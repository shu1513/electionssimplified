import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import MissionPage from "./MissionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ME_UNVERIFIED, ME_VERIFIED } from "../test/fixtures";

vi.mock("../data/embedPilotCities", () => {
  const pilot = { election_date: "2026-11-03", review_date: "2026-09-16", official_source_url: "https://example.org/", enabled: true, district_ids: [] };
  return {
    EMBED_PILOT_PUBLISHERS: [],
    EMBED_PILOT_CITIES: {
      tx: { ...pilot, slug: "tx", name: "Texas", state: "TX", kind: "state" },
      "los-angeles-ca": { ...pilot, slug: "los-angeles-ca", name: "Los Angeles", state: "CA", kind: "city" },
      "boise-id": { ...pilot, slug: "boise-id", name: "Boise", state: "ID", kind: "city", enabled: false },
    },
  };
});

const NOT_MEMBER = { enabled: true, membership: null, total_net_cents: 0, payments: [] };
const ACTIVE_MEMBER = {
  enabled: true,
  membership: {
    stripe_status: "active",
    monthly_amount_cents: 500,
    cancel_at_period_end: false,
    current_period_end: "2026-09-15T12:00:00.000Z",
    started_at: "2026-08-15T12:00:00.000Z",
  },
  total_net_cents: 500,
  payments: [],
};
const EMAIL_PREFERENCES = {
  email_digest: true,
  email_election_reminders: false,
  email_new_election_alerts: true,
  email_issue_updates: false,
  email_member_newsletter: true,
};

function renderMission() {
  return renderRoutes(
    [
      { path: "/mission", element: <MissionPage /> },
      { path: "/support/member", element: <p /> },
      { path: "/support/once", element: <p /> },
      { path: "/login", element: <p /> },
      { path: "/register", element: <p /> },
    ],
    "/mission"
  );
}

describe("MissionPage", () => {
  it("shows the pitch and the support buttons to logged-out readers, with no login line", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderMission();

    expect(await screen.findByRole("heading", { name: "Mission" })).toBeInTheDocument();
    // Payment moved to /support; the pitch buttons link there for everyone.
    expect(screen.getByRole("link", { name: "See how to become an honorary member" })).toHaveAttribute("href", "/support/member");
    expect(screen.getByRole("link", { name: "See how to contribute" })).toHaveAttribute(
      "href",
      "/support/once"
    );
    // The support pages handle auth gating, so the page carries no login line.
    expect(screen.queryByRole("link", { name: "Log in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "sign up" })).not.toBeInTheDocument();
    // No payment forms and no error box — the membership query must not fire
    // without a verified session.
    expect(screen.queryByRole("button", { name: "Support monthly" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the embed snippet for an enabled code and lists only the codes that render", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderMission();

    expect(
      await screen.findByRole("heading", { name: "For organizations and developers" })
    ).toBeInTheDocument();
    expect(
      screen.getByText('<script src="https://electionssimplified.com/embed.js" data-city="los-angeles-ca"></script>')
    ).toBeInTheDocument();
    // Enabled cities first, then states; the disabled entry is not advertised.
    expect(screen.getByText(/Codes available now/).closest("li")).toHaveTextContent(
      "Codes available now: los-angeles-ca, tx."
    );
    expect(screen.queryByText("boise-id")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact@electionssimplified.com" })).toHaveAttribute(
      "href",
      "mailto:contact@electionssimplified.com"
    );
    expect(screen.getByRole("link", { name: "embed guide" })).toHaveAttribute(
      "href",
      "https://github.com/shu1513/electionssimplified/blob/main/docs/newsroom-embed.md"
    );
  });

  it("asks unverified accounts to verify", async () => {
    stubApiRoutes({ "/api/me": { body: ME_UNVERIFIED } });
    renderMission();

    // The standard interstitial, with a real resend path.
    expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend verification email" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Support monthly" })).not.toBeInTheDocument();
  });

  it("shows the support buttons and the two email opt-ins to a verified non-member", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/membership": { body: NOT_MEMBER },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
    });
    const { queryClient } = renderMission();

    expect(await screen.findByRole("link", { name: "See how to become an honorary member" })).toHaveAttribute(
      "href",
      "/support/member"
    );
    // Way 3: only the two subscription toggles the pitch names, live values.
    expect(
      await screen.findByLabelText(/Updates about my candidates and election results/)
    ).toBeChecked();
    expect(screen.getByLabelText(/Updates about the issues you saved/)).not.toBeChecked();
    expect(
      screen.queryByLabelText(/Election reminder the day before election day/)
    ).not.toBeInTheDocument();
    // No inline payment forms anymore, and no member thanks for a non-member.
    await waitFor(() => expect(queryClient.getQueryState(["me", "membership"])?.status).toBe("success"));
    expect(screen.queryByRole("button", { name: "Support monthly" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage membership" })).not.toBeInTheDocument();
  });

  it("thanks an existing member and links to the membership page", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/membership": { body: ACTIVE_MEMBER },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
    });
    renderMission();

    expect(await screen.findByText("You are a supporting member. Thank you!")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/me/membership");
  });

  it("does not thank a member whose subscription is not active", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/membership": {
        body: { ...ACTIVE_MEMBER, membership: { ...ACTIVE_MEMBER.membership, stripe_status: "incomplete" } },
      },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
    });
    const { queryClient } = renderMission();

    await waitFor(() => expect(queryClient.getQueryState(["me", "membership"])?.status).toBe("success"));
    expect(screen.queryByText("You are a supporting member. Thank you!")).not.toBeInTheDocument();
  });

  it("keeps the pitch but no member widget when Stripe is not configured", async () => {
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/me/membership": { body: { enabled: false } },
      "/api/me/email-preferences": { body: EMAIL_PREFERENCES },
    });
    const { queryClient } = renderMission();

    expect(await screen.findByRole("heading", { name: "Mission" })).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(["me", "membership"])?.status).toBe("success"));
    expect(screen.queryByRole("link", { name: "Manage membership" })).not.toBeInTheDocument();
  });
});
