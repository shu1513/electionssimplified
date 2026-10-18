import { afterEach, describe, expect, it, vi } from "vitest";

import { syncDueMontanaCandidateFinance } from "../../../src/pipeline/montanaFinance/montanaCandidateFinanceBatchSync.js";
import type { MontanaCandidateFinanceDueRow } from "../../../src/pipeline/montanaFinance/montanaCandidateFinanceDueList.js";
import * as committeeBatch from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeBatchSync.js";
import * as independentIeBatch from "../../../src/pipeline/montanaFinance/montanaIndependentIeBatchSync.js";

function dueRow(overrides: Partial<MontanaCandidateFinanceDueRow>): MontanaCandidateFinanceDueRow {
  return {
    candidateId: "candidate-1",
    electionId: "election-1",
    candidateName: "David Bedey",
    electionYear: 2026,
    electionDate: "2026-11-03",
    officeScope: "state_upper",
    officeName: "State Senator",
    district: "43",
    committeeId: "21020",
    committeeName: "Bedey, David F.",
    linkSource: "cers_portal",
    sourceUrl: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

const db = { query: vi.fn(), connect: vi.fn() } as never;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("syncDueMontanaCandidateFinance", () => {
  it("runs independent IE with no legacy due rows or receipts, and preserves fault isolation",async()=>{
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_REPORTED_IE_ENABLED","true");
    vi.spyOn(committeeBatch,"syncDueMontanaCommitteeReceipts").mockRejectedValue(new Error("receipt unavailable"));
    const independent=vi.spyOn(independentIeBatch,"syncDueMontanaIndependentIe").mockResolvedValue({enabled:true,writtenCount:1} as never);
    const noDue=await syncDueMontanaCandidateFinance({db,autoLinkMissingLinks:false,listDueRowsFn:vi.fn().mockResolvedValue({rows:[],totalDueRows:0}),log:()=>{}});
    expect(noDue.independentIe).toEqual({enabled:true,writtenCount:1});expect(independent).toHaveBeenCalledWith(expect.objectContaining({db,maxCandidates:10}));
    independent.mockRejectedValue(new Error("IE unavailable"));const sync=vi.fn().mockResolvedValue({status:"synced"}),acquireOutside=vi.fn();
    const next=await syncDueMontanaCandidateFinance({db,autoLinkMissingLinks:false,forceRawDataRefresh:true,listDueRowsFn:vi.fn().mockResolvedValue({rows:[dueRow({})],totalDueRows:1}),acquireArtifactsFn:vi.fn(),acquireOutsideArtifactsFn:acquireOutside,syncCandidateFn:sync,log:()=>{}});
    expect(next.succeeded).toBe(1);expect(acquireOutside).not.toHaveBeenCalled();expect(sync).toHaveBeenCalledWith(expect.objectContaining({outsideArtifacts:null}));
    expect(independent).toHaveBeenLastCalledWith(expect.objectContaining({forceRawDataRefresh:true}));
  });
  it("runs the independent committee schedule when no legacy summary is due", async () => {
    const component=vi.spyOn(committeeBatch,"syncDueMontanaCommitteeReceipts").mockResolvedValue({enabled:true,writtenCount:1} as never);
    const result=await syncDueMontanaCandidateFinance({db,autoLinkMissingLinks:false,
      listDueRowsFn:vi.fn().mockResolvedValue({rows:[],totalDueRows:0}),log:()=>{}});
    expect(component).toHaveBeenCalledWith(expect.objectContaining({db,maxCandidates:10,electionLookbackDays:98,dryRun:false}));
    expect(result.attempted).toBe(0);expect(result.committeeReceipts).toEqual({enabled:true,writtenCount:1});
  });
  it("continues legacy work after an independent component failure", async () => {
    vi.spyOn(committeeBatch,"syncDueMontanaCommitteeReceipts").mockRejectedValue(new Error("synthetic component failure"));
    const sync=vi.fn().mockResolvedValue({status:"synced"}),result=await syncDueMontanaCandidateFinance({db,autoLinkMissingLinks:false,
      listDueRowsFn:vi.fn().mockResolvedValue({rows:[dueRow({})],totalDueRows:1}),syncCandidateFn:sync,log:()=>{}});
    expect(sync).toHaveBeenCalledTimes(1);expect(result.succeeded).toBe(1);
  });
  it("skips acquisition when the raw-refresh flag is off and syncs from cache", async () => {
    const acquire = vi.fn();
    const sync = vi.fn().mockResolvedValue({ status: "synced" });
    const result = await syncDueMontanaCandidateFinance({
      db,
      now: new Date("2026-08-28T00:00:00.000Z"),
      autoLinkMissingLinks: false,
      listDueRowsFn: vi.fn().mockResolvedValue({ rows: [dueRow({})], totalDueRows: 1 }),
      acquireArtifactsFn: acquire,
      syncCandidateFn: sync,
      log: () => {},
    });
    expect(result.rawDataRefreshEnabled).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);
  });

  it("acquires fresh artifacts per candidate when forced, and records failures without stopping", async () => {
    vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED", "true");
    const acquire = vi.fn().mockResolvedValue({});
    const acquireOutside = vi.fn().mockResolvedValue({});
    const sync = vi
      .fn()
      .mockRejectedValueOnce(new Error("chain failed"))
      .mockResolvedValueOnce({ status: "synced" });
    const result = await syncDueMontanaCandidateFinance({
      db,
      now: new Date("2026-08-28T00:00:00.000Z"),
      forceRawDataRefresh: true,
      autoLinkMissingLinks: false,
      listDueRowsFn: vi.fn().mockResolvedValue({
        rows: [dueRow({}), dueRow({ candidateId: "candidate-2", committeeId: "21021" })],
        totalDueRows: 2,
      }),
      acquireArtifactsFn: acquire,
      acquireOutsideArtifactsFn: acquireOutside,
      syncCandidateFn: sync,
      log: () => {},
    });
    expect(result.rawDataRefreshEnabled).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 21020, year: 2026 }));
    // The year-scoped IE sweep runs ONCE for the whole batch, not per row.
    expect(acquireOutside).toHaveBeenCalledTimes(1);
    expect(acquireOutside).toHaveBeenCalledWith(expect.objectContaining({ year: 2026 }));
    expect(result.outsideSweepYearCount).toBe(1);
    // A successful sweep leaves outsideArtifacts undefined: sync reads cache.
    expect(sync.mock.calls[0]![0]).not.toHaveProperty("outsideArtifacts");
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.candidates[0]).toMatchObject({ ok: false, error: "chain failed" });
  });

  it("skips the outside leg for the year when the IE sweep fails, without blocking direct syncs", async () => {
    vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({ status: "synced" });
    const result = await syncDueMontanaCandidateFinance({
      db,
      now: new Date("2026-08-28T00:00:00.000Z"),
      forceRawDataRefresh: true,
      autoLinkMissingLinks: false,
      listDueRowsFn: vi.fn().mockResolvedValue({ rows: [dueRow({})], totalDueRows: 1 }),
      acquireArtifactsFn: vi.fn().mockResolvedValue({}),
      acquireOutsideArtifactsFn: vi.fn().mockRejectedValue(new Error("sweep down")),
      syncCandidateFn: sync,
      log: () => {},
    });
    expect(result.failedOutsideSweepYearCount).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(sync.mock.calls[0]![0]).toMatchObject({ outsideArtifacts: null });
  });

  it("continues with existing links when the auto-link pass fails", async () => {
    const result = await syncDueMontanaCandidateFinance({
      db,
      now: new Date("2026-08-28T00:00:00.000Z"),
      autoLinkFn: vi.fn().mockRejectedValue(new Error("registration list down")),
      listDueRowsFn: vi.fn().mockResolvedValue({ rows: [], totalDueRows: 0 }),
      log: () => {},
    });
    expect(result.autoLinkResults).toEqual([]);
    expect(result.attempted).toBe(0);
  });
});
