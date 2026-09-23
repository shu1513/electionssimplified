import { describe, expect, it, vi } from "vitest";

import {
  lookupBallotSummariesByDistrictIds,
  lookupElectionDetailById,
} from "../../../src/pipeline/address/ballotLookup.js";

const districtId = "11111111-1111-4111-8111-111111111111";
const electionId = "22222222-2222-4222-8222-222222222222";

const districtRow = {
  id: districtId,
  district_type: "county",
  geoid_compact: "06037",
  name: "Los Angeles County",
  state: "CA",
  state_fips: "06",
  representation_power_score: "72.5",
  population: null,
};

const electionFields = {
  district_id: districtId,
  district_type: "county",
  geoid_compact: "06037",
  district_name: "Los Angeles County",
  state: "CA",
  state_fips: "06",
  representation_power_score: "72.5",
  population: null,
  race_type: "office",
  official_ballot_title: "Sheriff",
  election_date: "2026-11-03",
  election_stage: "general",
  is_partisan: false,
  discovery_contest_family: "non_judicial_office",
  sources: [],
  office_id: null,
  office_scope: null,
  office_canonical_name: null,
  office_summary: null,
};

// Withdrawn candidates are hidden from election pages entirely (product
// decision): both the detail roster and the summary count must exclude them,
// or the ballot would claim more candidates than the detail page shows.
describe("withdrawn-candidate filtering", () => {
  it("excludes withdrawn links from the election-detail candidate query", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("FROM public.elections AS e") && text.includes("WHERE e.id = $1::uuid")) {
        return { rows: [{ election_id: electionId, ...electionFields }] };
      }
      return { rows: [] };
    });

    await lookupElectionDetailById({ query } as never, electionId);

    const candidateSql = calls.find((sql) => sql.includes("ce.id AS candidate_election_id"));
    expect(candidateSql).toBeDefined();
    expect(candidateSql).toContain("ce.status <> 'withdrawn'");

    // The staged roster size the uncontested rule reads takes withdrawn
    // links off, or a withdrawn name still in the staged payload would keep
    // a decided race looking contested.
    const stagedSql = calls.find((sql) => sql.includes("AS staged_roster_size"));
    expect(stagedSql).toBeDefined();
    expect(stagedSql).toContain("withdrawn.status = 'withdrawn'");
  });

  it("excludes withdrawn links from the ballot summary candidate count", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("FROM public.districts")) {
        return { rows: [districtRow] };
      }
      if (text.includes("FROM public.elections AS e") && text.includes("e.district_id = ANY")) {
        return { rows: [{ election_id: electionId, ...electionFields }] };
      }
      return { rows: [] };
    });

    await lookupBallotSummariesByDistrictIds({ query } as never, [districtId]);

    const countSql = calls.find((sql) => sql.includes("candidate_count"));
    expect(countSql).toBeDefined();
    expect(countSql).toContain("ce.status <> 'withdrawn'");

    const stagedSql = calls.find((sql) => sql.includes("AS staged_roster_size"));
    expect(stagedSql).toBeDefined();
    expect(stagedSql).toContain("withdrawn.status = 'withdrawn'");
  });
});
