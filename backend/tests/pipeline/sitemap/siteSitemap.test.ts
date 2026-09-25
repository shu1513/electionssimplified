import { describe, expect, it, vi } from "vitest";

import {
  buildSitemapFiles,
  buildSitemapIndexXml,
  buildSiteSitemapXml,
  createCachedSiteSitemap,
  listSiteSitemapUrls,
  normalizeSiteOrigin,
  parseSitemapSelection,
  SITEMAP_PAGE_SIZE,
} from "../../../src/pipeline/sitemap/siteSitemap.js";

function createDbMock() {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        { path: "/browse/ak", lastmod: "2026-07-01T12:34:56.000Z" },
        { path: "/districts/dddddddd-1111-4111-8111-111111111111", lastmod: "2026-07-01T12:34:56.000Z" },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          path: "/elections/11111111-1111-4111-8111-111111111111",
          lastmod: new Date("2026-07-01T12:34:56.000Z"),
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          path: "/candidates/22222222-2222-4222-8222-222222222222",
          lastmod: "2026-07-02T00:00:00.000Z",
        },
      ],
    });
  return { query };
}

describe("site sitemap", () => {
  it("normalizes an absolute site origin", () => {
    expect(normalizeSiteOrigin("https://electionssimplified.com/")).toBe("https://electionssimplified.com");
    expect(normalizeSiteOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("rejects origins with paths or unsupported protocols", () => {
    expect(() => normalizeSiteOrigin("https://electionssimplified.com/app")).toThrow(/must not include/);
    expect(() => normalizeSiteOrigin("ftp://electionssimplified.com")).toThrow(/http or https/);
    expect(() => normalizeSiteOrigin("not a url")).toThrow(/absolute http\(s\) URL/);
  });

  it("keeps the page size inside the sitemap protocol's 50,000-URL cap", () => {
    expect(SITEMAP_PAGE_SIZE).toBeLessThanOrEqual(50_000);
  });

  it("builds XML with escaped absolute URLs and lastmod values", () => {
    const xml = buildSiteSitemapXml({
      siteOrigin: "https://example.test",
      urls: [
        { path: "/" },
        { path: "/elections/11111111-1111-4111-8111-111111111111", lastmod: "2026-07-01T12:34:56Z" },
        { path: "/search?q=one&two", lastmod: new Date("2026-07-02T00:00:00.000Z") },
      ],
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<loc>https://example.test/</loc>");
    expect(xml).toContain("<lastmod>2026-07-01T12:34:56.000Z</lastmod>");
    expect(xml).toContain("<loc>https://example.test/search?q=one&amp;two</loc>");
  });

  it("builds a sitemap index with escaped child URLs", () => {
    const xml = buildSitemapIndexXml({
      siteOrigin: "https://example.test",
      sitemaps: [{ path: "/sitemap.xml?part=elections&page=1", lastmod: "2026-07-01T12:34:56Z" }],
    });

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<sitemap><loc>https://example.test/sitemap.xml?part=elections&amp;page=1</loc>");
    expect(xml).toContain("<lastmod>2026-07-01T12:34:56.000Z</lastmod></sitemap>");
    expect(xml).not.toContain("<urlset");
  });

  it("parses the child-file selection off the query string", () => {
    expect(parseSitemapSelection(new URLSearchParams(""))).toBeNull();
    expect(parseSitemapSelection(new URLSearchParams("part=elections&page=2"))).toEqual({ part: "elections", page: 2 });
    expect(parseSitemapSelection(new URLSearchParams("part=pages"))).toEqual({ part: "pages", page: 1 });
    // Unknown part, or a page that is not a positive integer: no such file.
    expect(parseSitemapSelection(new URLSearchParams("part=users"))).toBeUndefined();
    expect(parseSitemapSelection(new URLSearchParams("part=elections&page=0"))).toBeUndefined();
    expect(parseSitemapSelection(new URLSearchParams("part=elections&page=1.5"))).toBeUndefined();
    expect(parseSitemapSelection(new URLSearchParams("part=elections&page=-1"))).toBeUndefined();
    expect(parseSitemapSelection(new URLSearchParams("page=1"))).toBeUndefined();
  });

  it("lists static, browse, election and active candidate URLs in that order", async () => {
    const db = createDbMock();

    const urls = await listSiteSitemapUrls(db);

    expect(urls).toEqual([
      { path: "/" },
      { path: "/mission" },
      { path: "/methodology" },
      // /stats is derived from every election, so it is as fresh as the newest one.
      { path: "/stats", lastmod: new Date("2026-07-01T12:34:56.000Z") },
      { path: "/support" },
      { path: "/support/member" },
      { path: "/support/once" },
      { path: "/disclaimer" },
      { path: "/terms" },
      { path: "/privacy" },
      { path: "/browse" },
      { path: "/browse/ak", lastmod: "2026-07-01T12:34:56.000Z" },
      { path: "/districts/dddddddd-1111-4111-8111-111111111111", lastmod: "2026-07-01T12:34:56.000Z" },
      {
        path: "/elections/11111111-1111-4111-8111-111111111111",
        lastmod: new Date("2026-07-01T12:34:56.000Z"),
      },
      {
        path: "/candidates/22222222-2222-4222-8222-222222222222",
        lastmod: "2026-07-02T00:00:00.000Z",
      },
    ]);
    expect(db.query).toHaveBeenCalledTimes(3);
    // Browse pages exist only for named states and districts holding an
    // election — the same rules the catalog serves by, so nothing listed 404s.
    expect(db.query.mock.calls[0]?.[0]).toContain("JOIN public.elections e ON e.district_id = d.id");
    expect(db.query.mock.calls[0]?.[0]).toContain("WHERE d.state = ANY($1)");
    const stateCodes = db.query.mock.calls[0]?.[1]?.[0] as string[];
    expect(stateCodes).toHaveLength(51);
    expect(stateCodes).toContain("DC");
    expect(stateCodes).not.toContain("PR");
    expect(db.query.mock.calls[2]?.[0]).toContain("deleted_at IS NULL");
    expect(db.query.mock.calls[2]?.[0]).toContain("merged_into_candidate_id IS NULL");
  });

  it("splits each part into pages and lists every page in the index", () => {
    const elections = Array.from({ length: 5 }, (_, i) => ({
      path: `/elections/${i}`,
      lastmod: `2026-07-0${i + 1}T00:00:00.000Z`,
    }));
    const files = buildSitemapFiles({
      siteOrigin: "https://example.test",
      parts: { pages: [{ path: "/" }], browse: [{ path: "/browse" }], elections, candidates: [] },
      pageSize: 2,
    });

    // 1 page of static paths, 1 of browse, 3 of elections, 1 (empty) of candidates.
    expect([...files.children.keys()]).toEqual([
      "/sitemap.xml?part=pages&page=1",
      "/sitemap.xml?part=browse&page=1",
      "/sitemap.xml?part=elections&page=1",
      "/sitemap.xml?part=elections&page=2",
      "/sitemap.xml?part=elections&page=3",
      "/sitemap.xml?part=candidates&page=1",
    ]);
    for (const path of files.children.keys()) {
      expect(files.index).toContain(`<loc>https://example.test${path.replace("&", "&amp;")}</loc>`);
    }
    const lastPage = files.children.get("/sitemap.xml?part=elections&page=3") ?? "";
    expect(lastPage).toContain("<loc>https://example.test/elections/4</loc>");
    expect(lastPage).not.toContain("/elections/3</loc>");
    // The index carries each page's newest lastmod.
    expect(files.index).toContain(
      "<loc>https://example.test/sitemap.xml?part=elections&amp;page=1</loc><lastmod>2026-07-02T00:00:00.000Z</lastmod>"
    );
    expect(files.children.get("/sitemap.xml?part=candidates&page=1")).toContain("<urlset");
  });

  it("rejects a page size the sitemap protocol would not accept", () => {
    const parts = { pages: [], browse: [], elections: [], candidates: [] };
    expect(() => buildSitemapFiles({ siteOrigin: "https://example.test", parts, pageSize: 50_001 })).toThrow(/50,000/);
    expect(() => buildSitemapFiles({ siteOrigin: "https://example.test", parts, pageSize: 0 })).toThrow(/50,000/);
  });

  it("serves the index without a selection and child files with one", async () => {
    const db = createDbMock();
    const getSitemapXml = createCachedSiteSitemap({ db, siteOrigin: "https://example.test" });

    const index = await getSitemapXml();
    expect(index).toContain("<sitemapindex");
    expect(index).toContain("https://example.test/sitemap.xml?part=candidates&amp;page=1");

    const elections = await getSitemapXml({ part: "elections", page: 1 });
    expect(elections).toContain("<loc>https://example.test/elections/11111111-1111-4111-8111-111111111111</loc>");
    expect(elections).not.toContain("/candidates/");

    const browse = await getSitemapXml({ part: "browse", page: 1 });
    expect(browse).toContain("<loc>https://example.test/browse</loc>");
    expect(browse).toContain("<loc>https://example.test/browse/ak</loc>");
    expect(browse).toContain("<loc>https://example.test/districts/dddddddd-1111-4111-8111-111111111111</loc>");

    // Past the last page: no such file.
    expect(await getSitemapXml({ part: "elections", page: 2 })).toBeNull();
    // One DB snapshot served all of the above.
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("caches generated XML for the configured TTL", async () => {
    const db = createDbMock();
    let now = 1_000;
    const getSitemapXml = createCachedSiteSitemap({
      db,
      siteOrigin: "https://example.test",
      ttlMs: 60_000,
      now: () => now,
    });

    const first = await getSitemapXml();
    const second = await getSitemapXml();
    now += 60_001;
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const third = await getSitemapXml();

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(db.query).toHaveBeenCalledTimes(6);
  });

  it("serves stale cached XML when a refresh fails", async () => {
    const db = createDbMock();
    let now = 1_000;
    const getSitemapXml = createCachedSiteSitemap({
      db,
      siteOrigin: "https://example.test",
      ttlMs: 60_000,
      now: () => now,
    });

    const first = await getSitemapXml();
    now += 60_001;
    db.query
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const second = await getSitemapXml();

    expect(second).toBe(first);
    expect(db.query).toHaveBeenCalledTimes(6);
  });
});
