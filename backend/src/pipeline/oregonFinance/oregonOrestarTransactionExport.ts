import { read as readXlsWorkbook, utils as xlsxUtils } from "xlsx";

import { parseOregonDateYear } from "./oregonFinanceAggregator.js";
import type { OregonOrestarTransactionDetail } from "./oregonOrestarParser.js";

/**
 * Parser for the ORESTAR transaction search's XcelCNESearch export — a binary
 * BIFF .xls workbook whose first sheet holds one header row plus one row per
 * transaction. The export returns the FULL result set of the search that
 * produced it (verified live: 116 rows for a search reporting 116 records),
 * which is what makes it the right money path for large committees: one
 * download instead of one detail-page fetch per transaction.
 */

// Compound File Binary magic (D0 CF 11 E0): every real .xls starts with it. A
// blocked or degraded portal answers with HTML instead, so this is the
// cheapest fail-closed check before handing bytes to the workbook reader.
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;
// ZIP magic (50 4B 03 04): ORESTAR switched its exports to .xlsx by Oct 2026
// (still served as application/vnd.ms-excel). The workbook reader takes both.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

export function isOregonOrestarExportWorkbook(data: Uint8Array): boolean {
  return (
    CFB_MAGIC.every((byte, index) => data[index] === byte) ||
    ZIP_MAGIC.every((byte, index) => data[index] === byte)
  );
}

const REQUIRED_EXPORT_HEADERS = [
  "Tran Id",
  "Tran Date",
  "Filer",
  "Filer Id",
  "Contributor/Payee",
  "Sub Type",
  "Amount",
] as const;

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    // Number("") and Number("   ") are both 0, so a blank or currency-symbol-only
    // cell would masquerade as a genuine $0 and slip past the row guard — which
    // then lets the aggregator drop it and understate the total. An unknown
    // amount must read as null; only a real "0" may read as zero.
    const normalized = value.replace(/[$,]/g, "").trim();
    if (normalized.length === 0) {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Guards the gap between "the workbook has the right number of rows" and "the
 * aggregator can actually count this row". A row the aggregator silently drops
 * still satisfies the row-count completeness check, so a blank or unusable
 * cell would understate the saved total while every check stayed green — the
 * exact failure class the complete-or-throw contract exists to prevent.
 *
 * Only parseability is enforced. Non-positive amounts and refund/loan subtypes
 * are REAL rows that the aggregator excludes as a deliberate business rule, so
 * they must not throw here.
 */
function assertUsableExportRow(input: {
  detail: OregonOrestarTransactionDetail;
  expectedCommitteeId: string | null;
  rowNumber: number;
}): void {
  const { detail, expectedCommitteeId, rowNumber } = input;
  const fail = (reason: string): never => {
    throw new Error(
      `ORESTAR export row ${rowNumber} is unusable (${reason}); refusing to persist a total that would silently drop it`
    );
  };

  if (!detail.transactionId) {
    fail("missing Tran Id");
  }
  if (!detail.filerCommitteeId) {
    fail("missing Filer Id");
  }
  // The aggregator matches the filer committee by exact ID, so a stray row
  // from another committee would be dropped rather than counted.
  if (expectedCommitteeId && detail.filerCommitteeId !== expectedCommitteeId) {
    fail(`Filer Id ${detail.filerCommitteeId} does not match requested committee ${expectedCommitteeId}`);
  }
  // A blank date — or one exported as a raw Excel serial instead of a date
  // string — yields no year, and the aggregator's cycle-window check drops it.
  if (parseOregonDateYear(detail.transactionDate) === null) {
    fail(`unparseable Tran Date ${JSON.stringify(detail.transactionDate)}`);
  }
  if (detail.amount === null) {
    fail(`unparseable Amount ${JSON.stringify(detail.amount)}`);
  }
}

export function parseOregonOrestarTransactionExport(input: {
  data: Uint8Array;
  /** Stamped onto every row; the caller knows which cneSearchTranType it searched for. */
  transactionType?: string | null;
  sourceUrl?: string | null;
  /**
   * When set, every row's Filer Id must equal it. The sync always passes the
   * committee it searched for; it stays optional so the parser can be pointed
   * at an arbitrary saved export.
   */
  expectedCommitteeId?: string | null;
}): OregonOrestarTransactionDetail[] {
  if (!isOregonOrestarExportWorkbook(input.data)) {
    throw new Error("ORESTAR export response is not an .xls workbook; treating as blocked rather than parsing");
  }

  let rows: Record<string, unknown>[];
  try {
    const workbook = readXlsWorkbook(input.data, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) {
      throw new Error("workbook has no sheets");
    }
    rows = xlsxUtils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null });
  } catch (error) {
    throw new Error(
      `ORESTAR export workbook could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (rows.length > 0) {
    const headers = new Set(Object.keys(rows[0] ?? {}));
    const missing = REQUIRED_EXPORT_HEADERS.filter((header) => !headers.has(header));
    if (missing.length > 0) {
      throw new Error(`ORESTAR export is missing required columns: ${missing.join(", ")}`);
    }
  }

  const transactionType = input.transactionType?.trim() || null;
  const sourceUrl = input.sourceUrl?.trim() || null;
  const expectedCommitteeId = input.expectedCommitteeId?.trim() || null;
  return rows.map((row, index) => {
    const detail: OregonOrestarTransactionDetail = {
      transactionId: toText(row["Tran Id"]),
      transactionDate: toText(row["Tran Date"]),
      transactionType,
      transactionSubType: toText(row["Sub Type"]),
      filedDate: toText(row["Filed Date"]),
      amount: toAmount(row["Amount"]),
      aggregate: toAmount(row["Aggregate Amount"]),
      processStatus: toText(row["Tran Status"]),
      purpose: toText(row["Purp Desc"]),
      filerCommitteeName: toText(row["Filer"]),
      filerCommitteeId: toText(row["Filer Id"]),
      addressBookType: toText(row["Book Type"]),
      contributorPayeeName: toText(row["Contributor/Payee"]),
      address: null,
      occupation: toText(row["Occptn Txt"]),
      employerName: toText(row["Emp Name"]),
      // Independent-expenditure associations only exist on transaction detail
      // pages; the export has no equivalent column. This path has never carried
      // them (see the outside-spending limitation note in the batch sync).
      outsideAssociations: [],
      sourceUrl,
    };
    assertUsableExportRow({ detail, expectedCommitteeId, rowNumber: index + 2 });
    return detail;
  });
}
