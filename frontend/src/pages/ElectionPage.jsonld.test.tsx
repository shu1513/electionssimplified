import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ElectionPage, ErrorBoundary } from "./ElectionPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { electionDetail } from "../test/fixtures";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

afterEach(() => {
  vi.unstubAllGlobals();
});

// The Event markup a search engine reads off an election page. Google's
// validator accepts only Place (with a postal address) or VirtualLocation
// as the location, so a regression to a bare AdministrativeArea would be
// silent on screen and only show up as a Search Console warning.
describe("ElectionPage structured data", () => {
  it("describes the race as an Event at a Place in its state", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        {
          path: "/elections/:electionId",
          element: <ElectionPage />,
          errorElement: <ErrorBoundary />,
          hydrateFallbackElement: <p />,
          loader: () =>
            electionDetail({
              official_ballot_title: "Governor",
              election_date: "2026-11-03",
              district: { id: "d-1", district_type: "us_house", name: "Congressional District 1 (119th Congress), Alaska", state: "AK" },
            }),
        },
        { path: "/districts/:districtId", element: <p /> },
      ],
      "/elections/e-1"
    );

    expect(await screen.findByRole("heading", { name: "Governor" })).toBeInTheDocument();
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const event = JSON.parse(script!.textContent ?? "{}");
    expect(event).toMatchObject({
      "@type": "Event",
      name: "Governor",
      startDate: "2026-11-03",
      location: {
        "@type": "Place",
        // Vintage stripped, same as the visible district line.
        name: "Congressional District 1, Alaska",
        address: { "@type": "PostalAddress", addressRegion: "AK", addressCountry: "US" },
      },
    });
    // The visible district line links the district page and drops the vintage too.
    expect(screen.getByRole("link", { name: "Congressional District 1, Alaska" })).toHaveAttribute("href", "/districts/d-1");
  });
});
