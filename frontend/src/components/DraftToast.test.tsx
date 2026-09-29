import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { DraftToast } from "./DraftToast";
import { clearBallotDraft, setDraftBallotContext, setDraftCandidateChoice } from "../lib/ballotDraft";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { renderRoutes } from "../test/render";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

// A stand-in for the header's My Draft link, placed where the test says.
function mountHeaderLink(rect: Partial<DOMRect> | null): HTMLElement {
  const link = document.createElement("a");
  link.setAttribute("data-draft-link", "");
  if (rect) {
    link.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}), ...rect }) as DOMRect;
  }
  document.body.appendChild(link);
  return link;
}

function renderToast() {
  return renderRoutes([{ path: "/", element: <DraftToast /> }, { path: "/draft", element: <p /> }], "/");
}

describe("DraftToast", () => {
  afterEach(() => {
    document.querySelectorAll("[data-draft-link]").forEach((el) => el.remove());
    vi.unstubAllGlobals();
    clearBallotDraft();
  });

  it("anchors under the header's draft link with a caret when the link is on screen", async () => {
    clearBallotDraft();
    setDraftBallotContext(["d-1"], null);
    setDraftCandidateChoice({
      electionId: "e-1", raceTitle: "Governor", electionDate: "2026-11-03", seatsToFill: null,
      candidateId: "c-1", candidateName: "Jordan Voter", chosen: true,
    });
    stubApiRoutes({ ...ANONYMOUS });
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    // Link spans x 860–980, y 20–40: on screen, 120px wide.
    mountHeaderLink({ left: 860, right: 980, width: 120, top: 20, bottom: 40, height: 20 });
    renderToast();

    const link = await screen.findByRole("link", { name: "My Draft (1)" });
    const pill = link.closest('[role="status"]') as HTMLElement;
    const strip = pill.parentElement as HTMLElement;
    // 6px under the link, right edge flush with the link's right edge.
    expect(strip.style.top).toBe("46px");
    expect(strip.style.paddingRight).toBe("20px");
    // Caret centered under the link: half its width, less half the caret.
    const caret = pill.querySelector("[data-draft-toast-caret]") as HTMLElement;
    expect(caret).not.toBeNull();
    expect(caret.style.right).toBe("54px");
  });

  it("takes the top-right corner without a caret when the header has scrolled away", async () => {
    clearBallotDraft();
    setDraftBallotContext(["d-1"], null);
    setDraftCandidateChoice({
      electionId: "e-1", raceTitle: "Governor", electionDate: "2026-11-03", seatsToFill: null,
      candidateId: "c-1", candidateName: "Jordan Voter", chosen: true,
    });
    stubApiRoutes({ ...ANONYMOUS });
    vi.stubGlobal("innerHeight", 800);
    // Scrolled past: the link's bottom edge is above the viewport.
    mountHeaderLink({ left: 860, right: 980, width: 120, top: -60, bottom: -40, height: 20 });
    renderToast();

    const link = await screen.findByRole("link", { name: "My Draft (1)" });
    const pill = link.closest('[role="status"]') as HTMLElement;
    const strip = pill.parentElement as HTMLElement;
    expect(strip).toHaveClass("top-3");
    expect(strip.style.top).toBe("");
    expect(pill.querySelector("[data-draft-toast-caret]")).toBeNull();
  });
});
