# New York Campaign Finance Plan

## October 12, 2026 finance-gap increment

The local baseline has 21 active linked 2026 General candidates, 20 summaries,
and no stored outside groups. The batch already calls Schedule R acquisition.
Hochul has no summary: her four-year cycle has 48,691 itemized receipt rows,
exceeding the client's former 25 × 1,000-row bound after IE acquisition succeeds.
Receipt queries now default to 5,000-row pages with the existing maximum-page
guard and explicit caller overrides. No registry, target-name, office, seat,
race-year, support/oppose or unique-parent IE rule is relaxed.

Direct disclosures have an explicit `Political Action Committee (PAC)` type.
The new named PAC subset accepts positive monetary Schedule A/B/C receipts
with that exact reported type and a complete source occurrence identity. It
excludes Schedule D in-kind, Schedule M refunds, generic organizations and the
separate `Political Committee` class. Repeated gift identities are rejected
instead of selecting an unproven amendment version. Source-name keys identify
reported donor groups, not registered legal accounts. Amounts are **gross cash
receipts**, already included in Raised; they are not net support. The candidate
card states this scope. Signed net/refund accounting is a separate increment.

Fresh source controls: Mayer has 204 typed PAC cash receipts/$247,500; Hochul
has 473/$2,547,192.13. Gift IDs and transaction numbers are unique in these
bounded complete source queries. Original/amended report flags are not mixed
within the observed report buckets. These observations do not establish a
general latest-version contract or complete rapid-filings coverage. Disclosure
metadata was updated October 12 at 19:49:34 UTC; observation time and publisher
update are distinct. The existing whole-sync failure path writes no money;
malformed PAC source evidence or exhausted paging must likewise preserve rows.

Normal targeted rerun: pass the source/read flags inline, then use
`new-york-candidates:finance:sync-due -- --candidate-id <UUID> --year 2026 --refresh`.
Candidate/year scope applies before LIMIT and skips unrelated auto-linking.
`--refresh` bypasses staleness while retaining all eligibility/window checks;
SODA acquisition is genuinely fresh, without a fixture client. `--force` only
bypasses the feature gate. No environment-file changes or provider calls.

The [official 2026 filing calendar](https://elections.ny.gov/system/files/documents/2025/12/2026-filing-calendar-12112025-approved.secure.accessible.pdf)
sets the pre-general deadline at **October 23**, covering through **October 19**.
Acquire fresh publisher data and rerun **October 24**, then **October 27** for
late publication. A new fetch of an old snapshot does not prove post-deadline
coverage. Rapid weekly/24-hour reports require verified independent acquisition
and deduplication before daily coverage can be claimed; reconcile through
November 4 when available. The November 30 post-general filing covers through
November 26: fresh reconciliation **December 1**. The current due-list retains
only declared candidates and its default post-election grace is one day; the
December reconciliation therefore also needs a separately reviewed status/window
scope. No scheduler or automation is added by this increment.

*Written 2026-07-11 against `912f2f35`. Feasibility verified with live queries
against NY Open Data (Socrata) and the NYSBOE Public Reporting UI on this
date. Goal: New York state-office campaign finance in ballot lookup — outside
support/oppose groups and their funding industries first, direct-campaign
receipts second. Occupation breakdowns are impossible for NY state filings and
stay empty permanently.*

## 1. Verified facts (do not re-litigate; re-verify only if sources change)

### Data access

- `publicreporting.elections.ny.gov` and the zip host
  `cfapp.elections.ny.gov/NYSBOE/download/ZipDataFiles/` reject backend-style
  clients: HTTP 403, `server: cloudflare`, `cf-mitigated: challenge`. Browser
  UA does not help. **Never build production against these hosts.** No
  Playwright/cookie/challenge workarounds in production.
- Official alternative: NY Open Data (Socrata, `data.ny.gov`) hosts the same
  NYSBOE data, updated daily (verified `updatedAt` = same-day):
  - `e9ss-239a` — Campaign Finance Disclosure Reports Data: Beginning 1999
    (~18.1M rows, all schedules, all filers)
  - `4j2b-6a2j` — Contributions view (subset of e9ss-239a)
  - `ajsb-8pni` — Expenditures view (subset of e9ss-239a)
  - `7x2g-h32p` — Campaign Finance Filer Data: Beginning 1974 (filer registry)
  - `qcz9-s873` / `udeh-rt5n` / `epr8-9fny` — active filer/committee/candidate
    views of the registry
- Plain `curl`/Node fetch returns 200 with ETag + Last-Modified. No login. App
  token optional but production should send `X-App-Token` (env
  `NEW_YORK_SODA_APP_TOKEN`) for the larger rate-limit pool; unauthenticated
  calls share an IP-based pool and can 429.
- Never bulk-download the 18M-row dataset. Filtered SODA queries only:
  `$where` on year/schedule/filer, stable `$order`, bounded `$limit`/`$offset`,
  max-page guard. Repo precedent for all of this:
  [washingtonPdcClient.ts](../../backend/src/pipeline/washingtonFinance/washingtonPdcClient.ts)
  (data.wa.gov Socrata client with appToken, paging, maxPages).

### Disclosure schema (e9ss-239a, key columns)

`filer_id`, `cand_comm_name`, `election_year`, `filing_sched_abbrev`,
`filing_cat_desc` (Itemized/…), `trans_number`, `trans_mapping`,
`cntrbr_type_desc`, `flng_ent_name` / `flng_ent_first_name` /
`flng_ent_last_name`, `org_amt`, `sched_date`, and Schedule-R-specific:
`election_year_r`, `office_desc`, `district`, `r_support_oppose` (S/O),
`ie_cntrbr_occ`, `ie_cntrbr_emp`.

Schedules seen in practice: A (monetary from individuals/partnerships),
B (corporate), C (other incl. PACs/LLCs), D (in-kind), F (expenditures),
L, N, O, R ("Expense Allocation Among Candidates").

### Occupation: impossible

- Ordinary contribution rows carry name/address/type/amount only. NY Election
  Law does not collect occupation/employer for state filings.
- `ie_cntrbr_occ IS NOT NULL` count across the entire dataset: **0**.
- PCFB (public matching) makes campaigns collect employer >$99 but it never
  reaches public exports.
- Therefore `top_direct_donor_occupations` stays `[]` for NY. Never derive
  occupation from names/addresses/committee affiliation. Occupation data for
  NY voters exists only in FEC (federal races, already covered) and NYC CFB
  (city offices, out of scope).

### Outside spending: strong, with one trap

- Schedule R rows give: filing committee (`filer_id`, `cand_comm_name`),
  target candidate (`flng_ent_first_name`/`flng_ent_last_name`), `office_desc`,
  `district`, `election_year_r`, explicit `r_support_oppose`, `org_amt`,
  `trans_mapping` → parent Schedule F expenditure (verified: GUID resolves to
  single same-filer F row, allocation ≤ parent amount).
- **Not every `trans_mapping` resolves** (verified 2026-07-11: 5 of 47 CFAR
  mappings point at expenditures absent from the dataset — amended/superseded
  filings). Strict rule 8 below drops those rows by design; expect and accept
  a modest undercount rather than counting unverifiable allocations.
- **Trap (verified live): party committees also file Schedule R.** 2026
  Governor support rows include NYS Democratic Committee ($1.64M → Hochul) and
  NY Republican State Committee ($163k → Blakeman). That is coordinated party
  spending, not outside money. The registry gate below is mandatory, not
  optional.
- Registry (`7x2g-h32p`) `committee_type_desc` distinguishes
  `Independent Expenditure Committee` from party/authorized/PAC types.
- Verified end-to-end example (2026 Governor): Citizens for Affordable Rates
  PAC (filer 590891, registry type Independent Expenditure Committee),
  47 Schedule R rows supporting Kathy Hochul totaling $12,320,650.23, funded
  entirely by Uber Technologies Inc. via Schedule B ($11,686,700.23).
- Explicit-S/O row counts by `election_year_r`: 2020: 2S · 2021: 30S ·
  2022: 3S · 2023: 2S · 2024: 41S · 2025: 1,844S + 132O · 2026 (mid-cycle):
  407S + 15O. Plus thousands of R rows with NULL `r_support_oppose` — skip
  those. Missing output means "no safely structured data", not "no outside
  spending".

### Direct campaign: workable, needs conservative linking

- Socrata filer datasets expose **no candidate→authorized-committee FK**.
  (The Public Reporting UI knows it, but that host is blocked.)
- Candidate registry rows (`compliance_type_desc='CANDIDATE'`) carry
  office/district; committee rows carry committee type but no office.
- Verified: Friends for Kathy Hochul (filer 16851, Authorized Single Candidate
  Committee) has 8,198 itemized 2026 Schedule A individual receipts
  ($4.0M) plus B/C/D with `cntrbr_type_desc` populated — enough for
  contribution-size buckets, contributor-type buckets, and org-donor industry
  classification.
- Resolution strategy: candidate registry row (office/district/year match to
  our election) + committee whose name contains the candidate's name +
  committee type `Authorized Single Candidate Committee`; skip on ambiguity
  (0 or 2+ matches); manual-link escape hatch via `link_source='manual'`
  (same pattern as `la_candidate_finance_links`).

### Classifier defect (fix before NY ships)

`ORGANIZATION_PATTERN_RULES` at
[financeLabelClassifier.ts:175](../../backend/src/pipeline/finance/financeLabelClassifier.ts:175)
matches `TECHNOLOGIES` → `technology`, so "Uber Technologies Inc." misfiles as
technology; AI never revisits rule-classified labels
([financeIndustryClassificationService.ts:96](../../backend/src/pipeline/finance/financeIndustryClassificationService.ts:96)).
Fix: exact org rules before pattern rules — `UBER TECHNOLOGIES` →
`transportation` (add `LYFT` while there). Gambling orgs (FanDuel, DK Crown
Holdings — real 2026 oppose-side funders, verified) have no fitting slug in
`FINANCE_INDUSTRY_SLUGS`; v1 shows the group and omits industry rather than
forcing a wrong slug. Adding a `gambling_gaming` slug is a separate, later
decision.

## 2. Scope

Qualifying offices (canonical keys, gate like the other states):

- `statewide::Governor`
- `statewide::Lieutenant Governor`
- `statewide::Attorney General`
- `statewide::Comptroller` (NY office_desc is "State Comptroller"; alias
  already exists in seedOffices)
- `state_upper::State Senator` (63 districts)
- `state_lower::State Lower Chamber Legislator` (Member of Assembly, 150)

Excluded: federal (FEC wins), county/local offices, and all NYC city offices
(Mayor, Council, Public Advocate, NYC Comptroller, Borough President — NYC CFB
territory since 2020). NY elects no Secretary of State or Treasurer.

2026 is a NY cycle year for every qualifying office — timing is good, current
data is the strong part, historical coverage is thin and irrelevant (sync
window only covers future elections + grace day, like other states).

## 3. Phases

### Phase 0 — classifier fix + production connectivity probe (no migration, no writes)

1. Exact-rule classifier fix (Uber/Lyft), with test. Independent PR, ships
   regardless of NY.
2. `newYorkSodaProbe` script (npm command, no scheduler): queries `e9ss-239a`
   (filtered 2026 Schedule R page) and `7x2g-h32p` (filer lookup) with stable
   order, paging, timeout, 429/5xx retry, optional app token. Logs status,
   latency, row counts.
3. Deploy; run repeatedly **from Render**. Local success ≠ production proof.
   Gate: stable 200s from the deployed backend. Only then build the module.

### Phase 1 — outside spending v1 (`newYorkFinance/`, mirrors state-module layout)

Migration `1xx_add_new_york_campaign_finance_tables.sql`:
`ny_candidate_finance_links`, `ny_candidate_finance_summaries`,
`ny_candidate_finance_outside_groups`, `ny_candidate_finance_outside_group_breakdowns`
(+ `ny_candidate_finance_direct_breakdowns` in the same migration, used in
Phase 2). Copy Louisiana's constraint/trigger/index shape.

Files (names follow repo convention):

- `newYorkSodaClient.ts` — clone of washingtonPdcClient shape; datasets
  `e9ss-239a` + `7x2g-h32p`; `NEW_YORK_SODA_APP_TOKEN`.
- `newYorkFinanceEligibleOffices.ts` — allowlist above.
- `newYorkCandidateCommitteeResolver.ts` / `newYorkCandidateFinanceAutoLink.ts`
- `newYorkOutsideSpendingAggregator.ts` — strict acceptance rules, ALL must hold:
  1. registry `committee_type_desc = 'Independent Expenditure Committee'`
  2. `filing_sched_abbrev = 'R'`
  3. `r_support_oppose` explicitly `S` or `O`
  4. candidate name exact-normalizes to the linked candidate
  5. `office_desc` maps to the allowlist
  6. district exact match (where the office has one)
  7. `election_year_r` matches the linked election year
  8. `trans_mapping` resolves to exactly one Schedule F row, same filer
  9. allocation > 0 and ≤ parent expenditure amount
  10. conflicting/duplicate `trans_number` rows skipped
- `newYorkOutsideGroupContributionAggregator.ts` — IE committee funders from
  their own receipt schedules (A/B/C/D), **filtered to `election_year`
  matching the linked election** so historical funding is never presented as
  support in the current race; **organization donors only** feed industry
  classification (existing `donor` labelType path); individuals never treated
  as company money.
- `newYorkFinanceWriter.ts`, `newYorkCandidateFinanceSync.ts`,
  `newYorkCandidateFinanceBatchSync.ts`, scheduler, enricher hook in
  `candidateProfileEnricher.ts` (state `"NY"` + eligible-office gate),
  `newYorkBallotLookupFinanceLoader.ts` wired in `ballotLookup.ts`, source
  string `NEW_YORK_SODA`.

Flags (master + subflags, `--force` bypasses subflags only):

```bash
NEW_YORK_CAMPAIGN_FINANCE_ENABLED=false
NEW_YORK_CAMPAIGN_FINANCE_SYNC_ENABLED=false
NEW_YORK_SODA_APP_TOKEN=
```

Phase 1 ships with `direct_campaign` money fields null/empty and
`top_direct_donor_occupations: []` — response shape already supports this
(`ballotLookupFinanceShared.ts`).

### Phase 2 — direct campaign (SHIPPED 2026-07-11)

- Auto-link candidate→authorized committee with the conservative rule above;
  ambiguity skips; support `link_source='manual'` rows for hand-curated links.
- Direct aggregates from linked committee receipts filtered to
  `election_year` = linked election, `filing_cat_desc='Itemized'`:
  totals, `contribution_size` buckets, `contributor_type` buckets (registry of
  `cntrbr_type_desc` values verified: Individual, Corporation, PAC, Political
  Committee, PLLC/LLC, Partnership incl. LLPs, Union, Association, Sole
  Proprietorship, Candidate/Family, Other), top org donors → `donor` industry
  classification.
- Occupation/employer arrays remain empty. Unitemized lump rows (NULL
  `cntrbr_type_desc`) count toward totals, not breakdowns.

## 4. Risks / open items

- **Render outbound IP vs Socrata**: the entire plan gates on Phase 0. If
  Render is throttled/blocked, next option is app-token + backoff; do not fall
  back to the Cloudflare-blocked hosts.
- **429s**: shared anonymous pool is real; get the app token before enabling
  schedulers.
- **Committee-name heuristics**: NY names vary ("Friends for/of X", "X for
  NY"). Resolver requires candidate first+last name containment; expect
  moderate auto-link coverage and accept it — skipped is correct, guessed is
  wrong.
- **Schedule R rows with NULL r_support_oppose** exist in bulk (thousands per
  year); they are silently excluded by rule 3 — never infer direction.
- **Gambling slug** decision deferred; revisit if oppose-side gambling money
  keeps appearing in qualifying races.

## 5. Explicitly out of scope

- Scraping or automating `publicreporting.elections.ny.gov` / `cfapp` zips.
- NYC CFB integration (has occupation/employer + city races — future module).
- Occupation breakdowns for NY state offices (data does not exist).
- Historical backfill before the current cycle.
