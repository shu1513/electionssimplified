import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  syncDueOhioCandidateFinance,
  type OhioCandidateFinanceDueRow,
} from "../../../src/pipeline/ohioFinance/ohioCandidateFinanceBatchSync.js";
import type { OhioSos31uDetailRow } from "../../../src/pipeline/ohioFinance/ohioSos31uDetail.js";
import {
  OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER,
  OHIO_SOS_CANDIDATE_COVER_HEADER,
  OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER,
  OHIO_SOS_PAC_CONTRIBUTIONS_HEADER,
  OHIO_SOS_PAC_COVER_HEADER,
  OHIO_SOS_PAC_EXPENDITURES_HEADER,
  OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER,
  OHIO_SOS_PARTY_COVER_HEADER,
  OHIO_SOS_PARTY_EXPENDITURES_HEADER,
  type OhioSosCandidateCommitteeListRow,
} from "../../../src/pipeline/ohioFinance/ohioSosBulkFiles.js";

const SOURCE_URL = "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:73";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-oh-cycle-"));
  tempDirs.push(dir);
  return dir;
}

// Windows-1252 bytes with CR-only row separators — the real portal format
// the PR 4 parser pins.
async function writeBulkCsv(input: {
  cacheDir: string;
  fileName: string;
  header: readonly string[];
  rows: ReadonlyArray<Record<string, string>>;
}): Promise<void> {
  const lines = [
    input.header.join(","),
    ...input.rows.map((row) => input.header.map((column) => row[column] ?? "").join(",")),
  ];
  // The parser treats a file without a trailing row separator as truncated.
  await writeFile(join(input.cacheDir, input.fileName), `${lines.join("\r")}\r`, "latin1");
}

function detailRow(overrides: Partial<OhioSos31uDetailRow> = {}): OhioSos31uDetailRow {
  return {
    reportKey: "501544249",
    spenderCommitteeName: "NFIB OHIO PAC",
    payeeName: null,
    payeeNonIndividual: "NFIB",
    payeeAddress: null,
    payeeCity: null,
    payeeState: null,
    payeeZip: null,
    reportType: "POST-PRIMARY",
    amountCents: 100_000,
    year: 2026,
    expendDateIso: "2026-06-03",
    eventDateIso: null,
    purpose: null,
    office: "HOUSE",
    candidateNameOrBallotIssue: "DANIEL KALMBACH",
    direction: "support",
    rawDirection: "SUPPORT",
    ...overrides,
  };
}

// The complete 2026-cycle artifact set for one linked candidate committee
// (15877) plus one outside 31-U report (spender 1792 → report 501544249).
async function writeCycleArtifacts(cacheDir: string): Promise<void> {
  await writeBulkCsv({
    cacheDir,
    fileName: "CAC_CON_2025.CSV",
    header: OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER,
    rows: [
      {
        COM_NAME: "CITIZENS FOR KALMBACH",
        MASTER_KEY: "15877",
        RPT_YEAR: "2025",
        REPORT_KEY: "100",
        SHORT_DESCRIPTION: "31-A  Stmt of Contribution",
        FIRST_NAME: "JANE",
        LAST_NAME: "DOE",
        AMOUNT: "250",
        FILE_DATE: "10/15/2025",
      },
    ],
  });
  await writeBulkCsv({
    cacheDir,
    fileName: "CAC_CON_2026.CSV",
    header: OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER,
    rows: [
      {
        COM_NAME: "CITIZENS FOR KALMBACH",
        MASTER_KEY: "15877",
        RPT_YEAR: "2026",
        REPORT_KEY: "200",
        SHORT_DESCRIPTION: "31-A  Stmt of Contribution",
        NON_INDIVIDUAL: "BUCKEYE BUILDERS LLC",
        AMOUNT: "5000",
        FILE_DATE: "04/28/2026",
      },
      {
        COM_NAME: "CITIZENS FOR KALMBACH",
        MASTER_KEY: "15877",
        RPT_YEAR: "2026",
        REPORT_KEY: "200",
        SHORT_DESCRIPTION: "31-A-2 Other Income",
        NON_INDIVIDUAL: "BANK INTEREST",
        AMOUNT: "100",
        FILE_DATE: "04/28/2026",
      },
    ],
  });
  await writeBulkCsv({
    cacheDir,
    fileName: "CAN_COVER.CSV",
    header: OHIO_SOS_CANDIDATE_COVER_HEADER,
    rows: [
      {
        COM_NAME: "CITIZENS FOR KALMBACH",
        MASTER_KEY: "15877",
        CANDIDATE_FIRST_NAME: "DANIEL",
        CANDIDATE_LAST_NAME: "KALMBACH",
        REPORT_KEY: "100",
        RPT_YEAR: "2025",
        REPORT_DESCRIPTION: "ANNUAL",
        DATE_REPORT_FILED: "01/31/2026",
        AMT_FORWARD: "0",
        TOTAL_CONTRIBUTIONS: "250",
        TOTAL_OTHER_INCOME: "0",
        TOTAL_FUNDS: "250",
        TOTAL_EXPENDITURES: "100",
        BALANCE_ON_HAND: "150",
        VALUE_INKIND_RECEIVED: "0",
        VALUE_INKIND_MADE: "0",
        OUTSTANDING_LOANS_OWED: "0",
        OUTSTANDING_DEBT_OWED: "0",
        OUTSTANDING_LOANS_TO: "0",
        VALUE_IND_EXPENDITURES: "0",
      },
      {
        COM_NAME: "CITIZENS FOR KALMBACH",
        MASTER_KEY: "15877",
        CANDIDATE_FIRST_NAME: "DANIEL",
        CANDIDATE_LAST_NAME: "KALMBACH",
        REPORT_KEY: "200",
        RPT_YEAR: "2026",
        REPORT_DESCRIPTION: "POST-PRIMARY",
        DATE_REPORT_FILED: "06/15/2026",
        AMT_FORWARD: "150",
        TOTAL_CONTRIBUTIONS: "5000",
        TOTAL_OTHER_INCOME: "100",
        TOTAL_FUNDS: "5250",
        TOTAL_EXPENDITURES: "1000",
        BALANCE_ON_HAND: "4250",
        VALUE_INKIND_RECEIVED: "0",
        VALUE_INKIND_MADE: "0",
        OUTSTANDING_LOANS_OWED: "0",
        OUTSTANDING_DEBT_OWED: "0",
        OUTSTANDING_LOANS_TO: "0",
        VALUE_IND_EXPENDITURES: "0",
      },
    ],
  });

  for (const fileName of ["CAC_EXP_2025.CSV", "CAC_EXP_2026.CSV"]) {
    await writeBulkCsv({
      cacheDir,
      fileName,
      header: OHIO_SOS_CANDIDATE_EXPENDITURES_HEADER,
      rows: [],
    });
  }
  await writeBulkCsv({
    cacheDir,
    fileName: "PAC_EXP_2025.CSV",
    header: OHIO_SOS_PAC_EXPENDITURES_HEADER,
    rows: [],
  });
  await writeBulkCsv({
    cacheDir,
    fileName: "PAC_EXP_2026.CSV",
    header: OHIO_SOS_PAC_EXPENDITURES_HEADER,
    rows: [
      {
        COM_NAME: "NFIB OHIO PAC",
        MASTER_KEY: "1792",
        RPT_YEAR: "2026",
        REPORT_KEY: "501544249",
        REPORT_DESCRIPTION: "POST-PRIMARY",
        SHORT_DESCRIPTION: "31-U  Ind Exp by committee",
        NON_INDIVIDUAL: "NFIB",
        EXPEND_DATE: "06/03/2026",
        AMOUNT: "1000",
      },
    ],
  });
  for (const fileName of ["PPC_EXP_2025.CSV", "PPC_EXP_2026.CSV"]) {
    await writeBulkCsv({
      cacheDir,
      fileName,
      header: OHIO_SOS_PARTY_EXPENDITURES_HEADER,
      rows: [],
    });
  }

  // Funder-leg sources (PR 8): who funds spender 1792.
  await writeBulkCsv({
    cacheDir,
    fileName: "PAC_CON_2025.CSV",
    header: OHIO_SOS_PAC_CONTRIBUTIONS_HEADER,
    rows: [],
  });
  await writeBulkCsv({
    cacheDir,
    fileName: "PAC_CON_2026.CSV",
    header: OHIO_SOS_PAC_CONTRIBUTIONS_HEADER,
    rows: [
      {
        COM_NAME: "NFIB OHIO PAC",
        MASTER_KEY: "1792",
        RPT_YEAR: "2026",
        REPORT_KEY: "501544249",
        SHORT_DESCRIPTION: "31-A  Stmt of Contribution",
        NON_INDIVIDUAL: "MAIN STREET ALLIANCE LLC",
        AMOUNT: "2500",
        FILE_DATE: "05/01/2026",
      },
      {
        // Individual member dues — never a donor label.
        COM_NAME: "NFIB OHIO PAC",
        MASTER_KEY: "1792",
        RPT_YEAR: "2026",
        REPORT_KEY: "501544249",
        SHORT_DESCRIPTION: "31-A  Stmt of Contribution",
        FIRST_NAME: "SAM",
        LAST_NAME: "OWNER",
        AMOUNT: "50",
        FILE_DATE: "05/02/2026",
      },
    ],
  });
  for (const fileName of ["PPC_CON_2025.CSV", "PPC_CON_2026.CSV"]) {
    await writeBulkCsv({
      cacheDir,
      fileName,
      header: OHIO_SOS_PARTY_CONTRIBUTIONS_HEADER,
      rows: [],
    });
  }

  await writeBulkCsv({
    cacheDir,
    fileName: "PAC_COV.CSV",
    header: OHIO_SOS_PAC_COVER_HEADER,
    rows: [
      {
        COM_NAME: "NFIB OHIO PAC",
        MASTER_KEY: "1792",
        REPORT_KEY: "501544249",
        RPT_YEAR: "2026",
        REPORT_DESCRIPTION: "POST-PRIMARY",
        DATE_REPORT_FILED: "06/05/2026",
        VALUE_IND_EXPENDITURES: "1000",
      },
    ],
  });
  await writeBulkCsv({
    cacheDir,
    fileName: "PAR_COVER.CSV",
    header: OHIO_SOS_PARTY_COVER_HEADER,
    rows: [],
  });

  await writeFile(
    join(cacheDir, "31U_DETAIL_2026.json"),
    JSON.stringify({
      version: 1,
      cycleYear: 2026,
      retrievedAt: "2026-08-04T00:00:00.000Z",
      header: [],
      reports: [
        {
          reportKey: "501544249",
          annualTotalCents: 100_000,
          detailTotalCents: 100_000,
          reconciled: true,
          rows: [detailRow()],
        },
      ],
      failures: [],
    }),
    "utf8"
  );
}

function dueRow(overrides: Partial<OhioCandidateFinanceDueRow> = {}): OhioCandidateFinanceDueRow {
  return {
    candidateId: "11111111-1111-4111-8111-111111111111",
    electionId: "22222222-2222-4222-8222-222222222222",
    candidateName: "Daniel Kalmbach",
    electionYear: 2026,
    officeScope: "state_lower",
    officeName: "State Lower Chamber Legislator",
    district: "87",
    committeeId: "15877",
    committeeName: "CITIZENS FOR KALMBACH",
    linkSource: "sos_bulk_export",
    sourceUrl: SOURCE_URL,
    lastSyncedAt: null,
    ...overrides,
  };
}

function createDueListDb(rows: OhioCandidateFinanceDueRow[]) {
  const query = vi.fn().mockResolvedValue({
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

describe("syncDueOhioCandidateFinance", () => {
  it("keeps November races in the ordinary window after January annual filing publication", async () => {
    const db = createDueListDb([]), now = new Date("2027-02-04T12:00:00.000Z");
    await syncDueOhioCandidateFinance({ db, now, dryRun: true, autoLinkMissingLinks: false });
    const [, params] = db.query.mock.calls[0]!;
    const earliestElection = new Date(now.getTime() - Number(params[3]) * 86400000);
    expect(earliestElection.getTime()).toBeLessThanOrEqual(Date.parse("2026-11-03T00:00:00.000Z"));
    expect(db.query.mock.calls[0]![0]).toContain("make_interval(days => $4::int)");
  });
  it("streams the cycle artifacts once and aggregates direct plus outside money end to end", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    const rows = [
      dueRow(),
      dueRow({
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        electionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        candidateName: "Laalitya Acharya",
        district: "56",
        committeeId: "16258",
        committeeName: "ACHARYA FOR OHIO",
      }),
    ];
    const db = createDueListDb(rows);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result).toMatchObject({
      dryRun: true,
      now: "2026-08-05T09:10:11.000Z",
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
    });
    // Due-list query plus the year's outside target-universe query.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.connect).not.toHaveBeenCalled();

    const kalmbach = result.results[0]?.result;
    expect(kalmbach).toMatchObject({
      committeeId: "15877",
      // Cover receipts (250 + 5,000 + 100) beat the itemized sum.
      totalReceipts: 5350,
      directContributionTotal: 5250,
      totalDisbursements: 1100,
      cashOnHand: 4250,
      outsideSupportTotal: 1000,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 3,
      includedContributionRowCount: 2,
      coverReportCount: 2,
    });

    // No money anywhere for the second committee, but the aggregation ran:
    // outside totals are real zeros, cover-less summary stays NULL.
    const acharya = result.results[1]?.result;
    expect(acharya).toMatchObject({
      committeeId: "16258",
      totalReceipts: 0,
      directContributionTotal: 0,
      totalDisbursements: null,
      cashOnHand: null,
      outsideSupportTotal: 0,
      outsideOpposeTotal: 0,
    });

    expect(result.outsideAggregationByYear).toEqual([
      {
        electionYear: 2026,
        available: true,
        reportCount: 1,
        quarantinedReportCount: 0,
        missingDetailReportKeyCount: 0,
        unmatchedTargetCount: 0,
        ambiguousTargetCount: 0,
        attributedRowCount: 1,
        attributedCents: 100_000,
        fundersAvailable: true,
        funderContributionRowCount: 2,
      },
    ]);

    // Funder leg (PR 8): the organization donor is counted, the individual
    // row is matched-but-skipped.
    expect(kalmbach).toMatchObject({
      matchedOutsideContributionRowCount: 2,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 1,
    });
  });

  it("shares one outside target across a candidate's primary and general due rows", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // Same candidate, same office, two elections in the window — must NOT
    // become two targets that quarantine every row as ambiguous.
    const rows = [
      dueRow(),
      dueRow({ electionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    ];
    const db = createDueListDb(rows);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(2);
    expect(result.results[0]?.result?.outsideSupportTotal).toBe(1000);
    expect(result.results[1]?.result?.outsideSupportTotal).toBe(1000);
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      ambiguousTargetCount: 0,
      unmatchedTargetCount: 0,
    });
  });

  it("keeps two different same-name candidates as separate targets so their money quarantines", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // Two DIFFERENT people (distinct candidate ids), same display name and
    // office, different districts. Attributing the same $1,000 to both
    // would double-pay; the aggregator must see two targets and quarantine
    // the name as ambiguous instead.
    const rows = [
      dueRow(),
      dueRow({
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        electionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        district: "12",
        committeeId: "16258",
        committeeName: "KALMBACH FOR THE 12TH",
      }),
    ];
    const db = createDueListDb(rows);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(2);
    expect(result.results[0]?.result?.outsideSupportTotal).toBe(0);
    expect(result.results[1]?.result?.outsideSupportTotal).toBe(0);
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      ambiguousTargetCount: 1,
      attributedRowCount: 0,
    });
  });

  it("treats a bundle missing annual report keys as unavailable and preserves stored outside data", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // A second 31-U filing exists in the annual file but not in the bundle:
    // its money is invisible, so no outside total from this bundle can be
    // trusted — the year must fail closed to "unavailable".
    await writeBulkCsv({
      cacheDir,
      fileName: "PPC_EXP_2026.CSV",
      header: OHIO_SOS_PARTY_EXPENDITURES_HEADER,
      rows: [
        {
          COM_NAME: "SOME PARTY COMMITTEE",
          MASTER_KEY: "4242",
          RPT_YEAR: "2026",
          REPORT_KEY: "600000000",
          SHORT_DESCRIPTION: "31-U  Ind Exp by committee",
          NON_INDIVIDUAL: "AD BUYER",
          EXPEND_DATE: "05/01/2026",
          AMOUNT: "500",
          PARTY: "REPUBLICAN",
        },
      ],
    });
    const rows = [dueRow()];
    const db = createDueListDb(rows);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncOhioCandidateFinanceFn: syncFn as never,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(syncFn.mock.calls[0]?.[0]).toMatchObject({ outsideFinance: null });
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      electionYear: 2026,
      available: false,
      missingDetailReportKeyCount: 1,
    });
    expect(result.outsideAggregationByYear[0]?.error).toContain("600000000");
  });

  it("only disables the funder leg when the funder contribution artifacts are missing", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // The funder sources are gone; the outside totals leg must still sync
    // and the funder slice must be null (stored breakdowns preserved), not
    // an empty list (which would clear them).
    await rm(join(cacheDir, "PAC_CON_2025.CSV"));
    await rm(join(cacheDir, "PAC_CON_2026.CSV"));
    const rows = [dueRow()];
    const db = createDueListDb(rows);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncOhioCandidateFinanceFn: syncFn as never,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(syncFn.mock.calls[0]?.[0]).toMatchObject({
      outsideFinance: { supportTotal: 1000, opposeTotal: 0, funders: null },
    });
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      fundersAvailable: false,
    });
    expect(result.outsideAggregationByYear[0]?.fundersError).toBeTruthy();
  });

  it("sees a same-name double from the active-link universe even when it is not due", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // Only ONE Kalmbach is due this run, but a second same-name candidate
    // holds an active link for the year. The ambiguity guard must match
    // against the full universe, not the due page, or attribution would
    // depend on sync timing.
    const dueRows = [dueRow()];
    const query = vi
      .fn()
      // Due list.
      .mockResolvedValueOnce({
        rows: dueRows.map((row, index) => ({
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
          total_due_rows: index === 0 ? dueRows.length : undefined,
        })),
      })
      // Outside target universe for 2026: the due candidate plus a
      // different person with the same display name and office.
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: dueRows[0]!.candidateId,
            candidate_name: "Daniel Kalmbach",
            office_name: "State Lower Chamber Legislator",
          },
          {
            candidate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            candidate_name: "Daniel Kalmbach",
            office_name: "State Lower Chamber Legislator",
          },
        ],
      });
    const db = { query, connect: vi.fn() };

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(result.results[0]?.result?.outsideSupportTotal).toBe(0);
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      available: true,
      ambiguousTargetCount: 1,
      attributedRowCount: 0,
    });
  });

  it("refuses a cached file whose size no longer matches its manifest", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // A manifest that disagrees with the bytes on disk means the file
    // changed after install — a torn copy or truncation the parser might
    // not notice. The year must fail, never publish from it.
    await writeFile(
      join(cacheDir, "CAC_CON_2026.CSV.manifest.json"),
      JSON.stringify({
        version: 1,
        productKey: "candidate_contributions",
        fileName: "CAC_CON_2026.CSV",
        transactionYear: 2026,
        filePath: join(cacheDir, "CAC_CON_2026.CSV"),
        manifestPath: join(cacheDir, "CAC_CON_2026.CSV.manifest.json"),
        fileTransferPageUrl: SOURCE_URL,
        portalDateModified: null,
        retrievedAt: "2026-08-04T00:00:00.000Z",
        sha256: "0".repeat(64),
        byteSize: 999_999_999,
        rowCount: 2,
        encoding: "windows-1252",
        rowSeparator: "\r",
        minTransactionDateIso: null,
        maxTransactionDateIso: null,
        implausibleDateRowCount: 0,
        missingDateRowCount: 0,
        missingAmountRowCount: 0,
        malformedRowCount: 0,
        reportKeys31u: [],
      }),
      "utf8"
    );
    const db = createDueListDb([dueRow()]);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(0);
    expect(result.failedCandidateCount).toBe(1);
    expect(result.results[0]?.error).toContain("does not match its manifest");
  });

  it("passes the link's original provenance through to the sync", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    const rows = [dueRow({ linkSource: "manual" })];
    const db = createDueListDb(rows);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncOhioCandidateFinanceFn: syncFn as never,
    });

    expect(syncFn.mock.calls[0]?.[0]).toMatchObject({
      committee: { committeeId: "15877", linkSource: "manual" },
    });
  });

  it("fails the year's candidates when a direct artifact is missing", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    await rm(join(cacheDir, "CAC_CON_2026.CSV"));
    const rows = [dueRow()];
    const db = createDueListDb(rows);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(0);
    expect(result.failedCandidateCount).toBe(1);
    expect(result.results[0]).toMatchObject({ ok: false });
    expect(result.results[0]?.error).toContain("CAC_CON_2026.CSV");
    // The outside leg is never attempted for a year whose direct leg failed.
    expect(result.outsideAggregationByYear).toEqual([]);
  });

  it("syncs direct-only and preserves outside data when the 31-U bundle is missing", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    await rm(join(cacheDir, "31U_DETAIL_2026.json"));
    const rows = [dueRow()];
    const db = createDueListDb(rows);
    const syncFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
      syncOhioCandidateFinanceFn: syncFn as never,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(syncFn.mock.calls[0]?.[0]).toMatchObject({
      candidateId: rows[0]?.candidateId,
      outsideFinance: null,
      committee: { committeeId: "15877", committeeName: "CITIZENS FOR KALMBACH" },
    });
    expect(syncFn.mock.calls[0]?.[0].directFinance.summary.totalReceipts).toBe(5350);
    expect(result.outsideAggregationByYear[0]).toMatchObject({
      electionYear: 2026,
      available: false,
    });
  });

  it("reads the legacy spike-format 31-U bundle", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    // The 2026-08-04 spike checkpoint shape: raw table cells, "-" for blank.
    await writeFile(
      join(cacheDir, "31U_DETAIL_2026.json"),
      JSON.stringify({
        rows: [
          {
            key: "501544249",
            n: 1,
            rows: [
              [
                "-",
                "NFIB",
                "-",
                "-",
                "-",
                "-",
                "POST-PRIMARY",
                "$1,000.00",
                "2026",
                "06/03/2026",
                "-",
                "-",
                "NFIB OHIO PAC",
                "HOUSE",
                "DANIEL KALMBACH",
                "SUPPORT",
              ],
            ],
          },
        ],
        err: [],
        running: false,
      }),
      "utf8"
    );
    const db = createDueListDb([dueRow()]);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(result.results[0]?.result?.outsideSupportTotal).toBe(1000);
    expect(result.outsideAggregationByYear[0]).toMatchObject({ available: true, quarantinedReportCount: 0 });
  });

  it("fails a row with a non-numeric link committee id without failing the year", async () => {
    const cacheDir = await makeCacheDir();
    await writeCycleArtifacts(cacheDir);
    const rows = [
      dueRow(),
      dueRow({
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        electionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        committeeId: "MD-000123",
      }),
    ];
    const db = createDueListDb(rows);

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      dryRun: true,
      autoLinkMissingLinks: false,
      rawDataCacheDir: cacheDir,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(result.failedCandidateCount).toBe(1);
    expect(result.results[1]).toMatchObject({ ok: false });
    expect(result.results[1]?.error).toContain("not a numeric SOS master key");
  });

  it("auto-links missing candidates from the injected active-candidate list before syncing", async () => {
    const missingCandidateId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const missingElectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const query = vi
      .fn()
      // Page of candidate elections missing links.
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: missingCandidateId,
            election_id: missingElectionId,
            candidate_name: "Daniel Kalmbach",
            election_year: 2026,
            election_date: "2026-11-03",
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "87",
          },
        ],
      })
      // Link upsert.
      .mockResolvedValueOnce({ rows: [{ id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1 })
      // Due list (empty — nothing to sync in this test).
      .mockResolvedValueOnce({ rows: [] });
    const db = { query, connect: vi.fn() };
    const candidateListRows: OhioSosCandidateCommitteeListRow[] = [
      {
        committeeName: "CITIZENS FOR KALMBACH",
        masterKey: "15877",
        candidateFirstName: "DANIEL",
        candidateLastName: "KALMBACH",
        office: "HOUSE",
        district: "87",
        party: "REPUBLICAN",
      },
    ];

    const result = await syncDueOhioCandidateFinance({
      db,
      now: new Date("2026-08-05T09:10:11.000Z"),
      candidateListData: { rows: candidateListRows, sourceUrl: SOURCE_URL },
      rawDataCacheDir: "/nonexistent-cache-dir-not-touched",
    });

    expect(result.selectedCandidateCount).toBe(0);
    expect(query).toHaveBeenCalledTimes(3);
    const linkUpsertSql = String(query.mock.calls[1]?.[0]);
    expect(linkUpsertSql).toContain("oh_candidate_finance_links");
  });
});
