import { afterEach, describe, vi } from "vitest";

import { loadVermontCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/vermontFinance/vermontBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";
import { VERMONT_OUTSIDE_COVERAGE_NOTE } from "../../../src/pipeline/vermontFinance/vermontCommitteeCashReader.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vermontBallotLookupFinanceLoader characterization", () => {
  runStateFinanceLoaderCharacterization({
    load: loadVermontCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "VERMONT_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "VT",
    tablePrefix: "vt_candidate_finance",
    source: "VERMONT_CFD",
    genericSourceUrl: "https://campaignfinance.vermont.gov/",
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Governor" },
    ineligibleOffice: { office_scope: "place", office_canonical_name: "Mayor" },
    directCategoryTypes: ["contribution_size"],
    outsideSupportActionLabel: "PAC contributions supporting this candidate",
    outsideTotalsUnknown: true,
    outsideCoverageNote: VERMONT_OUTSIDE_COVERAGE_NOTE,
    additionalQueryAliases: [{ link: "links", source: "pac_sources", donor: "pac_donors" }],
  });
});
