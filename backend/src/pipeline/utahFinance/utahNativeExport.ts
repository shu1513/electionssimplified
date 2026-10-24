import {
  parseUtahDisclosuresStrictCsvPayload,
  UtahDisclosuresClientError,
  utahDisclosuresTransactionRowFromCsvRow,
  type UtahDisclosuresTransactionRow,
} from "./utahDisclosuresClient.js";

export type UtahNativeExportRow = UtahDisclosuresTransactionRow & { amountCents: number };
export type UtahNativeExportType = "PCC" | "PAC" | "INDEXP";
const COLUMNS = [
  "REPORT", "TRAN_ID", "TRAN_TYPE", "TRAN_DATE", "TRAN_AMT", "INKIND", "LOAN", "AMENDS",
  "NAME", "PURPOSE", "ADDRESS1", "ADDRESS2", "CITY", "STATE", "ZIP", "INKIND_COMMENTS",
];
function requireNative(value: unknown): asserts value {
  if (!value) throw new Error("native_export_validation");
}
function exactCents(raw: string): number {
  const m = /^(-?)(\d{1,14})(?:\.(\d{1,12}))?$/.exec(raw);
  requireNative(m);
  const fraction = m[3] ?? "";
  requireNative(!/[1-9]/.test(fraction.slice(2)));
  const cents = (BigInt(m[2]) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"))) *
    (m[1] ? -1n : 1n);
  requireNative(cents >= BigInt(Number.MIN_SAFE_INTEGER) && cents <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(cents);
}
function validDate(raw: string): boolean {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) return false;
  const month = Number(m[1]), day = Number(m[2]), year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1998 && year <= 2100 && date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Parse a whole observed native export. This does not establish source identity,
 * report currentness, completeness of a committee universe, or an accepted zero. */
export function parseUtahNativeExport(
  csv: string,
  type: UtahNativeExportType,
  scope: "folder" | "annual",
): UtahNativeExportRow[] {
  try {
    requireNative(["PCC", "PAC", "INDEXP"].includes(type));
    requireNative(scope === "folder" || scope === "annual");
    const expected = [...(scope === "annual" ? ["FILED"] : []), type, ...COLUMNS];
    const parsed = parseUtahDisclosuresStrictCsvPayload(csv);
    requireNative(parsed.headers.length === expected.length &&
      parsed.headers.every((header, index) => header === expected[index]));
    const ids = new Set<string>();
    return parsed.rows.map((raw) => {
      requireNative(/^\d+$/.test(raw.TRAN_ID) && !ids.has(raw.TRAN_ID));
      ids.add(raw.TRAN_ID);
      requireNative(raw[type].length > 0 && validDate(raw.TRAN_DATE));
      requireNative(raw.TRAN_TYPE === "Contribution" || raw.TRAN_TYPE === "Expenditure");
      requireNative(["", "X"].includes(raw.INKIND) && ["", "X"].includes(raw.LOAN));
      const amountCents = exactCents(raw.TRAN_AMT);
      const row = utahDisclosuresTransactionRowFromCsvRow(raw);
      requireNative(row && Number.isFinite(row.amount));
      return { ...row, amountCents };
    });
  } catch {
    // Never include source names, selectors, or financial row text in failures.
    throw new UtahDisclosuresClientError("bad_response", "Utah native export failed complete validation");
  }
}
