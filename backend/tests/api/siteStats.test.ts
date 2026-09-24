import { describe, expect, it, vi } from "vitest";

import { createCachedSiteStats, getSiteStats } from "../../src/api/siteStats.js";

describe("site stats", () => {
  it("joins per-state election and party counts, totals them, and drops codes it cannot name", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { state: "KY", districts: "12", upcoming_elections: "40", upcoming_contested: "25", upcoming_uncontested: "10", upcoming_measures: "3", next_election_date: "2026-11-03" },
          { state: "AK", districts: "2", upcoming_elections: "4", upcoming_contested: "3", upcoming_uncontested: "0", upcoming_measures: "1", next_election_date: "2026-10-06" },
          { state: "ZZ", districts: "1", upcoming_elections: "1", upcoming_contested: "1", upcoming_uncontested: "0", upcoming_measures: "0", next_election_date: null },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { state: "KY", democratic: "30", republican: "35", other: "5" },
          // AK has no party row at all: counts read as zero, never NaN.
        ],
      })
      .mockResolvedValueOnce({ rows: [{ candidate_records: "12345" }] });

    const result = await getSiteStats({ query }, () => new Date("2026-09-24T18:00:00Z"));

    expect(result.as_of).toBe("2026-09-24");
    expect(result.states).toEqual([
      {
        state: "KY",
        name: "Kentucky",
        districts: 12,
        upcoming_elections: 40,
        upcoming_contested: 25,
        upcoming_uncontested: 10,
        upcoming_measures: 3,
        upcoming_candidates: 70,
        upcoming_democratic: 30,
        upcoming_republican: 35,
        upcoming_other: 5,
        next_election_date: "2026-11-03",
      },
      {
        state: "AK",
        name: "Alaska",
        districts: 2,
        upcoming_elections: 4,
        upcoming_contested: 3,
        upcoming_uncontested: 0,
        upcoming_measures: 1,
        upcoming_candidates: 0,
        upcoming_democratic: 0,
        upcoming_republican: 0,
        upcoming_other: 0,
        next_election_date: "2026-10-06",
      },
    ]);
    expect(result.totals).toEqual({
      states: 2,
      districts: 14,
      upcoming_elections: 44,
      upcoming_contested: 28,
      upcoming_uncontested: 10,
      upcoming_measures: 4,
      upcoming_candidates: 70,
      upcoming_democratic: 30,
      upcoming_republican: 35,
      upcoming_other: 5,
      next_election_date: "2026-10-06",
      candidate_records: 12345,
    });
    // Uncontested follows the vote-power rule: candidates <= seats, seats defaulting to 1.
    expect(query.mock.calls[0]?.[0]).toContain("roster.active_count <= GREATEST(COALESCE(e.seats_to_fill, 1), 1)");
    // Withdrawn candidacies never count as running.
    expect(query.mock.calls[1]?.[0]).toContain("ce.status <> 'withdrawn'");
  });

  it("caches the result for the TTL, shares one in-flight load, and serves stale on a failed refresh", async () => {
    const empty = { rows: [] };
    const query = vi.fn().mockResolvedValue(empty);
    let clock = new Date("2026-09-24T00:00:00Z").getTime();
    const cached = createCachedSiteStats({ db: { query }, ttlMs: 1000, now: () => new Date(clock) });

    const [first, second] = await Promise.all([cached(), cached()]);
    expect(first).toBe(second);
    // Three queries for one load, not six.
    expect(query).toHaveBeenCalledTimes(3);

    clock += 500;
    await cached();
    expect(query).toHaveBeenCalledTimes(3);

    clock += 1000;
    query.mockRejectedValueOnce(new Error("db down"));
    expect(await cached()).toBe(first);
  });
});
