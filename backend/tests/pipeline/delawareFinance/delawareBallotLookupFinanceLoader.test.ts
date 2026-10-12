import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDelawareCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/delawareFinance/delawareBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";

const CANDIDATE = "11111111-1111-4111-8111-111111111111";
const ELECTION = "22222222-2222-4222-8222-222222222222";
const candidate = { candidate_id: CANDIDATE, election_id: ELECTION };
const election = { election_id: ELECTION, state: "DE", office_scope: "statewide", office_canonical_name: "Attorney General" };
function dbWithDonors(donors: Record<string, unknown>[]) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("de_candidate_finance_pac_donors")) return { rows: donors };
    if (sql.includes("count(DISTINCT link.committee_id)")) return { rows: [{
      candidate_id: CANDIDATE, election_id: ELECTION, committee_id: "01009999", election_year: 2026,
      total_receipts: "15000", direct_contribution_total: "15000", total_disbursements: "500",
      cash_on_hand: "14500", outside_support_total: null, outside_oppose_total: null,
      source_url: "https://cfrs.elections.delaware.gov/", last_synced_at: "2026-10-11T23:00:00Z",
    }] };
    return { rows: [] };
  }) };
}
const donor = (id: number, overrides: Record<string, unknown> = {}) => ({
  candidate_id: CANDIDATE, election_id: ELECTION, committee_id: `reported:${id}`,
  committee_name: `Example Entity ${id}`, committee_type: "Political Action Committee", amount: "100.25",
  source_url: "https://cfrs.elections.delaware.gov/", industry_slug: null, classification_source: null, confidence: null,
  ...overrides,
});

afterEach(() => vi.unstubAllEnvs());

describe("delawareBallotLookupFinanceLoader", () => {
  it("totals every eligible committee before name caps and keeps Raised unchanged", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([...Array.from({ length: 8 }, (_, index) => donor(index)),
      donor(9, { committee_type: "Candidate Committee", amount: "9000" }),
      donor(10, { committee_type: "Corporation/Partnership/Other Entity", amount: "8000" }), donor(11, { amount: "-500" })]);
    const result = await loadDelawareCandidateFinanceSummariesByCandidateElection(db, [candidate], [election]);
    const summary = result.get(`${CANDIDATE}\u0000${ELECTION}`)!;
    const groups = summary.direct_campaign.pac_money_by_interest!;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ amount: 802, pac_count: 8, interest_name: "Not yet sorted" });
    expect(groups[0]!.pacs).toHaveLength(5);
    expect(summary.direct_campaign.total_raised).toBe(15000);
    expect(summary.outside_spending.support_total).toBeNull();
    const [sql, params] = db.query.mock.calls.find(([sql]) => sql.includes("de_candidate_finance_pac_donors"))! as unknown as [string, unknown[]];
    expect(sql).not.toMatch(/\bLIMIT\b/i);
    expect(sql).toContain("sum(amount)");
    expect(sql).toContain("coalesce(donor.registered_committee_id, '') <> link.committee_id");
    expect(JSON.parse(String(params[0]))).toEqual([candidate]);
  });

  it("uses trusted interests but keeps eligible source committees when name rules suggest a hidden category", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([
      donor(1, { industry_slug: "construction", classification_source: "manual" }),
      donor(2, { committee_type: "Out-of-State or Federal Committee", industry_slug: "finance_investment", classification_source: "rule", confidence: "low" }),
      donor(3, { committee_type: "Political Committee", industry_slug: "candidate_committees", classification_source: "manual" }),
    ]);
    const summary = (await loadDelawareCandidateFinanceSummariesByCandidateElection(db, [candidate], [election])).get(`${CANDIDATE}\u0000${ELECTION}`)!;
    const groups = summary.direct_campaign.pac_money_by_interest!;
    expect(groups.reduce((total, group) => total + group.amount, 0)).toBe(300.75);
    expect(groups.find(group => group.interest_name === "Not yet sorted")).toMatchObject({ amount: 200.5, pac_count: 2 });
    expect(groups.find(group => group.interest === "construction")).toMatchObject({ amount: 100.25, pac_count: 1 });
  });

  it("does not query donors when the base loader returned no summaries", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await loadDelawareCandidateFinanceSummariesByCandidateElection(db, [candidate], [election])).toEqual(new Map());
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("pac_donors"))).toBe(false);
  });
  runStateFinanceLoaderCharacterization({
    load: loadDelawareCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "DELAWARE_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "DE",
    tablePrefix: "de_candidate_finance",
    source: "DELAWARE_CFRS",
    additionalQueryAliases: [{ link: "links", donor: "pac_donors" }],
    genericSourceUrl: "https://cfrs.elections.delaware.gov/",
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Attorney General" },
    ineligibleOffice: { office_scope: "county", office_canonical_name: "Sheriff" },
    directCoverageNote:
      "Delaware does not require donor occupation disclosure; occupation charts reflect voluntarily disclosed contributions only.",
    outsideCoverageNote:
      "Delaware outside spending coverage is incomplete. Unavailable totals do not mean zero.",
  });
});
