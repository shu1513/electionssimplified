import { createHash } from "node:crypto";
import {
  DELAWARE_CFRS_PAGES,
  type DelawareCfrsResponseCapture,
} from "./delawareCfrsClient.js";
import {
  extractDelawareGridTotal,
  parseDelawareAmountCents,
  parseDelawareCommitteeGridJson,
  parseDelawareFiledReportsHtml,
  parseDelawareThirdPartyReceiptsCsv,
  type DelawareFiledReportRow,
} from "./delawareCfrsParsers.js";
import {
  closeDelawareNativeLedger,
  decodeDelawareExpenseNativePage,
  decodeDelawareReceiptNativePage,
  type DelawareNativeLedgerRow,
} from "./delawareNativeLedger.js";
import {
  readDelawareThirdPartyFinancialReport,
  extractDelawareThirdPartyFinancialPdf,
  type DelawareThirdPartyFinancialReport,
  type DelawareThirdPartyPdfOccurrence,
} from "./delawareThirdPartyFinancialReport.js";

export type DelawareOutsidePayerScope = {
  cfId: string;
  memberId: number;
  committeeName: string;
  committeeType: "04";
};
export type DelawareOutsideCandidateScope = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  electionDate: string;
  electionStage: "general";
  candidateName: string;
  officeName: string;
  district: string | null;
  party: string;
  receivingCfId: string;
  receivingMemberId: number;
  receivingCommitteeName: string;
};
export type DelawareOutsideSourcePacket = {
  registry: readonly DelawareCfrsResponseCapture[];
  payerOrganization: readonly DelawareCfrsResponseCapture[];
  receiverIdentity: readonly DelawareCfrsResponseCapture[];
  candidateCycleAuthority: readonly DelawareCfrsResponseCapture[];
  allVersionReports: readonly DelawareCfrsResponseCapture[];
  latestAccountReport: readonly DelawareCfrsResponseCapture[];
  genericMemberReceipts: readonly DelawareCfrsResponseCapture[];
  thirdPartyReceiptExport: readonly DelawareCfrsResponseCapture[];
  expenses: readonly DelawareCfrsResponseCapture[];
  reportPdfs: readonly DelawareCfrsResponseCapture[];
  /** Retained diagnostics only; an unsupported TP-native facet is never money/zero authority. */
  unsupportedFacets?: readonly DelawareCfrsResponseCapture[];
};
export type DelawareVerifiedThirdPartyOutsideProof = {
  version: 1;
  scope: "reported_third_party_outside_expenses";
  candidateWideZeroAuthority: false;
  candidate: DelawareOutsideCandidateScope;
  payer: DelawareOutsidePayerScope;
  qualificationBasis: "source_reported_candidate_period_within_cycle";
  reports: readonly {
    fileName: string;
    sourceUrl: string;
    memberId: number;
    filingCalendarId: number;
    periodStart: string;
    periodEnd: string;
    pdfSha256: string;
    inventoryFingerprint: string;
    financialFingerprint: string;
    currentAuthority: "sole_report_in_complete_period_inventory";
  }[];
  allocations: readonly {
    transactionId: number;
    reportFileName: string;
    occurrence: number;
    date: string;
    amountCents: number;
    direction: "support" | "oppose";
    literalTarget: string;
    sourceNativeCategory: string;
    nativeRowFingerprint: string;
    qualificationReportFileName: string;
  }[];
  sourceMetadata: readonly Omit<DelawareCfrsResponseCapture, "body">[];
};
const origin = "https://cfrs.elections.delaware.gov";
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const display = (v: string) => v.replace(/\s+/gu, " ").trim();
const transport = (v: string) => display(v.replace(/,/g, " "));
function fail(v: string): never {
  throw new Error("Delaware outside source: " + v);
}
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  const ordered = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(ordered)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, val]) => [k, ordered(val)]),
          )
        : x;
  return JSON.stringify(ordered(v));
}
function civil(v: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v + "T00:00:00Z")) ||
    new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v
  )
    fail("invalid civil date");
  return v;
}
function date(v: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) fail("invalid published date");
  return civil(`${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
}
function sum(values: readonly number[]) {
  let n = 0;
  for (const v of values) {
    n += v;
    if (!Number.isSafeInteger(n)) fail("unsafe cash sum");
  }
  return n;
}
function text(c: DelawareCfrsResponseCapture): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(c.body);
}
function rawString(r: DelawareNativeLedgerRow, k: string): string {
  const v = r.rawFields[k];
  if (typeof v !== "string") fail("missing native financial field " + k);
  return v;
}
function url(c: DelawareCfrsResponseCapture): URL {
  const u = new URL(c.url);
  if (u.origin !== origin || u.hash || u.username || u.password)
    fail("wrong official URL");
  return u;
}
function capture(c: DelawareCfrsResponseCapture) {
  if (
    !Buffer.isBuffer(c.body) ||
    c.body.length !== c.byteCount ||
    c.byteCount > 4 * 1024 * 1024 ||
    hash(c.body) !== c.sha256 ||
    !/^[a-f0-9]{64}$/.test(c.sha256) ||
    c.status !== 200 ||
    c.requestScopeRedacted ||
    !Number.isSafeInteger(c.attempt) ||
    c.attempt < 1
  )
    fail("invalid/redacted source envelope");
  for (const t of [c.startedAt, c.completedAt])
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t) ||
      !Number.isFinite(Date.parse(t)) ||
      new Date(t).toISOString() !== t
    )
      fail("invalid original capture time");
  if (
    c.startedAt > c.completedAt ||
    !["GET", "POST"].includes(c.method) ||
    (c.method === "GET" ? c.financeFields !== null : c.financeFields === null)
  )
    fail("invalid request envelope");
  const u = url(c);
  if (!(Object.values(DELAWARE_CFRS_PAGES) as string[]).includes(u.pathname))
    fail("unrecognized public source path");
  const queryKeys: Record<string, readonly string[]> = {
    "/Public/ShowReview": [
      "memberID",
      "memVersID",
      "cTypeCode",
      "ftype",
      "fpath",
      "fname",
      "isPublic",
    ],
    "/Public/FiledReports": ["FileName", "CommitteeID", "FilingCalendarID"],
    "/Public/_ViewFiledReports": [
      "ajax",
      "Grid-page",
      "Grid-size",
      "Grid-orderBy",
      "Grid-groupBy",
      "Grid-filter",
      "theme",
    ],
    "/Public/ExportCSVNew": ["page", "orderBy", "filter", "Grid-size", "theme"],
    "/Public/ExportCSVNew_TP": [
      "page",
      "orderBy",
      "filter",
      "Grid-size",
      "theme",
    ],
    "/Public/ExportExpensestoCsv": [
      "page",
      "orderBy",
      "filter",
      "Grid-size",
      "theme",
    ],
  };
  const allowedKeys = queryKeys[u.pathname] ?? ["theme", "Grid-size"];
  const seen = new Set<string>();
  for (const [key, value] of u.searchParams) {
    if (!allowedKeys.includes(key)) fail("unrecognized public query selector");
    if (seen.has(key)) fail("duplicate public query selector");
    seen.add(key);
    if (
      [
        "filter",
        "Grid-filter",
        "orderBy",
        "Grid-orderBy",
        "Grid-groupBy",
      ].includes(key) &&
      !["", "~"].includes(value)
    )
      fail("active public query filter/sort");
    if (key === "theme" && value !== "vista") fail("wrong source theme");
    if (
      u.pathname.includes("Export") &&
      (
        {
          page: "1",
          orderBy: "~",
          filter: "~",
          "Grid-size": "15",
          theme: "vista",
        } as Record<string, string>
      )[key] !== value
    )
      fail("wrong full export query scope");
    if (
      u.pathname === "/Public/ShowReview" &&
      ["fpath", "fname"].includes(key) &&
      value !== ""
    )
      fail("active unknown SO document selector");
  }
}
function path(
  c: DelawareCfrsResponseCapture,
  p: string,
  method: "GET" | "POST",
) {
  if (url(c).pathname !== p || c.method !== method)
    fail("wrong source route " + p);
}
function packet(caps: readonly DelawareCfrsResponseCapture[]) {
  if (!caps.length || caps.length > 120) fail("missing/capped source facet");
  caps.forEach((c, i) => {
    capture(c);
    if (i && caps[i - 1]!.completedAt > c.startedAt)
      fail("source packet out of order");
  });
}
function at(
  caps: readonly DelawareCfrsResponseCapture[],
  p: string,
  method: "GET" | "POST",
  required = true,
): DelawareCfrsResponseCapture[] {
  const found = caps.filter(
    (c) => url(c).pathname === p && c.method === method,
  );
  if (required && !found.length) fail("missing source route " + p);
  return found;
}
function one(
  caps: readonly DelawareCfrsResponseCapture[],
  p: string,
  method: "GET" | "POST",
) {
  const found = at(caps, p, method);
  if (found.length !== 1) fail("ambiguous source route " + p);
  return found[0]!;
}
function search(
  c: DelawareCfrsResponseCapture,
  expected: Record<string, string>,
  allowed: readonly string[] = [],
) {
  if (c.method !== "POST" || !c.financeFields)
    fail("missing actual search fields");
  for (const [k, v] of Object.entries(expected))
    if (c.financeFields[k] !== v) fail("wrong source selector " + k);
  for (const k of ["filter", "orderBy", "groupBy"])
    if (
      c.financeFields[k] !== undefined &&
      !["", "~"].includes(c.financeFields[k]!)
    )
      fail("nonempty source page filtering/sort");
  for (const [k, v] of Object.entries(c.financeFields))
    if (
      v !== "" &&
      !Object.hasOwn(expected, k) &&
      !allowed.includes(k) &&
      !(["btnSearch", "Submit"].includes(k) && v === "Search")
    )
      fail("unexpected active source filter " + k);
}
function scopedSearch(
  caps: readonly DelawareCfrsResponseCapture[],
  p: string,
  member: number,
  name: string,
  kind: "receipts" | "expenses" | "reports",
  extra: Record<string, string> = {},
) {
  const candidates = at(caps, p, "POST");
  candidates.forEach((x) =>
    search(x, {
      MemberId: String(member),
      [kind === "receipts"
        ? "txtReceivingRegistrant"
        : kind === "expenses"
          ? "txtRegistrant"
          : "txtCommitteeName"]: name,
      ...extra,
    }),
  );
  const c = candidates.at(-1)!;
  search(c, {
    MemberId: String(member),
    [kind === "receipts"
      ? "txtReceivingRegistrant"
      : kind === "expenses"
        ? "txtRegistrant"
        : "txtCommitteeName"]: name,
    ...extra,
  });
  if (
    caps.some(
      (x) =>
        /_(?:ViewReceiptsCustom|ViewExpensesCustom|ViewFiledReports)$|Export/.test(
          url(x).pathname,
        ) && x.startedAt < c.completedAt,
    )
  )
    fail("source rows/export precede their actual search");
  return c;
}
function strip(s: string): string {
  return display(
    s
      .replace(/<[^>]*>/g, " ")
      .replace(/&(?:nbsp|#160);/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))),
  );
}
function table(html: string, id: string): string[][] {
  const match = new RegExp(
    `<table\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/table>`,
    "i",
  ).exec(html);
  if (!match) fail("missing SO table " + id);
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(match[1]!);
  if (!body) fail("missing SO table body");
  return [...body[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      strip(c[1]!),
    ),
  );
}
function label(html: string, name: string): string {
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
    strip(c[1]!),
  );
  const i = cells.findIndex((c) => c === name);
  if (i < 0 || !cells[i + 1]) fail("missing SO identity " + name);
  return cells[i + 1]!;
}
// Literal observed Cloudflare injection, with only its two transport parameters variable.
const challengeShape = `<script>(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:__R__,t:__T__};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);if('loading'!==document.readyState)c();else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script>`;
/** Derived SO semantic comparison only. Source bodies/hashes are never rewritten. */
export function fingerprintDelawareThirdPartyOrganizationHtml(
  html: string,
): string {
  const email = (hex: string) => {
    if (!/^(?:[0-9a-f]{2}){3,512}$/i.test(hex))
      fail("unsupported Cloudflare email encoding");
    const bytes = Buffer.from(hex, "hex"),
      key = bytes[0]!;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(1).map((b) => b ^ key),
    );
    if (!/^[^\s@]+@[^\s@]+$/.test(decoded))
      fail("unsupported public email projection");
    return "public-email-sha256:" + hash(decoded);
  };
  const projected = html
    .replace(
      /(data-cfemail=["'])([0-9a-f]+)(["'])/gi,
      (_, prefix, hex, suffix) => prefix + email(hex) + suffix,
    )
    .replace(
      /(\/cdn-cgi\/l\/email-protection#)([0-9a-f]+)/gi,
      (_, prefix, hex) => prefix + email(hex),
    )
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) => {
      if (!script.includes("window.__CF$cv$params")) return script;
      const normalized = script
        .replace(/r:'[0-9a-f]+'/g, "r:__R__")
        .replace(/t:'[A-Za-z0-9+/=]+'/g, "t:__T__");
      if (normalized !== challengeShape)
        fail("unknown Cloudflare challenge structure");
      return "";
    });
  return hash(projected);
}
function organization(
  caps: readonly DelawareCfrsResponseCapture[],
  member: number,
  type: string,
  name: string,
  versions: readonly number[],
) {
  const found = at(caps, "/Public/ShowReview", "GET");
  if (found.length !== versions.length)
    fail("missing complete published SO editions");
  return versions.map((version) => {
    const matches = found.filter(
      (c) => url(c).searchParams.get("memVersID") === String(version),
    );
    if (matches.length !== 1) fail("ambiguous/missing source SO edition");
    const c = matches[0]!,
      u = url(c);
    if (
      u.searchParams.get("memberID") !== String(member) ||
      u.searchParams.get("cTypeCode") !== type ||
      u.searchParams.get("ftype") !== "SO" ||
      u.searchParams.get("isPublic") !== "true"
    )
      fail("wrong SO request scope");
    const html = text(c);
    if (label(html, "Committee Name:") !== display(name))
      fail("SO owner name mismatch");
    return html;
  });
}
function registry(
  caps: readonly DelawareCfrsResponseCapture[],
  scope: { cfId: string; memberId: number; committeeName: string },
  type: string,
) {
  const posts = at(caps, "/Public/Search", "POST");
  posts.forEach((c) => {
    const f = c.financeFields;
    if (
      !f ||
      (f.txtCommitteeName ?? "") !== "" ||
      !["", scope.cfId].includes(f.txtCommitteeID ?? "")
    )
      fail("registry search cannot prove complete same-CF SO editions");
    search(c, { CommitteeType: type }, ["txtCommitteeID"]);
  });
  const grids = at(caps, "/Public/_ViewCommittees", "POST");
  if (grids.some((c) => c.startedAt < posts.at(-1)!.completedAt))
    fail("registry rows precede their actual complete-scope search");
  let total: number | null = null;
  const raw: Record<string, unknown>[] = [];
  grids.forEach((c, i) => {
    search(c, { page: String(i + 1), size: "500" }, [
      "orderBy",
      "groupBy",
      "filter",
    ]);
    const parsed = parseDelawareCommitteeGridJson(text(c));
    if (
      parsed.total === null ||
      !Number.isSafeInteger(parsed.total) ||
      parsed.total < 1 ||
      (total !== null && parsed.total !== total)
    )
      fail("registry completeness changed");
    total = parsed.total;
    const rows = JSON.parse(text(c)).data as Record<string, unknown>[];
    if (i < grids.length - 1 && rows.length !== 500) fail("registry page gap");
    raw.push(...rows);
  });
  if (raw.length !== total) fail("registry incomplete");
  const members = raw.filter((r) => r.Committee_Id === scope.cfId);
  if (
    !members.length ||
    members.some(
      (r) => r.MemberID !== scope.memberId || r.CommitteeTypeCode !== type,
    )
  )
    fail("registry CF/member/type ambiguous");
  const versions = members.map((r) => r.MemberVersID);
  if (
    versions.some(
      (v) => typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0,
    )
  )
    fail("registry missing source SO version");
  const distinct = [...new Set(versions as number[])].sort((a, b) => a - b);
  if (
    members.some(
      (r) =>
        display(String(r.CommitteeName)) !== display(scope.committeeName) ||
        r.CommitteeStatus !== "Active",
    )
  )
    fail("ambiguous published registry owner identities");
  const identityKeys = [
    "Committee_Id",
    "MemberID",
    "MemberVersID",
    "CommitteeTypeCode",
    "CommitteeName",
    "CommitteeStatus",
    "OfficeSought",
    "Office",
    "District",
    "DistrictName",
    "County",
  ];
  for (const version of distinct) {
    const sameEdition = members.filter((r) => r.MemberVersID === version);
    const identities = sameEdition.map((r) =>
      Object.fromEntries(identityKeys.map((k) => [k, r[k]])),
    );
    if (identities.some((v) => !equal(v, identities[0])))
      fail("conflicting owner/context rows within published SO edition");
  }
  return { versions: distinct, members };
}
function reports(
  caps: readonly DelawareCfrsResponseCapture[],
  member: number,
  name: string,
  cf: string,
  current = false,
) {
  scopedSearch(
    caps,
    "/Public/ViewFiledReports",
    member,
    name,
    "reports",
    current ? { hdnViewCurrent: "true", chkViewCurrReport: "on" } : {},
  );
  const pages = at(caps, "/Public/_ViewFiledReports", "GET");
  const rows: DelawareFiledReportRow[] = [];
  let total: number | null = null;
  pages.forEach((c, i) => {
    const u = url(c);
    if (
      u.searchParams.get("Grid-page") !== String(i + 1) ||
      u.searchParams.get("Grid-size") !== "500"
    )
      fail("report inventory page scope");
    const p = parseDelawareFiledReportsHtml(text(c));
    if (p.total === null || (total !== null && total !== p.total))
      fail("report inventory count changed");
    total = p.total;
    rows.push(...p.rows);
  });
  if (
    !rows.length ||
    rows.length !== total ||
    rows.some(
      (r) =>
        r.cfId !== cf ||
        display(r.committeeName) !== display(name) ||
        !r.document ||
        r.document.memberId !== member,
    )
  )
    fail("incomplete/wrong report inventory");
  const keys = rows.map((r) => r.document!.publicReportFileName);
  if (new Set(keys).size !== keys.length) fail("duplicate report identity");
  if (current && rows.length !== 1) fail("ambiguous account current pointer");
  return rows;
}
function pdfCapture(
  caps: readonly DelawareCfrsResponseCapture[],
  r: DelawareFiledReportRow,
) {
  const doc = r.document!;
  const found = caps.filter((c) => {
    const u = url(c);
    return (
      u.pathname === "/Public/FiledReports" &&
      u.searchParams.get("FileName") === doc.publicReportFileName
    );
  });
  if (found.length !== 1) fail("missing/duplicate financial PDF");
  const c = found[0]!,
    u = url(c);
  path(c, "/Public/FiledReports", "GET");
  if (
    u.searchParams.get("CommitteeID") !== String(doc.memberId) ||
    u.searchParams.get("FilingCalendarID") !== String(doc.filingCalendarId) ||
    !c.contentType?.includes("pdf")
  )
    fail("wrong financial PDF owner");
  return c;
}
function nativePages(
  caps: readonly DelawareCfrsResponseCapture[],
  kind: "receipts" | "expenses",
) {
  const p =
    kind === "receipts"
      ? "/Public/_ViewReceiptsCustom"
      : "/Public/_ViewExpensesCustom";
  const found = at(caps, p, "POST");
  const ids = new Set<number>();
  const rows: DelawareNativeLedgerRow[] = [];
  found.forEach((c, i) => {
    search(c, { page: String(i + 1), size: "500" }, [
      "orderBy",
      "groupBy",
      "filter",
    ]);
    const decoded =
      kind === "receipts"
        ? decodeDelawareReceiptNativePage(text(c))
        : decodeDelawareExpenseNativePage(text(c));
    if (
      (i < found.length - 1 && decoded.rows.length !== 500) ||
      (i === found.length - 1 && decoded.rows.length === 500)
    )
      fail("incomplete native paging");
    decoded.rows.forEach((r, j) => {
      if (ids.has(r.transactionId)) {
        const prev = rows.at(-1);
        if (
          j !== 0 ||
          !prev ||
          prev.transactionId !== r.transactionId ||
          !equal(prev.rawFields, r.rawFields)
        )
          fail("conflicting/repeated native ID");
      } else {
        ids.add(r.transactionId);
        rows.push(r);
      }
    });
  });
  return { captures: found, rows };
}
function tuples(values: readonly unknown[]) {
  return values.map(canonical).sort();
}
function cash(
  caps: readonly DelawareCfrsResponseCapture[],
  tp: readonly DelawareCfrsResponseCapture[],
  payer: DelawareOutsidePayerScope,
) {
  const generic = scopedSearch(
    caps,
    "/Public/ViewReceipts",
    payer.memberId,
    payer.committeeName,
    "receipts",
  );
  one(caps, "/Public/ViewReceiptsMain", "GET");
  const { rows } = nativePages(caps, "receipts"),
    count = extractDelawareGridTotal(text(generic));
  if (count === null || rows.length !== count)
    fail("generic Member cash rendered/native mismatch");
  const tpSearch = scopedSearch(
    tp,
    "/Public/ViewReceipts",
    payer.memberId,
    payer.committeeName,
    "receipts",
    { hdnTP: "1", chkTP: "3" },
  );
  one(tp, "/Public/ViewReceiptsMain", "GET");
  const exported = one(tp, "/Public/ExportCSVNew_TP", "GET");
  const parsed = parseDelawareThirdPartyReceiptsCsv(text(exported));
  if (
    parsed.malformedRowCount ||
    parsed.rows.length !== count ||
    extractDelawareGridTotal(text(tpSearch)) !== count
  )
    fail("TP8 cash cardinality mismatch");
  const published = parsed.rows.map((r) => [
    date(r["Contribution Date"]),
    transport(r["Contributor Name"]),
    transport(r["Contributor Address"]),
    transport(r["Employer Name"]),
    transport(r["Filed Reports"]),
    transport(r["Employer Occupation"]),
    parseDelawareAmountCents(r["Contribution Amount"]),
    transport(r["Receiving Committee"]),
  ]);
  const projected = rows.map((r) => {
    if (
      rawString(r, "WC_ID") !== payer.cfId ||
      display(rawString(r, "ReceivingCommitteeName")) !==
        display(payer.committeeName)
    )
      fail("cash receiving account mismatch");
    if (
      r.amountCents < 0 ||
      ![
        "Cash",
        "Check",
        "Credit Card",
        "Electronic Fund Transfer",
        "EFT",
      ].includes(display(rawString(r, "ContributionType")))
    )
      fail("unknown/returned/noncash payer receipt");
    return [
      r.date,
      transport(rawString(r, "ContributorName")),
      transport(rawString(r, "ContributorAddress")),
      transport(rawString(r, "EmployerName")),
      transport(rawString(r, "OccupationTitle")),
      transport(rawString(r, "FileAmendedVersion")),
      r.amountCents,
      transport(rawString(r, "ReceivingCommitteeName")),
    ];
  });
  if (!equal(tuples(published), tuples(projected)))
    fail("TP8 literal positional/full native cash mismatch");
  return rows;
}
function expenses(
  caps: readonly DelawareCfrsResponseCapture[],
  payer: DelawareOutsidePayerScope,
) {
  const searched = scopedSearch(
    caps,
    "/Public/OtherSearch",
    payer.memberId,
    payer.committeeName,
    "expenses",
    { CommitteeType: "04" },
  );
  const renderedCount = extractDelawareGridTotal(text(searched));
  if (renderedCount === null) fail("missing expense rendered count");
  const native = nativePages(caps, "expenses");
  const closed = closeDelawareNativeLedger({
    pages: native.captures.map((c, i) => ({
      pageNumber: i + 1,
      pageSize: 500,
      page: decodeDelawareExpenseNativePage(text(c)),
    })),
    renderedCount,
    csv: text(one(caps, "/Public/ExportExpensestoCsv", "GET")),
  });
  closed.rows.forEach((r) => {
    if (
      rawString(r, "CCF_ID") !== payer.cfId ||
      display(rawString(r, "RegistrantName")) !==
        display(payer.committeeName) ||
      r.amountCents < 0 ||
      display(rawString(r, "ExpenseCategory")) !== "Other Expenses" ||
      ![
        "Cash",
        "Check",
        "Credit Card",
        "Electronic Fund Transfer",
        "EFT",
        "Wire Transfer",
      ].includes(display(rawString(r, "ExpenseMethod"))) ||
      rawString(r, "Fixed_Asset") !== "No"
    )
      fail("unknown/refund/credit/asset payer expense");
  });
  return closed.rows;
}
function matchFinancial(
  native: readonly DelawareNativeLedgerRow[],
  pdf: readonly DelawareThirdPartyPdfOccurrence[],
  kind: "receipts" | "expenses",
) {
  const nativeTuple = (r: DelawareNativeLedgerRow) => [
    r.date,
    r.amountCents,
    display(
      rawString(r, kind === "receipts" ? "ContributorName" : "PayeeName"),
    ),
    kind === "receipts" ? "" : display(rawString(r, "VendorName")),
  ];
  const pdfTuple = (r: DelawareThirdPartyPdfOccurrence) => [
    r.date,
    r.amountCents,
    display(r.name),
    display(r.vendor),
  ];
  if (!equal(tuples(native.map(nativeTuple)), tuples(pdf.map(pdfTuple))))
    fail("complete PDF/native financial identity mismatch");
  const queues = new Map<string, DelawareNativeLedgerRow[]>();
  native.forEach((r) => {
    const k = canonical(nativeTuple(r)),
      q = queues.get(k) ?? [];
    q.push(r);
    queues.set(k, q);
  });
  let addressDifferences = 0;
  const pdfGroups = new Map<string, DelawareThirdPartyPdfOccurrence[]>();
  pdf.forEach((r) => {
    const key = canonical(pdfTuple(r));
    const rows = pdfGroups.get(key) ?? [];
    rows.push(r);
    pdfGroups.set(key, rows);
  });
  // A unique exact monetary identity can carry a different address snapshot.
  // Repeated identities need address corroboration and equivalent source facts;
  // otherwise an ordinal pairing would invent which native ID has which target.
  for (const [key, rows] of queues) {
    if (rows.length < 2) continue;
    const occurrences = pdfGroups.get(key)!;
    const nativeAddress = (r: DelawareNativeLedgerRow) => transport(
      rawString(r, kind === "receipts" ? "ContributorAddress" : "Address"),
    );
    if (!equal(tuples(rows.map(nativeAddress)), tuples(occurrences.map(r => transport(r.address)))))
      fail("repeated PDF/native monetary identities lack address corroboration");
    for (const address of new Set(rows.map(nativeAddress))) {
      const nativeFacts = rows.filter(r => nativeAddress(r) === address).map(r => [
        rawString(r, kind === "receipts" ? "ContributorType" : "PayeeType"),
        rawString(r, kind === "receipts" ? "ContributionType" : "ExpenseMethod"),
        rawString(r, "FilingPeriodName"),
        rawString(r, "FileAmendedVersion"),
      ]);
      const targets = occurrences.filter(r => transport(r.address) === address).map(r => r.target ?? null);
      if (new Set(nativeFacts.map(canonical)).size !== 1 || new Set(targets.map(canonical)).size !== 1)
        fail("repeated monetary identities have ambiguous source class/mechanism/target");
    }
  }
  const matched = pdf.map((r) => {
    const queue = queues.get(canonical(pdfTuple(r)))!;
    const address = transport(r.address);
    const index = queue.findIndex(row => transport(rawString(row,
      kind === "receipts" ? "ContributorAddress" : "Address")) === address);
    const row = queue.splice(index < 0 ? 0 : index, 1)[0]!;
    if (transport(rawString(row, kind === "receipts" ? "ContributorAddress" : "Address")) !== address)
      addressDifferences += 1;
    return row;
  });
  return { matched, addressDifferences };
}
function noSupplementalActivity(r: DelawareThirdPartyFinancialReport) {
  const controls = Object.values(r.supplementalTotals).flat();
  if (
    controls.some((v) => v !== 0) ||
    r.controls.receipts.anonymousCents !== 0 ||
    r.controls.expenditures.anonymousCents !== 0
  )
    fail("supplemental/anonymous financial scope unresolved");
  const headers = new Set([
    "Date Received",
    "Date Expended",
    "Date Paid",
    "Date Eliminated",
    "Contributor Name",
    "Contributor Mailing Address",
    "Description of",
    "Contribution",
    "Est. Amount Received",
    "Person or Activity Name",
    "Person or Activity",
    "Location or Mailing Address",
    "Vendor",
    "Expenditure",
    "Est. Amount",
    "Expended",
    "Transaction Id",
    "Lender",
    "Endorser",
    "Description of Security",
    "Int. Rate",
    "Amount",
    "Received",
    "Description",
    "Int",
    "Rate",
    "Previous",
    "Loan",
    "Balance",
    "Payments",
    "Made",
    "Reimburser",
    "Description of Activity",
    "Activity Date",
    "Total Expense",
    "Reimbursement",
    "Payee",
    "Description of Asset",
    "Location of Asset (Physical Address)",
    "Value of Asset",
    "Disposition of Asset",
  ]);
  const monetary = r.supplementalSourcePages.flatMap((p) =>
    p.cells.filter((c) => /^(?:-?\$|\(-?\$)/.test(c.text)),
  );
  if (monetary.length !== 16 || monetary.some((c) => !/^\$0\.00$/.test(c.text)))
    fail("supplemental financial activity beyond zero controls");
  for (const p of r.supplementalSourcePages) {
    const dates = p.cells.filter(
      (c) =>
        c.x < 200 &&
        /^Date (?:Received|Expended|Paid|Eliminated)$/.test(c.text),
    );
    if (!dates.length) fail("unknown supplemental table layout");
    for (const d of dates) {
      const totals = p.cells
        .filter(
          (c) =>
            c.x < 590 && /^(?:TOTAL|GRAND TOTAL)\b/.test(c.text) && c.y < d.y,
        )
        .sort((a, b) => b.y - a.y);
      if (!totals.length) fail("missing supplemental table control");
      if (
        p.cells.some(
          (c) =>
            c.x >= 38 &&
            c.x < 760 &&
            c.y <= d.y + 1.5 &&
            c.y > totals[0]!.y + 2 &&
            !headers.has(c.text),
        )
      )
        fail("unreconciled supplemental row/body identity");
    }
  }
}
function validScope(
  p: DelawareOutsidePayerScope,
  c: DelawareOutsideCandidateScope,
) {
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (
    !/^04\d{6}$/.test(p.cfId) ||
    p.committeeType !== "04" ||
    !Number.isSafeInteger(p.memberId) ||
    p.memberId <= 0 ||
    !p.committeeName.trim() ||
    !/^01\d{6}$/.test(c.receivingCfId) ||
    !Number.isSafeInteger(c.receivingMemberId) ||
    c.receivingMemberId <= 0 ||
    !uuid.test(c.candidateId) ||
    !uuid.test(c.electionId) ||
    c.electionStage !== "general" ||
    Number(civil(c.electionDate).slice(0, 4)) !== c.electionYear ||
    !c.candidateName.trim() ||
    !c.receivingCommitteeName.trim() ||
    !c.party.trim()
  )
    fail("invalid exact local/source context");
  // Initial finite source scope; unknown seat/office formats are never guessed.
  if (
    ![
      "Attorney General",
      "Governor",
      "Lieutenant Governor",
      "State Treasurer",
      "Insurance Commissioner",
      "Auditor of Accounts",
    ].includes(c.officeName) ||
    c.district !== null
  )
    fail("unsupported exact office/seat context");
}
function sameName(a: string, b: string) {
  return display(a).toUpperCase() === display(b).toUpperCase();
}
function sourcePerson(s: string) {
  return display(s).replace(/^(?:Ms\.|Mr\.|Mrs\.) /, "");
}
function receiver(
  caps: readonly DelawareCfrsResponseCapture[],
  c: DelawareOutsideCandidateScope,
) {
  const owner = {
    cfId: c.receivingCfId,
    memberId: c.receivingMemberId,
    committeeName: c.receivingCommitteeName,
  };
  const reg = registry(caps, owner, "01"),
    html = organization(
      caps,
      c.receivingMemberId,
      "01",
      c.receivingCommitteeName,
      reg.versions,
    );
  const identities = html.map((h) => ({
    election: table(h, "Viewelection"),
    person: table(h, "CandidateList").map((row) => [row[0]]),
  }));
  if (identities.some((identity) => !equal(identity, identities[0])))
    fail("unequal unresolved published receiver SO identities");
  const election = table(html[0]!, "Viewelection"),
    person = table(html[0]!, "CandidateList");
  if (
    election.length !== 1 ||
    election[0]!.length !== 5 ||
    election[0]![0] !== "State Office" ||
    election[0]![2] !== c.officeName ||
    election[0]![3] !== "-- Select District --" ||
    election[0]![4] !== c.party ||
    person.length !== 1 ||
    person[0]!.length !== 4
  )
    fail("receiver person/office/party source mismatch");
  const sourceName = sourcePerson(person[0]![0]!);
  // Exact local display normally agrees. The sole accepted relation is this actual
  // receiving committee/account + office/party source bridge, not a general nickname rule.
  const relation =
    c.receivingCfId === "01004199" &&
    c.receivingMemberId === 458984 &&
    sameName(c.receivingCommitteeName, "Friends of Kathy Jennings") &&
    sameName(c.candidateName, "Kathy Jennings") &&
    sourceName === "Kathleen Jennings" &&
    c.officeName === "Attorney General" &&
    c.party === "Democratic";
  if (!sameName(sourceName, c.candidateName) && !relation)
    fail("local/source candidate identity mismatch");
  return { sourceName, registry: reg, html };
}
async function candidatePeriods(
  caps: readonly DelawareCfrsResponseCapture[],
  c: DelawareOutsideCandidateScope,
) {
  const inventory = reports(
    caps,
    c.receivingMemberId,
    c.receivingCommitteeName,
    c.receivingCfId,
  );
  const accepted: {
    fileName: string;
    start: string;
    end: string;
    pdfSha256: string;
    inventoryFingerprint: string;
  }[] = [];
  for (const r of inventory) {
    // A published election label/owner/office/year proves only its actual dates.
    if (
      !new RegExp(`\\b${c.electionYear}\\b`).test(r.filingPeriodName) ||
      !/\b(?:General|Primary) Election\b/.test(r.filingPeriodName)
    )
      continue;
    if (
      r.filingYear !== String(c.electionYear) ||
      r.office !== "State Office - " + c.officeName
    )
      fail("receiver declared election/year/office mismatch");
    const covering = inventory.filter(
      (x) => x.document!.filingCalendarId === r.document!.filingCalendarId,
    );
    if (covering.length !== 1)
      fail("receiver candidacy report currentness ambiguous");
    const cap = pdfCapture(caps, r),
      extracted = await extractDelawareThirdPartyFinancialPdf(cap.body),
      cover = extracted.cover;
    const labels = extracted.pages[0]!.cells.filter((cell) =>
      /^ACCOUNT NUMBER\s*:/.test(cell.text),
    );
    if (
      labels.length !== 1 ||
      extracted.pages[0]!.cells.filter(
        (cell) =>
          Math.abs(cell.y - labels[0]!.y) < 3 && /^\d{8}$/.test(cell.text),
      )
        .map((cell) => cell.text)
        .join() !== c.receivingCfId
    )
      fail("receiver qualification PDF account mismatch");
    if (!cover.reportingPeriodFrom || !cover.reportingPeriodTo)
      fail("receiver qualification lacks actual dates");
    const start = date(cover.reportingPeriodFrom),
      end = date(cover.reportingPeriodTo);
    if (start > end || end.slice(0, 4) !== String(c.electionYear))
      fail("receiver qualification period/year mismatch");
    accepted.push({
      fileName: r.document!.publicReportFileName,
      start,
      end,
      pdfSha256: cap.sha256,
      inventoryFingerprint: hash(canonical(inventory)),
    });
  }
  if (!accepted.length) fail("no source-declared receiver candidacy period");
  return accepted;
}
type Phase = Awaited<ReturnType<typeof decodePhase>>;
async function decodePhase(
  p: DelawareOutsideSourcePacket,
  payer: DelawareOutsidePayerScope,
  c: DelawareOutsideCandidateScope,
) {
  for (const [k, v] of Object.entries(p))
    if (k !== "unsupportedFacets") packet(v);
  const reg = registry(p.registry, payer, "04"),
    org = organization(
      p.payerOrganization,
      payer.memberId,
      "04",
      payer.committeeName,
      reg.versions,
    );
  const receiverProof = receiver(p.receiverIdentity, c),
    sourceName = receiverProof.sourceName,
    periods = await candidatePeriods(p.candidateCycleAuthority, c);
  const publishedAffiliations = org.map((h) => table(h, "ViewCandiate"));
  if (publishedAffiliations.some((a) => !equal(a, publishedAffiliations[0])))
    fail("unequal unresolved published payer SO affiliations");
  const affiliations = publishedAffiliations[0]!;
  const inventory = reports(
      p.allVersionReports,
      payer.memberId,
      payer.committeeName,
      payer.cfId,
    ),
    latest = reports(
      p.latestAccountReport,
      payer.memberId,
      payer.committeeName,
      payer.cfId,
      true,
    )[0]!;
  const receipts = cash(
      p.genericMemberReceipts,
      p.thirdPartyReceiptExport,
      payer,
    ),
    outgoing = expenses(p.expenses, payer);
  const financial: {
    row: DelawareFiledReportRow;
    facts: DelawareThirdPartyFinancialReport;
    capture: DelawareCfrsResponseCapture;
  }[] = [];
  if (p.reportPdfs.length !== inventory.length)
    fail("missing/unclaimed report PDF");
  for (const row of inventory) {
    const cap = pdfCapture(p.reportPdfs, row),
      facts = await readDelawareThirdPartyFinancialReport(cap.body);
    if (
      facts.accountNumber !== payer.cfId ||
      !sameName(facts.organizationName, payer.committeeName)
    )
      fail("PDF payer identity mismatch");
    if (
      facts.periodEnd < facts.periodStart ||
      facts.reportDate < facts.periodEnd
    )
      fail("financial period/report date mismatch");
    noSupplementalActivity(facts);
    financial.push({ row, facts, capture: cap });
  }
  financial.sort((a, b) =>
    a.facts.periodStart.localeCompare(b.facts.periodStart),
  );
  for (let i = 0; i < financial.length; i++) {
    const current = financial[i]!,
      prior = financial[i - 1];
    if (
      financial.filter(
        (r) =>
          r.facts.periodStart === current.facts.periodStart &&
          r.facts.periodEnd === current.facts.periodEnd,
      ).length !== 1
    )
      fail("multiple current-period financial editions unresolved");
    if (
      prior &&
      (prior.facts.periodEnd >= current.facts.periodStart ||
        prior.facts.cover.endingBalanceCents !==
          current.facts.cover.beginningBalanceCents)
    )
      fail("overlap/balance-chain mismatch");
  }
  if (
    financial.at(-1)!.row.document!.publicReportFileName !==
    latest.document!.publicReportFileName
  )
    fail("account latest pointer contradicts financial history");
  const assignedReceipts = new Set<number>(),
    assignedExpenses = new Set<number>();
  const allocations: DelawareVerifiedThirdPartyOutsideProof["allocations"][number][] =
    [];
  let addressDifferences = 0;
  for (const r of financial) {
    const bound = (row: DelawareNativeLedgerRow) =>
      row.date >= r.facts.periodStart && row.date <= r.facts.periodEnd;
    const cashRows = receipts.filter(bound),
      expenseRows = outgoing.filter(bound);
    const receiptMatch = matchFinancial(cashRows, r.facts.receipts, "receipts");
    const expenseMatch = matchFinancial(
      expenseRows,
      r.facts.expenditures,
      "expenses",
    );
    const matched = expenseMatch.matched;
    addressDifferences += receiptMatch.addressDifferences + expenseMatch.addressDifferences;
    cashRows.forEach((row) => assignedReceipts.add(row.transactionId));
    expenseRows.forEach((row) => assignedExpenses.add(row.transactionId));
    if (
      sum(cashRows.map((row) => row.amountCents)) !==
        r.facts.cover.receiptsCents ||
      sum(expenseRows.map((row) => row.amountCents)) !==
        r.facts.cover.expendituresCents
    )
      fail("whole report financial control mismatch");
    r.facts.expenditures.forEach((row, i) => {
      const target = row.target;
      if (!target || row.amountCents <= 0) return;
      if (
        !sameName(target.candidateName, sourceName) ||
        target.officeName !== c.officeName ||
        target.party !== c.party
      )
        return;
      const relation = affiliations.filter(
        (a) =>
          a.length === 6 &&
          sameName(a[0]!, c.receivingCommitteeName) &&
          sourcePerson(a[1]!) === sourceName &&
          a[2] === c.officeName &&
          a[3] === c.party &&
          a[4] === (target.direction === "support" ? "Support" : "Oppose") &&
          a[5] === "Active",
      );
      if (relation.length !== 1)
        fail("literal target lacks exact source receiver bridge");
      const qualified = periods.filter(
        (period) => row.date >= period.start && row.date <= period.end,
      );
      if (qualified.length !== 1)
        fail(
          "explicit expense date lacks unique source candidacy-period qualification",
        );
      const native = matched[i]!;
      allocations.push({
        transactionId: native.transactionId,
        reportFileName: r.row.document!.publicReportFileName,
        occurrence: row.occurrence,
        date: row.date,
        amountCents: row.amountCents,
        direction: target.direction,
        literalTarget: target.literal,
        sourceNativeCategory: rawString(native, "ExpenseCategory"),
        nativeRowFingerprint: hash(canonical(native.rawFields)),
        qualificationReportFileName: qualified[0]!.fileName,
      });
    });
  }
  if (
    assignedReceipts.size !== receipts.length ||
    assignedExpenses.size !== outgoing.length
  )
    fail("financial rows outside complete current published periods");
  return {
    financial,
    receipts,
    outgoing,
    allocations,
    addressDifferences,
    reg,
    org,
    receiverProof,
    sourceName,
    periods,
    inventory,
    latest,
  };
}
function captures(p: DelawareOutsideSourcePacket) {
  return Object.entries(p)
    .filter(([k]) => k !== "unsupportedFacets")
    .flatMap(([, v]) => v);
}
/** Validate original public envelopes and order; this establishes no money authority. */
export function validateDelawareSourceCapturePacket(captures: readonly DelawareCfrsResponseCapture[]) {
  packet(captures);
}

/** Decode complete CF01 owner/SO source facts without asserting an election cycle. */
export function decodeDelawareCandidateOwnerSource(input: {
  captures: readonly DelawareCfrsResponseCapture[];
  owner: { cfId: string; memberId: number; committeeName: string };
}) {
  packet(input.captures);
  const ownerRegistry = registry(input.captures, input.owner, "01");
  const organizationHtml = organization(input.captures, input.owner.memberId, "01",
    input.owner.committeeName, ownerRegistry.versions);
  return { ownerRegistry, organizationHtml };
}

/** Decode actual all-version/current-pointer inventories; no maximum-edition guess. */
export function decodeDelawareReportInventorySource(input: {
  captures: readonly DelawareCfrsResponseCapture[];
  owner: { cfId: string; memberId: number; committeeName: string };
  current?: boolean;
}) {
  packet(input.captures);
  return reports(input.captures, input.owner.memberId, input.owner.committeeName,
    input.owner.cfId, input.current ?? false);
}
/** Pure immutable-byte source replay; emits positive report scopes only, never candidate-wide zero. */
export async function verifyDelawareThirdPartyOutsideSource(input: {
  payer: DelawareOutsidePayerScope;
  candidate: DelawareOutsideCandidateScope;
  before: DelawareOutsideSourcePacket;
  after: DelawareOutsideSourcePacket;
}): Promise<{
  proof?: DelawareVerifiedThirdPartyOutsideProof;
  diagnostics: string[];
}> {
  try {
    // Retain the caller generation before the first async PDF extraction.
    const cloneCaptures = (caps: readonly DelawareCfrsResponseCapture[]) =>
      caps.map((c) => ({
        ...c,
        body: Buffer.from(c.body),
        financeFields: c.financeFields === null ? null : { ...c.financeFields },
      }));
    const clonePacket = (
      p: DelawareOutsideSourcePacket,
    ): DelawareOutsideSourcePacket => ({
      registry: cloneCaptures(p.registry),
      payerOrganization: cloneCaptures(p.payerOrganization),
      receiverIdentity: cloneCaptures(p.receiverIdentity),
      candidateCycleAuthority: cloneCaptures(p.candidateCycleAuthority),
      allVersionReports: cloneCaptures(p.allVersionReports),
      latestAccountReport: cloneCaptures(p.latestAccountReport),
      genericMemberReceipts: cloneCaptures(p.genericMemberReceipts),
      thirdPartyReceiptExport: cloneCaptures(p.thirdPartyReceiptExport),
      expenses: cloneCaptures(p.expenses),
      reportPdfs: cloneCaptures(p.reportPdfs),
      ...(p.unsupportedFacets === undefined
        ? {}
        : { unsupportedFacets: cloneCaptures(p.unsupportedFacets) }),
    });
    const payer = { ...input.payer },
      candidate = { ...input.candidate },
      before = clonePacket(input.before),
      after = clonePacket(input.after);
    validScope(payer, candidate);
    const b = captures(before),
      a = captures(after);
    if (
      b.length + a.length > 240 ||
      b.reduce((n, c) => n + c.body.length, 0) +
        a.reduce((n, c) => n + c.body.length, 0) >
        128 * 1024 * 1024
    )
      fail("source generation budget exceeded");
    b.concat(a).forEach(capture);
    if (
      Math.max(...b.map((c) => Date.parse(c.completedAt))) >
      Math.min(...a.map((c) => Date.parse(c.startedAt)))
    )
      fail("closing authorities precede complete opening");
    const opening = await decodePhase(before, payer, candidate),
      closing = await decodePhase(after, payer, candidate);
    const stable = (p: Phase) => ({
      registry: p.reg,
      org: p.org.map(fingerprintDelawareThirdPartyOrganizationHtml),
      receiver: {
        ...p.receiverProof,
        html: p.receiverProof.html.map(
          fingerprintDelawareThirdPartyOrganizationHtml,
        ),
      },
      sourceName: p.sourceName,
      periods: p.periods,
      inventory: p.inventory,
      latest: p.latest,
      receipts: tuples(p.receipts.map((r) => r.rawFields)),
      expenses: tuples(p.outgoing.map((r) => r.rawFields)),
      pdfs: p.financial.map((r) => [r.row.document, r.facts.pdfSha256]),
      allocations: p.allocations,
    });
    if (!equal(stable(opening), stable(closing)))
      fail("opening/closing full current financial/source identity changed");
    if (!closing.allocations.length)
      return {
        diagnostics: [
          "No qualified positive literal financial allocations; no candidate zero authority.",
        ],
      };
    const proof: DelawareVerifiedThirdPartyOutsideProof = {
      version: 1,
      scope: "reported_third_party_outside_expenses",
      candidateWideZeroAuthority: false,
      candidate,
      payer,
      qualificationBasis: "source_reported_candidate_period_within_cycle",
      allocations: closing.allocations,
      reports: closing.financial.map((r) => ({
        fileName: r.row.document!.publicReportFileName,
        sourceUrl: r.capture.url,
        memberId: payer.memberId,
        filingCalendarId: r.row.document!.filingCalendarId,
        periodStart: r.facts.periodStart,
        periodEnd: r.facts.periodEnd,
        pdfSha256: r.facts.pdfSha256,
        inventoryFingerprint: hash(canonical(closing.inventory)),
        financialFingerprint: hash(
          canonical([
            closing.receipts
              .filter(
                (x) =>
                  x.date >= r.facts.periodStart && x.date <= r.facts.periodEnd,
              )
              .map((x) => x.rawFields),
            closing.outgoing
              .filter(
                (x) =>
                  x.date >= r.facts.periodStart && x.date <= r.facts.periodEnd,
              )
              .map((x) => x.rawFields),
          ]),
        ),
        currentAuthority: "sole_report_in_complete_period_inventory",
      })),
      sourceMetadata: b.concat(a).map(({ body: _, ...metadata }) => metadata),
    };
    return {
      proof,
      diagnostics: [
        ...(closing.addressDifferences > 0 ? [
          `${closing.addressDifferences} unique monetary identities have different PDF/native address snapshots; original source fields retained.`,
        ] : []),
        ...((before.unsupportedFacets?.length ?? 0) +
          (after.unsupportedFacets?.length ?? 0) >
        0
          ? [
              "Unsupported independent facets are retained diagnostic captures only, never zero or financial authority.",
            ]
          : []),
        "Qualified published candidate-period dates only; unfiled/additional payer reports and candidate-wide outside coverage remain unknown.",
      ],
    };
  } catch (error) {
    return {
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}
