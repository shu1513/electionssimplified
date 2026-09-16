<!--
Written to match the ACTUAL data practices
in this codebase as of July 2026 — if practices change (analytics,
advertising, new processors, address retention), this document must change
with them. The contact mailbox (contact@electionssimplified.com) must exist and
be monitored before launch. Analytics disclosure added 2026-07-05 ahead of
adoption; once a specific analytics provider is chosen, name it in Section 3
and confirm the "no advertising use" configuration claims hold for it.
Ask/OpenAI disclosure added 2026-08-12 (chatbot Phase 2): this version must be
LIVE before CHATBOT_LLM_ENABLED is ever turned on in production
(docs/plans/chatbot-rag.md). The Ask question-log description matches
backend/src/chatbot/ (anonymous, redacted, 90-day purge, low-count
suppression); the OpenAI description matches the adapter (store:false, no
raw identifiers).
Google Sign-In disclosure added 2026-08-12 (1.1 → 1.2,
docs/plans/google-sign-in.md): this version must be LIVE before
GOOGLE_OAUTH_CLIENT_ID is ever set in production. The description matches
backend/src/auth/googleIdToken.ts + loginWithGoogle: ID-token only (sub,
email, verified/hosted-domain status, optional first name), no Google
access/refresh tokens, no Google API calls, google_sub deleted with the
account. 1.2 is a clarifying addition for an OPTIONAL sign-in method —
CURRENT_TERMS_VERSION deliberately stays 1.1 (no forced re-acceptance).
Support-payments disclosure added 2026-08-21 (1.2 → 1.3,
docs/plans/membership-contributions.md): this version must be LIVE before
STRIPE_SECRET_KEY is ever set in production. The description matches the
plan's schema: Stripe holds card data, we hold amounts/dates/kind/refund
status/Stripe reference ids in billing_* tables, and those rows survive
account deletion unlinked from the account (billing_customers.user_id set
NULL) for accounting and legal compliance. The retained Stripe ids remain
resolvable to a person through the Stripe dashboard, so those rows are
pseudonymous business records, not anonymous data — the public text below
deliberately says "with the link to your deleted account removed" and never
claims anonymization. Unlike 1.2, this change ships together with
a Terms bump (payments section) — see terms-of-use.md.
Operator change 2026-08-29 (1.3 → 1.4): operator named as Elections
Simplified Inc., a Delaware corporation (previously impactperdollar).
Ships with the Terms 1.4 bump — see terms-of-use.md.
First-party usage analytics added 2026-09-04 (1.4 → 1.5,
docs/plans/usage-analytics.md): this version must be LIVE before
USAGE_ANALYTICS_ENABLED is ever set in production. The description matches
backend/src/usage/events.ts and frontend/src/lib/usage.ts: per-tab session
id in sessionStorage (no cookie, 30-minute idle rotation), route ids never
paths, no user/address/district/candidate/election ids, 90-day purge, and
the /privacy opt-out control. Like 1.2, a disclosure of a practice that
identifies nobody — CURRENT_TERMS_VERSION stays 1.4.
1.5 → 1.6 on 2026-09-10 (open-source readiness): names the stored picks
and the shared pick cards (public_pick_card_shares, first name, live view,
"Stop sharing" on /me/picks = DELETE /api/me/pick-card-shares); scopes any
future promotional content to research-area interests only, never picks or
follows (the old wording read as pick-targeted); adds section-into-view to
the analytics list (section_exposed in backend/src/usage/events.ts).
Clarifications of existing practice, nothing new collected —
CURRENT_TERMS_VERSION stays 1.4.
1.6 → 1.7 on 2026-09-12 (mobile store release, docs/mobile-release.md):
names the mobile push notification tokens (user_push_tokens: expo token,
native APNs/FCM token, platform, last_seen_at; revoked on logout, CASCADE on
account delete — mobile/src/lib/pushNotifications.ts) and the push
processors (Expo push service, APNs, FCM) that receive the token and
notification text only. This version must be LIVE before the app is
submitted to either store. Disclosure of an opt-in feature —
CURRENT_TERMS_VERSION stays 1.4.
1.7 → 1.8 on 2026-09-16 (legal audit): (1) the Ask log sentence no longer
calls the logs "anonymous" — backend/src/chatbot/redact.ts is four regexes
(email, phone, street address, 5+ digits) and cannot remove names or
identifying narrative, so the text now says what it does and warns that
free text can still identify someone; (2) the picks/follows sentence no
longer says "never disclose them to third parties" — the digest and
newsletter bodies (first name, followed candidates) pass through the SES
processor, so it now says no sale and no disclosure to advertisers,
campaigns, or political organizations, with processors handled in
Section 3; (3) the OpenAI entry says store:false disables response storage
but OpenAI may keep abuse-monitoring logs for up to 30 days (its
documented default); (4) content reports: free text is kept as written and
can contain identifying details; (5) Google Places entry links the Google
Privacy Policy as the Places policies require. Corrections of overclaims,
nothing new collected — ships with the Terms 1.5 bump, which re-accepts
the bundle anyway.
-->

# Elections Simplified Privacy Policy

**Last updated:** September 16, 2026
**Version:** 1.8

This Privacy Policy describes how Elections Simplified Inc., a Delaware corporation and the operator of the Elections Simplified service ("Elections Simplified," "we," "us"), collects, uses, and shares information when you use the Elections Simplified website and services (the "Service").

## 1. Information we collect

**Address and search input.** When you enter an address, we process it to determine your voting districts. The address is sent to geocoding services (see Section 3) and may be held in a server-side cache for up to 14 days to speed up repeat lookups; this cache is not linked to your account. What we store on your account is the resulting **list of districts** — not your street address. We do not maintain a saved-address book.

**Account information.** If you create an account: your email address, first name, and a cryptographic hash of your password (we never store the password itself). We also record which version of our terms you accepted and when.

**Sign in with Google (optional).** If you choose to sign up or sign in with your Google account, we receive from Google a signed identity token containing your stable Google account identifier, your Google account email address and its verification status (including whether it belongs to a Google Workspace organization), and optionally your first name. We store the identifier to recognize your sign-in and the email address and first name as your account information above. We receive **no** Google access or refresh tokens, cannot access your Google data (mail, contacts, files), and make no ongoing requests to your Google account. An account created with Google has no password until you set one (see Section 6).

**Support payments (optional).** If you choose to support the Service with a one-time payment or a monthly membership, the payment is processed by Stripe (see Section 3); you enter your card details on Stripe's payment pages, and your card number never reaches our servers. Stripe's payment notifications to us may include limited billing details (such as the name and email address you gave Stripe), which we do not store. What we store is the payment amount, date, type (one-time or monthly), refund status, and Stripe reference identifiers, linked to your account.

**Preferences and activity.** Settings you choose: candidates you follow, research-area interests, ballot ordering preferences, and email notification opt-ins.

**Mobile app and push notifications.** If you use the Elections Simplified app for iPhone or Android and allow notifications, we store a push notification token for that device (an identifier issued by Apple, Google, or the Expo push service that lets us send notifications to that device, not to you by name), the device platform (iOS or Android), and when the token was last registered or refreshed. The token is linked to your account so notifications about candidates you follow reach your devices. Signing out on a device marks that device's token as revoked, and we stop sending to it; deleting your account removes the stored tokens. The app stores your sign-in session on the device in the operating system's secure storage.

**Your picks.** If you record a pick for a race or a position on a ballot measure, we store it on your account so your ballot draft is there when you return. Because the Service is about elections, your picks, follows, and interests may reveal your civic or political views. We treat them as your private account data: we never sell them, and we never disclose them to advertisers, campaigns, or political organizations for their own purposes. They are visible outside our systems only through a pick card you choose to share (described below), through the service providers in Section 3 that process data on our behalf (for example, the email provider that delivers a notification email whose contents name a candidate you follow), and in the legal-disclosure situations described in Section 3. We use them to provide the features you chose and to select relevant civic updates for the notification emails you control in settings. If those emails ever include clearly labeled promotional content from a civic organization, it is chosen only from the research-area interests you selected (for example, an environmental group for someone who chose the environment as an interest), never from your picks or the candidates you follow. Every such email includes a working unsubscribe link, and the data used to choose them never leaves us.

**Shared pick cards (optional).** If you click Share on a date's pick card, we create a link that shows anyone who has it the picks on that card for that date, together with your first name. The card is live: it shows your picks as they stand when the link is opened. Nothing is shared until you click Share, and you can stop sharing at any time from your picks page, which makes the link stop working. Deleting your account removes every shared link.

**Ask (chat) questions.** If you use the Ask feature, the questions you type are processed to find an answer in our own election database. We do not attach your account identifier to stored question logs. Before a question is stored, automated filters attempt to remove common email-address, phone-number, street-address, and long-number patterns; these filters may not remove all personal information, and free text you type can still identify you or another person. Please don't include personal information in your questions. Stored question text is deleted after 90 days; only aggregate statistics about commonly asked questions (never rare or unique ones) are kept longer.

**Content reports.** If you report inaccurate or outdated content, we store the report message, the content item you identified, any optional source URL, any optional contact email you provide, and if you are signed in, your account identifier, so we can investigate and improve accuracy. The report message is kept as you wrote it, so it can contain identifying details if you include them. Do not include sensitive personal information in content reports.

**Technical information.** IP address, browser user agent, and request logs collected automatically for security, rate limiting, and abuse prevention. A session cookie (httpOnly) keeps you signed in. We do not use advertising or cross-site tracking cookies.

**Usage analytics.** We collect information about how the Service is used so we can improve it: which kinds of pages are viewed (the page type, never the full web address), which site controls are used, which sections of a page come into view as you scroll (for example, a candidate's finance section), how long a page stays visible, coarse device type (phone, tablet, or desktop), the general kind of site that referred you (a search engine, a social network, or none), the U.S. state and rough size of a ballot you looked at, and whether an action such as an address search succeeded or failed. This is collected by us, on our own infrastructure, with no third-party analytics service. It is tied to a random identifier that lives only in your browser tab, is not a cookie, resets after 30 minutes of inactivity, and is never linked to your account, your email, your address, the districts, candidates, or elections you looked at, or the choices you record. Analytics data is not used to build advertising profiles and is not shared with advertisers. You can turn it off for your browser (see Section 5).

## 2. How we use information

To provide the Service (find your districts, show your ballot, send notification emails you opted into); to secure the Service (authentication, rate limiting, abuse prevention); to understand and improve how the Service is used (analytics); to communicate with you about your account (verification, password reset, email-change confirmation); and to comply with law. We do **not** sell personal information, share it for cross-context behavioral advertising, or use it to build advertising profiles.

## 3. Service providers

We share information only with the processors needed to run the Service:

- **U.S. Census Bureau geocoder** — receives the address text you enter, to locate your districts.
- **Google Places (autocomplete)** — receives the address text you type when address suggestions are enabled; requests are proxied through our servers so Google does not receive your IP address from your browser. Google's handling of that text is described in the [Google Privacy Policy](https://www.google.com/policies/privacy/).
- **Google (Sign in with Google)** — when you choose to sign in with Google, your browser interacts with Google directly to complete the sign-in (Google's own privacy policy applies to that interaction), and we receive the identity token described in Section 1. We send Google nothing about your activity in the Service.
- **Amazon Web Services (SES)** — receives your email address to deliver account and notification emails.
- **Expo push service, Apple Push Notification service, and Google Firebase Cloud Messaging (mobile push notifications)** — when you allow notifications in the mobile app, receive the device push token and the notification text in order to deliver it to your device. They receive no account information.
- **Usage analytics** — the usage information described in Section 1 is collected and stored by us on the infrastructure providers listed below; no separate analytics company receives it.
- **OpenAI (AI answers in Ask)** — when AI-generated answers are enabled for the Ask feature, receives the text of your chat question and the snippets of our own election data used to answer it, together with a pseudonymous account identifier (a cryptographic hash used only for abuse prevention — never your email address, name, or address). We send requests with response storage disabled, and under OpenAI's API terms this content is not used to train OpenAI's models; OpenAI may retain API request logs for up to 30 days for abuse and misuse monitoring under its data-retention policy. Personal information you type into a question is sent to OpenAI as part of that question, so please leave it out. AI answers are labeled as AI-generated in the Service.
- **Stripe (support payments)** — if you choose to make a support payment, Stripe collects your card and billing details directly on its own payment pages (we never receive your card number) and processes the payment, any recurring membership billing, and any refund on our behalf. We receive the payment amount, status, and reference identifiers. Stripe also retains payment records under its own legal obligations; see Stripe's privacy policy at stripe.com/privacy.
- **Sentry (error monitoring)** — when error monitoring is enabled, receives reports about application errors (error type, stack trace, browser and device type, and the page path with its query string removed) so we can find and fix failures. We configure these reports to exclude your IP address, email address, address text, and the contents of your requests.
- **Infrastructure providers** — hosting, database, and cache providers that store Service data on our behalf.

Each receives only what its function requires. We do not share personal information with data brokers, advertisers, campaigns, or political organizations.

We may also disclose information if we believe in good faith that disclosure is required by law, subpoena, or other legal process, or is necessary to protect the rights, property, safety, or security of the Service, our users, or others, or to detect, prevent, or address fraud, abuse, or security issues. If the Service or its operator is involved in a merger, acquisition, reorganization, or sale of assets, account information may be transferred as part of that transaction; this Privacy Policy will continue to apply to it. The Service is operated from the United States, and information is processed and stored in the United States.

## 4. Retention and deletion

Account data is kept while your account is active. If you delete your account, your account record and its associated data — email address, name, the Google account identifier if you signed in with Google, saved districts, follows, preferences, mobile push notification tokens, and notification history — are deleted immediately: sessions are destroyed, notification sending stops, and your email address is released for re-registration. Content reports you submitted while signed in are kept for moderation purposes with your account identifier and contact email removed. If you made support payments, any active membership is canceled when you delete your account, and the payment records described in Section 1 (amounts, dates, type, refund status, and Stripe reference identifiers) are retained for accounting, tax, and legal-compliance purposes with the link to your deleted account removed; Stripe separately retains its payment records under its own legal obligations. Residual records may persist in backups and security logs for a limited period before being purged. Cached address lookups expire automatically. Notification event records are pruned on a rolling schedule. Usage analytics events are deleted 90 days after they are received; only aggregate statistics that identify no browser or session are kept longer.

## 5. Your choices

You can view and update your name, email address, password, districts, follows, and email preferences in account settings; you can change or remove your picks and stop sharing any pick card link from your picks page; every notification email includes a working unsubscribe link; and you can delete your account entirely in settings. You can turn usage analytics off for your browser with the control at the bottom of this page; the choice is remembered in your browser, and we honor opt-out mechanisms where required by applicable law. For access or deletion requests you cannot complete in the app, or questions about this policy, contact contact@electionssimplified.com. Depending on where you live, you may have additional privacy rights (such as access, correction, deletion, or portability); we honor valid requests as required by applicable law.

## 6. Security

Passwords are stored using a modern memory-hard hashing algorithm; sessions use httpOnly cookies; email-verification, password-reset, and email-change links are single-use and expire; and account-sensitive actions require your password and are rate limited. An account created with Sign in with Google has no password until you set one; changing your email or deleting your account then requires setting a password first (account settings link to the emailed set-a-password flow). No system is perfectly secure — use a unique password.

## 7. Children

The Service is not directed to children and requires users to be at least 18. We do not knowingly collect personal information from children under 13; if you believe a child has provided us personal information, contact contact@electionssimplified.com and we will delete it.

## 8. Changes

We may update this Privacy Policy; the version and date above identify the current text. For material changes we will provide notice in the Service and may require renewed acceptance.

## 9. Contact

Elections Simplified (operated by Elections Simplified Inc.) — contact@electionssimplified.com
