import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import MissionPage from "./MissionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";

// An empty manifest (nothing reviewed yet): the page must not advertise a
// snippet that would 404.
vi.mock("../data/embedPilotCities", () => ({ EMBED_PILOT_PUBLISHERS: [], EMBED_PILOT_CITIES: {} }));

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
