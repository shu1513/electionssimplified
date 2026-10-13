import { describe, expect, it, vi } from "vitest";

import {
  listDueNewYorkCandidateFinanceSyncRows,
  syncDueNewYorkCandidateFinance,
} from "../../../src/pipeline/newYorkFinance/newYorkCandidateFinanceBatchSync.js";
import { autoLinkNewYorkCandidateFinanceForCandidateElection } from "../../../src/pipeline/newYorkFinance/newYorkCandidateFinanceAutoLink.js";

const NOW = new Date("2026-07-11T12:00:00.000Z");

const DUE_ROW = {
  candidate_id: "11111111-1111-1111-1111-111111111111",
  election_id: "22222222-2222-2222-2222-222222222222",
  candidate_name: "Kathy Hochul",
  election_year: 2026,
  office_scope: "statewide",
  office_name: "Governor",
  district: null,
  filer_id: "16851",
  filer_name: "Friends for Kathy Hochul",
  source_url: null,
  last_synced_at: null,
  total_due_rows: "1",
};

describe("listDueNewYorkCandidateFinanceSyncRows", () => {
  it("selects stale active NY links for eligible offices within the election window", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [DUE_ROW], rowCount: 1 }),
    };

    const due = await listDueNewYorkCandidateFinanceSyncRows(db, {
      now: NOW,
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 1,
      electionLookaheadDays: 730,
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).toContain("FROM public.ny_candidate_finance_links");
    expect(String(sql)).toContain("district.state = 'NY'");
    expect(String(sql)).toContain("link.link_status = 'active'");
    expect(params?.[5]).toContain("statewide::Governor");
    expect(params?.[5]).toContain(
      "state_lower::State Lower Chamber Legislator",
    );
    expect(due.totalDueRows).toBe(1);
    expect(due.rows[0]).toMatchObject({
      filerId: "16851",
      candidateName: "Kathy Hochul",
    });
  });
});

describe("syncDueNewYorkCandidateFinance", () => {
  it("scopes a refresh before LIMIT and avoids unrelated auto-linking", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [DUE_ROW], rowCount: 1 }),
      connect: vi.fn(),
    };
    const syncFn = vi.fn(async () => ({ ok: true }) as never);
    await syncDueNewYorkCandidateFinance({
      db,
      now: NOW,
      candidateId: DUE_ROW.candidate_id,
      electionYear: 2026,
      refresh: true,
      maxCandidates: 1,
      syncNewYorkCandidateFinanceFn: syncFn,
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain("candidate_id = $7");
    expect(params).toEqual([
      NOW.toISOString(),
      7,
      1,
      1,
      730,
      expect.any(Array),
      DUE_ROW.candidate_id,
      2026,
      true,
    ]);
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: DUE_ROW.candidate_id,
        electionYear: 2026,
      }),
    );
  });
  it("auto-links missing candidates then syncs due rows as trusted committees", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("FROM public.candidate_elections")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [DUE_ROW], rowCount: 1 };
      }),
      connect: vi.fn(),
    };
    const syncFn = vi.fn(async () => ({ ok: true }) as never);

    const result = await syncDueNewYorkCandidateFinance({
      db,
      now: NOW,
      syncNewYorkCandidateFinanceFn: syncFn,
      sodaClientOptions: {},
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateName: "Kathy Hochul",
        trustedCommittee: expect.objectContaining({ filerId: "16851" }),
      }),
    );
  });

  it("records failures per candidate without aborting the batch", async () => {
    const secondRow = {
      ...DUE_ROW,
      candidate_id: "44444444-4444-4444-4444-444444444444",
      filer_id: "999",
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("FROM public.candidate_elections")) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [DUE_ROW, { ...secondRow, total_due_rows: "2" }],
          rowCount: 2,
        };
      }),
      connect: vi.fn(),
    };
    const syncFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("SODA down"))
      .mockResolvedValueOnce({ ok: true } as never);

    const result = await syncDueNewYorkCandidateFinance({
      db,
      now: NOW,
      syncNewYorkCandidateFinanceFn: syncFn,
      sodaClientOptions: {},
      autoLinkMissingLinks: false,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(result.failedCandidateCount).toBe(1);
    expect(result.results[0]).toMatchObject({ ok: false, error: "SODA down" });
  });
});

describe("autoLinkNewYorkCandidateFinanceForCandidateElection", () => {
  it("links resolved committees and reports skips otherwise", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ id: "link-1" }], rowCount: 1 }),
    };
    const resolveCandidateCommittee = vi.fn(async () => ({
      status: "matched" as const,
      filerId: "16851",
      filerName: "Friends for Kathy Hochul",
      candidateFilerId: "27197",
      confidence: "exact" as const,
      source: "ny_soda_api" as const,
      sourceUrl: null,
    }));

    const linked = await autoLinkNewYorkCandidateFinanceForCandidateElection({
      db,
      now: NOW,
      candidateElection: {
        candidateId: "11111111-1111-1111-1111-111111111111",
        electionId: "22222222-2222-2222-2222-222222222222",
        candidateName: "Kathy Hochul",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
      },
      resolveCandidateCommittee,
    });

    expect(linked).toMatchObject({ status: "linked", filerId: "16851" });
    // First call retires other active links; second upserts the new one.
    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "SET link_status = 'inactive'",
    );
    expect(String(db.query.mock.calls[1]?.[0])).toContain(
      "INSERT INTO public.ny_candidate_finance_links",
    );
    // link_source records the automated path.
    expect(db.query.mock.calls[1]?.[1]).toContain("ny_soda_api");

    const ambiguousResolver = vi.fn(async () => ({
      status: "ambiguous" as const,
      reason: "multiple_matching_committees" as const,
      candidateNameNormalized: "KATHY HOCHUL",
      officeNameNormalized: "Governor",
      matches: [],
    }));
    const skipped = await autoLinkNewYorkCandidateFinanceForCandidateElection({
      db,
      now: NOW,
      candidateElection: {
        candidateId: "11111111-1111-1111-1111-111111111111",
        electionId: "22222222-2222-2222-2222-222222222222",
        candidateName: "Kathy Hochul",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
      },
      resolveCandidateCommittee: ambiguousResolver,
    });
    expect(skipped).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
    });
  });
});
