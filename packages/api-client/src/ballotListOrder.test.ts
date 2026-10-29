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
  it("restores date order and the empty-race sink around a positional (state_baseline) payload, keeping ballot order within a date", () => {
    const payload = [
      row("gov-nov", "2026-11-03"),
      row("empty-nov", "2026-11-03", { candidate_count: 0 }),
      row("measure-nov", "2026-11-03", { race_type: "ballot_measure", candidate_count: 0 }),
      row("council-oct", "2026-10-28"),
      row("decided-oct", "2026-10-28", { candidate_count: 0, has_results: true }),
    ];
    expect(ballotListOrder(payload).map((e) => e.id)).toEqual([
      "council-oct",
      "decided-oct",
      "gov-nov",
      "measure-nov",
      "empty-nov",
    ]);
  });

  it("is the identity for a list-sort payload (already date-first with the sink applied)", () => {
    const payload = [
      row("followed-oct", "2026-10-28"),
      row("council-oct", "2026-10-28"),
      row("measure-nov", "2026-11-03", { race_type: "ballot_measure", candidate_count: 0 }),
      row("gov-nov", "2026-11-03"),
      row("empty-oct", "2026-10-28", { candidate_count: 0 }),
    ];
    const ordered = ballotListOrder(payload);
    expect(ordered.map((e) => e.id)).toEqual(payload.map((e) => e.id));
    expect(ordered).not.toBe(payload);
  });
});
