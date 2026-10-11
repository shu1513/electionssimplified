// Delaware ballot-lookup finance loader: thin config wrapper over the
// standard loader. Outside coverage remains incomplete; unavailable totals
// surface as null, while previously stored groups remain readable. Occupation
// breakdowns are the voluntarily disclosed values only (hard fact 1), named
// as such by the direct coverage note.

import type { Pool, PoolClient } from "pg";

import { isDelawareCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isDelawareFinanceEligibleOffice } from "./delawareFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DELAWARE_CFRS_SOURCE_URL = "https://cfrs.elections.delaware.gov/";
const DELAWARE_DIRECT_COVERAGE_NOTE =
  "Delaware does not require donor occupation disclosure; occupation charts reflect voluntarily disclosed contributions only.";
const DELAWARE_OUTSIDE_COVERAGE_NOTE =
  "Delaware outside spending coverage is incomplete. Unavailable totals do not mean zero.";

export async function loadDelawareCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  return loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "DE",
    source: "DELAWARE_CFRS",
    sourceUrl: DELAWARE_CFRS_SOURCE_URL,
    enabled: isDelawareCampaignFinanceEnabled,
    isEligibleElection: (row) => isDelawareFinanceEligibleOffice(officeInputFromElectionRow(row)),
    outsideCoverageNote: DELAWARE_OUTSIDE_COVERAGE_NOTE,
    directCoverageNote: DELAWARE_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "de_candidate_finance_links",
      summaries: "de_candidate_finance_summaries",
      directBreakdowns: "de_candidate_finance_direct_breakdowns",
      outsideGroups: "de_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "de_candidate_finance_outside_group_breakdowns",
    },
  });
}
