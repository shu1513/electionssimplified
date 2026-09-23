import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { ElectionDistrictType } from "../../types/election.js";
import {
  calculateHistoricalContestMargin,
  classifyHistoricalContestMargin,
  roundHistoricalContestMarginPercent,
} from "./competitivenessLabels.js";
import type { HistoricalContestCandidateLine } from "./historicalContestNormalizer.js";
import {
  buildHistoricalContestLookupKey,
  type HistoricalContestLookupKey,
} from "./historicalContestKeys.js";
import type { HistoricalContestCompetitivenessLabel } from "./competitivenessLabels.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export const HISTORICAL_CONTEST_WEIGHTED_MARGIN_METHOD = "weighted_last_3" as const;
export const HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS = [0.5, 0.3, 0.2] as const;

export type HistoricalContestMarginLookupInput = {
  lookupId: string;
  officeCanonicalName: string | null | undefined;
  districtType: ElectionDistrictType;
  geoidCompact: string;
  stateFips: string;
  currentElectionYear?: number | null;
  maxElectionYear?: number | null;
  // Seats the current election fills. Above one, each matched row is
  // re-ranked so the margin is the one that decided the last seat.
  seatsToFill?: number | null;
};

export type HistoricalContestMarginLookupRecord = {
  id: string;
  lookup_id: string;
  source: string;
  source_url: string | null;
  election_year: number;
  state: string;
  state_fips: string;
  office_type: HistoricalContestLookupKey["office_type"];
  district_type: HistoricalContestLookupKey["district_type"];
  district_key: string;
  mit_office: string;
  mit_district: string;
  winner_party: string | null;
  runner_up_party: string | null;
  winner_votes: number | null;
  runner_up_votes: number | null;
  total_votes: number;
  margin_percent: number;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  stale_after_redistricting: boolean;
  imported_at: string;
  // Every candidate line sorted by votes descending; null on rows imported
  // before migration 299.
  candidate_lines: HistoricalContestCandidateLine[] | null;
  // Which seat the margin fields describe: 1 = 1st vs 2nd place (the stored
  // pair), N = Nth vs (N+1)th after re-ranking for an N-seat election.
  seats_ranked: number;
};

export type HistoricalContestWeightedMarginContest = HistoricalContestMarginLookupRecord & {
  weight: number;
};

export type HistoricalContestWeightedMarginLookupRecord = {
  lookup_id: string;
  method: typeof HISTORICAL_CONTEST_WEIGHTED_MARGIN_METHOD;
  weights: readonly number[];
  contests_used: HistoricalContestWeightedMarginContest[];
  election_years: number[];
  source: string;
  source_url: string | null;
  state: string;
  state_fips: string;
  office_type: HistoricalContestLookupKey["office_type"];
  district_type: HistoricalContestLookupKey["district_type"];
  district_key: string;
  mit_office: string;
  mit_district: string;
  margin_percent: number;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  stale_after_redistricting: boolean;
};

type LookupQueryKey = HistoricalContestLookupKey & {
  lookup_id: string;
  min_election_year: number | null;
  max_election_year: number | null;
};

type HistoricalContestMarginLookupRow = QueryResultRow & {
  id: string;
  lookup_id: string;
  source: string;
  source_url: string | null;
  election_year: number;
  state: string;
  state_fips: string;
  office_type: HistoricalContestLookupKey["office_type"];
  district_type: HistoricalContestLookupKey["district_type"];
  district_key: string;
  mit_office: string;
  mit_district: string;
  winner_party: string | null;
  runner_up_party: string | null;
  winner_votes: number | string | null;
  runner_up_votes: number | string | null;
  total_votes: number | string;
  margin_percent: number | string;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  stale_after_redistricting: boolean;
  imported_at: string;
  candidate_lines?: unknown;
};

function parseInteger(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid historical contest numeric value: ${value}`);
  }
  return parsed;
}

// jsonb arrives parsed; anything but an array of {votes, party} objects
// (a hand-edited row) degrades to null, never a thrown ballot request.
function parseCandidateLines(value: unknown): HistoricalContestCandidateLine[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines: HistoricalContestCandidateLine[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const votes = (entry as { votes?: unknown }).votes;
    const party = (entry as { party?: unknown }).party;
    if (typeof votes !== "number" || !Number.isSafeInteger(votes) || votes < 0) {
      return null;
    }
    lines.push({ votes, party: typeof party === "string" && party ? party : null });
  }
  return lines;
}

// A "vote for N" election: the stored 1st-vs-2nd pair are both winners, so
// the margin that decided the last seat is line [N-1] vs line [N]. Rows
// without candidate lines (pre-migration-299 imports) keep the stored pair.
// Fewer lines than seats means nobody lost: the last line vs zero, which
// grades safe — the same reading the single-seat path gives an unopposed
// contest.
export function rerankHistoricalContestMarginForSeats(
  record: HistoricalContestMarginLookupRecord,
  seatsToFill: number | null | undefined
): HistoricalContestMarginLookupRecord {
  const seats =
    typeof seatsToFill === "number" && Number.isInteger(seatsToFill) && seatsToFill > 1 ? seatsToFill : 1;
  const lines = record.candidate_lines;
  if (seats === 1 || !lines || lines.length === 0) {
    return record;
  }
  const lastWinner = lines[Math.min(seats, lines.length) - 1]!;
  const firstLoser = lines[seats] ?? { votes: 0, party: null };
  const margin = calculateHistoricalContestMargin({
    winnerVotes: lastWinner.votes,
    runnerUpVotes: firstLoser.votes,
    totalVotes: record.total_votes,
  });
  if (!margin) {
    return record;
  }
  return {
    ...record,
    winner_party: lastWinner.party,
    runner_up_party: firstLoser.party,
    winner_votes: lastWinner.votes,
    runner_up_votes: firstLoser.votes,
    margin_percent: margin.marginPercent,
    competitiveness_label: margin.competitivenessLabel,
    seats_ranked: seats,
  };
}

function tryBuildLookupKey(input: HistoricalContestMarginLookupInput): HistoricalContestLookupKey | null {
  try {
    return buildHistoricalContestLookupKey({
      officeCanonicalName: input.officeCanonicalName,
      districtType: input.districtType,
      geoidCompact: input.geoidCompact,
      stateFips: input.stateFips,
    });
  } catch {
    return null;
  }
}

function normalizeElectionYear(value: number | null | undefined): number | null {
  return value !== undefined && value !== null && Number.isInteger(value) && value >= 1800 && value <= 2100
    ? value
    : null;
}

function redistrictingCycleStartYear(electionYear: number): number {
  return electionYear - (((electionYear - 2) % 10) + 10) % 10;
}

function minHistoricalElectionYearForKey(
  key: HistoricalContestLookupKey,
  currentElectionYear: number | null
): number | null {
  if (
    currentElectionYear === null ||
    (key.district_type !== "us_house" &&
      key.district_type !== "state_upper" &&
      key.district_type !== "state_lower")
  ) {
    return null;
  }
  return redistrictingCycleStartYear(currentElectionYear);
}

function buildQueryKeys(inputs: readonly HistoricalContestMarginLookupInput[]): LookupQueryKey[] {
  const keys = new Map<string, LookupQueryKey>();
  for (const input of inputs) {
    const lookupId = input.lookupId.trim();
    if (!lookupId) {
      continue;
    }
    const key = tryBuildLookupKey(input);
    if (!key) {
      continue;
    }
    const currentElectionYear = normalizeElectionYear(input.currentElectionYear);
    keys.set(lookupId, {
      lookup_id: lookupId,
      min_election_year: minHistoricalElectionYearForKey(key, currentElectionYear),
      max_election_year: normalizeElectionYear(input.maxElectionYear),
      ...key,
    });
  }
  return [...keys.values()];
}

function mapRow(row: HistoricalContestMarginLookupRow): HistoricalContestMarginLookupRecord {
  const winnerVotes = parseInteger(row.winner_votes);
  const runnerUpVotes = parseInteger(row.runner_up_votes);
  const totalVotes = parseInteger(row.total_votes);
  if (totalVotes === null) {
    throw new Error(`Invalid historical contest total_votes for margin row ${row.id}`);
  }

  return {
    id: row.id,
    lookup_id: row.lookup_id,
    source: row.source,
    source_url: row.source_url,
    election_year: row.election_year,
    state: row.state,
    state_fips: row.state_fips,
    office_type: row.office_type,
    district_type: row.district_type,
    district_key: row.district_key,
    mit_office: row.mit_office,
    mit_district: row.mit_district,
    winner_party: row.winner_party,
    runner_up_party: row.runner_up_party,
    winner_votes: winnerVotes,
    runner_up_votes: runnerUpVotes,
    total_votes: totalVotes,
    margin_percent: parseNumber(row.margin_percent),
    competitiveness_label: row.competitiveness_label,
    stale_after_redistricting: row.stale_after_redistricting,
    imported_at: row.imported_at,
    candidate_lines: parseCandidateLines(row.candidate_lines),
    seats_ranked: 1,
  };
}

function normalizeWeights(count: number): number[] {
  const weights = HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS.slice(0, count);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => Math.round((weight / weightTotal) * 10_000) / 10_000);
}

export function calculateWeightedHistoricalContestMargin(
  rows: readonly HistoricalContestMarginLookupRecord[]
): HistoricalContestWeightedMarginLookupRecord | null {
  const contests = [...rows]
    .sort((left, right) => right.election_year - left.election_year || right.imported_at.localeCompare(left.imported_at))
    .slice(0, HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS.length);
  const [latestContest] = contests;
  if (!latestContest) {
    return null;
  }

  const normalizedWeights = normalizeWeights(contests.length);
  const weightedMargin = roundHistoricalContestMarginPercent(
    contests.reduce((sum, contest, index) => sum + contest.margin_percent * normalizedWeights[index]!, 0)
  );
  const contestsUsed = contests.map((contest, index) => ({
    ...contest,
    weight: normalizedWeights[index]!,
  }));

  return {
    lookup_id: latestContest.lookup_id,
    method: HISTORICAL_CONTEST_WEIGHTED_MARGIN_METHOD,
    weights: normalizedWeights,
    contests_used: contestsUsed,
    election_years: contests.map((contest) => contest.election_year),
    source: latestContest.source,
    source_url: latestContest.source_url,
    state: latestContest.state,
    state_fips: latestContest.state_fips,
    office_type: latestContest.office_type,
    district_type: latestContest.district_type,
    district_key: latestContest.district_key,
    mit_office: latestContest.mit_office,
    mit_district: latestContest.mit_district,
    margin_percent: weightedMargin,
    competitiveness_label: classifyHistoricalContestMargin(weightedMargin),
    stale_after_redistricting: contests.some((contest) => contest.stale_after_redistricting),
  };
}

export async function lookupHistoricalContestMargins(
  db: Queryable,
  inputs: readonly HistoricalContestMarginLookupInput[]
): Promise<Map<string, HistoricalContestMarginLookupRecord>> {
  const rowsByLookupId = await lookupHistoricalContestMarginRows(db, inputs);
  const latestRows = new Map<string, HistoricalContestMarginLookupRecord>();
  for (const [lookupId, rows] of rowsByLookupId) {
    const [latestRow] = rows;
    if (latestRow) {
      latestRows.set(lookupId, latestRow);
    }
  }
  return latestRows;
}

export async function lookupHistoricalContestMarginRows(
  db: Queryable,
  inputs: readonly HistoricalContestMarginLookupInput[]
): Promise<Map<string, HistoricalContestMarginLookupRecord[]>> {
  const keys = buildQueryKeys(inputs);
  if (keys.length === 0) {
    return new Map();
  }
  const seatsByLookupId = new Map(inputs.map((input) => [input.lookupId.trim(), input.seatsToFill ?? null]));

  const result = await db.query<HistoricalContestMarginLookupRow>(
    `
      WITH lookup_keys AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS key (
          lookup_id text,
          min_election_year integer,
          max_election_year integer,
          state text,
          state_fips text,
          office_type text,
          district_type text,
          district_key text,
          mit_office text,
          mit_district text
        )
      ),
      ranked_margins AS (
        SELECT
          hcm.id,
          key.lookup_id,
          hcm.source,
          hcm.source_url,
          hcm.election_year,
          hcm.state,
          hcm.state_fips,
          hcm.office_type,
          hcm.district_type,
          hcm.district_key,
          hcm.mit_office,
          hcm.mit_district,
          hcm.winner_party,
          hcm.runner_up_party,
          hcm.winner_votes,
          hcm.runner_up_votes,
          hcm.total_votes,
          hcm.margin_percent,
          hcm.competitiveness_label,
          hcm.stale_after_redistricting,
          hcm.imported_at::text AS imported_at,
          hcm.candidate_lines,
          ROW_NUMBER() OVER (
            PARTITION BY key.lookup_id
            ORDER BY hcm.election_year DESC, hcm.imported_at DESC, hcm.id
          ) AS row_rank
      FROM lookup_keys AS key
      JOIN public.historical_contest_margins AS hcm
        ON hcm.state = key.state
       AND hcm.office_type = key.office_type
       AND hcm.district_type = key.district_type
       AND hcm.district_key = key.district_key
       AND (
         key.min_election_year IS NULL
         OR hcm.election_year >= key.min_election_year
       )
       AND (
         key.max_election_year IS NULL
         OR hcm.election_year <= key.max_election_year
       )
      )
      SELECT
        id,
        lookup_id,
        source,
        source_url,
        election_year,
        state,
        state_fips,
        office_type,
        district_type,
        district_key,
        mit_office,
        mit_district,
        winner_party,
        runner_up_party,
        winner_votes,
        runner_up_votes,
        total_votes,
        margin_percent,
        competitiveness_label,
        stale_after_redistricting,
        imported_at,
        candidate_lines
      FROM ranked_margins
      WHERE row_rank <= $2
      ORDER BY lookup_id, row_rank
    `,
    [JSON.stringify(keys), HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS.length]
  );

  const rowsByLookupId = new Map<string, HistoricalContestMarginLookupRecord[]>();
  for (const row of result.rows) {
    const mappedRow = rerankHistoricalContestMarginForSeats(mapRow(row), seatsByLookupId.get(row.lookup_id));
    rowsByLookupId.set(mappedRow.lookup_id, [...(rowsByLookupId.get(mappedRow.lookup_id) ?? []), mappedRow]);
  }
  return rowsByLookupId;
}
