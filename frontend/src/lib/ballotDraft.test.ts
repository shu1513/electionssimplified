import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "@voteapp/api-client";
import {
  allRacesDecided,
  clearBallotDraft,
  draftChoicesByElectionId,
  draftPickCount,
  draftProgress,
  flushBallotDraftToAccount,
  hasDraftPicks,
  nearestUpcomingTarget,
  pinDraftBallotContext,
  readBallotDraft,
  setDraftBallotContext,
  setDraftCandidateChoice,
  setDraftMeasureChoice,
  unpinDraftBallotContextForTests,
} from "./ballotDraft";

vi.mock("@voteapp/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voteapp/api-client")>();
  return { ...actual, apiRequest: vi.fn() };
});

const mockedApiRequest = vi.mocked(apiRequest);

const RACE = { electionId: "e1", raceTitle: "Governor", electionDate: "2026-11-03" };
// "Today" for progress: the fixture races are upcoming from here.
const TODAY = "2026-08-01";

// Writes raw bytes to storage and fires the cross-tab storage event so the
// module drops its in-memory cache and actually re-parses — without the
// event, readBallotDraft() serves the cached draft and a parse test passes
// no matter what the bytes say.
function seedStorage(value: string) {
  window.localStorage.setItem("voteapp_ballot_draft", value);
  window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
}

function pickJane(chosen = true, seatsToFill: number | null = null) {
  setDraftCandidateChoice({
    ...RACE,
    seatsToFill,
    candidateId: "c1",
    candidateName: "Jane Doe",
    chosen,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  clearBallotDraft();
  mockedApiRequest.mockReset();
});

afterEach(() => {
  clearBallotDraft();
});

describe("ballotDraft store", () => {
  it("starts empty and persists a candidate pick to localStorage", () => {
    expect(hasDraftPicks(readBallotDraft())).toBe(false);
    pickJane();
    const stored = JSON.parse(window.localStorage.getItem("voteapp_ballot_draft") ?? "{}");
    expect(stored.choices.e1.picks).toEqual([
      { candidate_id: "c1", display_name: "Jane Doe", candidacy_status: "active" },
    ]);
    expect(hasDraftPicks(readBallotDraft())).toBe(true);
  });

  it("single-seat picks behave as a radio (replace), unpick removes the row", () => {
    pickJane();
    setDraftCandidateChoice({ ...RACE, seatsToFill: 1, candidateId: "c2", candidateName: "John Roe", chosen: true });
    const row = readBallotDraft().choices.e1;
    expect(row.picks.map((pick) => pick.candidate_id)).toEqual(["c2"]);
    setDraftCandidateChoice({ ...RACE, seatsToFill: 1, candidateId: "c2", candidateName: "John Roe", chosen: false });
    expect(readBallotDraft().choices.e1).toBeUndefined();
  });

  it("multi-seat picks append to the seat cap and no-op past it", () => {
    pickJane(true, 2);
    setDraftCandidateChoice({ ...RACE, seatsToFill: 2, candidateId: "c2", candidateName: "John Roe", chosen: true });
    setDraftCandidateChoice({ ...RACE, seatsToFill: 2, candidateId: "c3", candidateName: "Ann Poe", chosen: true });
    expect(readBallotDraft().choices.e1.picks.map((pick) => pick.candidate_id)).toEqual(["c1", "c2"]);
  });

  it("sets and clears a measure position; clearing removes the row", () => {
    setDraftMeasureChoice({ electionId: "m1", raceTitle: "Prop A", electionDate: "2026-11-03", position: "no" });
    expect(readBallotDraft().choices.m1.measure_position).toBe("no");
    expect(readBallotDraft().choices.m1.race_type).toBe("ballot_measure");
    setDraftMeasureChoice({ electionId: "m1", raceTitle: "Prop A", electionDate: "2026-11-03", position: null });
    expect(readBallotDraft().choices.m1).toBeUndefined();
  });

  it("a Yes/No answer replaces a legacy judge pick on the same race, so clearing it clears the row", () => {
    pickJane();
    setDraftMeasureChoice({ ...RACE, position: "no", raceType: "office" });
    const row = readBallotDraft().choices.e1;
    expect(row.picks).toEqual([]);
    expect(row.measure_position).toBe("no");
    expect(row.race_type).toBe("office");
    setDraftMeasureChoice({ ...RACE, position: null, raceType: "office" });
    expect(readBallotDraft().choices.e1).toBeUndefined();
  });

  it("treats corrupt or foreign storage as an empty draft", () => {
    seedStorage("{not json");
    expect(readBallotDraft()).toEqual({ v: 1, district_ids: [], target: null, choices: {} });
    seedStorage(JSON.stringify({ v: 99, choices: {} }));
    expect(readBallotDraft().choices).toEqual({});
    seedStorage(JSON.stringify([{ v: 1 }]));
    expect(readBallotDraft().choices).toEqual({});
  });

  it("sanitizes malformed drafts field by field instead of crashing later readers", () => {
    // choices: null passes a bare typeof-object check; district_ids missing
    // would throw on .length in the header badge hook on every route.
    seedStorage(JSON.stringify({ v: 1, choices: null }));
    expect(readBallotDraft()).toEqual({ v: 1, district_ids: [], target: null, choices: {} });

    const goodRow = {
      election_id: "e1",
      race_type: "office",
      official_ballot_title: "Governor",
      election_date: "2026-11-03",
      seats_to_fill: null,
      picks: [{ candidate_id: "c1", display_name: "Jane Doe", candidacy_status: "active" }],
      measure_position: null,
      updated_at: "2026-08-12T00:00:00.000Z",
    };
    seedStorage(
      JSON.stringify({
        v: 1,
        // Non-UUID strings are dropped alongside non-strings: district ids
        // go verbatim into /api/ballot query params, where one malformed id
        // 400s the request and /draft shows an error box instead of its
        // address-search fallback. The check mirrors the backend's
        // version/variant-pinned pattern — the nil UUID and a version-6
        // value are valid hex shapes the server still rejects.
        district_ids: [
          "11111111-2222-4333-8444-555555555555",
          "d1",
          42,
          null,
          "00000000-0000-0000-0000-000000000000",
          "11111111-2222-6333-8444-555555555555",
        ],
        target: { bogus: true },
        choices: {
          e1: goodRow,
          bad1: { election_id: "bad1" }, // no picks array, no title
          bad2: { ...goodRow, election_id: "bad2", picks: [{ candidate_id: 7 }], measure_position: "maybe" },
        },
      })
    );
    const draft = readBallotDraft();
    expect(draft.district_ids).toEqual(["11111111-2222-4333-8444-555555555555"]);
    expect(draft.target).toBeNull();
    // The mangled rows die alone; the good pick survives them.
    expect(Object.keys(draft.choices)).toEqual(["e1"]);
    expect(draft.choices.e1).toEqual(goodRow);
    expect(draftPickCount(draft)).toBe(1);
    expect(draftProgress(draft, TODAY)).toBeNull();
  });

  it("caps district ids at the backend's 50-id limit", () => {
    // A 51st id would 400 the whole /api/ballot request exactly like a
    // malformed one; real ballots store far fewer, so trimming only ever
    // discards corrupt bytes.
    const ids = Array.from(
      { length: 60 },
      (_, i) => `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`
    );
    seedStorage(JSON.stringify({ v: 1, district_ids: ids, target: null, choices: {} }));
    expect(readBallotDraft().district_ids).toHaveLength(50);
  });

  it("computes progress against the stored target", () => {
    setDraftBallotContext(["d1"], { election_date: "2026-11-03", election_ids: ["e1", "m1", "e9"] });
    expect(draftProgress(readBallotDraft(), TODAY)).toEqual({
      election_date: "2026-11-03",
      election_ids: ["e1", "m1", "e9"],
      picked: 0,
      total: 3,
      complete: false,
    });
    pickJane();
    setDraftMeasureChoice({ electionId: "m1", raceTitle: "Prop A", electionDate: "2026-11-03", position: "yes" });
    expect(draftProgress(readBallotDraft(), TODAY)).toMatchObject({ picked: 2, total: 3, complete: false });
    setDraftCandidateChoice({
      electionId: "e9",
      raceTitle: "Sheriff",
      electionDate: "2026-11-03",
      seatsToFill: null,
      candidateId: "c9",
      candidateName: "Pat Law",
      chosen: true,
    });
    expect(draftProgress(readBallotDraft(), TODAY)).toMatchObject({ picked: 3, total: 3, complete: true });
    // Picks outside the target don't inflate the numerator.
    setDraftMeasureChoice({ electionId: "m2", raceTitle: "Prop B", electionDate: "2027-03-02", position: "no" });
    expect(draftProgress(readBallotDraft(), TODAY)?.picked).toBe(3);
  });

  it("drops the progress once the target day has passed (the snapshot only refreshes on a ballot load)", () => {
    setDraftBallotContext(["d1"], { election_date: "2026-11-03", election_ids: ["e1"] });
    pickJane();
    // Election day itself still counts as upcoming, matching nearestDayPickProgress.
    expect(draftProgress(readBallotDraft(), "2026-11-03")).toMatchObject({ complete: true });
    expect(draftProgress(readBallotDraft(), "2026-11-04")).toBeNull();
  });

  it("calls a day finished only when every listed race is decided", () => {
    pickJane();
    const choices = draftChoicesByElectionId(readBallotDraft());
    expect(allRacesDecided([{ id: "e1" }], choices)).toBe(true);
    expect(allRacesDecided([{ id: "e1" }, { id: "e2" }], choices)).toBe(false);
    expect(allRacesDecided([], choices)).toBe(false);
    expect(allRacesDecided([{ id: "e1" }], undefined)).toBe(false);
  });

  it("targets the nearest upcoming day's races from a full election list", () => {
    const elections = [
      { id: "past", election_date: "2026-06-02" },
      { id: "nov-a", election_date: "2026-11-03" },
      { id: "sep", election_date: "2026-09-15" },
      { id: "nov-b", election_date: "2026-11-03" },
    ].map((election) => ({ ...election, race_type: "office", official_ballot_title: election.id }));
    expect(nearestUpcomingTarget(elections, "2026-08-01")).toEqual({
      election_date: "2026-09-15",
      election_ids: ["sep"],
    });
    expect(nearestUpcomingTarget(elections, "2026-10-01")).toEqual({
      election_date: "2026-11-03",
      election_ids: ["nov-a", "nov-b"],
    });
    expect(nearestUpcomingTarget(elections, "2026-11-04")).toBeNull();
  });

  it("exposes draft rows as an ElectionChoice map", () => {
    pickJane();
    const choice = draftChoicesByElectionId(readBallotDraft()).get("e1");
    expect(choice?.official_ballot_title).toBe("Governor");
    expect(choice?.race_type).toBe("office");
    expect(choice?.election_date).toBe("2026-11-03");
  });
});

describe("pinned ballot context (newsroom embed)", () => {
  const CITY_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const CITY_B = "bbbbbbbb-2222-4222-8222-222222222222";
  const TARGET_A = { election_date: "2026-11-03", election_ids: ["e1"] };

  afterEach(() => {
    unpinDraftBallotContextForTests();
  });

  it("keeps this box's districts and target when another box rewrites the shared draft", () => {
    pinDraftBallotContext([CITY_A], TARGET_A);
    pickJane();
    // A second box on the same publisher site stores its own context.
    seedStorage(
      JSON.stringify({
        v: 1,
        district_ids: [CITY_B],
        target: { election_date: "2026-11-03", election_ids: ["e9", "e10"] },
        choices: readBallotDraft().choices,
      })
    );
    const draft = readBallotDraft();
    expect(draft.district_ids).toEqual([CITY_A]);
    expect(draft.target).toEqual(TARGET_A);
    // Picks stay shared.
    expect(draftPickCount(draft)).toBe(1);
    expect(draftProgress(draft, TODAY)).toMatchObject({ picked: 1, total: 1, complete: true });
  });

  it("ignores a page load that would refresh the context", () => {
    pinDraftBallotContext([CITY_A], TARGET_A);
    setDraftBallotContext([CITY_A], { election_date: "2026-10-06", election_ids: ["e1", "e2"] });
    expect(readBallotDraft().target).toEqual(TARGET_A);
  });
});

describe("flushBallotDraftToAccount", () => {
  it("replays every decided row through PUT and clears the draft", async () => {
    pickJane();
    setDraftMeasureChoice({ electionId: "m1", raceTitle: "Prop A", electionDate: "2026-11-03", position: "yes" });
    mockedApiRequest.mockResolvedValue({});
    await flushBallotDraftToAccount();
    const bodies = mockedApiRequest.mock.calls.map(([, options]) => (options as { body: unknown }).body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { election_id: "e1", candidate_id: "c1", chosen: true },
        { election_id: "m1", measure_position: "yes" },
      ])
    );
    expect(hasDraftPicks(readBallotDraft())).toBe(false);
  });

  it("skips business rejections (400/404) but keeps flushing, then clears", async () => {
    pickJane();
    setDraftMeasureChoice({ electionId: "m1", raceTitle: "Prop A", electionDate: "2026-11-03", position: "yes" });
    mockedApiRequest
      .mockRejectedValueOnce(new ApiError(400, "election_closed", "This election has ended"))
      .mockResolvedValue({});
    await flushBallotDraftToAccount();
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
    expect(hasDraftPicks(readBallotDraft())).toBe(false);
  });

  it("keeps the draft when transport fails so a later session can retry", async () => {
    pickJane();
    mockedApiRequest.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(flushBallotDraftToAccount()).rejects.toThrow("Failed to fetch");
    expect(hasDraftPicks(readBallotDraft())).toBe(true);
  });

  it("aborts and keeps the draft on auth, throttling, and server errors", async () => {
    // Only a 400/404 is the server's verdict on the row itself. 401 (session
    // died), 429 (the sequential PUT burst got throttled), and 5xx are
    // failures of the PASS — swallowing them and then clearing would delete
    // picks that never landed anywhere.
    pickJane();
    for (const [status, code] of [
      [401, "unauthorized"],
      [429, "rate_limited"],
      [500, "internal_error"],
    ] as const) {
      mockedApiRequest.mockReset();
      mockedApiRequest.mockRejectedValue(new ApiError(status, code, code));
      await expect(flushBallotDraftToAccount()).rejects.toThrow(code);
      expect(hasDraftPicks(readBallotDraft())).toBe(true);
    }
  });
});

it("keeps retention target metadata through storage without counting it", () => {
  const elections = [
    { id: "a", election_date: "2026-11-03", race_type: "office", official_ballot_title: "Shall Judge A be retained?" },
    { id: "mayor", election_date: "2026-11-03", race_type: "office", official_ballot_title: "Mayor" },
    { id: "b", election_date: "2026-11-03", race_type: "office", official_ballot_title: "Shall Judge B be retained?" },
  ];
  const target = nearestUpcomingTarget(elections, "2026-08-01");
  expect(target).toEqual({ election_date: "2026-11-03", election_ids: ["mayor"], retention_ids: ["a", "b"] });
  setDraftBallotContext([], target);
  window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
  expect(readBallotDraft().target).toEqual(target);
  expect(draftProgress(readBallotDraft(), "2026-08-01")).toMatchObject({ picked: 0, total: 1, election_ids: ["mayor"] });
  expect(nearestUpcomingTarget(elections.slice(0, 2), "2026-08-01")?.election_ids).toEqual(["a", "mayor"]);
});
