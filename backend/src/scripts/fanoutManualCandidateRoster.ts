import { Pool } from "pg";
import { createClient } from "redis";

import { resolveCandidateResearchMode } from "../ai/candidateResearchMode.js";
import { loadProjectEnv } from "../config/env.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { STAGING_ITEM_TYPE_CANDIDATE_ROSTER } from "../config/electionsPipeline.js";
import { parseCandidateRosterPayload, type CandidateRosterEntry } from "../contracts/candidateRosterPayloadContract.js";
import { enqueueCandidateProfileDrafts } from "../pipeline/candidates/candidateProfileDraftEmitter.js";

import { assertKnownCliFlags } from "./manualCliFlags.js";
type ElectionRow = {
  id: string;
  sources: unknown;
  race_type: string;
  district_type: string;
  official_ballot_title: string;
};

type CandidateRosterStagingRow = {
  ingest_key: string;
  payload: unknown;
  status: string;
  run_id: string | null;
};

type CandidateRosterFanoutEntry = CandidateRosterEntry & {
  roster_index: number;
  disambiguation_hint?: string;
  skip_per_election_name_dedupe?: boolean;
};

const MAX_SEED_URLS = 8;

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:candidate-roster:fanout -- --election-id uuid [--run-id id] [--dry-run]",
    "",
    "Reads candidate_roster:<election_id> from staging and emits profile drafts for only that election.",
  ].join("\n");
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }
  const prefix = `${name}=`;
  const match = process.argv.find((token) => token.startsWith(prefix));
  if (!match) {
    return null;
  }
  const value = match.slice(prefix.length);
  if (value.trim().length === 0) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseSeedUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      continue;
    }
    urls.push(trimmed);
  }
  return [...new Set(urls)].slice(0, MAX_SEED_URLS);
}

function mergeSeedUrls(...lists: Array<readonly string[] | undefined>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const trimmed = item.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
      if (merged.length >= MAX_SEED_URLS) {
        return merged;
      }
    }
  }
  return merged;
}

function rosterIngestKeyForElection(electionId: string): string {
  return `candidate_roster:${electionId}`;
}

function extractRosterCandidates(
  payload: unknown,
  options: { allowFecIds: boolean; requireFecIds: boolean }
): { ok: true; candidates: CandidateRosterFanoutEntry[] } | { ok: false; reason: string } {
  // Re-parse of an already-written staging payload: rosters imported before
  // the source-domain policy can carry a now-blocked URL, and fanout must not
  // fail over evidence the roster write already accepted.
  // allowNoFecIdException: the staged row was already accepted by the manual
  // inject, the only import path that lets the exception in.
  const parsed = parseCandidateRosterPayload(payload, {
    ...options,
    enforceSourcePolicy: false,
    allowNoFecIdException: true,
  });
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const rawCandidates = (payload as { candidates: unknown[] }).candidates;

  const candidates: CandidateRosterFanoutEntry[] = [];
  for (const [index, candidate] of parsed.payload.candidates.entries()) {
    // Parsed candidates may be a filtered subset of the raw rows (federal
    // no-FEC-ID policy), so raw hints must come from the original row position.
    const rawIndex = parsed.keptCandidateIndexes[index] ?? index;
    const raw = rawCandidates[rawIndex];
    const rawObject = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const rosterIndex =
      Number.isInteger(rawObject.roster_index) && Number(rawObject.roster_index) >= 0
        ? Number(rawObject.roster_index)
        : rawIndex;
    const disambiguationHint =
      typeof rawObject.disambiguation_hint === "string" && rawObject.disambiguation_hint.trim().length > 0
        ? rawObject.disambiguation_hint.trim()
        : undefined;
    const skipPerElectionNameDedupe =
      rawObject.skip_per_election_name_dedupe === true
        ? true
        : rawObject.skip_per_election_name_dedupe === false
          ? false
          : undefined;
    candidates.push({
      ...candidate,
      roster_index: rosterIndex,
      ...(disambiguationHint ? { disambiguation_hint: disambiguationHint } : {}),
      ...(skipPerElectionNameDedupe !== undefined ? { skip_per_election_name_dedupe: skipPerElectionNameDedupe } : {}),
    });
  }
  return { ok: true, candidates };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual candidate roster fanout`);
  }
  return value;
}

async function loadElection(pool: Pool, electionId: string): Promise<ElectionRow | null> {
  const result = await pool.query<ElectionRow>(
    `
      SELECT e.id::text AS id,
             e.sources,
             e.race_type,
             d.district_type,
             e.official_ballot_title
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      WHERE e.id::text = $1
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows[0] ?? null;
}

async function loadStagingRow(pool: Pool, ingestKey: string): Promise<CandidateRosterStagingRow | null> {
  const result = await pool.query<CandidateRosterStagingRow>(
    `
      SELECT ingest_key, payload, status, run_id
      FROM public.staging_items
      WHERE ingest_key = $1
        AND item_type = $2
      LIMIT 1
    `,
    [ingestKey, STAGING_ITEM_TYPE_CANDIDATE_ROSTER]
  );
  return result.rows[0] ?? null;
}

async function markStagingWritten(pool: Pool, ingestKey: string): Promise<void> {
  await pool.query(
    `
      UPDATE public.staging_items
      SET status = 'written',
          reason = NULL,
          written_at = now(),
          updated_at = now()
      WHERE ingest_key = $1
        AND item_type = $2
    `,
    [ingestKey, STAGING_ITEM_TYPE_CANDIDATE_ROSTER]
  );
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:candidate-roster:fanout", process.argv.slice(2), [{ name: "--election-id", value: "space" }, { name: "--run-id", value: "space" }, { name: "--dry-run", value: "none" }]);
  loadProjectEnv();

  const electionId = readFlag("--election-id");
  if (!electionId) {
    throw new Error(`Missing --election-id.\n${usage()}`);
  }
  const dryRun = hasFlag("--dry-run");
  const ingestKey = rosterIngestKeyForElection(electionId);
  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const redisUrl = dryRun ? null : requireEnv("REDIS_URL");

  const pool = new Pool({ connectionString: databaseUrl });
  const redis = dryRun ? null : createClient({ url: redisUrl! });

  try {
    const [election, stagingRow] = await Promise.all([
      loadElection(pool, electionId),
      loadStagingRow(pool, ingestKey),
    ]);
    if (!election) {
      throw new Error(`Election not found for election_id=${electionId}`);
    }
    if (election.race_type !== "office") {
      throw new Error(`Candidate roster fanout requires an office election; election_id=${electionId} has race_type=${election.race_type}`);
    }
    if (!stagingRow) {
      throw new Error(`Candidate roster staging row not found for ingest_key=${ingestKey}`);
    }
    if (stagingRow.status !== "validated" && stagingRow.status !== "written") {
      throw new Error(`Candidate roster staging row must be validated or written; ingest_key=${ingestKey} status=${stagingRow.status}`);
    }

    const researchMode = resolveCandidateResearchMode({
      districtType: election.district_type,
      officialBallotTitle: election.official_ballot_title,
    });
    const includeFecIds = researchMode !== "state_level";
    const extracted = extractRosterCandidates(stagingRow.payload, {
      allowFecIds: includeFecIds,
      requireFecIds: includeFecIds,
    });
    if (!extracted.ok) {
      throw new Error(`Invalid candidate roster staging payload for ingest_key=${ingestKey}: ${extracted.reason}`);
    }
    const candidates = extracted.candidates;
    // No-FEC-ID exception rows get no profile draft: the profile consumer
    // requires roster FEC IDs for federal contests, so a draft would only
    // retry and park. Their profiles go through manual:candidate-profile:write.
    // Only the lead's draft is skipped; a running mate's draft is still emitted.
    const manualProfileRequired = candidates
      .filter((candidate) => candidate.no_fec_id_exception)
      .map((candidate) => candidate.display_name);

    const runId = readFlag("--run-id") ?? stagingRow.run_id ?? `manual_candidate_roster_fanout_${new Date().toISOString()}`;
    const electionSeedUrls = parseSeedUrls(election.sources);

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            ingestKey,
            runId,
            electionId,
            researchMode,
            requiresFecIds: includeFecIds,
            candidateCount: candidates.length,
            manualProfileRequired,
          },
          null,
          2
        )
      );
      return;
    }

    await redis!.connect();
    const fanout = await enqueueCandidateProfileDrafts(
      redis!,
      candidates.flatMap((candidate) => [
        ...(candidate.no_fec_id_exception
          ? []
          : [
              {
                electionId,
                runId,
                displayName: candidate.display_name,
                rosterIndex: candidate.roster_index,
                rosterParty: candidate.party,
                rosterIsIncumbent: candidate.is_incumbent,
                disambiguationHint: candidate.disambiguation_hint,
                fecIds: candidate.fec_ids,
                stateFilingIdsHint: candidate.state_filing_ids,
                skipPerElectionNameDedupe: candidate.skip_per_election_name_dedupe,
                seedUrls: mergeSeedUrls(candidate.sources, electionSeedUrls),
              },
            ]),
        ...(candidate.running_mate
          ? [
              {
                electionId,
                runId,
                displayName: candidate.running_mate.display_name,
                rosterIndex: candidate.roster_index,
                rosterParty: candidate.running_mate.party,
                seedUrls: mergeSeedUrls(candidate.running_mate.sources, electionSeedUrls),
                electionTicketRole: "running_mate" as const,
                ticketLeadDisplayName: candidate.display_name,
              },
            ]
          : []),
      ])
    );

    await markStagingWritten(pool, ingestKey);

    console.log(
      JSON.stringify(
        {
          ingestKey,
          runId,
          electionId,
          researchMode,
          requiresFecIds: includeFecIds,
          candidateCount: candidates.length,
          manualProfileRequired,
          emittedCount: fanout.emittedCount,
          skippedCount: fanout.skippedCount,
        },
        null,
        2
      )
    );
  } finally {
    if (redis) {
      await redis.quit().catch(() => undefined);
    }
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("manual candidate roster fanout failed:", message);
  process.exitCode = 1;
});
