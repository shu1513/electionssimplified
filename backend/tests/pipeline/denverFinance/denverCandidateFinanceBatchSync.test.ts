import { describe, expect, it, vi } from "vitest";

import { syncDueDenverCandidateFinance } from "../../../src/pipeline/denverFinance/denverCandidateFinanceBatchSync.js";

const REGISTRANT_LIST = [
  {
    fullName: "Shontel Lewis",
    firstName: "Shontel",
    middleName: null,
    lastName: "Lewis",
    officeSoughtId: 7,
    officeSought: "City Council At-Large Seat B",
    district: null,
    committeeId: 900,
    filerId: 658,
  },
];

function dueRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "c1",
    election_id: "e1",
    candidate_name: "Shontel Lewis",
    election_year: 2026,
    office_scope: "place",
    office_name: "City Council Member",
    district: null,
    filer_id: "658",
    committee_name: "Lewis for Denver",
    source_url: "https://denver.maplight.com",
    last_synced_at: null,
    total_due_rows: "1",
    ...over,
  };
}

function makeDb(input: {
  dueRows: Record<string, unknown>[];
  electionDates?: Array<{ id: string; election_date: string }>;
}) {
  const sqlLog: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqlLog.push(sql);
    if (sql.includes("due AS (")) return { rows: input.dueRows };
    if (sql.includes("election_date::text election_date FROM public.elections"))
      return {
        rows: input.electionDates ?? [
          { id: "e1", election_date: "2026-11-03" },
        ],
      };
    // Auto-link selector / roster reads — none of these tests exercise them.
    return { rows: [] };
  });
  return { db: { query, connect: vi.fn() } as never, sqlLog, query };
}

const registrantFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("GetCandidatesByElectionCycle"))
    return new Response(JSON.stringify(REGISTRANT_LIST), { status: 200 });
  throw new Error(`Unexpected URL in batch test fetch: ${url}`);
});

describe("syncDueDenverCandidateFinance", () => {
  it("binds due candidates to cycle 36 by election date and passes link facts through", async () => {
    const { db } = makeDb({ dueRows: [dueRow()] });
    const syncFn = vi.fn(async () => ({ written: false }) as never);
    const result = await syncDueDenverCandidateFinance({
      db,
      now: new Date("2026-09-15T12:00:00Z"),
      dryRun: true,
      clientOptions: { fetchImpl: registrantFetch as never },
      syncFn,
    });
    expect(result.syncedCandidateCount).toBe(1);
    expect(result.dueCandidateCount).toBe(1);
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "c1",
        electionId: "e1",
        electionYear: 2026,
        candidateDisplayName: "Shontel Lewis",
        officeName: "City Council Member",
        filerId: 658,
        committeeName: "Lewis for Denver",
        electionCycleId: 36,
        cycleRegistrants: REGISTRANT_LIST,
        dryRun: true,
      }),
    );
  });

  it("skips (never guesses) an election date outside the cycle map", async () => {
    const { db } = makeDb({
      dueRows: [dueRow({ election_id: "e2" })],
      electionDates: [{ id: "e2", election_date: "2027-04-06" }],
    });
    const syncFn = vi.fn();
    const result = await syncDueDenverCandidateFinance({
      db,
      dryRun: true,
      syncFn: syncFn as never,
    });
    expect(syncFn).not.toHaveBeenCalled();
    expect(result.skippedCandidateCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      status: "skipped",
      reason: "no SearchLight cycle mapping for election date 2027-04-06",
    });
  });

  it("isolates a per-candidate sync failure", async () => {
    const { db } = makeDb({
      dueRows: [
        dueRow(),
        dueRow({ candidate_id: "c2", filer_id: "777", total_due_rows: "2" }),
      ],
    });
    const syncFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("composition failed"))
      .mockResolvedValueOnce({ written: false } as never);
    const result = await syncDueDenverCandidateFinance({
      db,
      dryRun: true,
      clientOptions: { fetchImpl: registrantFetch as never },
      syncFn: syncFn as never,
    });
    expect(result.failedCandidateCount).toBe(1);
    expect(result.syncedCandidateCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      reason: "composition failed",
    });
  });

  it("aborts the batch on a corrupt due-list filer id", async () => {
    const { db } = makeDb({ dueRows: [dueRow({ filer_id: "Ind787" })] });
    await expect(
      syncDueDenverCandidateFinance({ db, dryRun: true }),
    ).rejects.toThrow(/Invalid Denver due-list filer id: Ind787/);
  });

  // The missing-links selector is the only query with this NOT EXISTS guard
  // (the shared due list joins candidate_elections too, so that name is not
  // a discriminator).
  const AUTO_LINK_SELECTOR_MARKER =
    "NOT EXISTS (SELECT 1 FROM public.denver_candidate_finance_links";

  it("skips the auto-link leg on dry runs", async () => {
    const { db, sqlLog } = makeDb({ dueRows: [] });
    await syncDueDenverCandidateFinance({ db, dryRun: true });
    expect(sqlLog.some((sql) => sql.includes(AUTO_LINK_SELECTOR_MARKER))).toBe(
      false,
    );
  });

  it("runs the auto-link selector on real runs", async () => {
    const { db, sqlLog } = makeDb({ dueRows: [] });
    const result = await syncDueDenverCandidateFinance({ db });
    // Auto-link failures are swallowed into autoLinkError — assert the leg
    // completed, not just that its selector SQL was issued.
    expect(result.autoLinkError).toBeNull();
    expect(sqlLog.some((sql) => sql.includes(AUTO_LINK_SELECTOR_MARKER))).toBe(
      true,
    );
  });
});
