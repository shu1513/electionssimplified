import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS,
  oklahomaGuardianContributionCsvFileName,
  parseOklahomaGuardianContributionCsv,
  readOklahomaGuardianContributionRows,
} from "../../../src/pipeline/oklahomaFinance/oklahomaGuardianContributionReader.js";

type ZipFixtureEntry = {
  fileName: string;
  content?: string;
  compressionMethod?: 0 | 8;
};

let tempDirs: string[] = [];

function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.fileName, "utf8");
    const content = Buffer.from(entry.content ?? "", "utf8");
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

async function writeFixtureZip(entries: readonly ZipFixtureEntry[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ok-guardian-reader-"));
  tempDirs.push(dir);
  const zipPath = path.join(dir, "2026_ContributionLoanExtract.csv.zip");
  await writeFile(zipPath, makeZip(entries));
  return zipPath;
}

function csvValue(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function contributionRow(
  values: Partial<Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], string>>
): string {
  return OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map((column) => csvValue(values[column] ?? "")).join(",");
}

function contributionCsv(
  rows: readonly Partial<Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], string>>[]
): string {
  return [OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.join(","), ...rows.map(contributionRow)].join("\n");
}

describe("Oklahoma Guardian contribution reader", () => {
  afterEach(async () => {
    const dirs = tempDirs;
    tempDirs = [];
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds the official contribution CSV filename", () => {
    expect(oklahomaGuardianContributionCsvFileName(2026)).toBe("2026_ContributionLoanExtract.csv");
  });

  it("parses quoted contribution CSV rows", () => {
    expect(
      parseOklahomaGuardianContributionCsv(
        contributionCsv([
          {
            "Receipt ID": "123",
            "Org ID": "11808",
            "Receipt Amount": "125.50",
            "Committee Type": "Candidate Committee",
            "Committee Name": "Friends of Example",
            "Candidate Name": "Alex Example",
            Employer: "Acme, Inc.",
            Occupation: "Engineer",
          },
        ])
      )
    ).toEqual([
      expect.objectContaining({
        "Receipt ID": "123",
        "Org ID": "11808",
        "Candidate Name": "Alex Example",
        Employer: "Acme, Inc.",
      }),
    ]);
  });

  it("keeps standard escaped quotes before a comma intact", async () => {
    const csv = contributionCsv([
      { "Receipt ID": "1", "Org ID": "11808", Employer: 'ACME "NORTH", INC', Occupation: "ATTORNEY" },
    ]);
    const expected = [expect.objectContaining({ "Receipt ID": "1", Employer: 'ACME "NORTH", INC', Occupation: "ATTORNEY" })];
    expect(parseOklahomaGuardianContributionCsv(csv)).toEqual(expected);

    const zipPath = await writeFixtureZip([{ fileName: "2026_ContributionLoanExtract.csv", compressionMethod: 8, content: csv }]);
    await expect(readOklahomaGuardianContributionRows({ zipPath, year: 2026 })).resolves.toEqual(expected);
  });

  it("recovers rows whose inner quotes Guardian left undoubled", async () => {
    // Both shapes observed in the 2026 extract (2026-09-25): `"JAMES "JIM'"`
    // and `"COLATA "JODY""`. Under plain RFC-4180 parsing the first flips
    // the quote state and swallows every later row.
    const rawCells = (overrides: Partial<Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], string>>) =>
      OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map((column) => `"${overrides[column] ?? ""}"`).join(",");
    const csv = [
      OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.join(","),
      rawCells({ "Receipt ID": "2552500", "Org ID": "12403", "Middle Name": 'JAMES "JIM\'', "Candidate Name": "JASON LOWE" }),
      // A multi-line quoted field while the standard parse is still flipped:
      // it ends the mis-split row inside this field, so recovery must carry
      // its mid-field state into the rest of the input.
      contributionRow({ "Receipt ID": "3", "Org ID": "11808", "Candidate Name": "CYNDI MUNSON", Employer: "Acme, Inc.", Description: "PIZZA\nFOR VOLUNTEERS" }),
      rawCells({ "Receipt ID": "2501123", "Org ID": "11808", "First Name": 'COLATA "JODY"', "Candidate Name": "CYNDI MUNSON" }),
      // A valid escaped quote before a comma while tolerant mode is on must
      // keep its standard meaning.
      contributionRow({ "Receipt ID": "4", "Org ID": "11808", "Candidate Name": "CYNDI MUNSON", Employer: 'ACME "NORTH", INC', Occupation: "TEACHER" }),
    ].join("\n");
    const expected = [
      expect.objectContaining({ "Receipt ID": "2552500", "Middle Name": 'JAMES "JIM\'', "Candidate Name": "JASON LOWE" }),
      expect.objectContaining({ "Receipt ID": "3", Employer: "Acme, Inc.", Description: "PIZZA\nFOR VOLUNTEERS" }),
      expect.objectContaining({ "Receipt ID": "2501123", "First Name": 'COLATA "JODY"', "Candidate Name": "CYNDI MUNSON" }),
      expect.objectContaining({ "Receipt ID": "4", Employer: 'ACME "NORTH", INC', Occupation: "TEACHER" }),
    ];
    expect(parseOklahomaGuardianContributionCsv(csv)).toEqual(expected);

    const zipPath = await writeFixtureZip([{ fileName: "2026_ContributionLoanExtract.csv", compressionMethod: 8, content: csv }]);
    await expect(readOklahomaGuardianContributionRows({ zipPath, year: 2026 })).resolves.toEqual(expected);
  });

  it("fails a recovered row whose width still does not match the header", async () => {
    const jimRow = OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map((column) =>
      column === "Middle Name" ? '"JAMES "JIM\'"' : column === "Receipt ID" ? '"1"' : '""'
    ).join(",");
    const shortRow = '"2","11808","Monetary"';
    const csv = `${OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.join(",")}\n${jimRow}\n${shortRow}\n`;
    expect(() => parseOklahomaGuardianContributionCsv(csv)).toThrow(/has 3 cells, expected 23/);

    const zipPath = await writeFixtureZip([{ fileName: "2026_ContributionLoanExtract.csv", compressionMethod: 8, content: csv }]);
    await expect(readOklahomaGuardianContributionRows({ zipPath, year: 2026 })).rejects.toThrow(/has 3 cells, expected 23/);
  });

  it("still fails a quoted field that never closes", async () => {
    const csv = `${OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.join(",")}\n"1","11808","Monetary`;
    expect(() => parseOklahomaGuardianContributionCsv(csv)).toThrow(/unterminated quoted field/);

    const zipPath = await writeFixtureZip([{ fileName: "2026_ContributionLoanExtract.csv", compressionMethod: 8, content: csv }]);
    await expect(readOklahomaGuardianContributionRows({ zipPath, year: 2026 })).rejects.toThrow(/unterminated quoted field/);
  });

  it("reads deflated contribution rows from the expected yearly CSV entry", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "2026_ContributionLoanExtract.csv",
        compressionMethod: 8,
        content: contributionCsv([
          {
            "Receipt ID": "1",
            "Org ID": "11808",
            "Candidate Name": "CYNDI MUNSON",
            Employer: "MCAFEE & TAFT",
            Occupation: "ATTORNEY",
          },
          {
            "Receipt ID": "2",
            "Org ID": "99999",
            "Candidate Name": "OTHER CANDIDATE",
            Employer: "Beta",
            Occupation: "Teacher",
          },
        ]),
      },
    ]);

    await expect(
      readOklahomaGuardianContributionRows({
        zipPath,
        year: 2026,
        predicate: (row) => row["Candidate Name"] === "CYNDI MUNSON",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        "Receipt ID": "1",
        "Org ID": "11808",
        "Candidate Name": "CYNDI MUNSON",
        Occupation: "ATTORNEY",
      }),
    ]);
  });

  it("supports maxRows after filtering", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "2026_ContributionLoanExtract.csv",
        content: contributionCsv([
          { "Receipt ID": "1", "Candidate Name": "CYNDI MUNSON" },
          { "Receipt ID": "2", "Candidate Name": "CYNDI MUNSON" },
          { "Receipt ID": "3", "Candidate Name": "OTHER CANDIDATE" },
        ]),
      },
    ]);

    const rows = await readOklahomaGuardianContributionRows({
      zipPath,
      year: 2026,
      predicate: (row) => row["Candidate Name"] === "CYNDI MUNSON",
      maxRows: 1,
    });

    expect(rows).toEqual([expect.objectContaining({ "Receipt ID": "1" })]);
  });

  it("throws when the expected yearly CSV entry is missing", async () => {
    const zipPath = await writeFixtureZip([
      {
        fileName: "wrong.csv",
        content: contributionCsv([]),
      },
    ]);

    await expect(readOklahomaGuardianContributionRows({ zipPath, year: 2026 })).rejects.toThrow(
      "Oklahoma Guardian contribution CSV not found in ZIP: 2026_ContributionLoanExtract.csv"
    );
  });

  it("throws when a required column is missing", () => {
    const columns = OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.filter((column) => column !== "Occupation");
    expect(() => parseOklahomaGuardianContributionCsv(columns.join(","))).toThrow(
      "Missing required Oklahoma Guardian contribution CSV column: Occupation"
    );
  });
});
