import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { clearBallotDraft, setDraftBallotContext } from "../lib/ballotDraft";
import { getEmbedHome, resetEmbedSessionForTests } from "../lib/embedSession";
import { EmbedHomePage } from "./EmbedHomePage";

function renderHome() {
  return renderRoutes([{ path: "/embed", element: <EmbedHomePage /> }], "/embed");
}

beforeEach(() => {
  resetEmbedSessionForTests();
  clearBallotDraft();
  stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EmbedHomePage", () => {
  it("opens the box on the site's landing page without taking focus from the host page", async () => {
    renderHome();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "See who the candidates in your elections really are by their track records"
    );
    expect(screen.getByText("Factual, nonpartisan, AI-assisted research with linked sources")).toBeInTheDocument();
    const field = screen.getByLabelText("Enter address to see which elections you can vote in:");
    expect(field).not.toHaveFocus();
    // No big wordmark in a publisher's article: one small credit at the
    // bottom, which is also the way to the site, in a new tab.
    const credit = screen.getByRole("link", { name: "Elections Simplified" });
    expect(credit).toHaveAttribute("target", "_blank");
    expect(credit.closest("p")).toHaveTextContent("Powered by Elections Simplified");
    expect(screen.getAllByText("Elections Simplified")).toHaveLength(1);
    expect(getEmbedHome()).toEqual({ path: "/embed", label: "Search" });
    expect(screen.queryByRole("link", { name: "My elections" })).not.toBeInTheDocument();
  });

  it("stays the landing page for a returning reader: no extra links the site does not have", async () => {
    setDraftBallotContext(["dddddddd-1111-4111-8111-111111111111"], null);
    renderHome();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "My elections" })).not.toBeInTheDocument();
  });
});
