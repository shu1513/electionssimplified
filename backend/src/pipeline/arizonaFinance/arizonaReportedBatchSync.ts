import type { Pool } from "pg";
import { isArizonaReportedCommitteeEnabled, isArizonaIndependentIeEnabled, isArizonaReportedRawRefreshEnabled, isCandidateFinanceSyncEnabled, isArizonaCampaignFinanceSyncEnabled } from "../../config/featureFlags.js";
import { listArizonaReportedReceivers, lockArizonaReportedReceiver, writeArizonaReportedComponent, aggregateArizonaReported, type ArizonaReportedReceiver } from "./arizonaReportedStore.js";
import { createArizonaReportedSource } from "./arizonaReportedSource.js";
import { AZ_REPORTED_REVISION, azCanonical, azHash, azAdd, azHold, ArizonaReportedHold, type ArizonaReportedKind } from "./arizonaReportedCore.js";

export type ArizonaReportedBatchOptions = {
  db: Pick<Pool, "query" | "connect">; cacheDir?: string; now?: Date; dryRun?: boolean; refresh?: boolean;
  maxCandidates?: number; staleAfterDays?: number; electionLookbackDays?: number; electionLookaheadDays?: number;
};
export type ArizonaReportedBatchResult = {
  enabled: boolean; dryRun: boolean; eligibleCount: number; dueCount: number; selectedCount: number;
  attemptedCount: number; writtenCount: number; committeeWrittenCount: number; ieWrittenCount: number;
  heldCount: number; sourceUnavailableCount: number; refreshFailedCount: number; heldReasons: Record<string,number>;
  totalCommitteeCents: number; supportCents: number; opposeCents: number; groupCount: number;
};
const int = (v: number | undefined, fallback: number, max: number): number => {
  const n = v ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error("Invalid Arizona reported batch option"); return n;
};
// Parser retry revision is separate from the immutable stored metric schema.
const attemptRevision = azHash(AZ_REPORTED_REVISION + ":exclusive-person-and-signed-parents-3");
/** Select independent component work before any HTTP request. Legacy direct
 * clocks and receipt/YTD errors never suppress current IE acquisition. */
export async function syncDueArizonaReportedFinance(options: ArizonaReportedBatchOptions): Promise<ArizonaReportedBatchResult> {
  const kinds: ArizonaReportedKind[] = [...(isArizonaReportedCommitteeEnabled() ? ["committee" as const] : []), ...(isArizonaIndependentIeEnabled() ? ["ie" as const] : [])];
  const result: ArizonaReportedBatchResult = { enabled: !!kinds.length, dryRun: options.dryRun === true,
    eligibleCount: 0, dueCount: 0, selectedCount: 0, attemptedCount: 0, writtenCount: 0, committeeWrittenCount: 0, ieWrittenCount: 0,
    heldCount: 0, sourceUnavailableCount: 0, refreshFailedCount: 0, heldReasons: {}, totalCommitteeCents: 0, supportCents: 0, opposeCents: 0, groupCount: 0 };
  if (!kinds.length || !isCandidateFinanceSyncEnabled() || !isArizonaCampaignFinanceSyncEnabled()) { result.enabled=false; return result; }
  const now = options.now ?? new Date(), max = int(options.maxCandidates,25,1000), stale = int(options.staleAfterDays,7,365),
    back = int(options.electionLookbackDays,98,550), ahead = int(options.electionLookaheadDays,730,1000);
  if (!Number.isFinite(now.getTime())) throw Error("Invalid Arizona reported batch clock");
  const eligible = (await listArizonaReportedReceivers(options.db)).filter(r => Date.parse(r.electionDate) >= now.getTime()-back*86400000 && Date.parse(r.electionDate) <= now.getTime()+ahead*86400000);
  result.eligibleCount = eligible.length;
  if (!eligible.length) return result;
  const stored = (await options.db.query<Record<string,any>>(`SELECT link_id::text,component,receiver_context,last_synced_at::text FROM public.az_reported_finance_components WHERE election_year=2026`)).rows;
  const attempts = (await options.db.query<Record<string,any>>(`SELECT link_id::text,component,receiver_context,source_revision,last_attempted_at::text FROM public.az_reported_finance_attempts WHERE election_year=2026`)).rows;
  const due: { receiver: ArizonaReportedReceiver; kinds: ArizonaReportedKind[]; attempted: number }[] = [];
  for (const receiver of eligible) {
    const selected: ArizonaReportedKind[] = []; let attempted = Infinity;
    for (const kind of kinds) {
      const s = stored.find(x => x.link_id === receiver.linkId && x.component === kind), a = attempts.find(x => x.link_id === receiver.linkId && x.component === kind);
      const changed = !a || a.source_revision !== attemptRevision || azCanonical(a.receiver_context) !== azCanonical(receiver);
      const needs = options.refresh || !s || azCanonical(s.receiver_context) !== azCanonical(receiver) || Date.parse(s.last_synced_at) < now.getTime()-stale*86400000;
      if (needs && (options.refresh || changed || now.getTime()-Date.parse(a.last_attempted_at) >= 86400000)) {
        selected.push(kind); attempted = Math.min(attempted,a ? Date.parse(a.last_attempted_at) : -Infinity);
      }
    }
    if (selected.length) due.push({ receiver, kinds: selected, attempted });
  }
  due.sort((a,b) => a.attempted-b.attempted || a.receiver.linkId.localeCompare(b.receiver.linkId));
  result.dueCount = due.length;
  const selected = due.slice(0,max); result.selectedCount = selected.length;
  if (!selected.length) return result;
  // A cache directory or filesystem failure holds every selected component as
  // an unavailable source; it never aborts the batch or legacy direct finance.
  let source: Awaited<ReturnType<typeof createArizonaReportedSource>>;
  try { source = await createArizonaReportedSource({cacheDir:options.cacheDir,refresh:options.refresh,allowLive:isArizonaReportedRawRefreshEnabled()}); }
  catch { source = { load: async () => azHold("source_unavailable") }; }
  for (const item of selected) for (const kind of item.kinds) {
    if (!result.dryRun) {
      const c = await options.db.connect(); let begun = false, accepted = false;
      try {
        await c.query("BEGIN"); begun = true; await lockArizonaReportedReceiver(c,item.receiver);
        const a = await c.query(`INSERT INTO public.az_reported_finance_attempts(link_id,election_year,component,receiver_context,source_revision,last_attempted_at)
          VALUES($1,2026,$2,$3::jsonb,$4,$5) ON CONFLICT(link_id,election_year,component) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,
          source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at WHERE az_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at
          AND ($6::boolean OR az_reported_finance_attempts.source_revision<>EXCLUDED.source_revision OR az_reported_finance_attempts.receiver_context<>EXCLUDED.receiver_context OR
          az_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at-interval '24 hours') RETURNING 1`,
          [item.receiver.linkId,kind,JSON.stringify(item.receiver),attemptRevision,new Date().toISOString(),options.refresh===true]);
        accepted = a.rows.length === 1; await c.query("COMMIT"); begun = false;
      } catch (e) { if (begun) await c.query("ROLLBACK").catch(()=>{}); if (!(e instanceof ArizonaReportedHold)) throw e; }
      finally { c.release(); }
      if (!accepted) { result.heldCount++; continue; }
    }
    result.attemptedCount++;
    try {
      const s = await source.load(item.receiver,kind),
        a = aggregateArizonaReported(item.receiver,s);
      if (!result.dryRun) {
        await writeArizonaReportedComponent({db:options.db,receiver:item.receiver,source:s}); result.writtenCount++;
        if (kind === "committee") result.committeeWrittenCount++; else result.ieWrittenCount++;
      }
      result.groupCount += a.groups.length;
      if (kind === "committee") result.totalCommitteeCents = azAdd(result.totalCommitteeCents,a.totalCents);
      else { result.supportCents = azAdd(result.supportCents,a.supportCents); result.opposeCents = azAdd(result.opposeCents,a.opposeCents); }
    } catch (e) {
      if (!(e instanceof ArizonaReportedHold)) throw e;
      result.heldCount++; result.heldReasons[e.reason]=(result.heldReasons[e.reason]??0)+1;
      if (["source_unavailable","source_status_or_eof","source_json","live_scope_unavailable"].includes(e.reason)) {
        result.sourceUnavailableCount++;
        if (options.refresh) result.refreshFailedCount++;
      }
    }
  }
  return result;
}
