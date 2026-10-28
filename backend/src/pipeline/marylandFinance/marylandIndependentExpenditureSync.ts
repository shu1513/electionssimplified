import type { Pool, PoolClient } from "pg";
import { isMarylandCampaignFinanceSyncEnabled } from "../../config/featureFlags.js";
import { loadMarylandIndependentOutsideSource } from "./marylandIndependentOutsideSource.js";
import { replaceMarylandIndependentOutsideSnapshot } from "./marylandIndependentOutsideWriter.js";
import {
  marylandOutsideGuid,
  type MarylandOutsideCanonical,
} from "./marylandIndependentOutsideQualification.js";
import type { MarylandNativeOutsideObservationResult } from "./marylandNativeOutsideObservationLoader.js";
type DB = Pick<Pool | PoolClient, "query"> & Pick<Pool, "connect">;
type Due = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  party: string;
  office_scope: string;
  office_name: string;
  geoid_compact: string;
  election_date: string;
  election_year: number;
  native_directory: string | null;
  target_account_guids: string[] | null;
};
export type MarylandIndependentExpenditureSyncResult = {
  attempted: number;
  qualified: number;
  written: number;
  preserved: number;
  groupsWritten: number;
  allocationsQualified: number;
  sourceCaptures: number;
  savedOpeningQueries: number;
  diagnostics: string[];
  results: {
    dueIndex: number;
    status: "ready" | "written" | "preserve";
    diagnostics: string[];
  }[];
  observation?: MarylandNativeOutsideObservationResult;
};
export async function syncMarylandIndependentExpenditures(input: {
  db: DB;
  rawCacheDir: string;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  candidateId?: string;
  electionYear?: number;
  dryRun?: boolean;
  refresh?: boolean;
  force?: boolean;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  loadSourceFn?: typeof loadMarylandIndependentOutsideSource;
  writeSnapshotFn?: typeof replaceMarylandIndependentOutsideSnapshot;
}): Promise<MarylandIndependentExpenditureSyncResult> {
  const result: MarylandIndependentExpenditureSyncResult = {
    attempted: 0,
    qualified: 0,
    written: 0,
    preserved: 0,
    groupsWritten: 0,
    allocationsQualified: 0,
    sourceCaptures: 0,
    savedOpeningQueries: 0,
    diagnostics: [],
    results: [],
  };
  if (!isMarylandCampaignFinanceSyncEnabled(input.force)) {
    result.diagnostics = ["outside_disabled"];
    return result;
  }
  const now = new Date(input.now?.getTime() ?? Date.now()),
    max = input.maxCandidates ?? 20,
    stale = input.staleAfterDays ?? 7;
  const back = input.electionLookbackDays ?? 90,
    ahead = input.electionLookaheadDays ?? 730;
  if (
    !Number.isFinite(now.getTime()) ||
    [max, stale, back, ahead].some((v) => !Number.isInteger(v) || v < 0) ||
    max < 1 ||
    stale < 1
  )
    throw Error("invalid_maryland_outside_sync_scope");
  if (input.candidateId) marylandOutsideGuid(input.candidateId);
  if (
    input.electionYear !== undefined &&
    (!Number.isInteger(input.electionYear) ||
      input.electionYear < 2000 ||
      input.electionYear > 2100)
  )
    throw Error("invalid_maryland_outside_sync_scope");
  let rows: Due[];
  try {
    const due = await input.db.query<Due>(
      `WITH milestone AS (
      SELECT max(day) AS day FROM unnest(ARRAY[DATE '2026-10-24',DATE '2026-10-26',DATE '2026-11-18',
        DATE '2026-11-20',DATE '2027-01-28',DATE '2027-01-29']) AS dates(day)
      WHERE day<=($1::timestamptz AT TIME ZONE 'America/New_York')::date
    ) SELECT c.id::text AS candidate_id,e.id::text AS election_id,c.display_name AS candidate_name,c.party,
        o.scope AS office_scope,o.canonical_name AS office_name,d.geoid_compact,e.election_date::text,
        EXTRACT(YEAR FROM e.election_date)::integer AS election_year,s.native_directory,s.target_account_guids
      FROM public.candidate_elections ce JOIN public.candidates c ON c.id=ce.candidate_id
      JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id
      JOIN public.offices o ON o.id=e.office_id
      LEFT JOIN public.md_candidate_finance_ie_sources s ON s.candidate_id=c.id AND s.election_id=e.id
      LEFT JOIN public.md_candidate_finance_ie_attempts a ON a.candidate_id=c.id AND a.election_id=e.id CROSS JOIN milestone m
      WHERE d.state='MD' AND c.deleted_at IS NULL AND c.merged_into_candidate_id IS NULL
        AND ce.status NOT IN ('withdrawn','lost') AND e.race_type='office' AND e.election_stage='general'
        AND e.election_date=DATE '2026-11-03' AND (o.scope||'::'||o.canonical_name) IN
          ('state_upper::State Senator','state_lower::State Lower Chamber Legislator')
        AND e.election_date BETWEEN ($1::timestamptz)::date-$4::integer AND ($1::timestamptz)::date+$5::integer
        AND ($6::uuid IS NULL OR c.id=$6::uuid) AND ($7::integer IS NULL OR EXTRACT(YEAR FROM e.election_date)::integer=$7)
        AND ($8::boolean OR ((s.candidate_id IS NULL OR s.source_observed_at<$1::timestamptz-make_interval(days=>$3::integer)
          OR (s.source_observed_at AT TIME ZONE 'America/New_York')::date<m.day
          OR s.canonical_context->>'candidateName' IS DISTINCT FROM c.display_name
          OR s.canonical_context->>'party' IS DISTINCT FROM c.party
          OR s.canonical_context->>'officeName' IS DISTINCT FROM o.canonical_name
          OR s.canonical_context->>'districtGeoidCompact' IS DISTINCT FROM d.geoid_compact)
          AND (a.candidate_id IS NULL OR a.last_attempted_at<$1::timestamptz-interval '1 day'
            OR (a.last_attempted_at AT TIME ZONE 'America/New_York')::date<m.day)))
      ORDER BY a.last_attempted_at ASC NULLS FIRST,s.source_observed_at ASC NULLS FIRST,c.id,e.id LIMIT $2`,
      [
        now.toISOString(),
        max,
        stale,
        back,
        ahead,
        input.candidateId ?? null,
        input.electionYear ?? null,
        // force only lifts the recurring-sync flag; refresh widens the due set.
        input.refresh === true,
      ],
    );
    rows = due.rows;
  } catch {
    result.diagnostics = ["outside_store_or_due_query_unavailable"];
    return result;
  }
  const contexts: MarylandOutsideCanonical[] = [],
    previousSources = new Map<
      string,
      { nativeDirectory: string; targetAccountGuids: readonly string[] }
    >();
  for (const r of rows) {
    marylandOutsideGuid(r.candidate_id);
    marylandOutsideGuid(r.election_id);
    contexts.push({
      candidateId: r.candidate_id,
      electionId: r.election_id,
      candidateName: r.candidate_name,
      party: r.party,
      officeScope: r.office_scope,
      officeName: r.office_name,
      districtGeoidCompact: r.geoid_compact,
      electionYear: r.election_year,
      electionDate: r.election_date,
      electionStage: "general",
    });
    if (r.native_directory) {
      if (!r.target_account_guids?.length)
        throw Error("maryland_outside_retained_scope_missing");
      previousSources.set(`${r.candidate_id}:${r.election_id}`, {
        nativeDirectory: r.native_directory,
        targetAccountGuids: r.target_account_guids,
      });
    }
  }
  result.attempted = contexts.length;
  if (!contexts.length) return result;
  const loaded = await (
    input.loadSourceFn ?? loadMarylandIndependentOutsideSource
  )({
    contexts,
    previousSources,
    rawCacheDir: input.rawCacheDir,
    refresh: input.refresh,
    fetchImpl: input.fetchImpl,
    log: input.log,
  });
  result.observation = loaded.observation;
  result.sourceCaptures = loaded.captures;
  result.savedOpeningQueries = loaded.savedOpeningQueries;
  for (const [dueIndex, context] of contexts.entries()) {
    const snapshots = loaded.snapshots.filter(
      (s) =>
        s.context.candidateId === context.candidateId &&
        s.context.electionId === context.electionId,
    );
    let diagnostics = loaded.results.find((r) => r.dueIndex === dueIndex)
      ?.diagnostics ?? ["outside_source_unavailable"];
    let status: "ready" | "written" | "preserve" = "preserve";
    if (snapshots.length === 1 && !diagnostics.length)
      try {
        result.qualified++;
        result.allocationsQualified += snapshots[0]!.allocationCount;
        if (input.dryRun) status = "ready";
        else {
          const written = await (
            input.writeSnapshotFn ?? replaceMarylandIndependentOutsideSnapshot
          )({ db: input.db, snapshot: snapshots[0]! });
          result.written++;
          result.groupsWritten += written.groupsWritten;
          status = "written";
        }
      } catch {
        diagnostics = ["outside_snapshot_not_written"];
      }
    if (status === "preserve") result.preserved++;
    result.results.push({ dueIndex, status, diagnostics });
    if (!input.dryRun)
      await input.db.query(
        `INSERT INTO public.md_candidate_finance_ie_attempts
      (candidate_id,election_id,last_attempted_at,diagnostic) VALUES($1::uuid,$2::uuid,$3::timestamptz,$4)
      ON CONFLICT(candidate_id,election_id) DO UPDATE SET last_attempted_at=EXCLUDED.last_attempted_at,diagnostic=EXCLUDED.diagnostic`,
        [
          context.candidateId,
          context.electionId,
          new Date().toISOString(),
          diagnostics[0] ?? status,
        ],
      );
  }
  return result;
}
