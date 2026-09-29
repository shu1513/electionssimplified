import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { TERMS_VERSION } from "@voteapp/api-client";
import { App } from "../App";
import { clearBallotDraft, readBallotDraft, setDraftCandidateChoice } from "../lib/ballotDraft";
import { BallotPage } from "./BallotPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionSummary, retentionElection, ME_VERIFIED, VOTE_POWER } from "../test/fixtures";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

function renderBallot(entry: string | { pathname: string; search?: string; state?: unknown }) {
  return renderRoutes(
    [
      { path: "/ballot", element: <BallotPage /> },
      { path: "/elections/:electionId", element: <p /> },
      { path: "/", element: <p /> },
    ],
    entry
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BallotPage", () => {
  it("asks for an address when no districts are in the URL", () => {
    stubApiRoutes(ANONYMOUS);
    renderBallot("/ballot");
    expect(screen.getByText("No districts selected.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start with your address" })).toHaveAttribute("href", "/");
  });

  it("labels a partial ballot, naming the ZIP from router state", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot({
      pathname: "/ballot",
      search: "?d=d-1&partial=1",
      state: { matchedAddress: "78701", addressMatchCount: 1, scope: "zip" },
    });

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This is a partial ballot for ZIP code 78701");
    expect(banner).toHaveTextContent("Enter your street address");
    expect(screen.getByRole("link", { name: "Enter your street address" })).toHaveAttribute("href", "/?new=1");
  });

  it("labels a partial ballot, naming the area from router state on a region search", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot({
      pathname: "/ballot",
      search: "?d=d-1&partial=1",
      state: { matchedAddress: "Los Angeles, CA, USA", addressMatchCount: 1, scope: "region" },
    });

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This is a partial ballot for Los Angeles, CA, USA");
    expect(banner).not.toHaveTextContent("ZIP code");
  });

  it("labels a partial ballot generically on a bare link with no router state", async () => {
    // partial=1 lives in the URL precisely so a refresh or shared link keeps
    // the label; the ZIP itself (router state) is gone then.
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot("/ballot?d=d-1&partial=1");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This is a partial ballot.");
    expect(banner).toHaveTextContent("Enter your street address");
  });

  it("shows no partial label without the flag", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot("/ballot?d=d-1");

    expect(await screen.findByText("Governor")).toBeInTheDocument();
    expect(screen.queryByText(/partial ballot/)).not.toBeInTheDocument();
  });

  it("shows the service-trouble copy on a 500", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": apiError(500, "internal_error", "boom"),
    });
    renderBallot("/ballot?d=d-1");
    expect(
      await screen.findByText("The service is having trouble right now. Please try again shortly.")
    ).toBeInTheDocument();
  });

  it("renders election cards under a date heading, with only public sorts", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": {
        body: ballotSummary([
          electionSummary(),
          electionSummary({ id: "e-2", official_ballot_title: "State Senate" }),
        ]),
      },
    });
    renderBallot("/ballot?d=d-1");

    expect(await screen.findByText("Governor")).toBeInTheDocument();
    expect(screen.getByText("State Senate")).toBeInTheDocument();
    // A visible "My elections:" h1 names the list for first-time visitors,
    // one step larger than the date group heading below it. No
    // election/district count line, no explainer collapsibles.
    expect(
      screen.getByRole("heading", { name: "Elections on November 3, 2026" })
    ).toBeInTheDocument();
    const h1 = screen.getByRole("heading", { level: 1, name: "My elections:" });
    expect(h1).not.toHaveClass("sr-only");
    expect(h1).toHaveClass("text-title");
    expect(screen.queryByText(/elections across/)).not.toBeInTheDocument();
    expect(screen.queryByText("Which districts?")).not.toBeInTheDocument();
    expect(screen.queryByText("What do these labels mean?")).not.toBeInTheDocument();

    // The anonymous endpoint cannot honor my_areas; the dropdown must not offer it.
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).not.toContain("My issues");
    expect(options).toContain("My vote power");
  });

  it("replaces the 0-candidates chip with the roster-status explanation", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": {
        body: ballotSummary([
          electionSummary({
            candidate_count: 0,
            candidate_roster_status: { reason: "awaiting_official_roster", check_after: "2026-08-27" },
          }),
        ]),
      },
    });
    renderBallot("/ballot?d=d-1");

    // The roster status renders in the card's title row where the candidate
    // count would sit, so match it as a substring.
    // The waiting section starts collapsed.
    await userEvent.click(await screen.findByRole("button", { name: /^Elections awaiting candidate information/ }));
    expect(await screen.findByText(/Candidate list not final/)).toBeInTheDocument();
    expect(screen.queryByText(/0 candidates/)).not.toBeInTheDocument();
  });

  it("tells a guest which address the elections are for after an unambiguous match", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot({
      pathname: "/ballot",
      search: "?d=d-1",
      state: { matchedAddress: "123 MAIN ST, JUNEAU, AK, 99801", addressMatchCount: 1 },
    });

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Elections for 123 MAIN ST, JUNEAU, AK, 99801.");
    expect(status).toHaveTextContent(
      "Your address was only used to find these election districts. We do NOT save it to any account."
    );
    // A single match needs no warning; the status line is not an alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the matched-address line off a signed-in member's one-off search", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot({
      pathname: "/ballot",
      search: "?d=d-1",
      state: { matchedAddress: "123 MAIN ST, JUNEAU, AK, 99801", addressMatchCount: 1 },
    });

    await screen.findByText("Governor");
    expect(screen.queryByText(/123 MAIN ST/)).not.toBeInTheDocument();
  });

  it("warns with the matched address when the search matched multiple addresses", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot({
      pathname: "/ballot",
      search: "?d=d-1",
      state: { matchedAddress: "100 MAIN ST, SPRINGFIELD, MA, 01105", addressMatchCount: 7 },
    });

    // Self-contained warning: it names the matched address itself since the
    // confirmation line above it is gone.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your search matched 7 possible addresses");
    expect(alert).toHaveTextContent("100 MAIN ST, SPRINGFIELD, MA, 01105");
    expect(screen.getByRole("link", { name: "search again" })).toHaveAttribute("href", "/?new=1");
  });

  it("shows no ambiguity warning for an exact single match", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot({
      pathname: "/ballot",
      search: "?d=d-1",
      state: { matchedAddress: "123 MAIN ST, JUNEAU, AK, 99801", addressMatchCount: 1 },
    });

    await screen.findByText("Governor");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("omits the matched-address line on direct visits without router state", async () => {
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": { body: ballotSummary([electionSummary()]) },
    });
    renderBallot("/ballot?d=d-1");
    await screen.findByText("Governor");
    expect(screen.queryByText(/Matched address:/)).not.toBeInTheDocument();
  });

  describe("terms gate over a first search's results", () => {
    const STORAGE_KEY = "voteapp_terms_acceptance";
    const PENDING = {
      pathname: "/ballot",
      search: "?d=d-1",
      state: { matchedAddress: "123 MAIN ST, JUNEAU, AK, 99801", addressMatchCount: 1, termsPending: true },
    };

    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
      clearBallotDraft();
    });

    it("opens the dialog over the results with an empty box and the action disabled", async () => {
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([electionSummary()]) } });
      renderBallot(PENDING);

      const dialog = await screen.findByRole("dialog", { name: "Your elections are ready" });
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Agree and show results" })).toBeDisabled();
      expect(dialog).toHaveTextContent("The address is only used to find voting districts.");
      // Clickwrap adjacency, and opening one must not discard the dialog.
      for (const [name, href] of [
        ["Terms of Use", "/terms"],
        ["Privacy Policy", "/privacy"],
        ["AI Research and Election Information Disclaimer", "/disclaimer"],
      ] as const) {
        const link = screen.getByRole("link", { name });
        expect(link).toHaveAttribute("href", href);
        expect(link).toHaveAttribute("target", "_blank");
      }
      // The results are on the page behind it, blurred, not withheld.
      expect(await screen.findByText("Governor")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, hidden: true }).parentElement?.className).toContain("blur-sm");
    });

    it("reveals the results and remembers the acceptance on agreement", async () => {
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([electionSummary()]) } });
      renderBallot(PENDING);

      await screen.findByRole("dialog");
      await userEvent.click(screen.getByRole("checkbox"));
      await userEvent.click(screen.getByRole("button", { name: "Agree and show results" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({ version: TERMS_VERSION });
      expect(screen.getByRole("heading", { level: 1 }).parentElement?.className).not.toContain("blur-sm");
      // The draft follows the search only once agreed.
      await waitFor(() => {
        expect(readBallotDraft().district_ids).toEqual(["d-1"]);
      });
    });

    it("leaves for the search form with nothing kept from the search on cancel", async () => {
      // What the home page queued for a later signup handoff before the gate.
      sessionStorage.setItem("voteapp_pending_district_ids", JSON.stringify(["d-1"]));
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([electionSummary()]) } });
      const { router } = renderBallot(PENDING);

      await screen.findByRole("dialog");
      await screen.findByText("Governor");
      // The guest draft is not pointed at an un-agreed search either.
      expect(readBallotDraft().district_ids).toEqual([]);
      await userEvent.click(screen.getByRole("checkbox"));
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/");
      });
      expect(router.state.location.search).toBe("?new=1");
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem("voteapp_pending_district_ids")).toBeNull();
      expect(readBallotDraft().district_ids).toEqual([]);
    });

    it("stays closed when this browser already holds a current acceptance", async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: Date.now() }));
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([electionSummary()]) } });
      renderBallot(PENDING);

      await screen.findByText("Governor");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("never opens on a shared link or a search that already carried an acceptance", async () => {
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([electionSummary()]) } });
      renderBallot({ ...PENDING, state: { ...PENDING.state, termsPending: false } });

      await screen.findByText("Governor");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("shows the empty-ballot message when districts have no elections", async () => {
    stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([]) } });
    renderBallot("/ballot?d=d-1");
    expect(await screen.findByText(/No upcoming elections found for these districts yet/)).toBeInTheDocument();
  });

  describe("race-type tabs", () => {
    // A ballot mixing both race types — the only shape that offers the tabs.
    const MIXED_BALLOT = {
      body: ballotSummary([
        electionSummary(),
        electionSummary({ id: "q-1", race_type: "ballot_measure", official_ballot_title: "Measure A" }),
      ]),
    };

    it("switches between All, Candidates, and Ballot Measures via the URL", async () => {
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": MIXED_BALLOT });
      const user = userEvent.setup();
      const { router } = renderBallot("/ballot?d=d-1");

      // Default: the All tab, nothing sliced.
      expect(await screen.findByText("Governor")).toBeInTheDocument();
      expect(screen.getByText("Measure A")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

      await user.click(screen.getByRole("button", { name: "Ballot Measures" }));
      expect(screen.getByText("Measure A")).toBeInTheDocument();
      expect(screen.queryByText("Governor")).not.toBeInTheDocument();
      // A view switch, not a filter: nothing reads as "hidden".
      expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
      // URL state like sort, so the tab survives navigating into a race.
      expect(router.state.location.search).toContain("type=ballot_measure");

      await user.click(screen.getByRole("button", { name: "Offices" }));
      expect(screen.getByText("Governor")).toBeInTheDocument();
      expect(screen.queryByText("Measure A")).not.toBeInTheDocument();
      expect(router.state.location.search).toContain("type=office");

      await user.click(screen.getByRole("button", { name: "All" }));
      expect(screen.getByText("Governor")).toBeInTheDocument();
      expect(screen.getByText("Measure A")).toBeInTheDocument();
      expect(router.state.location.search).not.toContain("type=");
    });

    it("offers no tabs on a single-type ballot and ignores a ?type= link there", async () => {
      stubApiRoutes({
        ...ANONYMOUS,
        "/api/ballot": {
          body: ballotSummary([
            electionSummary(),
            electionSummary({ id: "e-2", official_ballot_title: "State Senate" }),
          ]),
        },
      });
      renderBallot("/ballot?d=d-1&type=ballot_measure");

      // All-office ballot: nothing to switch between, and the shared link
      // must not empty the list with no tab bar on screen to explain it.
      expect(await screen.findByText("Governor")).toBeInTheDocument();
      expect(screen.getByText("State Senate")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Ballot Measures" })).not.toBeInTheDocument();
    });

    it("arrives on the Ballot Measures tab from a shared ?type= link", async () => {
      stubApiRoutes({ ...ANONYMOUS, "/api/ballot": MIXED_BALLOT });
      renderBallot("/ballot?d=d-1&type=ballot_measure");

      expect(await screen.findByText("Measure A")).toBeInTheDocument();
      expect(screen.queryByText("Governor")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ballot Measures" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
  });

  describe("how to vote resources", () => {
    const AK_RESOURCES = {
      state_abbreviation: "AK",
      state_name: "Alaska",
      polling_place_url: "https://myvoterinformation.alaska.gov",
      mail_voting_available: true,
      mail_ballot_request_url: "https://absenteeballotapplication.alaska.gov",
      mail_ballot_request_type: "online_portal",
      mail_ballot_request_deadline_rule:
        "Applications to receive an absentee ballot by mail must be received at least 10 days before the election.",
    };

    it("opens official mail-first voting resources for the ballot's state", async () => {
      stubApiRoutes({
        ...ANONYMOUS,
        "/api/ballot": { body: ballotSummary([electionSummary()]) },
        "/api/state-resources": { body: { state_resources: AK_RESOURCES } },
      });
      const user = userEvent.setup();
      renderBallot("/ballot?d=d-1");

      const toggle = await screen.findByRole("button", { name: "How to vote in AK" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      await user.click(toggle);

      const requestLink = await screen.findByRole("link", { name: "Request your ballot online" });
      expect(requestLink).toHaveAttribute("href", "https://absenteeballotapplication.alaska.gov");
      const pollingLink = screen.getByRole("link", { name: "Find your polling place" });
      expect(pollingLink).toHaveAttribute("href", "https://myvoterinformation.alaska.gov");
      // Mail leads, "or" separates, in-person follows.
      expect(screen.getByText("Vote by mail")).toBeInTheDocument();
      expect(screen.getByText("or")).toBeInTheDocument();
      expect(screen.getByText("Vote in person")).toBeInTheDocument();
      expect(
        requestLink.compareDocumentPosition(pollingLink) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        screen.getByText(
          "Applications to receive an absentee ballot by mail must be received at least 10 days before the election."
        )
      ).toBeInTheDocument();
      // Say where the links go.
      expect(screen.getByText("absenteeballotapplication.alaska.gov")).toBeInTheDocument();
      expect(screen.getByText("myvoterinformation.alaska.gov")).toBeInTheDocument();
    });

    it("explains automatic vote-by-mail states instead of asking voters to sign up", async () => {
      stubApiRoutes({
        ...ANONYMOUS,
        "/api/ballot": { body: ballotSummary([electionSummary()]) },
        "/api/state-resources": {
          body: {
            state_resources: {
              ...AK_RESOURCES,
              state_abbreviation: "WA",
              state_name: "Washington",
              polling_place_url: "https://voter.votewa.gov",
              mail_ballot_request_url:
                "https://www.sos.wa.gov/elections/voters/helpful-information/frequently-asked-questions-voting-mail",
              mail_ballot_request_type: "not_required",
              mail_ballot_request_deadline_rule: null,
            },
          },
        },
      });
      const user = userEvent.setup();
      renderBallot("/ballot?d=d-1");

      await user.click(await screen.findByRole("button", { name: "How to vote in AK" }));

      expect(
        await screen.findByText(
          "Every registered Washington voter is mailed a ballot automatically — no request needed."
        )
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "How vote-by-mail works" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Request your ballot online" })).not.toBeInTheDocument();
    });

    it("closes from the panel's close button and returns focus to the trigger", async () => {
      stubApiRoutes({
        ...ANONYMOUS,
        "/api/ballot": { body: ballotSummary([electionSummary()]) },
        "/api/state-resources": { body: { state_resources: AK_RESOURCES } },
      });
      const user = userEvent.setup();
      renderBallot("/ballot?d=d-1");

      const toggle = await screen.findByRole("button", { name: "How to vote in AK" });
      await user.click(toggle);
      expect(await screen.findByRole("link", { name: "Find your polling place" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("link", { name: "Find your polling place" })).not.toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveFocus();
    });

    it("fetches the resources lazily, only when the disclosure opens", async () => {
      const fetchMock = stubApiRoutes({
        ...ANONYMOUS,
        "/api/ballot": { body: ballotSummary([electionSummary()]) },
        "/api/state-resources": { body: { state_resources: AK_RESOURCES } },
      });
      const user = userEvent.setup();
      renderBallot("/ballot?d=d-1");

      const toggle = await screen.findByRole("button", { name: "How to vote in AK" });
      const calledPaths = () =>
        fetchMock.mock.calls.map((call) => new URL(String(call[0]), "http://localhost").pathname);
      expect(calledPaths()).not.toContain("/api/state-resources");
      await user.click(toggle);
      expect(await screen.findByRole("link", { name: "Find your polling place" })).toBeInTheDocument();
      expect(calledPaths()).toContain("/api/state-resources");
    });
  });
});

describe("BallotPage my_areas sort", () => {
  const HOUSING = { id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null };
  const SAVED_HOUSING = {
    "/api/me": { body: ME_VERIFIED },
    "/api/me/research-area-preferences": {
      body: {
        preferences: [
          { research_area_id: "a-1", slug: "housing_affordability", name: "Housing Affordability", description: null, rank: 1 },
        ],
      },
    },
  };
  // Governor leads under vote_power (score 42 vs 5); Housing Board leads
  // under my_areas (it alone matches the saved area). One payload proves the
  // client re-sort actually reordered.
  const BALLOT = {
    body: ballotSummary([
      electionSummary(),
      electionSummary({
        id: "hb-1",
        official_ballot_title: "Housing Board",
        research_areas: [HOUSING],
        vote_power: { ...VOTE_POWER, score: 5, label: "low" as const },
      }),
    ]),
  };
  const cardOrder = () =>
    screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

  it("offers My issues to a saved-areas viewer and reorders matched races first", async () => {
    stubApiRoutes({ ...SAVED_HOUSING, "/api/ballot": BALLOT });
    renderBallot("/ballot?d=d-1&sort=my_areas");

    await screen.findByText("Housing Board");
    // The matched race outranks the higher vote-power race — the mirrored
    // backend comparator, run client-side (the anonymous endpoint cannot
    // score a user).
    expect(cardOrder()).toEqual(["Housing Board", "Governor"]);
    expect(screen.getByRole("combobox")).toHaveValue("my_areas");
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("My issues");
  });

  it("fetches the vote_power payload for a my_areas view", async () => {
    const fetchMock = stubApiRoutes({ ...SAVED_HOUSING, "/api/ballot": BALLOT });
    renderBallot("/ballot?d=d-1&sort=my_areas");

    await screen.findByText("Housing Board");
    const ballotCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/api/ballot"));
    // my_areas is client-side on this page; the backend is asked for (and
    // the query cached under) the plain default payload.
    expect(ballotCalls).toEqual([expect.stringContaining("sort=vote_power")]);
  });

  it("degrades a my_areas URL to vote_power for an anonymous visitor", async () => {
    stubApiRoutes({ ...ANONYMOUS, "/api/ballot": BALLOT });
    renderBallot("/ballot?d=d-1&sort=my_areas");

    await screen.findByText("Housing Board");
    // Nothing to score against: payload (vote_power) order, no My issues
    // option, and the select admits the fallback rather than claiming an
    // issue ordering.
    expect(cardOrder()).toEqual(["Governor", "Housing Board"]);
    expect(screen.getByRole("combobox")).toHaveValue("vote_power");
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).not.toContain("My issues");
  });

  it("withholds the list on a ?sort=my_areas load until the saved areas arrive", async () => {
    // The ballot is one request; the saved areas are two chained ones, so
    // the ballot usually lands first. The page must not flash the
    // vote_power order while the saved areas are still unknown.
    let releasePreferences!: () => void;
    const preferencesGate = new Promise<void>((resolve) => {
      releasePreferences = resolve;
    });
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/research-area-preferences": async () => {
        await preferencesGate;
        return SAVED_HOUSING["/api/me/research-area-preferences"];
      },
      "/api/ballot": BALLOT,
    });
    renderBallot("/ballot?d=d-1&sort=my_areas");

    await expect(screen.findByText("Governor", {}, { timeout: 250 })).rejects.toThrow();
    expect(screen.getByText("Loading your elections…")).toBeInTheDocument();

    releasePreferences();
    await screen.findByText("Housing Board");
    expect(cardOrder()).toEqual(["Housing Board", "Governor"]);
  });

  it("shows a ballot error instead of the withhold notice while saved areas still load", async () => {
    // A ballot error has no list to withhold: it must win over the
    // saved-areas gate, not render alongside (or behind) a loading notice.
    const neverSettles = new Promise<never>(() => {});
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/research-area-preferences": () => neverSettles,
      "/api/ballot": apiError(500, "internal_error", "boom"),
    });
    renderBallot("/ballot?d=d-1&sort=my_areas");

    expect(
      await screen.findByText("The service is having trouble right now. Please try again shortly.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading your elections…")).not.toBeInTheDocument();
  });

  it("falls open to the vote_power order when the saved-areas fetch fails", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/research-area-preferences": apiError(500, "internal_error", "boom"),
      "/api/ballot": BALLOT,
    });
    renderBallot("/ballot?d=d-1&sort=my_areas");

    // Deliberate fail-open, not a spinner: nothing to score against, so the
    // payload order shows and the select admits the fallback.
    await screen.findByText("Housing Board");
    expect(cardOrder()).toEqual(["Governor", "Housing Board"]);
    expect(screen.getByRole("combobox")).toHaveValue("vote_power");
  });

  it("carries a chosen My issues sort into the URL and seeds the detail rail", async () => {
    const user = userEvent.setup();
    stubApiRoutes({ ...SAVED_HOUSING, "/api/ballot": BALLOT });
    const { router } = renderBallot("/ballot?d=d-1");

    await screen.findByText("Housing Board");
    // The option appears once the saved-areas chain confirms the viewer can
    // be scored — after the ballot itself typically.
    await screen.findByRole("option", { name: "My issues" });
    await user.selectOptions(screen.getByRole("combobox"), "my_areas");
    expect(router.state.location.search).toContain("sort=my_areas");
    expect(cardOrder()).toEqual(["Housing Board", "Governor"]);

    await user.click(screen.getByRole("link", { name: /Housing Board/ }));
    const navState = router.state.location.state as { railSort?: string };
    expect(navState.railSort).toBe("my_areas");
  });
});

describe("BallotPage nav context", () => {
  it("hands election cards its own URL and the displayed contest order", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": {
        // Awaiting-candidates race first in the payload: the displayed order
        // (readable races, then the awaiting tail) must win over payload order.
        body: ballotSummary([
          electionSummary({ id: "e-2", official_ballot_title: "Mayor", candidate_count: 0 }),
          electionSummary(),
        ]),
      },
    });
    const { router } = renderBallot("/ballot?d=d-1&sort=district_size");

    await user.click(await screen.findByRole("link", { name: /Governor/ }));

    expect(router.state.location.pathname).toBe("/elections/e-1");
    expect(router.state.location.state).toEqual({
      backTo: { path: "/ballot?d=d-1&sort=district_size", label: "All elections" },
      // race_type powers the detail rail's tabs, the sort keys its sort
      // control; the awaiting flag keeps that tail sunk under rail sorts.
      // No raceType field while the list is on the All tab. Under a
      // district-size sort every contest carries its level section heading
      // (the fixture district is an unlevelled "state" type: "Other"), so
      // the rail can group under the same headings.
      contests: [
        {
          id: "e-1",
          title: "Governor",
          race_type: "office",
          vote_power_score: 42,
          election_date: "2026-11-03",
          research_area_ids: [],
          vote_power_band: "high",
          group: "Other",
        },
        {
          id: "e-2",
          title: "Mayor",
          race_type: "office",
          vote_power_score: 42,
          election_date: "2026-11-03",
          research_area_ids: [],
          awaiting_candidates: true,
          group: "Other",
        },
      ],
      // The list's sort seeds the rail's always-engaged sort control: a
      // district-size list opens the rail on By district.
      railSort: "district",
    });
  });

  it("snapshots the full pool plus the engaged tab when a race-type tab is active", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      ...ANONYMOUS,
      "/api/ballot": {
        body: ballotSummary([
          electionSummary(),
          electionSummary({ id: "q-1", race_type: "ballot_measure", official_ballot_title: "Measure A" }),
        ]),
      },
    });
    const { router } = renderBallot("/ballot?d=d-1&type=ballot_measure");

    await user.click(await screen.findByRole("link", { name: /Measure A/ }));

    // The pool is NOT sliced by the tab — the rail's own tabs must be able
    // to reach the office races — and raceType records where to start.
    expect(router.state.location.state).toEqual({
      backTo: { path: "/ballot?d=d-1&type=ballot_measure", label: "All elections" },
      contests: [
        {
          id: "e-1",
          title: "Governor",
          race_type: "office",
          vote_power_score: 42,
          election_date: "2026-11-03",
          research_area_ids: [],
          vote_power_band: "high",
        },
        {
          id: "q-1",
          title: "Measure A",
          race_type: "ballot_measure",
          vote_power_score: 42,
          election_date: "2026-11-03",
          research_area_ids: [],
          vote_power_band: "high",
        },
      ],
      raceType: "ballot_measure",
      railSort: "vote_power",
    });
  });
});

it("excludes grouped retention from the guest header and target while keeping office tabs", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  window.localStorage.clear();
  clearBallotDraft();
  try {
    setDraftCandidateChoice({ electionId: "e-1", raceTitle: "Governor", electionDate: "2026-11-03",
      seatsToFill: null, candidateId: "c-1", candidateName: "Jane", chosen: true });
    stubApiRoutes({ ...ANONYMOUS, "/api/ballot": { body: ballotSummary([
      retentionElection("r-1"), electionSummary(), retentionElection("r-2"),
      electionSummary({ id: "m-1", official_ballot_title: "Measure One", race_type: "ballot_measure" }),
    ]) } });
    renderRoutes([{ path: "/", element: <App />, children: [{ path: "ballot", element: <BallotPage /> }] }],
      "/ballot?d=dddddddd-1111-4111-8111-111111111111");
    expect(await screen.findByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
    await waitFor(() => expect(readBallotDraft().target).toEqual({
      election_date: "2026-11-03", election_ids: ["e-1", "m-1"], retention_ids: ["r-1", "r-2"],
    }));
    expect(screen.getByRole("button", { name: "Retention Races (2)" })).toBeInTheDocument();
    const offices = screen.getByRole("button", { name: /Offices/ });
    await userEvent.click(offices);
    expect(screen.getByRole("button", { name: "Retention Races (2)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Measures/ }));
    expect(screen.queryByRole("button", { name: /Retention Races/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Draft 1/2" })).toBeInTheDocument();
  } finally {
    clearBallotDraft();
    vi.useRealTimers();
  }
});
