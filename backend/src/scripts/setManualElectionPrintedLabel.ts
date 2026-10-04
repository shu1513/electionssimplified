// Guarded setter for one ballot measure's printed ballot label.
//
// A measure's descriptive title is its permanent identity, so the number a
// state assigns for the paper ballot ("Statewide Amendment 1") cannot be
// written by reinjecting a retitled election. This wrapper stores that label
// in elections.printed_ballot_label on one exactly identified row; readers
// apply it for display and the stored title is left untouched.
import { pathToFileURL } from "node:url";

import { Pool, type PoolClient } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { applyPrintedBallotLabel } from "../pipeline/address/stateBallotOrderRules.js";
import { mergeElectionSource } from "./electionSourceUtils.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LABEL_LENGTH = 80;

type QueryResultLike<T> = { rows: T[] };

export type ElectionPrintedLabelClient = Pick<PoolClient, "query"> & {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type ElectionPrintedLabelOptions = {
  electionId: string;
  label: string;
  sourceUrl: string;
  dryRun: boolean;
};

type ElectionRow = {
  id: string;
  official_ballot_title: string;
  race_type: string;
  printed_ballot_label: string | null;
  sources: unknown;
};

export type ElectionPrintedLabelResult = {
  electionId: string;
  officialBallotTitle: string;
  previousLabel: string | null;
  label: string;
  displayedTitle: string;
  alreadySet: boolean;
  sourceAppended: boolean;
  dryRun: boolean;
};

function usage(): string {
  return [
    "Set the label the paper ballot prints for one ballot measure election.",
    "",
    "Usage:",
    '  npm run manual:election-printed-label:set -- --election-id uuid --label "Statewide Amendment 1" --source-url https://... --reason text [--dry-run]',
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
  if (!value) throw new Error(`${name} is required for setting a printed ballot label`);
  return value;
}

// The label is joined to the stored title as "<label>: <rest>", so a colon or
// line break inside it would produce a title readers cannot split again.
export function parsePrintedBallotLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, " ");
  if (label.length === 0) throw new Error("--label must not be empty");
  if (label.length > MAX_LABEL_LENGTH) {
    throw new Error(`--label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  if (label.includes(":")) throw new Error("--label must not contain a colon");
  return label;
}

function assertHttpsSource(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("--source-url must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("--source-url must use HTTPS");
  }
}

export async function runElectionPrintedLabelSet(
  client: ElectionPrintedLabelClient,
  options: ElectionPrintedLabelOptions
): Promise<ElectionPrintedLabelResult> {
  const { electionId, sourceUrl, dryRun } = options;
  const label = parsePrintedBallotLabel(options.label);
  assertHttpsSource(sourceUrl);

  await client.query("BEGIN");
  try {
    const locked = await client.query<ElectionRow>(
      `
        SELECT
          e.id,
          e.official_ballot_title,
          e.race_type,
          e.printed_ballot_label,
          e.sources
        FROM public.elections e
        WHERE e.id = $1::uuid
        FOR UPDATE OF e
      `,
      [electionId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error(`Election not found: ${electionId}`);
    if (row.race_type !== "ballot_measure") {
      throw new Error(
        `Election ${electionId} is race_type=${row.race_type}; only ballot measures are supported`
      );
    }

    const alreadySet = row.printed_ballot_label === label;
    const { sources, appended: sourceAppended } = mergeElectionSource(row.sources, sourceUrl);

    if (dryRun || (alreadySet && !sourceAppended)) {
      await client.query("ROLLBACK");
    } else {
      await client.query(
        `
          UPDATE public.elections
          SET printed_ballot_label = $2,
              sources = $3::jsonb,
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [electionId, label, JSON.stringify(sources)]
      );
      await client.query("COMMIT");
    }

    return {
      electionId,
      officialBallotTitle: row.official_ballot_title,
      previousLabel: row.printed_ballot_label,
      label,
      displayedTitle: applyPrintedBallotLabel(row.official_ballot_title, label),
      alreadySet,
      sourceAppended,
      dryRun,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:election-printed-label:set", process.argv.slice(2), [
    { name: "--election-id", value: "space" },
    { name: "--label", value: "space" },
    { name: "--source-url", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const electionId = requireFlag("--election-id");
  const label = requireFlag("--label");
  const sourceUrl = requireFlag("--source-url");
  const reason = requireFlag("--reason");
  const dryRun = process.argv.includes("--dry-run");

  if (!UUID_RE.test(electionId)) throw new Error(`Invalid --election-id: ${electionId}`);
  if (reason.length < 20) {
    throw new Error("--reason must explain the label in at least 20 characters");
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await runElectionPrintedLabelSet(client, {
      electionId,
      label,
      sourceUrl,
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
