import { describe, expect, it, vi } from "vitest";

const reported = vi.hoisted(() => ({ sync: vi.fn(async () => undefined) }));
vi.mock("../../../src/pipeline/arizonaFinance/arizonaReportedBatchSync.js", () => ({
  syncDueArizonaReportedFinance: reported.sync,
}));

import {
  listDueArizonaCandidateFinanceSyncRows,
  syncDueArizonaCandidateFinance,
} from "../../../src/pipeline/arizonaFinance/arizonaCandidateFinanceBatchSync.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

describe("arizonaCandidateFinanceBatchSync", () => {
  it("lists due Arizona finance rows from active links", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          candidate_id: CANDIDATE_ID,
          election_id: ELECTION_ID,
          candidate_name: "Jane Arizonan",
          election_year: 2026,
          office_scope: "statewide",
          office_name: "Governor",
          district: null,
          committee_id: "AZ100",
          committee_name: "Jane Arizonan for Governor",
          link_source: "manual",
          source_url: "https://seethemoney.az.gov/Reporting/Explore",
          last_synced_at: null,
          total_due_rows: "1",
        },
      ],
    }));

    await expect(
      listDueArizonaCandidateFinanceSyncRows(
        { query },
        {
          now: new Date("2026-06-25T12:00:00.000Z"),
          staleAfterDays: 7,
          maxCandidates: 10,
          electionLookbackDays: 1,
          electionLookaheadDays: 365,
        }
      )
    ).resolves.toEqual({
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Jane Arizonan",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          committeeId: "AZ100",
          committeeName: "Jane Arizonan for Governor",
          linkSource: "manual",
          sourceUrl: "https://seethemoney.az.gov/Reporting/Explore",
          lastSyncedAt: null,
        },
      ],
      totalDueRows: 1,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("public.az_candidate_finance_links AS link");
    expect(String(query.mock.calls[0]?.[0])).toContain("public.az_candidate_finance_summaries AS summary");
  });

  it("syncs selected due rows with trusted committee data", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CANDIDATE_ID,
            election_id: ELECTION_ID,
            candidate_name: "Jane Arizonan",
            election_year: 2026,
            office_scope: "statewide",
            office_name: "Governor",
            district: null,
            committee_id: "AZ100",
            committee_name: "Jane Arizonan for Governor",
            link_source: "spotlight",
            source_url: null,
            last_synced_at: null,
            total_due_rows: "1",
          },
        ],
      });
    const syncArizonaCandidateFinanceFn = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: true,
      resolution: { status: "matched" as const, committeeId: "AZ100" },
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedIncomeTransactionCount: 1,
      includedIncomeTransactionCount: 1,
      skippedIncomeTransactionCount: 0,
      matchedIndependentExpenditureCount: 0,
      includedIndependentExpenditureCount: 0,
      skippedIndependentExpenditureCount: 0,
      matchedOutsideIncomeTransactionCount: 0,
      includedOutsideIncomeTransactionCount: 0,
      skippedOutsideIncomeTransactionCount: 0,
    }));

    const result = await syncDueArizonaCandidateFinance({
      db: { query },
      dryRun: true,
      now: new Date("2026-06-25T12:00:00.000Z"),
      syncArizonaCandidateFinanceFn,
    });

    expect(result).toMatchObject({
      dryRun: true,
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(syncArizonaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedCommittee: expect.objectContaining({
          committeeId: "AZ100",
          committeeName: "Jane Arizonan for Governor",
          linkSource: "spotlight",
        }),
        dryRun: true,
      })
    );
  });

  it("counts auto-link sync work in batch results and candidate budget", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CANDIDATE_ID,
            election_id: ELECTION_ID,
            candidate_name: "Jane Arizonan",
            election_year: 2026,
            office_scope: "statewide",
            office_name: "Governor",
            district: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const syncArizonaCandidateFinanceFn = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched" as const, committeeId: "AZ100", committeeName: "Jane Arizonan for Governor" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedIncomeTransactionCount: 1,
      includedIncomeTransactionCount: 1,
      skippedIncomeTransactionCount: 0,
      matchedIndependentExpenditureCount: 0,
      includedIndependentExpenditureCount: 0,
      skippedIndependentExpenditureCount: 0,
      matchedOutsideIncomeTransactionCount: 0,
      includedOutsideIncomeTransactionCount: 0,
      skippedOutsideIncomeTransactionCount: 0,
    }));

    const result = await syncDueArizonaCandidateFinance({
      db: { query },
      dryRun: false,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 1,
      syncArizonaCandidateFinanceFn,
    });

    expect(result).toMatchObject({
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
      results: [expect.objectContaining({ committeeId: "AZ100", ok: true })],
    });
    expect(query.mock.calls[1]?.[1]?.[2]).toBe(0);
  });

  it("continues legacy finance when the reported component batch rejects", async () => {
    reported.sync.mockRejectedValueOnce(new Error("Invalid Arizona reported batch option"));
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          candidate_id: CANDIDATE_ID,
          election_id: ELECTION_ID,
          candidate_name: "Jane Arizonan",
          election_year: 2026,
          office_scope: "statewide",
          office_name: "Governor",
          district: null,
          committee_id: "AZ100",
          committee_name: "Jane Arizonan for Governor",
          link_source: "spotlight",
          source_url: null,
          last_synced_at: null,
          total_due_rows: "1",
        },
      ],
    });
    const syncArizonaCandidateFinanceFn = vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: true,
      resolution: { status: "matched" as const, committeeId: "AZ100" },
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedIncomeTransactionCount: 1,
      includedIncomeTransactionCount: 1,
      skippedIncomeTransactionCount: 0,
      matchedIndependentExpenditureCount: 0,
      includedIndependentExpenditureCount: 0,
      skippedIndependentExpenditureCount: 0,
      matchedOutsideIncomeTransactionCount: 0,
      includedOutsideIncomeTransactionCount: 0,
      skippedOutsideIncomeTransactionCount: 0,
    }));

    const result = await syncDueArizonaCandidateFinance({
      db: { query } as any,
      dryRun: true,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 1001,
      syncArizonaCandidateFinanceFn,
    });

    expect(result.reportedFinance).toBeUndefined();
    expect(result.reportedFinanceError).toBe("Invalid Arizona reported batch option");
    expect(result).toMatchObject({ selectedCandidateCount: 1, syncedCandidateCount: 1, failedCandidateCount: 0 });
  });
});
