import { describe, expect, it } from "vitest";
import { collectSuggestedIssues, hasClearableAutoPicks, reasonLabel, summarizeAutoPick } from "./autoPick";
import type { AutoPickElectionResult, AutoPickReason, ElectionChoice } from "./types";

// The full summary/panel copy matrix is exercised by the web control tests
// (AutoPickControl.test.tsx renders these sentences); this file pins the
// pure helpers where they now live.

function choice(overrides: Partial<ElectionChoice>): ElectionChoice {
  return {
    election_id: "e1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: 1,
    picks: [],
    measure_position: null,
    updated_at: "2026-08-29T00:00:00Z",
    ...overrides,
  };
}

function result(overrides: Partial<AutoPickElectionResult>): AutoPickElectionResult {
  return {
    election_id: "e1",
    race_type: "office",
    outcome: "no_pick",
    reason: null,
    picked_candidate_ids: [],
    measure_position: null,
    shortlist_candidate_ids: [],
    candidates: [],
    measure_per_issue: [],
    unresearched: [],
    ...overrides,
  };
}

describe("reasonLabel", () => {
  it("reads null (no recorded reason) as the evidence gap", () => {
    expect(reasonLabel(null)).toBe("not enough evidence");
    expect(reasonLabel("tie")).toBe("a tie");
    expect(reasonLabel("too_few_issues")).toBe("fewer than 3 ranked issues");
    // A reason this build does not know (older backend mid-deploy) must
    // never render as "undefined".
    expect(reasonLabel("retention" as unknown as AutoPickReason)).toBe("not enough evidence");
  });
});

describe("hasClearableAutoPicks", () => {
  it("finds auto rows only on the given date", () => {
    const choices = [
      choice({
        election_id: "e1",
        election_date: "2026-11-03",
        picks: [{ candidate_id: "c1", display_name: "Jane", candidacy_status: "active", origin: "auto" }],
      }),
    ];
    expect(hasClearableAutoPicks(choices, "2026-11-03")).toBe(true);
    expect(hasClearableAutoPicks(choices, "2026-12-01")).toBe(false);
  });

  it("ignores manual picks and manual measure positions", () => {
    const choices = [
      choice({
        election_id: "e1",
        picks: [{ candidate_id: "c1", display_name: "Jane", candidacy_status: "active", origin: "manual" }],
      }),
      choice({
        election_id: "e2",
        race_type: "ballot_measure",
        measure_position: "yes",
        measure_origin: "manual",
      }),
    ];
    expect(hasClearableAutoPicks(choices, "2026-11-03")).toBe(false);
  });

  it("counts an auto measure position", () => {
    const choices = [
      choice({
        election_id: "e2",
        race_type: "ballot_measure",
        measure_position: "no",
        measure_origin: "auto",
      }),
    ];
    expect(hasClearableAutoPicks(choices, "2026-11-03")).toBe(true);
  });
});

describe("summarizeAutoPick", () => {
  const reports = [
    { candidate_id: "c1", display_name: "Jane Doe", score: 1, has_evidence: true, vetoed_by: [], per_issue: [] },
    { candidate_id: "c2", display_name: "John Roe", score: 0, has_evidence: false, vetoed_by: [], per_issue: [] },
  ];

  it("names the winner", () => {
    const summary = summarizeAutoPick(
      result({ outcome: "picked", picked_candidate_ids: ["c1"], candidates: reports }),
      1
    );
    expect(summary).toBe("Picked Jane Doe — the best match for your issues.");
  });

  it("flags open seats on a partial multi-seat fill", () => {
    const summary = summarizeAutoPick(
      result({ outcome: "picked", picked_candidate_ids: ["c1"], candidates: reports }),
      3
    );
    expect(summary).toContain("Picked Jane Doe");
    expect(summary).toContain("2 seats are still open");
  });

  it("puts the couldn't-run reasons before the measure fork", () => {
    const summary = summarizeAutoPick(
      result({ race_type: "ballot_measure", reason: "too_few_issues" }),
      null
    );
    expect(summary).toBe("Rank at least 3 issues first, so the pick reflects what matters to you.");
  });

  it("tells the two measure no-answer cases apart", () => {
    expect(summarizeAutoPick(result({ race_type: "ballot_measure" }), null)).toBe(
      "No answer — this measure isn't tagged with any of your issues yet."
    );
    expect(
      summarizeAutoPick(
        result({
          race_type: "ballot_measure",
          measure_per_issue: [{ research_area_id: "a1", net: 1 }],
        }),
        null
      )
    ).toBe("No answer — this measure helps some of your issues and hurts others about equally, so it's your call.");
  });

  it("names the shortlist on a tie", () => {
    const summary = summarizeAutoPick(
      result({ reason: "tie", shortlist_candidate_ids: ["c1", "c2"], candidates: reports }),
      1
    );
    expect(summary).toBe("It's a tie between Jane Doe and John Roe on your issues — your call between them.");
  });
});

describe("retention Yes/No copy", () => {
  const judge = {
    candidate_id: "c-judge",
    display_name: "Judge Pat Example",
    score: 0.5,
    has_evidence: true,
    vetoed_by: [],
    per_issue: [{ research_area_id: "a1", net: 1, for_count: 1, against_count: 0 }],
  };
  function retention(overrides: Partial<AutoPickElectionResult>): AutoPickElectionResult {
    return {
      election_id: "e-1",
      race_type: "office",
      outcome: "picked",
      reason: null,
      picked_candidate_ids: [],
      measure_position: "yes",
      shortlist_candidate_ids: [],
      candidates: [judge],
      unresearched: [],
      measure_per_issue: [{ research_area_id: "a1", net: 1 }],
      ...overrides,
    } as AutoPickElectionResult;
  }

  it("answers Yes or No on keeping the judge", () => {
    expect(summarizeAutoPick(retention({}), 1)).toBe("Vote Yes — this judge's record supports your issues overall.");
    expect(summarizeAutoPick(retention({ measure_position: "no" }), 1)).toBe(
      "Vote No — this judge's record goes against your issues overall."
    );
    expect(summarizeAutoPick(retention({ measure_position: "no", reason: "veto" }), 1)).toBe(
      "Vote No — this judge's record goes against an issue you drew a line on."
    );
  });

  it("names the one-candidate gap when there is no answer", () => {
    const noRecords = retention({
      outcome: "no_pick",
      reason: "insufficient_evidence",
      measure_position: null,
      candidates: [{ ...judge, score: 0, has_evidence: false, per_issue: [] }],
      measure_per_issue: [],
    });
    expect(summarizeAutoPick(noRecords, 1)).toBe("No pick: this candidate has no record on your issues yet.");
    const cancelled = retention({
      outcome: "no_pick",
      reason: "insufficient_evidence",
      measure_position: null,
      candidates: [{ ...judge, score: 0 }],
    });
    expect(summarizeAutoPick(cancelled, 1)).toBe(
      "No pick: this candidate's record helps some of your issues and hurts others about equally, so it's your call."
    );
  });
});

describe("collectSuggestedIssues", () => {
  const issue = (research_area_id: string, name: string, candidate_count: number, record_count = candidate_count) => ({
    research_area_id,
    slug: name.toLowerCase(),
    name,
    description: null,
    candidate_count,
    record_count,
  });

  it("merges one issue across races, summing counts and counting the races it would help", () => {
    const merged = collectSuggestedIssues([
      result({ election_id: "e1", suggested_issues: [issue("a", "Housing", 2), issue("b", "Taxes", 3)] }),
      result({ election_id: "e2", suggested_issues: [issue("a", "Housing", 1)] }),
    ]);
    expect(merged).toEqual([
      { ...issue("a", "Housing", 3), race_count: 2 },
      { ...issue("b", "Taxes", 3), race_count: 1 },
    ]);
  });

  it("orders by races helped, then candidates, then records, then name", () => {
    const merged = collectSuggestedIssues([
      result({
        suggested_issues: [issue("c", "Climate", 1, 1), issue("b", "Budget", 1, 4), issue("a", "Water", 2, 2)],
      }),
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(["Water", "Budget", "Climate"]);
  });

  it("contributes nothing from a result without the field (older backend)", () => {
    expect(collectSuggestedIssues([result({})])).toEqual([]);
  });
});
