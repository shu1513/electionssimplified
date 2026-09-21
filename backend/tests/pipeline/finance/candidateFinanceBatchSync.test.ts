import { describe, expect, it, vi } from "vitest";

import {
  listDueCandidateFinanceSyncRows,
  syncDueCandidateFinance,
} from "../../../src/pipeline/finance/candidateFinanceBatchSync.js";

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe("candidateFinanceBatchSync", () => {
  it("lists due finance sync rows with conservative federal and presidential filters", async () => {
    const db = createMockDb([
      {
        candidate_id: "11111111-1111-4111-8111-111111111111",
        fec_candidate_id: "S4CA00001",
        election_year: 2024,
        source: "candidate_election",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        fec_candidate_id: "P80001571",
        election_year: 2024,
        source: "presidential_cycle",
        last_synced_at: "2026-01-01 00:00:00+00",
        total_due_rows: "2",
      },
    ]);

    const result = await listDueCandidateFinanceSyncRows(db, {
      now: new Date("2026-06-01T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 30,
      electionLookaheadDays: 730,
    });

    expect(result).toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: "11111111-1111-4111-8111-111111111111",
          fecCandidateId: "S4CA00001",
          electionYear: 2024,
          source: "candidate_election",
          lastSyncedAt: null,
        },
        {
          candidateId: "22222222-2222-4222-8222-222222222222",
          fecCandidateId: "P80001571",
          electionYear: 2024,
          source: "presidential_cycle",
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });
    expect(String(db.query.mock.calls[0]?.[0])).toContain("office.canonical_name = 'United States Senator'");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("office.canonical_name = 'United States Representative'");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.presidential_cycle_candidates");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("general_cycle.election_date");
    expect(String(db.query.mock.calls[0]?.[0])).toContain(">= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      30,
      730,
      false,
    ]);
  });

  it("uses a one-day post-election grace window by default for due selection", async () => {
    const db = createMockDb();

    await syncDueCandidateFinance({
      db,
      openFecOptions: { apiKeys: ["k1"], timeoutMs: 1000 },
      syncCandidateFinanceFn: vi.fn(),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "e.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      false,
    ]);
  });

  it("syncs selected due candidates and continues after individual failures", async () => {
    const db = createMockDb([
      {
        candidate_id: "11111111-1111-4111-8111-111111111111",
        fec_candidate_id: "S4CA00001",
        election_year: 2024,
        source: "candidate_election",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        fec_candidate_id: "P80001571",
        election_year: 2024,
        source: "presidential_cycle",
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const syncCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce({
        fecCandidateId: "S4CA00001",
        electionYear: 2024,
        dryRun: false,
        directCommitteeCount: 1,
        summaryWritten: true,
        directBreakdownsWritten: 1,
        industryBreakdownsWritten: 0,
        classificationsWritten: 0,
        outsideIncluded: true,
        outsideGroupsWritten: 0,
        outsideGroupBreakdownsWritten: 0,
        outsideSupportTotal: null,
        outsideOpposeTotal: null,
      })
      .mockRejectedValueOnce(new Error("OpenFEC unavailable"));

    const result = await syncDueCandidateFinance({
      db,
      openFecOptions: { apiKeys: ["k1"], timeoutMs: 1000 },
      syncCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      includeOutside: true,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      perPage: 10,
      outsideGroupLimit: 5,
    });

    expect(result).toMatchObject({
      dryRun: false,
      includeOutside: true,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({ ok: true, fecCandidateId: "S4CA00001" });
    expect(result.results[1]).toMatchObject({
      ok: false,
      fecCandidateId: "P80001571",
      error: "OpenFEC unavailable",
    });
    expect(syncCandidateFinanceFn).toHaveBeenCalledTimes(2);
    expect(syncCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        fecCandidateId: "S4CA00001",
        electionYear: 2024,
        includeOutside: true,
        perPage: 10,
        outsideGroupLimit: 5,
      })
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      3,
      2,
      30,
      730,
      false,
    ]);
  });

  it("refreshes donor and conduit lists for every candidate in the window, not only the due ones", async () => {
    const db = createMockDb([
      {
        candidate_id: "11111111-1111-4111-8111-111111111111",
        fec_candidate_id: "S4CA00001",
        election_year: 2026,
        source: "candidate_election",
        last_synced_at: "2026-05-31 00:00:00+00",
        total_due_rows: "2",
      },
      {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        fec_candidate_id: "H4CA00002",
        election_year: 2026,
        source: "candidate_election",
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const syncCandidateFinanceFn = vi.fn();
    const contributorResult = { dryRun: false, candidateCount: 1, candidatesWithPacDonors: 1, candidatesWithConduits: 0, results: [] };
    const syncCandidateFinanceContributorsFn = vi.fn().mockResolvedValue(contributorResult);

    const result = await syncDueCandidateFinance({
      db,
      openFecOptions: { apiKeys: [] },
      now: new Date("2026-06-01T00:00:00.000Z"),
      contributorsOnly: true,
      contributorCandidateIds: ["h4ca00002"],
      bulkDataDirectory: "/tmp/fec-bulk",
      syncCandidateFinanceFn,
      syncCandidateFinanceContributorsFn,
    });

    // No OpenFEC API sync in a contributors-only run.
    expect(syncCandidateFinanceFn).not.toHaveBeenCalled();
    // The second listing ignores staleness so recently synced candidates are covered too.
    expect(db.query.mock.calls[1]?.[1]?.[5]).toBe(true);
    expect(syncCandidateFinanceContributorsFn).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ fecCandidateId: "H4CA00002", electionYear: 2026 }],
        bulkDataDirectory: "/tmp/fec-bulk",
        dryRun: false,
      })
    );
    expect(result.contributors).toEqual(contributorResult);
    expect(result.results).toEqual([]);
  });

  it("rejects invalid batch options before querying", async () => {
    const db = createMockDb();

    await expect(
      syncDueCandidateFinance({
        db,
        openFecOptions: { apiKeys: ["k1"] },
        maxCandidates: 0,
      })
    ).rejects.toThrow("Invalid candidate finance batch sync maxCandidates");
    expect(db.query).not.toHaveBeenCalled();
  });
});
