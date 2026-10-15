# Georgia campaign finance — implementation plan

## October 2026 finance-gap follow-up

This follow-up stays in one Georgia PR under the current task's one-state-per-PR requirement. Flags are passed inline; do not read, copy or edit environment files. Existing source observations below retain their original dates.

The ordinary batch already fetches PeachFile independent expenditures and calls the outside aggregator. The remaining failure boundary is direct-finance acquisition/reconciliation before the outside write. A failed direct ledger can therefore prevent otherwise available independent expenditures from refreshing. Outside-spender funder acquisition already degrades separately. An independent component must preserve direct amounts and their acquisition/write clocks, active/manual receiving links, genuine source failures and qualified zeros.

The current official bulk data key distinguishes **Contributor Type** from the receiving filer's **Registration Type/Subtype**. Explicit reported committee classes can support an honestly labelled committee-contribution component; business codes and names containing PAC cannot establish that role. A genuine current export is retained privately for structural, return, scope and amendment qualification. Diagnostic sums are not accepted financial data. Preserve the current JSON occupation path; bulk contributor-role coverage is a separate feature.

The first implementation step strengthens the existing IE client: check native `totalItems` when supplied, require complete consecutive financial payloads rather than ID-set equality, reject conflicting duplicate IDs and malformed target arrays, and accept only safe exact cents. Retain valid timed-only rows, the unchanged ordinary request shape, and the empty-store failure guard. No transaction-date cutoff is inferred from a current election year.

The native contribution adapter selects **Non-Candidate Committee** and **Candidate / Candidate Committee**, candidate-campaign receivers, `Contribution` / `Itemized Contribution`, and the explicit allocated election year. It preserves distinct native occurrences and reported amended/timed-only records. Loans, in-kind receipts, unitemized/anonymous money, other allocated years and separately reported returns stay outside this gross contribution measure. The mixed **Corporation / Business / Unregistered Committee** class stays excluded. This is reported committee money before returns, not verified legal PAC identity or a net/current-effective ledger claim.

The observed Windows-1252 CSV dialect includes literal Excel guards and proper quoted multiline cells. Closing-quote errors, attributable malformed continuations and a NUL in a known receiver's record quarantine that receiver's entire component; unknown boundaries, undefined encoding bytes, bad headers and truncated endings make the source unavailable. Original values are never repaired or reconstructed. Unrelated loan-detail duplicate IDs do not gate committee contributions; relevant duplicate IDs hold affected receivers.

`georgia-reported-finance:sources:refresh` is the ordinary acquisition command. Each enabled source installs exact originals in an immutable generation, validates before publishing an atomic pointer, and retains the prior generation on failure. Cache readers verify manifest and original hashes and rerun the native parser/client. Source observation and completion clocks survive cached replay. New reported IE and committee-contribution flags default off under both finance parents; force cannot enable them. The raw-refresh gate is separate. Acquisition performs no canonical financial writes.

The [current official filing schedule](https://ethics.ga.gov/filing-schedule/), checked October 15, distinguishes these deadlines:

- CCDR all-filer and PAC tables each show August 1–October 20 reporting periods, **October 20 due**, and **October 27 end of grace**.
- Independent Committees' general-election 14-day report is separately **due October 20**. That section does not publish a separate period or grace date.
- Fresh acquisition and ordinary sync must rerun **October 21 and October 28**, with **November 2, November 4 and November 6** late/timed-report checks, allowing for the actual source publication clock and two-business-day filing interval. These are planned checks, not scheduled automations or finality guarantees.

Before this PR opens, run the committed acquisition path over an ordinary due cohort, verify canonical counts and a candidate's amounts, then inspect the production API and actual candidate card. Source-parser replay, old stored groups, preservation-only results or fixture money do not satisfy that proof.

Date: 2026-08-06. Governs the Georgia state-finance build. Read alongside
`plan.md` ("Pause point — add new states") and
`docs/finance-module-capability-matrix.md` — their rules apply to every PR
here. Feasibility: agent report dated 2026-08-02, then independently
re-verified live on 2026-08-06 against both source systems (this session;
findings below **supersede** the agent report where they differ). Do not
re-hit the portals during code-only PRs — portal work happens in the
acquisition spike PR, when authorized.

## Verdict

Georgia is born on the shared factories with **zero migration debt** and
**zero new factory capability**. Canonical identity (`committee_id` =
PeachFile numeric `filerEntityId`, `committee_name`), all 5 standard tables,
standard summary columns, std direct categories (`occupation` +
`contribution_size`), donor/industry outside breakdowns. All four product
features are supported by verified live data:

1. Total raised / total spent / cash on hand — official full-cycle totals in
   the PeachFile candidate index (verified: Carr $5,374,711.06 raised,
   $1,167,791.24 cash).
2. Top donor occupations — occupation + employer populated per transaction in
   the search APIs of both systems (verified: Carr → Retired 648, Attorney
   127, …; `Information Requested` is a real placeholder value).
3. Outside support/oppose — structured IE targets with stance, office,
   jurisdiction, district, and a **stable `filerRegistrationGuid` join** to
   the candidate registration (no name matching).
4. Outside-group funders/industries — outside spenders are ordinary filers;
   their itemized contributions come from the same search APIs.

Reference sibling: **tennessee** (HTTP JSON client per linked candidate —
`tennesseeCampClient.ts` shape), NOT ohio (statewide-bulk streaming). Reason
is finding F1 below.

## Two source systems (both required)

| Period | System | API host | Access |
|---|---|---|---|
| 2022 – 2025-06-30 (by report) | EFile archive, frozen 03/06/2026 | `api-recordsearch.ethics.ga.gov` | Search APIs work via plain fetch; bulk-export endpoint 406s for non-browser clients |
| 2025-07-01 onward (by report) | PeachFile, nightly extract | `api-peachfile.ethics.ga.gov` | Search APIs AND bulk export work via plain fetch |
| 2005–2021 legacy | media.ethics.ga.gov | — | Out of scope v1 |

A 2026-cycle candidate has 2025 activity in the archive and 2026 activity in
PeachFile. **The spike killed the clean-date-partition picture** (results
item 1): PeachFile migrated some filers' pre-cutover reports (with re-keyed
ids and content drift), other filers' pre-cutover reports exist only in the
archive, and the archive kept accepting special-election reports with
periods into late 2025. The boundary is **per registration and per report**,
never a global date — see the spike results for the source-selection rule.

## Live-verified findings (2026-08-06)

Numbered like Ohio's decisions; **F** = fact probed from real bytes.

- **F1 — statewide bulk contribution CSV has occupation/employer 100%
  blank.** `POST /api/ExportPublicData/GetExportPublicDownloadData`, body
  `{"transactionTypeCode":"TCON","type":"CSV","filingYear":"2026"}` → 74 MB
  CSV; all 119,962 itemized-individual rows have empty
  `Contributor/Person Responsible for Loan Occupation` and `... Employer`
  columns. The columns exist in the data key; the export does not populate
  them. **Therefore the bulk file cannot be the production transaction
  source for the occupation feature.** The per-transaction search API
  populates both fields.
- **F2 — per-filer transaction search API is the production source.**
  `POST /api/PublicTransactionDetails/GetTransactionDetails` (both hosts).
  Filter body includes `transactionTypeCode:"TCON"`, `filerName`, dates,
  election year. Items carry `transactionId`, `filerEntityId`, `filerName`,
  `sourceName`, `payeeOccupation`, `payeeEmployer`, `transactionSubTypeDesc`,
  `transactionStatusCode`, `filerReportId`, `filerReportVersionId`,
  `electionYear`, `electionType`, `transactionAmount`, `reportName`.
  **`pageSize` hard cap 100** — anything larger is rejected by the WAF with
  `{"message":"Potentially harmful payload detected!"}` (F2a). Archive
  returns `totalItems`; PeachFile returns `totalRows: null` on this endpoint
  — page until short page (F2b).
- **F3 — candidate index gives resolver identity AND full-cycle official
  totals.** `POST /api/PublicFilerDetails/GetCandidateDetails`
  (`filerTypeCode:"RC"`). Items carry candidate name parts, `committeeName`,
  `office`/`officeId`, `districtName`/`districtId`, jurisdiction fields,
  `politicalPartyCode`, `electionCycleName`, `filerStatusCode`,
  `filerEntityId`, `filerRegistrationId`, `guid`, and `totalContributions`,
  `totalExpenditures`, `cashOnHand`. Verified the totals are **whole-cycle
  across both systems** (Carr: index $5.37M vs PeachFile-only transaction sum
  $1.80M). These are the summary source and the reconciliation anchor.
- **F4 — filer identity splits across systems, and worse.** Carr has THREE
  filer ids: archive legacy `2750` (his 2022 AG committee — which ALSO
  carries $995k of 2026-cycle rows), archive `757274`
  ("Carr, Christopher Michael"), PeachFile `100035`
  ("Carr for Georgia, Inc."). Archive-757274-2026 + PeachFile = $5.27M vs
  official $5.37M — a $103k residual whose composition is UNPROVEN: the
  legacy filer's 2026-cycle rows total $995k, so at most a slice of them is
  inside the official total (which slice, and whether the residual involves
  them at all, is spike work — A6). A naive per-year split **loses money**,
  and an office-exact filer match can never surface the legacy committee. A
  per-candidate cross-system filer map is mandatory (decision D3).
- **F5 — independent expenditures.**
  `POST /api/PublicIndependentExpenditureDetails/GetIndependentExpenditureDetails`
  (both hosts; PeachFile 551 txns, archive 3,679 as of probe). Each item:
  spender (`filerName`, `filerRegistrationGuid`, committee contact block),
  `amountApplied`, `transactionId`, `filerReportVersionId`, report name, and
  `candidateMeasures[]` — each target with `candidateMeasureTitle` (usually
  the candidate COMMITTEE name), `officeName`/`officeId`, jurisdiction
  fields, `districtName`/`districtId`, `stance` (`Support`/`Oppose`),
  `reasonTypeCode` (`CAN` = candidate; ballot/amendment codes excluded), and
  the target's **`filerRegistrationGuid`** → ID join to the candidate
  registration. Archive targets are weaker: office/jurisdiction often null,
  `candidateMeasureTitle` = "Last, First (Committee Name)".
- **F6 — no per-target amount exists anywhere.** Not in the JSON
  (`candidateMeasures[]` has no amount), not in the bulk CSV (header row
  carries the amount with blank target columns; target rows carry
  stance/target with blank amount, sharing the `Transaction ID`). Probed
  filing-year-2026 file: 387 IE transactions, 338 single-target, **49
  multi-target (~13%), up to 21 targets on one transaction**. → decision D6.
- **F7 — filtered grid download exists but is inferior.**
  `POST /api/PublicGridDownload/DownloadPublicGridData`
  (`publicGridName:"ContributionsPublicGrid"` + the search filter) returns a
  filtered CSV that DOES include occupation/employer — but has no
  transaction id and no amended flag. Use only as a validation cross-check,
  never as the production source.
- **F8 — bulk files still useful for reconciliation.** PeachFile bulk
  TCON/TEXP work via plain fetch and carry `Transaction Id` + `Amended` +
  report names; use them as cycle-level cross-checks of the API-synced rows
  (not as the primary source; F1). Archive bulk export is 406-blocked for
  non-browser clients — archive checks go through its search APIs.
- **F9 — CSV/parser hazards** (for the bulk cross-check path and fixtures):
  cp1252 bytes (0xa0 seen), Excel-guard zips `="30026"`, amounts
  `"$1,000.00"`, **parenthesized amount = returned transaction** (per data
  key), occasional ragged rows (embedded newlines), a handful of stray rows
  with transaction dates 2001–2024 and off-cycle `Election Year` values
  (filter on election year + cycle). Archive dates are ISO
  (`2025-06-30`), PeachFile dates are `MM/DD/YYYY`. Archive occupation
  values are right-padded with spaces — trim.
- **F10 — data keys are versioned schema contracts.**
  `POST /api/PublicFiledReportAndDownload/DownloadFileTemplate/?transactionTypeCode=TCON&fileName=Data%20Key%20Detail`
  → PDF (same for TEXP). Fixture copies retrieved 2026-08-06. "Filing Year"
  on the download page = filing/report cycle, **not** transaction year
  (verified: filing-year-2026 file contains H2-2025 transactions).

## Settled design decisions

1. **D1 — transport**: JSON search APIs on both hosts, per linked candidate
   (TN-style client), `pageSize` 100, polite delay between pages, exact
   fail-closed on non-200/non-JSON. No headless-browser dependency. The
   PeachFile bulk endpoints are a separate, optional reconciliation artifact
   path (F8) cached with manifests per the pause-point rules.
2. **D2 — committee identity**: `committee_id` = PeachFile `filerEntityId`
   (numeric, strict validation + trim), `committee_name` = PeachFile
   committee name. Canonical 5-table schema, no extra link columns.
3. **D3 — cross-system filer identity map**: one Georgia-specific extra
   table (`ga_finance_filer_identity_map`) covering **every filer role we
   join on — candidate committees AND outside spenders** (archive IEs carry
   archive spender ids; PeachFile IEs carry PeachFile ids; the same PAC
   spending in both halves of the cycle must land under one outside-group
   identity). Rows: canonical (PeachFile) filer id ↔ per-system
   `filerEntityId` + registration `guid`, role, cycle, provenance,
   verified-at; multiple source ids per canonical entity mean **the same
   registration chain re-keyed across systems** (A6: archive `757274` ↔
   PeachFile `100035` — one committee, two ids). **A legally separate
   committee is NEVER a source id of the candidate's canonical entity**
   (A6 refuted the earlier F4 reading): Carr's legacy `2750` is its own
   terminated ledger (termination signal = `filerStatusCode: "T"` — never
   the `isTerminated` boolean, which is `false` on this very registration;
   see D8's string-codes-only rule) whose $1,202,308.37 stays out of
   candidate totals —
   Georgia's own official number excludes it, and its only crossing is an
   $8,400 capped transfer that appears as an ordinary itemized contribution
   row. Legacy committees get mapped, if at all, as distinct entities
   (relevant as donors or outside-spender identities), and the map schema
   must make candidate-total inclusion an explicit per-row property, not a
   consequence of sharing a canonical id. Discovery still collects **every
   archive filer associated with the candidate by name + cycle as
   evidence** — office match is corroboration, never a discovery filter,
   because a legacy committee registered for a prior race's office (Carr's
   2022 AG committee) can carry current-cycle rows and an office-exact rule
   could never propose it for the map at all. Inclusion in candidate totals
   is then decided by reconciling the candidate filer set against the
   official candidate-index totals; a cross-office carryover filer enters
   the map only with manual confirmation. Ambiguous → manual review, fail
   closed. **The map table's migration lands post-spike**
   (its shape depends on A6); the 5 canonical tables don't wait for it.
   **Name-form facts pinned at the spike** (results item 3): archive
   transaction search keys candidate filers by the person's display name
   ("Carr, Christopher Michael" — one query returns rows across ALL of the
   person's committees, including the legacy one), and does NOT match
   committee names; PeachFile keys the same search by committee name and
   does not match "Last, First" person names. `filerEntityId` AND
   `transactionId` are both re-keyed between systems (zero shared ids on the
   same report's rows), so cross-system row identity is (date, source,
   amount) at best — another reason report-level, not row-level,
   source selection. Discovery therefore queries **both hosts'
   `GetFilerReport` inventories and candidate indexes**, with per-host name
   forms, and the map stores the per-host names it verified.
4. **D4 — summary source**: candidate-index totals (F3) are official and
   full-cycle, and Georgia's "total contributions" includes loans, interest,
   and unitemized money — it is NOT an itemized/direct subtotal. The shared
   loader also displays `direct_contribution_total ?? total_receipts`
   (`standardStateFinanceBallotLookupLoader.ts` total_raised), so writing a
   computed itemized sum there would hide the official number. **v1: write
   index totals to `totalReceipts`/`totalDisbursements`/`cashOnHand`; leave
   `directContributionTotal` NULL.** Itemized/direct sums stay as sync
   diagnostics and reconciliation inputs only — material unexplained
   difference (beyond nightly-extract timing) → keep previous good
   snapshot. Occupation and size breakdowns are unaffected. (Do not add a
   loader preference variant for this — zero new factory capability.)
   **Index semantics — REVISED 2026-08-09 (supersedes the spike's item 6;
   see the ROOT CAUSE Status entry):** the index total is PeachFile's
   cumulative **report-cover accumulator**
   (`GetFinancialSummaryDetails.monetaryContributionsCumulative`), seeded
   per-filer at migration — NOT a transaction sum. The spike's
   to-the-cent Carr decomposition held only because Carr's full history was
   migrated, making the two models coincide; for legislators the official
   total routinely counts cover money whose transactions never entered the
   PeachFile store, and NEVER counts unmigrated archive ledgers. The guard
   therefore does not require rows to equal the index: it fails closed on
   zero recognized dollars against a nonzero total, and on rows EXCEEDING
   the total (foreign ledger); under-coverage is expected and disclosed
   (`uncoveredOfficialAmount` + the D12 direct coverage note).
5. **D5 — occupation rules**: individuals only; filed value only; blanks and
   placeholders (`N/A`, `Unknown`, `Information Requested`, empty) → unknown
   bucket; keep `Retired`/`Student`/`Homemaker`/`Self-employed` as-is;
   aggregate dollars, not row counts; unitemized dollars are never assigned
   to occupation or size buckets. **Returned contributions are excluded from
   breakdowns and counted in a diagnostic — now permanent** (A9 answered):
   a return is its own `Return Contribution` transaction with an
   always-negative amount and a free-text reason, with **no structural link
   to the original row** (contributor-name matching is the only join), so
   subtract-in-place is not safely expressible, ever. Totals are unaffected
   (they come from the index, which nets returns itself).
6. **D6 — IE allocation (release-blocking rule)**: "single target" means
   **exactly one target row on the transaction, of any kind** — a
   transaction with one candidate target plus one ballot target is still
   unallocatable. Single candidate target → full `amountApplied` to it.
   Everything else → quarantine from per-candidate totals + diagnostic +
   `outsideCoverageNote`. Also quarantine: duplicate target GUIDs, mixed
   stances for one target, missing/unresolvable `filerRegistrationGuid`,
   missing stance. Never repeat the full amount per target. Only
   `reasonTypeCode = CAN` targets can receive money. Diagnostics report
   **excluded dollars, not just excluded transaction counts** (spike
   refresh: 76 of 551 PeachFile IE transactions are multi-target — 14% — up
   to **65 targets** on one transaction, so the share understates the money
   at stake).
7. **D7 — writer config** (`createStandardStateFinanceSnapshotWriter`
   wrapper, maryland/ohio pattern): `label: "Georgia"`,
   `minElectionYear: 2026` — link identity is the PeachFile `filerEntityId`,
   which only exists for PeachFile-era filers, so v1 links are scoped to the
   2026 cycle (also matches product scope). Archive-only entities (2022–2025
   cycles) are out of v1 link scope; revisit identity if older cycles are
   ever wanted. `outsideGroupValidation: "pairing"` (mandatory — cascade-FK
   trap), `summaryUpdatePolicy`: replace summary fields, preserve-when-null
   the two outside totals (direct and outside sync from different API legs),
   `supersededLinkSource: "peachfile_api"` (also the link-source CHECK value
   next to `'manual'`).
8. **D8 — amendments and report-source selection (CONFIRMED + EXTENDED at
   the spike, results items 2 and 4)**:
   - **The transaction search already serves only the latest report
     version's rows** — verified: every row's `filerReportVersionId` equals
     the report's current version, amendment-changed rows are flagged
     `TAMD`, and no prior-version rows appear. Latest-version-atomic is
     therefore a *verification* (assert version consistency per report), not
     a selection algorithm.
   - **Pinned `transactionStatusCode` vocabularies — PER HOST** (the two
     systems use disjoint code sets; a single list would reject one host's
     entire store). PeachFile: `TFIL` (disclosed on a filed CCDR), `TPEN`
     (disclosed on a timed report — Two Business Day etc. — not yet folded
     into a CCDR; **included in official index totals**, so included in
     ours; the store holds each contribution once, never timed+CCDR
     duplicated), `TAMD` (current value of an amended row), `TPAMD`
     (amended while still timed-pending). Archive: `F` (filed — every one
     of the 1,114 archive TCON rows probed) and `A` (amended-current;
     observed once, on an IE row). Anything outside the host's own set
     fails closed: excluded + counted.
   - **Report-source selection across hosts**: build the report inventory
     per registration as the UNION of both hosts' `GetFilerReport` results.
     The cross-host match key is **(registration via the D3 map, normalized
     report family, period start, period end)** — NEVER the raw
     `reportTypeCode` (the hosts use disjoint code sets: archive `103`/`104`
     vs PeachFile `FPCFDR`/`FPTBDR`, so raw-code matching would let the same
     report survive the union twice and double-count its contributions),
     and NEVER report/amendment status (the PeachFile copy of a migrated
     report is often "Amended" while the archive copy stays "Original" —
     status is version state, not identity). The per-host
     `reportTypeCode` → normalized-family mapping is pinned from fixtures
     at PR 3 and fails closed on unknown codes. Where both hosts hold the
     same report, **PeachFile wins** (it carries current amendment state —
     pre-cutover reports get amended in PeachFile after migration);
     archive-only reports sync from the archive. Report NAMES are an open
     vocabulary ("2026 Jul 31 CCDR", "Two Business Day Report", "Two Week
     Prior CCDR", "6 Day Prior CCDR", "Special General CCDR Nov 17", …) —
     never enumerate names in logic. Amendment chains ride
     `hasChild`/`childResults` (per-version GUIDs, per-version PDF paths,
     `reportStatus` "Version N").
   - **Timed-pending rows carry no real `filerReportGuid`, and the two
     endpoints encode the absence DIFFERENTLY**: the TCON endpoint writes
     the zero GUID (`00000000-0000-0000-0000-000000000000`) while the IE
     endpoint writes `null` (both captured in fixtures). Grouping rule:
     when `filerReportGuid` is null OR the zero GUID, group the row by
     `timedFiledReportGuid` (populated on those rows; `filerReportId` is a
     cross-check where present). A null-only check misses the sentinel and
     would collapse every filer's timed-pending money into one pseudo-report
     that matches no inventory entry — and since TPEN money is inside
     official totals (D4), those rows must reconcile, not fail.
   - **String status codes are authoritative; the boolean convenience flags
     are broken upstream and must never carry logic.** Captured in
     fixtures on BOTH hosts: registration 15866 has
     `filerStatusCode: "T"`/`filerStatus: "Terminated"` with
     `isTerminated: false`; reports 13310 (archive) and 38 (PeachFile) have
     `reportStatus: "Amended"`/`reportVersionId: 2` with
     `isAmended: false`. Key on `filerStatusCode`, `reportStatus`,
     `reportVersionId`, and `hasChild`/`childResults` — never on
     `isAmended`/`isTerminated`.
   - Bulk `Amended` flag (`Y` on live rows) stays the cross-check, with the
     caveat that bulk lags: it contains only CCDR-disclosed rows (timed-
     pending money and the newest grace-window filings are API-only).
9. **D9 — eligible offices v1** (DB-grounded at PR time against Georgia 2026
   election rows): statewide constitutional offices (Governor, Lt. Governor,
   Secretary of State, Attorney General, Agriculture/Insurance/Labor
   Commissioners, State School Superintendent, PSC) + State Senate + State
   House. No county/municipal in v1 (local filings are largely uploaded
   documents; IE targets may still name local candidates — those rows only
   flow into IE totals when the target resolves to a covered candidate). No
   federal offices — FEC connector owns them; the Georgia connector must
   refuse US House/Senate rows.
10. **D10 — source labels**: source enum `GEORGIA_ETHICS`;
    `FINANCE_SOURCE_LABELS` display "Georgia Government Transparency and
    Campaign Finance Commission" (shortenable to "Georgia Ethics Commission"
    if the card overflows — decide in the labels PR); generic source URL
    `https://ethics.ga.gov/records-search-all/`.
11. **D11 — flags** (mirroring Ohio's `featureFlags.ts` trio):
    `GEORGIA_CAMPAIGN_FINANCE_ENABLED`,
    `GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED`,
    `GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED`. Wire the read flag in
    **`backend/.env.example` AND `render.yaml` in the schema PR** (Ohio
    shipped missing both — pause-point rule). `backend/.env` is gitignored —
    updating the local `.env` is a merge-time runbook action, not a PR
    change.
12. **D12 — coverage notes**: outside note must disclose (a) multi-target IE
    quarantine (D6) and (b) any archive-side gaps found at spike. Direct
    occupation coverage = occupation-covered itemized individual dollars over
    all direct dollars; unitemized stays out of `Unknown`. **Direct note
    (added 2026-08-09 with the cover-arithmetic revision of D4):** the
    breakdowns explain only PeachFile-store transactions while the official
    totals are cumulative cover figures, so the loader sends a static
    `direct_coverage_note` naming that boundary; it renders with the
    occupation/size breakdowns whenever any exist.

## Acquisition spike results (run 2026-08-07, user-authorized)

~200 paced requests across both hosts (1 in flight, 2s gaps, descriptive
UA), zero blocks/429s — including a 35-page sustained pull. Artifacts +
SHA-256 manifest cached under `scratch/georgia-campaign-finance/`
(gitignored). Redacted fixtures (street addresses blanked; names,
occupations, amounts kept — public-record data our features display) under
`backend/tests/fixtures/georgiaFinance/`, including both data-key PDFs.
Probe sample: Carr (full three-registration decomposition), Jackson,
Burt Jones, 8 more statewide/legislative candidates, AFP / Fair Fight /
American Future PACs; both hosts' report inventories; 4 CCDR cover PDFs;
full PeachFile IE store (551 txns); fresh bulk TCON (274,680 rows) + TEXP
(65,106 rows).

Verdict: **Georgia is feasible and the architecture survives, but the
two-system model is messier than planned** — the schema (migration 213) and
factory config stand unchanged; the client (PR 3/4) gains a per-report
source-selection layer instead of a date partition. Every dollar question
closed exactly:

1. **A1 — the date partition is DEAD; source selection is per registration
   and per report.** PeachFile migrated Carr's registration with FULL
   pre-cutover history (both 2024–25 CCDRs, re-keyed ids); Harper (29
   archive reports), King (28), Dolezal (30), Powell (16) have ZERO
   PeachFile copies; Bottoms's Feb–Jun 2025 CCDR exists ONLY in the
   archive; the archive kept accepting special-election reports with
   periods through Nov 2025 (Fair Fight). Rule: inventory-union per
   registration, PeachFile wins per report where both hosts hold it (D8).
   Terminated pre-cutover registrations (Carr's legacy committee) are
   archive-only.
2. **A2 — answered, better than hoped** (now in D8): search APIs serve
   latest-version rows only; `TFIL`/`TPEN`/`TAMD`/`TPAMD` pinned; TPEN
   money IS in official totals; no timed/CCDR double-listing (verified on
   Jackson: 67 CCDR rows + 6 pending, zero cross-report duplicates);
   amendment chains in `childResults` with per-version PDFs.
3. **A3 — filerName is a case-insensitive substring over the per-host
   display name** (archive: person-format for candidates, committee names
   DON'T match; PeachFile: committee name). Id-based filter params
   (`filerEntityId` etc.) are **silently ignored** — an unknown body field
   returns the full 2.56M-row store, so the client must post-filter rows by
   `filerEntityId` and treat "filter had no effect" as a hard error.
   `sourceName` filters work (substring; used to find the legacy transfer).
4. **A4 — offset pagination is unstable under date-sort ties**: an
   immediate identical refetch of page 3 differed by 1 row in 100; a
   35-page pull produced 39 duplicate ids AND therefore 39 silently missed
   rows. Alternative `sortBy` values ("Transaction ID", "Amount") return
   **0 rows silently** — an invalid sort looks like an empty filer, so the
   client pins `sortBy: "Transaction Date"` and treats empty-on-nonempty-
   filer as failure. Sync rule: page-until-short-page + dedup by
   `transactionId` + per-report row-count/sum reconciliation; slice by date
   windows to bound drift. **Date windows must not become filters that lose
   rows**: the store contains garbage transaction dates on valid rows
   (fixture: IE transaction 257851 dated 2001-04-27 on a 2026 report — the
   F9 stray-2001–2024-dates hazard exists in the API store, not just bulk).
   Window bounds derive from nothing narrower than the filer's full
   plausible range, and every per-filer pull ends with an unbounded
   (no-date-filter) sweep pass whose job is to catch out-of-window rows;
   out-of-range dates land in the row's report group normally (report
   membership comes from `filerReportGuid`/`timedFiledReportGuid`, never
   from the transaction date) plus an impossible-date diagnostic.
   **Residual risk, owned by PR 3**: date filters
   can't subdivide below one day, so a deadline day with more than one page
   of tied rows rides on dedup + reconciliation alone — the client needs a
   tested bounded-retry (re-pull window until the unique-id set is stable
   across two passes) that fails the report closed when it never
   stabilizes. **Stability proves reproducibility, not completeness** (a
   tie-ordering that drops the SAME rows every pass yields equal-but-short
   id sets), so the client's windowed fetch always unions with the
   mandatory unbounded sweep — which also changes the offset geometry and
   can surface reproducibly-dropped rows — and reports sweep-only rows as a
   diagnostic; the completeness PROOF stays with PR 4's per-report
   count/sum reconciliation against the inventory and index totals.
5. **A5 — `amountApplied` == bulk `Transaction Amount` for all 387
   CCDR-disclosed IE transactions (0 mismatches)**; the API additionally
   carries 164 timed-pending IE txns (TPEN/TPAMD) the bulk lacks (~30%
   in-season) → the IE leg syncs from the API, bulk is cross-check only.
   No negative/voided IEs observed; returned expenditures exist as
   `Return Expenditure` type (146 rows) for the funders leg to exclude.
6. **A6 — Carr fully decomposed, to the cent**: official index
   $5,374,711.06 = archive 757274 store $3,468,940.96 (= cover Line 6
   $3,439,652.67 + in-kind-to-date $29,288.29, both cover-exact) +
   PeachFile CCDR rows $1,802,135.40 + timed-pending 2BD rows $103,634.70
   (49 TPEN rows — the formerly "UNPROVEN residual" of F4, now identified
   exactly). The legacy committee ($1,202,308.37 raised AND spent in its
   own terminated 2026-cycle registration, cover-exact) contributes only an
   $8,400 max-limit transfer INTO the candidate committee — an ordinary
   itemized row already inside the official total. **Legacy committees are
   never summed into candidate totals; Georgia's own official number
   excludes them.** Archive candidate index exposes the same
   identity+totals fields as PeachFile's (per-registration), so the D3 map
   shape holds. Bonus instrument: archive CCDR PDFs download cleanly by
   `filerReportGuid` and their Summary Report page is machine-readable
   structured arithmetic (Lines 2–6 text layer, no OCR) — the per-report
   official decomposition source. PeachFile's public report-PDF download is
   **broken server-side** (the UI's own call 400s; all recovered contracts
   400/500) — nothing in v1 needs it; re-probe at PR 4.
7. **A7 — zero throttling** at ~200 requests/2s pacing incl. bulk pulls
   from a residential IP; Render-egress behavior still unproven (unchanged
   caveat, first live sync measures it). Archive bulk export remains
   406-blocked for non-browser clients; archive search/PDF endpoints are
   fine.
8. **A8 — transaction taxonomy pinned from real bytes, PER HOST**
   (sample-complete, population-checked at the live run; like the D8 status
   codes, EVERY taxonomy field is a disjoint vocabulary per host — a merged
   list would silently break one host's store):
   - **PeachFile**: bulk/API types {Contribution, Loan Received, Return
     Contribution, Interest Earned (Non-Investment Account), Loan Payment,
     Loan Forgiven}; subtypes {Itemized Contribution, Unitemized
     Contribution, In-Kind Contribution, Anonymous Contribution};
     `transactionSourceTypeCode` {TIND individual, TBSN business, null}.
   - **Archive** (from the 1,114-row Carr pull): `transactionTypeCode`
     {CON, description "Contributions" — plural}; subtypes {Monetary
     Itemized, Monetary Non-Itemized, In-Kind, Anonymous};
     `transactionSourceTypeCode` {IND individual (722), null (274),
     OTH (98), COM (20)}.
   - **D5's individuals-only occupation gate keys on the per-host
     individual code — `TIND` on PeachFile, `IND` on the archive.** Pinning
     only the PeachFile codes would silently drop every pre-cutover
     individual contribution from the occupation breakdown with no error
     raised (the outside-pinned-set rule diagnoses-and-excludes), gutting
     D12 occupation coverage for archive money.
   - TEXP types {Expenditure, Independent Expenditure, Return Expenditure}
     (PeachFile bulk). Bulk hazards confirmed on the new files: cp1252,
     parenthesized negatives, `="…"` Excel guards, ragged rows (a stray
     "SELF EMployed" leaks into Transaction Type on 3 rows — ragged-row
     detection stays mandatory). Data-key PDFs committed as fixtures.
   Note: `GetTransactionDetails` ignores `transactionTypeCode:"TEXP"`
   (returns TCON) — candidate expenditure line-items aren't needed for any
   v1 feature; the funders leg uses TCON of IE spenders.
9. **A9 — returns have NO structural linkage** (D5 now permanent):
   `Return Contribution` rows carry their own id, always-negative amount,
   free-text reason ("over allowed contribution limit", "Stop Payment"),
   and no original-row reference.

## Open spike questions — ANSWERED 2026-08-07 (kept for the record)

- **A1**: report-level partition (archive ≤ Jun 30 2025 / PeachFile ≥ Jul 1
  2025) holds for every filer type, or per-filer exceptions exist (probe ≥10
  filers incl. non-candidate committees).
- **A2**: search APIs return only latest amendment version (D8), and what
  each `transactionStatusCode` value means (`TPEN` pending vs `TFIL` filed —
  does a pending row belong in published totals? default: exclude + count).
- **A3**: `filerName` filter matching semantics (substring? exact?) and
  whether filer-scoped queries are better keyed by another filter field
  (e.g. registration guid) — probe for an id-based filter param.
- **A4**: PeachFile `GetTransactionDetails` result ordering is stable across
  pages under `sortBy: "Transaction Date"` (pagination-drift risk while new
  filings arrive mid-sync).
- **A5**: IE `amountApplied` vs bulk `Transaction Amount` agree per
  transaction; returned/voided IEs representation.
- **A6**: archive candidate index exposes the same
  totals/identity fields as F3 (probe `GetCandidateDetails` on
  api-recordsearch) — settles the filer-map shape (D3) before its
  migration. Must also decompose one full candidate (Carr): which archive
  filers' transactions compose the official full-cycle total, including how
  much of the legacy filer's current-cycle money ($995k on filer 2750)
  belongs in it and what explains the $103k residual (F4).
- **A7**: rate limits / WAF behavior under sustained polite paging from a
  server IP (Render egress), not just a residential IP.
- **A8 — transaction taxonomy gate**: pin the complete observed vocabulary
  from real pages before any aggregator code: `transactionSubTypeDesc`,
  `transactionStatusCode`, `transactionSourceTypeCode` (individual-vs-
  organization discriminator), monetary vs in-kind vs loan vs interest vs
  refund/return meaning, and gross-vs-signed amount behavior per type.
  Anything outside the pinned set → diagnostic counter, never a bucket.
- **A9**: how a returned contribution links to its original (same
  transaction id? separate row? negative amount only?) — gates D5's
  returns handling.

## Module layout

```text
backend/src/pipeline/georgiaFinance/
  index.ts
  georgiaEthicsClient.ts                       # both hosts; search APIs; pageSize<=100; fail-closed
  georgiaEthicsArtifactCache.ts                # optional bulk cross-check artifacts (F8), manifest+SHA-256
  georgiaCandidateCommitteeResolver.ts         # candidate-index resolution (F3), fail closed on ambiguity
  georgiaCandidateFinanceAutoLink.ts           # sibling copy (tennessee/maryland)
  georgiaFilerIdentityMap.ts                   # D3 cross-system map access
  georgiaDirectContributionAggregator.ts       # occupation + contribution_size (D5)
  georgiaOutsideSpendingAggregator.ts          # IE leg (F5/F6/D6)
  georgiaOutsideGroupContributionAggregator.ts # funders of outside spenders (TN pattern)
  georgiaFinanceEligibleOffices.ts             # D9
  georgiaFinanceWriter.ts                      # factory wrapper (D7)
  georgiaCandidateFinanceSync.ts
  georgiaCandidateFinanceBatchSync.ts
  georgiaBallotLookupFinanceLoader.ts          # shared-loader wrapper + coverage notes (D12)
```

Schema: `db/migrations/<next>_add_georgia_campaign_finance_tables.sql` —
clone the maryland/ohio migration, `ga_` prefix (longest identifier
`ga_candidate_finance_outside_group_breakdowns` = 45 chars; use the short
`ga_cff_` constraint-prefix trick where needed). The D3 map table is a
**separate post-spike migration** (shape gated on A6). Allocate the next
free migration number at PR time.

Partial-snapshot contract (writer semantics, pinned here because it is easy
to get wrong): a leg that didn't run passes **`undefined`, never `[]`** —
empty arrays delete the stored rows. Direct-only sync omits the outside
arrays; outside-only sync omits `directBreakdowns`.

## PR sequence (one PR at a time; `npm run typecheck` + `npm test` green in `backend/`; cite matrix row)

Ohio/NC precedent holds: canonical schema is spike-independent (matrix-pinned
shape) and lands first; only the D3 map table waits for the spike.

1. **PR 1 — plan + canonical schema + flags + labels + loader**: this doc;
   migration (5 canonical tables only); `featureFlags.ts` trio (D11);
   `backend/.env.example` + `render.yaml` read flag; `GEORGIA_ETHICS` in
   `FINANCE_SUMMARY_SOURCES` (`ballotLookupFinanceShared.ts`) and
   `FINANCE_SOURCE_LABELS` (`packages/api-client/src/format.ts`); loader
   wrapper + **`ballotLookup.ts` registry entry** (`{ state: "GA", load: … }`
   — the source union alone activates nothing) + characterization test up
   front (born-shared state).
2. **PR 2 — acquisition spike (gated, user-authorized)**: answer A1–A9
   against live systems; commit small redacted fixtures for both hosts
   (candidate index, TCON pages, IE pages incl. one real multi-target,
   data-key PDFs); revise this plan's decisions before any parser code.
3. **PR 3 — map-table migration + client + resolver + auto-link**: D3 map
   migration (shape from A6: per-host filerEntityId + registration guid +
   per-host display-name forms, multiple rows per canonical entity);
   `georgiaEthicsClient` (+ fixture tests) implementing the D8
   inventory-union/source-selection layer and the A4 paging rules
   (date-window slicing, id-dedup, pinned sortBy, filter-effectiveness
   check); candidate-index resolver, auto-link; due-list builder config +
   due-list test.
4. **PR 4 — direct finance**: per-filer TCON sync across both systems,
   aggregators (D5, taxonomy from A8), summary from candidate index (D4),
   reconciliation guard; sync + batchSync + npm scripts
   (`georgia-candidates:finance:*`, ohio block as template).
5. **PR 5 — outside spending**: IE leg with D6 allocation rule + coverage
   note; support/oppose totals + groups.
6. **PR 6 — outside-group funders/industries**: TN-style contribution
   aggregation for IE spenders. Sync never calls AI; unresolved labels
   persist as `unknown` classification rows for the manual
   industry/committee-label queues.
7. **PR 7 — scheduler wiring + live run**: scheduler upsert/worker/trigger
   scripts (ohio `ohio-candidates:finance:scheduler:*` as template); then a
   live run through the committed sync scripts — fresh pull, full sync of
   linked Nov-2026 Georgia candidates, money-reconciliation + match-rate
   report against candidate-index totals, and first-run DB verification
   (spot-check written rows against the public search UI).

## Status

- 2026-08-06: plan written from live verification. Revised same day after a
  second-opinion review (D3 scope widened to outside spenders, map table
  moved post-spike, D4 official-totals-to-`total_receipts`, D7 floor 2026,
  D8 report-version-atomic, D6 exact-one-target, A8/A9 added).
- 2026-08-07: **PR 1 implemented** — migration 213 (5 canonical tables,
  NC-212 clone, `ga_` prefix, link sources `manual`/`peachfile_api`), flag
  trio, `.env.example` + `render.yaml`, writer wrapper (D7) + eligible
  offices (D9, DB-grounded: 9 statewide + both chambers; US Senate/us_house/
  county/school excluded) + loader wrapper + `ballotLookup.ts` registry +
  `GEORGIA_ETHICS` source union + `FINANCE_SOURCE_LABELS` label ("Georgia
  Ethics Commission" — D10 short form; the statute name overflows the card)
  + writer/offices/characterization tests. Merged as PR #568.
- 2026-08-07: **PR 2 acquisition spike run** (user-authorized) — all nine
  questions answered, Carr decomposed to the cent, date-partition model
  replaced by per-report source selection (D8), returns rule made permanent
  (D5), pagination/fail-closed rules pinned (A4), fixtures + data keys
  committed. Schema and factory config unchanged — migration 213 stands.
  Next: PR 3 (map migration + client + resolver + auto-link).
- 2026-08-07: **PR 3 implemented** — migration 214
  (`ga_finance_filer_identity_map`: per-host filerEntityId + registration
  guid + per-host name forms, explicit `include_in_candidate_totals`,
  outside spenders unrepresentable inside candidate totals) + map access
  module; `georgiaEthicsClient` (paced single-flight transport, pinned
  request bodies, per-host status/taxonomy/report-family vocabularies,
  A4 paging: pinned sortBy + short-page loop + id-dedup +
  filter-effectiveness hard error + bounded-retry stability loop, D8
  report-inventory union with PeachFile-wins and standalone null-period
  archive rows — a fixture-checked case: 2022-era archive inventory rows
  can carry no period); PeachFile candidate-index resolver (office labels
  pinned from spike bytes — Agriculture/Labor never appeared in the probed
  sample, so both orderings are listed and a wrong alias can only fail
  closed); auto-link (tennessee pattern; ambiguous is report-only — the
  links status vocabulary is active/inactive); due-list config on the
  shared factory. Fixture-driven tests throughout (the Carr union test
  proves cross-host identity matching on disjoint raw codes and statuses).
- 2026-08-07: **PR 3 review round** (external, both findings verified against
  the code before acting): (1) resolver now preserves middle-name evidence —
  "John A. Smith" no longer matches "Smith, John B." on a shared first+last
  key; conflicting middles reject, an initial corroborating the full middle
  matches, and the first+last fallback applies only when a side lacks middle
  information (the index's structured `candidateMiddleName` field is now
  read, so evidence is as rich as the portal provides). (2)
  `fetchGeorgiaTransactionRowsWindowed` added: windowed stable pulls sharing
  boundary days + the mandatory unbounded sweep union with sweep-only/
  sweep-missed diagnostics; docs state explicitly that equal id sets prove
  reproducibility, not completeness — reconciliation (PR 4) is the proof.
- 2026-08-07: **PR 4 implemented** — direct finance.
  `georgiaDirectContributionAggregator` (D5/A8: per-host subtype codes pinned
  from spike bytes — PeachFile ITMY/NITMY/INKIND, archive MOI/NIM/IKD/ANO;
  occupation = itemized individuals via the per-host individual code with an
  explicit "Unknown" bucket for blank/placeholder filings; size buckets =
  every positive itemized row; unitemized/in-kind/anonymous/returns/unpinned
  subtypes stay IN the synced-row sum and out of the buckets — the index
  total includes loans, interest, and unitemized money and nets returns;
  unrecognized statuses excluded from everything + counted; no transaction
  date ever gates anything). `georgiaCandidateFinanceSync`: PeachFile index
  row (matched on the linked filerEntityId) is the summary source AND the
  reconciliation anchor; archive side = identity-map rows when any archive
  candidate-committee row exists (a lone exclusion row suppresses discovery),
  else discovery from the archive candidate index (same person via the
  middle-evidence matcher, cycle label leads with the election year,
  `filerStatusCode` ≠ "T" — excludes Carr's terminated legacy 2750, keeps
  757274; discovery is in-memory only, nothing writes to the map); report
  inventories both hosts (PeachFile keyed by committee name — the person-name
  form returns zero rows there, archive keyed per source filer name), scoped
  by registration guid, D8 union, per-host selected guid sets including
  child-version guids (spike artifacts confirm rows reference both parent and
  version guids and all 12 timed guids resolve to FPTBDR inventory rows);
  windowed+sweep TCON pulls with the window range derived from the earliest
  inventory period start; rows selected by report-group guid, superseded
  archive copies and unassigned groups excluded + counted; reconciliation
  guard |sum − index total| ≤ max($2,500, 2%) (Carr's migrated-copy drift is
  0.40%) — breach throws and keeps the previous snapshot. Client gained
  per-window filter_ineffective tolerance (a quiet window with only foreign
  name-matches is expected; the sweep stays the authority) and a whole-pull
  filter_ineffective on one leg is treated as zero rows with the guard
  arbitrating. Summary write per D4: index totals to
  totalReceipts/totalDisbursements/cashOnHand, direct_contribution_total
  NULL, outside legs untouched (undefined, never []). Due list now carries
  link_source so provenance survives the write-back; batch sync (tennessee
  shape, auto-link first, per-candidate isolation, default 10
  candidates/run — Georgia candidates cost hundreds of paced requests);
  `syncDueGeorgiaCandidateFinance` script + `georgia-candidates:finance:sync-due`
  npm script gated on the sync flag.
- 2026-08-07: **PR 4 review round** (external, all three findings verified
  against the code before acting): (1) reconciliation floor cut $2,500 →
  $100 — the relative share is the real absorber (drift scales with the
  money) and the old floor dominated the tolerance for every filer under
  $125k, exactly the small campaigns it endangered — plus an explicit
  zero-coverage guard: a nonzero index total with zero selected rows is
  PROOF of a broken pull (the index is the exact sum of the store's rows,
  A6), so no tolerance may excuse it and the stored breakdowns are never
  deleted on a dead pull's say-so. (2) index-row selection now applies the
  election-cycle gate that created the link (entity id alone is
  API-order-dependent once a committee re-registers for a later cycle — the
  archive's filer 2750 shows the two-rows-one-entity shape) and requires
  exactly one surviving row. (3) null official totals fail closed instead
  of `?? 0` — no-money filers report 0.0, never null, and the summary
  policy is "replace", so a null would overwrite stored values.
- 2026-08-08: **PR 5 implemented** — outside spending (F5/F6/D6/D12).
  Client: `fetchGeorgiaIndependentExpenditureRows` — full-store pull, the
  only spike-verified request shape (body pinned byte-for-byte from the
  spike transcript: every filter null, sortBy "Transaction Date", sortType
  per host as verified — PeachFile asc, archive desc); pages until short
  page, dedups by transactionId, and requires two consecutive equal id-set
  passes (A4 offset-drift discipline), failing closed otherwise. IE rows
  carry NO filerEntityId — the spender's identity is its registration guid
  (probed store: 40 spenders, one guid each), which becomes the
  outside-group committee_id. `georgiaOutsideSpendingAggregator`: pure ID
  join — a target's filerRegistrationGuid against the candidate's PeachFile
  registration guid, never a name match; D6 allocation (exactly one target
  of ANY kind → full amountApplied; candidate+ballot still unallocatable);
  quarantined-as-dollars diagnostics for multi-target, malformed
  single-target (non-CAN reason, missing stance, missing spender identity,
  non-positive amount — the schema requires amount >= 0), and
  unrecognized-status rows; stance STRING is authoritative (the
  supportOppose "True"/"False" mirror falls under the D8 broken-booleans
  rule). **Archive IE is excluded by design**: spike bytes show archive
  targets carry neither a registration guid nor a reasonTypeCode (0 of 103
  probed), so no archive row can ever satisfy the D6 gates — for v1's
  2026-cycle candidates that money is pre-cycle, and the coverage note now
  names the current-system boundary ("current filing system (July 2025
  onward)"). Sync: IE leg runs after the reconciliation guard (a failed
  direct pull never costs the store fetch); summary gains
  outsideSupportTotal/outsideOpposeTotal and outsideGroups is written even
  when empty (truthful zero — the leg ran); outside-group BREAKDOWNS stay
  undefined (funders are PR 6). Batch: the candidate-independent PeachFile
  IE store is pulled once per run and shared across every candidate;
  skipped entirely when nothing is due. 118 GA tests; full suite 6,743
  green.
- 2026-08-08: **PR 5 review round** (external, both findings verified against
  the code before acting, both adopted): (1) a stable EMPTY IE store now
  fails closed in the client — both stores are pinned nonempty and cumulative
  (551 PeachFile / 3,679 archive at the spike, a full-store pull can only
  grow), so two agreeing empty passes are a dead endpoint being perfectly
  reproducible, and writing them through would delete every stored outside
  group and zero the totals (same class as the PR 4 zero-coverage guard).
  (2) an IE-side client failure no longer blocks the direct leg: the IE
  fetch is the LAST fetch, after the direct pull's hundreds of paced
  requests have succeeded and reconciled, so the sync catches
  GeorgiaEthicsClientError (network / WAF / unstable / empty-store) and
  degrades to direct-only — outside summary fields go null
  (preserveWhenNull keeps stored values), outsideGroups goes undefined
  (stored groups untouched, the partial-snapshot contract's exact purpose),
  and the skip reason rides the result. The batch layer catches the shared
  store pull's client failures the same way and passes the NULL sentinel so
  candidates never each retry a known-dead fetch
  (independentExpenditureStoreError surfaces it); non-client errors are
  bugs and still throw everywhere. The two guards compose: empty store →
  client throws → sync degrades → stored outside data preserved. 122 GA
  tests, suite 6,747 green.
- 2026-08-08: **PR 6 implemented** — outside-group funders/industries
  (maryland/ohio donor+industry pattern; the schema's outside categories are
  donor + industry only, so ORGANIZATION contributors are the only donors
  surfaced). Spender identity: IE rows carry no filerEntityId, so each
  spender's entity id is resolved from its PeachFile `GetFilerReport` rows
  (name search, scoped by the registration guid = the group identity), then
  its TCON store rides the existing entity-id-filtered stable fetch and the
  rows are re-scoped to the registration guid (other-registration rows
  counted) — zero new client code, only proven mechanisms.
  `georgiaOutsideGroupContributionAggregator`: pure aggregation over
  pre-scoped rows; gates = pinned PeachFile status set, positive amount
  (returns excluded, A5/A9), ITMY/INKIND subtypes only (unitemized/anonymous
  carry no donor identity; in-kind is genuine funding, maryland parity),
  cycle window Y-1..Y (transaction-date year, electionYear fallback), org
  test via the structured source-type code first (TIND individual / TBSN
  business, A8) with a name-shape fallback for null codes. Donor rows
  UNCAPPED in the aggregator; the sync rule-classifies every donor at floor
  0, lets cached DB rows (manual verdicts) override, rebuilds industry rows
  from the merged classification state, and only then caps persisted donors
  (50/group). **No AI classifier exists on this path** — unresolved donors
  persist as 'unknown' classification rows for the manual industry-label
  queue via the writer. Failure semantics: an UNRESOLVED spender identity
  (name-form mismatch / ambiguous entity) only costs that spender's donor
  rows (counted + warned); `filter_ineffective` on the TCON pull is an
  honest empty (a treasury IE filer that never disclosed a contribution); a
  client-level pull failure degrades the WHOLE funders leg to undefined —
  a partial breakdown array would delete the failed spender's stored donor
  rows on write — while groups and totals still refresh (group upsert does
  not cascade surviving groups' stored breakdowns); non-client errors throw.
  Batch: one spender-contribution cache per run shared across candidates
  (the same PAC funds several statewide races), failures cached so a dead
  pull is never retried per candidate. Breakdowns pair only with the capped
  group list actually written (writer pairing validation). 138 GA tests,
  suite 7,081 green.
- 2026-08-08: **PR 6 review round** (external, both findings verified against
  the code before acting, both adopted): (1) `filter_ineffective` on a
  spender TCON pull no longer converts to a confirmed-zero result — the
  error's two readings (filter ignored / matched the wrong filer) cannot be
  told apart, and the funders leg has no arbiter (the direct leg tolerates
  the whole-pull shape only because the index-total reconciliation guard
  proves whether money went missing), so writing empty through would delete
  the spender's stored donor rows on an unresolvable ambiguity. It now
  returns "failed" and the whole funders leg degrades (stored breakdowns
  preserved). The honest treasury-spender case is unaffected: a
  full-committee-name query for a filer with no TCON disclosures returns
  zero rows TOTAL — a clean empty result, no error. "unresolved" deliberately
  stays per-spender: resolution is an ID join over immutable filed reports
  (a spender that resolved once keeps resolving, so an unresolved spender
  has no stored rows to lose), and a permanently odd spender name must not
  disable the funders leg for every candidate. (2) the sync file carried
  three literal NUL bytes (0x00) as key separators — the file read as
  binary to `rg`/`file` and hid from search tooling; replaced with textual
  `\u0000` escapes (same defect class was already fixed in the aggregator
  file; a byte-scan now covers every Georgia file). 138 GA tests, suite
  7,081 green.
- 2026-08-09: **PR 7 scheduler wiring implemented** (North Carolina
  scheduler as the template — the newest sibling): BullMQ scheduler module
  (`georgiaCandidateFinanceSyncScheduler.ts`) with daily job-scheduler
  upsert (removed when the master flag is off), manual enqueue (sync flag
  gated, force bypasses only the sync flag — never the master flag),
  reserved-jobId guard, and a concurrency-1 worker; upsert/worker/trigger
  scripts with the strict NC-style CLI parsers (unknown-flag, boolean=value,
  repeated-flag, and non-positive-integer rejection) minus `--raw-cache-dir`
  (the Georgia batch sync is transport-based, no raw cache dir); npm scripts
  `georgia-candidates:finance:scheduler:{upsert,worker,trigger}`. The
  disabled no-op result matches the Georgia batch result shape
  (autoLinkAttemptedCount/autoLinkLinkedCount/independentExpenditureStoreError,
  no outsideAggregationByYear). Cron default "55 10 * * *" UTC — offset from
  Ohio's 09:55 and North Carolina's 10:25 so state syncs never stack on one
  worker host. Scheduler queue/cron/tz env vars have code defaults and stay
  out of `.env.example` (Ohio/NC precedent). 19 new tests (7 scheduler + 12
  CLI args); suite 7,120 green. The PR 7 live run remains a separate,
  user-authorized step.
- 2026-08-09: **PR 7 review round** (external, both findings verified
  against runtime behavior before acting, both adopted): (1) positional
  typos bypassed dry-run protection — both new parsers skipped every token
  not starting with `--`, so `npm run …:trigger -- dry-run` (npm eats the
  first `--`) silently enqueued a REAL sync, and the upsert variant would
  persist a real daily-write scheduler; the existing sync-due parser
  already rejected such input, making the new "strict" parsers strictly
  weaker than the parser they cite. A bare token is now legal only as the
  value of the immediately preceding space-form value flag; anything else
  throws `Unexpected positional argument`. (2) `Number.isInteger` accepts
  silently-rounded unsafe values (`Number("9007199254740993")` → 2^53) —
  the scheduler's assertPositiveInteger (guarding every path: upsert,
  enqueue, worker run) now uses `Number.isSafeInteger`, and both CLI
  parsers reject at parse time so the error carries the operator's
  original string. Same two defects exist in the Ohio and North Carolina
  scheduler parsers/asserts (this code's templates) — out of scope here,
  flagged for a follow-up. 24 GA scheduler-round tests; suite 7,125 green.
- 2026-08-09: **follow-up CLOSED fleet-wide**: the two PR 7 review-round
  defects were ported to every sibling. PR #620 fixed the 13 CLIs sharing
  the `validateKnownFlags` template (Ohio, North Carolina, Maine, the
  Maryland sync-due) plus `Number.isSafeInteger` in all 44 schedulers
  matching the assertPositiveInteger grep; its review round added Los
  Angeles (no template code at all), the Alaska/Florida
  assertNonNegativeInteger variants the `value <= 0` grep missed, and this
  file's own sync-due parser. PR #622 closed New York City (hand-rolled
  parsing, also invisible to the grep). A concept-level sweep — every
  finance CLI arg parse reaching a write, not the template pattern — then
  found the remaining 78 pre-template CLIs (trigger/upsert/sync-due and
  raw-data refresh across ~25 states, 62 of them write-by-default) with no
  unknown-flag or positional rejection at all; all now call a shared
  `assertKnownCliFlags` (financeCliFlagGuard.ts) with per-script flag
  sets. The review round then caught what that sweep's own globs missed:
  the guard never required a value flag's value (a bare `--candidate-id`
  silently ran an untargeted full batch — the guard now rejects missing
  and empty values in both forms and consumes space-form values), the 5
  direct-write `sync*CandidateFinance` CLIs (glob only matched syncDue),
  8 Tracer/eCRIS/CFIS/TEC raw trigger/upsert CLIs (glob required
  "Finance" in the name), and 27 partially-guarded CLIs across
  DC/FL/IL/KY/LA/MN/NE/CO/Maine/MD whose five bespoke validator shapes
  skipped positionals or inline boolean values — every bespoke validator
  now delegates to the shared guard, and the per-state error strings were
  canonicalized to the guard's wording. Verified complete and left alone:
  NCSBE/Ohio-SoS/Minnesota refresh loops, the NJ/Indiana/Tennessee
  CliArgs helper modules, Georgia's own sync-due loop, the LA/NYC
  flat-set guards, and the Ohio/NC/Georgia templates. Lesson recorded
  twice now: the grep that finds the port cohort also defines its blind
  spot — sweep for the concept, then diff against the grep hits.
- 2026-08-09: **LIVE RUN round 1 + archive-leg fix.** First 50 candidates:
  auto-link solid (link accuracy spot-checked clean), every synced
  candidate reconciled to $0.00, but 23/50 breached reconciliation and the
  archive diagnostics showed **zero archive rows ever included** — the
  archive leg had never worked live (fixture stubs masked both defects).
  Root causes, live-verified: (1) archive report/transaction fetches
  searched by the index display name ("Elizabeth Anne Camp"), but the
  archive report + transaction endpoints store "Surname, Firstname" forms
  — the space-form name matches zero rows there; fetches now use the
  surname token and the registration-guid / entity-id filters do the
  scoping. (2) discovery's cycle gate required a "2026 " archive index
  row, but the archive FROZE July 2025 — a 2026-cycle candidate's archive
  money often sits under a registration whose newest index row says
  2022/2024 (re-registration happened in PeachFile); gate removed. Key new
  fact: **official PeachFile index totals are registration-chain-cumulative
  (career)** — Dunn's pre-fix gap $64,594.00 equalled his entire archive
  store to the cent, and Mitchell's official total requires archive
  filings back to 2021 — so including every report of a discovered
  registration is correct and the reconciliation guard stays the arbiter
  (over-inclusion breaches and fails closed). Post-fix Dunn syncs
  $240,790.24, reconciliationDifference 0, 119 archive rows. Remaining
  open classes after the fix: nickname/legal-name discovery misses (Beth
  Camp = "Elizabeth Anne Camp", Betsy Holland = "Elizabeth Stuart
  Holland", Al Williams, Buddy DeLoach — need identity-map rows or a
  user-approved nickname rule), PF store gaps (Shaikh's Jan-31 CCDR has
  zero TCON rows in the store), and PF pull instability (4 candidates,
  retryable). 138 GA tests, suite 7,224 green.
- 2026-08-09: **CORRECTION — the cycle-gate removal above was WRONG and is
  reverted (the surname-token fetch fix stands).** The next two live
  batches regressed: a new OVER-inclusion class appeared (batch 4: 10 of 19
  breaches oversummed, worst +$218,243.33 on a $55,140.20 official total).
  Root of the mistake: "official index totals are
  registration-chain-cumulative" was generalized from two candidates. Dunn
  fit only because all 119 of his archive rows sat in ONE report period
  inside the current cycle — equally consistent with a cycle-scoped rule —
  and Mitchell actively contradicted it (still $21,974.58 SHORT even with
  his entire archive included) but was filed as an unexplained residual
  instead of treated as falsifying evidence. **Structural fact learned:**
  the archive issues one registration guid PER CYCLE under a single filer
  entity (Summers entity 5467 → 2022/2024/2026 guids at $200,211.28 /
  $204,588.00 / $28,700.00), so the cycle gate is selecting among a
  candidate's own per-cycle ledgers, not filtering foreign filers.
  **The scope rule remains UNRESOLVED — do not guess again.** Measured
  against Summers, the required archive amount matches no subset of his
  registration guids AND no report-period cutoff (cumulative jumps
  $248,038.00 → $301,968.53 straight past the needed $255,343.01). The
  baseline arithmetic is itself unreliable because the PeachFile
  contribution SHIFTS once archive reports enter the D8 inventory union
  (Summers: PF-only $103,850.00 pre-fix vs $75,150.00 post-fix — exactly
  the $28,700.00 2026-archive guid moved hosts). Settling this needs the
  instrument the spike already identified: **archive CCDR PDFs download by
  filerReportGuid and their Summary Report pages are machine-readable text
  (Lines 2–6)** — the official per-report decomposition, which can be
  compared against the index total directly instead of inferred from sums.
  Both failure directions fail closed (the reconciliation guard writes
  nothing either way), so no wrong money was ever written. 138 GA tests,
  suite 7,224 green.
- 2026-08-09: **ROOT CAUSE FOUND AND FIXED — official totals are report-cover
  arithmetic, not transaction sums.** Proven from PeachFile's own systems
  (profile UI + `POST /api/PublicFilerDetails/GetFinancialSummaryDetails`
  with `{filerRegistrationGuid}`, discovered by driving the UI in a browser
  and reading the app bundles): the endpoint returns the official
  accumulator (`monetaryContributionsCumulative` = the index total exactly,
  plus startBalance/endBalance/loansReceivedCumulative), maintained over
  the registration's FILED REPORT COVERS and seeded per-filer at migration.
  Consequences, all verified live: (a) the official total counts money from
  covers whose transactions never entered the PeachFile transaction store
  (Cox: official $186,121.55; PeachFile's own profile pies show itemized
  transactions of exactly $77,275.20 — Georgia itself displays both without
  reconciling them); (b) unmigrated archive ledgers are NEVER counted
  (Erwin and Payne: official == PeachFile-only rows to the cent while their
  archive registrations hold five-figure sums); (c) migrated transactions,
  when carried at all, are already in the PeachFile store under re-keyed
  ids (Carr). Every reconciliation failure and every failed archive
  hypothesis followed from anchoring a TRANSACTION sum to a COVER
  accumulator. **Fix (this entry's PR): the direct leg reads the PeachFile
  store only** — archive discovery, archive report fetch, and archive TCON
  pull removed from the direct path (the archive host now serves nothing on
  this leg); the guard becomes (1) the unchanged zero-coverage guard and
  (2) an OVER-count guard (rows exceeding the official total prove a
  foreign ledger — fail closed); under-coverage is a new
  `uncoveredOfficialAmount` result field (cover-counted pre-cutover money),
  disclosed rather than failed. A user-facing coverage note on direct
  breakdowns ships with this change set's review round through the shared
  read-side contract (`direct_coverage_note`: loader option -> api-client
  type -> FinanceSummaryCard, outside-note pattern). The
  identity map table stays (outside-spender use) but the sync no longer
  consults it. PeachFile report rows DO carry per-version PDF filePaths,
  but the download endpoint still 500s server-side (re-confirmed live);
  nothing in this design needs it. 136 GA sync-file tests after the review round; backend suite 7,324 green, frontend 515.
