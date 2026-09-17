import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import MissionPage from "./MissionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";

// Uses the real generated manifest, which is empty until the first reviewed
// city is added: the page must not advertise a snippet that would 404.
describe("MissionPage with an empty embed manifest", () => {
  it("offers the embed without a snippet and asks readers to request a city", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderRoutes([{ path: "/mission", element: <MissionPage /> }], "/mission");

    expect(await screen.findByRole("heading", { name: "For organizations and developers" })).toBeInTheDocument();
    expect(screen.getByText(/the embed opens as soon as they are ready/)).toBeInTheDocument();
    expect(screen.queryByText(/embed\.js/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact@electionssimplified.com" })).toHaveAttribute(
      "href",
      "mailto:contact@electionssimplified.com"
    );
  });
});
