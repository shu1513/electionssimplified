# Finance module capability matrix

Phase 0 deliverable of the finance consolidation plan (see `docs/plans/plan.md`). Extracted mechanically from the writers, loaders, and test tree on 2026-08-01; spot-verified by hand. This matrix decides migration cohorts — cite the relevant row in every migration PR.

## Legend

- **Tables**: which of the five canonical tables (`links`, `summaries`, `direct_breakdowns`, `outside_groups`, `outside_group_breakdowns`) the writer touches. `5` = all five.
- **Link extras**: link-table columns beyond the canonical set (`candidate_id`, `election_id`, `election_year`, `candidate_name_normalized`, `office_name`, `district`, `committee_id`, `committee_name`, `link_status`, `link_source`, `source_url`, `last_verified_at`). `→` marks a rename of `committee_id`/`committee_name`.
- **Merge policy** (summaries upsert): `R` = replace all fields (`= EXCLUDED.x`); `C` = COALESCE all (preserve when incoming NULL); `R+oC` = replace, but COALESCE the two outside totals; `C+oR` = COALESCE, but replace outside totals. Field-set deviations noted.
- **Floor**: minimum accepted election year.
- **Tx**: `pool` = throws unless given a Pool ("must receive a Pool"); `self` = opens own transaction on a Pool, runs **unwrapped** on a client (pre-refactor Texas semantics); `factory` = delegates to the shared writer.
- **Val+**: `G` = outside-group-breakdown ↔ group **pairing** validation (each breakdown must match a group in the snapshot; two message variants exist: "require matching…" and "must reference…"); `g` = presence-only check (breakdowns need ≥1 group, no pairing); `N` = `normalizeCommitteeId`; `M` = same-identity manual-link protection (an AUTOMATIC link upsert — incoming `link_source <> 'manual'` — preserves `link_status`/`link_source` when the existing row's `link_source = 'manual'` and fails closed when that row is operator-disabled; a manual write applies in full; pre-INSERT "retire other identities" steps never touch manual rows; shared SQL in `pipeline/finance/manualLinkProtection.ts`, in every bespoke writer and the factory since the 2026-09 backlog PR); `M+` = candidate/election-wide protection (exact active manual identity reuse, disabled exact rejection, different active identity rejection).
- **Signed**: summary fields allowed to be negative.
- **Direct cats**: `std` = `occupation` + `contribution_size`.
- **Tests** (per-module files): W = writer, L = ballot-lookup loader, A = auto-link, B = batchSync.

The shared factory (`createStandardStateFinanceSnapshotWriter`) after PR #488 + the second-wave prep PR + the outside-identity PR #509: canonical link columns, all 5 tables mandatory, outside-group identity configurable (defaults `committee_id`/`committee_name`), tx `pool`, config = `{label, tables, minElectionYear (required), summaryUpdatePolicy? (per-column replace|preserveWhenNull, default preserve), outsideGroupValidation? (none|presence|pairing, default none), normalizeCommitteeId? (fn applied at every committee-id write/compare site, default identity), supersededLinkSource? (an active incoming link with this source deactivates other active same-source links for the candidate+election inside the snapshot tx, default off), manualLinkProtection? (candidate/election-wide M+, default false), outsideGroupIdentityColumns? ({id?, name?} column names in the outside tables, default committee_id/committee_name, identifier-validated; input fields stay committeeId/committeeName — wrappers map)}`. `linkIdentityColumns?` ({id?, name?} column names in the links table, default committee_id/committee_name, identifier-validated; id joins the link conflict target) is also configurable since the link-identity PR. Same-identity manual protection `M` is always built into the factory link upsert since PR #667. `manualLinkProtection: true` adds `M+`: automatic exact active identities reuse the manual row and refresh only verification time; exact disabled and different active manual identities fail closed; SQL blocks a concurrent same-identity automatic rewrite. Missouri is the first consumer. Signed cash is configurable since the Georgia PR (`allowNegativeCashOnHand`). Still missing (add only when a migrating cohort needs it): caller-transaction mode, optional tables.

## Writers

| Module | Tables | Link extras | Merge | Floor | Tx | Val+ | Signed | Direct cats |
|---|---|---|---|---|---|---|---|---|
| alaska | 5 | →`candidate_filer_id`/`candidate_filer_name` | R; **deletes summary row when absent; unconditional stale deletes for omitted sections** (full-replace snapshot semantics — one-state, verified 2026-08-02) | 2000 | pool | G | — | std |
| arizona | 5 | none | R | 2002 | pool | g | — | std |
| california | 5 | no `district`; →`controlled_committee_id`/`_name` | C; +`debts_owed`; no `direct_contribution_total` | 2001 | self | — | — | std+`contributor_source_type`+`industry` |
| colorado | 3 (no outside) | +`tracer_candidate_id` | C; only receipts+source | 2001 | self | — | — | std |
| connecticut | 4 (no `outside_group_breakdowns`; outside groups since the 2026-09 IE PR, keyed by normalized committee name) | none | C; no direct/cash | 2008 | self | — | — | std |
| districtOfColumbia | 5 | →`committee_key` | C | 2000 | pool | G | — | std |
| florida | **6** (+`outside_group_links`, 2nd insert) | none | R+oC | 1996 | pool | — | — | std |
| hawaii | 5 | +`election_period` | C+oR | 2000 | pool | g | — | std |
| houston | factory wrapper | — | factory | factory | factory | — | — | — |
| illinois | 5 | +`sbe_candidate_id`,`sbe_district_type`,`sbe_office`,`is_at_large`; →`committee_key` | R+oC; +`debts_owed` | 2000 | pool | G,M | `cash_on_hand` | std |
| idaho | 5 via existing factory; independent reported-PAC source/group/attempt tables since migration 352 | →`registration_guid`/`filer_name` | existing snapshot unchanged; PAC source/groups atomic replace, stale/equal-clock guards | 2026 for reported PAC | pinned pool transaction | canonical person/office/district/cycle + unique active link; native identity and itemized TPAC category closure | signed receipt corrections before grouping | existing size/source-type; separate reported committee-interest overlay |
| indiana | 3 (no outside) | none | R; only receipts+direct | 2000 | self | M | — | std+`pac_backed_industry` |
| kentucky | 5 | +`candidate_key`; →`committee_key` | R | 2000 | pool | G | `cash_on_hand` | std |
| losAngelesCity | 4 (no `outside_group_breakdowns`); `lacity_` prefix | different shape (city outlier) | — | none | self | — | — | — |
| louisiana | 5 | →`filer_number`/`filer_name` | R | 2000 | pool | G | `cash_on_hand` | std+`contributor_type`+`donor` |
| maine | 5 | supersedes same-source active links (`cfis_bulk`) | R+oC | 2000 | pool | G,N | — | std |
| maryland | 5 | supersedes same-source active links (`cfs_public_export`) | R+oC | 2000 | pool | G,N | — | std |
| massachusetts | 5 | →`candidate_cpf_id`/`filer_name`; keeps `committee_name` | R | 2000 | pool | g | — | std |
| michigan | 5 | none | R+oC; +`candidate_loan_total` | 2000 | pool | G,M | — | std |
| minnesota | **4 (no `direct_breakdowns`)** | none | C | 2000 | pool | G,M | — | n/a (no direct table) |
| missouri | 5 | supersedes same-source active links (`mec_portal`) | R | 2024 | factory | G,N,M+ | — | std |
| nebraska | 3 (no outside) | none | C; only receipts+direct | 2021 | self | — | — | std |
| newJersey | 5 | →`candidate_entity_s`/`entity_name`; +`election_type_code` | R | 1980 | pool | G | — | std |
| newMexico | 5 | none | C; no `cash_on_hand` | 2020 | self | — | — | std |
| newYorkCity | 5 (`nyc_` prefix) | city outlier | different summary fields entirely (`private_contributions`, `net_expenditures`, `outstanding_bills`, `public_funds`) | none | self | M | — | — |
| newYork | 5 | →`filer_id`/`filer_name` | C+oR | 2000 | pool | g | — | std+`contributor_type`+`donor`+`industry` |
| oklahoma | 3 (no outside) | none | C; only receipts+direct | 2014 | self | — | — | std |
| oregon | 5 | none | R | 2000 | pool | g | — | std |
| pennsylvania | 5 | →`filer_id`/`filer_name` | R+oC | 2000 | pool | G,M | — | std |
| tennessee | 5 | +`camp_candidate_id`,`owner_name`,`report_list_url` | R; no disb/cash | 2000 | self | G | — | std |
| texas | factory wrapper | — | factory | factory | factory | — | — | — |
| utah | 3 + **alt outside tables** (`supporting_committees`, `supporting_committee_industries`) | →`folder_id` | R; no outside | 1998 | self | — | — | `contribution_size` only |
| vermont | 5 | +`filer_registration_guid`,`entity_id`; →`filer_name` | R | 2000 | pool | g | — | std+`contributor_source_type`+`donor` |
| virginia | 3 (no outside) | +`committee_code` | C; only receipts+direct | 2000 | self | — | — | std |
| washington | 5 | +`filer_id`,`candidacy_id` | C+oR | 2000 | pool | g | — | std+`employer`+`industry` |
| wisconsin | 5 | +`entity_id`,`assigned_committee_id` | C | 2000 | pool | g | — | std+`employer`+`industry` |

### Writer outside-group identity columns

The factory's outside-groups and outside-group-breakdowns identity columns default to `committee_id`/`committee_name` and are configurable via `outsideGroupIdentityColumns` since PR #509; the `committeeId`/`committeeName` input fields stay fixed (wrappers map state-specific field names onto them). Writers diverge (this was missed in the first pass and disqualified Oregon as a pilot):

- **`committee_id`/`committee_name` (factory-canonical)**: arizona, california, florida, hawaii, maine, maryland, michigan, minnesota, newMexico
- **`committee_key`**: districtOfColumbia, illinois, kentucky, tennessee
- **`sponsor_id`/`sponsor_name`** (and `sponsorId` input fields): oregon, washington, wisconsin
- **One-offs**: alaska `outside_group_id`; louisiana `filer_number`; massachusetts `iepac_cpf_id`; newJersey `outside_entity_s`; newYork `filer_id`; newYorkCity `spender_id`; pennsylvania `group_id`; utah `committee_name` only (alt tables); vermont `filer_registration_guid`
- **No outside tables**: colorado, connecticut, indiana, nebraska, oklahoma, virginia (+ texas/houston wrappers, factory-owned)

Any state outside the factory-canonical group needs a configurable outside-identity column before its writer can migrate — shipped as `outsideGroupIdentityColumns` (own PR, 2026-08-02). Caution: outside identity alone unblocks only **oregon** (its link side is canonical). dc/alaska also rename the link identity column — covered by `linkIdentityColumns` since the link-identity PR; dc migrated on it, but alaska turned out to have one-state delete-when-absent snapshot semantics (see its row and the wave notes below) and stays bespoke. massachusetts has an extra link column (`filer_name` — 13-param link upsert, verified 2026-08-02) and still needs factory work.

**Cascade-FK trap (affects migration validation choice):** the `*_outside_group_breakdowns` tables carry a `FOREIGN KEY ... REFERENCES *_outside_groups ON DELETE CASCADE` (verified for arizona, texas, houston — same DDL template). The factory upserts breakdowns before deleting stale groups, so under validation `none` or `presence` a breakdown referencing a stale group inserts, is cascade-deleted by the stale-group cleanup, and is still counted as written. Any state with this FK must migrate with `outsideGroupValidation: "pairing"` (arizona does, per PR #492 review) — or document why not. Texas/Houston run `none` today; that window predates the factory (it was extracted byte-identical from Texas) and fixing them is a separate behavior-change decision.

Val+ distribution before Missouri: pairing validation `G` in 12 (two message variants — "require matching": dc, kentucky, maryland, newJersey, tennessee, maine; "must reference": alaska, illinois, louisiana, michigan, minnesota, pennsylvania); presence-only `g` in 10; bespoke manual-link protection `M` in 6 (illinois, indiana, michigan, minnesota, newYorkCity, pennsylvania). Factory coverage: pairing/presence configurable since PR #488 (with the factory's "must reference" wording — "require matching" states reproduce their wording in wrapper pre-validation), `normalizeCommitteeId` and same-source link supersession (maine `cfis_bulk`, maryland `cfs_public_export` — a first-pass matrix miss, recorded here) configurable since the second-wave prep PR; same-identity `M` built in since PR #667; opt-in candidate/election-wide `M+` added for Missouri Phase 1. Illinois additionally guards its SBE columns and `source_url` for manual rows — that extra-column guarding stays bespoke.

## Ballot-lookup loaders (identity columns per relation)

`link.id`, `link.candidate_id`, `link.election_id`, `*.link_id` are universal and omitted. Shared loader supports `committee_id`/`committee_key` as one column across all relations via `committeeColumn`, plus per-relation overrides (Phase 3 descriptor PR): `linkIdentityColumn` for the summary query and `outsideGroupIdentityColumns: {id?, name?}` for the three outside queries — both identifier-validated; the ID defaults chain through `committeeColumn` while the name default is always `committee_name`, so existing configs are unchanged. `directBreakdownCategoryTypes?` narrows the direct-breakdown `category_type` filter (default `occupation`+`contribution_size`; whitelisted to the two routable types — unroutable ones like `industry` are rejected rather than mis-landing in `top_occupations`). `outsideSupportActionLabel?` swaps the outside-industry explanation's action wording (default "independent spending supporting this candidate"; louisiana/vermont say "PAC contributions supporting this candidate").

| Module | File | Link identity | Outside-group / breakdown identity |
|---|---|---|---|
| alaska | **wrapper over shared loader** (`alaskaCandidateFinanceBallotLookup.ts`, nonstandard name) | `candidate_filer_id` via `linkIdentityColumn` | `outside_group_id`/`outside_group_name` via `outsideGroupIdentityColumns` |
| arizona | `arizonaFinanceBallotLookup.ts` (nonstandard name) | `committee_id` | `committee_id` |
| california | standard name | `controlled_committee_id` | `committee_id` |
| colorado | standard | `committee_id` | direct-only |
| connecticut | standard | `committee_id` | direct-only |
| districtOfColumbia | standard | `committee_key` | `committee_key` |
| florida | **no loader file** | — | — |
| hawaii | standard | `committee_id` | `committee_id` |
| houston / illinois / texas | wrappers over shared loader | — | — |
| indiana | standard | `committee_id` | direct-only |
| idaho | standard wrapper plus default-off reported-PAC overlay | `registration_guid` | `filer_key`; reported PAC groups use native source entity keys, full totals before top-five details; IE already wired, electioneering excluded |
| kentucky | standard | `committee_key` | `committee_key` |
| losAngelesCity | `losAngelesBallotLookupFinanceLoader.ts` | `fppc_committee_id` | city outlier |
| louisiana | standard | `filer_number` | `filer_number` |
| maine | standard | `committee_id` | `committee_id` |
| maryland | standard | `committee_id` | `committee_id` |
| massachusetts | **wrapper over shared loader** | `candidate_cpf_id` via `linkIdentityColumn` | `iepac_cpf_id`/`iepac_name` via `outsideGroupIdentityColumns` |
| michigan | standard | `committee_id` | `committee_id` |
| minnesota | standard | `committee_id` | `committee_id` |
| nebraska | standard | `committee_id` | direct-only |
| newJersey | standard | entity columns | entity columns |
| newMexico | standard | `committee_id` | `committee_id` |
| newYorkCity | standard | `cfb_candidate_id` | `spender_id` |
| newYork | standard | `filer_id` | `filer_id` |
| oklahoma | standard | `committee_id` | direct-only |
| oregon | standard | `committee_id` | **`sponsor_id`** (mixed) |
| pennsylvania | `pennsylvaniaBallotLookupFinance.ts` (nonstandard name) | `filer_id` | **`group_id`** (mixed) |
| tennessee | standard | `camp_candidate_id` | `committee_key` |
| utah | standard | `folder_id` | alt tables |
| vermont | standard | `filer_registration_guid` | `filer_registration_guid` |
| virginia | standard | `committee_id` | direct-only |
| washington | **wrapper over shared loader** (descriptor-cohort pilot) | `committee_id` | `sponsor_id`/`sponsor_name` via `outsideGroupIdentityColumns` |
| wisconsin | **wrapper over shared loader** | `committee_id` | `sponsor_id`/`sponsor_name` via `outsideGroupIdentityColumns` |

Mixed-identity states (link column ≠ outside column) are why the loader descriptor must be per-relation, not a single option.

**Query-shape families** (normalized SQL cluster of all unmigrated loaders vs the shared loader with its interpolations resolved, 2026-08-02):

- **Config-expressible today, zero factory change (4): arizona, hawaii, maine, maryland** — every query CONFIG-EXACT under existing options. Their donor-evidence variant (`= 'donor'`, hardcoded `organization_type`, pinned `classification.label_type = 'donor'`) is textual-only vs the shared loader's `evidenceLabelTypes: ["donor"]` (`IN ('donor')`, `category_type AS organization_type`, mapper default `?? "donor"`) — outputs equal. **MIGRATED (Phase 3 cohort 0)**: texas-style wrappers; behavior pinned first by characterization tests (shared harness `tests/helpers/stateFinanceLoaderCharacterization.ts`: output map, query order/tables, request params, migration-column cross-check — no SQL text assertions). maine/maryland keep their `isEligibleElection` office filters; ME/MD/HI/AZ all pass `evidenceLabelTypes: ["donor"]`.
- **Identity renames — the per-relation descriptor's cohort** (descriptor shipped in the Phase 3 descriptor PR; **washington MIGRATED as its pilot**, `sponsor_id`/`sponsor_name` via `outsideGroupIdentityColumns`): **wisconsin, alaska, massachusetts MIGRATED (wave 2)** — wisconsin `sponsor_*`, alaska `candidate_filer_id` link + `outside_group_id`/`outside_group_name` (first `linkIdentityColumn` consumer), massachusetts `candidate_cpf_id` + `iepac_cpf_id`/`iepac_name`, all donor-only evidence; alaska helper-copy edge behaviors ("" and trunc) documented as an unobservable no-op delta. **districtOfColumbia MIGRATED** — `committeeColumn: "committee_key"` alone (verified: OCF keys link + both outside relations by `committee_key`), everything else shared defaults; pin written first (DC had zero loader tests); one accepted no-op delta — bespoke hardcoded evidence `organization_type: "donor"`, shared reads `category_type`, unreachable because migration 120 constrains DC outside breakdowns to `('donor', 'industry')` and the shared writer's type is the same, so evidence rows are always `donor`. Identity rename **plus another blocker**: **louisiana DROPPED** — its loader opens a `BEGIN READ ONLY` transaction when handed a Pool (one-state, grep-verified; stays bespoke per the working rules); **vermont MIGRATED** — first state combining `linkIdentityColumn` + `outsideGroupIdentityColumns` (`filer_registration_guid` everywhere, `filer_name`) with donor-only evidence, `directBreakdownCategoryTypes: ["contribution_size"]`, and the PAC `outsideSupportActionLabel`; newYork (direct-breakdown `industry` routing to `direct_campaign.top_industries`), tennessee (+`expenditure_count` outside-group column + trimmed summary), oregon/pennsylvania (outside totals aggregated with sum-CASE instead of `max`), michigan (+`candidate_loan_total` summary column), newJersey (`::text`-cast entity columns).
- **Query-family subsets**: minnesota (no direct-breakdown query), california/newJersey/newMexico (4 queries, no donor evidence), colorado/connecticut/nebraska/indiana/oklahoma/virginia (2 queries, direct-only, each trimming different summary columns), utah (3 queries, alternate outside tables).
- **Direct-breakdown `category_type` filters**: standard `('occupation','contribution_size')`; `('occupation','industry')` california/colorado/connecticut/nebraska/newMexico; `('contribution_size','industry')` newYork; `= 'contribution_size'` louisiana/vermont/utah; indiana adds `pac_backed_industry`; newJersey adds `employer`. Several of these also route output differently (e.g. nebraska fills `direct_campaign.top_industries`, leaves `total_spent` null).
- **Structural outliers**: kentucky (extra dedup CTE in donor evidence), newYorkCity/losAngelesCity (city shapes), newYorkCombined (aggregator, no SQL), florida (no loader file).

## BatchSync due-list queries (Phase 2)

Every non-city batchSync exports `listDue<State>CandidateFinanceSyncRows(db, {now, staleAfterDays, maxCandidates, electionLookbackDays, electionLookaheadDays})` returning `{rows, totalDueRows}` built on one `WITH due AS (…)` template; houston is the exception (no due CTE, different function shape). Normalized diff of all 33 templates against Texas (2026-08-02):

- **Byte-identical modulo link/summary table names + state code (8)**: indiana, maine, maryland, minnesota, nebraska, newMexico, oklahoma, texas.
- **Column-list-only deltas** — plain `link.<col>` swaps/additions in the slot between `district` and `source_url` (12): alaska (`candidate_filer_id`/`candidate_filer_name`, +`link_source`), districtOfColumbia (`committee_key`), hawaii (+`election_period`), illinois (`sbe_candidate_id`,`sbe_district_type`,`sbe_office`,`is_at_large`,`committee_key`), louisiana (`filer_number`/`filer_name`), massachusetts (`candidate_cpf_id`, +`filer_name`), newYork (`filer_id`/`filer_name`), tennessee (`camp_candidate_id`, +`owner_name`,`link_source`,`report_list_url`), utah (`folder_id`), vermont (`filer_registration_guid`,`entity_id`,`filer_name`), virginia (+`committee_code`,`link_source`), wisconsin (+`entity_id`,`assigned_committee_id`).
- **Real deltas beyond the column list**: arizona (inner `JOIN offices` — functionally equivalent under the office-key filter — plus `concat_ws` name fallback, which is NOT equivalent when one name part is NULL, +`link_source`); michigan (extra `$7` param: `link.election_year > $7`); oregon (extra `nullif(trim(link.source_url), '') IS NOT NULL`); kentucky (`district AS location`, +`election_date`, `candidate_key`, `committee_key`); washington (`district AS legislative_district`, +`filer_id`,`candidacy_id`); pennsylvania (+`link.id::text AS link_id` alias, `filer_id`/`filer_name`); florida (+`candidate_election_id`, drops `office_scope` from the select); california/colorado/connecticut (no offices join, no office-key filter; california/colorado also drop `district`/`office_scope`); newJersey (starts from candidate_elections with a `LEFT JOIN LATERAL` newest-active-link, whitespace-normalized office keys, link_status filter inside the lateral); newYorkCity/losAngelesCity/houston (city outliers / no CTE).

The shared builder (`createStandardStateFinanceDueListQuery` in `finance/standardStateFinanceDueListQuery.ts`, Phase 2 builder PR) covers the first two groups: config `{state, tables: {links, summaries}, eligibleOfficeKeys, linkColumns?, mapRow?}`, canonical defaults, byte-identical to the bespoke Texas SQL under canonical config (verified). Real-delta states migrate only if their delta lands behind config in its own PR — or they keep their bespoke query.

**The 8-state canonical cohort is migrated** (single PR after the builder PR): their `listDue*` exports are builder instances under canonical config, due-row types alias `StandardStateFinanceDueRow`, private query-row types and `parseTotalDueRows`/`mapDueRow` helpers deleted. Per-state parity verified: emitted SQL byte-identical to the pre-migration template from main, parameters and mapping equal; per-state batchSync tests unmodified. The 12-state column-list cohort is next (each needs `linkColumns` + a state `mapRow`); **districtOfColumbia is migrated as its pilot** (`committee_key` swap, same byte-parity proof); **wave 1 followed**: hawaii, virginia, wisconsin, utah, louisiana, newYork (mapper quirks preserved: hawaii/virginia district normalizers, virginia's typed `link_source`, louisiana's Set office-keys spread once). **Wave 2 closed the cohort**: alaska, illinois, massachusetts, tennessee, vermont (quirks preserved: massachusetts `normalizeMassachusettsOcpfDistrict`, tennessee trim-to-null `normalizeDistrict` + nullable `committee_name` + typed `link_source`, alaska typed `link_source`, illinois nullable SBE columns, vermont numeric `entity_id`). The single non-byte delta of the entire migration: tennessee's `report_list_url` moved from after `source_url` into the link-column slot — column-order only, rows read by name. **All 20 builder-eligible due-lists now run the shared builder**; the 11 real-delta states (arizona, michigan, oregon, kentucky, washington, pennsylvania, florida, california, colorado, connecticut, newJersey) keep bespoke queries unless their delta lands behind config in its own PR.

## Auto-link shape

- **Standalone file with resolve + write** (wrapper-equivalent candidates): 26 modules.
- **File without link-writing**: illinois (resolve-only), michigan (list-only).
- **Embedded in batchSync, no file**: arizona, maryland, vermont (vermont adds statewide-only safety logic).
- **No auto-link at all**: newJersey, newYorkCity, utah.

## Transaction-ownership note

`self` writers (california, colorado, connecticut, indiana, losAngelesCity, nebraska, newMexico, newYorkCity, oklahoma, tennessee, utah, virginia) open their own transaction only when handed a Pool; on a client they run **without** a wrapping transaction (assumed caller-owned). The factory instead throws on non-Pool input. Migrating a `self` writer to the factory changes this contract — check each one's callers (the `cycleArtifactRows` batch cohort passes clients: colorado, indiana, maine*, maryland*, nebraska, newMexico, oklahoma — *maine/maryland are `pool` writers, so their batch paths must already cope; verify when they migrate).

## Test coverage (per module)

| Role | Have tests | Missing |
|---|---|---|
| Writer | 34 of 34 (minnesota added in PR #488) | — |
| Ballot-lookup loader | 10 of 31 with loader files | 21 modules — characterization tests required before each loader cohort migrates |
| Auto-link | 25 of 28 files | illinois, michigan + 1 |
| BatchSync | 34 of 34 | — |

The factory itself has a dedicated config-option test file (`tests/pipeline/finance/standardStateFinanceSnapshotWriter.test.ts`, PR #488) alongside the Texas/Houston wrapper tests.

## Cohort readout (feeds plan phases)

- **Phase 1 pilot (exact canonical shape)**: **arizona** — the only state with canonical link columns, all 5 tables, factory-canonical outside identity, merge `R`, std categories, `pool` tx. The factory prereqs (per-field merge policy, required floor, presence check `g`) shipped in PR #488. Oregon was originally listed as a co-pilot but is disqualified: its outside tables use `sponsor_id`/`sponsor_name` and its exported types use `sponsorId` fields.
- **Phase 1 second wave (factory-canonical outside identity only)**: maine, maryland (`G`+`N` + `R+oC` policy + same-source supersession — factory prereqs `normalizeCommitteeId` + `supersededLinkSource` shipped in the second-wave prep PR). **michigan is deferred to Phase 5**: its `candidate_loan_total` summary column is a one-state capability (grep-verified 2026-08-01 — no other writer has it), and the plan's working rule keeps one-state features out of the factory; its manual-link protection `M` need is covered by the factory since PR #667. The outside-identity renames (`sponsor_id`, `group_id`, `iepac_cpf_id`, `outside_group_id`, `filer_number`) are covered by `outsideGroupIdentityColumns` since PR #509 — **oregon migrated onto the factory** (third wave: sponsor identity columns + `sponsorId`/`sponsorName` field mapping in the wrapper, `presence` validation kept — its cascade-FK stale-group window predates the migration, same standing decision as Texas/Houston). Link-identity renames are covered by `linkIdentityColumns` since the link-identity PR — fourth wave: **districtOfColumbia migrated** (`committee_key` for both relations, COALESCE-default policy, pairing; the bespoke writer normalized OUTSIDE keys only — the link key stays raw-trimmed, so the wrapper normalizes in its field mapping instead of using `normalizeCommitteeId`; legacy quirk preserved: an empty-but-present groups list with breakdowns throws the pairing message, not the presence one). **alaska is DROPPED from the wave** (2026-08-02 source audit, Michigan pattern): its writer deletes the summary row when no summary is supplied and runs unconditional stale deletes for omitted sections — full-replace snapshot semantics the factory cannot model without a one-state option (grep-verified: no other writer deletes summary rows). Per the working rules it keeps its bespoke writer; identity columns were never its only delta, the matrix merge column just couldn't express delete-when-absent. The rest still need factory work: washington/wisconsin (extra link columns), massachusetts (extra `filer_name` column), louisiana (signed `cash_on_hand` + extra direct category types), florida (extra table). pennsylvania's only listed gap (manual-link protection) is factory-covered since PR #667 — re-verify its writer for other deltas before migrating.
- **Deferred writer families (Phase 5)**: michigan (`candidate_loan_total`; its manual-link protection is factory-covered since PR #667), california, illinois, hawaii, kentucky, vermont, wisconsin, washington, newJersey, tennessee (extra columns/fields); colorado, connecticut, indiana, nebraska, oklahoma, virginia (3-table direct-only + reduced summary sets); minnesota (no direct table); utah (alt outside tables); city outliers (nyc, losAngelesCity) stay bespoke.
- **Loader cohorts**: uniform-identity `committee_id` states first (hawaii, maine, maryland, michigan, minnesota, newMexico + direct-only colorado, connecticut, indiana, nebraska, oklahoma, virginia); then `committee_key` (dc, kentucky); mixed-identity and renamed states after the per-relation descriptor exists; alaska/arizona/pennsylvania (nonstandard filenames) and florida (no loader) resolved case-by-case.

## Post-pause-point modules (added 2026-09-04, plan v3 addendum)

Hand-verified from each module's writer/loader/due-list files. Legend: **W** = writer-factory wrapper, **L** = shared-loader wrapper, **D** = due-list builder config, **D\*** = bespoke due list that was the builder + `election_stage='general'` (Phase 2b cohort, six states — all migrated to **D** by 2026-09-05), **AL/BS/SCH** = auto-link / batchSync / scheduler file present. Writer options listed only where set.

| Module | Lines | Tables | W | L | D | AL/BS/SCH | Writer options | Loader options |
|---|---|---|---|---|---|---|---|---|
| ohio | 6,355 | `oh_` 5 | W | L | D (in batchSync) | 1/1/1 | floor 2000, pairing, `sos_bulk_export` supersession | donor-only evidence |
| northCarolina | 7,024 | `nc_` 5 | W | L | D (in batchSync) | 1/1/1 | floor 2000, pairing, `ncsbe_portal` supersession | donor-only evidence |
| georgia | 4,569 | `ga_` 5 | W | L | D | 1/1/1 | floor 2026, signed cash, pairing, `peachfile_api` supersession | donor-only evidence |
| rhodeIsland | 4,251 | `ri_` 5 | W | L | — (import-style) | 1/0/0 | floor 2026, signed cash, pairing, `erts_portal` supersession | donor-only, `contribution_size` only |
| missouri | 4,702 | `mo_` 5 | W | L | D (`electionStage: "general"`, `selectElectionDate`, `linkColumns` +`link_source`, DIRECT office subset; migrated 2026-09-04) | 1/1/1 | floor 2024, pairing, `mec_portal` supersession, M+ | donor-only, PAC action label |
| newHampshire | 4,056 | `nh_` 5 | W | L | bespoke — **stays** (general-stage shape plus a `candidateNames[]` spelling list that `chooseSyncCandidateName` verifies against the linked filer; one-state, load-bearing) | 1/1/0 | floor 2016, M+, `cfs_registration` supersession | `linkIdentityColumn: filing_entity_id`, `industry`+`contribution_size`, donor-only |
| delaware | 3,896 | `de_` 5 | W | L | D (`electionStage: "general"`, `selectElectionDate`, `linkColumns` +`link_source`, `committee_id` → `cfId`; migrated 2026-09-04) | 1/1/0 | floor 2026, `cfrs_portal` supersession, M+ | defaults |
| nevada | 1,879 | `nv_` 5 | W | L | — (import-style) | 0/0/0 | floor 2004, M+, `aurora_search` supersession | `linkIdentityColumn: filer_key`, `industry`+`contribution_size`, donor-only |
| montana | 5,070 | `mt_` 5 | W | L | D (`electionStage: "general"`, `selectElectionDate`, `linkColumns` +`link_source`; Phase 2b pilot, migrated 2026-09-04) | 1/1/1 | floor 2024, pairing, `cers_portal` supersession, M+ | donor-only |
| arkansas | 3,373 | `ar_` 5 | W | L | D | 1/1/0 | floor 2026, signed cash, M+ | `linkIdentityColumn: filing_entity_id` |
| westVirginia | 3,805 | `wv_` 5 | W | L | D | 1/1/0 | floor 2026, M+, `cfrs_registry` supersession | `occupation`+`industry`+`contribution_size` |
| idaho | 3,819 | `id_` 5 | W | L | D (`electionStage: "general"`, `selectElectionDate`, `linkColumns` `registration_guid`/`filer_name`/`link_source`, guid normalized in `mapRow`; migrated 2026-09-05) | 1/1/0 | floor 2026, signed cash, M+ | `linkIdentityColumn: registration_guid`, `contribution_size` only, donor-only |
| northDakota | 4,827 | `nd_` 5 | W | L | D | 1/1/0 | floor 2026, pairing, M+ | `occupation`+`contribution_size` |
| kansas | 5,625 | `ks_` 5 | W | **none yet** (not in registry) | D | 1/1/0 | floor 2024, pairing, `cfr_viewer` supersession, M+ | — |
| alabama | 3,481 | `al_` 5 | W | L | D (`electionStage: "general"`, `selectBallotTitle`, no `election_date`, `linkColumns` +`fcpa_committee_number`/`link_source`; migrated 2026-09-05) | 1/1/0 | floor 2024, M+, `fcpa_race_search` supersession | defaults |
| southCarolina | 2,691 | `sc_` 5 | W | L | D (`electionStage: "general"`, `selectElectionDate`, `linkColumns` `candidate_filer_id`/`candidate_filer_name`/`link_source`, filer id parsed in `mapRow`; migrated 2026-09-05) | 1/1/1 | floor 2008, signed cash, M+, `ethics_filer_search` supersession | `linkIdentityColumn: candidate_filer_id` |
| austin (city) | 3,588 | city | bespoke | L | D | 1/1/0 | — | — |
| denver (city) | 3,018 | city | bespoke | L | D | 1/1/0 | — | — |
| phoenix, sanDiegoCity, sanJose, sanFrancisco (cities) | 4,491 / 3,446 / 3,101 / 4,065 | city | bespoke | bespoke | bespoke | 1/1/0 · 1/1/0 · 1/1/0 · 1/1/1 | — | — |

Phase 2b cohort (six states): **all migrated** — montana (pilot), missouri, delaware on 2026-09-04; idaho, southCarolina, alabama on 2026-09-05 (`selectBallotTitle` landed with alabama). newHampshire is excluded (see its row). Normalized WHERE/JOIN/ORDER clauses of all seven files, newHampshire included, are identical — the exclusion is about its projection, not its predicates.
