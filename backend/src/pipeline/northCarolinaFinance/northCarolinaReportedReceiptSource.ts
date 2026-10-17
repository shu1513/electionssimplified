import {
  decodeNcsbeHtmlEntities,
  extractNcsbeEmbeddedJson,
  NCSBE_COVER_SECTIONS,
  parseNcsbeDate,
  parseNcsbeReceiptsPage,
  parseNcsbeReportDetailPage,
  type NcsbeReceiptRow,
  type NcsbeReportDetail,
} from "./northCarolinaNcsbeParsers.js";
import { NCSBE_PORTAL_BASE_URL, NCSBE_TRANSACTION_PAGE_SIZE } from "./northCarolinaNcsbeClient.js";

const ORIGIN = NCSBE_PORTAL_BASE_URL;

export const NORTH_CAROLINA_RECEIPT_CSV_HEADERS = [
  "Group ID", "Date", "Is Prior", "Name", "Street 1", "Street 2", "City", "State",
  "Full Zip", "Country Name", "Outside US Postal Code", "Profession", "Employers Name",
  "Purpose", "Receipt Type Desc", "Account Abbr", "Form Of Payment Desc", "Description",
  "Amount", "Sum To Date",
] as const;

const RECEIPT_FIELDS = [
  "GroupID", "OccurDate", "IsPrior", "OrgName", "Street1", "Street2", "City", "State",
  "FullZip", "CountryName", "OutsideUSPostalCode", "Profession", "EmployersName",
  "Purpose", "ReceiptTypeDesc", "AccountAbbr", "FormOfPaymentDesc", "Description",
  "Amount", "SumToDate",
] as const;

type Reason = "export_anchor" | "cover" | "csv" | "money" | "receipt_pages" | "receipt_fields"
  | "receipt_occurrences" | "receipt_controls";

function fail(reason: Reason): never {
  // Source values and parser messages can contain private identities.
  throw new Error(`NCSBE reported receipt source: ${reason}`);
}

function record(value: unknown, reason: Reason): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(reason);
  return value as Record<string, unknown>;
}

function reportIdIsValid(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

/** Read the native ALL export anchor from the report's own cover. No route is synthesized. */
export function extractNorthCarolinaNativeExportUrl(input: { reportId: string; coverHtml: string }): string {
  if (!reportIdIsValid(input.reportId)) fail("export_anchor");
  const candidates: string[] = [];
  for (const anchor of input.coverHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = anchor[1]!;
    const hrefs = [...attributes.matchAll(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)];
    const text = decodeNcsbeHtmlEntities(anchor[2]!.replace(/<[^>]*>/g, "")).trim();
    const looksLikeExport = /\bexport\b/i.test(text) || hrefs.some((href) => /(?:handler=Export|ExportDetailResults)/i.test(decodeNcsbeHtmlEntities(href[1] ?? href[2] ?? "")));
    if (!looksLikeExport) continue;
    if (hrefs.length !== 1) fail("export_anchor");
    const href = decodeNcsbeHtmlEntities(hrefs[0]![1] ?? hrefs[0]![2] ?? "");
    let url: URL;
    try { url = new URL(href, ORIGIN); } catch { fail("export_anchor"); }
    if ((!href.startsWith("/CFOrgLkup/ReportDetail?") && !href.startsWith(`${ORIGIN}/CFOrgLkup/ReportDetail?`))
      || href.includes("#") || href.trim() !== href || /[\u0000-\u0020\\]/.test(href) || url.origin !== ORIGIN
      || url.username !== "" || url.password !== "" || url.hash !== ""
      || url.pathname !== "/CFOrgLkup/ReportDetail") fail("export_anchor");
    const expected = new Map([ ["handler", "Export"], ["RID", input.reportId], ["TP", "ALL"], ["sid", ""], ["cn", ""] ]);
    if ([...url.searchParams].length !== expected.size) fail("export_anchor");
    for (const [key, value] of expected) {
      if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) fail("export_anchor");
    }
    candidates.push(url.href);
  }
  if (candidates.length !== 1) fail("export_anchor");
  return candidates[0]!;
}

/** Native SQL-money strings may have four places, but may never lose a subcent. */
function exactCents(value: string): number {
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(value)) fail("money");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  if (/[1-9]/.test(fraction.slice(2))) fail("money");
  const cents = (BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2))) * (value.startsWith("-") ? -1n : 1n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) fail("money");
  return Number(cents);
}

// Keep original numeric lexemes alongside ordinary JSON. JSON.parse alone can
// round an unsafe amount into an apparently safe cent value before validation.
function jsonWithNumberText(body: string, reason: Reason): { raw: unknown; numberText: unknown } {
  let shadow = "";
  for (let index = 0; index < body.length;) {
    const char = body[index]!;
    if (char === '"') {
      const start = index++;
      let closed = false;
      while (index < body.length) {
        if (body[index] === "\\") { index += 2; continue; }
        if (body[index++] === '"') { closed = true; break; }
      }
      if (!closed) fail(reason);
      shadow += body.slice(start, index);
    } else if (char === "-" || /\d/.test(char)) {
      const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(body.slice(index));
      if (!token) fail(reason);
      shadow += JSON.stringify(token[0]);
      index += token[0].length;
    } else {
      shadow += char;
      index += 1;
    }
  }
  try { return { raw: JSON.parse(body), numberText: JSON.parse(shadow) }; } catch { fail(reason); }
}

function nativeCents(value: unknown, token: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || typeof token !== "string") fail("money");
  return exactCents(token);
}

function nativeSafeInteger(value: unknown, token: unknown, reason: Reason): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || typeof token !== "string"
    || !/^-?\d+$/.test(token) || BigInt(token) !== BigInt(value)) fail(reason);
  return value;
}

function parseCsv(body: string): Map<string, string[][]> {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false, closed = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') { value += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === '"') {
      if (value !== "" || closed) fail("csv");
      quoted = true;
    } else if (char === ",") {
      row.push(value); value = ""; closed = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      row.push(value);
      rows.push(row.length === 1 && row[0] === "" && !closed ? [] : row);
      row = []; value = ""; closed = false;
    } else {
      if (closed) fail("csv");
      value += char;
    }
  }
  if (quoted) fail("csv");
  if (value !== "" || row.length > 0 || closed) { row.push(value); rows.push(row); }
  const sections = new Map<string, string[][]>();
  let section: string[][] | undefined;
  for (const line of rows) {
    if (line.length === 0) { section = undefined; continue; }
    if (!section) {
      if (line.length !== 1 || line[0] === "" || sections.has(line[0]!)) fail("csv");
      section = []; sections.set(line[0]!, section);
    } else section.push(line);
  }
  for (const sectionRows of sections.values()) {
    const header = sectionRows[0];
    if (!header || header.length === 0 || sectionRows.some((line) => line.length !== header.length)) fail("csv");
  }
  return sections;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function exactCover(coverHtml: string, reportId: string): NcsbeReportDetail {
  try {
    const rawGrids: string[] = [];
    if (coverHtml.includes("var dataCover = ")) {
      const ownIds = [...coverHtml.matchAll(/var\s+rptID\s*=\s*(\d+)\s*;/g)];
      if (ownIds.length !== 1 || ownIds[0]![1] !== reportId) fail("cover");
      let from = 0;
      while ((from = coverHtml.indexOf("SetupGrid(", from)) >= 0) {
        const extracted = extractNcsbeEmbeddedJson({ html: coverHtml, marker: "SetupGrid(", open: "[", label: "summary", from });
        const value: unknown = JSON.parse(extracted.raw);
        if (Array.isArray(value) && value.length > 0 && value.every((row) => row && typeof row === "object" && "Sequence" in row && "Period" in row && "Cycle" in row && "Section" in row)) rawGrids.push(extracted.raw);
        from += "SetupGrid(".length;
      }
    } else {
      const from = coverHtml.indexOf('jQuery("#gridSummary").kendoGrid(');
      rawGrids.push(extractNcsbeEmbeddedJson({ html: coverHtml, marker: '"data":{"Data":', open: "[", label: "summary", from }).raw);
    }
    if (rawGrids.length !== 1) fail("cover");
    const grid = jsonWithNumberText(rawGrids[0]!, "cover");
    if (!Array.isArray(grid.raw) || !Array.isArray(grid.numberText) || grid.raw.length !== NCSBE_COVER_SECTIONS.size) fail("cover");
    const tokens = grid.numberText;
    const seen = new Set<number>();
    const summarySections = grid.raw.map((entry, index) => {
      const row = record(entry, "cover"), token = record(tokens[index], "cover");
      const sequence = nativeSafeInteger(row.Sequence, token.Sequence, "cover");
      if (NCSBE_COVER_SECTIONS.get(sequence) !== row.Section || seen.has(sequence)) fail("cover");
      seen.add(sequence);
      return { sequence, section: row.Section as string, periodCents: nativeCents(row.Period, token.Period), cycleCents: nativeCents(row.Cycle, token.Cycle) };
    });
    const detail = parseNcsbeReportDetailPage(coverHtml);
    if (detail.cover.reportId !== reportId) fail("cover");
    return { cover: detail.cover, summarySections };
  } catch (error) {
    if (error instanceof Error && error.message === "NCSBE reported receipt source: money") throw error;
    fail("cover");
  }
}

export type NorthCarolinaReportedReceipt = NcsbeReceiptRow & {
  // Preserve source strings, including IsPrior's native blank, without Boolean inference.
  // Money values retain their original decimal lexemes; the typed cent fields above are exact.
  sourceFields: Readonly<Record<(typeof RECEIPT_FIELDS)[number], string | number | null>>;
};

export type NorthCarolinaReportedReceiptSource = {
  reportId: string;
  exportUrl: string;
  detail: NcsbeReportDetail;
  receipts: NorthCarolinaReportedReceipt[];
};

/** Validate one source report. This does not establish a complete cycle or publication eligibility. */
export function validateNorthCarolinaReportedReceiptSource(input: {
  reportId: string;
  coverHtml: string;
  exportCsv: string;
  receiptPages: ReadonlyArray<{ page: number; body: string }>;
}): NorthCarolinaReportedReceiptSource {
  const exportUrl = extractNorthCarolinaNativeExportUrl(input);
  const detail = exactCover(input.coverHtml, input.reportId);
  const sections = parseCsv(input.exportCsv);
  const summary = sections.get("SUMMARY");
  if (!summary || !same(summary[0], ["Sequence", "Section", "Period", "Cycle"]) || summary.length !== 35) fail("csv");
  const csvSummary = new Map<number, { section: string; periodCents: number; cycleCents: number }>();
  for (const row of summary.slice(1)) {
    if (!/^\d+$/.test(row[0]!)) fail("csv");
    const sequence = Number(row[0]);
    if (!Number.isSafeInteger(sequence) || csvSummary.has(sequence)) fail("csv");
    csvSummary.set(sequence, { section: row[1]!, periodCents: exactCents(row[2]!), cycleCents: exactCents(row[3]!) });
  }
  for (const row of detail.summarySections) {
    const actual = csvSummary.get(row.sequence);
    if (!actual || actual.section !== row.section || actual.periodCents !== row.periodCents || actual.cycleCents !== row.cycleCents) fail("cover");
  }

  let total: number | undefined;
  const receipts: NorthCarolinaReportedReceipt[] = [];
  const comparisonRows: Array<Array<string | number | null>> = [];
  if (input.receiptPages.length === 0) fail("receipt_pages");
  for (let index = 0; index < input.receiptPages.length; index += 1) {
    const page = input.receiptPages[index]!;
    if (page.page !== index) fail("receipt_pages");
    const parsed = jsonWithNumberText(page.body, "receipt_pages");
    const envelope = record(parsed.raw, "receipt_pages"), tokens = record(parsed.numberText, "receipt_pages");
    const data = Array.isArray(envelope.Data) ? envelope : record(envelope.Data, "receipt_pages");
    const tokenData = Array.isArray(envelope.Data) ? tokens : record(tokens.Data, "receipt_pages");
    const rows = Array.isArray(envelope.Data) ? envelope.Data : data.results;
    const rowTokens = Array.isArray(envelope.Data) ? tokens.Data : tokenData.results;
    const count = nativeSafeInteger(Array.isArray(envelope.Data) ? envelope.Total : data.recordCountKey,
      Array.isArray(envelope.Data) ? tokens.Total : tokenData.recordCountKey, "receipt_pages");
    if (envelope.Errors !== null && envelope.Errors !== undefined) fail("receipt_pages");
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(rows) || !Array.isArray(rowTokens)) fail("receipt_pages");
    if (total === undefined) total = count;
    if (total !== count || input.receiptPages.length !== Math.max(1, Math.ceil(total / NCSBE_TRANSACTION_PAGE_SIZE))
      || rows.length !== Math.min(NCSBE_TRANSACTION_PAGE_SIZE, total - index * NCSBE_TRANSACTION_PAGE_SIZE)) fail("receipt_pages");
    const pageFields: NorthCarolinaReportedReceipt["sourceFields"][] = [];
    const pageComparisons: Array<Array<string | number | null>> = [];
    for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
      const row = record(rows[ordinal], "receipt_fields"), token = record(rowTokens[ordinal], "receipt_fields");
      const fields = {} as Record<(typeof RECEIPT_FIELDS)[number], string | number | null>;
      const comparison: Array<string | number | null> = [];
      for (const field of RECEIPT_FIELDS) {
        const value = row[field];
        if (field === "GroupID") {
          const groupId = value === null ? null : nativeSafeInteger(value, token[field], "receipt_fields");
          fields[field] = groupId;
          comparison.push(groupId === null ? "" : String(groupId));
        } else if (field === "Amount" || field === "SumToDate") {
          if (field === "SumToDate" && value === null) { fields[field] = null; comparison.push(null); }
          else { const cents = nativeCents(value, token[field]); fields[field] = token[field] as string; comparison.push(cents); }
        } else {
          if (value !== null && typeof value !== "string") fail("receipt_fields");
          if (field === "IsPrior" && typeof value !== "string") fail("receipt_fields");
          fields[field] = value as string | null;
          if (field === "OccurDate") comparison.push(receiptDate(value));
          else if (field === "IsPrior") comparison.push((value ?? "").trim());
          else comparison.push(decodeNcsbeHtmlEntities(value ?? ""));
        }
      }
      comparisonRows.push(comparison);
      pageFields.push(fields);
      pageComparisons.push(comparison);
    }
    let normalized: NcsbeReceiptRow[];
    try { normalized = parseNcsbeReceiptsPage(page.body).rows; } catch { fail("receipt_fields"); }
    for (let ordinal = 0; ordinal < normalized.length; ordinal += 1) {
      const comparison = pageComparisons[ordinal]!;
      receipts.push({ ...normalized[ordinal]!, amountCents: comparison[18] as number, sumToDateCents: comparison[19] as number | null, sourceFields: pageFields[ordinal]! });
    }
  }
  const csvReceipts = sections.get("RECEIPTS");
  if (!csvReceipts && total !== 0) fail("receipt_occurrences");
  if (csvReceipts && !same(csvReceipts[0], NORTH_CAROLINA_RECEIPT_CSV_HEADERS)) fail("csv");
  const occurrences = new Map<string, number>();
  for (const row of comparisonRows) { const key = JSON.stringify(row); occurrences.set(key, (occurrences.get(key) ?? 0) + 1); }
  for (const row of csvReceipts?.slice(1) ?? []) {
    const values: Array<string | number | null> = row.map((value, index) => {
      if (index === 1) return receiptDate(value);
      if (index === 2) return value.trim();
      if (index === 18 || index === 19) return index === 19 && value === "" ? null : exactCents(value);
      return decodeNcsbeHtmlEntities(value);
    });
    const key = JSON.stringify(values), count = occurrences.get(key) ?? 0;
    if (count === 0) fail("receipt_occurrences");
    occurrences.set(key, count - 1);
  }
  if ([...occurrences.values()].some((count) => count !== 0)) fail("receipt_occurrences");
  for (const [code, sequence] of [["PPTY", 30], ["CPCM", 35]] as const) {
    let cents = 0n;
    for (const row of receipts) if (row.receiptTypeCode === code) cents += BigInt(row.amountCents);
    const coverCents = detail.summarySections.find((row) => row.sequence === sequence)!.periodCents;
    if (cents !== BigInt(coverCents)) fail("receipt_controls");
  }
  return { reportId: input.reportId, exportUrl, detail, receipts };
}

function receiptDate(value: unknown): string | null {
  if (value !== null && typeof value !== "string") fail("receipt_fields");
  const date = parseNcsbeDate(value);
  if (date.implausible) fail("receipt_fields");
  return date.iso;
}
