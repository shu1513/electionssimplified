import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDueTexasCandidateFinance } from "../../../src/pipeline/texasFinance/texasCandidateFinanceBatchSync.js";
import {
  getTexasTecCsvDatabaseArtifactCachePaths,
  refreshTexasTecCsvDatabaseArtifactCache,
  TEXAS_TEC_CSV_DATABASE_URL,
} from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseArtifactCache.js";
import {
  TEXAS_TEC_CANDIDATE_COLUMNS, TEXAS_TEC_CONTRIBUTION_COLUMNS,
  TEXAS_TEC_EXPENDITURE_COLUMNS, TEXAS_TEC_FILER_COLUMNS,
  TEXAS_TEC_PURPOSE_COLUMNS, TEXAS_TEC_SPAC_COLUMNS,
} from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";

const dirs: string[] = [];
const candidateId = "11111111-1111-4111-8111-111111111111";
const electionId = "22222222-2222-4222-8222-222222222222";
const linkId = "33333333-3333-4333-8333-333333333333";

function csv(headers: readonly string[], rows: readonly Record<string, string>[]): string {
  const cell = (value: string) => /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  return [headers.join(","), ...rows.map(row => headers.map(h => cell(row[h] ?? "")).join(","))].join("\n");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { name: string; text: string }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.text), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(checksum, 16); dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function cachedSource(broken?: "purpose" | "receipts") {
  const cacheDir = await mkdtemp(join(tmpdir(), "voteapp-tx-cached-sync-"));
  dirs.push(cacheDir);
  const paths = getTexasTecCsvDatabaseArtifactCachePaths(cacheDir);
  const filers = [
    { recordType: "FILER", filerIdent: "00012345", filerTypeCd: "COH", filerName: "ABBOTT, GREG",
      committeeStatusCd: "ACTIVE", filerFilerpersStatusCd: "CURRENT", filerPersentTypeCd: "INDIVIDUAL",
      filerNameFirst: "GREG", filerNameLast: "ABBOTT", contestSeekOfficeCd: "GOVERNOR" },
    { recordType: "FILER", filerIdent: "00085824", filerTypeCd: "GPAC", filerName: "Coalition Por For Texas PAC",
      committeeStatusCd: "ACTIVE", filerNameOrganization: "Coalition Por For Texas PAC" },
    { recordType: "FILER", filerIdent: "00015672", filerTypeCd: "MPAC", filerName: "Wholesale Beer Distributors of Texas PAC",
      committeeStatusCd: "ACTIVE", filerNameOrganization: "Wholesale Beer Distributors of Texas PAC" },
  ];
  const expense = (id: string, report: string, amount: string) => ({
    recordType: "EXPN", formTypeCd: "GPAC", schedFormTypeCd: "F1", reportInfoIdent: report,
    infoOnlyFlag: "N", filerIdent: "00085824", filerTypeCd: "GPAC", filerName: "Coalition Por For Texas PAC",
    expendInfoId: id, expendDt: "20260916", expendAmount: amount, expendCatCd: "CONSULT",
    expendDescr: "Grassroots consulting", payeeNameOrganization: "Apex Canvassing & Consulting LLC",
  });
  const beneficiary = (id: string, report: string, amount: string, first = "GREG", last = "ABBOTT", office = "GOVERNOR") => ({
    ...expense(id, report, amount), recordType: "CAND", candidateNameFirst: first, candidateNameLast: last,
    candidatePersentTypeCd: "INDIVIDUAL", candidateSeekOfficeCd: office,
  });
  const purpose = (report: string) => ({
    recordType: "PURPOSE", formTypeCd: "GPAC", reportInfoIdent: report, infoOnlyFlag: "N",
    filerIdent: "00085824", filerTypeCd: "GPAC", subjectCategoryCd: "CANDIDATE",
    subjectPositionCd: "SUPPORT", activitySeekOfficeCd: "GOVERNOR", commActivityName: "Abbott, Greg",
  });
  const receipt = (id: string, amount: string, name: string, oos = "", fec = "") => ({
    recordType: "RCPT", formTypeCd: "COH", schedFormTypeCd: "A1", reportInfoIdent: "RC1",
    infoOnlyFlag: "N", filerIdent: "00012345", filerTypeCd: "COH", contributionInfoId: id,
    contributionDt: "20260414", contributionAmount: amount, contributorPersentTypeCd: "ENTITY",
    contributorNameOrganization: name, contributorOosPacFlag: oos, contributorPacFein: fec,
  });
  const purposeHeaders = broken === "purpose"
    ? TEXAS_TEC_PURPOSE_COLUMNS.filter(c => c !== "subjectPositionCd") : TEXAS_TEC_PURPOSE_COLUMNS;
  const receiptHeaders = broken === "receipts"
    ? TEXAS_TEC_CONTRIBUTION_COLUMNS.filter(c => c !== "contributorPacFein") : TEXAS_TEC_CONTRIBUTION_COLUMNS;
  const bytes = zip([
    { name: "filers.csv", text: csv(TEXAS_TEC_FILER_COLUMNS, filers) },
    { name: "cand.csv", text: csv(TEXAS_TEC_CANDIDATE_COLUMNS, [
      beneficiary("106420958", "101069341", "35000.00"),
      beneficiary("SHARED", "SHARED_REPORT", "2000.00"),
      beneficiary("SHARED", "SHARED_REPORT", "2000.00", "DAN", "PATRICK", "LTGOVERNOR"),
    ]) },
    { name: "spacs.csv", text: csv(TEXAS_TEC_SPAC_COLUMNS, []) },
    { name: "purpose.csv", text: csv(purposeHeaders, [purpose("101069341"), purpose("SHARED_REPORT")]) },
    { name: "expend_100.csv", text: csv(TEXAS_TEC_EXPENDITURE_COLUMNS, [
      expense("106420958", "101069341", "35000.00"), expense("SHARED", "SHARED_REPORT", "2000.00"),
    ]) },
    { name: "contribs_99.csv", text: csv(receiptHeaders, [{
      ...receipt("PERSON", "100.00", ""), contributorPersentTypeCd: "INDIVIDUAL",
      contributorNameFirst: "JANE", contributorNameLast: "DOE",
    }]) },
    { name: "contribs_100.csv", text: csv(receiptHeaders, [receipt("TEC_PAC", "2500.00", "Wholesale Beer Distributors of Texas PAC")]) },
    { name: "contribs_111.csv", text: csv(receiptHeaders, [receipt("OOS_PAC", "2500.00", "DRIVE Committee", "Y", "C00032979")]) },
  ]);
  await writeFile(paths.zipPath, bytes);
  const metadata = JSON.stringify({
    version: 1, zipPath: paths.zipPath, metadataPath: paths.metadataPath,
    downloadedAt: "2026-10-10T10:35:03.000Z", bytesWritten: bytes.length,
    remote: { url: TEXAS_TEC_CSV_DATABASE_URL, contentLength: bytes.length,
      contentType: "application/zip", etag: '"unchanged-v1"',
      lastModified: "Sat, 10 Oct 2026 10:35:03 GMT" },
  });
  await writeFile(paths.metadataPath, metadata);
  return { cacheDir, paths, bytes, metadata };
}

function db() {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.tx_candidate_finance_links AS link")) return { rows: [{
      candidate_id: candidateId, election_id: electionId, candidate_name: "Greg Abbott",
      election_year: 2026, office_scope: "statewide", office_name: "Governor", district: null,
      committee_id: "00012345", committee_name: "ABBOTT, GREG", source_url: TEXAS_TEC_CSV_DATABASE_URL,
      last_synced_at: null, total_due_rows: "1",
    }] };
    return { rows: [{ id: linkId }], rowCount: 1 };
  }) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Texas cached raw data through the real batch and writer", () => {
  it("reads new partitions, typed donors and report directions when v1 cache refresh skips downloading", async () => {
    const source = await cachedSource();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "HEAD") throw new Error("Cached bytes must not be downloaded again");
      return new Response(null, { headers: {
        "content-length": String(source.bytes.length), "content-type": "application/zip",
        etag: '"unchanged-v1"', "last-modified": "Sat, 10 Oct 2026 10:35:03 GMT",
      } });
    });
    const refresh = await refreshTexasTecCsvDatabaseArtifactCache({ cacheDir: source.cacheDir, fetchImpl });
    expect(refresh.status).toBe("unchanged");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const database = db();
    const result = await syncDueTexasCandidateFinance({
      db: database, rawDataCacheDir: source.cacheDir, autoLinkMissingLinks: false, maxCandidates: 1,
      now: new Date("2026-10-11T10:00:00.000Z"),
    });
    expect(result.failedCandidateCount).toBe(0);
    expect(result.results[0]?.result).toMatchObject({
      totalReceipts: 5100, directContributionTotal: 5100, outsideSupportTotal: 35000,
      outsideOpposeTotal: 0, outsideGroupsWritten: 1,
    });
    const donorInserts = database.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO public.tx_candidate_finance_pac_donors"));
    expect(donorInserts).toHaveLength(2);
    expect(donorInserts.flatMap(([, values]) => values as unknown[])).toEqual(expect.arrayContaining([
      "00015672", "MPAC", "Wholesale Beer Distributors of Texas PAC", "fec:C00032979", "OOS_PAC", "DRIVE Committee", 2500,
    ]));
    expect(database.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(await readFile(source.paths.zipPath)).toEqual(source.bytes);
    expect(await readFile(source.paths.metadataPath, "utf8")).toBe(source.metadata);
  });

  it.each(["purpose", "receipts"] as const)("preserves snapshots when %s source headers are incomplete", async broken => {
    const source = await cachedSource(broken), database = db();
    const result = await syncDueTexasCandidateFinance({
      db: database, rawDataCacheDir: source.cacheDir, autoLinkMissingLinks: false,
      now: new Date("2026-10-11T10:00:00.000Z"),
    });
    expect(result.syncedCandidateCount).toBe(0);
    expect(result.failedCandidateCount).toBe(1);
    expect(result.results[0]?.error).toMatch(/missing.*column|missing.*header/i);
    expect(database.query.mock.calls.some(([sql]) => /INSERT|DELETE|BEGIN/.test(sql))).toBe(false);
  });
});
