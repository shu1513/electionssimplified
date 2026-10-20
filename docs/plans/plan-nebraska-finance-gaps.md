# Nebraska reported finance gaps

## Source decision

1. **Independent expenditures:** NADC publishes current transaction searches and a detailed CSV export in [FirstTuesday](https://nadc-e.nebraska.gov/PublicSite/). The annual expenditure ZIPs also contain candidate, office/district and support/oppose fields. The current HTML search silently stops at 800 allocations; the detailed CSV contains 1,642 current 2025–2026 allocations and closes byte-for-byte over two fresh captures. A nine-target native expense independently confirms that exported amounts are allocations whose sum equals the detail's gross amount. Repeated expense IDs must not collapse allocations or multiply the gross amount.
2. **Existing integration:** the Nebraska batch reads contribution/loan ZIPs only. Its artifact reader already recognizes expenditure columns, but no IE acquisition, storage or reader path is called. New reported components must run independently of legacy direct receipts, source health and success clocks.
3. **Committee donors:** the source explicitly distinguishes independent PACs, separate segregated funds, parties, candidate committees, Federal PACs and ballot-question committees. The current contribution search supports these six filters. Its detailed grid truncates at 500 rows and its CSV exports summary totals only. Complete typed receipt acquisition uses date partitions, checks every partition against uncapped native summary totals and re-reads every page of it before closing. Changing recipient type resets contributor type; both native postbacks must be completed and checked.

Current native data is monetary authority. Annual bulk data contains historical offsets and older contexts; its whole-cycle signed IE occurrence count agrees with the current export, but its amounts and some contexts differ. Do not drop negative rows, select amended flags as current records, or force those sources to agree.

## Priority and scope

The complete local census has 48 linked eligible Nebraska candidates. Nebraska remains the highest actionable state at 48 × 0.65 = 31.2, ahead of DC 9.1, New Mexico 8.5 and Alaska 6.5. Higher Indiana, Colorado and Utah scores retain documented source holds.

All 48 receivers pass native ID, exclusive ownership, current registration, jurisdiction, election year, canonical office/district and full/structured/display name checks, including middle names and generations. District labels' boundary vintage is separate from election year. Current native committee names can differ from legacy link names; leave legacy metadata unchanged.

Six complete current committee-source acquisitions contain 3,546 receipt rows. Eight are unpaid pledges; the observed gift metric has 3,538 rows. Include current monetary/in-kind/earmarked contributions, paid pledges and reported loan/debt forgiveness. Exclude loans, unpaid pledges and miscellaneous noncontribution receipts. These are gross current receipts; separately reported later disbursement returns are not subtracted. Group by reported committee name without inferring a legal PAC identity or an interest classification.

Fifteen current IE rows omit both target and office. Preserve their source coverage count and leave their money unassigned. Candidate figures describe explicitly attributable reported allocations, with that gap beside the figures. Lack of an attributed record cannot certify a zero while this gap remains. Ambiguous candidate bindings or unsupported allocations hold the affected component.

## Implementation and proof

- Separate, default-off IE and committee components, with saved-original-first acquisition and replay, real source clocks, exact cents and complete source controls.
- Pure uncapped aggregation, atomic storage, independent attempts and fair selection. Keep legacy links, headline money and clocks intact. Failed fetches never write zeros.
- Validate all stored groups before display caps. Ordinary batches retain the default 25-candidate selection and remain independent of legacy direct success.
- Before the PR: real local ordinary sync; uncapped in-memory comparison of every admitted name, cent, count, canonical context and source observation; actual production HTTP API and hydrated candidate card; focused tests, typecheck, migration checks and exact-head CI.

No Nebraska migration, monetary write, sync/card proof or PR has been completed at this planning checkpoint. Re-read main and the local migration ledger before selecting a migration; applied migrations remain immutable.

## Local validation — October 19, 2026

Fresh production acquisition/replay closed 81 registry rows, 1,642 current IE allocations and 3,547 committee receipt rows in 49 complete date windows. The receipt population grew by one after the earlier research capture; the new original clocks and bytes are retained. Separate parse5/CSV reference replay compared every source field and observation in memory.

Ordinary default batches selected 25 candidates, then 23, then none. All 48 eligible receivers received committee components; 46 received IE components. Two IE components remain held because absence of attributed records cannot certify zero while 15 source allocations lack target details. Stored 94 components and 1,345 uncapped groups: $4,732,344.42 committee gifts and $1,683,645.90 identifiable IE. Every name, cent, count, canonical context and source observation matched the independent reference and storage. All three legacy finance tables stayed unchanged.

Actual production HTTP API and hydrated candidate card passed. One ordinary candidate example has $380,000 in committee gifts across 34 reported groups, $722,512.09 supporting IE and $650 opposing IE. All ten visible names/amounts, source notes and full committee count matched the API in memory. The existing $5,000 UI threshold suppresses the smaller opposition section; the API retains its exact amount. No financial identities or routes are saved in derived proof.

Migration 364 was applied locally after checking main and the 385-entry ledger; all older migration checksums remained unchanged. New features remain off by default. Enable `NEBRASKA_CAMPAIGN_FINANCE_ENABLED`, `NEBRASKA_CAMPAIGN_FINANCE_SYNC_ENABLED`, `NEBRASKA_REPORTED_COMMITTEE_ENABLED` and/or `NEBRASKA_REPORTED_IE_ENABLED` inline for the ordinary reported CLI (`src/scripts/syncDueNebraskaReportedFinance.ts`). It uses explicit process environment and never loads environment files. Native acquisition also runs independently before annual-file work in the existing batch. `--refresh` forces whole-cycle acquisition and fair reselection; repeat default batches to cover the cohort after each deadline. Source failures preserve prior groups and original clocks.

After the Nebraska PR and exact-head CI, pause the broader state rollout as requested. Kansas donor names and all new Missouri publication remain held.

Local validation: 254 tests across 22 files passed, including existing Nebraska pipeline/CLI/scheduler and shared finance regressions; TypeScript passed. New-source tests exercise exact request/body integrity, status/EOF/MIME/length and clock failures, saved-first replay without network or mtime freshness, explicit native empty results, six committee classes, ambiguous identity/scope, full stored closure before display caps and independent component failure handling.

## Late filings and required manual reruns

The [official calendar](https://nadc.nebraska.gov/important-election-dates) gives first general October 5, covering through September 29; second general **October 26**, covering September 30–October 19; and post-general **January 12, 2027**, covering October 20–December 31. Certain late transactions October 20–November 2 require reporting within two days. [Form B-11](https://nadc.nebraska.gov/sites/default/files/doc/B-11%202026.pdf) late IE also appears on the following campaign statement; current native transaction data avoids counting those reports twice.

Force a **whole-cycle** refresh/reselection October 27, through November 4 for rapid reports, January 13/14 after post-general, and February 2/3 after the February 1 annual/primary-only deadline. Later filings can add transactions dated in earlier partitions. Keep general-election losers eligible through the 98-day closeout window. No automation is created.

Kansas donor names and all new Missouri publication remain held. No environment-file access, AI provider calls, production changes, merge/deploy, screenshots or new agents.
