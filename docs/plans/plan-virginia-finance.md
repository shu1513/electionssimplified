# Virginia reported finance gaps

## Source and implementation plan

ELECT publishes structured independent-expenditure HTML at
https://cfreports.elections.virginia.gov/IE, linked by
https://www.elections.virginia.gov/candidatepac-info/reporting/ for reports from
July 1, 2025 onward. Existing Virginia code acquires scheduled receiving XML
only; neither IE acquisition nor PAC aggregation is wired into the sync.

XML `Contributor IsIndividual=false` identifies organizations, not PACs. Search
the official registry across all classes, require one exact registered name of
class Political Action Committee, and corroborate the full reported postal
address against that filer's own report header filed by the gift date. Candidate
transfers, parties, other organizations and unresolved identities remain
excluded. This is a current registration classification, not a claim about
historical legal status. Include signed itemized Schedule A cash and Schedule B
in-kind contributions; exclude loans. Describe this gross receiving-side metric
and unresolved PAC-name entries on the card.

Acquire the complete receiving inventory and all scheduled/rapid XML, respecting
native election cycle, office, district and amendment controls. Scheduled periods
must be disjoint. Covered rapid occurrences must reconcile one-to-one with
scheduled itemization; admit only rapid receipts strictly after the last
scheduled close. Fail closed on ambiguous versions, periods or multiplicity.
Never sum scheduled and rapid representations of the same covered period.
Amended receiving-report families remain held until their native replacement
relationships can be proved; the prior component survives those holds.

Acquire IE independently: opening and closing complete index, every native detail,
parent/index/payee money closure and explicit percentage closure. Use the
published economic spender, explicit candidate committee, office, stance and
allocation. No target inference from purpose text. Reject ambiguous targets and
fractional-cent target allocations. Current calendar-year scope and the channel's
July 2025 start must be explicit. Preserve old money and observation clocks on
either component's acquisition, identity, validation or storage failure.

Initially qualify House candidates through ELECT's actual linked ballot XLSX,
native candidate registration and report office/district/cycle. Other office
contexts remain held until their source qualification is implemented. Recheck
canonical ownership under lock. Keep complete original bytes, genuine response
metadata and observation times in a private ignored cache; saved originals first,
raw refresh and publication separately default off. Native components have their
own seven-day due clock, 24-hour retry clock, ordinary 25-candidate batch and
112-day loser-inclusive closeout window. Legacy direct finance remains independent.

Publication requires `CANDIDATE_FINANCE_ENABLED` and
`VIRGINIA_CAMPAIGN_FINANCE_ENABLED`, plus independently
`VIRGINIA_REPORTED_COMMITTEE_ENABLED` or `VIRGINIA_REPORTED_IE_ENABLED`.
Network acquisition additionally requires `VIRGINIA_REPORTED_RAW_REFRESH_ENABLED`.
Ordinary recurring runs retain `VIRGINIA_CAMPAIGN_FINANCE_SYNC_ENABLED`.
Pass flags inline; do not edit environment files.

## Source qualification, October 21, 2026

The complete published IE graph has 432 parents and 1,154 candidate occurrences;
all parent/index/payee totals and percentage sums close. No target matches either
currently linked candidate. Two people independently match ELECT's November 3
House District 20 special-election roster. Six scheduled reports and 18 current
rapid reports yield 50 disjoint cash/in-kind items: 16 covered rapid occurrences
reconcile exactly and two are after the scheduled close. Three future-cycle
rapid reports are excluded. Six scheduled A and B count/money controls close.

Five items match unique current PAC names ($35,500). All 258 reports from the four
potential donor inventories were captured (139 scheduled, 46 rapid contributions,
and 73 later-section expenditure originals that the legacy parser misclassified);
native acquisition uses the actual section boundaries. Dated native header addresses
corroborate three items ($30,000). Two items ($5,500) remain unassigned. Current
registration PDFs alone and name-only matches do not resolve them.

## Late filings and reruns

Use the amended February 23 candidate calendar:
https://www.elections.virginia.gov/media/formswarehouse/campaign-finance/2026/AMENDED-2026-Candidate-Reporting-Deadlines-example.pdf
and PAC calendar:
https://www.elections.virginia.gov/media/formswarehouse/campaign-finance/2026/2026_PAC_Reporting_Deadlines.pdf.
November 3 candidates, including specials on the general-election date: October
26 through October 22; December 3 through November 26; January 15, 2027 through
December 31. Candidate rapid window October 23–November 2. PAC October 15 through
October 7 and January 15 through December 31, plus applicable rapid reports.
IE has its separate 24-hour rule under
https://law.lis.virginia.gov/vacode/title24.2/chapter9.3/section24.2-945.2/.
The calendar's old paper/fax IE footer does not describe the verified electronic
publication. ELECT updates nightly at 5:15 PM and 12:05 AM. Manually rerun whole
scope after publication October 27, November 3/5, December 4 and January 16/19,
2027, and for amendments. No automation is created.

## Proof and limits

Before PR: synthetic parser/identity/period/allocation/storage/failure tests,
backend typecheck, normal local write sync with default selection, independent
original-to-full-store reconciliation, production HTTP API and hydrated candidate
card. Keep legacy tables unchanged in the native proof. No financial identities,
selectors or original record text in committed tests or derived audit output.
No production, merge or deploy. Kansas donor names and all new Missouri
publication remain held. Applied migrations through 368 are immutable; Virginia
uses migration 369. Another local workflow advanced the ledger during research;
Virginia's file was renamed before application, with all prior entries preserved.
Finish this state and PR before taking another state. The latest continuation
resumes the broader goal; the previous state's pause boundary was already met.

## Local proof

The ordinary CLI's default write run selected two candidates and wrote four
components, with two PAC groups, three gifts and $30,000. Two PAC-name items
($5,500) remain unassigned. Both IE components are qualified zeroes within the
stated calendar-year publication scope. A second ordinary run had no native
work due. All three legacy tables remained identical; their independent live
acquisition failed under the proof's network guard without suppressing native
progress.

An independent parser reconciled all four stored components against their
genuine originals: 1,154 metadata bindings, every stored group, 50 disjoint
receiving items and 16 covered rapid occurrences. It also checked all 432 IE
parents and 1,154 candidate occurrences for each of the two IE components.
Actual production HTTP and the hydrated candidate page agree on both donor
rows, their amounts and the $30,000 total; the unresolved-item note is visible.
The existing UI hides an outside section with zero spending. No screenshot or
identity-bearing derived audit was saved. Source originals remain private and
ignored. The preview used explicit loopback API configuration and no environment
files or provider calls.

## Review fixes, October 21, 2026

A stored component is replayed as idempotent only when the new packet's
original manifest hash matches; equal oldest observation times are not enough,
because the oldest original is usually a reused saved roster or registry page
while newer report or inventory originals carry new money. Receipts and counted
IE allocations dated after the Virginia calendar day of their original's
observation hold the component (`future_at_original_observation`), as in New
Mexico. A native batch failure (unapplied migration, cache permissions, option
bounds) is recorded as `reportedError` and no longer stops the legacy sync. The
CLI loads the project environment unconditionally, like the other state scripts.

Initial PR CI found unrelated Mobile dependency drift: Expo's compatibility
check now expects `@expo/ui ~57.0.26`, `expo ~57.0.31` and
`expo-router ~57.0.29`. This PR changes no Mobile dependency or lock files.
Keep that dependency update separate from Virginia source acquisition.
