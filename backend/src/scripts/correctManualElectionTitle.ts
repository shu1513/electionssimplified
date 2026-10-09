// Guarded in-place correction of one election's official ballot title.
//
// The title is part of the election upsert identity (district_id,
// official_ballot_title_key, election_date), so a wrong title cannot be fixed
// through the injector: a corrected payload inserts a SECOND election shell
// next to the old one, and manual:elections:supersede cannot remove the old
// one while a ballot_measures detail row points at it (live cases: a Toledo
// charter-amendment measure naming the wrong charter sections; a Canutillo
// ISD trustee contest whose combined "(3 full terms; 1 unexpired term)" title
// went stale after the short term was split into its own election).
//
// This wrapper updates the title on one exactly identified row and recomputes
// official_ballot_title_key with the same builder the elections writer uses,
// so the row keeps its id and every dependent row (candidate links, measure
// detail, printed label, deferrals, finance links) stays attached.
//
// Guard rails, all of which have to pass before a single row changes:
// - the new title must not collide with another election in the same
//   district and date (that situation is a duplicate shell and wants
//   manual:elections:supersede or a link move, not a retitle);
// - a stored printed label must not repeat at the start of the new title
//   (readers show "<label>: <title after its colon>");
// - an HTTPS source documenting the corrected title is appended to sources;
// - when the identity key changes, the OLD identity gets a tombstone in
//   retired_election_identities (action 'superseded', pointing at this same
//   election id), so a later re-injection of the old title is skipped by the
//   writer instead of recreating the duplicate. An open tombstone for the
//   NEW identity is closed as reinstated by this correction;
// - a ballot_measures detail row mirrors the election title (the measure
//   writer copies it), so it is updated in the same transaction;
// - local-database guard, row lock, single transaction, and --dry-run.
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  findStagingIngestKeysForIdentity,
  insertRetiredElectionIdentity,
  markRetiredElectionIdentityReinstated,
} from "../pipeline/elections/retiredElectionIdentities.js";
import { normalizeElectionTitleKey } from "../utils/normalizeElectionTitleKey.js";
import { mergeElectionSource } from "./electionSourceUtils.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { assertLabelNotRepeatedInTitle } from "./setManualElectionPrintedLabel.js";

type QueryResultLike<T> = { rows: T[] };

export type ElectionTitleCorrectionClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type ElectionTitleCorrectionOptions = {
  electionId: string;
  title: string;
  sourceUrl: string;
  reason: string;
  dryRun: boolean;
};

export type ElectionTitleCorrectionResult =
  | {
      alreadyCorrected: true;
      dryRun: boolean;
      electionId: string;
      title: string;
      sourceAppended: boolean;
    }
  | {
      alreadyCorrected: false;
      dryRun: boolean;
      electionId: string;
      districtId: string;
      districtName: string;
      districtState: string;
      electionDate: string;
      previousTitle: string;
      title: string;
      previousTitleKey: string;
      titleKey: string;
      /** False when only spelling/punctuation changed and the identity key is the same. */
      identityChanged: boolean;
      printedBallotLabel: string | null;
      sources: string[];
      /** The ballot_measures detail row whose mirrored title was updated, if any. */
      measureDetail: { id: string; previousTitle: string } | null;
      /** Tombstone written for the old identity (ledgerId is null on a dry run or when the key did not change). */
      retiredIdentity: {
        ledgerId: string | null;
        /** An open tombstone that already covered the old identity; reused instead of inserting a second one. */
        existingLedgerId: string | null;
        stagingIngestKeys: string[];
      } | null;
      /** Open tombstones on the NEW identity that this correction closes as reinstated. */
      reinstatedLedgerIds: string[];
    };

type ElectionRow = {
  id: string;
  district_id: string;
  election_date: string;
  official_ballot_title: string;
  official_ballot_title_key: string;
  race_type: string | null;
  printed_ballot_label: string | null;
  sources: unknown;
  district_name: string;
  district_state: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 300;

function usage(): string {
  return [
    "Correct one election's official ballot title in place, keeping its id and every dependent row.",
    "",
    "Usage:",
    '  npm run manual:election-title:correct -- --election-id uuid --title "<corrected title>" --source-url https://... --reason "<why>" [--dry-run]',
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
  if (!value) throw new Error(`${name} is required for manual election-title correction`);
  return value;
}

/** Trim, collapse whitespace, and refuse empty, overlong, or multi-line titles. */
export function parseCorrectedElectionTitle(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("--title must be a single line");
  const title = value.trim().replace(/\s+/g, " ");
  if (title.length === 0) throw new Error("--title must not be empty");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`--title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  if (normalizeElectionTitleKey(title).length === 0) {
    throw new Error("--title must contain letters or digits (its identity key would be empty)");
  }
  return title;
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

export async function runElectionTitleCorrection(
  client: ElectionTitleCorrectionClient,
  options: ElectionTitleCorrectionOptions
): Promise<ElectionTitleCorrectionResult> {
  // PostgreSQL returns uuid columns lowercased; normalize so a valid
  // uppercase input cannot fail comparisons downstream.
  const electionId = options.electionId.toLowerCase();
  const { dryRun, reason } = options;
  const title = parseCorrectedElectionTitle(options.title);
  const titleKey = normalizeElectionTitleKey(title);
  const sourceUrl = options.sourceUrl.trim();
  // Enforced here, not only in main(): a direct caller must not be able to
  // store non-HTTPS provenance.
  assertHttpsSource(sourceUrl);

  await client.query("BEGIN");
  try {
    const locked = await client.query<ElectionRow>(
      `
        SELECT e.id, e.district_id, e.election_date::text, e.official_ballot_title,
               e.official_ballot_title_key, e.race_type, e.printed_ballot_label, e.sources,
               d.name AS district_name, d.state AS district_state
        FROM public.elections e
        JOIN public.districts d ON d.id = e.district_id
        WHERE e.id = $1::uuid
        FOR UPDATE OF e
      `,
      [electionId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error(`Election not found: ${electionId}`);

    if (row.official_ballot_title === title) {
      // Idempotent path: the title is already right, but still converge
      // provenance so re-running the exact command ends in one final state.
      const { sources, appended } = mergeElectionSource(row.sources, sourceUrl);
      if (appended && !dryRun) {
        await client.query(
          `
            UPDATE public.elections
            SET sources = $2::jsonb,
                updated_at = now()
            WHERE id = $1::uuid
          `,
          [electionId, JSON.stringify(sources)]
        );
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
      }
      return { alreadyCorrected: true, dryRun, electionId, title, sourceAppended: appended };
    }

    // Readers show "<label>: <title after its colon>"; a new title that
    // starts with the stored label would print the heading twice.
    if (row.printed_ballot_label) {
      assertLabelNotRepeatedInTitle(title, row.printed_ballot_label);
    }

    const identityChanged = titleKey !== row.official_ballot_title_key;
    const reinstatedLedgerIds: string[] = [];
    let retiredIdentity: Extract<ElectionTitleCorrectionResult, { alreadyCorrected: false }>["retiredIdentity"] =
      null;

    if (identityChanged) {
      const conflict = await client.query<{ id: string; official_ballot_title: string }>(
        `
          SELECT id, official_ballot_title
          FROM public.elections
          WHERE district_id = $1::uuid
            AND election_date = $2::date
            AND official_ballot_title_key = $3
            AND id <> $4::uuid
          LIMIT 1
        `,
        [row.district_id, row.election_date, titleKey, electionId]
      );
      if (conflict.rows[0]) {
        throw new Error(
          `Correction would collide with election ${conflict.rows[0].id} ` +
            `(${JSON.stringify(conflict.rows[0].official_ballot_title)}) which already has that title key; ` +
            "that is a duplicate shell — move its links and supersede one side instead of retitling"
        );
      }

      // An open tombstone on the NEW identity would otherwise sit under a
      // live contest. The operator is deliberately bringing that identity
      // back with a source, so close it as reinstated by this election.
      const openOnNew = await client.query<{ id: string }>(
        `
          SELECT id
          FROM public.retired_election_identities
          WHERE district_id = $1::uuid
            AND election_date = $2::date
            AND official_ballot_title_key = $3
            AND reinstated_at IS NULL
          ORDER BY retired_at DESC
        `,
        [row.district_id, row.election_date, titleKey]
      );
      reinstatedLedgerIds.push(...openOnNew.rows.map((ledger) => ledger.id));

      // The old identity may already carry an open tombstone (a bypassed
      // write brought it back); the partial unique index allows only one, so
      // reuse it rather than inserting a second.
      const openOnOld = await client.query<{ id: string }>(
        `
          SELECT id
          FROM public.retired_election_identities
          WHERE district_id = $1::uuid
            AND election_date = $2::date
            AND official_ballot_title_key = $3
            AND reinstated_at IS NULL
          ORDER BY retired_at DESC
          LIMIT 1
        `,
        [row.district_id, row.election_date, row.official_ballot_title_key]
      );
      const stagingIngestKeys = await findStagingIngestKeysForIdentity(
        client,
        row.district_id,
        row.official_ballot_title_key,
        row.election_date
      );
      retiredIdentity = {
        ledgerId: null,
        existingLedgerId: openOnOld.rows[0]?.id ?? null,
        stagingIngestKeys,
      };
    }

    const measure = await client.query<{ id: string; official_ballot_title: string }>(
      `SELECT id, official_ballot_title FROM public.ballot_measures WHERE election_id = $1::uuid LIMIT 1`,
      [electionId]
    );
    const measureDetail = measure.rows[0]
      ? { id: measure.rows[0].id, previousTitle: measure.rows[0].official_ballot_title }
      : null;

    const { sources } = mergeElectionSource(row.sources, sourceUrl);

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      if (identityChanged && retiredIdentity) {
        for (const ledgerId of reinstatedLedgerIds) {
          await markRetiredElectionIdentityReinstated(client, ledgerId, electionId, reason);
        }
        if (!retiredIdentity.existingLedgerId) {
          // Tombstone first, then the retitle, one transaction: the old
          // identity is never left open for a re-injection to recreate.
          const ledger = await insertRetiredElectionIdentity(client, {
            districtId: row.district_id,
            electionDate: row.election_date,
            officialBallotTitle: row.official_ballot_title,
            officialBallotTitleKey: row.official_ballot_title_key,
            raceType: row.race_type,
            electionId,
            action: "superseded",
            reason,
            sourceUrl,
            supersededByElectionIds: [electionId],
            stagingIngestKey: retiredIdentity.stagingIngestKeys[0] ?? null,
          });
          retiredIdentity = { ...retiredIdentity, ledgerId: ledger.id };
        }
      }
      await client.query(
        `
          UPDATE public.elections
          SET official_ballot_title = $2,
              official_ballot_title_key = $3,
              sources = $4::jsonb,
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [electionId, title, titleKey, JSON.stringify(sources)]
      );
      if (measureDetail) {
        await client.query(
          `
            UPDATE public.ballot_measures
            SET official_ballot_title = $2,
                updated_at = now()
            WHERE id = $1::uuid
          `,
          [measureDetail.id, title]
        );
      }
      await client.query("COMMIT");
    }

    return {
      alreadyCorrected: false,
      dryRun,
      electionId,
      districtId: row.district_id,
      districtName: row.district_name,
      districtState: row.district_state,
      electionDate: row.election_date,
      previousTitle: row.official_ballot_title,
      title,
      previousTitleKey: row.official_ballot_title_key,
      titleKey,
      identityChanged,
      printedBallotLabel: row.printed_ballot_label,
      sources,
      measureDetail,
      retiredIdentity,
      reinstatedLedgerIds,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:election-title:correct", process.argv.slice(2), [
    { name: "--election-id", value: "space" },
    { name: "--title", value: "space" },
    { name: "--source-url", value: "space" },
    { name: "--reason", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const electionId = requireFlag("--election-id");
  const title = requireFlag("--title");
  const sourceUrl = requireFlag("--source-url");
  const reason = requireFlag("--reason");
  const dryRun = process.argv.includes("--dry-run");

  if (!UUID_RE.test(electionId)) throw new Error(`Invalid --election-id: ${electionId}`);
  if (reason.length < 20) {
    throw new Error("--reason must explain the correction in at least 20 characters");
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await runElectionTitleCorrection(client, {
      electionId,
      title,
      sourceUrl,
      reason,
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
