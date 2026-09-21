// Local-only repair for stale completeness claims in
// candidate_record_sweep_confirmations.
//
// Before the merge fix in writeMergedSweepConfirmation, a small additive
// records write REPLACED the candidate's ledger row and computed its claims
// from the new batch alone. A batch of only general-labeled rows stored
// candidate_records.only_general_labels for candidates with many
// stance-labeled records. This wrapper re-checks each claimed row against the
// candidate's whole active record set and removes claims that stored records
// contradict: only_general_labels when a stance-labeled record exists,
// no_records_found when any active record exists. Rows, evidence and
// confirmed_at stay; records and search stamps are never touched.
// Zero-record candidates holding only_general_labels are left alone: they are
// the records-retired-out cohort of manual:records:reset-confirmations.
//
// Default: only_general_labels only. --include-no-records-found also clears
// no_records_found claims on candidates who now have active records.
// Dry run unless --apply. Refuses any non-local DATABASE_URL.

import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import {
  loadCandidateRecordSetShape,
  pruneUnsupportedSweepClaims,
  type CandidateRecordSetShape,
} from "./candidateRecordSweepEvidence.js";

const ONLY_GENERAL_LABELS_GAP_ID = "candidate_records.only_general_labels";
const NO_RECORDS_FOUND_GAP_ID = "candidate_records.no_records_found";
const SAMPLE_SIZE = 10;

function isContradictedByRecords(gapId: string, shape: CandidateRecordSetShape): boolean {
  if (gapId === ONLY_GENERAL_LABELS_GAP_ID) {
    return shape.stanceLabeledRecordCount > 0;
  }
  return shape.activeRecordCount > 0;
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:records:clear-stale-claims", process.argv.slice(2), [
    { name: "--apply", value: "none" },
    { name: "--include-no-records-found", value: "none" },
    { name: "--candidate-id", value: "space" },
  ]);
  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL ?? "";
  requireLocalDatabaseTarget(databaseUrl);

  const apply = process.argv.includes("--apply");
  const gapIds = process.argv.includes("--include-no-records-found")
    ? [ONLY_GENERAL_LABELS_GAP_ID, NO_RECORDS_FOUND_GAP_ID]
    : [ONLY_GENERAL_LABELS_GAP_ID];
  const candidateId = readFlag("--candidate-id");

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ candidate_id: string; claimed_gap_ids: string[] }>(
      `
        SELECT candidate_id, array_agg(DISTINCT gap_id) AS claimed_gap_ids
        FROM public.candidate_record_sweep_confirmations,
             unnest(confirmed_gap_ids) AS gap_id
        WHERE gap_id = ANY($1::text[])
          AND ($2::uuid IS NULL OR candidate_id = $2::uuid)
        GROUP BY candidate_id
        ORDER BY candidate_id
      `,
      [gapIds, candidateId]
    );

    const staleByGapId = new Map<string, number>(gapIds.map((id) => [id, 0]));
    const sample: { candidateId: string; activeRecords: number; stanceLabeledRecords: number }[] = [];
    let staleCandidates = 0;
    let rowsChanged = 0;
    for (const row of claimed.rows) {
      const shape = await loadCandidateRecordSetShape(client, row.candidate_id);
      const unsupported = row.claimed_gap_ids.filter((id) => isContradictedByRecords(id, shape));
      if (unsupported.length === 0) {
        continue;
      }
      staleCandidates += 1;
      for (const id of unsupported) {
        staleByGapId.set(id, (staleByGapId.get(id) ?? 0) + 1);
      }
      if (sample.length < SAMPLE_SIZE) {
        sample.push({
          candidateId: row.candidate_id,
          activeRecords: shape.activeRecordCount,
          stanceLabeledRecords: shape.stanceLabeledRecordCount,
        });
      }
      rowsChanged += await pruneUnsupportedSweepClaims(client, row.candidate_id, shape, unsupported);
    }

    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          gapIds,
          candidatesWithClaims: claimed.rows.length,
          staleCandidates,
          staleCandidatesByGapId: Object.fromEntries(staleByGapId),
          [apply ? "rowsChanged" : "rowsWouldChange"]: rowsChanged,
          sample,
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("clear stale sweep claims failed:", message);
    process.exitCode = 1;
  });
}
