# New Hampshire campaign finance gaps

## Source assessment

The official [CFS portal](https://cfs.sos.nh.gov/) publishes paged JSON for independent expenditures, contributions, filer registrations, current report inventories, and amendment histories. The existing direct-finance batch already called its IE client. Its transaction-level version selection did not establish which filing was current: an amendment can replace a report with a different numeric ID and GUID. Genuine source inspection found 558 IE rows, including 19 superseded rows, and 91 receipts for the ordinary first five linked receivers, including 55 superseded rows.

Contribution records carry the native `transactionSourceTypeCode`; `TPAC` means reported Political Committee. The old normalized contribution shape discarded that field. Use this explicit classification for current itemized monetary and in-kind contributions, grouped by reported name. This does not assert a resolved legal committee identity. Exclude loans, unitemized receipts, and other contributor classes. Display gross receipts before separately reported returns, with that scope visible on the card.

Before implementation, rank was 447 eligible links × 0.35 estimated fixability = 156.45. Native report authority and complete-ledger acquisition needed proof before accepting money.

## Implementation

1. Reconcile the complete current report inventory and every advertised amendment history against transaction report identities. Require stable closing inventories, complete pagination, exact returned filer registration/cycle identities, and unchanged original bytes.
2. Keep independent immutable raw-cache generations for the registry, statewide IE, and each receiving committee. Replay saved originals first. Refresh through the official public API only when its separate raw-data gate is enabled. Retain prior qualified source clocks and figures when acquisition fails.
3. Run the independent `new-hampshire-candidates:finance:reported:sync-due` job. Its ordinary due list uses canonical eligible candidates and its own attempt/component clocks; missing or fresh legacy direct-finance summaries do not block IE acquisition. Default batch size is 25. Never select candidates by known positive amounts.
4. Migration 350 adds independent component, group, and attempt tables. Preserve all five legacy NH tables. Commit uncapped component totals and groups atomically, with source and write clocks separate. Reject changed receiving context, stale sources, and conflicting equal-clock writes.
5. Attach validated components through the production finance loader. Preserve existing direct campaign totals and headline dates. The existing frontend renders reported committee receipts as “Committee money by interest”; unmatched interests remain “Not yet sorted.” Apply display limits only after full totals and counts close.

All gates default off: `NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED`, `NEW_HAMPSHIRE_REPORTED_IE_ENABLED`, `NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED`, and `NEW_HAMPSHIRE_CFS_RAW_DATA_REFRESH_ENABLED`. Inject flags at invocation; never load or modify `.env` for this job. No AI providers are required.

Empty report inventories, empty name-filtered receipt searches, empty statewide IE searches, ambiguous target aliases, unsupported allocations, and unresolved paper amendments are held as unavailable. They do not establish a money zero. Receipt searches require exact returned filer identity because the public endpoint ignores numeric filer/GUID filters. A qualified nonempty current ledger with no in-scope committee receipts can establish a scoped zero.

## Filing deadlines and reruns

The previously verified official [2026 receipts and expenditures calendar](https://www.sos.nh.gov/sites/g/files/ehbemt561/files/inline-documents/sonh/2026-re-dates.pdf) lists October 14 (through October 11), October 28 (through October 25), and November 25 (through November 24), due at 5 p.m. New Hampshire time. The calendar download returned 403 during this continuation; that response is not fresh date verification.

Run fresh acquisition plus the ordinary sync after the October 14 report is available, then October 29, November 2 and 5 for late filings/IE/amendments, and November 26. Extend the post-election lookback if necessary. Rerun acquisition as well as aggregation so new filings can appear. These are operational follow-ups, not scheduled automations. Pennsylvania's late-filing pattern makes a single early snapshot insufficient.

## Verification before PR

Require the NH unit suite and backend typecheck; a real ordinary local sync against the official source; full canonical component/group totals and source-clock comparisons; unchanged migration ledger and legacy rows; a production API GET; and a real frontend candidate card. Keep proof artifacts private and aggregate-only, with original source bytes retained separately. No production writes, merge, or deployment.

Verified locally October 17, 2026: two successive ordinary batches of 25 candidates from 447 eligible links, without identity, amount, or year overrides. The batches captured and independently checked 292 official responses against the unchanged raw-cache bytes. Canonical results were 50 IE components and 30 committee components, with 56 groups: $5,448.26 supporting IE, $28,605.36 opposing IE, and $46,922.50 gross committee receipts. Twenty unavailable committee ledgers remained held, including one returned registration/cycle mismatch. All five legacy NH tables and the 372-row migration ledger remained unchanged.

Actual production API GETs matched canonical totals, complete group counts, displayed names, and source clocks. Real React Router candidate cards displayed one candidate's $24,169.16 opposing IE as $24,169 under normal whole-dollar formatting, and another candidate's $20,000 committee receipts across 12 reported groups under “Not yet sorted.” The latter retained its September 25 campaign headline date while the component note showed October 17 observation. All 185 NH tests and the backend typecheck passed after integrating current main. No source identities or screenshots were saved in proof artifacts.
