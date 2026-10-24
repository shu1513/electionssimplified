# Utah finance source requalification

Status: filed committee cash implemented and verified locally through the ordinary sync, independent source/store comparison, production HTTP API and hydrated candidate card. Candidate-specific IE remains an unresolved source gap.

## Existing source and pipeline

Utah's [public disclosure portal](https://disclosures.utah.gov/Search/AdvancedSearch) publishes annual transaction exports and individual financial statements. The advanced search includes Independent Expenditures (`INDEXP`), Political Action Committee (`PAC`), candidate (`PCC`), and other reporting classes. The INDEXP category does not cover every reporting entity's independent spending; regular-report exceptions must be respected.

The current Utah batch loads the receiving candidate's annual export and then a PAC export for supporting-committee industry research. It does not acquire or aggregate independent spending. Its ballot reader has no named committee-cash component. The existing organization-name heuristic used for supporting-committee research is insufficient evidence that a contributor is a PAC.

The annual export identifies the receiving reporting class, counterparty name, native transaction ID, transaction type/date, amount, amendment reference, and in-kind/loan flags. It does not identify the contributor's class. The statewide export includes `FILED`; the observed per-folder `GenerateReport` export has 17 columns and does not include `FILED`. A typed PAC export supplies reported receiving names for PACs with exported activity, not a complete registration census or proof of unique legal identity.

## October 23, 2026 source observations

Fresh whole statewide originals contain seven INDEXP expenses totaling $322,694.19. The observed native statement and export do not provide explicit candidate target, stance, or allocation fields. This is source-level expenditure evidence, not candidate-specific outside spending. Candidate totals must remain unknown until those fields are qualified; no narrative inference or equal allocation is permitted.

The complete statewide candidate export still fails strict CSV parsing. Its valid prefix is not acceptable financial authority. The PAC export parses completely: 46,435 transaction occurrences and 181 reported receiving-name groups. Its amounts are not receiving candidates' PAC totals.

A canonical candidate's per-folder `GenerateReport` export parses completely: 274 unique transaction IDs, comprising 178 contributions and 96 expenditures. Three native filed statements independently reconcile their contribution controls after excluding in-kind amounts from cash, and their expenditure controls reconcile with the expense rows. The export also assigns two receipts totaling $150 to the General report, which is not among the three native filed statements. Their report assignment must not be mistaken for a completed filing. This receiver has no exact-name match to the observed PAC export and does not establish a positive named-donor card proof. An independent complete occurrence comparison closes all 272 transactions in the three displayed filed statements against the CSV on date, reported name, amount, in-kind status, and loan status. Native in-kind information links and loan checkmarks are different representations; parsing both as a text boolean loses the in-kind flags.

The separate native `CSV Download of Filed Reports` has inconsistent record widths and is not accepted. A closing capture was a bot challenge, not an empty ledger. Another canonical receiver with previously recorded committee support was selected read-only, but its new source capture was also challenged. Human verification approval was received and native browser access resumed. The missing third statement and receiving registration were saved as whole browser DOM observations, with no HTTP-byte claim. A closing export has not yet been verified.

The saved native folder and export names match the canonical candidate. The older finance link's committee-name field does not match the native folder after the tested person-name normalization. The native CSV-download selector is also different from the stored folder selector; retain the actual source-provided identities separately rather than forcing one numeric ID into every route. Canonical office/district evidence and the intended native selector roles still need qualification.

Native amendment-information links occur even though this receiver's CSV `AMENDS` fields are empty. Empty `AMENDS` is therefore insufficient evidence of an unamended reporting history. The official [2026 legislative filing instructions](https://vote.utah.gov/wp-content/uploads/2025/12/2026-Partisan-Legislative-Declaration-of-Candidacy-1.pdf) distinguish entering transactions from filing the report and describe later changes as amendments. Qualify the current public view and amendment behavior before accepting money; the complete detail comparisons above establish agreement of observed views, not a resolved amendment history.

## Gates before implementation and publication

1. Qualify the complete typed filer inventory or explicitly narrow the classification to source-proved PAC receiving names. Prove the receiving committee's canonical identity independently of a saved link.
2. Qualify every report-label group, filed/current version authority, signed cash/in-kind/loan/return semantics, and complete native parent/detail controls. Repeated occurrences must remain distinct. An unavailable closing observation must hold the component.
3. Demonstrate a complete positive receiving ledger and exact reported-name matches. Do not substitute generic organization names for contributor classes or describe reported-name groups as resolved legal entities.
4. Record a concrete implementation decision before monetary code. Any new component must acquire saved originals first, gate refresh independently, operate independently of legacy direct-finance freshness/failure, and preserve previous money and clocks on failure.
5. Use the normal local sync and protected writer. Verify all uncapped source/store groups and amounts, the actual HTTP API, and a hydrated candidate card before a Utah-only PR. Applied migrations are immutable. No provider calls, environment-file changes, production activation, merge, or deployment.

Independent spending remains a separate source gate even if a receiving-side committee-cash component qualifies first.

## Reporting deadlines and required reruns

The official [2026 financial disclosure dates](https://disclosures.utah.gov/File/307) and [candidate manual](https://vote.utah.gov/wp-content/uploads/2026/01/2026-Candidate-Manual.pdf) give the pre-general report deadline as **October 27, 2026**, covering September 26–October 22. The official [PAC guide](https://disclosures.utah.gov/File/304) also requires pre-general reporting and rolling contribution entry. Entity-class schedules and regular-report exceptions must be verified for any newly included source scope.

Refresh acquisition and rerun after October 27: October 28/29, then November 4/6. Retain December 5/7 follow-ups for the separately documented 31-day independent-expenditure reporting lag; verify the applicable current provision before admitting an IE source. The calendar lists year-end January 10, 2027, with the candidate manual's next-business-day rule relevant to that Sunday; retain January 12/14 follow-ups. Later filings and amendments require further reruns. These are manual follow-ups; no automation is created.

Kansas contributor names and all new Missouri publication remain held pending review.

## Source-reader foundation

The observed native CSV flags are `X` for true and blank for false. The existing mapper does not recognize `X`, which loses native in-kind and loan status. Correct this mapping and add a strict native-export reader for the independently observed 17-column folder and 18-column annual contracts. Strict reading validates the entire export, record widths, primitive values and exact integer cents; a malformed ledger must not become a valid prefix or lose invalid rows. This foundation does not authorize financial writes. Source/identity/currentness controls and the real sync/API/card proof remain required before the state PR.

## Foundation verification and remaining work

The mapper now recognizes native `X` flags. A separate strict reader validates the actual 17/18-column native contracts, every record, unique native transaction IDs, dates, flags, and exact integer cents. Existing legacy report shapes remain supported. The focused Utah suite passes 94 tests, the backend compiler passes, and the new 23 regressions also pass using the backend's own test runtime.

Read-only replay of genuine originals accepts all 279 positive-receiver rows, 46,435 PAC rows, and seven INDEXP rows. It rejects the malformed statewide candidate export, inconsistent filed-report CSV, and challenge page. No network or financial writes occur during this replay.

The positive receiver's three displayed filed statements now reconcile all 266 occurrences, including names, dates, amounts, in-kind flags, loan flags, and cash controls. Thirteen General-report receipts remain outside that filed inventory. Across the full receiving export, seven exact-name committee gifts total $12,500 in five groups; this is source research, not accepted financial data.

The source registration, reached through the finance folder's own reference, matches the canonical person's structured name, House office, and district. The registration's ID differs from the finance-folder ID. The research handoff incorrectly reused the registration ID for an export URL; future acquisition must keep these roles separate and use the actual finance-folder export link. The failed browser download establishes no valid closing export.

Nine saved PAC registry pages contain 225 distinct typed filer names. Their exact overlap with the annual PAC export is incomplete; the pager window does not establish a full registry census. Finish the relevant filer inventory, current amendment/public-view semantics, and closing-source controls before the protected writer, independent due sync, actual API/card proof, and Utah PR.

## Implementation decision after closing source check

The correct finance-folder closing export contains 281 occurrences, including two newly entered General receipts. The three filed report references and all 266 filed occurrences remain stable. The narrow accepted component will cover current public filed statements only. Six matched cash contributions in those statements total $11,500; the additional $1,000 committee gift in the unfiled General group is outside this scope. The refreshed typed annual PAC export contains 46,528 occurrences and the same 181 receiving-name groups. Exact PAC receiving-name matches establish reported-name recognition, not registration identity or a complete PAC census.

Implement a separate saved-original-first acquisition, strict native statement verifier, uncapped committee-cash aggregation, protected atomic component writer and independent due gate. It must run even when the old direct summary is fresh or its acquisition fails. The receiving folder's own registration reference must resolve canonical structured name, office and district. Every current-year filed statement must be reached from that folder; current main-table occurrences, cash controls and CSV rows must agree. Amendment-history popups are not additional transactions: use the folder's currently displayed report and require full agreement with the current export. Any nonempty CSV amendment linkage, duplicate/ambiguous report label, unstable filed inventory, malformed original, missing detail or unsupported flags holds the entire component. General/unfiled groups are explicitly excluded, never treated as filed or used to fill totals.

Store reported committee names and signed cash contribution subtotals with a separate observation clock; exclude in-kind and loan rows. Do not turn spending/payee names into contribution returns. State coverage explicitly as filed, itemized cash contributions, limited to exact names in the observed PAC-class export; it is not net receipts or all PAC money. A new card may be created from this component without inventing direct totals or outside-spending zeros. Existing direct totals and freshness remain independent. Re-run after the October 27 pre-general deadline as scheduled above.

Required proof remains: ordinary local due sync, independent uncapped source/store equality, actual HTTP API and hydrated candidate page, then a Utah-only PR. Source-only reader work is not a completed Utah fix. IE still lacks qualified candidate allocations and must remain unknown with an explicit coverage note.

## Local proof completed

Migration 380 was committed before applying it with the normal local migration runner. Applied migrations 378/379 were left unchanged. The ordinary Utah due-sync script ran a single canonical candidate's committee-cash component from genuine saved originals: three filed statements, all 266 filed occurrences, five recognized reported-name groups, six cash contributions, **$11,500**. Fifteen receipts outside the displayed filed inventory remain excluded.

A separate Python CSV/Decimal implementation reconciled every uncapped stored reported name, group identity, cent amount and occurrence count against the complete closing source. Its comparison also confirmed the exact stored source-observation clock. The first JavaScript audit's clock diagnostic had lost milliseconds by passing a Date object to Date.parse; this was a proof-reader error, corrected and independently checked, not a change to stored money or timestamps.

The ordinary repeat was idempotent. A missing-source run held the component and preserved all donor rows, source clocks and legacy direct summaries. The actual production HTTP endpoint returned all five displayed names/amounts/identities and the same $11,500; direct totals and their headline clock remained unchanged. A real candidate route loaded in the Browser pane with zero console/hydration errors. A React-only content expansion was verified and restored. The finance disclosure, every committee link/amount, group count, source footer and filed-subset coverage note matched the API. No outside-spending zero was presented. No financial screenshots or source-row dumps were saved.

For manual reruns, enable the ordinary Utah read/sync flags inline, use `--committee-cash-only --candidate-id=<canonical UUID> --year=2026 --raw-cache-dir=<private cache>`, and use `--refresh-committee-cash` to bypass only component staleness. Saved originals are read first. `--committee-cash-network` explicitly permits source GETs for missing originals; `--refresh-cache` requests replacement acquisition. Missing, old or challenged originals hold the component. Do not infer a complete PAC census from this recognized subset. Reacquire and rerun after the October 27 deadline.

Utah committee cash has a real sync/API/card proof. Candidate-specific IE remains a separate unresolved source gap; this PR must not be described as a completed IE integration. Kansas contributor-name publication and every new Missouri publication remain held.

Final focused validation: 133 Utah pipeline/script regressions pass. The Utah address-reader regression was also updated for the independent component query and explicit outside coverage note.

## Follow-up verification after review

The reader retains signed committee cash subtotals, acquisition checks download completion against the actual wall clock, and a separate last-attempt table rotates held receivers without advancing their financial observation clock. Migration 381 creates that nonfinancial table idempotently. The normal local runner applied only 381 against a verified identical empty table; all 404 earlier migration checksums and applied timestamps remained unchanged. No applied migration was renumbered or rewritten.

The updated code passed the ordinary scoped sync replay, a separate complete Python source/store comparison, the actual production HTTP endpoint and a hydrated candidate route. All five displayed reported names, amounts and official links match, totaling $11,500 from six filed cash contributions. The repeat is idempotent; a missing-original attempt records its hold while preserving every donor row, financial observation clock and legacy direct value. The React content expansion was verified and restored. The focused 133 tests and backend typecheck pass. Candidate-specific IE remains unknown; the October 28/29 post-deadline acquisition rerun remains required.

A concurrent review fix also isolates committee acquisition exceptions so the legacy direct sync continues; committee-only requests still report their acquisition error. Its focused regression and the integrated ordinary source/store replay pass.
