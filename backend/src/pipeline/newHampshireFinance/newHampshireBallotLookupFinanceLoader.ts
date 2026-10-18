import type { Pool, PoolClient } from "pg";

import { isNewHampshireCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  buildStateFinanceSummaryRequests,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isNewHampshireFinanceEligibleOffice } from "./newHampshireFinanceEligibleOffices.js";
import { attachNewHampshireReportedFinance } from "./newHampshireReportedFinanceReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const NEW_HAMPSHIRE_CFS_SOURCE_URL = "https://cfs.sos.nh.gov/";
const NEW_HAMPSHIRE_DIRECT_COVERAGE_NOTE =
  "New Hampshire CFS does not provide usable occupation data; industries are derived from disclosed contributor employers, while contributions without a disclosed or classifiable employer remain in totals and contribution-size buckets.";

export async function loadNewHampshireCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "NH",
    source: "NEW_HAMPSHIRE_CFS",
    sourceUrl: NEW_HAMPSHIRE_CFS_SOURCE_URL,
    enabled: isNewHampshireCampaignFinanceEnabled,
    isEligibleElection: (row) =>
      isNewHampshireFinanceEligibleOffice(officeInputFromElectionRow(row)),
    linkIdentityColumn: "filing_entity_id",
    outsideGroupIdentityColumns: {
      id: "filing_entity_id",
      name: "filer_name",
    },
    directBreakdownCategoryTypes: ["industry", "contribution_size"],
    evidenceLabelTypes: ["donor"],
    directCoverageNote: NEW_HAMPSHIRE_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "nh_candidate_finance_links",
      summaries: "nh_candidate_finance_summaries",
      directBreakdowns: "nh_candidate_finance_direct_breakdowns",
      outsideGroups: "nh_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "nh_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachNewHampshireReportedFinance({db,summaries,
    requests:buildStateFinanceSummaryRequests("NH",candidateRows,electionRows,
      row=>isNewHampshireFinanceEligibleOffice(officeInputFromElectionRow(row)))});
}
