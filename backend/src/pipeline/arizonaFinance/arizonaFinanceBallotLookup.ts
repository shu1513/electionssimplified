import type { Pool, PoolClient } from "pg";

import { isArizonaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceSummary,
  StateFinanceRequestCandidateRow,
  StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { buildStateFinanceSummaryRequests } from "../address/ballotLookupFinanceShared.js";
import { attachArizonaReportedFinance } from "./arizonaReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The bespoke loader exported its own row types; the wrapper keeps the names
// (working rule: exported names/types survive migration) as aliases of the
// shared request rows, whose extra election fields are all optional.
export type ArizonaFinanceBallotLookupCandidateRow = StateFinanceRequestCandidateRow;
export type ArizonaFinanceBallotLookupElectionRow = StateFinanceRequestElectionRow;

const GENERIC_ARIZONA_SPOTLIGHT_SOURCE_URL = "https://seethemoney.az.gov/Reporting/Explore";

export async function loadArizonaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "AZ",
    source: "ARIZONA_SOS",
    sourceUrl: GENERIC_ARIZONA_SPOTLIGHT_SOURCE_URL,
    enabled: isArizonaCampaignFinanceEnabled,
    evidenceLabelTypes: ["donor"],
    tables: {
      links: "az_candidate_finance_links",
      summaries: "az_candidate_finance_summaries",
      directBreakdowns: "az_candidate_finance_direct_breakdowns",
      outsideGroups: "az_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "az_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachArizonaReportedFinance({db,summaries,requests:buildStateFinanceSummaryRequests("AZ",candidateRows,electionRows)});
}
