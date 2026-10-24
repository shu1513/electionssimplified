import { appendAustinReportedCommitteeCash } from "./austinReportedCommitteeCashBallotSummary.js";
// Ballot-lookup read side for Austin (plan Phase 3): a thin config wrapper
// over the shared standard-shape loader. Austin deltas: link identity is
// filer_key (no filer id exists), outside tables key on
// spender_key/spender_name (the normalized DCE `paid_by`), and the outside
// totals carry a coverage note because the schema can only hold directed
// spending.
//
// TEXAS_TEC / Houston coexistence: the Texas state loader already skips
// every place-scope "Mayor" / "City Council Member" election (the Houston
// office list), so no tx_ summary can compete with an atx_ one; Houston's
// tables are disjoint from Austin's (different place row, different link
// table). Registered as the third TX adapter.

import type { Pool, PoolClient } from "pg";

import { isAustinCampaignFinanceEnabled, isAustinReportedCommitteeCashEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceSummary,
  StateFinanceRequestCandidateRow,
  StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { AUSTIN_FINANCE_LINK_SOURCE_URL } from "./austinCandidateFinanceAutoLink.js";
import {
  AUSTIN_CITY_GEOID,
  AUSTIN_FINANCE_ELIGIBLE_OFFICE_NAMES,
} from "./austinFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// What the outside totals leave out, by construction (see
// austinOutsideSpendingAggregator): direction comes only from the spender's
// own city filing, and one payment naming several candidates is not split.
const AUSTIN_OUTSIDE_COVERAGE_NOTE =
  "Counts only outside spending whose spender declared support or opposition for this candidate in its " +
  "City of Austin filings; payments naming several candidates at once, or with no declared direction, are not included. Unavailable totals do not mean zero.";

export async function loadAustinCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "TX",
    source: "AUSTIN_CITY_CLERK",
    sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
    enabled: isAustinCampaignFinanceEnabled,
    // Structural gate only: election rows carry no ballot title, so the
    // district-number rule cannot run here. Austin-linked rows exist only
    // for candidates the (fully gated) sync wrote, so this is a narrowing
    // filter, not the eligibility authority.
    isEligibleElection: (row) =>
      row.state?.trim().toUpperCase() === "TX" &&
      row.district_type === "place" &&
      row.geoid_compact === AUSTIN_CITY_GEOID &&
      row.office_scope === "place" &&
      (AUSTIN_FINANCE_ELIGIBLE_OFFICE_NAMES as readonly string[]).includes(
        row.office_canonical_name?.trim() ?? "",
      ),
    linkIdentityColumn: "filer_key",
    outsideGroupIdentityColumns: { id: "spender_key", name: "spender_name" },
    outsideCoverageNote: AUSTIN_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "atx_candidate_finance_links",
      summaries: "atx_candidate_finance_summaries",
      directBreakdowns: "atx_candidate_finance_direct_breakdowns",
      outsideGroups: "atx_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "atx_candidate_finance_outside_group_breakdowns",
    },
  });
  if (isAustinReportedCommitteeCashEnabled()) await appendAustinReportedCommitteeCash(db, summaries);
  return summaries;
}
