import type { Pool } from "pg";
import { lockMassachusettsReportedReceiver, type MassachusettsReportedReceiver } from "./massachusettsReportedReceiver.js";
import { aggregateMassachusettsReported, validateMassachusettsReportedClosure, type MassachusettsReportedGroup } from "./massachusettsReportedAggregation.js";
import { isMassachusettsReceiverPacket, type MassachusettsReceiverPacket } from "./massachusettsReportedSource.js";
import { MA_REPORTED_REVISION, maCanonical, maHold, maIso, type MassachusettsReportedKind } from "./massachusettsReportedCore.js";
export { listMassachusettsReportedReceivers, lockMassachusettsReportedReceiver, type MassachusettsReportedReceiver } from "./massachusettsReportedReceiver.js";
export { aggregateMassachusettsReported, validateMassachusettsReportedClosure, type MassachusettsReportedAggregation, type MassachusettsReportedGroup } from "./massachusettsReportedAggregation.js";
export function massachusettsReportedSourceFacts(s: MassachusettsReceiverPacket) {
  const p = s.packet;
  return { revision: MA_REPORTED_REVISION, kind: p.kind, electionYear: 2026, sourceAt: s.sourceAt,
    acquisitionStartedAt: p.acquisitionStartedAt < s.profileStartedAt ? p.acquisitionStartedAt : s.profileStartedAt,
    sourceHash: s.sourceHash, profileAt: s.profileAt, profileHash: s.profileHash,
    oldestBodyAt: p.kind === "ie" ? p.oldestBodyAt : s.profileStartedAt,
    newestBodyAt: p.kind === "ie" ? p.newestBodyAt : s.profileAt,
    sourceRows: p.kind === "ie" ? p.sourceRows : s.rows.length, reportCount: p.reportCount,
    windowStart: "2026-01-01", windowEnd: "2026-12-31" };
}
export function validateMassachusettsReportedFacts(value: unknown, kind: MassachusettsReportedKind, syncedAt: string): void {
  const s = value as ReturnType<typeof massachusettsReportedSourceFacts>;
  if (!s || s.revision !== MA_REPORTED_REVISION || s.kind !== kind || s.electionYear !== 2026 ||
    ![s.sourceAt,s.acquisitionStartedAt,s.profileAt,s.oldestBodyAt,s.newestBodyAt,syncedAt].every(maIso) ||
    s.sourceAt < s.acquisitionStartedAt || s.profileAt < s.acquisitionStartedAt || s.oldestBodyAt < s.acquisitionStartedAt ||
    s.newestBodyAt < s.oldestBodyAt || syncedAt < s.sourceAt || syncedAt < s.profileAt || syncedAt < s.newestBodyAt ||
    Date.parse(syncedAt) > Date.now() + 300000 || ![s.sourceHash,s.profileHash].every(h => /^[a-f0-9]{64}$/.test(h)) ||
    s.windowStart !== "2026-01-01" || s.windowEnd !== "2026-12-31" ||
    ![s.sourceRows,s.reportCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2000000) ||
    (kind === "committee" ? s.reportCount !== 0 || s.sourceRows === 0 : s.reportCount === 0 || s.newestBodyAt > s.sourceAt)) maHold("stored_source_facts");
}
const where = "link_id=$1::uuid AND election_year=2026 AND component=$2";
/** Full replay/closure happens before taking the lock; canonical context is
 * checked again under lock. Each component replacement is atomic. */
export async function writeMassachusettsReportedComponent(input: {
  db: Pick<Pool, "connect">; receiver: MassachusettsReportedReceiver; source: MassachusettsReceiverPacket; now?: Date;
}): Promise<{ groups: number; idempotent: boolean }> {
  const { receiver, source } = input, now = input.now ?? new Date();
  if (!isMassachusettsReceiverPacket(source) || !Number.isFinite(now.getTime())) maHold("unverified_source");
  const a = aggregateMassachusettsReported(receiver, source), facts = massachusettsReportedSourceFacts(source);
  validateMassachusettsReportedFacts(facts, source.packet.kind, now.toISOString()); validateMassachusettsReportedClosure(a, source.packet.kind);
  const { groups, ...controls } = a, client = await input.db.connect(), key = [receiver.linkId, source.packet.kind];
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true; await lockMassachusettsReportedReceiver(client, receiver);
    const prior = (await client.query(`SELECT * FROM public.ma_reported_finance_components WHERE ${where} FOR UPDATE`, key)).rows;
    if (prior.length) {
      const old = prior[0]!, clock = new Date(old.source_observed_at).toISOString();
      if (clock > source.sourceAt) maHold("older_source");
      if (clock === source.sourceAt) {
        const stored = (await client.query<MassachusettsReportedGroup>(`SELECT group_key key,reported_name name,source_class "sourceClass",stance,amount_cents::float8 cents,occurrence_count occurrences FROM public.ma_reported_finance_groups WHERE ${where} ORDER BY group_key`, key)).rows;
        if (maCanonical(old.receiver_context) !== maCanonical(receiver) || maCanonical(old.source_facts) !== maCanonical(facts) || maCanonical(old.aggregation_controls) !== maCanonical(controls) || maCanonical([...stored].sort((a,b) => a.key.localeCompare(b.key))) !== maCanonical([...groups].sort((a,b) => a.key.localeCompare(b.key)))) maHold("equal_source_conflict");
        await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: true };
      }
    }
    await client.query(`INSERT INTO public.ma_reported_finance_components(link_id,election_year,component,candidate_id,election_id,receiver_context,source_facts,aggregation_controls,source_observed_at,last_synced_at)
      VALUES($1,2026,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
      ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,
      source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [...key,receiver.candidateId,receiver.electionId,JSON.stringify(receiver),JSON.stringify(facts),JSON.stringify(controls),source.sourceAt,now.toISOString()]);
    await client.query(`DELETE FROM public.ma_reported_finance_groups WHERE ${where}`, key);
    if (groups.length) await client.query(`INSERT INTO public.ma_reported_finance_groups(link_id,election_year,component,group_key,reported_name,source_class,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,2026,$2,x.key,x.name,x."sourceClass",x.stance,x.cents,x.occurrences FROM jsonb_to_recordset($3::jsonb) AS x(key text,name text,"sourceClass" text,stance text,cents bigint,occurrences integer)`, [...key,JSON.stringify(groups)]);
    await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: false };
  } catch (e) { if (begun) await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}
