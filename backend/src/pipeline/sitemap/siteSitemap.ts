import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export const DEFAULT_SITE_SITEMAP_CACHE_TTL_MS = 60 * 60 * 1000;

export const SITEMAP_STATIC_PATHS = ["/", "/mission", "/support", "/support/member", "/support/once", "/disclaimer", "/terms", "/privacy"] as const;

// The sitemap protocol caps one file at 50,000 URLs (and 50 MB); the site
// passed that in 2026-09 (~55k election + candidate pages), and Search
// Console rejects an oversized file outright rather than reading the first
// 50,000. So /sitemap.xml is a sitemap index, and each child file holds one
// part (static pages, elections, candidates) in pages of this size. Child
// files live at the same path with a query string (?part=…&page=…) so the
// edge Worker's exact-path routing (isApiPath) and robots.txt need no change.
export const SITEMAP_PAGE_SIZE = 25_000;

export const SITEMAP_PARTS = ["pages", "elections", "candidates"] as const;
export type SitemapPart = (typeof SITEMAP_PARTS)[number];

export type SitemapSelection = { part: SitemapPart; page: number };

export type SiteSitemapUrl = {
  path: string;
  lastmod?: string | Date | null;
};

type SitemapRow = {
  path: string;
  lastmod: string | Date | null;
};

export type CachedSiteSitemapOptions = {
  db: Queryable;
  siteOrigin: string;
  ttlMs?: number;
  now?: () => number;
  /** URLs per child sitemap; tests shrink it. Must stay ≤ 50,000. */
  pageSize?: number;
};

export function normalizeSiteOrigin(rawOrigin: string): string {
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    throw new Error("SITE_ORIGIN must not be empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`SITE_ORIGIN must be an absolute http(s) URL: ${rawOrigin}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`SITE_ORIGIN must use http or https: ${rawOrigin}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`SITE_ORIGIN must not include a path, query, or hash: ${rawOrigin}`);
  }

  return parsed.origin;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLastmod(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function absoluteUrl(siteOrigin: string, path: string): string {
  return new URL(path, `${siteOrigin}/`).toString();
}

/**
 * Reads ?part=…&page=… off /sitemap.xml. null = no selection (serve the
 * index); undefined = a selection that can never exist (unknown part, page
 * that is not a positive integer), which the API answers with 404.
 */
export function parseSitemapSelection(searchParams: URLSearchParams): SitemapSelection | null | undefined {
  const part = searchParams.get("part");
  const rawPage = searchParams.get("page");
  if (part === null && rawPage === null) {
    return null;
  }
  if (!SITEMAP_PARTS.includes(part as SitemapPart)) {
    return undefined;
  }
  const page = rawPage === null ? 1 : /^\d+$/.test(rawPage) ? Number(rawPage) : Number.NaN;
  if (!Number.isInteger(page) || page < 1) {
    return undefined;
  }
  return { part: part as SitemapPart, page };
}

export function sitemapSelectionPath(selection: SitemapSelection): string {
  return `/sitemap.xml?part=${selection.part}&page=${selection.page}`;
}

export function buildSiteSitemapXml(input: { siteOrigin: string; urls: readonly SiteSitemapUrl[] }): string {
  const siteOrigin = normalizeSiteOrigin(input.siteOrigin);
  const entries = input.urls
    .map((url) => {
      const loc = escapeXml(absoluteUrl(siteOrigin, url.path));
      const lastmod = formatLastmod(url.lastmod);
      return lastmod
        ? `  <url><loc>${loc}</loc><lastmod>${escapeXml(lastmod)}</lastmod></url>`
        : `  <url><loc>${loc}</loc></url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function buildSitemapIndexXml(input: { siteOrigin: string; sitemaps: readonly SiteSitemapUrl[] }): string {
  const siteOrigin = normalizeSiteOrigin(input.siteOrigin);
  const entries = input.sitemaps
    .map((sitemap) => {
      const loc = escapeXml(absoluteUrl(siteOrigin, sitemap.path));
      const lastmod = formatLastmod(sitemap.lastmod);
      return lastmod
        ? `  <sitemap><loc>${loc}</loc><lastmod>${escapeXml(lastmod)}</lastmod></sitemap>`
        : `  <sitemap><loc>${loc}</loc></sitemap>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

export type SiteSitemapParts = Record<SitemapPart, SiteSitemapUrl[]>;

export async function listSiteSitemapParts(db: Queryable): Promise<SiteSitemapParts> {
  const [elections, candidates] = await Promise.all([
    db.query<SitemapRow>(
      `
        SELECT
          ('/elections/' || id::text) AS path,
          updated_at AS lastmod
        FROM public.elections
        ORDER BY updated_at DESC, id ASC
      `
    ),
    db.query<SitemapRow>(
      `
        SELECT
          ('/candidates/' || id::text) AS path,
          updated_at AS lastmod
        FROM public.candidates
        WHERE deleted_at IS NULL
          AND merged_into_candidate_id IS NULL
        ORDER BY updated_at DESC, id ASC
      `
    ),
  ]);

  return {
    pages: SITEMAP_STATIC_PATHS.map((path) => ({ path })),
    elections: elections.rows.map((row) => ({ path: row.path, lastmod: row.lastmod })),
    candidates: candidates.rows.map((row) => ({ path: row.path, lastmod: row.lastmod })),
  };
}

/** Flat list in index order; kept for callers that want every URL at once. */
export async function listSiteSitemapUrls(db: Queryable): Promise<SiteSitemapUrl[]> {
  const parts = await listSiteSitemapParts(db);
  return SITEMAP_PARTS.flatMap((part) => parts[part]);
}

function newestLastmod(urls: readonly SiteSitemapUrl[]): string | null {
  let newest: string | null = null;
  for (const url of urls) {
    const lastmod = formatLastmod(url.lastmod);
    if (lastmod && (newest === null || lastmod > newest)) {
      newest = lastmod;
    }
  }
  return newest;
}

type SitemapFiles = {
  index: string;
  children: Map<string, string>;
};

export function buildSitemapFiles(input: { siteOrigin: string; parts: SiteSitemapParts; pageSize?: number }): SitemapFiles {
  const pageSize = input.pageSize ?? SITEMAP_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50_000) {
    throw new Error(`sitemap page size must be an integer between 1 and 50,000: ${pageSize}`);
  }
  const children = new Map<string, string>();
  const indexEntries: SiteSitemapUrl[] = [];
  for (const part of SITEMAP_PARTS) {
    const urls = input.parts[part];
    // An empty part still gets one (empty) child so its URL never 404s
    // while listed nowhere — simpler for anyone who bookmarked it.
    const pageCount = Math.max(1, Math.ceil(urls.length / pageSize));
    for (let page = 1; page <= pageCount; page += 1) {
      const slice = urls.slice((page - 1) * pageSize, page * pageSize);
      const path = sitemapSelectionPath({ part, page });
      children.set(path, buildSiteSitemapXml({ siteOrigin: input.siteOrigin, urls: slice }));
      indexEntries.push({ path, lastmod: newestLastmod(slice) });
    }
  }
  return {
    index: buildSitemapIndexXml({ siteOrigin: input.siteOrigin, sitemaps: indexEntries }),
    children,
  };
}

export type GetSitemapXml = (selection?: SitemapSelection | null) => Promise<string | null>;

/**
 * No selection → the sitemap index. A selection → that child file, or null
 * when the page is past the end (the API turns null into a 404). All files
 * come from one DB snapshot per TTL, so the index never lists a page the
 * children do not have.
 */
export function createCachedSiteSitemap(options: CachedSiteSitemapOptions): GetSitemapXml {
  const ttlMs = options.ttlMs ?? DEFAULT_SITE_SITEMAP_CACHE_TTL_MS;
  const siteOrigin = normalizeSiteOrigin(options.siteOrigin);
  const now = options.now ?? (() => Date.now());
  let cachedFiles: SitemapFiles | null = null;
  let cachedUntil = 0;
  let inFlight: Promise<SitemapFiles> | null = null;

  async function loadFiles(): Promise<SitemapFiles> {
    const currentTime = now();
    if (cachedFiles && currentTime < cachedUntil) {
      return cachedFiles;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      const parts = await listSiteSitemapParts(options.db);
      const files = buildSitemapFiles({ siteOrigin, parts, pageSize: options.pageSize });
      cachedFiles = files;
      cachedUntil = now() + ttlMs;
      return files;
    })();

    try {
      return await inFlight;
    } catch (error) {
      if (cachedFiles) {
        return cachedFiles;
      }
      throw error;
    } finally {
      inFlight = null;
    }
  }

  return async (selection) => {
    const files = await loadFiles();
    if (!selection) {
      return files.index;
    }
    return files.children.get(sitemapSelectionPath(selection)) ?? null;
  };
}
