# Usage analytics (first-party, privacy-preserving)

Status: PR 1 (collector + search-to-ballot events + report + policy 1.5 +
opt-out) MERGED 2026-09-04 (#1115); migration 272 applied locally. PR 2
(research and pick flows, guest/account events, follow, share, report
sections 4–5) MERGED 2026-09-05 (#1123). PR 3 (chat, checkout, report
section 6) implemented 2026-09-05 on branch `claude/usage-analytics-pr3`.
Production still needs: privacy policy 1.5 live, migration 272 applied,
`API_DATABASE_URL` confirmed on the API service (the anonymous intake should
write as `voteapp_api`, not the owner — docs/postgres-api-role.md), then
`USAGE_ANALYTICS_ENABLED` via render.yaml (already set there for the next
blueprint sync).

## Idea

We do not know how visitors use the site: where they land, whether they
type an address, whether they open "Why full address?" or the terms dialog
before searching, how long the elections list holds them, which election
they open, whether they reach a candidate, whether they pick, follow, or
ask the chatbot. Every UX decision is a guess.

This plan adds first-party usage tracking: page views with foreground
time, named-control interactions, a few section exposures, and the
client-observed outcome of the operations that matter (address resolve,
ballot load, pick, follow, sign-up, handoff, chat ask). Events land in
Postgres and are read with SQL.

## Decision

Build our own collector. No third-party script.

- The API, database, Cloudflare route (`/api/*` passes through uncached)
  and CSP (`connect-src 'self'`) already exist. A same-origin POST needs no
  infrastructure change.
- `chatbot.questions` is the pattern to copy: insert-only from the request
  path, SECURITY DEFINER purge, Redis-elected daily maintenance
  (`db/migrations/234`, `241`, `backend/src/chatbot/maintenance.ts`).
- A separate schema with no dependencies on core tables is removable with
  one `DROP SCHEMA`.

What SQL over this table can do: measure recorded behaviour and compare
cohorts. What it cannot do: recover events we never collected, explain
motivation, or prove a design change caused a difference. Dashboards,
session replay, heatmaps and experiments stay out of scope.

## Non-goals

- No cross-visit visitor identification. The session id is a navigation
  session (below), not a person.
- No user id, email, name, address text, district ids, candidate ids,
  election ids, measure positions, or chat text in analytics. Ever.
- No card-impression tracking, header/footer link tracking, outbound-link
  capture, party buckets, per-issue-group tracking or share-channel detail
  in the first release. Add any of these only for a named question.

## Privacy rules (hard)

1. **Entities stay out.** Events carry `race_type`, `office_level`
   (federal / state / county / city / other), content-availability flags
   and the interaction surface — never a candidate id, election id,
   measure id or a Yes/No value. A pick is recorded as
   `added | changed | removed`. Rationale: a visitor's sequence of pages and
   picks is political-opinion data even when each entity is public, and
   election ids reveal districts. This forgoes per-candidate popularity
   reports and "distinct candidates compared" counts; accepted.
2. **Route ids, never paths.** The client stores the React Router route id
   (`pages/ElectionPage`, `pages/PublicPickCardPage`, …) and nothing else
   from the URL. `/picks/:token` would otherwise copy an authorization
   token into analytics. Unmatched URLs record as `not_found`.
3. **No query strings, no UTM values in v1.** UTM support, when wanted,
   accepts only an allowlist of campaign values we set ourselves. Referrer
   is bucketed client-side to `search | social | direct | internal | other`
   — no hostnames.
4. **Ballot geography is coarse.** `ballot_ready` carries the US state
   code(s), scope (`exact | zip | region`), and bucketed election and
   district counts. Never the district ids or the matched address.
5. **Chat text stays in `chatbot.questions`** with no join key. `chat_ask`
   records entry method, context kind and outcome only.
6. **Rejected payloads are counted, not logged.** Validation failures
   increment a counter; request bodies and headers never reach logs or
   Sentry.
7. **Raw events are deleted after 90 days** by `received_at`, whether or
   not collection is enabled. Any aggregate kept longer drops the session
   id and suppresses groups under 5 sessions. (Reviewer suggested 30 days;
   90 keeps one Sept → Nov 3 election window comparable in raw form.
   Revisit after the first cycle.)
8. **Visible opt-out.** A control on `/privacy` ("Usage analytics: on /
   off") sets `localStorage['voteapp_usage_optout']`; the client module is
   inert when it is set. This is a real user control, available to guests.
9. **Policy update in the same PR** as the collector: §1 lists the actual
   fields (session id lifetime, route ids, control names, coarse ballot
   state, outcomes), §3 says "operated by us on our hosting and database
   providers" (not "no third party" — processors exist), §4 states 90-day
   retention, §5 names the opt-out. No consent banner: the audience is US
   voters, the identifier is not persistent, and the policy plus opt-out is
   the basis we rely on.

## Session definition

- `session_id`: `crypto.randomUUID()` stored in
  `sessionStorage['voteapp_usage_session']` together with a last-activity
  timestamp. Rotated when the last activity is more than 30 minutes old.
  Survives reloads (by design) and can be copied into an opener-spawned
  tab; it is a *navigation session*, not a visitor. Cross-tab journeys and
  the email-verification round trip are disconnected; accepted.
- Every `page_view` gets a `page_view_id` (UUID). Every event carries the
  current `page_view_id`; operation events carry the id captured when the
  operation *started*, so a late response is not attributed to the next
  page.
- Every event has its own `event_id` (UUID) for retry deduplication.

## Data model

Migration `272_add_usage_analytics_schema.sql`. Own schema, no FKs.

```sql
CREATE SCHEMA usage;

CREATE TABLE usage.events (
  event_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  page_view_id uuid,
  name text NOT NULL,                     -- catalog below
  route text NOT NULL,                    -- React Router route id or 'not_found'
  received_at timestamptz NOT NULL DEFAULT now(),
  client_offset_ms int NOT NULL,          -- ms since session start on the client's monotonic clock
  v smallint NOT NULL DEFAULT 1,          -- payload schema version
  props jsonb                             -- per-name allowlisted keys, < 300 bytes
);
CREATE INDEX idx_usage_events_received_at ON usage.events (received_at);
CREATE INDEX idx_usage_events_session ON usage.events (session_id, client_offset_ms);
```

`client_offset_ms` is a monotonic offset, not wall-clock time; combined with
`received_at` it orders events within a session without trusting the
client clock.

Grants (guarded by the `pg_roles` check from migration 234): `USAGE` on
the schema and `INSERT` on `usage.events` to `voteapp_api`. No SELECT, no
UPDATE, no sequences. The insert is a plain multi-row `INSERT … ON
CONFLICT DO NOTHING` — untargeted, because naming the arbiter column
(`ON CONFLICT (event_id)`) makes Postgres demand SELECT on it (42501 under
an INSERT-only role, verified). Test it under an INSERT-only role, not the
owner.

Purge: `usage.purge_events()` — `DELETE FROM usage.events WHERE
received_at < now() - interval '90 days'`, `SECURITY DEFINER`, `SET
search_path = ''`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE` to the API
role — exactly migration 241's shape. Called by a new
`backend/src/usage/maintenance.ts` (`maybeRunUsageRetention`, Redis key
`usage:purge:<utcDay>`) from `runAddressApiServer.ts` beside the chatbot
call. Runs even when collection is disabled and logs failures.

## Event catalog (v1)

Every event: `event_id`, `session_id`, `page_view_id`, `name`, `route`,
`client_offset_ms`, `props`. Names are `snake_case`; `props` keys are
allowlisted per name on the server.

### Lifecycle

| name | when | props |
|---|---|---|
| `session_start` | first event of a session | `referrer_bucket`, `device` (`phone\|tablet\|desktop`), `landing_route`, `had_saved_draft` (bool), `auth` (`unknown\|guest\|signed_in`) |
| `auth_resolved` | `/api/me` settles the first time in a session, and on any later change | `auth` (`guest\|signed_in`) |
| `page_view` | route change and first load | `arrival` (`home\|list\|rail\|pager\|back\|picks\|draft\|chat\|share\|deep`), `race_type?`, `office_level?`, `has_summary?`, `has_stance_tags?`, `has_official_url?`, `measure_tbd?`, `candidate_count_bucket?`, `record_count_bucket?` — from the matched route's loader data, so it is known at view time |
| `page_time` | checkpoint: on hide, on route change, and every 30 s while visible | `visible_ms` (cumulative foreground time from a monotonic clock; paused while hidden). Reports take `max(visible_ms)` per `page_view_id`. Missing = unknown, never inferred from the next view's time. |
| `section_exposed` | a tracked section's heading marker enters the viewport (threshold 0), once per page view | `section` |
| `error_shown` | `ErrorNotice` / `NotFoundNotice` / `RouteError` render | `category` (`not_found\|rate_limited\|server\|network\|other`) |

Section markers, explicit hook `useSectionExposure("name")` on the
heading element (not the whole section; a tall section never reaches a 50 %
threshold). v1 sections — election page: `vote_power`, `office`,
`measure_summary`, `measure_yes_no`, `candidates`, `results`; candidate
page: `summary`, `stance`, `finance`, `track_record`, `pick_card`.

### Search → ballot (PR 1)

| name | trigger | props |
|---|---|---|
| `address_input` | first input of ≥ 3 characters (the autocomplete threshold). Not focus: desktop autofocuses the field. | |
| `address_suggestion` | suggestion selected | `granularity` (`address\|zip\|region\|unsupported`) |
| `why_address_open` | explainer opened | `after_input` (bool) |
| `address_submit` | form `submit` (covers Enter and the button) | `via_suggestion` (bool) |
| `terms_shown` / `terms_decision` | terms dialog (web: over the first results on the ballot page; mobile: before search) | `decision` (`agree\|cancel\|dismiss`), `doc_opened` (`terms\|privacy\|disclaimer\|none`), `open_ms` |
| `address_result` | resolve settled | `outcome` (`exact\|zip\|region\|error`), `error_category?`, `latency_ms` |
| `ballot_result` | `/api/ballot` or `/api/me/ballot` settled on a list page | `outcome` (`ready\|empty\|error`), `scope`, `states` (≤ 3 codes), `election_count_bucket`, `district_count_bucket`, `partial_banner`, `ambiguous_banner` |
| `list_control` | sort / filter / tab / how-to-vote | `control` (`sort\|filter_issues\|filter_impact\|show_all\|race_tab\|how_to_vote\|how_to_vote_link\|followed_first\|view_toggle`), `value` (enum, bounded) |
| `election_open` | election card activated | `race_type`, `office_level`, `vote_power`, `position_bucket` (`1-3\|4-10\|11+`), `list_sort`, `from_tab` |
| `partial_upgrade_click` | "Enter your street address" in the partial or ambiguous banner | `banner` |

### Research → pick (PR 2)

| name | trigger | props |
|---|---|---|
| `page_view` (detail pages) | election / candidate route | `arrival` (`list\|roster\|candidate\|draft\|picks\|share\|deep`, from the validated nav state's back destination), `race_type`, `office_level` (`federal\|state\|county\|city\|school\|other`), `upcoming`, `has_summary`, `has_stance_tags`, `has_official_url`, `measure_tbd`, `candidate_count_bucket`, `record_count_bucket`, `has_finance` — all from the route's loader data, in render, so the view event is complete when emitted |
| `section_exposed` | `useSectionExposure(name, key)` on a heading marker; threshold 0, once per key | `section` (election: `vote_power\|office\|measure_summary\|measure_yes_no\|candidates\|results`; candidate: `summary\|stance\|finance\|track_record`) |
| `candidate_open` | roster card activated | `position_bucket`, `has_summary`, `has_stances`, `incumbent` |
| `detail_control` | party filter, roster sort, rail tab/sort/item, pager prev/next/back, vote-power how, record view, show-all, finance / record-group toggle | `control`, `value` (bounded enum; `open\|close` for toggles, `none` for links) |
| `official_source_click` | measure official URL, record / result / election source, profile link | `kind` (`measure_official\|record_source\|result_source\|election_source\|profile_link`), `gov` (bool), `pdf` (bool) |
| `pick_attempt` | control activated | `kind` (`candidate\|measure`), `surface` (`election_inline\|candidate_card\|candidate_row\|measure_card\|stranded`), `store` (`account\|draft`), `change` (`added\|changed\|removed`), `ms_since_view` |
| `pick_result` | `mutateAsync` settled (account) or draft setter returned | same `kind/surface/store/change` + `outcome` (`saved\|draft_memory\|error`), `error_category?`. Draft writes report `draft_memory`, not "saved": `writeDraft` swallows storage failures. Attributed to the page the pick started on. |
| `autopick_attempt` / `autopick_result` | `AutoPickControl` (scope `election`), `AutoPickFillControl` (scope `date`) | `scope`, `races_bucket`, `prompted_rank_issues` (attempt); `outcome` (`picked\|no_pick\|mixed\|error`), `reason?` (AutoPickReason), `error_category?` (result) |
| `address_nudge_click` | `AddressNudge` link | `route` already says where |
| `post_pick_click` | `PostPickActions` | `target` (`back\|draft`) |
| `share_open` | `ShareButton` opened (not proof of sharing) | `subject` (`election\|candidate\|picks\|site`) |

### Guests, accounts, follow, chat (PR 2/3)

| name | trigger | props |
|---|---|---|
| `draft_review` | `/draft` or `/me/picks` settled with ≥ 1 pick, once per payload | `pick_count_bucket`, `view` (`list\|ballot`), `store` (`account\|draft`) |
| `signup_prompt` | register/login prompt shown, and its link clicked | `source` (`follow\|pick\|draft\|milestone\|picks_wall\|chat\|autopick`), `action` (`shown\|click`) |
| `auth_result` | login / register / google / logout settled (from inside `mutationFn`) | `action` (`login\|register\|google_login\|google_signup\|logout`), `outcome` (`ok\|error`), `error_category?`, `has_next` |
| `welcome_result` | `WelcomePage` | `action` (`save\|skip`), `ranked_count_bucket`, optional `step` (`pick\|rank`) |
| `handoff_result` | `SavedBallotPage` districts initialize | `outcome` (`done\|failed\|rejected`) |
| `draft_complete_notice` | shown / review / dismiss | `action` |
| `follow_result` | `FollowButton` `mutateAsync` settled | `change` (`follow\|unfollow`), `outcome` (`ok\|error`), `error_category?` |
| `chat_open` | `ChatWidget` launcher clicked | `context_kind` (`candidate\|election\|none`, the remembered page), `wall` (`none\|register\|verify`) — the register wall also fires `signup_prompt` with source `chat` |
| `chat_ask` | ask settled (from inside `mutationFn`) | `entry` (`typed\|starter\|followup`), `context_kind`, `first_turn`, `outcome` (`ok\|error`), `answer?` (server outcome: `template\|retrieval\|clarify\|refuse_no_data\|refuse_policy\|other`), `result_count_bucket?`, `ai_generated?`, `error_category?` — never the text |
| `chat_result_click` | a result card clicked | `source` (`candidate\|record\|finance\|election\|measure\|official\|source\|page\|other`), `position_bucket` — never the URL |
| `chat_feedback` | 👍/👎 settled | `verdict` (`up\|down`), `outcome`, `error_category?` |
| `checkout_start` | Checkout session requested (`MembershipSection`, support pages; not proof of payment) | `kind` (`monthly\|one_time`), `outcome`, `error_category?` — never the amount |

Interaction events fire from explicit handlers (`onSubmit`, `onChange`,
existing `onClick`s) calling `track(name, props)`. A delegated
`[data-track]` click listener is used only for simple links and buttons
without existing handlers. Outcome events fire from inside the mutation
function wrappers (`mutationFn`), which run to completion even when the
calling component unmounts.

## Ballot measures

Measures have no candidate hop. Split every election-page metric by
`race_type`; measure-specific reads:

- `page_view` → first `pick_result` on the same `page_view_id`: time to
  decision.
- `section_exposed(measure_yes_no)` before vs after the first pick, and
  `official_source_click(measure_official)` with/without a later pick on
  the same view.
- "No observed in-app pick" rate (not "roll-off": a visitor may decide
  without saving, arrive decided, or leave for the official text).
- `election_open` position and `race_tab` use for measure cards.
- Content flags (`has_summary`, `has_stance_tags`, `has_official_url`,
  `measure_tbd`) as hypothesis variables only — placement and prominence
  confound them.
- `autopick_result` distribution on measures (measure recommendations are
  implemented; their outcomes are something to measure, not assume).

## Client design (`frontend/src/lib/usage.ts`)

- Inert when: SSR, `navigator.webdriver` (automation filter, not bot
  protection), `localStorage['voteapp_usage_optout']`, or
  `VITE_USAGE_ANALYTICS_ENABLED !== "true"`.
- `track(name, props)` appends `{ event_id, session_id, page_view_id,
  name, route, client_offset_ms, v, props }` to a bounded in-memory queue
  (max 200; oldest dropped). Never throws.
- Route: `useMatches()` → last match's `id`; loader `data` from the same
  match supplies `page_view` content flags synchronously, so the view
  event is complete when emitted. A small map turns route ids into the
  values stored (`pages/ElectionPage` → `election`, …); unknown → `other`,
  the splat route → `not_found`.
- Page time: on `page_view` start a monotonic timer; `visibilitychange`
  pauses/resumes; `page_time` checkpoints every 30 s while visible, on
  hide, and on route change.
- Flush: every 15 s if the queue is non-empty, at 20 events, and on
  `visibilitychange → hidden` / `pagehide`. Routine flushes use
  `fetch(..., { keepalive: true, headers: { "content-type":
  "application/json" } })` (the API's JSON parser requires the content
  type) and re-queue once on network failure or 5xx. Hide-time flushes use
  `navigator.sendBeacon` with a JSON `Blob` — queued-not-confirmed, no
  retry. One flush in flight at a time; batches are split so the encoded
  body stays under 12 KB (well inside the 16 KB parser limit).
- Hooks mounted once in `App.tsx`: `useUsagePageViews()`,
  `useUsagePageTime()`, `useUsageDelegatedClicks()`. Section exposure is
  explicit per page via `useSectionExposure(name)`.

Performance: no synchronous work in render; one delegated click listener;
one `IntersectionObserver` per page with ≤ 12 targets; flushes are
asynchronous and never awaited by UI code. Module budget < 3 KB gzipped.

## Server design

- `USAGE_EVENTS_PATH = "/api/usage/events"`, `POST` only. Must be added to
  `isKnownApiPath`, the dispatch branch, and `AddressApiServerOptions`
  wiring in `runAddressApiServer.ts`. The JSON body parser and origin
  checks apply unchanged.
- Rate limit: reuse the existing per-IP limiter with its own bucket key
  (`${clientIp} usage`), the same carve-out `addressApiRateLimiter.ts`
  gives autocomplete, so analytics can neither starve nor be starved by
  the shared per-IP budget. 60 requests per minute per bucket is far
  above a client's ≤ 4 flushes per minute.
- Validation (`backend/src/api/usageEventsValidation.ts`): `events` array
  1–40; per event: `event_id` / `session_id` / `page_view_id` UUIDs,
  `name` in the catalog, `route` in the route allowlist, `client_offset_ms`
  integer 0–86 400 000, `v` = 1, `props` object whose keys and values match
  the per-name allowlist (enums, bounded ints, booleans, ≤ 3-item string
  arrays of 2-letter state codes). Invalid events are dropped and counted;
  valid events in the same batch are kept. Empty valid set → `204`.
- Write: one bounded multi-row `INSERT … ON CONFLICT (event_id) DO
  NOTHING`, awaited, then `204`. The request is the write; awaiting it
  gives backpressure without touching any user-facing action.
- Flag `USAGE_ANALYTICS_ENABLED` (backend; default **false** — this is a
  write feature, not a free read-side flag) and
  `VITE_USAGE_ANALYTICS_ENABLED` (frontend). Off → `404` and inert client.
  Enable in `render.yaml` and `backend/.env` explicitly; local dev and
  staging stay off unless testing the feature.

## Reports (ship with PR 1)

`backend/src/scripts/usageReport.ts` (owner role), printing denominators
and "unknown" counts explicitly. Homepage entrants, deep-link arrivals and
signed-in returners are separate cohorts, never one mandatory funnel.

1. Search completion: sessions → `address_input` → `address_submit` →
   `terms_decision` → `address_result` by outcome and latency, by device
   and referrer bucket.
2. Ballot usefulness: `ballot_result` outcome, scope, count buckets.
3. Exploration: `ballot_result(ready)` → `election_open` (rate, position
   bucket, race_type), `list_control` use, median `page_time` on the list
   before the first open.
4. Research → action (PR 2): `candidate_open` rate, section exposures,
   `official_source_click`, `pick_attempt` → `pick_result` by surface and
   store, office vs measure paths.
5. Guest retention (PR 2): `draft_review`, `signup_prompt` → `auth_result`,
   `handoff_result`.
6. Chat and support (PR 3): `chat_open` by wall, `chat_ask` by entry and
   answer kind, card clicks by source, feedback verdicts, `checkout_start`
   by kind and outcome (follow lives in section 5).
7. What breaks: `error_shown` by route and category; `pick_result(error)`;
   `address_result(error)`.

## Rollout

PR 1 — collector + search-to-ballot: migration 272 (table, purge
function, grants), `usage.ts`, `App.tsx` hooks, `session_start` /
`auth_resolved` / `page_view` / `page_time` / `error_shown`, the search →
ballot events, endpoint + validation + limiter bucket + retention +
flags, `/privacy` opt-out control, privacy-policy edits, `usageReport.ts`
sections 1–3 and 7.

PR 2 — research and pick flows: election/candidate page events, section
exposures, measure specifics, guest/account events, report sections 4–5.

PR 3 — chat (`chat_open`, `chat_ask`, `chat_result_click`,
`chat_feedback`, the register wall as a `signup_prompt`), `checkout_start`,
report section 6. Anything the first production reports show we still
cannot answer is a follow-up, not part of this plan.

## Tests (the boundaries that would corrupt results)

- Route id, never path: a `/picks/<token>` view stores
  `pages/PublicPickCardPage` and no token anywhere in the payload.
- Insert succeeds under `voteapp_api` (INSERT-only) — integration test
  against the local DB with the role created for the test.
- Reload deduplication: the same `event_id` twice → one row.
- Hidden/resumed page: `visible_ms` excludes the hidden interval;
  repeated `page_time` checkpoints collapse to the max.
- Late operation: a `pick_result` arriving after navigation carries the
  originating `page_view_id`.
- Storage failure: `sessionStorage` throwing → module inert, app unaffected.
- Oversized batch: 40 × 300-byte props splits into two requests, both
  under 12 KB.
- Limiter isolation: usage traffic never consumes the plain per-IP bucket.
- Validation: invalid event dropped and counted, siblings stored; unknown
  prop keys removed.
- Opt-out: with the flag set no request leaves the page.

## Open questions

- Sampling: none. Add `USAGE_SAMPLE_RATE` only past ~1 M rows/month.
- Signed-in pages (`/me/*`) are tracked under the same rules (no user id);
  confirm this is wanted before PR 2.
- Mobile app: same endpoint contract later; out of scope here.
