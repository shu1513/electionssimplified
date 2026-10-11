import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  TEXAS_TEC_CANDIDATE_COLUMNS,
  TEXAS_TEC_CONTRIBUTION_COLUMNS,
  TEXAS_TEC_EXPENDITURE_COLUMNS,
  TEXAS_TEC_FILER_COLUMNS,
  TEXAS_TEC_PURPOSE_COLUMNS,
  TEXAS_TEC_SPAC_COLUMNS,
  listTexasTecContributionCsvFileNames,
  listTexasTecCsvDatabaseZipEntries,
  listTexasTecExpenditureCsvFileNames,
  normalizeTexasTecCsvPartition,
  readTexasTecCandidateRows,
  readTexasTecContributionRows,
  readTexasTecCsvDatabaseTableRows,
  readTexasTecExpenditureRows,
  readTexasTecFilerRows,
  readTexasTecPurposeRows,
  readTexasTecSpacRows,
  texasTecContributionCsvFileName,
  texasTecExpenditureCsvFileName,
} from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";

type ZipFixtureEntry = {
  fileName: string;
  content?: string;
  compressionMethod?: 0 | 8;
  forceZip64CentralDirectory?: boolean;
};

const tempDirs: string[] = [];

function makeZip(entries: readonly ZipFixtureEntry[], comment: Buffer = Buffer.alloc(0)): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.fileName, "utf8");
    const content = Buffer.from(entry.content ?? "", "utf8");
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressed = compressionMethod === 8 ? deflateRawSync(content) : content;
    const zip64ExtraField = entry.forceZip64CentralDirectory
      ? (() => {
          const extraField = Buffer.alloc(28);
          extraField.writeUInt16LE(0x0001, 0);
          extraField.writeUInt16LE(24, 2);
          extraField.writeBigUInt64LE(BigInt(content.length), 4);
          extraField.writeBigUInt64LE(BigInt(compressed.length), 12);
          extraField.writeBigUInt64LE(BigInt(localOffset), 20);
          return extraField;
        })()
      : Buffer.alloc(0);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, fileName, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(entry.forceZip64CentralDirectory ? 0xffffffff : compressed.length, 20);
    centralHeader.writeUInt32LE(entry.forceZip64CentralDirectory ? 0xffffffff : content.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(zip64ExtraField.length, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.fileName.endsWith("/") ? 0x10 : 0, 38);
    centralHeader.writeUInt32LE(entry.forceZip64CentralDirectory ? 0xffffffff : localOffset, 42);
    centralParts.push(centralHeader, fileName, zip64ExtraField);

    localOffset += localHeader.length + fileName.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd, comment]);
}

async function writeFixtureZip(entries: readonly ZipFixtureEntry[], comment?: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "voteapp-tx-tec-reader-"));
  tempDirs.push(dir);
  const zipPath = path.join(dir, "TEC_CF_CSV.zip");
  await writeFile(zipPath, makeZip(entries, comment));
  return zipPath;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(headers: readonly string[], values: Record<string, string>): string {
  return headers.map((header) => csvCell(values[header] ?? "")).join(",");
}

function csv(headers: readonly string[], rows: readonly Record<string, string>[]): string {
  return [headers.join(","), ...rows.map((row) => csvRow(headers, row))].join("\n");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Texas TEC CSV database reader", () => {
  it("builds official partitioned contribution and expenditure filenames", () => {
    expect(normalizeTexasTecCsvPartition(0)).toBe("00");
    expect(normalizeTexasTecCsvPartition(7)).toBe("07");
    expect(texasTecContributionCsvFileName(12)).toBe("contribs_12.csv");
    expect(texasTecExpenditureCsvFileName(3)).toBe("expend_03.csv");
    expect(normalizeTexasTecCsvPartition(100)).toBe("100");
    expect(texasTecContributionCsvFileName(111)).toBe("contribs_111.csv");
    expect(texasTecExpenditureCsvFileName(100)).toBe("expend_100.csv");
    expect(() => normalizeTexasTecCsvPartition(-1)).toThrow("Invalid Texas TEC CSV partition");
    expect(() => normalizeTexasTecCsvPartition(Number.MAX_SAFE_INTEGER + 1)).toThrow("Invalid Texas TEC CSV partition");
  });

  it("lists ZIP entries and partitioned contribution/expenditure files", async () => {
    const zipPath = await writeFixtureZip([
      { fileName: "folder/" },
      { fileName: "filers.csv", content: "recordType,filerIdent\nFILER,1\n" },
      { fileName: "contribs_00.csv", content: "recordType,filerIdent\nRCPT,1\n" },
      { fileName: "contribs_01.csv", content: "recordType,filerIdent\nRCPT,2\n", compressionMethod: 8 },
      { fileName: "expend_00.csv", content: "recordType,filerIdent\nEXPN,1\n" },
      { fileName: "cont_ss.csv", content: "recordType,filerIdent\nRCPT,3\n" },
    ]);

    await expect(listTexasTecCsvDatabaseZipEntries(zipPath)).resolves.toEqual([
      {
        fileName: "folder/",
        compressedSize: 0,
        uncompressedSize: 0,
        compressionMethod: "stored",
        isDirectory: true,
      },
      expect.objectContaining({
        fileName: "filers.csv",
        compressionMethod: "stored",
        isDirectory: false,
      }),
      expect.objectContaining({
        fileName: "contribs_00.csv",
        compressionMethod: "stored",
      }),
      expect.objectContaining({
        fileName: "contribs_01.csv",
        compressionMethod: "deflated",
      }),
      expect.objectContaining({
        fileName: "expend_00.csv",
      }),
      expect.objectContaining({
        fileName: "cont_ss.csv",
      }),
    ]);
    await expect(listTexasTecContributionCsvFileNames(zipPath)).resolves.toEqual([
      "contribs_00.csv",
      "contribs_01.csv",
    ]);
    await expect(listTexasTecExpenditureCsvFileNames(zipPath)).resolves.toEqual(["expend_00.csv"]);
  });

  it("ignores EOCD signature bytes inside the ZIP comment", async () => {
    const comment = Buffer.from("comment before PK\u0005\u0006 comment after", "binary");
    const zipPath = await writeFixtureZip(
      [{ fileName: "filers.csv", content: "recordType,filerIdent\nFILER,1\n" }],
      comment
    );

    await expect(listTexasTecCsvDatabaseZipEntries(zipPath)).resolves.toEqual([
      expect.objectContaining({
        fileName: "filers.csv",
        isDirectory: false,
      }),
    ]);
  });

  it("streams selected CSV table rows with predicate and maxRows", async () => {
    const headers = [
      "recordType",
      "filerIdent",
      "filerName",
      "contributionAmount",
      "contributorEmployer",
      "contributorOccupation",
    ];
    const zipPath = await writeFixtureZip([
      {
        fileName: "contribs_00.csv",
        compressionMethod: 8,
        content: csv(headers, [
          {
            recordType: "RCPT",
            filerIdent: "00012345",
            filerName: "Example for Texas",
            contributionAmount: "100.00",
            contributorEmployer: "Acme, Inc.",
            contributorOccupation: "Engineer",
          },
          {
            recordType: "RCPT",
            filerIdent: "00012345",
            filerName: "Example for Texas",
            contributionAmount: "250.00",
            contributorEmployer: "Beta",
            contributorOccupation: "Attorney",
          },
          {
            recordType: "RCPT",
            filerIdent: "00099999",
            filerName: "Other Campaign",
            contributionAmount: "500.00",
            contributorEmployer: "Other",
            contributorOccupation: "Teacher",
          },
        ]),
      },
    ]);

    await expect(
      readTexasTecCsvDatabaseTableRows({
        zipPath,
        fileName: "contribs_00.csv",
        predicate: (row) => row.filerIdent === "00012345",
        maxRows: 1,
      })
    ).resolves.toEqual([
      {
        recordType: "RCPT",
        filerIdent: "00012345",
        filerName: "Example for Texas",
        contributionAmount: "100.00",
        contributorEmployer: "Acme, Inc.",
        contributorOccupation: "Engineer",
      },
    ]);
  });

  it("streams quoted multiline fields without splitting rows", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "cand.csv",
        compressionMethod: 8,
        content: csv(
          ["recordType", "filerIdent", "candidateNameLast", "candidateNameFirst", "expendDescr"],
          [
            {
              recordType: "CAND",
              filerIdent: "7001",
              candidateNameLast: "Example",
              candidateNameFirst: "Alex",
              expendDescr: "line one\nline two",
            },
          ]
        ),
      },
    ]);

    await expect(readTexasTecCsvDatabaseTableRows({ zipPath, fileName: "cand.csv" })).resolves.toEqual([
      {
        recordType: "CAND",
        filerIdent: "7001",
        candidateNameLast: "Example",
        candidateNameFirst: "Alex",
        expendDescr: "line one\nline two",
      },
    ]);
  });

  it("reads typed filer, candidate, SPAC, and purpose rows", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "filers.csv",
        content: csv(TEXAS_TEC_FILER_COLUMNS, [
          {
            recordType: "FILER",
            filerIdent: "00012345",
            filerTypeCd: "COH",
            filerName: "Example for Texas",
            committeeStatusCd: "ACTIVE",
            filerFilerpersStatusCd: "CURRENT",
            contestSeekOfficeCd: "GOV",
            contestSeekOfficeDistrict: "",
            contestSeekOfficePlace: "",
            contestSeekOfficeDescr: "Governor",
            contestSeekOfficeCountyCd: "",
            contestSeekOfficeCountyDescr: "",
          },
        ]),
      },
      {
        fileName: "cand.csv",
        content: csv(TEXAS_TEC_CANDIDATE_COLUMNS, [
          {
            recordType: "CAND",
            filerIdent: "7001",
            filerTypeCd: "SPAC",
            filerName: "Texans for Example",
            expendInfoId: "5001",
            expendDt: "20261001",
            expendAmount: "12000.00",
            expendDescr: "Digital ads",
            candidatePersentTypeCd: "INDIVIDUAL",
            candidateNameOrganization: "",
            candidateNameLast: "Example",
            candidateNameFirst: "Alex",
            candidateSeekOfficeCd: "GOV",
            candidateSeekOfficeDistrict: "",
            candidateSeekOfficePlace: "",
            candidateSeekOfficeDescr: "Governor",
            candidateSeekOfficeCountyCd: "",
            candidateSeekOfficeCountyDescr: "",
          },
        ]),
      },
      {
        fileName: "spacs.csv",
        content: csv(TEXAS_TEC_SPAC_COLUMNS, [
          {
            recordType: "SPAC",
            spacFilerIdent: "7001",
            spacFilerTypeCd: "SPAC",
            spacFilerName: "Texans for Example",
            spacFilerNameShort: "",
            spacCommitteeStatusCd: "ACTIVE",
            spacPositionCd: "SUPPORT",
            candidateFilerIdent: "00012345",
            candidateFilerTypeCd: "COH",
            candidateFilerName: "Example for Texas",
            candidateFilerpersStatusCd: "CURRENT",
            candidateSeekOfficeCd: "GOV",
            candidateSeekOfficeDistrict: "",
            candidateSeekOfficePlace: "",
            candidateSeekOfficeDescr: "Governor",
            candidateSeekOfficeCountyCd: "",
            candidateSeekOfficeCountyDescr: "",
          },
        ]),
      },
      {
        fileName: "purpose.csv",
        content: csv(TEXAS_TEC_PURPOSE_COLUMNS, [
          {
            recordType: "CVR3",
            filerIdent: "7001",
            filerTypeCd: "SPAC",
            filerName: "Texans for Example",
            committeeActivityId: "9001",
            subjectCategoryCd: "CANDIDATE",
            subjectPositionCd: "SUPPORT",
            subjectDescr: "Alex Example",
            subjectElectionDt: "20261103",
            activitySeekOfficeCd: "GOV",
            activitySeekOfficeDistrict: "",
            activitySeekOfficePlace: "",
            activitySeekOfficeDescr: "Governor",
            activitySeekOfficeCountyCd: "",
            activitySeekOfficeCountyDescr: "",
          },
        ]),
      },
    ]);

    await expect(readTexasTecFilerRows({ zipPath })).resolves.toEqual([
      expect.objectContaining({
        filerIdent: "00012345",
        filerName: "Example for Texas",
        contestSeekOfficeCd: "GOV",
      }),
    ]);
    await expect(readTexasTecCandidateRows({ zipPath })).resolves.toEqual([
      expect.objectContaining({
        filerIdent: "7001",
        candidateNameLast: "Example",
        expendAmount: "12000.00",
      }),
    ]);
    await expect(readTexasTecSpacRows({ zipPath })).resolves.toEqual([
      expect.objectContaining({
        spacFilerIdent: "7001",
        spacPositionCd: "SUPPORT",
        candidateFilerIdent: "00012345",
      }),
    ]);
    await expect(readTexasTecPurposeRows({ zipPath })).resolves.toEqual([
      expect.objectContaining({
        filerIdent: "7001",
        subjectPositionCd: "SUPPORT",
        subjectDescr: "Alex Example",
      }),
    ]);
  });

  it("reads typed contribution and expenditure rows from partition files", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "contribs_00.csv",
        content: csv(TEXAS_TEC_CONTRIBUTION_COLUMNS, [
          {
            recordType: "RCPT",
            formTypeCd: "COH",
            schedFormTypeCd: "A",
            reportInfoIdent: "100",
            receivedDt: "20261001",
            infoOnlyFlag: "N",
            filerIdent: "00012345",
            filerTypeCd: "COH",
            filerName: "Example for Texas",
            contributionInfoId: "200",
            contributionDt: "20260915",
            contributionAmount: "500.00",
            contributionDescr: "Contribution",
            contributorPersentTypeCd: "INDIVIDUAL",
            contributorNameOrganization: "",
            contributorNameLast: "Donor",
            contributorNameFirst: "Dana",
            contributorStreetStateCd: "TX",
            contributorEmployer: "Acme",
            contributorOccupation: "Engineer",
            contributorJobTitle: "Staff engineer",
          },
        ]),
      },
      {
        fileName: "expend_00.csv",
        content: csv(TEXAS_TEC_EXPENDITURE_COLUMNS, [
          {
            recordType: "EXPN",
            formTypeCd: "SPAC",
            schedFormTypeCd: "F",
            reportInfoIdent: "300",
            receivedDt: "20261001",
            infoOnlyFlag: "N",
            filerIdent: "7001",
            filerTypeCd: "SPAC",
            filerName: "Texans for Example",
            expendInfoId: "5001",
            expendDt: "20260920",
            expendAmount: "12000.00",
            expendDescr: "Digital ads",
            expendCatCd: "ADV",
            expendCatDescr: "Advertising",
            politicalExpendCd: "POLITICAL",
            payeePersentTypeCd: "ENTITY",
            payeeNameOrganization: "Ad Vendor LLC",
            payeeNameLast: "",
            payeeNameFirst: "",
          },
        ]),
      },
    ]);

    await expect(readTexasTecContributionRows({ zipPath, fileName: "contribs_00.csv" })).resolves.toEqual([
      expect.objectContaining({
        filerIdent: "00012345",
        contributionAmount: "500.00",
        contributorOccupation: "Engineer",
      }),
    ]);
    await expect(readTexasTecExpenditureRows({ zipPath, fileName: "expend_00.csv" })).resolves.toEqual([
      expect.objectContaining({
        filerIdent: "7001",
        expendInfoId: "5001",
        expendAmount: "12000.00",
      }),
    ]);
  });

  it("supports ZIP64 extended entry fields without requiring ZIP64 archives", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "spacs.csv",
        content: "recordType,spacFilerIdent,spacPositionCd\nSPAC,8001,SUPPORT\n",
        forceZip64CentralDirectory: true,
      },
    ]);

    await expect(readTexasTecCsvDatabaseTableRows({ zipPath, fileName: "spacs.csv" })).resolves.toEqual([
      {
        recordType: "SPAC",
        spacFilerIdent: "8001",
        spacPositionCd: "SUPPORT",
      },
    ]);
  });

  it("throws when the requested table is missing or maxRows is invalid", async () => {
    const zipPath = await writeFixtureZip([{ fileName: "filers.csv", content: "recordType,filerIdent\nFILER,1\n" }]);

    await expect(readTexasTecCsvDatabaseTableRows({ zipPath, fileName: "missing.csv" })).rejects.toThrow(
      "Texas TEC CSV table not found in ZIP: missing.csv"
    );
    await expect(
      readTexasTecCsvDatabaseTableRows({ zipPath, fileName: "filers.csv", maxRows: 0 })
    ).rejects.toThrow("Invalid Texas TEC CSV database maxRows");
  });

  it("throws when a requested table entry is empty", async () => {
    const zipPath = await writeFixtureZip([{ fileName: "filers.csv", content: "" }]);

    await expect(readTexasTecCsvDatabaseTableRows({ zipPath, fileName: "filers.csv" })).rejects.toThrow(
      "Texas TEC CSV entry is empty: filers.csv"
    );
  });

  it("throws when typed readers receive invalid filenames or missing required columns", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "contribs_00.csv",
        content: "recordType,filerIdent\nRCPT,00012345\n",
      },
      {
        fileName: "expend_00.csv",
        content: csv(TEXAS_TEC_EXPENDITURE_COLUMNS, []),
      },
    ]);

    await expect(readTexasTecContributionRows({ zipPath, fileName: "cont_ss.csv" })).rejects.toThrow(
      "Invalid Texas TEC contribution CSV file name: cont_ss.csv"
    );
    await expect(readTexasTecExpenditureRows({ zipPath, fileName: "cand.csv" })).rejects.toThrow(
      "Invalid Texas TEC expenditure CSV file name: cand.csv"
    );
    await expect(readTexasTecContributionRows({ zipPath, fileName: "contribs_00.csv" })).rejects.toThrow(
      "Missing required Texas TEC contribution CSV column: formTypeCd"
    );
  });
});

describe("complete Texas partition and donor-field contract", () => {
  it("reads partitions 100 and 111 in numeric order for both contributions and expenditures", async () => {
    const zipPath = await writeFixtureZip([
      { fileName: "contribs_111.csv", compressionMethod: 8, content: csv(TEXAS_TEC_CONTRIBUTION_COLUMNS, [{ contributionInfoId: "111", contributorOosPacFlag: "Y", contributorPacFein: "C00032979" }]) },
      { fileName: "contribs_100.csv", content: csv(TEXAS_TEC_CONTRIBUTION_COLUMNS, [{ contributionInfoId: "100" }]) },
      { fileName: "contribs_99.csv", content: csv(TEXAS_TEC_CONTRIBUTION_COLUMNS, [{ contributionInfoId: "99" }]) },
      { fileName: "expend_111.csv", content: csv(TEXAS_TEC_EXPENDITURE_COLUMNS, [{ expendInfoId: "111" }]) },
      { fileName: "expend_100.csv", compressionMethod: 8, content: csv(TEXAS_TEC_EXPENDITURE_COLUMNS, [{ expendInfoId: "100" }]) },
      { fileName: "expend_99.csv", content: csv(TEXAS_TEC_EXPENDITURE_COLUMNS, [{ expendInfoId: "99" }]) },
      { fileName: "cont_t.csv", content: "rapid receipts are separate" },
      { fileName: "expn_t.csv", content: "rapid expenses are separate" },
      { fileName: "contribs_bad.csv", content: "invalid" },
    ]);
    expect(await listTexasTecContributionCsvFileNames(zipPath)).toEqual(["contribs_99.csv", "contribs_100.csv", "contribs_111.csv"]);
    expect(await listTexasTecExpenditureCsvFileNames(zipPath)).toEqual(["expend_99.csv", "expend_100.csv", "expend_111.csv"]);
    expect(await readTexasTecContributionRows({ zipPath, fileName: "contribs_100.csv" })).toEqual([expect.objectContaining({ contributionInfoId: "100" })]);
    expect(await readTexasTecContributionRows({ zipPath, fileName: "contribs_111.csv" })).toEqual([expect.objectContaining({ contributionInfoId: "111", contributorOosPacFlag: "Y", contributorPacFein: "C00032979" })]);
    expect(await readTexasTecExpenditureRows({ zipPath, fileName: "expend_100.csv" })).toEqual([expect.objectContaining({ expendInfoId: "100" })]);
    expect(await readTexasTecExpenditureRows({ zipPath, fileName: "expend_111.csv" })).toEqual([expect.objectContaining({ expendInfoId: "111" })]);
  });

  it.each(["contributorOosPacFlag", "contributorPacFein"])("requires official contribution header %s", async (column) => {
    const zipPath = await writeFixtureZip([{ fileName: "contribs_100.csv",
      content: csv(TEXAS_TEC_CONTRIBUTION_COLUMNS.filter((field) => field !== column), []) }]);
    await expect(readTexasTecContributionRows({ zipPath, fileName: "contribs_100.csv" }))
      .rejects.toThrow(`Missing required Texas TEC contribution CSV column: ${column}`);
  });
});
