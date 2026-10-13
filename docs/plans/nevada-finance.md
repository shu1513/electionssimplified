# Nevada campaign finance — implementation plan

Status: **Phases 0-3 DONE (Phase 2 run 2026-08-27: 95/108 candidates imported
into the local DB; harvest gotchas + unlinked list in the feasibility doc
Addendum 5. Phase 3 ship 2026-08-27: flag in `backend/.env` + `render.yaml`,
NEVADA_AURORA display label + portal home URL in `packages/api-client`,
ballot-page spot-check green — prod promotion tracked in the memory topic).** Phase 0: fixtures in
`backend/tests/fixtures/nevadaFinance/` (5/5 reconciliation exact). Phase 1:
migration 258, `backend/src/pipeline/nevadaFinance/` (CSV + report parsers,
selection, cycle builder, aggregator, resolver, writer, loader), CLIs
`nevada-candidates:finance:auto-link` / `:import`, 26 tests. Note: the shared
loader publishes `direct_contribution_total` as the displayed total_raised;
since PR #912 the import stores donor money (lines 1+5+7) there and the
official line-8 gross in `total_receipts`; the itemized CSV sum stays
internal to the reconciliation gate. Next: prod promotion (runbook steps in
the memory topic), then Phase 4 Oct refresh.
Feasibility detail in `backend/docs/nevada-campaign-finance.md`.

## Scope and non-goals

Ship for Nov-2026 NV races filed with the SOS jurisdiction (statewide,
legislature, state judicial — **195 filers for election year 2026**):

- total raised, total spent, cash on hand (official report-summary lines)
- itemized direct-donor lists, contribution-size buckets
- industry breakdowns for **entity donors only** (label: "industries among
  identifiable organization donors"; ~39% of dollars on the single Governor
  fixture — not a statewide coverage estimate), via the existing donor/industry
  classifier

Source coverage limits (never synthesize missing fields):

- donor occupation/employer: NRS 294A collects name + address only
- candidate-level outside spending and support/oppose: reviewed C&E expense
  schedules identify vendors and amounts but do not establish allocated
  candidates and stance. This is an integration coverage gap, not proof that
  Nevada never publishes those details. Outside totals remain unknown until
  target, direction and allocated amount are verified. Federal NV races keep
  the FEC path. See `plan-nevada-finance-gaps.md` for the current donor-only seam.
- county/city-jurisdiction filers (values 1–35 in the jurisdiction dropdown):
  deferable; same system if wanted later.

## Source facts the design rests on (all verified live)

- One system: AURORA search at
  `https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx`.
  Plain WebForms POST with `search_type` = `#individual_search` /
  `#group_search` / `#contribution_search` / `#expenditure_search`.
- **Imperva WAF blocks every non-browser client** (curl and Node fetch get the
  212-byte `_Incapsula_Resource` challenge; cookie replay from a challenged
  response does NOT unlock — verified). Page-context `fetch` in a real browser
  works. So raw acquisition is a **browser-session harvest**, not a server sync.
- Transaction searches accept a **date-only query** (no name) and an
  "Export Results to CSV Only" checkbox that returns `text/csv` from the POST.
  Result cap: June 2026 statewide = 4,322 rows OK; Apr–Jun = "too many
  results" (cap also applies to CSV mode). **Month slices work; halve on cap.**
- CSV columns — contributions: `Contributor, Date, Amount, Type, Recipient,
  Report`; expenditures: `Payee, Date, Amount, Type, Payer, Report`. No
  address, no category, no IDs. Amounts `"$5,000.00"`, dates `M/D/YYYY`.
- **Amendments replace**: transaction search returns only the amended report's
  rows (two fixtures: Lombardo 2022 Q3, Hansen 2024 Q4). Report *lists* on
  detail pages show both versions — totals must pick one document per logical
  report, never both.
- `Report` values are filer-typed display names: `2026 CE Report 2`,
  `… (Amended)`, `… (Legal Defense Fund)`, `… (Amended, Legal Defense Fund)`,
  annual filings, and junk like `Tick`. Treat as opaque strings; the only
  parsing is the `(… Legal Defense Fund…)` suffix (exclude those rows/reports).
- Individual search with `ddlJurisdiction=36` ("NV SOS", numeric option
  values) + `ddlElectionYear` returns the roster grid (Name | Party |
  Jurisdiction, 25/page) with `CandidateDetails.aspx?o=<token>&y=<year>`
  links. The detail page adds Office **with district** ("State Assembly,
  District 32") and the report list with `ViewCCEReport.aspx?syn=<token>`
  links. `syn` tokens are stable across sessions (23-day-old links still
  resolve); `o=` token stability unverified — re-resolve by search.
- Two relevant report layouts observed (recall-committee and other niche forms
  unprobed): candidate form = $100 threshold, summary lines 1–13
  (7 = unitemized ≤$100 aggregate, 8 = total raised, 12 = total spent,
  13 = ending fund balance). PAC/IE/party form = $1,000 threshold, lines 1–8,
  **no unitemized line, no balance line**. Candidate cumulative column starts
  at CE#1 (Jan 1 of election year) — it does NOT include prior-year money.

## Architecture (clone New Hampshire, swap the transport)

Reuse the NH module shape end-to-end; the only novel part is that artifacts
are harvested by a Claude browser session instead of `fetch` in the refresh
script.

1. **Artifacts** under `scratch/nevada-campaign-finance/aurora/` with sidecar
   metadata JSON (mirror `newHampshireCfsArtifactCache` conventions):
   - `contributions/YYYY-MM.csv` and `expenditures/YYYY-MM.csv` — statewide
     month-sliced date-only CSV exports (split `a`/`b` halves when capped)
   - `candidates/<election-year>/roster.json` — paged individual-search grid
     for jurisdiction 36 (name, party, detail token)
   - `candidates/<election-year>/<candidate-key>/reports.json` — detail-page
     office/district + report list (name, file date, `syn` token)
   - `reports/<syn-hash>.html` — raw `ViewCCEReport` pages for linked
     candidates' non-LDF reports
   The harvest procedure is a documented page-context JS loop (the exact POST
   bodies are in `backend/docs/nevada-campaign-finance.md`) run from a Claude
   session with the browser pane; files land via Bash. No scheduler, no WAF
   games server-side.
2. **Pipeline** `backend/src/pipeline/nevadaFinance/`:
   - artifact reader/validators (CSV header + month coverage checks)
   - report-summary parser (both form layouts; picks the amended document when
     a `(Amended)` sibling exists for the same logical report)
   - candidate resolver: VoteApp roster → individual-search roster by
     normalized name, confirmed by office + district read off the
     **Year-matched report rows** on the detail page (the profile Office is the
     filer's current seat, not the candidacy — Cannizzaro fixture); ambiguous
     names (2+ AURORA matches) stay unlinked
   - direct-contribution aggregator: month CSVs filtered to
     `Recipient == linked filer name`, LDF rows dropped; buckets +
     entity-donor industry labels (existing classifier, `labelType:"donor"`);
     **skip breakdowns entirely for a candidate whose filer name is not unique
     in the cycle's CSVs** (name is the only join key). Implemented as far as
     the data allows: same-year duplicates explode at roster read (slug
     collision), and in-window rows citing only report years outside
     electionYear-1..+1 quarantine the candidate (cross-cycle same-name
     collision). A same-cycle same-name filer outside the harvested roster is
     undetectable from CSV data; residual exposure is breakdowns-only (totals
     come from report covers) and bounded by the reconciliation ceiling
   - summary builder: raised/spent = Σ per-report "This Period" lines 8/12
     (candidate form) across the cycle window (Annual filings + CE#1–4),
     picking the latest effective version per covered period, LDF excluded;
     cash = line 13 of the report covering the **latest period end** (latest
     version of that period — NOT the newest file date; a late amendment to an
     old quarter can be the newest filing). Line 8 is the state's official
     "Total Amount of All Contributions" and includes loan-type lines 2/3 (and
     invisibly, loan-flagged rows inside line 1; the CSV has no loan flag) —
     see the Phase-2 loan gate. Never read the cumulative column as a
     cross-year total (it restarts at CE#1 each election year).
   - snapshot writer via `createStandardStateFinanceSnapshotWriter` into new
     `nv_candidate_finance_*` tables (one migration, NH-shaped); outside-group
     tables created but never populated
3. **Read side**: `nevadaBallotLookupFinanceLoader.ts` registered in
   `src/pipeline/address/ballotLookup.ts`, flag
   `NEVADA_CAMPAIGN_FINANCE_ENABLED` (free read-side flag → ON in
   `backend/.env` + `render.yaml` once data exists), eligible-offices module,
   coverage note: "Nevada does not collect donor occupation or employer;
   industry breakdowns cover identifiable organization donors only, and
   contribution-size buckets cover itemized transactions only (truly
   unitemized ≤$100 money stays in totals). Candidate target and
   support/oppose direction are not available in Nevada SOS report data.
   Coverage is the searchable electronic filings only (NRS 294A.3733 exempts
   some small filers; pre-2004 and paper filings are out of scope)" — an
   unmatched or exempt filer renders as "no filing found in the electronic
   system", never $0.
4. **CLI** (npm scripts, matching house naming):
   - `nevada-candidates:finance:import` — read artifacts, aggregate, write
     snapshots (idempotent, `--dry-run`)
   - `nevada-candidates:finance:auto-link` — roster resolver with report
   No sync-due/scheduler scripts: refresh cadence is quarterly filings, run by
   hand after each deadline.

## Phases

**Phase 0 — fixtures, no product code. [DONE 2026-08-26]** Both questions
answered (annual filings self-contained, period==cumulative; CE chain restarts
yearly; CSV gate = lines 1+5 ≤ Σ ≤ 1+5+7 because filers may itemize ≤$100
rows) and reconciliation exact 5/5 — see the feasibility doc addendum 3 and
the fixtures README. Original scope: harvest one month of CSVs + five
candidate report sets (Governor, AG, one Assembly, one state Senate, one
judicial; include one amended report and one LDF filer). Answer the two open
semantics questions with fixtures: (a) Annual CE Filing summary columns
(period vs cumulative meaning) so the cycle-window sum is provably right;
(b) confirm summary-vs-CSV reconciliation on all five (expect: CSV Σ = lines
1+5, gap = line 7). Output: fixture files checked into the repo test dir +
a short findings note appended to the feasibility doc. Exit: reconciliation
exact on 5/5.

**Phase 1 — PR: schema + pipeline + tests.** Migration, readers, parsers,
resolver, aggregators, summary builder, writer, loader, flag, CLIs, vitest
coverage driven by the Phase-0 fixtures (including: amended-pair selection,
LDF exclusion, dual layout, ambiguous-name skip, cap-split month files).

**Phase 2 — full harvest + local run.** Cycle window artifacts (monthly CSVs
2025-01 → current, both kinds ≈ 40 files; roster + report lists for the 195
filers; report HTML for linked Nov-2026 candidates), auto-link with per-link
report, import, gates below. Local DB only.

**Phase 3 — ship.** Loader flag ON locally, spot-check ballot pages, then the
standard prod checklist (migration → data promotion → env flag in render.yaml
+ Render env, manual deploy per runbook).

**Phase 4 — Oct refresh.** After the Oct 15 CE#3 deadline (covers through
Sep 30): harvest new months + new reports, re-import, re-promote. Same by-hand
run; CE#4/annual lands Jan 15, 2027 (post-election, optional).

## Validation gates (import refuses to write on failure)

- per-candidate: Σ itemized CSV (non-LDF, monetary+in-kind) within
  [Σ lines 1+5, Σ lines 1+5+7] for the same window (filers may itemize ≤$100
  money, so unitemized line 7 is the allowed slack); expenditure CSV sum
  within [Σ lines 9+10, Σ lines 9+10+11]; else quarantine the candidate
- every linked candidate: office + district + year matched exactly; name
  unique in AURORA roster
- month coverage: contiguous month files spanning the cycle window, each
  either uncapped or fully split
- no occupation-labeled output anywhere; no outside-group rows anywhere
- Phase 2 additionally: locate ≥1 loan-flagged filer among Nov-2026 candidates
  (schedule checkbox / summary lines 2–3 nonzero); if loan money is material,
  decide the totalReceipts treatment before shipping — otherwise record
  "immaterial for this cycle" in the run notes

## Open items (tracked, not blocking)

- `o=` candidate-token stability across sessions (works around it by design)
- optional email to NV SOS: sanctioned bulk route ("Bulk Data Download" exists
  behind account login) and whether any nonpublic candidate-target/stance
  field exists (NRS 294A.210 doesn't require one — expect no). A bulk account
  would replace the CSV harvest but changes nothing downstream.
