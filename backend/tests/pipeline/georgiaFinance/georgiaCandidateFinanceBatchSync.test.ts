import { describe, expect, it, vi } from "vitest";

import { syncDueGeorgiaCandidateFinance } from "../../../src/pipeline/georgiaFinance/georgiaCandidateFinanceBatchSync.js";
import type { GeorgiaCandidateFinanceSyncResult } from "../../../src/pipeline/georgiaFinance/georgiaCandidateFinanceSync.js";
import {
  GeorgiaEthicsClientError,
  type GeorgiaEthicsTransport,
  type GeorgiaIndependentExpenditureRow,
} from "../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js";

const NOW = new Date("2026-08-07T12:00:00Z");

const dummyTransport: GeorgiaEthicsTransport = {
  postJson: async () => {
    throw new Error("test must not touch the network");
  },
};

const IE_STORE_ROWS: GeorgiaIndependentExpenditureRow[] = [
  {
    guid: "ie-1",
    transactionId: 101,
    amountApplied: 1500,
    filerRegistrationGuid: "spender-a-guid",
    filerName: "Example PAC",
    filerReportGuid: "ie-r1",
    timedFiledReportGuid: null,
    filerReportVersionId: 1,
    transactionDate: "2026-02-01T00:00:00",
    transactionStatusCode: "TFIL",
    transactionTypeCode: "TIE",
    electionYear: 2026,
    candidateMeasures: [],
  },
];

function ieStoreFetcher() {
  return vi.fn(async () => ({
    rows: IE_STORE_ROWS,
    fetchedRowCount: IE_STORE_ROWS.length,
    duplicateRowCount: 0,
    passCount: 2,
  }));
}

function dueQueryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "candidate-1",
    election_id: "election-1",
    candidate_name: "Christopher Carr",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    committee_id: "100035",
    committee_name: "Carr for Georgia, Inc.",
    link_source: "peachfile_api",
    source_url: "https://ethics.ga.gov/records-search-all/",
    last_synced_at: null,
    total_due_rows: "2",
    ...overrides,
  };
}

function createMockDb(dueRows: Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("due AS (")) {
      return { rows: dueRows, rowCount: dueRows.length };
    }
    // Auto-link candidate-election listing: none missing.
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  return { query, connect: vi.fn().mockResolvedValue(client), client };
}

function syncResult(overrides: Partial<GeorgiaCandidateFinanceSyncResult> = {}): GeorgiaCandidateFinanceSyncResult {
  return {
    candidateId: "candidate-1",
    electionId: "election-1",
    electionYear: 2026,
    dryRun: false,
    committeeId: "100035",
    linkWritten: true,
    summaryWritten: true,
    directBreakdownsWritten: 3,
    outsideGroupsWritten: 1,
    outsideSupportTotal: 1500,
    outsideOpposeTotal: 0,
    totalReceipts: 3500,
    totalDisbursements: 1200,
    cashOnHand: 2300,
    syncedRowSum: 3500,
    uncoveredOfficialAmount: 0,
    reconciliationDifference: 0,
    reconciliationTolerance: 2500,
    reportInventorySize: 2,
    peachfile: {
      fetchedRowCount: 2,
      includedRowCount: 2,
      supersededRowCount: 0,
      unassignedRowCount: 0,
      windowFilterIneffectiveCount: 0,
      sweepOnlyRowCount: 0,
      sweepMissedRowCount: 0,
      filterIneffective: false,
    },
    aggregation: {
      syncedRowSum: 3500,
      totalRowCount: 2,
      bucketedRowCount: 2,
      occupationCoveredAmount: 3500,
      occupationUnknownAmount: 0,
      unitemizedAmount: 0,
      inKindAmount: 0,
      anonymousAmount: 0,
      returnedRowCount: 0,
      returnedAmount: 0,
      unpinnedSubTypeRowCount: 0,
      unpinnedSubTypeAmount: 0,
      unrecognizedStatusRowCount: 0,
      unrecognizedStatusAmount: 0,
    },
    outsideSpending: {
      supportTotal: 1500,
      opposeTotal: 0,
      storeRowCount: 1,
      candidateTargetRowCount: 1,
      attributedRowCount: 1,
      attributedAmount: 1500,
      multiTargetRowCount: 0,
      multiTargetAmount: 0,
      malformedRowCount: 0,
      malformedAmount: 0,
      unrecognizedStatusRowCount: 0,
      unrecognizedStatusAmount: 0,
    },
    outsideSpendingSkippedReason: null,
    outsideGroupBreakdownsWritten: 2,
    outsideFunders: {
      spenderCount: 1,
      unresolvedSpenderCount: 0,
      otherRegistrationRowCount: 0,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
      donorBreakdownCount: 1,
      industryBreakdownCount: 1,
    },
    outsideFundersSkippedReason: null,
    ...overrides,
  };
}

describe("syncDueGeorgiaCandidateFinance", () => {
  it("syncs every due row through the injected sync fn and passes the link identity through", async () => {
    const dueRows = [dueQueryRow(), dueQueryRow({ candidate_id: "candidate-2", committee_id: "100200", link_source: "manual" })];
    const db = createMockDb(dueRows);
    const syncFn = vi.fn(async () => syncResult());
    const fetchIeFn = ieStoreFetcher();
    const result = await syncDueGeorgiaCandidateFinance({
      db,
      transport: dummyTransport,
      now: NOW,
      syncGeorgiaCandidateFinanceFn: syncFn,
      fetchIndependentExpenditureRowsFn: fetchIeFn,
    });

    expect(result.dueCandidateCount).toBe(2);
    expect(result.selectedCandidateCount).toBe(2);
    expect(result.syncedCandidateCount).toBe(2);
    expect(result.failedCandidateCount).toBe(0);
    expect(syncFn).toHaveBeenCalledTimes(2);
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        transport: dummyTransport,
        candidateId: "candidate-1",
        committee: expect.objectContaining({ committeeId: "100035", linkSource: "peachfile_api" }),
      })
    );
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "candidate-2",
        committee: expect.objectContaining({ committeeId: "100200", linkSource: "manual" }),
      })
    );
    // The PeachFile IE store was pulled ONCE and shared with every sync call.
    expect(fetchIeFn).toHaveBeenCalledTimes(1);
    expect(fetchIeFn).toHaveBeenCalledWith(dummyTransport, "peachfile", { maxPasses: undefined });
    for (const call of syncFn.mock.calls) {
      expect((call as unknown[])[0]).toMatchObject({ independentExpenditureRows: IE_STORE_ROWS });
    }
    // Every sync call shares ONE spender-contribution cache, so a PAC funding
    // several candidates is pulled once per run.
    const caches = syncFn.mock.calls.map(
      (call) => ((call as unknown[])[0] as { spenderContributionCache?: unknown }).spenderContributionCache
    );
    expect(caches[0]).toBeInstanceOf(Map);
    expect(new Set(caches).size).toBe(1);
  });

  it("degrades to direct-only when the IE store pull fails with a client error, and rethrows bugs", async () => {
    const dueRows = [dueQueryRow(), dueQueryRow({ candidate_id: "candidate-2", committee_id: "100200" })];
    const db = createMockDb(dueRows);
    const syncFn = vi.fn(async () => syncResult({ outsideSpendingSkippedReason: "IE store unavailable" }));
    const failingFetch = vi.fn(async () => {
      throw new GeorgiaEthicsClientError("bad_response", "stable EMPTY store");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await syncDueGeorgiaCandidateFinance({
        db,
        transport: dummyTransport,
        now: NOW,
        syncGeorgiaCandidateFinanceFn: syncFn,
        fetchIndependentExpenditureRowsFn: failingFetch,
      });
      // Every candidate still synced, with the null sentinel so nobody
      // retries the dead fetch.
      expect(result.syncedCandidateCount).toBe(2);
      expect(result.independentExpenditureStoreError).toContain("stable EMPTY store");
      expect(failingFetch).toHaveBeenCalledTimes(1);
      for (const call of syncFn.mock.calls) {
        expect((call as unknown[])[0]).toMatchObject({ independentExpenditureRows: null });
      }
    } finally {
      warn.mockRestore();
    }

    // A non-client error is a bug and fails the batch.
    const buggyFetch = vi.fn(async () => {
      throw new TypeError("boom");
    });
    await expect(
      syncDueGeorgiaCandidateFinance({
        db: createMockDb(dueRows),
        transport: dummyTransport,
        now: NOW,
        syncGeorgiaCandidateFinanceFn: syncFn,
        fetchIndependentExpenditureRowsFn: buggyFetch,
      })
    ).rejects.toThrow("boom");
  });

  it("skips the IE store pull when nothing is due", async () => {
    const db = createMockDb([]);
    const syncFn = vi.fn(async () => syncResult());
    const fetchIeFn = ieStoreFetcher();
    const result = await syncDueGeorgiaCandidateFinance({
      db,
      transport: dummyTransport,
      now: NOW,
      dryRun: true,
      syncGeorgiaCandidateFinanceFn: syncFn,
      fetchIndependentExpenditureRowsFn: fetchIeFn,
    });
    expect(result.selectedCandidateCount).toBe(0);
    expect(fetchIeFn).not.toHaveBeenCalled();
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("isolates per-candidate failures and keeps going", async () => {
    const dueRows = [dueQueryRow(), dueQueryRow({ candidate_id: "candidate-2", committee_id: "100200" })];
    const db = createMockDb(dueRows);
    const syncFn = vi
      .fn(async () => syncResult())
      .mockRejectedValueOnce(new Error("reconciliation failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await syncDueGeorgiaCandidateFinance({
        db,
        transport: dummyTransport,
        now: NOW,
        syncGeorgiaCandidateFinanceFn: syncFn,
        fetchIndependentExpenditureRowsFn: ieStoreFetcher(),
      });
      expect(result.syncedCandidateCount).toBe(1);
      expect(result.failedCandidateCount).toBe(1);
      expect(result.results[0]).toMatchObject({ ok: false, error: "reconciliation failed" });
      expect(result.results[1]).toMatchObject({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("dry run skips auto-link and passes dryRun through", async () => {
    const db = createMockDb([dueQueryRow()]);
    const syncFn = vi.fn(async () => syncResult({ dryRun: true, linkWritten: false }));
    const result = await syncDueGeorgiaCandidateFinance({
      db,
      transport: dummyTransport,
      now: NOW,
      dryRun: true,
      syncGeorgiaCandidateFinanceFn: syncFn,
      fetchIndependentExpenditureRowsFn: ieStoreFetcher(),
    });
    expect(result.dryRun).toBe(true);
    expect(result.autoLinkAttemptedCount).toBe(0);
    expect(syncFn).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    // The only db call was the due list — auto-link never queried.
    const sqls = db.query.mock.calls.map(([sql]) => sql as string);
    expect(sqls.every((sql) => sql.includes("due AS ("))).toBe(true);
  });
});
