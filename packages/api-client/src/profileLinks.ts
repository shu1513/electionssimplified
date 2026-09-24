// Outbound links shown under the candidate profile header, in display
// order. Web and mobile render the same list, so the X URL construction
// and the "which fields count as links" policy live here once.
//
// twitter_handle is stored as a bare lowercase handle (normalizeTwitterHandle
// in the backend strips the @ and any x.com/twitter.com URL wrapper); the
// client rebuilds the URL. The handle shape is re-checked here so a stray
// malformed row can never become an href — it is dropped instead.
//
// linkedin_url is only validated as http(s) on the write path, but the
// label asserts the domain, so a non-LinkedIn host is dropped the same way
// rather than shown as "LinkedIn". Host must be linkedin.com or a subdomain
// (www., uk., …) and end right there — "linkedin.com.evil.example" fails.
const TWITTER_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const LINKEDIN_URL = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com(?:[/?#]|$)/i;

export type CandidateProfileLink = { href: string; label: string };

// Reference sites whose candidate page is about the same person — the
// schema.org `sameAs` sense. A researched profile_sources entry on one of
// these hosts lets a search or AI engine reconcile our page with the entity
// it already knows (Ballotpedia and Wikipedia are the anchors most engines
// key on). Official filings, news, and legislature pages are sources, not
// identities, so they stay out. Host must be the site or a subdomain.
const SAME_AS_HOSTS = /^([a-z0-9-]+\.)*(?:ballotpedia\.org|wikipedia\.org|wikidata\.org|votesmart\.org)$/i;

// Generational suffixes that are not the surname.
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * The candidate's surname as lower-case letters, for matching a reference
 * page's title: nicknames in quotes and generational suffixes are dropped
 * ('Michael "Dr. Mike" Katz Jr.' → "katz"). null when nothing usable.
 */
export function candidateSurname(displayName: string): string | null {
  const tokens = displayName
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .split(/\s+/)
    .map((token) => token.toLowerCase().replace(/[^a-z\-]/g, "").replace(/-/g, " ").trim())
    .filter((token) => token !== "" && !NAME_SUFFIXES.has(token));
  return tokens.length > 0 ? tokens[tokens.length - 1]! : null;
}

/** The URL path as lower-case words: "/Jordan_Voter_(politician)" → "jordan voter politician". */
function pathWords(url: URL): string {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  return path.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

/**
 * URLs that identify the candidate elsewhere on the web, for the Person
 * JSON-LD `sameAs` list: the profile links (official site, X, LinkedIn)
 * plus profile sources on a recognised reference site whose page is about
 * this person. profile_sources mostly hold evidence pages — a state's
 * "House elections, 2026" overview, a county page — and citing those as
 * the candidate's identity would tell engines the wrong entity; only ~1 in
 * 5 reference-site sources actually names the person. So the page title
 * (the URL path) must contain the candidate's surname as a whole word.
 * Deduplicated in first-seen order; malformed URLs are dropped.
 */
export function candidateSameAsUrls(candidate: {
  display_name: string;
  official_website_url: string | null;
  twitter_handle: string | null;
  linkedin_url: string | null;
  profile_sources: readonly string[];
}): string[] {
  const urls: string[] = candidateProfileLinks(candidate).map((link) => link.href);
  const surname = candidateSurname(candidate.display_name);
  const namesPerson = surname ? new RegExp(`(^| )${surname}( |$)`) : null;
  for (const source of candidate.profile_sources) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      continue;
    }
    if (SAME_AS_HOSTS.test(url.hostname) && namesPerson?.test(pathWords(url))) {
      urls.push(source);
    }
  }
  return [...new Set(urls)];
}

export function candidateProfileLinks(candidate: {
  official_website_url: string | null;
  twitter_handle: string | null;
  linkedin_url: string | null;
}): CandidateProfileLink[] {
  const links: CandidateProfileLink[] = [];
  if (candidate.official_website_url) {
    links.push({ href: candidate.official_website_url, label: "Official website" });
  }
  if (candidate.twitter_handle && TWITTER_HANDLE.test(candidate.twitter_handle)) {
    links.push({ href: `https://x.com/${candidate.twitter_handle}`, label: "X (Twitter)" });
  }
  if (candidate.linkedin_url && LINKEDIN_URL.test(candidate.linkedin_url)) {
    links.push({ href: candidate.linkedin_url, label: "LinkedIn" });
  }
  return links;
}
