import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { attachMissouriCommitteeMonetaryReceipts, type MissouriCommitteeMonetaryReceiptReaderRow as Row } from "../../../src/pipeline/missouriFinance/missouriCommitteeMonetaryReceiptReader.js";
import * as classifier from "../../../src/pipeline/finance/pacInterestClassifier.js";

const candidate_id = "11111111-1111-4111-8111-111111111111", election_id = "22222222-2222-4222-8222-222222222222";
const link_id = "33333333-3333-4333-8333-333333333333";
const requests = [{ candidate_id, election_id }], key = candidateElectionKey(candidate_id, election_id);
const portal = "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx";
function rows(amounts: number[], names = amounts.map((_, i) => `Example reported committee ${i}`)): Row[] {
  const source = { candidate_id, election_id, link_id, election_year: 2026, committee_id: "C123456", active_link_count: 1,
    source_link_id: link_id, source_year: 2026, receiving_committee_id: "C123456", cycle_start: "2026-08-05", cycle_end: "2026-11-03",
    total_amount_cents: String(amounts.reduce((sum, n) => sum + n, 0)), group_count: amounts.length, receipt_count: amounts.length,
    source_row_count: amounts.length + 3, in_cycle_row_count: amounts.length + 2, outside_cycle_row_count: 1,
    canonical_row_count: amounts.length + 2, matched_committee_row_count: amounts.length + 1,
    excluded_noncommittee_row_count: 1, in_kind_row_count: 1, zero_monetary_row_count: 0,
    source_url: portal, source_retrieved_at: "2026-10-12T11:00:00Z", last_synced_at: "2026-10-15T12:00:00Z",
    source_sha256: "a".repeat(64), source_byte_size: "1234", report_inventory_sha256: "b".repeat(64) };
  return amounts.length ? amounts.map((amount, i) => ({ ...source, reported_committee_name: names[i]!,
    reported_name_key: names[i]!.toUpperCase(), amount_cents: String(amount), group_receipt_count: 1 })) :
    [{ ...source, reported_committee_name: null, reported_name_key: null, amount_cents: null, group_receipt_count: null }];
}
function db(data: Row[]) { return { query: vi.fn().mockResolvedValue({ rows: data }) }; }
function read(data: Row[], summaries = new Map<string, BallotLookupFinanceSummary>()) {
  return attachMissouriCommitteeMonetaryReceipts({ db: db(data), requests, summaries });
}
async function existing() {
  const summary = (await read(rows([100]))).get(key)!;
  delete summary.direct_campaign.pac_money_by_interest;
  delete summary.direct_campaign.pac_money_basis;
  delete summary.direct_campaign.pac_money_coverage_note;
  summary.last_synced_at = "2026-09-01T00:00:00Z";
  summary.direct_campaign.total_raised = 999;
  summary.direct_campaign.direct_coverage_note = "Existing direct coverage";
  summary.outside_spending.support_total = 123;
  return summary;
}
beforeEach(() => {
  vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Missouri reported committee monetary receipt reader", () => {
  it.each(["", "false"])("does not query new tables while the independent publication gate is %s", async flag => {
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", flag);
    const database = db(rows([100]));
    const summaries = new Map<string, BallotLookupFinanceSummary>();
    expect(await attachMissouriCommitteeMonetaryReceipts({ db: database, requests, summaries })).toBe(summaries);
    expect(database.query).not.toHaveBeenCalled();
  });
  it("also honors the parent finance gate and empty requests", async () => {
    const database = db(rows([100]));
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "false");
    await attachMissouriCommitteeMonetaryReceipts({ db: database, requests, summaries: new Map() });
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    await attachMissouriCommitteeMonetaryReceipts({ db: database, requests: [], summaries: new Map() });
    expect(database.query).not.toHaveBeenCalled();
  });
  it("uses full source controls before caps and includes unclassified native committees", async () => {
    const database = db(rows([600, 500, 400, 300, 200, 100]));
    const output = await attachMissouriCommitteeMonetaryReceipts({ db: database, requests, summaries: new Map() });
    const summary = output.get(key)!, group = summary.direct_campaign.pac_money_by_interest![0]!;
    expect(group).toMatchObject({ interest: "unclassified", interest_name: "Not yet sorted", amount: 21, pac_count: 6 });
    expect(group.pacs.map(p => p.amount)).toEqual([6, 5, 4, 3, 2]);
    expect(group.pacs.every(p => p.committee_id === `mo-reported:${p.committee_name.toUpperCase()}` && p.source_url === portal)).toBe(true);
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-12T11:00:00.000Z");
    expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_monetary_receipts");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("2026-08-05 through 2026-11-03");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("2026-10-12");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("May include loans; before separately reported returns");
    expect(String(database.query.mock.calls[0]?.[0])).not.toMatch(/\bLIMIT\b|amount_cents\s*>\s*0/i);
    expect(String(database.query.mock.calls[0]?.[0])).toContain("LEFT JOIN public.mo_candidate_finance_committee_receipt_sources");
  });
  it.each(["candidate_committees", "leadership_pacs"] as const)("remaps a federal excluded interest %s to Not yet sorted", async interestSlug => {
    vi.spyOn(classifier, "classifyPacInterest").mockReturnValue({ interestSlug, source: "rule", confidence: "high" });
    const output = await read(rows([100]));
    expect(output.get(key)?.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ interest: "unclassified", amount: 1, pac_count: 1 });
  });
  it("keeps a qualified zero source without Raised or outside zero claims", async () => {
    const output = await read(rows([]));
    expect(output.get(key)?.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(output.get(key)?.direct_campaign.total_raised).toBeNull();
    expect(output.get(key)?.outside_spending.oppose_total).toBeNull();
  });
  it("preserves headline freshness, totals and coverage when attaching receipts", async () => {
    const original = await existing();
    const output = await read(rows([1000]), new Map([[key, original]]));
    expect(output.get(key)?.last_synced_at).toBe(original.last_synced_at);
    expect(output.get(key)?.direct_campaign.total_raised).toBe(999);
    expect(output.get(key)?.direct_campaign.direct_coverage_note).toBe("Existing direct coverage");
    expect(output.get(key)?.outside_spending.support_total).toBe(123);
    expect(output.get(key)?.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(10);
    expect(original.direct_campaign.pac_money_by_interest).toBeUndefined();
  });
  it.each(["absent", "partial", "missing_source"] as const)("preserves existing summary for %s active receiving coverage", async mode => {
    const original = await existing(), data = mode === "absent" ? [] : rows([100]);
    if (mode === "partial") data[0]!.active_link_count = 2;
    if (mode === "missing_source") data[0]!.source_link_id = null;
    const output = await read(data, new Map([[key, original]]));
    expect(output.get(key)).toBe(original);
    expect((await read(data)).size).toBe(0);
  });
  it("combines complete receiving links by reported name and uses oldest source age", async () => {
    const first = rows([100]), second = rows([200]).map(row => ({ ...row, link_id: "44444444-4444-4444-8444-444444444444",
      source_link_id: "44444444-4444-4444-8444-444444444444", committee_id: "C654321", receiving_committee_id: "C654321",
      source_retrieved_at: "2026-10-10T11:00:00Z" }));
    const data = [...first, ...second].map(row => ({ ...row, active_link_count: 2 }));
    const summary = (await read(data)).get(key)!;
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 3, pac_count: 1 });
    expect(summary.controlled_committee_id).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-10T11:00:00.000Z");
  });
  it.each(["total", "group_count", "receipt_count", "source_counts", "duplicate", "name_key", "hash", "inventory_hash",
    "bytes", "receiver", "year", "window", "time", "source_url", "unsafe", "negative", "zero_count", "repeated_metadata"] as const)(
    "rejects corrupt uncapped %s controls without changing an existing summary", async mode => {
      const original = await existing(), data = rows([200, 100]);
      if (mode === "total") data[0]!.total_amount_cents = "301";
      if (mode === "group_count") data.forEach(row => row.group_count = 1);
      if (mode === "receipt_count") data.forEach(row => row.receipt_count = 3);
      if (mode === "source_counts") data.forEach(row => row.source_row_count = 99);
      if (mode === "duplicate") data[1] = { ...data[0]! };
      if (mode === "name_key") data[1]!.reported_name_key = "other";
      if (mode === "hash") data.forEach(row => row.source_sha256 = "bad");
      if (mode === "inventory_hash") data.forEach(row => row.report_inventory_sha256 = "bad");
      if (mode === "bytes") data.forEach(row => row.source_byte_size = "0");
      if (mode === "receiver") data.forEach(row => row.receiving_committee_id = "C000001");
      if (mode === "year") data.forEach(row => row.source_year = 2024);
      if (mode === "window") data.forEach(row => row.cycle_start = "2026-02-30");
      if (mode === "time") data.forEach(row => row.source_retrieved_at = "2026-10-16T00:00:00Z");
      if (mode === "source_url") data.forEach(row => row.source_url = "https://example.invalid");
      if (mode === "unsafe") data[1]!.amount_cents = "9007199254740992";
      if (mode === "negative") data[1]!.amount_cents = "-100";
      if (mode === "zero_count") data[1]!.group_receipt_count = 0;
      if (mode === "repeated_metadata") data[1]!.source_byte_size = "1235";
      expect((await read(data, new Map([[key, original]]))).get(key)).toBe(original);
      expect((await read(data)).size).toBe(0);
    });
  it("checks a group beyond the display cap and isolates corrupt candidates", async () => {
    const data = rows([600, 500, 400, 300, 200, 100]); data[5]!.amount_cents = "101";
    const otherId = "55555555-5555-4555-8555-555555555555";
    const other = rows([100]).map(row => ({ ...row, candidate_id: otherId }));
    const output = await attachMissouriCommitteeMonetaryReceipts({ db: db([...data, ...other]),
      requests: [...requests, { candidate_id: otherId, election_id }], summaries: new Map() });
    expect(output.has(key)).toBe(false);
    expect(output.has(candidateElectionKey(otherId, election_id))).toBe(true);
  });
});
