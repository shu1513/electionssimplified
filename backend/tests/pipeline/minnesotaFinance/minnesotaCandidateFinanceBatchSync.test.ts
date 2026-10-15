import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshMinnesotaCampaignFinanceArtifactCache } from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactCache.js";
import * as artifactReader from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactReader.js";

import {
  listDueMinnesotaCandidateFinanceSyncRows,
  syncDueMinnesotaCandidateFinance,
} from "../../../src/pipeline/minnesotaFinance/minnesotaCandidateFinanceBatchSync.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");
const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const receiptHeaders = "Recipient reg num,Recipient,Recipient type,Recipient subtype,Amount,Receipt date,Year,Contributor,Contrib Reg Num,Contrib type,Receipt type,In kind?,In-kind descr,Contrib zip,Contrib Employer name";
const ieHeaders = "Spender,Spender Reg Num,Spender type,Spender sub-type,Affected Comte Name,Affected Cmte Reg Num,For /Against,Year,Date,Type,Amount,Unpaid amount,In kind?,In kind descr,Purpose,Vendor name,Vendor city,Vendor State,Vendor zip";
async function prepareCache(cacheDir?: string, amount = "10.00") {
  const dir = cacheDir ?? await mkdtemp(join(tmpdir(), "voteapp-mn-batch-"));
  if (!cacheDir) tempDirs.push(dir);
  const bodies = {
    "/contrib.csv": `${receiptHeaders}\n1001,Example,PCC,,${amount},2026-01-01,2026,Example Committee,3001,Political Committee/Fund,Contribution,No,,,\n9999,Other,PCC,,1.00,2026-01-01,2026,Other Committee,3002,Political Committee/Fund,Contribution,No,,,`,
    "/ie.csv": `${ieHeaders}\nExample Spender,4001,PCF,IEC,Example,1001,For,2026,2026-01-01,Independent Expenditure,${amount},0,No,,,,,,`,
    "/ie-contrib.csv": `${receiptHeaders}\n4001,Example Spender,PCF,IEC,${amount},2026-01-01,2026,Example Funder,5001,Political Committee/Fund,Contribution,No,,,`,
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/campaign-finance/")) return new Response(`<table>
      <tr><td>All Contributions received by all entities - 2015 to present</td><td><a href="/contrib.csv">Download</a></td></tr>
      <tr><td>All Independent expenditures by all entities - 2015 to present</td><td><a href="/ie.csv">Download</a></td></tr>
      <tr><td>Independent expenditure committees and funds Contributions received by independent expenditure committees and funds only - 2015 to present</td><td><a href="/ie-contrib.csv">Download</a></td></tr></table>`);
    return new Response(bodies[path as keyof typeof bodies]);
  });
  return { dir, result: await refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: dir, fetchImpl: fetchImpl as typeof fetch, force: true }) };
}

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

function dueQueryRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Jane Doe",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    committee_id: "1001",
    committee_name: "FRIENDS OF JANE DOE",
    source_url: "https://example.invalid/source",
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

describe("minnesotaCandidateFinanceBatchSync", () => {
  it("loads already-linked recipients independently of auto-linking and pins one generation", async () => {
    const { dir, result } = await prepareCache();
    const original = artifactReader.readMinnesotaCampaignFinanceNativeRows;
    const read = vi.spyOn(artifactReader, "readMinnesotaCampaignFinanceNativeRows").mockImplementation(async (input) => {
      const loaded = await original(input);
      if (input.key === "independent_expenditures") {
        read.mockRestore();
        await prepareCache(dir, "20.00");
      }
      return loaded;
    });
    const sync = vi.fn().mockResolvedValue({});
    await syncDueMinnesotaCandidateFinance({ db: createMockDb([dueQueryRow()]) as never, now: NOW,
      dryRun: true, autoLinkMissingLinks: false, rawDataCacheDir: dir,
      syncMinnesotaCandidateFinanceFn: sync as never, fetchMinnesotaCandidateFinancialSummaryFn: vi.fn().mockResolvedValue(null) });
    const input = sync.mock.calls[0]?.[0];
    expect(input.contributionRows).toHaveLength(1);
    expect(input.contributionRows[0]["Recipient reg num"]).toBe("1001");
    expect(input.contributionRows[0].Amount).toBe("10.00");
    expect(input.expenditureRows[0].Amount).toBe("10.00");
    expect(input.outsideContributionRows[0].Amount).toBe("10.00");
    expect(result.current.version).toBe(2);
  });

  it.each(["independent_expenditures", "independent_expenditure_contributions"] as const)(
    "isolates a corrupt %s component while direct receipts remain usable", async (key) => {
      const { dir, result } = await prepareCache();
      const file = result.current.downloads[key].outputPath;
      await writeFile(file, (await readFile(file, "utf8")).replace("10.00", "99.00"));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const sync = vi.fn().mockResolvedValue({});
      const summary = { committeeId: "1001", electionYear: 2026, totalReceipts: 1000,
        directContributionTotal: 900, totalDisbursements: 400, sourceUrl: "https://example.invalid/summary" };
      await syncDueMinnesotaCandidateFinance({ db: createMockDb([dueQueryRow()]) as never, now: NOW,
        dryRun: true, autoLinkMissingLinks: false, rawDataCacheDir: dir,
        syncMinnesotaCandidateFinanceFn: sync as never, fetchMinnesotaCandidateFinancialSummaryFn: vi.fn().mockResolvedValue(summary) });
      const input = sync.mock.calls[0]?.[0];
      expect(input.contributionRows).toHaveLength(1);
      expect(input.financialSummary).toEqual(summary);
      expect(input.outsideContributionRows).toBeUndefined();
      if (key === "independent_expenditures") expect(input.expenditureRows).toBeUndefined();
      else expect(input.expenditureRows).toHaveLength(1);
    });

  it("does not trust root files when the publication metadata is absent", async () => {
    const { dir, result } = await prepareCache();
    await rm(result.metadataPath);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sync = vi.fn().mockResolvedValue({});
    await syncDueMinnesotaCandidateFinance({ db: createMockDb([dueQueryRow()]) as never, now: NOW,
      dryRun: true, autoLinkMissingLinks: false, rawDataCacheDir: dir,
      syncMinnesotaCandidateFinanceFn: sync as never, fetchMinnesotaCandidateFinancialSummaryFn: vi.fn().mockResolvedValue(null) });
    expect(sync.mock.calls[0]?.[0]).toMatchObject({ contributionRows: [], expenditureRows: undefined,
      outsideContributionRows: undefined });
  });

  it("lists active Minnesota finance links that are due for sync", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "statewide",
        office_name: "Governor",
        district: null,
        committee_id: "1001",
        committee_name: "FRIENDS OF JANE DOE",
        source_url: "https://example.invalid/source",
        last_synced_at: null,
        total_due_rows: "1",
      },
    ]);

    await expect(
      listDueMinnesotaCandidateFinanceSyncRows(db, {
        now: NOW,
        staleAfterDays: 7,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual({
      totalDueRows: 1,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          committeeId: "1001",
          committeeName: "FRIENDS OF JANE DOE",
          sourceUrl: "https://example.invalid/source",
          lastSyncedAt: null,
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.mn_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'MN'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining([
        "statewide::Governor",
        "statewide::Lieutenant Governor",
        "statewide::Secretary of State",
        "statewide::Attorney General",
        "state_upper::State Senator",
        "state_lower::State Lower Chamber Legislator",
      ]),
    ]);
  });

  it("syncs selected due candidates with trusted linked committees", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "statewide",
        office_name: "Governor",
        district: null,
        committee_id: "1001",
        committee_name: "FRIENDS OF JANE DOE",
        source_url: "https://example.invalid/source",
        last_synced_at: null,
        total_due_rows: "1",
      },
    ]);

    const syncMinnesotaCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      resolution: {
        status: "matched",
        committeeId: "1001",
        committeeName: "FRIENDS OF JANE DOE",
        confidence: "exact",
        source: "mn_board_viewer",
        sourceUrl: "https://example.invalid/source",
        matchedCandidateRowCount: 1,
      },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: null,
      directContributionTotal: null,
      totalDisbursements: null,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
      matchedOutsideExpenditureRowCount: 0,
      includedOutsideExpenditureRowCount: 0,
      skippedOutsideExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    });

    const fetchMinnesotaCandidateFinancialSummaryFn = vi.fn().mockResolvedValue({
      committeeId: "1001",
      electionYear: 2026,
      totalReceipts: 1000,
      directContributionTotal: 900,
      totalDisbursements: 400,
      sourceUrl: "https://example.invalid/financial-summary",
    });

    const result = await syncDueMinnesotaCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 25,
      staleAfterDays: 7,
      electionLookbackDays: 1,
      electionLookaheadDays: 730,
      autoLinkMissingLinks: false,
      contributionRows: [],
      expenditureRows: [],
      outsideContributionRows: [],
      syncMinnesotaCandidateFinanceFn: syncMinnesotaCandidateFinanceFn as never,
      fetchMinnesotaCandidateFinancialSummaryFn,
    });

    expect(result).toMatchObject({
      dryRun: false,
      now: NOW.toISOString(),
      staleAfterDays: 7,
      maxCandidates: 25,
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(result.results).toHaveLength(1);
    expect(fetchMinnesotaCandidateFinancialSummaryFn).toHaveBeenCalledWith({
      committeeId: "1001",
      electionYear: 2026,
    });
    expect(syncMinnesotaCandidateFinanceFn).toHaveBeenCalledTimes(1);
    expect(syncMinnesotaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
        sourceUrl: "https://example.invalid/source",
        contributionRows: [],
        contributionSourceUrl: null,
        expenditureRows: [],
        outsideContributionRows: [],
        outsideSourceUrl: null,
        financialSummary: {
          committeeId: "1001",
          electionYear: 2026,
          totalReceipts: 1000,
          directContributionTotal: 900,
          totalDisbursements: 400,
          sourceUrl: "https://example.invalid/financial-summary",
        },
        trustedCommittee: {
          committeeId: "1001",
          committeeName: "FRIENDS OF JANE DOE",
          sourceUrl: "https://example.invalid/source",
        },
        dryRun: false,
        now: NOW,
      })
    );
  });

  it("continues the candidate sync without new direct totals when CFB is unavailable", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "statewide",
        office_name: "Governor",
        district: null,
        committee_id: "1001",
        committee_name: "FRIENDS OF JANE DOE",
        source_url: "https://example.invalid/source",
        last_synced_at: null,
        total_due_rows: "1",
      },
    ]);
    const fetchMinnesotaCandidateFinancialSummaryFn = vi.fn().mockRejectedValue(new Error("temporary outage"));
    const syncMinnesotaCandidateFinanceFn = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await syncDueMinnesotaCandidateFinance({
        db,
        now: NOW,
        autoLinkMissingLinks: false,
        contributionRows: [],
        expenditureRows: [],
        outsideContributionRows: [],
        syncMinnesotaCandidateFinanceFn: syncMinnesotaCandidateFinanceFn as never,
        fetchMinnesotaCandidateFinancialSummaryFn,
      });

      expect(result.syncedCandidateCount).toBe(1);
      expect(result.failedCandidateCount).toBe(0);
      expect(syncMinnesotaCandidateFinanceFn).toHaveBeenCalledWith(
        expect.objectContaining({ financialSummary: undefined })
      );
      expect(warn).toHaveBeenCalledWith(
        "Minnesota CFB financial summary unavailable for committee 1001; preserving existing direct totals:",
        "temporary outage"
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves existing direct totals without warning when CFB explicitly reports no data", async () => {
    const db = createMockDb([dueQueryRow()]);
    const fetchMinnesotaCandidateFinancialSummaryFn = vi.fn().mockResolvedValue(null);
    const syncMinnesotaCandidateFinanceFn = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await syncDueMinnesotaCandidateFinance({
        db,
        now: NOW,
        autoLinkMissingLinks: false,
        contributionRows: [],
        expenditureRows: [],
        outsideContributionRows: [],
        syncMinnesotaCandidateFinanceFn: syncMinnesotaCandidateFinanceFn as never,
        fetchMinnesotaCandidateFinancialSummaryFn,
      });

      expect(result.syncedCandidateCount).toBe(1);
      expect(result.failedCandidateCount).toBe(0);
      expect(syncMinnesotaCandidateFinanceFn).toHaveBeenCalledWith(
        expect.objectContaining({ financialSummary: undefined })
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reuses a financial-summary request for candidates sharing a committee and election", async () => {
    const db = createMockDb([
      dueQueryRow({ total_due_rows: "2" }),
      dueQueryRow({
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "John Doe",
        total_due_rows: "2",
      }),
    ]);
    const fetchMinnesotaCandidateFinancialSummaryFn = vi.fn().mockResolvedValue({
      committeeId: "1001",
      electionYear: 2026,
      totalReceipts: 1000,
      directContributionTotal: 900,
      totalDisbursements: 400,
      sourceUrl: "https://example.invalid/financial-summary",
    });
    const syncMinnesotaCandidateFinanceFn = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });

    const result = await syncDueMinnesotaCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      contributionRows: [],
      expenditureRows: [],
      outsideContributionRows: [],
      syncMinnesotaCandidateFinanceFn: syncMinnesotaCandidateFinanceFn as never,
      fetchMinnesotaCandidateFinancialSummaryFn,
    });

    expect(result.syncedCandidateCount).toBe(2);
    expect(fetchMinnesotaCandidateFinancialSummaryFn).toHaveBeenCalledTimes(1);
    expect(syncMinnesotaCandidateFinanceFn).toHaveBeenCalledTimes(2);
  });
});
