import { describe, expect, it } from "vitest";
import { candidateAnswerSnippet, candidateAnswerText, type CandidateAnswerElection, type CandidateAnswerInput } from "./candidateAnswer";

const TODAY = "2026-09-28";

function election(overrides: Partial<CandidateAnswerElection> = {}): CandidateAnswerElection {
  return {
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    district: { name: "Kentucky" },
    is_incumbent: false,
    status: "declared",
    ...overrides,
  };
}

function person(overrides: Partial<CandidateAnswerInput> = {}): CandidateAnswerInput {
  return {
    display_name: "Jordan Voter",
    party: "Democratic",
    state: "KY",
    current_office: null,
    summary: "Jordan Voter is a Lexington city council member and former teacher.",
    records: [{}, {}, {}],
    records_researched_through: "2026-09-01",
    elections: [election()],
    ...overrides,
  };
}

describe("candidateAnswerText", () => {
  it("states the race, the summary, and the record count in plain sentences", () => {
    expect(candidateAnswerText(person(), TODAY)).toBe(
      "Jordan Voter (Democratic) is running for Governor in Kentucky in the November 3, 2026 election. " +
        "Jordan Voter is a Lexington city council member and former teacher. " +
        "3 public records with sources, researched through September 1, 2026, are listed below."
    );
  });

  it("names the office held now ahead of the incumbent flag", () => {
    expect(candidateAnswerText(person({ current_office: "State Senator" }), TODAY)).toContain(
      "Jordan Voter currently serves as State Senator."
    );
    const incumbent = person({ elections: [election({ is_incumbent: true })] });
    expect(candidateAnswerText(incumbent, TODAY)).toContain("Jordan Voter is the incumbent.");
    expect(candidateAnswerText(incumbent, TODAY)).not.toContain("currently serves");
  });

  it("lists every race the candidate is in at once", () => {
    const two = person({
      elections: [election(), election({ official_ballot_title: "City Council At-Large", district: { name: "Lexington, Kentucky" } })],
    });
    expect(candidateAnswerText(two, TODAY)).toContain(
      "is running for Governor in Kentucky (November 3, 2026) and City Council At-Large in Lexington, Kentucky (November 3, 2026)."
    );
  });

  it("does not repeat the place when the ballot title already names it", () => {
    const titled = person({
      elections: [election({ official_ballot_title: "State's Attorney, Carroll County", district: { name: "Carroll County, Maryland" } })],
    });
    expect(candidateAnswerText(titled, TODAY)).toContain(
      "Jordan Voter (Democratic) is running for State's Attorney, Carroll County in the November 3, 2026 election."
    );
  });

  it("switches to past tense after the election and skips withdrawn candidacies", () => {
    expect(candidateAnswerText(person({ elections: [election({ election_date: "2024-11-05" })] }), TODAY)).toContain(
      "Jordan Voter (Democratic) ran for Governor in Kentucky in the November 5, 2024 election."
    );
    const withdrew = person({ elections: [election({ status: "withdrawn" })] });
    expect(candidateAnswerText(withdrew, TODAY)).toContain(
      "Jordan Voter (Democratic) is no longer on the ballot for Governor in Kentucky (November 3, 2026)."
    );
    // A live candidacy beats an exited one in the same cycle.
    const mixed = person({ elections: [election({ status: "withdrawn", official_ballot_title: "Mayor" }), election()] });
    expect(candidateAnswerText(mixed, TODAY)).toContain("is running for Governor in Kentucky");
    expect(candidateAnswerText(mixed, TODAY)).not.toContain("Mayor");
  });

  it("falls back to party and state when no race is known, and hides placeholder parties", () => {
    expect(candidateAnswerText(person({ elections: [] }), TODAY)).toContain("Jordan Voter is a Democratic candidate in KY.");
    expect(candidateAnswerText(person({ elections: [], party: "Nonpartisan" }), TODAY)).toContain("Jordan Voter is a candidate in KY.");
    expect(candidateAnswerText(person({ party: "Unknown" }), TODAY)).toContain("Jordan Voter is running for Governor");
  });

  it("says no records were found only once a records search has run", () => {
    expect(candidateAnswerText(person({ records: [] }), TODAY)).toContain(
      "No verified public records were found for this candidate through September 1, 2026."
    );
    expect(candidateAnswerText(person({ records: [], records_researched_through: null }), TODAY)).not.toContain("records");
    expect(candidateAnswerText(person({ records: [{}] }), TODAY)).toContain("1 public record with sources, researched through September 1, 2026, is listed below.");
  });

  it("skips a missing summary without leaving a gap", () => {
    expect(candidateAnswerText(person({ summary: null, records_researched_through: null }), TODAY)).toBe(
      "Jordan Voter (Democratic) is running for Governor in Kentucky in the November 3, 2026 election."
    );
  });
});

describe("candidateAnswerSnippet", () => {
  it("keeps whole leading sentences within the length cap", () => {
    expect(candidateAnswerSnippet(person(), TODAY, 170)).toBe(
      "Jordan Voter (Democratic) is running for Governor in Kentucky in the November 3, 2026 election. Jordan Voter is a Lexington city council member and former teacher."
    );
    expect(candidateAnswerSnippet(person(), TODAY, 10)).toBe(
      "Jordan Voter (Democratic) is running for Governor in Kentucky in the November 3, 2026 election."
    );
  });
});
