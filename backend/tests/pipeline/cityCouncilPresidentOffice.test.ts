import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { OfficeMatcher } from "../../src/pipeline/elections/officeMatcher.js";

const MIGRATION_398_SQL = readFileSync(
  new URL("../../../db/migrations/398_add_place_city_council_president_office.sql", import.meta.url),
  "utf8"
);
const SEED_OFFICES_TS = readFileSync(new URL("../../src/scripts/seedOffices.ts", import.meta.url), "utf8");

// (canonical name, alias text, normalized alias) rows of the migration's alias VALUES list.
function migrationAliases(): Array<[string, string, string]> {
  return [...MIGRATION_398_SQL.matchAll(/^\s+\('([^']+)', '([^']+)', '([^']+)'\)/gm)].map((match) => [
    match[1],
    match[2],
    match[3],
  ]);
}

describe("migration 398", () => {
  it("adds every alias to seedOffices.ts too, so a reseed keeps them", () => {
    const aliases = migrationAliases();
    expect(aliases.length).toBe(8);
    for (const [canonicalName, aliasText] of aliases) {
      expect(SEED_OFFICES_TS, aliasText).toContain(
        `scope: "place",\n    officeCanonicalName: "${canonicalName}",\n    aliasText: "${aliasText}",`
      );
    }
    expect(SEED_OFFICES_TS).toContain('canonicalName: "City Council President"');
  });
});

describe("City Council President office", () => {
  it("matches St. Louis' and Nashville's council-head titles, and the two new names", async () => {
    const offices = [
      { id: "office-president", canonical_name: "City Council President" },
      { id: "office-alderman", canonical_name: "Alderman" },
      { id: "office-council", canonical_name: "City Council Member" },
      { id: "office-mayor", canonical_name: "Mayor" },
    ];
    const byName = new Map(offices.map((office) => [office.canonical_name, office.id]));
    const aliases = migrationAliases().map(([canonicalName, , normalized]) => ({
      office_id: byName.get(canonicalName),
      normalized_alias: normalized,
    }));
    const query = vi.fn(async (sql: string) =>
      sql.includes("FROM public.office_title_aliases") ? { rows: aliases } : { rows: offices }
    );
    const matcher = new OfficeMatcher({ query } as never);

    const cases: Array<[string, string]> = [
      ["President of the Board of Aldermen", "office-president"],
      ["Metropolitan Vice Mayor", "office-president"],
      ["Alder District 5", "office-alderman"],
      ["Member of Council at Large", "office-council"],
    ];
    for (const [title, officeId] of cases) {
      const result = await matcher.resolve({
        scope: "place",
        districtName: "St. Louis city, Missouri",
        state: "MO",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBe(officeId);
    }
  });
});
