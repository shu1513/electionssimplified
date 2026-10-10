import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type StandardStateFinanceMissingLinksInput = {
  now: Date;
  /**
   * Row cap. Omitted means no cap (bound as NULL, which Postgres reads as
   * LIMIT ALL): states whose auto-link resolves in memory enumerate every
   * eligible candidate so a stable ORDER BY + LIMIT cannot starve the tail.
   */
  maxCandidates?: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
};

/** A candidate election with no active finance link, ready for a resolver. */
export type StandardStateFinanceMissingLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type StandardStateFinanceMissingLinksQuery = (
  db: Queryable,
  input: StandardStateFinanceMissingLinksInput
) => Promise<StandardStateFinanceMissingLinkCandidateElection[]>;

export type StandardStateFinanceMissingLinksConfig = {
  /** Two-letter uppercase state code used in the districts.state filter. */
  state: string;
  /** Links table checked by the NOT EXISTS; interpolated, so validated as an identifier. */
  linksTable: string;
  /** "scope::canonical_name" office keys; bound as the $5 array parameter. */
  eligibleOfficeKeys: readonly string[];
};

type MissingLinkQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
};

function assertStateCode(value: string): string {
  if (!/^[A-Z]{2}$/.test(value)) {
    throw new Error(`Invalid standard finance missing-links state: ${value}`);
  }
  return value;
}

function assertIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid standard finance missing-links table identifier: ${value}`);
  }
  return value;
}

function mapRow(row: MissingLinkQueryRow): StandardStateFinanceMissingLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
  };
}

function buildMissingLinksSql(config: StandardStateFinanceMissingLinksConfig): string {
  const state = assertStateCode(config.state);
  const linksTable = assertIdentifier(config.linksTable);
  return `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(
              regexp_replace(
                substring(district.geoid_compact from char_length(district.state_fips) + 1),
                '^0+',
                ''
              ),
              ''
            )
          ELSE NULL
        END AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE candidate.deleted_at IS NULL
        AND district.state = '${state}'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.${linksTable} AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $2::int
    `;
}

/**
 * Builds a state's missing-links query: candidate elections for eligible
 * offices inside the election date window whose candidate has a display
 * name and no active row in the state's links table, ordered by election
 * date then name, capped by maxCandidates (NULL = no cap). Rows carry the
 * fields an auto-link resolver needs; resolving, link writing, caps and
 * error reporting stay per-state.
 *
 * Deliberately separate from the due-list builder: this query reads from
 * candidate_elections rather than the links table and derives name, office
 * and district from the election rows, so only the filter shape overlaps.
 */
export function createStandardStateFinanceMissingLinksQuery(
  config: StandardStateFinanceMissingLinksConfig
): StandardStateFinanceMissingLinksQuery {
  if (config.eligibleOfficeKeys.length === 0) {
    throw new Error("Standard finance missing-links eligible office keys must not be empty");
  }
  const sql = buildMissingLinksSql(config);

  return async (db, input) => {
    const result = await db.query<MissingLinkQueryRow>(sql, [
      input.now.toISOString(),
      // NULL means LIMIT ALL in Postgres — enumerate every eligible candidate.
      input.maxCandidates ?? null,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...config.eligibleOfficeKeys],
    ]);
    return result.rows.map(mapRow);
  };
}
