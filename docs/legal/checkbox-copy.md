<!--
The frontend must copy these strings verbatim. Version bumps to
disclaimer.md require re-review of this file too.
1.4 → 1.5 (2026-09-16, legal audit): reviewed for the Terms 1.5 / Disclaimer
1.5 / Privacy 1.8 bump — every published checkbox string is unchanged; the
only addition is the re-acceptance interstitial's exit rules (below).
1.5 presentation revision (2026-09-28), WEB ANONYMOUS GATE ONLY. Two changes,
no version bump — the three pinned documents are byte-identical, so the
agreement entered is the same agreement.
(a) The web dialog dropped its two disclaimer paragraphs; its body is now the
short privacy note, then the checkbox with its three linked documents. Same
reasoning as the 2026-08-30 trim: the paragraphs restated the linked
Disclaimer as warning copy at the moment of assent, and the results page
already shows the verification line (VERIFY_WITH_OFFICIALS_NOTE) to every
reader, gate or no gate.
(b) The gate moved from before the search to before the results. Pressing
Search now runs the lookup at once; a browser with no current acceptance
lands on the elections page with the list blurred behind the dialog, and the
list is readable only after **Agree and show results**. Cancel, Escape, or the
backdrop leave the page for the search form with the results unread. The
Terms of Use already bind on "submitting an address or search" (Section 1),
so the moment of assent moved to where the visitor is about to get the
service, which is still the clickwrap-case placement (assent gating the thing
asked for). Consequence for enforcement: POST /api/address/resolve no longer
requires accepted_terms_version. It serves a search that carries none and
still refuses a stale or unknown version; the field is sent only by browsers
that already hold an acceptance. The evidence of the gate is this file plus
the deployed frontend (BallotPage termsPending), not the endpoint.
The mobile sheet is unchanged by both (still pre-search, still renders the
paragraphs archived below) until it is revised separately; a 1.5 acceptance
row cannot say which screen it came from, and the ambiguity only runs the
safe way — every acceptor saw the checkbox naming and linking all three
documents, some saw extra paragraphs above it.
1.5 presentation revision (2026-10-04), SIGNUP ONLY. The signup label was cut
to the same one sentence as the anonymous gate. It dropped three things, each
already stated in a linked document: the age statement (Terms of Use
"Eligibility": by using the Service you represent that you are 18 or older),
the electronic-consent sentence (Terms of Use "Electronic communications and
notices"; ticking the box is itself the electronic assent), and the "not an
official election source" sentence (the Disclaimer, plus the verification
line shown on results). No version bump — the three pinned documents are
byte-identical. As with the 2026-08-31 trim, the ledger boundary is a
per-client deploy boundary and only runs the safe way: older 1.5 acceptors
saw the current sentence plus more.
1.1 → 1.2 (2026-08-21): reviewed for the Terms 1.2 support-payments bump —
every published string below is unchanged. One-time payments ride the
three-document acceptance. Monthly memberships additionally carry their own
auto-renewal consent INSIDE Stripe Checkout (consent_collection required +
custom renewal-terms text near the unchecked box: amount, monthly renewal,
cancel-anytime — CA BPC §17602; see docs/plans/membership-contributions.md).
That checkout copy lives in the backend session-creation call, not here,
because Stripe renders it.

1.4 presentation revision (2026-08-30), PRE-SEARCH GATE ONLY. The anonymous
dialog dropped two paragraphs — the arbitration restatement and the long
privacy notice — and its checkbox label was cut to the three document names.
The version did NOT bump, and that is the right call rather than an oversight:
terms-of-use.md, privacy-policy.md and disclaimer.md are byte-identical (the
pinned SHA-256 values in legalCopy.test.ts did not move), so the agreement a
visitor enters is the same agreement, presented shorter. A bump would have
forced every account through re-acceptance for a change to nothing they
accepted. What did change is that "1.4" now covers two pre-search screens, so
the boundary is recorded here: acceptances before 2026-08-30 saw the
four-paragraph dialog naming arbitration; acceptances after saw this file's
current text. Rationale for the removals is in "Why arbitration is not
named on any checkbox screen" and under the short privacy note.

1.4 presentation revision (2026-08-31), SIGNUP AND RE-ACCEPTANCE. The signup
label dropped its closing arbitration sentence and the re-acceptance label its
"including the agreement..." clause, for the same reason the pre-search gate
was trimmed the day before: Section 12 is stated in the linked Terms of Use,
and restating it beside the checkbox repeated a linked document as scare copy.
The version again did NOT bump — the three pinned documents are byte-identical,
so the agreement entered is the same agreement. Boundary for the acceptance
ledger: it is a per-client DEPLOY boundary, not a calendar line, and the rows
do not record label text, so a 1.4 row alone cannot say which wording was on
screen. Web flipped with the 2026-08-31 deploy; a mobile binary built earlier
keeps showing the old labels until the app updates, so 1.4 rows dated after
2026-08-31 may come from either wording. The ambiguity only runs the safe way:
the old labels are the current text PLUS an arbitration sentence, so every 1.4
acceptor saw at least the current wording — some saw more notice, none less.

Clickwrap requirements (Meyer v. Uber; Nguyen v. Barnes & Noble; Berman v.
Freedom Financial Network):
- Checkbox UNCHECKED by default; the action button stays disabled until
  checked.
- Checkbox sits directly above the action button it gates.
- [Terms of Use] / [Privacy Policy] / [Disclaimer] render as clearly visible
  links right next to the checkbox — no tiny gray text, no footer-only links.
  On every gate this is now the ENTIRE notice, since no clause is called out
  anywhere any more (see the 2026-08-30 and 2026-08-31 revision notes above),
  so weakening those links is the one edit that would actually cost us
  Section 12.
- Signup acceptance is recorded server-side: POST /api/auth/register requires
  accepted_terms_version matching CURRENT_TERMS_VERSION
  (backend/src/constants/legal.ts); stored on the user row with a timestamp.
  Registration always asks for its own acceptance: an anonymous acceptance on
  the same browser proves nothing about who owns the account.
- The users columns hold only the CURRENT version, and re-acceptance
  overwrites them, so every acceptance is also appended to
  user_terms_acceptances (migration 201). That table is the answer to "what
  has this account ever accepted"; the users columns answer "what is it on
  now", which is what the re-acceptance interstitial reads. Registration and
  renewal write their history row in the same statement or transaction as the
  users write, so an account can never claim a version with no history behind
  it. Rows are append-only: UPDATE is rejected, and DELETE is rejected unless
  the account itself is being deleted.
- Two limits on that table, stated here so nobody describes it as more than it
  is. It does not reach back before migration 201: accounts that accepted 1.0
  and later re-accepted 1.1 had the 1.0 acceptance overwritten in place on
  2026-07-18, and only a pre-bump backup can recover it. And acceptance rows
  are deleted with the account, so a closed account leaves no acceptance
  evidence at all — deliberate, because keeping it would be a retention
  practice the privacy policy does not describe.
- The wording behind a version is pinned by hash in
  packages/api-client/src/legalCopy.test.ts. A version string is only worth
  what the text behind it is, so editing terms-of-use.md, privacy-policy.md,
  or disclaimer.md fails CI until someone decides whether the edit keeps the
  version or needs a bump and re-acceptance.
- Registration and the re-acceptance interstitial keep their checkbox INLINE
  on the page: both gate an explicit account action the visitor came to take.
- The anonymous gate is a SIGN-IN WRAP (since 2026-10-10): no checkbox, no
  dialog. One sentence sits directly under the Search button, in the same
  block as the button, naming and linking all three documents, and pressing
  Search is the assent. That is the screen upheld in Meyer v. Uber. Notice
  sitting apart from the action is the weak pattern — Nicosia v. Amazon
  turned on exactly that — so the sentence may never move to the footer,
  shrink to a bare "Terms" link, or lose a document link. It is rendered word
  for word from PRE_SEARCH_NOTICE (packages/api-client/src/legalCopy.ts).
- Anonymous acceptance is never stored. Every search sends the current
  accepted_terms_version to POST /api/address/resolve; the endpoint serves a
  search that carries none (an older bundle) and refuses a stale or unknown
  one. Nothing about the acceptance is persisted — an anonymous visitor's IP
  and user agent are deliberately NOT collected, so the evidence is this file
  plus the deployed notice, not a row per search. Abuse of the endpoint is
  bounded by the per-IP rate limit, which never depended on this field.
- The device does not remember an anonymous acceptance either: there is no
  dialog to skip, and each search is its own assent. (The dialog era kept a
  90-day device memory so returning visitors were not re-asked; that code is
  gone with the dialog.)
- Notice at collection: the autocomplete forwards typed fragments after
  three characters, so collection begins before Search is ever pressed. The
  anonymous search field carries the "why full address" explainer in its own
  label (which repeats the short privacy note and links the Privacy Policy),
  and the agreement line under Search links the Privacy Policy by name. The
  short note itself sits beside the signed-in address form. (Until
  2026-10-10 a compressed copy of the note also sat under the anonymous
  field; it was cut as a second copy of what the explainer says.)
- The pre-search notice names the three documents and nothing else — see
  "Why arbitration is not named on any checkbox screen" below, and do not add
  a clause callout back to any label without reading that section first.
- All of this copy lives in packages/api-client/src/legalCopy.ts, and
  legalCopy.test.ts asserts every string still appears in this file. That suite
  also pins arbitration and the class-action waiver OUT of every label, so the
  restatement cannot creep back one screen at a time.
-->

# Checkbox and notice copy — Version 1.5

## Anonymous search notice (web and mobile, since 2026-10-10)

One sentence directly under the **Search** button, in the same block as the
button, with all three documents linked. Pressing Search is the agreement:
there is no checkbox, no dialog, and nothing to dismiss. On the web the links
open in a new tab so the typed address is not lost; in the app they open the
legal screens, and the address is still there on return.

> By clicking Search you agree to the [Terms of Use], [Privacy Policy], and
> [AI Research and Election Information Disclaimer].

### Archived: anonymous terms dialog (2026-08-30 to 2026-10-10)

Kept for the acceptances made against it. Web (2026-09-28 to 2026-10-10):
opened on the elections page when the search ran on a browser with no current
acceptance, with the list blurred behind it. Heading: **Your elections are
ready**. Body: the short privacy note, the checkbox and its three document
links, then **Cancel** and **Agree and show results**. Web before 2026-09-28
and mobile throughout: opened by pressing **Search**. Heading: **Before we
search**. Body: the two paragraphs below, the short privacy note, the checkbox
and links, then **Cancel** and **Agree and search**. The box was empty every
time it opened and the agree button stayed disabled until it was ticked.

> [ ] I have read and agree to the [Terms of Use], [Privacy Policy], and
> [AI Research and Election Information Disclaimer].

Dialog paragraphs (web until 2026-09-28, mobile until 2026-10-10):

> Elections Simplified provides AI-assisted informational research only. It is
> not an official election source, and results may be inaccurate, incomplete,
> outdated, or misleading.
>
> You must verify voting, registration, ballot, district, polling-place,
> deadline, and election-result information with official election authorities
> before relying on it.

### Why arbitration is not named on any checkbox screen

No label in this file — pre-search, signup, or re-acceptance — mentions
arbitration or the class-action waiver, and that is deliberate:

- What the clickwrap cases require is conspicuous notice of the **documents**
  plus an unambiguous act of assent, not a callout of any one clause. The Uber
  registration screen upheld in *Meyer v. Uber Technologies*, 868 F.3d 66 (2d
  Cir. 2017) read "By creating an Uber account, you agree to the TERMS OF
  SERVICE & PRIVACY POLICY" and never used the word "arbitration". An empty
  checkbox that gates the action clears that bar by a wider margin than Uber's
  click-to-continue did.
- Section 12 is stated once, in the Terms of Use. Restating it beside a
  checkbox repeats a linked document as a lawsuit warning on a screen someone
  came to for something else — a ballot lookup, an account, a version bump.
- What a Section 12 motion rests on is the assent evidence, not a clause
  restatement: for accounts, the `user_terms_acceptances` rows recording
  acceptance of the named documents; for anonymous searchers, this file plus
  the deployed gate.

The Terms of Use link beside each checkbox is what carries the whole of the
notice. It is not optional and it may not be demoted to the footer: the link,
named and adjacent at the moment of assent, is the basis on which Section 12
binds at all.

## Signup checkbox (account registration)

> [ ] I have read and agree to the [Terms of Use], [Privacy Policy], and
> [AI Research and Election Information Disclaimer].

## Re-acceptance checkbox (signed-in interstitial after a version bump)

> [ ] I have read and agree to the updated [Terms of Use], [Privacy Policy],
> and [AI Research and Election Information Disclaimer].

Rules for the interstitial (1.5, 2026-09-16): declining must not trap the
account. The modal carries a **log out** control, and it does not cover the
three legal pages, `/me/settings` (email/privacy preferences, delete account)
or `/me/membership` (cancel) on the web, nor `/legal/*`,
`/settings/security` (sign out, delete account) or
`/settings/email-preferences` in the app. A member who rejects the new terms
can therefore cancel, delete, or leave without first agreeing — Cal. Bus. &
Prof. Code §17602(d) forbids extra steps in front of online cancellation, and
consent extracted by blocking the exit is not consent. Everything else stays
gated until the box is ticked.

## Short privacy note (signed-in address form, and inside the explainer)

This carries the address-specific points that matter at collection. It carries
no Privacy Policy link of its own: the footer links the policy on every page,
the explainer links it directly, and the search notice under the button links
it by name — so a second inline copy sat next to the question people actually
ask and crowded it out. The 14-day lookup cache
and the "not sold" assurance are carried by Privacy Policy Section 1 rather
than repeated here, to keep this line to the two facts a visitor weighs while
typing — what the address is used for, and that it does not end up on their
account.

This line also replaced the longer privacy paragraph the pre-search dialog used
to carry. That paragraph summarised the whole of Privacy Policy Section 1 —
address, account data, device and usage data, purposes, legal compliance — one
click away from the policy it was summarising, and its opening clause ("we
collect the address you enter") implied retention the system does not perform:
the address is sent to the Census geocoder, held in an anonymous 14-day cache
in its normalised form, and never written to the database or attached to an
account, which stores district ids only.

> The address is only used to find voting districts. We do NOT save it to
> your account.

In the anonymous search field's label, **(why full address)** opens an
informational dialog on web and mobile. One paragraph: the ballot depends
on which voting districts a home sits in, and those boundaries do not follow
ZIP codes — they can split a neighborhood or a single street, so two homes in
the same ZIP can vote in different races. The dialog repeats the
address-handling summary, links to the Privacy Policy, and closes with **Got
it**. It has no checkbox or agreement button because it explains the field
rather than requesting consent.

## Results verification line (ballot and results screens)

Non-blocking, and deliberately not gated on acceptance: it has to reach the
people the clickwrap never did — a shared computer, someone else's phone, a
link from a text message.

> AI-assisted research. Verify voting information with official election
> authorities. [Disclaimer]

## Per-record source line (candidate records, measures, results)

> Source: [link]

## Notification email footer line

> Information is AI-assisted research; verify with official sources before
> voting.
