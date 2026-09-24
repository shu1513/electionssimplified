import { describe, expect, it } from "vitest";

import { buildIndexNowPayload, parseIndexNowArgs, selectIndexNowUrls } from "../../src/scripts/indexNowSubmit.js";

describe("indexnow submit", () => {
  it("parses exactly one of --all / --since, plus --dry-run", () => {
    expect(parseIndexNowArgs(["--all"])).toEqual({ since: null, all: true, dryRun: false });
    expect(parseIndexNowArgs(["--since", "2026-09-20", "--dry-run"])).toEqual({ since: "2026-09-20", all: false, dryRun: true });
    expect(() => parseIndexNowArgs([])).toThrow(/exactly one/);
    expect(() => parseIndexNowArgs(["--all", "--since", "2026-09-20"])).toThrow(/exactly one/);
    expect(() => parseIndexNowArgs(["--since", "yesterday"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseIndexNowArgs(["--since", "2026-99-99"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseIndexNowArgs(["--since", "2026-02-30"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseIndexNowArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("selects every URL with --all and only rows modified on or after --since", () => {
    const urls = [
      { path: "/" },
      { path: "/elections/e-old", lastmod: "2026-09-01T00:00:00.000Z" },
      { path: "/elections/e-new", lastmod: new Date("2026-09-21T12:00:00Z") },
      { path: "/candidates/c-edge", lastmod: "2026-09-20T00:00:00.000Z" },
    ];
    expect(selectIndexNowUrls(urls, "https://electionssimplified.com", null)).toEqual([
      "https://electionssimplified.com/",
      "https://electionssimplified.com/elections/e-old",
      "https://electionssimplified.com/elections/e-new",
      "https://electionssimplified.com/candidates/c-edge",
    ]);
    // Static pages have no lastmod and are skipped by a --since run.
    expect(selectIndexNowUrls(urls, "https://electionssimplified.com", "2026-09-20")).toEqual([
      "https://electionssimplified.com/elections/e-new",
      "https://electionssimplified.com/candidates/c-edge",
    ]);
  });

  it("builds the protocol payload with the key file at the site root", () => {
    expect(buildIndexNowPayload({ siteOrigin: "https://electionssimplified.com/", key: "abc123", urlList: ["https://electionssimplified.com/stats"] })).toEqual({
      host: "electionssimplified.com",
      key: "abc123",
      keyLocation: "https://electionssimplified.com/indexnow-key.txt",
      urlList: ["https://electionssimplified.com/stats"],
    });
  });
});
