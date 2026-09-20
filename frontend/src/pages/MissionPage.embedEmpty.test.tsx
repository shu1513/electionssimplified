import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import MissionPage from "./MissionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";

// An empty manifest (nothing reviewed yet): the page must not advertise a
// city code that would 404.
vi.mock("../data/embedPilotCities", () => ({ EMBED_PILOT_PUBLISHERS: [], EMBED_PILOT_CITIES: {} }));

describe("MissionPage with an empty embed manifest", () => {
  it("hands out the one-line snippet, which needs no city, and advertises no city codes", async () => {
    stubApiRoutes({ "/api/me": apiError(401, "unauthorized", "Not logged in") });
    renderRoutes([{ path: "/mission", element: <MissionPage /> }], "/mission");

    expect(await screen.findByRole("heading", { name: "For organizations and developers" })).toBeInTheDocument();
    expect(screen.getByText('<script src="https://electionssimplified.com/embed.js"></script>')).toBeInTheDocument();
    expect(screen.queryByText(/Codes available now/)).not.toBeInTheDocument();
    expect(screen.queryByText(/data-city/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact@electionssimplified.com" })).toHaveAttribute(
      "href",
      "mailto:contact@electionssimplified.com"
    );
  });
});
