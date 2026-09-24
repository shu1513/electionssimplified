import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { BrowseDistrictResponse, BrowseStateResponse, BrowseStatesResponse } from "@voteapp/api-client";
import { BrowseStatesPage, meta as statesMeta } from "./BrowseStatesPage";
import { BrowseStatePage, ErrorBoundary as StateErrorBoundary, groupDistrictsByLevel, meta as stateMeta } from "./BrowseStatePage";
import { DistrictPage, ErrorBoundary as DistrictErrorBoundary, meta as districtMeta } from "./DistrictPage";
import { renderRoutes } from "../test/render";
import { apiError, stubApiRoutes } from "../test/mockApi";

const ANONYMOUS = { "/api/me": apiError(401, "unauthorized", "Not logged in") };

const STATES: BrowseStatesResponse = {
  states: [
    { state: "AK", name: "Alaska", district_count: 3, upcoming_election_count: 7 },
    { state: "KY", name: "Kentucky", district_count: 40, upcoming_election_count: 1234 },
  ],
};

const KENTUCKY: BrowseStateResponse = {
  state: "KY",
  name: "Kentucky",
  districts: [
    { id: "d-place", name: "Franklin city, Kentucky", district_type: "place", election_count: 1, upcoming_election_count: 0, next_election_date: null },
    { id: "d-county", name: "Simpson County, Kentucky", district_type: "county", election_count: 3, upcoming_election_count: 2, next_election_date: "2026-11-03" },
    { id: "d-state", name: "Kentucky", district_type: "statewide", election_count: 2, upcoming_election_count: 1, next_election_date: "2026-11-03" },
    { id: "d-house", name: "House District 12 (2024); Kentucky", district_type: "state_lower", election_count: 1, upcoming_election_count: 1, next_election_date: "2026-11-03" },
  ],
};

const SIMPSON: BrowseDistrictResponse = {
  district: { id: "d-county", name: "Simpson County, Kentucky", district_type: "county", state: "KY", state_name: "Kentucky" },
  elections: [
    {
      id: "e-upcoming",
      official_ballot_title: "County Judge/Executive",
      election_date: "2099-11-03",
      election_stage: "general",
      race_type: "office",
      candidates: [
        { candidate_id: "c-1", display_name: "Jordan Voter", party: "Republican", status: "declared" },
        { candidate_id: "c-2", display_name: "Pat Quit", party: "Democratic", status: "withdrawn" },
      ],
    },
    {
      id: "e-past",
      official_ballot_title: "Constable West District",
      election_date: "2022-11-08",
      election_stage: "general",
      race_type: "office",
      candidates: [],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const metaArgs = (data: unknown, pathname: string) =>
  ({ data, error: undefined, location: { pathname }, params: {}, matches: [] }) as never;

function titleOf(descriptors: Record<string, unknown>[]): unknown {
  return descriptors.find((entry) => typeof entry.title === "string")?.title;
}

describe("BrowseStatesPage", () => {
  it("links every state to its district list", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        { path: "/browse", element: <BrowseStatesPage />, hydrateFallbackElement: <p />, loader: () => STATES },
        { path: "/browse/:state", element: <p /> },
      ],
      "/browse"
    );

    expect(await screen.findByRole("heading", { name: "Browse elections by state" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kentucky" })).toHaveAttribute("href", "/browse/ky");
    expect(screen.getByText("1,234 upcoming")).toBeInTheDocument();
    expect(titleOf(statesMeta(metaArgs(STATES, "/browse")) as Record<string, unknown>[])).toBe(
      "Browse elections by state · Elections Simplified"
    );
  });
});

describe("BrowseStatePage", () => {
  it("groups districts by level, statewide first, and links each to its page", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        { path: "/browse/:state", element: <BrowseStatePage />, hydrateFallbackElement: <p />, loader: () => KENTUCKY },
        { path: "/districts/:districtId", element: <p /> },
        { path: "/browse", element: <p /> },
      ],
      "/browse/ky"
    );

    expect(await screen.findByRole("heading", { name: "Kentucky elections" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Statewide (1)", "State house district (1)", "County (1)", "City (1)"]);
    expect(screen.getByRole("link", { name: "Simpson County, Kentucky" })).toHaveAttribute("href", "/districts/d-county");
    // The boundary vintage is provenance, not identity (formatDistrictName).
    expect(screen.getByRole("link", { name: "House District 12; Kentucky" })).toBeInTheDocument();
    expect(screen.getByText("2 upcoming · next November 3, 2026")).toBeInTheDocument();
    expect(screen.getByText("1 past")).toBeInTheDocument();
    // Breadcrumb back up to the state list.
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/browse");
    expect(titleOf(stateMeta(metaArgs(KENTUCKY, "/browse/ky")) as Record<string, unknown>[])).toBe(
      "Kentucky elections by district · Elections Simplified"
    );
  });

  it("orders unknown levels last", () => {
    const groups = groupDistrictsByLevel([
      { id: "a", name: "A", district_type: "zzz_new", election_count: 1, upcoming_election_count: 0, next_election_date: null },
      { id: "b", name: "B", district_type: "county", election_count: 1, upcoming_election_count: 0, next_election_date: null },
    ]);
    expect(groups.map(([type]) => type)).toEqual(["county", "zzz_new"]);
  });

  it("renders not-found UI when the loader throws a 404", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        {
          path: "/browse/:state",
          element: <BrowseStatePage />,
          errorElement: <StateErrorBoundary />,
          hydrateFallbackElement: <p />,
          loader: () => {
            throw new Response("Not Found", { status: 404 });
          },
        },
      ],
      "/browse/pr"
    );
    expect(await screen.findByText("State not found")).toBeInTheDocument();
  });
});

describe("DistrictPage", () => {
  it("splits races into upcoming and past and links every race and candidate", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        { path: "/districts/:districtId", element: <DistrictPage />, hydrateFallbackElement: <p />, loader: () => SIMPSON },
        { path: "/elections/:electionId", element: <p /> },
        { path: "/candidates/:candidateId", element: <p /> },
        { path: "/browse/:state", element: <p /> },
        { path: "/browse", element: <p /> },
      ],
      "/districts/d-county"
    );

    expect(await screen.findByRole("heading", { name: "Simpson County, Kentucky" })).toBeInTheDocument();
    const upcoming = screen.getByRole("heading", { name: "Upcoming elections" }).parentElement!;
    expect(within(upcoming).getByRole("link", { name: "County Judge/Executive" })).toHaveAttribute("href", "/elections/e-upcoming");
    expect(within(upcoming).getByRole("link", { name: "Jordan Voter" })).toHaveAttribute("href", "/candidates/c-1");
    expect(within(upcoming).getByText("— withdrawn")).toBeInTheDocument();
    const past = screen.getByRole("heading", { name: "Past elections" }).parentElement!;
    expect(within(past).getByRole("link", { name: "Constable West District" })).toHaveAttribute("href", "/elections/e-past");
    // Breadcrumb up to the state.
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Kentucky" })).toHaveAttribute("href", "/browse/ky");
    expect(titleOf(districtMeta(metaArgs(SIMPSON, "/districts/d-county")) as Record<string, unknown>[])).toBe(
      "Simpson County, Kentucky elections · Elections Simplified"
    );
  });

  it("renders not-found UI when the loader throws a 404", async () => {
    stubApiRoutes({ ...ANONYMOUS });
    renderRoutes(
      [
        {
          path: "/districts/:districtId",
          element: <DistrictPage />,
          errorElement: <DistrictErrorBoundary />,
          hydrateFallbackElement: <p />,
          loader: () => {
            throw new Response("Not Found", { status: 404 });
          },
        },
      ],
      "/districts/missing"
    );
    expect(await screen.findByText("District not found")).toBeInTheDocument();
  });
});
