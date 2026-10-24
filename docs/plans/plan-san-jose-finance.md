# San José Local Campaign Finance Plan

Status: Phases 1–5 built (shared `efileCalFinance/` client + parser, the San
José eligibility + resolver adapter, the direct/outside aggregators — all
live-verified 2026-08-10 — then migration 233 + flags + source enum + snapshot
writer, then the Phase 5 sync/auto-link/batch/loader/CLI, dry-run verified
live 2026-08-11); Phase 6 live validation done locally 2026-08-12 (real writes,
all six candidates reconciled cent-exact against every filed 460 PDF), to be
re-run after the city's final candidate list (Aug 13) before production.
Feasibility + export semantics verified against live
data 2026-08-10 (portal probed, 2025+2026 workbooks downloaded and audited).

## Goal and v1 scope

Per-candidate finance summaries for San José city offices, same card the other
city modules feed: total raised, total spent, top donor occupations/employers,
contribution size buckets, and outside spending for/against. v1 targets the
November 3, 2026 runoff (verified on the city 2026 election page: **Council
Districts 5, 7, 9 only** — mayor is presidential-cycle since 2024). Never
hardcode districts: sync is gated to OUR November-election roster candidates
(city finalizes its candidate list August 13).

Candidate qualification comes from OUR rosters (manual research), never
inferred from filings — the filing store also contains withdrawn, terminated,
prior-cycle, and non-city committees (verified: "David Cohen for California
Senate District 10 2026" files copies with the city).

## Proven source access (all verified live 2026-08-10)

- Official portal `https://efile.sanjoseca.gov` (vendor efile.systems), live
  since 2025-12-18. Old SouthTech portal retired **February 2026** — never
  build against it.
- Bulk export API (no auth):
  `GET /api/v1/public/campaign-bulk-export-url?year=<Y>&most_recent_only=<bool>`
  → returns a stable unsigned S3 URL, e.g.
  `https://efs-efile-campaign-exports.s3.amazonaws.com/csj/export/City_of_San_Jose_CAL_2026_most_recent.xlsx`.
  Years 2018–2026; recent 3 years refresh hourly. 2026 file ≈ 2.6 MB.
- Filing-metadata API: `GET /api/v1/public/campaign-search?...` → per-filing
  JSON: `state_id` (FPPC ID), committee `name`, `committee_type`, amendment
  chain (`amends_orig_id`, `amendment_number`), `e_filing_id`.
- Workbook (CAL 2.20 data, XLSX): **15 sheets, NO cover/CVR sheet** —
  `F460-Summary`, `F460-A-Contribs`, `F460-C-Contribs`, `F460-B1-Loans`,
  `F460-D-ContribIndepExpn`, `F460-E-Expenditures`, `S496`, `S497`, etc.
  Occupation/employer present (`Ctrib_Occ`/`Ctrib_Emp` on A and C sheets).
- Amendment semantics verified: the `most_recent_only=true` ("without amended
  records") variant keeps only current versions (superseded originals absent;
  e.g. Bien Doan filing 24690 replaced by amendment 24692).
- Backend already has the `xlsx` dependency; no new packages.

## Export semantics (audited — these are load-bearing)

- `F460-Summary` rows key on **(Form_Type, Line_Item)** — never a bare line
  number. `Form_Type=F460` line 2 = net loans; `Form_Type=A` line 2 =
  unitemized monetary < $100; `Form_Type=C` line 2 = unitemized nonmonetary.
- `Amount_A` = this report period; `Amount_B` = **calendar-year-to-date** (not
  cycle-to-date). The 2026 campaign contribution period began **November 4,
  2025**, so a 2026 cycle needs the **2025 + 2026** files summed.
- Form 460 line 5 includes loans (line 2). VoteApp keeps loans out of
  `total_raised` (`loans_received` is separate in
  `ballotLookupFinanceShared.ts`), so line 5 is NEVER mapped to total_raised.
- Filed arithmetic can be internally wrong: Bien Doan's current 2026 460
  reports YTD line 1 = 91,178.91, line 2 = 20,000.00, but line 3 =
  131,178.91 — a $20,000 overstatement baked into the filing. Invariant
  checks are mandatory, not nice-to-have.

### Cycle formulas (verified against live data)

Across canonical, non-overlapping, current-version F460 filings whose periods
fall inside the campaign period (2025-11-04 → runoff, spans calendar years):

- `total_raised` = Σ(F460 line 1 `Amount_A`) + Σ(F460 line 4 `Amount_A`)
  (monetary + nonmonetary, loans excluded)
- `loans_received` = loan-receipt lines of the B1 summary block (exact
  (Form_Type, Line_Item) pinned in Phase 1 fixtures), cross-checked against
  the `F460-B1-Loans` sheet
- `total_spent` = Σ(F460 line 11 `Amount_A`)
- `cash_on_hand` = latest filing's F460 line 16 `Amount_A`
- `debts_owed` = latest filing's F460 line 19 `Amount_A`
- unitemized bucket = Σ(Form_Type=A line 2) + Σ(Form_Type=C line 2)

Live check (Bien Doan D7, through 6/30/2026): raised 117,125.37 · loans
20,000 · spent 108,905.71 · cash 32,668.66 — matches the portal PDFs, not the
malformed line 3/5.

**Invariants** (per filing: line 3 = 1 + 2, line 5 = 3 + 4; per committee:
period continuity, no gaps/overlaps, cash chain line 16 consistency). On
violation: quarantine the committee, reconcile against the filing PDF before
anything is written — never publish silently from broken arithmetic.

### Outside spending

- Sources: `S496` sheet ∪ `F460-D-ContribIndepExpn` rows with
  `Expn_Code=IND`, deduped by **(Filer_ID, Tran_ID)** — verified live: all 41
  Schedule D IND rows matched an S496 row by that key (S496: 174 rows /
  $653,351 in the 2026 file at audit time).
- Schedule D `MON`/`IKD` rows are contributions TO committees, not
  independent spending — excluded from outside totals.
- S496 target identity is structured (`Cand_NamL/F`, `Office_Cd`,
  `Office_Dscr`, `Dist_No`, `Supp_Opp_Cd`).
- Form 496 only captures qualifying IEs in the 90-day window; the Schedule D
  union closes most of that gap. Anything still uncovered goes in
  `outside_coverage_note`.
- S497 (24-hour late contributions) is a provisional recency signal only —
  never added to totals.

## Committee resolution (no CVR sheet exists)

Dry-run against the live 2026 roster cohort (all 6 D5/7/9 runoff candidates)
2026-08-10 produced the constraints below. Every candidate does resolve, but
naive name matching is unsafe.

- Durable key = FPPC ID (`Filer_ID` in workbook = `state_id` in search API).
  **`Filer_ID` is not always numeric** — the export contains the literal
  string `Pending` (observed on a 2024 committee still ID-less today), so the
  key type is text and `Pending` is never a durable identity; such committees
  fall back to normalized-name keys and cannot auto-link. (Whether `Pending`
  later flips to a real ID is unverified — confirm during live validation.)
- **`Cmtte_Type` is the safety gate, not the name.** Observed across both
  files: `C` (candidate-controlled), `P` (primarily formed), `G` (general
  purpose) — labels are the CAL spec's committee-type codes and match every
  spot-checked committee (IBEW 332 fund, Silicon Valley Biz PAC, COMMON GOOD
  = all `G`). Only `C` may feed direct totals; any code outside the known set
  fails closed. Cross-check against the search API's human-readable
  `committee_type` ("Candidate or Officeholder"). This matters because an
  outside committee
  can carry the candidate's name: "South Bay Working Families Supporting
  Ortiz for City Council 2026" (`P`, FPPC 1487316) sits next to "Peter Ortiz
  for San Jose City Council District 5 2026" (`C`, FPPC 1480385). Matching on
  name alone would book independent-expenditure money as the candidate's own
  fundraising.
- **District is NOT reliably in the committee name** — 2 of 6 lack it: "Nora
  Campos for San Jose City Council 2026", "Van Le for City Council 2026" (the
  latter omits the city too). Formats seen: `District 5`, `D7`, none. So
  district is a *confirming* signal when present, never a match requirement.
- Name normalization is mandatory: accented/unaccented city ("San José" vs
  "San Jose") and trailing-whitespace duplicates of the same `Filer_ID`.
- **Match on word tokens, never substring** — a case-insensitive substring
  probe for "Le" hit IBEW Local 332, Silicon Valley Biz PAC, and COMMON GOOD
  SILICON VALLEY (the "le" inside "Electrical"/"Valley"). Tokenized matching
  makes short surnames like Le safe.
- `Elect_Date` is dirty (observed `20260630` — a period date — and `None`), so
  it is a soft signal only; cycle gating comes from filing periods.
- Match to roster candidates by name tokens + `Cmtte_Type=C` + city-office
  name parse, confirmed by district and election year when present, reusing
  `personFirstNameNicknames` / `personNameMiddleEvidence` + suffix veto.
  **Given name AND surname must both match** (given name nickname-aware) —
  surname alone collides in live data: "Nora Campos … 2026" and "Pamela
  Campos … District 2 2024" are different people.
- Resolution must be unique within the roster cohort; ambiguous, duplicate, or
  unparseable committees fail closed (no auto-link, queued for manual link).

## Privacy and transport hardening

- Never persist contributor street addresses (`Ctrib_Adr*` columns are
  parsed past, not stored).
- Download client: allowlist hosts (`efile.sanjoseca.gov`,
  `efs-efile-campaign-exports.s3.amazonaws.com`), cap workbook size, validate
  XLSX/ZIP magic bytes before parsing.

## Phases

Phase 0 (export proof) is **done** — endpoint, sheet inventory, amendment
semantics, formulas, dedup, and a full resolver dry-run against the live
roster cohort audited 2026-08-10 with the 2025 + 2026 `most_recent_only`
files. Roster prerequisite is also met: the three Nov-3-2026 runoff races
(D5/7/9) exist with 2 candidates each, and all 6 map to a `Cmtte_Type=C`
committee in the export. That 6-candidate mapping is **provisional** — the
city finalizes its candidate list August 13, 2026; re-run the resolver
dry-run against the final roster before enabling sync.

### Phase 1: shared vendor module + parser — DONE (2026-08-10)

- Built: `efileCalFinance/efileCalBulkClient.ts` (agency config = key +
  portal base URL + export-host allowlist; export-URL resolution → JSON
  `{success, data}`; size-capped magic-checked download; ETag/Last-Modified
  artifact cache modeled on `calAccessRawDataArtifactCache.ts`) and
  `efileCalWorkbookParser.ts` (typed rows for F460-Summary, A, C, B1, D,
  S496, S497; keyed (Form_Type, Line_Item); memo-row aware; exact
  text-decimal → cents; addresses never surfaced).
- Tests off synthetic workbooks (12): keying, money edge cases, flag cells,
  lenient `Elect_Date` vs strict period dates, `Pending` filer ID, missing
  sheet/column/identity fail-closed, allowlist, size cap, cache
  unchanged/changed/force.
- Live-verified: both 2025+2026 workbooks parse whole (no rejected rows);
  Bien Doan reconciles cent-exact (raised 117,125.37 / spent 108,905.71 /
  cash 32,668.66 / net loans 20,000); real portal refresh → `downloaded`
  then `unchanged` on the ETag.

### Phase 2: San José agency adapter — eligibility + resolution — DONE (2026-08-10)

- Built: `sanJoseFinance/sanJoseFinanceEligibleOffices.ts` (GEOID `0668000`,
  keys `place::Mayor` + `place::City Council Member`, seat parse covering the
  catalog's actual "Member, City Council, District N" title, D1–D10) and
  `sanJoseCandidateCommitteeResolver.ts` (committee grouping by `Filer_ID`
  with Pending rows keyed by name; type gate = lone `C`, unknown/conflicting
  codes fail closed; person match via the shared `personNameMiddleEvidence`
  gates + `personFirstNameNicknames` VoteApp-side expansion; district / year /
  cross-office / foreign-office name evidence as vetoes; FPPC-id tier off
  `state_filing_ids`, with the same vetoes applied — `state_filing_ids` is
  candidate-global across races, so a stored id contradicted by the
  committee's own name evidence falls through to the name tier instead of
  linking; ambiguity fails closed in both directions and a blocked
  name-match also blocks its linkable sibling).
- Tests (26): the full Phase 6 resolver list (Ortiz `P` committee, Campos /
  Van Le district-less names, "Le" substring safety, Nora-vs-Pamela, accent
  variants, Pending, unknown types, suffix veto, nickname, quoted call names,
  both ambiguity directions) plus seat-parse and eligibility gates.
- Live-verified: resolver run against the real 2025+2026 workbooks (21,913
  rows → 35 committees) resolves all 6 D5/7/9 runoff candidates to 6 unique
  `C` committees by name, matching the Phase 0 manual dry-run. Roster is
  still provisional until the city's final candidate list (Aug 13) — re-run
  before enabling sync.

### Phase 3: aggregation — DONE (2026-08-10)

- Built: `sanJoseDirectFinanceAggregator.ts` (cycle formulas above off
  Amount_A only; canonical-filing selection — the live `most_recent_only`
  export carries committees with TWO current filings for one period,
  including two independent amendment chains for Van Le with their Schedule
  A rows duplicated, so one filing per period wins by latest Rpt_Date and the
  transaction sheets are filtered to the winners; occupations/employers/size
  buckets from canonical A + C rows, `Entity_Cd=IND`, memo excluded, refunds
  never bucketed; `reportedThrough`/`coverageStart` emitted) and
  `sanJoseOutsideSpendingAggregator.ts` (S496 ∪ Schedule D IND by
  (Filer_ID, Tran_ID); duplicate 496 REPORTS of one expenditure collapse to
  the latest report while same-key rows naming different targets are kept;
  token-based target-name matching via the resolver's shared person gates
  with office/jurisdiction/district as fail-closed vetoes on name-matched
  rows; direction only from literal SUPPORT/OPPOSE; measure rows excluded;
  Pending spenders group by normalized name). Industry/label classification
  stays at sync time (SF pattern) — aggregators emit raw names only.
- Invariants are a typed `violations` list, never a silent gate: line 3=1+2 /
  5=3+4 on both columns, period gap/overlap, duplicate-period filings,
  cash-chain (line 12 vs prior 16), nonzero opening cash
  (`prior_activity_uncovered`), rows-vs-cover reconciliation (Schedule A +
  A|2 = line 1, C + C|2 = line 4, B1 Loan_Amt1 = B1 summary line 1). Sync
  (Phase 5) decides quarantine and `direct_coverage_note` wording.
- Tests (19): formulas, Van Le duplicate chains, Bien Doan Amount_B error,
  Ortiz overlap/cash restatements, Altwer opening cash, missing core line vs
  legitimately absent A|2/B1 blocks, reconciliation drift, breakdown
  semantics, 496 duplicate report, multi-candidate mailers, D-IND union +
  MON/IKD exclusion, dirty target names, office/juris/district/direction
  vetoes, Pending spender grouping, mayor district veto.
- Live-verified (dry-run on the cached 2025+2026 workbooks): all six runoff
  candidates reconcile cent-exact to the Phase 0 manual audit (Bien Doan
  117,125.37 / 108,905.71 / 32,668.66 / loans 20,000); violations fire
  exactly on the known live defects — Doan's $20,000 YTD line-3 error, Van
  Le's duplicate chains (and her two other broken YTD line-3 filings), Ortiz
  beginning-cash restatements ($50/$500) + one-day overlap, Doan one-day gap
  + $4,449 year-boundary cash restatement, Altwer's uncovered 2025 activity
  ($47,353.73 opening cash — her 2025 filings are absent from the export;
  disclose via `direct_coverage_note` at sync). Outside: Ortiz support
  281,447.58 (dedup removed the double-reported $374.02), Campos oppose
  5,270.18, Doan 101,249.54, Altwer 118,723.85, Chester 1,255.68, Le 0; the
  10 candidate-less rows ($35,191.60) are ballot-measure spending, excluded.
- Store `reported_through` (latest covered `Thru_Date`) alongside totals so
  the UI never implies sync time = data recency (field emitted; persisted in
  Phase 4).

### Phase 4: schema, flags, writer — DONE

- Migration `233_add_san_jose_campaign_finance_tables.sql`: four `sjc_`
  tables modeled on SF (215 + 229) with SJ's differences — committee
  identity = FPPC id alone (no contest code / filer nid; `fppc_id` CHECK
  rejects the literal `Pending`); one donor-money `total_raised` (no
  headline/direct split, no public-funds column); `cash_on_hand` signed
  from day one (the GA/MA 231/232 lesson); `direct_coverage_note` column
  on summaries (per-candidate disclosure, e.g. Altwer's uncovered 2025);
  outside groups carry `expenditure_count` and include `spender_name` in
  the unique key so two id-less Pending spenders never collide. Validated
  on a scratch DB (constraints exercised: Pending rejected, negative cash
  accepted, negative flow rejected).
- Flags shipped (defaults false in code): `SAN_JOSE_CAMPAIGN_FINANCE_ENABLED`,
  `SAN_JOSE_CAMPAIGN_FINANCE_SYNC_ENABLED`,
  `SAN_JOSE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED`; all three `=true`
  in local `backend/.env`; read flag added to `render.yaml`.
- Source enum `SAN_JOSE_CITY_CLERK` in `ballotLookupFinanceShared.ts`
  (+ runtime `FINANCE_SUMMARY_SOURCES` mirror); label "City of San José
  Office of the City Clerk" in `FINANCE_SOURCE_LABELS`
  (`packages/api-client/src/format.ts`, shared by web + mobile) +
  `financeSourceLabel` test.
- `sanJoseFinanceWriter.ts`: `upsertSanJoseFinanceLink` (manual-link
  protection incl. last_verified_at advance on exact FPPC match, automatic
  conflict errors, active upsert deactivates other automatic links) +
  `replaceSanJoseCandidateFinanceSnapshot` (one transaction: link, summary,
  breakdowns, outside groups, optional industry classifications; integer
  cents → exact dollar strings; negative flows abort, signed cash passes).
  8 writer tests; module 58, full backend suite green.

### Phase 5: sync, loader, scripts — DONE (2026-08-11)

- Built: `sanJoseCandidateFinanceSync.ts` (per-candidate sync: committee
  presence check fails closed when a linked committee leaves the export;
  quarantine policy — blocking = filing_unusable / duplicate_summary_line /
  missing_summary_line / contribution_reconciliation / loan_cross_check,
  prior_activity_uncovered publishes WITH a per-candidate
  `direct_coverage_note`, the rest are diagnostics only since all six live
  committees trip them and still reconcile cent-exact; SF anomaly gates —
  reported_through regression never bypassable, 10× raised collapse on an
  unchanged filing set bypassable; employer-label classification
  deterministic + cached-manual only, zero AI; `loadSanJoseCycleWorkbookData`
  fetches the [year-1, year] workbook pair through the Phase 1 artifact
  cache, network-off unless the raw-data flag allows), plus the agency
  config (`csj`, S3 host allowlist) and methodology version `sj-2026.1`.
- `sanJoseCandidateFinanceAutoLink.ts`: SF-style missing-links selector
  (SJ place predicate + TS office gate + seat parse), resolution PER
  ELECTION via the Phase 2 resolver; matched → active `efile_export` link,
  ambiguous → needs_review, unmatched → no_committee; manual-link
  protection lives in the writer and surfaces as a per-candidate error.
- `sanJoseCandidateFinanceBatchSync.ts`: workbooks loaded once per election
  year (failures cached so the portal is hit once), auto-link leg
  warn-and-continue, stalest-first due loop, `electionId` backfill
  targeting. No SF-style stale-election leg: no relations table exists, and
  every snapshot rewrite advances `last_verified_at`.
- `sanJoseBallotLookupFinanceLoader.ts` registered in `ballotLookup.ts`
  (source `SAN_JOSE_CITY_CLERK`): loans surfaced, per-candidate
  `direct_coverage_note` threaded (omitted when null), real
  `expenditure_count` on outside groups, summary-URL fallback.
- Script `syncDueSanJoseCandidateFinance.ts` (`npm run
  san-jose-candidates:finance:sync-due`; strict flags, `--force`,
  `--bypass-anomaly-check`, `--election-id`); raw refresh gated by
  `SAN_JOSE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED`. Scheduler scripts
  deferred until San José gets an automated cadence.
- Tests: 27 new (sync 9, auto-link 6, batch 7, loader 5); module 85/85,
  full backend suite green.
- Live-verified 2026-08-11 (dry-run, no DB writes; fresh 2025+2026
  downloads): all 6 runoff candidates resolve 6 unique committees; Doan
  cent-exact vs the Phase 0 audit (117,125.37 / 108,905.71 / 32,668.66 /
  loans 20,000 / outside 101,249.54); Altwer 118,723.85 / Campos oppose
  5,270.18 / Chester 1,255.68 / Le 0 match Phase 3; Ortiz support
  281,447.58 → 292,697.58 (new IE filings since Aug 10). Coverage notes
  fire for Altwer AND Van Le (her export history opens 2025-07-01 with
  prior cash — new observation); zero blocking violations. The dry-run
  driver is a local UNVERSIONED scratch file
  (`backend/scratch/sjPhase5DryRun.ts`, gitignored); the post-Aug-13
  re-run can use it where it exists, or equivalently: refresh the
  workbooks via `loadSanJoseCycleWorkbookData`, list roster candidates
  with `listSanJoseCandidateElectionsMissingFinanceLinks`, resolve with
  `resolveSanJoseCandidateCommittees`, and run
  `syncSanJoseCandidateFinance` with `dryRun: true` per match.

### Phase 6: tests and live validation

- Unit: malformed summary math (Bien Doan case), cross-calendar-year cycle
  assembly, memo rows, A/C unitemized keying, 496/Schedule-D dedup, MON/IKD
  exclusion, missing occupation handling, address-privacy assertion.
- Resolver unit tests, each from a real observed case: `P`-type committee
  carrying a candidate's name is never linked (Ortiz), district-less committee
  names still resolve (Campos, Van Le), short surnames do not substring-match
  ("Le" vs IBEW/Silicon Valley/COMMON GOOD), same-surname different-person
  committees never cross-link (Nora vs Pamela Campos), accent and
  trailing-whitespace normalization (Doan), `Filer_ID='Pending'` is not a
  durable key, dirty `Elect_Date` does not gate, unknown `Cmtte_Type` codes
  fail closed.
- Live: sync the D5/7/9 runoff candidates; reconcile every written total
  against portal 460 PDFs; verify at least one IE committee shows correct
  direction; verify quarantine fires on the known malformed filing if still
  uncorrected.

**Live validation run, local DB, 2026-08-12 (all four checks passed):**

- Real writes: `npm run san-jose-candidates:finance:sync-due` auto-linked and
  wrote all 6 roster candidates, 0 failures, workbooks served from cache.
  (The CLI's `--dry-run` is a no-op on a cold database by design: the auto-link
  leg is skipped when dry, so nothing is ever due. Rehearse with the scratch
  driver, not with `--dry-run`.)
- PDF reconciliation: every one of the 30 Form 460 filings the export carries
  for these committees was downloaded from the portal
  (`/api/v1/public/document?doc_id=Ext_<filing_id>`, which returns a signed S3
  URL) and its whole summary page — lines 1–19, both columns — compared to the
  export. **30/30 cent-exact, zero mismatches.** Recomputing the published
  totals from the PDF numbers alone reproduces all four figures for all six
  candidates exactly. Column B (calendar YTD) is confirmed unreliable in the
  filings themselves (Ortiz's own B column drifts $710 off its own column A
  chain) — another reason the app sums column A.
- IE direction: the Government Attorneys' PAC 496 against Nora Campos is
  marked OPPOSE on the filed form and is stored as `oppose`; the committees
  stored as `support` are self-described supporting committees. Direction maps
  correctly both ways.
- Quarantine: fires as designed and blocks nothing — Doan's $20,000 line-3
  error, Le's three broken column-B lines and duplicate 2025 period, Ortiz's
  two cash-chain restatements and one period overlap, Altwer's and Le's
  prior-activity notes. All diagnostics; no committee was withheld.

**Defect found by this run (FIXED 2026-08-12, see below) — outside spending
misses paper filings.**
The bulk export carries e-filed data only. Santa Clara County Government
Attorneys' Association PAC filed *two* 496s opposing Nora Campos: `24950`
(e-filed, $5,270.18, in the export) and `24823` (paper/scanned, $5,270.27,
filed 05/12/2026 via netfile.com, **absent from the export**). The e-filed
form's own "cumulative to date" line — $10,540.45 — proves the pair. So
Campos's published oppose total is roughly half the real figure, with no
disclosure. Scope citywide for 2026: 4 paper 496/497 filings total, of which
these 2 are 496s; **no candidate committee among the six has a paper 460**, so
the direct-money side is unaffected. Attribution is the hard part — the portal
search index exposes the *spender*, never the target, and a scanned 496 has no
text layer, so a cross-check could only say "N paper IE filings exist
citywide", which would tag all six candidates for one candidate's gap. Options,
in order of preference: (a) leave the totals alone and treat paper IEs as
manual research; (b) add an outside-coverage note driven by an operator-curated
list; (c) OCR the scans.

**Fix shipped 2026-08-12: curated paper-496 supplements.**
`sanJosePaperFilingSupplements.ts` holds operator-verified transcriptions of
paper 496 expenditure lines (spender, target as printed, office/district,
direction, amount, portal e_filing_id, source note). Automated attribution was
confirmed impossible first: the raw S496 sheet has no `Cum_YTD` column (only
Schedules A/C carry one) — the cumulative printed on the 496 PDF is
vendor-rendered from data the XLSX never carries — and the search index names
the spender, never the target. Supplements are validated at module load (fail
loud: blank fields, nonpositive amounts, non-ISO dates, duplicate
filing+target), keyed by `electionYear` (sync applies only the matching
cycle), and fed through the aggregator's normal target-match and veto pipeline
as synthetic rows in a `paper-496-` Tran_ID namespace, so they can never
collide with export rows and a mistyped target simply matches nobody.
Maintenance contract in the module header: add an entry only after reading the
scan AND confirming the expenditure is absent from the export; re-verify when
re-auditing a cycle (a later e-filed amendment re-reporting the expenditure
would double-count). One entry shipped: the anti-Campos paper 496
(e_filing_id 24823, $5,270.27). Live re-sync confirms Campos oppose =
$10,540.45 — exactly the PAC's own sworn cumulative — with every other
candidate unchanged.

## Limitations and risk register

- Export covers e-filed statements only. Confirmed live 2026-08-12: paper
  filings exist and are invisible to the export (see the Phase 6 Campos 496
  case above). Candidate committees all e-file, so the direct side is safe;
  outside spending is not. If a qualifying
  candidate has such a gap, disclose via `direct_coverage_note`
  (field exists in `ballotLookupFinanceShared.ts`; Georgia uses it).
- Filing lag: totals are as of `reported_through`, surfaced in UI.
- CARS (risk register, not v1 work): SOS's CAL-ACCESS replacement lands after
  the Nov 2026 election; no evidence it changes this vendor's local export.
  Keep parsing behind one interface; revisit when the vendor announces.

## Reuse beyond San José

- **San Diego (same vendor, near-drop-in)**: `efile.sandiego.gov` verified
  2026-08-10 with the identical Bulk Export (XLSX CAL 2.20, 2018–2026).
  A San Diego module = `efileCalFinance` agency config + its own eligible
  offices/GEOID + resolver quirks. Council districts 2/4/6/8 are on the Nov
  2026 ballot. Recommended fast-follow.
- **NetFile jurisdictions (future, different client)**: most CA local
  agencies (Oakland, Berkeley, Sacramento, Fresno, Santa Clara County, …)
  expose CAL-format public exports/APIs via NetFile. Same parser core,
  different transport. Build only when a covered city has roster candidates.
- **Other states: no reuse.** CAL is California-only.


## San Jose finance gaps — 2026-10-24 implementation plan before code

Scope gap_repair_only; broad goal ACTIVE after San Diego PR1642 delivered/all CIgreen. Worktree /Users/shu/.codex/worktrees/7a4e/voteApp, clean code branch codex/san-jose-finance-gaps from current origin/main ad2922159d20a59a5b2baaf6e885c8f7d101d4f1. SD PR1642 remains separate/unmerged. No SJ application edits or financial writes yet. Keep Kansas donor names/all new Missouri/all new Wisconsin publication held. No prod, merge/deploy, env files, AI/provider calls, automation, new agents or external messages. Financial data only RAM, genuine whole private originals, application cache and local DB; no financial extracts/masks/per-record hashes/screenshots.

Ranking: San Jose is the next remaining eligible local cohort, six current canonical runoff contexts/six active links. Previous audit found Louisiana/NewJersey/Houston/NYC zero within their supported current canonical windows; these require a fresh complete eligibility audit after SJ, never a universal absence claim.

1. IE publication and wiring: official https://efile.sanjoseca.gov/ publishes 2025/2026 CAL XLSX, S496 and spender ScheduleD IND rows. Existing shared bulk loader/per-candidate sync/batch already acquire/call outside aggregation. Current contract06 audit over all six contexts finds zero eligible D targets suppressed by another 496 target and zero newer D amount/stance disagreement lost to existing source preference. All current candidate office/jurisdiction/district/direction veto counts are zero. The one native-zero context has no qualified D targets; this is current e-filed scope, not a paper/late/statewide absence claim. Keep SJ outside algorithm intact; do not copy SD dual-identity behavior without source evidence. Include actual shipped paper supplements (if any match the selected control) in later real ordinary proof, not a private empty override.

2. Donor publication and current gap: ScheduleA Entity_Cd identifies COM recipient committees, PTY parties, SCC small contributor committees; native Cmte_ID is the reported giving committee ID. IND/OTH and committee-shaped names alone are insufficient. Main's shared parser currently omits Cmte_ID; SD PR1642 adds an optional field but SJ must work independently from main, using the same minimal optional parser addition and compatible regression rather than importing unmerged SD code. Add SJ-only gross positive, non-memo canonical ScheduleA typed cash, excluding the same receiving account ID/labels, unitemized, C noncash, B1 loans and standalone497 duplicate notices. Reported names/IDs are not independently verified registry identities and are not net/allPAC money. Do not claim broader own-account ownership without registry proof. Preserve equal gifts with distinct native occurrences; reject native occurrence collisions, signed identified cash, invalid dates/types/IDs and source count/cent/scope mismatches.

3. Actual source qualification and largest-control conflict: ordinary default-client acquisition saved six complete genuine native responses, two full workbooks; strict parser passes 5,071 summary/24,768 A/33C/77B1/85D/270S496/19S497 rows, zero unusable. Highest preliminary cash47gifts/36labels/$34,450 has overlapping canonical periods. Focused audit04 proves its overlap is NOT one shared amendment root: different native roots/start/end, consistent source metadata, zero shared native receipt IDs. No evidence permits discarding either filing or changing canonical chain selection. Keep this amount unqualified until parent/period accounting review; do not fabricate deduplication, silently publish it or write zero. New cash aggregation must hold overlapping canonical periods. A fully clean positive context has7canonicalfilings/356ScheduleArows/22typedgifts/16preliminarylabels/$14,800, no direct violations, two native outside groups. Private selector now explicitly chooses the highest positive context with zero direct violations. Counts/identity may change only under final native ID grouping; all final groups must be independently reconciled before writes. Clean control is proof of the implementation, not resolution of the largest conflict.

Implementation baby steps: optional shared parser donor ID; SJ-only canonical typed cash aggregator with a non-overlapping-period gate; source/uncapped donors in new migration388 after fresh local ledger/schema preflight (all411 prior rows including applied387 are immutable, although387 is absent from current main). Source controls receiving FPPC ID, canonical filing count, cents/gift/group counts, reported-through, office/seat and observation clock. Atomic complete snapshot, optional omission preserves existing cash evidence, full-precision older observation rejection after link lock. Default-off SAN_JOSE_REPORTED_COMMITTEE_CASH_ENABLED under existing master; reader verifies current canonical identity, eligible jurisdiction/office/seat and unique receiving ownership, closes all groups before existing classification/caps, unknown Not yet sorted, explicit gross/source coverage. Shared threshold/caps and UI shape stay intact. No changes to direct period accounting or IE source preferences are authorized by current evidence.

Deadlines confirmed from official city election page, calendar and live current publisher code (Oct12/2026 version). Calendar https://www.sanjoseca.gov/home/showpublisheddocument/124637/639062508219330000 gives Sep24/Oct22 Form460 deadlines, Oct22 throughOct17, Feb1/2027 semiannual. SJMC12.06.910(G) at https://library.municode.com/ca/san_jose/codes/code_of_ordinances?nodeId=TIT12ETOPGOPR_CH12.06MUCAOFAC_PT9CADI requires third statement noon on day before election, closing23:59 day before it is due: derived Nov2noon/Nov1close for Nov3runoff. Calendar's Nov3 primary label and third-report closing text conflict; follow explicit code rule, do not adopt those descriptions or SD Oct30. Manual re-acquire now/Oct26, Nov2afternoon, Nov3/4, Feb2/4 and later amendments. No automation; keep normal historical/current date guards.

Evidence: live official election page https://www.sanjoseca.gov/your-government/appointees/city-clerk/elections/2026-elections-primary-and-runoff confirms Council5/7/9 runoff and directs to current portal/code. FPPC Form460 https://www.fppc.ca.gov/siteassets/documents/tad/forms/campaign/460.pdf defines donor types and ScheduleA monetary basis. Native source originals and audits02/03/04/05/06 remain private. City page/Municode Web access limitations resolved in Chrome; owned legal tab940577026 closed. No source absence inferred from Web403.

Required before PR: independent whole-original Python/Decimal reference for every uncapped donor name/reportedID/type/key/cent/gift occurrence and every native/paper IE group/stance/amount/source, direct headlines/balances and source counts; ordinary default-client fresh local sync without financial/clock/writer injection; business repeat/no duplicates, controlled source-failure all-table/full-clock retention, unrelated context preservation and migration immutability; actual production HTTP/default-off and hydrated fresh-reload candidate card. Focused tests plus shared parser/SD compatibility (SD base tests when its PR unmerged), backendTSC/diff; close owned tabs/servers and enforce0700/0600. One neutral SJ PR, attach it and finish CI. Largest overlapping context remains explicit unresolved_conflict, not claimed fixed.

### Reported committee cash implementation and local proof — October 24, 2026

Added gross positive non-memo canonical Schedule A COM/PTY/SCC receipts, preserving native donor IDs and distinct gift occurrences. Source counts, cents, receiving account, office/seat and observation clock are stored atomically with the existing snapshot. Invalid or overlapping canonical periods abort before any financial write; the larger $34,450 preliminary context remains `unresolved_conflict`, not a qualified donor total. Existing direct accounting and S496/Schedule D source preference are unchanged. The new reader closes every uncapped stored group before classification/display caps, checks current candidate identity and receiving-account scope, and is default-off behind `SAN_JOSE_REPORTED_COMMITTEE_CASH_ENABLED` under the San José master flag.

Real ordinary default-client local sync, repeated with fresh complete sources, passed for one clean current candidate: seven canonical filings, 356 Schedule A rows, 15 reported committee groups, 22 gifts, $14,800 cash; raised $59,135, spent $54,229.70, cash $9,331.82, debts/loans $4,000 each. Two outside groups total $3,624.72 support and $5,664.24 opposition, reported through October 17. Independent Python/Decimal parsing of both complete native workbooks matched every uncapped donor name/reported ID/type/key/cent/gift count, every IE group/stance/amount/count, and all direct headlines. The reference separately implements San José's S496 preference. Ordinary sync used the shipped paper supplements; none added a qualifying expenditure for this control. No source, clock or writer substitution was used for successful imports.

Business re-import is stable, unrelated San José snapshots remain unchanged, and controlled source-fetch failure preserves all seven tables and full-precision clocks. Official migration runner applied only 388; all 411 prior ledger records, including separately applied 387, retain their filenames/checksums/timestamps. Migration 388 is now immutable. Actual production HTTP returned 200, matched the store and hid the new component with its flag off. Actual hydrated candidate page, follow-dialog interaction without account/follow submission, finance/interest disclosure expansion, donor links and fresh reload passed. Five capped donor details are shown; all 15 were checked independently. The unchanged $5,000 threshold displays opposition and hides the smaller support direction; both groups remain present and verified in API/store. No shared UI/threshold/cap changes.

280 focused tests across 24 files (San José, shared efile parser/client, San Diego compatibility), backend TypeScript and diff checks passed. Both owned browser tabs closed and financial browser buffers cleared. Previews are local/read-only and will be stopped before delivery. Initial preview configuration pointed SSR at the default port; correcting only the explicit private API URL resolved it. Transient browser deadlines were resolved from observed page state. Guard denials were technical preview startup constraints, not approval-review rejections; no environment files or remote services were accessed by previews.

Manual re-acquisition: after October 22 (now/October 26), November 2 afternoon after the noon third-statement deadline (coverage through November 1 at 23:59 per SJMC 12.06.910(G)), November 3–4, February 2–4 after the February 1 semiannual deadline, and later amendments. No automatic follow-up created. Kansas donor names, all new Missouri publication and all new Wisconsin publication remain held. No production changes, merge or deployment. Finish this PR and its checks, then pause; no further source starts in this unit.
