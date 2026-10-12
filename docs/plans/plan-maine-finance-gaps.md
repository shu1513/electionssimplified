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

## Normal integration and real proof still required

- Independently acquire current IE and donor source components through the
  ordinary batch/CLI, using saved originals and fresh source observations.
- Bind actual source targets to canonical election/name/office/seat/year and
  check the official general ballot, with ambiguity preservation.
- Use production writer/reader; retain existing direct totals/freshness and
  unavailable prior components. Partial source scope must not clear unrelated
  groups or turn unknown overall spending into zero.
- Run an actual ordinary local sync with AI disabled and flags inline; verify
  persisted row counts/money and render an actual candidate finance card.
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
No automation is included.

Sources: [Maine Ethics](https://www.maine.gov/ethics/),
[officially linked disclosure](https://www.mainecampaignfinancedisclosure.com/public),
[published dataset guide](https://maine-disclosure-system.refined.site/space/MESUPPORT/2763390977/Maine+Campaign+Finance+Datasets),
[traditional schedule](https://www.maine.gov/ethics/sites/ethics/files/inline-files/Updated%202026%20Filing%20Schedule%20Traditional-County.pdf),
[PAC/state-party schedule](https://www.maine.gov/ethics/sites/ethics/files/2026-09/UPDATED%20-%20PAC%20BQC%20State%20Party%20Committee%202026%20Filing%20Schedule%20-09.10.2026%20FINAL.pdf).
