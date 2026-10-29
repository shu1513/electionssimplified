# Michigan outside spending: shared pre-election statement labels

Michigan publishes independent expenditures through MiTN's complete XLSX exports and public filing histories. The batch sync already acquires these sources. Committee donors are recognized through the filer registry and feed the existing PAC interest card.

The October 28 post-deadline source check found primary and general campaign statements both named `Pre-Election CS`. One amendment explicitly references the general statement, while another original covers the primary. Treating the statement name as a unique coverage period unnecessarily holds statewide outside-spending acquisition.

Permit this case only with one amendment, one explicitly referenced original, matching amendment coverage, pairwise disjoint original campaign-statement coverage, and identical nonempty full/amended economic record sets. Compare every exported field except filing status, statement year and statement name, using the existing expense identity rules. Changed, deleted, added or retargeted expenses, multiple amendments, unresolved references and overlapping coverage remain held. Direct receipt version selection is unchanged.

Before implementation, all 264 real responses and 87 complete filing histories were independently verified. Three native filing PDFs were read in RAM, with complete page numbering, exact expense-ID/money joins and schedule reconciliation. Independent comparison found 14 full-export occurrences and seven amended occurrences representing the same seven eligible economic records. Source originals remain private; tests use synthetic data.

Validation requires focused regressions, the Michigan suite and backend typecheck, followed by a real normal local sync, independent uncapped source/store checks, ordinary API and hydrated candidate-card/reload proof before a Michigan-only PR. Publication holds for Kansas contributor names, new Missouri and Wisconsin data, and Phoenix reviewed-EFD data remain in effect.

The official [Michigan reporting calendar](https://www.michigan.gov/sos/elections/disclosure/cfr) sets candidate pre-general reports due October 23, 2026, through October 18; independent/PAC reports are due October 26 through October 20. The October 28 acquisition and money verification below are after both deadlines. Check late reports again November 4/6. Post-general reports are due December 3 through November 23; rerun December 4/7. Do not count a dry-run or a future planned check as a completed money refresh.

## Completed local verification, October 28

All 324 Michigan tests passed, as did backend typecheck. The normal existing-link batch selected 50 contexts: 19 updated and 31 held for unresolved receipt versions, dates or filing metadata. All held contexts without a successful sibling retained every financial row and clock; the migration ledger was unchanged. Fresh acquisition captured 465 successful whole responses. Outside acquisition succeeded without source errors, and all donor registry lookups succeeded.

An independent XML/HTML reader verified the whole source corpus and a read-only exact-decimal DB snapshot. It checked every updated context's uncapped receipts, raised amount, loans, outside support/opposition, all 12 stored outside groups, all 105 stored PAC donor groups and 48 contribution-size buckets. Seven updated contexts had positive outside spending; eight had PAC donors. Three source occurrences with contradictory target/stance fields remained excluded under the existing scope.

The ordinary production HTTP response matched the real database reader. A real React Router candidate page showed five outside groups and five PAC donors under `Not yet sorted`. Finance, PAC and size disclosures worked after hydration; a fresh reload preserved all visible finance text. No financial fixtures, source extracts or screenshots were saved. These checks complete this local post-deadline refresh; later scheduled filing windows still require their own reruns.
