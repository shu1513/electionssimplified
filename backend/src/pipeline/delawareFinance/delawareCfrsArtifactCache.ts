// Delaware CFRS artifact cache (docs/plans/plan-delaware-finance.md architecture).
//
// The sync is cache-only: it never touches the live portal. This module owns
// the restricted on-disk artifact store the acquisition layer (Phase 2)
// writes and the sync reads. Shape, per committee (keyed by canonical
// CF_ID):
//
//   <cacheDir>/<CF_ID>/receipts.csv          full receipts export
//   <cacheDir>/<CF_ID>/expenses.csv          full expenses export
//   <cacheDir>/<CF_ID>/filed_reports.html    rendered filed-reports grid
//   <cacheDir>/<CF_ID>/reports/<sha16>.pdf   one per report document
//   <cacheDir>/<CF_ID>/manifest.json         the commit marker
//
// A store builds the ENTIRE bundle (manifest included) in a staging
// directory beside the final one and swaps it in only when complete — a
// failure mid-store leaves the previous bundle byte-identical, never a
// mixed-vintage directory whose old manifest points at overwritten files.
// The manifest records SHA-256 + byte size for every file, the parser
// version, the portal's stored-search totals (the sync's count==total gate
// re-checks them), the acquisition MemberID, and one retrievedAt for the
// whole bundle. Optional source journals preserve original per-response times,
// scopes and bytes; they make no currentness or financial authority assertion.
// Reads recompute every hash and re-run the parsers; any
// disagreement throws.
//
// PII: receipts artifacts carry contributor street addresses — directories
// are 0700, files 0600, and the cache directory must never enter git.

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  parseDelawareExpensesCsv,
  parseDelawareFiledReportsHtml,
  parseDelawareReceiptsCsv,
  type DelawareExpenseCsvRow,
  type DelawareFiledReportRow,
  type DelawareReceiptCsvRow,
} from "./delawareCfrsParsers.js";

import {
  DELAWARE_CFRS_BASE_URL,
  buildDelawareCommitteeSearchFields,
  DELAWARE_CFRS_MAX_RESPONSE_BYTES,
  DELAWARE_CFRS_PAGES,
  isDelawareCfrsPublicReportFileName,
  type DelawareCfrsResponseCapture,
} from "./delawareCfrsClient.js";

export const DELAWARE_CFRS_ARTIFACT_SCHEMA_VERSION = 1;
/** Bump when a parser change invalidates previously cached artifacts. */
export const DELAWARE_CFRS_PARSER_VERSION = 1;

export const DEFAULT_DELAWARE_CFRS_CACHE_DIR = "artifact-cache/delaware-cfrs";

export type DelawareCfrsReportPdfInput = {
  /** The portal's opaque public report file name (manifest identity). */
  publicReportFileName: string;
  filingCalendarId: number;
  body: Buffer;
};

type ManifestFileEntry = { path: string; sha256: string; byteSize: number };

/** Raw response journal only; neither currentness nor financial authority. */
export type DelawareCfrsSourceJournalEntry = Omit<
  DelawareCfrsResponseCapture,
  "body"
> & { path: string };
export type DelawareCfrsSourceJournal = {
  version: 1;
  captureCount: number;
  captures: DelawareCfrsSourceJournalEntry[];
};

/** Capture references only; no decoded money or source-currentness assertions. */
export type DelawareCfrsSourcePacketIndex = {
  version: 1;
  cfId: string;
  memberId: number;
  committeeName: string;
  requestWindow: { start: string; end: string } | null;
  candidateCaptureIndices: readonly number[];
  registryOpeningCaptureIndices: readonly number[];
  registryClosingCaptureIndices: readonly number[];
  payers: readonly {
    cfId: string;
    memberId: number;
    committeeName: string;
    committeeType: "04";
    facets: {
      registry: readonly number[];
      payerOrganization: readonly number[];
      receiverIdentity: readonly number[];
      candidateCycleAuthority: readonly number[];
      allVersionReports: readonly number[];
      latestAccountReport: readonly number[];
      genericMemberReceipts: readonly number[];
      thirdPartyReceiptExport: readonly number[];
      expenses: readonly number[];
      reportPdfs: readonly number[];
      unsupportedFacets?: readonly number[];
    };
  }[];
};

export type DelawareCfrsCommitteeArtifactManifest = {
  version: typeof DELAWARE_CFRS_ARTIFACT_SCHEMA_VERSION;
  parserVersion: number;
  cfId: string;
  /** Portal acquisition key — never written to product tables. */
  memberId: number;
  sourceUrl: string;
  retrievedAt: string;
  receiptsSearchTotal: number;
  expensesSearchTotal: number;
  sourceJournal?: DelawareCfrsSourceJournal;
  sourcePacketIndex?: DelawareCfrsSourcePacketIndex;
  /** Exact official election responses, outside the CFRS-only journal. */
  officialElectionSources?: DelawareCfrsSourceJournalEntry[];
  files: {
    receiptsCsv: ManifestFileEntry;
    expensesCsv: ManifestFileEntry;
    filedReportsHtml: ManifestFileEntry;
    reportPdfs: (ManifestFileEntry & {
      publicReportFileName: string;
      filingCalendarId: number;
    })[];
  };
};

function requireCfId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{8}$/.test(normalized)) {
    throw new Error(`Invalid Delaware CF_ID for artifact cache: ${value}`);
  }
  return normalized;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function pdfRelativePath(publicReportFileName: string): string {
  return join(
    "reports",
    `${sha256(Buffer.from(publicReportFileName, "utf8")).slice(0, 16)}.pdf`,
  );
}

const JOURNAL_FINANCE_FIELDS = new Set([
  "txtReceivingRegistrant",
  "txtRegistrant",
  "txtCommitteeName",
  "txtCommitteeID",
  "txtContributorName",
  "txtFirstName",
  "txtPayeeFirstName",
  "txtPayeeLastName",
  "CommitteeType",
  "CommitteeStatus",
  "FormType",
  "ContributorType",
  "ContributionType",
  "FilingYear",
  "FilingPeriodName",
  "ReportName",
  "ddlElectiontype",
  "dtStartDate",
  "dtEndDate",
  "dtCloseStartDate",
  "dtCloseEndDate",
  "ddlOffice",
  "hdnddlOffice",
  "ddlCounty",
  "hdnddlCounty",
  "ddlOfficeSought",
  "hdnddlOfficeSought",
  "ddljurisdiction",
  "hdnddljurisdiction",
  "hdnCommitteeName",
  "hdnFilingPeriodName",
  "hdnReportName",
  "hdnViewCurrent",
  "chkViewCurrReport",
  "hdnTP",
  "chkTP",
  "hdnFixedAssets",
  "ddlPayeeType",
  "ddlExpenCategory",
  "ddlExpensePurpose",
  "CommitteeTypeData",
  "filingYearData",
  "expenseCategoryData",
  "expensePruposeData",
  "payeeTypeData",
  "committeeNameData",
  "btnSearch",
  "Submit",
  "rdGroup",
  "page",
  "size",
  "orderBy",
  "groupBy",
  "theme",
  "ajax",
  "Grid-page",
  "Grid-size",
  "Grid-orderBy",
  "Grid-groupBy",
  "q",
  "ftype",
  "isPublic",
]);
const JOURNAL_PUBLIC_ID_FIELDS = new Set([
  "MemberId",
  "MemberID",
  "memberID",
  "CommitteeID",
  "CommitteeId",
  "FilingCalendarID",
  "memVersID",
  "cTypeCode",
]);
const JOURNAL_PATHS: ReadonlySet<string> = new Set([
  "/",
  ...Object.values(DELAWARE_CFRS_PAGES),
]);

function journalFieldAllowed(key: string, value: string): boolean {
  if (key === "FileName") return isDelawareCfrsPublicReportFileName(value);
  if (key === "fpath" || key === "fname") return value === "";
  if (key === "filter" || key === "Grid-filter")
    return value === "" || value === "~";
  if (JOURNAL_PUBLIC_ID_FIELDS.has(key))
    return value === "" || /^\d+$/.test(value);
  return JOURNAL_FINANCE_FIELDS.has(key);
}

const JOURNAL_MAX_CAPTURES = 10000;
const JOURNAL_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const JOURNAL_ENTRY_KEYS = [
  "path",
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
const capturePath = (index: number) =>
  `source-captures/${String(index).padStart(6, "0")}.bin`;
function journalError(message: string): never {
  throw new Error(`Invalid Delaware CFRS source journal: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function validateJournal(
  value: unknown,
): asserts value is DelawareCfrsSourceJournal {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "captureCount", "captures"]) ||
    value.version !== 1 ||
    !Array.isArray(value.captures) ||
    value.captures.length > JOURNAL_MAX_CAPTURES ||
    value.captureCount !== value.captures.length
  )
    journalError("shape/count");
  let totalBytes = 0;
  value.captures.forEach((entry: unknown, index: number) => {
    if (!record(entry) || !exactKeys(entry, JOURNAL_ENTRY_KEYS))
      journalError("capture shape");
    if (
      entry.path !== capturePath(index) ||
      !Number.isSafeInteger(entry.byteCount) ||
      (entry.byteCount as number) < 0 ||
      (entry.byteCount as number) > DELAWARE_CFRS_MAX_RESPONSE_BYTES ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      journalError("path/bytes/hash");
    totalBytes += entry.byteCount as number;
    if (totalBytes > JOURNAL_MAX_TOTAL_BYTES) journalError("total byte limit");
    if (
      (entry.method !== "GET" && entry.method !== "POST") ||
      typeof entry.requestScopeRedacted !== "boolean" ||
      !Number.isSafeInteger(entry.attempt) ||
      (entry.attempt as number) < 1 ||
      (entry.attempt as number) > 10000 ||
      !Number.isInteger(entry.status) ||
      (entry.status as number) < 100 ||
      (entry.status as number) > 599 ||
      !(
        entry.contentType === null ||
        (typeof entry.contentType === "string" &&
          entry.contentType.length <= 512 &&
          !/[\r\n\0]/.test(entry.contentType))
      )
    )
      journalError("HTTP metadata");
    if (
      !validTimestamp(entry.startedAt) ||
      !validTimestamp(entry.completedAt) ||
      entry.startedAt > entry.completedAt
    )
      journalError("capture interval");
    if (typeof entry.url !== "string" || entry.url.length > 16384)
      journalError("URL");
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      journalError("URL");
    }
    if (
      url.origin !== DELAWARE_CFRS_BASE_URL ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !JOURNAL_PATHS.has(url.pathname) ||
      [...url.searchParams].some(([key, val]) => !journalFieldAllowed(key, val))
    )
      journalError("unsafe URL scope");
    if (
      entry.method === "GET"
        ? entry.financeFields !== null
        : !record(entry.financeFields)
    )
      journalError("request fields");
    if (
      record(entry.financeFields) &&
      (Object.keys(entry.financeFields).length > 200 ||
        Object.entries(entry.financeFields).some(
          ([key, val]) =>
            typeof val !== "string" ||
            val.length > 16384 ||
            !journalFieldAllowed(key, val),
        ))
    )
      journalError("unsafe request fields");
  });
}

function snapshotCapture(
  capture: DelawareCfrsResponseCapture,
  index: number,
): { metadata: DelawareCfrsSourceJournalEntry; body: Buffer } {
  if (
    !record(capture) ||
    !exactKeys(capture, [
      "body",
      ...JOURNAL_ENTRY_KEYS.filter((key) => key !== "path"),
    ]) ||
    !Buffer.isBuffer(capture.body)
  )
    journalError("input capture shape");
  const { body, ...fields } = capture;
  if (
    body.byteLength > DELAWARE_CFRS_MAX_RESPONSE_BYTES ||
    !(fields.financeFields === null || record(fields.financeFields))
  )
    journalError("input bytes/fields");
  const metadata = {
    ...fields,
    financeFields:
      fields.financeFields === null ? null : { ...fields.financeFields },
    path: capturePath(index),
  };
  return { metadata, body: Buffer.from(body) };
}

const OFFICIAL_MAX_BYTES = 12 * 1024 * 1024;
const OFFICIAL_MAX_CAPTURES = 16;
const officialCapturePath = (index: number) =>
  `official-election-sources/${String(index).padStart(6, "0")}.bin`;
const PACKET_FACETS = [
  "registry",
  "payerOrganization",
  "receiverIdentity",
  "candidateCycleAuthority",
  "allVersionReports",
  "latestAccountReport",
  "genericMemberReceipts",
  "thirdPartyReceiptExport",
  "expenses",
  "reportPdfs",
] as const;
function packetError(message: string): never {
  throw new Error(`Invalid Delaware CFRS source packet index: ${message}`);
}
function civilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}
function validatePacketIndex(
  value: unknown,
  journal: DelawareCfrsSourceJournal | undefined,
  receiver: { cfId: string; memberId: number },
): asserts value is DelawareCfrsSourcePacketIndex {
  if (!journal) packetError("requires original source journal");
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "cfId",
      "memberId",
      "committeeName",
      "requestWindow",
      "candidateCaptureIndices",
      "registryOpeningCaptureIndices",
      "registryClosingCaptureIndices",
      "payers",
    ]) ||
    value.version !== 1 ||
    value.cfId !== receiver.cfId ||
    !/^01\d{6}$/.test(String(value.cfId)) ||
    value.memberId !== receiver.memberId ||
    !Number.isSafeInteger(value.memberId) ||
    receiver.memberId <= 0 ||
    typeof value.committeeName !== "string" ||
    !value.committeeName.trim() ||
    value.committeeName.length > 4096
  )
    packetError("receiver identity/shape");
  if (
    value.requestWindow !== null &&
    (!record(value.requestWindow) ||
      !exactKeys(value.requestWindow, ["start", "end"]) ||
      !civilDate(value.requestWindow.start) ||
      !civilDate(value.requestWindow.end) ||
      value.requestWindow.start > value.requestWindow.end)
  )
    packetError("request window");
  let referencedCount = 0;
  function references(
    indices: unknown,
    allowEmpty = false,
  ): DelawareCfrsSourceJournalEntry[] {
    if (
      !Array.isArray(indices) ||
      (!allowEmpty && !indices.length) ||
      indices.length > JOURNAL_MAX_CAPTURES ||
      Array.from(indices).some(
        (v, i) =>
          !Number.isSafeInteger(v) ||
          v < 0 ||
          v >= journal!.captureCount ||
          (i > 0 && v <= indices[i - 1]),
      )
    )
      packetError("capture references/order");
    referencedCount += indices.length;
    if (referencedCount > JOURNAL_MAX_CAPTURES)
      packetError("total reference bound");
    return indices.map((v) => journal!.captures[v]!);
  }
  const candidate = references(value.candidateCaptureIndices);
  const opening = references(value.registryOpeningCaptureIndices);
  const closing = references(value.registryClosingCaptureIndices);
  const allGroups = [
    value.candidateCaptureIndices,
    value.registryOpeningCaptureIndices,
    value.registryClosingCaptureIndices,
  ] as number[][];
  if (new Set(allGroups.flat()).size !== allGroups.flat().length)
    packetError("overlapping candidate/registry references");
  if (
    Math.max(...opening.map((c) => Date.parse(c.completedAt))) >
      Math.min(...candidate.map((c) => Date.parse(c.startedAt))) ||
    Math.min(...closing.map((c) => Date.parse(c.startedAt))) <
      Math.max(...candidate.map((c) => Date.parse(c.completedAt)))
  )
    packetError("registry does not precede/close candidate captures");
  for (const c of candidate) {
    const u = new URL(c.url);
    for (const key of ["MemberId", "MemberID", "memberID"]) {
      const actual = c.financeFields?.[key] ?? u.searchParams.get(key);
      if (
        actual !== null &&
        actual !== undefined &&
        actual !== "" &&
        actual.trim() !== String(receiver.memberId)
      )
        packetError("candidate Member scope");
    }
    if (
      u.pathname === "/Public/Search" &&
      c.method === "POST" &&
      c.financeFields?.txtCommitteeID !== receiver.cfId
    )
      packetError("candidate CF scope");
    if (
      c.method === "POST" &&
      ["/Public/ViewReceipts", "/Public/OtherSearch"].includes(u.pathname)
    ) {
      for (const [key, side] of [
        ["dtStartDate", "start"],
        ["dtEndDate", "end"],
      ] as const) {
        const actual = c.financeFields?.[key];
        const date =
          value.requestWindow === null
            ? null
            : (value.requestWindow as { start: string; end: string })[side];
        const expected =
          date === null
            ? ""
            : `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
        if (actual !== undefined && actual !== expected)
          packetError("candidate request window scope");
      }
    }
    for (const key of ["txtReceivingRegistrant", "txtRegistrant"]) {
      const actual = c.financeFields?.[key];
      if (
        actual !== undefined &&
        actual !== "" &&
        actual !== value.committeeName
      )
        packetError("candidate name scope");
    }
  }
  for (const group of [opening, closing]) {
    const searches = group.filter(
      (c) =>
        new URL(c.url).pathname === "/Public/Search" && c.method === "POST",
    );
    const expected = buildDelawareCommitteeSearchFields();
    if (
      !searches.some((c) => c.status === 200) ||
      searches.some(
        (c) =>
          [
            "CommitteeType",
            "CommitteeStatus",
            "txtCommitteeID",
            "txtCommitteeName",
          ].some((key) => c.financeFields?.[key] !== "") ||
          Object.entries(c.financeFields ?? {}).some(
            ([key, actual]) => actual !== (expected[key] ?? ""),
          ),
      )
    )
      packetError("registry selector scope");
  }
  if (!Array.isArray(value.payers) || value.payers.length > 100)
    packetError("payer bound");
  const payerIds = new Set<string>();
  for (const payer of value.payers) {
    if (
      !record(payer) ||
      !exactKeys(payer, [
        "cfId",
        "memberId",
        "committeeName",
        "committeeType",
        "facets",
      ]) ||
      typeof payer.cfId !== "string" ||
      !/^04\d{6}$/.test(payer.cfId) ||
      payer.committeeType !== "04" ||
      !Number.isSafeInteger(payer.memberId) ||
      (payer.memberId as number) <= 0 ||
      typeof payer.committeeName !== "string" ||
      !payer.committeeName.trim() ||
      payer.committeeName.length > 4096 ||
      payerIds.has(payer.cfId)
    )
      packetError("payer identity");
    payerIds.add(payer.cfId);
    if (
      !record(payer.facets) ||
      !exactKeys(payer.facets, [
        ...PACKET_FACETS,
        ...(Object.hasOwn(payer.facets, "unsupportedFacets")
          ? ["unsupportedFacets"]
          : []),
      ])
    )
      packetError("payer facets");
    for (const facet of PACKET_FACETS) {
      const entries = references(payer.facets[facet]);
      const context =
        facet === "receiverIdentity" || facet === "candidateCycleAuthority"
          ? {
              cfId: receiver.cfId,
              memberId: receiver.memberId,
              committeeName: value.committeeName,
            }
          : payer;
      for (const c of entries) {
        const url = new URL(c.url);
        for (const key of ["MemberId", "MemberID", "memberID"]) {
          for (const actual of [
            c.financeFields?.[key],
            url.searchParams.get(key),
          ]) {
            if (
              actual !== undefined &&
              actual !== null &&
              actual !== "" &&
              actual.trim() !== String(context.memberId)
            )
              packetError("payer facet Member scope");
          }
        }
        if (
          url.pathname === "/Public/Search" &&
          c.method === "POST" &&
          c.financeFields?.txtCommitteeID !== context.cfId
        )
          packetError("payer facet CF scope");
        for (const key of [
          "txtReceivingRegistrant",
          "txtRegistrant",
          "txtCommitteeName",
        ]) {
          const actual = c.financeFields?.[key];
          if (
            actual !== undefined &&
            actual !== "" &&
            actual !== context.committeeName
          )
            packetError("payer facet name scope");
        }
      }
    }
    if (Object.hasOwn(payer.facets, "unsupportedFacets"))
      references(payer.facets.unsupportedFacets, true);
  }
}
function validateOfficialSources(
  value: unknown,
): asserts value is DelawareCfrsSourceJournalEntry[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > OFFICIAL_MAX_CAPTURES
  )
    throw new Error("Invalid Delaware official election sources: count");
  Array.from(value).forEach((entry: unknown, index: number) => {
    if (
      !record(entry) ||
      !exactKeys(entry, JOURNAL_ENTRY_KEYS) ||
      entry.path !== officialCapturePath(index) ||
      typeof entry.url !== "string" ||
      entry.url.length > 16384 ||
      entry.method !== "GET" ||
      entry.financeFields !== null ||
      entry.requestScopeRedacted !== false ||
      entry.status !== 200 ||
      !Number.isSafeInteger(entry.attempt) ||
      (entry.attempt as number) < 1 ||
      (entry.attempt as number) > 10000 ||
      !Number.isSafeInteger(entry.byteCount) ||
      (entry.byteCount as number) <= 0 ||
      (entry.byteCount as number) > OFFICIAL_MAX_BYTES ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !validTimestamp(entry.startedAt) ||
      !validTimestamp(entry.completedAt) ||
      entry.startedAt > entry.completedAt ||
      !(
        entry.contentType === null ||
        (typeof entry.contentType === "string" &&
          entry.contentType.length <= 512 &&
          !/[\r\n\0]/.test(entry.contentType))
      )
    )
      throw new Error("Invalid Delaware official election sources: metadata");
    let u: URL;
    try {
      u = new URL(String(entry.url));
    } catch {
      throw new Error("Invalid Delaware official election sources: URL");
    }
    if (
      u.origin !== "https://elections.delaware.gov" ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      u.port ||
      !(
        u.pathname === "/reports/GE2022.html" ||
        /^\/elections\/general\/sampleballots\/GE2026\/\d{2}-\d{2}\.html$/.test(
          u.pathname,
        )
      )
    )
      throw new Error("Invalid Delaware official election sources: route");
  });
}
function snapshotOfficialSources(
  captures: readonly DelawareCfrsResponseCapture[],
) {
  if (
    !Array.isArray(captures) ||
    !captures.length ||
    captures.length > OFFICIAL_MAX_CAPTURES
  )
    throw new Error("Invalid Delaware official election sources: count");
  const snapshots = Array.from(captures).map((capture, index) => {
    if (
      !record(capture) ||
      !exactKeys(capture, [
        "body",
        ...JOURNAL_ENTRY_KEYS.filter((key) => key !== "path"),
      ]) ||
      !Buffer.isBuffer(capture.body)
    )
      throw new Error("Invalid Delaware official election sources: input");
    const { body, ...fields } = capture;
    const metadata = {
      ...fields,
      path: officialCapturePath(index),
    } as DelawareCfrsSourceJournalEntry;
    return { metadata, body: Buffer.from(body) };
  });
  validateOfficialSources(snapshots.map((s) => s.metadata));
  if (
    snapshots.some(
      (s) =>
        s.body.length !== s.metadata.byteCount ||
        sha256(s.body) !== s.metadata.sha256,
    )
  )
    throw new Error("Invalid Delaware official election sources: body/hash");
  return snapshots;
}

async function writeRestricted(
  path: string,
  body: Buffer | string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function storeDelawareCfrsCommitteeArtifacts(input: {
  cacheDir?: string;
  cfId: string;
  memberId: number;
  sourceUrl: string;
  receiptsCsv: string;
  receiptsSearchTotal: number;
  expensesCsv: string;
  expensesSearchTotal: number;
  filedReportsHtml: string;
  reportPdfs: readonly DelawareCfrsReportPdfInput[];
  retrievedAt?: Date;
  /** Optional original bounded attempts, including rejected/redacted responses. */
  sourceCaptures?: readonly DelawareCfrsResponseCapture[];
  sourcePacketIndex?: DelawareCfrsSourcePacketIndex;
  officialElectionSources?: readonly DelawareCfrsResponseCapture[];
}): Promise<DelawareCfrsCommitteeArtifactManifest> {
  // Retain the entire caller generation before any filesystem await.
  input = {
    ...input,
    sourcePacketIndex:
      input.sourcePacketIndex === undefined
        ? undefined
        : structuredClone(input.sourcePacketIndex),
    retrievedAt:
      input.retrievedAt === undefined
        ? undefined
        : new Date(input.retrievedAt.getTime()),
    reportPdfs: input.reportPdfs.map((pdf) => ({
      ...pdf,
      body: Buffer.from(pdf.body),
    })),
  };
  if (
    input.sourceCaptures !== undefined &&
    (!Array.isArray(input.sourceCaptures) ||
      input.sourceCaptures.length > JOURNAL_MAX_CAPTURES)
  )
    journalError("input count");
  const captureSnapshots = input.sourceCaptures?.map(snapshotCapture);
  const sourceJournal: DelawareCfrsSourceJournal | undefined =
    captureSnapshots === undefined
      ? undefined
      : {
          version: 1,
          captureCount: captureSnapshots.length,
          captures: captureSnapshots.map((capture) => capture.metadata),
        };
  if (sourceJournal !== undefined) {
    validateJournal(sourceJournal);
    captureSnapshots!.forEach(({ metadata, body }) => {
      if (
        body.byteLength !== metadata.byteCount ||
        sha256(body) !== metadata.sha256
      )
        journalError("input body/hash mismatch");
    });
  }
  const cfId = requireCfId(input.cfId);
  if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
    throw new Error(
      `Invalid Delaware MemberID for artifact cache: ${input.memberId}`,
    );
  }
  if (input.sourcePacketIndex !== undefined)
    validatePacketIndex(input.sourcePacketIndex, sourceJournal, {
      cfId,
      memberId: input.memberId,
    });
  const officialSnapshots =
    input.officialElectionSources === undefined
      ? undefined
      : snapshotOfficialSources(input.officialElectionSources);
  // Validate before storing: a body the parser rejects is never cached.
  parseDelawareReceiptsCsv(input.receiptsCsv);
  parseDelawareExpensesCsv(input.expensesCsv);
  parseDelawareFiledReportsHtml(input.filedReportsHtml);

  const cacheDir = input.cacheDir ?? DEFAULT_DELAWARE_CFRS_CACHE_DIR;
  const committeeDir = join(cacheDir, cfId);
  // Stage beside the final directory (same filesystem, so the rename below
  // is a plain directory move) and swap only once the bundle is complete —
  // a failure anywhere in here must leave the previous bundle untouched.
  const generation = `${process.pid}-${randomUUID()}`;
  const stagingDir = join(cacheDir, `${cfId}.staging-${generation}`);
  try {
    const entry = async (
      relativePath: string,
      body: Buffer,
    ): Promise<ManifestFileEntry> => {
      await writeRestricted(join(stagingDir, relativePath), body);
      return {
        path: relativePath,
        sha256: sha256(body),
        byteSize: body.byteLength,
      };
    };

    const seenPdfPaths = new Set<string>();
    const reportPdfs: DelawareCfrsCommitteeArtifactManifest["files"]["reportPdfs"] =
      [];
    for (const pdf of input.reportPdfs) {
      const relativePath = pdfRelativePath(pdf.publicReportFileName);
      if (seenPdfPaths.has(relativePath)) {
        throw new Error(
          `duplicate report PDF in bundle: ${pdf.publicReportFileName}`,
        );
      }
      seenPdfPaths.add(relativePath);
      reportPdfs.push({
        ...(await entry(relativePath, pdf.body)),
        publicReportFileName: pdf.publicReportFileName,
        filingCalendarId: pdf.filingCalendarId,
      });
    }

    for (const capture of captureSnapshots ?? []) {
      await entry(capture.metadata.path, capture.body);
    }
    for (const capture of officialSnapshots ?? [])
      await entry(capture.metadata.path, capture.body);
    const manifest: DelawareCfrsCommitteeArtifactManifest = {
      version: DELAWARE_CFRS_ARTIFACT_SCHEMA_VERSION,
      parserVersion: DELAWARE_CFRS_PARSER_VERSION,
      cfId,
      memberId: input.memberId,
      sourceUrl: input.sourceUrl,
      retrievedAt: (input.retrievedAt ?? new Date()).toISOString(),
      receiptsSearchTotal: input.receiptsSearchTotal,
      expensesSearchTotal: input.expensesSearchTotal,
      ...(sourceJournal === undefined ? {} : { sourceJournal }),
      ...(input.sourcePacketIndex === undefined
        ? {}
        : { sourcePacketIndex: input.sourcePacketIndex }),
      ...(officialSnapshots === undefined
        ? {}
        : {
            officialElectionSources: officialSnapshots.map((s) => s.metadata),
          }),
      files: {
        receiptsCsv: await entry(
          "receipts.csv",
          Buffer.from(input.receiptsCsv, "utf8"),
        ),
        expensesCsv: await entry(
          "expenses.csv",
          Buffer.from(input.expensesCsv, "utf8"),
        ),
        filedReportsHtml: await entry(
          "filed_reports.html",
          Buffer.from(input.filedReportsHtml, "utf8"),
        ),
        reportPdfs,
      },
    };
    await writeRestricted(
      join(stagingDir, "manifest.json"),
      JSON.stringify(manifest, null, 1),
    );

    // Swap via move-aside: the previous bundle is never deleted until the
    // new one is installed. A failed install renames it back; a crash
    // mid-swap leaves it on disk under the .previous name (a read then says
    // "no bundle cached" — fail-closed, and the data remains recoverable).
    const previousDir = join(cacheDir, `${cfId}.previous-${generation}`);
    await rm(previousDir, { recursive: true, force: true });
    let hadPrevious = true;
    try {
      await rename(committeeDir, previousDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      hadPrevious = false;
    }
    try {
      await rename(stagingDir, committeeDir);
    } catch (error) {
      if (hadPrevious) {
        await rename(previousDir, committeeDir).catch(() => {});
      }
      throw error;
    }
    if (hadPrevious) {
      await rm(previousDir, { recursive: true, force: true });
    }
    return manifest;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export type DelawareCfrsCommitteeArtifacts = {
  manifest: DelawareCfrsCommitteeArtifactManifest;
  receiptRows: DelawareReceiptCsvRow[];
  receiptsMalformedRowCount: number;
  expenseRows: DelawareExpenseCsvRow[];
  expensesMalformedRowCount: number;
  filedReportRows: DelawareFiledReportRow[];
  filedReportsGridTotal: number | null;
  /** Undefined for legacy bundles; no financial completeness or freshness claim. */
  sourceCaptures?: DelawareCfrsResponseCapture[];
  sourcePacketIndex?: DelawareCfrsSourcePacketIndex;
  officialElectionSources?: DelawareCfrsResponseCapture[];
  reportPdfs: {
    publicReportFileName: string;
    filingCalendarId: number;
    body: Buffer;
  }[];
};

async function readVerified(
  committeeDir: string,
  entry: ManifestFileEntry,
  label: string,
): Promise<Buffer> {
  if (
    !record(entry) ||
    typeof entry.path !== "string" ||
    isAbsolute(entry.path) ||
    entry.path.includes("\\") ||
    entry.path
      .split("/")
      .some((part) => part === ".." || part === "." || part === "") ||
    !Number.isSafeInteger(entry.byteSize) ||
    entry.byteSize < 0 ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error(`Invalid Delaware CFRS artifact entry: ${label}`);
  let body: Buffer;
  try {
    const target = join(committeeDir, entry.path);
    const confined = relative(
      await realpath(committeeDir),
      await realpath(target),
    );
    const info = await stat(target);
    if (
      confined === "" ||
      confined.startsWith(`..${sep}`) ||
      confined === ".." ||
      isAbsolute(confined) ||
      !info.isFile()
    )
      throw new Error(`Unconfined Delaware CFRS artifact: ${label}`);
    if (info.size !== entry.byteSize)
      throw new Error(
        `Stale or corrupted Delaware CFRS artifact: ${label} (${entry.path})`,
      );
    body = await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Missing Delaware CFRS artifact: ${label} (${entry.path})`,
      );
    }
    throw error;
  }
  if (body.byteLength !== entry.byteSize || sha256(body) !== entry.sha256) {
    throw new Error(
      `Stale or corrupted Delaware CFRS artifact: ${label} (${entry.path})`,
    );
  }
  return body;
}

export async function readDelawareCfrsCommitteeArtifacts(input: {
  cacheDir?: string;
  cfId: string;
}): Promise<DelawareCfrsCommitteeArtifacts> {
  const cfId = requireCfId(input.cfId);
  const committeeDir = join(
    input.cacheDir ?? DEFAULT_DELAWARE_CFRS_CACHE_DIR,
    cfId,
  );
  let manifestBody: string;
  try {
    manifestBody = await readFile(join(committeeDir, "manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No Delaware CFRS artifact bundle cached for CF_ID ${cfId}`,
      );
    }
    throw error;
  }
  const manifest = JSON.parse(
    manifestBody,
  ) as DelawareCfrsCommitteeArtifactManifest;
  if (manifest.version !== DELAWARE_CFRS_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Delaware CFRS artifact schema version ${manifest.version} for CF_ID ${cfId}`,
    );
  }
  if (manifest.parserVersion !== DELAWARE_CFRS_PARSER_VERSION) {
    throw new Error(
      `Delaware CFRS artifact bundle for CF_ID ${cfId} was written by parser version ${manifest.parserVersion}, ` +
        `current is ${DELAWARE_CFRS_PARSER_VERSION} — re-acquire`,
    );
  }
  if (manifest.cfId !== cfId) {
    throw new Error(
      `Delaware CFRS artifact bundle identity mismatch: requested ${cfId}, stored ${manifest.cfId}`,
    );
  }

  if (Object.hasOwn(manifest, "sourceJournal"))
    validateJournal(manifest.sourceJournal);
  if (Object.hasOwn(manifest, "sourcePacketIndex"))
    validatePacketIndex(manifest.sourcePacketIndex, manifest.sourceJournal, {
      cfId,
      memberId: manifest.memberId,
    });
  if (Object.hasOwn(manifest, "officialElectionSources"))
    validateOfficialSources(manifest.officialElectionSources);
  const officialElectionSources =
    manifest.officialElectionSources === undefined
      ? undefined
      : ([] as DelawareCfrsResponseCapture[]);
  for (const entry of manifest.officialElectionSources ?? []) {
    const { path, ...metadata } = entry;
    const body = await readVerified(
      committeeDir,
      { path, sha256: entry.sha256, byteSize: entry.byteCount },
      `official election source ${path}`,
    );
    officialElectionSources!.push({ ...metadata, body });
  }
  const sourceCaptures: DelawareCfrsResponseCapture[] | undefined =
    manifest.sourceJournal === undefined ? undefined : [];
  for (const capture of manifest.sourceJournal?.captures ?? []) {
    const { path, ...metadata } = capture;
    const body = await readVerified(
      committeeDir,
      { path, sha256: capture.sha256, byteSize: capture.byteCount },
      `source capture ${path}`,
    );
    sourceCaptures!.push({
      ...metadata,
      financeFields:
        metadata.financeFields === null ? null : { ...metadata.financeFields },
      body,
    });
  }

  const receipts = parseDelawareReceiptsCsv(
    (
      await readVerified(
        committeeDir,
        manifest.files.receiptsCsv,
        "receipts CSV",
      )
    ).toString("utf8"),
  );
  const expenses = parseDelawareExpensesCsv(
    (
      await readVerified(
        committeeDir,
        manifest.files.expensesCsv,
        "expenses CSV",
      )
    ).toString("utf8"),
  );
  const filedReports = parseDelawareFiledReportsHtml(
    (
      await readVerified(
        committeeDir,
        manifest.files.filedReportsHtml,
        "filed-reports grid",
      )
    ).toString("utf8"),
  );
  const reportPdfs = [];
  for (const pdfEntry of manifest.files.reportPdfs) {
    reportPdfs.push({
      publicReportFileName: pdfEntry.publicReportFileName,
      filingCalendarId: pdfEntry.filingCalendarId,
      body: await readVerified(
        committeeDir,
        pdfEntry,
        `report PDF ${pdfEntry.publicReportFileName}`,
      ),
    });
  }
  return {
    manifest,
    ...(sourceCaptures === undefined ? {} : { sourceCaptures }),
    ...(manifest.sourcePacketIndex === undefined
      ? {}
      : { sourcePacketIndex: structuredClone(manifest.sourcePacketIndex) }),
    ...(officialElectionSources === undefined
      ? {}
      : { officialElectionSources }),
    receiptRows: receipts.rows,
    receiptsMalformedRowCount: receipts.malformedRowCount,
    expenseRows: expenses.rows,
    expensesMalformedRowCount: expenses.malformedRowCount,
    filedReportRows: filedReports.rows,
    filedReportsGridTotal: filedReports.total,
    reportPdfs,
  };
}
