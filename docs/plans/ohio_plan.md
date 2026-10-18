# Ohio campaign finance — implementation plan

## October 2026 committee-receipt correction

Fresh read-only priority: 221 canonical eligible candidates × .90 = 198.90, ahead of Montana's 180.00. Existing Ohio summaries are fresh, so the missing committee component needs an independent schedule. The existing batch already acquires cached annual expenditure files and Form 31-U details and calls the outside aggregator; 13 local outside groups confirm this is not Pennsylvania's missing-call bug. Preserve that path and its registered-committee coverage note. Separate unregistered-spender and electioneering filings remain outside the current source's stated coverage.

The three source questions are resolved as follows:

1. Ohio publishes registered-committee IE through annual candidate/PAC/party expenditure CSVs, per-report Form 31-U target/stance CSVs, and cover-page controls. A complete detail inventory and annual/cover reconciliation gate attribution. Missing or failed detail acquisition must preserve existing groups and dates.
2. The batch already calls both direct and outside aggregators. Its default one-day post-election lookback, however, cannot reach December post-general or January annual filings; extend the ordinary window to 98 days and retain late/amended follow-ups.
3. Candidate receipts carry `NON_INDIVIDUAL` and `PAC_REG_NO`. Organization text alone is insufficient. Active candidate/PAC lists and historical candidate/PAC/party covers identify committees; PAC covers retain historical registration numbers. [Form 31-A](https://www.ohiosos.gov/assets/e-form-31-a.pdf) also permits reported PCE/local-PAC labels in the registration field. Preserve valid reported committee groups without claiming a resolved legal registration when only a declaration supports them. Exact registry/name evidence comes first; malformed declarations, contradictory identities and unresolved ambiguous matches hold the receiving component rather than silently dropping known committee money.

Genuine source research retained complete 2025/2026 candidate receipts (413,334 and 839,140 occurrences), 751 active candidate rows, 1,620 active PAC rows and all three cover inventories. Native current exports preserve occurrence multiplicity: do not deduplicate identical rows or invent an amendment-family graph. Require each receiving report's complete cash and in-kind receipt sums to match its current native cover, complete report membership, unique report keys/periods, valid signed cents and no unsupported receipt roles. Research found four cash discrepancies, four receipt reports without covers, one repeated current-cycle period and malformed source declarations; these are holds, not zero. Corrected read-only first-25 research under the declared/registry scope qualified 18 receivers totaling $3,012,723.57; this is source research, not a financial sync or publication proof.

Implementation proceeds in small steps: preserve and replay original cached CSVs with strict manifests/hashes and actual acquisition clocks; build full signed committee groups only after per-report closure; add independently gated source/group/attempt persistence with canonical person/office/district/election and unique-active-link checks; then add an ordinary default-25 sync/CLI and production committee-interest overlay. Aggregate complete totals before named-detail limits, retain “Not yet sorted,” and label cash/in-kind receipts before separate expenditure-side returns. Unknown legacy fundraising/IE remains unknown, and component work must preserve existing legacy money and clocks. New committee gate defaults off under the Ohio master; original acquisition remains separately gated and attended when the portal blocks HTTP. No environment-file loading or financial/identity selectors in the new ordinary job.

The [official 2026 calendar](https://www.ohiosos.gov/assets/campaign-finance-deadline-calendar-2026.pdf) sets pre-general filing **October 22** through October 14, post-general **December 11** through December 4, and annual **January 29, 2027** through December 31. Statewide July–September monthly contributions are not repeated in later reports and must be retained once. The [official data portal](https://data.ohiosos.gov/portal/campaign-finance) allows five days for newly filed information to appear. Refresh acquisition and ordinary sync October 23/28, November 2/5, December 12/17, and January 30/February 4, 2027, then follow later amendments. These dates are an operational plan, not an automation.

Before an Ohio-only PR: source/correction/ambiguity/cache/closure tests, atomic canonical writer and independent scheduling/reader tests, backend typecheck, a genuine ordinary local sync with complete row/money/clock comparisons, fresh existing IE sync, actual production API and real candidate cards. Baseline: 211 Ohio tests across 15 files passed. Recheck main and the local migration ledger before allocating the next number; applied migrations remain immutable. Kansas donor names and all new Missouri publication remain held. No production activation, merge or deployment. Older environment-file and rollout instructions below are historical and do not authorize those actions for this correction.

Date: 2026-08-03, revised 2026-08-04 after a second-opinion review (valid items
folded in below; the reviewer's stale-checkout claims — "maryland loader is
bespoke", "migrations end at 208" — were verified false and rejected). Governs
the Ohio state-finance build. Read alongside `plan.md` ("Pause point — add new
states") and `docs/finance-module-capability-matrix.md` — their rules apply to
every PR here. Feasibility research: Ohio report dated 2026-08-02; do not
re-hit the portal during code-only PRs (portal work happens only in the
acquisition spike, when authorized).

## Verdict

Ohio is born on the shared factories with **zero migration debt** and **zero new
factory capability**. Canonical identity (`committee_id` = Ohio stable numeric
MASTER_KEY, `committee_name`), all 5 standard tables, standard summary columns,
std direct categories (`occupation` + `contribution_size`), donor/industry
outside breakdowns. Reference sibling: **maryland** (diff against it before
writing each file).

Scope decision (user, 2026-08-04): outside-group funders/industries (**#3** —
who funds the PACs, industry rollups + donor evidence) **stays in scope**,
built as the last feature PR. Ohio v1 UI parity target = Maryland/Texas.

## Shared-piece config (settled)

- **Writer** — `createStandardStateFinanceSnapshotWriter` wrapper, maryland
  pattern (`marylandFinanceWriter.ts`):
  - `label: "Ohio"`, `minElectionYear: 2000`
  - `summaryUpdatePolicy`: replace all summary fields, preserve-when-null the two
    outside totals (R+oC — direct and outside are built from different artifact
    sets; a direct-only refresh must not wipe outside totals)
  - `outsideGroupValidation: "pairing"` — **mandatory**, cascade-FK trap
    (matrix: breakdowns upsert before stale-group delete; `none`/`presence`
    silently cascade-deletes)
  - `supersededLinkSource: "sos_bulk_export"` (decided at PR 1; also the
    link-source CHECK value next to `'manual'` — ME `cfis_bulk` / MD
    `cfs_public_export` precedent, auto-link re-keys need supersession)
  - No `normalizeCommitteeId` (MASTER_KEY numeric; strict numeric validation +
    trim in wrapper mapping)
  - Pool-guard wrapper stub (maryland's `requireMarylandPool` pattern)
- **Due-list** — `createStandardStateFinanceDueListQuery`, canonical config, no
  `linkColumns`, no `mapRow`.
- **Loader** — `loadStandardStateFinanceSummariesByCandidateElection` wrapper
  (~40 lines, maryland shape — maryland IS a shared-loader wrapper since Phase 3
  cohort 0): defaults + `isEligibleElection` + `evidenceLabelTypes: ["donor"]`
  (donor evidence feeds the outside-industry explanations — #3 is in scope, so
  this stays). Characterization test via
  `tests/helpers/stateFinanceLoaderCharacterization.ts` written **up front**
  (born-shared state: the pin tests the wrapper directly).
- **Auto-link** — copy maryland (`marylandCandidateCommitteeAutoLinker.ts`).

## Schema (allocate migration number at PR time — 210 as of 2026-08-03)

`db/migrations/<next>_add_ohio_campaign_finance_tables.sql` — clone migration
127 (maryland), `oh_` prefix. Identifiers ≤63 chars: longest is
`oh_candidate_finance_direct_breakdowns_source_url_check` (55); the
outside-group-breakdowns table uses the short constraint prefix `oh_cff_`
(maryland's `md_cff_` trick). Link-source CHECK lists `'manual'` + the Ohio bulk
source. Amounts CHECK `>= 0` (canonical).

## Settled design decisions

1. **Negative cash-on-hand**: canonical schema rejects negatives; signed cash is
   a Phase-5 capability (IL/KY/LA) and Ohio does not adopt it. If a cover page
   reports a negative balance: write NULL + count in sync diagnostics. Never
   clamp to 0. **Spike: this is a real, small case** — `BALANCE_ON_HAND` is
   negative on 417 of 36,085 cover rows (1.16%), and 7 of 763 for 2026 (0.92%).
2. **Eligible offices v1** (DB-grounded at PR 1 against Ohio 2026 election
   rows): `statewide::Governor`, `statewide::Attorney General`,
   `statewide::Secretary of State`, `statewide::State Auditor`,
   `statewide::State Treasurer`, `state_upper::State Senator`,
   `state_lower::State Lower Chamber Legislator`. **No Lieutenant Governor**
   — Ohio elects it on a joint ticket, no separate election rows exist. **No
   judicial offices** — no existing state's eligible list has any
   (grep-verified 2026-08-03); Ohio judicial rows use canonical name "State
   Level Judge"; Supreme Court / Court of Appeals / Board of Education
   deferred. County/municipal excluded (report: e-filing not uniformly
   required locally).
3. **Support/oppose fail-closed**: only rows with explicit SUPPORT/OPPOSE become
   outside-spending rows (schema CHECK enforces anyway). Blank-direction rows →
   excluded-amount + row-count diagnostics. Never infer direction. No dedup of
   identical-looking expenditures (legitimately repeat). **Spike: the rule
   bites and the diagnostics matter** — 8 of 43 2026 detail rows carry a blank
   direction, excluding $398,950 of $9,800,170.34 (4.1%); the remaining 35 rows
   ($9,401,220.34) split 21 SUPPORT / 14 OPPOSE. The no-dedup rule is also load
   bearing: V-PAC filed three byte-identical $150,000 rows for the same payee
   and candidate, two of them on the same date.
4. **Form 31-U is two-stage** (review finding, confirm in spike): the annual
   candidate/PAC/party expenditure bulk files carry 31-U rows with spender
   MASTER_KEY, REPORT_KEY, vendor, date, amount, purpose — but reportedly NOT
   target candidate/office/direction. Those live in each report's separate
   Form 31-U detail export (`independent_expenditure.csv`). Pipeline:
   annual files → collect unique REPORT_KEYs → fetch each report's detail CSV
   → validate detail total against annual bulk + cover page (three-way
   reconciliation) → aggregate only explicit SUPPORT/OPPOSE rows.
   **Annual rows are discovery/reconciliation data only — never sum annual and
   detail amounts.** Observed volume (2026 PAC file): 43 rows, 13 report keys,
   $9.8M — detail fetch count is small.

   **CONFIRMED at the spike, exactly as described.** `PAC_EXP_2026.CSV` carries
   `COM_NAME, MASTER_KEY, RPT_YEAR, REPORT_KEY, REPORT_DESCRIPTION,
   SHORT_DESCRIPTION, …payee…, EXPEND_DATE, AMOUNT, EVENT_DATE, PURPOSE` and
   **no office, candidate, or direction**; the detail export carries all three.
   Volume matched the report precisely: 43 rows of `31-U  Ind Exp by committee`
   across 13 distinct report keys, $9,800,170.34. **Reconciliation is exact** —
   detail total equals annual total per report key, 0 mismatches across all 13.
   Two mechanics the plan lacked:
   - The **detail export has no `MASTER_KEY`** — it identifies the spender only
     by `Committee Name`. The spender identity must be carried in from the
     annual file's `(MASTER_KEY, REPORT_KEY)` pair, never re-derived by name.
   - The detail lives at
     `f?p=CFDISCLOSURE:48:::::P48_LISTTYPE,P48_REPORT_ID,P48_TYPE:simple,<REPORT_KEY>,31U`.
     Its CSV-export link is a session-bound APEX widget URL with a checksum, so
     it is **not** a stable fetch target; **scrape the page's HTML table
     instead** — verified to reproduce the exported CSV column-for-column
     (16 columns, identical rows).
5. **Candidate matching (31-U detail)** — **REVISED at the spike**: the
   original "name + compatible office + cycle" rule is unusable as written,
   because `Office` is blank on the largest rows — the two 2026 gubernatorial
   targets (AMY ACTON $8.21M, VIVEK RAMASWAMY $600K) carry no office at all,
   i.e. requiring office would quarantine $8.81M of the $9.40M directional
   total. Revised rule: **normalized name (upper-cased — the same person
   appears as both `JASON STEPHENS` and `Jason Stephens`) + cycle + state,
   uniquely matching exactly one Ohio candidate**; office is used as a
   *confirming* filter only when present, never as a requirement. The column
   is `Candidate Name /Ballot Issue` and really does mix kinds — ballot-issue
   and non-state rows appear (`Jefferson Jackson Good Government`,
   `Weisburg for Sheriff`) — so reject values that fail to resolve to a single
   candidate rather than guessing. Still **no fuzzy matching**; ambiguous or
   unmatched rows quarantine with diagnostics.
6. **Occupation — fail closed** (review finding: Ohio's single combined
   `Employer/Occupation or Labor Organization` field has no prescribed
   delimiter; sampled 2024 data ~65% row coverage and contains employers, LLC
   names, even dates): emit an `occupation` breakdown row **only** when the
   whole value or exactly one component matches a versioned high-confidence
   occupation taxonomy. Ambiguous values are OMITTED from the occupation
   category — never shown as occupations; the exact reported string lives only
   in raw artifacts/diagnostics. Sync reports matched rows, matched dollars,
   omitted rows, representative omissions. **Manual precision audit gates
   enabling the feature; if precision is poor, launch Ohio without occupations
   rather than mislabel employers.** Contribution-size buckets are unaffected.

   **RESOLVED at the spike — Ohio launches WITHOUT occupations.** Audit of the
   real 2026 candidate-contributions file (414,474 rows): 220,369 rows (53.2%;
   59.8% of dollars) have any `EMP_OCCUPATION` value, but **80.1% of those are
   not occupations at all** — `RETIRED RETIRED` alone is 162,243 rows, plus
   `NOT EMPLOYED`, `HOMEMAKER`, `UNEMPLOYED`, `UNKNOWN`, bare `/`. Only 43,779
   rows — **10.6% of all contributions** — carry anything occupation-like, and
   those spread over ~21,900 uncontrolled distinct values that concatenate
   occupation and employer with no delimiter (`PHYSICIAN SELF`, `VP TRIRX
   MEDICAL`, `TECHNICIAN FRESCO`, `BUCKINGHAM DOOLITTLE  BURROUGHS/ATTORNEY`,
   `KISHMAN IGA MARKETS`). A high-confidence taxonomy would match a small
   fraction of an already-small 10.6%, so `top_occupations` stays empty for
   Ohio and no occupation breakdown rows are written. Revisit only if Ohio
   splits the field. Contribution-size buckets are unaffected and remain the
   direct-money breakdown Ohio ships.
7. **Amendments**: whole-artifact refresh; rebuild each candidate snapshot from
   newest artifact set; replace, never append. Reconcile 31-U totals vs
   cover-page IE totals; quarantine mismatches beyond rounding tolerance.
8. **Flags** (free read flag ON in `backend/.env` per policy; others off):
   - `OHIO_CAMPAIGN_FINANCE_ENABLED`
   - `OHIO_CAMPAIGN_FINANCE_SYNC_ENABLED`
   - `OHIO_SOS_RAW_DATA_REFRESH_ENABLED` (house raw-refresh naming)
9. **Artifact retrieval**: portal blocks unattended HTTP (Cloudflare 403) — a
   real browser session is required; **Florida is NOT a browser precedent**
   (its client is plain fetch), though its artifact-cache/manifest code shape
   (`floridaCampaignFinanceArtifactCache.ts`) remains the template. Acquisition
   mechanism (automated browser job vs Claude-assisted manual download into the
   cache dir) is decided in the acquisition spike. Retrieval stays separate
   from parsing: download → validate → SHA-256 → atomically replace snapshot;
   finance sync reads cache only. Product download IDs must be discovered from
   file labels/years on the file-transfer page — never hardcode `P72_GETID`.

   **Confirmed at the spike.** Plain HTTP is 403 even with a descriptive
   user-agent (Cloudflare serves a 1.2 MB "Website Maintenance" interstitial),
   so a real browser session is mandatory — no header tweak substitutes for
   it. Page map: **`CFDISCLOSURE:73` lists** files (`P73_TYPE` =
   `NEW`|`CAN`|`PAC`|`PARTY`) and **`CFDISCLOSURE:72` serves** them
   (`P72_GETID:<id>`); session-less URLs work, APEX mints its own session. IDs
   are confirmed non-sequential (`120`, `123`, `6768`, `6130`, `3`, `3431`,
   `6770`, `122`, `6772`), so label discovery is mandatory, as planned. **The
   portal rate-limits: rapid requests return HTTP 429**, so acquisition must be
   strictly sequential with a delay between files (~8 s worked; a 17-file,
   305 MB cycle pulled clean). Front door moved to `data.ohiosos.gov/portal/
   campaign-finance`, but it only links into the same APEX app — no API.
10. **Parser hardening** (review findings from live samples; build in from the
    first parser PR): Windows-1252 (not valid UTF-8), CR-only row separators,
    duplicate headers (active-candidate file has `OFFICE` twice — second is
    actually party), HTML entities (`&AMP;`), header whitespace/spelling
    drift, currency-formatted detail amounts (`"$31,550.42"`). Annual
    contribution files ≈90 MB → stream parsing + streaming SHA-256, never
    whole-file in memory. **Spike-confirmed on real bytes**: row separators are
    CR-only (no LF anywhere), `ACT_CAN_LIST.CSV` really does repeat `OFFICE` at
    positions 19 and 21 with the second holding party (`…,HOUSE,87,REPUBLICAN`),
    detail amounts are quoted currency (`"$150,000.00"`), and the 2026/2025
    candidate contribution files are 93 MB / 97 MB. Fixtures capturing each
    quirk live in `backend/tests/fixtures/ohioFinance/`.

    **PR 4 ran the pinned schemas against all 17 real files (305 MB): every
    file parsed with 0 malformed rows.** Three further quirks surfaced and are
    handled in `ohioSosCsv.ts` / `ohioSosBulkFiles.ts`:
    - **Filer year typos are common enough to poison a naive date range** —
      `0202`, `0206`, `2926`, `3026`, `3036`, `5025` all appear. ~194 rows
      across the cycle. Manifest date ranges therefore ignore dates outside a
      plausible window (1990-01-01 .. next year) and report
      `implausibleDateRowCount` instead of widening the range.
    - **Blank `AMOUNT` is real** — 11 rows across the cycle (blank in-kind
      amounts, a literal `TEST` row). Parsed as `null` and counted in
      `missingAmountRowCount`; never read as zero.
    - **The scraped 31-U page renders an empty cell as a bare `-`**, where the
      CSV export leaves it blank. Only an exact `-` is treated as a
      placeholder, so the scrape and the export produce identical rows
      (pinned by a test).
11. **Artifact manifest fields**: product label + expected year, original
    filename, file-transfer page URL, retrieval time + portal "date modified",
    SHA-256, byte size + row count, detected encoding + row separator,
    header/schema version, min/max transaction dates, report keys found,
    validation + quarantine counts.
12. **Source label**: `"OHIO_SOS"` (agency convention: `ARIZONA_SOS`,
    `FLORIDA_DOS`, `PENNSYLVANIA_DOS`) — new member in
    `ballotLookupFinanceShared.ts` source union + `FINANCE_SUMMARY_SOURCES`
    array, registry entry in `ballotLookup.ts` state table.
13. **PDF Miscellaneous-Filings path** (nonregistered spenders: AFP etc.):
    separate `ohioSpecialFilingParser`, accept only fully-parsed rows (spender,
    candidate, direction, amount, year, filing id + URL), quarantine the rest.
    Not a v1 blocker; last PR. Electioneering mentions without explicit
    support/oppose stay out. Until it ships, source metadata must say
    registered-committee outside spending only.

    **Disclosure SHIPPED 2026-08-06** (the live run made it load-bearing —
    $9.03M of outside spending is now published). New optional summary field
    `outside_spending.outside_coverage_note`, set only by loaders whose
    source has a known systematic gap (same "only sources that disclose it
    set this" seam as `membership_*_total`); the Ohio loader supplies it, the
    web and mobile finance cards render it directly under the outside-spending
    explanation — with the totals, not in the source footnote, since a reader
    who sees a dollar figure assumes it is all the outside money in the race.
    Absent (not null) for every other state, so their payloads are unchanged.
    **Delete the note and its loader option when the PDF path ships.**

## Acquisition spike results (run 2026-08-04, user-authorized)

Full cycle-2026 artifact set pulled: **17 files, 305 MB**, cached under
`scratch/ohio-campaign-finance/sos/` (gitignored territory — never committed).
Portal files had all been regenerated that morning (08/04/2026 10:30–10:45).
SHA-256 recorded for every file at download time.

`P72_GETID` map as observed — **re-discover by label each run, never hardcode**:

| File | id | bytes |
|---|---|---|
| ACT_CAN_LIST.CSV | 120 | 124,597 |
| CAN_COVER.CSV | 123 | 4,800,596 |
| CAC_CON_2026.CSV | 6768 | 93,067,396 |
| CAC_EXP_2026.CSV | 6769 | 4,239,894 |
| CAC_CON_2025.CSV | 6130 | 96,890,718 |
| CAC_EXP_2025.CSV | 6131 | 5,501,878 |
| ACT_PAC_LIST.CSV | 3 | 268,372 |
| PAC_COV.CSV | 3431 | 8,511,267 |
| PAC_CON_2026.CSV | 6770 | 35,959,087 |
| PAC_EXP_2026.CSV | 6771 | 1,287,947 |
| PAC_CON_2025.CSV | 6132 | 58,967,666 |
| PAC_EXP_2025.CSV | 6133 | 2,817,296 |
| PAR_COVER.CSV | 122 | 854,396 |
| PPC_CON_2026.CSV | 6772 | 2,025,924 |
| PPC_EXP_2026.CSV | 6773 | 534,629 |
| PPC_CON_2025.CSV | 6134 | 2,743,418 |
| PPC_EXP_2025.CSV | 6135 | 1,035,095 |

Verdict: **Ohio is feasible and the plan survives the spike.** Decision 4 is
confirmed with exact reconciliation; decisions 1, 3, 10 are confirmed with real
numbers; decision 9 gains the page map and a rate-limit rule; decision 5 is
revised (office is unusable as a match requirement) and decision 6 is resolved
against shipping occupations. Nothing found requires new factory capability or
schema change — migration 210 stands.

**Acquisition mechanism — RESOLVED at PR 4.** Scripted HTTP is permanently out
(Cloudflare) and headless / fresh-profile automated Chrome were both refused in
probes, so the shipped mechanism is an attended step: the user starts their own
Chrome with `--remote-debugging-port=9222` (Chrome 136+ ignores that flag on
the default profile directory — if `/json/version` is unreachable, relaunch
with a dedicated long-lived `--user-data-dir`; a fresh directory may need one
attended Cloudflare click-through, after which it keeps the trust), and
`npm run ohio-candidates:finance:raw:refresh` attaches over the DevTools
protocol (no new dependency — Node's built-in WebSocket). No unattended server
job, no fingerprint spoofing, no challenge solving; if Cloudflare interstitials,
the script stops and says so. Cover-page fields
(`TOTAL_CONTRIBUTIONS`, `TOTAL_EXPENDITURES`, `BALANCE_ON_HAND`,
`VALUE_IND_EXPENDITURES`) map cleanly onto the canonical summary columns, and
`CAC_CON_*` carries `CANDIDATE_FIRST_NAME/LAST_NAME/OFFICE/DISTRICT/PARTY`,
which gives the committee resolver (PR 5) a direct MASTER_KEY → candidate path.

## Required artifacts per cycle Y

- Active candidate list + candidate cover pages
- Candidate contributions Y−1, Y; candidate expenditures Y−1, Y
- Active PAC list + PAC cover pages; PAC expenditures Y−1, Y
- Party cover pages; party expenditures Y−1, Y
- One Form 31-U detail CSV per discovered REPORT_KEY
- For #3 (funders/industries, last feature PR): PAC contributions Y−1, Y
  (+ party contributions if needed)
- Later: Miscellaneous Filings index + candidate-related 30-B-2/30-E PDFs

## Module layout

`backend/src/pipeline/ohioFinance/`: artifact cache, rows/parsers, committee
resolver, direct-contribution aggregator, outside-spending aggregator (31-U
two-stage), outside-group contribution aggregator (tennessee
`tennesseeOutsideGroupContributionAggregator.ts` pattern — #3, last),
special-filing parser (late), writer wrapper, ballot-lookup loader wrapper,
eligible offices, auto-link, sync, batchSync, `index.ts`.

## PR sequence (one PR at a time; `npm run typecheck` + `npm test` green in `backend/`; cite matrix row)

Code-only PRs 1–2 are data-independent and proceed under the no-portal rule.
The acquisition spike is the gate before parser/aggregator work — it is the
main feasibility risk and also settles the 31-U two-stage question.

1. Migration (next free number) + writer wrapper + writer test + eligible
   offices (+ test) + feature flags.
2. Loader wrapper + characterization pin + flag-gate test + `ballotLookup.ts`
   registry + `OHIO_SOS` source union entry.
3. **Acquisition spike** (needs user authorization for portal access; no
   migration, no DB writes): prove browser retrieval works, discover + download
   annual artifacts, fetch all 31-U detail CSVs, confirm/refute decision 4,
   produce reconciliation + occupation-quality reports, capture real fixture
   samples for the parser PR.
4. Artifact cache + row parsers (encoding/row-separator/header-drift/currency
   handling per decision 10; manifests per decision 11; fixtures from spike)
   **+ acquisition script** (user decision 2026-08-04): a committed script that
   drives the user's real Chrome session — the only transport that passes the
   Cloudflare gate (headless AND fresh-profile automated Chrome both got 403 in
   probes; only the real profile passed). Script does label→ID discovery on
   `CFDISCLOSURE:73`, sequential paced downloads from `:72`, page-48 31-U
   detail scrapes, SHA-256 + manifest into the cache dir. User starts it;
   no unattended server job (would require bot-detection evasion — out).
5. Committee resolver (+ test) + auto-link copied from maryland (+ test).
6. Aggregators: direct contributions (occupation fail-closed per decision 6) +
   31-U two-stage outside spending with three-way reconciliation (+ tests).
7. Sync + batchSync (due-list builder config) + npm scripts
   (`ohio-candidates:finance:*`, maryland block as template).
8. **#3**: outside-group contribution aggregator (TN pattern) + PAC
   contribution artifacts + committee-label / industry-label queue entries.
9. Later, separately gated: PDF special-filings path; first live run with
   money reconciliation + match-rate report.

## Status

- [x] PR 1 schema + writer (migration 210, `oh_` tables, writer wrapper with
      numeric MASTER_KEY validation, eligible offices, 3 flags; branch
      `claude/ohio-financial-module-55919c`)
- [x] PR 2 loader + wiring (`ohioBallotLookupFinanceLoader.ts` shared-loader
      wrapper, characterization pin with Lieutenant-Governor ineligibility,
      `OHIO_SOS` source union + `FINANCE_SUMMARY_SOURCES`, `ballotLookup.ts`
      registry entry; branch `claude/ohio-finance-loader-pr2`)
- [x] PR 3 acquisition spike — RUN 2026-08-04 (see "Acquisition spike results").
      17 files / 305 MB cached, decision 4 confirmed with exact reconciliation,
      decision 5 revised, decision 6 resolved (no occupations), fixtures written
      to `backend/tests/fixtures/ohioFinance/`. No code shipped — the fixtures
      and these plan updates ride along in PR 4.
- [x] PR 4 artifact cache + parsers + acquisition script (branch
      `claude/ohio-finance-parsers-pr4`): `ohioSosCsv.ts` (Windows-1252,
      CR-only rows, header-drift-tolerant pinned schemas, currency/date/entity
      handling), `ohioSosBulkFiles.ts` (11 pinned families + streaming reader
      with manifest stats), `ohioSos31uDetail.ts` (CSV + scraped-table parser,
      fail-closed direction, three-way reconciliation), `ohioSosArtifactCache.ts`
      (SHA-256 + manifests per decision 11, atomic install, cycle status),
      `ohioSosChromeClient.ts` + `ohioSosArtifactAcquisition.ts` +
      `refreshOhioSosCampaignFinanceRawData.ts` (label→ID discovery, paced
      sequential downloads, 31-U detail scrapes). Validated against all 17 real
      files: 0 malformed rows, and the 31-U reconciliation reproduces the spike
      exactly — 13 report keys, 43 rows, $9,800,170.34, 0 mismatches,
      $9,401,220.34 directional, 8 blank-direction rows excluding $398,950.
- [x] PR 5 resolver + auto-link (branch `claude/ohio-finance-resolver-pr5`):
      `ohioCandidateCommitteeResolver.ts` (maryland shape over the
      active-candidate list; fail-closed normalized-name + exact OFFICE-token
      match with the vocabulary pinned from the real 2026-08-04 file —
      GOVERNOR / ATTORNEY GENERAL / SECRETARY OF STATE / AUDITOR / TREASURER /
      SENATE / HOUSE; numeric MASTER_KEY required) +
      `ohioCandidateCommitteeAutoLinker.ts` (due query, exact-match-only link
      writes via `upsertOhioFinanceLink`, linkSource `sos_bulk_export`).
      Deviation from maryland worth keeping: Ohio's list carries a verifiable
      numeric DISTRICT, so General Assembly links are allowed behind an exact
      district match (maryland refuses legislative links outright); statewide
      rows ignore the list's junk district values (0/100). The list has no
      year column (current registrations only), so election year is validated
      for storage, not used as a row filter. Real-data smoke: Acton → 16171,
      Ramaswamy → 16178, Stephens (House 93) → 15242, each exactly one match.
- [x] PR 6 aggregators (branch `claude/ohio-finance-aggregators-pr6`):
      `ohioDirectContributionAggregator.ts` (streaming accumulator per
      decision 10 — the caller streams CAC_CON files once and feeds all open
      accumulators; size buckets only per decision 6, fail-closed
      SHORT_DESCRIPTION vocabulary: 31-A / 31-E / 31-J-1 are donor support,
      31-A-2 receipts-only, anything new counted not bucketed) +
      `ohioOutsideSpendingAggregator.ts` (two-stage 31-U per decision 4:
      spender pinned from the annual (MASTER_KEY, REPORT_KEY) pair; per-report
      reconciliation gate annual-vs-detail plus the cover-page IE leg;
      decision-5 target matching with office as a confirming filter that also
      rejects a contradicting stated office). Findings baked in from the real
      2026-cycle files: cover reports chain exactly (AMT_FORWARD = previous
      BALANCE_ON_HAND, no duplicates, no AMENDED rows), so summary receipts /
      disbursements come from cover sums and cash from the latest report —
      cover satisfies receipts − disbursements + forward = cash to the cent,
      while itemized-only receipts would miss Ramaswamy's $25.4M non-itemized
      federal transfer (itemized sum kept as a diagnostic); 31-U spans all six
      expenditure files (candidate and party committees file it too — 28
      cycle report keys, not 13); 14 of 28 report keys have no cover row
      (federal-calendar reports), so a missing cover row never quarantines,
      only a present-and-mismatched one does. Real-data smoke reproduced the
      spike exactly: 13/13 bundle reports reconciled, Acton oppose
      $8,211,114.50, Ramaswamy support $600,000, Stephens oppose $217,704.16,
      JON HUSTED (federal) correctly quarantined unmatched.
- [x] PR 7 sync + batchSync + scripts (branch `claude/ohio-finance-sync-pr7`):
      `ohioCandidateFinanceSync.ts` — write step only. Unlike maryland it
      takes aggregation RESULTS, not raw rows: the batch layer owns the
      single stream over the ~90 MB CAC_CON files (decision 10). Committee
      identity is the due row's active link (no resolver call — the due list
      only returns linked candidates). outsideFinance null → summary outside
      totals NULL (writer preserveWhenNull keeps stored values) and outside
      groups untouched; an empty groups list clears stale rows.
      `ohioCandidateFinanceBatchSync.ts` — due list via the shared factory
      over the oh_ tables; auto-link phase reuses the PR 5 walker with the
      cached ACT_CAN_LIST; per election year one accumulator per distinct
      linked committee is fed by one CAC_CON_{Y-1,Y} pass, cover files load
      once per run, and outside spending aggregates once per year over
      (candidate name, office)-DEDUPED targets — without the dedupe a
      candidate due for both primary and general would appear twice and
      quarantine every row aimed at them as ambiguous. Missing direct
      artifacts fail the year's rows (receipts would be fabricated);
      missing outside artifacts only disable the outside leg, with a
      per-year availability summary in the batch result.
      `readOhioSos31uDetailBundle` accepts the version-1 payload AND the
      2026-08-04 spike checkpoint format, so the existing 305 MB cache
      works without another attended Chrome session. Scheduler (BullMQ,
      queue `ohio_candidate_finance_sync_maintenance`, daily cron default
      `55 9 * * *` UTC) + 4 scripts + npm block
      (`ohio-candidates:finance:sync-due` / `scheduler:upsert` /
      `scheduler:worker` / `scheduler:trigger`).
      Real-data smoke (end-to-end dry run over the cached cycle): Acton
      receipts $15,898,732.10 / cash $8,136,281.98 / oppose $8,211,114.50;
      Ramaswamy receipts $55,081,342.57 (cover beats the $30.3M itemized
      sum) / support $600,000; Stephens receipts $343,371.62 / oppose
      $217,704.16 — 13 reports reconciled, 0 quarantined, and the
      attributed-cents delta vs the PR 6 smoke is exactly the Perez+Haines
      $102,348.10 that this due list does not cover.
      Review round (Codex + CodeRabbit): (1) a bundle missing annual report
      keys now fails the year closed to outside-unavailable — the real
      cache's spike bundle misses 15 keys carrying ~$5.9M of annual 31-U
      money (incl. V-PAC $4.0M + $0.9M), so publishing zeros from it would
      have been false; totals return after `raw:refresh`. (2) Outside
      target dedupe keys on candidateId, not display name — two different
      same-name people stay separate targets and quarantine as ambiguous
      instead of both being paid. (3) The version-1 bundle reader validates
      every consumed field (a direction outside support/oppose/null would
      have landed in the aggregator's oppose branch). (4) #542 leftover
      closed: on a FILLED cover row a blank VALUE_IND_EXPENDITURES now
      feeds the gate as 0 (fully-blank rows stay ignored); probe of all 28
      cycle keys found 13 exact IE matches, 15 no-cover, 0 blank-on-filled,
      so the change is pure added protection. Declined: streaming-JSON for
      the bundle (it is 9.8 KB — 305 MB is the whole cache), shared CLI
      flag parser and dropping `force` from the recurring scheduler payload
      (both verbatim the maryland/all-states template; repo-wide questions,
      not Ohio's).
      Review round 2 (Codex, all four fixed): (1) every cached stream now
      passes a manifest gate — size-vs-manifest mismatch fails the year
      ("stale" = the only detectable corruption; a manifest-less file
      streams with a warning since there is nothing to verify against, and
      the extant spike cache has no manifests); (2) the outside ambiguity
      guard matches against the year's FULL active-link universe (new
      query), not the stale-filtered 25-row due page, so a same-name
      double is seen even when not due — unlinked doubles remain the
      residual blind spot; (3) link_source rides in the due row
      (alaska/tennessee/virginia linkColumns pattern) and is written back
      as-is, so manual links keep provenance and auto-supersession
      immunity; (4) trigger/upsert scripts validate known flags and reject
      duplicates like sync-due (a --dryrun typo now fails instead of
      enqueueing a real write).
- [x] PR 8 outside-group funders/industries (#3) (branch
      `claude/ohio-finance-pr8`): `ohioOutsideGroupContributionAggregator.ts`
      — maryland pattern (donor + industry only, the standard writer's
      outside category set), adapted to Ohio: matching is by the spender's
      numeric MASTER_KEY (never name), the cycle window is RPT_YEAR ∈
      {Y−1, Y}, and organization donors come from the explicit
      NON_INDIVIDUAL column — no name heuristics, individuals never become
      labels. Donor vocabulary pinned from the real files (31-A / 31-E /
      31-J-1; 31-A-2 and the party-only 31-CC are known-excluded; anything
      else fails closed into an unknown counter — the real 2026 PAC/party
      files have ZERO unknowns). Real-data finding: union PACs put
      transaction descriptions in NON_INDIVIDUAL ("CONTRIBUTION FROM DUES
      MONEY" $76K, "TRANSFER OF MEMBERSHIP DUES" $855K), so a value is
      rejected (counted, nonEntityLabelRowCount) only when it BOTH starts
      like a generic description AND carries dues/transfer context —
      entity-bearing values ("OHIO AFL-CIO/DUES MONEY", "UAW REGION 2B
      MEMBERSHIP DUES") keep their verbatim label.
      Batch: after the year's outside aggregation succeeds, ONE filtered
      pass over PAC_CON_{Y-1,Y} + PPC_CON_{Y-1,Y} keeps only rows whose
      MASTER_KEY is a 31-U spender, then a per-candidate slice feeds the
      sync. Candidate-committee 31-U spenders are NOT covered (receipts
      live in the ~90 MB CAC_CON files; no bundle-covered spender is one
      on the real 2026 files) — their groups simply carry no funder rows.
      A funder artifact failure only disables this leg (funders null →
      writer keeps stored breakdown rows; year summary carries
      fundersAvailable/fundersError); the outside totals still sync.
      Sync: maryland's industry enrichment verbatim — the aggregator's
      static industry rows are discarded and rebuilt from merged
      classification state (rules + cached DB rows + manual verdicts), so
      manual industry labels always win and every unresolved donor
      persists a classification_source='unknown' row. No AI classifier is
      constructed by default (rule/cached-only).
      Queue entries needed NO new code: the committee-label due list reads
      outside groups through the merged read path (live since PR 7) and
      the industry-label due list reads the 'unknown' classification rows
      this PR persists; OHIO_SOS was already in FINANCE_SUMMARY_SOURCES.
      Real-data smoke: probe showed all 13 bundle-covered spenders are
      PACs; funder aggregation over the cached cycle: 1,290 filtered rows
      → 6 org-donor rows (RYAN B WALKER CPA INC $300 for NFIB; Libertarian
      Party state fund $19,000 + Butler County LP $394.50), 1,218
      individuals skipped, 4 non-entity dues labels rejected, 62
      excluded-form rows, 0 unknown forms. Big super PACs (V-PAC $8.66M)
      have NO PAC_CON rows at all — funder coverage is structurally
      partial, and empty is correct (never fabricate). Full non-dry batch
      run on the local DB (migration 210 applied): 25/25 synced with PR 7's
      exact direct totals (Acton $15,898,732.10 / cash $8,136,281.98), the
      stale bundle correctly disabling outside AND funders (stored rows
      preserved).
      Review round (Codex, both fixed): (1) the aggregator no longer caps
      donor rows — the sync layer classifies EVERY donor, rebuilds industry
      totals from all of them, and only then caps the persisted donor
      display rows (`outsideMaxDonorBreakdownsPerGroup`, default 50) — the
      old order rebuilt a >50-donor group's industries from just the top 50
      (maryland/tennessee carry the same inherited flaw; out of this PR's
      scope). (2) The aggregator's key helpers carried five literal NUL
      bytes (the recurring Write-tool trap), making the file binary to Git
      and its diff invisible — replaced with textual `\u0000` escapes; the
      `grep -P` pre-commit check that was supposed to catch this is silent
      on BSD grep, so the check is now `python3` byte-count.
- [x] **First live run (2026-08-06)** — attended refresh + full sync on the
      local DB. **Found and fixed a blocking acquisition bug**: the
      file-transfer page lists PRODUCT LABELS ("Candidate
      Contributions--2026"), never file names, but discovery searched each
      row for a `*.CSV` name — so all 303 listed rows matched nothing and
      every one of the 17 artifacts reported missing. The label-discovery
      path had never actually completed against the portal (the spike
      downloaded by a different route). Fixed with an exact,
      list-type-scoped label table (`ohioSosProductFromListingRow`); the
      file name is derived from the matched product, so plan/download/
      manifest code is unchanged. **The exactness is load-bearing**: the
      NEW tab lists per-committee files whose labels differ from the
      statewide annual only by a committee name between single dashes
      (`Candidate Contributions-DAVE YOST FOR OHIO-2026` vs
      `Candidate Contributions--2026`), so a prefix/substring match would
      install ONE committee's file as the whole state's. Tests pin all 11
      label forms verbatim plus that trap.
      Refresh: 17/17 files, 0 failures, manifests written for the first
      time (the spike cache had none). `CAC_CON_2026.CSV` came down 133 MB
      /593,131 rows vs the portal's listed 91,023 KB — verified legitimate
      (all rows RPT_YEAR=2026, 341 distinct committees, row count scaling
      with bytes), i.e. a post-deadline batch, not a bad download; the
      portal's size column is stale.
      31-U bundle un-staled: **28/28 reports fetched** (was 13, 15
      missing), 118 rows, **2 unreconciled** (481068415 detail −$86,455.17,
      506135809 detail −$418.40) which quarantine per decision 4 rather
      than publish; 40 blank-direction rows excluded ($5,354,928.83) per
      decision 3.
      Sync: **189/189 candidates synced, 0 failed**, receipts
      $104,396,358.50, **outside spending published for the first time —
      $9,034,464.14** across 9 group rows (V-PAC oppose $8,211,114.50 +
      support $600,000, Ohioans for a Healthy Economy oppose $217,704.16),
      859 direct breakdowns, 0 ambiguous targets, 24 unmatched targets
      (mostly federal/ballot-issue names, decision 5 quarantine).
      **Funder leg correctly published almost nothing**: of 254 funder rows
      for the 7 spender committees only 20 carry an organization name and
      ALL 20 are `31-A-2 Other Income` (candidate committees transferring
      to a PAC), which the pinned vocabulary excludes — so 2 donor rows
      total (RYAN B WALKER CPA INC → NFIB). Empty here is the honest
      answer, not a gap.
      Operational lesson: rows synced while the bundle was stale kept NULL
      outside totals and were not due again for a day (`staleAfterDays`
      minimum is 1) — 25 rows needed `last_synced_at` aged to refresh. A
      refresh that changes artifact availability should be followed by a
      forced re-sync of anything synced during the outage.
- [x] Read flag + outside-coverage disclosure (2026-08-06): two gaps the
      live run exposed. (1) `OHIO_CAMPAIGN_FINANCE_ENABLED` was absent from
      every checkout's `backend/.env` (and from Render), so all 189 synced
      summaries rendered nothing — the registry wiring was fine, the flag
      was the only gate. Added to this worktree's `backend/.env` per the
      free-read-flag policy; **still needs adding to the main checkout's
      `backend/.env` and to Render before prod shows Ohio.** (2) Decision
      13's disclosure requirement shipped — see that decision for the design.
- [ ] PR 9+ PDF path (Miscellaneous Filings, nonregistered spenders) —
      when it lands, remove the Ohio coverage note (decision 13).

Update the checklist + any changed decision here as PRs land; also update the
finance-consolidation memory at campaign end.
