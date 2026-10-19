import type { Pool } from "pg";
import { lockArizonaReportedReceiver, type ArizonaReportedReceiver } from "./arizonaReportedReceiver.js";
import { validateArizonaReportedClosure, type ArizonaReportedGroup } from "./arizonaReportedAggregation.js";
import { aggregateArizonaReported, isArizonaReportedPacket, type ArizonaReportedPacket, type ArizonaReportedSourceFacts } from "./arizonaReportedSource.js";
export { aggregateArizonaReported } from "./arizonaReportedSource.js";
import { AZ_REPORTED_REVISION, azCanonical, azHold, azIso, type ArizonaReportedKind } from "./arizonaReportedCore.js";
export { listArizonaReportedReceivers, lockArizonaReportedReceiver, type ArizonaReportedReceiver } from "./arizonaReportedReceiver.js";
export { validateArizonaReportedClosure, type ArizonaReportedAggregation, type ArizonaReportedGroup } from "./arizonaReportedAggregation.js";
export function validateArizonaReportedFacts(value: unknown, kind: ArizonaReportedKind, syncedAt: string): void {
  const s=value as ArizonaReportedSourceFacts;
  if(!s || azCanonical(Object.keys(s).sort())!==azCanonical(["revision","kind","electionYear","sourceAt","oldestBodyAt","newestBodyAt","sourceHash","sourceRows","reportCount","parentRows","windowStart","windowEnd"].sort()) ||
    s.revision!==AZ_REPORTED_REVISION || s.kind!==kind || s.electionYear!==2026 ||
    ![s.sourceAt,s.oldestBodyAt,s.newestBodyAt,syncedAt].every(azIso) ||
    s.oldestBodyAt>s.newestBodyAt || s.newestBodyAt>s.sourceAt || syncedAt<s.sourceAt ||
    Date.parse(syncedAt)>Date.now()+300000 || !/^[a-f0-9]{64}$/.test(s.sourceHash) ||
    s.windowStart!=="2025-01-01" || s.windowEnd!=="2026-12-31" ||
    ![s.sourceRows,s.reportCount,s.parentRows].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2000000) ||
    (kind==="committee" && s.reportCount===0)) azHold("stored_source_facts");
}
const where = "link_id=$1::uuid AND election_year=2026 AND component=$2";
/** Full replay/closure happens before taking the lock; canonical context is
 * checked again under lock. Each component replacement is atomic. */
export async function writeArizonaReportedComponent(input: {
  db: Pick<Pool, "connect">; receiver: ArizonaReportedReceiver; source: ArizonaReportedPacket; now?: Date;
}): Promise<{ groups: number; idempotent: boolean }> {
  const { receiver, source } = input, now = input.now ?? new Date();
  if (!isArizonaReportedPacket(source) || !Number.isFinite(now.getTime())) azHold("unverified_source");
  const a = aggregateArizonaReported(receiver, source), facts = source.facts;
  validateArizonaReportedFacts(facts, source.kind, now.toISOString()); validateArizonaReportedClosure(a, source.kind);
  const { groups, ...controls } = a, client = await input.db.connect(), key = [receiver.linkId, source.kind];
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true; await lockArizonaReportedReceiver(client, receiver);
    const prior = (await client.query(`SELECT * FROM public.az_reported_finance_components WHERE ${where} FOR UPDATE`, key)).rows;
    if (prior.length) {
      const old = prior[0]!, clock = new Date(old.source_observed_at).toISOString();
      if (clock > source.facts.sourceAt) azHold("older_source");
      if (clock === source.facts.sourceAt) {
        const stored = (await client.query<ArizonaReportedGroup>(`SELECT group_key key,reported_name name,source_class "sourceClass",stance,amount_cents::float8 cents,occurrence_count occurrences FROM public.az_reported_finance_groups WHERE ${where} ORDER BY group_key`, key)).rows;
        if (azCanonical(old.receiver_context) !== azCanonical(receiver) || azCanonical(old.source_facts) !== azCanonical(facts) || azCanonical(old.aggregation_controls) !== azCanonical(controls) || azCanonical([...stored].sort((a,b) => a.key.localeCompare(b.key))) !== azCanonical([...groups].sort((a,b) => a.key.localeCompare(b.key)))) azHold("equal_source_conflict");
        await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: true };
      }
    }
    await client.query(`INSERT INTO public.az_reported_finance_components(link_id,election_year,component,candidate_id,election_id,receiver_context,source_facts,aggregation_controls,source_observed_at,last_synced_at)
      VALUES($1,2026,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
      ON CONFLICT(link_id,election_year,component) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiver_context=EXCLUDED.receiver_context,
      source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,source_observed_at=EXCLUDED.source_observed_at,last_synced_at=EXCLUDED.last_synced_at`,
      [...key,receiver.candidateId,receiver.electionId,JSON.stringify(receiver),JSON.stringify(facts),JSON.stringify(controls),source.facts.sourceAt,now.toISOString()]);
    await client.query(`DELETE FROM public.az_reported_finance_groups WHERE ${where}`, key);
    if (groups.length) await client.query(`INSERT INTO public.az_reported_finance_groups(link_id,election_year,component,group_key,reported_name,source_class,stance,amount_cents,occurrence_count)
      SELECT $1::uuid,2026,$2,x.key,x.name,x."sourceClass",x.stance,x.cents,x.occurrences FROM jsonb_to_recordset($3::jsonb) AS x(key text,name text,"sourceClass" text,stance text,cents bigint,occurrences integer)`, [...key,JSON.stringify(groups)]);
    await client.query("COMMIT"); begun = false; return { groups: groups.length, idempotent: false };
  } catch (e) { if (begun) await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}
