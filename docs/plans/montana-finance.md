# Montana campaign finance — build plan

## October 2026 reported-committee correction — implementation in progress

Current local work: the parsing foundation and independent receipt path are committed. **186 Montana tests across 20 files and backend typecheck passed.** Migrations 354 and 355 were applied only to verified local Unix Postgres (377 ledger entries afterward); their checksums remain immutable. The first ordinary default-10 component sync completed: **8 accepted, 2 held, $14,100 across 29 groups**, including three fully reconciled zero-committee components. Every original/count/money/clock comparison passed for accepted components; all five legacy tables and clocks and the migration ledger stayed unchanged. A read-only replay through the current source parser reconfirmed all eight accepted components. One repeated native ledger differed only in nested contact-array order, with every contact and financial value unchanged; normalize only that ordering while preserving originals. Migration 355 lets corrected holds retry by qualification revision without overriding the ordinary cap or falsifying clocks. The actual production API and hydrated React Router candidate card show **$9,360 across 21 reported groups**, five named details after full reconciliation, and unchanged legacy figures and August 29 headline date; named details stayed closed during DOM proof. A full ordinary production batch is running with the corrected receipt path, fresh IE sweep and legacy acquisition. A current filed standalone C7 has not yet been verified: eight recent receiver inventories showed only incorporated notices, so a standalone current C7 holds the whole component pending verified detail semantics. Complete-batch, fresh IE and PR acceptance remain incomplete.

Fresh local priority is 240 canonical eligible candidates × .75 = **180.00**, ahead of California's 152.10. The local legacy tables contain 240 links, 232 summaries and 78 outside groups; all eligible legacy summaries are stale or missing. The three source questions have current evidence:

1. **Outside publication:** CERS publishes independent-expenditure committee inventories and per-committee JSON ledgers. A current native search returned **64 committees**. The first two complete sample ledgers contained eight in-cycle IE rows with blank targets; these remain unallocated, not zero candidate spending. A complete fresh sweep and attribution proof remain required.
2. **Existing call path:** the batch already acquires one IE sweep per year, classifies targets and calls the existing aggregator/writer/loader. Missing or stale outside artifacts preserve prior data. The existing no-C5 gate also suppresses outside publication for a no-filing recipient; measure that exclusion against the fresh sweep before deciding whether an independent publication path is required. Do not describe this state as Pennsylvania's missing-call bug.
3. **Named receipts:** current public transaction rows explicitly distinguish independent, political-party and incidental committee contributions. Observed independent receipts carry `transTypeCode=5`, the independent-contribution label, `committeeTypeCode=PA` and `entityDTO.entityTypeCode=CM`; party receipts use code 6 and PP. `entIdFrom` matches the native reported entity's `entId`, but the legal committee-registration ID is absent. Preserve reported source-entity groups and names without claiming resolved legal PAC registrations. The year-filtered committee registry omits standing PACs/parties, whose placeholder registration year is commonly 2000; the independent registry has 5,472 rows and the first 5,000-row response is incomplete. That research sample cannot authorize money. Per-receipt native types and entities provide the relevant classification directly.

The genuine first-two receiver research covered 7 and 9 current C5 reports, 8 and 91 complete incoming transactions, and 10 committee occurrences totaling **$5,188**, including **$2,688** declared independent-committee contributions. Every report's committee multiset matched the transaction search, including cash, in-kind, names, side and transaction date; every search row referenced a current selected report. Opening/closing report and person controls matched after normalizing only unordered contact arrays, and the complete 1,088-row candidate identity graph remained unchanged. Native `primaryTotal` and `generalTotal` search fields were zero despite reported money, so they are not usable monetary controls. This is source research with zero financial writes, not sync or card acceptance.

Implementation proceeds in small steps: strict native contribution parsing and complete per-report reconciliation; preserved original HTTP bytes and actual capture clocks in a private immutable cache; a branded source packet; canonical person/office/district/year and unique-active-link guards; atomic independent source/group/attempt tables; then an ordinary default-10 component job and existing-card overlay. Include the full declared committee-contribution family, both election sides and cash/in-kind, before separate expenditure-side returns. Group by native reported source entities; retain unknown interests under “Not yet sorted.” Require full uncapped closure before any named-detail cap. Current filed rapid contribution reports need verified parent/detail membership; incorporated notices must not be counted again, and unreadable or unsupported membership holds the component rather than publishing a partial subtotal.

The new `MONTANA_REPORTED_COMMITTEE_RECEIPTS_ENABLED` gate will default off under the Montana master. Acquisition remains separately gated by the existing raw-refresh flag, with saved originals first, actual source dates, bounded requests and fresh sessions. Its own missing/source-clock schedule and durable held-attempt rotation must run independently of legacy summary freshness, including when invoked from the existing batch. Extend the ordinary post-election window to 98 days for late filings/corrections. Preserve legacy fundraising, outside data and headline clocks during component-only work. Fresh-check main and the local migration ledger before allocating a new migration; applied migrations 350–353 remain immutable.

The [official candidate calendar](https://politicalpractices.mt.gov/home/Even-year-2026-candidate-reporting-calendar.pdf) sets pre-general **October 20 through October 14** and post-general **November 20 through November 15**. The [current CERS calendar](https://cers-ext.mt.gov/CampaignTracker/dashboard) sets committee pre-general **October 30 through October 24** and post-general **November 30 through November 25**. Candidate rapid notices run October 15–November 2; committee notices run October 25–November 2, due within two business days. Refresh acquisition and ordinary sync October 21/26, October 31–November 2, November 5, November 23 and December 1, followed by January 6 and later amendment checks. Calendar sources disagree on some period-start dates; actual filing inventory supplies report boundaries. These are planned reruns, not automations.

Before an isolated Montana PR: baseline **141 tests across 17 files passed**; add source/version/paging/identity/correction and atomic writer/reader/schedule tests, backend typecheck, a real ordinary component sync with complete original/money/count/clock comparisons, a fresh complete IE sweep and ordinary legacy sync, and actual production API plus React Router card proof. The existing $5,000 card threshold stays intact. No financial acceptance, migration, production activation, deployment or merge has occurred for this correction. Kansas donor names and all new Missouri publication remain held. Earlier Phase 4 and environment-file instructions below are historical and do not authorize production or environment-file access in this task.

Status: rev 7 — Phase 3 EXECUTED 2026-08-29 (240 of 241 Nov-2026 candidates linked, 230 published locally with money; the live corpus forced six gate fixes plus a quarantine-triage rule change, and IE attachment recovery lifted outside resolution 43.1% -> 49.9% of in-window dollars; results + what the live data disproved are below and in `backend/docs/montana-campaign-finance.md`); next = Phase 4 (prod). Read flag is already ON in render.yaml (PR #957); prod holds NO Montana data yet.
Source facts: `backend/docs/montana-campaign-finance.md` (endpoint recipe + gotchas; **commit it with Phase 1** — untracked files don't reach other checkouts)
Template module: `backend/src/pipeline/missouriFinance/` (per-candidate portal harvest,
sha256+manifest artifact cache, occupation breakdown, outside spending, due-list sync)
Writer: `createStandardStateFinanceSnapshotWriter` (`pipeline/finance/standardStateFinanceSnapshotWriter.ts`)

## What Montana gives us (verified live 2026-08-26)

| Feature | Verdict | Source surface |
|---|---|---|
| Raised / spent | YES, cent-exact | per-candidate CSV export + detail JSON |
| Primary/General split | YES, native | `Election Type` / `amountTypeDescr` |
| Official cover totals | **NO** — public view renders cash-summary cells EMPTY; report-list JSON has only `primCashBeg`/`genCashBeg` + unitemized lumps | control = cash-begin chain (below) |
| Donor occupation + employer | YES, 100% fill on sample | CSV export + `financeRepDetailList` JSON only |
| Contribution sizes | YES — Q1 PASS (entry-level rows, real dates) | `financeRepDetailList` JSON only — CSV dates synthetic |
| Outside target | YES (free text `candidateIssue`, JSON rows only) | NOT in CSV export |
| Outside stance | stance-aware: bare name → support (rule); explicit "Oppose X" rows exist at scale → oppose | rule below |
| Outside funders | independent/party committees: YES (org donors); incidental: v1 SKIP | committee CONTR flow |

2026 registration reality (full 1,090-row pull, 2026-08-26): 640 Active / 260 Amended /
138 Closed / 22 Withdrawn / 22 Reopened / 8 In Process; **426 declared "will spend less
than $500" and file no C-5**. Registration list ≠ ballot (contains a Governor and an
"Exploratory" registration). We link FROM our Nov-2026 roster, never from the CERS list.
State-level 2026 offices actually registered: Supreme Court Justice No. 03 + No. 04,
12 District Judge depts, PSC 01 + 05, ~25 SDs, HD 1–100. (No Clerk of Supreme Court
in 2026.) US Sen/House = FEC path, untouched.

### Stance rule (load-bearing)

**ARM 44.11.502(6)(b)** (current numbering; COPP's 2018 guidance PDFs cite the same text
as (8)(b)): an IE filer must report "the name of the candidate or committee the
independent expenditure was intended to benefit". COPP CERS 101, verbatim: when an IE
"is made primarily to oppose a specific candidate, the candidate benefitted needs to be
listed ... as a supported candidate". Therefore:

- **Phase 0 falsified uniform benefit-convention compliance**: 2025–26 filings contain
  explicit stance verbs in `candidateIssue` itself — "Oppose George Nikolakakos"
  ($80.7k), "Support Barry Usher", etc. Explicit oppose = $454k resolved (8.4% of IE
  dollars, nearly all School Freedom Fund - FEC) + $232k unresolved. Mapping those
  rows to "support" would attribute attack money TO its target. Stance-aware parser:
  - bare `NAME (SD-9)` / name-only rows → `support` (benefit semantics per rule);
  - leading `Support <name>` → `support`;
  - leading `Oppose <name>` → **`oppose`** — this is filer-declared stance in the
    target field itself, not narrative inference; publish it.
- `outsideOpposeTotal`: populated from explicit oppose rows when they exist for a
  candidate; NULL when none disclosed (never 0). Mixed-convention caveat: some
  committees book attack money as support-of-beneficiary (per COPP guidance), others
  as oppose-of-target — totals mix the two; the footnote explains.
- Never infer stance beyond the leading verb; narrative purpose text stays diagnostics.
- Exclude `electioneeringInd='Y'` rows and ballot-issue rows from candidate totals.
- **UI note (ships WITH Phase 2b, small):** both cards hardcode "supporting/opposing"
  ([FinanceSummaryCard.tsx:161](../../frontend/src/components/FinanceSummaryCard.tsx), mobile ~:262) — fine as-is. DO add
  a one-line Montana footnote in the outside section: "Montana support totals include
  spending that benefits a candidate by opposing an opponent; opposition is shown only
  where the filer declared it." Gate: MT outside data does not go live before the
  footnote exists (web + mobile).

## Architecture

`backend/src/pipeline/montanaFinance/` mirroring Missouri (same file roles:
client / artifact cache / parsers / report inventory / filer resolver / auto-link /
direct + outside + outside-group aggregators / eligible offices / writer / sync /
due-list / batch / ballot-lookup loader / index). Scripts: `montana-candidates:finance:*`
(MO naming). Artifact cache = copy `missouriMecArtifactCache` pattern verbatim
(sha256 + manifest + atomic tmp-rename — already content-addressed; invent nothing).

### Client rules (verified gotchas — do not rediscover)

- Fresh session per entity (stale session silently serves the previous entity).
- `iSortCol_0=1&sSortDir_0=asc` on every DataTables list GET (else HTML 500).
- Committee financial searches: `electionYear` + EMPTY date fields; assert response
  `<title>` is `(searchResults)` — `(search)` means silent validation bounce.
- Form actions resolve relative to `/CampaignTracker/public/`, not `/public/search/`.
- `retrieve*` POSTs → 302 → GET page → JSON list endpoints.
- Sequential, ~1 req/s, artifacts cached; ballot-lookup loader reads DB only.
- ONE harvest surface per data class (search-flow JSON for transactions; report-list
  JSON for periods/lumps) so `transId` dedupe is within a single surface.

### Totals + reconciliation (rev 2 — cover totals are NOT public)

- Verified twice: `viewFinanceReport` HTML renders summary lines 1–4 with EMPTY cells
  in the public flow, and `listFinanceReports` rows carry no receipts/disbursements
  totals (`grandTotal: null`). So there is no official cover receipts number to adopt.
- **Official control = the cash-begin chain**: for consecutive canonical reports,
  `begin(N) + receipts(N) − disbursements(N)` must equal `begin(N+1)`
  (`primCashBeg`/`genCashBeg`, primary and general checked separately). Detail sums
  define receipts/disbursements; the chain check is the fail-closed reconciliation.
- Cycle math: card totals = Σ canonical-report current-period amounts, Primary +
  General both (never total-to-date fields, never a silent General-only number).
- `directContributionTotal` = Individual + Committee + Candidate-personal
  contributions + derived unitemized lump. Excludes loans, debt, and the misc-receipts
  family (below). Loader shows this as "Raised"
  ([standardStateFinanceBallotLookupLoader.ts:704](../../backend/src/pipeline/finance/standardStateFinanceBallotLookupLoader.ts) prefers it over totalReceipts) —
  individuals-only would undercount.
- Loans: excluded from `directContributionTotal`; cash loan proceeds DO count in
  chain receipts (they hit the bank — see the residual term definitions). No separate
  loan field in v1.
- Misc receipts: the `refunds` + `fundraisers` detail lists share one line-item family
  ("Interest, Rebates, Refunds, Fundraisers, and Other Miscellaneous Receipts") and
  hold POSITIVE receipts (Eddy: a $241k returned expenditure back into the bank).
  Chain math includes them as cash in; `directContributionTotal` EXCLUDES them
  (returned money / interest is not new money raised).
- `cashOnHand` = latest canonical report's begin-chain-derived ending balance; NULL if
  chain broken. Phase 0 tests a negative-balance filer; if CERS allows it, enable the
  writer's existing `allowNegativeCashOnHand` + matching DB constraint (RI/GA precedent).
- Unitemized lumps: the `grandTotalLessThan35*` / `totalContrLessThan35` JSON fields
  are ALWAYS 0 in the public flow (Phase 0: all 24 harvested C-5s, incl. candidates
  with obvious small-donor money) — dead fields, do not use. **Derive the unitemized
  amount per period from the chain residual**: `lump(N) = begin(N+1) − (begin(N) +
  itemized_cash_receipts(N) − cash_expenditures(N))`. Term definitions (load-bearing —
  wider than `directContributionTotal`): `itemized_cash_receipts` = ALL itemized cash
  inflows — contributions (individual + committee + candidate-personal) + cash loan
  proceeds + the misc-receipts family (refunds/fundraisers/interest); in-kind portions
  never counted. `cash_expenditures` = cash portions of all disbursement lists.
  Omitting loans or misc receipts here would misclassify them as unitemized
  contributions or fail the gate. Sign convention (load-bearing):
  hidden receipts make the actual next-begin HIGHER than the itemized-derived ending,
  so under this formula the lump is POSITIVE. Gate: `lump ≥ 0` and small relative to
  itemized receipts; negative (itemized flows overshoot actual cash) or large → fail
  closed. Latest period's lump is unknowable until the next report files (accepted
  small understatement).
- Loans can be IN-KIND (Phase 0: Ahner's filing-fee check from a personal account =
  loan with `cashAmt` 0, amount in `inKindAmt`/`debtAmt`) — in-kind loans never touch
  the bank; chain math uses cash portions only.
- Canonical report selection: group by (entity, form, exact period); pick by status +
  `amendedDate`/`receivedDate` + reportId — never `dateFiled` alone (observed
  inconsistent dates). `C7`/`C7E` status `Incorporated` never added to period totals.

### Breakdowns

- Direct `occupation`: dollars by filed Occupation, Individual Contributions rows only,
  from the CONTR CSV export (100% fill verified); in-kind counts as dollars; filed
  values only, never inferred; `Retired`/`Self-employed` preserved.
- Direct `contribution_size`: GO (Q1 PASS 2026-08-27) — build from
  `financeRepDetailList` JSON `datePaid` rows, NEVER from the CSV export
  (its `Date Paid` = period start — synthetic).
- Outside groups: IE committee sweep per year (`independentExpendSearch=true`) →
  per-committee JSON rows → dedupe by `transId` → resolve `candidateIssue` by parsed
  name + office/district token (`(SD-9)`) + year. Two-stage resolution, measured
  separately in Phase 0:
  1. CERS text → unique CERS candidate: measured 35.9% auto-resolved (Phase 0) →
     outside spending ships resolved-rows-only, plus quarantine reporting and the
     attachment-recovery campaign for top attach/blank spenders;
  2. CERS candidate → VoteApp roster candidate (subset by design; unmatched = fine).
  Fuzzy-name-only matching FORBIDDEN (observed `LYN BENNET`/`LYN BENNETT`).
  Quarantine (log, never publish): multi-candidate single-amount rows, "see
  attachment"/"see quantity", blanks, ballot issues, unresolvables.
- Outside funders (`donor`/`industry`): independent + party committees only, and
  **organizational donors only** — the exact MO aggregator pattern (it already skips
  individuals; no writer extension). Org names through the industry-label pipeline.
  **Incidental committees: v1 attaches NO funder breakdowns** (their filings mix
  designated and appeal-response money; attaching the donor pool to one candidate
  is wrong without a per-row designation field — Phase 0 checks if one exists).
  Coverage note instead; MCA 13-37-232 documented in parser comments.

## DB

- Migration `<next>_add_montana_campaign_finance_tables.sql`: five `mt_candidate_finance_*`
  tables — START from Missouri 245 but ADAPT: `committee_id` CHECK becomes numeric
  (`^[0-9]+$` — CERS ids are numeric; MO's is `^[A-Z][0-9]{6}$`), `link_source IN
  ('manual','cers_portal')`, year range as-is. Identifiers ≤63 chars; never renumber.
- Source enum in `ballotLookupFinanceShared.ts`; label `MONTANA_COPP: "Montana
  Commissioner of Political Practices"` in `packages/api-client/src/format.ts`
  `FINANCE_SOURCE_LABELS` (alphabetical) + `format.test.ts` case.
- `sourceUrl` on links/summaries = stable dashboard URL
  (`https://cers-ext.mt.gov/CampaignTracker/dashboard`) — deep links are POST/session
  driven, unproven as GETs. Numeric `candidateId`/`committeeId` live in their own
  columns; Phase 0 Q7 re-checks their stability.

## Flags

Code defaults `false` in `featureFlags.ts`. PR adds all three to tracked
`backend/.env.example` + the read flag to `render.yaml`; locally set ON in
`backend/.env` (house policy: free read-side flags stay ON):

```
MONTANA_CAMPAIGN_FINANCE_ENABLED
MONTANA_CAMPAIGN_FINANCE_SYNC_ENABLED
MONTANA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED
```

Raw-refresh false ⇒ sync consumes cached artifacts only (MO semantics).

## Phases

### Phase 0 — EXECUTED 2026-08-27 (results)

Harvest: full report-detail JSON for Eddy (SupCt#4), Wilson (SupCt#4), Bedey (SD-43),
Ahner (county attorney), Adams (sub-$500 JP); CONTR CSV exports; full 2025–26 IE sweep
(46 committees, 1,367 deduped IE rows, $5.43M); AFP C-4 schedules. Raw state:
scratchpad `mt_phase0/state/` — **EXPIRED** (session scratchpad cleaned; verified
gone 2026-08-27). Phase 1 re-harvests the fixture entities itself (client is cheap:
no WAF, ~1 req/s, sequential). Answers:

- **Q1 PASS** — entry-level transactions with real dates (Eddy: 2,908 individual rows,
  387 distinct dates; exact-duplicate keys rare). `contribution_size` is GO, built
  from report-detail JSON (never from the CSV export's synthetic dates).
- **Q2: current-only.** One row per (period, form); amended replaces original; no
  history endpoint. Snapshot on every sync; keep artifacts as the only history.
- **Q3 PASS with derived-lump design** — chain closes exactly on several periods;
  everywhere else actual next-begin sat slightly ABOVE the itemized-derived ending =
  hidden unitemized small-donor money (public lump fields are dead-zero). Derived
  lumps: Bedey $49, $45; Wilson $255…$2,056; Eddy up to $3,480. (The Phase 0 run log
  recorded these with the opposite sign — `calculated − actual`, hence "small
  negatives"; same measurements, convention now unified on the formula above.)
  Residual IS the unitemized lump; gate = lump ≥ 0 and < threshold. One Ahner anomaly
  (amended + in-kind loan reorder, ±$335.80) → the fail-closed flag works as intended.
- **Q4 FAIL vs 90% — outside spending re-scoped.** Auto-attributable = 35.9% of IE
  dollars (bare 21.6% + Support 6.0% + Oppose 8.4%). Structurally unreachable ceiling:
  "see attached" = 30.9% ($1.68M, 16 rows — $1.75M incl. blanks from Conservatives4MT
  alone) + blank 10% + multi 7.1%. Consequences: (a) v1 publishes resolved rows only,
  with per-committee quarantine reporting; (b) top attach/blank spenders
  (Conservatives4MT first) get a **manual attachment-recovery campaign** via
  `viewFinanceReport/attachmentList` + the manual-research skill — that alone can
  roughly double coverage; (c) resolution itself has headroom (nickname/alias table,
  review queue) for the ~18% unresolved-name dollars.
- **Q5 PASS** — occupation fill 100%/100%/100%/99.99% of itemized individual dollars
  (Eddy/Bedey/Ahner/Wilson).
- **Q6** — loans excluded from raised (kept); in-kind loan quirk above; `cashOnHand` =
  derived ending balance of latest canonical report (understates by that period's
  not-yet-derivable lump; acceptable), no negative balances observed.
- **Q7 PASS** — candidateId/committeeId identical across sessions and days
  (0 mismatches on the full 2026 list).
- **Q8** — misc-receipts family rule above.
- **Q9** — AFP (incidental) filed ZERO contribution rows: no funders disclosed, no
  designation field to check. v1 no-incidental-funders decision stands.
- **Q10** — superseded: lump fields are dead; validation replaced by the residual gate.
- Bonus: the Supreme Court #03 "candidate" is `TEST, Acct` — CERS contains test data;
  registration list is not a ballot list (roster-driven linking only).

Sanitized fixtures (NH precedent) get built during the Phase 1 PR from a fresh
harvest of the same fixture entities (raw Phase 0 state expired), alongside the
parsers they test.

#### Original spike design (for reference)

Gold set: 1 Supreme Court or district-judge candidate, Bedey SD-43 (probed) + 1 more
legislative, 1 county >$500, 1 sub-threshold local (expect NO C-5 → coverage note),
AFP-Montana + 1 messy IE committee, 1 party committee, 1 incidental committee with
designated funders + 1 without, 1 candidate with nonzero unitemized lump, and hunt one
negative-ending-balance filer.

Questions (each gates something):
- Q1 entry granularity (gates `contribution_size`)
- Q2 amendment history: pre-amendment version retrievable by old reportId, or
  current-only? (gates snapshot cadence)
- Q3 chain reconciliation closes to the cent on all fixtures (gates ship)
- Q4 candidateIssue two-stage resolution rates; stage-1 ≥90% of dollars (gates
  outside spending)
- Q5 occupation fill ≥95% of itemized individual dollars across fixtures
- Q6 loans placement + cashOnHand derivability + negative-balance behavior
- Q7 candidateId/committeeId stability across sessions/days
- Q8 refund-section subtype inventory + sign rules
- Q9 incidental-committee rows: is a per-contribution designation field exposed?
- Q10 lump JSON values match rendered "< $50" report line

Fixtures: **sanitized** (NH precedent — `-sanitized` names, REDACTED addresses,
synthetic names where the value doesn't matter), minimal and structure-faithful, under
`backend/tests/fixtures/montanaFinance/`. Full raw artifacts stay in scratch, not git.

### Phase 1 — schema + client + parsers PR

Migration, client + artifact cache + parsers + report inventory + canonical-report
selection + chain reconciliation, flags (.env.example + render.yaml), source enum +
label + format test, probe script, fixture-driven tests (parsers, reconciliation,
amended selection, C7-incorporated exclusion, `<title>` failure assertion, empty-vs-
legit-zero artifacts: schema-valid zero rows with zero controls = legitimate; empty
body / HTML error page / truncation = failure). Commit `backend/docs/montana-campaign-finance.md`.
Gate: backend `npm run typecheck` + `npm test`.

### Phase 2a — direct money PR — BUILT 2026-08-28

Discoveries (details in `backend/docs/montana-campaign-finance.md`): the
`payment` detail list is debt/loan REPAYMENT (chain outflow, but excluded
from the published "spent" = expendOther + pettyCash, matching the state's
own EXPEND export); CSV↔JSON individual/committee/expenditure totals proven
cent-exact and enforced as fail-closed cross-checks; financial search works
with an empty lastName so acquisition needs only candidateId + year; the
resolver matches against the full one-page year registration list (name +
office-title + year exact, one fetch per batch).


Resolver, auto-link (manual-link protection), direct aggregator (occupation +
contribution sizes — Q1 passed; report-detail JSON source), writer wrapper, sync/due-list/batch/scheduler scripts, ballot-lookup
loader registered in [ballotLookup.ts](../../backend/src/pipeline/address/ballotLookup.ts) — BOTH the per-state import
(block ~line 59) AND an `{ state: "MT", load: ... }` entry in
`STATE_FINANCE_LOOKUP_ADAPTERS` (~line 1030; import alone leaves the loader dead) +
`FINANCE_SOURCE_HOME_URLS` entry in `packages/api-client/src/finance.ts`
(`https://politicalpractices.mt.gov/`), loader/registry/format tests + web/mobile
card tests. Fail-closed everywhere: reconciliation, ambiguity, schema drift, bad
artifact → keep last good snapshot + diagnostic.

### Phase 2b — outside spending PR (re-scoped per Q4: resolved rows only) — BUILT 2026-08-28

IE sweep + two-stage resolution + per-committee quarantine reporting. Totals per the
stance rule above: bare-name and leading-`Support` rows → `outsideSupportTotal`;
leading-`Oppose` rows → `outsideOpposeTotal` (NULL only when a candidate has no
explicit oppose rows — never 0). Unresolved/attach/blank/multi rows stay quarantined,
never published. Plus the Montana footnote in web + mobile outside sections (hard
gate for enabling MT outside data). Attachment-recovery campaign (Conservatives4MT
first) is a follow-on data task, not a code gate.

Build discoveries (full recipe in `backend/docs/montana-campaign-finance.md`):
the year-scoped committee search returns each committee's FULL IE history
(cycle scoping is by `datePaid` over [Jan 1 year−1, Jan 1 year+1)); IE rows
carry no committee identity (fresh session per committee + `resultCount`
cross-check is the binding); support totals are also NULL when nothing
resolved (a fabricated $0 would misstate a 57%-quarantined corpus);
resolution got nickname expansion (shared `personFirstNameNicknames`, one-
sided) and a live-registration tie-break (CERS mints a new candidateId per
race, so race-switchers carry multiple same-year registrations) → measured
43.1% of in-window dollars resolved. The sweep rides the daily batch (once
per election year); the footnote ships as the loader's
`outside_coverage_note`, which web + mobile already render — gate satisfied
without UI code changes. v1 boundary: outside money publishes only alongside
a filed direct snapshot (`no_filed_reports` candidates keep their guarded
all-NULL stamp; their IE rows stay visible in the quarantine report).

### Phase 2c — outside funders PR (optional, only if coverage proves useful)

Independent/party committees, org donors only, industry labels. Incidental
committees stay excluded unless Q9 found a real designation field.

### Phase 3 — local live run — EXECUTED 2026-08-29

Result: **240 of 241** eligible Nov-2026 candidate-elections linked, **230
published** with money (plus 2 guarded "nothing filed" stamps). 39 carry
outside totals, 9 of them opposition. Local only — prod holds no Montana data.

Linking: the first auto-link pass left 22 unlinked, and **none** were resolver
bugs. 16 were roster nicknames against CERS formal names (Ben/Benjamin,
Kim/Kimberly, Joe/Joseph), fixed by wiring the shared one-sided
`firstNameVariants` expansion into the resolver through the middle-evidence
matcher's `firstNamesEquivalent` hook — surname, chamber+district and year
still match exactly, and same-family pools resolve ambiguous (live: "Joe
Cohenour" picks Joseph, not Jill, in the same district). 5 were structural
quirks linked by hand as `manual` (J.C. -> John C Windmueller, `Weeks-ONeal`,
`BogdenRIchards`, Tracey (Miller) Karcher, and Willis Curdy whom CERS spells
"Willus"). 1 (Boeshore, HD-30) has no CERS registration at all.

**The fixture-built gates failed ~85% of real filers.** Six shapes the Phase
0/2a fixtures never carried, all fixed and all live-verified:

- **Null begin anchors** are routine (40 of 151 C5 rows in the first 24
  candidates), not corruption. Effective begins carry forward from the prior
  derived ending; conservation is still checked at every real anchor.
- **Small negative residuals** (-$9.13, -$15.00) are unitemized bank fees;
  tolerated to a floor and never counted as contributions.
- The CSV splits committee money across **three** line items (Independent /
  Political Party / Incidental) — sum all three.
- The **$50 itemization threshold is inclusive** (MCA 13-37-229 "in excess
  of"), and each surface makes its own itemize-or-lump call for threshold
  rows in BOTH directions.
- `prepareDownloadFile` returns **no fileName for a zero-row export**; store
  a header-only CSV rather than failing.
- **PENDA (Pending-Amended) reports are canonical** — the filed version is
  operative, and excluding them dropped whole periods ($3,380 on one filer).

Also live-disproved: negative cash on hand looked real (two filers) but the
balance is DERIVED and every derivation is a lower bound, so a negative may be
an artifact — `cashOnHand` publishes NULL instead, and the negative-cash
migration written for it was reverted. Same reasoning killed publishing a
balance for an all-carried (all-null) chain, which reconciles tautologically.

Quarantine triage of the 22 holdouts: **14 were our rule being too tight, 7
are genuine CERS data gaps** (money appearing or vanishing — one balance
climbs $30k across reports recording zero receipts). The 14 fail one or two
links with residuals that cancel exactly across the span (a $1,000
restatement; a filer entering a derived -$3,452.87 balance as +$3,452.87 then
correcting it; a $650 shuffle between sides). Per-link checking polices which
PERIOD a dollar was booked in, and nothing published depends on that, so a
failing chain now falls back to combined cumulative conservation across the
real-anchored span. 216 already-published candidates stayed unchanged to the
cent.

Spot check: 12 candidates verified cent-exact against an independent replay
from raw artifacts, including Bedey's Phase 2a UI-verified figures.

Industry-label run: **N/A in v1** — no funder breakdowns are published (that
is Phase 2c), so there are no organization names to label.

Still unpublished and correct: 8 filers on genuine anomalies, plus the
candidates with no registration or no filings. Montana ships at 230/240.

### Phase 4 — prod

Standard new-state finance runbook: prod migration (261 shipped with the
2026-08-28 deploy — verify, do not re-apply), render.yaml read flag (DONE,
PR #957 — still needs a manual blueprint **Approve**, and an env-var change
alone does not restart the service), data promotion by `pg_dump` of the five
`mt_candidate_finance_*` tables, deploy by FULL sha, spot checks against the
CERS UI.

Cadence caveat: the plan's "scheduler daily Sep–Nov" is **not reachable
today**. No state sets `*_SYNC_ENABLED` in prod — the flag only ever lives on
a dedicated cron service, and the one that exists (San Francisco) is
commented out pending a paid Render plan. Until that changes, keeping Montana
current means re-running the sync locally and re-promoting, the same loop the
other states use.

## Explicitly rejected (with reasons)

- Opposition totals from purpose text — rule-backed benefit semantics only.
- Per-source "benefiting" relabel of the support/oppose UI — COPP itself labels the
  field "supported"; footnote covers the nuance at 1% of the cost.
- C-5 cover totals as authority — not publicly rendered (verified empty cells + no
  JSON fields); chain check replaces it.
- Individual-donor funder aggregation for outside groups — writer supports
  `donor|industry` only and MO precedent skips individuals; revisit only with a real
  product need.
- Browser-tier harvester — no WAF; curl session flow verified.
- Pre-2020 history, hard-copy archive, electioneering product feature, FEC bridge —
  deferred; staging keeps `electioneeringInd`.
