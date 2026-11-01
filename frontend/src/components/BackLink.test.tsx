import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router";
import { BackLink } from "./BackLink";
import { renderRoutes } from "../test/render";

// The Mission ↔ Methodology shape: a page links to another with a labeled
// back pointing at itself. The labeled control must POP back to it, not push
// a second copy (which, with the first page's own plain "← Back" popping,
// made the two pages bounce forever).
function renderPair(withFrom: boolean) {
  return renderRoutes(
    [
      {
        path: "/",
        element: (
          <Link to="/target" state={{ backTo: { path: "/", label: "Home" }, ...(withFrom ? { from: "/" } : {}) }}>
            Open target
          </Link>
        ),
      },
      {
        path: "/target",
        element: (
          <>
            <BackLink />
            <p>target</p>
          </>
        ),
      },
    ],
    "/"
  );
}

describe("BackLink", () => {
  it("pops history for a labeled back whose link came from the labeled page", async () => {
    const user = userEvent.setup();
    const { router } = renderPair(true);
    await user.click(screen.getByRole("link", { name: "Open target" }));
    await screen.findByText("target");
    const back = screen.getByRole("button", { name: "Back to Home" });
    await user.click(back);
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("POP");
  });

  it("keeps a labeled back as a link when the origin is not the labeled page", async () => {
    const user = userEvent.setup();
    renderPair(false);
    await user.click(screen.getByRole("link", { name: "Open target" }));
    await screen.findByText("target");
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  it("shows a plain Back that pops on an in-app arrival, and nothing on a cold load", async () => {
    const user = userEvent.setup();
    const { router } = renderRoutes(
      [
        { path: "/", element: <Link to="/target">Open target</Link> },
        {
          path: "/target",
          element: (
            <>
              <BackLink />
              <p>target</p>
            </>
          ),
        },
      ],
      "/"
    );
    await user.click(screen.getByRole("link", { name: "Open target" }));
    await screen.findByText("target");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/");

    renderRoutes([{ path: "/target", element: <BackLink /> }], "/target");
    expect(screen.queryByRole("navigation", { name: "Back" })).not.toBeInTheDocument();
  });
});
