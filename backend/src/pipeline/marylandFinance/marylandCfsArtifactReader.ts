import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const MARYLAND_CFS_CONTRIBUTION_COLUMNS = [
  "Filing Entity Id",
  "Committee Name",
  "Abbreviated Committee Name",
  "Committee Type",
  "Contributor Type",
  "Contributor Company Name",
  "Contributor Last Name",
  "Contributor First Name",
  "Contributor Middle Name",
  "Contributor Mailing Address1",
  "Contributor Mailing Address2",
  "Contributor City",
  "Contributor State",
  "Contributor ZipCode",
  "Contributor County Of Residence",
  "Transaction Type",
  "Transaction Date",
  "Transaction Amount",
  "Payment Type",
  "Fund Type",
  "Number Of People Purchasing Or Making Contributions",
  "Price Per Person Or Average Contribution",
  "Coordinated In-Kind",
  "Public Funding Requested",
  "Amount Eligible For Public Funding",
  "Description",
  "Report Name",
  "Aggregate As Of Download Date",
] as const;

export const MARYLAND_CFS_EXPENDITURE_COLUMNS = [
  "Filing Entity Id",
  "Committee Name",
  "Abbreviated Committee Name",
  "Committee Type",
  "Payee Type",
  "Payee Company Name",
  "Payee Last Name",
  "Payee First Name",
  "Payee Middle Name",
  "Payee Country",
  "Payee Mailing Address1",
  "Payee Mailing Address2",
  "Payee City",
  "Payee State",
  "Payee Zip Code",
  "Vendor Type",
  "Vendor Name",
  "Vendor Country",
  "Vendor Mailing Address1",
  "Vendor Mailing Address2",
  "Vendor City",
  "Vendor State",
  "Vendor Zip Code",
  "Transaction Type",
  "Transaction Date",
  "Transaction Amount",
  "Category",
  "Purpose",
  "Fund Type",
  "Description",
  "Pay In-Kind Contribution",
  "Committee Filing Entity ID",
  "Report Name",
  "Candidate/Ballot Issue",
  "Office Sought",
  "Position",
  "Amount Applied",
] as const;

export const MARYLAND_CFS_COMMITTEE_COLUMNS = [
  "Filing Entity Id",
  "Committee Name",
  "Abbreviated Committee Name",
  "Committee Type",
  "Election",
  "Treasurer/Authorized Agent Name",
  "Treasurer/Authorized Agent Public Address1",
  "Treasurer/Authorized Agent Address2",
  "Treasurer/Authorized Agent City",
  "Treasurer/Authorized Agent State",
  "Treasurer/Authorized Agent Zip Code",
  "Chairperson/Principal Officer Name",
  "Chairperson/Principal Officer Public Address1",
  "Chairperson/Principal Officer Address2",
  "Chairperson/Principal Officer City",
  "Chairperson/Principal Officer State",
  "Chairperson/Principal Officer Zip Code",
  "Committee Mailing Address1",
  "Committee Mailing Address2",
  "Committee City",
  "Committee State",
  "Committee ZipCode",
  "Committee Phone",
  "Committee Email",
  "Registration Submission Date",
  "Registration Approval Date",
  "Registration Dissolved Date",
  "Candidate LastName",
  "Candidate First Name",
  "Candidate Middle Name",
  "Candidate Suffix",
  "Candidate DOB",
  "Candidate Public Address1",
  "Candidate Address2",
  "Candidate City",
  "Candidate State",
  "Candidate Zip Code",
  "Candidate Email",
  "Candidate Public Phone",
  "Entity Type",
  "Entity Name",
  "Notifying Of Disbursements Made",
  "Notification Website",
  "Jurisdiction",
  "Office Sought",
  "Party Affiliation",
  "State The Committee IsLocated",
  "Supporting Organization",
  "Purpose Of The Committee",
  "Purpose Description",
  "Affiliated CommitteeName",
  "Location",
  "Ballot Issue",
  "Official Ballot Name",
  "Petition Sponsor",
  "Position",
  "Election Year",
  "Website",
  "Facebook",
  "Instagram",
  "X (Twitter)",
  "LinkedIn",
] as const;

export type MarylandCfsContributionColumn = (typeof MARYLAND_CFS_CONTRIBUTION_COLUMNS)[number];
export type MarylandCfsExpenditureColumn = (typeof MARYLAND_CFS_EXPENDITURE_COLUMNS)[number];
export type MarylandCfsCommitteeColumn = (typeof MARYLAND_CFS_COMMITTEE_COLUMNS)[number];

export type MarylandCfsContributionRow = Record<MarylandCfsContributionColumn, string>;
export type MarylandCfsExpenditureRow = Record<MarylandCfsExpenditureColumn, string>;
export type MarylandCfsCommitteeRow = Record<MarylandCfsCommitteeColumn, string>;

export type MarylandCfsContributionRowPredicate = (row: MarylandCfsContributionRow) => boolean;
export type MarylandCfsExpenditureRowPredicate = (row: MarylandCfsExpenditureRow) => boolean;
export type MarylandCfsCommitteeRowPredicate = (row: MarylandCfsCommitteeRow) => boolean;

type MarylandCfsRowForColumns<TColumns extends readonly string[]> = Record<TColumns[number], string>;

export function normalizeMarylandCfsHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

export function parseMarylandCfsMoney(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const isParenthesized = normalized.startsWith("(") && normalized.endsWith(")");
  const withoutAdornment = normalized.replace(/[$,()\s]/g, "");
  if (!withoutAdornment) {
    return null;
  }
  const parsed = Number(withoutAdornment);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return isParenthesized ? -parsed : parsed;
}

export function normalizeMarylandCfsExcelString(value: string): string {
  const trimmed = value.trim();
  const match = /^="(.*)"$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Maryland CFS ${fieldName}: ${value}`);
  }
  return value;
}

function cell(cells: readonly string[], index: number): string {
  return cells[index]?.trim() ?? "";
}

function isMarylandCfsDownloadMetadataRow(cells: readonly string[]): boolean {
  const firstCell = normalizeMarylandCfsHeader(cells[0] ?? "");
  const onlyFirstCellHasContent = cells.slice(1).every((cell) => cell.trim().length === 0);
  return (
    onlyFirstCellHasContent &&
    (firstCell.startsWith("Contributions and Loan Download as of ") ||
      firstCell.startsWith("Expenditure Download as of ") ||
      firstCell.startsWith("Committee Download as of "))
  );
}

function buildHeader(cells: readonly string[]): string[] {
  const header = cells.map(normalizeMarylandCfsHeader);
  const seen = new Set<string>();
  for (const name of header) {
    if (!name) {
      continue;
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate Maryland CFS CSV header: ${name}`);
    }
    seen.add(name);
  }
  if (seen.size === 0) {
    throw new Error("Maryland CFS CSV header row is empty");
  }
  return header;
}

function buildHeaderIndex(header: readonly string[]): Map<string, number> {
  return new Map(header.map((name, index) => [normalizeMarylandCfsHeader(name), index]));
}

function requireColumn(headerIndex: ReadonlyMap<string, number>, column: string, label: string): number {
  const index = headerIndex.get(column);
  if (index === undefined) {
    throw new Error(`Missing required Maryland CFS ${label} CSV column: ${column}`);
  }
  return index;
}

function indexesForColumns<TColumns extends readonly string[]>(
  header: readonly string[],
  columns: TColumns,
  label: string
): Record<TColumns[number], number> {
  const headerIndex = buildHeaderIndex(header);
  return Object.fromEntries(columns.map((column) => [column, requireColumn(headerIndex, column, label)])) as Record<
    TColumns[number],
    number
  >;
}

function rowObjectFromCells<TColumns extends readonly string[]>(
  cells: readonly string[],
  columns: TColumns,
  indexes: Record<TColumns[number], number>
): MarylandCfsRowForColumns<TColumns> {
  const entries = (columns as readonly TColumns[number][]).map((column) => [
    column,
    cell(cells, indexes[column]),
  ]);
  return Object.fromEntries(entries) as MarylandCfsRowForColumns<TColumns>;
}

// CFS does not escape quotes: a quote appears inside unquoted fields
// (O"Meara, McDonald"s) and inside quoted ones. A quote opens a quoted field
// only at the start of a field, and ends one only when nothing but spaces
// separates it from a comma, a line end, or the end of the text; any other
// quote is content. Reading every quote as a delimiter put the parser out of
// phase and failed the whole yearly load.
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

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"' && quoteEndsQuotedField(csv, index)) {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
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
      rows.push(row);
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
    throw new Error("Maryland CFS CSV has an unterminated quoted field");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
}

function parseRowsForColumns<TColumns extends readonly string[]>(input: {
  csv: string;
  columns: TColumns;
  label: string;
}): MarylandCfsRowForColumns<TColumns>[] {
  const rows = parseCsvRows(input.csv).filter((cells) => !isMarylandCfsDownloadMetadataRow(cells));
  const headerCells = rows[0];
  if (!headerCells) {
    throw new Error(`Missing Maryland CFS ${input.label} CSV header row`);
  }
  const indexes = indexesForColumns(buildHeader(headerCells), input.columns, input.label);
  return rows.slice(1).map((cells) => rowObjectFromCells(cells, input.columns, indexes));
}

export function parseMarylandCfsContributionCsvRows(csv: string): MarylandCfsContributionRow[] {
  return parseRowsForColumns({
    csv,
    columns: MARYLAND_CFS_CONTRIBUTION_COLUMNS,
    label: "contribution",
  });
}

export function parseMarylandCfsExpenditureCsvRows(csv: string): MarylandCfsExpenditureRow[] {
  return parseRowsForColumns({
    csv,
    columns: MARYLAND_CFS_EXPENDITURE_COLUMNS,
    label: "expenditure",
  });
}

export function parseMarylandCfsCommitteeCsvRows(csv: string): MarylandCfsCommitteeRow[] {
  return parseRowsForColumns({
    csv,
    columns: MARYLAND_CFS_COMMITTEE_COLUMNS,
    label: "committee",
  });
}

async function readMarylandCfsRows<TColumns extends readonly string[]>(input: {
  filePath: string;
  columns: TColumns;
  label: string;
  predicate?: (row: MarylandCfsRowForColumns<TColumns>) => boolean;
  maxRows?: number;
}): Promise<MarylandCfsRowForColumns<TColumns>[]> {
  const maxRows = normalizePositiveInteger(input.maxRows, "maxRows");
  const source = createReadStream(input.filePath);
  const decoder = new StringDecoder("utf8");

  return await new Promise((resolve, reject) => {
    const rows: MarylandCfsRowForColumns<TColumns>[] = [];
    let indexes: Record<TColumns[number], number> | null = null;
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    // A quote followed only by spaces at the end of a chunk cannot be judged
    // until the next chunk shows what follows; it is carried over verbatim.
    let carry = "";
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
      resolve(rows);
    };

    const consumeCompletedRow = (cells: string[]): void => {
      if (!cells.some((value) => value.trim().length > 0) || isMarylandCfsDownloadMetadataRow(cells)) {
        return;
      }
      if (!indexes) {
        indexes = indexesForColumns(buildHeader(cells), input.columns, input.label);
        return;
      }
      if (maxRows !== undefined && rows.length >= maxRows) {
        return;
      }

      const parsedRow = rowObjectFromCells(cells, input.columns, indexes);
      if (!input.predicate || input.predicate(parsedRow)) {
        rows.push(parsedRow);
        if (maxRows !== undefined && rows.length >= maxRows) {
          resolveOnce();
          source.destroy();
        }
      }
    };

    const finishCurrentRow = (): void => {
      row.push(field);
      consumeCompletedRow(row);
      row = [];
      field = "";
    };

    const processText = (chunk: string, isFinal = false): void => {
      const text = carry + chunk;
      carry = "";

      for (let index = 0; index < text.length && !settled; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inQuotes) {
          if (char === '"' && next === '"') {
            field += '"';
            index += 1;
          } else if (char === '"' && !isFinal && /^[ \t]*$/.test(text.slice(index + 1))) {
            carry = text.slice(index);
            break;
          } else if (char === '"' && quoteEndsQuotedField(text, index)) {
            inQuotes = false;
          } else {
            field += char;
          }
          continue;
        }

        if (char === '"' && field.length === 0) {
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
    };

    source.on("data", (chunk: string | Buffer) => {
      if (settled) {
        return;
      }
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        processText(decoder.write(buffer));
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
        processText(decoder.end(), true);
        if (inQuotes) {
          rejectOnce(new Error("Maryland CFS CSV has an unterminated quoted field"));
          return;
        }
        if (field.length > 0 || row.length > 0) {
          finishCurrentRow();
        }
        if (!indexes) {
          rejectOnce(new Error(`Missing Maryland CFS ${input.label} CSV header row`));
          return;
        }
        resolveOnce();
      } catch (error) {
        rejectOnce(error as Error);
      }
    });

    source.on("error", (error: Error) => rejectOnce(error));
  });
}

export async function readMarylandCfsContributionRows(input: {
  filePath: string;
  predicate?: MarylandCfsContributionRowPredicate;
  maxRows?: number;
}): Promise<MarylandCfsContributionRow[]> {
  return await readMarylandCfsRows({
    filePath: input.filePath,
    columns: MARYLAND_CFS_CONTRIBUTION_COLUMNS,
    label: "contribution",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readMarylandCfsExpenditureRows(input: {
  filePath: string;
  predicate?: MarylandCfsExpenditureRowPredicate;
  maxRows?: number;
}): Promise<MarylandCfsExpenditureRow[]> {
  return await readMarylandCfsRows({
    filePath: input.filePath,
    columns: MARYLAND_CFS_EXPENDITURE_COLUMNS,
    label: "expenditure",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readMarylandCfsCommitteeRows(input: {
  filePath: string;
  predicate?: MarylandCfsCommitteeRowPredicate;
  maxRows?: number;
}): Promise<MarylandCfsCommitteeRow[]> {
  return await readMarylandCfsRows({
    filePath: input.filePath,
    columns: MARYLAND_CFS_COMMITTEE_COLUMNS,
    label: "committee",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}
