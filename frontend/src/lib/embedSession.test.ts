import { afterEach, describe, expect, it, vi } from "vitest";
import { guardEmbedClick, isInBoxPath, rememberEmbedSource, resetEmbedSessionForTests } from "./embedSession";

function clickOn(html: string) {
  document.body.innerHTML = html;
  const target = document.body.querySelector("[data-target]") ?? document.body.querySelector("a")!;
  const event = { target, defaultPrevented: false, preventDefault: vi.fn() };
  guardEmbedClick(event);
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("isInBoxPath", () => {
  it("keeps only the box's own pages in the frame", () => {
    expect(isInBoxPath("/embed")).toBe(true);
    expect(isInBoxPath("/embed/city/austin-tx")).toBe(false);
    expect(isInBoxPath("/candidates/c-1")).toBe(true);
    expect(isInBoxPath("/elections/e-1")).toBe(true);
    expect(isInBoxPath("/draft")).toBe(true);
    expect(isInBoxPath("/ballot")).toBe(true);
    expect(isInBoxPath("/")).toBe(false);
    expect(isInBoxPath("/register")).toBe(false);
    expect(isInBoxPath("/me/picks")).toBe(false);
    expect(isInBoxPath("/candidates/c-1/extra")).toBe(false);
  });
});

describe("guardEmbedClick", () => {
  it("leaves links to in-box pages to the router", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = clickOn('<a href="/candidates/c-1?src=alpha"><span data-target>Ada</span></a>');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens every other page of the site in a new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = clickOn('<a href="/register?next=%2Fdraft">Sign up</a>');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/register?next=%2Fdraft`, "_blank", "noopener");
  });

  it("opens external links in a new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    clickOn('<a href="https://example.gov/source">Source</a>');
    expect(open).toHaveBeenCalledWith("https://example.gov/source", "_blank", "noopener");
  });

  it("ignores links that already open a new tab, fragment links, and non-links", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(clickOn('<a href="/" target="_blank">Home</a>').preventDefault).not.toHaveBeenCalled();
    expect(clickOn('<a href="#main">Skip</a>').preventDefault).not.toHaveBeenCalled();
    expect(clickOn("<button data-target>Pick</button>").preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("rememberEmbedSource", () => {
  it("keeps the first publisher code when a later page has none", () => {
    resetEmbedSessionForTests();
    expect(rememberEmbedSource("alpha-news")).toBe("alpha-news");
    expect(rememberEmbedSource(null)).toBe("alpha-news");
  });
});
