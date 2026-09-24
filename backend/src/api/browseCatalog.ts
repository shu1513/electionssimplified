import type { Pool, PoolClient } from "pg";
import { STATE_NAME_BY_ABBREVIATION } from "../constants/usStates.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * The browse catalog behind /browse, /browse/:state and /districts/:id: the
 * crawlable path from the home page down to every race and candidate
 * (state → district → race → candidate). Detail pages link only their own
 * neighbours, so without these lists the ~55k detail pages are reachable
 * from nothing but the sitemap, and a search engine ranks a page nothing
 * links to as if nobody cares about it.
 *
 * Only districts that hold at least one election appear: 42k of the 55k
 * district rows never had a race researched and would be empty pages.
 * Anonymous and identical for everyone, so the API answers with a shared
 * cache header and the edge Worker caches the rendered pages.
 */

export type BrowseState = {
  state: string;
  name: string;
  /** Districts holding at least one election. */
  district_count: number;
  /** Elections dated today or later. */
  upcoming_election_count: number;
};

export type BrowseStatesResult = { states: BrowseState[] };

export type BrowseDistrictSummary = {
  id: string;
  name: string;
  district_type: string;
  election_count: number;
  upcoming_election_count: number;
  /** ISO date of the soonest election today or later; null when none. */
  next_election_date: string | null;
};

export type BrowseStateResult = {
  state: string;
  name: string;
  districts: BrowseDistrictSummary[];
};

export type BrowseElectionCandidate = {
  candidate_id: string;
  display_name: string;
  party: string;
  status: string;
};

export type BrowseElection = {
  id: string;
  official_ballot_title: string;
  election_date: string;
  election_stage: string | null;
  race_type: string;
  candidates: BrowseElectionCandidate[];
};

export type BrowseDistrictResult = {
  district: { id: string; name: string; district_type: string; state: string; state_name: string };
  elections: BrowseElection[];
};

/** Two-letter USPS code, upper-cased; null when it is not a state we name. */
export function normalizeBrowseState(raw: string): string | null {
  const state = raw.trim().toUpperCase();
  return STATE_NAME_BY_ABBREVIATION[state] ? state : null;
}

type StateRow = { state: string; district_count: string | number; upcoming_election_count: string | number };

export async function listBrowseStates(db: Queryable): Promise<BrowseStatesResult> {
  const result = await db.query<StateRow>(
    `
      SELECT
        d.state,
        COUNT(DISTINCT d.id) AS district_count,
        COUNT(e.id) FILTER (WHERE e.election_date >= CURRENT_DATE) AS upcoming_election_count
      FROM public.districts d
      JOIN public.elections e ON e.district_id = d.id
      GROUP BY d.state
      ORDER BY d.state ASC
    `
  );
  const states: BrowseState[] = [];
  for (const row of result.rows) {
    // Rows for a code we cannot name (bad data) get no page rather than a
    // page titled by its abbreviation.
    const name = STATE_NAME_BY_ABBREVIATION[row.state];
    if (!name) {
      continue;
    }
    states.push({
      state: row.state,
      name,
      district_count: Number(row.district_count),
      upcoming_election_count: Number(row.upcoming_election_count),
    });
  }
  return { states };
}

type DistrictRow = {
  id: string;
  name: string;
  district_type: string;
  election_count: string | number;
  upcoming_election_count: string | number;
  next_election_date: string | null;
};

export async function getBrowseState(db: Queryable, rawState: string): Promise<BrowseStateResult | null> {
  const state = normalizeBrowseState(rawState);
  if (!state) {
    return null;
  }
  const result = await db.query<DistrictRow>(
    `
      SELECT
        d.id,
        d.name,
        d.district_type,
        COUNT(e.id) AS election_count,
        COUNT(e.id) FILTER (WHERE e.election_date >= CURRENT_DATE) AS upcoming_election_count,
        (MIN(e.election_date) FILTER (WHERE e.election_date >= CURRENT_DATE))::text AS next_election_date
      FROM public.districts d
      JOIN public.elections e ON e.district_id = d.id
      WHERE d.state = $1
      GROUP BY d.id
      ORDER BY d.district_type ASC, d.name ASC, d.id ASC
    `,
    [state]
  );
  // A state with nothing researched yet is a 404, not an empty page: the
  // states list never links it, and an empty page has nothing to index.
  if (result.rows.length === 0) {
    return null;
  }
  return {
    state,
    name: STATE_NAME_BY_ABBREVIATION[state] ?? state,
    districts: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      district_type: row.district_type,
      election_count: Number(row.election_count),
      upcoming_election_count: Number(row.upcoming_election_count),
      next_election_date: row.next_election_date,
    })),
  };
}

type DistrictHeaderRow = { id: string; name: string; district_type: string; state: string };

type ElectionRow = {
  id: string;
  official_ballot_title: string;
  election_date: string;
  election_stage: string | null;
  race_type: string;
  candidates: BrowseElectionCandidate[] | null;
};

export async function getBrowseDistrict(db: Queryable, districtId: string): Promise<BrowseDistrictResult | null> {
  const district = await db.query<DistrictHeaderRow>(
    `
      SELECT id, name, district_type, state
      FROM public.districts
      WHERE id = $1
    `,
    [districtId]
  );
  const header = district.rows[0];
  // A district in a state we cannot name would breadcrumb to a state page
  // that 404s; the catalog covers the 50 states + DC, same as the sitemap.
  const stateName = header ? STATE_NAME_BY_ABBREVIATION[header.state] : undefined;
  if (!header || !stateName) {
    return null;
  }
  const elections = await db.query<ElectionRow>(
    `
      SELECT
        e.id,
        e.official_ballot_title,
        e.election_date::text AS election_date,
        e.election_stage,
        e.race_type,
        (
          SELECT json_agg(
            json_build_object(
              'candidate_id', c.id,
              'display_name', c.display_name,
              'party', c.party,
              'status', ce.status
            )
            ORDER BY c.display_name ASC, c.id ASC
          )
          FROM public.candidate_elections ce
          JOIN public.candidates c ON c.id = ce.candidate_id
          WHERE ce.election_id = e.id
            AND c.deleted_at IS NULL
            AND c.merged_into_candidate_id IS NULL
        ) AS candidates
      FROM public.elections e
      WHERE e.district_id = $1
      ORDER BY e.election_date DESC, e.official_ballot_title ASC, e.id ASC
    `,
    [districtId]
  );
  // Same rule as the state page: a district with no races is not a page.
  if (elections.rows.length === 0) {
    return null;
  }
  return {
    district: {
      id: header.id,
      name: header.name,
      district_type: header.district_type,
      state: header.state,
      state_name: stateName,
    },
    elections: elections.rows.map((row) => ({
      id: row.id,
      official_ballot_title: row.official_ballot_title,
      election_date: row.election_date,
      election_stage: row.election_stage,
      race_type: row.race_type,
      candidates: row.candidates ?? [],
    })),
  };
}
