import type { Pool, PoolClient } from "pg";

import type { ElectionDistrictType, ElectionRaceType, ElectionStage, OfficeScope } from "../../types/election.js";
import type { CandidateElectionStatus } from "../../types/electionResults.js";
import { isUuid } from "../../utils/uuid.js";
import { displayElectionTitle } from "../../utils/displayElectionTitle.js";
import { US_LATEST_LOCAL_DATE_SQL } from "../../utils/usLocalDate.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type CandidateDetailFollow = {
  notify_elections: boolean;
  notify_updates: boolean;
  created_at: string;
};

export type CandidateDetailResearchAreaTag = {
  research_area_id: string;
  slug: string;
  name: string;
  stance: "for" | "against" | null;
};

export type CandidateDetailRecord = {
  id: string;
  description: string;
  source_url: string;
  event_date: string;
  created_at: string;
  research_area_tags: CandidateDetailResearchAreaTag[];
};

// Keep candidate detail election links compact. Election-specific finance stays on
// GET /api/elections/:election_id to avoid duplicating ballot lookup finance logic here.
export type CandidateDetailElectionDistrict = {
  id: string;
  name: string;
  district_type: ElectionDistrictType;
  state: string;
};

export type CandidateDetailElection = {
  candidate_election_id: string;
  election_id: string;
  district: CandidateDetailElectionDistrict;
  race_type: ElectionRaceType;
  official_ballot_title: string;
  election_date: string;
  election_stage: ElectionStage | null;
  is_partisan: boolean | null;
  is_incumbent: boolean;
  status: CandidateElectionStatus;
  /** elections.seats_to_fill; NULL means "not recorded", which renders as a
   * single seat (migration 190). The choice UI uses this for its seat cap. */
  seats_to_fill: number | null;
  office_scope: OfficeScope | null;
  office_canonical_name: string | null;
};

export type CandidateDetailCandidate = {
  candidate_id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  party: string;
  state: string;
  current_office: string | null;
  summary: string | null;
  twitter_handle: string | null;
  linkedin_url: string | null;
  official_website_url: string | null;
  fec_ids: string[];
  state_filing_ids: string[];
  profile_sources: string[];
  last_researched: string | null;
  // Date the candidate's record history has been researched through
  // (candidates.last_records_researched_through). Null means no records
  // search has completed yet, so an empty `records` array is "not researched"
  // rather than "researched and none found" — clients use this to tell the
  // two apart.
  records_researched_through: string | null;
  records: CandidateDetailRecord[];
  elections: CandidateDetailElection[];
  is_following: boolean;
  follow: CandidateDetailFollow | null;
};

export type CandidateDetailResult = {
  candidate: CandidateDetailCandidate;
};

export type CandidateDetailReaderErrorCode = "invalid_candidate_id" | "invalid_user_id";

export class CandidateDetailReaderError extends Error {
  constructor(
    readonly code: CandidateDetailReaderErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CandidateDetailReaderError";
  }
}

type CandidateDetailRow = {
  candidate_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  party: string | null;
  state: string | null;
  current_office: string | null;
  summary: string | null;
  twitter_handle: string | null;
  linkedin_url: string | null;
  official_website_url: string | null;
  fec_ids: unknown;
  state_filing_ids: unknown;
  profile_sources: unknown;
  last_researched: string | null;
  records_researched_through: string | null;
};

type CandidateFollowRow = {
  notify_elections: boolean | null;
  notify_updates: boolean | null;
  created_at: string | Date | null;
};

type CandidateRecordRow = {
  candidate_record_id: string;
  description: string;
  source_url: string;
  event_date: string;
  created_at: string;
};

type CandidateRecordTagRow = {
  candidate_record_id: string;
  research_area_id: string;
  slug: string;
  name: string;
  stance: string | null;
};

type CandidateElectionRow = {
  candidate_election_id: string;
  election_id: string;
  district_id: string;
  district_type: ElectionDistrictType;
  district_name: string;
  district_state: string;
  race_type: ElectionRaceType;
  official_ballot_title: string;
  election_date: string;
  election_stage: ElectionStage | null;
  is_partisan: boolean | null;
  is_incumbent: boolean;
  status: CandidateElectionStatus;
  seats_to_fill: number | null;
  office_scope: OfficeScope | null;
  office_canonical_name: string | null;
};

export type CandidateDetailLookupInput = {
  candidateId: string;
  userId?: string | null;
};

function normalizeCandidateId(candidateId: string): string {
  const normalized = candidateId.trim();
  if (!isUuid(normalized)) {
    throw new CandidateDetailReaderError("invalid_candidate_id", "Candidate ID must be a valid UUID");
  }
  return normalized;
}

function normalizeOptionalUserId(userId: string | null | undefined): string | null {
  if (userId === undefined || userId === null) {
    return null;
  }
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new CandidateDetailReaderError("invalid_user_id", "User ID must be a valid UUID");
  }
  return normalized;
}

function formatTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeResearchAreaStance(stance: string | null): "for" | "against" | null {
  return stance === "for" || stance === "against" ? stance : null;
}

function rowToCandidate(
  row: CandidateDetailRow,
  records: CandidateDetailRecord[],
  elections: CandidateDetailElection[],
  follow: CandidateDetailFollow | null
): CandidateDetailCandidate {
  return {
    candidate_id: row.candidate_id,
    display_name: row.display_name ?? "",
    first_name: row.first_name,
    last_name: row.last_name,
    date_of_birth: row.date_of_birth,
    party: row.party ?? "",
    state: row.state ?? "",
    current_office: row.current_office,
    summary: row.summary,
    twitter_handle: row.twitter_handle,
    linkedin_url: row.linkedin_url,
    official_website_url: row.official_website_url,
    fec_ids: parseStringArray(row.fec_ids),
    state_filing_ids: parseStringArray(row.state_filing_ids),
    profile_sources: parseStringArray(row.profile_sources),
    last_researched: row.last_researched,
    records_researched_through: row.records_researched_through,
    records,
    elections,
    is_following: follow !== null,
    follow,
  };
}

// Candidate detail is a candidate-wide view, so records keep ALL their area
// tags here — including areas outside any single election office's allowed
// set. Election-scoped views (ballot lookup) filter tags to the election
// office's allowed research areas instead; see loadFullElectionDetails in
// pipeline/address/ballotLookup.ts.
async function lookupCandidateRecords(
  db: Queryable,
  normalizedCandidateId: string
): Promise<CandidateDetailRecord[]> {
  const recordResult = await db.query<CandidateRecordRow>(
    `
      SELECT
        record.id::text AS candidate_record_id,
        record.description,
        record.source_url,
        record.event_date::text AS event_date,
        record.created_at::text AS created_at
      FROM public.candidate_records AS record
      WHERE record.candidate_id = $1::uuid
        AND record.retired_at IS NULL
      ORDER BY record.event_date DESC, record.created_at DESC, record.id
    `,
    [normalizedCandidateId]
  );

  if (recordResult.rows.length === 0) {
    return [];
  }

  const recordIds = recordResult.rows.map((row) => row.candidate_record_id);
  const tagResult = await db.query<CandidateRecordTagRow>(
    `
      SELECT
        tag.candidate_record_id::text AS candidate_record_id,
        research_area.id::text AS research_area_id,
        research_area.slug,
        research_area.name,
        tag.stance
      FROM public.candidate_record_area_tags AS tag
      JOIN public.research_areas AS research_area
        ON research_area.id = tag.research_area_id
      WHERE tag.candidate_record_id = ANY($1::uuid[])
      ORDER BY tag.candidate_record_id, research_area.slug
    `,
    [recordIds]
  );

  const tagsByRecord = new Map<string, CandidateDetailResearchAreaTag[]>();
  for (const tag of tagResult.rows) {
    const list = tagsByRecord.get(tag.candidate_record_id) ?? [];
    list.push({
      research_area_id: tag.research_area_id,
      slug: tag.slug,
      name: tag.name,
      stance: normalizeResearchAreaStance(tag.stance),
    });
    tagsByRecord.set(tag.candidate_record_id, list);
  }

  return recordResult.rows.map((record) => ({
    id: record.candidate_record_id,
    description: record.description,
    source_url: record.source_url,
    event_date: record.event_date,
    created_at: record.created_at,
    research_area_tags: tagsByRecord.get(record.candidate_record_id) ?? [],
  }));
}

async function lookupCandidateElections(
  db: Queryable,
  normalizedCandidateId: string
): Promise<CandidateDetailElection[]> {
  const result = await db.query<CandidateElectionRow>(
    `
      SELECT
        candidate_election.id::text AS candidate_election_id,
        election.id::text AS election_id,
        district.id::text AS district_id,
        district.district_type,
        district.name AS district_name,
        district.state AS district_state,
        election.race_type,
        election.official_ballot_title,
        election.election_date::text AS election_date,
        election.election_stage,
        election.is_partisan,
        -- is_incumbent describes the row's ticket lead, not the running mate;
        -- never claim incumbency for a running-mate match.
        CASE
          WHEN candidate_election.candidate_id = $1::uuid THEN candidate_election.is_incumbent
          ELSE FALSE
        END AS is_incumbent,
        candidate_election.status,
        election.seats_to_fill,
        office.scope AS office_scope,
        office.canonical_name AS office_canonical_name
      FROM public.candidate_elections AS candidate_election
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE (candidate_election.candidate_id = $1::uuid
        -- Schema uniqueness is per role, so a candidate can hold their own row
        -- and appear as a running mate in the same election; keep only the own
        -- row then or the page would list the election twice.
        OR (candidate_election.running_mate_candidate_id = $1::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM public.candidate_elections AS own_link
            WHERE own_link.candidate_id = $1::uuid
              AND own_link.election_id = candidate_election.election_id
          )))
      ORDER BY
        CASE WHEN election.election_date >= ${US_LATEST_LOCAL_DATE_SQL} THEN 0 ELSE 1 END ASC,
        CASE WHEN election.election_date >= ${US_LATEST_LOCAL_DATE_SQL} THEN election.election_date END ASC,
        CASE WHEN election.election_date < ${US_LATEST_LOCAL_DATE_SQL} THEN election.election_date END DESC,
        election.official_ballot_title ASC,
        candidate_election.id ASC
    `,
    [normalizedCandidateId]
  );

  return result.rows.map((row) => ({
    candidate_election_id: row.candidate_election_id,
    election_id: row.election_id,
    district: {
      id: row.district_id,
      name: row.district_name,
      district_type: row.district_type,
      state: row.district_state,
    },
    race_type: row.race_type,
    official_ballot_title: displayElectionTitle(row.official_ballot_title),
    election_date: row.election_date,
    election_stage: row.election_stage,
    is_partisan: row.is_partisan,
    is_incumbent: row.is_incumbent,
    status: row.status,
    seats_to_fill: row.seats_to_fill,
    office_scope: row.office_scope,
    office_canonical_name: row.office_canonical_name,
  }));
}

async function lookupCandidateFollow(
  db: Queryable,
  normalizedUserId: string,
  normalizedCandidateId: string
): Promise<CandidateDetailFollow | null> {
  const result = await db.query<CandidateFollowRow>(
    `
      SELECT
        follow.notify_elections,
        follow.notify_updates,
        follow.created_at
      FROM public.users AS user_row
      JOIN public.user_candidate_follows AS follow
        ON follow.user_id = user_row.id
       AND follow.candidate_id = $2::uuid
      WHERE user_row.id = $1::uuid
        AND user_row.deleted_at IS NULL
      LIMIT 1
    `,
    [normalizedUserId, normalizedCandidateId]
  );
  const row = result.rows[0];
  if (!row?.created_at) {
    return null;
  }

  return {
    notify_elections: row.notify_elections ?? true,
    notify_updates: row.notify_updates ?? true,
    created_at: formatTimestamp(row.created_at),
  };
}

export async function lookupCandidateDetailById(
  db: Queryable,
  input: CandidateDetailLookupInput
): Promise<CandidateDetailResult | null> {
  const normalizedCandidateId = normalizeCandidateId(input.candidateId);
  const normalizedUserId = normalizeOptionalUserId(input.userId);

  const result = await db.query<CandidateDetailRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          trim(concat_ws(' ', candidate.first_name, candidate.last_name))
        ) AS display_name,
        candidate.first_name,
        candidate.last_name,
        candidate.date_of_birth::text AS date_of_birth,
        candidate.party,
        candidate.state,
        candidate.current_office,
        candidate.summary,
        candidate.twitter_handle,
        candidate.linkedin_url,
        candidate.official_website_url,
        candidate.fec_ids,
        candidate.state_filing_ids,
        candidate.profile_sources,
        candidate.last_researched::text AS last_researched,
        candidate.last_records_researched_through::text AS records_researched_through
      FROM public.candidates AS candidate
      WHERE candidate.id = $1::uuid
        AND candidate.deleted_at IS NULL
        AND candidate.merged_into_candidate_id IS NULL
      LIMIT 1
    `,
    [normalizedCandidateId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const records = await lookupCandidateRecords(db, normalizedCandidateId);
  const elections = await lookupCandidateElections(db, normalizedCandidateId);
  const follow = normalizedUserId ? await lookupCandidateFollow(db, normalizedUserId, normalizedCandidateId) : null;

  return {
    candidate: rowToCandidate(row, records, elections, follow),
  };
}
