import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PRE_SEARCH_NOTICE, TERMS_VERSION } from "@voteapp/api-client";
import { HomePage } from "./HomePage";
import { electionSummary } from "../test/fixtures";

const ADDRESS_LABEL = "Enter address or ZIP to see your own elections and candidates";

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <HomePage /> },
    { path: "/ballot", element: <p /> },
    { path: "/disclaimer", element: <p /> },
    { path: "/terms", element: <p /> },
    { path: "/privacy", element: <p /> },
  ]);
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...rendered, router };
}

function stubResolveFetch(
  resolution: Record<string, unknown> = { matched_address: "123 Main St", address_match_count: 1, districts: [], scope: "exact" }
) {
  const fetchMock = vi.fn().mockImplementation(async (path: string) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () =>
      path === "/api/address/resolve"
        ? resolution
        : // The autocomplete suggest call races these tests on a real 275ms
          // debounce timer; it must get a well-formed (empty) response, not
          // the fallthrough body, whenever it happens to fire in time.
          path === "/api/address/autocomplete"
          ? { suggestions: [] }
          : { user: null },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function typeAddress(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(ADDRESS_LABEL), "123 Main St, Austin, TX");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The three hops behind the nearby-elections block, keyed by path prefix so
// the ballot query's district_ids/sort query string matches too.
const NEARBY_RESOLUTION = {
  matched_address: "Fresno, CA",
  address_match_count: 1,
  scope: "region",
  districts: [
    { id: "d-ca", district_type: "statewide", geoid_compact: "06", name: "California", state: "CA", population: null, representation_power_score: null },
    { id: "d-fresno", district_type: "place", geoid_compact: "0627000", name: "Fresno city, California", state: "CA", population: null, representation_power_score: null },
  ],
};
const FRESNO = { id: "d-fresno", district_type: "place", name: "Fresno city, California", state: "CA" };
const NEARBY_ELECTIONS = [
  electionSummary({ id: "e1", district_id: FRESNO.id, district: FRESNO, official_ballot_title: "Mayor of Fresno" }),
  electionSummary({ id: "e2", official_ballot_title: "Governor" }),
  electionSummary({ id: "e3", official_ballot_title: "Lieutenant Governor" }),
  electionSummary({ id: "e4", official_ballot_title: "Spring runoff", election_date: "2027-04-06" }),
];

const FRESNO_POINT = { lat: 36.7378, lng: -119.7871 };

function stubNearbyFetch({
  geoHint = { ok: true, status: 200, body: { location: { state: "CA", city: "Fresno", coordinates: FRESNO_POINT } } },
  pointResolve = "ok",
}: {
  geoHint?: { ok: boolean; status: number; body: unknown };
  /** Whether the coordinate resolve succeeds or 422s (point matched nothing). */
  pointResolve?: "ok" | "fail";
} = {}) {
  const fetchMock = vi.fn().mockImplementation(async (path: string, init?: { body?: string }) => {
    const respond = (body: unknown, ok = true, status = 200) => ({
      ok,
      status,
      headers: new Headers(),
      json: async () => body,
    });
    if (path === "/api/geo-hint") {
      return respond(geoHint.body, geoHint.ok, geoHint.status);
    }
    if (path === "/api/address/resolve") {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if ("coordinates" in body) {
        // The point first: no region fields (the resolver would take the
        // region path over the point), no terms version (nothing was clicked).
        expect(body).toEqual({ address: "Fresno, CA", allow_partial: true, coordinates: FRESNO_POINT });
        return pointResolve === "ok"
          ? respond({ ...NEARBY_RESOLUTION, scope: "exact" })
          : respond({ error: { code: "not_found", message: "no match" } }, false, 422);
      }
      // The city fallback.
      expect(body).toEqual({ address: "Fresno, CA", allow_partial: true, region_state: "CA", region_locality: "Fresno" });
      return respond(NEARBY_RESOLUTION);
    }
    if (path.startsWith("/api/ballot?")) {
      expect(path).toBe("/api/ballot?district_ids=d-ca%2Cd-fresno&sort=state_baseline");
      return respond({ district_ids: ["d-ca", "d-fresno"], districts: [], elections: NEARBY_ELECTIONS });
    }
    if (path === "/api/address/autocomplete") {
      return respond({ suggestions: [] });
    }
    return respond({ user: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("HomePage nearby elections", () => {
  it("lists the hinted city's races under the search in the ballot page's cards", async () => {
    stubNearbyFetch();
    renderHome();

    // One heading names the place and the date; the list's own date heading
    // is withheld so the date is said once.
    expect(
      await screen.findByRole("heading", { level: 2, name: "Sample elections near Fresno, CA on November 3, 2026" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Elections on November 3, 2026" })).not.toBeInTheDocument();
    // The pitch stays the page's only h1; this block is a section under it.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Enter address above for your full ballot")).toBeInTheDocument();

    // The nearest date's races, in the ballot's order, as ElectionList cards,
    // each title linking to its election page; a later date is left out.
    expect(screen.getByRole("link", { name: /Mayor of Fresno/ })).toHaveAttribute("href", "/elections/e1");
    expect(screen.getByRole("link", { name: /^Governor/ })).toHaveAttribute("href", "/elections/e2");
    expect(screen.getByRole("link", { name: /Lieutenant Governor/ })).toHaveAttribute("href", "/elections/e3");
    expect(screen.queryByRole("link", { name: /Spring runoff/ })).not.toBeInTheDocument();
  });

  it("falls back to the city path when the point resolves nothing", async () => {
    const fetchMock = stubNearbyFetch({ pointResolve: "fail" });
    renderHome();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Sample elections near Fresno, CA on November 3, 2026" })
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/address/resolve")).toHaveLength(2);
  });

  it("goes straight to the city path when the hint carries no point", async () => {
    const fetchMock = stubNearbyFetch({
      geoHint: { ok: true, status: 200, body: { location: { state: "CA", city: "Fresno", coordinates: null } } },
    });
    renderHome();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Sample elections near Fresno, CA on November 3, 2026" })
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/address/resolve")).toHaveLength(1);
  });

  it("renders nothing when the edge has no location for the visitor", async () => {
    const fetchMock = stubNearbyFetch({ geoHint: { ok: true, status: 200, body: { location: null } } });
    renderHome();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/geo-hint", expect.anything()));
    // Give the chain a tick: no resolve, no ballot, no section.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/address/resolve");
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("renders nothing when the hint path is missing (a backend reached without the Worker)", async () => {
    const fetchMock = stubNearbyFetch({
      geoHint: { ok: false, status: 404, body: { error: { code: "not_found", message: "Not found" } } },
    });
    renderHome();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/geo-hint", expect.anything()));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/address/resolve");
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("sends a sample card's back link to the home URL as opened, ?new=1 included", async () => {
    stubNearbyFetch();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        { path: "/", element: <HomePage /> },
        { path: "/elections/:id", element: <p>election</p> },
      ],
      { initialEntries: ["/?new=1"] }
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    await userEvent.setup().click(await screen.findByRole("link", { name: /Mayor of Fresno/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/elections/e1"));
    // A bare "/" would bounce a verified one-off visitor to /me/ballot.
    expect((router.state.location.state as { backTo: { path: string; label: string } }).backTo).toEqual({
      path: "/?new=1",
      label: "Home",
    });
  });

  it("skips the lookups for a verified user, who is leaving for the saved ballot", async () => {
    const fetchMock = stubNearbyFetch();
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        path === "/api/me"
          ? { user: { id: "u1", email: "v@example.com", email_verified: true, terms_version: TERMS_VERSION } }
          : path === "/api/address/autocomplete"
            ? { suggestions: [] }
            : {},
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/", element: <HomePage /> },
      { path: "/me/ballot", element: <p>saved ballot</p> },
    ]);
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/me/ballot"));
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/geo-hint");
  });
});

describe("HomePage pre-search notice", () => {
  it("puts the agreement under the Search button, word for word, with every document linked", () => {
    renderHome();

    // A sign-in wrap: no checkbox, no dialog, one sentence beside the action.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const notice = screen.getByTestId("pre-search-notice");
    expect(notice.textContent?.replace(/\s+/g, " ").trim()).toBe(PRE_SEARCH_NOTICE);
    // Adjacency: the notice is the next thing after the button it names.
    const search = screen.getByRole("button", { name: "Search" });
    expect(search.parentElement?.nextElementSibling).toBe(notice);
    // Every document is reachable from the sentence itself, in a new tab so
    // reading one does not discard the typed address.
    for (const [name, href] of [
      ["Terms of Use", "/terms"],
      ["Privacy Policy", "/privacy"],
      ["AI-Assisted Research and Election Information Disclaimer", "/disclaimer"],
    ] as const) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(notice).toContainElement(link);
    }
  });

  it("treats pressing Search as the acceptance and opens the results at once", async () => {
    const fetchMock = stubResolveFetch();
    const user = userEvent.setup();
    const { router } = renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/ballot");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The search itself carries the acceptance; nothing is left for the
    // ballot page to ask.
    const resolveCall = fetchMock.mock.calls.find(([path]) => path === "/api/address/resolve");
    expect(JSON.parse((resolveCall as [string, { body: string }])[1].body)).toEqual({
      address: "123 Main St, Austin, TX",
      accepted_terms_version: TERMS_VERSION,
      allow_partial: true,
    });
    expect(router.state.location.state).toMatchObject({ matchedAddress: "123 Main St" });
    expect(router.state.location.state).not.toHaveProperty("termsPending");
  });

  it("opens on the pitch, with no brand mark of its own", () => {
    renderHome();
    // The brand mark is the shared header's corner logo (App.tsx); the pitch
    // is the first thing on the page and its sole h1.
    expect(screen.queryByText("Elections Simplified")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^See who your candidates really are by their track records$/
    );
  });

  it("lands the visitor on an empty, focused address field", () => {
    renderHome();
    // Google-style entry: no example address to clear away, just a cursor.
    // Focus comes from HomePage's mount effect, never the autoFocus prop:
    // that prop SSRs as a real autofocus attribute, which phones honor
    // before hydration and end up with a focused box under the search glyph.
    const input = screen.getByLabelText(ADDRESS_LABEL);
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("autofocus");
    expect(input).not.toHaveAttribute("placeholder");
  });

  it("keeps the box idle at phone widths so the glyph, not the cursor, greets", () => {
    // jsdom has no matchMedia; a phone-width stub flips the mount effect off.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    renderHome();
    const input = screen.getByLabelText(ADDRESS_LABEL);
    expect(input).not.toHaveFocus();
    expect(screen.getByTestId("address-search-hint")).toBeInTheDocument();
  });

  it("catches stray typing after a click on empty space, Google-style", async () => {
    const user = userEvent.setup();
    renderHome();
    const input = screen.getByLabelText(ADDRESS_LABEL);
    // A click on the (non-editable) pitch line steals focus from the box —
    // the browser's normal behavior this listener exists to soften.
    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(input).not.toHaveFocus();
    // A plain printable key comes back to the box…
    await user.keyboard("h");
    expect(input).toHaveFocus();
    // …but a copy/paste-style chord pressed elsewhere is left alone.
    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(input).not.toHaveFocus();
    await user.keyboard("{Meta>}c{/Meta}");
    expect(input).not.toHaveFocus();
  });

  it("leaves typing alone inside dialog overlays the page does not own", async () => {
    const user = userEvent.setup();
    renderHome();
    const input = screen.getByLabelText(ADDRESS_LABEL);
    // Stand-in for the overlays that can cover the landing (TermsRenewalGate,
    // the signed-in chat panel): a modal with a focused non-editable control.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    button.textContent = "Agree";
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();
    await user.keyboard("h");
    // Focus must stay in the modal, never drop behind it into the form.
    expect(button).toHaveFocus();
    expect(input).not.toHaveFocus();
    document.body.removeChild(dialog);
  });

  it("shows the idle search glyph and clears it on focus or text", async () => {
    const user = userEvent.setup();
    renderHome();
    const input = screen.getByLabelText(ADDRESS_LABEL);
    // jsdom reports desktop width, so the box autofocuses; blur to reach the
    // idle state a phone lands in (phones ignore autoFocus). The glyph is
    // desktop-hidden by CSS only (sm:hidden), so jsdom still renders it.
    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(screen.getByTestId("address-search-hint")).toBeInTheDocument();
    // Tapping the box clears it, Google-style...
    await user.click(input);
    expect(screen.queryByTestId("address-search-hint")).not.toBeInTheDocument();
    // ...and text keeps it away even after focus leaves.
    await user.type(input, "9");
    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(screen.queryByTestId("address-search-hint")).not.toBeInTheDocument();
  });

  it("names ZIP in the field label and keeps the explainer link inside it", () => {
    renderHome();
    // The label itself offers the escape hatch (ZIP) and the "why
    // address" explainer; the old note under the field is gone. The
    // explainer and the agreement line under Search carry the privacy
    // points at the point of collection.
    expect(screen.getByLabelText(ADDRESS_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(/is only used to find voting districts/)).not.toBeInTheDocument();
    expect(screen.queryByText(/You can also search by ZIP or city/)).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "why address?" });
    expect(trigger.parentElement?.textContent?.replace(/\s+/g, "")).toBe("(whyaddress?):");
  });

  it("explains why a full address is needed without treating the explanation as consent", async () => {
    const user = userEvent.setup();
    renderHome();

    const trigger = screen.getByRole("button", { name: "why address?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Why do you need the full address?" });
    expect(dialog).toHaveTextContent("Voting districts don’t necessarily follow ZIP codes.");
    expect(dialog).toHaveTextContent("Two homes in the same city or ZIP often vote in different races.");
    expect(dialog).toHaveTextContent("We do NOT save it to your account");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const privacyPolicy = screen.getByRole("link", { name: "Read our Privacy Policy" });
    expect(privacyPolicy).toHaveAttribute("href", "/privacy");
    expect(privacyPolicy).toHaveAttribute("target", "_blank");

    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not search without an address", async () => {
    const fetchMock = stubResolveFetch();
    const user = userEvent.setup();
    renderHome();

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/address/resolve")).toHaveLength(0);
  });
});

describe("HomePage ZIP partial flow", () => {
  const PENDING_KEY = "voteapp_pending_district_ids";

  async function searchFor(user: ReturnType<typeof userEvent.setup>, input: string) {
    await user.type(screen.getByLabelText(ADDRESS_LABEL), input);
    await user.click(screen.getByRole("button", { name: "Search" }));
  }

  it("routes a ZIP result to the ballot with partial=1 and clears any pending handoff", async () => {
    // A stale exact search must not initialize a later signup: last search wins.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(["stale-district"]));
    stubResolveFetch({
      matched_address: "78701",
      address_match_count: 1,
      districts: [{ id: "d-tx" }, { id: "d-travis" }],
      scope: "zip",
    });
    const user = userEvent.setup();
    const { router } = renderHome();

    await searchFor(user, "78701");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/ballot");
    });
    expect(router.state.location.search).toBe("?d=d-tx,d-travis&partial=1");
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("clears the pending handoff on a ZIP result even while identity is still loading", async () => {
    // The save is identity-gated (a verified user's one-off search must not
    // ARM the handoff); the clear is not — a stale exact set must never
    // outlive a newer partial search just because /api/me was slow.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(["stale-district"]));
    const fetchMock = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/api/me") {
        return new Promise(() => {}); // identity never resolves
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () =>
          path === "/api/address/resolve"
            ? { matched_address: "78701", address_match_count: 1, districts: [{ id: "d-tx" }], scope: "zip" }
            : { suggestions: [] },
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { router } = renderHome();

    await searchFor(user, "78701");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/ballot");
    });
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("disables Search after a stateless area selection and re-enables on the next edit", async () => {
    const suggestion = {
      place_id: "place-usa",
      description: "United States",
      main_text: "United States",
      secondary_text: "",
    };
    const fetchMock = vi.fn().mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        path === "/api/address/autocomplete"
          ? { suggestions: [suggestion] }
          : path === "/api/address/autocomplete/retrieve"
            ? {
                address: "United States",
                location: null,
                granularity: "region",
                postal_code: null,
                state: null,
                locality: null,
              }
            : { user: null },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText(ADDRESS_LABEL), "United States");
    await user.click(await screen.findByRole("option", { name: /United States/ }));

    // The selection is an area the server could not place in a state:
    // guidance appears and Search stays off — a submit could only die in the
    // geocoder. Escape first: Headless UI keeps the combobox marked open
    // after our custom option click (pre-existing quirk of the `static`
    // options pattern) and aria-hides the rest of the form while it is.
    expect(await screen.findByText(/We can’t place that selection in a state/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();

    await user.type(screen.getByLabelText(ADDRESS_LABEL), " 78701");
    expect(screen.queryByText(/We can’t place that selection in a state/)).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });

  it("holds Search while a selection's retrieve is in flight", async () => {
    const suggestion = {
      place_id: "place-la",
      description: "Los Angeles, CA, USA",
      main_text: "Los Angeles",
      secondary_text: "CA, USA",
    };
    let releaseRetrieve!: () => void;
    const retrieveGate = new Promise<void>((resolve) => {
      releaseRetrieve = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/api/address/autocomplete/retrieve") {
        // Held open until the test releases it — the window under test.
        await retrieveGate;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () =>
          path === "/api/address/autocomplete"
            ? { suggestions: [suggestion] }
            : path === "/api/address/autocomplete/retrieve"
              ? {
                  address: "Los Angeles, CA, USA",
                  location: null,
                  granularity: "region",
                  postal_code: null,
                  state: "CA",
                  locality: "Los Angeles",
                }
              : { user: null },
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderHome();

    await user.type(screen.getByLabelText(ADDRESS_LABEL), "Los Angeles");
    await user.click(await screen.findByRole("option", { name: /Los Angeles/ }));
    await user.keyboard("{Escape}");

    // The input already shows the picked description, but classification has
    // not landed — a submit now would send a bare area string to the
    // geocoder, so Search must hold.
    expect(screen.getByLabelText(ADDRESS_LABEL)).toHaveValue("Los Angeles, CA, USA");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();

    releaseRetrieve();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
    });
  });

  it("searches a city selection through the region path and routes with partial=1", async () => {
    const suggestion = {
      place_id: "place-la",
      description: "Los Angeles, CA, USA",
      main_text: "Los Angeles",
      secondary_text: "CA, USA",
    };
    const fetchMock = vi.fn().mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        path === "/api/address/autocomplete"
          ? { suggestions: [suggestion] }
          : path === "/api/address/autocomplete/retrieve"
            ? {
                address: "Los Angeles, CA, USA",
                location: null,
                granularity: "region",
                postal_code: null,
                state: "CA",
                locality: "Los Angeles",
              }
            : path === "/api/address/resolve"
              ? {
                  matched_address: "Los Angeles, CA, USA",
                  address_match_count: 1,
                  districts: [{ id: "d-ca" }, { id: "d-la" }],
                  scope: "region",
                }
              : { user: null },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { router } = renderHome();

    await user.type(screen.getByLabelText(ADDRESS_LABEL), "Los Angeles");
    await user.click(await screen.findByRole("option", { name: /Los Angeles/ }));
    await waitFor(() => {
      expect(screen.getByLabelText(ADDRESS_LABEL)).toHaveValue("Los Angeles, CA, USA");
    });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/ballot");
    });
    expect(router.state.location.search).toBe("?d=d-ca,d-la&partial=1");
    // The resolve body carries the server-classified region, never a point.
    const resolveCall = fetchMock.mock.calls.find(([path]) => path === "/api/address/resolve");
    const body = JSON.parse((resolveCall?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body.region_state).toBe("CA");
    expect(body.region_locality).toBe("Los Angeles");
    expect(body.coordinates).toBeUndefined();
  });

  it("routes an exact result without partial=1 and saves the pending handoff", async () => {
    stubResolveFetch({
      matched_address: "123 Main St",
      address_match_count: 1,
      districts: [{ id: "d-1" }],
      scope: "exact",
    });
    const user = userEvent.setup();
    const { router } = renderHome();

    await searchFor(user, "123 Main St, Austin, TX");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/ballot");
    });
    expect(router.state.location.search).toBe("?d=d-1");
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null")).toEqual(["d-1"]);
  });
});
