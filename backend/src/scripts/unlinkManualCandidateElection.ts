// Guarded single-link removal for research errors.
//
// When research wrongly linked a candidate to an election they were never in,
// the link is our mistake, not election news: it is deleted outright, no
// withdrawn status, no follower notification (notifying followers about our
// own error is noise). A real dropout is different — use
// manual:candidate-elections:withdraw, which keeps the row as history and
// notifies election-alert followers.
//
// Guard rails, all of which must pass before a single row changes:
// - the link (candidate, election) exists and is row-locked;
// - no persisted election_results row names this candidate as a winner:
//   winners JSON references candidate_elections ids, which a delete would
//   dangle (manual:candidate-elections:move keeps the broader election-wide
//   check because it rewrites the link's election);
// - no candidate-scoped election FK rows exist for the pair (state finance
//   links etc., discovered dynamically from the catalog): those rows assert
//   the pairing was real, so a "research error" delete under them is
//   contradictory — resolve them first;
// - unsent notification events for the pair are deleted in the same
//   transaction (an unsent "on the ballot" line for a link that never should
//   have existed is wrong); sent ones cannot be recalled;
// - local-database guard, single transaction, --dry-run (executes everything
//   and rolls back, so the reported counts are real).
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { listCandidateScopedElectionFkTables } from "./moveManualCandidateElectionLink.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";

type QueryResultLike<T> = { rows: T[]; rowCount?: number | null };

export type UnlinkCandidateElectionClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type UnlinkCandidateElectionOptions = {
  candidateId: string;
  electionId: string;
  dryRun: boolean;
};

export type UnlinkCandidateElectionResult = {
  action: "unlinked";
  dryRun: boolean;
  candidateId: string;
  electionId: string;
  electionTitle: string;
  linkStatus: string;
  staleNotificationEventsDeleted: number;
};

type LinkRow = {
  id: string;
  status: string;
};

type ElectionRow = {
  id: string;
  official_ballot_title: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "Delete one candidate_elections link that research created in error.",
    "",
    "Usage:",
    "  npm run manual:candidate-elections:unlink -- --candidate-id uuid --election-id uuid --reason text [--dry-run]",
    "",
    "For a candidate who actually dropped out, use",
    "manual:candidate-elections:withdraw instead — it keeps the row as history",
    "and notifies election-alert followers.",
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
  if (!value) throw new Error(`${name} is required for manual candidate-election unlink`);
  return value;
}

export async function runUnlinkCandidateElection(
  client: UnlinkCandidateElectionClient,
  options: UnlinkCandidateElectionOptions
): Promise<UnlinkCandidateElectionResult> {
  // PostgreSQL returns uuid columns lowercased; a valid uppercase input
  // would otherwise fail the row-matching below with a false "not found".
  const candidateId = options.candidateId.toLowerCase();
  const electionId = options.electionId.toLowerCase();
  const { dryRun } = options;

  await client.query("BEGIN");
  try {
    const linkResult = await client.query<LinkRow>(
      `
        SELECT id, status
        FROM public.candidate_elections
        WHERE candidate_id = $1::uuid AND election_id = $2::uuid
        FOR UPDATE
      `,
      [candidateId, electionId]
    );
    const link = linkResult.rows[0];
    if (!link) {
      throw new Error(
        `No candidate_elections link found for candidate ${candidateId} on election ${electionId}`
      );
    }
    // A non-declared status asserts recorded history: 'withdrawn' is an
    // evidence-backed manual record (followers may already have been told),
    // and result statuses are settled outcomes. Deleting such a link as a
    // "research error" is a compound mess that needs a user decision, not a
    // silent wrapper path.
    if (link.status !== "declared") {
      throw new Error(
        `Link ${link.id} has status '${link.status}', which asserts recorded history; refusing a ` +
          "research-error unlink. If that status itself is wrong, resolve it first (user decision), then re-run."
      );
    }

    // Locked like manual:candidate-elections:move locks its elections: the
    // guards below must not pass on a row a concurrent election edit (date
    // correction, supersede) is changing mid-transaction.
    const electionResult = await client.query<ElectionRow>(
      `
        SELECT id, official_ballot_title
        FROM public.elections
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [electionId]
    );
    const election = electionResult.rows[0];
    if (!election) {
      throw new Error(`Election not found: ${electionId}`);
    }

    // Persisted-results guard: election_results.winners stores
    // candidate_election_id inside JSON, which the FK scan below cannot see
    // into; deleting the link would leave a winner entry dangling. Only a
    // winner entry that names THIS link (or this candidate) is a dangle risk.
    // A result row that names other winners proves nothing about this pair —
    // live 2026-09-16: Brown County WI's August primary results name the
    // Republican sheriff nominee only, while the wrongly linked Democrat
    // (whose only contest that day was Assembly District 88) was un-removable
    // under the old election-wide check.
    const persistedResults = await client.query<{ id: string }>(
      `
        SELECT r.id
        FROM public.election_results r
        WHERE r.election_id = $1::uuid
          AND jsonb_typeof(r.winners) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(r.winners) AS w
            WHERE w->>'candidate_election_id' = $2::text
               OR w->>'candidate_id' = $3::text
          )
        LIMIT 1
      `,
      [electionId, link.id, candidateId]
    );
    if (persistedResults.rows[0]) {
      throw new Error(
        `Election ${electionId} has persisted election_results rows whose winners reference ` +
          "this candidate; refusing unlink — resolve the result rows first (user decision), then re-run."
      );
    }

    // Election-scoped candidate rows (state finance links etc.) assert the
    // pairing was real; deleting the link as a "research error" under them is
    // contradictory. Identifiers come from the catalog, not user input.
    // The follow-notification events table matches the scan's shape (FK to
    // elections + candidate_id column) but is explicitly handled below —
    // unsent events are deleted, sent ones tolerated (they cannot be
    // recalled) — so it must not trip the conflict guard it precedes.
    const fkTables = (await listCandidateScopedElectionFkTables(client)).filter(
      ({ table }) => table !== "public.user_candidate_follow_notification_events"
    );
    const conflicting: string[] = [];
    for (const { table, electionColumn } of fkTables) {
      const countResult = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE candidate_id = $1::uuid AND ${electionColumn} = $2::uuid`,
        [candidateId, electionId]
      );
      const n = Number(countResult.rows[0]?.n ?? "0");
      if (n > 0) conflicting.push(`${table} (${n})`);
    }
    if (conflicting.length > 0) {
      throw new Error(
        `Candidate has election-scoped rows for this pairing that contradict a research-error unlink: ${conflicting.join(", ")}. ` +
          "Resolve those rows first (user decision), then re-run."
      );
    }

    // A link that never should have existed must not leave "on the ballot"
    // (or withdrawal) lines in anyone's digest. Sent events cannot be
    // recalled.
    const staleEvents = await client.query(
      `
        DELETE FROM public.user_candidate_follow_notification_events
        WHERE candidate_id = $1::uuid
          AND election_id = $2::uuid
          AND notified_at IS NULL
      `,
      [candidateId, electionId]
    );

    await client.query(`DELETE FROM public.candidate_elections WHERE id = $1::uuid`, [link.id]);

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
    return {
      action: "unlinked",
      dryRun,
      candidateId,
      electionId,
      electionTitle: election.official_ballot_title,
      linkStatus: link.status,
      staleNotificationEventsDeleted: staleEvents.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:candidate-elections:unlink", process.argv.slice(2), [
    { name: "--candidate-id", value: "space" },
    { name: "--election-id", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const candidateId = requireFlag("--candidate-id");
  const electionId = requireFlag("--election-id");
  const reason = requireFlag("--reason");
  const dryRun = process.argv.includes("--dry-run");

  for (const [name, value] of [
    ["--candidate-id", candidateId],
    ["--election-id", electionId],
  ] as const) {
    if (!UUID_RE.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  }
  if (reason.length < 20) {
    throw new Error("--reason must explain the research error in at least 20 characters");
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await runUnlinkCandidateElection(client, { candidateId, electionId, dryRun });
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
