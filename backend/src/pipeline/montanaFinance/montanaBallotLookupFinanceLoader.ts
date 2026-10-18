import type { Pool, PoolClient } from "pg";

import { isMontanaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { MONTANA_CERS_DASHBOARD_URL } from "./montanaCersClient.js";
import { isMontanaFinanceEligibleOffice } from "./montanaFinanceEligibleOffices.js";
import { overlayMontanaCommitteeReceipts } from "./montanaReportedCommitteeReader.js";
import { overlayMontanaIndependentIe } from "./montanaIndependentIeReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// Wording is careful not to overclaim: a candidate with a single filed
// report has no consecutive-report boundary to verify, so the chain claim
// is scoped to where consecutive reports exist. Itemized totals are always
// cross-checked between the report-detail and export surfaces.
const MONTANA_DIRECT_COVERAGE_NOTE =
  "Totals are summed from itemized Montana CERS filings; where consecutive reports exist they are verified against the official cash-balance chain, which also supplies derived unitemized small-donor amounts. Occupation breakdowns come from the state's export file, which can omit small or amended contributions.";

// The plan's Phase 2b hard gate: Montana outside data must not go live
// without this footnote (web and mobile both render outside_coverage_note).
// Two claims, both load-bearing: (1) only filer-disclosed targets that could
// be verified are counted — a large share of Montana IE money names no
// verifiable target ("see attached", blanks, multi-candidate rows) and is
// excluded; (2) Montana's benefit-reporting convention means support totals
// can include attack spending against an opponent, and opposition appears
// only where the filer declared it (never inferred).
const MONTANA_OUTSIDE_COVERAGE_NOTE =
  "Counts only independent expenditures whose disclosed target could be verified; many Montana filings name no verifiable candidate and are excluded. Montana support totals can include spending that benefits a candidate by opposing an opponent; opposition is shown only where the filer declared it.";

export async function loadMontanaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "MT",
    source: "MONTANA_COPP",
    sourceUrl: MONTANA_CERS_DASHBOARD_URL,
    enabled: isMontanaCampaignFinanceEnabled,
    isEligibleElection: (row) => isMontanaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    // Phase 2b outside funders are organizational donors only (MO pattern).
    evidenceLabelTypes: ["donor"],
    directCoverageNote: MONTANA_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote: MONTANA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "mt_candidate_finance_links",
      summaries: "mt_candidate_finance_summaries",
      directBreakdowns: "mt_candidate_finance_direct_breakdowns",
      outsideGroups: "mt_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "mt_candidate_finance_outside_group_breakdowns",
    },
  });
  await overlayMontanaIndependentIe(db,summaries,candidateRows,electionRows,MONTANA_OUTSIDE_COVERAGE_NOTE);
  return overlayMontanaCommitteeReceipts(db,summaries,candidateRows,electionRows);
}
