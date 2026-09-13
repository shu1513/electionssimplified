import type { Pool, PoolClient } from "pg";

import { NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN } from "../../contracts/candidateProfilePayloadContract.js";
import { listMissingGeneralElections } from "../../scripts/listMissingGeneralElections.js";
import { usLatestLocalDateIso } from "../../utils/usLocalDate.js";
import type { AddressResolvedDistrict } from "./addressDistrictLookup.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// Stage vocabulary matches manual_research_deferrals where the stages overlap
// so one word means one research unit across both ledgers.
export type ManualResearchDemandStage =
  | "candidate_roster"
  | "candidate_profile"
  | "candidate_records"
  | "ballot_measure"
  | "election_results"
  | "missing_general";

export const MANUAL_RESEARCH_DEMAND_STAGES: readonly ManualResearchDemandStage[] = [
  "candidate_roster",
  "candidate_profile",
  "candidate_records",
  "ballot_measure",
  "election_results",
  "missing_general",
];

export type ManualResearchDemandTriggerSource = "address_resolve" | "me_address_update";

/** Default window on each side of today that a gap counts as demand-worthy. */
export const DEFAULT_MANUAL_RESEARCH_DEMAND_HORIZON_DAYS = 365;

export type ResearchGap = {
  stage: ManualResearchDemandStage;
  target_id: string;
  district_id: string;
  election_id: string | null;
  state: string;
  label: string;
  election_date: string | null;
};

export type ManualResearchDemandRow = ResearchGap & {
  request_count: number;
  first_requested_at: string;
  last_requested_at: string;
  last_trigger_source: string;
};

export type RecordManualResearchDemandResult = {
  checked_districts: number;
  gaps: number;
  recorded: number;
  bumped: number;
  failed: number;
};

type GapQueryInput = {
  districtIds: readonly string[];
  asOfDate: string;
  horizonDays: number;
};

const GAP_SELECT_COLUMNS = `
  e.district_id::text AS district_id,
  e.id::text AS election_id,
  d.state,
  e.election_date::text AS election_date
`;

// One query per stage, all bound as ($1 district ids, $2 as-of date,
// $3 horizon days). Every predicate mirrors the matching due list so a row
// the ledger calls open is a row the operator's worklist also shows.
const GAP_QUERIES: Record<Exclude<ManualResearchDemandStage, "missing_general">, string> = {
  // Upcoming office election with no candidate link at all (withdrawn links
  // still count as a processed roster) and no live roster deferral.
  candidate_roster: `
    SELECT 'candidate_roster' AS stage, e.id::text AS target_id, ${GAP_SELECT_COLUMNS},
      e.official_ballot_title AS label
    FROM public.elections AS e
    JOIN public.districts AS d ON d.id = e.district_id
    WHERE e.district_id = ANY($1::uuid[])
      AND e.race_type = 'office'
      AND e.election_date >= $2::date
      AND (e.election_date - $2::date)::int <= $3::int
      AND NOT EXISTS (
        SELECT 1 FROM public.candidate_elections AS ce WHERE ce.election_id = e.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.manual_research_deferrals AS mrd
        WHERE mrd.status = 'deferred'
          AND mrd.stage = 'candidate_roster'
          AND mrd.blocked_until > $2::date
          AND (mrd.election_id = e.id OR (mrd.election_id IS NULL AND mrd.district_id = e.district_id))
      )
  `,
  // A live candidate on an upcoming ballot whose summary is empty (the
  // profile stage never ran) or is the "no public information" placeholder
  // (it ran and found nothing), with no live profile deferral covering the
  // candidate. A deferral covers the candidate when it is district-wide,
  // election-wide (no candidate blocker key), or keyed to this candidate
  // (blocker_key profile-<first 8 chars of the candidate id>). Once the
  // deferral's date passes the row is a gap again, so a placeholder comes
  // back for its recheck on its own.
  candidate_profile: `
    SELECT DISTINCT ON (c.id)
      'candidate_profile' AS stage, c.id::text AS target_id, ${GAP_SELECT_COLUMNS},
      COALESCE(NULLIF(btrim(c.display_name), ''), btrim(c.first_name || ' ' || c.last_name)) AS label
    FROM public.candidate_elections AS ce
    JOIN public.elections AS e ON e.id = ce.election_id
    JOIN public.districts AS d ON d.id = e.district_id
    JOIN public.candidates AS c ON c.id = ce.candidate_id
    WHERE e.district_id = ANY($1::uuid[])
      AND e.race_type = 'office'
      AND e.election_date >= $2::date
      AND (e.election_date - $2::date)::int <= $3::int
      AND ce.status <> 'withdrawn'
      AND c.deleted_at IS NULL
      AND c.merged_into_candidate_id IS NULL
      AND (
        COALESCE(btrim(c.summary), '') = ''
        OR btrim(c.summary) ~ '${NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN.replace(/'/g, "''")}'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.manual_research_deferrals AS mrd
        WHERE mrd.status = 'deferred'
          AND mrd.stage = 'candidate_profile'
          AND mrd.blocked_until > $2::date
          AND (mrd.election_id = e.id OR (mrd.election_id IS NULL AND mrd.district_id = e.district_id))
          AND (
            mrd.blocker_key IS NULL
            OR mrd.blocker_key NOT LIKE 'profile-%'
            OR mrd.blocker_key = 'profile-' || left(c.id::text, 8)
          )
      )
    ORDER BY c.id, e.election_date ASC, e.id ASC
  `,
  // Same candidates, records never searched.
  candidate_records: `
    SELECT DISTINCT ON (c.id)
      'candidate_records' AS stage, c.id::text AS target_id, ${GAP_SELECT_COLUMNS},
      COALESCE(NULLIF(btrim(c.display_name), ''), btrim(c.first_name || ' ' || c.last_name)) AS label
    FROM public.candidate_elections AS ce
    JOIN public.elections AS e ON e.id = ce.election_id
    JOIN public.districts AS d ON d.id = e.district_id
    JOIN public.candidates AS c ON c.id = ce.candidate_id
    WHERE e.district_id = ANY($1::uuid[])
      AND e.race_type = 'office'
      AND e.election_date >= $2::date
      AND (e.election_date - $2::date)::int <= $3::int
      AND ce.status <> 'withdrawn'
      AND c.deleted_at IS NULL
      AND c.merged_into_candidate_id IS NULL
      AND c.last_records_searched_at IS NULL
    ORDER BY c.id, e.election_date ASC, e.id ASC
  `,
  // Upcoming measure election whose detail row does not exist yet (the
  // measure writer creates ballot_measures only after research — the very
  // gap to count), was never researched, or has no summary. Keyed by the
  // election so the row's identity survives research.
  ballot_measure: `
    SELECT 'ballot_measure' AS stage, e.id::text AS target_id, ${GAP_SELECT_COLUMNS},
      e.official_ballot_title AS label
    FROM public.elections AS e
    JOIN public.districts AS d ON d.id = e.district_id
    LEFT JOIN public.ballot_measures AS bm ON bm.election_id = e.id
    WHERE e.district_id = ANY($1::uuid[])
      AND e.race_type = 'ballot_measure'
      AND e.election_date >= $2::date
      AND (e.election_date - $2::date)::int <= $3::int
      AND (bm.id IS NULL OR bm.last_researched IS NULL OR COALESCE(btrim(bm.summary), '') = '')
  `,
  // Past election with no decisive result: an office race whose roster
  // exists but no won/advanced/runoff row was recorded, or a measure
  // election with a measure still lacking its result.
  election_results: `
    SELECT 'election_results' AS stage, e.id::text AS target_id, ${GAP_SELECT_COLUMNS},
      e.official_ballot_title AS label
    FROM public.elections AS e
    JOIN public.districts AS d ON d.id = e.district_id
    WHERE e.district_id = ANY($1::uuid[])
      AND e.election_date < $2::date
      AND ($2::date - e.election_date)::int <= $3::int
      AND (
        (
          e.race_type = 'office'
          AND EXISTS (SELECT 1 FROM public.candidate_elections AS ce WHERE ce.election_id = e.id)
          AND NOT EXISTS (
            SELECT 1 FROM public.election_results AS er
            WHERE er.election_id = e.id AND er.outcome IN ('won', 'advanced', 'runoff')
          )
        )
        OR (
          e.race_type = 'ballot_measure'
          AND EXISTS (
            SELECT 1 FROM public.ballot_measures AS bm
            WHERE bm.election_id = e.id AND bm.result IS NULL
          )
        )
      )
  `,
};

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

/**
 * Every open research gap a ballot built from these districts would show:
 * empty rosters, profile-less or record-less candidates, unresearched
 * measures, past races without results, primaries with no general. Live
 * data only — nothing here reads the ledger — so the same function decides
 * both what to record on an address lookup and which ledger rows are still
 * open when the ledger is read.
 */
export async function findResearchGapsForDistricts(db: Queryable, input: GapQueryInput): Promise<ResearchGap[]> {
  const districtIds = [...new Set(input.districtIds)];
  if (districtIds.length === 0) {
    return [];
  }
  const params = [districtIds, input.asOfDate, input.horizonDays];
  const gaps: ResearchGap[] = [];
  for (const stage of MANUAL_RESEARCH_DEMAND_STAGES) {
    if (stage === "missing_general") {
      continue;
    }
    const result = await db.query<ResearchGap>(GAP_QUERIES[stage], params);
    gaps.push(...result.rows);
  }
  // The missing-generals report already encodes the contest-matching and
  // Louisiana rules; reuse it rather than restate them.
  const missingGenerals = await listMissingGeneralElections(db, {
    asOfDate: input.asOfDate,
    lookbackDays: input.horizonDays,
    lookaheadDays: input.horizonDays,
    horizonDays: input.horizonDays,
    districtIds,
  });
  for (const row of missingGenerals) {
    gaps.push({
      stage: "missing_general",
      target_id: row.election_id,
      district_id: row.district_id,
      election_id: row.election_id,
      state: row.state ?? "",
      label: row.official_ballot_title ?? "",
      election_date: row.election_date,
    });
  }
  return gaps;
}

/**
 * Demand ledger bump for one address lookup. Finds every open gap on the
 * ballot these districts produce and upserts one counter row per gap
 * (PRIMARY KEY (stage, target_id)): a new gap inserts at request_count 1, a
 * known one bumps request_count + last_requested_at.
 *
 * Same contract as enqueueManualDistrictResearchRequestsForStaleDistricts:
 * never throws, fire-and-forget from the address API, so it can never affect
 * the address response.
 */
export async function recordManualResearchDemandForDistricts(
  db: Queryable,
  input: {
    districts: readonly Pick<AddressResolvedDistrict, "id">[];
    triggerSource: ManualResearchDemandTriggerSource;
    asOfDate?: string;
    horizonDays?: number;
  }
): Promise<RecordManualResearchDemandResult> {
  const districtIds = [...new Set(input.districts.map((district) => district.id))];
  const result: RecordManualResearchDemandResult = {
    checked_districts: districtIds.length,
    gaps: 0,
    recorded: 0,
    bumped: 0,
    failed: 0,
  };
  if (districtIds.length === 0) {
    return result;
  }
  try {
    const gaps = await findResearchGapsForDistricts(db, {
      districtIds,
      asOfDate: input.asOfDate ?? usLatestLocalDateIso(),
      horizonDays: input.horizonDays ?? DEFAULT_MANUAL_RESEARCH_DEMAND_HORIZON_DAYS,
    });
    result.gaps = gaps.length;
    if (gaps.length === 0) {
      return result;
    }
    const upsert = await db.query<{ request_count: string | number }>(
      `
        INSERT INTO public.manual_research_demand
          (stage, target_id, district_id, election_id, state, label, election_date, last_trigger_source)
        SELECT g.stage, g.target_id, g.district_id, g.election_id, g.state, g.label, g.election_date, $8::text
        FROM unnest(
          $1::text[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::date[]
        ) AS g(stage, target_id, district_id, election_id, state, label, election_date)
        ON CONFLICT (stage, target_id) DO UPDATE SET
          district_id = EXCLUDED.district_id,
          election_id = EXCLUDED.election_id,
          state = EXCLUDED.state,
          label = EXCLUDED.label,
          election_date = EXCLUDED.election_date,
          request_count = public.manual_research_demand.request_count + 1,
          last_requested_at = now(),
          last_trigger_source = EXCLUDED.last_trigger_source
        RETURNING request_count
      `,
      [
        gaps.map((gap) => gap.stage),
        gaps.map((gap) => gap.target_id),
        gaps.map((gap) => gap.district_id),
        gaps.map((gap) => gap.election_id),
        gaps.map((gap) => gap.state),
        gaps.map((gap) => gap.label),
        gaps.map((gap) => gap.election_date),
        input.triggerSource,
      ]
    );
    // A fresh row carries the default request_count of 1; anything above
    // means the ON CONFLICT branch bumped a known gap.
    for (const row of upsert.rows) {
      if (Number(row.request_count) <= 1) {
        result.recorded += 1;
      } else {
        result.bumped += 1;
      }
    }
    console.log("manual research demand recorded:", { triggerSource: input.triggerSource, ...result });
    return result;
  } catch (error) {
    console.warn("manual research demand record failed; address response unaffected:", toReason(error));
    return { ...result, failed: 1 };
  }
}

type LedgerReadInput = {
  asOfDate: string;
  horizonDays: number;
  stage?: ManualResearchDemandStage;
  state?: string;
};

async function loadLedgerRows(db: Queryable, input: LedgerReadInput): Promise<ManualResearchDemandRow[]> {
  const result = await db.query<ManualResearchDemandRow>(
    `
      SELECT
        stage, target_id::text AS target_id, district_id::text AS district_id,
        election_id::text AS election_id, state, label, election_date::text AS election_date,
        request_count, first_requested_at::text AS first_requested_at,
        last_requested_at::text AS last_requested_at, last_trigger_source
      FROM public.manual_research_demand
      WHERE ($1::text IS NULL OR stage = $1::text)
        AND ($2::text IS NULL OR state = $2::text)
      ORDER BY request_count DESC, last_requested_at DESC, stage ASC, target_id ASC
    `,
    [input.stage ?? null, input.state ?? null]
  );
  return result.rows;
}

function gapKey(gap: Pick<ResearchGap, "stage" | "target_id">): string {
  return `${gap.stage}:${gap.target_id}`;
}

/**
 * Splits the ledger into rows whose gap is still open (hottest first) and
 * rows whose gap has since closed — researched through any path, or drifted
 * outside the horizon. Closed rows are reported, never deleted here; that is
 * pruneManualResearchDemand's job.
 */
export async function listManualResearchDemand(
  db: Queryable,
  input: LedgerReadInput & { limit: number }
): Promise<{ open: ManualResearchDemandRow[]; closed: ManualResearchDemandRow[] }> {
  const rows = await loadLedgerRows(db, input);
  if (rows.length === 0) {
    return { open: [], closed: [] };
  }
  const gaps = await findResearchGapsForDistricts(db, {
    districtIds: rows.map((row) => row.district_id),
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
  });
  const openKeys = new Set(gaps.map(gapKey));
  const open = rows.filter((row) => openKeys.has(gapKey(row)));
  const closed = rows.filter((row) => !openKeys.has(gapKey(row)));
  return { open: open.slice(0, input.limit), closed };
}

/** Deletes ledger rows whose gap has closed. Returns how many were removed. */
export async function pruneManualResearchDemand(
  db: Queryable,
  input: Pick<LedgerReadInput, "asOfDate" | "horizonDays">
): Promise<{ deleted: number }> {
  const { closed } = await listManualResearchDemand(db, { ...input, limit: 0 });
  if (closed.length === 0) {
    return { deleted: 0 };
  }
  const result = await db.query(
    `
      DELETE FROM public.manual_research_demand AS m
      USING unnest($1::text[], $2::uuid[]) AS c(stage, target_id)
      WHERE m.stage = c.stage AND m.target_id = c.target_id
    `,
    [closed.map((row) => row.stage), closed.map((row) => row.target_id)]
  );
  return { deleted: result.rowCount ?? 0 };
}
