# Arkansas campaign finance — feasibility (probed 2026-08-26)

October11,2026 update: normal sync now verifies explicit typed PAC cash and positive candidate-specific outside allocations from complete current Original electronic report/PDF/native-ledger evidence. Initial outside scope is explicit 2026primary rows with exact target/stance/office/seat; unknown, amended or failed components preserve stored evidence and never establish overall zero. Full source policy, local witness requirements and fresh post-deadline reruns are recorded in [the implementation plan](../../docs/plans/plan-arkansas-finance.md). The feasibility observations below describe the earlier probe, not complete current coverage.

Verdict: **buildable for Nov 2026**. Totals raised/spent YES (two independent
routes), donor occupation YES (structured, ~87% filled — better than NH),
outside-spending stance PARTIAL (free text only; small volume).

## System

- Vendor: **Civix CFIS** — same family as New Mexico and New Hampshire
  (`arcfis-*.azurefd.net` behind Azure Front Door). Launched Sept 2023.
- Public SPA: https://ethics-disclosures.sos.arkansas.gov (Angular).
- API host: **https://api-ethics-disclosures.sos.arkansas.gov/api** — anonymous
  JSON, no auth, no token. Response wrapper `{data, succeeded, error}`.
- **DNS gotcha (verified 2026-08-26):** both hostnames return NXDOMAIN from some
  resolvers (local router DNS and Anthropic's WebFetch both failed) but resolve
  fine via 8.8.8.8. Probes used `curl --resolve` with pinned IPs
  (150.171.109.145 site / .146 api). The adapter should not need pinning on a
  normally-configured host, but if fetches fail with ENOTFOUND, this is why.
- Pre-Sept-2023 filings = legacy PDF archive only
  (https://www.ark.org/sos-filing_search/ + `PublicLegacyFiledReport/*`
  endpoints). New-system transaction data effectively starts filing year 2022
  (small file: late-2022 transactions back-filed into CFIS).

## Key endpoints (verified working, anonymous)

Endpoint constants live in webpack chunk `common.<hash>.js`
(`Y.y` / `m.Hi` map), NOT in main.js — bundle names above verified 2026-08-26.

- **Bulk CSV export** (NH twin):
  `POST /api/ExportData/GetExportPublicDownloadData`
  body `{"type":"CSV","filingYear":<YYYY>,"transactionTypeCode":"TCON"|"TEXP"}`.
  Synchronous CSV response. Verified years 2022–2026.
  2026 TCON = 92 MB / 304,193 rows / $36.3M; TEXP = 6 MB / 20,591 rows / $31.5M.
- **Filer search** (registration + server-computed totals):
  `POST /api/PublicFilerDetails/GetCandidateCommitteDetails`
  body `{"pageNumber":N,"pageSize":N,"filerName":"<text>"}` (the filter key is
  `filerName`; `searchText`/`lastName` are ignored). 10,733 registrations at
  probe. Rows: `filerEntityID` (stable numeric, = CSV "Filing Entity ID"),
  `guid` (registration), `filerType` ("Candidate", PAC, "SFI Filer", IEF...),
  `office`, `officeDistrictName`, `politicalParty`, `electionYear` (cycle),
  `filingYear`, **`totalRaised` / `totalSpent` / `balanceofFunds`**
  (server-computed, cycle-cumulative).
- **Transaction search**:
  `POST /api/PublicTransactionDetails/GetTransactionDetails`
  body `{"filerRegistrationGuid":"<guid>","transactionTypeCode":"TCON"|"TEXP",
  "pageNumber":N,"pageSize":N}` — pageSize 1000 OK. 1,425,693 rows all-time.
  Per row: guid, filerName, transactionAmount (numeric), transactionDate,
  sourceName, **employerName, occupation** (e.g. `Other(Chief Deputy Coroner)`),
  sourceAddress, transactionSource, reportName, transactionSubTypeDesc,
  transactionCategory, `hasChild`, filerRegistrationGuid.
- **Per-registration totals widget**:
  `POST /api/PublicFilerDetails/GetPublicFilerDetails…/GetCombinedFinancialTotalsDetails`
  body `{"filerRegistrationGuid":...}` → interest/loan/monetaryContribution/
  expenditure cumulatives + endBalance. CAUTION: for Sanders this returned
  numbers matching only ~one report period, NOT the cycle — semantics unpinned;
  the search-row totalRaised/totalSpent is the trustworthy cycle figure.
- Other mapped: GetTopDonorsAndPayees, GetContributionsCategoriesDetails,
  GetContributionsInStateAndOutStateDetail, GetPublicLoansAndDebtsDetails,
  GetAmendedSheetHistory, GetFilerDetailsById, PublicLookup/* (office,
  jurisdiction, election-year lookups). `Lookup/ToGetFilingYears` = 401 anon.

## CSV shapes

TCON columns: Filing Entity ID, Entity Name, FilerType, Transaction Type,
Transaction Sub Type, Funding Source / Loan Source Type, Source Name, Source
Address, **Employer Name, Occupation, Occupation Other**, Transaction Date,
Transaction Amount (`"$5,000.00"` strings), Transaction Description,
Transaction ID, Election Type, Election Year, Guarantor Name/Address, Report
Filed Date, Report Name, **Amended** (Y/N).

TEXP columns: ... Payee Type/Name/Address, Transaction Category (+ Others),
Election Type/Year, Report Filed Date, Report Name, Amended.

2026 TCON mix: Non-Itemized Monetary 204,543 / Itemized Monetary 97,303 /
Loan 1,059 / Itemized Nonmoney 845 / Return Contribution ~443.
Filer types: PAC 271,068 rows, Candidate 31,482 (921 distinct candidate
filers), County Party 1,566, IEF 74, Party 3.

## Totals reconciliation (Sanders, Governor, entity 1004)

Search-row cycle totals: raised **$7,870,507.53**, spent **$5,717,191.87**.
CSV sums filing years 2022–2026:

- Raised: monetary itemized 6,900,333.77 + non-itemized 884,346.62 + 2022 file
  85,614.08 ≈ overshoots target by ~$31k ≈ the nonmoney 31,458.43 → server
  "totalRaised" ≈ monetary only (± ~$213 residual). Close, not yet cent-exact.
- Spent: CSV 5,460,018.99 vs target 5,717,191.87 → **−$257,172.88 gap**.
  Cause identified: the TEXP CSV omits rows the search API has — API TEXP row
  count for her registration = 2,909 vs 1,527 CSV rows (`hasChild` parent/child
  credit-card style itemization suspected).

**Design consequence:** headline raised/spent should come from the
registration search row (`totalRaised`/`totalSpent`, server-computed,
cycle-scoped) — like Georgia's cover-arithmetic decision. CSVs/search rows
feed occupation & donor aggregates, not headline totals, until a plan-phase
fixture pins the CSV↔API↔cover reconciliation.

## Receipt-search semantics (Phase 3 gold-set profile, 2026-09-02)

Ten 2026-cycle candidate registrations pulled through the windowed
registration-scoped `GetTransactionDetails` (TCON) path:

- The search returns **receipts only**: `transactionSubTypeDesc` is one of
  `Itemized Monetary`, `Non-Itemized Monetary`, `Itemized Nonmoney`,
  `Interest`. Loan and Return Contribution rows (present in the CSV) never
  appear — entity 10477 has 19 CSV loan rows and reconciles to the cent
  without them.
- **`totalRaised` = monetary rows + interest rows** (loans and in-kind
  excluded). Entity 7289 (20 interest rows, $5,331.35) reconciles only with
  interest counted; every unamended filer reconciles to the cent.
- Non-itemized rows are per-report lumps (`transactionSource` null, no
  occupation); `transactionSource` is otherwise `Individual`, `Candidate`,
  `Political Action Committee`, `Business/Organization/Unlisted PAC`.
- Amounts can carry sub-cent noise (`1500.001`, entity 8313); rounding each
  row to cents reconciles.
- Some amended filers overshoot the registration total (superseded versions
  kept in the search: 7526 +$11,800 with one amended report; 8753 +$550;
  8021 +$17,500) while others with amendments reconcile exactly (7722, 10477,
  8313 with ten amended reports). The aggregator therefore publishes
  breakdowns only when the receipt sum equals `totalRaised` to the cent and
  withholds them otherwise (totals still publish). `hasChild` rows appeared
  only on overshooting filers (8021: 5, 8753: 4) — semantics unpinned.
- Per-row `GetTransactionDetailsByGuid` (body `{"transactionGuid"}`; returns
  `transactionID`, `transactionVersionID`, election type/year, source type,
  category) on 10477, 8313 and 7526 (551 rows): every transactionID appears
  once, all at version 1 — so the 7526 overshoot is transactions an amendment
  removed surviving as their own rows, not duplicate versions. A max-version
  dedupe cannot repair overshoots; only report-lineage scoping could.
- Two filers in the Phase 4 cohort UNDERSHOOT: Brannan (7471) receipts sum
  to $250 below `totalRaised` and Smith (8367) to $19.12 below, with no
  in-kind or interest row explaining the gap (probe 2026-09-02). Amendment
  leftovers therefore do not only add money; the exact-sum gate withholds
  breakdowns in both directions.
- Year-less registrations: 61 of the 480 live legislative candidate rows
  carry no `electionYear` (all `filingYear` 2026/2028, 54 Active), including
  active 2026 candidates (Holladay HD70 $80.6k, Teeter HD44, Rankin Baker
  HD99, Heron HD14) and Wilson (11847, the Phase 0 loan-heavy gold filer).
  Auto-link never matches them (no cycle evidence); the sync accepts an
  entity's single year-less registration for the linked office and
  district once a link pins the cycle.

## Phase 4 live run (2026-09-02, local)

163 eligible Nov-2026 candidates → 141 auto-linked + 18 manual links (see
docs/plans/plan-arkansas-finance.md Phase 4 for the evidence list) + 3 with no
registration (two Libertarians, one Democrat) + 1 withheld (Dean Hunter,
legal name unconfirmed). 159/159 syncs succeeded: $17.45M raised, $11.16M
spent, 7 negative balances, 143 reconciled to the cent, 16 quarantined
(largest Deitchler +$70,128.10 and Puryear +$45,128.73; two undershoots
above). 2,016 breakdown rows. All 159 read back through the ballot-lookup
loader. Prod promotion is a user-run one-transaction TRUNCATE + data-only
restore (recipe in the plan doc); scheduled sync stays off.

## Donor occupation (verified — shippable)

2026 TCON individual-source rows: 301,059; **occupation filled 261,131 (87%)**
(Occupation dropdown + `Occupation Other` free text; count either),
employer filled 261,628 (87%). Occupation itself is ~50k on the dropdown
column alone — must merge `Occupation` + `Occupation Other`.
Unlike NH, a real occupation chart is shippable; employer→industry pipeline
also usable.

## Outside spending (support/oppose) — PARTIAL

- Filer type "Independent Expenditure Filer" (code IEF) exists; 2026: 182
  expenditure rows, 74 contribution rows — almost all NRA Political Victory
  Fund.
- **No structured stance/target anywhere found**: not in TEXP CSV, not in
  transaction search rows. Stance lives in free text:
  `"SMS MESSAGING IN SUPPORT OF BRANDON ACHOR, AR-SD-13"`.
- No `transactionSearch:"TIE"` switch (NH's IE search) — AR build's
  GetTransactionDetails accepted the guid+type filters; TIE not applicable.
- v1: outside spending **null** (or IEF-aggregate without stance); a curated
  description parse ("IN SUPPORT OF/IN OPPOSITION TO <name>, AR-XX-nn") could
  be a follow-up — the NRA pattern is regular, but sample too small to trust.

## Coverage notes

- Local candidates file here too (Mayor, City Council rows seen) — AR
  counties/cities are in scope, unlike most states' state-only portals.
- Registration rows carry office + district + party → auto-link candidate →
  filerEntityID looks straightforward (office/district match like NH rules).
- Amended: CSV has explicit Amended Y/N (149 of 304k rows in 2026), but the
  flag is not version semantics. **Pinned by the Phase 0 run (2026-08-27; see
  the Phase 0 results in `docs/plans/plan-arkansas-finance.md`, the authoritative
  record):** the CSV under-reports amended filers (Burkes $16.5k vs $33.9k
  registration total) while the transaction search over-reports them
  (superseded versions included, no per-row marker). Version-safe machinery:
  `PublicFilerDetails/GetPublicFilerProfileFiling` (deduped current-version
  report inventory), `GetPublicFilerProfileChildFilingDetails` (prior
  versions), `GetTransactionDetailsByGuid` (`transactionID` +
  `transactionVersionID` per row).
- Transaction-search paging is unstable across pages (no unique sort key
  exists; `fromDate`/`toDate` MM/DD/YYYY inclusive and `reportName` filters
  do exist) — complete pulls partition by date window; see the client.
- The 2026-only occupation figure above (87%) is superseded by the all-years,
  candidate-filer-only figures in the plan doc's Phase 0 results.
