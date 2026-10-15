import { describe, expect, it, vi } from "vitest";
import { attachMarylandCommitteeMonetaryFinance } from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryReader.js";
import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";

const candidate_id = "11111111-1111-4111-8111-111111111111", election_id = "22222222-2222-4222-8222-222222222222";
const requests = [{candidate_id, election_id}], key = candidateElectionKey(candidate_id, election_id);
function rows(amounts: number[], codes = amounts.map(() => "TPAC")) {
  const net = amounts.reduce((a, b) => a + b, 0), gross = amounts.reduce((a, b) => a + Math.max(0, b), 0);
  const source = {candidate_id, election_id, link_id: "33333333-3333-4333-8333-333333333333", election_year: 2026,
    committee_id: "1234", active_link_count: 1, net_amount: String(net), gross_amount: String(gross),
    refund_amount: String(gross - net), position_count: amounts.length,
    financial_basis:"active_native_api_with_published_summary_controls",
    source_observed_at: "2026-10-13T10:00:00Z", inventory_observed_at: "2026-10-15T10:00:00Z", last_synced_at: "2026-10-15T11:00:00Z"};
  return amounts.length ? amounts.map((amount, i) => ({...source, id: `stored-position-${i}`, donor_name: `Example ${i}`,
    reported_class_code: codes[i]!, amount: String(amount), gross: String(Math.max(0, amount)),
    refund: String(Math.max(0, -amount)), source_url: "https://campaignfinance.maryland.gov"})) :
    [{...source, id: null, donor_name: null, reported_class_code: null, amount: null, gross: null, refund: null, source_url: null}];
}
function db(data: ReturnType<typeof rows>) {
  return {query: vi.fn().mockResolvedValue({rows: data})};
}
describe("Maryland committee monetary reader", () => {
  it("sums signed positions before caps and keeps all nine classes in scope", async () => {
    const data = rows([6000, 100, 100, 100, 100, 100, -6500, 500, 500],
      ["TPAC", "TFED", "TPCC", "TPCLB", "TPOC", "TRNFC", "TUNFC", "TSLATE", "TCC"]);
    const database = db(data);
    const result = await attachMarylandCommitteeMonetaryFinance({db: database, requests, summaries: new Map()});
    const summary = result.get(key)!;
    const groups = summary.direct_campaign.pac_money_by_interest!;
    expect(groups.reduce((n, g) => n + g.amount, 0)).toBe(1000);
    const unsorted = groups.find(g => g.interest === "unclassified")!;
    expect(unsorted.amount).toBe(500);
    expect(unsorted.pac_count).toBe(8);
    expect(unsorted.pacs).toHaveLength(5);
    expect(unsorted.pacs.map(p => p.amount)).toEqual([-6500, 6000, 500, 100, 100]);
    expect(groups.find(g => g.interest === "candidate_committees")?.amount).toBe(500);
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.last_synced_at).toBe("2026-10-13T10:00:00.000Z");
    expect(summary.direct_campaign.pac_money_basis).toBe("reported_committee_monetary_positions");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("2026-10-13");
    expect(summary.direct_campaign.pac_money_coverage_note).toContain("printed receipt details have unresolved differences");
    expect(String(database.query.mock.calls[0]?.[0])).not.toMatch(/\bLIMIT\b|amount\s*>\s*0/i);
  });
  it("ranks interests by magnitude so a large net refund survives the display cap", async () => {
    const output = await attachMarylandCommitteeMonetaryFinance({db: db(rows([10, -6000], ["TPAC", "TCC"])), requests, summaries: new Map()});
    expect(output.get(key)?.direct_campaign.pac_money_by_interest?.map(g => [g.interest, g.amount]))
      .toEqual([["candidate_committees", -6000], ["unclassified", 10]]);
  });
  it("retains existing money, timestamps and coverage notes", async () => {
    const original = (await attachMarylandCommitteeMonetaryFinance({db: db(rows([10000])), requests, summaries: new Map()})).get(key)!;
    original.last_synced_at = "2026-09-01T00:00:00Z";
    original.direct_campaign.total_raised = 999;
    original.direct_campaign.direct_coverage_note = "Existing explanation";
    original.outside_spending.support_total = 123;
    const output = await attachMarylandCommitteeMonetaryFinance({db: db(rows([-6000])), requests, summaries: new Map([[key, original]])});
    expect(output.get(key)?.last_synced_at).toBe(original.last_synced_at);
    expect(output.get(key)?.direct_campaign.total_raised).toBe(999);
    expect(output.get(key)?.direct_campaign.direct_coverage_note).toBe("Existing explanation");
    expect(output.get(key)?.outside_spending.support_total).toBe(123);
    expect(output.get(key)?.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(-6000);
    expect(original.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(10000);
  });
  it("omits a candidate whose active receiving links are only partly qualified", async () => {
    const data = rows([10000]); data[0]!.active_link_count = 2;
    const output = await attachMarylandCommitteeMonetaryFinance({db: db(data), requests, summaries: new Map()});
    expect(output.size).toBe(0);
  });
  it("preserves a qualified empty component without inventing Raised or outside zeros", async () => {
    const output = await attachMarylandCommitteeMonetaryFinance({db: db(rows([])), requests, summaries: new Map()});
    expect(output.get(key)?.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(output.get(key)?.direct_campaign.total_raised).toBeNull();
    expect(output.get(key)?.outside_spending.oppose_total).toBeNull();
  });
  it("preserves full gross/refund materiality when the same reported position nets to zero", async () => {
    const data = rows([0]);
    Object.assign(data[0]!, {gross_amount: "10000", refund_amount: "10000", gross: "10000", refund: "10000"});
    const output = await attachMarylandCommitteeMonetaryFinance({db: db(data), requests, summaries: new Map()});
    expect(output.get(key)?.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({amount: 0, gross_amount: 10000, refund_amount: 10000, pac_count: 1});
  });
  it.each(["total", "count", "duplicate", "time", "class", "basis"])("rejects inconsistent stored %s", async mode => {
    const data = rows([10000, -1000]);
    if (mode === "total") data[0]!.net_amount = "10000";
    if (mode === "count") data[0]!.position_count = 1;
    if (mode === "duplicate") data[1]!.id = data[0]!.id;
    if (mode === "time") data[0]!.source_observed_at = "2026-10-16T00:00:00Z";
    if (mode === "class") data[0]!.reported_class_code = "TIND";
    if (mode === "basis") data[0]!.financial_basis="unqualified";
    await expect(attachMarylandCommitteeMonetaryFinance({db: db(data), requests, summaries: new Map()})).rejects.toThrow("invalid_maryland_stored_committee_component");
  });
});
