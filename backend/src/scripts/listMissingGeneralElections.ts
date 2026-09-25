import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { usLatestLocalDateIso } from "../utils/usLocalDate.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Read-only gap report: primaries whose general was never imported.
//
// Importing a primary without its general leaves the ballot half-blind — the
// Michigan Aug-2026 statewide primaries shipped while the November Governor
// race didn't exist at all, so voters saw who advanced but not the race they
// advanced TO. This report is the standing guard against that pattern: a
// primary implies a later round, so every office-race primary must be
// followed, in the same district and for the same contest, by a later
// election within the horizon. The list of violations IS the to-be-researched
// queue — recomputed from the elections table each run, so a general imported
// through any path clears its gap instantly and a newly imported primary
// surfaces one, with no queue state to drift.
//
// A row leaves the report one of three ways:
//   - the general is researched and imported (manual:elections:inject) — the
//     normal outcome;
//   - research finds the primary legitimately ends the contest (majority-win
//     judicial primaries, charter rules like Honolulu's exactly-two-filers) —
//     record an elections-stage deferral on the primary
//     (manual:deferral:record) and manual:deferral:due owns it from there;
//   - the primary itself was bad data and gets superseded/corrected.
//
// Louisiana November primaries are NOT gaps: the jungle primary IS the
// November election, and its next round (a December runoff) exists only when
// no candidate clears 50%. Those rows are reported in a separate bucket so
// the operator can see them without them drowning the real gaps. The
// carve-out is Louisiana-only and the two queries are exact complements —
// a November or December primary anywhere else still expects a later round
// and stays gap-eligible, and no primary can fall between the buckets.
//
// Contest matching: office_id vouches for a later row only when this
// district+office holds a single primary that day — seat-per-title races
// (city council districts, judicial positions) share one office_id, and one
// seat's general must not clear the other seats' gaps (verified live: Cape
// Coral council districts, WA Supreme Court positions). When sibling
// primaries exist, or office_id is absent, official_ballot_title_key
// identity decides — unless both rows carry offices that disagree, which
// marks different contests sharing a title. Residual: a multi-seat contest
// whose OTHER seats' primaries were never imported has no sibling to betray
// it, so a different seat's general can still clear it; importing the full
// primary set is what closes that hole. Any later same-contest election
// counts — general, runoff, or unstaged — because the report's question is
// "does the next round exist at all", not "is its stage labeled correctly".
//
// Third rule, for titles that name the same seat differently across rounds
// (verified live 2026-09-24: Pima "Constable, Justice Prec. 2" vs
// "Constable, Justice Prec. 2, Pima County, Arizona"; "Cape Coral City
// Council District 6" vs "City of Cape Coral City Council District 6";
// Canyon County "County Commissioner District 1" vs "Commissioner District
// 1"): both title keys are reduced to a contest key by stripping the
// district's own name / state as a suffix and a leading "City of <name>",
// "<name>" or "County" prefix. Equal contest keys vouch only when the key
// carries a seat token (district/precinct/position number) — so they still
// tell sibling seats apart — and the offices don't disagree.

type Queryable = Pick<Pool, "query">;

export type MissingGeneralElectionRow = {
  election_id: string;
  district_id: string;
  state: string | null;
  district_name: string | null;
  district_type: string | null;
  official_ballot_title: string | null;
  election_date: string;
  office_id: string | null;
  linked_candidate_count: number;
  // True when a decisive result row (won/advanced/runoff) exists for the
  // primary — winners are recorded as advancing to a race that isn't there,
  // the loudest version of the gap.
  has_decisive_result: boolean;
};

export type MissingGeneralElectionsInput = {
  asOfDate: string;
  /** How far back a primary may lie and still be reported. */
  lookbackDays: number;
  /** How far ahead a primary may lie and still be reported. */
  lookaheadDays: number;
  /** How long after the primary its next round may plausibly fall. */
  horizonDays: number;
  /** Optional two-letter state filter (uppercase). */
  state?: string;
  /** Optional district filter (the demand ledger scopes to one ballot). */
  districtIds?: readonly string[];
};

// Matches a normalized district name's trailing jurisdiction word ("cape
// coral city" -> "cape coral"), so a title can drop the bare place name.
const JURISDICTION_WORD_PATTERN = "(city|town|village|borough|county|parish|township|municipality|cdp)";

function normalizedTextSql(expr: string): string {
  return `btrim(regexp_replace(lower(coalesce(${expr}, '')), '[^a-z0-9]+', ' ', 'g'))`;
}

/**
 * SQL expression reducing a title key to its contest key: the district's own
 * name / state stripped as a suffix, then a leading "City of <name>" /
 * "<name>" / "County" prefix. `titleKeyExpr` must already be a normalized
 * official_ballot_title_key (lowercase, single spaces); `districtNameExpr` is
 * the raw districts.name ("Pima County, Arizona"), normalized here the same
 * way so it is safe to splice into a regex (only [a-z0-9 ] remain).
 * Every strip needs a non-empty remainder, so a title that IS the district
 * name is left whole. Exported for the Postgres-backed test.
 */
export function contestKeySql(titleKeyExpr: string, districtNameExpr: string): string {
  const fullName = normalizedTextSql(districtNameExpr);
  const baseName = normalizedTextSql(`split_part(${districtNameExpr}, ',', 1)`);
  const stateName = normalizedTextSql(`nullif(split_part(${districtNameExpr}, ',', 2), '')`);
  const bareName = `regexp_replace(${baseName}, ' ${JURISDICTION_WORD_PATTERN}$', '')`;
  const stripSuffix = (expr: string, name: string) =>
    `CASE WHEN ${name} <> '' AND ${expr} LIKE '_% ' || ${name} THEN left(${expr}, length(${expr}) - length(${name}) - 1) ELSE ${expr} END`;
  const withoutSuffix = stripSuffix(stripSuffix(stripSuffix(titleKeyExpr, fullName), baseName), stateName);
  const withoutPlacePrefix = `regexp_replace(${withoutSuffix}, '^(${JURISDICTION_WORD_PATTERN} of )?' || ${bareName} || ' (?=.)', '')`;
  return `regexp_replace(${withoutPlacePrefix}, '^county (?=.)', '')`;
}

// A contest key vouches only when it names a seat: a district, precinct,
// ward, position or seat number. Without one, sibling seats could collapse.
const SEAT_TOKEN_PATTERN = "\\m[0-9]+[a-z]?\\M";

/**
 * SQL predicate: the two title keys name the same seat once the district's
 * own name is stripped (see contestKeySql), and that key carries a seat
 * token. Exported for the Postgres-backed test.
 */
export function sameSeatContestKeySql(primaryKeyExpr: string, laterKeyExpr: string, districtNameExpr: string): string {
  const primaryContestKey = contestKeySql(primaryKeyExpr, districtNameExpr);
  return `(${contestKeySql(laterKeyExpr, districtNameExpr)} = ${primaryContestKey} AND ${primaryContestKey} ~ '${SEAT_TOKEN_PATTERN}')`;
}

const MISSING_GENERALS_SQL = `
  SELECT
    e.id::text AS election_id,
    e.district_id::text AS district_id,
    d.state,
    d.name AS district_name,
    d.district_type,
    e.official_ballot_title,
    e.election_date::text AS election_date,
    e.office_id::text AS office_id,
    linked.linked_candidate_count,
    EXISTS (
      SELECT 1
      FROM public.election_results AS er
      WHERE er.election_id = e.id
        AND er.outcome IN ('won', 'advanced', 'runoff')
    ) AS has_decisive_result
  FROM public.elections AS e
  JOIN public.districts AS d
    ON d.id = e.district_id
  JOIN LATERAL (
    SELECT count(*)::int AS linked_candidate_count
    FROM public.candidate_elections AS ce
    WHERE ce.election_id = e.id
  ) AS linked ON true
  WHERE e.race_type = 'office'
    AND e.election_stage = 'primary'
    AND e.election_date >= ($1::date - make_interval(days => $2::int))
    AND e.election_date <= ($1::date + make_interval(days => $3::int))
    AND ($5::text IS NULL OR d.state = $5::text)
    AND ($6::uuid[] IS NULL OR e.district_id = ANY($6::uuid[]))
    -- Louisiana's fall jungle primaries are terminal-stage: the November
    -- race IS the general and a runoff exists only when required. Only that
    -- verified jurisdiction is excluded — a November or December primary
    -- anywhere else still expects a later round. Exact complement of
    -- listTerminalStagePrimaries, so no primary falls between the buckets.
    AND NOT (d.state = 'LA' AND EXTRACT(MONTH FROM e.election_date) >= 11)
    -- The gap itself: no later same-contest election in this district
    -- within the horizon. Stage is deliberately ignored on the later row —
    -- the question is whether the next round exists at all.
    AND NOT EXISTS (
      SELECT 1
      FROM public.elections AS g
      WHERE g.district_id = e.district_id
        AND g.id <> e.id
        AND g.election_date > e.election_date
        AND (g.election_date - e.election_date)::int <= $4::int
        AND (
          -- office_id vouches only when this district+office holds a single
          -- primary that day: seat-per-title races (city council districts,
          -- judicial positions) share one office_id, and one seat's general
          -- must not clear the other seats' gaps.
          (
            e.office_id IS NOT NULL
            AND g.office_id = e.office_id
            AND NOT EXISTS (
              SELECT 1
              FROM public.elections AS sibling
              WHERE sibling.district_id = e.district_id
                AND sibling.office_id = e.office_id
                AND sibling.election_stage = 'primary'
                AND sibling.election_date = e.election_date
                AND sibling.id <> e.id
            )
          )
          -- Title-key identity vouches unless both rows carry offices that
          -- disagree — different contests sharing a title.
          OR (
            g.official_ballot_title_key = e.official_ballot_title_key
            AND (e.office_id IS NULL OR g.office_id IS NULL OR g.office_id = e.office_id)
          )
          -- Contest-key identity: the same seat titled with and without the
          -- district's name ("..., Pima County, Arizona", "City of Cape
          -- Coral ...", "County Commissioner ..."). Needs a seat token so
          -- sibling seats stay apart, and offices must not disagree.
          OR (
            ${sameSeatContestKeySql("e.official_ballot_title_key", "g.official_ballot_title_key", "d.name")}
            AND (e.office_id IS NULL OR g.office_id IS NULL OR g.office_id = e.office_id)
          )
        )
    )
    -- An open elections-stage deferral proves research already established
    -- why no general is expected (or when it can be researched).
    -- manual:deferral:due owns those rows.
    AND NOT EXISTS (
      SELECT 1
      FROM public.manual_research_deferrals AS mrd
      WHERE mrd.status = 'deferred'
        AND mrd.stage = 'elections'
        AND (
          mrd.election_id = e.id
          OR (mrd.election_id IS NULL AND mrd.district_id = e.district_id)
        )
    )
  ORDER BY d.state ASC NULLS LAST, e.election_date ASC, d.name ASC, e.official_ballot_title ASC, e.id ASC
`;

export async function listMissingGeneralElections(
  db: Queryable,
  input: MissingGeneralElectionsInput
): Promise<MissingGeneralElectionRow[]> {
  const result = await db.query<MissingGeneralElectionRow>(MISSING_GENERALS_SQL, [
    input.asOfDate,
    input.lookbackDays,
    input.lookaheadDays,
    input.horizonDays,
    input.state ?? null,
    input.districtIds ? [...input.districtIds] : null,
  ]);
  return result.rows;
}

export type TerminalStagePrimaryRow = {
  election_id: string;
  state: string | null;
  district_name: string | null;
  district_type: string | null;
  official_ballot_title: string | null;
  election_date: string;
};

/**
 * Louisiana fall (jungle) primaries in the same window, for visibility only:
 * their next round is a conditional runoff, so "no later election" is their
 * normal state, not a gap. Louisiana-only — this is the exact complement of
 * the gap query's carve-out, so no primary falls between the buckets.
 * Reported so the operator knows they were considered and excluded rather
 * than missed.
 */
export async function listTerminalStagePrimaries(
  db: Queryable,
  input: MissingGeneralElectionsInput
): Promise<TerminalStagePrimaryRow[]> {
  const result = await db.query<TerminalStagePrimaryRow>(
    `
      SELECT
        e.id::text AS election_id,
        d.state,
        d.name AS district_name,
        d.district_type,
        e.official_ballot_title,
        e.election_date::text AS election_date
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      WHERE e.race_type = 'office'
        AND e.election_stage = 'primary'
        AND e.election_date >= ($1::date - make_interval(days => $2::int))
        AND e.election_date <= ($1::date + make_interval(days => $3::int))
        AND ($4::text IS NULL OR d.state = $4::text)
        AND d.state = 'LA'
        AND EXTRACT(MONTH FROM e.election_date) >= 11
      ORDER BY d.state ASC NULLS LAST, e.election_date ASC, d.name ASC, e.official_ballot_title ASC, e.id ASC
    `,
    [input.asOfDate, input.lookbackDays, input.lookaheadDays, input.state ?? null]
  );
  return result.rows;
}

function readStateFlag(argv: readonly string[]): string | undefined {
  const flagIndex = argv.indexOf("--state");
  const inline = argv.find((token) => token.startsWith("--state="));
  const rawValue = flagIndex >= 0 ? argv[flagIndex + 1] : inline ? inline.slice("--state=".length) : null;
  if (flagIndex >= 0 && rawValue === undefined) {
    throw new Error("--state requires a value");
  }
  if (rawValue === null || rawValue === undefined) {
    return undefined;
  }
  const normalized = rawValue.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`--state must be a two-letter state code, got: ${rawValue}`);
  }
  return normalized;
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:elections:missing-generals", process.argv.slice(2), [
    { name: "--lookback-days", value: "both" },
    { name: "--lookahead-days", value: "both" },
    { name: "--horizon-days", value: "both" },
    { name: "--state", value: "both" },
  ]);
  loadProjectEnv();

  const argv = process.argv.slice(2);
  const lookbackDays = readPositiveIntegerFlag(argv, "--lookback-days", 180);
  const lookaheadDays = readPositiveIntegerFlag(argv, "--lookahead-days", 365);
  const horizonDays = readPositiveIntegerFlag(argv, "--horizon-days", 365);
  const state = readStateFlag(argv);
  // US-local boundary, not UTC: after UTC midnight a UTC date would shift
  // which primaries fall inside the window.
  const asOfDate = usLatestLocalDateIso();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the missing-generals report");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const input: MissingGeneralElectionsInput = { asOfDate, lookbackDays, lookaheadDays, horizonDays, state };
    const gaps = await listMissingGeneralElections(pool, input);
    const terminalStagePrimaries = await listTerminalStagePrimaries(pool, input);

    const gapsByState = new Map<string, number>();
    for (const gap of gaps) {
      const key = gap.state ?? "??";
      gapsByState.set(key, (gapsByState.get(key) ?? 0) + 1);
    }

    console.log(
      JSON.stringify(
        {
          asOfDate,
          lookbackDays,
          lookaheadDays,
          horizonDays,
          ...(state ? { state } : {}),
          queueSemantics: {
            gaps: "primaries with no later same-contest election — research and import the general (manual:elections:inject), or record an elections-stage deferral (manual:deferral:record) when the primary legitimately ends the contest",
            terminalStagePrimaries:
              "Louisiana fall (jungle) primaries: the general IS this race and a runoff exists only when required — listed for visibility, never as gaps",
          },
          gapCount: gaps.length,
          gapCountByState: Object.fromEntries([...gapsByState.entries()].sort()),
          gaps,
          terminalStagePrimaryCount: terminalStagePrimaries.length,
          terminalStagePrimaries,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("missing-generals report failed:", message);
    process.exitCode = 1;
  });
}
