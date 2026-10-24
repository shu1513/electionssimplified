// Phase 5 per-candidate sync: aggregate one linked committee's direct and
// outside money from the parsed cycle workbooks, decide quarantine from the
// Phase 3 violation list, build the per-candidate coverage note, classify
// employer labels (deterministic + cached-manual only — NO classifier is
// ever injected; San José finance sync performs zero AI calls), then write
// one all-or-nothing snapshot.
//
// Fail-closed contract (the SF pattern): every health-check failure THROWS
// before replaceSanJoseCandidateFinanceSnapshot is called, so the prior
// snapshot survives untouched. A committee that affirmatively reports no
// qualifying data (registered, no Form 460 filings yet) writes a zero
// snapshot with a coverage note instead — "the source says nothing" and
// "the source is broken" are deliberately different outcomes.
//
// Quarantine policy (the decision Phase 3 left to sync): a violation blocks
// the write only when it makes the published totals untrustworthy —
//   filing_unusable / duplicate_summary_line / missing_summary_line
//     (a filing or core line is excluded or ambiguous, totals incomplete),
//   contribution_reconciliation / loan_cross_check
//     (rows and report covers disagree — canonical selection failed).
// prior_activity_uncovered publishes WITH a direct_coverage_note (Altwer's
// live case: the export simply lacks her 2025 filings). Everything else —
// duplicate_period_filings, line_arithmetic, period_overlap, period_gap,
// cash_chain — is diagnostics only: all six live committees trip at least
// one of these and still reconcile cent-exact against the Phase 0 manual
// audit (the canonical-selection and Amount_A-only rules are the fix).

import { aggregateSanJoseCommitteeCash } from "./sanJoseCommitteeCash.js";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import {
  getEfileCalWorkbookArtifactCachePaths,
  refreshEfileCalWorkbookArtifactCache,
  type EfileCalAgencyConfig,
} from "../efileCalFinance/efileCalBulkClient.js";
import {
  parseEfileCalWorkbook,
  type EfileCalWorkbook,
} from "../efileCalFinance/efileCalWorkbookParser.js";
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
  aggregateSanJoseDirectFinance,
  type SanJoseDirectViolation,
  type SanJoseDirectViolationType,
} from "./sanJoseDirectFinanceAggregator.js";
import {
  aggregateSanJoseOutsideSpending,
  type SanJoseOutsideTargetCandidate,
} from "./sanJoseOutsideSpendingAggregator.js";
import { normalizeSanJoseTextKey } from "./sanJoseCandidateCommitteeResolver.js";
import {
  SAN_JOSE_PAPER_496_SUPPLEMENTS,
  type SanJosePaper496Supplement,
} from "./sanJosePaperFilingSupplements.js";
import {
  replaceSanJoseCandidateFinanceSnapshot,
  type SanJoseDirectBreakdownInput,
} from "./sanJoseFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

/**
 * Recorded with every snapshot (plan Phase 0 decision). Bump when the proven
 * composition rules change — the formulas live on the Phase 3 aggregators.
 */
export const SAN_JOSE_FINANCE_METHODOLOGY_VERSION = "sj-2026.1";

/** The public e-filing portal — the stable citizen-facing source page. */
export const SAN_JOSE_FINANCE_SOURCE_URL = "https://efile.sanjoseca.gov";

export const SAN_JOSE_EFILE_AGENCY_CONFIG: EfileCalAgencyConfig = {
  agencyKey: "csj",
  portalBaseUrl: SAN_JOSE_FINANCE_SOURCE_URL,
  // The bulk-export endpoint returns a stable unsigned S3 URL on this host
  // (verified live 2026-08-10); anything else is refused by the client.
  allowedExportHosts: ["efs-efile-campaign-exports.s3.amazonaws.com"],
};

export const DEFAULT_SAN_JOSE_FINANCE_CACHE_DIR =
  "scratch/san-jose-campaign-finance/efile";

// Anomaly bound, the SF constants: an order-of-magnitude drop in donor money
// on an unchanged filing set aborts the write; floors at $1,000 stored so
// micro-committees cannot trip it on rounding noise.
const ANOMALY_MIN_STORED_CENTS = 100_000;
const ANOMALY_DROP_FACTOR = 10;

const BLOCKING_VIOLATION_TYPES: ReadonlySet<SanJoseDirectViolationType> =
  new Set([
    "filing_unusable",
    "duplicate_summary_line",
    "missing_summary_line",
    "contribution_reconciliation",
    "loan_cross_check",
  ]);

/**
 * The San José campaign period for a November election opens the day after
 * the previous year's consolidated election (2025-11-04 for the 2026 cycle),
 * and the export files are per CALENDAR year — so a cycle always spans the
 * election year and the year before it. Earlier committee activity, when it
 * exists, is caught by the prior_activity_uncovered invariant and disclosed
 * via direct_coverage_note rather than silently missed.
 *
 * Deliberately NOT clipped to the municipal contribution period: that date
 * bounds when candidates may solicit under the city's limits, not what the
 * campaign's money is. Committees here are per-race ("… for City Council
 * District 5 2026" — the resolver's year veto enforces it), so everything
 * the committee reports is this race's activity, and live filings straddle
 * the period-start anyway (Van Le's covers 2025-07-01..12-31) — F460 cover
 * totals cannot be split mid-period without abandoning the proven
 * rows-vs-cover reconciliation. Totals are committee-coverage totals, with
 * reported_through and the coverage note saying exactly what they span.
 */
export function sanJoseCycleYears(electionYear: number): number[] {
  if (
    !Number.isInteger(electionYear) ||
    electionYear < 2000 ||
    electionYear > 2100
  )
    throw new Error(`Implausible San José election year: ${electionYear}`);
  return [electionYear - 1, electionYear];
}

export type SanJoseCycleWorkbookData = {
  electionYear: number;
  years: number[];
  /** Every sheet concatenated across the cycle's calendar-year workbooks. */
  workbook: EfileCalWorkbook;
  /** Per-year acquisition outcome for diagnostics. */
  sources: { year: number; status: "downloaded" | "unchanged" | "cached" }[];
};

/**
 * Loads (and, when allowed, refreshes) the cycle's calendar-year workbooks
 * from the artifact cache and parses them into one concatenated row set.
 * With refreshRawData=false this NEVER touches the network — a missing cache
 * file throws with the flag name so the operator knows which gate to open.
 */
export async function loadSanJoseCycleWorkbookData(input: {
  electionYear: number;
  refreshRawData: boolean;
  cacheDir?: string;
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<SanJoseCycleWorkbookData> {
  const years = sanJoseCycleYears(input.electionYear);
  const cacheDir = input.cacheDir ?? DEFAULT_SAN_JOSE_FINANCE_CACHE_DIR;
  const workbook: EfileCalWorkbook = {
    summary: [],
    scheduleA: [],
    scheduleC: [],
    scheduleB1: [],
    scheduleD: [],
    s496: [],
    s497: [],
  };
  const sources: SanJoseCycleWorkbookData["sources"] = [];
  for (const year of years) {
    const paths = getEfileCalWorkbookArtifactCachePaths({
      cacheDir,
      agencyKey: SAN_JOSE_EFILE_AGENCY_CONFIG.agencyKey,
      year,
      // Superseded filings are already removed upstream in this variant;
      // canonical period selection still guards the residual duplicates.
      mostRecentOnly: true,
    });
    let workbookPath = paths.workbookPath;
    if (input.refreshRawData) {
      const refresh = await refreshEfileCalWorkbookArtifactCache({
        config: SAN_JOSE_EFILE_AGENCY_CONFIG,
        year,
        mostRecentOnly: true,
        cacheDir,
        force: input.force,
        fetchImpl: input.fetchImpl,
        now: input.now,
      });
      workbookPath = refresh.workbookPath;
      sources.push({ year, status: refresh.status });
    } else {
      sources.push({ year, status: "cached" });
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(workbookPath);
    } catch (error) {
      throw new Error(
        `San José ${year} workbook is not cached at ${workbookPath}` +
          ` (enable SAN_JOSE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED or run a refresh first): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    const parsed = parseEfileCalWorkbook(bytes);
    workbook.summary.push(...parsed.summary);
    workbook.scheduleA.push(...parsed.scheduleA);
    workbook.scheduleC.push(...parsed.scheduleC);
    workbook.scheduleB1.push(...parsed.scheduleB1);
    workbook.scheduleD.push(...parsed.scheduleD);
    workbook.s496.push(...parsed.s496);
    workbook.s497.push(...parsed.s497);
  }
  return { electionYear: input.electionYear, years, workbook, sources };
}

/** Exact "[-]dollars.cc" text (numeric(16,2)) → integer cents; null passes. */
function dollarsTextToCents(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Unparseable stored dollar amount: ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 100 + Number((match[3] ?? "0").padEnd(2, "0")));
}

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export type SanJoseCandidateFinanceSyncResult = {
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
  directCoverageNote: string | null;
  /** Full Phase 3 violation list — blocking ones never reach here (they throw). */
  violations: SanJoseDirectViolation[];
  canonicalFilingCount: number;
};

export async function syncSanJoseCandidateFinance(input: {
  db: PoolLike;
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateDisplayName: string;
  officeName: SanJoseOutsideTargetCandidate["officeName"];
  /** Council district seat (1–10); null for Mayor. */
  seatNumber: number | null;
  /** The linked committee (active sjc_candidate_finance_links row). */
  fppcId: string;
  /** Concatenated cycle workbooks (loadSanJoseCycleWorkbookData). */
  workbook: EfileCalWorkbook;
  /** Operator override for the previous-vs-new anomaly bound only. */
  bypassAnomalyCheck?: boolean;
  /** Test seam; defaults to the shipped curated list. */
  paperSupplements?: readonly SanJosePaper496Supplement[];
  dryRun?: boolean;
  now?: Date;
}): Promise<SanJoseCandidateFinanceSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid San José finance sync timestamp");
  const { workbook, fppcId } = input;

  // --- Committee presence: a linked committee with no rows anywhere in the
  // cycle export has LEFT the export (or the export is broken) — that is a
  // source failure, not "no data"; the prior snapshot must survive.
  const committeeNames = new Set<string>();
  for (const rows of [
    workbook.summary,
    workbook.scheduleA,
    workbook.scheduleC,
    workbook.scheduleB1,
    workbook.scheduleD,
    workbook.s496,
    workbook.s497,
  ] as const) {
    for (const row of rows)
      if (row.filerId === fppcId) committeeNames.add(row.filerName);
  }
  if (committeeNames.size === 0)
    throw new Error(
      `Linked San José committee ${fppcId} has no rows in the cycle export; refusing to overwrite the prior snapshot`,
    );
  // Longest observed spelling — the fullest disclosed committee name.
  const committeeName = [...committeeNames].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  )[0]!;

  // --- Direct aggregation and quarantine. ---
  const direct = aggregateSanJoseDirectFinance({
    filerId: fppcId,
    summary: workbook.summary,
    scheduleA: workbook.scheduleA,
    scheduleC: workbook.scheduleC,
    scheduleB1: workbook.scheduleB1,
  });
  const blocking = direct.violations.filter((violation) =>
    BLOCKING_VIOLATION_TYPES.has(violation.type),
  );
  if (blocking.length > 0)
    throw new Error(
      `San José committee ${fppcId} filings are quarantined (${blocking.length} blocking violation${blocking.length === 1 ? "" : "s"}): ${blocking
        .map((violation) => `${violation.type}: ${violation.message}`)
        .join("; ")}`,
    );

  // --- Coverage note: what the direct totals do NOT cover. ---
  let directCoverageNote: string | null = null;
  const priorActivity = direct.violations.some(
    (violation) => violation.type === "prior_activity_uncovered",
  );
  if (direct.filings.length === 0) {
    // Schedule A/C/B1/D are Form 460 CHILD sheets: rows there prove a 460
    // was filed, so "no canonical filing but child rows exist" is export
    // inconsistency (summary rows lost), never affirmative zero activity —
    // abort and keep the prior snapshot. (Summary rows that exist but are
    // all unusable already threw as blocking filing_unusable above.)
    const orphanedChildRows = (
      [
        workbook.scheduleA,
        workbook.scheduleC,
        workbook.scheduleB1,
        workbook.scheduleD,
      ] as const
    ).reduce(
      (count, rows) =>
        count + rows.filter((row) => row.filerId === fppcId).length,
      0,
    );
    if (orphanedChildRows > 0)
      throw new Error(
        `San José committee ${fppcId} has ${orphanedChildRows} Form 460 child-sheet rows but no usable Form 460 summary; the export is inconsistent`,
      );
    // Affirmative no-data: the committee is in the export only through
    // standalone forms (496/497) or registration — no Form 460 yet. A zero
    // snapshot with this note, not an abort.
    directCoverageNote =
      "The committee has not filed a Form 460 disclosure statement in the city's e-filing system yet.";
  } else if (priorActivity) {
    // Altwer's live case: the first covered filing opens with cash already
    // on hand, so raised/spent undercount the campaign's full history.
    directCoverageNote =
      `Totals cover the committee's e-filed disclosures from ${direct.coverageStart} onward; ` +
      "it began that period with money from earlier activity that is not in the city's e-filing export.";
  }

  // --- Outside spending. Paper 496s are invisible to the bulk export, so
  // curated supplements for THIS election's cycle join the export rows here.
  const outside = aggregateSanJoseOutsideSpending({
    candidate: {
      displayName: input.candidateDisplayName,
      officeName: input.officeName,
      seatNumber: input.seatNumber,
    },
    s496: workbook.s496,
    scheduleD: workbook.scheduleD,
    paperSupplements: (
      input.paperSupplements ?? SAN_JOSE_PAPER_496_SUPPLEMENTS
    ).filter((entry) => entry.electionYear === input.electionYear),
  });

  const committeeCash = aggregateSanJoseCommitteeCash({ officeName:input.officeName,seatNumber:input.seatNumber,filerId:fppcId,
    filings:direct.filings,scheduleA:workbook.scheduleA,reportedThrough:direct.reportedThrough });

  // --- Previous-vs-new anomaly bounds (baseline = THIS committee's active
  // link only; a relink legitimately starts with no baseline). ---
  const stored = await input.db.query<{
    total_raised: string | null;
    reported_through: string | null;
  }>(
    `SELECT summary.total_raised::text,summary.reported_through::text reported_through FROM public.sjc_candidate_finance_summaries summary JOIN public.sjc_candidate_finance_links link ON link.id=summary.link_id WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND summary.election_year=$3 AND link.link_status='active' AND link.fppc_id=$4`,
    [input.candidateId, input.electionId, input.electionYear, fppcId],
  );
  const storedRow = stored.rows[0];
  const storedReportedThrough = storedRow?.reported_through ?? null;
  // A null stored reported_through means the prior snapshot was the zero
  // "no Form 460 yet" case — nothing to regress against, and its stored
  // total_raised of 0 sits under the collapse floor, so skipping both
  // gates loses nothing.
  if (storedReportedThrough !== null) {
    // Filing history never shrinks: a snapshot reported through a LATER date
    // than today's latest filing means the export lost filings — abort.
    // Deliberately NOT overridable by bypassAnomalyCheck: that flag covers
    // the drop bound only; a true regression is a source catastrophe.
    if (
      direct.reportedThrough === null ||
      direct.reportedThrough < storedReportedThrough
    )
      throw new Error(
        `San José filing history went backwards for committee ${fppcId}: stored through ${storedReportedThrough}, now ${direct.reportedThrough ?? "no filings"}`,
      );
    const storedRaisedCents = dollarsTextToCents(storedRow?.total_raised ?? null);
    if (
      !input.bypassAnomalyCheck &&
      storedRaisedCents !== null &&
      storedRaisedCents >= ANOMALY_MIN_STORED_CENTS &&
      direct.reportedThrough === storedReportedThrough &&
      direct.totalRaisedCents < storedRaisedCents / ANOMALY_DROP_FACTOR
    )
      throw new Error(
        `San José total raised collapsed on an unchanged filing set for committee ${fppcId}: ${usd(storedRaisedCents)} -> ${usd(direct.totalRaisedCents)} (pass bypassAnomalyCheck to override)`,
      );
  }

  // --- Deterministic + cached-manual industry classification only (the SF
  // pattern, kept identical on purpose): industries derive from the
  // aggregator's top-20 employer rows; unknown results persist through the
  // snapshot write and form the manual industry-label due queue. ---
  const classifications = new Map<string, FinanceLabelClassification>();
  const employerRows = direct.breakdowns.filter(
    (row) => row.categoryType === "employer",
  );
  for (const row of employerRows)
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: row.categoryName, labelType: "employer" }),
    );
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
    const current = industryCents.get(row.categoryName) ?? { cents: 0, count: 0 };
    current.cents += row.amount;
    current.count += row.contributorCount ?? 0;
    industryCents.set(row.categoryName, current);
  }
  const directBreakdowns: SanJoseDirectBreakdownInput[] = [
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

  if (!input.dryRun)
    await replaceSanJoseCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeSanJoseTextKey(
          input.candidateDisplayName,
        ),
        fppcId,
        committeeName,
        linkStatus: "active",
        linkSource: "efile_export",
        sourceUrl: SAN_JOSE_FINANCE_SOURCE_URL,
        lastVerifiedAt: now,
      },
      summary: {
        totalRaisedCents: direct.totalRaisedCents,
        totalSpentCents: direct.totalSpentCents,
        cashOnHandCents: direct.cashOnHandCents,
        debtsOwedCents: direct.debtsOwedCents,
        loansReceivedCents: direct.loansReceivedCents,
        outsideSupportCents: outside.supportTotalCents,
        outsideOpposeCents: outside.opposeTotalCents,
        directCoverageNote,
        methodologyVersion: SAN_JOSE_FINANCE_METHODOLOGY_VERSION,
        sourceUrl: SAN_JOSE_FINANCE_SOURCE_URL,
        reportedThrough: direct.reportedThrough,
      },
      directBreakdowns,
      committeeCash,
      outsideGroups: outside.groups.map((group) => ({
        spenderFilerId: group.spenderFilerId,
        spenderName: group.spenderName,
        supportOppose: group.direction,
        amountCents: group.amountCents,
        expenditureCount: group.expenditureCount,
        sourceUrl: SAN_JOSE_FINANCE_SOURCE_URL,
      })),
      classifications: [...classifications.values()],
      syncedAt: now,
    });

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
    violations: direct.violations,
    canonicalFilingCount: direct.filings.length,
  };
}
