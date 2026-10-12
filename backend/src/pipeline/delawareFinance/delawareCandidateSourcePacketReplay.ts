import { createHash } from "node:crypto";
import type { DelawareCfrsCandidateSourcePacket } from "./delawareCfrsArtifactAcquisition.js";
import {
  buildDelawareCfrsUrl,
  buildDelawareCommitteeSearchFields,
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
  buildDelawareReceiptsSearchFields,
  DELAWARE_CFRS_BASE_URL,
  DELAWARE_CFRS_EXPORT_QUERY,
  DELAWARE_CFRS_MAX_RESPONSE_BYTES,
  DELAWARE_CFRS_PAGES,
  isDelawareCfrsCaptureFieldAllowed,
  type DelawareCfrsResponseCapture,
} from "./delawareCfrsClient.js";
import {
  extractDelawareGridTotal,
  parseDelawareCommitteeGridJson,
  parseDelawareFiledReportsHtml,
  type DelawareFiledReportRow,
} from "./delawareCfrsParsers.js";
import {
  closeDelawareNativeLedger,
  decodeDelawareExpenseNativePage,
  decodeDelawareReceiptNativePage,
} from "./delawareNativeLedger.js";

export type DelawareCandidateSourcePacketReplayInput = {
  cfId: string;
  memberId: number;
  committeeName: string;
  requestWindow: { start: string; end: string } | null;
  captures: readonly DelawareCfrsResponseCapture[];
};
const captureKeys = [
  "body",
  "url",
  "method",
  "financeFields",
  "requestScopeRedacted",
  "attempt",
  "startedAt",
  "completedAt",
  "status",
  "contentType",
  "byteCount",
  "sha256",
];
const sourcePaths = new Set<string>([
  "/",
  ...Object.values(DELAWARE_CFRS_PAGES),
]);
const path = (c: DelawareCfrsResponseCapture) => new URL(c.url).pathname;
const text = (c: DelawareCfrsResponseCapture) =>
  new TextDecoder("utf-8", { fatal: true }).decode(c.body);
function fail(message: string): never {
  throw new Error(`Delaware candidate packet replay: ${message}`);
}
function date(value: string) {
  if (
    !/^\d{4}-\d\d-\d\d$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail("invalid request date");
  return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
}
function originalCaptures(values: readonly DelawareCfrsResponseCapture[]) {
  if (!Array.isArray(values) || !values.length || values.length > 1000)
    fail("capture bound");
  let totalBytes = 0;
  const captures = Array.from(values).map((c) => {
    if (
      !c ||
      typeof c !== "object" ||
      Object.keys(c).length !== captureKeys.length ||
      captureKeys.some((k) => !Object.hasOwn(c, k)) ||
      !Buffer.isBuffer(c.body)
    )
      fail("original envelope shape");
    const copy = {
      ...c,
      body: Buffer.from(c.body),
      financeFields: c.financeFields === null ? null : { ...c.financeFields },
    };
    if (
      !Number.isSafeInteger(c.byteCount) ||
      c.byteCount < 0 ||
      c.byteCount > DELAWARE_CFRS_MAX_RESPONSE_BYTES ||
      copy.body.length !== c.byteCount ||
      createHash("sha256").update(copy.body).digest("hex") !== c.sha256 ||
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      !Number.isSafeInteger(c.attempt) ||
      c.attempt < 1 ||
      !Number.isInteger(c.status) ||
      c.status < 100 ||
      c.status > 599 ||
      typeof c.requestScopeRedacted !== "boolean"
    )
      fail("original envelope integrity");
    for (const t of [c.startedAt, c.completedAt])
      if (
        typeof t !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t) ||
        !Number.isFinite(Date.parse(t)) ||
        new Date(t).toISOString() !== t
      )
        fail("original source time");
    if (
      c.startedAt > c.completedAt ||
      !["GET", "POST"].includes(c.method) ||
      (c.method === "GET"
        ? c.financeFields !== null
        : !c.financeFields ||
          typeof c.financeFields !== "object" ||
          Array.isArray(c.financeFields)) ||
      !(
        c.contentType === null ||
        (typeof c.contentType === "string" &&
          c.contentType.length <= 512 &&
          !/[\r\n\0]/.test(c.contentType))
      )
    )
      fail("original request envelope");
    const u = new URL(c.url);
    if (
      u.origin !== DELAWARE_CFRS_BASE_URL ||
      u.username ||
      u.password ||
      u.hash ||
      !sourcePaths.has(u.pathname) ||
      new Set([...u.searchParams.keys()]).size !== [...u.searchParams].length ||
      [...u.searchParams].some(
        ([k, v]) => !isDelawareCfrsCaptureFieldAllowed(k, v),
      ) ||
      Object.entries(c.financeFields ?? {}).some(
        ([k, v]) =>
          typeof v !== "string" || !isDelawareCfrsCaptureFieldAllowed(k, v),
      )
    )
      fail("unsafe original source scope");
    totalBytes += copy.body.length;
    if (totalBytes > 128 * 1024 * 1024) fail("capture byte bound");
    return copy;
  });
  captures.forEach((c, i) => {
    if (i && captures[i - 1]!.completedAt > c.startedAt)
      fail("out-of-order source captures");
  });
  return captures;
}
function scope(
  c: DelawareCfrsResponseCapture,
  expected: Record<string, string>,
) {
  if (c.requestScopeRedacted || c.method !== "POST" || !c.financeFields)
    fail("unavailable request scope");
  const projected = Object.fromEntries(
    Object.entries(expected).filter(([k, v]) =>
      isDelawareCfrsCaptureFieldAllowed(k, v),
    ),
  );
  if (
    Object.entries(projected).some(([k, v]) => c.financeFields![k] !== v) ||
    Object.entries(c.financeFields).some(([k, v]) => v !== (projected[k] ?? ""))
  )
    fail("wrong actual source selectors");
}
function one(
  caps: readonly DelawareCfrsResponseCapture[],
  route: string,
  method: "GET" | "POST",
) {
  const found = caps.filter((c) => path(c) === route && c.method === method);
  if (found.length !== 1) fail(`missing/ambiguous ${route}`);
  return found[0]!;
}
function query(
  c: DelawareCfrsResponseCapture,
  expected: Record<string, string>,
) {
  const actual = new URL(c.url).searchParams;
  if (
    [...actual].length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, v]) => actual.get(k) !== v)
  )
    fail("wrong actual query selectors");
}
function organizationUrls(html: string, memberId: number) {
  const urls = new Set<string>();
  for (const m of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/gi,
  )) {
    const raw = m[2]!.replace(/&amp;|&#38;/g, "&");
    if (!raw.startsWith("/Public/ShowReview?")) continue;
    const u = new URL(raw, DELAWARE_CFRS_BASE_URL);
    const f = Object.fromEntries(
      [...u.searchParams].map(([k, v]) => [k, v.trim()]),
    );
    if (f.memberID !== String(memberId) || f.ftype !== "SO") continue;
    const keys = [
      "memberID",
      "memVersID",
      "cTypeCode",
      "ftype",
      "fpath",
      "fname",
      "isPublic",
    ];
    if (
      [...u.searchParams].length !== keys.length ||
      Object.keys(f).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(f, k)) ||
      f.cTypeCode !== "01" ||
      !/^[1-9]\d*$/.test(f.memVersID!) ||
      !Number.isSafeInteger(Number(f.memVersID)) ||
      f.fpath !== "" ||
      f.fname !== "" ||
      f.isPublic !== "true"
    )
      fail("invalid observed SO link");
    urls.add(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.statementOfOrganization, f),
    );
  }
  return [...urls];
}

/** Re-decodes immutable captured source facts. No currentness, legal cycle or financial acceptance. */
export function decodeDelawareCandidateSourcePacketFromCaptures(
  input: DelawareCandidateSourcePacketReplayInput,
): DelawareCfrsCandidateSourcePacket {
  const { cfId, memberId } = input,
    committeeName = input.committeeName.trim();
  if (
    !/^01\d{6}$/.test(cfId) ||
    !Number.isSafeInteger(memberId) ||
    memberId <= 0 ||
    !committeeName
  )
    fail("invalid receiver scope");
  const requestWindow =
    input.requestWindow === null ? null : { ...input.requestWindow };
  const start = requestWindow === null ? "" : date(requestWindow.start),
    end = requestWindow === null ? "" : date(requestWindow.end);
  if (requestWindow && requestWindow.start > requestWindow.end)
    fail("reversed request window");
  const sourceCaptures = originalCaptures(input.captures);
  const successful = sourceCaptures.filter((c) => c.status === 200);
  if (successful.some((c) => c.requestScopeRedacted))
    fail("redacted successful source scope");
  const searches = successful.flatMap((c, i) =>
    path(c) === DELAWARE_CFRS_PAGES.filedReportsSearch && c.method === "POST"
      ? [i]
      : [],
  );
  const receiptStart = successful.findIndex(
    (c) => path(c) === DELAWARE_CFRS_PAGES.receiptsEntry && c.method === "GET",
  );
  const expenseStart = successful.findIndex(
    (c) => path(c) === DELAWARE_CFRS_PAGES.expensesSearch && c.method === "GET",
  );
  if (
    searches.length !== 2 ||
    searches[0]! >= searches[1]! ||
    searches[1]! >= receiptStart ||
    receiptStart >= expenseStart
  )
    fail("actual operation boundaries missing");
  const owner = successful.slice(0, searches[0]);
  one(owner, DELAWARE_CFRS_PAGES.committeeSearch, "GET");
  const registrySearch = one(
    owner,
    DELAWARE_CFRS_PAGES.committeeSearchPost,
    "POST",
  );
  scope(
    registrySearch,
    buildDelawareCommitteeSearchFields({
      CommitteeType: "01",
      txtCommitteeID: cfId,
    }),
  );
  const grids = owner.filter(
    (c) =>
      path(c) === DELAWARE_CFRS_PAGES.committeeGridJson && c.method === "POST",
  );
  if (!grids.length || grids.length > 40) fail("registry pages missing/capped");
  const registryRows: Readonly<Record<string, unknown>>[] = [];
  let registryCount: number | null = null;
  grids.forEach((c, i) => {
    scope(c, {
      page: String(i + 1),
      size: "500",
      orderBy: "",
      groupBy: "",
      filter: "",
    });
    const parsed = parseDelawareCommitteeGridJson(text(c));
    if (
      c.startedAt < registrySearch.completedAt ||
      parsed.total === null ||
      !Number.isSafeInteger(parsed.total) ||
      parsed.total < 0 ||
      parsed.rows.length > 500 ||
      (registryCount !== null && registryCount !== parsed.total) ||
      (i < grids.length - 1 && parsed.rows.length !== 500)
    )
      fail("incomplete/changed registry pages");
    registryCount = parsed.total;
    registryRows.push(...JSON.parse(text(c)).data);
  });
  if (registryRows.length !== registryCount) fail("registry count mismatch");
  const matches = registryRows.filter((r) => r.Committee_Id === cfId);
  if (
    !matches.length ||
    matches.some(
      (r) =>
        r.MemberID !== memberId ||
        r.CommitteeTypeCode !== "01" ||
        typeof r.CommitteeName !== "string" ||
        r.CommitteeName.trim() !== committeeName,
    )
  )
    fail("registry receiver mismatch");
  const observed = organizationUrls(text(registrySearch), memberId);
  const soCaps = owner.filter(
    (c) =>
      path(c) === DELAWARE_CFRS_PAGES.statementOfOrganization &&
      c.method === "GET",
  );
  if (
    soCaps.length !== observed.length ||
    observed.some((u) => soCaps.filter((c) => c.url === u).length !== 1)
  )
    fail("missing/unobserved SO capture");
  const versions = observed.map((u) =>
    Number(new URL(u).searchParams.get("memVersID")),
  );
  if (versions.some((v) => !matches.some((r) => r.MemberVersID === v)))
    fail("observed SO version absent from registry");
  const diagnostics: string[] = [];
  if (!observed.length)
    diagnostics.push(
      "No observed organization links; identity authority unavailable.",
    );
  if (matches.some((r) => !versions.includes(Number(r.MemberVersID))))
    diagnostics.push(
      "Registry editions lack observed SO links; identity authority unresolved.",
    );
  function inventory(
    caps: readonly DelawareCfrsResponseCapture[],
    current: boolean,
  ) {
    const searched = one(caps, DELAWARE_CFRS_PAGES.filedReportsSearch, "POST");
    scope(searched, {
      ...buildDelawareFiledReportsSearchFields({
        MemberId: String(memberId),
        txtCommitteeName: committeeName,
      }),
      ...(current ? { hdnViewCurrent: "true", chkViewCurrReport: "on" } : {}),
    });
    const pages = caps.filter(
      (c) =>
        path(c) === DELAWARE_CFRS_PAGES.filedReportsGridJson &&
        c.method === "GET",
    );
    if (!pages.length || pages.length > 40) fail("report pages missing/capped");
    const rows: DelawareFiledReportRow[] = [];
    let count: number | null = null;
    pages.forEach((c, i) => {
      query(c, {
        ajax: "True",
        "Grid-page": String(i + 1),
        "Grid-size": "500",
        "Grid-orderBy": "~",
        "Grid-groupBy": "~",
        "Grid-filter": "~",
        theme: "vista",
      });
      const parsed = parseDelawareFiledReportsHtml(text(c));
      if (
        c.startedAt < searched.completedAt ||
        parsed.total === null ||
        !Number.isSafeInteger(parsed.total) ||
        parsed.total < 0 ||
        (count !== null && count !== parsed.total) ||
        parsed.rows.length > 500 ||
        (i < pages.length - 1 && parsed.rows.length !== 500)
      )
        fail("incomplete/changed report pages");
      count = parsed.total;
      rows.push(...parsed.rows);
    });
    if (
      rows.length !== count ||
      rows.some(
        (r) =>
          r.cfId !== cfId ||
          r.committeeName.trim() !== committeeName ||
          r.document?.memberId !== memberId,
      ) ||
      new Set(rows.map((r) => r.document!.publicReportFileName)).size !==
        rows.length
    )
      fail("report inventory identity/count");
    return rows;
  }
  const allVersionReportRows = inventory(
    successful.slice(searches[0], searches[1]),
    false,
  );
  const latestAccountReportRows = inventory(
    successful
      .slice(searches[1], receiptStart)
      .filter((c) => path(c) !== DELAWARE_CFRS_PAGES.filedReportPdf),
    true,
  );
  const pdfs = successful.filter(
    (c) => path(c) === DELAWARE_CFRS_PAGES.filedReportPdf,
  );
  const documents = new Map<
    string,
    NonNullable<DelawareFiledReportRow["document"]>
  >();
  for (const r of [...allVersionReportRows, ...latestAccountReportRows]) {
    const d = r.document!;
    const prior = documents.get(d.publicReportFileName);
    if (
      prior &&
      (prior.filingCalendarId !== d.filingCalendarId ||
        prior.memberId !== d.memberId)
    )
      fail("conflicting PDF document identity");
    documents.set(d.publicReportFileName, d);
  }
  const reportPdfs = pdfs.map((c) => {
    if (c.method !== "GET") fail("wrong PDF method");
    const file = new URL(c.url).searchParams.get("FileName")!,
      d = documents.get(file);
    if (
      !d ||
      pdfs.filter((p) => new URL(p.url).searchParams.get("FileName") === file)
        .length !== 1
    )
      fail("missing/duplicate/unobserved PDF");
    query(c, {
      FileName: file,
      CommitteeID: String(memberId),
      FilingCalendarID: String(d.filingCalendarId),
    });
    if (
      c.body.length > 4 * 1024 * 1024 ||
      c.body.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      c.startedAt < successful[searches[1]!]!.completedAt ||
      c.completedAt > successful[receiptStart]!.startedAt
    )
      fail("invalid PDF body/sequence");
    return {
      publicReportFileName: file,
      filingCalendarId: d.filingCalendarId,
      body: Buffer.from(c.body),
    };
  });
  if (reportPdfs.length !== documents.size) fail("missing report PDF");
  function ledger(
    caps: readonly DelawareCfrsResponseCapture[],
    kind: "receipts" | "expenses",
  ) {
    const receipt = kind === "receipts";
    const posts = caps.filter(
      (c) =>
        path(c) ===
          (receipt
            ? DELAWARE_CFRS_PAGES.receiptsSearch
            : DELAWARE_CFRS_PAGES.expensesSearchPost) && c.method === "POST",
    );
    if (!posts.length) fail("missing financial search");
    posts.forEach((c) =>
      scope(
        c,
        receipt
          ? buildDelawareReceiptsSearchFields({
              MemberId: String(memberId),
              txtReceivingRegistrant: committeeName,
              dtStartDate: start,
              dtEndDate: end,
            })
          : buildDelawareExpensesSearchFields({
              MemberId: String(memberId),
              txtRegistrant: committeeName,
              CommitteeType: "01",
              dtStartDate: start,
              dtEndDate: end,
            }),
      ),
    );
    const last = posts.at(-1)!;
    const renderedCount = extractDelawareGridTotal(text(last));
    if (
      renderedCount === null ||
      !Number.isSafeInteger(renderedCount) ||
      renderedCount < 0
    )
      fail("missing rendered count");
    const csvCapture = one(
      caps,
      receipt
        ? DELAWARE_CFRS_PAGES.receiptsExportCsv
        : DELAWARE_CFRS_PAGES.expensesExportCsv,
      "GET",
    );
    query(csvCapture, { ...DELAWARE_CFRS_EXPORT_QUERY });
    const native = caps.filter(
      (c) =>
        path(c) ===
          (receipt
            ? DELAWARE_CFRS_PAGES.receiptsGridJson
            : DELAWARE_CFRS_PAGES.expensesGridJson) && c.method === "POST",
    );
    if (!native.length || native.length > 40)
      fail("native pages missing/capped");
    const pages = native.map((c, i) => {
      scope(c, {
        page: String(i + 1),
        size: "500",
        orderBy: "",
        groupBy: "",
        filter: "",
      });
      query(c, { "Grid-size": "15", theme: "vista" });
      if (
        c.startedAt < last.completedAt ||
        c.completedAt > csvCapture.startedAt
      )
        fail("native rows precede search/export boundary");
      return {
        pageNumber: i + 1,
        pageSize: 500,
        page: (receipt
          ? decodeDelawareReceiptNativePage
          : decodeDelawareExpenseNativePage)(text(c)),
      };
    });
    const csv = text(csvCapture);
    const closed = closeDelawareNativeLedger({ pages, renderedCount, csv });
    if (
      closed.rows.some(
        (r) =>
          r.rawFields[receipt ? "WC_ID" : "CCF_ID"] !== cfId ||
          (requestWindow !== null &&
            (r.date < requestWindow.start || r.date > requestWindow.end)),
      )
    )
      fail("native row outside receiver/window");
    return { csv, renderedCount, ledger: closed };
  }
  const receipts = ledger(
      successful.slice(receiptStart, expenseStart),
      "receipts",
    ),
    expenses = ledger(successful.slice(expenseStart), "expenses");
  return {
    sourceCaptures,
    registryRows,
    organizationUrls: observed,
    diagnostics,
    requestWindow,
    queryScope:
      requestWindow === null
        ? { kind: "whole_member" }
        : { kind: "bounded_window", ...requestWindow },
    allVersionReportRows,
    latestAccountReportRows,
    reportPdfs,
    receiptsCsv: receipts.csv,
    expensesCsv: expenses.csv,
    receiptRenderedCount: receipts.renderedCount,
    expenseRenderedCount: expenses.renderedCount,
    receipts: receipts.ledger,
    expenses: expenses.ledger,
  };
}
