import { parseMarylandCfsMoney } from "./marylandCfsArtifactReader.js";
import type { bindMarylandOutsideReceivingContext } from "./marylandOutsideReceivingContext.js";
import type { compareMarylandLegacyCommitteeReturnOccurrences, proveMarylandLegacyReturnCashFamilies } from "./marylandLegacyReturnedContributionFacts.js";
import { bindMarylandNativeReportOccurrences } from "./marylandNativeReportBinding.js";
import { buildMarylandPublicReportInventoryRequest } from "./marylandPublicReportClient.js";

type SourceRow = Readonly<Record<string, unknown>>;
type ParsedRow = {
  id: number; guid: string; date: string; amountCents: number;
  role: "TCON" | "TRCON"; mechanism: string; donorType: string | null;
  donorName: string; parentId: number | null; parentGuid: string | null;
};
export class MarylandNativePacAggregationError extends Error {
  constructor(public readonly code: "invalid_scope" | "incomplete_collection" | "invalid_row" |
    "duplicate_identity" | "unresolved_parent" | "parent_identity" | "refund_exceeds_gift" |
    "unsafe_total" | "negative_position") {
    super(`Maryland native PAC aggregation: ${code}`);
  }
}
function fail(code: ConstructorParameters<typeof MarylandNativePacAggregationError>[0]): never {
  throw new MarylandNativePacAggregationError(code);
}
const guid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nameKey = (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase();
const classes = new Set(["TBSN", "TCC", "TFED", "TIND", "TLAB", "TNPO", "TPAC", "TPCC",
  "TPCLB", "TPOC", "TRNFC", "TSLATE", "TSPDC", "TUNFC"]);
const mechanisms = new Set(["ANYMS", "CINKIND", "CMONT", "OTHRINCM", "TRFR"]);
const cashGift = (row: ParsedRow) => row.mechanism === "CMONT" || row.mechanism === "TRFR";
function add(left: number, right: number) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) return fail("unsafe_total");
  return result;
}

/** Pure whole-collection arithmetic facts. Acquisition manifests, current
 * report membership/controls and candidate ownership must qualify separately
 * before any writer consumes these positions. This function grants no freshness
 * or publication authority and never calls a source, provider or database. */
export function aggregateMarylandNativePacPositions(input: {
  receivingGuid: string; currentCycle: string; priorCycle: string;
  currentRows: readonly SourceRow[]; priorRows: readonly SourceRow[];
  declaredCurrentRows: number; declaredPriorRows: number;
}) {
  if (!guid(input.receivingGuid) || !/^[1-9]\d*$/.test(input.currentCycle) ||
    !/^[1-9]\d*$/.test(input.priorCycle) || input.currentCycle === input.priorCycle ||
    !Number.isSafeInteger(input.declaredCurrentRows) || input.declaredCurrentRows < 0 ||
    !Number.isSafeInteger(input.declaredPriorRows) || input.declaredPriorRows < 0) fail("invalid_scope");
  if (input.currentRows.length !== input.declaredCurrentRows || input.priorRows.length !== input.declaredPriorRows)
    fail("incomplete_collection");
  const ids = new Set<number>(), guids = new Set<string>();
  function parse(row: SourceRow, cycle: string): ParsedRow {
    const amount = typeof row.transactionAmount === "number" && Number.isFinite(row.transactionAmount)
      ? parseMarylandCfsMoney(String(row.transactionAmount)) : null;
    const donorType = row.contributorTypeCode;
    if (!guid(row.filerRegistrationGuid) || row.filerRegistrationGuid.toLowerCase() !== input.receivingGuid.toLowerCase() ||
      !Number.isSafeInteger(row.electionCycleId) || String(row.electionCycleId) !== cycle ||
      !positiveId(row.transactionId) || !guid(row.transactionGuid) ||
      row.isActive !== true || typeof row.isReturn !== "boolean" ||
      row.transactionTypeCode !== (row.isReturn ? "TRCON" : "TCON") ||
      typeof row.contributionTypeCode !== "string" || !mechanisms.has(row.contributionTypeCode) ||
      (donorType !== null && (typeof donorType !== "string" || !classes.has(donorType))) ||
      (donorType === null && row.contributionTypeCode !== "ANYMS") ||
      (donorType === "TPAC" && row.contributorType !== "Political Action Committee") ||
      (row.contributionTypeCode !== "ANYMS" && (typeof row.contributorName !== "string" || !row.contributorName.trim())) ||
      amount === null || amount <= 0 ||
      typeof row.transactionDate !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.transactionDate) ||
      !Number.isFinite(Date.parse(`${row.transactionDate}Z`)) ||
      new Date(`${row.transactionDate}Z`).toISOString().slice(0, 19) !== row.transactionDate)
      return fail("invalid_row");
    const id = row.transactionId as number, identity = (row.transactionGuid as string).toLowerCase();
    if (ids.has(id) || guids.has(identity)) return fail("duplicate_identity");
    ids.add(id); guids.add(identity);
    if (row.isReturn && (!positiveId(row.parentTransactionId) ||
      (row.parentTransactionGuid !== null && !guid(row.parentTransactionGuid)))) return fail("invalid_row");
    return {id, guid: identity, date: row.transactionDate as string,
      amountCents: Math.round(amount * 100), role: row.transactionTypeCode as ParsedRow["role"],
      mechanism: row.contributionTypeCode as string, donorType: donorType as string | null,
      donorName: typeof row.contributorName === "string" ? row.contributorName.trim().replace(/\s+/g, " ") : "",
      parentId: row.isReturn ? row.parentTransactionId as number : null,
      parentGuid: row.isReturn && typeof row.parentTransactionGuid === "string" ? row.parentTransactionGuid.toLowerCase() : null};
  }
  const current = input.currentRows.map(row => parse(row, input.currentCycle));
  const prior = input.priorRows.map(row => parse(row, input.priorCycle));
  const gifts = new Map([...current, ...prior].filter(row => row.role === "TCON").map(row => [row.id, row]));
  const positions = new Map<string, {donorName: string; grossCents: number; refundCents: number; giftCount: number; refundCount: number}>();
  function position(gift: ParsedRow) {
    const key = nameKey(gift.donorName);
    let result = positions.get(key);
    if (!result) {result = {donorName: gift.donorName, grossCents: 0, refundCents: 0, giftCount: 0, refundCount: 0};positions.set(key, result);}
    return result;
  }
  for (const gift of current) {
    if (gift.role !== "TCON" || gift.donorType !== "TPAC" || !cashGift(gift)) continue;
    const p = position(gift); p.grossCents = add(p.grossCents, gift.amountCents); p.giftCount++;
  }
  // Previous-cycle refunds count toward an original gift's lifetime bound;
  // only current-cycle refunds reduce current-cycle positions.
  const refundedByParent = new Map<number, number>();
  const nonPacOverRefundParents = new Set<number>();
  const currentParents = new Set(current.filter(row => row.role === "TRCON").map(row => row.parentId!));
  for (const refund of [...prior, ...current]) {
    if (refund.role !== "TRCON" || !currentParents.has(refund.parentId!)) continue;
    const original = gifts.get(refund.parentId!);
    if (!original) fail("unresolved_parent");
    if ((refund.parentGuid !== null && refund.parentGuid !== original.guid) ||
      nameKey(refund.donorName) !== nameKey(original.donorName) || refund.date < original.date) fail("parent_identity");
    const cumulative = add(refundedByParent.get(original.id) ?? 0, refund.amountCents);
    if (cumulative > original.amountCents) {
      if (original.donorType === "TPAC") fail("refund_exceeds_gift");
      // Preserve the published non-PAC anomaly as a diagnostic. These facts
      // cannot qualify an overall cash summary; no non-PAC money enters a PAC
      // position and no source row/refund is removed from the collection.
      nonPacOverRefundParents.add(original.id);
    }
    refundedByParent.set(original.id, cumulative);
  }
  for (const refund of current) {
    if (refund.role !== "TRCON") continue;
    const original = gifts.get(refund.parentId!)!;
    if (original.donorType === "TPAC" && !cashGift(original) && cashGift(refund)) fail("parent_identity");
    // Reported refund class can differ: genuine TPOC refunds resolve to TPAC
    // original gifts. Neither the refund class nor a positive sign owns a gift.
    if (original.donorType !== "TPAC" || !cashGift(original) || !cashGift(refund)) continue;
    const p = position(original);p.refundCents = add(p.refundCents, refund.amountCents);p.refundCount++;
  }
  const result = [...positions.values()].map(p => ({...p, netCents: add(p.grossCents, -p.refundCents)}));
  if (result.some(p => p.netCents < 0)) fail("negative_position");
  result.sort((a, b) => b.netCents - a.netCents || a.donorName.localeCompare(b.donorName));
  return {positions: result, sourceRows: current.length, resolvedRefunds: current.filter(r => r.role === "TRCON").length,
    nonPacOverRefundParentCount: nonPacOverRefundParents.size,
    giftCount: result.reduce((n, p) => n + p.giftCount, 0), refundCount: result.reduce((n, p) => n + p.refundCount, 0),
    grossCents: result.reduce((n, p) => add(n, p.grossCents), 0), refundCents: result.reduce((n, p) => add(n, p.refundCents), 0),
    netCents: result.reduce((n, p) => add(n, p.netCents), 0)};
}

const reportedClassLabels = {
  TBSN: "Business/Group/Organization", TCC: "Candidate Committee", TFED: "Federal Committee",
  TIND: "Individual", TLAB: "Labor Union", TNPO: "Non-Profit Organization",
  TPAC: "Political Action Committee", TPCC: "Party Central Committee", TPCLB: "Political Club",
  TPOC: "Participating Organization Committee", TRNFC: "Registered Out-of-State (Non-Federal) Committee",
  TSLATE: "Slate Committee", TSPDC: "Spouse", TUNFC: "Unregistered Out-of-State (Non-Federal) Committee",
} as const;
const reportedCommitteeClasses = new Set(["TCC", "TFED", "TPAC", "TPCC", "TPCLB", "TPOC", "TRNFC", "TSLATE", "TUNFC"]);
export class MarylandReportedCommitteeAggregationError extends Error {
  constructor(public readonly code: "invalid_scope" | "incomplete_collection" | "invalid_row" |
    "duplicate_identity" | "unresolved_parent" | "parent_identity" | "refund_exceeds_gift" |
    "unsafe_total" | "invalid_receiving_context" | "ambiguous_self" | "invalid_return_fact" |
    "missing_return_family") { super(`Maryland reported committee aggregation: ${code}`); }
}
type ReceivingContext = NonNullable<Awaited<ReturnType<typeof bindMarylandOutsideReceivingContext>>["binding"]>;
type LegacyReturnComparison = ReturnType<typeof compareMarylandLegacyCommitteeReturnOccurrences>;

/** Pure arithmetic over complete supplied periods. Reported class/name groups
 * are not legal donor identities. Actual source-bound return facts preserve
 * document cash flow separately from original gift kind. The normal packet
 * reader must recompute those facts from complete genuine inputs; structural
 * TypeScript types cannot authenticate provenance. Complete acquisition,
 * report/PDF occurrence controls, current canonical ownership and signed
 * storage/read semantics still qualify outside this function. No result here
 * grants financial acceptance, freshness or publication authority. */
export function aggregateMarylandReportedCommitteePositions(input: {
  receivingGuid: string; currentCycle: string; priorCycle: string;
  currentRows: readonly SourceRow[]; priorRows: readonly SourceRow[];
  declaredCurrentRows: number; declaredPriorRows: number;
  receivingContext: ReceivingContext;
  legacyReturnComparison?: LegacyReturnComparison;
  legacyReturnCashFamilies?: ReturnType<typeof proveMarylandLegacyReturnCashFamilies>;
}) {
  const hold = (code: MarylandReportedCommitteeAggregationError["code"]): never => {
    throw new MarylandReportedCommitteeAggregationError(code);
  };
  const sum = (a: number, b: number) => {
    const n = a + b; if (!Number.isSafeInteger(n)) hold("unsafe_total"); return n;
  };
  if (!guid(input.receivingGuid) || !/^[1-9]\d*$/.test(input.currentCycle) ||
    !/^[1-9]\d*$/.test(input.priorCycle) || input.currentCycle === input.priorCycle ||
    !Number.isSafeInteger(input.declaredCurrentRows) || input.declaredCurrentRows < 0 ||
    !Number.isSafeInteger(input.declaredPriorRows) || input.declaredPriorRows < 0) hold("invalid_scope");
  if (input.currentRows.length !== input.declaredCurrentRows || input.priorRows.length !== input.declaredPriorRows)
    hold("incomplete_collection");
  const receiver = input.receivingContext;
  if (!receiver || !guid(receiver.filerRegistrationGuid) ||
    receiver.filerRegistrationGuid.toLowerCase() !== input.receivingGuid.toLowerCase() ||
    receiver.sourceCycle?.value !== input.currentCycle || !Array.isArray(receiver.sourceCommitteeLabels) ||
    receiver.sourceCommitteeLabels.length !== 2 || receiver.sourceCommitteeLabels.some(s => typeof s !== "string" || !s.trim()) ||
    receiver.sourceCommitteeLabels[0] !== receiver.sourceCommitteeName ||
    receiver.sourceCommitteeName !== receiver.canonical?.committeeName ||
    !Array.isArray(receiver.sourceMetadata) || receiver.sourceMetadata.length < 5) hold("invalid_receiving_context");
  const receivingLabels = new Set(receiver.sourceCommitteeLabels.map(nameKey));
  const ids = new Set<number>(), identities = new Set<string>();
  type Row = ParsedRow & { source: SourceRow };
  function parse(row: SourceRow, cycle: string): Row {
    const amount = typeof row.transactionAmount === "number" && Number.isFinite(row.transactionAmount)
      ? parseMarylandCfsMoney(String(row.transactionAmount)) : null;
    const donorType = row.contributorTypeCode;
    if (!guid(row.filerRegistrationGuid) || row.filerRegistrationGuid.toLowerCase() !== input.receivingGuid.toLowerCase() ||
      !positiveId(row.electionCycleId) || String(row.electionCycleId) !== cycle ||
      !positiveId(row.transactionId) || !guid(row.transactionGuid) || row.isActive !== true ||
      typeof row.isReturn !== "boolean" || row.transactionTypeCode !== (row.isReturn ? "TRCON" : "TCON") ||
      typeof row.contributionTypeCode !== "string" || !mechanisms.has(row.contributionTypeCode) ||
      (donorType !== null && (typeof donorType !== "string" || !Object.hasOwn(reportedClassLabels, donorType) ||
        row.contributorType !== reportedClassLabels[donorType as keyof typeof reportedClassLabels])) ||
      (donorType === null && (row.contributionTypeCode !== "ANYMS" || row.contributorType !== null)) ||
      (row.contributionTypeCode !== "ANYMS" && (typeof row.contributorName !== "string" || !row.contributorName.trim())) ||
      amount === null || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) ||
      typeof row.transactionDate !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.transactionDate) ||
      !Number.isFinite(Date.parse(`${row.transactionDate}Z`)) ||
      new Date(`${row.transactionDate}Z`).toISOString().slice(0, 19) !== row.transactionDate ||
      (row.isReturn && (!positiveId(row.parentTransactionId) || (row.parentTransactionGuid !== null && !guid(row.parentTransactionGuid))))) hold("invalid_row");
    const id = row.transactionId as number, identity = (row.transactionGuid as string).toLowerCase();
    if (ids.has(id) || identities.has(identity)) hold("duplicate_identity");
    ids.add(id); identities.add(identity);
    return {id, guid: identity, date: row.transactionDate as string, amountCents: Math.round(amount! * 100),
      role: row.transactionTypeCode as Row["role"], mechanism: row.contributionTypeCode as string,
      donorType: donorType as string | null, donorName: typeof row.contributorName === "string" ? row.contributorName.trim().replace(/\s+/g, " ") : "",
      parentId: row.isReturn ? row.parentTransactionId as number : null,
      parentGuid: row.isReturn && typeof row.parentTransactionGuid === "string" ? row.parentTransactionGuid.toLowerCase() : null, source: row};
  }
  const current = input.currentRows.map(r => parse(r, input.currentCycle));
  const prior = input.priorRows.map(r => parse(r, input.priorCycle));
  const gifts = new Map([...current, ...prior].filter(r => r.role === "TCON").map(r => [r.id, r]));
  const currentRefunds = new Map(current.filter(r => r.role === "TRCON").map(r => [r.id, r]));
  const relevantParents = new Set([...currentRefunds.values()].map(r => r.parentId!));
  const refunded = new Map<number, number>(), nonCommitteeOverRefundParents = new Set<number>();
  for (const refund of [...prior, ...current]) {
    if (refund.role !== "TRCON" || !relevantParents.has(refund.parentId!)) continue;
    const parent = gifts.get(refund.parentId!); if (!parent) hold("unresolved_parent");
    if ((refund.parentGuid !== null && refund.parentGuid !== parent!.guid) || nameKey(refund.donorName) !== nameKey(parent!.donorName) || refund.date < parent!.date) hold("parent_identity");
    const total = sum(refunded.get(parent!.id) ?? 0, refund.amountCents); refunded.set(parent!.id, total);
    if (total > parent!.amountCents) {
      if (reportedCommitteeClasses.has(parent!.donorType!)) hold("refund_exceeds_gift");
      nonCommitteeOverRefundParents.add(parent!.id);
    }
  }
  const bound = new Set<number>(), physical = new Set<string>();
  if (input.legacyReturnComparison && input.legacyReturnCashFamilies) hold("invalid_return_fact");
  if (input.legacyReturnCashFamilies) {
    const {sourceFacts: f, reports} = input.legacyReturnCashFamilies;
    if (!f || !Array.isArray(reports) || f.documentFamily !== "cash_outflow" ||
      ![f.reportsCompared, f.nativeReturns, f.pdfReturns, f.returnCents].every(n => Number.isSafeInteger(n) && n >= 0) ||
      f.reportsCompared !== reports.length || f.nativeReturns !== f.pdfReturns ||
      reports.some(r => !r || r.documentFamily !== "cash_outflow" || !/^[a-f0-9]{64}$/.test(r.pdfSha256) ||
        !positiveId(r.pdfByteCount) || !positiveId(r.pdfPageCount) ||
        !Number.isSafeInteger(r.returnCount) || r.returnCount < 0 || !Number.isSafeInteger(r.returnCents) || r.returnCents < 0)) hold("invalid_return_fact");
    // Rebind the complete supplied report scopes, including every class and
    // gift kind. A report-wide family proves no per-row PDF identity/contact.
    // The ordinary packet must regenerate these plain facts from its originals.
    let binding: ReturnType<typeof bindMarylandNativeReportOccurrences>;
    try {
      const request = buildMarylandPublicReportInventoryRequest({filerRegistrationGuid: input.receivingGuid,
        electionCycleId: input.currentCycle, pageNumber: 1});
      const published = bindMarylandNativeReportOccurrences({request, reports: reports.map(r => r.report), nativeRows: []});
      const reportGuids = new Set(published.reports.flatMap(({report}) => [report.reportGuid.toLowerCase(),
        ...(report.childResults ?? []).map(c => c.filerReportGuid.toLowerCase())]));
      binding = bindMarylandNativeReportOccurrences({request, reports: published.reports.map(r => r.report),
        nativeRows: current.filter(r => typeof r.source.reportGuid === "string" && reportGuids.has(r.source.reportGuid.toLowerCase())).map(r => r.source)});
    } catch { return hold("invalid_return_fact"); }
    let count = 0, cents = 0;
    binding.reports.forEach((bucket, index) => {
      const fact = reports[index]!;
      const returns = bucket.rows.filter(r => r.isReturn);
      const total = returns.reduce((n, row) => sum(n, currentRefunds.get(row.transactionId as number)!.amountCents), 0);
      if (returns.length !== fact.returnCount || total !== fact.returnCents) hold("invalid_return_fact");
      count = sum(count, returns.length); cents = sum(cents, total);
      for (const row of returns) {
        if (!cashGift(currentRefunds.get(row.transactionId as number)!)) hold("invalid_return_fact");
        bound.add(row.transactionId as number);
      }
    });
    if (count !== f.nativeReturns || cents !== f.returnCents) hold("invalid_return_fact");
  }
  if (input.legacyReturnComparison) {
    const {sourceFacts: f, privateBoundReturns: facts} = input.legacyReturnComparison;
    if (!f || !Array.isArray(facts) || f.nativeReturns !== f.pdfReturns || f.eligibleReturns !== facts.length ||
      ![f.reportsCompared, f.nativeReturns, f.pdfReturns, f.returnCents, f.eligibleReturns, f.eligibleReturnCents].every(n => Number.isSafeInteger(n) && n >= 0) ||
      f.eligibleReturns > f.nativeReturns || f.eligibleReturnCents > f.returnCents ||
      facts.some(fact => !fact || !positiveId(fact.transactionId) || !positiveId(fact.refundCents)) ||
      (facts.length > 0 && f.reportsCompared < 1) || f.eligibleReturnCents !== facts.reduce((n, fact) => sum(n, fact.refundCents), 0)) hold("invalid_return_fact");
    for (const fact of facts) {
      const refund = currentRefunds.get(fact.transactionId), parent = refund ? gifts.get(refund.parentId!) : undefined;
      const key = `${typeof fact.reportGuid === "string" ? fact.reportGuid.toLowerCase() : ""}:${fact.reportVersionId}:${fact.pageNumber}:${fact.ordinal}`;
      if (!refund || !parent || bound.has(fact.transactionId) || physical.has(key) ||
        !reportedCommitteeClasses.has(parent.donorType!) || !cashGift(refund) ||
        !guid(fact.transactionGuid) || !guid(fact.reportGuid) || !positiveId(fact.reportVersionId) || !guid(fact.originalTransactionGuid) ||
        !guid(fact.nativeReportGuid) || !positiveId(fact.nativeReportVersionId) || !guid(refund.source.reportGuid) ||
        fact.transactionGuid.toLowerCase() !== refund.guid || fact.nativeReportGuid.toLowerCase() !== refund.source.reportGuid.toLowerCase() || fact.nativeReportVersionId !== refund.source.reportVersionId ||
        fact.originalTransactionId !== parent.id || fact.originalTransactionGuid.toLowerCase() !== parent.guid ||
        fact.originalClass !== parent.donorType || fact.originalKind !== parent.mechanism || fact.documentFamily !== "cash_outflow" ||
        fact.refundCents !== refund.amountCents || !positiveId(fact.pageNumber) || !Number.isSafeInteger(fact.ordinal) || fact.ordinal < 0) hold("invalid_return_fact");
      bound.add(fact.transactionId); physical.add(key);
    }
  }
  type Position = { donorName: string; reportedClassCode: string; reportedClassLabel: string;
    recognitionMethod: "explicit_reported_class"; identityScope: "reported_class_and_name";
    grossCents: number; refundCents: number; giftCount: number; refundCount: number;
    originalGiftKinds: string[]; documentBoundCashOutflowRefundCount: number };
  const positions = new Map<string, Position>();
  function position(parent: Row) {
    if (receivingLabels.has(nameKey(parent.donorName))) hold("ambiguous_self");
    const key = JSON.stringify([parent.donorType, nameKey(parent.donorName)]);
    let p = positions.get(key);
    if (!p) {p = {donorName: parent.donorName, reportedClassCode: parent.donorType!,
      reportedClassLabel: reportedClassLabels[parent.donorType as keyof typeof reportedClassLabels],
      recognitionMethod: "explicit_reported_class", identityScope: "reported_class_and_name",
      grossCents: 0, refundCents: 0, giftCount: 0, refundCount: 0,
      originalGiftKinds: [], documentBoundCashOutflowRefundCount: 0}; positions.set(key, p);}
    if (!p.originalGiftKinds.includes(parent.mechanism)) p.originalGiftKinds.push(parent.mechanism);
    return p;
  }
  for (const gift of current) {
    if (gift.role !== "TCON" || !reportedCommitteeClasses.has(gift.donorType!) || !cashGift(gift)) continue;
    const p = position(gift); p.grossCents = sum(p.grossCents, gift.amountCents); p.giftCount++;
  }
  for (const refund of currentRefunds.values()) {
    const parent = gifts.get(refund.parentId!)!;
    if (!reportedCommitteeClasses.has(parent.donorType!)) continue;
    // A conflicting native noncash-return mechanism needs its own source
    // semantics. A report family alone does not reinterpret that field.
    if (bound.has(refund.id) && !cashGift(refund)) hold("invalid_return_fact");
    if (!cashGift(refund)) continue;
    if (!cashGift(parent) && !bound.has(refund.id)) hold("missing_return_family");
    const p = position(parent); p.refundCents = sum(p.refundCents, refund.amountCents); p.refundCount++;
    if (bound.has(refund.id)) p.documentBoundCashOutflowRefundCount++;
  }
  const result = [...positions.values()].map(p => ({...p, originalGiftKinds: [...p.originalGiftKinds].sort(), netCents: sum(p.grossCents, -p.refundCents)}));
  result.sort((a, b) => b.netCents - a.netCents || a.reportedClassCode.localeCompare(b.reportedClassCode) || a.donorName.localeCompare(b.donorName));
  return {positions: result, sourceRows: current.length, priorSourceRows: prior.length,
    currentCycle: input.currentCycle, priorCycle: input.priorCycle,
    resolvedRefunds: currentRefunds.size, nonCommitteeOverRefundParentCount: nonCommitteeOverRefundParents.size,
    giftCount: result.reduce((n, p) => n + p.giftCount, 0), refundCount: result.reduce((n, p) => n + p.refundCount, 0),
    grossCents: result.reduce((n, p) => sum(n, p.grossCents), 0), refundCents: result.reduce((n, p) => sum(n, p.refundCents), 0),
    netCents: result.reduce((n, p) => sum(n, p.netCents), 0)};
}
