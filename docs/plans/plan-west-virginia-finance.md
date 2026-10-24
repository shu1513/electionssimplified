# West Virginia Campaign Finance Plan

Written 2026-08-26 after a live probe of the WV SOS Campaign Finance Reporting System
(bulk CSV catalog + downloads, Public-Service transaction/committee/document APIs, one
F-7b IE PDF pulled end-to-end) cross-validated against an independent 2026-08-03
feasibility report. Revised 2026-08-27 after an external review round; every adopted
correction was re-verified live before adoption (full-result occupation stats, 2025
reporting-schedule windows, CSV malformation counts, selector-total matrix, 2022 IE
stance rows, election-2026 registry counts, §3-8-6a text, the shared finance contract's
field shapes). Feasibility doc with raw endpoint details:
`backend/docs/west-virginia-campaign-finance.md` (exists untracked in this worktree; the
Phase 0 PR commits it). Verdict: **GO — direct finance is a conventional bulk-file
adapter; outside support/oppose is real but lives in scanned F-7b PDFs and gets its own
document-evidence phase.**

Scope: CFRS covers statewide, State Senate, House of Delegates, non-magistrate judicial,
and multi-county offices. County/municipal filings stay with local clerks until the
2027-01-01 centralization (§3-8-5a) — **CFRS is not a complete source for 2026 local
races and v1 claims nothing about them**. Federal races use the FEC path (§3-8-2 exempts
federal-candidate IEs; any F-7b naming a federal candidate is excluded). Registry
population for `election == "2026 Election"`: **427 State Candidate committees (353
active)** — House of Delegates 315, State Senate 77, judicial ~15, plus 21 Undeclared.
These are the *registration population*, not the November ballot cohort (they include
primary losers and terminated committees); **the VoteApp roster is the cohort
authority**, the registry is linkage evidence. VoteApp currently rosters zero of these
races — see Prerequisites.

## Verified sources (probed live 2026-08-26/27)

### Access reality: open API, hostile transport

`https://cfrs.wvsos.gov/api/Public-Service` — anonymous JSON, no auth, no CAPTCHA. But:

1. **Incomplete TLS chain** (server sends leaf + a second `CN=*.wvsos.gov` cert, no CA
   intermediate; `Verify return code: 21`). Client behavior: try normal system trust
   first; on failure, retry with the bundled intermediate appended for this exact host
   (**never** `rejectUnauthorized: false`), and count fallback uses as a metric. If the
   state fixes its chain, the fallback simply stops firing.
2. **Browser User-Agent mandatory.** Default curl/node UA → WAF `403 Forbidden` on every
   path including `/api`. Client sends a pinned desktop-Chrome UA string.
3. **Two services.** Data APIs on `api/Public-Service`; document presigned links on
   `api/Common-Service` (`/AmazonCloudFront/getDownloadLinkWithoutCookies`, body
   `{"s3FilePath": …}`). Both need gotchas 1–2.
4. Presigned S3 URLs (bulk CSVs and PDFs alike) expire in **3600s**, fetched plain from
   the S3 host. Mint→fetch atomically; store the S3 object path + bytes, never the URL;
   **redact the presigned query string from all logs and error messages** (it embeds
   `X-Amz-Security-Token` credentials).
5. The API self-describes: unknown members return `Could not find member 'x' …`.
   Parsers treat any HTML body (WAF page) or `isSuccess:false` as fail-closed.

### Bulk CSV catalog (raised / spent — the primary direct source)

`POST /AccessReport/getDataDownloadDataList` body **exactly
`{"pageNumber":1,"pageSize":5000}`** (a bare `{}` returns zero rows, not the catalog) →
**81 artifacts** — Contributions 2016–2026, Expenditures 2015–2026, Debts 2017–2026,
Loans 2016–2026, Filed reports 2014–2026, Registrations 2006–2026, Reporting Schedules
2025–2029. One file per (type, year), **regenerated nightly** (timestamp in the S3
object name). Download via `POST /AccessReport/getDataDownloadfile/{id}` → presigned URL.

**Files are cp1252 and malformed beyond encoding (verified):**

- Contributions: quote characters inside unquoted fields (2026 line 98:
  `…,Warren "Dean" Jeffries,…`) — strict RFC-4180 parsers fail; lenient parsing yields
  the correct 12-column rows. The 2025 file also has **1 bad-width row**
  (`Alonzio Perry, II` — generational-suffix comma in the contributor name).
- Expenditures 2026: **428 of 10,736 rows have 1–3 extra columns** (382×13, 25×14,
  21×15) from unescaped commas in recipient name/address; all keep a valid
  type/date/amount prefix and a recoverable trailing `FiledDate`.

Parser rules (implemented + green in Phase 0): header drift → fail the artifact.
Otherwise cp1252 (explicit 0x80–0x9F remap — Node's `TextDecoder("windows-1252")`
silently degrades to latin1 on small-ICU builds) + relaxed embedded quotes + per-column
typed validation. Bad-width rows in BOTH files: typed prefix + trailing fixed columns
valid → accept for totals, keep only the first column of the damaged name/address span
as the counterparty name (the ambiguous tail mixes in the street address and is
discarded), flag `recovered`; prefix invalid → row error, fail closed per committee.
"Fail on column drift" alone would brick the whole artifact over 4% cosmetic damage.

Contributions 2026 (18,396 rows, $10,454,673.08, 573 registrants, dates through the Q2
close 06-30): `RegistrantID, CommitteeName, CandidateName, TransactionType,
TransactionCategory, TransactionDate, TransactionAmount, ContributorPayeeType,
ContributorPayeeName, ContributorAddress, EmployerName, FiledDate`. Categories: Monetary
17,664 / In-Kind 471 / Other Income 164 / Receipt of Transfer of Excess Funds 93 /
Return 4. Contributor types: Individual 15,058, Business or Organization 1,653, PAC
1,036, Self 388, Candidate 231, Party/Caucus 30. 240 byte-identical duplicate rows
(ambiguous). **No occupation column, no election/cycle column, no report or version
column.**

Expenditures 2026 (10,736 rows, $14,073,952.38): Monetary 10,541 / Disbursement of
Excess Funds 191 / Return 4. **No IE flag, no target, no stance** — payee is the vendor.

Registrations 2026 (428 rows): names + type/subtype + status only — **no office, no
district**; never used for candidate linking.

Reporting Schedules: the 2026 file lists 2025-Q4 → General for the 2026 cycle; the
**2025 file shows the 2026 Candidate/Committee Election Cycle already running in 2025 Q3
(begin 2025-07-01)** — the cycle reaches further back than any single year's file
implies, and pre-candidacy activity can be earlier still. No cycle start date is
assumed anywhere; see hard fact 5. 2026 due dates: Q1 04-07, Primary 05-01, Q2 07-07,
Q3 10-07, **General (10-01→10-18) due 10-23**.

### Transaction search API (occupation + amendment metadata)

`POST /CommitteeTransactions/getAllPublicTransactionDataList`. **The
`transactionCategory` / `transactionTypeCode` selectors are unstable query modes, not
filters** (verified totals: no selector → 10,780; `transactionCategory:"CON"` → 18,685;
`"EXP"` → 10,780; `"IE"` → 29,534; `transactionTypeCode:"CON"` → 29; with
`orgTypeCode:"101"` + category `CON` → 11,506 rows that include Monetary, In-Kind,
Loans/Loan Payment/Loan Forgiveness, Transfers, Other Income, Returns). Client rule:
**always send `orgTypeCode`** (first three digits of `entityId`: 101 State Candidate,
102 State PAC, 104 IEC), then classify every returned row from its own
category/type/purpose response fields under a pinned mapping; contract-test the observed
selector×field combinations and fail closed on a new combination. Response
`transactionTypeDesc` can contradict the request mode — one more reason rows
self-classify. `pageSize:5000` works; **paginate on `totalRecords` — page 1 is not the
result set.**

Per-row fields the CSVs lack: **`employerOccupation`**, `amendedFlag`,
`reportVersionID`, `reportFileName`, `s3ReportFilePath`, `transactionID`, `orgID`,
`entityID`, `transactionTotalYTD`, stance/target/measure (IE grid only).

Occupation fill, full 2026 result (org 101 + CON, all 11,506 rows across 3 pages):
8,530 individual transactions; 2,723 single transactions > $250, of which **occupation
2,597 (95.4%), employer 2,611 (95.9%)**. Caveat: §3-8-5a triggers on a donor's
**election-cycle aggregate** over $250, not single-gift size, so single-transaction
fill is a proxy; rows with `transactionTotalYTD` > 250: 2,743, occupation 2,500
(91.1%) — but `transactionTotalYTD` semantics (YTD vs cycle, per-committee vs per-donor)
are unproven and get pinned in Phase 0. Values are a controlled vocabulary
("Attorney/Legal", "Construction/Engineering", "Retired", "Unknown"), not free text.

### Committee registry (candidate linkage)

`POST /Committee/getPublicCandidatesCommitteeDataList` `{"pageNumber":1,"pageSize":5000}`
→ all 2,967 committees: `orgID` (internal, keys the document API), **`entityId` (public
10-digit id; == bulk-CSV `RegistrantID` — the join key)**, `orgName`, `candidateName`
("Last, First M."), `orgType`/`orgSubType` (+codes), `office`, `district`, `party`,
`election`, `registrationYear`, `orgStatus`, `officerName`. Judicial encoding
(verified): **circuit lives in `office`** ("Circuit Court Judge, Circuit 15"),
**division lives in `district`** (numeric for circuit/family; string `"Division 1"` /
`"Division Undeclared"` for Supreme and Intermediate Court of Appeals).

### Outside spending: the document store is the source of record

**Decisive negative result:** F-7b Independent Expenditure filings do not become
structured transactions. Citizens for Better Communities (orgID 3981) — 3 IE PDFs,
**zero** structured transactions, zero filed-report rows. Across all 93 IEC/ECC
committees in the registry, documents received 2025–2026: **292 "Independent
Expenditure Report" PDFs from 25 committees** (probe re-run 2026-09-01; the first run
counted 111 because it only looked at committees registered 2025–2026 — Americans for
Prosperity, registered 2023, alone holds 129) vs 1 stance-populated 2026 grid row. Historical stance rows exist but are filer-specific:
2022 has **11** stance rows — every one from West Virginia Strong, Inc., the same
online-form filer behind the single 2026 row — out of 467 grid rows; 2024/2025 have
zero. The grid captures stance only when a filer e-files through the portal form; paper
F-7b filers (the overwhelming majority) bypass it. **Do not wait for October; the grid
will not fill in.** Structured stance rows are reconciled as a bonus check only.

Document chain (verified end-to-end): `POST /Committee/getAllPublicOrgDocumentDataList`
`{"orgID": …}` → `documentID, documentType, documentName, receivedDate, s3DocName`;
then Common-Service `getDownloadLinkWithoutCookies` → presigned URL → PDF. Fixture: a
2-page **image-only scan (no text layer)** of fixed Form F-7b (revised 4/26/2024):
filer, direction/control persons, filing-type checkboxes (Quarterly / Last-Minute /
Anytime), per-expenditure blocks — candidate name, election year, **In Support / In
Opposition checkboxes**, payee, amount, date, Primary/General/Special — page 2 =
purpose-specific contributor schedule (>$1,000 furthering-the-expenditure funders with
occupation + employer) + oath. Fixture values: Robert Fluharty / Opposition /
Mainstream Consulting, LLC / $4,000.00 / May 7 2026 / Primary; funder schedule blank.
**The form has no report-total field** — validators are per-expenditure-block only.

**Completeness boundary is bigger than the registry.** §3-8-2 applies to *any person*
crossing $1,000/yr, and the F-7b's own checkbox text describes quarterly filings by
"entities that are not registered as political committees." A registry IEC/ECC sweep
cannot prove it saw every filing — non-committee filers may or may not receive registry
`orgID`s. Until the SOS answers (below) or a global document index is found, outside
totals publish with the explicit limitation **"registered IEC/ECC filings only"** — or
stay `null`.

Statutes (fetched 2026-08-26/27): §3-8-2(a) IE >$1,000/yr must report candidate,
support/oppose, amount per candidate; (d)/(e) 24-hour report inside 15 days ($5,000
statewide/legislative, $500 county/municipal) and 48-hour report at $10,000; **(c)
obliges the SOS to publish candidate-by-candidate for/against IE indices**. §3-8-2b
electioneering communications: same candidate+stance disclosure, separate legal
category (3 ECC committees all-time; same document flow, distinct source type).
**§3-8-6a (effective 2027-01-01): contributor street number + street name and the
individual's *major business affiliation* may not be publicly released for statements
filed on or after 2027-01-01; occupation is NOT restricted; pre-2027 statements
unaffected.** See hard fact 10.

## Hard facts that shape the design

1. **Occupation is publishable as occupation — API-only, individuals-only, verbatim.**
   The shared contract's `top_occupations` takes free-text names (no canonical
   occupation taxonomy exists in the repo) — publish WV's controlled labels directly
   after whitespace normalization; blank and `"Unknown"` rows stay out of the breakdown,
   never inferred. Employer strings additionally feed the existing employer/donor
   industry-label path (`top_industries` renders only as fallback when occupations are
   absent — contract rule, so WV will normally show occupations). Because occupation
   rides only on API rows, the direct pipeline joins **CSV (totals authority) with API
   rows (attribute authority)** — fact 3 governs the join.
2. **Money model — explicit mapping onto the existing shared contract (no new fields
   needed; two optional ones used).**
   - `total_raised` (donor money) = Monetary + In-Kind from non-committee/non-self
     donors, Returns signed negative. Excludes Other Income, Transfers of Excess Funds,
     Self/Candidate rows, and loans.
   - `total_spent` = expenditure rows (Monetary + Disbursement of Excess Funds, Returns
     signed).
   - **`loans_received`** = LOAN-file rows (contract field exists; the CON grid's
     loan-subtype rows must be proven non-overlapping with the LOAN file in Phase 0 —
     double-count check).
   - **`debts_owed`** = DEB file if Phase 0 shows it carries outstanding balances.
   - **`public_funds_received`**: WV runs a Supreme Court public-financing program —
     Phase 0 checks whether the data distinguishes it (likely Other Income subtype);
     map only if the source distinguishes it.
   - `cash_on_hand` = only if Phase 0 proves filed-report covers are extractable and
     chain; otherwise omitted, never derived from transaction arithmetic.
   - Contribution-size buckets = positive itemized Monetary individual rows only, with
     `direct_coverage_note` naming exclusions.
   - The exact category×contributor-type×loan-subtype matrix is pinned in Phase 0
     against filed-report covers, not assumed.
3. **Amendments — the #1 Phase-0 question.** CSVs have no report/version identity; 240
   byte-identical duplicate rows are ambiguous. The API exposes `amendedFlag`,
   `reportVersionID`, `transactionID`. **Unknown: whether the nightly CSV holds
   current-version rows only, or original+amended side by side.** Phase 0 answers it by
   **per-report** reconciliation (not whole-committee sums, which can mask offsetting
   errors): for each gold committee's reports, CSV rows ↔ API current-version rows ↔
   cover totals, cent-level. Until then nothing aggregates. If versions coexist,
   resolution happens on the API side; the CSV demotes to discovery/checksum for those
   filers; unresolvable lineage quarantines the committee with dollar diagnostics.
4. **Row identity: none invented.** Bulk snapshots are full nightly replacements; rows
   are a multiset. Raw provenance = artifact SHA-256 + row ordinal. API `transactionID`
   used only where fact-3 resolution needs stable identity. Contributor street
   addresses: parsed, never written to product tables, never logged; artifact cache
   restricted (`0700`/`0600`); fixtures sanitized.
5. **Cycle windows come from report/cycle membership, not guessed dates.** The 2026
   cycle's reporting periods already run in 2025 Q3, and pre-candidacy activity can
   predate that. Harvest at least the **2024–2026** artifact years for the Nov-2026
   build; scope candidacy totals by REPS-file cycle membership (`ReportingCycle`
   strings) + committee `election` field + per-report evidence, with the exact rule
   pinned in Phase 0 from 2024–2026 data. Committees persist across cycles (a "…2022"
   committee re-registered for 2026) — a committee's full history never dumps onto the
   current candidacy. Ambiguous window → no publication.
6. **Candidate linkage: registry-only, exact-evidence, roster-authoritative.** Match
   registry `candidateName` + `office` + `district` + `election` against the VoteApp
   roster; `entityId` is committee identity, not person identity across cycles. House
   districts: 100 statewide-numbered single-member seats — no county qualification.
   Judicial: circuit parsed from `office`, division from `district` (string form for
   Supreme/ICA). Registry counts are the registration population; the roster decides
   who is on the November ballot. Ambiguous matches quarantine; manual links win.
7. **Outside support/oppose is a document-evidence product.** Inventory = every IEC +
   ECC org × every IE/EC-typed document, hashed and cached, plus the fact that this
   boundary is *known-incomplete* (non-committee filers) until the SOS answers. At ~292
   docs for 2025–26 and fixed form geometry, v1 extraction is **agent-read PDFs through
   the manual-research evidence pattern** (per-document ledger: candidate / stance /
   amount / date / payee / election + reviewer status), with deterministic per-block
   validators (checkbox exclusivity, amount format, candidate resolves against roster,
   election-year sanity). No OCR infrastructure in v1. Only `accepted` rows publish;
   discovered/parsed/accepted/needs-review counts live in the **ledger and sync
   manifest as operational diagnostics** (the public contract has no counter fields —
   the public artifact is `outside_coverage_note`). Stance never inferred from
   committee name, payee, or ideology. Un-extracted inventory → outside fields `null` +
   coverage note, never `$0`.
8. **Outside funders: evidence-only, no v1 UI.** The page-2 schedule is
   purpose-specific, not a donor list; blank schedule = **"No qualifying funder was
   listed on this filing."** The shared contract has no "funders of this expenditure"
   field — page-2 rows (with occupation/employer) are preserved in the ledger as
   evidence only, available to the outside-industry path later; IEC general receipts
   never merge with per-expenditure funder rows.
9. **Absent data ≠ zero.** A rostered candidate with no CFRS committee gets no finance
   link, not a zero snapshot. Acquisition cadence: **lightweight daily catalog + (in
   Phase 3) document-inventory poll** — late, amended, and final reports arrive anytime,
   so the schedule file informs *expectations*, not polling — with burst frequency
   (multiple sweeps/day) in the 15 days before the primary and general for 24h/48h IE
   filings.
10. **2027 privacy boundary (§3-8-6a).** For statements filed ≥ 2027-01-01: street
    number/name and **major business affiliation** (the employer field) are not
    publicly releasable; occupation is unaffected. The employer→industry path therefore
    gets a filing-date boundary and a **fail-closed redaction regression fixture**
    (post-2027 filings must produce no employer-derived output even if the state keeps
    exporting the column); pre-2027 filings unchanged. Also the 2027-01-01 local-filing
    centralization is a separate re-probe before any scope extension.

## Prerequisites

1. **Rosters — blocking for Phase 2, minimal form.** Districts + elections + candidate
   rosters for WV House of Delegates / State Senate / judicial Nov-2026 via
   `voteapp-manual-research`. **Profiles are not required for finance linking** and do
   not block. This is the critical path of the whole campaign.
2. **SOS email** (cheap, high-leverage; user decides whether to send): (a) the
   §3-8-2(c) candidate-by-candidate IE index as structured data; (b) whether
   non-committee F-7b/EC filers receive registry `orgID`s and appear in
   `getAllPublicOrgDocumentDataList`; (c) whether a global IE/EC document index/export
   exists (filer, document id/type, received date, path). Answer (a) collapses Phase 3
   into an import; answer (b)/(c) closes the completeness boundary. Phase 3 does not
   block on the answers but its published limitation depends on them.

## Architecture

New module `backend/src/pipeline/westVirginiaFinance/`, tables `wv_candidate_finance_*`
(≤63 chars), standard five-table shape via `createStandardStateFinanceSnapshotWriter`.
Factory config mirrors the standard pattern: pairing validation, replace-merge,
`supersededLinkSource: "west_virginia_cfrs"`, `manualLinkProtection` on. Closest
structural analogs: **NH/NM (bulk artifact + search API pairing)** for the direct path;
the outside path reuses the manual-research evidence-ledger pattern.

```text
westVirginiaCfrsClient.ts            # trust-first TLS with pinned-intermediate fallback (+ metric),
                                     # pinned UA, Public-Service/Common-Service split, atomic
                                     # mint→fetch for presigned URLs, presigned-query redaction,
                                     # fail-closed on HTML/isSuccess:false, bounded bodies,
                                     # exact-host allowlist, courteous throttle
westVirginiaCfrsArtifactAcquisition.ts # daily catalog poll → changed-object download; API page
                                     # harvests (totalRecords-driven pagination); document
                                     # inventory + PDF fetch; the only live-portal component
westVirginiaCfrsArtifactCache.ts     # NC pattern: SHA-256 + manifest + pinned parser version;
                                     # restricted perms; sync reads cache only
westVirginiaCfrsCsv.ts               # cp1252 + relaxed-quote CSV readers with typed per-column
                                     # validation and the EXP bad-width recovery rule; API row
                                     # normalizers with response-field self-classification;
                                     # catalog/doc-list parsers; header drift fails the artifact
westVirginiaReportingCycleWindows.ts # REPS cycle-membership windows (fact 5)
westVirginiaAmendmentResolution.ts   # fact-3 per-report CSV↔API↔cover reconciliation + lineage
westVirginiaCandidateCommitteeResolver.ts # registry office/district/election evidence incl.
                                     # judicial circuit/division parse; roster-authoritative
westVirginiaCandidateFinanceAutoLink.ts
westVirginiaCandidateFinanceDueList.ts
westVirginiaCandidateFinanceBatchSync.ts
westVirginiaCandidateFinanceSync.ts  # cache-only; runs fact-2/3/5 gates before writing
westVirginiaDirectContributionAggregator.ts # money matrix incl. loans/debts, size buckets,
                                     # verbatim occupation breakdown, employer→industry handoff
                                     # with the §3-8-6a filing-date boundary
westVirginiaOutsideDocumentInventory.ts # IEC/ECC sweep × doc enumeration; completeness counters;
                                     # burst-sweep mode; known-incomplete boundary flag
westVirginiaOutsideEvidenceLedger.ts # F-7b/EC extraction rows + per-block validators + review
                                     # status; page-2 funder evidence; only `accepted` publishes
westVirginiaFinanceEligibleOffices.ts # from registry office vocabulary, not guessed
westVirginiaFinanceWriter.ts
westVirginiaBallotLookupFinanceLoader.ts # direct + occupation breakdowns + loans/debts; outside
                                     # totals from accepted ledger rows with the
                                     # registered-filers-only coverage note, else null
index.ts
```

Launch checklist items (per `voteapp-new-state-finance-checklist`, baked into phase PRs):

- Flags, code defaults all `false` in `backend/src/config/featureFlags.ts`:
  `WEST_VIRGINIA_CAMPAIGN_FINANCE_ENABLED`,
  `WEST_VIRGINIA_CAMPAIGN_FINANCE_SYNC_ENABLED`,
  `WEST_VIRGINIA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED` (house pattern: sync is
  cache-only unless the refresh flag allows live fetches). First two into `backend/.env`
  (alphabetical) + read flag into `render.yaml`; refresh flag per-run only.
- Source plumbing — all four spots: (1) source union + runtime list in
  `backend/src/pipeline/address/ballotLookupFinanceShared.ts` (`WEST_VIRGINIA_CFRS`);
  (2) `FINANCE_SOURCE_LABELS` entry `"West Virginia Campaign Finance Reporting System"`
  in `packages/api-client/src/format.ts` (alphabetical) + `format.test.ts` case;
  (3) source home-URL map in `packages/api-client/src/finance.ts`
  (`https://cfrs.wvsos.gov/`); (4) `FINANCE_SOURCE_LABELS` test.

## Phases (each its own PR; probe before schema)

### Phase 0 — probe PR (no schema, no publication)

`npm run west-virginia-candidates:finance:probe` (`probeWestVirginiaCandidateFinance.ts`)
on the client + acquisition layers; the PR commits
`backend/docs/west-virginia-campaign-finance.md`. Gold set: 3 House of Delegates 2026
committees (≥1 amended filing), 2 State Senate, 1 Supreme Court (public-financing
check), 1 filer with Returns + Transfers, 1 filer with loans, the Jeffries committee
(1010003610 — embedded-quote fixture), ≥3 committees owning bad-width EXP rows, 1
cross-cycle re-registration, West Virginia Strong (structured-stance filer, 2022+2026),
Citizens for Better Communities orgID 3981 (doc-only fixture), 1 terminated committee.
Hard gates:

1. **Transport determinism**: trust-first/fallback TLS + pinned UA fetches catalog →
   CSV → API pages → doc PDF; two fresh harvests of the same nightly artifact
   byte-identical; presigned mint→fetch atomic; no presigned query in any log line.
2. **Malformed-CSV recovery**: parser passes the full 2026 CON file (embedded quotes)
   and recovers all 428 bad-width EXP rows under the prefix rule; recovered totals
   reconcile against API sums for the owning committees.
3. **Amendment semantics (fact 3)**: **per-report** CSV↔API-current↔cover
   reconciliation on every gold committee incl. the amended fixture; lineage rule
   pinned; CSV-vs-API authority decided per filer class.
4. **Money-model matrix (fact 2)**: every observed category × contributor-type × loan
   subtype cell mapped to `total_raised` / `total_spent` / `loans_received` /
   `debts_owed` / excluded, against real covers; LOAN-file vs CON-grid loan rows proven
   non-overlapping; Returns/Transfers/In-Kind placement pinned; Supreme Court
   public-financing signal checked for `public_funds_received`.
5. **Cycle windows (fact 5)**: inspect 2024–2026 REPS + transaction data; pin the
   cycle-membership rule; the cross-cycle fixture's prior-cycle money must stay out.
6. **Occupation semantics**: full distinct-value sweep of `employerOccupation` (2025 +
   2026); pin `transactionTotalYTD` semantics (YTD vs cycle, per-donor vs
   per-committee) or fall back to deterministic donor aggregation for the
   statute-aligned coverage number; verbatim-label publication list finalized
   (blank/`Unknown` excluded).
7. **Linkage gate**: registry sweep → `westVirginiaFinanceEligibleOffices.ts`
   vocabulary; `entityId`↔`RegistrantID` join proven on gold filers; judicial
   circuit/division parse (incl. `"Division Undeclared"`) exercised.
8. **Outside inventory dry run**: full IEC+ECC sweep × doc enumeration (~292 IE docs
   received 2025–26 across 25 committees); pull 5 F-7bs spanning filing types + both stances + a
   multi-expenditure form; confirm fixed geometry; ledger row shape + per-block
   validator list pinned; document the non-committee-filer boundary as
   known-incomplete pending SOS answers.
9. **Cover extractability**: are e-filed report PDFs text PDFs with usable summary
   totals? Decides `cash_on_hand` and the strength of gate 3's third leg.

### Phase 1 — direct-finance path PR (schema through loader, defaults off)

Migration `NNN_add_west_virginia_campaign_finance_tables.sql` (next free number at
merge time): the five canonical `wv_` tables; the outside-evidence ledger table only if
Phase 0 pinned its shape — otherwise it waits for Phase 3. Writer + resolver +
auto-link + due list + sync + aggregator + windows + amendment resolution + loader,
all behind `false` defaults; flags + all four source-plumbing spots. Tests: writer
transactional snapshot, manual-link guard, malformed-CSV parser contracts off sanitized
Phase-0 fixtures (embedded-quote + all three bad-width shapes), amendment-resolution and
money-matrix gates off fixture data, occupation label-list snapshot (new state value =
visible diff, not silent pass-through), **§3-8-6a redaction regression fixture**
(post-2027-dated filing → zero employer-derived output).

**Built 2026-09-01 (migration 267; flags off; PR pending).** Decisions taken while
building, each verified against the live portal or the cached 2025–2026 artifacts:

- **Scope = House of Delegates + State Senate only.** Statewide executive offices run in
  presidential years, judicial races are decided at the May primary, and county/municipal
  filings stay local until 2027, so nothing else is on the November 2026 ballot to link.
  The judicial circuit/division parse is deferred until a judicial roster exists.
- **Window rule pinned:** `<year> Candidate Election Cycle` rows across the election
  year's three schedule files (y−1, y, y+1). The 2027 file adds a "2026 4th Quarter"
  period (2026-10-19 → 12-31), so the 2026 window is **2025-07-01 → 2026-12-31**; a
  missing schedule file fails the sync closed rather than shortening the window.
- **Amendment gate = per-year committee-level CSV↔API multiset reconciliation** (the
  Phase 0 evidence, re-proved on every sync). Per-report cover-total reconciliation and
  `cash_on_hand` are NOT built: the cover PDF layout was never pinned, so `cash_on_hand`
  stays NULL rather than guessed. `loans_received` / `debts_owed` also stay unpublished
  (LOAN/DEB files unparsed; the CON bulk file carries no loan rows, so totals are clean).
- **Money model as pinned:** `Return` rows carry positive amounts in both files and are
  subtracted; donors = individuals, businesses, PACs, party committees; Self/Candidate,
  Other Income and transfers stay out of "Raised" (the coverage note says so).
- **Occupation** = verbatim controlled label from API Monetary + In-Kind individual rows
  (blank / "Unknown" excluded; no snapshot list — labels publish as filed). **Industry** =
  CSV employer of the same rows through the rule classifier, only for statements filed
  before 2027-01-01 (redaction fixture in the aggregator test); recovered rows skip it.
- **Resolver limits (fail closed to manual links):** re-registered same-seat pairs (3 in
  the 2026 population) and "goes-by" names the shared matcher cannot align — the
  registry writes `Jeffries, Warren "Dean"` (1 of 393 legislative names; a
  parenthesized `(Les)` is the only other) so a roster "Dean Jeffries" is unmatched while
  "Warren Jeffries" links.
- Dry-run sync on real cached data (8 committees incl. the embedded-quote fixture and
  two with amended 2025 reports): every year reconciled cent- and multiset-exact.

### Phase 2 — rosters, then local live run + enablement

Blocked on Prerequisite 1 (districts + elections + rosters only). Then: 2024–2026
acquisition, auto-link against the rosters, reconciliation-gated sync for the Nov-2026
cohort, `.env` flags on locally, operator checklist. Prod promotion stays a separate
explicit operator action per house rule.

**Done 2026-09-03 (local only).** Rosters landed 2026-09-02 (119 legislative contests,
242 candidate rows). Live run: refresh (9 artifacts, window 2025-07-01 → 2026-12-31) →
auto-link **228** → 15 evidence-backed manual links → **all 242 roster rows linked**
(243 links; Marta Beck holds two committees) → sync reconciled cent- and multiset-exact
on every link (36 amended API rows absorbed), **$4.65M in qualifying contributions out
of $5.37M received, $3.21M spent** across 218 committees; 25 committees with no rows in
the window publish NULL. The two cases the resolver refused are settled: Beck's two
committees are provably disjoint, so both are linked and the shared loader sums them;
Ratliff is a certified write-in in HD 45 whose committee the SOS feed names for him,
despite the registry filing it under HD 50. Three small
code changes came out of the live evidence — see
`backend/docs/west-virginia-campaign-finance.md` "Phase 2" for the resolver widening
(office `Undeclared`, quoted call names), the nickname-table additions, the NULL-totals
rule, the manual-link evidence list and the operator recipe. `render.yaml` read flag
now `"true"` (sync flag stays off in prod).

### Phase 3 — outside documents (support / oppose)

Inventory module + evidence ledger + agent extraction runs (batched, ~292 docs; each
doc = ledger row + validator pass + accept/review status), reconciliation against
structured-stance grid rows (WV Strong), loader publication of support/oppose totals
for `accepted`-only evidence carrying the **"registered IEC/ECC filings only"**
coverage note (dropped only if the SOS confirms the registry boundary is complete or
provides a global index). Burst sweeps armed 2026-10-19 → 11-03 for 24h/48h filings.
ECC documents flow through the same ledger as a distinct legal category. A structured
§3-8-2(c) index from the SOS collapses this phase into a conventional import with the
ledger as audit trail.

**Built 2026-10-23 (local DB only).** Inventory module + refresh CLI, reviewed ledger
(365 documents: 347 accepted / 14 rejected / 4 review), sync merge with the electronic
IE path, document-aware stored-evidence guard. See `backend/docs/west-virginia-campaign-finance.md`
"Phase 3 outside documents".

### Phase 4 — prod promotion

Standard new-state checklist: migrations, data promotion, flags in Render env +
`render.yaml`, manual deploy (Render never auto-deploys), post-deploy verification.
Re-probe near Nov for the General-report wave (due 2026-10-23).

## Validation / acceptance

- Every published number traces to cached artifacts (CSV/PDF SHA-256 + row ordinal or
  ledger row) and passed the fact-2/3/5 gates; re-running sync on an unchanged cache
  yields an identical snapshot.
- Occupation breakdown = verbatim state labels (blank/`Unknown` excluded); nothing
  inferred from employer, name, or address; employer→industry only through the existing
  classifier and only for pre-2027-filed statements.
- Outside totals contain `accepted` ledger rows only; stance never inferred; blank
  funder schedules read "No qualifying funder was listed on this filing"; incomplete or
  boundary-limited inventory publishes `null` or the registered-filers-only note, never
  a silently-complete `$0`; federal-candidate F-7bs excluded.
- No-committee candidates get no link (not zero); no contributor street address in any
  product table or log; no presigned query strings in logs.
- Fail closed on: WAF HTML body, `isSuccess:false`, header drift, typed-column
  validation failure outside the pinned EXP recovery rule, catalog artifact missing for
  an in-scope year, per-report CSV↔API↔cover mismatch beyond Phase-0-documented
  classes, ambiguous amendment lineage, ambiguous cycle window, ambiguous candidate
  match, unrecognized selector×field combination, checkbox-ambiguous F-7b block.
