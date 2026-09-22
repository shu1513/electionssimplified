// Backfill retired_election_identities for contests deleted before the
// ledger existed (migration 296).
//
// The only trace of a deleted contest is the 'written' staging_items row
// whose payload produced it. An entry there whose (district_id, title key,
// election_date) has no elections row today was deleted — OR was relabeled
// in place by a later migration (Arkansas quorum-court titles, county-board
// moves), OR had its date corrected by manual:election-date:correct. A blind
// backfill would tombstone live contests, so this runs in two steps:
//
//   --discover --out <tsv> [--retire-tsv <path>[,<path>...]]
//     Read-only. Lists every candidate identity with a classification and,
//     when a retire list (election id, reason, source URL[, title]) names
//     it, the matching election id/reason/source prefilled. The operator
//     reviews the file: keeps the rows that were really retired, fills in
//     action/reason for the rest or deletes them.
//
//   --manifest <tsv> [--retired-on YYYY-MM-DD] [--dry-run]
//     Guarded apply. Every row is re-checked against the live tables (no
//     elections row with that identity, no open ledger row, district exists,
//     replacement ids exist for a supersession). --dry-run prints the counts
//     and inserts nothing; the live run inserts in one transaction.
//
// Manifest / discovery columns (tab-separated, header row required):
//   election_id (blank allowed only with action=backfilled), district_id,
//   election_date, official_ballot_title, action, reason, source_url,
//   superseded_by (comma-separated ids; a backfilled row may carry them too
//   when the log names the replacements), then any extra
//   columns, which are ignored on apply (discovery writes race_type,
//   district_name, state, staging_ingest_key, classification, tsv_candidates).
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  findStagingIngestKeysForIdentity,
  insertRetiredElectionIdentity,
  RETIRED_ELECTION_ACTIONS,
  type RetiredElectionAction,
  type RetiredIdentityClient,
} from "../pipeline/elections/retiredElectionIdentities.js";
import { normalizeElectionTitleKey } from "../utils/normalizeElectionTitleKey.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";

// Format-only: ids in a manifest come from database rows or logs, not user-minted values.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MANIFEST_COLUMNS = [
  "election_id",
  "district_id",
  "election_date",
  "official_ballot_title",
  "action",
  "reason",
  "source_url",
  "superseded_by",
] as const;

const DISCOVERY_EXTRA_COLUMNS = [
  "race_type",
  "district_name",
  "state",
  "staging_ingest_key",
  "classification",
  "tsv_candidates",
] as const;

function usage(): string {
  return [
    "Backfill the retired-election ledger for contests deleted before it existed.",
    "",
    "Usage:",
    "  npm run manual:elections:backfill-retired-ledger -- --discover --out candidates.tsv [--retire-tsv a.tsv,b.tsv]",
    "  npm run manual:elections:backfill-retired-ledger -- --manifest reviewed.tsv [--retired-on YYYY-MM-DD] [--dry-run]",
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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the retired-ledger backfill`);
  return value;
}

// ---------- TSV helpers ----------

function tsvEscape(value: string | null | undefined): string {
  return (value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

export function parseTsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0]!.split("\t").map((cell) => cell.trim());
  const rows = lines.slice(1).map((line) => line.split("\t").map((cell) => cell.trim()));
  return { header, rows };
}

// ---------- retire lists (election id, reason, source URL[, title]) ----------

export type RetireListRow = {
  electionId: string;
  reason: string;
  sourceUrl: string;
  title: string | null;
  file: string;
};

/** Headerless: <election id> \t <reason> \t <source url> [\t <title>]. */
export function parseRetireList(text: string, file: string): RetireListRow[] {
  const rows: RetireListRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const cells = line.split("\t").map((cell) => cell.trim());
    const electionId = cells[0] ?? "";
    if (!UUID_RE.test(electionId)) continue;
    rows.push({
      electionId: electionId.toLowerCase(),
      reason: cells[1] ?? "",
      sourceUrl: cells[2] ?? "",
      title: cells[3] && cells[3].length > 0 ? cells[3] : null,
      file,
    });
  }
  return rows;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Retire-list rows that could describe this candidate: same title key when
 * the list carries a title, otherwise the candidate's title spelled out
 * inside the reason. A district hint (the district's first name token in
 * the reason) is required when more than one row matches on title alone.
 */
export function matchRetireListRows(
  candidate: { officialBallotTitle: string; districtName: string },
  list: readonly RetireListRow[]
): RetireListRow[] {
  const key = normalizeElectionTitleKey(candidate.officialBallotTitle);
  const titleText = normalizeText(candidate.officialBallotTitle);
  const districtToken = normalizeText(candidate.districtName).split(" ")[0] ?? "";
  const byTitle = list.filter((row) => {
    if (row.title) return normalizeElectionTitleKey(row.title) === key;
    return titleText.length > 0 && ` ${normalizeText(row.reason)} `.includes(` ${titleText} `);
  });
  if (byTitle.length <= 1) return byTitle;
  const withDistrict = byTitle.filter(
    (row) => districtToken.length > 2 && normalizeText(row.reason).includes(districtToken)
  );
  return withDistrict.length > 0 ? withDistrict : byTitle;
}

// ---------- discovery ----------

export type StagingEntryCandidate = {
  ingestKey: string;
  districtId: string;
  electionDate: string;
  officialBallotTitle: string;
  raceType: string | null;
};

export type CandidateClassification =
  | "district_missing"
  | "district_not_canonical"
  | "date_moved"
  | "same_date_siblings"
  | "no_same_date_rows";

export type DiscoveryContext = {
  liveIdentities: ReadonlySet<string>;
  liveDistrictKeyDates: ReadonlyMap<string, ReadonlySet<string>>;
  liveDistrictDateCounts: ReadonlyMap<string, number>;
  openLedgerIdentities: ReadonlySet<string>;
  districts: ReadonlyMap<string, { name: string; state: string; canonicalDistrictId: string | null }>;
};

export function identityKey(districtId: string, electionDate: string, titleKey: string): string {
  return `${districtId}|${electionDate}|${titleKey}`;
}

export type ClassifiedCandidate = StagingEntryCandidate & {
  titleKey: string;
  classification: CandidateClassification;
  districtName: string;
  state: string;
};

/**
 * Pure classification of one staging entry. Returns null when the identity
 * is alive or already in the ledger (nothing to backfill).
 */
export function classifyStagingEntry(
  entry: StagingEntryCandidate,
  context: DiscoveryContext
): ClassifiedCandidate | null {
  const titleKey = normalizeElectionTitleKey(entry.officialBallotTitle);
  const identity = identityKey(entry.districtId, entry.electionDate, titleKey);
  if (context.liveIdentities.has(identity) || context.openLedgerIdentities.has(identity)) {
    return null;
  }
  const district = context.districts.get(entry.districtId);
  const base = {
    ...entry,
    titleKey,
    districtName: district?.name ?? "",
    state: district?.state ?? "",
  };
  if (!district) return { ...base, classification: "district_missing" };
  if (district.canonicalDistrictId) return { ...base, classification: "district_not_canonical" };
  const otherDates = context.liveDistrictKeyDates.get(`${entry.districtId}|${titleKey}`);
  if (otherDates && otherDates.size > 0) return { ...base, classification: "date_moved" };
  const siblings = context.liveDistrictDateCounts.get(`${entry.districtId}|${entry.electionDate}`) ?? 0;
  return { ...base, classification: siblings > 0 ? "same_date_siblings" : "no_same_date_rows" };
}

async function loadDiscoveryContext(client: RetiredIdentityClient): Promise<DiscoveryContext> {
  const live = await client.query<{ district_id: string; election_date: string; official_ballot_title_key: string }>(
    `SELECT district_id, election_date::text AS election_date, official_ballot_title_key FROM public.elections`
  );
  const liveIdentities = new Set<string>();
  const liveDistrictKeyDates = new Map<string, Set<string>>();
  const liveDistrictDateCounts = new Map<string, number>();
  for (const row of live.rows) {
    liveIdentities.add(identityKey(row.district_id, row.election_date, row.official_ballot_title_key));
    const keyDates = liveDistrictKeyDates.get(`${row.district_id}|${row.official_ballot_title_key}`) ?? new Set<string>();
    keyDates.add(row.election_date);
    liveDistrictKeyDates.set(`${row.district_id}|${row.official_ballot_title_key}`, keyDates);
    const dateKey = `${row.district_id}|${row.election_date}`;
    liveDistrictDateCounts.set(dateKey, (liveDistrictDateCounts.get(dateKey) ?? 0) + 1);
  }

  const ledger = await client.query<{ district_id: string; election_date: string; official_ballot_title_key: string }>(
    `
      SELECT district_id, election_date::text AS election_date, official_ballot_title_key
      FROM public.retired_election_identities
      WHERE reinstated_at IS NULL
    `
  );
  const openLedgerIdentities = new Set(
    ledger.rows.map((row) => identityKey(row.district_id, row.election_date, row.official_ballot_title_key))
  );

  const districtRows = await client.query<{
    id: string;
    name: string;
    state: string;
    canonical_district_id: string | null;
  }>(`SELECT id, name, state, canonical_district_id FROM public.districts`);
  const districts = new Map(
    districtRows.rows.map((row) => [
      row.id,
      { name: row.name, state: row.state, canonicalDistrictId: row.canonical_district_id },
    ])
  );

  return { liveIdentities, liveDistrictKeyDates, liveDistrictDateCounts, openLedgerIdentities, districts };
}

async function loadWrittenStagingEntries(client: RetiredIdentityClient): Promise<StagingEntryCandidate[]> {
  const result = await client.query<{
    ingest_key: string;
    district_id: string | null;
    title: string | null;
    election_date: string | null;
    race_type: string | null;
  }>(
    `
      SELECT s.ingest_key,
             s.payload->>'district_id' AS district_id,
             e->>'official_ballot_title' AS title,
             e->>'election_date' AS election_date,
             e->>'race_type' AS race_type
      FROM public.staging_items AS s
      CROSS JOIN LATERAL jsonb_array_elements(s.payload->'entries') AS e
      WHERE s.item_type = 'election'
        AND s.status = 'written'
      ORDER BY s.written_at DESC NULLS LAST, s.ingest_key
    `
  );
  const entries: StagingEntryCandidate[] = [];
  for (const row of result.rows) {
    if (!row.district_id || !row.title || !row.election_date || !ISO_DATE_RE.test(row.election_date)) continue;
    entries.push({
      ingestKey: row.ingest_key,
      districtId: row.district_id,
      electionDate: row.election_date,
      officialBallotTitle: row.title,
      raceType: row.race_type,
    });
  }
  return entries;
}

export type DiscoveryOutputRow = Record<(typeof MANIFEST_COLUMNS)[number] | (typeof DISCOVERY_EXTRA_COLUMNS)[number], string>;

export function buildDiscoveryRow(candidate: ClassifiedCandidate, matches: readonly RetireListRow[]): DiscoveryOutputRow {
  const single = matches.length === 1 ? matches[0]! : null;
  return {
    election_id: single?.electionId ?? "",
    district_id: candidate.districtId,
    election_date: candidate.electionDate,
    official_ballot_title: candidate.officialBallotTitle,
    action: single ? "retired_spurious" : "",
    reason: single?.reason ?? "",
    source_url: single?.sourceUrl ?? "",
    superseded_by: "",
    race_type: candidate.raceType ?? "",
    district_name: candidate.districtName,
    state: candidate.state,
    staging_ingest_key: candidate.ingestKey,
    classification: candidate.classification,
    tsv_candidates: matches.map((row) => row.electionId).join(","),
  };
}

async function runDiscover(client: RetiredIdentityClient, outPath: string, retireLists: RetireListRow[]): Promise<void> {
  const context = await loadDiscoveryContext(client);
  const entries = await loadWrittenStagingEntries(client);
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  const outputRows: DiscoveryOutputRow[] = [];
  let tsvMatched = 0;
  let tsvAmbiguous = 0;
  for (const entry of entries) {
    const classified = classifyStagingEntry(entry, context);
    if (!classified) continue;
    const identity = identityKey(classified.districtId, classified.electionDate, classified.titleKey);
    if (seen.has(identity)) continue;
    seen.add(identity);
    counts[classified.classification] = (counts[classified.classification] ?? 0) + 1;
    const matches = matchRetireListRows(
      { officialBallotTitle: classified.officialBallotTitle, districtName: classified.districtName },
      retireLists
    );
    if (matches.length === 1) tsvMatched += 1;
    if (matches.length > 1) tsvAmbiguous += 1;
    outputRows.push(buildDiscoveryRow(classified, matches));
  }

  const columns = [...MANIFEST_COLUMNS, ...DISCOVERY_EXTRA_COLUMNS];
  const lines = [columns.join("\t")];
  for (const row of outputRows) {
    lines.push(columns.map((column) => tsvEscape(row[column])).join("\t"));
  }
  await writeFile(outPath, `${lines.join("\n")}\n`, "utf8");

  const listIds = new Set(retireLists.map((row) => row.electionId));
  const matchedIds = new Set(outputRows.filter((row) => row.election_id).map((row) => row.election_id));
  console.log(
    JSON.stringify(
      {
        mode: "discover",
        writtenStagingEntries: entries.length,
        candidateIdentities: outputRows.length,
        byClassification: counts,
        retireListRows: listIds.size,
        retireListMatchedUniquely: tsvMatched,
        retireListAmbiguous: tsvAmbiguous,
        retireListUnmatched: [...listIds].filter((id) => !matchedIds.has(id)).length,
        out: outPath,
        next: "Review the file, keep the rows that were really retired (fill action/reason), then run --manifest <file> --dry-run.",
      },
      null,
      2
    )
  );
}

// ---------- manifest apply ----------

export type ManifestRow = {
  line: number;
  /** Null only for a backfilled row whose original id survived as a log prefix. */
  electionId: string | null;
  districtId: string;
  electionDate: string;
  officialBallotTitle: string;
  action: RetiredElectionAction;
  reason: string;
  sourceUrl: string | null;
  supersededBy: string[];
  stagingIngestKey: string | null;
};

export function parseManifest(text: string): { rows: ManifestRow[]; invalid: string[] } {
  const { header, rows } = parseTsv(text);
  const invalid: string[] = [];
  const missing = MANIFEST_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return { rows: [], invalid: [`manifest header is missing column(s): ${missing.join(", ")}`] };
  }
  const col = (cells: string[], name: string): string => {
    const index = header.indexOf(name);
    return index >= 0 ? (cells[index] ?? "").trim() : "";
  };
  const parsed: ManifestRow[] = [];
  const seen = new Set<string>();
  rows.forEach((cells, index) => {
    const line = index + 2;
    const electionId = col(cells, "election_id").toLowerCase();
    const districtId = col(cells, "district_id").toLowerCase();
    const electionDate = col(cells, "election_date");
    const officialBallotTitle = col(cells, "official_ballot_title");
    const action = col(cells, "action") as RetiredElectionAction;
    const reason = col(cells, "reason");
    const sourceUrl = col(cells, "source_url");
    const supersededBy = col(cells, "superseded_by")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    const stagingIngestKey = col(cells, "staging_ingest_key");
    const problems: string[] = [];
    if (!UUID_RE.test(electionId) && !(electionId.length === 0 && action === "backfilled")) {
      problems.push("election_id is not a uuid (blank is allowed only with action=backfilled)");
    }
    if (!UUID_RE.test(districtId)) problems.push("district_id is not a uuid");
    if (!ISO_DATE_RE.test(electionDate)) problems.push("election_date is not YYYY-MM-DD");
    if (officialBallotTitle.length === 0) problems.push("official_ballot_title is empty");
    if (!RETIRED_ELECTION_ACTIONS.includes(action)) {
      problems.push(`action must be one of ${RETIRED_ELECTION_ACTIONS.join("|")}`);
    }
    if (reason.length < 10) problems.push("reason must be at least 10 characters");
    if (sourceUrl.length > 0 && !/^https?:\/\//i.test(sourceUrl)) problems.push("source_url must be http(s)");
    if (supersededBy.some((id) => !UUID_RE.test(id))) problems.push("superseded_by contains a non-uuid");
    if (action === "superseded" && supersededBy.length === 0) problems.push("superseded rows need superseded_by");
    if (action === "retired_spurious" && supersededBy.length > 0) {
      problems.push("retired_spurious rows may not carry superseded_by");
    }
    const identity = identityKey(districtId, electionDate, normalizeElectionTitleKey(officialBallotTitle));
    if (seen.has(identity)) problems.push("duplicate identity in manifest");
    seen.add(identity);
    if (problems.length > 0) {
      invalid.push(`line ${line}: ${problems.join("; ")}`);
      return;
    }
    parsed.push({
      line,
      electionId: electionId.length > 0 ? electionId : null,
      districtId,
      electionDate,
      officialBallotTitle,
      action,
      reason,
      sourceUrl: sourceUrl.length > 0 ? sourceUrl : null,
      supersededBy,
      stagingIngestKey: stagingIngestKey.length > 0 ? stagingIngestKey : null,
    });
  });
  return { rows: parsed, invalid };
}

export type ManifestApplyResult = {
  dryRun: boolean;
  retiredOn: string;
  rows: number;
  inserted: number;
  wouldInsert: number;
  skippedLiveRow: string[];
  skippedAlreadyInLedger: string[];
  invalid: string[];
};

export async function applyManifest(
  client: RetiredIdentityClient,
  manifest: { rows: ManifestRow[]; invalid: string[] },
  options: { dryRun: boolean; retiredOn: string }
): Promise<ManifestApplyResult> {
  const result: ManifestApplyResult = {
    dryRun: options.dryRun,
    retiredOn: options.retiredOn,
    rows: manifest.rows.length,
    inserted: 0,
    wouldInsert: 0,
    skippedLiveRow: [],
    skippedAlreadyInLedger: [],
    invalid: [...manifest.invalid],
  };

  await client.query("BEGIN");
  try {
    const plan: Array<{ row: ManifestRow; titleKey: string; stagingIngestKey: string | null }> = [];
    for (const row of manifest.rows) {
      const label = `line ${row.line} (${row.officialBallotTitle} ${row.electionDate})`;
      const titleKey = normalizeElectionTitleKey(row.officialBallotTitle);

      const district = await client.query<{ canonical_district_id: string | null }>(
        `SELECT canonical_district_id FROM public.districts WHERE id = $1::uuid`,
        [row.districtId]
      );
      if (!district.rows[0]) {
        result.invalid.push(`${label}: district ${row.districtId} does not exist`);
        continue;
      }
      const live = await client.query<{ id: string }>(
        `
          SELECT id FROM public.elections
          WHERE district_id = $1::uuid AND election_date = $2::date AND official_ballot_title_key = $3
        `,
        [row.districtId, row.electionDate, titleKey]
      );
      if (live.rows[0]) {
        result.skippedLiveRow.push(`${label}: elections row ${live.rows[0].id} is live`);
        continue;
      }
      const ledger = await client.query<{ id: string }>(
        `
          SELECT id FROM public.retired_election_identities
          WHERE district_id = $1::uuid AND election_date = $2::date AND official_ballot_title_key = $3
            AND reinstated_at IS NULL
        `,
        [row.districtId, row.electionDate, titleKey]
      );
      if (ledger.rows[0]) {
        result.skippedAlreadyInLedger.push(`${label}: ledger row ${ledger.rows[0].id}`);
        continue;
      }
      if (row.supersededBy.length > 0) {
        const survivors = await client.query<{ id: string }>(
          `SELECT id FROM public.elections WHERE id = ANY($1::uuid[])`,
          [row.supersededBy]
        );
        const found = new Set(survivors.rows.map((survivor) => survivor.id));
        const absent = row.supersededBy.filter((id) => !found.has(id));
        if (absent.length > 0) {
          result.invalid.push(`${label}: superseded_by id(s) not found: ${absent.join(", ")}`);
          continue;
        }
      }
      const stagingIngestKey =
        row.stagingIngestKey ??
        (await findStagingIngestKeysForIdentity(client, row.districtId, titleKey, row.electionDate))[0] ??
        null;
      plan.push({ row, titleKey, stagingIngestKey });
    }

    result.wouldInsert = plan.length;
    if (options.dryRun) {
      await client.query("ROLLBACK");
      return result;
    }
    for (const item of plan) {
      await insertRetiredElectionIdentity(client, {
        districtId: item.row.districtId,
        electionDate: item.row.electionDate,
        officialBallotTitle: item.row.officialBallotTitle,
        officialBallotTitleKey: item.titleKey,
        raceType: null,
        electionId: item.row.electionId,
        action: item.row.action,
        reason: item.row.reason,
        sourceUrl: item.row.sourceUrl,
        supersededByElectionIds: item.row.supersededBy,
        stagingIngestKey: item.stagingIngestKey,
        retiredAt: `${options.retiredOn}T12:00:00Z`,
      });
      result.inserted += 1;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:elections:backfill-retired-ledger", process.argv.slice(2), [
    { name: "--discover", value: "none" },
    { name: "--out", value: "space" },
    { name: "--retire-tsv", value: "space" },
    { name: "--manifest", value: "space" },
    { name: "--retired-on", value: "space" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const discover = process.argv.includes("--discover");
  const manifestPath = readFlag("--manifest");
  const dryRun = process.argv.includes("--dry-run");
  if (discover === Boolean(manifestPath)) {
    throw new Error(`Pass exactly one of --discover or --manifest.\n${usage()}`);
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    if (discover) {
      const outPath = readFlag("--out");
      if (!outPath) throw new Error(`--discover requires --out <tsv>.\n${usage()}`);
      const retireLists: RetireListRow[] = [];
      for (const path of (readFlag("--retire-tsv") ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
        retireLists.push(...parseRetireList(await readFile(path, "utf8"), path));
      }
      await runDiscover(client, outPath, retireLists);
      return;
    }

    const retiredOn = readFlag("--retired-on") ?? new Date().toISOString().slice(0, 10);
    if (!ISO_DATE_RE.test(retiredOn)) throw new Error(`--retired-on must be YYYY-MM-DD: ${retiredOn}`);
    const manifest = parseManifest(await readFile(manifestPath!, "utf8"));
    const result = await applyManifest(client, manifest, { dryRun, retiredOn });
    console.log(JSON.stringify({ mode: "manifest", manifest: manifestPath, ...result }, null, 2));
    if (result.invalid.length > 0 && !dryRun) {
      process.exitCode = 1;
    }
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
