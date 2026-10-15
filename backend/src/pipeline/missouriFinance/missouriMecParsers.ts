import { buildMissouriMecUrl, MISSOURI_MEC_PAGES } from "./missouriMecClient.js";

export const MISSOURI_MEC_PARSER_VERSION = 3;

const CANDIDATE_EXPORT_HEADER = [
  "MECID",
  "Committee Name",
  "Candidate Name",
  "Party",
  "Office Sought",
  "Status",
] as const;

export const MISSOURI_MEC_COMMITTEE_ACTIVITY_HEADER = [
  "Status Date",
  "MECID",
  "Committee Name",
  "Committee Type",
  "Committee Candidate",
  "Committee Status",
] as const;

export const MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER = [
  "MECID",
  "Committee",
  "Report",
  "Contributor-Committee",
  "Contributor-Company",
  "Contributor-Last Name",
  "Contributor-First Name",
  "Address1",
  "Address2",
  "City",
  "State",
  "Zip",
  "Employer",
  "Occupation",
  "Contribution Date",
  "Contribution Amount",
  "Monetary/In-Kind",
  "Committee",
] as const;

export const MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER = [
  "MECID",
  "Committee Name",
  "Report",
  "Expenditure-Last Name",
  "Expenditure-First Name",
  "Expenditure-Company",
  "Expenditure-Address1",
  "Expenditure-Address2",
  "Expenditure-City",
  "Expenditure-State",
  "Expenditure-Zip",
  "Expenditure Purpose",
  "Expenditure Date",
  "Expenditure Amount",
  "Expenditure Type",
] as const;

export const MISSOURI_MEC_OUTSIDE_SPENDING_EXPORT_HEADER = [
  "Candidates Name and Address",
  "Office Sought",
  "Support/Oppose",
  "Date",
  "Amount",
  "Reporting Committee",
  "Report",
] as const;

const MISSOURI_MEC_ID_PATTERN = /^[A-Z]\d{6}$/;

export type MissouriMecCandidateExportRow = {
  mecid: string;
  committeeName: string;
  candidateName: string;
  party: string | null;
  officeSought: string;
  status: string;
};

export type MissouriMecElectionHistoryRow = {
  electionDate: string;
  electionType: string;
  office: string;
  politicalSubdivision: string;
};

export type MissouriMecCommitteeInfo = {
  mecid: string;
  committeeName: string;
  candidateName: string;
  electionHistory: MissouriMecElectionHistoryRow[];
  sourceUrl: string;
};

export type MissouriMecCommitteeIdentity = {
  mecid: string;
  committeeName: string;
};

export type MissouriMecCommitteeActivityRow = {
  statusDate: string;
  /** Canonical committee MECID; exemption registrations end in E and cannot identify a spender committee. */
  mecid: string | null;
  committeeName: string;
  committeeType: string;
  committeeCandidate: string | null;
  committeeStatus: string;
};

export type MissouriMecSelectOption = {
  value: string;
  label: string;
  selected: boolean;
};

export type MissouriMecContributionRow = {
  mecid: string;
  committeeName: string;
  report: string;
  contributorCommittee: string | null;
  contributorCompany: string | null;
  contributorLastName: string | null;
  contributorFirstName: string | null;
  employer: string | null;
  occupation: string | null;
  contributionDate: string;
  amountCents: number;
  contributionKind: string;
  /** Verbatim final duplicate "Committee" column; its meaning is not inferred. */
  trailingCommitteeField?: string | null;
};

export type MissouriMecExpenditureRow = {
  mecid: string;
  committeeName: string;
  report: string;
  payeeLastName: string | null;
  payeeFirstName: string | null;
  payeeCompany: string | null;
  purpose: string | null;
  expenditureDate: string;
  amountCents: number;
  expenditureType: string;
};

export type MissouriMecOutsideSpendingRow = {
  candidateNameAndAddress: string;
  officeSought: string;
  supportOppose: "Support" | "Oppose";
  expenditureDate: string;
  amountCents: number;
  reportingCommittee: string;
  report: string;
};

export type MissouriMecOutsideSpenderIdentity = {
  reportingCommittee: string;
  mecid: string | null;
};

export type MissouriMecOutsideSpendingGridRow = MissouriMecOutsideSpendingRow & {
  committeeEventTarget: string;
};

export type MissouriMecOutsideSpendingGridPage = {
  currentPage: number;
  rows: MissouriMecOutsideSpendingGridRow[];
  nextPageEventTarget: string | null;
};

export type MissouriMecReportYear = {
  year: number;
  /** WebForms image-button name used to expand this year. */
  expandControlName: string;
};

export type MissouriMecReportInventoryRow = {
  reportId: string;
  report: string;
  dateFiled: string;
  isAmended: boolean;
  lineageKey: string;
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|nbsp|amp|lt|gt|quot|apos);/g,
    (entity, hex?: string, decimal?: string) => {
      if (hex !== undefined) {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      if (decimal !== undefined) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      switch (entity) {
        case "&nbsp;":
          return " ";
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default:
          return entity;
      }
    }
  );
}

function textContent(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** The result page's full-disclosure count controls export completeness, including zero. */
export function parseMissouriMecFullDisclosureCount(html: string): number {
  const text = textContent(html);
  const labels = [...text.matchAll(/Full Disclosure Reports\s*\(([^()]*)\)/gi)];
  if (labels.length === 0) throw new Error("Missing Missouri MEC full-disclosure result count");
  const counts = labels.map((label) => {
    const value = label[1]!.trim();
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) {
      throw new Error("Invalid Missouri MEC full-disclosure result count");
    }
    const count = Number(value.replace(/,/g, ""));
    if (!Number.isSafeInteger(count)) throw new Error("Invalid Missouri MEC full-disclosure result count");
    return count;
  });
  if (new Set(counts).size !== 1) throw new Error("Conflicting Missouri MEC full-disclosure result counts");
  return counts[0]!;
}

export function parseMissouriMecSelectOptions(html: string, controlId: string): MissouriMecSelectOption[] {
  const escapedId = controlId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const select = new RegExp(
    `<select\\b[^>]*id="[^"]*${escapedId}"[^>]*>([\\s\\S]*?)<\\/select>`,
    "i"
  ).exec(html);
  if (select === null) {
    return [];
  }
  return [...select[1]!.matchAll(/<option\b([^>]*)value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)].map(
    (match) => ({
      value: decodeHtmlEntities(match[2]!),
      label: textContent(match[3]!),
      selected: /\bselected(?:="selected")?/i.test(match[1]!),
    })
  );
}

function normalizeMecId(value: string): string {
  const mecid = value.trim().toUpperCase();
  if (!MISSOURI_MEC_ID_PATTERN.test(mecid)) {
    throw new Error("Invalid Missouri MECID in source");
  }
  return mecid;
}

function parseFirstHtmlTable(html: string): string[][] {
  const opening = /<table\b[^>]*>/i.exec(html);
  if (opening === null) {
    throw new Error("Missouri MEC export has no HTML table");
  }
  const rows: string[][] = [];
  let row: string[] | null = null;
  let cell: { tag: string; start: number } | null = null;
  const tags = /<(\/?)(table|tr|td|th)\b[^>]*>/gi;
  tags.lastIndex = opening.index + opening[0].length;
  for (;;) {
    const tag = tags.exec(html);
    if (tag === null) break;
    const closing = tag[1] === "/";
    const name = tag[2]!.toLowerCase();
    if (name === "table") {
      if (!closing || row !== null || cell !== null) break;
      return rows;
    }
    if (name === "tr") {
      if (cell !== null || (closing ? row === null : row !== null)) break;
      if (closing) {
        if (row!.length > 0) rows.push(row!);
        row = null;
      } else row = [];
    } else {
      if (row === null || (closing ? cell?.tag !== name : cell !== null)) break;
      if (closing) {
        row.push(textContent(html.slice(cell!.start, tag.index)));
        cell = null;
      } else cell = { tag: name, start: tags.lastIndex };
    }
  }
  throw new Error("Incomplete or malformed Missouri MEC export table");
}

function parseHtmlTableById(html: string, idSuffix: string, label: string): string[][] {
  const escapedId = idSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const table = new RegExp(`<table\\b[^>]*id="[^"]*${escapedId}"[^>]*>([\\s\\S]*?)<\\/table>`, "i").exec(html);
  if (!table) throw new Error(`Missouri MEC ${label} has no ${idSuffix} table`);
  const rows: string[][] = [];
  for (const row of table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => textContent(cell[1]!));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function nullableText(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function parseMecCurrencyCents(value: string, label: string): number {
  const normalized = value.trim();
  const match = /^(\()?(-)?\$((?:\d+|\d{1,3}(?:,\d{3})+))\.(\d{2})(\))?$/.exec(normalized);
  if (match === null || Boolean(match[1]) !== Boolean(match[5]) || (match[1] && match[2])) {
    throw new Error(`Invalid Missouri MEC ${label}`);
  }
  const whole = Number.parseInt(match[3]!.replace(/,/g, ""), 10);
  const cents = whole * 100 + Number.parseInt(match[4]!, 10);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Missouri MEC ${label} exceeds safe integer range`);
  }
  return match[1] || match[2] ? -cents : cents;
}

function parseMecTransactionDate(value: string, label: string): string {
  try {
    return normalizeMissouriMecElectionDate(value);
  } catch {
    throw new Error(`Invalid Missouri MEC ${label}`);
  }
}

function assertExportHeader(rows: readonly string[][], expected: readonly string[], label: string): void {
  const header = rows[0] ?? [];
  if (header.join("\u0000") !== expected.join("\u0000")) {
    throw new Error(`Unexpected Missouri MEC ${label} header`);
  }
}

export function parseMissouriMecContributionExport(html: string): MissouriMecContributionRow[] {
  const rows = parseFirstHtmlTable(html);
  assertExportHeader(rows, MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER, "contribution export");
  return rows.slice(1).map((row, index) => {
    if (row.length !== MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER.length) {
      throw new Error(`Unexpected Missouri MEC contribution export row ${index + 2}: ${row.length} columns`);
    }
    const [
      rawMecid,
      committeeName = "",
      report = "",
      contributorCommittee = "",
      contributorCompany = "",
      contributorLastName = "",
      contributorFirstName = "",
      ,
      ,
      ,
      ,
      ,
      employer = "",
      occupation = "",
      contributionDate = "",
      amount = "",
      contributionKind = "",
      trailingCommitteeField = "",
    ] = row;
    if (!committeeName || !report || !contributionKind) {
      throw new Error(`Incomplete Missouri MEC contribution export row ${index + 2}`);
    }
    return {
      mecid: normalizeMecId(rawMecid ?? ""),
      committeeName,
      report,
      contributorCommittee: nullableText(contributorCommittee),
      contributorCompany: nullableText(contributorCompany),
      contributorLastName: nullableText(contributorLastName),
      contributorFirstName: nullableText(contributorFirstName),
      employer: nullableText(employer),
      occupation: nullableText(occupation),
      contributionDate: parseMecTransactionDate(contributionDate, "contribution date"),
      amountCents: parseMecCurrencyCents(amount, "contribution amount"),
      contributionKind: contributionKind.trim(),
      trailingCommitteeField: nullableText(trailingCommitteeField),
    };
  });
}

export function parseMissouriMecExpenditureExport(html: string): MissouriMecExpenditureRow[] {
  const rows = parseFirstHtmlTable(html);
  assertExportHeader(rows, MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER, "expenditure export");
  return rows.slice(1).map((row, index) => {
    if (row.length !== MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER.length) {
      throw new Error(`Unexpected Missouri MEC expenditure export row ${index + 2}: ${row.length} columns`);
    }
    const [
      rawMecid,
      committeeName = "",
      report = "",
      payeeLastName = "",
      payeeFirstName = "",
      payeeCompany = "",
      ,
      ,
      ,
      ,
      ,
      purpose = "",
      expenditureDate = "",
      amount = "",
      expenditureType = "",
    ] = row;
    if (!committeeName || !report || !expenditureType) {
      throw new Error(`Incomplete Missouri MEC expenditure export row ${index + 2}`);
    }
    return {
      mecid: normalizeMecId(rawMecid ?? ""),
      committeeName,
      report,
      payeeLastName: nullableText(payeeLastName),
      payeeFirstName: nullableText(payeeFirstName),
      payeeCompany: nullableText(payeeCompany),
      purpose: nullableText(purpose),
      expenditureDate: parseMecTransactionDate(expenditureDate, "expenditure date"),
      amountCents: parseMecCurrencyCents(amount, "expenditure amount"),
      expenditureType: expenditureType.trim(),
    };
  });
}

export function parseMissouriMecOutsideSpendingExport(html: string): MissouriMecOutsideSpendingRow[] {
  const rows = parseFirstHtmlTable(html);
  assertExportHeader(rows, MISSOURI_MEC_OUTSIDE_SPENDING_EXPORT_HEADER, "outside-spending export");
  return rows.slice(1).map((row, index) => {
    if (row.length !== MISSOURI_MEC_OUTSIDE_SPENDING_EXPORT_HEADER.length) {
      throw new Error(`Unexpected Missouri MEC outside-spending export row ${index + 2}: ${row.length} columns`);
    }
    const [
      candidateNameAndAddress = "",
      officeSought = "",
      supportOppose = "",
      expenditureDate = "",
      amount = "",
      reportingCommittee = "",
      report = "",
    ] = row;
    if (
      !candidateNameAndAddress ||
      !officeSought ||
      !reportingCommittee ||
      !report ||
      (supportOppose !== "Support" && supportOppose !== "Oppose")
    ) {
      throw new Error(`Incomplete Missouri MEC outside-spending export row ${index + 2}`);
    }
    return {
      candidateNameAndAddress,
      officeSought,
      supportOppose,
      expenditureDate: parseMecTransactionDate(expenditureDate, "outside-spending date"),
      amountCents: parseMecCurrencyCents(amount, "outside-spending amount"),
      reportingCommittee,
      report,
    };
  });
}

function parseIndexedOutsideGridValues(html: string, label: string): Map<number, string> {
  const values = new Map<number, string>();
  const pattern = new RegExp(`grvExpenditures_${label}_(\\d+)"[^>]*>([\\s\\S]*?)<\\/span>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const index = Number.parseInt(match[1]!, 10);
    if (values.has(index)) throw new Error(`Duplicate Missouri MEC outside-spending grid ${label} row ${index}`);
    values.set(index, textContent(match[2]!));
  }
  return values;
}

export function parseMissouriMecOutsideSpendingGridPage(html: string): MissouriMecOutsideSpendingGridPage {
  const values = {
    candidateNameAndAddress: parseIndexedOutsideGridValues(html, "lblName"),
    officeSought: parseIndexedOutsideGridValues(html, "lblSought"),
    supportOppose: parseIndexedOutsideGridValues(html, "lblSupp"),
    expenditureDate: parseIndexedOutsideGridValues(html, "lblDate"),
    amount: parseIndexedOutsideGridValues(html, "lblAmount"),
    report: parseIndexedOutsideGridValues(html, "lblReport"),
  };
  const committeeLinks = new Map<number, { reportingCommittee: string; committeeEventTarget: string }>();
  for (const match of html.matchAll(
    /<a\b[^>]*id="[^"]*grvExpenditures_lbtnCommittee_(\d+)"[^>]*href="javascript:__doPostBack\(&#39;([^&]+)&#39;,&#39;&#39;\)"[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const index = Number.parseInt(match[1]!, 10);
    if (committeeLinks.has(index)) throw new Error(`Duplicate Missouri MEC outside-spending committee row ${index}`);
    committeeLinks.set(index, {
      committeeEventTarget: decodeHtmlEntities(match[2]!),
      reportingCommittee: textContent(match[3]!),
    });
  }
  const rowCount = values.candidateNameAndAddress.size;
  if (rowCount === 0) throw new Error("Missouri MEC outside-spending grid has no rows");
  for (const [label, rows] of Object.entries(values)) {
    if (rows.size !== rowCount) {
      throw new Error(`Misaligned Missouri MEC outside-spending grid: names=${rowCount}, ${label}=${rows.size}`);
    }
  }
  if (committeeLinks.size !== rowCount) {
    throw new Error(`Misaligned Missouri MEC outside-spending grid: names=${rowCount}, committees=${committeeLinks.size}`);
  }
  const rows: MissouriMecOutsideSpendingGridRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const committee = committeeLinks.get(index);
    const supportOppose = values.supportOppose.get(index);
    if (!committee || (supportOppose !== "Support" && supportOppose !== "Oppose")) {
      throw new Error(`Incomplete Missouri MEC outside-spending grid row ${index}`);
    }
    rows.push({
      candidateNameAndAddress: values.candidateNameAndAddress.get(index) ?? "",
      officeSought: values.officeSought.get(index) ?? "",
      supportOppose,
      expenditureDate: parseMecTransactionDate(values.expenditureDate.get(index) ?? "", "outside-spending date"),
      amountCents: parseMecCurrencyCents(values.amount.get(index) ?? "", "outside-spending amount"),
      reportingCommittee: committee.reportingCommittee,
      report: values.report.get(index) ?? "",
      committeeEventTarget: committee.committeeEventTarget,
    });
  }
  const currentPageText = /grvExpenditures_CurrentPage[^>]*>[\s\S]*?<font\b[^>]*>(\d+)<\/font>/i.exec(html)?.[1];
  const currentPage = Number.parseInt(currentPageText ?? "1", 10);
  const nextPageEventTarget = /<a\b[^>]*id="[^"]*grvExpenditures_lbtnNextPage"[^>]*href="javascript:__doPostBack\(&#39;([^&]+)&#39;,&#39;&#39;\)"/i.exec(html)?.[1] ?? null;
  return { currentPage, rows, nextPageEventTarget };
}

export function parseMissouriMecOutsideSpenderIdentities(body: string): MissouriMecOutsideSpenderIdentity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Invalid Missouri MEC outside-spender identity artifact JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("Invalid Missouri MEC outside-spender identity artifact shape");
  const names = new Set<string>();
  return parsed.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`Invalid Missouri MEC outside-spender identity row ${index}`);
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.reportingCommittee !== "string" ||
      !row.reportingCommittee.trim() ||
      (row.mecid !== null && typeof row.mecid !== "string")
    ) {
      throw new Error(`Invalid Missouri MEC outside-spender identity row ${index}`);
    }
    const reportingCommittee = row.reportingCommittee.trim().replace(/\s+/g, " ");
    if (names.has(reportingCommittee)) {
      throw new Error("Duplicate Missouri MEC outside-spender identity");
    }
    names.add(reportingCommittee);
    return { reportingCommittee, mecid: row.mecid === null ? null : normalizeMecId(row.mecid) };
  });
}

export function parseMissouriMecCommitteeActivityRows(html: string): MissouriMecCommitteeActivityRow[] {
  const rows = parseHtmlTableById(html, "gvAdvanced", "committee-activity results");
  assertExportHeader(rows, MISSOURI_MEC_COMMITTEE_ACTIVITY_HEADER, "committee-activity results");
  return rows.slice(1).map((row, index) => {
    if (row.length !== MISSOURI_MEC_COMMITTEE_ACTIVITY_HEADER.length) {
      throw new Error(`Unexpected Missouri MEC committee-activity row ${index + 2}: ${row.length} columns`);
    }
    const [statusDate = "", rawMecid = "", committeeName = "", committeeType = "", committeeCandidate = "", committeeStatus = ""] = row;
    if (!committeeName || !committeeType || !committeeStatus) {
      throw new Error(`Incomplete Missouri MEC committee-activity row ${index + 2}`);
    }
    const activityMecid = rawMecid.trim().toUpperCase();
    const mecid = MISSOURI_MEC_ID_PATTERN.test(activityMecid)
      ? activityMecid
      : /^[A-Z]\d{6}E$/.test(activityMecid) && committeeType === "Exemption"
        ? null
        : normalizeMecId(rawMecid);
    return {
      statusDate: parseMecTransactionDate(statusDate, "committee activity date"),
      mecid,
      committeeName,
      committeeType,
      committeeCandidate: nullableText(committeeCandidate),
      committeeStatus,
    };
  });
}

export function normalizeMissouriMecReportLineage(value: string): string {
  const normalized = value.trim().replace(/^AMENDED\s+/i, "").replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Missouri MEC report name is empty");
  }
  return normalized.toLocaleUpperCase("en-US");
}

export function parseMissouriMecReportYears(html: string): MissouriMecReportYear[] {
  const years = new Map<number, number>();
  for (const match of html.matchAll(/grvReportOutside_lblYear_(\d+)[^>]*>([\s\S]*?)<\/span>/gi)) {
    const index = Number.parseInt(match[1]!, 10);
    const year = Number.parseInt(textContent(match[2]!), 10);
    if (!Number.isInteger(year) || year < 1990 || year > 2100 || years.has(index)) {
      throw new Error(`Invalid Missouri MEC report-year row ${index}`);
    }
    years.set(index, year);
  }
  return [...years.entries()].sort((a, b) => a[0] - b[0]).map(([index, year]) => ({
    year,
    expandControlName: `grvReportOutside$ctl${String(index + 2).padStart(2, "0")}$ImgRptRight`,
  }));
}

export function parseMissouriMecReportInventory(html: string): MissouriMecReportInventoryRow[] {
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  const dates = new Map<string, string>();
  for (const match of html.matchAll(/grvReports_(\d+)_hlink_(\d+)"[^>]*data-CPID="(\d+)"/gi)) {
    const key = `${match[1]}:${match[2]}`;
    if (ids.has(key)) throw new Error(`Duplicate Missouri MEC report id row ${key}`);
    ids.set(key, match[3]!);
  }
  for (const match of html.matchAll(/grvReports_(\d+)_lblReport_(\d+)"[^>]*>([\s\S]*?)<\/span>/gi)) {
    const key = `${match[1]}:${match[2]}`;
    if (names.has(key)) throw new Error(`Duplicate Missouri MEC report-name row ${key}`);
    names.set(key, textContent(match[3]!));
  }
  for (const match of html.matchAll(/grvReports_(\d+)_lblDateReceived_(\d+)"[^>]*>([\s\S]*?)<\/span>/gi)) {
    const key = `${match[1]}:${match[2]}`;
    if (dates.has(key)) throw new Error(`Duplicate Missouri MEC report-date row ${key}`);
    dates.set(key, textContent(match[3]!));
  }
  if (ids.size === 0) {
    throw new Error("Missouri MEC expanded report inventory has no report rows");
  }
  if (ids.size !== names.size || ids.size !== dates.size) {
    throw new Error(`Misaligned Missouri MEC report inventory: ids=${ids.size}, names=${names.size}, dates=${dates.size}`);
  }
  return [...ids.keys()].sort((a, b) => {
    const [ag = 0, ar = 0] = a.split(":").map(Number);
    const [bg = 0, br = 0] = b.split(":").map(Number);
    return ag - bg || ar - br;
  }).map((key) => {
    const report = names.get(key) ?? "";
    if (!report || !dates.has(key)) throw new Error(`Incomplete Missouri MEC report inventory row ${key}`);
    return {
      reportId: ids.get(key)!,
      report,
      dateFiled: parseMecTransactionDate(dates.get(key)!, "report filed date"),
      isAmended: /^AMENDED\s+/i.test(report),
      lineageKey: normalizeMissouriMecReportLineage(report),
    };
  });
}

export type MissouriMecCandidateExportResult = {
  rows: MissouriMecCandidateExportRow[];
  sourceRowCount: number;
  excludedExemptionRegistrationCount: number;
};

export function parseMissouriMecCandidateExportWithDiagnostics(html: string): MissouriMecCandidateExportResult {
  const rows = parseFirstHtmlTable(html);
  const header = rows[0] ?? [];
  if (header.join("\u0000") !== CANDIDATE_EXPORT_HEADER.join("\u0000")) {
    throw new Error("Unexpected Missouri MEC candidate export header");
  }

  const candidates: MissouriMecCandidateExportRow[] = [];
  let excludedExemptionRegistrationCount = 0;
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== CANDIDATE_EXPORT_HEADER.length) {
      throw new Error(`Unexpected Missouri MEC candidate export row ${index + 2}: ${row.length} columns`);
    }
    const [rawMecid, committeeName = "", candidateName = "", party = "", officeSought = "", status = ""] = row;
    if (!committeeName || !candidateName || !officeSought || !status) {
      throw new Error(`Incomplete Missouri MEC candidate export row ${index + 2}`);
    }
    const normalizedMecid = (rawMecid ?? "").trim().toUpperCase();
    // MEC includes candidate exemption registrations in this export. Their
    // C######E identifiers are not committee identities and CommInfo cannot
    // resolve them, so retain them only in source-count reconciliation.
    if (/^C\d{6}E$/.test(normalizedMecid)) {
      excludedExemptionRegistrationCount += 1;
      continue;
    }
    candidates.push({
      mecid: normalizeMecId(rawMecid ?? ""),
      committeeName,
      candidateName,
      party: party || null,
      officeSought,
      status,
    });
  }
  return {
    rows: candidates,
    sourceRowCount: rows.length - 1,
    excludedExemptionRegistrationCount,
  };
}

export function parseMissouriMecCandidateExport(html: string): MissouriMecCandidateExportRow[] {
  return parseMissouriMecCandidateExportWithDiagnostics(html).rows;
}

function parseSpanText(html: string, label: string): string {
  const pattern = new RegExp(`id="[^"]*${label}"[^>]*>([\\s\\S]*?)<\\/span>`, "i");
  return textContent(pattern.exec(html)?.[1] ?? "");
}

function parseHistorySeries(html: string, label: string): string[] {
  const pattern = new RegExp(
    `id="[^"]*gvElecHistory_${label}_(\\d+)"[^>]*>([\\s\\S]*?)<\\/span>`,
    "gi"
  );
  const byIndex = new Map<number, string>();
  for (const match of html.matchAll(pattern)) {
    const index = Number.parseInt(match[1]!, 10);
    if (byIndex.has(index)) {
      throw new Error(`Duplicate Missouri MEC election-history ${label} row ${index}`);
    }
    byIndex.set(index, textContent(match[2]!));
  }
  return [...byIndex.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
}

export function normalizeMissouriMecElectionDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid Missouri MEC election date: ${value}`);
  }
  const month = Number.parseInt(match[1]!, 10);
  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid Missouri MEC election date: ${value}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseMissouriMecCommitteeInfo(html: string): MissouriMecCommitteeInfo {
  const { mecid, committeeName } = parseMissouriMecCommitteeIdentity(html);
  const candidateName = parseSpanText(html, "lblCandName");
  if (!committeeName || !candidateName) {
    throw new Error("Incomplete Missouri MEC committee profile");
  }

  const dates = parseHistorySeries(html, "lblElecYear");
  const types = parseHistorySeries(html, "lblElectionType");
  const offices = parseHistorySeries(html, "lblSub");
  const subdivisions = parseHistorySeries(html, "lblPolSub");
  if (
    dates.length === 0 ||
    dates.length !== types.length ||
    dates.length !== offices.length ||
    dates.length !== subdivisions.length
  ) {
    throw new Error(
      `Misaligned Missouri MEC election history: dates=${dates.length}, types=${types.length}, offices=${offices.length}, subdivisions=${subdivisions.length}`
    );
  }

  return {
    mecid,
    committeeName,
    candidateName,
    electionHistory: dates.map((electionDate, index) => {
      const electionType = types[index] ?? "";
      const office = offices[index] ?? "";
      const politicalSubdivision = subdivisions[index] ?? "";
      if (!electionType || !office) {
        throw new Error(`Incomplete Missouri MEC election-history row ${index + 1}`);
      }
      return {
        electionDate: normalizeMissouriMecElectionDate(electionDate),
        electionType,
        office,
        politicalSubdivision,
      };
    }),
    sourceUrl: buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeInfo, { MECID: mecid }),
  };
}

export function parseMissouriMecCommitteeIdentity(html: string): MissouriMecCommitteeIdentity {
  const mecid = normalizeMecId(parseSpanText(html, "lblMECID"));
  const committeeName = parseSpanText(html, "lblCommName");
  if (!committeeName) throw new Error("Incomplete Missouri MEC committee identity");
  return { mecid, committeeName };
}
