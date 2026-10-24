# Wisconsin reported finance gaps

Status: implementation in progress. Source transport is verified; ordinary finance sync, API/card verification and PR remain pending. New Wisconsin publication remains disabled pending Ethics Commission/counsel clearance. Kansas contributor names and all new Missouri publication remain held.

## Source and existing path

1. Wisconsin publishes reports, transactions and registrants through [Sunshine](https://campaignfinance.wi.gov/browse-data), introduced in 2025 and covering activity since July 2008. Current public tRPC reads provide independent expenditure categories, related entities, support/opposition, offices, districts, submitted report references and native source counts. Native transaction CSV exports are also available. A legal reporting requirement alone does not establish usable candidate allocation.
2. Existing Wisconsin auto-link, due selection, sync, writer and ballot loader are wired. All 16 existing 2026 links in the local selection audit are primary contexts; supported general-election eligibility has 239 current candidate contexts. Zero general links is not absence of an actionable cohort. The legacy client sends offsets, while the current source requires cursors; transaction cursor dates require SuperJSON Date metadata. Direct and outside reads share a failure boundary, and outside display limits enter monetary aggregation. These need independent qualification and preservation gates.
3. Receiving data identifies individual, business and registrant entities. Generic registrant/business types alone do not prove a PAC. Exact native registry classes supply stronger committee evidence. Pennsylvania's explicit reported-name rule can supply a narrower tier for a source committee entity explicitly named as a PAC; this does not assert registration or legal identity.

## Priority

The cross-source completion audit found 56 modules, excluding the shared efileCal helper, and 45 modules with current linked general contexts. Delivered PRs are not evidence that every source's IE is qualified. Wisconsin is the next zero-current-link module requiring canonical eligibility review. Its literal linked-candidate score is zero; 239 eligible general contexts × an estimated .85 opportunity is 203.15, a conditional planning estimate rather than a linked count or measured success rate.

## Qualified receiving control

Private controls bind one receiver through its sole candidate-role connection, native office and exact general-election date to a unique canonical context. Canonical surname discovery works without a legacy finance link. Native registry counts and empty cursor terminals close. The complete current transaction ledger reconciles to all in-scope certified submissions, including a filed no-activity report.

Keep real source rows, identities, selectors and monetary proof private while publication is held. The supported cash scope recognizes exact native PAC, party and candidate-committee classes, plus a separate conservative tier for a source committee entity explicitly naming a PAC whose native public profile says Unregistered. Preserve that distinction. Exclude in-kind gifts, loans and other income; subtract returned contributions from qualifying source recipient entities, including refund-only recipients. This is reported committee cash, not a legal PAC census or complete multi-year campaign money.

Generic report-template bounds can overlap across schedule variants. Validate coverage as a date union and reconcile report memberships against globally unique native transaction IDs. Count each native transaction once; never add overlapping window totals or deduplicate distinct gifts by matching names, dates and amounts. Unsupported amendments and notice/regular-report overlap remain held. Regular reports currently end September 23, 2026, followed by later 72-hour notices; post-deadline reacquisition remains necessary.

## IE qualification still open

One fresh registry-qualified spender's full native ledger, CSV and report inventory are privately acquired. Paid occurrences with incomplete allocation fields, incurred-payment linkage, refunds and amendments still need qualification. Genuine filed PDFs have also been inspected privately. No new IE amount is accepted from a positive subset, and no zero is inferred. Continue the single-filer source pass before another filer. IE acquisition must operate independently of receiving finance; an unresolved source preserves prior amounts and source clocks.

## Implementation and proof gates

First add a saved-first public-source reader with private whole originals, real download clocks, whole-body integrity, typed native cursors, independent counts, explicit empty terminals and two matching complete scans. Refresh does not grant network permission. Reject private procedures, partial reads, duplicate IDs, drifting records and stale/future cache clocks.

Then wire a separately due reported-cash component with protected atomic writes, independent attempt/source clocks, candidate/year CLI targeting and a publication gate defaulting off. New IE money requires its own qualified source contract. Applied migrations are immutable; allocate a new migration only after fresh ledger/schema preflight. No environment files, provider calls, production operations, merges or deployment.

Before PR: ordinary real local sync, uncapped independent source/store reference, actual production HTTP API and hydrated candidate route. Verify disabled-publication behavior, idempotence and missing-source preservation. Current completed checks include source-contract tests, backend type-check, a real saved-first complete-ledger replay, a source-minted immutable cash packet, and independent uncapped source references. All real-data proof remains private. These checks are not the ordinary finance sync or card proof.

## Deadlines and reruns

The [official reporting calendar](https://ethics.wi.gov/Pages/CampaignFinance/ReportPeriods.aspx) lists the fall pre-election deadline as **October 26, 2026**, with Schedule B coverage September 24–October 19. January Continuing is **January 15, 2027**, covering October 20–December 31. Reacquire and rerun October 27/28, November 4/6, January 16/19, and after later amendments. No automation is scheduled. Qualify additional entity-class or special-election schedules before expanding scope.

The Commission's [72-hour reporting memorandum](https://ethics.wi.gov/Resources/New%2072-Hour%20Reporting%20Requirement%20Changes.docx.pdf) describes the aggregate express-advocacy trigger and incurred/dissemination/disbursement timing. Avoid counting an obligation and its payment, or a notice and its regular-report inclusion, as separate economic spending.

Sunshine displays the commercial-use restriction under Wis. Stat. § 11.1304(12). The human confirmed no clearance: code and private local proof only. Force-refresh cannot bypass publication holds.
