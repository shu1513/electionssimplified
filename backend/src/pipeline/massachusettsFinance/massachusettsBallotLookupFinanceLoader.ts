import type { Pool, PoolClient } from "pg";

import { isMassachusettsCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isMassachusettsFinanceEligibleElectionRow } from "./massachusettsFinanceEligibleOffices.js";
import { attachMassachusettsReportedFinance } from "./massachusettsReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_MASSACHUSETTS_OCPF_SOURCE_URL = "https://www.ocpf.us/";

// The outside leg reads OCPF's IEPAC report feed only. Independent spending
// disclosed by other filer types (the separate "ordinary" IE report feed) and
// electioneering communications are not read yet. That is a systematic gap,
// not a rounding error, so it is stated with the totals until those paths
// ship — at which point this note is removed.
const MASSACHUSETTS_OUTSIDE_COVERAGE_NOTE =
  "Covers independent expenditures reported by independent expenditure PACs (IEPACs) to the Massachusetts " +
  "Office of Campaign and Political Finance. Independent spending by other filer types and electioneering " +
  "communications are not included yet.";

// Official raised/spent totals are OCPF bank-report year-to-date cover
// figures; the breakdowns come from itemized receipts, whose sum differs
// from the cover figures (refunds, timing, prior-year and unitemized money).
// "Where available" is load-bearing: when the YTD feed has no row for a
// candidate the sync stores the itemized-receipt sum as raised, so the note
// must not promise a bank-report figure for every candidate. Without this
// sentence a reader reasonably assumes the breakdowns explain the whole
// total.
const MASSACHUSETTS_DIRECT_COVERAGE_NOTE =
  "Donor breakdowns reflect itemized receipts reported to the Massachusetts Office of Campaign and Political " +
  "Finance. Totals are official bank-report year-to-date figures where available (otherwise sums of itemized " +
  "receipts) and can include money not shown in the breakdowns.";

export async function loadMassachusettsCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "MA",
    source: "MASSACHUSETTS_OCPF",
    sourceUrl: GENERIC_MASSACHUSETTS_OCPF_SOURCE_URL,
    enabled: isMassachusettsCampaignFinanceEnabled,
    // Place offices additionally require an allowlisted municipal GEOID.
    isEligibleElection: (row) => isMassachusettsFinanceEligibleElectionRow(row),
    // Massachusetts renames both identities: candidate_cpf_id on the link
    // table, iepac_cpf_id/iepac_name on the outside tables.
    linkIdentityColumn: "candidate_cpf_id",
    outsideGroupIdentityColumns: { id: "iepac_cpf_id", name: "iepac_name" },
    evidenceLabelTypes: ["donor"],
    outsideCoverageNote: MASSACHUSETTS_OUTSIDE_COVERAGE_NOTE,
    directCoverageNote: MASSACHUSETTS_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "ma_candidate_finance_links",
      summaries: "ma_candidate_finance_summaries",
      directBreakdowns: "ma_candidate_finance_direct_breakdowns",
      outsideGroups: "ma_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "ma_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachMassachusettsReportedFinance({ db, summaries, requests: buildStateFinanceSummaryRequests("MA", candidateRows, electionRows,
    row => isMassachusettsFinanceEligibleElectionRow(row)) });
}
