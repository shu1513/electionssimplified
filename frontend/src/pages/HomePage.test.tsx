import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PRE_SEARCH_AGREEMENT_PARAGRAPHS, TERMS_VERSION } from "@voteapp/api-client";
import { HomePage } from "./HomePage";

const ADDRESS_LABEL = "Enter address to see your elections and candidates:";
const STORAGE_KEY = "voteapp_terms_acceptance";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

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

describe("HomePage pre-search clickwrap", () => {
  it("keeps the landing page free of the gate until Search is pressed", async () => {
    const user = userEvent.setup();
    renderHome();

    // The wall of legal text is what moved off the page; a first-time visitor
    // sees an address field, not an agreement.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens on the pitch, with no brand mark of its own", () => {
    renderHome();
    // The brand mark is the shared header's corner logo (App.tsx); the pitch
    // is the first thing on the page and its sole h1.
    expect(screen.queryByText("Elections Simplified")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^Uncover who your candidates really are by their track records$/
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

  it("keeps the privacy note beside the address field, where collection starts", () => {
    renderHome();
    // The autocomplete forwards what is typed before Search is ever pressed,
    // so this notice may never move into the dialog. The home page carries a
    // compressed variant of ADDRESS_FIELD_PRIVACY_NOTE (same two promises:
    // district lookup only, never saved) plus the ZIP/city hint.
    expect(screen.getByText(/The address is only used to find voting districts/)).toBeInTheDocument();
    expect(screen.getByText(/You can also search by ZIP or city/)).toBeInTheDocument();
    // The policy is reachable without a second inline link — the footer
    // carries it site-wide and the explainer links it directly — so the note
    // offers the question people actually ask instead.
    expect(screen.queryByRole("link", { name: "Privacy notice" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Why full address?" })).toBeInTheDocument();
  });

  it("explains why a full address is needed without treating the explanation as consent", async () => {
    const user = userEvent.setup();
    renderHome();

    const trigger = screen.getByRole("button", { name: "Why full address?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Why do you need the full address?" });
    expect(dialog).toHaveTextContent(
      "Your ballot depends on your voting districts, whose boundaries don’t follow ZIP codes"
    );
    expect(dialog).toHaveTextContent("Two homes in the same ZIP can vote in different races.");
    expect(dialog).toHaveTextContent("We don’t save it to your account");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const privacyPolicy = screen.getByRole("link", { name: "Read our Privacy Policy" });
    expect(privacyPolicy).toHaveAttribute("href", "/privacy");
    expect(privacyPolicy).toHaveAttribute("target", "_blank");

    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not open the dialog without an address", async () => {
    const user = userEvent.setup();
    renderHome();

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with an empty box, the action disabled, and every document named", async () => {
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Agree and search" })).toBeDisabled();
    for (const paragraph of PRE_SEARCH_AGREEMENT_PARAGRAPHS) {
      expect(screen.getByRole("dialog")).toHaveTextContent(paragraph);
    }
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
  });

  it("enables the action only once the box is ticked", async () => {
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("checkbox"));

    expect(screen.getByRole("button", { name: "Agree and search" })).toBeEnabled();
  });

  it("cancels without searching, without storing, and without losing the address", async () => {
    const fetchMock = stubResolveFetch();
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/address/resolve")).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    // Cancelling the terms is not a request to retype an address.
    expect(screen.getByLabelText(ADDRESS_LABEL)).toHaveValue("123 Main St, Austin, TX");
  });

  it("re-opens with an empty box after a cancel", async () => {
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("searches on agreement and sends the accepted version", async () => {
    const fetchMock = stubResolveFetch();
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Agree and search" }));

    await waitFor(() => {
      const resolveCall = fetchMock.mock.calls.find(([path]) => path === "/api/address/resolve");
      expect(resolveCall).toBeDefined();
      expect(JSON.parse((resolveCall as [string, { body: string }])[1].body)).toEqual({
        address: "123 Main St, Austin, TX",
        accepted_terms_version: TERMS_VERSION,
        allow_partial: true,
      });
    });
  });

  it("remembers the acceptance so the next search goes straight through", async () => {
    stubResolveFetch();
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Agree and search" }));

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    cleanup();
    renderHome();
    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks again once the stored acceptance expires", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: TERMS_VERSION, acceptedAt: Date.now() - NINETY_DAYS_MS - 1000 })
    );
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("asks again when the stored acceptance is for superseded terms", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: "0.9", acceptedAt: Date.now() })
    );
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("asks again when the stored acceptance is unreadable", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const user = userEvent.setup();
    renderHome();

    await typeAddress(user);
    await user.click(screen.getByRole("button", { name: "Search" }));

    // Fails closed: showing the terms once more costs a click, skipping them
    // wrongly costs the agreement.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("HomePage ZIP partial flow", () => {
  const PENDING_KEY = "voteapp_pending_district_ids";

  async function searchFor(user: ReturnType<typeof userEvent.setup>, input: string) {
    await user.type(screen.getByLabelText(ADDRESS_LABEL), input);
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Agree and search" }));
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: Date.now() }));
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
