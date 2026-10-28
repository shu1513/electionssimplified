# Alabama Campaign Finance Plan

Written 2026-08-26 after two probe passes of the Alabama FCPA system (findings + verification detail in `backend/docs/alabama-campaign-finance.md`, including two addenda that cross-checked an external feasibility report and a terse implementation spec point-by-point). Totals-only module: Alabama does not collect donor occupation/employer, and its disclosure schema has no independent-expenditure target or support/oppose direction, so both are structurally unavailable — not sparse.

## Goal and v1 scope

State-level candidates on the November 2026 ballot (statewide, legislature, judicial; county deferred, municipal excluded):

- Total raised, total spent, cash on hand — from the state's own race-level summary API, verified against bulk extracts.
- Direct-contribution size buckets from itemized cash rows.
- `outsideSupportTotal` / `outsideOpposeTotal` stored as **null, never zero**. No outside-group rows. No occupation rows. No new frontend work: nulls render through the existing UI (sections absent, never $0); coverage detail lives in sync diagnostics.

Out of scope permanently (source limitation, do not revisit without a statute change): occupation/employer breakdowns; candidate-directed outside spending. Rejected inference routes (FEC name-matching, people-data services, expenditure free-text, PAC-name heuristics) are documented in the findings doc and stay rejected.

Out of scope for v1 (revisit later): county candidates (enable after exact-identity link audit), municipal candidates (HB 156: no filing legitimately means ≤$1,000 activity — needs UI that distinguishes `not required to file` from `filed zero` before enabling), PAC funder/industry views.

## Source model (all verified live 2026-08-26)

System: Tyler entellitrak app at `https://fcpa.alabamavotes.gov/` ("AL Campaign Finance System"). No auth, no CAPTCHA, JSON responses. The pre-2025 `PublicSite` system is dead — any old URLs redirect to a login page.

**TLS:** the server sends an incomplete certificate chain. The client must supply the missing intermediate CA (custom `connect.ca` on an Undici `Agent` passed as `fetch(..., { dispatcher })` — a Node `https.Agent` would not affect Undici/global fetch; intermediate fetched once and committed as a PEM fixture, see `alabamaFcpaTls.ts`). Never disable verification.

### Primary: political race search (roster + totals)

`GET /page.request.do?page=com.acf.common.page.politicalracesearchresults&pageNumber=1&pageSize=100&sortDirection=ASC&sortBy=candidate&election=160&office=<id>[&jurisdiction=<id>&district=<id>&party=<id>]`

- `election=160` = "2026 ELECTION CYCLE". Election/office/jurisdiction dropdown id maps are embedded in the search page HTML (`page=page.acfPublicPoliticalRaceSearch`); scrape them per sync, do not hard-code beyond 160 + verified office ids (23 = Governor).
- **Omit the `year` param for cycle totals.** It works but takes an internal option id from the page's `financialYear` dropdown (1 = 2026, 12 = 2025 — NOT the literal year, which returns 0 rows). Year-scoped rows attribute money differently from the extracts' contribution-date years (Jones 2025: race-year row $105,546.38 vs extract $588,344.73) — never mix them; the no-year response is the authoritative cycle aggregate.
- Row fields: `COMMITTEEID` (internal id), `CANDIDATE`, `CANDIDATESTATUS`, `BEGINNINGFUNDS`, `MONETARYCONTRIB`, `MONETARYEXP`, `NONMONETARYCONTRIB`, `OTHERSOURCES`, `ENDINGFUNDS`, `YEAR`. **No district/jurisdiction column** — a legislative office query returns every district's candidates in one flat list (State Rep: 193 rows). District comes from joining `COMMITTEEID` → committee-search `id`, whose `jurisdiction` field carries it ("HOUSE DISTRICT 68"); verified live 2026-08-28: 193/193 State Rep race rows join; 192/193 have jurisdiction populated (the gap is a 06/2026 registration with no jurisdiction or place — the resolver fails closed to manual review on missing district).
- Verified accounting identity: `ENDINGFUNDS = BEGINNINGFUNDS + MONETARYCONTRIB + OTHERSOURCES − MONETARYEXP` (in-kind and line-of-credit excluded, matching the portal's own warning). Tuberville exact to the cent. Jones shows a $500.00 residual in the aggregate contribution/expenditure columns, but `ENDINGFUNDS` itself is filing-chain-validated: July monthly cover ending balance $1,659,100.23 + the $20,000.00 Major Contribution Report filed 08/26 = $1,679,100.23 exactly. Trust `ENDINGFUNDS`; treat column residuals as a reconcile-tolerance item.
- Verified cross-year cent-exactness vs extracts: Jones `MONETARYEXP` 1,984,347.70 = 2026 extract 1,962,002.67 + 2025 report 22,345.03.
- **VoteApp ballot data is the roster.** The resolver iterates our Nov-2026 candidates; race rows are the FCPA-side match-and-totals source. Within FCPA, race rows beat the PCC committee search for that job (2026 Governor: 9 race rows incl. Tuberville and dissolved candidates vs 22 "Active" committees incl. 2022 leftovers) — committee search is metadata fallback only (internal id ↔ FCPA committeeId ↔ party/office).

### Secondary: bulk extracts (size buckets + verification)

Catalog: `GET /page.request.do?page=com.acf.common.page.transactiondatadownloadsresults&pageSize=100&pageNumber=1&sortDirection=ASC&sortBy=state` → `{DATATYPE, YEAR, LASTUPDATED, DOWNLOAD:<id>}` per file (2013–2026, 4 types, regenerated daily ~02:32 AM CT). Download: `page=getTransactionData&id=<DOWNLOAD>` → zip with one CSV. **Ids are catalog rows, not stable — re-read the catalog every sync.**

v1 needs only the Cash Contributions extract, pulled for every transaction-date year in scope — not just 2025 + 2026: Phase 0 found a 2025-registered committee with a 2024-dated contribution living in the 2024 file, so the extract-year window is the transaction-date years (2024–2026 observed), not the committee's registration life:

- Header: `CommitteeId,ContributionAmount,ContributionDate,LastName,FirstName,MI,Suffix,Address1,City,State,Zip,ContributionID,FiledDate,ContributionType,ContributorType,CommitteeType,CommitteeName,CandidateName,Amended`.
- `CommitteeId` here is the FCPA committee number (e.g. 32837), NOT the race row's internal `COMMITTEEID` (e.g. 7962). The committee search response carries both (`committeeId` + `id`); the resolver must store both.
- The cash file **embeds in-kind rows** (`ContributionType` = In-Kind …) with the same transaction ids the separate In-Kind extract uses; in-kind ids never collide with cash ids. v1 ignores the In-Kind file entirely and filters in-kind rows out of size buckets.
- Extracts are current-state snapshots: transaction ids are unique, `Amended=Y` marks the current post-amendment version — **keep those rows**, never drop or double-load.
- ~2.5% of expenditure-extract lines are malformed (unescaped quotes: wrong field counts plus lines swallowed into neighbors — 877/34,505 in the 2026 file); the cash file is nearly clean (4 mis-fielded rows in the 2026-08-26 snapshot; files regenerate daily, so counts drift — assert by method, not exact number). The parser must be tolerant: count and report skipped lines, never abort the file, never silently mis-assign columns (a row whose `ContributionAmount` fails numeric parse or whose `ContributionID` is non-numeric is quarantined, not guessed at).

### Tertiary: verification anchors

- Filing detail page (`page=page.acfPublicFilingDetail&filingId=<n>`): structured per-report cover — beginning/ending balance, itemized/non-itemized splits. Correct balance anchor. (The `acfPublicCommitteeFinancialSummary` page takes the internal id **plain, not base64**, and can anchor to a Major Contribution Report with no balance accounting — do not use it for balances.)
- Interactive searches export max 20,000 rows — human verification only, never ingestion.

## Summary mapping

| Writer field | Source | Rule |
|---|---|---|
| `totalReceipts` | race row | `MONETARYCONTRIB + NONMONETARYCONTRIB + OTHERSOURCES` |
| `directContributionTotal` | race row | `MONETARYCONTRIB + NONMONETARYCONTRIB` |
| `totalDisbursements` | race row | `MONETARYEXP` (state accounting excludes line-of-credit; statewide LOC ≈ 0.4% of well-formed 2026 spend — $312,710.75 vs $76.8M) |
| `cashOnHand` | race row | `ENDINGFUNDS` (filing-chain-validated; includes post-cover major-contribution reports) |
| `outsideSupportTotal` / `outsideOpposeTotal` | — | null |
| direct `contribution_size` rows | cash extract | itemized cash rows only — exclude in-kind rows, `Cash (Non-Itemized)`, and `ContributorType = Returned (Cash Only)` rows (Florida precedent: in-kind/refund/returned stay out of direct buckets); amounts are signed (negative rows exist — 1 in the 2026 file) and must be handled, never abs()'d |
| `occupation` rows / outside rows | — | none written |

Freshness/reconcile note: displayed totals carry **no dollar tolerance** — the Phase 0 authority contract validates race totals cent-exact against the committee's filed report covers (same source, no time window). Extracts are never an acceptance check on totals: they lag (~02:32 AM regeneration, one day's filings drift — observed exactly $20,000 on Jones) and can permanently omit filed rows, so extract-vs-race comparison is a **coverage ratio** for the size buckets (observed 0.989–1.0), reported in sync diagnostics under the rule in Phase 3.

## Phase 0: reconciliation probe (no schema, no flags)

**STATUS: DONE 2026-08-26 — PASSED; re-run 2026-08-28 — PASSED** (`npm run alabama-candidates:finance:phase-zero`, `ok: true`; the re-run added legislative + judicial enumeration — State Rep 193 rows, State Senator 68, Supreme Court Associate Justice 4 — and a district-join gate: 193/193 State Rep race rows join the committee search, jurisdiction populated on all but 1). Key outcome: the gate became the **authority contract** — race totals == Σ filed-report covers, cent-exact (verified 3 fixtures incl. 99-filing Tuberville and 10-amendment Boyd) — while extracts get a coverage ratio (observed 0.989–1.0; they can miss rows covers contain). Full findings in `backend/docs/alabama-campaign-finance.md` §Phase 0 results. Consequences for later phases: totals from race API, buckets from extracts with coverage reported; extract-year window = transaction-date years (2024 file needed); Major Contribution Report covers have a reduced layout; filing-detail fetches need retries.

The spec below is the original pre-run gate, kept for the record. Where it conflicts with the STATUS line above or the findings doc's §Phase 0 results (which replaced extract-sum reconciliation and the extracts-as-primary fallback with the covers authority contract), the findings doc wins.

Script `npm run alabama-candidates:finance:phase-zero` (pattern: `newHampshirePhaseZero.ts`). Must demonstrate, against live data:

1. Race rows for ≥3 offices (Governor + one legislative chamber + one judicial) enumerate correctly from scraped dropdown ids under election 160.
2. For ≥3 committees spanning large/small: race `MONETARYCONTRIB + NONMONETARYCONTRIB` reconciles to cash-extract sums (2025+2026) within the one-day freshness tolerance, and `MONETARYEXP` reconciles to expenditure-extract sums + prior-year covers cent-exact.
3. Aggregate-column residuals are characterized: confirm whether `MONETARYCONTRIB` counts `Returned (Cash Only)` rows positively (their extract amounts are positive), and bound the Jones-style $500 column residual. `ENDINGFUNDS` is already filing-chain-validated; the freshness rule (race API includes same-day filings the 02:32 AM extracts lack — observed $20,000 Major Contribution Report) sets the reconcile tolerance.
4. Amendment behavior: pick a committee with `Amended=Y` rows, confirm the extract row matches the current filing detail (not the superseded version).
5. TLS: client connects with the pinned intermediate, verification on.

Stop rule: if (2) fails outside tolerance on any committee, do not proceed — fall back to extracts-as-primary (the slower path the findings doc originally sketched) and re-plan.

## Phase 1: client, cache, parser

**STATUS: DONE 2026-08-28.** Client, CSV parser, and TLS shipped with the Phase 0 PR; this phase added `alabamaFcpaArtifactCache.ts` (raw-zip artifact cache with integrity metadata, unchanged-detection on CSV checksum since zips recompress daily, verified read-back that fails closed on corruption) plus tests, and split the client's download into raw-zip-bytes + unzip so the cache stores exactly what the portal served. No separate `alabamaFinanceTypes.ts` — types live in the client/csv modules where they are used. Live-verified: 2024 cash extract cached (57,908 rows, 2 quarantined), second refresh reported `unchanged`.

`backend/src/pipeline/alabamaFinance/`:

- `alabamaFcpaClient.ts` — race search, dropdown-id scrape, extract catalog + download, committee search (fallback), filing detail + filings-list fetch (`committeeelectronicfilingsresults&committeeId=<internal id>`). Every list endpoint paginates via `totalRecords` (never assume one page). Concurrency 1–2, bounded timeouts, pinned CA.
- `alabamaFcpaArtifactCache.ts` — raw zip bytes keyed by (dataType, year) with retrieval time, source URL, checksum; reject HTML bodies/empty archives/changed headers; keep last good artifact on failure (pattern: `newHampshireCfsArtifactCache.ts`).
- `alabamaFcpaCsv.ts` — tolerant cash-extract parser per the rules above, with skipped-line accounting surfaced in the sync report.

Tests: fixture zips (small hand-built CSVs incl. ragged lines, in-kind rows, Amended=Y, returned contributions); race/committee search JSON fixtures; no live calls.

## Phase 2: schema, flags, source label (launch checklist — see voteapp-new-state-finance-checklist)

- Migration `NNN_add_alabama_campaign_finance_tables.sql` — next free number at implementation time (≥257; check open finance PRs #885/#886/#887 for claimed numbers first; never renumber). All five standard tables so `standardStateFinanceSnapshotWriter` works unchanged: `al_candidate_finance_links`, `_summaries`, `_direct_breakdowns`, `_outside_groups`, `_outside_group_breakdowns` (outside tables stay empty by design). All identifiers ≤63 chars.
- `featureFlags.ts`: `ALABAMA_CAMPAIGN_FINANCE_ENABLED`, `ALABAMA_CAMPAIGN_FINANCE_SYNC_ENABLED`, plus `ALABAMA_FCPA_RAW_DATA_REFRESH_ENABLED` gating the artifact-refresh command (NH pattern) with its `npm run alabama:finance:refresh-artifacts` script; code defaults false; document in `backend/.env.example` (tracked, alphabetical — NH pattern), set in local `backend/.env`, and add the read flag to `render.yaml` (prod values live in Render's environment).
- Source enum `ALABAMA_FCPA` in `ballotLookupFinanceShared.ts`; `FINANCE_SOURCE_LABELS` entry "Alabama FCPA Reporting System" in `packages/api-client/src/format.ts` (alphabetical) + `format.test.ts` case; **`FINANCE_SOURCE_HOME_URLS` entry** (`https://fcpa.alabamavotes.gov/`) in `packages/api-client/src/finance.ts` + its test.
- Keep `backend/docs/alabama-campaign-finance.md` updated (committed with the Phase 0 PR).

**STATUS: DONE 2026-08-28.** Migration `263_add_alabama_campaign_finance_tables.sql` (Montana 261 twin; validated by a full from-scratch migration run on a throwaway local database). One deliberate addition beyond the spec above: the links table carries a nullable `fcpa_committee_number` column (extract `CommitteeId`, e.g. 32837) alongside `committee_id` (internal portal id, e.g. 7962), because Phase 3 requires storing both ids and the standard snapshot writer's fixed link upsert can only populate `committee_id` — the resolver backfills the extra column and the sync skips buckets (with a diagnostic) while it is NULL. `link_source` values are `('manual', 'fcpa_race_search')`. Flags + refresh script shipped as specced, except the npm script name follows the fleet convention instead of the bullet above: `npm run alabama-candidates:finance:raw:refresh` (NH twin; repeatable `--year` off one catalog read, `--artifact-kind`, `--cache-dir` / `ALABAMA_FCPA_RAW_DATA_CACHE_DIR`, `--timeout-ms`, `--force` bypassing only the refresh sub-gate, and a separate `--accept-empty` for the cache's zero-row guard — gate bypass is routine, discarding a populated artifact for an empty extract is not, so they never share a flag). `ALABAMA_FCPA` registered in the source union + `FINANCE_SUMMARY_SOURCES`, label + home-URL maps + tests. `render.yaml` read flag added as `"false"` until Alabama data reaches prod. Local `backend/.env` lives in the main checkout (worktree discipline) — add the three flags there by hand before the Phase 4 live run.

## Phase 3: resolver, sync, loader

- `alabamaFinanceEligibleOffices.ts` — explicit office allowlist (statewide + legislature + judicial), the only offices the resolver touches.
- `alabamaCandidateResolver.ts` — VoteApp Nov-2026 candidates in allowlisted offices → race rows. Link requires normalized candidate name match + compatible office/district (district via the committee-search `jurisdiction` join — race rows carry no district column) + election cycle; store internal `COMMITTEEID`, FCPA `committeeId`, and source URL. Ambiguity (two plausible rows, or race row absent for a ballot candidate) fails closed to manual review. Never link on name alone. Auto-link must never overwrite a `linkSource: manual` row.
- `alabamaCandidateFinanceSync.ts` — per linked candidate: summary from live race row; `contribution_size` buckets from cached cash extracts filtered to the FCPA committeeId and transaction-date-year window; cash coverage ratio = (itemized + non-itemized extract cash) ÷ race `MONETARYCONTRIB`, always reported. Coverage gates **buckets only, never the summary** — a lagging or permanently incomplete extract must not leave authoritative totals stale: outside [0.97, 1.01] (brackets the observed 0.989–1.0 with headroom for one day's filings drift; above 1.01, or race total 0 with nonzero extract cash, means a bad committee join), write the race-row summary with no size buckets plus a diagnostic. Full-replacement write via `createStandardStateFinanceSnapshotWriter`; keep the previous snapshot only when the race row or covers themselves fail to fetch/parse.
- Loader `directCoverageNote` (house pattern — GA/MO/RI/Denver/WA): tell voters the size buckets cover itemized cash contributions only, while the raised total also includes non-itemized cash, in-kind, and other receipts.
- `alabamaBallotLookupFinanceLoader.ts` via `standardStateFinanceBallotLookupLoader`, registered alongside the other states; due-list mechanics per the finance sync runbook (link-gated).
- Sync diagnostics per candidate: extract last-updated stamp, skipped-line counts, itemized vs non-itemized dollars, reconcile delta, explicit `occupation_unavailable` / `outside_unavailable` reasons.

**STATUS: DONE 2026-08-28.** Shipped as the SC file shape: `alabamaFinanceEligibleOffices.ts` (v1 allowlist = 9 statewide keys incl. `State Level Judge` + both chambers; FCPA office-label map pinned from the live dropdown — `Lt. Governor`, `Commissioner of Agriculture & Industries` needs the `&amp;` decode, judicial routed by ballot-title regex, no-rule titles fail closed), `alabamaCandidateRaceResolver.ts` (full-name match via the shared middle-evidence helper; trailing-suffix commas rewritten "Julius Walker, Jr." → "Julius Walker Jr." so the comma isn't parsed as Last,First; roster first names expanded through the shared nickname table — race rows carry LEGAL names, live-observed "TUBERVILLE, THOMAS H" for roster "Tommy Tuberville"; legislative matches must district-confirm through the committee-search `jurisdiction` join, with missing committee row / missing jurisdiction / district mismatch and unconfirmable same-name rows all failing closed to manual review), `alabamaDirectFinanceAggregator.ts` (Delaware bucket edges; buckets = positive `Cash (Itemized)` minus `Returned (Cash Only)`; coverage cash = signed non-in-kind sum; ratio gates buckets only), `alabamaFinanceWriter.ts` (standard writer, outside replace-to-null, `fcpa_committee_number` backfill helper), auto-link + due list + batch sync (one office fetch and one artifact parse per batch via memoized loaders; auto-link shares the sync flag), `alabamaCandidateFinanceSync.ts` (summary always from the live race row per the Summary-mapping table; bucket window = cached cash artifacts `electionYear-3..electionYear`, never fetched live; any gate failure — missing FCPA number, unreadable artifact, coverage out of band — clears stored buckets and keeps the summary, and a missing race row throws with nothing written), loader `alabamaBallotLookupFinanceLoader.ts` registered in `ballotLookup.ts`, CLIs `alabama-candidates:finance:auto-link` / `:sync-due`. Live read-only smoke 2026-08-28: 5 office labels resolve, race↔committee joins 9/9, 193/193, 4/4, 4/4, 10/10; Tuberville resolves matched (internal 6750, FCPA 31625). Review round: (1) predecessor-committee policy — same-name rows tie-break to the single Active committee ONLY when every other row is a zero-money registration; a predecessor with real money fails closed to review (live: Brad Mendheim has Active + Dissolved Supreme Court committees, the dissolved one with $23,500 raised/$81,660.96 spent this cycle — no summation policy exists, transfers would double-count naively); (2) bucket window is term-aware — six years for `State Level Judge` (appellate terms), four otherwise (`alabamaOfficeTermYears`); (3) a NULL `fcpa_committee_number` self-heals during sync from the committee-search join (and the backfill helper is keyed by link identity, not link id), so a crashed auto-link backfill or a manual link is repaired on the next sync. 68 Alabama tests.

## Phase 4: live run + prod checklist

Local: link + sync the Nov-2026 statewide slate, spot-check 3 candidates against filing details in the portal UI. Prod: migration, flags in Render env, deploy, then **run the sync directly against production** — per-state finance tables are never promoted (the promote scripts only carry `finance_committee_labels`). Re-sync near November.

**STATUS: LOCAL RUN DONE 2026-09-01/02; prod pending.** Order that worked: three flags into `backend/.env` → `alabama-candidates:finance:raw:refresh --year 2021 … --year 2026` (six cash extracts, 515k rows, 9 quarantined) → `alabama-candidates:finance:auto-link --max-candidates 300` → `sync-due --no-auto-link --max-candidates 300` (default `--max-candidates` is 10/25; the CLI rejects `--stale-after-days 0`, so a forced re-sync ages `last_synced_at` by SQL). Result: **213 links / 213 summaries / $66.9M raised / 693 size-bucket rows**, 0 failures. Links: 183 auto (of 219 eligible candidate-elections) + 30 manual; the 36 auto-link misses were harvested against the race rows and were almost all goes-by-middle-name cases ("Matt Gentry" = GENTRY, KEVIN MATTHEW; "Danny Garrett" = GARRETT, JOHN DANIEL; "Will Barfoot" = BARFOOT, CHARLES WILLIAMSON) plus Elaine Beech's jurisdiction-less committee — linked by hand (`link_source = 'manual'`, district-confirmed) after eye review. Left unlinked on purpose: Brad Mendheim (dual committees, no summation policy), Thayer Spencer / Ronald Burnette Jr. / Kinsley Hammons / Charlie Watts (no FCPA race row = not filed), and the Will Barfoot **District 26** roster row (a roster defect — his committee is SD 25).

Three defects the live run exposed, all fixed in this phase (see findings doc, Phase 4 correction): (1) **the race row's aggregate columns are not cycle-scoped** — they add every untagged Annual / Major Contribution Report the committee ever filed, so 127/183 first-pass coverage ratios sat at 0.26–18×; the summary now comes from filed covers with period begin ≥ Jan 1 of the first term year (`alabamaCommitteeCycleCovers.ts`), which restores the balance identity cent-exact and lifts bucket coverage to 153/213; the race row stays the identity gate + cash-on-hand source; (2) `push(...rows)` overflowed the call stack on the 117k/120k-row 2025/2026 extracts (every bucket gated off as `artifact_unavailable`); (3) overdrawn balances render as `($220.23)` — parser now accepts them; the writer rejects a negative `cash_on_hand`, so those four committees store `null` with a `cash_on_hand_negative_not_stored` diagnostic. Also: committee 7460's filings list advertises 17 rows and serves 16 at every page size — the pager now accepts a list the portal closes with an empty page. Remaining diagnostics are informational: 12 `cash_on_hand_identity_mismatch` rows (Jones's known $500 residual; several round-number gaps such as Ortis $500,000 that look like a filer re-listing a major contribution inside a monthly report — we show the portal's own figure) and 60 coverage-gated bucket sets (extract omissions, e.g. Joseph Cleveland 0.27). Spot-check: Robertson (AG, 47 filings) cent-exact vs covers; Stutts (SD 6, 105 filings) and Daniels (HD 53, 83 filings) exact on the window rule; read side verified through `loadAlabamaCandidateFinanceSummariesByCandidateElection` (Stutts $173,766.49 raised, buckets sum to his itemized cash). Prod: migration 263 and the code are already deployed (08-31 round); `render.yaml` read flag flipped to `"true"` in this PR; remaining = deploy + run refresh/auto-link/sync from a main snapshot with the prod DSN (sync flags inline, never in Render).

## Gotcha bank (carry into implementation)

1. `year` param on race search takes dropdown option ids (1 = 2026), not literal years, and its year attribution differs from extract years — omit it; use the no-year cycle aggregate.
2. Extract download ids: unstable catalog rows, re-read per sync.
3. Cash extract contains in-kind rows — same ids as the In-Kind file; filter by `ContributionType`, don't double-count.
4. `Amended=Y` = current version, keep.
5. Race `COMMITTEEID` (internal) ≠ extract `CommitteeId` (FCPA number) — store both, join via committee search.
6. Financial-summary page: plain internal id (not base64) and unreliable for balances; filing detail is the balance anchor.
7. PCC committee search requires the `committeeType:"1"` criteria row and returns stale registrations — never use it as roster.
8. Ragged CSV lines (~2.5% expenditures file) — tolerant parser, quarantine + count.
9. Extracts regenerate ~02:32 AM CT; race API is live — one-day drift is normal.
10. Municipal: no filing ⇔ possibly ≤$1,000 by law (HB 156) — excluded from v1; if ever enabled, absence must render as unavailable, not $0.
11. TLS incomplete chain — pinned intermediate, verification always on.
12. `Returned (Cash Only)` rows carry POSITIVE amounts; one genuinely negative cash row also exists — handle signed amounts, exclude returned rows from buckets, characterize their effect on `MONETARYCONTRIB` in Phase 0.
13. Malformed-row amounts poison naive sums (they inflated a statewide spend estimate 8×) — quarantine before any aggregation, including in diagnostics.
14. Race rows have no district column — district for legislature/districted courts comes only from the committee-search join (`jurisdiction`); a race query returns all districts of an office flat.

## PAC verification: purchase refunds (2026-10-28)

The public receipt ledger uses literal `Refund` for a purchase refund reported under Other Receipts. Treat that category as non-contribution money when reconciling PAC cash. The [SOS Other Receipts guide](https://sos.alabama.gov/sites/default/files/fcpa/Other%20Receipts%20Quick%20Reference.pdf) distinguishes purchase refunds from contributions; the [EDI specification](https://fcpa.alabamavotes.gov/page.request.do?page=getResource&resource=ediSpecification) separately defines `Refund`, `Return Contribution/Check`, and `Returned (Cash Only)`. The latter two remain unresolved return gates. Unknown aliases remain held. Refund rows still participate in the complete native opening/closing edition comparison.

Local production sync proof: one existing eligible receiver gained 37 donor groups from 40 accepted PAC cash occurrences. Independent full-file traversal and uncapped source/store comparison checked all 98 current cash rows against the native ledger and 23 filed covers. Six unrelated malformed bulk records were quarantined; none belonged to the receiver. Ordinary HTTP and the hydrated candidate card, including a fresh reload, matched displayed names, money and source links. Unrelated Alabama rows, outside components and the migration ledger stayed unchanged. Native Other Receipts detail totals do not reconcile to filed covers; that separate discrepancy remains unresolved. Summary authority remains the filed covers, and Other Receipts do not enter contribution cash or PAC totals. This proof does not establish outside-spending coverage.

Late filings require another refresh and sync after the applicable deadline. The [official 2026 filing calendar](https://www.sos.alabama.gov/sites/default/files/fcpa/2026FCPAFilingCalendar.pdf) lists:

- Third general weekly report: October 26, covering through October 23. The local reread and sync above occurred October 28.
- Fourth general weekly report: November 2, covering through October 30, with the calendar's exception for daily filers. Conditional daily reporting runs October 26–November 2; the final daily report is due by 12:01 p.m. November 2. Manually refresh and re-sync November 3–4, then check late filings again November 6.
- Annual report: January 31, 2027. Manually refresh and re-sync February 1 and check again February 3.

These are manual follow-up checkpoints; no scheduled automation or production run is part of this change.
