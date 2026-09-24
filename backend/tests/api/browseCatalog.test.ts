import { describe, expect, it, vi } from "vitest";

import { getBrowseDistrict, getBrowseState, listBrowseStates, normalizeBrowseState } from "../../src/api/browseCatalog.js";

describe("browse catalog", () => {
  it("normalizes a state code and rejects codes it cannot name", () => {
    expect(normalizeBrowseState(" ky ")).toBe("KY");
    expect(normalizeBrowseState("DC")).toBe("DC");
    expect(normalizeBrowseState("PR")).toBeNull();
    expect(normalizeBrowseState("Kentucky")).toBeNull();
  });

  it("lists states with numeric counts, dropping codes it cannot name", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { state: "KY", district_count: "12", upcoming_election_count: "40" },
        { state: "ZZ", district_count: "1", upcoming_election_count: "1" },
      ],
    });

    const result = await listBrowseStates({ query });

    expect(result).toEqual({
      states: [{ state: "KY", name: "Kentucky", district_count: 12, upcoming_election_count: 40 }],
    });
    // Only districts holding an election count.
    expect(query.mock.calls[0]?.[0]).toContain("JOIN public.elections e ON e.district_id = d.id");
  });

  it("serves a state's districts and 404s an unnamed or empty state", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "dddddddd-1111-4111-8111-111111111111",
          name: "Simpson County, Kentucky",
          district_type: "county",
          election_count: "3",
          upcoming_election_count: "2",
          next_election_date: "2026-11-03",
        },
      ],
    });

    const result = await getBrowseState({ query }, "ky");
    expect(result).toEqual({
      state: "KY",
      name: "Kentucky",
      districts: [
        {
          id: "dddddddd-1111-4111-8111-111111111111",
          name: "Simpson County, Kentucky",
          district_type: "county",
          election_count: 3,
          upcoming_election_count: 2,
          next_election_date: "2026-11-03",
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE d.state = $1"), ["KY"]);

    expect(await getBrowseState({ query }, "PR")).toBeNull();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getBrowseState({ query }, "WY")).toBeNull();
  });

  it("serves a district's elections with their candidates", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "dddddddd-1111-4111-8111-111111111111", name: "Simpson County, Kentucky", district_type: "county", state: "KY" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            official_ballot_title: "County Judge/Executive",
            election_date: "2026-11-03",
            election_stage: "general",
            race_type: "office",
            candidates: [{ candidate_id: "22222222-2222-4222-8222-222222222222", display_name: "Jordan Voter", party: "Republican", status: "declared" }],
          },
          {
            id: "11111111-1111-4111-8111-111111111112",
            official_ballot_title: "Constable",
            election_date: "2024-11-05",
            election_stage: "general",
            race_type: "office",
            candidates: null,
          },
        ],
      });

    const result = await getBrowseDistrict({ query }, "dddddddd-1111-4111-8111-111111111111");

    expect(result?.district).toEqual({
      id: "dddddddd-1111-4111-8111-111111111111",
      name: "Simpson County, Kentucky",
      district_type: "county",
      state: "KY",
      state_name: "Kentucky",
    });
    expect(result?.elections.map((election) => election.official_ballot_title)).toEqual(["County Judge/Executive", "Constable"]);
    expect(result?.elections[0]?.candidates).toEqual([
      { candidate_id: "22222222-2222-4222-8222-222222222222", display_name: "Jordan Voter", party: "Republican", status: "declared" },
    ]);
    // A race with nobody linked yet reads as an empty list, not null.
    expect(result?.elections[1]?.candidates).toEqual([]);
    // Deleted and merged-away candidates never appear.
    expect(query.mock.calls[1]?.[0]).toContain("c.deleted_at IS NULL");
    expect(query.mock.calls[1]?.[0]).toContain("c.merged_into_candidate_id IS NULL");
  });

  it("404s an unknown district and a district with no elections", async () => {
    const unknown = vi.fn().mockResolvedValueOnce({ rows: [] });
    expect(await getBrowseDistrict({ query: unknown }, "dddddddd-1111-4111-8111-111111111111")).toBeNull();
    expect(unknown).toHaveBeenCalledTimes(1);

    const empty = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "d", name: "Nowhere", district_type: "place", state: "KY" }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await getBrowseDistrict({ query: empty }, "dddddddd-1111-4111-8111-111111111111")).toBeNull();
  });
});
