import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  buildSanFranciscoContestManifestUrl,
  type SanFranciscoDashboardManifestClientOptions,
  type SanFranciscoManifestCandidate,
} from "./sanFranciscoDashboardManifestClient.js";

export type SanFranciscoCommitteePublicFunds = {
  fppcId: string;
  filerNid: string;
  electionDate: string;
  candidateName: string;
  committeeName: string;
  contributionCents: number;
  expenditureCents: number;
  publicFundsCents: number;
  sourceUrl: string;
  sha256: string;
};
const key = (x: unknown) =>
  typeof x === "string" ? x.trim().replace(/\s+/g, " ").toUpperCase() : "";
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
function cents(x: unknown): number {
  const s = typeof x === "number" || typeof x === "string" ? String(x) : "";
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error("Invalid San Francisco committee publication amount");
  const n = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(n))
    throw new Error("Unsafe San Francisco committee publication amount");
  return n;
}
export function parseSanFranciscoCommitteePublicFunds(input: {
  markdown: string;
  electionDate: string;
  candidate: SanFranciscoManifestCandidate;
  sourceUrl: string;
}): SanFranciscoCommitteePublicFunds {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input.markdown);
  if (!match)
    throw new Error("Missing San Francisco committee publication frontmatter");
  let raw: unknown;
  try {
    raw = parseYaml(match[1]!);
  } catch {
    throw new Error("Invalid San Francisco committee publication frontmatter");
  }
  if (
    !object(raw) ||
    raw.layout !== "candidate_committee" ||
    raw.committee_type !== "candidate" ||
    raw.election !== input.electionDate ||
    String(raw.filer_id) !== input.candidate.fppcId ||
    String(raw.filer_nid) !== input.candidate.filerNid ||
    !key(raw.candidate_name) ||
    key(raw.candidate_name) !== key(input.candidate.candidateName) ||
    key(raw.filer_name) !== key(input.candidate.committeeName)
  )
    throw new Error("San Francisco committee publication identity mismatch");
  if (
    !Array.isArray(raw.totals) ||
    raw.totals.length !== 2 ||
    !object(raw.pubfi) ||
    raw.pubfi.participant !== "True"
  )
    throw new Error(
      "Missing participating San Francisco committee public-funds metadata",
    );
  const publicFundsCents = cents(raw.pubfi.total);
  if (publicFundsCents <= 0)
    throw new Error(
      "San Francisco committee public-funds fallback requires a positive amount",
    );
  return {
    fppcId: input.candidate.fppcId,
    filerNid: input.candidate.filerNid,
    electionDate: input.electionDate,
    candidateName: String(raw.candidate_name),
    committeeName: String(raw.filer_name),
    contributionCents: cents(raw.totals[0]),
    expenditureCents: cents(raw.totals[1]),
    publicFundsCents,
    sourceUrl: input.sourceUrl,
    sha256: createHash("sha256").update(input.markdown).digest("hex"),
  };
}
export async function getSanFranciscoCommitteePublicFunds(
  input: {
    electionDate: string;
    contestCode: string;
    candidate: SanFranciscoManifestCandidate;
  },
  options: SanFranciscoDashboardManifestClientOptions = {},
): Promise<SanFranciscoCommitteePublicFunds> {
  // Retain the exact receiving account before any source await; no local nickname/alias inference.
  input = structuredClone(input);
  options = { ...options };
  if (
    !/^\d{4,12}$/.test(input.candidate.fppcId) ||
    !/^\d+$/.test(input.candidate.filerNid)
  )
    throw new Error("Invalid San Francisco committee publication account");
  const manifestUrl = buildSanFranciscoContestManifestUrl({
    electionDate: input.electionDate,
    contestCode: input.contestCode,
    repo: options.repo,
    branch: options.branch,
  });
  const sourceUrl = manifestUrl.replace(
    `/contests/${input.contestCode}.md`,
    `/committees/CA${input.candidate.fppcId}.md`,
  );
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error("Invalid San Francisco committee publication timeout");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await (options.fetchImpl ?? fetch)(sourceUrl, {
      headers: { accept: "text/plain" },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        `San Francisco committee publication request failed: ${response.status}`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 4 * 1024 * 1024)
      throw new Error("Invalid San Francisco committee publication size");
    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Invalid San Francisco committee publication encoding");
    }
    const result = parseSanFranciscoCommitteePublicFunds({
      ...input,
      markdown,
      sourceUrl,
    });
    return {
      ...result,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    clearTimeout(timer);
  }
}
