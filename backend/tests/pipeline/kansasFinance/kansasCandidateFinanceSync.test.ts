import { describe, expect, it, vi } from "vitest";

import { KANSAS_CFR_LINK_SOURCE_URL } from "../../../src/pipeline/kansasFinance/kansasCandidateFinanceAutoLink.js";
import {
  kansasSnapshotFigures,
  syncKansasCandidateFinance,
  type KansasCandidateFinanceSyncInput,
} from "../../../src/pipeline/kansasFinance/kansasCandidateFinanceSync.js";
import type { KansasCandidateLedgerResult, KansasCandidateReport } from "../../../src/pipeline/kansasFinance/kansasCandidateLedger.js";
import type { KansasReportCover, KansasScheduleARow, KansasScheduleBRow } from "../../../src/pipeline/kansasFinance/kansasCfrViewerParsers.js";
import type { KansasDirectFinance } from "../../../src/pipeline/kansasFinance/kansasDirectContributionAggregator.js";
import { kansasCfrOfficeForRace } from "../../../src/pipeline/kansasFinance/kansasFinanceEligibleOffices.js";
import type { KansasOutsideRow } from "../../../src/pipeline/kansasFinance/kansasOutsideSpendingAggregator.js";
import type { KansasPaperCoverOverride } from "../../../src/pipeline/kansasFinance/kansasPaperCoverOverrides.js";
import {
  buildKansasReportLedger,
  kansasLastMinuteWindows,
  kansasReportingPeriods,
  type KansasFilingHeader,
} from "../../../src/pipeline/kansasFinance/kansasReportInventory.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOUSE = kansasCfrOfficeForRace({ officeScope: "state_lower", officeCanonicalName: "State Lower Chamber Legislator" })!;
const periods = kansasReportingPeriods(HOUSE, 2026);
const ANNUAL = { periodStart: "1/1/2025", periodEnd: "12/31/2025" };
const PRE_PRIMARY = { periodStart: "1/1/2026", periodEnd: "7/23/2026" };

function header(overrides: Partial<KansasFilingHeader> & Pick<KansasFilingHeader, "periodStart" | "periodEnd">): KansasFilingHeader {
  return { fileDate: "01/09/2026", amendmentDate: null, amended: false, termination: false, channel: "efile", ...overrides };
}

// Synthetic contributors on purpose (25-4154(d) posture).
let rowIndex = 0;
function aRow(overrides: Partial<KansasScheduleARow> & Pick<KansasScheduleARow, "amountCents">): KansasScheduleARow {
  rowIndex += 1;
  return {
    index: rowIndex,
    date: "03/01/26",
    contributorName: "Example Person",
    addressLines: ["1 Example St", "Sampleton KS 66000"],
    zip: "66000",
    tenderType: "Check",
    occupation: "",
    primaryTotalCents: overrides.amountCents,
    generalTotalCents: 0,
    ...overrides,
  };
}
function bRow(overrides: Partial<KansasScheduleBRow> & Pick<KansasScheduleBRow, "valueCents">): KansasScheduleBRow {
  rowIndex += 1;
  return {
    index: rowIndex,
    date: "03/01/26",
    contributorName: "Example Person",
    addressLines: ["1 Example St", "Sampleton KS 66000"],
    zip: "66000",
    occupation: "",
    description: "Food and Drink",
    ...overrides,
  };
}

/** An opened e-filed report whose cover and both schedules reconcile (line 2 = A rows + unitemized, line 6 = B rows). */
function report(
  filing: KansasFilingHeader,
  input: { begin: number; spent: number; rowsA?: KansasScheduleARow[]; unitemizedA?: number; rowsB?: KansasScheduleBRow[] }
): KansasCandidateReport {
  const rowsA = input.rowsA ?? [];
  const rowsB = input.rowsB ?? [];
  const itemizedA = rowsA.reduce((sum, row) => sum + row.amountCents!, 0);
  const inKind = rowsB.reduce((sum, row) => sum + row.valueCents!, 0);
  const receipts = itemizedA + (input.unitemizedA ?? 0);
  const cover: KansasReportCover = {
    candidateName: "HOLLOWAY MARGARET",
    officeSought: "State Representative",
    district: "85",
    periodStart: filing.periodStart,
    periodEnd: filing.periodEnd,
    amended: false,
    termination: false,
    electronicallyFiledOn: null,
    cashBeginningCents: input.begin,
    totalContributionsCents: receipts,
    cashAvailableCents: input.begin + receipts,
    totalExpendituresCents: input.spent,
    cashCloseCents: input.begin + receipts - input.spent,
    inKindCents: inKind,
    otherTransactionsCents: 0,
  };
  return {
    row: {
      index: 0,
      fileDate: filing.fileDate!,
      amendmentDate: "",
      amendmentNo: "",
      name: "HOLLOWAY MARGARET",
      officeSought: "State Representative",
      district: "85",
      channel: "efile",
      postbackTarget: "grdviewCfrResults$ctl02$lnkbtnName",
    },
    cover,
    header: filing,
    scheduleA: {
      rows: { rows: rowsA, malformedRowCount: 0 },
      totals: {
        totalItemizedCents: itemizedA,
        totalUnitemizedCents: input.unitemizedA ?? 0,
        politicalMaterialsCents: 0,
        contributorUnknownCents: 0,
        totalReceiptsCents: receipts,
      },
    },
    scheduleB: {
      rows: { rows: rowsB, malformedRowCount: 0 },
      totals: { totalItemizedCents: inKind, totalUnitemizedCents: 0, totalInKindCents: inKind },
    },
  };
}

function resolved(
  reports: KansasCandidateReport[],
  extra: { affidavitDates?: string[]; complete?: boolean; paperHeaders?: KansasFilingHeader[]; paperFileNames?: string[] } = {}
): KansasCandidateLedgerResult {
  const paperHeaders = extra.paperHeaders ?? [];
  const ledger = buildKansasReportLedger({
    periods,
    filings: [...reports.map((entry) => entry.header), ...paperHeaders],
    appointmentsOfTreasurer: [],
    affidavitDates: extra.affidavitDates ?? [],
    lastMinuteWindows: kansasLastMinuteWindows(2026),
    now: NOW,
  });
  return {
    status: "resolved",
    match: { surname: "HOLLOWAY", firstName: "MARGARET", committeeName: "HOLLOWAY MARGARET", filedNames: ["HOLLOWAY MARGARET"], rowCount: reports.length, confidence: "name_exact" },
    reports,
    // The KPDC inventory exists only for a candidate the viewer shows paper rows for (one per version here).
    paperReports: paperHeaders.map(() => ({ channel: "paper" }) as never),
    paper:
      paperHeaders.length === 0
        ? null
        : {
            status: "resolved",
            filedNames: ["Holloway, Margaret"],
            headers: paperHeaders,
            fileNames: extra.paperFileNames ?? ["H085MH_AT.pdf", "H085MH_202607.pdf"],
            explainedByEfile: 0,
            lastMinute: 0,
            skipped: 1,
            unmapped: [],
          },
    appointments: [],
    affidavitDates: extra.affidavitDates ?? [],
    ledger,
    complete: extra.complete ?? ledger.complete,
  };
}

/** The two filed periods of a complete House 2026 ledger on 2026-09-02: a loan, two occupations, one in-kind row. */
function filedReports(): KansasCandidateReport[] {
  return [
    report(header({ ...ANNUAL }), { begin: 0, spent: 1_000, rowsA: [aRow({ amountCents: 20_000, occupation: "Retired" })], unitemizedA: 5_000 }),
    report(header({ ...PRE_PRIMARY, fileDate: "07/27/2026" }), {
      begin: 24_000,
      spent: 50_000,
      rowsA: [aRow({ amountCents: 100_000, tenderType: "Loan" }), aRow({ amountCents: 15_000, occupation: "Farmer" })],
      rowsB: [bRow({ valueCents: 3_000, occupation: "retired" })],
    }),
  ];
}

function writingDb() {
  const client = {
    query: vi.fn((sql: unknown) =>
      String(sql).includes("INSERT INTO public.ks_candidate_finance_links")
        ? Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ),
    release: vi.fn(),
  };
  const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
  return { db, client };
}

function baseInput(db: { query: unknown; connect: unknown }, ledger: KansasCandidateLedgerResult): {
  input: KansasCandidateFinanceSyncInput;
  buildLedger: ReturnType<typeof vi.fn>;
} {
  const buildLedger = vi.fn(async () => ledger);
  const loadFilingPool = vi.fn();
  const loadKpdcRows = vi.fn();
  return {
    buildLedger,
    input: {
      db: db as never,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      candidateName: "Margaret Holloway",
      electionYear: 2026,
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      district: "85",
      link: { committeeId: "7:85:HOLLOWAY:MARGARET", committeeName: "HOLLOWAY MARGARET", linkSource: "manual", sourceUrl: null },
      now: NOW,
      loadFilingPool: loadFilingPool as never,
      loadKpdcRows: loadKpdcRows as never,
      loadOutsideRows: vi.fn(async () => []),
      buildLedger: buildLedger as never,
    },
  };
}

/** A transcribed IE row against the test candidate (synthetic filer and vendor). */
function ieRow(
  overrides: Partial<KansasOutsideRow> & Pick<KansasOutsideRow, "sourceFileName" | "rowIndex" | "amountCents" | "statementTotalCents">
): KansasOutsideRow {
  return {
    filerName: "Example Fund",
    sourceUrl: `https://www.kansas.gov/ethics/CFAScanned/Others/2026ElecCycle/202607/${overrides.sourceFileName}`,
    periodDueKey: "202607",
    filingKey: null,
    rowDate: "2026-07-01",
    vendorName: "Example Vendor LLC",
    targetCommitteeId: "7:85:HOLLOWAY:MARGARET",
    namedCommitteeIds: [],
    targetAsFiled: "KS HD 85 Margaret Holloway",
    supportOppose: "oppose",
    ...overrides,
  };
}

function expectOutsidePreserved(client: ReturnType<typeof writingDb>["client"]) {
  const summaryCall = client.query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"),
  );
  const summarySql = summaryCall?.[0];
  expect(summaryCall?.[1]?.slice(6, 8)).toEqual([null, null]);
  expect(String(summarySql)).toContain(
    "outside_support_total = COALESCE(EXCLUDED.outside_support_total, ks_candidate_finance_summaries.outside_support_total)",
  );
  expect(String(summarySql)).toContain(
    "outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, ks_candidate_finance_summaries.outside_oppose_total)",
  );
  expect(
    client.query.mock.calls.some(([sql]) =>
      /DELETE FROM public\.ks_candidate_finance_outside_(?:groups|group_breakdowns)/.test(String(sql)),
    ),
  ).toBe(false);
}
describe("syncKansasCandidateFinance", () => {
  it("builds the ledger with schedules, aggregates, and writes totals + buckets (direct = line 2 + line 6 − loans)", async () => {
    const { db, client } = writingDb();
    const { input, buildLedger } = baseInput(db, resolved(filedReports()));

    const result = await syncKansasCandidateFinance(input);

    expect(buildLedger).toHaveBeenCalledWith({
      target: { committeeId: "7:85:HOLLOWAY:MARGARET", committeeName: "HOLLOWAY MARGARET", office: HOUSE, electionYear: 2026 },
      now: NOW,
      loadFilingPool: input.loadFilingPool,
      loadKpdcRows: input.loadKpdcRows,
      openSchedules: true,
    });
    expect(result).toMatchObject({
      status: "synced",
      dryRun: false,
      committeeId: "7:85:HOLLOWAY:MARGARET",
      periods: { "2025-annual": "report_filed", "2026-pre_primary": "report_filed" },
      totalReceipts: 1400,
      directContributionTotal: 430,
      totalDisbursements: 510,
      cashOnHand: 890,
      coverage: { contributionCents: 38_000, occupationCoveredCents: 38_000, unitemizedCents: 5_000, nonContributionReceiptCents: 100_000 },
      breakdownCounts: { occupation: 2, contribution_size: 2 },
      diagnostics: [],
      outside: { status: "none_found" },
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 0,
    });

    const linkInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_links"));
    expect(linkInsert?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "MARGARET HOLLOWAY",
      "State Lower Chamber Legislator",
      "85",
      "7:85:HOLLOWAY:MARGARET",
      "HOLLOWAY MARGARET",
      "active",
      "manual",
      KANSAS_CFR_LINK_SOURCE_URL,
      NOW.toISOString(),
    ]);
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summaryInsert?.[1]).toEqual([LINK_ID, 2026, 1400, 430, 510, 890, null, null, KANSAS_CFR_LINK_SOURCE_URL, NOW.toISOString()]);
    const breakdowns = client.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_direct_breakdowns"))
      .map(([, params]) => (params as unknown[]).slice(2, 5));
    expect(breakdowns).toEqual([
      ["occupation", "Retired", 230],
      ["occupation", "Farmer", 150],
      ["contribution_size", "$1-$99", 30],
      ["contribution_size", "$100-$249", 350],
    ]);
    // No outside evidence: neither a synthetic zero nor deletion of prior groups.
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_outside_groups"))).toBe(false);
    expectOutsidePreserved(client);
  });

  it("writes outside totals and one group per filer and direction from the transcribed IE rows naming the recipe", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved(filedReports()));
    const rows: KansasOutsideRow[] = [
      ieRow({ sourceFileName: "IE_EX1_2607.pdf", rowIndex: 1, amountCents: 6_000, statementTotalCents: 10_000 }),
      // A shared row naming two OTHER candidates: it feeds the filer's checksum, not this candidate.
      ieRow({ sourceFileName: "IE_EX1_2607.pdf", rowIndex: 2, amountCents: 4_000, statementTotalCents: 10_000, targetCommitteeId: null, supportOppose: null, namedCommitteeIds: ["7:2:MUIR:DANIEL", "7:3:EXAMPLE:CHRIS"], targetAsFiled: "KS HD 2 Daniel Muir; KS HD 3 Chris Example" }),
      ieRow({ sourceFileName: "IE_OF_2607.pdf", rowIndex: 1, amountCents: 25_000, statementTotalCents: 25_000, filerName: "Other Fund", supportOppose: "support", targetCommitteeId: " 7:85:holloway:margaret " }),
      ieRow({ sourceFileName: "IE_ZZ_2607.pdf", rowIndex: 1, amountCents: 99_900, statementTotalCents: 99_900, filerName: "Unrelated Fund", targetCommitteeId: "7:2:MUIR:DANIEL" }),
    ];
    const loadOutsideRows = vi.fn(async () => rows);

    const result = await syncKansasCandidateFinance({ ...input, loadOutsideRows });

    expect(loadOutsideRows).toHaveBeenCalledWith(2026);
    expect(result).toMatchObject({
      status: "synced",
      totalReceipts: 1400,
      outside: { status: "ok", supportTotal: 250, opposeTotal: 60, groupCount: 2, statementCount: 2 },
      outsideGroupsWritten: 2,
    });
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summaryInsert?.[1]).toEqual([LINK_ID, 2026, 1400, 430, 510, 890, 250, 60, KANSAS_CFR_LINK_SOURCE_URL, NOW.toISOString()]);
    const groupInserts = client.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_outside_groups"))
      .map(([, params]) => params as unknown[]);
    expect(groupInserts).toHaveLength(2);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.ks_candidate_finance_outside_groups"))).toBe(true);
    expect(groupInserts[0]).toEqual(expect.arrayContaining(["IE:EXAMPLE FUND", "Example Fund", "oppose", 60]));
    expect(groupInserts[1]).toEqual(expect.arrayContaining(["IE:OTHER FUND", "Other Fund", "support", 250]));
  });

  it("preserves outside on a rejected checksum while syncing valid direct totals", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved(filedReports()));
    const loadOutsideRows = vi.fn(async () => [ieRow({ sourceFileName: "IE_EX1_2607.pdf", rowIndex: 1, amountCents: 6_000, statementTotalCents: 10_000 })]);

    const result = await syncKansasCandidateFinance({ ...input, loadOutsideRows });

    expect(result).toMatchObject({
      status: "synced",
      totalReceipts: 1400,
      outside: {
        status: "unpublishable",
        reasons: [
          "Example Fund 202607: IE_EX1_2607.pdf rows 6000 != Total this Period 10000 (read as one filing)" +
            " and running total 6000 != IE_EX1_2607.pdf Total this Period 10000 (read as cumulative)",
        ],
      },
      summaryWritten: true,
      outsideGroupsWritten: 0,
    });
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summaryInsert?.[1]?.slice(6, 8)).toEqual([null, null]);
    expectOutsidePreserved(client);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_outside_groups"))).toBe(false);
  });

  it("preserves outside for shared spending with no per-candidate allocation", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved(filedReports()));
    const loadOutsideRows = vi.fn(async () => [
      ieRow({ sourceFileName: "IE_EX1_2607.pdf", rowIndex: 1, amountCents: 6_000, statementTotalCents: 10_000 }),
      ieRow({ sourceFileName: "IE_EX1_2607.pdf", rowIndex: 2, amountCents: 4_000, statementTotalCents: 10_000, targetCommitteeId: null, supportOppose: null, namedCommitteeIds: ["7:85:HOLLOWAY:MARGARET", "7:2:MUIR:DANIEL"], targetAsFiled: "KS HD 85 Margaret Holloway; KS HD 2 Daniel Muir" }),
    ]);
    const result = await syncKansasCandidateFinance({ ...input, loadOutsideRows });
    expect(result).toMatchObject({
      status: "synced",
      outside: { status: "partial_unallocated", reasons: ["IE_EX1_2607.pdf row 2: 4000 cents across 2 candidates with no per-candidate amount"] },
      outsideGroupsWritten: 0,
    });
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summaryInsert?.[1]?.slice(6, 8)).toEqual([null, null]);
    expectOutsidePreserved(client);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_outside_groups"))).toBe(false);
  });

it("isolates outside loader failure and preserves its rows while writing valid direct totals", async () => {
  const { db, client } = writingDb();
  const { input } = baseInput(db, resolved(filedReports()));
  const result = await syncKansasCandidateFinance({
    ...input,
    loadOutsideRows: vi.fn(async () => {
      throw new Error("transcribed IE source unavailable");
    }),
  });
  expect(result).toMatchObject({
    status: "synced",
    totalReceipts: 1400,
    directContributionTotal: 430,
    summaryWritten: true,
    outside: { status: "unavailable", reasons: ["transcribed IE source unavailable"] },
  });
  expect(result.diagnostics).toContain("outside unavailable: transcribed IE source unavailable");
  expectOutsidePreserved(client);
  expect(
    client.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO public.ks_candidate_finance_direct_breakdowns"),
    ),
  ).toBe(true);
  expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
});

it("keeps genuine direct filed-zero handling while outside evidence is absent", async () => {
  const { db, client } = writingDb();
  const reports = [
    report(header({ ...ANNUAL }), { begin: 0, spent: 0 }),
    report(header({ ...PRE_PRIMARY, fileDate: "07/27/2026" }), { begin: 0, spent: 0 }),
  ];
  const { input } = baseInput(db, resolved(reports));
  const result = await syncKansasCandidateFinance(input);
  expect(result).toMatchObject({
    status: "synced",
    totalReceipts: 0,
    directContributionTotal: 0,
    outside: { status: "none_found" },
  });
  expectOutsidePreserved(client);
  expect(
    client.query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM public.ks_candidate_finance_direct_breakdowns"),
    ),
  ).toBe(true);
});

it("rolls the valid direct write back when accepted outside insertion fails", async () => {
  const { db, client } = writingDb();
  client.query.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes("INSERT INTO public.ks_candidate_finance_links"))
      return { rows: [{ id: LINK_ID }], rowCount: 1 };
    if (String(sql).includes("INSERT INTO public.ks_candidate_finance_outside_groups"))
      throw new Error("outside SQL failure");
    return { rows: [], rowCount: 0 };
  });
  const { input } = baseInput(db, resolved(filedReports()));
  await expect(
    syncKansasCandidateFinance({
      ...input,
      loadOutsideRows: vi.fn(async () => [
        ieRow({ sourceFileName: "IE_EX1_2607.pdf", rowIndex: 1, amountCents: 6000, statementTotalCents: 6000 }),
      ]),
    }),
  ).rejects.toThrow("outside SQL failure");
  expect(
    client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries")),
  ).toBe(true);
  expect(
    client.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO public.ks_candidate_finance_direct_breakdowns"),
    ),
  ).toBe(true);
  expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  expect(client.release).toHaveBeenCalledOnce();
});
  it("does not read the outside rows for a candidate whose direct leg fails closed", async () => {
    const { db } = writingDb();
    const { input } = baseInput(db, resolved(filedReports(), { complete: false }));
    const loadOutsideRows = vi.fn(async () => []);
    await expect(syncKansasCandidateFinance({ ...input, loadOutsideRows })).rejects.toThrow("unpublishable");
    expect(loadOutsideRows).not.toHaveBeenCalled();
  });

  it("writes null figures (never $0) when every period is affidavit-exempt", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved([], { affidavitDates: ["01/05/2026"] }));
    const result = await syncKansasCandidateFinance(input);
    expect(result).toMatchObject({
      status: "no_filed_report",
      periods: { "2025-annual": "affidavit_exempt", "2026-pre_primary": "affidavit_exempt" },
      totalReceipts: null,
      directContributionTotal: null,
      totalDisbursements: null,
      cashOnHand: null,
      coverage: null,
      breakdownCounts: { occupation: 0, contribution_size: 0 },
      summaryWritten: true,
      directBreakdownsWritten: 0,
    });
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summaryInsert?.[1]?.slice(2, 6)).toEqual([null, null, null, null]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.ks_candidate_finance_direct_breakdowns"))).toBe(true);
  });

  it("fails closed without touching the database when the candidate is unpublishable", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved(filedReports(), { complete: false }));
    await expect(syncKansasCandidateFinance(input)).rejects.toThrow("unpublishable: ledger incomplete");
    expect(client.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("fails closed when the link no longer resolves or the office is not eligible", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, { status: "unresolved", reason: "no_matching_filer" });
    await expect(syncKansasCandidateFinance(input)).rejects.toThrow("7:85:HOLLOWAY:MARGARET does not resolve in the viewer: no_matching_filer");
    await expect(syncKansasCandidateFinance({ ...input, officeScope: "county", officeName: "County Attorney" })).rejects.toThrow("not Kansas-finance eligible");
    await expect(syncKansasCandidateFinance({ ...input, electionYear: 2023 })).rejects.toThrow("invalid election year");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("dry run aggregates without touching the database", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved(filedReports()));
    const result = await syncKansasCandidateFinance({ ...input, dryRun: true });
    expect(result).toMatchObject({ status: "synced", dryRun: true, totalReceipts: 1400, directContributionTotal: 430, summaryWritten: false, directBreakdownsWritten: 0 });
    expect(client.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  // A paper filer: the 2025 annual e-filed, the pre-primary a KPDC scan (the ledger's date-less paper version).
  const PAPER_PRE_PRIMARY: KansasFilingHeader = {
    periodStart: "2026-01-01",
    periodEnd: "2026-07-23",
    fileDate: null,
    amendmentDate: null,
    amended: false,
    amendmentOrdinal: null,
    termination: false,
    channel: "paper",
  };
  const annualEfiled = () =>
    report(header({ ...ANNUAL }), { begin: 0, spent: 1_000, rowsA: [aRow({ amountCents: 20_000, occupation: "Retired" })], unitemizedA: 5_000 });
  /** Transcribed pre-primary cover: begins at the annual's close ($240), $500 in, $50 out. */
  const transcribed = (fileName: string): KansasPaperCoverOverride => ({
    committeeId: "7:85:HOLLOWAY:MARGARET",
    electionYear: 2026,
    sourceFileName: fileName,
    sourceUrl: `https://www.kansas.gov/ethics/CFAScanned/House/2026ElecCycle/${fileName}`,
    cashBeginningCents: 24_000,
    totalContributionsCents: 50_000,
    cashAvailableCents: 74_000,
    totalExpendituresCents: 5_000,
    cashCloseCents: 69_000,
    inKindCents: 0,
    otherTransactionsCents: null,
  });

  it("stands a transcribed cover in for a canonical paper version: totals only, no direct total, no buckets", async () => {
    const { db, client } = writingDb();
    const { input } = baseInput(db, resolved([annualEfiled()], { paperHeaders: [PAPER_PRE_PRIMARY] }));
    const loadPaperCovers = vi.fn(async () => [transcribed("H085MH_202607.pdf")]);

    const result = await syncKansasCandidateFinance({ ...input, loadPaperCovers });

    expect(loadPaperCovers).toHaveBeenCalledWith("7:85:HOLLOWAY:MARGARET", 2026);
    expect(result).toMatchObject({
      status: "synced",
      periods: { "2025-annual": "report_filed", "2026-pre_primary": "report_filed" },
      totalReceipts: 750,
      directContributionTotal: null,
      totalDisbursements: 60,
      cashOnHand: 690,
      coverage: null,
      breakdownCounts: { occupation: 0, contribution_size: 0 },
      diagnostics: [
        "no breakdowns: schedules not opened for 2026-pre_primary",
        "no breakdowns: direct contribution total not reported",
        "transcribed paper covers: H085MH_202607.pdf",
      ],
      summaryWritten: true,
      directBreakdownsWritten: 0,
    });
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summaryInsert?.[1]).toEqual([LINK_ID, 2026, 750, null, 60, 690, null, null, KANSAS_CFR_LINK_SOURCE_URL, NOW.toISOString()]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_direct_breakdowns"))).toBe(false);
  });

  it("fails closed when the canonical paper version has no transcribed cover, and consults the table only for paper rows", async () => {
    const { db, client } = writingDb();
    const paperFiler = resolved([annualEfiled()], { paperHeaders: [PAPER_PRE_PRIMARY] });
    await expect(
      syncKansasCandidateFinance({ ...baseInput(db, paperFiler).input, loadPaperCovers: vi.fn(async () => []) })
    ).rejects.toThrow("unpublishable: 2026-pre_primary: no opened cover for the canonical paper version");

    // The ledger counts the amendment; a transcribed ORIGINAL does not stand in for it.
    const amended = resolved([annualEfiled()], { paperHeaders: [PAPER_PRE_PRIMARY, { ...PAPER_PRE_PRIMARY, amended: true, amendmentOrdinal: 1 }] });
    expect(amended.status === "resolved" && amended.ledger.entries[1]!.status).toBe("amended");
    await expect(
      syncKansasCandidateFinance({ ...baseInput(db, amended).input, loadPaperCovers: vi.fn(async () => [transcribed("H085MH_202607.pdf")]) })
    ).rejects.toThrow("unpublishable: 2026-pre_primary: no opened cover for the canonical paper version");

    // An operator row that names no report of the cycle is an error, not a silent skip.
    await expect(
      syncKansasCandidateFinance({ ...baseInput(db, paperFiler).input, loadPaperCovers: vi.fn(async () => [transcribed("H085MH_AT.pdf")]) })
    ).rejects.toThrow("transcribed cover H085MH_AT.pdf: not a report of a required period");

    // Another candidate's scan of the same period builds the same header key; the tree's ownership rejects it.
    await expect(
      syncKansasCandidateFinance({ ...baseInput(db, paperFiler).input, loadPaperCovers: vi.fn(async () => [transcribed("H058AS_202607.pdf")]) })
    ).rejects.toThrow("transcribed cover H058AS_202607.pdf: not among the 2 scans the KPDC tree lists for this candidate");
    expect(client.query).not.toHaveBeenCalled();

    // No viewer paper rows: the table is never read.
    const untouched = vi.fn(async () => []);
    await syncKansasCandidateFinance({ ...baseInput(db, resolved(filedReports())).input, loadPaperCovers: untouched, dryRun: true });
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe("kansasSnapshotFigures", () => {
  const ok = (overrides: Partial<Extract<KansasDirectFinance, { status: "ok" }>> = {}): KansasDirectFinance => ({
    status: "ok",
    totalReceiptsCents: 140_000,
    totalDisbursementsCents: 51_000,
    inKindCents: 3_000,
    cashOnHandCents: null,
    itemized: { contributionCents: 38_000, occupationCoveredCents: 38_000, unitemizedCents: 5_000, nonContributionReceiptCents: 100_000, breakdowns: [] },
    diagnostics: ["cash on hand -1 is negative; reported as null"],
    periods: [],
    ...overrides,
  });

  it("reports no direct total when a counted cover came without schedules", () => {
    expect(kansasSnapshotFigures(ok({ itemized: null }))).toMatchObject({
      status: "synced",
      summary: { totalReceipts: 1400, directContributionTotal: null, totalDisbursements: 510, cashOnHand: null },
      coverage: null,
      diagnostics: ["cash on hand -1 is negative; reported as null", "no breakdowns: direct contribution total not reported"],
    });
  });

  it("refuses negative figures", () => {
    expect(() =>
      kansasSnapshotFigures(ok({ itemized: { contributionCents: 0, occupationCoveredCents: 0, unitemizedCents: 0, nonContributionReceiptCents: 150_000, breakdowns: [] } }))
    ).toThrow("direct contribution total is negative");
    expect(() => kansasSnapshotFigures(ok({ totalReceiptsCents: -1 }))).toThrow("total receipts is negative");
    expect(() => kansasSnapshotFigures({ status: "unpublishable", reasons: ["a", "b"], periods: [] })).toThrow("unpublishable: a; b");
  });
});
