import type { Pool, PoolClient } from "pg";
import type { MissouriCommitteeMonetaryReceiptAggregation } from "./missouriCommitteeMonetaryReceiptAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export type MissouriCommitteeMonetaryReceiptComponent = {
  receivingCommitteeId: string;
  cycleStart: string;
  cycleEnd: string;
  aggregation: MissouriCommitteeMonetaryReceiptAggregation;
  sourceRetrievedAt: Date;
  sourceUrl: string;
  sourceSha256: string;
  sourceByteSize: number;
  reportInventorySha256: string;
};
export type PreparedMissouriCommitteeMonetaryReceiptComponent = Omit<MissouriCommitteeMonetaryReceiptComponent, "aggregation"> & {
  aggregation: Extract<MissouriCommitteeMonetaryReceiptAggregation, { status: "qualified" }>;
};
type WriteCode = "invalid_component" | "receiving_link_changed" | "older_source" | "write_failed";
export class MissouriCommitteeMonetaryReceiptWriteError extends Error {
  constructor(readonly code: WriteCode) {
    super(`Missouri committee monetary receipts ${code}`);
    this.name = "MissouriCommitteeMonetaryReceiptWriteError";
  }
}
const fail = (): never => { throw new MissouriCommitteeMonetaryReceiptWriteError("invalid_component"); };
const clean = (s: string) => s.normalize("NFC").trim().replace(/\s+/gu, " ");
const name = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(s);
const count = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 2_147_483_647;
const cents = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
function isoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}
function add(a: number, b: number): number { const n = a + b; return Number.isSafeInteger(n) ? n : fail(); }
function officialSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "www.mec.mo.gov" &&
    !u.username && !u.password && !u.hash && u.pathname.toLowerCase() === "/mec/campaign_finance/cf12_contrexpend.aspx" && !u.search; }
  catch { return false; }
}

/** Copy and validate before connecting. Acquisition qualification remains the
 * ordinary loader's responsibility; this does not authorize publication. Held
 * or omitted components never become empty rows or new observation times. */
export function prepareMissouriCommitteeMonetaryReceiptComponent(input: {
  component?: MissouriCommitteeMonetaryReceiptComponent;
  receivingCommitteeId: string;
  electionYear: number;
  syncedAt: Date;
}): PreparedMissouriCommitteeMonetaryReceiptComponent | undefined {
  if (input.component === undefined || input.component?.aggregation?.status === "held") return undefined;
  let s: MissouriCommitteeMonetaryReceiptComponent;
  try { s = structuredClone(input.component); } catch { return fail(); }
  if (!s || s.aggregation?.status !== "qualified" || typeof s.receivingCommitteeId !== "string" ||
    !/^[A-Z]\d{6}$/.test(s.receivingCommitteeId.trim().toUpperCase()) ||
    s.receivingCommitteeId.trim().toUpperCase() !== input.receivingCommitteeId.trim().toUpperCase() ||
    !Number.isInteger(input.electionYear) || input.electionYear < 2024 || input.electionYear > 2100 ||
    !isoDate(s.cycleStart) || !isoDate(s.cycleEnd) || s.cycleStart > s.cycleEnd || Number(s.cycleEnd.slice(0, 4)) !== input.electionYear ||
    !(s.sourceRetrievedAt instanceof Date) || !Number.isFinite(s.sourceRetrievedAt.getTime()) ||
    !(input.syncedAt instanceof Date) || !Number.isFinite(input.syncedAt.getTime()) || s.sourceRetrievedAt > input.syncedAt ||
    !officialSource(s.sourceUrl) || !hash(s.sourceSha256) || !hash(s.reportInventorySha256) || !cents(s.sourceByteSize) || s.sourceByteSize === 0) return fail();
  const a = s.aggregation;
  if (!Array.isArray(a.committees) || !cents(a.totalAmountCents) ||
    ![a.sourceRowCount, a.inCycleRowCount, a.outsideCycleRowCount, a.canonicalRowCount, a.matchedCommitteeRowCount,
      a.excludedNonCommitteeRowCount, a.inKindRowCount, a.zeroMonetaryRowCount, a.includedReceiptRowCount,
      a.relevantUnresolvedLineageCount, a.excludedLineageRowCount].every(count) ||
    a.sourceRowCount !== a.inCycleRowCount + a.outsideCycleRowCount || a.canonicalRowCount > a.inCycleRowCount ||
    a.canonicalRowCount !== a.matchedCommitteeRowCount + a.excludedNonCommitteeRowCount ||
    a.matchedCommitteeRowCount !== a.inKindRowCount + a.zeroMonetaryRowCount + a.includedReceiptRowCount ||
    a.relevantUnresolvedLineageCount !== 0 || a.excludedLineageRowCount !== 0 || a.excludedLineageAmountCents !== 0 ||
    !Array.isArray(a.lineageDiagnosticCodes) || a.lineageDiagnosticCodes.length !== 0) return fail();
  const seen = new Set<string>(); let amount = 0, receipts = 0;
  for (const group of a.committees) {
    if (!name(group.reportedCommitteeName) || clean(group.reportedCommitteeName) !== group.reportedCommitteeName ||
      !name(group.reportedNameKey) || group.reportedNameKey !== group.reportedCommitteeName.toUpperCase() ||
      seen.has(group.reportedNameKey) || !cents(group.amountCents) || group.amountCents === 0 || !count(group.receiptCount) || group.receiptCount === 0) return fail();
    seen.add(group.reportedNameKey); amount = add(amount, group.amountCents); receipts = add(receipts, group.receiptCount);
  }
  if (amount !== a.totalAmountCents || receipts !== a.includedReceiptRowCount || !count(a.committees.length) ||
    a.committees.length > receipts || (a.committees.length === 0) !== (a.totalAmountCents === 0)) return fail();
  return { ...s, receivingCommitteeId: s.receivingCommitteeId.trim().toUpperCase(), aggregation: a };
}

/** Called only from the protected snapshot's afterSnapshotWrite transaction. */
export async function replaceMissouriCommitteeMonetaryReceiptRows(input: {
  db: Queryable; linkId: string; electionYear: number; syncedAt: Date;
  component: PreparedMissouriCommitteeMonetaryReceiptComponent;
}): Promise<void> {
  if (!uuid(input.linkId)) return fail();
  const s = prepareMissouriCommitteeMonetaryReceiptComponent({ component: input.component,
    receivingCommitteeId: input.component.receivingCommitteeId, electionYear: input.electionYear, syncedAt: input.syncedAt });
  if (!s) return fail();
  const a = s.aggregation;
  try {
    const link = await input.db.query(`SELECT id FROM public.mo_candidate_finance_links
      WHERE id=$1::uuid AND election_year=$2 AND committee_id=$3 AND link_status='active' FOR UPDATE`,
    [input.linkId, input.electionYear, s.receivingCommitteeId]);
    if (link.rows.length !== 1) throw new MissouriCommitteeMonetaryReceiptWriteError("receiving_link_changed");
    const prior = await input.db.query<{ source_retrieved_at: Date | string }>(`SELECT source_retrieved_at
      FROM public.mo_candidate_finance_committee_receipt_sources WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`, [input.linkId, input.electionYear]);
    if (prior.rows.some(row => new Date(row.source_retrieved_at).getTime() > s.sourceRetrievedAt.getTime())) {
      throw new MissouriCommitteeMonetaryReceiptWriteError("older_source");
    }
    await input.db.query(`INSERT INTO public.mo_candidate_finance_committee_receipt_sources
      (link_id,election_year,receiving_committee_id,cycle_start,cycle_end,total_amount_cents,group_count,receipt_count,
       source_row_count,in_cycle_row_count,outside_cycle_row_count,canonical_row_count,matched_committee_row_count,
       excluded_noncommittee_row_count,in_kind_row_count,zero_monetary_row_count,source_url,source_retrieved_at,
       source_sha256,source_byte_size,report_inventory_sha256,last_synced_at)
      VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6::bigint,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::timestamptz,$19,$20::bigint,$21,$22::timestamptz)
      ON CONFLICT(link_id,election_year) DO UPDATE SET receiving_committee_id=EXCLUDED.receiving_committee_id,
       cycle_start=EXCLUDED.cycle_start,cycle_end=EXCLUDED.cycle_end,total_amount_cents=EXCLUDED.total_amount_cents,
       group_count=EXCLUDED.group_count,receipt_count=EXCLUDED.receipt_count,source_row_count=EXCLUDED.source_row_count,
       in_cycle_row_count=EXCLUDED.in_cycle_row_count,outside_cycle_row_count=EXCLUDED.outside_cycle_row_count,
       canonical_row_count=EXCLUDED.canonical_row_count,matched_committee_row_count=EXCLUDED.matched_committee_row_count,
       excluded_noncommittee_row_count=EXCLUDED.excluded_noncommittee_row_count,in_kind_row_count=EXCLUDED.in_kind_row_count,
       zero_monetary_row_count=EXCLUDED.zero_monetary_row_count,source_url=EXCLUDED.source_url,
       source_retrieved_at=EXCLUDED.source_retrieved_at,source_sha256=EXCLUDED.source_sha256,
       source_byte_size=EXCLUDED.source_byte_size,report_inventory_sha256=EXCLUDED.report_inventory_sha256,last_synced_at=EXCLUDED.last_synced_at`,
    [input.linkId,input.electionYear,s.receivingCommitteeId,s.cycleStart,s.cycleEnd,String(a.totalAmountCents),a.committees.length,a.includedReceiptRowCount,
      a.sourceRowCount,a.inCycleRowCount,a.outsideCycleRowCount,a.canonicalRowCount,a.matchedCommitteeRowCount,a.excludedNonCommitteeRowCount,
      a.inKindRowCount,a.zeroMonetaryRowCount,s.sourceUrl,s.sourceRetrievedAt.toISOString(),s.sourceSha256,String(s.sourceByteSize),s.reportInventorySha256,input.syncedAt.toISOString()]);
    await input.db.query(`DELETE FROM public.mo_candidate_finance_committee_receipts WHERE link_id=$1::uuid AND election_year=$2`, [input.linkId,input.electionYear]);
    for (const group of a.committees) await input.db.query(`INSERT INTO public.mo_candidate_finance_committee_receipts
      (link_id,election_year,reported_committee_name,reported_name_key,amount_cents,receipt_count)
      VALUES($1::uuid,$2,$3,$4,$5::bigint,$6)`,
    [input.linkId,input.electionYear,group.reportedCommitteeName,group.reportedNameKey,String(group.amountCents),group.receiptCount]);
  } catch (error) {
    if (error instanceof MissouriCommitteeMonetaryReceiptWriteError) throw error;
    throw new MissouriCommitteeMonetaryReceiptWriteError("write_failed");
  }
}
