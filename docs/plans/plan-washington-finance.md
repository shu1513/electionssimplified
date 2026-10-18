# Washington reported PAC receipts

## Source and gap

PDC publishes current [contributions](https://data.wa.gov/d/kv7h-kjye), [campaign summaries](https://data.wa.gov/d/3h9x-7bvm), and [C6 independent expenditures/electioneering communications](https://data.wa.gov/d/67cp-h962) as paged Socrata JSON. The publisher excludes superseded amended reports from the transaction views. Contributions have a native `code` whose live value `Political Action Committee` identifies reported PAC contributions. `Organization` alone also includes businesses, unions, parties, caucuses, and other entities; it is insufficient PAC evidence.

The existing Washington batch already calls the C6 client with both candidate filer and committee IDs. Preserve that exact identity. The missing direct PAC component cannot depend on legacy summary freshness: current local evidence has 246 eligible candidates but zero due legacy summaries. Fresh canonical active eligibility is 274 unique candidates across 492 links; the provisional priority score is 274 × .75 = 205.50, ahead of the remaining Idaho/Ohio estimates.

Live contribution origins include C3 cash, B.1 in-kind, AU auction receipts, and C.1 signed adjustments. Apply the signed adjustments when grouping receipts. The published dataset can include unpaid loans and excludes separately reported expenditures/refunds; do not describe the resulting figure as loan-free or net of all refunds. Group by reported PAC name without claiming a resolved legal committee identity. Party, caucus, union, business, and individual classes remain outside this component.

## Implementation sequence

1. Add complete native PAC-source acquisition and immutable private original-byte cache replay. Bind the receiving filer/committee/year to the official summary, require complete counts/pages and stable closing receipts/context, and validate native classes, occurrence identities, decimal cents, and corrections. Use saved qualified originals first; a failed refresh preserves prior money and observation dates.
2. Store uncapped source totals/groups and independent scheduling attempts in state-specific tables. Write sources/groups atomically after locking and rechecking canonical eligibility and receiving context. Reject stale or conflicting equal-clock inputs. Do not modify applied migrations.
3. Add an independent default-25 ordinary sync and CLI with separate default-off PAC-publication/raw-refresh gates under the Washington master. Missing components and their own source clocks determine due work. Rotate held contexts fairly. Never load `.env` or pass candidate IDs/known amounts as job selectors.
4. Attach validated PAC groups through the production finance loader and existing committee-interest card. Validate full totals before display limits, retain “Not yet sorted,” and display component scope/date separately from unchanged legacy fundraising and IE clocks.

Incomplete, unstable, mismatched, mini-reporting/no-report, or contradictory negative-net sources remain unavailable. Do not turn them into zeros or discard their adjustments. A complete qualified empty PAC scope can establish a scoped zero.

The independent CLI is `npm run washington-reported-pac:sync-due` from `backend/`. It reads runtime configuration without loading `.env`. Set `WASHINGTON_CAMPAIGN_FINANCE_ENABLED=true` and `WASHINGTON_REPORTED_PAC_RECEIPTS_ENABLED=true` inline for local work; fresh acquisition additionally requires `WASHINGTON_PDC_RAW_DATA_REFRESH_ENABLED=true`. All three default off. `--refresh` bypasses component/attempt freshness, while canonical eligibility remains required. Use `--election-lookback-days` for the later reporting passes. Failed acquisition preserves the qualified cache pointer, stored financial rows and original observation dates; attempts rotate separately.

## Reporting dates and fresh reruns

The official [2026 calendar](https://www.pdc.wa.gov/registration-reporting/candidates-committees/registration-reporting-basics/key-dates-2026) gives October 13 C4 reporting through October 12 and October 27 reporting through October 26. Weekly C3 reports continue through November 2; special reporting runs October 13–November 2. Post-general C4 is due December 10 through November 30, and end-cycle reporting January 11, 2027 through December 31.

Run fresh acquisition plus ordinary sync now after the October 13 deadline, then October 28, November 3 and 5, December 11, and January 12, 2027. Extend the election lookback for later passes and check late/amended publication. The [IE rules](https://www.pdc.wa.gov/registration-reporting/independent-expenditures/when-report) distinguish ordinary C6, expedited reporting, electioneering communications, and committee C4 reporting; C6 is not automatically exhaustive outside-spending coverage. These are planned operational reruns, not automations.

PDC's source metadata carries a commercial-use restriction concerning lists of individuals. New work is limited to reported organizational PAC groups, remains default off, and requires release review before activation. No clearance is inferred from this implementation. Kansas donor-name and all new Missouri-publication holds remain in force.

## Required proof before PR

Run focused source/cache/aggregation/writer/scheduling/reader tests and backend typecheck. Perform a genuine ordinary local legacy IE refresh and new PAC sync, verify complete canonical totals/groups/source clocks and legacy preservation, then verify the actual production API and a real frontend candidate card. Keep proof artifacts private and aggregate-only. Open one Washington-only PR; no production writes, merge, or deployment.

## Verified local result — October 17, 2026 (October 18 UTC)

- 116 Washington tests passed across 12 files; backend typecheck passed. Tests cover original-byte replay, query/byte tampering, native classes, signed corrections, exact integer cents, canonical person/office/candidacy checks, transaction rollback, stale/equal-clock conflicts, independent scheduling and failed-refresh preservation.
- The genuine ordinary legacy batch refreshed five receivers with zero failures. Eight spender groups reconciled to the source-backed headline amounts; one example has $150,251.69 support across three groups. An earlier successful local legacy run stopped at a proof assertion that mishandled SoQL whitespace; its original audit remains retained separately.
- The independent ordinary default-25 batch selected 25 of 246 eligible missing components, acquired 25 fresh official sources, and wrote 25 sources/465 groups from 621 native PAC occurrences. Total corrected receipts: $568,218.28 ($571,118.28 positive entries and $2,900 signed negative adjustments), across 18 positive receivers and seven qualified empty scopes. The remaining due count is 221. No identity, amount, year, source-row or financial-result override selected the job.
- All 200 PAC capture records matched independently observed native response bodies; the complete run retained 234 genuine official responses. Every canonical uncapped group, total, count and source clock matched saved-original replay. All five legacy Washington tables, full rows and clocks, and the migration ledger stayed unchanged during the PAC-only step. Migration 351 was applied locally with prior migration checksums unchanged.
- Actual production API GETs and real React Router candidate profiles passed. The PAC example shows $106,950 across 91 reported groups and two interests, including “Not yet sorted,” with correction/refund scope and the actual October 18 UTC observation date. Named PAC details stayed closed. A separate real IE card shows $150,252, the existing formatter's rounding of $150,251.69, with the C6/C4 coverage note. Legacy fundraising, IE fields and headline clocks were preserved.

All proof artifacts remain private and aggregate-only. New gates remain default off; this is local verification, not release activation. Reporting reruns above remain necessary.
