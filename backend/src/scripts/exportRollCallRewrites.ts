import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadProjectEnv } from "../config/env.js";
import {
  describeRollCallDescriptionLengthProblem,
  splitRollCallSentences,
} from "../pipeline/rollcall/rollCallDescriptionLength.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Writes the current yea/nay sentences of one jurisdiction's APPROVED roll
// calls as a rollcall:rewrite file, so an operator edits the text in place
// and applies it. Each entry carries an `_current` note (sentence count,
// characters, and the length problem the gate would raise) — rewrite the
// entries that have one. Read-only; local DB only, no AI.
//
//   npm run rollcall:export-rewrites -- --jurisdiction DE --out <file> [--only-over-limit]

function readValueFlag(argv: readonly string[], flagName: string): string | null {
  const index = argv.indexOf(flagName);
  if (index >= 0) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flagName} requires a value`);
    }
    return value;
  }
  const inline = argv.find((token) => token.startsWith(`${flagName}=`));
  return inline ? inline.slice(flagName.length + 1) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("rollcall:export-rewrites", argv, [
    { name: "--jurisdiction", value: "both" },
    { name: "--out", value: "both" },
    { name: "--only-over-limit", value: "none" },
  ]);
  const jurisdiction = readValueFlag(argv, "--jurisdiction");
  const out = readValueFlag(argv, "--out");
  if (jurisdiction === null || out === null) {
    throw new Error("--jurisdiction and --out are required");
  }
  const onlyOverLimit = argv.includes("--only-over-limit");
  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      chamber: string;
      session: string;
      roll_number: number;
      measure_id: string | null;
      vote_date: string;
      exact_question: string;
      yeas: number;
      nays: number;
      yea_description: string;
      nay_description: string;
    }>(
      `SELECT chamber, session, roll_number, measure_id, vote_date::text AS vote_date, exact_question, yeas, nays,
              yea_description, nay_description
         FROM legislative_votes
        WHERE jurisdiction = $1
          AND review_status = 'approved'
        ORDER BY chamber, session, roll_number`,
      [jurisdiction.toUpperCase()]
    );
    const rewrites = result.rows
      .map((row) => {
        const problem =
          describeRollCallDescriptionLengthProblem(row.yea_description) ??
          describeRollCallDescriptionLengthProblem(row.nay_description);
        return {
          _current: {
            question: row.exact_question,
            tally: `${row.yeas}-${row.nays}`,
            sentences: splitRollCallSentences(row.yea_description).length,
            chars: row.yea_description.length,
            problem,
          },
          jurisdiction: jurisdiction.toUpperCase(),
          chamber: row.chamber,
          session: row.session,
          roll: row.roll_number,
          measure_id: row.measure_id,
          vote_date: row.vote_date,
          yea_description: row.yea_description,
          nay_description: row.nay_description,
        };
      })
      .filter((entry) => !onlyOverLimit || entry._current.problem !== null);
    writeFileSync(out, `${JSON.stringify({ rewrites }, null, 2)}\n`);
    const overLimit = rewrites.filter((entry) => entry._current.problem !== null).length;
    console.log(JSON.stringify({ jurisdiction: jurisdiction.toUpperCase(), out, approved: result.rows.length, exported: rewrites.length, overLimit }));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
