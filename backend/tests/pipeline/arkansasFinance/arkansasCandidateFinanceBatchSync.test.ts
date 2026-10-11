import { describe, expect, it, vi } from "vitest";

import { syncDueArkansasCandidateFinance } from "../../../src/pipeline/arkansasFinance/arkansasCandidateFinanceBatchSync.js";
import type { ArkansasCandidateFinanceDueRow } from "../../../src/pipeline/arkansasFinance/arkansasCandidateFinanceDueList.js";

const NOW = new Date("2026-09-02T12:00:00Z");

function dueRow(overrides: Partial<ArkansasCandidateFinanceDueRow> = {}): ArkansasCandidateFinanceDueRow {
  return {
    candidateId: "11111111-1111-4111-8111-111111111111",
    electionId: "22222222-2222-4222-8222-222222222222",
    candidateName: "Jane Doe",
    electionYear: 2026,
    officeScope: "state_lower",
    officeName: "State Lower Chamber Legislator",
    district: "State House District 59",
    filingEntityId: 7968,
    filerName: "Doe, Jane A.",
    linkSource: "cfis_registration",
    sourceUrl: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

describe("syncDueArkansasCandidateFinance", () => {
  it("auto-links, lists due rows, and syncs each with one shared registry loader", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const autoLinkFn = vi.fn(async () => []);
    const rows = [dueRow(), dueRow({ candidateId: "44444444-4444-4444-8444-444444444444", candidateName: "Rick Roe", filingEntityId: 7526, filerName: "Roe, Rick" })];
    const listDueRowsFn = vi.fn(async () => ({ rows, totalDueRows: 5 }));
    const syncCandidateFn = vi.fn(async (input: { link: { filingEntityId: number } }) => {
      if (input.link.filingEntityId === 7526) throw new Error("Arkansas CFIS carries entity 7526 2 times for the 2026 cycle");
      return { summaryWritten: true } as never;
    });
    const log = vi.fn();

    const result = await syncDueArkansasCandidateFinance({
      db: db as never,
      now: NOW,
      maxCandidates: 2,
      autoLinkFn,
      listDueRowsFn,
      syncCandidateFn,
      log,
    });

    expect(autoLinkFn).toHaveBeenCalledWith(
      expect.objectContaining({ now: NOW, maxCandidates: 2, electionLookbackDays: 100, electionLookaheadDays: 730 })
    );
    expect(listDueRowsFn).toHaveBeenCalledWith(db, {
      now: NOW,
      staleAfterDays: 7,
      maxCandidates: 2,
      electionLookbackDays: 100,
      electionLookaheadDays: 730,
    });
    const sharedLoader = autoLinkFn.mock.calls[0]![0].loadRegistrations;
    expect(typeof sharedLoader).toBe("function");
    expect(syncCandidateFn).toHaveBeenCalledTimes(2);
    for (const call of syncCandidateFn.mock.calls) {
      expect((call[0] as { loadRegistrations: unknown }).loadRegistrations).toBe(sharedLoader);
    }
    expect(syncCandidateFn.mock.calls[0]![0]).toMatchObject({
      candidateId: rows[0]!.candidateId,
      electionYear: 2026,
      officeName: "State Lower Chamber Legislator",
      district: "State House District 59",
      link: { filingEntityId: 7968, filerName: "Doe, Jane A.", linkSource: "cfis_registration", sourceUrl: null },
      dryRun: false,
      now: NOW,
    });
    expect(result).toMatchObject({ dryRun: false, totalDueRows: 5, attempted: 2, succeeded: 1, failed: 1 });
    expect(result.candidates[1]).toMatchObject({ ok: false, error: expect.stringContaining("2 times") });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Rick Roe (filer entity 7526)"));
  });

  it("skips auto-link on dry run or when disabled and survives an auto-link failure", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const listDueRowsFn = vi.fn(async () => ({ rows: [], totalDueRows: 0 }));
    const autoLinkFn = vi.fn(async () => {
      throw new Error("sweep failed");
    });
    const log = vi.fn();

    const dry = await syncDueArkansasCandidateFinance({ db: db as never, dryRun: true, autoLinkFn, listDueRowsFn, log });
    expect(dry).toMatchObject({ dryRun: true, autoLinkResults: [], attempted: 0 });
    expect(autoLinkFn).not.toHaveBeenCalled();

    await syncDueArkansasCandidateFinance({ db: db as never, autoLinkMissingLinks: false, autoLinkFn, listDueRowsFn, log });
    expect(autoLinkFn).not.toHaveBeenCalled();

    const live = await syncDueArkansasCandidateFinance({ db: db as never, autoLinkFn, listDueRowsFn, log });
    expect(autoLinkFn).toHaveBeenCalledTimes(1);
    expect(live.autoLinkResults).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("auto-link pass failed"));
  });

  it("refreshes scoped candidates before limiting and skips unrelated auto-link writes", async () => {
    const target = dueRow({ candidateId: "44444444-4444-4444-8444-444444444444", filingEntityId: 7243,
      lastSyncedAt: "2026-09-02T11:59:00Z" });
    const db = { query: vi.fn(), connect: vi.fn() };
    const autoLinkFn = vi.fn();
    const listDueRowsFn = vi.fn(async () => ({ rows: [dueRow(), target, dueRow({ electionYear: 2028 })], totalDueRows: 3 }));
    const syncCandidateFn = vi.fn(async () => ({ summaryWritten: true } as never));
    const result = await syncDueArkansasCandidateFinance({ db: db as never, now: NOW, refresh: true,
      candidateId: target.candidateId.toUpperCase(), electionYear: 2026, maxCandidates: 1,
      autoLinkFn, listDueRowsFn, syncCandidateFn });
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(listDueRowsFn).toHaveBeenCalledWith(db, expect.objectContaining({
      now: NOW, staleAfterDays: 0, maxCandidates: 10000,
    }));
    expect(syncCandidateFn).toHaveBeenCalledTimes(1);
    expect(syncCandidateFn).toHaveBeenCalledWith(expect.objectContaining({ candidateId: target.candidateId, now: NOW }));
    expect(result).toMatchObject({ totalDueRows: 1, attempted: 1, succeeded: 1, failed: 0 });
  });

  it("rejects truncated scoped lists before syncing or changing links", async () => {
    const autoLinkFn = vi.fn();
    const syncCandidateFn = vi.fn();
    await expect(syncDueArkansasCandidateFinance({ db: { query: vi.fn(), connect: vi.fn() } as never,
      electionYear: 2026, autoLinkFn, syncCandidateFn,
      listDueRowsFn: vi.fn(async () => ({ rows: [dueRow()], totalDueRows: 10001 })),
    })).rejects.toThrow("complete-row bound");
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(syncCandidateFn).not.toHaveBeenCalled();
  });

  it("prepares closed independent source components before writes and preserves unavailable evidence", async () => {
    const events: string[] = [], rows = [dueRow(), dueRow({ candidateId: "44444444-4444-4444-8444-444444444444", filingEntityId: 7243 })];
    const query = vi.fn(async () => ({ rows: [] }));
    const loadIndependentSpending = vi.fn(async () => {
      events.push("outside-closed");
      return { scope: "current_original_ief_reports" as const, attemptedRegistrationGuids: [],
        unverifiedRegistrationGuids: [], diagnostics: ["outside source unavailable"] };
    });
    const loadCandidate = vi.fn(async ({ link }: { link: { candidateId: string } }) => {
      events.push(`pac-closed:${link.candidateId}`);
      return { diagnostics: ["PAC source unavailable"] };
    });
    const loadCandidateIdentity = vi.fn(async () => ({ diagnostics: [] }));
    const syncCandidateFn = vi.fn(async input => {
      expect(events.slice(0, 3)).toEqual(["outside-closed", `pac-closed:${rows[0]!.candidateId}`, `pac-closed:${rows[1]!.candidateId}`]);
      events.push("write");
      expect(input.verifiedFinance).toEqual({ pacDonors: undefined, pacSourceProvenance: undefined,
        outsideEvidence: [], diagnostics: ["PAC source unavailable", "outside source unavailable"] });
      return { summaryWritten: true } as never;
    });
    const result = await syncDueArkansasCandidateFinance({ db: { query, connect: vi.fn() } as never, now: NOW,
      autoLinkMissingLinks: false, maxCandidates: 2, listDueRowsFn: vi.fn(async () => ({ rows, totalDueRows: 2 })),
      syncCandidateFn, verifiedFinanceLoader: { loadCandidate, loadIndependentSpending, loadCandidateIdentity } });
    expect(loadIndependentSpending).toHaveBeenCalledTimes(1);
    expect(loadCandidate).toHaveBeenCalledTimes(2);
    expect(loadCandidateIdentity).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 2, succeeded: 2, failed: 0 });
    expect(query.mock.calls).toHaveLength(1);
  });
});
