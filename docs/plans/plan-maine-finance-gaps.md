# Maine finance gaps

## Evidence before implementation

The October 12 read-only audit confirms 19 canonical eligible declared General
candidates with active links (Governor 1, Senate 8, House 10), 19 summaries and
104 direct breakdowns. The actual production reader returns 19 cards, no PAC
cards and no outside groups. All outside totals are stored July 21 zeros.
Craig Hickman's existing Raised is $9,430.37; Spent and Cash are unknown.
The conditional next-correction rank remains 19 × 0.65 = 12.35.

1. Maine publishes allocated IE in the officially linked replacement MapLight
   disclosure source. The published itemized dataset has whole transaction
   amount, target candidate, stance and per-candidate amount. The guide defines
   the snapshot as transactions present on a filed report at Last Updated.
   Separate paper filings and return/currentness semantics still require
   coverage checks; publication alone does not prove complete net spending.
2. The existing CFIS EXP path is already invoked by batch and sync. Its old
   host fails and its schema/IDs differ from MapLight. Legacy CON failure also
   blocks independently valid IE. A URL substitution or fake numeric/f_ID
   crosswalk cannot fix this. Modern acquisition must preserve direct fields
   and timestamps and reuse exact existing receiving-link ownership.
3. Legacy Committee Type identifies the recipient. Modern reported transaction
   contact types distinguish PAC, party and candidate committees. Direct PAC
   storage/display is absent. A source-typed reported donor name can be honest
   provenance without a fabricated legal registration ID. Complete accepted
   cash/returns must precede donor replacement.

## First baby step

Parse the actual modern 19-column IE CSV into source facts, with strict headers,
real dates, cents, transaction metadata consistency, duplicate allocation
identities and allocation sums. Retain signed values, actual reported names and
blank Candidate IDs; never infer IDs from names. Whole expenditure amount must
not be repeated for each beneficiary. Omit source contact/address fields from
stored facts and diagnostics.

The unchanged October 11 original has 1,306 allocation rows, 486 transactions,
134 transactions split across targets, and no duplicate allocation identities
or allocation-sum mismatches. It contains 133 blank Candidate IDs. Exact Craig
Hickman gross source rows show $134,101.94 support/$7,250 oppose; these are
source observations, not accepted net totals. Source return rows in a separate
all-filer export use positive lexemes and must not be counted as gifts.

The parser is a source primitive for the normal acquisition path. It must not
authorize a canonical write, infer current editions or complete cycle/channel
coverage, or substitute a known isolated gift for whole accepted source scope.
The next implementation decision follows the full export/return audit.

## Current source integration

The actual Rebuild Maine Q3 report resolves the $5,025 return: it is in
ordinary Returned Expenditures, with an explicit empty Returned Independent
Expenditures section. Its 38 IE transactions reconcile to $73,843.66. The
ordinary return must not be deducted from IE or allocated proportionately.
This classifies those joined source transactions; it does not establish a
latest-edition or full-cycle guarantee.

Current acquisition discovers the actual dataset attachment from the guide
and paged publisher catalog, verifies saved originals first, then checks
opening/closing selections around bounded downloads. The real ordinary
raw-refresh on October 12 captured both CSV bodies freshly: 29,739,015 bytes
for all filers and 379,864 bytes for IE. Their SHA-256 hashes agree with the
independent source originals. The 344 source and CLI tests and backend
typecheck passed before storage integration.

The modern batch is the ordinary default. Legacy replay is explicit. Modern
committee positions and allocated IE have separate source scopes, preserving
direct summaries/breakdowns and original receiving committee IDs. Official
SOS ballot context and whole-export own-filer uniqueness qualify candidates;
unknown offices, conflicting known names, ambiguous rows and unresolved
returns preserve the affected component. SS/SR legislative bindings are
established; the governor workbook GOV versus office-key GV discrepancy is
unresolved. The 2025 dataset remains unavailable in the observed catalog.

## Local monetary proof — October 12

Migration 338 was applied through the normal local migration runner, without
changing any applied migration. The ordinary default modern sync for Craig
Hickman persisted two reported committee positions/$600 and 25 allocated IE
rows: $134,101.94 support and $7,250 oppose. The actual production reader agrees.
All 19 existing summaries, 104 direct breakdowns, original receiving-link
business fields and verification timestamps match the prewrite audit. The link
updated_at changes when evidence is attached; direct freshness stays July 21.

The public Q3 report returned 403 to stateless Node requests while opening in
the browser. Chrome's HTML-only saved page was registered through
`registerMaineMapLightSavedReport`, preserving its actual browser-save interval,
byte count/SHA and `browser_dom` provenance. It does not claim a fresh HTTP
body/status. The ordinary `--resync` run used that verified saved original and
reconciled its financial sections against the complete publisher export.
The preceding fresh sync wrote the donor component and preserved outside data
when that report was unavailable; it did not write outside zeros.

The actual frontend `FinanceSummaryCard` was rendered from the real reader DTO.
It shows the outside groups, unchanged Raised and dated scope notes. Hickman's
$600 committee subset reaches `pac_money_by_interest`; the existing $5,000 PAC
panel threshold hides it on this witness's card. No global display threshold
was changed. Overall outside totals remain unknown, and 2025/paper/full-cycle
coverage is not asserted.

`--refresh` bypasses staleness and forces genuinely fresh source acquisition;
`--resync` bypasses only staleness while using the verified saved-first path.
The raw flag must remain inline for network acquisition. Report references
are exact observed public filer/filing routes, without private queries. A
saved source registration requires its original SHA/bytes/observation interval,
canonical public binding and successful financial-section parsing. Browser
sources are labeled explicitly and have no invented HTTP method/status.

## Verification and remaining scope

- Independently acquire current IE and donor source components through the
  ordinary batch/CLI, using saved originals and fresh source observations.
- Bind actual source targets to canonical election/name/office/seat/year and
  check the official general ballot, with ambiguity preservation.
- Use production writer/reader; retain existing direct totals/freshness and
  unavailable prior components. Partial source scope must not clear unrelated
  groups or turn unknown overall spending into zero.
- Actual ordinary local sync, persisted money/production reader and candidate
  card proof are complete for Hickman with AI disabled and flags inline.
- Run relevant checks and open one Maine-only PR after monetary proof. No PR
  from fixture parser output or a dry run; no production operation.

## Deadlines and genuinely fresh reruns

The official traditional candidate and PAC/state-party schedules list the
pre-general report due **October 23, 2026**, through **October 20**. Acquire
fresh source and rerun locally **October 24**. Qualifying IE over $1,000 per
candidate changes from two-calendar-day reporting to one day on October 21;
include fresh daily acquisition **October 22–November 5** if rapid coverage is
wired. A single election-day cache read cannot establish later filings.

Post-general is due **December 15**, through December 8: fresh **December 16**.
PAC annual is due **January 15, 2027**, through December 31: fresh **January 16**.
Use the explicit 2026 cohort/lookback after election day. Source audits must
retain actual acquisition/update times and latest accepted report periods.
The current modern ownership guard accepts declared General candidates.
Before a post-election rerun, audit changed candidate statuses and extend/test
eligibility deliberately if necessary; do not claim coverage from a zero-row
run. Governor qualification and missing 2025 coverage remain separate gaps.
No automation is included.

Sources: [Maine Ethics](https://www.maine.gov/ethics/),
[officially linked disclosure](https://www.mainecampaignfinancedisclosure.com/public),
[published dataset guide](https://maine-disclosure-system.refined.site/space/MESUPPORT/2763390977/Maine+Campaign+Finance+Datasets),
[traditional schedule](https://www.maine.gov/ethics/sites/ethics/files/inline-files/Updated%202026%20Filing%20Schedule%20Traditional-County.pdf),
[PAC/state-party schedule](https://www.maine.gov/ethics/sites/ethics/files/2026-09/UPDATED%20-%20PAC%20BQC%20State%20Party%20Committee%202026%20Filing%20Schedule%20-09.10.2026%20FINAL.pdf).
