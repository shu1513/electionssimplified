import type { PoolClient } from "pg";

import type { CandidateProfilePayload } from "../../contracts/candidateProfilePayloadContract.js";
import { assertCandidatePartyWillNotBeDiscarded } from "../../ai/candidatePartisanship.js";
import {
  hasNormalizedIntersection,
  normalizeCandidateName,
  normalizeOptionalUrl,
  normalizeTwitterHandle,
} from "../../utils/candidateIdentity.js";
import { normalizeHttpUrl } from "../../utils/normalizeHttpUrl.js";
import { canonicalizeParty } from "./candidatePartyCanonicalization.js";

/**
 * Two or more name-related candidates match the incoming profile's hard
 * identifiers: the data already holds duplicates for this person, and
 * inserting yet another row would compound them. Callers park or surface
 * the profile so an operator can merge the duplicate rows first.
 */
export class AmbiguousCandidateIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousCandidateIdentityError";
  }
}

export type ExistingCandidateRow = {
  id: string;
  first_name: string;
  last_name: string;
  // Present on rows loaded by the identity pool queries; older callers and
  // tests may omit it, so the name comparison falls back to first + last.
  display_name?: string | null;
  date_of_birth: string | null;
  twitter_handle: string | null;
  linkedin_url: string | null;
  official_website_url: string | null;
  former_website_urls: unknown;
  fec_ids: unknown;
  state_filing_ids: unknown;
  current_office: string | null;
  state: string;
};

export type FindOrCreateCandidateFromProfileInput = {
  client: PoolClient;
  profile: CandidateProfilePayload;
  state: string;
  rosterParty: string | undefined;
  includeParty: boolean;
  allowCrossStateHardIdentifierMatch?: boolean;
  // When set, a candidate already linked to this election (directly or as a
  // running mate) with the same display_name is treated as the same person
  // even when no hard identifier matches. Rosters enforce display_name
  // uniqueness per election, so this cannot merge two different people; it
  // prevents duplicate candidates when a re-written profile changes the row's
  // only hard identifier (e.g. swapping a placeholder campaign URL).
  matchByLinkedElectionId?: string;
  // Field names whose non-empty stored values may be REPLACED by the incoming
  // profile (deliberate correction). Everything else keeps fill-if-empty
  // semantics: never overwrite a non-empty stored value.
  overwriteProfileFields?: ReadonlySet<OverwritableProfileField>;
  // Field names whose stored values are set to NULL (deliberate retraction of
  // stale data, e.g. a current_office the person no longer holds). Clearing
  // only applies when an existing candidate matched — there is nothing to
  // clear on an insert — and a field cannot be both cleared and supplied.
  // Manual-wrapper-only; the AI pipeline never passes this.
  clearProfileFields?: ReadonlySet<OverwritableProfileField>;
};

export const OVERWRITABLE_PROFILE_FIELDS = [
  "party",
  "date_of_birth",
  "twitter_handle",
  "linkedin_url",
  // Volatile identifier: campaign sites change when a candidate enters a new
  // race, so the merge REPLACES a differing stored URL with the incoming one
  // by default and archives the old URL in former_website_urls (which still
  // matches as a hard identifier). Listing it under --replace-profile-fields
  // is the correction path for a WRONG stored URL — the stored value is
  // dropped without being archived. --clear-profile-fields drops it without
  // archiving too.
  "official_website_url",
  "summary",
  "current_office",
  // Tri-state routing fact. Fill-if-NULL by default; listing it under
  // --replace-profile-fields is the supported correction path for a stale
  // stored value (the records writers refuse to sweep past a contradiction).
  // Replacing with a payload null is the repair path for a false that was
  // manufactured from office-history-silent sources — the row returns to
  // "unanswered" instead of asserting an unresearched negative. Not listed
  // under --clear-profile-fields: the contract requires an explicit answer,
  // so a retraction travels in the payload, not as a flag-only clear.
  "has_held_public_office",
  // Provenance list. Merged as a UNION of stored + incoming by default: the
  // merge UPDATE keeps stored facts (fill-if-empty scalars, additive id
  // lists), so the sources supporting those surviving facts must survive
  // too — a narrow correction payload must not wipe the row's provenance.
  // Listing it under --replace-profile-fields swaps in exactly the payload's
  // list, the deliberate cleanup path for dead or disallowed stored URLs.
  // Not clearable: the profile contract requires sources on every payload.
  "profile_sources",
] as const;
export type OverwritableProfileField = (typeof OVERWRITABLE_PROFILE_FIELDS)[number];

export type FindOrCreateCandidateFromProfileResult = {
  candidateId: string;
  matchedExisting: boolean;
};

function parseOptionalStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeIdList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function mergeIdentifierLists(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined
): string[] | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of [existing ?? [], incoming ?? []]) {
    for (const value of source) {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(trimmed);
    }
  }

  return merged.length > 0 ? merged : undefined;
}

/**
 * Union of stored and incoming profile sources. Dedupes on the NORMALIZED
 * URL (trailing slash, hash), not the raw string: stored legacy rows predate
 * contract-side normalizeHttpUrl, so "https://a.example/page/" and its
 * normalized twin are the same source. First occurrence wins and stored
 * order comes first, so repeated re-writes are stable.
 *
 * The normalized key keeps its case: URL parsing already lowercases the
 * scheme and hostname — the components that ARE case-insensitive — while
 * paths and queries are case-sensitive per RFC 3986, so "/Bio" and "/bio"
 * may be distinct documents. Collapsing them would silently discard a
 * source, the failure this union exists to prevent; keeping a duplicate
 * URL is harmless and cleanable via --replace-profile-fields. Only the
 * non-URL fallback (legacy stored junk — the contract refuses non-URL
 * incoming sources) compares case-insensitively.
 */
export function mergeProfileSourceLists(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of [existing, incoming]) {
    for (const value of source) {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const key = normalizeHttpUrl(trimmed) ?? trimmed.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(trimmed);
    }
  }

  return merged;
}

export function websiteUrlKey(url: string): string {
  return normalizeOptionalUrl(url) ?? url.toLowerCase();
}

function dedupeWebsiteUrlList(urls: readonly string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = websiteUrlKey(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

function withoutWebsiteUrl(urls: readonly string[], url: string | null): string[] {
  if (!url) {
    return [...urls];
  }
  const key = websiteUrlKey(url);
  return urls.filter((candidate) => websiteUrlKey(candidate) !== key);
}

/**
 * official_website_url is the one hard identifier that legitimately CHANGES:
 * candidates stand up a new campaign site per race. So unlike every other
 * scalar (fill-if-empty), a differing incoming URL replaces the stored one by
 * default, and the replaced URL is archived in former_website_urls — where it
 * keeps matching as a hard identifier, so a payload carrying either the old
 * or the new site resolves to the same person.
 *
 * An incoming URL that is already ARCHIVED does not rotate back in: the
 * archive only holds URLs a later write displaced, so such a payload is a
 * stale replay (retried job, re-run research file) — it matches the person
 * but the stored, newer site is kept. A genuine return to an archived URL
 * takes --replace-profile-fields official_website_url.
 *
 * The explicit flags keep their correction semantics: --replace-profile-fields
 * swaps in the incoming URL WITHOUT archiving the stored one (the stored value
 * was wrong, and archiving a wrong URL would poison future matching);
 * --clear-profile-fields drops the stored URL without archiving for the same
 * reason. The former list is deduped on the normalized URL and never contains
 * the current URL.
 */
export function resolveWebsiteRotationOnMerge(input: {
  storedWebsite: string | null | undefined;
  storedFormerWebsites: readonly string[];
  incomingWebsite: string | null | undefined;
  overwrite: boolean;
  clear: boolean;
}): { website: string | null; formerWebsites: string[] } {
  const stored = input.storedWebsite?.trim() || null;
  const incoming = input.incomingWebsite?.trim() || null;
  const storedFormer = dedupeWebsiteUrlList(input.storedFormerWebsites);

  if (input.clear) {
    return { website: null, formerWebsites: storedFormer };
  }
  if (input.overwrite && incoming) {
    return { website: incoming, formerWebsites: withoutWebsiteUrl(storedFormer, incoming) };
  }
  if (!stored) {
    return { website: incoming, formerWebsites: withoutWebsiteUrl(storedFormer, incoming) };
  }
  if (incoming && normalizeOptionalUrl(incoming) !== normalizeOptionalUrl(stored)) {
    // An incoming URL that sits in the archive proves IDENTITY, not
    // freshness: a URL is only archived because a later write displaced it,
    // so a payload carrying it (a retried job, a re-run of an old research
    // file) is older than the row. Rotating it back in would silently revert
    // the newer site — keep the stored one. A candidate who genuinely
    // returned to an archived URL goes through --replace-profile-fields
    // official_website_url.
    const incomingKey = websiteUrlKey(incoming);
    if (storedFormer.some((url) => websiteUrlKey(url) === incomingKey)) {
      return { website: stored, formerWebsites: storedFormer };
    }
    return {
      website: incoming,
      formerWebsites: withoutWebsiteUrl(dedupeWebsiteUrlList([...storedFormer, stored]), incoming),
    };
  }
  return { website: stored, formerWebsites: storedFormer };
}

/**
 * Duplicate-row merge (manual:candidates:merge): the duplicate's current and
 * former websites join the survivor's archive so they keep identifying the
 * person after the duplicate row is gone — losing them would undo exactly the
 * identity work the merge encodes. The survivor's EFFECTIVE current website
 * (which may have been filled from the duplicate) never appears in the list.
 */
export function unionFormerWebsiteUrls(input: {
  survivorCurrentWebsite: string | null;
  survivorFormerWebsites: readonly string[];
  duplicateCurrentWebsite: string | null;
  duplicateFormerWebsites: readonly string[];
}): string[] {
  return withoutWebsiteUrl(
    dedupeWebsiteUrlList([
      ...input.survivorFormerWebsites,
      ...input.duplicateFormerWebsites,
      ...(input.duplicateCurrentWebsite ? [input.duplicateCurrentWebsite] : []),
    ]),
    input.survivorCurrentWebsite
  );
}

function haveSameNormalizedIdentifierSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  const leftSet = new Set(normalizeIdList(left));
  const rightSet = new Set(normalizeIdList(right));
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  for (const value of leftSet) {
    if (!rightSet.has(value)) {
      return false;
    }
  }
  return true;
}

// Words that mark a page listing MANY people rather than one person's own
// site: an elected-officials directory, an election results page, a court or
// board roster. Matched as whole words of the last meaningful path segment
// (plus the query string), so a legislator's own member page under
// ".../Members/Details/<slug>" is not caught while ".../Members/Index" is.
const SHARED_PAGE_WHOLE_WORDS = new Set([
  "alderman",
  "aldermen",
  "ballot",
  "ballots",
  "bench",
  "biographies",
  "board",
  "boe",
  "commission",
  "council",
  "court",
  "courts",
  "department",
  "departments",
  "election",
  "elections",
  "government",
  "guide",
  "justice",
  "leadership",
  "legislators",
  "list",
  "officeholders",
  "qualifying",
  "results",
  "selectmen",
  "staff",
  "supervisors",
  "tracker",
  "trustees",
]);
// Longer tokens that identify a listing even when glued to other words
// ("CandidateFilingResults", "JudicialDirectory", "countyfilings").
// "members" (not "member": a legislator's own page is ".../Member?district="),
// "officials" (not "official": ".../official-biography" is one person's page).
const SHARED_PAGE_SUBSTRINGS = [
  "candidate",
  "commissioner",
  "constable",
  "directory",
  "elected",
  "filings",
  "judges",
  "judicial",
  "judiciary",
  "justices",
  "magistrate",
  "members",
  "officials",
  "roster",
];
// Segments that only point at a document inside a folder; the folder name
// carries the meaning ("elections_administration/index.php").
const SHARED_PAGE_INDEX_SEGMENTS = new Set(["index", "default", "page", "pages", "view", "home"]);

function sharedPageSegmentWords(segment: string): string[] {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return decoded
    .toLowerCase()
    .replace(/\.(html?|aspx?|php|jsp|pdf|shtml|cfm|cms)$/i, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function wordsMarkSharedPage(words: readonly string[]): boolean {
  return words.some(
    (word) =>
      SHARED_PAGE_WHOLE_WORDS.has(word) || SHARED_PAGE_SUBSTRINGS.some((token) => word.includes(token))
  );
}

/**
 * A page that lists many people — a county officials directory, an election
 * results page, a court or board roster, a candidate list — is not one
 * person's own website, so it must never identify a candidate row. On the
 * local data 371 such URLs sat on two or more live rows each (a Tarrant
 * County officials page on 39 rows; a Maryland primary results page on 22).
 *
 * The check reads the URL's shape only: the last meaningful path segment
 * (skipping bare numbers, one-letter segments and index documents) plus the
 * query string must carry a listing word. Personal campaign sites have none.
 * A bare host is never flagged, whatever its domain: "clyburn.house.gov" is
 * one person's official site, and 242 local rows store such a site. A
 * listing page with an opaque path (".../bcityj.html") or a bare shared
 * root ("nacogdochesco.gov") slips through here and is caught by the
 * stored-holder check instead (assessWebsiteIdentifier).
 */
export function isSharedPageWebsiteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const words = sharedPageSegmentWords(segments[index]!);
    const meaningful = words.filter((word) => !/^\d+$/.test(word) && word.length > 1);
    if (meaningful.length === 0) {
      continue;
    }
    if (meaningful.length === 1 && SHARED_PAGE_INDEX_SEGMENTS.has(meaningful[0]!)) {
      continue;
    }
    if (wordsMarkSharedPage(words)) {
      return true;
    }
    break;
  }
  const queryWords: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    queryWords.push(...sharedPageSegmentWords(key), ...sharedPageSegmentWords(value));
  }
  return wordsMarkSharedPage(queryWords);
}

function rowWebsiteKeys(row: Pick<ExistingCandidateRow, "official_website_url" | "former_website_urls">): string[] {
  const keys: string[] = [];
  if (row.official_website_url) {
    keys.push(websiteUrlKey(row.official_website_url));
  }
  for (const formerUrl of parseOptionalStringArray(row.former_website_urls)) {
    keys.push(websiteUrlKey(formerUrl));
  }
  return keys;
}

function rowHasSameNormalizedName(profile: CandidateProfilePayload, row: ExistingCandidateRow): boolean {
  if (isExactNameMatch(profile, row)) {
    return true;
  }
  const rowDisplayName = row.display_name?.trim();
  return Boolean(
    rowDisplayName && normalizeCandidateName(rowDisplayName) === normalizeCandidateName(profile.display_name)
  );
}

export type WebsiteIdentifierAssessment = {
  url: string | null;
  usable: boolean;
  reason: "shared_page" | "held_by_other_candidate" | null;
  // Live rows under a different normalized name that already carry the URL
  // (current or former). Empty unless reason is held_by_other_candidate.
  holders: { id: string; displayName: string }[];
};

/**
 * Decides whether the payload's official_website_url may act as a hard
 * identifier. It may not when (a) it matches a shared-page pattern
 * (isSharedPageWebsiteUrl) or (b) a live row under a DIFFERENT normalized
 * name already stores it as its current or former website — a URL two
 * people share cannot single out either of them. `rows` is the identity
 * pool, which loadNameRelatedCandidates widens to include every holder of
 * the incoming URL for exactly this check.
 */
export function assessWebsiteIdentifier(
  profile: CandidateProfilePayload,
  rows: readonly ExistingCandidateRow[]
): WebsiteIdentifierAssessment {
  const url = profile.official_website_url?.trim() || null;
  const incomingKey = url ? normalizeOptionalUrl(url) : null;
  if (!url || !incomingKey) {
    return { url, usable: false, reason: null, holders: [] };
  }
  if (isSharedPageWebsiteUrl(url)) {
    return { url, usable: false, reason: "shared_page", holders: [] };
  }
  const holders = rows
    .filter((row) => rowWebsiteKeys(row).includes(incomingKey) && !rowHasSameNormalizedName(profile, row))
    .map((row) => ({ id: row.id, displayName: row.display_name?.trim() || `${row.first_name} ${row.last_name}` }));
  if (holders.length > 0) {
    return { url, usable: false, reason: "held_by_other_candidate", holders };
  }
  return { url, usable: true, reason: null, holders: [] };
}

export function describeUnusableWebsiteIdentifier(assessment: WebsiteIdentifierAssessment): string | null {
  if (assessment.usable || !assessment.reason) {
    return null;
  }
  const detail =
    assessment.reason === "shared_page"
      ? "it looks like a page that lists many people (an officials directory, election results, a court or board roster)"
      : `it is already stored on ${assessment.holders.length} other candidate row(s) under a different name: ${assessment.holders
          .slice(0, 5)
          .map((holder) => `${holder.displayName} (${holder.id})`)
          .join(", ")}${assessment.holders.length > 5 ? ", ..." : ""}`;
  return `official_website_url ${assessment.url} cannot serve as a hard identifier: ${detail}. Use the candidate's own site, a filing id (roster fec_ids or state_filing_ids), or pass --allow-no-hard-identifier deliberately.`;
}

/**
 * Loads the identity pool for the payload and runs assessWebsiteIdentifier
 * against it — the read-only form the manual writers use to refuse a write
 * before opening a transaction.
 */
export async function assessWebsiteIdentifierAgainstDatabase(
  client: Pick<PoolClient, "query">,
  profile: CandidateProfilePayload,
  scope: { state: string; allowCrossStateHardIdentifierMatch?: boolean }
): Promise<WebsiteIdentifierAssessment> {
  const rows = scope.allowCrossStateHardIdentifierMatch
    ? await loadNameRelatedCandidatesAcrossStates(client, profile)
    : await loadNameRelatedCandidates(client, profile, scope.state);
  return assessWebsiteIdentifier(profile, rows);
}

/**
 * Removes every website (current or former) that `shouldStrip` flags from a
 * stored row, using the same URL keys the merge path uses. Nothing is
 * archived: a shared page never identified the person, so keeping it in
 * former_website_urls would let it keep matching. Serves the batch cleanup
 * script (manual:candidates:clear-shared-websites).
 */
export function stripWebsiteUrlsFromCandidate(input: {
  storedWebsite: string | null | undefined;
  storedFormerWebsites: readonly string[];
  shouldStrip: (url: string) => boolean;
}): { website: string | null; formerWebsites: string[]; strippedUrls: string[]; changed: boolean } {
  const stored = input.storedWebsite?.trim() || null;
  const storedFormer = dedupeWebsiteUrlList(input.storedFormerWebsites);
  const strippedUrls: string[] = [];
  let website = stored;
  if (stored && input.shouldStrip(stored)) {
    strippedUrls.push(stored);
    website = null;
  }
  const formerWebsites = storedFormer.filter((url) => {
    if (input.shouldStrip(url)) {
      strippedUrls.push(url);
      return false;
    }
    return true;
  });
  const changed =
    website !== stored ||
    formerWebsites.length !== storedFormer.length ||
    formerWebsites.length !== input.storedFormerWebsites.length;
  return { website, formerWebsites: withoutWebsiteUrl(formerWebsites, website), strippedUrls, changed };
}

export function hasAtLeastOneHardIdentifier(
  profile: CandidateProfilePayload,
  options: { websiteCountsAsIdentifier?: boolean } = {}
): boolean {
  const hasFec = (profile.fec_ids?.length ?? 0) > 0;
  const hasStateFiling = (profile.state_filing_ids?.length ?? 0) > 0;
  const website = profile.official_website_url?.trim() || null;
  // Default: a website counts unless its shape says it lists many people.
  // Callers that consulted the database pass the assessed answer instead.
  const websiteCounts =
    options.websiteCountsAsIdentifier ?? Boolean(website && !isSharedPageWebsiteUrl(website));
  const hasOfficialWebsite = websiteCounts && Boolean(normalizeOptionalUrl(website));
  return Boolean(
    profile.date_of_birth ||
      profile.twitter_handle ||
      profile.linkedin_url ||
      hasOfficialWebsite ||
      hasFec ||
      hasStateFiling
  );
}

export function resolveStoredCandidateParty(input: {
  includeParty: boolean;
  rosterParty: string | undefined;
  profileParty: string | undefined;
}): string {
  // Canonicalized here because this is the single choke point every
  // candidates.party write flows through (insert and merge alike), so
  // "DEM" / "Democrat" / "Democratic Party" all store as "Democratic".
  return canonicalizeParty(
    input.includeParty ? input.rosterParty ?? input.profileParty ?? "Unknown" : "Nonpartisan"
  );
}

function matchesLinkedInUrl(profile: CandidateProfilePayload, row: ExistingCandidateRow): boolean {
  // Both sides must normalize: two junk (non-URL) values would otherwise
  // compare null === null and match, as the website check already guards.
  const profileUrl = normalizeOptionalUrl(profile.linkedin_url);
  const rowUrl = normalizeOptionalUrl(row.linkedin_url);
  return Boolean(profileUrl && rowUrl && profileUrl === rowUrl);
}

// The contract only checks that linkedin_url is an http(s) URL, so a company
// or school page can sit in the column. Only a personal profile (/in/<slug>)
// identifies one human; two colleagues sharing an employer page must not.
export function isPersonalLinkedInProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname) && /^\/in\/[^/]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function matchesFecId(profile: CandidateProfilePayload, row: ExistingCandidateRow): boolean {
  const profileFecIds = normalizeIdList(profile.fec_ids);
  const rowFecIds = normalizeIdList(parseOptionalStringArray(row.fec_ids));
  return profileFecIds.length > 0 && rowFecIds.length > 0 && hasNormalizedIntersection(profileFecIds, rowFecIds);
}

function matchesStateFilingId(profile: CandidateProfilePayload, row: ExistingCandidateRow): boolean {
  const profileStateFilingIds = normalizeIdList(profile.state_filing_ids);
  const rowStateFilingIds = normalizeIdList(parseOptionalStringArray(row.state_filing_ids));
  return (
    profileStateFilingIds.length > 0 &&
    rowStateFilingIds.length > 0 &&
    hasNormalizedIntersection(profileStateFilingIds, rowStateFilingIds)
  );
}

/**
 * Identifiers a registry (FEC, a state filing system) or the person's own
 * professional profile assigns to exactly one human. These are trusted to
 * match a row even when the stored name parts differ from the payload's
 * (see loadNameRelatedCandidates). A shared website, twitter handle, or
 * birth date is NOT: on the local data, rows sharing a website across
 * different first names were mostly different people (slate sites — one
 * Texas county site listed five unrelated candidates; family pairs like
 * "Bob White" / "Cathy White"), while every pair sharing a filing or FEC
 * id across name variants was the same person.
 *
 * A state filing id is only unique within the state that issued it, so it
 * counts only for a row in the payload's state — the cross-state
 * presidential pool can hold another state's row with the same digits.
 * FEC ids and personal LinkedIn profiles are global.
 */
export function matchesByRegistryIdentifier(
  profile: CandidateProfilePayload,
  row: ExistingCandidateRow,
  scope: { state: string }
): boolean {
  if (matchesLinkedInUrl(profile, row) && isPersonalLinkedInProfileUrl(profile.linkedin_url!)) {
    return true;
  }
  if (matchesFecId(profile, row)) {
    return true;
  }
  return row.state === scope.state && matchesStateFilingId(profile, row);
}

export function matchesByHardIdentifier(
  profile: CandidateProfilePayload,
  row: ExistingCandidateRow,
  options: { websiteCountsAsIdentifier?: boolean } = {}
): boolean {
  // Exact-name rows keep the historical rule: any hard identifier, with no
  // state scoping on filing ids and no personal-profile check on LinkedIn.
  if (matchesLinkedInUrl(profile, row) || matchesFecId(profile, row) || matchesStateFilingId(profile, row)) {
    return true;
  }

  if (profile.date_of_birth && row.date_of_birth && profile.date_of_birth === row.date_of_birth) {
    return true;
  }

  if (profile.twitter_handle && row.twitter_handle) {
    const normalizedProfileHandle = normalizeTwitterHandle(profile.twitter_handle);
    const normalizedRowHandle = normalizeTwitterHandle(row.twitter_handle);
    if (
      normalizedProfileHandle &&
      normalizedRowHandle &&
      normalizedProfileHandle === normalizedRowHandle
    ) {
      return true;
    }
  }

  // A shared page (officials directory, results page, court roster) never
  // identifies one person; findOrCreateCandidateFromProfile also switches the
  // website off when another candidate under a different name holds it.
  const websiteCounts =
    options.websiteCountsAsIdentifier ??
    Boolean(profile.official_website_url && !isSharedPageWebsiteUrl(profile.official_website_url));
  const incomingWebsite =
    websiteCounts && profile.official_website_url ? normalizeOptionalUrl(profile.official_website_url) : null;
  if (incomingWebsite) {
    if (
      row.official_website_url &&
      incomingWebsite === normalizeOptionalUrl(row.official_website_url)
    ) {
      return true;
    }
    // Campaign sites change between races; the merge archives the replaced
    // URL, so a payload still carrying the OLD site must keep matching the
    // person instead of minting a duplicate row.
    for (const formerUrl of parseOptionalStringArray(row.former_website_urls)) {
      if (incomingWebsite === normalizeOptionalUrl(formerUrl)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * The stored name parts agree with the payload's exactly (case-insensitive),
 * the historical precondition for ANY hard-identifier match. Rows in the
 * identity pool that fail this only match on registry identifiers.
 */
export function isExactNameMatch(profile: CandidateProfilePayload, row: ExistingCandidateRow): boolean {
  return (
    row.first_name.toLowerCase() === profile.first_name.toLowerCase() &&
    row.last_name.toLowerCase() === profile.last_name.toLowerCase()
  );
}

const IDENTITY_POOL_COLUMNS = `
      SELECT
        id,
        first_name,
        last_name,
        display_name,
        date_of_birth::text AS date_of_birth,
        twitter_handle,
        linkedin_url,
        official_website_url,
        former_website_urls,
        fec_ids,
        state_filing_ids,
        current_office,
        state
      FROM public.candidates
      WHERE deleted_at IS NULL`;

/**
 * Rows the identity resolver compares hard identifiers against.
 *
 * The pool is wider than an exact first+last match: it also holds rows that
 * share EITHER name part or the display name. Stored name parts are not
 * reliable — rosters split "Jimmie Wilson Jr." into last_name "Jr.", and a
 * primary-stage row may hold "Chris" where the general-stage payload says
 * "Christopher". With an exact-name pool those rows were never even loaded,
 * so a shared state filing id could not be consulted and the writer minted
 * a duplicate person (three of them in the November 2026 legislative run).
 *
 * Widening the pool is only safe because findOrCreateCandidateFromProfile
 * trusts a non-exact-name row on registry identifiers alone
 * (matchesByRegistryIdentifier); the weak identifiers keep requiring the
 * exact name. lower() on both sides defeats the plain last_name index, as
 * the exact-name query already did; the table is ~20k rows.
 *
 * The pool also holds every live row that stores the payload's website
 * (current or former, compared case-insensitively without a trailing slash)
 * whatever its name: assessWebsiteIdentifier needs those rows to tell a
 * personal site from a page several people share. They never match on the
 * website themselves — the exact-name rule above still applies.
 */
const IDENTITY_POOL_WEBSITE_CLAUSE = (param: string) => `
          OR lower(rtrim(official_website_url, '/')) = lower(rtrim(${param}::text, '/'))
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(former_website_urls) = 'array' THEN former_website_urls ELSE '[]'::jsonb END
            ) AS former(url)
            WHERE lower(rtrim(former.url, '/')) = lower(rtrim(${param}::text, '/'))
          )`;

function identityPoolWebsiteParam(profile: CandidateProfilePayload): string | null {
  return profile.official_website_url ? normalizeOptionalUrl(profile.official_website_url) : null;
}

export async function loadNameRelatedCandidates(
  client: Pick<PoolClient, "query">,
  profile: CandidateProfilePayload,
  state: string
): Promise<ExistingCandidateRow[]> {
  const result = await client.query<ExistingCandidateRow>(
    `${IDENTITY_POOL_COLUMNS}
        AND state = $3
        AND (
          lower(first_name) = lower($1)
          OR lower(last_name) = lower($2)
          OR lower(trim(display_name)) = lower(trim($4))${IDENTITY_POOL_WEBSITE_CLAUSE("$5")}
        )
    `,
    [profile.first_name, profile.last_name, state, profile.display_name, identityPoolWebsiteParam(profile)]
  );

  return result.rows;
}

export async function loadNameRelatedCandidatesAcrossStates(
  client: Pick<PoolClient, "query">,
  profile: CandidateProfilePayload
): Promise<ExistingCandidateRow[]> {
  const result = await client.query<ExistingCandidateRow>(
    `${IDENTITY_POOL_COLUMNS}
        AND (
          lower(first_name) = lower($1)
          OR lower(last_name) = lower($2)
          OR lower(trim(display_name)) = lower(trim($3))${IDENTITY_POOL_WEBSITE_CLAUSE("$4")}
        )
    `,
    [profile.first_name, profile.last_name, profile.display_name, identityPoolWebsiteParam(profile)]
  );

  return result.rows;
}

async function insertCandidate(
  client: PoolClient,
  profile: CandidateProfilePayload,
  state: string,
  storedParty: string
): Promise<string> {
  const insertResult = await client.query<{ id: string }>(
    `
      INSERT INTO public.candidates (
        display_name,
        first_name,
        last_name,
        date_of_birth,
        party,
        summary,
        twitter_handle,
        linkedin_url,
        fec_ids,
        state_filing_ids,
        state,
        official_website_url,
        profile_sources,
        current_office,
        has_held_public_office,
        last_researched
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::date,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10::jsonb,
        $11,
        $12,
        $13::jsonb,
        $14,
        $15::boolean,
        now()
      )
      RETURNING id
    `,
    [
      profile.display_name,
      profile.first_name,
      profile.last_name,
      profile.date_of_birth ?? null,
      storedParty,
      profile.summary ?? null,
      profile.twitter_handle ?? null,
      profile.linkedin_url ?? null,
      profile.fec_ids ? JSON.stringify(profile.fec_ids) : null,
      profile.state_filing_ids ? JSON.stringify(profile.state_filing_ids) : null,
      state,
      profile.official_website_url ?? null,
      JSON.stringify(profile.sources),
      profile.current_office ?? null,
      profile.has_held_public_office ?? null,
    ]
  );

  const id = insertResult.rows[0]?.id;
  if (!id) {
    throw new Error("candidate insert returned no id");
  }

  return id;
}

/**
 * Refuse a merge whose EFFECTIVE post-write state would say "holds
 * current_office X" and "has NEVER held public office" at once — the payload
 * contract already rejects that pair inside one payload, but fill-if-empty
 * merging can assemble it across writes (stored office + incoming false
 * filling a NULL column, or incoming office filling a blank while a stored
 * false survives). A contradictory row would route the record sweep onto the
 * wrong question list, which is the exact failure this column exists to end.
 * Mirrors the merge UPDATE's CASE semantics.
 */
export function assertMergedOfficeRoutingConsistent(input: {
  profile: CandidateProfilePayload;
  storedCurrentOffice: string | null;
  storedHasHeldPublicOffice: boolean | null;
  overwriteFields?: ReadonlySet<OverwritableProfileField>;
  clearFields?: ReadonlySet<OverwritableProfileField>;
}): void {
  const incomingHasHeld = input.profile.has_held_public_office ?? null;
  const effectiveHasHeld = input.overwriteFields?.has("has_held_public_office")
    ? incomingHasHeld
    : input.storedHasHeldPublicOffice ?? incomingHasHeld;

  const storedOffice = input.storedCurrentOffice?.trim() || null;
  const incomingOffice = input.profile.current_office?.trim() || null;
  const effectiveOffice = input.clearFields?.has("current_office")
    ? null
    : input.overwriteFields?.has("current_office") && incomingOffice !== null
      ? incomingOffice
      : storedOffice ?? incomingOffice;

  if (effectiveHasHeld === false && effectiveOffice !== null) {
    throw new Error(
      `Profile merge would leave a contradictory candidate row: current_office would be "${effectiveOffice}" (stored: ${JSON.stringify(input.storedCurrentOffice)}, incoming: ${JSON.stringify(input.profile.current_office ?? null)}) while has_held_public_office would be false — a candidate holding a public office now HAS held public office. If the stored office is stale or holds an occupation, clear or replace it (--clear-profile-fields current_office / --replace-profile-fields current_office); if the stored false routing answer is stale, correct it with --replace-profile-fields has_held_public_office. Nothing was written.`
    );
  }

  // A null-retraction is refused while a current office would survive the
  // write: the office itself proves the answer is true, so retracting to
  // "unanswered" beside it either erases a provable fact or leaves a stale
  // office standing. Deliberately narrower than "reject office + non-true":
  // legacy rows hold current_office with a NULL answer wholesale, and a
  // routine pass that answers null from office-history-silent sources must
  // still be able to fill their OTHER empty fields — only the write that
  // actively retracts is refused, not one that merely fails to repair
  // pre-existing state.
  if (
    input.overwriteFields?.has("has_held_public_office") &&
    incomingHasHeld === null &&
    effectiveOffice !== null
  ) {
    throw new Error(
      `Profile merge refuses to retract has_held_public_office to null while current_office would remain "${effectiveOffice}" (stored: ${JSON.stringify(input.storedCurrentOffice)}) — a standing current office proves the answer is true. If the stored office is real, drop the retraction (or answer true); if it is stale or holds an occupation, clear or replace it in the same write (--clear-profile-fields current_office / --replace-profile-fields current_office). Nothing was written.`
    );
  }
}

async function mergeCandidateIdentifiersForExistingCandidate(
  client: PoolClient,
  candidateId: string,
  profile: CandidateProfilePayload,
  storedParty: string,
  overwriteFields?: ReadonlySet<OverwritableProfileField>,
  clearFields?: ReadonlySet<OverwritableProfileField>
): Promise<void> {
  const locked = await client.query<{
    fec_ids: unknown;
    state_filing_ids: unknown;
    current_office: string | null;
    has_held_public_office: boolean | null;
    party: string | null;
    profile_sources: unknown;
    official_website_url: string | null;
    former_website_urls: unknown;
  }>(
    `
      SELECT fec_ids, state_filing_ids, current_office, has_held_public_office, party, profile_sources,
             official_website_url, former_website_urls
      FROM public.candidates
      WHERE id = $1
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    [candidateId]
  );
  const current = locked.rows[0];
  if (!current) {
    return;
  }

  assertMergedOfficeRoutingConsistent({
    profile,
    storedCurrentOffice: current.current_office,
    storedHasHeldPublicOffice: current.has_held_public_office,
    overwriteFields,
    clearFields,
  });

  const existingFecIds = parseOptionalStringArray(current.fec_ids);
  const existingStateFilingIds = parseOptionalStringArray(current.state_filing_ids);

  const mergedFecIds = mergeIdentifierLists(existingFecIds, profile.fec_ids);
  const mergedStateFilingIds = mergeIdentifierLists(existingStateFilingIds, profile.state_filing_ids);

  // profile_sources follows the same additive logic as the fact columns it
  // vouches for: the UPDATE below keeps stored facts, so a narrow correction
  // payload must not wipe the sources supporting them. Only an explicit
  // --replace-profile-fields profile_sources swaps in the payload's list.
  const mergedProfileSources = overwriteFields?.has("profile_sources")
    ? [...profile.sources]
    : mergeProfileSourceLists(parseOptionalStringArray(current.profile_sources), profile.sources);

  // Scalar fields fill empty columns but never overwrite non-empty stored
  // values, unless the caller explicitly listed the field for replacement —
  // or listed it for clearing, which sets the column to NULL and wins over
  // every other branch. Identifier lists stay additive; profile_sources
  // unions with the stored list (replace only when explicitly listed).
  // official_website_url is the exception: it is volatile, so it is resolved
  // in TS from the locked row (replace-and-archive by default; see
  // resolveWebsiteRotationOnMerge) and written directly.
  const scalarValue = (field: OverwritableProfileField, value: string | undefined | null) => ({
    value: value ?? null,
    overwrite: overwriteFields?.has(field) ?? false,
    clear: clearFields?.has(field) ?? false,
  });
  const scalars = {
    date_of_birth: scalarValue("date_of_birth", profile.date_of_birth),
    twitter_handle: scalarValue("twitter_handle", profile.twitter_handle),
    linkedin_url: scalarValue("linkedin_url", profile.linkedin_url),
    summary: scalarValue("summary", profile.summary),
    current_office: scalarValue("current_office", profile.current_office),
  };
  const website = resolveWebsiteRotationOnMerge({
    storedWebsite: current.official_website_url,
    storedFormerWebsites: parseOptionalStringArray(current.former_website_urls),
    incomingWebsite: profile.official_website_url,
    overwrite: overwriteFields?.has("official_website_url") ?? false,
    clear: clearFields?.has("official_website_url") ?? false,
  });

  await client.query(
    `
      UPDATE public.candidates
      SET fec_ids = $2::jsonb,
          state_filing_ids = $3::jsonb,
          date_of_birth = CASE
            WHEN $15::boolean THEN NULL
            WHEN $6::boolean AND $5::date IS NOT NULL THEN $5::date
            WHEN date_of_birth IS NULL THEN $5::date
            ELSE date_of_birth
          END,
          twitter_handle = CASE
            WHEN $16::boolean THEN NULL
            WHEN $8::boolean AND $7::text IS NOT NULL AND length(trim($7::text)) > 0 THEN $7::text
            WHEN twitter_handle IS NULL OR length(trim(twitter_handle)) = 0 THEN COALESCE($7::text, twitter_handle)
            ELSE twitter_handle
          END,
          linkedin_url = CASE
            WHEN $17::boolean THEN NULL
            WHEN $10::boolean AND $9::text IS NOT NULL AND length(trim($9::text)) > 0 THEN $9::text
            WHEN linkedin_url IS NULL OR length(trim(linkedin_url)) = 0 THEN COALESCE($9::text, linkedin_url)
            ELSE linkedin_url
          END,
          -- Resolved in TS from the locked row (resolveWebsiteRotationOnMerge):
          -- the volatile website replaces-and-archives instead of fill-if-empty,
          -- so the value arrives fully decided.
          official_website_url = $24::text,
          former_website_urls = $25::jsonb,
          summary = CASE
            WHEN $18::boolean THEN NULL
            WHEN $12::boolean AND $11::text IS NOT NULL AND length(trim($11::text)) > 0 THEN $11::text
            WHEN summary IS NULL OR length(trim(summary)) = 0 THEN COALESCE($11::text, summary)
            ELSE summary
          END,
          current_office = CASE
            WHEN $19::boolean THEN NULL
            WHEN $14::boolean AND $13::text IS NOT NULL AND length(trim($13::text)) > 0 THEN $13::text
            WHEN current_office IS NULL OR length(trim(current_office)) = 0 THEN COALESCE($13::text, current_office)
            ELSE current_office
          END,
          has_held_public_office = CASE
            -- Overwrite takes the payload value even when it is NULL: a
            -- stored false manufactured from office-history-silent sources
            -- is repaired by an explicit payload null under
            -- --replace-profile-fields, returning the row to "unanswered".
            WHEN $21::boolean THEN $20::boolean
            WHEN has_held_public_office IS NULL THEN $20::boolean
            ELSE has_held_public_office
          END,
          party = CASE
            WHEN $23::boolean AND length(trim($22::text)) > 0 THEN $22::text
            -- party has been NOT NULL since migration 001. Repair blank
            -- values, but never turn schema-drift NULLs into "Unknown"
            -- without the explicit overwrite branch above.
            WHEN party IS NOT NULL AND length(trim(party)) = 0 THEN $22::text
            ELSE party
          END,
          profile_sources = $4::jsonb,
          last_researched = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [
      candidateId,
      mergedFecIds ? JSON.stringify(mergedFecIds) : null,
      mergedStateFilingIds ? JSON.stringify(mergedStateFilingIds) : null,
      JSON.stringify(mergedProfileSources),
      scalars.date_of_birth.value,
      scalars.date_of_birth.overwrite,
      scalars.twitter_handle.value,
      scalars.twitter_handle.overwrite,
      scalars.linkedin_url.value,
      scalars.linkedin_url.overwrite,
      scalars.summary.value,
      scalars.summary.overwrite,
      scalars.current_office.value,
      scalars.current_office.overwrite,
      scalars.date_of_birth.clear,
      scalars.twitter_handle.clear,
      scalars.linkedin_url.clear,
      scalars.summary.clear,
      scalars.current_office.clear,
      // Tri-state routing fact: fill-if-NULL, replace only when explicitly
      // listed (including replace with an explicit payload null). Never
      // cleared via --clear-profile-fields — the contract requires an
      // answer, so a retraction travels as a payload null instead.
      profile.has_held_public_office ?? null,
      overwriteFields?.has("has_held_public_office") ?? false,
      storedParty,
      overwriteFields?.has("party") ?? false,
      website.website,
      website.formerWebsites.length > 0 ? JSON.stringify(website.formerWebsites) : null,
    ]
  );
}

async function findCandidateLinkedToElectionByDisplayName(
  client: PoolClient,
  electionId: string,
  displayName: string
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `
      SELECT DISTINCT c.id
      FROM public.candidates c
      JOIN public.candidate_elections ce
        ON (ce.candidate_id = c.id OR ce.running_mate_candidate_id = c.id)
      WHERE ce.election_id = $1
        AND c.deleted_at IS NULL
        AND lower(trim(c.display_name)) = lower(trim($2))
    `,
    [electionId, displayName]
  );
  if (result.rows.length > 1) {
    throw new Error(
      `Multiple candidates named "${displayName}" are linked to election ${electionId}; resolve the duplicate rows before re-writing this profile.`
    );
  }
  return result.rows[0]?.id ?? null;
}

export async function findOrCreateCandidateFromProfile(
  input: FindOrCreateCandidateFromProfileInput
): Promise<FindOrCreateCandidateFromProfileResult> {
  assertCandidatePartyWillNotBeDiscarded({
    includeParty: input.includeParty,
    partyLabels: [input.rosterParty, input.profile.party],
  });
  const storedParty = resolveStoredCandidateParty({
    includeParty: input.includeParty,
    rosterParty: input.rosterParty,
    profileParty: input.profile.party,
  });
  // Serialize identity resolution per person: the read below and the insert
  // at the bottom are otherwise an unlocked read-then-insert, and the
  // candidates table has no uniqueness constraint — two workers processing
  // the same person concurrently would both see no match and insert
  // duplicate rows. The transaction-scoped advisory lock releases on
  // commit/rollback. Keyed by name only (not state) so the cross-state
  // presidential path contends with the per-state path for the same person.
  const lockName = normalizeCandidateName(`${input.profile.first_name} ${input.profile.last_name}`);
  await input.client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('candidate_identity:' || $1, 0))`,
    [lockName]
  );

  const existingCandidates = input.allowCrossStateHardIdentifierMatch
    ? await loadNameRelatedCandidatesAcrossStates(input.client, input.profile)
    : await loadNameRelatedCandidates(input.client, input.profile, input.state);

  // A website only identifies a person when it is their own site: a shared
  // page, or a URL another candidate under a different name already holds,
  // is switched off for both the identifier gate and the match below. The
  // manual writers refuse such a payload up front unless the operator passed
  // --allow-no-hard-identifier; here the write simply proceeds as if the
  // payload carried no website (linked-election match or insert).
  const websiteCountsAsIdentifier = assessWebsiteIdentifier(input.profile, existingCandidates).usable;

  if (hasAtLeastOneHardIdentifier(input.profile, { websiteCountsAsIdentifier })) {
    // Exact-name rows match on any hard identifier (unchanged). Rows that
    // only share a name part or the display name must match on a registry
    // identifier — a shared campaign site or birth date across different
    // names is more often two people than one (see matchesByRegistryIdentifier).
    const matched = existingCandidates.filter((row) =>
      isExactNameMatch(input.profile, row)
        ? matchesByHardIdentifier(input.profile, row, { websiteCountsAsIdentifier })
        : matchesByRegistryIdentifier(input.profile, row, { state: input.state })
    );
    if (matched.length === 1) {
      const matchedCandidate = matched[0]!;
      await mergeCandidateIdentifiersForExistingCandidate(
        input.client,
        matchedCandidate.id,
        input.profile,
        storedParty,
        input.overwriteProfileFields,
        input.clearProfileFields
      );
      return { candidateId: matchedCandidate.id, matchedExisting: true };
    }
    if (matched.length > 1) {
      // Falling through would insert a third row for an already-duplicated
      // person. Surface instead so an operator merges the duplicates.
      throw new AmbiguousCandidateIdentityError(
        `Multiple existing candidates named "${input.profile.display_name}" match this profile's hard identifiers ` +
          `(${matched.map((row) => row.id).join(", ")}); merge the duplicate rows before re-writing this profile.`
      );
    }
  }

  if (input.matchByLinkedElectionId) {
    const linkedCandidateId = await findCandidateLinkedToElectionByDisplayName(
      input.client,
      input.matchByLinkedElectionId,
      input.profile.display_name
    );
    if (linkedCandidateId) {
      await mergeCandidateIdentifiersForExistingCandidate(
        input.client,
        linkedCandidateId,
        input.profile,
        storedParty,
        input.overwriteProfileFields,
        input.clearProfileFields
      );
      return { candidateId: linkedCandidateId, matchedExisting: true };
    }
  }

  const candidateId = await insertCandidate(
    input.client,
    input.profile,
    input.state,
    storedParty
  );
  return { candidateId, matchedExisting: false };
}
