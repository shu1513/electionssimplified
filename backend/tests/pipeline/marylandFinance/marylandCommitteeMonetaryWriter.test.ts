import { describe, expect, it, vi } from "vitest";
import { replaceMarylandCommitteeMonetarySnapshot, type MarylandCommitteeMonetarySnapshot } from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryWriter.js";

function snapshot(): MarylandCommitteeMonetarySnapshot {
  return {
    linkId: "11111111-1111-4111-8111-111111111111", candidateId: "22222222-2222-4222-8222-222222222222",
    electionId: "33333333-3333-4333-8333-333333333333", electionYear: 2026, receivingCommitteeId: "1234",
    sourceUrl: "https://campaignfinance.maryland.gov", sourceObservedAt: new Date("2026-10-13T10:00:00Z"),
    inventoryObservedAt: new Date("2026-10-15T10:00:00Z"),
    provenance: {reportCount: 7, captureCount: 30, originalSha256s: ["a".repeat(64)]},
    aggregation: {currentCycle: "7", priorCycle: "6", sourceRows: 9, priorSourceRows: 4, resolvedRefunds: 2,
      nonCommitteeOverRefundParentCount: 0, giftCount: 1, refundCount: 2, grossCents: 50000, refundCents: 60000, netCents: -10000,
      positions: [
        {donorName: "Example Committee", reportedClassCode: "TPAC", reportedClassLabel: "Political Action Committee",
          recognitionMethod: "explicit_reported_class", identityScope: "reported_class_and_name",
          grossCents: 50000, refundCents: 50000, netCents: 0, giftCount: 1, refundCount: 1,
          originalGiftKinds: ["CMONT"], documentBoundCashOutflowRefundCount: 1},
        {donorName: "Example Committee", reportedClassCode: "TFED", reportedClassLabel: "Federal Committee",
          recognitionMethod: "explicit_reported_class", identityScope: "reported_class_and_name",
          grossCents: 0, refundCents: 10000, netCents: -10000, giftCount: 0, refundCount: 1,
          originalGiftKinds: ["CINKIND"], documentBoundCashOutflowRefundCount: 1},
      ]},
  };
}
function database(options: {missingLink?: boolean; newer?: boolean; failInsert?: boolean} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM")) return {rows: options.missingLink ? [] : [{id: snapshot().linkId}]};
    if (sql.includes("SELECT link_id FROM")) return {rows: options.newer ? [{link_id: snapshot().linkId}] : []};
    if (options.failInsert && sql.includes("INSERT INTO public.md_candidate_finance_pac_sources")) throw new Error("write_failed");
    return {rows: []};
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({query, release}));
  return {db: {connect} as unknown as Parameters<typeof replaceMarylandCommitteeMonetarySnapshot>[0]["db"], query, release, connect};
}
const syncedAt = new Date("2026-10-15T11:00:00Z");
describe("Maryland independent monetary component writer", () => {
  it("retains negative and zero positions, separates same-name classes, and never updates other components", async () => {
    const d = database();
    await expect(replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: snapshot(), syncedAt})).resolves.toEqual({positionsWritten: 2});
    const calls = d.query.mock.calls as unknown as [string, unknown[]][];
    const donors = calls.filter(([sql]) => sql.includes("INSERT INTO public.md_candidate_finance_pac_donors"));
    expect(donors.map(([,args]) => args.slice(4, 8))).toEqual([["TPAC", "0.00", "500.00", "500.00"], ["TFED", "-100.00", "0.00", "100.00"]]);
    expect(calls.some(([sql]) => /(?:INSERT INTO|UPDATE|DELETE FROM) public\.md_candidate_finance_(?:summaries|direct_breakdowns|outside)/.test(sql))).toBe(false);
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
    expect(d.release).toHaveBeenCalledOnce();
  });
  it("uses upserts for stable row IDs and removes obsolete class/name pairs", async () => {
    const d = database();
    await replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: snapshot(), syncedAt});
    const calls = d.query.mock.calls as unknown as [string, unknown[]][];
    const donor = calls.find(([sql]) => sql.includes("INSERT INTO public.md_candidate_finance_pac_donors"))!;
    expect(donor[0]).toContain("ON CONFLICT (link_id, election_year, reported_class_code, donor_name_normalized)");
    expect(donor[0]).not.toContain("id =");
    const deletion = calls.find(([sql]) => sql.includes("DELETE FROM"))!;
    expect(deletion[1].slice(2)).toEqual([["TPAC", "TFED"], ["EXAMPLE COMMITTEE", "EXAMPLE COMMITTEE"]]);
  });
  it("retains validated values when the caller mutates inputs while connect is pending", async () => {
    const d = database(); const s = snapshot(); const at = new Date(syncedAt);
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const originalConnect = d.connect.getMockImplementation()!;
    d.connect.mockImplementation(async () => { await pending; return originalConnect(); });
    const result = replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: s, syncedAt: at});
    s.aggregation.positions[0]!.donorName = "Changed";
    s.aggregation.positions[0]!.originalGiftKinds.push("ANYMS");
    s.aggregation.netCents = 123;
    s.sourceObservedAt.setUTCFullYear(2030);
    s.provenance.originalSha256s = ["b".repeat(64)];
    at.setUTCFullYear(2030);
    resume(); await result;
    const calls = d.query.mock.calls as unknown as [string, unknown[]][];
    const donor = calls.find(([sql]) => sql.includes("INSERT INTO public.md_candidate_finance_pac_donors"))![1];
    expect(donor[2]).toBe("Example Committee");
    expect(donor[10]).toEqual(["CMONT"]);
    expect(donor[13]).toBe("2026-10-13T10:00:00.000Z");
    expect(donor[14]).toBe("2026-10-15T11:00:00.000Z");
    const source = calls.find(([sql]) => sql.includes("INSERT INTO public.md_candidate_finance_pac_sources"))![1];
    expect(source[2]).toBe("-100.00");
    expect(JSON.parse(source[8] as string).originalSha256s).toEqual(["a".repeat(64)]);
  });
  it.each(["missingLink", "newer"] as const)("rolls back %s without replacing rows", async field => {
    const d = database({[field]: true});
    await expect(replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: snapshot(), syncedAt})).rejects.toThrow(field === "newer" ? "maryland_committee_older_source" : "maryland_committee_receiving_link_changed");
    expect(d.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(d.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
    expect(d.release).toHaveBeenCalledOnce();
  });
  it("rolls back partial donor updates if component summary fails", async () => {
    const d = database({failInsert: true});
    await expect(replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: snapshot(), syncedAt})).rejects.toThrow("write_failed");
    expect(d.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(d.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(d.release).toHaveBeenCalledOnce();
  });
  it.each(["totals", "duplicate", "timestamp", "class", "unsafe", "kind"])("rejects invalid %s before acquiring a DB client", async mode => {
    const d = database(); const s = snapshot();
    if (mode === "totals") s.aggregation.netCents++;
    if (mode === "duplicate") s.aggregation.positions[1] = {...s.aggregation.positions[0]!};
    if (mode === "timestamp") s.sourceObservedAt = new Date("2026-10-16T00:00:00Z");
    if (mode === "class") s.aggregation.positions[0]!.reportedClassCode = "TIND";
    if (mode === "unsafe") s.aggregation.positions[0]!.grossCents = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "kind") s.aggregation.positions[0]!.originalGiftKinds = ["CMONT", "CMONT"];
    await expect(replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: s, syncedAt})).rejects.toThrow("invalid_maryland_committee_monetary_snapshot");
    expect(d.connect).not.toHaveBeenCalled();
  });
  it("replaces a fully qualified empty component without publishing other zero totals", async () => {
    const d = database(); const s = snapshot();
    Object.assign(s.aggregation, {positions: [], giftCount: 0, refundCount: 0, grossCents: 0, refundCents: 0, netCents: 0});
    await expect(replaceMarylandCommitteeMonetarySnapshot({db: d.db, snapshot: s, syncedAt})).resolves.toEqual({positionsWritten: 0});
    const calls = d.query.mock.calls as unknown as [string, unknown[]][];
    expect(calls.find(([sql]) => sql.includes("DELETE FROM"))?.[1].slice(2)).toEqual([[], []]);
    expect(calls.filter(([sql]) => sql.includes("INSERT INTO public.md_candidate_finance_pac_donors"))).toHaveLength(0);
  });
});
