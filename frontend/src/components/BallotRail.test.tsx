import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { BallotRail } from "./BallotRail";
import { renderRoutes } from "../test/render";

// Structure and navigation behavior are exercised end-to-end by the page
// tests (ElectionPage "ballot rail" and CandidatePage "roster rail"
// describes); this file covers only what those can't see: the
// scroll-into-view of the current box or row. jsdom elements have no
// scrollIntoView (the component guards for exactly that — every page test
// proves the guard), so supporting it is opt-in via the prototype.
describe("BallotRail", () => {
  afterEach(() => {
    // @ts-expect-error test-installed stub, absent in stock jsdom
    delete window.HTMLElement.prototype.scrollIntoView;
  });

  const CONTESTS = [
    { id: "e-1", label: "Governor", path: "/elections/e-1" },
    { id: "e-2", label: "Mayor", path: "/elections/e-2" },
  ];
  const ROWS = [
    { id: "c-1", label: "Jordan Voter", path: "/candidates/c-1", picked: false },
    { id: "c-2", label: "Riley Runner", path: "/candidates/c-2", picked: true },
  ];

  it("scrolls the current box into view when the browser supports it", () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderRoutes([
      {
        path: "/",
        element: (
          <BallotRail
            ariaLabel="Ballot"
            contests={CONTESTS}
            currentId="e-2"
            rows={ROWS}
            backTo={{ path: "/ballot", label: "All elections" }}
          />
        ),
      },
    ]);

    const rail = screen.getByRole("navigation", { name: "Ballot" });
    const box = within(rail).getByText("Mayor").closest("li")!;
    expect(box).toHaveAttribute("aria-current", "page");
    // Called on the current box, minimally ("nearest" scrolls the rail's
    // own container, not the page, when the box is off-screen).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances).toEqual([box]);
  });

  it("scrolls the current row into view on a candidate page, its race title linked", () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderRoutes([
      {
        path: "/",
        element: (
          <BallotRail
            ariaLabel="Ballot"
            contests={CONTESTS}
            currentId="e-2"
            currentRowId="c-2"
            rows={ROWS}
            backTo={{ path: "/ballot", label: "All elections" }}
          />
        ),
      },
    ]);

    const rail = screen.getByRole("navigation", { name: "Ballot" });
    const row = within(rail).getByText("Riley Runner").closest("li")!;
    expect(row).toHaveAttribute("aria-current", "page");
    expect(row).toHaveTextContent("(my pick)");
    expect(within(rail).getByRole("link", { name: "Mayor" })).toHaveAttribute("href", "/elections/e-2");
    expect(within(rail).getByRole("link", { name: "Mayor" }).closest("li")).not.toHaveAttribute("aria-current");
    expect(scrollIntoView.mock.instances).toEqual([row]);
  });
});
