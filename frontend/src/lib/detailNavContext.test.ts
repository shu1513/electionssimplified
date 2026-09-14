import { describe, expect, it } from "vitest";
import { pagerNeighbors, readCandidateNavState, readElectionNavState } from "./detailNavContext";

const BACK_TO = { path: "/ballot?d=d-1&sort=district_size", label: "All elections" };

describe("readElectionNavState", () => {
  it("passes a full valid state through", () => {
    const state = { backTo: BACK_TO, contests: [{ id: "e-1", title: "Governor" }] };
    expect(readElectionNavState(state)).toEqual(state);
  });

  it("preserves list expansion through nested navigation and discards malformed dates", () => {
    const listState = { expandedRetentionDates: ["2026-11-03"], collapsedVotePowerGroups: ["2026-11-03:high"] };
    const election = { backTo: BACK_TO, listState };
    expect(readElectionNavState(election)).toEqual(election);
    expect(readCandidateNavState({ backTo: { path: "/elections/e-1", label: "Election" }, backState: election })?.backState).toEqual(election);
    for (const expandedRetentionDates of [null, "2026-11-03", [3], ["bad"]]) {
      expect(readElectionNavState({ backTo: BACK_TO, listState: { expandedRetentionDates } })).toEqual({ backTo: BACK_TO });
    }
  });

  it("validates vote-power disclosure state independently from retention state", () => {
    const read = (listState: unknown) => readElectionNavState({ backTo: BACK_TO, listState })?.listState;
    expect(read({ collapsedVotePowerGroups: ["2026-11-03:high"] })).toEqual({
      expandedRetentionDates: [], collapsedVotePowerGroups: ["2026-11-03:high"],
    });
    for (const groups of [null, "high", [3], ["2026-11-03:bad"], ["high"]]) {
      expect(read({ expandedRetentionDates: ["2026-11-03"], collapsedVotePowerGroups: groups })).toEqual({ expandedRetentionDates: ["2026-11-03"] });
      expect(read({ collapsedVotePowerGroups: groups })).toBeUndefined();
    }
  });

  it("returns null for junk, null, and missing backTo", () => {
    expect(readElectionNavState(null)).toBeNull();
    expect(readElectionNavState("nonsense")).toBeNull();
    expect(readElectionNavState({})).toBeNull();
    expect(readElectionNavState({ backTo: { path: "/ballot" } })).toBeNull();
    expect(readElectionNavState({ backTo: { path: "/ballot", label: "  " } })).toBeNull();
  });

  it("rejects non-internal back paths", () => {
    expect(readElectionNavState({ backTo: { path: "https://evil.example", label: "x" } })).toBeNull();
    expect(readElectionNavState({ backTo: { path: "//evil.example", label: "x" } })).toBeNull();
  });

  it("keeps a nested candidate backState and drops a malformed one alone", () => {
    const nested = { backTo: { path: "/candidates/c-1", label: "Jordan Voter" } };
    expect(readElectionNavState({ backTo: BACK_TO, backState: nested })).toEqual({
      backTo: BACK_TO,
      backState: nested,
    });
    expect(readElectionNavState({ backTo: BACK_TO, backState: { backTo: null } })).toEqual({
      backTo: BACK_TO,
    });
  });

  it("keeps the back link when only the contests list is malformed", () => {
    expect(readElectionNavState({ backTo: BACK_TO, contests: "not-a-list" })).toEqual({ backTo: BACK_TO });
    expect(
      readElectionNavState({ backTo: BACK_TO, contests: [{ id: "e-1", title: "Governor" }, { id: 7 }] })
    ).toEqual({ backTo: BACK_TO });
  });

  it("round-trips contest race_type and the engaged raceType tab", () => {
    const state = {
      backTo: BACK_TO,
      contests: [
        { id: "e-1", title: "Governor", race_type: "office" },
        { id: "q-1", title: "Measure A", race_type: "ballot_measure" },
      ],
      raceType: "ballot_measure",
    };
    expect(readElectionNavState(state)).toEqual(state);
  });

  it("drops an invalid race_type per entry and an invalid raceType alone", () => {
    // An unknown race_type withholds only that entry's field (disabling the
    // tabs, which need every entry typed) — never the entry or the list.
    expect(
      readElectionNavState({
        backTo: BACK_TO,
        contests: [
          { id: "e-1", title: "Governor", race_type: "banana" },
          { id: "q-1", title: "Measure A", race_type: "ballot_measure" },
        ],
        raceType: "banana",
      })
    ).toEqual({
      backTo: BACK_TO,
      contests: [
        { id: "e-1", title: "Governor" },
        { id: "q-1", title: "Measure A", race_type: "ballot_measure" },
      ],
    });
  });

  it("round-trips a valid rosterSort and drops an invalid one alone", () => {
    // rosterSort restores the election page's candidates-section order
    // after a candidate round trip; it shares the candidate rail's value
    // space, not the election rail's.
    const state = { backTo: BACK_TO, rosterSort: "alphabetical" };
    expect(readElectionNavState(state)).toEqual(state);
    expect(readElectionNavState({ backTo: BACK_TO, rosterSort: "vote_power" })).toEqual({
      backTo: BACK_TO,
    });
  });

  it("treats whitespace-only contest ids and titles as malformed", () => {
    // A whitespace-only id would build a broken href; a whitespace-only
    // title would render an invisible pager link.
    expect(
      readElectionNavState({ backTo: BACK_TO, contests: [{ id: "   ", title: "Governor" }] })
    ).toEqual({ backTo: BACK_TO });
    expect(
      readElectionNavState({ backTo: BACK_TO, contests: [{ id: "e-1", title: "   " }] })
    ).toEqual({ backTo: BACK_TO });
    expect(readElectionNavState({ backTo: BACK_TO, contests: [{ id: "e-1", title: "" }] })).toEqual({
      backTo: BACK_TO,
    });
  });
});

describe("readCandidateNavState", () => {
  const ELECTION_BACK = { path: "/elections/e-1", label: "Governor" };

  it("passes a full valid state through", () => {
    const state = {
      backTo: ELECTION_BACK,
      backState: { backTo: BACK_TO, contests: [{ id: "e-1", title: "Governor" }] },
      electionId: "e-1",
      candidates: [{ id: "c-1", name: "Jordan Voter" }],
    };
    expect(readCandidateNavState(state)).toEqual(state);
  });

  it("returns null only when backTo is unusable", () => {
    expect(readCandidateNavState(undefined)).toBeNull();
    expect(readCandidateNavState({ electionId: "e-1" })).toBeNull();
  });

  it("round-trips candidate stance keys and the engaged rail sort", () => {
    const state = {
      backTo: ELECTION_BACK,
      candidates: [
        {
          id: "c-1",
          name: "Jordan Voter",
          research_area_records: [{ research_area_id: "a-1", record_count: 2 }],
        },
      ],
      railSort: "my_issues",
    };
    expect(readCandidateNavState(state)).toEqual(state);
  });

  it("drops invalid stance keys per entry and an invalid railSort alone", () => {
    expect(
      readCandidateNavState({
        backTo: ELECTION_BACK,
        candidates: [
          { id: "c-1", name: "Jordan Voter", research_area_records: "junk" },
          {
            id: "c-2",
            name: "Riley Runner",
            research_area_records: [{ research_area_id: "a-1", record_count: 1 }],
          },
        ],
        railSort: "banana",
      })
    ).toEqual({
      backTo: ELECTION_BACK,
      candidates: [
        { id: "c-1", name: "Jordan Voter" },
        {
          id: "c-2",
          name: "Riley Runner",
          research_area_records: [{ research_area_id: "a-1", record_count: 1 }],
        },
      ],
    });
  });

  it("rejects non-count record_count values per entry", () => {
    // record_count feeds the sort's record-volume tiebreak; NaN there makes
    // the comparator return NaN and the order arbitrary. Only non-negative
    // integers survive — anything else drops that entry's records alone.
    const entry = (id: string, recordCount: unknown) => ({
      id,
      name: id,
      research_area_records: [{ research_area_id: "a-1", record_count: recordCount }],
    });
    expect(
      readCandidateNavState({
        backTo: ELECTION_BACK,
        candidates: [entry("c-1", Number.NaN), entry("c-2", -1), entry("c-3", 1.5), entry("c-4", 3)],
      })
    ).toEqual({
      backTo: ELECTION_BACK,
      candidates: [
        { id: "c-1", name: "c-1" },
        { id: "c-2", name: "c-2" },
        { id: "c-3", name: "c-3" },
        { id: "c-4", name: "c-4", research_area_records: [{ research_area_id: "a-1", record_count: 3 }] },
      ],
    });
  });

  it("degrades each optional field independently", () => {
    expect(
      readCandidateNavState({
        backTo: ELECTION_BACK,
        backState: { backTo: { path: "not-internal", label: "x" } },
        electionId: 42,
        candidates: [{ id: "c-1" }],
      })
    ).toEqual({ backTo: ELECTION_BACK });
  });

  it("treats whitespace-only candidate ids and names as malformed", () => {
    expect(
      readCandidateNavState({ backTo: ELECTION_BACK, candidates: [{ id: " ", name: "Jordan Voter" }] })
    ).toEqual({ backTo: ELECTION_BACK });
    expect(
      readCandidateNavState({ backTo: ELECTION_BACK, candidates: [{ id: "c-1", name: " " }] })
    ).toEqual({ backTo: ELECTION_BACK });
  });
});

describe("pagerNeighbors", () => {
  const LIST = [
    { id: "e-1", title: "Governor" },
    { id: "e-2", title: "Mayor" },
    { id: "e-3", title: "Sheriff" },
  ];

  it("returns both neighbors for a middle entry and null slots at the ends", () => {
    expect(pagerNeighbors(LIST, "e-2")).toEqual({ prev: LIST[0], next: LIST[2] });
    expect(pagerNeighbors(LIST, "e-1")).toEqual({ prev: null, next: LIST[1] });
    expect(pagerNeighbors(LIST, "e-3")).toEqual({ prev: LIST[1], next: null });
  });

  it("returns null with no list, a short list, or the current id missing", () => {
    expect(pagerNeighbors(undefined, "e-1")).toBeNull();
    expect(pagerNeighbors([LIST[0]], "e-1")).toBeNull();
    // A stale snapshot that no longer contains the page must not page.
    expect(pagerNeighbors(LIST, "e-999")).toBeNull();
  });
});

it("preserves a valid retention flag and discards malformed flags", () => {
  expect(readElectionNavState({ backTo: BACK_TO, contests: [
    { id: "a", title: "Judge A", retention: true },
    { id: "b", title: "Judge B", retention: "true" },
  ] })?.contests).toEqual([{ id: "a", title: "Judge A", retention: true }, { id: "b", title: "Judge B" }]);
});
