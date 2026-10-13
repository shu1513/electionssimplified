import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGACY_DUPLICATE_MIGRATION_FILES_BY_PREFIX,
  isLegacyDuplicateMigrationSet,
} from "../../src/scripts/legacyDuplicateMigrations.js";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, "../../src/scripts");
const migrationsDir = resolve(here, "../../../db/migrations");

// Both enforcers kept private copies of this allowlist until PR #592, and PR
// #587 had updated only dbMigrate's — so `db:migrate` accepted the duplicate
// 215 pair while `manual:research:preflight` hard-failed on it, blocking every
// manual research run. These tests pin the shared arrangement and the list.
describe("legacy duplicate migration allowlist", () => {
  it("is the only copy — neither enforcer redeclares it", async () => {
    for (const file of ["dbMigrate.ts", "checkManualResearchPreflight.ts"]) {
      const source = await readFile(resolve(scriptsDir, file), "utf8");
      expect(source, `${file} must not declare its own allowlist`).not.toMatch(
        /(const|let)\s+LEGACY_DUPLICATE_MIGRATION_FILES_BY_PREFIX/
      );
      expect(source, `${file} must not reimplement the comparison`).not.toMatch(
        /function\s+isLegacyDuplicateMigrationSet/
      );
      expect(source, `${file} must import the shared module`).toContain(
        './legacyDuplicateMigrations.js"'
      );
    }
  });

  it("lists real migration filenames, at least two per allowlisted prefix", async () => {
    const onDisk = new Set((await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")));

    for (const [prefix, filenames] of LEGACY_DUPLICATE_MIGRATION_FILES_BY_PREFIX) {
      expect(filenames.length, `prefix ${prefix} is not a duplicate set`).toBeGreaterThan(1);
      expect(new Set(filenames).size, `prefix ${prefix} repeats a filename`).toBe(filenames.length);
      for (const filename of filenames) {
        expect(
          filename.startsWith(`${prefix}_`),
          `${filename} does not carry prefix ${prefix}`
        ).toBe(true);
        // #1575 is still a separate open PR. Predeclare its already-applied
        // filename so #1578 can merge first without importing Kansas code.
        // Every other allowlisted file, including #1578's own, must exist.
        if (filename === "336_add_kansas_independent_expenditure_evidence.sql" && !onDisk.has(filename)) {
          expect(onDisk.has("336_add_limit_foreign_influence_research_area.sql")).toBe(true);
          continue;
        }
        // A stale entry means an allowlisted migration was renamed — the one
        // thing this list exists to prevent.
        expect(onDisk.has(filename), `${filename} is allowlisted but not in db/migrations`).toBe(
          true
        );
      }
    }
  });

  it("covers every duplicate prefix actually present in db/migrations", async () => {
    const byPrefix = new Map<string, string[]>();
    for (const name of await readdir(migrationsDir)) {
      const match = /^(\d+)_.+\.sql$/.exec(name);
      if (!match) {
        continue;
      }
      const prefix = match[1]!;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    }

    const unallowed = [...byPrefix.entries()]
      .filter(([prefix, names]) => names.length > 1 && !isLegacyDuplicateMigrationSet(prefix, names))
      .map(([prefix]) => prefix);

    expect(
      unallowed,
      "new duplicate prefixes must be allowlisted (never renumber an applied migration)"
    ).toEqual([]);
  });

  it("accepts the applied 336 pair in either order but rejects new collisions", () => {
    const pair = [
      "336_add_kansas_independent_expenditure_evidence.sql",
      "336_add_limit_foreign_influence_research_area.sql",
    ];
    expect(isLegacyDuplicateMigrationSet("336", pair)).toBe(true);
    expect(isLegacyDuplicateMigrationSet("336", [...pair].reverse())).toBe(true);
    expect(isLegacyDuplicateMigrationSet("336", [pair[0]!])).toBe(false);
    expect(isLegacyDuplicateMigrationSet("336", [pair[1]!])).toBe(false);
    expect(isLegacyDuplicateMigrationSet("336", [...pair, "336_unreviewed.sql"])).toBe(false);
    expect(isLegacyDuplicateMigrationSet("336", [pair[0]!, "336_unreviewed.sql"])).toBe(false);
  });

  it("matches only the exact allowlisted filename set", () => {
    const [prefix, filenames] = [...LEGACY_DUPLICATE_MIGRATION_FILES_BY_PREFIX][0]!;

    expect(isLegacyDuplicateMigrationSet(prefix, filenames)).toBe(true);
    // A third file landing on an allowlisted prefix is a NEW collision that
    // nobody has reviewed, so it must not inherit the existing exemption.
    expect(isLegacyDuplicateMigrationSet(prefix, [...filenames, `${prefix}_unreviewed.sql`])).toBe(
      false
    );
    expect(isLegacyDuplicateMigrationSet("999", [`999_a.sql`, `999_b.sql`])).toBe(false);
  });
});
