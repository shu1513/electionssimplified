import type { Pool, PoolClient } from "pg";

import { isAlaskaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isAlaskaFinanceEligibleOffice } from "./alaskaFinanceEligibleOffices.js";

import { overlayAlaskaReportedFinance } from "./alaskaReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_ALASKA_APOC_SOURCE_URL = "https://aws.state.ak.us/ApocReports/Campaign/";

// The bespoke loader carried local helper copies with two edge behaviors the
// shared helpers do not have: parseFinanceAmount("") returned null (shared
// returns 0) and parseFinanceCount truncated instead of rounding. Both are
// unobservable on real rows — amount columns are numeric(16,2) NOT NULL and
// contributor_count is integer, so Postgres never yields "" or fractional
// count strings — an accepted no-op delta of this migration.
export async function loadAlaskaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "AK",
    source: "ALASKA_APOC",
    sourceUrl: GENERIC_ALASKA_APOC_SOURCE_URL,
    enabled: isAlaskaCampaignFinanceEnabled,
    isEligibleElection: (row) => isAlaskaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    // Alaska renames both identities: candidate_filer_id on the link table,
    // outside_group_id/outside_group_name on the outside tables.
    linkIdentityColumn: "candidate_filer_id",
    outsideGroupIdentityColumns: { id: "outside_group_id", name: "outside_group_name" },
    evidenceLabelTypes: ["donor"],
    tables: {
      links: "ak_candidate_finance_links",
      summaries: "ak_candidate_finance_summaries",
      directBreakdowns: "ak_candidate_finance_direct_breakdowns",
      outsideGroups: "ak_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "ak_candidate_finance_outside_group_breakdowns",
    },
  });
  return overlayAlaskaReportedFinance(db, summaries, candidateRows, electionRows);
}
