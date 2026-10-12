import { createHash } from "node:crypto";
import {
  DELAWARE_EXPENSE_CSV_COLUMNS,
  DELAWARE_RECEIPT_CSV_COLUMNS,
  parseDelawareAmountCents,
  parseDelawareExpensesCsv,
  parseDelawareReceiptsCsv,
} from "./delawareCfrsParsers.js";

export const DELAWARE_NATIVE_PAGE_SIZE = 500;
export const DELAWARE_NATIVE_RECEIPT_FIELDS = [
  "ContributionType",
  "TransactionDate",
  "Transaction_id",
  "ContributorName",
  "ContributionAmount",
  "ContributorAddress",
  "EmployerAddress",
  "OccupationTitle",
  "EmployerName",
  "EmployerAddressLine1",
  "ContributorType",
  "ReceivingCommitteeName",
  "GabId",
  "WC_ID",
  "Office",
  "District",
  "Branch",
  "FilingPeriodName",
  "Fund_Type",
  "Fixed_Asset",
  "FileAmendedVersion",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State_Code",
  "Zip_Code",
  "Zip_Ext",
] as const;
export const DELAWARE_NATIVE_EXPENSE_FIELDS = [
  "Transaction_Id",
  "RegistrantName",
  "PayeeName",
  "PayeeType",
  "Address",
  "TransactionDate",
  "ExpensePurpose",
  "ExpenseCategory",
  "ExpenseMethod",
  "ExpenseAmount",
  "District",
  "FilingYear",
  "FilingPeriodName",
  "CommitteeID",
  "VendorName",
  "VendorAddress",
  "Comments",
  "Fund_Type",
  "Fixed_Asset",
  "Fixed_Asset_Desc",
  "Fixed_Asset_Location",
  "CCF_ID",
  "FileAmendedVersion",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State",
  "ZipCode",
] as const;

export class DelawareNativeLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelawareNativeLedgerError";
  }
}

export type DelawareNativeLedgerKind = "receipts" | "expenses";
export type DelawareNativeLedgerRow = {
  readonly transactionId: number;
  readonly date: string;
  readonly amountCents: number;
  readonly rawFields: Readonly<Record<string, unknown>>;
};
export type DelawareNativeLedgerPage = {
  readonly kind: DelawareNativeLedgerKind;
  readonly rows: readonly DelawareNativeLedgerRow[];
  /** Source value retained without using it as cardinality authority. */
  readonly advisoryTotal: unknown;
};
export type DelawareNativeLedger = {
  readonly kind: DelawareNativeLedgerKind;
  readonly rows: readonly DelawareNativeLedgerRow[];
  readonly physicalRowCount: number;
  readonly transportOverlapCount: number;
  readonly advisoryTotals: readonly unknown[];
  readonly rawRowFingerprint: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new DelawareNativeLedgerError(message);
}
function cloneJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  if (object(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, cloneJson(v)]),
      ),
    );
  }
  return fail("Native source contains an unsupported JSON value");
}
function canonical(value: unknown): string {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : object(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, ordered(v[key])]),
          )
        : v;
  return JSON.stringify(ordered(value));
}
function nativeDate(value: unknown): string {
  if (typeof value !== "string")
    return fail("Native TransactionDate is not a string");
  const match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (!match) return fail("Native TransactionDate shape changed");
  const millis = Number(match[1]);
  const date = new Date(millis);
  if (!Number.isSafeInteger(millis) || !Number.isFinite(date.getTime())) {
    return fail("Native TransactionDate is invalid");
  }
  const iso = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso))
    return fail("Native TransactionDate is outside civil-date range");
  return iso;
}
function csvDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) return fail("CSV civil date shape changed");
  const iso =
    match[3] +
    "-" +
    match[1]!.padStart(2, "0") +
    "-" +
    match[2]!.padStart(2, "0");
  const date = new Date(iso + "T00:00:00Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso
  ) {
    return fail("CSV civil date is invalid");
  }
  return iso;
}
function decode(
  rawJson: string,
  kind: DelawareNativeLedgerKind,
): DelawareNativeLedgerPage {
  let body: unknown;
  try {
    body = JSON.parse(rawJson);
  } catch {
    return fail("Native response is not JSON");
  }
  if (
    !object(body) ||
    !Object.hasOwn(body, "data") ||
    !Array.isArray(body.data)
  ) {
    return fail("Native response requires an explicit data array");
  }
  if (!Object.hasOwn(body, "total"))
    return fail("Native response omitted advisory total");
  if (body.data.length > DELAWARE_NATIVE_PAGE_SIZE)
    return fail("Native page exceeds 500 rows");
  const fields =
    kind === "receipts"
      ? DELAWARE_NATIVE_RECEIPT_FIELDS
      : DELAWARE_NATIVE_EXPENSE_FIELDS;
  const idField = kind === "receipts" ? "Transaction_id" : "Transaction_Id";
  const amountField =
    kind === "receipts" ? "ContributionAmount" : "ExpenseAmount";
  const nullable = new Set(
    kind === "receipts"
      ? [
          "EmployerAddress",
          "EmployerAddressLine1",
          "Office",
          "Branch",
          "Fund_Type",
        ]
      : ["District", "FilingYear", "CommitteeID", "Comments", "Fund_Type"],
  );
  const rows = body.data.map((input): DelawareNativeLedgerRow => {
    if (!object(input) || fields.some((key) => !Object.hasOwn(input, key))) {
      return fail("Native row omitted a required published field");
    }
    for (const field of fields) {
      if (field === idField || field === amountField) continue;
      if (
        typeof input[field] !== "string" &&
        !(nullable.has(field) && input[field] === null)
      ) {
        return fail("Native row field type changed: " + field);
      }
    }
    const id = input[idField];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      return fail("Native transaction ID is invalid");
    const amount = input[amountField];
    if (typeof amount !== "number" || !Number.isFinite(amount))
      return fail("Native amount is not a finite number");
    const amountCents = parseDelawareAmountCents(String(amount));
    const rawFields = cloneJson(input) as Readonly<Record<string, unknown>>;
    return Object.freeze({
      transactionId: id,
      date: nativeDate(input.TransactionDate),
      amountCents,
      rawFields,
    });
  });
  return Object.freeze({
    kind,
    rows: Object.freeze(rows),
    advisoryTotal: cloneJson(body.total),
  });
}
export function decodeDelawareReceiptNativePage(
  rawJson: string,
): DelawareNativeLedgerPage {
  return decode(rawJson, "receipts");
}
export function decodeDelawareExpenseNativePage(
  rawJson: string,
): DelawareNativeLedgerPage {
  return decode(rawJson, "expenses");
}

/** Exact observed native-to-CSV transport: literal commas become spaces. No name aliases. */
function text(row: DelawareNativeLedgerRow, key: string): string {
  const value = row.rawFields[key];
  return typeof value === "string"
    ? value.replace(/,/g, " ").trim()
    : fail("Native CSV projection field missing: " + key);
}
export function projectDelawareNativeReceiptCsvRow(
  row: DelawareNativeLedgerRow,
): Record<string, string> {
  const projected: Record<string, string> = {
    "Contribution Date": row.date,
    "Contribution Amount": String(row.amountCents),
  };
  const fields = {
    "Contributor Name": "ContributorName",
    "Contributor Address Line 1": "AddressLine1",
    "Contributor Address Line 2": "AddressLine2",
    "Contributor City": "City",
    "Contributor State": "State_Code",
    "Contributor Type": "ContributorType",
    "Employer Name": "EmployerName",
    "Employer Occupation": "OccupationTitle",
    "Contribution Type": "ContributionType",
    CF_ID: "WC_ID",
    "Receiving Committee": "ReceivingCommitteeName",
    "Filing Period": "FilingPeriodName",
    Office: "District",
    "Fixed Asset": "Fixed_Asset",
  };
  for (const [column, key] of Object.entries(fields))
    projected[column] = text(row, key);
  // The export adds a hyphen for a nonempty raw extension, including four spaces.
  // Preserve that source transport; do not clean or guess a valid postal code.
  const extension = row.rawFields.Zip_Ext;
  if (typeof extension !== "string")
    return fail("Native Zip_Ext field missing");
  const code = row.rawFields.Zip_Code;
  if (typeof code !== "string") return fail("Native Zip_Code field missing");
  projected["Contributor Zip"] = (
    code + (extension.length > 0 ? "-" + extension : "")
  )
    .replace(/,/g, " ")
    .trim();
  return projected;
}
export function projectDelawareNativeExpenseCsvRow(
  row: DelawareNativeLedgerRow,
): Record<string, string> {
  const projected: Record<string, string> = {
    "Expenditure Date": row.date,
    "Amount($)": String(row.amountCents),
  };
  const fields = {
    "Payee Name": "PayeeName",
    "Payee Address Line 1": "AddressLine1",
    "Payee Address Line 2": "AddressLine2",
    "Payee City": "City",
    "Payee State": "State",
    "Payee Zip": "ZipCode",
    "Payee Type": "PayeeType",
    "CF ID": "CCF_ID",
    "Committee Name": "RegistrantName",
    "Expense Category": "ExpenseCategory",
    "Expense Purpose": "ExpensePurpose",
    "Expense Method": "ExpenseMethod",
    "Filing Period": "FilingPeriodName",
    "Fixed Asset": "Fixed_Asset",
  };
  for (const [column, key] of Object.entries(fields))
    projected[column] = text(row, key);
  return projected;
}

/** Transport/identity closure only. Empty transport is never authoritative financial zero. */
export function closeDelawareNativeLedger(input: {
  pages: readonly {
    pageNumber: number;
    pageSize: number;
    page: DelawareNativeLedgerPage;
  }[];
  renderedCount: number;
  csv: string;
}): DelawareNativeLedger {
  if (
    !Number.isSafeInteger(input.renderedCount) ||
    input.renderedCount < 0 ||
    input.pages.length === 0
  ) {
    return fail(
      "Native closure requires a valid independent rendered count and pages",
    );
  }
  const kind = input.pages[0]!.page.kind;
  const rows: DelawareNativeLedgerRow[] = [];
  const byId = new Map<number, DelawareNativeLedgerRow>();
  let physicalRowCount = 0;
  let transportOverlapCount = 0;
  for (let index = 0; index < input.pages.length; index += 1) {
    const packet = input.pages[index]!;
    if (
      packet.pageNumber !== index + 1 ||
      !Number.isSafeInteger(packet.pageSize) ||
      packet.pageSize < 1 ||
      packet.pageSize > DELAWARE_NATIVE_PAGE_SIZE ||
      (input.pages.length > 1 &&
        packet.pageSize !== DELAWARE_NATIVE_PAGE_SIZE) ||
      packet.page.kind !== kind
    ) {
      return fail(
        "Native pages are missing, reordered, or have an unsupported page size",
      );
    }
    if (
      packet.page.rows.length > packet.pageSize ||
      (index < input.pages.length - 1 &&
        packet.page.rows.length !== DELAWARE_NATIVE_PAGE_SIZE) ||
      (index === input.pages.length - 1 &&
        packet.page.rows.length === packet.pageSize)
    ) {
      return fail("Native paging lacks a complete short terminal page");
    }
    const previousLast =
      index === 0 ? undefined : input.pages[index - 1]!.page.rows.at(-1);
    for (let rowIndex = 0; rowIndex < packet.page.rows.length; rowIndex += 1) {
      const row = packet.page.rows[rowIndex]!;
      physicalRowCount += 1;
      const prior = byId.get(row.transactionId);
      if (prior) {
        if (canonical(prior.rawFields) !== canonical(row.rawFields))
          return fail("Conflicting native stable transaction ID");
        if (
          rowIndex !== 0 ||
          previousLast?.transactionId !== row.transactionId
        ) {
          return fail(
            "Repeated native stable ID is not the proved page-boundary overlap",
          );
        }
        transportOverlapCount += 1;
      } else {
        byId.set(row.transactionId, row);
        rows.push(row);
      }
    }
  }
  if (rows.length !== input.renderedCount)
    return fail("Native logical count differs from rendered count");
  const parsed =
    kind === "receipts"
      ? parseDelawareReceiptsCsv(input.csv)
      : parseDelawareExpensesCsv(input.csv);
  if (
    parsed.malformedRowCount !== 0 ||
    parsed.rows.length !== input.renderedCount
  ) {
    return fail("CSV is malformed or differs from independent source count");
  }
  const columns: readonly string[] =
    kind === "receipts"
      ? DELAWARE_RECEIPT_CSV_COLUMNS
      : DELAWARE_EXPENSE_CSV_COLUMNS;
  const dateColumn =
    kind === "receipts" ? "Contribution Date" : "Expenditure Date";
  const amountColumn =
    kind === "receipts" ? "Contribution Amount" : "Amount($)";
  const csvTuples = (parsed.rows as readonly Record<string, string>[]).map(
    (row) =>
      columns.map((column) =>
        column === dateColumn
          ? csvDate(row[column]!)
          : column === amountColumn
            ? String(parseDelawareAmountCents(row[column]!))
            : row[column]!.trim(),
      ),
  );
  const nativeTuples = rows.map((row) => {
    const projected =
      kind === "receipts"
        ? projectDelawareNativeReceiptCsvRow(row)
        : projectDelawareNativeExpenseCsvRow(row);
    return columns.map((column) => projected[column]);
  });
  if (
    canonical(csvTuples.map(canonical).sort()) !==
    canonical(nativeTuples.map(canonical).sort())
  ) {
    return fail("Full published CSV/native financial multiset differs");
  }
  const rawRowFingerprint = createHash("sha256")
    .update(
      canonical({
        kind,
        rows: [...rows]
          .sort((a, b) => a.transactionId - b.transactionId)
          .map((row) => row.rawFields),
      }),
    )
    .digest("hex");
  return Object.freeze({
    kind,
    rows: Object.freeze(rows),
    physicalRowCount,
    transportOverlapCount,
    advisoryTotals: Object.freeze(
      input.pages.map((packet) => packet.page.advisoryTotal),
    ),
    rawRowFingerprint,
  });
}
