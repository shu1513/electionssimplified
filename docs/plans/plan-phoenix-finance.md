# Phoenix City Campaign Finance Plan

## Finance-gap continuation — 2026-10-12

The refreshed source/code audit and ranked work order are recorded in `~/.claude/tmp/voteapp-finance-gaps-2026-10/phoenix-finance-gap-source-code-audit-2026-10-12.md`, `phoenix-finance-gap-next-step-2026-10-12.md`, and `plan.md`. The local cohort has 16 active linked council candidates across four November 3 contests; stored summaries date from August 13. City Schedule B(6) acquisition already runs through the normal batch context. Standing-PAC state filings, noncommittee IE, and expenditure-funded communications remain separate acquisition gaps; an unavailable channel must not establish zero outside spending.

The first increment adds a pure parser for literal monetary PAC contributions (A1e) and returned contributions (A1l), checking receiving COPID, physical row multiplicity, civil dates, safe integer cents, schedule pagination and cash controls. It does not infer the donor class of a return, combine donor aliases, select current amendments, or publish money. Batch results retain the candidate sync diagnostics so a real normal CLI run can be assessed. The unchanged District 4 CLI dry-run completed 8/8 candidates; its shared context discovered 15 city-filing IE PACs, 13 standing IE PACs and four B(6) packages. Those counts do not prove exhaustive outside coverage or new eligible spending.

Fresh opening and closing Hermes grids contain 710 contribution rows, 111 expenditure rows and zero loans; both report PDFs were fetched in both phases and are byte-identical. Annual 2026 covers April 1, 2025–March 31, 2026; Q1 covers April 1–June 30, 2026. The Q1 PDF reports three PAC cash gifts totaling $19,500 and a separate $1,000 return. Row `SubmittedDate` varies within each package and must not select filing editions. Current publication authority, complete cycle coverage, return ownership and native-channel acquisition must be qualified before adding storage. A real local write, production reader and actual candidate card remain required before opening the Phoenix PR.

### Local implementation proof — 2026-10-12

Named cash acquisition runs in the ordinary sync behind the separate, default-off `PHOENIX_COMMITTEE_CASH_SYNC_ENABLED` gate. Pass `AI_API_CALLS_ALLOWED=false`, `PHOENIX_CAMPAIGN_FINANCE_ENABLED=true`, `PHOENIX_CAMPAIGN_FINANCE_SYNC_ENABLED=true` and the new donor gate inline; never write them to `.env`. Migration 341 adds independent source pointers and retained donor generations. Failed optional qualification preserves prior donor generations and does not block acquired city IE. Omitted outside groups preserve stored payers; successful partial city observations upsert known groups, and the production reader keeps overall outside totals unknown while displaying known groups.

The normal local District 4 command completed eight candidates with zero failures, October 13, 2026, 00:58:40.962–01:01:29.358 UTC. Actual public-response capture retained 261 HTTP 200 responses, 23,742,320 bytes, with original bodies, request scopes, SHA256 and execution timestamps in a private generation. Two committee cash components qualified and six were held: one had no complete published report set, five had cycle-control discrepancies. No held component was cleared or made current.

The production reader returned Hermes's six reported-name PAC positions/six gifts/$32,250 net through June 30 under “Not yet sorted.” The separate $1,000 returned contribution matched only a source-typed individual schedule. Reported-name groups do not assert registered legal identity or merge different annual/quarterly spellings. One annual individual row had a date one day outside its printed cover period; its source schedule membership remains class evidence, with no effect on PAC amounts. Named PAC and return dates remain period-bounded. Raised remained $316,139.10; overall outside totals are unknown. The actual frontend `FinanceSummaryCard` rendered from that DTO; eight unrelated local contexts retained identical summary, direct-detail and outside-detail hashes.

Proof files live under `~/.claude/tmp/voteapp-finance-gaps-2026-10/`: `phoenix-district4-real-normal-sync.log`, `phoenix-real-reader-proof.json`, `phoenix-hermes-real-card.html`, and private `phoenix-normal-source-capture-057870a7-e929-4655-94ea-dd7ef6666a04/`. The October 12 outside audit found 31 standing-PAC discovery occurrences without verified current candidate allocations; the EFD publication list still ends in November 2024, and no noncommittee inventory was discovered. These channels remain incomplete.

### Fresh reruns after filing deadlines

The [official city candidate calendar](https://www.phoenix.gov/content/dam/phoenix/cityclerksite/documents/campaign-finance/Campaign_Finance_Reporting_Schedule_2026%20CANs_EVEN.pdf) and [city PAC calendar](https://www.phoenix.gov/content/dam/phoenix/cityclerksite/documents/campaign-finance/Campaign_Finance_Reporting_Schedule_2026_PACs_.pdf) distinguish these reporting roles:

- Candidate and city PAC quarterly reports: October 15, through September 30; acquire fresh October 16 and retry October 19.
- City PAC and SOS standing pre-election reports: October 19, through October 17; acquire fresh October 20 and retry October 22. The [SOS standing calendar](https://azsos.gov/elections/campaign-finance/campaign-finance-reporting-dates) separately confirms standing quarterly October 15 through September 30 and year-end January 15 through December 31; use the same post-deadline acquisition/retry dates for those periods.
- Candidate first-election reports: November 18, through November 3; acquire fresh November 19 and retry November 23.
- Candidate/city PAC year-end reports: January 15, 2027; acquire fresh January 16 and retry January 19, after reviewing the new window/status.
- Check amendments and applicable IE/EFD filings during October 18–November 5. Standing PACs follow the separately verified Arizona SOS calendar, not the city candidate calendar.

The city calls November 3 its first election and March 9, 2027 its second election; preserve that terminology separately from local election labels. A fresh fetch timestamp does not advance the publisher's reporting date. No scheduled automation is created by this plan.

Written 2026-08-12 after live probing of the City of Phoenix Campaign Finance eFiling system (search grids exercised in a real browser, JSON responses captured, a 2026 candidate report PDF downloaded and text-extracted, codebase and local DB audited). Revised the same day after an external review round; every correction below was re-verified against live data or code before adoption. Verdict: **GO — Phase 0 first.** Schema and any published numbers wait until the Phase 0 gates reconcile to the cent.

The standard new-module launch checklist is inlined in full under "Flags & labels" below — this plan is self-contained; no external checklist is required.

## Why a new module (not an extension)

`backend/src/pipeline/arizonaFinance/` covers only state filings from `seethemoney.az.gov` — `arizonaFinanceEligibleOffices.ts` has zero `place::` keys, and Phoenix city candidate committees file with the Phoenix City Clerk, not the Secretary of State. `plan-seattle-finance.md` already classified Phoenix as Tier C (own filing regime → own module, like SF/LA/Houston). Structural template is `sanJoseFinance/` — but the transport layer is genuinely new: Phoenix is not CAL 2.20, not efile.systems, not NetFile.

**Arizona-state module is still relevant to the outside leg**: committees registered with the Secretary of State as *Standing PACs* appear in the Phoenix portal's registration search (blue bold-faced names) but "are required to file campaign finance reports only with the secretary of state" (stated on the portal's RegFilings page, verified 2026-08-12). Their Phoenix IE detail therefore lives in Spotlight, not the Phoenix portal — see Outside spending.

## Verified source (probed live 2026-08-12)

City of Phoenix Online Campaign Finance, `https://apps-secure.phoenix.gov/CampaignFinance` — filings since 2013-01-01, public, no login. COP ID prefixes: `CAN-*` candidate committees, `PAC-*`, legacy `IE-*` / `MC-*`. **E-filing is mandatory for committees** ("ALL campaign finance related filings must be made by using the City of Phoenix Campaign Finance eFiling system" — city rules page): no paper gap for committee reports. Non-committee IE entities and dark-money filers use separate channels (see Outside spending).

Two data surfaces, both verified live:

1. **Kendo grid JSON endpoints** (return `{Data: [...], Total: n}`, pageable; observed as POSTs in-browser):
   - `/CampaignFinance/Search/_SearchCommittees` — registration filings: `COPID`, `CommitteeId` (GUID), `CommitteeName`, `CommitteeType`, `ElectionCycle` (+ cycle GUID), `RegType`/`ReportType` (Statement of Organization vs Termination), `Approved`, `Amendment`, `Terminated`, `CandidateName`, chairman/treasurer, political functions incl. `PAC_CANDIDATE_IE`, `IsStandingCommittee`, and the registration PDF ids.
     **Rows are document versions, not committees** (verified: "Ed Hermes" returns 3 rows across two committees). Canonicalize by `CommitteeId`/`COPID` + latest `Approved` timestamp + `Terminated` status, and exclude the test records that live in production data (e.g. "2021 New City of Phoenix Test Committee", `PAC-21-15`).
     **`CandidateOfficeSought` and `CandidateRunningDistrict` are null on live rows** (verified on `CAN-25-4`) — only `CandidateName` + `OfficeSoughtElectionCycle` are populated. **A candidate gets a new COP ID each cycle** (Hermes: `CAN-23-7` then `CAN-25-4`); never interpret COP-ID digits as a district.
   - `/CampaignFinance/Search/_SearchContributors` — per-transaction rows: `OrgName`, `COPID`, `ContributorName`, `Amount`, `ContributionDate`, `ReportName`, `ScheduleKey` (`A1A`, `A1C`, …), `ReportingPeriodTotal`, and `ReportPackageId` — the GUID of the filed report. **No occupation/employer, no stable transaction id.**
   - `/CampaignFinance/Search/_SearchExpenditures` and `/CampaignFinance/Search/_SearchLoans` — same pattern (columns verified on-page; JSON shape assumed symmetric — probe confirms).
   Because grid rows carry no stable transaction ids, each canonical report package is treated as a **replaceable snapshot** (keyed by `ReportPackageId`); never dedupe same-day/same-amount donations globally.
2. **Report PDFs** — `/CampaignFinance/Reports/PrintReport/<ReportPackageId>`. Machine-generated, text-extractable (verified with pypdf on Ed Hermes for Phoenix, `CAN-25-4`, Q1 2026, 56 pages). These are the authoritative numbers; grids are discovery + cross-check.

Fetch hygiene: the WAF serves a fake "maintenance" HTML page (HTTP 200) to default curl UAs — send a browser User-Agent (verified working for PDFs). Validate every response before parsing: content type + JSON schema for grids, `%PDF` signature for reports, UUID shape for ids; treat the maintenance page as a fetch failure, never as empty data. Allowlist exactly `apps-secure.phoenix.gov` (plus `www.phoenix.gov` for the clerk roster/reference PDFs), HTTPS only, size caps, artifact cache with checksum + fetch timestamp.

**PII policy**: registration JSON carries emails/phones/addresses and even bank-name fields; schedules carry donor street addresses. Raw artifacts are cached outside the repo, fixtures are sanitized before commit, contributor street addresses are parsed but never persisted, and raw payloads/PDFs are never logged.

## Report accounting model (verified on the Hermes Q1 2026 filing)

Cover FINANCIAL SUMMARY: `(a)` beginning balance `+ (b)` total receipts `− (c)` total disbursements `= (d)` closing balance. **Cycle-to-date figures exist only for (b) and (c)**; (a)/(d) are period-only. Verified: (b) = $72,621.00 period / $316,139.10 cycle.

Summary of Receipts (Schedule A), cash and equity columns:

```
Σ 1(a)…1(j)  = 1(k) monetary contributions subtotal      ($73,621.00)
1(k) − 1(l) refunds = 1(m) net monetary contributions     ($72,621.00)
1(m) + loans 2(e) + other receipts (3, 4, 8-9, 11-12) = line 13 total receipts (cash)
line 13 cash = cover (b)                                  (verified exact)
in-kind lives in the equity column (5(a)-(k) …)           ($4,805.29 equity line 13)
```

Summary of Disbursements (Schedule B): line 16 cash = cover (c). Line 6 = "Independent Expenditures Made".

Field mapping (the shared summary already carries both totals):
- `direct_contribution_total` = Schedule A line 1(m) (net monetary contributions).
- `total_receipts` = line 13 cash. `total_disbursements` = Schedule B line 16 cash. `cash_on_hand` = cover (d).
- Loans disclosed via Schedule A section 2 (grid `_SearchLoans` as cross-check).

Amendments: reports amend. The registration `Amendment` flag says nothing about report amendments — Phase 0 pins report-amendment semantics on a real amended modern report (report package id, reporting period, submission timestamp), one canonical report per period; never rely on "[AMENDMENT]" title text alone.

**Election cycle is Phoenix's own, not a calendar year**: current candidate cycle runs 2025-04-01 through 2027-03-31 (city cycles PDF, verified); election Nov 3 2026 with a possible Mar 9 2027 runoff. Store the portal cycle identity + date bounds on the link/summary rows separately from VoteApp `election_year`; cycle totals are NOT clipped to the November date (same documented decision as San José).

## Requirement mapping

| Requirement | Source | Status |
|---|---|---|
| Total raised / spent / cash | Cover (b)/(c) cycle-to-date + line 13/16 arithmetic, latest canonical report (Georgia lesson: covers authoritative) | Verified live |
| Top donor occupations/employers | PDF Schedule A(1)(a) + A(1)(c) itemized rows | Verified live (both schedules carry Occupation + Employer) |
| Outside support/oppose | Multi-channel — see below | Partially verified; Phase 0 census |

Occupation semantics (verified): **A(1)(a)'s "more than $100" is a cumulative-per-cycle threshold, not a transaction floor** (it contains $25 rows); A(1)(c) covers out-of-state individuals at every amount, also with occupation/employer; A(1)(b) is a single unitemized aggregate for in-state ≤$100 donors. Coverage note: occupations/employers cover in-state individuals whose cycle total exceeds $100 plus all out-of-state individuals; exclude the A(1)(b) aggregate and non-individual contributors.

**`contribution_size_buckets` is omitted in v1**: A(1)(b) exposes only one aggregate, so exact buckets cannot be reconstructed — do not publish knowingly partial buckets as complete.

## Outside spending (multi-channel by design)

`PAC_CANDIDATE_IE` in a registration is an *authorization*, not evidence of IE activity, and Phoenix candidate-targeted outside money legally flows through four channels:

1. **Phoenix-registered PACs** — reports in the portal; itemized IE detail expected on the report's IE schedule (disbursement line 6 is verified; the itemization schedule's candidate + support/oppose format is a Phase 0 gate).
2. **Standing PACs (SOS-registered)** — registration visible in the portal, but finance reports filed *only* with the AZ Secretary of State → detail lives in Spotlight (`arizonaSpotlightClient.ts` already exists; probe checks whether its filings expose city-race IE targets).
3. **Non-committee IE entities** (A.R.S. §16-901(31)) — file fillable IE report forms by email/mail/in-person with the Clerk (city rules page, verified). Likely scanned PDFs, low volume → curated-supplements path (PR #661 mechanism), never OCR.
4. **Election Funding Disclosure ("dark money" ordinance)** — any non-committee spender at $1,000+/cycle files an EFD report (48-hour report at $10,000+ within 16 days of the election); the Clerk publishes a "List of Dark Money Reports Filed". Same curated-supplements treatment.

Phase 0 runs a census across all four channels for the current cycle. v1 implements channel 1 systematically; channels 2–4 become systematic legs only if the census shows recurring volume, otherwise curated supplements. **Publishing rule: outside totals are written only for channels actually measured; unmeasured channels make the totals partial — disclose via `outside_coverage_note`, and write NULL (no row), never zero, when nothing was measured.**

## Prerequisites

1. **Rosters.** Local DB has the four elections — "Phoenix City Council, District 2/4/6/8", 2026-11-03, on the place row (`Phoenix city, Arizona`, GEOID `0455000`) — with **all four rosters empty**. The Clerk's certified candidate list is live (verified 2026-08-12): **16 certified candidates** — D2 Evans/Mazza/Read, D4 Harder/Hermes/Hernandez/Jimenez/Lauer/Mazzocco/Olivieri/Schmitz, D6 Del Prete/Robinson, D8 Abasciano Jr./Hodge Washington/Maupin Jr. Roster research via the `voteapp-manual-research` skill can run immediately.
2. **Office scope.** `place::City Council Member` now; `place::Mayor` dormant until the next mayoral cycle. No new office modeling needed.

## Architecture

New module `backend/src/pipeline/phoenixFinance/`, tables prefixed `phx_` (no collisions). **Four tables, matching the shipped San José shape (migration 233)**: `phx_candidate_finance_{links,summaries,direct_breakdowns,outside_groups}` — no `outside_group_breakdowns` table. Outside-group *funder* backtrace (who funded each spender PAC → `top_supporting_industries`/`top_opposing_industries`) is **out of scope for v1**, exactly as San José shipped it: the SJ loader returns those arrays empty by design (`sanJoseBallotLookupFinanceLoader.ts:256`), and Phoenix funder backtrace would mean parsing each spender's own report PDFs — a full extra leg. The Phase 0 outside census records, per spender, whether its funding sources are visible in the portal, so a later funder leg is a data-informed follow-up, not a v1 gate. Migration takes the next free number at build time (never renumber).

**Writer/loader/due-list: SJ-pattern bespoke, not the shared factories as-is.** Audited 2026-08-12:
- the factory writer's direct categories are `occupation | contribution_size` only (no employer), and it lacks manual-link protection — `upsertLink` overwrites `link_source` on conflict (`standardStateFinanceSnapshotWriter.ts:392`; capability matrix line 17 lists manual protection as "still missing");
- the shared loader hard-codes direct `top_employers: []` (`standardStateFinanceBallotLookupLoader.ts:661`);
- the shared due-list query scopes by `districts.state` + office key only (`standardStateFinanceDueListQuery.ts:166,171`) — in AZ that would sweep every city's `place::City Council Member`, so Phoenix scoping must pin GEOID `0455000`.

So: copy-adapt `sanJoseFinanceWriter.ts` (manual-link protection at `sanJoseFinanceWriter.ts:120-143`; direct categories include `employer` at `:59`), `sanJoseBallotLookupFinanceLoader.ts` (routes employer breakdowns at `:242`), and SJ's GEOID-scoped selection queries — auto-link `sanJoseCandidateFinanceAutoLink.ts:46` and the due query embedded in `sanJoseCandidateFinanceBatchSync.ts:30,226` (SJ has no standalone due-list module) — to `phx_` tables. Do NOT extend the shared factories for this — per the capability-matrix policy, factory features are added only when a migrating cohort needs them. Outside-group writes keep SJ's actual semantics: per-snapshot delete + plain inserts of pre-grouped (spender identity, direction) rows, where a unique-key collision is a caller bug that aborts the snapshot (`sanJoseFinanceWriter.ts:235-256`).

Reuse as-is: shared name gates (`personNameMiddleEvidence`, `personFirstNameNicknames`, suffix veto), `financeLabelClassifier` + industry classification, `BallotLookupFinanceSummary` contract (top_occupations/top_employers, outside support/oppose, coverage notes — no frontend changes expected).

Copy-adapt from `sanJoseFinance/` beyond the writer/loader: aggregator violation taxonomy (cover arithmetic, period gap/overlap, duplicate-period, cash chain (a)=prior (d)), sync quarantine + SF anomaly gates, batchSync/scripts skeletons, paper-filing supplements mechanism (repurposed for IE-entity/EFD filings).

Genuinely new (Phase 0/1 work):
- `phoenixEfilingClient.ts` — grid replay + PDF fetch, response validation (maintenance-page rejection), artifact cache.
- `phoenixReportPdfParser.ts` — cover + Schedule A/B summaries + A(1)(a)/A(1)(c) itemization + IE schedule. **Use the Houston precedent's positioned-text approach**: `pdfjs-dist` (already a backend dependency) `getTextContent()` with each item's `transform[4]/[5]` x/y grouped into lines and x-ordered cells (`houstonCampaignFinancePdfParser.ts:51-52,69,79`). This matters — naive whole-page text extraction scrambles Phoenix's label/value order (observed in probing: labels and values interleave out of reading order), while x/y reconstruction recovers the form layout. Pin every schedule with fixtures.
- `phoenixCandidateCommitteeResolver.ts` — evidence order: (1) Clerk certified roster (candidate identity + district), (2) registration `CandidateName` + exact portal cycle + COP ID (canonicalized committee), (3) report-cover "Office Sought" ("Council Member District 4" is machine-readable on the cover, verified) as office/district confirmation, (4) shared name gates; fail closed when a committee has no report and evidence is name-only.

## Phases (small; single-source module)

- **Phase 0 — probe (no schema, no writes, no publication).** `backend/src/scripts/probePhoenixCandidateFinance.ts` + npm script. Hard gates:
  1. Headless replay of the four grid endpoints — capture the exact method, Kendo paging/sort parameter names, and any cookie/token requirements; correct `Total`, complete pagination; response validation rejects the maintenance page.
  2. Canonical registration index: committee-version rows collapse to one committee per `CommitteeId`/`COPID` with correct terminated/test-record exclusion (fixtures: Hermes `CAN-23-7` vs `CAN-25-4`; `PAC-21-15` test committee excluded).
  3. Cover + Schedule A/B parse: the full equation chain (1(k)→1(m)→13→(b); 16→(c); (a)+(b)−(c)=(d)) reproduced to the cent for ≥3 committees, including at least one with loans, refunds, or non-contribution receipts; period chain continuity ((a) = prior (d); cycle-to-date (b)/(c) = Σ canonical periods) — deviations become typed violations.
  4. Report-amendment canonicalization pinned on a real amended modern report: one canonical report per period.
  5. Occupation/employer extraction from A(1)(a) + A(1)(c) for ≥2 committees; itemized + A(1)(b) aggregate reconcile to the cover receipts lines to the cent.
  6. Outside census across all four channels for the 2025–27 cycle: portal PACs with actual IE filings (pin the IE schedule's candidate + support/oppose format on ≥1 real filing, falling back to the most recent prior cycle if this one is empty), standing-PAC detection (`IsStandingCommittee`) + whether Spotlight exposes their city-race IE detail, the IE-entity report list, and the EFD dark-money list. Output: per-channel volume + the v1 systematic-vs-curated decision + the null-vs-zero publishing matrix + per-spender note on whether its funding sources are visible in the portal (informs the deferred funder-backtrace leg, not a v1 gate).
  7. Resolver dry-run: all 16 certified candidates map to canonical committees via the evidence chain, or carry an explicit unresolved reason.
- **Phase 1 — schema + writer.** Four `phx_` tables (SJ shape); SJ-pattern bespoke writer (manual-link protection, employer category, portal-cycle columns); writer tests including manual-protection and employer-routing cases.
- **Phase 2 — resolver + links.** Evidence-chain resolver, auto-link scoped to GEOID `0455000`, manual-link protection end-to-end.
- **Phase 3 — aggregators + sync.** Direct (cover-based totals + A(1)(a)/A(1)(c) breakdowns, no size buckets), outside per the Phase 0 channel decision, coverage notes, sync + due list (GEOID-scoped), flags, source enum, ballot-lookup loader registry entry.
- **Phase 4 — live run + UI check.** Full-cycle ingest locally for all 16 candidates; PDF-reconciliation sweep (every written summary cent-exact vs live report covers); IE-entity/EFD sweep with curated supplements for real misses; FinanceSummaryCard renders raised/spent/cash/occupations/outside S-O — **employers are stored and API-exposed but deliberately not rendered by the card** (repo-wide product decision, test-enforced at `FinanceSummaryCard.test.tsx:26`; no frontend change in this plan). Prod scheduling stays manual-trigger (render.yaml finance crons still commented out pending Render billing — repo-wide state).

## Flags & labels (checklist items, do not skip)

- `PHOENIX_CAMPAIGN_FINANCE_ENABLED` + `PHOENIX_CAMPAIGN_FINANCE_SYNC_ENABLED` (+ `PHOENIX_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED` if the artifact-refresh split is kept): code defaults `false` in `featureFlags.ts`; set `true` in `backend/.env` (alphabetical); add to `backend/.env.example`; read flag added to `render.yaml`.
- Source enum `PHOENIX_CITY_CLERK` in `ballotLookupFinanceShared.ts` (union + `FINANCE_SUMMARY_SOURCES`); display label "City of Phoenix City Clerk Department" in `FINANCE_SOURCE_LABELS` (`packages/api-client/src/format.ts`, alphabetical) + `format.test.ts` case.
- Capability-matrix row (`docs/finance-module-capability-matrix.md`) cited in every PR.

## Out of scope (v1)

- Pre-2017 legacy report format; pre-2024 elections; the pre-2013 / Nov-2016–May-2017 records gap (separate archive system).
- Ballot-measure and recall committees; the "Notice of Large Contribution"/10K notification feeds (useful later for freshness, not load-bearing).
- `contribution_size_buckets` (A(1)(b) aggregate makes exact buckets impossible — see above).
- Outside-group funder backtrace (`top_supporting_industries`/`top_opposing_industries` stay empty, as in shipped San José) — revisit with the Phase 0 census's funder-visibility notes if the outside legs prove material.
- OCR of scanned IE-entity/EFD filings (curated supplements only).
