import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_TODAY, isDemoMode, isDemoPath, isOutsideDemo } from "./demoMode";
import { loadFromApi } from "./loadFromApi";
import { usLatestLocalDate } from "./usLatestLocalDate";

function visit(path: string): void {
  window.history.pushState({}, "", path);
}

afterEach(() => {
  visit("/");
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("isDemoPath", () => {
  it("matches /demo and everything under it, in any letter case", () => {
    for (const path of ["/demo", "/demo/", "/demo/ballot", "/demo/elections/e-1", "/Demo/ballot"]) {
      expect(isDemoPath(path), path).toBe(true);
    }
  });

  it("does not match other pages that merely start with the same letters", () => {
    for (const path of ["/", "/ballot", "/demonstration", "/elections/demo", "/me/demo"]) {
      expect(isDemoPath(path), path).toBe(false);
    }
  });
});

describe("isOutsideDemo", () => {
  it("covers sign-in, account, shared-pick and payment pages", () => {
    for (const path of ["/login", "/register", "/reset-password", "/me/picks", "/me", "/picks/tok", "/support", "/support/once"]) {
      expect(isOutsideDemo(path), path).toBe(true);
    }
  });

  it("leaves the public pages in the demo", () => {
    for (const path of ["/", "/ballot", "/draft", "/elections/e-1", "/candidates/c-1", "/browse/ky", "/mission", "/methodology"]) {
      expect(isOutsideDemo(path), path).toBe(false);
    }
  });
});

describe("in the browser", () => {
  const REAL_DISTRICT = "11111111-1111-4111-8111-000000000001";
  const DEMO_DISTRICT = "22222222-2222-4222-8222-000000000002";

  // The draft module keeps an in-memory copy for the life of a page, and
  // entering or leaving the demo is always a full page load: model one.
  async function loadPage(path: string) {
    visit(path);
    vi.resetModules();
    return import("./ballotDraft");
  }

  it("is off on a normal page: real date, real draft", async () => {
    const draft = await loadPage("/ballot");
    expect(isDemoMode()).toBe(false);
    expect(usLatestLocalDate()).not.toBe(DEMO_TODAY);
    draft.setDraftBallotContext([REAL_DISTRICT], null);
    expect(Object.keys(window.localStorage)).toEqual(["voteapp_ballot_draft"]);
  });

  it("is on under /demo: fixed date, and a draft of its own", async () => {
    (await loadPage("/ballot")).setDraftBallotContext([REAL_DISTRICT], null);
    const realDraftBefore = window.localStorage.getItem("voteapp_ballot_draft");

    const demoDraft = await loadPage("/demo/ballot");
    expect(isDemoMode()).toBe(true);
    expect(usLatestLocalDate()).toBe("2026-11-02");
    // The real draft is neither read nor written from the demo.
    expect(demoDraft.readBallotDraft().district_ids).toEqual([]);
    demoDraft.setDraftBallotContext([DEMO_DISTRICT], null);
    expect(window.localStorage.getItem("voteapp_ballot_draft")).toBe(realDraftBefore);
    expect(JSON.parse(window.localStorage.getItem("voteapp_ballot_draft_demo") ?? "{}").district_ids).toEqual([
      DEMO_DISTRICT,
    ]);

    expect((await loadPage("/ballot")).readBallotDraft().district_ids).toEqual([REAL_DISTRICT]);
  });

  it("sends the demo header from a loader only under /demo", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const headerOf = (call: number) => (fetchMock.mock.calls[call][1]?.headers as Headers).get("x-voteapp-demo");

    visit("/elections/e-1");
    await loadFromApi("/api/elections/e-1", new Request("http://ssr.local/elections/e-1"));
    visit("/demo/elections/e-1");
    await loadFromApi("/api/elections/e-1", new Request("http://ssr.local/demo/elections/e-1"));

    expect(headerOf(0)).toBeNull();
    expect(headerOf(1)).toBe("1");
  });
});
