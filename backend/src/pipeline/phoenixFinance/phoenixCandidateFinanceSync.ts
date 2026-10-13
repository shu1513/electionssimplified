// Phase 3 per-candidate sync: discover and parse one linked committee's
// e-filed reports, aggregate direct and outside money, decide quarantine
// from the violation list, build the per-candidate coverage notes, classify
// employer labels (deterministic + cached-manual only — NO classifier is
// ever injected; Phoenix finance sync performs zero AI calls), then write
// one all-or-nothing snapshot.
//
// Copy-adapted from the San Diego sync. The Phoenix divergences:
//
// - The source is live grids + report PDFs, not a bulk workbook: the
//   run-level context (canonical registration index + the city-filing IE
//   PACs' parsed Schedule B(6) pool) is loaded once per batch run and
//   threaded to every candidate; per-candidate discovery reads the three
//   transaction grids for the linked COP ID and parses each canonical
//   report PDF. Successful syncs refresh published PDFs; cached bodies do
//   not establish the current accessible publication census.
// - BOTH coverage notes are always-on. Direct: the totals basis plus the
//   occupation/employer itemization threshold (A(1)(a) is cumulative >$100
//   in-state; A(1)(c) is all out-of-state). Outside: the city-portal basis
//   plus the three channels requiring separately qualified financial
//   allocations. The October 12 scout proved no current eligible allocation
//   from those channels; missing coverage remains unknown.
//
// Fail-closed contract (the SF pattern): every health-check failure THROWS
// before replacePhoenixCandidateFinanceSnapshot is called, so the prior
// snapshot survives untouched. A committee that affirmatively reports no
// qualifying data (registered, no reports discovered for the cycle) writes
// a zero snapshot with a coverage note instead — "the source says nothing"
// and "the source is broken" are deliberately different outcomes.
//
// Quarantine policy: a violation blocks the write only when it makes the
// published totals untrustworthy —
//   cover_arithmetic / schedule_reconciliation
//     (a report's own numbers disagree — parsing or the filing is wrong),
//   period_overlap
//     (canonical selection failed; period sums would double-count),
//   coverage_hole
//     (money moved during days no discovered report covers — the cycle sums
//      are provably incomplete),
//   negative_cycle_total
//     (unpublishable — the DB CHECK rejects it anyway).
// cash_chain_break / period_gap / cycle_column_discrepancy /
// opening_balance_unexplained are diagnostics only (see the aggregator's
// type docs): a restated opening balance does not move a cycle total, which
// sums period (b)/(c) values — the same call San José and San Diego make.

import type { Pool, PoolClient } from "pg";
import { isPhoenixCommitteeCashSyncEnabled } from "../../config/featureFlags.js";
import { syncPhoenixCommitteeCash } from "./phoenixCommitteeCashSync.js";
import {
  classifyFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
} from "../finance/financeIndustryClassificationService.js";
import {
  canonicalPhoenixRegistration,
  canonicalPhoenixReportRefs,
  discoverPhoenixCanonicalReportRefs,
  fetchPhoenixCanonicalRegistrations,
  fetchPhoenixReportPdf,
  phoenixFilesystemPdfCache,
  phoenixGridAll,
  phoenixSubmittedDateMs,
  toPhoenixRegistrationRow,
  PHOENIX_CANDIDATE_IE_FUNCTION_ID,
  PHOENIX_REPORT_PACKAGE_GUID,
  PHOENIX_TEST_COMMITTEE_PATTERN,
  type PhoenixPdfCache,
  type PhoenixRegistrationRow,
  type PhoenixReportRef,
} from "./phoenixEfilingClient.js";
import {
  extractPhoenixPdfPages,
  isPhoenixB6Page,
  parsePhoenixB6Entries,
  parsePhoenixReportCover,
  parsePhoenixReportPages,
} from "./phoenixReportPdfParser.js";
import {
  aggregatePhoenixDirectFinance,
  type PhoenixDirectViolation,
  type PhoenixDirectViolationType,
  type PhoenixCanonicalReport,
} from "./phoenixDirectFinanceAggregator.js";
import {
  aggregatePhoenixOutsideSpending,
  type PhoenixOutsidePoolEntry,
  type PhoenixOutsideTargetCandidate,
} from "./phoenixOutsideSpendingAggregator.js";
import {
  PHOENIX_OUTSIDE_SUPPLEMENTS,
  type PhoenixOutsideSupplement,
} from "./phoenixOutsideSpendingSupplements.js";
import { normalizePhoenixTextKey } from "./phoenixCandidateCommitteeResolver.js";
import { PHOENIX_FINANCE_SOURCE_URL } from "./phoenixCandidateFinanceAutoLink.js";
import {
  replacePhoenixCandidateFinanceSnapshot,
  type PhoenixDirectBreakdownInput,
} from "./phoenixFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

/**
 * Recorded with every snapshot. Bump when the proven composition rules
 * change — the formulas live on the Phase 3 aggregators.
 */
export const PHOENIX_FINANCE_METHODOLOGY_VERSION = "phx-2026.1";

export const DEFAULT_PHOENIX_FINANCE_CACHE_DIR =
  "scratch/phoenix-campaign-finance/reports";

// Anomaly bound, the SF constants: an order-of-magnitude drop in donor money
// on an unchanged filing set aborts the write; floors at $1,000 stored so
// micro-committees cannot trip it on rounding noise.
const ANOMALY_MIN_STORED_CENTS = 100_000;
const ANOMALY_DROP_FACTOR = 10;

const BLOCKING_VIOLATION_TYPES: ReadonlySet<PhoenixDirectViolationType> =
  new Set([
    "cover_arithmetic",
    "schedule_reconciliation",
    "period_overlap",
    "coverage_hole",
    "negative_cycle_total",
  ]);

// Always-on baselines. Direct discloses the occupation/employer itemization
// threshold (plan "Requirement mapping"); outside discloses the measured
// channel and the curated-only ones (plan "Outside spending" + the
// 2026-08-12 Spotlight verification).
const DIRECT_BASELINE_NOTE =
  "Totals come from the committee's reports filed in the city's e-filing system. " +
  "Top donor occupations and employers cover itemized individual contributions: " +
  "in-state donors giving more than $100 in the election cycle and all out-of-state donors.";
const OUTSIDE_BASELINE_NOTE_START =
  "Outside spending totals cover independent expenditures reported to the Phoenix City Clerk by city-registered committees";
const OUTSIDE_CHANNELS_NOTE =
  "Spending disclosed only to the Arizona Secretary of State by standing committees, by non-committee filers, or through dark-money disclosure reports is not automatically included.";

export type PhoenixFinanceRunContext = {
  /** Canonical registration index (one row per COP ID, all types). */
  registrations: PhoenixRegistrationRow[];
  registrationsByCopId: Map<string, PhoenixRegistrationRow>;
  /** Parsed B(6) entries across every city-filing IE PAC (may be empty —
   * the 2025-2027 cycle has zero B(6) rows so far). */
  outsidePool: PhoenixOutsidePoolEntry[];
  diagnostics: {
    ieRegistrations: number;
    cityFilingIePacs: number;
    standingIePacs: number;
    b6Packages: number;
  };
};

type FetchSeams = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  cache?: PhoenixPdfCache;
};

function gridAmountToCents(raw: unknown, context: string): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.round(raw * 100);
  }
  const text = String(raw ?? "")
    .replace(/[$,]/g, "")
    .trim();
  const match = /^-?\d+(?:\.\d{1,2})?$/.exec(text);
  if (!match)
    throw new Error(`Unparseable grid amount "${String(raw)}" for ${context}`);
  const value = Number(text);
  return Math.round(value * 100);
}

/**
 * Loads the run-level context once per batch run: the canonical registration
 * index, and the outside-spending pool — every city-filing IE-authorized
 * PAC's Schedule B(6) entries, amendment-canonicalized and reconciled
 * against the expenditure grid (count + cents per package). ANY pool
 * inconsistency throws: an unattributable or missing IE row makes every
 * candidate's outside totals suspect (the SD unusable-row policy).
 */
export async function loadPhoenixFinanceRunContext(
  seams: FetchSeams = {},
): Promise<PhoenixFinanceRunContext> {
  const cache =
    seams.cache ?? phoenixFilesystemPdfCache(DEFAULT_PHOENIX_FINANCE_CACHE_DIR);
  const registrations = await fetchPhoenixCanonicalRegistrations({
    timeoutMs: seams.timeoutMs,
    fetchImpl: seams.fetchImpl,
  });
  const registrationsByCopId = new Map(
    registrations.map((row) => [row.copId, row]),
  );

  // IE-authorized registrations come from the CFUNC-filtered grid (the
  // canonical index above has no function data), then collapse to canonical
  // per COP ID with the same rule.
  const ieRows = (
    await phoenixGridAll({
      path: "/CampaignFinance/Search/_SearchCommittees",
      filters: { CFUNC: PHOENIX_CANDIDATE_IE_FUNCTION_ID },
      timeoutMs: seams.timeoutMs,
      fetchImpl: seams.fetchImpl,
    })
  ).map(toPhoenixRegistrationRow);
  const ieByCopId = new Map<string, PhoenixRegistrationRow[]>();
  for (const row of ieRows) {
    if (!row.copId) continue;
    const bucket = ieByCopId.get(row.copId) ?? [];
    bucket.push(row);
    ieByCopId.set(row.copId, bucket);
  }
  let standingIePacs = 0;
  const cityFilers: PhoenixRegistrationRow[] = [];
  for (const rows of ieByCopId.values()) {
    const canonical = canonicalPhoenixRegistration(rows);
    if (canonical === null) continue;
    if (PHOENIX_TEST_COMMITTEE_PATTERN.test(canonical.committeeName)) continue;
    // Terminated PACs stay IN the pool: termination ends future filing, not
    // the filings already made. A PAC that spent on this cycle and then
    // terminated would otherwise vanish from the pool on the next run, and
    // the snapshot rewrite would silently shrink every affected candidate's
    // outside totals. The aggregator's per-entry cycle gate already keeps a
    // dead PAC's prior-cycle spending out.
    if (canonical.isStandingCommittee) {
      // Standing PACs file finance reports only with the AZ SOS — the
      // curated channel (see the outside aggregator's header).
      standingIePacs += 1;
      continue;
    }
    cityFilers.push(canonical);
  }

  const outsidePool: PhoenixOutsidePoolEntry[] = [];
  let b6Packages = 0;
  for (const pac of cityFilers) {
    const expenditureRows = await phoenixGridAll({
      path: "/CampaignFinance/Search/_SearchExpenditures",
      filters: { COPID: pac.copId },
      timeoutMs: seams.timeoutMs,
      fetchImpl: seams.fetchImpl,
    });
    // Validate every physical row before selecting the B(6) component.
    // No timestamp or equal report name establishes amendment lineage.
    for (const row of expenditureRows) {
      if (
        typeof row.COPID !== "string" ||
        !/^(?:CAN|PAC)-\d{2}-[1-9]\d*$/.test(row.COPID.trim().toUpperCase()) ||
        !row.COPID.trim().toUpperCase().startsWith(pac.copId)
      ) {
        throw new Error("Phoenix IE expense grid receiving COPID mismatch");
      }
      // Exact receiver selection follows full physical prefix-search closure.
      if (row.COPID.trim().toUpperCase() !== pac.copId) continue;
      if (
        row.RecentReport !== undefined &&
        row.RecentReport !== null &&
        row.RecentReport !== "" &&
        row.RecentReport !== "00000000-0000-0000-0000-000000000000"
      ) {
        throw new Error(
          "Phoenix IE expense grid has an unexplained RecentReport pointer",
        );
      }
      if (
        typeof row.ReportPackageId !== "string" ||
        !PHOENIX_REPORT_PACKAGE_GUID.test(row.ReportPackageId) ||
        row.ReportPackageId === "00000000-0000-0000-0000-000000000000" ||
        typeof row.ReportName !== "string" ||
        !row.ReportName.trim()
      ) {
        throw new Error(
          "Phoenix IE expense grid has invalid package/name metadata",
        );
      }
    }
    const b6Rows = expenditureRows.filter((row) =>
      typeof row.COPID === "string" &&
      row.COPID.trim().toUpperCase() === pac.copId &&
      /B\(6\)/.test(String(row.ReportScheduleName ?? "")),
    );
    if (b6Rows.length === 0) continue;
    const refs: PhoenixReportRef[] = [];
    const gridByPackage = new Map<string, { count: number; cents: number }>();
    for (const row of b6Rows) {
      const id = row.ReportPackageId as string;
      refs.push({
        reportPackageId: id,
        reportName: row.ReportName as string,
        submittedDateMs: phoenixSubmittedDateMs(
          row.SubmittedDate,
          "IE report row metadata",
        ),
      });
      const tally = gridByPackage.get(id) ?? { count: 0, cents: 0 };
      tally.count += 1;
      tally.cents += gridAmountToCents(
        row.Amount,
        `${pac.copId} package ${id}`,
      );
      gridByPackage.set(id, tally);
    }
    const { refs: canonicalRefs } = canonicalPhoenixReportRefs(refs);
    const periods: { from: string; to: string }[] = [];
    for (const winner of canonicalRefs) {
      b6Packages += 1;
      const bytes = await fetchPhoenixReportPdf({
        reportPackageId: winner.reportPackageId,
        cache,
        refresh: true,
        timeoutMs: seams.timeoutMs,
        fetchImpl: seams.fetchImpl,
      });
      const pages = await extractPhoenixPdfPages(bytes);
      for (const page of pages) {
        const ids = page.lines
          .filter((line) => line.y > 700)
          .flatMap((line) => line.cells.map((cell) => cell.text))
          .filter((text) => /^(?:CAN|PAC)-\d{2}-[1-9]\d*$/.test(text));
        if (ids.length !== 1 || ids[0] !== pac.copId) {
          throw new Error("Phoenix IE PDF receiving COPID mismatch");
        }
      }
      const coverPages = pages.filter((page) =>
        page.lines.some((line) =>
          /FINANCIAL SUMMARY \(required\)/.test(line.text),
        ),
      );
      if (coverPages.length !== 1)
        throw new Error("Phoenix IE PDF has no unique financial cover");
      const cover = parsePhoenixReportCover(coverPages[0]!);
      if (cover.periodFrom > cover.periodTo)
        throw new Error("Phoenix IE PDF has reversed cover period");
      if (
        periods.some(
          (period) =>
            cover.periodFrom <= period.to && period.from <= cover.periodTo,
        )
      ) {
        throw new Error(
          "Phoenix IE PAC has overlapping B(6) report periods; published edition authority is unresolved",
        );
      }
      periods.push({ from: cover.periodFrom, to: cover.periodTo });

      const entries = pages
        .filter((page) => isPhoenixB6Page(page))
        .flatMap((page) => parsePhoenixB6Entries(page));
      // Grid-vs-schedule reconciliation for the canonical package: the grid
      // exposes one row per B(6) expenditure, so count and cents must agree.
      const gridTally = gridByPackage.get(winner.reportPackageId)!;
      const parsedCents = entries.reduce(
        (sum, entry) => sum + entry.amountCents,
        0,
      );
      if (
        entries.length !== gridTally.count ||
        parsedCents !== gridTally.cents
      ) {
        throw new Error(
          `Phoenix IE PAC ${pac.copId} package ${winner.reportPackageId}: parsed ${entries.length} B(6) entries totaling ${parsedCents} cents but the grid shows ${gridTally.count} rows totaling ${gridTally.cents} cents`,
        );
      }
      for (const entry of entries) {
        outsidePool.push({
          spenderCopId: pac.copId,
          spenderName: pac.committeeName,
          reportPackageId: winner.reportPackageId,
          entry,
        });
      }
    }
  }

  return {
    registrations,
    registrationsByCopId,
    outsidePool,
    diagnostics: {
      ieRegistrations: ieByCopId.size,
      cityFilingIePacs: cityFilers.length,
      standingIePacs,
      b6Packages,
    },
  };
}

/**
 * Report-cover "Office Sought" values per COP ID for the resolver's name
 * tier (each committee's LATEST canonical report cover — enough to
 * corroborate a contest). A committee with no discoverable report yields no
 * entry, and the name tier keeps failing closed for it, by design.
 */
export async function buildPhoenixCoverOfficeSoughtIndex(input: {
  copIds: readonly string[];
  seams?: FetchSeams;
}): Promise<Map<string, readonly string[]>> {
  const seams = input.seams ?? {};
  const cache =
    seams.cache ?? phoenixFilesystemPdfCache(DEFAULT_PHOENIX_FINANCE_CACHE_DIR);
  const covers = new Map<string, readonly string[]>();
  for (const copId of new Set(input.copIds)) {
    const { refs } = await discoverPhoenixCanonicalReportRefs({
      copId,
      timeoutMs: seams.timeoutMs,
      fetchImpl: seams.fetchImpl,
    });
    const observed: { periodTo: string; officeSought: string | null }[] = [];
    for (const ref of refs) {
      const bytes = await fetchPhoenixReportPdf({
        reportPackageId: ref.reportPackageId,
        cache,
        refresh: true,
        timeoutMs: seams.timeoutMs,
        fetchImpl: seams.fetchImpl,
      });
      const pages = await extractPhoenixPdfPages(bytes);
      const coverPages = pages.filter((page) =>
        page.lines.some((line) =>
          /FINANCIAL SUMMARY \(required\)/.test(line.text),
        ),
      );
      if (coverPages.length !== 1) continue;
      const coverPage = coverPages[0]!;
      const ids = coverPage.lines
        .filter((line) => line.y > 700)
        .flatMap((line) => line.cells.map((cell) => cell.text))
        .filter((text) => /^(?:CAN|PAC)-\d{2}-[1-9]\d*$/.test(text));
      if (ids.length !== 1 || ids[0] !== copId.trim().toUpperCase()) continue;
      const cover = parsePhoenixReportCover(coverPage);
      if (cover.periodFrom > cover.periodTo) continue;
      observed.push({
        periodTo: cover.periodTo,
        officeSought: cover.officeSought,
      });
    }
    // An unavailable cover could be the latest one; do not select an older
    // office from the remaining packages. GUID and row-time order are irrelevant.
    if (!observed.length || observed.length !== refs.length) continue;
    const latestEnd = observed.reduce(
      (latest, cover) => (cover.periodTo > latest ? cover.periodTo : latest),
      "",
    );
    const latestOffices = new Set(
      observed
        .filter((cover) => cover.periodTo === latestEnd)
        .map((cover) => cover.officeSought),
    );
    if (latestOffices.size !== 1 || latestOffices.has(null)) continue;
    covers.set(copId, [latestOffices.values().next().value!]);
  }
  return covers;
}

/** Exact "[-]dollars.cc" text (numeric(16,2)) → integer cents; null passes. */
function dollarsTextToCents(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Unparseable stored dollar amount: ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return (
    sign * (Number(match[2]) * 100 + Number((match[3] ?? "0").padEnd(2, "0")))
  );
}

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export type PhoenixCandidateFinanceSyncResult = {
  linkWritten: boolean;
  totalRaisedCents: number;
  totalSpentCents: number;
  loansReceivedCents: number;
  cashOnHandCents: number | null;
  outsideSupportCents: number;
  outsideOpposeCents: number;
  directBreakdownCount: number;
  outsideGroupCount: number;
  reportedThrough: string | null;
  directCoverageNote: string;
  outsideCoverageNote: string;
  /** Full violation list — blocking ones never reach here (they throw). */
  violations: PhoenixDirectViolation[];
  canonicalReportCount: number;
  committeeCash?:
    | { ok: true; result: Awaited<ReturnType<typeof syncPhoenixCommitteeCash>> }
    | { ok: false; error: string };
};

export async function syncPhoenixCandidateFinance(input: {
  db: PoolLike;
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateDisplayName: string;
  officeName: PhoenixOutsideTargetCandidate["officeName"];
  /** Council district (1–8); null for Mayor. */
  districtNumber: number | null;
  /** ISO election date (anchors the outside cycle gate). */
  electionDate: string;
  /** The linked committee (active phx_candidate_finance_links row). */
  copId: string;
  /** The link row's portal cycle bounds (ISO dates). */
  portalCycleStart: string;
  portalCycleEnd: string;
  /** Run-level context (loadPhoenixFinanceRunContext). */
  context: PhoenixFinanceRunContext;
  /** Operator override for the previous-vs-new anomaly bound only. */
  bypassAnomalyCheck?: boolean;
  /** Test seam; defaults to grid discovery + PDF fetch + parse. */
  loadCommitteeReports?: (copId: string) => Promise<PhoenixCanonicalReport[]>;
  syncCommitteeCashFn?: typeof syncPhoenixCommitteeCash;
  /** Test seam; defaults to the shipped curated list. */
  supplements?: readonly PhoenixOutsideSupplement[];
  seams?: FetchSeams;
  dryRun?: boolean;
  now?: Date;
}): Promise<PhoenixCandidateFinanceSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid Phoenix finance sync timestamp");
  }
  const copId = input.copId.trim().toUpperCase();
  const seams = input.seams ?? {};
  const cache =
    seams.cache ?? phoenixFilesystemPdfCache(DEFAULT_PHOENIX_FINANCE_CACHE_DIR);

  // --- Committee presence: a linked COP ID missing from the canonical
  // registration index means the portal lost it (or the index fetch is
  // broken) — a source failure, never "no data". A terminated registration
  // stays syncable: its filed reports remain this candidate's money.
  const registration = input.context.registrationsByCopId.get(copId);
  if (registration === undefined) {
    throw new Error(
      `Linked Phoenix committee ${copId} has no approved registration in the portal index; refusing to overwrite the prior snapshot`,
    );
  }

  // --- Direct: discover → parse → aggregate. A parse failure on ANY
  // canonical report throws (periods are unknowable without the cover, so
  // no report can be proven out-of-cycle and skipped).
  const loadCommitteeReports =
    input.loadCommitteeReports ??
    (async (targetCopId: string): Promise<PhoenixCanonicalReport[]> => {
      const discovery = await discoverPhoenixCanonicalReportRefs({
        copId: targetCopId,
        timeoutMs: seams.timeoutMs,
        fetchImpl: seams.fetchImpl,
      });
      const loaded: PhoenixCanonicalReport[] = [];
      for (const ref of discovery.refs) {
        const bytes = await fetchPhoenixReportPdf({
          reportPackageId: ref.reportPackageId,
          cache,
          refresh: true,
          timeoutMs: seams.timeoutMs,
          fetchImpl: seams.fetchImpl,
        });
        loaded.push({
          reportPackageId: ref.reportPackageId,
          reportName: ref.reportName,
          submittedDateMs: ref.submittedDateMs,
          parsed: parsePhoenixReportPages(await extractPhoenixPdfPages(bytes)),
        });
      }
      return loaded;
    });
  const reports = await loadCommitteeReports(copId);
  const direct = aggregatePhoenixDirectFinance({
    copId,
    reports,
    portalCycleStart: input.portalCycleStart,
    portalCycleEnd: input.portalCycleEnd,
  });
  const blocking = direct.violations.filter((violation) =>
    BLOCKING_VIOLATION_TYPES.has(violation.type),
  );
  if (blocking.length > 0) {
    throw new Error(
      `Phoenix committee ${copId} reports are quarantined (${blocking.length} blocking violation${blocking.length === 1 ? "" : "s"}): ${blocking
        .map((violation) => `${violation.type}: ${violation.message}`)
        .join("; ")}`,
    );
  }

  // --- Direct coverage note: the always-on basis, plus the affirmative
  // no-reports-yet case (registered committee, nothing filed this cycle —
  // a zero snapshot, not an abort).
  const directNotes = [DIRECT_BASELINE_NOTE];
  if (direct.reports.length === 0) {
    directNotes.push(
      "The committee has not filed a campaign finance report for this election cycle yet.",
    );
  }
  const directCoverageNote = directNotes.join(" ");

  // --- Outside spending: the run-level B(6) pool plus curated supplements
  // for this election year. ---
  const outside = aggregatePhoenixOutsideSpending({
    candidate: {
      displayName: input.candidateDisplayName,
      officeName: input.officeName,
      districtNumber: input.districtNumber,
      electionDate: input.electionDate,
    },
    pool: input.context.outsidePool,
    supplements: (input.supplements ?? PHOENIX_OUTSIDE_SUPPLEMENTS).filter(
      (entry) => entry.electionYear === input.electionYear,
    ),
  });
  const unattributed =
    outside.diagnostics.unattributableEntries +
    outside.diagnostics.undatedEntries +
    outside.diagnostics.partialAttributionRows;
  const outsideNotes = [
    outside.diagnostics.supplementRowsIncluded > 0
      ? `${OUTSIDE_BASELINE_NOTE_START}, plus ${outside.diagnostics.supplementRowsIncluded} individually reviewed filing${outside.diagnostics.supplementRowsIncluded === 1 ? "" : "s"} from other channels.`
      : `${OUTSIDE_BASELINE_NOTE_START}.`,
    OUTSIDE_CHANNELS_NOTE,
  ];
  if (unattributed > 0) {
    outsideNotes.push(
      `${unattributed} disclosed independent expenditure${unattributed === 1 ? " was" : "s were"} not attributable to a single candidate and ${unattributed === 1 ? "is" : "are"} not included.`,
    );
  }
  if (outside.diagnostics.vetoedRows > 0) {
    outsideNotes.push(
      `${outside.diagnostics.vetoedRows} expenditure${outside.diagnostics.vetoedRows === 1 ? "" : "s"} naming this candidate ${outside.diagnostics.vetoedRows === 1 ? "was" : "were"} excluded because the disclosed office or district did not match this contest.`,
    );
  }
  const outsideCoverageNote = outsideNotes.join(" ");

  // --- Previous-vs-new anomaly bounds (baseline = THIS committee's active
  // link only; a relink legitimately starts with no baseline). ---
  const stored = await input.db.query<{
    total_raised: string | null;
    reported_through: string | null;
  }>(
    `SELECT summary.total_raised::text,summary.reported_through::text reported_through FROM public.phx_candidate_finance_summaries summary JOIN public.phx_candidate_finance_links link ON link.id=summary.link_id WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND summary.election_year=$3 AND link.link_status='active' AND link.cop_id=$4`,
    [input.candidateId, input.electionId, input.electionYear, copId],
  );
  const storedRow = stored.rows[0];
  const storedReportedThrough = storedRow?.reported_through ?? null;
  // A null stored reported_through means the prior snapshot was the zero
  // "nothing filed yet" case — nothing to regress against.
  if (storedReportedThrough !== null) {
    // Filing history never shrinks: a snapshot reported through a LATER
    // date than today's latest report means discovery lost reports — abort.
    // Deliberately NOT overridable by bypassAnomalyCheck.
    if (
      direct.reportedThrough === null ||
      direct.reportedThrough < storedReportedThrough
    ) {
      throw new Error(
        `Phoenix filing history went backwards for committee ${copId}: stored through ${storedReportedThrough}, now ${direct.reportedThrough ?? "no reports"}`,
      );
    }
    const storedRaisedCents = dollarsTextToCents(
      storedRow?.total_raised ?? null,
    );
    if (
      !input.bypassAnomalyCheck &&
      storedRaisedCents !== null &&
      storedRaisedCents >= ANOMALY_MIN_STORED_CENTS &&
      direct.reportedThrough === storedReportedThrough &&
      direct.totalRaisedCents < storedRaisedCents / ANOMALY_DROP_FACTOR
    ) {
      throw new Error(
        `Phoenix total raised collapsed on an unchanged report set for committee ${copId}: ${usd(storedRaisedCents)} -> ${usd(direct.totalRaisedCents)} (pass bypassAnomalyCheck to override)`,
      );
    }
  }

  // --- Deterministic + cached-manual industry classification only (the SF
  // pattern): industries derive from the aggregator's top-20 employer rows;
  // unknown results persist through the snapshot write and form the manual
  // industry-label due queue. ---
  const classifications = new Map<string, FinanceLabelClassification>();
  const employerRows = direct.breakdowns.filter(
    (row) => row.categoryType === "employer",
  );
  for (const row of employerRows) {
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({
        rawLabel: row.categoryName,
        labelType: "employer",
      }),
    );
  }
  const classifiableEmployerRows = employerRows.map((row) => ({
    categoryType: row.categoryType,
    categoryName: row.categoryName,
    amount: row.amountCents,
    contributorCount: row.contributorCount,
  }));
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: classifiableEmployerRows,
    outsideBreakdowns: [],
    classifications,
    classifier: undefined,
    minAmount: 0,
    dryRun: Boolean(input.dryRun),
  });
  const industryCents = new Map<string, { cents: number; count: number }>();
  for (const row of buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: classifiableEmployerRows,
    outsideBreakdowns: [],
    classifications,
  }).directIndustryBreakdowns) {
    const current = industryCents.get(row.categoryName) ?? {
      cents: 0,
      count: 0,
    };
    current.cents += row.amount;
    current.count += row.contributorCount ?? 0;
    industryCents.set(row.categoryName, current);
  }
  const directBreakdowns: PhoenixDirectBreakdownInput[] = [
    ...direct.breakdowns.map((row) => ({
      categoryType: row.categoryType,
      categoryName: row.categoryName,
      amountCents: row.amountCents,
      contributorCount: row.contributorCount,
    })),
    ...[...industryCents]
      .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0]))
      .map(([categoryName, value]) => ({
        categoryType: "industry" as const,
        categoryName,
        amountCents: value.cents,
        contributorCount: value.count,
      })),
  ];

  let committeeCash: PhoenixCandidateFinanceSyncResult["committeeCash"];
  if (isPhoenixCommitteeCashSyncEnabled()) {
    try {
      const result = await (
        input.syncCommitteeCashFn ?? syncPhoenixCommitteeCash
      )({
        db: input.db,
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        copId,
        committeeName: registration.committeeName,
        officeSought:
          input.officeName === "Mayor"
            ? "Mayor"
            : `Council Member District ${input.districtNumber}`,
        portalCycleStart: input.portalCycleStart,
        portalCycleEnd: input.portalCycleEnd,
        dryRun: input.dryRun,
        timeoutMs: seams.timeoutMs,
        fetchImpl: seams.fetchImpl,
      });
      committeeCash = { ok: true, result };
    } catch (error) {
      committeeCash = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!input.dryRun) {
    await replacePhoenixCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizePhoenixTextKey(
          input.candidateDisplayName,
        ),
        copId,
        // The registration is the current authority on the committee's name
        // and portal cycle string; the upsert refreshes both on the link.
        committeeName: registration.committeeName,
        portalCycleName: registration.electionCycle,
        portalCycleStart: input.portalCycleStart,
        portalCycleEnd: input.portalCycleEnd,
        linkStatus: "active",
        linkSource: "efiling_portal",
        sourceUrl: PHOENIX_FINANCE_SOURCE_URL,
        lastVerifiedAt: now,
      },
      summary: {
        totalRaisedCents: direct.totalRaisedCents,
        totalSpentCents: direct.totalSpentCents,
        cashOnHandCents: direct.cashOnHandCents,
        // Not parsed in v1 (disbursements line 12 semantics unverified).
        debtsOwedCents: null,
        loansReceivedCents: direct.loansReceivedCents,
        // Missing standing/noncommittee/EFD channels cannot replace overall totals.
        outsideSupportCents: undefined,
        outsideOpposeCents: undefined,
        directCoverageNote,
        outsideCoverageNote,
        methodologyVersion: PHOENIX_FINANCE_METHODOLOGY_VERSION,
        sourceUrl: PHOENIX_FINANCE_SOURCE_URL,
        reportedThrough: direct.reportedThrough,
      },
      directBreakdowns,
      outsideGroups: outside.groups.map((group) => ({
        spenderFilerId: group.spenderFilerId,
        spenderName: group.spenderName,
        supportOppose: group.direction,
        amountCents: group.amountCents,
        expenditureCount: group.expenditureCount,
        sourceUrl: PHOENIX_FINANCE_SOURCE_URL,
      })),
      classifications: [...classifications.values()],
      syncedAt: now,
    });
  }

  return {
    linkWritten: !input.dryRun,
    totalRaisedCents: direct.totalRaisedCents,
    totalSpentCents: direct.totalSpentCents,
    loansReceivedCents: direct.loansReceivedCents,
    cashOnHandCents: direct.cashOnHandCents,
    outsideSupportCents: outside.supportTotalCents,
    outsideOpposeCents: outside.opposeTotalCents,
    directBreakdownCount: directBreakdowns.length,
    outsideGroupCount: outside.groups.length,
    reportedThrough: direct.reportedThrough,
    directCoverageNote,
    outsideCoverageNote,
    violations: direct.violations,
    canonicalReportCount: direct.reports.length,
    ...(committeeCash ? { committeeCash } : {}),
  };
}
