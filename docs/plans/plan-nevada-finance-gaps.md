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
   exact Keystone Corporation PAC witness, but publishes no verified result
   count for that query. Its $2,500 gift remains excluded. A narrow literal PAC/P.A.C. name
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
controls and canonical page paths with query values omitted. The verifier must
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
