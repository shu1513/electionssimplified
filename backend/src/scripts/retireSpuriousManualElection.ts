// Guarded retirement of a spurious election row — a contest that does not
// exist in the real world.
//
// manual:elections:supersede handles duplicate SHELLS: it requires named
// replacement contests, because a duplicate always has a survivor. A
// spurious row has no survivor — discovery invented a contest from nothing
// (live case: a 2026 California "United States Senator" general written by a
// research run; neither CA Senate class is up before 2028). The injector
// cannot retire it (upsert identity keeps the row forever), and supersede
// cannot either, so the invented race keeps consuming downstream work:
// roster deferrals re-trigger, ratings sweeps re-select it, and district
// pages render an empty contest.
//
// Guard rails, all of which must pass before the row is deleted:
// - --reason and --no-contest-source are required: the no-contest fact must
//   be source-verified (e.g. an outlet's "Not Up This Cycle" listing), never
//   inferred from empty local data;
// - every table with a foreign key onto public.elections is checked
//   dynamically (same catalog scan as supersede, so new tables can never be
//   forgotten). Rows in a small allowlist of write-time bookkeeping that the
//   spurious insert itself created are reported and allowed to go with the
//   row (all elections FKs are ON DELETE CASCADE):
//     - election_senate_metadata (written by the same election upsert),
//     - manual_research_deferrals (research bookkeeping for the fake race),
//     - user_district_notification_events still un-sent (write-time
//       fan-out on the election INSERT, not a user action),
//     - current_race_ratings with evidence_status = 'none_found' (the
//       "research found no such race" marker).
//   Everything else blocks: candidate links, follows, choices, results,
//   ballot measures, finance links; a current_race_ratings row with
//   evidence_status = 'rated', because a real outlet rating is evidence the
//   race EXISTS and the operator is deleting the wrong row; and a SENT
//   notification event, because it is the only record of which users were
//   told about the fake race — preserve or export it deliberately first;
// - local-database guard (ALLOW_REMOTE_DB_WRITES=1 covers the deliberate
//   production repair pass), row lock, single transaction, --dry-run.
//
// The delete leaves a tombstone: the same transaction inserts the contest's
// identity (district, title key, date) into retired_election_identities with
// the reason and the no-contest source. The elections writer skips any later
// payload entry that matches it, so a rediscovery cannot write the invented
// race back. See src/pipeline/elections/retiredElectionIdentities.ts.
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { listElectionFkReferences } from "./supersedeManualElection.js";
import {
  findStagingIngestKeysForIdentity,
  insertRetiredElectionIdentity,
} from "../pipeline/elections/retiredElectionIdentities.js";

type QueryResultLike<T> = { rows: T[] };

export type RetireSpuriousElectionClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type RetireSpuriousElectionOptions = {
  electionId: string;
  reason: string;
  noContestSource: string;
  dryRun: boolean;
};

export type RetireSpuriousElectionResult = {
  dryRun: boolean;
  deletedElectionId: string;
  deletedElectionTitle: string;
  electionDate: string;
  districtName: string;
  districtState: string;
  noContestSource: string;
  /** Allowlisted bookkeeping rows that go with the election via cascade. */
  cascadeDeletes: { table: string; rows: number; note?: string }[];
  referencingTablesChecked: number;
  /** The tombstone written alongside the delete (ledgerId is null on a dry run). */
  retiredIdentity: {
    ledgerId: string | null;
    officialBallotTitleKey: string;
    /** 'written' staging rows whose payload still carries this contest. */
    stagingIngestKeys: string[];
  };
};

type ElectionRow = {
  id: string;
  district_id: string;
  election_date: string;
  official_ballot_title: string;
  official_ballot_title_key: string;
  race_type: string | null;
  district_name: string;
  district_state: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Bookkeeping the spurious insert itself fanned out; anything not listed
// here blocks the delete. Keys are schema-stripped table names because
// conrelid::regclass::text renders "public" bare under the default
// search_path but schema-qualified otherwise.
const CASCADE_ALLOWLIST = new Set([
  "election_senate_metadata",
  "manual_research_deferrals",
  "user_district_notification_events",
  "current_race_ratings",
]);

function stripPublicSchema(table: string): string {
  return table.startsWith("public.") ? table.slice("public.".length) : table;
}

function usage(): string {
  return [
    "Delete one spurious election row (a contest that does not exist) after verifying nothing meaningful references it.",
    "",
    "Usage:",
    "  npm run manual:elections:retire-spurious -- --election-id uuid --reason text --no-contest-source url [--dry-run]",
  ].join("\n");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value.trim();
}

function requireFlag(name: string): string {
  const value = readFlag(name);
  if (!value) throw new Error(`Missing ${name}.\n${usage()}`);
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for manual election retirement`);
  return value;
}

export async function runRetireSpuriousElection(
  client: RetireSpuriousElectionClient,
  options: RetireSpuriousElectionOptions
): Promise<RetireSpuriousElectionResult> {
  // PostgreSQL returns uuid columns lowercased; normalize so a valid
  // uppercase input cannot fail comparisons downstream.
  const electionId = options.electionId.toLowerCase();
  const { dryRun } = options;

  await client.query("BEGIN");
  try {
    const lockedResult = await client.query<ElectionRow>(
      `
        SELECT e.id, e.district_id, e.election_date::text, e.official_ballot_title,
               e.official_ballot_title_key, e.race_type,
               d.name AS district_name, d.state AS district_state
        FROM public.elections e
        JOIN public.districts d ON d.id = e.district_id
        WHERE e.id = $1::uuid
        FOR UPDATE OF e
      `,
      [electionId]
    );
    const retired = lockedResult.rows[0];
    if (!retired) throw new Error(`Election not found: ${electionId}`);

    // Reference sweep. Identifiers come from the catalog (regclass /
    // pg_attribute), not from user input.
    const references = await listElectionFkReferences(client);
    const blocking: string[] = [];
    const cascadeDeletes: RetireSpuriousElectionResult["cascadeDeletes"] = [];
    for (const { table, column } of references) {
      const countResult = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1::uuid`,
        [electionId]
      );
      const n = Number(countResult.rows[0]?.n ?? "0");
      if (n === 0) continue;

      const bareTable = stripPublicSchema(table);
      if (!CASCADE_ALLOWLIST.has(bareTable)) {
        blocking.push(`${table}.${column} (${n})`);
        continue;
      }

      if (bareTable === "current_race_ratings") {
        // A rated row means an outlet rates this race — strong evidence the
        // contest is real and the operator picked the wrong election id.
        const ratedResult = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1::uuid AND evidence_status <> 'none_found'`,
          [electionId]
        );
        const rated = Number(ratedResult.rows[0]?.n ?? "0");
        if (rated > 0) {
          blocking.push(`${table}.${column} (${rated} with evidence_status = 'rated' — a real rating means the race exists)`);
          continue;
        }
        cascadeDeletes.push({ table: bareTable, rows: n, note: "evidence_status = 'none_found'" });
        continue;
      }

      if (bareTable === "user_district_notification_events") {
        // Un-sent rows are pure write-time fan-out from the election INSERT
        // and go with it. A SENT row is different in kind: it records that a
        // user was actually told about this race, and cascading it away
        // would erase the only evidence of who received the misinformation.
        // Block so the operator records those users (and decides whether a
        // correction is owed) before deliberately clearing the events.
        const sentResult = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1::uuid AND notified_at IS NOT NULL`,
          [electionId]
        );
        const sent = Number(sentResult.rows[0]?.n ?? "0");
        if (sent > 0) {
          blocking.push(
            `${table}.${column} (${sent} already notified — record who was told about this race and clear those events deliberately before retiring)`
          );
          continue;
        }
        cascadeDeletes.push({ table: bareTable, rows: n, note: `${n} unsent` });
        continue;
      }

      cascadeDeletes.push({ table: bareTable, rows: n });
    }
    if (blocking.length > 0) {
      throw new Error(
        `Election ${electionId} is still referenced and cannot be retired as spurious: ${blocking.join(", ")}. ` +
          "References outside write-time bookkeeping mean this may be a real contest — investigate before deleting."
      );
    }

    // Tombstone first, delete second, one transaction: a retired identity
    // is never left without its ledger row.
    const stagingIngestKeys = await findStagingIngestKeysForIdentity(
      client,
      retired.district_id,
      retired.official_ballot_title_key,
      retired.election_date
    );
    let ledgerId: string | null = null;
    if (!dryRun) {
      const ledger = await insertRetiredElectionIdentity(client, {
        districtId: retired.district_id,
        electionDate: retired.election_date,
        officialBallotTitle: retired.official_ballot_title,
        officialBallotTitleKey: retired.official_ballot_title_key,
        raceType: retired.race_type,
        electionId,
        action: "retired_spurious",
        reason: options.reason,
        sourceUrl: options.noContestSource,
        stagingIngestKey: stagingIngestKeys[0] ?? null,
      });
      ledgerId = ledger.id;
      await client.query(`DELETE FROM public.elections WHERE id = $1::uuid`, [electionId]);
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    return {
      dryRun,
      deletedElectionId: electionId,
      deletedElectionTitle: retired.official_ballot_title,
      electionDate: retired.election_date,
      districtName: retired.district_name,
      districtState: retired.district_state,
      noContestSource: options.noContestSource,
      cascadeDeletes,
      referencingTablesChecked: references.length,
      retiredIdentity: {
        ledgerId,
        officialBallotTitleKey: retired.official_ballot_title_key,
        stagingIngestKeys,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:elections:retire-spurious", process.argv.slice(2), [
    { name: "--election-id", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--no-contest-source", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const electionId = requireFlag("--election-id");
  const reason = requireFlag("--reason");
  const noContestSource = requireFlag("--no-contest-source");
  const dryRun = process.argv.includes("--dry-run");

  if (!UUID_RE.test(electionId)) throw new Error(`Invalid --election-id: ${electionId}`);
  if (reason.length < 20) {
    throw new Error("--reason must explain why the contest does not exist in at least 20 characters");
  }
  let parsedSource: URL;
  try {
    parsedSource = new URL(noContestSource);
  } catch {
    throw new Error(`--no-contest-source must be a URL: ${noContestSource}`);
  }
  if (parsedSource.protocol !== "http:" && parsedSource.protocol !== "https:") {
    throw new Error(`--no-contest-source must be an http(s) URL: ${noContestSource}`);
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await runRetireSpuriousElection(client, {
      electionId,
      reason,
      noContestSource,
      dryRun,
    });
    console.log(JSON.stringify({ ...result, reason }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
