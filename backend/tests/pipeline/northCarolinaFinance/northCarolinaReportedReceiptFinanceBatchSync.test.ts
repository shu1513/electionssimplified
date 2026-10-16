import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Qualified } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceTypes.js";
import type { NorthCarolinaReportedReceiptFinanceReceiver } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceTypes.js";
const mocks = vi.hoisted(() => ({ due: vi.fn(), attempt: vi.fn(), read: vi.fn(), acquire: vi.fn(), discover: vi.fn(), transport: vi.fn(),
  validate: vi.fn(), write: vi.fn(), delay: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), lstat: vi.fn(), readdir: vi.fn(), order: [] as string[] }));
vi.mock("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceDueList.js", () => ({
  listDueNorthCarolinaReportedReceiptFinance: mocks.due, recordNorthCarolinaReportedReceiptFinanceAttempt: mocks.attempt,
}));
vi.mock("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js", async original => ({
  ...await original<typeof import("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js")>(),
  readNorthCarolinaReportedReceiptSource: mocks.read, resolveNorthCarolinaReportedReceiptCacheDir: (v?: string) => v ?? "/private/synthetic-default-cache",
}));
vi.mock("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceAcquisition.js", () => ({ acquireNorthCarolinaReportedReceiptSource: mocks.acquire }));
vi.mock("../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeAcquisitionDiscovery.js", () => ({ discoverNcsbeAcquisitionCommittees: mocks.discover }));
vi.mock("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptDiscoveryTransport.js", () => ({
  createNorthCarolinaReportedReceiptDiscoveryTransport: mocks.transport,
}));
vi.mock("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceWriter.js", async original => ({
  ...await original<typeof import("../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceWriter.js")>(),
  validateNorthCarolinaReportedReceiptPacket: mocks.validate, writeNorthCarolinaReportedReceiptComponent: mocks.write,
}));
vi.mock("node:timers/promises", async original => ({ ...await original<typeof import("node:timers/promises")>(), setTimeout: mocks.delay }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(),
  mkdir: mocks.mkdir, chmod: mocks.chmod, lstat: mocks.lstat, readdir: mocks.readdir,
}));
import { syncDueNorthCarolinaReportedReceiptFinance as sync } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceBatchSync.js";
import { NorthCarolinaReportedReceiptSourceError as SourceError } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js";
import { NorthCarolinaReportedReceiptFinanceWriteError as WriteError } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceWriter.js";

const NOW = new Date("2026-10-20T12:00:00.000Z"), CACHE = "/private/synthetic-nc-cache";
const db = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;
function receiver(index = 1, committee = index, electionYear = 2026): NorthCarolinaReportedReceiptFinanceReceiver {
  return { linkId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, candidateId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    electionId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, electionYear, electionDate: `${electionYear}-11-03`,
    candidateName: `Synthetic Candidate ${index}`, officeScope: "state_upper", officeName: "State Senate", district: String(index), committeeId: `STA-AA11BB-C-${String(committee).padStart(3, "0")}`,
    committeeName: `Synthetic Campaign ${committee}`, linkSource: "manual", sourceUrl: null, lastSyncedAt: null };
}
/** Orchestration boundary stubs only. Full source/packet financial validation
 * has separate tests; none of these mocks constitutes accepted source proof. */
function packet(r = receiver(), zero = false): Qualified {
  return { source: { receivingCommitteeId: r.committeeId, electionYear: r.electionYear, sourceRetrievedAt: "2026-10-15T10:00:00.000Z" },
    aggregation: { status: "qualified", groups: zero ? [] : [{ positiveGrossCents: 75 }], positiveGrossCents: zero ? 0 : 75 } } as Qualified;
}
const run = (options: Partial<Parameters<typeof sync>[0]> = {}) => sync({ db, now: NOW, cacheDir: CACHE, ...options });
function due(rows = [receiver()], totalDueRows = rows.length) { mocks.due.mockResolvedValue({ eligibleCount: rows.length + 5, totalDueRows, rows }); }
function raw() { vi.stubEnv("NORTH_CAROLINA_NCSBE_RAW_DATA_REFRESH_ENABLED", "true"); }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW); mocks.order.length = 0;
  for (const flag of ["CANDIDATE_FINANCE_ENABLED", "NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED"]) vi.stubEnv(flag, "true");
  vi.stubEnv("NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED", "false"); vi.stubEnv("CANDIDATE_FINANCE_SYNC_ENABLED", "false");
  vi.stubEnv("NORTH_CAROLINA_NCSBE_RAW_DATA_REFRESH_ENABLED", "false"); due();
  mocks.attempt.mockImplementation(async () => { mocks.order.push("attempt"); return true; });
  mocks.read.mockImplementation(async ({ receivingCommitteeId, electionYear }) => { mocks.order.push("read"); return packet({ ...receiver(), committeeId: receivingCommitteeId, electionYear }); });
  mocks.validate.mockImplementation(() => { mocks.order.push("validate"); });
  mocks.write.mockImplementation(async () => { mocks.order.push("write"); return { sourceWritten: true, groupCount: 1, idempotent: false }; });
  mocks.acquire.mockImplementation(async () => { mocks.order.push("acquire"); return packet(); });
  mocks.discover.mockImplementation(async ({ roster }) => { mocks.order.push("discover"); return { committees: [{ sboeId: roster[0].linkedCommitteeId, orgGroupId: 17 }], searchFailures: [], ogidFailures: [] }; });
  mocks.transport.mockReturnValue({ fetchText: vi.fn().mockRejectedValue(new Error("synthetic transport must not fetch")) });
  mocks.mkdir.mockResolvedValue(undefined); mocks.chmod.mockResolvedValue(undefined); mocks.readdir.mockResolvedValue([]);
  mocks.lstat.mockResolvedValue({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }); mocks.delay.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("independent North Carolina reported receipt finance batch", () => {
  it.each(["CANDIDATE_FINANCE_ENABLED", "NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED"])("cannot bypass disabled %s even with force and refresh", async flag => {
    vi.stubEnv(flag, "false"); const result = await run({ force: true, refresh: true });
    expect(result).toMatchObject({ enabled: false, attemptedCount: 0, writtenCount: 0 });
    for (const fn of [mocks.due, mocks.attempt, mocks.read, mocks.acquire, mocks.write, mocks.mkdir]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([false, true])("writes cache-only qualified source (zero=%s) independently of legacy sync gates", async zero => {
    const value = packet(receiver(), zero); mocks.read.mockResolvedValue(value);
    const result = await run({ force: true });
    expect(result).toMatchObject({ enabled: true, dryRun: false, attemptedCount: 1, qualifiedCount: 1, writtenCount: 1, heldCount: 0, sourceRefreshedCount: 0, acquisitionStopped: false });
    expect(mocks.validate).toHaveBeenCalledWith({ packet: value, receivingCommitteeId: receiver().committeeId, electionYear: 2026, syncedAt: NOW });
    expect(mocks.write).toHaveBeenCalledWith({ db, receiver: receiver(), packet: value });
    expect(mocks.write.mock.calls[0]![0]).not.toHaveProperty("syncedAt");
    expect(mocks.acquire).not.toHaveBeenCalled(); expect(mocks.discover).not.toHaveBeenCalled(); expect(mocks.mkdir).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled(); expect(db.connect).not.toHaveBeenCalled();
  });

  it("reserves before reading and finishes after the writer with actual attempt clocks", async () => {
    const result = await run({ now: new Date("2026-10-19T00:00:00.000Z") });
    expect(result.now).toBe("2026-10-19T00:00:00.000Z"); expect(mocks.order).toEqual(["attempt", "read", "validate", "write", "attempt"]);
    expect(mocks.attempt).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.attempt.mock.calls) expect(input).toEqual({ db, receiver: receiver(), now: NOW, cacheDir: CACHE });
  });

  it("passes normal due options and preserves the due list's exact order and counts", async () => {
    const rows = [receiver(3), receiver(1)]; due(rows, 8);
    const result = await run({ maxCandidates: 2, staleAfterDays: 9, electionLookbackDays: 2, electionLookaheadDays: 500, refresh: true, electionYear: 2026 });
    expect(mocks.due).toHaveBeenCalledWith(db, { now: NOW, maxCandidates: 2, staleAfterDays: 9, electionLookbackDays: 2, electionLookaheadDays: 500, refresh: true, electionYear: 2026, cacheDir: CACHE });
    expect(mocks.write.mock.calls.map(([input]) => input.receiver)).toEqual(rows);
    expect(result).toMatchObject({ eligibleCount: 7, totalDueRows: 8, attemptedCount: 2, writtenCount: 2 });
  });

  it("dry run qualifies complete cached sources without reserving attempts or writing money", async () => {
    const result = await run({ dryRun: true });
    expect(result).toMatchObject({ dryRun: true, attemptedCount: 1, qualifiedCount: 1, writtenCount: 0, heldCount: 0 });
    expect(mocks.read).toHaveBeenCalledOnce(); expect(mocks.validate).toHaveBeenCalledOnce(); expect(mocks.attempt).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });

  it("skips a context whose protected attempt reservation fails", async () => {
    mocks.attempt.mockResolvedValueOnce(false); const result = await run();
    expect(result).toMatchObject({ attemptedCount: 1, heldCount: 1, writtenCount: 0 }); expect(mocks.attempt).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([null, new SourceError("held", "current_lineage"), new SourceError("unavailable")])("preserves money when cached source is absent/held/unavailable and continues other receivers", async failure => {
    due([receiver(1), receiver(2)]);
    if (failure instanceof Error) mocks.read.mockRejectedValueOnce(failure); else mocks.read.mockResolvedValueOnce(failure);
    const result = await run(); expect(result).toMatchObject({ attemptedCount: 2, qualifiedCount: 1, writtenCount: 1, heldCount: 1, acquisitionStopped: false });
    expect(mocks.attempt).toHaveBeenCalledTimes(4); expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.write.mock.calls[0]![0].receiver).toEqual(receiver(2));
  });

  it.each(["receiving_context_changed", "stale_source", "equal_source_conflict", "storage_unavailable"] as const)("contains safe writer %s and finishes its attempt", async code => {
    due([receiver(1), receiver(2)]); mocks.write.mockRejectedValueOnce(new WriteError(code));
    const result = await run(); expect(result).toMatchObject({ qualifiedCount: 2, writtenCount: 1, heldCount: 1 }); expect(mocks.attempt).toHaveBeenCalledTimes(4);
  });

  it("holds invalid packet controls before a writer and still closes the attempt", async () => {
    mocks.validate.mockImplementationOnce(() => { throw new WriteError("invalid_component"); });
    const result = await run(); expect(result).toMatchObject({ qualifiedCount: 0, heldCount: 1, writtenCount: 0 }); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.attempt).toHaveBeenCalledTimes(2);
  });

  it("surfaces unexpected programming failures after finishing the current attempt", async () => {
    due([receiver(1), receiver(2)]); const failure = new Error("synthetic_unexpected_failure"); mocks.write.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure); expect(mocks.attempt).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("uses real acquisition boundaries while the old direct-sync gates are off", async () => {
    raw(); const result = await run();
    expect(result).toMatchObject({ sourceRefreshedCount: 1, writtenCount: 1, acquisitionStopped: false });
    expect(mocks.order).toEqual(["attempt", "discover", "acquire", "read", "validate", "write", "attempt"]);
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport).toHaveBeenCalledWith({ cacheDir: expect.stringMatching(/^\/private\/synthetic-nc-cache\/discovery\/pass-[a-f0-9-]+$/) });
    expect(mocks.discover.mock.calls[0]![0].transport).toBe(mocks.transport.mock.results[0]!.value);
    expect(mocks.acquire).toHaveBeenCalledWith({ cacheDir: CACHE, receivingCommitteeId: receiver().committeeId, electionYear: 2026, orgGroupId: 17 });
    expect(mocks.discover.mock.calls[0]![0]).toMatchObject({ force: true, roster: [{ linkedCommitteeId: receiver().committeeId, candidateId: receiver().candidateId }] });
    expect(mocks.delay).toHaveBeenCalledWith(2000); expect(mocks.chmod).toHaveBeenCalled();
  });

  it("dry-run raw refresh may qualify genuine sources but never stamps attempts or finances", async () => {
    raw(); const result = await run({ dryRun: true });
    expect(result).toMatchObject({ sourceRefreshedCount: 1, qualifiedCount: 1, writtenCount: 0 }); expect(mocks.acquire).toHaveBeenCalledOnce(); expect(mocks.attempt).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });

  it("reuses one captured receiver-year packet across current contexts while retaining protected per-context writes", async () => {
    raw(); const rows = [receiver(1, 1), receiver(2, 1), receiver(3, 2)]; due(rows);
    const result = await run(); expect(result).toMatchObject({ attemptedCount: 3, sourceRefreshedCount: 2, qualifiedCount: 3, writtenCount: 3 });
    expect(mocks.discover).toHaveBeenCalledTimes(2); expect(mocks.acquire).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.write.mock.calls.map(([input]) => input.receiver)).toEqual(rows); expect(mocks.attempt).toHaveBeenCalledTimes(6);
    expect(mocks.delay.mock.calls).toEqual([[2000], [2000], [2000]]);
  });

  it("does not conflate the same receiver in different election years", async () => {
    raw(); due([receiver(1, 1), receiver(2, 1, 2028)]); const result = await run();
    expect(result).toMatchObject({ sourceRefreshedCount: 2, writtenCount: 2 }); expect(mocks.acquire.mock.calls.map(([input]) => input.electionYear)).toEqual([2026, 2028]);
  });

  it("continues healthy-host acquisition after a semantic source hold and never falls back to an old cached packet", async () => {
    raw(); due([receiver(1), receiver(2)]); mocks.acquire.mockRejectedValueOnce(new SourceError("held", "current_lineage"));
    const result = await run(); expect(result).toMatchObject({ sourceRefreshedCount: 1, heldCount: 1, writtenCount: 1, acquisitionStopped: false });
    expect(mocks.acquire).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledOnce(); expect(mocks.read.mock.calls[0]![0].receivingCommitteeId).toBe(receiver(2).committeeId);
    expect(mocks.attempt).toHaveBeenCalledTimes(4);
  });

  it("stops later host acquisition after native unavailability, preserving every affected component", async () => {
    raw(); due([receiver(1), receiver(2), receiver(3)]); mocks.acquire.mockRejectedValueOnce(new SourceError("unavailable"));
    const result = await run(); expect(result).toMatchObject({ attemptedCount: 3, heldCount: 3, qualifiedCount: 0, writtenCount: 0, sourceRefreshedCount: 0, acquisitionStopped: true });
    expect(mocks.discover).toHaveBeenCalledOnce(); expect(mocks.acquire).toHaveBeenCalledOnce(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.attempt).toHaveBeenCalledTimes(6);
  });

  it("does not retry a held repeated receiver-year or substitute a previously cached source", async () => {
    raw(); due([receiver(1, 1), receiver(2, 1)]); mocks.acquire.mockRejectedValueOnce(new SourceError("held", "current_lineage"));
    const result = await run(); expect(result).toMatchObject({ attemptedCount: 2, heldCount: 2, writtenCount: 0 });
    expect(mocks.acquire).toHaveBeenCalledOnce(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.attempt).toHaveBeenCalledTimes(4);
  });

  it.each(["search", "identity", "ambiguous"])("holds discovery %s failure without using financial fallback", async kind => {
    raw(); mocks.discover.mockResolvedValue({ committees: kind === "identity" ? [{ sboeId: receiver(2).committeeId, orgGroupId: 17 }] : kind === "ambiguous" ? [] : [{ sboeId: receiver().committeeId, orgGroupId: 17 }],
      searchFailures: kind === "search" ? [{ message: "synthetic_failure" }] : [], ogidFailures: [] });
    const result = await run(); expect(result).toMatchObject({ heldCount: 1, writtenCount: 0, acquisitionStopped: kind === "search" });
    expect(mocks.acquire).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.attempt).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a refreshed but absent qualified pointer for zero", async () => {
    raw(); mocks.read.mockResolvedValueOnce(null); const result = await run();
    expect(result).toMatchObject({ sourceRefreshedCount: 1, qualifiedCount: 0, writtenCount: 0, heldCount: 1 }); expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([{ maxCandidates: 0 }, { staleAfterDays: 0 }, { electionYear: 1999 }, { electionLookbackDays: -1 }, { electionLookaheadDays: -1 }, { refresh: "true" }, { now: new Date(NaN) }])("rejects invalid batch options before any due work", async options => {
    await expect(run(options as Parameters<typeof run>[0])).rejects.toThrow("Invalid North Carolina reported receipt batch"); expect(mocks.due).not.toHaveBeenCalled();
  });
});
