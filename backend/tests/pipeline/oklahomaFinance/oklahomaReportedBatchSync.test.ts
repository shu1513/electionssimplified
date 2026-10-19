import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ list: vi.fn(), lock: vi.fn(), write: vi.fn(), aggregate: vi.fn(), load: vi.fn() }));
vi.mock("../../../src/pipeline/oklahomaFinance/oklahomaReportedStore.js", () => ({ listOklahomaReportedReceivers: h.list, lockOklahomaReportedReceiver: h.lock, writeOklahomaReportedComponent: h.write, aggregateOklahomaReported: h.aggregate }));
vi.mock("../../../src/pipeline/oklahomaFinance/oklahomaReportedSource.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/pipeline/oklahomaFinance/oklahomaReportedSource.js")>(), loadOklahomaReportedPacket: h.load,loadOklahomaReceiverPacket: async (packet:any)=>({packet}) }));
import { syncDueOklahomaReportedFinance } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedBatchSync.js";
import { OK_REPORTED_REVISION, okHash } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedCore.js";
import { OklahomaReportedHold } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedCore.js";
import { syncDueOklahomaCandidateFinance } from "../../../src/pipeline/oklahomaFinance/oklahomaCandidateFinanceBatchSync.js";
const now = new Date("2026-10-18T12:00:00.000Z"), hash = "a".repeat(64);
const receivers = Array.from({ length: 30 }, (_, n) => ({ linkId: String(n).padStart(3, "0"), electionDate: "2026-11-03", candidateId: `candidate-${n}`, electionId: "election", candidateName: `Example ${n}` }));
function database(stored: any[] = [], attempts: any[] = []) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT") ? sql.includes("ok_reported_finance_attempts") ? attempts : stored : sql.includes("INSERT") ? [{}] : [] }));
  const connect = vi.fn(async () => ({ query, release: vi.fn() })); return { db: { query, connect } as unknown as Pool, query, connect };
}
beforeEach(() => {
  vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("OKLAHOMA_REPORTED_COMMITTEE_ENABLED", "true"); vi.stubEnv("OKLAHOMA_INDEPENDENT_IE_ENABLED", "true");
  h.list.mockResolvedValue(receivers); h.lock.mockResolvedValue(undefined); h.write.mockResolvedValue({ groups: 1, idempotent: false });
  h.load.mockImplementation(async kind => ({ kind, sourceHash: hash, sourceAt: "2026-10-17T12:00:00.000Z" }));
  h.aggregate.mockImplementation((_r, s) => ({ totalCents: 10000, supportCents: s.packet.kind === "ie" ? 10000 : 0, opposeCents: 0, groups: [{}] }));
});
afterEach(() => vi.unstubAllEnvs());
describe("Oklahoma independent component batch", () => {
  it("defaults to 25 receivers and writes both independently qualified components", async () => {
    const d = database(), r = await syncDueOklahomaReportedFinance({ db: d.db, now });
    expect(r).toMatchObject({ eligibleCount: 30, dueCount: 30, selectedCount: 25, attemptedCount: 50, writtenCount: 50, committeeWrittenCount: 25, ieWrittenCount: 25 });
    expect(h.write).toHaveBeenCalledTimes(50);
  });
  it("acquires and writes IE when the complete contribution source is unavailable", async () => {
    h.load.mockImplementation(async kind => { if (kind === "committee") throw Error("direct_source_unavailable"); return { kind, sourceHash: hash, sourceAt: now.toISOString() }; });
    const r = await syncDueOklahomaReportedFinance({ db: database().db, now });
    expect(r).toMatchObject({ sourceUnavailableCount: 1, committeeWrittenCount: 0, ieWrittenCount: 25, heldCount: 25 });
    expect(h.load.mock.calls.map(x => x[0])).toEqual(["committee", "ie"]);
  });
  it("keeps IE independent of a candidate's direct aggregation failure", async () => {
    h.aggregate.mockImplementation((_r, s) => { if (s.packet.kind === "committee") throw new OklahomaReportedHold("direct_control"); return { totalCents: 10000, supportCents: 10000, opposeCents: 0, groups: [{}] }; });
    expect(await syncDueOklahomaReportedFinance({ db: database().db, now })).toMatchObject({ ieWrittenCount: 25, committeeWrittenCount: 0, heldCount: 25 });
  });
  it("rotates never-attempted receivers before recently held receivers", async () => {
    const attempts = receivers.slice(0, 5).flatMap(receiver => ["committee", "ie"].map(component => ({ link_id: receiver.linkId, component, source_revision: okHash(OK_REPORTED_REVISION + hash), receiver_context: receiver, last_attempted_at: now.toISOString() })));
    const r = await syncDueOklahomaReportedFinance({ db: database([], attempts).db, now });
    expect(r.dueCount).toBe(25); expect(h.write.mock.calls.slice(0,25).every(x=>!receivers.slice(0,5).some(r=>r.linkId===x[0].receiver.linkId))).toBe(true);
  });
  it("retries changed source revisions and canonical context without a 24-hour wait", async () => {
    h.list.mockResolvedValue([receivers[0]]);
    const attempts = ["committee", "ie"].map(component => ({ link_id: "000", component, source_revision: "b".repeat(64), receiver_context: receivers[0], last_attempted_at: now.toISOString() }));
    expect((await syncDueOklahomaReportedFinance({ db: database([], attempts).db, now })).writtenCount).toBe(2);
    h.write.mockClear(); for (const a of attempts) { a.source_revision = okHash(OK_REPORTED_REVISION + hash); a.receiver_context = { ...receivers[0]!, candidateName: "old" }; }
    expect((await syncDueOklahomaReportedFinance({ db: database([], attempts).db, now })).writtenCount).toBe(2);
  });
  it("retains the post-election cohort through the year-end filing retry", async () => {
    expect((await syncDueOklahomaReportedFinance({ db: database().db, now: new Date("2027-02-08T12:00:00Z"), dryRun: true })).eligibleCount).toBe(30);
    expect((await syncDueOklahomaReportedFinance({ db: database().db, now: new Date("2027-02-16T12:00:00Z"), dryRun: true })).eligibleCount).toBe(0);
  });
  it("dry run performs no attempts or monetary writes", async () => {
    const d = database(); await syncDueOklahomaReportedFinance({ db: d.db, now, dryRun: true });
    expect(d.connect).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  });
  it("default-off gates avoid source and database work", async () => {
    vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED", "false"); const d = database();
    expect((await syncDueOklahomaReportedFinance({ db: d.db, now })).enabled).toBe(false);
    expect(d.query).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
    // Legacy CLI values beyond this job's caps must not break the legacy batch while the flags are off.
    expect((await syncDueOklahomaReportedFinance({ db: d.db, now, maxCandidates: 5000, staleAfterDays: 400 })).enabled).toBe(false);
    vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED", "true");
    await expect(syncDueOklahomaReportedFinance({ db: d.db, now, maxCandidates: 5000 })).rejects.toThrow(/batch option/);
  });
});

