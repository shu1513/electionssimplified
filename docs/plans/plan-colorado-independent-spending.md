# Colorado independent spending

## Source and scope decision, October 22, 2026

TRACER publishes Independent Expenditures - Detail as native CSV, XML and PDF.
Its jurisdiction default, All Counties, excludes the separate STATEWIDE scope.
Acquire all three published scopes, including FEDERAL, and validate whole source
controls before filtering candidates. The existing Colorado batch calls only the
direct contribution ZIP path; new IE acquisition and freshness must work separately.

Fresh contribution ZIPs still fail strict whole-source decoding or CSV grammar.
The bulk donor ContributorType is distinct from the receiving CommitteeType.
Clean native receiving exports and the complete typed registry now support a
separate cash-donor component. The source path and acceptance below qualify one
receiving context; malformed ZIPs remain held.

Acquire January 2022 through the observation date, then use each candidate’s
actual published financial cycle (currently December 9, 2022–December 3, 2026).
Whole source controls must close across CSV/XML and repeated complete observations.
Native shared expenses and statewide controls retain fractional cents. Preserve
exact microdollars; candidate groups must sum to exact cents before publication.
CSV currency cells verify native cent rendering; XML retains exact decimals.
Use the agency’s America/Denver calendar day for report and registry dates.
Native expense parents can list multiple targets without allocations.
Count each parent once; preserve signed credits and repeated occurrences. Never
divide a shared amount or infer support/oppose from a payee or description.

Source target fields give explicit person, party and office, but no district.
The first local acceptance admitted independently verified current statewide
Governor, Attorney General, Secretary of State and State Treasurer contexts.
Legislative contexts additionally require the canonical chamber/district bridge,
an all-years/all-status native candidate census and each peer's actual financial
cycle. Reporting captions contain a registered name plus a literal trailing
comma; exact complete typed registry and native profile evidence corroborate the
reporter. Do not treat vendors as reporting committees or infer legal entities from
name hints.

## Implementation and acceptance sequence

1. Strict native report/registry parsers with synthetic fixtures and genuine replay.
2. Graph-bound saved-first acquisition; gated fresh source and complete closing
   controls, plus candidate-specific native campaign identity qualification.
3. Protected independent component writer, due query and ballot reader overlay.
   Recheck canonical intent under lock and on read; keep direct money/clocks intact.
4. Ordinary local sync, independent uncapped SQL/source amounts, actual API and
   hydrated candidate card proof, then a Colorado pull request.

New flags default off beneath Colorado gates. Source failures retain prior money
and clocks. Publish positive, proved single-target allocations with explicit partial
coverage; unsupported or absent evidence stays unknown. Tests or a dry run alone
are insufficient acceptance. Kansas contributor names and all new Missouri
publication remain held.

## Late filings and manual reruns

The [official frequent calendar](https://www.coloradosos.gov/pubs/elections/CampaignFinance/calendars/2026/2026StateFrequentMonthlyBiweekly.pdf),
revised July 2026, sets October 19 through October 14, November 2 through
October 28, and December 8 through December 3. Applicable 48-hour IE supplements
run October 4–November 2 in addition to regular reports. Acquire fresh originals
after November 2 (November 3/4), after December 8 (December 9/11), and again for
late/amended filings. These are manual reruns; no automation.

Sources: [native reports](https://tracer.sos.colorado.gov/PublicSite/Reports/Reports.aspx),
[bulk downloads](https://tracer.sos.colorado.gov/PublicSite/DataDownload.aspx).

## Local acceptance, October 22–23, 2026

The ordinary IE-only CLI wrote one source component and two reported-name groups
from six allocated expenses: $153,630 supporting and $967,058.33 opposing one
verified existing candidate. The native source cycle is December 9, 2022 through
December 3, 2026; this observation includes filings through October 22. Nineteen
shared candidate expense parents remain unallocated.

Uncapped local SQL, the actual HTTP API and the hydrated candidate profile agree.
The same genuine originals produce an idempotent write. An injected group-insert
failure after source replacement and group deletion rolls back all money and
clocks. All existing Colorado links, direct summaries and breakdowns remain
unchanged. New functionality defaults off.

For a local run, pass `CANDIDATE_FINANCE_ENABLED=true`,
`COLORADO_CAMPAIGN_FINANCE_ENABLED=true`,
`COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED=true`, and
`COLORADO_REPORTED_IE_ENABLED=true` inline. The existing
`COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED=true` flag permits public acquisition.
Run the normal Colorado due-sync command with `--ie-only`; `--ie-cache-dir`
selects a private originals cache, and `--ie-link-id` targets a verified link.
`--refresh-ie` makes the selected IE contexts due and acquires fresh originals;
it cannot bypass source or sync gates. Use it for the deadline reruns above.

This first acceptance proves one current statewide context. Subsequent
legislative and native cash-receipt acceptances are documented below.

## Legislative identity research, October 23

The native Candidate Listing supplies complete candidate/party/office/district
and receiving-name populations for all 18 published election-year options.
Opening and closing observations match across 3,661 rows and 36 paired CSV/XML
exports, including inactive candidates and early future-year registrations.
Blank historical party values remain unknown. A strict roster parser retains
every occurrence and verifies the full population across both formats.

This roster supplies neither candidate/receiving IDs nor financial-cycle bounds.
Actual IE target spellings match historical entries with other committees and
districts, so current-year name uniqueness is insufficient. Native all-years
search IDs and each peer's published campaign dates must resolve overlapping
identities before legislative money is admitted. One actual family search now
closes five grid rows, two native candidate IDs and six complete campaign rows
against a fresh second observation. Every matching roster row maps to that grid,
and every grid row maps to published native campaign dates. Those dates separate
all 58 observed target occurrences from historical peers: 37 single-target
expenses qualify for further integration; 21 shared parents remain unallocated.
This is source proof. The protected writer/reader now have a separate legislative
revision that requires those peer and seat controls; existing statewide snapshots
retain their original shape and revision. Every record action uses its own page's
form state. Repeated pages, wrong returned IDs and changed closing inventories hold
the component.

The ordinary local IE-only CLI now also proves one existing House context: five
groups from 37 single-target expenses, $161,505.38 supporting and $62,293.12
opposing. Its actual financial cycle is December 6, 2024–December 3, 2026; this
source observation includes filings through October 22. Twenty-one shared parents
remain unallocated. All 58 matching target occurrences have one applicable native
candidate/campaign context after the historical peer dates are checked.

Uncapped SQL, the actual HTTP API and the hydrated candidate page agree on every
group and amount. Default-off behavior, source links and district/cycle coverage
text pass. Reusing the same genuine originals is idempotent. A fresh 21-original
candidate/peer acquisition followed by an injected group-insert failure rolls back
the real source replacement and group deletion. All component rows, existing
statewide money, legacy direct finance and their clocks remain unchanged.
These two local candidate acceptances do not constitute a full statewide batch.
Native cash-receipt acceptance below adds one independently qualified receiver.

## Native named committee receipts: source decision, October 23

The native receiving report closes all 14 currently filed periods in one verified
House committee's actual December 6, 2024–December 3, 2026 financial cycle.
Its 257 receipt occurrences reconcile to independent filing parents: $107,240
gross, $2,750 signed returns and $104,490 net. Reports currently end October 14.
All current regular filings are filed and unamended; unknown versions or kinds
must hold the component until qualified.

Acquire every native committee class across All Counties, STATEWIDE and FEDERAL,
including inactive registrations. Complete opening/closing CSV/XML populations
close across 15,112 registry occurrences. Federal scope supplies 120 Federal PAC
rows absent from the other two scopes. Exact normalized registry names identify
78 cash receipts in this receiver: 69 reported-name groups totaling $64,675.
All 78 have blank contributor types. Explicit individuals and unmatched businesses
remain excluded; no name-token heuristic or inferred industry.

Two current major-contributor notices each match one regular receipt and must
not add money again. Their full exports, independent totals, receiver identity
and empty loan sections close. The
[official supplemental calendar](https://www.coloradosos.gov/pubs/elections/CampaignFinance/calendars/2026/2026SupplementalRptCalendar.pdf)
also requires separate 24-hour notices for major contributions during October
4–November 2. Keep the post-deadline manual reruns above, including late notices
and amendments.

Implementation proceeds through strict parsers and genuine replay, saved-first
native acquisition, a separately gated protected cash-donor component, then the
ordinary local CLI, uncapped SQL, actual API and hydrated candidate-card proof.
Receipt freshness must remain independent of the malformed bulk ZIP and IE.
The reader remains default off and requires successful whole-source qualification
through that protected path.

## Native cash implementation and local acceptance

`COLORADO_NATIVE_RECEIPTS_ENABLED` defaults off beneath the global and Colorado
read gates. Acquisition uses complete saved originals first; the existing raw
refresh flag permits fresh native reports. The component has separate source,
donor and retry tables, canonical ownership checks and an atomic replacement
transaction. Neither direct ZIP discovery nor IE freshness controls this path.

The ordinary Colorado due-sync CLI accepts `--receipts-only`,
`--receipts-cache-dir`, `--receipts-link-id` and `--refresh-receipts`. Enable the
normal Colorado sync flag inline for writes. `--ie-only` and `--receipts-only`
are mutually exclusive. Deadline reruns must include fresh receipt acquisition
when this component is enabled.

Actual production acquisition retained 219 registry and 251 receiving originals.
Saved-only replay made zero network calls and reproduced every control. The
ordinary targeted receipts-only CLI then wrote one source and 69 donor groups
from 78 registered-name receipts, totaling $64,675. Uncapped SQL compared every
name, key and amount to the genuine source in memory. All existing Colorado
links, direct finance, IE components and their clocks stayed unchanged. The
actual HTTP API agrees on total/count and its five displayed groups; default-off
behavior and existing direct/IE/headline clocks pass.

This is one qualified receiving context, not a full statewide batch. Initial
admission requires complete positive native history controls, unamended regular
filings, the three qualified monetary/return kinds, zero noncash contributions
and expense-return controls, and every current major notice represented by
regular cash occurrences. Unknown empty-history states, amendments, new kinds,
loans in notices or uncovered notices hold the component and preserve prior
money and clocks; they require further source qualification. No zero or complete
statewide-coverage claim follows from a held component.

Migration 379 was applied through the ordinary local runner. All 402 previous
checksums stayed unchanged. Migration 379 is now immutable.

The actual hydrated CandidatePage also passes: both disclosures open, the cash
heading, $64,675, 69 reported groups, all five displayed names/amounts, “and 64
more,” full coverage text and official links agree. Existing IE sentences remain
correct. The browser reported zero page errors and zero remote requests; no
financial screenshots, video, traces or extracted text files were created.

Real writer replay is idempotent. A new complete 219-original registry observation
followed by an injected donor-insert failure exercises actual source replacement
and donor deletion, then rolls back. All nine Colorado component/legacy tables
and their clocks remain identical, with zero committed financial changes.
