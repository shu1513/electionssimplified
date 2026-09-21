import type { CandidateProfilePayload } from "../../contracts/candidateProfilePayloadContract.js";
import type {
  CandidateRosterEntry,
  CandidateRosterNoFecIdException,
} from "../../contracts/candidateRosterPayloadContract.js";

// Helpers for the manual no-FEC-ID exception: a federal candidate an election
// authority lists on the ballot while the FEC has issued no candidate ID.
// The contract accepts the exception only on the manual roster inject path.

export type RosterNoFecIdExceptionAuditEntry = CandidateRosterNoFecIdException & {
  display_name: string;
};

// Shape stored in staging_items.ai_raw_debug.roster_no_fec_id_exceptions.
export function listRosterNoFecIdExceptions(
  candidates: readonly CandidateRosterEntry[]
): RosterNoFecIdExceptionAuditEntry[] {
  return candidates.flatMap((candidate) =>
    candidate.no_fec_id_exception
      ? [{ display_name: candidate.display_name, ...candidate.no_fec_id_exception }]
      : []
  );
}

function hostnameWithoutWww(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// With no FEC ID, identity matching and duplicate prevention need another hard
// identifier. Two are accepted:
// - the election authority's own filing number, carried on the staged roster
//   row as state_filing_ids (minor-party and write-in candidates often have no
//   campaign website at all); or
// - the campaign website, "verified" meaning a cited source sits on the same
//   host: cited sources are the URLs the profile writer checks for
//   reachability, so the site was actually opened during research.
// A website in the payload is always held to the cited-host rule, even when a
// filing number is present, so an unverified site never rides in beside it.
export function assertNoFecIdExceptionProfileHasHardIdentifier(
  profile: Pick<CandidateProfilePayload, "official_website_url" | "sources">,
  rosterStateFilingIds: readonly string[]
): void {
  const websiteHost = profile.official_website_url ? hostnameWithoutWww(profile.official_website_url) : null;
  if (!websiteHost) {
    if (rosterStateFilingIds.length > 0) {
      return;
    }
    throw new Error(
      "payload.official_website_url is required for a roster row with no_fec_id_exception unless the roster row carries state_filing_ids; with no FEC ID, the campaign website or the election authority's filing number is the hard identifier"
    );
  }
  const cited = profile.sources.some((source) => hostnameWithoutWww(source) === websiteHost);
  if (!cited) {
    throw new Error(
      `payload.sources must include a page on ${websiteHost} for a roster row with no_fec_id_exception; the campaign website must be a verified source`
    );
  }
}
