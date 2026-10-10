import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";

import { assertKnownCliFlags } from "./manualCliFlags.js";
import { isLegacyDuplicateMigrationSet } from "./legacyDuplicateMigrations.js";
type RequiredColumn = {
  table: string;
  column: string;
};

type RequiredTable = {
  table: string;
};

type RequiredUniqueObject = {
  table: string;
  name: string;
  columns: string[];
};

type UniqueObjectDefinition = {
  table: string;
  name: string;
  isUnique: boolean;
  isValid: boolean;
  isPartial: boolean;
  columns: string[];
};

const REQUIRED_COLUMNS: RequiredColumn[] = [
  { table: "staging_items", column: "ingest_key" },
  { table: "staging_items", column: "ai_raw_debug" },
  { table: "candidates", column: "display_name" },
  { table: "candidates", column: "official_website_url" },
  { table: "candidates", column: "former_website_urls" },
  { table: "candidates", column: "fec_ids" },
  { table: "candidates", column: "state_filing_ids" },
  { table: "candidate_elections", column: "candidate_id" },
  { table: "candidate_elections", column: "election_id" },
  { table: "candidate_elections", column: "updated_at" },
  { table: "candidate_records", column: "candidate_id" },
  { table: "candidate_records", column: "description" },
  { table: "candidate_records", column: "source_url" },
  { table: "candidate_records", column: "event_date" },
  { table: "candidate_records", column: "record_identity_key" },
  { table: "candidate_records", column: "updated_at" },
  { table: "candidate_record_area_tags", column: "candidate_record_id" },
  { table: "candidate_record_area_tags", column: "research_area_id" },
  { table: "candidate_record_area_tags", column: "stance" },
  { table: "candidate_record_area_tags", column: "updated_at" },
  { table: "ballot_measures", column: "election_id" },
  { table: "ballot_measures", column: "summary" },
  { table: "ballot_measures", column: "what_yes_means" },
  { table: "ballot_measures", column: "what_no_means" },
  { table: "ballot_measures", column: "source_url" },
  { table: "ballot_measures", column: "official_measure_url" },
  { table: "ballot_measures", column: "proposed_by" },
  { table: "ballot_measures", column: "proposed_by_about" },
  { table: "ballot_measures", column: "proposed_by_source_url" },
  { table: "ballot_measures", column: "proposed_by_researched_at" },
  { table: "ballot_measures", column: "research_area_tags_researched_at" },
  { table: "ballot_measures", column: "updated_at" },
  { table: "ballot_measure_research_area_tags", column: "ballot_measure_id" },
  { table: "ballot_measure_research_area_tags", column: "research_area_id" },
  { table: "ballot_measure_research_area_tags", column: "stance" },
  { table: "ballot_measure_research_area_tags", column: "updated_at" },
  { table: "office_research_areas", column: "office_id" },
  { table: "research_areas", column: "slug" },
  // Deferral-ledger columns the record/due/resolve commands read and write.
  // Its dedupe indexes are deliberately PARTIAL, so they cannot be listed in
  // REQUIRED_UNIQUE_OBJECTS below — that check treats a partial index as drift.
  { table: "manual_research_deferrals", column: "district_id" },
  { table: "manual_research_deferrals", column: "election_id" },
  { table: "manual_research_deferrals", column: "stage" },
  { table: "manual_research_deferrals", column: "blocker_key" },
  { table: "manual_research_deferrals", column: "reason" },
  { table: "manual_research_deferrals", column: "blocked_until" },
  { table: "manual_research_deferrals", column: "source_url" },
  { table: "manual_research_deferrals", column: "district_name_snapshot" },
  { table: "manual_research_deferrals", column: "status" },
  { table: "manual_research_deferrals", column: "resolved_at" },
  { table: "manual_research_deferrals", column: "resolution_note" },
  { table: "manual_research_deferrals", column: "updated_at" },
  // Sweep routing: the records writer reads (and backfills) the officeholder
  // answer that picks the discovery question list.
  { table: "candidates", column: "has_held_public_office" },
  // Sweep-confirmation columns the records writers persist and the audit reads.
  { table: "candidate_record_sweep_confirmations", column: "candidate_id" },
  { table: "candidate_record_sweep_confirmations", column: "confirmed_gap_ids" },
  { table: "candidate_record_sweep_confirmations", column: "evidence" },
  { table: "candidate_record_sweep_confirmations", column: "context_type" },
  { table: "candidate_record_sweep_confirmations", column: "context_id" },
  { table: "candidate_record_sweep_confirmations", column: "confirmed_at" },
];

const REQUIRED_TABLES: RequiredTable[] = [
  { table: "user_candidate_follow_notification_events" },
  { table: "manual_research_deferrals" },
  { table: "candidate_record_sweep_confirmations" },
];

const REQUIRED_UNIQUE_OBJECTS: RequiredUniqueObject[] = [
  {
    table: "candidate_elections",
    name: "uq_candidate_elections_candidate_id_election_id",
    columns: ["candidate_id", "election_id"],
  },
  {
    table: "candidate_records",
    name: "uq_candidate_records_candidate_identity_key",
    columns: ["candidate_id", "record_identity_key"],
  },
  {
    table: "candidate_record_sweep_confirmations",
    name: "candidate_record_sweep_confirmations_pkey",
    columns: ["candidate_id", "context_type", "context_id"],
  },
  { table: "ballot_measures", name: "uq_ballot_measures_election_id", columns: ["election_id"] },
];

function resolveMigrationsDir(): string {
  const candidates = [
    resolve(process.cwd(), "db/migrations"),
    resolve(process.cwd(), "../db/migrations"),
  ];
  const match = candidates.find((path) => existsSync(path));
  if (!match) {
    throw new Error(`Could not find db/migrations from cwd=${process.cwd()}`);
  }
  return match;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:research:preflight",
    "",
    "Checks local DB/schema assumptions needed by manual research writer scripts.",
  ].join("\n");
}

function duplicateMigrationNumbers(files: readonly string[]): Record<string, string[]> {
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const match = /^(\d{3})_.*\.sql$/.exec(file);
    if (!match) {
      continue;
    }
    const number = match[1]!;
    const group = byNumber.get(number) ?? [];
    group.push(file);
    byNumber.set(number, group);
  }

  const duplicates: Record<string, string[]> = {};
  for (const [number, group] of byNumber.entries()) {
    if (group.length > 1) {
      duplicates[number] = group.sort();
    }
  }
  return duplicates;
}

async function loadExistingColumns(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `
  );
  return new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
}

async function loadExistingTables(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function loadUniqueObjectDefinitions(pool: Pool): Promise<Map<string, UniqueObjectDefinition>> {
  const result = await pool.query<{
    table_name: string;
    index_name: string;
    is_unique: boolean;
    is_valid: boolean;
    is_partial: boolean;
    columns: unknown;
  }>(
    `
      SELECT
        table_class.relname AS table_name,
        index_class.relname AS index_name,
        index_row.indisunique AS is_unique,
        index_row.indisvalid AS is_valid,
        index_row.indpred IS NOT NULL AS is_partial,
        COALESCE(
          array_agg(attribute.attname ORDER BY key_columns.ordinality)
            FILTER (WHERE attribute.attname IS NOT NULL),
          ARRAY[]::text[]
        ) AS columns
      FROM pg_index AS index_row
      JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      JOIN pg_class AS table_class
        ON table_class.oid = index_row.indrelid
      JOIN pg_namespace AS namespace
        ON namespace.oid = table_class.relnamespace
      LEFT JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
        ON key_columns.ordinality <= index_row.indnkeyatts
      LEFT JOIN pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum = key_columns.attnum
      WHERE namespace.nspname = 'public'
      GROUP BY table_class.relname, index_class.relname, index_row.indisunique, index_row.indisvalid, index_row.indpred
    `
  );
  return new Map(
    result.rows.map((row) => [
      `${row.table_name}.${row.index_name}`,
      {
        table: row.table_name,
        name: row.index_name,
        isUnique: row.is_unique,
        isValid: row.is_valid,
        isPartial: row.is_partial,
        columns: normalizePgTextArray(row.columns),
      },
    ])
  );
}

function normalizePgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return [];
  }
  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) {
    return [];
  }
  return inner.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
}

function hasExactColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual research preflight`);
  }
  return value;
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:research:preflight", process.argv.slice(2), [{ name: "--help", value: "none" }, { name: "-h", value: "none" }]);
  loadProjectEnv();

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const migrationFiles = await readdir(resolveMigrationsDir());
  const migrationNumberDuplicates = duplicateMigrationNumbers(migrationFiles);
  const unallowedMigrationNumberDuplicates = Object.fromEntries(
    Object.entries(migrationNumberDuplicates).filter(
      ([prefix, filenames]) => !isLegacyDuplicateMigrationSet(prefix, filenames)
    )
  );

  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });

  try {
    const [columns, tables, uniqueObjectDefinitions] = await Promise.all([
      loadExistingColumns(pool),
      loadExistingTables(pool),
      loadUniqueObjectDefinitions(pool),
    ]);

    const missingTables = REQUIRED_TABLES.filter((entry) => !tables.has(entry.table));
    const missingColumns = REQUIRED_COLUMNS.filter(
      (entry) => !columns.has(`${entry.table}.${entry.column}`)
    );
    const invalidUniqueObjects = REQUIRED_UNIQUE_OBJECTS.flatMap((entry) => {
      const definition = uniqueObjectDefinitions.get(`${entry.table}.${entry.name}`);
      if (!definition) {
        return [{ ...entry, reason: "missing" }];
      }
      if (!definition.isUnique) {
        return [{ ...entry, reason: "not_unique", actualColumns: definition.columns }];
      }
      if (!definition.isValid) {
        return [{ ...entry, reason: "invalid_index", actualColumns: definition.columns }];
      }
      if (definition.isPartial) {
        return [{ ...entry, reason: "partial_index", actualColumns: definition.columns }];
      }
      if (!hasExactColumns(definition.columns, entry.columns)) {
        return [{ ...entry, reason: "wrong_columns", actualColumns: definition.columns }];
      }
      return [];
    });

    const ok =
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      invalidUniqueObjects.length === 0 &&
      Object.keys(unallowedMigrationNumberDuplicates).length === 0;

    const report = {
      ok,
      missingTables,
      missingColumns,
      invalidUniqueObjects,
      unallowedMigrationNumberDuplicates,
      migrationNumberDuplicates,
    };
    console.log(JSON.stringify(report, null, 2));

    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("manual research preflight failed:", message);
  process.exitCode = 1;
});
