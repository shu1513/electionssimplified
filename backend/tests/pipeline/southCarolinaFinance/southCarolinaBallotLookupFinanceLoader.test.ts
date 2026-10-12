import { afterEach, describe, vi } from "vitest";

import { SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE } from "../../../src/pipeline/southCarolinaFinance/southCarolinaDirectContributionAggregator.js";
import { loadSouthCarolinaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/southCarolinaFinance/southCarolinaBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

afterEach(() => vi.unstubAllEnvs());

describe("southCarolinaBallotLookupFinanceLoader", () => {
  runStateFinanceLoaderCharacterization({
    load: loadSouthCarolinaCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "SC",
    tablePrefix: "sc_candidate_finance",
    source: "SOUTH_CAROLINA_CAMPAIGN_FINANCE",
    genericSourceUrl: "https://ethicsfiling.sc.gov/public",
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Governor" },
    ineligibleOffice: { office_scope: "county", office_canonical_name: "Sheriff" },
    directCoverageNote: SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote:
      "South Carolina outside spending coverage is incomplete. Unavailable totals do not mean zero.",
  });
});
