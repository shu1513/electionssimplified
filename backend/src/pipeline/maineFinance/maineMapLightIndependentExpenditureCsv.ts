import {
  parseMaineMapLightCsvRecords as parseRecords,
  parseMaineMapLightCivilDate as civilDate,
  parseMaineMapLightCents as moneyCents,
  parseMaineMapLightSourceId as sourceId,
  requireMaineMapLightIdentityText as requiredText,
} from "./maineMapLightCsvPrimitives.js";

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

/**
 * Decodes the observed 19-column snapshot without retaining source contact fields.
 * Every allocation is retained. Duplicate association keys fail rather than dedupe.
 * Whole-transaction reconciliation proves only the internal CSV allocation control.
 * Header-only output is an empty fact set, never evidence of complete zero spending.
 */
export function parseMaineMapLightIndependentExpenditureCsv(
  csv: string,
): MaineMapLightIndependentExpenditureAllocation[] {
  const records = parseRecords(csv.replace(/^\uFEFF/, ""), fail);
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
      const transactionId = sourceId(raw["Transaction ID"], "a", fail);
      const filerId = sourceId(raw["Filer ID"], "f", fail);
      const filerName = requiredText(raw["Filer Name"], fail);
      const candidateName = requiredText(raw["Candidate Name"], fail);
      const candidateId =
        raw["Candidate ID"] === ""
          ? null
          : sourceId(raw["Candidate ID"], "f", fail);
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
        fail,
      );
      const amountSpentOnCandidateCents = moneyCents(
        raw["Amount Spent on Candidate"],
        fail,
      );
      const transactionDate = civilDate(raw["Transaction Date"], fail);
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
