export const ILLINOIS_SBE_EXPORT_ROW_CAP = 25_000;

const ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL =
  "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCandidates.aspx";
const ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL =
  "https://www.elections.il.gov/CampaignDisclosure/ExpenditureSearchByAllExpenditures.aspx";

export type IllinoisSbeSupportOppose = "support" | "oppose";

export type IllinoisSbeCsvRow = Record<string, string>;

export type IllinoisSbeReportSourceFields = {
  /** Exact source committee identifier; receiving ownership must be verified separately. */
  committeeId?: string | null;
  documentName?: string | null;
  reportingPeriodStart?: string | null;
  reportingPeriodEnd?: string | null;
  /** Populated only after the complete all-version metadata join verifies an exact current report. */
  sourceDocumentId?: string | null;
};

export type IllinoisSbeContributionRecord = IllinoisSbeReportSourceFields & {
  contributorName: string | null;
  contributorAddress: string | null;
  occupation: string | null;
  employer: string | null;
  amount: number;
  receivedDate: string | null;
  reportReceivedDate: string | null;
  contributionType: string | null;
  recipientCommitteeName: string | null;
  description: string | null;
  vendorName: string | null;
  vendorAddress: string | null;
  sourceUrl: string;
};

export type IllinoisSbeExpenditureRecord = IllinoisSbeReportSourceFields & {
  payeeName: string | null;
  payeeAddress: string | null;
  amount: number;
  expendedDate: string | null;
  reportReceivedDate: string | null;
  expenditureType: string | null;
  expendingCommitteeName: string | null;
  purpose: string | null;
  candidateName: string | null;
  officeDistrict: string | null;
  supportOppose: IllinoisSbeSupportOppose | null;
  sourceUrl: string;
};

export type IllinoisSbeExportCapStatus = {
  rowCount: number;
  cap: number;
  capped: boolean;
  warningTextPresent: boolean;
  reason: "row_count_reached_cap" | "warning_text_present" | null;
};

export type IllinoisSbePartitionDateWindow = {
  fromDate: string;
  toDate: string;
};

export type IllinoisSbePartitionAmountWindow = {
  minAmount: number;
  maxAmount: number;
};

export type IllinoisSbeExportPartitionWindow = {
  fromDate?: string;
  toDate?: string;
  minAmount?: number;
  maxAmount?: number;
};

export type IllinoisSbeExportPartitionPlan = {
  status: IllinoisSbeExportCapStatus;
  strategy: "date" | "amount" | null;
  partitions: [IllinoisSbeExportPartitionWindow, IllinoisSbeExportPartitionWindow] | null;
};

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
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
    throw new Error("Illinois SBE CSV has an unterminated quoted field");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((fields) => fields.some((fieldValue) => fieldValue.trim().length > 0));
}

export function parseIllinoisSbeCsvRows(csv: string): IllinoisSbeCsvRow[] {
  const rows = parseCsvRows(csv);
  const headerRow = rows[0];
  if (!headerRow) {
    return [];
  }
  const headers = headerRow.map(normalizeHeader);
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error("Illinois SBE CSV has empty or duplicate headers");
  }
  return rows.slice(1).map((fields) => {
    if (fields.length !== headers.length) {
      throw new Error("Illinois SBE CSV row width does not match its header");
    }
    const row: IllinoisSbeCsvRow = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header) {
        row[header] = fields[index]?.trim() ?? "";
      }
    }
    return row;
  });
}

function getString(row: IllinoisSbeCsvRow, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[normalizeHeader(key)] ?? row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().replace(/\u00a0/g, " ");
    }
  }
  return null;
}

function parseAmount(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.trim();
  const parentheses = /^\(.*\)$/.test(normalized);
  const unsigned = parentheses ? normalized.slice(1, -1) : normalized;
  if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(unsigned)) return null;
  const parsed = Number(unsigned.replace(/[$,]/g, ""));
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(Math.round(parsed * 100)) || (parentheses && parsed < 0)) return null;
  return parentheses ? -parsed : parsed;
}

const MODERN_CONTRIBUTION_HEADERS = [
  "CommitteeID", "CommitteeName", "ContributedBy", "RcvdDate", "Amount", "LoanAmount", "Occupation", "Employer",
  "Address1", "Address2", "City", "State", "Zip", "D2Part", "Description", "VendorName", "VendorAddress1",
  "VendorAddress2", "VendorCity", "VendorState", "VendorZip", "DocName", "Election", "RptPdBegDate", "RptPdEndDate", "FiledRcvdDate",
];
const MODERN_EXPENDITURE_HEADERS = [
  "CommitteeID", "ReceivedBy", "ExpndDate", "Amount", "Address1", "Address2", "City", "State", "Zip",
  "ExpendedByType", "Purpose", "Beneficiary", "CandidateName", "OfficeDistrict", "SupportingOpposing", "DocName",
  "Election", "RptPdBegDate", "RptPdEndDate", "RptRcvdDate", "ExpendedBy",
];

function validatedExportRows(csv: string, kind: "contribution" | "expenditure"): IllinoisSbeCsvRow[] {
  if (hasIllinoisSbeExportCapWarning(csv)) throw new Error("Illinois SBE export is capped");
  const table = parseCsvRows(csv);
  const headers = table[0]?.map(normalizeHeader) ?? [];
  const modern = headers.includes("committeeid");
  const required = modern
    ? (kind === "contribution" ? MODERN_CONTRIBUTION_HEADERS : MODERN_EXPENDITURE_HEADERS)
    : (kind === "contribution"
      ? ["Contributed By", "Received By", "Amount", "Amount Received Date", "Report Received Date"]
      : ["Received By", "Expended By", "Amount", "Expended By Date", "Report Received Date", "Candidate Name", "Office - District", "Supporting / Opposing"]);
  if (!required.every((header) => headers.includes(normalizeHeader(header))) || (modern && headers.length !== required.length)) {
    throw new Error(`Illinois SBE ${kind} export has an unrecognized schema`);
  }
  const rows = parseIllinoisSbeCsvRows(csv);
  if (rows.length >= ILLINOIS_SBE_EXPORT_ROW_CAP) throw new Error("Illinois SBE export is capped");
  if (modern && rows.length === 0) {
    throw new Error("Illinois SBE modern header-only export does not establish complete empty coverage");
  }
  return rows;
}

function modernReportFields(row: IllinoisSbeCsvRow): IllinoisSbeReportSourceFields {
  if (!("committeeid" in row)) return {};
  const committeeId = getString(row, "CommitteeID");
  if (!committeeId || !/^\d+$/.test(committeeId)) throw new Error("Illinois SBE CSV has an invalid committee ID");
  return {
    committeeId,
    documentName: getString(row, "DocName"),
    reportingPeriodStart: getString(row, "RptPdBegDate"),
    reportingPeriodEnd: getString(row, "RptPdEndDate"),
  };
}

function modernAddress(row: IllinoisSbeCsvRow, prefix = ""): string | null {
  return ["Address1", "Address2", "City", "State", "Zip"]
    .map((field) => getString(row, `${prefix}${field}`)).filter(Boolean).join("\n") || null;
}

function splitMultilineCell(value: string | null): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\u00a0/g, " "))
    .filter(Boolean);
}

function parseNameAddressOccupationEmployer(value: string | null): {
  name: string | null;
  address: string | null;
  occupation: string | null;
  employer: string | null;
} {
  const lines = splitMultilineCell(value);
  let occupation: string | null = null;
  let employer: string | null = null;
  const identityLines: string[] = [];

  for (const line of lines) {
    const occupationMatch = /^Occupation:\s*(.+)$/i.exec(line);
    if (occupationMatch?.[1]) {
      occupation = occupationMatch[1].trim();
      continue;
    }
    const employerMatch = /^Employer:\s*(.+)$/i.exec(line);
    if (employerMatch?.[1]) {
      employer = employerMatch[1].trim();
      continue;
    }
    identityLines.push(line);
  }

  return {
    name: identityLines[0] ?? null,
    address: identityLines.slice(1).join("\n") || null,
    occupation,
    employer,
  };
}

function parseTypeAndCommittee(value: string | null): { type: string | null; committeeName: string | null } {
  const lines = splitMultilineCell(value);
  return {
    type: lines[0] ?? null,
    committeeName: lines.slice(1).join(" ") || null,
  };
}

function parseSupportOppose(value: string | null): IllinoisSbeSupportOppose | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "supporting" || normalized === "support") {
    return "support";
  }
  if (normalized === "opposing" || normalized === "oppose") {
    return "oppose";
  }
  return null;
}

export function illinoisSbeContributionRecordFromRow(
  row: IllinoisSbeCsvRow,
  sourceUrl = ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL
): IllinoisSbeContributionRecord | null {
  const amount = parseAmount(getString(row, "Amount"));
  if (amount === null) {
    return null;
  }
  const modern = "committeeid" in row;
  const contributor = parseNameAddressOccupationEmployer(getString(row, "Contributed By", "ContributedBy"));
  const recipient = parseTypeAndCommittee(getString(row, "Received By"));
  return {
    contributorName: contributor.name,
    contributorAddress: modern ? modernAddress(row) : contributor.address,
    occupation: modern ? getString(row, "Occupation") : contributor.occupation,
    employer: modern ? getString(row, "Employer") : contributor.employer,
    amount,
    receivedDate: getString(row, "Amount Received Date", "Contribution Received Date", "Received Date", "RcvdDate"),
    reportReceivedDate: getString(row, "Report Received Date", "FiledRcvdDate"),
    contributionType: modern ? getString(row, "D2Part") : recipient.type,
    recipientCommitteeName: modern ? getString(row, "CommitteeName") : recipient.committeeName,
    description: getString(row, "Description"),
    vendorName: getString(row, "Vendor Name", "VendorName"),
    vendorAddress: modern ? modernAddress(row, "Vendor") : getString(row, "Vendor Address"),
    ...modernReportFields(row),
    sourceUrl,
  };
}

export function illinoisSbeExpenditureRecordFromRow(
  row: IllinoisSbeCsvRow,
  sourceUrl = ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL
): IllinoisSbeExpenditureRecord | null {
  const amount = parseAmount(getString(row, "Amount"));
  if (amount === null) {
    return null;
  }
  const modern = "committeeid" in row;
  const payee = parseNameAddressOccupationEmployer(getString(row, "Received By", "ReceivedBy"));
  const spender = parseTypeAndCommittee(getString(row, "Expended By"));
  return {
    payeeName: payee.name,
    payeeAddress: modern ? modernAddress(row) : payee.address,
    amount,
    expendedDate: getString(row, "Expended By Date", "Date Expended", "ExpndDate"),
    reportReceivedDate: getString(row, "Report Received Date", "RptRcvdDate"),
    expenditureType: modern ? getString(row, "ExpendedByType") : spender.type,
    expendingCommitteeName: modern ? getString(row, "ExpendedBy") : spender.committeeName,
    purpose: getString(row, "Purpose / Beneficiary", "Purpose", "Beneficiary"),
    candidateName: getString(row, "Candidate Name", "CandidateName"),
    officeDistrict: getString(row, "Office - District", "Office Being Sought", "OfficeDistrict"),
    supportOppose: parseSupportOppose(getString(row, "Supporting / Opposing", "SupportingOpposing")),
    ...modernReportFields(row),
    sourceUrl,
  };
}

export function parseIllinoisSbeContributionRecordsCsv(
  csv: string,
  sourceUrl = ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL
): IllinoisSbeContributionRecord[] {
  return validatedExportRows(csv, "contribution").map((row) => {
    const record = illinoisSbeContributionRecordFromRow(row, sourceUrl);
    if (!record) throw new Error("Illinois SBE contribution export has an invalid amount");
    return record;
  });
}

export function parseIllinoisSbeExpenditureRecordsCsv(
  csv: string,
  sourceUrl = ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL
): IllinoisSbeExpenditureRecord[] {
  return validatedExportRows(csv, "expenditure").map((row) => {
    const record = illinoisSbeExpenditureRecordFromRow(row, sourceUrl);
    if (!record) throw new Error("Illinois SBE expenditure export has an invalid amount");
    return record;
  });
}

export function hasIllinoisSbeExportCapWarning(text: string): boolean {
  return /maximum\s+number\s+of\s+records\s+available\s+for\s+download\s+is\s+25,?000/i.test(text);
}

export function getIllinoisSbeExportCapStatus(input: {
  csvRowCount: number;
  resultText?: string | null;
  cap?: number;
}): IllinoisSbeExportCapStatus {
  const cap = input.cap ?? ILLINOIS_SBE_EXPORT_ROW_CAP;
  const warningTextPresent = input.resultText ? hasIllinoisSbeExportCapWarning(input.resultText) : false;
  const rowCountReachedCap = input.csvRowCount >= cap;
  return {
    rowCount: input.csvRowCount,
    cap,
    capped: rowCountReachedCap || warningTextPresent,
    warningTextPresent,
    reason: rowCountReachedCap ? "row_count_reached_cap" : warningTextPresent ? "warning_text_present" : null,
  };
}

function parseIllinoisDate(value: string): Date | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function formatIllinoisDate(date: Date): string {
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export function splitIllinoisSbeDateWindow(
  window: IllinoisSbePartitionDateWindow
): [IllinoisSbePartitionDateWindow, IllinoisSbePartitionDateWindow] | null {
  const from = parseIllinoisDate(window.fromDate);
  const to = parseIllinoisDate(window.toDate);
  if (!from || !to || from.getTime() >= to.getTime()) {
    return null;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor((to.getTime() - from.getTime()) / dayMs);
  if (days < 1) {
    return null;
  }
  const midpoint = addUtcDays(from, Math.floor(days / 2));
  const secondStart = addUtcDays(midpoint, 1);
  if (secondStart.getTime() > to.getTime()) {
    return null;
  }
  return [
    { fromDate: formatIllinoisDate(from), toDate: formatIllinoisDate(midpoint) },
    { fromDate: formatIllinoisDate(secondStart), toDate: formatIllinoisDate(to) },
  ];
}

export function splitIllinoisSbeAmountWindow(
  window: IllinoisSbePartitionAmountWindow
): [IllinoisSbePartitionAmountWindow, IllinoisSbePartitionAmountWindow] | null {
  if (
    !Number.isFinite(window.minAmount) ||
    !Number.isFinite(window.maxAmount) ||
    window.minAmount < 0 ||
    window.maxAmount <= window.minAmount
  ) {
    return null;
  }
  const minCents = Math.round(window.minAmount * 100);
  const maxCents = Math.round(window.maxAmount * 100);
  if (maxCents - minCents < 1) {
    return null;
  }
  const midpointCents = Math.floor((minCents + maxCents) / 2);
  if (midpointCents < minCents || midpointCents >= maxCents) {
    return null;
  }
  return [
    { minAmount: minCents / 100, maxAmount: midpointCents / 100 },
    { minAmount: (midpointCents + 1) / 100, maxAmount: maxCents / 100 },
  ];
}

export function planIllinoisSbeExportPartitions(input: {
  csvRowCount: number;
  resultText?: string | null;
  cap?: number;
  fromDate?: string | null;
  toDate?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
}): IllinoisSbeExportPartitionPlan {
  const status = getIllinoisSbeExportCapStatus({
    csvRowCount: input.csvRowCount,
    resultText: input.resultText,
    cap: input.cap,
  });
  if (!status.capped) {
    return { status, strategy: null, partitions: null };
  }

  if (input.fromDate && input.toDate) {
    const datePartitions = splitIllinoisSbeDateWindow({
      fromDate: input.fromDate,
      toDate: input.toDate,
    });
    if (datePartitions) {
      return {
        status,
        strategy: "date",
        partitions: datePartitions.map((partition) => ({
          ...partition,
          ...(input.minAmount !== null && input.minAmount !== undefined ? { minAmount: input.minAmount } : {}),
          ...(input.maxAmount !== null && input.maxAmount !== undefined ? { maxAmount: input.maxAmount } : {}),
        })) as [IllinoisSbeExportPartitionWindow, IllinoisSbeExportPartitionWindow],
      };
    }
  }

  if (input.minAmount !== null && input.minAmount !== undefined && input.maxAmount !== null && input.maxAmount !== undefined) {
    const amountPartitions = splitIllinoisSbeAmountWindow({
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
    });
    if (amountPartitions) {
      return {
        status,
        strategy: "amount",
        partitions: amountPartitions.map((partition) => ({
          ...(input.fromDate ? { fromDate: input.fromDate } : {}),
          ...(input.toDate ? { toDate: input.toDate } : {}),
          ...partition,
        })) as [IllinoisSbeExportPartitionWindow, IllinoisSbeExportPartitionWindow],
      };
    }
  }

  return { status, strategy: null, partitions: null };
}
