import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { DraftToast } from "./DraftToast";
import { clearBallotDraft, setDraftBallotContext, setDraftCandidateChoice } from "../lib/ballotDraft";
import { DRAFT_TOAST_SEEN_KEY } from "../lib/draftToastSeen";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { renderRoutes } from "../test/render";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

// A stand-in for the header's My Draft link; `place` moves it, as a scroll
// would. Width 120, x 860–980 in a 1000px-wide viewport.
function mountHeaderLink(top: number): { place: (top: number) => void } {
  const link = document.createElement("a");
  link.setAttribute("data-draft-link", "");
  let y = top;
  link.getBoundingClientRect = () =>
    ({ x: 860, y, width: 120, height: 20, top: y, bottom: y + 20, left: 860, right: 980, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(link);
  return {
    place: (next) => {
      y = next;
    },
  };
}

function scroll() {
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

function pillParts() {
  const link = screen.getByRole("link", { name: "My Draft (1)" });
  const pill = link.closest('[role="status"]') as HTMLElement;
  return { pill, strip: pill.parentElement as HTMLElement, caret: pill.querySelector("[data-draft-toast-caret]") as HTMLElement | null };
}

function renderToast() {
  return renderRoutes([{ path: "/", element: <DraftToast /> }, { path: "/draft", element: <p /> }], "/");
}

describe("DraftToast", () => {
  beforeEach(() => {
    clearBallotDraft();
    setDraftBallotContext(["d-1"], null);
    setDraftCandidateChoice({
      electionId: "e-1", raceTitle: "Governor", electionDate: "2026-11-03", seatsToFill: null,
      candidateId: "c-1", candidateName: "Jordan Voter", chosen: true,
    });
    stubApiRoutes({ ...ANONYMOUS });
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    // Scroll handling is frame-throttled; run frames synchronously here.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    document.querySelectorAll("[data-draft-link]").forEach((el) => el.remove());
    vi.unstubAllGlobals();
    clearBallotDraft();
  });

  it("hangs under the header's draft link with a caret, and follows it as the page scrolls", async () => {
    const header = mountHeaderLink(20);
    renderToast();
    await screen.findByRole("link", { name: "My Draft (1)" });

    // 6px under the link (bottom 40), right edge flush with the link's
    // right edge (1000 - 980), caret centered under the link.
    let parts = pillParts();
    expect(parts.strip.style.top).toBe("46px");
    expect(parts.strip.style.paddingRight).toBe("20px");
    expect(parts.caret?.style.right).toBe("54px");

    header.place(10);
    scroll();
    parts = pillParts();
    expect(parts.strip.style.top).toBe("36px");
    expect(parts.caret).not.toBeNull();
  });

  it("parks at the top of the link's column, caret still up, once the header scrolls away", async () => {
    mountHeaderLink(-60);
    renderToast();
    await screen.findByRole("link", { name: "My Draft (1)" });

    const parts = pillParts();
    expect(parts.strip).toHaveClass("top-3");
    expect(parts.strip.style.top).toBe("");
    // Still the header link's column: the pill lines up with where the
    // counter is, not with the viewport edge — and the caret keeps
    // pointing up at it ("it's above you").
    expect(parts.strip.style.paddingRight).toBe("20px");
    expect(parts.caret?.style.right).toBe("54px");
  });

  it("dismisses itself when the header scrolls back into view over a parked pill", async () => {
    const header = mountHeaderLink(-60);
    renderToast();
    await screen.findByRole("link", { name: "My Draft (1)" });

    header.place(20);
    scroll();
    expect(screen.queryByRole("link", { name: "My Draft (1)" })).not.toBeInTheDocument();
  });

  it("detaches into the parked pill when the header scrolls away from under it", async () => {
    const header = mountHeaderLink(20);
    renderToast();
    await screen.findByRole("link", { name: "My Draft (1)" });
    expect(pillParts().caret).not.toBeNull();

    header.place(-60);
    scroll();
    const parts = pillParts();
    expect(parts.strip).toHaveClass("top-3");
    expect(parts.caret).not.toBeNull();
  });

  it("spends the once-per-browser showing only when it is actually on screen", async () => {
    window.localStorage.removeItem(DRAFT_TOAST_SEEN_KEY);
    // Split view: the caller's rail:hidden wrapper keeps the pill off
    // screen. jsdom has no checkVisibility, so stand one in.
    const checkVisibility = vi.fn(() => false);
    HTMLElement.prototype.checkVisibility = checkVisibility;
    try {
      const { unmount } = renderToast();
      await screen.findByRole("link", { name: "My Draft (1)" });
      expect(checkVisibility).toHaveBeenCalled();
      expect(window.localStorage.getItem(DRAFT_TOAST_SEEN_KEY)).toBeNull();
      unmount();

      checkVisibility.mockReturnValue(true);
      renderToast();
      await screen.findByRole("link", { name: "My Draft (1)" });
      expect(window.localStorage.getItem(DRAFT_TOAST_SEEN_KEY)).toBe("1");
    } finally {
      delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
      window.localStorage.removeItem(DRAFT_TOAST_SEEN_KEY);
    }
  });

  it("falls back to the page gutter when there is no header link at all", async () => {
    renderToast();
    await screen.findByRole("link", { name: "My Draft (1)" });
    const parts = pillParts();
    expect(parts.strip).toHaveClass("top-3");
    expect(parts.strip.style.paddingRight).toBe("16px");
    expect(parts.caret).not.toBeNull();
  });
});
