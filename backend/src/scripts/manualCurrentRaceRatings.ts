import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { parseCurrentRaceRatingPayload } from "../contracts/currentRaceRatingPayloadContract.js";
import {
  loadCurrentRaceRatingContexts,
  isDcDelegateDistrict,
} from "../pipeline/competitiveness/currentRaceRatingContextLoader.js";
import {
  loadCurrentRaceRatings,
  currentRaceRatingBlocksResearch,
  type CurrentRaceRatingLookupRecord,
} from "../pipeline/competitiveness/currentRaceRatingLookup.js";
import { validateCurrentRaceRatingSourceUrls } from "../pipeline/competitiveness/currentRaceRatingSourceValidation.js";
import { upsertCurrentRaceRatings } from "../pipeline/competitiveness/currentRaceRatingWriter.js";
import type { ElectionDistrictType, ElectionStage } from "../types/election.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { usLatestLocalDateIso } from "../utils/usLocalDate.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { readPositiveIntegerEnv } from "../config/envReaders.js";

// Manual (no AI provider) current-race-rating workflow: the vote-power
// decisiveness axis prefers a fresh, confident current-cycle rating over
// historic margins, and this script is how those ratings get in. Research is
// browser-tier (Inside Elections 403s every non-browser client) and follows
// the voteapp-manual-research skill's current-race-ratings reference doc.
//
// Subcommands:
//   due      List in-scope elections (US Senate / US House voting seats /
//            Governor, general+special stages) still owing a rating — or the
//            subset of a frozen election-ID manifest — excluding rows with a
//            fresh rating (60 d from as_of) or a recent none_found (30 d from
//            researched_at). The DC delegate row is excluded with a reason,
//            never silently skipped.
//   context  Print research context (election, district, roster, historic
//            competitiveness label) for up to 10 elections.
//   write    Validate a researched payload (label + confidence are derived in
//            code from the raw outlet strings, never taken from the payload),
//            check source URL liveness, and upsert in a transaction.

type Subcommand = "due" | "context" | "write";

const MAX_ELECTIONS_PER_WRITE = 10;

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:current-ratings:due -- [--scope senate|house|governor|all] [--state XX] [--limit 500]",
    "  npm run manual:current-ratings:due -- --manifest manifest.json",
    "  npm run manual:current-ratings:context -- --election-ids uuid,uuid,...",
    "  npm run manual:current-ratings:write -- --election-ids uuid,uuid,... --file payload.json [--dry-run] [--force]",
    "",
    "The write payload must match the current-race-rating payload contract:",
    '  { "ratings": [ { "election_id", "method": "outlet_consensus", "evidence_status": "rated"|"none_found",',
    '    "observations": [ { "outlet": "inside_elections"|"sabato", "raw_rating", "as_of", "url" } ],  // rated only',
    '    "source_url", "notes"? } ] }',
    "competitiveness_label, confidence, as_of, favored, and intensity are derived in code and rejected as inputs.",
    "A manifest file is a JSON array of election-id strings, or { \"election_ids\": [...] }.",
  ].join("\n");
}

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }
  const prefix = `${name}=`;
  const match = argv.find((token) => token.startsWith(prefix));
  if (!match) {
    return null;
  }
  const value = match.slice(prefix.length);
  if (value.trim().length === 0) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual current race ratings`);
  }
  return value;
}

// Election ids are lowercased on the way in: Postgres accepts uppercase
// UUID input but returns lowercase text, so a case-preserving id would fail
// every later found/missing comparison against DB-sourced ids.
export function parseElectionIdsFlag(value: string): string[] {
  const ids = [
    ...new Set(value.split(",").map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0)),
  ];
  if (ids.length === 0) {
    throw new Error("--election-ids must contain at least one election id");
  }
  return ids;
}

// A frozen manifest is a due-output snapshot committed to the run's scratch
// state file: either a bare JSON array of election-id strings or an object
// with an election_ids array. Anything else is a malformed manifest, not an
// empty one.
export function parseManifestElectionIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { election_ids?: unknown }).election_ids)
      ? (raw as { election_ids: unknown[] }).election_ids
      : null;
  if (list === null) {
    throw new Error('Manifest must be a JSON array of election ids or { "election_ids": [...] }');
  }
  const ids = [
    ...new Set(
      list.map((entry) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new Error(`Manifest election ids must be non-empty strings, got: ${JSON.stringify(entry)}`);
        }
        return entry.trim().toLowerCase();
      })
    ),
  ];
  if (ids.length === 0) {
    throw new Error("Manifest contains no election ids");
  }
  return ids;
}

const DUE_SCOPES = ["senate", "house", "governor", "all"] as const;
type DueScope = (typeof DUE_SCOPES)[number];

// Scope predicates for the v1 outlet-consensus targets. The canonical office
// is the primary key — ballot titles vary per state ("US Senate",
// "Governor / Lt. Governor") and the discovery contest family is not always
// set (MI's Senate row carries non_judicial_office) — with a fallback for
// rows whose office never resolved: the contest family for Senate, and a
// title list (statewide only, so "Lieutenant Governor" alone can never
// match) for Governor. House needs no fallback; the district type is
// structural. Mayors are a v1.1 milestone and have no scope here — their
// due list will require an explicit city manifest.
const SCOPE_CONDITIONS: Record<Exclude<DueScope, "all">, string> = {
  senate: `(office.canonical_name = 'United States Senator' OR e.discovery_contest_family = 'us_senate')`,
  // Colorado's regent and State Board of Education seats share the us_house
  // row; they are not House races.
  house: `(d.district_type = 'us_house' AND (office.canonical_name IS NULL OR office.canonical_name = 'United States Representative'))`,
  governor: `(office.canonical_name = 'Governor' OR (e.office_id IS NULL AND d.district_type = 'statewide' AND e.official_ballot_title IN ('Governor', 'Governor and Lieutenant Governor', 'Governor/Lt. Governor', 'Governor / Lt. Governor')))`,
};

type DueCandidateRow = {
  election_id: string;
  state: string;
  district_name: string;
  district_type: ElectionDistrictType;
  official_ballot_title: string;
  election_date: string;
  election_stage: ElectionStage | null;
};

type ExistingRatingSummary = {
  evidence_status: CurrentRaceRatingLookupRecord["evidence_status"];
  competitiveness_label: CurrentRaceRatingLookupRecord["competitiveness_label"];
  confidence: CurrentRaceRatingLookupRecord["confidence"];
  as_of: string | null;
  researched_on: string;
};

type AnnotatedDueRow = DueCandidateRow & {
  is_dc_delegate: boolean;
  existing_rating: ExistingRatingSummary | null;
};

export type DuePartition = {
  due: AnnotatedDueRow[];
  blocked: AnnotatedDueRow[];
  excluded: Array<AnnotatedDueRow & { reason: string }>;
};

function summarizeExistingRating(record: CurrentRaceRatingLookupRecord | undefined): ExistingRatingSummary | null {
  if (!record) {
    return null;
  }
  return {
    evidence_status: record.evidence_status,
    competitiveness_label: record.competitiveness_label,
    confidence: record.confidence,
    as_of: record.as_of,
    researched_on: record.researched_on,
  };
}

export function partitionDueRows(
  rows: readonly DueCandidateRow[],
  ratings: ReadonlyMap<string, CurrentRaceRatingLookupRecord>,
  now: Date
): DuePartition {
  const partition: DuePartition = { due: [], blocked: [], excluded: [] };
  for (const row of rows) {
    const record = ratings.get(row.election_id);
    const annotated: AnnotatedDueRow = {
      ...row,
      is_dc_delegate: isDcDelegateDistrict(row.district_type, row.state),
      existing_rating: summarizeExistingRating(record),
    };
    if (annotated.is_dc_delegate) {
      partition.excluded.push({
        ...annotated,
        reason: "DC delegate race: outlets do not rate it; record none_found or leave it out of the run",
      });
    } else if (record && currentRaceRatingBlocksResearch(record, now)) {
      partition.blocked.push(annotated);
    } else {
      partition.due.push(annotated);
    }
  }
  return partition;
}

async function runDue(pool: Pool, argv: readonly string[]): Promise<void> {
  const asOfDate = usLatestLocalDateIso();
  const manifestPath = readFlag(argv, "--manifest");
  const scopeRaw = readFlag(argv, "--scope");
  const stateFilter = readFlag(argv, "--state")?.trim().toUpperCase() ?? null;
  const limit = readPositiveIntegerFlag(argv, "--limit", 500);

  if (manifestPath && (scopeRaw || stateFilter)) {
    throw new Error(`--manifest is a frozen id list; combine it with --scope or --state and the two would disagree about scope. Pass one or the other.\n${usage()}`);
  }
  const scope = (scopeRaw?.trim().toLowerCase() ?? "all") as DueScope;
  if (!DUE_SCOPES.includes(scope)) {
    throw new Error(`Invalid --scope: ${scopeRaw}. Expected senate|house|governor|all.\n${usage()}`);
  }

  let rows: DueCandidateRow[];
  let unknownManifestIds: string[] = [];
  if (manifestPath) {
    const manifestIds = parseManifestElectionIds(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    const result = await pool.query<DueCandidateRow>(
      `
        SELECT
          e.id::text AS election_id,
          d.state,
          d.name AS district_name,
          d.district_type,
          e.official_ballot_title,
          e.election_date::text AS election_date,
          e.election_stage
        FROM public.elections AS e
        JOIN public.districts AS d
          ON d.id = e.district_id
        WHERE e.id = ANY($1::uuid[])
        ORDER BY d.state ASC, e.official_ballot_title ASC, e.id ASC
      `,
      [manifestIds]
    );
    rows = result.rows;
    const found = new Set(rows.map((row) => row.election_id));
    unknownManifestIds = manifestIds.filter((id) => !found.has(id));
  } else {
    const scopeCondition =
      scope === "all"
        ? `(${Object.values(SCOPE_CONDITIONS).map((condition) => `(${condition})`).join(" OR ")})`
        : `(${SCOPE_CONDITIONS[scope]})`;
    const params: unknown[] = [asOfDate];
    let stateClause = "";
    if (stateFilter) {
      params.push(stateFilter);
      stateClause = `AND d.state = $${params.length}`;
    }
    const result = await pool.query<DueCandidateRow>(
      `
        SELECT
          e.id::text AS election_id,
          d.state,
          d.name AS district_name,
          d.district_type,
          e.official_ballot_title,
          e.election_date::text AS election_date,
          e.election_stage
        FROM public.elections AS e
        JOIN public.districts AS d
          ON d.id = e.district_id
        LEFT JOIN public.offices AS office
          ON office.id = e.office_id
        WHERE e.race_type = 'office'
          AND e.election_stage IN ('general', 'special')
          AND e.election_date >= $1::date
          AND ${scopeCondition}
          ${stateClause}
        ORDER BY e.election_date ASC, d.state ASC, e.official_ballot_title ASC, e.id ASC
      `,
      params
    );
    rows = result.rows;
  }

  const ratings = await loadCurrentRaceRatings(
    pool,
    rows.map((row) => row.election_id)
  );
  const partition = partitionDueRows(rows, ratings, new Date());

  console.log(
    JSON.stringify(
      {
        asOfDate,
        mode: manifestPath ? "manifest" : "scope",
        scope: manifestPath ? null : scope,
        stateFilter,
        limit,
        scopedCount: rows.length,
        unknownManifestIds,
        dueCount: partition.due.length,
        blockedCount: partition.blocked.length,
        excludedCount: partition.excluded.length,
        due: partition.due.slice(0, limit),
        blocked: partition.blocked.slice(0, limit),
        excluded: partition.excluded,
      },
      null,
      2
    )
  );
}

async function loadContextsOrThrow(pool: Pool, ids: readonly string[]) {
  const contexts = await loadCurrentRaceRatingContexts(pool, ids);
  const found = new Set(contexts.map((context) => context.electionId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`No office election found for election_id(s): ${missing.join(", ")}`);
  }
  return contexts;
}

async function runContext(pool: Pool, argv: readonly string[]): Promise<void> {
  const idsRaw = readFlag(argv, "--election-ids");
  if (!idsRaw) {
    throw new Error(`Missing --election-ids.\n${usage()}`);
  }
  const ids = parseElectionIdsFlag(idsRaw);
  if (ids.length > MAX_ELECTIONS_PER_WRITE) {
    throw new Error(`--election-ids accepts at most ${MAX_ELECTIONS_PER_WRITE} elections per batch, got ${ids.length}`);
  }

  const contexts = await loadContextsOrThrow(pool, ids);
  const ratings = await loadCurrentRaceRatings(pool, ids);

  console.log(
    JSON.stringify(
      {
        asOfDate: usLatestLocalDateIso(),
        contexts: contexts.map((context) => ({
          ...context,
          existingRating: summarizeExistingRating(ratings.get(context.electionId)),
        })),
      },
      null,
      2
    )
  );
}

async function runWrite(pool: Pool, argv: readonly string[]): Promise<void> {
  const idsRaw = readFlag(argv, "--election-ids");
  const file = readFlag(argv, "--file");
  if (!idsRaw || !file) {
    throw new Error(`Missing --election-ids or --file.\n${usage()}`);
  }
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");

  const ids = parseElectionIdsFlag(idsRaw);
  if (ids.length > MAX_ELECTIONS_PER_WRITE) {
    throw new Error(`--election-ids accepts at most ${MAX_ELECTIONS_PER_WRITE} elections per batch, got ${ids.length}`);
  }

  const contexts = await loadContextsOrThrow(pool, ids);

  // A rating for a past election can never override decisiveness (the
  // freshness rule requires an upcoming election), so a write for one is
  // almost certainly a mistargeted id. --force is the reviewed escape hatch.
  const asOfDate = usLatestLocalDateIso();
  const pastElections = contexts.filter((context) => context.electionDate < asOfDate);
  if (pastElections.length > 0 && !force) {
    throw new Error(
      `Election(s) already past (${pastElections
        .map((context) => `${context.electionId} on ${context.electionDate}`)
        .join(", ")}); a current rating for a past election never overrides decisiveness. Re-run with --force if this provenance write is intended.`
    );
  }

  const rawPayload = JSON.parse(await readFile(file, "utf8")) as unknown;
  const parsed = parseCurrentRaceRatingPayload(rawPayload, { contexts });
  if (!parsed.ok) {
    throw new Error(`Current race rating payload failed validation: ${parsed.reason}`);
  }
  const payload = parsed.payload;

  const sourceValidation = await validateCurrentRaceRatingSourceUrls(payload, {
    timeoutMs: readPositiveIntegerEnv("AI_TIMEOUT_MS", 90000),
  });
  if (!sourceValidation.ok) {
    throw new Error(
      [
        `Current race rating source validation failed: ${sourceValidation.reason}`,
        ...sourceValidation.failedUrls.map(
          (failed) => `Do not reuse this unreachable source URL: ${failed.url} (${failed.reason})`
        ),
        "Replace failed URLs with the live outlet/cross-check pages actually used, then re-run.",
      ].join("\n")
    );
  }

  const contextById = new Map(contexts.map((context) => [context.electionId, context]));
  const derivedRows = payload.ratings.map((row) => ({
    election_id: row.election_id,
    official_ballot_title: contextById.get(row.election_id)?.officialBallotTitle ?? null,
    state: contextById.get(row.election_id)?.district.state ?? null,
    evidence_status: row.evidence_status,
    competitiveness_label: row.competitiveness_label,
    confidence: row.confidence,
    as_of: row.as_of,
    mean_intensity: (row.evidence as { mean_intensity?: number }).mean_intensity ?? null,
    observation_count: Array.isArray(row.evidence.observations) ? row.evidence.observations.length : 0,
    historical_label: contextById.get(row.election_id)?.historical?.competitivenessLabel ?? null,
  }));

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          electionCount: payload.ratings.length,
          derivedRows,
          sourceVerifications: sourceValidation.verifications,
        },
        null,
        2
      )
    );
    return;
  }

  let writeResult;
  let client: PoolClient | undefined;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    writeResult = await upsertCurrentRaceRatings(client, payload.ratings, { force });
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted && client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client?.release();
  }

  const after = await loadCurrentRaceRatings(pool, ids);
  console.log(
    JSON.stringify(
      {
        requested: writeResult.requested,
        rowsWritten: writeResult.rowsWritten,
        force,
        derivedRows,
        sourceVerifications: sourceValidation.verifications,
        storedAfter: ids.map((id) => ({
          election_id: id,
          rating: summarizeExistingRating(after.get(id)),
        })),
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "due" && command !== "context" && command !== "write") {
    throw new Error(`Unknown subcommand: ${command ?? "(none)"}.\n${usage()}`);
  }
  const subcommand: Subcommand = command;

  const flagSpecs = {
    due: [
      { name: "--scope", value: "both" as const },
      { name: "--manifest", value: "both" as const },
      { name: "--state", value: "both" as const },
      { name: "--limit", value: "both" as const },
    ],
    context: [{ name: "--election-ids", value: "both" as const }],
    write: [
      { name: "--election-ids", value: "both" as const },
      { name: "--file", value: "both" as const },
      { name: "--dry-run", value: "none" as const },
      { name: "--force", value: "none" as const },
    ],
  }[subcommand];
  assertKnownCliFlags(`manual:current-ratings:${subcommand}`, rest, flagSpecs);

  loadProjectEnv();
  const databaseUrl = requireEnv("DATABASE_URL");
  if (subcommand === "write") {
    requireLocalDatabaseTarget(databaseUrl);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (subcommand === "due") {
      await runDue(pool, rest);
    } else if (subcommand === "context") {
      await runContext(pool, rest);
    } else {
      await runWrite(pool, rest);
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("manual current race ratings failed:", message);
    process.exitCode = 1;
  });
}
