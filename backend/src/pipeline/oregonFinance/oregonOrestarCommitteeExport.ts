import { read as readXlsWorkbook, utils as xlsxUtils } from "xlsx";

import { OREGON_ORESTAR_BASE_URL } from "./oregonOrestarParser.js";
import { isOregonOrestarExportWorkbook } from "./oregonOrestarTransactionExport.js";

export type OregonOrestarCommitteeDirectoryRow = {
  filerCommitteeId: string;
  filerCommitteeName: string;
  committeeUrl: string;
  committeeType: string;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  candidateOffice: string | null;
  activeElection: string | null;
};

// Same .xls / .xlsx check as the transaction export.
export function isOregonOrestarCommitteeExportWorkbook(data: Uint8Array): boolean {
  return isOregonOrestarExportWorkbook(data);
}

const REQUIRED_EXPORT_HEADERS = [
  "Committee Id",
  "Committee Name",
  "Committee Type",
  "Candidate Office",
  "Candidate First Name",
  "Candidate Last Name",
  "Active Election",
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

export function parseOregonOrestarCommitteeExport(
  data: Uint8Array
): OregonOrestarCommitteeDirectoryRow[] {
  if (!isOregonOrestarCommitteeExportWorkbook(data)) {
    throw new Error(
      "ORESTAR committee export response is not an .xls workbook; treating as blocked rather than parsing"
    );
  }

  let rows: Record<string, unknown>[];
  try {
    const workbook = readXlsWorkbook(data, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) {
      throw new Error("workbook has no sheets");
    }
    rows = xlsxUtils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null });
  } catch (error) {
    throw new Error(
      `ORESTAR committee export workbook could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (rows.length > 0) {
    const headers = new Set(Object.keys(rows[0] ?? {}));
    const missing = REQUIRED_EXPORT_HEADERS.filter((header) => !headers.has(header));
    if (missing.length > 0) {
      throw new Error(`ORESTAR committee export is missing required columns: ${missing.join(", ")}`);
    }
  }

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const committeeId = toText(row["Committee Id"]);
    const committeeName = toText(row["Committee Name"]);
    const committeeType = toText(row["Committee Type"]);
    const fail = (reason: string): never => {
      throw new Error(`ORESTAR committee export row ${rowNumber} is unusable: ${reason}`);
    };

    if (!committeeId || !/^\d+$/.test(committeeId)) {
      fail(`invalid Committee Id ${JSON.stringify(committeeId)}`);
    }
    if (!committeeName) {
      fail("missing Committee Name");
    }
    if (committeeType !== "CC") {
      fail(`unexpected Committee Type ${JSON.stringify(committeeType)}`);
    }

    return {
      filerCommitteeId: committeeId!,
      filerCommitteeName: committeeName!,
      committeeUrl: `${OREGON_ORESTAR_BASE_URL}/orestar/sooDetail.do?cneCommitteeId=${encodeURIComponent(committeeId!)}`,
      committeeType: committeeType!,
      candidateFirstName: toText(row["Candidate First Name"]),
      candidateLastName: toText(row["Candidate Last Name"]),
      candidateOffice: toText(row["Candidate Office"]),
      activeElection: toText(row["Active Election"]),
    };
  });
}
