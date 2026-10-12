/** Source allocation facts only: this decoder establishes no currentness or money authority. */
export const MAINE_MAPLIGHT_INDEPENDENT_EXPENDITURE_HEADERS = [
  "Transaction ID",
  "Filer ID",
  "Filer Name",
  "Transaction Type",
  "Transaction Date",
  "Total Transaction Amount",
  "Description",
  "Contact Type",
  "Contact Name",
  "Contact Street Address 1",
  "Contact Street Address 2",
  "Contact City",
  "Contact State",
  "Contact Zip",
  "Purpose",
  "Candidate Name",
  "Candidate ID",
  "Support or Oppose",
  "Amount Spent on Candidate",
] as const;

type Column = (typeof MAINE_MAPLIGHT_INDEPENDENT_EXPENDITURE_HEADERS)[number];
type SourceRow = Record<Column, string>;

export interface MaineMapLightIndependentExpenditureAllocation {
  /** One-based logical data-record occurrence; never an expenditure or report ID. */
  occurrence: number;
  transactionId: string;
  filerId: string;
  filerName: string;
  transactionType: "independent_expenditure";
  transactionDate: string;
  totalTransactionAmount: string;
  totalTransactionAmountCents: number;
  description: string;
  purpose: string;
  candidateName: string;
  /** The published snapshot has some unnamed-ID targets; no ID is inferred. */
  candidateId: string | null;
  supportOppose: "support" | "oppose";
  amountSpentOnCandidate: string;
  amountSpentOnCandidateCents: number;
}

function fail(message: string): never {
  // Static diagnostics deliberately omit financial/contact fields and opaque IDs.
  throw new Error(`Maine MapLight IE CSV: ${message}`);
}

function parseRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "closed" = "unquoted";
  let atFieldStart = true;
  const finishField = () => {
    record.push(field);
    field = "";
    state = "unquoted";
    atFieldStart = true;
  };
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (state === "quoted") {
      if (char !== '"') field += char;
      else if (csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else state = "closed";
      continue;
    }
    if (char === ",") {
      finishField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      finishField();
      records.push(record);
      record = [];
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      continue;
    }
    if (state === "closed") fail("unexpected character after quoted field");
    if (char === '"') {
      if (!atFieldStart) fail("quote inside unquoted field");
      state = "quoted";
    } else field += char;
    atFieldStart = false;
  }
  if (state === "quoted") fail("unterminated quoted field");
  if (record.length || field || !atFieldStart) {
    finishField();
    records.push(record);
  }
  return records;
}

function civilDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("invalid transaction date");
  const [year, month, day] = value.split("-").map(Number);
  if (
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    fail("invalid transaction date");
  return value;
}

function moneyCents(value: string): number {
  // Preserve signed facts. No rounding, implicit exponent, or malformed grouping.
  const matched = /^(?:(-)\$?|\$(-)?|)(\d+|\d{1,3}(?:,\d{3})+)\.(\d{2})$/.exec(
    value,
  );
  if (!matched) fail("invalid exact-cent amount");
  const dollars = Number(matched[3].replace(/,/g, ""));
  const amount = dollars * 100 + Number(matched[4]);
  if (!Number.isSafeInteger(amount))
    fail("amount exceeds safe exact-cent range");
  return matched[1] || matched[2] ? -amount : amount;
}

function sourceId(value: string, prefix: "a" | "f"): string {
  if (!new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value))
    fail("invalid source ID");
  return value;
}

function requiredText(value: string): string {
  if (!value.trim()) fail("missing source identity text");
  return value;
}

/**
 * Decodes the observed 19-column snapshot without retaining source contact fields.
 * Every allocation is retained. Duplicate association keys fail rather than dedupe.
 * Whole-transaction reconciliation proves only the internal CSV allocation control.
 * Header-only output is an empty fact set, never evidence of complete zero spending.
 */
export function parseMaineMapLightIndependentExpenditureCsv(
  csv: string,
): MaineMapLightIndependentExpenditureAllocation[] {
  const records = parseRecords(csv.replace(/^\uFEFF/, ""));
  const headers = records.shift();
  if (
    !headers ||
    headers.length !== MAINE_MAPLIGHT_INDEPENDENT_EXPENDITURE_HEADERS.length ||
    headers.some(
      (header, index) =>
        header !== MAINE_MAPLIGHT_INDEPENDENT_EXPENDITURE_HEADERS[index],
    )
  ) {
    fail("unexpected 19-column header");
  }
  const transactions = new Map<
    string,
    { common: string; wholeCents: number; allocatedCents: number }
  >();
  const candidateNames = new Map<string, string>();
  const filerNames = new Map<string, string>();
  const keys = new Set<string>();
  const rows = records.map(
    (cells, index): MaineMapLightIndependentExpenditureAllocation => {
      if (cells.length !== headers.length) fail("unexpected data-record width");
      const raw = Object.fromEntries(
        headers.map((header, cell) => [header, cells[cell]]),
      ) as SourceRow;
      if (raw["Transaction Type"] !== "independent_expenditure")
        fail("unsupported transaction type");
      const direction = raw["Support or Oppose"];
      if (direction !== "support" && direction !== "oppose")
        fail("unsupported direction");
      const transactionId = sourceId(raw["Transaction ID"], "a");
      const filerId = sourceId(raw["Filer ID"], "f");
      const filerName = requiredText(raw["Filer Name"]);
      const candidateName = requiredText(raw["Candidate Name"]);
      const candidateId =
        raw["Candidate ID"] === "" ? null : sourceId(raw["Candidate ID"], "f");
      if (filerNames.has(filerId) && filerNames.get(filerId) !== filerName)
        fail("conflicting filer identity");
      filerNames.set(filerId, filerName);
      if (candidateId) {
        if (
          candidateNames.has(candidateId) &&
          candidateNames.get(candidateId) !== candidateName
        ) {
          fail("conflicting candidate identity");
        }
        candidateNames.set(candidateId, candidateName);
      }
      const key = JSON.stringify([
        transactionId,
        candidateId ? ["id", candidateId] : ["name", candidateName],
        direction,
      ]);
      if (keys.has(key)) fail("duplicate allocation key");
      keys.add(key);
      const totalTransactionAmountCents = moneyCents(
        raw["Total Transaction Amount"],
      );
      const amountSpentOnCandidateCents = moneyCents(
        raw["Amount Spent on Candidate"],
      );
      const transactionDate = civilDate(raw["Transaction Date"]);
      const common = JSON.stringify(cells.slice(0, 15));
      const prior = transactions.get(transactionId);
      if (prior && prior.common !== common)
        fail("conflicting whole-transaction fields");
      const allocatedCents =
        (prior?.allocatedCents ?? 0) + amountSpentOnCandidateCents;
      if (!Number.isSafeInteger(allocatedCents))
        fail("allocation sum exceeds safe exact-cent range");
      transactions.set(transactionId, {
        common,
        wholeCents: totalTransactionAmountCents,
        allocatedCents,
      });
      return {
        occurrence: index + 1,
        transactionId,
        filerId,
        filerName,
        transactionType: "independent_expenditure",
        transactionDate,
        totalTransactionAmount: raw["Total Transaction Amount"],
        totalTransactionAmountCents,
        description: raw.Description,
        purpose: raw.Purpose,
        candidateName,
        candidateId,
        supportOppose: direction,
        amountSpentOnCandidate: raw["Amount Spent on Candidate"],
        amountSpentOnCandidateCents,
      };
    },
  );
  for (const transaction of transactions.values()) {
    if (transaction.allocatedCents !== transaction.wholeCents)
      fail("candidate allocations do not equal whole transaction");
  }
  return rows;
}
