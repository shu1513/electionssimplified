// South Carolina ballot-lookup finance loader: thin config wrapper over the
// standard loader. Outside coverage remains incomplete; unavailable totals
// surface as null while stored groups remain readable. The direct note is
// the source-wide static one from the aggregator; the standard family
// persists no per-candidate note (that variant is a sync diagnostic only).

import type { Pool, PoolClient } from "pg";

import { isSouthCarolinaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE } from "./southCarolinaDirectContributionAggregator.js";
import { isSouthCarolinaFinanceEligibleOffice } from "./southCarolinaFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const SOUTH_CAROLINA_ETHICS_SOURCE_URL = "https://ethicsfiling.sc.gov/public";
const SOUTH_CAROLINA_OUTSIDE_COVERAGE_NOTE =
  "South Carolina outside spending coverage is incomplete. Unavailable totals do not mean zero.";

export async function loadSouthCarolinaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  return loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "SC",
    source: "SOUTH_CAROLINA_CAMPAIGN_FINANCE",
    sourceUrl: SOUTH_CAROLINA_ETHICS_SOURCE_URL,
    enabled: isSouthCarolinaCampaignFinanceEnabled,
    isEligibleElection: (row) => isSouthCarolinaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    linkIdentityColumn: "candidate_filer_id",
    directCoverageNote: SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote: SOUTH_CAROLINA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "sc_candidate_finance_links",
      summaries: "sc_candidate_finance_summaries",
      directBreakdowns: "sc_candidate_finance_direct_breakdowns",
      outsideGroups: "sc_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "sc_candidate_finance_outside_group_breakdowns",
    },
  });
}
