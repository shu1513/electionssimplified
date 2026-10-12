import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMaineCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/maineFinance/maineBallotLookupFinanceLoader.js";
import { runStateFinanceLoaderCharacterization } from "../../helpers/stateFinanceLoaderCharacterization.js";
import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maineBallotLookupFinanceLoader", () => {
  runStateFinanceLoaderCharacterization({
    load: loadMaineCandidateFinanceSummariesByCandidateElection,
    flagEnvVar: "MAINE_CAMPAIGN_FINANCE_ENABLED",
    stateCode: "ME",
    tablePrefix: "me_candidate_finance",
    source: "MAINE_CFIS",
    additionalQueryAliases: [{ link: "links", marker: "source_markers" }],
    genericSourceUrl: "https://mainecampaignfinance.com/",
    eligibleOffice: { office_scope: "statewide", office_canonical_name: "Governor" },
    ineligibleOffice: { office_scope: "place", office_canonical_name: "Mayor" },
  });
});


const CANDIDATE = "11111111-1111-4111-8111-111111111111";
const ELECTION = "22222222-2222-4222-8222-222222222222";
const key = `${CANDIDATE}\u0000${ELECTION}`;
const sourceId = (letter: string) => `f_${letter.repeat(26)}`;
const transactionId = (letter: string) => `a_${letter.repeat(26)}`;
const candidates = [{ candidate_id: CANDIDATE, election_id: ELECTION }];
const elections = [{ election_id: ELECTION, state: "ME", office_scope: "statewide", office_canonical_name: "Governor" }];
const marker = (component: string) => ({ candidate_id: CANDIDATE, election_id: ELECTION, election_year: 2026, source_calendar_year: 2026, component, period_end: "2026-10-11", observed_at: "2026-10-12T20:00:00Z", published_source_times: { allFiler: "10/11/2026 09:59 ET", independentExpenditures: "10/11/2026 09:55 ET" } });
function donor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: CANDIDATE, election_id: ELECTION, source_filer_id: sourceId("r"), source_calendar_year: 2026,
    committee_id: "reported:EXAMPLE SOURCE COMMITTEE", committee_name: "Example Source Committee",
    source_reported_class: "political_action_committee", amount: "500.00", contribution_count: "1",
    gift_transaction_ids: [transactionId("a")], returned_transaction_ids: [], source_url: null,
    industry_slug: null, classification_source: null, confidence: null, ...overrides };
}
function allocation(overrides: Record<string, unknown> = {}) {
  return { candidate_id: CANDIDATE, election_id: ELECTION, transaction_id: transactionId("b"), target_filer_id: sourceId("r"),
    payer_id: sourceId("p"), payer_name: "Example Reported Payer", support_oppose: "support", transaction_date: "2026-09-29",
    amount: "50.00", whole_amount: "200.00", source_url: "https://www.mainecampaignfinancedisclosure.com/public", ...overrides };
}
function database(options: { markers?: Record<string, unknown>[]; donors?: Record<string, unknown>[]; allocations?: Record<string, unknown>[]; legacy?: Record<string, unknown>[]; summary?: Record<string, unknown> } = {}) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("me_candidate_finance_pac_donors")) return { rows: options.donors ?? [] };
    if (sql.includes("me_candidate_finance_maplight_allocations")) return { rows: options.allocations ?? [] };
    if (sql.includes("me_candidate_finance_source_markers")) return { rows: options.markers ?? [] };
    if (sql.includes("me_candidate_finance_summaries")) return { rows: [{ candidate_id: CANDIDATE, election_id: ELECTION, election_year: 2026,
      committee_id: "LEGACY_RECEIVER", total_receipts: "4000", direct_contribution_total: "3500", total_disbursements: "1000",
      cash_on_hand: "200", outside_support_total: "0", outside_oppose_total: "125", source_url: "https://mainecampaignfinance.com/",
      last_synced_at: "2026-09-22T00:00:00Z", ...options.summary }] };
    if (sql.includes("me_candidate_finance_outside_groups") && !sql.includes("me_candidate_finance_outside_group_breakdowns")) return { rows: options.legacy ?? [] };
    return { rows: [] };
  }) };
}
async function load(options: Parameters<typeof database>[0] = {}) {
  vi.stubEnv("MAINE_CAMPAIGN_FINANCE_ENABLED", "true");
  const db = database(options);
  const result = await loadMaineCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
  return { summary: result.get(key)!, db };
}

describe("Maine published MapLight reader overlay", () => {
  it("leaves legacy direct scalars, timestamp, outside values and groups untouched without a marker", async () => {
    const legacy = { candidate_id: CANDIDATE, election_id: ELECTION, committee_id: "LEGACY-PAYER", committee_name: "Existing Payer", support_oppose: "support", amount: "900", source_url: null };
    const { summary, db } = await load({ legacy: [legacy] });
    expect(summary.direct_campaign.total_raised).toBe(3500);
    expect(summary.last_synced_at).toBe("2026-09-22T00:00:00Z");
    expect(summary.outside_spending.support_total).toBe(0);
    expect(summary.outside_spending.oppose_total).toBe(125);
    expect(summary.outside_spending.top_supporting_groups[0].committee_id).toBe("LEGACY-PAYER");
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect(summary.outside_spending).not.toHaveProperty("outside_coverage_note");
    expect(db.query).toHaveBeenCalledTimes(6);
  });
  it("masks outside headline totals for a modern marker while retaining direct as-of and legacy groups", async () => {
    const legacy = { candidate_id: CANDIDATE, election_id: ELECTION, committee_id: "LEGACY-PAYER", committee_name: "Existing Payer", support_oppose: "support", amount: "900", source_url: null };
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [donor()], legacy: [legacy] });
    expect(summary.direct_campaign).toMatchObject({ total_raised: 3500, total_spent: 1000, cash_on_hand: 200 });
    expect(summary.last_synced_at).toBe("2026-09-22T00:00:00Z");
    expect(summary.outside_spending).toMatchObject({ support_total: null, oppose_total: null });
    expect(summary.outside_spending.top_supporting_groups[0].amount).toBe(900);
    expect(summary.direct_campaign.direct_coverage_note).toMatch(/2026 itemized cash.*2025 coverage is unknown/);
    expect(summary.outside_spending.outside_coverage_note).toMatch(/totals are unavailable, not zero/);
    expect(summary.direct_campaign.direct_coverage_note).toContain("Published source cutoff: 2026-10-11");
    expect(summary.direct_campaign.direct_coverage_note).toContain("All-filer publication: 10/11/2026 09:59 ET");
    expect(summary.direct_campaign.direct_coverage_note).toContain("Source observed: 2026-10-12T20:00:00Z");
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ interest: "unclassified", interest_name: "Not yet sorted", amount: 500, pac_count: 1 });
  });
  it("nets signed donor positions before filtering and does not count sibling source receivers twice", async () => {
    const positive = donor({ amount: "600.00" });
    const negative = donor({ source_filer_id: sourceId("s"), amount: "-100.00", contribution_count: 0, gift_transaction_ids: [], returned_transaction_ids: [transactionId("c")] });
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [positive, { ...positive }, negative] });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 500, pac_count: 1, pacs: [{ amount: 500 }] });
  });
  it("does not turn a negative or zero final net into a positive displayed donor", async () => {
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [donor({ amount: "-500.00", gift_transaction_ids: [], returned_transaction_ids: [transactionId("c")] }), donor({ source_filer_id: sourceId("s"), amount: "500.00" })] });
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([]);
  });
  it("retains explicit party and PAC names and computes all donor totals/counts before name caps", async () => {
    const donors = Array.from({ length: 8 }, (_, i) => donor({ committee_id: `reported:EXAMPLE SOURCE ${i}`, committee_name: `Example Source ${i}`, amount: "100.00", source_reported_class: i === 0 ? "political_party_committee" : "political_action_committee" }));
    const { summary } = await load({ markers: [marker("committee_donors")], donors });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 800, pac_count: 8 });
    expect(summary.direct_campaign.pac_money_by_interest?.[0].pacs).toHaveLength(5);
  });
  it("uses only high-trust interests and does not demote explicit source committees by interest hints", async () => {
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [
      donor({ committee_id: "reported:EXAMPLE LOW", committee_name: "Example Low", classification_source: "ai", confidence: "low", industry_slug: "healthcare", amount: "100" }),
      donor({ committee_id: "reported:EXAMPLE HIGH", committee_name: "Example High", classification_source: "manual", confidence: "low", industry_slug: "healthcare", amount: "200" }),
      donor({ committee_id: "reported:EXAMPLE CANDIDATE HINT", committee_name: "Example Candidate Hint", classification_source: "manual", confidence: "high", industry_slug: "candidate_committees", amount: "300" }),
    ] });
    expect(summary.direct_campaign.pac_money_by_interest?.map(group => [group.interest, group.amount, group.pac_count])).toEqual([["unclassified",400,2],["healthcare",200,1]]);
  });
  it("keeps unknown reviewed interest slugs in Not yet sorted rather than inventing a category", async () => {
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [donor({ classification_source: "manual", confidence: "high", industry_slug: "unknown_interest" })] });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ interest: "unclassified", interest_name: "Not yet sorted", amount: 500 });
  });
  it.each(["candidate_committee", "candidate", "business"])("never promotes source class %s to committee money", async source_reported_class => {
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [donor({ source_reported_class })] });
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
  });
  it("omits a conflicting or unsafe modern PAC component instead of partially understating it", async () => {
    const { summary } = await load({ markers: [marker("committee_donors")], donors: [donor(), donor({ amount: "499.00" })] });
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    const unsafe = await load({ markers: [marker("committee_donors")], donors: [donor(), donor({ committee_id: "reported:EXAMPLE LARGE", committee_name: "Example Large", amount: "90071992547409.92" })] });
    expect(unsafe.summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
  });
  it("materializes exact allocations, retaining distinct transaction occurrences and both directions", async () => {
    const first = allocation();
    const { summary } = await load({ markers: [marker("independent_expenditures")], allocations: [first, { ...first }, allocation({ transaction_id: transactionId("c"), amount: "25.00" }), allocation({ transaction_id: transactionId("d"), support_oppose: "oppose", amount: "10.00" })] });
    expect(summary.outside_spending.top_supporting_groups).toMatchObject([{ committee_id: sourceId("p"), amount: 75, expenditure_count: 2 }]);
    expect(summary.outside_spending.top_opposing_groups).toMatchObject([{ amount: 10, expenditure_count: 1 }]);
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.outside_spending.oppose_total).toBeNull();
  });
  it("preserves unrelated legacy groups and does not overwrite a legacy identity conflict", async () => {
    const legacy = { candidate_id: CANDIDATE, election_id: ELECTION, committee_id: sourceId("p"), committee_name: "Existing Name", support_oppose: "support", amount: "900", source_url: null };
    const { summary } = await load({ markers: [marker("independent_expenditures")], legacy: [legacy], allocations: [allocation(), allocation({ transaction_id: transactionId("c"), payer_id: sourceId("q"), payer_name: "Other Payer", amount: "20.00" })] });
    expect(summary.outside_spending.top_supporting_groups.map(group => [group.committee_name, group.amount])).toEqual([["Existing Name",900],["Other Payer",20]]);
  });
  it("does not clear legacy groups on empty or inconsistent modern allocations", async () => {
    const legacy = { candidate_id: CANDIDATE, election_id: ELECTION, committee_id: "OLD", committee_name: "Existing Payer", support_oppose: "support", amount: "100", source_url: null };
    const empty = await load({ markers: [marker("independent_expenditures")], allocations: [], legacy: [legacy] });
    expect(empty.summary.outside_spending.top_supporting_groups).toHaveLength(1);
    const conflicting = await load({ markers: [marker("independent_expenditures")], allocations: [allocation(), allocation({ amount: "49.00" })], legacy: [legacy] });
    expect(conflicting.summary.outside_spending.top_supporting_groups[0].committee_id).toBe("OLD");
    expect(conflicting.summary.outside_spending.top_supporting_groups).toHaveLength(1);
  });
  it("leaves outside allocations readable when the PAC component is independently invalid", async () => {
    const { summary, db } = await load({ markers: [marker("committee_donors"), marker("independent_expenditures")], donors: [donor({ amount: "1.001" })], allocations: [allocation()] });
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect(summary.outside_spending.top_supporting_groups[0].amount).toBe(50);
    const sql = db.query.mock.calls.map(call => call[0]).join("\n");
    expect(sql).toContain("allocation.target_filer_id = marker.source_filer_id");
    expect(sql).toContain("donor.source_calendar_year = marker.source_calendar_year");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).not.toMatch(/DELETE|UPDATE|INSERT/);
  });
  it("queries only declared marker, donor and allocation columns without pre-aggregation caps", async () => {
    const { db } = await load({ markers: [marker("committee_donors"), marker("independent_expenditures")], donors: [donor()], allocations: [allocation()] });
    for (const [alias, table] of [["link", "me_candidate_finance_links"], ["marker", "me_candidate_finance_source_markers"], ["donor", "me_candidate_finance_pac_donors"], ["allocation", "me_candidate_finance_maplight_allocations"]]) {
      const columns = migrationTableColumns(table);
      expect(columns.size).toBeGreaterThan(0);
      for (const [sql] of db.query.mock.calls.slice(5)) {
        for (const matched of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, "g"))) expect(columns.has(matched[1])).toBe(true);
        expect(sql).not.toMatch(/\bLIMIT\b/);
      }
    }
  });
  it("renders the actual same-calendar-year scope instead of hardcoding 2026", async () => {
    const { summary, db } = await load({ summary: { election_year: 2028, last_synced_at: "2028-07-14T00:00:00Z" }, markers: [{ ...marker("committee_donors"), election_year: 2028, source_calendar_year: 2028, period_end: "2028-10-11", observed_at: "2028-10-12T20:00:00Z", published_source_times: null }], donors: [donor({ source_calendar_year: 2028 })] });
    expect(summary.direct_campaign.direct_coverage_note).toContain("published 2028 itemized cash");
    expect(summary.direct_campaign.direct_coverage_note).toContain("2027 coverage is unknown");
    expect(summary.direct_campaign.direct_coverage_note).toContain("Published source cutoff: 2028-10-11");
    expect(summary.last_synced_at).toBe("2028-07-14T00:00:00Z");
    expect(summary.outside_spending.outside_coverage_note).not.toContain("2026");
    expect(db.query.mock.calls.map(call => call[0]).join("\n")).toContain("marker.source_calendar_year = link.election_year");
  });
  it("ignores mismatched calendar/election markers rather than claiming a scope", async () => {
    const { summary, db } = await load({ markers: [{ ...marker("committee_donors"), election_year: 2024 }, { ...marker("independent_expenditures"), source_calendar_year: 2025 }] });
    expect(summary.outside_spending.support_total).toBe(0);
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect(db.query).toHaveBeenCalledTimes(6);
  });
});
