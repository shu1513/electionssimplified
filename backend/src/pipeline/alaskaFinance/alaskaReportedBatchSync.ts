import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isAlaskaReportedCommitteeEnabled,
  isAlaskaReportedIeEnabled,
} from "../../config/featureFlags.js";
import { AlaskaReportedSourceError, akCheck } from "./alaskaReportedNative.js";
import {
  AK_REPORTED_FROM,
  AK_REPORTED_SELECT,
  AK_REPORTED_WHERE,
  AK_REPORTED_OFFICES,
  loadAlaskaReportedReceiver,
} from "./alaskaReportedEligibility.js";
import { AlaskaReportedSource } from "./alaskaReportedSource.js";
import { AlaskaOriginalArchive } from "./alaskaReportedOriginals.js";
import {
  AK_REPORTED_REVISION,
  writeAlaskaReportedComponent,
  type AlaskaReportedComponent,
} from "./alaskaReportedStore.js";
import type { AlaskaReportedReceiver } from "./alaskaReportedReceiver.js";

export type AlaskaReportedBatchInput = {
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
type DueRow = AlaskaReportedReceiver & {
  dueComponents: AlaskaReportedComponent[];
};
function options(input: AlaskaReportedBatchInput) {
  const now = input.now ?? new Date(),
    max = input.maxCandidates ?? 25,
    stale = input.staleAfterDays ?? 7,
    back = input.electionLookbackDays ?? 112,
    ahead = input.electionLookaheadDays ?? 730;
  akCheck(
    Number.isFinite(now.getTime()) &&
      [max, stale, back, ahead].every(
        (n) => Number.isSafeInteger(n) && n >= 1 && n <= 100000,
      ),
    "invalid_batch_options",
  );
  return { now, max, stale, back, ahead };
}
export async function listDueAlaskaReportedFinance(
  input: AlaskaReportedBatchInput,
) {
  const { now, max, stale, back, ahead } = options(input),
    kinds: AlaskaReportedComponent[] = [];
  if (isAlaskaReportedCommitteeEnabled()) kinds.push("committee");
  if (isAlaskaReportedIeEnabled()) kinds.push("ie");
  if (!kinds.length) return { totalDueRows: 0, rows: [] as DueRow[] };
  const result = await input.db.query<DueRow>(
    `SELECT ${AK_REPORTED_SELECT},array_agg(kind.component ORDER BY kind.component) "dueComponents"
    ${AK_REPORTED_FROM} CROSS JOIN unnest($2::text[]) kind(component)
    LEFT JOIN public.ak_reported_finance_components s ON s.link_id=l.id AND s.election_year=l.election_year AND s.component=kind.component
    LEFT JOIN public.ak_reported_finance_attempts a ON a.link_id=l.id AND a.election_year=l.election_year AND a.component=kind.component
    WHERE ${AK_REPORTED_WHERE}
    AND e.election_date BETWEEN (($3::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$4::int))
      AND (($3::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$5::int))
    AND ($8::boolean OR s.link_id IS NULL OR s.source_observed_at<($3::timestamptz-make_interval(days=>$6::int)) OR s.source_observed_at>$3::timestamptz
      OR s.receiver_context<>jsonb_build_object('linkId',l.id::text,'candidateId',l.candidate_id::text,'electionId',l.election_id::text,
        'electionYear',l.election_year,'electionDate',e.election_date::text,'firstName',c.first_name,'lastName',c.last_name,'receivingId',l.candidate_filer_id,'legacyCommitteeName',l.candidate_filer_name,
        'candidateAliases',array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL),
        'officeScope',o.scope,'officeName',o.canonical_name,'linkOfficeName',l.office_name,'district',l.district,
        'canonicalDistrictName',d.name,'canonicalDistrictType',d.district_type,'activeCandidateOwnerCount',
        (SELECT count(DISTINCT owner.candidate_id)::int FROM public.ak_candidate_finance_links owner WHERE owner.candidate_filer_id=l.candidate_filer_id AND owner.link_status='active'))
      OR s.source_facts->>'revision' IS DISTINCT FROM $7)
    AND ($8::boolean OR a.link_id IS NULL OR a.last_attempted_at<=($3::timestamptz-interval '24 hours') OR a.last_attempted_at>$3::timestamptz
      OR a.source_revision<>$7 OR a.receiver_context->>'receivingId'<>l.candidate_filer_id)
    GROUP BY l.id,c.id,ce.candidate_id,ce.election_id,e.id,d.id,o.id
    ORDER BY min(a.last_attempted_at) ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,
    [
      AK_REPORTED_OFFICES,
      kinds,
      now.toISOString(),
      back,
      ahead,
      stale,
      AK_REPORTED_REVISION,
      input.forceRawDataRefresh === true,
    ],
  );
  akCheck(
    result.rows.length <= 100000 &&
      new Set(result.rows.map((r) => r.linkId)).size === result.rows.length,
    "incomplete_eligible_scope",
  );
  return { totalDueRows: result.rows.length, rows: result.rows.slice(0, max) };
}
async function attempt(
  db: AlaskaReportedBatchInput["db"],
  expected: AlaskaReportedReceiver,
  component: AlaskaReportedComponent,
) {
  const client = await db.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const current = await loadAlaskaReportedReceiver(
      client,
      expected.linkId,
      true,
    );
    akCheck(
      current && isDeepStrictEqual(current, expected),
      "canonical_receiving_context_changed",
    );
    await client.query(
      `INSERT INTO public.ak_reported_finance_attempts(link_id,election_year,component,receiver_context,source_revision,last_attempted_at)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(link_id,election_year,component) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,
      source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
      [
        expected.linkId,
        expected.electionYear,
        component,
        JSON.stringify(expected),
        AK_REPORTED_REVISION,
        new Date().toISOString(),
      ],
    );
    await client.query("COMMIT");
    begun = false;
  } catch (e) {
    if (begun) await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
/** Independent attempts and transactions let either native component progress
 * when annual direct data or the other native component is unavailable. */
export async function syncDueAlaskaReportedFinance(
  input: AlaskaReportedBatchInput,
) {
  const output = {
    enabled: isAlaskaReportedCommitteeEnabled() || isAlaskaReportedIeEnabled(),
    dryRun: input.dryRun === true,
    totalDueRows: 0,
    selectedCandidates: 0,
    attemptedComponents: 0,
    writtenComponents: 0,
    idempotentComponents: 0,
    heldComponents: 0,
    groups: 0,
    holds: {} as Record<string, number>,
    failure: null as string | null,
  };
  if (!output.enabled) return output;
  let due: Awaited<ReturnType<typeof listDueAlaskaReportedFinance>>;
  try {
    due = await listDueAlaskaReportedFinance(input);
  } catch (error) {
    // A failed native due query must not stop the legacy acquisition that follows.
    output.failure = error instanceof Error ? error.message : String(error);
    return output;
  }
  output.totalDueRows = due.totalDueRows;
  output.selectedCandidates = due.rows.length;
  if (output.dryRun) return output;
  const source = new AlaskaReportedSource(
    new AlaskaOriginalArchive(input.cacheDir),
    input.forceRawDataRefresh,
  );
  for (const row of due.rows) {
    const { dueComponents, ...receiver } = row;
    for (const component of dueComponents) {
      output.attemptedComponents++;
      try {
        await attempt(input.db, receiver, component);
        const packet = await source.get(receiver, component);
        const result = await writeAlaskaReportedComponent({
          db: input.db,
          receiver,
          packet,
        });
        output.writtenComponents++;
        output.groups += result.groups;
        if (result.idempotent) output.idempotentComponents++;
      } catch (e) {
        output.heldComponents++;
        if (!(e instanceof AlaskaReportedSourceError))
          console.warn("Alaska reported finance component held:", {
            linkId: receiver.linkId,
            component,
            error: e instanceof Error ? e.message : String(e),
          });
        const code =
          e instanceof AlaskaReportedSourceError
            ? e.code
            : "storage_unavailable";
        output.holds[code] = (output.holds[code] ?? 0) + 1;
      }
    }
  }
  return output;
}
