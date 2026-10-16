import { describe, expect, it, vi } from "vitest";
import {
  prepareMissouriCommitteeMonetaryReceiptComponent as prepare,
  replaceMissouriCommitteeMonetaryReceiptRows as replace,
  type MissouriCommitteeMonetaryReceiptComponent,
} from "../../../src/pipeline/missouriFinance/missouriCommitteeMonetaryReceiptWriter.js";

const linkId = "33333333-3333-4333-8333-333333333333";
const syncedAt = new Date("2026-10-15T12:00:00Z");
function component(groups = 2): MissouriCommitteeMonetaryReceiptComponent {
  return {
    receivingCommitteeId: "A123456", cycleStart: "2025-01-01", cycleEnd: "2026-11-03",
    sourceRetrievedAt: new Date("2026-10-14T12:00:00Z"),
    sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx",
    sourceSha256: "a".repeat(64), sourceByteSize: 1234, reportInventorySha256: "b".repeat(64),
    aggregation: { status: "qualified", sourceRowCount: groups + 3, inCycleRowCount: groups + 2, outsideCycleRowCount: 1,
      canonicalRowCount: groups + 2, matchedCommitteeRowCount: groups + 1, excludedNonCommitteeRowCount: 1,
      inKindRowCount: 1, zeroMonetaryRowCount: 0, includedReceiptRowCount: groups,
      relevantUnresolvedLineageCount: 0, excludedLineageRowCount: 0, excludedLineageAmountCents: 0, lineageDiagnosticCodes: [],
      totalAmountCents: groups * 101, committees: Array.from({length: groups}, (_, i) => ({
        reportedCommitteeName: `Example Committee ${i}`, reportedNameKey: `EXAMPLE COMMITTEE ${i}`, amountCents: 101, receiptCount: 1,
      })),
    },
  };
}
const prepared = (c = component()) => prepare({ component: c, receivingCommitteeId: " a123456 ", electionYear: 2026, syncedAt })!;
function dbWith(prior?: Date) {
  return { query: vi.fn(async (sql: unknown, _values?: unknown[]) => {
    if (String(sql).startsWith("SELECT id")) return { rows: [{id: linkId}], rowCount: 1 };
    if (String(sql).startsWith("SELECT source_retrieved_at")) return { rows: prior ? [{source_retrieved_at: prior}] : [], rowCount: prior ? 1 : 0 };
    return { rows: [], rowCount: 1 };
  }) };
}
describe("Missouri reported committee monetary receipt storage", () => {
  it("preserves held or absent components without promoting them to source zero", () => {
    expect(prepare({ receivingCommitteeId: "A123456", electionYear: 2026, syncedAt })).toBeUndefined();
    const c = component();
    c.aggregation = { ...c.aggregation, status: "held", reason: "unresolved_receipt_lineage" };
    expect(prepare({component: c, receivingCommitteeId: "A123456", electionYear: 2026, syncedAt})).toBeUndefined();
  });
  it.each([
    ["wrong receiver", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.receivingCommitteeId = "A999999"; }],
    ["wrong cycle year", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.cycleEnd = "2025-11-03"; }],
    ["invalid date", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.cycleStart = "2025-02-30"; }],
    ["future source", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.sourceRetrievedAt = new Date("2027-01-01"); }],
    ["invalid provenance", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.sourceSha256 = "invalid"; }],
    ["empty original", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.sourceByteSize = 0; }],
    ["wrong total", (c: MissouriCommitteeMonetaryReceiptComponent) => { if(c.aggregation.status === "qualified") c.aggregation.totalAmountCents++; }],
    ["wrong receipt count", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.aggregation.includedReceiptRowCount++; }],
    ["wrong source control", (c: MissouriCommitteeMonetaryReceiptComponent) => { c.aggregation.sourceRowCount++; }],
    ["fractional cents", (c: MissouriCommitteeMonetaryReceiptComponent) => { if(c.aggregation.status === "qualified") c.aggregation.committees[0]!.amountCents = 1.2; }],
    ["negative group", (c: MissouriCommitteeMonetaryReceiptComponent) => { if(c.aggregation.status === "qualified") c.aggregation.committees[0]!.amountCents = -101; }],
    ["duplicate groups", (c: MissouriCommitteeMonetaryReceiptComponent) => { if(c.aggregation.status === "qualified") c.aggregation.committees[1] = {...c.aggregation.committees[0]!}; }],
  ])("rejects %s before SQL", async (_label, mutate) => {
    const c = component(); mutate(c); const db = dbWith();
    expect(() => prepared(c)).toThrow("Missouri committee monetary receipts invalid_component");
    expect(db.query).not.toHaveBeenCalled();
  });
  it("stores every reported group, exact cents, and original retrieval time", async () => {
    const db = dbWith(); const c = prepared(component(101));
    await replace({ db: db as never, linkId, electionYear: 2026, syncedAt, component: c });
    const source = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.mo_candidate_finance_committee_receipt_sources"));
    expect(source?.[1]?.[5]).toBe("10201");
    expect(source?.[1]?.[6]).toBe(101);
    expect(source?.[1]?.[17]).toBe("2026-10-14T12:00:00.000Z");
    expect(source?.[1]?.[21]).toBe(syncedAt.toISOString());
    const groups = db.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.mo_candidate_finance_committee_receipts"));
    expect(groups).toHaveLength(101);
    expect(groups.every(call => call[1]?.[4] === "101")).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => ["BEGIN", "COMMIT"].includes(String(sql)))).toBe(false);
  });
  it("allows a qualified zero to clear stale groups without inventing gift counts", async () => {
    const db = dbWith(); const c = prepared(component(0));
    await replace({ db: db as never, linkId, electionYear: 2026, syncedAt, component: c });
    expect(db.query.mock.calls.some(([sql]) => String(sql).startsWith("DELETE FROM"))).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.mo_candidate_finance_committee_receipts"))).toBe(false);
    const source = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.mo_candidate_finance_committee_receipt_sources"));
    expect(source?.[1]?.slice(5,8)).toEqual(["0",0,0]);
  });
  it("refuses a newer source overwrite or a changed protected receiver before deleting groups", async () => {
    const db = dbWith(new Date("2026-10-15T00:00:00Z"));
    await expect(replace({ db: db as never, linkId, electionYear: 2026, syncedAt, component: prepared() })).rejects.toMatchObject({ code: "older_source" });
    expect(db.query.mock.calls).toHaveLength(2);
    db.query.mockResolvedValue({rows: [], rowCount: 0});
    await expect(replace({ db: db as never, linkId, electionYear: 2026, syncedAt, component: prepared() })).rejects.toMatchObject({ code: "receiving_link_changed" });
    expect(db.query.mock.calls.some(([sql]) => String(sql).startsWith("DELETE"))).toBe(false);
  });
  it("copies validated values before callers can mutate their packet", () => {
    const c = component(); const safe = prepared(c);
    if(c.aggregation.status === "qualified") c.aggregation.committees[0]!.amountCents = 999;
    c.sourceRetrievedAt.setUTCFullYear(2099);
    expect(safe.aggregation.committees[0]!.amountCents).toBe(101);
    expect(safe.sourceRetrievedAt.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });
  it("masks database details with a constant safe error", async () => {
    const db = dbWith(); db.query.mockRejectedValue(new Error("synthetic private database payload"));
    await expect(replace({ db: db as never, linkId, electionYear: 2026, syncedAt, component: prepared() })).rejects.toThrow("Missouri committee monetary receipts write_failed");
  });
});
