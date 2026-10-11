# Florida finance gaps

Updated October 11, 2026. Separate Florida work starts from main after the
all-source analysis and ranking in
`~/.claude/tmp/voteapp-finance-gaps-2026-10/plan.md`. The local cohort has 437
active finance links for 338 candidates. Oregon PR #1569 remains separate.

## Source and wiring findings

Florida publishes independent expenditures through EFS. The public expenditure
export contains genuine IEC expenses, including $1,691,804.30 of 2025–26
Americans for Prosperity Action expenses. Its payer/payee/purpose fields do not
identify a beneficiary, support/opposition, or candidate-specific allocation.
The native account export adds reporting periods, not those missing fields.
Section 106.071 requires candidate particulars for applicable independent
expenditure reports; investigate the actual current public report/detail path
before treating its generic expenditure export as candidate money. The
campaign-document label “Independent Expenditure Statement” can identify a
DS-DE 7 party rebate affidavit and does not establish reported spending.

The existing scheduled batch explicitly disables outside finance. Its optional
resolver consumes trusted/manual support evidence or committee-name heuristics;
the outside contribution aggregator measures donations to groups, rather than
expenses allocated to candidates. Acquiring candidate contributions cannot
establish an outside-spending zero. Preserve existing outside rows and totals
when attribution or acquisition is unavailable.

The candidate contribution export has payment type, not contributor legal type.
The actual nine-column format has `CityStateZip`; the current parser discards
that field. The official committee registry exposes legal account/type/name,
with targeted searches including closed accounts. Active-only registry matching
misses historical and cross-type collisions. Retain the source legal type and
resolve identity before choosing a committee category; a PAC word or reported
occupation alone does not establish a registered PAC identity.

## Implementation order

1. Preserve the combined reported location without guessing how to split it.
   Test the real export shape, signed refunds, and identical occurrence counts.
2. Resolve the numeric receiving account against the actual candidate, general
   election year, office, and district. A synthetic local committee key or
   surname query cannot establish ownership. Build saved-page-first source
   acquisition with immutable raw bodies, hashes, request parameters, and real
   acquisition timestamps. Legacy cache metadata alone cannot prove completeness.
3. Treat a public processed report as a current snapshot only after validating
   complete current filing status, report identity, detail counts, native period
   totals, and the full native/generic financial occurrence multiset under stable
   before/after status brackets. Preserve duplicate occurrences. Do not replay
   ADD/UPD/DEL instructions from a processed export that does not contain them.
   Do not reject all amended reports merely because historical original files
   are unavailable; document the published-current contract and its limits.
4. Identify political committee donors from source registry evidence, including
   registration/disbandment dates and reported address when needed to resolve
   same-name accounts. Preserve genuine uncertainty rather than selecting an
   active account by default. Compute cash gifts and signed REF refunds by the
   verified legal donor. Tant's published $1,500 gifts and −$500 refund must net
   to $1,000. Exclude carryover, loans, in-kind, interest, and self-funding from
   PAC gifts. Do not change existing Raised semantics as an incidental step.
5. Add typed PAC donor storage, atomic writer integration, and the existing
   “PAC money by interest” reader, including “Not yet sorted.” Verify complete
   groups/counts before display caps. Preserve a prior accepted component when
   its new source cannot establish current money. Use a new migration number;
   applied Oregon migration 331 must not be renumbered or reused.
6. Wire candidate outside expenses only when a primary source provides the
   spender, full candidate identity/office/district/year, direction, amount,
   and allocation/version contract. Continue that investigation alongside PAC
   work. A PAC-only result leaves this gap open; it does not complete Florida
   or the overall source goal.
7. Run the ordinary local sync against fresh official data. Record before/after
   row counts, a candidate's donor amounts, stored provenance, and the ordinary
   ballot card before opening one factual Florida PR. No production changes or
   AI provider calls; feature flags stay inline, never in `.env`.

## Filing deadlines and required fresh reruns

Official 2026 calendars were fetched again on October 11. Filing dates use
Eastern time; reports are due at 11:59 p.m. A saved October 11 generation is not
a completed pre-election finance picture. Each rerun must acquire genuinely
fresh source data rather than replay an old cache.

| Filer | Report deadline | Fresh rerun |
| --- | --- | --- |
| Nonstatewide candidates | G5 October 23, covering October 3–16 | October 24 |
| Nonstatewide candidates | G6 October 30, covering October 17–29 | October 31 |
| Statewide candidates; PC/IXO | G4A October 16, covering October 3–9 | October 17 |
| Statewide candidates; PC/IXO | G5 October 23, covering October 10–16 | October 24 |
| Statewide candidates; PC/IXO | D1–D6 October 24–29 | Following mornings, for the supported daily path |
| Statewide candidates; PC/IXO | G6 October 30, covering October 17–29 | October 31 |
| Parties | G6 October 30, covering August 14–October 29 | October 31 |
| Applicable continuing filers | Q4 January 11, 2027, covering October 30–December 31 | January 12, 2027 |

Daily reports require previously unreported contributions; expenditures are
optional. Do not count the same expenditure again in G6. Party calendars do not
inherit PC daily deadlines. ECO electioneering reports have a distinct scope
and additional daily filings; do not turn them into independent expenditures.
Candidate termination/unopposed reporting requirements need their own applicable
calendar check. No recurring automation is requested or created.

Primary sources:
[IE instructions](https://dos.fl.gov/elections/candidates-committees/campaign-finance/filing-campaign-reports/campaign-reports-independent-expenditures/),
[106.071](https://www.flsenate.gov/Laws/Statutes/2026/0106.071),
[upload specification](https://dos.fl.gov/media/694088/dsde111.pdf),
[public database](https://dos.fl.gov/elections/candidates-committees/campaign-finance/campaign-finance-database/),
[nonstatewide calendar](https://dos.fl.gov/media/709876/2026-reporting-dates-other-than-statewide-candidates.pdf),
[statewide calendar](https://dos.fl.gov/media/709819/2026-reporting-dates-statewide-candidates.pdf),
[PC/IXO calendar](https://dos.fl.gov/media/709820/2026-reporting-dates-pc.pdf),
[party calendar](https://dos.fl.gov/media/709817/2026-reporting-dates-parties.pdf).

Detailed raw-source journals and financial reconciliation witnesses remain local
under `~/.claude/tmp/voteapp-finance-gaps-2026-10/`; no credentials or raw donor
address exports belong in Git.

## Completed source-row foundation

The parser now retains `City State Zip`/`CityStateZip` independently of optional
separate location columns. Florida's 97 existing/new tests and backend typecheck
pass. Replaying the untouched saved Botana public export retained all 107
reported combined locations. Its 15,286 source bytes and original SHA-256
`2bebd1baed2bd2dc81f35994ebb2c97d417ba42f679a07d0a109c27f9388d1dc`
match the acquisition journal. This is a saved-source parser check, not a fresh
financial acceptance or a normal sync money proof. No new PAC/outside rows have
been written and no Florida PR has been opened.
