import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import * as classifier from "../../../src/pipeline/finance/pacInterestClassifier.js";
import { attachNorthCarolinaReportedReceiptComponent as attach } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceReader.js";
import { ncsbeDocumentInventoryUrl, ncsbeReportDetailUrl, ncsbeReceiptsUrl, ncsbeExpendituresUrl } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";
import type { NorthCarolinaReportedCommitteeReceiptClassControl as Control, NorthCarolinaReportedCommitteeReceiptGroup as Group } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedCommitteeReceiptAggregator.js";

type Row = Record<string, any>;
const candidate_id = "11111111-1111-4111-8111-111111111111", election_id = "22222222-2222-4222-8222-222222222222";
const link_id = "33333333-3333-4333-8333-333333333333", receiver = "STA-AA11BB-C-001";
const key = candidateElectionKey(candidate_id, election_id), requests = [{ candidate_id, election_id }];
const sourceUrl = "https://cf.ncsbe.gov/CFOrgLkup/", now = new Date("2026-01-03T00:00:00.000Z");
function flags(enabled = true) {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", String(enabled));
}
function group(displayName: string, amount: number, reportedClass: "CPCM" | "PPTY" = "CPCM", occurrences = 1): Group {
  return { displayName, normalizedName: displayName.toUpperCase(), reportedClass, positiveGrossCents: amount, positiveOccurrenceCount: occurrences };
}
function classControl(role: "CPCM" | "PPTY", groups: Group[]): Control {
  const values = groups.filter(g => g.reportedClass === role), count = values.reduce((n, g) => n + g.positiveOccurrenceCount, 0), cents = values.reduce((n, g) => n + g.positiveGrossCents, 0);
  return { reportedClass: role, sourceOccurrenceCount: count, signedSourceCents: cents, coverPeriodCents: cents, positiveOccurrenceCount: count, positiveGrossCents: cents,
    zeroOccurrenceCount: 0, excludedAggregatedOccurrenceCount: 0, excludedAggregatedSignedCents: 0, excludedInKindOccurrenceCount: 0, excludedInKindSignedCents: 0 };
}
function row(groups = [group("Synthetic Committee A", 125, "CPCM", 2), group("Synthetic Committee B", 175), group("Synthetic Party", 100, "PPTY")]): Row {
  const all = [classControl("CPCM", groups), classControl("PPTY", groups)];
  const positive = groups.reduce((n, g) => n + g.positiveGrossCents, 0), occurrences = groups.reduce((n, g) => n + g.positiveOccurrenceCount, 0);
  const inventory = ncsbeDocumentInventoryUrl({ sboeId: receiver, orgGroupId: 17 });
  const bindings = [{ role: "inventory_open", url: inventory }, { role: "report_cover", reportId: "11", url: ncsbeReportDetailUrl("11") },
    { role: "receipt_page", reportId: "11", page: 0, url: ncsbeReceiptsUrl("11") }, { role: "expenditure_page", reportId: "11", page: 0, url: ncsbeExpendituresUrl("11") },
    { role: "native_csv", reportId: "11", url: "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?handler=Export&RID=11&TP=ALL&sid=&cn=" }, { role: "inventory_close", url: inventory }];
  const sourceControls = bindings.map((b, i) => ({ ...b, ordinal: i + 1, file: `originals/${String(i + 1).padStart(4, "0")}.raw`, status: 200, eof: true, byteSize: 100, sha256: "a".repeat(64),
    startedAt: `2026-01-01T00:00:${String(i * 2).padStart(2, "0")}.000Z`, completedAt: `2026-01-01T00:00:${String(i * 2 + 1).padStart(2, "0")}.000Z` }));
  const source = { receivingCommitteeId: receiver, electionYear: 2026, sourceGeneration: "44444444-4444-4444-8444-444444444444", sourceRetrievedAt: sourceControls[0]!.startedAt,
    sourceCompletedAt: sourceControls.at(-1)!.completedAt, sourceUrl, sourceReceiptOccurrenceCount: occurrences, sourceReportCount: 1, sourceByteSize: 600, sourceManifestSha256: "b".repeat(64), sourceControls };
  const controls = { status: "qualified", receivingCommitteeId: receiver, electionYear: 2026, metric: "reported_itemized_committee_monetary_receipts_before_returns", positiveGrossCents: positive,
    positiveOccurrenceCount: occurrences, classControls: all, coveredPeriods: [{ reportId: "11", reportType: "First Quarter", periodStart: "2025-01-01", periodEnd: "2025-03-31", sourceOccurrenceCount: occurrences, classControls: structuredClone(all) }],
    diagnostics: { inventoryRowCount: 2, excludedOtherReceiverInventoryRowCount: 0, duplicateInventoryRowCount: 0, excludedNoTotalReportRowCount: 0, excludedOutsideLegReportRowCount: 0,
      excludedUndatedOutOfCycleRowCount: 0, reportCount: 1, sourceOccurrenceCount: occurrences, excludedOtherClassOccurrenceCount: 0, coverIdentityMetadataDisagreementReportCount: 0, coverPeriodDisagreementReportCount: 0 } };
  return { candidate_id, election_id, link_id, link_year: 2026, calendar_year: 2026, election_date: "2026-11-03", committee_id: receiver, link_source: "manual", link_status: "active", active_link_count: 1,
    deleted_at: null, candidate_election_status: "active", district_state: "NC", race_type: "office", office_key: "state_upper::State Senator", source_link_id: link_id,
    source_election_year: 2026, receiving_committee_id: receiver, positive_gross_cents: String(positive), positive_occurrence_count: occurrences, group_count: groups.length,
    source_report_count: 1, source_receipt_occurrence_count: occurrences, source_generation: source.sourceGeneration, source_retrieved_at: source.sourceRetrievedAt, source_completed_at: source.sourceCompletedAt,
    source_manifest_sha256: source.sourceManifestSha256, source_byte_size: "600", source_facts: source, aggregation_controls: controls, last_synced_at: "2026-01-02T00:00:00.000Z",
    groups: groups.map(g => ({ ...g, positiveGrossCents: String(g.positiveGrossCents) })) };
}
function legacy(): BallotLookupFinanceSummary {
  const breakdown = { category_name: "Synthetic prior category", amount: 12, contributor_count: 2, source_url: sourceUrl };
  return { source: "NORTH_CAROLINA_SBE", cycle: 2026, fec_candidate_id: null, controlled_committee_id: receiver, last_synced_at: "2025-12-01T01:02:03.000Z",
    direct_campaign: { total_raised: 999, total_spent: 111, cash_on_hand: -20, debts_owed: null, top_occupations: [breakdown], top_employers: [breakdown], top_industries: [breakdown], contribution_size_buckets: [breakdown], direct_coverage_note: "Existing direct coverage" },
    outside_spending: { support_total: 222, oppose_total: 333, top_supporting_groups: [{ committee_id: "synthetic-prior", committee_name: "Synthetic prior spender", support_oppose: "support", amount: 222, source_url: sourceUrl }], top_opposing_groups: [],
      top_supporting_industries: [breakdown], top_opposing_industries: [breakdown], outside_coverage_note: "Existing outside scope" },
    backing_summary: { top_direct_donor_occupations: [breakdown], top_outside_supporting_industries: [{ ...breakdown, explanation: "Synthetic prior backing", supporting_organizations: [] }],
      top_pac_backed_industries: [{ ...breakdown, explanation: "Synthetic prior backing", supporting_organizations: [] }], top_supporting_committee_industries: [{ ...breakdown, supporting_committee_name: "Synthetic prior spender" }] } };
}
function database(rows: Row[] = []) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
  return { query } as unknown as Pick<Pool, "query"> & { query: typeof query };
}
async function load(rows: Row[] = [row()], summaries = new Map<string, BallotLookupFinanceSummary>()) { return attach({ db: database(rows), requests, summaries }); }
async function retained(value: Row) { const previous = legacy(); const result = await load([value], new Map([[key, previous]])); expect(result.get(key)).toBe(previous); expect((await load([value])).size).toBe(0); }
beforeEach(() => { flags(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("NC reported receipt finance reader", () => {
  it.each(["CANDIDATE_FINANCE_ENABLED", "NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED"])("returns the same map and makes no query when %s is off", async gate => {
    vi.stubEnv(gate, "false"); const db = database([row()]), summaries = new Map([[key, legacy()]]);
    expect(await attach({ db, summaries, requests })).toBe(summaries); expect(db.query).not.toHaveBeenCalled();
  });
  it("defaults the child gate off and ignores force-like environment settings", async () => {
    vi.stubEnv("NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", ""); vi.stubEnv("NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_FORCE", "true");
    const db = database([row()]), summaries = new Map<string, BallotLookupFinanceSummary>(); expect(await attach({ db, summaries, requests })).toBe(summaries); expect(db.query).not.toHaveBeenCalled();
  });
  it("skips empty requests and deduplicates repeated requests", async () => {
    const db = database([row()]), summaries = new Map<string, BallotLookupFinanceSummary>(); expect(await attach({ db, summaries, requests: [] })).toBe(summaries);
    expect(db.query).not.toHaveBeenCalled(); const result = await attach({ db, summaries, requests: [...requests, ...requests] }); expect(result.size).toBe(1);
    expect(JSON.parse(db.query.mock.calls[0]![1]![0] as string)).toEqual(requests);
  });
  it("queries one uncapped source per link with all group DTOs and raw same-year active count before eligibility/source filters", async () => {
    const db = database([row()]); await attach({ db, summaries: new Map(), requests }); const sql = db.query.mock.calls[0]![0];
    expect(db.query).toHaveBeenCalledOnce(); expect(sql).toContain("PARTITION BY link.candidate_id, link.election_id, link.election_year");
    expect(sql.indexOf("count(*) OVER")).toBeLessThan(sql.indexOf("eligible AS"));
    expect(sql).toContain("WHERE link.link_status = 'active'"); expect(sql).toContain("link.election_year = EXTRACT(YEAR FROM election.election_date)");
    expect(sql).toContain("candidate.deleted_at IS NULL"); expect(sql).toContain("membership.status NOT IN ('withdrawn', 'lost')"); expect(sql).toContain("district.state = 'NC'");
    expect(sql).toContain("link.link_source IN ('manual', 'ncsbe_portal')"); expect(sql).toContain("jsonb_agg(jsonb_build_object"); expect(sql.match(/src\.source_facts/g)).toHaveLength(1);
    expect(sql).toContain("g.positive_gross_cents::text"); expect(sql).not.toMatch(/\bLIMIT\b|positive_gross_cents\s*>|nc_reported_receipt_attempts/i);
  });
  it("uses native class/name keys, includes both classes, and shows honest source-only headlines and age", async () => {
    const summary = (await load([row([group("Synthetic Same", 100), group("Synthetic Same", 200, "PPTY")])])).get(key)!;
    expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_monetary_receipts"); expect(summary.direct_campaign.pac_money_by_interest).toHaveLength(1);
    expect(summary.direct_campaign.pac_money_by_interest![0]).toMatchObject({ interest_name: "Not yet sorted", amount: 3, pac_count: 2 });
    expect(summary.direct_campaign.pac_money_by_interest![0]!.pacs.map(p => p.committee_id)).toEqual(["nc-reported:PPTY:SYNTHETIC SAME", "nc-reported:CPCM:SYNTHETIC SAME"]);
    expect(summary.direct_campaign).toMatchObject({ total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null }); expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.last_synced_at).toBe("2026-01-01T00:00:00.000Z");
    const note = summary.direct_campaign.pac_money_coverage_note!; for (const text of ["CPCM/PPTY", "Periods in 2025–2026", "before separately reported returns", "In Kind", "aggregated", "48-Hour", "2026-01-01"]) expect(note).toContain(text);
  });
  it("preserves every old headline/direct/outside/funder value and clock without mutating its input", async () => {
    const previous = legacy(), saved = structuredClone(previous), summary = (await load([row()], new Map([[key, previous]]))).get(key)!;
    expect(summary.last_synced_at).toBe(previous.last_synced_at); expect(summary.outside_spending).toBe(previous.outside_spending); expect(summary.backing_summary).toBe(previous.backing_summary);
    for (const k of ["total_raised", "total_spent", "cash_on_hand", "debts_owed", "top_occupations", "top_employers", "top_industries", "contribution_size_buckets", "direct_coverage_note"] as const) expect(summary.direct_campaign[k]).toEqual(previous.direct_campaign[k]);
    expect(previous).toEqual(saved); expect(summary.direct_campaign.pac_money_by_interest![0]!.amount).toBe(4);
  });
  it("publishes fully qualified explicit zero, while missing source never fabricates zero or a summary", async () => {
    const zero = (await load([row([])])).get(key)!; expect(zero.direct_campaign.pac_money_by_interest).toEqual([]); expect(zero.direct_campaign.total_raised).toBeNull();
    expect((await load([])).size).toBe(0); const previous = legacy(); expect((await load([], new Map([[key, previous]]))).get(key)).toBe(previous);
  });
  it("accounts for all groups before caps and sorts by exact amount then explicit presentation ID", async () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`Synthetic ${String(i).padStart(2, "0")}`, 100));
    const interest = (await load([row(groups.reverse())])).get(key)!.direct_campaign.pac_money_by_interest![0]!;
    expect(interest).toMatchObject({ amount: 8, pac_count: 8 }); expect(interest.pacs).toHaveLength(5);
    expect(interest.pacs.map(p => p.committee_name)).toEqual(["Synthetic 00", "Synthetic 01", "Synthetic 02", "Synthetic 03", "Synthetic 04"]);
    const broken = row(groups); broken.groups[7].positiveGrossCents = "101"; await retained(broken);
  });
  it("classifies exact known names and preserves unknown money as Not yet sorted", async () => {
    const values = (await load([row([group("GOOGLE", 200), group("Synthetic unsorted", 100)])])).get(key)!.direct_campaign.pac_money_by_interest!;
    expect(values.map(v => [v.interest_name, v.amount])).toEqual([["Technology", 2], ["Not yet sorted", 1]]);
  });
  it.each(["leadership_pacs", "candidate_committees"] as const)("keeps native reported money when an interest is otherwise suppressed: %s", async interestSlug => {
    vi.spyOn(classifier, "classifyPacInterest").mockReturnValue({ interestSlug, confidence: "high", source: "fec" });
    expect((await load()).get(key)!.direct_campaign.pac_money_by_interest![0]).toMatchObject({ interest: "unclassified", amount: 4, pac_count: 3 });
  });
  it("caps interest display only after all packet controls and keeps deterministic ties", async () => {
    const slugs = ["technology", "healthcare", "finance_investment", "oil_gas_energy", "education", "real_estate", "agriculture_and_food"] as const;
    vi.spyOn(classifier, "classifyPacInterest").mockImplementation(({ committeeName }) => ({ interestSlug: slugs[Number(committeeName.split(" ").at(-1))]!, confidence: "high", source: "rule" }));
    const all = row(slugs.map((_, i) => group(`Synthetic ${i}`, 100))); const values = (await load([all])).get(key)!.direct_campaign.pac_money_by_interest!;
    expect(values).toHaveLength(5); expect(values.map(v => v.interest)).toEqual([...slugs].sort().slice(0, 5));
    all.groups.at(-1).positiveOccurrenceCount = 2; await retained(all);
  });
  it("isolates a corrupt component from a separate valid requested candidate", async () => {
    const valid = row(), broken = row(); broken.candidate_id = "55555555-5555-4555-8555-555555555555"; broken.positive_gross_cents = "401";
    const result = await attach({ db: database([broken, valid]), summaries: new Map(), requests: [...requests, { candidate_id: broken.candidate_id, election_id }] });
    expect(result.size).toBe(1); expect(result.has(key)).toBe(true);
  });
  it("does not attach unexpected, duplicate, or conflicting source rows", async () => {
    const unrelated = row(); unrelated.candidate_id = "55555555-5555-4555-8555-555555555555"; expect((await load([unrelated])).size).toBe(0);
    const previous = legacy(); expect((await load([row(), row()], new Map([[key, previous]]))).get(key)).toBe(previous);
    const conflict = row(); conflict.link_id = "66666666-6666-4666-8666-666666666666"; expect((await load([row(), conflict])).size).toBe(0);
  });
  it.each([
    ["receiving_committee_id", "STA-AA11BB-C-002"], ["positive_gross_cents", "401"], ["positive_occurrence_count", 5], ["group_count", 4], ["source_report_count", 2], ["source_receipt_occurrence_count", 5],
    ["source_generation", "55555555-5555-4555-8555-555555555555"], ["source_retrieved_at", "2026-01-01T00:00:01.000Z"], ["source_completed_at", "2026-01-01T00:00:12.000Z"],
    ["source_manifest_sha256", "c".repeat(64)], ["source_byte_size", "601"], ["source_link_id", "55555555-5555-4555-8555-555555555555"], ["source_election_year", 2025],
  ])("withholds any typed source mismatch: %s", async (field, value) => { const stored = row(); stored[field as string] = value; await retained(stored); });
  it.each([
    ["active_link_count", 2], ["link_year", 2025], ["link_status", "inactive"], ["committee_id", "STA-AA11BB-C-002"], ["link_source", "unsupported"], ["deleted_at", "2025-01-01"],
    ["candidate_election_status", "withdrawn"], ["candidate_election_status", "lost"], ["district_state", "VA"], ["race_type", "measure"], ["office_key", "federal::United States Senator"],
    ["election_date", "2025-11-03"], ["election_date", "2026-13-99"],
  ])("withholds changed/ambiguous current receiving context: %s=%s", async (field, value) => { const stored = row(); stored[field as string] = value; await retained(stored); });
  it("holds two active same-year receivers but does not mistake wrong-year active links for current ambiguity", async () => {
    const ambiguous = row(); ambiguous.active_link_count = 2; await retained(ambiguous);
    // The SQL partitions the raw count by year, then filters actual election
    // year; the current result remains one even if another year's link exists.
    const db = database([row()]); const result = await attach({ db, summaries: new Map(), requests });
    expect(db.query.mock.calls[0]![0]).toContain("PARTITION BY link.candidate_id, link.election_id, link.election_year"); expect(result.has(key)).toBe(true);
  });
  it.each([
    (v: Row) => { v.source_facts.sourceControls[2].eof = false; },
    (v: Row) => { v.source_facts.sourceControls[0].url = "https://invalid.example/"; },
    (v: Row) => { v.source_facts.sourceControls.pop(); },
    (v: Row) => { v.source_facts.unexpected = true; },
    (v: Row) => { v.aggregation_controls.groups = []; },
    (v: Row) => { v.aggregation_controls.classControls[0].coverPeriodCents++; },
    (v: Row) => { v.aggregation_controls.coveredPeriods[0].periodEnd = "2027-01-01"; },
    (v: Row) => { v.groups[0].normalizedName = "ALIAS"; },
    (v: Row) => { v.groups[0].reportedClass = "IND"; },
    (v: Row) => { v.groups[0].positiveGrossCents = "9007199254740992"; },
    (v: Row) => { v.groups.push(structuredClone(v.groups[0])); v.group_count++; },
  ])("reuses full source and monetary controls before publishing amounts", async edit => { const stored = row(); edit(stored); await retained(stored); });
  it("allows bounded write-clock skew but preserves the original observation date", async () => {
    const value = row(); value.last_synced_at = new Date(now.getTime() + 300000).toISOString(); expect((await load([value])).get(key)!.last_synced_at).toBe(value.source_facts.sourceRetrievedAt);
    value.last_synced_at = new Date(now.getTime() + 300001).toISOString(); await retained(value);
  });
  it("rejects a write clock earlier than complete source, malformed clocks and inconsistent legacy year", async () => {
    const early = row(); early.last_synced_at = "2026-01-01T00:00:10.000Z"; await retained(early);
    const malformed = row(); malformed.last_synced_at = "not-a-time"; await retained(malformed);
    const previous = legacy(); previous.cycle = 2025; expect((await load([row()], new Map([[key, previous]]))).get(key)).toBe(previous);
  });
  it("surfaces SQL errors without returning a fabricated empty component", async () => {
    const db = database(); db.query.mockRejectedValue(new Error("synthetic_query_failure"));
    await expect(attach({ db, summaries: new Map([[key, legacy()]]), requests })).rejects.toThrow("synthetic_query_failure");
  });
});
