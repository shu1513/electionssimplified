import { describe, expect, it } from "vitest";

import {
  toDemoBallotSummary,
  toDemoBrowseDistrict,
  toDemoCandidateDetail,
  toDemoElectionChoice,
  toDemoElectionDetail,
} from "../../src/api/demoView.js";

// The demo date is 2026-11-02: the November 3 general is still ahead, the
// June primary is over.
const GENERAL = "2026-11-03";
const PRIMARY = "2026-06-02";

describe("toDemoBallotSummary", () => {
  const summary = (electionDate: string) =>
    ({
      district_ids: ["d1"],
      districts: [],
      elections: [
        {
          id: "e1",
          election_date: electionDate,
          has_results: true,
          current_result_outcome: "won",
          current_result_winners: [{ candidate_name: "Ada Winner" }],
          preview: {
            seats_to_fill: 1,
            measure: null,
            candidates: [
              { candidate_id: "c1", status: "won" },
              { candidate_id: "c2", status: "lost" },
              { candidate_id: "c3", status: "withdrawn" },
            ],
          },
        },
      ],
    }) as never;

  it("hides the result of an election that is still ahead on the demo date", () => {
    const [election] = toDemoBallotSummary(summary(GENERAL)).elections;
    expect(election.has_results).toBe(false);
    expect(election.current_result_outcome).toBeNull();
    expect(election.current_result_winners).toEqual([]);
    expect(election.preview?.candidates.map((candidate) => candidate.status)).toEqual([
      "declared",
      "declared",
      "withdrawn",
    ]);
  });

  it("keeps the result of an election already held on the demo date", () => {
    const input = summary(PRIMARY);
    expect(toDemoBallotSummary(input)).toEqual(input);
  });

  it("covers election day itself and leaves preview-less rows preview-less", () => {
    const input = {
      district_ids: [],
      districts: [],
      elections: [{ id: "e1", election_date: "2026-11-02", has_results: true, current_result_outcome: "won", current_result_winners: [] }],
    } as never;
    const [election] = toDemoBallotSummary(input).elections;
    expect(election.has_results).toBe(false);
    expect("preview" in election).toBe(false);
  });

  it("does not change its input", () => {
    const input = summary(GENERAL);
    const before = JSON.stringify(input);
    toDemoBallotSummary(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("toDemoElectionDetail", () => {
  const detail = (electionDate: string) =>
    ({
      id: "e1",
      election_date: electionDate,
      results: [{ id: "r1", outcome: "won" }],
      ballot_measure: { id: "m1", result: "passed", results: [{ id: "mr1", outcome: "passed" }] },
      candidates: [
        {
          candidate_id: "c1",
          status: "advanced",
          records: [
            { id: "old", event_date: "2026-11-02" },
            { id: "new", event_date: "2026-11-04" },
          ],
        },
      ],
    }) as never;

  it("removes results, measure outcome, result statuses and later records", () => {
    const election = toDemoElectionDetail(detail(GENERAL));
    expect(election.results).toEqual([]);
    expect(election.ballot_measure).toMatchObject({ id: "m1", result: null, results: [] });
    expect(election.candidates[0].status).toBe("declared");
    expect(election.candidates[0].records.map((record) => record.id)).toEqual(["old"]);
  });

  it("keeps a held election's results but still drops later records", () => {
    const election = toDemoElectionDetail(detail(PRIMARY));
    expect(election.results).toHaveLength(1);
    expect(election.ballot_measure?.result).toBe("passed");
    expect(election.candidates[0].status).toBe("advanced");
    expect(election.candidates[0].records.map((record) => record.id)).toEqual(["old"]);
  });

  it("handles an office race with no measure", () => {
    const input = { ...(detail(GENERAL) as object), ballot_measure: null } as never;
    expect(toDemoElectionDetail(input).ballot_measure).toBeNull();
  });
});

describe("toDemoCandidateDetail", () => {
  it("resets result statuses per election and drops later records", () => {
    const result = toDemoCandidateDetail({
      candidate: {
        candidate_id: "c1",
        records: [
          { id: "old", event_date: "2026-10-30" },
          { id: "new", event_date: "2027-01-05" },
        ],
        elections: [
          { election_id: "general", election_date: GENERAL, status: "lost" },
          { election_id: "primary", election_date: PRIMARY, status: "advanced" },
        ],
      },
    } as never);
    expect(result.candidate.records.map((record) => record.id)).toEqual(["old"]);
    expect(result.candidate.elections.map((election) => election.status)).toEqual(["declared", "advanced"]);
    expect(result.candidate.candidate_id).toBe("c1");
  });
});

describe("toDemoBrowseDistrict", () => {
  it("resets result statuses only for elections still ahead", () => {
    const result = toDemoBrowseDistrict({
      district: { id: "d1" },
      elections: [
        { id: "general", election_date: GENERAL, candidates: [{ candidate_id: "c1", status: "won" }] },
        { id: "primary", election_date: PRIMARY, candidates: [{ candidate_id: "c1", status: "advanced" }] },
      ],
    } as never);
    expect(result.elections.map((election) => election.candidates[0].status)).toEqual(["declared", "advanced"]);
  });
});

describe("toDemoElectionChoice", () => {
  const choice = (electionDate: string) =>
    ({
      election_id: "e1",
      election_date: electionDate,
      picks: [
        { candidate_id: "c1", candidacy_status: "won" },
        { candidate_id: "c2", candidacy_status: "withdrawn" },
      ],
      measure_position: "yes",
      measure_result: "passed",
      current_result_outcome: "won",
      current_result_winners: [{ candidate_name: "Ada Winner" }],
    }) as never;

  it("hides how a pick turned out when its election is still ahead", () => {
    const result = toDemoElectionChoice(choice(GENERAL));
    expect(result.picks.map((pick) => pick.candidacy_status)).toEqual(["declared", "withdrawn"]);
    expect(result).toMatchObject({ measure_position: "yes", measure_result: null, current_result_outcome: null, current_result_winners: [] });
  });

  it("leaves a pick in an election already held as it is", () => {
    const input = choice(PRIMARY);
    expect(toDemoElectionChoice(input)).toBe(input);
  });
});
