import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  isNewMexicoReportedCommitteeEnabled,
  isNewMexicoReportedIeEnabled,
} from "../../config/featureFlags.js";
import {
  NewMexicoReportedSourceError,
  nmCheck,
} from "./newMexicoReportedNative.js";
import {
  NM_REPORTED_FROM,
  NM_REPORTED_SELECT,
  NM_REPORTED_WHERE,
  NM_REPORTED_OFFICES,
  loadNewMexicoReportedReceiver,
} from "./newMexicoReportedEligibility.js";
import { qualifyNewMexicoReportedContext } from "./newMexicoReportedAggregation.js";
import type { NewMexicoReportedScope } from "./newMexicoReportedOriginals.js";
import { getNewMexicoReportedSource } from "./newMexicoReportedSource.js";
import {
  NM_REPORTED_REVISION,
  writeNewMexicoReportedComponent,
  type NewMexicoReportedComponent,
} from "./newMexicoReportedStore.js";
import {
  qualifyNewMexicoReportedReceiver,
  type NewMexicoReportedReceiver,
} from "./newMexicoReportedReceiver.js";

export type NewMexicoReportedBatchInput = {
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
type DueRow = NewMexicoReportedReceiver & {
  dueComponents: NewMexicoReportedComponent[];
};
function options(input: NewMexicoReportedBatchInput) {
  const now = input.now ?? new Date(),
    max = input.maxCandidates ?? 25,
    stale = input.staleAfterDays ?? 7,
    back = input.electionLookbackDays ?? 98,
    ahead = input.electionLookaheadDays ?? 730;
  nmCheck(
    Number.isFinite(now.getTime()) &&
      [max, stale, back, ahead].every(
        (n) => Number.isSafeInteger(n) && n >= 1 && n <= 100000,
      ),
    "invalid_batch_options",
  );
  return { now, max, stale, back, ahead };
}
export async function listDueNewMexicoReportedFinance(
  input: NewMexicoReportedBatchInput,
) {
  const { now, max, stale, back, ahead } = options(input),
    kinds: NewMexicoReportedComponent[] = [];
  if (isNewMexicoReportedCommitteeEnabled()) kinds.push("committee");
  if (isNewMexicoReportedIeEnabled()) kinds.push("ie");
  if (!kinds.length) return { totalDueRows: 0, rows: [] as DueRow[] };
  const result = await input.db.query<DueRow>(
    `SELECT ${NM_REPORTED_SELECT},array_agg(kind.component ORDER BY kind.component) "dueComponents"
    ${NM_REPORTED_FROM} CROSS JOIN unnest($2::text[]) kind(component)
    LEFT JOIN public.nm_reported_finance_components s ON s.link_id=l.id AND s.election_year=l.election_year AND s.component=kind.component
    LEFT JOIN public.nm_reported_finance_attempts a ON a.link_id=l.id AND a.election_year=l.election_year AND a.component=kind.component
    WHERE ${NM_REPORTED_WHERE}
    AND e.election_date BETWEEN (($3::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$4::int))
      AND (($3::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$5::int))
    AND ($8::boolean OR s.link_id IS NULL OR s.source_observed_at<($3::timestamptz-make_interval(days=>$6::int)) OR s.source_observed_at>$3::timestamptz
      OR s.receiver_context<>jsonb_build_object('linkId',l.id::text,'candidateId',l.candidate_id::text,'electionId',l.election_id::text,
        'electionYear',l.election_year,'electionDate',e.election_date::text,'receivingId',l.committee_id,'legacyCommitteeName',l.committee_name,
        'candidateAliases',array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL),
        'officeScope',o.scope,'officeName',o.canonical_name,'linkOfficeName',l.office_name,'district',l.district,
        'canonicalDistrictName',d.name,'canonicalDistrictType',d.district_type,'activeCandidateOwnerCount',
        (SELECT count(DISTINCT owner.candidate_id)::int FROM public.nm_candidate_finance_links owner WHERE owner.committee_id=l.committee_id AND owner.link_status='active'))
      OR s.source_facts->>'revision' IS DISTINCT FROM $7)
    AND ($8::boolean OR a.link_id IS NULL OR a.last_attempted_at<=($3::timestamptz-interval '24 hours') OR a.last_attempted_at>$3::timestamptz
      OR a.source_revision<>$7 OR a.receiver_context->>'receivingId'<>l.committee_id)
    GROUP BY l.id,c.id,ce.candidate_id,ce.election_id,e.id,d.id,o.id
    ORDER BY min(a.last_attempted_at) ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,
    [
      NM_REPORTED_OFFICES,
      kinds,
      now.toISOString(),
      back,
      ahead,
      stale,
      NM_REPORTED_REVISION,
      input.forceRawDataRefresh === true,
    ],
  );
  nmCheck(
    result.rows.length <= 100000 &&
      new Set(result.rows.map((r) => r.linkId)).size === result.rows.length,
    "incomplete_eligible_scope",
  );
  return { totalDueRows: result.rows.length, rows: result.rows.slice(0, max) };
}
async function attempt(
  db: NewMexicoReportedBatchInput["db"],
  expected: NewMexicoReportedReceiver,
  component: NewMexicoReportedComponent,
) {
  const client = await db.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const current = await loadNewMexicoReportedReceiver(
      client,
      expected.linkId,
      true,
    );
    nmCheck(
      current && isDeepStrictEqual(current, expected),
      "canonical_receiving_context_changed",
    );
    await client.query(
      `INSERT INTO public.nm_reported_finance_attempts(link_id,election_year,component,receiver_context,source_revision,last_attempted_at)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(link_id,election_year,component) DO UPDATE SET receiver_context=EXCLUDED.receiver_context,
      source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
      [
        expected.linkId,
        expected.electionYear,
        component,
        JSON.stringify(expected),
        NM_REPORTED_REVISION,
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
export async function syncDueNewMexicoReportedFinance(
  input: NewMexicoReportedBatchInput,
) {
  const output = {
    enabled:
      isNewMexicoReportedCommitteeEnabled() || isNewMexicoReportedIeEnabled(),
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
  const due = await listDueNewMexicoReportedFinance(input);
  output.totalDueRows = due.totalDueRows;
  output.selectedCandidates = due.rows.length;
  if (output.dryRun) return output;
  const packets = new Map<
    string,
    ReturnType<typeof getNewMexicoReportedSource>
  >();
  const source = (scope: NewMexicoReportedScope) => {
    const key = JSON.stringify(scope);
    let promise = packets.get(key);
    if (!promise) {
      promise = getNewMexicoReportedSource({
        scope,
        cacheDir: input.cacheDir,
        refresh: input.forceRawDataRefresh,
      });
      packets.set(key, promise);
    }
    return promise;
  };
  for (const row of due.rows) {
    const { dueComponents, ...receiver } = row;
    for (const component of [...dueComponents].sort((a, b) =>
      a === b ? 0 : a === "ie" ? -1 : 1,
    )) {
      output.attemptedComponents++;
      try {
        await attempt(input.db, receiver, component);
        const registry = await source({
          kind: "registry",
          year: receiver.electionYear,
          selector: null,
        });
        nmCheck(registry.registrations, "registry_population");
        const registration = qualifyNewMexicoReportedReceiver(
          receiver,
          registry.registrations,
        );
        const identity = await source({
          kind: "receiver",
          year: receiver.electionYear,
          selector: registration.locator,
        });
        nmCheck(identity.receiver, "receiver_population");
        const context = qualifyNewMexicoReportedContext(
          receiver,
          registry.registrations,
          identity.receiver,
        );
        const financial = await source(
          component === "ie"
            ? { kind: "ie", year: receiver.electionYear, selector: null }
            : {
                kind: "committee",
                year: receiver.electionYear,
                selector: context.detail.candidateName,
                memberId: context.detail.memberId,
              },
        );
        const result = await writeNewMexicoReportedComponent({
          db: input.db,
          receiver,
          component,
          registry,
          identity,
          financial,
        });
        output.writtenComponents++;
        output.groups += result.groups;
        if (result.idempotent) output.idempotentComponents++;
      } catch (e) {
        output.heldComponents++;
        const code =
          e instanceof NewMexicoReportedSourceError
            ? e.code
            : "storage_unavailable";
        output.holds[code] = (output.holds[code] ?? 0) + 1;
      }
    }
  }
  return output;
}
