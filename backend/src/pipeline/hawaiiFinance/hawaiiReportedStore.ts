import type { Pool } from "pg";
import { hiCanonical, hiHold, HI_REPORTED_REVISION, type HawaiiReportedKind } from "./hawaiiReportedCore.js";
import { hawaiiReportedReceiverContext, lockHawaiiReportedReceiver, type HawaiiReportedReceiver } from "./hawaiiReportedReceiver.js";
import { aggregateHawaiiReported, isHawaiiReceiverPacket, validateHawaiiReportedClosure, type HawaiiReceiverPacket, type HawaiiReportedGroup } from "./hawaiiReportedAggregation.js";
export const hiIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function hawaiiReportedSourceFacts(s: HawaiiReceiverPacket) {
  const p = s.packet;
  return { revision: HI_REPORTED_REVISION, kind: p.kind, electionYear: 2026, sourceAt: s.sourceAt, sourceHash: s.sourceHash,
    acquisitionStartedAt: p.acquisitionStartedAt < s.profileStartedAt ? p.acquisitionStartedAt : s.profileStartedAt,
    capturedAt: p.capturedAt, publisherUpdatedAt: p.publisherUpdatedAt, profileAt: s.profileAt, profileHash: s.profileHash,
    sourceRows: p.rows.length, parentCount: p.parentControls.length, nativeVersions: p.nativeVersions, supersededVersions: p.supersededVersions,
    windowStart: p.kind === "ie" ? "2024-11-06" : null, windowEnd: "2026-11-03", nativeLedgerCents: s.nativeLedgerCents };
}
export function validateHawaiiReportedFacts(value: unknown, kind: HawaiiReportedKind, syncedAt: string): void {
  const s = value as ReturnType<typeof hawaiiReportedSourceFacts>;
  if (!s || s.revision !== HI_REPORTED_REVISION || s.kind !== kind || s.electionYear !== 2026
    || ![s.sourceAt, s.acquisitionStartedAt, s.capturedAt, s.publisherUpdatedAt, s.profileAt, syncedAt].every(hiIso)
    || s.sourceAt < s.acquisitionStartedAt || s.capturedAt < s.sourceAt || s.profileAt < s.acquisitionStartedAt
    || s.publisherUpdatedAt > s.capturedAt || syncedAt < s.capturedAt || syncedAt < s.profileAt || Date.parse(syncedAt) > Date.now() + 300000
    || ![s.sourceHash, s.profileHash].every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))
    || ![s.sourceRows, s.parentCount, s.nativeVersions, s.supersededVersions].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2000000)
    || !s.sourceRows || s.supersededVersions > s.nativeVersions || s.windowEnd !== "2026-11-03"
    || (kind === "ie" ? !s.parentCount || s.windowStart !== "2024-11-06" || s.nativeLedgerCents !== null
      : s.parentCount !== 0 || s.windowStart !== null || !Number.isSafeInteger(s.nativeLedgerCents) || s.nativeLedgerCents! < 0)) hiHold("stored_source_facts");
}
export const HI_COMPONENT_WHERE = "candidate_id=$1::uuid AND election_id=$2::uuid AND election_year=2026 AND component=$3";
export async function writeHawaiiReportedComponent(input: {
  db: Pick<Pool, "connect">; receiver: HawaiiReportedReceiver; source: HawaiiReceiverPacket;
}): Promise<{ groups: number; idempotent: boolean }> {
  const { receiver, source } = input;
  if (!isHawaiiReceiverPacket(source)) hiHold("unverified_source");
  const a = aggregateHawaiiReported(receiver, source), facts = hawaiiReportedSourceFacts(source), now = new Date().toISOString();
  validateHawaiiReportedClosure(a, source.packet.kind); validateHawaiiReportedFacts(facts, source.packet.kind, now);
  const { groups, ...controls } = a, key = [receiver.candidateId, receiver.electionId, source.packet.kind], c = await input.db.connect(); let begun = false;
  try {
    await c.query("BEGIN"); begun = true; await lockHawaiiReportedReceiver(c, receiver, source.packet.kind);
    const prior = (await c.query(`SELECT * FROM public.hi_reported_finance_components WHERE ${HI_COMPONENT_WHERE} FOR UPDATE`, key)).rows;
    if (prior.length) {
      const old = prior[0]!, clock = new Date(old.source_observed_at).toISOString();
      if (clock > source.sourceAt) hiHold("older_source");
      if (clock === source.sourceAt) {
        const stored = (await c.query<HawaiiReportedGroup>(`SELECT group_key key,reported_name name,source_class "sourceClass",evidence,stance,amount_cents::float8 cents,occurrence_count occurrences FROM public.hi_reported_finance_groups WHERE ${HI_COMPONENT_WHERE} ORDER BY group_key`, key)).rows;
        const sorted = (rows: HawaiiReportedGroup[]) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
        if (hawaiiReportedReceiverContext(old.receiver_context, source.packet.kind) !== hawaiiReportedReceiverContext(receiver, source.packet.kind) || hiCanonical(old.source_facts) !== hiCanonical(facts)
          || hiCanonical(old.aggregation_controls) !== hiCanonical(controls) || hiCanonical(sorted(stored)) !== hiCanonical(sorted(groups))) hiHold("equal_source_conflict");
        await c.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: true };
      }
    }
    await c.query(`INSERT INTO public.hi_reported_finance_components(candidate_id,election_id,election_year,component,receiver_context,source_facts,aggregation_controls,source_observed_at,last_synced_at)
      VALUES($1,$2,2026,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(candidate_id,election_id,election_year,component) DO UPDATE SET
      receiver_context=EXCLUDED.receiver_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,
      source_observed_at=EXCLUDED.source_observed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [...key, JSON.stringify(receiver), JSON.stringify(facts), JSON.stringify(controls), source.sourceAt, now]);
    await c.query(`DELETE FROM public.hi_reported_finance_groups WHERE ${HI_COMPONENT_WHERE}`, key);
    if (groups.length) await c.query(`INSERT INTO public.hi_reported_finance_groups(candidate_id,election_id,election_year,component,group_key,reported_name,source_class,evidence,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,$2::uuid,2026,$3,x.key,x.name,x."sourceClass",x.evidence,x.stance,x.cents,x.occurrences FROM jsonb_to_recordset($4::jsonb)
      AS x(key text,name text,"sourceClass" text,evidence text,stance text,cents bigint,occurrences integer)`, [...key, JSON.stringify(groups)]);
    await c.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: false };
  } catch (e) { if (begun) await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
