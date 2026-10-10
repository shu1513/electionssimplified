import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PENNSYLVANIA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,
  PENNSYLVANIA_CAMPAIGN_FINANCE_FILER_COLUMNS,
  findPennsylvaniaCampaignFinanceTableFile,
  listPennsylvaniaCampaignFinanceExtractedFileNames,
  parsePennsylvaniaCampaignFinanceCsvRows,
  pennsylvaniaCampaignFinanceTableFileName,
  readPennsylvaniaCampaignFinanceContributionRows,
  readPennsylvaniaCampaignFinanceFilerRows,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaCampaignFinanceReader.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-pa-cf-reader-"));
  tempDirs.push(dir);
  return dir;
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

async function writeCsv(
  dir: string,
  fileName: string,
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): Promise<void> {
  await writeFile(join(dir, fileName), `${csv(headers, rows)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pennsylvania campaign finance export reader", () => {
  it("builds known yearly table file names", () => {
    expect(pennsylvaniaCampaignFinanceTableFileName({ table: "contrib", year: 2026 })).toBe("contrib_2026.txt");
    expect(pennsylvaniaCampaignFinanceTableFileName({ table: "filer", year: 2024 })).toBe("filer_2024.txt");
    expect(() => pennsylvaniaCampaignFinanceTableFileName({ table: "contrib", year: 1999 })).toThrow(
      "Invalid Pennsylvania campaign finance export year"
    );
  });

  it("parses quoted CSV cells and trims headers and values", () => {
    const rows = parsePennsylvaniaCampaignFinanceCsvRows({
      csv: "\uFEFFname,amount,notes\n\"Smith, Jane\", \"100.00\" ,\"line 1\nline 2\"\n",
      requiredColumns: ["name", "amount"],
      tableLabel: "fixture",
    });

    expect(rows).toEqual([
      {
        name: "Smith, Jane",
        amount: "100.00",
        notes: "line 1\nline 2",
      },
    ]);
  });

  it("keeps unescaped quotes inside quoted cells as content", () => {
    // Live 2025/2026 exports: "Grace d"Alo", "MARINUCCI"S DELI", and
    // "CAROLYN SUSIE" STEWART" — none escaped as "". The strict parser threw
    // "unterminated quoted field" and the whole yearly load failed.
    const rows = parsePennsylvaniaCampaignFinanceCsvRows({
      csv: [
        "ID,NAME,CITY,AMOUNT",
        '1,"Grace d"Alo","Carlisle",100.00',
        '2,"MARINUCCI"S DELI","PHILA",59.58',
        '3,"CAROLYN SUSIE" STEWART","SYLVA",66.67',
        '4,"Raise The Money, Inc.\nRaise the Money, Inc.","Little Rock",44.89',
        '5,"Plain ""escaped"" quote","York",1.00',
        '6,"Trailing space" ,"Erie",2.00',
      ].join("\r\n"),
    });
    expect(rows.map((row) => [row.NAME, row.CITY, row.AMOUNT])).toEqual([
      ['Grace d"Alo', "Carlisle", "100.00"],
      ['MARINUCCI"S DELI', "PHILA", "59.58"],
      ['CAROLYN SUSIE" STEWART', "SYLVA", "66.67"],
      ["Raise The Money, Inc.\nRaise the Money, Inc.", "Little Rock", "44.89"],
      ['Plain "escaped" quote', "York", "1.00"],
      ["Trailing space", "Erie", "2.00"],
    ]);
  });

  it("lists extracted files and finds root or nested yearly tables", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "contrib_2026.txt"), "a\n", "utf8");
    await mkdir(join(dir, "2024"));
    await writeFile(join(dir, "2024", "filer_2024.txt"), "a\n", "utf8");

    await expect(listPennsylvaniaCampaignFinanceExtractedFileNames(dir)).resolves.toEqual([
      "2024/filer_2024.txt",
      "contrib_2026.txt",
    ]);
    await expect(
      findPennsylvaniaCampaignFinanceTableFile({ extractedDir: dir, table: "contrib", year: 2026 })
    ).resolves.toBe(join(dir, "contrib_2026.txt"));
    await expect(
      findPennsylvaniaCampaignFinanceTableFile({ extractedDir: dir, table: "filer", year: 2024 })
    ).resolves.toBe(join(dir, "2024", "filer_2024.txt"));
  });

  it("streams contribution rows with predicate and maxRows", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "2024"));
    await writeCsv(join(dir, "2024"), "contrib_2024.txt", PENNSYLVANIA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS, [
      {
        CampaignFinanceID: "1",
        FilerID: "100",
        EYEAR: "2024",
        Section: "IB",
        CONTRIBUTOR: "Jane Doe",
        OCCUPATION: "Attorney",
        CONTDATE1: "20241001",
        CONTAMT1: "100.00",
      },
      {
        CampaignFinanceID: "2",
        FilerID: "200",
        EYEAR: "2024",
        Section: "IC",
        CONTRIBUTOR: "Other Donor",
        CONTDATE1: "20241002",
        CONTAMT1: "250.00",
      },
      {
        CampaignFinanceID: "3",
        FilerID: "100",
        EYEAR: "2024",
        Section: "IB",
        CONTRIBUTOR: "John Roe",
        OCCUPATION: "Teacher",
        CONTDATE1: "20241003",
        CONTAMT1: "50.00",
      },
    ]);

    await expect(
      readPennsylvaniaCampaignFinanceContributionRows({
        extractedDir: dir,
        year: 2024,
        predicate: (row) => row.FilerID === "100",
        maxRows: 1,
      })
    ).resolves.toMatchObject([
      {
        CampaignFinanceID: "1",
        FilerID: "100",
        CONTRIBUTOR: "Jane Doe",
        OCCUPATION: "Attorney",
        CONTAMT1: "100.00",
      },
    ]);
  });

  it("decodes Pennsylvania export files as latin1", async () => {
    const dir = await makeTempDir();
    const content = `${csv(PENNSYLVANIA_CAMPAIGN_FINANCE_FILER_COLUMNS, [
      {
        CampaignfinanceID: "10",
        FILERID: "20240001",
        EYEAR: "2024",
        FILERTYPE: "2",
        FILERNAME: "PEÑA FOR PA",
        OFFICE: "STH",
        DISTRICT: "1",
      },
    ])}\n`;
    await writeFile(join(dir, "filer_2024.txt"), Buffer.from(content, "latin1"));

    await expect(
      readPennsylvaniaCampaignFinanceFilerRows({
        extractedDir: dir,
        year: 2024,
      })
    ).resolves.toMatchObject([
      {
        FILERID: "20240001",
        FILERNAME: "PEÑA FOR PA",
      },
    ]);
  });

  it("fails loudly when a required typed column is missing", async () => {
    const dir = await makeTempDir();
    await writeCsv(dir, "filer_2024.txt", ["FILERID", "FILERNAME"], [
      {
        FILERID: "20240001",
        FILERNAME: "FRIENDS OF EXAMPLE",
      },
    ]);

    await expect(
      readPennsylvaniaCampaignFinanceFilerRows({
        extractedDir: dir,
        year: 2024,
      })
    ).rejects.toThrow("Missing required Pennsylvania campaign finance filer CSV column: CampaignfinanceID");
  });
});
