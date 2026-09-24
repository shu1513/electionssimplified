import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { SiteStatsResponse } from "@voteapp/api-client";
import { StatsPage, ErrorBoundary, meta, statsAnswerText } from "./StatsPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

const STATS: SiteStatsResponse = {
  as_of: "2026-09-24",
  totals: {
    states: 2,
    districts: 14,
    upcoming_elections: 44,
    upcoming_contested: 28,
    upcoming_uncontested: 12,
    upcoming_measures: 4,
    upcoming_candidates: 70,
    upcoming_democratic: 30,
    upcoming_republican: 35,
    upcoming_other: 5,
    next_election_date: "2026-10-06",
    candidate_records: 12345,
  },
  states: [
    {
      state: "AK",
      name: "Alaska",
      districts: 2,
      upcoming_elections: 4,
      upcoming_contested: 3,
      upcoming_uncontested: 2,
      upcoming_measures: 1,
      upcoming_candidates: 0,
      upcoming_democratic: 0,
      upcoming_republican: 0,
      upcoming_other: 0,
      next_election_date: "2026-10-06",
    },
    {
      state: "KY",
      name: "Kentucky",
      districts: 12,
      upcoming_elections: 40,
      upcoming_contested: 25,
      upcoming_uncontested: 10,
      upcoming_measures: 3,
      upcoming_candidates: 70,
      upcoming_democratic: 30,
      upcoming_republican: 35,
      upcoming_other: 5,
      next_election_date: "2026-11-03",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StatsPage", () => {
  it("opens with the whole picture in sentences and tabulates every state with a link", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        { path: "/stats", element: <StatsPage />, errorElement: <ErrorBoundary />, hydrateFallbackElement: <p />, loader: () => STATS },
        { path: "/browse/:state", element: <p /> },
      ],
      "/stats"
    );

    expect(await screen.findByRole("heading", { name: "Election coverage statistics" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "As of September 24, 2026, Elections Simplified covers 44 upcoming elections in 14 districts across 2 states, including 4 ballot measures. " +
          "Of the 40 office races with a known candidate list, 12 (30%) are uncontested. " +
          "70 candidates are running: 30 Democrats, 35 Republicans, and 5 independents, minor-party, or nonpartisan candidates. " +
          "The site holds 12,345 sourced candidate records. The next election day on file is October 6, 2026."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kentucky" })).toHaveAttribute("href", "/browse/ky");
    expect(screen.getByRole("row", { name: /All states/ })).toHaveTextContent("44");

    const script = document.querySelector('script[type="application/ld+json"]');
    const dataset = JSON.parse(script!.textContent ?? "{}");
    expect(dataset).toMatchObject({
      "@type": "Dataset",
      dateModified: "2026-09-24",
      distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: "https://electionssimplified.com/api/stats" }],
    });
  });

  it("uses the answer paragraph as the search description", () => {
    const tags = meta({ data: STATS, params: {}, location: { pathname: "/stats" }, matches: [] } as never);
    expect(tags).toContainEqual({ name: "description", content: statsAnswerText(STATS) });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "https://electionssimplified.com/stats" });
  });
});
