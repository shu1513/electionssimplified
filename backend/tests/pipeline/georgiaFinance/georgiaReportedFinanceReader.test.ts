import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { attachGeorgiaReportedFinanceComponents } from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceReader.js";
import { loadGeorgiaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/georgiaFinance/georgiaBallotLookupFinanceLoader.js";

const candidate_id = "11111111-1111-4111-8111-111111111111", election_id = "22222222-2222-4222-8222-222222222222";
const link_id = "33333333-3333-4333-8333-333333333333", registration = "44444444-4444-4444-8444-444444444444";
const key = candidateElectionKey(candidate_id, election_id), requests = [{ candidate_id, election_id }];
const url = "https://ethics.ga.gov/records-search-all/";
const generation = "generation-55555555-5555-4555-8555-555555555555";
type Row = Record<string, any>;
function flags(committee: boolean, ie: boolean) {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED", String(committee));
  vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED", String(ie));
}
function facts(kind: "committee" | "ie"): Row {
  const start = "2026-10-13T10:00:00.000Z", firstEnd = "2026-10-13T10:00:01.000Z", end = "2026-10-13T10:00:04.000Z";
  const control = { file: `${generation}/0001.raw`, sha256: "a".repeat(64), byteSize: 100,
    startedAt: start, completedAt: firstEnd, status: 200, contentType: kind === "ie" ? "application/json" : "text/csv; charset=windows-1252" };
  return { candidate_id, election_id, link_id, link_year: 2026, calendar_year: 2026, committee_id: "1234", link_source: "manual", active_link_count: 1,
    source_link_id: link_id, source_election_year: 2026, filing_year: 2026, receiving_committee_id: "1234", registration_guid: registration,
    source_row_count: 1000, source_url: url, source_retrieved_at: start, source_completed_at: kind === "committee" ? firstEnd : end,
    source_manifest_sha256: "b".repeat(64), source_byte_size: kind === "committee" ? "100" : "200",
    source_controls: kind === "committee" ? [control] : [control, { ...control, file: `${generation}/0002.raw`, startedAt: "2026-10-13T10:00:03.000Z", completedAt: end }],
    last_synced_at: "2026-10-15T11:00:00.000Z" };
}
function committeeRows(amounts = [10000, 5000], names = amounts.map((_, i) => `Fixture committee ${i}`)): Row[] {
  const base = { ...facts("committee"), total_amount_cents: String(amounts.reduce((a, b) => a + b, 0)), contribution_count: amounts.length,
    group_count: amounts.length, held_receiving_count: 4 };
  return amounts.length ? amounts.map((amount, i) => ({ ...base, group_name: names[i], group_name_key: names[i]!.toUpperCase(),
    group_type: i % 2 ? "Candidate / Candidate Committee" : "Non-Candidate Committee", group_amount_cents: String(amount), group_occurrence_count: 1 })) :
    [{ ...base, group_name: null, group_name_key: null, group_type: null, group_amount_cents: null, group_occurrence_count: null }];
}
function ieRows(amounts = [25000, 15000], stances = amounts.map((_, i) => i % 2 ? "oppose" : "support")): Row[] {
  const base = { ...facts("ie"), support_total_cents: String(amounts.reduce((n, amount, i) => n + (stances[i] === "support" ? amount : 0), 0)),
    oppose_total_cents: String(amounts.reduce((n, amount, i) => n + (stances[i] === "oppose" ? amount : 0), 0)),
    group_count: amounts.length, expenditure_count: amounts.length, candidate_target_row_count: amounts.length + 2,
    other_year_row_count: 1, multi_target_row_count: 1, multi_target_amount_cents: "500" };
  return amounts.length ? amounts.map((amount, i) => ({ ...base, group_id: `fixture-spender-${i}`, group_name: `Fixture spender ${i}`,
    group_stance: stances[i], group_amount_cents: String(amount), group_occurrence_count: 1 })) :
    [{ ...base, group_id: null, group_name: null, group_stance: null, group_amount_cents: null, group_occurrence_count: null }];
}
function database(committee: Row[] = [], ie: Row[] = []) {
  return { query: vi.fn(async (sql: string) => ({ rows: sql.includes("ga_reported_committee_sources") ? committee : sql.includes("ga_reported_ie_sources") ? ie : [] })) };
}
function legacy(): BallotLookupFinanceSummary {
  const industry = { category_name: "Old industry", amount: 70, contributor_count: 1, source_url: url };
  return { source: "GEORGIA_ETHICS", cycle: 2026, fec_candidate_id: null, controlled_committee_id: "1234", last_synced_at: "2026-09-01T01:02:03.000Z",
    direct_campaign: { total_raised: 999, total_spent: 111, cash_on_hand: -20, debts_owed: null,
      top_occupations: [{ category_name: "Fixture occupation", amount: 99, contributor_count: 2, source_url: url }],
      top_employers: [], top_industries: [industry], contribution_size_buckets: [{ category_name: "Fixture bucket", amount: 88, contributor_count: 1, source_url: url }],
      direct_coverage_note: "Existing direct scope" },
    outside_spending: { support_total: 777, oppose_total: 444,
      top_supporting_groups: [{ committee_id: "old-reported-group", committee_name: "Fixture old group", amount: 777, support_oppose: "support", source_url: url }],
      top_opposing_groups: [], top_supporting_industries: [industry], top_opposing_industries: [industry], outside_coverage_note: "Previous outside scope" },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [{ ...industry, explanation: "Old backing", supporting_organizations: [] }],
      top_pac_backed_industries: [{ ...industry, explanation: "Old backing", supporting_organizations: [] }],
      top_supporting_committee_industries: [{ ...industry, supporting_committee_name: "Fixture old group" }] } };
}
async function load(db = database(), summaries = new Map<string, BallotLookupFinanceSummary>()) {
  return attachGeorgiaReportedFinanceComponents({ db, requests, summaries });
}
beforeEach(() => flags(false, false));
afterEach(() => vi.unstubAllEnvs());

describe("Georgia reported component reader", () => {
  it("performs no additional queries while both gates are off, including absent tables", async () => {
    const db = database(), original = new Map([[key, legacy()]]);
    expect(await load(db, original)).toBe(original);
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([[true, false, "committee", "ie"], [false, true, "ie", "committee"]] as const)("isolates single gate %s/%s", async (committee, ie, present, absent) => {
    flags(committee, ie);
    const db = database(committeeRows(), ieRows());
    expect((await load(db)).has(key)).toBe(true);
    expect(db.query).toHaveBeenCalledTimes(1);
    const sql = db.query.mock.calls[0]![0];
    expect(sql).toContain(`ga_reported_${present}_sources`);
    expect(sql).not.toContain(`ga_reported_${absent}_`);
    expect(sql).not.toContain("ga_reported_finance_attempts");
    expect(sql).not.toMatch(/\bLIMIT\b|amount_cents\s*>/i);
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("candidate.deleted_at IS NULL");
    expect(sql).toContain("membership.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("district.state = 'GA'");
  });
  it("does not read components when a parent gate is disabled or requests are empty", async () => {
    flags(true, true); vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED", "false");
    const db = database(); await load(db); expect(db.query).not.toHaveBeenCalled();
    flags(true, true); await attachGeorgiaReportedFinanceComponents({ db, requests: [], summaries: new Map() });
    expect(db.query).not.toHaveBeenCalled();
  });
  it("includes both native committee classes, keeps unsorted groups and caps only after whole controls", async () => {
    flags(true, false);
    const rows = committeeRows([900, 800, 700, 600, 500, 400, 300]);
    const summary = (await load(database(rows))).get(key)!;
    const interest = summary.direct_campaign.pac_money_by_interest![0]!;
    expect(interest).toMatchObject({ interest: "unclassified", interest_name: "Not yet sorted", amount: 42, pac_count: 7 });
    expect(interest.pacs).toHaveLength(5);
    expect(interest.pacs[1]!.committee_id).toContain("Candidate / Candidate Committee");
    expect(interest.pacs[0]!.committee_id).toBe("ga-reported:Non-Candidate Committee:FIXTURE COMMITTEE 0");
    expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_itemized_contributions");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("Separately reported returns are not subtracted");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("2026-10-13");
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-13T10:00:00.000Z");
  });
  it("classifies only deterministic exact rules without dropping candidate-reported money", async () => {
    flags(true, false);
    const summary = (await load(database(committeeRows([1000, 800], ["GOOGLE", "Fixture other candidate committee"])))).get(key)!;
    expect(summary.direct_campaign.pac_money_by_interest?.map(g => [g.interest_name, g.amount]))
      .toEqual([["Technology", 10], ["Not yet sorted", 8]]);
  });
  it("preserves every existing direct value and headline date while replacing IE and clearing stale backing", async () => {
    flags(false, true);
    const original = legacy();
    const summary = (await load(database([], ieRows()), new Map([[key, original]]))).get(key)!;
    expect(summary.direct_campaign).toEqual(original.direct_campaign);
    expect(summary.last_synced_at).toBe(original.last_synced_at);
    expect(summary.outside_spending).toMatchObject({ support_total: 250, oppose_total: 150, top_supporting_industries: [], top_opposing_industries: [] });
    expect(summary.outside_spending.top_supporting_groups).toHaveLength(1);
    expect(summary.backing_summary).toMatchObject({ top_outside_supporting_industries: [], top_pac_backed_industries: [], top_supporting_committee_industries: [] });
    expect(summary.outside_spending.outside_coverage_note).toContain("allocated to the 2026 election year");
    expect(summary.outside_spending.outside_coverage_note).toContain("Source snapshot observed 2026-10-13");
    expect(original.outside_spending.support_total).toBe(777);
    expect(original.backing_summary.top_outside_supporting_industries).toHaveLength(1);
  });
  it.each(["missing", "corrupt"])("retains old IE amounts/groups/age with honest unknown observation for %s new source", async mode => {
    flags(false, true);
    const rows = mode === "missing" ? [] : ieRows();
    if (rows.length) rows[0]!.support_total_cents = "999999";
    const original = legacy(), summary = (await load(database([], rows), new Map([[key, original]]))).get(key)!;
    expect(summary.direct_campaign).toEqual(original.direct_campaign);
    expect(summary.last_synced_at).toBe(original.last_synced_at);
    expect(summary.outside_spending.support_total).toBe(777);
    expect(summary.outside_spending.top_supporting_groups).toEqual(original.outside_spending.top_supporting_groups);
    expect(summary.outside_spending.outside_coverage_note).toContain("acquisition date is unavailable");
    expect(summary.backing_summary.top_outside_supporting_industries).toEqual([]);
  });
  it("does not fabricate a summary or outside zero when new source and old content are absent", async () => {
    flags(true, true);
    expect((await load()).size).toBe(0);
    const original = legacy(); original.outside_spending = { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] };
    original.backing_summary.top_outside_supporting_industries = [];
    const summary = (await load(database(), new Map([[key, original]]))).get(key)!;
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.outside_spending.outside_coverage_note).toBeUndefined();
  });
  it("accepts separately controlled true zeros with null direct totals and no old-source freshness", async () => {
    flags(true, true);
    const summary = (await load(database(committeeRows([]), ieRows([])))).get(key)!;
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(summary.outside_spending).toMatchObject({ support_total: 0, oppose_total: 0, top_supporting_groups: [], top_opposing_groups: [] });
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-13T10:00:00.000Z");
  });
  it.each(["committee", "ie"])("keeps a separately valid component when %s controls fail", async mode => {
    flags(true, true);
    const committee = committeeRows(), ie = ieRows();
    if (mode === "committee") committee[0]!.contribution_count = 99; else ie[0]!.expenditure_count = 99;
    const summary = (await load(database(committee, ie))).get(key)!;
    if (mode === "committee") {
      expect(summary.direct_campaign.pac_money_by_interest).toBeUndefined(); expect(summary.outside_spending.support_total).toBe(250);
    } else {
      expect(summary.direct_campaign.pac_money_by_interest).toHaveLength(1); expect(summary.outside_spending.support_total).toBeNull();
    }
  });
  it("uses the oldest actual source observation for a card that has only independent sources", async () => {
    flags(true, true);
    const ie = ieRows();
    for (const row of ie) {
      row.source_retrieved_at = "2026-10-12T10:00:00.000Z"; row.source_completed_at = "2026-10-12T10:00:04.000Z";
      row.source_controls = row.source_controls.map((c: Row) => ({ ...c, startedAt: c.startedAt.replace("10-13", "10-12"), completedAt: c.completedAt.replace("10-13", "10-12") }));
    }
    expect((await load(database(committeeRows(), ie))).get(key)!.last_synced_at).toBe("2026-10-12T10:00:00.000Z");
  });
  it.each(["receiver", "link", "year", "multi", "registration", "hash", "byte total", "file path", "MIME", "clock", "future clock", "unexpected source metadata", "held receiver count", "duplicate", "unsafe cents", "missing seventh group"])("holds corrupt %s before any cap", async mode => {
    flags(true, false);
    const rows = committeeRows([900, 800, 700, 600, 500, 400, 300]);
    for (const row of rows) {
      if (mode === "receiver") row.receiving_committee_id = "999";
      if (mode === "link") row.source_link_id = "changed-link";
      if (mode === "year") row.source_election_year = 2024;
      if (mode === "multi") row.active_link_count = 2;
      if (mode === "registration") row.registration_guid = "not-a-registration";
      if (mode === "hash") row.source_manifest_sha256 = "invalid";
      if (mode === "byte total") row.source_byte_size = "101";
      if (mode === "file path") row.source_controls = [{ ...row.source_controls[0], file: "../../outside.raw" }];
      if (mode === "MIME") row.source_controls = [{ ...row.source_controls[0], contentType: "text/html" }];
      if (mode === "clock") row.source_retrieved_at = "2026-10-16T00:00:00.000Z";
      if (mode === "future clock") {
        row.source_retrieved_at = row.source_retrieved_at.replace("2026", "2099");
        row.source_completed_at = row.source_completed_at.replace("2026", "2099");
        row.last_synced_at = row.last_synced_at.replace("2026", "2099");
        row.source_controls = row.source_controls.map((c: Row) => ({ ...c, startedAt: c.startedAt.replace("2026", "2099"), completedAt: c.completedAt.replace("2026", "2099") }));
      }
      if (mode === "unexpected source metadata") row.source_controls = [{ ...row.source_controls[0], requestBody: "unexpected fixture property" }];
      if (mode === "held receiver count") row.held_receiving_count = 1001;
    }
    if (mode === "duplicate") { rows[6]!.group_name = rows[0]!.group_name; rows[6]!.group_name_key = rows[0]!.group_name_key; rows[6]!.group_type = rows[0]!.group_type; }
    if (mode === "unsafe cents") rows[6]!.group_amount_cents = "9007199254740992";
    if (mode === "missing seventh group") rows.pop();
    const original = legacy(), summary = (await load(database(rows), new Map([[key, original]]))).get(key)!;
    expect(summary).toEqual(original);
    expect(summary.direct_campaign.pac_money_by_interest).toBeUndefined();
  });
  it("validates all IE groups before the five-group display cap", async () => {
    flags(false, true);
    const rows = ieRows([900, 800, 700, 600, 500, 400, 300], Array(7).fill("support"));
    const good = (await load(database([], rows))).get(key)!;
    expect(good.outside_spending.support_total).toBe(42);
    expect(good.outside_spending.top_supporting_groups).toHaveLength(5);
    rows[6]!.group_occurrence_count = 2;
    expect((await load(database([], rows))).size).toBe(0);
  });
  it("attaches through the real loader only after its unchanged legacy queries", async () => {
    flags(true, false);
    const db = database(committeeRows());
    const output = await loadGeorgiaCandidateFinanceSummariesByCandidateElection(db, requests,
      [{ election_id, state: "GA", office_scope: "statewide", office_canonical_name: "Governor" }]);
    expect(output.get(key)?.direct_campaign.pac_money_basis).toBe("reported_committee_itemized_contributions");
    const sql = db.query.mock.calls.map(call => call[0]);
    const componentPosition = sql.findIndex(s => s.includes("ga_reported_committee_sources"));
    expect(componentPosition).toBeGreaterThan(0);
    expect(sql.slice(0, componentPosition).join(" ")).toContain("ga_candidate_finance_summaries");
  });
});
