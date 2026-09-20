import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@voteapp/api-client";
import {
  arrivalFor,
  countBucket,
  errorCategoryOf,
  flushUsageEventsForTests,
  isUsageOptedOut,
  officeLevel,
  pageViewProps,
  positionBucket,
  resetUsageForTests,
  routeForMatchId,
  setUsageOptOut,
  chatSourceBucket,
  sourceLinkProps,
  track,
  trackSettled,
} from "./usage";

type SentBody = {
  v: number;
  events: { name: string; route: string; session_id: string; props: Record<string, unknown> }[];
};

function stubFetch(status = 204) {
  const fetchMock = vi.fn(async () => ({ ok: status < 300, status, headers: new Headers(), json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBodies(fetchMock: ReturnType<typeof stubFetch>): SentBody[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
}

beforeEach(() => {
  resetUsageForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
});

vi.mock("../data/embedPublishers", () => ({ EMBED_PUBLISHERS: ["alpha-news"] }));

describe("track", () => {
  it("records an allowlisted publisher code from the arrival URL on session_start, and nothing else from the query", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    window.history.replaceState({}, "", "/?src=alpha-news&utm_source=leak");
    const fetchMock = stubFetch();
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const start = sentBodies(fetchMock)[0]!.events[0]!;
    expect(start.name).toBe("session_start");
    expect(start.props).toMatchObject({ source: "alpha-news" });
    expect(JSON.stringify(start)).not.toContain("leak");
  });

  it("ignores a source code that is not on the allowlist", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    window.history.replaceState({}, "", "/?src=stranger");
    const fetchMock = stubFetch();
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(sentBodies(fetchMock)[0]!.events[0]!.props).not.toHaveProperty("source");
  });

  it("is inert unless the build flag is on", () => {
    const fetchMock = stubFetch();
    track("address_input");
    flushUsageEventsForTests();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("voteapp_usage_session")).toBeNull();
  });

  it("opens a session, sends a session_start first, and posts only catalog fields", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch();
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/usage/events");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const body = sentBodies(fetchMock)[0]!;
    expect(body.v).toBe(1);
    expect(body.events.map((event) => event.name)).toEqual(["session_start", "address_input"]);
    // Route ids only — no pathname, no href, no query string anywhere.
    for (const event of body.events) {
      expect(Object.keys(event).sort()).toEqual(
        ["client_offset_ms", "event_id", "name", "page_view_id", "props", "route", "session_id"].sort()
      );
      expect(JSON.stringify(event)).not.toContain("http");
    }
    expect(body.events[0]!.props).toMatchObject({ referrer_bucket: "direct", auth: "unknown", had_saved_draft: false });
    expect(sessionStorage.getItem("voteapp_usage_session")).not.toBeNull();
  });

  it("stops for the tab once the server says the feature is off (404)", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch(404);
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    track("address_submit", { via_suggestion: false });
    flushUsageEventsForTests();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-sends a batch once after a server failure, then gives up", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch(503);
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    // The re-queue lands after the response settles; keep flushing until
    // the second request goes out (one in-flight request at a time).
    await vi.waitFor(() => {
      flushUsageEventsForTests();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(sentBodies(fetchMock)[1]!.events.map((event) => event.name)).toEqual(["session_start", "address_input"]);
    await vi.waitFor(() => {
      flushUsageEventsForTests();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushUsageEventsForTests();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never resends a batch that failed in flight after the visitor opted out", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    let release!: (value: { ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }) => void;
    const fetchMock = vi.fn(() => new Promise<{ ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> }>((resolve) => {
      release = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    track("address_input");
    flushUsageEventsForTests();
    expect(fetchMock).toHaveBeenCalledOnce();
    // Opt out while the request is in flight, then let it fail.
    setUsageOptOut(true);
    release({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushUsageEventsForTests();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors the /privacy opt-out and drops anything queued", () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch();
    track("address_input");
    setUsageOptOut(true);
    expect(isUsageOptedOut()).toBe(true);
    track("address_submit", { via_suggestion: false });
    flushUsageEventsForTests();
    expect(fetchMock).not.toHaveBeenCalled();
    setUsageOptOut(false);
    expect(isUsageOptedOut()).toBe(false);
  });

  it("reuses a recent stored session and rotates a stale one", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch();
    const recent = { id: "11111111-1111-4111-8111-111111111111", started_at: Date.now() - 60_000, last_active_at: Date.now() - 60_000 };
    sessionStorage.setItem("voteapp_usage_session", JSON.stringify(recent));
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const first = sentBodies(fetchMock)[0]!;
    expect(first.events.map((event) => event.name)).toEqual(["address_input"]);
    expect(first.events[0]!.session_id).toBe(recent.id);

    resetUsageForTests();
    const stale = { ...recent, last_active_at: Date.now() - 31 * 60_000 };
    sessionStorage.setItem("voteapp_usage_session", JSON.stringify(stale));
    track("address_input");
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = sentBodies(fetchMock)[1]!;
    expect(second.events.map((event) => event.name)).toEqual(["session_start", "address_input"]);
    expect(second.events[0]!.session_id).not.toBe(recent.id);
  });

  it("keeps an opt-out for the tab even when localStorage refuses the write", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
      if (key === "voteapp_usage_optout") throw new Error("quota");
    });
    try {
      setUsageOptOut(true);
      expect(isUsageOptedOut()).toBe(true);
      track("address_input");
      flushUsageEventsForTests();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("never throws when sessionStorage is unavailable", () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(() => track("address_input")).not.toThrow();
      flushUsageEventsForTests();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
    }
  });
});

describe("helpers", () => {
  it("maps route ids and never falls back to a path", () => {
    expect(routeForMatchId("pages/HomePage")).toBe("home");
    expect(routeForMatchId("pages/PublicPickCardPage")).toBe("pick_card");
    expect(routeForMatchId("routes/privacy")).toBe("privacy");
    expect(routeForMatchId("0-3")).toBe("other");
    expect(routeForMatchId(undefined)).toBe("other");
  });

  it("buckets counts and positions", () => {
    expect([0, 1, 3, 4, 10, 11, 25, 26].map(countBucket)).toEqual(["0", "1-3", "1-3", "4-10", "4-10", "11-25", "11-25", "26+"]);
    expect([1, 3, 4, 10, 11].map(positionBucket)).toEqual(["1-3", "1-3", "4-10", "4-10", "11+"]);
  });

  it("maps office scopes and district types to coarse levels", () => {
    expect(officeLevel("us_house")).toBe("federal");
    expect(officeLevel("statewide")).toBe("state");
    expect(officeLevel("state_lower")).toBe("state");
    expect(officeLevel("county")).toBe("county");
    expect(officeLevel("place")).toBe("city");
    expect(officeLevel("school_unified")).toBe("school");
    expect(officeLevel(null)).toBe("other");
  });

  it("reads arrival from the nav state's back destination, never its ids", () => {
    expect(arrivalFor("election", null)).toBe("deep");
    expect(arrivalFor("election", { backTo: { path: "/ballot?d=abc", label: "All elections" } })).toBe("list");
    expect(arrivalFor("election", { backTo: { path: "/me/ballot", label: "My Elections" } })).toBe("list");
    expect(arrivalFor("election", { backTo: { path: "/candidates/c-1", label: "Jane" } })).toBe("candidate");
    expect(arrivalFor("candidate", { backTo: { path: "/elections/e-1", label: "Governor" } })).toBe("roster");
    expect(arrivalFor("candidate", { backTo: { path: "/draft", label: "My Ballot Draft" } })).toBe("draft");
    expect(arrivalFor("candidate", { backTo: { path: "/me/picks", label: "My Election Draft" } })).toBe("picks");
    expect(arrivalFor("candidate", { backTo: { path: "/picks/tok3n", label: "Shared picks" } })).toBe("share");
    expect(arrivalFor("candidate", { backTo: { path: "https://evil.example", label: "x" } })).toBe("deep");
  });

  it("describes a detail page's content shape without naming it", () => {
    const election = {
      id: "e-1",
      race_type: "ballot_measure",
      election_date: "2099-11-03",
      office: null,
      district: { id: "d-1", district_type: "county", name: "Kings County", state: "NY" },
      candidates: [],
      ballot_measure: {
        id: "m-1",
        summary: "A short summary.",
        official_measure_url: "https://sos.ca.gov/measure.pdf",
        research_area_tags: [{ research_area_id: "a", slug: "housing", name: "Housing", stance: "for" }],
      },
    };
    const props = pageViewProps("election", election, null);
    expect(props).toEqual({
      arrival: "deep",
      race_type: "ballot_measure",
      office_level: "county",
      upcoming: true,
      measure_tbd: false,
      has_summary: true,
      has_official_url: true,
      has_stance_tags: true,
    });
    expect(JSON.stringify(props)).not.toContain("e-1");

    const office = pageViewProps(
      "election",
      { race_type: "office", election_date: "2000-01-01", office: { scope: "statewide", summary: "" }, district: {}, candidates: [{}, {}, {}, {}] },
      { backTo: { path: "/ballot", label: "All" } }
    );
    expect(office).toEqual({
      arrival: "list",
      race_type: "office",
      office_level: "state",
      upcoming: false,
      has_summary: false,
      candidate_count_bucket: "4-10",
    });

    const candidate = pageViewProps(
      "candidate",
      {
        candidate: { candidate_id: "c-1", summary: "Bio.", records: [{}, {}], elections: [{ election_date: "2099-11-03" }] },
        ongoing_finance: { x: null },
      },
      null
    );
    expect(candidate).toEqual({ arrival: "deep", has_summary: true, record_count_bucket: "1-3", upcoming: true, has_finance: false });
    expect(pageViewProps("home", { anything: 1 }, null)).toEqual({});
  });

  it("folds chat card source types to a short list, unknown to other", () => {
    expect(chatSourceBucket("candidate_profile")).toBe("candidate");
    expect(chatSourceBucket("official_state_resource")).toBe("official");
    expect(chatSourceBucket("brand_new_type")).toBe("other");
  });

  it("flags .gov hosts and PDFs for source clicks without keeping the URL", () => {
    expect(sourceLinkProps("https://sos.ca.gov/measures/prop-1.pdf?x=1")).toEqual({ gov: true, pdf: true });
    expect(sourceLinkProps("https://ballotpedia.org/Prop_1")).toEqual({ gov: false, pdf: false });
    expect(sourceLinkProps("not a url")).toEqual({ gov: false, pdf: false });
  });

  it("records a settled outcome on the page the operation started from", async () => {
    vi.stubEnv("VITE_USAGE_ANALYTICS_ENABLED", "true");
    const fetchMock = stubFetch();
    let reject!: (error: unknown) => void;
    const request = new Promise((_resolve, rej) => {
      reject = rej;
    });
    trackSettled(request, "follow_result", { change: "follow" });
    reject(new ApiError(503, "unavailable", "down"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushUsageEventsForTests();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const events = sentBodies(fetchMock)[0]!.events;
    expect(events.at(-1)).toMatchObject({
      name: "follow_result",
      props: { change: "follow", outcome: "error", error_category: "server" },
    });
  });

  it("categorizes errors without carrying their messages", () => {
    expect(errorCategoryOf(new ApiError(422, "address_not_found", "We couldn't find 123 Main St"))).toBe("address");
    expect(errorCategoryOf(new ApiError(429, "rate_limited", "slow down", 30))).toBe("rate_limited");
    expect(errorCategoryOf(new ApiError(502, "bad_gateway", "upstream"))).toBe("server");
    expect(errorCategoryOf(new ApiError(404, "not_found", "gone"))).toBe("not_found");
    expect(errorCategoryOf(new ApiError(400, "invalid_request", "bad"))).toBe("other");
    expect(errorCategoryOf(new TypeError("Failed to fetch"))).toBe("network");
  });
});
