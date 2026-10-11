// Tolerant parsing for the Alabama FCPA annual bulk extracts. Roughly 2.5% of
// expenditure-extract lines are malformed (unescaped quotes/newlines), so the
// parser quarantines defective records instead of aborting or guessing — and
// nothing downstream may aggregate quarantined rows (docs/plans/plan-alabama-finance.md,
// gotchas 8 and 13).

export const ALABAMA_CASH_EXTRACT_COLUMNS = [
  "CommitteeId",
  "ContributionAmount",
  "ContributionDate",
  "LastName",
  "FirstName",
  "MI",
  "Suffix",
  "Address1",
  "City",
  "State",
  "Zip",
  "ContributionID",
  "FiledDate",
  "ContributionType",
  "ContributorType",
  "CommitteeType",
  "CommitteeName",
  "CandidateName",
  "Amended",
] as const;

export const ALABAMA_EXPENDITURE_EXTRACT_COLUMNS = [
  "CommitteeId",
  "ExpenditureAmount",
  "ExpenditureDate",
  "LastName",
  "FirstName",
  "MI",
  "Suffix",
  "Address1",
  "City",
  "State",
  "Zip",
  "Explanation",
  "ExpenditureID",
  "FiledDate",
  "Purpose",
  "ExpenditureType",
  "CommitteeType",
  "CommitteeName",
  "CandidateName",
  "Amended",
] as const;

export type AlabamaQuarantinedRecord = {
  recordNumber: number;
  fieldCount: number;
  reason: "field_count" | "bad_id" | "bad_amount";
};

export type AlabamaExtractParseResult<TRow> = {
  rows: TRow[];
  quarantined: AlabamaQuarantinedRecord[];
  recordCount: number;
};

export type AlabamaCashRow = {
  committeeId: string;
  amountCents: number;
  contributionDate: string;
  lastName: string;
  firstName: string;
  /** Retain source identity fields for exact native/bulk agreement. */
  middleName?: string;
  suffix?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  contributionId: string;
  filedDate: string;
  contributionType: string;
  contributorType: string;
  committeeType: string;
  committeeName: string;
  candidateName: string;
  amended: string;
};

export type AlabamaExpenditureRow = {
  committeeId: string;
  amountCents: number;
  expenditureDate: string;
  expenditureId: string;
  filedDate: string;
  purpose: string;
  expenditureType: string;
  committeeType: string;
  committeeName: string;
  candidateName: string;
  amended: string;
};

/** "326.40" / "-500.00" -> signed cents; null when not a plain decimal amount. */
export function parseAlabamaAmountCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

// CSV records in the python-csv dialect the probes validated cent-exact
// against the portal: a quote only opens quoting at field start; inside a
// quoted section "" is an escaped quote and newlines are literal; a quote
// mid-field is a literal character.
function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (char === ",") {
      fields.push(field);
      field = "";
      atFieldStart = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      fields.push(field);
      records.push(fields);
      fields = [];
      field = "";
      atFieldStart = true;
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  if (field !== "" || fields.length > 0) {
    fields.push(field);
    records.push(fields);
  }
  return records.filter((record) => !(record.length === 1 && record[0]!.trim() === ""));
}

type AlabamaRowParse<TRow> =
  | { ok: true; row: TRow }
  | { ok: false; reason: AlabamaQuarantinedRecord["reason"] };

function parseAlabamaExtract<TRow>(
  csvText: string,
  expectedColumns: readonly string[],
  toRow: (record: readonly string[]) => AlabamaRowParse<TRow>
): AlabamaExtractParseResult<TRow> {
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const records = splitCsvRecords(text);
  if (records.length === 0) throw new Error("Alabama extract CSV is empty");
  const header = records[0]!.map((name) => name.trim());
  if (header.length !== expectedColumns.length || header.some((name, i) => name !== expectedColumns[i])) {
    throw new Error(`Alabama extract header changed: ${JSON.stringify(header)}`);
  }
  const rows: TRow[] = [];
  const quarantined: AlabamaQuarantinedRecord[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]!;
    // recordNumber is 1-based over data records, matching probe accounting.
    if (record.length !== expectedColumns.length) {
      quarantined.push({ recordNumber: index, fieldCount: record.length, reason: "field_count" });
      continue;
    }
    const result = toRow(record);
    if (result.ok) {
      rows.push(result.row);
    } else {
      quarantined.push({ recordNumber: index, fieldCount: record.length, reason: result.reason });
    }
  }
  return { rows, quarantined, recordCount: records.length - 1 };
}

export function parseAlabamaCashExtract(csvText: string): AlabamaExtractParseResult<AlabamaCashRow> {
  return parseAlabamaExtract(csvText, ALABAMA_CASH_EXTRACT_COLUMNS, (record) => {
    if (!/^\d+$/.test(record[11]!.trim())) return { ok: false, reason: "bad_id" };
    const amountCents = parseAlabamaAmountCents(record[1]!);
    if (amountCents === null) return { ok: false, reason: "bad_amount" };
    return {
      ok: true,
      row: {
        committeeId: record[0]!.trim(),
        amountCents,
        contributionDate: record[2]!.trim(),
        lastName: record[3]!.trim(),
        firstName: record[4]!.trim(),
        middleName: record[5]!.trim(),
        suffix: record[6]!.trim(),
        address1: record[7]!.trim(),
        city: record[8]!.trim(),
        state: record[9]!.trim(),
        zip: record[10]!.trim(),
        contributionId: record[11]!.trim(),
        filedDate: record[12]!.trim(),
        contributionType: record[13]!.trim(),
        contributorType: record[14]!.trim(),
        committeeType: record[15]!.trim(),
        committeeName: record[16]!.trim(),
        candidateName: record[17]!.trim(),
        amended: record[18]!.trim(),
      },
    };
  });
}

export function parseAlabamaExpenditureExtract(
  csvText: string
): AlabamaExtractParseResult<AlabamaExpenditureRow> {
  return parseAlabamaExtract(csvText, ALABAMA_EXPENDITURE_EXTRACT_COLUMNS, (record) => {
    if (!/^\d+$/.test(record[12]!.trim())) return { ok: false, reason: "bad_id" };
    const amountCents = parseAlabamaAmountCents(record[1]!);
    if (amountCents === null) return { ok: false, reason: "bad_amount" };
    return {
      ok: true,
      row: {
        committeeId: record[0]!.trim(),
        amountCents,
        expenditureDate: record[2]!.trim(),
        expenditureId: record[12]!.trim(),
        filedDate: record[13]!.trim(),
        purpose: record[14]!.trim(),
        expenditureType: record[15]!.trim(),
        committeeType: record[16]!.trim(),
        committeeName: record[17]!.trim(),
        candidateName: record[18]!.trim(),
        amended: record[19]!.trim(),
      },
    };
  });
}
