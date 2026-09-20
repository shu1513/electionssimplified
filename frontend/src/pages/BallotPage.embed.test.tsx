import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionSummary } from "../test/fixtures";

// The newsroom box: the app is framed, and the reader came from a city list.
vi.mock("../lib/embedSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/embedSession")>();
  return { ...actual, useEmbedSession: () => true };
});

import { getEmbedBallotPath, resetEmbedSessionForTests, setEmbedHome } from "../lib/embedSession";
import { clearBallotDraft, unpinDraftBallotContextForTests } from "../lib/ballotDraft";
import { BallotPage } from "./BallotPage";

const DISTRICT = "dddddddd-1111-4111-8111-111111111111";

beforeEach(() => {
  resetEmbedSessionForTests();
  clearBallotDraft();
  setEmbedHome({ path: "/embed/city/austin-tx", label: "Austin races" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  unpinDraftBallotContextForTests();
});

describe("BallotPage inside the newsroom box", () => {
  it("leads back to the city list, remembers the reader's ballot, and sends a new search to the box's own field", async () => {
    stubApiRoutes({
      "/api/me": apiError(401, "unauthorized", "Not logged in"),
      [`/api/ballot?district_ids=${DISTRICT}&sort=vote_power`]: { body: ballotSummary([electionSummary({ id: "e-1" })]) },
    });
    renderRoutes(
      [
        { path: "/ballot", element: <BallotPage /> },
        { path: "/embed/city/:slug", element: <p /> },
        { path: "/elections/:electionId", element: <p /> },
      ],
      `/ballot?d=${DISTRICT}&partial=1`
    );

    expect(await screen.findByRole("link", { name: "Back to Austin races" })).toHaveAttribute("href", "/embed/city/austin-tx");
    expect(screen.getByRole("link", { name: "Enter your street address" })).toHaveAttribute("href", "/embed/city/austin-tx");
    expect(getEmbedBallotPath()).toBe(`/ballot?d=${DISTRICT}&partial=1`);
  });
});
