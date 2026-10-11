// Parsers for the NCSBE campaign-finance portal (cf.ncsbe.gov). Every parser
// is fail-closed (docs/plans/north_carolina_plan.md decision 9): a page or payload that
// does not match the pinned shape throws instead of yielding partial rows.
// The portal is an early-2000s ASP.NET app that renders result pages by
// inlining JSON into script blocks (`var data = [...]`, `SetupGrid([...])`),
// and serves real JSON endpoints with a `text/html` Content-Type — so shape
// validation here, never the header, is what decides whether a body is data.
//
// Fixtures for every shape live in backend/tests/fixtures/northCarolinaFinance/
// (real bytes captured during the 2026-08-07 acquisition spike).

// Bumped whenever a pinned vocabulary or an output field changes, so cached
// artifacts parsed under an older version can be re-validated.
export const NCSBE_PARSER_VERSION = 1;

// SBoEID pattern pinned from spike bytes (spike results item 6): prefix is
// `STA` or a 3-digit county code; `-C-` = committee, `-F-` = legal-expense
// fund (excluded from candidate finance). Unregistered IE filers carry the
// literal `No Id`, which must never be used as a key (decision 6).
export const NORTH_CAROLINA_SBOEID_PATTERN = /^([A-Z]{3}|\d{3})-[A-Z0-9]{6}-[CF]-\d{3}$/;

export function isNcsbeLegalExpenseFundSboeId(sboeId: string): boolean {
  return NORTH_CAROLINA_SBOEID_PATTERN.test(sboeId) && sboeId.includes("-F-");
}

// HTML entities occur inside the embedded JSON's string values — a missing
// candidate name is the literal `&nbsp;` (spike results item 6).
export function decodeNcsbeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Entity-decodes, collapses whitespace, and returns null for empty values.
// Never use on fields whose exact bytes are pinned (ReceiptTypeCode keeps its
// trailing space, decision 7).
export function normalizeNcsbeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = decodeNcsbeHtmlEntities(value).replace(/\s+/g, " ").trim();
  return normalized.length === 0 ? null : normalized;
}

export type NcsbeDate = {
  raw: string;
  iso: string | null;
  // True when the date parses but lies outside 1990–2100 — the portal holds
  // live rows dated year 3026 (spike extra findings), so period math must
  // never trust raw bounds.
  implausible: boolean;
};

// Portal dates are MM/DD/YYYY; missing dates are empty strings.
export function parseNcsbeDate(raw: string | null | undefined): NcsbeDate {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    return { raw: value, iso: null, implausible: false };
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) {
    return { raw: value, iso: null, implausible: true };
  }
  const [, monthRaw, dayRaw, yearRaw] = match;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { raw: value, iso: null, implausible: true };
  }
  // Round-trip through a real calendar so impossible dates (02/31, non-leap
  // 02/29) fail closed instead of minting a nonexistent ISO day.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return { raw: value, iso: null, implausible: true };
  }
  const iso = `${yearRaw}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { raw: value, iso, implausible: false };
}

// Portal amounts are JSON numbers with up to four decimal places.
export function ncsbeAmountToCents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`NCSBE ${label} is not a finite number`);
  }
  return Math.round(value * 100);
}

function ncsbeOptionalAmountToCents(value: unknown, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return ncsbeAmountToCents(value, label);
}

// Extracts the bracketed JSON literal that starts at the first `open` bracket
// after `marker`, respecting strings and escapes. The pages surround these
// literals with arbitrary markup and grid-config script, so regexes over the
// whole page are unreliable (the spike's longest-array heuristic broke on the
// ReportDetail grid config).
export function extractNcsbeEmbeddedJson(input: {
  html: string;
  marker: string;
  open: "[" | "{";
  label: string;
  from?: number;
}): { raw: string; start: number; end: number } {
  const close = input.open === "[" ? "]" : "}";
  const markerIndex = input.html.indexOf(input.marker, input.from ?? 0);
  if (markerIndex < 0) {
    throw new Error(`NCSBE ${input.label}: marker ${JSON.stringify(input.marker)} not found — not a result page`);
  }
  const start = input.html.indexOf(input.open, markerIndex);
  if (start < 0) {
    throw new Error(`NCSBE ${input.label}: no ${input.open} after marker`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.html.length; index += 1) {
    const char = input.html[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === input.open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return { raw: input.html.slice(start, index + 1), start, end: index + 1 };
      }
    }
  }
  throw new Error(`NCSBE ${input.label}: unterminated ${input.open} literal`);
}

function parseJsonStrict(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`NCSBE ${label}: embedded JSON does not parse — ${(error as Error).message}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`NCSBE ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`NCSBE ${label} is not a string`);
  }
  return value;
}

function requireStringOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireString(value, label);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`NCSBE ${label} is not a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`NCSBE ${label} is not an integer`);
  }
  return value;
}

// --- Committee search (/CFOrgLkup/CommitteeGeneralResult/) ------------------

export type NcsbeCommitteeSearchRow = {
  orgName: string;
  // Null for unregistered entities and when the portal renders placeholders;
  // the literal `No Id` never survives as an identifier (decision 6).
  sboeId: string | null;
  oldId: string | null;
  candName: string | null;
  statusDesc: string;
  orgGroupId: number;
};

// The search and document-list pages embed their rows one of two ways: the
// original `var data = [...]`, or (portal redesign seen live 2026-10-10) a
// Kendo grid config whose inline data source is `"data":{"Data":[...],
// "Total":n}` with every row inline (no server paging). Same row schema in
// both; the old marker is tried first so cached artifacts still parse. The
// redesigned page drops the grid entirely when nothing matches and shows a
// `divNoResults` block ("No committees found.") instead — that is an empty
// result, not a broken page.
const NCSBE_LEGACY_GRID_DATA_MARKER = "var data = ";
const NCSBE_KENDO_GRID_DATA_MARKER = '"data":{"Data":';
const NCSBE_NO_RESULTS_MARKER = 'id="divNoResults"';

function extractNcsbeGridRowsJson(html: string, label: string): string {
  if (html.includes(NCSBE_LEGACY_GRID_DATA_MARKER)) {
    return extractNcsbeEmbeddedJson({ html, marker: NCSBE_LEGACY_GRID_DATA_MARKER, open: "[", label }).raw;
  }
  if (!html.includes(NCSBE_KENDO_GRID_DATA_MARKER) && html.includes(NCSBE_NO_RESULTS_MARKER)) {
    return "[]";
  }
  const marker = NCSBE_KENDO_GRID_DATA_MARKER;
  return extractNcsbeEmbeddedJson({ html, marker, open: "[", label }).raw;
}

export function parseNcsbeCommitteeSearchPage(html: string): NcsbeCommitteeSearchRow[] {
  const raw = extractNcsbeGridRowsJson(html, "committee search");
  const parsed = parseJsonStrict(raw, "committee search");
  if (!Array.isArray(parsed)) {
    throw new Error("NCSBE committee search: embedded data is not an array");
  }
  return parsed.map((entry, index) => {
    const row = requireRecord(entry, `committee search row ${index}`);
    const sboeIdRaw = normalizeNcsbeText(requireStringOrNull(row.SBoEID, `committee search row ${index} SBoEID`));
    return {
      orgName: requireString(row.OrgName, `committee search row ${index} OrgName`),
      sboeId: sboeIdRaw !== null && sboeIdRaw.toUpperCase() === "NO ID" ? null : sboeIdRaw,
      oldId: normalizeNcsbeText(requireStringOrNull(row.OldID, `committee search row ${index} OldID`)),
      candName: normalizeNcsbeText(requireStringOrNull(row.CandName, `committee search row ${index} CandName`)),
      statusDesc: requireString(row.StatusDesc, `committee search row ${index} StatusDesc`),
      orgGroupId: requireInteger(row.OrgGroupID, `committee search row ${index} OrgGroupID`),
    };
  });
}

// --- Document listings ------------------------------------------------------
// Shared by the per-committee inventory (/CFOrgLkup/DocumentGeneralResult/)
// and the statewide doc-type inventory (/CFDocLkup/DocumentResult/) — both
// embed the same row schema.

// Disclosure-report types that carry NO cover totals and whose money is
// re-reported on the covering regular report, verified live in the PR 9 run:
// RID 230343 ("2026 48-Hour Notice", STA-E1V050-C-001) has a 3-heading
// all-zero summary grid, and its single $2,500 receipt reappears on the
// committee's Second Quarter report (GroupID 22554243). Both inventory
// readers — the acquisition's fetch selection and the direct cycle filter —
// exclude these rows: fetching one fails the 34-section cover pin, and
// aggregating one would double-count both the dollars and the occupation
// row. Exclusion is by THIS pinned set only, never by pattern — an unknown
// no-total form must keep failing closed until it is verified and added.
export const NCSBE_NO_TOTAL_REPORT_TYPES: ReadonlySet<string> = new Set(["48-Hour Notice"]);

// Report types the OUTSIDE leg owns (decision 3's single-source rule). PR 8
// assumed IE informationals were not Disclosure Report rows and so could
// never reach a direct read; the live run refuted that — an IE filing is
// `DocumentType: "Disclosure Report"` with this ReportType, and the outside
// leg already reads it from the IE doc-type inventory. Reading it again on
// the direct side would double-count IE money into a committee's own totals,
// and an image-only one (5 of the 15 live rows) makes a registered spender
// look superseded-unavailable, which fails the whole funder leg closed.
export const NCSBE_OUTSIDE_LEG_REPORT_TYPES: ReadonlySet<string> = new Set([
  "Independent Expenditure Report",
]);

// Window fallback for an inventory row whose period bounds are missing or
// implausible: the row's own `ReportYear` decides whether it can touch the
// Y−1..Y cycle. One function so the acquisition's fetch selection and the
// sync's cycle filter can never disagree about which undated rows exist.
export function isNcsbeReportYearInCycle(reportYear: number, cycleYear: number): boolean {
  return reportYear >= cycleYear - 1 && reportYear <= cycleYear;
}

export type NcsbeDocumentRow = {
  committeeName: string;
  // Null when the filer is unregistered (`No Id`) — decision 6.
  sboeId: string | null;
  reportYear: number;
  documentType: string;
  reportType: string | null;
  // Null when the portal leaves the flag blank — observed only on
  // correspondence/certification noise rows, never on Disclosure or
  // Informational Reports. Report selection must treat null as ambiguous,
  // never as "not an amendment".
  isAmendment: boolean | null;
  imageReceiptDate: NcsbeDate;
  dataImportDate: NcsbeDate;
  periodStartDate: NcsbeDate;
  periodEndDate: NcsbeDate;
  // Structured report id for ReportDetail/GetReceipts/GetExpenditures, null
  // for image-only rows.
  dataLink: string | null;
  imageLink: string | null;
};

export function parseNcsbeDocumentListPage(html: string): NcsbeDocumentRow[] {
  const raw = extractNcsbeGridRowsJson(html, "document list");
  const parsed = parseJsonStrict(raw, "document list");
  if (!Array.isArray(parsed)) {
    throw new Error("NCSBE document list: embedded data is not an array");
  }
  return parsed.map((entry, index) => {
    const row = requireRecord(entry, `document list row ${index}`);
    const label = (field: string) => `document list row ${index} ${field}`;
    const isAmendmentRaw = requireString(row.IsAmendment, label("IsAmendment"));
    if (isAmendmentRaw !== "Y" && isAmendmentRaw !== "N" && isAmendmentRaw !== "") {
      throw new Error(`NCSBE ${label("IsAmendment")} has unexpected value ${JSON.stringify(isAmendmentRaw)}`);
    }
    const dataLinkRaw = requireStringOrNull(row.DataLink, label("DataLink"));
    const dataLink = dataLinkRaw === null || dataLinkRaw.trim().length === 0 ? null : dataLinkRaw.trim();
    if (dataLink !== null && !/^\d+$/.test(dataLink)) {
      throw new Error(`NCSBE ${label("DataLink")} is not a numeric report id: ${JSON.stringify(dataLinkRaw)}`);
    }
    const sboeIdRaw = normalizeNcsbeText(requireStringOrNull(row.SBoEID, label("SBoEID")));
    return {
      committeeName: requireString(row.CommitteeName, label("CommitteeName")),
      sboeId: sboeIdRaw !== null && sboeIdRaw.toUpperCase() === "NO ID" ? null : sboeIdRaw,
      reportYear: requireInteger(row.ReportYear, label("ReportYear")),
      documentType: requireString(row.DocumentType, label("DocumentType")),
      reportType: normalizeNcsbeText(requireStringOrNull(row.ReportType, label("ReportType"))),
      isAmendment: isAmendmentRaw === "" ? null : isAmendmentRaw === "Y",
      imageReceiptDate: parseNcsbeDate(requireStringOrNull(row.ImageReceiptDate, label("ImageReceiptDate"))),
      dataImportDate: parseNcsbeDate(requireStringOrNull(row.DataImportDate, label("DataImportDate"))),
      periodStartDate: parseNcsbeDate(requireStringOrNull(row.PeriodStartDate, label("PeriodStartDate"))),
      periodEndDate: parseNcsbeDate(requireStringOrNull(row.PeriodEndDate, label("PeriodEndDate"))),
      dataLink,
      imageLink: normalizeNcsbeText(requireStringOrNull(row.ImageLink, label("ImageLink"))),
    };
  });
}

// --- Report cover (/CFOrgLkup/ReportDetail/) --------------------------------

// The 34 cover summary sections, pinned from spike bytes and cross-verified
// on legislative, Council-of-State, and amended covers (spike results item
// 2). A section outside this set fails the parse — new portal vocabulary is
// reviewed, never silently aggregated.
export const NCSBE_COVER_SECTIONS: ReadonlyMap<number, string> = new Map([
  [5, "Cash on Hand at Beginning"],
  [10, "RECEIPTS"],
  [15, "Aggregated Contributions from Individuals"],
  [20, "Contributions from Individuals"],
  [30, "Political Party Committees"],
  [35, "Other Political Committees (such as PACs)"],
  [45, "Loan Proceeds"],
  [50, "Refunds/Reimbursements To the Committee"],
  [55, "Interest on Bank Accounts"],
  [56, "Contributions from Not-For-Profit Organizations"],
  [57, "Outside Sources of Income"],
  [58, "Legal Expense Fund - Other Sources"],
  [59, "Exempt Purchase Price Sales"],
  [60, "Total Receipts"],
  [65, "EXPENDITURES"],
  [70, "Operating Expenditures"],
  [75, "Contributions to Candidates/Political Committees"],
  [80, "Coordinated Party Expenditures"],
  [81, "Aggregated Non-Media Expenditures"],
  [85, "Loan Repayments"],
  [86, "Refunds/Reimbursements From the Committee"],
  [87, "In-Kind Contributions"],
  [90, "Total Expenditures"],
  [95, "Cash on Hand at End of Reporting Period"],
  [96, "ADDITIONAL INFORMATION"],
  [97, "Non-Monetary Gifts Given to Other Committees"],
  [98, "Outstanding Loans (incl. ones from other campaigns)"],
  [100, "Debts and Obligations owed BY the Committee"],
  [105, "Debts and Obligations owed TO the Committee"],
  [106, "Account Transfers Within the Committee"],
  [107, "Administrative Support"],
  [108, "Forgiven Loans"],
  [109, "48-Hour Notice Reports Sum"],
  [110, "Contributions to be Refunded"],
]);

export type NcsbeCoverSummarySection = {
  sequence: number;
  section: string;
  periodCents: number;
  cycleCents: number;
};

export type NcsbeReportCover = {
  // The report's OWN id, declared by the page as `var rptID = <n>;`. Present
  // and correct on all 770 covers of the PR 9 live pull, which makes it the
  // only decisive answer to "are these the bytes I asked for?" — every other
  // candidate field disagrees with the inventory somewhere in real data
  // (period dates on 17, committee name on 110, report name on 14, and even
  // SBoEID on 35 via O/0 and S/5 glyph confusions like STA-A52Z95 vs
  // STA-A52Z9S).
  reportId: string;
  // Null on live covers (PR 9 run: ~40% of committee reports, e.g. RID 231912
  // "COMMITTEE TO ELECT ELMA HAIRSTON") — the spike's fixtures all carried a
  // string, so this was pinned as required and failed those reports closed.
  // Nothing downstream reads it: committee identity comes from the inventory
  // row's SBoEID, never from the cover.
  boeId: string | null;
  orgName: string;
  entityTypeDesc: string | null;
  fullReportName: string | null;
  reportVersion: string | null;
  beginDate: NcsbeDate;
  endDate: NcsbeDate;
  // The date this filing was legally filed — differs between an original and
  // its amendment (spike: Berger YE-2025 original 01/30/2026 vs amendment
  // 07/10/2026), so it doubles as per-filing chronology evidence. No
  // amendment counter exists anywhere in the cover bytes.
  filedDate: NcsbeDate;
};

export type NcsbeReportDetail = {
  cover: NcsbeReportCover;
  summarySections: NcsbeCoverSummarySection[];
};

// Thrown when a grid matches the summary row shape but fails validation —
// that is a real page change, never one of the page's other SetupGrid calls.
// A sentinel class, not a message-substring test, so relabeling an error can
// never silently downgrade a validation failure into "not the summary grid".
class NcsbeCoverSummaryError extends Error {}

function isCoverSummaryShape(rows: unknown): rows is Array<Record<string, unknown>> {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        !Array.isArray(row) &&
        "Sequence" in row &&
        "Section" in row &&
        "Period" in row &&
        "Cycle" in row
    )
  );
}

export function parseNcsbeReportDetailPage(html: string): NcsbeReportDetail {
  const coverExtract = extractNcsbeEmbeddedJson({
    html,
    marker: "var dataCover = ",
    open: "{",
    label: "report cover",
  });
  const coverRaw = requireRecord(parseJsonStrict(coverExtract.raw, "report cover"), "report cover");

  // The page holds several SetupGrid(...) calls (officers, accounts, grid
  // config that itself mentions `Section`). The summary grid is identified by
  // row shape, and exactly one grid may match — zero or several is a page
  // change and fails closed.
  const summaryCandidates: NcsbeCoverSummarySection[][] = [];
  let searchFrom = 0;
  while (true) {
    const markerIndex = html.indexOf("SetupGrid(", searchFrom);
    if (markerIndex < 0) {
      break;
    }
    try {
      const gridExtract = extractNcsbeEmbeddedJson({
        html,
        marker: "SetupGrid(",
        open: "[",
        label: "cover grid",
        from: markerIndex,
      });
      const parsed = parseJsonStrict(gridExtract.raw, "cover grid");
      if (isCoverSummaryShape(parsed)) {
        try {
          const sections = parsed.map((row, index) => {
            const sequence = requireInteger(row.Sequence, `cover summary row ${index} Sequence`);
            const section = requireString(row.Section, `cover summary row ${index} Section`);
            const pinned = NCSBE_COVER_SECTIONS.get(sequence);
            if (pinned !== section) {
              throw new Error(
                `NCSBE cover summary row ${index} has unknown section ${JSON.stringify(section)} (sequence ${sequence})`
              );
            }
            return {
              sequence,
              section,
              periodCents: ncsbeAmountToCents(row.Period, `cover summary row ${index} Period`),
              cycleCents: ncsbeAmountToCents(row.Cycle, `cover summary row ${index} Cycle`),
            };
          });
          // The 34 sections are a fixed set (spike results item 2): a
          // truncated or duplicated grid must fail here, not surface later as
          // a silently missing Total Receipts.
          const seenSequences = new Set(sections.map((row) => row.sequence));
          if (seenSequences.size !== sections.length) {
            throw new Error("NCSBE cover summary grid repeats a section sequence");
          }
          if (sections.length !== NCSBE_COVER_SECTIONS.size) {
            const missing = [...NCSBE_COVER_SECTIONS.keys()].filter((sequence) => !seenSequences.has(sequence));
            throw new Error(
              `NCSBE cover summary grid has ${sections.length} of ${NCSBE_COVER_SECTIONS.size} sections ` +
                `(missing sequences: ${missing.join(", ")})`
            );
          }
          summaryCandidates.push(sections);
        } catch (error) {
          throw new NcsbeCoverSummaryError((error as Error).message);
        }
      }
    } catch (error) {
      // A grid that matches the summary shape but fails validation is a real
      // failure; anything else is one of the page's other grids.
      if (error instanceof NcsbeCoverSummaryError) {
        throw error;
      }
    }
    searchFrom = markerIndex + "SetupGrid(".length;
  }
  if (summaryCandidates.length !== 1) {
    throw new Error(
      `NCSBE report cover: expected exactly one summary grid, found ${summaryCandidates.length}`
    );
  }

  const reportIdMatch = /var\s+rptID\s*=\s*(\d+)\s*;/.exec(html);
  if (!reportIdMatch) {
    throw new Error("NCSBE report cover does not declare its own rptID");
  }

  return {
    cover: {
      reportId: reportIdMatch[1]!,
      boeId: normalizeNcsbeText(requireStringOrNull(coverRaw.BoeID, "report cover BoeID")),
      orgName: requireString(coverRaw.OrgName, "report cover OrgName"),
      entityTypeDesc: normalizeNcsbeText(requireStringOrNull(coverRaw.EntityTypeDesc, "report cover EntityTypeDesc")),
      fullReportName: normalizeNcsbeText(
        requireStringOrNull(coverRaw.FullReportName, "report cover FullReportName")
      ),
      reportVersion: normalizeNcsbeText(requireStringOrNull(coverRaw.ReportVersion, "report cover ReportVersion")),
      beginDate: parseNcsbeDate(requireStringOrNull(coverRaw.BeginDate, "report cover BeginDate")),
      endDate: parseNcsbeDate(requireStringOrNull(coverRaw.EndDate, "report cover EndDate")),
      filedDate: parseNcsbeDate(requireStringOrNull(coverRaw.FiledDate, "report cover FiledDate")),
    },
    summarySections: summaryCandidates[0]!,
  };
}

// --- Transaction pages (GetReceipts / GetExpenditures) ----------------------

export type NcsbeReceiptRow = {
  groupId: number | null;
  occurDate: NcsbeDate;
  orgName: string | null;
  isOrg: boolean;
  amountCents: number;
  // Contributor-cumulative; never summed (decision 7).
  sumToDateCents: number | null;
  // Kept verbatim — the placeholder vocabulary is matched case-insensitively
  // downstream, and blank stays blank.
  profession: string | null;
  employersName: string | null;
  isAggregated: boolean;
  receiptTypeDesc: string | null;
  // Verbatim: `"IND "` carries a real trailing space (decision 7).
  receiptTypeCode: string | null;
  accountAbbr: string | null;
  formOfPaymentDesc: string | null;
  purpose: string | null;
};

export type NcsbeExpenditureRow = {
  occurDate: NcsbeDate;
  orgName: string | null;
  isOrg: boolean;
  amountCents: number;
  // Per-target amount on unregistered IE forms; null on registered-committee
  // IE rows where `Amount` holds the single-target value (decision 4).
  ieAmountCents: number | null;
  isAggregated: boolean;
  expenditureTypeDesc: string | null;
  purposeTypeCode: string | null;
  purpose: string | null;
  accountAbbr: string | null;
  formOfPaymentDesc: string | null;
  // IE target fields; junk on plain operating rows (spike results item 9) —
  // the ExpenditureTypeDesc conjunction is what qualifies them.
  candidate: string | null;
  officeSought: string | null;
  declaration: string | null;
};

export type NcsbeTransactionPage<Row> = {
  recordCount: number;
  rows: Row[];
};

function parseNcsbeTransactionEnvelope(body: string, label: string): { recordCount: number; results: unknown[] } {
  const parsed = parseJsonStrict(body, label);
  const envelope = requireRecord(parsed, label);
  const data = requireRecord(envelope.Data, `${label} Data`);
  const recordCount = requireInteger(data.recordCountKey, `${label} recordCountKey`);
  if (recordCount < 0) {
    throw new Error(`NCSBE ${label} recordCountKey is negative`);
  }
  if (!Array.isArray(data.results)) {
    throw new Error(`NCSBE ${label} Data.results is not an array`);
  }
  return { recordCount, results: data.results };
}

export function parseNcsbeReceiptsPage(body: string): NcsbeTransactionPage<NcsbeReceiptRow> {
  const { recordCount, results } = parseNcsbeTransactionEnvelope(body, "receipts page");
  return {
    recordCount,
    rows: results.map((entry, index) => {
      const row = requireRecord(entry, `receipts row ${index}`);
      const label = (field: string) => `receipts row ${index} ${field}`;
      const groupId = row.GroupID === null || row.GroupID === undefined ? null : requireInteger(row.GroupID, label("GroupID"));
      return {
        groupId,
        occurDate: parseNcsbeDate(requireStringOrNull(row.OccurDate, label("OccurDate"))),
        orgName: normalizeNcsbeText(requireStringOrNull(row.OrgName, label("OrgName"))),
        isOrg: requireBoolean(row.IsOrg, label("IsOrg")),
        amountCents: ncsbeAmountToCents(row.Amount, label("Amount")),
        sumToDateCents: ncsbeOptionalAmountToCents(row.SumToDate, label("SumToDate")),
        profession: requireStringOrNull(row.Profession, label("Profession")),
        employersName: requireStringOrNull(row.EmployersName, label("EmployersName")),
        isAggregated: requireBoolean(row.IsAggregated, label("IsAggregated")),
        receiptTypeDesc: requireStringOrNull(row.ReceiptTypeDesc, label("ReceiptTypeDesc")),
        receiptTypeCode: requireStringOrNull(row.ReceiptTypeCode, label("ReceiptTypeCode")),
        accountAbbr: requireStringOrNull(row.AccountAbbr, label("AccountAbbr")),
        formOfPaymentDesc: requireStringOrNull(row.FormOfPaymentDesc, label("FormOfPaymentDesc")),
        purpose: requireStringOrNull(row.Purpose, label("Purpose")),
      };
    }),
  };
}

export function parseNcsbeExpendituresPage(body: string): NcsbeTransactionPage<NcsbeExpenditureRow> {
  const { recordCount, results } = parseNcsbeTransactionEnvelope(body, "expenditures page");
  return {
    recordCount,
    rows: results.map((entry, index) => {
      const row = requireRecord(entry, `expenditures row ${index}`);
      const label = (field: string) => `expenditures row ${index} ${field}`;
      return {
        occurDate: parseNcsbeDate(requireStringOrNull(row.OccurDate, label("OccurDate"))),
        orgName: normalizeNcsbeText(requireStringOrNull(row.OrgName, label("OrgName"))),
        isOrg: requireBoolean(row.IsOrg, label("IsOrg")),
        amountCents: ncsbeAmountToCents(row.Amount, label("Amount")),
        ieAmountCents: ncsbeOptionalAmountToCents(row.IEAmount, label("IEAmount")),
        isAggregated: requireBoolean(row.IsAggregated, label("IsAggregated")),
        expenditureTypeDesc: requireStringOrNull(row.ExpenditureTypeDesc, label("ExpenditureTypeDesc")),
        purposeTypeCode: requireStringOrNull(row.PurposeTypeCode, label("PurposeTypeCode")),
        purpose: requireStringOrNull(row.Purpose, label("Purpose")),
        accountAbbr: requireStringOrNull(row.AccountAbbr, label("AccountAbbr")),
        formOfPaymentDesc: requireStringOrNull(row.FormOfPaymentDesc, label("FormOfPaymentDesc")),
        candidate: normalizeNcsbeText(requireStringOrNull(row.Candidate, label("Candidate"))),
        officeSought: normalizeNcsbeText(requireStringOrNull(row.OfficeSought, label("OfficeSought"))),
        declaration: normalizeNcsbeText(requireStringOrNull(row.Declaration, label("Declaration"))),
      };
    }),
  };
}
