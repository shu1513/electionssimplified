import type { Pool } from "pg";
import { isDeepStrictEqual as eq } from "node:util";
import { isDcReportedCommitteeEnabled } from "../../config/featureFlags.js";
import {
  DC_COMMITTEE_REVISION,
  DcCommitteeSourceError,
  dcCheck,
} from "./dcCommitteeNative.js";
import {
  DC_COMMITTEE_SELECT,
  DC_COMMITTEE_FROM,
  DC_COMMITTEE_WHERE,
  DC_COMMITTEE_OFFICES,
  loadDcCommitteeReceiver,
  type DcCommitteeReceiver,
} from "./dcCommitteeReceiver.js";
import { getDcCommitteeSource } from "./dcCommitteeSource.js";
import { writeDcCommitteeComponent } from "./dcCommitteeStore.js";

export type DcCommitteeBatchInput = {
  db: Pick<Pool, "query" | "connect">;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  cacheDir?: string;
  forceRawDataRefresh?: boolean;
};
export async function listDueDcCommitteeFinance(input: DcCommitteeBatchInput) {
  const now = input.now ?? new Date(),
    max = input.maxCandidates ?? 25,
    stale = input.staleAfterDays ?? 7,
    back = input.electionLookbackDays ?? 98,
    ahead = input.electionLookaheadDays ?? 730;
  dcCheck(
    Number.isFinite(now.getTime()) &&
      [max, stale, back, ahead].every(
        (v) => Number.isSafeInteger(v) && v > 0 && v <= 100000,
      ),
    "invalid_batch_options",
  );
  if (!isDcReportedCommitteeEnabled())
    return { totalDueRows: 0, rows: [] as DcCommitteeReceiver[] };
  const result = await input.db.query<DcCommitteeReceiver>(
    `WITH receivers AS(SELECT ${DC_COMMITTEE_SELECT} ${DC_COMMITTEE_FROM} WHERE ${DC_COMMITTEE_WHERE})
    SELECT r.* FROM receivers r LEFT JOIN public.dc_committee_finance_components s ON s.link_id=r."linkId"::uuid AND s.election_year=r."electionYear"
    LEFT JOIN public.dc_committee_finance_attempts a ON a.link_id=r."linkId"::uuid AND a.election_year=r."electionYear"
    WHERE r."electionDate"::date BETWEEN (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int)) AND (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    AND ($7::boolean OR s.link_id IS NULL OR s.source_observed_at<($2::timestamptz-make_interval(days=>$5::int)) OR s.source_observed_at>$2::timestamptz OR s.receiver_context IS DISTINCT FROM to_jsonb(r) OR s.source_revision<>$6)
    AND ($7::boolean OR a.link_id IS NULL OR a.last_attempted_at<=($2::timestamptz-interval '24 hours') OR a.last_attempted_at>$2::timestamptz OR a.source_revision<>$6 OR a.receiver_context IS DISTINCT FROM to_jsonb(r))
    ORDER BY a.last_attempted_at ASC NULLS FIRST,r."electionDate",r."candidateAliases",r."linkId" LIMIT 100001`,
    [
      DC_COMMITTEE_OFFICES,
      now.toISOString(),
      back,
      ahead,
      stale,
      DC_COMMITTEE_REVISION,
      input.forceRawDataRefresh === true,
    ],
  );
  dcCheck(
    result.rows.length <= 100000 &&
      new Set(result.rows.map((r) => r.linkId)).size === result.rows.length,
    "incomplete_eligible_scope",
  );
  return { totalDueRows: result.rows.length, rows: result.rows.slice(0, max) };
}
async function attempt(
  db: DcCommitteeBatchInput["db"],
  receiver: DcCommitteeReceiver,
) {
  const c = await db.connect();
  let begun = false;
  try {
    await c.query("BEGIN");
    begun = true;
    dcCheck(
      eq(await loadDcCommitteeReceiver(c, receiver.linkId, true), receiver),
      "canonical_receiving_context_changed",
    );
    await c.query(
      `INSERT INTO public.dc_committee_finance_attempts(link_id,election_year,receiver_context,source_revision,last_attempted_at) VALUES($1,$2,$3::jsonb,$4,$5)
      ON CONFLICT(link_id,election_year) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
      [
        receiver.linkId,
        receiver.electionYear,
        JSON.stringify(receiver),
        DC_COMMITTEE_REVISION,
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
/** Independent from legacy direct, Fair Elections, IEC and classifier calls. */
export async function syncDueDcCommitteeFinance(input: DcCommitteeBatchInput) {
  const out = {
    enabled: isDcReportedCommitteeEnabled(),
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
  if (!out.enabled) return out;
  const due = await listDueDcCommitteeFinance(input);
  out.totalDueRows = due.totalDueRows;
  out.selectedCandidates = due.rows.length;
  if (out.dryRun) return out;
  const packets = new Map<number, ReturnType<typeof getDcCommitteeSource>>();
  for (const receiver of due.rows) {
    out.attemptedComponents++;
    try {
      await attempt(input.db, receiver);
      let packet = packets.get(receiver.electionYear);
      if (!packet) {
        packet = getDcCommitteeSource({
          year: receiver.electionYear,
          cacheDir: input.cacheDir,
          refresh: input.forceRawDataRefresh,
        });
        packets.set(receiver.electionYear, packet);
      }
      const result = await writeDcCommitteeComponent({
        db: input.db,
        receiver,
        source: await packet,
      });
      out.writtenComponents++;
      out.groups += result.groups;
      if (result.idempotent) out.idempotentComponents++;
    } catch (e) {
      out.heldComponents++;
      const code =
        e instanceof DcCommitteeSourceError ? e.code : "storage_unavailable";
      out.holds[code] = (out.holds[code] ?? 0) + 1;
    }
  }
  return out;
}
