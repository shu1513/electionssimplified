# Minnesota finance gaps

## Before-code decision — October 15, 2026

Select Minnesota next: 383 linked candidates × provisional .80 readiness =
306.40. Fresh local read-only evidence has 391 active 2026 links/summaries,
397 outside groups across 119 links, and no direct committee-donor table.
Missouri's 283.05 and North Carolina's 241.20 estimates primarily describe
their donor increments; Georgia is 382 × .70 = 267.40, New Hampshire
447 × .35 = 156.45. These estimates do not certify source completeness or
close the full 56-source goal.

The [official bulk publication](https://register.cfb.mn.gov/reports-and-data/self-help/data-downloads/campaign-finance/)
provides all receipts, independent expenditures and IE-funder receipts from
2015 onward. A genuine ordinary refresh on October 15, 19:37:32–19:38:52 UTC,
retained three complete originals totaling 97,382,060 bytes. Their bytes and
hashes match the normal cache. Whole-source UTF-8 and the existing publisher
CSV dialect close 614,431 receipt rows/15 fields, 42,428 IE rows/19 fields and
7,549 IE-receipt rows/15 fields, with no width or unterminated-record errors.
Forty receipt quote escapes use the dialect already supported by the reader.

The native receipt class `Political Committee/Fund` is explicit and distinct
from candidate committees, party units, individuals and generic organizations.
The 2025–26 candidate/monetary/contribution scope has 3,718 such occurrences;
all have a reported donor registration number and positive amounts. This
supports reported committee cash contributions. It does not establish net cash
after later returns or require certification of legal donor identity. Preserve
source occurrence multiplicity; equal rows do not establish duplicate filings.

## Concrete gaps and sequence

1. Existing native IE acquisition is already called. Its amount parser rejects
   source-valid leading-dot decimals such as `.25`; the whole IE file contains
   610 such amounts, including twelve explicit zeros. First fix that finite
   amount format and verify the ordinary sync's actual allocated amount.
2. General receipts currently load only for missing-link name matching.
   Already-linked candidates normally receive an empty receipt buffer. Load
   direct receipts by due candidates' trusted recipient IDs independently of
   auto-linking. Verify complete saved schemas/bytes/hashes and retain actual
   acquisition times. A failed refresh must retain complete previous source
   material and stored components.
3. Add a dedicated typed cash contribution aggregate, component storage and
   transactional writer, then the production reader's existing interest card.
   Use the agency's reported class/name/account scope and an honest coverage
   note. Exclude in-kind, loans, miscellaneous income and other contributor
   classes. Do not infer PACs from the broad outside organization classifier.
4. Check reporting-year/receipt-date semantics and comparable financial summary
   controls. The wider source has 457 following-year receipt dates; current
   committee cash observations have dates within 2025–26. Do not equate the
   itemized publication with full Raised or describe gifts as net after later
   separately reported disbursements. Hold unresolved negative eligible rows.
5. Before a migration, inspect upstream files and the actual local ledger.
   Applied migration 343 belongs to Maryland PR 1584 and is immutable; never
   renumber it. PostgreSQL identifiers must stay within 63 bytes.
6. A real ordinary local refresh/sync, new stored-row counts and one candidate's
   figures, production reader/API and actual frontend card precede a Minnesota
   PR. Parser-only or preservation-only work is not completion. Missing or
   unqualified components preserve existing values and observation times.

Private originals and aggregate diagnostics remain outside Git. No environment
file is read, loaded, recopied or modified. State flags stay inline; AI calls
remain disabled. No production operation, deployment, merge or automation.

## Implementation checkpoint

The first amount-format correction passed all 109 Minnesota pipeline, CLI and
scheduler tests, including ordinary sync cases for `.25`, `$.25` and `0.25`.
Independent manual review found no other accepted-format change.

The ordinary producer now publishes three verified immutable originals through
one atomic manifest. Ordinary batches pin it once and read every byte through
EOF, checking UTF-8, native schema, widths, money/allocation fields for IE, bytes
and hashes before using filtered rows. V1 originals remain readable after full
qualification. Failed acquisition keeps the prior manifest/files; component
failure independently preserves stored cash, IE or IE-funder evidence.

Applied local migration 344 only after the normal runner verified it was the
sole pending file. Migration 343 remains reserved/applied for Maryland. Cash
groups and actual acquisition provenance are written in the existing protected
link transaction; omitted or held cash leaves all stored cash values/times alone.
Native blank/Unknown/Null contributor classes are counted as omitted, not
guessed into committees or used to suppress separately explicit committee gifts.

A second genuine ordinary refresh acquired four HTTP-200 responses October 15,
20:13:05–20:15:02 UTC, with 97,382,060 bulk bytes and the same whole-source row
counts. No fixture or edited acceptance manifest supplied the financial proof.
The ordinary 25-candidate due batch then dry-ran with all existing DB values and
times unchanged, followed by the real local writer: 25 source components and
186 donor groups, 204 gift occurrences totaling $314,790; three otherwise
eligible unknown-class rows omitted. Both runs made 50 normal official summary
requests with no warnings or candidate failures. This proves one ordinary batch
of 373 due candidates, not completion of every linked candidate's initial fill.

Amy Klobuchar's 2026 Governor/Lieutenant Governor component has 90 reported
groups, 100 occurrences and $264,290. The production reader and real Chrome
candidate page show that exact amount under “Committee cash by interest,” with
the named donor list collapsed. Raised remains the separate official-summary
$4,850,027.11; native outside totals are $82,203.25 support/$2,719,137.72 oppose.
No annual-summary equality is asserted: the official candidate form includes
cash, in-kind and nonitemized amounts in its broader committee/fund category.
Sources are acquisition observations, not certified report-through dates.

Validation before final review: all 16,741 backend tests passed (163 skipped),
all 1,230 frontend/shared tests passed, and backend/frontend/mobile TypeScript
checks passed. Focused tests also cover missing and corrupt sources, publication
failure retention, pinned generations, exact cents and occurrence multiplicity,
transaction rollback, source-only readers and honest card labels/empty states.

## Filing deadlines and fresh reruns

The [candidate calendar](https://cfb.mn.gov/pdf/calendars/2026_senate_house_district_court.pdf)
and [committee/fund calendar](https://cfb.mn.gov/pdf/calendars/2026_PCF.pdf)
set the pre-general deadline at October 26, covering through October 19.
Acquire complete new originals and run the ordinary sync October 27, then
check publication lag and late amendments. Check large contribution notices
daily October 20–November 2 and through November 4; bulk inclusion of those
notices is unverified and must not be claimed.

The year-end deadline is February 1, 2027; acquire/sync February 2 with an
extended election lookback and publication followup. February 2 is not the
filing deadline. These are required future reruns, not created automations.
