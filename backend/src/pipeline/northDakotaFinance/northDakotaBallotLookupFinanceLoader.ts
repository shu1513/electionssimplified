// North Dakota ballot-lookup finance loader: thin config wrapper over the
// standard loader. Phase 2 publishes total receipts, the donor-only "Raised"
// figure and contribution-size buckets; Phase 3 adds filed occupations for
// committees that pass the display gate (the sync stores none otherwise, so
// the card simply has no occupation rows); Phase 4a adds support/oppose
// groups and totals from the IE harvest (NULL when that component was
// skipped, $0 when a clean harvest names nobody). Spending (year-end
// statement only) and cash (statewide filers only, unparsed) are never
// stored yet, so they surface as null with the coverage notes — never $0.

import type { Pool, PoolClient } from "pg";

import { isNorthDakotaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { NORTH_DAKOTA_DIRECT_COVERAGE_NOTE } from "./northDakotaDirectContributionAggregator.js";
import { isNorthDakotaFinanceEligibleOffice } from "./northDakotaFinanceEligibleOffices.js";
import { NORTH_DAKOTA_CFRS_SOURCE_URL } from "./northDakotaFinanceWriter.js";
import { attachNorthDakotaReportedFinance } from "./northDakotaReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// Phase 4: IE statements are filed within 48 hours with no minimum amount
// (statute + FAQ); stance and target candidate come from the filing itself.
// The spenders' own funders are not loaded yet.
const NORTH_DAKOTA_OUTSIDE_COVERAGE_NOTE =
  "Outside spending counts independent expenditures that registered North Dakota committees reported for or against this candidate, using the stance each filing states; a total of zero means no such filing names the candidate yet. The groups' own funders are not shown yet.";

export async function loadNorthDakotaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "ND",
    source: "NORTH_DAKOTA_CFRS",
    sourceUrl: NORTH_DAKOTA_CFRS_SOURCE_URL,
    enabled: isNorthDakotaCampaignFinanceEnabled,
    isEligibleElection: (row) => isNorthDakotaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    directBreakdownCategoryTypes: ["occupation", "contribution_size"],
    directCoverageNote: NORTH_DAKOTA_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote: NORTH_DAKOTA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "nd_candidate_finance_links",
      summaries: "nd_candidate_finance_summaries",
      directBreakdowns: "nd_candidate_finance_direct_breakdowns",
      outsideGroups: "nd_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "nd_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachNorthDakotaReportedFinance({ db, summaries, requests: buildStateFinanceSummaryRequests("ND", candidateRows, electionRows,
    row => isNorthDakotaFinanceEligibleOffice(officeInputFromElectionRow(row))) });
}
