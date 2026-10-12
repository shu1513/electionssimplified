import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migration = readFileSync(new URL(
  "../../../../db/migrations/334_clear_oregon_unproven_outside_zeros.sql", import.meta.url,
), "utf8");
// Execute the migration's UPDATE on session-local fixtures, never public data.
const update = migration.replace(/^\s*(?:BEGIN|COMMIT);/gm, "").replaceAll("public.", "pg_temp.");
const link = "11111111-1111-4111-8111-111111111111";
const otherLink = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!databaseUrl)("Oregon legacy outside-zero backfill (requires DATABASE_URL)", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });

  it.each([
    { name: "both unsupported zeros", support: "0.00", oppose: "0.00", expected: [null, null] },
    { name: "positive support", support: "12.34", oppose: "0.00", expected: ["12.34", null] },
    { name: "positive opposition", support: "0.00", oppose: "56.78", expected: [null, "56.78"] },
    { name: "unknown support", support: null, oppose: "0.00", expected: [null, null] },
    { name: "unknown opposition", support: "0.00", oppose: null, expected: [null, null] },
    { name: "existing positives", support: "12.34", oppose: "56.78", expected: ["12.34", "56.78"] },
    { name: "existing unknowns", support: null, oppose: null, expected: [null, null] },
    { name: "group-backed summary", support: "0.00", oppose: "56.78", groupLink: link, groupYear: 2026, expected: ["0.00", "56.78"] },
    { name: "group-backed zeros", support: "0.00", oppose: "0.00", groupLink: link, groupYear: 2026, expected: ["0.00", "0.00"] },
    { name: "different link's group", support: "0.00", oppose: "0.00", groupLink: otherLink, groupYear: 2026, expected: [null, null] },
    { name: "different year's group", support: "0.00", oppose: "0.00", groupLink: link, groupYear: 2024, expected: [null, null] },
  ])("handles $name without changing direct finance", async fixture => {
    await client.query("BEGIN");
    try {
      await client.query(`
        CREATE TEMP TABLE or_candidate_finance_summaries (
          link_id uuid, election_year integer, outside_support_total numeric(16,2),
          outside_oppose_total numeric(16,2), total_receipts numeric(16,2),
          last_synced_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE or_candidate_finance_outside_groups (
          link_id uuid, election_year integer
        ) ON COMMIT DROP;
      `);
      await client.query(`INSERT INTO pg_temp.or_candidate_finance_summaries
        VALUES ($1, 2026, $2, $3, 12345.67, '2026-10-11T00:00:00Z')`, [link, fixture.support, fixture.oppose]);
      if (fixture.groupLink) await client.query(
        "INSERT INTO pg_temp.or_candidate_finance_outside_groups VALUES ($1, $2)", [fixture.groupLink, fixture.groupYear],
      );
      await client.query(update);
      const read = () => client.query(`SELECT outside_support_total, outside_oppose_total, total_receipts,
        last_synced_at FROM pg_temp.or_candidate_finance_summaries`);
      const first = await read();
      expect(first.rows).toEqual([{
        outside_support_total: fixture.expected[0], outside_oppose_total: fixture.expected[1],
        total_receipts: "12345.67", last_synced_at: new Date("2026-10-11T00:00:00Z"),
      }]);
      await client.query(update);
      expect((await read()).rows).toEqual(first.rows);
      const groups = await client.query("SELECT count(*)::int AS count FROM pg_temp.or_candidate_finance_outside_groups");
      expect(groups.rows[0].count).toBe(fixture.groupLink ? 1 : 0);
    } finally { await client.query("ROLLBACK"); }
  });
});
