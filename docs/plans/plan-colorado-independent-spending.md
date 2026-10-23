# Colorado independent spending

## Source and scope decision, October 22, 2026

TRACER publishes Independent Expenditures - Detail as native CSV, XML and PDF.
Its jurisdiction default, All Counties, excludes the separate STATEWIDE scope.
Acquire all three published scopes, including FEDERAL, and validate whole source
controls before filtering candidates. The existing Colorado batch calls only the
direct contribution ZIP path; new IE acquisition and freshness must work separately.

Fresh contribution ZIPs still fail strict whole-source decoding or CSV grammar.
The bulk donor ContributorType is distinct from the receiving CommitteeType.
Clean native receiving exports and a typed registry exist, but named committee
receipts still need complete receiving/version/control and positive identity proof.
This increment does not qualify those donors.

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
Initially admit only independently verified current statewide Governor, Attorney
General, Secretary of State and State Treasurer contexts. Legislative identity
remains held. Reporting captions contain a registered name plus a literal trailing
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

This acceptance proves one current statewide context. Legislative district
identity and native committee-receipt qualification remain open Colorado work.

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
This is source proof. The current writer and reader remain scoped to the four
qualified statewide offices; legislative sync/API/card acceptance is still pending.
