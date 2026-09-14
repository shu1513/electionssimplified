import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import type { ElectionChoice } from "@voteapp/api-client";
import { DraftPage } from "./DraftPage";
import { ElectionPage } from "./ElectionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionDetail, electionSummary, retentionElection, ME_VERIFIED } from "../test/fixtures";
import { readBallotDraft } from "../lib/ballotDraft";

function renderDraft() {
  return renderRoutes(
    [
      { path: "/draft", element: <DraftPage /> },
      { path: "/", element: <p>Home placeholder</p> },
      { path: "/me/picks", element: <p>Picks placeholder</p> },
      { path: "/elections/:electionId", element: <p>Election page</p> },
      { path: "/candidates/:candidateId", element: <p>Candidate page</p> },
    ],
    "/draft"
  );
}

function draftChoice(overrides: Partial<ElectionChoice> = {}): ElectionChoice {
  return {
    election_id: "e-1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "active" }],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

// Seeds the localStorage draft and fires the storage event so the module
// cache re-reads the bytes (same pattern as ballotDraft.test.ts).
function seedDraft(draft: {
  district_ids: string[];
  target: { election_date: string; election_ids: string[] } | null;
  choices: Record<string, ElectionChoice>;
}) {
  window.localStorage.setItem("voteapp_ballot_draft", JSON.stringify({ v: 1, ...draft }));
  window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
}

// Frozen clock, same reason as PicksPage.test: the upcoming/past split runs
// against the real date and the 2026-11-03 fixtures must stay upcoming.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const GUEST = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

describe("DraftPage", () => {
  it("redirects signed-in visitors to My Picks", async () => {
    stubApiRoutes({ "/api/me": { body: ME_VERIFIED } });
    renderDraft();
    expect(await screen.findByText("Picks placeholder")).toBeInTheDocument();
  });

  it("points an empty draft at the address search", async () => {
    stubApiRoutes(GUEST);
    renderDraft();
    expect(await screen.findByText("Your ballot draft is empty.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start with your address" })).toHaveAttribute("href", "/");
    // No CTA without a pick to save.
    expect(screen.queryByRole("link", { name: "Sign up free to save your picks" })).not.toBeInTheDocument();
    // No ballot to go back to either — the address link is the only exit.
    expect(screen.queryByRole("navigation", { name: "Draft navigation" })).not.toBeInTheDocument();
  });

  it("renders the ballot's date card from the draft, share-free, with the signup CTA", async () => {
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1", "e-2"] },
      choices: { "e-1": draftChoice() },
    });
    stubApiRoutes({
      ...GUEST,
      "/api/ballot": {
        body: ballotSummary([
          electionSummary(),
          electionSummary({ id: "e-2", official_ballot_title: "Mayor" }),
        ]),
      },
    });
    renderDraft();

    expect(await screen.findByRole("heading", { name: "November 3, 2026" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "1 of 2 races decided" })).toBeInTheDocument();
    // Not finished: no milestone, no seen marker.
    expect(screen.queryByRole("region", { name: /election draft milestone/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("voteapp_draft_complete_seen")).toBeNull();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mayor — no pick yet" })).toBeInTheDocument();
    // Account-only machinery stays off the guest page.
    expect(screen.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign up free to save your picks" })).toBeInTheDocument();
    // Every draft pick is on a card — no leftover section.
    expect(screen.queryByText("Other saved picks")).not.toBeInTheDocument();
    // The way back to the ballot: the detail pages' top bar, back slot only,
    // pointing at the draft's own districts.
    const back = screen.getByRole("link", { name: "Back to My elections" });
    expect(back).toHaveAttribute("href", "/ballot?d=dddddddd-1111-4111-8111-111111111111");
    expect(screen.getByRole("navigation", { name: "Draft navigation" })).toContainElement(back);
  });

  it("refreshes the draft's progress target from the loaded ballot, like /ballot does", async () => {
    // A stale target (yesterday's snapshot: one race) with today's ballot
    // showing two; without the refresh the header would keep counting to 1.
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1"] },
      choices: { "e-1": draftChoice() },
    });
    stubApiRoutes({
      ...GUEST,
      "/api/ballot": {
        body: ballotSummary([
          electionSummary({ id: "e-9", election_date: "2026-06-02", official_ballot_title: "Past primary" }),
          electionSummary(),
          electionSummary({ id: "e-2", official_ballot_title: "Mayor" }),
        ]),
      },
    });
    renderDraft();
    expect(await screen.findByRole("progressbar", { name: "1 of 2 races decided" })).toBeInTheDocument();
    expect(readBallotDraft().target).toEqual({ election_date: "2026-11-03", election_ids: ["e-1", "e-2"] });
    expect(readBallotDraft().district_ids).toEqual(["dddddddd-1111-4111-8111-111111111111"]);
  });

  it("shows the milestone with the sign-up link once every race has a pick, in both views", async () => {
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1", "e-2"] },
      choices: {
        "e-1": draftChoice(),
        "e-2": draftChoice({ election_id: "e-2", official_ballot_title: "Mayor" }),
      },
    });
    stubApiRoutes({
      ...GUEST,
      "/api/ballot": {
        body: ballotSummary([electionSummary(), electionSummary({ id: "e-2", official_ballot_title: "Mayor" })]),
      },
    });
    renderDraft();

    const milestone = await screen.findByRole("region", { name: "November 3, 2026 election draft milestone" });
    expect(milestone).toHaveTextContent("You have completed your November 3, 2026 election draft.");
    expect(milestone).not.toHaveTextContent(/decided/);
    // ONE sign-up link on the page: the milestone's, with the device hint;
    // the bottom CTA steps aside rather than repeat it.
    expect(screen.getAllByRole("link", { name: "Sign up free to save your picks" })).toHaveLength(1);
    expect(milestone).toContainElement(screen.getByRole("link", { name: "Sign up free to save your picks" }));
    expect(milestone).toHaveTextContent("Your draft lives only on this device until you sign up.");
    // Reading it here counts as seeing the day: the header notice must not
    // fire for it later.
    expect(JSON.parse(window.localStorage.getItem("voteapp_draft_complete_seen") ?? "[]")).toEqual(["2026-11-03"]);
    expect(JSON.parse(window.localStorage.getItem("voteapp_draft_milestone_seen") ?? "[]")).toEqual(["2026-11-03"]);

    // Same fake-timer-aware user-event setup as the ballot-view test below.
    const user = (await import("@testing-library/user-event")).default.setup({
      advanceTimers: vi.advanceTimersByTime,
    });
    await user.click(screen.getByRole("button", { name: "Ballot preview" }));
    expect(await screen.findByRole("heading", { name: /Ballot preview — November 3, 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "November 3, 2026 election draft milestone" })).toBeInTheDocument();
  });

  it("shows the milestone once per browser; later visits get the bottom sign-up CTA back", async () => {
    window.localStorage.setItem("voteapp_draft_milestone_seen", JSON.stringify(["2026-11-03"]));
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1", "e-2"] },
      choices: {
        "e-1": draftChoice(),
        "e-2": draftChoice({ election_id: "e-2", official_ballot_title: "Mayor" }),
      },
    });
    stubApiRoutes({
      ...GUEST,
      "/api/ballot": {
        body: ballotSummary([electionSummary(), electionSummary({ id: "e-2", official_ballot_title: "Mayor" })]),
      },
    });
    renderDraft();
    expect(await screen.findByRole("progressbar", { name: "2 of 2 races decided" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /election draft milestone/ })).not.toBeInTheDocument();
    // Still exactly one sign-up button — the page's own, since the
    // milestone (which would carry it) stays away.
    expect(screen.getAllByRole("link", { name: "Sign up free to save your picks" })).toHaveLength(1);
    expect(screen.getByText("Your draft lives only on this device until you sign up.")).toBeInTheDocument();
  });

  it("gives guests the ballot view over the public preview endpoint", async () => {
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1"] },
      choices: { "e-1": draftChoice() },
    });
    // ONE fetch serves both views: the preview payload is also the list
    // payload, so List and Ballot preview share the same order by design.
    const fetchMock = stubApiRoutes({
      ...GUEST,
      "/api/ballot": {
        body: ballotSummary([
          electionSummary({
            preview: {
              seats_to_fill: null,
              candidates: [
                {
                  candidate_election_id: "ce-1",
                  candidate_id: "c-1",
                  display_name: "Jane Smith",
                  party: "Democratic",
                  is_incumbent: false,
                  status: "declared",
                },
              ],
              measure: null,
            },
          }),
        ]),
      },
    });
    const user = (await import("@testing-library/user-event")).default.setup({
      advanceTimers: vi.advanceTimersByTime,
    });
    renderDraft();

    await user.click(await screen.findByRole("button", { name: "Ballot preview" }));

    expect(await screen.findByRole("heading", { name: /Ballot preview — November 3, 2026/ })).toBeInTheDocument();
    expect(screen.getByText("Not an official ballot")).toBeInTheDocument();
    expect(screen.getByText("My pick")).toBeInTheDocument();
    // Guest preview rides the PUBLIC endpoint with the same ordering
    // contract — and toggling views must NOT refetch: one payload backs
    // both List and Ballot preview.
    const ballotCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/ballot?"));
    expect(ballotCalls).toHaveLength(1);
    expect(String(ballotCalls[0][0])).toContain("district_ids=dddddddd-1111-4111-8111-111111111111");
    expect(String(ballotCalls[0][0])).toContain("include=preview");
    expect(String(ballotCalls[0][0])).toContain("sort=state_baseline");
    expect(String(ballotCalls[0][0])).toContain("followed_first=false");
    // The signup CTA survives the view switch — the sheet IS the pitch.
    // Exactly one: this one-race draft is finished, so the milestone above
    // the toggle carries the link and the bottom CTA steps aside.
    expect(screen.getAllByRole("link", { name: "Sign up free to save your picks" })).toHaveLength(1);
  });

  it("lists picks made outside the stored ballot under Other saved picks", async () => {
    // Deep-link scenario: ballot A is stored, but the pick came from a
    // shared link to election e-9 in some other district. The cards can't
    // carry it; hiding it while the badge and CTA count it reads as lost.
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1"] },
      choices: {
        "e-9": draftChoice({
          election_id: "e-9",
          official_ballot_title: "Springfield Mayor",
          picks: [{ candidate_id: "c-9", display_name: "Pat Elsewhere", candidacy_status: "active" }],
        }),
      },
    });
    stubApiRoutes({
      ...GUEST,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderDraft();

    expect(await screen.findByText("Other saved picks")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Springfield Mayor" })).toHaveAttribute("href", "/elections/e-9");
    expect(screen.getByText("Pat Elsewhere")).toBeInTheDocument();
    // The stored ballot's own card still renders alongside.
    expect(screen.getByRole("link", { name: "Governor — no pick yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign up free to save your picks" })).toBeInTheDocument();
  });

  it("links pick names to candidate profiles with the draft back state", async () => {
    // One pick on the date card (PickedLine with the draft nav state) and one
    // outside the ballot (DraftChoiceRows) — both names must link out.
    seedDraft({
      district_ids: ["dddddddd-1111-4111-8111-111111111111"],
      target: { election_date: "2026-11-03", election_ids: ["e-1"] },
      choices: {
        "e-1": draftChoice(),
        "e-9": draftChoice({
          election_id: "e-9",
          official_ballot_title: "Springfield Mayor",
          picks: [{ candidate_id: "c-9", display_name: "Pat Elsewhere", candidacy_status: "active" }],
        }),
      },
    });
    stubApiRoutes({
      ...GUEST,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    const user = (await import("@testing-library/user-event")).default.setup({
      advanceTimers: vi.advanceTimersByTime,
    });
    const { router } = renderDraft();

    expect(await screen.findByRole("link", { name: "Jane Smith" })).toHaveAttribute(
      "href",
      "/candidates/c-1"
    );
    await user.click(screen.getByRole("link", { name: "Pat Elsewhere" }));

    expect(router.state.location.pathname).toBe("/candidates/c-9");
    expect(router.state.location.state).toEqual({
      backTo: { path: "/draft", label: "My Draft" },
      electionId: "e-9",
    });
  });

  it("lists picks without any ballot context and points at the address search", async () => {
    seedDraft({
      district_ids: [],
      target: null,
      choices: { "e-1": draftChoice() },
    });
    stubApiRoutes(GUEST);
    renderDraft();

    expect(await screen.findByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Governor" })).toHaveAttribute("href", "/elections/e-1");
    expect(screen.getByRole("link", { name: "Search your address" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Sign up free to save your picks" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Draft navigation" })).not.toBeInTheDocument();
  });
});

it("refreshes the guest target and splits retention from date progress and rows", async () => {
  seedDraft({ district_ids: ["dddddddd-1111-4111-8111-111111111111"], target: null,
    choices: { "e-1": draftChoice(), "r-1": draftChoice({ election_id: "r-1", picks: [], measure_position: "yes" }) } });
  stubApiRoutes({ ...GUEST, "/api/ballot": { body: ballotSummary([retentionElection("r-1"), electionSummary(), retentionElection("r-2")]) } });
  renderDraft();
  expect(await screen.findByRole("progressbar", { name: "1 of 1 race decided" })).toBeInTheDocument();
  expect(readBallotDraft().target).toEqual({ election_date: "2026-11-03", election_ids: ["e-1"], retention_ids: ["r-1", "r-2"] });
  expect(screen.getByRole("region", { name: /election draft milestone/ })).toHaveTextContent("Retention races are still open on your draft.");
  const progress = screen.getByRole("progressbar", { name: "1 of 2 retention races decided" });
  expect(progress).toHaveAttribute("aria-valuenow", "1");
  expect(progress).toHaveAttribute("aria-valuemax", "2");
  expect(progress.firstElementChild).toHaveStyle({ width: "50%" });
  expect(screen.queryByText("1/2")).not.toBeInTheDocument();
  const group = screen.getByRole("button", { name: "Retention Races" });
  expect(group).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("link", { name: /Shall Judge/ })).not.toBeInTheDocument();
  await userEvent.click(group);
  expect(screen.getAllByRole("link", { name: /Shall Judge/ })).toHaveLength(2);
  expect(screen.getByText("Yes")).toBeInTheDocument();
});

// Exercise the actual detail back link, not a placeholder returning state.
it.each(["back link", "browser Back"])("restores My Draft retention expansion via %s", async (returnVia) => {
  const elections = [retentionElection("r-1"), retentionElection("r-2"),
    retentionElection("r-3", { election_date: "2027-11-02" }),
    retentionElection("r-4", { election_date: "2027-11-02" })];
  seedDraft({ district_ids: ["dddddddd-1111-4111-8111-111111111111"], target: null, choices: {} });
  stubApiRoutes({ ...GUEST, "/api/ballot": { body: ballotSummary(elections) } });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { router } = renderRoutes([
    { path: "/draft", element: <DraftPage /> },
    { path: "/elections/:electionId", element: <ElectionPage />, hydrateFallbackElement: <p />,
      loader: () => electionDetail({ id: "r-1", official_ballot_title: elections[0].official_ballot_title }) },
  ], "/draft");
  const groups = () => screen.getAllByRole("button", { name: "Retention Races" });
  await screen.findAllByRole("button", { name: "Retention Races" });
  expect(groups()[0]).toHaveAttribute("aria-expanded", "false");
  await user.click(groups()[0]);
  await user.click(screen.getByRole("link", { name: new RegExp(elections[0].official_ballot_title) }));
  const back = await screen.findByRole("link", { name: "Back to My Draft" });
  expect(screen.queryByRole("link", { name: "Back to My Ballot Draft" })).not.toBeInTheDocument();
  if (returnVia === "back link") await user.click(back);
  else await act(async () => { await router.navigate(-1); });
  await waitFor(() => expect(groups()[0]).toHaveAttribute("aria-expanded", "true"));
  expect(groups()[1]).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("link", { name: new RegExp(elections[0].official_ballot_title) })).toBeInTheDocument();
  await user.click(groups()[0]);
  expect(router.state.location.state.expandedRetentionDates).toEqual([]);
  await user.click(groups()[0]);
  await act(async () => { await router.navigate("/draft", { state: null }); });
  expect(groups()[0]).toHaveAttribute("aria-expanded", "false");
});
