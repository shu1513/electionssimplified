import type { Pool, PoolClient } from "pg";

import { isWashingtonCampaignFinanceEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceSummary,
  StateFinanceRequestCandidateRow,
  StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { overlayWashingtonReportedPacReceipts } from "./washingtonReportedPacReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_WASHINGTON_PDC_SOURCE_URL = "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data";

// Washington requires occupation/employer disclosure only for donors whose
// contributions exceed $250 in aggregate per campaign, and batched small
// contributions (including Seattle democracy-voucher redemptions) carry no
// donor detail at all — so the occupation breakdowns legitimately explain
// less than the official totals (Seattle 2025 live probe: 63% of itemized
// individual dollars carried an occupation). Mini-reporting campaigns
// (roughly a $7,000 ceiling) file no itemized contribution reports with the
// PDC at all; the note covers that case too because the reporting option is
// not propagated per candidate.
const WASHINGTON_DIRECT_COVERAGE_NOTE =
  "Occupation breakdowns reflect donors whose contributions exceed $250 in aggregate, the threshold above " +
  "which Washington requires occupation disclosure. Smaller and batched contributions are included in the " +
  "official totals but carry no donor detail, and campaigns using Washington's mini-reporting option file " +
  "no itemized contribution reports at all.";

export async function loadWashingtonCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "WA",
    source: "WASHINGTON_PDC",
    sourceUrl: GENERIC_WASHINGTON_PDC_SOURCE_URL,
    enabled: isWashingtonCampaignFinanceEnabled,
    // Washington's link table keeps the canonical committee_id, but its
    // outside tables use sponsor_id/sponsor_name — the mixed-identity case the
    // per-relation descriptor exists for. Evidence uses both label types (the
    // shared default).
    outsideGroupIdentityColumns: { id: "sponsor_id", name: "sponsor_name" },
    directCoverageNote: WASHINGTON_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "wa_candidate_finance_links",
      summaries: "wa_candidate_finance_summaries",
      directBreakdowns: "wa_candidate_finance_direct_breakdowns",
      outsideGroups: "wa_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "wa_candidate_finance_outside_group_breakdowns",
    },
  });
  return overlayWashingtonReportedPacReceipts(db, summaries, candidateRows, electionRows);
}
