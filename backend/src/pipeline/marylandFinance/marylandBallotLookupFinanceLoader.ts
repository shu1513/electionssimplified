import type { Pool, PoolClient } from "pg";

import { isMarylandCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isMarylandFinanceEligibleOffice } from "./marylandFinanceEligibleOffices.js";
import { attachMarylandCommitteeMonetaryFinance } from "./marylandCommitteeMonetaryReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_MARYLAND_CFS_SOURCE_URL = "https://campaignfinance.maryland.gov/public/cf/downloads";

export async function loadMarylandCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isMarylandCampaignFinanceEnabled()) return new Map();
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "MD",
    source: "MARYLAND_CFS",
    sourceUrl: GENERIC_MARYLAND_CFS_SOURCE_URL,
    enabled: isMarylandCampaignFinanceEnabled,
    isEligibleElection: (row) => isMarylandFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    tables: {
      links: "md_candidate_finance_links",
      summaries: "md_candidate_finance_summaries",
      directBreakdowns: "md_candidate_finance_direct_breakdowns",
      outsideGroups: "md_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "md_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachMarylandCommitteeMonetaryFinance({db, summaries,
    requests: buildStateFinanceSummaryRequests("MD", candidateRows, electionRows,
      row => isMarylandFinanceEligibleOffice(officeInputFromElectionRow(row)))});
}
