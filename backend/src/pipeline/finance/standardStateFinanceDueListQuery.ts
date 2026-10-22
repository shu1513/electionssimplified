import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type StandardStateFinanceDueListInput = {
  now: Date;
  staleAfterDays: number;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  /** Optional explicit scope, applied before ordering and LIMIT. */
  candidateId?: string;
  electionYear?: number;
  /** Bypass only staleness; all identity/eligibility/window filters remain. */
  refresh?: boolean;
};

/**
 * Raw row shape produced by the due-list query. The canonical columns are
 * always present; link identity columns (default committee_id/committee_name,
 * overridable via linkColumns) land under their snake_case column names and
 * are read through the index signature by a state's mapRow.
 */
export type StandardStateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
  /** Present only when the config sets selectElectionDate. */
  election_date?: string;
  /** Present only when the config sets selectBallotTitle. */
  ballot_title?: string;
  source_url: string | null;
  last_synced_at: string | null;
  total_due_rows: string | number;
} & Record<string, unknown>;

/** Canonical mapped row for states whose links carry committee_id/committee_name. */
export type StandardStateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type StandardStateFinanceDueListResult<TRow> = {
  rows: TRow[];
  totalDueRows: number;
};

export type StandardStateFinanceDueListQuery<TRow> = (
  db: Queryable,
  input: StandardStateFinanceDueListInput
) => Promise<StandardStateFinanceDueListResult<TRow>>;

export type StandardStateFinanceDueListConfig = {
  /** Two-letter uppercase state code used in the districts.state filter. */
  state: string;
  tables: {
    links: string;
    summaries: string;
  };
  /** "scope::canonical_name" office keys; bound as the $6 array parameter. */
  eligibleOfficeKeys: readonly string[];
  /**
   * Link columns selected between district and source_url — the link identity
   * plus any per-state extras (e.g. link_source, election_period). Defaults to
   * ["committee_id", "committee_name"]. Overriding requires a mapRow, since
   * the default mapper only knows the canonical pair. Interpolated into SQL,
   * so validated as identifiers at construction.
   */
  linkColumns?: readonly string[];
  /**
   * Restrict due links to elections in this stage. Nov-2026-scoped states
   * that link FROM the general roster only pass "general". Interpolated as a
   * literal, so the accepted values are a closed list. Default: no stage
   * filter (every stage the link universe carries).
   */
  electionStage?: "general";
  /**
   * Also select election.election_date::text AS election_date (between
   * election_year and office_scope). Read through mapRow. Default false.
   */
  selectElectionDate?: boolean;
  /**
   * Also select election.official_ballot_title AS ballot_title (between
   * office_name and district). Read through mapRow. Default false.
   */
  selectBallotTitle?: boolean;
};

const ELECTION_STAGES: readonly string[] = ["general"];

const DEFAULT_LINK_COLUMNS: readonly string[] = ["committee_id", "committee_name"];

function assertStateCode(value: string): string {
  if (!/^[A-Z]{2}$/.test(value)) {
    throw new Error(`Invalid standard finance due-list state: ${value}`);
  }
  return value;
}

function assertIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error(`Invalid standard finance table identifier: ${value}`);
  return value;
}

function assertLinkColumn(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid standard finance due-list link column: ${value}`);
  }
  return value;
}

function assertElectionStage(value: string): string {
  if (!ELECTION_STAGES.includes(value)) {
    throw new Error(`Invalid standard finance due-list election stage: ${value}`);
  }
  return value;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapStandardDueRow(row: StandardStateFinanceDueQueryRow): StandardStateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    committeeId: row.committee_id as string,
    committeeName: row.committee_name as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

function buildDueListSql(
  config: StandardStateFinanceDueListConfig,
  scope: { candidateParam?: number; yearParam?: number; refreshParam?: number } = {}
): string {
  const state = assertStateCode(config.state);
  const linksTable = assertIdentifier(config.tables.links);
  const summariesTable = assertIdentifier(config.tables.summaries);
  const linkColumns = config.linkColumns ?? DEFAULT_LINK_COLUMNS;
  if (linkColumns.length === 0) {
    throw new Error("Standard finance due-list link columns must not be empty");
  }
  for (const column of linkColumns) {
    assertLinkColumn(column);
  }
  const innerLinkColumns = linkColumns.map((column) => `          link.${column},`).join("\n");
  const outerLinkColumns = linkColumns.map((column) => `        ${column},`).join("\n");
  // Optional lines are emitted with their trailing newline so an unset option
  // leaves the canonical template byte-identical.
  const electionStage =
    config.electionStage === undefined ? undefined : assertElectionStage(config.electionStage);
  const stageFilter =
    electionStage === undefined ? "" : `          AND election.election_stage = '${electionStage}'\n`;
  const innerElectionDate = config.selectElectionDate
    ? "          election.election_date::text AS election_date,\n"
    : "";
  const outerElectionDate = config.selectElectionDate ? "        election_date,\n" : "";
  const innerBallotTitle = config.selectBallotTitle
    ? "          election.official_ballot_title AS ballot_title,\n"
    : "";
  const outerBallotTitle = config.selectBallotTitle ? "        ballot_title,\n" : "";
  const scopeFilters = [
    ...(scope.candidateParam === undefined
      ? []
      : [`          AND link.candidate_id = $${scope.candidateParam}::uuid\n`]),
    ...(scope.yearParam === undefined
      ? []
      : [
          `          AND link.election_year = $${scope.yearParam}::int\n          AND EXTRACT(YEAR FROM election.election_date)::int = $${scope.yearParam}::int\n`,
        ]),
  ].join("");
  const refreshPrefix =
    scope.refreshParam === undefined ? "" : `            $${scope.refreshParam}::boolean\n            OR`;
  // Race-mates ride along: whenever one candidate of an election is due,
  // every other eligible linked candidate of that same election is synced in
  // the same batch, stale or not. Opponents then always show outside groups
  // (one committee supporting A and opposing B) from the same source
  // snapshot instead of from whichever run each happened to be due in.
  // Race sizes are small (≤10 linked candidates), so the batch stays bounded.
  return `
      WITH eligible AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
${innerElectionDate}          office.scope AS office_scope,
          link.office_name,
${innerBallotTitle}          link.district,
${innerLinkColumns}
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          link.id AS sort_link_id,
          link.candidate_name_normalized AS sort_name,
          election.election_date AS sort_election_date,
          summary.last_synced_at AS sort_synced_at,
          (
${refreshPrefix}${scope.refreshParam === undefined ? "            " : " "}summary.last_synced_at IS NULL
            OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))
          ) AS is_stale
        FROM public.${linksTable} AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.offices AS office
          ON office.id = election.office_id
        LEFT JOIN public.${summariesTable} AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = '${state}'
          AND election.race_type = 'office'
${stageFilter}          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
${scopeFilters}      ),
      due AS (
        SELECT eligible.*, COUNT(*) OVER () AS total_due_rows
        FROM eligible
        WHERE eligible.is_stale
        ORDER BY eligible.sort_synced_at ASC NULLS FIRST,
                 eligible.sort_election_date ASC,
                 eligible.sort_name ASC,
                 eligible.sort_link_id ASC
        LIMIT $3::int
      ),
      batch AS (
        SELECT due.*, 0 AS race_mate
        FROM due
        UNION ALL
        SELECT eligible.*, (SELECT MAX(due.total_due_rows) FROM due), 1 AS race_mate
        FROM eligible
        WHERE eligible.election_id IN (SELECT due.election_id FROM due)
          AND eligible.sort_link_id NOT IN (SELECT due.sort_link_id FROM due)
      )
      SELECT
        candidate_id,
        election_id,
        candidate_name,
        election_year,
${outerElectionDate}        office_scope,
        office_name,
${outerBallotTitle}        district,
${outerLinkColumns}
        source_url,
        last_synced_at,
        total_due_rows
      FROM batch
      ORDER BY race_mate ASC,
               sort_synced_at ASC NULLS FIRST,
               sort_election_date ASC,
               sort_name ASC,
               sort_link_id ASC
    `;
}

/**
 * Builds a state's finance due-list query: active links joined to candidates,
 * candidate_elections, elections, districts, offices, and the summary table,
 * filtered to eligible offices inside the election date window, kept when the
 * summary is missing or stale, ordered stalest-first, limited to
 * maxCandidates, with the pre-limit total exposed as totalDueRows. Every
 * other eligible candidate of a selected row's election is appended (stale
 * or not), so a batch can exceed maxCandidates by those race-mates.
 *
 * Canonical states omit mapRow and get StandardStateFinanceDueRow rows.
 * States with renamed or extra link columns pass linkColumns plus a mapRow
 * that reads them off the raw row. Orchestration (auto-link, validation,
 * loading, the sync loop) stays per-state.
 */
export function createStandardStateFinanceDueListQuery(
  config: StandardStateFinanceDueListConfig & { linkColumns?: undefined; mapRow?: undefined }
): StandardStateFinanceDueListQuery<StandardStateFinanceDueRow>;
export function createStandardStateFinanceDueListQuery<TRow>(
  config: StandardStateFinanceDueListConfig & {
    mapRow: (row: StandardStateFinanceDueQueryRow) => TRow;
  }
): StandardStateFinanceDueListQuery<TRow>;
export function createStandardStateFinanceDueListQuery(
  config: StandardStateFinanceDueListConfig & {
    mapRow?: (row: StandardStateFinanceDueQueryRow) => unknown;
  }
): StandardStateFinanceDueListQuery<unknown> {
  if (config.linkColumns && !config.mapRow) {
    throw new Error("Standard finance due-list linkColumns require a mapRow");
  }
  if (config.eligibleOfficeKeys.length === 0) {
    throw new Error("Standard finance due-list eligible office keys must not be empty");
  }
  const sql = buildDueListSql(config);
  const mapRow = config.mapRow ?? mapStandardDueRow;

  return async (db, input) => {
    if (
      input.candidateId !== undefined &&
      (typeof input.candidateId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.candidateId))
    ) {
      throw new Error("Invalid standard finance due-list candidateId: expected UUID");
    }
    if (
      input.electionYear !== undefined &&
      (!Number.isSafeInteger(input.electionYear) || input.electionYear < 1900 || input.electionYear > 2100)
    ) {
      throw new Error("Invalid standard finance due-list electionYear");
    }
    if (input.refresh !== undefined && typeof input.refresh !== "boolean") {
      throw new Error("Invalid standard finance due-list refresh");
    }
    const parameters: unknown[] = [
      input.now.toISOString(),
      input.staleAfterDays,
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...config.eligibleOfficeKeys],
    ];
    const scope: { candidateParam?: number; yearParam?: number; refreshParam?: number } = {};
    if (input.candidateId !== undefined) scope.candidateParam = parameters.push(input.candidateId);
    if (input.electionYear !== undefined) scope.yearParam = parameters.push(input.electionYear);
    if (input.refresh === true) scope.refreshParam = parameters.push(true);
    const scoped = Object.keys(scope).length > 0;
    const result = await db.query<StandardStateFinanceDueQueryRow>(
      scoped ? buildDueListSql(config, scope) : sql,
      parameters
    );
    return {
      rows: result.rows.map(mapRow),
      totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
    };
  };
}
