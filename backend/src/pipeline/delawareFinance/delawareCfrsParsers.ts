// Delaware CFRS artifact parsers (docs/plans/plan-delaware-finance.md).
//
// Every shape here was pinned from live portal responses on 2026-08-26:
// - Receipts/expenses CSV exports are NOT RFC CSV: fields are never quoted
//   and never contain commas or newlines (verified across 8,758 live rows —
//   every physical line naive-splits to exactly the same field count), and a
//   double quote is a literal data character ("Kevin O"Connell" appears in
//   Meyer's receipts). Parsing is therefore a literal line/comma split with
//   NO quote semantics — an RFC parser corrupts on the stray quote. The
//   fixed per-line field count is the fail-closed guard: if the portal ever
//   emits an embedded comma the count changes and the row lands in
//   malformedRowCount (and the count==total gates catch it).
// - The header line ends with a dangling comma (a final empty header cell).
//   Receipt data rows do NOT echo the empty cell; expense data rows DO.
// - Amounts are plain unformatted decimals with four decimal places
//   ("500.0000"); parsing fails closed on anything that cannot be
//   represented exactly in integer cents.
// - Grid JSON endpoints answer { data: [...], total: N } — but `total` is
//   unstable on the transaction grids (probe-verified), so only the
//   committee/filed-report grids trust it and the CSV is the transaction
//   source of truth.
// - Report PDFs are generated (not scanned) CFFM011 documents; the
//   STATEMENT OF ACCOUNT BALANCE page carries beginning balance, receipts,
//   expenditures, and ending balance. Extraction is self-validating: a
//   result is returned only when beginning + receipts − expenditures =
//   ending holds exactly.
// PII: receipt rows carry contributor street addresses — callers never log
// or persist address fields (plan privacy rules).

type CsvObject = Record<string, string>;

export class DelawareCfrsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelawareCfrsParseError";
  }
}

// --- CSV exports -----------------------------------------------------------

/** Pinned live 2026-08-26: receipts export header (the trailing empty cell is dropped). */
export const DELAWARE_RECEIPT_CSV_COLUMNS = [
  "Contribution Date",
  "Contributor Name",
  "Contributor Address Line 1",
  "Contributor Address Line 2",
  "Contributor City",
  "Contributor State",
  "Contributor Zip",
  "Contributor Type",
  "Employer Name",
  "Employer Occupation",
  "Contribution Type",
  "Contribution Amount",
  "CF_ID",
  "Receiving Committee",
  "Filing Period",
  "Office",
  "Fixed Asset",
] as const;

/** Pinned live 2026-08-26: expenses export header (the trailing empty cell is dropped). */
export const DELAWARE_EXPENSE_CSV_COLUMNS = [
  "Expenditure Date",
  "Payee Name",
  "Payee Address Line 1",
  "Payee Address Line 2",
  "Payee City",
  "Payee State",
  "Payee Zip",
  "Payee Type",
  "Amount($)",
  "CF ID",
  "Committee Name",
  "Expense Category",
  "Expense Purpose",
  "Expense Method",
  "Filing Period",
  "Fixed Asset",
] as const;

export type DelawareReceiptCsvRow = Record<(typeof DELAWARE_RECEIPT_CSV_COLUMNS)[number], string>;
export type DelawareExpenseCsvRow = Record<(typeof DELAWARE_EXPENSE_CSV_COLUMNS)[number], string>;

/** Actual third-party funder export, observed 2026-10-11; not candidate receipts. */
export const DELAWARE_THIRD_PARTY_RECEIPT_CSV_COLUMNS = [
  "Contribution Date", "Contributor Name", "Contributor Address", "Employer Name",
  "Filed Reports", "Employer Occupation", "Contribution Amount", "Receiving Committee",
] as const;
export type DelawareThirdPartyReceiptCsvRow = Record<(typeof DELAWARE_THIRD_PARTY_RECEIPT_CSV_COLUMNS)[number], string>;

/** The aggregate pseudo-contributor rows that itemize sub-$100 money in bulk. */
export const DELAWARE_SUB_100_AGGREGATE_TYPE = "Total of Contributions not exceeding $100";

/**
 * Literal line/comma split — no quote semantics (see the header note). The
 * header must match the pinned column list exactly (modulo the dangling
 * trailing empty cell); data rows must have exactly the named-column count,
 * or that count plus one trailing empty cell. Anything else is counted
 * malformed and the caller's count==total gate fails closed.
 */
function parseDelawareCsv(
  text: string,
  columns: readonly string[],
  what: string
): { rows: CsvObject[]; malformedRowCount: number } {
  if (text.trim() === "") {
    throw new DelawareCfrsParseError(`${what} CSV is empty`);
  }
  const lines = text.split(/\r?\n/);
  let headerCells: string[] | null = null;
  const rows: CsvObject[] = [];
  let malformedRowCount = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    let cells = line.split(",");
    if (cells.length === columns.length + 1 && (cells[columns.length] ?? "").trim() === "") {
      cells = cells.slice(0, columns.length);
    }
    if (headerCells === null) {
      headerCells = cells.map((cell) => cell.replace(/^\uFEFF/, "").trim());
      if (headerCells.length !== columns.length || columns.some((column, index) => headerCells![index] !== column)) {
        throw new DelawareCfrsParseError(
          `${what} CSV header drift: expected [${columns.join(", ")}], got [${headerCells.join(", ")}]`
        );
      }
      continue;
    }
    if (cells.length !== columns.length) {
      malformedRowCount += 1;
      continue;
    }
    const row: CsvObject = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]!] = cells[index]!.trim();
    }
    rows.push(row);
  }
  if (headerCells === null) {
    throw new DelawareCfrsParseError(`${what} CSV is empty`);
  }
  return { rows, malformedRowCount };
}

export function parseDelawareReceiptsCsv(text: string): {
  rows: DelawareReceiptCsvRow[];
  malformedRowCount: number;
} {
  const parsed = parseDelawareCsv(text, DELAWARE_RECEIPT_CSV_COLUMNS, "receipts");
  return { rows: parsed.rows as unknown as DelawareReceiptCsvRow[], malformedRowCount: parsed.malformedRowCount };
}

export function parseDelawareExpensesCsv(text: string): {
  rows: DelawareExpenseCsvRow[];
  malformedRowCount: number;
} {
  const parsed = parseDelawareCsv(text, DELAWARE_EXPENSE_CSV_COLUMNS, "expenses");
  return { rows: parsed.rows as unknown as DelawareExpenseCsvRow[], malformedRowCount: parsed.malformedRowCount };
}

/** No contributor class or public CF_ID is published in this export. */
export function parseDelawareThirdPartyReceiptsCsv(text: string): {
  rows: DelawareThirdPartyReceiptCsvRow[];
  malformedRowCount: number;
} {
  const parsed = parseDelawareCsv(text, DELAWARE_THIRD_PARTY_RECEIPT_CSV_COLUMNS, "third-party receipts");
  return { rows: parsed.rows as unknown as DelawareThirdPartyReceiptCsvRow[], malformedRowCount: parsed.malformedRowCount };
}

// --- Amounts ---------------------------------------------------------------

/**
 * Parses a CFRS decimal amount ("500.0000", "-63.1800") to exact integer
 * cents. Fails closed on grouping commas, currency symbols, or sub-cent
 * precision that is not zero — those would mean silent value drift.
 */
export function parseDelawareAmountCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new DelawareCfrsParseError(`unparseable CFRS amount: "${value}"`);
  }
  const [, sign, whole, fractionRaw] = match;
  const fraction = (fractionRaw ?? "").padEnd(2, "0");
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) {
    throw new DelawareCfrsParseError(`CFRS amount has non-zero sub-cent precision: "${value}"`);
  }
  const cents = Number.parseInt(whole!, 10) * 100 + Number.parseInt(fraction.slice(0, 2), 10);
  if (!Number.isSafeInteger(cents)) {
    throw new DelawareCfrsParseError(`CFRS amount out of safe range: "${value}"`);
  }
  return sign === "-" ? -cents : cents;
}

/**
 * "$243,160.00" / "($12.34)" on report-PDF pages -> signed integer cents;
 * null when not currency. Strict on shape — parentheses must balance and
 * comma groups must be real thousands groups — so a layout drift that mashes
 * tokens together ("$12.34)", "$1,,2.00") is never counted as an amount.
 */
export function parseDelawareCurrencyCents(value: string): number | null {
  const match = /^(?:-?\$(?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2}|\(-?\$(?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2}\))$/.exec(
    value.trim()
  );
  if (match === null) {
    return null;
  }
  const cents = Math.round(Number.parseFloat(value.replace(/[$,()]/g, "")) * 100);
  return value.trim().startsWith("(") || value.includes("-") ? -Math.abs(cents) : cents;
}

// --- Search-results page ---------------------------------------------------

/**
 * The stored-search row count as rendered in the results page's Telerik grid
 * config: jQuery('#<gridId>').tGrid({... total:N ...}). This count matched
 * the CSV export's row count exactly on every probe query — it is the page's
 * only trustworthy total (the grid JSON endpoints' `total` is unstable).
 */
export function extractDelawareGridTotal(html: string, gridId = "Grid"): number | null {
  const start = html.indexOf(`jQuery('#${gridId}').tGrid(`);
  if (start === -1) {
    return null;
  }
  const window = html.slice(start, start + 4_000);
  const match = /total:(\d+)/.exec(window);
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

// --- Grid JSON endpoints ---------------------------------------------------

/** "/Date(1704171600000)/" -> epoch milliseconds; null for anything else. */
export function parseDelawareJsonDateMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

export type DelawareCommitteeGridRow = {
  memberId: number;
  /** Public committee id ("CF ID", e.g. "01005311"); "" when the portal left it blank. */
  cfId: string;
  committeeName: string;
  committeeTypeCode: string;
  committeeType: string;
  committeeStatus: string;
  officeSought: string;
  districtName: string;
  county: string;
  registeredDate: string;
  formType: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validates one /Public/_ViewCommittees data row; throws on shape drift. */
function parseCommitteeGridRow(row: unknown, index: number): DelawareCommitteeGridRow {
  if (typeof row !== "object" || row === null) {
    throw new DelawareCfrsParseError(`committee grid row ${index} is not an object`);
  }
  const record = row as Record<string, unknown>;
  const memberId = record.MemberID;
  if (typeof memberId !== "number" || !Number.isSafeInteger(memberId) || memberId <= 0) {
    throw new DelawareCfrsParseError(`committee grid row ${index} has no numeric MemberID`);
  }
  const committeeName = asString(record.CommitteeName);
  if (committeeName === "") {
    throw new DelawareCfrsParseError(`committee grid row ${index} (MemberID ${memberId}) has no CommitteeName`);
  }
  return {
    memberId,
    cfId: asString(record.Committee_Id),
    committeeName,
    committeeTypeCode: asString(record.CommitteeTypeCode),
    committeeType: asString(record.CommitteeType),
    committeeStatus: asString(record.CommitteeStatus),
    officeSought: asString(record.OfficeSought),
    districtName: asString(record.DistrictName),
    county: asString(record.County),
    registeredDate: asString(record.RegisteredDateStr),
    formType: asString(record.Formtype),
  };
}

export function parseDelawareCommitteeGridJson(text: string): {
  rows: DelawareCommitteeGridRow[];
  total: number | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DelawareCfrsParseError("committee grid response is not JSON");
  }
  const envelope = parsed as { data?: unknown; total?: unknown };
  if (!Array.isArray(envelope.data)) {
    throw new DelawareCfrsParseError("committee grid response has no data array");
  }
  return {
    rows: envelope.data.map((row, index) => parseCommitteeGridRow(row, index)),
    total: typeof envelope.total === "number" ? envelope.total : null,
  };
}

export type DelawareFiledReportRow = {
  filingPeriodName: string;
  /** Grid "Filing Method" cell text — e.g. "Original Financial Statement", "Amended Financial Statement". */
  reportName: string;
  /** Public committee id — the grid's "CF ID" column. */
  cfId: string;
  committeeName: string;
  committeeType: string;
  /** MM/DD/YYYY as rendered; "" when blank. */
  dateFiled: string;
  filingYear: string;
  office: string;
  committeeStatus: string;
  /** downloadReport(...) args; null when the row has no attached document. */
  document: { publicReportFileName: string; memberId: number; filingCalendarId: number } | null;
};

/**
 * Parses the filed-reports grid from a rendered View Filed Reports page.
 * The grid is NOT ajax-JSON: telerik's server operation mode navigates to
 * /Public/_ViewFiledReports?ajax=True&Grid-page=…&Grid-size=… which returns
 * the FULL page with the requested slice rendered in the grid's <tbody>
 * (verified live 2026-08-26; Grid-size=200 renders every row of a 20-row
 * result). Row cells: Filing Period | Filing Method (anchor with
 * downloadReport(&#39;file&#39;,&#39;memberId&#39;,&#39;filingCalendarId&#39;))
 * | CF ID | Committee Name | Committee Type | Report Filed Date |
 * Reporting Year | Office | Status.
 */
export function parseDelawareFiledReportsHtml(html: string): {
  rows: DelawareFiledReportRow[];
  total: number | null;
} {
  const total = extractDelawareGridTotal(html);
  const gridStart = html.indexOf("jQuery('#Grid').tGrid(");
  if (gridStart === -1) {
    throw new DelawareCfrsParseError("filed-reports page has no #Grid config (layout drift?)");
  }
  // Scope the row search to the grid's own markup: the live page renders the
  // Telerik wrapper <div class="t-widget t-grid" id="Grid"> around the grid
  // table (verified 2026-08-27; the #Grid script config sits in the head,
  // far before the table), so a layout table's tbody earlier in the page can
  // never be mistaken for the report rows. When the wrapper is absent
  // (sanitized fixtures), fall back to the whole page — the fixed cell-count
  // and total checks below still guard that path.
  const gridWrapper = /<div[^>]*\bid="Grid"[^>]*>/.exec(html);
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(gridWrapper === null ? html : html.slice(gridWrapper.index));
  if (body === null) {
    // A zero-result search renders no tbody; trust the grid total for that.
    if (total === 0) {
      return { rows: [], total };
    }
    throw new DelawareCfrsParseError("filed-reports page has no grid tbody");
  }
  const rows: DelawareFiledReportRow[] = [];
  for (const rowMatch of body[1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cellsHtml = [...rowMatch[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]!);
    if (cellsHtml.length < 9) {
      continue;
    }
    const cells = cellsHtml.map((cell) => stripTags(cell));
    const documentMatch = /downloadReport\(&#39;([^&]+)&#39;,&#39;(\d+)&#39;,&#39;(\d+)&#39;\)/.exec(cellsHtml[1]!);
    rows.push({
      filingPeriodName: cells[0]!,
      reportName: cells[1]!,
      cfId: cells[2]!,
      committeeName: cells[3]!,
      committeeType: cells[4]!,
      dateFiled: cells[5]!,
      filingYear: cells[6]!,
      office: cells[7]!,
      committeeStatus: cells[8]!,
      document:
        documentMatch === null
          ? null
          : {
              publicReportFileName: documentMatch[1]!,
              memberId: Number.parseInt(documentMatch[2]!, 10),
              filingCalendarId: Number.parseInt(documentMatch[3]!, 10),
            },
    });
  }
  if (rows.length === 0 && total !== 0) {
    throw new DelawareCfrsParseError("filed-reports grid tbody present but no rows parsed (layout drift?)");
  }
  return { rows, total };
}

// --- Registrant autocomplete ----------------------------------------------

export type DelawareRegistrantSuggestion = { name: string; status: string; memberId: number };

/** "Meyer for Delaware(Active)|558171" lines from /Public/FindRegistrants. */
export function parseDelawareRegistrantSuggestions(text: string): DelawareRegistrantSuggestion[] {
  const suggestions: DelawareRegistrantSuggestion[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const match = /^(.*)\(([^()]*)\)\|(\d+)$/.exec(trimmed);
    if (match === null) {
      throw new DelawareCfrsParseError(`unparseable registrant suggestion line: "${trimmed}"`);
    }
    suggestions.push({
      name: match[1]!.trim(),
      status: match[2]!.trim(),
      memberId: Number.parseInt(match[3]!, 10),
    });
  }
  return suggestions;
}

// --- Statement-of-organization affiliation table ---------------------------

export type DelawareTpAffiliationRow = {
  candidateCommitteeName: string;
  candidateName: string;
  officeSought: string;
  party: string;
  position: string;
  status: string;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * The "Affiliated Candidate Information" table on a 3rd-party advertiser's
 * statement of organization (/Public/ShowReview). Returns [] when the portal
 * renders "No records to view." — a registered TP advertiser with no declared
 * candidate affiliations (a real case: DLGA PAC, memberID 643731). Throws
 * when the section itself is missing — that is drift, not an empty table.
 */
export function parseDelawareTpAffiliations(html: string): DelawareTpAffiliationRow[] {
  const sectionStart = html.search(/Affiliated\s+Candidate\s+Information/i);
  if (sectionStart === -1) {
    throw new DelawareCfrsParseError("ShowReview page has no Affiliated Candidate Information section");
  }
  // The section is bounded by the next SO section heading.
  const sectionEnd = html.slice(sectionStart).search(/Name\s+of\s+Party\s+if\s+entire\s+ticket/i);
  const section = sectionEnd === -1 ? html.slice(sectionStart) : html.slice(sectionStart, sectionStart + sectionEnd);
  if (/No\s+records\s+to\s+view/i.test(section)) {
    return [];
  }
  const rows: DelawareTpAffiliationRow[] = [];
  for (const rowMatch of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => stripTags(cell[1]!));
    if (cells.length < 6) {
      continue;
    }
    // Skip the header row and pager rows.
    if (/candidate\s+committee\s+name/i.test(cells[0] ?? "") || /displaying\s+page/i.test(cells[0] ?? "")) {
      continue;
    }
    const position = (cells[4] ?? "").trim();
    if (position !== "Support" && position !== "Oppose") {
      throw new DelawareCfrsParseError(
        `TP affiliation row has unexpected Position "${position}" (expected Support|Oppose)`
      );
    }
    rows.push({
      candidateCommitteeName: cells[0]!,
      candidateName: cells[1]!,
      officeSought: cells[2]!,
      party: cells[3]!,
      position,
      status: cells[5]!,
    });
  }
  if (rows.length === 0) {
    throw new DelawareCfrsParseError(
      "Affiliated Candidate Information section present but no data rows parsed (layout drift?)"
    );
  }
  return rows;
}

// --- Report-PDF cover (STATEMENT OF ACCOUNT BALANCE) -----------------------

export type DelawareReportCover = {
  pageNumber: number;
  beginningBalanceCents: number;
  /** Line 2E "SUBTOTAL (Total of A,B,C,D)" — itemized + in-kind + loans + reimbursements. */
  receiptsCents: number;
  /** Line 3J "SUBTOTAL (Total of F,G,H,I)". */
  expendituresCents: number;
  endingBalanceCents: number;
  /** "REPORTING PERIOD : <from> TO <to>" as printed (MM/DD/YYYY); null when absent. */
  reportingPeriodFrom: string | null;
  reportingPeriodTo: string | null;
  /** Literal footer label; not independently proved report amendment authority. */
  documentVersion: number | null;
  /** How the values were located — "rows" (label-aligned) or "sequence" (reading order). */
  method: "rows" | "sequence";
};

type PdfTextRow = { y: number; texts: string[] };

async function extractPdfPageRows(data: Uint8Array): Promise<PdfTextRow[][]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data });
  const pdf = await loadingTask.promise;
  try {
    const pages: PdfTextRow[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const rows: { y: number; cells: { x: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!("str" in item)) {
          continue;
        }
        const text = item.str.replace(/\s+/g, " ").trim();
        if (text === "") {
          continue;
        }
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2);
        if (row === undefined) {
          row = { y, cells: [] };
          rows.push(row);
        }
        row.cells.push({ x, text });
      }
      rows.sort((left, right) => right.y - left.y);
      pages.push(
        rows.map((row) => ({
          y: row.y,
          texts: row.cells.sort((left, right) => left.x - right.x).map((cell) => cell.text),
        }))
      );
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}

function currencyTokens(texts: readonly string[]): number[] {
  const values: number[] = [];
  for (const text of texts) {
    // A cell may hold several amounts ("$0.00 $243,160.00").
    for (const token of text.split(/\s+/)) {
      const cents = parseDelawareCurrencyCents(token);
      if (cents !== null) {
        values.push(cents);
      }
    }
  }
  return values;
}

function findLabeledAmount(rows: readonly PdfTextRow[], label: RegExp): number | null {
  for (const row of rows) {
    if (label.test(row.texts.join(" "))) {
      const amounts = currencyTokens(row.texts);
      if (amounts.length === 1) {
        return amounts[0]!;
      }
    }
  }
  return null;
}

/**
 * Locates the STATEMENT OF ACCOUNT BALANCE page and extracts the four core
 * lines. Self-validating: a result is returned ONLY when
 * beginning + receipts − expenditures = ending holds exactly — otherwise the
 * extraction fails closed with the page's currency tokens in the message.
 *
 * Layout pinned from a live CFFM011 page dump (2026-08-26): each line's label
 * and dollar value share a y-row (±2pt). The four canonical lines are
 * line 1 "BEGINNING BALANCE", line 2E "SUBTOTAL (Total of A,B,C,D)" (the
 * receipts total — "2. RECEIPTS :" itself is a bare section heading),
 * line 3J "SUBTOTAL (Total of F,G,H,I)", and line 4 "ENDING BALANCE".
 * A reading-order fallback (first amount = beginning; the receipts/
 * expenditures/ending recap ends the sequence before the lines 5-7 zeros)
 * exists for template variants, still behind the same identity check.
 */
export async function extractDelawareReportCover(pdfBytes: Uint8Array): Promise<DelawareReportCover> {
  const pages = await extractPdfPageRows(pdfBytes);
  const fullText = pages
    .map((rows) => rows.map((row) => row.texts.join(" ")).join(" "))
    .join(" ");
  const versionMatch = /Document:\s*\d+\s*Version:\s*(\d+)/.exec(fullText);
  const documentVersion = versionMatch === null ? null : Number.parseInt(versionMatch[1]!, 10);

  for (let index = 0; index < pages.length; index += 1) {
    const rows = pages[index]!;
    const pageText = rows.map((row) => row.texts.join(" ")).join(" ");
    if (!/STATEMENT\s+OF\s+ACCOUNT\s+BALANCE/i.test(pageText)) {
      continue;
    }
    const identityHolds = (beginning: number, receipts: number, expenditures: number, ending: number): boolean =>
      beginning + receipts - expenditures === ending;

    // "REPORTING PERIOD : 01/01/2025 ... TO ... 12/31/2025" — the FROM/TO
    // dates are the first two dates at or after the label in reading order.
    let reportingPeriodFrom: string | null = null;
    let reportingPeriodTo: string | null = null;
    const periodIndex = pageText.search(/REPORTING\s+PERIOD/i);
    if (periodIndex !== -1) {
      const dates = [...pageText.slice(periodIndex).matchAll(/\d{2}\/\d{2}\/\d{4}/g)].map((match) => match[0]);
      reportingPeriodFrom = dates[0] ?? null;
      reportingPeriodTo = dates[1] ?? null;
    }

    const shared = { pageNumber: index + 1, reportingPeriodFrom, reportingPeriodTo, documentVersion };

    // Line-number anchors matter: line 1 reads "BEGINNING BALANCE (Ending
    // Balance from last reporting period)" and line 4 reads "ENDING BALANCE
    // (Beginning Balance plus 2E minus 3J)" — an unanchored BEGINNING/ENDING
    // match hits the wrong line's parenthetical.
    const labeled = {
      beginning: findLabeledAmount(rows, /(?:^|\s)1\.\s*BEGINNING\s+BALANCE/i),
      receipts: findLabeledAmount(rows, /SUBTOTAL\s*\(\s*Total\s+of\s+A\s*,\s*B\s*,\s*C\s*,\s*D\s*\)/i),
      expenditures: findLabeledAmount(rows, /SUBTOTAL\s*\(\s*Total\s+of\s+F\s*,\s*G\s*,\s*H\s*,\s*I\s*\)/i),
      ending: findLabeledAmount(rows, /(?:^|\s)4\.\s*ENDING\s+BALANCE/i),
    };
    if (
      labeled.beginning !== null &&
      labeled.receipts !== null &&
      labeled.expenditures !== null &&
      labeled.ending !== null &&
      identityHolds(labeled.beginning, labeled.receipts, labeled.expenditures, labeled.ending)
    ) {
      return {
        ...shared,
        beginningBalanceCents: labeled.beginning,
        receiptsCents: labeled.receipts,
        expendituresCents: labeled.expenditures,
        endingBalanceCents: labeled.ending,
        method: "rows",
      };
    }

    const sequence = rows.flatMap((row) => currencyTokens(row.texts));
    if (sequence.length >= 4) {
      // Lines 5-7 (non-cash assets, disposed assets, loan balance) trail the
      // ending balance; strip trailing zeros before applying the recap rule.
      const trimmed = [...sequence];
      while (trimmed.length > 4 && trimmed[trimmed.length - 1] === 0) {
        trimmed.pop();
      }
      const beginning = trimmed[0]!;
      const receipts = trimmed[trimmed.length - 3]!;
      const expenditures = trimmed[trimmed.length - 2]!;
      const ending = trimmed[trimmed.length - 1]!;
      if (trimmed.length >= 4 && identityHolds(beginning, receipts, expenditures, ending)) {
        return {
          ...shared,
          beginningBalanceCents: beginning,
          receiptsCents: receipts,
          expendituresCents: expenditures,
          endingBalanceCents: ending,
          method: "sequence",
        };
      }
    }
    throw new DelawareCfrsParseError(
      `STATEMENT OF ACCOUNT BALANCE page ${index + 1} found but the cash identity does not hold ` +
        `for any extraction strategy (currency tokens in reading order: [${rows
          .flatMap((row) => currencyTokens(row.texts))
          .join(", ")}] cents)`
    );
  }
  throw new DelawareCfrsParseError("no STATEMENT OF ACCOUNT BALANCE page in the report PDF");
}
