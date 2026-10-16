# North Carolina campaign finance — implementation plan

Date: 2026-08-06. Governs the North Carolina state-finance build. Read
alongside `plan.md` ("Pause point — add new states") and
`docs/finance-module-capability-matrix.md` — their rules apply to every PR
here. Feasibility research: agent report dated 2026-08-02, independently
re-verified live 2026-08-06 (every money number reproduced; two portal quirks
the report missed are folded into decisions 9–10). Do not re-hit the portal
during code-only PRs — portal work happens only in the acquisition spike, when
authorized.

## Verdict

North Carolina is born on the shared factories with **zero migration debt**
and **zero new factory capability**. Canonical identity (`committee_id` =
NCSBE `SBoEID`, e.g. `STA-JV516O-C-001`; `committee_name`), all 5 standard
tables, standard summary columns, std direct categories (`occupation` +
`contribution_size` — unlike Ohio, NC's separate `Profession` /
`EmployersName` fields make occupations shippable), donor/industry outside
breakdowns. Reference siblings: **ohio** (the first pause-point state — same
ladder) and **maryland** (writer/loader/auto-link shape); diff against them
before writing each file.

Two structural advantages over Ohio, verified live: **no Cloudflare wall**
(plain unauthenticated HTTP works — ~15 probe requests, zero blocks) and
**per-report JSON endpoints** instead of 90 MB bulk CSVs. One structural
disadvantage: ~24% of independent-expenditure filings are image-only
(23 of 95 in the 2026 inventory) — v1 ships with an `outsideCoverageNote`
from day one (decision 13).

Scope: direct finance (receipts, expenditures, cash, contribution sizes,
occupations) + structured outside support/oppose + outside-group
funders/industries (#3, last feature PR — tennessee/ohio pattern). PDF/image
fallback and county/municipal candidates are out of v1 (decisions 2, 13).

## Shared-piece config (settled)

- **Writer** — `createStandardStateFinanceSnapshotWriter` wrapper, ohio/maryland
  pattern:
  - `label: "North Carolina"`, `minElectionYear: 2000`
  - `summaryUpdatePolicy`: replace all summary fields, preserve-when-null the
    two outside totals (direct and outside are built from different artifact
    sets; a direct-only refresh must not wipe outside totals)
  - `outsideGroupValidation: "pairing"` — **mandatory**, cascade-FK trap
  - `supersededLinkSource`: `ncsbe_portal` (settled at PR 1; the link-source
    CHECK value next to `'manual'` — OH `sos_bulk_export` precedent)
  - `normalizeCommitteeId`: trim + upper-case. PR 1 validates loosely
    (nonempty after trim); the exact SBoEID regex is pinned at PR 4 from
    spike bytes, not invented at PR 1. All synthetic keys are defined
    uppercase (decision 6) so the normalizer stays unconditional.
  - No pool-guard stub — ohio precedent (maryland's `requireMarylandPool`
    is legacy; `ohioFinanceWriter.ts` has none).
- **Due-list** — `createStandardStateFinanceDueListQuery` with
  `linkColumns: ["committee_id", "committee_name", "link_source"]` + `mapRow`
  (ohio pattern, `ohioCandidateFinanceBatchSync.ts:657`): `link_source` rides
  in the due row and is written back as-is, so manual links keep provenance
  and auto-supersession immunity. Canonical config without it would re-key
  manual links to the bulk source on every sync.
- **Loader** — `loadStandardStateFinanceSummariesByCandidateElection` wrapper
  (~40 lines, ohio shape): defaults + `isEligibleElection` +
  `evidenceLabelTypes: ["donor"]` + `outsideCoverageNote` (decision 13).
  Characterization test via
  `tests/helpers/stateFinanceLoaderCharacterization.ts` written **up front**.
- **Auto-link** — copy ohio/maryland auto-linker shape over the committee
  search results (decision 5).

## Schema

`db/migrations/212_add_north_carolina_campaign_finance_tables.sql` (211 is
owned by open PR #563) — clone
the ohio migration (210), `nc_` prefix. Identifiers ≤63 chars: longest is
`nc_candidate_finance_direct_breakdowns_source_url_check` (55); the
outside-group-breakdowns table uses the short constraint prefix `nc_cff_`
(maryland's `md_cff_` trick). Link-source CHECK lists `'manual'` + the NC bulk
source. Amounts CHECK `>= 0` (canonical).

Per the hardened pause-point rules: **the read flag is wired end-to-end in
this same PR** — `render.yaml` and `backend/.env.example` (both committable;
`backend/.env` itself is gitignored, so the flag is added by hand to the main
checkout's `.env` at merge time — Ohio shipped without any of this and
rendered nothing).

## Settled design decisions

1. **Data access is per-report JSON/CSV over stable GET routes** (verified
   live 2026-08-06, unauthenticated):
   - Committee search:
     `/CFOrgLkup/CommitteeGeneralResult/?name=<q>&useOrgName=True&useCandName=True&useInHouseName=True&useAcronym=False`
     — page embeds JSON with `CommitteeName`, `CandidateName`, `SBoEID`,
     `OrgGroupID`, status.
   - Document inventory:
     `/CFOrgLkup/DocumentGeneralResult/?OGID=<OrgGroupID>&SID=<SBoEID>` — page
     embeds JSON rows with `ReportType`, `IsAmendment`, `ImageReceiptDate`,
     `DataImportDate`, `PeriodStartDate/EndDate`, `DataLink` (structured
     report ID) and `ImageLink` (scanned doc).
   - Report cover + summary: `/CFOrgLkup/ReportDetail/?RID=<id>&TP=ALL` —
     page embeds a summary JSON array of `{Section, Period, Cycle}` rows
     (Total Receipts / Total Expenditures / Cash on Hand at End of Reporting
     Period / …).
   - Transactions: `/CFOrgLkup/GetReceipts?ReportID=<id>&page=<n>&pageSize=<m>`
     and `/CFOrgLkup/GetExpenditures?ReportID=<id>&ShowIEColumns=true&page=<n>&pageSize=<m>`
     — real JSON (`Data.recordCountKey` + `Data.results`).
   - CSV export: `/CFOrgLkup/ExportDetailResults/?ReportID=<id>&Type=ALL&Title=<t>`
     (`text/csv`, COVER section included) — reconciliation artifact.
   - The **advanced transaction search (`/CFTxnLkup/`) is not an ingestion
     path** (session-backed, slow); it is a later completeness-audit tool
     only.
2. **Eligible offices v1** (DB-grounded at PR 1 against NC 2026 election
   rows): NC state-controlled filings cover Council of State, NC House, NC
   Senate, judicial, and district attorney. v1 eligible set = `state_upper` +
   `state_lower` legislators plus whatever statewide Council-of-State rows
   actually exist for the cycle (2026 is a midterm — most Council of State
   races run in presidential years — when a presidential cycle enters scope,
   the full ten-office Council of State set becomes eligible: Governor, Lt.
   Governor, Attorney General, Secretary of State, Auditor, Treasurer,
   Agriculture/Insurance/Labor Commissioners, Superintendent of Public
   Instruction; grounded against real election rows then, not invented now).
   **No judicial offices** (no existing
   state's eligible list has any — grep-verified precedent from the Ohio
   plan); DA deferred with them. **County and municipal candidates excluded**
   — they file with county boards and appear in the state portal only when
   filed electronically; never advertise local coverage.
3. **Support/oppose fail-closed**: only expenditure rows with
   `ExpenditureTypeDesc = "Independent Expenditure"` AND explicit
   `Declaration` of `Support`/`Oppose` enter outside totals. Blank or other
   declarations → excluded-amount + row-count diagnostics. Never infer
   direction from a group's name or politics. Electioneering communications
   stay out entirely. **Single-source rule (added after PR 3 review)**:
   outside totals are aggregated ONLY from reports discovered via the IE
   doc-type inventories (`IRIEX`/`IRCIX`/`RPIER`) — the spike found the same
   IE row duplicated verbatim in a registered committee's regular quarterly
   (Carolina Federation, results item 9), so counting both sources
   double-counts. Regular-report rows that pass this decision's filters
   become a cross-check diagnostic instead: a committee with IE-typed
   regular-report rows but no ingested IE informational report is flagged
   for audit, catching the inverse miss.
4. **Outside amount = `IEAmount`, never `Amount`** (verified live: report
   RID=232624 has 39 target rows; `IEAmount` sums to $29,306.30 = official
   total, while `Amount` repeats the full vendor invoice on every target row
   and sums to $49,306.29 — a $20K overstatement). Reconcile the `IEAmount`
   sum to the report's official expenditure total with a tolerance of one
   cent per split vendor transaction, not a percentage. No dedup on
   (date, vendor, `Amount`) — one invoice legitimately yields several target
   rows; expenditure fingerprints (decision 8) include candidate, direction,
   and `IEAmount`. **Form-dependence found after PR 3 review**: on
   registered-committee IE rows (`IRCIX` informational reports and their
   regular-report mirrors) `IEAmount` can be **null** with `Amount` holding
   the true single-target value (Carolina Federation's $10,500 Pivot Group
   row, both views). Amount-field semantics are pinned **per report form**
   at PR 6: `IEAmount` where populated (the multi-target vendor-invoice
   inflation lives on the unregistered form), `Amount` only where `IEAmount`
   is null on a registered-committee form — and the official-total
   reconciliation is the guard either way; a form that fails it quarantines.
5. **Candidate matching — fail closed.** Direct link: exact normalized
   candidate name + one active, non-exempt candidate committee from the
   committee search; multiple plausible matches quarantine; manual override
   keyed by `SBoEID`. Outside targets: rows carry `Candidate` — observed in
   **both token orders across filers** (`PIERCE RODNEY`, `PIERCE RODNEY D`,
   and `RODNEY PIERCE` all name the same person; spike results item 4) —
   + `OfficeSought` ranging from broad (`House`) to district-bearing
   (`NC HOUSE 27`). The name normalizer must match order-insensitively
   (pinned at PR 6 from fixtures) — order-sensitive exact matching would
   silently drop a filer's whole report. Match = normalized name + cycle uniquely matching
   exactly one NC candidate, with office as a *confirming* filter only
   (Ohio's decision-5 lesson: requiring office quarantines the biggest rows).
   **Federal targets are filtered before matching** (verified live:
   `US HOUSE OF REPRESENTATIVES` rows appear in the same report) — FEC owns
   federal money; NC federal rows survive only as audit artifacts. No fuzzy
   matching anywhere.
6. **Outside-group identity**: `SBoEID` when present; else the portal's
   numeric `OrgGroupID` resolved by exact entity search as `NC-OGID:<id>`;
   else a synthetic source-scoped key `NC-IE-FILER:<sha256-of-normalized-name>`.
   All keys uppercase by definition, so the writer's unconditional upper-case
   normalizer never mangles a namespace. Never key on the literal `No Id`. Noncommittee filers' same-report donation rows
   (verified live: Rolling Sea Fund $24,506 `Donation` inside the Advance NC
   IE report) aggregate under the label **disclosed IE funders** — never
   presented as the group's full funding, never backfilled from older cycles.
7. **Occupations ship for NC** (the feature Ohio had to kill): built only
   from itemized individual receipts —
   `ReceiptTypeCode == "IND "` (**trailing space is real**, pin it),
   `IsAggregated == false`, `Amount > 0`. Sum `Amount`; never `SumToDate`
   (contributor-cumulative). `Profession` and `EmployersName` are separate
   fields; never infer occupation from employer. Placeholder vocabulary
   (`Not Employed`, `Retired`, `Self`, blank, …) is pinned from spike bytes
   and excluded from `top_occupations` (counted in diagnostics). Employer
   values live in raw artifacts/diagnostics only — the canonical direct
   tables accept only `occupation` and `contribution_size` categories
   (industry routing is a deferred factory capability, per plan.md), so no
   direct employer/industry rows are written. Aggregated individual
   money stays in direct totals but outside occupation rows. Publish
   occupation dollar coverage as a diagnostic.
   **Derived-stat inputs (REVISED after PR 3 review)**:
   `direct_contribution_total` comes **from the cover summary** — the spike
   proved the cover carries `Contributions from Individuals` +
   `Aggregated Contributions from Individuals` as separate authoritative
   sections (results item 2), so the individual-money total follows the same
   cover-is-authoritative rule as `total_receipts` (decision 11) and the
   itemized+aggregated receipt-row sum becomes its reconciliation
   diagnostic. Contribution-size buckets = itemized individual transaction
   amounts (VoteApp standard buckets). The `ReceiptTypeCode` → (official
   receipts / direct contributions / size buckets / occupations) mapping
   table is seeded from spike bytes and grows at PR 4/6 fixture time; a code
   outside the pinned set **quarantines the derived breakdowns only**
   (occupations + size buckets) for that candidate — cover-derived totals,
   including `direct_contribution_total`, are unaffected — and always as a
   counted diagnostic, never just a counter.
8. **Report selection + amendments** (**grouping REVISED at the spike, keys
   settled after PR 3 review** — two levels, don't conflate them):
   - *Row-merge key* — assembles one filing from its split inventory rows:
     (filer, `DocumentType`, `ReportType`, period start, period end,
     `IsAmendment`). The same filing can appear as a DATA row and a separate
     IMAGE row (results item 8); merge is allowed **only when unambiguous**:
     exactly one DATA row + at most one IMAGE row = one filing; an all-DATA
     group = a chain of distinct structured filings (Berger's Mid-Year 2025
     has two amendments, RIDs 225581 and 232191 — `IsAmendment` is a flag,
     not a counter, so it cannot tell them apart); any other mix (an extra
     IMAGE row that could be a newer image-only amendment hiding behind an
     older structured one) is ambiguous lineage → quarantine the group.
     **PR 4 probe result (from spike bytes): NO amendment counter exists** —
     `dataCover` carries only `ReportVersion` (a form version, "2007" on
     every probed cover) and the CSV COVER section has no counter either, so
     the heuristic stays. What the cover DOES carry is `FiledDate`, which
     differs between an original and its amendment (Berger YE-2025:
     01/30/2026 original vs 07/10/2026 amendment) — per-filing chronology
     evidence for the PR 6 selector, available without any counter.
     Second parser finding: inventory `IsAmendment` can be **blank** — only
     on correspondence/certification noise rows in every sampled inventory,
     never on Disclosure or Informational Reports — parsed as null, and the
     selector must treat null as ambiguous (quarantine), never as "not an
     amendment".
   - *Selection group* — picks the current filing: the same key **without
     `IsAmendment`** (originals and amendments must share a group or an
     amendment could never supersede its original). Within it, select by
     **filing chronology first** — newest `ImageReceiptDate` (what was
     legally filed last; for a merged filing, the max available date across
     its rows), with `DataImportDate` only as tie-break; import order is
     administrative and can lag or reorder (an older amendment imported
     later must not beat a newer one). If a group's lineage stays ambiguous
     (multiple non-amendment originals sharing a period beyond the 48-hour
     case), fail closed and quarantine the group. **If the
   selected-newest filing in a group is image-only (`DataLink` empty), the
   period is superseded-unavailable — never silently keep the older
   structured report. When that (or a failed reconciliation) hits a required
   direct period, the sync WRITES the honest snapshot: direct summary fields
   null + direct breakdowns emptied (outside totals preserved by the writer's
   preserve-when-null policy) — it does not skip the write and leave stale
   money visible.** A transport failure is different: keep the previous valid
   snapshot (ohio distinction — absence of evidence vs evidence of
   supersession). Receipts keep source `GroupID` + report ID; expenditure row
   identity = report ID + row ordinal within the report (byte-identical
   legitimate rows must survive — Ohio's V-PAC filed three identical $150K
   rows). No cross-report dedup in v1; overlapping-period duplicate-looking
   rows land in a diagnostic, and a dedup rule is added only if the spike
   proves the portal actually repeats transactions across selected reports.
   Whole-artifact refresh: rebuild each candidate snapshot from the current
   selected set; replace, never append.
9. **Paging + fail-closed transport** (both found in re-verification, absent
   from the feasibility report; **paging contract REVISED at the spike** —
   see results item 1):
   - `GetReceipts`/`GetExpenditures` **require `page` (0-indexed) and
     `pageSize`** — a bare call returns HTTP 200 with an HTML error page.
     Spike finding: the server then **ignores `pageSize`** and serves fixed
     300-row disjoint pages; `Content-Type` stays `text/html` even for real
     JSON. Every JSON fetch validates content shape (parses as JSON, has
     `Data.results`) and pages until row count equals `recordCountKey`;
     mismatch fails the report closed.
   - The doc-type inventory GET requires **single-quoted codes**:
     `/CFDocLkup/DocumentResult/?year=<Y>&reports=%27IRIEX%27,%27IRCIX%27,%27RPIER%27`
     — the unquoted form is an error page. Query all three IE codes for both
     cycle years (2026 inventory verified live: 95 filings = 72 structured +
     23 image-only, 4 amendments).
10. **Artifact retrieval**: plain HTTP with a descriptive user agent works —
    no browser session needed (the opposite of Ohio). Low concurrency (1–2
    in flight), delays between requests, bounded retries with backoff.
    Retrieval stays separate from parsing: fetch → validate → SHA-256 →
    atomic install with manifest; sync reads cache only. **The portal is an
    early-2000s ASP.NET app the state is actively replacing** (2026-05 RFP)
    — route changes are expected migration work, so every route lives in the
    client module, nowhere else. Report IDs are discovered from inventories
    each run, never hardcoded.
11. **Summary calculation**: for election year Y, select regular reports
    covering Y−1 and Y within the candidate's cycle. `total_receipts` /
    `total_disbursements` = sum of selected reports' official **Period**
    section values (cover summary is authoritative; itemized sums are
    reconciliation diagnostics — Ohio's lesson: itemized-only missed a
    $25.4M non-itemized transfer). `cash_on_hand` = latest selected report's
    end-of-period cash; **never sum cash across reports**. The Y−1..Y window
    is the house convention for every state including 4-year offices
    (maryland + ohio governors, grep-verified) — NC does not invent
    office-term cycle math. The newest report's **Cycle** column ("Total this
    Election") is a second cycle-level check only; **semantics CONFIRMED at
    the spike** (results item 11): Cycle = election-cycle-to-date, resetting
    after the office's election, with chain-exact arithmetic
    `Cycle_n = Cycle_{n-1} + Period_n` — so the check is valid only when
    summing every report since the office's cycle start, and for mid-cycle
    4-year offices it spans more than Y−1..Y; the Y−1..Y summary window
    itself is unchanged. On mismatch, drop the check for that office class,
    never widen the window.
    **48-hour reports never enter totals** (their contributions
    reappear on the next scheduled report; on the probed committee they were
    image-only anyway). Negative cash: write NULL + diagnostic, never clamp
    (canonical schema rejects negatives).
12. **Flags** (free read flag ON in `backend/.env` per policy; others off):
    - `NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED`
    - `NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED`
    - `NORTH_CAROLINA_NCSBE_RAW_DATA_REFRESH_ENABLED` (house raw-refresh
      naming)
    Paper/PDF fallback gets its own flag only when that path is built.
13. **Structured-coverage gap is disclosed with the totals**: set the
    loader's `outsideCoverageNote` (the seam decision 13 of the Ohio plan
    built). The gap is **reports without a structured `DATA` view** (23 of 95
    IE filings in the 2026 inventory) — not "paper filings": staff-entered
    paper reports can gain a `DATA` view, and e-filing thresholds differ by
    filer type, so small filers may legally file paper indefinitely. Remove
    the note only when a reviewed, fail-closed PDF/image path ships
    (out of v1; last on the ladder, own gated flag). Never OCR into
    production totals.
14. **Source label**: `"NORTH_CAROLINA_SBE"` — `ILLINOIS_SBE` is the exact
    precedent (Illinois State Board of Elections). New member in
    `ballotLookupFinanceShared.ts` source union + `FINANCE_SUMMARY_SOURCES`,
    registry entry in `ballotLookup.ts`, **and a display label
    ("North Carolina State Board of Elections") in
    `packages/api-client/src/format.ts` `FINANCE_SOURCE_LABELS` + test** —
    the fallback title-cases raw enum values (`OHIO_SOS` renders "Ohio Sos"
    today because its label was never added; do not repeat that).
15. **Artifact manifest fields**: route + query params, report/document IDs,
    retrieval time, SHA-256, byte size + row count vs `recordCountKey`,
    amendment flag + import dates, parser version. **Revised at PR 4**: no
    "data current as of" stamp exists anywhere in the portal bytes (checked
    search/inventory/cover pages), so the manifest records `retrievedAt`
    only; and cover-vs-itemized reconciliation is aggregation work (PR 6),
    so the per-artifact reconciliation field is the transaction pages'
    `rowCount` vs `recordCountKey` — enforced at fetch time by the paging
    loop, recorded per page.

## Acquisition spike must confirm (or revise) before parser work

- Paging behavior on a large report (rows > pageSize; verify
  `recordCountKey` completeness contract) — probes only saw ≤39-row reports.
- Full `ReceiptTypeCode` vocabulary (probes saw `IND ` and `PPTY`) and the
  cover-summary `Section` vocabulary — pin both, fail closed on strangers.
- Occupation placeholder vocabulary from real bytes (decision 7).
- `Candidate` name format variants in IE rows (`LAST FIRST` vs
  `LAST FIRST MIDDLE`) and `OfficeSought` variants (`House` / `N.C. House` /
  federal strings) — pin the normalizer table.
- Structured-vs-image **dollar** coverage for the cycle (the 72/23 split is
  filing counts, not dollars) — feeds the coverage-note wording.
- SBoEID pattern across committee types (decision on the validation regex).
- Rate-limit behavior under a real full-cycle pull (Ohio hit 429s; NC probes
  were too small to know).
- Whether every 2026 candidate committee's current report has structured
  `DataLink` (the e-filing thresholds mean small committees may be
  image-only — measures direct-finance coverage, not just outside).
- **IE completeness**: whether registered committees' independent
  expenditures appear ONLY in the `IRIEX`/`IRCIX`/`RPIER` inventories, or
  also/instead inside their regular quarterly reports (`ShowIEColumns` rows)
  — a miss means undercounting, an overlap means double-counting; pin the
  rule from a spender with known IE activity in both views.
- 48-hour reporting for **IE filers specifically** (their regime differs
  from candidate committees' — confirm whether IE 48-hour rows also appear
  on a later scheduled report before excluding them like direct 48-hours).
- "Total this Election" Cycle-column semantics on a 4-year-office report
  (decision 11's secondary check; a 2026-only spike can use any Council of
  State committee's prior filings).
- The full `ReceiptTypeCode` mapping table (decision 7) from real bytes.
- Whether transactions ever repeat across selected overlapping-period
  reports (decision 8's dedup question).

## Acquisition spike results (run 2026-08-07, user-authorized)

~60 paced requests (1 in flight, ~2s gaps, descriptive UA), zero blocks or
429s. Artifacts + SHA-256 manifest cached under
`scratch/north-carolina-campaign-finance/ncsbe/` (gitignored — never
committed). Sample: 9 committees (Berger, Hall, Grafstein, Galey, Jeffers,
Pierce, Gadson legislative; Stein Council of State; Carolina Federation
Freedom PAC IE filer — added in the post-review follow-up, plus Down Home NC
IE PAC) + both IE inventories + 9 report covers + 7 receipt sets + 7
expenditure sets + 1 CSV export.

Verdict: **NC is feasible and the plan survives the spike.** No new factory
capability, no schema change — migration 212 stands. Every probe money number
reproduced (Gadson $6,073.24; IE `IEAmount` $29,306.30 vs `Amount`
$49,306.29; Rolling Sea Fund $24,506 funder row). **11 of 13 items fully
answered; items 8 (population-wide structured coverage) and 12 (full
receipt-code vocabulary) are answered for the sample only and close at PR 9's
live-run audit** — each says so inline. Spike-item answers:

1. **Paging contract (REVISES decision 9's assumption):** the server
   **ignores `pageSize` entirely** and returns fixed **300-row pages**,
   0-indexed and disjoint; a report smaller than 300 rows arrives whole on
   page 0; pages past the end return 0 rows. Verified on 111-row (1 page),
   335-row (300+35), and 121,124-row (300/page) reports. Completeness = loop
   pages until fetched row count equals `recordCountKey`, fail closed on
   mismatch. **`Content-Type` is `text/html` even for real JSON** — validate
   body shape (`Data.results` + `recordCountKey`), never the header.
2. **Cover summary = 34 fixed `Section` strings** with stable `Sequence` ids
   and numeric `Period`/`Cycle` values (no string parsing). Component sums
   reconcile to `Total Receipts`/`Total Expenditures` exactly.
   `Debts and Obligations owed BY the Committee` maps to canonical
   `debts_owed`. "Contributions from Individuals" + "Aggregated Contributions
   from Individuals" give `direct_contribution_total` inputs straight off the
   cover. Beware: `ReportDetail` also embeds a JS grid config mentioning
   `Section` — extract the `{"Sequence":…}` data rows, not the first array.
3. **Occupation placeholders (observed, case-varying):** `Not Employed`,
   `Not employed`, `Retired`, `Homemaker`, `homemaker`, `No Job Title`,
   blank, plus junk value `United States` (21×) — placeholder matching must
   be case-insensitive; `Profession` is free text (135 distinct across 542
   itemized rows).
4. **IE target formats:** `LAST FIRST`, `LAST FIRST M`, **and `FIRST LAST`**
   — Rodney Pierce appears as `PIERCE RODNEY`, `PIERCE RODNEY D`, and
   `RODNEY PIERCE` across three filers' reports, so the matcher must be
   token-order-insensitive (decision 5 updated). **Real misspellings of the
   same target across filings** (`DEBERRY SATANA` / `DEWBERRY SANTANA`) —
   fail-closed matching quarantines them, as designed. Sentinel value
   `SPECIFIC NON CANDIDATE` = known non-candidate target, pin as excluded.
   `OfficeSought` variants: `House`, `NC HOUSE 27` (district-bearing),
   `US HOUSE OF REPRESENTATIVES`, `U.S. HOUSE OF REPRESENTATIVES` (filter
   both federal spellings), `County/Municipal` (out of scope).
5. **Dollar coverage of image-only filings is unmeasurable** — they carry no
   structured dollars anywhere and OCR is banned, so the count split (2026:
   72 structured / 23 image; 2025: 35/16) is the only honest number. The
   PR 2 coverage note is deliberately count-free; keep it that way.
6. **SBoEID pattern:** `^([A-Z]{3}|\d{3})-[A-Z0-9]{6}-[CF]-\d{3}$` — prefix
   is `STA` or a county alpha/numeric code; `F` = legal-expense fund
   (**exclude F-type from candidate finance**; Berger has one). Literal
   `No Id` on unregistered IE filers (decision 6 stands). `CandName` can be
   the literal string `&nbsp;` — HTML entities occur inside JSON values;
   decode or reject.
7. **Rate limits:** none observed at ~55 requests with 2s pacing. Full-cycle
   scale still unproven — keep decision 10's pacing + bounded retries.
8. **Direct structured coverage: 8/8 SAMPLED committees fully structured**
   for 2025–26 — sampled evidence only; the checklist question ("every 2026
   candidate committee") **stays open** and is measured for the full
   population as a free byproduct of the first live sync (PR 9 reports it).
   The sample did force a **grouping revision (decision 8): the same filing
   can appear as TWO inventory rows** — a DATA row (`DataLink` set,
   `ImageReceiptDate` often empty) and an IMAGE row (`DataLink` null, image
   date days later) — which must be merged before any
   image-only-supersession test, else a healthy e-filed report reads as
   superseded-unavailable. Because `IsAmendment` is a flag, not a counter,
   merging is restricted to unambiguous one-DATA/one-IMAGE groups and
   all-DATA amendment chains; anything else quarantines (full rules +
   the PR 4 amendment-counter probe now live in decision 8). Single rows
   with both links also occur.
9. **IE completeness — REVISED after a second-filer check (PR 3 review
   follow-up): filers are INCONSISTENT, and the double-count is real.**
   Down Home NC IE PAC: zero row overlap between its IE informational report
   and its regular quarterly (IEs only in the informational). Carolina
   Federation Freedom PAC: its single IE row ($10,500 Pivot Group →
   RODNEY PIERCE, Support) appears **verbatim in BOTH** its `IRCIX`
   informational report and its regular Q2 as an
   `ExpenditureTypeDesc: "Independent Expenditure"` row — so decision 3's
   row filters alone would double-count it. Rule (now in decision 3):
   aggregate outside totals ONLY from IE-inventory-discovered reports;
   IE-typed regular-report rows become the cross-check diagnostic that
   catches the inverse case (a filer whose IEs appear only in regular
   reports). Provisional on n=2 — PR 9's advanced-transaction-search spot
   audit is the population-level gate. Separately: candidate-committee
   regular-report `ShowIEColumns` values can be **junk** (`Declaration:
   Oppose` + `Candidate` = vendor name on plain Operating Expense rows — 119
   of Berger's 129), excluded independently by the `ExpenditureTypeDesc`
   conjunction.
10. **48-hour filings — exclusion stays PROVISIONAL.** None appear in either
    year's IE doc-type inventories, but an IE filer's own inventory can
    carry one (Carolina Federation has a 2026 48-Hour informational,
    image-only) — the three IE codes don't surface them. All 385+ sampled
    48-hours are image-only (`DataLink` null), so structured-only ingestion
    excludes them mechanically; what the spike could NOT verify (images,
    OCR banned) is decision 11's premise that excluded 48-hour money
    reappears on the next scheduled report. If it doesn't, direct totals
    undercount. Cover section `48-Hour Notice Reports Sum` is the per-report
    diagnostic hook, and PR 9's portal-search spot audit is the gate that
    would expose any systematic gap.
11. **Cycle column semantics PROVEN:** `Cycle_n = Cycle_{n-1} + Period_n`
    chain-exact on Stein (4-year office) and Pierce; Berger's chain closed
    only through his amended YE-2025 report (a real $6,800 amendment delta —
    live proof amendment selection changes money). Cycle = official
    election-cycle-to-date (resets after the office's election), **not
    Y−1..Y** — usable as a secondary check only when summing every report
    since cycle start; the Y−1..Y house window stands unchanged.
12. **ReceiptTypeCode — PARTIAL, by design.** Pinned from sample bytes:
    `"IND "` (trailing space confirmed; also on aggregated rows — those are
    `IsAggregated: true` with `OrgName` `Aggregated Individual
    Contribution`), `"CPCM"` (other political committee), `"PPTY"` (party).
    Noncommittee IE-filer funder rows use `ReceiptTypeDesc` `Donation`. The
    checklist asked for the FULL mapping table; a finite sample cannot prove
    vocabulary completeness (the sampled committees simply had no loans,
    interest, or refunds), so the deliverable is restated honestly: the
    pinned set is **seeded** here and **extended at PR 4/6 fixture time**,
    with decision 7's stranger-code quarantine as the permanent guard —
    and since `direct_contribution_total` is now cover-derived (decision 7
    revision), an unknown code can only ever quarantine breakdowns, never
    totals.
13. **No cross-report transaction repeats within a source chain:** Pierce
    Q1/Q2 disjoint (0 of 281), and Advance NC's overlapping-period IE
    reports are **incremental, not cumulative** (0 of 7 rows repeated
    despite nested periods). The one verbatim repeat found lives **across
    source chains** — an IE row mirrored into the filer's regular quarterly
    (item 9) — and is handled structurally by decision 3's single-source
    rule, not row dedup. No dedup rule; keep the overlap diagnostic.

Extra findings for PR 4–7: report cadence is quarters in election years,
semi-annuals off-year, plus `Organizational` and `Interim` types (both can
carry `DataLink`) — the selector matches `DocumentType = "Disclosure Report"`
rows by **period overlap with Y−1..Y**, not a report-type whitelist;
correspondence/penalty/Statement-of-Organization/Certification rows are
noise. Committee-search JSON keys: `OrgName`, `SBoEID`, `OldID`, `CandName`,
`StatusDesc` (`ACTIVE (NON-EXEMPT)`, `CLOSED`, `CLOSED (PENDING)`,
`CONDITIONALLY CLOSED`, `INACTIVE`), `OrgGroupID`. CSV export works
(`text/csv`, COVER section + `Committee Type: Candidate Committee` — resolver
evidence). Receipts carry `GroupID`; expenditure rows have no row id —
report ID + ordinal stands (decision 8). Real data-quality landmine: a
`PeriodEndDate` of `06/01/3026` (year 3026) sits in Carolina Federation's
live inventory — every parsed date gets a sane-range check (fail closed,
count in diagnostics), and period math must never trust raw bounds.

## Required artifacts per cycle Y

- Committee search result per roster candidate (resolver evidence)
- Document inventory per linked committee (Y−1, Y)
- Selected regular reports: cover/summary JSON + receipts JSON + expenditures
  JSON (+ CSV export for reconciliation spot checks)
- IE doc-type inventories: `IRIEX`, `IRCIX`, `RPIER` for Y−1 and Y
- Selected IE reports: expenditures JSON (`ShowIEColumns=true`) + receipts
  JSON (noncommittee disclosed funders, decision 6)
- For #3: registered spender committees' document inventories + regular-report
  receipts (funders/industries)
- Coverage-gap table rows for every image-only filing encountered

## Module layout

`backend/src/pipeline/northCarolinaFinance/`: portal client (all routes +
fail-closed transport), artifact cache, report inventory + snapshot selector
(amendment logic), candidate committee resolver, direct-contribution
aggregator, outside-spending aggregator, outside-group contribution
aggregator (#3, last), writer wrapper, ballot-lookup loader wrapper, eligible
offices, auto-link, sync, batchSync, `index.ts`.

## PR sequence (one PR at a time; `npm run typecheck` + `npm test` green in `backend/`; cite matrix row)

Code-only PRs 1–2 are data-independent and proceed under the no-portal rule.
The acquisition spike is the gate before parser/aggregator work.

1. Migration + writer wrapper + writer test + eligible offices (+ test) +
   feature flags **wired into `backend/.env` and `render.yaml`**.
2. Loader wrapper + characterization pin + flag-gate test + `ballotLookup.ts`
   registry + `NORTH_CAROLINA_SBE` source union entry + `format.ts` display
   label (+ test) + coverage note.
3. **Acquisition spike** (needs user authorization for portal access; no
   migration, no DB writes): pull the 2025–2026 cycle-to-date for several
   candidates
   spanning statewide/legislative + the complete IE inventory; confirm/refute
   every item in "Acquisition spike must confirm"; capture real fixtures;
   produce reconciliation + occupation-coverage + structured-coverage
   reports.
4. Portal client + artifact cache + parsers (fail-closed transport per
   decision 9, manifests per decision 15, fixtures from spike) **+ committed
   acquisition script** (label/inventory-driven discovery, paced sequential
   fetches, SHA-256 + manifest install).
5. Committee resolver (+ test) + auto-link (+ test).
6. Aggregators: direct contributions (occupations per decision 7, summary per
   decision 11) + outside spending (decisions 3–5, `IEAmount` reconciliation)
   (+ tests).
7. Sync + batchSync (due-list builder config) + npm scripts
   (`north-carolina-candidates:finance:*`, ohio block as template) +
   scheduler.
8. **#3**: outside-group contribution aggregator (TN/OH pattern) + registered
   spender receipts + noncommittee disclosed-funders + committee-label /
   industry-label queue entries.
9. **First live run through the committed acquisition script** (the final
   gate — fresh portal pull, full sync, money-reconciliation + match-rate +
   coverage report, **including an advanced-transaction-search spot audit**:
   sample candidates' portal-search totals vs pipeline totals, catching rows
   the report-type inventories missed). Later, separately gated: PDF/image
   fallback; when it ships, remove the coverage note.

## Status

- [x] PR 1 schema + writer + flags (env + render.yaml) — migration 212;
  eligible set DB-grounded 2026-08-06: only `state_upper::State Senator` +
  `state_lower::State Lower Chamber Legislator` (zero Council-of-State 2026
  rows; the lone statewide row is United States Senator = federal/FEC)
- [x] PR 2 loader + wiring + coverage note — characterization pin, `NC`
  registry entry, `NORTH_CAROLINA_SBE` union + `FINANCE_SUMMARY_SOURCES` +
  `format.ts` label ("North Carolina State Board of Elections") + test
- [x] PR 3 acquisition spike — RUN 2026-08-07 + review follow-up (see
  "Acquisition spike results"): 11 of 13 items fully answered; items 8 and
  12 sample-answered, closing at PR 9's live-run audit. Paging contract +
  grouping keys + IE single-source rule + cover-derived
  `direct_contribution_total` revised; Cycle chain proven; no schema or
  factory change needed
- [x] PR 4 client + cache + parsers + acquisition script — 2026-08-07, from
  spike bytes only (no portal hits): `northCarolinaNcsbeClient.ts` (all
  routes + paced serialized transport + recordCountKey-complete paging),
  `northCarolinaNcsbeParsers.ts` (bracket-scan embedded-JSON extraction, 34
  pinned cover sections, SBoEID regex, sane-range dates, verbatim
  `"IND "`/`"DON "` codes), `northCarolinaNcsbeArtifactCache.ts`
  (validate-before-install, SHA-256 + per-artifact manifest, parser-version
  staleness), `northCarolinaNcsbeArtifactAcquisition.ts` (inventory-driven
  discovery, period-overlap selection incl. bad-date widening,
  DataImportDate skip logic, per-report failure isolation) +
  `refreshNorthCarolinaNcsbeCampaignFinanceRawData.ts` script wired as
  `north-carolina-candidates:finance:raw:refresh` (flag-gated). Real spike
  bytes committed under `backend/tests/fixtures/northCarolinaFinance/`
  (11 fixtures). Decision 8 amendment-counter probe answered (none exists;
  cover `FiledDate` is the chronology bonus); decision 15 manifest revised;
  new blank-`IsAmendment` noise-row finding folded into decision 8
- [x] PR 5 resolver + auto-link — 2026-08-07, fixture-driven (no portal
  hits): `northCarolinaCandidateCommitteeResolver.ts` (decision 5 fail-closed
  direct link over committee-search rows: strict `CandName` name-key match
  with middle/suffix conflict guard — ohio machinery + NC digit-suffix
  handling ("SIDNEY RALPH PIERCE 3" = III), restricted to
  `ACTIVE (NON-EXEMPT)` + STA-prefixed `-C-` SBoEIDs; county prefixes are a
  live mislink hazard (active same-name county sheriff in the pierce
  fixture) so non-STA rows never match — a hypothetical county-filed
  legislative committee goes unmatched → manual link, never mislinked;
  multiple matches quarantine as ambiguous; match carries `orgGroupId` so
  the sync can fetch inventories without a second search) +
  `northCarolinaCandidateCommitteeAutoLinker.ts` (ohio keyset-cursor
  full-window walk over `nc_candidate_finance_links`, with a per-candidate
  `loadCandidateSearchRows` seam — NCSBE is searched per candidate, so the
  PR 7 sync owns pacing/caching and this module never fetches; loader
  returns rows + the search URL as link provenance). OGID is deliberately
  NOT persisted on the link row: manual links are keyed by SBoEID alone
  (decision 5), so the PR 7 sync must derive SBoEID→OGID for every link
  kind — exact-SBoEID filter over the per-cycle committee-search artifact
  ("Required artifacts per cycle Y") — while same-run auto-link results
  carry `orgGroupId` so a fresh resolution skips that lookup
- [x] PR 6 aggregators — 2026-08-07, fixture-driven (no portal hits), three
  pure modules the PR 7 sync feeds from the artifact cache:
  `northCarolinaReportSelector.ts` (decision 8 as written: structured rows
  dedup by report id across inventories; row-merge allows 1 DATA + ≤1 IMAGE,
  all-DATA amendment chains, or a single IMAGE row — any other mix
  quarantines; selection groups drop `IsAmendment`, order by
  `ImageReceiptDate` then `DataImportDate` then the amendment flag itself —
  a same-day amendment still beats its original by flag semantics, but two
  amendments tying on the whole key quarantine (`ambiguous_filing_chronology`;
  review round: report ids are NOT chronology evidence — nothing pins them
  monotonic — so money is never selected by id ordering); null flags,
  multiple originals, and a chronology pick that puts an original over an
  existing amendment all quarantine; image-only current filing =
  superseded-unavailable, never a fallback). `northCarolinaDirectContributionAggregator.ts` (decisions 7+11:
  cover-authoritative Period sums for receipts/disbursements + cover 15+20
  for `direct_contribution_total`; latest-report cash with negative→NULL;
  Cycle chain check as an advisory consecutive-report diagnostic;
  occupations + size buckets from itemized `"IND "` rows with the
  case-insensitive placeholder set, contributor identity = receipt `GroupID`;
  unknown receipt codes quarantine breakdowns only — direct-known set pinned
  to `IND `/`CPCM`/`PPTY`, `DON ` stays IE-side; three outcomes: `ok`,
  `honest_null` — supersession/ambiguity proof → write null summary + empty
  breakdowns — and `incomplete_artifacts` — missing cached report OR a
  cover whose own period contradicts its inventory filing (mispaired
  artifact, checked before any summing; review round) → do NOT write,
  reacquire; IE-typed regular rows counted as the decision-3 cross-check).
  `northCarolinaOutsideSpendingAggregator.ts` (decisions 3–6: pinned two IE
  report types; per-form amounts — `IEAmount` required on the unregistered
  form, `IEAmount ?? Amount` on the registered form; per-report
  reconciliation gate vs cover official total with one cent slack per split
  vendor row; token-order-insensitive target matching via a LAST-first
  reading layered on the resolver matcher; federal/`SPECIFIC NON CANDIDATE`/
  County-Municipal rows filtered with money counted; office+district
  confirm-only filters; group keys `SBoEID` else `NC-IE-FILER:<sha256>`
  — the `NC-OGID:` variant needs a portal entity search; PR 8 deferred it
  into the pre-PR 9 acquisition work (the hash key already carries identity);
  overlapping-report duplicate-looking rows surfaced, never deduped;
  image-only/quarantined filings emitted as coverage-gap rows). Live-run
  watch item for PR 9: unregistered IE filers' report covers have never been
  parsed (no fixture) — if their summary grid deviates from the 34-section
  pin, those reports quarantine as `missing_official_total` until the parser
  learns the form.
- [x] PR 7 sync + batchSync + scripts + scheduler — 2026-08-08, cache-fed
  (zero portal hits, decision 10 honored literally: the sync never fetches).
  `northCarolinaCandidateFinanceSync.ts` (per-candidate write step, ohio
  shape, taking aggregation RESULTS; enforces the PR 6 three-status contract —
  `ok` and `honest_null` both write [the writer's preserve-when-null keeps
  outside totals through an honest null], `incomplete_artifacts` THROWS so a
  direct caller can never write suspect money; manual link provenance rides
  through untouched; funders/industry enrichment deliberately absent until
  PR 8). `northCarolinaCandidateFinanceBatchSync.ts` (due list via
  `createStandardStateFinanceDueListQuery` with `link_source` in linkColumns +
  mapRow; auto-link over `createNcsbeCachedCommitteeSearchLoader` — the
  cached committee-search artifact keyed by the trimmed candidate name via
  `northCarolinaCommitteeSearchQueryForCandidateName`, fail-closed when the
  search was never cached; per-(year, committee) direct aggregation reading
  inventory + cover + complete transaction page sets from cache, replaying
  decision 9's completeness contract at read time [every page must agree on
  recordCountKey and the reassembled row count must equal it]; the
  incomplete_artifacts leg fails the item with per-report read failures in
  the error and never calls the sync; outside aggregation once per year over
  due rows + the year's full active-link universe [ohio's same-name-double
  guard], with the whole year failing closed to "unavailable" — stored
  outside totals preserved — when an IE inventory is uncached OR any
  selected structured IE report has no readable artifacts [Ohio's stale-31-U
  precedent: invisible money must not publish as a false zero]; portal-reason
  quarantines (reconciliation mismatch, null IEAmount) stay diagnostics; the
  decision-3 inverse-miss cross-check is wired here — IE-typed regular-report
  rows with no aggregated IE-inventory report for that filer flag
  `ieInverseMissSuspected` for the PR 9 audit). **Review round (2 accepted)**:
  (1) the outside target universe is the year's FULL NC candidate-election
  set, not just active links — IE targets match by NAME, so a same-name
  candidate with no link, an out-of-scope office, or a withdrawn candidacy
  still makes that name ambiguous, and a link-only universe would silently
  hand their money to whoever happens to be linked; extra targets only fail
  closed (absorb nothing or force a quarantine), and written rows stay
  limited to the due page. (2) the outside target key gained the normalized
  district (and swapped free-text office name for office SCOPE) — one person
  contesting the same office in two districts in one cycle must not share
  one slice across both races; district-less rows alias into the person's
  district-bearing canonical target so a manual link without a district
  never makes a person ambiguous with themselves. **Review round 2 (CodeRabbit,
  1 major + 3 nitpicks, all accepted)**: (a) the district-less alias is now a
  deterministic two-pass fold — pass 1 collects every known district per
  person+scope, pass 2 aliases a district-less row only when exactly ONE
  known district exists; with two or more, the key goes to
  `ambiguousDistrictlessKeys` and that due row's outside slice becomes null
  at write (writer preserves stored data) — no alias (arbitrary district's
  money), no district-less target (would quarantine even well-discriminated
  rows), no zeros (false zero). The reviewer's exactly-one guard alone was
  still order-dependent (due rows process first, so the district-less row
  became the canonical target and got upgraded by whichever universe
  district arrived first); the two-pass shape removes the order dependence
  entirely. (b) universe query year predicate is a sargable half-open date
  range instead of `extract(year …)`. (c) the outside leg's fail-closed
  unavailable message now names each missing IE report's read failure
  (matching the direct path's `reportReadFailures`). (d) test added: person
  with two known districts + district-less due row → slice null, direct
  still syncs, attribution stays on district 27. The sync needs NO OrgGroupID
  (inventories are cached by SBoEID alone) — the PR 5 SBoEID→OGID derivation
  note lands on the acquisition side, where the portal URL is built.
  Scheduler: `northCarolinaCandidateFinanceSyncScheduler.ts` (ohio clone;
  queue `north_carolina_candidate_finance_sync_maintenance`, daily cron
  default `25 10 * * *` offset from Ohio's 09:55) + 4 scripts
  (`sync-due`, `scheduler:upsert`, `scheduler:worker`, `scheduler:trigger`)
  under `north-carolina-candidates:finance:*`. **Known gap, owed before
  PR 9's live run**: the committed acquisition script still takes explicit
  `--committee <SBoEID>:<OGID>` args and never fetches committee searches —
  roster-driven discovery (search per roster candidate, committees from
  active links, OGID derived from the cached searches) must be added to the
  acquisition side, else auto-link has no cached searches to resolve against
  and every committee must be typed by hand.
- [x] PR 8 outside-group funders/industries (#3) — 2026-08-08, fixture-driven
  (no portal hits), tennessee/ohio pattern:
  `northCarolinaOutsideGroupContributionAggregator.ts` (pure aggregator: one
  candidate's outside groups + per-spender receipt rows keyed by group
  committeeId → uncapped donor rows + static-rule industry rows; pinned
  entity donor codes `CPCM`/`PPTY`/`"DON "` per decision 12 — `"IND "`
  individuals, `IsAggregated` roll-ups, blank names, non-positive amounts,
  and unknown codes each fail closed into counters, unknown codes listed).
  Spender receipt sources split per the plan: a REGISTERED spender (SBoEID)
  is read through its document inventory + the decision-8 selector's
  "Disclosure Report" rows (receipts only — IE informationals are not
  Disclosure Report rows, so IE money is never re-read); an UNREGISTERED
  filer (`NC-IE-FILER:` key) has no regular filings, so its disclosed
  funders are the `Donation` rows on its own selected non-quarantined IE
  reports (decision 6 — the selector's `NAME:` filer keys are re-derived
  through the same decision-6 id function to join the group ids exactly).
  Batch funder leg: spenders read once per year AFTER the outside leg
  succeeds; ANY spender read failure fails the WHOLE year's funder leg
  closed (funders null → writer preserves stored breakdown rows — a partial
  picture would publish "no disclosed funders" as a silent undercount),
  outside totals unaffected; summary gains
  `fundersAvailable`/`fundersError`/`funderReceiptRowCount`. Sync: ohio's
  enrichment verbatim — donor rows re-classified through rules + cached DB
  rows + manual verdicts (`resolveFinanceIndustryClassifications`), static
  industry rows discarded and rebuilt, every unresolved donor persists an
  'unknown' `finance_label_classifications` row (the manual industry-label
  queue), donor display rows capped per (committee, direction) only at
  persist (default 50) so classification always sees every donor; no AI
  classifier constructed (rule/cached-only, aiCallGuard untouched).
  Committee-label queue needs no new code — the
  `manual:finance-committee-labels:due` script enumerates the merged
  ballot-lookup read path, which PR 2's `FINANCE_SUMMARY_SOURCES` entry
  already covers. Deliberately deferred WITH the pre-PR 9 acquisition work:
  the `NC-OGID:` identity upgrade (needs a portal entity search) and
  registered-spender acquisition discovery — the acquisition script must
  also pull IE-inventory-discovered registered spenders' document
  inventories + receipts (today they'd need explicit `--committee` args),
  else live funder legs for registered spenders stay honestly unavailable.
  **Review round (P1+P2+P3, all accepted)**: (P1) the registered-spender
  receipts path originally read EVERY cycle inventory row (the acquisition
  fetch-set) — original + amendment both summed. Now it pipes through the
  exported `selectNorthCarolinaDirectCycleReportRows` filter + the
  decision-8 `selectNcsbeCurrentFilings` selector, exactly like the direct
  money leg, and a superseded-unavailable period or quarantined lineage
  throws (the direct leg's honest-null analogue → funders-unavailable, never
  a stale-original fallback). (P2) an unknown receipt-type code no longer
  ships a partial funder picture: decision 12 semantics — the affected
  CANDIDATE's funder slice is withheld (writer preserves stored breakdowns;
  precise because the aggregator only counts codes on that candidate's own
  spenders), and the codes surface on the year summary as
  `funderUnknownReceiptTypeCodes`. (P3) literal NUL separator bytes in the
  new aggregator's template keys made git treat the source as binary —
  replaced with escaped sequences (identical runtime strings), plus the same
  one-byte fix to the PR 6 outside aggregator that had shipped with it.
- [x] PR 9 live run — 2026-08-09, user-authorized portal access; full report
  in "PR 9 live run results" below (operator logs and raw sync JSON stay in
  `~/.claude/projects/-Users-shu-voteApp/nc-pr9-live-run/` on the run
  machine).
  First the owed acquisition-side work shipped: `--roster` mode on the
  refresh script + `northCarolinaNcsbeAcquisitionDiscovery.ts` (roster read
  from the DB before any portal request, pool closed for the paced run; one
  cached committee search per roster candidate under the SAME key the sync's
  auto-link loader reads — unlinked candidates refresh every run, linked
  reuse the cache; active links' OGIDs by exact-SBoEID filter over those
  searches with a committee-name-search fallback and a fail-closed skip when
  no search answers; resolver-matched committees pre-pulled so the first
  sync can aggregate; registered IE spenders discovered from the cached IE
  doc-type inventories and their inventories + reports acquired for the
  PR 8 funder leg, per-spender failure isolation). **Live results**: 312
  roster candidate elections, 312 searches, 167 auto-linked (53.5%, the rest
  fail-closed unregistered), 186 inventories, 770 report artifact sets
  (107 MB), 108 IE reports + 45 image-only, 19 spenders, zero fetch failures
  at the end. Sync wrote 167/167 with 0 failures: $12,870,748.95 receipts,
  $8,608,523.77 disbursements, $1,937,021.84 outside support, $90,000
  oppose, 3,937 direct breakdown rows (3,358 occupation), 33 outside groups
  / 66 funder rows; 39 honest nulls, every one with a portal reason (32
  image-only current filings, 7 contradictory lineages); 0 quarantined
  breakdowns, 0 inverse-miss flags. **Spot audit** (portal advanced
  transaction search vs pipeline, three committees): receipts match to the
  row and the cent on two (Hall 10,354 / $1,889,785.22; Lee 438 /
  $1,297,989.76); the third differs only by loan rows — `LOAN`/`OTLN`/`FRLN`
  the receipts endpoint never serves, and the same $300k Outstanding Loan is
  restated on all four reports, so an itemized sum would quadruple-count it.
  That is decision 11's cover-authoritative rule confirmed against live
  bytes. In-kind rows explain the expenditure deltas. **Eight defects found
  and fixed**, each from live bytes: (1) null `BoeID` on ~40% of covers;
  (2) 48-Hour Notices have no cover totals and their money rides the
  covering report — pinned as no-total, never fetched, never aggregated;
  (3) undated 1989–1994 filings now dated by `ReportYear` instead of being
  fetched and then failing a spender's whole funder leg; (4) covers paired
  by their own `rptID` (correct on all 770) instead of by period dates
  (wrong on 17 of 697, and the portal serves begin-after-end pairs) — eight
  candidates had been withheld as "mispaired"; (5) Independent Expenditure
  Reports are `DocumentType: "Disclosure Report"`, so they reached the
  direct leg — refuting PR 8's premise, killing the funder leg statewide,
  and leaving a latent IE double-count; now the outside leg's alone;
  (6) an amendment with no ImageReceiptDate sorted older than its original,
  quarantining six lineages; (7) six reviewed non-individual receipt codes
  (`OUTS`/`RFND`/`NFPC`/`GEN `/`CNRE`/`INT `) were quarantining 52 of 167
  candidates' occupations; (8) `OUTS` + `NFPC`, the largest funder money in
  the state ($12.7M), admitted as donor codes while `RFND` is pinned
  non-donor. Deferred with reasons: the `NC-OGID:` upgrade (the
  `NC-IE-FILER:` hash already carries identity and totals do not depend on
  it) and the PDF/image path (45 image-only IE filings plus the periods
  behind the 32 honest nulls; the coverage note already says so).
- [ ] Later, separately gated: PDF/image fallback (remove the coverage note
  when it ships); own feature flag for the NC raw refresh in `render.yaml`

Update the checklist + any changed decision here as PRs land; also update the
north-carolina memory at campaign end.

## PR 9 live run results (run 2026-08-09, user-authorized)

Portal data current as of 2026-08-08 (NCSBE footer). Cycle 2026 (Y−1..Y =
2025–2026). Zero AI calls; all writes local.

Acquisition (roster-driven, one paced 2 s pass, resumed once): 312 roster
candidate elections; 312 committee searches fetched + cached (0 failures);
167 committees discovered + 19 registered IE spenders; 770 report artifact
sets; 186 document inventories; IE inventories 2025 (51 filings) + 2026
(102); 108 structured IE reports fetched, 45 image-only never fetched;
107 MB cache; zero fetch failures after the fixes below.

Match rate: 167 of 312 auto-linked (53.5%). The 145 unmatched are the
resolver's fail-closed cases — no active non-exempt STA-prefixed candidate
committee matched the name exactly; none were mislinked.

Sync: 167/167 written, 0 failures. $12,870,748.95 total receipts,
$8,608,523.77 disbursements, $1,937,021.84 outside support, $90,000 oppose;
3,937 direct breakdown rows (3,358 occupation); 33 outside groups / 66
funder rows. 128 summaries carry money, 39 are honest nulls, every one with
a portal reason: 32 committees have ≥1 period whose current filing is
image-only (11×1, 9×2, 6×3, 6×4 periods), 7 have genuinely contradictory
lineages (4 multiple originals, 2 ambiguous chronology, 1 original later
than its amendment on both dates). Outside leg available: 108 IE reports
read, 9 portal-reason quarantines, 37 coverage-gap rows, 0 missing
artifacts, 65 unmatched targets (out-of-scope or non-unique names), 0
ambiguous. Funder leg available: 269 spender receipt rows, no unknown codes
left, 0 quarantined breakdowns, 0 inverse-miss flags. Year attribution was
$2,805,434.67 over 244 rows; money attributed to candidates without an
active link stays unpublished by design.

Advanced-transaction-search spot audit (portal search 01/01/2025–12/31/2026
vs the pipeline's selected reports):

| Committee | Portal receipts | Pipeline receipts | Verdict |
| --- | --- | --- | --- |
| CITIZENS FOR DESTIN HALL | 10,354 rows / $1,889,785.22 | 10,354 / $1,889,785.22 | exact |
| COMM TO ELECT MICHAEL LEE | 438 rows / $1,297,989.76 | 438 / $1,297,989.76 | exact |
| STACIE MCGINN FOR NC SENATE | 282 rows / $1,963,385.46 | 270 / $123,385.46 | explained |

No report the inventories missed, on any of the three. The two differences
are explained and are not defects: (1) expenditure deltas are in-kind rows
the report schedule lists but the transaction search does not count as EXP
(Hall: one $1,810.50 in-kind); (2) McGinn's $1.84M receipt gap is loan
activity — `LOAN`/`OTLN`/`FRLN` rows the report receipts endpoint never
serves, with the same $300,000 Outstanding Loan restated on all four of her
reports, so an itemized transaction sum counts it four times. That is
decision 11's cover-authoritative rule confirmed against live bytes.

## October 15, 2026 receipt-gap continuation

The existing ordinary batch already calls independent-expenditure aggregation;
acquisition is a separate, cache-producing operation. Its structured-data-only
coverage note remains necessary. This is not a missing IE call-path repair.
The legacy direct-artifact failure path can skip the shared financial writer,
so a newly qualified committee-receipt component must acquire, write and become
due independently of that path.

Native receipt codes `CPCM` and `PPTY` identify reported other political
committees and parties. They support an explicitly labelled committee/party
receipt measure without a registry match or a legal-PAC inference. `IsOrg`,
general/outside/nonprofit receipt classes and donor-name words do not establish
that role. Positive monetary receipts must exclude native in-kind payments;
refunds/reimbursements **to** the receiving committee are not outgoing returns.
The proposed measure is gross before separately reported returns, restricted
to current selected regular reports, and excludes separately filed 48-hour
notices. It is not all raised money or complete current-cycle coverage.

The first five ordinary due contexts were acquired through the actual
discovery and report-acquisition functions, without a positive-money selector.
The capture retained 101 complete official responses and stable opening/closing
inventories. All 17 current structured reports and 438 receipt occurrences pass
the new pure source validator: exact original JSON money, stable 300-row pages,
all 34 cover-summary controls and the native CSV's full 20-field receipt
occurrence multiset. Equal occurrences remain separate. Two receiving contexts
have unresolved current filing lineages and remain held; passing a report's
controls does not qualify the entire receiving context.

The redesigned cover's native export anchor uses the `ReportDetail` `Export`
handler. The former `ExportDetailResults` route returned HTTP 404. Native CSV
exports have multiple sections and four-decimal SQL-money strings; nonzero
subcents must be rejected. Receipt names correspond to `OrgName`, and `IsPrior`
is source text, including blank and `X`, rather than a Boolean. The source
validator does not require expenditure CSV/grid equality to establish gross
receipt occurrences. It makes no net-return or rapid-filing mirror claim.

The pure report validator and committee-receipt aggregator now have adversarial
tests. All 337 NC pipeline tests and backend type checking passed; separate
replays used the unchanged genuine source originals. The aggregator requires
every selected current report, preserves equal occurrences, excludes native
`In Kind` and aggregated rows, and holds unresolved monetary payment types,
prior markers, negative receipts and unsafe amounts. Only native `Cash`,
`Check`, `Credit Card` and `Electronic Funds Transfer` are currently accepted
monetary payment labels. An unrelated account-transfer CSV section and a
period-boundary discrepancy involving no committee receipts do not change the
receipt population or justify deduplication.

The independent source producer captures a complete receiving generation:
unchanged HTTP originals, ordinary report artifacts, current native CSVs and
closing inventory. Its reader checks full native inventory occurrences,
including fields omitted by the legacy projection; presentation reorder is
allowed, and duplicates remain separate. It replays all report/page/source
controls before atomically publishing a pointer. Failed refreshes preserve the
prior pointer and source dates. Bounded sequential transport, exclusive leases
and private retained artifacts keep interrupted or concurrent captures from
qualifying a partial source. This source-only step is not wired to publication.

Next steps require protected independent storage and due handling,
default-off publication, and actual ordinary local sync, API and frontend card
proof before the single NC pull request.

The [official 2026 reporting schedule](https://www.ncsbe.gov/campaign-finance/reporting-schedules/state-and-county-reporting-schedule)
sets the on-ballot third-quarter period through October 17, due October 27;
fourth-quarter reports are due January 12, 2027. The 48-hour period runs October
18–November 3. Plan fresh acquisition and ordinary sync on October 28 and 30,
November 3 and 6, and January 13, with attention to weeknight import lag and
late filings. These are planned reruns; no automation has been installed.
