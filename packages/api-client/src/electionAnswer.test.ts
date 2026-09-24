import { describe, expect, it } from "vitest";
import { electionAnswerSnippet, electionAnswerText, type ElectionAnswerInput } from "./electionAnswer";

const TODAY = "2026-09-24";

function race(overrides: Partial<ElectionAnswerInput> = {}): ElectionAnswerInput {
  return {
    race_type: "office",
    official_ballot_title: "Governor",
    district: { name: "Kentucky" },
    election_date: "2026-11-03",
    election_stage: "general",
    seats_to_fill: null,
    candidates: [
      { display_name: "Jordan Voter", party: "Democratic", is_incumbent: false, status: "declared" },
      { display_name: "Riley Runner", party: "Republican", is_incumbent: true, status: "declared" },
      { display_name: "Pat Quit", party: "Independent", is_incumbent: false, status: "withdrawn" },
    ],
    ballot_measure: null,
    results: [],
    vote_power: { label: "high" },
    ...overrides,
  };
}

describe("electionAnswerText", () => {
  it("states the race, place, date, roster with parties, incumbent, and vote power in plain sentences", () => {
    expect(electionAnswerText(race(), TODAY)).toBe(
      "The Governor general election in Kentucky is on November 3, 2026. " +
        "2 candidates are running: Jordan Voter (Democratic) and Riley Runner (Republican). " +
        "Riley Runner is the incumbent. " +
        "One vote here carries high weight compared with other races."
    );
  });

  it("switches to past tense and names the winner once a result exists", () => {
    const text = electionAnswerText(
      race({
        election_date: "2024-11-05",
        results: [{ outcome: "won", result_status: "certified", winners: [{ candidate_name: "Riley Runner", party: "Republican" }] }],
      }),
      TODAY
    );
    expect(text).toContain("The Governor general election in Kentucky was held on November 5, 2024.");
    expect(text).toContain("Certified result: the winner is Riley Runner (Republican).");
  });

  it("calls a one-candidate, one-seat race uncontested and a roster that fits the seats all winners", () => {
    const solo = race({ candidates: [{ display_name: "Jordan Voter", party: "Democratic", is_incumbent: false, status: "declared" }] });
    expect(electionAnswerText(solo, TODAY)).toContain("One candidate is on the ballot, Jordan Voter (Democratic), so the race is uncontested.");

    const fits = race({
      seats_to_fill: 3,
      candidates: [
        { display_name: "A One", party: "Nonpartisan", is_incumbent: false, status: "declared" },
        { display_name: "B Two", party: "Nonpartisan", is_incumbent: false, status: "declared" },
        { display_name: "C Three", party: "Nonpartisan", is_incumbent: false, status: "declared" },
      ],
    });
    expect(electionAnswerText(fits, TODAY)).toContain("3 candidates are running for 3 seats, A One, B Two, and C Three, so every candidate wins a seat.");
  });

  it("describes a ballot measure with its summary and outcome, and never mentions candidates", () => {
    const measure = race({
      race_type: "ballot_measure",
      official_ballot_title: "Proposition 1",
      election_stage: null,
      candidates: [],
      ballot_measure: { summary: "Adds a two percent sales tax for road repair.", result: "passed" },
      election_date: "2024-11-05",
      vote_power: { label: "medium" },
    });
    expect(electionAnswerText(measure, TODAY)).toBe(
      "Proposition 1 was a ballot measure in Kentucky on the November 5, 2024 ballot. Adds a two percent sales tax for road repair. It passed."
    );
  });

  it("phrases a retention race as a yes-or-no question on the judge", () => {
    const retention = race({
      official_ballot_title: "Shall Judge Alex Bench be retained in office?",
      candidates: [{ display_name: "Alex Bench", party: "Nonpartisan", is_incumbent: true, status: "declared" }],
      vote_power: { label: "retention" },
    });
    expect(electionAnswerText(retention, TODAY)).toContain("Voters decide yes or no on keeping Alex Bench in office.");
    expect(electionAnswerText(retention, TODAY)).not.toContain("uncontested");
    expect(electionAnswerText(retention, TODAY)).not.toContain("weight");
  });

  it("says nothing about the roster when no candidates are known yet", () => {
    expect(electionAnswerText(race({ candidates: [], vote_power: { label: "unknown" } }), TODAY)).toBe(
      "The Governor general election in Kentucky is on November 3, 2026."
    );
  });
});

describe("electionAnswerSnippet", () => {
  it("keeps whole leading sentences within the length cap", () => {
    // Two sentences fit (151 chars); the incumbent sentence would push past the cap.
    const snippet = electionAnswerSnippet(race(), TODAY, 160);
    expect(snippet).toBe(
      "The Governor general election in Kentucky is on November 3, 2026. 2 candidates are running: Jordan Voter (Democratic) and Riley Runner (Republican)."
    );
  });

  it("never cuts a sentence in half, even when the first one alone is over the cap", () => {
    expect(electionAnswerSnippet(race(), TODAY, 10)).toBe("The Governor general election in Kentucky is on November 3, 2026.");
  });

  it("keeps decimals and abbreviations inside a sentence intact", () => {
    const measure = race({
      race_type: "ballot_measure",
      official_ballot_title: "Parks Bond",
      candidates: [],
      ballot_measure: { summary: "Borrows $6.5 million to fix parks in St. Louis.", result: null },
    });
    expect(electionAnswerSnippet(measure, TODAY)).toBe(
      "Parks Bond is a ballot measure in Kentucky on the November 3, 2026 ballot. Borrows $6.5 million to fix parks in St. Louis."
    );
  });
});
