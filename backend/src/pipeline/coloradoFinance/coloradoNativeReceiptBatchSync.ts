import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isColoradoCampaignFinanceSyncEnabled,
  isColoradoNativeReceiptsEnabled,
} from "../../config/featureFlags.js";
import { ColoradoReportError } from "./coloradoTracerReports.js";
import {
  listColoradoIeReceivers,
  lockColoradoIeReceiver,
  type ColoradoIeReceiver,
} from "./coloradoReportedIeReceiver.js";
import {
  getColoradoNativeReceiptRegistry,
  getColoradoNativeReceiptsPacket,
} from "./coloradoNativeReceiptSource.js";
import { writeColoradoNativeReceipts } from "./coloradoNativeReceiptStore.js";
import { CO_NATIVE_RECEIPTS_REVISION } from "./coloradoNativeReceiptSource.js";
export type ColoradoNativeReceiptBatchInput = {
  db: Pick<Pool, "query" | "connect">;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  cacheDir?: string;
  linkId?: string;
  refresh?: boolean;
};
export async function syncDueColoradoNativeReceipts(
  input: ColoradoNativeReceiptBatchInput,
) {
  const output = {
    enabled:
      isColoradoNativeReceiptsEnabled() &&
      isColoradoCampaignFinanceSyncEnabled(),
    dryRun: input.dryRun === true,
    totalDueRows: 0,
    selectedCandidates: 0,
    attemptedComponents: 0,
    writtenComponents: 0,
    idempotentComponents: 0,
    heldComponents: 0,
    groups: 0,
    holds: {} as Record<string, number>,
  };
  if (!output.enabled) return output;
  const now = input.now ?? new Date(),
    max = input.maxCandidates ?? 25,
    stale = input.staleAfterDays ?? 7,
    back = input.electionLookbackDays ?? 112,
    ahead = input.electionLookaheadDays ?? 730;
  if (
    !Number.isFinite(now.getTime()) ||
    ![max, stale, back, ahead].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 100000,
    ) ||
    (input.linkId &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(input.linkId))
  )
    throw new ColoradoReportError("invalid_native_receipt_batch_options");
  const receivers = (await listColoradoIeReceivers(input.db)).filter(
    (r) =>
      (!input.linkId || r.linkId === input.linkId) &&
      Date.parse(r.electionDate) >= now.getTime() - back * 86400000 &&
      Date.parse(r.electionDate) <= now.getTime() + ahead * 86400000,
  );
  if (!receivers.length) return output;
  const sources = (
    await input.db.query<Record<string, unknown>>(
      "SELECT * FROM public.co_native_receipt_sources WHERE link_id=ANY($1::uuid[])",
      [receivers.map((r) => r.linkId)],
    )
  ).rows;
  const attempts = (
    await input.db.query<Record<string, unknown>>(
      "SELECT * FROM public.co_native_receipt_attempts WHERE link_id=ANY($1::uuid[])",
      [receivers.map((r) => r.linkId)],
    )
  ).rows;
  const due = receivers
    .filter((r) => {
      const s = sources.find(
          (s) =>
            s.link_id === r.linkId &&
            Number(s.election_year) === r.electionYear,
        ),
        a = attempts.find(
          (a) =>
            a.link_id === r.linkId &&
            Number(a.election_year) === r.electionYear,
        );
      const clock = s ? Date.parse(String(s.source_observed_at)) : NaN,
        retry = a ? Date.parse(String(a.last_attempted_at)) : NaN;
      return (
        (input.refresh ||
          !s ||
          !isDeepStrictEqual(s.receiver_context, r) ||
          (s.source_facts as { revision?: string })?.revision !==
            CO_NATIVE_RECEIPTS_REVISION ||
          !Number.isFinite(clock) ||
          clock > now.getTime() ||
          clock < now.getTime() - stale * 86400000) &&
        (input.refresh ||
          !a ||
          !isDeepStrictEqual(a.receiver_context, r) ||
          a.source_revision !== CO_NATIVE_RECEIPTS_REVISION ||
          !Number.isFinite(retry) ||
          retry > now.getTime() ||
          retry <= now.getTime() - 86400000)
      );
    })
    .sort((a, b) => {
      const attempted = (linkId: string): number => {
        const value = attempts.find(
          (t) => t.link_id === linkId,
        )?.last_attempted_at;
        const date =
          value == null
            ? NaN
            : value instanceof Date
              ? value.getTime()
              : Date.parse(String(value));
        return Number.isFinite(date) ? date : Number.NEGATIVE_INFINITY;
      };
      return (
        attempted(a.linkId) - attempted(b.linkId) ||
        a.linkId.localeCompare(b.linkId)
      );
    });
  output.totalDueRows = due.length;
  output.selectedCandidates = Math.min(due.length, max);
  if (input.dryRun) return output;
  const registries = new Map<
    number,
    ReturnType<typeof getColoradoNativeReceiptRegistry>
  >();
  for (const receiver of due.slice(0, max)) {
    output.attemptedComponents++;
    try {
      await attempt(input.db, receiver);
      let registry = registries.get(receiver.electionYear);
      if (!registry) {
        registry = getColoradoNativeReceiptRegistry({
          electionYear: receiver.electionYear,
          cacheDir: input.cacheDir,
          refresh: input.refresh,
        });
        registries.set(receiver.electionYear, registry);
      }
      const packet = await getColoradoNativeReceiptsPacket({
        receiver,
        registry: await registry,
        cacheDir: input.cacheDir,
        refresh: input.refresh,
      });
      const written = await writeColoradoNativeReceipts({
        db: input.db,
        packet,
      });
      output.writtenComponents++;
      output.groups += written.groups;
      if (written.idempotent) output.idempotentComponents++;
    } catch (e) {
      output.heldComponents++;
      const code =
        e instanceof ColoradoReportError
          ? e.code
          : "native_receipt_storage_unavailable";
      output.holds[code] = (output.holds[code] ?? 0) + 1;
    }
  }
  return output;
}
async function attempt(
  db: ColoradoNativeReceiptBatchInput["db"],
  r: ColoradoIeReceiver,
) {
  const c = await db.connect();
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    await lockColoradoIeReceiver(c, r);
    await c.query(
      `INSERT INTO public.co_native_receipt_attempts(link_id,election_year,receiver_context,source_revision,last_attempted_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(link_id,election_year) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
      [
        r.linkId,
        r.electionYear,
        JSON.stringify(r),
        CO_NATIVE_RECEIPTS_REVISION,
        new Date().toISOString(),
      ],
    );
    await c.query("COMMIT");
    begun = false;
  } catch (e) {
    if (begun) await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
