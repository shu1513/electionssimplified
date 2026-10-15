import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { MinnesotaCampaignFinanceDownloadKey } from "./minnesotaCampaignFinanceArtifactCache.js";

import {
  MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME,
  MINNESOTA_CAMPAIGN_FINANCE_IE_CONTRIBUTORS_CSV_FILE_NAME,
  MINNESOTA_CAMPAIGN_FINANCE_INDEPENDENT_EXPENDITURES_CSV_FILE_NAME,
} from "./minnesotaCampaignFinanceArtifactCache.js";

export type MinnesotaCampaignFinanceCsvRow = Record<string, string>;
export type MinnesotaCampaignFinanceCsvRowPredicate = (row: MinnesotaCampaignFinanceCsvRow) => boolean;

const RECEIPT_HEADERS = [
  "Recipient reg num", "Recipient", "Recipient type", "Recipient subtype", "Amount",
  "Receipt date", "Year", "Contributor", "Contrib Reg Num", "Contrib type",
  "Receipt type", "In kind?", "In-kind descr", "Contrib zip", "Contrib Employer name",
];
const IE_HEADERS = [
  "Spender", "Spender Reg Num", "Spender type", "Spender sub-type", "Affected Comte Name",
  "Affected Cmte Reg Num", "For /Against", "Year", "Date", "Type", "Amount", "Unpaid amount",
  "In kind?", "In kind descr", "Purpose", "Vendor name", "Vendor city", "Vendor State", "Vendor zip",
];

export type MinnesotaCampaignFinanceSourceFacts = {
  rowCount: number;
  byteCount: number;
  sha256: string;
  headers: string[];
};

type NativeQualification = {
  key: MinnesotaCampaignFinanceDownloadKey;
  expectedSha256: string;
  expectedBytes: number;
};

function nativeFailure(reason: string): Error {
  return new Error(`Minnesota campaign finance source invalid: ${reason}`);
}

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Minnesota campaign finance ${fieldName}: ${value}`);
  }
  return value;
}

export function normalizeMinnesotaCampaignFinanceHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function buildHeader(cells: readonly string[]): string[] {
  const header = cells.map(normalizeMinnesotaCampaignFinanceHeader);
  const seen = new Set<string>();
  for (const name of header) {
    if (!name) {
      continue;
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate Minnesota campaign finance CSV header: ${name}`);
    }
    seen.add(name);
  }
  if (seen.size === 0) {
    throw new Error("Minnesota campaign finance CSV header row is empty");
  }
  return header;
}

function rowObjectFromCells(headers: readonly string[], row: readonly string[]): MinnesotaCampaignFinanceCsvRow {
  return Object.fromEntries(
    headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? ""])
  );
}

function consumeBackslashEscapedQuote(field: string, nextCharacter: string | undefined): string | null {
  if (
    nextCharacter === undefined ||
    nextCharacter === "," ||
    nextCharacter === "\n" ||
    nextCharacter === "\r"
  ) {
    return null;
  }

  let backslashCount = 0;
  for (let index = field.length - 1; index >= 0 && field[index] === "\\"; index -= 1) {
    backslashCount += 1;
  }
  if (backslashCount % 2 === 0) {
    return null;
  }

  // The live CFB export occasionally emits \" inside a quoted field instead
  // of RFC 4180's doubled quote. Remove the escaping slash and keep the quote
  // as field content so one malformed description cannot discard the dataset.
  return `${field.slice(0, -1)}"`;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let pendingQuoteInQuotedField = false;

  const finishRow = (): void => {
    row.push(field);
    if (row.some((value) => value.trim().length > 0)) {
      rows.push(row);
    }
    row = [];
    field = "";
  };

  const processText = (text: string, isFinal = false): void => {
    let index = 0;
    if (pendingQuoteInQuotedField) {
      pendingQuoteInQuotedField = false;
      const escapedField = consumeBackslashEscapedQuote(field, text[0]);
      if (escapedField !== null) {
        field = escapedField;
      } else if (text[0] === '"') {
        field += '"';
        index = 1;
      } else {
        inQuotes = false;
      }
    }

    for (; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (inQuotes) {
        const escapedField = char === '"' ? consumeBackslashEscapedQuote(field, next) : null;
        if (escapedField !== null) {
          field = escapedField;
        } else if (char === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (char === '"' && next === undefined && !isFinal) {
          pendingQuoteInQuotedField = true;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
        continue;
      }

      if (char === '"') {
        inQuotes = true;
        continue;
      }

      if (char === ",") {
        row.push(field);
        field = "";
        continue;
      }

      if (char === "\n") {
        finishRow();
        continue;
      }

      if (char === "\r") {
        continue;
      }

      field += char;
    }
  };

  processText(csv, true);
  if (inQuotes || pendingQuoteInQuotedField) {
    throw new Error("Minnesota campaign finance CSV has an unterminated quoted field");
  }
  if (field.length > 0 || row.length > 0) {
    finishRow();
  }

  return rows;
}

function parseRowsForCsv(csv: string): MinnesotaCampaignFinanceCsvRow[] {
  const rows = parseCsvRows(csv);
  const headerCells = rows[0];
  if (!headerCells) {
    return [];
  }
  const headers = buildHeader(headerCells);
  return rows.slice(1).map((cells) => rowObjectFromCells(headers, cells));
}

async function readMinnesotaCampaignFinanceCsvRowsFromFile(input: {
  filePath: string;
  predicate?: MinnesotaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
  native?: NativeQualification;
}): Promise<{ rows: MinnesotaCampaignFinanceCsvRow[]; sourceFacts: MinnesotaCampaignFinanceSourceFacts }> {
  const maxRows = normalizePositiveInteger(input.maxRows, "maxRows");
  const source = createReadStream(input.filePath);
  const decoder = input.native ? new TextDecoder("utf-8", { fatal: true }) : null;
  const looseDecoder = new StringDecoder("utf8");
  const hash = createHash("sha256");
  let byteCount = 0;
  let rowCount = 0;

  return await new Promise((resolve, reject) => {
    const rows: MinnesotaCampaignFinanceCsvRow[] = [];
    let headers: string[] | null = null;
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let pendingQuoteInQuotedField = false;
    let quoteClosed = false;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ rows, sourceFacts: { rowCount, byteCount, sha256: hash.digest("hex"), headers: headers ?? [] } });
    };

    const finishRow = (): void => {
      row.push(field);
      const cells = row;
      row = [];
      field = "";
      quoteClosed = false;

      if (input.native
        ? cells.length === 1 && cells[0]?.trim() === ""
        : !cells.some((value) => value.trim().length > 0)) {
        return;
      }
      if (!headers) {
        if (input.native) {
          const expected = input.native.key === "independent_expenditures" ? IE_HEADERS : RECEIPT_HEADERS;
          const normalized = cells.map(normalizeMinnesotaCampaignFinanceHeader);
          if (normalized.length !== expected.length || new Set(normalized).size !== expected.length ||
            expected.some((header) => !normalized.includes(header))) {
            throw nativeFailure("schema");
          }
          headers = normalized;
        } else {
          headers = buildHeader(cells);
        }
        return;
      }
      if (input.native && cells.length !== headers.length) throw nativeFailure("row_width");
      rowCount += 1;
      if (maxRows !== undefined && rows.length >= maxRows) {
        return;
      }

      const parsedRow = rowObjectFromCells(headers, cells);
      if (input.native?.key === "independent_expenditures") {
        const amount = parsedRow.Amount?.trim() ?? "";
        // A malformed native IE must not turn a previously positive component
        // into zero when the allocator otherwise skips unsupported rows.
        if (!/^-?(?:\d+|\d*\.\d{1,4})$/.test(amount) || Number(amount) < 0 ||
          !Number.isSafeInteger(Math.round(Number(amount) * 100)) ||
          !/^\d{4}$/.test(parsedRow.Year?.trim() ?? "") ||
          parsedRow.Type?.trim() !== "Independent Expenditure" ||
          !["For", "Against"].includes(parsedRow["For /Against"]?.trim() ?? "") ||
          !parsedRow["Spender Reg Num"]?.trim() || !parsedRow.Spender?.trim()) {
          throw nativeFailure("ie_fields");
        }
      }
      if (!input.predicate || input.predicate(parsedRow)) {
        rows.push(parsedRow);
        if (maxRows !== undefined && rows.length >= maxRows) {
          resolveOnce();
          source.destroy();
        }
      }
    };

    const processText = (text: string, isFinal = false): void => {
      let index = 0;
      if (pendingQuoteInQuotedField) {
        pendingQuoteInQuotedField = false;
        const escapedField = consumeBackslashEscapedQuote(field, text[0]);
        if (escapedField !== null) {
          field = escapedField;
        } else if (text[0] === '"') {
          field += '"';
          index = 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      }

      for (; index < text.length && !settled; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inQuotes) {
          const escapedField = char === '"' ? consumeBackslashEscapedQuote(field, next) : null;
          if (escapedField !== null) {
            field = escapedField;
          } else if (char === '"' && next === '"') {
            field += '"';
            index += 1;
          } else if (char === '"' && next === undefined && !isFinal) {
            pendingQuoteInQuotedField = true;
          } else if (char === '"') {
            inQuotes = false;
            quoteClosed = true;
          } else {
            field += char;
          }
          continue;
        }

        if (input.native && quoteClosed && char !== "," && char !== "\n" && char !== "\r") {
          throw nativeFailure("csv_quote");
        }
        if (char === '"') {
          if (input.native && field.length > 0) throw nativeFailure("csv_quote");
          inQuotes = true;
          continue;
        }

        if (char === ",") {
          row.push(field);
          field = "";
          quoteClosed = false;
          continue;
        }

        if (char === "\n") {
          finishRow();
          continue;
        }

        if (char === "\r") {
          continue;
        }

        field += char;
      }
    };

    source.on("data", (chunk: string | Buffer) => {
      if (settled) {
        return;
      }
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.length;
        hash.update(buffer);
        if (input.native && byteCount > input.native.expectedBytes) throw nativeFailure("byte_count");
        processText(decoder ? decoder.decode(buffer, { stream: true }) : looseDecoder.write(buffer));
      } catch (error) {
        rejectOnce(error as Error);
        source.destroy(error as Error);
      }
    });

    source.on("end", () => {
      if (settled) {
        return;
      }
      try {
        processText(decoder ? decoder.decode() : looseDecoder.end(), true);
        if (inQuotes || pendingQuoteInQuotedField) {
          rejectOnce(new Error("Minnesota campaign finance CSV has an unterminated quoted field"));
          return;
        }
        if (field.length > 0 || row.length > 0) {
          finishRow();
        }
        if (input.native) {
          if (!headers || rowCount === 0) throw nativeFailure("empty_bulk");
          if (byteCount !== input.native.expectedBytes) throw nativeFailure("byte_count");
          if (hash.copy().digest("hex") !== input.native.expectedSha256) throw nativeFailure("sha256");
        }
        resolveOnce();
      } catch (error) {
        rejectOnce(error as Error);
      }
    });

    source.on("error", (error: Error) => rejectOnce(error));
  });
}

export function parseMinnesotaCampaignFinanceContributionCsvRows(csv: string): MinnesotaCampaignFinanceCsvRow[] {
  return parseRowsForCsv(csv);
}

export function parseMinnesotaCampaignFinanceIndependentExpenditureCsvRows(csv: string): MinnesotaCampaignFinanceCsvRow[] {
  return parseRowsForCsv(csv);
}

export function parseMinnesotaCampaignFinanceIndependentExpenditureContributionCsvRows(
  csv: string
): MinnesotaCampaignFinanceCsvRow[] {
  return parseRowsForCsv(csv);
}

export async function readMinnesotaCampaignFinanceContributionRows(input: {
  filePath: string;
  predicate?: MinnesotaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<MinnesotaCampaignFinanceCsvRow[]> {
  return (await readMinnesotaCampaignFinanceCsvRowsFromFile(input)).rows;
}

export async function readMinnesotaCampaignFinanceIndependentExpenditureRows(input: {
  filePath: string;
  predicate?: MinnesotaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<MinnesotaCampaignFinanceCsvRow[]> {
  return (await readMinnesotaCampaignFinanceCsvRowsFromFile(input)).rows;
}

export async function readMinnesotaCampaignFinanceIndependentExpenditureContributionRows(input: {
  filePath: string;
  predicate?: MinnesotaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<MinnesotaCampaignFinanceCsvRow[]> {
  return (await readMinnesotaCampaignFinanceCsvRowsFromFile(input)).rows;
}

/** Verify the complete original before returning even a filtered subset. */
export async function readMinnesotaCampaignFinanceNativeRows(input: {
  filePath: string;
  key: MinnesotaCampaignFinanceDownloadKey;
  expectedSha256: string;
  expectedBytes: number;
  predicate?: MinnesotaCampaignFinanceCsvRowPredicate;
}): Promise<{ rows: MinnesotaCampaignFinanceCsvRow[]; sourceFacts: MinnesotaCampaignFinanceSourceFacts }> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
    !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0 ||
    !["contributions_received", "independent_expenditures", "independent_expenditure_contributions"].includes(input.key)) {
    throw nativeFailure("metadata");
  }
  try {
    return await readMinnesotaCampaignFinanceCsvRowsFromFile({
      filePath: input.filePath, predicate: input.predicate, native: input,
    });
  } catch (error) {
    // Never expose a source row, path, identity or malformed header in logs.
    if (error instanceof Error && /^Minnesota campaign finance source invalid: (schema|row_width|byte_count|empty_bulk|sha256|csv_quote|ie_fields)$/.test(error.message)) {
      throw error;
    }
    throw nativeFailure("encoding_or_csv_or_read");
  }
}

export {
  MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME,
  MINNESOTA_CAMPAIGN_FINANCE_IE_CONTRIBUTORS_CSV_FILE_NAME,
  MINNESOTA_CAMPAIGN_FINANCE_INDEPENDENT_EXPENDITURES_CSV_FILE_NAME,
} from "./minnesotaCampaignFinanceArtifactCache.js";
