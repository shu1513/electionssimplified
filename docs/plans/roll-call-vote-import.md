# Roll-call vote import (bill → legislators → candidate records)

Status: research + design, 2026-08-22. No code yet.

## Idea

Today records are found per candidate (one search per person). Flip it: take one
roll-call vote, which already lists how every member of a chamber voted, judge
that ROLL CALL once (what it decided, which research area, which way is "for"),
then fan that judgment out to every member who is already a candidate in our
DB. One judgment → up to 435 records. Dedupe against the candidate's existing records
before writing.

## What the DB already has (verified 2026-08-22, local)

- `candidate_records` columns: `candidate_id, description, source_url, event_date,
  record_identity_key, origin (ai_enricher|repair|manual), origin_run_id,
  retired_at, retired_reason`. Unique on `(candidate_id, record_identity_key)`
  where the key = md5 of normalized `source_url | event_date | description`
  (`backend/src/pipeline/candidates/candidateRecordStore.ts:143-156`).
- Labels live in `candidate_record_area_tags (record_id, research_area_id,
  stance for|against|NULL)`; 27 slugs in `db/seeds/research_areas_v1.sql`
  (e.g. `womens_reproductive_rights`, `gun_control`, `immigration`). Federal
  offices use an 18-slug subset.
- Writer: `upsertCandidateRecords` — same candidate + same date + same URL +
  description token-F1 ≥ 0.86 → update in place; else insert. Manual CLI:
  `npm run manual:candidate-records:write --records-file --labels-file`.
- Source policy: any `*.gov` is auto-listed; `legiscan.com`, `openstates.org`,
  `govtrack.us`, `votesmart.org` are on the founding allowlist; `voteview.com`
  is not (unlisted = still accepted unless damaging-claim pattern).
- Candidates carry NO bioguide / OpenStates / LegiScan ids. Only `fec_ids`,
  `state_filing_ids`, `current_office` (free text like `PA State Representative`),
  `has_held_public_office`. Districts are named
  `State House District 83 (2024); Texas` / `Congressional District 7 (119th
  Congress), Massachusetts`, with `geoid_compact` (`48083`, `2507`).
- Nov-2026 candidates with `has_held_public_office`: us_house 118,
  state_upper 563, state_lower 2,094 (33 states). US Senate incumbents sit under
  `statewide`.
- 448 live records across 84 candidates already cite
  `clerk.house.gov/evs/<year>/rollNNN.xml` or
  `senate.gov/legislative/LIS/roll_call_votes/.../vote_CCC_S_NNNNN.htm` — written
  by hand through the skill. Note they mix `.htm` and `.xml` URLs, so URL-based
  dedupe alone will miss them.

## Sources (verified first-hand unless noted)

### US House — use Clerk static XML (primary)

- Index: `https://clerk.house.gov/evs/<year>/ROLL_<000|100|200|...>.asp` (one
  row per roll: number, date, bill, question, result).
- Vote: `https://clerk.house.gov/evs/<year>/roll<NNN>.xml`. Fields:
  `rollcall-num, legis-num (e.g. "S 1582"), vote-question ("On Passage"),
  vote-type (YEA-AND-NAY, RECORDED VOTE, QUORUM, 2/3 ...), vote-result,
  action-date ("17-Jul-2025"), vote-desc ("GENIUS Act")`, then 435
  `<recorded-vote><legislator name-id="A000370" party="D" state="NC">…</legislator><vote>Aye|No|Yea|Nay|Present|Not Voting</vote>`.
  `name-id` = bioguide id. Plain curl, no key, no block, validator-reachable.
- Backup / richer metadata: Congress.gov API `/v3/house-vote/{congress}/{session}`
  and `/…/{roll}/members` (bioguideID, voteCast, voteParty, voteState,
  legislationType/Number, voteQuestion, amendment fields). ChangeLog says the
  beta label was dropped (the endpoint doc page is stale and still says beta
  / 118th–119th only); live list counts returned votes for the 115th–117th —
  probe coverage per Congress before any historical expansion.
  No date filter — iterate congress/session/roll. `format=json` must be passed
  (default is XML). 5,000 req/hour per key; keys already in main `backend/.env`
  (`CONGRESS_GOV_API_KEY_1/2`). `congress.gov` blocks the record validator, so
  never use it as `source_url` — cite the Clerk XML (which is exactly the
  `sourceDataURL` the API itself returns).

### US Senate — senate.gov LIS XML (only structured source)

- Menu per session: `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_<congress>_<session>.xml`
  (659 votes in 119-1; each has `vote_number, vote_date, issue (S.5 / PN373 /
  H.R.1), question, result, title`).
- Vote: `https://www.senate.gov/legislative/LIS/roll_call_votes/vote<congress><session>/vote_<congress>_<session>_<NNNNN>.xml`
  → 100 `<member>` rows with `last_name, first_name, party, state,
  vote_cast (Yea|Nay|Not Voting|Present), lis_member_id (S370)`.
- Congress.gov API has NO Senate vote endpoint (`/senate-vote/119/1` → 404,
  checked Aug 2026). Senate rolls can still be DISCOVERED per bill through
  `/v3/bill/{congress}/{type}/{n}/actions` → `recordedVotes[].url`, which
  points at the senate.gov XML above.

### Federal member crosswalk — `unitedstates/congress-legislators`

- `https://unitedstates.github.io/congress-legislators/legislators-current.yaml`
  (+ `legislators-historical.yaml`). Per person: `bioguide, lis, govtrack,
  opensecrets, votesmart, fec[], ballotpedia, wikidata, icpsr`, plus `terms[]`
  with `type, start, end, state, district, party`. CC0. Actively maintained
  (commits 2026-08-19).
- This gives: bioguide ↔ LIS id ↔ FEC id. Our `candidates.fec_ids` is the hook
  for an exact match. Name + state + district is never an auto-attach path;
  it only feeds the manual-resolution report (see Design §2).

### Bill meaning (what the vote was about)

- Congress.gov API `/v3/bill/{congress}/{type}/{number}` (+ `/summaries`,
  `/subjects`): title, CRS summary, `policyArea`, legislative subjects. This is
  the best plain-English source for the description and the research-area
  label.
- Voteview `https://voteview.com/static/data/out/rollcalls/H119_rollcalls.csv`
  has `vote_desc, vote_question, bill_number, clerk_rollnumber` per roll (JSON
  variant adds `crs_policy_area`), and `members/HS119_members.csv` maps
  `icpsr → bioguide_id` (554/555 rows; better than congress-legislators, whose
  `icpsr` is empty for all 79 freshmen). Near-live, 1789–present, citation
  only, no license page. Join on `clerk_rollnumber`, NOT `rollnumber`
  (cumulative across the Congress). Good cross-check / backfill index.

### Dead / avoid

- ProPublica Congress API: shut down 2024-07-10, no new keys.
- GovTrack: bulk data ended 2017; `https://www.govtrack.us/api/v2/vote` still
  answers but is unsupported AND `govtrack.us/legal` forbids using its data
  "for the development of any software program" — do not use, even as a
  cross-check. (Its founding-allowlist entry is fine for hand-cited URLs only.) `unitedstates/congress` scrapers (CC0, last commit
  2025-10) still produce vote JSON for both chambers if we ever want a mirror.
- govinfo / GPO: no roll-call collection at all (BILLSTATUS XML only indexes
  `recordedVotes`).
- Ballotpedia: bot-blocked, paid API; human cross-check only.
- VoteSmart: API alive but skill already found service-period and
  identity-contamination bugs in its key-vote archive.

### State legislatures

Two aggregators cover all 50 states; only ~10 states publish real
machine-readable per-member votes themselves.

Official state sources with per-member votes (all probed live 2026-08-22):

| State | Endpoint | Notes |
|---|---|---|
| VA | `https://lis.blob.core.windows.net/lisfiles/20261/VOTE.CSV` | Best in country. Floor + committee, member codes `H0386`,`Y/N/X`; joins to `Members.csv`. No auth. |
| WA | `https://wslwebservices.leg.wa.gov/LegislationService.asmx/GetRollCalls?biennium=2025-26&billNumber=1240` (integer) | Per-member `MemberId`; element misspelled `<VOte>`; use plain GET not SOAP. |
| OR | `https://api.oregonlegislature.gov/odata/ODataService.svc/MeasureVotes` (+`CommitteeVotes`) | OData JSON; `VoteName` abbreviated string. |
| NJ | `https://pub.njleg.gov/votes/A2026.zip` | Daily zipped CSV, 1988–present, `Full_Name`, `Legislator_Vote`. |
| OH | `https://search-prod.lis.state.oh.us/api/v2/general_assembly_136/legislation/hb96/actions/` | Verified: each action has `yeas[]`/`nays[]` of lpids like `sen_wilson_steve_1`; floor + committee; undocumented, no auth, trailing slash required. |
| GA | `http://webservices.legis.ga.gov/GGAServices/Votes/Service.svc` | SOAP, numeric member ids; https times out. |
| CA | `https://downloads.leginfo.legislature.ca.gov/pubinfo_daily_Mon.zip` (both `pubinfo_<Day>.zip` and `pubinfo_daily_<Day>.zip` are listed) | `BILL_DETAIL_VOTE_TBL` one row per legislator, last-name join only. |
| NY Senate | `https://legislation.nysenate.gov/api/3/bills/2025/S1` | Free key; `memberVotes` with permanent `memberId`; Assembly NOT covered. |
| MA Senate | `https://malegislature.gov/api/GeneralCourts/193/Branches/Senate/RollCalls/5` | House roll calls = journal pages, no API. |
| MN House | `https://www.house.mn.gov/Votes/Details?SessionKey=302&BillNumber=HF1486` | HTML; Senate = journal PDFs only. |
| IN | `https://api.iga.in.gov/2026/rollcalls` | UNVERIFIED: needs emailed token; payload shape unknown. |

Structured-HTML scrape tier: WI, NC, OK, TN, FL House, PA, MI (journal HTML),
CO (vote pages, surnames only). PDF-only: MD, CT, KY, LA, NM, SC, IA, KS, FL
Senate, IL, TX. TX/PA/KS/MD/UT have APIs or bulk files with tallies but no
member positions. Stable numeric member ids exist only in VA, WA, GA, NY
Senate, OR; everywhere else = surname matching (`Bell, C.` / `Bell, K.`).

- **Open States / Plural** (`https://v3.openstates.org`, OpenAPI at
  `/openapi.json`). `GET /bills?jurisdiction=…&include=votes,actions,abstracts`
  → `VoteEvent {motion_text, motion_classification[], start_date, result,
  counts[], votes[{option, voter_name, voter{id,name}}]}`. Person ids are
  `ocd-person/<uuid>`; `https://data.openstates.org/people/current/<st>.csv` is
  public (no login) with `current_district, current_chamber, current_party,
  wikidata`. All 53 jurisdictions have VoteEvent code in the scraper repo, but
  completeness varies by state (report card: points deducted "often for roll
  call votes"; HI and MN flagged for no stand-alone roll calls). Public domain.
  Free key = 250 req/day (api-v3 `auth.py`; docs say 500 — treat 250 as
  real), 20 bills/page → API is useless for bulk; session CSV bulk needs a
  login (`vote_people.csv` has `voter_id`; the JSON export DROPS it); monthly
  `pgdump` at `https://data.openstates.org/postgres/monthly/` is ungated
  (~10 GB). Scrapers repo: 50 jurisdictions emit per-person votes; AK, MN, SC
  tallies only. Project alive but thin (Plural bought by SAI360 2025-12;
  public bill pages turned off 2026-01). `motion_classification` is
  near-useless: 31 scrapers hardcode `passage` on every vote.
- **LegiScan** (`https://api.legiscan.com/?key=…&op=getRollCall&id=…`).
  `getRollCall` → `date, desc, yea/nay/nv/absent, passed, chamber, votes[{people_id,
  vote_id, vote_text}]`; `getPerson` → `name, party, role, district ("HD-030"),
  votesmart_id, ballotpedia, opensecrets_id, followthemoney_eid`; `getBill` →
  `title, description, status (4 Passed, 5 Vetoed), progress[], history[]`,
  `votes[]` summary. Free public key: 30,000 queries/month; weekly bulk ZIP
  datasets per session (`getDatasetList`/`getDataset`) cover every getBill /
  getRollCall / getPerson payload, so the free tier is enough if we use bulk.
  Covers all 50 states + Congress (`US`). Bulk datasets are licensed
  **CC BY 4.0** (stated on `legiscan.com/datasets`); API page says data may
  power commercial/public products. No "list roll calls for a session" op —
  roll-call ids come from `getBill.votes[]`, so use the weekly bulk ZIP rather
  than walking bills by API. `getPerson` has no bioguide id (bridge federal via
  `votesmart_id` → congress-legislators). Citing a
  `legiscan.com/<ST>/rollcall/<bill>/id/<n>` page as `source_url` is fine
  (domain is allowlisted).
- LegiScan details that matter: `vote_id` 1 Yea / 2 Nay / 3 NV-abstain /
  4 absent-excused (absent vs excused collapsed); `getPerson` returns CURRENT
  party/district → store per-session snapshots from the dataset, never join
  a 2019 vote to today's district; `desc` has no convention (`Read 3rd
  time`, `House Passed`, `Passage: House Vote #243`, `FP`, TX = bare
  `RV#105`) so final-passage detection = per-state regex + compare `total`
  to chamber size (12 votes in a 100-seat chamber = committee). `description`
  is a real synopsis only in some states (MD, VA yes; CA, GA, TX = legal
  title) — allowlist per state. Weekly national bulk refresh ≈ 230 of the
  30,000 free monthly queries. Paid: Pull $1k (1 state) → $6k (50+), Push
  $2k → $12k/yr.
- Recommendation: LegiScan bulk datasets as the spine (uniform schema, roll
  calls everywhere they exist, CC BY 4.0); Open States people YAML (CC0,
  `ocd-person` ids survive chamber/district changes; bridge to LegiScan via
  `votesmart_id`) as the identity layer; VA `VOTE.CSV` + WA `GetRollCalls`
  as ground truth to validate the classifier; official state bill pages as
  the `source_url` where the skill already proved them validator-reachable
  (`capitol.texas.gov`, `leginfo.legislature.ca.gov`, …; for Michigan the
  skill cites `michiganvotes.org` — a Mackinac Center project, NOT official —
  only because `legislature.mi.gov` fails the validator's TLS check), else
  the `legiscan.com/<ST>/rollcall/...` page. BillTrack50 ($5k/yr, only
  vendor with published price + documented vote endpoints, 24h cache rule)
  is the fallback if we'd rather not maintain ingestion.

### Governors

No vote to import. Structured equivalent = bill signings / vetoes:
Open States action classifications `executive-signature`, `executive-veto`,
`executive-veto-line-item`, `became-law` (signature OR inaction — ambiguous);
LegiScan `status 5 = Vetoed`, history text `"Vetoed by Governor"`. Neither
names the governor → join on state + date against our own governor roster.
Best official feeds: WA (`GetLegislationGovernorSigned/Veto/PartialVeto`
SOAP), NY (`legislation.nysenate.gov` JSON with `signer`), CA
(`VETO_MESSAGE_TBL` in leginfo bulk). Treat as a later phase.

## Design

Review unit = ONE ROLL CALL, not a bill. A bill gets many materially
different votes (rule, amendment, recommit, passage, concurrence, conference
report, override) on different text versions. Bill metadata (title, CRS
summary, policy area) is fetched once into a reusable dossier; the judgment
(sentences + labels) is made and approved per roll call. "One AI call per
bill" is only a cache, never the correctness boundary.

### 1. Pick the votes (queue, then judgment)

The skill's rule stands: "the test is the ITEM, never the tally". So do NOT
import every roll call. Regex builds a queue; it never decides truth.

1. Pull the index (House ROLL_*.asp / Senate vote_menu / LegiScan bulk).
2. Narrow final-action patterns → queue. Measured on House 2025 rolls 1–362:
   98 `On Passage`, 79 `On Motion to Suspend the Rules and Pass[, as Amended]`,
   49 amendment, 42 `On Agreeing to the Resolution` (39 of them H.Res =
   mostly special rules for debate), 33 previous question, 29 recommit.
   - House keep: `On Passage`, `On Motion to Suspend the Rules and Pass`
     (+ `, as Amended`), `On Motion to Concur in the Senate Amendment`,
     `On Agreeing to the Conference Report`, `On Passage, Objections of the
     President Notwithstanding`. Default-exclude: everything on H.Res /
     H.Con.Res (`On Agreeing to the Resolution` is usually a rule), amendments,
     previous question, recommit, table, adjourn, quorum, Speaker election.
   - Senate keep: `On Passage of the Bill`, `On the Joint Resolution`, `On the
     Conference Report`, `On Overriding the Veto`. Default-exclude: cloture,
     motions to table/proceed, nominations (`PN…`), S.Res.
   - States (LegiScan `desc` / Open States `motion_text`): per-state regex
     for third reading / final passage / concurrence / override.
   - Committee votes are rejected BEFORE the queue via `is_floor_vote` on
     `legislative_votes`, derived per source: House/Senate XML are floor-only
     by construction; OH actions carry `cmte_name`; VA `VOTE.CSV` and WA
     `GetRollCalls` mark committee rows; LegiScan has no flag, so there
     `is_floor_vote` comes from the `desc` regex plus `total` vs chamber
     size, and anything unresolved stays `null` = excluded, not queued.
   - Exceptions (an impeachment H.Res, a war-powers H.Con.Res, a named
     nomination) enter only by explicit hand add, never by regex.
3. Drop trivia from the queue: post-office namings, commemoratives,
   suspension bills with no policy area of interest.
4. Judgment per roll call, written by the operator (the Claude session
   working with the user — no AI provider call; see Decisions 2026-08-23)
   from the bill page / CRS summary + exact question + voted text version:
   the yea sentence, the nay sentence, research-area slug(s), and which
   option = `for` per slug (yea ≠ `for` by default — depends on the slug's
   goal). Recorded in `judgments.json` under the run's evidence dir and
   applied with `rollcall:judge`, which stores them on the
   `legislative_votes` row.
5. Review per roll call before fan-out (a bad template replicates ×435):
   exact question + version, source excerpt or CRS summary, both sentences,
   every label/stance, a sample of resolved identities
   (`rollcall:resolve`). The judgments file carries the decision
   (`review_status`: `approved` / `pending`); the committed file is the
   review artifact.

### 2. Resolve members to candidates

- Federal: `legislators-current.yaml` + `legislators-historical.yaml`
  (pin the commit sha per run) → bioguide / LIS → `fec[]` → exact match on
  `candidates.fec_ids`. Local check 2026-08-22: 118/118 House and 32/32
  Senate Nov-2026 officeholders carry `fec_ids`, so exact-only is viable.
  Verify chamber, state, district, and that the vote date falls inside a
  `terms[]` window. Name/state/district matching produces a manual-resolution
  REPORT only; nothing auto-attaches on a name.
- State: LegiScan `getPerson` (`district "HD-030"`) / Open States people CSV
  → state + chamber + district number (parsed from `State House District 83
  (2024); Texas`) + name tokens; confidence threshold; below it → report.
  No new id table in phase 1 (`fec_ids` suffices federally). Add a
  `candidate_external_ids (candidate_id, scheme, identifier, jurisdiction,
  valid_from, valid_to, source)` table only when state imports start.
- Only candidates on a Nov-2026-or-later election are in scope.

### 3. Generate + dedupe + write

- Description per roll call, two variants (no name in the text). The opener
  follows the question class, not a generic "voted for": `Voted to pass
  <bill id>, the <short title>, which <one-line effect>…` / `Voted against
  passing…`; `Voted to concur in the Senate amendment to…`; `Voted to adopt
  the conference report on…`; `Voted to override the veto of…`; suspension
  votes read as passage. Tally closes the record: `It passed/failed the
  House/Senate <yeas>-<nays>.` Past tense, ≤ 2 sentences, no modals (quality
  gate rejects `future_promise`). **Hard gate since 2026-09-13** (every state
  had drifted to 6-sentence bill digests): `rollcall:judge` and
  `rollcall:rewrite` refuse a description over 3 sentences, 320 characters,
  or 30 words in one sentence (`rollCallDescriptionLength.ts`). The one-line
  effect says what changes for people — who pays, who is covered, what is
  now allowed or banned — not the bill's mechanics; the reader who wants
  the mechanics has the bill link. Reword approved rolls with
  `rollcall:export-rewrites` → edit → `rollcall:rewrite` (wording-only:
  labels, dates, and review status stay; fan-out records are rewritten in
  place with identity transitions). Say "passed the House", never "became law",
  unless the bill was enacted. Omnibus votes get only the dominant slug(s),
  not every provision. `Not Voting` / `Present` rows are skipped.
- `source_url` = Clerk XML / Senate XML / state roll-call page; `event_date` =
  vote date. One URL per record is the existing contract, and the roll-call
  page proves the decisive claim (how the member voted). The "which
  <effect>" clause is therefore kept to the bill's official title / CRS
  summary gist — nothing a reader could not confirm from the bill itself —
  and the bill page URL lives on `legislative_votes.bill_url` for audit,
  exactly as the 448 existing hand-written roll-call records already do.
- Dedupe key = candidate + event_date + normalized bill id (`H.R. 3746`,
  `HR3746`, `H.Res. 863`, `S. 5`, `SB 5`) + question class, scanning live
  records on that date (URL compared with `.htm`↔`.xml` folded). Exactly one
  old row ↔ exactly one new roll call → duplicate. Anything else (several
  roll calls on the same bill and date matching one old row, OR one roll
  call matching several old rows on that candidate) → ambiguous → report, no
  write.
- Duplicates are REWRITTEN IN PLACE, not retired + reinserted. Migration 202
  defines retirement as "the claim was wrong"; migration 209 exists precisely
  for in-place rekeys that keep the row id, tags, and notification history
  (`user_candidate_follow_notification_events` FKs onto the record). The
  importer OWNS this update — it cannot go through `upsertCandidateRecords`,
  whose `findSimilarExistingRecord` requires an identical normalized URL
  (only trailing slashes stripped), so a `.htm`→`.xml` rewrite would insert a
  second row; and its transition reason is hardcoded `research_refresh`. So:
  `UPDATE … WHERE id = <matched record id>` setting `description`,
  `source_url`, `record_identity_key`, `origin`, `origin_run_id`; replace its
  area tags; `recordIdentityTransition(reason = 'rollcall_normalization')` —
  all in one transaction. Same end result the user wants (uniform wording +
  labels), no audit break. Pilot dry-run lists every match first;
  `--skip-existing` flag keeps old rows untouched.
- Notifications: `writeManualCandidateRecords.ts` calls
  `createCandidateRecordUpdateNotificationEvents` for every inserted record,
  and nothing downstream filters on `event_date`, so a 117th-Congress
  backfill would email followers about years-old votes. The importer
  notifies only for inserts whose vote date is within the last 30 days
  (new roll calls); backfill inserts and in-place rewrites never create
  notification events.
- Writer: a small dedicated importer (`src/scripts/importRollCallVotes.ts`),
  reusing the validator, label checks, `upsertCandidateRecords`, and the
  transaction pattern from `writeManualCandidateRecords.ts` — which is
  one-candidate-one-election per invocation and stamps manual provenance, so
  it cannot be the bulk path unchanged. New provenance value
  `origin = 'rollcall_import'` (migration widening the CHECK in 197, plus the
  `CandidateRecordOrigin` TS union) and transition reason
  `'rollcall_normalization'` (added to `RecordIdentityTransitionReason` in
  `candidateRecordStore.ts`);
  `origin_run_id = rollcall:<jurisdiction>:<chamber>:<session>:<roll>:<ts>`.
  Fan-out is atomic and idempotent per roll call; re-running an approved
  roll call writes nothing new.

### 4. Data model (phase 1)

```
legislative_votes
  jurisdiction, chamber, session (congress+session or state session)
  roll_number, vote_date, measure_id, exact_question, voted_text_version
  is_floor_vote (null = unknown = excluded)
  result, yeas, nays
  display_url, machine_url, bill_url, source_sha256, fetched_at
  yea_description, nay_description, labels_json
  review_status (pending|approved|rejected), reviewed_at
  importer_version
  UNIQUE (jurisdiction, chamber, session, roll_number)
```
Member rows are not stored. The fetched XML and the run report (resolutions,
skips, ambiguities, failures) go under `backend/evidence/rollcall/<run-id>/`
and are committed, like the other research campaigns' evidence ledgers. The
importer runs from a developer machine against the local DB (prod gets rows
via `research:promote`), so Render's lack of a persistent disk is not in
play; git is the durable store.

### 5. Phases

1. **Federal pilot**: 10–20 hand-picked 119th-Congress roll calls, clear
   final passage, mostly single-policy bills or CRA resolutions, both
   chambers, exact FEC matches only, Nov-2026 scope, dry-run before every
   write. Measure: match precision, unresolved rate, duplicate-detection
   precision, human rejection rate, label disagreement rate, re-run
   idempotency.
2. **Federal expansion** 119th → 118th/117th for candidates whose service
   overlaps.
3. **State pilot: Ohio.** Has Nov-2026 races (103 incumbents locally), an
   official JSON API with per-member floor + committee votes as ground truth
   (`…/legislation/<bill>/actions/` yeas/nays lpids, verified), and LegiScan
   as the spine. Not Virginia: its legislature has NO Nov-2026 election (odd
   years; 0 VA state incumbents in the Nov-2026 set). Not TX/PA: PDF-only,
   surname matching — the hardest case first.
4. **State rollout** across the 33 states with Nov-2026 incumbents.

Out of scope: voice votes (unrecorded), committee votes, amendment votes,
nominations, and governor sign/veto actions — the latter is a different
importer with different evidence (see "Governors" above for sources).

## Decisions (2026-08-22)

- One judgment per ROLL CALL (originally planned as a guarded AI run;
  superseded 2026-08-23, see below). Look at each roll call's two sentences
  + labels before fan-out.
- Duplicates of the 448 hand-written roll-call rows: replace — done as an
  in-place rewrite (row id kept, transition logged), not retire + reinsert.
- Review unit = roll call; federal matching = exact FEC id only; state pilot
  = Ohio; governors = separate future importer (2026-08-22 review).
- Judgment + review (PR 5, 2026-08-23): no AI provider call. The operator
  (Claude session + user) is both judge and reviewer, so the judgment pass is
  a committed `judgments.json` applied by `rollcall:judge`, not a guarded
  run. Each judgment names the measure and vote date it was written about,
  checked against the row under lock, so a mistyped roll number that lands
  on another roll call is refused. An approved row whose judgment changes
  is moved back to pending, rewritten, and re-approved in one transaction
  (the only path the freeze trigger allows); the next `rollcall:import`
  rewrites the fanned-out records in place. Approved → pending is refused
  once records have fanned out (the importer never withdraws records):
  replace the judgment, or retire the records first.
- Duplicate scan (PR 4, 2026-08-23): an old row is a duplicate only when its
  `source_url` IS this roll call (Clerk XML, Clerk vote page, Senate
  .htm/.xml — `rollCallUrlKey` folds them). The "bill id + question class"
  key was dropped: a free-text description has no reliable question class,
  so a same-day recommit vote on the same bill would have been rewritten
  into a passage record. Same-day rows that name the measure without citing
  the roll call (press-release citations) are listed in the report as
  `relatedRecordIds` for a human and never written.
- Pilot follow-ups (PR 6, 2026-08-23): the duplicate match also folds the
  Clerk's MemberVotes search page (roll number is exact within the
  date-scoped scan); `relatedRecordIds` additionally lists same-day
  vote-claim rows from non-roll-call sources (the pilot's press-release
  misses named neither a bill id nor the feed's title — the Clerk prints
  "One Big Beautiful Act", the Senate title is just "S. 5, As Amended");
  and a retired row blocks a candidate only when no live row carries the
  vote, so retiring a redundant duplicate copy does not freeze the live
  record.

## Decisions (2026-08-23, phase 3)

- Ohio pilot runs on the OFFICIAL Ohio LIS API directly, not LegiScan: no
  key or account needed, `state.oh.us` is listed by the source policy, and
  the cited feed itself carries the per-member votes. LegiScan stays the
  plan of record for the phase-4 rollout. Code: `rollcall:oh:fetch` /
  `rollcall:oh:resolve` / `rollcall:oh:import` (+ state entries in the
  shared `rollcall:judge` judgments format).
- Ohio has no roll numbers → surrogate `roll_number` = the vote action's
  `occurred` timestamp in epoch seconds (deterministic, unique per chamber,
  int4-safe until 2038); the fetcher refuses collisions and refuses two
  kept floor votes of one chamber on one bill and day, because the per-bill
  actions URL is the source_url and could not tell them apart.
- State identity layer = a committed per-GA crosswalk file
  (`evidence/rollcall/ohio-136/crosswalk.json`), lpid → candidate id, the
  review artifact playing the role of exact FEC ids. `rollcall:oh:resolve`
  proposes pairs by strict name matching (report-only); a human decides
  what enters the file; the importer attaches only what the file says. The
  `candidate_external_ids` table waits for the multi-state rollout.
- Committee-ness comes from Ohio's structured action codes, never
  `cmte_name` (a conference-report floor vote carries the conference
  committee's name). Unknown vote-bearing codes classify `is_floor_vote =
  null` and are surfaced, never queued.
- Judgment grounding for Ohio = the LSC Final Analysis PDF (CRS analog)
  from the bill page's Documents tab; the two-sentence + labels + review
  flow is unchanged.

## Decisions (2026-08-24, phase 4 code)

- Phase-4 spine = LegiScan bulk datasets, as recommended above, read from an
  EXTRACTED dataset directory. No live-API code: bulk is the plan of record,
  no key exists yet, and untestable download code would ship unverified. The
  operator downloads the session ZIP (legiscan.com/datasets, or
  `getDatasetRaw` with a key once registered) and unzips it; the fetcher
  routes files by their envelope key (`bill` / `roll_call` / `person`),
  never by archive layout. Schema pinned against the LegiScan API User
  Manual v1.91 (rev 2025-03-17); every read field re-checked at parse time.
  Code: `rollcall:legiscan:fetch` / `rollcall:legiscan:resolve` /
  `rollcall:legiscan:import` (+ registry states accepted by the shared
  `rollcall:judge`).
- `roll_number` = LegiScan `roll_call_id` (real, globally unique, int4-safe);
  `session` = LegiScan `session_id` as a string; `source_url` = the per-roll
  page `legiscan.com/<ST>/rollcall/<bill>/id/<roll_call_id>` from the bill
  feed's own `votes[].url` (constructed fallback), which names exactly one
  vote — so none of Ohio's surrogate-roll or same-day-collision machinery
  carries over. legiscan.com now sits behind a Cloudflare challenge (403);
  the record validator explicitly allows 403, verified end-to-end.
- Which descriptions are final-action floor votes is a PER-STATE fact:
  `legiscanStateConfigs.ts` is a registry (jurisdiction, pinned session_id,
  chamber sizes, kept/excluded desc regexes) that ships EMPTY. A state is
  added only after `--survey` (config-free desc histogram per chamber with
  tally ranges) has been read — patterns are measured, never guessed.
  Committee-ness: kept desc + total ≥ 60% of chamber = floor; unknown desc +
  total < 50% = committee (rejected before the queue, counted); everything
  between classifies `is_floor_vote = null` — stored and surfaced, so a
  state that lists only voting members cannot lose a floor vote silently.
  Kept instrument types = LegiScan `bill_type` B / JR / JRCA / CA.
- Identity layer = a committed crosswalk file keyed by `people_id`, pinned
  to the jurisdiction only (people_id is stable across sessions, unlike
  Ohio's per-GA lpids). The proposer keeps the Ohio name rules
  (last-name tail + first exact-or-prefix, unique both directions) and adds
  `seatAgrees` (member's `HD-063` vs the candidacy's district) as reviewer
  information — a mismatch flags, never vetoes, since a member may be
  running for another seat. LegiScan's `last_name` is a clean field, so the
  Ohio pilot's `"Hall, D."` blind spot does not carry over. The importer
  runs off committed files alone: evidence dir + crosswalk + the people
  snapshot `legiscan-people-<st>-<sessionId>.json` that resolve writes.
- Smoke-tested 2026-08-24 on a synthetic one-bill dataset against the local
  DB: fetch (inserted → unchanged on re-run), judge (approved through the
  registry gate), import dry-run + real (transaction, sha pin, live
  sentence validation of the legiscan.com URL, zero records for an
  all-null crosswalk), then the row deleted and the temp config removed.

## Decisions (2026-08-29, stance + review-gate fixes)

Driven by defects the records-quality campaign found in fanned-out rows
(GA SB 40 / PA HB 103 chip sweeps, GA HB 1247 title-vs-text cluster,
ND SB 2377 committee-name subject):

- **Nay stance is authored, never inverted.** `labels_json` elements are now
  `{slug, yea, nay}`. The old fan-out inverted the yea stance for nay voters
  (`flip()`), but a no vote on one bill is not the opposite stance on the
  area's whole goal — it rendered as "Opposes <Area>" chips that two manual
  sweeps had to remove. On a stance area, `nay: "for"|"against"` is the
  stance a no vote actually evidences; `nay: null` means nay voters get NO
  tag on that slug (silence, not the opposite claim; untagged records are an
  accepted state). Non-stance areas tag both sides topically as before.
  `rollcall:judge` refuses a new stance label without an explicit `nay`;
  stored pre-`nay` rows read as `nay: null`, so the next `rollcall:import`
  of such a roll call drops the flipped stance tags rather than re-minting
  them — the deliberate repair path, run per roll call, never automatically.
- **Tally gate.** Approving a judgment requires both sentences to cite the
  row's own `<yeas>-<nays>` (the closing tally sentence was already the §3
  template; now it is enforced). Catches sentences written about a different
  stage of the same bill and mistyped tallies.
- **Superseded-stage gate.** A roll call cannot be approved while another
  kept floor vote (`is_floor_vote = true`) on the same measure in the same
  chamber and session sits in `legislative_votes` on or after its date —
  same-day peers count (reconsider-and-revote pairs share a date and the
  sources give no within-day order), and the scan stays inside the bill's
  session since measure numbers repeat across sessions (US scans both
  calendar sessions of the Congress) (PA HB 103: first passage 148-55 was
  fanned out while the members' final position was the 201-2 concurrence
  that became Act 28). Judge the chamber's final action; to approve an
  earlier stage on purpose, list the later roll numbers under
  `acknowledge_later_rolls`. Limit: the gate only sees fetched rows — fetch
  the bill's full vote list before judging (LegiScan bulk gives it for
  free; federal, walk the bill's actions).
- **Authoring rules that stay human** (not mechanically checkable; the
  materiality-regex experiment false-positived 50/54 rows, so no wording
  pattern checks): (1) describe provisions from the text actually voted on
  (the PN/engrossed/enrolled version in `exact_question`, or the enacted
  act), never from the bill's TITLE — GA HB 1247's title read as a
  permission ("may act as authorizing agencies") while the enacted text is
  a mandate ("shall be required to participate"), replicated to 188 rows;
  verify may/shall against the operative text before writing. (2) Never
  infer a bill's subject from the COMMITTEE that handled it — ND SB 2377
  sat in a human-services committee but amends the insurance code; the
  subject comes from the bill text/analysis. (3) Existing rule restated:
  the sentences describe THIS roll call's question, and multi-stage bills
  get the final action.
- Committed pre-gate `judgments.json` files no longer re-apply verbatim:
  the file parse now demands explicit `nay` on every stance label. Add the
  `nay` fields (usually `null`) to re-apply one; a judgment that then
  matches the stored row byte-for-what-it-means is still `unchanged` (the
  apply-time gates run only when something would change).
- Fan-out `refresh` action (2026-09-04, PR #1091). The identity key hashes
  the description and URL after normalizing them (lowercase, punctuation
  and extra spaces dropped, trailing slash dropped), so an edit that only
  changes punctuation, case, or spacing keeps the key and used to come back
  `unchanged` with the old text still stored (the IL comma-splice fix
  needed a direct SQL `replace()`). The plan step now compares the stored
  description and source_url byte for byte with the incoming ones; a
  same-key `rollcall_import` row that differs is `refresh`, which updates
  description, source_url, and updated_at on that row (same id, key, tags,
  and notification events), guarded on the old text, and is counted
  separately in the import report. Hand-written and pre-provenance rows
  with the same key stay `unchanged`; `--skip-existing` still only guards
  hand-written duplicates. Word changes still move the key and take the
  `rewrite` path, but only after `rollcall:judge` has applied the edited
  judgments file. DE batch-01 (2026-09-04) skipped that step: the importer
  reads `legislative_votes`, not `judgments.json`, so it recomputed the old
  keys and reported 177 `unchanged`; the rows were then patched by hand
  while `legislative_votes` still holds the old text. A fixed description
  is a re-judge plus a real re-run, not a file edit.

## Open questions

- Register a free LegiScan API key (needed to download the phase-4 bulk
  datasets; the user must create the account).
- LegiScan ToS read-through before redistributing raw dumps (data itself is
  CC BY 4.0).
