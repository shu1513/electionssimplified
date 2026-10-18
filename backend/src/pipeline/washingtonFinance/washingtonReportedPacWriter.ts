import type { Pool } from "pg";
import { isVerifiedWashingtonPacSource, validateWashingtonPacSourceFacts, type WashingtonPacSourcePacket } from "./washingtonReportedPacCache.js";
import { loadWashingtonPacReceiver, qualifyWashingtonPacReceiver, type WashingtonPacReceiver } from "./washingtonReportedPacReceiver.js";
import { aggregateWashingtonPacRows, waPacHold, waPacObject, waPacText, type WashingtonPacAggregation, type WashingtonPacScope,
  WASHINGTON_REPORTED_PAC_SOURCE_URL } from "./washingtonReportedPacSource.js";

type Row = Record<string, unknown>;
export const waPacCanonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const same = (a: unknown, b: unknown) => waPacCanonical(a) === waPacCanonical(b);
export function waPacInteger(v: unknown, min = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) waPacHold("invalid_stored_integer"); return n;
}
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : waPacHold("invalid_stored_clock");
const sum = (n: number[]) => { const v = n.reduce((a, b) => a + BigInt(b), 0n); return waPacInteger(Number(v), Number.MIN_SAFE_INTEGER); };
export function validateWashingtonPacAggregation(a: WashingtonPacAggregation): void {
  for (const n of [a.totalCents, a.positiveCents, a.positiveRows, a.negativeRows, a.zeroRows, a.sourceRowCount,
    a.canceledGroupCount, a.canceledRowCount]) waPacInteger(n);
  waPacInteger(a.negativeCents, Number.MIN_SAFE_INTEGER);
  if (a.negativeCents > 0 || a.sourceRowCount > 10000 || sum([a.positiveRows, a.negativeRows, a.zeroRows]) !== a.sourceRowCount ||
    sum([a.positiveCents, a.negativeCents]) !== a.totalCents || (a.positiveRows === 0) !== (a.positiveCents === 0) ||
    (a.negativeRows === 0) !== (a.negativeCents === 0) || !Array.isArray(a.groups) ||
    a.canceledGroupCount > a.canceledRowCount || (a.canceledGroupCount === 0) !== (a.canceledRowCount === 0)) waPacHold("invalid_aggregation_controls");
  const keys = new Set<string>();
  for (const g of a.groups) {
    if (!g || waPacText(g.name) !== g.name || g.key !== g.name.toUpperCase() || keys.has(g.key)) waPacHold("invalid_reported_group");
    keys.add(g.key); waPacInteger(g.cents, 1); waPacInteger(g.rowCount, 1);
  }
  if (sum(a.groups.map(g => g.cents)) !== a.totalCents || sum([a.canceledRowCount, ...a.groups.map(g => g.rowCount)]) !== a.sourceRowCount ||
    (a.groups.length === 0) !== (a.totalCents === 0)) waPacHold("stored_group_closure_mismatch");
}
export function washingtonPacFacts(p: WashingtonPacSourcePacket) {
  return { scope: p.scope, summary: p.summary, sourceUrl: WASHINGTON_REPORTED_PAC_SOURCE_URL, sourceControls: p.sourceControls };
}
/** Validate every stored group before the API applies any display cap. */
export function readStoredWashingtonPacComponent(source: Row, groups: Row[], receiver: WashingtonPacReceiver) {
  if (source.candidate_id !== receiver.candidate_id || source.election_id !== receiver.election_id || source.link_id !== receiver.link_id ||
    waPacInteger(source.election_year) !== receiver.election_year || source.receiving_filer_id !== receiver.filer_id ||
    source.receiving_committee_id !== receiver.committee_id) waPacHold("stored_receiver_mismatch");
  const facts = waPacObject(source.source_facts), scope = waPacObject(facts.scope) as unknown as WashingtonPacScope;
  if (facts.sourceUrl !== WASHINGTON_REPORTED_PAC_SOURCE_URL) waPacHold("stored_source_mismatch");
  qualifyWashingtonPacReceiver(receiver, scope, waPacObject(facts.summary));
  const sourceRetrievedAt = iso(source.source_retrieved_at), sourceCompletedAt = iso(source.source_completed_at);
  const controls = facts.sourceControls as WashingtonPacSourcePacket["sourceControls"];
  validateWashingtonPacSourceFacts({ sourceRetrievedAt, sourceCompletedAt, sourceManifestSha256: String(source.source_manifest_sha256),
    sourceByteSize: waPacInteger(source.source_byte_size), sourceControls: controls });
  if (Date.parse(sourceCompletedAt) > Date.parse(iso(source.last_synced_at)) || Date.parse(iso(source.last_synced_at)) > Date.now()) waPacHold("invalid_stored_clock");
  const aggregation = { ...waPacObject(source.aggregation_controls), groups: groups.map(g => {
    if (g.link_id !== receiver.link_id || waPacInteger(g.election_year) !== receiver.election_year) waPacHold("stored_group_receiver_mismatch");
    return { key: String(g.reported_name_key), name: String(g.reported_name), cents: waPacInteger(g.amount_cents), rowCount: waPacInteger(g.source_row_count) };
  }).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) } as WashingtonPacAggregation;
  validateWashingtonPacAggregation(aggregation);
  if (waPacInteger(source.total_cents) !== aggregation.totalCents || waPacInteger(source.group_count) !== groups.length ||
    waPacInteger(source.source_row_count) !== aggregation.sourceRowCount) waPacHold("stored_source_total_mismatch");
  return { aggregation, sourceRetrievedAt, sourceCompletedAt, facts };
}

/** Only a complete original-byte replay can reach the financial transaction.
 * No caller-supplied money, classifier result, or write clock is accepted. */
export async function writeWashingtonReportedPacReceipts(input: { db: Pick<Pool, "connect">; receiver: WashingtonPacReceiver; source: WashingtonPacSourcePacket }) {
  const { receiver: expected, source: p } = input;
  if (!isVerifiedWashingtonPacSource(p)) waPacHold("unverified_source_packet");
  validateWashingtonPacSourceFacts(p); qualifyWashingtonPacReceiver(expected, p.scope, p.summary);
  const a = aggregateWashingtonPacRows(p.rows); validateWashingtonPacAggregation(a);
  const { groups, ...controls } = a, facts = washingtonPacFacts(p), client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const receiver = await loadWashingtonPacReceiver(client, expected.link_id, true);
    if (!receiver || !same(receiver, expected)) waPacHold("receiving_context_changed");
    qualifyWashingtonPacReceiver(receiver, p.scope, p.summary);
    const params = [receiver.link_id, receiver.election_year], where = "link_id=$1::uuid AND election_year=$2::int";
    const old = await client.query<Row>(`SELECT * FROM public.wa_reported_pac_sources WHERE ${where} FOR UPDATE`, params);
    const prior = old.rows[0], at = new Date().toISOString();
    if (prior) {
      const previous = Date.parse(iso(prior.source_retrieved_at)), next = Date.parse(p.sourceRetrievedAt);
      if (next < previous) waPacHold("stale_source");
      if (next === previous) {
        const saved = await client.query<Row>(`SELECT * FROM public.wa_reported_pac_groups WHERE ${where} FOR UPDATE`, params);
        const component = readStoredWashingtonPacComponent(prior, saved.rows, receiver);
        if (prior.source_manifest_sha256 !== p.sourceManifestSha256 || waPacInteger(prior.source_byte_size) !== p.sourceByteSize ||
          component.sourceCompletedAt !== p.sourceCompletedAt || !same(component.facts, facts) || !same(component.aggregation, a)) waPacHold("equal_source_conflict");
        await client.query(`UPDATE public.wa_reported_pac_sources SET last_synced_at=GREATEST(last_synced_at,$3::timestamptz) WHERE ${where}`, [...params, at]);
        await client.query("COMMIT"); return { groupCount: groups.length, totalCents: a.totalCents, idempotent: true };
      }
    }
    await client.query(`INSERT INTO public.wa_reported_pac_sources
      (link_id,election_year,candidate_id,election_id,receiving_filer_id,receiving_committee_id,total_cents,group_count,source_row_count,
       source_retrieved_at,source_completed_at,source_manifest_sha256,source_byte_size,source_facts,aggregation_controls,last_synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)
      ON CONFLICT (link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
       receiving_filer_id=EXCLUDED.receiving_filer_id,receiving_committee_id=EXCLUDED.receiving_committee_id,total_cents=EXCLUDED.total_cents,
       group_count=EXCLUDED.group_count,source_row_count=EXCLUDED.source_row_count,source_retrieved_at=EXCLUDED.source_retrieved_at,
       source_completed_at=EXCLUDED.source_completed_at,source_manifest_sha256=EXCLUDED.source_manifest_sha256,
       source_byte_size=EXCLUDED.source_byte_size,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,
       last_synced_at=EXCLUDED.last_synced_at`, [...params, receiver.candidate_id, receiver.election_id, receiver.filer_id, receiver.committee_id,
      a.totalCents, groups.length, a.sourceRowCount, p.sourceRetrievedAt, p.sourceCompletedAt, p.sourceManifestSha256, p.sourceByteSize,
      JSON.stringify(facts), JSON.stringify(controls), at]);
    await client.query(`DELETE FROM public.wa_reported_pac_groups WHERE ${where}`, params);
    // One uncapped set, one pinned transaction, no partial group replacement.
    if (groups.length) await client.query(`INSERT INTO public.wa_reported_pac_groups
      (link_id,election_year,reported_name_key,reported_name,amount_cents,source_row_count)
      SELECT $1::uuid,$2::int,g.key,g.name,g.cents,g."rowCount"
      FROM jsonb_to_recordset($3::jsonb) AS g(key text,name text,cents bigint,"rowCount" integer)`, [...params, JSON.stringify(groups)]);
    await client.query("COMMIT"); return { groupCount: groups.length, totalCents: a.totalCents, idempotent: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
