import type { Pool, PoolClient } from "pg";
import type { aggregateMarylandReportedCommitteePositions } from "./marylandNativePacAggregator.js";

type Aggregation = ReturnType<typeof aggregateMarylandReportedCommitteePositions>;
type QueryablePool = Pick<Pool, "connect">;
export type MarylandCommitteeMonetarySnapshot = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  receivingCommitteeId: string;
  aggregation: Aggregation;
  sourceUrl: string;
  sourceObservedAt: Date;
  inventoryObservedAt: Date;
  provenance: {
    reportCount: number;
    captureCount: number;
    originalSha256s: readonly string[];
  };
};

const fail = (): never => { throw new Error("invalid_maryland_committee_monetary_snapshot"); };
const key = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();
const classes = new Set(["TCC", "TFED", "TPAC", "TPCC", "TPCLB", "TPOC", "TRNFC", "TUNFC", "TSLATE"]);
const kinds = new Set(["CMONT", "TRFR", "CINKIND", "OTHRINCM", "ANYMS"]);
const uuid = (s: unknown): s is string => typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s);
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
const sum = (a: number, b: number) => {
  const n = a + b;
  if (!Number.isSafeInteger(n)) return fail();
  return n;
};
// Decimal strings avoid introducing float rounding on the way into NUMERIC.
function money(cents: number): string {
  const n = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}
function validate(s: MarylandCommitteeMonetarySnapshot, syncedAt: Date) {
  const a = s.aggregation;
  if (![s.linkId, s.candidateId, s.electionId].every(uuid) ||
    !Number.isInteger(s.electionYear) || s.electionYear < 2000 || s.electionYear > 2100 ||
    typeof s.receivingCommitteeId !== "string" || !s.receivingCommitteeId.trim() ||
    !(s.sourceObservedAt instanceof Date) || !(s.inventoryObservedAt instanceof Date) ||
    ![s.sourceObservedAt.getTime(), s.inventoryObservedAt.getTime(), syncedAt.getTime()].every(Number.isFinite) ||
    s.sourceObservedAt > s.inventoryObservedAt || s.inventoryObservedAt > syncedAt ||
    s.sourceUrl !== "https://campaignfinance.maryland.gov" ||
    !a || !Array.isArray(a.positions) || !/^[1-9]\d*$/.test(a.currentCycle) || !/^[1-9]\d*$/.test(a.priorCycle) ||
    a.currentCycle === a.priorCycle || ![a.sourceRows, a.priorSourceRows, a.resolvedRefunds,
      a.nonCommitteeOverRefundParentCount, a.giftCount, a.refundCount, a.grossCents, a.refundCents].every(count) ||
    !Number.isSafeInteger(a.netCents) || a.netCents !== a.grossCents - a.refundCents ||
    !s.provenance || !count(s.provenance.reportCount) || s.provenance.reportCount < 1 ||
    !count(s.provenance.captureCount) || s.provenance.captureCount < 1 ||
    !Array.isArray(s.provenance.originalSha256s) || !s.provenance.originalSha256s.length ||
    s.provenance.originalSha256s.some(h => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h))) fail();
  const seen = new Set<string>();
  let gross = 0, refunds = 0, gifts = 0, returns = 0;
  for (const p of a.positions) {
    if (typeof p.donorName !== "string" || !p.donorName.trim() || !classes.has(p.reportedClassCode) ||
      p.recognitionMethod !== "explicit_reported_class" || p.identityScope !== "reported_class_and_name" ||
      ![p.grossCents, p.refundCents, p.giftCount, p.refundCount, p.documentBoundCashOutflowRefundCount].every(count) ||
      !Number.isSafeInteger(p.netCents) || p.netCents !== p.grossCents - p.refundCents ||
      p.giftCount + p.refundCount === 0 || (p.giftCount > 0) !== (p.grossCents > 0) ||
      (p.refundCount > 0) !== (p.refundCents > 0) || p.documentBoundCashOutflowRefundCount > p.refundCount ||
      !Array.isArray(p.originalGiftKinds) || !p.originalGiftKinds.length ||
      p.originalGiftKinds.some(k => !kinds.has(k)) || new Set(p.originalGiftKinds).size !== p.originalGiftKinds.length) fail();
    const identity = JSON.stringify([p.reportedClassCode, key(p.donorName)]);
    if (seen.has(identity)) fail();
    seen.add(identity);
    gross = sum(gross, p.grossCents); refunds = sum(refunds, p.refundCents);
    gifts = sum(gifts, p.giftCount); returns = sum(returns, p.refundCount);
  }
  if (gross !== a.grossCents || refunds !== a.refundCents || gifts !== a.giftCount || returns !== a.refundCount) fail();
}

/** Component-only writer. The normal source loader must qualify the complete
 * native/PDF packet and current receiving context before calling it. These
 * ordinary input types grant no acquisition or publication authority. */
export async function replaceMarylandCommitteeMonetarySnapshot(input: {
  db: QueryablePool;
  snapshot: MarylandCommitteeMonetarySnapshot;
  syncedAt?: Date;
}): Promise<{ positionsWritten: number }> {
  // Retain one private value before yielding: caller mutation during connect
  // or a query must not split donor rows from their validated totals/source.
  const syncedAt = new Date(input.syncedAt?.getTime() ?? Date.now());
  let s: MarylandCommitteeMonetarySnapshot;
  try { s = structuredClone(input.snapshot); } catch { return fail(); }
  validate(s, syncedAt);
  const client: PoolClient = await input.db.connect();
  try {
    await client.query("BEGIN");
    // Serialize replacements on the existing receiving link, including the
    // first component write when there is no sources row yet.
    const link = await client.query(`SELECT id FROM public.md_candidate_finance_links
      WHERE id = $1::uuid AND candidate_id = $2::uuid AND election_id = $3::uuid
        AND election_year = $4 AND committee_id = $5 AND link_status = 'active'
      FOR UPDATE`, [s.linkId, s.candidateId, s.electionId, s.electionYear, s.receivingCommitteeId]);
    if (link.rows.length !== 1) throw new Error("maryland_committee_receiving_link_changed");
    const newer = await client.query(`SELECT link_id FROM public.md_candidate_finance_pac_sources
      WHERE link_id = $1::uuid AND election_year = $2
        AND (source_observed_at > $3::timestamptz OR inventory_observed_at > $4::timestamptz
          OR last_synced_at > $5::timestamptz)`,
    [s.linkId, s.electionYear, s.sourceObservedAt.toISOString(), s.inventoryObservedAt.toISOString(), syncedAt.toISOString()]);
    if (newer.rows.length) throw new Error("maryland_committee_older_source");
    for (const p of s.aggregation.positions) {
      await client.query(`INSERT INTO public.md_candidate_finance_pac_donors
        (link_id, election_year, donor_name, donor_name_normalized, reported_class_code,
         amount, gross_amount, refund_amount, gift_count, refund_count, original_gift_kinds,
         document_bound_cash_outflow_refund_count, source_url, source_observed_at, last_synced_at)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14::timestamptz,$15::timestamptz)
        ON CONFLICT (link_id, election_year, reported_class_code, donor_name_normalized)
        DO UPDATE SET donor_name = EXCLUDED.donor_name, amount = EXCLUDED.amount,
          gross_amount = EXCLUDED.gross_amount, refund_amount = EXCLUDED.refund_amount,
          gift_count = EXCLUDED.gift_count, refund_count = EXCLUDED.refund_count,
          original_gift_kinds = EXCLUDED.original_gift_kinds,
          document_bound_cash_outflow_refund_count = EXCLUDED.document_bound_cash_outflow_refund_count,
          source_url = EXCLUDED.source_url, source_observed_at = EXCLUDED.source_observed_at,
          last_synced_at = EXCLUDED.last_synced_at`,
      [s.linkId, s.electionYear, p.donorName.trim().replace(/\s+/g, " "), key(p.donorName), p.reportedClassCode,
        money(p.netCents), money(p.grossCents), money(p.refundCents), p.giftCount, p.refundCount,
        p.originalGiftKinds, p.documentBoundCashOutflowRefundCount, s.sourceUrl, s.sourceObservedAt.toISOString(), syncedAt.toISOString()]);
    }
    await client.query(`DELETE FROM public.md_candidate_finance_pac_donors
      WHERE link_id = $1::uuid AND election_year = $2
        AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) AS keep(class, name)
          WHERE keep.class = reported_class_code AND keep.name = donor_name_normalized)`,
    [s.linkId, s.electionYear, s.aggregation.positions.map(p => p.reportedClassCode), s.aggregation.positions.map(p => key(p.donorName))]);
    const provenance = {scope: "reported_committee_monetary_positions", version: 1,
      currentCycle: s.aggregation.currentCycle, priorCycle: s.aggregation.priorCycle,
      currentRows: s.aggregation.sourceRows, priorRows: s.aggregation.priorSourceRows,
      reportCount: s.provenance.reportCount, captureCount: s.provenance.captureCount,
      originalSha256s: s.provenance.originalSha256s};
    await client.query(`INSERT INTO public.md_candidate_finance_pac_sources
      (link_id, election_year, net_amount, gross_amount, refund_amount, position_count,
       source_observed_at, inventory_observed_at, provenance, last_synced_at)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::jsonb,$10::timestamptz)
      ON CONFLICT (link_id, election_year) DO UPDATE SET net_amount = EXCLUDED.net_amount,
        gross_amount = EXCLUDED.gross_amount, refund_amount = EXCLUDED.refund_amount,
        position_count = EXCLUDED.position_count, source_observed_at = EXCLUDED.source_observed_at,
        inventory_observed_at = EXCLUDED.inventory_observed_at, provenance = EXCLUDED.provenance,
        last_synced_at = EXCLUDED.last_synced_at`,
    [s.linkId, s.electionYear, money(s.aggregation.netCents), money(s.aggregation.grossCents),
      money(s.aggregation.refundCents), s.aggregation.positions.length, s.sourceObservedAt.toISOString(),
      s.inventoryObservedAt.toISOString(), JSON.stringify(provenance), syncedAt.toISOString()]);
    await client.query("COMMIT");
    return {positionsWritten: s.aggregation.positions.length};
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
