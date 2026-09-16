// Legal strings rendered VERBATIM from docs/legal/checkbox-copy.md.
// Do not edit here without updating that file (and vice versa); the version
// must track docs/legal/disclaimer.md and the backend's
// CURRENT_TERMS_VERSION in lockstep.

export const TERMS_VERSION = "1.5";

// The pre-search clickwrap is split in two: a one-sentence label naming every
// document, plus a dialog holding the two sentences a first-time visitor has
// to read before results mean anything. Three paragraphs of small print above
// the Search button was skimmed past, which is the failure mode a clickwrap
// cannot afford; a summary the visitor actually reads, with the full text one
// click away and re-shown at the moment of agreement, is the pattern the
// clickwrap cases reward (Meyer v. Uber; Berman v. Freedom Financial; Sellers
// v. JustAnswer).
//
// No label in this file names arbitration — not this one, not
// SIGNUP_CHECKBOX_LABEL, not RENEWAL_CHECKBOX_LABEL. Section 12 lives in the
// Terms of Use, and restating it beside every checkbox repeated a linked
// document and put a lawsuit warning on screens people came to for something
// else. What the clickwrap cases require is conspicuous notice of the TERMS
// plus an unambiguous act of assent, not a callout of any particular clause:
// the registration screen enforced in Meyer v. Uber, 868 F.3d 66 (2d Cir.
// 2017) said only "By creating an Uber account, you agree to the TERMS OF
// SERVICE & PRIVACY POLICY"; the word "arbitration" was nowhere on it. An
// empty checkbox that gates the action clears that bar by a wider margin than
// Uber's click-to-continue did.
//
// What must NOT be dropped is the Terms of Use link beside each label. With no
// clause called out anywhere, the named, linked document at the moment of
// assent IS the notice; those links are the whole basis on which Section 12
// binds anyone.
export const PRE_SEARCH_CHECKBOX_LABEL =
  "I have read and agree to the Terms of Use, Privacy Policy, and AI Research and Election Information " +
  "Disclaimer.";

/** Body of the "full agreement" dialog behind the pre-search checkbox. */
export const PRE_SEARCH_AGREEMENT_PARAGRAPHS = [
  "Elections Simplified provides AI-assisted informational research only. It is not an official election " +
    "source, and results may be inaccurate, incomplete, outdated, or misleading.",
  "You must verify voting, registration, ballot, district, polling-place, deadline, and election-result " +
    "information with official election authorities before relying on it.",
] as const;

// These are the acceptances the DB records against a terms version
// (user_terms_acceptances). They bind through the three named, linked
// documents — no clause restatement here either; see PRE_SEARCH_CHECKBOX_LABEL
// for the reasoning, which now applies to every gate.
export const SIGNUP_CHECKBOX_LABEL =
  "I am at least 18 years old, and I have read and agree to the Terms of Use, Privacy Policy, and AI " +
  "Research and Election Information Disclaimer. I consent to enter this agreement electronically. I " +
  "understand that Elections Simplified is not an official election source, does not register voters or cast ballots, " +
  "and may display AI-assisted content that must be independently verified with official election " +
  "authorities.";

export const RENEWAL_CHECKBOX_LABEL =
  "I have read and agree to the updated Terms of Use, Privacy Policy, and AI Research and Election " +
  "Information Disclaimer.";

/**
 * Sits beside the address field, where collection actually begins: the
 * autocomplete forwards what is typed after three characters, long before
 * anyone presses Search, and notice has to arrive at or before collection.
 * Also the only privacy line in the pre-search dialog.
 *
 * It replaced a longer PRIVACY_NOTICE that summarised the whole of Privacy
 * Policy Section 1 — address, account data, device and usage data, the
 * purposes, the law. That summary was a second copy of a linked document, and
 * its first clause ("we collect the address you enter") read as retention when
 * the truth is narrower and better: the address goes to the Census geocoder,
 * an anonymous 14-day cache holds the normalised form, and what lands on an
 * account is a list of district ids. Say the narrow true thing here; the full
 * disclosure stays one click away in the Privacy Policy.
 */
export const ADDRESS_FIELD_PRIVACY_NOTE =
  "The address is only used to find voting districts. We don’t save it to your account.";

/**
 * Shown on results, where it reaches people who never passed the gate at all
 * — a shared computer, someone else's phone, a link from a text message. For
 * a reliance claim this line does more work than the agreement does, because
 * it does not depend on the reader having accepted anything.
 */
export const VERIFY_WITH_OFFICIALS_NOTE =
  "AI-assisted research. Verify voting information with official election authorities.";

// Acceptance IS remembered, per terms version, with an expiry — see
// frontend/src/lib/termsAcceptance.ts. What must never come back is the older
// behaviour that stored acceptance and then returned repeat visitors a
// PRE-TICKED box. Those are different things: a pre-ticked box shows assent
// that was never given, while skipping a gate somebody already passed is what
// every large site does. Remembering may therefore only ever decide whether
// the dialog OPENS. If a dialog opens, its checkbox starts empty.
