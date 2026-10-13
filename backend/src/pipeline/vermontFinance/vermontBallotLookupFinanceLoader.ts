import type { Pool, PoolClient } from "pg";

import { isVermontCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  buildStateFinanceSummaryRequests,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isVermontFinanceEligibleOffice } from "./vermontFinanceEligibleOffices.js";
import { addVermontCommitteeCashToSummaries } from "./vermontCommitteeCashReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The bespoke loader exported its own row types; the wrapper keeps the names
// (working rule: exported names/types survive migration) as aliases of the
// shared request rows, whose extra election fields are all optional.
export type VermontBallotLookupCandidateRow = StateFinanceRequestCandidateRow;
export type VermontBallotLookupElectionRow = StateFinanceRequestElectionRow;

const GENERIC_VERMONT_CFD_SOURCE_URL = "https://campaignfinance.vermont.gov/";

export async function loadVermontCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly VermontBallotLookupCandidateRow[],
  electionRows: readonly VermontBallotLookupElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isVermontCampaignFinanceEnabled()) return new Map();
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "VT",
    source: "VERMONT_CFD",
    sourceUrl: GENERIC_VERMONT_CFD_SOURCE_URL,
    enabled: isVermontCampaignFinanceEnabled,
    isEligibleElection: (row) => isVermontFinanceEligibleOffice(officeInputFromElectionRow(row)),
    // Vermont's CFD keys every relation by filer registration GUID: the link
    // table and both outside tables use filer_registration_guid, with
    // filer_name as the display name — the first state to swap the link and
    // outside identities together.
    linkIdentityColumn: "filer_registration_guid",
    outsideGroupIdentityColumns: { id: "filer_registration_guid", name: "filer_name" },
    evidenceLabelTypes: ["donor"],
    // Vermont's direct-breakdown table only carries contribution-size buckets,
    // and its outside groups are PACs rather than independent-expenditure
    // committees, so the explanation wording says so.
    directBreakdownCategoryTypes: ["contribution_size"],
    outsideSupportActionLabel: "PAC contributions supporting this candidate",
    tables: {
      links: "vt_candidate_finance_links",
      summaries: "vt_candidate_finance_summaries",
      directBreakdowns: "vt_candidate_finance_direct_breakdowns",
      outsideGroups: "vt_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "vt_candidate_finance_outside_group_breakdowns",
    },
  });
  const requests = buildStateFinanceSummaryRequests("VT", candidateRows, electionRows,
    row => isVermontFinanceEligibleOffice(officeInputFromElectionRow(row)));
  return addVermontCommitteeCashToSummaries(db, requests, summaries);
}
