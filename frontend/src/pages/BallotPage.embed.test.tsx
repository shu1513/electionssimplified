import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { ballotSummary, electionSummary } from "../test/fixtures";

// The newsroom box: the app is framed, and the reader came from its front page.
vi.mock("../lib/embedSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/embedSession")>();
  return { ...actual, useEmbedSession: () => true };
});

import { resetEmbedSessionForTests, setEmbedHome } from "../lib/embedSession";
import { clearBallotDraft, readBallotDraft } from "../lib/ballotDraft";
import { BallotPage } from "./BallotPage";

const DISTRICT = "dddddddd-1111-4111-8111-111111111111";

beforeEach(() => {
  resetEmbedSessionForTests();
  clearBallotDraft();
  setEmbedHome({ path: "/embed", label: "Search" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BallotPage inside the newsroom box", () => {
  it("leads back to the box's search page, keeps the reader's ballot, and sends a new search there too", async () => {
    stubApiRoutes({
      "/api/me": apiError(401, "unauthorized", "Not logged in"),
      "/api/ballot": { body: ballotSummary([electionSummary({ id: "e-1" })]) },
    });
    renderRoutes(
      [
        { path: "/ballot", element: <BallotPage /> },
        { path: "/embed", element: <p /> },
        { path: "/elections/:electionId", element: <p /> },
      ],
      `/ballot?d=${DISTRICT}&partial=1`
    );

    expect(await screen.findByRole("link", { name: "Back to Search" })).toHaveAttribute("href", "/embed");
    expect(screen.getByRole("link", { name: "Enter your street address" })).toHaveAttribute("href", "/embed");
    await waitFor(() => expect(readBallotDraft().district_ids).toEqual([DISTRICT]));
  });
});
