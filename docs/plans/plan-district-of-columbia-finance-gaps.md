# DC committee receipts and outside-spending source decision

## Research before implementation

The October 20, 2026 read-only census ranked DC13×.70=9.10, New Mexico10×.85=8.50, Alaska10×.65=6.50 and Virginia2×.70=1.40. Indiana, Colorado and Utah retain previously documented native-source holds. Nebraska PR1610 is merged. DC work started from main7f20e7c05; the private master plan and DC source decision were written before code.

1. **Where are independent expenditures?** OCF's traditional DataDownload CSV includes registered IEC expenditures. A separate [single independent expenditure system](https://ocf.dc.gov/page/ocf-online-filing-system-single-independent-expenditures) publishes explicit target/stance rows. Its full 2025–2026 ledger has63 occurrences with unchanged closing sweep and complete target-type union. Default zero row IDs/clocks, absent parent amendment controls, blank CSV payers, unresolved historical targets and multi-target contexts prevent admission of that additional source. Do not sum its amounts into existing figures or certify zeros from it.
2. **Is existing IE code called?** Yes. `districtOfColumbiaCandidateFinanceBatchSync` calls the registered-IEC expenditure/contribution clients and outside aggregator; ten outside groups already exist locally. DC does not have Pennsylvania's missing-call gap. The dedicated single-IE source remains a distinct coverage hold, not a completed fix.
3. **Can political-committee donors be recognized?** Yes. The traditional native receipt ledger carries contributor classes and actual receipt schedules. A1 covers parties, A2 political committees, A4 other authorized committees. Verify these against the [official report packet](https://ocf.dc.gov/sites/default/files/dc/sites/ocf/publication/attachments/ocfform16_0.pdf). Include all reported party, PAC, labor-sponsored PAC, corporate-sponsored PAC, other PAC/committee and authorized-committee gifts. Do not infer PAC status from businesses, unions, individual names or interests.

## Qualified scope

This PR adds only independently acquired traditional committee receipts, behind default-off `DISTRICT_OF_COLUMBIA_REPORTED_COMMITTEE_ENABLED` under the DC master flag. It leaves legacy direct/outside money, links and clocks unchanged. Eight current traditional receivers qualify; five Fair Elections receivers are outside this component.

Full native controls: principal registry965 in two complete sweeps; candidate receipts3951 in complete CSV/native JSON/closing sweeps; public 2025/2026 report catalogs395, including two duplicate catalog occurrences preserved as published. All114 receipt parent IDs uniquely bind full candidate/committee/year/report context and highest family amendment. No selected financial parent can be duplicated. The native ledger's `RegistrationId` and default `ScheduleTransactionId` are not authority; use actual native candidate/committee keys, receiving year and full person/office/seat evidence. All1403 receipts for the eight current receivers agree on those native keys/year/person. Eleven current political-gift occurrences reach two receivers.

The CSV contains individual middle names omitted by native JSON; preserve originals and require full eligible political names to agree exactly. Parse exact cents, including native sub-dollar and four-decimal formatting, without rounding fractional cents. Keep all source records and occurrences. Source schema/count/version/context failures hold the component. Named amounts are **gross reported committee gifts before separately reported expenditure-side returns**, including cash/in-kind gifts, excluding self receipts, loans, miscellaneous receipts and interest. Legal PAC status/interests are not inferred; reported groups enter “Not yet sorted.”

Fair Elections uses a different dictionary: A4 authorized Fair Elections committees, A3 public funds, A5 prohibited receipts. All93 published report versions for its five current receivers corroborate zero A4 amounts/counts. One link also fails full-person evidence after native structured-detail inspection. This PR publishes no new Fair Elections donor amounts, names or zeros; a future positive-A4 acquisition needs its own qualification.

## Implementation and proof

Replay genuine private originals before fetching. Preserve unchanged bytes, request bodies, actual status/redirect/EOF/MIME/length/integrity and start/end clocks. Never retime saved originals. Only complete protocol replay seals a monetary packet.

Use ordinary batches of25, seven-day source freshness, independent 24-hour failed-attempt backoff, and98-day post-election lookback including general-election losers. Recheck/lock canonical receiver, every person alias, middle/generation, native office/seat/year and exclusive app ownership before atomic writes. Separate attempts from successful monetary observations. Validate every stored name/cent/count and full group closure before applying presentation caps. Failures retain previous values.

Required completion: synthetic protocol/parser/identity/transaction/reader/batch tests, TypeScript, migration validation; real ordinary local sync; full independent original/reference/store comparison in RAM; actual production HTTP API and hydrated candidate card; DC-only PR and exact-head CI. Record aggregate results here after completion. No production, merge/deploy, AI calls, environment-file reads/loads/edits, new agents or automations. Kansas donor names and all new Missouri publication stay held.

## Late-filing reruns

Current OCF homepage confirms **October26,2026** pre-general due date. Earlier official2026 materials list October10 and December10; the historical October13 weekend/holiday adjustment still needs independent notice verification. Obtain exact coverage close dates from filed reports; never assume a five-day subtraction. Plan whole-cycle refresh and fresh eligibility selection **October27**, through **November4** for late filings, **December11/14** after post-general, and later amendments. No automation is scheduled.

## Local validation completed October 20

312 tests across26 files and TypeScript pass, including legacy DC, CLI/scheduler, feature flags, shared finance API fault isolation and migration helpers. Migration365 applied only to the local Unix-socket database; ledger386→387 and every prior checksum remained unchanged. Existing13 historical ledger entries whose files were removed before this change were not altered.

The ordinary CLI with no candidate, year, amount, refresh or batch-size override selected8→0 across two calls. It wrote eight components and11 groups/11 gift occurrences totaling **$14,500 gross**, across two receivers, from1403 receiving receipt rows. A complete36-observation production acquisition/replay closed965 registrations,3951 receipts and395 catalog occurrences. Independent original/reference/store comparison matched every admitted name, cent, count, native/canonical context, source fact and genuine observation clock in RAM. All five legacy finance tables remained exactly unchanged.

The actual production HTTP endpoint matches the canonical reader and stored controls. The actual hydrated frontend card's five displayed donor names and rounded amounts, full group count, total, gross coverage and source dates all match in RAM. Legacy headline/outside money and timestamps are preserved. Private aggregate audits contain no financial identities, selectors or source text. No screenshots were taken. Preview tabs and loopback services were stopped. Frontend guards recorded zero environment-file or remote-network attempts; six framework listener probes were blocked. The initial private preview command/root and review-selector join were corrected before the successful API/card proof; application money was unaffected.

Dedicated single-IE and new Fair Elections donor publication remain held as documented above. DC's existing registered-IEC path remains operational and unchanged. This validation does not claim complete coverage of those additional sources.
