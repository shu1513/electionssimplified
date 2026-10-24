import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRhodeIslandCommitteeCashSummaries as append } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashBallotSummary.js";
import { isRhodeIslandReportedCommitteeCashEnabled } from "../../../src/config/featureFlags.js";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
const request = { candidate_id: "11111111-1111-4111-8111-111111111111", election_id: "22222222-2222-4222-8222-222222222222" };
const key = candidateElectionKey(request.candidate_id, request.election_id);
function row(patch: Record<string, unknown> = {}) {
  return { ...request, election_year: 2026, candidate_name: "Jordan Example", candidate_name_normalized: "JORDAN EXAMPLE",
    observed_at: "2026-10-24 09:00:00+00", period_end: "2026-10-05", group_count: 1, cash_cents: "100000", selected_occurrences: 1,
    source_url: "https://www.ricampaignfinance.com/RIPublic/Reporting/TransactionReport.aspx?OrgID=123&BeginDate=01/01/2025&EndDate=12/31/2026",
    reported_key: '["PAC","QZX EXAMPLE PAC"]', committee_name: "QZX Example PAC", source_class: "PAC", amount_cents: "100000", contribution_count: 1,
    industry_slug: null, classification_source: null, confidence: null, ...patch };
}
function seed(): BallotLookupFinanceSummary {
  return { source: "RHODE_ISLAND_ERTS", cycle: 2026, fec_candidate_id: null, last_synced_at: "2026-10-01T09:00:00.000Z",
    direct_campaign: { total_raised: 20_000, total_spent: 1_000, cash_on_hand: 19_000, debts_owed: null, top_occupations: [], top_industries: [] },
    outside_spending: { support_total: 10_000, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
}
function database(rows: object[]) { return { query: vi.fn(async () => ({ rows })) } as any; }
afterEach(() => vi.unstubAllEnvs());
describe("Rhode Island reported cash read path", () => {
  it("defaults publication off and requires the state master flag", () => {
    vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("RHODE_ISLAND_REPORTED_COMMITTEE_CASH_ENABLED", "false");
    expect(isRhodeIslandReportedCommitteeCashEnabled()).toBe(false);
    vi.stubEnv("RHODE_ISLAND_REPORTED_COMMITTEE_CASH_ENABLED", "true"); expect(isRhodeIslandReportedCommitteeCashEnabled()).toBe(true);
    vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED", "false"); expect(isRhodeIslandReportedCommitteeCashEnabled()).toBe(false);
  });
  it("keeps unknown interests under Not yet sorted and preserves other finance clocks/money", async () => {
    const original = seed(), summaries = new Map([[key, original]]);
    await append(database([row()]), [request], summaries);
    expect(original.last_synced_at).toBe("2026-10-01T09:00:00.000Z");
    expect(original.direct_campaign.total_raised).toBe(20_000); expect(original.outside_spending.support_total).toBe(10_000);
    expect(original.direct_campaign.pac_money_by_interest).toEqual([expect.objectContaining({ interest: "unclassified", interest_name: "Not yet sorted", amount: 1000, pac_count: 1 })]);
    expect(original.direct_campaign.pac_money_basis).toBe("reported_itemized_committee_cash_contributions");
    expect(original.direct_campaign.pac_money_coverage_note).toContain("Gross positive");
    expect(original.direct_campaign.pac_money_coverage_note).toContain("expenditure-side returns");
    expect(original.direct_campaign.pac_money_coverage_note).toContain("2026-10-05");
  });
  it("keeps uncapped interest totals/counts before limiting donor detail", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ group_count: 6, cash_cents: "600000", selected_occurrences: 6,
      committee_name: `QZX Example ${i} PAC`, reported_key: JSON.stringify(["PAC", `QZX EXAMPLE ${i} PAC`]) }));
    const summaries = new Map<string, BallotLookupFinanceSummary>(); await append(database(rows), [request], summaries);
    const interest = summaries.get(key)!.direct_campaign.pac_money_by_interest![0]!;
    expect(interest).toMatchObject({ amount: 6000, pac_count: 6 }); expect(interest.pacs).toHaveLength(5);
  });
  it.each([
    { group_count: 2 }, { cash_cents: "200000" }, { selected_occurrences: 2 },
    { candidate_name_normalized: "OTHER PERSON" }, { source_class: "Unknown" }, { amount_cents: "100000.5" },
    { reported_key: '["PAC","DIFFERENT NAME"]' }, { observed_at: "not-a-clock" },
  ])("omits inconsistent source data rather than returning an empty committee list", async patch => {
    const original = seed(), before = structuredClone(original), summaries = new Map([[key, original]]);
    await append(database([row(patch)]), [request], summaries); expect(original).toEqual(before);
  });
  it("does not count duplicate reported groups twice", async () => {
    const summaries = new Map<string, BallotLookupFinanceSummary>(); await append(database([row(), row()]), [request], summaries);
    expect(summaries.size).toBe(0);
  });
  it("returns a true accepted zero only after complete source-count closure", async () => {
    const summaries = new Map<string, BallotLookupFinanceSummary>();
    await append(database([row({ group_count: 0, cash_cents: "0", selected_occurrences: 0, reported_key: null,
      committee_name: null, source_class: null, amount_cents: null, contribution_count: null })]), [request], summaries);
    expect(summaries.get(key)!.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(summaries.get(key)!.outside_spending.support_total).toBeNull();
  });
  it("does not turn a product-excluded positive interest into a nothing-reported message", async () => {
    const summaries = new Map<string, BallotLookupFinanceSummary>();
    await append(database([row({ industry_slug: "candidate_committees", classification_source: "manual", confidence: "high" })]), [request], summaries);
    expect(summaries.size).toBe(0);
  });
  it("does not trust low-confidence interest guesses", async () => {
    const summaries = new Map<string, BallotLookupFinanceSummary>();
    await append(database([row({ industry_slug: "healthcare", classification_source: "ai", confidence: "medium" })]), [request], summaries);
    expect(summaries.get(key)!.direct_campaign.pac_money_by_interest![0]!.interest).toBe("unclassified");
  });
  it("does not read donor tables for an empty request scope", async () => {
    const db = database([]); await append(db, [], new Map()); expect(db.query).not.toHaveBeenCalled();
  });
});
