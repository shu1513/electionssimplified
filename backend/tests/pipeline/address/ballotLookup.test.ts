import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BALLOT_PAST_ELECTION_VISIBILITY_DAYS,
  deriveCandidateRosterStatus,
  lookupBallotSummariesByDistrictIds,
  lookupCandidateElectionFinanceSummaryById,
  lookupElectionDetailById,
} from "../../../src/pipeline/address/ballotLookup.js";

const districtId = "11111111-1111-4111-8111-111111111111";
const officeElectionId = "22222222-2222-4222-8222-222222222222";
const measureElectionId = "33333333-3333-4333-8333-333333333333";
const officeId = "12121212-1212-4212-8212-121212121212";
const candidateId = "44444444-4444-4444-8444-444444444444";
const candidateElectionId = "55555555-5555-4555-8555-555555555555";
const candidateRecordId = "66666666-6666-4666-8666-666666666666";
const ballotMeasureId = "77777777-7777-4777-8777-777777777777";
const researchAreaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const measureResearchAreaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("lookupBallotSummariesByDistrictIds", () => {
  it("returns an empty summary result without querying for empty district IDs", async () => {
    const db = { query: vi.fn() };

    await expect(lookupBallotSummariesByDistrictIds(db, [" "])).resolves.toEqual({
      district_ids: [],
      districts: [],
      elections: [],
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("pins the election list to one date when electionDate is set, bypassing the recent-past window", async () => {
    const districtId = "11111111-1111-4111-8111-111111111111";
    const query = vi.fn(async () => ({ rows: [] }));
    await lookupBallotSummariesByDistrictIds({ query }, [districtId], { electionDate: "2026-11-03" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("AND e.election_date = $2::date");
    expect(query.mock.calls[1]?.[0]).not.toContain("Pacific/Honolulu");
    expect(query.mock.calls[1]?.[1]).toEqual([[districtId], "2026-11-03"]);
  });

  it("loads lightweight election summaries with office context, area links, counts, and result status", async () => {
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-06-02",
            election_stage: "primary",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: officeId,
            office_scope: "county",
            office_canonical_name: "Sheriff",
            office_summary: "County law-enforcement executive.",
          },
          {
            election_id: measureElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
            race_type: "ballot_measure",
            official_ballot_title: "Measure H",
            election_date: "2026-06-02",
            election_stage: null,
            is_partisan: null,
            discovery_contest_family: "ballot_measure",
            sources: ["https://example.test/measure"],
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
            office_summary: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ election_id: officeElectionId, candidate_count: 3 }],
      })
      .mockResolvedValueOnce({
        rows: [{ election_id: measureElectionId, ballot_measure_id: ballotMeasureId }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            office_id: officeId,
            research_area_id: researchAreaId,
            slug: "public_safety_and_crime_control",
            name: "Public Safety and Crime Control",
            description: "Crime, policing, and public safety.",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            research_area_id: measureResearchAreaId,
            slug: "housing_affordability",
            name: "Housing Affordability",
            description: "Housing supply and cost.",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            outcome: "won",
            winners: [{ candidate_id: "22222222-2222-4222-8222-222222222222", candidate_name: "Jane Winner", party: "Nonpartisan" }],
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [],
      });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [districtId, districtId]);

    expect(result).toEqual({
      district_ids: [districtId],
      districts: [
        {
          id: districtId,
          district_type: "county",
          geoid_compact: "06037",
          name: "Los Angeles County",
          state: "CA",
          state_fips: "06",
          representation_power_score: 72.5,
          population: null,
        },
      ],
      // Order-independent: the reader now sorts by the default vote_power
      // ordering; this test covers the summary shape, not the ordering.
      elections: expect.arrayContaining([
        {
          id: officeElectionId,
          district_id: districtId,
          district: {
            id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: 72.5,
            population: null,
          },
          race_type: "office",
          official_ballot_title: "Sheriff",
          // Countywide office with no seat designator, so nothing to flag.
          sub_district_seat: null,
          election_date: "2026-06-02",
          election_stage: "primary",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.test/elections"],
          candidate_count: 3,
          candidate_roster_status: null,
          ballot_measure_id: null,
          has_results: true,
          current_result_outcome: "won",
          current_result_winners: [
            { candidate_id: "22222222-2222-4222-8222-222222222222", candidate_name: "Jane Winner", party: "Nonpartisan" },
          ],
          office: {
            id: officeId,
            scope: "county",
            canonical_name: "Sheriff",
            summary: "County law-enforcement executive.",
          },
          research_areas: [
            {
              id: researchAreaId,
              slug: "public_safety_and_crime_control",
              name: "Public Safety and Crime Control",
              description: "Crime, policing, and public safety.",
            },
          ],
          historical_competitiveness: null,
          current_competitiveness: null,
          vote_power: {
            score: 73,
            label: "high",
            confidence: "medium",
            representation_level: "high",
            decisiveness_level: "unknown",
            factors: ["high_representation", "missing_decisiveness_data"],
          },
        },
        {
          id: measureElectionId,
          district_id: districtId,
          district: {
            id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: 72.5,
            population: null,
          },
          race_type: "ballot_measure",
          official_ballot_title: "Measure H",
          // Measures have no office, so the seat gate never applies.
          sub_district_seat: null,
          election_date: "2026-06-02",
          election_stage: null,
          is_partisan: null,
          discovery_contest_family: "ballot_measure",
          sources: ["https://example.test/measure"],
          candidate_count: 0,
          candidate_roster_status: null,
          ballot_measure_id: ballotMeasureId,
          has_results: false,
          current_result_outcome: null,
          current_result_winners: [],
          office: null,
          research_areas: [
            {
              id: measureResearchAreaId,
              slug: "housing_affordability",
              name: "Housing Affordability",
              description: "Housing supply and cost.",
            },
          ],
          historical_competitiveness: null,
          current_competitiveness: null,
          vote_power: {
            // The direct-vote label bump (high → very high) is capped back
            // to high because the measure has no close-race evidence; the
            // score carries no bonus.
            score: 73,
            label: "high",
            confidence: "high",
            representation_level: "high",
            decisiveness_level: "unknown",
            factors: ["high_representation", "direct_vote_on_policy"],
          },
        },
      ]),
    });
    expect(result.elections).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(9);
    expect(query.mock.calls[0]?.[1]).toEqual([[districtId]]);
    // Ballot summaries hide finished elections after the results-visibility
    // window; the boundary must be the last US local date (Honolulu), not
    // the server's UTC date, so a west-coast election never expires early.
    expect(query.mock.calls[1]?.[0]).toContain(
      `AND e.election_date >= (now() AT TIME ZONE 'Pacific/Honolulu')::date - ${BALLOT_PAST_ELECTION_VISIBILITY_DAYS}`
    );
    expect(query.mock.calls[6]?.[0]).toContain("CASE pass_type");
    expect(query.mock.calls[6]?.[0]).toContain("WHEN 'certified' THEN 1");
    expect(query.mock.calls[6]?.[0]).toContain("WHEN 'election_night' THEN 2");
    // unknown-outcome rows (not_found / not_final_yet sweeps) must not win the
    // summary pick over a decisive election-night row, nor flag has_results on
    // their own — both result tables filter them out before ranking.
    expect(query.mock.calls[6]?.[0]).toContain("AND er.outcome <> 'unknown'");
    expect(query.mock.calls[6]?.[0]).toContain("AND bmr.outcome <> 'unknown'");
    expect(query.mock.calls[7]?.[0]).toContain("historical_contest_margins");
    // The lightweight summary must not embed the full candidate array (the
    // detail endpoint's "candidates" key).
    expect(JSON.stringify(result)).not.toContain('"candidates"');
    expect(JSON.stringify(result)).not.toContain("candidate_record");
    expect(JSON.stringify(result)).not.toContain("what_yes_means");
  });

  it("attaches the ballot-preview payload (roster incl. withdrawn, measure text, seats) when includePreview is set", async () => {
    const withdrawnCandidateId = "88888888-8888-4888-8888-888888888888";
    const withdrawnCandidateElectionId = "99999999-9999-4999-8999-999999999999";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
            race_type: "office",
            official_ballot_title: "County Supervisor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            seats_to_fill: 2,
            discovery_contest_family: "non_judicial_office",
            sources: [],
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
            office_summary: null,
          },
          {
            election_id: measureElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
            race_type: "ballot_measure",
            official_ballot_title: "Measure H",
            election_date: "2026-11-03",
            election_stage: null,
            is_partisan: null,
            seats_to_fill: null,
            discovery_contest_family: "ballot_measure",
            sources: [],
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
            office_summary: null,
          },
        ],
      })
      // candidate counts (withdrawn excluded, matching the visible count)
      .mockResolvedValueOnce({ rows: [{ election_id: officeElectionId, candidate_count: 1 }] })
      // ballot measure ids
      .mockResolvedValueOnce({ rows: [{ election_id: measureElectionId, ballot_measure_id: ballotMeasureId }] })
      // measure research areas (office research areas + historical
      // competitiveness + roster status all skip their queries here: no
      // office ids, no supported office scopes, no zero-candidate office)
      .mockResolvedValueOnce({ rows: [] })
      // result summaries
      .mockResolvedValueOnce({ rows: [] })
      // preview candidates: withdrawn row comes back too
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Alice Alvarez",
            party: "Nonpartisan",
            is_incumbent: true,
            status: "declared",
            running_mate_candidate_id: null,
            running_mate_display_name: null,
            running_mate_party: null,
          },
          {
            election_id: officeElectionId,
            candidate_election_id: withdrawnCandidateElectionId,
            candidate_id: withdrawnCandidateId,
            display_name: "Bob Breyer",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "withdrawn",
            running_mate_candidate_id: null,
            running_mate_display_name: null,
            running_mate_party: null,
          },
        ],
      })
      // preview measures: full text fields
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            ballot_measure_id: ballotMeasureId,
            official_ballot_title: "Measure H",
            summary: "A VoteApp summary.",
            what_yes_means: "Yes adopts the tax.",
            what_no_means: "No keeps current law.",
          },
        ],
      });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [districtId], { includePreview: true });

    expect(query).toHaveBeenCalledTimes(9);
    // The preview candidate query must NOT exclude withdrawn candidacies —
    // a late withdrawal can still be printed on the paper ballot.
    expect(query.mock.calls[6]?.[0]).not.toContain("withdrawn");
    const officeSummary = result.elections.find((election) => election.id === officeElectionId);
    expect(officeSummary?.preview).toEqual({
      seats_to_fill: 2,
      candidates: [
        {
          candidate_election_id: candidateElectionId,
          candidate_id: candidateId,
          display_name: "Alice Alvarez",
          party: "Nonpartisan",
          is_incumbent: true,
          status: "declared",
        },
        {
          candidate_election_id: withdrawnCandidateElectionId,
          candidate_id: withdrawnCandidateId,
          display_name: "Bob Breyer",
          party: "Nonpartisan",
          is_incumbent: false,
          status: "withdrawn",
        },
      ],
      measure: null,
    });
    // The visible count keeps excluding withdrawn rows even though the
    // preview roster carries them.
    expect(officeSummary?.candidate_count).toBe(1);
    const measureSummary = result.elections.find((election) => election.id === measureElectionId);
    expect(measureSummary?.preview).toEqual({
      seats_to_fill: null,
      candidates: [],
      measure: {
        id: ballotMeasureId,
        official_ballot_title: "Measure H",
        summary: "A VoteApp summary.",
        what_yes_means: "Yes adopts the tax.",
        what_no_means: "No keeps current law.",
      },
    });
  });

  it("attaches historical competitiveness to supported office summaries", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("runtime ballot lookup must not fetch historical data"));
    vi.stubGlobal("fetch", fetch);
    const houseDistrictId = "99999999-9999-4999-8999-999999999991";
    const houseElectionId = "99999999-9999-4999-8999-999999999992";
    const houseOfficeId = "99999999-9999-4999-8999-999999999993";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: houseDistrictId,
            district_type: "us_house",
            geoid_compact: "0631",
            name: "California's 31st Congressional District",
            state: "CA",
            state_fips: "06",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: houseElectionId,
            district_id: houseDistrictId,
            district_type: "us_house",
            geoid_compact: "0631",
            district_name: "California's 31st Congressional District",
            state: "CA",
            state_fips: "06",
            race_type: "office",
            official_ballot_title: "United States Representative District 31",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: houseOfficeId,
            office_scope: "us_house",
            office_canonical_name: "United States Representative",
            office_summary: "Federal lower-chamber legislator.",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ election_id: houseElectionId, candidate_count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            lookup_id: houseElectionId,
            source: "MIT_2024",
            source_url: "https://github.com/MEDSL/2024-elections-official",
            election_year: 2024,
            state: "CA",
            state_fips: "06",
            office_type: "US_HOUSE",
            district_type: "us_house",
            district_key: "0631",
            mit_office: "US HOUSE",
            mit_district: "031",
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            winner_votes: "109200",
            runner_up_votes: "90800",
            total_votes: "200000",
            margin_percent: "9.20",
            competitiveness_label: "competitive",
            stale_after_redistricting: false,
            imported_at: "2026-06-14 12:00:00+00",
          },
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            lookup_id: houseElectionId,
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            state: "CA",
            state_fips: "06",
            office_type: "US_HOUSE",
            district_type: "us_house",
            district_key: "0631",
            mit_office: "US HOUSE",
            mit_district: "031",
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            winner_votes: "115200",
            runner_up_votes: "84800",
            total_votes: "200000",
            margin_percent: "15.20",
            competitiveness_label: "somewhat_competitive",
            stale_after_redistricting: false,
            imported_at: "2026-06-14 11:00:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [houseDistrictId]);

    expect(result.elections).toHaveLength(1);
    expect(result.elections[0]).toMatchObject({
      id: houseElectionId,
      office: {
        canonical_name: "United States Representative",
      },
      historical_competitiveness: {
        display_label: "Historically somewhat competitive",
        display_description: "Based on weighted margins from 2024 and 2022 U.S. House results.",
        source: "MIT_2024",
        source_url: "https://github.com/MEDSL/2024-elections-official",
        election_year: 2024,
        winner_party: "DEMOCRAT",
        runner_up_party: "REPUBLICAN",
        margin_percent: 11.45,
        competitiveness_label: "somewhat_competitive",
        stale_after_redistricting: false,
        method: "weighted_last_3",
        weights: [0.625, 0.375],
        election_years: [2024, 2022],
        contests_used: [
          {
            source: "MIT_2024",
            source_url: "https://github.com/MEDSL/2024-elections-official",
            election_year: 2024,
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            margin_percent: 9.2,
            competitiveness_label: "competitive",
            stale_after_redistricting: false,
            weight: 0.625,
          },
          {
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            margin_percent: 15.2,
            competitiveness_label: "somewhat_competitive",
            stale_after_redistricting: false,
            weight: 0.375,
          },
        ],
      },
      vote_power: {
        score: 45,
        label: "medium",
        confidence: "medium",
        representation_level: "unknown",
        decisiveness_level: "medium",
        factors: ["missing_representation_data", "medium_decisiveness"],
      },
    });
    expect(query).toHaveBeenCalledTimes(8);
    expect(fetch).not.toHaveBeenCalled();
    expect(query.mock.calls[6]?.[0]).toContain("public.historical_contest_margins");
    expect(JSON.parse(query.mock.calls[6]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: houseElectionId,
        min_election_year: 2022,
        max_election_year: 2025,
        state: "CA",
        state_fips: "06",
        office_type: "US_HOUSE",
        district_type: "us_house",
        district_key: "0631",
        mit_office: "US HOUSE",
        mit_district: "031",
      },
    ]);
  });

  it("attaches historical competitiveness to supported county office summaries", async () => {
    const countyDistrictId = "77777777-7777-4777-8777-777777777771";
    const sheriffElectionId = "77777777-7777-4777-8777-777777777772";
    const sheriffOfficeId = "77777777-7777-4777-8777-777777777773";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: countyDistrictId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: sheriffElectionId,
            district_id: countyDistrictId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: sheriffOfficeId,
            office_scope: "county",
            office_canonical_name: "Sheriff",
            office_summary: "County law-enforcement executive.",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ election_id: sheriffElectionId, candidate_count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "77777777-7777-4777-8777-777777777774",
            lookup_id: sheriffElectionId,
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            state: "CA",
            state_fips: "06",
            office_type: "COUNTY_SHERIFF",
            district_type: "county",
            district_key: "06037",
            mit_office: "COUNTY SHERIFF",
            mit_district: "06037",
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            winner_votes: "56000",
            runner_up_votes: "44000",
            total_votes: "100000",
            margin_percent: "12.00",
            competitiveness_label: "somewhat_competitive",
            stale_after_redistricting: false,
            imported_at: "2026-06-14 12:00:00+00",
          },
          {
            id: "77777777-7777-4777-8777-777777777775",
            lookup_id: sheriffElectionId,
            source: "MIT_2018",
            source_url: "https://doi.org/10.7910/DVN/UBKYRU",
            election_year: 2018,
            state: "CA",
            state_fips: "06",
            office_type: "COUNTY_SHERIFF",
            district_type: "county",
            district_key: "06037",
            mit_office: "COUNTY SHERIFF",
            mit_district: "06037",
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            winner_votes: "52000",
            runner_up_votes: "48000",
            total_votes: "100000",
            margin_percent: "4.00",
            competitiveness_label: "very_competitive",
            stale_after_redistricting: false,
            imported_at: "2026-06-14 11:00:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [countyDistrictId]);

    expect(result.elections).toHaveLength(1);
    expect(result.elections[0]).toMatchObject({
      id: sheriffElectionId,
      district: {
        district_type: "county",
        geoid_compact: "06037",
      },
      office: {
        canonical_name: "Sheriff",
      },
      historical_competitiveness: {
        display_label: "Historically competitive",
        display_description: "Based on weighted margins from 2022 and 2018 Sheriff results.",
        source: "MIT_2022",
        source_url: "https://doi.org/10.7910/DVN/UYQIEP",
        election_year: 2022,
        winner_party: "DEMOCRAT",
        runner_up_party: "REPUBLICAN",
        margin_percent: 9,
        competitiveness_label: "competitive",
        stale_after_redistricting: false,
        method: "weighted_last_3",
        weights: [0.625, 0.375],
        election_years: [2022, 2018],
        contests_used: [
          {
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            margin_percent: 12,
            competitiveness_label: "somewhat_competitive",
            stale_after_redistricting: false,
            weight: 0.625,
          },
          {
            source: "MIT_2018",
            source_url: "https://doi.org/10.7910/DVN/UBKYRU",
            election_year: 2018,
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            margin_percent: 4,
            competitiveness_label: "very_competitive",
            stale_after_redistricting: false,
            weight: 0.375,
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(8);
    expect(JSON.parse(query.mock.calls[6]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: sheriffElectionId,
        min_election_year: null,
        max_election_year: 2025,
        state: "CA",
        state_fips: "06",
        office_type: "COUNTY_SHERIFF",
        district_type: "county",
        district_key: "06037",
        mit_office: "COUNTY SHERIFF",
        mit_district: "06037",
      },
    ]);
  });

  it("attaches county office historical competitiveness using each county district key", async () => {
    const counties = [
      {
        districtId: "77777777-7777-4777-8777-7777777777a1",
        electionId: "77777777-7777-4777-8777-7777777777a2",
        officeId: "77777777-7777-4777-8777-7777777777a3",
        geoidCompact: "06037",
        name: "Los Angeles County",
        state: "CA",
        stateFips: "06",
        margin: "12.00",
        label: "somewhat_competitive",
      },
      {
        districtId: "77777777-7777-4777-8777-7777777777b1",
        electionId: "77777777-7777-4777-8777-7777777777b2",
        officeId: "77777777-7777-4777-8777-7777777777b3",
        geoidCompact: "53033",
        name: "King County",
        state: "WA",
        stateFips: "53",
        margin: "4.00",
        label: "very_competitive",
      },
      {
        districtId: "77777777-7777-4777-8777-7777777777c1",
        electionId: "77777777-7777-4777-8777-7777777777c2",
        officeId: "77777777-7777-4777-8777-7777777777c3",
        geoidCompact: "27053",
        name: "Hennepin County",
        state: "MN",
        stateFips: "27",
        margin: "22.00",
        label: "safe",
      },
    ] as const;
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: counties.map((county) => ({
          id: county.districtId,
          district_type: "county",
          geoid_compact: county.geoidCompact,
          name: county.name,
          state: county.state,
          state_fips: county.stateFips,
        })),
      })
      .mockResolvedValueOnce({
        rows: counties.map((county) => ({
          election_id: county.electionId,
          district_id: county.districtId,
          district_type: "county",
          geoid_compact: county.geoidCompact,
          district_name: county.name,
          state: county.state,
          state_fips: county.stateFips,
          race_type: "office",
          official_ballot_title: "Sheriff",
          election_date: "2026-11-03",
          election_stage: "general",
          is_partisan: false,
          discovery_contest_family: "non_judicial_office",
          sources: ["https://example.test/elections"],
          office_id: county.officeId,
          office_scope: "county",
          office_canonical_name: "Sheriff",
          office_summary: "County law-enforcement executive.",
        })),
      })
      .mockResolvedValueOnce({
        rows: counties.map((county) => ({ election_id: county.electionId, candidate_count: 2 })),
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: counties.map((county, index) => ({
          id: `77777777-7777-4777-8777-7777777778${index}1`,
          lookup_id: county.electionId,
          source: "MIT_2022",
          source_url: "https://doi.org/10.7910/DVN/UYQIEP",
          election_year: 2022,
          state: county.state,
          state_fips: county.stateFips,
          office_type: "COUNTY_SHERIFF",
          district_type: "county",
          district_key: county.geoidCompact,
          mit_office: "COUNTY SHERIFF",
          mit_district: county.geoidCompact,
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "56000",
          runner_up_votes: "44000",
          total_votes: "100000",
          margin_percent: county.margin,
          competitiveness_label: county.label,
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        })),
      });

    const result = await lookupBallotSummariesByDistrictIds(
      { query },
      counties.map((county) => county.districtId)
    );

    expect(result.elections).toHaveLength(3);
    for (const county of counties) {
      expect(result.elections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: county.electionId,
            district: expect.objectContaining({
              district_type: "county",
              geoid_compact: county.geoidCompact,
            }),
            office: expect.objectContaining({
              canonical_name: "Sheriff",
            }),
            historical_competitiveness: expect.objectContaining({
              source: "MIT_2022",
              election_year: 2022,
              margin_percent: Number(county.margin),
              competitiveness_label: county.label,
              election_years: [2022],
            }),
          }),
        ])
      );
    }
    expect(JSON.parse(query.mock.calls[6]?.[1]?.[0] as string)).toEqual(
      counties.map((county) => ({
        lookup_id: county.electionId,
        min_election_year: null,
        max_election_year: 2025,
        state: county.state,
        state_fips: county.stateFips,
        office_type: "COUNTY_SHERIFF",
        district_type: "county",
        district_key: county.geoidCompact,
        mit_office: "COUNTY SHERIFF",
        mit_district: county.geoidCompact,
      }))
    );
  });

  it("does not look up historical competitiveness for unsupported county office summaries", async () => {
    const countyDistrictId = "77777777-7777-4777-8777-777777777781";
    const commissionerElectionId = "77777777-7777-4777-8777-777777777782";
    const commissionerOfficeId = "77777777-7777-4777-8777-777777777783";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: countyDistrictId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: commissionerElectionId,
            district_id: countyDistrictId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            race_type: "office",
            official_ballot_title: "County Commissioner",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: commissionerOfficeId,
            office_scope: "county",
            office_canonical_name: "County Commissioner",
            office_summary: "County board member.",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ election_id: commissionerElectionId, candidate_count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [countyDistrictId]);

    expect(result.elections).toHaveLength(1);
    expect(result.elections[0]).toMatchObject({
      id: commissionerElectionId,
      office: {
        canonical_name: "County Commissioner",
      },
      historical_competitiveness: null,
    });
    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls.map((call) => call[0]).join("\n")).not.toContain("historical_contest_margins");
  });

  it("attaches historical competitiveness to supported statewide executive office summaries", async () => {
    const statewideDistrictId = "88888888-8888-4888-8888-888888888881";
    const attorneyGeneralElectionId = "88888888-8888-4888-8888-888888888882";
    const attorneyGeneralOfficeId = "88888888-8888-4888-8888-888888888883";
    const fetch = vi.fn().mockRejectedValue(new Error("runtime ballot lookup must not fetch historical data"));
    vi.stubGlobal("fetch", fetch);
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: statewideDistrictId,
            district_type: "statewide",
            geoid_compact: "06",
            name: "California",
            state: "CA",
            state_fips: "06",
            representation_power_score: "90",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: attorneyGeneralElectionId,
            district_id: statewideDistrictId,
            district_type: "statewide",
            geoid_compact: "06",
            district_name: "California",
            state: "CA",
            state_fips: "06",
            representation_power_score: "90",
            race_type: "office",
            official_ballot_title: "Attorney General",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: attorneyGeneralOfficeId,
            office_scope: "statewide",
            office_canonical_name: "Attorney General",
            office_summary: "State chief legal officer.",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ election_id: attorneyGeneralElectionId, candidate_count: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "88888888-8888-4888-8888-888888888884",
            lookup_id: attorneyGeneralElectionId,
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            state: "CA",
            state_fips: "06",
            office_type: "ATTORNEY_GENERAL",
            district_type: "statewide",
            district_key: "06",
            mit_office: "ATTORNEY GENERAL",
            mit_district: "STATEWIDE",
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            winner_votes: "1035000",
            runner_up_votes: "1000000",
            total_votes: "2035000",
            margin_percent: "1.72",
            competitiveness_label: "toss_up",
            stale_after_redistricting: false,
            imported_at: "2026-06-14 12:00:00+00",
          },
        ],
      });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [statewideDistrictId]);

    expect(result.elections).toHaveLength(1);
    expect(result.elections[0]).toMatchObject({
      id: attorneyGeneralElectionId,
      district: {
        district_type: "statewide",
        geoid_compact: "06",
      },
      office: {
        canonical_name: "Attorney General",
      },
      historical_competitiveness: {
        display_label: "Historically a toss-up",
        display_description: "Based on the 2022 Attorney General result.",
        source: "MIT_2022",
        source_url: "https://doi.org/10.7910/DVN/UYQIEP",
        election_year: 2022,
        winner_party: "DEMOCRAT",
        runner_up_party: "REPUBLICAN",
        margin_percent: 1.72,
        competitiveness_label: "toss_up",
        stale_after_redistricting: false,
        method: "weighted_last_3",
        weights: [1],
        election_years: [2022],
        contests_used: [
          {
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            margin_percent: 1.72,
            competitiveness_label: "toss_up",
            stale_after_redistricting: false,
            weight: 1,
          },
        ],
      },
      vote_power: {
        score: 25,
        label: "low",
        confidence: "high",
        representation_level: "high",
        decisiveness_level: "none",
        factors: ["high_representation", "uncontested_race"],
      },
    });
    expect(query).toHaveBeenCalledTimes(8);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(query.mock.calls[6]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: attorneyGeneralElectionId,
        min_election_year: null,
        max_election_year: 2025,
        state: "CA",
        state_fips: "06",
        office_type: "ATTORNEY_GENERAL",
        district_type: "statewide",
        district_key: "06",
        mit_office: "ATTORNEY GENERAL",
        mit_district: "STATEWIDE",
      },
    ]);
  });

});

describe("deriveCandidateRosterStatus", () => {
  const today = "2026-07-16";
  const upcoming = "2026-11-03";
  const past = "2026-06-02";

  it("marks staged rosters with names as processing regardless of deferrals", () => {
    for (const staging_status of ["written", "validated"]) {
      expect(
        deriveCandidateRosterStatus(
          { election_date: upcoming, staging_status, staged_candidate_count: 2, has_candidate_links: false, blocked_until: "2026-08-27" },
          today
        )
      ).toEqual({ reason: "roster_processing", check_after: null });
    }
  });

  it("never reads a withdrawn-emptied race as processing", () => {
    // Every candidate withdrew (or was deleted): links exist but none are
    // visible. The staged roster was already processed, so "profiles are
    // being prepared" would be false forever.
    expect(
      deriveCandidateRosterStatus(
        {
          election_date: upcoming,
          staging_status: "written",
          staged_candidate_count: 2,
          has_candidate_links: true,
          blocked_until: null,
        },
        today
      )
    ).toEqual({ reason: "candidate_information_unavailable", check_after: null });
    // A deferral still applies there: replacing a withdrawn nominee is
    // genuinely awaiting a new official roster.
    expect(
      deriveCandidateRosterStatus(
        {
          election_date: upcoming,
          staging_status: "written",
          staged_candidate_count: 2,
          has_candidate_links: true,
          blocked_until: "2026-08-27",
        },
        today
      )
    ).toEqual({ reason: "awaiting_official_roster", check_after: "2026-08-27" });
  });

  it("maps an open deferral on an upcoming election to awaiting with a future check_after", () => {
    expect(
      deriveCandidateRosterStatus(
        { election_date: upcoming, staging_status: "pending", staged_candidate_count: 0, has_candidate_links: false, blocked_until: "2026-08-27" },
        today
      )
    ).toEqual({ reason: "awaiting_official_roster", check_after: "2026-08-27" });
  });

  it("never exposes a past or same-day check_after date", () => {
    for (const blocked_until of ["2026-07-01", today]) {
      expect(
        deriveCandidateRosterStatus(
          { election_date: upcoming, staging_status: null, staged_candidate_count: null, has_candidate_links: false, blocked_until },
          today
        )
      ).toEqual({ reason: "awaiting_official_roster", check_after: null });
    }
  });

  it("suppresses awaiting and processing copy for past elections", () => {
    // Open deferral on a finished race: no "we'll check again" promise.
    expect(
      deriveCandidateRosterStatus(
        { election_date: past, staging_status: "pending", staged_candidate_count: 0, has_candidate_links: false, blocked_until: "2026-08-27" },
        today
      )
    ).toEqual({ reason: "candidate_information_unavailable", check_after: null });
    // Staged-but-never-linked roster on a finished race: no "coming soon"
    // promise either — fanout debt must not read as active processing forever.
    for (const staging_status of ["written", "validated"]) {
      expect(
        deriveCandidateRosterStatus(
          { election_date: past, staging_status, staged_candidate_count: 2, has_candidate_links: false, blocked_until: null },
          today
        )
      ).toEqual({ reason: "candidate_information_unavailable", check_after: null });
    }
  });

  it("falls back to unavailable for pending/failed/no_results/empty-payload staging without a deferral", () => {
    for (const row of [
      { staging_status: "pending", staged_candidate_count: 0, has_candidate_links: false },
      { staging_status: "failed", staged_candidate_count: 0, has_candidate_links: false },
      { staging_status: "no_results", staged_candidate_count: 0, has_candidate_links: false },
      // A written row with an empty payload is a no-roster marker, not names.
      { staging_status: "written", staged_candidate_count: 0, has_candidate_links: false },
      { staging_status: null, staged_candidate_count: null, has_candidate_links: false },
    ]) {
      expect(
        deriveCandidateRosterStatus({ election_date: upcoming, ...row, blocked_until: null }, today)
      ).toEqual({ reason: "candidate_information_unavailable", check_after: null });
    }
  });
});

describe("candidate_roster_status wiring", () => {
  it("attaches roster status to zero-candidate office summaries and leaves measures null", async () => {
    const futureElectionDate = "2099-11-03";
    const futureBlockedUntil = "2099-08-27";
    const electionRowBase = {
      district_id: districtId,
      district_type: "county",
      geoid_compact: "06037",
      district_name: "Los Angeles County",
      state: "CA",
      state_fips: "06",
      representation_power_score: "72.5",
      election_date: futureElectionDate,
      sources: ["https://example.test/elections"],
    };
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "72.5",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            ...electionRowBase,
            election_id: officeElectionId,
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
            office_summary: null,
          },
          {
            ...electionRowBase,
            election_id: measureElectionId,
            race_type: "ballot_measure",
            official_ballot_title: "Measure H",
            election_stage: null,
            is_partisan: null,
            discovery_contest_family: "ballot_measure",
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
            office_summary: null,
          },
        ],
      })
      // candidate counts: none for either election
      .mockResolvedValueOnce({ rows: [] })
      // ballot measures
      .mockResolvedValueOnce({
        rows: [{ election_id: measureElectionId, ballot_measure_id: ballotMeasureId }],
      })
      // measure research areas (office research areas skipped: no office ids)
      .mockResolvedValueOnce({ rows: [] })
      // result outcomes
      .mockResolvedValueOnce({ rows: [] })
      // roster status (only the zero-candidate OFFICE election)
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            election_date: futureElectionDate,
            staging_status: "pending",
            staged_candidate_count: 0,
            has_candidate_links: false,
            blocked_until: futureBlockedUntil,
          },
        ],
      });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [districtId]);

    const officeSummary = result.elections.find((election) => election.id === officeElectionId);
    const measureSummary = result.elections.find((election) => election.id === measureElectionId);
    expect(officeSummary?.candidate_roster_status).toEqual({
      reason: "awaiting_official_roster",
      check_after: futureBlockedUntil,
    });
    expect(measureSummary?.candidate_roster_status).toBeNull();

    expect(query).toHaveBeenCalledTimes(8);
    const rosterStatusCall = query.mock.calls[6];
    expect(rosterStatusCall?.[0]).toContain("candidate_roster:");
    expect(rosterStatusCall?.[0]).toContain("manual_research_deferrals");
    // Only the zero-candidate office election is queried — never the measure.
    expect(rosterStatusCall?.[1]).toEqual([[officeElectionId]]);
  });

  it("attaches roster status to a zero-candidate office detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_upper",
            geoid_compact: "36028",
            district_name: "State Senate District 28 (2024); New York",
            state: "NY",
            state_fips: "36",
            representation_power_score: "50",
            race_type: "office",
            official_ballot_title: "State Senator, District 28",
            election_date: "2099-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
          },
        ],
      })
      // candidates: none
      .mockResolvedValueOnce({ rows: [] })
      // ballot measures
      .mockResolvedValueOnce({ rows: [] })
      // office results
      .mockResolvedValueOnce({ rows: [] })
      // ballot measure outcomes
      .mockResolvedValueOnce({ rows: [] })
      // roster status
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            election_date: "2099-11-03",
            staging_status: "written",
            staged_candidate_count: 2,
            has_candidate_links: false,
            blocked_until: null,
          },
        ],
      })
      // historical competitiveness
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates).toEqual([]);
    expect(result?.candidate_roster_status).toEqual({ reason: "roster_processing", check_after: null });
    expect(query.mock.calls[5]?.[0]).toContain("candidate_roster:");
    expect(query.mock.calls[5]?.[1]).toEqual([[officeElectionId]]);
  });

  it("issues no roster-status query when every office election has candidates", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "64.25",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2099-06-02",
            election_stage: "primary",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: null,
            office_scope: null,
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: null,
            current_office: null,
            state: "CA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // candidate records
      .mockResolvedValueOnce({ rows: [] })
      // candidate record tags
      .mockResolvedValueOnce({ rows: [] })
      // historical competitiveness
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidate_roster_status).toBeNull();
    for (const call of query.mock.calls) {
      expect(call[0]).not.toContain("manual_research_deferrals");
    }
  });
});

describe("lookupElectionDetailById", () => {
  it("returns null without querying for empty election IDs", async () => {
    const query = vi.fn();

    await expect(lookupElectionDetailById({ query }, "   ")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns null without detail queries when the election does not exist", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await expect(lookupElectionDetailById({ query }, officeElectionId)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("loads full detail for one office election by election ID", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "50.42",
            population: "104650",
            scope_max_population: "9808667",
            scope_min_population: "1204",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-06-02",
            election_stage: "primary",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: "Sheriff",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Trial attorney.",
            current_office: null,
            state: "CA",
            fec_ids: ["H1CA00001"],
            state_filing_ids: ["SF-1"],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            id: "88888888-8888-4888-8888-888888888888",
            pass_type: "election_night",
            result_status: "unofficial",
            outcome: "won",
            winners: [{ candidate_election_id: candidateElectionId, candidate_name: "Pat Connolly" }],
            match_status: "matched",
            source_url: "https://results.example.test/office",
            source_type: "official",
            retrieved_at: "2026-06-03 04:10:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            candidate_record_id: candidateRecordId,
            description: "Handled public corruption cases.",
            source_url: "https://example.test/record",
            event_date: "2025-05-01",
            created_at: "2026-06-04 00:00:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_record_id: candidateRecordId,
            research_area_id: researchAreaId,
            slug: "anti_corruption",
            name: "Anti-Corruption",
            stance: "for",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10101010-1010-4010-8010-101010101010",
            lookup_id: officeElectionId,
            source: "MIT_2022",
            source_url: "https://doi.org/10.7910/DVN/UYQIEP",
            election_year: 2022,
            state: "CA",
            state_fips: "06",
            office_type: "COUNTY_SHERIFF",
            district_type: "county",
            district_key: "06037",
            mit_office: "COUNTY SHERIFF",
            mit_district: "06037",
            winner_party: "DEMOCRAT",
            runner_up_party: "REPUBLICAN",
            winner_votes: "56000",
            runner_up_votes: "44000",
            total_votes: "100000",
            margin_percent: "12.00",
            competitiveness_label: "somewhat_competitive",
            stale_after_redistricting: false,
            imported_at: "2026-06-14 12:00:00+00",
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result).toMatchObject({
      id: officeElectionId,
      district_id: districtId,
      district: {
        representation_power_score: 50.42,
      },
      race_type: "office",
      official_ballot_title: "Sheriff",
      candidates: [
        {
          candidate_election_id: candidateElectionId,
          candidate_id: candidateId,
          display_name: "Pat Connolly",
          finance_summary: null,
          records: [
            {
              id: candidateRecordId,
              description: "Handled public corruption cases.",
              research_area_tags: [{ slug: "anti_corruption", stance: "for" }],
            },
          ],
        },
      ],
      ballot_measure: null,
      results: [{ outcome: "won", match_status: "matched" }],
      historical_competitiveness: {
        display_label: "Historically somewhat competitive",
        display_description: "Based on the 2022 Sheriff result.",
        source: "MIT_2022",
        election_year: 2022,
        margin_percent: 12,
        competitiveness_label: "somewhat_competitive",
      },
      vote_power: {
        score: 23,
        label: "low",
        confidence: "high",
        representation_level: "medium",
        decisiveness_level: "none",
        factors: ["medium_representation", "uncontested_race"],
        explanation: {
          how: expect.stringContaining("What determines the vote power rating:"),
          parts: [
            {
              title: "Representation",
              grade: "Average",
              stat: "50 out of 100",
              detail:
                "This district covers a large share of its state, so each vote carries about average weight — like a vote in a statewide race. About 104,650 people live here.",
              // The stored 50.42 comes from the retired within-type model, so
              // the live recompute cannot reproduce it and the formula
              // degrades to the symbolic form.
              formula:
                "score = 50 + 50 × ln(state population ÷ this district's population) ÷ ln(50,000), kept between 50 and 100 and rounded to 2 decimals = 50.42 (grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline)",
            },
            {
              title: "Decisiveness",
              grade: "None",
              stat: "only 1 candidate",
              detail: "One candidate is running unopposed, so votes can't change the outcome.",
              formula: null,
            },
          ],
          result: "Average representation + an uncontested race → My vote power: Below average.",
          caveat: null,
        },
      },
    });
    expect(query).toHaveBeenCalledTimes(9);
    expect(query.mock.calls[0]?.[1]).toEqual([officeElectionId]);
    // A not_found/not_final_yet sweep row would render as "Unknown · Not
    // found" above the decisive row; the detail queries filter it out like
    // the summary ranking does.
    expect(query.mock.calls[3]?.[0]).toContain("AND er.outcome <> 'unknown'");
    expect(query.mock.calls[4]?.[0]).toContain("AND bmr.outcome <> 'unknown'");
    expect(query.mock.calls[7]?.[0]).toContain("public.historical_contest_margins");
  });

  it("scopes candidate record tags to the election office's allowed research areas", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const wealthGapAreaId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const integrityAreaId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "place",
            geoid_compact: "0644000",
            district_name: "Los Angeles city",
            state: "CA",
            state_fips: "06",
            representation_power_score: "64.25",
            race_type: "office",
            official_ballot_title: "Mayor",
            election_date: "2026-06-02",
            election_stage: "primary",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: officeId,
            office_scope: "place",
            office_canonical_name: "Mayor",
            office_summary: "Runs the city government.",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Trial attorney.",
            current_office: null,
            state: "CA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            candidate_record_id: candidateRecordId,
            description: "Handled public corruption cases.",
            source_url: "https://example.test/record",
            event_date: "2025-05-01",
            created_at: "2026-06-04 00:00:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_record_id: candidateRecordId,
            research_area_id: researchAreaId,
            slug: "anti_corruption",
            name: "Anti-Corruption",
            stance: "for",
          },
          {
            candidate_record_id: candidateRecordId,
            research_area_id: integrityAreaId,
            slug: "integrity_and_ethics",
            name: "Integrity & Ethics",
            stance: null,
          },
          {
            candidate_record_id: candidateRecordId,
            research_area_id: wealthGapAreaId,
            slug: "reduce_wealth_gap",
            name: "Reduce Wealth Gap",
            stance: "for",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { office_id: officeId, research_area_id: researchAreaId },
          { office_id: null, research_area_id: integrityAreaId },
        ],
      })
      // Office research-area summaries for the detail payload's
      // research_areas field (distinct from the allowed-set scoping query
      // above, which returns bare ids).
      .mockResolvedValueOnce({
        rows: [
          {
            office_id: officeId,
            research_area_id: researchAreaId,
            slug: "anti_corruption",
            name: "Anti-Corruption",
            description: "Corruption and abuse of office.",
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    // reduce_wealth_gap is not in the mayor office's allowed set, so its
    // candidate-wide legacy tag is dropped from this election's view; the
    // office-allowed and universal tags survive.
    expect(result?.candidates[0]?.records[0]?.research_area_tags).toEqual([
      {
        research_area_id: researchAreaId,
        slug: "anti_corruption",
        name: "Anti-Corruption",
        stance: "for",
      },
      {
        research_area_id: integrityAreaId,
        slug: "integrity_and_ethics",
        name: "Integrity & Ethics",
        stance: null,
      },
    ]);
    expect(result?.office).toEqual({
      id: officeId,
      scope: "place",
      canonical_name: "Mayor",
      summary: "Runs the city government.",
    });
    expect(result?.research_areas).toEqual([
      {
        id: researchAreaId,
        slug: "anti_corruption",
        name: "Anti-Corruption",
        description: "Corruption and abuse of office.",
      },
    ]);
    expect(query).toHaveBeenCalledTimes(10);
    expect(query.mock.calls[7]?.[0]).toContain("public.office_research_areas");
    expect(query.mock.calls[7]?.[1]).toEqual([[officeId], ["general", "integrity_and_ethics"]]);
    expect(query.mock.calls[8]?.[0]).toContain("public.office_research_areas");
    expect(query.mock.calls[8]?.[1]).toEqual([[officeId]]);
  });

  it("keeps only universal tags when the election office has no curated research areas", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const wealthGapAreaId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const integrityAreaId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "place",
            geoid_compact: "0644000",
            district_name: "Los Angeles city",
            state: "CA",
            state_fips: "06",
            representation_power_score: "64.25",
            race_type: "office",
            official_ballot_title: "Mayor",
            election_date: "2026-06-02",
            election_stage: "primary",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: officeId,
            office_canonical_name: "Mayor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Trial attorney.",
            current_office: null,
            state: "CA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            candidate_record_id: candidateRecordId,
            description: "Handled public corruption cases.",
            source_url: "https://example.test/record",
            event_date: "2025-05-01",
            created_at: "2026-06-04 00:00:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_record_id: candidateRecordId,
            research_area_id: integrityAreaId,
            slug: "integrity_and_ethics",
            name: "Integrity & Ethics",
            stance: null,
          },
          {
            candidate_record_id: candidateRecordId,
            research_area_id: wealthGapAreaId,
            slug: "reduce_wealth_gap",
            name: "Reduce Wealth Gap",
            stance: "for",
          },
        ],
      })
      // The office has no office_research_areas rows, so the allowed-areas
      // query returns only the universal areas. Filtering must still apply —
      // an office-scoped tag outside the (empty) curated set is dropped, not
      // passed through.
      .mockResolvedValueOnce({
        rows: [{ office_id: null, research_area_id: integrityAreaId }],
      })
      // No curated areas either way, so the payload's research_areas summary
      // query comes back empty too.
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.records[0]?.research_area_tags).toEqual([
      {
        research_area_id: integrityAreaId,
        slug: "integrity_and_ethics",
        name: "Integrity & Ethics",
        stance: null,
      },
    ]);
    expect(result?.research_areas).toEqual([]);
    expect(query).toHaveBeenCalledTimes(10);
    expect(query.mock.calls[7]?.[0]).toContain("public.office_research_areas");
  });

  it("keeps all candidate record tags when the election has no linked office", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "64.25",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-06-02",
            election_stage: "primary",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: null,
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Trial attorney.",
            current_office: null,
            state: "CA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            candidate_record_id: candidateRecordId,
            description: "Handled public corruption cases.",
            source_url: "https://example.test/record",
            event_date: "2025-05-01",
            created_at: "2026-06-04 00:00:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_record_id: candidateRecordId,
            research_area_id: researchAreaId,
            slug: "reduce_wealth_gap",
            name: "Reduce Wealth Gap",
            stance: "for",
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    // No office → no allowed set to scope by, so the allowed-areas query is
    // skipped entirely and the tag passes through.
    expect(result?.candidates[0]?.records[0]?.research_area_tags).toEqual([
      {
        research_area_id: researchAreaId,
        slug: "reduce_wealth_gap",
        name: "Reduce Wealth Gap",
        stance: "for",
      },
    ]);
    expect(query).toHaveBeenCalledTimes(8);
    for (const call of query.mock.calls) {
      expect(call[0]).not.toContain("public.office_research_areas");
    }
  });

  it("includes locally synced FEC finance summaries for candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "06",
            district_name: "California",
            state: "CA",
            state_fips: "06",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "U.S. Senate",
            election_date: "2024-11-05",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "us_senate",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "CA",
            fec_ids: ["S4CA00001"],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            fec_candidate_id: "S4CA00001",
            election_year: 2024,
            total_receipts: "1000.50",
            total_disbursements: "700.25",
            cash_on_hand: "300.00",
            debts_owed: "10.00",
            outside_support_total: "5000.00",
            outside_oppose_total: "125.50",
            source_url: "https://www.fec.gov/data/candidate/S4CA00001/?cycle=2024",
            last_synced_at: "2026-01-02 03:04:05+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "400.00",
            contributor_count: 4,
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "employer",
            category_name: "Google LLC",
            amount: "350.00",
            contributor_count: 3,
            source_url: "https://www.fec.gov/data/receipts/individual-contributions/?committee_id=C00000001",
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "industry",
            category_name: "technology",
            amount: "350.00",
            contributor_count: 3,
            source_url: "https://www.fec.gov/data/receipts/individual-contributions/?committee_id=C00000001",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "C00000001",
            committee_name: "Support Candidate PAC",
            support_oppose: "support",
            amount: "5000.00",
            source_url: "https://www.fec.gov/data/independent-expenditures/?committee_id=C00000001",
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "C00000002",
            committee_name: "Oppose Candidate PAC",
            support_oppose: "oppose",
            amount: "125.50",
            source_url: "https://www.fec.gov/data/independent-expenditures/?committee_id=C00000002",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "technology",
            amount: "2500.00",
            contributor_count: "8",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "finance_investment",
            amount: "125.50",
            contributor_count: "1",
            source_url: "https://www.fec.gov/data/receipts/individual-contributions/?committee_id=C00000002",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "technology",
            organization_name: "Google LLC",
            organization_type: "employer",
            amount: "2000.00",
            contributor_count: "6",
            committee_id: "C00000001",
            committee_name: "Support Candidate PAC",
            source_url: null,
          },
        ],
      })
      // Trailing committee-labels lookup (applyFinanceCommitteeLabels): the
      // supporting group has a researched label for this cycle, the opposing
      // group does not — labeled groups gain `label` plus its evidence,
      // unlabeled groups stay untouched.
      .mockResolvedValueOnce({
        rows: [
          {
            source: "FEC",
            committee_id: "C00000001",
            cycle: 2024,
            label: "Super PAC funded primarily by technology-industry donors",
            source_urls: ["https://www.opensecrets.org/pacs/lookup"],
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "FEC",
      cycle: 2024,
      fec_candidate_id: "S4CA00001",
      last_synced_at: "2026-01-02 03:04:05+00",
      direct_campaign: {
        total_raised: 1000.5,
        total_spent: 700.25,
        cash_on_hand: 300,
        debts_owed: 10,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 400,
            contributor_count: 4,
            source_url: "https://www.fec.gov/data/candidate/S4CA00001/?cycle=2024",
          },
        ],
        top_employers: [
          {
            category_name: "Google LLC",
            amount: 350,
            contributor_count: 3,
            source_url: "https://www.fec.gov/data/receipts/individual-contributions/?committee_id=C00000001",
          },
        ],
        top_industries: [
          {
            category_name: "technology",
            amount: 350,
            contributor_count: 3,
            source_url: "https://www.fec.gov/data/receipts/individual-contributions/?committee_id=C00000001",
          },
        ],
      },
      outside_spending: {
        support_total: 5000,
        oppose_total: 125.5,
        top_supporting_groups: [
          {
            committee_id: "C00000001",
            committee_name: "Support Candidate PAC",
            support_oppose: "support",
            amount: 5000,
            source_url: "https://www.fec.gov/data/independent-expenditures/?committee_id=C00000001",
            label: "Super PAC funded primarily by technology-industry donors",
            label_source_urls: ["https://www.opensecrets.org/pacs/lookup"],
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "C00000002",
            committee_name: "Oppose Candidate PAC",
            support_oppose: "oppose",
            amount: 125.5,
            source_url: "https://www.fec.gov/data/independent-expenditures/?committee_id=C00000002",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "technology",
            amount: 2500,
            contributor_count: 8,
            source_url: "https://www.fec.gov/data/independent-expenditures/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "finance_investment",
            amount: 125.5,
            contributor_count: 1,
            source_url: "https://www.fec.gov/data/receipts/individual-contributions/?committee_id=C00000002",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 400,
            contributor_count: 4,
            source_url: "https://www.fec.gov/data/candidate/S4CA00001/?cycle=2024",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "technology",
            amount: 2500,
            contributor_count: 8,
            source_url: "https://www.fec.gov/data/independent-expenditures/",
            explanation:
              "The Technology category is a top outside-spending support industry because contributors employed by Google LLC contributed to Support Candidate PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Google LLC",
                organization_type: "employer",
                amount: 2000,
                contributor_count: 6,
                committee_id: "C00000001",
                committee_name: "Support Candidate PAC",
                source_url: "https://www.fec.gov/data/independent-expenditures/",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.candidate_finance_direct_breakdowns");
    expect(query.mock.calls[9]?.[0]).toContain("public.candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
    // Committee-labels enrichment runs last, keyed on
    // (source, committee_id, cycle).
    expect(query.mock.calls[12]?.[0]).toContain("public.finance_committee_labels");
    expect(query.mock.calls[12]?.[1]).toEqual([
      ["FEC", "FEC"],
      ["C00000001", "C00000002"],
      [2024, 2024],
    ]);
  });

  // FEC ids are office-typed (S=Senate, H=House, P=President) and stored
  // additively, so a candidate keeps ids from earlier federal runs. The FEC
  // summaries table is keyed (fec_candidate_id, election_year) with no
  // election_id, so without an office gate a state race would match the
  // candidate's federal money for the same year — and override the correct
  // state summary, since FEC merges last. These mocks dispatch on the queried
  // table, not call order, so they survive loader reordering.
  it("does not load FEC finance for a state office race when the candidate retains a federal FEC id", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "true");

    const query = vi.fn().mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("public.elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: officeElectionId,
              district_id: districtId,
              district_type: "statewide",
              geoid_compact: "51",
              district_name: "Virginia",
              state: "VA",
              state_fips: "51",
              representation_power_score: "80",
              race_type: "office",
              official_ballot_title: "Governor",
              election_date: "2026-11-03",
              election_stage: "general",
              is_partisan: true,
              discovery_contest_family: "non_judicial_office",
              sources: ["https://example.test/elections"],
              office_scope: "statewide",
              office_canonical_name: "Governor",
            },
          ],
        });
      }
      if (text.includes("public.candidate_elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: officeElectionId,
              candidate_election_id: candidateElectionId,
              candidate_id: candidateId,
              display_name: "Jane Commonwealth",
              party: "Democratic",
              is_incumbent: false,
              status: "declared",
              summary: "Candidate summary.",
              current_office: "United States Senator",
              state: "VA",
              fec_ids: ["S4VA00001"],
              state_filing_ids: [],
            },
          ],
        });
      }
      if (text.includes("public.va_candidate_finance_summaries")) {
        return Promise.resolve({
          rows: [
            {
              candidate_id: candidateId,
              election_id: officeElectionId,
              committee_id: "CC-25-00001",
              election_year: 2026,
              total_receipts: "210000.00",
              direct_contribution_total: "180000.00",
              source_url: "https://cfreports.elections.virginia.gov/Committee/Index/CC-25-00001",
              last_synced_at: "2026-06-22 04:05:00+00",
            },
          ],
        });
      }
      if (text.includes("public.candidate_finance_summaries")) {
        return Promise.resolve({
          rows: [
            {
              candidate_id: candidateId,
              election_id: officeElectionId,
              fec_candidate_id: "S4VA00001",
              election_year: 2026,
              total_receipts: "1000.50",
              total_disbursements: "700.25",
              cash_on_hand: "300.00",
              debts_owed: "10.00",
              outside_support_total: null,
              outside_oppose_total: null,
              source_url: "https://www.fec.gov/data/candidate/S4VA00001/?cycle=2026",
              last_synced_at: "2026-01-02 03:04:05+00",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await lookupElectionDetailById({ query }, officeElectionId);
    const financeSummary = result?.candidates[0]?.finance_summary;

    // The governor race keeps its state finance...
    expect(financeSummary?.source).toBe("VIRGINIA_CFREPORTS");
    expect(financeSummary?.controlled_committee_id).toBe("CC-25-00001");
    expect(financeSummary?.direct_campaign.total_raised).toBe(180000);

    // ...and the federal summaries table is never queried for it.
    const queriedTables = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(queriedTables).toContain("public.va_candidate_finance_summaries");
    expect(queriedTables).not.toContain("public.candidate_finance_summaries AS");
  });

  // discovery_contest_family records which search found the election and is
  // stored with no consistency check against the resolved office, so the two
  // can disagree. The office link is curated and must win: a Governor office
  // blocks Senate finance even when the family wrongly says us_senate.
  it("does not load FEC finance when a mislabeled contest family contradicts the resolved office", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");

    const query = vi.fn().mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("public.elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: officeElectionId,
              district_id: districtId,
              district_type: "statewide",
              geoid_compact: "51",
              district_name: "Virginia",
              state: "VA",
              state_fips: "51",
              representation_power_score: "80",
              race_type: "office",
              official_ballot_title: "Governor",
              election_date: "2026-11-03",
              election_stage: "general",
              is_partisan: true,
              // Wrong: the discovering search's family, never validated
              // against the office the matcher resolved below.
              discovery_contest_family: "us_senate",
              sources: ["https://example.test/elections"],
              office_scope: "statewide",
              office_canonical_name: "Governor",
            },
          ],
        });
      }
      if (text.includes("public.candidate_elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: officeElectionId,
              candidate_election_id: candidateElectionId,
              candidate_id: candidateId,
              display_name: "Jane Commonwealth",
              party: "Democratic",
              is_incumbent: false,
              status: "declared",
              summary: "Candidate summary.",
              current_office: "United States Senator",
              state: "VA",
              fec_ids: ["S4VA00001"],
              state_filing_ids: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    const queriedTables = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(queriedTables).not.toContain("public.candidate_finance_summaries AS");
  });

  it("requests FEC finance only for the id matching the election's federal office", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");

    const query = vi.fn().mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("public.elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: officeElectionId,
              district_id: districtId,
              district_type: "us_house",
              geoid_compact: "5101",
              district_name: "Virginia's 1st Congressional District",
              state: "VA",
              state_fips: "51",
              representation_power_score: "60",
              race_type: "office",
              official_ballot_title: "U.S. House, Virginia District 1",
              election_date: "2026-11-03",
              election_stage: "general",
              is_partisan: true,
              discovery_contest_family: "non_judicial_office",
              sources: ["https://example.test/elections"],
              office_scope: "us_house",
              office_canonical_name: "United States Representative",
            },
          ],
        });
      }
      if (text.includes("public.candidate_elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: officeElectionId,
              candidate_election_id: candidateElectionId,
              candidate_id: candidateId,
              display_name: "Jane Commonwealth",
              party: "Democratic",
              is_incumbent: false,
              status: "declared",
              summary: "Candidate summary.",
              current_office: null,
              state: "VA",
              // A House id plus a retained Senate id from an earlier run.
              fec_ids: ["H6VA01234", "S4VA00001"],
              state_filing_ids: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    await lookupElectionDetailById({ query }, officeElectionId);

    const fecSummaryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("public.candidate_finance_summaries AS")
    );
    expect(fecSummaryCall).toBeDefined();
    const requests = JSON.parse(String(fecSummaryCall?.[1]?.[0])) as Array<{ fec_candidate_id: string }>;
    expect(requests.map((request) => request.fec_candidate_id)).toEqual(["H6VA01234"]);
  });

  it("includes locally synced California finance summaries for California candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "06",
            district_name: "California",
            state: "CA",
            state_fips: "06",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Gavin Newsom",
            party: "Democratic",
            is_incumbent: true,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "CA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            controlled_committee_id: "1456045",
            election_year: 2026,
            total_receipts: "2750.00",
            total_disbursements: null,
            cash_on_hand: null,
            debts_owed: null,
            outside_support_total: "300.00",
            outside_oppose_total: "50.00",
            source_url: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
            last_synced_at: "2026-02-03 04:05:06+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "125.00",
            contributor_count: 2,
            source_url: "https://powersearch.sos.ca.gov/advanced.php",
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "employer",
            category_name: "Google LLC",
            amount: "2500.00",
            contributor_count: 4,
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "industry",
            category_name: "technology",
            amount: "2500.00",
            contributor_count: 4,
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "1267335",
            committee_name: "Democratic Club of Ventura",
            support_oppose: "support",
            amount: "300.00",
            source_url: "https://powersearch.sos.ca.gov:3000/ie/search?candidatename=Newsom%2C+Gavin&electioncycle=2025",
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "1442978",
            committee_name: "SAFE CA INC",
            support_oppose: "oppose",
            amount: "50.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "environmental_group",
            amount: "175.00",
            contributor_count: "3",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "50.00",
            contributor_count: "1",
            source_url: "https://powersearch.sos.ca.gov:3000/ie/search?candidatename=Newsom%2C+Gavin&electioncycle=2025",
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "CALIFORNIA_SOS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "1456045",
      last_synced_at: "2026-02-03 04:05:06+00",
      direct_campaign: {
        total_raised: 2750,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 125,
            contributor_count: 2,
            source_url: "https://powersearch.sos.ca.gov/advanced.php",
          },
        ],
        top_employers: [],
        top_industries: [
          {
            category_name: "technology",
            amount: 2500,
            contributor_count: 4,
            source_url: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
          },
        ],
      },
      outside_spending: {
        support_total: 300,
        oppose_total: 50,
        top_supporting_groups: [
          {
            committee_id: "1267335",
            committee_name: "Democratic Club of Ventura",
            support_oppose: "support",
            amount: 300,
            source_url: "https://powersearch.sos.ca.gov:3000/ie/search?candidatename=Newsom%2C+Gavin&electioncycle=2025",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "1442978",
            committee_name: "SAFE CA INC",
            support_oppose: "oppose",
            amount: 50,
            source_url: "https://powersearch.sos.ca.gov:3000/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 175,
            contributor_count: 3,
            source_url: "https://powersearch.sos.ca.gov:3000/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 50,
            contributor_count: 1,
            source_url: "https://powersearch.sos.ca.gov:3000/ie/search?candidatename=Newsom%2C+Gavin&electioncycle=2025",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 125,
            contributor_count: 2,
            source_url: "https://powersearch.sos.ca.gov/advanced.php",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 175,
            contributor_count: 3,
            source_url: "https://powersearch.sos.ca.gov:3000/",
            explanation:
              "The Environmental groups category is a top outside-spending support industry because organizations classified in this industry contributed to outside groups that reported independent spending supporting this candidate.",
            supporting_organizations: [],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(13);
    expect(query.mock.calls[7]?.[0]).toContain("public.ca_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ca_candidate_finance_direct_breakdowns");
    expect(query.mock.calls[9]?.[0]).toContain("public.ca_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.ca_candidate_finance_outside_group_breakdowns");
    expect(String(query.mock.calls[7]?.[0])).not.toContain("DISTINCT ON");
    expect(String(query.mock.calls[7]?.[0])).toContain("sum(summary.total_receipts)");
    expect(String(query.mock.calls[7]?.[0])).toContain("max(summary.outside_support_total)");
    expect(String(query.mock.calls[7]?.[0])).toContain("count(DISTINCT link.controlled_committee_id)");
    expect(String(query.mock.calls[8]?.[0])).toContain(
      "GROUP BY selected.candidate_id, selected.election_id, breakdown.category_type, breakdown.category_name"
    );
    expect(String(query.mock.calls[9]?.[0])).toContain("max(outside_group.amount)");
    expect(String(query.mock.calls[9]?.[0])).toContain(
      "GROUP BY selected.candidate_id, selected.election_id, outside_group.committee_id, outside_group.support_oppose"
    );
    expect(String(query.mock.calls[10]?.[0])).toContain("per_group AS");
    expect(String(query.mock.calls[10]?.[0])).toContain("max(breakdown.amount)");
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("includes locally synced Colorado finance summaries for Colorado candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "08",
            district_name: "Colorado",
            state: "CO",
            state_fips: "08",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Doe",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "CO",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "202650001",
            election_year: 2026,
            total_receipts: "3250.00",
            source_url:
              "https://tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
            last_synced_at: "2026-02-03 04:05:06+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "750.00",
            contributor_count: "3",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "employer",
            category_name: "Acme Inc",
            amount: "1500.00",
            contributor_count: "4",
            source_url:
              "https://tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "industry",
            category_name: "technology",
            amount: "1500.00",
            contributor_count: "4",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "COLORADO_TRACER",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "202650001",
      last_synced_at: "2026-02-03 04:05:06+00",
      direct_campaign: {
        total_raised: 3250,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 750,
            contributor_count: 3,
            source_url:
              "https://tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
        ],
        top_employers: [],
        top_industries: [
          {
            category_name: "technology",
            amount: 1500,
            contributor_count: 4,
            source_url:
              "https://tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 750,
            contributor_count: 3,
            source_url:
              "https://tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
        ],
        top_outside_supporting_industries: [],
      },
    });
    expect(query).toHaveBeenCalledTimes(10);
    expect(query.mock.calls[7]?.[0]).toContain("public.co_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.co_candidate_finance_direct_breakdowns");
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("public.ca_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("includes locally synced Connecticut finance summaries for Connecticut candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "09",
            district_name: "Connecticut",
            state: "CT",
            state_fips: "09",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Doe",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "CT",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "12345",
            election_year: 2026,
            total_receipts: "4250.00",
            total_disbursements: "1200.25",
            source_url:
              "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
            last_synced_at: "2026-02-03 04:05:06+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "950.00",
            contributor_count: "3",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$100-$249",
            amount: "500.00",
            contributor_count: "4",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "industry",
            category_name: "lawyers_and_legal_services",
            amount: "950.00",
            contributor_count: "3",
            source_url: null,
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "CONNECTICUT_ECRIS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "12345",
      last_synced_at: "2026-02-03 04:05:06+00",
      direct_campaign: {
        total_raised: 4250,
        total_spent: 1200.25,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 950,
            contributor_count: 3,
            source_url:
              "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
          },
        ],
        top_employers: [],
        top_industries: [
          {
            category_name: "lawyers_and_legal_services",
            amount: 950,
            contributor_count: 3,
            source_url:
              "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        outside_coverage_note:
          "Connecticut totals count independent expenditures that SEEC Form 40 filers reported as paid and tied to this one candidate; expenditures not yet paid, lines naming several candidates at once, and spending reported on other SEEC forms (party and PAC statements, and reports by spenders that are not committees) are not included.",
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 950,
            contributor_count: 3,
            source_url:
              "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
          },
        ],
        top_outside_supporting_industries: [],
      },
    });
    expect(query).toHaveBeenCalledTimes(11);
    expect(query.mock.calls[7]?.[0]).toContain("public.ct_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ct_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'industry')");
    expect(query.mock.calls[9]?.[0]).toContain("public.ct_candidate_finance_outside_groups");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.co_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.ca_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("includes locally synced Nebraska finance summaries with top direct donor occupations", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEBRASKA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_upper",
            geoid_compact: "31030",
            district_name: "Nebraska Legislative District 30",
            state: "NE",
            state_fips: "31",
            representation_power_score: "70",
            race_type: "office",
            official_ballot_title: "State Senator District 30",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: "State Senator",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Rick Vest",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "NE",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "7569",
            election_year: 2026,
            total_receipts: "81880.74",
            direct_contribution_total: "75389.00",
            source_url:
              "https://nadc-e.nebraska.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "PROPRIETOR",
            amount: "500.00",
            contributor_count: "1",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "industry",
            category_name: "agriculture_and_food",
            amount: "2500.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "NEBRASKA_NADC",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "7569",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 81880.74,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "PROPRIETOR",
            amount: 500,
            contributor_count: 1,
            source_url:
              "https://nadc-e.nebraska.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
          },
        ],
        top_employers: [],
        top_industries: [
          {
            category_name: "agriculture_and_food",
            amount: 2500,
            contributor_count: 1,
            source_url:
              "https://nadc-e.nebraska.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "PROPRIETOR",
            amount: 500,
            contributor_count: 1,
            source_url:
              "https://nadc-e.nebraska.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
          },
        ],
        top_outside_supporting_industries: [],
      },
    });
    expect(query).toHaveBeenCalledTimes(11);
    expect(query.mock.calls[7]?.[0]).toContain("public.ne_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ne_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'industry')");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.ct_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.co_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.ca_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("includes locally synced Oklahoma finance summaries with top direct donor occupations", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEBRASKA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_upper",
            geoid_compact: "40047",
            district_name: "Oklahoma Senate District 47",
            state: "OK",
            state_fips: "40",
            representation_power_score: "70",
            race_type: "office",
            official_ballot_title: "State Senator District 47",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: "State Senator",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Brent Dishman",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "OK",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "11954",
            election_year: 2026,
            total_receipts: "120000.00",
            direct_contribution_total: "95000.00",
            source_url:
              "https://guardian.ok.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "1500.00",
            contributor_count: "3",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "25000.00",
            contributor_count: "2",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "OKLAHOMA_GUARDIAN",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "11954",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 120000,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 1500,
            contributor_count: 3,
            source_url:
              "https://guardian.ok.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 25000,
            contributor_count: 2,
            source_url:
              "https://guardian.ok.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 1500,
            contributor_count: 3,
            source_url:
              "https://guardian.ok.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionLoanExtract.csv.zip",
          },
        ],
        top_outside_supporting_industries: [],
      },
    });
    expect(query).toHaveBeenCalledTimes(11);
    expect(query.mock.calls[7]?.[0]).toContain("public.ok_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ok_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.nm_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.ne_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("includes locally synced Indiana finance summaries with top direct donor occupations", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("ALASKA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("ARIZONA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("COLORADO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("FLORIDA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("HAWAII_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MAINE_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("MARYLAND_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("MINNESOTA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEBRASKA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEW_JERSEY_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("OREGON_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("PENNSYLVANIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("TENNESSEE_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("UTAH_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("WASHINGTON_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_upper",
            geoid_compact: "18030",
            district_name: "Indiana Senate District 30",
            state: "IN",
            state_fips: "18",
            representation_power_score: "70",
            race_type: "office",
            official_ballot_title: "State Senator District 30",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: "State Senator",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Cesar Diego Morales",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "IN",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "422",
            election_year: 2026,
            total_receipts: "5350.00",
            direct_contribution_total: "5350.00",
            source_url:
              "https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Teacher/Education",
            amount: "5000.00",
            contributor_count: "1",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$5,000+",
            amount: "5000.00",
            contributor_count: "1",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "pac_backed_industry",
            category_name: "pharmaceuticals",
            amount: "2500.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "INDIANA_CAMPAIGN_FINANCE",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "422",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 5350,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Teacher/Education",
            amount: 5000,
            contributor_count: 1,
            source_url:
              "https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$5,000+",
            amount: 5000,
            contributor_count: 1,
            source_url:
              "https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Teacher/Education",
            amount: 5000,
            contributor_count: 1,
            source_url:
              "https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
          },
        ],
        top_outside_supporting_industries: [],
        top_pac_backed_industries: [
          {
            category_name: "pharmaceuticals",
            amount: 2500,
            contributor_count: 1,
            source_url:
              "https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
            explanation:
              "The Pharmaceuticals category is a top PAC-backed donor industry because organizations classified in this industry contributed to PACs that directly contributed to this candidate's committee.",
            supporting_organizations: [],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(11);
    expect(query.mock.calls[7]?.[0]).toContain("public.in_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.in_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain(
      "breakdown.category_type IN ('occupation', 'contribution_size', 'pac_backed_industry')"
    );
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.ok_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.ne_candidate_finance");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.candidate_finance_summaries");
  });


  it("includes locally synced New Mexico finance summaries for New Mexico candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "35",
            district_name: "New Mexico",
            state: "NM",
            state_fips: "35",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Michelle Lujan Grisham",
            party: "Democratic",
            is_incumbent: true,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "NM",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "12345",
            election_year: 2026,
            total_receipts: "100000.00",
            direct_contribution_total: "75000.00",
            total_disbursements: "25000.00",
            outside_support_total: "50000.00",
            outside_oppose_total: "1000.00",
            source_url: "https://login.cfis.sos.state.nm.us/api/DataDownload/GetCSVDownloadReport?year=2026&transactionType=CON",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "ATTORNEY",
            amount: "20000.00",
            contributor_count: "12",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "industry",
            category_name: "lawyers_and_legal_services",
            amount: "22000.00",
            contributor_count: "13",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "9001",
            committee_name: "New Mexico Progress PAC",
            support_oppose: "support",
            amount: "50000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "9002",
            committee_name: "Oppose Governor PAC",
            support_oppose: "oppose",
            amount: "1000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "oil_gas_energy",
            amount: "45000.00",
            contributor_count: "4",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "1000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "NEW_MEXICO_CFIS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "12345",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 75000,
        total_spent: 25000,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 20000,
            contributor_count: 12,
            source_url:
              "https://login.cfis.sos.state.nm.us/api/DataDownload/GetCSVDownloadReport?year=2026&transactionType=CON",
          },
        ],
        top_employers: [],
        top_industries: [
          {
            category_name: "lawyers_and_legal_services",
            amount: 22000,
            contributor_count: 13,
            source_url:
              "https://login.cfis.sos.state.nm.us/api/DataDownload/GetCSVDownloadReport?year=2026&transactionType=CON",
          },
        ],
      },
      outside_spending: {
        support_total: 50000,
        oppose_total: 1000,
        top_supporting_groups: [
          {
            committee_id: "9001",
            committee_name: "New Mexico Progress PAC",
            support_oppose: "support",
            amount: 50000,
            source_url: "https://www.cfis.state.nm.us/media/CFIS_Data_Download.aspx",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "9002",
            committee_name: "Oppose Governor PAC",
            support_oppose: "oppose",
            amount: 1000,
            source_url: "https://www.cfis.state.nm.us/media/CFIS_Data_Download.aspx",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "oil_gas_energy",
            amount: 45000,
            contributor_count: 4,
            source_url: "https://www.cfis.state.nm.us/media/CFIS_Data_Download.aspx",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 1000,
            contributor_count: 1,
            source_url: "https://www.cfis.state.nm.us/media/CFIS_Data_Download.aspx",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 20000,
            contributor_count: 12,
            source_url:
              "https://login.cfis.sos.state.nm.us/api/DataDownload/GetCSVDownloadReport?year=2026&transactionType=CON",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "oil_gas_energy",
            amount: 45000,
            contributor_count: 4,
            source_url: "https://www.cfis.state.nm.us/media/CFIS_Data_Download.aspx",
            explanation:
              "The Oil, gas, and energy category is a top outside-spending support industry because organizations classified in this industry contributed to outside groups that reported independent spending supporting this candidate.",
            supporting_organizations: [],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(13);
    expect(query.mock.calls[7]?.[0]).toContain("public.nm_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.nm_candidate_finance_direct_breakdowns");
    expect(query.mock.calls[9]?.[0]).toContain("public.nm_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.nm_candidate_finance_outside_group_breakdowns");
  });

  it("includes locally synced Texas finance summaries for Texas candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "48",
            district_name: "Texas",
            state: "TX",
            state_fips: "48",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Texan",
            party: "Republican",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "TX",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "TX100",
            election_year: 2026,
            total_receipts: "120000.00",
            direct_contribution_total: "95000.00",
            total_disbursements: "30000.00",
            cash_on_hand: "65000.00",
            outside_support_total: "80000.00",
            outside_oppose_total: "2000.00",
            source_url: "https://www.ethics.state.tx.us/search/cf/",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "ATTORNEY",
            amount: "25000.00",
            contributor_count: "10",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "SPAC1",
            committee_name: "Texas Progress PAC",
            support_oppose: "support",
            amount: "80000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "SPAC2",
            committee_name: "Oppose Jane PAC",
            support_oppose: "oppose",
            amount: "2000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "technology",
            amount: "70000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "2000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "technology",
            committee_id: "SPAC1",
            committee_name: "Texas Progress PAC",
            support_oppose: "support",
            organization_name: "LONE STAR AI LABS LLC",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "TEXAS_TEC",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "TX100",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 95000,
        total_spent: 30000,
        cash_on_hand: 65000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
      },
      outside_spending: {
        support_total: 80000,
        oppose_total: 2000,
        top_supporting_groups: [
          {
            committee_id: "SPAC1",
            committee_name: "Texas Progress PAC",
            support_oppose: "support",
            amount: 80000,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "SPAC2",
            committee_name: "Oppose Jane PAC",
            support_oppose: "oppose",
            amount: 2000,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "technology",
            amount: 70000,
            contributor_count: 2,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 2000,
            contributor_count: 1,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "technology",
            amount: 70000,
            contributor_count: 2,
            source_url: "https://www.ethics.state.tx.us/search/cf/",
            explanation:
              "The Technology category is a top outside-spending support industry because LONE STAR AI LABS LLC contributed to Texas Progress PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "LONE STAR AI LABS LLC",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "SPAC1",
                committee_name: "Texas Progress PAC",
                source_url: "https://www.ethics.state.tx.us/search/cf/",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.tx_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.tx_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.tx_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.tx_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.tx_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Florida finance summaries for Florida candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("FLORIDA_CAMPAIGN_FINANCE_ENABLED", "true");
    const floridaSourceUrl =
      "https://dos.fl.gov/elections/candidates-committees/campaign-finance/campaign-finance-database/";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "12",
            district_name: "Florida",
            state: "FL",
            state_fips: "12",
            representation_power_score: "78",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Floridian",
            party: "Republican",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "FL",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "FRIENDS_OF_JANE_FL",
            election_year: 2026,
            total_receipts: "120000.00",
            direct_contribution_total: "95000.00",
            total_disbursements: "30000.00",
            cash_on_hand: "65000.00",
            outside_support_total: "80000.00",
            outside_oppose_total: "2000.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "25000.00",
            contributor_count: "10",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "FLPAC1",
            committee_name: "Floridians for Jane",
            support_oppose: "support",
            amount: "80000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "FLPAC2",
            committee_name: "Oppose Jane Florida",
            support_oppose: "oppose",
            amount: "2000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "real_estate",
            amount: "70000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "insurance",
            amount: "2000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "real_estate",
            committee_id: "FLPAC1",
            committee_name: "Floridians for Jane",
            support_oppose: "support",
            organization_name: "SUNSHINE REALTY LLC",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "FLORIDA_DOS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "FRIENDS_OF_JANE_FL",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 95000,
        total_spent: 30000,
        cash_on_hand: 65000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 25000,
            contributor_count: 10,
            source_url: floridaSourceUrl,
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: floridaSourceUrl,
          },
        ],
      },
      outside_spending: {
        support_total: 80000,
        oppose_total: 2000,
        top_supporting_groups: [
          {
            committee_id: "FLPAC1",
            committee_name: "Floridians for Jane",
            support_oppose: "support",
            amount: 80000,
            source_url: floridaSourceUrl,
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "FLPAC2",
            committee_name: "Oppose Jane Florida",
            support_oppose: "oppose",
            amount: 2000,
            source_url: floridaSourceUrl,
          },
        ],
        top_supporting_industries: [
          {
            category_name: "real_estate",
            amount: 70000,
            contributor_count: 2,
            source_url: floridaSourceUrl,
          },
        ],
        top_opposing_industries: [
          {
            category_name: "insurance",
            amount: 2000,
            contributor_count: 1,
            source_url: floridaSourceUrl,
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 25000,
            contributor_count: 10,
            source_url: floridaSourceUrl,
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "real_estate",
            amount: 70000,
            contributor_count: 2,
            source_url: floridaSourceUrl,
            explanation:
              "The Real estate category is a top outside-spending support industry because SUNSHINE REALTY LLC contributed to Floridians for Jane, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "SUNSHINE REALTY LLC",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "FLPAC1",
                committee_name: "Floridians for Jane",
                source_url: floridaSourceUrl,
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.fl_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.fl_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.fl_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.fl_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.fl_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
  });

  it("includes locally synced Arizona finance summaries for Arizona candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("ARIZONA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "04",
            district_name: "Arizona",
            state: "AZ",
            state_fips: "04",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Arizonan",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "AZ",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "AZ100",
            election_year: 2026,
            total_receipts: "120000.00",
            direct_contribution_total: "95000.00",
            total_disbursements: "30000.00",
            cash_on_hand: "65000.00",
            outside_support_total: "80000.00",
            outside_oppose_total: "2000.00",
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "ATTORNEY",
            amount: "25000.00",
            contributor_count: "10",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "AZPAC1",
            committee_name: "Arizona Progress PAC",
            support_oppose: "support",
            amount: "80000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "AZPAC2",
            committee_name: "Oppose Jane PAC",
            support_oppose: "oppose",
            amount: "2000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "technology",
            amount: "70000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "2000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "technology",
            committee_id: "AZPAC1",
            committee_name: "Arizona Progress PAC",
            support_oppose: "support",
            organization_name: "DESERT AI LABS LLC",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "ARIZONA_SOS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "AZ100",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 95000,
        total_spent: 30000,
        cash_on_hand: 65000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
      },
      outside_spending: {
        support_total: 80000,
        oppose_total: 2000,
        top_supporting_groups: [
          {
            committee_id: "AZPAC1",
            committee_name: "Arizona Progress PAC",
            support_oppose: "support",
            amount: 80000,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "AZPAC2",
            committee_name: "Oppose Jane PAC",
            support_oppose: "oppose",
            amount: 2000,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "technology",
            amount: 70000,
            contributor_count: 2,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 2000,
            contributor_count: 1,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "technology",
            amount: 70000,
            contributor_count: 2,
            source_url: "https://seethemoney.az.gov/Reporting/Explore",
            explanation:
              "The Technology category is a top outside-spending support industry because DESERT AI LABS LLC contributed to Arizona Progress PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "DESERT AI LABS LLC",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "AZPAC1",
                committee_name: "Arizona Progress PAC",
                source_url: "https://seethemoney.az.gov/Reporting/Explore",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.az_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.az_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.az_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.az_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.az_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Washington finance summaries for Washington candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("WASHINGTON_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "53",
            district_name: "Washington",
            state: "WA",
            state_fips: "53",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Evergreen",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "WA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "WA100",
            election_year: 2026,
            total_receipts: "130000.00",
            direct_contribution_total: "100000.00",
            total_disbursements: "45000.00",
            cash_on_hand: "55000.00",
            outside_support_total: "70000.00",
            outside_oppose_total: "3000.00",
            source_url: "https://data.wa.gov/resource/3h9x-7bvm.json",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "ATTORNEY - LAWYER",
            amount: "25000.00",
            contributor_count: "10",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "FUSEV147",
            committee_name: "Fuse Votes",
            support_oppose: "support",
            amount: "70000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "WASH24",
            committee_name: "Washington 24",
            support_oppose: "oppose",
            amount: "3000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "environmental_group",
            amount: "60000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "3000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "environmental_group",
            committee_id: "FUSEV147",
            committee_name: "Fuse Votes",
            support_oppose: "support",
            organization_name: "Washington Conservation Action Votes",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "WASHINGTON_PDC",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "WA100",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 100000,
        total_spent: 45000,
        cash_on_hand: 55000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "ATTORNEY - LAWYER",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://data.wa.gov/resource/3h9x-7bvm.json",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: "https://data.wa.gov/resource/3h9x-7bvm.json",
          },
        ],
        direct_coverage_note:
          "Occupation breakdowns reflect donors whose contributions exceed $250 in aggregate, the threshold above " +
          "which Washington requires occupation disclosure. Smaller and batched contributions are included in the " +
          "official totals but carry no donor detail, and campaigns using Washington's mini-reporting option file " +
          "no itemized contribution reports at all.",
      },
      outside_spending: {
        support_total: 70000,
        oppose_total: 3000,
        top_supporting_groups: [
          {
            committee_id: "FUSEV147",
            committee_name: "Fuse Votes",
            support_oppose: "support",
            amount: 70000,
            source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "WASH24",
            committee_name: "Washington 24",
            support_oppose: "oppose",
            amount: 3000,
            source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 3000,
            contributor_count: 1,
            source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "ATTORNEY - LAWYER",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://data.wa.gov/resource/3h9x-7bvm.json",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data",
            explanation:
              "The Environmental groups category is a top outside-spending support industry because Washington Conservation Action Votes contributed to Fuse Votes, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Washington Conservation Action Votes",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "FUSEV147",
                committee_name: "Fuse Votes",
                source_url: "https://www.pdc.wa.gov/political-disclosure-reporting-data/browse-search-data",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.wa_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.wa_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.wa_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.wa_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.wa_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Wisconsin finance summaries for Wisconsin candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "55",
            district_name: "Wisconsin",
            state: "WI",
            state_fips: "55",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Badger",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "WI",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "WI100",
            election_year: 2026,
            total_receipts: "130000.00",
            direct_contribution_total: "100000.00",
            total_disbursements: "45000.00",
            cash_on_hand: "55000.00",
            outside_support_total: "70000.00",
            outside_oppose_total: "3000.00",
            source_url: "https://campaignfinance.wi.gov/",
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "ATTORNEY - LAWYER",
            amount: "25000.00",
            contributor_count: "10",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "WICVIEC",
            committee_name: "Wisconsin Conservation Voters IEC",
            support_oppose: "support",
            amount: "70000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "WIS24",
            committee_name: "Wisconsin 24",
            support_oppose: "oppose",
            amount: "3000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "environmental_group",
            amount: "60000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "3000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "environmental_group",
            committee_id: "WICVIEC",
            committee_name: "Wisconsin Conservation Voters IEC",
            support_oppose: "support",
            organization_name: "Wisconsin Conservation Action Votes",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "WISCONSIN_SUNSHINE",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "WI100",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 100000,
        total_spent: 45000,
        cash_on_hand: 55000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "ATTORNEY - LAWYER",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
      },
      outside_spending: {
        support_total: 70000,
        oppose_total: 3000,
        top_supporting_groups: [
          {
            committee_id: "WICVIEC",
            committee_name: "Wisconsin Conservation Voters IEC",
            support_oppose: "support",
            amount: 70000,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "WIS24",
            committee_name: "Wisconsin 24",
            support_oppose: "oppose",
            amount: 3000,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 3000,
            contributor_count: 1,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "ATTORNEY - LAWYER",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://campaignfinance.wi.gov/",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://campaignfinance.wi.gov/",
            explanation:
              "The Environmental groups category is a top outside-spending support industry because Wisconsin Conservation Action Votes contributed to Wisconsin Conservation Voters IEC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Wisconsin Conservation Action Votes",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "WICVIEC",
                committee_name: "Wisconsin Conservation Voters IEC",
                source_url: "https://campaignfinance.wi.gov/",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.wi_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.wi_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.wi_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.wi_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.wi_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Minnesota finance summaries for Minnesota candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MINNESOTA_CAMPAIGN_FINANCE_ENABLED", "true");
    const genericMinnesotaSourceUrl =
      "https://register.cfb.mn.gov/reports-and-data/self-help/data-downloads/campaign-finance/";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "27",
            district_name: "Minnesota",
            state: "MN",
            state_fips: "27",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: officeId,
            office_scope: "statewide",
            office_canonical_name: "Governor",
            office_summary: "Governor of Minnesota.",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Northstar",
            party: "Democratic-Farmer-Labor",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "MN",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "31001",
            election_year: 2026,
            total_receipts: "120000.00",
            direct_contribution_total: "120000.00",
            total_disbursements: "45000.00",
            cash_on_hand: "75000.00",
            outside_support_total: "60000.00",
            outside_oppose_total: "10000.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "32001",
            committee_name: "Northstar Alliance",
            support_oppose: "support",
            amount: "60000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "32099",
            committee_name: "Minnesota 24",
            support_oppose: "oppose",
            amount: "10000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "environmental_group",
            amount: "50000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "10000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "environmental_group",
            committee_id: "32001",
            committee_name: "Northstar Alliance",
            support_oppose: "support",
            organization_name: "Minnesota Conservation League",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      // Detail-payload office research-area summaries (none curated here).
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.office).toEqual({
      id: officeId,
      scope: "statewide",
      canonical_name: "Governor",
      summary: "Governor of Minnesota.",
    });
    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "MINNESOTA_CFB",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "31001",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 120000,
        total_spent: 45000,
        cash_on_hand: 75000,
        debts_owed: null,
        top_occupations: [],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [],
      },
      outside_spending: {
        support_total: 60000,
        oppose_total: 10000,
        top_supporting_groups: [
          {
            committee_id: "32001",
            committee_name: "Northstar Alliance",
            support_oppose: "support",
            amount: 60000,
            source_url: genericMinnesotaSourceUrl,
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "32099",
            committee_name: "Minnesota 24",
            support_oppose: "oppose",
            amount: 10000,
            source_url: genericMinnesotaSourceUrl,
          },
        ],
        top_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 50000,
            contributor_count: 2,
            source_url: genericMinnesotaSourceUrl,
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 10000,
            contributor_count: 1,
            source_url: genericMinnesotaSourceUrl,
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [],
        top_outside_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 50000,
            contributor_count: 2,
            source_url: genericMinnesotaSourceUrl,
            explanation:
              "The Environmental groups category is a top outside-spending support industry because Minnesota Conservation League contributed to Northstar Alliance, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Minnesota Conservation League",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "32001",
                committee_name: "Northstar Alliance",
                source_url: genericMinnesotaSourceUrl,
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.mn_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.mn_candidate_finance_outside_groups");
    expect(query.mock.calls[9]?.[0]).toContain("public.mn_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[10]?.[0]).toContain("public.mn_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[10]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[10]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[10]?.[0]).toContain("classification.normalized_label");
  });

  it("includes Minnesota finance summaries for legislative races whose election rows carry no district", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MINNESOTA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_lower",
            geoid_compact: "2707A",
            district_name: "Minnesota House District 7A",
            state: "MN",
            state_fips: "27",
            representation_power_score: "40",
            race_type: "office",
            official_ballot_title: "State Representative District 7A",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: officeId,
            office_scope: "state_lower",
            office_canonical_name: "State Representative",
            office_summary: "Member of the Minnesota House of Representatives.",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Northstar",
            party: "Democratic-Farmer-Labor",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "State Representative",
            state: "MN",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "31002",
            election_year: 2026,
            total_receipts: "40000.00",
            direct_contribution_total: "40000.00",
            total_disbursements: "15000.00",
            cash_on_hand: "25000.00",
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // Detail-payload office research-area summaries (none curated here).
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toMatchObject({
      source: "MINNESOTA_CFB",
      cycle: 2026,
      controlled_committee_id: "31002",
      direct_campaign: {
        total_raised: 40000,
        total_spent: 15000,
        cash_on_hand: 25000,
      },
    });
    expect(query).toHaveBeenCalledTimes(13);
    expect(query.mock.calls[7]?.[0]).toContain("public.mn_candidate_finance_summaries");
  });

  it("includes Louisiana finance summaries for legislative races whose election rows carry no district", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("LOUISIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_lower",
            geoid_compact: "22042",
            district_name: "Louisiana House District 42",
            state: "LA",
            state_fips: "22",
            representation_power_score: "40",
            race_type: "office",
            official_ballot_title: "State Representative District 42",
            election_date: "2027-10-09",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_id: officeId,
            office_scope: "state_lower",
            office_canonical_name: "State Representative",
            office_summary: "Member of the Louisiana House of Representatives.",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Bayou",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "State Representative",
            state: "LA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "54321",
            election_year: 2027,
            total_receipts: "40000.00",
            direct_contribution_total: "40000.00",
            total_disbursements: "15000.00",
            cash_on_hand: "25000.00",
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // Detail-payload office research-area summaries (none curated here).
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toMatchObject({
      source: "LOUISIANA_ETHICS",
      cycle: 2027,
      controlled_committee_id: "54321",
      direct_campaign: {
        total_raised: 40000,
        total_spent: 15000,
        cash_on_hand: 25000,
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.la_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.la_candidate_finance_direct_breakdowns");
  });

  it("includes locally synced Massachusetts finance summaries for Massachusetts candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "25",
            district_name: "Massachusetts",
            state: "MA",
            state_fips: "25",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Baystate",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "MA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "15710",
            election_year: 2026,
            total_receipts: "130000.00",
            direct_contribution_total: "100000.00",
            total_disbursements: "45000.00",
            cash_on_hand: "55000.00",
            outside_support_total: "70000.00",
            outside_oppose_total: "3000.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "25000.00",
            contributor_count: "10",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "81068",
            committee_name: "Local 103 IBEW IE PAC",
            support_oppose: "support",
            amount: "70000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "99999",
            committee_name: "Massachusetts 24",
            support_oppose: "oppose",
            amount: "3000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "environmental_group",
            amount: "60000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "3000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "environmental_group",
            committee_id: "81068",
            committee_name: "Local 103 IBEW IE PAC",
            support_oppose: "support",
            organization_name: "Environmental League",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "MASSACHUSETTS_OCPF",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "15710",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 100000,
        total_spent: 45000,
        cash_on_hand: 55000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://www.ocpf.us/",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: "https://www.ocpf.us/",
          },
        ],
        direct_coverage_note:
          "Donor breakdowns reflect itemized receipts reported to the Massachusetts Office of Campaign and Political " +
          "Finance. Totals are official bank-report year-to-date figures where available (otherwise sums of itemized " +
          "receipts) and can include money not shown in the breakdowns.",
      },
      outside_spending: {
        support_total: 70000,
        oppose_total: 3000,
        outside_coverage_note:
          "Covers independent expenditures reported by independent expenditure PACs (IEPACs) to the Massachusetts " +
          "Office of Campaign and Political Finance. Independent spending by other filer types and electioneering " +
          "communications are not included yet.",
        top_supporting_groups: [
          {
            committee_id: "81068",
            committee_name: "Local 103 IBEW IE PAC",
            support_oppose: "support",
            amount: 70000,
            source_url: "https://www.ocpf.us/",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "99999",
            committee_name: "Massachusetts 24",
            support_oppose: "oppose",
            amount: 3000,
            source_url: "https://www.ocpf.us/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://www.ocpf.us/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 3000,
            contributor_count: 1,
            source_url: "https://www.ocpf.us/",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 25000,
            contributor_count: 10,
            source_url: "https://www.ocpf.us/",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://www.ocpf.us/",
            explanation:
              "The Environmental groups category is a top outside-spending support industry because Environmental League contributed to Local 103 IBEW IE PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Environmental League",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "81068",
                committee_name: "Local 103 IBEW IE PAC",
                source_url: "https://www.ocpf.us/",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.ma_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ma_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.ma_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.ma_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.ma_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Vermont finance summaries for Vermont candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("VERMONT_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "50",
            district_name: "Vermont",
            state: "VT",
            state_fips: "50",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Green Mountain",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "VT",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "candidate-guid",
            election_year: 2026,
            total_receipts: "130000.00",
            direct_contribution_total: "100000.00",
            total_disbursements: null,
            cash_on_hand: null,
            outside_support_total: "70000.00",
            outside_oppose_total: "3000.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "40000.00",
            contributor_count: "8",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "pac-guid",
            committee_name: "VERMONT FUTURE PAC",
            support_oppose: "support",
            amount: "70000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "oppose-pac-guid",
            committee_name: "VERMONT 24 PAC",
            support_oppose: "oppose",
            amount: "3000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "environmental_group",
            amount: "60000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "3000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "environmental_group",
            committee_id: "pac-guid",
            committee_name: "VERMONT FUTURE PAC",
            support_oppose: "support",
            organization_name: "Sierra Club",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "VERMONT_CFD",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "candidate-guid",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 100000,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 40000,
            contributor_count: 8,
            source_url: "https://campaignfinance.vermont.gov/",
          },
        ],
      },
      outside_spending: {
        support_total: 70000,
        oppose_total: 3000,
        top_supporting_groups: [
          {
            committee_id: "pac-guid",
            committee_name: "VERMONT FUTURE PAC",
            support_oppose: "support",
            amount: 70000,
            source_url: "https://campaignfinance.vermont.gov/",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "oppose-pac-guid",
            committee_name: "VERMONT 24 PAC",
            support_oppose: "oppose",
            amount: 3000,
            source_url: "https://campaignfinance.vermont.gov/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://campaignfinance.vermont.gov/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 3000,
            contributor_count: 1,
            source_url: "https://campaignfinance.vermont.gov/",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [],
        top_outside_supporting_industries: [
          {
            category_name: "environmental_group",
            amount: 60000,
            contributor_count: 2,
            source_url: "https://campaignfinance.vermont.gov/",
            explanation:
              "The Environmental groups category is a top outside-spending support industry because Sierra Club contributed to VERMONT FUTURE PAC, which reported PAC contributions supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Sierra Club",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "pac-guid",
                committee_name: "VERMONT FUTURE PAC",
                source_url: "https://campaignfinance.vermont.gov/",
              },
            ],
          },
        ],
      },
    });
    const querySql = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(querySql).toContain("public.vt_candidate_finance_summaries");
    expect(querySql).toContain("breakdown.category_type IN ('contribution_size')");
    expect(querySql).toContain("public.vt_candidate_finance_outside_groups");
    expect(querySql).toContain("public.vt_candidate_finance_outside_group_breakdowns");
    expect(querySql).toContain("public.finance_label_classifications");
  });

  it("includes locally synced Kentucky KREF finance summaries for Kentucky candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
    const genericKentuckySourceUrl = "https://secure.kentucky.gov/kref/publicsearch";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "21",
            district_name: "Kentucky",
            state: "KY",
            state_fips: "21",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2023-11-07",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/kentucky-elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Andy Beshear",
            party: "Democratic",
            is_incumbent: true,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "KY",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "BESHEAR CAMPAIGN COMMITTEE",
            election_year: 2023,
            total_receipts: "1750.00",
            direct_contribution_total: "750.00",
            total_disbursements: null,
            cash_on_hand: null,
            outside_support_total: "10000.00",
            outside_oppose_total: "3000.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "750.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$500-$999",
            amount: "500.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "KENTUCKY FUTURE PROJECT ACTION FUND",
            committee_name: "Kentucky Future Project Action Fund",
            support_oppose: "support",
            amount: "10000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "OPPOSE BESHEAR PAC",
            committee_name: "Oppose Beshear PAC",
            support_oppose: "oppose",
            amount: "3000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "labor_unions",
            amount: "10000.00",
            contributor_count: "1",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "3000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "labor_unions",
            committee_id: "KENTUCKY FUTURE PROJECT ACTION FUND",
            committee_name: "Kentucky Future Project Action Fund",
            support_oppose: "support",
            organization_name: "IBEW Local 369 PAC",
            amount: "10000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "KENTUCKY_KREF",
      cycle: 2023,
      fec_candidate_id: null,
      controlled_committee_id: "BESHEAR CAMPAIGN COMMITTEE",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 750,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 750,
            contributor_count: 2,
            source_url: genericKentuckySourceUrl,
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$500-$999",
            amount: 500,
            contributor_count: 1,
            source_url: genericKentuckySourceUrl,
          },
        ],
      },
      outside_spending: {
        support_total: 10000,
        oppose_total: 3000,
        top_supporting_groups: [
          {
            committee_id: "KENTUCKY FUTURE PROJECT ACTION FUND",
            committee_name: "Kentucky Future Project Action Fund",
            support_oppose: "support",
            amount: 10000,
            source_url: genericKentuckySourceUrl,
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "OPPOSE BESHEAR PAC",
            committee_name: "Oppose Beshear PAC",
            support_oppose: "oppose",
            amount: 3000,
            source_url: genericKentuckySourceUrl,
          },
        ],
        top_supporting_industries: [
          {
            category_name: "labor_unions",
            amount: 10000,
            contributor_count: 1,
            source_url: genericKentuckySourceUrl,
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 3000,
            contributor_count: 1,
            source_url: genericKentuckySourceUrl,
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 750,
            contributor_count: 2,
            source_url: genericKentuckySourceUrl,
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "labor_unions",
            amount: 10000,
            contributor_count: 1,
            source_url: genericKentuckySourceUrl,
            explanation:
              "The Labor unions category is a top outside-spending support industry because IBEW Local 369 PAC contributed to Kentucky Future Project Action Fund, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "IBEW Local 369 PAC",
                organization_type: "donor",
                amount: 10000,
                contributor_count: 1,
                committee_id: "KENTUCKY FUTURE PROJECT ACTION FUND",
                committee_name: "Kentucky Future Project Action Fund",
                source_url: genericKentuckySourceUrl,
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.ky_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ky_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.ky_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.ky_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.ky_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("deduped_evidence AS");
    expect(query.mock.calls[11]?.[0]).toContain(
      "GROUP BY candidate_id, election_id, industry_name, committee_id, support_oppose, organization_name"
    );
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Alaska finance summaries for Alaska candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("ALASKA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "02",
            district_name: "Alaska",
            state: "AK",
            state_fips: "02",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane North",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "AK",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "AK100",
            election_year: 2026,
            total_receipts: "90000.00",
            direct_contribution_total: "75000.00",
            total_disbursements: "20000.00",
            cash_on_hand: "55000.00",
            outside_support_total: "40000.00",
            outside_oppose_total: "5000.00",
            source_url: null,
            last_synced_at: "2026-06-22 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Engineer",
            amount: "15000.00",
            contributor_count: "6",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$500-$999",
            amount: "22000.00",
            contributor_count: "12",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "AKPAC1",
            committee_name: "Alaska Future PAC",
            support_oppose: "support",
            amount: "40000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "AKPAC2",
            committee_name: "No North PAC",
            support_oppose: "oppose",
            amount: "5000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "oil_gas_energy",
            amount: "30000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "5000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "oil_gas_energy",
            committee_id: "AKPAC1",
            committee_name: "Alaska Future PAC",
            support_oppose: "support",
            organization_name: "Northern Energy LLC",
            amount: "25000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "ALASKA_APOC",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "AK100",
      last_synced_at: "2026-06-22 04:05:00+00",
      direct_campaign: {
        total_raised: 75000,
        total_spent: 20000,
        cash_on_hand: 55000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Engineer",
            amount: 15000,
            contributor_count: 6,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$500-$999",
            amount: 22000,
            contributor_count: 12,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
      },
      outside_spending: {
        support_total: 40000,
        oppose_total: 5000,
        top_supporting_groups: [
          {
            committee_id: "AKPAC1",
            committee_name: "Alaska Future PAC",
            support_oppose: "support",
            amount: 40000,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "AKPAC2",
            committee_name: "No North PAC",
            support_oppose: "oppose",
            amount: 5000,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "oil_gas_energy",
            amount: 30000,
            contributor_count: 2,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 5000,
            contributor_count: 1,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Engineer",
            amount: 15000,
            contributor_count: 6,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "oil_gas_energy",
            amount: 30000,
            contributor_count: 2,
            source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
            explanation:
              "The Oil, gas, and energy category is a top outside-spending support industry because Northern Energy LLC contributed to Alaska Future PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Northern Energy LLC",
                organization_type: "donor",
                amount: 25000,
                contributor_count: 1,
                committee_id: "AKPAC1",
                committee_name: "Alaska Future PAC",
                source_url: "https://aws.state.ak.us/ApocReports/Campaign/",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.ak_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ak_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.ak_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.ak_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.ak_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
  });

  it("does not load Alaska finance summaries for unsupported Alaska offices", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("ALASKA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "place",
            geoid_compact: "0203000",
            district_name: "Anchorage",
            state: "AK",
            state_fips: "02",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Mayor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: false,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "local",
            office_canonical_name: "Mayor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane North",
            party: "Nonpartisan",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Mayor",
            state: "AK",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("ak_candidate_finance");
  });

  it("includes locally synced Michigan finance summaries for Michigan candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true");
    const genericMichiganSourceUrl =
      "https://www.michigan.gov/sos/elections/disclosure/cfr/committee-search/intro/welcome-to-the-michigan-campaign-finance-searchable-database";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "26",
            district_name: "Michigan",
            state: "MI",
            state_fips: "26",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Greatlake",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "MI",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "520001",
            election_year: 2026,
            total_receipts: "250000.00",
            direct_contribution_total: "200000.00",
            candidate_loan_total: "45000.00",
            total_disbursements: "90000.00",
            cash_on_hand: "110000.00",
            outside_support_total: "80000.00",
            outside_oppose_total: "12500.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "ATTORNEY",
            amount: "45000.00",
            contributor_count: "12",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "65000.00",
            contributor_count: "14",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "520012",
            committee_name: "Get Michigan Working Again",
            support_oppose: "support",
            amount: "80000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "520099",
            committee_name: "Michigan 24",
            support_oppose: "oppose",
            amount: "12500.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "oil_gas_energy",
            amount: "75000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "12500.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "oil_gas_energy",
            committee_id: "520012",
            committee_name: "Get Michigan Working Again",
            support_oppose: "support",
            organization_name: "Petroplex Energy",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "MICHIGAN_MITN",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "520001",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 200000,
        loans_received: 45000,
        total_spent: 90000,
        cash_on_hand: 110000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 45000,
            contributor_count: 12,
            source_url: genericMichiganSourceUrl,
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 65000,
            contributor_count: 14,
            source_url: genericMichiganSourceUrl,
          },
        ],
      },
      outside_spending: {
        support_total: 80000,
        oppose_total: 12500,
        top_supporting_groups: [
          {
            committee_id: "520012",
            committee_name: "Get Michigan Working Again",
            support_oppose: "support",
            amount: 80000,
            source_url: genericMichiganSourceUrl,
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "520099",
            committee_name: "Michigan 24",
            support_oppose: "oppose",
            amount: 12500,
            source_url: genericMichiganSourceUrl,
          },
        ],
        top_supporting_industries: [
          {
            category_name: "oil_gas_energy",
            amount: 75000,
            contributor_count: 2,
            source_url: genericMichiganSourceUrl,
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 12500,
            contributor_count: 1,
            source_url: genericMichiganSourceUrl,
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "ATTORNEY",
            amount: 45000,
            contributor_count: 12,
            source_url: genericMichiganSourceUrl,
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "oil_gas_energy",
            amount: 75000,
            contributor_count: 2,
            source_url: genericMichiganSourceUrl,
            explanation:
              "The Oil, gas, and energy category is a top outside-spending support industry because Petroplex Energy contributed to Get Michigan Working Again, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Petroplex Energy",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "520012",
                committee_name: "Get Michigan Working Again",
                source_url: genericMichiganSourceUrl,
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.mi_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.mi_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.mi_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.mi_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.mi_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Oregon finance summaries for Oregon candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("OREGON_CAMPAIGN_FINANCE_ENABLED", "true");
    const genericOregonSourceUrl = "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "41",
            district_name: "Oregon",
            state: "OR",
            state_fips: "41",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Cascadia",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "OR",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "4792",
            election_year: 2026,
            total_receipts: "180000.00",
            direct_contribution_total: "150000.00",
            total_disbursements: "70000.00",
            cash_on_hand: "80000.00",
            outside_support_total: "67766.61",
            outside_oppose_total: "0.00",
            source_url: null,
            last_synced_at: "2026-06-21 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "TEACHER",
            amount: "32000.00",
            contributor_count: "18",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$101-$500",
            amount: "45000.00",
            contributor_count: "125",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "ORPAC-22333",
            committee_name: "2022 Our Oregon Voter Guide",
            support_oppose: "support",
            amount: "67766.61",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "labor_unions",
            amount: "60000.00",
            contributor_count: "2",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "labor_unions",
            committee_id: "ORPAC-22333",
            committee_name: "2022 Our Oregon Voter Guide",
            support_oppose: "support",
            organization_name: "SEIU Local 503",
            amount: "50000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "ORESTAR",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "4792",
      last_synced_at: "2026-06-21 04:05:00+00",
      direct_campaign: {
        total_raised: 150000,
        total_spent: 70000,
        cash_on_hand: 80000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "TEACHER",
            amount: 32000,
            contributor_count: 18,
            source_url: genericOregonSourceUrl,
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$101-$500",
            amount: 45000,
            contributor_count: 125,
            source_url: genericOregonSourceUrl,
          },
        ],
      },
      outside_spending: {
        support_total: 67766.61,
        oppose_total: 0,
        top_supporting_groups: [
          {
            committee_id: "ORPAC-22333",
            committee_name: "2022 Our Oregon Voter Guide",
            support_oppose: "support",
            amount: 67766.61,
            source_url: genericOregonSourceUrl,
          },
        ],
        top_opposing_groups: [],
        top_supporting_industries: [
          {
            category_name: "labor_unions",
            amount: 60000,
            contributor_count: 2,
            source_url: genericOregonSourceUrl,
          },
        ],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "TEACHER",
            amount: 32000,
            contributor_count: 18,
            source_url: genericOregonSourceUrl,
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "labor_unions",
            amount: 60000,
            contributor_count: 2,
            source_url: genericOregonSourceUrl,
            explanation:
              "The Labor unions category is a top outside-spending support industry because SEIU Local 503 contributed to 2022 Our Oregon Voter Guide, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "SEIU Local 503",
                organization_type: "donor",
                amount: 50000,
                contributor_count: 1,
                committee_id: "ORPAC-22333",
                committee_name: "2022 Our Oregon Voter Guide",
                source_url: genericOregonSourceUrl,
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    expect(query.mock.calls[7]?.[0]).toContain("public.or_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.or_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.or_candidate_finance_outside_groups");
    expect(query.mock.calls[9]?.[0]).toContain("outside_group.sponsor_id AS committee_id");
    expect(query.mock.calls[10]?.[0]).toContain("public.or_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[10]?.[0]).toContain("breakdown.sponsor_id AS committee_id");
    expect(query.mock.calls[11]?.[0]).toContain("public.or_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("does not query Oregon finance tables when Oregon campaign finance is disabled", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("OREGON_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "41",
            district_name: "Oregon",
            state: "OR",
            state_fips: "41",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Cascadia",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "OR",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query).toHaveBeenCalledTimes(9);
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("or_candidate_finance");
  });

  it("includes locally synced Hawaii finance summaries for Hawaii candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("HAWAII_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "15",
            district_name: "Hawaii",
            state: "HI",
            state_fips: "15",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Aloha",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "HI",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "CC10174",
            election_year: 2022,
            total_receipts: "4070153.38",
            direct_contribution_total: "4070153.38",
            total_disbursements: null,
            cash_on_hand: null,
            outside_support_total: "500557.00",
            outside_oppose_total: "10000.00",
            source_url: "https://hicscdata.hawaii.gov/resource/jexd-xbcg.json",
            last_synced_at: "2026-06-22 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "332962.31",
            contributor_count: "1200",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "150000.00",
            contributor_count: "30",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "NC101",
            committee_name: "Be Change Now",
            support_oppose: "support",
            amount: "500557.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "NC202",
            committee_name: "Hawaii Future PAC",
            support_oppose: "oppose",
            amount: "10000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "construction",
            amount: "2086436.92",
            contributor_count: "1",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "finance_investment",
            amount: "50000.00",
            contributor_count: "2",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "construction",
            committee_id: "NC101",
            committee_name: "Be Change Now",
            support_oppose: "support",
            organization_name: "Hawaii Carpenters Market Recovery Program Fund",
            amount: "2086436.92",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "HAWAII_CSC",
      cycle: 2022,
      fec_candidate_id: null,
      controlled_committee_id: "CC10174",
      last_synced_at: "2026-06-22 04:05:00+00",
      direct_campaign: {
        total_raised: 4070153.38,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 332962.31,
            contributor_count: 1200,
            source_url: "https://hicscdata.hawaii.gov/resource/jexd-xbcg.json",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 150000,
            contributor_count: 30,
            source_url: "https://hicscdata.hawaii.gov/resource/jexd-xbcg.json",
          },
        ],
      },
      outside_spending: {
        support_total: 500557,
        oppose_total: 10000,
        top_supporting_groups: [
          {
            committee_id: "NC101",
            committee_name: "Be Change Now",
            support_oppose: "support",
            amount: 500557,
            source_url: "https://hicscdata.hawaii.gov/",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "NC202",
            committee_name: "Hawaii Future PAC",
            support_oppose: "oppose",
            amount: 10000,
            source_url: "https://hicscdata.hawaii.gov/",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "construction",
            amount: 2086436.92,
            contributor_count: 1,
            source_url: "https://hicscdata.hawaii.gov/",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "finance_investment",
            amount: 50000,
            contributor_count: 2,
            source_url: "https://hicscdata.hawaii.gov/",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 332962.31,
            contributor_count: 1200,
            source_url: "https://hicscdata.hawaii.gov/resource/jexd-xbcg.json",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "construction",
            amount: 2086436.92,
            contributor_count: 1,
            source_url: "https://hicscdata.hawaii.gov/",
            explanation:
              "The Construction category is a top outside-spending support industry because Hawaii Carpenters Market Recovery Program Fund contributed to Be Change Now, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Hawaii Carpenters Market Recovery Program Fund",
                organization_type: "donor",
                amount: 2086436.92,
                contributor_count: 1,
                committee_id: "NC101",
                committee_name: "Be Change Now",
                source_url: "https://hicscdata.hawaii.gov/",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.hi_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.hi_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.hi_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.hi_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.hi_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("max(industry.amount) AS amount");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced D.C. finance summaries for D.C. candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "place",
            geoid_compact: "1150000",
            district_name: "District of Columbia",
            state: "DC",
            state_fips: "11",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Mayor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane District",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Mayor",
            state: "DC",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "JANE DISTRICT FOR MAYOR",
            election_year: 2026,
            total_receipts: "250000.00",
            direct_contribution_total: "250000.00",
            total_disbursements: "90000.00",
            cash_on_hand: "160000.00",
            outside_support_total: "40000.00",
            outside_oppose_total: "5000.00",
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
            last_synced_at: "2026-06-22 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "75000.00",
            contributor_count: "42",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "100000.00",
            contributor_count: "50",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "DC FUTURE IEC",
            committee_name: "DC Future IEC",
            support_oppose: "support",
            amount: "40000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "DC TAXPAYERS IEC",
            committee_name: "DC Taxpayers IEC",
            support_oppose: "oppose",
            amount: "5000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "labor_unions",
            amount: "35000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "5000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "labor_unions",
            committee_id: "DC FUTURE IEC",
            committee_name: "DC Future IEC",
            support_oppose: "support",
            organization_name: "District Workers Union PAC",
            amount: "25000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "DISTRICT_OF_COLUMBIA_OCF",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "JANE DISTRICT FOR MAYOR",
      last_synced_at: "2026-06-22 04:05:00+00",
      direct_campaign: {
        total_raised: 250000,
        total_spent: 90000,
        cash_on_hand: 160000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 75000,
            contributor_count: 42,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 100000,
            contributor_count: 50,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
      },
      outside_spending: {
        support_total: 40000,
        oppose_total: 5000,
        top_supporting_groups: [
          {
            committee_id: "DC FUTURE IEC",
            committee_name: "DC Future IEC",
            support_oppose: "support",
            amount: 40000,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "DC TAXPAYERS IEC",
            committee_name: "DC Taxpayers IEC",
            support_oppose: "oppose",
            amount: 5000,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
        top_supporting_industries: [
          {
            category_name: "labor_unions",
            amount: 35000,
            contributor_count: 2,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 5000,
            contributor_count: 1,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 75000,
            contributor_count: 42,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "labor_unions",
            amount: 35000,
            contributor_count: 2,
            source_url: "https://efiling.ocf.dc.gov/DataDownload",
            explanation:
              "The Labor unions category is a top outside-spending support industry because District Workers Union PAC contributed to DC Future IEC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "District Workers Union PAC",
                organization_type: "donor",
                amount: 25000,
                contributor_count: 1,
                committee_id: "DC FUTURE IEC",
                committee_name: "DC Future IEC",
                source_url: "https://efiling.ocf.dc.gov/DataDownload",
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(14);
    expect(query.mock.calls[7]?.[0]).toContain("public.dc_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.dc_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls[9]?.[0]).toContain("public.dc_candidate_finance_outside_groups");
    expect(query.mock.calls[10]?.[0]).toContain("public.dc_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("public.dc_candidate_finance_outside_group_breakdowns");
    expect(query.mock.calls[11]?.[0]).toContain("top_industries_per_group");
    expect(query.mock.calls[11]?.[0]).toContain("public.finance_label_classifications");
    expect(query.mock.calls[11]?.[0]).toContain("classification.normalized_label");
    expect(query.mock.calls[11]?.[0]).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Maryland finance summaries for Maryland candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MARYLAND_CAMPAIGN_FINANCE_ENABLED", "true");
    const sourceUrl = "https://campaignfinance.maryland.gov/public/cf/downloads";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_upper",
            geoid_compact: "24001",
            district_name: "Maryland Senate District 1",
            state: "MD",
            state_fips: "24",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "State Senator",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "state_upper",
            office_canonical_name: "State Senator",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Justin Gallucci",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "MD",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "16018290",
            election_year: 2026,
            total_receipts: "100000.00",
            direct_contribution_total: "75000.00",
            total_disbursements: "25000.00",
            cash_on_hand: "50000.00",
            outside_support_total: "40000.00",
            outside_oppose_total: "5000.00",
            source_url: sourceUrl,
            last_synced_at: "2026-06-23 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$250-$499",
            amount: "30000.00",
            contributor_count: "100",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "16020184",
            committee_name: "Momentum Maryland PAC",
            support_oppose: "support",
            amount: "40000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "16030001",
            committee_name: "Maryland Taxpayers PAC",
            support_oppose: "oppose",
            amount: "5000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "construction",
            amount: "35000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "5000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "construction",
            committee_id: "16020184",
            committee_name: "Momentum Maryland PAC",
            support_oppose: "support",
            organization_name: "Old Construction Company LLC",
            amount: "30000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "MARYLAND_CFS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "16018290",
      last_synced_at: "2026-06-23 04:05:00+00",
      direct_campaign: {
        total_raised: 75000,
        total_spent: 25000,
        cash_on_hand: 50000,
        debts_owed: null,
        top_occupations: [],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$250-$499",
            amount: 30000,
            contributor_count: 100,
            source_url: sourceUrl,
          },
        ],
      },
      outside_spending: {
        support_total: 40000,
        oppose_total: 5000,
        top_supporting_groups: [
          {
            committee_id: "16020184",
            committee_name: "Momentum Maryland PAC",
            support_oppose: "support",
            amount: 40000,
            source_url: sourceUrl,
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "16030001",
            committee_name: "Maryland Taxpayers PAC",
            support_oppose: "oppose",
            amount: 5000,
            source_url: sourceUrl,
          },
        ],
        top_supporting_industries: [
          {
            category_name: "construction",
            amount: 35000,
            contributor_count: 2,
            source_url: sourceUrl,
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 5000,
            contributor_count: 1,
            source_url: sourceUrl,
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [],
        top_outside_supporting_industries: [
          {
            category_name: "construction",
            amount: 35000,
            contributor_count: 2,
            source_url: sourceUrl,
            explanation:
              "The Construction category is a top outside-spending support industry because Old Construction Company LLC contributed to Momentum Maryland PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Old Construction Company LLC",
                organization_type: "donor",
                amount: 30000,
                contributor_count: 1,
                committee_id: "16020184",
                committee_name: "Momentum Maryland PAC",
                source_url: sourceUrl,
              },
            ],
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(15);
    const marylandQueries = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("public.md_candidate_finance_"));
    expect(marylandQueries.some((sql) => sql.includes("public.md_candidate_finance_summaries"))).toBe(true);
    expect(marylandQueries.some((sql) => sql.includes("public.md_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(
      marylandQueries.some((sql) => sql.includes("breakdown.category_type IN ('occupation', 'contribution_size')"))
    ).toBe(true);
    expect(marylandQueries.some((sql) => sql.includes("public.md_candidate_finance_outside_groups"))).toBe(true);
    expect(marylandQueries.some((sql) => sql.includes("public.md_candidate_finance_outside_group_breakdowns"))).toBe(
      true
    );
    const supportingEvidenceQuery = marylandQueries.find((sql) => sql.includes("top_industries_per_group"));
    expect(supportingEvidenceQuery).toContain("public.finance_label_classifications");
    expect(supportingEvidenceQuery).toContain("classification.normalized_label");
    expect(supportingEvidenceQuery).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Maine finance summaries for Maine candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MAINE_CAMPAIGN_FINANCE_ENABLED", "true");
    const sourceUrl = "https://mainecampaignfinance.com/";
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "state_upper",
            geoid_compact: "23001",
            district_name: "Maine Senate District 1",
            state: "ME",
            state_fips: "23",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "State Senator",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "state_upper",
            office_canonical_name: "State Senator",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Casey Pine",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "ME",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "100123",
            election_year: 2026,
            total_receipts: "90000.00",
            direct_contribution_total: "64000.00",
            total_disbursements: "20000.00",
            cash_on_hand: "44000.00",
            outside_support_total: "35000.00",
            outside_oppose_total: "7000.00",
            source_url: sourceUrl,
            last_synced_at: "2026-06-24 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Teacher",
            amount: "18000.00",
            contributor_count: "36",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$100-$249",
            amount: "22000.00",
            contributor_count: "120",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "200456",
            committee_name: "Maine Forward PAC",
            support_oppose: "support",
            amount: "35000.00",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "200789",
            committee_name: "Maine Accountability PAC",
            support_oppose: "oppose",
            amount: "7000.00",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "education",
            amount: "30000.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "oppose",
            category_name: "real_estate",
            amount: "7000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            industry_name: "education",
            committee_id: "200456",
            committee_name: "Maine Forward PAC",
            support_oppose: "support",
            organization_name: "Maine Teachers Association",
            amount: "25000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "MAINE_CFIS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "100123",
      last_synced_at: "2026-06-24 04:05:00+00",
      direct_campaign: {
        total_raised: 64000,
        total_spent: 20000,
        cash_on_hand: 44000,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Teacher",
            amount: 18000,
            contributor_count: 36,
            source_url: sourceUrl,
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$100-$249",
            amount: 22000,
            contributor_count: 120,
            source_url: sourceUrl,
          },
        ],
      },
      outside_spending: {
        support_total: 35000,
        oppose_total: 7000,
        top_supporting_groups: [
          {
            committee_id: "200456",
            committee_name: "Maine Forward PAC",
            support_oppose: "support",
            amount: 35000,
            source_url: sourceUrl,
          },
        ],
        top_opposing_groups: [
          {
            committee_id: "200789",
            committee_name: "Maine Accountability PAC",
            support_oppose: "oppose",
            amount: 7000,
            source_url: sourceUrl,
          },
        ],
        top_supporting_industries: [
          {
            category_name: "education",
            amount: 30000,
            contributor_count: 2,
            source_url: sourceUrl,
          },
        ],
        top_opposing_industries: [
          {
            category_name: "real_estate",
            amount: 7000,
            contributor_count: 1,
            source_url: sourceUrl,
          },
        ],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Teacher",
            amount: 18000,
            contributor_count: 36,
            source_url: sourceUrl,
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "education",
            amount: 30000,
            contributor_count: 2,
            source_url: sourceUrl,
            explanation:
              "The Education category is a top outside-spending support industry because Maine Teachers Association contributed to Maine Forward PAC, which reported independent spending supporting this candidate.",
            supporting_organizations: [
              {
                organization_name: "Maine Teachers Association",
                organization_type: "donor",
                amount: 25000,
                contributor_count: 1,
                committee_id: "200456",
                committee_name: "Maine Forward PAC",
                source_url: sourceUrl,
              },
            ],
          },
        ],
      },
    });
    const maineQueries = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("public.me_candidate_finance_"));
    expect(maineQueries.some((sql) => sql.includes("public.me_candidate_finance_summaries"))).toBe(true);
    expect(maineQueries.some((sql) => sql.includes("public.me_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(maineQueries.some((sql) => sql.includes("breakdown.category_type IN ('occupation', 'contribution_size')"))).toBe(
      true
    );
    expect(maineQueries.some((sql) => sql.includes("public.me_candidate_finance_outside_groups"))).toBe(true);
    expect(maineQueries.some((sql) => sql.includes("public.me_candidate_finance_outside_group_breakdowns"))).toBe(true);
    const supportingEvidenceQuery = maineQueries.find((sql) => sql.includes("top_industries_per_group"));
    expect(supportingEvidenceQuery).toContain("public.finance_label_classifications");
    expect(supportingEvidenceQuery).toContain("classification.normalized_label");
    expect(supportingEvidenceQuery).not.toContain("classification.raw_label = breakdown.category_name");
  });

  it("includes locally synced Virginia finance summaries for Virginia candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "51",
            district_name: "Virginia",
            state: "VA",
            state_fips: "51",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Commonwealth",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "VA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "CC-25-00001",
            election_year: 2026,
            total_receipts: "210000.00",
            direct_contribution_total: "180000.00",
            source_url: "https://cfreports.elections.virginia.gov/Committee/Index/CC-25-00001",
            last_synced_at: "2026-06-22 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "90000.00",
            contributor_count: "30",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "70000.00",
            contributor_count: "25",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "VIRGINIA_CFREPORTS",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "CC-25-00001",
      last_synced_at: "2026-06-22 04:05:00+00",
      direct_campaign: {
        total_raised: 180000,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 90000,
            contributor_count: 30,
            source_url: "https://cfreports.elections.virginia.gov/Committee/Index/CC-25-00001",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 70000,
            contributor_count: 25,
            source_url: "https://cfreports.elections.virginia.gov/Committee/Index/CC-25-00001",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 90000,
            contributor_count: 30,
            source_url: "https://cfreports.elections.virginia.gov/Committee/Index/CC-25-00001",
          },
        ],
        top_outside_supporting_industries: [],
      },
    });
    expect(query).toHaveBeenCalledTimes(11);
    expect(query.mock.calls[7]?.[0]).toContain("public.va_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.va_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("includes locally synced Utah finance summaries for Utah candidate detail", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("UTAH_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "49",
            district_name: "Utah",
            state: "UT",
            state_fips: "49",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Utahn",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "UT",
            fec_ids: [],
            state_filing_ids: ["ut-folder:98765"],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            folder_id: "98765",
            election_year: 2026,
            total_receipts: "15000.00",
            direct_contribution_total: "12500.00",
            total_disbursements: "4200.00",
            source_url: "https://disclosures.utah.gov/Search/AdvancedSearch/GenerateReport/98765?ReportYear=2026",
            last_synced_at: "2026-06-22 04:05:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$1,000-$4,999",
            amount: "8000.00",
            contributor_count: "3",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            supporting_committee_name: "Utah Builders PAC",
            category_name: "construction",
            amount: "25000.00",
            contributor_count: "2",
            source_url: "https://disclosures.utah.gov/Search/AdvancedSearch/GenerateReport?ReportYear=2026&EntityType=PAC",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "UTAH_DISCLOSURES",
      cycle: 2026,
      fec_candidate_id: null,
      controlled_committee_id: "98765",
      last_synced_at: "2026-06-22 04:05:00+00",
      direct_campaign: {
        total_raised: 12500,
        total_spent: 4200,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$1,000-$4,999",
            amount: 8000,
            contributor_count: 3,
            source_url: "https://disclosures.utah.gov/Search/AdvancedSearch/GenerateReport/98765?ReportYear=2026",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [],
        top_outside_supporting_industries: [],
        top_supporting_committee_industries: [
          {
            supporting_committee_name: "Utah Builders PAC",
            category_name: "construction",
            amount: 25000,
            contributor_count: 2,
            source_url: "https://disclosures.utah.gov/Search/AdvancedSearch/GenerateReport?ReportYear=2026&EntityType=PAC",
          },
        ],
      },
    });
    expect(query).toHaveBeenCalledTimes(12);
    expect(query.mock.calls[7]?.[0]).toContain("public.ut_candidate_finance_summaries");
    expect(query.mock.calls[8]?.[0]).toContain("public.ut_candidate_finance_direct_breakdowns");
    expect(String(query.mock.calls[8]?.[0])).toContain("breakdown.category_type = 'contribution_size'");
    expect(query.mock.calls[9]?.[0]).toContain("public.ut_candidate_finance_supporting_committee_industries");
    expect(query.mock.calls.map((call) => String(call[0])).join("\\n")).not.toContain("public.candidate_finance_summaries");
  });

  it("does not query Utah finance tables when Utah campaign finance is disabled", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("UTAH_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "49",
            district_name: "Utah",
            state: "UT",
            state_fips: "49",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Utahn",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "UT",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("ut_candidate_finance");
  });

  it("does not query Texas finance tables when Texas campaign finance is disabled", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "48",
            district_name: "Texas",
            state: "TX",
            state_fips: "48",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Texan",
            party: "Republican",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "TX",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("tx_candidate_finance");
  });

  it("omits finance summaries without querying finance tables when candidate finance is disabled", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "06",
            district_name: "California",
            state: "CA",
            state_fips: "06",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "U.S. Senate",
            election_date: "2024-11-05",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "us_senate",
            sources: ["https://example.test/elections"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Pat Connolly",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: null,
            state: "CA",
            fec_ids: ["S4CA00001"],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("candidate_finance");
  });

  it("loads full detail for one ballot measure election by election ID", async () => {
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "148.75",
            race_type: "ballot_measure",
            official_ballot_title: "Measure H",
            election_date: "2026-06-02",
            election_stage: null,
            is_partisan: null,
            discovery_contest_family: "ballot_measure",
            sources: ["https://example.test/measure"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            ballot_measure_id: ballotMeasureId,
            official_ballot_title: "Measure H",
            summary: "Funds hospitals.",
            what_yes_means: "Raises the tax.",
            what_no_means: "Keeps current tax rates.",
            result: "passed",
            source_url: ["https://example.test/measure-h"],
            official_measure_url: "https://example.test/measure-h/full-text",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            ballot_measure_id: ballotMeasureId,
            id: "99999999-9999-4999-8999-999999999999",
            pass_type: "certified",
            result_status: "certified",
            outcome: "passed",
            source_url: "https://results.example.test/measure",
            source_type: "official",
            retrieved_at: "2026-07-10 04:10:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            ballot_measure_id: ballotMeasureId,
            research_area_id: researchAreaId,
            slug: "healthcare_affordability",
            name: "Healthcare Affordability",
            stance: "for",
          },
        ],
      })
      // Measure funding: only the support side was written with committees.
      .mockResolvedValueOnce({
        rows: [
          {
            ballot_measure_id: ballotMeasureId,
            side: "oppose",
            total_raised: "0.00",
            committees: [],
            top_donors: [],
            as_of: "2026-05-01",
          },
          {
            ballot_measure_id: ballotMeasureId,
            side: "support",
            total_raised: "1250000.50",
            committees: [
              {
                name: "Yes on H",
                total_raised: 1250000.5,
                from_same_side_committees: 0,
                also_covers_other_measures: true,
                source_url: "https://ethics.example.test/committee/1",
              },
            ],
            top_donors: [{ name: "County Hospital Association", amount: 900000, type: "organization", state: "CA" }],
            as_of: "2026-05-01",
          },
        ],
      })
      // Detail-payload research_areas: the measure's areas as summaries.
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            research_area_id: researchAreaId,
            slug: "healthcare_affordability",
            name: "Healthcare Affordability",
            description: "Cost of care and coverage.",
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, measureElectionId);

    // Committee names stay out of the API: the page shows donors, and the
    // committees' filing pages come through as source_urls.
    expect(result?.ballot_measure?.funding).toEqual({
      as_of: "2026-05-01",
      support: {
        total_raised: 1250000.5,
        shared_with_other_measures_raised: 1250000.5,
        top_donors: [{ name: "County Hospital Association", amount: 900000, type: "organization", state: "CA" }],
        source_urls: ["https://ethics.example.test/committee/1"],
      },
      oppose: { total_raised: 0, shared_with_other_measures_raised: 0, top_donors: [], source_urls: [] },
    });
    expect(result).toMatchObject({
      id: measureElectionId,
      district_id: districtId,
      district: {
        representation_power_score: 100,
      },
      race_type: "ballot_measure",
      official_ballot_title: "Measure H",
      candidates: [],
      results: [],
      ballot_measure: {
        id: ballotMeasureId,
        summary: "Funds hospitals.",
        what_yes_means: "Raises the tax.",
        what_no_means: "Keeps current tax rates.",
        result: "passed",
        source_urls: ["https://example.test/measure-h"],
        official_measure_url: "https://example.test/measure-h/full-text",
        research_area_tags: [{ slug: "healthcare_affordability", stance: "for" }],
        results: [{ outcome: "passed", result_status: "certified" }],
      },
      // No office on a measure election; research_areas carry the measure's
      // tagged areas so the detail page can render them like the list does.
      office: null,
      research_areas: [
        {
          id: researchAreaId,
          slug: "healthcare_affordability",
          name: "Healthcare Affordability",
          description: "Cost of care and coverage.",
        },
      ],
      historical_competitiveness: null,
      vote_power: {
        score: 100,
        label: "high",
        confidence: "high",
        representation_level: "high",
        decisiveness_level: "unknown",
        factors: ["high_representation", "direct_vote_on_policy"],
      },
    });
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls[0]?.[1]).toEqual([measureElectionId]);
    expect(query.mock.calls[6]?.[0]).toContain("public.ballot_measure_funding");
    expect(query.mock.calls[6]?.[1]).toEqual([[ballotMeasureId]]);
    expect(query.mock.calls[7]?.[0]).toContain("public.ballot_measure_research_area_tags");
    expect(query.mock.calls[7]?.[1]).toEqual([[measureElectionId]]);
  });

  it("still serves the measure when the funding read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "06037",
            district_name: "Los Angeles County",
            state: "CA",
            state_fips: "06",
            representation_power_score: "148.75",
            race_type: "ballot_measure",
            official_ballot_title: "Measure H",
            election_date: "2026-06-02",
            election_stage: null,
            is_partisan: null,
            discovery_contest_family: "ballot_measure",
            sources: ["https://example.test/measure"],
            office_canonical_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: measureElectionId,
            ballot_measure_id: ballotMeasureId,
            official_ballot_title: "Measure H",
            summary: "Funds hospitals.",
            what_yes_means: "Raises the tax.",
            what_no_means: "Keeps current tax rates.",
            result: null,
            source_url: [],
            official_measure_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // e.g. the API was deployed before the funding table's migration ran.
      .mockRejectedValueOnce(new Error('relation "public.ballot_measure_funding" does not exist'));

    const result = await lookupElectionDetailById({ query }, measureElectionId);

    expect(result?.ballot_measure).toMatchObject({ id: ballotMeasureId, summary: "Funds hospitals.", funding: null });
    expect(warn).toHaveBeenCalledWith(
      "ballot measure funding failed; continuing without it:",
      expect.objectContaining({ reason: expect.stringContaining("ballot_measure_funding") })
    );
    warn.mockRestore();
  });

  it("does not load Virginia finance summaries for unsupported Virginia offices", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "51059",
            district_name: "Fairfax County",
            state: "VA",
            state_fips: "51",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "county",
            office_canonical_name: "Sheriff",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Commonwealth",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Sheriff",
            state: "VA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("va_candidate_finance");
  });

  it("loads New Jersey ELEC finance summaries for eligible New Jersey offices", async () => {
    vi.stubEnv("NEW_JERSEY_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "statewide",
            geoid_compact: "34",
            district_name: "New Jersey",
            state: "NJ",
            state_fips: "34",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Governor",
            election_date: "2025-11-04",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "statewide",
            office_canonical_name: "Governor",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Mikie Sherrill",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Governor",
            state: "NJ",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "473742",
            election_year: 2025,
            total_receipts: "350.00",
            direct_contribution_total: "350.00",
            total_disbursements: null,
            cash_on_hand: null,
            outside_support_total: "100082.02",
            outside_oppose_total: "0.00",
            source_url: null,
            last_synced_at: "2026-06-25 13:30:00+00",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "occupation",
            category_name: "Attorney",
            amount: "350.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "employer",
            category_name: "Acme Law",
            amount: "350.00",
            contributor_count: "2",
            source_url: null,
          },
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            category_type: "contribution_size",
            category_name: "$250-$499",
            amount: "250.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            committee_id: "477267",
            committee_name: "ONE GIANT LEAP PAC - OGL PAC",
            support_oppose: "support",
            amount: "100082.02",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            support_oppose: "support",
            category_name: "finance_investment",
            amount: "100000.00",
            contributor_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    // Trailing committee-labels lookup (applyFinanceCommitteeLabels):
    // none researched, so the groups stay unlabeled.
    query.mockResolvedValueOnce({ rows: [] });
    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toEqual({
      source: "NEW_JERSEY_ELEC",
      cycle: 2025,
      fec_candidate_id: null,
      controlled_committee_id: "473742",
      last_synced_at: "2026-06-25 13:30:00+00",
      direct_campaign: {
        total_raised: 350,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 350,
            contributor_count: 2,
            source_url: "https://www.njelecefilesearch.com/",
          },
        ],
        top_employers: [
          {
            category_name: "Acme Law",
            amount: 350,
            contributor_count: 2,
            source_url: "https://www.njelecefilesearch.com/",
          },
        ],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$250-$499",
            amount: 250,
            contributor_count: 1,
            source_url: "https://www.njelecefilesearch.com/",
          },
        ],
      },
      outside_spending: {
        support_total: 100082.02,
        oppose_total: 0,
        top_supporting_groups: [
          {
            committee_id: "477267",
            committee_name: "ONE GIANT LEAP PAC - OGL PAC",
            support_oppose: "support",
            amount: 100082.02,
            source_url: "https://www.njelecefilesearch.com/",
          },
        ],
        top_opposing_groups: [],
        top_supporting_industries: [
          {
            category_name: "finance_investment",
            amount: 100000,
            contributor_count: 1,
            source_url: "https://www.njelecefilesearch.com/",
          },
        ],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [
          {
            category_name: "Attorney",
            amount: 350,
            contributor_count: 2,
            source_url: "https://www.njelecefilesearch.com/",
          },
        ],
        top_outside_supporting_industries: [
          {
            category_name: "finance_investment",
            amount: 100000,
            contributor_count: 1,
            source_url: "https://www.njelecefilesearch.com/",
            explanation:
              "The Finance and investment category is a top outside-spending support industry because organizations classified in this industry contributed to outside groups that reported independent spending supporting this candidate.",
            supporting_organizations: [],
          },
        ],
      },
    });
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).toContain("public.nj_candidate_finance_summaries");
  });

  it("does not load Massachusetts finance summaries for unsupported Massachusetts offices", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "25025",
            district_name: "Suffolk County",
            state: "MA",
            state_fips: "25",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "county",
            office_canonical_name: "Sheriff",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Baystate",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Sheriff",
            state: "MA",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("ma_candidate_finance");
  });

  it("does not load Vermont finance summaries for unsupported Vermont offices", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("VERMONT_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "50007",
            district_name: "Chittenden County",
            state: "VT",
            state_fips: "50",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "county",
            office_canonical_name: "Sheriff",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Green Mountain",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Sheriff",
            state: "VT",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("vt_candidate_finance");
  });

  it("does not load Wisconsin finance summaries for unsupported Wisconsin offices", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    vi.stubEnv("WISCONSIN_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            district_id: districtId,
            district_type: "county",
            geoid_compact: "55025",
            district_name: "Dane County",
            state: "WI",
            state_fips: "55",
            representation_power_score: "80",
            race_type: "office",
            official_ballot_title: "Sheriff",
            election_date: "2026-11-03",
            election_stage: "general",
            is_partisan: true,
            discovery_contest_family: "non_judicial_office",
            sources: ["https://example.test/elections"],
            office_scope: "county",
            office_canonical_name: "Sheriff",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            election_id: officeElectionId,
            candidate_election_id: candidateElectionId,
            candidate_id: candidateId,
            display_name: "Jane Badger",
            party: "Democratic",
            is_incumbent: false,
            status: "declared",
            summary: "Candidate summary.",
            current_office: "Sheriff",
            state: "WI",
            fec_ids: [],
            state_filing_ids: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupElectionDetailById({ query }, officeElectionId);

    expect(result?.candidates[0]?.finance_summary).toBeNull();
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("wi_candidate_finance");
  });
});

describe("lookupCandidateElectionFinanceSummaryById", () => {
  it("returns null without querying for empty IDs", async () => {
    const query = vi.fn();

    await expect(lookupCandidateElectionFinanceSummaryById({ query }, "   ", candidateId)).resolves.toBeNull();
    await expect(lookupCandidateElectionFinanceSummaryById({ query }, officeElectionId, "")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns null without a candidate query when the election does not exist", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await expect(lookupCandidateElectionFinanceSummaryById({ query }, officeElectionId, candidateId)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns null when the candidate is not in the election", async () => {
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [senateElectionRowForFinance()] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(lookupCandidateElectionFinanceSummaryById({ query }, officeElectionId, candidateId)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([officeElectionId, candidateId]);
    // The candidate filter and identity guards live only in this SQL —
    // the ordered mocks return rows unconditionally, so pin the query text.
    // deleted_at and merged_into mirror the profile reader's guards: this
    // endpoint must 404 whenever the candidate profile itself does.
    const candidateSql = String(query.mock.calls[1]?.[0]);
    expect(candidateSql).toContain("ce.candidate_id = $2::uuid");
    expect(candidateSql).toContain("c.deleted_at IS NULL");
    expect(candidateSql).toContain("c.merged_into_candidate_id IS NULL");
  });

  it("returns a null summary without finance queries when finance is disabled", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "false");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [senateElectionRowForFinance()] })
      .mockResolvedValueOnce({ rows: [senateCandidateRowForFinance()] });

    const result = await lookupCandidateElectionFinanceSummaryById({ query }, officeElectionId, candidateId);

    expect(result).toEqual({ finance_summary: null });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns the FEC finance summary for a single candidate/election pair", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [senateElectionRowForFinance()] })
      .mockResolvedValueOnce({ rows: [senateCandidateRowForFinance()] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: candidateId,
            election_id: officeElectionId,
            fec_candidate_id: "S4CA00001",
            election_year: 2024,
            total_receipts: "1000.50",
            total_disbursements: "700.25",
            cash_on_hand: "300.00",
            debts_owed: "10.00",
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: "https://www.fec.gov/data/candidate/S4CA00001/?cycle=2024",
            last_synced_at: "2026-01-02 03:04:05+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupCandidateElectionFinanceSummaryById({ query }, officeElectionId, candidateId);

    expect(result?.finance_summary).toMatchObject({
      source: "FEC",
      cycle: 2024,
      fec_candidate_id: "S4CA00001",
      last_synced_at: "2026-01-02 03:04:05+00",
      direct_campaign: {
        total_raised: 1000.5,
        total_spent: 700.25,
        cash_on_hand: 300,
        debts_owed: 10,
      },
    });
    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls[1]?.[1]).toEqual([officeElectionId, candidateId]);
    expect(query.mock.calls[2]?.[0]).toContain("public.candidate_finance_summaries");
  });

  it("finds the summary for uppercase request UUIDs by keying on the DB row ids", async () => {
    // isUuid accepts uppercase hex and Postgres uuid casts match it, but the
    // finance maps are keyed on the lowercase ids the database returns — the
    // final lookup must use the row values, not the request strings. The ids
    // must contain hex letters (the shared numeric-only fixtures are
    // case-insensitive by accident).
    const letterElectionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const letterCandidateId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      // Terminal default: the trailing current_race_ratings lookup (empty = no
      // current rating; ordered Once mocks below are consumed first).
      .mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...senateElectionRowForFinance(), election_id: letterElectionId }] })
      .mockResolvedValueOnce({
        rows: [{ election_id: letterElectionId, candidate_id: letterCandidateId, fec_ids: ["S4CA00001"] }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: letterCandidateId,
            election_id: letterElectionId,
            fec_candidate_id: "S4CA00001",
            election_year: 2024,
            total_receipts: "1000.50",
            total_disbursements: "700.25",
            cash_on_hand: "300.00",
            debts_owed: "10.00",
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: "https://www.fec.gov/data/candidate/S4CA00001/?cycle=2024",
            last_synced_at: "2026-01-02 03:04:05+00",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await lookupCandidateElectionFinanceSummaryById(
      { query },
      letterElectionId.toUpperCase(),
      letterCandidateId.toUpperCase()
    );

    expect(result?.finance_summary).toMatchObject({ source: "FEC", cycle: 2024 });
  });
});

function senateElectionRowForFinance() {
  return {
    election_id: officeElectionId,
    district_id: districtId,
    district_type: "statewide",
    geoid_compact: "06",
    district_name: "California",
    state: "CA",
    state_fips: "06",
    representation_power_score: "80",
    race_type: "office",
    official_ballot_title: "U.S. Senate",
    election_date: "2024-11-05",
    election_stage: "general",
    is_partisan: true,
    discovery_contest_family: "us_senate",
    sources: ["https://example.test/elections"],
    office_canonical_name: null,
  };
}

// Mirrors the finance lookup's candidate projection: only the columns the
// finance sources read (candidate_id/election_id/fec_ids).
function senateCandidateRowForFinance() {
  return {
    election_id: officeElectionId,
    candidate_id: candidateId,
    fec_ids: ["S4CA00001"],
  };
}

// Current-cycle rating read path: dispatch-style mocks (keyed on the queried
// table, so they survive loader reordering). Dates are computed from the real
// clock because currentRaceRatingOverridesHistory runs on it.
describe("current race rating read path", () => {
  const ratedDistrictId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ratedElectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ratedOfficeId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  function isoDaysFromNow(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  }
  const electionDate = isoDaysFromNow(60);
  const asOf = isoDaysFromNow(-1);

  function summaryElectionRow(overrides: Record<string, unknown> = {}) {
    return {
      election_id: ratedElectionId,
      district_id: ratedDistrictId,
      district_type: "us_house",
      geoid_compact: "0631",
      district_name: "California's 31st Congressional District",
      state: "CA",
      state_fips: "06",
      representation_power_score: "72.5",
      race_type: "office",
      official_ballot_title: "United States Representative District 31",
      election_date: electionDate,
      election_stage: "general",
      is_partisan: true,
      discovery_contest_family: "us_house",
      sources: ["https://example.test/elections"],
      office_id: ratedOfficeId,
      office_scope: "us_house",
      office_canonical_name: "United States Representative",
      office_summary: "Federal lower-chamber legislator.",
      ...overrides,
    };
  }

  function marginRow() {
    return {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      lookup_id: ratedElectionId,
      source: "MIT_2024",
      source_url: "https://github.com/MEDSL/2024-elections-official",
      election_year: 2024,
      state: "CA",
      state_fips: "06",
      office_type: "US_HOUSE",
      district_type: "us_house",
      district_key: "0631",
      mit_office: "US HOUSE",
      mit_district: "031",
      winner_party: "DEMOCRAT",
      runner_up_party: "REPUBLICAN",
      winner_votes: "109200",
      runner_up_votes: "90800",
      total_votes: "200000",
      margin_percent: "9.20",
      competitiveness_label: "competitive",
      stale_after_redistricting: false,
      imported_at: "2026-06-14 12:00:00+00",
    };
  }

  function ratingRow(overrides: Record<string, unknown> = {}) {
    return {
      election_id: ratedElectionId,
      election_date: electionDate,
      competitiveness_label: "toss_up",
      method: "outlet_consensus",
      confidence: "high",
      evidence_status: "rated",
      as_of: asOf,
      decisive_round: null,
      evidence: {
        mean_intensity: 0,
        observations: [
          {
            outlet: "inside_elections",
            raw_rating: "Toss-up",
            favored: "none",
            intensity: 0,
            as_of: asOf,
            url: "https://insideelections.com/ratings/house",
          },
          {
            outlet: "sabato",
            raw_rating: "Toss-up",
            favored: "none",
            intensity: 0,
            as_of: asOf,
            url: "https://centerforpolitics.org/crystalball/2026-house",
          },
        ],
      },
      source_url: "https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_elections",
      researched_on: isoDaysFromNow(-1),
      ...overrides,
    };
  }

  function summaryQueryMock(options: { rating: Record<string, unknown> | null; candidateCount?: number }) {
    return vi.fn().mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("public.current_race_ratings")) {
        return Promise.resolve({ rows: options.rating ? [options.rating] : [] });
      }
      if (text.includes("public.historical_contest_margins")) {
        return Promise.resolve({ rows: [marginRow()] });
      }
      if (text.includes("candidate_count")) {
        return Promise.resolve({
          rows: [{ election_id: ratedElectionId, candidate_count: options.candidateCount ?? 2 }],
        });
      }
      if (text.includes("FROM public.elections")) {
        return Promise.resolve({ rows: [summaryElectionRow()] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it("prefers a fresh, confident current rating over historic margins and attaches both payloads", async () => {
    const query = summaryQueryMock({ rating: ratingRow() });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [ratedDistrictId]);
    const election = result.elections[0]!;

    expect(election.current_competitiveness).toEqual({
      display_label: "Currently a toss-up",
      display_description: expect.stringContaining("Inside Elections and University of Virginia's Sabato's Crystal Ball"),
      competitiveness_label: "toss_up",
      method: "outlet_consensus",
      confidence: "high",
      as_of: asOf,
    });
    // The historic chip data stays available for fallback rendering...
    expect(election.historical_competitiveness?.competitiveness_label).toBe("competitive");
    // ...but decisiveness graded on the current toss_up (historic competitive
    // would grade "medium").
    expect(election.vote_power.decisiveness_level).toBe("high");
    // 100 × (0.45 × 0.725 + 0.55 × 1.0) = 87.625 → 88; the historic
    // competitive label alone would score 68. Ballot ordering sorts on this
    // score (ballotElectionOrdering), so the upgrade reorders with no
    // further code.
    expect(election.vote_power.score).toBe(88);
  });

  it("labels very_competitive and competitive ratings with distinct chip text", async () => {
    // The two labels grade different decisiveness levels (high vs medium),
    // so their chips must not read identically.
    const veryCompetitive = await lookupBallotSummariesByDistrictIds(
      { query: summaryQueryMock({ rating: ratingRow({ competitiveness_label: "very_competitive" }) }) },
      [ratedDistrictId]
    );
    expect(veryCompetitive.elections[0]!.current_competitiveness?.display_label).toBe("Currently very competitive");
    expect(veryCompetitive.elections[0]!.vote_power.decisiveness_level).toBe("high");

    const competitive = await lookupBallotSummariesByDistrictIds(
      { query: summaryQueryMock({ rating: ratingRow({ competitiveness_label: "competitive" }) }) },
      [ratedDistrictId]
    );
    expect(competitive.elections[0]!.current_competitiveness?.display_label).toBe("Currently competitive");
    expect(competitive.elections[0]!.vote_power.decisiveness_level).toBe("medium");
  });

  it("falls back to historic margins when the stored row is none_found", async () => {
    // The DC delegate race can only ever store none_found rows, so this is
    // also the DC-untouched case.
    const query = summaryQueryMock({
      rating: ratingRow({ competitiveness_label: null, confidence: null, as_of: null, evidence_status: "none_found" }),
    });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [ratedDistrictId]);
    const election = result.elections[0]!;

    expect(election.current_competitiveness).toBeNull();
    expect(election.vote_power.decisiveness_level).toBe("medium");
  });

  it("falls back to historic margins when the current rating is stale", async () => {
    // -62, not -61: freshness runs on the latest US local date (Honolulu),
    // which lags this helper's UTC arithmetic by a day for part of each day.
    const query = summaryQueryMock({ rating: ratingRow({ as_of: isoDaysFromNow(-62) }) });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [ratedDistrictId]);
    const election = result.elections[0]!;

    expect(election.current_competitiveness).toBeNull();
    expect(election.vote_power.decisiveness_level).toBe("medium");
  });

  it("suppresses the current rating entirely on uncontested races", async () => {
    const query = summaryQueryMock({ rating: ratingRow(), candidateCount: 1 });

    const result = await lookupBallotSummariesByDistrictIds({ query }, [ratedDistrictId]);
    const election = result.elections[0]!;

    // One candidate grades decisiveness "none" whatever the label, so the
    // rating did not drive the grade — and the payload contract says the
    // field exists only when it did. A "Currently a toss-up" chip beside an
    // unopposed race would contradict the uncontested grade.
    expect(election.current_competitiveness).toBeNull();
    expect(election.vote_power.decisiveness_level).toBe("none");
  });

  it("keeps the current rating through election day on the latest US clock, not UTC", async () => {
    // 05:00 UTC on Nov 4 is still 19:00 Nov 3 in Hawaii — polls open. The
    // UTC calendar date would call the election past and silently fall back
    // to historic margins mid-election-day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-04T05:00:00.000Z"));
      const stillVoting = await lookupBallotSummariesByDistrictIds(
        {
          query: summaryQueryMock({
            rating: ratingRow({ election_date: "2026-11-03", as_of: "2026-11-01" }),
          }),
        },
        [ratedDistrictId]
      );
      expect(stillVoting.elections[0]!.current_competitiveness?.display_label).toBe("Currently a toss-up");
      expect(stillVoting.elections[0]!.vote_power.decisiveness_level).toBe("high");

      // Once the whole US has left Nov 3 (11:00 UTC = 01:00 Nov 4 in
      // Hawaii), the election is genuinely past and historic data resumes.
      vi.setSystemTime(new Date("2026-11-04T11:00:00.000Z"));
      const past = await lookupBallotSummariesByDistrictIds(
        {
          query: summaryQueryMock({
            rating: ratingRow({ election_date: "2026-11-03", as_of: "2026-11-01" }),
          }),
        },
        [ratedDistrictId]
      );
      expect(past.elections[0]!.current_competitiveness).toBeNull();
      expect(past.elections[0]!.vote_power.decisiveness_level).toBe("medium");
    } finally {
      vi.useRealTimers();
    }
  });

  it("swaps the detail explanation to rating copy when the current rating drives the label", async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("public.current_race_ratings")) {
        return Promise.resolve({ rows: [ratingRow()] });
      }
      if (text.includes("public.historical_contest_margins")) {
        return Promise.resolve({ rows: [marginRow()] });
      }
      if (text.includes("public.candidate_elections")) {
        return Promise.resolve({
          rows: [
            {
              election_id: ratedElectionId,
              candidate_election_id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
              candidate_id: "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2",
              display_name: "Alex Incumbent",
              party: "Democratic",
              is_incumbent: true,
              status: "declared",
              summary: null,
              current_office: null,
              state: "CA",
              fec_ids: [],
              state_filing_ids: [],
            },
            {
              election_id: ratedElectionId,
              candidate_election_id: "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3",
              candidate_id: "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4",
              display_name: "Sam Challenger",
              party: "Republican",
              is_incumbent: false,
              status: "declared",
              summary: null,
              current_office: null,
              state: "CA",
              fec_ids: [],
              state_filing_ids: [],
            },
          ],
        });
      }
      if (text.includes("FROM public.elections")) {
        return Promise.resolve({ rows: [summaryElectionRow()] });
      }
      return Promise.resolve({ rows: [] });
    });

    const detail = await lookupElectionDetailById({ query }, ratedElectionId);

    expect(detail?.current_competitiveness?.display_label).toBe("Currently a toss-up");
    expect(detail?.vote_power.decisiveness_level).toBe("high");
    const decisiveness = detail?.vote_power.explanation.parts.find((part) => part.title === "Decisiveness");
    expect(decisiveness?.stat).toContain("rated toss-up as of");
    // Historic margin numbers must not caption a rating-sourced grade.
    expect(decisiveness?.stat).not.toContain("margin");
    expect(decisiveness?.formula).toContain('IE "Toss-up" (d=0) + Sabato "Toss-up" (d=0) → mean 0 → "toss-up"');
    // The "how" copy is static now (names both sources); the part row carries
    // which one drove this rating.
    expect(detail?.vote_power.explanation.how).toContain("past results or current analyst ratings");
    // Both payload objects ride along, mirroring the summary list.
    expect(detail?.historical_competitiveness?.competitiveness_label).toBe("competitive");
  });
});
