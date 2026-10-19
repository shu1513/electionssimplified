import type { Pool } from "pg";
import { isHawaiiIndependentIeEnabled, isHawaiiReportedCommitteeEnabled } from "../../config/featureFlags.js";
import { HI_REPORTED_REVISION, hiAdd, hiHash, HawaiiReportedHold, type HawaiiReportedKind } from "./hawaiiReportedCore.js";
import { hawaiiReportedReceiverContext, listHawaiiReportedReceivers, lockHawaiiReportedReceiver, type HawaiiReportedReceiver } from "./hawaiiReportedReceiver.js";
import { loadHawaiiReportedPacket, type HawaiiReportedPacket } from "./hawaiiReportedSource.js";
import { aggregateHawaiiReported, loadHawaiiReceiverPacket } from "./hawaiiReportedAggregation.js";
import { writeHawaiiReportedComponent } from "./hawaiiReportedStore.js";

export type HawaiiReportedBatchOptions = {
  db: Pick<Pool, "query" | "connect">; cacheDir?: string; now?: Date; dryRun?: boolean; refresh?: boolean;
  maxCandidates?: number; staleAfterDays?: number; electionLookbackDays?: number; electionLookaheadDays?: number;
};
export type HawaiiReportedBatchResult = {
  enabled: boolean; dryRun: boolean; eligibleCount: number; dueCount: number; selectedCount: number;
  attemptedCount: number; writtenCount: number; committeeWrittenCount: number; ieWrittenCount: number;
  heldCount: number; sourceUnavailableCount: number; refreshFailedCount: number;
  totalCommitteeCents: number; supportCents: number; opposeCents: number; groupCount: number;
  heldReasons: Record<string, number>; sourceHoldReasons: Record<string, number>;
};
const int = (v: number | undefined, fallback: number, max: number) => {
  const n = v ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error("Invalid Hawaii reported batch option"); return n;
};
const attemptRevision = hiHash(HI_REPORTED_REVISION + ":native-read-3-candidate-cover-period");

/** Component due work is selected before any source request. Each component
 * receives its own default batch of 25 and daily retry/success clocks. */
export async function syncDueHawaiiReportedFinance(options: HawaiiReportedBatchOptions): Promise<HawaiiReportedBatchResult> {
  const kinds: HawaiiReportedKind[] = [...(isHawaiiIndependentIeEnabled() ? ["ie" as const] : []), ...(isHawaiiReportedCommitteeEnabled() ? ["committee" as const] : [])];
  const result: HawaiiReportedBatchResult = { enabled: !!kinds.length, dryRun: options.dryRun === true, eligibleCount: 0, dueCount: 0, selectedCount: 0,
    attemptedCount: 0, writtenCount: 0, committeeWrittenCount: 0, ieWrittenCount: 0, heldCount: 0, sourceUnavailableCount: 0, refreshFailedCount: 0,
    totalCommitteeCents: 0, supportCents: 0, opposeCents: 0, groupCount: 0, heldReasons: {}, sourceHoldReasons: {} };
  if (!kinds.length) return result;
  const now = options.now ?? new Date(), max = int(options.maxCandidates, 25, 1000), stale = int(options.staleAfterDays, 1, 365),
    back = int(options.electionLookbackDays, 98, 550), ahead = int(options.electionLookaheadDays, 730, 1000);
  if (!Number.isFinite(now.getTime())) throw Error("Invalid Hawaii reported batch clock");
  const eligible = (await listHawaiiReportedReceivers(options.db)).filter(r => Date.parse(r.electionDate) >= now.getTime() - back * 86400000 && Date.parse(r.electionDate) <= now.getTime() + ahead * 86400000);
  result.eligibleCount = eligible.length; if (!eligible.length) return result;
  const stored = (await options.db.query<Record<string, any>>("SELECT candidate_id::text,election_id::text,component,receiver_context,last_synced_at::text FROM public.hi_reported_finance_components WHERE election_year=2026")).rows;
  const attempts = (await options.db.query<Record<string, any>>("SELECT candidate_id::text,election_id::text,component,receiver_context,source_revision,last_attempted_at::text FROM public.hi_reported_finance_attempts WHERE election_year=2026")).rows;
  const same = (x: Record<string, any>, r: HawaiiReportedReceiver, kind: HawaiiReportedKind) => x.candidate_id === r.candidateId && x.election_id === r.electionId && x.component === kind;
  const work: { receiver: HawaiiReportedReceiver; kind: HawaiiReportedKind }[] = [];
  for (const kind of kinds) {
    const due = eligible.flatMap(receiver => {
      const s = stored.find(x => same(x, receiver, kind)), a = attempts.find(x => same(x, receiver, kind));
      const changed = !a || a.source_revision !== attemptRevision || hawaiiReportedReceiverContext(a.receiver_context, kind) !== hawaiiReportedReceiverContext(receiver, kind);
      const needs = options.refresh || !s || hawaiiReportedReceiverContext(s.receiver_context, kind) !== hawaiiReportedReceiverContext(receiver, kind) || Date.parse(s.last_synced_at) < now.getTime() - stale * 86400000;
      return needs && (options.refresh || changed || now.getTime() - Date.parse(a.last_attempted_at) >= 86400000)
        ? [{ receiver, attempted: a ? Date.parse(a.last_attempted_at) : -Infinity }] : [];
    }).sort((a, b) => a.attempted - b.attempted || a.receiver.candidateId.localeCompare(b.receiver.candidateId) || a.receiver.electionId.localeCompare(b.receiver.electionId));
    result.dueCount += due.length; work.push(...due.slice(0, max).map(x => ({ receiver: x.receiver, kind })));
  }
  result.selectedCount = work.length; if (!work.length) return result;
  const packets = new Map<HawaiiReportedKind, HawaiiReportedPacket | null>();
  for (const kind of kinds.filter(k => work.some(w => w.kind === k))) {
    let packet: HawaiiReportedPacket | null = null;
    try { packet = await loadHawaiiReportedPacket(kind, { cacheDir: options.cacheDir, refresh: options.refresh, onRefreshError: code => {
      result.refreshFailedCount++; result.sourceHoldReasons[code] = (result.sourceHoldReasons[code] ?? 0) + 1;
    } }); } catch { /* Acquisition failures are isolated by component. */ }
    if (!packet) result.sourceUnavailableCount++; packets.set(kind, packet);
  }
  for (const { receiver, kind } of work) {
    if (!result.dryRun) {
      const c = await options.db.connect(); let begun = false, accepted = false;
      try {
        await c.query("BEGIN"); begun = true; await lockHawaiiReportedReceiver(c, receiver, kind);
        const a = await c.query(`INSERT INTO public.hi_reported_finance_attempts(candidate_id,election_id,election_year,component,receiver_context,source_revision,last_attempted_at)
          VALUES($1,$2,2026,$3,$4::jsonb,$5,$6) ON CONFLICT(candidate_id,election_id,election_year,component) DO UPDATE SET
          receiver_context=EXCLUDED.receiver_context,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at
          WHERE hi_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at AND ($7::boolean OR
          hi_reported_finance_attempts.source_revision<>EXCLUDED.source_revision OR hi_reported_finance_attempts.receiver_context<>EXCLUDED.receiver_context
          OR hi_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at-interval '24 hours') RETURNING 1`,
          [receiver.candidateId, receiver.electionId, kind, JSON.stringify(receiver), attemptRevision, new Date().toISOString(), options.refresh === true]);
        accepted = a.rows.length === 1; await c.query("COMMIT"); begun = false;
      } catch (e) { if (begun) await c.query("ROLLBACK").catch(() => {}); if (!(e instanceof HawaiiReportedHold)) throw e; }
      finally { c.release(); }
      if (!accepted) { result.heldCount++; continue; }
    }
    result.attemptedCount++; const packet = packets.get(kind);
    if (!packet) { result.heldCount++; continue; }
    try {
      const source = await loadHawaiiReceiverPacket(packet, receiver, { cacheDir: options.cacheDir, refresh: options.refresh });
      const a = aggregateHawaiiReported(receiver, source);
      if (!result.dryRun) {
        await writeHawaiiReportedComponent({ db: options.db, receiver, source }); result.writtenCount++;
        if (kind === "committee") result.committeeWrittenCount++; else result.ieWrittenCount++;
      }
      result.groupCount += a.groups.length;
      if (kind === "committee") result.totalCommitteeCents = hiAdd(result.totalCommitteeCents, a.totalCents);
      else { result.supportCents = hiAdd(result.supportCents, a.supportCents); result.opposeCents = hiAdd(result.opposeCents, a.opposeCents); }
    } catch (e) {
      result.heldCount++; const code = e instanceof HawaiiReportedHold ? e.code : "component_unavailable";
      result.heldReasons[code] = (result.heldReasons[code] ?? 0) + 1;
    }
  }
  return result;
}
