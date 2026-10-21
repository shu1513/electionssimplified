import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { getPipelineEnv } from "../config/env.js";
import { isLegacyDuplicateMigrationSet } from "./legacyDuplicateMigrations.js";

type AppliedMigrationRow = {
  filename: string;
  checksum: string;
  applied_at: Date;
};

type MigrationPrefixDuplicate = {
  prefix: string;
  filenames: string[];
  legacy_allowed: boolean;
};

const MIGRATION_FILE_RE = /^\d+_.+\.sql$/;
const LOCK_KEY = 780_001_001;

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function getMigrationsDir(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "../../../db/migrations");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isSqlCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("--");
}

function stripOuterTransactionStatements(sql: string): string {
  const lines = sql.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && isSqlCommentOrBlank(lines[first] ?? "")) {
    first += 1;
  }

  let last = lines.length - 1;
  while (last >= 0 && isSqlCommentOrBlank(lines[last] ?? "")) {
    last -= 1;
  }

  const firstLine = (lines[first] ?? "").trim().replace(/;$/, "").toUpperCase();
  const lastLine = (lines[last] ?? "").trim().replace(/;$/, "").toUpperCase();

  const strippedStart = firstLine === "BEGIN" ? first + 1 : first;
  const strippedEnd = lastLine === "COMMIT" ? last - 1 : last;

  if (strippedStart > strippedEnd) {
    return "";
  }
  return lines.slice(strippedStart, strippedEnd + 1).join("\n");
}

type Queryable = Pool | PoolClient;

async function ensureSchemaMigrationsTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const dir = getMigrationsDir();
  const names = await readdir(dir);
  return names
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort((a, b) => {
      const aOrder = Number.parseInt(a.split("_", 1)[0] ?? "", 10);
      const bOrder = Number.parseInt(b.split("_", 1)[0] ?? "", 10);
      return aOrder - bOrder || a.localeCompare(b);
    });
}

function getMigrationPrefix(filename: string): string {
  return filename.split("_", 1)[0] ?? "";
}

function findMigrationPrefixDuplicates(filenames: string[]): MigrationPrefixDuplicate[] {
  const filesByPrefix = new Map<string, string[]>();

  for (const filename of filenames) {
    const prefix = getMigrationPrefix(filename);
    const files = filesByPrefix.get(prefix) ?? [];
    files.push(filename);
    filesByPrefix.set(prefix, files);
  }

  return [...filesByPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => {
      const sortedFiles = files.sort((a, b) => a.localeCompare(b));
      return {
        prefix,
        filenames: sortedFiles,
        legacy_allowed: isLegacyDuplicateMigrationSet(prefix, sortedFiles),
      };
    })
    .sort((a, b) => Number.parseInt(a.prefix, 10) - Number.parseInt(b.prefix, 10) || a.prefix.localeCompare(b.prefix));
}

function getUnallowedMigrationPrefixDuplicates(filenames: string[]): MigrationPrefixDuplicate[] {
  return findMigrationPrefixDuplicates(filenames).filter((duplicate) => !duplicate.legacy_allowed);
}

function throwIfUnallowedMigrationPrefixDuplicates(filenames: string[]): void {
  const unallowedDuplicates = getUnallowedMigrationPrefixDuplicates(filenames);
  if (unallowedDuplicates.length === 0) {
    return;
  }

  throw new Error(`Duplicate migration number prefix(es): ${JSON.stringify(unallowedDuplicates)}`);
}

async function readMigrationFile(filename: string): Promise<{ filename: string; sql: string; checksum: string }> {
  const fullPath = resolve(getMigrationsDir(), filename);
  const sql = await readFile(fullPath, "utf8");
  return { filename, sql, checksum: sha256(sql) };
}

async function getAppliedMap(db: Queryable): Promise<Map<string, AppliedMigrationRow>> {
  const result = await db.query<AppliedMigrationRow>(
    `
      SELECT filename, checksum, applied_at
      FROM schema_migrations
      ORDER BY filename
    `
  );

  const map = new Map<string, AppliedMigrationRow>();
  for (const row of result.rows) {
    map.set(row.filename, row);
  }
  return map;
}

function parseMode(): "status" | "apply" | "baseline" | "check-files" {
  if (process.argv.includes("--check-files")) {
    return "check-files";
  }
  if (process.argv.includes("--status")) {
    return "status";
  }
  if (process.argv.includes("--baseline")) {
    return "baseline";
  }
  return "apply";
}

async function main(): Promise<void> {
  const mode = parseMode();
  const filenames = await listMigrationFiles();
  const duplicatePrefixReport = findMigrationPrefixDuplicates(filenames);

  if (mode === "check-files") {
    throwIfUnallowedMigrationPrefixDuplicates(filenames);
    console.log(
      JSON.stringify(
        {
          mode,
          migrations_dir: getMigrationsDir(),
          total_files: filenames.length,
          duplicate_prefixes: duplicatePrefixReport,
          duplicate_prefixes_ok: true,
        },
        null,
        2
      )
    );
    return;
  }

  // An explicitly supplied connection is sufficient for this infrastructure
  // command; it need not load environment files or AI configuration.
  const databaseUrl = process.env.DATABASE_URL?.trim() || getPipelineEnv().DATABASE_URL;
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    await ensureSchemaMigrationsTable(client);

    throwIfUnallowedMigrationPrefixDuplicates(filenames);

    const migrations = await Promise.all(filenames.map((filename) => readMigrationFile(filename)));
    const applied = await getAppliedMap(client);

    const checksumMismatches = migrations
      .filter((migration) => {
        const prior = applied.get(migration.filename);
        return Boolean(prior && prior.checksum !== migration.checksum);
      })
      .map((migration) => {
        const prior = applied.get(migration.filename) as AppliedMigrationRow;
        return {
          filename: migration.filename,
          expected_checksum: migration.checksum,
          applied_checksum: prior.checksum,
        };
      });

    if (checksumMismatches.length > 0) {
      throw new Error(`Checksum mismatch for applied migration(s): ${JSON.stringify(checksumMismatches)}`);
    }

    const pending = migrations.filter((migration) => !applied.has(migration.filename));

    if (mode === "status") {
      console.log(
        JSON.stringify(
          {
            mode,
            migrations_dir: getMigrationsDir(),
            total_files: migrations.length,
            applied_count: applied.size,
            pending_count: pending.length,
            pending_files: pending.map((migration) => migration.filename),
            duplicate_prefixes: duplicatePrefixReport,
            duplicate_prefixes_ok: true,
          },
          null,
          2
        )
      );
      return;
    }

    if (mode === "baseline") {
      if (applied.size > 0) {
        throw new Error("Cannot baseline: schema_migrations is not empty. Use --status and run normal apply.");
      }

      await client.query("BEGIN");
      try {
        for (const migration of migrations) {
          await client.query(
            `
              INSERT INTO schema_migrations (filename, checksum)
              VALUES ($1, $2)
              ON CONFLICT (filename) DO NOTHING
            `,
            [migration.filename, migration.checksum]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // best-effort rollback for baseline
        }
        throw error;
      }

      console.log(
        JSON.stringify(
          {
            mode,
            baselined_count: migrations.length,
            baselined_files: migrations.map((migration) => migration.filename),
          },
          null,
          2
        )
      );
      return;
    }

    const appliedNow: string[] = [];
    for (const migration of pending) {
      const sqlToRun = stripOuterTransactionStatements(migration.sql);
      await client.query("BEGIN");
      try {
        if (sqlToRun.trim().length > 0) {
          await client.query(sqlToRun);
        }
        await client.query(
          `
            INSERT INTO schema_migrations (filename, checksum)
            VALUES ($1, $2)
          `,
          [migration.filename, migration.checksum]
        );
        await client.query("COMMIT");
        appliedNow.push(migration.filename);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // best-effort rollback on failed migration apply
        }
        throw error;
      }
    }

    console.log(
      JSON.stringify(
        {
          mode,
          applied_count: appliedNow.length,
          applied_files: appliedNow,
          already_applied_count: applied.size,
        },
        null,
        2
      )
    );
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    } catch {
      // best-effort unlock on shutdown
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, reason: toReason(error) }, null, 2));
  process.exitCode = 1;
});
