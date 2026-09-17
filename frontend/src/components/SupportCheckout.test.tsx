import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SupportCheckout } from "./SupportCheckout";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { flushUsageEventsForTests, resetUsageForTests } from "../lib/usage";

vi.mock("../lib/externalNavigation", () => ({ navigateExternal: vi.fn() }));
import { navigateExternal } from "../lib/externalNavigation";

const NOT_MEMBER = { enabled: true, membership: null, total_net_cents: 0, payments: [] };

const ACTIVE_MEMBER = {
  enabled: true,
  membership: {
    stripe_status: "active",
    monthly_amount_cents: 500,
    cancel_at_period_end: false,
    current_period_end: "2026-09-15T12:00:00.000Z",
    started_at: "2026-08-15T12:00:00.000Z",
    pending_amount_change: null,
  },
  total_net_cents: 1500,
  payments: [
    { amount_cents: 500, refunded_amount_cents: 0, kind: "monthly", currency: "usd", paid_at: "2026-08-15T12:00:00.000Z" },
  ],
};

function renderCheckout(kind: "monthly" | "one_time", search = "") {
  const path = kind === "monthly" ? "/support/member" : "/support/once";
  return renderRoutes(
    [
      { path, element: <SupportCheckout kind={kind} /> },
      { path: "/terms", element: <p /> },
      { path: "/me/membership", element: <p /> },
    ],
    { pathname: path, search }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(navigateExternal).mockReset();
});

describe("SupportCheckout", () => {
  it("shows an unavailable notice instead of a dead form when Stripe is not configured", async () => {
    stubApiRoutes({ "/api/me/membership": { body: { enabled: false } } });
    renderCheckout("monthly");

    expect(await screen.findByText(/Payments are temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Become an honorary member" })).not.toBeInTheDocument();
  });

  it("shows the monthly form, the disclaimer, and the one-time cross-link to a non-member", async () => {
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("monthly");

    expect(await screen.findByLabelText(/Monthly amount/)).toHaveValue("10.00");
    expect(screen.getByText(/isn't a political contribution, isn't tax-deductible/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Become an honorary member" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Terms of Use" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Support once" })).toHaveAttribute("href", "/support/once");
    expect(screen.queryByLabelText(/One-time support/)).not.toBeInTheDocument();
  });

  it("shows the one-time form with the member cross-link", async () => {
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("one_time");

    expect(await screen.findByLabelText(/One-time support/)).toHaveValue("10.00");
    expect(screen.getByRole("button", { name: "Support once" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Support monthly" })).toHaveAttribute("href", "/support/member");
    expect(screen.queryByLabelText(/Monthly amount/)).not.toBeInTheDocument();
  });

  it("rejects amounts under the $5 minimum with a visible message", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("monthly");

    const input = await screen.findByLabelText(/Monthly amount/);
    await user.clear(input);
    await user.type(input, "4");

    expect(screen.getByText("The minimum is $5.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Become an honorary member" })).toBeDisabled();
    // No checkout call reaches the server for an invalid amount.
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost").pathname)).not.toContain(
      "/api/me/membership/checkout"
    );
  });

  it("rejects amounts over the $1,000 cap with a visible message", async () => {
    const user = userEvent.setup();
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("one_time");

    const input = await screen.findByLabelText(/One-time support/);
    await user.clear(input);
    await user.type(input, "1001");

    expect(screen.getByText("The maximum is $1,000 per payment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Support once" })).toBeDisabled();

    // The boundary itself is accepted.
    await user.clear(input);
    await user.type(input, "1000");
    expect(screen.getByRole("button", { name: "Support once" })).toBeEnabled();
  });

  it("accepts dollars and cents, and rejects a third decimal", async () => {
    const user = userEvent.setup();
    let checkoutBody: unknown = null;
    stubApiRoutes({
      "/api/me/membership": { body: NOT_MEMBER },
      "/api/me/membership/checkout": (_url, init) => {
        checkoutBody = JSON.parse(String(init?.body));
        return { body: { url: "https://checkout.stripe.com/c/pay/cs_test_456" } };
      },
    });
    renderCheckout("one_time");

    const input = await screen.findByLabelText(/One-time support/);
    await user.clear(input);
    await user.type(input, "7.505");
    expect(screen.getByText("Use at most two decimals, like 7.50.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Support once" })).toBeDisabled();

    // Leaving the field tidies a valid amount to two decimals; a pasted
    // "$1,000.00" style value is fine too.
    await user.clear(input);
    await user.type(input, "7.5");
    await user.tab();
    expect(input).toHaveValue("7.50");
    await user.clear(input);
    await user.type(input, "$1,000.00");
    expect(screen.getByRole("button", { name: "Support once" })).toBeEnabled();

    // A decimal comma is never read as a thousands separator (7,50 ≠ $750).
    await user.clear(input);
    await user.type(input, "7,50");
    expect(screen.getByText("Enter an amount like 7.50.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Support once" })).toBeDisabled();

    await user.clear(input);
    await user.type(input, "12.50");
    await user.click(screen.getByRole("button", { name: "Support once" }));
    await waitFor(() =>
      expect(navigateExternal).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_456")
    );
    expect(checkoutBody).toEqual({ kind: "one_time", amount_cents: 1250 });
  });

  it("fills the field from a preset chip and posts that amount", async () => {
    const user = userEvent.setup();
    let checkoutBody: unknown = null;
    stubApiRoutes({
      "/api/me/membership": { body: NOT_MEMBER },
      "/api/me/membership/checkout": (_url, init) => {
        checkoutBody = JSON.parse(String(init?.body));
        return { body: { url: "https://checkout.stripe.com/c/pay/cs_test_789" } };
      },
    });
    renderCheckout("one_time");

    const input = await screen.findByLabelText(/One-time support/);
    const presets = within(screen.getByRole("group", { name: "Suggested amounts" }));
    // The $10 prefill is already the pressed chip.
    expect(presets.getByRole("button", { name: "$10" })).toHaveAttribute("aria-pressed", "true");

    await user.click(presets.getByRole("button", { name: "$25" }));
    expect(input).toHaveValue("25.00");
    expect(presets.getByRole("button", { name: "$25" })).toHaveAttribute("aria-pressed", "true");
    expect(presets.getByRole("button", { name: "$10" })).toHaveAttribute("aria-pressed", "false");

    // Typing another amount releases the chip.
    await user.clear(input);
    await user.type(input, "30");
    expect(presets.getByRole("button", { name: "$25" })).toHaveAttribute("aria-pressed", "false");

    await user.click(presets.getByRole("button", { name: "$100" }));
    await user.click(screen.getByRole("button", { name: "Support once" }));
    await waitFor(() =>
      expect(navigateExternal).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_789")
    );
    expect(checkoutBody).toEqual({ kind: "one_time", amount_cents: 10_000 });
  });

  it("posts the amount in cents and redirects to the Checkout URL", async () => {
    const user = userEvent.setup();
    let checkoutBody: unknown = null;
    stubApiRoutes({
      "/api/me/membership": { body: NOT_MEMBER },
      "/api/me/membership/checkout": (_url, init) => {
        checkoutBody = JSON.parse(String(init?.body));
        return { body: { url: "https://checkout.stripe.com/c/pay/cs_test_123" } };
      },
    });
    renderCheckout("monthly");

    const input = await screen.findByLabelText(/Monthly amount/);
    await user.clear(input);
    await user.type(input, "12");
    await user.click(screen.getByRole("button", { name: "Become an honorary member" }));

    await waitFor(() =>
      expect(navigateExternal).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_123")
    );
    expect(checkoutBody).toEqual({ kind: "monthly", amount_cents: 1200 });
    // The button stays locked until the browser actually leaves the page.
    expect(screen.getByRole("button", { name: "Become an honorary member" })).toBeDisabled();
  });

  // Usage analytics (docs/plans/usage-analytics.md PR 3): the Checkout
  // request is counted by kind and outcome — never the amount.
  it("records checkout_start by kind without the amount", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    resetUsageForTests();
    sessionStorage.clear();
    const user = userEvent.setup();
    const fetchMock = stubApiRoutes({
      "/api/me/membership": { body: NOT_MEMBER },
      "/api/me/membership/checkout": apiError(409, "membership_exists", "You already have a monthly membership."),
      "/api/usage/events": { status: 204, body: null },
    });
    renderCheckout("monthly");
    const input = await screen.findByLabelText(/Monthly amount/);
    await user.clear(input);
    await user.type(input, "12");
    await user.click(screen.getByRole("button", { name: "Become an honorary member" }));
    await screen.findByText(/already have a monthly membership/);

    flushUsageEventsForTests();
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/api/usage/events"))).toBe(true));
    const usageCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/api/usage/events"))!;
    const { events } = JSON.parse((usageCall[1] as RequestInit).body as string) as {
      events: { name: string; props: Record<string, unknown> }[];
    };
    expect(events.filter((event) => event.name === "checkout_start").map((event) => event.props)).toEqual([
      { kind: "monthly", outcome: "error", error_category: "other" },
    ]);
    // Props only: the envelope carries random UUIDs, which can contain "1200".
    expect(JSON.stringify(events.map((event) => event.props))).not.toContain("1200");
    vi.unstubAllEnvs();
  });

  it("surfaces a checkout rejection (e.g. already a member) without redirecting", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      "/api/me/membership": { body: NOT_MEMBER },
      "/api/me/membership/checkout": apiError(409, "membership_exists", "You already have a monthly membership."),
    });
    renderCheckout("monthly");

    await user.click(await screen.findByRole("button", { name: "Become an honorary member" }));

    expect(await screen.findByText("You already have a monthly membership.")).toBeInTheDocument();
    expect(navigateExternal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Become an honorary member" })).toBeEnabled();
  });

  it("points an existing member at the membership page instead of the monthly form", async () => {
    stubApiRoutes({ "/api/me/membership": { body: ACTIVE_MEMBER } });
    renderCheckout("monthly");

    expect(await screen.findByText(/You're already an honorary member/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/me/membership");
    expect(screen.queryByRole("button", { name: "Become an honorary member" })).not.toBeInTheDocument();
    // History and the portal moved to the membership page.
    expect(screen.queryByText("Support history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage membership" })).not.toBeInTheDocument();
  });

  it("still offers the one-time form to a member", async () => {
    stubApiRoutes({ "/api/me/membership": { body: ACTIVE_MEMBER } });
    renderCheckout("one_time");

    expect(await screen.findByRole("button", { name: "Support once" })).toBeEnabled();
    expect(screen.queryByText(/already an honorary member/)).not.toBeInTheDocument();
  });

  it("shows an incomplete first payment as being set up, not as a member", async () => {
    stubApiRoutes({
      "/api/me/membership": {
        body: { ...ACTIVE_MEMBER, membership: { ...ACTIVE_MEMBER.membership, stripe_status: "incomplete" } },
      },
    });
    renderCheckout("monthly");

    expect(await screen.findByText("Your membership is being set up.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/me/membership");
    expect(screen.queryByText(/honorary member — thank you/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Become an honorary member" })).not.toBeInTheDocument();
  });

  it("welcomes a new member returning from Checkout, links Settings, and strips the query param", async () => {
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    const { router } = renderCheckout("monthly", "?membership=success");

    expect(await screen.findByText(/You're now an honorary member/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/me/settings");
    // Nothing competes with the welcome: no form, no "already a member" line.
    expect(screen.queryByRole("button", { name: "Become an honorary member" })).not.toBeInTheDocument();
    expect(screen.queryByText(/already an honorary member/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose your monthly amount/)).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(""));
    // The banner survives the param removal (read once into state).
    expect(screen.getByText(/Thank you for your support!/)).toBeInTheDocument();
  });

  it("thanks a one-time contributor without linking the membership page", async () => {
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("one_time", "?membership=success");

    expect(
      await screen.findByText(
        "Thank you for your support! Because of you, we can keep bringing you quality content and keep improving it."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "membership page" })).not.toBeInTheDocument();
  });

  it("keeps the one-time form locked after a successful Checkout until the webhook has landed", async () => {
    // The status endpoint can still say "not a member" for a moment after
    // the redirect back; a second click here would be a second charge.
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("one_time", "?membership=success");

    expect(await screen.findByText(/Thank you for your support!/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Support once" })).toBeDisabled();
  });

  it("notes a canceled Checkout without alarm", async () => {
    stubApiRoutes({ "/api/me/membership": { body: NOT_MEMBER } });
    renderCheckout("one_time", "?membership=canceled");

    expect(await screen.findByText("Checkout was canceled. Nothing was charged.")).toBeInTheDocument();
  });
});
