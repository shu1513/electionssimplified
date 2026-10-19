import type { Pool } from "pg";
import {
  isNorthDakotaReportedCommitteeEnabled,
  isNorthDakotaIndependentIeEnabled,
} from "../../config/featureFlags.js";
import {
  listNorthDakotaReportedReceivers,
  lockNorthDakotaReportedReceiver,
  writeNorthDakotaReportedComponent,
} from "./northDakotaReportedStore.js";
import {
  loadNorthDakotaReportedPacket,
  ndCanonical,
  ndHash,
  ND_REPORTED_REVISION,
  type NorthDakotaReportedKind,
  type NorthDakotaReportedPacket,
} from "./northDakotaReportedSource.js";
import {
  aggregateNorthDakotaReported,
  type NorthDakotaReportedReceiver,
} from "./northDakotaReportedStore.js";
import { NorthDakotaReportedHold } from "./northDakotaReportedAggregation.js";

export type NorthDakotaReportedBatchOptions = {
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
export type NorthDakotaReportedBatchResult = {
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
  totalCommitteeCents: number;
  supportCents: number;
  opposeCents: number;
  groupCount: number;
};
const int = (n: number | undefined, fallback: number, max: number): number => {
  const v = n ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1 || v > max)
    throw new Error("Invalid NorthDakota reported batch option");
  return v;
};
type Due = {
  receiver: NorthDakotaReportedReceiver;
  kinds: NorthDakotaReportedKind[];
  attempted: number;
};
/** Each component has its own source and attempts. A malformed direct ledger
 * cannot prevent acquiring or writing the IE observation. */
export async function syncDueNorthDakotaReportedFinance(
  options: NorthDakotaReportedBatchOptions,
): Promise<NorthDakotaReportedBatchResult> {
  const kinds: NorthDakotaReportedKind[] = [
    ...(isNorthDakotaReportedCommitteeEnabled() ? ["committee" as const] : []),
    ...(isNorthDakotaIndependentIeEnabled() ? ["ie" as const] : []),
  ];
  // Validate options only when enabled: the legacy batch forwards its own
  // uncapped CLI values and must keep working while these flags are off.
  const now = options.now ?? new Date(),
    max = kinds.length ? int(options.maxCandidates, 25, 1000) : 0,
    stale = !kinds.length || options.staleAfterDays === 0 ? 0 : int(options.staleAfterDays, 7, 365),
    lookback = kinds.length ? int(options.electionLookbackDays, 103, 550) : 0,
    lookahead = kinds.length ? int(options.electionLookaheadDays, 730, 1000) : 0;
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid NorthDakota reported batch clock");
  const result: NorthDakotaReportedBatchResult = {
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
    totalCommitteeCents: 0,
    supportCents: 0,
    opposeCents: 0,
    groupCount: 0,
  };
  if (!result.enabled) return result;
  const packets = new Map<
    NorthDakotaReportedKind,
    NorthDakotaReportedPacket | null
  >();
  for (const kind of kinds) {
    let source: NorthDakotaReportedPacket | null = null;
    try {
      source = await loadNorthDakotaReportedPacket(kind, { cacheDir: options.cacheDir, refresh: options.refresh });
    } catch {
      // Each complete source graph fails independently; retain prior rows.
    }
    packets.set(kind, source);
    if (!source) result.sourceUnavailableCount++;
  }
  const eligible = (await listNorthDakotaReportedReceivers(options.db)).filter(
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
      `SELECT s.link_id::text,s.component,s.receiver_context,s.source_observed_at::text,s.last_synced_at::text FROM public.nd_reported_finance_components s WHERE election_year=2026`,
    )
  ).rows;
  const attempts = (
    await options.db.query<Record<string, any>>(
      `SELECT link_id::text,component,source_revision,receiver_context,last_attempted_at::text FROM public.nd_reported_finance_attempts WHERE election_year=2026`,
    )
  ).rows;
  const due: Due[] = [];
  for (const receiver of eligible) {
    const selected: NorthDakotaReportedKind[] = [];
    let attempted = Infinity;
    for (const kind of kinds) {
      const source = packets.get(kind),
        revision = source ? ndHash(ND_REPORTED_REVISION + source.sourceHash) : "none",
        s = stored.find(
          (x) => x.link_id === receiver.linkId && x.component === kind,
        ),
        a = attempts.find(
          (x) => x.link_id === receiver.linkId && x.component === kind,
        );
      const changed =
        !a ||
        a.source_revision !== revision ||
        ndCanonical(a.receiver_context) !== ndCanonical(receiver);
      const needs =
        options.refresh ||
        !s ||
        !source ||
        ndCanonical(s.receiver_context) !== ndCanonical(receiver) ||
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
      a.receiver.linkId.localeCompare(b.receiver.linkId),
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
          await lockNorthDakotaReportedReceiver(c, item.receiver);
          const a = await c.query(
            `INSERT INTO public.nd_reported_finance_attempts(link_id,election_year,component,receiver_context,source_revision,last_attempted_at)
          VALUES($1,2026,$2,$3::jsonb,$4,$5) ON CONFLICT(link_id,election_year,component) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,
          source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at
          WHERE nd_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at AND (
            nd_reported_finance_attempts.source_revision<>EXCLUDED.source_revision OR nd_reported_finance_attempts.receiver_context<>EXCLUDED.receiver_context OR
            nd_reported_finance_attempts.last_attempted_at<=EXCLUDED.last_attempted_at-interval '24 hours') RETURNING 1`,
            [
              item.receiver.linkId,
              kind,
              JSON.stringify(item.receiver),
              source ? ndHash(ND_REPORTED_REVISION + source.sourceHash) : "none",
              new Date().toISOString(),
            ],
          );
          accepted = a.rows.length === 1;
          await c.query("COMMIT");
          begun = false;
        } catch (e) {
          if (begun) await c.query("ROLLBACK").catch(() => {});
          if (!(e instanceof NorthDakotaReportedHold)) throw e;
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
        const a = aggregateNorthDakotaReported(item.receiver, source);
        if (!result.dryRun) {
          await writeNorthDakotaReportedComponent({
            db: options.db,
            receiver: item.receiver,
            source,
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
        if (!(e instanceof NorthDakotaReportedHold)) throw e;
        result.heldCount++;
      }
    }
  return result;
}
