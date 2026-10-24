# West Virginia campaign finance — feasibility (probed 2026-08-26, cross-validated against independent report)

Verdict: **buildable**; outside spending needs a document (PDF) path, not the structured grid.

| Need | Status |
|---|---|
| Total raised | YES — bulk CSV + API, cent-level rows |
| Total spent | YES — bulk CSV + API |
| Direct donor occupation | YES **via API only** (bulk CSV has employer, no occupation); full 2026 result (re-run 2026-09-01, Monetary + In-Kind individual rows only — loans/returns/other income excluded): 95.7% occupation / 96.3% employer on >$250 single transactions (2,694 of 8,490 individual donation rows); statutory basis: W. Va. Code §3-8-5a requires occupation + major business affiliation once a donor's **cycle aggregate** exceeds $250 (single-gift >$250 is a proxy; `transactionTotalYTD`>$250 view: 91.4%, field semantics unproven) |
| Outside spending support/oppose | YES **via filed F-7b PDFs**; the structured IE grid is NOT the source of record — see below |

## System

- Public SPA: https://cfrs.wvsos.gov (React). WV SOS CFRS, hosted in AWS GovCloud.
- Public API: **https://cfrs.wvsos.gov/api/Public-Service** — anonymous JSON, no auth.
- **Two client gotchas, both mandatory:**
  1. The host serves an **incomplete TLS chain** (no intermediate; `Verify return code: 21`).
     Anaconda/Node default CA bundles reject it; macOS system curl works. Client
     strategy: try normal system trust first, fall back to a bundled intermediate for
     this exact host (never disable verification), and count fallback uses.
  2. A **browser User-Agent is required**. Default `curl`/`node-fetch` UA → `403 Forbidden`
     from the WAF on every path including `/api`.
- The API is ASP.NET and self-describes: an unknown body member returns
  `Could not find member 'x' on object of type 'GetXRequest'` — useful for probing.

## Bulk CSV downloads (raised / spent)

Three calls:

1. `GET /Common/getAllDataType` → CON (Contributions), EXP (Expenditures), LOAN, DEB,
   REG (Registrations), REPS (Reporting Schedules), FREP (Filed reports).
   `GET /Common/geAllYearForDataDownload` → 2004–2029.
2. `POST /AccessReport/getDataDownloadDataList` body `{"dataType":"CON","year":"2026","pageNumber":1,"pageSize":25}`
   → `{id, dataType, year, s3ReportFilePath}`. One file per (type, year).
3. `POST /AccessReport/getDataDownloadfile/{id}` (no body) → `{fileUrl}`, a **presigned S3
   URL, `X-Amz-Expires=3600`**. Fetch it without the WV UA/CA workarounds.

Files are **regenerated nightly** (2026 contributions file stamped `20260826030002`).
Encoding is **cp1252, not UTF-8** — decoding as UTF-8 throws on smart quotes (eight
`0x92` bytes in the 2026 file). The files are also **malformed beyond encoding**
(verified 2026-08-27): the contributions file has quote characters inside unquoted
fields (line 98: `…,Warren "Dean" Jeffries,…` — strict RFC-4180 parsers fail; lenient
parsing yields correct 12-column rows); the 2026 expenditures file has **428/10,736 rows
with 1–3 extra columns** (382×13, 25×14, 21×15) from unescaped commas in the recipient
name/address; and the **contributions files have the same defect class** (2025 file:
1 row — `Alonzio Perry, II`, a generational-suffix comma in the contributor name). All
bad-width rows keep a valid typed prefix and a recoverable trailing `FiledDate`.
Recovery rule (implemented in `westVirginiaCfrsCsv.ts`): keep the typed prefix and the
trailing fixed columns, keep only the FIRST column of the damaged name/address span as
the counterparty name, discard the ambiguous tail (it mixes in the street address —
never retained), and flag the row `recovered`.
Catalog depth (verified): 81 artifacts — Contributions 2016–2026, Expenditures 2015–2026,
Debts 2017–2026, Loans 2016–2026, Filed reports 2014–2026, Registrations 2006–2026,
Reporting Schedules 2025–2029. Full catalog in one call with body exactly
`{"pageNumber":1,"pageSize":5000}` — a bare `{}` returns zero rows.

Contributions `Contributions_2026_*.csv` (3.1 MB, 18,396 rows at probe):
`RegistrantID, CommitteeName, CandidateName, TransactionType, TransactionCategory,
TransactionDate, TransactionAmount, ContributorPayeeType, ContributorPayeeName,
ContributorAddress, EmployerName, FiledDate`.
2026 to date: **$10,454,673.08 across 573 registrants**, dates 2026-01-01 → 2026-06-30
(through the Q2 report, due 2026-07-07).
Categories: Monetary 17,664 / In-Kind 471 / Other Income 164 / Transfer of Excess Funds 93 / Return 4.
Contributor types: Individual 15,058, Business/Org 1,653, PAC 1,036, Self 388, Candidate 231, Party 30.

Expenditures `Expenditure_2026_*.csv` (2.2 MB, 10,736 rows, **$14,073,952.38**):
`RegistrantID, CommitteeName, CandidateName, TransactionType, ExpenditureType,
ExpenditurePurpose, TransactionDate, TransactionAmount, RecipientType, RecipientName,
RecipientAddress, FiledDate`. **No IE flag, no target, no stance** — the payee column is
the vendor. Outside spending must come from the API (below).

Registrations `Registration_2026_*.csv` (428 rows): RegistrantID, CommitteeName,
CandidateName, CommitteeType, CommitteeSubType, RegistrationDate, CommitteeStatus.
2026: 383 State Candidate, 26 State PAC, 15 Independent Expenditure Committee, 4 Party.
**No office or district column** — do not link candidates from this file; use the
committee API instead.

### Amendment semantics — committee-level evidence (Phase 0 probe, 2026-08-27; re-run 2026-09-01)

**Working conclusion: the nightly CSV holds current-version rows only.** Evidence from
the live probe (`npm run west-virginia-candidates:finance:probe`):

- Six committees reconciled CSV↔API, including two 2025 committees with amended
  reports on file (report versions 2 and 3): every one matched **cent-exact and
  multiset-exact** on (date, amount, category) — zero rows only-in-CSV or
  only-in-API. The probe now fails (`ok: false`, exit 1) on any mismatch or on an
  empty sample, so a mistyped committee id cannot "match" as 0 = 0.
- Version >1 rows are common in the API (2026: 2,114 of 11,506 rows on versions 2–5)
  with **zero** `amendedFlag` rows in 2026 and 47 in 2025 — if the CSV carried
  original+amended side by side, amended committees' CSV row counts would exceed the
  API's; they don't.
- Therefore the CSV is safe to aggregate directly, and the byte-identical duplicate
  rows (2026: 240; 2025: 1,049) are legitimate repeat transactions, not version
  residue.

**What this evidence is and is not.** The CSV has no report identity, so the check is
committee-wide on the fields both sides share (date, amount, category). It rules out
coexisting versions (row counts would differ) but cannot see an amendment that only
renamed the donor or moved a row between reports. The plan's per-report
CSV↔API↔cover-total reconciliation is not done yet — cover totals need PDF text
extraction — and stays a Phase 1 gate alongside the money-model matrix. The API's
`amendedFlag`/`reportVersionID`/`transactionID` remain available for diagnostics; a
version-resolution staging layer is not planned unless that Phase 1 gate finds a
counterexample.

## Donor occupation — API only

The bulk contributions CSV has `EmployerName` **but no occupation column**
(employer filled on 2,974 / 3,135 individual rows over $250 = 95%).

`employerOccupation` exists only on the transaction search endpoint:

`POST /CommitteeTransactions/getAllPublicTransactionDataList`
```json
{"pageNumber":1,"pageSize":5000,"transactionCategory":"CON","orgTypeCode":"101","transactionYear":"2026"}
```
→ 11,509 rows for 2026 (3 pages, re-run 2026-09-01). The probe measures occupation on
**individual Monetary + In-Kind rows only** — the CON selector also returns loans, loan
payments, returns and other income from individuals, which are not donors. Full result:
8,490 individual donation rows; 2,694 single transactions >$250, of which **occupation
2,579 (95.7%), employer 2,593 (96.3%)**. Statute triggers on the donor's cycle
aggregate, not single-gift size; the `transactionTotalYTD`>$250 view gives 2,722 rows /
occupation 2,487 (91.4%), but that field's semantics (YTD vs cycle, per-donor vs
per-committee) are unproven.

Values are a controlled vocabulary, not free text ("Construction/Engineering",
"Environmental Services", "General Business", "Unknown"). The shared contract's
`top_occupations` takes free-text names — publish WV's labels verbatim (whitespace
normalization only), excluding blanks and "Unknown". Employer strings separately feed
the existing employer/donor industry-label path (pre-2027 filings only — see §3-8-6a).

### Search-request gotchas (all verified; corrected 2026-08-27)

- `orgTypeCode` = the first three digits of `entityId`: **101** State Candidate,
  **102** State PAC, **104** Independent Expenditure Committee, party committees separate.
- **The selectors are unstable query modes, not filters.** Verified totals: no selector
  → 10,780; `transactionCategory:"CON"` alone → 18,685; `"EXP"` alone → 10,780; `"IE"`
  alone → 29,534; `transactionTypeCode:"CON"` → 29. With `orgTypeCode:"101"` +
  category `CON` → 11,506 rows that include Monetary, In-Kind, loan subtypes (Loans /
  Loan Payment / Loan Forgiveness), Transfers, Other Income, Returns.
- Client rule: always send `orgTypeCode`, then classify every returned row from its own
  category/type/purpose response fields under a pinned mapping — never trust the request
  mode or the (sometimes contradictory) `transactionTypeDesc` label alone.
- Paginate on `totalRecords` — a 5,000-row page 1 is not the result set.
- Other accepted members: `candidateNameAssocation` (sic), `stance`, `orgName`,
  `orgSubTypeCode`, `sourceFullName`, `contributorType`, `transactionBeginDate`,
  `transactionEndDate`, `transactionMinAmount`, `transactionMaxAmount`, `zipcode`,
  `electionYear`, `measure`, `petition`, `sortColumn`, `sortDirection`.
- `pageSize:5000` is served in one response (7 MB). Paginate on `totalRecords`.

## Outside spending (support / oppose) — document pipeline required

**Decisive finding (verified 2026-08-26):** IE reports filed on Form F-7b exist only as
scanned PDFs in the committee document store. They never become structured transactions.

Proof: Citizens for Better Communities (orgID 3981, entityId 1040003981) has **zero**
structured transactions in any category, zero filed reports via
`getAllFiledReportDataListForPublic` — but 3 "Independent Expenditure Report" PDFs in
`POST /Committee/getAllPublicOrgDocumentDataList` (`{"orgID":3981,...}`). Downloaded one:
a 2-page scanned F-7b (image-only, **no text layer** — no `/Font` objects), containing
exactly the fields VoteApp needs, all handwritten/typed on fixed form positions:
candidate "Robert Fluharty", checkbox **In Opposition of Candidate**, payee
"Mainstream Consulting, LLC", $4,000.00, May 7 2026, Primary. Page 2 = purpose-specific
contributor schedule (>$1,000 furthering-the-expenditure funders, occupation + employer
fields) — blank on this filing.

Scale of the document universe (first probe, committees registered 2025–2026 only):
**18 IE committees, 111 IE-report PDFs** (Mountaineer Conservative Action 29,
Mountaineer Freedom Alliance 15, School Freedom Fund 11, Make Liberty Win 10, …). The
registry holds 93 IEC/ECC committees all-time (registration years 2016–2026), and an
older committee can still file this cycle, so the probe now enumerates every one and
scopes documents by `receivedDate` year instead. **Re-run 2026-09-01: 93 committees,
335 documents received 2025–2026, of which 292 are IE reports across 25 committees.**
The registration-year filter had hidden 181 of them — Americans for Prosperity
(registered 2023) alone has 129, The West Virginia Chamber of Commerce (2020) 21,
Mountaineer Majority Fund (2024) 8, West Virginia Coal Victory PAC (2022) 7. Still
small enough for form-fixed extraction with review; too big to ignore.

PDF retrieval chain (verified):
1. `POST /Committee/getAllPublicOrgDocumentDataList` → `documentID`, `documentType`,
   `documentName`, `receivedDate`, `s3DocName`.
2. `POST https://cfrs.wvsos.gov/api/Common-Service/AmazonCloudFront/getDownloadLinkWithoutCookies`
   body `{"s3FilePath":"<s3DocName>"}` → presigned S3 URL (1-hour expiry).
   (Note different service: **Common-Service**, not Public-Service.)

Statutes (fetched + verified 2026-08-26): §3-8-2(a) — IE >$1,000/calendar-year must
report candidate, support/oppose, amount per candidate. §3-8-2(d)/(e) — 24-hour report
inside 15 days ($5,000 statewide/legislative, $500 county/municipal); 48-hour report
$10,000+. §3-8-2(c) — SOS must publish candidate-by-candidate IE indices for/against;
asking SOS for that index as structured data is worth one email before building OCR.
§3-8-2b — electioneering communications, same candidate+stance disclosure, separate
category (3 ECC committees all-time).

### Structured IE grid — what it actually holds

IE rows: same endpoint, `{"transactionCategory":"IE","orgTypeCode":"104","transactionYear":"<yyyy>"}`.
Stance vocabulary: `GET /CommitteeTransactions/getStanceForPublic` → SU Support (1) / OP Oppose (0).

Per-row fields when populated: `stanceDescription`, `candidateNameAssocation` ("Last, First"),
`ballotMeasureDescription`, `petitionDescription`, `transactionAmount`, `transactionPurpose`
(e.g. "Direct Mail"), `committeeName`, `entityID`, `reportFileName`, `s3ReportFilePath`.

**Coverage (corrected 2026-08-27 — stance capture is filer-specific, not era-specific):**

| Year | IE rows (org 104) | Total | stance / target filled |
|---|---|---|---|
| 2022 | 467 | — | **11** (all West Virginia Strong, Inc.) |
| 2024 | 754 | $11,964,831.91 | 0 |
| 2025 | 50 | $46,668.67 | 0 |
| 2026 | 1 | $897.10 | 1 (WV Strong again: Support, "Criss, Vernon") |

One filer (WV Strong) e-files through the portal form and gets structured stance; paper
F-7b filers — everyone else — bypass the grid entirely.

Interpretation (corrected after the document-store finding): the grid rows are IE
committees' *general expenditure schedules* from quarterly filings; the candidate-specific
support/oppose money lives on F-7b PDFs that bypass the grid entirely. The single
stance-filled 2026 row (West Virginia Strong, "Criss, Vernon", Support, $897.10) is the
rare committee that e-filed through the online form. **The 2026 doc store already holds
292 IE PDFs while the grid holds 1 stance row — do not wait for October; the grid will
not fill in.** Build totals from documents; treat any structured stance rows as a bonus
to reconcile against.

Also present but unprobed: `/CommitteeTransactions/getIndependentExpenditureChartData`.

## Candidate → filer linkage

`POST /Committee/getPublicCandidatesCommitteeDataList` body `{"pageNumber":1,"pageSize":5000}`
returns all 2,967 committees in one call, no filters needed:
`orgID, entityId, orgName, candidateName ("Last, First M."), orgType, orgSubType,
registrationDate, orgAddress, election ("2018 Election"), office, district, party,
orgStatus, registrationYear, stance`.

`entityId` == `RegistrantID` in the bulk CSVs — that is the join key.
Registration-population counts (labels matter): `registrationYear=="2026"` → 262 rows;
**`election=="2026 Election"` → 427 State Candidate committees (353 active)**: House of
Delegates 315, State Senator 77, judicial ~15, Undeclared 21. Both populations include
primary losers, terminated committees, and (in the registration-year view) 2028
pre-candidates — the VoteApp roster, not the registry, decides the November cohort.
Judicial encoding: circuit lives in `office` ("Circuit Court Judge, Circuit 15"),
division in `district` (numeric; Supreme/Intermediate use strings like `"Division 1"`,
`"Division Undeclared"`). `stance` on the committee row is not usable: filled on 1 of 88
IE committees.

## 2026 filing calendar (from the REPS bulk files)

**Cycle-start caution (added 2026-08-27):** the 2025 REPS file shows the "2026 Candidate
/ Committee Election Cycle" already running in **2025 Q3 (begin 2025-07-01)** — the 2026
file's earliest listed period (2025 Q4) is not the cycle start. Never assume a start
date; scope by REPS cycle membership and harvest 2024–2026 artifact years.

2025 Q4 due 2026-01-07 · Q1 due 2026-04-07 · Primary (04-01→04-26) due 2026-05-01 ·
Q2 (04-27→06-30) due 2026-07-07 · Q3 (07-01→09-30) due 2026-10-07 ·
**General (10-01→10-18) due 2026-10-23**.

Sync cadence: lightweight daily catalog/document poll (late, amended, and final reports
arrive anytime), with burst sweeps in the 15 days before the primary and general for
24h/48h IE filings. The deadline list sets expectations, not the polling schedule.

## 2027 privacy boundary (W. Va. Code §3-8-6a, verified 2026-08-27)

For financial statements filed on or after **2027-01-01**: contributor street number +
street name and the individual's **major business affiliation** (the employer field) may
not be publicly released; **occupation is NOT restricted**; pre-2027 statements are
explicitly unaffected. Employer→industry processing therefore needs a filing-date
boundary and a fail-closed redaction test; occupation charts are unaffected.

## Phase 0 probe results (run 2026-08-27, re-run 2026-09-01, all gates green)

`npm run west-virginia-candidates:finance:probe` (client + parsers + phaseZero in
`backend/src/pipeline/westVirginiaFinance/`). Transport and parse problems throw as
they happen; the evidence gates run on the collected report and set `ok: false` +
`gate_failures` + exit 1 while still printing the evidence. Gates: every reconciled
committee non-empty and cent/multiset-exact, every CSV registrant in the registry, at
least one IE document in the window, a filed-report PDF with a text layer. Verified
live (2026-09-01 figures; the nightly files move a little between runs):

- Transport: TLS trust-first + pinned-intermediate fallback works; catalog 81
  artifacts; repeated mint+download byte-identical (determinism).
- Parsers: CON 2025 28,873 rows / $6,940,014.31 / 1 recovered; CON 2026 18,399 rows /
  $10,454,913.08 / 0 errors; EXP 2026 10,736 rows / $14,073,952.38 / 428 recovered —
  all cent-exact against the known totals.
- Join: all 705 CSV registrants (2025+2026) resolve in the committee registry (100%).
- Reporting cycles: 2026 Candidate/Committee cycles = 7 periods, 2025-07-01 ->
  2026-10-18 (cycle-membership scoping confirmed).
- Reconciliation: 6 committees (incl. embedded-quote fixture 1010003610 and two
  amended-report committees) all cent-exact + multiset-exact on (date, amount,
  category) -> committee-level amendment evidence (see above for its limits).
- Occupation (org 101 CON 2026, individual Monetary + In-Kind rows): 8,490 rows; >$250
  single-txn 2,694 with occupation 2,579 (95.7%) / employer 2,593 (96.3%); YTD>$250
  2,722 / occ 2,487; **165 distinct occupation labels** (top: Attorney/Legal 841,
  Retired 601, Business Owner 344, Healthcare/Medical 328, Not Currently Employed 304).
- Outside: all 93 IEC/ECC committees enumerated, 335 docs received 2025-26, **292 IE
  docs across 25 committees** (first run's registration-year filter saw 111); sample
  F-7b PDF has no text layer (scan, as expected); sample filed-report PDF (2026 Q2,
  1.3 MB) **has a text layer** -> cover extraction / cash_on_hand path is feasible.

## Phase 1 direct pipeline (built 2026-09-01, migration 267, flags off)

`backend/src/pipeline/westVirginiaFinance/`: artifact cache (content-addressed CSV/JSON
+ metadata pointer, 0700/0600), reporting-cycle windows, resolver, auto-link, due list,
cache-only sync, aggregator, writer, loader; CLIs
`west-virginia-candidates:finance:raw:refresh` (the only live caller — takes
`--election-year`, refreshes the three schedule files, resolves the window, then every
window year's CON/EXP/API-CON artifacts), `:auto-link` (live registry, one fetch per
batch) and `:sync-due`. Flags `WEST_VIRGINIA_CAMPAIGN_FINANCE_{ENABLED,SYNC_ENABLED,
RAW_DATA_REFRESH_ENABLED}`, all default false. Evidence gathered while building:

- **Window:** the `2026 Candidate Election Cycle` spans three schedule files — the 2027
  file holds a "2026 4th Quarter Report" period (2026-10-19 -> 2026-12-31) — so the
  cycle window is 2025-07-01 -> 2026-12-31 (data years 2025 + 2026). Committee-cycle
  and non-partisan cycles are separate strings.
- **Registry vocabulary (429 "2026 Election" State Candidate rows):** office
  `House of Delegates` 316 / `State Senator` 77 / `Undeclared` 21 / judicial 15; district
  is the plain seat number; candidateName is `Last, First Middle Suffix`
  (`Oliverio, Michael Angelo II`); status Active 355 / Terminated 74; three same-seat
  re-registered pairs (resolver reports them ambiguous). One legislative name carries a
  quoted nickname (`Jeffries, Warren "Dean"`), one a parenthesized one — manual links.
- **Signs:** `Return` rows are POSITIVE in both bulk files (CON: contribution returned to
  the donor; EXP: vendor refund) and are subtracted. API amounts are never negative.
- **API CON selector rows (2026, org 101):** Monetary/In-Kind/Other Income/Transfer/
  Return rows carry `transactionTypeDesc` "Contributions"; loan subtypes carry "Loans".
  The CON bulk file has no loan rows at all, so the LOAN-file overlap question does not
  touch the published totals. `transactionDate`/`filedDate` are ISO
  (`2026-06-30T00:00:00`); `transactionTotalYTD` stays unused.
- **Parsers on the 2025 files:** CON 2025 28,873 rows / 1 recovered; **EXP 2025 6,214
  rows / 310 recovered** (same bad-width class as 2026's 428); API-CON 2025 16,394 rows.
- **Dry-run sync on 8 real committees** (embedded-quote fixture 1010003610, top-3 2026
  totals, two committees with amended 2025 reports, two with Return rows): every year
  reconciled cent- and multiset-exact; prior-cycle committees produce zero in-window
  rows (the window rule keeps 2024-cycle money out).

Not built in Phase 1, on purpose: `cash_on_hand` (cover PDF layout never pinned),
`loans_received` / `debts_owed` (LOAN/DEB files unparsed), judicial offices (no November
races), the occupation label snapshot (labels publish verbatim as filed).

## Coverage boundary (statutory, verified)

SOS holds filings for statewide, State Senate, House of Delegates, non-magistrate
judicial, and multi-county districts. County candidates file with county clerks and
municipal with municipal recorders through 2026 — **CFRS is not a complete source for
2026 local races**. §3-8-5a: all financial statements for municipal/county/non-statewide
elections filed **after 2027-01-01** go to the SOS. Re-check CFRS + bulk files after that
date; do not assume back-migration of older local filings.

## Phase 2 local live run (2026-09-03, local DB only)

Rosters arrived 2026-09-02 (119 House/Senate contests, 242 `candidate_elections` rows,
all `declared`). Run, in order, from `backend/` with the two flags in `.env`:

```text
npm run west-virginia-candidates:finance:raw:refresh -- --election-year 2026 --force
npm run west-virginia-candidates:finance:auto-link -- --max-candidates 300
npm run west-virginia-candidates:finance:sync-due -- --dry-run --no-auto-link --max-candidates 300
npm run west-virginia-candidates:finance:sync-due -- --no-auto-link --max-candidates 300
```

Results: refresh 9 artifacts (REPS 2025/26/27, CON/EXP/API-CON 2025+2026; EXP recovered
310 + 428 bad-width rows, as in Phase 1). Auto-link **228 / 242** (217 on the Phase 1
resolver, +11 after the changes below). **15 manual links** (list below) close the rest,
so **all 242 roster rows are linked** through 243 links — Marta Beck holds two, see the
same-candidate note. Sync succeeded on every link; each window year reconciled cent- and
multiset-exact, 36 amended API rows absorbed. Across the 218 committees with in-window
rows: **$5,368,402 received, of which $4,645,349 is the qualifying contributions the app
publishes as "raised"** (receipts also carry self-funding, other income and transfers,
which the coverage note excludes), and **$3,212,818 spent**. Top raised Takubo $266k,
Barrett $229k, Oliverio $186k.

**A candidate may hold more than one committee.** The links table is unique on
(candidate, election, committee), and the shared ballot-lookup loader sums summaries
across all of a candidate's active links, so a second link is the supported way to
represent this — no summation policy of our own. When a candidate has two,
`controlled_committee_id` publishes as null, since no single committee controls the
money. Only pair committees this way after checking they are disjoint (see Beck below).

### Code changes forced by the live evidence

- **Resolver accepts registry office `Undeclared` for the same seat.** 21 "2026 Election"
  committees were registered before the candidate declared and keep office `Undeclared`
  (seat number filled) after certification — it is their only 2026 committee. Same seat
  + full-name rules still apply; a declared + undeclared pair for one person stays
  ambiguous. Known limit: an Undeclared row has no chamber, so the same seat number in
  the other chamber reaches it too; only a same-named second person on that seat could
  mislink, which the exact-office path cannot catch either. Unlocked 6 auto-links (Beach-Burge, Horst, Thorne, Young — 200 rows —,
  Pushkin, Holden) plus Hillenbrand by hand.
- **Double-quoted call names become parentheticals** on both sides before matching, so
  the shared matcher reads them as first-name aliases: `Jeffries, Warren "Dean"` ↔
  "Dean Jeffries", `Carl "Robbie" Martin` ↔ "Martin, Carl Robert" (was a ROBBIE/ROBERT
  middle-name conflict).
- **Nickname table** (`personFirstNameNicknames.ts`, shared): EDMUND/ED/EDDIE,
  NATHAN/NATE, NATHANIEL/NATE, PHILIP/PHIL, PHILLIP/PHIL (+ spelling pair), WESLEY/WES.
  Unlocked Wagoner, Stansberry, Mallow, Holden.
- **Zero in-window rows ⇒ NULL totals, not $0.** 25 linked committees have no CON/EXP
  row in 2025–2026 at all; 21 registered in 2026 (registry gives the year only), so few
  or no filings were due yet. The sync writes the summary row (so the due list sees it synced)
  with NULL totals and no breakdowns; the loader shows "unavailable". Re-sync after each
  filing wave (General report due 2026-10-23) turns them into numbers.

### Manual links (link_source `manual`; same seat and "2026 Election" unless noted)

| Roster | entityId | Registry name / evidence |
|---|---|---|
| C. D. Caldwell (HD 21) | 1010003677 | Caldwell, Carl Dean II — initials |
| Charles R. Sheedy Sr (HD 7) | 1010003517 | registry says "Jr."; committee is "Committee to Re-Elect Charles R. Sheedy Sr."; only Sheedy on the seat |
| D.R. Buck Jennings (HD 84) | 1010003791 | Jennings, DR Buck — dotted initials |
| David Green (HD 36) | 1010003526 | Green, Stephen David; "David Green for WV" |
| Henry Corby Dillon (HD 29) | 1010003599 | Dillon, Henry Corbett; 2024 row spelled Corby |
| Mandy Weirich (HD 67) | 1010003739 | Weirich, Mandana R; "Mandy for WV" |
| Michael B. (Mickey) Browning (HD 33) | 1010003924 | Browning, Michael Mickey; "Mickey for House" |
| Paige Reiring (HD 79) | 1010003958 | Reiring, Sydney Paige; "Paige Reiring for WV" |
| Ray Canterbury (HD 47) | 1010003767 | Canterbury, Denny Ray Jr.; 2024 row "Canterbury, Ray" |
| Rick Hillenbrand (HD 88) | 1010003520 | Hillenbrand, Frederick Rick III (Undeclared 88); 2022/2024 rows HD 88 |
| S. Chris Anders (HD 97) | 1010003541 | Anders, Stephen Christian; "Anders for WV" |
| Taylor Richmond (SD 13) | 1010003961 | re-registered pair; twin 1010003964 (Terminated) has zero cached rows |
| Marta Beck (HD 98) | 1010003604 **and** 1010003840 | both committees, see below |
| Christopher Marcus Ratliff (HD 45) | 1010003722 | registry files it under HD 50; the certified feed names this committee for his HD 45 write-in candidacy, see below |

### The two cases the resolver could not decide (settled 2026-09-03)

**Marta Beck, HD 98 — both committees linked.** She registered "Friends of Marta Beck"
in 2025 (1010003604), terminated it, and registered a second committee under the same
name in 2026 (1010003840). Both carry money inside the cycle window, which is why the
resolver reported the pair ambiguous. Evidence gathered before pairing them: **zero
identical (date, amount, contributor) rows across the two**, and **no transfer between
them** — the closed committee's last act was a "Disbursement of Excess Funds" back to
the candidate, not a hand-off — so the money is disjoint and summing cannot double-count.

| Committee | In-window rows | Receipts | Qualifying contributions | Spent |
|---|---|---|---|---|
| 1010003604 (Terminated) | 8 contributions, 5 expenditures | $1,610.00 | $1,610.00 | $769.06 |
| 1010003840 (Active) | 24 contributions, 23 expenditures | $3,195.67 | $2,257.29 | $579.09 |

Linking only the Active committee would have understated her by $1,610, a third of her
cycle money. With both linked the loader publishes $3,867.29 raised and $1,348.15 spent,
and merges the occupation and size breakdowns. The 2025 committee's pre-window money
($958.31, before 2025-07-01) stays out, the same rule everyone else gets.

**Christopher Marcus Ratliff, HD 45 — linked despite the district mismatch.** The
registry files entity 1010003722 under House of Delegates **50**, so the exact-seat
auto-linker skipped him. The SOS certified candidate feed settles it: he is a **write-in**
candidate in **HD 45** (filed 2026-08-07), and the feed's own `committeeName` for him is
"COMMITTEE TO ELECT CHRISTOPHER RATLIFF" — the exact `orgName` of 1010003722. No other
Ratliff runs for either seat. The roster is right and the committee registration's
district is stale. He has one contribution and one expenditure in window: $53.00
received, all Other Income, so **$0 raised** and $47.50 spent.

Certified-feed recipe (it decided this case, and the host serves an incomplete TLS
chain): `POST https://candidates.wvsos.gov/candidate-web-api/candidates` with
`{"size":5000}` (add `"candidateType":"W"` for write-ins — Ratliff appears only there),
a browser `User-Agent` plus `Origin`/`Referer`, and Node run with
`NODE_EXTRA_CA_CERTS=<the Entrust intermediate in westVirginiaCfrsIntermediateCa.ts>`.
Rows arrive under `data.candidates`; the seat is in `officeName`, not a district field.

### Operator notes

- Auto-link fetches the registry live (shares the sync flag); sync is cache-only.
  Re-run refresh before every sync wave; `--force` bypasses only the refresh flag.
- Prod (Phase 4): apply migration 267, set `WEST_VIRGINIA_CAMPAIGN_FINANCE_ENABLED`
  (read) in Render — already `"true"` in `render.yaml` — keep the sync flag off, promote
  the five `wv_candidate_finance_*` tables, deploy. Nothing is in prod yet.

## Phase 3 outside documents (built 2026-10-23, local DB only)

Scope: every registered IEC (org type 104) and ECC (org type 105) committee's
document store, filtered to "Independent Expenditure Report" / "Electioneering
Communication Report" documents received in 2025–2026. Live run 2026-10-23:
99 committees swept, **365 documents (all received in 2026), 30 filers**, 147 MB
of PDFs, cached under `scratch/west-virginia-campaign-finance/cfrs/outside-documents/`
with `inventory.json` (SHA-256 per file). CLI (live, refresh-flag gated):
`west-virginia-candidates:finance:outside-documents:refresh --received-year 2025 --received-year 2026`.

Reading: the forms are scanned F-7b / F-14 pages; OCR (pdftotext → tesseract)
was a hint only, every page was read by eye. Typed spreadsheet attachments
(West Virginians for Life, School Freedom Fund, NRA) were read row by row.

Ledger: `backend/evidence/west-virginia-finance/outside-document-ledger.json`
(`westVirginiaOutsideDocumentLedger.ts`), one entry per document pinned to the
PDF's SHA-256, one row per expenditure block. Targets are stored as the exact
roster storage name (`wv_candidate_finance_links.candidate_name_normalized`) plus
office and district, resolved at review time; non-roster targets (judicial races,
primary losers, non-candidates) keep `targetRosterName: null` and never publish.

Review outcome: 365 entries = **347 accepted, 14 rejected, 4 review**.
Accepted expenditures 2,365 rows / $8,250,222.40 as filed; 1,620 rows /
$3,932,538.77 aimed at November roster candidates. Rejected = byte-identical
re-uploads (4 pairs), four Mountaineer Freedom Alliance re-uploads with the
controller added, superseded amendments (Raise the Bar, WV for Life 9/14 and
10/1 restatements, WV First Patriots F-14 duplicate of its F-7b), and one F-7A
mislabeled as an IE report. Review = Sugar Maple 10833 (restates 10720), WV for
Life 10940 (restates 10791), 11210 and 11233 (10/1 spending restated as 11272 +
11274). Rules applied inside accepted entries, each noted on the entry:
negative amounts excluded (AFP 10657, 10661), blocks with both or neither stance
box marked excluded (Chamber 10864/10954, Coal Victory 10793, Home Sweet Home
10751, WVWA 10935/10985), joint two-candidate blocks left unmatched (Coal
Victory 10848/10913), "also in same mailer" notes without an amount excluded
(Conservative Policy Action 11264/11300).

Publication: the sync merges accepted ledger rows inside the cycle window with
the electronic IE rows per (spender, stance); provenance rows carry
`kind: "document"` and the stored-evidence guard lets a published document row
disappear only when the ledger entry is now `review`/`rejected`. The ledger
loader fails closed when the inventory is missing or a reviewed PDF's bytes
changed. Coverage note: registered IEC/ECC filers only (§3-8-2(c) SOS index
still unanswered).
