import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { DetailRail } from "./DetailRail";
import { renderRoutes } from "../test/render";

// Structure and navigation behavior are exercised end-to-end by the page
// tests (ElectionPage "ballot rail" describe); this file covers only what
// those can't see: the scroll-into-view of the current row. jsdom elements
// have no scrollIntoView (the component guards for exactly that — every
// page test proves the guard), so supporting it is opt-in via the prototype.
describe("DetailRail", () => {
  afterEach(() => {
    // @ts-expect-error test-installed stub, absent in stock jsdom
    delete window.HTMLElement.prototype.scrollIntoView;
  });

  it("scrolls the current row into view when the browser supports it", () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderRoutes([
      {
        path: "/",
        element: (
          <DetailRail
            ariaLabel="Ballot"
            entries={[
              { id: "e-1", label: "Governor", path: "/elections/e-1" },
              { id: "e-2", label: "Mayor", path: "/elections/e-2" },
            ]}
            currentId="e-2"
            backTo={{ path: "/ballot", label: "All elections" }}
          />
        ),
      },
    ]);

    const rail = screen.getByRole("navigation", { name: "Ballot" });
    expect(within(rail).getByText("Mayor").closest("li")).toHaveAttribute("aria-current", "page");
    // Called on the current row, minimally ("nearest" scrolls the rail's own
    // container, not the page, when the row is off-screen).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances).toHaveLength(1);
  });
});
