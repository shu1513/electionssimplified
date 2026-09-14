import { describe, expect, it } from "vitest";

import {
  candidateRailSortsOffered,
  railSortsOffered,
  sortCandidateRailEntries,
  sortRailEntries,
  type CandidateRailSortEntry,
  type RailSortEntry,
} from "./railSort";
import { buildResearchAreaWeights } from "./researchAreaScoring";

function entry(id: string, overrides: Partial<RailSortEntry> = {}): RailSortEntry {
  return {
    id,
    title: id,
    race_type: "office",
    vote_power_score: null,
    election_date: "2026-11-03",
    research_area_ids: [],
    ...overrides,
  };
}

describe("railSortsOffered", () => {
  const KEYED = [entry("a"), entry("b")];

  it("offers everything but my_areas without saved areas", () => {
    expect(railSortsOffered(KEYED, false)).toEqual(["vote_power", "alphabetical"]);
    expect(railSortsOffered(KEYED, true)).toEqual(["my_areas", "vote_power", "alphabetical"]);
  });

  it("offers nothing on an unkeyed (pre-deploy) snapshot or a single entry", () => {
    expect(railSortsOffered([{ id: "a", title: "A" }, { id: "b", title: "B" }], true)).toEqual([]);
    expect(railSortsOffered([entry("a")], true)).toEqual([]);
  });

  it("withholds only my_areas when area ids are missing from an entry", () => {
    const noAreas = [entry("a"), { ...entry("b"), research_area_ids: undefined }];
    expect(railSortsOffered(noAreas, true)).toEqual(["vote_power", "alphabetical"]);
  });
});

describe("sortRailEntries", () => {
  it("vote_power: higher score first, unknown scores last, title tiebreak", () => {
    const sorted = sortRailEntries(
      [
        entry("low", { vote_power_score: 1 }),
        entry("unknown", { vote_power_score: null }),
        entry("high", { vote_power_score: 9 }),
      ],
      "vote_power"
    );
    expect(sorted.map((e) => e.id)).toEqual(["high", "low", "unknown"]);
  });

  it("keeps election date as the outer order under every sort, the sort within a date", () => {
    const entries = [
      entry("later-high", { election_date: "2026-11-03", vote_power_score: 99, title: "AAA", research_area_ids: ["a-1"] }),
      entry("sooner-low", { election_date: "2026-08-18", vote_power_score: 1, title: "ZZZ" }),
      entry("sooner-high", { election_date: "2026-08-18", vote_power_score: 50, title: "MMM" }),
    ];
    const weights = buildResearchAreaWeights([{ research_area_id: "a-1", rank: 1 }]);
    expect(sortRailEntries(entries, "vote_power").map((e) => e.id)).toEqual(["sooner-high", "sooner-low", "later-high"]);
    expect(sortRailEntries(entries, "my_areas", weights).map((e) => e.id)).toEqual([
      "sooner-high",
      "sooner-low",
      "later-high",
    ]);
    expect(sortRailEntries(entries, "alphabetical").map((e) => e.id)).toEqual(["sooner-high", "sooner-low", "later-high"]);
  });

  it("alphabetical is numeric-aware: Proposition 4 before Proposition 33", () => {
    const sorted = sortRailEntries(
      [
        entry("p33", { title: "Proposition 33: Rent" }),
        entry("p4", { title: "Proposition 4: Bonds" }),
      ],
      "alphabetical"
    );
    expect(sorted.map((e) => e.id)).toEqual(["p4", "p33"]);
  });

  it("my_areas: summed matched weights first, best rank breaks ties, vote power after", () => {
    // rank 1 → weight 1, rank 2 → weight 0.75, rank 3 → weight 0.5625.
    const weights = buildResearchAreaWeights([
      { research_area_id: "a-1", slug: "s1", name: "n1", description: null, rank: 1, direction: "support", hard_veto: false },
      { research_area_id: "a-2", slug: "s2", name: "n2", description: null, rank: 2, direction: "support", hard_veto: false },
      { research_area_id: "a-3", slug: "s3", name: "n3", description: null, rank: 3, direction: "support", hard_veto: false },
    ]);
    const sorted = sortRailEntries(
      [
        entry("none", { vote_power_score: 99 }),
        entry("second-and-third", { research_area_ids: ["a-2", "a-3"] }), // 1.3125
        entry("top-only", { research_area_ids: ["a-1"] }), // 1
        entry("top-and-third", { research_area_ids: ["a-1", "a-3"] }), // 1.5625
      ],
      "my_areas",
      weights
    );
    expect(sorted.map((e) => e.id)).toEqual(["top-and-third", "second-and-third", "top-only", "none"]);
  });

  it("my_areas without weights degrades to vote_power order", () => {
    const sorted = sortRailEntries(
      [
        entry("weak", { vote_power_score: 1, research_area_ids: ["a-1"] }),
        entry("strong", { vote_power_score: 5 }),
      ],
      "my_areas"
    );
    expect(sorted.map((e) => e.id)).toEqual(["strong", "weak"]);
  });

  it("keeps the awaiting-candidates tail sunk under every sort", () => {
    const entries = [
      entry("awaiting-high", { vote_power_score: 99, awaiting_candidates: true, title: "AAA" }),
      entry("readable", { vote_power_score: 1, title: "ZZZ" }),
    ];
    for (const sort of ["my_areas", "vote_power", "alphabetical"] as const) {
      expect(
        sortRailEntries(entries, sort).map((e) => e.id),
        sort
      ).toEqual(["readable", "awaiting-high"]);
    }
  });

  it("does not mutate the input", () => {
    const entries = [entry("b"), entry("a")];
    sortRailEntries(entries, "alphabetical");
    expect(entries.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

function candidateEntry(
  id: string,
  name: string,
  areas: { research_area_id: string; record_count: number }[] = []
): CandidateRailSortEntry {
  return { id, name, research_area_records: areas };
}

describe("candidateRailSortsOffered", () => {
  const KEYED = [candidateEntry("c-1", "A"), candidateEntry("c-2", "B")];

  it("offers My issues only with saved areas, A–Z otherwise", () => {
    expect(candidateRailSortsOffered(KEYED, true)).toEqual(["my_issues", "alphabetical"]);
    expect(candidateRailSortsOffered(KEYED, false)).toEqual(["alphabetical"]);
  });

  it("offers nothing on an unkeyed (pre-deploy) snapshot or a single entry", () => {
    expect(
      candidateRailSortsOffered([{ id: "c-1", name: "A" }, { id: "c-2", name: "B" }], true)
    ).toEqual([]);
    expect(candidateRailSortsOffered([candidateEntry("c-1", "A")], true)).toEqual([]);
  });
});

describe("sortCandidateRailEntries", () => {
  // rank 1 → weight 1, rank 2 → weight 0.75.
  const WEIGHTS = buildResearchAreaWeights([
    { research_area_id: "a-1", slug: "s1", name: "n1", description: null, rank: 1, direction: "support", hard_veto: false },
    { research_area_id: "a-2", slug: "s2", name: "n2", description: null, rank: 2, direction: "support", hard_veto: false },
  ]);

  it("my_issues: weighted matched areas first, record volume breaks ties, ties keep arrival order", () => {
    const sorted = sortCandidateRailEntries(
      [
        candidateEntry("none", "Zoe Zero"),
        candidateEntry("both", "Bo Both", [
          { research_area_id: "a-1", record_count: 1 },
          { research_area_id: "a-2", record_count: 1 },
        ]), // score 1.75
        candidateEntry("top-few", "Fay Few", [{ research_area_id: "a-1", record_count: 1 }]), // 1, 1 record
        candidateEntry("top-many", "May Many", [{ research_area_id: "a-1", record_count: 4 }]), // 1, 4 records
      ],
      "my_issues",
      WEIGHTS
    );
    expect(sorted.map((e) => e.id)).toEqual(["both", "top-many", "top-few", "none"]);
  });

  it("my_issues ignores unmatched areas and zero-count rows", () => {
    const sorted = sortCandidateRailEntries(
      [
        candidateEntry("unmatched", "A", [{ research_area_id: "other", record_count: 9 }]),
        candidateEntry("zero", "B", [{ research_area_id: "a-1", record_count: 0 }]),
        candidateEntry("matched", "C", [{ research_area_id: "a-2", record_count: 1 }]),
      ],
      "my_issues",
      WEIGHTS
    );
    expect(sorted.map((e) => e.id)).toEqual(["matched", "unmatched", "zero"]);
  });

  it("alphabetical sorts by name and does not mutate the input", () => {
    const entries = [candidateEntry("c-2", "Riley Runner"), candidateEntry("c-1", "Jordan Voter")];
    const sorted = sortCandidateRailEntries(entries, "alphabetical");
    expect(sorted.map((e) => e.id)).toEqual(["c-1", "c-2"]);
    expect(entries.map((e) => e.id)).toEqual(["c-2", "c-1"]);
  });
});

describe("retention rail order", () => {
  it.each(["my_areas", "vote_power", "alphabetical"] as const)("sinks retention above awaiting under %s", (sort) => {
    const entries = [
      entry("retention", { title: "A judge", retention: true, vote_power_score: 99 }),
      entry("awaiting", { title: "A awaiting", awaiting_candidates: true }),
      entry("contest", { title: "Z contest", vote_power_score: 1 }),
      entry("later", { election_date: "2027-01-01" }),
    ];
    expect(sortRailEntries(entries, sort).map((e) => e.id)).toEqual(["contest", "retention", "later", "awaiting"]);
  });
});
