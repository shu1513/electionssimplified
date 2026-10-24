import { afterEach, describe, expect, it, vi } from "vitest";

import { loadWisconsinCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/wisconsinFinance/wisconsinBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wisconsinBallotLookupFinanceLoader", () => {
  it("does not read new cash tables while publication is held", async () => {
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("WISCONSIN_REPORTED_COMMITTEE_CASH_ENABLED", "false");
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await loadWisconsinCandidateFinanceSummariesByCandidateElection(db,
      [{ candidate_id: "11111111-1111-4111-8111-111111111111", election_id: "22222222-2222-4222-8222-222222222222" }],
      [{ election_id: "22222222-2222-4222-8222-222222222222", state: "WI", office_scope: "statewide", office_canonical_name: "State Treasurer" }]);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("reported_cash"))).toBe(false);
  });
  runStateFinanceLoaderCharacterization({
    load: loadWisconsinCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "WISCONSIN_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "WI",
    tablePrefix: "wi_candidate_finance",
    source: "WISCONSIN_SUNSHINE",
    genericSourceUrl: "https://campaignfinance.wi.gov/",
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Governor" },
    ineligibleOffice: { office_scope: "place", office_canonical_name: "Mayor" },
  });
});
