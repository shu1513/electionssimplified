import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoPickElectionResult, ElectionChoice, Me } from "@voteapp/api-client";
import { AutoPickFillControl } from "./AutoPickFillControl";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { electionSummary } from "../test/fixtures";
import { renderRoutes } from "../test/render";

// Same mocking rationale as AutoPickControl.test: useMyResearchAreas forks
// on the session, and renderRoutes seeds nothing — a real useMe would stay
// loading forever.
const SIGNED_IN: Me = {
  id: "user-1",
  email: "voter@example.com",
  first_name: "Vo",
  email_verified: true,
  accepted_terms_version: null,
  has_password: true,
};
vi.mock("@voteapp/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voteapp/api-client")>();
  return {
    ...actual,
    useMe: () => ({ me: SIGNED_IN, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const DATE = "2026-11-03";
const E_EMPTY = "11111111-1111-4111-8111-111111111111";
const E_PICKED = "22222222-2222-4222-8222-222222222222";
const E_MEASURE = "33333333-3333-4333-8333-333333333333";
const E_PAST = "44444444-4444-4444-8444-444444444444";
const CAND_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const AREA = "aaaaaaaa-0000-4000-8000-000000000001";

const THREE_PREFERENCES = {
  preferences: [1, 2, 3].map((rank) => ({
    research_area_id: `${AREA.slice(0, -1)}${rank}`,
    slug: `issue-${rank}`,
    name: `Issue ${rank}`,
    description: null,
    rank,
    direction: "support",
    hard_veto: false,
  })),
};

function choice(overrides: Partial<ElectionChoice>): ElectionChoice {
  return {
    election_id: E_PICKED,
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function noPickResult(electionId: string, reason: AutoPickElectionResult["reason"]): AutoPickElectionResult {
  return {
    election_id: electionId,
    race_type: "office",
    outcome: "no_pick",
    reason,
    picked_candidate_ids: [],
    measure_position: null,
    shortlist_candidate_ids: [],
    candidates: [],
    measure_per_issue: [],
    unresearched: [],
  };
}

function pickedResult(electionId: string): AutoPickElectionResult {
  return { ...noPickResult(electionId, null), outcome: "picked", picked_candidate_ids: [CAND_A] };
}

const ELECTIONS = [
  electionSummary({ id: E_EMPTY, official_ballot_title: "Mayor" }),
  electionSummary({ id: E_PICKED, official_ballot_title: "Governor" }),
  electionSummary({ id: E_MEASURE, official_ballot_title: "Measure Q", race_type: "ballot_measure" }),
];

function renderControl({
  elections = ELECTIONS,
  choices = [] as ElectionChoice[],
  onResults,
}: {
  elections?: typeof ELECTIONS;
  choices?: ElectionChoice[];
  onResults?: (byElectionId: Map<string, AutoPickElectionResult> | null) => void;
} = {}) {
  const byId = new Map(choices.map((entry) => [entry.election_id, entry]));
  return renderRoutes([
    {
      path: "/",
      element: (
        <AutoPickFillControl
          date={DATE}
          elections={elections}
          choices={choices}
          choiceByElectionId={byId}
          onResults={onResults}
        />
      ),
    },
    { path: "/me/settings", element: <p>Settings page</p> },
    { path: "/elections/:electionId", element: <p>Election page</p> },
  ]);
}

/** The button disables while the preferences load; click only once ready. */
async function clickFill() {
  const button = await screen.findByRole("button", { name: "Auto-fill empty picks by my issues" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

function requestsTo(fetchMock: ReturnType<typeof stubApiRoutes>, pathname: string) {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input), "http://localhost").pathname === pathname)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

describe("AutoPickFillControl", () => {
  it("renders nothing when every race is decided and nothing is auto-picked", async () => {
    stubApiRoutes({ "/api/me/research-area-preferences": { body: THREE_PREFERENCES } });
    const { container } = renderControl({
      elections: [ELECTIONS[1]!],
      choices: [
        choice({ picks: [{ candidate_id: CAND_A, display_name: "Alice", candidacy_status: "declared" }] }),
      ],
    });
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });

  it("fills only the empty races and hands the per-race results to the caller", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/auto-picks": {
        body: {
          results: [pickedResult(E_EMPTY), noPickResult(E_MEASURE, "insufficient_evidence")],
        },
      },
    });
    const onResults = vi.fn();
    renderControl({
      choices: [
        choice({ picks: [{ candidate_id: CAND_A, display_name: "Alice", candidacy_status: "declared" }] }),
      ],
      onResults,
    });
    // The decided race stays out of the request; no result list renders
    // here — the caller annotates its own race rows from the map.
    await clickFill();

    // Two calls: null up front (stale-annotation wipe), then the map.
    await waitFor(() => expect(onResults).toHaveBeenCalledTimes(2));
    expect(onResults.mock.calls[0]?.[0]).toBeNull();
    const byElectionId = onResults.mock.lastCall?.[0] as Map<string, AutoPickElectionResult>;
    expect(byElectionId.get(E_EMPTY)?.outcome).toBe("picked");
    expect(byElectionId.get(E_MEASURE)?.reason).toBe("insufficient_evidence");
    expect(requestsTo(fetchMock, "/api/me/auto-picks")).toEqual([
      { election_ids: [E_EMPTY, E_MEASURE], mode: "fill_empty" },
    ]);
  });

  it("sends large ballots in chunks of 200", async () => {
    const many = Array.from({ length: 201 }, (_, index) =>
      electionSummary({
        id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        official_ballot_title: `Race ${index}`,
      })
    );
    const fetchMock = stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/auto-picks": (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { election_ids: string[] };
        return { body: { results: body.election_ids.map((id) => pickedResult(id)) } };
      },
    });
    const onResults = vi.fn();
    renderControl({ elections: many, onResults });
    await clickFill();

    await waitFor(() => expect(onResults).toHaveBeenCalledTimes(2));
    expect((onResults.mock.lastCall?.[0] as Map<string, unknown>).size).toBe(201);
    const bodies = requestsTo(fetchMock, "/api/me/auto-picks");
    expect(bodies.map((body) => body.election_ids.length)).toEqual([200, 1]);
  });

  it("prompts for the issue floor instead of calling the API", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderControl();
    await clickFill();

    expect(await screen.findByText(/Rank at least 3 issues first/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rank your issues" })).toHaveAttribute("href", "/me/settings#my-issues");
    expect(requestsTo(fetchMock, "/api/me/auto-picks")).toEqual([]);
  });

  it("clears via one server-side DELETE, never a per-row loop", async () => {
    // A PUT per row would trip the global per-IP rate limit on big ballots
    // and race stale cache from another tab; the server scopes the delete
    // to origin = 'auto' atomically.
    const fetchMock = stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/auto-picks": { body: { cleared_count: 2 } },
    });
    renderControl({
      elections: [],
      choices: [
        choice({
          picks: [
            { candidate_id: CAND_A, display_name: "Alice", candidacy_status: "declared", origin: "auto" },
          ],
        }),
        choice({
          election_id: E_MEASURE,
          race_type: "ballot_measure",
          measure_position: "yes",
          measure_origin: "auto",
        }),
      ],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Clear auto picks" }));

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(
        ([input, init]) =>
          new URL(String(input), "http://localhost").pathname === "/api/me/auto-picks" &&
          init?.method === "DELETE"
      );
      expect(deletes).toHaveLength(1);
      // Scoped to this card's date: other dates' auto picks must survive.
      expect(new URL(String(deletes[0]?.[0]), "http://localhost").searchParams.get("election_date")).toBe(DATE);
    });
    expect(requestsTo(fetchMock, "/api/me/election-choices")).toEqual([]);
  });

  it("replaces the fill button with Clear once the date has auto picks, even with races still open", async () => {
    // A rerun over the races the engine already left open would return the
    // same "not enough evidence"; Clear → fill again is the useful path.
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
    });
    renderControl({
      choices: [
        choice({
          picks: [
            { candidate_id: CAND_A, display_name: "Alice", candidacy_status: "declared", origin: "auto" },
          ],
        }),
      ],
    });
    expect(await screen.findByRole("button", { name: "Clear auto picks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-fill empty picks by my issues" })).toBeNull();
    expect(screen.queryByRole("button", { name: "How does this work?" })).toBeNull();
  });

  // The plain-English note sits behind an (i) beside the fill button
  // (HowItWorksPopover); it leaves with the fill button, so a date that
  // only offers Clear shows no glyph (asserted above).
  it("explains how the fill works in a popover beside the button", async () => {
    stubApiRoutes({ "/api/me/research-area-preferences": { body: THREE_PREFERENCES } });
    renderControl();
    await screen.findByRole("button", { name: "Auto-fill empty picks by my issues" });
    const how = screen.getByRole("button", { name: "How does this work?" });
    expect(how).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Picks you made yourself are not changed/)).toBeNull();
    const user = userEvent.setup();
    await user.click(how);
    expect(how).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Picks you made yourself are not changed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Picks you made yourself are not changed/)).toBeNull();
    expect(how).toHaveFocus();
  });

  it("hides the clear button when the only auto picks are on another date", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
    });
    const { container } = renderControl({
      elections: [],
      choices: [
        choice({
          election_id: E_PAST,
          election_date: "2026-05-05",
          picks: [
            { candidate_id: CAND_A, display_name: "Alice", candidacy_status: "declared", origin: "auto" },
          ],
        }),
      ],
    });
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });

  it("keeps the partial-write warning on API errors — the batch commits election by election", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/auto-picks": apiError(429, "rate_limited", "Too many requests. Try again later."),
    });
    const onResults = vi.fn();
    renderControl({ onResults });
    await clickFill();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests. Try again later.");
    expect(alert).toHaveTextContent("Some races may already be filled — check the rows below.");
    // The run cleared the previous annotations up front and never replaced
    // them: a stale "not enough evidence" must not outlive a failed rerun.
    expect(onResults).toHaveBeenCalledExactlyOnceWith(null);
  });
});
