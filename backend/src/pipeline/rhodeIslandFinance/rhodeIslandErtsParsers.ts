// Parsers for the Rhode Island ERTS portal (ricampaignfinance.com). Every
// parser is fail-closed (docs/plans/rhode_island_plan.md decision 3): a page or export
// that does not match the pinned shape throws or classifies as unreadable
// instead of yielding partial rows. The shapes here were proven live by the
// PR 3 acquisition spike (`src/scripts/probeRhodeIslandCandidateFinance.ts`,
// 7/7 gates on 2026-08-13) and are pinned against trimmed fixtures in
// backend/tests/fixtures/rhodeIslandFinance/.
//
// The portal is an ASP.NET WebForms app (v 20201012.1). It never 404s a bad
// search: it answers 200 with a redirect back to the search page, so grid
// markers — never the HTTP status — decide whether a body is data.

// Bumped whenever a pinned vocabulary or an output field changes, so cached
// artifacts validated under an older version re-validate instead of being
// trusted (north carolina cache discipline).
export const RHODE_ISLAND_ERTS_PARSER_VERSION = 4;

// Base of every public portal route. Lives here (not the client) because the
// CF-8 index parser must absolutize relative `/ReportsScanned/` links.
export const ERTS_PUBLIC_BASE_URL = "https://www.ricampaignfinance.com/RIPublic/";

// Contribution-type codes on `lstContributionType` (Contributions.aspx, read
// live 2026-08-13). Pinned so decision 13's mapping table can be checked
// against the live vocabulary; `0` means "all types". NOTE (spike result 5b):
// the summary-groupings vocabulary is WIDER than this list — `NSF Check` and
// `Refund of Contribution` render as parenthesized negatives with no search
// code — so an absent label is not automatically an error; it just cannot be
// proven summary-only by a typed search.
export const ERTS_CONTRIBUTION_TYPE_CODES: Readonly<Record<string, number>> = {
  Individual: 2,
  "Aggregate - Individual": 1,
  "Aggregate - PAC": 20,
  "Aggregate - Party": 19,
  PAC: 4,
  Party: 3,
  "Loan Proceeds": 5,
  "Loan Proceeds - PAC": 23,
  "Loan Proceeds - Party": 22,
  "In-Kind - Individual": 6,
  "In-Kind - Party": 7,
  "In-Kind - PAC": 8,
  "In Kind - Aggregate": 21,
  "Interest Received": 10,
  "Refund/Rebate": 11,
  "State Check Off": 12,
  "Party Building - Individual": 16,
  "Party Building - PAC": 18,
  "Party Building - Party": 24,
  "Other Receipt": 17,
  "Matching Public Funds": 9,
};

// Detail-export columns, in order, as served on 2026-08-13. There is no
// occupation column (decision 1 was confirmed against real bytes).
export const ERTS_CONTRIBUTION_EXPORT_COLUMNS: readonly string[] = [
  "ContributionID",
  "ContDesc",
  "IncompleteDesc",
  "OrganizationName",
  "ViewIncomplete",
  "ReceiptDate",
  "DepositDate",
  "Amount",
  "ContribExplanation",
  "MPFMatchAmount",
  "FirstName",
  "LastName",
  "FullName",
  "Address",
  "CityStZip",
  "EmployerName",
  "EmpAddress",
  "EmpCityStZip",
  "ReceiptDesc",
  "BeginDate",
  "EndDate",
  "TransType",
];

// Summary-groupings grid ids: the contribution report and the expenditure
// report render the same block under different ids.
export const ERTS_CONTRIBUTION_SUMMARY_GRID_ID = "dgrReport";
export const ERTS_EXPENDITURE_SUMMARY_GRID_ID = "dgrExpenditureSummary";

// Result grids (the itemized rows below the summary block).
export const ERTS_CONTRIBUTION_RESULT_GRID_ID = "dgrContribution";
export const ERTS_EXPENDITURE_RESULT_GRID_ID = "dgrExpenditure";

// CF-2 page-1 labels pinned for the totals mapping (decision 2). The value
// sits on the same text baseline as its label, to its right. Spike result 5b:
// each CF-2 line aggregates a SET of search types (line 6 is every in-kind
// type) — mapping lines to single types produces false mismatches.
export const ERTS_CF2_SUMMARY_LABELS = [
  "1. Beginning Cash Balance",
  "2. Individuals",
  "3. Political Parties",
  "4. Political Action Committees",
  "7. Interest Received",
  "3. Total Cash",
  "5. Ending Cash Balance",
  "6. Report of In-Kind Contributions",
] as const;

// --- HTML primitives ---------------------------------------------------------

function decodeErtsHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function stripErtsTags(value: string): string {
  return decodeErtsHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function gridRowHtml(html: string, gridId: string): string[] {
  const table = new RegExp(`<table[^>]*id="${gridId}"[\\s\\S]*?</table>`, "i").exec(html)?.[0];
  if (!table) return [];
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => row[1]);
}

function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripErtsTags(cell[1]));
}

// --- Money and dates ---------------------------------------------------------

/**
 * Rendered pages print two decimals with parenthesized negatives (spike
 * result 5b: `NSF Check ($100.00)`); the detail export prints four
 * ("250.0000"). Sub-cent precision has never been observed and would break
 * the integer-cent contract, so it is rejected rather than rounded away.
 */
export function parseErtsMoneyToCents(value: string): number | null {
  const trimmed = value.replace(/[$\s]/g, "");
  if (trimmed === "") return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[()]/g, "").replace(/,/g, "");
  const parts = /^-?(\d+)(?:\.(\d{1,4}))?$/.exec(digits);
  if (!parts) return null;
  const fraction = (parts[2] ?? "").padEnd(4, "0");
  if (fraction.slice(2) !== "00") return null;
  const cents = Number(parts[1]) * 100 + Number(fraction.slice(0, 2));
  const signed = digits.startsWith("-") ? -cents : cents;
  return negative ? -signed : signed;
}

/**
 * Portal dates are US-style. Pages render zero-padded MM/DD/YYYY; the export
 * also serves single-digit months and days (`1/1/1900` is the portal's
 * no-deposit-date sentinel, handled by the export parser, not here).
 */
export function ertsUsDateToIso(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, month, day, year] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso)) return null;
  return iso;
}

// --- Report pages ------------------------------------------------------------

/**
 * "Summary Groupings" block above a transaction grid: the portal's own
 * per-type totals for the searched window. These, never a transaction sum,
 * are the official-total side (decision 2; the georgia cover-arithmetic
 * lesson — Q2 2026 carries `Other Receipt $113.95` in the summary while the
 * itemized search for that type returns no rows).
 */
export function parseErtsSummaryGroupings(html: string, gridId: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const rowHtml of gridRowHtml(html, gridId)) {
    const cells = rowCells(rowHtml);
    if (cells.length < 2) continue;
    const cents = parseErtsMoneyToCents(cells[cells.length - 1]);
    const label = cells[0];
    if (cents === null || label === "" || /^total$/i.test(label)) continue;
    totals.set(label, cents);
  }
  return totals;
}

/**
 * Classify a transaction search response. The portal never 404s: a search
 * with no rows answers 200 with a redirect back to the search page carrying
 * "No Contributions were found" (or the expenditure equivalent), and anything
 * else — a Cloudflare challenge, an error page — must read as unreadable,
 * never as "no rows".
 */
export function classifyErtsSearchResult(html: string, resultGridId: string): "rows" | "no_rows" | "unreadable" {
  if (new RegExp(`<table[^>]*id="${resultGridId}"`, "i").test(html)) return "rows";
  const noun = resultGridId === ERTS_CONTRIBUTION_RESULT_GRID_ID ? "Contributions" :
    resultGridId === ERTS_EXPENDITURE_RESULT_GRID_ID ? "Expenditures" : null;
  if (noun && new RegExp(`No ${noun} were found for the Search criteria you entered`, "i").test(stripErtsTags(html))) {
    return "no_rows";
  }
  // Current empty expenditure reports redirect to this native message.
  // The CF-2 reconciliation still independently verifies zero disbursements;
  // an unmarked generic empty search page is never sufficient.
  if (resultGridId === ERTS_EXPENDITURE_RESULT_GRID_ID) {
    const message = /<span\b[^>]*\bid=["']lblNoReportMsg["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];
    if (message && stripErtsTags(message).trim() === "There were no reports found, please try your search again.") {
      return "no_rows";
    }
  }
  return "unreadable";
}

// --- Contribution detail export ----------------------------------------------

/** Minimal RFC-4180 reader — the export quotes any field containing a comma. */
export function parseErtsCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

export type ErtsContributionExportRow = {
  contributionId: string;
  // Raw `ContDesc` — the pinned type vocabulary; unknown values are counted
  // by the caller's diagnostics, never guessed into a bucket (decision 13).
  contributionType: string;
  receiptDateIso: string;
  // Null when the portal serves its `1/1/1900` no-deposit-date sentinel.
  depositDateIso: string | null;
  amountCents: number;
  mpfMatchAmountCents: number;
  firstName: string;
  lastName: string;
  fullName: string;
  employerName: string;
  // `ViewIncomplete` !== "Complete": the row is a real contribution with
  // missing employer/address detail — it stays in totals (spike result 3).
  incomplete: boolean;
  receiptDesc: string;
  transType: string;
};

const ERTS_NO_DATE_SENTINEL_ISO = "1900-01-01";

/**
 * Parse the contribution detail export (the 3-hop CSV). Fail-closed: the
 * pinned 22-column header, a parseable amount and a parseable receipt date on
 * every row are the contract — any drift throws rather than yielding rows a
 * money aggregation would silently misread.
 */
export function parseErtsContributionExport(csvText: string): ErtsContributionExportRow[] {
  const rows = parseErtsCsv(csvText);
  const header = rows[0] ?? [];
  const headerMatches =
    header.length === ERTS_CONTRIBUTION_EXPORT_COLUMNS.length &&
    header.every((column, index) => column === ERTS_CONTRIBUTION_EXPORT_COLUMNS[index]);
  if (!headerMatches) {
    throw new Error(`ERTS contribution export header changed: ${header.join(",")}`);
  }
  const column = (name: string): number => ERTS_CONTRIBUTION_EXPORT_COLUMNS.indexOf(name);
  const parsed: ErtsContributionExportRow[] = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== ERTS_CONTRIBUTION_EXPORT_COLUMNS.length) {
      throw new Error(`ERTS contribution export row ${rowIndex + 1} has ${row.length} fields, expected ${ERTS_CONTRIBUTION_EXPORT_COLUMNS.length}`);
    }
    const cell = (name: string): string => row[column(name)].trim();
    const amountCents = parseErtsMoneyToCents(cell("Amount"));
    const mpfMatchAmountCents = parseErtsMoneyToCents(cell("MPFMatchAmount"));
    const receiptDateIso = ertsUsDateToIso(cell("ReceiptDate"));
    if (amountCents === null || mpfMatchAmountCents === null || receiptDateIso === null) {
      throw new Error(
        `ERTS contribution export row ${rowIndex + 1} (ContributionID ${cell("ContributionID")}) has an ` +
          `unparseable amount or receipt date`
      );
    }
    const depositDateIso = ertsUsDateToIso(cell("DepositDate"));
    parsed.push({
      contributionId: cell("ContributionID"),
      contributionType: cell("ContDesc"),
      receiptDateIso,
      depositDateIso: depositDateIso === ERTS_NO_DATE_SENTINEL_ISO ? null : depositDateIso,
      amountCents,
      mpfMatchAmountCents,
      firstName: cell("FirstName"),
      lastName: cell("LastName"),
      fullName: cell("FullName"),
      employerName: cell("EmployerName"),
      incomplete: cell("ViewIncomplete") !== "Complete",
      receiptDesc: cell("ReceiptDesc"),
      transType: cell("TransType"),
    });
  }
  return parsed;
}

// --- Organization search results ---------------------------------------------

export const ERTS_ORG_SEARCH_GRID_ID = "dgdOrgSearchResults";

export type ErtsOrganizationSearchRow = {
  organizationName: string;
  // WebForms postback target that selects this row in the live session.
  postbackTarget: string;
  // Board registration status column ("Active" / "Inactive") — the only
  // non-name evidence the search grid offers, and what the resolver's
  // active-registration gate reads.
  status: string;
};

export type ErtsOrganizationSearchPage = {
  rows: ErtsOrganizationSearchRow[];
  // True when the grid's pager row carries page links: the rows above are an
  // incomplete slice, so nothing name-based can be proven complete from this
  // page alone. The pager's postback mechanics were never probed (spike
  // searches all fit one page), so callers deciding identity must refuse a
  // paginated result rather than guess.
  hasMorePages: boolean;
};

/**
 * The session-scoped organization search grid (Contributions.aspx). Column
 * layout pinned live 2026-08-13: name (a `$lnkOrgID` select link), address,
 * city, state, status. Fail-closed like the filing-list parser: only the
 * pinned header and pager rows may be skipped — a data-like row that fails
 * the shape throws, because a silently dropped row here is a committee the
 * resolver never sees.
 */
export function parseErtsOrganizationSearchPage(html: string): ErtsOrganizationSearchPage {
  const rows: ErtsOrganizationSearchRow[] = [];
  let hasMorePages = false;
  for (const rowHtml of gridRowHtml(html, ERTS_ORG_SEARCH_GRID_ID)) {
    const cells = rowCells(rowHtml);
    if (cells.length === 0 || cells[0] === "Organization Name") continue;
    if (/<td\b[^>]*colspan=/i.test(rowHtml)) {
      // The pager row (single full-width cell). One page renders a bare
      // <span>1</span>; page links mean more results exist. Accumulate: if
      // the grid ever renders top AND bottom pagers, one link-bearing row
      // must keep the page marked incomplete.
      hasMorePages ||= /<a\b/i.test(rowHtml);
      continue;
    }
    const target = /__doPostBack\('(dgdOrgSearchResults\$[^']*\$lnkOrgID)'/.exec(rowHtml)?.[1];
    if (!target || cells.length < 5) {
      throw new Error(
        `ERTS organization search row does not match the pinned shape (cells: ${JSON.stringify(cells.slice(0, 3))}…)`
      );
    }
    rows.push({
      organizationName: cells[0]!,
      postbackTarget: target,
      status: cells[4]!,
    });
  }
  return { rows, hasMorePages };
}

/** Rows of the organization search grid; see parseErtsOrganizationSearchPage. */
export function parseErtsOrganizationSearchRows(html: string): ErtsOrganizationSearchRow[] {
  return parseErtsOrganizationSearchPage(html).rows;
}

// --- Organization filing list ------------------------------------------------

export type ErtsFilingRow = {
  reportType: string;
  // Recognized CF-1 registrations and filed MPF-3 requests have no period.
  periodBegin: string;
  periodEnd: string;
  status: string;
  // Empty for a report that is due but not yet filed.
  filedAt: string;
  amended: boolean;
  // From the row's `FilingAmendmentSelect.aspx` View link; null on unfiled
  // rows (which render no link).
  filingId: string | null;
  // `FormName` from the same link (RICF2, RIMPF2, ...). Only RICF2 filings
  // carry the CF-2 summary page the totals mapping reads (decision 2).
  formName: string | null;
  amendmentSelectUrl: string | null;
};

export const ERTS_FILING_LIST_GRID_ID = "grdSearchResults";

/**
 * The org filing grid (Filings.aspx, session-scoped). Column layout pinned
 * live 2026-08-13: report type, period begin, period end, due date, status,
 * original-filed timestamp, Amended Yes/No, View link. Unfiled rows are kept
 * (empty `filedAt`) so a caller can tell "not filed yet" from "absent".
 * Fail-closed: only the pinned header row may be skipped — a data-like row
 * whose financial period no longer parses throws, because a silently dropped
 * filing would silently drop its reporting period from the totals. Known CF-1
 * registrations and filed MPF-3 payment requests have blank periods and remain
 * in the inventory; the CF-2 selector excludes them by form type.
 */
export function parseErtsFilingListPage(html: string): ErtsFilingRow[] {
  const rows: ErtsFilingRow[] = [];
  for (const rowHtml of gridRowHtml(html, ERTS_FILING_LIST_GRID_ID)) {
    const cells = rowCells(rowHtml);
    if (cells.length === 0 || cells[0] === "Report Type") continue;
    const link = /href="([^"]*FilingAmendmentSelect\.aspx[^"]*)"/i.exec(decodeErtsHtml(rowHtml))?.[1] ?? null;
    const filingId = link ? (/FilingID=(\d+)/.exec(link)?.[1] ?? null) : null;
    const formName = link ? (/FormName=([A-Za-z0-9]+)/.exec(link)?.[1] ?? null) : null;
    const hasPeriod = /^\d{2}\/\d{2}\/\d{4}$/.test(cells[1] ?? "")
      && /^\d{2}\/\d{2}\/\d{4}$/.test(cells[2] ?? "");
    const isKnownRegistration = ["Notice of Organization - (CF-1)", "Amendment of Organization"].includes(cells[0])
      && cells[1] === "" && cells[2] === ""
      && ((formName === "RICF1" && filingId !== null && cells[5] !== "")
        || (link === null && cells[5] === ""));
    // Native MPF-3 affidavits request public financing, not a CF-2 period.
    // Require the exact filed form identity; do not accept unknown/unfiled
    // nonperiod reports or turn their absence into a financial zero.
    const isFiledMatchingFundsRequest = cells[0] === "MPF3, Affidavit and Payment Request"
      && cells[1] === "" && cells[2] === ""
      && formName === "RIMPF3" && filingId !== null && cells[5] !== "";
    if (cells.length < 7 || (!hasPeriod && !isKnownRegistration && !isFiledMatchingFundsRequest)) {
      throw new Error(
        `ERTS filing list row does not match the pinned shape (cells: ${JSON.stringify(cells.slice(0, 4))}…)`
      );
    }
    rows.push({
      reportType: cells[0],
      periodBegin: cells[1],
      periodEnd: cells[2],
      status: cells[4] ?? "",
      filedAt: cells[5] ?? "",
      amended: /^yes$/i.test(cells[6] ?? ""),
      filingId,
      formName,
      amendmentSelectUrl: link,
    });
  }
  return rows;
}

// --- Filing versions (FilingAmendmentSelect.aspx) ----------------------------

export type ErtsFilingVersion = { amendmentLabel: string; filedAt: string; pdfUrl: string };

export const ERTS_FILING_VERSIONS_GRID_ID = "grdAmendments";

/**
 * Version list for one filing family. `grdAmendments` lists oldest-first
 * (original, then each amendment in filing order — confirmed across the
 * spike's families, including a three-version one), so the last row is the
 * in-force version. Every version links a stable generated text-layer PDF
 * under `/ExportDocs/`. Fail-closed: only the pinned header row may be
 * skipped — a data row without a parseable PDF link throws, because
 * silently dropping the LATEST row would silently promote an older filing
 * to "in force" and publish stale totals.
 */
export function parseErtsFilingVersionsPage(html: string): ErtsFilingVersion[] {
  const versions: ErtsFilingVersion[] = [];
  for (const rowHtml of gridRowHtml(html, ERTS_FILING_VERSIONS_GRID_ID)) {
    const cells = rowCells(rowHtml);
    if (cells.length === 0 || cells[0] === "Amendment") continue;
    const pdfUrl = /href="([^"]*\/ExportDocs\/[^"]+\.pdf)"/i.exec(decodeErtsHtml(rowHtml))?.[1];
    if (!pdfUrl) {
      throw new Error(
        `ERTS filing-versions row carries no /ExportDocs/ PDF link (cells: ${JSON.stringify(cells.slice(0, 3))})`
      );
    }
    versions.push({ amendmentLabel: cells[0] ?? "", filedAt: cells[2] ?? "", pdfUrl });
  }
  return versions;
}

// --- CF-2 summary PDF --------------------------------------------------------

export type ErtsPdfTextItem = { text: string; x: number; y: number };

/** Positioned text items of a PDF's first page (the CF-2 summary page). */
export async function extractErtsPdfPageItems(pdf: Uint8Array): Promise<ErtsPdfTextItem[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: pdf }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    return content.items
      .map((item) => {
        const typed = item as { str?: string; transform?: number[] };
        return {
          text: (typed.str ?? "").trim(),
          x: Math.round(typed.transform?.[4] ?? 0),
          y: Math.round(typed.transform?.[5] ?? 0),
        };
      })
      .filter((item) => item.text !== "");
  } finally {
    await document.destroy();
  }
}

/**
 * CF-2 page 1 is a fixed two-column form: each amount sits on its label's
 * baseline, to the right of it, and the NEAREST such amount is the label's
 * value ("nearest" is load-bearing). Negative amounts print in parentheses
 * (`allowNegativeCashOnHand`, confirmed in the wild).
 */
export function readErtsCf2SummaryValues(
  items: readonly ErtsPdfTextItem[],
  labels: readonly string[]
): Map<string, number> {
  const values = new Map<string, number>();
  for (const label of labels) {
    const anchor = items.find((item) => item.text === label);
    if (!anchor) continue;
    let best: { x: number; cents: number } | null = null;
    for (const item of items) {
      if (Math.abs(item.y - anchor.y) > 3 || item.x <= anchor.x) continue;
      const cents = parseErtsMoneyToCents(item.text);
      if (cents === null) continue;
      if (!best || item.x < best.x) best = { x: item.x, cents };
    }
    if (best) values.set(label, best.cents);
  }
  return values;
}

// --- CF-8 "Other Filings" index ----------------------------------------------

export const ERTS_CF8_INDEX_GRID_ID = "dgdCF8FilingList";

export type ErtsCf8IndexRow = {
  filedDate: string;
  filingType: string;
  organizationName: string;
  scannedUrl: string | null;
};

/**
 * Fail-closed row reading: the pinned header row and the single-cell pager
 * row are the only skips — a data-like row whose filed date no longer
 * parses throws, because a silently dropped row is a silently missed
 * outside-spending filing (the decision-5 diff source).
 */
export function parseErtsCf8IndexPage(html: string): ErtsCf8IndexRow[] {
  const rows: ErtsCf8IndexRow[] = [];
  for (const rowHtml of gridRowHtml(html, ERTS_CF8_INDEX_GRID_ID)) {
    const cells = rowCells(rowHtml);
    // The pager renders as one full-width cell; blank spacer rows have none.
    if (cells.length < 2 || cells[0] === "Filed Date") continue;
    if (cells.length < 4 || !/^[A-Z][a-z]{2} \d{1,2} \d{4}$/.test(cells[0])) {
      throw new Error(`ERTS CF-8 index row does not match the pinned shape (cells: ${JSON.stringify(cells.slice(0, 4))})`);
    }
    const href = /href="([^"]*ReportsScanned\/[^"]+)"/i.exec(decodeErtsHtml(rowHtml))?.[1] ?? null;
    rows.push({
      filedDate: cells[0],
      filingType: cells[2],
      organizationName: cells[3],
      scannedUrl: href ? new URL(href, `${ERTS_PUBLIC_BASE_URL}Homepage.aspx`).toString() : null,
    });
  }
  return rows;
}

export type ErtsCf8Pager = { currentPage: number | null; links: { label: string; target: string }[] };

/**
 * The grid's pager row: the current page renders as a bare `<span>`, every
 * other page as a postback link labelled with its page number, and "..."
 * jumps to the next window of ten. The control ids are POSITIONAL, not page
 * numbers (page 2 is `ctl14$ctl01`) — following ids in order walks backwards
 * into an already-read page, so traversal must advance by rendered label
 * (spike result 7).
 */
export function parseErtsCf8Pager(html: string): ErtsCf8Pager {
  const pagerCell = [...gridRowHtml(html, ERTS_CF8_INDEX_GRID_ID)]
    .reverse()
    .find((rowHtml) => /__doPostBack\('dgdCF8FilingList\$/.test(rowHtml));
  if (!pagerCell) return { currentPage: null, links: [] };
  const currentLabel = /<span>\s*(\d+)\s*<\/span>/i.exec(pagerCell)?.[1];
  const links: { label: string; target: string }[] = [];
  for (const anchor of pagerCell.matchAll(
    /<a\b[^>]*__doPostBack\('(dgdCF8FilingList\$[^']+)'[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    links.push({ label: stripErtsTags(anchor[2]), target: anchor[1] });
  }
  return { currentPage: currentLabel ? Number(currentLabel) : null, links };
}

/** CF-8 index dates render as "Jul 3 2025"; NaN when the shape drifts. */
export function parseErtsCf8FiledDate(value: string): number {
  const parsed = Date.parse(`${value} 00:00:00Z`);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}
