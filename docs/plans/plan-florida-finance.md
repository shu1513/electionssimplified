# Florida finance gaps

Updated October 11, 2026. Separate Florida work starts from main after the
October 2026 all-source finance-gap analysis and ranking. The local cohort has 437
active finance links for 338 candidates. Oregon PR #1569 remains separate.

## Source and wiring findings

Florida publishes independent expenditures through EFS. The public expenditure
export contains genuine IEC expenses, including $1,691,804.30 of 2025–26
Americans for Prosperity Action expenses. Those expenses' generic purposes do
not identify a beneficiary, support/opposition, or candidate-specific allocation.
Other payers' **full TSV Purpose** can explicitly name a single candidate,
stance, and office/seat; the screen view truncates that field to 40 characters.
The native account export adds reporting periods, not structured target fields.
Section 106.071 requires candidate particulars for applicable independent
expenditure reports; investigate the actual current public report/detail path
before treating its generic expenditure export as candidate money. The
campaign-document label “Independent Expenditure Statement” can identify a
DS-DE 7 party rebate affidavit and does not establish reported spending.

The existing scheduled batch explicitly disables outside finance. Its optional
resolver consumes trusted/manual support evidence or committee-name heuristics;
the outside contribution aggregator measures donations to groups, rather than
expenses allocated to candidates. Acquiring candidate contributions cannot
establish an outside-spending zero. Preserve existing outside rows and totals
when attribution or acquisition is unavailable.

The candidate contribution export has payment type, not contributor legal type.
The actual nine-column format has `CityStateZip`; the current parser discards
that field. The official committee registry exposes legal account/type/name,
with targeted searches including closed accounts. Active-only registry matching
misses historical and cross-type collisions. Retain the source legal type and
resolve identity before choosing a committee category; a PAC word or reported
occupation alone does not establish a registered PAC identity.

## Implementation order

1. Preserve the combined reported location without guessing how to split it.
   Test the real export shape, signed refunds, and identical occurrence counts.
2. Resolve the numeric receiving account against the actual candidate, general
   election year, office, and district. A synthetic local committee key or
   surname query cannot establish ownership. Build saved-page-first source
   acquisition with immutable raw bodies, hashes, request parameters, and real
   acquisition timestamps. Legacy cache metadata alone cannot prove completeness.
3. Treat a public processed report as a current snapshot only after validating
   complete current filing status, report identity, detail counts, native period
   totals, and the full native/generic financial occurrence multiset under stable
   before/after status brackets. Preserve duplicate occurrences. Do not replay
   ADD/UPD/DEL instructions from a processed export that does not contain them.
   Do not reject all amended reports merely because historical original files
   are unavailable; document the published-current contract and its limits.
4. Identify political committee donors from source registry evidence, including
   registration/disbandment dates and reported address when needed to resolve
   same-name accounts. Preserve genuine uncertainty rather than selecting an
   active account by default. Compute cash gifts and signed REF refunds by the
   verified legal donor. Tant's published $1,500 gifts and −$500 refund must net
   to $1,000. Exclude carryover, loans, in-kind, interest, and self-funding from
   PAC gifts. Do not change existing Raised semantics as an incidental step.
5. Add typed PAC donor storage, atomic writer integration, and the existing
   “PAC money by interest” reader, including “Not yet sorted.” Verify complete
   groups/counts before display caps. Preserve a prior accepted component when
   its new source cannot establish current money. The typed donor scope includes
   PAC/CCE political committees and PTY/PAP parties, retaining those distinct
   legal types; ECO/ECI/IXO remain separate. Unmatched positive names stay
   unclassified; unknown refunds or ambiguous identities preserve the component.
   Use a new migration number;
   applied Oregon migration 331 must not be renumbered or reused.
6. Wire candidate outside expenses only when a primary source provides the
   spender, full candidate identity/office/district/year, direction, amount,
   and allocation/version contract. Continue that investigation alongside PAC
   work. A PAC-only result leaves this gap open; it does not complete Florida
   or the overall source goal.
7. Run the ordinary local sync against fresh official data. Record before/after
   row counts, a candidate's donor amounts, stored provenance, and the ordinary
   ballot card before opening one factual Florida PR. No production changes or
   AI provider calls; feature flags stay inline, never in `.env`.

## Filing deadlines and required fresh reruns

Official 2026 calendars were fetched again on October 11. Filing dates use
Eastern time; reports are due at 11:59 p.m. A saved October 11 generation is not
a completed pre-election finance picture. Each rerun must acquire genuinely
fresh source data rather than replay an old cache.

| Filer | Report deadline | Fresh rerun |
| --- | --- | --- |
| Nonstatewide candidates | G5 October 23, covering October 3–16 | October 24 |
| Nonstatewide candidates | G6 October 30, covering October 17–29 | October 31 |
| Statewide candidates; PC/IXO | G4A October 16, covering October 3–9 | October 17 |
| Statewide candidates; PC/IXO | G5 October 23, covering October 10–16 | October 24 |
| Statewide candidates; PC/IXO | D1–D6 October 24–29 | Following mornings, for the supported daily path |
| Statewide candidates; PC/IXO | G6 October 30, covering October 17–29 | October 31 |
| Parties | G6 October 30, covering August 14–October 29 | October 31 |
| Applicable continuing filers | Q4 January 11, 2027, covering October 30–December 31 | January 12, 2027 |

Daily reports require previously unreported contributions; expenditures are
optional. Do not count the same expenditure again in G6. Party calendars do not
inherit PC daily deadlines. ECO electioneering reports have a distinct scope
and additional daily filings; do not turn them into independent expenditures.
Candidate termination/unopposed reporting requirements need their own applicable
calendar check. No recurring automation is requested or created.

Primary sources:
[IE instructions](https://dos.fl.gov/elections/candidates-committees/campaign-finance/filing-campaign-reports/campaign-reports-independent-expenditures/),
[106.071](https://www.flsenate.gov/Laws/Statutes/2026/0106.071),
[upload specification](https://dos.fl.gov/media/694088/dsde111.pdf),
[public database](https://dos.fl.gov/elections/candidates-committees/campaign-finance/campaign-finance-database/),
[nonstatewide calendar](https://dos.fl.gov/media/709876/2026-reporting-dates-other-than-statewide-candidates.pdf),
[statewide calendar](https://dos.fl.gov/media/709819/2026-reporting-dates-statewide-candidates.pdf),
[PC/IXO calendar](https://dos.fl.gov/media/709820/2026-reporting-dates-pc.pdf),
[party calendar](https://dos.fl.gov/media/709817/2026-reporting-dates-parties.pdf).

Detailed raw-source journals and financial reconciliation witnesses remain outside
the repository; reviewers can request them from the PR author. No credentials or
raw donor address exports belong in Git.

## Completed source-row foundation

The parser now retains `City State Zip`/`CityStateZip` independently of optional
separate location columns. Florida's 97 existing/new tests and backend typecheck
pass. Replaying the untouched saved Botana public export retained all 107
reported combined locations. Its 15,286 source bytes and original SHA-256
`2bebd1baed2bd2dc81f35994ebb2c97d417ba42f679a07d0a109c27f9388d1dc`
match the acquisition journal. This is a saved-source parser check, not a fresh
financial acceptance or a normal sync money proof. No new PAC/outside rows have
been written and no Florida PR has been opened.

The standalone net committee aggregator passes 21 focused tests and backend
typecheck. It nets CHE/CAS/MO and identified signed REF occurrences, retaining
positive occurrence counts, true committee/party types, and unclassified cash.
Unknown refunds, negative net, ambiguous identity, unsafe cents, or malformed
source values preserve the component. It is not yet called by the normal sync.

Fresh source followup found RSLC–Florida's explicit $525 “PRO-JON MAPLES, HD-87”
expense, but its EFS report is for the March special election, not either local
General/Primary link. New Southern Majority's seven explicit county school-board
support expenses total $82,616; none of those targets is in the linked cohort.
These are source mechanism/regression witnesses, not new local outside money.
No current eligible outside positive has been accepted.

Tant's fresh whole-source bracket currently preserves PAC: Q4/2025 is Amending /
Updated–Needs Review, with EFS count 59 versus 57 published rows. The two identical
June 17, 2025 $1,000 self occurrences are **INK**, correcting older research prose;
retain their multiplicity and exclude them from cash. The separate $1,500 cash /
−$500 PAC refund pattern remains a financial witness, not an accepted whole-source
normal-sync result.

## Current implementation checkpoint

The saved-first public source client stores untouched response bytes, SHA-256,
HTTP status, exact public request fields, and genuine capture times in separate
UUID generations. Every closing acquisition is fresh; the refresh flag bypasses
saved openings. A shared research registry journal was overwritten; its old
registry bodies are research fixtures only. A new intact registry generation
reestablished the dated Home Builders identity, with no reconstructed timestamps.

The all-status candidate catalog reconciles all 1,145 primary accounts between
native HTML and the 26-column export. Eleven Governor running mates remain
separate contexts. Source accounts are resolved automatically and independently
bound to actual local General races, eligible offices and compact district IDs.
Botana resolves to account 88807/House 80; Tant to 88773/House 9.

Botana's genuine 78-request processed-source generation passes after correcting
the visible-heading district parser. It contains 18 current reports, 108 native
occurrences and 107 cycle occurrences. One independently verified waiver has no
selectable native export; it is not inferred from a sequence gap. Current amended
reports are accepted only under the complete stable report/count/cover/multiset
contract. Recipient whitespace projection does not change untouched source rows
or donor identities.

Normal due sync now calls the registered committee source and omits an uncertain
PAC component while continuing independent direct finance. Atomic PAC writer and
the existing card reader are integrated. Migration 332 was applied only locally;
its immutable SHA-256 is
`6ca77148e755a7f0ec66d92b82177f1936974c8cb0ca8449e17fec851ca5d0cc`.
Applied Oregon migration 331 is untouched. The reader retains exact registered committees
and parties under “Not yet sorted” and computes all totals/counts before caps.

The first full Botana donor scan preserved at the Duke Energy historical
same-name collision. Its published closed account needs independently reviewed
effective dates; current money is not accepted from the known-donor subset. The
external reviewed-date manifest carries account/date/source-PDF bindings only
after source review. No Florida money write or PR has been proved yet. Ordinary
fresh local sync, stored candidate numbers and reader proof remain required.

All 515 Florida tests pass, including atomic rollback, actual local race binding,
full source occurrence/count gates, failed-component preservation and complete
reader totals before caps. Backend typecheck and migration filename/status checks
pass. New temporal evidence distinguishes an exact effective day from source
proof that an account was active or closed by a reviewed date; filing dates are
not silently substituted for effective dates.

### Ordinary local sync checkpoint, October 11

The ordinary due-sync CLI ran for Botana with an explicit local Unix-socket
database, fresh export/source artifacts, one candidate, the reviewed-date
manifest and AI calls disabled. Its verified-source generation retained 160
genuine HTTP 200 captures. Direct Raised changed from $86,700 to $113,700 over
107 current cycle contribution occurrences. The independently gated committee
component preserved at the FAIAPAC historical account collision: no accepted
component or donor rows were written. The ordinary ballot reader returns Raised
$113,700, omits an unknown PAC card, and retains NULL outside support/opposition.
This proves the failure-preservation path, not positive PAC acceptance.

Reviewed source bounds now cover Home Builders, Duke Energy and FAIAPAC account
transitions. Exact effective dates remain distinct from active-by/closed-by
evidence. The observed Duke street postdirectional NORTHWEST/NW projection is
limited to its position after AVENUE, with unchanged suite and locality, following
USPS Publication 28 section 233.22. Remaining donor identities must resolve for
the complete component before another genuinely fresh ordinary sync can accept
PAC money; no known-donor subset is written.

All 549 Florida tests and 83 ballot-reader tests pass. Settled full backend
typecheck/tests pass: 13,919 tests passed, 152 skipped. Mobile typecheck/lint pass
with existing warnings; all 98 Worker tests pass. Frontend typecheck/lint pass;
installed Node 23 full frontend run passed 1,222 tests with one pager timing
failure; an isolated rerun of that complete file passed all 113 tests. Earlier
Node 20/24 runtime failures remain recorded outside Git. No Florida PR has been
opened.

Fresh bounded independent-expense discovery retains full Purpose but supplies
no eligible local state-office positive. Jon Maples' $525 source witness is
Special-election spending; actual local records contain only Primary/General,
so neither may receive it. Partial spender discovery cannot use the legacy
global outside-group replacement or infer zeros. Complete current expense proof
and a scoped persistence path remain open work. Post-deadline fresh reruns above
remain required even after present source coverage is accepted.

### Next outside source foundations

Before adding a normal outside hook, implement two bounded source-only steps.
First, an exact-query saved-artifact-first discovery adapter validates the
official eight-column full-Purpose expense export, election selector and row
limit. Refresh bypasses saved openings. Missing/failed/capped/malformed data
remains unknown; discovery does not authorize money or zero writes.

Second, a pure current committee expense verifier separately binds the numeric
legal owner, native committee activity cover, current EFS report and complete
native/generic expense occurrences under genuine before/after capture metadata.
The observed committee cover has eight cells with Expend/Other/Transfers, unlike
the candidate contribution cover. New Southern Majority's five P7 and two G1
rows reconcile to $82,500 + $116, including full Purpose in the generic export;
their seven school-board targets remain outside this local state-office scope.
Report counts, full financial multiset and expense-cover totals must reconcile
before target filtering. Native selectors and EFS report sequences are
independently bound rather than equated. Scoped persistence and an eligible
local positive remain separate subsequent gates.

### Positive outside payer acquisition

Before persistence, add a bounded all-status payer adapter. Only positive IEC
discovery occurrences whose full observed Purpose matches the actual local
candidate name, office and seat produce leads. Leads retain every occurrence
and grant no election, money or zero authority. Generic vendor addresses never
serve as payer addresses. Source payer annotations must exactly reconstruct the
full registered legal name and class, preserving legal-name parentheses.

Two distinct literal name prefixes and independently fresh closing queries and
complete account details must remain stable. Acquire all exact legal-name
accounts across classes/statuses, then require one exact annotated PAC/IXO
account. Multiple accounts with that complete annotation remain unknown; active
status alone does not resolve them. Numeric owner and full current expense
proof remain separate gates. No legacy outside-group replacement receives
partial discovery; no absent spender or opposite direction becomes zero.

Next, compose candidate allocations by re-running the pure expense verifier on
the full raw packet, then matching each native occurrence against its actual
current EFS report and local race. Preserve a source election mismatch before
allocation. A verified one-payer target component can be empty, but never
authorizes a candidate-wide total or zero. Retain duplicate occurrences and
complete source provenance. Atomic persistence must repeat this verification
and local ownership under a lock; database provenance stores metadata only.

### Normal outside hook checkpoint

Automatic current expense acquisition and raw-packet re-verification are
implemented. Exact full-name Purpose discovery runs after ordinary direct/PAC
sync, with saved openings, fresh closing authority and independent failed-payer
preservation. Previously accepted payers refresh even if discovery no longer
contains a lead. A candidate-election is processed once across receiving links.
The new scoped writer and migration 333 use separate payer rows; candidate-wide
outside totals and the legacy groups remain unchanged. The reader displays
explicit checked groups with a partial-coverage note and refuses to combine
them with unreconciled legacy outside totals/groups.

The retained General source audit checked 1,017 query occurrences, including
23 IEC query occurrences across four uncapped exact scopes. Overlapping queries
are not summed. None supplies an eligible explicit local General state-office
target. Special-election purposes can appear under a General generic selector,
confirming that the actual current EFS election must bind the final allocation.
The separate PRO- query fills its 500-row cap, so this audit proves neither
statewide absence nor candidate-wide zero. No real eligible outside positive
has been accepted. Post-deadline fresh reruns remain mandatory.

The external date manifest now contains 20 integrity-verified records. Two
CCE accounts with Closed or Revoked status have distinct enacted-law
certification revocation authority; it is not recorded as a closure date. The
complete 91-tuple source identity replay is resolved. The next genuinely fresh
ordinary local sync remains required. No partial known-donor subset is accepted.

### Fresh post-deadline source runs

October 17, 24 and 31 reruns require both `--refresh-export-artifacts` and
`--stale-after-days 0`. Refresh bypasses saved opening source captures; it does
not bypass the normal seven-day due filter, including for `--candidate-id`.
January 12, 2027 Q4 reruns additionally require `--lookback-days 90`; the default
one-day election lookback would omit November 3 races. Existing eligibility
excludes lost and withdrawn candidates, so these are current eligible-race runs,
not historical coverage. Daily/cumulative overlapping expense periods remain
preserved until independently reconciled.

Payer identity now encloses verified financial acquisition: complete all-type,
all-status opening queries and exact-name details finish before the earliest
financial capture, and every closing detail/query is freshly captured after the
latest financial capture. The atomic writer repeats this interval check on raw
source replay. Original cached opening times remain unchanged; incompatible
capture intervals preserve the component. No financially valid component escapes
if final payer identity changes or becomes ambiguous.


Within the nested outside flow, financial opening and closing packets are always
fresh. Otherwise, an opening financial owner GET could reuse the payer opening
GET and predate completion of the payer authority. Discovery and registry
openings retain saved-first behavior and original capture times; registry
closings remain fresh. This bounded financial freshness is necessary for the
normal default hook and does not relax source completeness or zero authority.

### Fresh ordinary local sync proof

The October 11 ordinary due CLI completed against the local `voteapp` database
with the Florida flag enabled inline, AI calls disabled, refresh enabled,
staleness set to zero and the 20-record reviewed date manifest. Its new financial
generation captured 578 genuine HTTP 200 responses from 22:38:25 through
22:48:10 UTC; outside discovery captured one additional HTTP 200 response.
Independent replay verified every original body, hash and journal metadata.

Adam Botana's House 80 General link changed from zero PAC rows/components to
24 registered PAC donor rows and one accepted current processed component.
Net PAC cash is $25,500 across 28 gift occurrences, with no refunds. The full
proof retains 18 current reports, 78 financial captures and 106 registry lookups;
$68,200 across 78 positive cash occurrences remains unclassified. The ordinary
ballot reader displays $25,500 and 24 PACs under “Not yet sorted,” with its
five-name display cap applied after the full total/count. Raised remains
$113,700. No outside component was written; supporting/opposing totals remain
unknown. Empty discovery supplies no financial zero. These are source-reviewed
CLI results, not a claim that every Florida candidate or outside payer is covered.

PAC replacement now locks prior accepted provenance and preserves older,
malformed or missing-period refreshes while independent direct data can commit.
Outside replacement checks the same prior-period boundary, nested registry
authority, genuine closing source age, actual local ownership and legacy data.
Migration 333 was applied only locally and is now immutable, SHA-256
`96021a3a5a9d7bc25cf31e021a046b1db45bdfa74bb3ec3644de117a25a854f9`.
Migration 332 remains unchanged. No source date is replaced with a job timestamp.

Settled backend checks pass: 14,235 tests passed, 152 skipped, plus typecheck
and 11 auth-proxy checks. Complete frontend tests pass on installed Node 23:
1,223 tests across 99 files. Migration file checks pass. Prior frontend/mobile
typecheck/lint and 98 Worker tests pass, with existing lint warnings. The filing
deadline reruns above remain required; eligible outside positives, additional
Purpose grammars, daily reconciliation and broader source coverage remain open.

### Legislative IE acquisition independent of direct finance (October 28)

New complete current native reports witness `DATA SUPPORTING Full Name (HD-N)`
and `MAILER & PHONE BANKS SUPPORTING Full Name (HD-N)`, with corresponding
`SD-N` Senate clauses. The parser accepts only these anchored single-target
forms, exact full names and valid chamber seats. Pooled, truncated, unsupported
or mismatched clauses remain excluded. An independent full-book reference found
25 such clauses, 23 exact canonical target matches across 12 local races; two
name mismatches and one other IEC purpose remain excluded. This is scoped source
qualification, not statewide coverage.

The ordinary due runner now selects legislative IE contexts independently of
direct-summary freshness, missing receiving exports and direct/PAC failures.
Candidate-specific discovery requests each witnessed prefix separately, with
the existing strict UTF-8/2,000-row acquisition bound. Discovery is never money
or absence authority. Every admitted component still requires exact all-status
registry ownership enclosing both complete native financial snapshots, current
EFS statuses, report counts, cover totals and generic/native occurrence equality.

Migration 389 adds a separate scheduling-only acquisition-attempt table. Oldest
attempts sort first and sibling receiving links deduplicate before the bound.
Failures and empty discoveries back off at most one day; accepted financial
freshness continues to use actual verified source times. No attempt stamps money,
completeness or candidate-wide zero. Explicit `--stale-after-days 0` bypasses
attempt backoff as well as accepted-source staleness for deadline reruns.

The first October 28 normal local run acquired 149 whole responses and wrote one
positive payer/target component while direct export was gated off by its separate
raw-export flag. That is a live independence proof, not a fresh direct proof.
A subsequent run with all three Florida flags enabled inline acquired 310 whole
responses, refreshed direct finance and independently refreshed the positive IE
component containing two allocated occurrences. The prior PAC component and all
24 donor clocks remained held. Independent Decimal/count/identity audits verified
the full 117-row receiving export, exact raised total and all 53 occupation/size
buckets; both full 27-expense books, 13 current reports, every admitted allocation,
stored source-metadata envelope and genuine closing clock also reconciled.
Ordinary HTTP matched the production reader and every displayed IE/PAC row. The
real hydrated candidate card displayed fresh direct data, the IE group, preserved
PAC data and partial-coverage note; reload and interactive expansion preserved
every visible finance text. Candidate-wide support/oppose totals remain unknown.
No production writes, financial extracts, financial screenshots or publication
hold changes. All 892 Florida tests, backend typecheck and migration checks pass.

The current run precedes G6: due October 30 for activity through October 29.
Fresh reruns remain required October 31/November 2 and late checks November 4/6.
Q4 is due January 11, 2027; rerun January 12/15 with the historical lookback
described above. No automation was created.
