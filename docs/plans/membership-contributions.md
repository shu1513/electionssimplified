# Membership & one-time support payments

Let signed-in users support the app with a custom monthly membership or a one-time payment — both minimum $5, both capped at $1,000 per transaction (the cap is shown in the UI when exceeded, not silently rejected). Every dollar is recorded in our own database: who paid, how much, when, and refunds. Stripe handles all card data; we store references only.

Not a nonprofit. UI copy must say the money supports operating the service — never candidates, campaigns, committees, parties, or charities — and must never claim charitable deductibility. Brand in UI copy is **Elections Simplified** (VoteApp is the internal repo name). Use "support" / "supporter" / "membership" in customer-facing copy — avoid "contribution"/"donation", which read as political/charitable in this product. No content is ever gated behind membership; perks are recognition only (out of scope for v1).

## Stripe facts this plan relies on (verified 2026-08-21)

- Checkout `custom_unit_amount` (pay-what-you-want prices) is **one-time only** ([docs](https://docs.stripe.com/payments/checkout/pay-what-you-want)). Custom monthly amounts instead use inline `price_data` with a dynamic `unit_amount`, which works in both `mode: "payment"` and `mode: "subscription"` (`recurring: {interval: "month"}`). One mechanism for both flows: user types a dollar amount in *our* UI, backend creates the session. Server enforces minimums.
- Webhook signature verification (`stripe.webhooks.constructEvent`) needs the **exact raw request body** — add an `express.raw` branch for the webhook path ahead of `createJsonBodyParser()` (already path-scoped).
- Stripe **does not guarantee webhook event order** and retries failed (non-2xx) deliveries for up to ~3 days ([docs](https://docs.stripe.com/webhooks)). Handlers must be idempotent and must not trust event arrival order for state.
- The SDK's pinned API version does **not** pin webhook payload shapes — the webhook endpoint's own configured API version controls those ([versioning](https://docs.stripe.com/api/versioning)). Pin the endpoint version when creating it (prod checklist): set it to the exact `YYYY-MM-DD.codename` version the installed SDK pins (printed in the stripe-node release notes; not the npm package number).
- Stripe-hosted customer portal gives cancel + card-update UI; its **defaults allow customers to edit email/name and switch plans** — configure it explicitly ([portal config](https://docs.stripe.com/customer-management/configure-portal)).
- Fees 2.9% + 30¢ per domestic card charge → a $1 payment loses ~33% to fees. Hence $5 minimum on one-time too (~9% at $5).
- SDK: `stripe` npm package v22.x.

## Account-deletion constraint (drives the schema)

Account deletion is a **hard delete** — `DELETE FROM users` with `ON DELETE CASCADE` on every user-owned table ([authService.ts:1275](backend/src/auth/authService.ts#L1275)), promised by the privacy policy. So:
- Payment history must NOT reference `users.id` directly: a `NOT NULL` FK would block deletion; a cascade would erase accounting records we are legally required to keep.
- Solution: a `billing_customers` indirection row. On account deletion its `user_id` is set NULL — payment records survive as accounting data unlinked from any account (amounts, dates, Stripe refs; no name/email in our DB). Be precise about what this is: the retained Stripe ids can still be resolved to a person through the Stripe dashboard, so these rows are **pseudonymous business records, not anonymous data** — retained under the accounting/tax/legal basis the privacy policy §4 states, accessible only to whoever holds DB + Stripe credentials (the operator). Never call them "anonymized".
- Deletion flow must **cancel any nonterminal subscription first** — any Stripe status other than `canceled`/`incomplete_expired`, since even an `incomplete` one can still activate within its 23-hour window (Stripe would otherwise keep charging a card for a deleted account) — then let `user_id` null out. Cancellation is a **precondition**: if the Stripe cancel call fails, the delete request fails with a retryable error ("couldn't cancel your membership — try again in a few minutes") and no DB rows are touched. This keeps the Terms §14.3 promise ("deleting your account cancels any active membership") true without building a retry queue — the user retries, and cancel is idempotent, so the cancel-succeeded-but-delete-failed half-state is harmless (the retry's re-cancel is a no-op). Users with no live subscription (the vast majority) are unaffected.

## Data model — migration 250 (next free number at write time)

```sql
-- Indirection that survives account deletion.
CREATE TABLE billing_customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,  -- nullable
    stripe_customer_id text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Ledger: one row per successful charge, monthly and one-time alike.
CREATE TABLE billing_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    billing_customer_id uuid NOT NULL REFERENCES billing_customers(id),
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    currency text NOT NULL DEFAULT 'usd',
    kind text NOT NULL CHECK (kind IN ('one_time', 'monthly')),
    stripe_payment_ref text NOT NULL UNIQUE,  -- payment_intent id (one-time) or invoice id (monthly)
    -- Always populated, for both kinds: refund events identify a
    -- charge/payment_intent, never an invoice, so this is the join key for
    -- refunds. One-time: same value as stripe_payment_ref. Monthly: resolved
    -- at insert time via the invoice's payments (expand `payments` on the
    -- invoice, or list /v1/invoice_payments?invoice=... — invoice.payment_intent
    -- itself was removed in 2025-03-31+ API versions); our invoices are
    -- Checkout card subscriptions paid in full by one payment, so expect
    -- exactly one succeeded payment — zero found means we caught Stripe
    -- mid-settlement, return 5xx and let the retry find it; multiple, take
    -- the succeeded one and log.
    stripe_payment_intent_id text NOT NULL UNIQUE,
    refunded_amount_cents integer NOT NULL DEFAULT 0
        CHECK (refunded_amount_cents >= 0),
    refunded_at timestamptz,
    CHECK (refunded_amount_cents <= amount_cents),
    paid_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_payments_customer_paid_at_idx
    ON billing_payments (billing_customer_id, paid_at DESC);

-- One row PER SUBSCRIPTION, append-only across a customer's lifetime: a
-- cancel + resubscribe adds a row, never overwrites one. This is what
-- preserves consent evidence — CA BPC §17602 wants consent verification
-- retained ≥3 years (or 1 year past termination), and a single
-- row-per-customer would overwrite the prior subscription's consent
-- pointer on resubscribe. "Current membership" = the one nonterminal row.
CREATE TABLE billing_subscriptions (
    stripe_subscription_id text PRIMARY KEY,
    billing_customer_id uuid NOT NULL REFERENCES billing_customers(id),
    -- Consent evidence pointer (CA auto-renewal law): the Checkout Session
    -- that carried the renewal-terms consent checkbox. Stripe retains the
    -- session (with its consent record) retrievably; we keep the id, one
    -- per subscription, for the life of the row.
    stripe_checkout_session_id text,
    -- §17602 post-purchase acknowledgment: set when the membership-started
    -- email (renewal terms + how to cancel) was sent. NULL = not yet sent;
    -- the next subscription webhook poke retries the send.
    acknowledgment_sent_at timestamptz,
    monthly_amount_cents integer NOT NULL CHECK (monthly_amount_cents >= 500),
    stripe_status text NOT NULL,           -- raw Stripe status verbatim
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    current_period_end timestamptz,
    started_at timestamptz NOT NULL,
    canceled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one live subscription per customer, enforced by the DB itself
-- (the webhook duplicate-sub guard cancels the loser of a race; this index
-- is the backstop that makes the invariant impossible to violate).
CREATE UNIQUE INDEX billing_subscriptions_one_live_per_customer_idx
    ON billing_subscriptions (billing_customer_id)
    WHERE stripe_status NOT IN ('canceled', 'incomplete_expired');
```

- "Is this user a paid member" = join through `billing_customers` to the customer's nonterminal subscription row where `stripe_status IN ('active', 'past_due')` (`past_due` keeps member treatment during the retry window; everything else — `canceled`, `incomplete`, `unpaid`, etc. — is not a member). Raw status is stored verbatim so new Stripe statuses never break the schema.
- `stripe_payment_ref UNIQUE` = idempotent ledger writes under webhook retries (`ON CONFLICT DO NOTHING`).
- Totals shown to users = `SUM(amount_cents - refunded_amount_cents)` (net).
- All identifiers ≤ 63 chars.

## Backend

New module `backend/src/api/membership/` (service + helpers), wired through `AddressApiServerOptions` like existing features (see `getAuthenticatedEmailPreferences`: option injected in `runAddressApiServer.ts`, handler in `apiServer.ts`). Stripe client injected at the service boundary so tests mock it without network.

### Endpoints

First three: `requireVerifiedAuthenticatedUser` + JSON-parser path list. Webhook: public predicate list, signature-verified, raw body, **exempted from the global per-IP rate limiter** (`app.use(createRateLimitMiddleware…)` applies to every path and buckets by IP — Stripe's shared delivery IPs would 429 under the 60/min default).

1. `GET /api/me/membership` — `{ enabled, stripeStatus, monthlyAmountCents, cancelAtPeriodEnd, currentPeriodEnd, totalNetCents, payments: [...latest 50] }`. When Stripe isn't configured returns `{ enabled: false }` (frontend hides the whole section — no broken UI, no separate feature flag).
2. `POST /api/me/membership/checkout` — body `{ kind: 'monthly' | 'one_time', amountCents }`.
   - Validate: integer; ≥ 500 both kinds; ≤ 100_000 (=$1,000 card-testing cap — raise later if a real supporter asks).
   - Monthly while a subscription row is in a live status → 409 (amount change = cancel in portal, resubscribe; portal plan-switching is disabled).
   - Get-or-create `billing_customers` row + Stripe customer, then create the session:
     - `line_items[0].price_data`: `{currency: 'usd', product: STRIPE_MEMBERSHIP_PRODUCT_ID, unit_amount, recurring?}`; one dashboard-created Product shared by both flows.
     - `payment_method_types: ['card']` — cards only in v1, so no async-payment-method events (`checkout.session.async_payment_*`) to handle.
     - `customer`, `client_reference_id` = billing_customer_id; `metadata: {billingCustomerId, kind}` on the session, mirrored into `payment_intent_data.metadata` (one-time) / `subscription_data.metadata` (monthly). Internal billing id in metadata, never raw user id.
     - `success_url`/`cancel_url` → settings page `?membership=success|canceled`.
     - `expires_at` = 30 minutes (Checkout's minimum) — a stale tab can't complete a forgotten session hours later.
     - Monthly only — **California auto-renewal consent (BPC §17602)**: `consent_collection.terms_of_service: 'required'` plus `custom_text.terms_of_service_acceptance.message` stating, next to the unchecked box, the selected amount, that it renews monthly until canceled, and that cancellation is available anytime in account settings, with a link to the Terms. The completion handler verifies `session.consent` is present and stores the session id on `billing_subscriptions.stripe_checkout_session_id` — Stripe retains the session with its consent record, which is the retained proof §17602 wants. A completion arriving **without** consent (should be impossible — Stripe enforces `required`) fails closed: cancel the subscription and record its canceled state, because continued billing without retained consent evidence is exactly what §17602 forbids; the already-charged first month is refunded manually, like the guard cancels. (Requires the Terms URL configured in the Stripe dashboard's public details — rollout item.)
   - Frontend disables the button while the request is in flight (double-click guard); a rarer cross-tab race is closed by the webhook guard below. A user who deliberately completes checkout twice has genuinely paid twice: the guard cancels the second subscription's future charges, and its already-charged first month is refunded manually from the dashboard (visible in the ledger).
3. `POST /api/me/membership/portal` — portal session, `return_url` → settings. 404 without a billing customer.
4. `POST /api/stripe/webhook` — verify signature; response policy:
   - `400`: bad signature/payload.
   - `2xx`: event ignored, or DB transaction committed.
   - `5xx`: transient DB/internal failure → Stripe retries (this is the delivery guarantee; "always 200" would silently drop payments).
   Events:
   - `checkout.session.completed` (`mode: payment`) → insert ledger row (`one_time`, ref = payment_intent).
   - `checkout.session.completed` (`mode: subscription`) → **fetch the subscription from Stripe and upsert `billing_subscriptions` keyed by subscription id** from that current state (no ledger row here — first month's row comes from `invoice.paid`; writing it in both places double-counts). A resubscribe therefore adds a new row; old rows are never touched (consent history).
   - **Membership-started acknowledgment email** (§17602's retainable post-purchase acknowledgment — a Stripe receipt alone doesn't carry cancellation policy): when a subscription row first reaches a live status and `acknowledgment_sent_at IS NULL`, send one SES email (existing mailer infra) stating the monthly amount, that it renews monthly until canceled, how to cancel (settings → Manage membership), and linking the Terms; then stamp `acknowledgment_sent_at`. On a failed send the column stays NULL and the webhook fails retryably (5xx) — Stripe redelivers that event with backoff for days, and any later subscription poke also retries, so the legally required notice never depends on a future event happening to arrive. A send that succeeded but failed to stamp may re-send on retry; a rare duplicate acknowledgment beats a lost one.
   - `customer.subscription.created` / `.updated` / `.deleted` → same treatment: the event is a poke, the fetched subscription object is the truth. This makes out-of-order delivery harmless — every handler writes current reality, not the event's snapshot.
   - `invoice.paid` (subscription invoices, amount > 0) → ledger row only (`monthly`, ref = invoice id). Never flips membership status — status recovery arrives via its own `subscription.updated` event.
   - `charge.refunded` (the **only** refund event we subscribe to) → find the ledger row by the charge's `payment_intent` and **set** `refunded_amount_cents = charge.amount_refunded` — Stripe's cumulative figure, an absolute assignment, never an increment. That one choice makes the handler idempotent under retries, correct for partial refunds, and self-correcting when a pending refund later fails (a `refund.created` handler would count refunds that never succeed, and listening to two refund events would double-apply). `refunded_at` = first time the value goes above zero. Not subscribed: `refund.created`/`refund.updated`/`refund.failed` (all folded into the charge's cumulative number) and `invoice.payment_failed` (status arrives via `subscription.updated`). Disputes: log + handle manually in the dashboard (volume will be ~0).
   - Duplicate-subscription guard: on subscription upsert, if the billing customer already has a **different** live subscription id, cancel the newly arrived one via API and log — closes the concurrent-checkout race without reservation machinery.
   - Deleted-account guard: on any subscription upsert where the billing customer's `user_id IS NULL` (account already deleted — e.g. a checkout tab completed after deletion), cancel the subscription at Stripe immediately. Same one-line check closes the deletion↔checkout race without deletion-pending states or locks. A one-time completion for a deleted account just records its ledger row (no recurring harm; refund manually if the person asks).
   - Unknown event types → 200 + log. Unmatched `charge.refunded` (no ledger row for its `payment_intent` yet — delivery order isn't guaranteed, the refund can arrive while `invoice.paid` is still retrying) → **5xx**, so Stripe redelivers until the ledger row exists; every charge on this account comes from our checkouts, so it always eventually matches.

### Email-change integration

Stripe locks an existing customer's email in Checkout and sends receipts to it, so the customer object must track the account email. After a verified email change commits, `authService.verifyEmailChange` calls a best-effort membership hook that pushes the new address via `customers.update` — a Stripe failure warns and never fails the committed change (checkout/portal keep working; the dashboard can fix a stuck address). Subscription events are additionally ownership-checked against `STRIPE_MEMBERSHIP_PRODUCT_ID` before any record or guard-cancel, so the guards can only ever touch membership subscriptions.

### Account-deletion integration

In `authService` deleteAccount, before `DELETE FROM users`: look up the user's billing customer; if a nonterminal subscription exists (any Stripe status except `canceled`/`incomplete_expired`), cancel it at Stripe (immediate, not period-end). Stripe failure → the delete request fails with a retryable error and nothing is deleted (see the deletion-constraint section: cancellation is a precondition, cancel is idempotent, so retrying is always safe). On success, `billing_customers.user_id` nulls via FK.

### Config

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MEMBERSHIP_PRODUCT_ID` (`.env.example` + render.yaml `sync: false`).
- Presence of `STRIPE_SECRET_KEY` turns the feature on; startup then **fails fast if the other two are missing, if no site origin is set, or if no mailer is configured** (the §17602 acknowledgment email is a legal requirement of taking the first subscription, so Stripe-on/mailer-off is partial config = crash at boot, not 500s at runtime). All absent = feature cleanly off (per feature-flags policy: money features default off).
- New dependency: `stripe` (backend only). No frontend Stripe SDK — Checkout and portal are full-page redirects.

### Backend tests

- Checkout validation (mins, cap, kind, non-integer); 409 while live subscription.
- Webhook: bad signature → 400; DB error → 5xx; each event type; duplicate delivery no-ops; out-of-order subscription events converge (fetch-current makes this trivial); subscription-mode completion writes no ledger row; `charge.refunded` re-delivery and partial refunds land on the same cumulative value; `charge.refunded` before its ledger row exists → 5xx, then succeeds once `invoice.paid` lands; duplicate-subscription guard cancels the newcomer; deleted-account guard (`user_id IS NULL`) cancels a post-deletion subscription; subscription completion without `session.consent` cancels the subscription and records it canceled; a subscription on a different Stripe product is ignored (no record, no guard cancels); email-change sync pushes the new address to `customers.update` and a Stripe failure never fails the change; resubscribe after cancel creates a second row and leaves the first row's consent pointer intact; acknowledgment email sent once, failed send → retryable 5xx and the stamp stays unset; a consent-less completion for a different Stripe product cancels nothing; checkout for an existing customer refreshes the Stripe customer email first.
- Deletion: active member delete cancels subscription and nulls `user_id`; Stripe failure → delete request fails, no rows deleted; retry after successful cancel completes the delete.
- GET totals = net of refunds.

## Frontend

"Support Elections Simplified" section on [SettingsPage.tsx](frontend/src/pages/SettingsPage.tsx), existing useQuery/useMutation card pattern. Hidden entirely when `enabled: false`.

- Non-member: support pitch + two dollar inputs/buttons ("Become a monthly supporter — $5/month minimum", "One-time support"). Copy (final legal review in rollout phase): *"Elections Simplified is independently operated. Optional payments support operating the service — not any candidate, campaign, committee, party, or charity. Payments provide no additional content or influence and are not eligible for a charitable-contribution receipt."*
- Member: "Monthly supporter — $X/month since {date}"; if `cancel_at_period_end`, "ends {current_period_end}"; net total supported; "Manage membership" → portal. `past_due` → fix-payment nudge (portal link).
- Payment history (latest 50, no pagination v1).
- `?membership=success` → thank-you banner + refetch ("may take a moment to appear" — webhook lag; no polling).
- Whole-dollar input, cents conversion client-side, min **and $1,000 max** enforced both ends with a visible message when exceeded; buttons disabled in flight. Frontend tests cover both boundaries ($5 min, $1,000 max).

Frontend tests: hidden-when-disabled, three states render, min validation, redirect on checkout response.

Mobile: out of scope v1. (Apple's external-purchase rules now vary by region — US allows external-purchase links with conditions; don't add any mobile surface without a per-region guideline check.)

## Phases

1. **PR 0 — legal**: privacy policy (name Stripe as a third party in Section 3; amend Section 4: payment records are retained, unlinked from the deleted account, for accounting/legal compliance) + terms of use (payments/subscription/refund/cancellation section). Small doc-only PR, merges first — the retention promise must change before any payment exists.
2. **PR 1 — backend**: migration 250, `stripe` dep, service, 4 endpoints, deletion integration, rate-limiter exemption, wiring, tests. Inert without env keys.
3. **PR 2 — frontend**: settings section + tests.
4. **Rollout** (no PR): Stripe live account — confirm account classification for voluntary support payments with Stripe ([their tips/donations requirements](https://support.stripe.com/questions/requirements-for-accepting-tips-or-donations)); create Product; restricted API key; webhook endpoint subscribed to exactly these six events — `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `charge.refunded` — and **pin its API version to the SDK's pinned version**; configure portal explicitly (payment-method update + invoice history + period-end cancel ON; email/name edits + plan switching OFF); set the Terms of Use URL in the Stripe dashboard's public business details (required before `consent_collection.terms_of_service: 'required'` works); enable Stripe email receipts for recurring charges (each names the amount and our contact; the settings-page portal link = §17602's required easy online cancellation); enable Stripe's failed-webhook email alerts; set 3 env vars in Render (manual sync approve); apply migration 250 (prod script-file pattern); test-mode E2E first, then live $5 → verify ledger row → refund it → verify net total drops to $0 → cancel → delete a test account while subscribed.

## Deferred with a deadline (not optional)

**Annual renewal reminder (CA BPC §17602, as amended by AB 2863 eff. 2025-07-01).** Don't confuse the two notice provisions: the 15–45-day pre-renewal notice applies only to initial terms ≥ 1 year (not us), but the AB 2863 **annual reminder** applies to automatic-renewal/continuous-service offers generally — month-to-month included (product, charge amount + frequency, how to cancel). A monthly Stripe receipt is a payment record, not that reminder. Nothing is owed until a membership approaches one year old, so v1 ships without it — but a simple SES email to active members (we already send account email via SES) **must ship within 12 months of the first membership**. Track it as a follow-up the moment the first member subscribes.

**Shipped 2026-09-16** (legal audit follow-up): `npm run membership:annual-reminders` (`backend/src/scripts/sendMembershipAnnualReminders.ts`) sends the reminder in the 30 days before each anniversary of `started_at` to every active/past_due, uncanceled subscription on a live account — amount, monthly renewal, start date, Manage membership link, period-end cancellation — and records the send in `billing_subscription_annual_reminders (stripe_subscription_id, anniversary_year)` (migration 282). Dry run by default; `--live` sends under an advisory lock. Rollout: apply migration 282, then run it on a weekly cron (any cadence ≤ 30 days keeps the send inside the lead window; a missed run still sends late rather than skipping the year). Until the Render cron is funded, run it by hand at least monthly starting the month before the first subscription's anniversary.

## Explicitly out of scope (v1)

Perks/badges/supporters page; dispute automation (manual); anonymous or logged-out payments; amount change without cancel+resubscribe; non-USD; mobile; pagination; a `stripe_webhook_events` inbox table and a scheduled reconciliation script (revisit if volume or audit needs grow — at launch scale, idempotent handlers + Stripe's dashboard event log + failed-delivery alerts cover it).

## References

- [Pay-what-you-want limits](https://docs.stripe.com/payments/checkout/pay-what-you-want) · [Webhooks: retries & ordering](https://docs.stripe.com/webhooks) · [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) · [API versioning](https://docs.stripe.com/api/versioning) · [Refunds](https://docs.stripe.com/refunds) · [Portal configuration](https://docs.stripe.com/customer-management/configure-portal) · [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) · [stripe-node releases](https://github.com/stripe/stripe-node/releases)
