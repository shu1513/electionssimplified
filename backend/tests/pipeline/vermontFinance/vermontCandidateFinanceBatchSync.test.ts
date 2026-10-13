import { describe, expect, it, vi } from "vitest";

import {
  listDueVermontCandidateFinanceSyncRows,
  syncDueVermontCandidateFinance,
} from "../../../src/pipeline/vermontFinance/vermontCandidateFinanceBatchSync.js";
import type { VermontCandidateFinanceSyncResult } from "../../../src/pipeline/vermontFinance/vermontCandidateFinanceSync.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SOURCE_URL = "https://campaignfinance.vermont.gov/";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Phil Scott",
    election_year: 2024,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    filer_registration_guid: "candidate-guid",
    entity_id: 33545,
    filer_name: "SCOTT, PHIL",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function successfulSync(): VermontCandidateFinanceSyncResult {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2024,
    dryRun: false,
    resolution: {
      status: "matched",
      filerRegistrationGuid: "candidate-guid",
      filerName: "SCOTT, PHIL",
      candidateName: null,
      officeId: 19,
      officeName: "Governor",
      officeDisplayName: "Governor",
      electionYear: 2024,
      electionId: 35,
      entityId: 33545,
      reportName: null,
      confidence: "exact",
      source: "vermont_public_transactions",
      sourceUrl: SOURCE_URL,
      matchedTransactionRowCount: 1,
    },
    linkWritten: true,
    summaryWritten: true,
    directBreakdownsWritten: 1,
    outsideGroupsWritten: 1,
    outsideGroupBreakdownsWritten: 2,
    totalReceipts: 100,
    directContributionTotal: 100,
    outsideSupportTotal: 1000,
    outsideOpposeTotal: 0,
    matchedContributionRowCount: 1,
    includedContributionRowCount: 1,
    skippedContributionRowCount: 0,
    matchedExpenditureRowCount: 1,
    includedExpenditureRowCount: 1,
    skippedExpenditureRowCount: 0,
    matchedOutsideContributionRowCount: 1,
    includedOutsideContributionRowCount: 1,
    skippedOutsideContributionRowCount: 0,
    fetchedContributionRowCount: 1,
    fetchedExpenditureRowCount: 1,
    fetchedOutsideContributionRowCount: 1,
  };
}

describe("vermontCandidateFinanceBatchSync", () => {
  it("lists active Vermont finance links that are due for sync", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "Jane Doe",
            election_year: 2026,
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "Washington-1",
            filer_registration_guid: "candidate-guid-2",
            entity_id: null,
            filer_name: "DOE, JANE",
            source_url: null,
            last_synced_at: "2026-01-01 00:00:00+00",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
    };

    await expect(
      listDueVermontCandidateFinanceSyncRows(db, {
        now: NOW,
        staleAfterDays: 7,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      }),
    ).resolves.toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Phil Scott",
          electionYear: 2024,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          filerRegistrationGuid: "candidate-guid",
          entityId: 33545,
          filerName: "SCOTT, PHIL",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          district: "Washington-1",
          filerRegistrationGuid: "candidate-guid-2",
          entityId: null,
          filerName: "DOE, JANE",
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.vt_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'VT'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain(
      "candidate_election.status NOT IN ('withdrawn', 'lost')",
    );
    expect(sql).toContain(
      "(office.scope || '::' || office.canonical_name) = ANY($6::text[])",
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining([
        "statewide::Governor",
        "state_upper::State Senator",
        "state_lower::State Lower Chamber Legislator",
      ]),
    ]);
  });

  it("syncs selected due candidates with trusted Vermont filer identities and continues after failure", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "Jane Doe",
            filer_registration_guid: "candidate-guid-2",
            filer_name: "DOE, JANE",
            source_url: null,
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
      connect: vi.fn(),
    };
    const syncVermontCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce(successfulSync())
      .mockRejectedValueOnce(new Error("Vermont API unavailable"));

    const result = await syncDueVermontCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      syncVermontCandidateFinanceFn: syncVermontCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      dryRun: false,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(result.results[0]).toMatchObject({
      ok: true,
      result: successfulSync(),
    });
    expect(result.results[1]).toMatchObject({
      ok: false,
      error: "Vermont API unavailable",
    });
    expect(syncVermontCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Phil Scott",
        electionYear: 2024,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
        sourceUrl: SOURCE_URL,
        trustedCommittee: {
          filerRegistrationGuid: "candidate-guid",
          filerName: "SCOTT, PHIL",
          entityId: 33545,
          sourceUrl: SOURCE_URL,
        },
        dryRun: false,
        now: NOW,
      }),
    );
  });

  it("auto-links unlinked candidates by running the self-resolving sync for them", async () => {
    const db = {
      query: vi
        .fn()
        // 1: missing-links enumeration
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Phil Scott",
              election_year: 2024,
              office_scope: "statewide",
              office_name: "Governor",
              district: null,
            },
          ],
        })
        // 2: due query (freshly-synced candidate is no longer due)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
    };
    const syncVermontCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce(successfulSync());

    const result = await syncDueVermontCandidateFinance({
      db,
      now: NOW,
      syncVermontCandidateFinanceFn: syncVermontCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
      autoLinkFailedCount: 0,
      dueCandidateCount: 0,
      // Due-sync counters stay internally consistent with `results`; the
      // auto-link sync is reported via autoLinkResults instead.
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
    });
    expect(result.results).toHaveLength(0);
    expect(result.autoLinkResults[0]).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      filerRegistrationGuid: "candidate-guid",
      ok: true,
    });
    // The sync must run WITHOUT a trustedCommittee so it live-resolves and
    // writes the link itself.
    const syncArgs = syncVermontCandidateFinanceFn.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(syncArgs.trustedCommittee).toBeUndefined();
    expect(syncArgs).toMatchObject({
      candidateId: CANDIDATE_ID,
      candidateName: "Phil Scott",
      officeScope: "statewide",
      officeName: "Governor",
    });
    // Enumeration is uncapped (no maxCandidates parameter).
    const enumerationParams = db.query.mock.calls[0]?.[1] as unknown[];
    expect(enumerationParams).toHaveLength(4);
    const enumerationSql = String(db.query.mock.calls[0]?.[0]);
    expect(enumerationSql).toContain("NOT EXISTS");
    expect(enumerationSql).toContain("district.state = 'VT'");
    expect(enumerationSql).not.toContain("LIMIT");
    // Auto-link is restricted to statewide offices: Vermont transactions have
    // no district data, so same-name legislative candidates in different
    // districts cannot be disambiguated.
    const officeKeys = enumerationParams[3] as string[];
    expect(officeKeys.length).toBeGreaterThan(0);
    expect(officeKeys.every((key) => key.startsWith("statewide::"))).toBe(true);
  });

  it("counts auto-link exceptions in autoLinkFailedCount without touching due-sync counters", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Phil Scott",
              election_year: 2024,
              office_scope: "statewide",
              office_name: "Governor",
              district: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
    };
    const syncVermontCandidateFinanceFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Vermont API unavailable"));

    const result = await syncDueVermontCandidateFinance({
      db,
      now: NOW,
      syncVermontCandidateFinanceFn: syncVermontCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 0,
      autoLinkFailedCount: 1,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
    });
    expect(result.autoLinkResults[0]).toMatchObject({
      candidateId: CANDIDATE_ID,
      ok: false,
      error: "Vermont API unavailable",
    });
  });

  it("uses one post-election grace day by default", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(),
    };
    const syncVermontCandidateFinanceFn = vi.fn();

    await syncDueVermontCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      syncVermontCandidateFinanceFn: syncVermontCandidateFinanceFn as never,
    });

    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.any(Array),
    ]);
    expect(syncVermontCandidateFinanceFn).not.toHaveBeenCalled();
  });
});

describe("Vermont opt-in committee cash batch", () => {
  it("uses PAC marker freshness and explicit scope before LIMIT; never invokes legacy or auto-link", async () => {
    const query = vi.fn(async () => ({
      rows: [dueRow({ election_year: 2026 })],
    }));
    const connect = vi.fn();
    const legacy = vi.fn();
    const cash = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      dryRun: false,
      written: true,
      status: "qualified" as const,
      diagnostics: [],
    }));
    const result = await syncDueVermontCandidateFinance({
      db: { query, connect } as never,
      now: NOW,
      committeeCashOnly: true,
      candidateId: CANDIDATE_ID,
      refresh: true,
      syncVermontCandidateFinanceFn: legacy,
      syncVermontCommitteeCashFn: cash,
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]! as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("source.observed_at");
    expect(sql).not.toContain("vt_candidate_finance_summaries");
    expect(sql.indexOf("link.candidate_id=$7::uuid")).toBeLessThan(
      sql.indexOf("LIMIT $3"),
    );
    expect(sql).toContain("election.election_stage='general'");
    expect(sql).toContain("ce.status='declared'");
    expect(params[6]).toBe(CANDIDATE_ID);
    expect(params[7]).toBe(true);
    expect(result).toMatchObject({
      syncedCandidateCount: 1,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(result.results[0]).toHaveProperty("committeeCashResult");
    expect(result.results[0]).not.toHaveProperty("result");
  });
  it("retains cash-only mode and source callbacks across caller mutation", async () => {
    const query = vi.fn(async () => ({
      rows: [
        dueRow(),
        dueRow({ candidate_id: "33333333-3333-4333-8333-333333333333" }),
      ],
    }));
    const legacy = vi.fn(),
      originalFetch = vi.fn() as unknown as typeof fetch;
    const replacementCash = vi.fn(),
      replacementCapture = vi.fn();
    let input: Parameters<typeof syncDueVermontCandidateFinance>[0];
    const originalCapture = vi.fn(() => {
      input.committeeCashOnly = false;
      input.syncVermontCandidateFinanceFn = legacy;
      input.syncVermontCommitteeCashFn = replacementCash;
      input.committeeCashOnCapture = replacementCapture;
      input.vermontClientOptions!.timeoutMs = 1;
      input.now!.setUTCFullYear(2000);
    });
    const cash = vi.fn(
      async (
        args: Parameters<
          NonNullable<
            Parameters<
              typeof syncDueVermontCandidateFinance
            >[0]["syncVermontCommitteeCashFn"]
          >
        >[0],
      ) => {
        await args.onCapture?.({
          url: "https://api.campaignfinance.vermont.gov/api/test",
          method: "POST",
          requestFields: {},
          httpStatus: 200,
          startedAt: "2026-06-01T00:00:00Z",
          completedAt: "2026-06-01T00:00:01Z",
          sha256: "a".repeat(64),
          byteCount: 0,
          body: new Uint8Array(),
        });
        return {
          candidateId: args.candidateId,
          electionId: args.electionId,
          dryRun: false,
          written: true,
          status: "qualified" as const,
          diagnostics: [],
        };
      },
    );
    input = {
      db: { query, connect: vi.fn() } as never,
      now: new Date(NOW),
      committeeCashOnly: true,
      committeeCashOnCapture: originalCapture,
      syncVermontCommitteeCashFn: cash,
      syncVermontCandidateFinanceFn: legacy,
      vermontClientOptions: { fetchImpl: originalFetch, timeoutMs: 90000 },
    };
    const result = await syncDueVermontCandidateFinance(input);
    expect(cash).toHaveBeenCalledTimes(2);
    expect(legacy).not.toHaveBeenCalled();
    expect(replacementCash).not.toHaveBeenCalled();
    expect(originalCapture).toHaveBeenCalledTimes(2);
    expect(replacementCapture).not.toHaveBeenCalled();
    expect(cash.mock.calls[1]![0].clientOptions).toEqual({
      fetchImpl: originalFetch,
      timeoutMs: 90000,
    });
    expect(result.now).toBe(NOW.toISOString());
  });
  it("held cash proof remains failed/preserved without legacy fallback", async () => {
    const query = vi.fn(async () => ({ rows: [dueRow()] }));
    const legacy = vi.fn();
    const cash = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      dryRun: false,
      written: false,
      status: "held" as const,
      diagnostics: ["Unknown report"],
    }));
    const result = await syncDueVermontCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: NOW,
      committeeCashOnly: true,
      syncVermontCandidateFinanceFn: legacy,
      syncVermontCommitteeCashFn: cash,
    });
    expect(result).toMatchObject({
      failedCandidateCount: 1,
      syncedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(result.results[0]?.error).toBe("Unknown report");
  });
  it("cash dry run uses the same isolated acquisition path", async () => {
    const query = vi.fn(async () => ({ rows: [dueRow()] }));
    const legacy = vi.fn();
    const cash = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      dryRun: true,
      written: false,
      status: "qualified" as const,
      diagnostics: [],
    }));
    await syncDueVermontCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: NOW,
      committeeCashOnly: true,
      dryRun: true,
      syncVermontCandidateFinanceFn: legacy,
      syncVermontCommitteeCashFn: cash,
    });
    expect(cash.mock.calls[0]![0]).toMatchObject({ dryRun: true });
    expect(legacy).not.toHaveBeenCalled();
  });
});
