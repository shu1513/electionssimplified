import { describe, expect, it, vi } from "vitest";

import { applyBallotElectionOrdering } from "../../../src/pipeline/address/ballotElectionOrdering.js";
import type { BallotLookupElectionSummary, BallotSummaryResult } from "../../../src/pipeline/address/ballotLookup.js";

const districtId = "11111111-1111-4111-8111-111111111111";
const candidateId = "44444444-4444-4444-8444-444444444444";
const userId = "99999999-9999-4999-8999-999999999999";

const electionA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const electionB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const electionC = "cccccccc-3333-4333-8333-cccccccccccc";

type FakeElection = {
  id: string;
  election_date?: string;
  official_ballot_title?: string;
  vote_power_score?: number | null;
  population?: number | null;
  research_area_ids?: string[];
  race_type?: string;
  candidate_count?: number;
  has_results?: boolean;
  office_scope?: string;
  office_name?: string;
  contest_family?: string;
  election_stage?: string | null;
};

function makeSummary(
  elections: FakeElection[],
  districts: BallotSummaryResult["districts"] = []
): BallotSummaryResult {
  return {
    district_ids: [districtId],
    districts,
    elections: elections.map(
      (e): BallotLookupElectionSummary => ({
        id: e.id,
        district_id: districtId,
        district: {
          id: districtId,
          district_type: "county",
          geoid_compact: "06037",
          name: "Los Angeles County",
          state: "CA",
          state_fips: "06",
          representation_power_score: 50,
          population: e.population ?? null,
        },
        race_type: e.race_type ?? "office",
        official_ballot_title: e.official_ballot_title ?? "Office",
        election_date: e.election_date ?? "2026-11-03",
        election_stage: (e.election_stage === undefined
          ? "general"
          : e.election_stage) as BallotLookupElectionSummary["election_stage"],
        is_partisan: false,
        discovery_contest_family: e.contest_family ?? "non_judicial_office",
        sources: [],
        candidate_count: e.candidate_count ?? 2,
        ballot_measure_id: null,
        has_results: e.has_results ?? false,
        current_result_outcome: null,
        office: e.office_scope
          ? {
              id: "12121212-1212-4212-8212-121212121212",
              scope: e.office_scope,
              canonical_name: e.office_name ?? "Office",
              summary: "",
            }
          : null,
        research_areas: (e.research_area_ids ?? []).map((areaId) => ({
          id: areaId,
          slug: areaId,
          name: areaId,
          description: null,
        })),
        historical_competitiveness: null,
        vote_power: {
          // undefined = the fixture default; an explicit null is a race with
          // no score (unknown data, or a retention race).
          score: e.vote_power_score === undefined ? 50 : e.vote_power_score,
          label: "medium",
          confidence: "medium",
          representation_level: "medium",
          decisiveness_level: "medium",
          factors: [],
        },
      })
    ),
  };
}

function makeFollowsQuery(rows: { election_id: string; candidate_id: string; display_name: string }[]) {
  return vi.fn().mockResolvedValue({ rows });
}

// Routes the decorator's two queries (candidate follows, research-area
// preference weights) by their distinguishing SQL fragments.
function makeOrderingQuery(fixtures: {
  follows?: { election_id: string; candidate_id: string; display_name: string }[];
  areaPreferences?: { research_area_id: string; rank: number | null }[];
}) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("user_research_area_preferences")) {
      return { rows: fixtures.areaPreferences ?? [] };
    }
    if (sql.includes("user_candidate_follows")) {
      return { rows: fixtures.follows ?? [] };
    }
    throw new Error(`Unexpected SQL in test: ${sql.slice(0, 80)}`);
  });
}

describe("applyBallotElectionOrdering", () => {
  it("orders by vote_power score descending by default", async () => {
    const query = makeFollowsQuery([]);
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, vote_power_score: 20 },
        { id: electionB, vote_power_score: 95 },
      ])
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
    expect(result.elections.every((e) => e.followed_candidates.length === 0)).toBe(true);
  });

  it("sorts a null score (a retention race) after every scored race under vote_power", async () => {
    const query = makeFollowsQuery([]);
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, vote_power_score: null },
        { id: electionB, vote_power_score: 5 },
      ])
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
  });

  it("keeps election date as the outer order: earliest date first, the sort applies within a date", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        { id: electionA, election_date: "2026-11-03", vote_power_score: 95 },
        { id: electionB, election_date: "2026-08-26", vote_power_score: 10 },
        { id: electionC, election_date: "2026-08-26", vote_power_score: 40 },
      ])
    );

    // August before November despite November's higher score; within August
    // the higher score leads.
    expect(result.elections.map((e) => e.id)).toEqual([electionC, electionB, electionA]);
  });

  it("groups followed candidates first only within their election date", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([{ election_id: electionA, candidate_id: candidateId, display_name: "Followed" }]) },
      makeSummary([
        { id: electionA, election_date: "2026-11-03", vote_power_score: 10 },
        { id: electionB, election_date: "2026-11-03", vote_power_score: 95 },
        { id: electionC, election_date: "2026-08-26", vote_power_score: 5 },
      ]),
      { userId }
    );

    // The followed November race leads November, but never jumps above August.
    expect(result.elections.map((e) => e.id)).toEqual([electionC, electionA, electionB]);
  });

  it("breaks title ties numerically so Proposition 4 sorts before Proposition 33", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        { id: electionA, official_ballot_title: "Proposition 33", vote_power_score: 50 },
        { id: electionB, official_ballot_title: "Proposition 4", vote_power_score: 50 },
        { id: electionC, official_ballot_title: "Proposition 12", vote_power_score: 50 },
      ])
    );

    expect(result.elections.map((e) => e.official_ballot_title)).toEqual([
      "Proposition 4",
      "Proposition 12",
      "Proposition 33",
    ]);
  });

  it("orders by district population descending when sort=district_size, unknown populations last", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        { id: electionA, vote_power_score: 95, population: 250_000 },
        { id: electionB, vote_power_score: 10, population: 9_800_000 },
        { id: electionC, vote_power_score: 95, population: null },
      ]),
      { sort: "district_size" }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA, electionC]);
  });

  it("orders by district population ascending when sort=district_size_smallest, unknown populations still last", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        { id: electionA, population: 250_000 },
        { id: electionB, population: 9_800_000 },
        { id: electionC, population: null },
      ]),
      { sort: "district_size_smallest" }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionB, electionC]);
  });

  it("walks the government levels before population under the district-size sorts", async () => {
    // A House district (~760k) is smaller than the county (~9.8M), yet
    // federal outranks county under district_size — level is the outer key,
    // population orders within a level. Measures level on district_type.
    // US Senate offices carry scope "statewide" (no us_senate scope exists);
    // the contest family is what makes them federal, above the House seat
    // by population and above the governor's identical statewide district.
    // Colorado's regent seat is the reverse case: its office is scope
    // "us_house" but it is a state office, so it sits in the state tier,
    // after the governor's larger district.
    const elections = [
      { id: electionA, population: 9_800_000, official_ballot_title: "Sheriff" }, // county (no office)
      { id: electionB, population: 760_000, office_scope: "us_house", official_ballot_title: "US House" },
      { id: electionC, population: 39_000_000, office_scope: "statewide", official_ballot_title: "Governor" },
      {
        id: "88888888-8888-4888-8888-888888888888",
        population: 760_000,
        office_scope: "us_house",
        office_name: "State Board of Regents Member",
        official_ballot_title: "Regent",
      },
      { id: "dddddddd-4444-4444-8444-dddddddddddd", population: 4_000_000, office_scope: "place", official_ballot_title: "Mayor" },
      { id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", population: 39_000_000, office_scope: "presidential", official_ballot_title: "President" },
      { id: "ffffffff-6666-4666-8666-ffffffffffff", population: 20_000, office_scope: "school_unified", official_ballot_title: "School Board" },
      { id: "99999999-7777-4777-8777-999999999999", population: 39_000_000, office_scope: "statewide", contest_family: "us_senate", official_ballot_title: "US Senate" },
    ];
    const biggest = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, makeSummary(elections), {
      sort: "district_size",
    });
    expect(biggest.elections.map((e) => e.official_ballot_title)).toEqual([
      "President",
      "US Senate",
      "US House",
      "Governor",
      "Regent",
      "Sheriff",
      "Mayor",
      "School Board",
    ]);

    const smallest = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, makeSummary(elections), {
      sort: "district_size_smallest",
    });
    // Reverse walk, and within a tier the smaller district leads.
    expect(smallest.elections.map((e) => e.official_ballot_title)).toEqual([
      "School Board",
      "Mayor",
      "Sheriff",
      "Regent",
      "Governor",
      "US House",
      "US Senate",
      "President",
    ]);
  });

  it("keeps a followed race inside its level under the district-size sorts", async () => {
    // Followed-first hoisting a county race above the federal one would
    // split County into two list sections; the tier applies within a level.
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([{ election_id: electionC, candidate_id: candidateId, display_name: "Followed" }]) },
      makeSummary([
        { id: electionA, population: 760_000, office_scope: "us_house" },
        { id: electionB, population: 9_800_000, official_ballot_title: "Assessor" },
        { id: electionC, population: 9_800_000, official_ballot_title: "Sheriff" },
      ]),
      { userId, sort: "district_size" }
    );

    // Federal still leads; within County the followed Sheriff jumps Assessor.
    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionC, electionB]);
  });

  it("groups followed elections first by default for authenticated calls and annotates them", async () => {
    const query = makeFollowsQuery([{ election_id: electionA, candidate_id: candidateId, display_name: "Jane Doe" }]);
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, vote_power_score: 10 },
        { id: electionB, vote_power_score: 95 },
      ]),
      { userId }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionB]);
    expect(result.elections[0]?.followed_candidates).toEqual([
      { candidate_id: candidateId, display_name: "Jane Doe" },
    ]);
    expect(result.elections[1]?.followed_candidates).toEqual([]);
  });

  it("does not group followed elections first when followedFirst is explicitly off, but still annotates them", async () => {
    const query = makeFollowsQuery([{ election_id: electionA, candidate_id: candidateId, display_name: "Jane Doe" }]);
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, vote_power_score: 10 },
        { id: electionB, vote_power_score: 95 },
      ]),
      { userId, followedFirst: false }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
    expect(result.elections.find((e) => e.id === electionA)?.followed_candidates).toEqual([
      { candidate_id: candidateId, display_name: "Jane Doe" },
    ]);
  });

  it("sinks office races with no published candidate list below every readable race", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        // Top vote power, but nothing to read: the card is a "Candidate list
        // not final" placeholder, so it must not lead the ballot.
        { id: electionA, vote_power_score: 99, candidate_count: 0 },
        { id: electionB, vote_power_score: 10 },
      ])
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
  });

  it("keeps candidate-less races with a recorded result in their normal position", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        // Winners can be recorded without candidate links (unmatched winners,
        // see electionResultPayloadContract), and the ballot keeps races
        // three days past election day: a decided race is readable, so it
        // sorts on vote power like any other.
        { id: electionA, vote_power_score: 99, candidate_count: 0, has_results: true },
        { id: electionB, vote_power_score: 10 },
      ])
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionB]);
  });

  it("keeps candidate-less ballot measures in their normal position", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        // A measure legitimately has zero candidates — the measure text is the
        // content, so it sorts on vote power like any other readable race.
        { id: electionA, vote_power_score: 99, candidate_count: 0, race_type: "ballot_measure" },
        { id: electionB, vote_power_score: 10 },
      ])
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionB]);
  });

  it("sinks candidate-less races under every sort, not just the default", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        { id: electionA, election_date: "2026-06-02", candidate_count: 0, population: 900000 },
        { id: electionB, election_date: "2026-11-03", population: 1000 },
      ]),
      { sort: "district_size" }
    );

    // Earliest date (and the bigger district) would normally lead; having
    // nothing to read outranks even the date order.
    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
  });

  it("orders contests in paper-ballot order when sort=state_baseline, applying the state override", async () => {
    const electionD = "dddddddd-4444-4444-8444-dddddddddddd";
    const electionE = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    const electionF = "ffffffff-6666-4666-8666-ffffffffffff";
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        // Deliberately shuffled input; vote power set to fight the ranking so
        // the test fails if state_baseline ever degrades to the default sort.
        { id: electionA, race_type: "ballot_measure", contest_family: "ballot_measure", vote_power_score: 100 },
        { id: electionB, office_scope: "place", vote_power_score: 90 },
        { id: electionC, office_scope: "county", vote_power_score: 80 },
        { id: electionD, office_scope: "statewide", vote_power_score: 10 },
        { id: electionE, office_scope: "statewide", contest_family: "us_senate", vote_power_score: 5 },
        { id: electionF, office_scope: "us_house", vote_power_score: 1 },
      ]),
      { sort: "state_baseline" }
    );

    // The fixture district is California on a general election, so the CA
    // override (stateBallotOrderRules.ts) applies: statewide executives
    // print BEFORE US Senate, unlike the generic baseline.
    expect(result.elections.map((e) => e.id)).toEqual([
      electionD, // statewide executive — CA prints these first
      electionE, // US Senate
      electionF, // US House
      electionC, // county
      electionB, // municipal
      electionA, // ballot measure last
    ]);
  });

  it("state_baseline keeps the generic order on non-general stages", async () => {
    const electionD = "dddddddd-4444-4444-8444-dddddddddddd";
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary([
        { id: electionD, office_scope: "statewide", election_stage: "primary" },
        { id: electionA, office_scope: "statewide", contest_family: "us_senate", election_stage: "primary" },
      ]),
      { sort: "state_baseline" }
    );

    // No override on a primary: US Senate leads under the generic baseline.
    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionD]);
  });

  it("state_baseline gives stage-less measures the state order when they share a general ballot", async () => {
    // Ballot measures are stored without a stage. Washington prints measures
    // first, so on a general ballot the measure must lead the offices.
    const washington = makeSummary([
      { id: electionA, office_scope: "statewide", official_ballot_title: "Governor" },
      { id: electionB, race_type: "ballot_measure", contest_family: "ballot_measure", election_stage: null },
    ]);
    for (const election of washington.elections) {
      election.district = { ...election.district, state: "WA", state_fips: "53", geoid_compact: "53033" };
    }
    const result = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, washington, {
      sort: "state_baseline",
    });
    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);

    // No general contest on the date: the measure keeps the generic slot.
    const alone = makeSummary([
      { id: electionA, office_scope: "statewide", official_ballot_title: "Governor", election_stage: "special" },
      { id: electionB, race_type: "ballot_measure", contest_family: "ballot_measure", election_stage: null },
    ]);
    for (const election of alone.elections) {
      election.district = { ...election.district, state: "WA", state_fips: "53", geoid_compact: "53033" };
    }
    const unchanged = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, alone, {
      sort: "state_baseline",
    });
    expect(unchanged.elections.map((e) => e.id)).toEqual([electionA, electionB]);
  });

  it("state_baseline uses the county's own order when the ballot sits in Los Angeles County", async () => {
    const electionD = "dddddddd-4444-4444-8444-dddddddddddd";
    const electionE = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([]) },
      makeSummary(
        [
          { id: electionA, office_scope: "statewide", official_ballot_title: "Governor" },
          { id: electionB, office_scope: "us_house", official_ballot_title: "United States Representative" },
          { id: electionC, office_scope: "county", official_ballot_title: "Sheriff", election_stage: "runoff" },
          { id: electionD, office_scope: "place", official_ballot_title: "Member of the City Council" },
          { id: electionE, race_type: "ballot_measure", contest_family: "ballot_measure", election_stage: null },
        ],
        [
          {
            id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: 50,
            population: null,
          },
        ]
      ),
      { sort: "state_baseline" }
    );

    // Local first: city council, US House, then the county block (Sheriff,
    // county measure), then the state block.
    expect(result.elections.map((e) => e.id)).toEqual([electionD, electionB, electionC, electionE, electionA]);
  });

  it("shows a county's printed label for state measures under every sort", async () => {
    const laCounty = {
      id: districtId,
      district_type: "county" as const,
      geoid_compact: "06037",
      name: "Los Angeles County",
      state: "CA",
      state_fips: "06",
      representation_power_score: 50,
      population: null,
    };
    const summary = makeSummary(
      [
        {
          id: electionA,
          race_type: "ballot_measure",
          contest_family: "ballot_measure",
          election_stage: null,
          official_ballot_title: "Proposition 1: Housing Bonds",
        },
      ],
      [laCounty]
    );
    summary.elections[0].district = { ...summary.elections[0].district, district_type: "statewide", geoid_compact: "06" };
    const result = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, summary, { sort: "vote_power" });
    expect(result.elections[0].official_ballot_title).toBe("State Measure 1: Housing Bonds");
  });

  it("shows a stored printed label in place of the stored title's label", async () => {
    const summary = makeSummary([
      {
        id: electionA,
        race_type: "ballot_measure",
        contest_family: "ballot_measure",
        election_stage: null,
        official_ballot_title: "Act 2026-341: Lieutenant Governor vacancy",
      },
    ]);
    summary.elections[0].printed_ballot_label = "Statewide Amendment 1";
    const result = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, summary, { sort: "vote_power" });
    expect(result.elections[0].official_ballot_title).toBe("Statewide Amendment 1: Lieutenant Governor vacancy");
    expect(result.elections[0].printed_ballot_label).toBe("Statewide Amendment 1");
  });

  it("breaks ties on the printed title, so numbered measures list in ballot order", async () => {
    const measure = (id: string, official_ballot_title: string) => ({
      id,
      race_type: "ballot_measure" as const,
      contest_family: "ballot_measure" as const,
      election_stage: null,
      official_ballot_title,
    });
    // Stored titles sort A, C, B; the printed numbers say A, B, C.
    const summary = makeSummary([
      measure(electionA, "Conservation Use Amendment"),
      measure(electionB, "Nonpartisan Elections for Probate Judges Amendment"),
      measure(electionC, "Next Generation 9-1-1 Fund Amendment"),
    ]);
    const labels: Record<string, string> = { [electionA]: "Amendment 1", [electionB]: "Amendment 2", [electionC]: "Amendment 3" };
    for (const election of summary.elections) {
      election.printed_ballot_label = labels[election.id];
    }
    for (const sort of ["vote_power", "state_baseline"] as const) {
      const result = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, summary, { sort });
      expect(result.elections.map((e) => e.id)).toEqual([electionA, electionB, electionC]);
    }
  });

  it("shows a title stored in capital letters in title case, under a printed label too", async () => {
    const summary = makeSummary([
      { id: electionA, vote_power_score: 90, official_ballot_title: "PITT COUNTY BOARD OF COMMISSIONERS DISTRICT 06" },
      { id: electionB, vote_power_score: 80, official_ballot_title: "Pitt County Sheriff" },
      {
        id: electionC,
        vote_power_score: 70,
        race_type: "ballot_measure",
        contest_family: "ballot_measure",
        election_stage: null,
        official_ballot_title: "NEXT GENERATION 9-1-1 FUND AMENDMENT",
      },
    ]);
    summary.elections[2].printed_ballot_label = "Amendment 3";
    const result = await applyBallotElectionOrdering({ query: makeFollowsQuery([]) }, summary, { sort: "vote_power" });
    expect(result.elections.map((e) => e.official_ballot_title)).toEqual([
      "Pitt County Board of Commissioners District 06",
      "Pitt County Sheriff",
      "Amendment 3: Next Generation 9-1-1 Fund Amendment",
    ]);
  });

  it("state_baseline is positional: no followed-first grouping, no empty-race sink", async () => {
    const result = await applyBallotElectionOrdering(
      { query: makeFollowsQuery([{ election_id: electionB, candidate_id: candidateId, display_name: "Fol Lowed" }]) },
      makeSummary([
        // Zero-candidate US House race would sink under every other sort.
        { id: electionA, office_scope: "us_house", candidate_count: 0 },
        // Followed municipal race would lead under followed-first grouping.
        { id: electionB, office_scope: "place" },
        { id: electionC, office_scope: "county" },
      ]),
      { userId, sort: "state_baseline", followedFirst: true }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionA, electionC, electionB]);
    // Follow annotations still attach even though grouping is skipped.
    expect(result.elections.find((e) => e.id === electionB)?.followed_candidates).toEqual([
      { candidate_id: candidateId, display_name: "Fol Lowed" },
    ]);
  });

  it("orders by summed saved-area weights when sort=my_areas, non-matching elections last", async () => {
    const areaTop = "aaaaaaaa-0000-4000-8000-000000000001";
    const areaMid = "aaaaaaaa-0000-4000-8000-000000000002";
    const areaLow = "aaaaaaaa-0000-4000-8000-000000000003";
    const query = makeOrderingQuery({
      areaPreferences: [
        { research_area_id: areaTop, rank: 1 }, // weight 1
        { research_area_id: areaMid, rank: 2 }, // weight 0.75
        { research_area_id: areaLow, rank: 3 }, // weight 0.5625
      ],
    });
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, research_area_ids: [areaTop], vote_power_score: 99 }, // score 1
        { id: electionB, research_area_ids: [areaMid, areaLow], vote_power_score: 1 }, // score 1.3125
        { id: electionC, research_area_ids: [], vote_power_score: 100 }, // no match
      ]),
      { userId, sort: "my_areas" }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA, electionC]);
  });

  it("weighs a legacy unranked save one rank below the last ranked area", async () => {
    // With geometric weights, equal sums only arise from the same matched
    // set, so the best-rank tiebreak no longer separates distinct matches;
    // what matters is that an unranked save still counts, below every
    // explicit rank.
    const areaRankOne = "aaaaaaaa-0000-4000-8000-000000000004";
    const areaRankTwo = "aaaaaaaa-0000-4000-8000-000000000005";
    const areaUnranked = "aaaaaaaa-0000-4000-8000-000000000006";
    const query = makeOrderingQuery({
      areaPreferences: [
        { research_area_id: areaRankOne, rank: 1 }, // weight 1
        { research_area_id: areaRankTwo, rank: 2 }, // weight 0.75
        { research_area_id: areaUnranked, rank: null }, // weight as rank 3 = 0.5625
      ],
    });
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, research_area_ids: [areaUnranked], vote_power_score: 99 },
        { id: electionB, research_area_ids: [areaRankTwo], vote_power_score: 1 },
        { id: electionC, research_area_ids: [], vote_power_score: 100 },
      ]),
      { userId, sort: "my_areas" }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA, electionC]);
  });

  it("degrades my_areas to vote_power for anonymous calls without querying weights", async () => {
    const query = makeOrderingQuery({});
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, vote_power_score: 10 },
        { id: electionB, vote_power_score: 90 },
      ]),
      { sort: "my_areas" }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
    expect(query).not.toHaveBeenCalled();
  });

  it("degrades my_areas to vote_power when the user saved no research areas", async () => {
    const query = makeOrderingQuery({ areaPreferences: [] });
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, vote_power_score: 10 },
        { id: electionB, vote_power_score: 90 },
      ]),
      { userId, sort: "my_areas" }
    );

    expect(result.elections.map((e) => e.id)).toEqual([electionB, electionA]);
  });

  it("keeps followed elections grouped first under my_areas", async () => {
    const areaTop = "aaaaaaaa-0000-4000-8000-000000000007";
    const query = makeOrderingQuery({
      follows: [{ election_id: electionC, candidate_id: candidateId, display_name: "Jane Doe" }],
      areaPreferences: [{ research_area_id: areaTop, rank: 1 }],
    });
    const result = await applyBallotElectionOrdering(
      { query },
      makeSummary([
        { id: electionA, research_area_ids: [areaTop] },
        { id: electionC, research_area_ids: [] },
      ]),
      { userId, sort: "my_areas" }
    );

    // electionC matches nothing but contains a followed candidate.
    expect(result.elections.map((e) => e.id)).toEqual([electionC, electionA]);
  });

  it("skips the follow query entirely for anonymous calls", async () => {
    const query = makeFollowsQuery([{ election_id: electionA, candidate_id: candidateId, display_name: "Jane Doe" }]);
    const result = await applyBallotElectionOrdering({ query }, makeSummary([{ id: electionA }]));

    expect(query).not.toHaveBeenCalled();
    expect(result.elections[0]?.followed_candidates).toEqual([]);
  });

  it("filters followed candidates to live, unmerged, still-competing ballot links in SQL", async () => {
    const query = makeFollowsQuery([]);
    await applyBallotElectionOrdering({ query }, makeSummary([{ id: electionA }]), { userId });

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("ce.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("c.merged_into_candidate_id IS NULL");
    expect(sql).toContain("concat_ws(' ', c.first_name, c.last_name)");
  });
});
