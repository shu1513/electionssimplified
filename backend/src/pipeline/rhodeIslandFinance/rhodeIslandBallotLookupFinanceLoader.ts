import type { Pool, PoolClient } from "pg";

import { isRhodeIslandCampaignFinanceEnabled, isRhodeIslandReportedCommitteeCashEnabled, isRhodeIslandReportedIeEnabled } from "../../config/featureFlags.js";
import { appendRhodeIslandReviewedIeSummaries } from "./rhodeIslandReviewedIeBallotSummary.js";
import {
  officeInputFromElectionRow,
  buildStateFinanceSummaryRequests,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isRhodeIslandFinanceEligibleOffice } from "./rhodeIslandFinanceEligibleOffices.js";
import { appendRhodeIslandCommitteeCashSummaries } from "./rhodeIslandCommitteeCashBallotSummary.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// ERTS public homepage — search is per-organization only (no stable public
// deep link per committee), so the generic fallback points at the portal
// entry page.
const GENERIC_RHODE_ISLAND_ERTS_SOURCE_URL = "https://www.ricampaignfinance.com/RIPublic/Homepage.aspx";

// docs/plans/rhode_island_plan.md decision 5/7: CF-8 outside-spending filings are
// scanned PDFs ingested as hand-curated supplement entries, a multi-target
// filing without the apportionment RI regulation 410-RICR-10-00-13
// §13.5(B)(2)(d) requires is quarantined in full, and §17-25.3-1 obliges
// spenders to disclose only donors above $1,000 per cycle (with statutory
// carve-outs). Systematic gaps, not rounding errors, so they are stated
// with the totals.
const RHODE_ISLAND_OUTSIDE_COVERAGE_NOTE =
  "Outside-spending filings in Rhode Island are scanned documents; totals include manually verified filings " +
  "with a clear per-candidate amount — filings naming several candidates without a stated split are excluded — " +
  "and the state requires spenders to disclose only donors above $1,000 per cycle, with statutory exceptions.";

// docs/plans/rhode_island_plan.md decision 1/13: RI discloses employer, never
// occupation (§ 17-25-11), so the occupation card can never populate; and
// lawful "Aggregate - *" rows (donors at or under $200/year) are inside the
// direct total but never in the size buckets, so buckets cannot reconcile
// to the total and the note says why.
const RHODE_ISLAND_DIRECT_COVERAGE_NOTE =
  "Rhode Island discloses a direct contributor's employer, not occupation, so donor-occupation breakdowns " +
  "are not available for this state; size buckets reflect itemized contributions only.";

export async function loadRhodeIslandCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "RI",
    source: "RHODE_ISLAND_ERTS",
    sourceUrl: GENERIC_RHODE_ISLAND_ERTS_SOURCE_URL,
    enabled: isRhodeIslandCampaignFinanceEnabled,
    isEligibleElection: (row) => isRhodeIslandFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    // Occupation rows never exist for RI (decision 1), so the loader selects
    // buckets only — the Louisiana/Vermont narrowing.
    directBreakdownCategoryTypes: ["contribution_size"],
    outsideCoverageNote: RHODE_ISLAND_OUTSIDE_COVERAGE_NOTE,
    directCoverageNote: RHODE_ISLAND_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "ri_candidate_finance_links",
      summaries: "ri_candidate_finance_summaries",
      directBreakdowns: "ri_candidate_finance_direct_breakdowns",
      outsideGroups: "ri_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "ri_candidate_finance_outside_group_breakdowns",
    },
  });
  if (isRhodeIslandReportedCommitteeCashEnabled()) {
    const requests = buildStateFinanceSummaryRequests("RI", candidateRows, electionRows,
      row => isRhodeIslandFinanceEligibleOffice(officeInputFromElectionRow(row)));
    await appendRhodeIslandCommitteeCashSummaries(db, requests, summaries);
  }
  if (isRhodeIslandReportedIeEnabled()) {
    const requests = buildStateFinanceSummaryRequests("RI", candidateRows, electionRows,
      row => isRhodeIslandFinanceEligibleOffice(officeInputFromElectionRow(row)));
    await appendRhodeIslandReviewedIeSummaries(db, requests, summaries);
  }
  return summaries;
}
