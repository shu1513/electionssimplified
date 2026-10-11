import type { Pool, PoolClient } from "pg";

import { isDistrictOfColumbiaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceSummary,
  StateFinanceRequestCandidateRow,
  StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_DISTRICT_OF_COLUMBIA_OCF_SOURCE_URL = "https://efiling.ocf.dc.gov/DataDownload";

export async function loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  return loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "DC",
    source: "DISTRICT_OF_COLUMBIA_OCF",
    sourceUrl: GENERIC_DISTRICT_OF_COLUMBIA_OCF_SOURCE_URL,
    enabled: isDistrictOfColumbiaCampaignFinanceEnabled,
    // OCF keys every relation by committee_key, so the one-column option
    // covers the link and both outside identities (illinois precedent);
    // everything else is shared defaults — both evidence label types, no
    // office filter.
    //
    // Accepted no-op delta (alaska precedent): the bespoke mapper hardcoded
    // organization_type: "donor" on evidence rows while the shared mapper
    // reads the row's category_type. Unreachable divergence — DC outside
    // breakdowns are constrained to ('donor', 'industry') by
    // dc_cff_outside_breakdowns_type_check (migration 120), the shared
    // snapshot writer's outside category type is likewise "donor" |
    // "industry", and the evidence filter admits only donor/employer, so
    // every evidence row's category_type is 'donor' — exactly what the
    // bespoke mapper hardcoded.
    //
    // evidenceLabelTypes stays at the default for the same reason the
    // bespoke SQL selected IN ('donor', 'employer'): narrowing it to
    // ["donor"] would change emitted SQL with no output change, and would
    // split DC from texas/houston/washington, which carry the identical
    // schema constraint and also run the default.
    committeeColumn: "committee_key",
    // Fair Elections base and matching payments (migration 321). Null for
    // committees outside the program, so the card hides the stat for them.
    fundingColumns: ["public_funds_received"],
    tables: {
      links: "dc_candidate_finance_links",
      summaries: "dc_candidate_finance_summaries",
      directBreakdowns: "dc_candidate_finance_direct_breakdowns",
      outsideGroups: "dc_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "dc_candidate_finance_outside_group_breakdowns",
    },
  });
}
