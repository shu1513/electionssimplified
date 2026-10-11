# Oregon campaign finance gaps

## Source and implementation scope — October 11, 2026

The existing batch sync reads receiving-committee contributions. ORESTAR publishes independent expenditure allocations on transaction detail pages, and contribution exports include donor class and public committee ID. These fields require separate acquisition and identity checks before they can populate outside spending and named PAC donors.

Initial PAC scope is current cash contributions from currently registered Political Action Committees, with complete current contributions and Other Disbursement searches, matching native rows and exports, fresh financial details, and receiving/donor Statement of Organization (SOO) checks before and after acquisition. Candidate committees, self transfers, party committees and in-kind contributions are excluded. A candidate-controlled PAC remains eligible when its official class is PAC. Any nonempty or unavailable Other Disbursement ledger preserves the PAC component initially; refund netting is outside this first implementation.

The named PAC card covers source-identified, registered PAC gifts. Baker's current ledger also contains 23 rows with the exact published label `Miscellaneous Cash Contributions $100 and under`, no donor committee ID and no Book Type. Retain these anonymous aggregates and their dollars as unclassified; they cannot be assigned to PACs or individuals. Only this exact source shape may be excluded from the named-donor subset. Other missing named-donor identity or class preserves the component. Positive anonymous money without any identified PAC gifts does not authorize a zero PAC snapshot. The $17,000 witness is a known named-PAC subtotal, not a complete total including anonymous contributions.

Initial outside scope is positive, current Original cash expenditures with explicitly allocated Independent support/opposition. In-kind associations remain separate. Complete payer ledgers and full association occurrence identities must agree before and after acquisition. Free-text targets require exact full names, complete competing native candidate contexts, and a qualified receiving SOO proving election year, office and district. The October 11 native all-status candidate directory contains 740 distinct IDs; its export contains only 715 distinct IDs and cannot establish complete target coverage. Unknown, ambiguous, amended or disappeared prior authority preserves stored data. These positive groups do not establish complete outside headline totals or zeros.

Source witnesses awaiting normal local sync proof: Adam Baker, receiving committee 21892, has $17,000 across four PACs and five current cash gifts; Paul Evans, receiving committee 16508, has an explicit $2,500 opposition allocation from Evergreen PAC transaction 5868897. Evans's unassociated $20 refund prevents initial PAC acceptance. These numbers are public-source research findings, not stored-money claims.

The first implementation step separates contribution data from outside data. A contribution-only refresh preserves outside groups and totals. Explicit `--refresh`, `--candidate-id`, `--election-year` and `--no-auto-link` support bounded local verification; candidate/year constraints apply before the batch limit. The default post-election window extends to 100 days. Existing withdrawn/lost eligibility exclusions still apply, including to scoped refreshes.

## Filing deadlines and fresh reruns

The official [2026 Campaign Finance Manual](https://sos.oregon.gov/elections/documents/campaign-finance.pdf), printed pages 22 and 26, requires transactions occurring September 22–November 3, 2026 to be filed within seven calendar days, by 11:59 p.m.; weekend and holiday deadlines extend to the next business day. Oregon has rolling filing deadlines rather than one pre-general report. Independent expenditure filers cannot use the small-committee opt-out. Outside this window, transactions generally have 30-day deadlines. Later amendments can change current records.

Run fresh acquisitions daily through November 3 once wiring is ready. Specific checkpoints:

- October 28, after October 20 transactions are due October 27.
- November 3 morning, after October 26 transactions are due November 2; this does not cover all election-day spending.
- November 12, after election-day transactions are due November 10 and the November 11 holiday.
- Continue later amendment refreshes using explicit `--election-year=2026` and a sufficient post-election lookback.

`--force` enables the sync; `--refresh` selects links regardless of summary staleness. A deadline rerun also requires genuinely fresh source generations and closing checks, not old saved evidence presented as a fresh observation. Saved immutable pages may support source recovery, but failed acquisition never authorizes zero money. No recurring automation is created by this plan.

Official sources: [ORESTAR transaction search](https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do), [Baker receiving SOO](https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21892), [Evans receiving SOO](https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=16508), [Evans opposition allocation](https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5868897), and [Transaction Filing Manual](https://sos.oregon.gov/elections/documents/orestartransfiling.pdf).
