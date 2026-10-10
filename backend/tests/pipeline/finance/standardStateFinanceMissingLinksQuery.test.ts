import { describe, expect, it, vi } from "vitest";

import { createStandardStateFinanceMissingLinksQuery } from "../../../src/pipeline/finance/standardStateFinanceMissingLinksQuery.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

// The Texas missing-links query text as it stood before the builder landed
// (origin/main texasCandidateFinanceAutoLink.ts). The builder must emit it
// byte-for-byte for the Texas config; 15 sibling states carried the same
// text modulo state code and links table.
const EXPECTED_TEXAS_SQL = `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(
              regexp_replace(
                substring(district.geoid_compact from char_length(district.state_fips) + 1),
                '^0+',
                ''
              ),
              ''
            )
          ELSE NULL
        END AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE candidate.deleted_at IS NULL
        AND district.state = 'TX'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.tx_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $2::int
    `;

function createMockDb(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

function createTexasQuery() {
  return createStandardStateFinanceMissingLinksQuery({
    state: "TX",
    linksTable: "tx_candidate_finance_links",
    eligibleOfficeKeys: ["statewide::Governor", "state_upper::State Senator"],
  });
}

describe("createStandardStateFinanceMissingLinksQuery", () => {
  it("emits the Texas missing-links SQL byte-for-byte and maps rows to camelCase", async () => {
    const db = createMockDb([
      {
        candidate_id: "candidate-1",
        election_id: "election-1",
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "state_upper",
        office_name: "State Senator",
        district: "12",
      },
    ]);

    const rows = await createTexasQuery()(db, {
      now: NOW,
      maxCandidates: 25,
      electionLookbackDays: 30,
      electionLookaheadDays: 730,
    });

    expect(String(db.query.mock.calls[0]?.[0])).toBe(EXPECTED_TEXAS_SQL);
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      25,
      30,
      730,
      ["statewide::Governor", "state_upper::State Senator"],
    ]);
    expect(rows).toEqual([
      {
        candidateId: "candidate-1",
        electionId: "election-1",
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "12",
      },
    ]);
  });

  it("binds NULL for an omitted maxCandidates so Postgres applies LIMIT ALL", async () => {
    const db = createMockDb();
    await createTexasQuery()(db, { now: NOW, electionLookbackDays: 30, electionLookaheadDays: 730 });
    expect(db.query.mock.calls[0]?.[1]?.[1]).toBeNull();
  });

  it("interpolates the state code and links table for a sibling state", async () => {
    const db = createMockDb();
    await createStandardStateFinanceMissingLinksQuery({
      state: "HI",
      linksTable: "hi_candidate_finance_links",
      eligibleOfficeKeys: ["statewide::Governor"],
    })(db, { now: NOW, maxCandidates: 5, electionLookbackDays: 1, electionLookaheadDays: 1 });
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("        AND district.state = 'HI'\n");
    expect(sql).toContain("          FROM public.hi_candidate_finance_links AS link\n");
    expect(sql).not.toContain("TX");
    expect(sql).not.toContain("tx_");
  });

  it("passes a fresh eligible-office array on every call", async () => {
    const db = createMockDb();
    const query = createTexasQuery();
    const input = { now: NOW, maxCandidates: 5, electionLookbackDays: 1, electionLookaheadDays: 1 };
    await query(db, input);
    await query(db, input);
    const first = db.query.mock.calls[0]?.[1]?.[4];
    const second = db.query.mock.calls[1]?.[1]?.[4];
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("rejects invalid configuration at construction", () => {
    const base = { state: "TX", linksTable: "tx_candidate_finance_links", eligibleOfficeKeys: ["statewide::Governor"] };
    expect(() => createStandardStateFinanceMissingLinksQuery({ ...base, state: "Texas" })).toThrow(
      "Invalid standard finance missing-links state: Texas"
    );
    expect(() => createStandardStateFinanceMissingLinksQuery({ ...base, state: "tx" })).toThrow(
      "Invalid standard finance missing-links state: tx"
    );
    expect(() =>
      createStandardStateFinanceMissingLinksQuery({ ...base, linksTable: "tx_links; DROP TABLE" })
    ).toThrow("Invalid standard finance missing-links table identifier: tx_links; DROP TABLE");
    expect(() => createStandardStateFinanceMissingLinksQuery({ ...base, eligibleOfficeKeys: [] })).toThrow(
      "Standard finance missing-links eligible office keys must not be empty"
    );
  });
});
