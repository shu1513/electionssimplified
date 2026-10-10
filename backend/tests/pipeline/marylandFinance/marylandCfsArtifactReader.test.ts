import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MARYLAND_CFS_COMMITTEE_COLUMNS,
  MARYLAND_CFS_CONTRIBUTION_COLUMNS,
  MARYLAND_CFS_EXPENDITURE_COLUMNS,
  normalizeMarylandCfsExcelString,
  normalizeMarylandCfsHeader,
  parseMarylandCfsCommitteeCsvRows,
  parseMarylandCfsContributionCsvRows,
  parseMarylandCfsExpenditureCsvRows,
  parseMarylandCfsMoney,
  readMarylandCfsCommitteeRows,
  readMarylandCfsContributionRows,
  readMarylandCfsExpenditureRows,
} from "../../../src/pipeline/marylandFinance/marylandCfsArtifactReader.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-md-cfs-reader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow<TColumn extends string>(columns: readonly TColumn[], values: Partial<Record<TColumn, string>>): string {
  return columns.map((column) => csvCell(values[column] ?? "")).join(",");
}

function contributionCsv(
  rows: readonly Partial<Record<(typeof MARYLAND_CFS_CONTRIBUTION_COLUMNS)[number], string>>[]
): string {
  return [
    "Contributions and Loan Download as of 06/23/2026 01:01 AM,",
    MARYLAND_CFS_CONTRIBUTION_COLUMNS.join(","),
    ...rows.map((row) => csvRow(MARYLAND_CFS_CONTRIBUTION_COLUMNS, row)),
  ].join("\n");
}

function expenditureCsv(
  rows: readonly Partial<Record<(typeof MARYLAND_CFS_EXPENDITURE_COLUMNS)[number], string>>[]
): string {
  return [
    "Expenditure Download as of 06/25/2026 01:03 AM,",
    MARYLAND_CFS_EXPENDITURE_COLUMNS.join(","),
    ...rows.map((row) => csvRow(MARYLAND_CFS_EXPENDITURE_COLUMNS, row)),
  ].join("\n");
}

function committeeCsv(
  rows: readonly Partial<Record<(typeof MARYLAND_CFS_COMMITTEE_COLUMNS)[number], string>>[]
): string {
  return [
    "Committee Download as of 06/25/2026 01:03 AM,",
    MARYLAND_CFS_COMMITTEE_COLUMNS.join(","),
    ...rows.map((row) => csvRow(MARYLAND_CFS_COMMITTEE_COLUMNS, row)),
  ].join("\n");
}

describe("Maryland CFS artifact reader", () => {
  it("keeps unescaped quotes as content inside unquoted and quoted cells", () => {
    // Live 2025/2026 TCON exports: O"Meara and McDonald"s in unquoted cells,
    // 63 and 200 such lines; the strict parser threw and the yearly load
    // failed for every linked candidate.
    const columns = MARYLAND_CFS_CONTRIBUTION_COLUMNS;
    const line = (committee: string, last: string, amount: string, address: string): string =>
      columns
        .map((column) => {
          switch (column) {
            case "Filing Entity Id":
              return "1";
            case "Committee Name":
              return committee;
            case "Contributor Last Name":
              return last;
            case "Transaction Amount":
              return amount;
            case "Contributor Mailing Address1":
              return address;
            default:
              return "";
          }
        })
        .join(",");
    const rows = parseMarylandCfsContributionCsvRows(
      [
        columns.join(","),
        line('"Feldman, Brian Citizens For"', 'O"Meara', "$250.00", '"1 Churchview Road, Suite 301"'),
        line('"Beidle, Pam Friends of"', 'McDonald"s', "$250", '"Belt"s Transportation, Inc."'),
        line("Plain Committee", '"Quoted ""escaped"" Name"', "$5.00", '"Trailing" '),
      ].join("\r\n")
    );
    expect(
      rows.map((row) => [row["Committee Name"], row["Contributor Last Name"], row["Transaction Amount"], row["Contributor Mailing Address1"]])
    ).toEqual([
      ["Feldman, Brian Citizens For", 'O"Meara', "$250.00", "1 Churchview Road, Suite 301"],
      ["Beidle, Pam Friends of", 'McDonald"s', "$250", 'Belt"s Transportation, Inc.'],
      ["Plain Committee", 'Quoted "escaped" Name', "$5.00", "Trailing"],
    ]);
  });

  it("normalizes headers, Excel strings, and money values", () => {
    expect(normalizeMarylandCfsHeader("\uFEFFFiling Entity Id ")).toBe("Filing Entity Id");
    expect(normalizeMarylandCfsExcelString('="20678-1234"')).toBe("20678-1234");
    expect(parseMarylandCfsMoney("$1,234.56")).toBe(1234.56);
    expect(parseMarylandCfsMoney("($42.50)")).toBe(-42.5);
    expect(parseMarylandCfsMoney("")).toBeNull();
    expect(parseMarylandCfsMoney("not-money")).toBeNull();
  });

  it("parses contribution rows after the Maryland metadata row", () => {
    const rows = parseMarylandCfsContributionCsvRows(
      contributionCsv([
        {
          "Filing Entity Id": "5007501",
          "Committee Name": "Democratic State Central Committee Of Maryland",
          "Committee Type": "Party Central",
          "Contributor Type": "Business/Group/Organization",
          "Contributor Company Name": "Bill.com",
          "Contributor City": "Alviso",
          "Contributor State": "CA",
          "Contributor ZipCode": '="95002-2563"',
          "Transaction Type": "Contribution",
          "Transaction Date": "05/27/2026",
          "Transaction Amount": "$0.01",
          Description: "Bill pay verify system deposit",
          "Report Name": "2026 Pre-Primary 2 Gubernatorial",
        },
      ])
    );

    expect(rows).toEqual([
      expect.objectContaining({
        "Filing Entity Id": "5007501",
        "Contributor Company Name": "Bill.com",
        "Contributor ZipCode": '="95002-2563"',
        "Transaction Amount": "$0.01",
      }),
    ]);
  });

  it("rejects in-memory CSVs that only contain the Maryland metadata row", () => {
    expect(() =>
      parseMarylandCfsContributionCsvRows("Contributions and Loan Download as of 06/23/2026 01:01 AM,\n")
    ).toThrow("Missing Maryland CFS contribution CSV header row");
  });

  it("parses expenditure rows with outside-spending target fields", () => {
    const rows = parseMarylandCfsExpenditureCsvRows(
      expenditureCsv([
        {
          "Filing Entity Id": "16020172",
          "Committee Name": "HOMETOWN FREEDOM ACTION NETWORK",
          "Committee Type": "Super Political Action Committee (Super PAC)",
          "Transaction Type": "Independent Expenditure",
          "Transaction Date": "05/20/2026",
          "Transaction Amount": "$75,000.00",
          "Candidate/Ballot Issue": "Example, Alex",
          "Office Sought": "Governor/Lieutenant Governor",
          Position: "Support",
          "Amount Applied": "$75,000.00",
        },
      ])
    );

    expect(rows).toEqual([
      expect.objectContaining({
        "Filing Entity Id": "16020172",
        "Committee Type": "Super Political Action Committee (Super PAC)",
        "Candidate/Ballot Issue": "Example, Alex",
        Position: "Support",
        "Amount Applied": "$75,000.00",
      }),
    ]);
  });

  it("parses committee rows for candidate and outside groups", () => {
    const rows = parseMarylandCfsCommitteeCsvRows(
      committeeCsv([
        {
          "Filing Entity Id": "16020184",
          "Committee Name": "Momentum Maryland PAC",
          "Committee Type": "Super Political Action Committee (Super PAC)",
          Election: "Gubernatorial - 11/08/2026",
          "Purpose Of The Committee": "Independent Expenditures Only",
        },
        {
          "Filing Entity Id": "16018290",
          "Committee Name": "Gallucci, Justin Friends of",
          "Committee Type": "Candidate Committee",
          "Candidate LastName": "Gallucci",
          "Candidate First Name": "Justin",
          Jurisdiction: "Maryland State",
          "Office Sought": "State Senator",
          "Party Affiliation": "Republican",
        },
      ])
    );

    expect(rows).toEqual([
      expect.objectContaining({
        "Filing Entity Id": "16020184",
        "Committee Type": "Super Political Action Committee (Super PAC)",
        "Purpose Of The Committee": "Independent Expenditures Only",
      }),
      expect.objectContaining({
        "Filing Entity Id": "16018290",
        "Candidate LastName": "Gallucci",
        "Office Sought": "State Senator",
      }),
    ]);
  });

  it("streams contribution rows from disk with predicate and maxRows", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "TCON_2026.csv");
    await writeFile(
      filePath,
      contributionCsv([
        {
          "Filing Entity Id": "1001",
          "Committee Name": "Jane Doe for Governor",
          "Transaction Amount": "$100.00",
        },
        {
          "Filing Entity Id": "1002",
          "Committee Name": "Other Candidate",
          "Transaction Amount": "$200.00",
        },
        {
          "Filing Entity Id": "1001",
          "Committee Name": "Jane Doe for Governor",
          "Transaction Amount": "$300.00",
        },
      ]),
      "utf8"
    );

    await expect(
      readMarylandCfsContributionRows({
        filePath,
        predicate: (row) => row["Filing Entity Id"] === "1001",
        maxRows: 1,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        "Filing Entity Id": "1001",
        "Transaction Amount": "$100.00",
      }),
    ]);
  });

  it("rejects streamed CSVs that never provide a header row", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "TCON_2026.csv");
    await writeFile(filePath, "Contributions and Loan Download as of 06/23/2026 01:01 AM,\n", "utf8");

    await expect(readMarylandCfsContributionRows({ filePath })).rejects.toThrow(
      "Missing Maryland CFS contribution CSV header row"
    );
  });

  it("streams quoted multiline expenditure fields without splitting rows", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "TEXP_2026.csv");
    await writeFile(
      filePath,
      expenditureCsv([
        {
          "Filing Entity Id": "9001",
          "Committee Name": "Maryland Example IEC",
          Description: "line one\nline two",
          "Candidate/Ballot Issue": "Doe, Jane",
          Position: "Support",
        },
        {
          "Filing Entity Id": "9002",
          "Committee Name": "Candidate Committee",
          "Candidate/Ballot Issue": "Someone Else",
          Position: "Support",
        },
      ]),
      "utf8"
    );

    await expect(
      readMarylandCfsExpenditureRows({
        filePath,
        predicate: (row) => row["Filing Entity Id"] === "9001",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        Description: "line one\nline two",
        "Candidate/Ballot Issue": "Doe, Jane",
        Position: "Support",
      }),
    ]);
  });

  it("streams committee rows with predicate support", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "TCMD_2026.csv");
    await writeFile(
      filePath,
      committeeCsv([
        {
          "Filing Entity Id": "16020184",
          "Committee Name": "Momentum Maryland PAC",
          "Committee Type": "Super Political Action Committee (Super PAC)",
        },
        {
          "Filing Entity Id": "16018290",
          "Committee Name": "Gallucci, Justin Friends of",
          "Committee Type": "Candidate Committee",
        },
      ]),
      "utf8"
    );

    await expect(
      readMarylandCfsCommitteeRows({
        filePath,
        predicate: (row) => row["Committee Type"] === "Candidate Committee",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        "Filing Entity Id": "16018290",
        "Committee Type": "Candidate Committee",
      }),
    ]);
  });

  it("rejects duplicate and missing headers", () => {
    expect(() => parseMarylandCfsContributionCsvRows("Filing Entity Id,Filing Entity Id\n1,2\n")).toThrow(
      "Duplicate Maryland CFS CSV header"
    );

    const columns = MARYLAND_CFS_EXPENDITURE_COLUMNS.filter((column) => column !== "Position");
    expect(() => parseMarylandCfsExpenditureCsvRows(`${columns.join(",")}\n${columns.map(() => "").join(",")}\n`)).toThrow(
      "Missing required Maryland CFS expenditure CSV column: Position"
    );
  });

  it("rejects malformed quoted CSV and invalid maxRows", async () => {
    expect(() => parseMarylandCfsCommitteeCsvRows('Filing Entity Id,Committee Name\n1,"unterminated\n')).toThrow(
      "unterminated quoted field"
    );

    const dir = await makeTempDir();
    const filePath = join(dir, "TCON_2026.csv");
    await writeFile(filePath, contributionCsv([]), "utf8");

    await expect(readMarylandCfsContributionRows({ filePath, maxRows: 0 })).rejects.toThrow(
      "Invalid Maryland CFS maxRows"
    );
  });
});
