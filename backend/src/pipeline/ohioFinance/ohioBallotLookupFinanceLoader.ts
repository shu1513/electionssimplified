import type { Pool, PoolClient } from "pg";

import { isOhioCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isOhioFinanceEligibleOffice } from "./ohioFinanceEligibleOffices.js";
import { overlayOhioCommitteeReceipts } from "./ohioCommitteeReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_OHIO_SOS_SOURCE_URL = "https://www.ohiosos.gov/campaign-finance/search/";

// docs/plans/ohio_plan.md decision 13: Ohio's outside-spending totals come from Form
// 31-U filings by REGISTERED committees in the SoS bulk exports. Spenders
// that never register (issue-advocacy groups and the like) disclose through
// the Miscellaneous Filings PDFs instead, which the pipeline does not parse
// yet. That is a systematic gap, not a rounding error, so it is stated with
// the totals until the PDF path ships — at which point this note is removed.
const OHIO_OUTSIDE_COVERAGE_NOTE =
  "Covers outside spending reported by committees registered with the Ohio Secretary of State. " +
  "Groups that spend without registering file separately and are not included yet.";

export async function loadOhioCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "OH",
    source: "OHIO_SOS",
    sourceUrl: GENERIC_OHIO_SOS_SOURCE_URL,
    enabled: isOhioCampaignFinanceEnabled,
    isEligibleElection: (row) => isOhioFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    outsideCoverageNote: OHIO_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "oh_candidate_finance_links",
      summaries: "oh_candidate_finance_summaries",
      directBreakdowns: "oh_candidate_finance_direct_breakdowns",
      outsideGroups: "oh_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "oh_candidate_finance_outside_group_breakdowns",
    },
  });
  return overlayOhioCommitteeReceipts(db, summaries, candidateRows, electionRows);
}
