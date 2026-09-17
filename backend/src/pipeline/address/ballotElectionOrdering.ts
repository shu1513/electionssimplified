import type { Pool, PoolClient } from "pg";

import type { BallotLookupElectionSummary, BallotSummaryResult } from "./ballotLookup.js";
import { stateBallotContestRank } from "./stateBallotOrderRules.js";
import {
  loadUserResearchAreaWeights,
  scoreResearchAreaMatch,
  type ResearchAreaMatchScore,
} from "../users/userResearchAreaScoring.js";

// ---------------------------------------------------------------------------
// Personalized ballot election ordering (sort modes, followed-candidates
// surfacing, and the "followed first" grouping).
//
// This feature is deliberately isolated as a decorator over the plain ballot
// summary reader: `lookupBallotSummariesByDistrictIds` knows nothing about it.
// To REMOVE the feature entirely, delete:
//   - this file (+ tests/pipeline/address/ballotElectionOrdering.test.ts)
//   - src/pipeline/users/userBallotPreferences.ts (+ its tests)
//   - db/migrations/144_add_user_ballot_preferences.sql (+ the table)
// and the blocks tagged [ballot-personalized-ordering] in:
//   - src/api/apiValidation.ts   (path const + two parsers)
//   - src/api/apiServer.ts       (prefs route, me/ballot merge, path lists)
//   - src/api/apiErrors.ts       (UserBallotPreferencesError mapping)
//   - src/api/addressApiTypes.ts (options/result types, prefs option fns)
//   - src/scripts/runAddressApiServer.ts (decorator composition, prefs wiring)
// The base endpoints then return the reader's natural date ordering again.
// ---------------------------------------------------------------------------

type Queryable = Pick<Pool | PoolClient, "query">;

// Ordering the caller wants for the elections list. Election date is the
// list's fixed outer structure under every sort below (earliest date first —
// the list pages render one "Elections on {date}" section per date); the
// chosen sort orders the races WITHIN each date. `vote_power` (the default)
// sorts by the computed vote-power score descending; `district_size` sorts
// by government level (presidential → federal → state → county → city, see
// ballotLevelRank) and then by district population descending (largest
// electorate first); `district_size_smallest` reverses both keys. Unknown
// populations sort last in both directions. The level key is what lets the
// list pages render one collapsible section per level under these two sorts
// as consecutive runs of the payload. Office races with no published candidate list sink
// below every other race under all of these — see hasNothingToRead.
// `my_areas` sorts by how strongly the election's
// research areas match the user's saved research-area preferences (summed
// weights, see userResearchAreaScoring.ts) and degrades to `vote_power` for
// anonymous callers and users with no saved areas.
// `state_baseline` orders contests the way they appear on a US paper ballot
// (ballotContestRank.ts generic tiers + stateBallotOrderRules.ts per-state
// general-election overrides) for the ballot-preview render. It is a
// POSITIONAL order: followed-first grouping and the empty-race sink are both
// skipped under it, because moving a race breaks the copy-across promise.
// Keep SAVEABLE_BALLOT_PREFERENCE_SORTS in sync with the
// user_ballot_preferences sort CHECK constraint (db/migrations/281) and the
// frontend BALLOT_SORTS mirror; state_baseline is deliberately request-only
// (not saveable) — the preview always passes it explicitly. The former
// `soonest` sort was retired once date became the outer order of every sort
// (migration 281 rewrote saved rows to vote_power).
export type BallotSummarySort =
  | "vote_power"
  | "district_size"
  | "district_size_smallest"
  | "my_areas"
  | "state_baseline";

export const BALLOT_SUMMARY_SORTS: readonly BallotSummarySort[] = [
  "vote_power",
  "district_size",
  "district_size_smallest",
  "my_areas",
  "state_baseline",
];

export const SAVEABLE_BALLOT_PREFERENCE_SORTS: readonly BallotSummarySort[] = [
  "vote_power",
  "district_size",
  "district_size_smallest",
  "my_areas",
];

export function isBallotSummarySort(value: unknown): value is BallotSummarySort {
  return typeof value === "string" && (BALLOT_SUMMARY_SORTS as readonly string[]).includes(value);
}

// The preferences store must use this, not isBallotSummarySort: a request-only
// sort that reaches the INSERT surfaces as a CHECK-constraint failure instead
// of invalid_preferences.
export function isSaveableBallotPreferenceSort(value: unknown): value is BallotSummarySort {
  return typeof value === "string" && (SAVEABLE_BALLOT_PREFERENCE_SORTS as readonly string[]).includes(value);
}

export type BallotSummaryOptions = {
  // When set (YYYY-MM-DD), only elections on that date are returned and the
  // rolling "recent past" window does not apply. The newsroom embed uses it
  // so a reviewed November list stays readable after election day.
  electionDate?: string;
  // When set, followed candidates are resolved for this user and attached to
  // each election. Anonymous lookups omit it and every election gets [].
  userId?: string | null;
  sort?: BallotSummarySort;
  // When true (the default), elections that contain at least one followed
  // candidate are grouped ahead of the rest WITHIN each election date, each
  // group still ordered by `sort`. A no-op for anonymous lookups, which never
  // have follows.
  followedFirst?: boolean;
  // include=preview: the READER consumes this (ballot-preview roster/measure
  // payload per election); it rides on this shared options object so the API
  // wiring hands one bag to both layers. This decorator ignores it — the
  // spread in applyBallotElectionOrdering carries any attached preview
  // through untouched.
  includePreview?: boolean;
};

export type BallotFollowedCandidate = {
  candidate_id: string;
  display_name: string;
};

// Candidates this user follows who are running in this election. Always
// present on ordered results; empty for anonymous lookups or elections with
// no followed candidate. Drives the "followed first" grouping and FE chips.
export type OrderedBallotElectionSummary = BallotLookupElectionSummary & {
  followed_candidates: BallotFollowedCandidate[];
};

export type OrderedBallotSummaryResult = Omit<BallotSummaryResult, "elections"> & {
  elections: OrderedBallotElectionSummary[];
};

// Decorates a plain ballot summary result with followed-candidate annotations
// and applies the requested ordering. This is the single entry point the API
// wiring composes over the reader.
export async function applyBallotElectionOrdering(
  db: Queryable,
  result: BallotSummaryResult,
  options: BallotSummaryOptions = {}
): Promise<OrderedBallotSummaryResult> {
  // Independent queries keyed only on the user: load them in parallel so the
  // my_areas sort does not add a sequential round trip to the ballot path.
  const [followedByElection, weights] = await Promise.all([
    loadFollowedCandidatesByElection(
      db,
      options.userId ?? null,
      result.elections.map((election) => election.id)
    ),
    options.sort === "my_areas"
      ? loadUserResearchAreaWeights(db, options.userId ?? null)
      : Promise.resolve(null),
  ]);

  const elections: OrderedBallotElectionSummary[] = result.elections.map((election) => ({
    ...election,
    followed_candidates: followedByElection.get(election.id) ?? [],
  }));

  let sort = options.sort ?? "vote_power";
  let areaScoresByElection: Map<string, ResearchAreaMatchScore> | null = null;
  if (sort === "my_areas") {
    if (!weights || weights.size === 0) {
      // Anonymous caller or no saved areas: nothing to match against, so the
      // sort degrades to the default rather than erroring.
      sort = "vote_power";
    } else {
      areaScoresByElection = new Map(
        elections.map((election) => [
          election.id,
          scoreResearchAreaMatch(
            election.research_areas.map((area) => area.id),
            weights
          ),
        ])
      );
    }
  }

  sortBallotElections(elections, sort, options.followedFirst ?? true, areaScoresByElection);

  return { ...result, elections };
}

type FollowedCandidateRow = {
  election_id: string;
  candidate_id: string;
  display_name: string;
};

// Resolves, per election, the candidates this user follows who are actually on
// that ballot. Returns an empty map for anonymous callers so every election
// gets [] without a database round-trip.
async function loadFollowedCandidatesByElection(
  db: Queryable,
  userId: string | null,
  electionIds: readonly string[]
): Promise<Map<string, BallotFollowedCandidate[]>> {
  const followed = new Map<string, BallotFollowedCandidate[]>();
  const trimmedUserId = typeof userId === "string" ? userId.trim() : "";
  if (trimmedUserId.length === 0 || electionIds.length === 0) {
    return followed;
  }

  const result = await db.query<FollowedCandidateRow>(
    `
      SELECT
        ce.election_id,
        c.id AS candidate_id,
        COALESCE(NULLIF(trim(c.display_name), ''), trim(concat_ws(' ', c.first_name, c.last_name))) AS display_name
      FROM public.user_candidate_follows AS f
      JOIN public.candidate_elections AS ce
        ON ce.candidate_id = f.candidate_id
       AND ce.status NOT IN ('withdrawn', 'lost')
      JOIN public.candidates AS c
        ON c.id = f.candidate_id
       AND c.deleted_at IS NULL
       AND c.merged_into_candidate_id IS NULL
      WHERE f.user_id = $1
        AND ce.election_id = ANY($2::uuid[])
      ORDER BY ce.election_id, display_name, c.id
    `,
    [trimmedUserId, electionIds]
  );

  for (const row of result.rows) {
    const list = followed.get(row.election_id);
    const entry = { candidate_id: row.candidate_id, display_name: row.display_name };
    if (list) {
      list.push(entry);
    } else {
      followed.set(row.election_id, [entry]);
    }
  }
  return followed;
}

// An office race whose candidate list has not been published (or not yet
// imported) shows a "Candidate list not final" card with nothing to read —
// so it sinks below every race a voter can act on, under every sort. Ballot
// measures are exempt: zero candidates is their normal state, and the measure
// text is the content. A recorded result also exempts: winners can be
// recorded without candidate links (see electionResultPayloadContract), and
// the ballot keeps races for three days past election day — a decided race
// is readable regardless of its roster. The sink outranks the date order and
// the followed-first tier: the list pages render every sunk race in one
// closing "awaiting candidate information" section under all the date
// sections, and the followed tier can never contradict it — a followed
// candidate is a candidate.
function hasNothingToRead(election: OrderedBallotElectionSummary): boolean {
  return election.race_type !== "ballot_measure" && election.candidate_count === 0 && !election.has_results;
}

// Stable, in-place ordering of the elections list. `Array.prototype.sort` is
// stable, so the reader's SQL order (election_date, race_type, title, id) is
// the deterministic tiebreak whenever the chosen keys are equal.
function sortBallotElections(
  elections: OrderedBallotElectionSummary[],
  sort: BallotSummarySort,
  followedFirst: boolean,
  areaScoresByElection: Map<string, ResearchAreaMatchScore> | null = null
): void {
  // Positional ballot order: no followed-first grouping, no empty-race sink —
  // a race's slot on the sheet is the whole point of this sort. The rank is
  // the state's verified general-election order where an override exists
  // (stateBallotOrderRules.ts), the generic baseline otherwise. Rank-first
  // (not date-first) is fine even when the summary spans several election
  // dates: the preview renders one sheet per election_date and only relies
  // on the payload order WITHIN each date (BallotPreviewSheets).
  if (sort === "state_baseline") {
    elections.sort((a, b) => {
      const byRank = stateBallotContestRank(a) - stateBallotContestRank(b);
      return byRank !== 0 ? byRank : compareTail(a, b);
    });
    return;
  }
  elections.sort((a, b) => {
    const aEmpty = hasNothingToRead(a) ? 1 : 0;
    const bEmpty = hasNothingToRead(b) ? 1 : 0;
    if (aEmpty !== bEmpty) {
      return aEmpty - bEmpty;
    }
    // Date is the outer structure of every sort: earliest date first, and
    // the followed-first tier and the chosen sort only reorder races that
    // share a date.
    if (a.election_date !== b.election_date) {
      return a.election_date < b.election_date ? -1 : 1;
    }
    // Level sits ABOVE the followed tier for the district-size sorts: the
    // list pages section these sorts by level as consecutive runs, and a
    // followed race hoisted out of its level would split one level into two
    // sections. Followed-first still applies within each level.
    if (sort === "district_size" || sort === "district_size_smallest") {
      const byLevel = ballotLevelRank(a, sort) - ballotLevelRank(b, sort);
      if (byLevel !== 0) {
        return byLevel;
      }
    }
    if (followedFirst) {
      const aFollowed = a.followed_candidates.length > 0 ? 0 : 1;
      const bFollowed = b.followed_candidates.length > 0 ? 0 : 1;
      if (aFollowed !== bFollowed) {
        return aFollowed - bFollowed;
      }
    }
    return compareBySort(a, b, sort, areaScoresByElection);
  });
}

const NO_AREA_MATCH: ResearchAreaMatchScore = { score: 0, bestRank: Number.POSITIVE_INFINITY };

// Numeric-aware title compare so "Proposition 4" sorts before "Proposition 33"
// (plain string compare puts 33 first). Fixed "en" locale keeps the order
// deterministic across server environments.
const BALLOT_TITLE_COLLATOR = new Intl.Collator("en", { numeric: true });

function compareBySort(
  a: OrderedBallotElectionSummary,
  b: OrderedBallotElectionSummary,
  sort: BallotSummarySort,
  areaScoresByElection: Map<string, ResearchAreaMatchScore> | null = null
): number {
  if (sort === "my_areas") {
    // Higher summed weight of matched saved areas first; among equal sums the
    // election touching the user's best-ranked area wins; then the default
    // vote-power ordering decides.
    const aMatch = areaScoresByElection?.get(a.id) ?? NO_AREA_MATCH;
    const bMatch = areaScoresByElection?.get(b.id) ?? NO_AREA_MATCH;
    if (aMatch.score !== bMatch.score) {
      return bMatch.score - aMatch.score;
    }
    if (aMatch.bestRank !== bMatch.bestRank) {
      return aMatch.bestRank - bMatch.bestRank;
    }
    return compareBySort(a, b, "vote_power");
  }
  if (sort === "vote_power") {
    // Higher vote-power score first; unknown scores (null) sort last.
    const aScore = typeof a.vote_power.score === "number" ? a.vote_power.score : Number.NEGATIVE_INFINITY;
    const bScore = typeof b.vote_power.score === "number" ? b.vote_power.score : Number.NEGATIVE_INFINITY;
    if (aScore !== bScore) {
      return bScore - aScore;
    }
  }
  if (sort === "district_size" || sort === "district_size_smallest") {
    // Level was already compared in sortBallotElections (above the followed
    // tier); here only population remains. district_size: larger population
    // first; district_size_smallest: smaller first. Unknown populations
    // (null) sort last in both directions.
    const missing = sort === "district_size" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const aPopulation = typeof a.district.population === "number" ? a.district.population : missing;
    const bPopulation = typeof b.district.population === "number" ? b.district.population : missing;
    if (aPopulation !== bPopulation) {
      return sort === "district_size" ? bPopulation - aPopulation : aPopulation - bPopulation;
    }
  }
  return compareTail(a, b);
}

// Government level of a race, biggest first. Mirrors ballotLevel in
// packages/api-client (ballotLevel.ts), which the list pages use to label the
// sections — keep the two in step. office.scope leads (a place office on a
// coextensive county row is still a city race); district_type covers ballot
// measures, which have no office. School boards fold into the city tier.
// US Senate is the one level the scope cannot tell: its offices are scope
// "statewide" (there is no us_senate scope), so the contest family is what
// lifts it to the federal tier.
const BALLOT_LEVEL_RANKS: Record<string, number> = {
  presidential: 0,
  us_house: 1,
  statewide: 2,
  state_upper: 2,
  state_lower: 2,
  county: 3,
  place: 4,
  school_unified: 4,
  school_elementary: 4,
  school_secondary: 4,
};
const FEDERAL_LEVEL_RANK = 1;
const UNKNOWN_LEVEL_RANK = 5;

function ballotLevelRank(election: OrderedBallotElectionSummary, sort: BallotSummarySort): number {
  const rank =
    election.discovery_contest_family === "us_senate"
      ? FEDERAL_LEVEL_RANK
      : BALLOT_LEVEL_RANKS[election.office?.scope ?? election.district.district_type];
  if (rank === undefined) {
    return UNKNOWN_LEVEL_RANK;
  }
  return sort === "district_size_smallest" ? UNKNOWN_LEVEL_RANK - 1 - rank : rank;
}

// The shared tiebreak for equal primary keys — the reader's SQL order:
// earliest date first, then race_type, numeric-aware title, id. The date key
// is redundant under the list sorts (sortBallotElections already split by
// date) but carries state_baseline's within-rank order.
function compareTail(a: OrderedBallotElectionSummary, b: OrderedBallotElectionSummary): number {
  if (a.election_date !== b.election_date) {
    return a.election_date < b.election_date ? -1 : 1;
  }
  if (a.race_type !== b.race_type) {
    return a.race_type < b.race_type ? -1 : 1;
  }
  if (a.official_ballot_title !== b.official_ballot_title) {
    const byTitle = BALLOT_TITLE_COLLATOR.compare(a.official_ballot_title, b.official_ballot_title);
    if (byTitle !== 0) {
      return byTitle;
    }
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
