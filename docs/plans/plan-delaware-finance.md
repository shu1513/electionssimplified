# Delaware Campaign Finance Plan

## October 11, 2026 finance-gap work

This section supersedes historical outside-allocation, PDF-footer-version and
election-day-window conclusions below. One Delaware PR will extend the existing
adapter for verified committee donors and explicitly allocated third-party
expenses. Implementation and normal local sync proof remain pending.

Reference: Pennsylvania's saved-page-first batch acquisition, direct committee
classification, migration 322 and uncapped donor totals before display caps.
Delaware's reported `Political Action Committee`/`PAC` contributor types supply
primary class authority; retain verified registry identity/class separately.
Name hints alone cannot promote business/group/labor-union donors. Unknown
interests stay “Not yet sorted”; committee gifts do not increase Raised twice.

Fresh research witnesses, pending replay through the normal sync:

- Carlie Carey: 57 native/CSV receipts, current cover $25,215.80, five reported
  PAC checks of $600 ($3,000); 19 outgoing native/CSV expenses = $3,870.82. Genuine
  full source brackets and all five legal donor registry identities agree.
- Jennings: full applicable 2023–2026 cycle, 819 unique native receipts. One
  exact repeated ID at a page boundary is transport overlap; distinct economic
  occurrences remain. Primary 30-Day separately publishes a $1,240 under-$100
  Schedule A aggregate absent from both itemized exports. Retain that real
  control without invented gifts/counts. `Electronic Fund Transfer` is a current
  cash label; `Refund/Rebate` must follow actual Schedule A/cover semantics,
  without assumed reimbursement or donor-return classification.
- THE STATEHOUSE FUND: current financial Schedule B explicitly assigns $499,015
  to support Kathleen Jennings, Attorney General, Democratic. Full cover:
  $525,000 receipts − $499,015 expenses = $25,985. Native category = `Other Expenses`,
  not source-coded IEC. Exact receiving-committee affiliation bridges Friends
  of Kathy Jennings; no generic nickname alias. SO alone never allocates.
- Actual owner, calendar, filename GUID and current/all-version inventory govern
  report identity. Repeated footer `Document:14904 Version:1` is a template
  label; current-view `2099 Annual` is a placeholder. Neither proves financial
  scope/currentness. Native IDs/full fields and fresh source brackets are needed.
- Receipts initialize at `/Public/ViewReceiptsMain`, then search POST to
  `/Public/ViewReceipts`. Expenses need actual `CommitteeType`/`FilingYear`
  selects and blank selects; old `*Data` containers alone returned empty while
  the correct public search returned 456 rows. Third-party funder exports use
  `/Public/ExportCSVNew_TP` with a separate eight-column contract. Their literal
  `Filed Reports` value `Other` is not the native event-period identity.

Reuse existing restricted atomic acquisition/cache, parsers, sync and shared
transactional writer hook. First preserve omitted outside amounts/groups on
direct refresh. Positive components require full cash/refund/control/currentness
and exact local ownership proof. Saved artifacts retain original times; closing
sources must be freshly acquired. Missing/failed components retain stored money.
No global outside zero, 2026-only Jennings subset, Original-only workaround,
economic dedupe or manually inserted canonical money. Migrations 331–333 remain
reserved; add the next file only after verifying numbering. Ordinary fresh
local CLI row counts, candidate amounts and reader output are required before PR.

Immediate inventory correction: the legacy cover-only sync may accept a sole
document for a filing calendar under either Original or Amended. It must reject
multiple editions until full financial/current-pointer proof resolves them.
Footer version values remain optional descriptive metadata and never choose an
edition. This conservative gate runs before writes and preserves old snapshots.

Source facts and candidate packet transport are now implemented; accepted-money
composition, persistence, reader wiring and normal fresh sync proof remain open.
Complete candidate PDF facts retain anonymous controls and outstanding debt:
Jennings has three outstanding loans totaling $34,000, with no current payment.
Some anonymous controls already have distinct native aggregate rows; the $1,240
Primary 30-Day control does not. Bind each representation before adding totals.
Reported candidate-committee transfers stay distinct from political committees
eligible for the PAC card. Do not force final totals to the initial PAC scout.

Independent cycle witnesses are the [official 2022 statewide result](https://elections.delaware.gov/reports/GE2022.html)
and [official 2026 General ballot](https://elections.delaware.gov/elections/general/sampleballots/GE2026/15-10.html).
Their full raw source facts confirm the same named candidate and Attorney General
office; the final verifier must bind them to CF01 identity and the statutory case.
Do not infer historical office from today's office label on old report rows.

### Deadlines and mandatory fresh reruns

[Official 2026 calendar](https://elections.delaware.gov/public/calendar/pdfs/2026CampaignFinanceReportingPeriods.pdf):
General 30-Day through October 4, due October 6, 2026 at 11:59 p.m.; General
8-Day through October 26, due October 28 at 11:59 p.m.; annual through
December 31, due January 20, 2027. Acquire fresh sources after the already-passed
October 6 deadline, again October 29, and January 21, 2027. Third-party event
filings have 48h/24h windows: fresh daily checks through election and immediate
post-election followup. Late filings remain open coverage; no automation created.

[§8002(11)a/d](https://delcode.delaware.gov/title15/c080/sc01/index.html) ends
the applicable candidate/third-party cycle on December 31; a4 is a contribution-limit
split. Keep statutory `windowEnd` separate from `publishedThrough`.
[§8030(g)](https://delcode.delaware.gov/title15/c080/sc04/index.html) permits
eight-day expense detail deferral; timely reports cannot establish full absence.

Selection implemented: `--candidate-id UUID`, `--election-year 2026`, `--refresh`,
`--lookback-days 100`. Scope and refresh apply before SQL LIMIT; scoped runs skip
unrelated autolink. `--force` enables source/write flags, not due refresh;
`--refresh` bypasses staleness, not source authorization. January 21 requires
the 100-day lookback (79 days after November 3). Eligible-link rules still exclude
lost/withdrawn candidates; this is not full historical coverage.

Once full source verification is integrated, mandatory fresh rerun form:

```sh
DATABASE_URL='postgresql:///voteapp?host=/tmp&connect_timeout=5' AI_API_CALLS_ALLOWED=false DELAWARE_CAMPAIGN_FINANCE_ENABLED=true npm run delaware-candidates:finance:sync-due -- --election-year 2026 --refresh --force --write --no-auto-link --max 100 --lookback-days 100 --cache-dir /absolute/restricted/cache
```

Use this after October 28 and January 20 deadlines; increase/process the eligible cohort
until every due scope has an explicit result. Current positive-component proof
and ordinary sync validation remain pending. Dry-run omits `--write` and never
acquires or writes; it only inspects existing cache. Never fake time or
last_synced_at. Flags stay inline, never in `.env`. No production, providers,
deployment or automatic reminders.

## Historical initial adapter plan

Written 2026-08-26 after a live curl probe of the Delaware CFRS portal (session flow, receipts/expense/committee/filed-report searches, CSV exports, two TP report PDFs) cross-validated against an independent 2026-08-03 feasibility report. Revised the same day after an external review round; every adopted correction below was re-verified against the live portal, the statutes, or the code before adoption (2026 candidate lists, § 8002(11)/§ 8004/§ 8032 text, shared writer/loader field shapes, CSV vs grid-JSON column sets, clean-URL ShowReview fetch, the `*_RAW_DATA_REFRESH_ENABLED` house flag pattern). Feasibility doc with raw endpoint details: `backend/docs/delaware-campaign-finance.md` (currently uncommitted — the Phase 0 PR commits it). Verdict: **GO for direct finance — Phase 0 first.** Occupation: **published from disclosed values only** with a coverage note; employer text stored but never published; no industry classification (see hard fact 1). Candidate-targeted outside totals: **no v1 phase exists** — registration-level stance is real but the expenditure→candidate edge is missing; outside fields publish as `null` with a coverage note, never `$0`.

Scope: CFRS covers Delaware state and local filers. The Nov-2026 CFRS cohort is **state statewide races — Attorney General, State Treasurer, Auditor of Accounts (all three confirmed on the official 2026 general candidate list) — plus General Assembly (all House, ~half Senate) and county offices**, with municipal/school elections available later. Federal races (US House, US Senate) use the FEC path. The statewide races are the highest-value CFRS targets and must be in the Phase 2 cohort.

## Verified sources (probed live 2026-08-26)

### Access reality: open portal, session-bound searches, full-result CSV exports

`cfrs.elections.delaware.gov` — PCC/CRIS family (Maryland's *old* MDCRIS platform; **not** the Civix bulk API Maryland uses today, so `marylandCfsClient` is not reusable). Classic ASP.NET MVC + Telerik grids. No auth, no CAPTCHA, no WAF; plain curl worked on every request. Mechanics that shape the client:

1. **Session flow**: cookie jar mandatory. POST the search form, then GET the matching CSV export in the same session — the export streams the **full result set** of the stored search (Meyer receipts: 7,425 CSV rows matching the page's `total:7425` exactly). Because the search result is *session state*, concurrent searches in one session can clobber each other's exports — see the acquisition design below (single-flight, atomic search→export pairs).
2. **Every form field must be posted** (blank if unused) or the server answers the literal `Unable to process the request.` — parsers treat that string (also its `alert(...)`-wrapped variant some endpoints emit), and any HTML-instead-of-CSV body, as fail-closed.
2b. **The CSV exports are NOT RFC CSV**: fields are never quoted and never contain commas/newlines; a double quote is literal data (`Kevin O"Connell`). Parse by literal line/comma split with a fixed field count — an RFC parser corrupts on the stray quote. Statewide-scale caveat: the 2024 full-year export returned 36,605 rows vs the grid's `total:36718` (delta 113, full Jan–Dec coverage, no truncation signature); per-committee exports matched their totals exactly, and per-committee is the adapter's access pattern.
3. **Endpoint quirks (all verified)**: expenses search POSTs to `/Public/OtherSearch?theme=vista` (NOT `/Public/ViewExpenses` — that 302s to `HandleUnknown`); TP mode needs `chkTP=3&hdnTP=1` (`1`, not `"on"`); amount-range filters return `total:0` even for valid ranges — never use them, filter client-side; the grid JSON endpoints (`_ViewReceiptsCustom`, `_ViewExpensesCustom`) page fine but their `total` field is unstable garbage — CSV is the source of truth. **The results page also renders `total:0` transiently on a valid search** (observed twice live 2026-08-27, per-committee and statewide, while the stored search stayed intact and the export streamed the full set) — the acquisition layer must re-POST the search when the rendered total is 0 and never treat a transient 0 as an empty result.
4. **CSV vs grid JSON carry different columns.** The CSVs have **no row id and no version column**. The grid JSON rows additionally carry a stable internal `Transaction_id` and a **`FileAmendedVersion`** string (e.g. `02 Jan 2024 Version 0.0…`) — so any per-row version/identity work goes through the JSON or through report-scoped searches, never the CSV alone.

### Receipts (`POST /Public/ViewReceipts?theme=vista` → `GET /Public/ExportCSVNew?...`)

CSV columns (pinned from the live export): Contribution Date, Contributor Name, Address Line 1/2, City, State, Zip, Contributor Type, Employer Name, Employer Occupation (voluntary free text — 23.88% of 2024 individual rows disclose it, hard fact 1), Contribution Type, Contribution Amount, CF_ID, Receiving Committee, Filing Period, Office, Fixed Asset. Data back to ~2003; statewide 2024 = 36,718 rows. Contributor Type taxonomy observed live: Individual, Corporation/Partnership/Other Entity, Business/Group/Organization, PAC, Out-of-State or Federal Committee, Candidate Committee, Self (Candidate), Dem or Rep National Sub-Committees, Labor Union, and the aggregate row type **`Total of Contributions not exceeding $100`**. Contribution Type includes Check, Credit Card, EFT, Cash, In-Kind, Candidate Loan, Other Income, and the same aggregate marker.

### Expenses (`POST /Public/OtherSearch?theme=vista` → `GET /Public/ExportExpensestoCsv?...`)

CSV columns: Expenditure Date, Payee Name, Payee Address Line 1/2, City, State, Zip, Payee Type, Amount($), CF ID, Committee Name, Expense Category, Expense Purpose, Expense Method, Filing Period, Fixed Asset. Meyer for Delaware: 1,254 rows, $3,388,153.05.

### Committee registry (`POST /Public/Search?theme=vista` → JSON `POST /Public/_ViewCommittees?theme=vista`)

Full registry JSON per row: `MemberID` (internal portal key used in artifact routes), **`Committee_Id` = the public CF_ID** (verified populated, e.g. `04006155`), CommitteeName, CommitteeTypeCode (**01 candidate, 02 PAC, 03 political, 04 3rd Party Advertiser, 05 certificate of intention**), OfficeSought, DistrictName, County, status, registered/amended dates, treasurer. 71 type-04 committees all-time. Registrant autocomplete: `GET /Public/FindRegistrants?q=<name>` → `Name(Status)|MemberId`.

### Filed reports (`POST /Public/ViewFiledReports?theme=vista`; PDFs at `GET /Public/FiledReports?FileName=…&CommitteeID=<memberID>&FilingCalendarID=…`)

Report PDFs are **generated, text-extractable documents (not scans)**. Page 2 = STATEMENT OF ACCOUNT BALANCE (beginning balance, receipts, expenditures, ending balance, value of non-cash assets); schedules carry GRAND TOTAL lines including the `not exceeding $100` aggregate. **Unlike Missouri (reCAPTCHA-walled covers), DE covers are freely reachable → cover reconciliation is possible and required** (hard fact 2). Meyer: 20 report rows including multiple amendments — some amending the **same** filing period, so filed-date sorting alone cannot pick the current version; the canonical version per period is the **highest PDF-footer `Version:` per `FilingCalendarID`** (the search page's "View Current Report" control is NOT per-period — it returns only the single most recent report; hard fact 3).

### TP statement of organization (`GET /Public/ShowReview?memberID=<id>&memVersID=<v>&cTypeCode=04&ftype=SO&fpath=`)

Renders an **Affiliated Candidate Information** table: candidate committee, candidate name, office, party, **Position = Support | Oppose**, status. Verified: Citizens for a New Delaware Way (memberID 642221, CF 04006103) = Oppose Bethany Hall-Long / Support Matthew Meyer, both Gov 2024. (The portal's own links embed stray spaces before the `&`s; a clean, properly-encoded query returns the byte-identical page — build URLs with `URLSearchParams`, and keep a clean-vs-portal-link parity check in the probe.)

## Hard facts that shape the design

1. **Occupation/employer: voluntary, partially populated — REVISED by the Phase 0 run (2026-08-26).** 15 Del. C. § 8030(d)(2) requires contributor name, mailing address, aggregate, amount, date — no occupation/employer (HB 291's requirement was deleted by HA 2 before the 10/23/24 signing). But the statewide 2024 export shows the fields are NOT dormant: **6,681 of 27,974 individual rows (23.88%) carry Employer Occupation** and 5,211 carry Employer Name — filer-voluntary free text, wildly uneven per committee (Meyer for Delaware: 0 of 6,939 — the earlier "dormant" verdict came from that committee alone; the coded-dropdown searches undercount because they filter on the 29-code taxonomy, not the free text). v1 decision: **publish the occupation breakdown from non-blank values, verbatim, with the shared direct-breakdown coverage note** stating Delaware does not require occupation and charts reflect disclosed rows only. A committee with zero disclosed occupations naturally renders no chart. Employer text stored, not published. No industry classification of occupation text, ever. The sync keeps the non-blank-rate counter as a drift diagnostic.
2. **Money model — one explicit mapping onto the existing contract (no new fields).** The standard writer already accepts `totalReceipts`, `directContributionTotal`, `totalDisbursements`, `cashOnHand`; the loader publishes `total_raised` from `direct_contribution_total` (donor money only — shared-contract rule), `total_spent` from `total_disbursements`, `cash_on_hand` passthrough. Delaware mapping:
   - `total_receipts` = official cover cash receipts (includes non-donor income where the cover does).
   - `direct_contribution_total` = donor contributions: itemized monetary rows + the `not exceeding $100` aggregate rows + in-kind if and only if the cover counts it there (Phase-0 mapping question), signed for returned contributions. **Excludes** Candidate Loan and Other Income rows — those stay inside `total_receipts`, they are not deleted from existence.
   - `total_disbursements` = official cover expenditures.
   - `cash_on_hand` = ending balance of the latest canonical cover (reachable in DE, so publish it).
   - Contribution-size buckets = **positive itemized monetary contributions only** — exclude aggregate rows, in-kind, loans, other income, refunds/returns — with the shared direct-breakdown coverage-note field naming what the buckets don't cover.
   - Refund/negative-row taxonomy (negative rows vs a distinct type) is pinned in Phase 0 before any sign rule is coded.
3. **Amendments: ANSWERED by the Phase 0 run (2026-08-26) — the transaction search returns CURRENT-version rows only** (Nevada behavior): Meyer's receipts CSV ($3,961,664.59 / 7,425 rows) and expenses CSV ($3,388,153.05 / 1,254 rows) both reconcile **to the cent** against the summed canonical covers across all 9 reporting periods. Canonical-per-period selection: group filed reports by `FilingCalendarID` (the filing-period calendar entry) and take the **highest PDF-footer `Version:`** (v1..v5 observed; versions strictly increase per amendment). The grid's "View Current Report" checkbox is NOT per-period — it returns only the single most recent report — so canonical selection comes from the PDFs. The sync still re-verifies the reconciliation on every run (a future mid-amendment fetch window could break it; fail closed then).
4. **Row identity: none invented.** Snapshots are full replacements; rows are a **multiset** (legitimate identical rows preserved). Raw provenance = artifact SHA-256 + row ordinal. Fingerprints (date+name+amount+type+period) are diagnostics/version-comparison aids only — two legitimate identical contributions can share every field, and § 8032 lets some contributors have addresses removed later, so **address never participates in identity**. The JSON `Transaction_id` is used only if amendment resolution (fact 3) requires stable identity.
5. **Cycle windows are statutory cases, not a year filter.** § 8002(11) (verified): elected incumbent → period starts Jan 1 after the last election for that office; appointed/successor incumbent → starts the day of succession/appointment; challenger → starts on the first non-self/non-spouse contribution; and **the primary and general are separate election periods** (primary period ends primary day; next begins the day after). "Filing Period year + Contribution Date" is therefore not a safe window. Candidacy totals are assembled from the **canonical report inventory** (which reports cover the candidacy's election period, resolved per statutory case + office association); a committee spanning offices (§ 8003(a): one committee across elections and offices — Meyer's holds 2022 county-executive and 2024 governor money) never dumps its whole history on the current candidacy. Ambiguous window → no publication.
6. **Cover reconciliation = two identities, chained — not one sum vs one cover.**
   - *Per-report cash identity* (probe gate + sync validation): beginning balance + cash receipts − cash expenditures = ending balance, and each report's beginning balance = prior canonical report's ending balance. Chain gaps mean a missing/mis-selected report — fail closed. **Verified live**: all 20 Meyer PDFs satisfy the identity; the 9 canonical periods are sequential and non-overlapping (annuals cover the gaps between election reports, e.g. 2024 Annual = 10/29..12/31) with a fully continuous chain.
   - *Per-cycle donor identity* (publish gate): the canonical transaction multiset for the window sums to `direct_contribution_total` under the fact-2 classification, cent-exact against the summed cover lines for the window's reports (tolerated difference classes, e.g. in-kind placement, documented explicitly from Phase-0 evidence, not assumed).
7. **Outside stance: registration edge only — no v1 phase.** Verified three ways: (a) TP expense rows (JSON + CSV + PDF Schedule B) carry payee/amount/category, no candidate, no stance; (b) a two-affiliation committee (CNDW: Support Meyer + Oppose Hall-Long) filed one $243,160 report ($228,160 Tusk Strategies + $15,000 Shine Creative) with no per-candidate split — full-report allocation would be inference; (c) an active TP spender (DLGA PAC, 643731) has an **empty** affiliation table while its report shows $90,000 to Fortune Media with free text "Bethany for Governor" in the payee cell — payee text is never parsed as stance. § 8031(a)(2) legally requires naming each candidate per expenditure; CFRS doesn't structure it. v1 publishes outside fields as `null` with the coverage note "Delaware filings do not link each expenditure to a candidate and position" — never `$0`. **No TP database tables and no TP staging module in v1**: TP evidence (SO pages, report PDFs, probe exports) lives in the restricted artifact cache + sanitized fixtures only. Schema appears only if structured expenditure→candidate→position data ever exists; until then a TP schema would be dead tables holding contributor addresses for no product purpose. TP funder data (§ 8031(a)(3), Schedule A rows verified in both test PDFs) is likewise artifact-only until that phase exists.
8. **Absent data ≠ zero.** § 8004 (verified): **school-board candidates and candidates for offices paying under $1,000/year** may certify instead of forming a committee if they expect ≤ $5,000 in receipts/spending (mandatory committee + reports if crossed). A candidate with no CFRS committee gets **no finance link**, not a zero snapshot. Filing cadence (§ 8030: annual, 30-day, 8-day; the 8-day report may defer expenditure detail to the next report) means pre-election sums lag. The shared writer/loader has **no coverage-through field** (`last_synced_at` = fetch time and drives due mechanics — never overloaded); the covered-through date is kept in the DE sync's diagnostics only, and no UI "as of filing period" claim is made for v1.
9. **Privacy.** Contributor street addresses: parsed, used for nothing, **never written to product tables, never logged**. Artifact cache = restricted directory (`0700` dirs / `0600` files), never committed; fixtures sanitized (addresses replaced); bounded response sizes on every fetch. (§ 8032 address-removal requests are one more reason addresses can silently change between harvests — see fact 4.)
10. **HS1 HB 216** (expanded TP/funder disclosure; proposed effective 2028-07-01 **if enacted**) is pending in House Appropriations as of 2026-05 — monitored, not designed for.

## Prerequisites

1. **Rosters.** Finance links land only on rostered candidates. Verify Nov-2026 DE statewide (AG/Treasurer/Auditor) + General Assembly + county rosters exist (via `voteapp-manual-research`) before Phase 2.

(A Department-of-Elections extract request was considered and dropped — the user is not pursuing it. The outside phase therefore stays nonexistent unless structured expenditure→candidate→position data ever materializes from the Department on its own.)

## Architecture

New module `backend/src/pipeline/delawareFinance/`, tables `de_candidate_finance_*` (well under 63 chars), standard five-table shape via `createStandardStateFinanceSnapshotWriter`. Factory config mirrors Missouri: pairing validation, replace-merge, `supersededLinkSource: "delaware_cfrs"`, `manualLinkProtection` on, window per hard fact 5 (the `minElectionYear` floor is 2026 for the first cohort; the statutory window logic lives in the DE aggregator, not the factory).

**Committee identity — DECIDED by the Phase 0 run: CF_ID canonical, MemberID stored as the portal acquisition key.** Full type-01 registry sweep (3,869 rows = one per statement version; 2,358 committees): zero committees with conflicting CF_IDs, zero CF_IDs spanning two committees, only 10 committees with no CF_ID at all (excluded from auto-link, diagnostics only). Registry caveat: `OfficeSought`/`DistrictName` are EMPTY in bulk registry rows — office association for the resolver comes from the per-committee artifacts instead: the filed-report grid's Office column and the receipts CSV's Office column (probe gate 11 requires both populated on every gold-committee row), with committee detail pages as backup. District vocabulary for legislative committees is Phase 1 fixture work.

Closest structural analog: `missouriFinance/` (session portal client + artifact cache + parsers + itemized aggregation), minus the WAF machinery, plus cover reconciliation Missouri couldn't have.

```text
delawareCfrsClient.ts             # cookie-jar session, full-field form POSTs, CSV/PDF fetch, fail-closed detection ("Unable to process…", HTML-instead-of-CSV), bounded timeout/body, exact-host allowlist, courteous throttle
delawareCfrsArtifactAcquisition.ts# single-flight session queue; atomic search→export pairs; writes the artifact cache; the only component that touches the live portal
delawareCfrsArtifactCache.ts      # NC pattern: SHA-256 + manifest + pinned parser version; restricted perms; sync reads cache only
delawareCfrsParsers.ts            # receipts/expenses CSV, committee JSON, SO-detail HTML, report-PDF cover extractor — contract-tested, fail closed on drift
delawareReportInventory.ts        # filed-report rows + View-Current-Report authority + amendment lineage + election-period window resolution (facts 3+5)
delawareCandidateCommitteeResolver.ts   # name evidence + per-committee Office from filed-report/receipts artifacts (registry OfficeSought/DistrictName are EMPTY — probe gate 11); FindRegistrants assist; manual links always win
delawareCandidateFinanceAutoLink.ts
delawareCandidateFinanceDueList.ts
delawareCandidateFinanceBatchSync.ts
delawareCandidateFinanceSync.ts   # cache-only; runs the fact-6 gates before writing
delawareDirectContributionAggregator.ts # fact-2 classification, size buckets, coverage note
delawareCoverReconciliation.ts    # per-report cash identity + chain + per-cycle donor identity
delawareFinanceEligibleOffices.ts # from the observed Office vocabulary (filed-report grid + receipts CSV Office columns — registry OfficeSought is empty), not guessed
delawareFinanceWriter.ts
delawareBallotLookupFinanceLoader.ts    # contribution_size only; outside fields null + coverage note
index.ts
```

Launch checklist items (per `voteapp-new-state-finance-checklist` — baked into the phase PRs):

- Flags, code defaults all `false` in `backend/src/config/featureFlags.ts`: `DELAWARE_CAMPAIGN_FINANCE_ENABLED`, `DELAWARE_CAMPAIGN_FINANCE_SYNC_ENABLED`, and `DELAWARE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED` (the established `*_RAW_DATA_REFRESH_ENABLED` pattern — 22 states have it; sync defaults to cache-only and only the refresh flag allows live portal fetches). First two go into `backend/.env` (alphabetical) + the read flag into `render.yaml`; the refresh flag is enabled per-run.
- Source label: `DELAWARE_CFRS` in the shared source enum + `FINANCE_SOURCE_LABELS` entry `"Delaware Campaign Finance Reporting System"` in `packages/api-client/src/format.ts` (alphabetical) + `format.test.ts` case.

## Phases (each its own PR; probe before schema)

### Phase 0 — probe PR (no schema, no publication) — **EXECUTED 2026-08-26, re-run 2026-08-27: all 13 probe checks PASS** (on the Meyer + CNDW + DLGA fixtures — see the deferred list below)

Implemented: `delawareCfrsClient.ts` + `delawareCfrsParsers.ts` + `probeDelawareCandidateFinance.ts` (`npm run delaware-candidates:finance:probe`, artifact dir via `DELAWARE_CFRS_PROBE_ARTIFACT_DIR`) with unit tests. Headline results: amendment semantics = current-only, proven **per filing period** (fact 3); CF_ID canonical (architecture note); occupation 23.88% populated (fact 1 revision); cover extraction works on all 20 Meyer PDFs via labeled STATEMENT OF ACCOUNT BALANCE rows (line 1 / 2E / 3J / 4 — the 2E/3J SUBTOTALs are the receipts/expenditure totals; section headings carry no values) with the cash identity enforced; chain continuous across 9 sequential periods; TP ShowReview needs a committee-search POST in-session first.

Status against the original hard-gate list below: **settled** — gate 1 (Meyer flows + two-session determinism), gate 2 (per-period cent reconciliation, both sides), gate 3 (Meyer's full 20-report list), gate 6 (full registry sweep), gate 8 (statewide baseline, delta-bounded). **Partially settled** — gate 7 ran but its premise failed: registry OfficeSought/DistrictName are EMPTY; office evidence instead comes from the filed-report grid + receipts CSV Office columns (probe gate 11). **Deferred to Phase 1 (fixture-dependent, NOT yet proven)** — gate 4 (cycle-window reconstruction per statutory case), gate 5 (money-model mapping pinned against real covers), and the rest of the gold set: appointed-incumbent + challenger window cases, a 2026 statewide committee, 3 legislative committees (district vocabulary), county + school committees, a closed committee. Original gate list:

`npm run delaware-candidates:finance:probe` (`probeDelawareCandidateFinance.ts`) on the client + acquisition layers; the PR also commits `backend/docs/delaware-campaign-finance.md`. Gold set: AG or Treasurer 2026 committee, Meyer for Delaware (558171 — elected-incumbent + office-spanning fixture), one appointed-incumbent committee, one challenger committee, 3 legislative 2026 committees, 1 county, 1 school/municipal, an amended-filing committee (same-period amendment), CNDW 642221 + DLGA 643731 (TP evidence fixtures), 1 closed committee. Hard gates:

1. **Acquisition determinism**: fresh-session Node client reproduces search→CSV; CSV row count == page `total:` on every gold query; **parsed canonical row multiset identical across two fresh sessions** (same count, same signed sums, same normalized sorted hash) — raw byte equality advisory only. Clean-URL vs portal-link ShowReview parity.
2. **Amendment semantics (fact 3)**: current-only vs coexisting versions, proven on the amended fixture; dedup/lineage rule pinned; JSON `Transaction_id`/`FileAmendedVersion` join exercised if needed.
3. **Cover identities (fact 6)**: per-report cash identity + chain continuity across each gold committee's full report list (using max-PDF-version canonical selection); document tolerated difference classes (in-kind, non-cash assets) from evidence.
4. **Cycle windows (fact 5)**: reconstruct each fixture case's election-period window from inventory + statutory case; Meyer's 2024 window must exclude the 2022 county-era money; primary-boundary behavior observed on a primary-winning fixture.
5. **Money-model mapping (fact 2)**: map every Contribution Type / Contributor Type to `total_receipts`/`direct_contribution_total`/excluded, against real covers; pin refund/negative-row and in-kind placement.
6. **Committee identity gate**: CF_ID completeness + uniqueness across the full registry sweep; continuity across amendments/renames; canonical id decided.
7. **Registry sweep**: OfficeSought/DistrictName vocabulary → `delawareFinanceEligibleOffices.ts` (outcome: registry fields EMPTY — the office vocabulary comes from the filed-report/CSV Office columns instead, gate 11); count active 2026 statewide + legislative committees vs rosters.
8. **Occupation non-blank rate** measured statewide (the fact-1 diagnostic baseline).

### Phase 1 — direct-finance path PR (schema through loader, defaults off) — **IMPLEMENTED 2026-08-28**

Migration `259_add_delaware_campaign_finance_tables.sql`: the five canonical `de_` tables only — **no TP tables**. Writer + resolver + auto-link + due list + sync + aggregator + cover reconciliation + loader, all behind `false` defaults. Flags + source label checklist items. Tests: writer transactional snapshot, manual-link guard, parser contracts off sanitized Phase-0 fixtures, reconciliation gates off fixture covers.

Decisions pinned during implementation:

- **Money model (fact 2, settled)**: per-period reconciliation proved the CSV rows ARE the cover 2E content, so in-kind counts inside `direct_contribution_total` (the cover counts it there); Candidate Loan and Other Income rows are excluded from direct and tracked separately; refunds/negative rows subtract from totals and never enter buckets; buckets = positive itemized monetary rows only; occupation chart = disclosed-only rows (no "Unknown" bucket).
- **Window derivation (fact 5, mechanical form)**: windowEnd = election date; windowStart = Jan 1 after the year of the committee's most recent PRIOR 30/8-Day election report (the elected-incumbent rule, which also keeps an office-spanning committee's old-era money out — the Meyer case), else the committee's first report period start (challenger/fresh-committee case). A report straddling windowStart, a chain break, or any per-period mismatch fails closed. `cash_on_hand` = latest canonical cover's ending balance.
- **Resolver evidence**: live office-filtered type-01 committee search (ddlOfficeSought codes pinned from the portal's own BindOffice cascade 2026-08-28: AGEN/AACC/GOV/INCOM/LGOV/STTRE/STSEN/STREP; district option values are opaque numbers resolved live by their "District NN" labels) + conservative whole-word surname match with first-name refinement; any ambiguity skips; manual links always win via writer protection.
- **County offices deferred**: the CFRS county vocabulary (Clerk of Peace, Levy Court Commissioner, County Council) does not map cleanly onto VoteApp's DE county office keys (Clerk of Court, County Supervisor/Commissioner) — v1 eligible offices are statewide + General Assembly only; county needs its own mapping research before joining the cohort.
- **Acquisition layer = Phase 2**: the sync is strictly cache-only (`delawareCfrsArtifactCache` bundles: CSVs + filed-reports grid + report PDFs + manifest with stored-search totals); the batch sync records a per-candidate failure for any due candidate without a cached bundle. The acquisition component must re-POST a search whose page renders the transient `total:0` (portal quirk, seen three times live).

### Phase 2 — local live run + enablement — **acquisition layer IMPLEMENTED 2026-08-28**

Acquisition run for the Nov-2026 cohort (statewide + General Assembly + county), reconciliation-gated sync, `.env` flags on locally, operator checklist. Prod promotion stays a separate explicit operator action per house rule. Separate PR only if code changes fall out of the run.

Acquisition implementation (`delawareCfrsArtifactAcquisition.ts`): one fresh session per committee runs registry lookup (type-01 committee search with `txtCommitteeID` as a hint, identity decided by a client-side CF_ID filter over the paged grid — correctness never depends on the portal honoring that field) → receipts search + full CSV export → expenses search + export → filed-reports grid (ALL versions, `Grid-size=500`, incomplete slice fails closed) → every report PDF (content-type checked, `MemberID` cross-checked) → atomic cache-bundle store. Every search re-POSTs up to 3× on the transient `total:0` quirk, and the CSV row count must equal the final rendered total before anything is cached; a failed acquisition leaves any previous bundle untouched. Wired into the batch sync (per due row, deduped by CF_ID, gated on the raw-data-refresh flag / `--force`, skipped on dry runs, per-candidate failure isolation) plus a no-DB operator CLI `npm run delaware-candidates:finance:refresh-artifacts -- --cf-id ID [...]`. Remaining Phase 2 work: rosters for the Nov-2026 generals (AG/Treasurer general rosters still empty pre-primary), then the live run itself.

### Outside phase — nonexistent until the edge exists

Created only if a structured transaction-level candidate/position source ever exists (none is being pursued). Then: TP schema, support/oppose totals for uniquely-attributed amounts, funder charts via the Georgia-pattern classifier for resolved org identities. No inference fallback; single-affiliation registrations alone still don't qualify (registrations are committee-wide, not report-scoped).

## Validation / acceptance

- Every published number traces to cached artifacts (CSV + cover PDF hashes) and passed both fact-6 identities.
- Re-running sync on an unchanged cache = identical snapshot; amendment resolution deterministic.
- Occupation published from disclosed (non-blank) values only, verbatim, with the coverage note; employer text and derived industry categories never emitted; no outside `$0` emitted; no-committee candidates get no link (not zero); no contributor address in any product table or log.
- Fail closed on: `Unable to process the request.`, HTML-instead-of-CSV, CSV count ≠ page total, cash-identity or chain break, donor-identity mismatch beyond documented classes, ambiguous amendment lineage, ambiguous window, ambiguous committee match.
