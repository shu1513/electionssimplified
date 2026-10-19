import type { Pool } from "pg";
import { lockOklahomaReportedReceiver,type OklahomaReportedReceiver } from "./oklahomaReportedReceiver.js";
import { aggregateOklahomaReported,validateOklahomaReportedClosure,type OklahomaReportedGroup } from "./oklahomaReportedAggregation.js";
import { isOklahomaReceiverPacket,type OklahomaReceiverPacket } from "./oklahomaReportedSource.js";
import { OK_REPORTED_REVISION,okCanonical,okHold,okIso,type OklahomaReportedKind } from "./oklahomaReportedCore.js";
export { listOklahomaReportedReceivers,lockOklahomaReportedReceiver,type OklahomaReportedReceiver } from "./oklahomaReportedReceiver.js";
export { aggregateOklahomaReported,validateOklahomaReportedClosure,type OklahomaReportedAggregation,type OklahomaReportedGroup } from "./oklahomaReportedAggregation.js";
export function oklahomaReportedSourceFacts(s:OklahomaReceiverPacket) {
 const p=s.packet;return {revision:OK_REPORTED_REVISION,kind:p.kind,electionYear:2026,sourceAt:s.sourceAt,acquisitionStartedAt:p.acquisitionStartedAt<s.profileStartedAt?p.acquisitionStartedAt:s.profileStartedAt,sourceHash:s.sourceHash,
 profileAt:s.profileAt,profileHash:s.profileHash,sourceRows:p.sourceRows,reportCount:p.reportCount,closedReportCount:p.closedReportCount,windowStart:p.windowStart,windowEnd:p.windowEnd};
}
export function validateOklahomaReportedFacts(value:unknown,kind:OklahomaReportedKind,syncedAt:string):void {
 const s=value as ReturnType<typeof oklahomaReportedSourceFacts>;
 if(!s||s.revision!==OK_REPORTED_REVISION||s.kind!==kind||s.electionYear!==2026||![s.sourceAt,s.acquisitionStartedAt,s.profileAt,syncedAt].every(okIso)||
 s.sourceAt<s.acquisitionStartedAt||s.profileAt<s.acquisitionStartedAt||syncedAt<s.sourceAt||syncedAt<s.profileAt||Date.parse(syncedAt)>Date.now()+300000||
 ![s.sourceHash,s.profileHash].every(h=>/^[a-f0-9]{64}$/.test(h))||s.windowStart!=="2025-01-01"||!/^2026-\d\d-\d\d$/.test(s.windowEnd)||s.windowEnd<"2026-01-01"||s.windowEnd>"2026-12-31"||
 ![s.sourceRows,s.reportCount,s.closedReportCount].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2000000)||s.closedReportCount>s.reportCount||
 (kind==="committee"?(s.reportCount!==0||s.closedReportCount!==0||s.sourceRows===0):s.reportCount===0))okHold("stored_source_facts");
}
const where = "link_id=$1::uuid AND election_year=2026 AND component=$2";
export async function writeOklahomaReportedComponent(input: {
  db: Pick<Pool, "connect">; receiver: OklahomaReportedReceiver; source: OklahomaReceiverPacket; now?: Date;
}): Promise<{ groups: number; idempotent: boolean }> {
  const { receiver, source } = input, now = input.now ?? new Date();
  if (!isOklahomaReceiverPacket(source) || !Number.isFinite(now.getTime())) okHold("unverified_source");
  const a = aggregateOklahomaReported(receiver, source), facts = oklahomaReportedSourceFacts(source);
  validateOklahomaReportedFacts(facts, source.packet.kind, now.toISOString()); validateOklahomaReportedClosure(a, source.packet.kind);
  const { groups, ...controls } = a, client = await input.db.connect(), key = [receiver.linkId, source.packet.kind];
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true; await lockOklahomaReportedReceiver(client, receiver);
    const prior = (await client.query(`SELECT * FROM public.ok_reported_finance_components WHERE ${where} FOR UPDATE`, key)).rows;
    if (prior.length) {
      const old = prior[0]!, clock = new Date(old.source_observed_at).toISOString();
      if (clock > source.sourceAt) okHold("older_source");
      if (clock === source.sourceAt) {
        const stored = (await client.query<OklahomaReportedGroup>(`SELECT group_key key,reported_name name,source_class "sourceClass",stance,amount_cents::float8 cents,occurrence_count occurrences FROM public.ok_reported_finance_groups WHERE ${where} ORDER BY group_key`, key)).rows;
        if (okCanonical(old.receiver_context) !== okCanonical(receiver) || okCanonical(old.source_facts) !== okCanonical(facts) || okCanonical(old.aggregation_controls) !== okCanonical(controls) || okCanonical([...stored].sort((a, b) => a.key.localeCompare(b.key))) !== okCanonical([...groups].sort((a, b) => a.key.localeCompare(b.key)))) okHold("equal_source_conflict");
        await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: true };
      }
    }
    await client.query(`INSERT INTO public.ok_reported_finance_components (link_id,election_year,component,candidate_id,election_id,receiver_context,source_facts,aggregation_controls,source_observed_at,last_synced_at)
      VALUES ($1,2026,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
      ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
      receiver_context=EXCLUDED.receiver_context,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,last_synced_at=EXCLUDED.last_synced_at`,
    [...key, receiver.candidateId, receiver.electionId, JSON.stringify(receiver), JSON.stringify(facts), JSON.stringify(controls), source.sourceAt, now.toISOString()]);
    await client.query(`DELETE FROM public.ok_reported_finance_groups WHERE ${where}`, key);
    if (groups.length) await client.query(`INSERT INTO public.ok_reported_finance_groups(link_id,election_year,component,group_key,reported_name,source_class,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,2026,$2,x.key,x.name,x."sourceClass",x.stance,x.cents,x.occurrences FROM jsonb_to_recordset($3::jsonb) AS x(key text,name text,"sourceClass" text,stance text,cents bigint,occurrences integer)`, [...key, JSON.stringify(groups)]);
    await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: false };
  } catch (e) { if (begun) await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

