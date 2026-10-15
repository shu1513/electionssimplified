import type { Pool, PoolClient } from "pg";

import { isMissouriCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { attachMissouriCommitteeMonetaryReceipts } from "./missouriCommitteeMonetaryReceiptReader.js";
import { isMissouriFinanceEligibleOffice } from "./missouriFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const MISSOURI_MEC_SOURCE_URL = "https://www.mec.mo.gov/MEC/Campaign_Finance/";
const MISSOURI_DIRECT_COVERAGE_NOTE =
  "Totals and donor breakdowns are summed from itemized Missouri Ethics Commission filings and are not reconciled to official report covers.";
const MISSOURI_OUTSIDE_COVERAGE_NOTE =
  "Registered-committee reported spending only; Missouri non-committee expenditure reports (§ 130.047) are not included.";
const MISSOURI_OUTSIDE_SUPPORT_ACTION_LABEL =
  "independent spending supporting this candidate; listed contributions are committee-cycle funding, not money earmarked to that spending";

export async function loadMissouriCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "MO",
    source: "MISSOURI_MEC",
    sourceUrl: MISSOURI_MEC_SOURCE_URL,
    enabled: isMissouriCampaignFinanceEnabled,
    isEligibleElection: (row) => isMissouriFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    outsideSupportActionLabel: MISSOURI_OUTSIDE_SUPPORT_ACTION_LABEL,
    outsideCoverageNote: MISSOURI_OUTSIDE_COVERAGE_NOTE,
    directCoverageNote: MISSOURI_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "mo_candidate_finance_links",
      summaries: "mo_candidate_finance_summaries",
      directBreakdowns: "mo_candidate_finance_direct_breakdowns",
      outsideGroups: "mo_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "mo_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachMissouriCommitteeMonetaryReceipts({ db, summaries,
    requests: buildStateFinanceSummaryRequests("MO", candidateRows, electionRows,
      row => isMissouriFinanceEligibleOffice(officeInputFromElectionRow(row))) });
}
