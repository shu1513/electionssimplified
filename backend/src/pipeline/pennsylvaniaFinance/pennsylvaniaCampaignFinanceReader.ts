import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { normalizePennsylvaniaCampaignFinanceExportYear } from "./pennsylvaniaCampaignFinanceArtifactCache.js";

export const PENNSYLVANIA_CAMPAIGN_FINANCE_TABLES = [
  "contrib",
  "debt",
  "expense",
  "filer",
  "receipt",
] as const;

export type PennsylvaniaCampaignFinanceTable = (typeof PENNSYLVANIA_CAMPAIGN_FINANCE_TABLES)[number];

export const PENNSYLVANIA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS = [
  "CampaignFinanceID",
  "FilerID",
  "EYEAR",
  "SubmittedDate",
  "CYCLE",
  "Section",
  "CONTRIBUTOR",
  "ADDRESS1",
  "ADDRESS2",
  "CITY",
  "STATE",
  "ZIPCODE",
  "OCCUPATION",
  "ENAME",
  "EADDRESS1",
  "EADDRESS2",
  "ECITY",
  "ESTATE",
  "EZIPCODE",
  "CONTDATE1",
  "CONTAMT1",
  "CONTDATE2",
  "CONTAMT2",
  "CONTDATE3",
  "CONTAMT3",
  "CONTDESC",
] as const;

export const PENNSYLVANIA_CAMPAIGN_FINANCE_DEBT_COLUMNS = [
  "CampaignFinanceID",
  "FILERID",
  "EYEAR",
  "SubmittedDate",
  "CYCLE",
  "DBTNAME",
  "ADDRESS1",
  "ADDRESS2",
  "CITY",
  "STATE",
  "ZIPCODE",
  "DBTDATE",
  "DBTAMT",
  "DBTDESC",
] as const;

export const PENNSYLVANIA_CAMPAIGN_FINANCE_EXPENSE_COLUMNS = [
  "CampaignFinanceID",
  "FILERID",
  "EYEAR",
  "SubmittedDate",
  "CYCLE",
  "EXPNAME",
  "ADDRESS1",
  "ADDRESS2",
  "CITY",
  "STATE",
  "ZIPCODE",
  "EXPDATE",
  "EXPAMT",
  "EXPDESC",
] as const;

export const PENNSYLVANIA_CAMPAIGN_FINANCE_FILER_COLUMNS = [
  "CampaignfinanceID",
  "FILERID",
  "EYEAR",
  "SubmittedDate",
  "CYCLE",
  "AMMEND",
  "TERMINATE",
  "FILERTYPE",
  "FILERNAME",
  "OFFICE",
  "DISTRICT",
  "PARTY",
  "ADDRESS1",
  "ADDRESS2",
  "CITY",
  "STATE",
  "ZIPCODE",
  "COUNTY",
  "PHONE",
  "BEGINNING",
  "MONETARY",
  "INKIND",
] as const;

export const PENNSYLVANIA_CAMPAIGN_FINANCE_RECEIPT_COLUMNS = [
  "CampaignFinanceID",
  "FILERID",
  "EYEAR",
  "SubmittedDate",
  "CYCLE",
  "RECNAME",
  "ADDRESS1",
  "ADDRESS2",
  "CITY",
  "STATE",
  "ZIPCODE",
  "RECDESC",
  "RECDATE",
  "RECAMT",
] as const;

export type PennsylvaniaCampaignFinanceCsvRow = Record<string, string>;
export type PennsylvaniaCampaignFinanceCsvRowPredicate = (row: PennsylvaniaCampaignFinanceCsvRow) => boolean;
export type PennsylvaniaCampaignFinanceContributionRow = Record<
  (typeof PENNSYLVANIA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS)[number],
  string
>;
export type PennsylvaniaCampaignFinanceDebtRow = Record<
  (typeof PENNSYLVANIA_CAMPAIGN_FINANCE_DEBT_COLUMNS)[number],
  string
>;
export type PennsylvaniaCampaignFinanceExpenseRow = Record<
  (typeof PENNSYLVANIA_CAMPAIGN_FINANCE_EXPENSE_COLUMNS)[number],
  string
>;
export type PennsylvaniaCampaignFinanceFilerRow = Record<
  (typeof PENNSYLVANIA_CAMPAIGN_FINANCE_FILER_COLUMNS)[number],
  string
>;
export type PennsylvaniaCampaignFinanceReceiptRow = Record<
  (typeof PENNSYLVANIA_CAMPAIGN_FINANCE_RECEIPT_COLUMNS)[number],
  string
>;

const REQUIRED_COLUMNS_BY_TABLE: Record<PennsylvaniaCampaignFinanceTable, readonly string[]> = {
  contrib: PENNSYLVANIA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,
  debt: PENNSYLVANIA_CAMPAIGN_FINANCE_DEBT_COLUMNS,
  expense: PENNSYLVANIA_CAMPAIGN_FINANCE_EXPENSE_COLUMNS,
  filer: PENNSYLVANIA_CAMPAIGN_FINANCE_FILER_COLUMNS,
  receipt: PENNSYLVANIA_CAMPAIGN_FINANCE_RECEIPT_COLUMNS,
};

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Pennsylvania campaign finance ${fieldName}: ${value}`);
  }
  return value;
}

export function normalizePennsylvaniaCampaignFinanceCsvHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function buildHeader(cells: readonly string[]): string[] {
  const normalizedCells = cells.map(normalizePennsylvaniaCampaignFinanceCsvHeader);
  if (!normalizedCells.some(Boolean)) {
    throw new Error("Pennsylvania campaign finance CSV header row is empty");
  }
  const header = normalizedCells.map((name, index) => name || `_column_${index + 1}`);
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) {
      throw new Error(`Duplicate Pennsylvania campaign finance CSV header: ${name}`);
    }
    seen.add(name);
  }
  return header;
}

function requireColumns(headers: readonly string[], requiredColumns: readonly string[] | undefined, tableLabel: string): void {
  if (!requiredColumns) {
    return;
  }
  const headerSet = new Set(headers);
  const missing = requiredColumns.filter((column) => !headerSet.has(column));
  if (missing.length > 0) {
    throw new Error(`Missing required Pennsylvania campaign finance ${tableLabel} CSV column: ${missing[0]}`);
  }
}

function rowObjectFromCells(headers: readonly string[], cells: readonly string[]): PennsylvaniaCampaignFinanceCsvRow {
  const row: PennsylvaniaCampaignFinanceCsvRow = {};
  for (let index = 0; index < headers.length; index += 1) {
    const name = headers[index];
    row[name] = cells[index]?.trim() ?? "";
  }
  return row;
}

// PA does not escape quotes inside quoted fields ("Grace d"Alo",
// "MARINUCCI"S DELI", "CAROLYN SUSIE" STEWART"). A quote ends the field only
// when nothing but spaces separates it from a comma, a line end, or the end
// of the text; any other quote is content. Reading every quote as the end
// of the field put the parser out of phase and failed the whole yearly load.
function quoteEndsQuotedField(text: string, quoteIndex: number): boolean {
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === " " || char === "\t") {
      continue;
    }
    return char === "," || char === "\r" || char === "\n";
  }
  return true;
}

export function parsePennsylvaniaCampaignFinanceCsvRows(input: {
  csv: string;
  requiredColumns?: readonly string[];
  tableLabel?: string;
}): PennsylvaniaCampaignFinanceCsvRow[] {
  const parsedRows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.csv.length; index += 1) {
    const char = input.csv[index];
    const next = input.csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"' && quoteEndsQuotedField(input.csv, index)) {
        inQuotes = false;
      } else if (char === '"') {
        field += '"';
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
      row.push(field);
      parsedRows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    throw new Error("Pennsylvania campaign finance CSV has an unterminated quoted field");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    parsedRows.push(row);
  }

  const nonEmptyRows = parsedRows.filter((cells) => cells.some((value) => value.trim().length > 0));
  const headerCells = nonEmptyRows[0];
  if (!headerCells) {
    return [];
  }
  const headers = buildHeader(headerCells);
  requireColumns(headers, input.requiredColumns, input.tableLabel ?? "table");
  return nonEmptyRows.slice(1).map((cells) => rowObjectFromCells(headers, cells));
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const child of await listFilesRecursive(path)) {
        files.push(child);
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export async function listPennsylvaniaCampaignFinanceExtractedFileNames(extractedDir: string): Promise<string[]> {
  const root = await stat(extractedDir);
  if (!root.isDirectory()) {
    throw new Error(`Pennsylvania campaign finance extracted path is not a directory: ${extractedDir}`);
  }
  return (await listFilesRecursive(extractedDir))
    .map((filePath) => relative(extractedDir, filePath))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export function pennsylvaniaCampaignFinanceTableFileName(input: {
  table: PennsylvaniaCampaignFinanceTable;
  year: number;
}): string {
  const year = normalizePennsylvaniaCampaignFinanceExportYear(input.year);
  if (!PENNSYLVANIA_CAMPAIGN_FINANCE_TABLES.includes(input.table)) {
    throw new Error(`Invalid Pennsylvania campaign finance table: ${input.table}`);
  }
  return `${input.table}_${year}.txt`;
}

export async function findPennsylvaniaCampaignFinanceTableFile(input: {
  extractedDir: string;
  table: PennsylvaniaCampaignFinanceTable;
  year: number;
}): Promise<string> {
  const fileName = pennsylvaniaCampaignFinanceTableFileName({ table: input.table, year: input.year });
  const files = await listPennsylvaniaCampaignFinanceExtractedFileNames(input.extractedDir);
  const normalizedFileName = fileName.toLowerCase();
  const matches = files.filter((name) => name.split(/[\\/]/).at(-1)?.toLowerCase() === normalizedFileName);
  if (matches.length === 0) {
    throw new Error(`Missing Pennsylvania campaign finance ${input.table} export file for ${input.year}: ${fileName}`);
  }
  if (matches.length > 1) {
    const directMatch = matches.find((name) => !name.includes("/") && !name.includes("\\"));
    if (directMatch) {
      return join(input.extractedDir, directMatch);
    }
    throw new Error(
      `Multiple Pennsylvania campaign finance ${input.table} export files found for ${input.year}: ${matches.join(", ")}`
    );
  }
  return join(input.extractedDir, matches[0]);
}

async function assertReadableFile(path: string, tableLabel: string): Promise<void> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`Pennsylvania campaign finance ${tableLabel} CSV path is not a file: ${path}`);
  }
}

async function streamPennsylvaniaCampaignFinanceCsvRows(input: {
  filePath: string;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
  requiredColumns?: readonly string[];
  tableLabel: string;
}): Promise<PennsylvaniaCampaignFinanceCsvRow[]> {
  const maxRows = normalizePositiveInteger(input.maxRows, "maxRows");
  await assertReadableFile(input.filePath, input.tableLabel);
  const source = createReadStream(input.filePath);
  const decoder = new StringDecoder("latin1");

  return await new Promise((resolvePromise, reject) => {
    const rows: PennsylvaniaCampaignFinanceCsvRow[] = [];
    let headers: string[] | null = null;
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let pendingQuoteInQuotedField = false;
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
      resolvePromise(rows);
    };

    const consumeCompletedRow = (cells: string[]): void => {
      if (!cells.some((value) => value.trim().length > 0)) {
        return;
      }
      if (!headers) {
        headers = buildHeader(cells);
        requireColumns(headers, input.requiredColumns, input.tableLabel);
        return;
      }
      if (maxRows !== undefined && rows.length >= maxRows) {
        return;
      }

      const parsedRow = rowObjectFromCells(headers, cells);
      if (!input.predicate || input.predicate(parsedRow)) {
        rows.push(parsedRow);
        if (maxRows !== undefined && rows.length >= maxRows) {
          source.destroy();
          resolveOnce();
        }
      }
    };

    const finishCurrentRow = (): void => {
      row.push(field);
      consumeCompletedRow(row);
      row = [];
      field = "";
    };

    const processText = (text: string, isFinal = false): void => {
      let index = 0;
      if (pendingQuoteInQuotedField) {
        pendingQuoteInQuotedField = false;
        if (text[0] === '"') {
          field += '"';
          index = 1;
        } else if (quoteEndsQuotedField(text, -1)) {
          inQuotes = false;
        } else {
          field += '"';
        }
      }

      for (; index < text.length && !settled; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inQuotes) {
          if (char === '"' && next === '"') {
            field += '"';
            index += 1;
          } else if (char === '"' && next === undefined && !isFinal) {
            pendingQuoteInQuotedField = true;
          } else if (char === '"' && quoteEndsQuotedField(text, index)) {
            inQuotes = false;
          } else if (char === '"') {
            field += '"';
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
          finishCurrentRow();
          continue;
        }
        if (char === "\r") {
          continue;
        }
        field += char;
      }

      if (isFinal && pendingQuoteInQuotedField) {
        pendingQuoteInQuotedField = false;
        inQuotes = false;
      }
    };

    source.on("data", (chunk: string | Buffer) => {
      try {
        processText(decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      } catch (error) {
        source.destroy();
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
    source.on("error", (error) => rejectOnce(error));
    source.on("close", () => {
      if (settled) {
        return;
      }
      try {
        const remaining = decoder.end();
        if (remaining) {
          processText(remaining, true);
        } else {
          processText("", true);
        }
        if (inQuotes) {
          rejectOnce(new Error("Pennsylvania campaign finance CSV has an unterminated quoted field"));
          return;
        }
        if (field.length > 0 || row.length > 0) {
          finishCurrentRow();
        }
        resolveOnce();
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function readPennsylvaniaCampaignFinanceTableRows(input: {
  extractedDir: string;
  table: PennsylvaniaCampaignFinanceTable;
  year: number;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
  requiredColumns?: readonly string[];
}): Promise<PennsylvaniaCampaignFinanceCsvRow[]> {
  const year = normalizePennsylvaniaCampaignFinanceExportYear(input.year);
  const filePath = await findPennsylvaniaCampaignFinanceTableFile({
    extractedDir: input.extractedDir,
    table: input.table,
    year,
  });
  return await streamPennsylvaniaCampaignFinanceCsvRows({
    filePath,
    predicate: input.predicate,
    maxRows: input.maxRows,
    requiredColumns: input.requiredColumns ?? REQUIRED_COLUMNS_BY_TABLE[input.table],
    tableLabel: input.table,
  });
}

export async function readPennsylvaniaCampaignFinanceContributionRows(input: {
  extractedDir: string;
  year: number;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<PennsylvaniaCampaignFinanceContributionRow[]> {
  return (await readPennsylvaniaCampaignFinanceTableRows({
    ...input,
    table: "contrib",
  })) as PennsylvaniaCampaignFinanceContributionRow[];
}

export async function readPennsylvaniaCampaignFinanceDebtRows(input: {
  extractedDir: string;
  year: number;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<PennsylvaniaCampaignFinanceDebtRow[]> {
  return (await readPennsylvaniaCampaignFinanceTableRows({
    ...input,
    table: "debt",
  })) as PennsylvaniaCampaignFinanceDebtRow[];
}

export async function readPennsylvaniaCampaignFinanceExpenseRows(input: {
  extractedDir: string;
  year: number;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<PennsylvaniaCampaignFinanceExpenseRow[]> {
  return (await readPennsylvaniaCampaignFinanceTableRows({
    ...input,
    table: "expense",
  })) as PennsylvaniaCampaignFinanceExpenseRow[];
}

export async function readPennsylvaniaCampaignFinanceFilerRows(input: {
  extractedDir: string;
  year: number;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<PennsylvaniaCampaignFinanceFilerRow[]> {
  return (await readPennsylvaniaCampaignFinanceTableRows({
    ...input,
    table: "filer",
  })) as PennsylvaniaCampaignFinanceFilerRow[];
}

export async function readPennsylvaniaCampaignFinanceReceiptRows(input: {
  extractedDir: string;
  year: number;
  predicate?: PennsylvaniaCampaignFinanceCsvRowPredicate;
  maxRows?: number;
}): Promise<PennsylvaniaCampaignFinanceReceiptRow[]> {
  return (await readPennsylvaniaCampaignFinanceTableRows({
    ...input,
    table: "receipt",
  })) as PennsylvaniaCampaignFinanceReceiptRow[];
}
