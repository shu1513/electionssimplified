<!--
Version must stay in lockstep with disclaimer.md and the backend's
CURRENT_TERMS_VERSION; the three documents are accepted together by one
checkbox. The contact mailbox (contact@electionssimplified.com) must exist and
be monitored before launch. Section 12 (governing law CA, individual
arbitration with opt-out, class waiver, mass-filing staging, 1-year claims
deadline) added 2026-07-18; Section 12.1/12.8 assume California is the
operator's principal place of business — update if that changes.
Section 14 (support payments and memberships) added 2026-08-21 (1.1 → 1.2,
docs/plans/membership-contributions.md); Contact renumbered 14 → 15. This is
a substance change, so the bundle version bumps: disclaimer.md, backend
CURRENT_TERMS_VERSION, and api-client TERMS_VERSION all move to 1.2 together,
which makes signed-in users re-accept once (TermsRenewalGate) and the
anonymous search gate re-ask once. Clients bundle TERMS_VERSION at build
time (web bundles in stale tabs, any distributed mobile build), so around a
bump some clients present the PREVIOUS version's documents. The backend
therefore accepts current-or-grace versions during rollout —
GRACE_TERMS_VERSIONS in backend/src/constants/legal.ts, shipped with this
bump listing "1.1" — recording whatever version the client actually showed;
the renewal gate brings accounts to 1.2 on their next fresh load. Empty the
grace list once the rollout has settled. Without it there is no
breakage-free deploy order in either direction (exact-equality checks cut
off stale web tabs and any old mobile build at registration, search, and
re-acceptance). This version must be LIVE before STRIPE_SECRET_KEY is ever set in
production. Cancellation copy matches the plan: portal cancel is
end-of-period; account deletion cancels immediately.
Section 14.5 (member communications) added 2026-08-28 (1.2 -> 1.3): monthly
members may receive member-only newsletters/analysis reports, so 14.1's
"no additional content, features, or influence" carve-out now excepts 14.5
while keeping the no-influence shield absolute. Substance change - the
bundle bumps to 1.3 (disclaimer.md, CURRENT_TERMS_VERSION, TERMS_VERSION),
GRACE_TERMS_VERSIONS ships listing "1.2", and signed-in users re-accept
once. Must be LIVE before the first member-only communication is sent.
Operator change 2026-08-29 (1.3 -> 1.4): the operator and contracting party
is now Elections Simplified Inc., a Delaware corporation (previously
impactperdollar). Principal place of business remains California, so the
Section 12.1/12.8 assumptions are unchanged. A change of contracting party
is material — the bundle bumps to 1.4 (disclaimer.md, privacy-policy.md,
CURRENT_TERMS_VERSION, TERMS_VERSION), GRACE_TERMS_VERSIONS ships listing
"1.3", and signed-in users re-accept once.
Legal audit 2026-09-16 (1.4 -> 1.5): user-favorable narrowing after the
September 16 legal/product-risk review. Section 1 notices are effective
"to the extent permitted by law"; Section 6 carves out AGPL-licensed
source, public-domain material, and third-party licenses; Section 7 links
the Google Maps Platform terms and privacy policy required by the Places
policies; Section 8 cap is restated as one aggregate cap measured from the
event (matching Disclaimer 17); Section 9 indemnity drops the
"reliance the Disclaimer warns against" prong and is limited to third-party
claims with notice/defense safeguards; Section 12.4 preserves regulator
complaints and public injunctive relief; Section 12.6 replaces the bespoke
bellwether staging with the AAA Mass Arbitration Supplementary Rules;
Section 13 feedback license is limited to non-personal suggestions.
Disclaimer 1.5 deletes the Section 18 prospective release. Every change
reduces what the user gives up, but the bundle is re-accepted once so the
acceptance record points at the text in force: CURRENT_TERMS_VERSION and
TERMS_VERSION move to 1.5, GRACE_TERMS_VERSIONS ships listing "1.4" only
(no mobile build has been distributed yet, so 1.2/1.3 have no live client).
-->

# Elections Simplified Terms of Use

**Last updated:** September 16, 2026
**Version:** 1.5

## 1. Acceptance of these Terms

These Terms of Use ("Terms") are an agreement between you and Elections Simplified Inc., a Delaware corporation and the operator of the Elections Simplified service ("Elections Simplified," "we," "us," or "our") governing your use of the Elections Simplified website and services (the "Service"). By checking an agreement box, creating an account, submitting an address or search, or otherwise using the Service, you accept these Terms, the [Privacy Policy](/privacy), and the [AI Research and Election Information Disclaimer](/disclaimer) (the "Disclaimer"), which is incorporated into these Terms by reference. You consent to entering this agreement electronically.

**Electronic communications and notices.** You consent to receive communications from us electronically — by email to your account address or by posting in the Service — and to the extent permitted by applicable law, you agree that all agreements, notices, disclosures, and other communications we provide electronically satisfy any legal requirement that they be in writing. Notices to you are effective when posted in the Service or sent to your account email, except where applicable law requires a different form or timing of notice; notices to us must be sent to contact@electionssimplified.com.

If you do not agree, do not use the Service.

## 2. Eligibility

You must be at least 18 years old to use the Service. By using it, you represent that you are 18 or older and legally able to enter this agreement.

## 3. The Service

Elections Simplified provides AI-assisted, nonpartisan informational research about elections, candidates, ballot measures, campaign finance, and voting districts. The nature, limitations, and proper use of that information — including that it is not official election information, not professional advice, and must be verified with official sources — are described in the Disclaimer, which controls on those subjects.

The Service is operated from the United States and is intended for users located in the United States. We make no representation that the Service or its content is appropriate or available for use in any other location, and we may restrict access from outside the United States.

## 4. Accounts

You agree to provide accurate account information and to keep your password confidential. You are responsible for activity under your account. Notify us promptly at contact@electionssimplified.com if you believe your account has been compromised. You may delete your account at any time in account settings; we may suspend or terminate accounts that violate these Terms.

## 5. Acceptable use

You agree not to:

- use the Service or its content for any purpose prohibited by Section 13 ("Prohibited misuse") of the Disclaimer, including voter suppression, voter deception, intimidation, harassment, impersonation of election officials, or unlawful discrimination;
- use campaign finance information obtained through the Service for prohibited solicitation or commercial use of contributor information;
- probe, disrupt, overload, or interfere with the Service, its security features, or its rate limits, or access it through automated means at volumes a person could not produce;
- scrape, harvest, resell, or republish the Service's content at scale, or misrepresent Elections Simplified content as official election information;
- attempt to access another person's account or data.

## 6. Intellectual property

The Service, including its software, design, compiled content, and derived metrics, is owned by Elections Simplified's operator or its licensors and is protected by law. We grant you a limited, revocable, non-exclusive, non-transferable license to use the Service for personal, non-commercial civic purposes. Public records and third-party sources referenced by the Service remain subject to their own terms.

Software we make available under an open-source license (the Elections Simplified source code is published under the GNU Affero General Public License v3.0) is governed by that license, and these Terms do not limit any right it grants. These Terms also do not restrict your rights in public-domain material, including government records, or in third-party material licensed under its own terms. No right to use the Elections Simplified name, logo, or domain is granted except as expressly permitted in writing.

## 7. Third-party services and links

The Service relies on and links to third-party sources and services described in the Disclaimer and the Privacy Policy. We are not responsible for third-party content or services, and a link does not imply endorsement.

Address suggestions are provided by Google Maps Platform (Places). By using that feature you also agree to the [Google Maps/Google Earth Additional Terms of Service](https://www.google.com/help/terms_maps/) and acknowledge the [Google Privacy Policy](https://www.google.com/policies/privacy/).

## 8. Disclaimers and limitation of liability

The warranty disclaimers, limitation of liability, and acknowledgment and assumption-of-risk provisions in Sections 16, 17, and 18 of the Disclaimer apply to these Terms as if set out in full here. THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," AND, TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF THE AMOUNT YOU PAID US FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE FIRST SUCH CLAIM OR ONE HUNDRED U.S. DOLLARS ($100). If the wording of this Section and Section 17 of the Disclaimer differ, this Section controls.

Nothing in these Terms or the Disclaimer excludes or limits liability that cannot be excluded or limited under applicable law, including liability for fraud, willful misconduct, or violations of law that applicable law does not permit a contract to exempt.

## 9. Indemnification

To the maximum extent permitted by law, you agree to indemnify and hold harmless Elections Simplified's operator and its officers, employees, and contractors from losses, liabilities, and reasonable expenses (including attorneys' fees) arising from a claim by a third party that is caused by your material violation of these Terms, your unlawful use of the Service, or content you submit that infringes or violates another person's rights. We will notify you promptly of any such claim, and you may not settle a claim in a way that imposes an obligation on us or admits fault on our behalf without our written consent. This Section does not apply to losses caused by our own breach, negligence, or misconduct.

## 10. Termination

You may stop using the Service at any time. We may refuse, limit, suspend, or terminate access to the Service (in whole or in part) at any time, with or without notice, in our discretion, including for violations of these Terms or to protect the Service, its users, or others. Sections that by their nature should survive termination — including Sections 6, 8, 9, 12, 13, and 14 — survive.

## 11. Changes to the Service or these Terms

We may modify or discontinue the Service at any time. We may update these Terms; the version and date above identify the current text. Continued use after an update means you accept it, and for material changes we may require renewed acceptance before continued use.

## 12. Governing law and disputes

**Please read this section carefully. It requires most disputes to be resolved by binding individual arbitration, waives class actions and jury trials, and shortens the time to bring claims. You can opt out of arbitration within 30 days (Section 12.7).**

**12.1 Governing law.** These Terms and any dispute arising from them or the Service are governed by the laws of the State of California, without regard to conflict-of-law rules, except that the Federal Arbitration Act governs the interpretation and enforcement of the arbitration provisions below.

**12.2 Informal resolution first.** Before starting arbitration or filing suit, the party raising a dispute must send the other a written notice describing the dispute and the relief sought (to us: contact@electionssimplified.com with subject "DISPUTE NOTICE"; to you: the email address on your account). The notice must be individualized to the dispute and personally signed by the party raising it (in addition to any counsel). Both parties must then attempt in good faith to resolve the dispute for 60 days, which includes, if either party requests one, a telephone or video settlement conference in which you and we each personally participate (each party's counsel may also attend). Completion of this process is a condition precedent to starting arbitration or suit. Applicable limitations periods are tolled during this period.

**12.3 Binding individual arbitration.** Any dispute arising from or relating to these Terms or the Service that is not resolved informally will be resolved by final and binding arbitration before a single arbitrator, administered by the American Arbitration Association under its Consumer Arbitration Rules, rather than in court. The arbitration will be conducted by videoconference unless the arbitrator determines an in-person hearing is necessary, in which case it will take place in the county where you reside. Fees are allocated as provided in the AAA Consumer Arbitration Rules. The arbitrator decides all issues except those reserved to courts in this Section.

**12.4 Exceptions.** Either party may (a) bring an individual claim in small claims court, or (b) seek injunctive or other equitable relief in court for infringement of intellectual property or for unauthorized access to, scraping of, or abuse of the Service. Nothing in this Section prevents you from reporting a concern to, or seeking relief from, a federal, state, or local government agency or regulator, and nothing in this Section waives any right to seek public injunctive relief that cannot be waived under applicable law; a claim for such relief that cannot be arbitrated will be decided by a court under Section 12.8 after the arbitrator has decided all arbitrable individual claims.

**12.5 Class action and jury waiver.** Both parties waive the right to a jury trial and the right to litigate or arbitrate any claim as a class, collective, consolidated, private-attorney-general, or representative action. Claims may be brought only in an individual capacity. If this class waiver is held unenforceable as to a particular claim, that claim — and only that claim — must proceed in court under Section 12.8, not in arbitration.

**12.6 Coordinated filings.** If 25 or more arbitration demands raising substantially similar claims are filed by the same counsel or coordinated counsel, the AAA's Mass Arbitration Supplementary Rules apply in addition to its Consumer Arbitration Rules, and the demands will be administered under them. Limitations periods are tolled for any demand while it is pending under those rules. If the AAA is unavailable or declines to administer the arbitration, the parties will agree on a substitute administrator, or a court under Section 12.8 will appoint one.

**12.7 Arbitration opt-out.** You may reject the arbitration provisions (Sections 12.3, 12.6, and the arbitration portion of 12.5) by emailing contact@electionssimplified.com with the subject "ARBITRATION OPT-OUT" and your name within 30 days of first accepting these Terms. If you have an Elections Simplified account, include your account email; if you do not, send the opt-out from the email address you want the opt-out associated with, and your opt-out applies to your use of the Service from then on. Opting out does not affect any other provision of these Terms.

**12.8 Venue.** Any dispute that is not subject to arbitration will be brought exclusively in the state or federal courts located in California, and both parties consent to personal jurisdiction and venue there.

**12.9 Claims deadline.** To the maximum extent permitted by applicable law, any claim arising from or relating to these Terms or the Service must be filed within one (1) year after it accrues, or it is permanently barred. Where applicable law does not permit a one-year period, the shortest period permitted by that law applies.

## 13. Miscellaneous

If any provision of these Terms is held unenforceable, the remainder stays in effect. Our failure to enforce a provision is not a waiver. These Terms, the Privacy Policy, and the Disclaimer are the entire agreement between you and us about the Service. You may not assign these Terms; we may assign them in connection with a reorganization or transfer of the Service. If you send us feedback, suggestions, or ideas about how to improve the Service, we may use those suggestions without restriction or obligation to you; this does not apply to personal information, content reports, Ask questions, or account data, which are governed by the Privacy Policy.

**Force majeure.** We are not responsible or liable for any delay or failure in performance resulting from causes beyond our reasonable control, including natural disasters, power or internet failures, acts of government, labor disputes, war, terrorism, civil unrest, epidemics, or failures of third-party services or data sources.

**No third-party beneficiaries.** These Terms are for the benefit of you and us only; they do not create rights in any other person.

**Copyright complaints.** If you believe content on the Service infringes your copyright, send a notice containing the information required by 17 U.S.C. § 512(c)(3) to contact@electionssimplified.com with the subject "COPYRIGHT NOTICE." We may remove or disable access to the identified material and may terminate accounts of repeat infringers.

## 14. Support payments and memberships

**14.1 What payments are — and are not.** You may choose to support the Service with a one-time payment or a recurring monthly membership. Payments are entirely optional and fund the operation of the Service. They are **not** contributions to, and do not benefit, any candidate, campaign, political committee, party, or charity; except for the member communications described in Section 14.5, they provide no additional content or features, and they never provide influence over the Service's information; and they are not charitable contributions — do not treat them as deductible.

**14.2 Billing.** Payments are processed by Stripe, and you must provide accurate payment information. A monthly membership charges the amount you selected (at or above the posted minimum) to your payment method each month, starting when you subscribe and continuing until canceled. Amounts are in U.S. dollars and exclude any taxes that may apply. We may change posted minimums prospectively; your existing membership amount does not change unless you change it.

**14.3 Cancellation.** You can cancel your membership at any time from account settings under Manage membership. Cancellation takes effect at the end of the current billing period; you will not be charged again after cancellation, and no partial-month refund is owed. Deleting your account cancels any active membership immediately. If a recurring charge fails, we may treat the membership as lapsed after Stripe's retries are exhausted.

**14.4 Refunds.** Except where required by law, payments are non-refundable; we may issue refunds in our discretion (for example, for duplicate or mistaken charges). Contact contact@electionssimplified.com for billing questions.

**14.5 Member communications.** Monthly members may receive member-only communications from us at the email address on their account, such as newsletters or analysis reports. These communications are informational only and are part of the Service: the Disclaimer applies to them, and they reflect our independent editorial judgment. No payment gives any person influence over the Service's information or over what these communications say. We choose their content, format, and frequency, and we may change or discontinue them at any time; their availability, timing, or discontinuation does not create a right to a refund beyond Section 14.4.

## 15. Contact

Questions about these Terms: contact@electionssimplified.com.
