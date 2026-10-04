import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomePage } from "./WelcomePage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ME_UNVERIFIED, ME_VERIFIED } from "../test/fixtures";
import { hasSeenWelcome } from "../lib/welcomeSeen";

const CATALOG = {
  research_areas: [
    { id: "a-env", slug: "environment", name: "Environment", description: "Climate, energy, land use." },
    { id: "a-housing", slug: "housing", name: "Housing", description: null },
  ],
};

function renderWelcome(search = "") {
  return renderRoutes(
    [
      { path: "/me/welcome", element: <WelcomePage /> },
      { path: "/login", element: <p>Login placeholder</p> },
      { path: "/me/ballot", element: <p>Saved ballot placeholder</p> },
      { path: "/candidates/:candidateId", element: <p>candidate page</p> },
    ],
    `/me/welcome${search}`
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("WelcomePage", () => {
  it("redirects logged-out visitors to login", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderWelcome();
    expect(await screen.findByText("Login placeholder")).toBeInTheDocument();
  });

  it("redirects unverified users to the saved ballot", async () => {
    stubApiRoutes({ "/api/me": { body: ME_UNVERIFIED } });
    renderWelcome();
    expect(await screen.findByText("Saved ballot placeholder")).toBeInTheDocument();
  });

  it("picks issues on step 1, ranks them on step 2, then saves one PUT and continues to the ballot", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/research-areas": { body: CATALOG },
      "/api/me/research-area-preferences": (_url, init) => {
        expect(init?.method).toBe("PUT");
        return { body: { preferences: [] } };
      },
    });
    const { router } = renderWelcome();

    // Step 1 is pick-only: no ranked list, and Next waits for a first pick.
    const nextButton = await screen.findByRole("button", { name: "Next" });
    expect(nextButton).toBeDisabled();
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
    expect(screen.queryByText("My priorities")).not.toBeInTheDocument();

    // Descriptions sit behind a tap-to-open ⓘ toggle, not a title tooltip.
    expect(screen.queryByText("Climate, energy, land use.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "About Environment" }));
    expect(screen.getByText("Climate, energy, land use.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Housing" }));
    await user.click(screen.getByRole("button", { name: "Environment" }));
    // Picked cards show a check, not a rank: order is step 2's job.
    expect(screen.getByRole("button", { name: "Housing, selected. Click to remove." })).toBeInTheDocument();
    expect(screen.queryByText("#1")).not.toBeInTheDocument();

    // Enter on the focused Next button: React reuses that DOM node as "Save
    // and continue", so focus must move to the new step's heading or a
    // keyboard user tabs straight past the ranking rows.
    nextButton.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Step 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Put my issues in order" })).toHaveFocus();
    // Step 2 is rank-only: the rows carry tap order as the starting rank.
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "About Environment" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();

    // Back returns to the pool with the picks intact.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Welcome, Sam!" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Environment, selected. Click to remove." })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Saved ballot placeholder")).toBeInTheDocument();

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      preferences: [
        { research_area_id: "a-housing", rank: 1, direction: "support", hard_veto: false },
        { research_area_id: "a-env", rank: 2, direction: "support", hard_veto: false },
      ],
    });
    // Saving completes the step: a later login must not reopen it even if
    // the preferences are cleared afterwards.
    expect(hasSeenWelcome(ME_VERIFIED.user.id)).toBe(true);
    // The transient step replaces itself in history — Back from the ballot
    // must not land on a blank welcome screen.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("shows a retry instead of loading forever when /api/me fails", async () => {
    const user = userEvent.setup();
    let meCalls = 0;
    stubApiRoutes({
      "/api/me": () => {
        meCalls += 1;
        return meCalls === 1 ? apiError(500, "internal_error", "boom") : { body: ME_VERIFIED };
      },
      "/api/research-areas": { body: CATALOG },
    });
    renderWelcome();

    expect(await screen.findByText("We couldn't check your session. Please try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Welcome, Sam!" })).toBeInTheDocument();
  });

  it("skip remembers the choice and goes to the ballot without saving", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/research-areas": { body: CATALOG },
    });
    renderWelcome();

    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("Saved ballot placeholder")).toBeInTheDocument();
    expect(hasSeenWelcome(ME_VERIFIED.user.id)).toBe(true);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    });
  });

  it("continues to the next path the visitor signed in from, after save or skip", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/research-areas": { body: CATALOG },
      "/api/me/research-area-preferences": { body: { preferences: [] } },
    });
    const saved = renderWelcome("?next=/candidates/c-1");
    await user.click(await screen.findByRole("button", { name: "Housing" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("candidate page")).toBeInTheDocument();
    saved.unmount();

    renderWelcome("?next=/candidates/c-1");
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("candidate page")).toBeInTheDocument();
  });

  it("ignores an external next instead of open-redirecting", async () => {
    const user = userEvent.setup();
    stubApiRoutes({
      "/api/me": { body: ME_VERIFIED },
      "/api/research-areas": { body: CATALOG },
    });
    renderWelcome(`?next=${encodeURIComponent("//evil.example/phish")}`);

    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("Saved ballot placeholder")).toBeInTheDocument();
  });
});
