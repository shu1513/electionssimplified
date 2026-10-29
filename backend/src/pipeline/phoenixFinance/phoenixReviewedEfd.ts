import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { phoenixCandidateCycleForDate } from "./phoenixEfilingClient.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

export const PHOENIX_EFD_INDEX_URL =
  "https://www.phoenix.gov/administration/departments/cityclerk/programs-services/elections/dark-money.html";
export const PHOENIX_EFD_BALLOT_URL =
  "https://www.phoenix.gov/administration/departments/cityclerk/programs-services/elections/november-election-26/candidate-information-26.html";

export class PhoenixEfdHold extends Error {
  constructor(readonly reason: string) { super(`Phoenix reviewed EFD: ${reason}`); }
}
export function efdCheck(value: unknown, reason: string): asserts value {
  if (!value) throw new PhoenixEfdHold(reason);
}
export const efdText = (value: string): string => value.normalize("NFKC")
  .replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
export const efdNameKey = (value: string): string => efdText(value).toUpperCase();
const observationDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" });
export function phoenixEfdObservationDay(clock: string): string {
  efdCheck(Number.isFinite(Date.parse(clock)), "observation_clock");
  const parts = observationDay.formatToParts(new Date(clock));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function efdDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 500 && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/u.test(value);
}
export function efdAdd(a: number, b: number): number {
  efdCheck(Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(a + b), "unsafe_cent_sum");
  return a + b;
}
function publicDate(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  efdCheck(m, "publication_date_literal");
  const result = `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  efdCheck(efdDate(result), "publication_calendar_date");
  return result;
}
export type PhoenixEfdIndexRow = { documentId: string; filedDate: string; spenderName: string; sourceUrl: string };

/** Read every physical row. Historical date typos are retained, never repaired
 * or used to certify a missing current filing. Only a selected family may
 * establish the scope of a reviewed packet. */
export function parsePhoenixEfdIndex(html: string): PhoenixEfdIndexRow[] {
  const dom = new JSDOM(html);
  try {
    const tables = [...dom.window.document.querySelectorAll("table")].filter(t => {
      const headers = new Set([...t.querySelectorAll("th,td")].map(c => efdNameKey(c.textContent ?? "")));
      return ["DATE", "NAME", "DOC ID"].every(h => headers.has(h));
    });
    efdCheck(tables.length === 1, "whole_publication_table");
    const rows: PhoenixEfdIndexRow[] = [];
    for (const tr of tables[0]!.querySelectorAll("tr")) {
      const cells = [...tr.children].filter(c => ["TH", "TD"].includes(c.tagName));
      const values = cells.map(c => efdText(c.textContent ?? ""));
      if (!values.some(Boolean) || values.map(efdNameKey).join("|") === "DATE|NAME|DOC ID") continue;
      efdCheck(cells.length === 3 && values.every(Boolean), "publication_physical_row");
      const links = cells[2]!.querySelectorAll("a[href]");
      efdCheck(links.length === 1 && /^[1-9]\d{4,9}$/u.test(values[2]!), "publication_document_reference");
      const url = new URL(links[0]!.getAttribute("href")!, PHOENIX_EFD_INDEX_URL);
      efdCheck(url.protocol === "https:" && !url.username && !url.password && !url.port &&
        ["www.phoenix.gov", "phoenix.gov", "apps-secure.phoenix.gov"].includes(url.hostname), "publication_link_origin");
      rows.push({ documentId: values[2]!, filedDate: publicDate(values[0]!), spenderName: values[1]!, sourceUrl: url.href });
      efdCheck(rows.length <= 2000, "publication_row_bound");
    }
    efdCheck(rows.length > 0, "publication_positive_control");
    return rows;
  } finally { dom.window.close(); }
}

/** Only directly published CMS PDFs are acquired. This never enters the
 * public-records search, accepts its agreement, or follows archive selectors. */
export function assertPhoenixEfdCmsUrl(value: string): void {
  const url = new URL(value);
  efdCheck(url.protocol === "https:" && url.hostname === "www.phoenix.gov" && !url.username && !url.password &&
    !url.port && !url.search && !url.hash && url.pathname.startsWith("/content/dam/phoenix/cityclerksite/documents/") &&
    /\.pdf$/iu.test(url.pathname), "direct_public_cms_pdf_required");
}
export function selectPhoenixEfdFamily(rows: readonly PhoenixEfdIndexRow[], spenderName: string,
  electionDate: string, asOfDate: string): PhoenixEfdIndexRow[] {
  efdCheck(text(spenderName) && efdDate(electionDate) && efdDate(asOfDate), "family_identity_or_date");
  const cycle = phoenixCandidateCycleForDate(electionDate), key = efdNameKey(spenderName);
  efdCheck(asOfDate >= cycle.cycleStart && asOfDate <= cycle.cycleEnd, "review_cycle_observation");
  const family: PhoenixEfdIndexRow[] = [], ids = new Set<string>(), urls = new Set<string>();
  for (const row of rows) {
    const name = efdNameKey(row.spenderName);
    if (name !== key) {
      // An annotated edition may belong to this filer. Do not drop it by
      // exact-name filtering or infer amendment parentage from its timestamp.
      const at = name.indexOf(key);
      const prefix = at < 0 ? "" : name.slice(0, at), suffix = at < 0 ? "" : name.slice(at + key.length);
      const containsFiler = at >= 0 && (!prefix || /[\s()\[\],:/-]$/u.test(prefix)) &&
        (!suffix || /^[\s()\[\],:/-]/u.test(suffix));
      efdCheck(!(row.filedDate >= cycle.cycleStart && containsFiler && /(?:AMEND|48[\s-]*HOUR)/u.test(`${prefix} ${suffix}`)),
        "annotated_filer_lineage_requires_review");
      continue;
    }
    efdCheck(row.filedDate >= "2000-01-01" && row.filedDate <= asOfDate, "selected_filer_date_requires_review");
    if (row.filedDate < cycle.cycleStart) continue;
    assertPhoenixEfdCmsUrl(row.sourceUrl);
    efdCheck(!ids.has(row.documentId) && !urls.has(row.sourceUrl), "duplicate_publication_reference");
    ids.add(row.documentId); urls.add(row.sourceUrl); family.push(row);
  }
  efdCheck(family.length > 0 && family.length <= 100, "complete_nonempty_filer_family");
  return family;
}

export type PhoenixCouncilBallotRow = { name: string; district: number; certifiedDate: string | null };
export function parsePhoenixCouncilBallot(html: string): PhoenixCouncilBallotRow[] {
  const dom = new JSDOM(html);
  try {
    efdCheck(efdText(dom.window.document.body.textContent ?? "").includes("November 3, 2026"), "official_ballot_election");
    const rows: PhoenixCouncilBallotRow[] = [];
    let district: number | null = null;
    for (const element of dom.window.document.querySelectorAll("h2,h3,table")) {
      if (element.tagName !== "TABLE") {
        const match = /^Candidates for District (\d)$/iu.exec(efdText(element.textContent ?? ""));
        if (match) district = Number(match[1]);
        continue;
      }
      const trs = [...element.querySelectorAll("tr")];
      const header = trs.find(tr => /CERTIFIED TO BALLOT/u.test(efdNameKey(tr.textContent ?? "")));
      if (!header) continue;
      efdCheck(district !== null && [2, 4, 6, 8].includes(district), "official_ballot_district");
      const headings = [...header.children].map(c => efdNameKey(c.textContent ?? ""));
      const certifiedColumn = headings.indexOf("CERTIFIED TO BALLOT");
      efdCheck(headings[0] === "NAME" && certifiedColumn >= 1, "official_ballot_columns");
      for (const tr of trs) {
        if (tr === header) continue;
        const cells = [...tr.children];
        if (!cells.length || !efdText(tr.textContent ?? "")) continue;
        efdCheck(cells.length === headings.length, "official_ballot_physical_row");
        const name = efdText(cells[0]!.textContent ?? ""), certified = efdText(cells[certifiedColumn]!.textContent ?? "");
        efdCheck(text(name), "official_ballot_name_required");
        // The official register also lists people who never certified.
        // Retain them in edition controls; they cannot establish a mapping.
        rows.push({ name, district, certifiedDate: certified ? publicDate(certified) : null });
      }
    }
    efdCheck(rows.some(row => row.certifiedDate !== null) && rows.length <= 200 && new Set(rows.map(r => efdNameKey(r.name))).size === rows.length,
      "official_ballot_positive_unique_control");
    return rows;
  } finally { dom.window.close(); }
}

export const PHOENIX_EFD_REVIEW = {
  purpose: "election_funding_disclosure", newReport: true, wholeReportRead: true,
  candidateCount: 1, ballotMeasureCount: 0, entireAmountForNamedCandidate: true,
  reportedPayerNameVerified: true, certifiedBallotMappingVerified: true, distinctNewExpense: true,
} as const;
export type PhoenixReviewedEfdReport = {
  documentId: string; sourceUrl: string; sourceSha256: string; filedDate: string;
  reportedSpenderName: string; reportedCandidateName: string; reportedOffice: string;
  reportedDistrictNumber: number | null; vendorName: string; expenditureDate: string;
  amountCents: number; supportOppose: "support" | "oppose"; reviewedPageCount: number;
  review: typeof PHOENIX_EFD_REVIEW;
};
export type PhoenixReviewedEfdDraft = {
  spenderName: string; reports: readonly PhoenixReviewedEfdReport[];
  occurrenceCount: number; supportCents: number; opposeCents: number;
};

/** Review declarations validate an operator transcription; they are not OCR
 * claims or a determination that an EFD is a statutory independent expenditure. */
export function validatePhoenixReviewedEfd(input: {
  spenderName: string; electionDate: string; asOfDate: string;
  family: readonly PhoenixEfdIndexRow[]; reports: readonly PhoenixReviewedEfdReport[];
}): PhoenixReviewedEfdDraft {
  const family = selectPhoenixEfdFamily(input.family, input.spenderName, input.electionDate, input.asOfDate);
  efdCheck(Array.isArray(input.reports) && input.reports.length === family.length, "incomplete_reviewed_report_set");
  const seen = new Set<string>(), financial = new Set<string>(), hashes = new Set<string>();
  const cycle = phoenixCandidateCycleForDate(input.electionDate);
  let supportCents = 0, opposeCents = 0;
  const reports = input.reports.map(report => {
    const row = family.find(r => r.documentId === report.documentId);
    efdCheck(row && row.sourceUrl === report.sourceUrl && row.filedDate === report.filedDate, "reviewed_publication_binding");
    efdCheck(!seen.has(report.documentId), "duplicate_reviewed_report"); seen.add(report.documentId);
    efdCheck(/^[a-f0-9]{64}$/u.test(report.sourceSha256) && !hashes.has(report.sourceSha256), "duplicate_or_invalid_whole_original");
    hashes.add(report.sourceSha256);
    efdCheck(isDeepStrictEqual(report.review, PHOENIX_EFD_REVIEW), "whole_single_candidate_new_report_review");
    efdCheck(text(report.reportedSpenderName) && efdNameKey(report.reportedSpenderName) === efdNameKey(input.spenderName) &&
      text(report.reportedCandidateName) && text(report.vendorName) && text(report.reportedOffice) &&
      /\bCOUNCIL\b/u.test(efdNameKey(report.reportedOffice)), "reported_parties_or_office");
    const district = /\bDISTRICT (?:NO )?(\d{1,2})\b/u.exec(efdNameKey(report.reportedOffice));
    efdCheck(report.reportedDistrictNumber === (district ? Number(district[1]) : null), "reported_district_literal");
    efdCheck(efdDate(report.expenditureDate) && report.expenditureDate >= cycle.cycleStart &&
      report.expenditureDate <= input.electionDate && report.expenditureDate <= report.filedDate &&
      Number.isSafeInteger(report.amountCents) && report.amountCents > 0 &&
      Number.isSafeInteger(report.reviewedPageCount) && report.reviewedPageCount >= 1 && report.reviewedPageCount <= 50 &&
      ["support", "oppose"].includes(report.supportOppose), "reviewed_expenditure_controls");
    const occurrence = JSON.stringify([efdNameKey(report.vendorName), report.expenditureDate, report.amountCents,
      efdNameKey(report.reportedCandidateName), report.supportOppose]);
    efdCheck(!financial.has(occurrence), "indistinguishable_expenses_require_review"); financial.add(occurrence);
    if (report.supportOppose === "support") supportCents = efdAdd(supportCents, report.amountCents);
    else opposeCents = efdAdd(opposeCents, report.amountCents);
    return { ...report, review: { ...report.review } };
  });
  efdCheck(family.every(r => seen.has(r.documentId)), "incomplete_reviewed_report_set");
  return { spenderName: input.spenderName, reports, occurrenceCount: reports.length, supportCents, opposeCents };
}
