import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ list: vi.fn(), lock: vi.fn(), write: vi.fn(), aggregate: vi.fn(), load: vi.fn() }));
vi.mock("../../../src/pipeline/northDakotaFinance/northDakotaReportedStore.js", () => ({ listNorthDakotaReportedReceivers: h.list, lockNorthDakotaReportedReceiver: h.lock, writeNorthDakotaReportedComponent: h.write, aggregateNorthDakotaReported: h.aggregate }));
vi.mock("../../../src/pipeline/northDakotaFinance/northDakotaReportedSource.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/pipeline/northDakotaFinance/northDakotaReportedSource.js")>(), loadNorthDakotaReportedPacket: h.load }));
import { syncDueNorthDakotaReportedFinance } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedBatchSync.js";
import { ND_REPORTED_REVISION, ndHash } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedSource.js";
import { NorthDakotaReportedHold } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedAggregation.js";
import { syncDueNorthDakotaCandidateFinance } from "../../../src/pipeline/northDakotaFinance/northDakotaCandidateFinanceBatchSync.js";
const now = new Date("2026-10-18T12:00:00.000Z"), hash = "a".repeat(64);
const receivers = Array.from({ length: 30 }, (_, n) => ({ linkId: String(n).padStart(3, "0"), electionDate: "2026-11-03", candidateId: `candidate-${n}`, electionId: "election", candidateName: `Example ${n}` }));
function database(stored: any[] = [], attempts: any[] = []) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT") ? sql.includes("nd_reported_finance_attempts") ? attempts : stored : sql.includes("INSERT") ? [{}] : [] }));
  const connect = vi.fn(async () => ({ query, release: vi.fn() })); return { db: { query, connect } as unknown as Pool, query, connect };
}
beforeEach(() => {
  vi.stubEnv("NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("NORTH_DAKOTA_REPORTED_COMMITTEE_RECEIPTS_ENABLED", "true"); vi.stubEnv("NORTH_DAKOTA_INDEPENDENT_IE_ENABLED", "true");
  h.list.mockResolvedValue(receivers); h.lock.mockResolvedValue(undefined); h.write.mockResolvedValue({ groups: 1, idempotent: false });
  h.load.mockImplementation(async kind => ({ kind, sourceHash: hash, sourceAt: "2026-10-17T12:00:00.000Z" }));
  h.aggregate.mockImplementation((_r, s) => ({ totalCents: 10000, supportCents: s.kind === "ie" ? 10000 : 0, opposeCents: 0, groups: [{}] }));
});
afterEach(() => vi.unstubAllEnvs());
describe("North Dakota independent component batch", () => {
  it("runs through the ordinary candidate batch even when legacy summaries are fresh", async () => {
    const result = await syncDueNorthDakotaCandidateFinance({ db: database().db, now,
      listDueRowsFn: vi.fn().mockResolvedValue({ rows: [], totalDueRows: 0 }), log: vi.fn() });
    expect(result.attempted).toBe(0); expect(result.reported?.writtenCount).toBe(50);
  });
  it("keeps the legacy batch running when the reported job throws", async () => {
    h.list.mockRejectedValue(Error("relation nd_reported_finance_components does not exist")); const log = vi.fn();
    const result = await syncDueNorthDakotaCandidateFinance({ db: database().db, now, listDueRowsFn: vi.fn().mockResolvedValue({ rows: [], totalDueRows: 0 }), log });
    expect(result.reported).toBeUndefined(); expect(result.reportedError).toMatch(/does not exist/); expect(log).toHaveBeenCalledTimes(1);
  });
  it("defaults to 25 receivers and writes both independently qualified components", async () => {
    const d = database(), r = await syncDueNorthDakotaReportedFinance({ db: d.db, now });
    expect(r).toMatchObject({ eligibleCount: 30, dueCount: 30, selectedCount: 25, attemptedCount: 50, writtenCount: 50, committeeWrittenCount: 25, ieWrittenCount: 25 });
    expect(h.write).toHaveBeenCalledTimes(50);
  });
  it("acquires and writes IE when the complete contribution source is unavailable", async () => {
    h.load.mockImplementation(async kind => { if (kind === "committee") throw Error("direct_source_unavailable"); return { kind, sourceHash: hash, sourceAt: now.toISOString() }; });
    const r = await syncDueNorthDakotaReportedFinance({ db: database().db, now });
    expect(r).toMatchObject({ sourceUnavailableCount: 1, committeeWrittenCount: 0, ieWrittenCount: 25, heldCount: 25 });
    expect(h.load.mock.calls.map(x => x[0])).toEqual(["committee", "ie"]);
  });
  it("keeps IE independent of a candidate's direct aggregation failure", async () => {
    h.aggregate.mockImplementation((_r, s) => { if (s.kind === "committee") throw new NorthDakotaReportedHold("direct_control"); return { totalCents: 10000, supportCents: 10000, opposeCents: 0, groups: [{}] }; });
    expect(await syncDueNorthDakotaReportedFinance({ db: database().db, now })).toMatchObject({ ieWrittenCount: 25, committeeWrittenCount: 0, heldCount: 25 });
  });
  it("rotates never-attempted receivers before recently held receivers", async () => {
    const attempts = receivers.slice(0, 5).flatMap(receiver => ["committee", "ie"].map(component => ({ link_id: receiver.linkId, component, source_revision: ndHash(ND_REPORTED_REVISION + hash), receiver_context: receiver, last_attempted_at: now.toISOString() })));
    const r = await syncDueNorthDakotaReportedFinance({ db: database([], attempts).db, now });
    expect(r.dueCount).toBe(25); expect(h.write.mock.calls[0]![0].receiver.linkId).toBe("005");
  });
  it("retries changed source revisions and canonical context without a 24-hour wait", async () => {
    h.list.mockResolvedValue([receivers[0]]);
    const attempts = ["committee", "ie"].map(component => ({ link_id: "000", component, source_revision: "b".repeat(64), receiver_context: receivers[0], last_attempted_at: now.toISOString() }));
    expect((await syncDueNorthDakotaReportedFinance({ db: database([], attempts).db, now })).writtenCount).toBe(2);
    h.write.mockClear(); for (const a of attempts) { a.source_revision = ndHash(ND_REPORTED_REVISION + hash); a.receiver_context = { ...receivers[0]!, candidateName: "old" }; }
    expect((await syncDueNorthDakotaReportedFinance({ db: database([], attempts).db, now })).writtenCount).toBe(2);
  });
  it("retains the post-election cohort through the year-end filing retry", async () => {
    expect((await syncDueNorthDakotaReportedFinance({ db: database().db, now: new Date("2027-02-03T12:00:00Z"), dryRun: true })).eligibleCount).toBe(30);
    expect((await syncDueNorthDakotaReportedFinance({ db: database().db, now: new Date("2027-02-16T12:00:00Z"), dryRun: true })).eligibleCount).toBe(0);
  });
  it("dry run performs no attempts or monetary writes", async () => {
    const d = database(); await syncDueNorthDakotaReportedFinance({ db: d.db, now, dryRun: true });
    expect(d.connect).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  });
  it("default-off gates avoid source and database work", async () => {
    vi.stubEnv("NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", "false"); const d = database();
    expect((await syncDueNorthDakotaReportedFinance({ db: d.db, now })).enabled).toBe(false);
    expect(d.query).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
    // Legacy CLI values beyond this job's caps must not break the legacy batch while the flags are off.
    expect((await syncDueNorthDakotaReportedFinance({ db: d.db, now, maxCandidates: 5000, staleAfterDays: 400 })).enabled).toBe(false);
    vi.stubEnv("NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", "true");
    await expect(syncDueNorthDakotaReportedFinance({ db: d.db, now, maxCandidates: 5000 })).rejects.toThrow(/batch option/);
  });
});
