import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { PicksPage } from "./pages/PicksPage";
import { renderRoutes } from "./test/render";
import { apiError, stubApiRoutes } from "./test/mockApi";
import { ballotSummary, electionSummary, ME_VERIFIED } from "./test/fixtures";

function renderApp(initialEntry = "/") {
  return renderRoutes(
    [
      {
        path: "/",
        element: <App />,
        children: [
          { index: true, element: <p>home content</p> },
          // A stand-in non-landing page: the guest nav shows more on these
          // than on the address-search landing at "/".
          { path: "elections/e-1", element: <p>election content</p> },
          // Catch-all so in-test navigation (e.g. clicking Settings in the
          // account menu) keeps the app shell mounted.
          { path: "*", element: <p>other content</p> },
        ],
      },
    ],
    initialEntry
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("App account nav", () => {
  it("shows only log in and sign up on the search landing when logged out", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderApp();
    expect(await screen.findByRole("link", { name: "Log in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign up" })).toBeInTheDocument();
    // A first-time visitor has no draft to link to — the nav stays clean
    // until they've seen a ballot or made a pick.
    expect(screen.queryByRole("link", { name: /My Draft/ })).not.toBeInTheDocument();
    // Mission stays out of the landing's guest header; the footer link keeps
    // the page reachable.
    expect(screen.queryByRole("navigation", { name: "Footer" })).not.toBeNull();
    const header = screen.getByRole("banner");
    expect(header.querySelector('a[href="/mission"]')).toBeNull();
  });

  it("shows the header wordmark on the landing page as its only brand mark", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderApp();
    await screen.findByRole("link", { name: "Log in" });
    // The small corner logo is the landing's brand mark, same as every other
    // page; the page body carries no second, bigger copy.
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Elections Simplified" })).toHaveAttribute("href", "/");
    expect(screen.getAllByText("Elections Simplified")).toHaveLength(1);
  });

  it("keeps the header wordmark link home on every other page", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderApp("/elections/e-1");
    const wordmark = await screen.findByRole("link", { name: "Elections Simplified" });
    expect(wordmark).toHaveAttribute("href", "/");
  });

  it("shows Mission in the guest header on every page but the landing", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderApp("/elections/e-1");
    await screen.findByRole("link", { name: "Log in" });
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Mission" })).toHaveAttribute("href", "/mission");
  });

  it("shows the draft link once the guest has looked at a ballot — but never on the search landing", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    window.localStorage.setItem(
      "voteapp_ballot_draft",
      JSON.stringify({ v: 1, district_ids: ["dddddddd-1111-4111-8111-111111111111"], target: null, choices: {} })
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
    renderApp("/elections/e-1");
    expect(await screen.findByRole("link", { name: "My Draft" })).toHaveAttribute("href", "/draft");
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
  });

  it("keeps the same guest draft off the search landing's header", async () => {
    // Same draft as above, but rendered at "/" — the landing's whole job is
    // starting a fresh search, so the draft link stays out of its header.
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    window.localStorage.setItem(
      "voteapp_ballot_draft",
      JSON.stringify({ v: 1, district_ids: ["dddddddd-1111-4111-8111-111111111111"], target: null, choices: {} })
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
    renderApp();
    expect(await screen.findByRole("link", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /My Draft/ })).not.toBeInTheDocument();
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: "voteapp_ballot_draft" }));
  });

  it("collapses the signed-in nav to My Draft plus the account menu", async () => {
    stubApiRoutes({ "/api/me": { body: ME_VERIFIED } });
    renderApp();

    // Plain "My Draft" (no counter) while no pick is made / progress unknown.
    expect(await screen.findByRole("link", { name: "My Draft" })).toHaveAttribute("href", "/me/picks");

    // Everything else waits behind the greeting-as-menu-button, closed by
    // default.
    const trigger = screen.getByRole("button", { name: /Hi Sam/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "My Elections" })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "My Elections" })).toHaveAttribute("href", "/me/ballot");
    expect(header.getByRole("link", { name: "My Candidates" })).toHaveAttribute("href", "/me/follows");
    // The footer carries its own Mission link, hence the header scoping.
    expect(header.getByRole("link", { name: "Mission" })).toHaveAttribute("href", "/mission");
    expect(header.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/me/settings");
    expect(header.getByRole("button", { name: "Sign Out" })).toBeInTheDocument();

    // Escape closes it without navigating — and when keyboard focus sits on
    // a link that unmounts with the panel, it returns to the trigger
    // instead of dropping to <body>.
    await userEvent.tab();
    expect(header.getByRole("link", { name: "My Elections" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: "My Elections" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("signing out on the landing hands focus to main, not <body>", async () => {
    // Same-page sign-out is the one path the route-focus effect can't cover:
    // the pathname stays "/", the menu (holding the focused button) unmounts
    // with the session, and without the explicit focus hand-off the focus
    // would drop to <body>.
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/auth/logout-all": { body: { status: "ok" } },
    });
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: /Hi Sam/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign Out" }));

    // Session gone: the guest header replaces the account menu.
    expect(await screen.findByRole("link", { name: "Sign up" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("closes the account menu when a menu link navigates", async () => {
    stubApiRoutes({ "/api/me": { body: ME_VERIFIED } });
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: /Hi Sam/ }));
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.queryByRole("link", { name: "My Elections" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hi Sam/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the account menu when the selected link is the current page", async () => {
    // Selecting the link for the page already on screen leaves
    // location.pathname unchanged, so only the panel's own click handler
    // can close it.
    stubApiRoutes({ "/api/me": { body: ME_VERIFIED } });
    renderApp("/me/settings");

    await userEvent.click(await screen.findByRole("button", { name: /Hi Sam/ }));
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.queryByRole("link", { name: "My Elections" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hi Sam/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("cold-loading /me/picks shares ONE ballot request between the header badge and the page", async () => {
    // The header's pick counter (usePickProgress) and PicksPage ride the
    // same query key and url on purpose — rendering the page WITHOUT the
    // app shell would hide a regression back to two requests.
    // Frozen clock so the 2026-11-03 fixture stays upcoming (same reason as
    // PicksPage.test).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    const fetchMock = stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/ballot": { body: ballotSummary([electionSummary()]) },
      "/api/me/election-choices": {
        body: {
          choices: [
            {
              election_id: "e-1",
              race_type: "office",
              official_ballot_title: "Governor",
              election_date: "2026-11-03",
              seats_to_fill: null,
              picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "declared" }],
              measure_position: null,
              updated_at: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    renderRoutes(
      [
        {
          path: "/",
          element: <App />,
          children: [{ path: "me/picks", element: <PicksPage /> }],
        },
      ],
      "/me/picks"
    );

    // Both consumers settled: the page's date card AND the header counter
    // computed off the same payload (1 race, 1 picked → the earned label).
    expect(
      await screen.findByRole("heading", { name: "November 3, 2026" })
    ).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "My Draft ✓" })).toBeInTheDocument();

    const ballotCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/me/ballot?"));
    expect(ballotCalls).toHaveLength(1);
    expect(String(ballotCalls[0][0])).toContain("include=preview");
  });
});
