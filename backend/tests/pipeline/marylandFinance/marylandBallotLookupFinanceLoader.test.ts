import { afterEach, describe, vi } from "vitest";

import { loadMarylandCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/marylandFinance/marylandBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("marylandBallotLookupFinanceLoader", () => {
  runStateFinanceLoaderCharacterization({
    load: loadMarylandCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "MARYLAND_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "MD",
    tablePrefix: "md_candidate_finance",
    source: "MARYLAND_CFS",
    genericSourceUrl: "https://campaignfinance.maryland.gov/public/cf/downloads",
    additionalQueryAliases: [{src: "pac_sources", donor: "pac_donors"}],
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Governor" },
    ineligibleOffice: { office_scope: "place", office_canonical_name: "Mayor" },
  });
});
