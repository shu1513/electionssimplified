# Alaska native campaign-finance components

## Source findings before application changes

The current eligible linked cohort has ten State House candidates. Alaska is the next actionable source after New Mexico; Indiana, Colorado and Utah retain separate documented source-format holds. Kansas donor names and all new Missouri publication remain held.

1. **Independent expenditures are published.** [APOC's electronic IE search](https://aws.state.ak.us/ApocReports/IndependentExpenditures/IEExpenditures.aspx) exposes economic filer, target kind, candidate choice, stance, payment method, signed amount and a native report link. Its default current-report population closes against [IE parent reports](https://aws.state.ak.us/ApocReports/IndependentExpenditures/IEForms.aspx): 1,281 expense rows plus 274 debt rows, across 249 current reports. The combined transaction export omits the target-kind column and mixes expenses with debts. A candidate choice explicitly uses `YYYY - Name`; report year alone is insufficient. All-year candidate searches establish the actual filing-year scope instead of assuming two calendar years. The paper archive is separately observed; its 102 indexed filings are dated 2008–2011. The new paid-expense metric covers qualified electronic reports and states that scope.
2. **Existing IE code is called, but acquisition depends on direct finance.** The legacy client loads income first; the CLI defaults to CSV and dry-run, with IE files optional. A failed income acquisition prevents outside acquisition. Existing outside rows demonstrate that the writer and reader already work. New native components must run independently of the legacy data loader and of each other, preserve old money on failure, and retain their own attempt and source-observation clocks.
3. **Income has no proved contributor class.** Recipient filer type is not donor type. Complete all-year registration histories provide 4,479 group records across PAC, party, IE, special-interest, ballot, initiative and controlled classes, plus 441 non-group entity records. PAC-name classification requires an exact reported name, matching published postal address, a prior PAC registration, and no contradictory registered class. Other organization names, parties, candidate transfers, bank income and ambiguous funding stay outside this metric; no name-word heuristic or AI classification.

The complete native receiving families expose an additional acquisition defect: nine uniquely registered candidates have 99 current reports across filing years. All 99 itemized income sums match their native parent summaries. Their 42 reports for the 2026 state cycle contain 2,047 itemized rows; the complete transaction exports omit five of them, including a qualifying PAC-name receipt. The raw exports remain unchanged. Native report forms, not repaired exports, are receipt authority. One linked candidate lacks a matching current registration and must remain held for this component.

The [official general-election roster](https://www.elections.alaska.gov/candidates/?election=26genr) independently confirms all ten current names and House districts. The APOC registrations' Primary labels remain Primary; general-election participation is established separately. No guessed relinking or registration is allowed.

## Metrics and implementation

- Add separately gated, default-off native committee and IE components. Use the ordinary due cohort, 25-candidate limit and seven-day staleness. Recheck canonical identity, office, seat, election and exclusive ownership under lock before atomic writes.
- This implementation qualifies State House receivers and targets. Other offices remain held for native components until their official roster/seat context is implemented; their legacy finance is preserved.
- Use complete native report families for itemized PAC-name income. Read every included and excluded row, preserve occurrences and filed signs, reject ambiguous cross-report duplicates or loan classification, and disclose that separately reported expenditure-side returns are not deducted. Registry matches are reported-name evidence, not an assertion about legal entity identity or interests.
- Attribute IE only from the native candidate choice, explicit election context and stance. Use the economic `Filer`, never the submitter `Filer Name`. Verify each parent's complete expense/debt counts and signed cents; exclude debt obligations from paid expenses. Ambiguous targets or allocations hold the affected component. Never infer an allocation from payee or description text.
- Read verified saved originals before fetching report forms. Preserve unchanged bodies, actual requests, status, EOF, MIME, length, SHA and observation clocks. An incomplete export never becomes zero. A complete all-result response containing only explicit other target years can establish an empty current-cycle scope without relying on a failed supplementary read.
- Keep component money, provenance and clocks separate from legacy summaries. Validate the full stored groups and totals before display caps; clear incompatible legacy breakdowns when a native component supplies their replacement. No raw originals, identities, selectors or real-data fixtures in the PR.
- Use a new migration above the locally applied 366; applied migrations 365 and 366 remain immutable even while their PRs are unmerged.

## Deadlines and required reruns

Verified official originals: [candidate calendar](https://apoc.doa.alaska.gov/media/2n5ngaqg/2026-primarygeneral-candidate-calendar.pdf), [group calendar](https://apoc.doa.alaska.gov/media/gmhk2rxy/2026-primarygeneral-group-calendar.pdf).

- General 30-day reports: October 5, 2026; candidate period August 9–October 2, group period February 2–October 2.
- General seven-day reports: October 27; period October 3–24. Reselect the whole cycle and refresh October 28/29.
- Late contributions: October 25–November 2, with applicable 24-hour reporting. Refresh through November 4.
- IE Form 15-6: ten days after expenditure, except qualifying expenditures over $250 within nine days of the election require 24-hour reporting. Refresh November 13/16 for the ordinary lag.
- Candidate final/group year-end reports: February 16, 2027; period October 25–February 1. Refresh February 17/19 and after amendments. Keep general-election losers eligible for at least 112 days; 98 days misses this deadline.

Upstream IE-group receipts and true-source disclosures are not candidate receipts or candidate expense allocations. These are manual rerun checkpoints, not scheduled automations.

## Required proof before PR

Synthetic counterexamples for identity, source scope, malformed/partial data, amendment/current-report membership, signed cents, expense/debt separation, registry ambiguity, duplicates, independent failures, feature gates and stored-reader closure. Then run the ordinary local write command without candidate/year/fixture/amount overrides, independently reconcile the complete originals and store, verify actual production HTTP output and a hydrated candidate card, and open one Alaska-only PR with exact-head CI. No production, deployment, merge, provider calls, environment-file access or donor publication in the held states.

## Local validation

The ordinary `alaska-candidates:finance:sync-due -- --write` path ran with inline global/state/sync gates and `ALASKA_REPORTED_COMMITTEE_ENABLED=true`, `ALASKA_REPORTED_IE_ENABLED=true`. Raw refresh was off; the default ignored cache held genuine unchanged source observations. No candidate, year, fixture or amount override. An explicit local database connection avoids environment-file loading. Both CLI and scheduler defer legacy acquisition until after native work; unavailable legacy income does not block native IE.

Ten receivers produced 19 components and 14 groups: nine committee components, ten IE components; one missing receiving registration held. Three PAC-name income entries total $3,000.00. Forty-five paid IE entries total $223,742.53; twelve targeted debts are excluded. A repeat normal run selected no due components. All five legacy tables remained identical in memory.

An independent parser read all 99 receiving originals and 4,659 itemized rows (2,047 current-cycle rows), plus all 1,555 IE source rows. Every one of 249 IE parents closed separate paid/debt counts and signed money. All uncapped stored names, cents, counts, canonical/native contexts, original metadata and actual clocks matched the independent reference. Provenance hashing survives JSONB object-key reordering.

The actual production HTTP API returned matching data. The hydrated candidate card matched all four displayed outside groups, formatted amounts, full support total and coverage note. Verified PAC receipts are below the existing $5,000 per-candidate presentation threshold, so that section correctly remains hidden; positive data remains available in the API. No UI threshold or amount was overridden.

Fresh raw acquisition requires `ALASKA_REPORTED_RAW_REFRESH_ENABLED=true`. Saved report forms are checked before fetching. The election site's Node certificate chain failed locally; genuine normally verified browser/macOS captures qualified the saved roster. An unavailable or stale roster holds publication rather than bypassing TLS or inventing a zero.
