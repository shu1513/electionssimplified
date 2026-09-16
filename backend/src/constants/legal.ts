/**
 * Version of the Terms of Use / Disclaimer bundle the frontend must present
 * at signup. Must match the Version header in docs/legal/disclaimer.md —
 * bump both together. Registration rejects any other value so a stale
 * frontend cannot record acceptance of superseded terms; the git history of
 * docs/legal/ is the authoritative archive of what each version said.
 */
export const CURRENT_TERMS_VERSION = "1.5";

/**
 * Previous bundle versions still accepted while a version bump rolls out.
 * Frontends bundle their terms version at build time, and the api/ssr
 * services deploy separately, so around a bump there are always clients
 * whose bundle — and therefore whose RENDERED legal documents — are one
 * version behind: stale browser tabs, and any distributed mobile build.
 * Accepting the version such a client sends is legally sound (it is the
 * version the visitor was actually shown) and is recorded as-is; the
 * renewal gate then brings the account to the current version on the next
 * fresh load. Empty this list once a bump has fully rolled out (all web
 * bundles refreshed, no distributed mobile build on the old version), and
 * repopulate it with the outgoing version at the next bump.
 */
// 1.5 (2026-09-16 legal audit): only "1.4" is listed. No mobile build has
// been distributed yet, and the 1.2/1.3 web bundles are weeks old; a stale
// tab that old gets the renewal gate on its next fresh load. Empty the list
// once the 1.5 rollout settles.
export const GRACE_TERMS_VERSIONS: readonly string[] = ["1.4"];

/** A terms version a client may accept right now: current, or a listed
 * still-rolling-out previous version. */
export function isAcceptableTermsVersion(version: string): boolean {
  return version === CURRENT_TERMS_VERSION || GRACE_TERMS_VERSIONS.includes(version);
}
