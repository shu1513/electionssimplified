import { describe, expect, it, vi } from "vitest";

import {
  listDueUtahCandidateFinanceSyncRows,
  syncDueUtahCandidateFinance,
} from "../../../src/pipeline/utahFinance/utahCandidateFinanceBatchSync.js";
import type { UtahCandidateFinanceSyncResult } from "../../../src/pipeline/utahFinance/utahCandidateFinanceSync.js";
import type { UtahDisclosuresTransactionRow } from "../../../src/pipeline/utahFinance/utahDisclosuresClient.js";

vi.mock("../../../src/pipeline/utahFinance/utahReportedIeSync.js", () => ({
  syncDueUtahReportedIe: vi.fn(async () => ({selected:0,accepted:0,written:0,held:0,unallocated:0,failures:[]})),
}));

vi.mock("../../../src/pipeline/utahFinance/utahCommitteeCashSync.js", () => ({
  syncDueUtahCommitteeCash: vi.fn(async () => ({due:0,selected:0,accepted:0,written:0,held:0,failures:[]})),
}));

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SOURCE_URL = "https://disclosures.utah.gov/Search/AdvancedSearch/FolderDetails/98765";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Jane Doe",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    folder_id: "98765",
    committee_name: "Friends of Jane Doe",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function transaction(overrides: Partial<UtahDisclosuresTransactionRow> = {}): UtahDisclosuresTransactionRow {
  return {
    entityType: "PCC",
    entityName: "Friends of Jane Doe",
    transactionId: "T1",
    transactionType: "Contribution",
    transactionDate: "01/02/2026",
    amount: 100,
    name: "John Smith",
    inKind: false,
    loan: false,
    ...overrides,
  };
}

function syncResult(overrides: Partial<UtahCandidateFinanceSyncResult> = {}): UtahCandidateFinanceSyncResult {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    dryRun: false,
    resolution: {
      status: "matched",
      folderId: "98765",
      committeeName: "Friends of Jane Doe",
      confidence: "exact",
      source: "disclosures_advanced_search",
      sourceUrl: SOURCE_URL,
      matchedEntityRowCount: 1,
    },
    linkWritten: true,
    summaryWritten: true,
    directBreakdownsWritten: 1,
    totalReceipts: 100,
    directContributionTotal: 100,
    totalDisbursements: 0,
    matchedTransactionRowCount: 1,
    includedContributionRowCount: 1,
    skippedTransactionRowCount: 0,
    supportingCommitteeCount: 0,
    supportingCommitteeIndustryCount: 0,
    supportingCommitteeMatchedTransactionRowCount: 0,
    supportingCommitteeIncludedOrganizationDonorRowCount: 0,
    supportingCommitteeSkippedTransactionRowCount: 0,
    ...overrides,
  };
}

describe("utahCandidateFinanceBatchSync", () => {
  it("lists active Utah finance links that are due for sync", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "John Public",
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "57",
            folder_id: "12345",
            committee_name: "John Public for House",
            source_url: null,
            last_synced_at: "2026-01-01 00:00:00+00",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
    };

    await expect(
      listDueUtahCandidateFinanceSyncRows(db, {
        now: NOW,
        staleAfterDays: 7,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          folderId: "98765",
          committeeName: "Friends of Jane Doe",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "John Public",
          electionYear: 2026,
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          district: "57",
          folderId: "12345",
          committeeName: "John Public for House",
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.ut_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'UT'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
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

  it("downloads candidate folder CSVs and one PAC CSV per year before syncing linked candidates", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [dueRow({ total_due_rows: "2" }), dueRow({ folder_id: "22222" })] })),
    };
    const candidateRows = [transaction()];
    const pacRows = [transaction({ entityType: "PAC", entityName: "Utah Builders PAC", name: "Wasatch Builders LLC" })];
    const loadGeneratedReportRowsFn = vi.fn(async (input) => {
      if (input.folderId) {
        return {
          rows: candidateRows,
          cachePath: `/tmp/folder-${input.folderId}.csv`,
          sourceUrl: `https://example.test/folder/${input.folderId}`,
          cacheHit: false,
        };
      }
      return {
        rows: pacRows,
        cachePath: "/tmp/pac.csv",
        sourceUrl: "https://example.test/pac",
        cacheHit: false,
      };
    });
    const syncUtahCandidateFinanceFn = vi.fn().mockResolvedValue(syncResult());

    const result = await syncDueUtahCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      loadGeneratedReportRowsFn,
      syncUtahCandidateFinanceFn,
      autoLinkMissingLinks: false,
      classifySupportingCommitteeIndustriesWithAi: false,
      supportingCommitteeIndustryMinAmount: 5_000,
    });

    expect(result).toMatchObject({
      dryRun: false,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
    });
    expect(loadGeneratedReportRowsFn).toHaveBeenCalledWith({ reportYear: 2026, folderId: "98765" });
    expect(loadGeneratedReportRowsFn).toHaveBeenCalledWith({ reportYear: 2026, folderId: "22222" });
    expect(loadGeneratedReportRowsFn).toHaveBeenCalledWith({ reportYear: 2026, entityType: "PAC" });
    expect(loadGeneratedReportRowsFn.mock.calls.filter((call) => call[0].entityType === "PAC")).toHaveLength(1);
    expect(syncUtahCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        sourceUrl: SOURCE_URL,
        transactionSourceUrl: "https://example.test/folder/98765",
        supportingCommitteeSourceUrl: "https://example.test/pac",
        trustedCommittee: {
          folderId: "98765",
          committeeName: "Friends of Jane Doe",
          reportYears: [2026],
          sourceUrl: SOURCE_URL,
        },
        transactions: candidateRows,
        supportingCommitteeTransactions: pacRows,
        classifySupportingCommitteeIndustriesWithAi: false,
        supportingCommitteeIndustryMinAmount: 5_000,
        dryRun: false,
        now: NOW,
      })
    );
  });

  it("continues with direct finance when PAC enrichment CSV loading fails", async () => {
    const db = { query: vi.fn(async () => ({ rows: [dueRow()] })) };
    const loadGeneratedReportRowsFn = vi.fn(async (input) => {
      if (input.entityType === "PAC") {
        throw new Error("PAC bulk CSV unavailable");
      }
      return {
        rows: [transaction()],
        cachePath: "/tmp/folder.csv",
        sourceUrl: "https://example.test/folder",
        cacheHit: false,
      };
    });
    const syncUtahCandidateFinanceFn = vi.fn().mockResolvedValue(syncResult());

    const result = await syncDueUtahCandidateFinance({
      db,
      now: NOW,
      loadGeneratedReportRowsFn,
      syncUtahCandidateFinanceFn,
      autoLinkMissingLinks: false,
    });

    expect(result).toMatchObject({
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
      results: [{ ok: true, supportingCommitteeLoadError: "PAC bulk CSV unavailable" }],
    });
    expect(syncUtahCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        supportingCommitteeTransactions: undefined,
        supportingCommitteeSourceUrl: undefined,
      })
    );
  });

  it("links unlinked candidates before syncing, since nothing else creates Utah links", async () => {
    // Live Oct 2026: all 190 Nov-2026 Utah candidates were unlinked because
    // the due sync only refreshed existing links.
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("NOT EXISTS")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Nelson T. Abbott",
                election_year: 2026,
                office_scope: "state_lower",
                office_name: "State Lower Chamber Legislator",
                district: "57",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO public.ut_candidate_finance_links")) {
          return { rows: [{ id: "33333333-3333-4333-8333-333333333333", link_source: "disclosures_advanced_search", election_year: 2026 }] };
        }
        return { rows: [] };
      }),
    };
    const resolveCandidateCommittee = vi.fn(async () => ({
      status: "matched" as const,
      folderId: "1415393",
      committeeName: "Abbott, Nelson (2022 House-57)",
      reportYears: [2026],
      confidence: "exact" as const,
      source: "disclosures_advanced_search" as const,
      sourceUrl: "https://disclosures.utah.gov/Search/AdvancedSearch",
      matchedEntityRowCount: 1,
    }));

    const result = await syncDueUtahCandidateFinance({
      db,
      now: NOW,
      resolveCandidateCommittee,
      syncUtahCandidateFinanceFn: vi.fn(),
    });

    expect(resolveCandidateCommittee).toHaveBeenCalledWith(
      {
        candidateName: "Nelson T. Abbott",
        electionYear: 2026,
        officeName: "State Lower Chamber Legislator",
        district: "57",
      },
      undefined
    );
    expect(result).toMatchObject({ autoLinkAttemptedCount: 1, autoLinkLinkedCount: 1, selectedCandidateCount: 0 });
    expect(queries.some((sql) => sql.includes("INSERT INTO public.ut_candidate_finance_links"))).toBe(true);
  });

  it("does not auto-link on a dry run", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const resolveCandidateCommittee = vi.fn();

    const result = await syncDueUtahCandidateFinance({ db, now: NOW, dryRun: true, resolveCandidateCommittee });

    expect(resolveCandidateCommittee).not.toHaveBeenCalled();
    expect(result).toMatchObject({ autoLinkAttemptedCount: 0, autoLinkLinkedCount: 0 });
  });
});

it("acquires independently due committee cash before a failing legacy direct export", async () => {
  const { syncDueUtahCommitteeCash } = await import("../../../src/pipeline/utahFinance/utahCommitteeCashSync.js");
  vi.mocked(syncDueUtahCommitteeCash).mockResolvedValueOnce({due:1,selected:1,accepted:1,written:1,held:0,failures:[]});
  const loader = vi.fn(async () => { throw new Error("legacy source unavailable"); });
  const result = await syncDueUtahCandidateFinance({db:{query:vi.fn(async()=>({rows:[dueRow()]}))},now:NOW,autoLinkMissingLinks:false,loadGeneratedReportRowsFn:loader});
  expect(result.committeeCash?.written).toBe(1);
  expect(result.failedCandidateCount).toBe(1);
  expect(vi.mocked(syncDueUtahCommitteeCash).mock.invocationCallOrder.at(-1)).toBeLessThan(loader.mock.invocationCallOrder[0]);
});

it("keeps the legacy direct sync running when committee cash throws, but fails committee-cash-only runs", async () => {
  const { syncDueUtahCommitteeCash } = await import("../../../src/pipeline/utahFinance/utahCommitteeCashSync.js");
  vi.mocked(syncDueUtahCommitteeCash).mockRejectedValueOnce(new Error("relation does not exist"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await syncDueUtahCandidateFinance({db:{query:vi.fn(async()=>({rows:[dueRow()]}))},now:NOW,autoLinkMissingLinks:false,
    loadGeneratedReportRowsFn:vi.fn(async()=>({rows:[],cachePath:"synthetic.csv",sourceUrl:SOURCE_URL,cacheHit:true})),syncUtahCandidateFinanceFn:vi.fn(async()=>syncResult())});
  warn.mockRestore();
  expect(result.committeeCash).toBeUndefined();
  expect(result.committeeCashError).toBe("relation does not exist");
  expect(result.syncedCandidateCount).toBe(1);
  vi.mocked(syncDueUtahCommitteeCash).mockRejectedValueOnce(new Error("relation does not exist"));
  await expect(syncDueUtahCandidateFinance({db:{query:vi.fn()},now:NOW,committeeCashOnly:true})).rejects.toThrow("relation does not exist");
});

it("runs committee cash alone without auto-linking or loading legacy direct transactions", async () => {
  const loader=vi.fn();
  const result=await syncDueUtahCandidateFinance({db:{query:vi.fn()},now:NOW,committeeCashOnly:true,loadGeneratedReportRowsFn:loader});
  expect(result.autoLinkAttemptedCount).toBe(0);
  expect(loader).not.toHaveBeenCalled();
});

it("keeps explicit candidate scope from triggering unrelated auto-link writes", async () => {
  const db={query:vi.fn(async()=>({rows:[dueRow()]}))};
  await syncDueUtahCandidateFinance({db,now:NOW,candidateId:CANDIDATE_ID,electionYear:2026,
    loadGeneratedReportRowsFn:vi.fn(async()=>({rows:[],cachePath:"synthetic.csv",sourceUrl:SOURCE_URL,cacheHit:true})),
    syncUtahCandidateFinanceFn:vi.fn(async()=>syncResult())});
  expect(db.query).toHaveBeenCalledOnce();
});

it("runs IE acquisition before a failed direct source and preserves donor execution", async () => {
  const order:string[]=[];
  const ie=vi.fn(async()=>{order.push("ie");return {selected:1,accepted:1,written:1,held:0,unallocated:0,failures:[]};});
  const cash=vi.fn(async()=>{order.push("cash");return {due:0,selected:0,accepted:0,written:0,held:0,failures:[]};});
  const result=await syncDueUtahCandidateFinance({db:{query:vi.fn(async()=>({rows:[dueRow()]}))},now:NOW,autoLinkMissingLinks:false,
    syncDueUtahReportedIeFn:ie,syncDueUtahCommitteeCashFn:cash,loadGeneratedReportRowsFn:vi.fn(async()=>{order.push("direct");throw Error("synthetic_direct_failure");})});
  expect(order).toEqual(["ie","cash","direct"]);expect(result.reportedIe?.written).toBe(1);expect(result.failedCandidateCount).toBe(1);
});
it("runs targeted IE alone and contains its failure during ordinary direct sync", async () => {
  const db={query:vi.fn(async()=>({rows:[]}))},cash=vi.fn(),loader=vi.fn();
  const options={db,now:NOW,candidateId:CANDIDATE_ID,electionYear:2026,refreshIe:true,ieNetwork:false,syncDueUtahCommitteeCashFn:cash,loadGeneratedReportRowsFn:loader};
  const ie=vi.fn(async()=>({selected:1,accepted:1,written:0,held:0,unallocated:0,failures:[]}));
  const result=await syncDueUtahCandidateFinance({...options,ieOnly:true,syncDueUtahReportedIeFn:ie});
  expect(result.reportedIe?.accepted).toBe(1);expect(db.query).not.toHaveBeenCalled();expect(cash).not.toHaveBeenCalled();expect(loader).not.toHaveBeenCalled();
  expect(ie).toHaveBeenCalledWith(expect.objectContaining({candidateId:CANDIDATE_ID,electionYear:2026,refreshIe:true,ieNetwork:false}));
  const failed=await syncDueUtahCandidateFinance({db,now:NOW,autoLinkMissingLinks:false,syncDueUtahReportedIeFn:vi.fn(async()=>{throw Error("synthetic");})});
  expect(failed.reportedIeError).toBe("component_failed");expect(db.query).toHaveBeenCalled();
});


it.each([new Error("relation ut_reported_ie_attempts does not exist"), "database connection unavailable"])(
  "logs reported IE infrastructure failures while retaining the stable result code: %s", async cause => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cash = vi.fn(async () => ({ due: 0, selected: 0, accepted: 0, written: 0, held: 0, failures: [] }));
    const direct = vi.fn(async () => syncResult());
    try {
      const result = await syncDueUtahCandidateFinance({
        db: { query: vi.fn(async () => ({ rows: [dueRow()] })) }, now: NOW, autoLinkMissingLinks: false,
        syncDueUtahReportedIeFn: vi.fn(async () => { throw cause; }),
        syncDueUtahCommitteeCashFn: cash,
        loadGeneratedReportRowsFn: vi.fn(async () => ({ rows: [], cachePath: "synthetic.csv", sourceUrl: SOURCE_URL, cacheHit: true })),
        syncUtahCandidateFinanceFn: direct,
      });
      expect(result.reportedIeError).toBe("component_failed");
      expect(result.reportedIe).toBeUndefined();
      expect(result.syncedCandidateCount).toBe(1);
      expect(cash).toHaveBeenCalledOnce();
      expect(direct).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Utah reported IE sync skipped; continuing with committee cash and direct sync:",
        cause instanceof Error ? cause.message : cause,
      );
    } finally { warn.mockRestore(); }
  },
);

it("preserves the original cause when an IE-only run fails", async () => {
  const cause = new Error("database connection unavailable");
  const db = { query: vi.fn() }, cash = vi.fn(), loader = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const failure = await syncDueUtahCandidateFinance({ db, now: NOW, ieOnly: true,
      syncDueUtahReportedIeFn: vi.fn(async () => { throw cause; }),
      syncDueUtahCommitteeCashFn: cash, loadGeneratedReportRowsFn: loader,
    }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("Utah reported IE component failed");
    expect(failure.cause).toBe(cause);
    expect(warn).toHaveBeenCalledWith("Utah reported IE sync failed:", cause.message);
    expect(db.query).not.toHaveBeenCalled();
    expect(cash).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});
