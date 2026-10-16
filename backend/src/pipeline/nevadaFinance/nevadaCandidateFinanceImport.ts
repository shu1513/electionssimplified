import type { Pool, PoolClient } from "pg";

import {
  readNevadaCandidateReportsArtifact,
  readNevadaMonthlyContributions,
  readNevadaMonthlyExpenditures,
  readNevadaReportHtmlArtifact,
  readNevadaRosterArtifact,
  nevadaSlugForFilerName,
} from "./nevadaAuroraArtifacts.js";
import { nevadaFilerKey } from "./nevadaAuroraCsv.js";
import { readNevadaCommitteeDonorObservation } from "./nevadaCommitteeDonorObservation.js";
import { aggregateNevadaDirectContributions } from "./nevadaDirectContributionAggregator.js";
import {
  resolveNevadaCandidateFilers,
  type NevadaResolverCandidate,
  type NevadaRosterEntry,
  nevadaCandidateNamesMatch,
  nevadaDistrictNumberFromName,
  parseNevadaAuroraOffice,
} from "./nevadaCandidateFilerResolver.js";
import { NEVADA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./nevadaFinanceEligibleOffices.js";
import { replaceNevadaCandidateFinanceSnapshot } from "./nevadaFinanceWriter.js";
import {
  buildNevadaCycleSummary,
  parseNevadaCandidateReportSummary,
  selectNevadaCycleReports,
} from "./nevadaReportSummary.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

function candidateDetailsUrl(
  detailToken: string,
  electionYear: number,
): string {
  return `https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/CandidateDetails.aspx?o=${detailToken}&y=${electionYear}`;
}

function electionYearFromDate(electionDate: string): number {
  const match = electionDate.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!match) {
    throw new Error(
      `Invalid election date ${JSON.stringify(electionDate)} (expected yyyy-mm-dd)`,
    );
  }
  return Number(match[1]);
}

const ELIGIBLE_CANDIDATE_SQL = `
SELECT
  c.id AS candidate_id,
  e.id AS election_id,
  (c.first_name || ' ' || c.last_name) AS candidate_name,
  o.scope AS office_scope,
  o.canonical_name AS office_canonical_name,
  d.name AS district_name
FROM candidates c
JOIN candidate_elections ce ON ce.candidate_id = c.id
JOIN elections e ON e.id = ce.election_id
JOIN districts d ON d.id = e.district_id
JOIN offices o ON o.id = e.office_id
WHERE d.state = 'NV'
  AND e.election_date = $1
  AND (o.scope || '::' || o.canonical_name) = ANY($2)
ORDER BY c.last_name, c.first_name
`;

export type NevadaAutoLinkResult = {
  electionYear: number;
  candidateCount: number;
  matched: {
    candidateName: string;
    filerName: string;
    confirmedOffice: string;
  }[];
  skipped: { candidateName: string; reason: string; detail: string }[];
  linksWritten: number;
};

export async function autoLinkNevadaCandidateFinance(input: {
  db: ConnectableQueryable;
  artifactDir: string;
  electionDate: string;
  write: boolean;
}): Promise<NevadaAutoLinkResult> {
  const electionYear = electionYearFromDate(input.electionDate);
  const { rows } = await input.db.query(ELIGIBLE_CANDIDATE_SQL, [
    input.electionDate,
    [...NEVADA_FINANCE_ELIGIBLE_OFFICE_KEYS],
  ]);
  const candidates: NevadaResolverCandidate[] = (
    rows as {
      candidate_id: string;
      election_id: string;
      candidate_name: string;
      office_scope: string;
      office_canonical_name: string;
      district_name: string | null;
    }[]
  ).map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    electionYear,
    candidateName: row.candidate_name,
    officeScope: row.office_scope,
    officeCanonicalName: row.office_canonical_name,
    districtName: row.district_name,
  }));

  const rosterEntries: NevadaRosterEntry[] = [];
  for (const entry of await readNevadaRosterArtifact(
    input.artifactDir,
    electionYear,
  )) {
    let reportRows: NevadaRosterEntry["reportRows"] = [];
    try {
      reportRows = (
        await readNevadaCandidateReportsArtifact(
          input.artifactDir,
          electionYear,
          entry.slug,
        )
      ).reportRows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    rosterEntries.push({
      name: entry.name,
      slug: entry.slug,
      detailToken: entry.detailToken,
      reportRows,
    });
  }

  const resolution = resolveNevadaCandidateFilers({
    candidates,
    rosterEntries,
  });
  let linksWritten = 0;
  if (input.write) {
    for (const match of resolution.matches) {
      // replaceSnapshot with a link only (no summary/breakdowns) upserts the
      // link AND transactionally deactivates any other active aurora_search
      // link for the candidate + election — an AURORA display-name change
      // must supersede the old filer_key row, never leave two active links.
      await replaceNevadaCandidateFinanceSnapshot({
        db: input.db,
        link: {
          candidateId: match.candidate.candidateId,
          electionId: match.candidate.electionId,
          electionYear,
          candidateNameNormalized: match.candidate.candidateName
            .trim()
            .replace(/\s+/g, " "),
          officeName: match.candidate.officeCanonicalName,
          district: match.candidate.districtName,
          filerName: match.roster.name,
          linkSource: "aurora_search",
          sourceUrl: candidateDetailsUrl(
            match.roster.detailToken,
            electionYear,
          ),
          lastVerifiedAt: new Date(),
        },
      });
      linksWritten += 1;
    }
  }

  return {
    electionYear,
    candidateCount: candidates.length,
    matched: resolution.matches.map((match) => ({
      candidateName: match.candidate.candidateName,
      filerName: match.roster.name,
      confirmedOffice: match.confirmedOffice,
    })),
    skipped: resolution.skips.map((skip) => ({
      candidateName: skip.candidate.candidateName,
      reason: skip.reason,
      detail: skip.detail,
    })),
    linksWritten,
  };
}

type NevadaLinkRow = {
  candidate_id: string;
  election_id: string;
  election_year: number;
  candidate_name_normalized: string;
  office_name: string;
  district: string | null;
  filer_key: string;
  filer_name: string;
  source_url: string | null;
};

export type NevadaImportCandidateResult = {
  filerName: string;
  status: "imported" | "quarantined" | "dry_run_ok";
  reportCount?: number;
  totalReceipts?: number;
  totalDisbursements?: number;
  /** NULL when the filer reported a negative ending fund balance. */
  cashOnHand?: number | null;
  /** Itemized CSV sum — NOT the stored line-8 direct_contribution_total. */
  itemizedContributionTotal?: number;
  breakdownCount?: number;
  warnings: string[];
  reason?: string;
  pacDonorCount?: number;
  pacDonorAmount?: number;
  sourcePeriodEnd?: string;
};

export type NevadaImportResult = {
  electionYear: number;
  linkCount: number;
  monthsLoaded: string[];
  results: NevadaImportCandidateResult[];
  importedCount: number;
  quarantinedCount: number;
};

export async function importNevadaCandidateFinance(input: {
  db: ConnectableQueryable;
  artifactDir: string;
  electionDate: string;
  write: boolean;
  /** Optional filer-name filter (normalized comparison). */
  onlyFiler?: string | null;
  /** Complete browser financial observation; imports only the donor component. */
  committeeDonorArtifactPath?: string;
}): Promise<NevadaImportResult> {
  const electionYear = electionYearFromDate(input.electionDate);
  if (input.committeeDonorArtifactPath !== undefined) {
    const source = await readNevadaCommitteeDonorObservation(
      input.committeeDonorArtifactPath,
    );
    if (
      source.electionYear !== electionYear ||
      (input.onlyFiler &&
        nevadaFilerKey(input.onlyFiler) !== nevadaFilerKey(source.filerName))
    ) {
      throw new Error(
        "Nevada donor observation does not match requested filer/year",
      );
    }
    const { rows: sourceLinks } = await input.db.query(
      `SELECT link.*, (candidate.first_name || ' ' || candidate.last_name) AS canonical_candidate_name,
        office.scope AS office_scope, office.canonical_name AS office_canonical_name,
        district.name AS district_name, district.state AS canonical_state,
        roster.status AS canonical_status, candidate.deleted_at AS candidate_deleted_at,
        candidate.merged_into_candidate_id AS candidate_merged_into,
        election.election_stage AS canonical_stage
       FROM public.nv_candidate_finance_links AS link
       JOIN public.candidates AS candidate ON candidate.id = link.candidate_id
       JOIN public.elections AS election ON election.id = link.election_id
       JOIN public.offices AS office ON office.id = election.office_id
       JOIN public.districts AS district ON district.id = election.district_id
       JOIN public.candidate_elections AS roster
         ON roster.candidate_id = candidate.id AND roster.election_id = election.id
       WHERE link.election_year = $1 AND link.filer_key = $2
         AND link.link_status = 'active' AND election.election_date = $3::date`,
      [electionYear, nevadaFilerKey(source.filerName), input.electionDate],
    );
    if (sourceLinks.length !== 1)
      throw new Error(
        "Nevada donor source requires one existing active receiving link",
      );
    const link = sourceLinks[0] as NevadaLinkRow & {
      link_source: "manual" | "aurora_search";
      canonical_candidate_name: string;
      office_scope: string;
      office_canonical_name: string;
      district_name: string;
      canonical_state: string;
      canonical_status: string;
      canonical_stage: string;
      candidate_deleted_at: Date | null;
      candidate_merged_into: string | null;
      last_verified_at: Date | null;
    };
    const office = parseNevadaAuroraOffice(source.sourceOffice);
    if (
      link.canonical_state !== "NV" ||
      link.canonical_status !== "declared" ||
      link.canonical_stage !== "general" ||
      link.candidate_deleted_at !== null ||
      link.candidate_merged_into !== null ||
      !nevadaCandidateNamesMatch(
        link.canonical_candidate_name,
        source.filerName,
      ) ||
      !office ||
      office.officeScope !== link.office_scope ||
      office.officeCanonicalName !== link.office_canonical_name ||
      (office.officeScope !== "statewide" &&
        office.districtNumber !==
          nevadaDistrictNumberFromName(link.district_name))
    ) {
      throw new Error(
        "Nevada donor source candidate/office/seat does not match canonical link",
      );
    }
    const result: NevadaImportCandidateResult = {
      filerName: source.filerName,
      status: input.write ? "imported" : "dry_run_ok",
      reportCount: source.reportCount,
      itemizedContributionTotal: source.cashCents / 100,
      pacDonorCount: source.pacDonors.length,
      pacDonorAmount:
        source.pacDonors.reduce(
          (sum, donor) => sum + Math.round(donor.totalAmount * 100),
          0,
        ) / 100,
      sourcePeriodEnd: source.pacDonorSource.periodEnd,
      warnings: source.warnings,
    };
    if (input.write) {
      await replaceNevadaCandidateFinanceSnapshot({
        db: input.db,
        link: {
          candidateId: link.candidate_id,
          electionId: link.election_id,
          electionYear,
          candidateNameNormalized: link.candidate_name_normalized,
          officeName: link.office_name,
          district: link.district,
          filerName: link.filer_name,
          linkSource: link.link_source,
          sourceUrl: link.source_url,
          lastVerifiedAt: link.last_verified_at,
        },
        pacDonors: source.pacDonors,
        pacDonorSource: source.pacDonorSource,
      });
    }
    return {
      electionYear,
      linkCount: 1,
      monthsLoaded: [],
      results: [result],
      importedCount: input.write ? 1 : 0,
      quarantinedCount: 0,
    };
  }
  const { rows } = await input.db.query(
    `SELECT candidate_id, election_id, election_year, candidate_name_normalized,
            office_name, district, filer_key, filer_name, source_url
     FROM nv_candidate_finance_links
     WHERE election_year = $1 AND link_status = 'active'
     ORDER BY filer_name`,
    [electionYear],
  );
  let links = rows as NevadaLinkRow[];
  if (input.onlyFiler) {
    const onlyKey = nevadaFilerKey(input.onlyFiler);
    links = links.filter((link) => link.filer_key === onlyKey);
  }

  // Read every linked candidate's report list first so one monthly-CSV load
  // covers the widest selected period.
  const plans: {
    link: NevadaLinkRow;
    slug: string;
    selection: ReturnType<typeof selectNevadaCycleReports>;
  }[] = [];
  const results: NevadaImportCandidateResult[] = [];
  for (const link of links) {
    const slug = nevadaSlugForFilerName(link.filer_name);
    try {
      const reports = await readNevadaCandidateReportsArtifact(
        input.artifactDir,
        electionYear,
        slug,
      );
      if (nevadaFilerKey(reports.name) !== link.filer_key) {
        throw new Error(
          `reports.json filer ${JSON.stringify(reports.name)} does not match link ${JSON.stringify(link.filer_name)}`,
        );
      }
      const selection = selectNevadaCycleReports({
        rows: reports.reportRows,
        electionYear,
      });
      if (selection.selected.length === 0) {
        results.push({
          filerName: link.filer_name,
          status: "quarantined",
          reason: "no cycle reports found in AURORA report list",
          warnings: [],
        });
        continue;
      }
      plans.push({ link, slug, selection });
    } catch (error) {
      results.push({
        filerName: link.filer_name,
        status: "quarantined",
        reason: error instanceof Error ? error.message : String(error),
        warnings: [],
      });
    }
  }

  const startMonth = `${electionYear - 1}-01`;
  let maxPeriodEnd = `${electionYear - 1}-12-31`;
  for (const plan of plans) {
    for (const report of plan.selection.selected) {
      if (report.period.end > maxPeriodEnd) maxPeriodEnd = report.period.end;
    }
  }
  const endMonth = maxPeriodEnd.slice(0, 7);
  const [contributions, expenditures] = plans.length
    ? await Promise.all([
        readNevadaMonthlyContributions(input.artifactDir, startMonth, endMonth),
        readNevadaMonthlyExpenditures(input.artifactDir, startMonth, endMonth),
      ])
    : [
        { rows: [], monthsLoaded: [], fileCount: 0 },
        { rows: [], monthsLoaded: [], fileCount: 0 },
      ];

  let importedCount = 0;
  for (const plan of plans) {
    const warnings: string[] = [];
    try {
      if (plan.selection.unrecognizedReportNames.length > 0) {
        warnings.push(
          `unrecognized report names ignored: ${plan.selection.unrecognizedReportNames.join(" | ")}`,
        );
      }
      const parsedReports = [];
      for (const report of plan.selection.selected) {
        const html = await readNevadaReportHtmlArtifact(
          input.artifactDir,
          electionYear,
          plan.slug,
          report.syn,
        );
        parsedReports.push({
          report,
          summary: parseNevadaCandidateReportSummary(
            html,
            `${plan.link.filer_name} ${report.reportName}`,
          ),
        });
      }
      const cycle = buildNevadaCycleSummary(parsedReports);
      const periodStart = plan.selection.selected[0].period.start;
      const periodEnd = cycle.latestPeriodEnd;

      const aggregation = aggregateNevadaDirectContributions({
        filerKey: plan.link.filer_key,
        periodStart,
        periodEnd,
        contributionRows: contributions.rows,
        // Annual filings are labeled election-year+1 but cover the prior year,
        // so the cycle window can legitimately cite years -1 through +1.
        allowedReportYears: [electionYear - 1, electionYear, electionYear + 1],
        sourceUrl: plan.link.source_url,
      });
      if (aggregation.foreignReportYearRowCount > 0) {
        throw new Error(
          `${aggregation.foreignReportYearRowCount} in-window contribution row(s) cite report years ` +
            `outside ${electionYear - 1}-${electionYear + 1}; likely a same-name filer collision ` +
            `(the filer display name is the only CSV join key)`,
        );
      }
      const contributionSumCents = aggregation.directContributionTotalCents;
      // 1% tolerance on both bounds: filers misdate rows out of the cycle
      // window (floor shortfalls) and file schedules that exceed their own
      // summaries by tens of dollars (ceiling overruns) - live-hit at
      // -$250 / +$650 on $250k-$400k filers. Totals stay official line-8
      // sums; the tolerance only widens the breakdown-coverage gate.
      const tolerance = (cents: number) => Math.ceil(Math.max(0, cents) * 0.01);
      if (
        contributionSumCents <
          cycle.itemizedContributionFloorCents -
            tolerance(cycle.itemizedContributionFloorCents) ||
        contributionSumCents >
          cycle.itemizedContributionCeilingCents +
            tolerance(cycle.itemizedContributionCeilingCents)
      ) {
        throw new Error(
          `contribution reconciliation failed: CSV sum ${contributionSumCents} outside ` +
            `[${cycle.itemizedContributionFloorCents}, ${cycle.itemizedContributionCeilingCents}] cents (1% tolerance)`,
        );
      }
      let expenditureSumCents = 0;
      for (const row of expenditures.rows) {
        if (row.filerKey !== plan.link.filer_key || row.isLegalDefenseFund)
          continue;
        if (row.date < periodStart || row.date > periodEnd) continue;
        expenditureSumCents += row.amountCents;
      }
      if (
        expenditureSumCents <
          cycle.itemizedExpenseFloorCents -
            tolerance(cycle.itemizedExpenseFloorCents) ||
        expenditureSumCents >
          cycle.itemizedExpenseCeilingCents +
            tolerance(cycle.itemizedExpenseCeilingCents)
      ) {
        throw new Error(
          `expenditure reconciliation failed: CSV sum ${expenditureSumCents} outside ` +
            `[${cycle.itemizedExpenseFloorCents}, ${cycle.itemizedExpenseCeilingCents}] cents (1% tolerance)`,
        );
      }
      // Nevada filers may report a negative ending fund balance (campaign
      // debt). The summaries table only stores cash_on_hand >= 0, so publish
      // the reconciled totals and leave cash unknown (NULL) for that filer.
      const cashOnHand =
        cycle.cashOnHandCents < 0 ? null : cycle.cashOnHandCents / 100;
      if (cashOnHand === null) {
        warnings.push(
          `negative ending fund balance ${cycle.cashOnHandCents} cents stored as unknown cash on hand`,
        );
      }

      // Loan rows carry no marker in the itemized CSV, so when the cycle has
      // loan money (lines 2/3) the donor charts cannot be separated from it:
      // publish totals only and suppress the breakdowns for that filer.
      const suppressBreakdowns = cycle.loanContributionCents !== 0;
      if (suppressBreakdowns) {
        warnings.push(
          `loan lines 2/3 total ${cycle.loanContributionCents} cents; ` +
            `breakdowns suppressed (loan rows are unflagged in the CSV)`,
        );
      }
      const candidateResult: NevadaImportCandidateResult = {
        filerName: plan.link.filer_name,
        status: input.write ? "imported" : "dry_run_ok",
        reportCount: plan.selection.selected.length,
        totalReceipts: cycle.totalReceiptsCents / 100,
        totalDisbursements: cycle.totalDisbursementsCents / 100,
        cashOnHand,
        itemizedContributionTotal:
          aggregation.directContributionTotalCents / 100,
        breakdownCount: suppressBreakdowns
          ? 0
          : aggregation.directBreakdowns.length,
        warnings,
      };
      if (input.write) {
        await replaceNevadaCandidateFinanceSnapshot({
          db: input.db,
          link: {
            candidateId: plan.link.candidate_id,
            electionId: plan.link.election_id,
            electionYear,
            candidateNameNormalized: plan.link.candidate_name_normalized,
            officeName: plan.link.office_name,
            district: plan.link.district,
            filerName: plan.link.filer_name,
            linkSource: "aurora_search",
            sourceUrl: plan.link.source_url,
          },
          summary: {
            // Official line-8 gross (includes loan lines 2/3 and commitment
            // lines 4/6) stays in total_receipts; the shared loader publishes
            // direct_contribution_total as the displayed total_raised, which
            // the contract keeps to DONOR MONEY ONLY — lines 1+5+7. The
            // itemized CSV sum stays internal to the reconciliation gate.
            totalReceipts: cycle.totalReceiptsCents / 100,
            directContributionTotal: cycle.donorContributionCents / 100,
            totalDisbursements: cycle.totalDisbursementsCents / 100,
            cashOnHand,
            sourceUrl: plan.link.source_url,
          },
          directBreakdowns: suppressBreakdowns
            ? []
            : aggregation.directBreakdowns.map((breakdown) => ({
                categoryType: breakdown.categoryType,
                categoryName: breakdown.categoryName,
                amount: breakdown.amount,
                contributorCount: breakdown.contributorCount,
                sourceUrl: breakdown.sourceUrl,
              })),
        });
        importedCount += 1;
      }
      results.push(candidateResult);
    } catch (error) {
      results.push({
        filerName: plan.link.filer_name,
        status: "quarantined",
        reason: error instanceof Error ? error.message : String(error),
        warnings,
      });
    }
  }

  return {
    electionYear,
    linkCount: links.length,
    monthsLoaded: contributions.monthsLoaded,
    results,
    importedCount,
    quarantinedCount: results.filter(
      (result) => result.status === "quarantined",
    ).length,
  };
}
