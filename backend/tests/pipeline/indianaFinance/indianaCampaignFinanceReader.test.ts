import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,
  INDIANA_CAMPAIGN_FINANCE_EXPENDITURE_COLUMNS,
  indianaCampaignFinanceCsvFileName,
  parseIndianaCampaignFinanceCsvRows,
  readIndianaCampaignFinanceContributionRows,
  readIndianaCampaignFinanceExpenditureRows,
} from "../../../src/pipeline/indianaFinance/indianaCampaignFinanceReader.js";

type ZipFixtureEntry = {
  fileName: string;
  content?: string | Buffer;
  compressionMethod?: 0 | 8;
};

let tempDirs: string[] = [];

function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.fileName, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "", "utf8");
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressed = compressionMethod === 8 ? deflateRawSync(content) : content;

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
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.fileName.endsWith("/") ? 0x10 : 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, fileName);

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
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function writeFixtureZip(fileName: string, entries: readonly ZipFixtureEntry[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "in-finance-reader-"));
  tempDirs.push(dir);
  const zipPath = path.join(dir, fileName);
  await writeFile(zipPath, makeZip(entries));
  return zipPath;
}

function csvValue(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowFor<const Columns extends readonly string[]>(
  columns: Columns,
  values: Partial<Record<Columns[number], string>>
): string {
  return columns.map((column) => csvValue(values[column] ?? "")).join(",");
}

function csvFor<const Columns extends readonly string[]>(
  columns: Columns,
  rows: readonly Partial<Record<Columns[number], string>>[]
): string {
  return [columns.join(","), ...rows.map((row) => rowFor(columns, row))].join("\n");
}

describe("indianaCampaignFinanceReader", () => {
  afterEach(async () => {
    const dirs = tempDirs;
    tempDirs = [];
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds official contribution and expenditure CSV filenames", () => {
    expect(indianaCampaignFinanceCsvFileName({ year: 2026, artifactKind: "contribution" })).toBe(
      "2026_ContributionData.csv"
    );
    expect(indianaCampaignFinanceCsvFileName({ year: 2026, artifactKind: "expenditure" })).toBe(
      "2026_ExpenditureData.csv"
    );
  });

  it("parses quoted and multiline CSV rows", () => {
    expect(parseIndianaCampaignFinanceCsvRows('Name,Description\n"Acme, Inc.","line one\nline two"\n')).toEqual([
      ["Name", "Description"],
      ["Acme, Inc.", "line one\nline two"],
    ]);
  });

  it("reads deflated contribution rows from the expected yearly CSV entry", async () => {
    const zipPath = await writeFixtureZip("2026_ContributionData.csv.zip", [
      {
        fileName: "2026_ContributionData.csv",
        compressionMethod: 8,
        content: csvFor(INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS, [
          {
            FileNumber: "422",
            CommitteeType: "Candidate",
            Committee: "Diego for Indiana",
            CandidateName: "Cesar Diego Morales",
            Name: "Acme, Inc.",
            Occupation: "Business",
            Amount: "250.0000",
          },
          {
            FileNumber: "999",
            CandidateName: "Other Candidate",
            Amount: "500.0000",
          },
        ]),
      },
    ]);

    await expect(
      readIndianaCampaignFinanceContributionRows({
        zipPath,
        year: 2026,
        predicate: (row) => row.FileNumber === "422",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        FileNumber: "422",
        CandidateName: "Cesar Diego Morales",
        Name: "Acme, Inc.",
      }),
    ]);
  });

  it("reads expenditure rows from the expected yearly CSV entry", async () => {
    const zipPath = await writeFixtureZip("2026_ExpenditureData.csv.zip", [
      {
        fileName: "2026_ExpenditureData.csv",
        content: csvFor(INDIANA_CAMPAIGN_FINANCE_EXPENDITURE_COLUMNS, [
          {
            FileNumber: "700",
            CommitteeType: "PAC",
            Committee: "Hoosiers for Progress",
            CandidateName: "Cesar Diego Morales",
            ExpenditureType: "Independent",
            Purpose: "Digital, mail, and ads",
            Amount: "6990.5000",
          },
        ]),
      },
    ]);

    await expect(readIndianaCampaignFinanceExpenditureRows({ zipPath, year: 2026 })).resolves.toEqual([
      expect.objectContaining({
        FileNumber: "700",
        Purpose: "Digital, mail, and ads",
        Amount: "6990.5000",
      }),
    ]);
  });

  it("supports maxRows after filtering", async () => {
    const zipPath = await writeFixtureZip("2026_ContributionData.csv.zip", [
      {
        fileName: "2026_ContributionData.csv",
        content: csvFor(INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS, [
          { FileNumber: "422", Name: "One" },
          { FileNumber: "422", Name: "Two" },
          { FileNumber: "999", Name: "Three" },
        ]),
      },
    ]);

    await expect(
      readIndianaCampaignFinanceContributionRows({
        zipPath,
        year: 2026,
        predicate: (row) => row.FileNumber === "422",
        maxRows: 1,
      })
    ).resolves.toEqual([expect.objectContaining({ Name: "One" })]);
  });

  it("rejects malformed quotes rather than returning a plausible prefix", () => {
    expect(() => parseIndianaCampaignFinanceCsvRows('Name,Amount\nSynthetic"PAC,10\n')).toThrow("quote in an unquoted field");
    expect(() => parseIndianaCampaignFinanceCsvRows('Name,Amount\n"Synthetic PAC"tail,10\n')).toThrow("text after a closing quote");
    expect(parseIndianaCampaignFinanceCsvRows('\uFEFF"Name","Amount"\r\n"Synthetic ""PAC""","10"\r\n')).toEqual([["Name","Amount"],['Synthetic "PAC"','10']]);
  });

  it("rejects invalid UTF-8 before applying a row limit", async () => {
    const prefix = csvFor(INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,[{FileNumber:"synthetic-file",Name:"Synthetic PAC",Amount:"100"}]);
    const zipPath = await writeFixtureZip("invalid-utf8.zip",[{fileName:"2026_ContributionData.csv",content:Buffer.concat([Buffer.from(prefix+"\n"),Buffer.from([0xc3,0x28])])}]);
    await expect(readIndianaCampaignFinanceContributionRows({zipPath,year:2026,maxRows:1})).rejects.toThrow("not valid UTF-8");
  });

  it("checks every row width even after the requested filtered prefix", async () => {
    const csv = csvFor(INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,[{FileNumber:"synthetic-file",Name:"Synthetic PAC",Amount:"100"}])+"\nwrong,width";
    const zipPath = await writeFixtureZip("invalid-tail.zip",[{fileName:"2026_ContributionData.csv",content:csv}]);
    await expect(readIndianaCampaignFinanceContributionRows({zipPath,year:2026,maxRows:1,predicate:r=>r.FileNumber==="synthetic-file"})).rejects.toThrow("row width does not match");
  });

  it("throws when the expected yearly CSV entry is missing", async () => {
    const zipPath = await writeFixtureZip("2026_ContributionData.csv.zip", [
      {
        fileName: "wrong.csv",
        content: csvFor(INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS, []),
      },
    ]);

    await expect(readIndianaCampaignFinanceContributionRows({ zipPath, year: 2026 })).rejects.toThrow(
      "Indiana campaign finance ZIP did not contain expected CSV: 2026_contributiondata.csv"
    );
  });

  it("throws when a required CSV column is missing", async () => {
    const zipPath = await writeFixtureZip("2026_ContributionData.csv.zip", [
      {
        fileName: "2026_ContributionData.csv",
        content: "FileNumber,CommitteeType\n422,Candidate\n",
      },
    ]);

    await expect(readIndianaCampaignFinanceContributionRows({ zipPath, year: 2026 })).rejects.toThrow(
      "Missing required Indiana campaign finance CSV column: Committee"
    );
  });
});
