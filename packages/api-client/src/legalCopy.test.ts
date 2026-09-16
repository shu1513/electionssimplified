import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADDRESS_FIELD_PRIVACY_NOTE,
  PRE_SEARCH_AGREEMENT_PARAGRAPHS,
  PRE_SEARCH_CHECKBOX_LABEL,
  RENEWAL_CHECKBOX_LABEL,
  SIGNUP_CHECKBOX_LABEL,
  TERMS_VERSION,
  VERIFY_WITH_OFFICIALS_NOTE,
} from "./legalCopy";

// docs/legal/checkbox-copy.md says the frontend must copy these strings
// verbatim, and nothing checked it. Splitting the pre-search clickwrap into a
// short label plus dialog paragraphs turned one string into five, so drift is
// now easier — and the whole evidentiary value of the gate rests on the
// shipped wording matching the archived wording.
// Walked up from the cwd rather than resolved from import.meta.url: the jsdom
// environment hands this module a non-file URL, and the suite runs from either
// the package or the repo root.
function findLegalDoc(filename: string): string {
  let directory = process.cwd();
  for (;;) {
    const candidate = resolve(directory, "docs/legal", filename);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate docs/legal/${filename} above the working directory`);
    }
    directory = parent;
  }
}

function findCheckboxCopyDoc(): string {
  return findLegalDoc("checkbox-copy.md");
}

// Only the published copy counts. The file opens with an HTML comment of
// implementation notes that quotes fragments of these strings; matching
// against it would let a stale published string pass on the strength of a
// note.
const CHECKBOX_COPY_DOC = readFileSync(findCheckboxCopyDoc(), "utf8").replace(/<!--[\s\S]*?-->/g, "");

/** The doc is prose: markdown link brackets, blockquote markers, wrapped lines. */
function normalize(value: string): string {
  return value.replace(/[[\]]/g, "").replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ").trim();
}

const normalizedDoc = normalize(CHECKBOX_COPY_DOC);

describe("legal copy matches docs/legal/checkbox-copy.md", () => {
  it.each([
    ["pre-search label", PRE_SEARCH_CHECKBOX_LABEL],
    ["signup label", SIGNUP_CHECKBOX_LABEL],
    ["renewal label", RENEWAL_CHECKBOX_LABEL],
    ["short privacy note", ADDRESS_FIELD_PRIVACY_NOTE],
    ["results verification line", VERIFY_WITH_OFFICIALS_NOTE],
    ...PRE_SEARCH_AGREEMENT_PARAGRAPHS.map(
      (paragraph, index) => [`full-agreement paragraph ${index + 1}`, paragraph] as const
    ),
  ])("archives the %s", (_name, copy) => {
    expect(normalizedDoc).toContain(normalize(copy));
  });

  it("carries the version the doc is headed with", () => {
    expect(normalizedDoc).toContain(`Checkbox and notice copy — Version ${TERMS_VERSION}`);
  });

  // No checkbox restates Section 12: arbitration binds through the linked
  // Terms of Use, and repeating it beside every box was scare copy on screens
  // people came to for something else (2026-08-30 trimmed the pre-search gate,
  // 2026-08-31 the signup and renewal labels). Pinned so the restatement does
  // not creep back one label at a time. The reasoning is in legalCopy.ts above
  // PRE_SEARCH_CHECKBOX_LABEL.
  it.each([
    ["pre-search label", PRE_SEARCH_CHECKBOX_LABEL],
    ["signup label", SIGNUP_CHECKBOX_LABEL],
    ["renewal label", RENEWAL_CHECKBOX_LABEL],
    ...PRE_SEARCH_AGREEMENT_PARAGRAPHS.map(
      (paragraph, index) => [`full-agreement paragraph ${index + 1}`, paragraph] as const
    ),
  ])("leaves arbitration out of the %s", (_name, copy) => {
    expect(copy).not.toContain("arbitration");
    expect(copy).not.toContain("class-action");
  });

  // Dropping the arbitration callout leaves the linked documents carrying the
  // whole of the notice, so every label must still name all three — the
  // dialogs hard-code that same list as links beside it.
  it.each([
    ["pre-search", PRE_SEARCH_CHECKBOX_LABEL],
    ["signup", SIGNUP_CHECKBOX_LABEL],
    ["renewal", RENEWAL_CHECKBOX_LABEL],
  ])("names all three documents in the %s label", (_name, copy) => {
    for (const title of [
      "Terms of Use",
      "Privacy Policy",
      "AI Research and Election Information Disclaimer",
    ]) {
      expect(copy).toContain(title);
    }
  });
});

// The acceptance ledger records a version string, and the enforcement paths
// compare against one. Neither notices if the TEXT behind a version changes:
// an edit to any of these files ships silently, and every acceptance already
// recorded against that version now points at wording nobody agreed to.
//
// Pinning the bytes makes that impossible to do by accident. A deliberate
// change fails here, and clearing the failure means deciding, on purpose,
// whether the edit is a clarification that keeps the version or a change of
// substance that needs a version bump and re-acceptance.
//
// This deliberately does not pin checkbox-copy.md: the assertions above
// already tie every string it publishes to the shipped constants, and that
// file also carries implementation notes that change for non-legal reasons.
const PINNED_DOCUMENTS = [
  {
    filename: "terms-of-use.md",
    // 1.1 → 1.2 (2026-08-21): Section 14 support payments and memberships
    // (docs/plans/membership-contributions.md); Contact renumbered to 15.
    // Substance change — bundle bumps to 1.2 (CURRENT_TERMS_VERSION,
    // TERMS_VERSION, disclaimer.md) and signed-in users re-accept once.
    // Required BEFORE STRIPE_SECRET_KEY in prod.
    // 1.2 → 1.3 (2026-08-28): Section 14.5 member communications (member-only
    // newsletters/analysis reports); 14.1 carve-out excepts 14.5 while the
    // no-influence shield stays absolute. Substance change — bundle bumps to
    // 1.3, GRACE_TERMS_VERSIONS ships ["1.2"], signed-in users re-accept
    // once. Required BEFORE the first member-only communication is sent.
    // 1.3 → 1.4 (2026-08-29): operator/contracting party is now Elections
    // Simplified Inc., a Delaware corporation (previously impactperdollar).
    // Party-identity change is material — bundle bumps to 1.4,
    // GRACE_TERMS_VERSIONS ships ["1.3", "1.2"] (the 1.3 rollout was only a
    // day old), signed-in users re-accept once.
    // 1.4 wording fix (2026-09-04, docs/plans/membership-manage-page.md):
    // 14.3 cancellation path "(via the Stripe billing portal)" → "under
    // Manage membership" — navigation wording only, no change in rights, so
    // the hash is re-pinned WITHOUT a version bump or re-acceptance.
    // 1.4 → 1.5 (2026-09-16, legal audit): user-favorable narrowing —
    // notices "to the extent permitted by law"; AGPL/public-domain
    // carve-out in §6; Google Maps Platform terms linked in §7; one
    // aggregate cap measured from the event + non-excludable-liability
    // carve-out in §8; §9 indemnity limited to third-party claims from
    // breach/unlawful use/infringing submissions (reliance prong dropped);
    // §12.4 preserves regulator complaints and public injunctive relief;
    // §12.6 uses the AAA Mass Arbitration Supplementary Rules instead of a
    // bespoke bellwether hold; §13 feedback license excludes personal data.
    // Bundle bumps to 1.5, GRACE_TERMS_VERSIONS ships ["1.4"], signed-in
    // users re-accept once so the record points at the text in force.
    version: "1.5",
    sha256: "39a4ab0e2a339af72882eeb25a244a152a68ef4814938df4e9fe59e3497840e2",
  },
  {
    filename: "privacy-policy.md",
    // 1.0 → 1.1 (2026-08-12): Ask question-log disclosure + OpenAI processor
    // entry, required BEFORE CHATBOT_LLM_ENABLED in prod (chatbot Phase 2).
    // 1.1 → 1.2 (2026-08-12): Sign in with Google disclosure (ID-token data,
    // Google processor entry, password-less account handling), required
    // BEFORE GOOGLE_OAUTH_CLIENT_ID in prod. Clarifying addition for an
    // optional feature — TERMS_VERSION stays 1.1, no re-acceptance.
    // 1.2 → 1.3 (2026-08-21): support-payments disclosure (Stripe processor
    // entry, payment data in Section 1, payment-record retention after
    // account deletion in Section 4). Ships with the Terms 1.2 bump.
    // Required BEFORE STRIPE_SECRET_KEY in prod.
    // 1.3 → 1.4 (2026-08-29): operator named as Elections Simplified Inc., a
    // Delaware corporation. Ships with the Terms 1.4 bump.
    // 1.4 → 1.5 (2026-09-04): first-party usage analytics disclosure
    // (docs/plans/usage-analytics.md): what is collected, no third party,
    // per-tab identifier, 90-day retention, /privacy opt-out. Required
    // BEFORE USAGE_ANALYTICS_ENABLED in prod. Like 1.2, a disclosure that
    // identifies nobody — TERMS_VERSION stays 1.4, no re-acceptance.
    // 1.5 → 1.6 (2026-09-10, open-source readiness): names the stored picks
    // and shared pick cards (first name, live view, "Stop sharing" on
    // /me/picks); scopes any future promotional email content to
    // research-area interests only, never picks or follows (the 1.5 wording
    // read as pick-targeted); adds section-into-view to the analytics list.
    // Clarifications of existing practice, nothing new collected —
    // TERMS_VERSION stays 1.4, no re-acceptance.
    // 1.7 (2026-09-12): mobile push notification tokens and the push
    // processors (Expo push service, APNs, FCM) named ahead of the store
    // release. Opt-in feature disclosure — TERMS_VERSION stays 1.4.
    // 1.7 → 1.8 (2026-09-16, legal audit): overclaims corrected — Ask logs
    // no longer called "anonymous" (regex redaction only); picks/follows
    // "never disclosed to third parties" narrowed to no sale / no
    // advertisers-campaigns-political orgs, processors named; OpenAI
    // 30-day abuse-monitoring retention stated; content-report free text
    // kept as written; Google Privacy Policy linked for Places. Ships with
    // the Terms 1.5 bump.
    version: "1.8",
    sha256: "f3e0782569084d4bc7ce0087f3049aeea48ac3e0f2cf350ecc234a23292ef363",
  },
  {
    filename: "disclaimer.md",
    // 1.1 → 1.2 (2026-08-21): no content change; version string tracks
    // CURRENT_TERMS_VERSION, which moved for the Terms 1.2 payments section.
    // 1.2 → 1.3 (2026-08-28): no content change; tracks the Terms 1.3 bump
    // (Section 14.5 member communications).
    // 1.3 → 1.4 (2026-08-29): operator named as Elections Simplified Inc., a
    // Delaware corporation; tracks the Terms 1.4 bump.
    // 1.4 → 1.5 (2026-09-16, legal audit): §8 names automated draft picks
    // as drafts, not recommendations; §17 cap aligned with Terms §8 plus a
    // non-excludable-liability carve-out; §18 prospective "Release" (Civil
    // Code §1542 waiver) deleted. Tracks the Terms 1.5 bump.
    version: "1.5",
    sha256: "cdd9a7b7c30db87b1c3827ae5147a7431d9b0a8d881dc015c1756a3015519cdd",
  },
] as const;

describe("legal documents are pinned to their versions", () => {
  it.each(PINNED_DOCUMENTS)("$filename still declares version $version", ({ filename, version }) => {
    const text = readFileSync(findLegalDoc(filename), "utf8");
    expect(text).toContain(`**Version:** ${version}`);
  });

  it.each(PINNED_DOCUMENTS)("$filename content is unchanged", ({ filename, sha256 }) => {
    const text = readFileSync(findLegalDoc(filename), "utf8");
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(sha256);
  });
});
