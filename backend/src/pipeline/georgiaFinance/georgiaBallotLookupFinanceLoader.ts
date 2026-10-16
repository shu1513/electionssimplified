import type { Pool, PoolClient } from "pg";

import { isGeorgiaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  buildStateFinanceSummaryRequests,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isGeorgiaFinanceEligibleOffice } from "./georgiaFinanceEligibleOffices.js";
import { attachGeorgiaReportedFinanceComponents } from "./georgiaReportedFinanceReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_GEORGIA_ETHICS_SOURCE_URL = "https://ethics.ga.gov/records-search-all/";

// docs/plans/georgia_plan.md D6/D12: Georgia discloses no per-target amount on an
// independent expenditure, so a transaction naming more than one target —
// several candidates, or a candidate plus a ballot measure — has no
// defensible split and stays out of the per-candidate totals (49 of 387 IE
// transactions in the 2026 filing-year probe). That is a systematic gap,
// not a rounding error, so it is stated with the totals until the source
// discloses target-level amounts — at which point this note is removed.
// (Malformed rows D6 also quarantines — duplicate or missing targets,
// conflicting stances — are data-quality diagnostics, not a systematic
// gap, and deliberately stay out of this user-facing sentence.)
//
// The second gap (D12b, pinned at the spike): expenditures disclosed only to
// the retired pre-July-2025 filing system carry no target registration id at
// all, so they can never attribute — the IE leg reads the current system
// only. For the 2026-cycle candidates in v1 scope that money is pre-cycle,
// but the note states the boundary honestly.
const GEORGIA_OUTSIDE_COVERAGE_NOTE =
  "Covers independent expenditures that name a single candidate, as reported to the Georgia Government " +
  "Transparency and Campaign Finance Commission's current filing system (July 2025 onward). Spending " +
  "reported for more than one candidate or measure in a single expenditure is not included yet.";

// Georgia's official totals are the commission's cumulative report-cover
// figures, which count money (pre-July-2025 filings, loans, carried
// balances) that the current system's transaction store does not itemize —
// so the occupation/size breakdowns can legitimately explain less than the
// official total (live-verified 2026-08-09; see docs/plans/georgia_plan.md). Without
// this sentence a reader reasonably assumes the breakdowns cover all the
// money.
const GEORGIA_DIRECT_COVERAGE_NOTE =
  "Donor breakdowns reflect itemized contributions reported to Georgia's current filing system " +
  "(July 2025 onward). Official totals are cumulative and can include earlier or non-itemized money " +
  "not shown in the breakdowns.";

export async function loadGeorgiaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "GA",
    source: "GEORGIA_ETHICS",
    sourceUrl: GENERIC_GEORGIA_ETHICS_SOURCE_URL,
    enabled: isGeorgiaCampaignFinanceEnabled,
    isEligibleElection: (row) => isGeorgiaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    outsideCoverageNote: GEORGIA_OUTSIDE_COVERAGE_NOTE,
    directCoverageNote: GEORGIA_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "ga_candidate_finance_links",
      summaries: "ga_candidate_finance_summaries",
      directBreakdowns: "ga_candidate_finance_direct_breakdowns",
      outsideGroups: "ga_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "ga_candidate_finance_outside_group_breakdowns",
    },
  });
  return attachGeorgiaReportedFinanceComponents({ db, summaries,
    requests: buildStateFinanceSummaryRequests("GA", candidateRows, electionRows,
      row => isGeorgiaFinanceEligibleOffice(officeInputFromElectionRow(row))) });
}
