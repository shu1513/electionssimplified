# Wisconsin reported finance gaps

Status: implementation in progress. Source transport is verified; ordinary finance sync, API/card verification and PR remain pending. New Wisconsin publication remains disabled pending Ethics Commission/counsel clearance. Kansas contributor names and all new Missouri publication remain held.

## Source and existing path

1. Wisconsin publishes reports, transactions and registrants through [Sunshine](https://campaignfinance.wi.gov/browse-data), introduced in 2025 and covering activity since July 2008. Current public tRPC reads provide independent expenditure categories, related entities, support/opposition, offices, districts, submitted report references and native source counts. Native transaction CSV exports are also available. A legal reporting requirement alone does not establish usable candidate allocation.
2. Existing Wisconsin auto-link, due selection, sync, writer and ballot loader are wired. All 16 existing 2026 links in the local selection audit are primary contexts; supported general-election eligibility has 239 current candidate contexts. Zero general links is not absence of an actionable cohort. The legacy client sends offsets, while the current source requires cursors; transaction cursor dates require SuperJSON Date metadata. Direct and outside reads share a failure boundary, and outside display limits enter monetary aggregation. These need independent qualification and preservation gates.
3. Receiving data identifies individual, business and registrant entities. Generic registrant/business types alone do not prove a PAC. Exact native registry classes supply stronger committee evidence. Pennsylvania's explicit reported-name rule can supply a narrower tier for a source committee entity explicitly named as a PAC; this does not assert registration or legal identity.

## Priority

The cross-source completion audit found 56 modules, excluding the shared efileCal helper, and 45 modules with current linked general contexts. Delivered PRs are not evidence that every source's IE is qualified. Wisconsin is the next zero-current-link module requiring canonical eligibility review. Its literal linked-candidate score is zero; 239 eligible general contexts × an estimated .85 opportunity is 203.15, a conditional planning estimate rather than a linked count or measured success rate.

## Qualified receiving control

One current receiver is bound through its sole candidate-role connection, native office and exact general-election date to a unique canonical context. Native registry counts and empty cursor terminal close. The complete report inventory has 14 certified submissions. Two full transaction scans agree on 745 unique rows, reconciling exactly to six selected parent submission counts and coverage periods.

The independently checked reported-committee cash scope contains nine groups, ten monetary gifts and $27,195. Eight groups have exact native registry identities and committee classes; one additional source committee entity explicitly names a PAC and has a public profile marked Unregistered. Preserve that evidence distinction. Exclude in-kind gifts, loans and other income; subtract returned contributions from qualifying source recipient entities. This is reported committee cash, not all PAC money or a legal PAC census. No financial rows or record selectors belong in this plan, tests or PR text.

Regular reporting coverage begins January 1, 2025 and runs through September 23, 2026, with a later 72-hour notice containing October 21 activity. Four unavailable legacy templates are 2024 only and cover no selected transaction. Current selected receiving parents each have one submission. Future amendments must be qualified or held.

## IE qualification still open

One fresh registry-qualified outside spender has two identical complete scans of 1,343 transactions. Of 99 paid IE occurrences, six name the verified current Treasurer target, totaling $277.27. Eight paid occurrences have incomplete allocation fields, including two payments of incurred IE. Their original incurred obligations carry allocation fields, but neither the public grid nor the independently closed 61-column native CSV exposes the payment-to-obligation identifier. The source inventory has 70 reports and 73 submissions, including amendments. Six relevant genuine filed PDFs have been acquired and fully text-read privately; allocation, refund and current-version verification remains unfinished.

Do not publish this positive subset as complete IE or infer zero. Continue the single-filer qualification before another filer. IE acquisition must operate independently of receiving finance; an unresolved source must preserve prior amounts and source clocks.

## Implementation and proof gates

First add a saved-first public-source reader with private whole originals, real download clocks, whole-body integrity, typed native cursors, independent counts, explicit empty terminals and two matching complete scans. Refresh does not grant network permission. Reject private procedures, partial reads, duplicate IDs, drifting records and stale/future cache clocks.

Then wire a separately due reported-cash component with protected atomic writes, independent attempt/source clocks, candidate/year CLI targeting and a publication gate defaulting off. New IE money requires its own qualified source contract. Applied migrations are immutable; allocate a new migration only after fresh ledger/schema preflight. No environment files, provider calls, production operations, merges or deployment.

Before PR: ordinary real local sync, uncapped independent source/store reference, actual production HTTP API and hydrated candidate route. Verify disabled-publication behavior, idempotence and missing-source preservation. Current completed checks: 16 source-contract tests, backend type-check, and a real saved-first replay of all 745 receiver rows with zero network calls. This replay is not the finance sync or card proof.

## Deadlines and reruns

The [official reporting calendar](https://ethics.wi.gov/Pages/CampaignFinance/ReportPeriods.aspx) lists the fall pre-election deadline as **October 26, 2026**, with Schedule B coverage September 24–October 19. January Continuing is **January 15, 2027**, covering October 20–December 31. Reacquire and rerun October 27/28, November 4/6, January 16/19, and after later amendments. No automation is scheduled. Qualify additional entity-class or special-election schedules before expanding scope.

The Commission's [72-hour reporting memorandum](https://ethics.wi.gov/Resources/New%2072-Hour%20Reporting%20Requirement%20Changes.docx.pdf) describes the aggregate express-advocacy trigger and incurred/dissemination/disbursement timing. Avoid counting an obligation and its payment, or a notice and its regular-report inclusion, as separate economic spending.

Sunshine displays the commercial-use restriction under Wis. Stat. § 11.1304(12). The human confirmed no clearance: code and private local proof only. Force-refresh cannot bypass publication holds.
