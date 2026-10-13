import { parse as parseYaml } from "yaml";

// SFEC publishes its reconciled dashboard data as YAML frontmatter in the
// GitHub repository that also builds campaign.sfethics.org (GitHub Pages
// serves the site straight from the repo). The repo name is period-scoped
// ("dashboards-2025") and will roll over for future cycles, so it stays
// configurable rather than hardcoded at call sites.
export const SAN_FRANCISCO_DASHBOARD_DEFAULT_REPO = "sfethics/dashboards-2025";
export const SAN_FRANCISCO_DASHBOARD_DEFAULT_BRANCH = "main";
const DEFAULT_TIMEOUT_MS = 30_000;

export type SanFranciscoDashboardManifestClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryCount?: number;
  repo?: string;
  branch?: string;
};

export type SanFranciscoManifestCandidate = {
  filerNid: string;
  fppcId: string;
  committeeName: string;
  candidateName: string;
  /** Reconciled dashboard "funds" total, in cents. */
  fundsCents: number;
  /** Reconciled dashboard "expenses" total, in cents. */
  expensesCents: number;
};

export type SanFranciscoManifestOutsideRelation = {
  /** Target candidate as named in the manifest. */
  candidateName: string;
  /** Target candidate's controlled-committee FPPC id, when the manifest has one. */
  candidateFppcId: string | null;
  position: "support" | "oppose";
  /** Spender committee FPPC id; null when the manifest entry has none. */
  spenderFppcId: string | null;
  spenderName: string;
  /**
   * The dashboard attributes each relation's money to the committee's
   * "expenses" figure (verified: per-candidate support/oppose sums of these
   * match the rendered dashboard to the cent). In cents.
   */
  amountCents: number;
};

export type SanFranciscoContestManifest = {
  electionDate: string;
  contestCode: string;
  title: string;
  candidates: SanFranciscoManifestCandidate[];
  outsideRelations: SanFranciscoManifestOutsideRelation[];
  sourceUrl: string;
  /**
   * Sorted union of the frontmatter keys seen at each level
   * ("top:…|candidate:…|ie_candidate:…|ie_committee:…"). Recorded with every
   * parse so upstream schema drift shows up in diagnostics — added or renamed
   * keys change this string before they change behavior.
   */
  schemaFingerprint: string;
};

export function defaultSanFranciscoDashboardManifestClientOptions(): SanFranciscoDashboardManifestClientOptions {
  const repo = process.env.SAN_FRANCISCO_DASHBOARD_REPO?.trim();
  const branch = process.env.SAN_FRANCISCO_DASHBOARD_BRANCH?.trim();
  return {
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprintLevel(prefix: string, rows: unknown[]): string {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    for (const key of Object.keys(row)) keys.add(key);
  }
  return `${prefix}:${[...keys].sort().join(",")}`;
}

function requiredString(
  row: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = row[key];
  const result =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  if (!result)
    throw new Error(
      `San Francisco dashboard manifest ${context} is missing ${key}`,
    );
  return result;
}

function optionalId(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  const result =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  if (value === undefined || value === null || value === "") return null;
  if (!/^\d{4,12}$/.test(result))
    throw new Error(`San Francisco dashboard manifest has an invalid ${key}`);
  return result;
}

// Manifest money values are decimal dollars written by SFEC's own pipeline.
// Convert to integer cents immediately so every downstream comparison is
// exact instead of accumulating float error.
function requiredCents(
  row: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(
      `San Francisco dashboard manifest ${context} has a non-money ${key}: ${String(value)}`,
    );
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-6)
    throw new Error(
      `San Francisco dashboard manifest ${context} has a non-money ${key}`,
    );
  return cents;
}

export function parseSanFranciscoContestManifest(input: {
  markdown: string;
  electionDate: string;
  contestCode: string;
  sourceUrl: string;
}): SanFranciscoContestManifest {
  // Contest files are Jekyll pages: YAML frontmatter between "---" fences,
  // with no meaningful body. Parse only the first fenced block.
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input.markdown);
  if (!match)
    throw new Error(
      "San Francisco dashboard manifest has no YAML frontmatter block",
    );
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!);
  } catch (error) {
    throw new Error(
      `San Francisco dashboard manifest frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(frontmatter))
    throw new Error(
      "San Francisco dashboard manifest frontmatter is not a mapping",
    );
  if (frontmatter.election !== input.electionDate)
    throw new Error(
      "San Francisco dashboard manifest election does not match request",
    );
  const title =
    typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  if (!title)
    throw new Error("San Francisco dashboard manifest is missing title");
  if (
    !Array.isArray(frontmatter.candidates) ||
    frontmatter.candidates.length === 0
  )
    throw new Error("San Francisco dashboard manifest contains no candidates");
  const candidates: SanFranciscoManifestCandidate[] = [];
  for (const raw of frontmatter.candidates) {
    if (!isPlainObject(raw))
      throw new Error(
        "San Francisco dashboard manifest candidate entry is not a mapping",
      );
    const candidateName = requiredString(raw, "candidate_name", "candidate");
    const fppcId = optionalId(raw, "filer_id");
    const filerNid = optionalId(raw, "filer_nid");
    if (!fppcId || !filerNid)
      throw new Error(
        `San Francisco dashboard manifest candidate ${candidateName} is missing committee identity`,
      );
    candidates.push({
      filerNid,
      fppcId,
      committeeName: requiredString(raw, "committee_name", "candidate"),
      candidateName,
      fundsCents: requiredCents(raw, "funds", `candidate ${candidateName}`),
      expensesCents: requiredCents(
        raw,
        "expenses",
        `candidate ${candidateName}`,
      ),
    });
  }
  // An absent/null field cannot distinguish no spending from an incomplete
  // publication. Only an explicit list (including []) establishes this scope.
  const outsideRelations: SanFranciscoManifestOutsideRelation[] = [];
  const ieCandidates = frontmatter.ie_candidates;
  if (!Array.isArray(ieCandidates))
    throw new Error(
      "San Francisco dashboard manifest ie_candidates is not a list",
    );
  for (const raw of ieCandidates) {
    if (!isPlainObject(raw))
      throw new Error(
        "San Francisco dashboard manifest ie_candidates entry is not a mapping",
      );
    const candidateName = requiredString(
      raw,
      "candidate_name",
      "ie_candidates",
    );
    const candidateFppcId = optionalId(raw, "filer_id");
    if (!Array.isArray(raw.committees))
      throw new Error(
        `San Francisco dashboard manifest ie_candidates ${candidateName} has no committees list`,
      );
    for (const committee of raw.committees) {
      if (!isPlainObject(committee))
        throw new Error(
          "San Francisco dashboard manifest outside committee entry is not a mapping",
        );
      const positionRaw = requiredString(
        committee,
        "position",
        "outside committee",
      ).toLowerCase();
      if (positionRaw !== "support" && positionRaw !== "oppose")
        throw new Error(
          `San Francisco dashboard manifest outside committee has unknown position: ${positionRaw}`,
        );
      const spenderName = requiredString(
        committee,
        "committee_name",
        "outside committee",
      );
      outsideRelations.push({
        candidateName,
        candidateFppcId,
        position: positionRaw,
        // An absent committee id is supported; callers derive a synthetic
        // reported-name identity. A malformed supplied id is rejected above.
        spenderFppcId: optionalId(committee, "filer_id"),
        spenderName,
        amountCents: requiredCents(
          committee,
          "expenses",
          `outside committee ${spenderName}`,
        ),
      });
    }
  }
  const schemaFingerprint = [
    fingerprintLevel("top", [frontmatter]),
    fingerprintLevel("candidate", frontmatter.candidates),
    fingerprintLevel("ie_candidate", ieCandidates),
    fingerprintLevel(
      "ie_committee",
      ieCandidates.flatMap((entry) =>
        isPlainObject(entry) && Array.isArray(entry.committees)
          ? entry.committees
          : [],
      ),
    ),
  ].join("|");
  return {
    electionDate: input.electionDate,
    contestCode: input.contestCode,
    title,
    candidates,
    outsideRelations,
    sourceUrl: input.sourceUrl,
    schemaFingerprint,
  };
}

function validatedManifestPath(input: {
  electionDate: string;
  contestCode: string;
  repo?: string;
  branch?: string;
}): { repo: string; branch: string; path: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.electionDate))
    throw new Error(
      `Invalid San Francisco dashboard election date: ${input.electionDate}`,
    );
  if (!/^[a-z0-9]{2,20}$/.test(input.contestCode))
    throw new Error(
      `Invalid San Francisco dashboard contest code: ${input.contestCode}`,
    );
  const repo = input.repo ?? SAN_FRANCISCO_DASHBOARD_DEFAULT_REPO;
  const branch = input.branch ?? SAN_FRANCISCO_DASHBOARD_DEFAULT_BRANCH;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`Invalid San Francisco dashboard repo: ${repo}`);
  if (!/^[\w.-]+$/.test(branch))
    throw new Error(`Invalid San Francisco dashboard branch: ${branch}`);
  return {
    repo,
    branch,
    path: `elections/${input.electionDate}/contests/${input.contestCode}.md`,
  };
}

export function buildSanFranciscoContestManifestUrl(input: {
  electionDate: string;
  contestCode: string;
  repo?: string;
  branch?: string;
}): string {
  const { repo, branch, path } = validatedManifestPath(input);
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

/**
 * Fallback fetch URL: the GitHub contents API serves the identical bytes
 * (verified 2026-08-06) through a separate service path from the raw host,
 * and follows repository renames. The rendered campaign.sfethics.org site
 * cannot be the fallback the plan first suggested — GitHub Pages runs the
 * markdown through Jekyll, serves HTML only, and 404s the `.md` path
 * (verified live), so it can never feed this parser.
 */
export function buildSanFranciscoContestManifestApiUrl(input: {
  electionDate: string;
  contestCode: string;
  repo?: string;
  branch?: string;
}): string {
  const { repo, branch, path } = validatedManifestPath(input);
  return `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
}

async function fetchText(
  url: string,
  options: SanFranciscoDashboardManifestClientOptions,
  accept: string,
): Promise<string> {
  const retries = options.retryCount ?? 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { accept },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < retries
        )
          continue;
        throw new Error(
          `San Francisco dashboard manifest request failed: ${response.status} ${response.statusText}`,
        );
      }
      return await response.text();
    } catch (error) {
      if (
        attempt < retries &&
        (error instanceof TypeError ||
          (error instanceof Error && error.name === "AbortError"))
      )
        continue;
      if (error instanceof Error && error.name === "AbortError")
        throw new Error(
          `San Francisco dashboard manifest request timed out after ${timeoutMs}ms`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("San Francisco dashboard manifest request exhausted retries");
}

export async function getSanFranciscoContestManifest(
  input: { electionDate: string; contestCode: string },
  options: SanFranciscoDashboardManifestClientOptions = {},
): Promise<SanFranciscoContestManifest> {
  const target = {
    electionDate: input.electionDate,
    contestCode: input.contestCode,
    repo: options.repo,
    branch: options.branch,
  };
  const rawUrl = buildSanFranciscoContestManifestUrl(target);
  let markdown: string;
  let sourceUrl = rawUrl;
  try {
    markdown = await fetchText(rawUrl, options, "text/plain");
  } catch (primaryError) {
    // Fetch fallback only: a parse failure below is never retried through
    // the API, because the API serves the same bytes.
    const apiUrl = buildSanFranciscoContestManifestApiUrl(target);
    try {
      markdown = await fetchText(
        apiUrl,
        options,
        "application/vnd.github.raw+json",
      );
      sourceUrl = apiUrl;
    } catch (fallbackError) {
      throw new Error(
        `San Francisco dashboard manifest fetch failed on both hosts: ${
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError)
        }; fallback: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`,
      );
    }
  }
  return parseSanFranciscoContestManifest({
    markdown,
    electionDate: input.electionDate,
    contestCode: input.contestCode,
    sourceUrl,
  });
}
