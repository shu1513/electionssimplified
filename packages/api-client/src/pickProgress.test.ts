import { describe, expect, it } from "vitest";

import type { ElectionChoice } from "./types";
import { myDraftLabel, nearestDayDraftProgress, nearestDayPickProgress } from "./pickProgress";

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

describe("nearestDayDraftProgress", () => {
  const race = (id: string, retention = false, date = "2026-11-03") => ({
    id, election_date: date, race_type: "office" as const,
    official_ballot_title: retention ? `Shall Judge ${id} be retained?` : "Governor",
  });
  const elections = [race("governor"), race("r1", true), race("r2", true)];

  it("waits for both inputs and does not complete an absent ballot", () => {
    expect(nearestDayDraftProgress(undefined, new Map(), "2026-08-01")).toBeNull();
    expect(nearestDayDraftProgress(elections, undefined, "2026-08-01")).toBeNull();
    expect(nearestDayDraftProgress([], new Map(), "2026-08-01")).toBeNull();
    expect(nearestDayDraftProgress(elections, new Map(), "2027-01-01")).toBeNull();
  });

  it("keeps grouped retention answers outside completion while reporting remaining retention", () => {
    const choices = new Map([["governor", decided("governor")]]);
    const progress = nearestDayDraftProgress(elections, choices, "2026-08-01");
    expect(progress).toEqual({ election_date: "2026-11-03", election_ids: ["governor"],
      picked: 1, total: 1, complete: true, hasOpenRetention: true });
    expect(myDraftLabel(progress)).toBe("My Draft ✓");
    choices.set("r1", choice({ election_id: "r1", measure_position: "yes" }));
    expect(nearestDayDraftProgress(elections, choices, "2026-08-01")).toEqual(progress);
    choices.set("r2", choice({ election_id: "r2", measure_position: "no" }));
    expect(nearestDayDraftProgress(elections, choices, "2026-08-01"))
      .toEqual({ ...progress, hasOpenRetention: false });
    choices.delete("governor");
    expect(nearestDayDraftProgress(elections, choices, "2026-08-01"))
      .toMatchObject({ picked: 0, total: 1, complete: false, hasOpenRetention: false });
  });

  it("counts a singleton retention, even when another date has a retention", () => {
    const ballot = [race("governor"), race("r1", true), race("r2", true, "2027-11-02")];
    const choices = new Map([["governor", decided("governor")]]);
    expect(nearestDayDraftProgress(ballot, choices, "2026-08-01"))
      .toMatchObject({ picked: 1, total: 2, complete: false, hasOpenRetention: false });
    choices.set("r1", choice({ election_id: "r1", measure_position: "no" }));
    expect(nearestDayDraftProgress(ballot, choices, "2026-08-01"))
      .toMatchObject({ picked: 2, total: 2, complete: true, hasOpenRetention: false });
  });

  it("does not announce an empty completion or skip a nearest retention-only date", () => {
    const ballot = [race("r1", true), race("r2", true), race("later", false, "2027-11-02")];
    const choices = new Map([["later", decided("later")]]);
    expect(nearestDayDraftProgress(ballot, choices, "2026-08-01")).toBeNull();
    expect(myDraftLabel(nearestDayDraftProgress(ballot, choices, "2026-08-01"))).toBe("My Draft");
  });

  it("does not warn about retention on other dates", () => {
    const ballot = [race("governor"), race("r1", true, "2027-11-02"), race("r2", true, "2027-11-02")];
    expect(nearestDayDraftProgress(ballot, new Map([["governor", decided("governor")]]), "2026-08-01"))
      .toMatchObject({ total: 1, complete: true, hasOpenRetention: false });
  });
});
