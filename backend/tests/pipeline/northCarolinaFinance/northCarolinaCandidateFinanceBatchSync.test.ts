import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNcsbeCachedCommitteeSearchLoader,
  northCarolinaCommitteeSearchQueryForCandidateName,
  syncDueNorthCarolinaCandidateFinance,
  type NorthCarolinaCandidateFinanceDueRow,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaCandidateFinanceBatchSync.js";
import {
  storeNcsbeArtifact,
  type NcsbeArtifactKey,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeArtifactCache.js";
import { NCSBE_COVER_SECTIONS } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";

const SBOE_ID = "STA-AB12CD-C-001";
const COMMITTEE_NAME = "COMMITTEE TO ELECT JANE DOE";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-ncsbe-batch-"));
  tempDirs.push(dir);
  return dir;
}

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/northCarolinaFinance/${name}`, import.meta.url)),
    "utf8"
  );
}

async function install(cacheDir: string, key: NcsbeArtifactKey, body: string): Promise<void> {
  await storeNcsbeArtifact({
    cacheDir,
    key,
    url: `https://cf.ncsbe.gov/test/${JSON.stringify(key)}`,
    body,
    retrievedAt: new Date("2026-08-07T00:00:00.000Z"),
  });
}

type InventoryRowSpec = {
  committeeName?: string;
  sboeId?: string | null;
  reportYear?: number;
  documentType?: string;
  reportType?: string;
  isAmendment?: "Y" | "N" | "";
  imageReceiptDate?: string;
  dataImportDate?: string;
  periodStartDate?: string;
  periodEndDate?: string;
  dataLink?: string | null;
  imageLink?: string | null;
};

// Minimal portal-shaped document listing: the same embedded-JSON contract the
// parser pins, with only the values under test varying.
function makeInventoryHtml(rows: InventoryRowSpec[]): string {
  const data = rows.map((row) => ({
    CommitteeName: row.committeeName ?? COMMITTEE_NAME,
    SBoEID: row.sboeId === undefined ? SBOE_ID : row.sboeId ?? "No Id",
    ReportYear: row.reportYear ?? 2026,
    DocumentType: row.documentType ?? "Disclosure Report",
    ReportType: row.reportType ?? "First Quarter",
    IsAmendment: row.isAmendment ?? "N",
    ImageReceiptDate: row.imageReceiptDate ?? "02/24/2026",
    DataImportDate: row.dataImportDate ?? "02/24/2026",
    PeriodStartDate: row.periodStartDate ?? "01/01/2026",
    PeriodEndDate: row.periodEndDate ?? "02/14/2026",
    DataLink: row.dataLink ?? null,
    ImageLink: row.imageLink ?? "image.pdf",
  }));
  return `<html><body><script>\nvar data = ${JSON.stringify(data)};\n</script></body></html>`;
}

// Full 34-section cover page (the parser rejects anything else); section
// values default to zero and are overridden as [periodDollars, cycleDollars].
function makeCoverHtml(input: {
  // The cover declares its own report id; the aggregator's mispaired-artifact
  // guard compares it against the report the artifact was cached for.
  reportId: string;
  beginDate: string;
  endDate: string;
  filedDate: string;
  sections: Record<number, [number, number]>;
}): string {
  const cover = {
    BoeID: SBOE_ID,
    OrgName: COMMITTEE_NAME,
    EntityTypeDesc: "Candidate Committee",
    FullReportName: "Test Report",
    ReportVersion: "2007",
    BeginDate: input.beginDate,
    EndDate: input.endDate,
    FiledDate: input.filedDate,
  };
  const grid = [...NCSBE_COVER_SECTIONS.entries()].map(([sequence, section]) => {
    const [period, cycle] = input.sections[sequence] ?? [0, 0];
    return { Sequence: sequence, Section: section, Period: period, Cycle: cycle };
  });
  return (
    "<html><body><script>\n" +
    `var rptID = ${input.reportId};\n` +
    `var dataCover = ${JSON.stringify(cover)};\n` +
    `SetupGrid(${JSON.stringify(grid)}, "summary");\n` +
    "</script></body></html>"
  );
}

function makeReceiptsJson(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    Data: {
      recordCountKey: rows.length,
      responseDataKey: "results",
      results: rows.map((row) => ({
        GroupID: 11,
        OccurDate: "01/15/2026",
        OrgName: null,
        IsOrg: false,
        Amount: 0,
        SumToDate: null,
        Profession: "",
        EmployersName: "",
        IsAggregated: false,
        ReceiptTypeDesc: "Individual Contribution",
        ReceiptTypeCode: "IND ",
        AccountAbbr: "1",
        FormOfPaymentDesc: "Check",
        Purpose: null,
        ...row,
      })),
    },
  });
}

function makeExpendituresJson(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    Data: {
      recordCountKey: rows.length,
      responseDataKey: "results",
      results: rows.map((row) => ({
        OccurDate: "02/10/2026",
        OrgName: "VENDOR LLC",
        IsOrg: true,
        Amount: 0,
        IEAmount: null,
        IsAggregated: false,
        ExpenditureTypeDesc: "Operating Expense",
        PurposeTypeCode: "O",
        Purpose: null,
        AccountAbbr: "1",
        FormOfPaymentDesc: "Check",
        Candidate: null,
        OfficeSought: null,
        Declaration: null,
        ...row,
      })),
    },
  });
}

// The synthetic committee: a 2025 Year End report (300001) and a 2026 Q1
// report (300002) with chain-exact Cycle columns, plus one unregistered IE
// filer report (400001) targeting the candidate.
async function installCommitteeArtifacts(cacheDir: string): Promise<void> {
  await install(
    cacheDir,
    { type: "document_inventory", sboeId: SBOE_ID },
    makeInventoryHtml([
      {
        reportYear: 2025,
        reportType: "Year End Semi-Annual",
        imageReceiptDate: "01/20/2026",
        dataImportDate: "01/20/2026",
        periodStartDate: "07/01/2025",
        periodEndDate: "12/31/2025",
        dataLink: "300001",
      },
      {
        reportType: "First Quarter",
        dataLink: "300002",
      },
    ])
  );

  await install(
    cacheDir,
    { type: "report_cover", reportId: "300001" },
    makeCoverHtml({
      reportId: "300001",
      beginDate: "07/01/2025",
      endDate: "12/31/2025",
      filedDate: "01/20/2026",
      sections: { 15: [100, 100], 20: [800, 800], 60: [1000, 1000], 90: [400, 400], 95: [600, 600] },
    })
  );
  await install(
    cacheDir,
    { type: "report_transactions", reportId: "300001", kind: "receipts", page: 0 },
    makeReceiptsJson([
      { Amount: 800, SumToDate: 800, Profession: "Teacher", EmployersName: "Wake Schools" },
      {
        GroupID: null,
        OrgName: "Aggregated Individual Contribution",
        Amount: 100,
        IsAggregated: true,
      },
    ])
  );
  await install(
    cacheDir,
    { type: "report_transactions", reportId: "300001", kind: "expenditures", page: 0 },
    makeExpendituresJson([{ Amount: 400 }])
  );

  await install(
    cacheDir,
    { type: "report_cover", reportId: "300002" },
    makeCoverHtml({
      reportId: "300002",
      beginDate: "01/01/2026",
      endDate: "02/14/2026",
      filedDate: "02/24/2026",
      sections: { 20: [300, 1100], 15: [0, 100], 60: [500, 1500], 90: [200, 600], 95: [900, 900] },
    })
  );
  await install(
    cacheDir,
    { type: "report_transactions", reportId: "300002", kind: "receipts", page: 0 },
    makeReceiptsJson([{ Amount: 300, SumToDate: 1100, Profession: "Teacher", EmployersName: "Wake Schools" }])
  );
  await install(
    cacheDir,
    { type: "report_transactions", reportId: "300002", kind: "expenditures", page: 0 },
    // An IE-typed declared row inside a REGULAR report: decision 3's
    // single-source rule keeps its money out of outside totals; it feeds the
    // inverse-miss cross-check instead.
    makeExpendituresJson([
      { Amount: 200 },
      {
        Amount: 50,
        ExpenditureTypeDesc: "Independent Expenditure",
        Candidate: "SMITH JOHN",
        OfficeSought: "NC HOUSE 3",
        Declaration: "Oppose",
      },
    ])
  );
}

async function installIeArtifacts(
  cacheDir: string,
  options: { withReceipts?: boolean } = {}
): Promise<void> {
  await install(cacheDir, { type: "ie_doc_type_inventory", year: 2025 }, makeInventoryHtml([]));
  await install(
    cacheDir,
    { type: "ie_doc_type_inventory", year: 2026 },
    makeInventoryHtml([
      {
        committeeName: "ADVANCE CAROLINA ACTION",
        sboeId: null,
        documentType: "Informational Report",
        reportType: "Independent Expenditure Report",
        imageReceiptDate: "03/01/2026",
        dataImportDate: "03/01/2026",
        periodStartDate: "02/01/2026",
        periodEndDate: "02/28/2026",
        dataLink: "400001",
      },
    ])
  );
  await install(
    cacheDir,
    { type: "report_cover", reportId: "400001" },
    makeCoverHtml({
      reportId: "400001",
      beginDate: "02/01/2026",
      endDate: "02/28/2026",
      filedDate: "03/01/2026",
      sections: { 90: [250, 250] },
    })
  );
  await install(
    cacheDir,
    { type: "report_transactions", reportId: "400001", kind: "expenditures", page: 0 },
    makeExpendituresJson([
      {
        Amount: 250,
        IEAmount: 150,
        ExpenditureTypeDesc: "Independent Expenditure",
        Candidate: "DOE JANE",
        OfficeSought: "NC HOUSE 27",
        Declaration: "Support",
      },
      {
        Amount: 250,
        IEAmount: 100,
        ExpenditureTypeDesc: "Independent Expenditure",
        Candidate: "DOE JANE",
        OfficeSought: "NC HOUSE 27",
        Declaration: "Oppose",
      },
    ])
  );
  if (options.withReceipts !== false) {
    // The unregistered filer's disclosed-funder rows live on its own IE
    // report's receipts (decision 6).
    await install(
      cacheDir,
      { type: "report_transactions", reportId: "400001", kind: "receipts", page: 0 },
      makeReceiptsJson([
        {
          OrgName: "ROLLING SEA FUND",
          IsOrg: true,
          Amount: 24_506,
          SumToDate: 24_506,
          ReceiptTypeDesc: "Donation",
          ReceiptTypeCode: "DON ",
        },
      ])
    );
  }
}

function dueRow(
  overrides: Partial<NorthCarolinaCandidateFinanceDueRow> = {}
): NorthCarolinaCandidateFinanceDueRow {
  return {
    candidateId: "11111111-1111-4111-8111-111111111111",
    electionId: "22222222-2222-4222-8222-222222222222",
    candidateName: "Jane Doe",
    electionYear: 2026,
    officeScope: "state_lower",
    officeName: "State Lower Chamber Legislator",
    district: "27",
    committeeId: SBOE_ID,
    committeeName: COMMITTEE_NAME,
    linkSource: "manual",
    sourceUrl: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

// The due-list query answers first; every later query is a year's outside
// target-universe query (empty — the due rows are the whole universe).
function createDb(rows: NorthCarolinaCandidateFinanceDueRow[]) {
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [] })
    .mockResolvedValueOnce({
      rows: rows.map((row, index) => ({
        candidate_id: row.candidateId,
        election_id: row.electionId,
        candidate_name: row.candidateName,
        election_year: row.electionYear,
        office_scope: row.officeScope,
        office_name: row.officeName,
        district: row.district,
        committee_id: row.committeeId,
        committee_name: row.committeeName,
        link_source: row.linkSource,
        source_url: row.sourceUrl,
        last_synced_at: row.lastSyncedAt,
        total_due_rows: index === 0 ? rows.length : undefined,
      })),
    });
  return { query, connect: vi.fn() };
}

describe("syncDueNorthCarolinaCandidateFinance", () => {
  it("aggregates direct and outside money from the cache end to end", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result).toMatchObject({
      dryRun: false,
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(result.outsideAggregationByYear).toEqual([
      expect.objectContaining({
        electionYear: 2026,
        available: true,
        reportCount: 1,
        quarantinedReportCount: 0,
        missingReportIdCount: 0,
        attributedRowCount: 2,
        attributedCents: 25_000,
      }),
    ]);
    // The regular-report IE-typed row plus no aggregated IE report for THIS
    // committee (400001 belongs to the unregistered filer) → inverse-miss
    // suspect for the PR 9 audit.
    expect(result.results[0]).toMatchObject({ ok: true, ieInverseMissSuspected: true });

    expect(syncFn).toHaveBeenCalledTimes(1);
    const syncInput = syncFn.mock.calls[0]![0];
    expect(syncInput).toMatchObject({
      candidateId: "11111111-1111-4111-8111-111111111111",
      committee: {
        committeeId: SBOE_ID,
        committeeName: COMMITTEE_NAME,
        // Manual provenance rides through untouched.
        linkSource: "manual",
      },
    });
    // Cover-authoritative direct summary across both selected reports.
    expect(syncInput.directFinance).toMatchObject({
      status: "ok",
      summary: {
        totalReceipts: 1500,
        directContributionTotal: 1200,
        totalDisbursements: 600,
        cashOnHand: 900,
      },
      selectedReportIds: ["300001", "300002"],
      cycleChainMismatches: [],
      ieTypedRegularReportRowCount: 1,
      ieTypedRegularReportCents: 5_000,
    });
    expect(syncInput.directFinance.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "occupation", categoryName: "Teacher", amount: 1100 }),
        expect.objectContaining({ categoryType: "contribution_size", categoryName: "$500-$999", amount: 800 }),
        expect.objectContaining({ categoryType: "contribution_size", categoryName: "$250-$499", amount: 300 }),
      ])
    );
    // Outside slice: IEAmount-gated totals from the unregistered IE filer,
    // keyed by the synthetic NC-IE-FILER hash (no SBoEID).
    expect(syncInput.outsideFinance).toMatchObject({ supportTotal: 150, opposeTotal: 100 });
    expect(syncInput.outsideFinance.groups).toHaveLength(2);
    for (const group of syncInput.outsideFinance.groups) {
      expect(group.committeeId).toMatch(/^NC-IE-FILER:[0-9a-f]{64}$/);
      expect(group.committeeName).toBe("ADVANCE CAROLINA ACTION");
    }
    // Funder leg (PR 8): the unregistered filer's own IE-report Donation row
    // becomes a disclosed-funder donor on BOTH directions' groups.
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      fundersAvailable: true,
      funderReceiptRowCount: 1,
    });
    expect(syncInput.outsideFinance.funders).toMatchObject({
      matchedReceiptRowCount: 1,
      includedReceiptRowCount: 1,
      skippedReceiptRowCount: 0,
    });
    const donorRows = syncInput.outsideFinance.funders.breakdowns.filter(
      (row: { categoryType: string }) => row.categoryType === "donor"
    );
    expect(donorRows).toHaveLength(2);
    expect(new Set(donorRows.map((row: { supportOppose: string }) => row.supportOppose))).toEqual(
      new Set(["support", "oppose"])
    );
    for (const row of donorRows) {
      expect(row).toMatchObject({ categoryName: "ROLLING SEA FUND", amount: 24_506, contributorCount: 1 });
    }
  });

  it("reads a registered spender's funders from its regular-report receipts", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    // A REGISTERED IE filer: its IE report carries the outside money
    // (registered form — Amount holds the single-target value), while its
    // funders come from its regular disclosure report's receipts.
    await install(
      cacheDir,
      { type: "ie_doc_type_inventory", year: 2026 },
      makeInventoryHtml([
        {
          committeeName: "ADVANCE CAROLINA ACTION",
          sboeId: null,
          documentType: "Informational Report",
          reportType: "Independent Expenditure Report",
          imageReceiptDate: "03/01/2026",
          dataImportDate: "03/01/2026",
          periodStartDate: "02/01/2026",
          periodEndDate: "02/28/2026",
          dataLink: "400001",
        },
        {
          committeeName: "CAROLINA GROWTH PAC",
          sboeId: "STA-PC99XX-C-005",
          documentType: "Informational Report",
          reportType: "Independent Expenditure for Registered Committees",
          imageReceiptDate: "04/01/2026",
          dataImportDate: "04/01/2026",
          periodStartDate: "03/01/2026",
          periodEndDate: "03/31/2026",
          dataLink: "500001",
        },
      ])
    );
    await install(
      cacheDir,
      { type: "report_cover", reportId: "500001" },
      makeCoverHtml({
        reportId: "500001",
        beginDate: "03/01/2026",
        endDate: "03/31/2026",
        filedDate: "04/01/2026",
        sections: { 90: [75, 75] },
      })
    );
    await install(
      cacheDir,
      { type: "report_transactions", reportId: "500001", kind: "expenditures", page: 0 },
      makeExpendituresJson([
        {
          Amount: 75,
          IEAmount: null,
          ExpenditureTypeDesc: "Independent Expenditure",
          Candidate: "DOE JANE",
          OfficeSought: "NC HOUSE 27",
          Declaration: "Support",
        },
      ])
    );
    // The spender's Q1 was AMENDED: only the amendment's receipts may count
    // (review round — summing both, or the stale original, double-counts).
    await install(
      cacheDir,
      { type: "document_inventory", sboeId: "STA-PC99XX-C-005" },
      makeInventoryHtml([
        {
          committeeName: "CAROLINA GROWTH PAC",
          sboeId: "STA-PC99XX-C-005",
          reportType: "First Quarter",
          dataLink: "500100",
          imageReceiptDate: "04/01/2026",
          dataImportDate: "04/01/2026",
        },
        {
          committeeName: "CAROLINA GROWTH PAC",
          sboeId: "STA-PC99XX-C-005",
          reportType: "First Quarter",
          isAmendment: "Y",
          dataLink: "500101",
          imageReceiptDate: "04/15/2026",
          dataImportDate: "04/15/2026",
        },
      ])
    );
    await install(
      cacheDir,
      { type: "report_transactions", reportId: "500100", kind: "receipts", page: 0 },
      makeReceiptsJson([
        {
          OrgName: "Stale Original Donor PAC",
          IsOrg: true,
          Amount: 999,
          SumToDate: 999,
          ReceiptTypeDesc: "Other Political Committee Contribution",
          ReceiptTypeCode: "CPCM",
        },
      ])
    );
    await install(
      cacheDir,
      { type: "report_transactions", reportId: "500101", kind: "receipts", page: 0 },
      makeReceiptsJson([
        {
          OrgName: "Carolina Realty PAC",
          IsOrg: true,
          Amount: 1000,
          SumToDate: 1000,
          ReceiptTypeDesc: "Other Political Committee Contribution",
          ReceiptTypeCode: "CPCM",
        },
      ])
    );
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result.outsideAggregationByYear[0]).toMatchObject({ available: true, fundersAvailable: true });
    const syncInput = syncFn.mock.calls[0]![0];
    expect(syncInput.outsideFinance).toMatchObject({ supportTotal: 225, opposeTotal: 100 });
    const donorRows = syncInput.outsideFinance.funders.breakdowns.filter(
      (row: { categoryType: string }) => row.categoryType === "donor"
    );
    expect(donorRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          committeeId: "STA-PC99XX-C-005",
          supportOppose: "support",
          categoryName: "Carolina Realty PAC",
          amount: 1000,
        }),
        expect.objectContaining({ categoryName: "ROLLING SEA FUND", supportOppose: "support" }),
        expect.objectContaining({ categoryName: "ROLLING SEA FUND", supportOppose: "oppose" }),
      ])
    );
    // The amended-away original's donor never appears — current filings only.
    expect(donorRows.map((row: { categoryName: string }) => row.categoryName)).not.toContain(
      "Stale Original Donor PAC"
    );
    // The registered spender's donor classifies by rule into an industry row.
    expect(syncInput.outsideFinance.funders.breakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          committeeId: "STA-PC99XX-C-005",
          categoryType: "industry",
          categoryName: "real_estate",
          amount: 1000,
        }),
      ])
    );
  });

  it("fails the year's funder leg closed when a spender's receipts are not cached", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir, { withReceipts: false });
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    // Outside totals still sync; only the funder enrichment is withheld so
    // the writer preserves stored breakdown rows.
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      fundersAvailable: false,
      fundersError: expect.stringContaining("north-carolina-candidates:finance:raw:refresh"),
    });
    const syncInput = syncFn.mock.calls[0]![0];
    expect(syncInput.outsideFinance).toMatchObject({ supportTotal: 150, opposeTotal: 100 });
    expect(syncInput.outsideFinance.funders).toBeNull();
  });

  it("fails the funder leg closed when a registered spender's current filing is image-only", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    await install(
      cacheDir,
      { type: "ie_doc_type_inventory", year: 2026 },
      makeInventoryHtml([
        {
          committeeName: "CAROLINA GROWTH PAC",
          sboeId: "STA-PC99XX-C-005",
          documentType: "Informational Report",
          reportType: "Independent Expenditure for Registered Committees",
          imageReceiptDate: "04/01/2026",
          dataImportDate: "04/01/2026",
          periodStartDate: "03/01/2026",
          periodEndDate: "03/31/2026",
          dataLink: "500001",
        },
      ])
    );
    await install(
      cacheDir,
      { type: "report_cover", reportId: "500001" },
      makeCoverHtml({
        reportId: "500001",
        beginDate: "03/01/2026",
        endDate: "03/31/2026",
        filedDate: "04/01/2026",
        sections: { 90: [75, 75] },
      })
    );
    await install(
      cacheDir,
      { type: "report_transactions", reportId: "500001", kind: "expenditures", page: 0 },
      makeExpendituresJson([
        {
          Amount: 75,
          IEAmount: null,
          ExpenditureTypeDesc: "Independent Expenditure",
          Candidate: "DOE JANE",
          OfficeSought: "NC HOUSE 27",
          Declaration: "Support",
        },
      ])
    );
    // The spender's Q1 original was superseded by an IMAGE-ONLY amendment:
    // the period's current money is unreadable, so the funder picture is
    // provably partial and the leg must fail closed — never fall back to
    // the stale structured original.
    await install(
      cacheDir,
      { type: "document_inventory", sboeId: "STA-PC99XX-C-005" },
      makeInventoryHtml([
        {
          committeeName: "CAROLINA GROWTH PAC",
          sboeId: "STA-PC99XX-C-005",
          reportType: "First Quarter",
          dataLink: "500100",
          imageReceiptDate: "04/01/2026",
          dataImportDate: "04/01/2026",
        },
        {
          committeeName: "CAROLINA GROWTH PAC",
          sboeId: "STA-PC99XX-C-005",
          reportType: "First Quarter",
          isAmendment: "Y",
          dataLink: null,
          imageLink: "amended.pdf",
          imageReceiptDate: "05/01/2026",
          dataImportDate: "",
        },
      ])
    );
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      fundersAvailable: false,
      fundersError: expect.stringContaining("superseded-unavailable"),
    });
    expect(syncFn.mock.calls[0]![0].outsideFinance.funders).toBeNull();
  });

  it("withholds a candidate's funder slice when receipts carry an unknown receipt-type code", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    // Overwrite the IE filer's receipts with a set holding an unpinned code:
    // its semantics are unknown (could be entity donor money), so this
    // candidate's funder slice is withheld rather than published partial.
    await install(
      cacheDir,
      { type: "report_transactions", reportId: "400001", kind: "receipts", page: 0 },
      makeReceiptsJson([
        {
          OrgName: "ROLLING SEA FUND",
          IsOrg: true,
          Amount: 24_506,
          SumToDate: 24_506,
          ReceiptTypeDesc: "Donation",
          ReceiptTypeCode: "DON ",
        },
        {
          OrgName: "MYSTERY SOURCE LLC",
          IsOrg: true,
          Amount: 5_000,
          SumToDate: 5_000,
          ReceiptTypeDesc: "Loan Proceeds",
          ReceiptTypeCode: "LOAN",
        },
      ])
    );
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    // The leg itself ran (artifacts fine); the unknown vocabulary is
    // surfaced on the year summary for review.
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      fundersAvailable: true,
      funderUnknownReceiptTypeCodes: ["LOAN"],
    });
    const syncInput = syncFn.mock.calls[0]![0];
    expect(syncInput.outsideFinance).toMatchObject({ supportTotal: 150, opposeTotal: 100 });
    expect(syncInput.outsideFinance.funders).toBeNull();
  });

  it("fails the candidate without writing when a selected report's artifacts are missing", async () => {
    // A cache whose inventory lists 300002 but holds no artifacts for it.
    const partialDir = await makeCacheDir();
    await install(
      partialDir,
      { type: "document_inventory", sboeId: SBOE_ID },
      makeInventoryHtml([
        {
          reportYear: 2025,
          reportType: "Year End Semi-Annual",
          imageReceiptDate: "01/20/2026",
          dataImportDate: "01/20/2026",
          periodStartDate: "07/01/2025",
          periodEndDate: "12/31/2025",
          dataLink: "300001",
        },
        { reportType: "First Quarter", dataLink: "300002" },
      ])
    );
    await installIeArtifacts(partialDir);
    const db = createDb([dueRow()]);
    const syncFn = vi.fn();

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: partialDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(syncFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ syncedCandidateCount: 0, failedCandidateCount: 1 });
    expect(result.results[0]!.ok).toBe(false);
    expect(result.results[0]!.error).toContain("300002");
    expect(result.results[0]!.error).toContain("north-carolina-candidates:finance:raw:refresh");
  });

  it("preserves stored outside totals when the IE inventories are not cached", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result.outsideAggregationByYear).toEqual([
      expect.objectContaining({ electionYear: 2026, available: false }),
    ]);
    // Direct still syncs; the null outside leg lets the writer preserve.
    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(syncFn.mock.calls[0]![0].outsideFinance).toBeNull();
  });

  it("fails the year's outside leg closed when a selected IE report has no readable artifacts", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    // IE inventories present, but report 400001's artifacts absent.
    await install(cacheDir, { type: "ie_doc_type_inventory", year: 2025 }, makeInventoryHtml([]));
    await install(
      cacheDir,
      { type: "ie_doc_type_inventory", year: 2026 },
      makeInventoryHtml([
        {
          committeeName: "ADVANCE CAROLINA ACTION",
          sboeId: null,
          documentType: "Informational Report",
          reportType: "Independent Expenditure Report",
          imageReceiptDate: "03/01/2026",
          dataImportDate: "03/01/2026",
          periodStartDate: "02/01/2026",
          periodEndDate: "02/28/2026",
          dataLink: "400001",
        },
      ])
    );
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    const outside = result.outsideAggregationByYear[0]!;
    expect(outside.available).toBe(false);
    expect(outside.error).toContain("400001");
    expect(syncFn.mock.calls[0]![0].outsideFinance).toBeNull();
  });

  it("quarantines outside money when a same-name unlinked candidate exists in the universe", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    // The universe query surfaces a DIFFERENT person with the same name in
    // the same chamber and district — an eligible candidate_elections row
    // with no finance link. Every "DOE JANE" IE row is now ambiguous.
    const db = createDb([dueRow()]);
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "99999999-9999-4999-8999-999999999999",
            candidate_name: "Jane Doe",
            office_scope: "state_lower",
            district: "27",
          },
        ],
      });
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      ambiguousTargetCount: 1,
      attributedRowCount: 0,
    });
    // The due candidate gets zeros, never the ambiguous money.
    expect(syncFn.mock.calls[0]![0].outsideFinance).toMatchObject({
      supportTotal: 0,
      opposeTotal: 0,
      groups: [],
    });
  });

  it("keeps attribution on the district the rows confirm when one person contests two districts", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    // Same person, same office scope, a second race in district 3: the
    // district-bearing "NC HOUSE 27" rows must confirm exactly the district
    // 27 target — never both, never the wrong one.
    const db = createDb([dueRow()]);
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "11111111-1111-4111-8111-111111111111",
            candidate_name: "Jane Doe",
            office_scope: "state_lower",
            district: "3",
          },
        ],
      });
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      ambiguousTargetCount: 0,
      attributedRowCount: 2,
    });
    expect(syncFn.mock.calls[0]![0].outsideFinance).toMatchObject({
      supportTotal: 150,
      opposeTotal: 100,
    });
  });

  it("marks a district-less due row's outside slice unavailable when the person has two known districts", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    // The due row's manual link never recorded a district, but the universe
    // shows the same person contesting districts 27 and 3. Neither district
    // may claim the row, and a district-less target would make even the
    // clearly-district-27 IE rows ambiguous — so the row's outside slice is
    // null (writer preserves) while attribution stays on district 27.
    const db = createDb([dueRow({ district: null })]);
    db.query.mockResolvedValueOnce({
      rows: [
        {
          candidate_id: "11111111-1111-4111-8111-111111111111",
          candidate_name: "Jane Doe",
          office_scope: "state_lower",
          district: "27",
        },
        {
          candidate_id: "11111111-1111-4111-8111-111111111111",
          candidate_name: "Jane Doe",
          office_scope: "state_lower",
          district: "3",
        },
      ],
    });
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      ambiguousTargetCount: 0,
      attributedRowCount: 2,
    });
    // Direct finance still syncs; only the outside slice is withheld.
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
    expect(syncFn.mock.calls[0]![0].outsideFinance).toBeNull();
  });

  it("passes dryRun through and skips auto-link on dry runs", async () => {
    const cacheDir = await makeCacheDir();
    await installCommitteeArtifacts(cacheDir);
    await installIeArtifacts(cacheDir);
    const db = createDb([dueRow()]);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    await syncDueNorthCarolinaCandidateFinance({
      db,
      now: new Date("2026-08-07T09:00:00.000Z"),
      dryRun: true,
      rawDataCacheDir: cacheDir,
      syncNorthCarolinaCandidateFinanceFn: syncFn as never,
    });

    // Due list + one outside universe query — no missing-links query, so
    // auto-link never ran despite autoLinkMissingLinks defaulting on.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(syncFn.mock.calls[0]![0].dryRun).toBe(true);
  });
});

describe("createNcsbeCachedCommitteeSearchLoader", () => {
  it("serves parsed rows and provenance from the cached search artifact", async () => {
    const cacheDir = await makeCacheDir();
    const query = northCarolinaCommitteeSearchQueryForCandidateName("  Kimberly Gadson  ");
    expect(query).toBe("Gadson");
    // Live 2026-10-10: the portal's substring search missed most full
    // display names, so the query is the surname alone.
    expect(northCarolinaCommitteeSearchQueryForCandidateName("Danny Earl Britt, Jr.")).toBe("Britt");
    expect(northCarolinaCommitteeSearchQueryForCandidateName("Veleria M. Levy")).toBe("Levy");
    expect(northCarolinaCommitteeSearchQueryForCandidateName("Mary Price (Pricey) Harrison")).toBe("Harrison");
    expect(northCarolinaCommitteeSearchQueryForCandidateName("Gadson, Marcus")).toBe("Gadson");
    expect(northCarolinaCommitteeSearchQueryForCandidateName("Sally Kirby-Turner")).toBe("Kirby-Turner");
    await install(cacheDir, { type: "committee_search", query }, fixture("committee-search-gadson.html"));

    const loader = createNcsbeCachedCommitteeSearchLoader(cacheDir);
    const result = await loader({
      candidateId: "c1",
      electionId: "e1",
      candidateName: "Kimberly Gadson",
      electionYear: 2026,
      electionDate: "2026-11-03",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      district: "33",
    });

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some((row) => row.sboeId === "STA-JV516O-C-001")).toBe(true);
    expect(result.sourceUrl).toContain("cf.ncsbe.gov");
  });

  it("throws (fail-closed) when the candidate's search was never cached", async () => {
    const cacheDir = await makeCacheDir();
    const loader = createNcsbeCachedCommitteeSearchLoader(cacheDir);
    await expect(
      loader({
        candidateId: "c1",
        electionId: "e1",
        candidateName: "Nobody Cached",
        electionYear: 2026,
        electionDate: "2026-11-03",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "1",
      })
    ).rejects.toThrow(/missing/);
  });
});
