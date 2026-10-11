import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FloridaReviewedCommitteeDates } from "./floridaCommitteeRegistrySource.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";
import { FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY,
  isFloridaCommitteeCertificationRevocationEvidence } from "./floridaCommitteeDonorIdentity.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PDF_BYTES = 2 * 1024 * 1024; // Matches the registry's reviewed-PDF validation bound.
const MAX_RECORDS = 1000;
function fail(message: string): never {
  throw new Error(`Florida reviewed committee dates: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${label}`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`unknown ${label} field`);
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("invalid effective date");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    fail("invalid effective date");
  return value;
}
function path(value: unknown, parent: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0") ||
      /^[a-z][a-z\d+.-]*:\/\//i.test(value)) fail("invalid local artifact path");
  return resolve(parent, value);
}
async function boundedBytes(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail("artifact exceeds byte bound or is not a file");
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    for (;;) {
      const result = await handle.read(bytes, used, bytes.length - used, null);
      used += result.bytesRead;
      if (used > limit) fail("artifact exceeds byte bound");
      if (result.bytesRead === 0) break;
    }
    if (!used) fail("empty artifact");
    return bytes.subarray(0, used);
  } finally {
    await handle.close();
  }
}
async function json(filePath: string, limit: number): Promise<unknown> {
  const bytes = await boundedBytes(filePath, limit);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return fail("invalid artifact JSON/encoding"); }
}
function validatePdfUrl(value: unknown): string {
  if (typeof value !== "string") fail("invalid official PDF URL");
  let url: URL;
  try { url = new URL(value); } catch { return fail("invalid official PDF URL"); }
  if (url.origin !== "https://dos.elections.myflorida.com" || url.username || url.password || url.hash ||
      url.pathname !== "/campaign-docs/PDFHandler.ashx" || [...url.searchParams.keys()].length !== 2 ||
      !url.searchParams.has("AcctType") || !url.searchParams.has("TrackNum") ||
      !/^\d{1,2}\/\d{1,2}\/\d{2}(?:\d{2})?$/.test(url.searchParams.get("AcctType") ?? "") ||
      !/^[1-9]\d*$/.test(url.searchParams.get("TrackNum") ?? "")) fail("invalid official PDF URL");
  return value;
}
async function loadPdf(metadataPath: string, certificationRevocation = false): Promise<FloridaProcessedRawEvidence> {
  const meta = object(await json(metadataPath, MAX_METADATA_BYTES), "PDF metadata");
  const url = certificationRevocation
    ? FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY.sourceUrl : validatePdfUrl(meta.url);
  if (certificationRevocation && (meta.url !== url ||
    meta.sha256 !== FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY.sha256))
    fail("unreviewed certification revocation document");
  if (meta.status !== 200 || meta.method !== "GET" || meta.financeFields !== null ||
      typeof meta.contentType !== "string" || !/^application\/pdf(?:\s*;|$)/i.test(meta.contentType) ||
      !Number.isSafeInteger(meta.bytes) || (meta.bytes as number) < 5 || (meta.bytes as number) > MAX_PDF_BYTES ||
      typeof meta.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(meta.sha256)) fail("invalid PDF metadata envelope");
  if (typeof meta.startedAt !== "string" || typeof meta.completedAt !== "string") fail("invalid PDF capture interval");
  const start = Date.parse(meta.startedAt), end = Date.parse(meta.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) fail("invalid PDF capture interval");
  const bytesRaw = await boundedBytes(path(meta.rawPath, dirname(metadataPath)), MAX_PDF_BYTES);
  if (bytesRaw.length !== meta.bytes || bytesRaw.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      createHash("sha256").update(bytesRaw).digest("hex") !== meta.sha256) fail("PDF size/hash/magic mismatch");
  // Copy only public provenance fields; extra cache metadata or headers never escape this loader.
  return {
    bytesRaw, url, method: "GET", financeFields: null, status: 200,
    contentType: meta.contentType, sha256: meta.sha256, startedAt: meta.startedAt, completedAt: meta.completedAt,
  };
}

/** The caller's external manifest explicitly records human-reviewed account/date
 * bindings. This loader verifies immutable public PDF artifacts, not their meaning.
 * Genuine source timestamps are retained; local import time is never source time.
 */
export async function loadFloridaReviewedCommitteeDates(manifestPath: string): Promise<readonly FloridaReviewedCommitteeDates[]> {
  const absolutePath = path(manifestPath, process.cwd());
  const manifest = object(await json(absolutePath, MAX_MANIFEST_BYTES), "manifest");
  keys(manifest, ["version", "records"], "manifest");
  if (manifest.version !== 1 || !Array.isArray(manifest.records) || manifest.records.length > MAX_RECORDS)
    fail("unsupported manifest version/records");
  const seen = new Set<string>();
  const result: FloridaReviewedCommitteeDates[] = [];
  for (const rawRecord of manifest.records) {
    const record = object(rawRecord, "record");
    keys(record, ["committeeId", "registration", "disbandment", "certificationRevocation"], "record");
    if (typeof record.committeeId !== "string" || !/^[1-9]\d*$/.test(record.committeeId) ||
        !Number.isSafeInteger(Number(record.committeeId))) fail("invalid committee account");
    if (seen.has(record.committeeId)) fail("duplicate committee account");
    seen.add(record.committeeId);
    const output: FloridaReviewedCommitteeDates = { committeeId: record.committeeId };
    for (const kind of ["registration", "disbandment"] as const) {
      if (!(kind in record)) continue;
      const entry = object(record[kind], `${kind} entry`);
      const boundField = kind === "registration" ? "activeBy" : "closedBy";
      keys(entry, ["effectiveDate", boundField, "metadataPath"], `${kind} entry`);
      const dateFields = ["effectiveDate", boundField].filter(field => field in entry);
      if (dateFields.length !== 1) fail("provide exactly one reviewed date or temporal bound");
      const dateField = dateFields[0]!;
      const reviewedDate = date(entry[dateField]);
      const metadataPath = path(entry.metadataPath, dirname(absolutePath));
      const document = await loadPdf(metadataPath);
      if (kind === "registration") {
        output.registration = dateField === "effectiveDate"
          ? { effectiveDate: reviewedDate, document }
          : { activeBy: reviewedDate, document };
      } else {
        output.disbandment = dateField === "effectiveDate"
          ? { effectiveDate: reviewedDate, document }
          : { closedBy: reviewedDate, document };
      }
    }
    if ("certificationRevocation" in record) {
      const entry = object(record.certificationRevocation, "certification revocation");
      keys(entry, ["revokedOn", "section", "metadataPath"], "certification revocation");
      const authority = FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY;
      if (!isFloridaCommitteeCertificationRevocationEvidence({ revokedOn: entry.revokedOn,
        section: entry.section, sourceUrl: authority.sourceUrl, sha256: authority.sha256 }))
        fail("unreviewed certification revocation authority");
      const document = await loadPdf(path(entry.metadataPath, dirname(absolutePath)), true);
      output.certificationRevocation = { revokedOn: authority.revokedOn, section: authority.section, document };
    }
    if (!output.registration && !output.disbandment && !output.certificationRevocation)
      fail("record has no reviewed date or distinct authority");
    const exactRegistration = output.registration && "effectiveDate" in output.registration
      ? output.registration.effectiveDate : undefined;
    const closureBy = output.disbandment && ("effectiveDate" in output.disbandment
      ? output.disbandment.effectiveDate : output.disbandment.closedBy);
    if (exactRegistration && closureBy && exactRegistration > closureBy)
      fail("disbandment predates registration");
    result.push(output);
  }
  return result;
}
