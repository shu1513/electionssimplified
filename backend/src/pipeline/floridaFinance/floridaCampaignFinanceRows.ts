export type FloridaContributionRow = {
  recipientName: string;
  contributionDate: string;
  amount: string;
  transactionType: string;
  contributorName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  // Public DOS exports combine these fields. Preserve the reported location
  // without inventing a city/state/ZIP split, including non-US locations.
  cityStateZip?: string;
  occupation: string;
  inKindDescription: string;
  electionCode?: string;
  sourceUrl?: string | null;
};

export type FloridaContributionTsvParseOptions = {
  electionCode?: string;
  sourceUrl?: string | null;
};

export type FloridaContributionFieldKey =
  | "recipientName"
  | "contributionDate"
  | "amount"
  | "transactionType"
  | "contributorName"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "cityStateZip"
  | "occupation"
  | "inKindDescription";

export type FloridaContributionFixedWidthField = {
  key: FloridaContributionFieldKey;
  start: number;
  end: number;
};

export type FloridaContributionFixedWidthParseOptions = FloridaContributionTsvParseOptions & {
  fields: readonly FloridaContributionFixedWidthField[];
  headerLines?: number;
};

const HEADER_ALIASES = new Map<string, FloridaContributionFieldKey>([
  ["CANDIDATE COMMITTEE", "recipientName"],
  ["CANDIDATE/COMMITTEE", "recipientName"],
  ["CANDIDATE", "recipientName"],
  ["COMMITTEE", "recipientName"],
  ["DATE", "contributionDate"],
  ["CONTRIBUTION DATE", "contributionDate"],
  ["AMOUNT", "amount"],
  ["CONTRIBUTION AMOUNT", "amount"],
  ["TYP", "transactionType"],
  ["TYPE", "transactionType"],
  ["CONTRIBUTION TYPE", "transactionType"],
  ["CONTRIBUTOR NAME", "contributorName"],
  ["CONTRIBUTOR", "contributorName"],
  ["NAME", "contributorName"],
  ["ADDRESS", "address"],
  ["CITY", "city"],
  ["STATE", "state"],
  ["ZIP", "zip"],
  ["ZIPCODE", "zip"],
  ["ZIP CODE", "zip"],
  ["CITY STATE ZIP", "cityStateZip"],
  ["CITYSTATEZIP", "cityStateZip"],
  ["OCCUPATION", "occupation"],
  ["INKIND DESC", "inKindDescription"],
  ["IN KIND DESC", "inKindDescription"],
  ["INKIND DESCRIPTION", "inKindDescription"],
  ["IN KIND DESCRIPTION", "inKindDescription"],
]);

export function normalizeFloridaTextKey(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeFloridaDisplayText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function parseFloridaAmountCents(raw: string): number | null {
  const normalized = raw.replace(/[$,]/g, "").trim();
  if (!normalized || !/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) {
    return null;
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToFloridaDollars(cents: number): number {
  return cents / 100;
}

export function parseFloridaDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  const compactMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compactMatch) {
    return Number(compactMatch[1]);
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  return null;
}

export function floridaElectionCycleStartYear(electionYear: number): number {
  if (!Number.isInteger(electionYear) || electionYear < 1996 || electionYear > 2100) {
    throw new Error(`Invalid Florida election year: ${electionYear}`);
  }
  return electionYear - 1;
}

function normalizeHeader(value: string): string {
  return normalizeFloridaTextKey(value.replace(/\//g, " / "));
}

function splitTsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "\t" && !inQuotes) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  fields.push(current.trim());
  return fields;
}

function mapHeaders(headerLine: string): Map<FloridaContributionFieldKey, number> {
  const headers = splitTsvLine(headerLine);
  const result = new Map<FloridaContributionFieldKey, number>();
  for (const [index, header] of headers.entries()) {
    const key = HEADER_ALIASES.get(normalizeHeader(header));
    if (key && !result.has(key)) {
      result.set(key, index);
    }
  }
  return result;
}

function readField(
  fields: readonly string[],
  headerIndexes: Map<FloridaContributionFieldKey, number>,
  key: FloridaContributionFieldKey
): string {
  const index = headerIndexes.get(key);
  return index === undefined ? "" : normalizeFloridaDisplayText(fields[index]);
}

function validateContributionFields(fields: ReadonlySet<FloridaContributionFieldKey>, formatName: string): void {
  if (
    !fields.has("recipientName") ||
    !fields.has("contributionDate") ||
    !fields.has("amount") ||
    !fields.has("contributorName")
  ) {
    throw new Error(`Florida contribution ${formatName} is missing required fields`);
  }
}

export function parseFloridaContributionTsv(
  tsv: string,
  options: FloridaContributionTsvParseOptions = {}
): FloridaContributionRow[] {
  const lines = tsv
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }

  const headerIndexes = mapHeaders(lines[0]);
  try {
    validateContributionFields(new Set(headerIndexes.keys()), "TSV");
  } catch {
    throw new Error("Florida contribution TSV is missing required headers");
  }

  const rows: FloridaContributionRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = splitTsvLine(line);
    rows.push({
      recipientName: readField(fields, headerIndexes, "recipientName"),
      contributionDate: readField(fields, headerIndexes, "contributionDate"),
      amount: readField(fields, headerIndexes, "amount"),
      transactionType: readField(fields, headerIndexes, "transactionType"),
      contributorName: readField(fields, headerIndexes, "contributorName"),
      address: readField(fields, headerIndexes, "address"),
      city: readField(fields, headerIndexes, "city"),
      state: readField(fields, headerIndexes, "state"),
      zip: readField(fields, headerIndexes, "zip"),
      ...(headerIndexes.has("cityStateZip")
        ? { cityStateZip: readField(fields, headerIndexes, "cityStateZip") }
        : {}),
      occupation: readField(fields, headerIndexes, "occupation"),
      inKindDescription: readField(fields, headerIndexes, "inKindDescription"),
      electionCode: options.electionCode,
      sourceUrl: options.sourceUrl ?? null,
    });
  }

  return rows;
}

function validateFixedWidthFields(fields: readonly FloridaContributionFixedWidthField[]): void {
  const keys = new Set<FloridaContributionFieldKey>();
  for (const field of fields) {
    if (
      !Number.isInteger(field.start) ||
      !Number.isInteger(field.end) ||
      field.start < 0 ||
      field.end <= field.start
    ) {
      throw new Error(`Invalid Florida contribution fixed-width field range for ${field.key}`);
    }
    keys.add(field.key);
  }
  validateContributionFields(keys, "fixed-width export");
}

function fixedWidthFieldValue(
  line: string,
  fields: readonly FloridaContributionFixedWidthField[],
  key: FloridaContributionFieldKey
): string {
  const field = fields.find((candidate) => candidate.key === key);
  return field ? normalizeFloridaDisplayText(line.slice(field.start, field.end)) : "";
}

export function parseFloridaContributionFixedWidth(
  text: string,
  options: FloridaContributionFixedWidthParseOptions
): FloridaContributionRow[] {
  validateFixedWidthFields(options.fields);
  const headerLines = options.headerLines ?? 0;
  if (!Number.isInteger(headerLines) || headerLines < 0) {
    throw new Error(`Invalid Florida contribution fixed-width headerLines: ${headerLines}`);
  }

  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(headerLines)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      recipientName: fixedWidthFieldValue(line, options.fields, "recipientName"),
      contributionDate: fixedWidthFieldValue(line, options.fields, "contributionDate"),
      amount: fixedWidthFieldValue(line, options.fields, "amount"),
      transactionType: fixedWidthFieldValue(line, options.fields, "transactionType"),
      contributorName: fixedWidthFieldValue(line, options.fields, "contributorName"),
      address: fixedWidthFieldValue(line, options.fields, "address"),
      city: fixedWidthFieldValue(line, options.fields, "city"),
      state: fixedWidthFieldValue(line, options.fields, "state"),
      zip: fixedWidthFieldValue(line, options.fields, "zip"),
      ...(options.fields.some((field) => field.key === "cityStateZip")
        ? { cityStateZip: fixedWidthFieldValue(line, options.fields, "cityStateZip") }
        : {}),
      occupation: fixedWidthFieldValue(line, options.fields, "occupation"),
      inKindDescription: fixedWidthFieldValue(line, options.fields, "inKindDescription"),
      electionCode: options.electionCode,
      sourceUrl: options.sourceUrl ?? null,
    }));
}
