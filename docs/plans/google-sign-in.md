# Google Sign-In — build plan

Status: IMPLEMENTED in PR #683 (2026-08-12) — migration 238, backend, frontend, CSP, privacy policy 1.2 all in that PR; migration applied locally. Remaining work = the rollout steps below (prod migration, env vars, worker deploy, smoke).

## Goal

One-click signup/login with a Google account, next to the existing email+password form. Auth-only: we consume a Google **ID token** (signed JWT) as proof of identity; we request no Google API scopes, store no Google access/refresh tokens, and make no ongoing Google API calls. Sessions, cookies, Bearer transport, epoch revocation — all unchanged.

Biggest UX win: for a Gmail/Workspace address, a Google signup skips the SES verification round-trip entirely (`email_verified = true` at creation).

Scope: **web only in v1.** Mobile needs a dev build (Expo Go cannot load the native Google sign-in module) — phase 2, backend already ready for it.

## How it works

```
GIS button (accounts.google.com/gsi/client)
  → JS callback receives credential (ID-token JWT)
  → POST /api/auth/google { credential, intent, accepted_terms_version? }
  → backend verifyIdToken (google-auth-library): signature, aud, iss, exp
  → payload.sub = stable Google user id (NEVER key on email)
  → find-or-create/link user (rules below) → createAuthSession (existing Redis/epoch machinery)
  → Set-Cookie (web) / session_id in body (mobile transport, phase 2)
```

JS-callback mode, not `login_uri` redirect mode → Google's `g_csrf_token` cookie dance does not apply. CSRF protection for the POST = the existing pair of guards every auth route already relies on: the route is in the JSON-parser allowlist (`application/json` required — no HTML form can produce it) and the CORS middleware rejects disallowed browser origins. No nonce in v1: a meaningful nonce needs a server-bound one-time challenge; a client-random value adds ~nothing over the token's short `exp` + `aud` check.

## Decisions (made once, here)

| Question | Decision | Why |
|---|---|---|
| Identity key | `users.google_sub` (token `sub`) | Stable, unique, never reused. Email can change on a Google account. |
| Which Google emails count | **Authoritative only**: `email` ends `@gmail.com`, OR (`email_verified === true` AND `hd` non-empty, i.e. Workspace) | Google's own guidance: for other addresses ownership may have changed even though `email_verified` stays true — auto-linking could hand an old Google-account holder the current owner's VoteApp account. Non-authoritative → 400 "Use email signup/login for this address." (A second SES-verification path for them can come later if anyone asks.) |
| Email match, row has `google_sub = NULL` | Link | Both sides verified + authoritative. |
| Email match, row has a **different** `google_sub` | Reject, generic credential-conflict error | Never overwrite an existing link — the overwrite would be an account steal (token sub B + email X vs. row linked to sub A). Matters because stored email deliberately does not follow Google email changes. |
| Email match, row **unverified** | Signup intent only: link + `email_verified = true` + `session_epoch + 1` + **replace terms fields and record fresh acceptance** | Google login proves inbox control; epoch bump kills the pre-registration-attacker sessions `createOrRefreshAuthUser` already defends against; the old acceptance may be the attacker's, so it must not be inherited (same replace-on-re-register behavior as password flow). Login intent → tell the user to use the signup flow. |
| New Google user's password | `password_hash = NULL` — no random-password hack | Honest data. Password-required flows handled below. |
| Clickwrap | `intent: "login" \| "signup"` in the request. **Signup only from the register page**, where the existing `LegalGate` unchecked checkbox ([RegisterPage.tsx:189](../../frontend/src/pages/RegisterPage.tsx)) gates the Google button exactly like the password form. Login-page button never creates an account (sub match or verified-row link only). | Passive "By continuing…" copy would weaken the affirmative-assent evidence the checkbox exists to create (sign-in-wrap is enforceable but more fact-sensitive — 9th Cir. *Berman*). `accepted_terms_version` required + validated only for signup / unverified-row takeover. |
| Terms acceptance `context` | Reuse `"registration"` | Migration 201's CHECK only permits `registration/renewal/backfill`; a provider-specific value buys nothing. |
| Our stored email vs token email drift | Keep ours; never overwrite on login | Our email is the contact channel; user changes it via the existing email-change flow. |
| FedCM / One Tap | Button only, **omit** FedCM opt-in fields (`use_fedcm_for_prompt` is deprecated/ignored; `use_fedcm_for_button` defaults false) | Standard button flow works everywhere with zero extra config. One Tap skipped in v1. |
| Client IDs | **One Web client ID**, no comma-separated audience list | Native Google libraries request the ID token for the *server's* Web client ID (`serverClientId`), so phase 2 mobile likely needs no new audience anyway. Add complexity when proven needed. |
| Unlink / "disconnect Google" UI | Skip in v1 | Setting a password (below) is the escape hatch. |
| Enable switch | Configured-if-present: `GOOGLE_OAUTH_CLIENT_ID` unset → endpoint 500s "not configured", frontend hides button when its build-time ID is absent | Same pattern as `authService` itself and the Places proxy. Free feature, no money flag. |

## Migration 238 (shipped in PR #683 — 236/237 belong to RI/Denver finance; NEVER renumber)

```sql
BEGIN;
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE public.users
    ADD COLUMN google_sub text,
    ADD CONSTRAINT users_google_sub_present CHECK (google_sub IS NULL OR btrim(google_sub) <> '');
CREATE UNIQUE INDEX uq_users_google_sub_active
    ON public.users (google_sub) WHERE deleted_at IS NULL;
COMMENT ON COLUMN public.users.google_sub IS
    'Google ID-token sub claim. Stable per Google account; identity key for Sign in with Google. NULL = no Google link.';
COMMIT;
```

Partial index mirrors `uq_users_email_active` for consistency (account deletion is hard-delete today, so the predicate is future-proofing, not load-bearing).

## Backend

New dep: `google-auth-library` (official verifier; caches Google's public keys per Cache-Control).

### `authService.loginWithGoogle(input)` (in `authService.ts`, alongside `login`)

Input: `{ idToken: string, intent: "login" | "signup", acceptedTermsVersion?: string, currentSessionId?: string | null }`. Steps:

1. Verify via injected `verifyGoogleIdToken(idToken)` (thin wrapper around `OAuth2Client.verifyIdToken({ idToken, audience: clientId })`; injected so tests stub it — no network in vitest). **Normalize every verifier throw into one generic invalid-Google-credential `TypeError`** (→ 400); library errors must not surface as 500s. Extract and strictly validate `sub` (non-empty string), `email`, `email_verified`, `hd`, `given_name`.
2. Authoritative-email gate (table above) → else reject.
3. For `intent: "signup"` and for any unverified-row takeover: require `acceptedTermsVersion === CURRENT_TERMS_VERSION` (service-layer check mirroring `register`).
4. Transaction:
   - `SELECT … WHERE google_sub = $1 AND deleted_at IS NULL FOR UPDATE` → **found:** plain login (either intent). Do not touch stored email/terms.
   - Else `findActiveUserByEmailForUpdate(email)` → **found:**
     - `google_sub` set and ≠ token sub → abort, generic conflict error.
     - verified row, `google_sub` NULL → `UPDATE … SET google_sub = $sub` (either intent).
     - unverified row → signup intent: link + verify + epoch bump + replace terms fields + `recordTermsAcceptance(context: "registration")`; login intent: abort with "needs signup" error code.
   - Else **no row** → signup intent: insert `first_name = (given_name trimmed, sliced to 80) ?? deriveFirstName(email)`, `email`, `password_hash = NULL`, `google_sub`, `email_verified = true`, terms columns + acceptance row, same tx. Login intent: abort with "needs signup". Concurrent-first-signup race: unique-index 23505 → retry the whole lookup once in a fresh transaction.
   - `updateLastLoggedIn` in the same tx.
5. After commit: destroy `currentSessionId` best-effort (fixation, same as `login`), `createAuthSession` with the epoch read in the tx. Return `{ sessionId }`.

### Guard the dummy-hash hole in `login()` — same PR, non-negotiable

Today ([authService.ts:516](../../backend/src/auth/authService.ts)): `const passwordHash = user?.password_hash ?? (await DUMMY_PASSWORD_HASH_PROMISE)`. With `password_hash = NULL`, `??` substitutes the dummy hash — a *real* Argon2 hash of a fixed literal — so typing that literal as the password would authenticate into any Google-only account. Fix:

- still run `verifyPassword` against the dummy hash (constant-time behavior),
- then require `user && user.password_hash !== null && passwordMatches`.

`AuthUserRow.password_hash` becomes `string | null`; `changePassword` / `deleteAccount` / `requestEmailChange` get explicit NULL-hash guards → their existing generic "password is incorrect" error, never a match.

**Rollback hazard:** once any NULL-password user exists, the *old* backend build is vulnerable (its `?? dummy` login path). Never roll the API back past this PR; roll forward with Google disabled (`GOOGLE_OAUTH_CLIENT_ID` unset) instead.

### Endpoint `POST /api/auth/google` (apiServer.ts)

- Known-paths allowlist + method guard + "not configured" 500, copying the register block's shape.
- **Add the path to the JSON-parser allowlist** ([apiServer.ts:441](../../backend/src/api/apiServer.ts)) — this list is also half the CSRF story.
- Body parse in `apiValidation.ts`: `{ credential: string, intent: "login" | "signup", accepted_terms_version?: string }`; terms-version currency re-checked at API layer for signup (same dual-layer pattern as register).
- Rate limit: reuse `enforceAuthRateLimit` with `email: null` — **per-IP bucket only, before verification**. There is no password to brute-force behind this endpoint (credentials are Google-signed tokens), so a per-identity bucket adds nothing, and keying it would either couple Google sign-in to the stricter per-email quota (the bug the review round fixed) or require verifying before rate-limiting, inverting the limiter's cost-capping purpose. Do NOT restore token-email keying.
- Response: web → 200 + session cookie; mobile-transport requests → `session_id` in body (identical branch to login). Distinct 4xx error code for "needs signup" so the login page can route the user to register.

### Wiring (runAddressApiServer.ts)

`GOOGLE_OAUTH_CLIENT_ID` present + authService configured → construct the verifier and pass `loginWithGoogle` through; absent → endpoint stays 500-not-configured, warn once at boot like the partial-auth warning.

### `/api/me`: `has_password`

Add `has_password: boolean` (`password_hash IS NOT NULL`) to `UserIdentity` ([userIdentity.ts](../../backend/src/pipeline/users/userIdentity.ts)). Settings must know account state up front, not discover it via a generic password error.

## Frontend

- Small `GoogleSignInButton` component: renders nothing when `VITE_GOOGLE_OAUTH_CLIENT_ID` unset; loads `https://accounts.google.com/gsi/client` via a **singleton, idempotent** loader (Google says `initialize` once — Login → Register navigation must not leave a stale callback or double-init); handles script-load failure (button just doesn't appear; password form unaffected); ignores duplicate callbacks while a request is pending.
- `google.accounts.id.initialize({ client_id, callback })` + `renderButton`. No FedCM fields (see decisions).
- Register page: button disabled behind the existing `LegalGate` checkbox, exactly like the submit button; sends `intent: "signup"` + `accepted_terms_version: TERMS_VERSION`.
- Login page: sends `intent: "login"`; on the "needs signup" error code, message + link to the register page.
- On 200: same post-login routing/cache-refresh path as password login (`next` param honored, cached identity purged).

## CSP (real, not a no-op)

Production serves `Content-Security-Policy-Report-Only` from the Cloudflare router worker ([router-worker.js:74](../../infra/cloudflare/router-worker.js)); the policy is staged for enforcement, so ship it correct now. Add Google's documented sources + update the worker's tests:

- `script-src`: `https://accounts.google.com/gsi/client`
- `frame-src`: `https://accounts.google.com/gsi/`
- `connect-src`: `https://accounts.google.com/gsi/`
- `style-src`: `https://accounts.google.com/gsi/style`

`fenced-frame-src` omitted unless testing shows violations.

## Settings page (small, required for completeness)

Google-only users have no password, and `changePassword` / `requestEmailChange` / `deleteAccount` all demand one. v1 keeps those flows password-gated (no new attack surface) and, driven by `has_password`:

- password-less account → Settings shows "Add a password" pointing at the existing **forgot-password** flow (their email is verified, so the reset link works today with zero backend change), and the three password-gated forms are replaced by that hint instead of failing.

Account deletion therefore stays possible (set password → delete), satisfying the privacy-policy promise without a parallel re-auth mechanism. A fresh-Google-ID-token re-auth path is explicitly deferred. (Added later for account deletion only: `DELETE /api/me` accepts a `google_credential` whose subject must match the linked `google_sub`, so a Google-only account can delete itself without setting a password.)

## Privacy policy (before release)

Current policy states every account stores a password hash and that account-sensitive actions require your password ([privacy-policy.md](../legal/privacy-policy.md) §"Account information", §6) and does not mention Google. Amend:

- Google Sign-In as an optional sign-in method; data received = stable Google account identifier (`sub`), email, verification/hosted-domain status, optional first name.
- No Google access/refresh tokens; no Google API access.
- Password may be absent on Google-created accounts; sensitive actions then require adding a password first.
- The Google identifier is deleted with the account.

Small version bump (1.1 → 1.2) with the existing re-acceptance machinery, decided at PR time.

## Google Cloud console (manual, one-time)

Existing project (Places key lives there). Add:
1. OAuth consent screen / branding: app name, support email, **homepage + privacy-policy URLs**, authorized domain (ownership-verified). Logo triggers Google's brand review — submit early, it's async.
2. Audience → **Production** before launch: Testing mode allows only listed test users and its grants expire after 7 days.
3. OAuth Client ID (Web application): authorized JavaScript origins = prod origin + both `http://localhost` and `http://localhost:5173` (Google's guidance: include both bare and ported localhost). No redirect URIs (JS-callback mode).

## Tests

- `authService` google tests (stubbed verifier): signup create (terms recorded, verified at birth, NULL hash), sub-match login, verified-row link, unverified-row takeover (verify + epoch bump + terms replaced), **sub-conflict reject**, **non-authoritative email reject**, `email_verified:false` reject, login-intent-but-new-user reject, stale/missing terms reject, 23505 retry, verifier-throw → generic 400, `given_name` overflow capped at 80.
- `login()` regression: NULL-hash user + the dummy literal password → rejected; NULL-hash guards in change-password/email-change/delete.
- `apiServer` endpoint tests: method guard, not-configured, body validation (intent enum), JSON-parser list, rate-limit reuse, cookie vs mobile-body response, needs-signup error code.
- Frontend: button hidden without client ID; register button gated by LegalGate; login "needs signup" routing; singleton script loader (mock).
- Worker CSP test update.

## Rollout (ordered — "any order" is wrong)

1. Google console: branding/audience/client ID done and Production-published.
2. Merge PR; apply migration 238 (local, then prod).
3. Deploy backend **without** `GOOGLE_OAUTH_CLIENT_ID` (NULL-safe login fix live, Google endpoint inert).
4. Set backend `GOOGLE_OAUTH_CLIENT_ID`; smoke the endpoint directly.
5. Deploy the CSP worker update.
6. Build/deploy frontend with `VITE_GOOGLE_OAUTH_CLIENT_ID`.
7. Prod smoke: new-user signup, link-existing, returning-user, sub-conflict, login-intent-new-user, password login unchanged, "Add a password" reset path.

Roll-forward only after step 4 may have created NULL-password users (see rollback hazard above).

## Risks / non-goals

- **Google outage** = Google button down, password login unaffected.
- Non-authoritative Google addresses (non-Gmail, non-Workspace) are turned away in v1 — measure how often before building the SES-verification fallback.
- **Workspace email rename + password-less account**: login keeps working (keyed on `sub`), but our stored email points at the old address, so the "add a password" reset email is undeliverable — and email-change/delete need that password. Known v1 gap, accepted: affected users can still use the account and can recover via support; the fix is the deferred Google-reauthenticated account-management path, built if this ever actually occurs.
- Not doing in v1: One Tap / FedCM opt-ins, unlink UI, nonce, Apple/other providers, admin tooling, mobile. Phase 2 mobile: `@react-native-google-signin/google-signin` + dev build (`serverClientId` = the same Web client ID) — and shipping any third-party login on iOS triggers App Store guideline 4.8, so assess Sign in with Apple then.
