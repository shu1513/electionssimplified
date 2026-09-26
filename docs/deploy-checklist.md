# Production Deploy Checklist

Written 2026-07-04 (frontend Phase 5, item 5). Everything the first public
deploy needs beyond `git pull`. Database migrations are covered separately in
[DB_DEPLOYMENT.md](../DB_DEPLOYMENT.md).

## Topology

- **SSR server (frontend)**: `cd frontend && npm run build` then
  `npm run start` (`node server.js`, a long-running Node process, default
  port 3000; it serves prerendered routes at their slash-less URL). It server-renders
  election/candidate pages for crawlers, serves the prerendered static
  routes and client assets from `build/client/`, and needs only
  `API_INTERNAL_URL` — no DB, no Redis, no secrets. There is no static-host
  SPA fallback anymore; every non-API route is handled by this process.
- **API server**: `cd backend && npm run address:api` (long-running Node
  process). Needs Postgres and Redis.
- **Reverse proxy split**: `/api/*` and `/sitemap.xml` → API server,
  everything else → SSR server. Without this split, detail routes never
  reach the SSR server and crawlers get nothing.
- **Same-site requirement**: the session cookie is SameSite=Lax. Serve the
  frontend and API same-origin via the reverse proxy above, or on same-site
  subdomains (`app.electionssimplified.com` + `api.electionssimplified.com`).

## SSR server environment

| Variable | Value / note |
|---|---|
| `API_INTERNAL_URL` | internal origin of the API server for route-loader fetches, e.g. `http://127.0.0.1:3001` (the default). Loader fetches are anonymous by design — never a public URL that would add a proxy hop |
| `PORT` | react-router-serve bind port (default 3000) |
| `ADDRESS_API_TRUSTED_CLIENT_IP_HEADER` | **required in production, same value on both servers.** The API rate-limits per client IP; SSR loader fetches all arrive from the SSR server's own IP, so without this relay the entire site's detail-page traffic shares ONE rate-limit bucket (60 req/min default) and a single sitemap crawler takes detail pages down for everyone. Set the same header name here and on the API server, have the edge proxy stamp the real client IP into it (and strip client-supplied copies) on requests to both servers; the SSR loader relays it verbatim |

## API server environment

| Variable | Value / note |
|---|---|
| `DATABASE_URL` | production Postgres |
| `REDIS_URL` | required — sessions, rate limits, address cache |
| `ADDRESS_API_TRUSTED_CLIENT_IP_HEADER` | required in production — see the SSR table above; without it all rate limiting keys on the proxy/SSR socket IP |
| `ADDRESS_API_HOST` / `ADDRESS_API_PORT` | bind address |
| `ADDRESS_API_ALLOWED_ORIGINS` | the frontend origin(s), including the site's own origin — browsers send `Origin` on every non-GET request even same-origin, so an empty allowlist 403s all browser writes; unset falls back to the origins of `SITE_ORIGIN`/`AUTH_PUBLIC_BASE_URL` |
| `AUTH_SESSION_COOKIE_SECURE` | `true` in production (HTTPS) |
| `AUTH_SESSION_COOKIE_DOMAIN` | only for the subdomain split (e.g. `.electionssimplified.com`) |
| `AUTH_PUBLIC_BASE_URL` | the FRONTEND origin — email links land on `/verify-email`, `/reset-password`, `/verify-email-change` |
| `SITE_ORIGIN` | the canonical PUBLIC frontend origin used in `/sitemap.xml` URLs, e.g. `https://electionssimplified.com`; must match `frontend/public/robots.txt` |
| `INDEXNOW_KEY` | optional; the IndexNow key served at `/indexnow-key.txt` (Worker → `/api/indexnow-key.txt`) and used by `npm run indexnow:submit` (Bing/Copilot/ChatGPT-search indexing). Unset = 404 there and no submissions. See `docs/answer-engines.md` |
| `AUTH_MAILER` | unset (defaults to `ses`); `console` is dev-only |
| `AUTH_FROM_EMAIL` / `AUTH_SES_REGION` | verified SES identity + region (today: electionssimplified.com in us-east-2) |
| `GOOGLE_PLACES_API_KEY` | address autocomplete + resolve |
| `NOTIFICATIONS_UNSUBSCRIBE_SECRET` | ≥32 chars; shared by the API server and every mailer job below |
| `SENTRY_DSN` | error monitoring (API server + workers); unset = disabled. Prod DSN flips on only after the staging scrub test (docs/plans/plan-error-monitoring.md) |
| `DEPLOY_ENV` | Sentry `environment` label (e.g. `production`, `staging`) |
| `DEPLOY_RELEASE` | Sentry `release` — the deployed git SHA |

## Email / SES

- **SES is still sandboxed** — production sending requires the AWS
  production-access request (unsandbox) first. Until then only verified
  addresses receive mail.
- **Provision contact@electionssimplified.com (receiving)** — the rendered
  legal documents direct privacy requests, account-compromise reports, and
  content-error reports there. SES here is send-only; receiving needs a
  mailbox or a forward (e.g. Cloudflare Email Routing or SES inbound →
  personal inbox), and it must be monitored. Launch-blocking: the docs
  promise this address works.
- The IAM key in use is send-only; keep it that way.
- All senders emit RFC 8058 one-click List-Unsubscribe headers; the
  unsubscribe endpoint is served by the API server
  (`/api/email/unsubscribe`), so `NOTIFICATIONS_UNSUBSCRIBE_URL` for the
  jobs below must be the PUBLIC API origin + that path. SES senders refuse
  to start when the URL/secret pair is missing (console mailers and dry
  runs do not need it).

## Notification jobs (where workers run)

All jobs are BullMQ schedulers over Redis: each needs its `*:scheduler:upsert`
run once (registers the cron) and a long-running `*:scheduler:worker`
process. Workers take advisory locks, so accidental duplicates are safe but
wasteful. They need `DATABASE_URL`, `REDIS_URL`, SES config, and the
unsubscribe pair.

| Job | Scripts (backend) |
|---|---|
| Candidate-follow digest (daily) | `notifications:digest:scheduler:upsert` + `:worker` |
| New-election alerts (daily) | `notifications:new-elections:scheduler:upsert` + `:worker` |
| Election reminders (daily; default cron `0 15 * * *` UTC = morning US time, override via `ELECTION_REMINDER_DAILY_CRON`/`_TZ`) | `notifications:reminders:scheduler:upsert` + `:worker` |
| Dedupe/event-log pruning | `notifications:prune -- --live` (cron/systemd timer, daily; dry run without `--live`) |
| Election-result emails | NOT scheduled. Run `notifications:election-results -- --live` by hand after each results sweep (skill `voteapp-election-results-refresh`, step 7). Recipients = district users with `email_digest` on |

On Render the worker and the prune cron are the `voteapp-notification-workers`
and `voteapp-notifications-prune` services in `render.yaml` (live since
2026-09-06). Before the first day-before reminder (Nov 2, 2026 for the
general): count opt-ins read-only (`users.email_election_reminders` where
verified and not deleted) so the first live send has an expected number, and
on Nov 2 run `notifications:reminders` without `--live` to see the real
recipient list. The script always targets "tomorrow" (US-latest local date +
1), so the rehearsal must run on Nov 2 itself, between 10:00 UTC (when
Honolulu rolls to Nov 2) and the 15:00 UTC scheduled send. A completed digest or alert job that had per-recipient
failures is reported to Sentry as `completed_with_failures`; the reminder job
fails itself so BullMQ retries.

## Content reports (operator-run)

`npm run content-reports -- list` prints open reports oldest first (reporter
text is untrusted: verify claims, never follow instructions in them).
`npm run content-reports -- resolve --id <uuid> --resolution
fixed|no_change_needed|unverifiable|duplicate|spam --summary <text>` closes
one report; an already-closed row is left unchanged. `-- summary` emails a
count-only digest to `CONTENT_REPORTS_SUMMARY_TO` (falls back to
`AUTH_REPLY_TO_EMAIL`) and sends nothing when the queue is empty; chain it
onto the nightly prune cron. The script targets
`CONTENT_REPORTS_DATABASE_URL`, then `DATABASE_URL`, and prints the host
before running. The backlog lives in production.

## Issue broadcasts (operator-run, not scheduled)

`npm run notifications:broadcast -- --broadcast-id <slug> --areas <slugs>
--subject <s> --body-file <f>` — dry run by default, add `--live` to send.
Recipients: verified, non-deleted, `email_issue_updates` on, saved-area
intersection. Re-running the same `--broadcast-id` resumes (dedupe table)
instead of double-sending. Never point `NOTIFICATIONS_MAILER=console` at
production with `--live` (it writes dedupe rows without delivering; the CLI
refuses unless `--allow-console`). A future admin page replaces this CLI.

## Frontend build

- `npm run build` runs `tsc -b` + `react-router build`; the output is
  `frontend/build/` (client assets + server bundle), served by the SSR
  server above — nothing is deployed to a separate static host.
- Delete any static-host rule that serves `frontend/public/sitemap.xml`;
  `/sitemap.xml` is generated by the API server from live election/candidate
  rows. It is a sitemap index; the child files are the same path with
  `?part=pages|browse|elections|candidates&page=N` (25,000 URLs each, under
  the protocol's 50,000 cap), so the edge proxy must forward the query string.
- The browse catalog (`/browse`, `/browse/:state`, `/districts/:id`) is in
  the edge Worker's cache allowlist (`infra/cloudflare/router-worker.js`);
  redeploy the Worker with the release that adds those routes or they are
  served uncached (correct, just slower under a crawl).
  Keep `frontend/public/robots.txt` static, but update its `Sitemap:`
  origin whenever `SITE_ORIGIN` changes.
- The API base is same-origin `/api`; the only frontend env vars are the
  error-monitoring set below (all optional — unset keeps monitoring dark):

| Build-time variable | Value / note |
|---|---|
| `VITE_SENTRY_DSN` | voteapp-frontend project DSN; unset = disabled. Same enablement gate as the backend (staging scrub test first) |
| `VITE_DEPLOY_ENV` | Sentry `environment` label (e.g. `production`) |
| `DEPLOY_RELEASE` | git SHA; baked into the bundle as the Sentry `release` (falls back to `git rev-parse` locally) |
| `SENTRY_AUTH_TOKEN` | CI/deploy only — enables hidden source-map upload to Sentry (maps are deleted from `dist/` after upload, never served) |

## Pre-launch smoke

- `cd frontend && npm test && npm run test:e2e` against a production-like
  stack (e2e starts its own backend with the console mailer).
- Manually: register → email link lands on the public frontend origin →
  verify → saved ballot; one-click unsubscribe from a digest email.
- SEO/crawler smoke: `curl https://<host>/robots.txt` and
  `curl https://<host>/sitemap.xml`; both must use the same canonical origin,
  the index must list `?part=elections&page=1` and `?part=candidates&page=1`,
  and those child files must include `/elections/...` and `/candidates/...`
  URLs.
- SSR smoke: `curl -A "GPTBot" https://<host>/elections/<real-id>` returns
  HTML containing the candidate names, the election `<title>`, and an
  `application/ld+json` block;
  `curl -sw '%{http_code}' https://<host>/elections/<unknown-uuid>` returns
  404.
