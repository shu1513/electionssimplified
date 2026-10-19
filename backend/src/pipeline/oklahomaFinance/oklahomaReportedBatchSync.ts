import type { Pool } from "pg";
import {
  isOklahomaReportedCommitteeEnabled,
  isOklahomaIndependentIeEnabled,
} from "../../config/featureFlags.js";
import {
  listOklahomaReportedReceivers,
  lockOklahomaReportedReceiver,
  writeOklahomaReportedComponent,
} from "./oklahomaReportedStore.js";
import {
  loadOklahomaReportedPacket,
  loadOklahomaReceiverPacket,
  type OklahomaReportedPacket,
} from "./oklahomaReportedSource.js";
import {
  aggregateOklahomaReported,
  type OklahomaReportedReceiver,
} from "./oklahomaReportedStore.js";
import { OklahomaReportedHold,okCanonical,okHash,OK_REPORTED_REVISION,type OklahomaReportedKind } from "./oklahomaReportedCore.js";

export type OklahomaReportedBatchOptions = {
  db: Pick<Pool, "query" | "connect">;
  cacheDir?: string;
  now?: Date;
  dryRun?: boolean;
  refresh?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
};
export type OklahomaReportedBatchResult = {
  enabled: boolean;
  dryRun: boolean;
  eligibleCount: number;
  dueCount: number;
  selectedCount: number;
  attemptedCount: number;
  writtenCount: number;
  committeeWrittenCount: number;
  ieWrittenCount: number;
  heldCount: number;
  sourceUnavailableCount: number;
  /** Routine refreshes that failed; the last qualified packet was replayed instead. */
  refreshFailedCount: number;
  totalCommitteeCents: number;
  supportCents: number;
  opposeCents: number;
  groupCount: number;
  heldReasons:Record<string,number>;
  sourceHoldReasons:Record<string,number>;
};
const int = (n: number | undefined, fallback: number, max: number): number => {
  const v = n ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1 || v > max)
    throw new Error("Invalid Oklahoma reported batch option");
  return v;
};
type Due = {
  receiver: OklahomaReportedReceiver;
  kinds: OklahomaReportedKind[];
  attempted: number;
};
/** Each component has its own source and attempts. A malformed direct ledger
 * cannot prevent acquiring or writing the IE observation. */
export async function syncDueOklahomaReportedFinance(
  options: OklahomaReportedBatchOptions,
): Promise<OklahomaReportedBatchResult> {
  const kinds: OklahomaReportedKind[] = [
    ...(isOklahomaReportedCommitteeEnabled() ? ["committee" as const] : []),
    ...(isOklahomaIndependentIeEnabled() ? ["ie" as const] : []),
  ];
  // Validate options only when enabled: the legacy batch forwards its own
  // uncapped CLI values and must keep working while these flags are off.
  const now = options.now ?? new Date(),
    max = kinds.length ? int(options.maxCandidates, 25, 1000) : 0,
    stale = !kinds.length || options.staleAfterDays === 0 ? 0 : int(options.staleAfterDays, 7, 365),
    lookback = kinds.length ? int(options.electionLookbackDays, 98, 550) : 0,
    lookahead = kinds.length ? int(options.electionLookaheadDays, 730, 1000) : 0;
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid Oklahoma reported batch clock");
  const result: OklahomaReportedBatchResult = {
    enabled: kinds.length > 0,
    dryRun: options.dryRun === true,
    eligibleCount: 0,
    dueCount: 0,
    selectedCount: 0,
    attemptedCount: 0,
    writtenCount: 0,
    committeeWrittenCount: 0,
    ieWrittenCount: 0,
    heldCount: 0,
    sourceUnavailableCount: 0,
    refreshFailedCount: 0,
    totalCommitteeCents: 0,
    supportCents: 0,
    opposeCents: 0,
    groupCount: 0,
    heldReasons:{},sourceHoldReasons:{},
  };
  if (!result.enabled) return result;
  const packets = new Map<
    OklahomaReportedKind,
    OklahomaReportedPacket | null
  >();
  for (const kind of kinds) {
    let source: OklahomaReportedPacket | null = null;
    try {
      source = await loadOklahomaReportedPacket(kind, { cacheDir: options.cacheDir, refresh: options.refresh,
        onRefreshError: code => { result.refreshFailedCount++;result.sourceHoldReasons[code]=(result.sourceHoldReasons[code]??0)+1; } });
    } catch {
      // Each complete source graph fails independently; retain prior rows.
    }
    packets.set(kind, source);
    if (!source) result.sourceUnavailableCount++;
  }
  const eligible = (await listOklahomaReportedReceivers(options.db)).filter(
    (r) => {
      const t = Date.parse(r.electionDate);
      return (
        t >= now.getTime() - lookback * 86_400_000 &&
        t <= now.getTime() + lookahead * 86_400_000
      );
    },
  );
  result.eligibleCount = eligible.length;
  const stored = (
    await options.db.query<Record<string, any>>(
      `SELECT s.link_id::text,s.component,s.receiver_context,s.source_observed_at::text,s.last_synced_at::text FROM public.ok_reported_finance_components s WHERE election_year=2026`,
    )
  ).rows;
  const attempts = (
    await options.db.query<Record<string, any>>(
      `SELECT link_id::text,component,source_revision,receiver_context,last_attempted_at::text FROM public.ok_reported_finance_attempts WHERE election_year=2026`,
    )
  ).rows;
  const due: Due[] = [];
  for (const receiver of eligible) {
    const selected: OklahomaReportedKind[] = [];
    let attempted = Infinity;
    for (const kind of kinds) {
      const source = packets.get(kind),
        revision = source ? okHash(OK_REPORTED_REVISION + source.sourceHash) : "none",
        s = stored.find(
          (x) => x.link_id === receiver.linkId && x.component === kind,
        ),
        a = attempts.find(
          (x) => x.link_id === receiver.linkId && x.component === kind,
        );
      const changed =
        !a ||
        a.source_revision !== revision ||
        okCanonical(a.receiver_context) !== okCanonical(receiver);
      const needs =
        options.refresh ||
        !s ||
        !source ||
        okCanonical(s.receiver_context) !== okCanonical(receiver) ||
        Date.parse(s.source_observed_at) < Date.parse(source.sourceAt) ||
        Date.parse(s.last_synced_at) < now.getTime() - stale * 86_400_000;
      if (
        needs &&
        (changed ||
          now.getTime() - Date.parse(a.last_attempted_at) >= 86_400_000)
      ) {
        selected.push(kind);
        attempted = Math.min(
          attempted,
          a ? Date.parse(a.last_attempted_at) : -Infinity,
        );
      }
    }
    if (selected.length) due.push({ receiver, kinds: selected, attempted });
  }
  due.sort(
    (a, b) =>
      a.attempted - b.attempted ||
      a.receiver.candidateName.localeCompare(b.receiver.candidateName)||a.receiver.linkId.localeCompare(b.receiver.linkId),
  );
  result.dueCount = due.length;
  const selected = due.slice(0, max);
  result.selectedCount = selected.length;
  for (const item of selected)
    for (const kind of item.kinds) {
      const source = packets.get(kind) ?? null;
      if (!result.dryRun) {
        const c = await options.db.connect();
        let begun = false,
          accepted = false;
        try {
          await c.query("BEGIN");
          begun = true;
          await lockOklahomaReportedReceiver(c, item.receiver);
          const a = await c.query(
            `INSERT INTO public.ok_reported_finance_attempts(link_id,election_year,component,receiver_context,source_revision,last_attempted_at)
          VALUES($1,2026,$2,$3::jsonb,$4,$5) ON CONFLICT(link_id,election_year,component) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,
          source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at
          WHERE ok_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at AND (
            ok_reported_finance_attempts.source_revision<>EXCLUDED.source_revision OR ok_reported_finance_attempts.receiver_context<>EXCLUDED.receiver_context OR
            ok_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at-interval '24 hours') RETURNING 1`,
            [
              item.receiver.linkId,
              kind,
              JSON.stringify(item.receiver),
              source ? okHash(OK_REPORTED_REVISION + source.sourceHash) : "none",
              new Date().toISOString(),
            ],
          );
          accepted = a.rows.length === 1;
          await c.query("COMMIT");
          begun = false;
        } catch (e) {
          if (begun) await c.query("ROLLBACK").catch(() => {});
          if (!(e instanceof OklahomaReportedHold)) throw e;
        } finally {
          c.release();
        }
        if (!accepted) {
          result.heldCount++;
          continue;
        }
        result.attemptedCount++;
      }
      if (!source) {
        result.heldCount++;
        continue;
      }
      try {
        const qualifiedSource = await loadOklahomaReceiverPacket(source,item.receiver.entityId,{cacheDir:options.cacheDir,refresh:options.refresh});
        const a = aggregateOklahomaReported(item.receiver, qualifiedSource);
        if (!result.dryRun) {
          await writeOklahomaReportedComponent({
            db: options.db,
            receiver: item.receiver,
            source: qualifiedSource,
          });
          result.writtenCount++;
          if (kind === "committee") result.committeeWrittenCount++;
          else result.ieWrittenCount++;
        }
        result.groupCount += a.groups.length;
        if (kind === "committee") result.totalCommitteeCents += a.totalCents;
        else {
          result.supportCents += a.supportCents;
          result.opposeCents += a.opposeCents;
        }
      } catch (e) {
        if (!(e instanceof OklahomaReportedHold)) throw e;
        result.heldCount++;
        result.heldReasons[e.code]=(result.heldReasons[e.code]??0)+1;
      }
    }
  return result;
}

