import { parseMarylandCfsMoney } from "./marylandCfsArtifactReader.js";

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
