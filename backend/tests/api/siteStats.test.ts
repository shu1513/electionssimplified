import { describe, expect, it, vi } from "vitest";

import { createCachedSiteStats, getSiteStats } from "../../src/api/siteStats.js";

const AGGREGATES = {
  rows: [
    { state: "KY", districts: "12", upcoming_elections: "40", upcoming_measures: "3", next_election_date: "2026-11-03" },
    { state: "AK", districts: "2", upcoming_elections: "4", upcoming_measures: "1", next_election_date: "2026-10-06" },
    { state: "ZZ", districts: "1", upcoming_elections: "1", upcoming_measures: "0", next_election_date: null },
  ],
};

const OFFICE_RACES = {
  rows: [
    // Contested: more candidates than seats.
    { state: "KY", official_ballot_title: "Governor", seats_to_fill: null, active_count: "3" },
    { state: "KY", official_ballot_title: "City Council", seats_to_fill: 3, active_count: "4" },
    // Uncontested: every candidate wins a seat.
    { state: "KY", official_ballot_title: "County Clerk", seats_to_fill: null, active_count: "1" },
    { state: "KY", official_ballot_title: "School Board", seats_to_fill: 2, active_count: "2" },
    // A retention question is a yes/no vote on one judge: neither.
    { state: "KY", official_ballot_title: "Shall Judge Alex Bench be retained in office?", seats_to_fill: null, active_count: "1" },
    // No known candidates: neither.
    { state: "KY", official_ballot_title: "Constable", seats_to_fill: null, active_count: "0" },
    { state: "AK", official_ballot_title: "Mayor", seats_to_fill: null, active_count: "2" },
  ],
};

const PARTIES = {
  rows: [
    { state: "KY", democratic: "30", republican: "35", other: "5" },
    // AK has no party row at all: counts read as zero, never NaN.
  ],
};

const RECORDS = { rows: [{ candidate_records: "12345" }] };

describe("site stats", () => {
  it("classifies office races with the vote-power rules, joins party counts, totals, and drops unnamed codes", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(AGGREGATES)
      .mockResolvedValueOnce(OFFICE_RACES)
      .mockResolvedValueOnce(PARTIES)
      .mockResolvedValueOnce(RECORDS);

    const result = await getSiteStats({ query }, () => new Date("2026-09-24T18:00:00Z"));

    expect(result.as_of).toBe("2026-09-24");
    expect(result.states).toEqual([
      {
        state: "KY",
        name: "Kentucky",
        districts: 12,
        upcoming_elections: 40,
        upcoming_contested: 2,
        upcoming_uncontested: 2,
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
        upcoming_contested: 1,
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
      upcoming_contested: 3,
      upcoming_uncontested: 2,
      upcoming_measures: 4,
      upcoming_candidates: 70,
      upcoming_democratic: 30,
      upcoming_republican: 35,
      upcoming_other: 5,
      next_election_date: "2026-10-06",
      candidate_records: 12345,
    });
    // Withdrawn candidacies never count as running, in either query.
    expect(query.mock.calls[1]?.[0]).toContain("ce.status <> 'withdrawn'");
    // The roster size is the larger of linked profiles and the staged
    // roster, as on the election page — never links alone.
    expect(query.mock.calls[1]?.[0]).toContain("s.item_type = 'candidate_roster'");
    expect(query.mock.calls[1]?.[0]).toMatch(/GREATEST\(\s*\(\s*SELECT COUNT\(\*\)::int/);
    expect(query.mock.calls[2]?.[0]).toContain("ce.status <> 'withdrawn'");
  });

  it("caches for the TTL, shares one in-flight load, and serves stale to every waiter when a refresh fails", async () => {
    const empty = { rows: [] };
    const query = vi.fn().mockResolvedValue(empty);
    let clock = new Date("2026-09-24T00:00:00Z").getTime();
    const cached = createCachedSiteStats({ db: { query }, ttlMs: 1000, now: () => new Date(clock) });

    const [first, second] = await Promise.all([cached(), cached()]);
    expect(first).toBe(second);
    // Four queries for one load, not eight.
    expect(query).toHaveBeenCalledTimes(4);

    clock += 500;
    await cached();
    expect(query).toHaveBeenCalledTimes(4);

    // Past the TTL the refresh fails: both concurrent callers get the last
    // good result, not only the one that started the refresh.
    clock += 1000;
    query.mockRejectedValue(new Error("db down"));
    const [staleA, staleB] = await Promise.all([cached(), cached()]);
    expect(staleA).toBe(first);
    expect(staleB).toBe(first);
  });
});
