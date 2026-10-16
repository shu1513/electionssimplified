import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME,
  MINNESOTA_CAMPAIGN_FINANCE_IE_CONTRIBUTORS_CSV_FILE_NAME,
  MINNESOTA_CAMPAIGN_FINANCE_INDEPENDENT_EXPENDITURES_CSV_FILE_NAME,
  normalizeMinnesotaCampaignFinanceHeader,
  parseMinnesotaCampaignFinanceContributionCsvRows,
  parseMinnesotaCampaignFinanceIndependentExpenditureContributionCsvRows,
  parseMinnesotaCampaignFinanceIndependentExpenditureCsvRows,
  readMinnesotaCampaignFinanceContributionRows,
  readMinnesotaCampaignFinanceIndependentExpenditureContributionRows,
  readMinnesotaCampaignFinanceIndependentExpenditureRows,
  readMinnesotaCampaignFinanceNativeRows,
} from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactReader.js";

const tempDirs: string[] = [];

const nativeReceiptHeaders = [
  "Recipient reg num", "Recipient", "Recipient type", "Recipient subtype", "Amount",
  "Receipt date", "Year", "Contributor", "Contrib Reg Num", "Contrib type", "Receipt type",
  "In kind?", "In-kind descr", "Contrib zip", "Contrib Employer name",
];
const nativeValues = { "Recipient reg num": "10001", Recipient: "Example Candidate Committee",
  "Recipient type": "PCC", Amount: ".2500", "Receipt date": "2026-01-01", Year: "2026",
  Contributor: "Example Committee", "Contrib Reg Num": "30001", "Contrib type": "Political Committee/Fund",
  "Receipt type": "Contribution", "In kind?": "No" };
function nativeCsv(): string {
  return `${nativeReceiptHeaders.join(",")}\n${csvRow(nativeReceiptHeaders, nativeValues)}\n`;
}
async function nativeInput(bytes: Buffer | string) {
  const dir = await makeTempDir();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const filePath = join(dir, "native.csv");
  await writeFile(filePath, buffer);
  return { filePath, key: "contributions_received" as const,
    expectedBytes: buffer.length, expectedSha256: createHash("sha256").update(buffer).digest("hex") };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-mn-cf-reader-"));
  tempDirs.push(dir);
  return dir;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(columns: readonly string[], values: Record<string, string>): string {
  return columns.map((column) => csvCell(values[column] ?? "")).join(",");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Minnesota campaign finance artifact reader", () => {
  it("qualifies a complete native original and retains only requested rows", async () => {
    const input = await nativeInput(`\uFEFF${nativeCsv()}`);
    const result = await readMinnesotaCampaignFinanceNativeRows({ ...input, predicate: () => false });
    expect(result.rows).toEqual([]);
    expect(result.sourceFacts).toEqual({ rowCount: 1, byteCount: input.expectedBytes,
      sha256: input.expectedSha256, headers: nativeReceiptHeaders });
  });

  it.each(["short", "extra", "unterminated", "empty_delimited"] as const)("rejects %s filtered-away tails after a valid match", async (shape) => {
    const tail = shape === "short" ? "10001,hidden" : shape === "extra"
      ? `${csvRow(nativeReceiptHeaders, nativeValues)},hidden` : shape === "empty_delimited" ? ",," : '10001,"hidden';
    const input = await nativeInput(`${nativeCsv()}${tail}`);
    await expect(readMinnesotaCampaignFinanceNativeRows({ ...input, predicate: (row) => row.Amount === ".2500" }))
      .rejects.toThrow(/^Minnesota campaign finance source invalid:/);
  });

  it.each(["duplicate", "blank", "missing", "html", "empty"] as const)("rejects %s native schemas", async (shape) => {
    const headers = [...nativeReceiptHeaders];
    if (shape === "duplicate") headers[1] = headers[0]!;
    if (shape === "blank") headers[1] = "";
    if (shape === "missing") headers.pop();
    const csv = shape === "html" ? "<html>unavailable</html>" : shape === "empty"
      ? headers.join(",") : `${headers.join(",")}\n${csvRow(headers, nativeValues)}`;
    await expect(readMinnesotaCampaignFinanceNativeRows(await nativeInput(csv))).rejects.toThrow(
      /^Minnesota campaign finance source invalid: (schema|empty_bulk)$/);
  });

  it("rejects invalid UTF8 even in a filtered-away row", async () => {
    const buffer = Buffer.concat([Buffer.from(nativeCsv()), Buffer.from([0xc3, 0x28])]);
    await expect(readMinnesotaCampaignFinanceNativeRows({ ...await nativeInput(buffer), predicate: () => false }))
      .rejects.toThrow("Minnesota campaign finance source invalid: encoding_or_csv_or_read");
  });

  it.each(['1"0.00"', '"10.00"suffix'])("rejects invalid quote placement in monetary cells: %s", async (value) => {
    const input = await nativeInput(nativeCsv().replace(".2500", value));
    await expect(readMinnesotaCampaignFinanceNativeRows(input)).rejects.toThrow("source invalid: csv_quote");
  });

  it.each([
    { Amount: "unavailable" }, { Amount: "-1.00" }, { Year: "unknown" }, { Type: "Other expense" },
    { "For /Against": "Unknown" }, { Spender: "" }, { "Spender Reg Num": "" },
  ])("holds unallocatable native IE fields before a bad row can become zero: %j", async (overrides) => {
    const headers = "Spender|Spender Reg Num|Spender type|Spender sub-type|Affected Comte Name|Affected Cmte Reg Num|For /Against|Year|Date|Type|Amount|Unpaid amount|In kind?|In kind descr|Purpose|Vendor name|Vendor city|Vendor State|Vendor zip".split("|");
    const values = { Spender: "Example Committee", "Spender Reg Num": "3001", "Affected Cmte Reg Num": "1001",
      "For /Against": "For", Year: "2026", Type: "Independent Expenditure", Amount: ".25", ...overrides };
    const input = await nativeInput(`${headers.join(",")}\n${csvRow(headers, values)}`);
    await expect(readMinnesotaCampaignFinanceNativeRows({ ...input, key: "independent_expenditures", predicate: () => false }))
      .rejects.toThrow("source invalid: ie_fields");
  });

  it("detects same-size corruption and byte-count mismatch before returning rows", async () => {
    const input = await nativeInput(nativeCsv());
    await writeFile(input.filePath, nativeCsv().replace(".2500", ".3500"));
    await expect(readMinnesotaCampaignFinanceNativeRows(input)).rejects.toThrow("source invalid: sha256");
    await expect(readMinnesotaCampaignFinanceNativeRows({ ...input, expectedBytes: input.expectedBytes + 1 }))
      .rejects.toThrow("source invalid: byte_count");
  });

  it("supports reordered native headers, multiline and publisher escaped quotes across chunks", async () => {
    const headers = [...nativeReceiptHeaders].reverse();
    const prefix = `${headers.join(",")}\n`;
    const csv = `${prefix}${csvRow(headers, { ...nativeValues, "In-kind descr": "line one\nline two" })}\n`;
    expect((await readMinnesotaCampaignFinanceNativeRows(await nativeInput(csv))).rows[0]?.["In-kind descr"])
      .toBe("line one\nline two");
    const standardRow = csvRow(nativeReceiptHeaders, nativeValues);
    const rowPrefix = standardRow.slice(0, standardRow.indexOf("Example Committee"));
    const header = `${nativeReceiptHeaders.join(",")}\n`;
    const filler = "x".repeat(64 * 1024 - Buffer.byteLength(header + rowPrefix) - 3);
    const escapedRow = standardRow.replace("Example Committee", `"${filler}\\\"\"`);
    const result = await readMinnesotaCampaignFinanceNativeRows(await nativeInput(header + escapedRow));
    expect(result.rows[0]?.Contributor).toBe(`${filler}"`);
  });

  it("normalizes headers", () => {
    expect(normalizeMinnesotaCampaignFinanceHeader("\uFEFF Recipient ")).toBe("Recipient");
  });

  it("parses contributions with quoted commas and multiline values", () => {
    const csv = [
      [
        "Recipient reg num",
        "Recipient",
        "Recipient type",
        "Recipient subtype",
        "Amount",
        "Receipt date",
        "Year",
        "Contributor",
        "Contrib Reg Num",
        "Contrib type",
        "Receipt type",
        "In kind?",
        "In-kind descr",
        "Contrib zip",
        "Contrib Employer name",
      ].join(","),
      csvRow(
        [
          "Recipient reg num",
          "Recipient",
          "Recipient type",
          "Recipient subtype",
          "Amount",
          "Receipt date",
          "Year",
          "Contributor",
          "Contrib Reg Num",
          "Contrib type",
          "Receipt type",
          "In kind?",
          "In-kind descr",
          "Contrib zip",
          "Contrib Employer name",
        ],
        {
          "Recipient reg num": "CC10174",
          Recipient: "Friends of Example",
          "Recipient type": "Candidate",
          "Recipient subtype": "Statewide",
          Amount: "125.50",
          "Receipt date": "2026-06-01",
          Year: "2026",
          Contributor: "Acme, Inc.",
          "Contrib Reg Num": "C123",
          "Contrib type": "Business",
          "Receipt type": "Contribution",
          "In kind?": "N",
          "In-kind descr": "line one\nline two",
          "Contrib zip": "55111",
          "Contrib Employer name": "Acme Holdings",
        }
      ),
    ].join("\n");

    expect(parseMinnesotaCampaignFinanceContributionCsvRows(csv)).toEqual([
      expect.objectContaining({
        "Recipient reg num": "CC10174",
        Recipient: "Friends of Example",
        Amount: "125.50",
        Contributor: "Acme, Inc.",
        "In-kind descr": "line one\nline two",
        "Contrib Employer name": "Acme Holdings",
      }),
    ]);
  });

  it("tolerates the CFB export's backslash-escaped quotes in quoted fields", async () => {
    const csv = String.raw`Recipient reg num,Recipient,Recipient type,Recipient subtype,Amount,Year,Contributor,Contrib type
18894,"Hinnenkamp, Mary House Committee",PCC,,125.0000,2022,"Ehrhardt, George \\\"Mac\\\"",Individual`;

    expect(parseMinnesotaCampaignFinanceContributionCsvRows(csv)).toEqual([
      expect.objectContaining({
        Recipient: "Hinnenkamp, Mary House Committee",
        Contributor: 'Ehrhardt, George \\\\"Mac\\\\"',
        "Contrib type": "Individual",
      }),
    ]);

    const dir = await makeTempDir();
    const filePath = join(dir, MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME);
    await writeFile(filePath, csv, "utf8");
    await expect(readMinnesotaCampaignFinanceContributionRows({ filePath })).resolves.toEqual([
      expect.objectContaining({
        Recipient: "Hinnenkamp, Mary House Committee",
        "Contrib type": "Individual",
      }),
    ]);
  });

  it("keeps a trailing backslash before a quoted-field terminator", () => {
    const csv = String.raw`Recipient reg num,Recipient,Recipient type,Amount,Year,Contributor,Contrib type
18894,"Hinnenkamp, Mary House Committee",PCC,125.0000,2022,"Example\",Individual`;

    expect(parseMinnesotaCampaignFinanceContributionCsvRows(csv)).toEqual([
      expect.objectContaining({
        Contributor: "Example\\",
        "Contrib type": "Individual",
      }),
    ]);
  });

  it("handles a backslash-escaped quote split across stream chunks", async () => {
    const header =
      "Recipient reg num,Recipient,Recipient type,Amount,Year,Contributor,Contrib type";
    const rowPrefix = '18894,"Hinnenkamp, Mary House Committee",PCC,125.0000,2022,"';
    const bytesBeforeValue = Buffer.byteLength(`${header}\n${rowPrefix}`);
    const filler = "x".repeat(64 * 1024 - bytesBeforeValue - 2);
    const csv = `${header}\n${rowPrefix}${filler}\\\"\",Individual`;
    const dir = await makeTempDir();
    const filePath = join(dir, MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME);
    await writeFile(filePath, csv, "utf8");

    await expect(readMinnesotaCampaignFinanceContributionRows({ filePath })).resolves.toEqual([
      expect.objectContaining({
        Contributor: `${filler}\"`,
        "Contrib type": "Individual",
      }),
    ]);
  });

  it("parses independent expenditure rows", () => {
    const csv = [
      [
        "Spender",
        "Spender Reg Num",
        "Spender type",
        "Spender sub-type",
        "Affected Comte Name",
        "Affected Cmte Reg Num",
        "For /Against",
        "Year",
        "Date",
        "Type",
        "Amount",
        "Unpaid amount",
        "In kind?",
        "In kind descr",
        "Purpose",
        "Vendor name",
        "Vendor city",
        "Vendor State",
        "Vendor zip",
      ].join(","),
      csvRow(
        [
          "Spender",
          "Spender Reg Num",
          "Spender type",
          "Spender sub-type",
          "Affected Comte Name",
          "Affected Cmte Reg Num",
          "For /Against",
          "Year",
          "Date",
          "Type",
          "Amount",
          "Unpaid amount",
          "In kind?",
          "In kind descr",
          "Purpose",
          "Vendor name",
          "Vendor city",
          "Vendor State",
          "Vendor zip",
        ],
        {
          Spender: "Better Minnesota",
          "Spender Reg Num": "SP123",
          "Spender type": "PAC",
          "Spender sub-type": "Independent expenditure",
          "Affected Comte Name": "Friends of Example",
          "Affected Cmte Reg Num": "CC10174",
          "For /Against": "For",
          Year: "2026",
          Date: "2026-09-01",
          Type: "Independent Expenditure",
          Amount: "70000.00",
          "Unpaid amount": "0.00",
          "In kind?": "N",
          "In kind descr": "",
          Purpose: "Support for Example",
          "Vendor name": "Mail House",
          "Vendor city": "St Paul",
          "Vendor State": "MN",
          "Vendor zip": "55101",
        }
      ),
    ].join("\n");

    expect(parseMinnesotaCampaignFinanceIndependentExpenditureCsvRows(csv)).toEqual([
      expect.objectContaining({
        Spender: "Better Minnesota",
        "Affected Cmte Reg Num": "CC10174",
        "For /Against": "For",
        Amount: "70000.00",
        Purpose: "Support for Example",
      }),
    ]);
  });

  it("parses independent expenditure committee contribution rows", () => {
    const csv = [
      [
        "Recipient reg num",
        "Recipient",
        "Recipient type",
        "Recipient subtype",
        "Amount",
        "Receipt date",
        "Year",
        "Contributor",
        "Contrib Reg Num",
        "Contrib type",
        "Receipt type",
        "In kind?",
        "In-kind descr",
        "Contrib zip",
        "Contrib Employer name",
      ].join(","),
      csvRow(
        [
          "Recipient reg num",
          "Recipient",
          "Recipient type",
          "Recipient subtype",
          "Amount",
          "Receipt date",
          "Year",
          "Contributor",
          "Contrib Reg Num",
          "Contrib type",
          "Receipt type",
          "In kind?",
          "In-kind descr",
          "Contrib zip",
          "Contrib Employer name",
        ],
        {
          "Recipient reg num": "SP123",
          Recipient: "Better Minnesota",
          Amount: "20000.00",
          Contributor: "Union PAC",
          "Contrib Reg Num": "C789",
          "Contrib type": "Business",
          "Receipt type": "Contribution",
          "Contrib Employer name": "Union PAC Holdings",
        }
      ),
    ].join("\n");

    expect(parseMinnesotaCampaignFinanceIndependentExpenditureContributionCsvRows(csv)).toEqual([
      expect.objectContaining({
        Recipient: "Better Minnesota",
        Contributor: "Union PAC",
        Amount: "20000.00",
      }),
    ]);
  });

  it("streams and filters contribution rows from disk", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME);
    await writeFile(
      filePath,
      [
        [
          "Recipient reg num",
          "Recipient",
          "Amount",
          "Contributor",
          "Contrib type",
          "Contrib Employer name",
        ].join(","),
        `CC10174,Friends of Example,125.50,"Acme, Inc.",Business,Acme Holdings`,
        `CC10174,Friends of Example,300.00,Other Org,Business,Other Holdings`,
      ].join("\n"),
      "utf8"
    );

    await expect(
      readMinnesotaCampaignFinanceContributionRows({
        filePath,
        predicate: (row) => row.Contributor.includes("Acme"),
        maxRows: 1,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        Recipient: "Friends of Example",
        Amount: "125.50",
        Contributor: "Acme, Inc.",
      }),
    ]);
  });

  it("streams and filters independent expenditure rows from disk", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, MINNESOTA_CAMPAIGN_FINANCE_INDEPENDENT_EXPENDITURES_CSV_FILE_NAME);
    await writeFile(
      filePath,
      [
        [
          "Spender",
          "Affected Cmte Reg Num",
          "For /Against",
          "Type",
          "Amount",
          "Purpose",
        ].join(","),
        `Better Minnesota,CC10174,For,Independent Expenditure,70000.00,"Support for Example"`,
        `Other PAC,ZZ999,Against,Independent Expenditure,1000.00,"Oppose Other"`,
      ].join("\n"),
      "utf8"
    );

    await expect(
      readMinnesotaCampaignFinanceIndependentExpenditureRows({
        filePath,
        predicate: (row) => row["Affected Cmte Reg Num"] === "CC10174",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        Spender: "Better Minnesota",
        "For /Against": "For",
        Amount: "70000.00",
      }),
    ]);
  });

  it("streams independent expenditure contributor rows from disk", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, MINNESOTA_CAMPAIGN_FINANCE_IE_CONTRIBUTORS_CSV_FILE_NAME);
    await writeFile(
      filePath,
      [
        [
          "Recipient reg num",
          "Recipient",
          "Amount",
          "Contributor",
          "Contrib type",
          "Contrib Employer name",
        ].join(","),
        `SP123,Better Minnesota,20000.00,"Union PAC",Business,Union PAC Holdings`,
      ].join("\n"),
      "utf8"
    );

    await expect(
      readMinnesotaCampaignFinanceIndependentExpenditureContributionRows({
        filePath,
        predicate: (row) => row.Recipient === "Better Minnesota",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        Recipient: "Better Minnesota",
        Contributor: "Union PAC",
        Amount: "20000.00",
      }),
    ]);
  });

  it("rejects duplicate headers", () => {
    expect(() => parseMinnesotaCampaignFinanceContributionCsvRows("Recipient,Recipient\n1,2\n")).toThrow(
      "Duplicate Minnesota campaign finance CSV header"
    );
  });

  it("rejects malformed quoted csv", () => {
    expect(() => parseMinnesotaCampaignFinanceIndependentExpenditureCsvRows('Spender,Amount\n"unterminated\n')).toThrow(
      "unterminated quoted field"
    );
  });

  it("rejects invalid maxRows", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME);
    await writeFile(filePath, "Recipient,Amount\nExample,1\n", "utf8");

    await expect(readMinnesotaCampaignFinanceContributionRows({ filePath, maxRows: 0 })).rejects.toThrow(
      "Invalid Minnesota campaign finance maxRows"
    );
  });
});
