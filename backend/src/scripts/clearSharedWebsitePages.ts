import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  isSharedPageWebsiteUrl,
  stripWebsiteUrlsFromCandidate,
  websiteUrlKey,
} from "../pipeline/candidates/candidateProfileIdentity.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

/**
 * Batch cleanup: removes website URLs that are pages listing many people
 * (a county officials directory, an election results page, a court or board
 * roster) from candidates.official_website_url and former_website_urls.
 * Such a page never identified one person, and the profile writer no longer
 * accepts it as a hard identifier; leaving it stored would keep it matching
 * (former_website_urls matches too).
 *
 * A URL is stripped when it matches the shared-page shape check
 * (isSharedPageWebsiteUrl) AND at least --min-rows live rows hold it
 * (default 2), or when it is listed in --urls-file (one URL per line, "#"
 * comments) — the list covers listing pages with opaque paths the shape
 * check cannot see. Personal campaign sites shared by a governor ticket or a
 * slate are never stripped; they are reported under `sharedButKept` for
 * review.
 *
 * Dry run by default; --apply writes, one transaction. --report-file writes
 * the same JSON the run prints.
 *
 * Usage:
 *   npm run manual:candidates:clear-shared-websites -- [--urls-file path] [--min-rows 2] [--report-file out.json]
 *   npm run manual:candidates:clear-shared-websites -- --apply --urls-file path
 */

type CandidateWebsiteRow = {
  id: string;
  display_name: string | null;
  state: string;
  official_website_url: string | null;
  former_website_urls: unknown;
};

export type SharedWebsiteClearPlan = {
  minRows: number;
  rowsScanned: number;
  strippedUrls: {
    url: string;
    reason: "shared_page_pattern" | "listed";
    rows: number;
  }[];
  rowChanges: {
    candidateId: string;
    displayName: string | null;
    state: string;
    website: string | null;
    formerWebsites: string[];
    strippedUrls: string[];
  }[];
  sharedButKept: { url: string; rows: number; candidates: string[] }[];
};

function formerUrls(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

export function planSharedWebsiteClears(
  rows: readonly CandidateWebsiteRow[],
  options: { minRows: number; listedUrls: readonly string[] }
): SharedWebsiteClearPlan {
  const listedKeys = new Set(options.listedUrls.map((url) => websiteUrlKey(url)));
  const holdersByKey = new Map<string, { url: string; candidates: Map<string, string> }>();
  const remember = (row: CandidateWebsiteRow, url: string) => {
    const key = websiteUrlKey(url);
    const entry = holdersByKey.get(key) ?? { url, candidates: new Map<string, string>() };
    entry.candidates.set(row.id, row.display_name ?? `${row.id}`);
    holdersByKey.set(key, entry);
  };
  for (const row of rows) {
    if (row.official_website_url?.trim()) {
      remember(row, row.official_website_url.trim());
    }
    for (const url of formerUrls(row.former_website_urls)) {
      remember(row, url);
    }
  }

  const stripReason = (url: string): "shared_page_pattern" | "listed" | null => {
    const key = websiteUrlKey(url);
    if (listedKeys.has(key)) {
      return "listed";
    }
    const holders = holdersByKey.get(key)?.candidates.size ?? 0;
    return isSharedPageWebsiteUrl(url) && holders >= options.minRows ? "shared_page_pattern" : null;
  };

  const strippedByKey = new Map<string, SharedWebsiteClearPlan["strippedUrls"][number]>();
  const rowChanges: SharedWebsiteClearPlan["rowChanges"] = [];
  for (const row of rows) {
    const result = stripWebsiteUrlsFromCandidate({
      storedWebsite: row.official_website_url,
      storedFormerWebsites: formerUrls(row.former_website_urls),
      shouldStrip: (url) => stripReason(url) !== null,
    });
    if (!result.changed) {
      continue;
    }
    for (const url of result.strippedUrls) {
      const key = websiteUrlKey(url);
      const entry = strippedByKey.get(key) ?? {
        url: holdersByKey.get(key)?.url ?? url,
        reason: stripReason(url) ?? "listed",
        rows: 0,
      };
      entry.rows += 1;
      strippedByKey.set(key, entry);
    }
    rowChanges.push({
      candidateId: row.id,
      displayName: row.display_name,
      state: row.state,
      website: result.website,
      formerWebsites: result.formerWebsites,
      strippedUrls: result.strippedUrls,
    });
  }

  const sharedButKept: SharedWebsiteClearPlan["sharedButKept"] = [];
  for (const [key, entry] of holdersByKey) {
    if (entry.candidates.size >= 2 && !strippedByKey.has(key)) {
      sharedButKept.push({
        url: entry.url,
        rows: entry.candidates.size,
        candidates: [...entry.candidates.values()].sort(),
      });
    }
  }
  sharedButKept.sort((a, b) => b.rows - a.rows || a.url.localeCompare(b.url));

  return {
    minRows: options.minRows,
    rowsScanned: rows.length,
    strippedUrls: [...strippedByKey.values()].sort((a, b) => b.rows - a.rows || a.url.localeCompare(b.url)),
    rowChanges,
    sharedButKept,
  };
}

function readFlagValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1] ?? null;
  }
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  return withEquals ? withEquals.slice(name.length + 1) : null;
}

async function readUrlsFile(path: string | null): Promise<string[]> {
  if (!path) {
    return [];
  }
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("manual:candidates:clear-shared-websites", argv, [
    { name: "--apply", value: "none" },
    { name: "--min-rows", value: "space" },
    { name: "--urls-file", value: "space" },
    { name: "--report-file", value: "space" },
  ]);
  loadProjectEnv();
  const apply = argv.includes("--apply");
  const minRowsRaw = readFlagValue(argv, "--min-rows");
  const minRows = minRowsRaw ? Number.parseInt(minRowsRaw, 10) : 2;
  if (!Number.isInteger(minRows) || minRows < 1) {
    throw new Error(`--min-rows must be a positive integer, got ${minRowsRaw}`);
  }
  const listedUrls = await readUrlsFile(readFlagValue(argv, "--urls-file"));
  const reportFile = readFlagValue(argv, "--report-file");

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (apply) {
    requireLocalDatabaseTarget(databaseUrl);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const rows = await pool.query<CandidateWebsiteRow>(
      `SELECT id, display_name, state, official_website_url, former_website_urls
         FROM public.candidates
        WHERE deleted_at IS NULL
          AND (official_website_url IS NOT NULL OR jsonb_typeof(former_website_urls) = 'array')
        ORDER BY state, display_name`
    );
    const plan = planSharedWebsiteClears(rows.rows, { minRows, listedUrls });

    let updatedRows = 0;
    if (apply) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const change of plan.rowChanges) {
          const result = await client.query(
            `UPDATE public.candidates
                SET official_website_url = $2,
                    former_website_urls = $3::jsonb,
                    updated_at = now()
              WHERE id = $1
                AND deleted_at IS NULL`,
            [
              change.candidateId,
              change.website,
              change.formerWebsites.length > 0 ? JSON.stringify(change.formerWebsites) : null,
            ]
          );
          updatedRows += result.rowCount ?? 0;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    const report = {
      mode: apply ? "apply" : "dry-run",
      minRows: plan.minRows,
      listedUrls: listedUrls.length,
      rowsScanned: plan.rowsScanned,
      strippedUrlCount: plan.strippedUrls.length,
      changedRows: apply ? updatedRows : plan.rowChanges.length,
      strippedUrls: plan.strippedUrls,
      sharedButKept: plan.sharedButKept,
      rowChanges: plan.rowChanges,
    };
    const json = JSON.stringify(report, null, 2);
    if (reportFile) {
      await writeFile(reportFile, json);
    }
    // The row list is long; print the summary and the URL tables only.
    console.log(JSON.stringify({ ...report, rowChanges: undefined, rowChangeCount: plan.rowChanges.length }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("clearSharedWebsitePages.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
