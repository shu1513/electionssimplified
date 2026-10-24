# Rhode Island reported finance gaps

Status: receiving source qualified privately; ordinary acquisition/sync, card proof and PR remain pending. Wisconsin publication, Kansas contributor names and all new Missouri publication remain held.

## Source, current code and donor types

Rhode Island publishes candidate independent expenditures and other covered disbursements through CF-8 filings, indexed by ERTS and available as scanned PDFs. The current [2026 CF-8 guide and campaign manual](https://elections.ri.gov/campaign-finance/manuals) distinguish independent expenditures, electioneering communications and covered transfers. A legal reporting requirement does not establish candidate allocation. Qualify amendments, incurred/payment links, refunds and multi-target allocation before accepting outside money.

The current module has a WebForms client, artifact acquisition/cache, report/version parsers, a CF-2 selector, receiving aggregator, resolver/auto-link, writer wrapper and ballot loader. It exposes probe/raw-refresh commands. The consolidation plan deliberately describes Rhode Island as import-style; absence of a batch runner alone is not a defect. Reuse existing contracts and add the smallest scoped import/sync path that fits. Outside source acquisition must remain independent of receiving finance.

Native receiving exports explicitly distinguish PAC and Party cash from their aggregate, in-kind and loan categories. Recognize typed itemized cash without generic-name inference, distinguish unnamed aggregates from named donors, and qualify signed returns before claiming net positions. Source records and uncapped proof remain private.

## Priority and receiving evidence

A canonical audit using the actual production eligibility predicates found an actionable general-election cohort despite zero current general finance links. The same audit included special/runoff stages, so it did not dismiss city cohorts whose general-only count was zero. Rhode Island ranks first among the remaining untouched supported cohorts; conditional fixability estimates remain planning assumptions.

One receiving unit is tied to the current official general ballot and a sole active native registration. Historical registration subject-name/office fields corroborate the continuing account; they do not assert a new registration year. Two complete current-cycle exports agree, every row falls in exactly one current certified CF-2 period, latest versions are stable, and an independent Python/Decimal reference reconciles cash receipts, typed donor/in-kind lines and cash carry-forwards. The complete filed inventory remains unchanged before and after acquisition. Later unfiled reports are retained as pending, never converted to zero.

The first concrete acquisition gap is a filing-list parser that rejects genuine CF-1 registration rows with blank periods. Preserve only the verified registration titles and source form identity, including a recognized unfiled registration with no source link. Keep malformed/unknown financial periods rejected. The existing CF-2 selector then excludes registration records by form type. No dates or financial zeros are invented.

## Proof and implementation gates

Make source-specific changes in small tested steps. Use the ordinary committed acquisition script/default clients after the parser checkpoint; custom research replay is not sync proof. Before any financial write, run actual schema/ledger preflight, keep applied migrations immutable and identifiers at most 63 characters. Before PR, complete a real scoped local import/sync, independent uncapped source/store comparison, production HTTP API and hydrated candidate route. Verify missing-source preservation and idempotence. Preserve the existing small-amount display policy; use a separate fully researched receiving control if the initial valid committee detail is below that threshold. No environment files, provider calls, production operations, merge or deployment.

## Reporting deadlines and manual reruns

The [updated official reporting schedule](https://elections.ri.gov/sites/g/files/xkgbur756/files/2026-04/2026%20Primary%20and%20Election%20Reporting%20Schedule_(Updated).pdf) gives **October 27, 2026** for the pre-election report covering October 6–26. The post-election report is due **December 1, 2026**, covering October 27–November 30. Q4 is due **February 1, 2027**, covering December 1–31. Use actual certified periods and the updated calendar rather than older primary-date flyers.

Manually reacquire/rerun October 28/29, November 4/6, December 2/4, February 2/4 and after later amendments/late CF-8 filings. Outside-report timing must be checked against the current guide separately. No automation is scheduled.
