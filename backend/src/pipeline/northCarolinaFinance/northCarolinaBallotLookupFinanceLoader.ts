import type { Pool, PoolClient } from "pg";

import { isNorthCarolinaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  buildStateFinanceSummaryRequests,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isNorthCarolinaFinanceEligibleOffice } from "./northCarolinaFinanceEligibleOffices.js";
import { attachNorthCarolinaReportedReceiptComponent } from "./northCarolinaReportedReceiptFinanceReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_NORTH_CAROLINA_SBE_SOURCE_URL = "https://cf.ncsbe.gov/CFOrgLkup/";

// docs/plans/north_carolina_plan.md decision 13: a share of NCSBE filings (23 of 95
// independent-expenditure filings in the 2026 inventory) exist only as
// scanned images with no structured data view, and the pipeline never OCRs
// images into production totals. That is a systematic gap, not a rounding
// error, so it is stated with the totals until a reviewed PDF/image path
// ships — at which point this note is removed.
const NORTH_CAROLINA_OUTSIDE_COVERAGE_NOTE =
  "Covers outside spending from filings with structured data at the North Carolina State Board of Elections. " +
  "Filings available only as scanned images are not included yet.";

export async function loadNorthCarolinaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "NC",
    source: "NORTH_CAROLINA_SBE",
    sourceUrl: GENERIC_NORTH_CAROLINA_SBE_SOURCE_URL,
    enabled: isNorthCarolinaCampaignFinanceEnabled,
    isEligibleElection: (row) => isNorthCarolinaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    outsideCoverageNote: NORTH_CAROLINA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "nc_candidate_finance_links",
      summaries: "nc_candidate_finance_summaries",
      directBreakdowns: "nc_candidate_finance_direct_breakdowns",
      outsideGroups: "nc_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "nc_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachNorthCarolinaReportedReceiptComponent({ db, summaries,
    requests: buildStateFinanceSummaryRequests("NC", candidateRows, electionRows,
      (row) => isNorthCarolinaFinanceEligibleOffice(officeInputFromElectionRow(row))) });
}
