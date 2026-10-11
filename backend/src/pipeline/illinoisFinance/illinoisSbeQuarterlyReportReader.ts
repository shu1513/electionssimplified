import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { IllinoisSbeTsvParser } from "./illinoisSbeTsvParser.js";
import { decodeIllinoisSbeWindows1252 } from "./illinoisSbeLegalCommitteeDonorMatcher.js";

export const ILLINOIS_SBE_FILED_DOCUMENTS_HEADER = [
  "ID", "CommitteeID", "FiledDocType", "DocName", "Amend", "Comment", "Pages",
  "ElectionType", "ElectionYear", "RptPdBegDate", "RptPdEndDate", "RcvdAt",
  "RcvdDateTime", "Source", "Provider", "SignerLastOnlyName", "SignerFirstName",
  "SbmttrLastOnlyName", "SbmttrFirstName", "SbmttrAddress1", "SbmttrAddress2",
  "SbmttrCity", "SbmttrState", "SbmttrZip", "B9SignerLastOnlyName",
  "B9SignerFirstName", "Archived", "Clarification", "RedactionRequested",
] as const;
export const ILLINOIS_SBE_D2_TOTALS_HEADER = [
  "ID", "CommitteeID", "FiledDocID", "BegFundsAvail", "IndivContribI",
  "IndivContribNI", "XferInI", "XferInNI", "LoanRcvI", "LoanRcvNI",
  "OtherRctI", "OtherRctNI", "TotalReceipts", "InKindI", "InKindNI",
  "TotalInKind", "XferOutI", "XferOutNI", "LoanMadeI", "LoanMadeNI",
  "ExpendI", "ExpendNI", "IndependentExpI", "IndependentExpNI", "TotalExpend",
  "DebtsI", "DebtsNI", "TotalDebts", "TotalInvest", "EndFundsAvail", "Archived",
] as const;
export type IllinoisSbeD2AmountField = Exclude<
  typeof ILLINOIS_SBE_D2_TOTALS_HEADER[number], "ID" | "CommitteeID" | "FiledDocID" | "Archived"
>;
export type IllinoisSbeQuarterlyDocument = {
  documentId: string; committeeId: string; docName: "Quarterly"; filedDocType: string;
  amend: boolean | null; archived: boolean | null; source: string;
  electionYear: string; electionType: string; periodStartRaw: string; periodEndRaw: string;
  periodStart: string | null; periodEnd: string | null;
  receivedAtRaw: string; receivedDay: string | null;
};
export type IllinoisSbeQuarterlyReport = {
  document: IllinoisSbeQuarterlyDocument;
  d2: { rowId: string; committeeId: string; filedDocId: string; archived: false;
    amountsRaw: Record<IllinoisSbeD2AmountField, string>;
    amountsTenThousandths: Record<IllinoisSbeD2AmountField, number>;
    amountsCents: Record<IllinoisSbeD2AmountField, number | null>;
    monetaryDiagnostics: Partial<Record<IllinoisSbeD2AmountField, string>>;
    components: { cashItemized: boolean; independentExpenditures: boolean; raised: boolean } };
};
export type IllinoisSbeBulkSourceMetadata = {
  path: string; sha256: string; bytes: number; rowCount: number;
};
export type IllinoisSbeQuarterlyManifestAndTotals = {
  coverageYears: number[];
  diagnostics: { excludedOutOfScopeMalformedPeriods: number };
  sources: { filedDocuments: IllinoisSbeBulkSourceMetadata; d2Totals: IllinoisSbeBulkSourceMetadata };
  documentsById: Map<string, IllinoisSbeQuarterlyDocument>;
  currentReportsByCommitteeId: Map<string, IllinoisSbeQuarterlyReport[]>;
  unknownCommittees: Map<string, string[]>;
};

function sourceBoolean(value: string): boolean | null {
  return value === "True" ? true : value === "False" ? false : null;
}
function positiveId(value: string): boolean { return /^[1-9]\d*$/.test(value); }
/** Source timestamps are civil Illinois dates, not UTC instants. Preserve raw fractions separately. */
function timestampDay(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, minute, second] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return y + "-" + m + "-" + d;
}
function tenThousandths(raw: string): number | null {
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const magnitude = BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, "0"));
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(negative ? -magnitude : magnitude);
}
async function streamSource(path: string, header: readonly string[], visit: (row: string[]) => void,
  expectedHash?: string): Promise<IllinoisSbeBulkSourceMetadata> {
  const before = await stat(path);
  if (!before.isFile() || before.size === 0) throw new Error("Illinois SBE source is not a nonempty file: " + path);
  const hash = createHash("sha256");
  let bytes = 0, rowCount = 0;
  const parser = new IllinoisSbeTsvParser({
    label: path, expectedHeader: header, visit(row) { rowCount++; visit(row); },
  });
  for await (const chunk of createReadStream(path)) {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += raw.length; hash.update(raw); parser.push(decodeIllinoisSbeWindows1252(raw));
  }
  parser.end();
  const after = await stat(path);
  if (bytes !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new Error("Illinois SBE source changed during reading: " + path);
  const sha256 = hash.digest("hex");
  if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256 !== expectedHash))
    throw new Error("Illinois SBE source SHA-256 mismatch: " + path);
  if (rowCount === 0) throw new Error("Illinois SBE source contains no records: " + path);
  return { path, sha256, bytes, rowCount };
}

/** Complete raw sources are structural requirements. Scoped semantic gaps invalidate only their committee. */
export async function readIllinoisSbeQuarterlyManifestAndTotals(input: {
  filedDocumentsPath: string; d2TotalsPath: string; coverageYears: readonly number[];
  expectedSha256?: { filedDocuments: string; d2Totals: string };
}): Promise<IllinoisSbeQuarterlyManifestAndTotals> {
  const coverageYears = [...new Set(input.coverageYears)].sort((a, b) => a - b);
  if (!coverageYears.length || coverageYears.some((year) => !Number.isInteger(year) || year < 1900 || year > 9999))
    throw new Error("Illinois SBE coverageYears must contain valid civil years");
  let excludedOutOfScopeMalformedPeriods = 0;
  const documentsById = new Map<string, IllinoisSbeQuarterlyDocument>();
  const unknownCommittees = new Map<string, string[]>();
  const unknown = (committeeId: string, reason: string) => {
    const reasons = unknownCommittees.get(committeeId) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    unknownCommittees.set(committeeId, reasons);
  };
  const documentSourceRows = new Map<string, string>();
  const filedDocuments = await streamSource(input.filedDocumentsPath, ILLINOIS_SBE_FILED_DOCUMENTS_HEADER, (row) => {
    if (row[3] !== "Quarterly") return;
    const periodStart = timestampDay(row[9]!), periodEnd = timestampDay(row[10]!);
    const validPeriod = periodStart !== null && periodEnd !== null && periodStart <= periodEnd;
    if (periodStart !== null && periodEnd !== null) {
      const low = periodStart < periodEnd ? periodStart : periodEnd;
      const high = periodStart < periodEnd ? periodEnd : periodStart;
      if (!coverageYears.some((year) => low <= year + "-12-31" && high >= year + "-01-01")) {
        if (!validPeriod) excludedOutOfScopeMalformedPeriods++;
        return;
      }
    }
    const document: IllinoisSbeQuarterlyDocument = {
      documentId: row[0]!, committeeId: row[1]!, docName: "Quarterly", filedDocType: row[2]!,
      amend: sourceBoolean(row[4]!), archived: sourceBoolean(row[26]!), source: row[13]!,
      electionYear: row[8]!, electionType: row[7]!, periodStartRaw: row[9]!, periodEndRaw: row[10]!,
      periodStart, periodEnd, receivedAtRaw: row[12]!, receivedDay: timestampDay(row[12]!),
    };
    if (!positiveId(document.committeeId) || !positiveId(document.documentId))
      unknown(document.committeeId, "Invalid Quarterly document identity " + document.documentId);
    if (!validPeriod || document.receivedDay === null || document.amend === null || document.archived === null)
      unknown(document.committeeId, "Invalid Quarterly metadata for document " + document.documentId);
    const fingerprint = JSON.stringify(row);
    const prior = documentSourceRows.get(document.documentId);
    if (prior !== undefined && prior !== fingerprint) {
      unknown(document.committeeId, "Conflicting document ID " + document.documentId);
      unknown(documentsById.get(document.documentId)!.committeeId, "Conflicting document ID " + document.documentId);
    } else if (prior === undefined) {
      documentSourceRows.set(document.documentId, fingerprint);
      documentsById.set(document.documentId, document);
    }
  }, input.expectedSha256?.filedDocuments);
  const d2ByDocument = new Map<string, string[][]>();
  const d2Totals = await streamSource(input.d2TotalsPath, ILLINOIS_SBE_D2_TOTALS_HEADER, (row) => {
    if (!documentsById.has(row[2]!)) return;
    const rows = d2ByDocument.get(row[2]!) ?? [];
    // Exact duplicates represent one identity; the raw source count still includes every record.
    if (!rows.some((prior) => prior.every((value, index) => value === row[index]))) rows.push(row);
    d2ByDocument.set(row[2]!, rows);
  }, input.expectedSha256?.d2Totals);
  const periods = new Map<string, IllinoisSbeQuarterlyDocument[]>();
  for (const document of documentsById.values()) {
    if (document.periodStart === null || document.periodEnd === null) continue;
    const key = JSON.stringify([document.committeeId, document.periodStart, document.periodEnd]);
    const rows = periods.get(key) ?? []; rows.push(document); periods.set(key, rows);
  }
  const currentReportsByCommitteeId = new Map<string, IllinoisSbeQuarterlyReport[]>();
  const scopedD2Ids = new Map<string, { fingerprint: string; committeeId: string }>();
  for (const documents of periods.values()) {
    const committeeId = documents[0]!.committeeId;
    const current = documents.filter((document) => document.archived === false);
    if (current.length !== 1) {
      unknown(committeeId, "Expected one current Quarterly document for period " +
        documents[0]!.periodStart + ".." + documents[0]!.periodEnd);
      continue;
    }
    const document = current[0]!;
    const rows = d2ByDocument.get(document.documentId) ?? [];
    const active = rows.filter((row) => row[30] === "False");
    if (active.length !== 1 || rows.some((row) => sourceBoolean(row[30]!) === null)) {
      unknown(committeeId, "Missing or ambiguous current D2 totals for document " + document.documentId);
      continue;
    }
    const row = active[0]!;
    if (!positiveId(row[0]!) || row[1] !== committeeId || row[2] !== document.documentId) {
      unknown(committeeId, "D2 ownership or identity mismatch for document " + document.documentId);
      continue;
    }
    const fingerprint = JSON.stringify(row), prior = scopedD2Ids.get(row[0]!);
    if (prior !== undefined && prior.fingerprint !== fingerprint) {
      unknown(committeeId, "Conflicting D2 row ID " + row[0]);
      unknown(prior.committeeId, "Conflicting D2 row ID " + row[0]);
    }
    scopedD2Ids.set(row[0]!, { fingerprint, committeeId });
    const amountsRaw = {} as Record<IllinoisSbeD2AmountField, string>;
    const amountsTenThousandths = {} as Record<IllinoisSbeD2AmountField, number>;
    const amountsCents = {} as Record<IllinoisSbeD2AmountField, number | null>;
    const monetaryDiagnostics: Partial<Record<IllinoisSbeD2AmountField, string>> = {};
    let invalidAmount = false;
    const nonnegativeFields = new Set<IllinoisSbeD2AmountField>([
      "IndivContribI", "XferInI", "IndependentExpI", "IndependentExpNI",
      "TotalReceipts", "TotalExpend", "TotalDebts",
    ]);
    for (let index = 3; index < 30; index++) {
      const field = ILLINOIS_SBE_D2_TOTALS_HEADER[index] as IllinoisSbeD2AmountField;
      const raw = row[index]!;
      const value = tenThousandths(raw);
      if (value === null) { invalidAmount = true; break; }
      amountsRaw[field] = raw; amountsTenThousandths[field] = value;
      const exact = value % 100 === 0;
      const invalidSign = nonnegativeFields.has(field) && value < 0;
      amountsCents[field] = exact && !invalidSign ? value / 100 : null;
      if (!exact) monetaryDiagnostics[field] = "Published amount is not an exact number of cents";
      if (invalidSign) monetaryDiagnostics[field] = "Negative amount is unsupported for this component";
    }
    if (invalidAmount) {
      unknown(committeeId, "Invalid D2 monetary amount for document " + document.documentId); continue;
    }
    const components = {
      cashItemized: amountsCents.IndivContribI !== null && amountsCents.XferInI !== null,
      independentExpenditures: amountsCents.IndependentExpI !== null && amountsCents.IndependentExpNI !== null,
      raised: amountsCents.TotalReceipts !== null,
    };
    const reports = currentReportsByCommitteeId.get(committeeId) ?? [];
    reports.push({ document, d2: { rowId: row[0]!, committeeId, filedDocId: document.documentId,
      archived: false, amountsRaw, amountsTenThousandths, amountsCents, monetaryDiagnostics, components } });
    currentReportsByCommitteeId.set(committeeId, reports);
  }
  for (const committeeId of unknownCommittees.keys()) currentReportsByCommitteeId.delete(committeeId);
  for (const reports of currentReportsByCommitteeId.values())
    reports.sort((a, b) => a.document.periodStart!.localeCompare(b.document.periodStart!) ||
      a.document.documentId.localeCompare(b.document.documentId));
  return { coverageYears, diagnostics: { excludedOutOfScopeMalformedPeriods }, sources: { filedDocuments, d2Totals }, documentsById,
    currentReportsByCommitteeId, unknownCommittees };
}
