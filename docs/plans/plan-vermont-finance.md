# Vermont finance gaps

## October 12, 2026 source decision

Vermont publishes public JSON transactions and mass-media notices. The public
expenditure UI exposes candidate/measure, office/district, stance and allocated
amounts, but the observed child allocation request returned HTTP401. Ordinary
expenses and PAC transfers are not candidate independent expenditure authority.
The existing batch calls an aggregator that models PAC gifts to registrants,
`vt_pac_contribution_to_registrant`, rather than independently allocated IE.

The actual source protocol is lowercase sort and `electionID`. Resolve the
published election by exact date/type from its live lookup, not a hardcoded ID or
ignored year filter. General-scoped rows contain 2024–2026 dates; source election
context does not establish the financial period. Reject malformed physical money
rows and missing declared counts rather than silently dropping transactions.

Official source types distinguish TPAC, TIEPAC, TLLPAC, parties and businesses;
ITMY, INKIND and loans remain separate. A genuine September22 $5,180 TPAC/ITMY
REALTORS receipt to Phil Scott is a positive witness. Complete receiver/report
currentness, financial controls and signed returns remain prerequisites for net
PAC storage. No legal donor registry ID is inferred from a reported name.

Ranking before code: 11 active declared General links × .35 provisional fixability
= 3.85, ahead of Maryland2 × .55 = 1.10 in the remaining original priority cohort.
Other source rankings and the full 56-source goal remain in the master plan.

## Small steps and acceptance

1. Repair observed query casing/sort, live election lookup and strict financial
   row/count parsing. This step writes no money and grants no financial period or
   IE completeness authority.
2. Close the complete recipient cash/expense/report bracket, qualify actual
   report dates/versions/controls and returns, then wire typed PAC donor storage
   and the existing interest reader. Preserve failed components and their age.
3. Independently acquire actual public IE allocations with exact target, office,
   seat and stance. Missing acquisition preserves groups and unknown totals.
4. Run the normal local acquisition/write; prove rows and candidate numbers,
   production reader and actual frontend card before opening one Vermont PR.

## Filing deadlines and fresh reruns

- October15, through October12: fresh October16, retry19.
- October30 pre-General, through October27: October31, retry November2.
- November17, through November14: November18, retry20.
- December15 final/end-of-cycle: December16, retry18; use actual final covers.

Mass-media notices have a separate24-hour clock within45days and may repeat regular
report expenses. Reconcile source occurrence/channel identity; estimated costs or
multiple named candidates do not establish final allocated IE. Dates are a plan,
not scheduled automations.

Sources: [public system](https://campaignfinance.vermont.gov/),
[§2964](https://legislature.vermont.gov/statutes/section/17/061/02964),
[§2965](https://legislature.vermont.gov/statutes/section/17/061/02965),
[§2971](https://legislature.vermont.gov/statutes/section/17/061/02971).

## Actual acquisition proof, before financial writes

The production client resolved live General45 by November3/date/type. The first
name-scoped census returned867 contributions and271 expenses. All contributions
belonged to receiver33545; two same-name expenses belonged to a different account.
That receiver-uniqueness guard failed and its original source generation remains
unchanged. The corrected public query with the exact observed receiver GUID
returned269 expenses and zero foreign receiver rows. Names are discovery hints,
not financial ownership authority.

The public profile action returned15 physical/declared reports. Its exact stored
document action acquired all six regular PDFs:10 actual HTTP200 requests totaling
3,041,865 bytes including lookup, transactions and reports. Every original length
and SHA256 was replayed; all six PDF hashes matched the separate opening/closing
source research generation. Receipt controls total$414,475.24 across the six actual
periods December13/2024–September28/2026. Scott's one explicit TPAC/ITMY receipt is
$5,180. These are acquisition/control facts; production qualification and money
storage are still pending.

The separate public mass-media PDF names Scott and Amanda Janoo for Governor;
four payments total$252,826.90 and reconcile to its notice control. It prints no
stance or per-candidate allocation. No portion is assigned to either candidate.
Ordinary expense/control residual$400 remains separate from PAC cash authority.

Current checks:88 Vermont tests and backend typecheck pass. The exact-cent parser
rejects subcent money and unsafe decimal/number roundtrips in receipts, transaction
details and category totals. No Vermont migration, money write, frontend proof or
PR has been completed. The read-only baseline has22 links/22 summaries/157 direct
breakdowns/zero outside groups; preserve all unrelated components during the
eventual normal write.
