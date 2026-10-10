import { readFile } from "node:fs/promises";
import { Pool } from "pg";

import { verifyHttpUrlReachability } from "../ai/urlReachability.js";
import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerEnv } from "../config/envReaders.js";
import {
  parseOptionalBallotMeasureProposedBy,
  type BallotMeasureProposedBy,
} from "../contracts/ballotMeasureProposedByPayloadContract.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { usLatestLocalDateIso } from "../utils/usLocalDate.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Manual (no AI provider) research workflow for who put a ballot measure on
// the ballot, shown under the measure summary with a plain-language
// explainer and its source (ballot_measures.proposed_by*).
//
// The full measure payload (manual:ballot-measure:write) also accepts a
// proposed_by key, but re-supplying a measure's summary and yes/no text just
// to add its proposer would churn reviewed wording. This writer touches the
// proposer columns only.
//
// Subcommands:
//   due    List measures on upcoming ballots whose proposer was never
//          researched — the work queue.
//   write  Validate one researched payload and update the measure.

type Subcommand = "due" | "write";

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:ballot-measure-proposed-by:due -- [--state XX] [--limit 500] [--include-past]",
    "  npm run manual:ballot-measure-proposed-by:write -- --election-id uuid --file payload.json [--dry-run]",
    "",
    "The write payload shape:",
    '  { "proposed_by": { "name": "...", "about": "...", "source_url": "https://..." } }',
    '  { "proposed_by": null }   (researched; no official source names the proposer)',
    "",
    "See backend/src/contracts/ballotMeasureProposedByPayloadContract.ts.",
  ].join("\n");
}

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value.trim();
  }
  const inlinePrefix = `${name}=`;
  const inline = argv.find((token) => token.startsWith(inlinePrefix));
  if (inline) {
    const value = inline.slice(inlinePrefix.length).trim();
    if (value.length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual ballot measure proposed-by`);
  }
  return value;
}

function parseStateFlag(argv: readonly string[]): string | null {
  const raw = readFlag(argv, "--state");
  if (raw === null) {
    return null;
  }
  const state = raw.toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new Error(`--state must be a two-letter code, got: ${raw}`);
  }
  return state;
}

type DueMeasureRow = {
  election_id: string;
  ballot_measure_id: string;
  state: string;
  district_name: string;
  election_date: string;
  official_ballot_title: string;
  official_measure_url: string | null;
  source_urls: unknown;
};

async function runDue(pool: Pool, argv: readonly string[]): Promise<void> {
  const stateFilter = parseStateFlag(argv);
  const limit = readPositiveIntegerFlag(argv, "--limit", 500);
  const includePast = argv.includes("--include-past");
  const today = usLatestLocalDateIso();

  // Upcoming first: the proposer serves the races voters see now. Measures
  // researched with no sourced proposer carry the stamp and drop out.
  const result = await pool.query<DueMeasureRow>(
    `
      SELECT
        e.id::text AS election_id,
        bm.id::text AS ballot_measure_id,
        d.state,
        d.name AS district_name,
        e.election_date::text AS election_date,
        bm.official_ballot_title,
        bm.official_measure_url,
        bm.source_url AS source_urls
      FROM public.ballot_measures AS bm
      JOIN public.elections AS e
        ON e.id = bm.election_id
      JOIN public.districts AS d
        ON d.id = e.district_id
      WHERE bm.proposed_by_researched_at IS NULL
        AND ($1::boolean OR e.election_date >= $2::date)
        AND ($3::text IS NULL OR d.state = $3)
      ORDER BY e.election_date, d.state, d.name, bm.official_ballot_title
      LIMIT $4
    `,
    [includePast, today, stateFilter, limit]
  );

  const measures = result.rows.map((row) => ({
    election_id: row.election_id,
    ballot_measure_id: row.ballot_measure_id,
    state: row.state,
    district_name: row.district_name,
    election_date: row.election_date,
    official_ballot_title: row.official_ballot_title,
    official_measure_url: row.official_measure_url,
    // The measure's own sources usually name the enabling bill or petition.
    source_urls: Array.isArray(row.source_urls) ? row.source_urls.filter((url) => typeof url === "string") : [],
  }));

  console.log(
    JSON.stringify(
      {
        asOf: today,
        stateFilter,
        includePast,
        count: measures.length,
        limitReached: measures.length >= limit,
        measures,
      },
      null,
      2
    )
  );
}

type BallotMeasureRow = {
  ballot_measure_id: string;
  official_ballot_title: string;
  election_date: string;
  proposed_by: string | null;
  proposed_by_researched_at: string | null;
};

async function loadBallotMeasure(pool: Pool, electionId: string): Promise<BallotMeasureRow | null> {
  const result = await pool.query<BallotMeasureRow>(
    `
      SELECT
        bm.id::text AS ballot_measure_id,
        bm.official_ballot_title,
        e.election_date::text AS election_date,
        bm.proposed_by,
        bm.proposed_by_researched_at::text AS proposed_by_researched_at
      FROM public.ballot_measures AS bm
      JOIN public.elections AS e
        ON e.id = bm.election_id
      WHERE bm.election_id::text = $1
      ORDER BY bm.id
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows[0] ?? null;
}

async function runWrite(pool: Pool, argv: readonly string[]): Promise<void> {
  const file = readFlag(argv, "--file");
  const electionId = readFlag(argv, "--election-id");
  if (!file || !electionId) {
    throw new Error(`Missing --file or --election-id.\n${usage()}`);
  }
  const dryRun = argv.includes("--dry-run");

  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Payload must be an object.\n${usage()}`);
  }
  const parsed = parseOptionalBallotMeasureProposedBy((raw as Record<string, unknown>).proposed_by);
  if (!parsed.ok) {
    throw new Error(`Ballot-measure proposed_by payload failed validation: ${parsed.reason}`);
  }
  if (parsed.proposedBy === undefined) {
    throw new Error(`Payload must include a proposed_by key (object, or null when no official source names the proposer).\n${usage()}`);
  }
  let proposedBy: BallotMeasureProposedBy | null = parsed.proposedBy;

  // The measure's detail row must exist first: the proposer hangs off it.
  const measure = await loadBallotMeasure(pool, electionId);
  if (!measure) {
    throw new Error(
      `No ballot_measures row for election_id=${electionId}; write the measure with manual:ballot-measure:write first`
    );
  }

  if (proposedBy) {
    // Voters see this link as the evidence for the name: same reachability
    // bar as the measure's own sources (403 allowed — anti-bot edges answer
    // 403 to Node and 200 to browsers).
    const timeoutMs = Math.min(readPositiveIntegerEnv("AI_TIMEOUT_MS", 90000), 15_000);
    const reachability = await verifyHttpUrlReachability(proposedBy.source_url, { timeoutMs, allowStatusCodes: [403] });
    if (!reachability.ok) {
      throw new Error(`proposed_by source_url is not reachable: ${proposedBy.source_url} (${reachability.reason})`);
    }
    proposedBy = { ...proposedBy, source_url: reachability.finalUrl };
  }

  const summary = {
    electionId,
    ballotMeasureId: measure.ballot_measure_id,
    officialBallotTitle: measure.official_ballot_title,
    electionDate: measure.election_date,
    previous: {
      proposedBy: measure.proposed_by,
      researchedAt: measure.proposed_by_researched_at,
    },
    proposedBy,
  };

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
    return;
  }

  await pool.query(
    `
      UPDATE public.ballot_measures
      SET
        proposed_by = $2,
        proposed_by_about = $3,
        proposed_by_source_url = $4,
        proposed_by_researched_at = now(),
        updated_at = now()
      WHERE id::text = $1
    `,
    [measure.ballot_measure_id, proposedBy?.name ?? null, proposedBy?.about ?? null, proposedBy?.source_url ?? null]
  );
  console.log(JSON.stringify({ ...summary, written: true }, null, 2));
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand !== "due" && subcommand !== "write") {
    throw new Error(`Unknown subcommand: ${subcommand ?? "(none)"}.\n${usage()}`);
  }
  const command: Subcommand = subcommand;
  if (command === "due") {
    assertKnownCliFlags("manual:ballot-measure-proposed-by:due", rest, [
      { name: "--state", value: "space" },
      { name: "--limit", value: "space" },
      { name: "--include-past", value: "none" },
    ]);
  } else {
    assertKnownCliFlags("manual:ballot-measure-proposed-by:write", rest, [
      { name: "--election-id", value: "space" },
      { name: "--file", value: "space" },
      { name: "--dry-run", value: "none" },
    ]);
  }
  loadProjectEnv();

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (command === "due") {
      await runDue(pool, rest);
    } else {
      await runWrite(pool, rest);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("manual ballot measure proposed-by failed:", message);
  process.exitCode = 1;
});
