# San Francisco Local Campaign Finance Plan

## October 12, 2026 finance-gap continuation

The current canonical November3 General cohort has33 eligible candidates;
13 are linked, all with financial scope throughJune30 and August9 observations.
No stored outside groups or named committee donors exist for those links.
Outside acquisition is already wired to the official dashboard manifest.

A fresh normal District8 dry-run refused all four linked candidates because
summary max(data_as_of)=October7 differed from transactions October11. Official
DataSF metadata defines these as dates individual records were added to source,
with data_loaded_at describing their upload to the portal; they are not a
contracted shared refresh generation. The first correction removes only that
unsupported cross-dataset comparison. Missing/unparseable metadata, seven-day
upload-age, current Form460 coverage, sync flags and anomaly guards remain.
The next normal dry-run then reached a separate HTTP428 source failure. No
financial data has been written or accepted from that failed acquisition.

The subsequent controlled transport probe completed the same six source
requests with fresh connections. Adding `Connection: close` to the existing
client then passed the ordinary four-candidate District8 dry-run: four
successes, zero failures, two candidates with outside groups, through
September19. Batch results now retain the financial diagnostics instead of
discarding them. Three candidates initially reconciled to the cent; the fourth
had a $255,000 residual because approvals use Manny while the manifest uses
Emanuel Yekutiel. The official account publication binds the exact FPPC ID,
filer ID, election, candidate and committee to $522,957.99 contributions and
$255,000 public funds. A narrow fallback requires those identities, raw
contribution reconciliation, matching expenditures and the manifest's funds
identity; unavailable or mismatched publication preserves the prior snapshot.
No nickname match is inferred. HTTP428 still fails acquisition and preserves stored money;
this transport observation does not establish an upstream root cause.

Named committee cash requires nonmemoA and verified unpaired monetaryF497,
signedA returns and separately associated later ScheduleE/RFD refunds. C is
nonmonetary. COM means recipientcommittee and includes candidate campaigns;
SCC identifies smallcontributorcommittees, PTY party, OTH other entities.
Reported donor IDs can conflict with names, and terminated registry status
does not invalidate earlier gifts. Do not infer narrow PAC/legal identity or
promote businesses from a name, missing registry match or bad reported ID.
Source/return ownership and current occurrence multiplicity need proof before
the optional donor store/card increment. Known candidate/leadership interests
retain the shared display exclusions; true unknowns remain Not yet sorted.

The named-cash increment acquires the full receiving-account A/E/B1/F497
scope with strict source element, edition, receiving ID and exact money
decoding. Current Form460 authority and complete A/E itemized controls must
reconcile; fresh opening/closing context must match each other and the staged
core summary. Published report periods define the account scope, including
preparation before January1. Potential COM/SCC late occurrences without exact
independent association, ambiguous returns or changed editions omit the named
component and preserve stored positions while the independent IE path can
continue. Signed refunds remain stored until candidate-election netting.
Explicit campaign labels are excluded from the existing interest card; source
COM/SCC is disclosed as broad reported committee cash rather than legal PAC
status. Yekutiel's source witness is16 positions/$7,300, but campaign exclusions
leave8/$3,550, below the shared $5,000 display threshold. Do not force a panel.
Migration340 is append-only; no existing applied migration is changed.

### Real local validation, October12

The final ordinary CLI run freshly acquired the official sources and wrote
all four District8 contexts: four successes, zero failures and zero
reconciliation residuals, throughSeptember19. It persisted five outside
groups across two candidates and24 reported committee positions/$11,300.
Yekutiel: Raised$522,957.99, publicfunds$255,000, outside support$153,283.69,
oppose$59,495.84,16 committee positions/$7,300; campaign exclusions leave
$3,550 in the production DTO. McCoy: Raised$123,450, publicfunds$217,524,
outside support$288,568.77, oppose$23,010.83,8 positions/$4,000; exclusions
leave$3,000. The actual frontend FinanceSummaryCard renders both IE/public
funds cases and correctly omits their below-threshold committee panels.
Patel's named component remains unavailable for an unresolved possible
return; Nguyen's complete qualified component is empty. Neither is presented
as a fabricated named-donor success. All nine unrelated SF links/summaries
and389 direct detail rows have identical before/after hashes. This validates
District8, not the full eligible cohort or paper/late completeness.

307 focused SF tests and backend typecheck pass. Full frontend1223 tests,
frontend/mobile typecheck and lint, and98 worker tests pass. The full local
backend run passed15435 tests, skipped163, and failed24 tests in five mocked
suites because the DB URL was intentionally empty; those suites pass40/40
with a syntactically valid unreachable inline URL. The unchanged historical
import entrypoint also produced its known unhandled startup error. CI still
must pass before review; this increment does not deploy or merge.

The official candidate pre-election deadline is **October22**, covering
through **October17**: genuinely fresh **October23/26** reruns. Candidate third
pre-election filing **October30** covers through **October28**: fresh
**October31/November2**, after8amPacific to avoid the documented overnight
incomplete window. This third report is recommended for primarily formed
candidate committees rather than universally mandatory. Refresh actual
Form496/497/dashboard publication throughNovember5. The year-end deadline
is February1,2027: fresh February2/5 reconciliation, separately reviewing
post-election status/window eligibility. New fetch time is distinct from a new
publisher cutoff or version. Paper reports remain a separate coverage gap.
No automation or production action is introduced by this increment.

Written 2026-08-06; revised the same day after a second investigation round. Probed the San Francisco Ethics Commission (SFEC) datasets on DataSF, the official SFEC dashboard repository on GitHub, and audited the current campaign-finance architecture. The implementation must remain isolated, flag-gated, conservative about identity, and reuse the shared finance infrastructure (contract types, classification cache, standard-table loader pattern) instead of adding another large loader inside `ballotLookup.ts`.

The Los Angeles City adapter (`backend/src/pipeline/losAngelesCityFinance/`, migration `173`) is the closest structural blueprint. San Francisco's key difference: DataSF serves only raw filing data, but **SFEC publishes its reconciled dashboard data as machine-readable files in an official GitHub repository**, which this plan uses as the primary identity-and-totals source, with raw DataSF reconstruction as validator and fallback.

## Phase 0 status — COMPLETE (2026-08-06, branch `claude/sf-finance-phase-0`)

Implemented: `sanFranciscoDashboardManifestClient.ts` (0A), a lean `sanFranciscoOpenDataClient.ts` (0B oracle), and `probeSanFranciscoCandidateFinance.ts` (npm `san-francisco-candidates:finance:probe`), with parser/client unit tests. Live results across both canonical contests (10 mayoral + 5 D4 candidates):

- **Funds formula proven**: dashboard `funds` = Form 460 line-5 contributions (period prefix up to a cutoff filing) **+ public funds approved** (`dbak-p2fq`). Exact to the cent for 14 of 15 candidates (Breed's `$1,185,000`, Peskin's `$1,200,006`, Wong's `$252,000` public funds all reconcile exactly). Sole residual: Hirsch-Shell off by `$29.38` (immaterial; likely a returned-contribution edge).
- **Expenses are not raw-reproducible**: naive line-11 sums differ per candidate (`$0` for some, `+$51,338` Lurie, `+$102,896` Chow) — manifest stays authoritative for expenses.
- **Outside spending requires the manifest**: candidate-tagged F496 sums diverge from dashboard relations in both directions (Wong `$0` tagged vs `$744k` manifest; Breed `$3.19M` tagged vs `$2.69M` manifest), and Schedule D overlaps F496.
- **New source fact**: F496 transaction rows carry no `election_date` — contest bounding must use transaction-date windows.
- All four reference checks (Lurie funds/expenses, Wong funds/expenses/outside S/O) pass live.

**Decision: hybrid confirmed.** Manifest primary for identity, headline totals, and outside relations; DataSF for occupations/employers/buckets/balances/public funds; raw path retained as oracle via the probe.

**Explicitly NOT proven in Phase 0** (deferred to the Phase 4 entry gate, which must prove them before the direct-contribution aggregator ships): the itemized contributor formula (Sch A + C + 496 ≥$100 + 497P1 ≥$1,000), occupation/employer extraction, `entity_code` individual filtering, refund handling, F496/F497-vs-460 deduplication, memo/cross-reference rules, and outside-spender funding backtrace. Phase 0 validated headline totals and outside relations only. Also deferred to Phase 1: the rendered-site fetch fallback and manifest schema-version recording (the parser ships fail-loudly validation but no hash).

## Verified sources (probed live 2026-08-06)

### SFEC dashboard repository (primary for identity and headline totals)

`https://github.com/sfethics/dashboards-2025` is the source behind `https://campaign.sfethics.org` (the site is served directly from the repo via GitHub Pages; verified `server: GitHub.com`). It is updated daily by SFEC staff via automated "markdowns update" commits.

Per-contest files at `elections/<election-date>/contests/<contest>.md` contain YAML frontmatter with:

- `candidates[]`: `filer_nid`, `filer_id` (FPPC), `committee_name`, `candidate_name`, reconciled `funds`, `expenses` — exact dashboard numbers (verified: Lurie 2024 Mayor `10917642.52` / `10816112.85`; Wong June 2026 D4 `412371.0` / `410727.79`).
- `ie_candidates[]`: per candidate, each outside committee with `position` (`SUPPORT`/`OPPOSE`), `filer_id`, `committee_name`, and amounts (verified: Wong support committees sum to `744401.01` and oppose `24753.92`, matching the rendered dashboard to the cent).
- `contributors[]`: top contest contributors (informational; not needed for v1).

November 2026 contest files already exist: `asr` (Assessor-Recorder), `bos02/04/06/08/10`, `ccb` (Community College Board), `pdr` (Public Defender), `usd` (Board of Education).

Direction is per candidate-committee relation, not per committee: in `bos04.md` the GrowSF committee *supports* Wong while *opposing* Gee and Chow. Schema must model that.

Caveats (mitigations built into the plan): the repo is a publishing artifact, not a contracted API — no license/SLA, frontmatter schema can change, and the repo name is period-scoped (`dashboards-2025`) and will likely roll over for future cycles. Repo/branch must be configuration, parsing must be defensive and versioned, the GitHub contents API is the fetch fallback (Phase 1 finding: the rendered `campaign.sfethics.org` pages are Jekyll-built HTML and 404 the `.md` paths, so they can never feed the parser), and the raw-data path below stays alive as regression oracle. Elections before 2024-11-05 are not in this repo; deep historical backfill uses the raw path.

### DataSF datasets (breakdowns, balances, public funds, validation)

All on `https://data.sfgov.org` (Socrata/SODA), refreshed nightly; DataSF warns overnight processing can leave datasets temporarily incomplete, so syncs run after ~08:00 Pacific.

| Dataset | ID | Used for |
|---|---|---|
| Campaign Finance - Transactions | `pitq-e56w` | ~971k rows. Occupations, employers, size buckets, refunds: `transaction_occupation`, `transaction_employer`, `calculated_amount`, `entity_code`, `form_type`, `transaction_code`, `memo_code`, `cross_reference_match`/`_schedule`, `is_itemized`, `support_oppose_code`, candidate/office/election fields |
| Campaign Finance - Summary Totals | `9ggq-m8hp` | Form 460 summary lines per filing: cash, debt, loans (`line_*_col_a/b`, schedule totals), `sync_flag`, `data_as_of` |
| Campaign Finance - SF Campaign Filers | `4c8t-ngau` | Filer registry: `fppc_id`, `filer_nid`, `filer_type` (`Candidate or Officeholder` / `Primarily Formed Candidate` / `General Purpose`), `candidate_name`, `status` |
| Campaign Finance - Filings Received by SFEC | `qizs-bwft` | Filing index; freshness cross-checks |
| Campaign Finance - Public Funds Approved | `dbak-p2fq` | Public financing. **No committee id**: only `election_date`, `district`, `candidate`, `date_of_submission`, `date_certified_approved`, `pending_completed`, `funds_approved`. Mayor and Supervisor candidates only |

Source guarantees verified and relied upon:

- **Amendment supersession is upstream.** The published datasets contain only the current version of each filing (verified: max one row per `filing_nid` in summary totals across Lurie's nine filings, amendments included). Do not re-implement version selection; instead assert the guarantee (duplicate-`filing_nid` detection fails the sync loudly) and keep `filing_version` in diagnostics.
- **`calculated_amount` is the canonical amount column** on transactions ("most appropriate" amount per heterogeneous form type). Aggregators use it; `transaction_amount_1` is fetched for diagnostics only. All arithmetic in integer cents.
- **SFEC's documented contributor methodology** (from the dashboard pages): itemized contributions on Form 460 Schedules A and C, plus contributions reported on Form 496 (≥ $100) and Form 497 Part 1 (≥ $1,000) during the late reporting period. Returned contributions appear as negative Schedule A rows (same period) or Schedule E `RFD` rows (later period).

### Validated cross-checks already performed

- Summing Lurie's 460 `line_5_col_a` across filings reproduces the manifest `funds` figure exactly (`$10,917,642.52`); the naive `line_11_col_a` expense sum does *not* match the manifest expenses — reinforcing that headline totals come from the manifest, not raw sums.
- Candidate-tagged `F496` rows alone miss most outside money in small races (Wong: `$1,680` tagged vs `$744k` actual via primarily-formed and general-purpose committees) — reinforcing that outside-group relations come from the manifest.
- Schedule `D` rows duplicate `F496` activity (Lurie oppose: D `$2.89M` ≈ F496 `$2.99M`) — raw-path reconciliation must deduplicate; the manifest path avoids the problem entirely.

## Hard prerequisites (before the adapter can display anything)

1. **Candidate rosters.** Every November 2026 San Francisco election in the local database has zero linked candidates. Roster and profile work goes through the `voteapp-manual-research` skill. Can proceed in parallel with adapter phases.
2. **Office-scope modeling (Phase −1) — DONE (2026-08-07).** Confirmed against the office catalog (`seedOffices.ts` + local `offices` table), `electionsValidator.ts`, the local district rows, and the live SFEC repo contest listings (2024-11-05: `bos01/03/05/07/09/11, cat, ccb, dat, myr, shf, ttx, usd`; 2026-11-03: `asr, bos02/04/06/08/10, ccb, pdr, usd`):

   | SFEC contest | Ballot office | Scope::canonical office | Geoid |
   |---|---|---|---|
   | `myr` | Mayor | `place::Mayor` | 0667000 |
   | `cat` | City Attorney | `place::Municipal Attorney` (catalog alias "City Attorney") | 0667000 |
   | `ttx` | Treasurer | `place::City Treasurer` | 0667000 |
   | `dat` | District Attorney | `county::District Attorney` | 06075 |
   | `shf` | Sheriff | `county::Sheriff` | 06075 |
   | `bosNN` | Supervisor District N (1–11) | `county::County Supervisor` | 06075 |
   | `asr` | Assessor-Recorder | `county::County Assessor-Recorder` | 06075 |
   | `pdr` | Public Defender | `county::Public Defender` | 06075 |
   | `usd` | Board of Education (at-large) | `school_unified::School Board Member` | 0634410 |

   The validator's `cityLike` check forces mayor/city titles into `place` and its `countyLike` check forces sheriff/DA titles into `county`, so these pairs are the only ones it accepts. Local ballot titles read "Member, Board of Supervisors, District N"; the local Nov 2026 rows are exactly the manifest contests minus `ccb`, all with zero candidates.
3. **Community College Board decision (Phase −1) — DECIDED (2026-08-07): deferred out of v1.** `ElectionDistrictType` has no community-college type and no `Community College Board Member` canonical office exists; the local database correspondingly has no CCB election row. SFEC data stays ready (`ccb.md` in both cycles), so the follow-up remains: an election-model migration (new district type or deliberate scoped modeling) if CCB is ever brought in.

## Goal and v1 scope

San Francisco municipal candidate races: Mayor, Board of Supervisors, City Attorney, District Attorney, Sheriff, Treasurer, Assessor-Recorder, Public Defender, Board of Education. Community College Board is excluded from v1 (Phase −1 decision — no district type or canonical office; follow-up migration filed above).

Per candidate and election cycle:

- Total raised and spent — taken from the official manifest (reconciled), so they match `campaign.sfethics.org` exactly.
- Cash on hand, outstanding debt, loans received — from DataSF summary totals (latest filing's balance lines).
- Public funds received — from the public-funds dataset (Mayor/Supervisor candidates only).
- Top direct-donor occupations and employers (itemized, individuals only) and standard contribution-size buckets — from DataSF transactions using SFEC's documented contributor formula.
- Outside support/oppose totals and named groups — from the manifest's per-candidate `ie_candidates` relations.
- Industries via deterministic classification + previously cached manual classifications only. **No AI calls in finance sync** (matches current policy: due-sync scripts inject no classifier; unresolved high-value labels feed the existing manual industry-label due queue).

Out of scope for v1: ballot-measure committees, behested payments, DCCC races, Individual Expenditure Ceiling data, unitemized-donor analysis (no donor identity exists by law), and employer *display* (see Phase 8).

## Phase 0: dual-path validation gate

A standalone probe (`probeSanFranciscoCandidateFinance.ts`, kept afterward as a smoke test) proves both paths before any schema or runtime code:

**0A — manifest parser** (done). Typed, defensive parser for the contest frontmatter: unknown keys tolerated, missing/renamed known keys fail loudly. Validated against Lurie (2024 Mayor) and the June 2026 D4 contest: candidate totals, committee identities, per-relation outside amounts match the rendered dashboards to the cent. Rendered-site fetch fallback and schema-version recording were deferred to the Phase 1 client.

**0B — raw reconstruction as headline oracle** (done, deliberately narrower than first drafted). From DataSF, reproduce the dashboard funds figure (Form 460 line-5 prefix + public funds) and quantify how far candidate-tagged F496/Schedule D rows diverge from the manifest's outside relations. The itemized contributor formula (Sch A + C + 496 ≥$100 + 497P1 ≥$1,000, refunds, `entity_code`, memo/cross-reference rules, spender backtrace) was NOT exercised here — it belongs to the Phase 4 entry gate, where the direct-contribution aggregator needs it.

**Decision point** (done). Hybrid confirmed: manifest primary, raw oracle for headline reconciliation. Only composition rules proven by a gate ship. Record the methodology version with every snapshot.

## Phase 1: clients — COMPLETE (2026-08-06, branch `claude/sf-finance-phase-1`)

`backend/src/pipeline/sanFranciscoFinance/`:

- `sanFranciscoDashboardManifestClient.ts` — fetches contest files from the configured SFEC repo (raw.githubusercontent.com, branch + repo name in config), parses frontmatter, returns typed contest data. Bounded timeouts, retry on 429/5xx. Phase 1 added: every parse records a `schemaFingerprint` (sorted union of frontmatter keys per level) so upstream drift is visible in diagnostics before it breaks parsing, and the fetch falls back to the GitHub contents API (`api.github.com/repos/<repo>/contents/…`, verified byte-identical) when the raw host fails. **Deviation from the original plan**: the rendered-site fallback is impossible — `campaign.sfethics.org` is Jekyll-built HTML and 404s the `.md` paths (verified live), so the contents API is the fallback instead. Parse failures are never retried through the fallback (same bytes).
- `sanFranciscoOpenDataClient.ts` — SODA client modeled on `losAngelesOpenDataClient.ts`: base `https://data.sfgov.org/resource/<id>.json`, optional `SAN_FRANCISCO_OPEN_DATA_APP_TOKEN` (`X-App-Token`), 30s timeout, retry on 429/5xx, stable `$order` including `:id`, bounded paging. Typed fetchers: filers by fppc_id/candidate-name fragment (`4c8t-ngau`, "pending" ids map to null); summary rows by `fppc_id`; itemized transactions by committee + explicit form types + transaction-date bounds; public-funds rows by election date + optional district. Fetches `calculated_amount` (canonical) and `transaction_amount_1` (diagnostic); integer cents throughout; server-side `$select`/`$where`/`$group`; per-row rejects drop the row, never throw. Live-verified: Wong filer lookup, 525 Schedule A rows ($157,005.00), 27 mayoral 2024 public-funds rows.
- **Phase 1 discovery for the Phase 4 gate**: `cross_reference_match` and `cross_reference_schedule` are 100% null across all 971k transaction rows (verified 2026-08-06) — the late-filing dedupe cannot rely on them and must be proven with transaction ids/amount-and-date matching instead. The columns stay in the row type so upstream repopulation becomes visible.

## Phase 2: eligibility and office mapping — COMPLETE (2026-08-07, branch `claude/sf-finance-phase-2`)

`sanFranciscoFinanceEligibleOffices.ts`:

- State `CA`; district/GEOID pairs: `county::06075`, `place::0667000`, `school_unified::0634410`; office scope must equal the district type it sits in.
- Office → contest-code map per the Phase −1 table above; `County Supervisor` → `bosNN` (zero-padded, N ∈ 1–11 parsed NFKD-normalized from "Member, Board of Supervisors, District N"); CCB absent by decision.
- Eligibility is exact; the contest code doubles as the manifest file locator. Live-verified against the local database: all eight Nov 2026 races map to their exact SFEC contest codes, all five ballot measures reject.

## Phase 3: identity, links, and relations — COMPLETE (2026-08-07, branch `claude/sf-finance-phase-3`)

`sanFranciscoCandidateCommitteeResolver.ts` + `sanFranciscoFinanceWriter.ts` (link/relation writes only) + `sanFranciscoCandidateFinanceAutoLink.ts`, plus migration `215` carrying the two Phase 5 link tables forward (`sfc_candidate_finance_links`, `sfc_candidate_finance_outside_committee_links`) — a resolver without persistence is not verifiable end-to-end.

- Candidate → controlled committee comes **from the manifest** (`filer_nid` + `filer_id`). Resolution order: **FPPC id first** (roster rows store SF Ethics ids in `candidates.state_filing_ids` — deterministic for 13 of 15 manifest committees live), then Georgia-style name matching (parse variants, first+last alignment, middle-name-conflict veto, suffix-comma pre-strip for `"…, Jr."` display names). Cross-check `filer_type = 'Candidate or Officeholder'` in the filer registry; a missing or contradicting registry row writes the link as `needs_review` instead of active. Every ambiguity (one name → two candidates, one id → two candidates, two manifest committees → one candidate) fails closed.
- Outside relations from `ie_candidates`: one row per (candidate, election, spender, direction), targets resolved by committee id then name; id-less spenders keep a synthetic `name:<normalized>` identity — money is never dropped. **Deviation**: no `spender_filer_nid` column — the manifest names outside spenders with `filer_id` only, so the planned column would be permanently null.
- Auto-link refreshes each affected election **wholesale**: the full candidate list is re-read so manifest names and outside targets resolve against everyone in the contest; link upserts are idempotent; relation sets replace (empty clears stale rows); active automatic links whose committee left the manifest flip to `needs_review`, never deleted; manual links are protected exactly like LA.
- Live-verified 2026-08-07 against the real November manifests: 13 links created (asr 1, bos02 1, bos04 2, bos06 1, bos08 4, bos10 3, pdr 1), all matching the manifest to the committee; Gee and Brooke (committee-formers not on the ballot) surfaced as expected unmatched diagnostics; 12 ballot candidates without SFEC committees reported `no_committee`; second run idempotent. All November `ie_candidates` lists are currently empty, so the relation write path is unit-tested (June bos04 shapes) but not yet live-exercised.

## Phase 4: aggregation — COMPLETE (2026-08-08, branch `claude/sf-finance-phase-4-aggregators`)

Four pure modules, no schema or sync (Phases 5–6). `sanFranciscoDirectContributionAggregator` now owns the gate-proven formula and the probe delegates to it, so the production formula and the live gate cannot drift; the probe likewise uses `sanFranciscoPublicFundsMatcher` for its public-funds figures. Re-verified live after both refactors: all 15 committees reproduce the gate exactly (15/15 line identities, same three explained residuals), and the matcher resolved every funded candidate (`matched`/`none` only, no ambiguity). The client's summary rows additionally expose line 16 (ending cash), line 19 (outstanding debts), and Schedule B1 line 1 (loans received — summed across filings it reproduces the gate's $200,000 B1 finding on committee 1467508, including the real overlapping-period filing chain).

- `sanFranciscoHeadlineTotals` (from manifest): `total_raised` = `funds`, `total_spent` = `expenses` per candidate. Outside `support_total`/`oppose_total` = sums of the candidate's manifest relations by direction; groups list = the relations themselves with source URLs to the contest dashboard.
- `sanFranciscoBalanceAggregator` (from summary totals): cash on hand and outstanding debt from the latest filing's ending-balance lines; loans from Schedule B lines (`loans_received`, excluded from `total_raised` per the shared contract). Assert the no-duplicate-`filing_nid` guarantee.
- `sanFranciscoPublicFundsMatcher` (from `dbak-p2fq`): match by election date + district + normalized candidate name; sum `funds_approved` rows directly — every published row is an approval. `pending_completed` is no longer populated by the source (verified live: 152 valid approved rows carry it blank) and must never gate approval; `date_certified_approved` may optionally be required as a stricter signal. Ambiguous name matches fail closed (no public-funds figure rather than a wrong one). Mayor/Supervisor only.
- `sanFranciscoDirectContributionAggregator` (from transactions): **entry gate first** — before this aggregator ships, extend the probe to prove the itemized contributor formula against the two canonical races (Sch A + C itemized + qualifying 496/497P1 late-period rows, dedupe against later 460 reporting via transaction IDs and amount/date matching — `cross_reference_match`/`cross_reference_schedule` are 100% null upstream per the Phase 1 discovery — memo-row handling shown by the data rather than blanket-excluded, refunds negative). Phase 0 did not exercise these rules. Then implement the proven formula.

  **Entry gate DONE (2026-08-08, `proveContributorFormula` in the probe; verified live against all 15 committees of the two canonical races — every identity to the cent):**
  - **Itemized direct contributions = non-memo Sch A rows + non-memo Sch C rows + qualifying unpaired non-memo F497P1 rows.** F496 plays no role for controlled committees (zero F496 rows on all 15); no dollar thresholds are applied — the dataset only contains what was filed, including sub-$1,000 rows one filer put on 497s.
  - **Line identities (15/15 exact):** Form 460 line 1 = non-memo A + `F460ALine2` unitemized pseudo-rows; line 5 = line 1 + line 2 + line 4, where line 4 = non-memo C + `F460CLine2`. Memo exclusion proven on a memo-carrying committee (line 1 breaks by exactly the memo sum if included). **Schedule B loan principal is NOT in line 5** — the dashboard funds figure never includes loans (committee 1467508: $200,000 of B1 loans, line 2 = $29.38; line 2's semantics stay unidentified but tiny, carried as `line2Cents`).
  - **497P1 dedupe: filers re-report late contributions on the next 460 schedule under the SAME filer-assigned `transaction_id`** (Lurie: 13/13 ids reappear on Sch A with identical amounts — one with different name casing, so the no-id fallback matches names case-insensitively). Pairing order: A-by-id (ANY id hit is the twin — the filing software reuses one per-committee transaction counter across filings, which is the whole re-report mechanism; an amount mismatch means an amended amount, still a duplicate, and is counted separately so drift stays visible — 0 mismatches live across all 15 committees) → **B1-by-id = late-reported LOAN, excluded** → **city name + `funds_approved` amount match = 497-reported public-financing disbursement, excluded** (Chow: $60,000 from "City and Council of San Francisco" [sic] exactly matching a dbak-p2fq approval — counting it would double the public-funds figure) → amount/date/last-name → unpaired rows stay in (real money the 460s never saw; Mei: 20 sub-$100 rows totaling $620.86).
  - **Refunds are negative Sch A rows** (Lurie: 30 rows, −$12,800) — they stay in the sum, excluded from size buckets by sign.
  - **`entity_code` is populated on every Sch A row observed** (IND/COM/SCC/OTH); Lurie's 2,963 IND rows have 100% occupation and 99.97% employer coverage.
  - **Reconciliation: manifest funds = itemized + `F460ALine2` + `F460CLine2` + line 2 + public funds, exactly 0.00 for 12 of 15 committees.** The three residuals are fully explained: post-dashboard-cutoff filings (Lurie −$733,000, Hirsch-Shell −$29.38) and 497P1-only money the dashboard never counts (Mei −$620.86). Undated rows (all of Schedule B1) require the client's `includeUndatedTransactions` option — a strict date window silently drops the whole loan schedule. Occupation/employer analysis restricted to individual contributors via `entity_code`. Refunds reduce totals and are excluded from size buckets (no absolute-value bucketing). Occupations stay as disclosed — `classifyFinanceLabel` classifies industries and does not merge occupation synonyms ("ATTORNEY" and "LAWYER" remain separate rows); any alias layer is a separately tested follow-up, not v1. Reconcile the itemized sum against the manifest `funds` figure and store the difference (unitemized + timing) as a diagnostic.

## Phase 5: schema, flags, writer — COMPLETE (2026-08-09, branch `claude/sf-finance-phase-5-schema-writer`)

Shipped: migration 229 (`sfc_candidate_finance_summaries` / `_direct_breakdowns` / `_outside_groups`, applied locally; `matching_funds` is named `public_funds_received` after the shared read-path key rather than duplicated; `direct_contribution_total` added in review — the manifest funds figure includes public money, so donor money gets its own column the read path prefers for `total_raised`, NC pattern); the two flags in `featureFlags.ts`, `backend/.env` (both on locally per flag policy), and `render.yaml` (read flag only, sync deliberately absent); `replaceSanFranciscoCandidateFinanceSnapshot` in the writer (single transaction over link + summary + breakdowns + outside groups + optional industry classifications; integer-cents inputs converted to exact dollar strings at the DB boundary; negative or non-integer cents throw and roll the snapshot back). Live-verified with a real write/read/cleanup against a linked committee on the local database.

Original spec follows. Next free migration number at implementation time; `sfc_` prefix; identifiers ≤ 63 chars:

- `sfc_candidate_finance_links` — candidate/election identity, manifest contest code, `fppc_id`, `filer_nid`, committee name, link status (`active`/`needs_review`/`inactive`), link source, source URL, `last_verified_at`. Modeled on migration 173's link table.
- `sfc_candidate_finance_outside_committee_links` — normalized relation table (replaces any jsonb idea): `candidate_id`, `election_id`, `election_year`, `spender_fppc_id` (or synthetic id), `spender_filer_nid`, `spender_name`, `support_oppose`, `relation_source`, `source_url`, `last_verified_at`; unique per (candidate, election, spender, direction). A committee may legitimately appear supporting one candidate and opposing another.
- `sfc_candidate_finance_summaries` — LA columns plus `debts_owed`, `loans_received`, `public_funds_received`, `methodology_version`; no membership columns (SF does not disclose member communications separately).
- `sfc_candidate_finance_direct_breakdowns` (`occupation` / `employer` / `industry` / `contribution_size`).
- `sfc_candidate_finance_outside_groups` (per-cycle amounts per relation row).

Flags, default off, LA-pattern pair:

- `SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED`
- `SAN_FRANCISCO_CAMPAIGN_FINANCE_SYNC_ENABLED` (requires the first; `force` bypasses only the flag gate — see Phase 7 for backfill targeting)

`sanFranciscoFinanceWriter.ts`: **all-or-nothing candidate snapshots.** Stage every component (headline, balances, public funds, direct breakdowns, outside groups); write transactionally only when every required component passed source-health checks. No mixed-as-of summaries (partially fresh direct totals alongside stale outside totals must be impossible). Source unavailable → preserve prior snapshot untouched; source affirmatively returns no qualifying data → write zero totals and clear stale details.

## Phase 6: sync, batch, and source health — COMPLETE (2026-08-09, branch `claude/sf-finance-phase-6-sync`)

Shipped as specified, with the concrete health-check design pinned by live verification (all identities below re-checked against the real datasets on 2026-08-09; first full local batch run: 13/13 candidates synced, public-funds identity `direct_contribution_total = total_receipts − public_funds_received` exact on every funded candidate, `asr`/`pdr` correctly null-program).

- `sanFranciscoCandidateFinanceSync.ts` — one candidate/election: manifest (batch-cached or fetched), DataSF fetches, aggregate (headline, balances, public funds, direct with the probe's period-derived ±31-day transaction window), deterministic + cached-manual industry classification only (**no classifier parameter exists at all** — unknown rows persisting through the snapshot write ARE the manual industry-label due queue), all-or-nothing write, diagnostics incl. the raw-vs-manifest reconciliation difference. `direct_contribution_total` = manifest funds − matched public funds (both reconciled figures); an ambiguous public-funds match aborts the candidate (with the funds identity, a missing figure would corrupt the donor total too). Methodology version `sf-2026.1`.
- Source-health checks, all before any write (fail = throw = prior snapshot survives):
  - **`sync_flag`** must be true on every summary row (nulls exist upstream only on 2002-2007 legacy filings, verified live);
  - **filings-index coverage**: the index's current 460 chains (`current_status like 'Most Recent%'`, `rejected=false`, `has_efile_content=true` — paper filings never reach the extracts) must all appear in the summary dataset once older than a 5-day nightly-lag grace; verified live that this set exactly equals the summary dataset's `filing_nid`s on the gate committee;
  - **cross-dataset freshness**: summary vs transactions `max(data_as_of)` within a day of each other and `data_loaded_at` within 7 days of now (one aggregate query each, checked once per batch);
  - **anomaly bounds**: filing history may never go backwards (new latest-460 period end < stored `reported_through` aborts), and an order-of-magnitude donor-total drop on an unchanged filing set (same `reported_through`, stored ≥ $1,000) aborts; `bypassAnomalyCheck` is the operator override for the drop bound only.
- `sanFranciscoCandidateFinanceBatchSync.ts` — LA due-query pattern with the Phase 2 district predicates (the office gate is already encoded in the link's `contest_code`): auto-link missing links first (warn-and-continue), then sync due links stalest-first; defaults 25 candidates, 1-day staleness, 45-day lookback, 730-day lookahead; skips `withdrawn`/`lost`; manifests cached per (election date, contest); one freshness check per batch fails all due candidates with the same reason instead of hammering the API.
- **Election-level refresh (from Phase 3 review) — implemented:** a second pre-sync leg selects elections whose ACTIVE links went stale by `last_verified_at` (independent of missing-link discovery) and feeds one representative row per election through the auto-link's wholesale refresh, so outside relations and manifest-disappearance flags stay fresh on fully linked elections. Verified live: the first batch run wholesale-refreshed exactly the 3 fully-linked elections the missing-links leg skipped.
- Client additions: `syncFlag` on summary rows; `getSanFranciscoDatasetFreshness` (aggregate maxima); `getSanFranciscoCommitteeCurrentForm460Filings` (filings index `qizs-bwft`; note the bare dataset query 500s upstream — always pass `$select`).

## Phase 7: scheduling, scripts, backfill — COMPLETE (2026-08-09, branch `claude/sf-finance-phase-7-scheduling`)

Shipped as the full LA-mirror set (the repo's 45-scheduler convention), with the cron route as the v1 production choice:

- Scripts + npm wiring: `san-francisco-candidates:finance:sync-due` (`syncDueSanFranciscoCandidateFinance.ts`, Georgia-style strict parser: unknown flags, bare positionals after npm's `--`, non-safe-integer values all fail loudly), `:scheduler:upsert` / `:scheduler:worker` / `:scheduler:trigger` (LA style; trigger and upsert load `.env` before their flag checks like Georgia's, so local runs don't silently read an unloaded environment). `probeSanFranciscoCandidateFinance.ts` already existed.
- `sanFranciscoCandidateFinanceSyncScheduler.ts` — LA template: BullMQ queue `san_francisco_candidate_finance_maintenance`, scheduler id `san_francisco_candidate_finance_sync_daily`, cron default **`30 16 * * *` UTC** (09:30 PDT / 08:30 PST — after DataSF's nightly refresh year-round, offset from LA's 09:50), env overrides `SAN_FRANCISCO_CAMPAIGN_FINANCE_SYNC_SCHEDULER_QUEUE`/`_DAILY_CRON`/`_DAILY_TZ`, master flag not bypassable by `force`, upsert removes the scheduler when the master flag is off. Verified live against local Redis: upsert persisted the `30 16 * * *` scheduler, flag-off upsert removed it.
- **Production scheduling is explicit, not implied.** render.yaml carries a commented `voteapp-san-francisco-finance-sync` cron block (16:30 UTC, `npm run san-francisco-candidates:finance:sync-due`) documenting the v1 choice: one-shot cron, NOT the resident worker, with both SF flags on the cron service ONLY. Nothing runs until that block is uncommented on a paid plan.
- **Historical backfill targeting implemented:** `--election-id <uuid>` on the due-sync script (and `electionId` on the batch module) swaps the due query's election-date window for an `election.id` match, drops the `withdrawn`/`lost` exclusion (a decided election's losers are the point of a backfill), and skips both pre-sync legs — backfill requires links to exist already, and a targeted run does no unrelated daily maintenance. `--lookback-days` widens the ordinary window instead. `--force` still bypasses only the feature-flag gate. Unit tests prove the ordinary due query always carries both window bounds and the status exclusion (no silent unbounded history) and that a malformed election id fails before any work. Pre-2024 elections are absent from the manifest repo; anything older runs raw-path-only and is a separate, later decision.

## Phase 8: ballot-lookup and UI integration — COMPLETE (2026-08-09)

Shipped exactly as specified below: `SAN_FRANCISCO_ETHICS` source union member + runtime list, `sanFranciscoBallotLookupFinanceLoader.ts` (LA-shaped over the shared primitives; `total_raised` = `direct_contribution_total ?? total_receipts`; debts/loans/public funds mapped; outside groups keyed `spender_fppc_id` with `expenditure_count` always null — the manifest stores per-relation totals only; no membership fields — SF does not disclose member communications), registry entry after the LA CA entry, and the api-client label. `outside_coverage_note` left unset (Phase 0 found no systematic manifest gap). Live check against the local database: all 13 active links returned summaries, and every public-financing candidate showed donor-only "raised" disjoint from public funds (McCoy 104,832 vs 155,304 — the Phase 6 identity).

- Add source value `SAN_FRANCISCO_ETHICS` to the union in `backend/src/pipeline/address/ballotLookupFinanceShared.ts`.
- Add `sanFranciscoBallotLookupFinanceLoader.ts` (flag-gated, exact-eligibility) **modeled on the LA city loader** — a bespoke loader over the `ballotLookupFinanceShared` primitives (`buildStateFinanceSummaryRequests`, `mapFinanceBreakdown`, …), NOT `standardStateFinanceBallotLookupLoader`: the standard loader unconditionally queries `direct_contribution_total` variants plus an `outsideGroupBreakdowns` table, a shape neither LA nor SF has (SF has no spender-funder data — the manifest discloses per-relation totals only). The loader maps `total_raised` from `direct_contribution_total ?? total_receipts` (donor money preferred — the manifest funds figure includes public-financing money, and the card shows "Raised" and "Public funds" as disjoint stats) and selects `cash_on_hand`, `debts_owed`, `loans_received`, `public_funds_received`, which the existing card already renders. Register after the CA state and LA city entries in the `ballotLookup.ts` registry — GEOID eligibility keeps the domains disjoint.
- API-client label (web + mobile cards): `SAN_FRANCISCO_ETHICS`: `San Francisco Ethics Commission`.
- UI reality, stated precisely: **no UI changes are required** for raised/spent, occupations, size buckets, cash/debt/loans/public funds, or outside groups — the existing profile card renders those. Employer and direct-industry breakdowns are **stored but deliberately not displayed** (existing product decision documented in `FinanceSummaryCard.tsx`); showing employers would be a separate product decision, not part of this adapter.
- Set `outside_coverage_note` only if Phase 0 identifies a systematic gap in the manifest's outside coverage; otherwise leave unset.

## Phase 9: tests and validation — COMPLETE (2026-08-09)

Coverage audit found the checklist already covered by the phase 1–8 suites
(146 SF tests across 15 files) with one gap: SODA client retry. Four retry
tests were added (5xx and 429 retry-then-success, network-failure retry, no
retry on other 4xx, terminal status after exhaustion — the standalone "exhausted retries"
throw is unreachable because the final attempt always rethrows). Loader
registration has no unit test on purpose: the adapter registry is not
exported, and the live 13/13 read path already proves registration
end-to-end. Validation gates all passed: backend typecheck clean; SF tests
146/146; full suite 7,322 passed; empty-database migration run applied every
migration through 230; api-client 136/136; live Lurie + June-2026-D4 probe
reconciled with every dashboard reference check true and the same three
known residuals (−733,000.00 Lurie 497-only money, −29.38, −620.86); live
targeted 2026-cycle run re-synced all 13 linked candidates with the
public-funds identity exact on every funded committee; candidate-profile API
(`GET /api/elections/:election_id/candidates/:candidate_id/finance`) served
the fresh SAN_FRANCISCO_ETHICS summary with breakdown fallback URLs.

Fixtures are compact captured rows/frontmatter, not dataset dumps.

- Manifest parser: schema drift (unknown keys pass, missing known keys fail), synthetic-id fallback for id-less committees, dual-direction committee relations, fetch fallback.
- SODA client: paging, retry, `$where` construction, malformed-row rejection, cents conversion.
- Source guarantees: duplicate-`filing_nid` assertion fires; `sync_flag`/freshness gates blockwrites; anomaly bounds.
- Contributor formula: Sch A + C + 496/497P1 composition, late-period dedupe vs later 460s, refund sign handling and bucket exclusion, `entity_code` individual filter, memo-row rule as proven by the Phase 4 entry gate.
- Resolver: manifest-driven linking, ambiguous-name fail-closed, disappearance flagging, prior-office committee rejection.
- Public funds: name+district match, approved-only summation, ambiguity fail-closed.
- Eligibility: per-office scope matrix from Phase −1, seat parsing, non-SF CA rejection, LA/CA-state adapters untouched.
- Writer: all-or-nothing staging, preserve-vs-clear semantics, methodology version stamping.
- No-AI guarantee: sync path performs zero classifier calls; unresolved labels enqueue to the manual due queue.
- Loader registration and shared finance output shape; flag gating; scheduler-choice behavior.

Validation gates: backend typecheck; focused SF tests; full backend suite; empty-database migration run; api-client tests; live Lurie + June-2026-D4 probe with manifest headline and outside values matching the rendered dashboards to the cent, while the raw path validates the proven contribution formula and records residuals (raw expenses and outside tagging are documented as non-reproducible); then a live 2026-cycle run against real linked candidates once rosters exist, and database-backed candidate-profile API verification.

## Sequencing

1. **Phase −1** (done): office-scope confirmation + Community College Board deferral. Roster work (the eight Nov 2026 races in the local database) proceeds in parallel via the manual-research skill.
2. **Phase 0** dual-path validation. Gate + architecture decision.
3. Phases 1–6 (clients, eligibility, identity, aggregation, schema, sync).
4. Phase 7 scheduling decision wired into deploy config; Phase 8 loader + label; Phase 9 validation.
5. Targeted historical backfill (2024 Mayor et al.) via explicit election targeting; then enable flags per the deploy checklist.
