import { Pool } from "pg";
import { INDEXNOW_PUBLIC_KEY_PATH } from "../api/apiValidation.js";
import { listSiteSitemapUrls, normalizeSiteOrigin } from "../pipeline/sitemap/siteSitemap.js";

/**
 * Submits the site's URLs to IndexNow (api.indexnow.org), which fans out to
 * Bing, Yandex, Naver, Seznam, and Yep. Bing's index is what ChatGPT search
 * and Microsoft Copilot answer from, so a page Bing has not crawled cannot
 * be cited there; IndexNow tells Bing about changed pages the moment they
 * change instead of waiting weeks for a recrawl of a 55,000-URL sitemap.
 *
 * Usage (backend/):
 *   INDEXNOW_KEY=… SITE_ORIGIN=https://electionssimplified.com \
 *     npm run indexnow:submit -- --since 2026-09-20      # pages changed since
 *   npm run indexnow:submit -- --all                    # every sitemap URL
 *   npm run indexnow:submit -- --since 2026-09-20 --dry-run
 *
 * The key must match what https://<host>/indexnow-key.txt serves (the edge
 * Worker maps it onto GET /api/indexnow-key.txt; same INDEXNOW_KEY env on
 * the API service): IndexNow fetches that URL to prove the submitter owns
 * the host, and the root location is what lets it vouch for every page. Batches of 10,000 URLs per request,
 * the protocol's cap. A 200/202 means accepted; 422 means a URL is not on
 * the host; 403 means the key file did not match; 429 means slow down.
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_BATCH_SIZE = 10_000;

export type IndexNowArgs = { since: string | null; all: boolean; dryRun: boolean };

export function parseIndexNowArgs(argv: readonly string[]): IndexNowArgs {
  const args: IndexNowArgs = { since: null, all: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--since") {
      const value = argv[index + 1];
      // Shape AND calendar validity: "2026-99-99" matches the shape but
      // parses to NaN, which would silently select every dated URL; a
      // "2026-02-30" parses but rolls over to March, so it must round-trip.
      const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error("--since needs a real YYYY-MM-DD date");
      }
      args.since = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.all === (args.since !== null)) {
    throw new Error("Pass exactly one of --all or --since YYYY-MM-DD");
  }
  return args;
}

/** Sitemap URLs to submit: everything, or only rows modified on/after `since`. */
export function selectIndexNowUrls(
  urls: readonly { path: string; lastmod?: string | Date | null }[],
  siteOrigin: string,
  since: string | null
): string[] {
  const origin = normalizeSiteOrigin(siteOrigin);
  const cutoff = since ? new Date(`${since}T00:00:00Z`).getTime() : null;
  const selected: string[] = [];
  for (const url of urls) {
    if (cutoff !== null) {
      // Static pages carry no lastmod; they only go out with --all.
      if (!url.lastmod) {
        continue;
      }
      const modified = new Date(url.lastmod).getTime();
      if (Number.isNaN(modified) || modified < cutoff) {
        continue;
      }
    }
    selected.push(new URL(url.path, `${origin}/`).toString());
  }
  return selected;
}

export function buildIndexNowPayload(input: { siteOrigin: string; key: string; urlList: readonly string[] }) {
  const origin = normalizeSiteOrigin(input.siteOrigin);
  return {
    host: new URL(origin).host,
    key: input.key,
    // Root, not /api/: a key file only vouches for URLs under its own
    // directory, and every page we submit lives at the root.
    keyLocation: `${origin}${INDEXNOW_PUBLIC_KEY_PATH}`,
    urlList: [...input.urlList],
  };
}

async function main(): Promise<void> {
  const args = parseIndexNowArgs(process.argv.slice(2));
  const key = process.env.INDEXNOW_KEY?.trim();
  const siteOrigin = process.env.SITE_ORIGIN?.trim();
  if (!key) {
    throw new Error("INDEXNOW_KEY is unset (must equal the key the API serves at /api/indexnow-key.txt)");
  }
  if (!siteOrigin) {
    throw new Error("SITE_ORIGIN is unset");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const urls = selectIndexNowUrls(await listSiteSitemapUrls(pool), siteOrigin, args.since);
    console.log(`${urls.length} URL(s) selected${args.since ? ` (modified since ${args.since})` : ""}`);
    if (urls.length === 0) {
      return;
    }
    for (let start = 0; start < urls.length; start += INDEXNOW_BATCH_SIZE) {
      const batch = urls.slice(start, start + INDEXNOW_BATCH_SIZE);
      const payload = buildIndexNowPayload({ siteOrigin, key, urlList: batch });
      if (args.dryRun) {
        console.log(`[dry-run] would submit ${batch.length} URL(s); first: ${batch[0]}`);
        continue;
      }
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      console.log(`submitted ${batch.length} URL(s): HTTP ${response.status}`);
      if (response.status === 429) {
        throw new Error("IndexNow answered 429 (too many requests); rerun later with --since");
      }
      if (response.status >= 400) {
        throw new Error(`IndexNow rejected the batch: HTTP ${response.status} ${await response.text()}`);
      }
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("indexNowSubmit.ts") || process.argv[1]?.endsWith("indexNowSubmit.js");
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
