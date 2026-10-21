import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isVirginiaReportedCommitteeEnabled,
  isVirginiaReportedIeEnabled,
  isVirginiaReportedRawRefreshEnabled,
} from "../../config/featureFlags.js";
import {
  VirginiaReportedSourceError,
  vaCheck,
} from "./virginiaReportedNative.js";
import {
  VA_REPORTED_FROM,
  VA_REPORTED_SELECT,
  VA_REPORTED_WHERE,
  VA_REPORTED_OFFICES,
  loadVirginiaReportedReceiver,
} from "./virginiaReportedEligibility.js";
import { VirginiaReportedSource } from "./virginiaReportedSource.js";
import { VirginiaOriginalArchive } from "./virginiaReportedOriginals.js";
import {
  VA_REPORTED_REVISION,
  writeVirginiaReportedComponent,
  type VirginiaReportedComponent,
} from "./virginiaReportedStore.js";
import type { VirginiaReportedReceiver } from "./virginiaReportedReceiver.js";

export type VirginiaReportedBatchInput = {
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
type DueRow = VirginiaReportedReceiver & {
  dueComponents: VirginiaReportedComponent[];
};
function options(input: VirginiaReportedBatchInput) {
  const now = input.now ?? new Date(),
    max = input.maxCandidates ?? 25,
    stale = input.staleAfterDays ?? 7,
    back = input.electionLookbackDays ?? 112,
    ahead = input.electionLookaheadDays ?? 730;
  vaCheck(
    Number.isFinite(now.getTime()) &&
      [max, stale, back, ahead].every(
        (n) => Number.isSafeInteger(n) && n >= 1 && n <= 100000,
      ),
    "invalid_batch_options",
  );
  return { now, max, stale, back, ahead };
}
export async function listDueVirginiaReportedFinance(
  input: VirginiaReportedBatchInput,
) {
  const { now, max, stale, back, ahead } = options(input),
    kinds: VirginiaReportedComponent[] = [];
  if (isVirginiaReportedCommitteeEnabled()) kinds.push("committee");
  if (isVirginiaReportedIeEnabled()) kinds.push("ie");
  if (!kinds.length) return { totalDueRows: 0, rows: [] as DueRow[] };
  const result = await input.db.query<DueRow>(
    `SELECT ${VA_REPORTED_SELECT},array_agg(kind.component ORDER BY kind.component) "dueComponents"
    ${VA_REPORTED_FROM} CROSS JOIN unnest($2::text[]) kind(component)
    LEFT JOIN public.va_reported_finance_components s ON s.link_id=l.id AND s.election_year=l.election_year AND s.component=kind.component
    LEFT JOIN public.va_reported_finance_attempts a ON a.link_id=l.id AND a.election_year=l.election_year AND a.component=kind.component
    WHERE ${VA_REPORTED_WHERE}
    AND e.election_date BETWEEN (($3::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$4::int))
      AND (($3::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$5::int))
    AND ($8::boolean OR s.link_id IS NULL OR s.source_observed_at<($3::timestamptz-make_interval(days=>$6::int)) OR s.source_observed_at>$3::timestamptz
      OR s.receiver_context<>jsonb_build_object('linkId',l.id::text,'candidateId',l.candidate_id::text,'electionId',l.election_id::text,
        'electionYear',l.election_year,'electionDate',e.election_date::text,'firstName',c.first_name,'lastName',c.last_name,'receivingId',l.committee_id,'legacyCommitteeName',l.committee_name,
        'candidateAliases',array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL),
        'officeScope',o.scope,'officeName',o.canonical_name,'linkOfficeName',l.office_name,'district',l.district,
        'canonicalDistrictName',d.name,'canonicalDistrictType',d.district_type,'activeCandidateOwnerCount',
        (SELECT count(DISTINCT owner.candidate_id)::int FROM public.va_candidate_finance_links owner WHERE owner.committee_id=l.committee_id AND owner.link_status='active'))
      OR s.source_facts->>'revision' IS DISTINCT FROM $7)
    AND ($8::boolean OR a.link_id IS NULL OR a.last_attempted_at<=($3::timestamptz-interval '24 hours') OR a.last_attempted_at>$3::timestamptz
      OR a.source_revision<>$7 OR a.receiver_context->>'receivingId'<>l.committee_id)
    GROUP BY l.id,c.id,ce.candidate_id,ce.election_id,e.id,d.id,o.id
    ORDER BY min(a.last_attempted_at) ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,
    [
      VA_REPORTED_OFFICES,
      kinds,
      now.toISOString(),
      back,
      ahead,
      stale,
      VA_REPORTED_REVISION,
      input.forceRawDataRefresh === true,
    ],
  );
  vaCheck(
    result.rows.length <= 100000 &&
      new Set(result.rows.map((r) => r.linkId)).size === result.rows.length,
    "incomplete_eligible_scope",
  );
  return { totalDueRows: result.rows.length, rows: result.rows.slice(0, max) };
}
async function attempt(
  db: VirginiaReportedBatchInput["db"],
  expected: VirginiaReportedReceiver,
  component: VirginiaReportedComponent,
) {
  const client = await db.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const current = await loadVirginiaReportedReceiver(
      client,
      expected.linkId,
      true,
    );
    vaCheck(
      current && isDeepStrictEqual(current, expected),
      "canonical_receiving_context_changed",
    );
    await client.query(
      `INSERT INTO public.va_reported_finance_attempts(link_id,election_year,component,receiver_context,source_revision,last_attempted_at)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(link_id,election_year,component) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,
      source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
      [
        expected.linkId,
        expected.electionYear,
        component,
        JSON.stringify(expected),
        VA_REPORTED_REVISION,
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
export async function syncDueVirginiaReportedFinance(
  input: VirginiaReportedBatchInput,
) {
  const output = {
    enabled:
      isVirginiaReportedCommitteeEnabled() || isVirginiaReportedIeEnabled(),
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
  const due = await listDueVirginiaReportedFinance(input);
  output.totalDueRows = due.totalDueRows;
  output.selectedCandidates = due.rows.length;
  if (output.dryRun) return output;
  const source = new VirginiaReportedSource(
    new VirginiaOriginalArchive(input.cacheDir),
    input.forceRawDataRefresh ?? isVirginiaReportedRawRefreshEnabled(),
  );
  for (const row of due.rows) {
    const { dueComponents, ...receiver } = row;
    for (const component of dueComponents) {
      output.attemptedComponents++;
      try {
        await attempt(input.db, receiver, component);
        const packet = await source.get(receiver, component);
        const result = await writeVirginiaReportedComponent({
          db: input.db,
          receiver,
          packet,
        });
        output.writtenComponents++;
        output.groups += result.groups;
        if (result.idempotent) output.idempotentComponents++;
      } catch (e) {
        output.heldComponents++;
        const code =
          e instanceof VirginiaReportedSourceError
            ? e.code
            : "storage_unavailable";
        output.holds[code] = (output.holds[code] ?? 0) + 1;
      }
    }
  }
  return output;
}
