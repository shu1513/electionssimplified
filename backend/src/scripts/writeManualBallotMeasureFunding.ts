import { readFile } from "node:fs/promises";
import { Pool } from "pg";

import { verifyHttpUrlReachability } from "../ai/urlReachability.js";
import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerEnv } from "../config/envReaders.js";
import {
  BALLOT_MEASURE_FUNDING_SIDES,
  parseBallotMeasureFundingPayload,
  type BallotMeasureFundingPayload,
} from "../contracts/ballotMeasureFundingPayloadContract.js";
import { upsertBallotMeasureFunding } from "../pipeline/ballotMeasures/ballotMeasureFunding.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

type BallotMeasureRow = {
  ballot_measure_id: string;
  official_ballot_title: string;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:ballot-measure-funding:write -- --election-id uuid --file payload.json [--dry-run]",
    "",
    "Payload: { as_of, support: { committees, top_donors }, oppose: { committees, top_donors } }.",
    "See backend/src/contracts/ballotMeasureFundingPayloadContract.ts.",
  ].join("\n");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--") || value.trim().length === 0) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual ballot measure funding write`);
  }
  return value;
}

// The measure's detail row must exist first: funding hangs off it, and a
// measure with backers but no summary would render as a half-empty page.
async function loadBallotMeasure(pool: Pool, electionId: string): Promise<BallotMeasureRow | null> {
  const result = await pool.query<BallotMeasureRow>(
    `
      SELECT
        bm.id::text AS ballot_measure_id,
        bm.official_ballot_title
      FROM public.ballot_measures AS bm
      WHERE bm.election_id::text = $1
      ORDER BY bm.id
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows[0] ?? null;
}

function collectSourceUrls(payload: BallotMeasureFundingPayload): string[] {
  const urls = new Set<string>();
  for (const side of BALLOT_MEASURE_FUNDING_SIDES) {
    for (const committee of payload.sides[side].committees) {
      urls.add(committee.source_url);
    }
  }
  return [...urls];
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:ballot-measure-funding:write", process.argv.slice(2), [
    { name: "--election-id", value: "space" },
    { name: "--file", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const file = readFlag("--file");
  const electionId = readFlag("--election-id");
  if (!file || !electionId) {
    throw new Error(`Missing --file or --election-id.\n${usage()}`);
  }
  const dryRun = process.argv.includes("--dry-run");

  const parsed = parseBallotMeasureFundingPayload(JSON.parse(await readFile(file, "utf8")) as unknown);
  if (!parsed.ok) {
    throw new Error(`Ballot-measure funding payload failed validation: ${parsed.reason}`);
  }
  const payload = parsed.payload;

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const measure = await loadBallotMeasure(pool, electionId);
    if (!measure) {
      throw new Error(
        `No ballot_measures row for election_id=${electionId}; write the measure with manual:ballot-measure:write first`
      );
    }

    const timeoutMs = readPositiveIntegerEnv("AI_TIMEOUT_MS", 90000);
    for (const url of collectSourceUrls(payload)) {
      const reachability = await verifyHttpUrlReachability(url, { timeoutMs });
      if (!reachability.ok) {
        throw new Error(`Ballot-measure funding source URL is not reachable: ${url} (${reachability.reason})`);
      }
    }

    const summary = {
      electionId,
      ballotMeasureId: measure.ballot_measure_id,
      officialBallotTitle: measure.official_ballot_title,
      asOf: payload.as_of,
      sides: Object.fromEntries(
        BALLOT_MEASURE_FUNDING_SIDES.map((side) => [
          side,
          {
            committeeCount: payload.sides[side].committees.length,
            topDonors: payload.sides[side].top_donors.map((donor) => `${donor.name}: ${donor.amount}`),
          },
        ])
      ),
    };

    if (dryRun) {
      console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await upsertBallotMeasureFunding(client, measure.ballot_measure_id, payload);
      await client.query("COMMIT");
      console.log(JSON.stringify({ ...summary, sidesWritten: result.sidesWritten }, null, 2));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("manual ballot measure funding write failed:", message);
  process.exitCode = 1;
});
