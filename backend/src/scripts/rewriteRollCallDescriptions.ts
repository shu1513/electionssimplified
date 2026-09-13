import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadProjectEnv } from "../config/env.js";
import { buildCandidateRecordIdentityKey } from "../pipeline/candidates/candidateRecordStore.js";
import {
  applyLegislativeVoteDescriptionRewrite,
  type LegislativeVoteDescriptionRewrite,
} from "../pipeline/rollcall/legislativeVoteStore.js";
import { LEGISLATIVE_VOTE_CHAMBERS, type LegislativeVoteChamber } from "../pipeline/rollcall/legislativeVotes.js";
import { describeRollCallDescriptionLengthProblem } from "../pipeline/rollcall/rollCallDescriptionLength.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Rewords APPROVED roll calls in place — the description-length campaign
// (2026-09-13; see rollCallDescriptionLength.ts). For each entry in a
// rewrites file it (1) updates the roll call's yea/nay sentences through
// the same tally + length gates an approval passes, keeping labels, dates
// and review status untouched, then (2) rewrites every live
// `rollcall_import` record of that roll whose text is byte-equal to the
// OLD yea or nay sentence: new description, recomputed identity key, an
// identity transition (so research:promote follows the re-key) and a
// plain_language_rewrites audit row. Records whose text no longer matches
// (hand-edited since fan-out) are counted and listed, never touched.
// Tags, event dates, source URLs, and origin_run_id do not move. One
// transaction for the whole file; --dry-run runs every statement and
// rolls back. Local DB only, no AI.
//
//   npm run rollcall:export-rewrites -- --jurisdiction DE --out <file>   (current text, edit in place)
//   npm run rollcall:rewrite -- --rewrites-file <file> --dry-run
//   npm run rollcall:rewrite -- --rewrites-file <file>
//
// rewrites file:
//   { "rewrites": [ { "jurisdiction": "DE", "chamber": "house", "session": "2163",
//       "roll": 1529458, "measure_id": "HB 67", "vote_date": "2025-03-27",
//       "yea_description": "...", "nay_description": "..." } ] }
// Keys starting with "_" are operator notes and ignored.

const TRANSITION_REASON = "plain_language_rewrite";
const AUDIT_PROVIDER = "manual";
const AUDIT_MODEL = "rollcall-rewrite";

function fail(index: number, message: string): never {
  throw new Error(`rewrites[${index}]: ${message}`);
}

function readText(index: number, value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(index, `${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parseRewritesFile(raw: unknown): LegislativeVoteDescriptionRewrite[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("rewrites file must be an object with a rewrites array");
  }
  const { rewrites } = raw as { rewrites?: unknown };
  if (!Array.isArray(rewrites) || rewrites.length === 0) {
    throw new Error("rewrites must be a non-empty array");
  }
  const seen = new Set<string>();
  return rewrites.map((element, index) => {
    if (typeof element !== "object" || element === null || Array.isArray(element)) {
      fail(index, "must be an object");
    }
    const entry = element as Record<string, unknown>;
    const jurisdiction = readText(index, entry.jurisdiction, "jurisdiction");
    const chamber = entry.chamber;
    if (typeof chamber !== "string" || !(LEGISLATIVE_VOTE_CHAMBERS as readonly string[]).includes(chamber)) {
      fail(index, `chamber must be one of ${LEGISLATIVE_VOTE_CHAMBERS.join(", ")}`);
    }
    const session = readText(index, entry.session, "session");
    const roll = entry.roll;
    if (typeof roll !== "number" || !Number.isSafeInteger(roll) || roll < 1) {
      fail(index, "roll must be a positive integer");
    }
    const measureId = entry.measure_id;
    if (measureId !== null && (typeof measureId !== "string" || measureId.trim().length === 0)) {
      fail(index, "measure_id must be a non-empty string, or null for a vote with no measure");
    }
    const voteDate = entry.vote_date;
    if (typeof voteDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(voteDate)) {
      fail(index, "vote_date must be an ISO date (YYYY-MM-DD)");
    }
    const key = `${jurisdiction}:${chamber}:${session}:${roll}`;
    if (seen.has(key)) {
      fail(index, `${key} appears more than once`);
    }
    seen.add(key);
    return {
      jurisdiction,
      chamber: chamber as LegislativeVoteChamber,
      session,
      rollNumber: roll,
      measureId: measureId === null ? null : (measureId as string).trim(),
      voteDate,
      yeaDescription: readText(index, entry.yea_description, "yea_description"),
      nayDescription: readText(index, entry.nay_description, "nay_description"),
    };
  });
}

type Queryable = Pick<Pool, "query">;

type RollResult = {
  roll: string;
  outcome: "unchanged" | "updated";
  rewritten: number;
  leftAlone: number;
  leftAloneIds: string[];
};

/**
 * Rewrites the live fan-out records of one roll call whose text equals the
 * old yea or nay sentence. Exported for the per-roll walk in main() and
 * for tests; the caller owns the transaction.
 */
/** "Voted to pass Senate Bill 627, which ..." -> "Voted to pass Senate Bill 627". */
export function rollCallOpener(description: string): string {
  const match = /^(.*?)(?:, |\. )/.exec(description);
  return match ? match[1]! : description;
}

export async function rewriteRollCallRecords(
  client: Queryable,
  input: {
    rewrite: LegislativeVoteDescriptionRewrite;
    oldYeaDescription: string;
    oldNayDescription: string;
    /**
     * Also rewrite records that carry an earlier revision of the same digest:
     * same opener as the old yea/nay sentence and still over the length gate.
     * Records someone already shortened by hand are still left alone.
     */
    staleToo?: boolean;
  }
): Promise<{ rewritten: number; leftAlone: number; leftAloneIds: string[] }> {
  const { rewrite } = input;
  const yeaOpener = rollCallOpener(input.oldYeaDescription);
  const nayOpener = rollCallOpener(input.oldNayDescription);
  const staleMatch = (description: string): string | null => {
    if (!input.staleToo || yeaOpener === nayOpener) {
      return null;
    }
    if (describeRollCallDescriptionLengthProblem(description) === null) {
      return null;
    }
    const startsWithOpener = (opener: string) =>
      description.startsWith(`${opener}, `) || description.startsWith(`${opener}. `);
    if (startsWithOpener(yeaOpener)) {
      return rewrite.yeaDescription;
    }
    if (startsWithOpener(nayOpener)) {
      return rewrite.nayDescription;
    }
    return null;
  };
  const prefix = `rollcall:${rewrite.jurisdiction}:${rewrite.chamber}:${rewrite.session}:${rewrite.rollNumber}:`;
  const records = await client.query<{
    id: string;
    candidate_id: string;
    description: string;
    source_url: string;
    event_date: string;
    record_identity_key: string;
  }>(
    `SELECT id, candidate_id, description, source_url, event_date::text AS event_date, record_identity_key
       FROM public.candidate_records
      WHERE origin = 'rollcall_import'
        AND starts_with(origin_run_id, $1)
        AND retired_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [prefix]
  );
  let rewritten = 0;
  const leftAloneIds: string[] = [];
  for (const record of records.rows) {
    const next =
      record.description === input.oldYeaDescription
        ? rewrite.yeaDescription
        : record.description === input.oldNayDescription
          ? rewrite.nayDescription
          : staleMatch(record.description);
    if (next === null) {
      leftAloneIds.push(record.id);
      continue;
    }
    if (next === record.description) {
      continue;
    }
    const newKey = buildCandidateRecordIdentityKey({
      description: next,
      sourceUrl: record.source_url,
      eventDate: record.event_date,
    });
    const updated = await client.query(
      `UPDATE public.candidate_records
          SET description = $3,
              record_identity_key = $4,
              updated_at = now()
        WHERE id = $1
          AND record_identity_key = $2
          AND description = $5
          AND retired_at IS NULL`,
      [record.id, record.record_identity_key, next, newKey, record.description]
    );
    if (updated.rowCount !== 1) {
      throw new Error(`record ${record.id} changed under the rewrite (key ${record.record_identity_key})`);
    }
    if (newKey !== record.record_identity_key) {
      await client.query(
        `INSERT INTO public.candidate_record_identity_transitions
           (candidate_id, old_record_identity_key, new_record_identity_key, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (candidate_id, old_record_identity_key, new_record_identity_key) DO NOTHING`,
        [record.candidate_id, record.record_identity_key, newKey, TRANSITION_REASON]
      );
    }
    await client.query(
      `INSERT INTO public.plain_language_rewrites
         (target_table, target_id, target_column, status, original_text, rewritten_text, flag_reason, provider, model)
       VALUES ('candidate_records', $1, 'description', 'applied', $2, $3, NULL, $4, $5)
       ON CONFLICT (target_table, target_id, target_column) DO UPDATE
         SET status = 'applied',
             original_text = EXCLUDED.original_text,
             rewritten_text = EXCLUDED.rewritten_text,
             flag_reason = NULL,
             provider = EXCLUDED.provider,
             model = EXCLUDED.model,
             created_at = now()`,
      [record.id, record.description, next, AUDIT_PROVIDER, AUDIT_MODEL]
    );
    rewritten += 1;
  }
  return { rewritten, leftAlone: leftAloneIds.length, leftAloneIds };
}

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
  assertKnownCliFlags("rollcall:rewrite", argv, [
    { name: "--rewrites-file", value: "both" },
    { name: "--dry-run", value: "none" },
    { name: "--stale-too", value: "none" },
  ]);
  const rewritesFile = readValueFlag(argv, "--rewrites-file");
  if (rewritesFile === null) {
    throw new Error("--rewrites-file is required");
  }
  const dryRun = argv.includes("--dry-run");
  const staleToo = argv.includes("--stale-too");
  const entries = parseRewritesFile(JSON.parse(readFileSync(rewritesFile, "utf8")) as unknown);
  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const rows: RollResult[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        const roll = `${entry.jurisdiction}:${entry.chamber}:${entry.session}:${entry.rollNumber}`;
        const applied = await applyLegislativeVoteDescriptionRewrite(client, entry);
        if (applied.outcome === "unchanged" && !staleToo) {
          rows.push({ roll, outcome: "unchanged", rewritten: 0, leftAlone: 0, leftAloneIds: [] });
          continue;
        }
        const result = await rewriteRollCallRecords(client, {
          rewrite: entry,
          oldYeaDescription: applied.oldYeaDescription,
          oldNayDescription: applied.oldNayDescription,
          staleToo,
        });
        rows.push({ roll, outcome: applied.outcome, ...result, leftAloneIds: result.leftAloneIds.slice(0, 5) });
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  const totals = rows.reduce(
    (sum, row) => ({
      updatedRolls: sum.updatedRolls + (row.outcome === "updated" ? 1 : 0),
      unchangedRolls: sum.unchangedRolls + (row.outcome === "unchanged" ? 1 : 0),
      rewrittenRecords: sum.rewrittenRecords + row.rewritten,
      leftAloneRecords: sum.leftAloneRecords + row.leftAlone,
    }),
    { updatedRolls: 0, unchangedRolls: 0, rewrittenRecords: 0, leftAloneRecords: 0 }
  );
  console.log(JSON.stringify({ rewritesFile, dryRun, rolls: rows.length, ...totals, rows }, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
