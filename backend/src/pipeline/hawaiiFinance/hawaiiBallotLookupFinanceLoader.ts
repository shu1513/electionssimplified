import type { Pool, PoolClient } from "pg";

import { isHawaiiCampaignFinanceEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceSummary,
  StateFinanceRequestCandidateRow,
  StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { buildStateFinanceSummaryRequests } from "../address/ballotLookupFinanceShared.js";
import { attachHawaiiReportedFinance } from "./hawaiiReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_HAWAII_CSC_SOURCE_URL = "https://hicscdata.hawaii.gov/";

export async function loadHawaiiCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "HI",
    source: "HAWAII_CSC",
    sourceUrl: GENERIC_HAWAII_CSC_SOURCE_URL,
    enabled: isHawaiiCampaignFinanceEnabled,
    evidenceLabelTypes: ["donor"],
    tables: {
      links: "hi_candidate_finance_links",
      summaries: "hi_candidate_finance_summaries",
      directBreakdowns: "hi_candidate_finance_direct_breakdowns",
      outsideGroups: "hi_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "hi_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachHawaiiReportedFinance({ db, requests: buildStateFinanceSummaryRequests("HI", candidateRows, electionRows), summaries });
}
