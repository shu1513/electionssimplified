import { describe, expect, it } from "vitest";

import type { ElectionChoice } from "./types";
import { myDraftLabel, nearestDayPickProgress } from "./pickProgress";

function choice(partial: Partial<ElectionChoice>): ElectionChoice {
  return {
    election_id: "e1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [],
    measure_position: null,
    updated_at: "2026-08-28T00:00:00Z",
    ...partial,
  };
}

const decided = (electionId: string) =>
  choice({
    election_id: electionId,
    picks: [{ candidate_id: "c1", display_name: "Jane Doe", candidacy_status: "active" }],
  });

describe("myDraftLabel", () => {
  it("stays plain until the first pick, counts up, then earns My Draft ✓", () => {
    expect(myDraftLabel(null)).toBe("My Draft");
    const day = { election_date: "2026-11-03", election_ids: [] };
    expect(myDraftLabel({ ...day, picked: 0, total: 8, complete: false })).toBe("My Draft");
    expect(myDraftLabel({ ...day, picked: 3, total: 8, complete: false })).toBe("My Draft 3/8");
    expect(myDraftLabel({ ...day, picked: 8, total: 8, complete: true })).toBe("My Draft ✓");
  });
});

describe("nearestDayPickProgress", () => {
  const elections = [
    { id: "nov-1", election_date: "2026-11-03" },
    { id: "nov-2", election_date: "2026-11-03" },
    { id: "sep-1", election_date: "2026-09-15" },
    { id: "past-1", election_date: "2026-08-01" },
  ];

  it("returns null until both inputs settle and when nothing is upcoming", () => {
    const choices = new Map<string, ElectionChoice>();
    expect(nearestDayPickProgress(undefined, choices, "2026-08-28")).toBeNull();
    expect(nearestDayPickProgress(elections, undefined, "2026-08-28")).toBeNull();
    expect(nearestDayPickProgress(elections, choices, "2027-01-01")).toBeNull();
  });

  it("counts only the nearest upcoming day, ignoring past races and other days", () => {
    const choices = new Map<string, ElectionChoice>([
      // Decided on the nearest day...
      ["sep-1", decided("sep-1")],
      // ...and on a later day + a past day, which must not count.
      ["nov-1", decided("nov-1")],
      ["past-1", decided("past-1")],
    ]);
    expect(nearestDayPickProgress(elections, choices, "2026-08-28")).toEqual({
      election_date: "2026-09-15",
      election_ids: ["sep-1"],
      picked: 1,
      total: 1,
      complete: true,
    });
    // Once September passes, the November group (2 races, 1 decided) leads.
    expect(nearestDayPickProgress(elections, choices, "2026-10-01")).toEqual({
      election_date: "2026-11-03",
      election_ids: ["nov-1", "nov-2"],
      picked: 1,
      total: 2,
      complete: false,
    });
  });

  it("excludes races from both counts and ids, without changing the default", () => {
    const choices = new Map([["nov-1", decided("nov-1")]]);
    expect(nearestDayPickProgress(elections, choices, "2026-10-01", { exclude: new Set(["nov-1"]) }))
      .toEqual({ election_date: "2026-11-03", election_ids: ["nov-2"], picked: 0, total: 1, complete: false });
    expect(nearestDayPickProgress(elections, choices, "2026-10-01", { exclude: new Set(["nov-2"]) }))
      .toEqual({ election_date: "2026-11-03", election_ids: ["nov-1"], picked: 1, total: 1, complete: true });
    expect(nearestDayPickProgress(elections, choices, "2026-10-01", {}))
      .toEqual(nearestDayPickProgress(elections, choices, "2026-10-01"));
    expect(nearestDayPickProgress(elections, choices, "2026-08-28", { exclude: new Set(["sep-1"]) })).toBeNull();
  });

  it("treats an election day itself as upcoming and an emptied choice as undecided", () => {
    const choices = new Map<string, ElectionChoice>([["sep-1", choice({ election_id: "sep-1" })]]);
    expect(nearestDayPickProgress(elections, choices, "2026-09-15")).toEqual({
      election_date: "2026-09-15",
      election_ids: ["sep-1"],
      picked: 0,
      total: 1,
      complete: false,
    });
  });
});
