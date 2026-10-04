import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "./SettingsPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, ME_GOOGLE_NO_PASSWORD, ME_UNVERIFIED, ME_VERIFIED } from "../test/fixtures";

const EMAIL_PREFERENCES = {
  email_digest: true,
  email_election_reminders: false,
  email_new_election_alerts: true,
  email_issue_updates: true,
  email_member_newsletter: true,
};

function renderSettings(initialEntry = "/me/settings") {
  return renderRoutes(
    [
      { path: "/me/settings", element: <SettingsPage /> },
      { path: "/", element: <p>Home placeholder</p> },
      { path: "/login", element: <p /> },
      { path: "/me/ballot", element: <p>Saved ballot placeholder</p> },
    ],
    initialEntry
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // @ts-expect-error test-installed stub, absent in stock jsdom
  delete window.HTMLElement.prototype.scrollIntoView;
});

describe("SettingsPage", () => {
  it("asks logged-out visitors to log in", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderSettings();
    expect(await screen.findByText("Log in to manage your account.")).toBeInTheDocument();
  });

  it("hides notification sections until the email is verified", async () => {
    stubApiRoutes({ "/api/me": { body: ME_UNVERIFIED } });
    renderSettings();

    expect(
      await screen.findByText("Verify your email to manage your address and notifications.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Email notifications")).not.toBeInTheDocument();
    // Account basics still work unverified (fixing a typo must not need a
    // verified inbox).
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders the issue editor for verified users — back from its stint on My Picks", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Email notifications" })).toBeInTheDocument();
    expect(screen.getByText("My most important issues")).toBeInTheDocument();
  });

  it("scrolls to the issue editor when the link carries its hash", async () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings("/me/settings#my-issues");

    const heading = await screen.findByRole("heading", { name: "My most important issues" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    // Every call targets the editor's own section, heading at the top.
    const section = heading.closest("section");
    expect(section).toHaveAttribute("id", "my-issues");
    expect(scrollIntoView.mock.instances.every((instance) => instance === section)).toBe(true);
  });

  it("stays at the top of Settings without the hash", async () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Email notifications" })).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("carries no support box of its own — membership management lives on /me/membership", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: true, membership: null, total_net_cents: 0, payments: [] } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    // Non-member: the Profile box invites, pointing at the member page.
    expect(await screen.findByRole("link", { name: "Become an honorary member" })).toHaveAttribute("href", "/support/member");
    expect(screen.queryByRole("heading", { name: "Support Elections Simplified" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Support monthly" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Thank you for being a supporting member/)).not.toBeInTheDocument();
    // No payments, so no history to link.
    expect(screen.queryByText("Support history")).not.toBeInTheDocument();
  });

  it("links a lapsed supporter to their payment history next to the invitation", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": {
        body: {
          enabled: true,
          membership: null,
          total_net_cents: 500,
          payments: [
            { amount_cents: 500, refunded_amount_cents: 0, kind: "one_time", currency: "usd", paid_at: "2026-07-01T12:00:00.000Z" },
          ],
        },
      },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    // History folds open in place — no trip to the membership page, no total.
    const details = (await screen.findByText("Support history")).closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText(/July 1, 2026 · One-time/)).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("$5.00")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Support history" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Total support to date/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Become an honorary member" })).toHaveAttribute("href", "/support/member");
  });

  it("stays quiet when Stripe is not configured", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    const { queryClient } = renderSettings();

    expect(await screen.findByRole("heading", { name: "Email notifications" })).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(["me", "membership"])?.status).toBe("success"));
    expect(screen.queryByRole("link", { name: "Become an honorary member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage membership" })).not.toBeInTheDocument();
  });

  it("thanks a member in the Profile box and links to the membership page", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": {
        body: {
          enabled: true,
          membership: {
            stripe_status: "active",
            monthly_amount_cents: 500,
            cancel_at_period_end: false,
            current_period_end: "2026-09-15T12:00:00.000Z",
            started_at: "2026-08-15T12:00:00.000Z",
            pending_amount_change: null,
          },
          total_net_cents: 500,
          payments: [],
        },
      },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByText(/Thank you for being a supporting member/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/me/membership");
    expect(screen.queryByRole("link", { name: "Become an honorary member" })).not.toBeInTheDocument();
  });

  it.each([
    ["incomplete", "Your membership is being set up.", "Manage membership"],
    ["past_due", "Your last membership payment didn't go through.", "Fix payment"],
    ["unpaid", "Your last membership payment didn't go through.", "Fix payment"],
  ])("names a %s subscription in the Profile box and links to the membership page", async (state, text, label) => {
    // Neither thanks nor invites (checkout would 409); the page behind the
    // link carries the detail.
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": {
        body: {
          enabled: true,
          membership: {
            stripe_status: state,
            monthly_amount_cents: 500,
            cancel_at_period_end: false,
            current_period_end: null,
            started_at: "2026-08-15T12:00:00.000Z",
            pending_amount_change: null,
          },
          total_net_cents: 0,
          payments: [],
        },
      },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", "/me/membership");
    expect(screen.queryByText(/Thank you for being a supporting member/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Become an honorary member" })).not.toBeInTheDocument();
  });

  it("swaps the password and email forms for the add-a-password hint on Google-only accounts", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_GOOGLE_NO_PASSWORD },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Add a password" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a password" })).toHaveAttribute("href", "/forgot-password");
    // The two password-gated forms are replaced, not left to fail.
    expect(screen.queryByRole("heading", { name: "Change password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Change email" })).not.toBeInTheDocument();
    // Deletion stays available: it confirms with Google instead of a password.
    expect(screen.getByRole("heading", { name: "Delete account" })).toBeInTheDocument();
    // Sign Out moved to the header account menu — not on this page anymore.
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("deletes a Google-only account once Google confirms it, with no password field", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    const initialize = vi.fn();
    vi.stubGlobal("google", { accounts: { id: { initialize, renderButton: vi.fn() } } });
    const user = userEvent.setup();
    const fetchMock = stubApiRoutes({
      "/api/me": (_url, init) =>
        init?.method === "DELETE" ? { body: { status: "ok" } } : { body: ME_GOOGLE_NO_PASSWORD },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Delete my account…" }));
    expect(screen.getByText("Confirm with Google to permanently delete")).toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm with your password")).not.toBeInTheDocument();
    await waitFor(() => expect(initialize).toHaveBeenCalled());

    // Nothing is deleted until Google hands back a credential.
    const isDelete = ([, init]: [unknown, RequestInit?]) => init?.method === "DELETE";
    expect(fetchMock.mock.calls.some(isDelete)).toBe(false);
    const config = initialize.mock.calls.at(-1)?.[0] as { callback: (response: { credential?: string }) => void };
    config.callback({ credential: "google-jwt" });

    await waitFor(() => expect(fetchMock.mock.calls.some(isDelete)).toBe(true));
    const deleteCall = fetchMock.mock.calls.find(isDelete);
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ google_credential: "google-jwt" });
    expect(await screen.findByText("Home placeholder")).toBeInTheDocument();
  });

  it("points a Google-only account at the password route when Google cannot load", async () => {
    vi.stubEnv("VITE_GOOGLE_OAUTH_CLIENT_ID", "");
    const user = userEvent.setup();
    stubApiRoutes({
      "/api/me": { body: ME_GOOGLE_NO_PASSWORD },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Delete my account…" }));
    expect(
      screen.getByText("Google sign-in could not load. Add a password above, then delete your account with it.")
    ).toBeInTheDocument();
  });

  it("keeps the password-gated sections for accounts with a password", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Change password" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Change email" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delete account" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
  });

  it("confirms a saved first name, then clears the confirmation", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
    });
    renderSettings();

    const input = await screen.findByLabelText("First Name");
    await user.clear(input);
    await user.type(input, "Alex");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Confirmation is a live region so screen readers announce the save.
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Saved");

    // ...and it clears itself, so a stale "Saved" never sits beside a
    // later, unsaved edit.
    await waitFor(() => expect(status).toHaveTextContent(""), { timeout: 4000 });
  });

  it("saves a new home address and redirects to the saved ballot", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
      "/api/address/autocomplete": { body: { suggestions: [] } },
      "/api/me/address": {
        body: { ...ballotSummary([]), matched_address: "123 MAIN ST, AUSTIN, TX", address_match_count: 1 },
      },
    });
    renderSettings();

    await user.type(await screen.findByLabelText("New address"), "123 Main St, Austin, TX");
    await user.click(screen.getByRole("button", { name: "Save address" }));

    // A successful save lands on the election list; the confirmation itself
    // renders there (covered by the SavedBallotPage tests).
    expect(await screen.findByText("Saved ballot placeholder")).toBeInTheDocument();
  });

  it("sends the picked suggestion's coordinates with the address save", async () => {
    const user = userEvent.setup();
    const suggestion = {
      place_id: "place-herriman",
      description: "13822 S Scenic Canyon Cove, Herriman, UT 84096, USA",
      main_text: "13822 S Scenic Canyon Cove",
      secondary_text: "Herriman, UT 84096, USA",
    };
    const fetchMock = stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
      "/api/address/autocomplete": { body: { suggestions: [suggestion] } },
      "/api/address/autocomplete/retrieve": {
        body: {
          address: "13822 S Scenic Canyon Cove, Herriman, UT 84096, USA",
          location: { lat: 40.4886, lng: -111.9945 },
          granularity: "address",
          postal_code: "84096",
          state: "UT",
          locality: "Herriman",
        },
      },
      "/api/me/address": {
        body: { ...ballotSummary([]), matched_address: "13822 S SCENIC CANYON CV, HERRIMAN, UT", address_match_count: 1 },
      },
    });
    renderSettings();

    await user.type(await screen.findByLabelText("New address"), "13822 S Scenic");
    await user.click(await screen.findByRole("option", { name: /Scenic Canyon/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("New address")).toHaveValue(
        "13822 S Scenic Canyon Cove, Herriman, UT 84096, USA"
      );
    });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save address" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save address" }));

    expect(await screen.findByText("Saved ballot placeholder")).toBeInTheDocument();
    // The Census geocoder has no street range for a new subdivision; the
    // coordinates let the backend take the same coordinate-first path the
    // landing page search uses.
    const putCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/me/address"));
    const body = JSON.parse((putCall?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      address: "13822 S Scenic Canyon Cove, Herriman, UT 84096, USA",
      coordinates: { lat: 40.4886, lng: -111.9945 },
    });
  });

  it("shows all four email toggles with the saved values for verified users", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
      "/api/me/membership": { body: { enabled: false } },
      "/api/research-areas": { body: { research_areas: [] } },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    renderSettings();

    expect(await screen.findByLabelText(/Updates about my candidates and election results/)).toBeChecked();
    expect(screen.getByLabelText(/Election reminder the day before election day/)).not.toBeChecked();
    expect(screen.getByLabelText("Notify me about new elections coming up in my districts")).toBeChecked();
    expect(screen.getByLabelText(/Updates about the issues you saved/)).toBeChecked();
  });
});
