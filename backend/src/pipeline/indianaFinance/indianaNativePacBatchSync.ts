import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { isIndianaNativePacEnabled } from "../../config/featureFlags.js";
import { inCheck, IndianaNativeSourceError } from "./indianaNativeProtocol.js";
import {
  IN_NATIVE_SELECT,
  IN_NATIVE_FROM,
  IN_NATIVE_WHERE,
  loadIndianaNativeReceiver,
  type IndianaNativeReceiver,
} from "./indianaNativeReceiver.js";
import {
  IndianaNativePacSource,
  IN_NATIVE_PAC_REVISION,
} from "./indianaNativePacSource.js";
import { writeIndianaNativePac } from "./indianaNativePacStore.js";

export type IndianaNativePacBatchInput = {
  db: Pick<Pool, "query" | "connect">;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  linkId?: string;
};
export async function listDueIndianaNativePac(
  input: IndianaNativePacBatchInput,
) {
  const now = input.now ?? new Date(),
    max = input.maxCandidates ?? 25,
    stale = input.staleAfterDays ?? 7,
    back = input.electionLookbackDays ?? 112,
    ahead = input.electionLookaheadDays ?? 730;
  inCheck(
    Number.isFinite(now.getTime()) &&
      [max, stale, back, ahead].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 100000,
      ) &&
      (!input.linkId ||
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.linkId)),
    "invalid_native_batch_options",
  );
  if (!isIndianaNativePacEnabled())
    return { totalDueRows: 0, rows: [] as IndianaNativeReceiver[] };
  const result = await input.db.query<{
    receiver: IndianaNativeReceiver;
    source: Record<string, unknown> | null;
    attempt: Record<string, unknown> | null;
  }>(
    `WITH receivers AS(SELECT ${IN_NATIVE_SELECT} ${IN_NATIVE_FROM} WHERE ${IN_NATIVE_WHERE} AND l.election_year>=2026)
 SELECT to_jsonb(r) receiver,to_jsonb(s) source,to_jsonb(a) attempt FROM receivers r
 LEFT JOIN public.in_native_pac_sources s ON s.link_id=r."linkId"::uuid AND s.election_year=r."electionYear"
 LEFT JOIN public.in_native_pac_attempts a ON a.link_id=r."linkId"::uuid AND a.election_year=r."electionYear"
 WHERE r."electionDate"::date BETWEEN (($1::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$2::int)) AND (($1::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$3::int))
 AND ($4::uuid IS NULL OR r."linkId"::uuid=$4::uuid)
 ORDER BY a.last_attempted_at ASC NULLS FIRST,r."electionDate",r."linkId" LIMIT 100001`,
    [now.toISOString(), back, ahead, input.linkId ?? null],
  );
  inCheck(
    result.rows.length <= 100000 &&
      new Set(result.rows.map((r) => r.receiver.linkId)).size ===
        result.rows.length,
    "incomplete_native_eligible_scope",
  );
  const due = result.rows
    .filter(({ receiver: r, source: s, attempt: a }) => {
      const observed = s ? Date.parse(String(s.source_observed_at)) : NaN,
        attempted = a ? Date.parse(String(a.last_attempted_at)) : NaN;
      const sourceDue =
        !s ||
        !isDeepStrictEqual(s.receiver_context, r) ||
        (s.source_facts as { revision?: string })?.revision !==
          IN_NATIVE_PAC_REVISION ||
        !Number.isFinite(observed) ||
        observed > now.getTime() ||
        observed < now.getTime() - stale * 86400000;
      const retryDue =
        !a ||
        !isDeepStrictEqual(a.receiver_context, r) ||
        a.source_revision !== IN_NATIVE_PAC_REVISION ||
        !Number.isFinite(attempted) ||
        attempted > now.getTime() ||
        attempted <= now.getTime() - 86400000;
      return sourceDue && retryDue;
    })
    .map((r) => r.receiver);
  return { totalDueRows: due.length, rows: due.slice(0, max) };
}
async function recordAttempt(
  db: IndianaNativePacBatchInput["db"],
  receiver: IndianaNativeReceiver,
) {
  const c = await db.connect();
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    const current = await loadIndianaNativeReceiver(c, receiver.linkId, true);
    inCheck(
      current && isDeepStrictEqual(current, receiver),
      "native_attempt_context_changed",
    );
    await c.query(
      `INSERT INTO public.in_native_pac_attempts(link_id,election_year,receiver_context,source_revision,last_attempted_at) VALUES($1,$2,$3::jsonb,$4,$5)
 ON CONFLICT(link_id,election_year) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
      [
        receiver.linkId,
        receiver.electionYear,
        JSON.stringify(receiver),
        IN_NATIVE_PAC_REVISION,
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
/** Runs before legacy direct acquisition; a malformed annual ZIP cannot suppress
 * independently qualified receiving-side PAC evidence. Failures retain money. */
export async function syncDueIndianaNativePac(
  input: IndianaNativePacBatchInput,
) {
  const output = {
    enabled: isIndianaNativePacEnabled(),
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
  const due = await listDueIndianaNativePac(input);
  output.totalDueRows = due.totalDueRows;
  output.selectedCandidates = due.rows.length;
  if (output.dryRun) return output;
  const source = new IndianaNativePacSource(),
    through = (input.now ?? new Date()).toISOString().slice(0, 10);
  for (const receiver of due.rows) {
    output.attemptedComponents++;
    try {
      await recordAttempt(input.db, receiver);
      const packet = await source.get(receiver, through),
        written = await writeIndianaNativePac({ db: input.db, packet });
      output.writtenComponents++;
      output.groups += written.groups;
      if (written.idempotent) output.idempotentComponents++;
    } catch (e) {
      output.heldComponents++;
      const code =
        e instanceof IndianaNativeSourceError
          ? e.code
          : "native_storage_unavailable";
      output.holds[code] = (output.holds[code] ?? 0) + 1;
    }
  }
  return output;
}
