import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN } from "../contracts/candidateProfilePayloadContract.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { usLatestLocalDateIso } from "../utils/usLocalDate.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Read-only work queue for "no public information" profile summaries.
//
// A profile pass that finds nothing citable writes the fixed placeholder
// sentence (NO_PUBLIC_INFO_SUMMARY_PATTERN) and records a candidate_profile
// deferral with a recheck date. This command lists every placeholder on an
// upcoming ballot with the deferral that covers it, so a later session can
// re-research the candidate and replace the sentence with
// `--replace-profile-fields summary`. Each row is classified:
//   - due:               the covering deferral's blocked_until has passed
//   - waiting:           the covering deferral is still in the future
//   - missing_deferral:  no open candidate_profile deferral covers the
//                        candidate — a placeholder with no recheck date is a
//                        defect; record one or research now
//
// A deferral covers the candidate when it is district-wide, election-wide
// (no candidate blocker key), or keyed to the candidate
// (blocker_key profile-<first 8 chars of the candidate id>). The same
// coverage rule drives the demand ledger's candidate_profile gap, so a row
// this command calls due is a row manual:demand:status and the city-coverage
// report also show — and a candidate is waiting while any covering deferral
// is still in the future, even if its own candidate-keyed one has expired.

type Queryable = Pick<Pool, "query">;

export type NoInfoProfileSummaryStatus = "due" | "waiting" | "missing_deferral";

export type NoInfoProfileSummaryRow = {
  candidate_id: string;
  display_name: string;
  summary: string;
  election_id: string;
  district_id: string;
  state: string | null;
  official_ballot_title: string | null;
  election_date: string;
  election_stage: string | null;
  deferral_id: string | null;
  deferral_blocker_key: string | null;
  deferral_blocked_until: string | null;
  deferral_reason: string | null;
  status: NoInfoProfileSummaryStatus;
};

type QueryRow = Omit<NoInfoProfileSummaryRow, "status">;

export const NO_INFO_PROFILE_SUMMARIES_SQL = `
  SELECT
    c.id::text AS candidate_id,
    c.display_name,
    btrim(c.summary) AS summary,
    e.id::text AS election_id,
    e.district_id::text AS district_id,
    d.state,
    e.official_ballot_title,
    e.election_date::text AS election_date,
    e.election_stage,
    m.id::text AS deferral_id,
    m.blocker_key AS deferral_blocker_key,
    m.blocked_until::text AS deferral_blocked_until,
    m.reason AS deferral_reason
  FROM public.candidates AS c
  JOIN public.candidate_elections AS ce ON ce.candidate_id = c.id AND ce.status <> 'withdrawn'
  JOIN public.elections AS e ON e.id = ce.election_id
  JOIN public.districts AS d ON d.id = e.district_id
  LEFT JOIN LATERAL (
    SELECT m.id, m.blocker_key, m.blocked_until, m.reason
    FROM public.manual_research_deferrals AS m
    WHERE m.status = 'deferred'
      AND m.stage = 'candidate_profile'
      AND (m.election_id = e.id OR (m.election_id IS NULL AND m.district_id = e.district_id))
      AND (
        m.blocker_key IS NULL
        OR m.blocker_key NOT LIKE 'profile-%'
        OR m.blocker_key = 'profile-' || left(c.id::text, 8)
      )
    -- A live deferral wins over an expired one, however specific: the
    -- demand ledger hides the candidate while ANY covering deferral is in
    -- the future, and the status here must agree. Among equally live (or
    -- equally expired) rows, the candidate-keyed one is the row to resolve.
    ORDER BY (m.blocked_until > $1::date) DESC,
      (m.blocker_key = 'profile-' || left(c.id::text, 8)) DESC NULLS LAST,
      m.blocked_until ASC
    LIMIT 1
  ) AS m ON TRUE
  WHERE c.deleted_at IS NULL
    AND c.merged_into_candidate_id IS NULL
    AND btrim(c.summary) ~ '${NO_PUBLIC_INFO_SUMMARY_SQL_PATTERN.replace(/'/g, "''")}'
    AND e.race_type = 'office'
    AND e.election_date >= $1::date
    AND ($2::uuid IS NULL OR e.district_id = $2::uuid)
  ORDER BY (m.id IS NULL) DESC, m.blocked_until ASC NULLS FIRST, e.election_date ASC, c.display_name ASC, e.id ASC
`;

export function classifyNoInfoProfileSummary(
  row: Pick<QueryRow, "deferral_id" | "deferral_blocked_until">,
  asOfDate: string
): NoInfoProfileSummaryStatus {
  if (row.deferral_id === null || row.deferral_blocked_until === null) {
    return "missing_deferral";
  }
  return row.deferral_blocked_until <= asOfDate ? "due" : "waiting";
}

export async function listNoInfoProfileSummaries(
  db: Queryable,
  input: { asOfDate: string; districtId?: string | null; dueOnly?: boolean; limit?: number }
): Promise<NoInfoProfileSummaryRow[]> {
  const result = await db.query<QueryRow>(NO_INFO_PROFILE_SUMMARIES_SQL, [input.asOfDate, input.districtId ?? null]);
  const rows = result.rows.map((row) => ({ ...row, status: classifyNoInfoProfileSummary(row, input.asOfDate) }));
  // "Due" for the operator means actionable now: past its date, or never
  // given a date at all.
  const filtered = input.dueOnly ? rows.filter((row) => row.status !== "waiting") : rows;
  return input.limit !== undefined ? filtered.slice(0, input.limit) : filtered;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("manual:candidate-profile:placeholders", argv, [
    { name: "--as-of", value: "space" },
    { name: "--district-id", value: "space" },
    { name: "--limit", value: "space" },
    { name: "--due", value: "none" },
  ]);
  loadProjectEnv();
  const asOfDate = readStrictFlagValue(argv, "--as-of") ?? usLatestLocalDateIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error(`Invalid --as-of: ${asOfDate}. Expected YYYY-MM-DD.`);
  }
  const districtId = readStrictFlagValue(argv, "--district-id");
  const limit = readStrictPositiveIntegerFlag(argv, "--limit");
  const dueOnly = argv.includes("--due");

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the candidate-profile placeholder list");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const rows = await listNoInfoProfileSummaries(pool, { asOfDate, districtId, dueOnly, limit });
    const counts: Record<NoInfoProfileSummaryStatus, number> = { due: 0, waiting: 0, missing_deferral: 0 };
    for (const row of rows) {
      counts[row.status] += 1;
    }
    console.log(
      JSON.stringify(
        {
          asOfDate,
          dueOnly,
          statusSemantics: {
            due: "recheck date passed; re-research, then --replace-profile-fields summary and manual:deferral:resolve",
            waiting: "recheck date still ahead; leave it",
            missing_deferral: "placeholder with no open candidate_profile deferral; record one (blocker-key profile-<first 8 of candidate id>) or research now",
          },
          counts,
          rows,
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
    console.error("candidate-profile placeholder list failed:", message);
    process.exitCode = 1;
  });
}
