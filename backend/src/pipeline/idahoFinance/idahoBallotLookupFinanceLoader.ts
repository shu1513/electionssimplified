import type { Pool, PoolClient } from "pg";

import { isIdahoCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { IDAHO_CFS_PUBLIC_SITE_URL } from "./idahoCfsClient.js";
import { isIdahoFinanceEligibleOffice } from "./idahoFinanceEligibleOffices.js";
import { overlayIdahoReportedPacReceipts } from "./idahoReportedPacReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// Two facts the reader needs (plan Phase 2a): the headline is the state's
// official per-registration figure, while the size buckets come from the
// transaction search, which omits rows of some filed reports; and Idaho
// collects no donor occupation or employer, so there is no occupation chart.
const IDAHO_DIRECT_COVERAGE_NOTE =
  "Totals are the Idaho Secretary of State's official figures for this registration. Contribution-size breakdowns are built from the state's transaction search, which can omit contributions from some filed reports. Idaho does not collect donor occupation or employer.";

export async function loadIdahoCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "ID",
    source: "IDAHO_SUNSHINE",
    sourceUrl: IDAHO_CFS_PUBLIC_SITE_URL,
    enabled: isIdahoCampaignFinanceEnabled,
    isEligibleElection: (row) => isIdahoFinanceEligibleOffice(officeInputFromElectionRow(row)),
    linkIdentityColumn: "registration_guid",
    outsideGroupIdentityColumns: {
      id: "filer_key",
      name: "filer_name",
    },
    // contributor_source_type rows are stored but no loader surfaces them
    // yet (Phase 2a UI decision); occupation/industry never exist for Idaho.
    directBreakdownCategoryTypes: ["contribution_size"],
    evidenceLabelTypes: ["donor"],
    directCoverageNote: IDAHO_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "id_candidate_finance_links",
      summaries: "id_candidate_finance_summaries",
      directBreakdowns: "id_candidate_finance_direct_breakdowns",
      outsideGroups: "id_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "id_candidate_finance_outside_group_breakdowns",
    },
  });
  return overlayIdahoReportedPacReceipts(db,summaries,candidateRows,electionRows);
}
