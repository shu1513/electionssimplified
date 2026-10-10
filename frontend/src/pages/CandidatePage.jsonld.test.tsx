import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { CandidatePage, ErrorBoundary, meta } from "./CandidatePage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";
import { candidateDetail, candidateElection, DISTRICT } from "../test/fixtures";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

afterEach(() => {
  vi.unstubAllGlobals();
});

// The Person markup an engine reads off a profile: the identity links
// (sameAs) are what let it merge our page with the Ballotpedia/Wikipedia
// entity it already knows, and the party/description/date give it the
// facts without parsing the prose.
describe("CandidatePage structured data", () => {
  it("describes the candidate as a Person with party, summary, identity links, and a research date", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        {
          path: "/candidates/:candidateId",
          element: <CandidatePage />,
          errorElement: <ErrorBoundary />,
          hydrateFallbackElement: <p />,
          loader: () => ({
            ...candidateDetail({
              party: "Democratic",
              current_office: "State Senator",
              official_website_url: "https://jordan.example",
              twitter_handle: "jordanvoter",
              profile_sources: ["https://ballotpedia.org/Jordan_Voter", "https://example.gov/filing.pdf"],
              last_researched: "2026-06-01T00:00:00.000Z",
            }),
            ongoing_finance: {},
          }),
        },
        { path: "/elections/:electionId", element: <p /> },
      ],
      "/candidates/c-1"
    );

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const person = JSON.parse(script!.textContent ?? "{}");
    expect(person).toMatchObject({
      "@type": "Person",
      "@id": "https://electionssimplified.com/candidates/c-1#person",
      name: "Jordan Voter",
      jobTitle: "State Senator",
      url: "https://jordan.example",
      description: "A candidate summary.",
      affiliation: { "@type": "Organization", name: "Democratic" },
      dateModified: "2026-06-01T00:00:00.000Z",
      mainEntityOfPage: "https://electionssimplified.com/candidates/c-1",
      // The page node keeps the bare URL; the Person is a distinct node.
      subjectOf: { "@type": "WebPage", "@id": "https://electionssimplified.com/candidates/c-1" },
    });
    // The filing PDF is a source, not an identity, so it stays out of sameAs.
    expect(person.sameAs).toEqual(["https://jordan.example", "https://x.com/jordanvoter", "https://ballotpedia.org/Jordan_Voter"]);
  });

  // The page shows the plain summary; the stitched answer paragraph is only
  // the meta description's source and never renders.
  it("shows the plain summary and uses the answer paragraph as the meta description", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    const detail = {
      ...candidateDetail({
        party: "Democratic",
        current_office: "State Senator",
        elections: [candidateElection({ election_date: "2099-11-03", district: { ...DISTRICT, name: "Kentucky" } })],
      }),
      ongoing_finance: {},
    };
    renderRoutes(
      [
        {
          path: "/candidates/:candidateId",
          element: <CandidatePage />,
          errorElement: <ErrorBoundary />,
          hydrateFallbackElement: <p />,
          loader: () => detail,
        },
        { path: "/elections/:electionId", element: <p /> },
      ],
      "/candidates/c-1"
    );

    expect(await screen.findByRole("heading", { name: "Jordan Voter" })).toBeInTheDocument();
    expect(screen.getByText("A candidate summary.")).toBeInTheDocument();
    expect(screen.queryByText(/is running for Governor in Kentucky/)).not.toBeInTheDocument();
    // The route's meta export (the test router renders no <Meta/>): the
    // description is the paragraph's opening sentences, cut at a sentence end.
    const tags = meta({ data: detail, location: { pathname: "/candidates/c-1" } } as unknown as Parameters<typeof meta>[0]);
    expect(tags).toContainEqual({
      name: "description",
      content:
        "Jordan Voter (Democratic) is running for Governor in Kentucky in the November 3, 2099 election. Jordan Voter currently serves as State Senator. A candidate summary.",
    });
  });
});
