# Indiana finance gaps

## Source decision, October 21, 2026

Indiana publishes receipts and expenditures through its campaign-finance portal.
The existing batch consumes contribution ZIPs; it has no independent expenditure
acquisition/storage path. The bulk schema carries contributor type, but the old
PAC-backed-industry path depends on PAC-recipient rows and name heuristics.

Fresh yearly ZIP originals fail strict whole-source qualification. They must not
be repaired, parsed by prefix or interpreted as empty ledgers. The legacy reader now rejects invalid UTF-8, malformed CSV quoting and row-width mismatches before predicates or row limits; application-level checks reject all four genuine malformed ZIP originals. The native public
HTML publication provides actual contributor class, native event URLs, complete
paging/count/money controls, filing inventories and amendment families. This is
the receiving-side authority selected for the new component.

The native PAC path now includes immutable request/response originals, saved-first
qualification, gated live acquisition, a protected component writer, an independent
due queue and an API reader overlay. It preserves signed credits, distinguishes
gift kind from contributor class, requires an exact PAC subset of the full receiving
ledger, and checks each PAC detail. Current filing inventories bind the actual
family actions and unique latest filed clock; complete parent/schedule/return
controls and receipt occurrence multisets must reconcile. Ambiguity holds the
component without changing stored money or observation clocks.

Migration 376 was applied through the normal local runner after a fresh ledger
check. The ordinary local CLI wrote one component: 282 receiving occurrences,
88 literal-PAC cash gifts, 65 reported-name groups and $166,500 cash. Independent
uncapped storage, actual production API and the hydrated candidate card agree.
All five displayed name/amount pairs and source links were compared in memory.
The full group set is validated before applying the display cap. Names are source
reported buckets, not verified legal-entity counts. Legacy headline money and its
clock remain unchanged; outside spending remains unknown.

A separate empty-cache live run of the production source acquired and qualified
fresh official forms, inventories, current versions, complete receipt walks and
all 88 PAC details, agreeing with the saved-source total. A protected-writer replay
preserved money and clocks exactly. An injected insertion failure after replacement
and deletion rolled back the whole component; prior groups, source metadata and
legacy direct rows were preserved. These are local proofs; no production release.

New read/write gate: `INDIANA_NATIVE_PAC_ENABLED`, default off beneath the state
master flag. Live acquisition additionally requires
`INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED`, default off. Normal state sync gates still
apply. The ordinary sync also accepts `--native-pac-only` and a scoped
`--native-pac-link-id`; the native due queue runs before legacy direct acquisition,
uses its own observation clock, a 24-hour attempt cooldown and a 112-day default
post-election window. Canonical context is rechecked under lock and at read time.

All three published current supplemental families for that context precede and
fall inside the later regular report. The official manual requires their receipts
on that regular report too; they are not additive. An uncovered supplement or a
correction filed after its covering report holds the component until its native
ledger is qualified. Later filings must not be silently discarded.

## Outside spending remains a separate qualification

Candidate-supporting Super-PAC expenditures are reported on CFA-4 Schedule B.
CFA-12 concerns public questions, and CFA-5 is a private notice not filed with the
state. The payer's candidate/committee name is not an expenditure target.

A complete native PAC expenditure control window had 161 occurrences, four
opening/closing pages and matching native money controls. Every detail was read;
six generic support descriptions identified neither a candidate target nor
independence. No such row is admitted as candidate IE. This bounded observation
cannot establish whole-cycle absence or an outside-spending zero.

The native CSV export is also unsuitable as a substitute for the HTML controls:
the year original failed strict CSV parsing, and the bounded export omitted three
occurrences/$27 relative to the complete native grid. Preserve these failures;
never accept the convenient subset. Independent IE source qualification and
acquisition remain required before claiming that gap resolved.

## Remaining implementation and proof

- Finish independent IE qualification, then the smallest supported integration.
- Complete the independent IE source decision before claiming the state gap resolved.
  The PAC path has ordinary local sync/store/API/card proof; no Indiana PR yet.

## Late filings and manual reruns

The official 2026 schedule sets nonstatewide/PAC pre-election reports due
October 16 at noon, covering through October 9. Statewide candidates on the ballot
have the October 27 noon report covering through October 19. Applicable 48-hour
candidate supplements continue in the pre-election window; statewide and
nonstatewide windows differ. Follow each actual filing family, not one universal
cutoff. Annual reports are due January 20, 2027; regular-party reports March 1.

Plan fresh whole-scope acquisition October 28/30, November 4/6 and
January 21/25, 2027; March 2 for applicable regular-party sources. These are manual
reruns, not automations. Saved old inventories do not establish new currentness.

Sources: [Indiana campaign finance](https://www.in.gov/sos/elections/campaign-finance/),
[July 2026 manual](https://www.in.gov/dA/9daf8fac31/2026-Campaign-Finance-Manual.REVISED-7-2026.pdf?language_id=1),
[official reporting schedule](https://www.in.gov/dA/ed7ae96143/2026-C.F.-Reporting-Schedule.pdf?language_id=1).
