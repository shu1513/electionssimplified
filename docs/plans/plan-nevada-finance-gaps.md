# Nevada finance gaps

## Evidence before implementation

The October 12 local audit found 97 active finance links, including 94 declared
general-election candidates, two withdrawn candidates and one judicial candidate
with no election stage. The ordinary reader returned 95 stored cards, no PAC
donor cards, no outside groups and no known outside amounts. The priority score
is 94 × 0.40 = 37.60; this estimates the next correction's feasibility, not
complete statewide coverage.

1. AURORA publishes independent-expenditure filer expense reports. Reviewed
   schedules identify vendors, dates and amounts but do not establish an
   allocated candidate or support/oppose direction. Candidate-specific outside
   spending remains unverified. Do not infer it from advertising categories,
   vendors or filer type.
2. Nevada has no unused independent-expenditure collector or live batch to
   enable. Its existing path reads browser-acquired artifacts through
   `nevada-candidates:finance:import`, then the normal snapshot writer and ballot
   reader. Outside inputs are already omitted, preserving stored data.
3. Contribution CSV `Type` identifies monetary, in-kind or commitment
   transactions, rather than donor class. The typed group registry displays an
   exact Keystone Corporation witness under the PAC class, but the narrow
   query published no verified result count. That query alone cannot establish
   complete registry authority. A narrow literal PAC/P.A.C. name
   rule can also retain honestly reported committee names without inventing
   legal identities or aliases. Generic companies, associations and acronyms
   are insufficient.

## Smallest correction

Add an optional candidate-scoped committee-donor artifact to the ordinary
Nevada importer before its monthly direct CSV dependency. Use the existing
atomic snapshot callbacks and PAC interest reader pattern. Donor-only imports
omit the summary, direct breakdowns and outside components. They must preserve
direct amounts and direct `last_synced_at`, bind one existing active receiving
link and recheck canonical state, office, seat, year and candidate status.
Accepted donor evidence also renders before a direct summary exists, with
unknown direct/outside totals and donor observation freshness. Existing direct
cards retain their own totals and freshness.

The source contract must establish complete current cash schedules and paired
fresh report/manifest observations. Retain equal gift occurrences, signed cash
positions and actual loan-column evidence. Missing, changed, ambiguous or
unreviewed observations preserve the stored donor component. A complete
replacement may remove old donor rows; retain a source watermark even for an
accepted empty component. Reported-name keys describe source names, rather than
asserting a legal committee ID. PAC money is a subset of Raised and is never
added to Raised.

The bounded Hansen witness contains the 39-record manifest on two pages and
three applicable reports: annual 2025, 2026 CE1 and CE2. Their 26 cash rows total
$41,333.34: $9,833.34, $13,500 and $18,000 respectively. Financial schedules
were reloaded and agreed. Printed loan cells are blank under “CHECK HERE IF
LOAN”; they contain no checkbox elements. No negative cash rows or literal
return text were observed, and no dedicated no-returns control exists.

Browser observations are not HTTP response captures. A blocked transfer of
opaque locator values must not be retried through encoding or hashes. Safe
financial observations may retain actual times, public report descriptors,
controls and canonical page paths with query values omitted. Each current and
prior financial observation must retain `candidateName` from that report's
public owner header; it must match the packet context. Older packets without
this evidence must be reacquired, not backfilled from the context. The verifier must
reject descriptors that do not uniquely identify the selected report and must
not claim omitted locators or source HTTP bodies were retained. Acceptance of
that safer source contract was verified against the saved packet and tests.

Migration 337 was verified free after inspecting the local applied ledger.
Applied migrations 330–336, including both independent 334 filenames and the
unmerged South Carolina 335, remain immutable.

## Real local proof before a PR

- Save the actual source audit and safe observation packet; validate complete
  current report ownership, periods, controls, occurrence counts and closing
  agreement.
- Run focused finance tests and typecheck in this worktree.
- Run the ordinary importer against the explicit local database with AI
  disabled and state flags inline. Verify persisted donor counts/amounts,
  unchanged direct amounts/timestamps and unknown outside totals.
- Read the actual production DTO and render the actual Hansen finance card.
- Run required checks, then open a Nevada-only PR with factual coverage limits.

### Observed October 12 results

The ordinary `nevada-candidates:finance:import --committee-donor-artifact FILE
--filer 'Alexis M Hansen' --election-date 2026-11-03 --write` accepted the real
saved financial observations with AI disabled and an explicit local DSN.
It persisted four reported-name PAC positions totaling **$9,000**: Nevada
Realtors PAC $5,000, Associated General Contractors PAC $1,500, Nevadans For
Fair Recovery PAC $1,500 and Nevada Integrity PAC $1,000. No complete registry
query is supplied by this packet; attached suffixes and unclassified generic
organizations remain excluded.

Read-only before/after audits confirmed all 97 link business records, 95 direct
summaries and 756 direct breakdowns retained their amounts and existing direct
freshness timestamps. Hansen's Raised **$41,333.34**, Spent **$73,266.49** and
Cash **$23,678.19** remain unchanged. The actual production reader and actual
`FinanceSummaryCard` render four names/$9,000 under “Not yet sorted.” Outside
totals remain unknown. This is one candidate's accepted itemized cash subset
through June 30, not statewide or complete PAC coverage.

The full local backend run passed 15,373 tests, skipped 163, and encountered
24 failures in five existing environment-dependent research suites plus an
unhandled historical-import startup error. All 40 tests in those five suites
passed on a separate mocked-only retry with placeholder loopback configuration.
The historical-import startup issue remains outside this Nevada change.

Final focused validation passed **184 tests in 11 files**, backend and frontend
typechecks passed, frontend lint passed with existing warnings, and **98 worker
tests** passed. Local frontend tests hit `ERR_REQUIRE_ESM` in the existing
jsdom dependency stack before 98 suites could execute; two tests passed.
The final real local replay again stored four positions/$9,000, with all direct
business fields and freshness comparisons unchanged. Configured remote CI is
the remaining review gate; keep the PR draft if any required check fails.

## Late filings and fresh reruns

[NRS 294A.120](https://www.leg.state.nv.us/NRS/NRS-294A.html#NRS294ASec120)
sets the ordinary candidate CE3 deadline at **October 15, 2026**, covering
July 1–September 30. CE4 is due **January 15, 2027**, covering October
1–December 31. The current donor witness reaches June 30; it does not establish
September or pre-election spending coverage.

Acquire fresh manifests, current schedules and applicable registry observations,
then rerun locally on **October 16**, with late/amended catchups **October 30**
and **November 4**. Acquire final CE4 source and rerun **January 16, 2027**.
Catchups do not manufacture October/November coverage when no newer report
exists. Re-reading an old observation is not a fresh post-deadline acquisition.
Record actual acquisition times and latest covered periods. No automation or
production operation is included.

## October 25 registry follow-up

The fresh independent-expenditure source check covered all 110 registered
independent-expenditure filer references. Of those, 108 report inventories were
readable, 64 explicitly reported no submitted reports, and two returned portal
errors on both the initial read and one retry. Eight readable filers had 15
report references with grid year 2026. Full registry and current report-list
closing observations agreed. The actual expenditure CSV still has only Payee,
Date, Amount, Type, Payer and Report columns; its positive control matched a
native statement. This bounded scope does not establish candidate allocations
or absence in other reporting channels. Outside spending stays unknown.

For donor recognition, a broader all-class group-name query can publish a
complete native pager even when the narrower query omits it. The fresh
"Corp" query contains 42 rows on two pages, including the exact reported donor
name under the PAC class. Opening and closing rows agreed. The receiving
candidate's fresh 40-report manifest selects four cycle reports through
September 30; both financial readings contain 35 cash occurrences and agree
with the native cash controls. The completed local import and candidate-card checks are recorded below.

The optional groupRegistryObservations field supplies each query's opening
and closing observations. Each contains sourceSearchPath, nameQuery,
groupTypeBlank: true, otherFiltersBlank: true, and every page's
observedAt, native pager strings, and complete four-cell rows.
Only the public Nevada search path is accepted. Native totals must close over
contiguous 25-row pages, including the final page. Names must lie within the
observed query; unknown classes, repeated physical rows, restrictive filters,
changed controls/content, missing counts and invalid time order fail before
the writer runs.

Registry opening pages must precede the receiving manifest opening; registry
closing pages must follow its closing. The complete capture spans at most two
hours and must be no more than 36 hours old. The donor source watermark stays
at the financial manifest closing time; registry closings never advance it, so
an older financial snapshot cannot replace a newer one. Full reported-name PAC
matches feed the existing aggregator; exact non-PAC classes and cross-class
conflicts retain their veto. No legal committee ID or alias is inferred.
Packets without registry observations retain literal-name recognition.

Before opening the follow-up PR, retain the complete approved donor-source
originals, independently reproduce all source and stored positions, run the
ordinary local import, verify repeat/failure preservation and every component
clock, and prove the production HTTP response and hydrated candidate card.
Direct amounts, direct freshness and outside data must remain unchanged.
No new migration is needed. Kansas contributor names, all new Missouri
publication and all new Wisconsin publication remain held.

### Observed October 25 follow-up proof

After explicit approval, all 25 complete donor-source DOM originals were
retained privately and verified by whole-original hashes and file modes.
An independent BeautifulSoup reference reproduced every native registry and
manifest row, all four effective reports, all 35 cash occurrences, signed
positions, loan-column evidence, report controls and quarterly cumulative
controls. A source-derived observation was then written to the registered
application cache and independently compared against those originals.

The ordinary local Nevada import, with feature flags inline and AI denied,
replaced four stored donor positions with six, including one exact registry
PAC name without a literal PAC suffix. Independent reconciliation compared
every uncapped stored name, reported-name key, signed amount, count,
recognition method and source watermark against the original source.

Dry-run made no changes. All direct summaries and breakdowns, outside
components, their timestamps, link business fields and verification clocks
were preserved. Only the receiving link's update metadata and donor sync
timestamps may advance. Repeating the import preserved all donor business
fields and the source observation watermark; sync timestamps remained
monotonic. Truncated-registry and missing-source failures preserved every
audited field and clock. All 412 applied migration ledger entries remained
unchanged.

The real production HTTP response matched the actual reader and stored
direct amounts and freshness. The actual React Router candidate page was
hydrated, with client state changes observed before and after a fresh reload.
Its card showed five donor names under the normal display cap, the full
six-PAC count and “and 1 more.” Every displayed name, amount and source link,
plus the full interest totals and counts, matched the source and HTTP
response. The newly recognized registry donor was visible under “Not yet
sorted.” Outside amounts remained unknown and the filing-period limitation
remained visible. No financial screenshot or source extract was saved.

Focused validation passed 226 tests in 12 Nevada finance files; backend
typecheck and diff checks passed. Proof services used read-only local
Postgres and private loopback listeners, with environment files, providers
and remote traffic denied. The initial preview needed the normal explicit
SSR API URL; the successful fresh-load proof used that configuration.
