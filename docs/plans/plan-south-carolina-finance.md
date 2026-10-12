# South Carolina Campaign Finance Plan

## October 12, 2026 finance-gap continuation

The candidate-only sync acquires no outside evidence, so omitted outside totals
and groups now preserve previously stored values independently of direct cash.
The reader describes incomplete coverage without treating missing values as zero.
This foundation does not implement PAC donors or allocate vendor-only IE payments.
Committee donors will follow Pennsylvania's reported-name fallback, adapted to
SC's actual fields: `Group=Yes`, blank published occupation, and standalone
PAC/Political/Committee or dotted P.A.C. evidence. SC publishes no employer field.
Names are reported identities, not verified legal committee IDs or explicit PAC
source types; generic Association/Union/League/Council and acronym suffixes alone
are excluded. Distinct full names remain distinct. Prospective Guffey evidence:
24 receipt occurrences, 22 reported-name groups, $13,999.26; these are source
calculations, not canonical DB proof. Before writing, verify current report
versions, complete cash/expense/return controls, exact organization occurrences,
and unchanged independent financial observations. Net explicit returns by unique
reported owner before recognition; never select a particular gift without a
source reference. Unexplained returns preserve the entire donor component.
Use the existing atomic snapshot hook, a small per-link donor table, and the
existing interest card with unclassified names under Not yet sorted. Saved raw
JSON precedes fresh acquisition; raw capture failure or inconsistent observations
preserve donor rows independently of direct totals. No generic new framework.
Outside allocation still needs an actual published candidate/stance allocation.
Generic `Group=Yes` is not a PAC type; reported names and distinct source IDs must
remain intact. No Original-only amendment policy or inferred return ownership.

[Official election guidance](https://ethics.sc.gov/campaigns/election-material):
combined quarterly/pre-election due October 19, covering through October 14.
Mandatory fresh source rerun October 20; posting retry October 23. Nominal Q4
deadline January 10, 2027 falls Sunday: Commission regulation 52-208(A) supports
January 11; House/Senate applicability remains unverified. Refresh January 12,
posting retry January 15, after checking separately issued legislative guidance.
[Commission computation rule](https://www.scstatehouse.gov/query.php?category=CODEOFREGS&conid=7768413&keyval=99429&numrows=10&result_pos=50&search=DOC&searchtext=Regulations)
and [appropriate supervisory office](https://www.scstatehouse.gov/code/t08c013.php)
must not be conflated. `--refresh` bypasses staleness before LIMIT; candidate/year
scopes also precede LIMIT. `--force` only overrides the sync feature flag.
First/changed financial observation preserves donors and indexes the new closing;
rerun the same scoped fresh command to obtain a second complete observation.
Flags stay inline, AI false; no production or automatic reminders.
The historical v1 outside-null/deletion contract below is superseded by these
omission/preservation semantics. Source feature completion still requires ordinary
local sync, real row counts and the production card reader before a state-only PR.

Ordinary local sync proof (October 12 UTC): Brandon Guffey, filer 44315, 2026
House District 48: 22 stored reported-name donor rows, 24 receipt occurrences,
$13,999.26 net. Production reader returns the complete amount and 22-donor count
under Not yet sorted, displaying five names. Raised remains $39,124.26; reported
receipts $39,310.46, spent $26,875.15, cash $18,416.52. Outside totals remain NULL;
vendor-only payments are not allocated. Migration 335 was applied normally to
local Postgres and is immutable. No canonical money was manually injected.

Fresh pre-election command (run again if donor diagnostics report a changed or
missing opening; omit candidate scope for a full linked-candidate pass):

```sh
AI_API_CALLS_ALLOWED=false SOUTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED=true \
  npm run south-carolina-candidates:finance:sync-due -- --refresh --no-auto-link \
  --election-year 2026 --max-candidates 1000 --lookback-days 100
```

Use the configured local database and an ignored or external `--source-cache-dir`.
Review per-candidate diagnostics and failed counts; an attempted pass is not proof
of complete outside coverage. Later filings and amendments still require refresh.

Written 2026-08-26 after a live feasibility probe of both South Carolina disclosure systems; revised same day after a design review was itself verified point-by-point with further live probes (ID-space check, McMaster 2022 cycle-reset evidence, shared writer/loader code reads). Source findings, verified numbers, endpoint shapes, and statute cites live in `backend/docs/south-carolina-campaign-finance.md`; this plan is the implementation contract. The module must stay isolated, flag-gated, conservative about identity, and reuse the shared standard-state finance infrastructure (`standardStateFinanceSnapshotWriter.ts`, `standardStateFinanceBallotLookupLoader.ts`, `standardStateFinanceDueListQuery.ts`).

## Verdict and v1 scope

South Carolina supports authoritative direct-finance totals and useful filing-backed direct-contribution breakdowns; breakdown completeness is observed, not guaranteed (§ 8-13-1308(F) only requires itemizing sources over $100, even though tested filings itemize everything). It is a poor outside-spending state.

V1 ships, per linked candidate:

- Total raised, total spent, and cash on hand (cent-exact from official report summaries).
- Top occupations of individual direct donors and standard contribution-size buckets, from itemized rows, with a `direct_coverage_note` when itemized rows lawfully undershoot the official total.
- `outsideSupportTotal = null` and `outsideOpposeTotal = null` — unavailable, never zero. No outside-group rows, no outside-industry rows.

Outside spending is excluded because committee filings (legacy portal) expose no independent-expenditure flag, no candidate target, and no support/oppose direction, even though § 8-13-1308(F)(4) requires a beneficiary on certified reports. Do not infer stance from vendor names, descriptions, committee names, or race context. Outside spending unlocks only via an official State Ethics Commission extract (see Deferred work).

Office scope for v1: statewide offices plus SC Senate and SC House, restricted to the November 2026 election set VoteApp covers. County and municipal filers use the same API and can be enabled later by widening the eligibility predicate only.

## Proven source access

Candidate system: `https://ethicsfiling.sc.gov` — open JSON API, no auth, no key, no session, no paging. V1 uses exactly four endpoints:

1. `POST /api/Ethics/Get/Public/Search/By/Filer/Name/` — body is a bare JSON string (`"Wilson"`). Matching is contains/fuzzy, not prefix (`"Wilson"` also returns `Johnson-Wilson`); filter results locally to the exact normalized surname before candidate matching.
2. `POST /api/Ethics/Get/Public/Candidate/Reports` — `{"candidateFilerId":N}` → report index. Each row's `contributions` / `expenses` / `balance` are cumulative **per election run** (see cycle-reset finding below), keyed by that row's `electionDate`.
3. `GET /api/Ethics/Get/Public/Candidate/Report/Details/{reportId}` — authoritative report summary: income and expenditure lines by type (each with `filingPeriod` and `electionCycleTotal`), loans, versions. Contribution rows here carry `contributorId` (an entity id) — **not** joinable to search rows. POST `Candidate/Report/Get/*` variants are 401; always use this GET.
4. `POST /api/Candidate/Contribution/Search/` — itemized rows with `contributionId`, `candidateId`, `officeRunId`, `contributorOccupation`, `group` (Yes/No), amount, date, address. This is the only source of the `group` flag, so all breakdowns come from these rows. Rows cover cash + in-kind contributions (verified: Wilson search-row sum equals income Total = cash + in-kind).

Request contract facts (encode in the client):

- There is no server-side `candidateId` filter. Unknown body fields are ignored; a body with only unknown fields returns HTTP 500 ("Please search for something..."), not a statewide dump. Always send `{"candidate":"<surname>","contributionYear":<year>}` (numeric year, matching the official SPA; string also works) and filter rows locally by exact `candidateId` and accepted `officeRunId`s. Reject any request the client would send without a recognized server filter.
- The 2026-cycle statewide `officeName` is the literal string `"4"`; never filter or confirm office by office text for current-cycle statewide runs.
- The candidate portal *does* have global contribution/expenditure searches; it is the legacy committee portal that lacks any target-aware transaction search (an external report's "6-month / 500-record" committee search does not exist).

### Cycle-reset finding (answers the primary→general question)

McMaster 2022 (filer 27353): primary-run reports (elec 6/14/2022) climb to `contributions 5,528,030.35`; the next report, `Quarter 3 & Pre-Election (General) Report 2022` (elec 11/8/2022), restarts at `2,103,841.11`. Cumulative totals reset per election run. Therefore:

- A campaign's total raised/spent = sum of the final cumulative totals of each accepted run (primary + runoff + general) for the linked office and cycle.
- Cash on hand = `balance` of the chronologically latest report across those runs (balances carry over).
- Combined report names are real and must parse: `Quarter 3 & Pre-Election (General) Report 2022` (type `Pre-Election Quarterly`), `Quarter 4 & Final 2023 Report`.

### Report ordering and amendments

Choose the newest **filing period**, then the newest version of that period. Never order by submission or amendment timestamp: Evette's pre-election report was amended 2026-07-14 (cycle total $4.58M) after Q2 was filed 2026-07-10 (cycle total $6.20M) — timestamp ordering regresses totals. Amendments replace and can consolidate rows (Evette pre-election: Original 423616 = 399 rows, current Amendment 4 = 430061 = 356 rows, identical totals: cash $402,015.21 + in-kind $479.25 = $402,494.46).

### Refunds

Returned contributions appear as **positive expenditure rows** (`Refund Excessive`, `CHARGEBACK`), already included in the official expenditure Total; no negative contribution rows exist in tested data. Keep original contributions in breakdowns, do not match refunds back to donors, take total spent from the official summary. No netting logic anywhere.

## Phase 0: residual spike — DONE 2026-08-26 (except the agency ask)

1. **Below-$500 filer** ✓ — reports endpoint returns normal rows with `0.0` totals (verified filer 55794: `Quarter 3 & Pre-Election (General) Report 2025` and `Quarter 4 & Final 2025 Report`, all zeros). "Filed zero" is directly representable; a filer with no reports returns empty `results` ("no filing yet").
2. **Search rows track amendments** ✓ — Evette search rows dated inside the amended pre-election filing period (2026-04-01..05-20) = exactly 356 rows summing $402,494.46, matching Amendment 4's contributionsTotal to the cent. `Contribution/Search` serves current (amended) data. Her governor cycle is a single run (officeRunId 77609) spanning 2025-2026 rows.
3. **Agency ask** — outstanding: send the State Ethics Commission the outside-spending data request (beneficiary per § 8-13-1308(F)(4), IE classification, stance, bulk extract). Gates only the deferred outside phase; v1 does not wait.

## Phase 1: client + types — DONE 2026-08-26

`backend/src/pipeline/southCarolinaFinance/southCarolinaEthicsClient.ts` — the four endpoints, row types inline (NH client idiom), typed error class, injected `fetchImpl`, timeout via `AbortSignal.timeout`, 64 MB byte cap, JSON content-type required (SPA HTML fallback rejected), report rows integrity-checked against the requested `candidateFilerId`, contribution search refuses to fire without candidate text + valid year, contributor street addresses never parsed. Bonus source finding folded in: report-index rows carry `reportWithDates.campaignId` (= officeRunId) plus ISO `filingStartDate`/`filingEndDate` and `isPrimary`/`isGeneral`/`isPreElection`/`isFinal` — run grouping and period ordering use these, no date heuristics.

**No disk artifact cache in v1** (revised from the original plan): unlike New Hampshire's bulk CSVs or Missouri's acquired exports, SC syncs are three or four small per-candidate JSON calls where fresh data is exactly what a due sync wants, and nothing is shared across candidates. Dropping the cache removes a file, an acquisition/read indirection, and the on-disk donor-address privacy surface entirely. Tests inject `fetchImpl`.

Tests: `backend/tests/pipeline/southCarolinaFinance/southCarolinaEthicsClient.test.ts` (13 tests — bare-string filer body, filer-mismatch fail-closed, HTML fallback, numeric-year body, blank-occupation nulling, group-flag validation, unfiltered-search refusal, HTTP/network error wrapping). Live smoke passed: all four endpoints parsed real payloads; Wilson filtered search rows (candidateId 54344, run 77574) summed to 485,932,827 cents == report income Total, cent-exact.

No PDF, no DOM scraping, no browser tier, no AI anywhere in this module.

## Phase 2: eligibility and candidate resolution

Add `southCarolinaFinanceEligibleOffices.ts` and `southCarolinaCandidateFilerResolver.ts`.

Eligibility (v1): state `SC`; office scope statewide or SC Senate / SC House district; election in VoteApp's November 2026 coverage.

Link identity is **`candidateFilerId` only**, mapped onto the shared link columns (`committee_id` := filer id as text, `committee_name` := filer display name). Do not persist `officeRunId`: runs are per election event, change as the cycle progresses (Alan Wilson currently has only the primary run 77574 while VoteApp targets 2026-11-03), and the shared schema has no column for them. Each sync rediscovers accepted runs from the filer's report index: reports whose `electionDate` falls in the linked election's cycle (primary/runoff/general dates for that office) group into runs by distinct `electionDate`.

Resolver rules:

- Filer-name search by roster surname; locally require exact normalized surname, then confirm on election evidence (a report set whose election dates match the cycle) plus roster office. For current-cycle statewide runs office text is broken (`"4"`), so office confirmation uses roster office + election-date evidence, never the office string.
- Legal-name divergence (Alan Wilson files as `Wilson, Michael A`, filer 54344): if surnames match but first names differ, require a manual-confirm link with the evidence URL stored; never auto-link on surname alone.
- Exactly one unambiguous filer per candidate/election, or no link. Stored links become trusted identities on later syncs.

## Phase 3: direct aggregation

Add `southCarolinaDirectContributionAggregator.ts`. All arithmetic in integer cents.

Totals (authoritative, from report summaries):

- Per accepted run, select the newest filing period's newest version; read its income/expenditure election-cycle totals.
- `total_receipts` = sum over runs of income `Total`.
- `direct_contribution_total` = sum over runs of cash + in-kind + personal contributions (exclude loans, debt-setoff funds, account credits). The shared loader prefers `direct_contribution_total` for displayed "total raised", so loans never inflate it; `total_receipts` is retained for audit. No loans column in v1 (the shared `loans_received` opt-in is a separate follow-up if product wants it).
- `total_disbursements` = sum over runs of expenditure `Total` (already includes returned contributions and in-kind expenditures).
- `cash_on_hand` = `balance` of the latest report across runs.

Breakdowns (from `Contribution/Search` rows, filtered locally to the linked `candidateId` and accepted `officeRunId`s, over every calendar year touched by the matching reports — not hardcoded years):

- Occupations: individual rows only (`group:"No"`). Preserve the filed occupation verbatim, normalize through standard occupation labels, keep `Retired`, `Student`, `Homemaker`, `Self-employed`. Entity/PAC rows (`group:"Yes"`) never enter occupation totals and are never mapped to `Unknown` individuals.
- Size buckets from itemized amounts (these rows are cash + in-kind by construction; loans and credits never appear in them).
- Employer does not exist in this source: emit nothing (not `Unknown`). If S. 813 becomes law and the API grows an employer field, that is a schema-monitor event, not silent adoption. Never infer occupation or employer from outside sources.

Reconciliation policy (per run, against the authoritative summary):

- Itemized sum equals the summary contribution figure → full observed coverage.
- Itemized sum **below** the summary → lawful (unitemized ≤$100 aggregation is permitted): publish totals plus partial breakdowns with `direct_coverage_note` — "Occupation and contribution-size breakdowns use itemized contributions; filings may aggregate contributions of $100 or less."
- Itemized sum **above** the summary, duplicate `contributionId`s, malformed amounts, or incompatible periods → fail closed: keep the prior snapshot, record a diagnostic.

## Phase 4: schema, flags, writer

Standard five-table schema, next free migration number at implementation time:

- `sc_candidate_finance_links`, `sc_candidate_finance_summaries`, `sc_candidate_finance_direct_breakdowns`, `sc_candidate_finance_outside_groups`, `sc_candidate_finance_outside_group_breakdowns` (the outside tables exist for shared-loader uniformity; v1 writes no rows to them).
- Short `sc_cff_*` constraint names; identifiers ≤ 63 chars.

`southCarolinaFinanceWriter.ts` wraps the shared snapshot writer with:

```ts
summaryUpdatePolicy: {
  outside_support_total: "replace",
  outside_oppose_total: "replace",
}
```

because the shared writer's default is `preserveWhenNull` (COALESCE) and a null would otherwise never clear a previously written value. Pass empty outside-group arrays so stale rows clear.

Presence semantics — four states, not two:

- Source unavailable / request error → preserve the full prior snapshot.
- Filer resolves but has **no filing yet** for the cycle → preserve/absent; never manufacture zero (absence before a deadline is not an authoritative zero).
- Filer **filed** and the reports show zero qualifying activity → write zero direct totals and clear direct breakdown rows.
- Filed data → replace the snapshot transactionally.

Flags — split repo contract from operator rollout (this worktree has no `backend/.env`; `.env` is local-only and not a PR artifact):

- PR: `SOUTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED` and `SOUTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED` default `false` in `backend/src/config/featureFlags.ts`; both listed in `backend/.env.example`; read flag in `render.yaml` for prod.
- Rollout (main checkout, per the standing feature-flag policy — both flags are free, no AI involved): set both `true` in the operator's `backend/.env`; prod read flag goes live with the deploy after the migration; prod sync scheduling follows the standard prod checklist.

## Phase 5: sync, auto-link, batch, scheduler, scripts

- `southCarolinaCandidateFinanceSync.ts`, `southCarolinaCandidateFinanceAutoLink.ts`, `southCarolinaCandidateFinanceBatchSync.ts` on the Missouri/New Hampshire shape: find missing eligible candidate/elections → auto-link safe filers → shared due-list query gates work → fetch/cache → aggregate → one snapshot write per candidate.
- Cadence: the standard link-gated due mechanics (scheduler runs daily; a link syncs only when due). Per-link freshness aligned to the filing calendar's granularity — quarterly reports land Jan/Apr/Jul/Oct 10 and pre-election 15 days out, so a due link costs three or four small JSON calls; there is no daily full-pull of anything. Election day + grace, `--force` for backfill.
- BullMQ scheduler + scripts mirroring the existing pattern: `syncDueSouthCarolinaCandidateFinance.ts`, `triggerSouthCarolinaCandidateFinanceSync.ts`, scheduler upsert + worker (concurrency 1), `probeSouthCarolinaCandidateFinance.ts`.

## Phase 6: ballot-loader integration, labels, tests

- Add `SOUTH_CAROLINA_CAMPAIGN_FINANCE` to the source TS union **and** `FINANCE_SUMMARY_SOURCES` in `backend/src/pipeline/address/ballotLookupFinanceShared.ts`; register through the standard-table loader with the flag, eligibility predicate, `sc_*` table names, and fallback source URL `https://ethicsfiling.sc.gov/public`.
- Declare `SOUTH_CAROLINA_DIRECT_COVERAGE_NOTE` (exported by the aggregator) as the loader's static `directCoverageNote` — the standard family persists no per-candidate note, so the source-wide static note is the display path (Missouri/New Hampshire pattern); the aggregator's conditional per-candidate note is a Phase 5 sync diagnostic only.
- API-client label: `SOUTH_CAROLINA_CAMPAIGN_FINANCE`: `South Carolina State Ethics Commission` in `packages/api-client/src/format.ts` (alphabetical) plus the `financeSourceLabel` test in `format.test.ts`.
- Existing web/mobile finance cards need no SC-specific component; verify null outside totals render as absent, not $0.

Tests (compact sanitized fixtures from real responses):

- Client: HTML-fallback rejection; bare-string filer-search body; numeric year + candidate-text contract; refusal to search without a recognized server filter (an unsupported `candidateId`-only body must be rejected locally, not sent).
- Resolver: fuzzy filer results filtered to exact surname; `officeName:"4"` statewide confirmation path; Wilson legal-name manual-confirm; ambiguity → no link.
- Run grouping: primary/general cycle reset (McMaster-shaped fixture); combined `Quarter 3 & Pre-Election (General)` and `Quarter 4 & Final` parsing; runoff run inclusion.
- Ordering: a late amendment to an older period never outranks a newer period (Evette Jul-10/Jul-14 shape); newest-version selection (399-row original vs 356-row Amendment 4, equal totals).
- Aggregator: search rows filtered by `candidateId` + accepted runs; group-row exclusion; occupation normalization and status preservation; bucket edges; lawful unitemized gap publishes partial breakdowns + coverage note; itemized-over-summary, duplicate-id, malformed-amount → fail closed; integer-cent arithmetic.
- Writer: four presence states (`unavailable` / `no filing yet` / `filed zero` / `filed data`); outside nulls use the `replace` policy and clear via empty arrays.
- Fixtures contain no contributor street addresses.
- Loader isolation: SC rows only for SC-eligible candidates; other states untouched. Flag and scheduler enable/disable behavior.

Validation gates before merge:

- Backend typecheck, focused SC tests, full backend suite, empty-database migration run, api-client tests.
- Live smoke, cent-exact: Alan Wilson governor (filer 54344): search-row sum for accepted runs equals the summed income Totals at probe time (cash + in-kind identity). Pamela Evette governor (filer 54395): current pre-election version totals cash $402,015.21 / cycle $3,497,154.30 / ending $552,415.77 (row count asserted against the pinned version id, since amendments consolidate rows).
- Live smoke on one SC House and one SC Senate 2026 candidate, one below-$500 filer, one amended report, one candidate with a general run once general filings exist.
- Real database-backed election-detail and per-candidate finance API calls.

## Deferred work (explicitly out of v1)

1. **Outside spending** — blocked on an official Ethics Commission extract carrying expenditure classification + candidate target/beneficiary (+ stance if collected). Beneficiary-without-stance would ship as a separate reviewed benefit-only phase; opposition stays null. Behind `SOUTH_CAROLINA_CAMPAIGN_FINANCE_OUTSIDE_SPENDING_ENABLED`, default off.
2. **Committee staging** — legacy-portal harvester into raw staging for future funder analysis. The § 8-13-1300(7)/(31)(c) 45-day separate-account rule means committee receipts can understate election-period communication funding; any future funder output carries `outsideFundingCoverage: partial`.
3. **Loans surfacing** — the shared loader supports an opt-in `loans_received` column; add only if product asks (Evette carries $1M in personal loans that v1 deliberately keeps out of "raised").
4. **Local offices** — widen eligibility to county/municipal/probate-judge filers once office/district matching is validated.
5. **Historical cycles** — the constitutional-officer archive (`ssl.sc.gov/Ethics`) is currently down; inventory completeness per cycle before publishing history.
6. **S. 813 monitor** — occupation + employer bill, in Senate Judiciary as of 2026-08; portal schema change triggers review, never silent adoption.
