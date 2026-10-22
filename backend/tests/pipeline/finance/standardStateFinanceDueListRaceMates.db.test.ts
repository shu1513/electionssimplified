import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listDueTexasCandidateFinanceSyncRows } from "../../../src/pipeline/texasFinance/texasCandidateFinanceBatchSync.js";

/**
 * Live check that the shared due list syncs race-mates together: when one
 * candidate of an election is stale, every other linked candidate of that
 * election joins the batch even if fresh, so opponents' outside groups come
 * from the same source snapshot. Elections in other races stay out.
 *
 * Fixture dates sit in 2099 so real Texas rows never fall in the window.
 * Needs a live Postgres (DATABASE_URL) with migrations applied.
 */

const databaseUrl = process.env.DATABASE_URL;
const FIXTURE_TAG = "due-list-race-mates";
const NOW = new Date("2099-01-01T00:00:00.000Z");
const DUE_INPUT = {
  now: NOW,
  staleAfterDays: 7,
  maxCandidates: 25,
  electionLookbackDays: 30,
  electionLookaheadDays: 60,
};

describe.skipIf(!databaseUrl)("standard finance due list race-mates (requires DATABASE_URL)", () => {
  let pool: Pool;
  let districtId: string;
  const candidateIds: Record<"stale" | "freshMate" | "otherRace", string> = {
    stale: "",
    freshMate: "",
    otherRace: "",
  };

  async function insertElection(key: string, officeId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.elections
         (district_id, office_id, official_ballot_title, official_ballot_title_key, election_date, sources, race_type)
       VALUES ($1::uuid, $2::uuid, $3, $3, '2099-01-20', '["test"]'::jsonb, 'office')
       RETURNING id::text AS id`,
      [districtId, officeId, `${FIXTURE_TAG}-${key}`]
    );
    return result.rows[0]!.id;
  }

  async function insertLinkedCandidate(
    name: string,
    electionId: string,
    lastSyncedAt: Date
  ): Promise<string> {
    const candidate = await pool.query<{ id: string }>(
      `INSERT INTO public.candidates (first_name, last_name, party, state) VALUES ($1, $2, 'Nonpartisan', 'TX')
       RETURNING id::text AS id`,
      [name, FIXTURE_TAG]
    );
    const candidateId = candidate.rows[0]!.id;
    await pool.query(
      `INSERT INTO public.candidate_elections (candidate_id, election_id) VALUES ($1::uuid, $2::uuid)`,
      [candidateId, electionId]
    );
    const link = await pool.query<{ id: string }>(
      `INSERT INTO public.tx_candidate_finance_links
         (candidate_id, election_id, election_year, candidate_name_normalized, office_name, committee_id, committee_name)
       VALUES ($1::uuid, $2::uuid, 2099, upper($3), 'Governor', $4, $5)
       RETURNING id::text AS id`,
      [candidateId, electionId, name, `${FIXTURE_TAG}-${name}`, `Friends of ${name}`]
    );
    await pool.query(
      `INSERT INTO public.tx_candidate_finance_summaries (link_id, election_year, last_synced_at)
       VALUES ($1::uuid, 2099, $2::timestamptz)`,
      [link.rows[0]!.id, lastSyncedAt.toISOString()]
    );
    return candidateId;
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM public.candidates WHERE last_name = $1", [FIXTURE_TAG]);
    await pool.query("DELETE FROM public.elections WHERE official_ballot_title_key LIKE $1", [`${FIXTURE_TAG}-%`]);
    await pool.query("DELETE FROM public.districts WHERE geoid_compact = $1", [FIXTURE_TAG]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    await cleanup();
    const office = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM public.offices WHERE scope = 'statewide' AND canonical_name = 'Governor' LIMIT 1`
    );
    const officeId =
      office.rows[0]?.id ??
      (
        await pool.query<{ id: string }>(
          `INSERT INTO public.offices (scope, canonical_name, summary) VALUES ('statewide', 'Governor', $1)
           RETURNING id::text AS id`,
          [FIXTURE_TAG]
        )
      ).rows[0]!.id;
    const district = await pool.query<{ id: string }>(
      `INSERT INTO public.districts (geoid_compact, name, state, state_fips, district_type, population)
       VALUES ($1, 'Race-mate fixture', 'TX', '48', 'statewide', 1) RETURNING id::text AS id`,
      [FIXTURE_TAG]
    );
    districtId = district.rows[0]!.id;

    const raceElection = await insertElection("race", officeId);
    const otherElection = await insertElection("other", officeId);
    const stale = new Date("2098-12-01T00:00:00.000Z");
    const fresh = new Date("2098-12-31T00:00:00.000Z");
    candidateIds.stale = await insertLinkedCandidate("Stale", raceElection, stale);
    candidateIds.freshMate = await insertLinkedCandidate("Fresh", raceElection, fresh);
    candidateIds.otherRace = await insertLinkedCandidate("Other", otherElection, fresh);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("adds a fresh opponent of a due candidate but not fresh candidates in other races", async () => {
    const result = await listDueTexasCandidateFinanceSyncRows(pool, DUE_INPUT);

    expect(result.totalDueRows).toBe(1);
    expect(result.rows.map((row) => row.candidateId)).toEqual([candidateIds.stale, candidateIds.freshMate]);
  });

  it("does not add race-mates beyond what is eligible when nothing is due", async () => {
    const result = await listDueTexasCandidateFinanceSyncRows(pool, {
      ...DUE_INPUT,
      now: new Date("2098-12-02T00:00:00.000Z"),
    });

    expect(result).toEqual({ rows: [], totalDueRows: 0 });
  });
});
