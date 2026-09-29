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

  // The FAQPage block repeats the question headings with the text under
  // them, so an engine can lift "Who is running?" and its answer as a pair.
  it("adds FAQPage markup whose questions are the page's own headings", async () => {
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
              office: { id: "o-1", scope: "state", canonical_name: "Governor", summary: "Signs or vetoes bills.\nAppoints agency heads." },
            }),
        },
        { path: "/districts/:districtId", element: <p /> },
      ],
      "/elections/e-1"
    );

    expect(await screen.findByRole("heading", { name: "Who is running?" })).toBeInTheDocument();
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) =>
      JSON.parse(script.textContent ?? "{}")
    );
    const faq = scripts.find((node) => node["@type"] === "FAQPage");
    expect(faq).toMatchObject({
      "@id": "https://electionssimplified.com/elections/e-1#faq",
      mainEntity: [
        {
          "@type": "Question",
          name: "Who is running?",
          acceptedAnswer: { "@type": "Answer", text: "2 candidates are running: Jordan Voter (Independent) and Riley Runner (Independent). Riley Runner is the incumbent." },
        },
        {
          "@type": "Question",
          name: "What does this office do?",
          acceptedAnswer: { "@type": "Answer", text: "Signs or vetoes bills. Appoints agency heads." },
        },
      ],
    });
    // No result yet, so no "Who won?" entry — same as the page.
    expect(faq.mainEntity).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "What does this office do?" })).toBeInTheDocument();
  });
});
