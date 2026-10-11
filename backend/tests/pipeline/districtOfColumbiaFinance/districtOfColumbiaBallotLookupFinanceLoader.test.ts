import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

describe("districtOfColumbiaBallotLookupFinanceLoader", () => {
  // Pins the loader-internal flag gate the Phase 3 registry relies on
  // (adapters carry no enabled-checks; every loader must self-gate).
  it("returns an empty map without querying when DC campaign finance is disabled", async () => {
    const query = vi.fn();

    const result = await loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "DC" }]
    );

    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  runStateFinanceLoaderCharacterization({
    load: loadDistrictOfColumbiaCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "DC",
    tablePrefix: "dc_candidate_finance",
    source: "DISTRICT_OF_COLUMBIA_OCF",
    genericSourceUrl: "https://efiling.ocf.dc.gov/DataDownload",
    // DC has no ballot-lookup office filter, so any DC election is eligible
    // (same shape as washington's spec).
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Mayor" },
    // Fair Elections public funds (migration 321).
    publicFundsReceived: true,
  });
});
