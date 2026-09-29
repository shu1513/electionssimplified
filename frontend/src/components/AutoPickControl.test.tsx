import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link } from "react-router";
import type { AutoPickElectionResult, Me } from "@voteapp/api-client";
import { AutoPickControl } from "./AutoPickControl";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { renderRoutes } from "../test/render";

// Same mocking rationale as ElectionChoiceControls.test: the control forks
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
let mockMe: Me | null | undefined = SIGNED_IN;
vi.mock("@voteapp/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@voteapp/api-client")>();
  return {
    ...actual,
    useMe: () => ({ me: mockMe, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

beforeEach(() => {
  mockMe = SIGNED_IN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ELECTION_ID = "33333333-3333-4333-8333-333333333333";
const AREA_HOUSING = "aaaaaaaa-0000-4000-8000-000000000001";
const AREA_CLIMATE = "aaaaaaaa-0000-4000-8000-000000000002";
const AREA_TAXES = "aaaaaaaa-0000-4000-8000-000000000003";
const CAND_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const CAND_B = "bbbbbbbb-0000-4000-8000-00000000000b";

function preference(researchAreaId: string, name: string, rank: number) {
  return {
    research_area_id: researchAreaId,
    slug: name.toLowerCase(),
    name,
    description: null,
    rank,
    direction: "support",
    hard_veto: false,
  };
}

const THREE_PREFERENCES = {
  preferences: [
    preference(AREA_HOUSING, "Housing", 1),
    preference(AREA_CLIMATE, "Climate", 2),
    preference(AREA_TAXES, "Taxes", 3),
  ],
};

function pickedResult(overrides: Partial<AutoPickElectionResult> = {}): AutoPickElectionResult {
  return {
    election_id: ELECTION_ID,
    race_type: "office",
    outcome: "picked",
    reason: null,
    picked_candidate_ids: [CAND_A],
    measure_position: null,
    shortlist_candidate_ids: [],
    candidates: [
      {
        candidate_id: CAND_A,
        display_name: "Alice Alvarez",
        score: 1,
        has_evidence: true,
        vetoed_by: [],
        per_issue: [{ research_area_id: AREA_HOUSING, net: 1, for_count: 2, against_count: 0 }],
      },
      {
        candidate_id: CAND_B,
        display_name: "Bob Boone",
        score: 0,
        has_evidence: false,
        vetoed_by: [],
        per_issue: [],
      },
    ],
    measure_per_issue: [],
    unresearched: [{ candidate_id: CAND_B, display_name: "Bob Boone", never_researched: true }],
    ...overrides,
  };
}

function renderControl(seatsToFill: number | null = null, measure = false, retention = false) {
  return renderRoutes(
    [
      {
        path: "/elections/:id",
        element: (
          <AutoPickControl electionId={ELECTION_ID} seatsToFill={seatsToFill} measure={measure} retention={retention} />
        ),
      },
      { path: "/register", element: <p>Register page</p> },
      { path: "/login", element: <p>Login page</p> },
      { path: "/me/settings", element: <p>Settings page</p> },
    ],
    `/elections/${ELECTION_ID}`
  );
}

/** The button disables while the preferences load; click only once ready. */
async function clickPickForMe() {
  const button = await screen.findByRole("button", { name: "Auto-pick by my issues" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

describe("AutoPickControl", () => {
  // The plain-English explanation sits behind a bare info glyph beside
  // the button (accessible name "How does this work?") that opens a
  // popover with its own close button (same panel as "How to vote in
  // WA"): a hover title never shows on touch screens, and the "Why this
  // pick" panel only explains after a click.
  it("explains how the pick works in a popover next to the button", async () => {
    stubApiRoutes({});
    renderControl();
    await screen.findByRole("button", { name: "Auto-pick by my issues" });
    const how = screen.getByRole("button", { name: "How does this work?" });
    expect(how).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/weighting your top issues most/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(how);
    expect(how).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/pick the best match/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/pick the best match/)).not.toBeInTheDocument();
    expect(how).toHaveFocus();
  });

  // Guests get the pitch instead of the button: a plain-words question
  // that opens the shared log in / sign up dialog, both links carrying
  // this page as the post-auth return path so the visitor lands back on
  // the race. The auto-pick button itself never renders for them (issue
  // preferences are account-only).
  it("shows guests a teaser that opens the sign-up dialog", async () => {
    mockMe = null;
    stubApiRoutes({});
    renderControl();
    expect(screen.queryByRole("button", { name: "Auto-pick by my issues" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Which candidate best matches my values?" }));
    expect(
      await screen.findByText(
        "Log in or sign up for free to pick the issues you care about, and see which candidate best matches what you believe."
      )
    ).toBeInTheDocument();
    const next = encodeURIComponent(`/elections/${ELECTION_ID}`);
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", `/register?next=${next}`);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", `/login?next=${next}`);
  });

  it("asks about the measure, not a candidate, on a ballot measure", async () => {
    mockMe = null;
    stubApiRoutes({});
    renderControl(null, true);
    expect(screen.queryByRole("button", { name: /Which candidate/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Does this measure match my values?" }));
    expect(await screen.findByText(/see whether this measure matches what you believe/)).toBeInTheDocument();
  });

  it("asks whether the candidate aligns on a judicial retention race", async () => {
    mockMe = null;
    stubApiRoutes({});
    renderControl(null, false, true);
    expect(screen.queryByRole("button", { name: /Which candidate/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Does this candidate align with my values?" }));
    expect(await screen.findByText(/see whether this candidate aligns with what you believe/)).toBeInTheDocument();
  });

  it("renders nothing while the session is still resolving", () => {
    mockMe = undefined;
    stubApiRoutes({});
    renderControl();
    expect(screen.queryByRole("button", { name: "Auto-pick by my issues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /your values/ })).not.toBeInTheDocument();
  });

  it("prompts for more ranked issues below the floor, linking to the issue editor", async () => {
    stubApiRoutes({
      // useMyResearchAreas resolves the session through the real useMe (the
      // vi.mock above only swaps the component's own import), so the identity
      // endpoint must answer for the preferences query to enable.
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": {
        body: { preferences: THREE_PREFERENCES.preferences.slice(0, 2) },
      },
    });
    renderControl();
    await clickPickForMe();
    const link = await screen.findByRole("link", { name: "Rank your issues" });
    expect(link).toHaveAttribute("href", "/me/settings");
  });

  it("runs the engine and renders the why-this-pick panel for a winner", async () => {
    const fetchMock = stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": { body: { results: [pickedResult()] } },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Picked Alice Alvarez — the best match for your issues.");
    // Up to three aligned issues are named in the headline itself — no
    // count, no toggle (conflicts/mixed are always named below anyway).
    expect(panel).toHaveTextContent("Alice Alvarez — aligned on Housing");
    expect(within(panel).queryByRole("button", { expanded: false })).toBeNull();
    expect(panel).not.toHaveTextContent("Taxes");
    expect(panel).toHaveTextContent("Bob Boone (not researched yet)");
    const call = fetchMock.mock.calls.find(([input]) => String(input).includes("auto-picks"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      election_ids: [ELECTION_ID],
      mode: "replace",
    });
  });

  // A run started on election A must not reach into election B's page:
  // the control remounts per election, and the stale onPicked would clear
  // B's party filter. The usage outcome still lands (tracked elsewhere).
  it("drops the onPicked callback when the control unmounts before the engine answers", async () => {
    let answer: (() => void) | null = null;
    const held = new Promise<{ body: unknown }>((resolve) => {
      answer = () => resolve({ body: { results: [pickedResult()] } });
    });
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": () => held,
    });
    const onPicked = vi.fn();
    renderRoutes([
      {
        path: "/",
        element: (
          <>
            <AutoPickControl electionId={ELECTION_ID} seatsToFill={null} onPicked={onPicked} />
            <Link to="/away">Away</Link>
          </>
        ),
      },
      { path: "/away", element: <p>Away page</p> },
    ]);
    await clickPickForMe();
    await userEvent.click(screen.getByRole("link", { name: "Away" }));
    await screen.findByText("Away page");
    answer!();
    await act(async () => {
      await held;
    });
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("flags the open seats when a multi-seat pick fills only some of them", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": { body: { results: [pickedResult()] } },
    });
    renderControl(2);
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent(
      "Picked Alice Alvarez — the best match for your issues. One seat is still open: nothing known separates the other candidates, so those picks are yours to make."
    );
  });

  it("lets the backend decide the issue floor when the preferences fetch failed", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": apiError(500, "internal_error", "boom"),
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              outcome: "no_pick",
              reason: "too_few_issues",
              picked_candidate_ids: [],
              candidates: [],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    // No client-side "rank your issues" misdirection from the errored empty
    // list — the POST ran and the backend's authoritative reason rendered.
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Rank at least 3 issues first");
    expect(screen.queryByRole("link", { name: "Rank your issues" })).not.toBeInTheDocument();
  });

  it("explains an honest no-pick, naming the shortlist", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              outcome: "no_pick",
              reason: "tie",
              picked_candidate_ids: [],
              shortlist_candidate_ids: [CAND_A, CAND_B],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent(
      "It's a tie between Alice Alvarez and Bob Boone on your issues — your call between them."
    );
  });

  it("shows the vetoed candidate with the offending record", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              candidates: [
                pickedResult().candidates[0]!,
                {
                  candidate_id: CAND_B,
                  display_name: "Bob Boone",
                  score: 0.5,
                  has_evidence: true,
                  vetoed_by: [
                    {
                      research_area_id: AREA_CLIMATE,
                      record_id: "cccccccc-0000-4000-8000-000000000001",
                      description: "Voted to repeal the emissions standard",
                    },
                  ],
                  per_issue: [],
                },
              ],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Bob Boone excluded — crossed your line on Climate");
    expect(panel).toHaveTextContent("Voted to repeal the emissions standard");
  });

  it("explains a retention No as a crossed line, not an exclusion, with the judge's alignment", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              reason: "veto",
              picked_candidate_ids: [],
              measure_position: "no",
              candidates: [
                {
                  candidate_id: CAND_B,
                  display_name: "Judge Bob Boone",
                  score: 0.5,
                  has_evidence: true,
                  vetoed_by: [
                    {
                      research_area_id: AREA_CLIMATE,
                      record_id: "cccccccc-0000-4000-8000-000000000001",
                      description: "Voted to repeal the emissions standard",
                    },
                  ],
                  per_issue: [{ research_area_id: AREA_HOUSING, net: 1, for_count: 1, against_count: 0 }],
                },
              ],
              measure_per_issue: [{ research_area_id: AREA_HOUSING, net: 1 }],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl(null, false, true);
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Vote No — this judge's record goes against an issue you drew a line on.");
    expect(panel).toHaveTextContent("On your issues: aligned on Housing");
    expect(panel).toHaveTextContent("Judge Bob Boone — crossed your line on Climate");
    expect(panel).not.toHaveTextContent("excluded");
  });

  it("counts four or more aligned issues and lists the names behind a toggle, in rank order", async () => {
    const AREA_SCHOOLS = "aaaaaaaa-0000-4000-8000-000000000004";
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": {
        body: { preferences: [...THREE_PREFERENCES.preferences, preference(AREA_SCHOOLS, "Schools", 4)] },
      },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              candidates: [
                {
                  candidate_id: CAND_A,
                  display_name: "Alice Alvarez",
                  score: 1,
                  has_evidence: true,
                  vetoed_by: [],
                  // Deliberately out of rank order: the panel must sort.
                  per_issue: [
                    { research_area_id: AREA_SCHOOLS, net: 1, for_count: 1, against_count: 0 },
                    { research_area_id: AREA_TAXES, net: 1, for_count: 1, against_count: 0 },
                    { research_area_id: AREA_CLIMATE, net: 1, for_count: 1, against_count: 0 },
                    { research_area_id: AREA_HOUSING, net: 1, for_count: 1, against_count: 0 },
                  ],
                },
              ],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Alice Alvarez — aligned on all 4 of your issues");
    expect(panel).not.toHaveTextContent("Aligned:");
    await userEvent.click(within(panel).getByRole("button", { name: "aligned on all 4 of your issues" }));
    expect(panel).toHaveTextContent("Aligned: Housing, Climate, Taxes, Schools");
  });

  it("counts four or more conflicts the same way, names behind the toggle", async () => {
    const AREA_SCHOOLS = "aaaaaaaa-0000-4000-8000-000000000004";
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": {
        body: { preferences: [...THREE_PREFERENCES.preferences, preference(AREA_SCHOOLS, "Schools", 4)] },
      },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              candidates: [
                {
                  candidate_id: CAND_A,
                  display_name: "Alice Alvarez",
                  score: 1,
                  has_evidence: true,
                  vetoed_by: [],
                  per_issue: [AREA_HOUSING, AREA_CLIMATE, AREA_TAXES, AREA_SCHOOLS].map((id) => ({
                    research_area_id: id,
                    net: -1,
                    for_count: 0,
                    against_count: 1,
                  })),
                },
              ],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("aligned on 0 of your 4 issues");
    expect(panel).toHaveTextContent("Conflicts on 4 issues");
    expect(panel).not.toHaveTextContent("Conflicts: Housing");
    await userEvent.click(within(panel).getByRole("button", { name: "aligned on 0 of your 4 issues" }));
    expect(panel).toHaveTextContent("Conflicts: Housing, Climate, Taxes, Schools");
  });

  it("answers a measure with the veto explanation", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              race_type: "ballot_measure",
              reason: "veto",
              picked_candidate_ids: [],
              measure_position: "no",
              candidates: [],
              measure_per_issue: [{ research_area_id: AREA_CLIMATE, net: -1 }],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Vote No — this measure goes against an issue you drew a line on.");
    expect(panel).toHaveTextContent("aligned on 0 of your 3 issues");
    expect(panel).toHaveTextContent("Conflicts: Climate");
  });

  // The two measure no-answer flavors are distinct outcomes with distinct
  // remedies — the panel must say which one happened.
  it("tells a measure voter the measure isn't tagged with their issues", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              race_type: "ballot_measure",
              outcome: "no_pick",
              reason: "insufficient_evidence",
              picked_candidate_ids: [],
              candidates: [],
              measure_per_issue: [],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("No answer — this measure isn't tagged with any of your issues yet.");
  });

  it("tells a measure voter when their issues cancel out", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": { body: THREE_PREFERENCES },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              race_type: "ballot_measure",
              outcome: "no_pick",
              reason: "insufficient_evidence",
              picked_candidate_ids: [],
              candidates: [],
              measure_per_issue: [
                { research_area_id: AREA_HOUSING, net: 1 },
                { research_area_id: AREA_CLIMATE, net: -1 },
              ],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent(
      "No answer — this measure helps some of your issues and hurts others about equally, so it's your call."
    );
    expect(panel).toHaveTextContent("aligned on Housing");
    expect(panel).toHaveTextContent("Conflicts: Climate");
  });

  // Race-type-independent reasons must survive the measure branch: a
  // failed preferences fetch defers the issue floor to the backend, and
  // "isn't tagged" would misdirect a voter who needs to rank issues.
  it("renders the backend issue floor on a measure, not the tagging message", async () => {
    stubApiRoutes({
      "/api/me": { body: { user: SIGNED_IN } },
      "/api/me/research-area-preferences": apiError(500, "internal_error", "boom"),
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/auto-picks": {
        body: {
          results: [
            pickedResult({
              race_type: "ballot_measure",
              outcome: "no_pick",
              reason: "too_few_issues",
              picked_candidate_ids: [],
              candidates: [],
              measure_per_issue: [],
              unresearched: [],
            }),
          ],
        },
      },
    });
    renderControl();
    await clickPickForMe();
    const panel = await screen.findByRole("region", { name: "Why this pick" });
    expect(panel).toHaveTextContent("Rank at least 3 issues first");
    expect(panel).not.toHaveTextContent("isn't tagged");
  });
});
