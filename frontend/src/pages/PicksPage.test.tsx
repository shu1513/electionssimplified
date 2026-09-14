import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElectionChoice } from "@voteapp/api-client";
import { PicksPage } from "./PicksPage";
import { ElectionPage } from "./ElectionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionDetail, electionSummary, retentionElection, ME_UNVERIFIED, ME_VERIFIED } from "../test/fixtures";

function renderPicks() {
  return renderRoutes(
    [
      { path: "/me/picks", element: <PicksPage /> },
      { path: "/login", element: <p /> },
      { path: "/elections/:electionId", element: <p>Election page</p> },
      { path: "/candidates/:candidateId", element: <p>Candidate page</p> },
    ],
    "/me/picks"
  );
}

function electionChoice(overrides: Partial<ElectionChoice> = {}): ElectionChoice {
  return {
    election_id: "e-1",
    race_type: "office",
    official_ballot_title: "Governor",
    election_date: "2026-11-03",
    seats_to_fill: null,
    picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "declared" }],
    measure_position: null,
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

// Everything a verified render touches; individual tests override entries.
function verifiedRoutes(overrides: Record<string, unknown> = {}) {
  return {
    "/api/me": { body: ME_VERIFIED },
    "/api/me/ballot": {
      body: ballotSummary([
        electionSummary(),
        electionSummary({ id: "e-2", official_ballot_title: "Mayor" }),
      ]),
    },
    "/api/me/election-choices": { body: { choices: [electionChoice()] } },
    // ShareCardControl lists live share links on every card with picks;
    // none by default, so the card shows the mint button.
    "/api/me/pick-card-shares": { body: { shares: [] } },
    // AutoPickFillControl reads the viewer's ranked issues on every verified
    // render (button gating); empty keeps it inert unless a test overrides.
    "/api/me/research-area-preferences": { body: { preferences: [] } },
    // Read only once the nearest day is fully decided (the member ask);
    // default = Stripe on, not a member.
    "/api/me/membership": { body: { enabled: true, membership: null, total_net_cents: 0, payments: [] } },
    ...overrides,
  } as Parameters<typeof stubApiRoutes>[0];
}

// Frozen clock: the page classifies races as upcoming/past against the real
// date (usLatestLocalDate), so the 2026-11-03 fixtures would flip into the
// past section — and these assertions would rot — once that day passes.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PicksPage", () => {
  it("shows the milestone, without a sign-up link, once every race on the nearest day has a pick", async () => {
    window.localStorage.clear();
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [electionChoice(), electionChoice({ election_id: "e-2", official_ballot_title: "Mayor" })],
          },
        },
      })
    );
    renderPicks();

    const milestone = await screen.findByRole("region", { name: "November 3, 2026 election draft milestone" });
    expect(milestone).toHaveTextContent("You have completed your November 3, 2026 election draft.");
    expect(milestone).not.toHaveTextContent(/decided/);
    expect(screen.queryByRole("link", { name: /Sign up/ })).not.toBeInTheDocument();
    // Both scopes marked: this box never comes back, and the header notice
    // must not fire for a day read about here.
    expect(JSON.parse(window.localStorage.getItem("voteapp_draft_complete_seen") ?? "[]")).toEqual(["2026-11-03"]);
    expect(JSON.parse(window.localStorage.getItem("voteapp_draft_milestone_seen") ?? "[]")).toEqual(["2026-11-03"]);
    // The honorary-member ask rides the same single moment (not a member).
    const ask = await screen.findByRole("region", { name: "Support this work" });
    expect(ask).toHaveTextContent("Your draft is done.");
    expect(screen.getByRole("link", { name: "See our mission and join us" })).toHaveAttribute("href", "/mission");
  });

  it("shows neither the milestone nor the member ask on a later visit (once per browser)", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("voteapp_draft_milestone_seen", JSON.stringify(["2026-11-03"]));
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [electionChoice(), electionChoice({ election_id: "e-2", official_ballot_title: "Mayor" })],
          },
        },
      })
    );
    renderPicks();
    expect(await screen.findByRole("progressbar", { name: "2 of 2 races decided" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /election draft milestone/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Support this work" })).not.toBeInTheDocument();
  });

  it("skips the member ask for members and when Stripe is off", async () => {
    const complete = {
      "/api/me/election-choices": {
        body: {
          choices: [electionChoice(), electionChoice({ election_id: "e-2", official_ballot_title: "Mayor" })],
        },
      },
    };
    window.localStorage.clear();
    stubApiRoutes(
      verifiedRoutes({
        ...complete,
        "/api/me/membership": {
          body: {
            enabled: true,
            membership: {
              stripe_status: "active",
              monthly_amount_cents: 500,
              cancel_at_period_end: false,
              current_period_end: null,
              started_at: "2026-08-01T00:00:00.000Z",
            },
            total_net_cents: 500,
            payments: [],
          },
        },
      })
    );
    const first = renderPicks();
    expect(await screen.findByRole("region", { name: /election draft milestone/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Support this work" })).not.toBeInTheDocument();
    first.unmount();

    window.localStorage.clear();
    stubApiRoutes(verifiedRoutes({ ...complete, "/api/me/membership": { body: { enabled: false } } }));
    renderPicks();
    expect(await screen.findByRole("region", { name: /election draft milestone/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Support this work" })).not.toBeInTheDocument();
  });

  it("judges the nearest UPCOMING day, skipping a just-finished day still carded", async () => {
    window.localStorage.clear();
    stubApiRoutes(
      verifiedRoutes({
        // A finished July race (no pick) still rides the ballot; November is
        // the nearest upcoming day and it is fully decided.
        "/api/me/ballot": {
          body: ballotSummary([
            electionSummary({ id: "e-july", election_date: "2026-07-28", official_ballot_title: "Special" }),
            electionSummary(),
          ]),
        },
      })
    );
    renderPicks();

    expect(await screen.findByRole("region", { name: "November 3, 2026 election draft milestone" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /July 28, 2026 election draft milestone/ })).not.toBeInTheDocument();
  });

  it("shows no milestone while a race on the nearest day is still open", async () => {
    window.localStorage.clear();
    stubApiRoutes(verifiedRoutes());
    renderPicks();
    expect(await screen.findByRole("progressbar", { name: "1 of 2 races decided" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /election draft milestone/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("voteapp_draft_complete_seen")).toBeNull();
  });

  it("asks logged-out visitors to log in", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderPicks();
    expect(await screen.findByText(/Log in to plan your votes/)).toBeInTheDocument();
  });

  it("shows unverified users the verify interstitial AND their picks", async () => {
    // Choices are not verification-gated (any registered session may pick),
    // so the verify wall must not hide a pick the user just saved.
    stubApiRoutes({
      "/api/me": { body: ME_UNVERIFIED },
      "/api/me/election-choices": { body: { choices: [electionChoice()] } },
      "/api/me/pick-card-shares": { body: { shares: [] } },
    });
    renderPicks();
    expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Your upcoming picks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Governor" })).toHaveAttribute("href", "/elections/e-1");
    expect(screen.getByText(/Jane Smith/)).toBeInTheDocument();
  });

  it("lists an upcoming pick on a race missing from the saved ballot", async () => {
    // The choice API accepts picks on any upcoming race (candidate search,
    // shared links, an old address) — the cards only render the saved
    // ballot, so such a pick must surface in its own section instead of
    // silently vanishing.
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice(),
              electionChoice({
                election_id: "e-offballot",
                official_ballot_title: "Attorney General",
                election_date: "2026-11-03",
              }),
            ],
          },
        },
      })
    );
    renderPicks();

    expect(await screen.findByRole("heading", { name: "Other upcoming picks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Attorney General" })).toHaveAttribute(
      "href",
      "/elections/e-offballot"
    );
    // The carded race stays on its date card only — no duplicate row here.
    const section = screen.getByRole("heading", { name: "Other upcoming picks" }).closest("section");
    expect(section).not.toHaveTextContent("Governor");
  });

  it("offers removal on a withdrawn upcoming pick and PUTs chosen: false", async () => {
    // A withdrawn candidacy vanishes from election payloads, so no pick
    // button anywhere can toggle it off — this page's remove control is the
    // only way a multi-seat slot held by a withdrawn pick gets freed.
    const puts: unknown[] = [];
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": (_url: URL, init?: RequestInit) => {
          if (init?.method === "PUT") {
            puts.push(JSON.parse(String(init.body)));
            return { status: 200, body: { choice: electionChoice({ picks: [] }) } };
          }
          return {
            body: {
              choices: [
                electionChoice({
                  picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "withdrawn" }],
                }),
              ],
            },
          };
        },
      })
    );
    renderPicks();

    expect(await screen.findByText("(withdrew)")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove pick: Jane Smith" }));
    await waitFor(() =>
      expect(puts).toEqual([{ election_id: "e-1", candidate_id: "c-1", chosen: false }])
    );
  });

  it("offers no removal on a withdrawn pick from a past election", async () => {
    // The backend rejects choice writes to past elections — a dead button
    // whose only outcome is an error must not render.
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice({
                election_id: "e-past",
                election_date: "2026-05-05",
                picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "withdrawn" }],
              }),
            ],
          },
        },
      })
    );
    renderPicks();

    expect(await screen.findByText("(withdrew)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove pick/ })).not.toBeInTheDocument();
  });

  it("asks for an address when the empty ballot has no districts", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/ballot": { body: { district_ids: [], districts: [], elections: [] } },
        "/api/me/election-choices": { body: { choices: [] } },
      })
    );
    renderPicks();

    expect(await screen.findByRole("link", { name: "Set your address" })).toHaveAttribute(
      "href",
      "/me/ballot"
    );
  });

  it("omits the address ask when districts are known but no election is upcoming", async () => {
    // The lookup ran and simply found nothing — telling this viewer to set an
    // address they already set would read as a bug.
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/ballot": { body: ballotSummary([]) },
        "/api/me/election-choices": { body: { choices: [] } },
      })
    );
    renderPicks();

    expect(await screen.findByText("No upcoming elections on your ballot yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Set your address" })).not.toBeInTheDocument();
  });

  it("marks a measure pick with its outcome, muted when it went against the pick", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/ballot": {
          body: ballotSummary([
            electionSummary({ race_type: "ballot_measure", candidate_count: 0 }),
            electionSummary({
              id: "e-2",
              official_ballot_title: "Proposition 9",
              race_type: "ballot_measure",
              candidate_count: 0,
            }),
          ]),
        },
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice({ picks: [], measure_position: "yes", measure_result: "passed" }),
              electionChoice({
                election_id: "e-2",
                official_ballot_title: "Proposition 9",
                race_type: "ballot_measure",
                picks: [],
                measure_position: "yes",
                measure_result: "failed",
              }),
            ],
          },
        },
      })
    );
    renderPicks();

    // Matched pick: green chip; unmatched: muted — same semantics as the
    // candidate Won/Lost chips.
    expect(await screen.findByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("Passed").className).toContain("bg-green-700");
    // The exact muted style, not just "not green": a broken class would
    // otherwise pass.
    expect(screen.getByText("Failed").className).toContain("bg-surface");
  });

  it("renders a date card with picked and undecided races", async () => {
    stubApiRoutes(verifiedRoutes());
    renderPicks();

    // Date card heading + decided count.
    expect(await screen.findByRole("heading", { name: "November 3, 2026" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "1 of 2 races decided" })).toBeInTheDocument();

    // Picked race: title links to the race, pick renders beside it.
    expect(screen.getByRole("link", { name: "Governor" })).toHaveAttribute("href", "/elections/e-1");
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();

    // Undecided race: the grey line itself is the link to the race.
    const undecided = screen.getByRole("link", { name: "Mayor — no pick yet" });
    expect(undecided).toHaveAttribute("href", "/elections/e-2");

    // The follows manager and issue editor live on their own pages now
    // (/me/follows and Settings) — not here.
    expect(screen.queryByRole("heading", { name: "My Candidates" })).not.toBeInTheDocument();
    expect(screen.queryByText("My most important issues")).not.toBeInTheDocument();
  });

  it("mints a share link on demand and swaps in the share menu", async () => {
    const fetchMock = stubApiRoutes(
      verifiedRoutes({
        // Same path, two shapes: GET lists, POST mints. Stateful: after the
        // mint the list must carry the link, because the page reads ONLY the
        // list (the refetch after minting would otherwise wipe the link).
        "/api/me/pick-card-shares": (() => {
          const share = { token: "tok_abcdefghijklmnopqrstuvwxyz012345", election_date: "2026-11-03" };
          let minted = false;
          return (_url: URL, init?: RequestInit) => {
            if (init?.method === "POST") {
              minted = true;
              return { body: { share } };
            }
            return { body: { shares: minted ? [share] : [] } };
          };
        })(),
      })
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicks();

    await user.click(await screen.findByRole("button", { name: "Share my November 3, 2026 picks" }));

    // The standard ShareButton takes over once the token exists (menu shape
    // in jsdom — no navigator.share), alongside the live link.
    expect(await screen.findByRole("button", { name: "Share my November 3, 2026 picks" })).toBeInTheDocument();
    expect(screen.queryByText("Anyone with the link can see this card and your first name.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop sharing/ })).not.toBeInTheDocument();

    // The minted URL itself is visible — canonical host in the text, the
    // relative path as the href (the token only resolves where it was
    // minted; see ShareCardControl).
    const mintedLink = screen.getByRole("link", {
      name: "electionssimplified.com/picks/tok_abcdefghijklmnopqrstuvwxyz012345",
    });
    expect(mintedLink).toHaveAttribute("href", "/picks/tok_abcdefghijklmnopqrstuvwxyz012345");
    expect(mintedLink).toHaveAttribute("target", "_blank");

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(String(post![0])).toContain("/api/me/pick-card-shares");
    expect(JSON.parse(String(post![1]!.body))).toEqual({ election_date: "2026-11-03" });

    // The minted link lands in the share menu's copy target.
    await user.click(screen.getByRole("button", { name: "Share my November 3, 2026 picks" }));
    expect(await screen.findByRole("menuitem", { name: "Share on X" })).toHaveAttribute(
      "href",
      expect.stringContaining("tok_abcdefghijklmnopqrstuvwxyz012345")
    );
  });

  it("shows an error instead of all-undecided cards when the choices fetch fails", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": apiError(500, "internal_error", "boom"),
      })
    );
    renderPicks();

    // The error is the whole story: no card may render claiming races are
    // undecided when the truth is unknown.
    expect(await screen.findByText(/Could not load your picks/)).toBeInTheDocument();
    expect(screen.queryByText(/no pick yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "November 3, 2026" })).not.toBeInTheDocument();
  });

  it("shows an existing share link and Share button without the removed controls", async () => {
    const fetchMock = stubApiRoutes(verifiedRoutes({
      "/api/me/pick-card-shares": { body: { shares: [{ token: "tok_abcdefghijklmnopqrstuvwxyz012345", election_date: "2026-11-03" }] } },
    }));
    renderPicks();
    expect(await screen.findByRole("link", { name: "electionssimplified.com/picks/tok_abcdefghijklmnopqrstuvwxyz012345" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share my November 3, 2026 picks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop sharing/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Anyone with the link can see this card and your first name.")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "DELETE")).toBe(false);
  });

  it("hides the share control on a card with zero picks", async () => {
    stubApiRoutes(verifiedRoutes({ "/api/me/election-choices": { body: { choices: [] } } }));
    renderPicks();

    expect(await screen.findByRole("heading", { name: "November 3, 2026" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "0 of 2 races decided" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument();
  });

  it("keeps Share on a zero-pick card whose link is still live", async () => {
    // An existing link remains available after picks are cleared.
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": { body: { choices: [] } },
        "/api/me/pick-card-shares": {
          body: { shares: [{ token: "tok_abcdefghijklmnopqrstuvwxyz012345", election_date: "2026-11-03" }] },
        },
      })
    );
    renderPicks();

    expect(await screen.findByRole("button", { name: "Share my November 3, 2026 picks" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "electionssimplified.com/picks/tok_abcdefghijklmnopqrstuvwxyz012345" })
    ).toBeInTheDocument();
    // Not listed a second time below the cards: the card owns this date.
    expect(screen.queryByText(/^Shared links/)).not.toBeInTheDocument();
  });

  it("lists a live link for a date with no card under Shared links, with Share", async () => {
    // The election dropped off the ballot (or the address changed): no card,
    // but the link keeps serving results and the first name. Verified and
    // unverified renders both list it.
    const share = { token: "tok_pastdate_0123456789abcdefghijklmn", election_date: "2026-08-04" };
    stubApiRoutes(verifiedRoutes({ "/api/me/pick-card-shares": { body: { shares: [share] } } }));
    renderPicks();

    expect(await screen.findByText("Shared links (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share my August 4, 2026 picks" })).toBeInTheDocument();
    // The live URL itself, so the owner can see what is still public.
    expect(
      screen.getByRole("link", { name: "electionssimplified.com/picks/tok_pastdate_0123456789abcdefghijklmn" })
    ).toBeInTheDocument();
  });

  it("lists live links for unverified users too", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_UNVERIFIED },
      "/api/me/election-choices": { body: { choices: [] } },
      "/api/me/pick-card-shares": {
        body: { shares: [{ token: "tok_pastdate_0123456789abcdefghijklmn", election_date: "2026-08-04" }] },
      },
    });
    renderPicks();

    expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Share my August 4, 2026 picks" })).toBeInTheDocument();
  });

  it("keeps a just-finished election's card, with result chips, out of Past elections", async () => {
    // The ballot payload keeps finished races for a few days; the card must
    // live exactly as long, so results land on the very card that planned
    // the votes — not in the collapsed history.
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/ballot": {
          body: ballotSummary([
            electionSummary({
              election_date: "2026-07-28",
              has_results: true,
              current_result_outcome: "advanced",
              current_result_winners: [
                { candidate_id: "c-1", candidate_name: "Jane Smith", party: "Democratic" },
                { candidate_id: "c-2", candidate_name: "John James", party: "Republican" },
              ],
            }),
            electionSummary({ id: "e-2", official_ballot_title: "Mayor", election_date: "2026-07-28" }),
          ]),
        },
        "/api/me/election-choices": {
          body: { choices: [electionChoice({ election_date: "2026-07-28" })] },
        },
      })
    );
    renderPicks();

    expect(await screen.findByRole("heading", { name: "July 28, 2026" })).toBeInTheDocument();
    // The pick's own line carries the call.
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    // Still carded → not double-listed under Past elections.
    expect(screen.queryByText(/Past elections/)).not.toBeInTheDocument();
    // A race that can no longer be decided drops the "yet" (accessible name
    // only — sighted users read the empty pick column).
    expect(screen.getByRole("link", { name: "Mayor — no pick" })).toBeInTheDocument();
    expect(screen.queryByText(/no pick yet/)).not.toBeInTheDocument();
  });

  it("stays silent on a pick that missed the winners", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/ballot": {
          body: ballotSummary([
            electionSummary({
              election_date: "2026-07-28",
              has_results: true,
              current_result_outcome: "advanced",
              current_result_winners: [
                { candidate_id: "c-2", candidate_name: "John James", party: "Republican" },
              ],
            }),
          ]),
        },
        "/api/me/election-choices": {
          body: { choices: [electionChoice({ election_date: "2026-07-28" })] },
        },
      })
    );
    renderPicks();

    // The pick (c-1) is not among the winners: no chip, no loss flag.
    expect(await screen.findByText("Jane Smith")).toBeInTheDocument();
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
    expect(screen.queryByText("Lost")).not.toBeInTheDocument();
  });

  it("never doubles a certified candidacy chip with the result-derived one", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/ballot": {
          body: ballotSummary([
            electionSummary({
              election_date: "2026-07-28",
              has_results: true,
              current_result_outcome: "won",
              current_result_winners: [
                { candidate_id: "c-1", candidate_name: "Jane Smith", party: "Democratic" },
              ],
            }),
          ]),
        },
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice({
                election_date: "2026-07-28",
                picks: [{ candidate_id: "c-1", display_name: "Jane Smith", candidacy_status: "won" }],
              }),
            ],
          },
        },
      })
    );
    renderPicks();

    expect(await screen.findByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getAllByText("Won")).toHaveLength(1);
  });

  it("renders the ballot view on toggle: contest boxes in payload order, picks filled, withdrawn struck", async () => {
    const fetchMock = stubApiRoutes(
      verifiedRoutes({
        // ONE fetch serves both views: the preview payload is also the list
        // payload, so List and Ballot preview share the same order by design.
        "/api/me/ballot": {
          body: ballotSummary([
                  electionSummary({
                    id: "e-2",
                    official_ballot_title: "United States Senator",
                    preview: {
                      seats_to_fill: null,
                      candidates: [
                        {
                          candidate_election_id: "ce-2",
                          candidate_id: "c-2",
                          display_name: "Sam Senate",
                          party: "Republican",
                          is_incumbent: false,
                          status: "declared",
                        },
                      ],
                      measure: null,
                    },
                  }),
                  electionSummary({
                    preview: {
                      seats_to_fill: 2,
                      candidates: [
                        {
                          candidate_election_id: "ce-1",
                          candidate_id: "c-1",
                          display_name: "Jane Smith",
                          party: "Democratic",
                          is_incumbent: true,
                          status: "declared",
                        },
                        {
                          candidate_election_id: "ce-3",
                          candidate_id: "c-3",
                          display_name: "Walt Withdrawn",
                          party: "Independent",
                          is_incumbent: false,
                          status: "withdrawn",
                        },
                      ],
                      measure: null,
                    },
                  }),
                  electionSummary({
                    id: "e-3",
                    official_ballot_title: "Measure H",
                    race_type: "ballot_measure",
                    candidate_count: 0,
                    preview: {
                      seats_to_fill: null,
                      candidates: [],
                      measure: {
                        id: "m-1",
                        official_ballot_title: "Measure H",
                        summary: "A parcel tax.",
                        what_yes_means: "Adopts the tax.",
                        what_no_means: "Keeps current law.",
                      },
                    },
                  }),
                ]),
        },
        "/api/me/election-choices": {
          body: { choices: [electionChoice(), electionChoice({ election_id: "e-3", race_type: "ballot_measure", picks: [], measure_position: "yes" })] },
        },
      })
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicks();

    await user.click(await screen.findByRole("button", { name: "Ballot preview" }));

    // The fetch pins its own ordering contract — the user's saved list sort
    // must never reorder this page — and toggling views must NOT refetch:
    // one payload backs both List and Ballot preview.
    const ballotCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/me/ballot?"));
    expect(ballotCalls).toHaveLength(1);
    expect(String(ballotCalls[0][0])).toContain("include=preview");
    expect(String(ballotCalls[0][0])).toContain("sort=state_baseline");
    expect(String(ballotCalls[0][0])).toContain("followed_first=false");

    // Sheet header + disclaimer.
    expect(await screen.findByRole("heading", { name: /Ballot preview — November 3, 2026/ })).toBeInTheDocument();
    expect(screen.getByText("Not an official ballot")).toBeInTheDocument();

    // Contest boxes render in PAYLOAD order (Senator first), not list order.
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["United States Senator", "Governor", "Measure H"]);

    // Multi-seat instruction from seats_to_fill; single/null renders as one.
    expect(screen.getByText("Vote for up to 2")).toBeInTheDocument();
    expect(screen.getByText("Vote for One")).toBeInTheDocument();

    // The pick: filled oval is visual; the textual chip is the contract.
    expect(screen.getAllByText("My pick").length).toBe(2); // Jane + measure Yes
    expect(screen.getByText("Jane Smith").className).toContain("font-bold");

    // Withdrawn candidacy stays visible, struck through, with the warning.
    expect(screen.getByText("Walt Withdrawn").className).toContain("line-through");
    expect(screen.getByText(/withdrew — votes may not count/)).toBeInTheDocument();

    // Measure: VoteApp summary is labeled as ours, never as ballot text.
    expect(screen.getByText(/VoteApp summary \(not the printed ballot text\): A parcel tax\./)).toBeInTheDocument();

    // Toggling back restores the list cards.
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(await screen.findByRole("progressbar", { name: /races decided/ })).toBeInTheDocument();
  });

  it("lists past picks in a collapsible section with won/lost flags", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice(),
              electionChoice({
                election_id: "e-old",
                official_ballot_title: "Sheriff",
                election_date: "2024-11-05",
                picks: [{ candidate_id: "c-9", display_name: "Pat Winner", candidacy_status: "won" }],
              }),
              // Certified primaries project advanced/runoff onto winners'
              // candidacy_status; past picks have no result-row fallback, so
              // the chip must come from the status alone.
              electionChoice({
                election_id: "e-old-2",
                official_ballot_title: "Judge",
                election_date: "2024-08-06",
                picks: [
                  { candidate_id: "c-10", display_name: "Ada Advancer", candidacy_status: "advanced" },
                  { candidate_id: "c-11", display_name: "Rae Runoff", candidacy_status: "runoff" },
                ],
              }),
              // Pre-certification: candidacy_status still "declared", but the
              // choices list read attaches the canonical election-night
              // result — history must not lose the call for the weeks until
              // certification.
              electionChoice({
                election_id: "e-old-3",
                official_ballot_title: "Auditor",
                election_date: "2026-07-28",
                picks: [{ candidate_id: "c-12", display_name: "Nia Night", candidacy_status: "declared" }],
                current_result_outcome: "won",
                current_result_winners: [{ candidate_id: "c-12", candidate_name: "Nia Night" }],
              }),
              electionChoice({
                election_id: "e-old-4",
                official_ballot_title: "Prop 9",
                election_date: "2026-07-28",
                race_type: "ballot_measure",
                picks: [],
                measure_position: "yes",
                measure_result: null,
                current_result_outcome: "passed",
              }),
            ],
          },
        },
      })
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicks();

    const summary = await screen.findByText("Past elections (4)");
    await user.click(summary);

    expect(screen.getByText("Pat Winner")).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(screen.getByText("In runoff")).toBeInTheDocument();
    // Pat Winner's certified chip and Nia Night's election-night chip.
    expect(screen.getAllByText("Won")).toHaveLength(2);
    // The measure's election-night passed fills in for the certified field.
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sheriff" })).toHaveAttribute("href", "/elections/e-old");
  });

  it("badges auto picks and swaps the fill button for Clear once the engine has picked", async () => {
    // e-1's pick came from the engine (origin auto) → Auto chip + a clear
    // button; e-2 is still open, but the fill button stays hidden until Clear
    // runs — a rerun would only repeat the engine's "not enough evidence".
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice({
                picks: [
                  {
                    candidate_id: "c-1",
                    display_name: "Jane Smith",
                    candidacy_status: "declared",
                    origin: "auto",
                  },
                ],
              }),
            ],
          },
        },
      })
    );
    renderPicks();

    expect(await screen.findByText("Auto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear auto picks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-fill empty picks by my issues" })).toBeNull();
  });

  it("annotates undecided rows with the engine's reason after a fill run", async () => {
    // e-2 stays open (insufficient evidence): no result list — the reason
    // lands on the race row itself.
    const user = userEvent.setup();
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/research-area-preferences": {
          body: {
            preferences: [1, 2, 3].map((rank) => ({
              research_area_id: `a-${rank}`,
              slug: `issue-${rank}`,
              name: `Issue ${rank}`,
              description: null,
              rank,
              direction: "support",
              hard_veto: false,
            })),
          },
        },
        "/api/me/auto-picks": {
          body: {
            results: [
              {
                election_id: "e-2",
                race_type: "office",
                outcome: "no_pick",
                reason: "insufficient_evidence",
                picked_candidate_ids: [],
                measure_position: null,
                shortlist_candidate_ids: [],
                candidates: [],
                measure_per_issue: [],
                unresearched: [],
              },
            ],
          },
        },
      })
    );
    renderPicks();

    const button = await screen.findByRole("button", { name: "Auto-fill empty picks by my issues" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    // One summary line for the run, not a note on every open row.
    expect(
      await screen.findByText("Auto-fill picked 0 races · 1 left open: not enough evidence")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mayor — no pick yet" })).toBeInTheDocument();
  });

  it("keeps fill-run reasons across a switch to ballot view", async () => {
    // The results live in PicksPage, not the card: running a fill in list
    // view and toggling views must not discard the "why was this left
    // open" feedback — the ballot sheet's contest box carries it instead.
    const user = userEvent.setup();
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/research-area-preferences": {
          body: {
            preferences: [1, 2, 3].map((rank) => ({
              research_area_id: `a-${rank}`,
              slug: `issue-${rank}`,
              name: `Issue ${rank}`,
              description: null,
              rank,
              direction: "support",
              hard_veto: false,
            })),
          },
        },
        "/api/me/auto-picks": {
          body: {
            results: [
              {
                election_id: "e-2",
                race_type: "office",
                outcome: "no_pick",
                reason: "insufficient_evidence",
                picked_candidate_ids: [],
                measure_position: null,
                shortlist_candidate_ids: [],
                candidates: [],
                measure_per_issue: [],
                unresearched: [],
              },
            ],
          },
        },
      })
    );
    renderPicks();

    const button = await screen.findByRole("button", { name: "Auto-fill empty picks by my issues" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByText(/1 left open: not enough evidence/);

    await user.click(screen.getByRole("button", { name: "Ballot preview" }));

    expect(await screen.findByText("Auto pick left this open: not enough evidence.")).toBeInTheDocument();
  });

  it("shows no batch controls when everything is decided by hand", async () => {
    stubApiRoutes(
      verifiedRoutes({
        "/api/me/election-choices": {
          body: {
            choices: [
              electionChoice(),
              electionChoice({ election_id: "e-2", official_ballot_title: "Mayor" }),
            ],
          },
        },
      })
    );
    renderPicks();

    // The card's own count line (the finished-draft milestone above the
    // toggle repeats the count in a longer sentence).
    await screen.findByRole("progressbar", { name: "2 of 2 races decided" });
    expect(screen.queryByText("Auto")).toBeNull();
    expect(screen.queryByRole("button", { name: /Auto-fill empty picks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear auto picks" })).toBeNull();
  });
});

describe("PicksPage nav context", () => {
  const MY_PICKS_STATE = { backTo: { path: "/me/picks", label: "My Election Draft" } };

  it("hands election links My Election Draft as their back destination", async () => {
    const user = userEvent.setup();
    stubApiRoutes(verifiedRoutes());
    const { router } = renderPicks();

    await user.click(await screen.findByRole("link", { name: "Governor" }));

    expect(router.state.location.pathname).toBe("/elections/e-1");
    expect(router.state.location.state).toEqual(MY_PICKS_STATE);
  });

  it("links pick names to the candidate profile with picks back state", async () => {
    const user = userEvent.setup();
    stubApiRoutes(verifiedRoutes());
    const { router } = renderPicks();

    await user.click(await screen.findByRole("link", { name: "Jane Smith" }));

    expect(router.state.location.pathname).toBe("/candidates/c-1");
    // electionId scopes the profile's candidacy context to the picked race.
    expect(router.state.location.state).toEqual({ ...MY_PICKS_STATE, electionId: "e-1" });
  });
});

it("counts contested progress while keeping retention answers in a collapsed group", async () => {
  window.localStorage.clear();
  stubApiRoutes(verifiedRoutes({
    "/api/me/ballot": { body: ballotSummary([retentionElection("r-1"), electionSummary(), retentionElection("r-2")]) },
    "/api/me/election-choices": { body: { choices: [electionChoice(), electionChoice({ election_id: "r-1", picks: [], measure_position: "no" })] } },
  }));
  renderPicks();
  expect(await screen.findByRole("progressbar", { name: "1 of 1 race decided" })).toHaveAttribute("aria-valuemax", "1");
  expect(screen.getByRole("region", { name: /election draft milestone/ })).toHaveTextContent("Retention races are still open on your draft.");
  const group = screen.getByRole("button", { name: "Retention Races" });
  expect(group).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("link", { name: /Shall Judge/ })).not.toBeInTheDocument();
  await userEvent.click(group);
  expect(screen.getAllByRole("link", { name: /Shall Judge/ })).toHaveLength(2);
  expect(screen.getByText("No")).toBeInTheDocument();
});

it("keeps a lone retention in the date progress", async () => {
  stubApiRoutes(verifiedRoutes({
    "/api/me/ballot": { body: ballotSummary([electionSummary(), retentionElection("r-1")]) },
  }));
  renderPicks();
  expect(await screen.findByRole("progressbar", { name: "1 of 2 races decided" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Retention Races/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Shall Judge/ })).toBeInTheDocument();
});

it("keeps Share available for retention-only picks and omits an empty contested progress bar", async () => {
  stubApiRoutes(verifiedRoutes({
    "/api/me/ballot": { body: ballotSummary([retentionElection("r-1"), retentionElection("r-2")]) },
    "/api/me/election-choices": { body: { choices: [electionChoice({ election_id: "r-1", picks: [], measure_position: "yes" })] } },
  }));
  renderPicks();
  expect(await screen.findByRole("button", { name: "Retention Races" })).toBeInTheDocument();
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  expect(screen.getByRole("progressbar", { name: "1 of 2 retention races decided" })).toHaveAttribute("aria-valuenow", "1");
  expect(screen.getByRole("button", { name: /Share/ })).toBeInTheDocument();
});

// Real detail navigation must preserve each date's disclosure state.
it.each(["back link", "browser Back"])("restores signed-in retention expansion via %s", async (returnVia) => {
  const elections = [electionSummary(), retentionElection("r-1"), retentionElection("r-2"),
    retentionElection("r-3", { election_date: "2027-11-02" }),
    retentionElection("r-4", { election_date: "2027-11-02" })];
  stubApiRoutes(verifiedRoutes({ "/api/me/ballot": { body: ballotSummary(elections) } }));
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { router } = renderRoutes([
    { path: "/me/picks", element: <PicksPage /> },
    { path: "/elections/:electionId", element: <ElectionPage />, hydrateFallbackElement: <p />,
      loader: () => electionDetail({ id: "r-1", official_ballot_title: elections[1].official_ballot_title }) },
  ], "/me/picks");
  const groups = () => screen.getAllByRole("button", { name: "Retention Races" });
  await screen.findAllByRole("button", { name: "Retention Races" });
  expect(groups()[0]).toHaveAttribute("aria-expanded", "false");
  await user.click(groups()[0]);
  await user.click(screen.getByRole("link", { name: new RegExp(elections[1].official_ballot_title) }));
  const back = await screen.findByRole("link", { name: "Back to My Election Draft" });
  if (returnVia === "back link") await user.click(back);
  else await act(async () => { await router.navigate(-1); });
  await waitFor(() => expect(groups()[0]).toHaveAttribute("aria-expanded", "true"));
  expect(groups()[1]).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("link", { name: new RegExp(elections[1].official_ballot_title) })).toBeInTheDocument();
  await user.click(groups()[0]);
  expect(router.state.location.state.expandedRetentionDates).toEqual([]);
  await user.click(groups()[0]);
  await act(async () => { await router.navigate("/me/picks", { state: null }); });
  expect(groups()[0]).toHaveAttribute("aria-expanded", "false");
});
