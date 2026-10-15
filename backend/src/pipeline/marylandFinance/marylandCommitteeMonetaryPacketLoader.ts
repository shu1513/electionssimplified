import { readMarylandPartitionedContributionCensus } from "./marylandPartitionedContributionCensus.js";
import { readMarylandCurrentReportInventory, buildMarylandPublicReportInventoryRequest } from "./marylandPublicReportClient.js";
import { bindMarylandNativeReportOccurrences } from "./marylandNativeReportBinding.js";
import { readMarylandSavedReportDocument } from "./marylandSavedReportDocumentReader.js";
import { readMarylandReportSummary } from "./marylandReportSummaryReader.js";
import { readMarylandLegacyReturnedContributionObservations, proveMarylandLegacyReturnCashFamilies } from "./marylandLegacyReturnedContributionFacts.js";
import { parseMarylandCfsMoney } from "./marylandCfsArtifactReader.js";
import { bindMarylandOutsideReceivingContext, type MarylandOutsideReceivingContextInput } from "./marylandOutsideReceivingContext.js";
import { aggregateMarylandReportedCommitteePositions } from "./marylandNativePacAggregator.js";
import type { MarylandCommitteeMonetarySnapshot } from "./marylandCommitteeMonetaryWriter.js";

export type MarylandCommitteeMonetaryPacketSource = Readonly<{
  currentCensusDirectory: string;
  priorCensusDirectory: string;
  priorCycle: string;
  inventoryDirectory: string;
  documents: readonly Readonly<{ reportGuid: string; reportVersionId: number; originalPath: string; captureJournalPath: string }>[];
}>;
export type MarylandCommitteeMonetaryPacketInput = Readonly<{
  source: MarylandCommitteeMonetaryPacketSource;
  receivingContext: MarylandOutsideReceivingContextInput;
  now?: Date;
}>;
type CaptureRole = "current_census" | "prior_census" | "inventory" | "pdf" | "receiving_context";
type CaptureFact = Readonly<{ role: CaptureRole; sha256: string; byteCount: number; startedAt: string; completedAt: string }>;
const financialBasis = "active_native_api_with_published_summary_controls" as const;
type NativeRow = Readonly<Record<string, unknown>>;
type Family = "monetaryGifts" | "transfers" | "otherReceipts" | "inKindGifts" | "anonymousAggregates" | "cashReturns" | "inKindReturns";
type NativeFamilies = Record<Family, { count: number; cents: number }>;
type FamilyControl = { family: Family | "cashGifts"; nativeCents: number; controlCents: number | null; differenceCents: number | null };
export type MarylandCommitteeMonetaryPacketReportFact = {
  reportOrdinal: number;
  financialBasis: typeof financialBasis;
  detailVerification: "not_performed";
  format?: "legacy" | "modern";
  sha256?: string;
  byteCount?: number;
  pageCount?: number;
  nativeOccurrences: number;
  nativeFamilies?: NativeFamilies;
  familyControls?: FamilyControl[];
  publishedAnonymousTransactionCount?: number | null;
  anonymousItemizationComparison: "not_evaluable";
  legacyCashReturnFamily?: { returnCount: number; returnCents: number };
};
export type MarylandCommitteeMonetaryPacketFacts = {
  financialBasis: typeof financialBasis;
  detailVerification: "not_performed";
  nativeSchema?: { rowsChecked: number; absentReturnDisplays: number; originalFamilyReturnDisplays: number };
  currentRows: number;
  priorRows: number;
  reportCount: number;
  reportsCompared: number;
  captureCount: number;
  capturedBytes: number;
  originalCaptures: CaptureFact[];
  sourceObservedAt?: string;
  inventoryObservedAt?: string;
  positionCount?: number;
  grossCents?: number;
  refundCents?: number;
  netCents?: number;
};
export type MarylandCommitteeMonetaryPacketResult = {
  status: "preserve";
  diagnostics: string[];
  sourceFacts: MarylandCommitteeMonetaryPacketFacts;
  reports: MarylandCommitteeMonetaryPacketReportFact[];
} | {
  status: "ready";
  privateSnapshot: MarylandCommitteeMonetarySnapshot;
  diagnostics: string[];
  sourceFacts: MarylandCommitteeMonetaryPacketFacts;
  reports: MarylandCommitteeMonetaryPacketReportFact[];
};
const guid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s);
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
function instant(s: unknown): bigint {
  if (typeof s !== "string") throw Error("invalid_capture_time");
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(s);
  const ms = m ? Date.parse(`${m[1]}Z`) : NaN;
  if (!m || s.startsWith("0000") || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== m[1]) throw Error("invalid_capture_time");
  return BigInt(ms) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
const classLabels: Readonly<Record<string, string>> = {
  TBSN: "Business/Group/Organization", TCC: "Candidate Committee", TFED: "Federal Committee", TIND: "Individual", TLAB: "Labor Union", TNPO: "Non-Profit Organization",
  TPAC: "Political Action Committee", TPCC: "Party Central Committee", TPCLB: "Political Club", TPOC: "Participating Organization Committee", TRNFC: "Registered Out-of-State (Non-Federal) Committee",
  TSLATE: "Slate Committee", TSPDC: "Spouse", TUNFC: "Unregistered Out-of-State (Non-Federal) Committee",
};
// Literal finite displays observed in both complete native censuses. The
// publisher retains original gift-family displays on some cash returns.
const giftDisplays: Readonly<Record<string, readonly string[]>> = {
  CMONT: ["Monetary - Cash", "Monetary - Check", "Monetary - Credit Card", "Monetary - Electronic Fund Transfer (EFT)"],
  TRFR: ["Transfer"], CINKIND: ["In-Kind"], OTHRINCM: ["Other Income", "Other Income - Electronic Fund Transfer (EFT)"], ANYMS: ["Anonymous"],
};
const nameKey = (s: unknown) => typeof s === "string" ? s.trim().replace(/\s+/g, " ").toUpperCase() : "";
function validateNativeSchema(rows: readonly NativeRow[]) {
  const gifts = new Map(rows.filter(r => r.isReturn === false).map(r => [r.transactionId, r]));
  let absentReturnDisplays = 0, originalFamilyReturnDisplays = 0;
  for (const r of rows) {
    const code = r.contributionTypeCode, display = r.contributionType, cls = r.contributorTypeCode;
    if (r.isActive !== true || typeof r.isReturn !== "boolean" || r.transactionTypeCode !== (r.isReturn ? "TRCON" : "TCON") ||
      typeof code !== "string" || !Object.hasOwn(giftDisplays, code) ||
      (cls === null ? code !== "ANYMS" || r.contributorType !== null : typeof cls !== "string" || !Object.hasOwn(classLabels, cls) || r.contributorType !== classLabels[cls]) ||
      (code === "ANYMS" && (cls !== null || r.isReturn))) throw Error("invalid_native_schema");
    if (!r.isReturn) {
      if (typeof display !== "string" || !giftDisplays[code]!.includes(display)) throw Error("invalid_native_display");
      continue;
    }
    if ((code === "CINKIND" && display === "In-Kind") || (code === "TRFR" && display === "Transfer") || (code === "CMONT" && display === "Monetary")) continue;
    if (code !== "CMONT" || (display !== null && display !== "In-Kind" && display !== "Transfer")) throw Error("invalid_native_display");
    const parent = gifts.get(r.parentTransactionId), expected = display === "In-Kind" ? "CINKIND" : display === "Transfer" ? "TRFR" : null;
    if (!parent || (expected !== null && parent.contributionTypeCode !== expected) || !guid(parent.transactionGuid) ||
      (r.parentTransactionGuid !== null && (typeof r.parentTransactionGuid !== "string" || r.parentTransactionGuid.toLowerCase() !== parent.transactionGuid.toLowerCase())) ||
      !nameKey(r.contributorName) || nameKey(r.contributorName) !== nameKey(parent.contributorName) ||
      !guid(r.filerRegistrationGuid) || !guid(parent.filerRegistrationGuid) || r.filerRegistrationGuid.toLowerCase() !== parent.filerRegistrationGuid.toLowerCase() ||
      typeof r.transactionDate !== "string" || typeof parent.transactionDate !== "string" || r.transactionDate < parent.transactionDate) throw Error("return_display_parent");
    if (display === null) absentReturnDisplays++; else originalFamilyReturnDisplays++;
  }
  return { rowsChecked: rows.length, absentReturnDisplays, originalFamilyReturnDisplays };
}
function add(a: number, b: number) { const n = a + b; if (!Number.isSafeInteger(n)) throw Error("unsafe_total"); return n; }
function nativeFamilies(rows: readonly NativeRow[]): NativeFamilies {
  const result = Object.fromEntries(["monetaryGifts", "transfers", "otherReceipts", "inKindGifts", "anonymousAggregates", "cashReturns", "inKindReturns"].map(k => [k, { count: 0, cents: 0 }])) as NativeFamilies;
  for (const r of rows) {
    const dollars = typeof r.transactionAmount === "number" ? parseMarylandCfsMoney(String(r.transactionAmount)) : null;
    if (dollars === null || dollars <= 0) throw Error("invalid_native_amount");
    const code = r.contributionTypeCode;
    const family: Family = r.isReturn ? code === "CINKIND" ? "inKindReturns" : "cashReturns" : code === "CMONT" ? "monetaryGifts" : code === "TRFR" ? "transfers" : code === "OTHRINCM" ? "otherReceipts" : code === "CINKIND" ? "inKindGifts" : "anonymousAggregates";
    result[family].count++; result[family].cents = add(result[family].cents, Math.round(dollars * 100));
  }
  return result;
}

/** Recomputes one complete saved packet from original source captures. No
 * caller-supplied comparison, subset, success token or parsed row is accepted.
 * This explicit API ledger/summary basis never attempts or upgrades receipt
 * detail/status/identity verification. Only the private ready snapshot may be
 * passed to the component writer. */
export async function loadMarylandCommitteeMonetaryPacket(input: MarylandCommitteeMonetaryPacketInput): Promise<MarylandCommitteeMonetaryPacketResult> {
  const diagnostics: string[] = [], reports: MarylandCommitteeMonetaryPacketReportFact[] = [];
  const sourceFacts: MarylandCommitteeMonetaryPacketFacts = { financialBasis, detailVerification: "not_performed", currentRows: 0, priorRows: 0, reportCount: 0, reportsCompared: 0, captureCount: 0, capturedBytes: 0, originalCaptures: [] };
  const preserve = (): MarylandCommitteeMonetaryPacketResult => ({ status: "preserve", diagnostics, sourceFacts, reports });
  let retained: MarylandCommitteeMonetaryPacketInput, now: bigint, stage = "input";
  try {
    retained = freeze(structuredClone(input));
    const date = retained.now ?? new Date();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw Error("invalid_now");
    now = BigInt(date.getTime()) * 1000n;
    const s = retained.source;
    if (!s || ![s.currentCensusDirectory, s.priorCensusDirectory, s.inventoryDirectory].every(p => typeof p === "string" && p.trim()) ||
      s.currentCensusDirectory === s.priorCensusDirectory || !/^[1-9]\d*$/.test(s.priorCycle) || !Array.isArray(s.documents) || !s.documents.length || s.documents.length > 10000 ||
      s.documents.some(d => !d || !guid(d.reportGuid) || !Number.isSafeInteger(d.reportVersionId) || d.reportVersionId < 1 || typeof d.originalPath !== "string" || typeof d.captureJournalPath !== "string")) throw Error("invalid_input");
    const capture = (role: CaptureRole, c: { sha256: string; byteCount: number; startedAt: string; completedAt: string }) => {
      if (!/^[a-f0-9]{64}$/.test(c.sha256) || !Number.isSafeInteger(c.byteCount) || c.byteCount < 1 || instant(c.startedAt) > instant(c.completedAt) || instant(c.completedAt) > now) throw Error("invalid_capture");
      sourceFacts.originalCaptures.push(Object.freeze({ role, sha256: c.sha256, byteCount: c.byteCount, startedAt: c.startedAt, completedAt: c.completedAt }));
      sourceFacts.captureCount++;
      sourceFacts.capturedBytes += c.byteCount;
      if (!Number.isSafeInteger(sourceFacts.capturedBytes)) throw Error("unsafe_total");
      if (["current_census", "prior_census", "pdf"].includes(role) && (sourceFacts.sourceObservedAt === undefined || instant(c.completedAt) < instant(sourceFacts.sourceObservedAt))) sourceFacts.sourceObservedAt = c.completedAt;
    };
    stage = "receiving_context";
    const context = await bindMarylandOutsideReceivingContext(retained.receivingContext);
    if (!context.binding || context.diagnostics.length) throw Error("unbound_context");
    const receiver = context.binding, currentCycle = receiver.sourceCycle.value;
    if (s.priorCycle === currentCycle || Number(s.priorCycle) >= Number(currentCycle)) throw Error("invalid_prior_cycle");
    for (const c of receiver.sourceMetadata) capture("receiving_context", c);
    stage = "current_census";
    const current = await readMarylandPartitionedContributionCensus({ filerRegistrationGuid: receiver.filerRegistrationGuid, electionCycle: currentCycle, outputDirectory: s.currentCensusDirectory });
    sourceFacts.currentRows = current.rows.length;
    for (const c of current.captures) capture("current_census", c);
    stage = "prior_census";
    const prior = await readMarylandPartitionedContributionCensus({ filerRegistrationGuid: receiver.filerRegistrationGuid, electionCycle: s.priorCycle, outputDirectory: s.priorCensusDirectory });
    sourceFacts.priorRows = prior.rows.length;
    for (const c of prior.captures) capture("prior_census", c);
    stage = "native_schema";
    sourceFacts.nativeSchema = validateNativeSchema([...current.rows, ...prior.rows]);
    stage = "inventory";
    const inventory = await readMarylandCurrentReportInventory({ filerRegistrationGuid: receiver.filerRegistrationGuid, electionCycleId: currentCycle, outputDirectory: s.inventoryDirectory });
    sourceFacts.reportCount = inventory.privateReports.length;
    sourceFacts.inventoryObservedAt = inventory.sourceFacts.completedAt;
    for (const c of inventory.captures) capture("inventory", c);
    if (!sourceFacts.reportCount || s.documents.length !== sourceFacts.reportCount) throw Error("incomplete_documents");
    const inventoryRequest = buildMarylandPublicReportInventoryRequest({ filerRegistrationGuid: receiver.filerRegistrationGuid, electionCycleId: currentCycle, pageNumber: 1 });
    const bound = bindMarylandNativeReportOccurrences({ reports: inventory.privateReports, request: inventoryRequest, nativeRows: current.rows });
    const descriptors = new Map<string, typeof s.documents[number]>(), originals = new Set<string>();
    for (const d of s.documents) {
      const key = `${d.reportGuid.toLowerCase()}:${d.reportVersionId}`;
      if (descriptors.has(key) || originals.has(d.originalPath)) throw Error("duplicate_document");
      descriptors.set(key, d); originals.add(d.originalPath);
    }
    if (bound.reports.some(b => !descriptors.has(`${b.report.reportGuid.toLowerCase()}:${b.report.reportVersionId}`))) throw Error("unbound_document");
    const legacyReports: Parameters<typeof proveMarylandLegacyReturnCashFamilies>[0]["pdfReports"][number][] = [];
    for (const [reportOrdinal, bucket] of bound.reports.entries()) {
      const fact: MarylandCommitteeMonetaryPacketReportFact = { reportOrdinal, financialBasis, detailVerification: "not_performed", anonymousItemizationComparison: "not_evaluable", nativeOccurrences: bucket.rows.length };
      reports.push(fact);
      try {
        const descriptor = descriptors.get(`${bucket.report.reportGuid.toLowerCase()}:${bucket.report.reportVersionId}`)!;
        const document = await readMarylandSavedReportDocument({ report: bucket.report, originalPath: descriptor.originalPath, captureJournalPath: descriptor.captureJournalPath });
        capture("pdf", document.sourceFacts);
        const summary = await readMarylandReportSummary(document.privateBytes);
        fact.format = summary.format; fact.sha256 = document.sourceFacts.sha256; fact.byteCount = document.sourceFacts.byteCount; fact.pageCount = summary.sourceFacts.pageCount;
        if (summary.sourceFacts.sha256 !== document.sourceFacts.sha256 || summary.sourceFacts.byteCount !== document.sourceFacts.byteCount) throw Error("different_document");
        const families = nativeFamilies(bucket.rows), comparisons: FamilyControl[] = [];
        fact.nativeFamilies = families; fact.familyControls = comparisons;
        const compare = (family: FamilyControl["family"], controlCents: number | null) => {
          const cents = family === "cashGifts" ? add(add(families.monetaryGifts.cents, families.transfers.cents), families.otherReceipts.cents) : families[family].cents;
          comparisons.push({ family, nativeCents: cents, controlCents, differenceCents: controlCents === null ? null : cents - controlCents });
        };
        if (summary.format === "modern") {
          const control = (number: number) => { const matches = summary.controls.controls.filter(c => c.number === number); if (matches.length !== 1) throw Error("invalid_control"); return matches[0]!.amountCents; };
          compare("cashGifts", control(1));
          compare("anonymousAggregates", control(2)); compare("inKindGifts", add(control(19), control(20)));
          compare("cashReturns", control(3)); compare("inKindReturns", add(control(21), control(22)));
          fact.publishedAnonymousTransactionCount = summary.controls.anonymousTransactionCount;
        } else {
          const columns = (letters: readonly string[]) => { const matches = summary.controls.receiptControls.filter(c => letters.includes(c.column));
            if (matches.length !== letters.length || letters.some(letter => matches.filter(c => c.column === letter).length !== 1)) throw Error("invalid_control");
            return matches.reduce((n, c) => add(n, c.amountCents), 0); };
          compare("monetaryGifts", columns(["A", "B", "C", "D"])); compare("transfers", columns(["E", "F", "G", "H"])); compare("otherReceipts", columns(["I"]));
          compare("inKindGifts", summary.controls.inKind.contributionsCents); compare("anonymousAggregates", null); compare("inKindReturns", null);
          fact.publishedAnonymousTransactionCount = null;
          if (families.anonymousAggregates.count || families.inKindReturns.count) diagnostics.push(`report_${reportOrdinal}_uncontrolled_native_family`);
          const z = summary.controls.expenseControls.filter(c => c.schedule === "2" && c.column === "Z"); if (z.length !== 1) throw Error("invalid_control");
          compare("cashReturns", z[0]!.amountCents);
          const returns = await readMarylandLegacyReturnedContributionObservations(document.privateBytes);
          if (returns.sourceFacts.sha256 !== document.sourceFacts.sha256 || returns.sourceFacts.byteCount !== document.sourceFacts.byteCount) throw Error("different_return_document");
          legacyReports.push({ report: bucket.report, facts: returns });
          fact.legacyCashReturnFamily = { returnCount: returns.sourceFacts.returnCount, returnCents: returns.sourceFacts.returnCents };
        }
        if (comparisons.some(c => c.differenceCents !== null && c.differenceCents !== 0)) diagnostics.push(`report_${reportOrdinal}_financial_family_controls`);
        sourceFacts.reportsCompared++;
      } catch { diagnostics.push(`report_${reportOrdinal}_source_unavailable`); }
    }
    stage = "legacy_return_family";
    const returnFamilies = legacyReports.length ? proveMarylandLegacyReturnCashFamilies({ reports: inventory.privateReports, inventoryRequest, currentRows: current.rows, priorRows: prior.rows, pdfReports: legacyReports }) : undefined;
    stage = "reported_committee_arithmetic";
    const aggregation = aggregateMarylandReportedCommitteePositions({ receivingGuid: receiver.filerRegistrationGuid, currentCycle, priorCycle: s.priorCycle,
      currentRows: current.rows, priorRows: prior.rows, declaredCurrentRows: current.declaredRows, declaredPriorRows: prior.declaredRows, receivingContext: receiver, legacyReturnCashFamilies: returnFamilies });
    sourceFacts.positionCount = aggregation.positions.length; sourceFacts.grossCents = aggregation.grossCents; sourceFacts.refundCents = aggregation.refundCents; sourceFacts.netCents = aggregation.netCents;
    if (diagnostics.length || sourceFacts.reportsCompared !== sourceFacts.reportCount) return preserve();
    stage = "source_times";
    if (!sourceFacts.sourceObservedAt || instant(sourceFacts.sourceObservedAt) > instant(sourceFacts.inventoryObservedAt) || !sourceFacts.captureCount || ![sourceFacts.currentRows, sourceFacts.priorRows].every(count)) throw Error("invalid_source_times");
    const c = receiver.canonical;
    return { status: "ready", diagnostics, sourceFacts, reports, privateSnapshot: {
      linkId: c.linkId, candidateId: c.candidateId, electionId: c.electionId, electionYear: c.electionYear, receivingCommitteeId: c.committeeId,
      aggregation, sourceUrl: "https://campaignfinance.maryland.gov", sourceObservedAt: new Date(sourceFacts.sourceObservedAt), inventoryObservedAt: new Date(sourceFacts.inventoryObservedAt),
      provenance: { financialBasis, reportCount: sourceFacts.reportCount, captureCount: sourceFacts.captureCount, originalSha256s: sourceFacts.originalCaptures.map(capture => capture.sha256) },
    } };
  } catch { diagnostics.push(`${stage}_unavailable`); return preserve(); }
}
