import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElectionSummary } from "@voteapp/api-client";
import { renderRoutes } from "../test/render";
import { ballotSummary, electionDetail, electionSummary, retentionElection, VOTE_POWER_WITH_EXPLANATION } from "../test/fixtures";
import { stubApiRoutes } from "../test/mockApi";

vi.mock("../data/embedPilotCities", () => ({
  EMBED_PILOT_PUBLISHERS: ["alpha-news"],
  EMBED_PILOT_CITIES: {
    "austin-tx": {
      slug: "austin-tx",
      name: "Austin",
      state: "TX",
      election_date: "2026-11-03",
      review_date: "2026-09-16",
      official_source_url: "https://www.sos.state.tx.us/elections/",
      enabled: true,
      kind: "city",
      district_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    },
    tx: {
      slug: "tx",
      name: "Texas",
      state: "TX",
      election_date: "2026-11-03",
      review_date: "2026-09-16",
      official_source_url: "https://www.sos.state.tx.us/elections/",
      enabled: true,
      kind: "state",
      district_ids: ["44444444-4444-4444-8444-444444444444"],
    },
    "paused-city": {
      slug: "paused-city",
      name: "Paused",
      state: "TX",
      election_date: "2026-11-03",
      review_date: "2026-09-16",
      official_source_url: "https://example.gov/",
      enabled: false,
      kind: "city",
      district_ids: ["33333333-3333-4333-8333-333333333333"],
    },
  },
}));

const loadFromApi = vi.fn();
vi.mock("../lib/loadFromApi", () => ({ loadFromApi: (...args: unknown[]) => loadFromApi(...args) }));

import type { LoaderFunctionArgs } from "react-router";
import { resetEmbedSessionForTests } from "../lib/embedSession";
import { EmbedCityPage, ErrorBoundary, loader, type CityOverview } from "./EmbedCityPage";

const CANDIDATE = {
  candidate_election_id: "ce-1",
  candidate_id: "c-1",
  display_name: "Ada Lovelace",
  party: "Democratic",
  is_incumbent: true,
  status: "active",
};

function federalRace(): ElectionSummary {
  return electionSummary({
    id: "e-house",
    official_ballot_title: "U.S. House District 10",
    district: { id: "d-house", district_type: "us_house", name: "Congressional District 10", state: "TX" },
    office: { scope: "us_house" } as ElectionSummary["office"],
    preview: {
      seats_to_fill: null,
      candidates: [
        CANDIDATE,
        { ...CANDIDATE, candidate_election_id: "ce-2", candidate_id: "c-2", display_name: "Grace Hopper", party: "Republican", is_incumbent: false, status: "withdrawn" },
      ],
      measure: null,
    },
  });
}

function countyRace(): ElectionSummary {
  return electionSummary({
    id: "e-county",
    official_ballot_title: "County Commissioner, Precinct 2",
    district: { id: "d-county", district_type: "county", name: "Travis County", state: "TX" },
    sub_district_seat: "Precinct 2",
    office: { scope: "county" } as ElectionSummary["office"],
    preview: { seats_to_fill: 2, candidates: [CANDIDATE], measure: null },
  });
}

function measure(): ElectionSummary {
  return electionSummary({
    id: "e-prop",
    race_type: "ballot_measure",
    official_ballot_title: "Proposition A",
    district: { id: "d-place", district_type: "place", name: "Austin city", state: "TX" },
    preview: {
      seats_to_fill: null,
      candidates: [],
      measure: {
        id: "m-1",
        official_ballot_title: "Proposition A",
        summary: "Raises the library levy.",
        what_yes_means: "The levy rises.",
        what_no_means: "The levy stays.",
      },
    },
  });
}

function overview(overrides: Partial<CityOverview> = {}): CityOverview {
  return {
    city: {
      slug: "austin-tx",
      name: "Austin",
      state: "TX",
      kind: "city",
      election_date: "2026-11-03",
      review_date: "2026-09-16",
      official_source_url: "https://www.sos.state.tx.us/elections/",
    },
    races: [
      { id: "e-house", title: "U.S. House District 10", race_type: "office", level: "federal", district_name: "Congressional District 10", sub_district_seat: null, vote_power_label: "high", preview: federalRace().preview ?? null },
      { id: "e-county", title: "County Commissioner, Precinct 2", race_type: "office", level: "county", district_name: "Travis County", sub_district_seat: "Precinct 2", vote_power_label: "very_low", preview: countyRace().preview ?? null },
      { id: "e-prop", title: "Proposition A", race_type: "ballot_measure", level: "city", district_name: "Austin city", sub_district_seat: null, vote_power_label: "unknown", preview: measure().preview ?? null },
    ],
    embedded: true,
    ...overrides,
  };
}

function renderCity(data: CityOverview, path = "/embed/city/austin-tx", hash = "") {
  return renderRoutes(
    [
      { path: "/embed/city/:slug", element: <EmbedCityPage />, errorElement: <ErrorBoundary />, loader: () => data },
      { path: "/cities/:slug", element: <EmbedCityPage />, errorElement: <ErrorBoundary />, loader: () => data },
    ],
    hash ? { pathname: path, search: "", state: undefined, ...({ hash } as object) } : path
  );
}

beforeEach(() => {
  resetEmbedSessionForTests();
  loadFromApi.mockReset();
  window.location.hash = "";
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("loader", () => {
  const args = (slug: string, url: string) =>
    ({ params: { slug }, request: new Request(url), context: {} }) as unknown as LoaderFunctionArgs;

  it("404s for an unknown or disabled city", async () => {
    await expect(loader(args("nowhere", "http://x/embed/city/nowhere"))).rejects.toMatchObject({ status: 404 });
    await expect(loader(args("paused-city", "http://x/embed/city/paused-city"))).rejects.toMatchObject({ status: 404 });
    expect(loadFromApi).not.toHaveBeenCalled();
  });

  it("asks the ballot API for the manifest districts with the preview and keeps only the reviewed election date", async () => {
    loadFromApi.mockResolvedValue(
      ballotSummary([federalRace(), electionSummary({ id: "e-old", election_date: "2026-03-03", official_ballot_title: "Primary" })])
    );
    const result = await loader(args("austin-tx", "http://x/embed/city/austin-tx"));
    expect(loadFromApi).toHaveBeenCalledWith(
      "/api/ballot?district_ids=11111111-1111-4111-8111-111111111111%2C22222222-2222-4222-8222-222222222222&election_date=2026-11-03&sort=vote_power&include=preview",
      expect.any(Request)
    );
    expect(result.embedded).toBe(true);
    expect(result.races.map((race) => race.id)).toEqual(["e-house"]);
    expect(result.races[0]).toMatchObject({ level: "federal", district_name: "Congressional District 10", sub_district_seat: null, vote_power_label: "high" });
    expect(result.races[0]).not.toHaveProperty("vote_power");
  });

  it("leaves judicial retention questions out of the list", async () => {
    loadFromApi.mockResolvedValue(ballotSummary([federalRace(), retentionElection("e-retain", { election_date: "2026-11-03" })]));
    const result = await loader(args("austin-tx", "http://x/embed/city/austin-tx"));
    expect(result.races.map((race) => race.id)).toEqual(["e-house"]);
  });

  it("serves a state code from the manifest with its single statewide district", async () => {
    loadFromApi.mockResolvedValue(ballotSummary([]));
    const result = await loader(args("tx", "http://x/embed/city/tx"));
    expect(loadFromApi).toHaveBeenCalledWith(
      "/api/ballot?district_ids=44444444-4444-4444-8444-444444444444&election_date=2026-11-03&sort=vote_power&include=preview",
      expect.any(Request)
    );
    expect(result.city).toMatchObject({ kind: "state", name: "Texas" });
  });

  it("marks the plain /cities page as not embedded", async () => {
    loadFromApi.mockResolvedValue(ballotSummary([]));
    const result = await loader(args("austin-tx", "http://x/cities/austin-tx"));
    expect(result.embedded).toBe(false);
  });
});

describe("EmbedCityPage", () => {
  it("shows the city-wide framing, grouped races, and no address call to action", async () => {
    renderCity(overview());
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Explore November 3, 2026 races across Austin, TX.");
    expect(screen.queryByText(/not your ballot/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Find my races and build my ballot" })).not.toBeInTheDocument();
    // Every group starts collapsed, each with a race count.
    const federal = screen.getByText("Federal").closest("details")!;
    expect(federal).not.toHaveAttribute("open");
    expect(federal).toHaveTextContent("Federal (1 race)");
    const county = screen.getByText("County").closest("details")!;
    expect(county).not.toHaveAttribute("open");
    expect(county).toHaveTextContent("County (1 race)");
    expect(screen.getByText("Ballot measures")).toBeInTheDocument();
  });

  it("remembers which groups the reader opened in this browser", async () => {
    window.localStorage.setItem("voteapp_city_open_groups", JSON.stringify(["county"]));
    renderCity(overview());
    const county = (await screen.findByText("County")).closest("details")!;
    await waitFor(() => expect(county).toHaveAttribute("open"));
    expect(screen.getByText("Federal").closest("details")).not.toHaveAttribute("open");

    await userEvent.click(screen.getByText("Federal"));
    await waitFor(() => expect(screen.getByText("Federal").closest("details")).toHaveAttribute("open"));
    expect(JSON.parse(window.localStorage.getItem("voteapp_city_open_groups")!)).toEqual(["county", "federal"]);

    await userEvent.click(screen.getByText("County"));
    await waitFor(() => expect(county).not.toHaveAttribute("open"));
    expect(JSON.parse(window.localStorage.getItem("voteapp_city_open_groups")!)).toEqual(["federal"]);
  });

  it("renders each candidate as one clickable row with party, incumbent and withdrawn state, opening inside the box", async () => {
    renderCity(overview());
    const row = (await screen.findAllByText("Ada Lovelace"))[0].closest("li")!;
    expect(within(row).getByText("Democratic")).toBeInTheDocument();
    expect(within(row).getByText("Incumbent")).toBeInTheDocument();
    const link = within(row).getByRole("link", { name: /Ada Lovelace/ });
    expect(link).toHaveAttribute("href", "/candidates/c-1");
    // A router link: the profile opens in the box, not a new tab.
    expect(link).not.toHaveAttribute("target");
    const withdrawn = screen.getByText("Grace Hopper");
    expect(withdrawn).toHaveClass("line-through");
    expect(withdrawn.closest("li")).toHaveTextContent("(withdrew)");
  });

  it("lists each ballot measure as a title row that opens the measure's own page", async () => {
    renderCity(overview());
    const link = await screen.findByRole("link", { name: /Proposition A/ });
    expect(link).toHaveAttribute("href", "/elections/e-prop");
    expect(link).not.toHaveAttribute("target");
    expect(link).toHaveTextContent("Austin city");
    // The description and the yes/no meanings live on the measure page.
    expect(screen.queryByText(/Raises the library levy/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A yes vote means/)).not.toBeInTheDocument();
  });

  it("shows seat counts and the ward-level seat note", async () => {
    renderCity(overview());
    expect(await screen.findByText(/Travis County · covers Precinct 2 · Vote for up to 2/)).toBeInTheDocument();
  });

  it("shows the site's vote-power badge per race, folding very low into low and hiding unknown", async () => {
    renderCity(overview());
    expect(await screen.findByRole("button", { name: /Vote power: High/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Vote power: Below average/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Vote power:/ })).toHaveLength(2);
  });

  it("explains a race's vote power in a closable box, fetched only on demand", async () => {
    const fetchMock = stubApiRoutes({
      "/api/elections/e-house": { body: electionDetail({ id: "e-house", vote_power: VOTE_POWER_WITH_EXPLANATION }) },
    });
    renderCity(overview());
    const badge = await screen.findByRole("button", { name: /Vote power: High/ });
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(badge);
    const box = await screen.findByRole("region", { name: "Vote power explanation" });
    expect(await within(box).findByText(/mid-sized for its type/)).toBeInTheDocument();
    expect(within(box).getByText("Average representation + high decisiveness → Vote power: High.")).toBeInTheDocument();
    expect(within(box).getByText("Some data is missing.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.click(within(box).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Vote power explanation" })).not.toBeInTheDocument();
  });

  it("applies an allowlisted publisher code from the hash to outbound links only", async () => {
    window.location.hash = "#pub=alpha-news";
    renderCity(overview());
    const brand = (await screen.findAllByRole("link", { name: "Elections Simplified" }))[0]!;
    await waitFor(() => expect(brand).toHaveAttribute("href", "/?src=alpha-news"));
    expect(screen.getAllByRole("link", { name: /Ada Lovelace/ })[0]).toHaveAttribute("href", "/candidates/c-1?src=alpha-news");
  });

  it("ignores a publisher code that is not on the allowlist", async () => {
    window.location.hash = "#pub=stranger";
    renderCity(overview());
    const brand = (await screen.findAllByRole("link", { name: "Elections Simplified" }))[0]!;
    // Give the hash effect a chance to run; the href must stay untouched.
    await waitFor(() => expect(brand).toHaveAttribute("href", "/"));
    expect(screen.getAllByRole("link", { name: /Ada Lovelace/ })[0]).toHaveAttribute("href", "/candidates/c-1");
  });

  it("drops the frame-only chrome and targets on the plain city page", async () => {
    renderCity(overview({ embedded: false }), "/cities/austin-tx");
    await screen.findByRole("heading", { level: 1 });
    // The header wordmark is frame-only; the site header carries the brand here.
    expect(screen.queryByRole("link", { name: "Elections Simplified" })).not.toBeInTheDocument();
  });

  it("frames a two-letter state code as statewide races only", async () => {
    renderCity(overview({ city: { ...overview().city, slug: "tx", name: "Texas", kind: "state" } }), "/embed/city/tx");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Explore November 3, 2026 statewide races in Texas.");
    expect(screen.queryByText(/not your full ballot/)).not.toBeInTheDocument();
  });

  it("says when the election has passed", async () => {
    renderCity(overview({ city: { ...overview().city, election_date: "2020-11-03" }, races: [] }));
    expect(await screen.findByText("This election has passed.")).toBeInTheDocument();
    expect(screen.getByText(/No November 3, 2020 races are listed/)).toBeInTheDocument();
  });

  it("renders the not-available boundary for a 404", async () => {
    renderRoutes(
      [
        {
          path: "/embed/city/:slug",
          element: <EmbedCityPage />,
          errorElement: <ErrorBoundary />,
          loader: () => {
            throw new Response("Not Found", { status: 404 });
          },
        },
      ],
      "/embed/city/nowhere"
    );
    expect(await screen.findByText("City not available")).toBeInTheDocument();
  });
});
