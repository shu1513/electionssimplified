import { describe, expect, it } from "vitest";

import { ballotListOrder } from "./ballotListOrder";

const row = (id: string, election_date: string, extra: Partial<{ race_type: string; candidate_count: number; has_results: boolean }> = {}) => ({
  id,
  election_date,
  race_type: "office",
  candidate_count: 2,
  has_results: false,
  ...extra,
});

describe("ballotListOrder", () => {
  // A state_baseline payload: ranked across dates, candidate-less race in
  // its slot.
  const payload = [
    row("gov-nov", "2026-11-03"),
    row("empty-nov", "2026-11-03", { candidate_count: 0 }),
    row("measure-nov", "2026-11-03", { race_type: "ballot_measure", candidate_count: 0 }),
    row("council-oct", "2026-10-28"),
    row("decided-oct", "2026-10-28", { candidate_count: 0, has_results: true }),
  ];

  it("restores date order and the empty-race sink under state_baseline, keeping ballot order within a date", () => {
    expect(ballotListOrder(payload, "state_baseline").map((e) => e.id)).toEqual([
      "council-oct",
      "decided-oct",
      "gov-nov",
      "measure-nov",
      "empty-nov",
    ]);
  });

  it("leaves every other sort's payload order alone", () => {
    expect(ballotListOrder(payload, "vote_power").map((e) => e.id)).toEqual(payload.map((e) => e.id));
    expect(ballotListOrder(payload, "state_baseline")).not.toBe(payload);
  });
});
