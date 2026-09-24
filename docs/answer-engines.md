# Answer engines: getting cited by search and AI assistants

How electionssimplified.com is set up to be read, indexed, and cited by
Google (AI Overviews / AI Mode), Bing (which feeds ChatGPT search and
Microsoft Copilot), Perplexity, Claude, and Gemini — and the operator steps
that are not code.

Everything an engine reads is server-rendered HTML: no crawler needs
JavaScript. `frontend/public/llms.txt` exists but is a courtesy — the major
crawlers fetch pages, not that file.

## What the code does

| Piece | Where |
| --- | --- |
| All search and AI crawlers allowed by name | `frontend/public/robots.txt` |
| One log line per crawler hit (`event:crawler`) | `infra/cloudflare/router-worker.js` (`classifyCrawler`), Workers Logs on in `wrangler.toml` |
| Publisher identity (Organization + WebSite JSON-LD) on every page | `frontend/src/components/SiteJsonLd.tsx` |
| Candidate `Person` JSON-LD with party, summary, `sameAs` (Ballotpedia, Wikipedia, official site, socials), `dateModified` | `frontend/src/pages/CandidatePage.tsx`, `candidateSameAsUrls` in the api-client |
| Election `Event` JSON-LD with description, `dateModified`, candidates as `performer` | `frontend/src/pages/ElectionPage.tsx`; `updated_at` from `ballotLookup.ts` |
| One-paragraph answer block opening each election page (also the meta description) | `electionAnswerText` in `packages/api-client/src/electionAnswer.ts` |
| Question headings ("Who is running?", "Who won?", "What does this office do?") | `ElectionPage.tsx` |
| State hub answer paragraph | `stateAnswerText` in `BrowseStatePage.tsx` |
| `/methodology`: who, sources, checks, formulas, corrections | `frontend/src/pages/MethodologyPage.tsx` (prerendered) |
| `/stats` + `/api/stats`: coverage numbers per state, `Dataset` JSON-LD | `backend/src/api/siteStats.ts`, `frontend/src/pages/StatsPage.tsx` |
| IndexNow key file + submit script | `GET /api/indexnow-key.txt`, `npm run indexnow:submit` |

## Operator steps (one-time)

1. **Bing Webmaster Tools.** Sign in at bing.com/webmasters, add
   `electionssimplified.com`, verify (the "import from Google Search
   Console" option is fastest), then submit `https://electionssimplified.com/sitemap.xml`.
   Bing's index is what ChatGPT search and Copilot answer from.
2. **Cloudflare bot settings.** Dashboard → the zone → Security → Bots:
   confirm **"Block AI bots" / "AI Scrapers and Crawlers" is off** and Bot
   Fight Mode is not challenging verified bots. Either setting rejects
   GPTBot/ClaudeBot/PerplexityBot at the edge regardless of robots.txt.
   Verify from outside: `curl -A "Mozilla/5.0 (compatible; GPTBot/1.2)" -sI https://electionssimplified.com/ | head -1` must be `HTTP/2 200`.
3. **IndexNow.** Generate a key (32+ hex chars, e.g. `openssl rand -hex 16`).
   Set `INDEXNOW_KEY` on the API service (Render dashboard; `render.yaml`
   declares it `sync: false`) and redeploy. Check
   `https://electionssimplified.com/api/indexnow-key.txt` returns the key.
   Then from `backend/`:

   ```bash
   INDEXNOW_KEY=<key> SITE_ORIGIN=https://electionssimplified.com DATABASE_URL=<prod-url> npm run indexnow:submit -- --all
   ```

   After each research promotion to prod, submit only what changed:

   ```bash
   npm run indexnow:submit -- --since 2026-10-01
   ```

   HTTP 200/202 = accepted. 403 = key file mismatch. 429 = wait and rerun.
4. **Redeploy the Worker** (`infra/cloudflare`: `npm run deploy`) so the
   `/methodology` and `/stats` cache allowlist entries and Workers Logs take
   effect. Then check the Logs tab filters on `event:crawler`.
5. **Google Search Console**: resubmit the sitemap after deploy (it now
   lists `/methodology` and `/stats`).

## Measuring

- **Crawl coverage**: Worker Logs, filter `event:crawler`; group by
  `crawler` and `path`. If `openai` / `anthropic` / `perplexity` never
  appear over a week, step 2 is the first suspect.
- **AI referrals**: Cloudflare Web Analytics referrers `chatgpt.com`,
  `perplexity.ai`, `copilot.microsoft.com`, `gemini.google.com`. ChatGPT
  also appends `utm_source=chatgpt.com` to links it cites.
- **Citation panel** (monthly, manual): ask ChatGPT, Perplexity, Gemini,
  Claude, and Google AI Mode the same 20 questions ("who is running for
  governor of Kentucky in 2026", "what does Texas Proposition 3 do", "is
  the Simpson County judge-executive race contested") and record whether
  electionssimplified.com is cited. Keep the sheet; the trend is the metric.

## Keeping it true

`/methodology` states the vote-power and competitiveness formulas with
numbers. When `votePower.ts`, `competitivenessLabels.ts`, or
`districtsLoader.ts` change a threshold, change the sentence in
`MethodologyPage.tsx` in the same PR (its test pins the formula text).
