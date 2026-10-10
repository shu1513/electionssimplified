// Legal strings rendered VERBATIM from docs/legal/checkbox-copy.md.
// Do not edit here without updating that file (and vice versa); the version
// must track docs/legal/disclaimer.md and the backend's
// CURRENT_TERMS_VERSION in lockstep.

export const TERMS_VERSION = "1.5";

// The anonymous gate is a sign-in wrap: one sentence directly under the
// Search button on the web home, the newsroom box, and the app's home screen,
// naming and linking every document. Pressing Search is the act of assent.
// The earlier clickwrap dialog (an empty checkbox over the first results on
// the web, a sheet before the search in the app; 2026-08-30 to 2026-10-10)
// asked for the same agreement with an extra box, a Cancel button, and
// blurred results behind it, and it turned first-time visitors away before
// they saw a single election. Presentation only, no version bump; see
// docs/legal/checkbox-copy.md.
//
// What makes a sign-in wrap bind is notice placed where the action is taken:
// the registration screen enforced in Meyer v. Uber, 868 F.3d 66 (2d Cir.
// 2017) read "By creating an Uber account, you agree to the TERMS OF SERVICE
// & PRIVACY POLICY" beside the button, and nothing more. The weak pattern is
// notice sitting apart from the action (Nicosia v. Amazon), which is why this
// sentence may never move to the footer, shrink to a bare "Terms" link, or
// lose a document link. The search screens render it word for word, with
// each document name as the link to that document.
//
// No label in this file names arbitration — not this one, not
// SIGNUP_CHECKBOX_LABEL, not RENEWAL_CHECKBOX_LABEL. Section 12 lives in the
// Terms of Use, and restating it beside every gate repeated a linked
// document and put a lawsuit warning on screens people came to for something
// else. What the cases require is conspicuous notice of the TERMS plus an
// unambiguous act of assent, not a callout of any particular clause; the word
// "arbitration" was nowhere on Uber's screen.
//
// What must NOT be dropped is the Terms of Use link beside each label. With no
// clause called out anywhere, the named, linked document at the moment of
// assent IS the notice; those links are the whole basis on which Section 12
// binds anyone.
export const PRE_SEARCH_NOTICE =
  "By clicking Search you agree to the Terms of Use, Privacy Policy, and AI Research and Election Information " +
  "Disclaimer.";

// These are the acceptances the DB records against a terms version
// (user_terms_acceptances). They bind through the three named, linked
// documents — no clause restatement here either; see PRE_SEARCH_NOTICE
// for the reasoning, which now applies to every gate.
//
// The signup label is the same one sentence as the anonymous gate. Its age,
// electronic-consent and "not an official source" sentences were dropped on
// 2026-10-04 (presentation only, no version bump): Terms of Use Sections 1
// and 2 and the linked Disclaimer already say each of them.
export const SIGNUP_CHECKBOX_LABEL =
  "I have read and agree to the Terms of Use, Privacy Policy, and AI Research and Election Information " +
  "Disclaimer.";

export const RENEWAL_CHECKBOX_LABEL =
  "I have read and agree to the updated Terms of Use, Privacy Policy, and AI Research and Election " +
  "Information Disclaimer.";

/**
 * Sits beside the signed-in address form and inside the "why full address"
 * explainer that the anonymous search field links from its label. Collection
 * begins as the autocomplete forwards what is typed, long before anyone
 * presses Search, and notice has to arrive at or before collection.
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
  "The address is only used to find voting districts. We do NOT save it to your account.";

/**
 * Shown on the mobile ballot screen and the web How-it-works page. The web
 * site footer stopped rendering it on 2026-10-10 (presentation only, no
 * version bump): the footer's Disclaimer link carries the same warning.
 */
export const VERIFY_WITH_OFFICIALS_NOTE =
  "AI-assisted research. Verify voting information with official election authorities.";

// Anonymous acceptance is not stored anywhere, on the device or the server:
// every search sends the current TERMS_VERSION to POST /api/address/resolve,
// and the evidence of assent is docs/legal/checkbox-copy.md plus the deployed
// notice. Signed-in acceptances are the user_terms_acceptances rows. Should a
// checkbox ever come back on a search screen, it starts empty every time; a
// pre-ticked box shows assent nobody gave.
