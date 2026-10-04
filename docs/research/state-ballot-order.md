# State ballot contest-order rules — reference

Companion to `docs/plans/state-ballot-order-research.md`. One section per
jurisdiction, fixed template, graded A/B/C (see plan). Findings land here as
research completes; PENDING means unresearched, not "no rule".

Baseline (what "no deviation" means): the majority pattern encoded in
`backend/src/pipeline/address/ballotContestRank.ts` — President → US Senate →
US House → statewide executives → state senate → state house → county →
municipal → school → judicial late block (supreme → appeals → trial) →
measures last.

## Entry template

```text
### XX — State (FIPS nn) — GRADE [A|B|C] [partial]
- Authority: <cite + URL> (accessed YYYY-MM-DD)
- Office order: <sequence as prescribed>
- Judicial: <within-level | late block | separate section; retention placement>
- Measures: <last | first | interleaved; amendments vs local props>
- County discretion: <none | partial | full — cite>
- School/special: <placement>
- Corroboration: <county, cycle, URL — what it confirmed>
- Baseline delta: <none | describe override>
- Notes: <wrinkles, primary-order differences, conflicts>
```

---

## Batch 1

### CA — California (FIPS 06) — GRADE A
- Authority: Cal. Elections Code §13109 (Stats. 2002 ch. 784),
  https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=13109.&lawCode=ELEC
  (accessed 2026-08-16; verification pass got full text from plain curl w/
  browser UA — no browser needed despite the JSF frontend). Related:
  §§13109.5, 13109.7–13109.10 (LA County alternate order), §13111 (rotation
  by Assembly district), §13112 (randomized-alphabet drawing), same URL
  pattern.
- Office order: §13109 "Beginning in the column to the left": (a) President/VP
  → (b) President (primary rows) → (c) STATE: Governor → Lt. Gov → SOS →
  Controller → Treasurer → AG → Insurance Commissioner → Board of
  Equalization member → (d) US SENATOR → (e) US REPRESENTATIVE → (f) State
  Senator → (g) Assembly Member → (h) county committee → (i) JUDICIAL →
  (j) SCHOOL → (k) COUNTY → (l) CITY → (m) DISTRICT → (n) MEASURES. Statewide
  executives ABOVE US Senate and US House. Superintendent of Public
  Instruction is NOT in the state block — it heads (j) SCHOOL.
- Judicial: separate MID-BALLOT block, §13109(i), after Assembly/county
  committee and BEFORE school/county/city/district: Chief Justice → Associate
  Justice Supreme Court → Presiding Justice Court of Appeal → Associate
  Justice Court of Appeal → Superior Court judge → Marshal. Appellate
  retention YES/NO questions print inside this block, ahead of Superior Court
  races.
- Measures: last. §13109(n): "ballot measures in the order, state through
  district shown above, and within each jurisdiction, in the order prescribed
  by the official certifying them"; §13109(o) mandatory: "state measures
  shall always precede local measures."
- County discretion: partial, explicit — §13109(o): official "may vary the
  order of subdivisions (j), (k), (l), (m), and (n) as well as the order of
  offices within these subdivisions", but Superintendent of Public
  Instruction always precedes school/county/city offices and state measures
  always precede local. Subdivisions (a)–(i) (president → judicial) NOT
  reorderable. §13109.5: county-committee block movable. §§13109.7–13109.10:
  Los Angeles County alone gets a wholly different order (Notes).
- School/special: SCHOOL = (j), right after judicial, BEFORE county and city —
  Supt. of Public Instruction → county supt. → county board → college →
  unified → high school → elementary districts. Special districts = (m),
  alphabetical by district name.
- Corroboration: (1) San Bernardino County 2022 general (cycle 2022 —
  statewide executives only run in gubernatorial years, 2024 can't test
  Governor placement), official VIG ballot facsimile,
  https://uploads.rov.sbcounty.gov/rov/Elections/2022/1108/VIG-CMBEN.pdf —
  exact §13109 match (STATE OFFICES → US Senator full then short term → US
  Rep → State Senator → Assembly → Judicial YES/NO → School w/ Supt. first →
  County → City → District → Measures, state first). (2) Los Angeles County
  2024 general facsimile (style 29H34-NP-EN,
  https://mrca.ca.gov/wp-content/uploads/2024/09/Ballot-Measure-H.pdf — ONE
  page, 3 of 6: corroborates local-first + Superior Court inside COUNTY, but
  NOT the federal-last tail, which rests on §13109.8 text) + LA 2022 sample
  booklet
  (https://cdnsm5-hosted.civiclive.com/UserFiles/Servers/Server_212309/File/2022%20General%20Election%20Sample%20Ballot.pdf,
  facsimile pp. 17–21 — opens with NATIONAL ELECTION/US Senate because of
  the §13109.10 consolidated-special override, then CITY/LOCAL → COUNTY →
  STATE → STATE JUDICIAL) — both confirm LA on the ALTERNATE order. No
  statute-vs-sample conflict; each ballot matches the statute governing it.
- Baseline delta: REAL, substantial — (1) statewide executives BEFORE US
  Senate/House; (2) executive internal order has Controller before Treasurer,
  both before AG; (3) Supt. of Public Instruction heads SCHOOL, not a
  statewide-executive slot; (4) judicial mid-ballot (after legislature,
  before school/county/city), not late; (5) SCHOOL precedes county and city
  (baseline: county → municipal → school); (6) Board of Equalization has no
  baseline slot. Measures-last + state-before-local match.
- Notes: LA COUNTY CARVE-OUT (FIPS 06037) — §13109.8 alternate order is
  essentially the baseline inverted: CITY/LOCAL (incl. State Senate/Assembly/
  US House + city measures) → DISTRICT → COUNTY (incl. Superior Court judges
  + county measures) → STATE (executives + Supt. + state measures) → STATE
  JUDICIAL (appellate retention) → NATIONAL (President, US Senate) — local
  first, federal LAST, measures interleaved per jurisdiction. §13109.10 puts
  consolidated special+regular contests for the same office first (LA Nov
  2022 did exactly this with US Senate full+short). Pilot §13109.7
  self-repeals, but §13109.9 is permanent and DISCRETIONARY ("may use the
  alternate ballot order") — LA still used it Nov 2024; treat as standing
  county-option, revertible without statutory change. IMPLEMENTATION SCOPE:
  the planned override is keyed on state_fips only, so it cannot distinguish
  LA from the rest of "06" — the CA override therefore encodes the §13109
  statewide order ONLY, and LA is EXCLUDED from the first implementation
  (accepted limitation: LA voters' printed ballots differ; being a
  discretionary county option it could never be grade-A statewide anyway;
  county-scoped placement is ballot-facsimile Phase 3's territory).
  Primaries: same list +
  (b)/(h) blocks; §13109.5 committee move. Rotation (informational): §13112
  = the SOS randomized-alphabet drawing; the Assembly-district rotation
  itself is §13111 ("the name appearing first in the last preceding Assembly
  district shall be placed last") — within-contest name order only.

### TX — Texas (FIPS 48) — GRADE A
- Authority: Tex. Elec. Code §52.092 (office order), §52.093 (non-county
  subdivisions), §52.072(c)–(d) (propositions), §52.094–.095 (name/proposition
  order), §274.004 (constitutional amendments), §2.053(c) (unopposed block) —
  https://statutes.capitol.texas.gov/?tab=1&code=EL&chapter=EL.52&artSec= and
  https://statutes.capitol.texas.gov/?tab=1&code=EL&chapter=EL.274&artSec=
  (accessed 2026-08-16). Site is an Angular SPA — every path incl.
  /Docs/EL/htm/EL.52.htm and the PDF route serves only the shell to a plain
  fetch; text read from the rendered DOM in a browser. SOS corroboration
  (static): https://www.sos.texas.gov/elections/laws/advisory2024-25.shtml —
  "The order of statewide, district, county, and precinct offices on the
  ballot and the order of parties on the ballot are governed by Sections
  52.091 and 52.092 of the Election Code."
- Office order: §52.092(a): "(1) offices of the federal government; (2)
  offices of the state government: (A) statewide offices; (B) district
  offices; (3) offices of the county government: (A) county offices; (B)
  precinct offices." Federal (b): president/VP → US senator → US rep.
  Statewide (c): governor → lt. governor → AG → comptroller → land
  commissioner → agriculture → railroad commissioner → chief justice supreme
  court → justice supreme court → presiding judge CCA → judge CCA. District
  (d): SBOE → state senator → state rep → chief justice court of appeals →
  justice court of appeals → district judge → criminal district judge →
  family district judge → district attorney → criminal district attorney.
  County (e): county judge → county court at law → county criminal court →
  county probate court → county attorney → district clerk → district+county
  clerk → county clerk → sheriff → sheriff/tax assessor-collector → tax
  assessor-collector → treasurer → county school trustee (county ≥3.3M pop) →
  surveyor. Precinct (f): county commissioner → JP → constable. Then §52.093
  subdivision offices, then measures, then — CONDITIONALLY, only when a
  county uses the §2.053 declaration — the unopposed-declared-elected block
  dead last (informational, no votes cast). Effective sequence: contested
  offices → measures → unopposed block.
- Judicial: within-level, confirmed — NOT late block. Supreme Court + CCA =
  tail of statewide block; appeals + district judges inside district block;
  county courts LEAD the county block; JP/constable = precinct (last partisan
  contests). No retention mechanism — all partisan (party label under every
  judicial candidate on Harris 2024). §52.092(j): multicounty statutory county
  court judge listed as county office.
- Measures: last among VOTED items, after offices — §52.072(c): "each
  proposition stating a measure shall appear on the ballot after the listing
  of offices"; the conditional §2.053(c) unopposed block can still print
  after the measures (see Office order). Carve-outs:
  §52.072(d) contingent-office proposition prints BEFORE offices; §274.004:
  "A proposed constitutional amendment must be placed on the ballot before all
  other propositions" (internal order = SOS public drawing, §274.002(d)–(e)).
  Otherwise §52.095(a): ordering authority decides. Joint-election practice:
  "after the listing of offices" applies PER SUBDIVISION — each subdivision's
  section carries its own offices + its own props (Harris 2024).
- County discretion: partial — zero over the §52.092 partisan sequence
  (§52.092(i): SOS designates new offices' position); §52.093 delegates
  non-county-subdivision office order to "the authority ordering the
  election"; §52.095(a) same for propositions. §52.002: ballot prep split
  county clerk / city secretary / subdivision secretary — no single owner of a
  joint ballot.
- School/special: three-way split — SBOE FIRST in district block
  (§52.092(d)(1)); county school trustee a county office in ≥3.3M counties
  (§52.092(e)(13)); all other ISD/special-district offices = §52.093 tail
  after the partisan block, self-ordered. Harris 2024 practice: countywide
  special district → cities alphabetical → ISDs alphabetical → MUDs.
- Corroboration: Harris County 2024 general composite "Yellow" sample (19pp),
  https://files.harrisvotes.com/harrisvotes/prd/SampleBallot/1124_Yellow%20Sample%20Ballot_EN_SP.pdf?sv=2017-04-17&sr=b&si=DNNFileManagerPolicy&sig=6Bq4UIVFC6I7HCE5GZmLGvvHVYyRKrKrZH/uKs72o2o%3D
  — exact §52.092 match top to bottom (President → … → Constable Pcts 1–8 →
  Flood Control Prop A → cities alphabetical → Lone Star College District →
  ISDs alphabetical → MUD bond). Plus Sabine County 2022
  (https://www.co.sabine.tx.us/upload/page/3469/SB%20PCT%204.pdf, cycle
  2022) exercising the executive block: Governor → Lt. Gov → AG → Comptroller
  → Land Comm → Agriculture → Railroad Comm → Supreme Court → CCA → State
  Senator, exact §52.092(c)–(d) match. No statute-vs-sample conflict.
- Baseline delta: REAL, many — (1) judicial within-level (statewide courts
  after railroad commissioner, appeals/district judges after state house);
  (2) county courts lead the county block; (3) JP/constable last partisan;
  (4) SBOE before state senate/house; (5) DAs at end of district block;
  (6) county school trustee inside county block (big counties); (7)
  municipal/school §52.093-delegated, local props interleave per subdivision
  rather than pooling at the end; (8) amendments ahead of other props,
  contingent props ahead of offices.
- Notes: §52.092(a) opens "Except as provided by Section 2.053(c)" —
  unopposed-declared-elected offices list separately after measures, "grouped
  in the same relative order prescribed for the ballot generally", no votes
  cast. §52.092(g): place numbers part of title, numerical order. Primary
  uses the same §52.092 sequence (keys on "offices regularly filled at the
  general election"); name order drawn by county party chair (§52.002(2)).
  Name order (informational): party columns per §52.091; drawings per
  §52.094(a); no precinct rotation.

### FL — Florida (FIPS 12) — GRADE A
- Authority: Fla. Admin. Code R. 1S-2.032(7) "Uniform Design for Election
  Ballots" (eff. 4-23-2020), index https://flrules.org/gateway/ruleNo.asp?id=1S-2.032
  (operative text only in the linked .doc:
  https://flrules.org/gateway/readFile.asp?sid=0&tid=23116863&type=1&file=1S-2.032.doc
  — the rule page itself is an index shell); statutory base Fla. Stat.
  §101.151(2)(a), https://www.flsenate.gov/Laws/Statutes/2024/101.151, and
  §105.041(1), https://www.flsenate.gov/Laws/Statutes/2024/105.041 (all accessed
  2026-08-16)
- Office order: Rule 1S-2.032(7): "the ballot shall list the contests in the
  order specified in Sections 101.151 and 105.041, F.S." — (7)(a) partisan:
  Federal → State → County → Municipal → District/special district → Party
  offices. §101.151(2)(a) internal sequence: 1. President/VP; 2. US Senator and
  US Representative; 3. Governor+Lt. Gov (joint), AG, CFO, Commissioner of
  Agriculture, State Attorney, Public Defender; 4. State Senator and State
  Representative; 5. Clerk of Circuit Court, Sheriff, Property Appraiser, Tax
  Collector, District Superintendent of Schools, Supervisor of Elections;
  6. County Commission + other county/district offices "in the order fixed by
  the Department of State". (Item 5 also includes "Clerk of the County
  Court, when authorized by law".) §101.151(2)(d): offices not involved are
  omitted, the rest keep the named order.
- Judicial: separate NONPARTISAN section that judicial LEADS — not a
  school-after block. §105.041(1): nonpartisan candidates and "justices and
  judges seeking retention to office shall be grouped together on a separate
  portion of the general election ballot". Rule 1S-2.032(7)(b) orders it:
  Supreme Court (retention) → DCA (retention) → Circuit Judge → County Judge →
  nonpartisan county office → School Board → nonpartisan municipal →
  nonpartisan district/special district. Retention prints at the head of the
  same block, high→low court.
- Measures: last. Rule 1S-2.032(7)(d): statewide amendment/measure → county →
  municipal → special district.
- County discretion: partial, narrow — residual county/district offices ordered
  by the Department of State, not the supervisor; 1S-2.032(14) allows
  deviation only for six enumerated formatting/space reasons plus a catch-all
  for "extraordinary circumstances which cannot reasonably be accommodated
  except by deviation". Local variation is packaging (e.g. Miami-Dade
  separate municipal ballot), not sequence.
- School/special: School Board = item 6 of the nonpartisan block — AFTER
  judicial and nonpartisan county offices. Partisan district/special offices
  tail the partisan block after municipal.
- Corroboration: Miami-Dade County, 2024 general,
  https://www.miamidade.gov/elections/library/sample-ballots/2024-11-05-general-election-sample-ballot.pdf
  — observed: President → US Senator → US House → State Senator → State Rep →
  Clerk → Sheriff → Property Appraiser → Tax Collector → Supervisor of
  Elections, then nonpartisan: Supreme Court retention → 3rd DCA retention →
  County Judge → County Commissioner (nonpartisan by charter) → School Board,
  then Amendments 1–6 last. Matches (7)(a)→(b)→(d) exactly, incl.
  school-below-judicial. No statute-vs-sample conflict.
- Baseline delta: REAL — (1) whole nonpartisan judicial section (retention +
  trial) prints BEFORE school board and nonpartisan municipal (baseline has
  school 80 before judicial 82–90); (2) School Board itself precedes
  nonpartisan MUNICIPAL offices — rule (7)(b) item 6 vs items 7–8 — inverting
  the baseline's municipal-before-school within the nonpartisan section;
  (3) partisan municipal precedes district/special-district offices.
  Federal→state→county spine, Governor after US House,
  supreme→appeals→trial, measures-last all match baseline.
- Notes: 2024 = no governor race, so statewide-executive internal order rests
  on §101.151(2)(a)3. text alone. Primaries differ: §105.041(1) separate
  portion/ballot; §101.151(4)(a) alphabetical surnames. Name order within a
  general contest (informational): NO rotation — §101.151(3)(a) seats the
  last-gubernatorial-winner's party first. Design forms DS-DE 200–208
  incorporated by reference, not fetched.

### NY — New York (FIPS 36) — GRADE A (scoped; C→B→A(scoped) 2026-08-16/17 — external review applied the campaign's own one-matching-sample standard)
- GRADE SCOPE: A covers TWO legs, each with express authority AND a matching
  official sample: (1) judicial offices after ALL other partisan offices —
  §7-104(11)(b) express text (eff. 2025-01-01) + the Suffolk 2025 general
  booklet, every style (single-county, but the campaign's A standard is one
  matching sample — NH's Dover face is the precedent — and demanding a
  second county here would be a stricter rule invented for NY alone);
  (2) ballot proposals in a separate section, normally the ballot back —
  §7-110 "shall appear on the ballot in a separate section or on a separate
  sheet or card" + Suffolk 2024 (39 faces, reverse side) and 2025 (backs,
  statewide amendment first). EXCLUDED from A: (a) the (11)(a) precedence
  spine (executives above US Senate/House) — effective 2025-01-01 but NO
  general carrying (11)(a) offices has printed under it yet (first test =
  Nov 2026), so it is statute-only; (b) partisan-before-nonpartisan and the
  judicial-before-nonpartisan corollary (inference from NY's partisan
  judiciary; only pre-mandate nonpartisan sample); (c) the "customary
  order" middle band ((11)(b) leaves non-listed office order to county
  custom); (d) Big-5 school-board band placement (single pre-mandate Erie
  style). NO CODE CONSEQUENCE: both in-scope legs match the baseline
  (judicial late block, measures last), and the headline spine deviation is
  excluded — so NY gets NO override row until Nov 2026 print evidence
  brings the spine into scope.
- Authority: NY Election Law §7-104(11)(a)–(b). LAW HISTORY (corrected
  2026-08-16 against the S5943 bill text, deleted matter in brackets): the
  2019 "Voter Friendly Ballot Act" (L.2019 c.411) subdivision required only
  that "[the offices appearing on all ballots shall be listed in the
  customary order]" — NO office list, NO judicial-placement rule. The
  detailed precedence list AND the partisan-before-nonpartisan /
  judicial-after-partisan provisos were CREATED by Ch. 217 of 2024 (= S5943,
  signed 2024-08-06, https://www.nysenate.gov/legislation/bills/2023/S5943),
  effective "on the first of January next succeeding the date on which it
  shall have become a law" = January 1, 2025. Current text re-verified
  2026-08-16 (revision stamps 2024-08-09 and 2025-01-03),
  https://www.nysenate.gov/legislation/laws/ELN/7-104; proposals
  §7-110, https://www.nysenate.gov/legislation/laws/ELN/7-110; party rows
  §7-116, https://www.nysenate.gov/legislation/laws/ELN/7-116; NY Const. art.
  VI §2(e) (Court of Appeals appointed) + §6(c) (Supreme Court elected);
  Education Law §2002 (May school elections) (all accessed 2026-08-16).
  Current (11)(a) verbatim: "The offices appearing on all ballots shall be
  listed in the order of precedence, as applicable to the offices up for
  election in any given year, as follows: electors for president and
  vice-president of the United States, governor and lieutenant governor,
  New York state comptroller, New York state attorney general, United States
  senator, member of the house of representatives, New York state senator,
  member of the New York state assembly." Current (11)(b) verbatim:
  "Immediately following the offices in paragraph (a) of this subdivision,
  all other offices shall be placed upon the ballot in the customary order;
  provided, further, that partisan offices regardless of the size of the
  constituency shall be listed before or ahead of nonpartisan offices and
  all candidates for judicial offices shall follow all other partisan
  offices."
- Office order: §7-104(11)(a) fixed list (CURRENT law, eff. 2025-01-01):
  President/VP electors → Governor+Lt. Gov (joint, Gov first) → Comptroller →
  AG → US Senator → US Rep → State Senator → Assembly Member; closing
  sentence: "Any office which is not listed in this paragraph shall not
  appear on the ballot in a position before or ahead of an office which is
  listed." (11)(b): everything else "in the customary order", partisan before
  nonpartisan, judicial after all other partisan offices. Statewide
  executives ABOVE both congressional offices. NONE of this bound any ballot
  before 2025 (see Authority).
- Judicial: current statute's express rule = judicial offices "shall follow
  all other partisan offices". Their position relative to NONPARTISAN
  offices is an INFERENCE, not express text: NY's elected judicial offices
  are partisan (party nominations, party rows), so the separate
  partisan-before-nonpartisan clause puts them ahead of nonpartisan contests
  — flag any nonpartisan judicial contest, if one ever appears, as outside
  this deduction. 2024 BALLOTS printed Supreme Court Justice THIRD, right
  after US Senator, in both counties checked (Suffolk also County + Family
  Court there), ahead of Congress/legislature — LAWFUL at the time: the
  pre-2025 text required only "customary order", so those faces evidence
  the old custom, not a violation. 2025 (first cycle under the new
  mandate): Suffolk's general booklet prints all judicial after every
  partisan office (see Grade rationale). Court of Appeals
  appointed — never a contest. No retention.
- Measures: last, separate section, normally ballot BACK — §7-110 "Ballot
  proposals shall appear on the ballot in a separate section or on a separate
  sheet or card"; §7-104(16) front must say turn over. Practice numbers the
  statewide amendment first (Suffolk 2024 Proposal One = state ERA, Two =
  county charter).
- County discretion: partial — the eight (11)(a) offices fixed; the rest is
  "customary order" chosen by county boards subject to
  partisan-before-nonpartisan + judicial-after-partisan. 9 NYCRR 6210.7 =
  print specs only, no sequence.
- School/special: almost never on November ballot (Education Law §2002 = May).
  Exception: Big-5 charters — Buffalo Board of Education at-large printed on
  the Erie 2024 general, nonpartisan, after every partisan contest; in the
  ballot's bottom band it sits RIGHT of the state amendment and the county
  proposal (verifier-checked left-to-right: Proposal One → County Proposal
  No. One → school board). NYC: no elected board.
- Corroboration: Suffolk County 2024 general official sample booklet (80pp),
  https://apps2.suffolkcountyny.gov/boe/documents/2024General-SampleBallotBooklet.pdf
  — verified on all 39 ballot faces: President/VP → US Senator → Supreme
  Court Justice 10th JD (vote for up to 8) → County Court → Family Court →
  US Rep → State Senator → Assembly; some styles then append District Court
  Judge / Town Justice / Council member AFTER Assembly (trailing local tail,
  not all-judicial-up-top); proposals on reverse (One = ERA, Two = Suffolk
  charter; two East Hampton backs carry a third). Erie County 2024 — single
  Buffalo style BFLO ELL 002, vendor-mirrored,
  https://townsquare.media/site/11/files/2024/11/attachment-Erie-County-NY-Sample-Ballot.pdf:
  President → US Senator → Supreme Court Justice (no district printed on the
  header) → US Rep → State Senator → Assembly → Family Court → DA → Buffalo
  City Court; bottom band left-to-right = Proposal One (state amendment) →
  County Proposal No. One (Erie charter) → Buffalo Board of Education
  Member-at-Large.
- Baseline delta: current statute gives (1) statewide executives above
  Congress and (2) judicial after all other partisan offices (before
  nonpartisan only by the partisan-judiciary inference above); 2024 practice
  (pre-mandate, lawful custom) put judicial-district courts 3rd, while 2025
  practice (Suffolk booklet, first cycle under Ch. 217) matches the
  statute's judicial-after-all-partisan — which the baseline's late judicial
  block already approximates, so the judicial leg needs no override either
  way. Measures-last matches baseline WITH a Big-5
  qualifier: when a
  Buffalo school-board contest is present (Erie style above), the nonpartisan
  school contest prints to the RIGHT of the proposals, so the proposal
  section is not final on that ballot (single-style observation; Suffolk had
  nothing after its reverse-side proposals).
- Grade rationale: A (scoped), via C → B → A(scoped). The C rested on a
  supposed statute-vs-practice
  conflict; corrected law history DISSOLVES it — the batch research read the
  2026-current §7-104(11) text off nysenate.gov and mis-attributed it to
  L.2019 c.411, so the 2024 judicial-third faces were scored as violations
  of a rule that did not yet bind them (pre-2025 law: "customary order"
  only). There was never a conflict: 2024 ballots followed lawful custom;
  the detailed mandate took effect 2025-01-01 (Ch. 217 of 2024); and the
  Suffolk County 2025 GENERAL sample booklet (84pp, all styles,
  https://apps2.suffolkcountyny.gov/boe/documents/General%20Election,%202025%20-%20Sample%20Ballot%20Booklet.pdf,
  %PDF-verified, coordinate-extracted 2026-08-16) prints EVERY judicial
  office after ALL partisan county and town offices: DA(pos 1) → Sheriff(2)
  → County Legislator → town Supervisor → Town Clerk → Council →
  Justice of the Supreme Court 10th JD (pos 76-83, vote for up to 8) →
  County Court Judge(84) → Family Court Judge(85-87) → District Court
  Judge(88-90); machine-position numbering reserves the trailing 76+ band
  for judicial on every style. Proposals print on the ballot BACK with the
  statewide amendment (Proposal One, Olympic Sports Complex) first —
  §7-110 practice unchanged. Statute and first-cycle print practice AGREE
  on judicial placement. The interim B had demanded a SECOND county before
  A — the second external-review round correctly flagged that as a stricter
  rule than the campaign's A standard (explicit authority + ONE matching
  official sample; NH's Dover face is the single-jurisdiction precedent),
  so the judicial and proposals legs take scoped A and everything untested
  stays excluded (see GRADE SCOPE). Corroboration-widening paths, useful
  but NOT gates: another county's 2025 general face (Erie's
  elections.erie.gov/GenBallots/593.pdf is purged/404, the enhancedvoting
  Westchester archive is empty, Wayback replay was down service-wide on
  2026-08-16 — retry there), and a Nov 2026 general face, which is the
  REAL gate for bringing the (11)(a) spine into scope.
  Verification history: 2026-08-16 pass re-fetched every URL and re-read
  both 2024 ballots (39 Suffolk faces); this upgrade adds the 2025 booklet.
- Notes: grid ballots — party rows lettered by last gubernatorial vote
  (§7-116(1)); office sequence is the perpendicular axis. Fusion voting:
  same candidate on multiple party rows, informational only. Name order: no
  rotation; §7-116(2) lot on demand within party group. Primaries: §7-104(11)
  precedence still governs; within-party placement by lot (9 NYCRR 6204.3).

### PA — Pennsylvania (FIPS 42) — GRADE B
- Authority: PA Election Code (Act of June 3, 1937, P.L. 1333) §1003 "Form of
  Official Election Ballot" (25 P.S. §2963) (a)/(b)/(g) — official text only
  via the iframe route
  https://www.palegis.us/statutes/unconsolidated/law-information/view-statute?51&iFrame=true&txtType=HTM&SessYr=1937&SessInd=0&ActNum=0320.&chpt=10&subchpt=000.&sctn=3&subsctn=000.
  (accessed 2026-08-16; the human-facing wrapper is a script-rendered empty
  shell, and legis.state.pa.us ↔ palegis.us redirect-loop on per-section
  URLs). Word-identical mirror:
  https://codes.findlaw.com/pa/title-25-ps-elections-electoral-districts/pa-st-sect-25-2963/.
  §1109-A (25 P.S. §3031.9) covers electronic layout and imports the paper
  order: ballot labels "shall, as far as practicable, be in the same order or
  arrangement as provided for paper ballots." No Dept. of State ordering
  directive located.
- Office order: prescribed only by §1003(a)'s statutory SPECIMEN ("shall be in
  substantially the following form"): Presidential Electors → United States
  Senator → Governor → Representatives in Congress → Senator in the General
  Assembly. So Governor/statewide executives BEFORE US House. No enumerated
  internal order for AG/Auditor General/Treasurer; practice (2024 sample) =
  AG → Auditor General → Treasurer between US Senate and US House. Gov+Lt.Gov
  joint ticket. Nothing below state senate is statute-ordered.
- Judicial: normally ABSENT from the even-year general entirely. Pa. Const.
  art. V §13(a): judges "shall be elected at the municipal election" =
  odd-year November. Retention constitutionally segregated, art. V §15(b):
  "on a separate judicial ballot or in a separate column on voting machines".
  Odd-year internal placement not statute-fixed; NOW SAMPLE-VERIFIED
  (2026-08-16, two counties, 2025 municipal election, both %PDF-verified and
  coordinate-extracted): Bucks County Yardley Borough CS 306
  (https://www.buckscounty.gov/DocumentCenter/View/24132/YARDLEY_BOROUGH--306-OFF-NP-ENLocked?bidId=)
  prints Judge of the Superior Court → Judge of the Commonwealth Court →
  Judge of the Court of Common Pleas (7th JD) → DA → Sheriff → Prothonotary →
  Recorder of Deeds → Magisterial District Judge → School Director → Mayor →
  Council → Tax Collector → Judge of Elections → Inspector of Elections →
  retention questions DEAD LAST under the caption "Retention Election for
  Judicial Office" (Supreme ×3 → Superior → Commonwealth → Common Pleas);
  Chester County Atglen 005
  (https://www.chesco.org/DocumentCenter/View/81269/2025-Municipal-Election-CHESTER-COUNTY-SPECIMEN-BALLOTS?bidId=,
  462pp specimen book) prints the same appellate-first spine (Superior →
  Commonwealth → Common Pleas → Clerk of Courts → Controller → Coroner →
  Prothonotary → Treasurer → Magisterial District Judge → School Director →
  Member of Council → Mayor → Tax Collector → election-board officials) with
  "OFFICIAL JUDICIAL RETENTION QUESTIONS" as a separately captioned section
  last; NOTE these samples show a separately captioned section only — they do
  not by themselves establish either constitutional form in art. V § 15(b)
  (a separate judicial ballot, or a separate column on voting machines).
  MUNICIPAL MICRO-ORDER
  IS COUNTY-VARIABLE: Bucks prints Mayor before Council, Chester prints
  Council before Mayor — direct evidence that below the specimen the order
  is county practice, reinforcing B.
- Measures: last. §1003(g): "each amendment or other question so submitted
  may be printed upon the ballot below the groups of candidates … and, when
  required by law, shall be so printed." No placement distinction amendments
  vs local questions.
- County discretion: partial — counties print ballots (25 P.S. §2642(c)) and
  everything below the specimen's five office types (county row, municipal,
  school, judicial blocks) is de facto county/vendor practice, not statute.
- School/special: school directors = odd-year municipal (24 P.S. §3-303,
  verified verbatim: "At each municipal election, three school directors,
  except as otherwise provided in this act, shall be elected at large for
  terms of six (6) years"); never on the even-year general.
- Corroboration: Montgomery County 2024 general, Abington W1 P1 official
  sample,
  https://webapp07.montcopa.org/voterservices/sampleballots/Sample%20Ballots/Sample%20Ballots%20GE24/Abington/Abington%201-1%20-%20Official.pdf
  (archive index is POST-only; text extracts cleanly). Observed: Presidential
  Electors → US Senator → AG → Auditor General → State Treasurer → US Rep
  4th → State Rep 153rd. Matches the specimen; no conflict. Layout caveat:
  AG sits below US Senator in column 2 while Auditor General tops column 3 —
  the AG → Auditor order depends on column-major reading.
- Baseline delta: REAL — (1) statewide executives BEFORE US House; (2) NO
  judicial on even-year generals (odd-year municipal only), so the baseline
  judicial block is simply empty; (3) no county/municipal/school contests
  either (odd-year); (4) measures last matches.
- Notes: why B not A — no statute says "offices shall be arranged in the
  following order"; the ordering evidence is an illustrative specimen
  ("substantially the following form") stopping at state senate. Top-of-ballot
  leg alone would be A; full-ballot rule set alone would be C; B is the
  honest composite. DOS re-checked 2026-08-16: the Department of State's
  Directive on Logic & Accuracy Testing 3.1 (2025-04,
  https://www.pa.gov/content/dam/copapwp-pagov/en/dos/resources/voting-and-elections/directives-and-guidance/2025/2025-04-directive-on-logic-accuracy-testing-3.1.pdf,
  p. 3, verified) requires counties to confirm "Contests and candidates are
  displayed in the required order" — but no DOS document DEFINES that order,
  so the authority gap stands and B is unchanged by the new odd-year samples. Act 77 (2019) killed straight-party in practice; §1003(f)
  party-column text unrepealed. Name order (informational): no rotation —
  §1003(b) party order by last gubernatorial vote, primary order by lot
  (§§915–916). Odd-year municipal ballots differ substantially (judicial +
  retention + county row + school).

### IL — Illinois (FIPS 17) — GRADE A
- Authority: 10 ILCS 5/16-6 (amendments placement),
  https://www.ilga.gov/Documents/legislation/ilcs/documents/001000050K16-6.htm;
  10 ILCS 5/16-6.1 (separate green retention ballot),
  https://www.ilga.gov/Documents/legislation/ilcs/documents/001000050K16-6.1.htm;
  10 ILCS 5/16-3 (ballot form/column order),
  https://www.ilga.gov/Documents/legislation/ilcs/documents/001000050K16-3.htm;
  10 ILCS 5/16-7 (local questions, separate colored ballots),
  https://www.ilga.gov/Documents/legislation/ilcs/documents/001000050K16-7.htm;
  IL State Board of Elections 2026 Ballot Preparation Guide p.13 "Gubernatorial
  Order of Offices",
  https://www.elections.il.gov/agencyforms/1%20BALLOT%20PREPARATION%20GUIDE%20TESTING%20AND%20SECURITY%20FOR%20VOTING%20SYSTEMS/2026%20Ballot%20Preparation%20Guide.pdf
  (accessed 2026-08-16; verification pass fetched both PDFs plain, HTTP 200 —
  no User-Agent trick needed). Authority caveat: the guide's Preface
  self-describes as "information and suggested guidelines" — the office-
  category sequence is official SBE guidance (SOS-manual-class authority per
  this plan), not statute; the measures-first, retention-ballot, and
  SBE-certification legs ARE statutory (16-6, 16-6.1, 16-3).
- Office order: SBE guide p.13 verbatim list: Constitutional Questions →
  Statewide Advisory Questions → US Senator → Governor and Lt. Governor
  (bracketed joint) → State Officer(s) ("As certified by the State Board of
  Elections") → US Representative → State Senator → State Representative →
  Sanitary District Trustees → County Offices (incl. Educational Service
  Region superintendent) → Judicial Officers → Judicial Retention → Local
  Public Questions. NOTE this is a COMPOSITE logical sequence across
  physically separate ballots: the CANDIDATE ballot ends at Judicial
  Officers; Judicial Retention is its own green ballot (16-6.1) and each
  local public question its own distinctly-colored ballot (16-7) — neither
  holds a position ON the candidate ballot; the guide's tail order is how
  the set is conventionally presented (and how our single-list model should
  order them). Governor BEFORE US House; US Senate above Governor.
  Statewide-executive internal order not enumerated for the general — deferred
  to SBE certification (guide's nomination list runs Gov/Lt.Gov, AG, SOS,
  Comptroller, Treasurer, matching Ill. Const. art. V). President/VP heads
  candidate section in presidential years.
- Judicial: late block — after county offices, grouped Supreme → Appellate →
  Circuit → Subcircuit. Retention = wholly SEPARATE ballot, 16-6.1: "shall be
  separate from all other ballots voted on at the general election", green
  paper ("No other ballot at the same election shall be green in color");
  Supreme retention first group, Appellate second, circuit last; seniority
  order within group.
- Measures: SPLIT — statewide FIRST, local LAST. 16-6: amendments "shall be
  printed at the top of the 'Official Ballot' preceding the names of
  candidates"; convention propositions outrank amendments; statewide advisory
  questions follow amendments, still ahead of candidates. Local questions =
  separate distinctly-colored ballots (16-7), conventionally presented dead
  last after retention "by the order of initiation" — that phrase and the
  last-position are the SBE guide's (the guide only "recommends" public
  questions follow retention); 16-7 itself assigns no position, only the
  separate ballot.
- County discretion: partial — 16-3 lets election authorities set party-COLUMN
  order, but candidates print "in the order certified by the State Board of
  Elections"; party placement via post-primary lottery (10 ILCS 5/7-60).
  Office-category order not county-discretionary.
- School/special: sanitary/water-reclamation trustees BEFORE county offices
  (own slot). Regular school boards elect at April consolidated election, not
  November; exception Chicago Board of Education (School Code art. 33) printed
  LAST on the candidate ballot, after judicial.
- Corroboration: Chicago (Cook County) 2024 general specimen, Style 230 Ward
  32 Pct 03, https://ballots.chicagoelections.gov/cboeballots61/1_3203_230_SP.pdf
  — 3 statewide advisory questions → President/VP → US Rep 5th → State Rep
  11th → Water Reclamation Commissioners → Clerk of Circuit Court → State's
  Attorney → County Clerk → Supreme → Appellate ×4 → Circuit ×11 → Subcircuit
  → Chicago Board of Education 4th; separate retention card labeled "Ballot
  Style: 230 B". Confirms measures-first, sanitary-before-county, judicial
  late block, retention separate. No conflict. "President/VP heads the
  candidate section in presidential years" is sample-only — the guide's p.13
  list never mentions Presidential (it's the gubernatorial-year list).
- Baseline delta: REAL, four — (1) statewide measures FIRST not last (local
  referenda still last); (2) Governor + statewide executives BEFORE US House;
  (3) sanitary district trustees before county offices; (4) retention =
  separate ballot, and Chicago school board prints AFTER judicial (inverts
  baseline school-then-judicial).
- Notes: "blue ballot" folklore stale — 16-6 now requires amendments on
  "plain white paper"; 5 ILCS 20/2 still says separate ballot = stale
  cross-reference, 16-6 controls and the Chicago sample follows it. Primary
  order differs (10 ILCS 5/7-19, per-party ballots). Name order
  (informational): no rotation; post-primary party lottery fixes columns.

### OH — Ohio (FIPS 39) — GRADE A
- Authority: RC 3505.03(C) (office order),
  https://codes.ohio.gov/ohio-revised-code/section-3505.03; RC 3505.04
  (nonpartisan ballot), https://codes.ohio.gov/ohio-revised-code/section-3505.04;
  RC 3505.06(B)(1),(F)(1) (questions/issues),
  https://codes.ohio.gov/ohio-revised-code/section-3505.06; Ohio Const. art.
  IV §6 (judges elected); SOS Election Official Manual Ch. 5 (Directive
  2025-37),
  https://www.ohiosos.gov/globalassets/elections/directives/2025/eom/dir2025-37-ch05.pdf;
  SOS Directive 2024-25 prescribed sample ballot,
  https://www.ohiosos.gov/globalassets/elections/directives/2024/dir2024-25_sampleballot.pdf
  (all accessed 2026-08-16; ohiosos.gov behind a maintenance page — both PDFs
  read from Wayback captures of those exact URLs, 20250822140504 +
  20250305034715; codes.ohio.gov live).
- Office order: RC 3505.03(C) verbatim: "governor and lieutenant governor,
  attorney general, auditor of state, secretary of state, treasurer of state,
  chief justice of the supreme court, justice of the supreme court, United
  States senator, representative to congress, state senator, state
  representative, judge of a court of appeals, county commissioner, county
  auditor, prosecuting attorney, clerk of the court of common pleas, sheriff,
  county recorder, county treasurer, county engineer, and coroner."
  President/VP heads the ballot above that enumeration. FEDERAL SPLIT: US
  Senator + US Rep print BELOW the statewide executives and BELOW the Supreme
  Court block. Gov+Lt.Gov joint vote.
- Judicial: split across THREE places, not one late block — (a) Supreme Court
  (chief + justices) on the PARTISAN ballot mid-sequence, after treasurer of
  state, BEFORE US Senator, with party labels (SB 80, eff. 2021-09-30);
  (b) Court of Appeals partisan, between state representative and county
  commissioner; (c) only common pleas / county court / municipal court are
  nonpartisan and form the late block after every partisan office, §3505.04:
  "county judicial offices shall be listed first on the ballot, followed by
  municipal and township offices, and by offices of member of a board of
  education, in the order stated." Seats of one court sort by term start,
  full before unexpired (EOM §5.03, RC 3505.03(D)). No retention — art. IV §6
  elects every judge.
- Measures: last — EOM §5.04: "Put candidate contests on the ballot first,
  followed by questions and issues." §3505.06(B)(1): "State questions and
  issues shall always appear as the top group"; the FOUR LOCAL GROUPS ROTATE
  one place per calendar year (statute quoted in entry source; EOM publishes
  the cycle — 2026/2030 = state, school+other, county, municipal, township).
  County-vs-municipal-vs-school measure order is year-dependent, not fixed.
- County discretion: partial, narrow — office order prescribed + certified by
  SOS (identical clause in 3505.03(C) and 3505.04); boards choose only "the
  sequence for specific questions within each group" (EOM Ch. 5).
- School/special: LOCAL board of education = last in the nonpartisan tail,
  after municipal and township (§3505.04, odd-year in practice). STATE Board
  of Education differs: not in the 3505.03(C) enumeration; SOS prescribed
  form places it after Coroner, BEFORE Judge of Common Pleas — head of the
  nonpartisan block, ahead of trial judicial. Special districts: no general-
  election candidate contests; as issues they ride the "school or other
  district" group.
- Corroboration: Hamilton County 2024 general ballot proof,
  https://votehamiltoncountyohio.gov/wp-content/uploads/2024/09/BALLOTPROOF-0_Style25_English_8.5x14_Paper.pdf
  — President/VP → Supreme Court ×3 (party labels) → US Senator → US Rep →
  State Senator → State Rep → Court of Appeals ×4 (party labels) → county
  offices → Common Pleas ×2 (no labels) → Issue 1 (state) → city → village →
  township → school → special → county issues LAST → END OF BALLOT; matches
  the offices Directive 2024-25's form covers (the form also shows State BOE
  and County Court, absent from Hamilton's 2024 contests) and independently
  confirms the §3505.06 rotation (2024 slot = county last).
  Judicial-before-school untestable on even-year ballots
  (municipal/township/school are odd-year) — tested on Hamilton County Nov 4
  2025 proof,
  https://votehamiltoncountyohio.gov/wp-content/uploads/2025/09/G25-BALLOT-PROOF.pdf:
  PARTISAN municipal offices (Cheviot, Norwood, Reading… w/ party labels)
  print FIRST per 3505.03, then the nonpartisan ballot opens with Municipal
  Court Dists 1–7 → nonpartisan mayors/councils (Cincinnati, Blue Ash…) →
  township trustees → Boards of Education (city/exempted-village districts →
  Hamilton County ESC mid-block → local districts) → issues. So judicial
  leads the NONPARTISAN tail only; partisan municipal precedes it, and the
  ESC board is mid-school-block, not last. No statute/sample conflict.
- Baseline delta: REAL, large — (1) Supreme Court mid-partisan-ballot between
  executives and US Senate (NOT late block); (2) Court of Appeals between
  state rep and county offices (NOT late block); (3) US Senate/House pushed
  below state executives + Supreme Court (top of baseline inverted); (4) only
  trial judicial forms the late block, ahead of NONPARTISAN
  municipal/township/school (partisan municipal offices still print before
  it, on the partisan ballot);
  (5) local measure groups rotate annually (no fixed state→local nesting
  below the state group); (6) State BOE ahead of trial judiciary, not at the
  school tail. Holds: measures last, county above municipal, judicial-then-
  school within the nonpartisan tail.
- Notes: SUPERSEDES the earlier seed reading — the seed generalized §3505.04
  to all judicial; supreme/appeals actually sit in the partisan sequence per
  §3505.03(C). Even/odd-year split is the biggest practical wrinkle: even
  years = federal/state/county + supreme/appeals + common pleas + state BOE +
  issues; odd years = municipal/township/municipal-court/school. No printed
  section headers in practice — one continuous ballot, partisan/nonpartisan
  boundary visible only via party labels (statute-vs-practice divergence on
  labeling only). SOS 2024 form footer: "This SAMPLE ballot provides the
  CORRECT TITLES and ORDER OF OFFICES for ballot layout." Rotation
  (informational): §3505.03(E)(2) rotates candidate names by precinct, never
  contest order. Primaries: per-party ballots + separate issues ballot.
  Failed sources for the record: Franklin lookup-only, Cuyahoga
  script-rendered, lookup.boe.ohio.gov Cloudflare-gated.

### GA — Georgia (FIPS 13) — GRADE A (scoped; upgraded from B 2026-08-16)
- GRADE SCOPE: A covers ONE leg — state-court judicial absent from the
  November general (§ 21-2-138, primary-verified: nonpartisan election
  "held and conducted jointly with the general primary in each
  even-numbered year"; mandatory "shall", plus zero state-court judicial
  contests on all three November samples — Gwinnett 2022, Richmond 2022,
  Fulton 2024; the fourth sample is the Richmond May 2022 primary).
  EXCLUDED from A: (a) the ENTIRE
  office sequence (US Senate/President → 8 executives → US House →
  legislature → county → Soil & Water) — no authority text anywhere, SEB
  rule 183-1-12-.07 merely cross-references §§ 21-2-379.4/379.5 which
  terminate without fixing a sequence; (b) nonpartisan-last — § 21-2-285.1
  is a PRIMARY-ballot rule (its operative frame is "each official primary
  ballot", where § 21-2-138 puts nonpartisan elections), so it is outside
  this campaign's general-election scope, and the one November analogue
  observed (Richmond 2022 locally-partisan Chief Judge) printed in the
  county block, NOT last; (c) measures-after-candidates — § 21-2-285(f) /
  § 21-2-379.5(f) are PERMISSIVE ("may be printed ... following/below the
  groups of candidates"), which under this campaign's RI precedent
  (numbering/permission ≠ placement mandate) is sample-supported practice,
  not A-grade authority; (d) the county block's internal order, the
  Richmond-style locally-partisan judicial slot, and consolidated
  special-set placement after measures. NO CODE CONSEQUENCE: the in-scope
  leg and both excluded practice legs all match the baseline (empty
  November judicial tier, measures last), and the headline
  US-House-after-executives delta is excluded — so GA still gets NO
  override row.
- Authority: NO statute or SEB rule prescribes a federal→state→local sequence.
  Chain: Ga. Comp. R. & Regs. 183-1-12-.07 ("in the order specified in
  O.C.G.A. §§ 21-2-379.4 and 21-2-379.5"), https://rules.sos.ga.gov/gac/183-1-12
  (official SOS rules site) → §21-2-379.4(b) ("conform as nearly as
  practicable") → §21-2-285(c) — chain terminates without fixing office
  sequence. BMD arrangement delegated: §21-2-379.23(b) "The form and
  arrangement of ballots marked and printed by an electronic ballot marker
  shall be prescribed by the Secretary of State." Placement provisions that
  DO exist: §21-2-285.1 (nonpartisan last — PRIMARY-ballot rule), §21-2-138
  (judicial on primary date), §21-2-285(f)/§21-2-379.5(f) (PERMISSIVE
  authorization to print measures following/below the candidate groups —
  permission, not an ordering mandate; see GRADE SCOPE). (accessed
  2026-08-16.) PRIMARY VERIFICATION 2026-08-16: the official O.C.G.A. portal
  (https://www.lexisnexis.com/hottopics/gacode/ — "made available for public
  use by the Georgia Code Revision Commission on behalf of the Georgia
  General Assembly", serving via advance.lexis.com) was read in a JS browser
  using the search-result-snippet method (TN-style; full-doc view is
  CAPTCHA-walled, not bypassed). Verified verbatim on the official portal:
  § 21-2-285.1 ("insofar as practicable such offices to be filled in the
  nonpartisan election shall be separated from the names of candidates for
  party nomination to other offices by being listed last on each ballot",
  caption "OFFICIAL NONPARTISAN ELECTION BALLOT"); § 21-2-138 ("shall be
  placed on the ballot in a nonpartisan election to be held and conducted
  jointly with the general primary in each even-numbered year"); § 21-2-285(f)
  ("may be printed upon the ballot following the groups of candidates for the
  various offices. Proposed constitutional amendments so submitted shall be
  printed in the order ..."); § 21-2-379.5(f) ("below the groups of
  candidates"); § 21-2-379.23(a)-(b) (both the current and the
  effective-2028 versions: "The form and arrangement of ballots marked and
  printed by an electronic ballot marker shall be prescribed by the
  Secretary of State"); bonus § 21-2-480 (optical-scan, same measures
  language). FindLaw/onecle mirrors remain as convenience cites only, e.g.
  https://law.onecle.com/georgia/title-21/21-2-138.html,
  https://codes.findlaw.com/ga/title-21-elections/ga-code-sect-21-2-285-1.html
- Office order (printed practice, no statute): US Senate (or President/VP in
  presidential years) → Governor → Lt. Gov → SOS → AG → Agriculture →
  Insurance → School Superintendent → Labor → [PSC] → US HOUSE → State Senate
  → State House → county offices (DA/Solicitor, Clerk of Superior Court,
  Sheriff, Tax Commissioner, Surveyor, Commission) → Soil & Water supervisor →
  measures. US House AFTER all eight statewide executives — but only the two
  2022 midterm ballots (plus the May 2022 primary) can test that: Fulton 2024
  is a presidential year with no executives and no US Senate contest, so US
  House prints straight after President/VP there. PSC slot (after Labor,
  before US House) from Richmond May-2022 primary (two PSC contests, D2+D3);
  PSC absent from 2022/2024 generals (Rose v. Raffensperger litigation).
- Judicial: TWO cases, governed by DIFFERENT rules — keep them separate.
  (1) STATE-COURT judicial (Supreme/Appeals/Superior/State Court) is not on
  the November ballot — §21-2-138 puts those elections "in a nonpartisan
  election to be held and conducted jointly with the general primary" (May;
  probate/magistrate are NOT in this section). On THAT May ballot,
  §21-2-285.1 operates (its frame is the official primary ballot): the
  nonpartisan offices are "separated from the names of candidates for party
  nomination to other offices by being listed last on each ballot" "insofar
  as practicable", statutory caption "OFFICIAL NONPARTISAN ELECTION BALLOT"
  (the printed Richmond May-2022 ballot's caption reads "NONPARTISAN
  GENERAL ELECTION" instead). Observed May-2022 internal order: Supreme ×3
  → Court of Appeals ×3 → Superior ×3 → State Court ×2, then the section
  continues with NON-judicial nonpartisan offices (Mayor of Augusta,
  commission seats) — not purely judicial. No retention — all contested
  nonpartisan. (2) LOCALLY-PARTISAN judicial offices CAN still appear in
  the November county block, where NO placement statute controls —
  §21-2-285.1 does not reach the November general: Richmond 2022 "For
  Chief Judge, Civil and Magistrate Court" — ONE contest — printed between
  Tax Commissioner and School Board, incumbent listed "Democrat"
  (county-block practice, not a nonpartisan-last section).
- Measures: last among the REGULAR election's items — amendments → statewide
  referenda → local questions. §21-2-285(f) "may be printed upon the ballot
  following the groups of candidates" (permissive "may", universally
  followed); §21-2-379.5(f) "below the groups of candidates". Consolidated
  SPECIAL-election contest sets print after the measures (Fulton 2024: two
  municipal specials after Referendum A; Gwinnett 2022: SPLOST special after
  the statewide questions) — measures-last holds within the regular set
  only.
- County discretion: partial on paper (§21-2-284 — note: that section is
  "Form of Official Primary Ballot" and its county/SOS split concerns
  certifying party-question wording, not general-ballot prep), uniform de
  facto — SOS prescribes all BMD ballots statewide (§21-2-379.23(b));
  sequence lives in the statewide ballot-build config, no published document
  located.
- School/special: nonpartisan boards (§21-2-139; the "109 of ~180 districts"
  count is unsourced — treat as approximate) print on the MAY nonpartisan
  ballot AFTER judicial (confirmed Gwinnett + Rockdale May 2024); partisan
  boards ride the November county block (Richmond 2022, after the Chief
  Judge contest, before Soil & Water). Soil & Water supervisor =
  consistently last office before measures.
- Corroboration: four ballots, two cycles, all consistent — Gwinnett Nov 2022
  (https://www.gwinnettcounty.com/static/departments/elections/2022-Election/gwinnett-county-elections-general-and-special-sample-ballot-nov-8-2022-zh-yue.pdf,
  vector outlines, read via page render); Richmond Nov 2022
  (https://www.augustaga.gov/DocumentCenter/View/16238/Composite-Sample-Ballot-2022);
  Richmond May 2022 primary
  (https://www.augustaga.gov/DocumentCenter/View/15805/Sample-Ballot-85x14-REP-2022);
  Fulton Nov 2024
  (https://www.fultoncountyga.gov/-/media/Departments/Registration-and-Elections/Sample-Ballot/2024-Sample-Ballots/November-5-General-Election/Composite-Sample-Ballot--November-5-2024-General-Electionrevised-9232024.pdf
  — zero judicial/school/nonpartisan CONTESTS; incidental text hits like
  "Atlanta Judicial Circuit" in office titles exist). No statute-vs-sample
  conflict; the gap is authority, not agreement.
- Baseline delta: REAL, four — (1) US House after statewide executives
  (federal block split); (2) no STATE-COURT judicial on the November ballot
  (May last block instead; locally-partisan judicial can ride the county
  block); (3) school after judicial on the May ballot / mostly absent in
  November; (4) no municipal tier on even-year November (GA municipal =
  odd-year; consolidated special-election sets print after measures).
  Soil & Water = last office slot. Matches: President/Senate top, state
  senate before house, county after legislature, measures last within the
  regular set.
- Notes: grade history — was B on two grounds: (1) mirror-sourced statute
  text, CLOSED 2026-08-16 by primary verification on the official portal
  (see Authority); (2) no authority for the office sequence, which REMAINS
  true and is why the A is scoped (sequence excluded). A 2026-08-16 external
  sweep (Codex-assisted, findings verified where cited) found no official
  SOS document enumerating the sequence: SEB Rule 183-1-12-.07(4) only
  cross-references the statutes above, and a Feb 24, 2021 SEB transcript
  confirms an SOS "ballot proofing checklist" exists but does not reproduce
  it (unverified-by-us transcript detail; public-records request to the SOS
  for the checklist or the Dominion office-order template remains the
  sequence's restore path). Primary
  (one line): single ballot = party primary → party questions → captioned
  nonpartisan section last (§21-2-285.1). Name order (informational): party
  columns by descending last-gubernatorial vote (§21-2-285(c)); alphabetical
  in primaries/specials; no rotation. Open gap: Cobb County (partisan school
  board in November) unverified — sample PDF 403s, site script-rendered.
  Start-hint correction: 183-1-15 = returns/recounts, nothing to do with
  ballot order; operative rule is 183-1-12-.07.

### NC — North Carolina (FIPS 37) — GRADE A
- Authority: NC GS §163-165.6 "Arrangement of official ballots" (a), (b)(1)–(6),
  (h),
  https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_163/GS_163-165.6.html
  — a delegation with guardrails ("The State Board of Elections shall
  promulgate rules prescribing the order of offices"); the operative sequence
  is 08 NCAC 06B .0103 "Arrangement of Official Ballots" (readopted eff.
  2019-06-01, amended eff. 2022-01-01),
  http://reports.oah.state.nc.us/ncac/title%2008%20-%20elections/chapter%2006%20-%20partisan%20elections/subchapter%20b/08%20ncac%2006b%20.0103.html
  (both accessed 2026-08-16, plain HTML; oah.state.nc.us is HTTP-ONLY —
  https on :443 refuses, so a fetcher that force-upgrades will fail)
- Office order: 08 NCAC 06B .0103(b): (1) Federal — President/VP, US Senate,
  US House; (2) State — Governor, Lt. Gov, AG, Auditor, Agriculture,
  Insurance, Labor, SOS, Superintendent of Public Instruction, Treasurer,
  Supreme Court Chief Justice, Supreme Court Associate (by seat), Court of
  Appeals (by seat); (3) District — NC Senate, NC House, Superior Court,
  District Court, District Attorney; (4) partisan county; (5) partisan
  municipal; (6) nonpartisan county; (7) nonpartisan municipal; (8) referenda.
  Within a class: alphabetical by office / numeric by district; full terms
  before partial.
- Judicial: WITHIN-LEVEL, seed confirmed — never a late block. Appellate
  (Supreme → Appeals) tails the STATEWIDE class, after Treasurer and BEFORE
  the General Assembly; trial (Superior → District) tails the DISTRICT class
  after NC House, before county; DA last in class. §163-165.6(b)(4):
  "Judicial offices and district attorney shall be listed, in that order,
  after other offices in the same class." No retention: (b)(6)'s retention
  placement rule is dormant — the 2015 scheme (S.L. 2015-66) was held
  unconstitutional (Faires v. State Bd., 2016) and never used.
- Measures: last. §163-165.6(a): "Candidate ballot items shall be arranged on
  the official ballot before referenda." (h): amendments (chronological,
  labeled only "Constitutional Amendment") → other statewide referenda →
  local referenda. Carve-out in .0103(b)(8): last "unless the voting system
  design requires referenda to be before candidate ballot items".
- County discretion: none over contest order — .0103(a): State Board
  "shall certify to the county boards of elections the order of the offices";
  counties implement only.
- School/special: placement follows PARTISANSHIP not office type — nonpartisan
  school boards (majority) land in class (6) nonpartisan county, AFTER
  partisan municipal; partisan-by-local-act school boards land in class (4).
  Soil & Water supervisor also class (6).
- Corroboration: Wake County 2024 general, style B0140,
  https://www.sunfox.com/wp-content/uploads/2024/11/1295_92_B0140.pdf
  (third-party-hosted copy of the official county style — NCSBE serves sample
  ballots only via per-voter lookup, no static PDF). Printed order matches the
  rule exactly: President/VP → US House 2 → Governor → …Treasurer → Supreme
  Court Seat 6 → Appeals Seats 12/14/15 → NC Senate 14 → NC House 38 →
  District Court 10B → Wake Commissioners → Register of Deeds → [NONPARTISAN]
  Board of Education D4 → Soil & Water → Raleigh Mayor/Council → [REFERENDA]
  Constitutional Amendment → Wake library bonds. Zero conflict.
- Baseline delta: REAL, two axes — (1) judicial within-level: appellate
  between Council of State and legislature, trial between state house and
  county; (2) partisan/nonpartisan split outranks level below district class:
  partisan county → partisan MUNICIPAL → nonpartisan county (incl. school) →
  nonpartisan municipal — baseline's county → municipal → school chain
  interleaves. Matches baseline: federal first, Senate before House, state
  senate before house, measures last.
- Notes: statutory guardrails verbatim — (b)(2) "State and local offices
  shall be listed according to the size of the electorate"; (b)(3) "Partisan
  offices, regardless of the size of the constituency, shall be listed before
  nonpartisan offices". HISTORICAL BREAK: pre-2018 NC judicial races were
  nonpartisan and printed in a genuinely late block — S.L. 2017-3/2018-13
  made them partisan; old cycles do NOT match the current order. (b)(1) pins
  "Member of the United States House of Representatives shall be listed
  immediately after United States Senator" (no US Senate seat in 2024 →
  absent from sample). (f) bans straight-party. Name order (informational):
  (c) single statewide drawing, alphabetical or reverse-alphabetical.
  Primaries: contest order unchanged; per-precinct NAME rotation added by 08
  NCAC ch. 10.

### MI — Michigan (FIPS 26) — GRADE A
- Authority: MCL 168.697 (partisan office order),
  https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-168-697; MCL 168.699
  (nonpartisan section + internal order),
  https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-168-699; MCL 168.703
  (party-COLUMN order only); MCL 168.706 (arrangement delegated to SOS);
  Const 1963 art II §4(1)(c) (straight-party); Michigan Ballot Production
  Standards, Sept 2024 edition (compulsory per Ch. 1 p.4),
  https://www.michigan.gov/-/media/Project/Websites/sos/01mcalpine/BallotStandards.pdf
  (all accessed 2026-08-16). Fetch gotchas: legislature.mi.gov fails
  WebFetch/curl with a TLS chain error ("unable to verify the first
  certificate") — browser only; michigan.gov PDFs 403 to plain fetch (curl +
  browser UA works); mvic.sos.state.mi.us script-rendered + Cloudflare-gated.
- Office order: Partisan Section, MCL 168.697 verbatim: "Electors of President
  and Vice President of the United States; governor and lieutenant governor;
  secretary of state; attorney general; United States Senator; Representative
  in Congress; senator and representative in the state legislature; members
  of the state board of education; regents of the University of Michigan;
  trustees of Michigan State University; governors of Wayne State University;
  county executive; prosecuting attorney; sheriff; clerk; treasurer; register
  of deeds; …" then township officers "in substantially the following order:
  supervisor, clerk, treasurer, trustees, and constables." Standards Ch. 13
  adds County Commissioner at county-block end, partisan City between county
  and township, Precinct Delegate last. Straight Party Ticket position FIRST
  (Const art II §4(1)(c)). Office-block form; party labels under names
  (168.703 orders candidates within office, not offices).
- Judicial: separate nonpartisan section after the whole partisan section,
  judicial FIRST inside it. MCL 168.699 verbatim: "…in the following order:
  justices of the supreme court, judges of the court of appeals, judges of
  the circuit court, judges of the probate court, judges of the district
  court, community college board of trustees member, intermediate school
  district board member, city officers, …local school district board member,
  metropolitan district officer, and district library board member."
  Standards add Probate District + Municipal Court slots. No retention —
  incumbency designation instead (MCL 168.409b, Const art VI §24; within-
  office order Incumbent → Non-Incumbent → New Judgeship).
- Measures: last — Proposal Section after the nonpartisan section (Standards
  Ch. 11/20/21; Ch. 17: "Previous legislation passed affected only candidate
  race order and did not influence the order of proposals"). Internal order
  (Ch. 17 p.33): State → County → City → Township → Village → Local School →
  ISD → Community College → Metropolitan → District Library — but labeled
  "strongly encouraged", i.e. guidance, unlike the compulsory Ch. 11/13
  rules.
- County discretion: effectively none over sequence (SOS arrangement per MCL
  168.706, Standards compulsory). Pockets: city office order governed by city
  charter (both partisan + nonpartisan city blocks); authority items follow
  their parent unit; vendor layout latitude (banner scaffolding varies —
  Farmington Hills prints no section banners; ordering identical).
- School/special: all in the nonpartisan tail AFTER every judicial race
  (order above). BUT State Board of Education + U-M regents + MSU trustees +
  WSU governors are PARTISAN, printing between the state legislature and
  county offices ("State Boards" header) — no baseline slot.
- Corroboration: Mason County 2022 general (cycle 2022; SMALL county — the
  researcher retracted two earlier populous-county 2024 citations as
  unverified, see Notes), official sample ballot for a real precinct,
  published by the SOS (Mock-Election-Portal folder):
  https://www.michigan.gov/sos/-/media/Project/Websites/sos/Elections/Mock-Election-Portal/Mason-Sample-Ballot.pdf
  (City of Ludington Pct 1). Confirms in printed order: Partisan Section →
  Straight Party → State (Governor+Lt.Gov joint → SOS → AG) → Congressional
  (US Rep 2nd) → Legislative → State Boards (State BOE → U-M Regent) →
  County → Nonpartisan Section → Judicial (Supreme Court → Court of Appeals
  w/ Incumbent/Non-Incumbent positions) → Community College → City → Local
  School District → Proposal Section → State (22-1/22-2/22-3) last.
  Judicial-before-school, executives-before-Congress, proposals-last all
  confirmed on a real ballot; reinforced by the SOS's own full-ballot
  specimen in Standards Ch. 21. No statute/sample conflict on any point.
- Baseline delta: REAL, three — (1) statewide executives (Gov+Lt.Gov → SOS →
  AG) BEFORE US Senator/US Rep (statutory, MCL 168.697); (2) judicial leads
  the nonpartisan section, ahead of nonpartisan county/municipal/school —
  reverse of baseline school-before-judicial; (3) partisan education/
  university boards between state legislature and county. NOTE the
  nonpartisan tail does NOT reduce to a county→municipal→school progression:
  education contests sit on BOTH sides of the municipal offices — Community
  College and Intermediate School District print BEFORE city, while Local
  School District prints AFTER village (MCL 168.699 order above) — so an
  implementation needs distinct ranks for CC/ISD vs local school board.
  Matches: President first, legislature after Congress, measures last.
- Notes: RESEARCH RETRACTION recorded — the researcher's first report cited
  Wayne (Brownstown Twp) and Oakland (Farmington Hills) Nov-2024 sample
  ballots; it then retracted both as never actually fetched/verified. Do NOT
  cite those URLs; Mason 2022 + the Standards specimen are the only verified
  samples. Grade A stands on the rubric (authority + matching real ballot)
  but with caveats: sample is a small county, cycle 2022, and 2022 had
  neither presidential electors nor a US Senate race — so Electors-of-
  Pres/VP placement and US Senator's position relative to the executives
  rest on MCL 168.697 text alone. A populous-county 2024 ballot remains an
  open follow-up (mvic.sos.state.mi.us has it but the
  /PublicBallot/GetMvicBallot endpoint is script-rendered +
  Cloudflare-gated). 168.697 says "substantially in the following order"
  (softener); 168.699 says "in the following order" (strict); Standards
  remove the slack. Mason PDF two-column extraction scrambles the intra-
  state proposal sequence — only section placement confirmed there.
  Precinct delegates elected at August primary, never on the general.
  Primaries (one line): per-party sections, nonpartisan primary = judicial +
  some city only, undersubscribed offices omitted. Name order
  (informational): MCL 168.569a + R168.774(9) precinct rotation on
  nonpartisan ballots when contested; alphabetical otherwise; partisan
  general follows 168.703 party order. Standards republish per cycle — carry
  the edition forward.

## Batch 2

### NJ — New Jersey (FIPS 34) — GRADE A
- Authority: R.S. 19:14-8 "Arrangement of ballots" (as amended through
  L.2017, c.206, s.4), official NJ Division of Elections posting,
  https://nj.gov/state/dos-statutes-elections-19-10-19.shtml (accessed
  2026-08-16). Supporting: R.S. 19:14-2 + 19:14-13 + 19:14-14 (public
  questions), 19:14-12 (ballot draw), R.S. 19:49-2 as amended by P.L.2025,
  c.32, s.7 (county-clerk final arrangement),
  https://nj.gov/state/dos-statutes-elections-19-40-49.shtml; R.S. 19:60-9
  (school elections),
  https://nj.gov/state/dos-statutes-elections-19-60-63.shtml; P.L.2025,
  c.32 session law, https://pub.njleg.gov/Bills/2024/PL25/32_.HTM; NJ
  Const. via https://www.njleg.state.nj.us/constitution.
- Office order: statutorily fixed top-to-bottom within each party column
  (party-column "blanket" ballot at generals): presidential electors → US
  Senator → GOVERNOR → US House → State Senate → General Assembly → county
  executive (charter counties) → sheriff → county clerk → surrogate →
  register of deeds and mortgages → county supervisor → county
  commissioners (statute: "chosen freeholders") → coroners → mayor +
  municipal governing body → "any other titles of office". Governor sits
  BEFORE US House in statute but the pairing never occurs — Governor is
  odd-year (Const. art. XI (Schedule) §III ¶1, "at the general election to
  be held in the year one thousand nine hundred and forty-nine and every
  fourth year thereafter"; NOT art. V §III, which is the militia clause —
  citation fixed in verification), so no shared ballot. Lt. Governor runs
  conjointly (single vote); no other statewide executive elected (AG/SOS
  appointed, art. V §IV ¶3).
- Judicial: NONE — NJ elects no judges at any level (Const. art. VI §VI ¶1,
  gubernatorial appointment w/ Senate consent); no retention elections.
  Judicial block should be omitted entirely for FIPS 34.
- Measures: after all offices, "in a separate space at the foot of the
  ballot" under "Public Questions to be voted upon" (19:14-2, 19:14-14).
  Internal order (19:14-13): STATEWIDE first (SOS-certified order) →
  MUNICIPAL second → COUNTY last (municipal/county by clerk lot-draw).
  Exception: school-district money questions print NEAR the school-board
  candidates, not in the foot block (19:60-9, "below or to the right of"
  at clerk's option) — AUTHORITY-ONLY, no sampled ballot exercised it
  (Teaneck's foot-block question was municipal open-space).
- County discretion: real but bounded — 19:49-2 gives each county clerk
  "the specifications for, and the final arrangement of" general ballots
  "to the extent not inconsistent with the provisions of this Title";
  19:14-8 sequence stays mandatory. Named carve-outs: school/fire section
  layout at clerk discretion (19:14-8); school-question below-vs-right
  (19:60-9). Party COLUMN order + candidate order = clerk lot-draw
  (19:14-12), not statute.
- School/special: school board + fire commissioners pulled OUT of the
  sequence into a separate section — "shall be listed in a section of the
  ballot that is separate from the section featuring other candidates
  whenever possible in a layout at the discretion of the county clerk"
  (19:14-8). WHERE that section sits is clerk layout, not statute: Bergen
  prints a "NON-PARTISAN SCHOOL ELECTION" block below the partisan block;
  Hudson (Jersey City 2024) prints Board of Education as a separate
  right-hand "COLUMN J". Regional board prints ABOVE local board
  (19:60-9). Nonpartisan municipal contests likewise get their own
  "NON-PARTISAN MUNICIPAL ELECTION" block (Bergen: between partisan and
  school).
- Corroboration: Bergen County 2024 general, Hackensack sample,
  https://www.bergencountyclerk.gov/_Content/pdf/voting/sample-ballots/2024-general/Hackensack.pdf
  — presidential electors → US Senator → US House → Sheriff → County
  Commissioners, then separate "NON-PARTISAN SCHOOL ELECTION" / Local Board
  of Education. Teaneck same cycle,
  https://www.bergencountyclerk.gov/_Content/pdf/voting/sample-ballots/2024-general/Teaneck.pdf
  — adds NON-PARTISAN MUNICIPAL (Township Council) after county offices +
  "PUBLIC QUESTION TO BE VOTED UPON" in the bottom band. 2025 odd-year
  Hackensack,
  https://www.bergencountyclerk.gov/_Content/pdf/voting/sample-ballots/2025/Hackensack-Gen25.pdf
  — Governor & Lt. Governor → General Assembly → County Commissioners →
  separate school block. Second county (verification): Hudson, Jersey City
  Form 6, 2024,
  https://www.hudsoncountyclerk.org/wp-content/uploads/2024/09/2024-General-Election-F06-JC.pdf
  — presidential electors → US Senator → US House → Surrogate, Board of
  Education in separate COLUMN J. No statute-vs-sample conflict.
- Baseline delta: SEVERAL. (1) Governor between US Senate and US House in
  statute — moot in practice (odd-year), record only. (2) County tier has a
  mandated internal order (executive → sheriff → clerk → surrogate →
  register → supervisor → commissioners → coroners), not one bucket.
  (3) Judicial block does NOT EXIST — delete for NJ, don't sort late.
  (4) School/fire = physically separate nonpartisan section, not a late
  tier; nonpartisan municipal separate too. (5) Measures-last holds but
  internal order statewide → MUNICIPAL → COUNTY (baseline has no
  municipal-before-county rule). (6) School money questions print beside
  school-board contest — exception to measures-last.
- Notes: even-year NJ generals carry NO state contests at all (Governor +
  Assembly odd-year, Senate 2023/2027 cycle) — federal + county + local
  only. P.L.2025, c.32 (A5116, the county-line/office-block redesign after
  Kim v. Hanlon) amends PRIMARY ballot statutes + 19:49-2 only — it does
  NOT touch 19:14-8, so general-election contest order unchanged (decisive
  negative finding from the session-law text). Candidate order within
  contest (informational): clerk capsule draw 3pm on the 85th day before
  the general (19:14-12); never implemented. Statute's "board of chosen
  freeholders" prints as "Board of County Commissioners"; "coroners" is
  dead in practice. Dangling cross-reference: 19:14-2 cites a nonexistent
  19:14-15 (likely repealed into 19:14-13 by L.1979, c.191 — unconfirmed,
  practical effect nil). IMPLEMENTATION CAUTION: "NJ elects no judges"
  holds for every court, but the elected SURROGATE is a probate officer
  who sits as judge of the Surrogate's Court — if the office classifier
  tags "Surrogate" as judicial, NJ's deleted judicial block would misfile
  a mandatory county-tier office (N.J.S.A. 2B:14-1 unverified — flag, not
  assertion).

### VA — Virginia (FIPS 51) — GRADE A
- Authority: Va. Code § 24.2-613 "Form of ballot" (A), (C), (D),
  https://law.lis.virginia.gov/vacode/title24.2/chapter6/section24.2-613/ —
  delegates to the State Board; operative order = Virginia SBE "Ballot
  Standards", August 2022 edition, pp. 8, 19-22, 40 ("Ballot Placement"
  numbered list 1-33),
  https://www.elections.virginia.gov/media/formswarehouse/election-management/ballots/2022-08-SBE-Ballot-Standards-and-Verification-Procedures.pdf
  (confirmed current edition on the ELECT Forms Warehouse,
  https://www.elections.virginia.gov/formswarehouse/election-management/).
  (all accessed 2026-08-16)
- Office order: single numbered list 1-33 used for EVERY November general
  (absent offices skipped, filter not re-order): 1 President → 2 US Senate →
  3 US House → 4 GOVERNOR → 5 Lt Governor → 6 AG → 7 Senate of Virginia →
  8 House of Delegates → locality-wide: 9 Clerk of Court → 10
  Commonwealth's Attorney → 11 Sheriff → 12 Commissioner of Revenue → 13
  Treasurer → 14 Chairman Board of Supervisors / Mayor → 15 Supervisors/
  Council at-large → 16 Chairman School Board → 17 School Board at-large →
  district/ward: 18 Supervisors/Council district → 19-20 School Board
  district → 21 Soil & Water Conservation Director → town: 22 Mayor → 23-24
  Town Council → 25 Recorder → 26 Treasurer → measures 27-33. Governor
  AFTER US House (matches baseline — a first among researched deviating
  states); executives Gov → LtGov → AG. Tie-break: general before special
  for the same office.
- Judicial: NONE — Va. Const. art. VI §7, justices and "judges of all other
  courts of record" chosen by majority vote of each house of the General
  Assembly. Negative corroboration: placement list 1-33 has no judicial
  office; zero judicial contests across 538pp (2024, 269 styles) + 530pp
  (2025, 265 styles) of Fairfax sample books.
- Measures: all after all offices — § 24.2-613(D) "all offices to be
  elected shall appear before any questions presented to the voters".
  Internal order (Standards p.22): 27 statewide constitutional amendment →
  28 statewide bond → 29 regional referendum → 30 locality bond → 31
  locality referendum → 32 district/ward → 33 town. § 24.2-615: separate
  question per amendment.
- County discretion: NONE by default — order list is a mandatory Board
  requirement, § 24.2-613(A) makes SBE standards binding; 1VAC20 carries NO
  ballot-order rule (ten chapters, none ballots). Only escape = per-locality
  waiver approved by the Commissioner of Elections (Standards p.40).
- School/special: school board NOT a late block — INTERLEAVED into locality
  blocks: at-large seats 16-17 right after at-large governing body, before
  district-level offices; district seats 19-20 inside the district block.
  Soil & Water Conservation Director 21 = only special-district slot, after
  school, before town.
- Corroboration: Fairfax County, both cycles, no conflict. (a) Nov-2024
  all-styles book (538pp),
  https://www.fairfaxcounty.gov/elections/sites/elections/files/Assets/sample%20ballots/2024/2024-11-5/2024_Nov_FullBallots_Web.pdf
  — 104-CHAPEL: President → US Senate → US House 11th; reverse:
  Constitutional Amendment Q1 → county Transportation Bonds; 319-HERNDON#1
  adds Mayor Town of Herndon → Town Council in the town slot. (b) Nov-2025
  book (530pp),
  https://www.fairfaxcounty.gov/elections/sites/elections/files/Assets/Documents/PDF/2025_November_General_Web.pdf
  — Governor → Lt Gov → AG → House of Delegates 14th; reverse: Public
  School Bonds; Vienna style: Mayor → Town Council → bond. Confirms slots
  1-6, 8, 22-23, 27, 30 + offices-before-questions. SCHOOL INTERLEAVE
  ballot-confirmed by verification: Stafford County Nov-2025
  (https://cdn.staffordcountyva.gov/Voter%20Registration/Website%20Sample%20Ballots.pdf)
  — Governor → LtGov → AG → House of Delegates 64th → Supervisors Hartwood
  District → SCHOOL BOARD Hartwood District → End of Ballot (slot 18 → 20
  adjacency, every district style); City of Alexandria Nov-2024
  (https://www.alexandriava.gov/sites/default/files/2024-09/2024_nov_sample_ballot_district_a_colored_background.pdf)
  — President → US Senate → US House 8th → Mayor → City Council (vote for
  six) → School Board District A → Proposed Constitutional Amendment (slots
  14 → 15 → 20 → 27).
- Baseline delta: SEVERAL. (1) Judicial block does not exist — drop for VA
  ("Judge"/"Justice" = zero hits across both Fairfax books). (2) School NOT
  late — interleaved at 16-17/19-20 inside locality blocks (biggest
  structural delta; district seats 18→20 + at-large-city 15→20 now
  BALLOT-CONFIRMED via Stafford 2025 + Alexandria 2024; still
  authority-only: slots 16-17 Chairman/At-Large School Board and 21 Soil &
  Water). (3) County + city merged into shared locality
  blocks; TOWN separate and last (after Soil & Water). (4) Soil & Water
  slot 21 — baseline has none. (5) Measures internally sequenced statewide
  → regional → locality → district → town. (6) Constitutional-officer run
  (Clerk of Court → Commonwealth's Attorney → Sheriff → Comm. of Revenue →
  Treasurer) ahead of governing body. NO delta on federal head or
  executives: Pres → US Sen → US House → Gov → LtGov → AG matches baseline
  exactly.
- Notes: ONE list for odd + even Novembers — a filter, not two orders.
  Even-year November = federal + local/town + questions (slots 4-8 empty);
  odd-year = executives + General Assembly + local/town (slots 1-3 empty);
  2023/2027 cycle carries Senate of Virginia + constitutional officers
  (slots 7, 9-13 — authority-only, neither sampled cycle had them;
  Chesterfield's Nov-2023 book is the right test but 404s live and
  Wayback's sole capture 503s).
  Primary difference (one line): same office order; candidate order flips
  to filing order (Standards p.29, § 24.2-529). Candidate order within
  contest (informational): party order by SBE lot, recognized parties next,
  independents last by filing time (§ 24.2-613(C)); never implemented.
  § 24.2-640 is REPEALED (Acts 2014) — live sample-ballot section is
  § 24.2-641 (posting only, no order). Separate RCV ballot standard (June
  2022) exists, unread — may affect layout where a locality adopts RCV.

### WA — Washington (FIPS 53) — GRADE A
- Authority: RCW 29A.36.121 "Order of positions or offices",
  https://app.leg.wa.gov/RCW/default.aspx?cite=29A.36.121; WAC 434-230-025
  "Order of offices" (explicit 25-item sequence; authority RCW 29A.04.611;
  last amended WSR 24-03-053 eff. 2024-02-10 — DELETED "Advisory votes",
  repealed 2023; pre-2024 mirror copies are stale),
  https://app.leg.wa.gov/wac/default.aspx?cite=434-230-025, list
  independently confirmed via the rulemaking order
  https://lawfilesext.leg.wa.gov/law/wsr/2024/03/24-03-053.htm; seed
  re-confirmed RCW 29A.36.161(3) (state measures "must appear after the
  instructions and before any offices"); WAC 434-230-030 (local measures);
  RCW 29A.72.290 (state-measure internal order). (all accessed 2026-08-16)
- Office order: WAC 434-230-025 items (1)-(25): state measures (1)-(5) →
  (6) countywide measures → (7) President/VP → (8) US Senator → (9) US
  Representative → (10) Governor → (11) Lt Gov → (12) SOS → (13) Treasurer →
  (14) Auditor → (15) AG → (16) Public Lands Comm → (17) Superintendent of
  Public Instruction → (18) Insurance Comm → (19) State Senator → (20) State
  Rep → (21) county officers → (22) Supreme Court → (23) Court of Appeals →
  (24) Superior Court → (25) District Court → all other jurisdictions
  (city/school/special) per county auditor procedures. Federal ABOVE
  Governor — WA matches the baseline's federal-first spine (minority pattern
  among researched states so far).
- Judicial: late block but NOT last — items (22)-(25) sit after county
  officers and BEFORE municipal/school/special-district contests. Internal
  order Supreme → Appeals → Superior → District. SPI, though nonpartisan, is
  NOT in the judicial block — interleaved in the executive run at (17),
  labeled "nonpartisan office" (WAC 434-230-035; labeling ≠ reordering).
- Measures: state measures FIRST, before any office (RCW 29A.36.161(3)),
  internal order initiatives-to-people → referendum measures → referendum
  bills → initiatives-to-legislature (+alternates) → constitutional
  amendments (RCW 29A.72.290, serial-number order within headings).
  COUNTYWIDE measures immediately after state measures, still before offices
  (WAC 434-230-030 "listed immediately following state ballot measures").
  Other local measures print with their jurisdiction in the late tail (or a
  county-option special-measures area).
- County discretion: bounded — items (1)-(25) mandatory statewide; below
  (25), each county MUST adopt written procedures fixing sub-county
  jurisdiction order (WAC 434-230-030), consistent election to election. The
  tail's POSITION (after judges) is statewide; order WITHIN it is county-set.
- School/special: school/fire/port/water districts = "all other
  jurisdictions" after item (25); normally ODD-year contests (RCW 29A.04.330
  "city, town, and district general elections ... in the odd-numbered
  years") so rarely on even-year generals — their district MEASURES do
  appear there, same tail position.
- Corroboration: King County Nov-2024 general, style SEA 36-1386,
  https://cdn.kingcounty.gov/-/media/king-county/depts/elections/current-election/202411/sample-ballots/sample-ballot.pdf
  — Instructions → state measures (I-2066 "Initiative to the People", then
  initiatives to the legislature) → President/VP → US Senator → US Rep →
  Governor → Lt Gov → SOS → Treasurer → Auditor → AG → Public Lands → SPI
  ("nonpartisan office") → Insurance Comm → State Reps → Supreme Court →
  Court of Appeals → Superior Court → City of Seattle Prop 1 → Seattle
  Council Pos 8 → "End of Ballot". Confirms measures-first, executive order
  incl. SPI wedge, judicial above city, city measure printing with its city.
- Baseline delta: LARGE, four departures. (1) Measures FIRST (state, then
  countywide), not last. (2) Judicial block EARLIER than baseline — after
  county, before municipal/school/special. (3) Municipal/school/special dead
  last, internal order county-determined. (4) Executive INTERNAL order is
  FIXED (Gov → LtGov → SOS → Treasurer → Auditor → AG → Public Lands → SPI
  → Insurance) — the baseline ranks all statewide executives at one tier
  with a generic title tie-break, so WA's mandated sequence diverges.
  (SPI sitting inside the executive run is NOT itself a delta — the
  baseline already treats statewide non-judicial offices as one tier.)
  Matching baseline: federal-first spine, senate-before-house, Supreme →
  Appeals → trial.
- Notes: RCW 29A.36.121(1) is written for the PRIMARY ballot; the general
  "shall be substantially the same as on a primary ballot" (RCW
  29A.36.121(2)) + measures-first + President-first additions. Top-two
  general normally = 2 candidates/office ordered by primary vote, highest
  first (RCW 29A.36.170(1)) — EXCEPT judicial + SPI, where a
  majority-in-primary winner prints ALONE in the general (RCW
  29A.36.170(2); King's 2024 ballot shows single-name Supreme Court Pos 8/9
  and both Appeals seats); initial candidate order by lot (RCW 29A.36.131)
  — informational, never implemented. Unobserved on a real ballot: item
  (21) county officers (King = charter county, odd-year offices; Pierce
  County PDF 403-blocked) and item (25) District Court. Possible conflict
  recorded, unresolved — and EXCLUDED from the grade-A scope: pypdf
  extracted King's initiatives-to-legislature as 2124 → 2117 → 2109 vs RCW
  29A.72.290's serial-number order — likely a multi-column extraction
  artifact, needs visual read or second county; until then no override may
  encode the WITHIN-group serial order of state measures (immaterial to
  the ranker anyway — measures share one tier, sub-ordering individual
  measures is below its granularity). The measures-BEFORE-offices
  placement itself is unaffected (statute + ballot agree).
  Corroboration URL sits on a /current-election/202411/ path — expect rot.

### AZ — Arizona (FIPS 04) — GRADE A (scoped — see Notes)
- Grade scope: A covers the partisan sequence, the nonpartisan-section
  position, retention placement, and measures. It EXCLUDES the placement
  of contested (elected) Superior Court judges in the 11 non-retention
  counties — the one leg with conflicting evidence (2025 EPM nonpartisan
  slot 5 vs La Paz 2022 printing it in the partisan section) — so no
  override may encode that sub-office until the conflict resolves.
- Authority: A.R.S. § 16-502 "Form and contents of ballot",
  https://www.azleg.gov/ars/16/00502.htm; A.R.S. § 19-125 (measure
  numbering), https://www.azleg.gov/ars/19/00125.htm; AZ SOS 2025 Elections
  Procedures Manual (approved 2025-12-22 — operative for Nov 2026), Ch. 8
  § V.A.3 "Order of Candidate Races" (pp. 167-169) + A.5.b "Order of Ballot
  Measures" (pp. 172-173),
  http://apps.azsos.gov/election/files/epm/2025/Election-Procedures-Manual-2025--FINAL-12-22-25.pdf.
  EPM has force of law — A.R.S. § 16-452(C) makes violation a class 2
  misdemeanor. (all accessed 2026-08-16)
- Office order: § 16-502(C) fixes five coarse tiers (presidential electors
  → US senator → US representatives → "the several state offices" → county
  and precinct offices); the EPM enumerates: SECTION ONE PARTISAN — 1
  Presidential electors → 2 US Senator → 3 US Representative → 4 GOVERNOR
  AND LT GOVERNOR (joint ticket, first used 2026; 2023 EPM = Governor
  alone) → 5 STATE SENATOR → 6 STATE REPRESENTATIVE → 7 SOS → 8 AG → 9
  Treasurer → 10 Superintendent of Public Instruction → 11 Mine Inspector
  → 12 Corporation Commissioner → 13 county offices → 14 Justice of the
  Peace → 15 Constable. KEY WRINKLE: the LEGISLATURE splits the executive
  block — § 16-502(D) puts legislative candidates "immediately below the
  candidates for the office of governor", and the EPM keeps legislature
  before the remaining statewide offices even in non-gubernatorial years.
  Governor sits AFTER US House (federal-first partisan section). JP +
  Constable are PARTISAN and close section one, after county offices.
- Judicial: NOT a late block — judicial OPENS the nonpartisan section, but
  as an EPM DEFAULT with a lawful county override, not a hard statutory
  rule: § 16-502(I) prints the heading "Section Two / Nonpartisan Ballot";
  § 16-502(J) is ONE sentence covering judges AND "school district
  officials and other nonpartisan officials ... in an order determined by
  the officer in charge of the election" — only the EPM fixes
  judicial-first, and its "reasonably adjust" escape has three grounds
  (reverse-side avoidance, reverse-side uniformity, blank-space
  elimination). EPM nonpartisan order: 1 Supreme Court
  (retention, all counties) → 2 Court of Appeals Div 1 → 3 Div 2 → 4
  Superior Court RETENTION (Maricopa/Pima/Pinal/Coconino only) → 5 Superior
  Court CONTESTED (other 11 counties; partisan primary, NO party label in
  general — Ariz. Const. art. VI § 12) → then school → community college →
  JTED → special taxing district → city/town mayor → city/town council.
  Vacant unexpired nonpartisan terms print under a separate heading below
  (§ 16-502(K)).
- Measures: LAST — § 16-502(L) "immediately below the names of candidates
  for nonpartisan positions". EPM order: state constitutional amendments →
  statewide statutory initiatives → statewide referenda → county measures
  (incl. school/JTED/college/special-district measures) → city/town
  measures. Numbering (§ 19-125(B)): constitutional = 100-series;
  statutory initiative = 200; referendum = 300; county/local = 400;
  amendments "by themselves at the head of the ballot column".
- County discretion: real but bounded — (a) § 16-502(J) nonpartisan order
  "determined by the officer in charge of the election", constrained by the
  EPM list w/ escape only for reverse-side/blank-space adjustments; (b)
  internal order of the eight county offices (Supervisor, Assessor,
  Attorney, Clerk of Superior Court, Recorder, School Superintendent,
  Sheriff, Treasurer) is officer-determined; (c) local measure placement
  delegated (§ 16-502(L)). Partisan sequence NOT reorderable.
- School/special: school/college/JTED/special-district boards nonpartisan,
  AFTER the judicial block, BEFORE city/town — municipal offices are the
  LAST candidate races. Their bond/override QUESTIONS print separately in
  the county tier of the measures block, not beside board races.
- Corroboration: Pinal County Nov-2024 official ballot style
  PINA_105_001G05,
  https://www.pinal.gov/DocumentCenter/View/21280/PINA_105_001G05_1_1_NON-DEC
  — presidential electors → US Senator → US Rep CD-2 → State Senator LD-7 →
  State Rep LD-7 → Corporation Commission → Supervisors → Assessor →
  Attorney → Recorder → Sheriff → School Superintendent → Treasurer →
  "Section Two - Nonpartisan Ballot" (verbatim printed heading; "Section
  One - Partisan Ballot" heads the partisan run) → Supreme Court retention
  → Superior Court retention → "MEASURES SUBMITTED TO VOTERS" → Props
  137-140 (statewide constitutional) → 311-315 (statewide) → 486 (Pinal
  county road tax) → 489 (Ray USD budget override). Confirms
  legislature-before-Corporation-Commission, the literal Section Two
  heading w/ judges beneath, § 16-502(L) measures-last, AND the EPM
  measure sub-order (state → county → school-district override).
  (Verification pass re-extracted the PDF cleanly with PyMuPDF — the
  original researcher's "headings undecodable" caveat was a tooling
  limitation, since removed.) Secondary: Maricopa Nov-2024 final canvass
  (264 contests) — same federal→legislative→CorpComm→county→JP/Constable
  head; measures tail exactly § 19-125 series (133-140 → 311-315 → 479 →
  486). Late verification round added: (a) additional Pinal 2024 styles
  (https://www.pinal.gov/DocumentCenter/View/21383 = style 042G02 w/
  school bond, .../21430 = 061G04 w/ JP, .../21505 = 093G07 w/ town
  office+measure; index https://www.pinal.gov/QuickLinks.aspx?CID=634) —
  SCHOOL BOARDS PRINT AFTER THE JUDICIAL RETENTION BLOCK on every style
  carrying both (Apache Junction USD / Casa Grande UHS board members
  after the Supreme + Superior retentions), and Justice of the Peace is
  the LAST partisan contest directly before the Section Two header; local
  props print after ALL statewide props in number order, countywide (486)
  before sub-county (487/492). (b) La Paz County Nov-2022 all-styles book
  (https://www.co.la-paz.az.us/DocumentCenter/View/7966/Nov-8th-Sample-Ballots-PDF)
  — the EXECUTIVE SPLIT IN PRINT on a gubernatorial ballot: US Senator →
  US Rep → GOVERNOR → State Senator → State Rep → SOS → AG → Treasurer →
  Superintendent → Mine Inspector → Corporation Commissioner → county
  offices → JP → Constable; Section Two = Supreme Court retentions →
  Appeals Div I → school/town offices; measures 128-132 → 209/211 →
  308-310.
- Baseline delta: SUBSTANTIAL, three departures. (1) Statewide executives
  SPLIT by the legislature: Gov(+LtGov) → state senate → state house → SOS
  → AG → Treasurer → Supt → Mine Inspector → Corp Comm — only Governor
  precedes the legislature. (2) Judicial NOT late — opens the nonpartisan
  section ahead of school/college/special/municipal (internal supreme →
  appeals → trial matches). (3) Municipal comes after school and LAST among
  candidate races. Matching: federal-first top, senate-before-house, county
  before local, measures last.
- Notes: the Maricopa-canvass question is now SETTLED by printed ballots —
  the canvass (school/city before judicial) is jurisdiction-grouped
  reporting, and Pinal styles carrying BOTH contests print judicial
  retention FIRST, school boards after, matching the EPM; the EPM default
  holds on every printed ballot examined. 2022 executive split now
  ballot-observed (La Paz above); the Gov+LtGov joint ticket still debuts
  Nov-2026 (2022 Prop 131). CONFLICT RECORDED, NOT RESOLVED — and
  EXCLUDED from the grade-A scope (see Grade scope above): La Paz 2022
  prints its ELECTED Superior Court judge INSIDE Section One (partisan),
  between Clerk of the Superior Court and JP — the 2025 EPM puts
  contested Superior Court at NONPARTISAN slot 5, and § 16-502(J) itself
  delegates nonpartisan order to the election officer, so neither reading
  can be assumed. The 2022 ballot predates the 2023/2025 EPM editions
  (possibly superseded practice); resolve via an elected-judge county
  (Apache/Cochise/Yavapai...) Nov-2026 sample. Community-college
  boards never observed on any style (no seats up) — placement inferred
  from the EPM only. EPM edition
  delta (UNVERIFIABLE as of the verify pass — the 2023 EPM URL went dead
  between research and verification; claims retained but not
  re-established): 2023 EPM listed Governor alone at slot 4 and had
  special-taxing-district measures as a separate final bullet after city;
  2025 folds them into county measures. Party column
  order (informational): descending gubernatorial vote per county
  (§ 16-502(E)); candidate rotation across districts (§ 16-502(H)); recalls
  of partisan officials print in the partisan section (§ 19-213); never
  implemented. Fetch gotchas: azsos.gov + elections.maricopa.gov Cloudflare
  403 vs curl — needed in-browser same-origin fetch; Pima samples
  address-gated (no static PDFs).

### TN — Tennessee (FIPS 47) — GRADE A (upgraded from B 2026-08-16)
- Grade rationale: the former B was a SOURCING cap only, and its stated
  restore path ("read § 2-5-208 on an official source") is now SATISFIED.
  On 2026-08-16 the complete current text of T.C.A. § 2-5-208 — lead-in,
  the full (c)(1) office list (A)-(CC), (c)(2) alphabetical tie rule,
  (c)(3) retention-at-end, and the (f)(1) amendments-after-Governor rule —
  was read on the OFFICIAL LexisNexis-hosted "Tennessee Code Unannotated –
  Free Public Access" portal (entry https://www.lexisnexis.com/hottopics/tncode/,
  serving via advance.lexis.com). Retrieval method: the portal's full-document
  view is CAPTCHA-walled (not bypassed); the section text was recovered from
  the portal's own search-result snippets across 7 targeted phrase searches
  and stitched — every fragment letter-identical to the FindLaw/Justia
  mirrors previously cited. Currency proven in-portal: the snippet shows
  "(j) [Deleted by 2023 amendment.]", matching Public Chapter 346 (2023).
  Bonus official corroboration: T.C.A. § 2-13-311(2) (same portal) — state,
  county, and municipal offices on the presidential-preference ballot
  "shall appear in the order outlined in § 2-5-208". Everything below
  stands as researched; the mirror URLs remain as convenience cites only.
- Authority: T.C.A. § 2-5-208 (Arrangement of material on ballots), subsecs.
  (a), (c)(1)-(3), (d), (f)(1) — PRIMARY-VERIFIED 2026-08-16 on the official
  LexisNexis-hosted portal (https://www.lexisnexis.com/hottopics/tncode/;
  see Grade rationale for the retrieval method). Convenience mirror:
  https://codes.findlaw.com/tn/title-2-elections/tn-code-sect-2-5-208/
  (letter-identical). Currency also confirmed by the official 2023 Public
  Chapter 346 PDF
  (https://publications.tnsosfiles.com/acts/113/pub/pc0346.pdf — deletes
  old subsec. (j), and the official portal text shows
  "(j) [Deleted by 2023 amendment.]"); all sample ballots below match
  exactly. Former mirror-sourcing caveat CLOSED. Supporting: T.C.A. § 2-3-202 (August
  offices) + § 2-3-203 (NOVEMBER offices — the positive basis: "(1)
  Representative in the general assembly; (2) Representative in the United
  States congress; (3) Senator in the general assembly; (4) Senator in the
  United States senate; (5) Governor; and (6) Electors for president and
  vice president"),
  https://codes.findlaw.com/tn/title-2-elections/tn-code-sect-2-3-202/;
  T.C.A. § 17-4-105 (retention at the regular August election),
  https://codes.findlaw.com/tn/title-17-judges-and-chancellors/tn-code-sect-17-4-105/;
  Tenn. Const. art. XI, § 3, official SOS-published constitution (PRIMARY,
  https://publications.tnsosfiles.com/pub/2023%20TN%20Constitution.pdf).
- Office order: § 2-5-208(c)(1) — "The order of the titles of the offices to
  be filled ... shall be substantially as follows": (A) Presidential electors
  → (B) GOVERNOR → (C) US Senate → (D) US House → (E) TN Senate → (F) TN
  House → (G) Supreme Court judge → (H) Court of Appeals → (I) Court of
  Criminal Appeals → (J) Circuit court → (K) Chancellor → (L) Criminal court
  → (M) District attorney general → (N) Public defender → (O) County mayors
  → (P) County legislative → (Q) Assessor → (R) Trustee → (S) General
  sessions judge → (T) Juvenile court judge → (U) Sheriff → (V) Clerks of
  courts → (W) County clerk → (X) Register → (Y) elective county department
  offices (incl. SCHOOL BOARDS) → (Z) Municipal executive → (AA) Municipal
  legislative → (BB) Municipal judicial → (CC) unclassified. Governor sits at
  slot 2, ahead of the ENTIRE federal delegation — and Governor is TN's only
  statewide-elected executive (no elected SOS/AG/Treasurer). Ties within a
  class: § 2-5-208(c)(2) "arranged in alphabetical order".
- Judicial: split into TWO EARLY blocks, not one late block. Appellate +
  major trial courts at (G)-(L), immediately after the state house and
  BEFORE county; general sessions (S) and juvenile (T) judges sit inside the
  county block; municipal judicial dead last at (BB). Retention questions,
  when present, go to the END of the ballot per (c)(3) — but § 17-4-105
  holds retention at the regular AUGUST election, and § 2-3-202 sends
  "judges of all courts" + DA + most county offices to August, so November
  generals carry effectively NO judicial contests (Davidson 2022 + 2024
  November ballots: zero).
- Measures: TWO rules. State constitutional amendments print "directly after
  the list of candidates for governor" (§ 2-5-208(f)(1)) — slot 2.5, NOT
  last; amendments only appear in gubernatorial Novembers (art. XI § 3: "at
  the next general election in which a Governor is to be chosen"). ALL other
  questions (local referenda/charter amendments) go "at the end of the
  ballot"; if a retention question is present, other questions print after
  it.
- County discretion: none as to the DEFAULT order, with ONE narrow statutory
  fit exception (CodeRabbit catch, verified on the official portal
  2026-08-17): § 2-5-208(a) "The requirements of this section apply to all
  ballots" sets the default for everything, but § 2-5-206(b)(3) provides
  "If the arrangement as set out in subdivisions (b)(1) and (2) will not fit
  on the voting machine ballot, the county election commission may arrange
  the ballot so that the voting machine will accommodate the entire ballot
  including, without limitation, the arrangement of material in vertical
  columns with the office appearing first ..." — (b)(1)-(2) are § 2-5-206's
  machine-GEOMETRY rules (titles vertical, party columns), so the exception
  is aimed at layout geometry, but its "without limitation" wording is broad
  enough that fit-driven deviation from the printed sequence cannot be
  categorically ruled out; a related § 2-5-206 clause ("in any county where
  a voting machine will not accommodate the entire ballot, the coordinator
  of elections may, with the approval of the county election commission,
  permit the placement ...") is the same fit trigger. Montgomery County's
  official "Ballot Layout Requirements" summary
  (https://mcgtn.org/storage/departments/election/Ballot%20Layout%20Requirements.pdf)
  restates the exception. NO exercised rearrangement observed on any ballot
  read (all three match § 2-5-208 exactly). GRADE A accordingly covers the
  STATUTORY DEFAULT order; a fit-driven rearrangement under § 2-5-206(b)(3),
  if one ever surfaces, is outside it.
- School/special: school boards are NOT a separate tier — inside county
  class (Y) ("school boards" named in the class text), after Register,
  BEFORE municipal. Usually August but NOT statutorily bound to it —
  default school-board general dates are August AND November of even years
  (Knox Aug-2026 ballot confirms bottom-of-county-block placement). No
  special-district class → (CC) last.
- Corroboration: Davidson County Nov 2022 general,
  https://www.nashville.gov/sites/default/files/2022-09/Sample_Ballot_November_8_2022_State_Federal_Municipal_Elections.pdf
  — Governor → Amendments #1-#4 → US House → TN Senate → TN House →
  municipal (proves Governor-first inversion AND amendments-after-Governor).
  Davidson Nov 2024,
  https://www.nashville.gov/sites/default/files/2024-09/Sample_Ballot_November_5_2024_Elections.pdf
  — President → US Senate → US House → TN Senate → TN House → municipal →
  transit referendum LAST. Knox County Aug 2026 county general,
  https://www.knoxcounty.org/election/pdfs/General%20Sample%20Ballot_08.06.26.pdf
  — county half in exact statutory sequence. No conflicts.
- Baseline delta: SUBSTANTIAL, four departures. (1) Governor moves to slot
  2, before US Senate/House. (2) Judicial early (after state house, before
  county) and split — general sessions/juvenile mid-county, municipal
  judicial last; internal supreme → appeals → trial sequence preserved.
  (3) School inside county block → county → school → municipal, inverting
  baseline's municipal-before-school. (4) State constitutional amendments
  print second (after Governor), NOT last — only local questions trail. Plus
  DA/public defender occupy a tier between judicial and county that the
  baseline lacks.
- Notes: AUGUST/NOVEMBER SPLIT IS THE WHOLE STORY for November. Precision
  on the split: § 2-3-202's August list is exactly NINE items (assessor,
  constable, county clerk + court clerks, trustee, DA, judges of all
  courts, county legislative body, register, sheriff) — county MAYOR's
  August date comes from § 5-6-102(2), and SCHOOL BOARDS have NO August
  statute (TN default school-board general dates are August AND November
  of even years), so class (Y) is NOT reliably empty in November; § 2-3-203
  fixes what IS in November (see Authority). Effective November ballot:
  President → Governor → [amendments] → US Senate → US House → TN Senate →
  TN House → [occasional county-tail e.g. school board] → municipal →
  local questions. Governor IMMEDIATELY before US Senate IS
  ballot-confirmed — Nov-2018 carried both, and four county ballots print
  GOVERNOR → UNITED STATES SENATE → US HOUSE → TN Senate → TN House:
  Wayne https://tnsos.org/elections/ballots/418.pdf, Unicoi
  https://tnsos.org/elections/ballots/390.pdf, Jackson
  https://tnsos.org/elections/ballots/405.pdf (all three on the SOS's OWN
  ballot repository tnsos.org, found by verification), Hamblen
  https://www.hamblencountytn.gov/wp-content/uploads/delightful-downloads/2018/10/HamblenTN-G18-Infinity999.pdf;
  Wayne 2018 also ends "CITY OF CLIFTON / Retail Package Store Referendum"
  (local questions last). Davidson-2022 nuance: Governor printed slot 1
  (no US Senate race that year) — statutory (B)=slot-2 unaffected;
  verification confirmed amendments-after-Governor is genuinely VISUAL
  (same column, 23pt below Governor's write-in line), not a
  content-stream artifact. Knox Aug-2026 file is stamped "Preview Ballot
  06/15/2026". Candidate order within contest (informational): party
  columns majority → minority → minor (§ 2-5-208(d)(1)), alphabetical
  within; never implemented.

### MA — Massachusetts (FIPS 25) — GRADE A
- Authority: M.G.L. c.54 § 43A ("manner and order of appearance on
  ballots"),
  https://malegislature.gov/Laws/GeneralLaws/PartI/TitleVIII/Chapter54/Section43A
  (accessed 2026-08-16). Supporting: c.54 § 40 (state secretary prepares
  ALL state ballots), c.54 § 42 (candidate order within contest; questions
  after candidates; regional school committee paragraph), c.54 § 41A
  (Gov/LtGov grouped ticket), c.53 § 19 (district public-policy questions);
  Mass. Const. Pt. 2, c. II § I art. IX + Pt. 2, c. III art. I (judges
  appointed, good-behavior tenure), https://malegislature.gov/Laws/Constitution.
- Office order: statutory, fixed, statewide: Presidential elector → Senator
  in Congress → GOVERNOR AND LT GOVERNOR (one grouped ticket) → Attorney
  General → Secretary of State → Treasurer and Receiver General → Auditor →
  Congressman (US House) → COUNCILLOR (Governor's Council) → Senator in
  General Court → Representative in General Court → "all other offices ...
  in such order as the secretary of state may determine" (practice: county
  block — DA, Sheriff, Clerk of Courts, Register of Deeds, Register of
  Probate, County Commissioner, + regional district school committee) →
  questions last. Statewide executives BEFORE US House; Councillor tier
  between US House and state senate.
- Judicial: NONE — all judges appointed by the Governor w/ Governor's
  Council consent, good-behavior tenure (Const. cites above). Mandatory
  age-70 retirement = Amendment Art. XCVIII ("upon attaining seventy years
  of age said judges shall be retired" — annulled and replaced Ch. III
  art. I; on the same malegislature.gov Constitution page; Art. LVIII is
  only DISCRETIONARY retirement, no age). Nov-2024 specimen: zero judicial
  contests. Clerk of Courts / Register of Probate = elected court
  ADMINISTRATIVE offices → county block, never a judicial block.
- Measures: LAST — load-bearing cite is c.54 § 42 (unconditional): question
  "shall be printed on the ballot after the names of the candidates";
  § 43A's questions clause ("follow all of said offices, in such order as
  the secretary of state may determine") is textually CONDITIONED on
  vertical-row party arrangement, so cite it second. Statewide questions
  numbered 1..n; district public-policy questions (c.53 § 19) placed by the
  state secretary, no statutory sub-placement.
- County discretion: NONE over state-ballot order — c.54 § 40 "All ballots
  for use in elections of state officers shall be prepared and furnished
  by the state secretary". Counties play no role in the cited statutes;
  elections are administered by city/town clerks, whose ballot authority
  covers only their own MUNICIPAL elections (outside this entry's scope).
  Only order discretion on the state ballot = the STATE secretary's, over
  the trailing block + question order. County govts
  abolished in Middlesex/Franklin/Hampden/Worcester/Hampshire/Essex/Suffolk
  (1997-2000) but every county still elects Register of Deeds, Register of
  Probate, Sheriff, DA (SOC: "All counties, even those with abolished
  governments, elect their own registers of deeds, registers of probate,
  sheriffs, and district attorneys."); intact-government counties add
  Commissioners + Treasurer.
- School/special: regional district school committees elected district-wide
  DO print on the state general ballot — c.54 § 42 dedicated paragraph
  (separate paper ballot allowed if they don't fit). Their PLACEMENT
  within the trailing block is AUTHORITY-ONLY (no verified ballot carries
  one; a Stoughton-2018 observation was retracted as fabricated).
  Ordinary municipal school committees = separate city/town elections,
  never on the state ballot.
- Corroboration: Watertown (Middlesex Co.) SOC-issued "STATE ELECTION
  OFFICIAL SPECIMEN BALLOT" Nov-5-2024, Pcts. 1-8,
  https://content.civicplus.com/api/assets/ma-watertown/b1d6201b-6e9f-41e3-90b2-8176ed227b38?cache=1800
  (index https://www.watertown-ma.gov/specimen-ballots) — ELECTORS OF
  PRESIDENT AND VICE PRESIDENT → SENATOR IN CONGRESS → REPRESENTATIVE IN
  CONGRESS → COUNCILLOR → SENATOR IN GENERAL COURT → REPRESENTATIVE IN
  GENERAL COURT → CLERK OF COURTS → REGISTER OF DEEDS → QUESTIONS 1-5
  (non-gubernatorial year — executives absent; verification keyword sweep:
  JUDGE 0, SHERIFF 0, DA 0). The EXECUTIVE BLOCK is ballot-observed via
  TWO SOC-issued Nov-2022 specimens, coordinate-extracted in the main
  review session: Danvers (Essex Co.),
  https://www.danversma.gov/DocumentCenter/View/1132/State-Election---November-8-2022---Sample-Ballot
  — col 1: GOVERNOR and LIEUTENANT GOVERNOR (y272) → ATTORNEY GENERAL →
  SECRETARY OF STATE → TREASURER → AUDITOR → REPRESENTATIVE IN CONGRESS
  (y992); col 2: COUNCILLOR → SENATOR IN GENERAL COURT → REPRESENTATIVE IN
  GENERAL COURT → DISTRICT ATTORNEY → SHERIFF; QUESTIONS 1-4 on the back —
  § 43A's executive run end to end (no US Senate race existed in 2022);
  Reading (Middlesex Co.),
  https://www.readingma.gov/DocumentCenter/View/7180/2022-11-08-State-Election-Sample-Ballots
  — identical sequence, both precinct sheets. US-Senate-versus-Governor
  relative order remains statute-only (never co-observed: 2022 had no
  Senate race, 2024 no executives — same shape as TN pre-2018).
  RETRACTED BY VERIFIER (recorded): a verification report initially also
  cited Gloucester 2018/2022 and Stoughton 2018 specimens plus a
  dark-pixel test — on interrogation the verifier admitted it never
  fetched those documents (it wrote them up before its own subagent
  reported; the subagent never returned). All three ballots and the pixel
  test are STRUCK; nothing above rests on them. DISCARDED corroborator:
  a Sudbury-hosted Nov-2022 specimen PDF — the verifier's OWN decode
  (which stands) shows a real Sudbury/Middlesex 2022 print layer
  (Healey/Driscoll, Campbell, Galvin, Goldberg, DiZoglio, Middlesex
  Sheriff) with Nov-2018 residue in the raw text stream (Warren/Diehl
  Senate race, Baker/Polito) — contaminated file, nothing rests on it,
  and the county sub-order "conflict" once built on it stays deleted.
- Baseline delta: SIGNIFICANT. (1) Statewide executives BEFORE US House
  (US Sen → Gov/LtGov → AG → SOS → Treasurer → Auditor → US House).
  (2) Gov+LtGov one grouped contest. (3) Councillor tier between US House
  and state senate — baseline has no slot. (4) NO judicial block (judges
  appointed) — leave empty; don't map Clerk of Courts/Register of Probate
  into it. (5) NO municipal offices on state ballots. (6) School not a late
  tier — regional school committee inside the trailing SOC-ordered block.
  Matching: President first, US Senate second, senate-before-house, county
  after legislature, measures last.
- Notes: only the HEAD of the order is statutory — the county/
  regional-school tail is SOC discretion (§ 43A "in such order as the
  secretary of state may determine"), and observed practice varies by what
  is up: do NOT hard-code the county sub-order (the earlier "two ballots
  disagree" conflict was a PHANTOM built on the contaminated Sudbury file
  — deleted; the caution stands on the statute alone). Observed tail
  orders (verified ballots only): Watertown 2024 Clerk of Courts →
  Register of Deeds; Danvers + Reading 2022 DA → Sheriff. § 43A also
  governs state PRIMARIES with the same sequence
  (Gov/LtGov separate there — "as a group at a state election" limits
  grouping to the general). Candidate order within contest
  (informational): elected incumbents first alphabetically, then party
  candidates alphabetically, then others (c.54 § 42, § 41A same rule for
  Gov/LtGov groups); never implemented. Researcher discarded an unreliable
  WebFetch PDF summary (phantom Sheriff/DA contests) after local
  extraction contradicted it — all ballot claims come from local text
  extraction. Unverified search-artifact claim of a 2026 amendment to § 42
  (St. 2026, c.137) — not shown on malegislature.gov; recheck before the
  2027 cycle. SOC county-officers page URL has gone stale (now a generic
  Government overview) — quote real but re-point to the sibling
  gov-county.htm if cited again.

### IN — Indiana (FIPS 18) — GRADE A (scoped — see Notes)
- Grade scope: A covers the section structure (measures → straight party →
  partisan sequence → nonpartisan school → retention last) and the
  inter-tier office order. It EXCLUDES the county block's INTERNAL order,
  where the only sampled county violates the statute (Coroner before
  Recorder, unresolved). Immaterial to overrides anyway: our ranker holds
  all county offices at one tier, so within-county order is below its
  granularity and no override would encode it.
- Authority: Indiana Election Administrator's Manual (2026 ed., rev. Apr
  2026), Indiana SOS / Election Division, "Public Questions & Straight Party
  Devices" + "General Election Ballot Office Order" (pp. 133-138) —
  reproduces and cites IC 3-11-2-12, IC 3-11-2-12.4(c), IC 3-11-2-12.5,
  IC 3-11-2-14, IC 3-11-2-15, IC 3-11-13-11(e)-(l), IC 3-11-14-3.5(e)-(m),
  IC 3-10-1-19.
  https://www.in.gov/sos/elections/files/2026-Election-Administrators-Manual-Revised-Apr-2026.pdf
  (accessed 2026-08-16). The literal statutes were subsequently read in
  full by the verification pass on TWO independent mirrors agreeing
  verbatim (law.justia.com "IN Code § 3-11-2-12 (2025)" + FindLaw "Current
  as of January 01, 2026", both via the r.jina.ai fetch proxy — iga.in.gov
  itself is a JS-gated SPA w/ key-gated API): IC 3-11-2-12(a) "The
  following offices shall be placed on the general election ballot in the
  following order after the public questions described in section 10(a)":
  (1) federal/state — President/VP → US Senator → "Governor and lieutenant
  governor" → SOS → "State comptroller (auditor of state)" (renamed
  P.L.227-2023; manual still says Auditor) → Treasurer → AG → US
  Representative; then (2) legislative, (3) circuit + county judicial,
  (4) county, (5) township, (6) city, (7) town — identical to the manual.
  Plus IC 3-11-2-10(a) (public questions first: "(1) Ratification of a
  state constitutional amendment. (2) Local public questions."; (b)
  straight party after them), IC 3-11-2-12.4(b) (at-large block "after the
  offices described in section 12 ... and before the offices described in
  section 12.9"), IC 3-11-2-12.5 (county-board discretion), IC
  3-11-2-12.9(a) (school board "after the offices described in section
  12.4").
- Office order: cautionary statement + instructions → PUBLIC QUESTIONS
  (statewide first, then local) → STRAIGHT PARTY section → President/VP →
  US Senator → GOVERNOR & LT GOVERNOR (single ticket) → SOS → Auditor →
  Treasurer → AG → US REPRESENTATIVE → State Senator → State Rep → circuit &
  county JUDICIAL block (Circuit Court judge → Superior Court judge →
  Probate judge (St. Joseph Co. only) → Prosecuting Attorney → Circuit Court
  Clerk) → county offices (Auditor → Recorder → Treasurer → Sheriff →
  Coroner → Surveyor → Assessor → Commissioner → Council) → township
  (Assessor → Trustee → Board → Marion small-claims judge/constable) → city
  (Mayor → Clerk → City Court judge → Council) → town → at-large partisan
  offices, hoisted here CONDITIONALLY (IC 3-11-2-12.4; where a body has
  both at-large and district seats on one ballot, the manual returns them
  to normal § 12 position, at-large first — see Notes caveat) → School
  Board (at-large then district) → JUDICIAL RETENTION QUESTIONS dead
  last. Statewide executives
  ALL precede US House. Presidential years carry only Gov+Lt Gov and AG
  (SOS/Auditor/Treasurer are midterm-cycle).
- Judicial: SPLIT. Elected trial courts (circuit/superior/St. Joseph
  probate) print EARLY — own block right after State Rep, before county.
  Supreme Court + Court of Appeals are RETENTION questions printing DEAD
  LAST after school board: Supreme Court justices → Court of Appeals → Tax
  Court → authorized local retentions (Lake/St. Joseph/Marion superior) →
  Allen/Vanderburgh nonpartisan judicial. Retention questions are expressly
  NOT public questions — never ride the measures block ("A state or local
  level judicial retention question is not a public question and appears
  later on the ballot", p.133).
- Measures: FIRST, not last — public questions print below the voter
  instructions at the top, statewide (constitutional amendments) before
  local. Order among multiple local questions undirected by statute (manual:
  order certified to the county election board). School referenda
  (IC 20-46-1/20-46-9, IC 6-1.1-20) are local public questions, even-year
  generals only.
- County discretion: narrow and enumerated — IC 3-11-2-12.5 lets the county
  election board move Prosecuting Attorney, Circuit Court Clerk, and County
  Offices ahead of the county judicial offices; local-question order
  undirected; multi-district offices alphabetical/numerical. No general
  delegation.
- School/special: school board nonpartisan, even-year November, after ALL
  partisan offices (incl. the hoisted at-large block), immediately BEFORE
  the retention block. At-large seats before district seats. Straight-party
  marks never reach school board.
- Corroboration: Lake County Nov-2024 general, Precinct 164-H3 16,
  https://www.lakecountyin.org/departments/voters/2024-GENERAL-ELECTION-BALLOT-SAMPLES/Pct%20164-H3%2016%20Act%2001-GENERAL.pdf
  (7pp): public question (constitutional amendment) p1 → straight party +
  President p2 → US Senator → Gov&LtGov → AG → US Rep D1 → State Senator p3
  → State Rep → county p4 → "NON-PARTISAN OFFICES" School City of Hammond
  at-large p5 → "JUDICIAL RETENTION QUESTIONS" Supreme → Appeals → Lake
  Superior local retentions pp6-7. Three further precincts (341-WT 01,
  008-CCT 04, 269-MER 10) identical.
- Baseline delta: SUBSTANTIAL, three structural. (a) Measures FIRST
  (statewide then local), not last. (b) Statewide executives precede US
  House (Senate → Gov/LtGov → SOS → Auditor → Treasurer → AG → US House).
  (c) Judicial SPLIT — elected trial courts + prosecutor + clerk EARLY
  (after state house, before county); only the retention block is late, and
  it is the very LAST thing, after school. Plus: straight-party section
  between measures and first contest; hoisted at-large block; township tier
  between county and city. Matching baseline: senate-before-house, county →
  municipal, school after local partisan offices, supreme → appeals within
  retention block.
- Notes: STRAIGHT PARTY leads the office portion — not a contest, but a
  contest-order model needs a slot for it; since 2016, a straight-party mark
  does NOT cast at-large votes (why IC 3-11-2-12.4 hoists those offices).
  AT-LARGE HOIST CAVEAT: the manual's Exception returns a
  mixed-at-large/district body to the normal IC 3-11-2-12 position
  (at-large listed first, then district); the STATUTE (12.4(c)) only says
  at-large before district and never itself returns the block — manual
  gloss and statute pull apart, so do NOT encode an unconditional hoist.
  IC 3-11-2-14 alphabetical ordering applies ONLY to the Allen/Vanderburgh
  local nonpartisan judicial offices dead last in the retention block, not
  statewide. CONFLICT RECORDED, NOT RESOLVED: all four Lake 2024 precincts
  print County CORONER BEFORE RECORDER — a STATUTORY violation
  (IC 3-11-2-12(a)(4) fixes Recorder (B) ahead of Coroner (E); 12.5
  authorizes moving the county block, never reordering WITHIN it);
  verification proved it visual (same column, Coroner 188pt above
  Recorder), systematic across precincts; a benign alphabetical county
  sort is not excluded by one county — needs a second county (Hamilton's
  2024 PDFs 404'd, Marion = address-lookup only).
  Primary difference (one line): IC 3-10-1-19 May primary drops straight
  party, puts Governor immediately after US Senator (BEFORE US Rep), omits
  convention-nominated executives, appends Political Party Offices last.
  Candidate order within contest (informational): party order by last SOS
  election finish in the county; nonpartisan judicial alphabetical
  (IC 3-11-2-14); never implemented.

### MO — Missouri (FIPS 29) — GRADE C
- Authority: NO statewide authority prescribes the order of OFFICES /
  candidate contests — verification swept ALL 365 sections of RSMo ch. 115,
  all of ch. 116, and every 15 CSR Division 30 chapter: zero office-order
  language (the only regulatory mention is the 15 CSR 30-10.010(12)
  DEFINITION of "ballot style", which acknowledges order exists without
  prescribing one). §115.237 governs ballot CONTENTS + candidate order
  only, https://revisor.mo.gov/main/OneSection.aspx?section=115.237
  (accessed 2026-08-16); §115.237.6 ORDERS the SOS to promulgate uniform
  ballot-layout rules — a duty NEVER DISCHARGED (zero occurrences of
  "115.237"/"layout" in the SOS's own complete rule inventory,
  https://www.sos.mo.gov/CMSImages/SOSMain/SOSRuleReview.pdf) — and yields
  to the vendor system; §115.247 vests ballot production in each election
  authority. TWO narrow statewide placement rules DO exist: (a) statewide
  MEASURES have a prescribed heading sequence — §116.230 sample-ballot
  form ("CONSTITUTIONAL AMENDMENTS" heading first, then "STATUTORY
  MEASURES"; §116.210 numbers amendments in passage order, §116.220
  letters propositions), binding on election authorities via §116.240
  (SOS sends the sample ballot) + §115.127.3 ("The election authority
  shall print the official ballot as the same appears on the sample
  ballot"); (b) retention judges go on a SEPARATE ballot: Mo. Const. art.
  V, §25(c)(1) "on a separate judicial ballot, without party designation",
  https://revisor.mo.gov/main/OneSection.aspx?constit=y&section=V++25(c)(1).
- Office order (OBSERVED, identical in all NINE jurisdictions read —
  customary, not statutory): President/VP → US Senator → GOVERNOR → Lt Gov → SOS →
  Treasurer → AG → US Representative → State Senator → State Rep →
  county/city offices → [judicial block] → state measures → local measures.
  All statewide executives ABOVE US House, immediately below US Senate;
  internal order = Mo. Const. art. IV §17 list order (Gov, LtGov, SOS,
  Treasurer, AG). The SOS certification booklet (§115.401,
  https://www.sos.mo.gov/CMSImages/Elections/CertificationOfCandidatesNovember2024.pdf)
  lists offices in this same sequence — but §115.401 imposes no sequence,
  so that is the SOS's drafting convention, the likely SOURCE of the 4/4
  uniformity, not a directive. State Auditor = midterm cycle
  (2018/2022/2026), absent from all four Nov-2024 ballots.
- Judicial: TWO different things. (a) PARTISAN circuit/associate-circuit
  contests (non-Plan circuits) print INSIDE the partisan sequence, after
  state legislative and BEFORE county offices — ballot-confirmed by
  verification on Callaway (13th Circuit: "FOR CIRCUIT JUDGE CIRCUIT 13
  DIVISION 3", the one contested 2024 race, Osete-R vs Morrell-D, between
  State Rep 43 and Eastern District Commissioner) + single-name FOR CIRCUIT
  JUDGE listings in the same slot on Cass/StCharles/Cole/Ralls/Vernon;
  internal order circuit then associate circuit, ascending division.
  (b) Nonpartisan Court Plan RETENTIONS = party-free block, internally
  Supreme → Appeals (voter's district; no circuit-level retention appeared
  on ANY 2024 ballot read — Plan trial retentions exist but none were up
  outside the cities). Banner "OFFICIAL JUDICIAL BALLOT" + "VOTE ON EACH
  JUDGE" in most counties (constitutional basis art. V §25(c)(1) "separate
  judicial ballot"); St. Louis City prints retention items as ORDINARY
  contests with no banner, Vernon repeats per-office headings instead —
  the "separate ballot" is honored as a labeled section at best, sometimes
  not at all. Retention BLOCK placement: after county offices, BEFORE
  state measures in 7 of 9 jurisdictions read (StL City, KC, Jackson,
  Cass, StCharles, Cole, Ralls); dead LAST after Proposition A in Greene +
  Vernon — and the split tracks the ballot-PRINT FORMAT (the two dead-last
  counties share the JUDGE'S-INITIALS/END-OF-BALLOT vendor layout), not a
  county rule.
- Measures: after all offices (observed 4/4; position not statutory) —
  WITHIN the statewide block the order IS statutory: constitutional
  amendments (numbered in passage/submission order, §116.210) before
  statutory measures (lettered Proposition A..., §116.220), per the
  §116.230 sample-ballot form the election authority must reproduce
  (§115.127.3). Then county question → city/charter props last (observed).
  §115.245 fixes wording ("no other wording shall be used"), not order.
- County discretion: HIGH and dispositive — §115.247 "Each election
  authority shall provide all ballots for every election within its
  jurisdiction"; §115.237.6 vendor-system yield above. This is the C.
- School/special: ABSENT from November — §115.121.3 puts political
  subdivision + special-district officers on the APRIL general municipal
  election day; §162.291 elects school directors "at municipal elections".
  Greene Nov-2024: zero school/special OFFICE items across all 30 styles
  (12 Springfield styles do carry City of Springfield Question 1). Local
  QUESTIONS do appear in November.
- Corroboration: NINE jurisdictions read across research + verification,
  every one agreeing on the partisan spine Pres → US Sen → Gov → LtGov →
  SOS → TREASURER → AG (Treasurer before AG universal) → US House → State
  Sen → State House → [partisan circuit judges] → county; amendments 2,3,
  5,6,7 → Proposition A; local questions last. Research set: St. Louis
  City BEC
  https://www.stlouis-mo.gov/government/departments/board-election-commissioners/documents/upload/Nov24-All-Races-Sample-Ballot.pdf;
  Kansas City EB https://www.kceb.org/useruploads/Sample_Ballot-FINAL_11-24.pdf;
  Jackson County EB https://jcebmo.org/wp-content/uploads/Notice-Of-General-Election.pdf
  (NOTE: a §115.127 NOTICE OF GENERAL ELECTION, jurisdiction-grouped
  newspaper layout, not a ballot card — and KC EB + Jackson EB are two
  boards covering ONE county, so the research set = three jurisdictions,
  not four); Greene County
  https://vote.greenecountymo.gov/wp-content/uploads/2024/09/24GMOGRE_6-Samples-for-Website.pdf
  (60pp = 30 two-sided styles — 21 precinct, 8 federal-only, 1 interstate
  former-resident; "12" is just the Springfield styles). Verification
  added: Cass
  https://www.casscounty.com/DocumentCenter/View/4039/November-2024-Sample-Ballotpdf;
  St. Charles https://www.sccmo.org/DocumentCenter/View/25411/2024-11-05_Sample-Ballot;
  Cole (Wayback,
  https://web.archive.org/web/2024id_/https://colecounty.org/DocumentCenter/View/9690/November-5-2024-Combined-Sample-Ballot);
  Ralls https://rallscountymo.gov/wp-content/uploads/2024/09/sampleballots110524.pdf;
  Vernon https://vernoncountymo.org/wp-content/uploads/SAMPLE-BALLOTS-FINAL.pdf;
  Callaway (13th Circuit contested judge)
  https://callawaycountyclerk.com/wp-content/uploads/2024/09/November-5-Sample-Ballot.pdf
  (scanned/rotated — OCR'd). Boone publishes NO sample PDFs (per-voter
  lookup only); its Electionware results reports are election-definition
  order, not proven print order (2020+2022 match the 7-county majority;
  2024 report interleaves retention after circuit races — treated as a
  definition quirk, not evidence).
- Baseline delta: (1) statewide executives above US House (9/9 observed;
  Treasurer before AG); (2) partisan circuit judges between state house
  and county — baseline has no such slot; (3) municipal + school slots
  EMPTY in November (April cycle; "county before municipal" therefore
  unobserved); (4) Auditor never in presidential years (Boone 2022 report
  shows it in the executive run at midterms); (5) retention placement:
  majority = after county, before state measures (Greene/Vernon vendor
  layout puts it dead last). Matches baseline: retention internal order
  (Supreme → Appeals), state measures after offices, local questions last.
  NO override possible — office order is election-authority custom, not
  law (grade C); if a customary default is ever wanted anyway, the safe
  one is judicial-after-county-before-measures (7 of 9).
- Notes: (a) Retention-placement conflict RESOLVED as vendor-format split,
  not county policy: 7 of 9 (StL City, KC, Jackson, Cass, StCharles,
  Cole, Ralls) print retention after county before state measures; Greene
  + Vernon (the two sharing the JUDGE'S-INITIALS/END-OF-BALLOT layout)
  print it dead last. Still not statewide LAW — stays C. (b) Retention
  statewide at Supreme/Appeals; trial-level only in Plan counties (22nd
  StL City, 21st StL Cty, 16th Jackson, 7th Clay, 6th Platte, 31st
  Greene); other circuits elect partisan — now ballot-confirmed
  (Callaway). (c) April municipal day (§115.121.3, paired w/ §162.291
  "at municipal elections") explains the empty November municipal/school
  slots. (d) Primaries: §115.395 one ballot per party, filing order w/
  first-day random draw; §115.237.5 bans straight-ticket. (e) Candidate
  order (informational): party columns by prior gubernatorial vote
  (§115.239) → REP → DEM → LIB → BTR → GRN on all 2024 ballots; never
  implemented. (f) Extraction caveats: research-set sequences were
  content-stream order; verification re-derived Cass/StCharles/Cole/
  Ralls/Vernon from column-major coordinates and OCR'd Callaway — the
  spine held everywhere. Greene carried no State Senator contest in 2024
  (that link of the chain unobserved there). (g) Re-checked 2026-08-16
  (C stands): revisor.mo.gov shows § 115.237 unamended (effective
  28 Aug 2022, 5 histories); the current 15 CSR Title 15 chapter index
  (read directly at sos.mo.gov/adrules/csr/current/15csr/15csr) still lists
  NO Division 30 chapter on ballot layout or contest order (chapters cover
  voter ID, mail ballots, provisional voting, counting standards, voting
  machines, petitions, etc.) — the § 115.237.6 rulemaking duty remains
  undischarged. A Codex-assisted sweep of 2025-2026 legislation likewise
  found no amendment (its senate cross-reference page timed out — logged
  as a gap, not a negative).

### MD — Maryland (FIPS 24) — GRADE A
- Authority: Md. Code, Election Law § 9-210 "Arrangement of ballots —
  Candidates and offices" + § 9-211 (questions) + § 7-103 (question
  identifiers) + § 9-207 (State Board certifies "the content and
  arrangement of each ballot"),
  https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gel&section=9-210&enactments=false
  (and sibling section URLs); COMAR 33.10.01.17A ("The content and
  arrangement of all ballots shall comply with Election Law Article, Title
  9, Subtitle 2"), https://regs.maryland.gov/us/md/exec/comar/33.10.01.17.
  (all accessed 2026-08-16)
- Office order: § 9-210(a) verbatim sequence — (1) statewide: President/VP
  → GOVERNOR + LT GOV → Comptroller → Attorney General → US SENATOR (fifth!)
  → (2) Representative in Congress → (3) State Senate → House of Delegates
  → (4) county executive → county council/commissioner → (5) Baltimore
  City: Mayor → Council President → Comptroller → Council → (6) JUDICIAL →
  (7) county row offices: treasurer → State's Attorney → clerk of circuit
  court → register of wills → judge of orphans' court → sheriff → other
  partisan → (8) party offices → (9) nonpartisan offices. § 9-210(b)
  unlisted offices follow; § 9-210(c) at-large before district within any
  category.
- Judicial: MID-ballot block at (6) — after the county governing body,
  BEFORE county row offices/school/measures. Internal order INVERTED vs
  baseline: circuit court FIRST (contested, no party label per § 9-210(g)),
  then appellate "continuance in office" retention: Supreme Court of
  Maryland → Appellate Court of Maryland. Orphans' Court judges NOT here —
  county partisan block (7)(v), between register of wills and sheriff.
- Measures: all questions last, after every contest (ballot-confirmed;
  NOTE: no express statute says questions follow offices — § 9-211 only
  orders questions among THEMSELVES: new State Constitution → MD
  constitutional amendments → other General Assembly enactments → county
  charter → other county enactments → other). § 7-103: statewide/referendum
  = numeric ("Question 1"); county/municipal = alphabetic ("Question A"),
  letter series continuous across local types.
- County discretion: effectively none on order — statute fixes sequence;
  § 9-202(b) is the on-point cite: "Each local board shall place
  questions, names of candidates, and other material on the ballot in
  that county in accordance with the content and arrangement prescribed
  by the State Board"; § 9-207 (certification/display), § 9-204 "as
  uniform as possible", COMAR 33.10.01.17A. Local boards vary only
  content/pagination.
- School/special: Board of Education = nonpartisan → slot (9), LAST among
  offices, after judicial AND county row offices, immediately before
  questions. § 9-210(g) bars party labels; at-large BoE seat before
  district seats (§ 9-210(c)).
- Corroboration: four TEXT-LAYER official SBE ballots (archive path).
  Montgomery 2024,
  https://elections.maryland.gov/elections/archive/2024/general_ballots/Montgomery.pdf
  (514pp) — President → US Senator → US Rep D8 → Circuit Court Judge
  (Circuit 6) → Appellate Court At Large ×3 "For Continuance in Office" →
  BoE At Large → D2 → D4 → Question 1 (statewide) → Question A (county
  charter) → End of Ballot. Montgomery 2022 (gubernatorial leg),
  https://elections.maryland.gov/elections/archive/2022/general_ballots/Montgomery.pdf
  — Governor/LtGov → Comptroller → AG → US Senator → US Rep D8 → State
  Senator → House of Delegates → County Executive → Council At Large →
  Council D7 → Circuit Court Judge → Court of Appeals → Court of Special
  Appeals ×3 → State's Attorney → Clerk → Register of Wills → Sheriff →
  BoE. Baltimore City 2024 (same archive path) — Mayor → City Council
  President → Comptroller → Council D1 → Circuit Court C8 → "Justice,
  Supreme Court of Maryland" → Appellate ×4 (Supreme-before-Appellate
  confirmed). Baltimore County 2022 — State's Attorney → Clerk → Register
  of Wills → JUDGE OF THE ORPHANS' COURT → Sheriff → BoE (Orphans'-Court
  slot confirmed). The county-issued Montgomery 2024 voter-guide booklet
  (mcg.montgomerycountymd.gov CD-4 PDF) is RASTER (no text layer) — kept
  only as the researcher's original visual read; every claim above rests
  on the SBE text-layer ballots.
- Baseline delta: SUBSTANTIAL, five departures. (1) US Senate FIFTH —
  after Gov/LtGov, Comptroller, AG (statewide executives outrank the
  entire federal delegation below President). (2) US House after the whole
  statewide block. (3) Judicial MID-ballot — before county row offices,
  school, measures. (4) Judicial internal order INVERTED: trial (circuit)
  first, then Supreme, then Appellate. (5) School AFTER judicial (baseline
  inverts). Matches: senate-before-house, measures last.
- Notes: court renames 2022 (Court of Appeals → Supreme Court of Maryland;
  Court of Special Appeals → Appellate Court) — 2022 ballots old names,
  2024 new. Circuit judges: PARTISAN primaries (cross-filing allowed), no
  party label in the general (§ 9-210(g)) — longstanding, NOT a 2022
  change. Montgomery elects no Orphans' Court (circuit judges sit as it) +
  no county treasurer → those rows verified via Baltimore County/other
  counties or authority-only (treasurer = authority-only, no ballot
  exercised it). Party offices (8) = primary-only in practice, empty slot
  on generals, unconfirmed. Municipal outside Baltimore City = § 9-210(b)
  catch-all after nonpartisan, unconfirmed on a ballot. Prompt-premise
  fix: COMAR 33.06 is "Petitions", NOT ballots — ballots live at COMAR
  33.10.01.17. Wording variance recorded: statute/ballots "continuance in
  office" vs SBE candidacy page "retention in office" — cosmetic.
  Latent edge (§ 8-802(b)): the nonpartisan-BoE rule "does not apply ...
  if Title 3 of the Education Article requires a partisan election" — a
  partisan BoE would land in § 9-210(a)(7)(vii) with the county row
  offices, not last; no MD county currently does this. Candidate order
  within contest (informational): same-party candidates alphabetical by
  surname (§ 9-210(j)(3)); never implemented. Fetch gotcha: SBE live
  ballot paths soft-404 (HTTP 200 HTML error page) — the
  /elections/archive/<year>/general_ballots/<County>.pdf path serves the
  real PDFs.

### WI — Wisconsin (FIPS 55) — GRADE A
- Authority: Wis. Stat. § 5.64(1)(d) (general election ballots),
  https://docs.legis.wisconsin.gov/statutes/statutes/5/ii/64/1/d —
  incorporates the office list of § 5.62(3),
  https://docs.legis.wisconsin.gov/statutes/statutes/5/ii/62/3 (both
  accessed 2026-08-16). Supporting: § 5.02(5) (general-election scope),
  § 5.02(21) (spring election), § 5.64(2)(am)+(c) (referendum ballot),
  § 5.655 (consolidated ballot), § 7.08(1)(a) + § 7.10(1)(a) (WEC
  prescribes form, county clerk conforms "in substantially the same form").
- Office order: § 5.64(1)(d) hoists President/VP (presidential years) or
  the joint Governor/Lt Governor contest (gubernatorial years) to the top,
  "then the REMAINING offices in the order designated under s. 5.62(3)" —
  so the two effective sequences are: presidential years President/VP →
  [AG → SOS → Treasurer, if up] → US Senator → US Rep → State Senator →
  Assembly → DA → county; gubernatorial years Gov/LtGov (once — hoisted,
  not repeated from the list) → AG → SOS → Treasurer → US Senator → US Rep
  → State Senator → Assembly → DA → county. § 5.62(3) list verbatim:
  "governor, lieutenant governor, attorney general, secretary of state,
  state treasurer, U.S. senator, U.S. representative in congress, state
  senator, representative to the assembly, district attorney and the
  county offices". Statewide executives ABOVE US Senate + US House. Gov +
  LtGov = one joint contest at the general (§ 5.64(1)(f)). DA = own block
  between Assembly and county.
- Judicial: NONE in November — § 5.02(5) general election elects "state
  officers other than the state superintendent and judicial officers";
  § 5.02(21) puts judicial at the April spring election (§ 5.60 ballots).
  Zero Supreme/Appeals/Circuit contests across 302pp of Brown County
  Nov-2022 + Nov-2024 samples. Late judicial block = empty for WI.
- Measures: LAST, after every office. § 5.64(2)(am) nominally separate
  referendum ballot; § 5.655 consolidation = universal practice. Observed
  sub-order: State → County → School District. § 5.64(2)(c) separates
  state/county from municipal/special-district referenda, numbers state
  referenda chronologically. (Measures-last is observed practice on the
  consolidated ballot, not statutory position — statute only mandates the
  separate-ballot fiction.)
- County discretion: minimal on order — WEC prescribes forms (§ 7.08(1)(a)),
  clerks conform (§ 7.10(1)(a)). County-block internal order comes from the
  WEC template, not statute (§ 5.62(3) says only "and the county offices";
  EL-203ms prints Sheriff → Coroner → Clerk of Circuit Court for the
  gubernatorial cycle). TRAP: "Clerk of Circuit Court" is an ADMINISTRATIVE
  county office, not a judicial contest — naive "Circuit Court" keyword
  matching false-positives here.
- School/special: school board = April spring nonpartisan (§ 5.02(21)
  "educational officers"), effectively never in November — zero regular
  contests across every ballot read; EXCEPTION: SPECIAL school-board
  elections for unexpired terms can land on a November ballot (Milwaukee
  Public Schools Board District 4 special appeared in a subset of 2024
  Milwaukee city wards, per the county election notice — secondary-sourced,
  .gov hosts WAF-blocked). School-district REFERENDA do appear in November
  (§ 121.91(3) allows "partisan primary or general election"; Denmark
  School District 2-question referendum on the Nov-2022 ballot).
- Corroboration: Brown County (Green Bay) official samples + Milwaukee
  County (Whitefish Bay) samples + the WEC blank template itself. WEC
  EL-203ms general-election optical-scan template (Rev. 2022-07),
  https://elections.wi.gov/sites/default/files/documents/EL-203ms%20-%202022%20-%20Optical%20Scan%20-%20General%20Election%20-%20Oval.pdf
  — the template prints the order: Statewide (Gov/LtGov, AG, SOS,
  Treasurer) → Congressional (US Senator, US Rep) → Legislative (State
  Senator, Assembly) → County (Sheriff, Coroner, Clerk of Circuit Court) →
  Referendum (PDFs under /sites/default/files/ fetch fine; the HTML pages
  403). WEC Election Administration Manual (Aug 2024, p.41,
  https://elections.wi.gov/sites/default/files/documents/EA%20Manual-August%202024.pdf):
  "For optical scan or consolidated ballots: a. There must be a separate
  REFERENDUM section on the ballot. ... c. The title of the ballot must
  include the language 'and Referendum.'" (citing §§ 5.51(5), 5.60(7),
  5.64(2), 5.655) — referendum = bottom section of the SAME ballot, not a
  physically separate one. Whitefish Bay (Milwaukee Co.) Nov-2024,
  https://www.wfbvillage.gov/DocumentCenter/View/2201/November-5-2024-Sample-Ballot
  — Pres/VP → US Sen → US Rep D4 → State Sen D8 → Assembly D23 → DA →
  County Clerk → Treasurer → Register of Deeds → Referendum/State;
  Whitefish Bay Nov-2022,
  https://www.wfbvillage.gov/DocumentCenter/View/1684/Whitefish-Bay---Sample-November-8-2022
  — Gov/LtGov → AG → SOS → Treasurer → US Sen → US Rep D4 → Assembly D23 →
  Sheriff → Clerk of Circuit Court → Referendum/County. Portage County
  Nov-2024 (76pp) identical structure. Brown County Nov-2022 gubernatorial,
  https://www.browncountywi.gov/i/f/files/County-Clerk/Elections/Sample%20Ballots/2022/Nov/20221108%20Sample.pdf
  — headers Statewide (Gov/LtGov, AG, SOS, Treasurer) → Congressional →
  Legislative → County (Sheriff → Coroner → Clerk of Circuit Court,
  matching EL-203ms exactly) → Referendum (County → School District),
  identical across all wards (160pp). Nov-2024 presidential,
  https://www.browncountywi.gov/i/f/files/County-Clerk/Elections/Sample%20Ballots/2024/20241105%20Sample.pdf
  — President/VP → US Senator → US Rep → State Senator → Assembly → DA →
  County Clerk → Treasurer → Register of Deeds → Referendum (State)
  (142pp). Confirms executives-before-federal, DA slot, measures-last,
  zero judicial/school.
- Baseline delta: SUBSTANTIAL. (1) Statewide executives ABOVE US Senate +
  US House. (2) Gov/LtGov joint contest tops the midterm ballot. (3) DA
  block between state house and county — baseline has no DA slot. (4) No
  municipal block in November. (5) No school block in November. (6) Judicial
  block empty. (7) Measures last — matches.
- Notes: hard calendar split — November = partisan federal/state/DA/county;
  April spring = ALL judicial, state superintendent, school board,
  municipal, county supervisors + county executive. County block alternates
  by cycle (Sheriff/Coroner/Clerk of Circuit Court 2022 vs County Clerk/
  Treasurer/Register of Deeds 2024). § 5.62(3) is BY ITS OWN TERMS the
  partisan-PRIMARY list ("whenever these offices appear on the partisan
  primary ballot"); the general adopts it via § 5.64(1)(d)'s
  cross-reference (Gov and LtGov voted separately at the primary, jointly
  at the general). Brown Nov-2024 also shows a "Special Congressional
  Election" section printed ABOVE the regular Congressional section —
  special federal contests outrank their regular peers. Candidate order
  within contest (informational): WEC lot draw (§ 5.60(1)(b)); party
  columns left-to-right by last presidential/gubernatorial vote
  (§ 5.64(1)(b)); never implemented. Prompt-premise fix: § 5.58 = spring
  PRIMARY ballots, not partisan; partisan primary = § 5.62.

## Batch 3

### CO — Colorado (FIPS 08) — GRADE A (scoped — see Notes)
- Authority: C.R.S. § 1-5-403(5) (full office order + judicial-retention
  placement in one sentence-chain),
  https://content.leg.colorado.gov/sites/default/files/images/olls/crs2024-title-01.pdf
  (CRS 2024 Title 1; accessed 2026-08-16). Supplemented by § 1-5-407(5)(a)
  (measures after candidates + tier order), § 1-5-407(5.5) (separate-ballot
  option), § 1-5-203(1)(a)(I) (SOS certifies "the order of the ballot and the
  ballot content"), § 1-1-104(39)/(41)/(42) (school = odd-year Nov; RTD =
  concurrent with general; special district = May odd-year), § 32-9-119.3(2)
  (RTD sales-tax questions "immediately following any statewide amendments
  and propositions",
  https://content.leg.colorado.gov/sites/default/files/images/olls/crs2024-title-32.pdf),
  and 8 CCR 1505-1 Rule 4.5.2 (SOS Election Rules, Rule 4 as adopted
  9/09/2024,
  https://www.sos.state.co.us/pubs/rule_making/CurrentRules/8CCR1505-1/Rule4.pdf)
  for measure numbering/ordering.
- Office order: President/VP → US Senator → US Representative → joint
  Governor/Lt. Governor (one contest, one oval) → other state candidates →
  legislative (senate/house) → district attorney → RTD board of directors →
  other district offices greater than a county → county commissioner → county
  clerk & recorder → county treasurer → county assessor → county sheriff →
  county surveyor → county coroner ("The positions on the ballot shall be
  arranged as follows: First, candidates for president and vice president…").
  Governor sits AFTER US House — matches the baseline's federal-first spine.
  The statute does NOT order "other state candidates" internally; the SOS
  fixes it per cycle — full chain SOS → Treasurer → AG → State Board of
  Education (At-Large, then CD seat) → CU Regent observed on Douglas 2022
  (the only ballot with the whole chain; Arapahoe 2024 shows only
  SBE-before-Regent, Denver 2024's state head is a single Regent contest),
  and CONFIRMED by the official SOS "2026 General Election Ballot Order"
  page (verify pass;
  https://www.sos.state.co.us/pubs/elections/vote/generalBallotOrder.html,
  lot drawing July 28, 2026): US Senate → US House → Governor/Lt Governor
  → SOS → Treasurer → AG → State Board of Education → CU Regent → State
  Senate → State House — official artifact, though NOT the § 1-5-203
  certificate itself (still unlocated). Colo. Const. art. IV § 1(1) covers
  only SOS → Treasurer → AG; SBE and Regent placement is practice + the
  SOS page. Unlisted offices: clerk uses "substantially the form
  prescribed by this section".
- Judicial: Colorado elects NO judges — retention questions only. Fixed
  internal order supreme court → court of appeals → district court →
  county court, and precedence over all measures, from § 1-5-403(5)'s
  final sentence ("…shall be placed on the ballot in that order and shall
  precede the placement of ballot issues…"); the block's position AFTER
  every candidate contest is observed practice (Denver/Arapahoe/Douglas —
  the statute fixes only order-within-block and before-measures).
- Measures: after all offices and after retention. Tier order
  (§ 1-5-407(5)(a)): referred amendments → initiated amendments → referred
  propositions → initiated propositions → county → municipal → school
  district → other subdivisions in more than one county → other subdivisions
  wholly within one county. RTD sales-tax-rate questions carve out to
  "immediately following any statewide amendments and propositions"
  (§ 32-9-119.3(2)). Within a grouping: referred before initiated, tax →
  excess-revenue retention → debt → other (Rule 4.5.2(c)). CONFLICT
  (practice vs statute, unresolved — recharacterized by the verify pass):
  Rule 4.5.2(e) expressly DEFERS ordering to the statute ("Ballot issues
  from the various political subdivisions must be ordered on the ballot as
  provided in section 1-5-407(5), C.R.S") — its 1A-7Z letters are
  DESIGNATIONS, not an order (note (e)(2)'s initiated-local series numbers
  greater-than-county 500-599 BEFORE wholly-within 600-699, the opposite
  sense of (e)(3)'s 6/7 lettering). But observed practice does not follow
  the statute's last two tiers: Denver 2024 printed DDA 6A (wholly within)
  before RTD 7A (greater than a county); Arapahoe 2024 printed Polo
  Reserve Metro 6A before RTD 7A AND ran its school tier 5A/5B/5C before
  4A/4B. Counties also differ in intra-tail method — Denver + Douglas
  ascending designation series, Arapahoe alphabetical by subdivision
  (Rule 4.5.2(e)(5) grouping). Neither 2024 RTD 7A question was a
  § 32-9-119.3(1) sales-tax-RATE increase (both revenue-retention), so
  the § 32-9-119.3(2) carve-out does not explain it. Treat within-tail
  sequencing below the school tier as county-variable.
- County discretion: limited but real — (1) unlisted offices via the
  "substantially the form" catch-all (municipal offices printed after county,
  before retention, on Arapahoe 2024 + Douglas 2022 — clerk practice, no
  statutory sentence names that position); (2) § 1-5-407(5.5) separate-ballot
  option with a materially different measure order (candidates → tax
  increases → debt increases → citizen petitions → referred measures);
  (3) Rule 4.5.2(e)(5) lets the designated election official assign final
  measure numbers, grouping each subdivision's measures together.
- School/special: school tier structurally EMPTY on an even-year general —
  school director elections are odd-year November (§ 1-1-104(39)); special
  district directors = May odd-year (§ 1-1-104(42)). Only their MEASURES ride
  the general ballot. Exception: RTD directors print in a prescribed slot
  after district attorney (§ 1-1-104(41) + § 1-5-403(5)).
- Corroboration: Denver 2024 general composite
  (https://www.denvergov.org/files/assets/public/v/1/clerk-and-recorder/documents/elections-division/2024/ballot-measures/2024-general-composite-sample-engspa.pdf)
  — federal → state → DA → RTD, retention block supreme→appeals→district→
  county between offices and measures, statewide measure tiers in statutory
  order, DPS 4A → DDA 6A → RTD 7A tail; Arapahoe 2024 general
  (https://files.arapahoeco.gov/Your%20County/Arapahoe%20Votes/Documents/Records%20And%20data/Past%20Elections%20File%20Library/2024/2024%20GENERAL%20ELECTION%20SAMPLE%20BALLOT-ENG-20241003_0.pdf?t=202504090233470)
  — municipal offices (Cherry Hills Village) after county, before retention;
  printed measure headers State → County → Municipal → School District →
  Special District; Douglas 2022 general composite
  (https://www.douglas.co.us/documents/2022-general-election-composite-sample-ballot.pdf/)
  — Governor/Lt Gov pair after US House and before SOS → Treasurer → AG →
  SBE → Regent; county internal order exactly as § 1-5-403(5) (cycle 2022).
  All fetched curl + browser UA → pypdf. No office/judicial/measure-placement
  conflict; only the Rule-vs-statute tier inversion above.
- Baseline delta: (1) judicial = retention questions only, and the block
  lands after municipal/local OFFICES but before measures — baseline's late
  judicial block shape holds, but as Yes/No questions with zero elected
  judgeships; (2) RTD directors = prescribed contest between district
  attorney and county offices — no baseline analogue (multi-county special
  district ABOVE county tier); (3) school tier empty (odd-year); (4) county
  office internal order statutory (commissioner → clerk → treasurer →
  assessor → sheriff → surveyor → coroner); (5) DA prints before county
  offices (judicial-district office above county tier).
- Notes: § 1-5-402(1)(b) orders primaries similarly (no President, no
  Gov/LtGov pair, no RTD line) — general-only above. Candidate order within
  a contest: major parties by lot drawn July 1-15, then minor parties, then
  other organizations, each by lot (§ 1-5-404); President/VP and Gov/LtGov
  pairs alphabetical by top-of-ticket — informational only ("candidates
  are ordered by a lot drawing with the exception of the office of
  Governor and Lt. Governor, which are ordered by the last name of the
  gubernatorial candidate" — SOS generalBallotOrder.html). "Other state
  candidates" internal order is observed practice + the official SOS
  ballot-order page, not statute — flagged for the override decision (the
  § 1-5-203 certificate itself remains unlocated). GRADE SCOPE: A covers
  the office order, the judicial-retention block placement, and measure
  tiers through school district. NOT covered by the A: (a) sequencing
  WITHIN the school tier and of the final two "other political
  subdivisions" tiers — observed county practice contradicts
  § 1-5-407(5)(a) and differs between counties; (b) municipal-office
  placement (after county, before retention) — clerk practice under the
  "substantially the form" catch-all, not statute.

### MN — Minnesota (FIPS 27) — GRADE A
- Authority: Minn. R. 8250.1810 ("Format of ballots for optical scan
  systems"), subps. 5, 6, 10, 11, 18,
  https://www.revisor.mn.gov/rules/8250.1810/ (accessed 2026-08-16) — the
  only live rule FIXING CONTEST ORDER in ch. 8250 (8250.1800 repealed, 34
  SR 1561; 8250.0375 "FORM OF JUDICIAL BALLOT" is live but governs the
  overflow judicial ballot's form only); current text includes the June 1,
  2026 amendments (50 SR 971), in force for Nov 3, 2026. Statutory backbone: Minn. Stat. § 204D.13 subd. 1
  (partisan order + delegation: "The candidates for state offices shall
  follow in the order specified by the secretary of state",
  https://www.revisor.mn.gov/statutes/cite/204D.13); § 204D.11 subds. 1, 6
  (single "state general election ballot"; separate judicial ballot only
  when one card can't fit — card split, not reorder; implementing rule
  8250.0375); § 204D.15 subd. 1 (amendment titles). SOS implementation: 2026
  + 2024 statewide Example Ballots + Explanatory Notes (subp. 18: "The
  official ballots must conform in all respects to the example ballot").
- Office order: President/VP → US Senator → US Representative → State
  Senator → State Representative → Governor and Lieutenant Governor →
  Secretary of State → State Auditor → Attorney General → county block
  (Commissioner → Auditor → Treasurer → Auditor-Treasurer → Recorder →
  Sheriff → County Attorney → Surveyor → Coroner → Park Commissioner → Soil
  & Water Conservation District Supervisor → Conservation District
  Supervisor) → County Questions → city block
  (Mayor → Council → Clerk → Treasurer) → City Questions → town block → Town
  Questions → School Board Member → School District Questions → special
  district offices → Special District Questions → Judicial Offices.
  LEGISLATURE PRINTS BEFORE GOVERNOR — statewide executives are the TAIL of
  the State Offices block, not its head. No elected State Treasurer.
  At-large seats before district seats of same type; numbered seats in
  numerical order. § 204D.13 subd. 1 orders only the partisan backbone
  (US Sen → US Rep → state senator → state representative) and delegates the
  rest to the SOS; Rule 8250.1810 subp. 6 IS that specification — no
  conflict between the instruments. (Earlier seed's "204D.13 subd 2" was off
  by one — subd. 2 is presidential CANDIDATE order, not office order.)
- Judicial: DEAD LAST — after every office AND every question. Subp. 6:
  "Judicial offices must follow special district offices and appear in the
  following order: Chief Justice - Supreme Court / Associate Justice -
  Supreme Court / Judge - Court of Appeals / Judge - District Court."
  Numbered seats numerical, except a court's single-candidate seats print
  after that court's contested seats. § 204D.11 subd. 6 separate judicial
  ballot = overflow card only (8250.0375 subp. 1).
- Measures: two treatments. (1) Statewide constitutional amendments print
  EARLY — subp. 5 puts "Constitutional Amendments" third, immediately after
  State Offices, before County Offices. (2) Everything else interleaves per
  jurisdiction — subp. 10: "Ballot questions must be printed after offices
  of the same jurisdiction." No trailing measures block exists; judicial
  follows all of it. Amendments: SOS titles + AG approval (§ 204D.15
  subd. 1); failure-to-vote-counts-as-no notice beneath the heading
  (subp. 11); multiple amendments numbered.
- County discretion: narrow — auditor prepares ballots "subject to the rules
  of the secretary of state" (§ 204D.11 subd. 1) and must conform to the
  example ballot (subp. 18). Genuine delegation: unlisted county offices
  follow SWCD Supervisor "in the order determined by the county auditor"
  (subp. 6); position-by-lot when candidates ≤ seats (subp. 7); question
  titles written locally (subp. 10).
- School/special: School Board Member = own type after Town Questions;
  school questions immediately behind school offices; special districts
  (rule's example: Hospital District Board Member) between School District
  Questions and Judicial. Split precincts carry school district number on
  the style (subp. 1).
- Corroboration: SOS 2026 example ballot (gubernatorial year — settles
  Governor slot; "November 3, 2026",
  https://www.sos.mn.gov/media/5c1d4i4a/2026-primary-general-and-judicial-example-ballots.pdf)
  + SOS 2024 example ballot
  (https://www.sos.mn.gov/media/ejvpcipi/2024-primary-general-and-judicial-example-ballots.pdf)
  + REAL Hennepin County 2024 general (Golden Valley P-4,
  https://goldenvalleymn.gov/DocumentCenter/View/4326 — amendment before
  local tiers, school questions interleaved, judicial dead last,
  Supreme→Appeals→District) + REAL Rice County 2024 general (Northfield W4
  P2, https://www.northfieldmn.gov/DocumentCenter/View/21355/W4-P2 —
  full-stack: SWCD as county office, county question between county and
  city offices, judicial after all questions; small county, completeness
  corroborator) + Anoka County 2026 PRIMARY (Coon Rapids W-5 P-3,
  https://coonrapidsmn.gov/DocumentCenter/View/3957/Coon-Rapids-Ward-5-Precinct-3-PDF
  — supporting only, labeled primary). All curl+UA → pypdf. Zero conflicts.
  Verify-pass bonus: the single-candidate-seat exception is OBSERVED on
  both real 2024 ballots — Court of Appeals seat 12 (contested) prints
  before seats 2/3/4/6/8, and Northfield prints Associate Justice 6 before
  5, exactly subp. 6's "only one candidate filed must appear after all
  other judicial offices for that same court".
- Baseline delta: SUBSTANTIAL — (1) legislature before statewide executives
  (Gov/SOS/Auditor/AG follow state house); (2) measures NOT last: statewide
  amendments near top (after State Offices, before county), local questions
  interleaved per jurisdiction; (3) judicial last AFTER measures (baseline
  puts judicial before measures) — internal Supreme→Appeals→District order
  matches; (4) SWCD Supervisor = county office (second-to-last in the
  county block, ahead of the Conservation District Supervisor line), not
  special district.
- Notes: SOS 2026 Explanatory Notes misquote subp. 5 (omit the two Special
  District lines present in the Revisor text — SOS's own 2026 example ballot
  renders them; trust the Revisor). Primary difference (one line): partisan
  primary uses party columns ordered by ascending prior-general average
  vote, nonpartisan section behind a demarcation (subp. 2). Candidate
  rotation (informational): names rotate precinct-to-precinct (§ 204D.13
  subd. 2a, § 204D.08 subd. 3) — never model as stable. Open: no real 2026
  GENERAL ballot exists until ~Sept 18, 2026 (46-day print deadline) —
  Governor slot rests on rule text + official example ballots + a real 2026
  primary ballot; re-check on live 2026 generals if desired. Pre-1997 "pink
  ballot" amendment history unverified (Revisor 1996 archive unfetchable) —
  no claim made; § 204D.15 subd. 2 marked repealed 1997.

### SC — South Carolina (FIPS 45) — GRADE A (scoped — see Notes)
- Authority: no fixed statutory sequence for the whole ballot — two statutes
  control jointly. S.C. Code § 7-13-320(E) DELEGATES arrangement (offices
  placed "in an order as arranged by the State Election Commission" for
  SEC-distributed ballots, by the county board of voter registration and
  elections for county-distributed ones, incl. State Senator + State House;
  multi-county uniformity duty with SEC tiebreak if boards deadlock within
  60 days of the general — tiebreak also requires "written certification by
  at least one commissioner, that they have failed to act"); § 7-13-330
  supplies the statutory ballot TEMPLATE ("The arrangement of general
  election ballots containing the names of candidates for office must
  conform as nearly as possible to the following plan") whose blocks
  run STATE (Governor → Lt Gov → SOS) then CONGRESSIONAL (US Senator → US
  Rep), made binding by § 7-13-335 ("shall conform these ballots to the
  requirements of Section 7-13-330"). § 7-13-340 splits who arranges what
  (SEC: presidential electors, state officers, US Senate/House; county
  boards: State Senate/House, county, local, circuit; municipal authorities:
  municipal — expressly including "school districts, public service
  districts and like political subdivisions"). § 7-13-410 amendments.
  https://www.scstatehouse.gov/code/t07c013.php (accessed 2026-08-16). NO
  admin rule on order — S.C. Code of Regs Ch. 45 (SEC) fetched in full,
  covers vote recorders/ballot cards only
  (https://www.scstatehouse.gov/coderegs/Chapter%2045.pdf). § 7-13-440
  (machine-ballot arrangement) repealed by 2022 Act No. 150 § 17.
- Office order: Straight Party selector → President/VP (presidential years)
  → statewide executives (gubernatorial years — the President block and
  the executive block are MUTUALLY EXCLUSIVE by cycle, so their relative
  order is notional): Governor and Lieutenant Governor (single joint
  contest) → Secretary of State → State Treasurer → Attorney General →
  Comptroller General → Superintendent of Education → Commissioner of
  Agriculture → US Senate → US House → State Senate (presidential years;
  4-yr terms) → State House → Circuit Solicitor → county row officers
  (Sheriff, Probate Judge, Clerk of Court, Coroner, Auditor, County
  Treasurer, Register of Deeds — Register of Deeds position relative to
  County Council VARIES by county: Greenville before, Charleston after) →
  County Council → Soil &
  Water District Commission → School Board of Trustees → Public Service
  Districts → Constituent School Boards → Statewide Constitutional
  Amendments → Local Questions. Municipal = physically separate ballot in
  OBSERVED practice (Sumter 2024 city sheet; Charleston 2024 municipal
  special elections print after the questions) — § 7-13-340 assigns
  municipal printing/arrangement to municipal authorities and construes
  "municipal" to include school + public service districts, yet school/PSD
  contests print INLINE on the county ballot; cite § 7-13-340 for who
  arranges, the ballots for the physical separation. STATEWIDE EXECUTIVES
  SIT ABOVE US SENATE AND US HOUSE — statutory (§ 7-13-330 STATE block
  before CONGRESSIONAL block, verified in raw HTML source order) + observed
  (Charleston 2022).
- Judicial: Probate Judge is the ONLY judicial contest SC voters see —
  countywide, partisan, 4-year (§ 14-23-30: "elected by the qualified
  electors of the respective counties"), printed INSIDE the county
  row-officer block, not late. All other courts: Supreme/Appeals/Circuit =
  joint public vote of the General Assembly (S.C. Const. art. V §§ 3, 8,
  13); Family (§ 2-19-80) + Administrative Law (§ 1-23-510(A)) = General
  Assembly; magistrates = Governor + Senate consent (art. V § 26); municipal
  judges = council-appointed (§ 14-25-15); masters-in-equity =
  Governor-appointed (§ 14-11-20). Judicial late block EMPTY.
- Measures: last, two labeled blocks — "Statewide Constitutional
  Amendments" then "Local Questions" (printed headings on 2024 Georgetown +
  Sumter ballots). § 7-13-410: statewide amendments under that heading,
  white paper; local constitutional amendments = separate non-white ballot,
  counties alphabetical. § 7-13-450 permits a separate measure ballot.
- County discretion: EXPLICIT — § 7-13-320(E) hands order to SEC (top
  block, uniform statewide in practice) and county boards (below State
  House), which is where inter-county variation shows: Charleston puts
  Register of Deeds AFTER County Council; Georgetown/Sumter run row
  officers contiguously before Council. County block = soft-ordered.
- School/special: nonpartisan, after County Council, before measures: Soil &
  Water → School Board of Trustees → Public Service District → Constituent
  School Board. Names alphabetical in nonpartisan/at-large multi-seat races
  (§ 7-13-335).
- Corroboration: Charleston 2022 general ACTUAL sample ballots, styles 272 +
  178
  (https://www.charlestoncounty.org/departments/bevr/files/2022-General-Election_Sample-Ballots/Charleston_County_Sample_Ballot_Style272.pdf
  and …Style178.pdf) — executives above US Senate/House, internal executive
  order, probate judge in county block, amendments last; Georgetown 2024
  general (56 styles,
  https://www.gtcountysc.gov/DocumentCenter/View/3223/20241105-General-Election-Sample-Ballots-PDF)
  — President top, row-officer block, two-block measures tail; Sumter 2024
  general
  (https://www.sumtersc.gov/sites/default/files/uploads/Departments/NewsMedia/sample_ballot_public.pdf)
  — measures tail + municipal as physically separate ballot; Charleston
  2024 OFFICIAL BALLOT BOOKLET, all 301 styles (emergency/provisional,
  https://www.charlestoncounty.org/departments/bevr/files/Sample_EMG.pdf?v=536
  — ROLLING FILENAME, overwritten each election; content = Nov 5 2024 as
  of 2026-08-16; %PDF magic verified, 5.73MB, 602 pp): style B001 =
  Straight Party → President → US House D1 → State Senate 32 → State House
  112 → Solicitor Circuit 9 → Sheriff → Clerk of Court → Coroner → Auditor
  → County Treasurer → Soil & Water → School Board of Trustees D2 →
  Constituent School Board → Statewide Constitutional Amendment 1 → Local
  Questions 1-2; across styles: County Council always between County
  Treasurer and Soil & Water (145 styles); Public Service District after
  Soil & Water (98 styles); MUNICIPAL SPECIAL ELECTIONS DEAD LAST after
  both questions (B005 Isle of Palms, B29 Kiawah); Sheriff → Clerk →
  Coroner → Auditor → Treasurer identical in all 301 styles. Also
  Charleston 2024 results report as validated proxy
  (https://www.charlestoncounty.org/departments/bevr/files/10110524-ElectionResults.pdf?v=3)
  and Greenville County official 2024 candidate list (grade-B corroborator,
  https://www.greenvillecounty.org/VoterRegistration/pdf/2024GeneralElectionCandidates.pdf
  — same sequence; county section = Sheriff, Clerk, Coroner, Register of
  Deeds → County Council → nonpartisan Soil & Water → school trustees →
  Watershed → Fire District). All curl+UA → PyMuPDF.
- Baseline delta: (1) statewide executives BEFORE US Senate + US House
  (President stays top); (2) judicial block EMPTY — probate judge mid-ballot
  with county row officers; (3) straight-party selector heads the ballot;
  (4) Circuit Solicitor between legislature and county block; (5) municipal
  = separate ballot, after questions when combined (baseline: municipal
  before school); (6) measures last in two blocks — matches baseline.
- Notes: no candidate rotation (partisan contests ordered per SEC
  arrangement; nonpartisan alphabetical). Primary (one line): § 7-13-610
  splits primaries onto two alphabetical ballots (state+federal vs General
  Assembly/county/circuit). GRADE SCOPE: A applies to the SEC-arranged
  block (presidential electors, statewide executives, US Senate, US
  House) — § 7-13-330's STATE-before-CONGRESSIONAL template made binding
  by § 7-13-335, corroborated by Charleston 2022. Everything from State
  Senate DOWNWARD is delegated to county boards (§ 7-13-320(E) +
  § 7-13-340), fixed by no statute or regulation (Regs Ch. 45 order-free),
  and VARIES between counties (Register of Deeds before Council in
  Greenville, after in Charleston) — treat the county-and-below sequence
  as observed practice, grade B. Open: probate-judge cycle — § 14-23-30
  prescribes a UNIFORM statewide cycle ("each alternate general election,
  reckoning from the year 1890" → 2022, 2026), Charleston 2022 fits, but
  Georgetown ran a probate contest in 2024 while Charleston's 602-style
  2024 booklet (zero "Probate Judge" hits) and Sumter 2024 had none —
  observed variation is a DEPARTURE from the statute, so verify per
  county, per cycle; repealed § 7-13-440 prior text unavailable; no
  written SEC order directive located (ordering = operational practice
  implementing the § 7-13-330 template). President-vs-US-Senate: OBSERVED
  on a mirror-class artifact, so it SUPPORTS the inference but remains
  FORMALLY OPEN under the campaign's primary-source rule (the TN
  precedent: mirror-class evidence cannot close a sourcing gate, however
  low the practical risk). The observation: Greenville County 2020
  general sample ballot, precinct Saluda, prints President and Vice
  President FIRST with U.S. Senate immediately second (then US House 04 →
  State Senate 6 → State House 19 → Sheriff → Clerk → Coroner → Register
  of Deeds → Soil & Water → School Board D19) —
  https://ballotpedia.s3.amazonaws.com/images/7/78/2020_South_Carolina_sample_ballot_%28Greenville_County%29.pdf
  (PDF creationDate 2020-10-20; SHA-256 stable across two fetches;
  down-ballot races verified real). Why mirror-class: a voter-generated
  VREMS copy hosted on Ballotpedia's S3, not any official host — SC
  samples live behind the per-voter VREMS login and Charleston skipped
  2020 sample publication, so no official/archived 2020 artifact was
  locatable this session (Wayback replay down). The list-format
  methodology itself IS validated against an official printed ballot
  (Charleston 2022: SCVotes list-format sample matches printed styles 1 +
  50 contest-for-contest). CLOSE PATH: any official or Wayback-archived
  SC 2020 general ballot showing both contests. NEVER ENCODE "US Senate second" from this — the 2020
  President→US-Senate adjacency exists only because SC's executive block
  is midterm-only; in midterms US Senate prints BELOW the seven
  executives (Charleston 2022, both formats). President-vs-GOVERNOR
  stays structurally open (never co-ballot).

### AL — Alabama (FIPS 01) — GRADE A (scoped — see Notes)
- Authority: Ala. Code § 17-6-25 ("Order of Listing of Candidates on
  Ballots") — full 24-item office ladder,
  https://alison.legislature.state.al.us/code-of-alabama?section=17-6-25
  (OFFICIAL legislature host, browser-fetched 2026-08-16; law.justia mirror
  via r.jina.ai byte-identical). Companions: § 17-6-24 (party columns
  alphabetical from left + blank column; ballot style/design delegated to
  SOS APA rules), § 17-6-35 (straight-party mark "at the head of the
  ticket"), § 17-6-41 (amendment Yes/No format only — NOT position),
  § 17-6-33/-48/-49 ("Place No." for multi-seat; AOC recommends places to
  SOS by Dec 1 prior year), § 17-6-26; Ala. Const. 2022 art. XVIII
  § 284.01(b) (local amendment "on the ballot only in the county ...
  affected",
  https://alison.legislature.state.al.us/constitution?section=284.01).
- Office order (§ 17-6-25): (1) President (if preference primary) →
  (2) Governor → (3) Lt Governor → (4) US Senator → (5) US Representative →
  (6) Attorney General → (7) State Senator → (8) State Representative →
  (9) Supreme Court Justice → (10) Civil Appeals → (11) Criminal Appeals →
  (12) SOS → (13) Treasurer → (14) Auditor → (15) Commissioner of
  Agriculture & Industries → (16) Public Service Commissioner → (17) State
  Board of Education → (18) Circuit Court Judge → (19) District Attorney →
  (20) District Court Judge → (21) Circuit Clerk → (22) other public
  officers "in the order prescribed by the judge of probate" → (23)
  convention delegates → (24) party officers. GOVERNOR + LT GOV ABOVE US
  SENATE/HOUSE. Executives split into THREE runs: Gov/LtGov (before
  Congress) → AG alone (between US House and State Senate) →
  SOS/Treasurer/Auditor/AgComm/PSC (after the appellate courts).
  Legislature sits between AG and Supreme Court. Candidates within each
  office alphabetical by surname (no rotation). Straight-party prints as
  contest #1 on 3/3 verified ballots — PRACTICE: § 17-6-35 prescribes only
  HOW to mark ("at the head of the ticket"), § 17-6-24(a) orders only the
  party COLUMNS; neither fixes the straight-party block's position. Party
  columns alphabetical left-to-right + rightmost blank column (§ 17-6-24)
  — modern ballots print office-by-office with party labels.
- Judicial: within-level, TWO runs, no late block — appellate (9)-(11)
  between State Rep and SOS; trial (18)-(20) Circuit Judge → DA → District
  Judge → Circuit Clerk after SBOE, before county tier. Chief Justice
  before Associate places = practice (statute says only "Supreme Court
  Justice").
- Measures: NO statutory placement rule — complete Art. 2 (§§ 17-6-20 to
  -49) section list pulled; only § 17-6-41 touches amendments (format).
  Observed uniform on 3/3 verified ballots: dead last after every contest —
  recompilation/constitution question → "PROPOSED AMENDMENTS TO APPEAR ON
  THE BALLOT STATEWIDE" 1..N → "PROPOSED AMENDMENTS OF LOCAL…" 1..N → "END
  OF BALLOT". Local amendments print only in the affected county
  (§ 284.01(b)). Measure tier = observed practice, not statute.
- County discretion: explicit — § 17-6-25(22)/(24) delegate everything
  below Circuit Clerk to each county's probate judge. Sheriff, Probate
  Judge, County Commission, Coroner, county BOE, Constable etc. have no
  state internal order; observed sequences differ (Madison 2022: Sheriff →
  Coroner → BOE Supt → BOE Member; Jefferson 2024: Circuit Clerk (Bessemer)
  → Probate P1/P2 → Treasurer → Deputy Treasurer → Asst Tax Collector →
  County BOE → Constable).
- School/special: State BOE Member = item (17), partisan, mid-ballot before
  trial courts. County boards of education = item (22) county tail. No
  special-district tier in statute or on any ballot read.
- Corroboration: Madison 2022 general
  (https://www.sos.alabama.gov/sites/default/files/sample-ballots/2022/gen/Madison-Sample.pdf)
  — items (2)-(22) in exact statutory sequence, measures last; Jefferson
  2024 general
  (https://www.sos.alabama.gov/sites/default/files/sample-ballots/2024/gen/Jefferson-Sample.pdf)
  — President first, appellate block right after US House, PSC → SBOE →
  trial courts → county tail → measures; Jefferson 2022 general
  (https://www.sos.alabama.gov/sites/default/files/sample-ballots/2022/gen/Jefferson-Sample.pdf)
  — statewide amendments 1-10 then LOCAL AMENDMENT 1, all after contests.
  All curl -k + Chrome UA (sandbox TLS interception forces -k; integrity
  via md5 7e47602f8932a46d002c8ed1f47ee328 on the SOS Jefferson-2024 copy,
  reproduced independently by the verifier; the researcher's second-host
  match used
  https://jeffcoprobatecourt.com/wp-content/uploads/2024/11/2024-Pres-General-Sample-Ballot.pdf,
  which now 404s — index at https://www.jeffcoprobatecourt.com/sample-ballots/)
  → PyMuPDF coordinate extraction. Researcher re-verified all three
  itself; five additional subagent-reported county ballots NOT relied on.
  Verifier re-derived all three ballots independently — exact match.
- Baseline delta: LARGE — (1) Gov/LtGov before US Senate/House; (2) AG
  detached, between US House and State Senate; (3) legislature between AG
  and Supreme Court; (4) appellate judiciary mid-ballot; (5) second
  executive run after appellate courts; (6) SBOE between PSC and trial
  courts; (7) trial judiciary before all county offices; (8) straight-party
  contest #1. Tail only PARTLY matches baseline: measures last, yes — but
  there is NO separate school tier; county boards of education are item
  (22) county-tier entries and other county offices can follow them
  (Jefferson 2024: County BOE → Constable).
- Notes: § 17-6-25 descends from a 1975 primary act (items 1/23/24 are
  primary artifacts; § 17-6-26(b) allows amendments on primary ballots with
  amendment-only fallback) — Act 2006-570 recodified it into the general
  Ballots article and 3/3 general ballots follow items (2)-(22) exactly, so
  general-election application settled empirically; no interpretive
  document found (flag for override decision). SOS ballot-design APA rules
  promised by § 17-6-24(b)/-27/-35 appear NEVER promulgated — Ala. Admin.
  Code Title 820 Ch. 2 swept in full (chapters 820-2-1..12; 13-15 = 404),
  no ballot-design chapter. Municipal CLOSED at the statutory level
  (verify pass): § 17-6-45 — for municipal elections held apart from state
  generals, "the duties herein prescribed for the judge of probate …
  shall be discharged … by the mayor or other chief executive officer" —
  so Chapter 6 (incl. the § 17-6-25 ladder) governs stand-alone municipal
  elections with the mayor in the probate judge's role; municipal ORDER
  still unobserved on a ballot. Heading strings vary by county vendor;
  sequence invariant. Legacy alisondb host retired (DNS dead) — use
  alison.legislature.state.al.us SPA (curl gets the Next.js shell; browser
  or the site's POST /graphql `codeOfAlabamaSection` endpoint works).
  GRADE SCOPE: A covers the statutory ladder items (2)-(21) + the three
  matching official samples. NOT covered: measure placement (no authority
  anywhere — observed practice only) and the item-(22) county tier
  (expressly delegated to each probate judge, observed county-variable).

### LA — Louisiana (FIPS 22) — GRADE A
- Authority: La. R.S. 18:551 ("Ballots") — one statute prescribes both
  ballot order and candidate numbering, https://legis.la.gov/Legis/Law.aspx?d=81637
  (accessed 2026-08-16; current through Acts 2025 No. 386 §2). Ballot
  preparation CENTRALIZED in the SOS (18:551(A): "The secretary of state
  shall prepare and certify the absentee by mail ballots, the early voting
  ballots, and the ballots to be used on the voting machines"). SOS
  corroborating page: https://www.sos.la.gov/elections-voting/ballot-numbers.
  18:551(B)(2) covers "a primary or general election" — one order for BOTH,
  so the all-comers-November wrinkle doesn't change the order.
- Office order (18:551(B)(2)): party primary offices (closed-party races,
  grouped by party alphabetically) ABOVE everything → (a) President/VP →
  (b) presidential preference nominees → (c) STATE offices: Governor → Lt
  Gov → SOS → AG → Treasurer → Commissioner of Agriculture → Commissioner
  of Insurance → US SENATOR → US REPRESENTATIVE → Supreme Court justice →
  Court of Appeal judge → Public Service Commission → other state
  boards/commissions (BESE) → any other state office → (d) LOCAL offices:
  state senator → state representative → district judge → district
  attorney → parish court judge → sheriff → clerk of court → assessor →
  coroner → police juror → city court judge and marshal → SCHOOL BOARD →
  other local boards → justice of the peace → other local (constables) →
  (e) MUNICIPAL: mayor → chief of police/marshal → alderman/city council →
  municipal boards → (f) political party offices (state central committee,
  parish executive committee). Governor prints ABOVE US Senate/House by
  statute — but they never co-print (statewide execs = odd years 2023/2027,
  Congress = even years); statutory only, empirically untestable.
- Judicial: NO late block — split exactly as elected. Supreme Court +
  Court of Appeal INSIDE the state block, after US Representative, before
  PSC. District judge + DA at the TOP of the local block (slots 3-4, ahead
  of sheriff/clerk). Parish court judge next; city court judge/marshal
  later in (d) after police juror; JP second-to-last in (d) with
  constables after. All ballot-confirmed.
- Measures: statute SILENT on placement — 18:551(E) is typography only
  ("uniform size and style"); 18:1299/.1 = drafting, not position. Uniform
  practice on 6/6 ballots across 4 cycles (2020/2022/2023/2024): measures
  LAST — statewide constitutional amendments in CA-number order →
  parishwide propositions → municipal/special-district propositions.
  Strong practice, not codified law.
- County discretion: none — SOS central preparation; parish clerks only
  certify local candidates' NAMES (18:551(C)(1)(b)). Residual discretion
  is the SOS's: unlisted offices "in the order determined by the secretary
  of state" (18:551(B)(4)); special-election offices may move to the end
  (18:551(B)(3)); plus two discretions INSIDE the order list (verify
  pass): (B)(2)(b) lets the SOS lift presidential-preference nominees
  above same-party primary offices, and (B)(2)(f) lets political party
  offices move to just after the party-primary block instead of the end.
- School/special: parish school boards = LOCAL block (d), after police
  juror + city court judge/marshal, BEFORE municipal offices —
  ballot-confirmed (Lafayette 2023: "Member of School Board District 6"
  immediately above "City Council Member District 2, City of Lafayette").
  BESE = STATE office in block (c).
- Corroboration: official SOS precinct sample ballots via the GeauxVote
  portal's parish/ward/precinct-keyed endpoint (NOT address-gated):
  https://voterportal.sos.la.gov/SampleBallot/RacesByRegion?electionDate=…&parishId=…&wardId=…&precinctId=…
  — 6 single-precinct reads across 4 cycles: East Baton Rouge Nov 2024
  (measures tail: CA 1 → parish HRC amendment → Rec & Park props →
  city millage); Orleans Nov 2020 (Supreme Court after US Rep; Civil/
  Criminal District Courts + Magistrate + DA + Juvenile atop local block;
  school board after courts; CA 1-7 last); Orleans Nov 2022 (Court of
  Appeal 4th → PSC 3 → State Senator; CA 1-8 → parish prop); St. Tammany
  Oct 2023 gubernatorial (Gov → LtGov → SOS → AG → Treasurer → BESE →
  State Rep → District Judge → Sheriff → Clerk → Parish President →
  Council → CA 1-4); St. Tammany Nov 2020 (JP Ward 4 → Constable Ward 4
  directly before measures); Lafayette Oct 2023 (school-before-municipal).
  All curl+UA, single-precinct contiguous reads (researcher explicitly
  re-fetched individual precincts; parallel subagent's unreturned work NOT
  relied on). Verify-pass additions (verifier's own reads): Jefferson
  Parish 11/03/2020 (27/172/1750) — PSC 1 → Judge 2nd PARISH COURT Div A →
  JP 2nd Justice Court → Constable 2nd → CA 1-7 → PW Sports Wagering →
  Inspector General Special Services Funding District (parish-court slot +
  sub-parish measure tail CONFIRMED); EBR 10/12/2019 (18/134/1113) — full
  block-(c) executive run Gov → LtGov → SOS → AG → Treasurer → Ag &
  Forestry → Insurance → BESE 8, then (d) … Sheriff → Clerk → Assessor →
  CORONER (coroner slot confirmed).
- Baseline delta: (1) statewide executives ABOVE US Senate/House; (2) no
  late judicial block — appellate in state block after US House, trial
  courts + DA atop local block ahead of sheriff; (3) school board BEFORE
  municipal; (4) JP/constable tail of local block, still before municipal;
  (5) party offices after municipal; (6) closed-party-primary races print
  above President; (7) measures last matches baseline (practice only).
- Notes: NO rotation — names alphabetical by surname, numbered statewide,
  numbers permanent primary→general (18:551(C)(1)(c)(i)). November 2026 =
  hybrid: "U.S. Senate General/Open U.S. Representative Primary/Open
  Primary Election" (SOS election-dates page; closed party primary
  effective May 2026 for US House/Senate/Supreme Court/PSC/BESE, but Act 7
  of 2026 RS moved US House back to the fall open primary after a SCOTUS
  ruling — SOS press release 5/14/26,
  https://www.sos.la.gov/media/dcvl5ojl/051426-fall-house-races.pdf).
  Nov 3 2026 ballot not yet built — portal's election dropdown offers only
  ElectionId 343 (06/27/2026) as of 2026-08-16; re-pull in September to
  see the hybrid sequencing + whether a party-primary block appears.
  Open: measures-last has no authority; "party primary office" definition
  (R.S. 18:2(9)) not fetched first-hand; municipal (mayor/alderman)
  placement rests on statute alone (parish court judge + coroner CLOSED by
  the verify pass's Jefferson 2020 + EBR 2019 reads).

### KY — Kentucky (FIPS 21) — GRADE A (scoped)
- Authority: no single statute prescribes the full sequence. CAUTION
  (verify pass): 31 KAR 2:010 §1(11)'s "in the order under which they have
  been certified pursuant to KRS 118.215(1)" sits inside the DEFINITION of
  "Zero-file" — a TABULATION file, not the ballot; §2(2)(a) has no
  ordering words; §2(4)'s "appear in the correct positions" is circular —
  so the ballot↔certification order link is an INFERENCE from practice,
  not regulatory text
  (https://apps.legislature.ky.gov/law/kar/titles/031/002/010/). KRS
  117.383(2) DIRECTS the SBE to regulate ballot placement ("shall
  promulgate administrative regulations … and shall provide methods to: …
  (2) Place items on any ballot"), and no such regulation exists — 31 KAR
  chapters 1-6 swept 2026-08-16 with no contest-sequence chapter: Kentucky
  has left the sequence unregulated. KRS 118.215(1) (SOS certification +
  EXPRESS statutory order for the county/local-state tier: "Commonwealth's attorney, circuit clerk,
  property valuation administrator, county judge/executive, county
  attorney, county clerk, sheriff, jailer, county commissioner, coroner,
  justice of the peace, and constable",
  https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=56458);
  KRS 118.225 (names within office by lot); KRS 118A.090(4) (judicial =
  separate "Judicial Ballot" column immune to straight-party); KRS
  160.230 ("School Candidates" device); KRS 118.415(3) (amendments
  "indicated on the ballots" — no position); KRS 424.290 (published
  facsimile). All apps.legislature.ky.gov, curl+UA → pypdf, 2026-08-16.
  GRADE SCOPE (widened by the verify pass): statutory (A) = the
  county/local-state tier's internal order (KRS 118.215(1)) and the
  judicial/school ballot DEVICES (KRS 118A.090(4), 160.230). Everything
  else is B: the federal→state descent rests on an SOS certification
  order (the located instance is a 2026 PRIMARY certification), not
  statute; and the POSITIONS of the judicial, school, city and amendment
  blocks rest on county KRS 424.290 publication facsimiles (17 counties,
  2024 cycle), not on any authority text.
- Office order (Nov even-year, as certified and printed): straight-party
  box FIRST → President/VP → US Senator → US Representative → State
  Senator → State Representative → Commonwealth's Attorney → Circuit
  Clerk → other county offices (statutory sequence above) → nonpartisan
  judicial block → nonpartisan tail (soil & water / school board / city
  offices — SUB-ORDER VARIES BY COUNTY, see Notes) → constitutional
  amendments (countywide questions can follow them). STATEWIDE EXECUTIVES NEVER APPEAR IN EVEN
  YEARS — Ky. Const. § 95 fixes Governor/LtGov/Treasurer/Auditor/AG/SOS/
  Ag Commissioner to 1895+4k (2023, 2027); Governor-vs-US-House moot on
  the even-year ballot. Commonwealth's Attorney + Circuit Clerk are
  judicial-CIRCUIT offices but PARTISAN, heading the county block, not in
  the judicial block.
- Judicial: nonpartisan, own block under printed "NONPARTISAN JUDICIAL
  BALLOT" banner; KRS 118A.090(4) requires separate column/line
  "identified by the words 'Judicial Ballot'" so straight-party can't
  reach it; no party designation (KRS 118A.150(1)). Statute does NOT fix
  block position — McCracken 2024 prints it after partisan county
  offices, before the rest of the nonpartisan tail. Internal order
  CLOSED by the multi-county sweep (Kenton 2022 composite): Supreme Court
  → Court of Appeals → Circuit Judge (Family Court divisions interleaved
  by division number) → District Judge — the full chain on one county's
  ballot.
- Measures: constitutional amendments NEAR-last ("ALL PRECINCTS";
  McCracken 2024 prints them after everything on that ballot). CORRECTED
  by the multi-county sweep: CITY questions ride WITH that city's races
  (cannabis questions inline in the city blocks — Boone/Campbell/Hardin);
  COUNTYWIDE questions print AFTER the two constitutional amendments
  (Hardin QUESTION-HARDIN CANNABIS last, Bullitt QUESTION-BULLITT
  CANNABIS last, Fayette AD VALOREM TAX FOR PUBLIC PARKS last). KRS
  118.415(3) has no position rule — all placement = practice, and
  inferred from KRS 424.290 publication-facsimile COMPOSITES (layouts
  span precinct styles), not single-precinct ballot images.
- County discretion: SUBSTANTIAL and the real source of local sequencing
  — county clerk composes the certification listing (31 KAR 2:010
  §2(2)(a)), verifies positions (§2(4)); position unchangeable once
  designated (KRS 118.215(6)); independents + city candidates by clerk
  lot (KRS 118.215(2)-(3)). Bounded by the KRS 118.215(1) list only for
  the offices it NAMES — off-list county offices are slotted by the clerk
  inside that run (McCracken 2024 prints County Surveyor between Circuit
  Clerk and Justice of the Peace; Surveyor is not in the § (1) list).
- School/special: school board nonpartisan under printed NONPARTISAN
  "SCHOOL CANDIDATES" banner (KRS 160.230 verbatim device); order by
  lot; common-school divisions before independent-district seats; placed
  after judicial, before city. Soil & water supervisors nonpartisan,
  county-clerk-filed (KRS 262.210/.220), grouped with local nonpartisan
  offices (Kenton 2024 filings).
- Corroboration: McCracken County (Paducah) 2024 general official KRS
  424.290 facsimile, clerk-certified ("I, Jamie Huskey, County Clerk …
  true copy of the ballots"),
  https://mccrackencountyky.gov/wp-content/uploads/2020/10/2024-General-election-sample-ballot.pdf
  (scan → PyMuPDF render → visual read): STRAIGHT PARTY → President/VP →
  US Rep 1st → State Rep 1/2/3/6 → Commonwealth's Attorney 2nd Circuit →
  Circuit Clerk → County Surveyor (unexp.) → Justice of the Peace 2nd
  (unexp.) → NONPARTISAN JUDICIAL BALLOT (Appeals 1st App. Dist. 2nd
  Div. unexp. → District Judge 2nd 2nd unexp.) → NONPARTISAN "SCHOOL
  CANDIDATES" (Bd of Ed 2nd/4th/5th → Paducah Independent) → NONPARTISAN
  CITY BALLOT (Mayor Paducah → City Commissioners) → Strawberry Hills
  wet/dry QUESTION → (p.2) CONSTITUTIONAL AMENDMENT 1 → 2. County
  relative order matches KRS 118.215(1) (CA 1st, Circuit Clerk 2nd, JP
  11th). Supporting: Fayette 2026 PRIMARY publication ballot
  (https://web.sos.ky.gov/ballots/FAYETTE%202026P.pdf — federal→state→
  county descent inside party columns); SOS 2026 PRIMARY certification
  (May 19, 2026, SOS Michael G. Adams — a PRIMARY document; via Kenton
  clerk,
  https://kentoncountykyclerk.com/wp-content/uploads/2026/02/2026-KentonCertification.pdf)
  — operative order language (verify pass; the earlier quote was a scope
  recital): p.6 "Pursuant to KRS 118.215: The County Clerk of each county
  shall indicate on the ballots the following in order certified (where
  applicable). Republican Party / Democratic Party / Nonpartisan /
  Judicial Ballot"; p.19 (Kenton page) "You will place on the ballot the
  STATEWIDE OFFICES as listed in Section 4, then place the following on
  the ballot:" → US Representative → State Representative 63/64/69/78,
  with Section 4 (p.14) opening at United States Senator; Kenton "How to
  Read a Publication Ballot"
  ("The first item on everyone's ballot will be the Straight Ticket
  option"). MULTI-COUNTY SWEEP (child agent): 17 counties total. Live
  URL patterns:
  https://<name>countyclerk.ky.gov/wp-content/uploads/2024/10/<County>-2024G*.pdf
  (Boone Newspaper-Composite, Campbell, Jessamine, Woodford, Franklin,
  Clark, Oldham; Laurel under .../2024/09/, Daviess at
  https://www.daviessky.org/wp-content/uploads/2024/10/General-Election-Composite-2024.pdf)
  and https://<county>.countyclerk.us/wp-content/uploads/<yyyy>/<mm>/<County>-<yyyy>G.pdf
  (Bourbon, Campbell, McCracken). Claim-carrying exact URLs: Kenton 2024
  publication ballot
  (https://kentoncountykyclerk.com/wp-content/uploads/2024/09/2024-General-Publication-Ballot-24-9-24-21-48-38.pdf
  — city BEFORE school) + KENTON 2022 COMPOSITE, the judicial-chain
  anchor
  (https://kentoncountykyclerk.com/wp-content/uploads/2022/09/2022-GENERALCOMPOSITE-BALLOT.pdf
  — full county tier PVA → County Judge/Executive → County Attorney →
  County Clerk → Sheriff → Jailer → County Commissioner → Coroner →
  Surveyor → Magistrate → Constable matching KRS 118.215(1), then the
  FULL judicial chain); Fayette 2024
  (https://www.fayettecountyclerk.com/web/elections/2024GenElectionBallot.pdf
  — live tree now soft-404, recover via Common Crawl CC-MAIN-2024-46;
  ad-valorem question LAST after amendments); Jefferson clerk candidate
  list ("Candidates are listed in the order in which they will appear on
  the ballot" — LOCAL offices only;
  https://elections.jeffersoncountyclerk.org/pdfs/g24public.pdf, live
  host Akamai-403, recover via CC-MAIN-2024-42); Warren + Hardin +
  Bullitt + Madison SOS copies
  (https://web.sos.ky.gov/ballots/<County>%202024G.pdf, all live-404 —
  SOS purges to current cycle — recover via CC-MAIN-2024-42; Hardin +
  Bullitt carry the countywide-cannabis-after-amendments finding).
  Common Crawl recipe: query the CC index for the URL in the named
  collection, then a Range request on data.commoncrawl.org (1MB
  truncation corrupts big PDFs — re-fetch those from live county hosts).
  Dominant 2024 skeleton confirmed statewide: Straight Party →
  President/VP → US Rep → State Senator → State Rep → Commonwealth's
  Attorney → Circuit Clerk → leftover partisan county (unexpired terms) →
  NONPARTISAN JUDICIAL BALLOT → soil & water → school → city →
  amendments.
- Baseline delta: (1) straight-party box first, ahead of President;
  (2) NO statewide executives in even years (state legislature follows US
  House directly); (3) judicial block NOT last — county → JUDICIAL →
  school → city (baseline: county → municipal → school → judicial);
  (4) partisan Commonwealth's Attorney + Circuit Clerk head the county
  block; (5) amendments-last matches baseline.
- Notes: primary (one line): party columns + nonpartisan column, same
  descent. NO rotation — single public lot drawing fixes name order (KRS
  118.225, 118A.090(1)), then unalterable. KRS 118.235 ("Form of
  ballots") repealed 2003 — researcher-verified via the chapter index;
  the verifier could NOT re-verify (chapter.aspx renders via JS) — treat
  as single-sourced. NONPARTISAN TAIL SUB-ORDER VARIES BY COUNTY
  (sweep finding): soil & water usually before school
  (Boone/Campbell/Daviess/Kenton) but Fayette prints it LAST among
  nonpartisan races; school usually before city but Kenton 2024 and
  Laurel print CITY before school; Fayette inserts URBAN COUNTY COUNCIL
  between judicial and school — consistent with clerk discretion under
  31 KAR 2:010, so model the tail as county-variable. CLOSED by the
  sweep: Supreme/Circuit placement (Kenton 2022 full chain);
  single-county corroboration (now 17 counties incl. Jefferson + Fayette
  via Common Crawl). Still open: no SBE directive for the top-of-ballot
  sequence (would upgrade the B leg); Kenton 2024 filing doc lists
  Circuit Clerk before Commonwealth's Attorney — filing-list artifact,
  NOT ballot order (explicitly not relied on).
  ODD-YEAR EXECUTIVES CLOSED (late child agent, 2026-08-16): five 2023
  general ballots —
  https://campbell.countyclerk.us/wp-content/uploads/2023/09/Campbell-2023G.pdf
  (text layer: "FOR THE GENERAL ELECTION, NOVEMBER 7, 2023"),
  https://rowan.countyclerk.us/wp-content/uploads/2023/09/Rowan-2023G.pdf,
  https://harrison.countyclerk.us/wp-content/uploads/2023/09/Harrison-2023G.pdf
  (all live, %PDF verified), plus Fayette + Kenton SOS copies recovered
  from Common Crawl (live URLs
  https://web.sos.ky.gov/ballots/Fayette%202023G.pdf and
  https://web.sos.ky.gov/ballots/Kenton%202023G.pdf now 404 — SOS purges
  to current cycle; retrieve by querying the Common Crawl index for those
  exact URLs in collection CC-MAIN-2024-10, then a Range request on
  data.commoncrawl.org — the recovering agent did not retain the WARC
  capture identifiers, so re-derive them from the index query; 291,980
  and 134,389 bytes, Kenton has a text layer) — print an IDENTICAL
  executive sequence: STRAIGHT PARTY → GOVERNOR and LIEUTENANT
  GOVERNOR (one combined contest, "Vote for One") → SECRETARY of STATE →
  ATTORNEY GENERAL → AUDITOR of PUBLIC ACCOUNTS → STATE TREASURER →
  COMMISSIONER of AGRICULTURE — then county/nonpartisan tails vary by
  county as usual (Fayette 2023 = general AND special election, State Rep
  93rd prints after the nonpartisan school block). Two more 2024 counties
  confirm the even-year skeleton — Bourbon
  (https://bourbon.countyclerk.us/wp-content/uploads/2024/10/Bourbon-2024G.pdf)
  + Campbell
  (https://campbell.countyclerk.us/wp-content/uploads/2024/10/Campbell-2024G.pdf);
  McCracken independently re-derived as a pipeline self-check
  (https://mccracken.countyclerk.us/wp-content/uploads/2024/10/McCracken-2024G.pdf). Child also reports
  — NOT re-verified against fetched reg text, treat as pointers:
  straight-party-first codified at 31 KAR 5:026 §1, and full-term vs
  unexpired-term grouping at KRS 118.115(5); if confirmed, the
  straight-party slot upgrades from practice to authority. Anti-
  fabrication note: the child's %PDF magic check caught a Wayback error
  page masquerading as Fayette 2023G before it could become a fake
  ballot.

### OR — Oregon (FIPS 41) — GRADE A
- Authority: contest order set by SECRETARY OF STATE DIRECTIVE, not statute.
  ORS 246.110 (SOS = chief elections officer) + ORS 246.120 ("A county clerk
  affected thereby shall comply with the directives or instructions").
  Operative documents: SOS Directive 2024-05 "Official Ballot Statements"
  (Sept 5, 2024; Nov 5 2024 general),
  https://records.sos.state.or.us/ORSOSWebDrawer/Record/12855764/File/document,
  and Directive 2022-06 (Sept 8, 2022; Nov 8 2022 general),
  https://records.sos.state.or.us/ORSOSWebDrawer/Record/12855756/File/document,
  and Directive 2020-3 (Sept 3, 2020; Nov 3 2020 general — scanned, no
  text layer, OCR'd two ways + page visually confirmed by the verify
  pass; signed Bev Clarno by Stephen N. Trout),
  https://records.sos.state.or.us/ORSOSWebDrawer/Record/12855744/File/document
  — each with a "BALLOT ARRANGEMENT" section. WebDrawer unlock: ORMS
  titles these "Certified Ballot" (not "Official Ballot Statements") and
  WebDrawer ID = 12855643 + N for record EPD/25/N; ORMS holds election
  directives only for 2020-2024 (EPD/25/98-121) — a 2018 directive
  appears never to have been published (domain-wide Wayback CDX: earliest
  "directive" URL = 2020; index-level evidence, replay was down). Supporting statutes: ORS
  254.145(7) (measures "printed after the list of candidates"), ORS
  254.125(2)(a) (contested judicial before unopposed), ORS 254.135
  (general-ballot contents), ORS 254.155 + OAR 165-010-0090 (random-alphabet
  name order), ORS 250.115 (state measure numbering), ORS 254.108 (local
  measure county-prefix numbers). All accessed 2026-08-16. Directives carry
  edition/cycle — re-pull per cycle.
- Office order — the directives are PER-CYCLE and list only offices up
  that cycle, so NO single directive carries the whole ladder (verify-pass
  correction: the earlier presentation merged both). Union across 2024-05
  / 2022-06 / real ballots: 1. Federal Office (2024-05 lists US President
  + US Representative, no Senator; 2022-06 lists US Senator + US
  Representative, no President; President → US Senator → US Rep confirmed
  on Lincoln County 2020) → 2. State Office (2022: Governor; 2024: SOS →
  Treasurer → AG) → 3. Legislative (State Senator → State Representative)
  → 4. County Office if partisan → 5. City Office if partisan →
  6. Nonpartisan Office: (a) state — BOLI in 2022, "None at this
  election" in 2024, (b) state judicial, (c) District Attorney (2024-05
  ONLY — 2022-06's tier 6 runs a-e with no DA rung), (d) nonpartisan
  county, (e) nonpartisan city, (f) special district → 7. Ranked Choice
  Voting (2024-05 only; separate card or alternate position, county
  discretion) → 8. Measures (2022-06 numbers Measures as tier 7).
  Governor after US House — baseline spine holds. BOLI (nonpartisan
  statewide) does NOT print with executives — it heads the nonpartisan
  block after all partisan offices.
- Judicial: nonpartisan block slot 6(b) — AFTER every partisan office and
  BOLI, BEFORE District Attorney, nonpartisan county/city, special
  districts. Hierarchy Supreme → Appeals → Tax → Circuit — sourcing
  refined twice by the verify pass: 2024-05 lists Supreme + Circuit only
  and 2022-06 lists Appeals + Circuit only, but the recovered GENERAL
  Directive 2020-3 lists Supreme AND Appeals together ("Contested Supreme
  Court (None at this election) / Uncontested Supreme Court / Contested
  Court of Appeals (None…) / Uncontested Court of Appeals / Contested
  Circuit…"), so Supreme-before-Appeals is general-directive text; only
  the TAX COURT rung still rests on the May-2024 primary directive
  2024-01. Supreme → Appeals → Circuit → DA also ballot-confirmed on
  Lincoln County 2020. Contested before uncontested within each court (directive
  + ORS 254.125(2)(a)) — scoped "for the same office type", so a
  contested Appeals race never rises above an uncontested Supreme one.
  "Incumbent" printed per ORS 254.135(3)(c).
- Measures: last. ORS 254.145(7). Internal order per directive: State →
  County → City → Multi-County Special District → Single-County Special
  District. State measures numbered (= ordered) by ORS 250.115(1):
  legislative constitutional amendments → legislative Acts referred →
  initiative/referendum petitions (ballots print "State Legislative
  Measures Referred…" before "State Initiative Measures…"). Local measures
  carry county prefix (ORS 254.108; Multnomah = 26-).
- County discretion: narrow — arrangement binding via ORS 246.120; each
  directive ends with a contact-us escape for "undue administrative or
  printing problems". Express county options: RCV contests (separate
  card/alternate position — Multnomah 2024 used a wholly separate Portland
  RCV card) and Precinct Committee Person (primaries).
- School/special: school districts, ESDs, community colleges, ordinary
  special districts = ORS 255.012 "districts" electing "in each
  odd-numbered year on the third Tuesday in May" (ORS 255.335(1)) — SCHOOL
  BOARDS ABSENT from November even-year ballots. Exceptions on the general:
  soil & water conservation districts (ORS 568.530(1), 568.560(10)) +
  urban flood safety & water quality districts — both in tier 6(f) after
  judicial and county/city, before measures. Community college / Metro
  MEASURES can ride November at the district rung.
- Corroboration: Multnomah 2024 general
  (https://multco-web7-psh-files-usw2.s3-us-west-2.amazonaws.com/s3fs-public/96-1-4101-1-S-NON-EN.pdf)
  — Federal → State (SOS/Treasurer/AG) → Legislative → Nonpartisan State
  Judiciary (contested Circuit Pos 38 with 5 candidates BEFORE uncontested
  Pos 20/21/33) → SWCD → flood district → state legislative measures
  115-117 → initiatives 118-119 → Portland measures 26-249..253; separate
  RCV card (multco.us/file/2801-1-rcv-non-en.pdf/download) with Portland
  Mayor/Auditor/Councilor, county commissioner after judiciary on regular
  card; Multnomah 2022 general
  (https://multco.us/file/4101-1-s-2022-11.pdf/download) — Governor under
  State Offices → BOLI under State Nonpartisan Office → judiciary (Appeals
  Pos 10/11, Circuit 3/8/37) → county → city → SWCD → measures
  state→county→city→Metro. Both PyMuPDF block-geometry extractions,
  curl+UA. Directive-vs-ballot match tier-for-tier both cycles; only
  cosmetic header variance (2022 folded legislators under State Offices
  label). SECOND COUNTY (verify pass): Marion County official Voters'
  Pamphlet composite sample ballots, 3 cycles — 2024
  (https://www.co.marion.or.us/CO/elections/Documents/VoterRegistrationNumbers/2024/FINAL%20November%205%202024%20General%20VP_REV2(ONLINEVER).pdf),
  2022 (.../Final%20-%20November%208th%2c%202022%20VP.pdf), 2020
  (.../Results/Documents/20201103/November%202020%20Final%20Voter%20Pamphlet.pdf)
  — top-level sequence stable all three: Federal → Statewide Partisan →
  Countywide Partisan → Statewide Nonpartisan (judges) → Countywide
  Nonpartisan (sheriff/clerk) → Cities (alphabetical, mayor before
  councilor) → Soil & Water → State Measures → Local Measures. Marion
  2020 CLOSES Supreme-vs-Appeals: "Judge of the Supreme Court Position 4"
  prints ABOVE "Judge of the Court of Appeals Position 9" in the same
  column. Marion 2020 also prints state measures grouped "Proposed by
  Legislative Assembly" (107-108) then "Proposed by Initiative Petition"
  (109-110) — ORS 250.115 order observed. CAVEAT: pamphlet composites,
  not printed precinct ballots (grouping/sequence authoritative, per-voter
  ballot is a subset); and Marion 2020's executive run printed SOS → AG →
  Treasurer vs the 2024 directive's SOS → Treasurer → AG — the internal
  executive order is per-cycle directive, never claim it fixed. THIRD
  COUNTY (verify pass, verifier re-derived both): Lincoln County 2024
  general
  (https://www.co.lincoln.or.us/DocumentCenter/View/5816/November-5-2024-General-Election-Sample-Ballot)
  — Federal → State (SOS → Treasurer → AG) → Legislative → Nonpartisan
  (Supreme Pos 1, 7) → Nonpartisan County (Commissioner, Sheriff) —
  directive 2024-05 tier-for-tier; Lincoln 2020 general (county voters'
  pamphlet .../View/284, sample ballot pp. 25-26) — President → US
  Senator → US Rep 5th (federal-tier order pinned) and Supreme Pos 4 →
  Appeals Pos 9 → Circuit 17th Pos 2 → District Attorney (judicial chain
  + DA rung on a real ballot) → nonpartisan county → 7 cities → SWCD → 3
  PUDs → state measures → local fire-district measure 21-198. Both
  curl+UA → PyMuPDF line-level, column edges from the x0 distribution
  (the 2020 ballot is FOUR columns — a 3-column split silently merges
  the federal and judicial columns).
- Baseline delta: SUBSTANTIAL — (1) judicial NOT late: prints before
  county/city/special-district contests (opposite of baseline tail);
  (2) county/city offices SPLIT around the judicial block by partisanship
  (partisan before, nonpartisan after — most OR county/city offices are
  nonpartisan, so they land after the judges); (3) BOLI leaves the
  statewide-executive block, heads nonpartisan section; (4) school boards
  absent from November entirely; (5) Governor-after-US-House and
  measures-last match baseline.
- Notes: all vote-by-mail. Name order = single statewide random alphabet
  per election (ORS 254.155), no precinct rotation (informational).
  Primary (one line): per-party nominating ballots + nonpartisan ballot +
  PCP tier. No-filer offices still print with write-in lines. Directive
  PDFs vanish from sos.oregon.gov (404) — recover via SOS WebDrawer
  records.sos.state.or.us. CLOSED by the verify pass: Supreme-vs-Appeals
  (Directive 2020-3 text + Lincoln 2020 ballot); multi-county
  corroboration (Multnomah + Marion + Lincoln, 2020/2022/2024); the 2020
  directive itself (found + OCR'd). Still open: no OAR arranges contests
  (165-010-0090 = name order only; full ch. 165 index not enumerable —
  ballot-design rule elsewhere not fully excluded); nonpartisan-county
  example lists in tier 6 are "such as the following" EXAMPLES whose
  internal order differs per cycle (2022: Clerk→Assessor→…; 2024: County
  Judge→JP→Sheriff→…) — never treat as a fixed sub-order; 2018 directive
  existence airtight only via Wayback replay or an SOS records request.

### OK — Oklahoma (FIPS 40) — GRADE A
- Authority: 26 O.S. § 6-105 (separate General Election ballot sections),
  § 6-106 (printing; "the officers in the order in which they are set out
  by the Constitution and statutes"; SEB Secretary sets off sections),
  § 6-103/-104 (state/county boards print "in the order they appear in the
  statutes"), § 6-113 (state-question wording), §§ 11-108/-109 (judicial
  ballots nonpartisan; retention wording), § 6-102 (unopposed candidates
  never printed), § 13A-103 (school = Feb/April cycle), § 3-101(B)(5)
  (November allowable for subdivision specials) — official complete-title
  PDF https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os26.pdf
  (curl+UA → PyMuPDF, accessed 2026-08-16). State-officer internal order
  from Okla. Const. art. VI § 1
  (https://oksenate.gov/sites/default/files/2022-05/oc6.pdf) + art. IX
  § 15 (Corporation Commission, .../oc9.pdf). No SEB admin rule prescribes
  contest order (OAC 230 ch. 25 = separate ballots/lot order/quantities;
  official host rules.ok.gov 403s — ch. 25 text via elaws mirror + SEB
  proposal PDFs, those claims capped B).
- Office order (AS PRINTED, 5 real ballots across 3 cycles): STRAIGHT
  PARTY VOTING → Electors for President/VP (presidential years) →
  STATEWIDE EXECUTIVES BEFORE US SENATE/HOUSE, in constitutional order:
  Governor → Lt Governor → Auditor & Inspector → AG → Treasurer →
  Superintendent of Public Instruction → Labor Commissioner → Insurance
  Commissioner → Corporation Commissioner → US Senator (full term) → US
  Senator (unexpired) → US Representative → State Senator → State
  Representative → county offices (DA sits in this statutory block,
  § 6-105(7) — not directly observed) → District/Associate District Judge
  (nonpartisan, contested) → appellate RETENTION block (Supreme → Criminal
  Appeals → Civil Appeals) → State Questions LAST. Secretary of State =
  appointed, never on ballot (art. VI § 1(B)). County questions,
  municipal, school, special districts = SEPARATE BALLOTS.
- Judicial: late block, split — contested district/associate district
  judge races after county offices, before appellate retention; retention
  Supreme → Criminal Appeals → Civil Appeals ("Shall [NAME] … be retained
  in Office?", § 11-109); all before State Questions. Civil Appeals =
  retention, not contested.
- Measures: numbered State Questions dead last on the state/federal
  ballot, ascending number (SQ 833 → 834 in 2024), § 6-113 wording. County
  questions = separate ballot at the biennial general (Lincoln 2024
  county EMS-district proposition ballot verified; OAC 230:25-3-3
  proposal text says county questions "shall not be printed on the state
  ballot for the biennial General Election" — recorded vs elaws mirror's
  space-permitting wording, both B-capped).
- County discretion: none over order — § 6-104 binds county boards to
  statutory order; SEB programs ballots centrally (MESA entry +
  state-generated proofs, OAC 230:25-3-3). Discretion = quantities +
  whether a county question needs its own ballot.
- School/special: school + technology-center board elections = February
  primary / April general (§ 13A-103(A)) — NO school races in November.
  November specials allowed (§ 3-101(B)(5)) but ride SEPARATE ballots
  (OAC 230:25-13-1.1; SEB Precinct Official Manual "Multiple Elections on
  Same Date" = multiple ballots per voter).
- Section banners (printed grey bands, Delaware + Woodward 2024/2020):
  STRAIGHT PARTY → PRESIDENTIAL → STATE OFFICERS → CONGRESSIONAL OFFICERS →
  LEGISLATIVE, DISTRICT, AND COUNTY OFFICERS → JUDICIAL RETENTION ("Vote
  separately on each justice or judge; they are not running against each
  other.") → STATE QUESTIONS. The STATE OFFICERS band precedes the
  CONGRESSIONAL OFFICERS band on every banner ballot — the exec-first
  finding is structural, not incidental. Full 9-executive internal order
  OBSERVED on Osage 2018 (text PDF, coordinates): Governor → Lt Governor →
  State Auditor & Inspector → AG → Treasurer → Superintendent → Labor →
  Insurance Commissioner → Corporation Commissioner — exactly the art. VI
  § 1 enumeration (SOS skipped, appointed).
- Corroboration: Lincoln County 2022 general
  (https://lincolncountyok.org/file/ballots_and_results/general_election_sample_ballot_pct._1_2_3_4_21_22_110822_ballot_33.pdf)
  — Governor → LtGov → AG → Treasurer → Supt → Labor → Corporation
  Commissioner → US Senator ×2 → US Rep 05 → State Senator 28 → County
  Commissioner D1 → DISTRICT JUDGE D23 Office 1 (no party labels) →
  Supreme + Civil Appeals retention; Lincoln 2024 state/federal
  (...general_election_state_federal_sample_ballot_ballot_78.pdf) —
  President → Corporation Commissioner → US Rep → 3-court retention → SQ
  833 → SQ 834; Lincoln 2024 COUNTY ballot
  (...lincoln_county_sample_ballot_11.5.24_ballot_77.pdf) — sole EMS
  proposition; Osage 2022 pcts 570108 + 570305
  (https://osage.okcounties.org/file/ballots_and_results/pct_108_ballot_344.pdf,
  .../pct_305_ballot_361.pdf) — same sequence independently; Osage 2020
  pct 570107 (.../pct_107_ballot_256.pdf) — President → Corporation
  Commissioner → US Senator → US Rep → retention → SQ 805 → SQ 814. All
  curl+UA → PyMuPDF. Zero conflicts across five ballots.
- Baseline delta: (1) statewide executives before US Senate/House
  (President still first); (2) judicial block split (contested trial after
  county; appellate retention after that) and BEFORE measures; (3) county
  questions/municipal/school/special = separate ballots, outside the
  sequence entirely; (4) straight-party control heads the ballot; (5)
  State Questions last matches baseline.
- Notes: the apparent statute-vs-print conflict DISSOLVES on verification
  (adversarial pass): § 6-105 is a SECTION INVENTORY, not a sequence —
  its own list puts "6. State questions" ahead of "7. State Senators …
  county officers," which no ballot does; the text says the ballot "shall
  contain a separate section for the following". § 6-103/-104 are
  duty-to-print provisions whose operative clause is "in the order they
  appear in the statutes" (§ 6-104 carries the clause with no enumeration
  at all). The LAYOUT provision is § 6-106, and it matches print exactly:
  "The name of the office entitled to the first place, preceded by the
  word 'for', shall appear in bold type, as 'For Governor'" — the
  statute's own first-place example is Governor, and both non-presidential
  ballots open with FOR GOVERNOR; officers named "in the order in which
  they are set out by the Constitution and statutes" (Constitution first
  = art. VI § 1 executive order); "sections … set off with well-defined
  lines or by other means as prescribed by the Secretary of the State
  Election Board" = the printed banners. So the authority chain is
  § 6-106 + art. VI § 1, corroborated 4 elections × 4 counties.
  Observation-only legs: the federal band's position relative to the
  state band (§ 6-106 doesn't sequence federal vs state) and presidential
  electors printing first in presidential years. Unopposed candidates
  omitted entirely (§ 6-102) — explains missing offices per cycle (Osage
  2018 supplies the full 9-exec run). General election: NO rotation —
  recognized parties in lot order as prescribed by the SEB Secretary,
  then unrecognized parties, then independents (§ 6-106); rotation only
  at primary/runoff (§ 6-109). Primary (one line): per-party colored
  ballots (§ 6-110); OAC 230:25-3-3 contains BOTH sentences consecutively
  — county question may ride the state ballot at PRIMARY/runoff "if there
  is adequate space" but "shall not be printed on the state ballot for
  the biennial General Election" (primary = space-permitting, general =
  flat ban; the earlier mirror-vs-proposal "conflict" was a misread).
  DA SLOT PINNED (verify-pass child): Delaware County June 2022 GOP
  primary ballot
  (https://delaware.okcounties.org/file/ballots_and_results/5_7_8_9_12_14_15_16_18_20_rep_ballot_101.pdf)
  prints FOR DISTRICT ATTORNEY DISTRICT 13 (contested) after State
  Senator + State Representative and before County Sheriff, inside the
  same "LEGISLATIVE, DISTRICT, AND COUNTY OFFICERS" banner the generals
  use — primary-cycle evidence, but the banner and grouping are verbatim
  identical on the Nov 2022 Delaware generals (which also show the whole
  section DROPPING OUT when nothing in it is contested, precincts
  1-2-3-5… ballot_107 — Oklahoma omits empty sections rather than
  printing empty tiers). Contested DA on a November general remains
  unobserved (only 2022 case = Oklahoma County, which publishes no
  ballot PDFs).
  Additional corroborators (child sweep): Delaware County 2024 (2 ballot
  styles incl. the legislative-band style,
  https://delaware.okcounties.org/file/ballots_and_results/1_2_3_4_5_6_7_8_9_12_14_15_16_18_19_20_21_22_23_ballot_135.pdf
  + .../19_22_23_ballot_134.pdf, scans read at 110 dpi), Woodward 2024 +
  2020 (.../sample_ballot_ballot_49.pdf,
  .../november_election_ballot_ballot_25.pdf), Osage 2020 pct 201 + 2018
  pct 101 text PDFs with coordinates
  (https://osage.okcounties.org/file/ballots_and_results/pct_201_ballot_263.pdf,
  .../pct_101_ballot_151.pdf; siblings verified) — 4 general elections
  (2018/2020/2022/2024) × 4 counties (Lincoln, Osage, Delaware, Woodward),
  zero conflicts. Osage 2018 supplies the
  once-missing Auditor + Insurance Commissioner positions (observed, not
  just constitutional inference). Open: DA slot unobserved (no contested
  DA on any of 13 ballots); Associate District Judge same-slot assumption
  untested; district-judge home = between county block and retention
  (Lincoln 2022 observed; 2024 banner wording "LEGISLATIVE, DISTRICT, AND
  COUNTY OFFICERS" is consistent but no judge race printed under it);
  OKC/Tulsa/Cleveland county boards publish no ballot PDFs (address-gated
  portal; Cleveland 2024 files purged, Wayback replay 503).

### CT — Connecticut (FIPS 09) — GRADE A
- Authority: Conn. Gen. Stat. § 9-251 "Order of office on ballots" (ch.
  147), https://www.cga.ct.gov/current/pub/chap_147.htm (accessed
  2026-08-16 — cga.ct.gov TLS chain broken; `curl -sk` works, r.jina.ai
  proxy also works). Supporting: § 9-249a (party row order), § 9-250 (form),
  § 9-249b (>9 rows / SOTS multi-column), § 9-242(a) (≥9 party capacity),
  § 9-3 (SOTS = Commissioner of Elections, written instructions
  presumptively correct), § 9-181 (Gov/LtGov single vote), § 9-164
  (municipal = odd-year), § 45a-18(a) (probate quadrennial 1974+4k).
  Currency verified: 2026 Supplement to ch. 147 touches only §§ 9-239,
  9-261, 9-264 — order sections unamended.
- Office order (GRID ballot — offices are COLUMNS left→right, parties are
  ROWS; § 9-251 verbatim, note the opening scope limiter): "In the
  preparation of ballots for use at a state election, precedence shall be
  given to the offices … in the following descending order: Presidential electors, Governor and
  Lieutenant Governor, United States senator, representative in Congress,
  state senator, state representative, Secretary of the State, Treasurer,
  Comptroller, Attorney General and judge of probate." GOV/LTGOV = COLUMN
  2, ABOVE US SENATE AND US HOUSE; the other four statewide executives
  (SOS, Treasurer, Comptroller, AG) sit BELOW state senate + state house —
  executive block split around the legislature. Gov/LtGov one column, one
  vote (§ 9-181). Registrar of Voters (not in § 9-251; elected at state
  elections, § 9-190a) prints as the final column after judge of probate.
  Municipal-election order: "as prescribed by the Secretary of the State
  … so far as practicable … uniform throughout the state" (no published
  SOTS list located).
- Judicial: Supreme/Superior/lower courts APPOINTED (Conn. Const. art. V
  §§ 2-3 — governor nominates, General Assembly appoints). Only JUDGE OF
  PROBATE elected (art. V § 4; § 45a-18(a) "at the state election in
  1974, and every four years thereafter") — QUADRENNIAL for REGULAR
  terms: on ballot 2022 + 2026, NOT 2024. Prints last among statutory
  offices, before registrar. VACANCY carve-out: vacancy contests can
  appear in any state-election year and OUT of § 9-251 sequence — SOTS
  places them by ad hoc directive (Plainville Nov 2025 probate-vacancy in
  column 1; Mansfield 2024 probate-vacancy AFTER registrar). JPs removed
  from § 9-251 by P.A. 74-109.
- Measures: NO placement statute — § 9-369 governs numbering only
  (municipal clerk numbers per appearance order; SOTS numbers
  constitutional amendments by resolution date); explanatory text goes on
  polling-place posters, not the ballot (§ 9-369b). Placement VARIES BY
  TOWN: right-hand panel (Bridgeport/Greenwich/West Hartford/New
  Haven/New Britain), full-width top band (Hartford/Norwalk/Danbury),
  hybrid (Waterbury 2024), back of ballot (Stamford 2024). This sub-leg =
  C-grade town discretion.
- County discretion: NO COUNTY TIER EXISTS — counties are geographic only
  since 1960 (OLR 2015-R-0274); § 9-1(i) municipality = city/borough/town;
  last county-ish office (sheriff) deleted from § 9-251 by P.A. 00-99
  (eff. Dec 2000). Order centrally prescribed (statute + SOTS); town
  discretion = question placement + charter variations in which offices
  are elected (§ 9-185).
- School/special: Board of Education = municipal office (§ 9-185(8)),
  municipal elections ODD-YEAR (§ 9-164(a)(1)(A)) — NO school contests in
  even-year November. Odd-year ballots confirm: Hartford Nov 2025 = BOE
  only; West Hartford Nov 2025 = Town Council (cols 1-6) then BOE (cols
  7-9) — school after town legislative body. Charter exception CONFIRMED
  (verify pass): Stamford Charter § C1-80-5(b) requires an ANNUAL BOE
  election ("Annually at the regular election to be held in Stamford on
  the Tuesday after the first Monday in November, three members of the
  Board of Education shall be elected for terms of three years", per
  S.A. No. 467 of 1951) — in even years that November election IS the
  state election, so 3 BOE seats print on the state ballot (Stamford 2024
  side 2 cols 7-9 "Vote for Three"; electionhistory.ct.gov shows the same
  Full Term contest in 2022). Statutory basis: § 9-203 savings clause
  ("shall not be construed to repeal or affect any special act relating
  to a town which elects the members of its board of education in a
  different manner or for different terms") + § 9-185's "Unless otherwise
  provided by special act or charter" opening. NOT a § 9-164 escape —
  § 9-164 permits only May-of-odd-years variance; Stamford's even-year
  BOE = municipal offices riding the STATE election. Charter fetched from
  library.municode.com (JS SPA — browser render + innerText; curl and
  r.jina.ai get empty shells).
- Corroboration: Bridgeport Nov 2022 amended ballot
  (https://portal.ct.gov/-/media/sots/electionservices/town_ballots/2022/bridgeport-amended-11322.pdf?rev=167e5310b60a452983aeacab1900fb8c&hash=E6CF5DB9F3C597828FD7EDA5C761C9DA,
  curl+UA → PyMuPDF coordinates, researcher-parsed): columns 1-11 =
  Governor and Lieutenant Governor | US Senator | Representative in
  Congress | State Senator | State Representative | Secretary of the
  State | Treasurer | Comptroller | Attorney General | Judge of Probate |
  Registrar of Voters — exact § 9-251 match + registrar appended; rows
  A-I, row I = WRITE-IN VOTES; question in right panel. 18 further
  ballots from the official SOTS town-ballot archive
  (https://portal.ct.gov/sots/election-services/town-ballots/ballots; 10 ×
  Nov 2024, 8 × Nov 2022 across Bridgeport/New Haven/Hartford/Stamford/
  Waterbury/Norwalk/Danbury/New Britain/West Hartford/Greenwich) all
  match — SUBAGENT-SOURCED with only the index URL retained (no
  per-ballot URLs; supporting only, the Bridgeport parse is the verified
  anchor); 2024 STATE-OFFICE BLOCK = 6 columns (Presidential Electors For
  | US Senator | US Rep | State Senator | State Rep | Registrar), with
  charter-driven town offices appended where they exist (Stamford 2024
  BOE cols 7-9); no "PROBATE" string in any of the 10 SAMPLED 2024 PDFs —
  regular quadrennial cycle confirmed (Mansfield 2024 carried a probate
  VACANCY contest, see Judicial).
- Baseline delta: SUBSTANTIAL — (1) Gov/LtGov above US Senate/House;
  (2) SOS/Treasurer/Comptroller/AG below the legislature (executive split);
  (3) no county tier; (4) judicial = single probate column (last statutory
  office), no supreme→appeals→trial block; (5) measures not reliably last
  (town placement, incl. back of ballot); (6) Registrar of Voters after
  the judicial slot; (7) no municipal/school/local offices in even-year
  November (charter exceptions aside).
- Notes: cells labeled column-number + row-letter (1A, 2A…); write-in
  always bottom row; § 9-242(a) nine-party capacity. Party row order
  (one line, § 9-249a): top gubernatorial vote-getter's party first row,
  descending, then minors, then petitioning. Ballots bilingual EN/ES in
  sampled towns. Nov 2026 = gubernatorial AND probate year → the 2022
  Bridgeport 11-column structure is the correct template, not 2024.
  Follow-up sweep (child agent) closed several legs: RCSA 9-242a ALL 28
  sections harvested (eregulations.ct.gov JS shell but full text sits in a
  `var jsonData` blob — plain curl+UA works; r.jina.ai Cloudflare-403s
  there) — nothing on office order; Sec. 9-242a-4 puts printing "in
  accordance with the ballot layout established by the municipal clerk"
  (SOTS-approved). Registrar-last CONFIRMED twice over: SOTS form ED-101
  ("Offices to be Filled at a State Election", § 9-254 instrument,
  https://portal.ct.gov/-/media/sots/electionservices/lead_communications/2014/032014ed101officestobefilledatstateelectionpdf.pdf)
  lists Registrars of Voters after Judge of Probate, and 4 towns' 2022
  ballots print the identical 11-column order. VACANCY WRINKLE: SOTS
  places vacancy offices by ad hoc directive (ROVAC 2024 manual p.100 —
  private association source; corroborated: Plainville Nov 2025 put
  "Judge of Probate / To Fill a Vacancy" in column 1; Mansfield 2024 put
  a probate vacancy AFTER registrar) — vacancy contests can break the
  § 9-251 order. Question sub-rules that ARE stable: statewide
  constitutional amendment always Question 1 ahead of local questions;
  questions always on the office face (reverse = instructions). For state
  elections SOTS transmits binding "town grids" ("exactly as it appears
  on the enclosed list, with no variations" — 2016 Merrill letter); no
  municipal counterpart exists in the LEAD archive (263 items enumerated;
  2015 municipal year has no grid letter). Municipal order = § 9-254
  ED-102 returned-list mechanism, NOT public (form irretrievable; soft-404
  everywhere); de facto municipal shape from 30 Nov-2025 ballots
  (Mayor/First Selectman → Selectmen → Town Clerk → Treasurer → Tax
  Collector → Bd of Finance → Bd of Education → BAA → P&Z → ZBA →
  Regional BOE → Constables) but the legislative-body slot MOVES by town
  (Danbury/Stamford/Newington differ) — never model as fixed. Registrar
  variance CLOSED (verify pass): § 9-185's "Unless otherwise provided by
  special act or charter" is the mechanism — towns with charter/special
  acts appoint instead of elect, echoed by § 9-190 ("in each municipality
  in which registrars of voters are elected"), § 9-190a, and ED-101's
  "*Cross out if not elected" footnote. Stamford 2024 BOE mechanism
  CLOSED — see School/special.

### UT — Utah (FIPS 49) — GRADE A
- Authority: Utah Code § 20A-6-110(6)-(7) "Master ballot position list … —
  Ballot order" (current text, amended by Ch. 329, 2026 Gen. Sess.),
  https://le.utah.gov/xcode/Title20A/Chapter6/C20A-6_1800010118000101.pdf
  (accessed 2026-08-16); identical ladder in force for Nov 2024 as
  § 20A-6-305(6) + (7)(a)-(b) (effective 5/12/2020, renumbered 5/7/2025 —
  subsection (6) byte-identical; the 2020 text LACKS current (7)(c)
  (joint Gov/LtGov ticket) and (7)(d) (joint Pres/VP ticket), so the
  joint-ticket cites are current-law only,
  https://le.utah.gov/xcode/Title20A/Chapter6/C20A-6-S305_2020051220200512.pdf).
  Supporting: § 20A-6-107 (proposition/amendment headings + LG-assigned
  sequential numbering), § 20A-6-301/-304 (manual/mechanical ballots;
  nonpartisan + propositions after the candidate list), § 20A-12-201(3)(b),
  (4) (retention in nonpartisan section + judges.utah.gov statement),
  § 20A-14-104.1(2) (SBOE partisan), § 17B-1-306(7)(b)(i) (special
  districts in nonpartisan section). All from official le.utah.gov PDF
  endpoints (HTML routes are JS shells), curl+UA → pypdf.
- Office order (§ 20A-6-110(6), "each ticket … shall appear separately, in
  the following order"): federal (President/VP → US Senate → US House) →
  state (Governor and Lt Governor as single joint ticket → AG → State
  Auditor → State Treasurer → State Senate → State House → State Board of
  Education member) → county (executive → legislative body → assessor →
  county/district attorney → auditor → clerk → recorder → sheriff →
  surveyor → treasurer → LOCAL SCHOOL BOARD member) → municipal (mayor →
  council) → elected planning & service district council member → judicial
  retention questions → ballot propositions. Governor immediately after US
  House. No Secretary of State exists (LG runs elections); no separate LG
  contest (§ 20A-6-110(7)(c)). Combined offices take the earliest subsumed
  position (§ 20A-6-110(7)(a)).
- Judicial: ALL judges = unopposed retention questions, tier (f) — after
  every candidate contest incl. local school board, before propositions.
  "In the nonpartisan section of the ballot" (§ 20A-12-201(3)(b)(i)) with
  mandatory judges.utah.gov statement (§ 20A-12-201(4)(a)(i)). Exempt from
  the randomized master-list ordering (§ 20A-6-110(5)(b)). Court order NOT
  prescribed — 2024 practice, by county: Salt Lake printed Supreme →
  Appeals → District → Juvenile (no Justice Court questions on that
  style); Utah County printed District → Juvenile → Justice Court
  (high-to-low consistent, but no single ballot shows the full chain).
- Measures: last, tier (g). "Constitutional Amendment ___" (letter) vs
  "Proposition #___" (number); numbers assigned sequentially statewide by
  the LG (§ 20A-6-107(2)(b)(ii) — hence Utah County's gappy #5/#9/#10/#11/
  #13/#14). INTERNAL ORDER NOT PRESCRIBED and counties disagree: Utah
  County printed Amendments A-D then local propositions; Salt Lake printed
  county proposition + bond FIRST, Amendments A-D LAST. Recorded both ways.
- County discretion: minimal on office order (mandatory list). Real
  discretion: combined-office collapse, mechanical ballots "approximately"
  the manual order (§ 20A-6-304(1)(a)), device layout (§ 20A-6-102(3)),
  and the unlegislated measures sub-order. All-mail state
  (§ 20A-3a-202(1)(a)).
- School/special: SBOE = partisan, LAST IN STATE BLOCK (after State House)
  — not a late school tier. Local school board = last in COUNTY block,
  before municipal, printed without party. Special district trustees = "in
  the nonpartisan section" (§ 17B-1-306(7)(b)(i)) with no numbered tier;
  distinct tier (e) only for planning & service district councils.
- Corroboration: Salt Lake County 2024 general official ballot type 1
  (proof watermark 2024-09-17; two sheets:
  https://www.saltlakecounty.gov/globalassets/1-site-files/clerk/elections/2024-general-election/24g-ballots/ballot-type-1---english---page-1-of-2.pdf
  + …page-2-of-2.pdf) — FEDERAL → STATE (Gov/LtGov → AG → Auditor →
  Treasurer → State House 41 → State School Board 7) → COUNTY (Mayor →
  Council At-Large C → Council D6 → Assessor → Recorder → Surveyor →
  Treasurer) → SCHOOL BOARD (Canyons D3) → JUDICIAL RETENTION (statement +
  Supreme → Appeals → District → Juvenile) → countywide propositions →
  Constitutional Amendments A-D; Utah County 2024 general sample
  (https://vote.utahcounty.gov/cms/uploads/2024_General_Sample_Ballot_22344cdbf0.pdf;
  5-page variant independently at https://www.utah.gov/pmn/files/1175207.pdf)
  — same federal/state sequence, school boards closing the county block,
  retention, then Amendments A-D → Propositions. Method correction
  (verify pass): the Salt Lake PDFs carry a full text layer (readable
  directly); only the Utah County PDF is imageless — rendered at 150-400
  dpi and read as images. No office-order conflicts.
- Baseline delta: (1) SBOE inside the state PARTISAN block after State
  House — not a school tier; (2) local school board at END of county
  block, BEFORE municipal (baseline: school after municipal); (3) planning
  & service district tier between municipal and judicial; (4) judicial =
  single retention block after ALL candidate contests (no competitive
  judges); (5) measures last matches baseline but internal order
  county-variable.
- Notes: name order = statewide randomized alphabet drawn by the LG each
  even year (§ 20A-6-110(1)-(4)); no precinct rotation; single-candidate
  races + retention exempt — informational. Primaries use the same
  ordering (§ 20A-6-203(1)(b)). Municipal tier dormant in even-year
  generals (odd-year municipal elections) — statutory position unconfirmed
  by ballot. Utah County sample prints "County Surveyor" header twice
  (county document typo, verified at 400 dpi — the duplicate header sits
  over the TREASURER candidate). Admin-rule negative CLOSED (verify
  pass): R623-9 "Ballot Printing, Handling, and Envelope Standards"
  fetched in full via
  https://r.jina.ai/https://adminrules.utah.gov/public/rule/R623-9/Current%20Rules
  (plain curl 404s — JS shell; proxy renders it; last changed 2025-10-23,
  authorized by §§ 20A-6-108, 20A-3a-106) — covers vendor facility
  security, chain of custody, mailing/IMb, envelope standards; ZERO
  contest-order provisions. 2027: § 20A-6-301(5) removes clerk's name
  from masthead (no order impact).

## Batch 4

### IA — Iowa (FIPS 19) — GRADE A

- Authority: Iowa Admin. Code r. 721—21.203(49,52) "Form of general election
  ballot," subrule 21.203(3) "Office titles, order of offices and public
  measures" ("The order of offices and public measures listed on the general
  election ballot shall be as follows") —
  https://www.legis.iowa.gov/docs/iac/rule/721.21.203.pdf (accessed
  2026-08-16; IAC edition 11/12/25, chapter rescission date 1/1/28 per
  https://www.legis.iowa.gov/docs/iac/chapter/721.21.pdf). Enabling
  statutes: Iowa Code §49.57A (SOS "shall adopt rules in accordance with
  chapter 17A to implement sections 49.30 through 49.41, section 49.57, and
  any other provision of the law prescribing the form of the official
  ballot"), §49.37 (arrangement; four-way grouping), §49.30 (single ballot
  default; subsections (2)-(3) order political-subdivision offices AND
  measures county → city → school district → merged area → other), §49.43
  (measures), §46.21 (judicial ballot form), §39.17 (county office
  sequence) — all six served per-section at
  https://www.legis.iowa.gov/docs/code/49.57A.pdf (substitute the section
  number; all six URLs fetched + %PDF-verified 2026-08-17, Iowa Code 2026
  edition, §49.57A text matches the quote above verbatim).
- Office order: rule prescribes TWO cycle-specific sequences.
  Gubernatorial years (21.203(3)"a"): US Senator (if any) → US Rep →
  Governor and Lt. Governor (one team line) → SOS → Auditor of State →
  Treasurer of State → Secretary of Agriculture → Attorney General → State
  Senator (if any) → State Rep → Board of Supervisors → County Treasurer →
  County Recorder → County Attorney → Township Trustee → Township Clerk →
  County Public Hospital Trustee → Soil & Water Commissioner → County Ag
  Extension Council → other nonpartisan → judges → public measures.
  Presidential years (21.203(3)"b"): President → US Senator (if any) → US
  Rep → State Senator → State Rep → Supervisors → County Auditor → County
  Sheriff → township/nonpartisan tier → judges → measures (statewide
  executives structurally ABSENT — all elected in gubernatorial years).
  Governor sits AFTER US House. Executive internal order = Gov/LtGov → SOS
  → Auditor → Treasurer → Ag Secretary → AG. §49.37(2): "Partisan offices,
  nonpartisan offices, judges, and public measures shall be separated by a
  distinct line appearing on the ballot." Vacancy contests print after the
  regular contest for the same office (21.203(3)"c").
- Judicial: retention only (merit selection — no contested judicial races).
  Late block after all offices, before measures, as a conspicuously
  separated "Judicial Ballot" section (r. 721—21.203(8): "The judicial
  ballot shall be separate from the rest of the ballot and shall be
  conspicuously distinguished by headings and lines"; Iowa Code §46.21
  "STATE OF IOWA JUDICIAL BALLOT" form). Internal order: Supreme Court →
  Court of Appeals → District → District Associate → Assoc. Juvenile →
  Assoc. Probate. In practice a separately-headed section on the ballot
  reverse, not a separate sheet (all 4 samples).
- Measures: LAST, after judges, "Public Measures" heading, sub-order
  Constitutional Amendment → State Public Measure → County Public Measure →
  City Public Measure (21.203(3)"a"(27)/"b"(21)). Statewide numbered by
  SOS; local lettered by county commissioner (r. 721—21.200).
- County discretion: partial — narrow. Office sequence mandatory ("shall be
  as follows"). Auditors control: local-measure letter order (721—21.200(2));
  physical-ballot splits when content won't fit (§49.30(1)); candidate order
  within an office only by statutory formula (party rotation §49.31(1)"b",
  nonpartisan lot-draw §49.31(2)"c").
- School/special: municipal + school OFFICE tiers structurally EMPTY at
  November even-year generals — school elections are November ODD years
  (§277.1), city elections November odd years (§376.1), and §39.2(2) bars
  city/school specials from coinciding with the general. The nonpartisan
  special tier that DOES print: township trustee/clerk, county public
  hospital trustee, soil & water commissioner, county ag extension council
  (§39.21). Bond MEASURES may still appear via §39.2(4)"d" — but its text
  reaches "any political subdivision" (school/merged-area bonds too),
  which COLLIDES with §39.2(2)'s bar on city/school/merged-area specials
  coinciding with the general; conflict recorded unresolved — likely why
  no sample ever carried a city public measure.
- Corroboration: 6 samples across 5 counties, all %PDF-verified. Black Hawk
  2022 (Mt. Vernon
  Twp style 38,
  https://blackhawkcountyelections.iowa.gov/files/sample_ballots/20221108_mt_vernon_township_95420.pdf)
  — full gubernatorial-year sequence incl. exact executive order. Polk 2024
  (Ankeny 1, https://www.polkcountyiowa.gov/media/evnpb420/ankeny-1.pdf) —
  presidential-year sequence, judicial + amendments on back. Black Hawk 2024
  (style 10, Black Hawk Township,
  https://blackhawkcountyelections.iowa.gov/files/sample_ballots/20241105_ballot_style_10_black_hawk_township_30271.pdf
  — URL recovered via /elections/info/2024_general_election_2024_11_05/,
  re-fetched + %PDF-verified 2026-08-17) — township tier + vacancy rule.
  Scott 2024 (Ag Township style 2,
  https://elections.scottcountyiowa.gov/files/sample_ballots/20241105_ag_township_style_2_55282.pdf
  — URL recovered via /elections/info/general_election_2024_11_05/,
  re-fetched + %PDF-verified 2026-08-17) — third-county replication.
  Johnson 2022 (precinct IC05,
  https://johnsoncountyiowa.gov/sites/default/files/Elections/2022GeneralElectionSampleBallotIC05.pdf)
  — gubernatorial sequence replicated incl. State Senator directly after AG.
  Greene 2022 (Jefferson 2,
  https://www.greenecounty.iowa.gov/files/documents/2022J21744041853100422PM.pdf)
  — CLOSES the measure sub-order question: Constitutional Amendment 1 prints
  BEFORE "County of Greene Public Measure C" (jail bond), matching
  21.203(3)"a"(27); also shows hospital-trustee slot.
- Baseline delta: override needed. (1) municipal + school tiers EMPTY at
  even-year generals; (2) township + nonpartisan special-district tier
  between county and judicial; (3) judicial = retention-only late block
  (baseline late-block position itself matches); (4) measures sub-order
  amendment → state → county → city; (5) executive block gubernatorial-years
  only; county offices cycle-split (presidential = Auditor + Sheriff;
  gubernatorial = Treasurer + Recorder + County Attorney).
- Notes: Gov/LtGov = single team line ("Vote for no more than one team,"
  21.203(4)). Primary order differs (721—21.202(3): no President, Governor
  alone, ends at county tier — no nonpartisan/judges/measures). Mild
  tension: 21.203(8) "separate … ballot" vs §49.30(1) single-ballot default
  — every sample resolves as separate SECTION on the same sheet; both texts
  recorded. Printed banner WORDING varies by county (verify pass): Black
  Hawk/Johnson print "Federal Offices / State Offices / County Offices /
  Nonpartisan Offices"; Polk 2024 prints exactly two banners — "PARTISAN
  OFFICES" and "NON-PARTISAN OFFICES"; order unaffected. §46.21's form
  also carries a clerk-of-district-court retention line (never printed in
  any sample). Open
  (authority-only, not sample-tested): CITY measure slot (amendment→county
  sub-order closed by Greene 2022; no sample carried a city measure);
  "other nonpartisan offices" catch-all slot never populated in samples.

### NV — Nevada (FIPS 32) — GRADE A

- Authority: NRS 293.268 "Order of listing offices, candidates and
  questions on ballots" ("must be printed on ballots in the following
  order") — https://www.leg.state.nv.us/NRS/NRS-293.html (official
  Legislature host, accessed 2026-08-16). Supporting: NRS 293.250(2) (SOS
  owns placement; clerks only "prepare appropriate ballot forms"),
  293.195 (nonpartisan-office list), 293.267(5), 293.269, 293.270(2),
  293C.262; NAC ch. 293 has NO order rule (grepped).
- Office order: statutory 12-tier ladder. (1) President → (2) US Senator
  then US Rep "in that sequence" → (3) Governor, LtGov, SOS, Treasurer,
  Controller, AG "in that sequence" (Treasurer + Controller BEFORE AG) →
  (4) state senate + assembly → (5) county/township PARTISAN → (6)
  statewide nonpartisan → (7) district nonpartisan → (8) county
  nonpartisan → (9) city (Mayor → council by ward → municipal judges) →
  (10) township nonpartisan → (11) statewide questions (advisory last
  within group) → (12) local/special-district questions (advisory last).
- Judicial: NOT a late block — distributed by geographic scope, EARLY.
  Supreme Court + Court of Appeals = tier 6, District Court (incl. Family
  Div) = tier 7 — both BEFORE county nonpartisan/school/municipal.
  Municipal judges tier 9(c); JPs tier 10 (last of all offices). No
  retention — all contested nonpartisan (Nev. Const. art. 6 §§ 3, 3A(2),
  5). No segregated nonpartisan section; interleave is by scope.
- Measures: LAST. Statewide (tier 11) before local (tier 12); advisory
  questions trail within each group; legislative alternative prints
  BEFORE a rejected-initiative measure (NRS 293.267(5)).
- County discretion: none over order — 293.268 mandatory + 293.250(2)
  reserves placement to SOS. (293C.262(2)(a) city-clerk two-sheet split =
  layout, not order.)
- School/special: school trustees = county nonpartisan tier 8 (NRS
  293.195; Clark 2024 CCSD trustees open the tier); Regents + State Board
  of Education = tier 7 by district, BEFORE school board; county-scoped
  special districts (water/power) tier 8; county SHERIFF nonpartisan (NRS
  293.195) → tier 8 not the partisan band (statute-derived — see Notes).
- Corroboration: Clark 2024 official "in order of appearance on the
  ballot" contest list
  (https://www.clarkcountynv.gov/adobe/assets/urn:aaid:aem:64d1b48e-07cd-432d-90ca-32c470ac8985/original/as/officesup-24g.pdf,
  banner y-coordinates re-extracted via PyMuPDF) — tiers 1,2,4,5,6,7,8,
  9,10 in exact statutory sequence; questions booklet
  (all-quests-24g.pdf) = State Q1-7 then Boulder City → Henderson →
  Henderson Library District. Clark 2022 (contests-candidates-22g.pdf) —
  confirms tier 3: Governor → LtGov → SOS → Treasurer → Controller → AG
  after US House. Both linked from Clark's official 24g-info index; Clark
  services page restates the rule + NOTC office list. Child-agent
  additions (own provenance, re-verified artifacts): Clark 2024 Dominion
  CVR export (24G_CVRExport_NOV_Final_Confidential.zip, ZIP local-header +
  range-inflate read) — 100-contest machine ballot definition matching
  the SOV report set contest-for-contest and officesup-24g 90/90;
  questions DEAD LAST positions 91-100 (State Q1-7 → Boulder City →
  Henderson → Henderson Library); NOTC on exactly 5 contests, verified
  two independent ways. NOTE: officesup-24g.pdf contains ZERO questions
  (candidate list only) — question placement rests on CVR + SOV + Nye.
  SECOND COUNTY: Nye 2024 printed sample booklet (precincts 24/28/31,
  https://www.nyecountynv.gov/DocumentCenter/View/47456/Sample-Ballot---Precincts-24-28-31-PDF)
  — printed banners FEDERAL PARTISAN → FEDERAL DISTRICT PARTISAN → STATE
  DISTRICT PARTISAN → STATE NONPARTISAN (Supreme Seats C/F/G) → COUNTY
  DISTRICT NONPARTISAN (school board) → STATE BALLOT QUESTIONS 1-7 →
  COUNTY BALLOT QUESTIONS; NOTC only on Pres/US Sen/Supreme seats. THIRD
  COUNTY: Washoe — official 2024 canvass (Election Summary Report,
  https://www.washoecounty.gov/voters/results/resultsfiles/2024generalresults.pdf)
  + CVR export (2024generalcvr.csv), identical 40-contest sequence, every
  tier holds; 2022/2020/2018 canvasses fill the gaps: Court of Appeals =
  tier 6 directly after Supreme Court (2022 #31-33); District Court incl.
  Family = tier 7 first item (2020); SHERIFF = tier 8 county nonpartisan
  CONFIRMED (2022 #43, party NP, after the improvement districts — closes
  the sheriff question); constable 2018 print (#29 after County
  Treasurer) = PRE-SB-462 partisan placement, superseded — see delta (3);
  municipal sub-order Mayor → Council → Municipal Judge, Reno before
  Sparks (2022). All %PDF-verified.
- Baseline delta: override required (large). (1) judicial EARLY —
  Supreme/Appeals + District before county-nonpartisan/school/municipal;
  (2) school after judicial, before municipal (baseline has municipal →
  school → judicial); (3) JPs + constables (tier 10, township
  NONPARTISAN) last of offices after city — constables were made
  nonpartisan by SB 462 (2019 Stats. ch. 271, phased by term); Washoe
  2018's constable-after-County-Treasurer print is PRE-amendment and
  stale; Clark 2022 prints constables under "TOWNSHIP OFFICES (ALL
  NONPARTISAN)" before the JPs; (4) county tier SPLIT by the judicial
  block (partisan tier 5 vs nonpartisan tier 8, sheriff in 8); (5)
  executive internal order Treasurer + Controller before AG; (6)
  Regents/SBOE tier 7 ahead of school board; (7) measures last matches.
- Notes: "None of These Candidates" (NRS 293.269) only on President +
  statewide offices (Clark 2024: exactly 5 contests — Pres, US Senate,
  Supreme Court Seats C/F/G); statutory tension recorded: NRS 293.1105
  (2019) defines "statewide office" as elected STATE office, excluding US
  Senate, yet 293.269 (1975) is applied to US Senate in practice — never
  conformed. No write-ins anywhere (293.270(2)). Clark merges tiers 6+7
  under one "STATE AND DISTRICT NONPARTISAN OFFICES" banner — label
  merge, internal sequence intact. City elections moved to even years →
  municipal rides the general. Washoe 2022 NOTC = 12 contests (US Senate
  + six constitutional officers + 2 Supreme + 3 Court of Appeals).
  Statute-only still: advisory-question ordering (none in any cycle
  checked). OBSERVED DEVIATIONS (recorded, unexplained): Washoe 2024
  printed Reno wards 1, 5, 6, 3 — violates NRS 293.268(9)(b) numerical
  order (2020/2022 were numerical; canvass + CVR agree); Washoe 2022
  printed North Lake Tahoe Fire Protection District (tier 7) AFTER
  County Sheriff (tier 8). Clark's 2022 contest doc genuinely has NO
  sheriff row (verify pass: 0 occurrences over 13pp) — cause is NRS
  293.260(5)(b): a nonpartisan candidate with a primary majority "must
  be declared elected … and his or her name must not be placed on the
  ballot for the general election" (McMahill ~58% June 2022); Clark's
  2026 Candidate Guide (cg26.pdf) prints Sheriff | McMahill | NP as the
  LAST row of COUNTY NONPARTISAN OFFICES before CITY OFFICES — second
  county on the sheriff slot. Both print wobbles are below our tier
  granularity except ward order, which we don't encode. AJR 8 (2025)
  would move judges to appointment — needs 2027 Legislature + 2028
  ratification, no effect on 2026. Verify caveat: the Clark CVR/SOV
  100-contest leg rests on the child agent's own quoted provenance (V1
  did not re-derive the 81MB ZIP). NV SOS Elections Procedures Manual
  unread (Incapsula-walled; NRS 293.268 self-executing so not needed).
  Fetch: leg.state.nv.us fine w/ browser-UA curl; nvsos.gov =
  Incapsula-walled even via r.jina.ai; Clark sample facsimiles are
  login-gated — the public "order of appearance" composites substitute;
  Washoe publishes NO static sample ballot for Nov 2024 (OmniBallot
  per-voter app, api.omniballot.us 401; Common Crawl holds only the 2022
  + June-2024-primary books, 1MB-truncated) — a second hunter confirmed
  the same 40-contest order from CVR + canvass independently; both
  Washoe artifacts are ballot-DEFINITION order, not ink-on-paper scans
  (stated caveat).

### AR — Arkansas (FIPS 05) — GRADE C

- Authority: NO statute or rule prescribes contest/office order. A.C.A.
  § 7-5-208 fixes only ballot FORM (heading, perpendicular name column,
  FOR/AGAINST layout); § 7-5-207(c)(1) fixes only candidate order within a
  race (by lot, county board). Primary of record = SOS-published "Election
  Laws of Arkansas … 2025 Edition,"
  https://www.sos.arkansas.gov/uploads/elections/Arkansas_Election_Laws_and_Constitution_2025_Edition.pdf
  (accessed 2026-08-16; grep for order phrases = zero office-order hits).
  SBEC rule list has no ballot-form/order rule
  (https://sbec.arkansas.gov/rules/). What IS law: measure numbering
  § 7-9-117(c); judicial/prosecutor/school timing § 7-10-102; unopposed
  omission § 7-5-207(a)(2).
- Office order: county-set. Common spine: President → US House →
  statewide executives → State Senate → State House → county/township →
  municipal → school (pre-2025) → measures — but the judicial-runoff,
  unopposed, and local-question blocks land in DIFFERENT places per
  county (the Pulaski order is NOT common to both — verify-pass
  correction; see conflicts table in Notes). Governor AFTER US House.
  Benton 2022 executive order: Governor → LtGov → AG → SOS → State
  Treasurer → Auditor → Land Commissioner — NOT the art. 6 § 1
  constitutional order (ballot swaps AG forward). Benton also prints a
  NWACC community-college trustee tier after school, before Issues.
- Judicial: Supreme Court, Court of Appeals, circuit, district judges +
  prosecuting attorneys + school board = nonpartisan; their GENERAL is the
  March preferential-primary date (§ 7-10-102(b)(1)). November carries
  RUNOFFS only, "on the same ballots as used for the November general
  elections" (§ 7-10-102(c)(3)). Runoff-block position is county-chosen:
  Benton 2022 between county and municipal; Pulaski 2024 after
  municipal/school, before issues. No retention elections in Arkansas.
- Measures: statewide issues numbered "Issue 1…N" in statutory internal
  order — (A) GA-proposed amendments → (B) initiated amendments → (C)
  initiated acts → (D) referred acts → (E) GA-referred questions → (F)
  other (§ 7-9-117(c)(2)); local measures "[p]laced separate and apart …
  from the ballot titles of statewide measures" (§ 7-9-117(c)(3)). NOTHING
  places measures before/after offices. Both samples print statewide
  issues last; they DIVERGE on local questions (Benton inlines city
  questions in municipal blocks; Pulaski prints them after statewide
  issues).
- County discretion: FULL as to contest order — §§ 7-5-207(a)(1)/208(a) put
  production in the county board; SBEC 2026 Election Coordinator Manual
  p. 50: "The CBEC is responsible for the accurate layout of each ballot."
  Samples diverge on judicial-block, unopposed-block, local-question
  positions = direct evidence.
- School/special: Act 503 of 2025 → even-year school election on the
  preferential-primary date (§ 6-14-102(a)(1)(A)(i)); school-board
  RUNOFFS move to November (Act 503 also amended § 7-10-102, § 17).
  Pre-Act-503 board policy could pick the general — explains Pulaski
  2024's three school millages + LRSD Zone 4 runoff. 2026+: EXPECT no
  regular school contests in November — softened (verify pass):
  § 6-14-110(j)(2) still references "school elections held concurrently
  with a general election" in even years, a residual statutory path.
  Township Constable tier prints with/near the county JP tier.
- Corroboration: Benton 2022 county-produced composite sample ("FOR
  CLERK", nwahomepage.com mirror of county-authored PDF — county host
  403s:
  https://www.nwahomepage.com/wp-content/uploads/sites/90/2022/10/Benton-County-2022-GENERAL-ELECTION-SAMPLE-FOR-CLERK.pdf)
  — full face order incl. UNOPPOSED OFFICES block + executive chain.
  Pulaski 2024 official Unofficial-Summary-Results
  (https://votepulaskiar.gov/wp-content/uploads/Unofficial-Summary-Results.pdf)
  + county Notice of Election
  (https://votepulaskiar.gov/wp-content/uploads/11052024_Notice-of-Election_v2.pdf,
  "NAMES WILL APPEAR IN BALLOT POSITION ORDER"). All %PDF-verified.
- Baseline delta: none encodable — C, baseline stays. Safe to note for
  other features (NOT rank overrides): judicial/prosecutor/school absent
  from November except runoffs; unopposed non-exempt candidates absent
  entirely (§ 7-5-207(a)(2), exceptions Governor/mayor/circuit
  clerk/nonjudicial state officials print separately); statewide measures
  numbered per § 7-9-117(c)(2); write-ins abolished (Act 305 of 2023).
- Notes: C because office order has no authority + samples conflict on
  FOUR block positions (verify pass added the 4th): judicial-runoff
  (Benton after county measures/before municipal vs Pulaski after
  school/before issues), unopposed block (Benton after State Rep vs
  Pulaski after JP), local questions (Benton inlined per tier vs Pulaski
  all last), county measures (Benton directly after county JP block vs
  Pulaski dead last). Verify pass also confirmed the negative sweep
  independently (whole-compilation "in the following order" hits =
  measure numbering + a commission register only; NO SBEC-listed rule
  governs contest order — the sbec.arkansas.gov/rules/ index, read
  directly 2026-08-16, lists ~14 rules (training, procedure, voter-reg,
  7 CAR 90/91/92 etc.) and none touches ballot layout or office
  sequence, superseding an earlier verify-round note that counted "one
  rule, Vote Centers" off a narrower SOS-filings view; 2026 CBEC
  Manual = name-draw + measure formats only). Judicial-timing, measure-numbering,
  school-timing legs are individually A-quality. Aggregate "UNOPPOSED
  OFFICES — vote for all" pseudo-contest prints mid-ballot (position
  varies); Benton's on-ballot unopposed-exception list ADDS "City Clerk
  or Recorder/Treasurer" beyond § 7-5-207(a)(2)(B)(iv) (county
  over-inclusion). Pulaski's "NAMES WILL APPEAR IN BALLOT POSITION
  ORDER" = candidate order within a race, not office order (over-read
  fixed). Open: possible de-facto ES&S Web-Portal template standardizing
  the ~90% similarity (manual p. 53, not public); Pulaski corroboration
  is results/notice order, not a ballot face (sample lookup per-voter;
  /sample-ballot/ = HTTP 522); Benton 2024 composite not located;
  official O.C.A. = LexisNexis JS portal (SOS compilation used as
  primary instead); mid-term judicial vacancy path unchased. Re-checked
  2026-08-16 (C stands): SBEC rules index read directly
  (https://sbec.arkansas.gov/rules/) — still no ballot-format/order rule
  ("7 CAR 92 Voter Intent and Ballot Remake" = damaged-ballot duplication,
  not layout); 2025 HB1070 "Ballot Draw Standardization Act of 2025"
  (candidate name-draw only, not office order) failed third reading
  2025-03-13 and died on the House calendar at Sine Die 2025-05-05
  (verified on arkleg.state.ar.us). Codex-assisted sweep (results-report
  order, NOT ballot faces — treat as roster-grade only, unverified by us):
  Faulkner/Saline/Craighead 2024 broadly agree with the common spine, but
  Washington County places the unopposed block AFTER the statewide issues,
  contradicting all three — the county-conflict picture widened, not
  converged.

### KS — Kansas (FIPS 20) — GRADE A (scoped)

- Authority: K.S.A. 25-611 "Arrangement of offices on official general
  ballots" + ballot forms 25-616 (national) / 25-617 (state) / 25-618
  (county/township); questions 25-605 + 25-620; retention Kan. Const.
  art. 3 § 5(c) + K.S.A. 20-3006 + 20-2908 — Revisor of Statutes,
  https://ksrevisor.gov/statutes/chapters/ch25/025_006_0011.html
  (accessed 2026-08-16). Supplement: Kansas Election Standards Ch. II
  (rev. 2025-08-01, sos.ks.gov). K.A.R. Agency 7 art. 29 has no order
  rule (colors + secrecy only). Note: 25-611(b) is ONE list covering
  county AND township — the two-tier split comes from the ballot forms
  and printed faces, not (b) itself.
- Office order: National Offices: President → US Senator → US Rep. State
  Offices: Governor AND LtGov running together → SOS → AG → (other
  statewide = State Treasurer → Insurance Commissioner) → State Senator →
  State Rep → DISTRICT JUDGE → DISTRICT MAGISTRATE JUDGE → DISTRICT
  ATTORNEY → State Board of Education. County Offices: County
  Commissioner → Clerk → Treasurer → Register of Deeds → County Attorney
  → Sheriff. Township Offices: Trustee → Treasurer → Clerk. "When any
  office is not to be elected, it shall be omitted" (25-616/617). Cycle
  split: presidential years = no statewide executives, all 40 KS Senate,
  SBOE 2/4/6/8/10, all 6 DAs, full county slate; gubernatorial = all
  executives, NO KS Senate, SBOE 1/3/5/7/9, Township Clerk.
- Judicial: TWO mechanisms. (1) PARTISAN-elected district
  judges/magistrates (14 of 31 judicial districts; election is the
  constitutional DEFAULT — art. 3 § 6(a) lets a district opt IN to
  nonpartisan merit selection; note district #17 itself is a PARTISAN
  district) print INSIDE the state block between State Rep and DA — not
  late (biggest delta). VERIFIED ON A PRINTED FACE (verify pass):
  Osborne County 2024, 17th JD —
  https://www.osbornecounty.org/news_and_information/2024_election/sample_general_ballots/100%20Alton%20City.pdf
  — State Rep 109th → District Court Judge 17th Dist 1st Div → 2nd Div →
  District Magistrate Judge 4th Position, party labels + write-in lines,
  while Court of Appeals on the same ballot reads "Shall … be retained?"
  (2) RETENTION (Supreme, Court of Appeals, + the 17 nonpartisan-
  selection districts) "on a separate judicial ballot, without party
  designation" — internal order Supreme → Appeals → district →
  magistrate. Retention PLACEMENT is CARD-STRUCTURE-DEPENDENT, a county
  choice under 25-601/25-618(a)/25-620 ("may be separate … or may be
  combined"): combined-card counties print it late after all offices
  (Leavenworth 2022, Jefferson 2024, Osborne 2024); SPLIT-CARD counties
  print retention + amendments on the national/state card BEFORE any
  county office (Osborne 2022 rendered + read: SBOE → Supreme retention
  → Appeals retention → Questions 1-2, county offices on a separate
  card) — so Sedgwick's mid-ballot canvass position is likely REAL, not
  an artifact.
- Measures: "QUESTION SUBMITTED" headers, amendments first, then
  county/city/USD questions. PRACTICE not statute (same flag as MS) —
  25-605/618/620 fix form and card structure, never position. Last on
  combined cards; on split cards amendments print on the national/state
  card before county offices (Osborne 2022).
- County discretion: partial — office order fixed, no option;
  questions/judicial physical-ballot choice is the county's; odd-year
  municipal order delegated to SOS regulations (25-611(c)) that were
  never located (likely never adopted — Cornell LII shows no such K.A.R.).
- School/special: school board + community college + city GENERALS =
  odd-Nov (25-2010, 71-1413, 25-2107); even-year ballots carry ZERO
  school/CC contests (4 county artifacts). TWO refinements: (a) USD BOND
  questions DO appear even-year (Sedgwick USD 394, Shawnee USD 340) in
  the measures block; (b) city offices NOT structurally barred — 25-2107(a)
  "odd-numbered and even-numbered years, if needed" + real even-year city
  contests printed (Prairie Village Mayor 2022; Andale/Colwich/Garden
  Plain 2024), after township, before retention/questions.
- Corroboration: Leavenworth 2022 printed ballot face
  (https://files.leavenworthcounty.gov/Department/Clerk/Election/sample%20ballots/1%20Precinct%202%20Ward.pdf
  — NATIONAL/STATE/COUNTY headers, full executive chain, retention
  block, amendments last). Jefferson 2024 printed face (46-page style
  set, https://www.jfcountyks.com/DocumentCenter/View/6586/Sample-Ballots
  — presidential variant, Township tier, Appeals retention on back +
  USD 339 bond questions; header set across all styles = exactly
  {National,State,County,Township}). Osborne 2024 face (partisan-judge
  chain — see Judicial) + Osborne 2022 face (split-card layout +
  gubernatorial executive chain Gov/LtGov → SOS → AG → Treasurer →
  Insurance, NO KS Senate, SBOE district 5 — every cycle-split claim on
  print). Sedgwick 2024 official canvass — partisan district judges Div
  1-28 + magistrate + DA after KS House (canvass order; URL RE-LOCATED
  2026-08-17: bare /media/67739 dead, full-slug
  https://www.sedgwickcounty.org/media/67739/2024-general-official-results.pdf
  live via elections/election-results/2024-general-election/,
  %PDF-verified, sequence re-confirmed inside the file: KS House 105th →
  District Court Judge Dist 18 Div 1… → Magistrate → District Attorney →
  SBOE 8th — canvass evidence only, still not a printed face).
  Johnson 2022 + Shawnee 2022/2024 canvasses —
  retention late on combined cards; Shawnee's separate "Judicial
  Retention" results document = separate-card evidence. SOS statewide
  abstracts 2022/2024 corroborate. All %PDF-verified.
- Baseline delta: override required. (1) partisan district
  judges/magistrates + DA insert between state house and county; (2)
  SBOE inserts after that group, before county; (3) Township = distinct
  tier between county and municipal; (4) school tier EMPTY even years;
  municipal near-empty but NOT structurally empty.
- GRADE SCOPE: A covers the office ladder (national → state incl. the
  POSITION of the judge/DA/SBOE group between State Rep and county →
  county → township). EXCLUDED from A: (1) DA↔SBOE internal order
  (review round) — 25-611(a) puts DA first, but neither slot is
  verified on any printed face (Osborne carried neither contest) and
  the two canvasses carrying both disagree (Sedgwick follows statute,
  Shawnee 2024 prints SBOE first); below tier granularity, so nothing
  to encode — excluded to keep A from over-claiming. (2) retention-
  block and question PLACEMENT — card-structure-dependent county choice
  (late on combined cards; before county offices on split cards), no
  statutory position; leave baseline judicial-late as-is for retention
  and do not encode measure position.
- Notes: name rotation by county/precinct (25-610/614) never touches
  office order. Statute-vs-practice conflicts recorded: 25-611(a) puts DA
  BEFORE SBOE — Shawnee 2024 printed SBOE first, Sedgwick followed
  statute (two counties disagree, below tier granularity). KCEB trap
  avoided (kceb.org = Kansas City MISSOURI). 2026-08-04: voters REJECTED
  the amendment replacing merit selection with direct election —
  retention scheme unchanged for Nov 2026. Open: DA + SBOE slots still
  unverified on any printed face (Osborne had neither contest); 17/14
  split count has no primary source (Election Standards assertion +
  party-prefix inference from SOS abstracts); Wyandotte 403 even via
  r.jina.ai; municipal-order K.A.R. unlocated (likely never adopted).

### MS — Mississippi (FIPS 28) — GRADE A (scoped)

- Authority: Miss. Code Ann. § 23-15-367(2) (category order for office
  titles; final para. limits county discretion to categories (e)-(f)).
  PRIMARY carrier (verify-pass find — kills the mirror problem): enrolled
  Governor-signed 2026 HB 907 reprints § 23-15-367 IN FULL on the MS
  Legislature's own host, "~ OFFICIAL ~", disposition Law ch. 372 eff.
  2026-07-01 —
  https://billstatus.ls.state.ms.us/documents/2026/pdf/HB/0900-0999/HB0907SG.pdf
  (TLS AUTHENTICATED 2026-08-17 — the server misconfig is only an
  OMITTED INTERMEDIATE: it serves the leaf alone (CN=
  billstatus.ls.state.ms.us, O=Mississippi Department of Information
  Technology Services, expires 2027-01-04). Supplying the issuer cert
  (GlobalSign RSA OV SSL CA 2018, fetched from the leaf's AIA URL
  http://secure.globalsign.com/cacert/gsrsaovsslca2018.crt) makes
  `openssl verify` pass and lets curl fetch over fully VALIDATED TLS —
  `curl --cacert gs_int.pem <url>`; plain `curl -k` also works but is
  no longer load-bearing. sha256 of the fetched PDF:
  68cb4263ac8c1676f7485cf725988d440b0ab6329d6cdffc958e00f3dc5d2b14.
  Change markers only in subsection (3):
  SOS sample deadline 55 → 60 days + runoff escape; (2) reprinted
  unchanged). Justia mirror corroborates but is now STALE on (3).
  Restatement of the SEMS lock-down: 2026 County Elections Handbook, MS
  SOS Elections Division
  (https://www.sos.ms.gov/content/documents/elections/2026%20County%20Election%20Handbook.revised%2012-30-2025.pdf):
  "the order in which the titles of the federal, state, state district,
  legislative and multi-county offices … published by the Secretary of
  State's Office in SEMS shall not and cannot be changed by the County
  Election Officials. (Miss. Code Ann. § 23-15-367)" — note the handbook
  restates the lock-down only, NOT the (a)-(f) sequence; the A rests on
  the enrolled bill. Judicial: § 23-15-976 (nonpartisan), § 23-15-979
  (alphabetical, no party). CORRECTION (verify pass): § 23-15-367(1)'s
  exception clause governs SIZE/PRINT/PAPER, not order — judicial is
  simply absent from (2)'s categories, so EARLY-judicial placement has NO
  statutory basis; it rests entirely on the SOS-published SEMS ballot.
  Accessed 2026-08-16.
- Office order: TWO disjoint November generals — neither ever carries
  both federal and statewide-executive contests. EVEN years (federal +
  judicial): President → US Senate → US House → NONPARTISAN JUDICIAL
  ELECTION (Supreme Court → Court of Appeals → Circuit/Chancery/County
  Court as applicable) → County Election (Election Commissioner,
  § 23-15-213, presidential years) → School District Election → statewide
  measures → END OF BALLOT. ODD years (state + county, e.g. 2027):
  Governor → LtGov → SOS → AG → State Auditor → State Treasurer → Ag &
  Commerce Commissioner → Insurance Commissioner → Public Service
  Commissioner → Transportation Commissioner → District Attorney → State
  Senate → State House → countywide block (Chancery Clerk, Circuit
  Clerk, Coroner, County Attorney, Sheriff, Tax Assessor, Tax Collector)
  → county-district block (Supervisor, Justice Court Judge, Constable) →
  School Board / Election Commissioner.
- Judicial: EARLY, not late — even-year nonpartisan judicial block prints
  directly after US House, BEFORE any county contest, under repeated
  "NONPARTISAN JUDICIAL ELECTION" headers, inside the SOS-published SEMS
  ballot counties cannot reorder. Names alphabetical, no party
  (§ 23-15-979). Exception: Justice Court Judge is nonpartisan but prints
  in the odd-year county-district block with Supervisor/Constable.
  Election Commissioners are NOT in the nonpartisan section — party
  labels, "County Election" header (they just skip primaries).
- Measures: dead last after every contest incl. school, before "END OF
  BALLOT", numbered "Statewide Ballot Measure N". PRACTICE not statute —
  § 23-15-367(2) orders offices only; no measures-placement statute
  found. Initiative process struck 2021 (Butler v. Watson); legislative
  amendments keep the slot live.
- County discretion: partial, narrowly bounded — within-category order
  for (e) countywide + (f) county-district only; SEMS locks everything
  above.
- School/special: school board (all trustee types) nonpartisan, November
  general only, own "School District Election" header AFTER county,
  BEFORE measures. Handbook confirms in one sentence: judicial (incl.
  Justice Court Judge), all school-board trustee types "run as
  non-partisan candidates and only participate in the November General
  Election"; Election Commissioners party-labeled, no primaries,
  § 23-15-213. NO municipal tier — AFFIRMATIVE (verify pass): SOS
  publishes a separate 2025 Municipal Elections Handbook (municipal
  primaries = Municipal Party Executive Committees § 23-15-171;
  municipal elections = Municipal Election Commissions — different
  election, year, body).
- Corroboration: SOS-published sample ballots (primary; via r.jina.ai —
  sos.ms.gov Akamai-403s direct):
  https://www.sos.ms.gov/content/documents/elections/2024/GE%20Sample%20Ballot.pdf
  (even-year: federal + judicial ONLY — that IS the SEMS-locked portion;
  county/school/measures are county-appended below),
  https://www.sos.ms.gov/content/documents/elections/2023/2023%20General%20Sample%20Ballot.pdf
  (full odd-year executive chain), 2020 FINAL sample w/ Flag Referendum
  (measures 1-3 last; also prints "SPECIAL NONPARTISAN JUDICIAL
  ELECTION / Circuit Court, District 08 Place 1" — circuit in the block;
  https://www.sos.ms.gov/content/documents/elections/FINAL%202020%20sample%20GE%20Ballot%20with%20Flag.pdf).
  County (URLs closed by verify child): Hinds 2024 general
  (https://www.co.hinds.ms.us/pgs/pdf/sampleballots/Hinds%20County%202024%20General%20Sample.pdf,
  238pp/18 styles — federal → judicial (a style carries Court of Appeals
  OR County Court, never both) → Election Commissioner → School Board).
  Hinds 2023 general
  (https://www.co.hinds.ms.us/pgs/pdf/sampleballots/Hinds%20County%202023%20General%20Sample.pdf,
  264pp/132 styles — full odd-year chain on real faces: 8 executives →
  PSC → Transportation → DA → Senate → House → 8 countywide incl. County
  Surveyor → Supervisor → Election Commissioner → Justice Court Judge →
  Constable → School Board). Hinds 2019 official summary (odd-year
  sequence; results order). DeSoto 2020 ballot
  (http://records.desotocountyms.gov/Election/2020GenBallot01.pdf).
  DeSoto 2022 (https://www.desotocountyms.gov/DocumentCenter/View/6961)
  — CLOSES the Chancery slot: judicial block prints Court of Appeals →
  CHANCERY Court Judge → Circuit → County Court, then School Board + a
  Hernando local-proposition tail. Lauderdale 2020
  (https://www.lauderdalecounty.org/wp-content/uploads/2020/09/Lauderdale-Sample-Ballot-GE-2020.pdf,
  school → measures → END OF BALLOT). Tabulator reports (Hinds/DeSoto/
  Madison 2020) mirror. Child-agent third county: Lafayette 2020
  (https://lafayettems.com/wp-content/uploads/2020/09/2020-Sample-Ballot.pdf,
  image-only PDF — embedded TIFFs OCR'd w/ tesseract TSV coordinates for
  reading order) — same shape (federal → judicial → commissioners →
  school → measures side 3 alone); ALSO shows SPECIAL ELECTIONS
  interleave with regular contests (Special Constable directly after
  judicial; Special School Board at county-tail), not grouped separately.
  Weak/unusable scans noted (Newton pattern-consistent; Neshoba front
  only; Clarke/Kemper noise). %PDF-verified where PDF.
- Baseline delta: override required. (1) judicial moves from late block
  to position 4 (after US House, before county/school) in even years —
  largest deviation, but EXCLUDED from the A override (see GRADE
  SCOPE); (2) CYCLE SPLIT: even = no executives/legislature,
  odd = no federal — a merged sequence misorders both; (3) state-district
  tier (PSC, Transportation Commissioner, DA) between executives and
  legislature in odd years; (4) measures-last + school-after-county match
  baseline; (5) no municipal tier.
- GRADE SCOPE (review round): A covers the § 23-15-367(2) category
  ladder, the even/odd cycle split, the state-district tier, and the
  SEMS lock-down. EXCLUDED from A — even-year EARLY-judicial position:
  no statute, rule, or manual prescribes the slot (judicial is absent
  from (2)'s categories; the (1) exception governs size/print/paper;
  the handbook restates the lock-down only). It rests on the per-cycle
  SOS/SEMS-published ballot — same evidence class as NE's SOS-delegated
  executive internal order, which is likewise excluded from A. Held at
  B: consistent across 2020/2022/2024 SOS + county prints, but a
  future SOS could re-slot it without any law change and nothing
  written would flag the move. Consequence: no judicial-position
  override for MS; baseline judicial-late stays and is KNOWN WRONG in
  observed practice (recorded, not silently resolved). Restore path: a
  written SOS prescription of judicial position, or a per-cycle
  SEMS-confirmation policy decided at code-PR time.
- Notes: statute-vs-ballot conflicts recorded (both sit in a gap the
  statute leaves open — subsection (2) fixes CATEGORY order; internal
  order of statewide/state-district lists diverges in print): (a)
  § (2)(b) says "State Treasurer, Auditor of Public Accounts"; 2023 SOS
  sample + Hinds 2019 print State Auditor BEFORE State Treasurer; (b)
  § (2)(c) says "Transportation Commissioner, Public Service
  Commissioner"; both ballots print PSC first (DA third, matching).
  Intra-county tail varies (Hinds 2024 Election Commissioner→School
  Board; Hinds 2019 School Board→Election Commissioner) — don't hard-code.
  County Court slot CLOSED (Rankin 2024 runoff sample,
  https://www.rankincounty.org/egov/documents/1731619349_42643.pdf) and
  CHANCERY slot CLOSED (DeSoto 2022 — see Corroboration): every trial
  tier now observed in the block. Odd-year county-district internal
  order VARIES (Hinds 2023 faces: Supervisor → Election Commissioner →
  JCJ → Constable; entry's earlier Hinds-2019 summary order differs) —
  within (f) discretion, don't hard-code. Hinds 2020 448pp set URL now
  CONFIRMED (byte-count match 4,488,341:
  https://www.co.hinds.ms.us/pgs/pdf/sampleballots/Hinds_County_MS_2020_General_Election_NP_rev.pdf)
  — federal → judicial → County Election → measures on back, no printed
  END OF BALLOT on this county-printed set. Hinds 2019 general exists
  only in Wayback (CDX: 19GMSHIND_3_SAMPLE.pdf, replay 503 all session;
  2023 = same odd-year cycle, used instead).
  Open: odd-year measure placement never observed; § 23-15-365 =
  write-in spaces, dead lead. Fetch: sos.ms.gov = Akamai 403 direct →
  r.jina.ai; SOS sample filenames are inconsistent per year (2020 has NO
  year subdir); co.hinds.ms.us soft-404s = HTTP 200 + ~700B HTML (check
  %PDF); billstatus.ls.state.ms.us omits its TLS intermediate — either
  curl -k or (better) --cacert with the AIA-fetched GlobalSign RSA OV
  SSL CA 2018 cert for validated TLS (see Authority); Wayback playback
  503 all session.

### NM — New Mexico (FIPS 35) — GRADE A (scoped)

- Authority: NMSA 1978 § 1-10-8 "Ballots; order of offices and ballot
  questions," as amended by Laws 2023, ch. 39 (SB 180) § 60, eff.
  2023-06-16 — enrolled chaptered text (primary):
  https://www.nmlegis.gov/Sessions/23%20Regular/final/SB0180.pdf
  (pp. 111-116; chapter confirmed on the nmlegis bill page). Supporting:
  § 1-10-3 (uniformity; SOS sets positions), § 1-10-4 (clerks certify
  only), § 1-22-3 (Local Election Act odd-Nov, Laws 2018 ch. 79 HB 98).
  Accessed 2026-08-16.
- Office order: TWO statutory cycle lists. Presidential (§ 1-10-8(A)):
  President ticket → US Senator → US Rep → state senator → state rep →
  supreme court (partisan) → court of appeals (partisan) → public
  education commission → district attorney → district court →
  metropolitan court → county clerk → county treasurer → county
  commission (+ when applicable sheriff/assessor/probate). NO statewide
  executives. Gubernatorial (§ 1-10-8(B)): US Senator → US Rep → Governor
  & LtGov single joint ticket → SOS → AG → State Auditor → State
  Treasurer → Land Commissioner → state rep (NO senate — elected in
  presidential years) → supreme court → court of appeals → PEC → district
  court → metropolitan court → magistrate court → county sheriff →
  assessor → commission → probate judge (+ clerk/treasurer when
  applicable). Governor AFTER US House; AG precedes Auditor + Treasurer.
- Judicial: partisan judicial contests print MID-BALLOT after
  legislature/executives, BEFORE every county office — not a late block.
  PEC + district attorney sit inside that block. Position numbering:
  supreme/COA by vacancy date (§ 1-10-8(G)(2)); district/metro/magistrate
  ascending division (§ (G)(1)). RETENTION is not an office — it LEADS
  the questions block (§ 1-10-8(D)(1)), ahead of amendments;
  supreme/COA retention by seniority (§ (G)(3)).
- Measures: § 1-10-8(D) internal order — (1) judicial retention → (2)
  constitutional amendments → (3) other state questions (statewide GO
  bonds) → (4) county questions → (5) local-government questions (in the
  § (C) list order); SOS may prescribe a different question order
  ("unless a different order is prescribed by the secretary of state").
  Verify-pass precision: the statute never literally says
  questions-after-all-offices — that placement is structural inference
  CONFIRMED by every sampled ballot. The stale NMAC's county-set
  question order could arguably survive via the (D) savings clause, but
  2024 print follows the statute.
- County discretion: none — § 1-10-3(A) "Ballots shall be uniform
  throughout the state" (this one quote could NOT be re-verified this
  session: nmonesource 404, justia 403 even via r.jina.ai; conclusion
  survives on § 1-10-8's mandatory "shall contain … in the following
  order" + § 1-10-4); SOS sets positions; clerks certify precinct
  content (§ 1-10-4(B), verified via enrolled HB 407 (2019) p.135).
- School/special: NONE on the even-year general — § 1-10-8(C) puts
  municipal (exec → board → judicial), school board, community college,
  special districts on the regular LOCAL election, fixed odd-Nov by
  § 1-22-3(A); HB 98 repealed the School Election Law + Municipal
  Election Code. Local ballot QUESTIONS may still ride the general
  (§ 1-22-3(C)).
- Corroboration: Santa Fe County Nov 2024 official samples (PCT001 +
  PCT004 + PCT031,
  https://www.santafecountynm.gov/uploads/documents/Sample-SANT_PCT001.pdf
  — text layer is +0x1D char-shifted font encoding, decoded + rendered
  to PNG and read visually) — presidential-year sequence confirmed incl.
  clerk → treasurer → commission and JUDICIAL RETENTION → STATE
  amendments 1-4 → STATE bonds 1-4 → COUNTY GO bonds; zero
  school/municipal/special contests. Santa Fe June 2026 PRIMARY sample
  (2026_Primary_Sample-SANT_PCT001_DEM.pdf) corroborates the § (B)
  gubernatorial list exactly (Gov → LtGov → SOS → AG → Auditor →
  Treasurer → Land Comm → state rep → COA → district → magistrate →
  sheriff → assessor → commission → probate). Odd-year local ballot
  (Sample-SANT_PCT029.pdf) shows MUNICIPAL → SCHOOL → COLLEGE banners
  matching § (C). Child-agent additions (all %PDF-verified, live URLs):
  Santa Fe 2022 GENERAL styles (PCT001/002/009/020/031/040 under
  /media/files/Clerk/BoE/2022General/Sample%20Ballots/) — a real
  gubernatorial-year GENERAL printing US Rep → Gov&LtGov → SOS → AG →
  Auditor → Treasurer → Land Comm → State Rep → Supreme Court Positions
  1-2 → COA Positions 1-2 → Magistrate Divs 1-4 → Sheriff → Assessor →
  Commissioner → Probate Judge → JUDICIAL RETENTION → amendments → state
  bonds → county bonds (pre-2023 statutory text, but closes "partisan
  appellate contests in a general" as observed print). 2024 full question
  tail corroborated: retention → amendments 1-4 → state bonds 1-4 →
  COUNTY GO bonds 1-3 → MUNICIPAL band (City of Santa Fe roads bond) DEAD
  LAST (styles PCT011/020/031/050). Bernalillo publishes NO static ballot
  (per-voter portal only; entire WP media library + CDX + Common Crawl
  enumerated) — statutory Notice of Election PDFs substitute (2022 incl.
  questions; 2024 omits questions). All 9 2024 styles keyword-swept: zero
  SHERIFF/ASSESSOR/PROBATE hits (presidential-year absence confirmed).
- Baseline delta: override — substantial. (1) judicial partisan mid-block
  before ALL county offices; (2) PEC + DA inside that block; (3) county
  offices are the LAST offices, internal order flips by cycle; (4)
  judicial retention leads the measures block (before amendments); (5)
  municipal/school/special tiers EMPTY on even-year generals (municipal
  QUESTIONS may print, dead last after county questions); (6)
  presidential years have no executives and legislature moves directly
  behind US House.
- GRADE SCOPE (review round): A covers the presidential-cycle § (A)
  list (Nov 2024 Santa Fe generals corroborate it end-to-end), the
  § (D) question block incl. retention-first, and the empty
  school/municipal/special tiers. EXCLUDED from A — the gubernatorial
  § (B) list: the amended text has never run in a general (first =
  Nov 2026), and the plan requires a matching GENERAL sample for A.
  Statute is mandatory, county discretion nil, and the June 2026
  PRIMARY prints § (B) exactly — but this campaign has already seen
  print lawfully deviate from clear statutory order (NE § 32-813(1)
  reorder clause) and NM's own Nov 2024 print carried an off-list
  magistrate contest, so the general-corroboration leg is load-bearing.
  2022 general matches only the PRIOR text (DA placement differs).
  Held at B; restore to A from a Santa Fe Nov 2026 general sample
  (expected ~Oct 2026 — cheap close, before the override would ever
  fire for that cycle).
- Notes: statute-vs-sample gap recorded: Nov 2024 Santa Fe printed
  MAGISTRATE JUDGE Div. 2 (unexpired-term vacancy) but § (A) has no
  magistrate entry — it slotted between DA and county clerk, order
  unaffected, statutory list incomplete for off-cycle magistrate
  vacancies. § (B) has never yet run in a general (first = Nov 2026);
  2022 ballots reflect the PRIOR text (redline verified via
  Amendments_In_Context/SB0180.pdf) — Santa Fe 2022 general matches the
  prior text and the current § (B) shape except DA placement (prior text
  B(16)). 2024 text-layer trap: a phantom "STATE / ESTATAL" string
  precedes the President box in the text layer but is NOT printed
  (300-dpi render check) — office section carries no band headers; bands
  print only before question groups. /uploads/documents/ mixes elections:
  PCT009/PCT029 same-name files = Nov 2023 LOCAL ballots; _DEM/_REP
  suffix = primaries — read the printed date line. STALE SOS RULE: 1.10.11 NMAC (am.
  2018, still served at srca.nm.gov) conflicts with the current statute
  (executives before legislature in all years; Auditor/Treasurer before
  AG; lists abolished elective PRC; county-set local-question order) —
  statute controls, 2024 sample follows statute; treat NMAC as
  superseded (formal repeal status unresolved). PRC appointed since 2023
  (Laws 2020 ch. 9 + 2020 CA1). Gov/LtGov joint in general, separate in
  primary (art. V § 1). Statute-only (no sample): supreme/COA partisan
  slots in a presidential-year general (none up 2024); metropolitan
  court (Bernalillo sample not obtained — berncoclerk.gov paths 404; a
  late child agent may still report — treat unverified until re-fetched).
  Fetch: nmlegis.gov PDFs fine w/ browser-UA curl; law.justia.com 403 →
  r.jina.ai; nmonesource.com 404s (use enrolled bills); Wayback 503 all
  session.

### NE — Nebraska (FIPS 31) — GRADE A (scoped)

- Authority: Neb. Rev. Stat. § 32-813 "Statewide general election; ballot;
  contents" ("shall be arranged upon the ballot in parts separated from
  each other by bold lines in the order the offices and proposals are set
  forth in this section") —
  https://nebraskalegislature.gov/laws/statutes.php?statute=32-813
  (accessed 2026-08-16). Supporting: § 32-812 (SOS prescribes form),
  § 32-814 (one ballot; nonpartisan name rotation by precinct), § 32-815
  (partisan within-contest party order by prior gubernatorial vote,
  petition candidates last), § 24-815 (retention question "on the
  nonpolitical ballot"), § 32-556 (city/village/school combined onto the
  nonpartisan ballot), Neb. Const. art. III § 7 (Legislature nonpartisan,
  no party label).
- Office order: PARTISAN sections: Presidential Ticket → United States
  Senatorial Ticket → Congressional Ticket → State Ticket → County Ticket
  (+ county measures) → precinct/city/village. Governor AFTER US House.
  Executive internal order NOT in statute — § 32-813(5) delegates to SOS
  ("arranged in the order prescribed by the Secretary of State"); observed
  identical across Douglas 2014/2018/2022: Governor & LtGov (joint, one
  oval) → SOS → State Treasurer → AG → Auditor of Public Accounts →
  Public Service Commissioner. NONPARTISAN Ticket (§ 32-813(6)) statutory
  sub-order: Legislature → State Board of Education → Regents → Chief
  Justice → Supreme Court judges → Court of Appeals → Workers' Comp →
  District → Separate Juvenile → County Court → county officers "in the
  order prescribed by the election commissioner or county clerk."
  STATUTE-VS-PRACTICE (recorded both): § 32-813 lists Nonpartisan (6)
  BEFORE County Ticket (7); Douglas + Lancaster 2024 BOTH print County
  Ticket before Nonpartisan — lawful under the § 32-813(1) optical-scan
  reorder clause ("order of any offices may be altered to allow for the
  best utilization of ballot space"); consistent real-world practice.
- UNICAMERAL DECISION (campaign records it here): "Member of the
  Legislature" maps to `state_upper`; `state_lower` = STRUCTURALLY ABSENT
  for NE (suppress the block, never render empty/late). Rationale:
  members titled Senator; districts are Census/OCD `sldu`; downstream
  "your state senator" comparisons align. Legislature is the statutory
  FIRST item of the nonpartisan section (§ 32-813(6)(a)) and prints
  first in Douglas — but Lancaster 2024 prints SBOE → Regents →
  Legislature (lawful reorder; verify-pass finding). No party labels
  (art. III § 7).
- Judicial: ALL retention (§ 24-815 "Shall Judge … be retained in
  office?"), printed INSIDE the Nonpartisan Ticket — a MID block, not
  late. Statutory slot after Regents, before county/city/school.
  Lancaster 2024 follows statute exactly (Supreme → Workers' Comp →
  District → Separate Juvenile → County). Douglas 2024/2022 moves
  retention to the END of the nonpartisan section after school boards —
  intra-section position VARIES by county (see grade scope).
- Measures: TWO statutory classes — do not read "measures last" as one
  rule. (1) STATEWIDE initiatives/referenda/amendments — § 32-813(9):
  follow all other offices and "constitute a separate ballot"; these are
  the dead-last class (Lancaster 2024 = physically separate ballot;
  Douglas 2024 prints statewide Measures 434-439 last). (2) SUBDIVISION
  proposals — § 32-813(1): follow that subdivision's offices, so county
  measures ride the County Ticket (the "(+ county measures)" slot in
  Office order, BEFORE precinct/city/village offices) and city/school
  proposals follow their own offices near the tail (Douglas 2024: local
  Special Issues (Omaha charter, bonds) after their subdivisions' offices,
  then the statewide class last). Office-order, baseline-delta (ii
  "statewide measures last, after local measures"), and grade-scope
  bullets all use this two-class reading.
- County discretion: PARTIAL, unusually broad — optical-scan reorder
  clause (twice), (6)(k) county-officer order, (7)-(8) split-ballot
  options. Nonpartisan candidate NAMES rotate by precinct (§ 32-814(4))
  — stored candidate order meaningless; contest order stable.
- School/special: school boards in the nonpartisan block (Lancaster:
  dedicated SCHOOL TICKET header) AFTER state/judicial/special-district
  tiers; § 32-556 folds school offices/issues into the nonpartisan
  ballot. Elected special districts (community college Board of
  Governors, Learning Community Coordinating Council, NRD, PPD,
  Metropolitan Utilities District, ESU, Omaha Regional Metro Transit) all
  print inside the Nonpartisan Ticket after Regents/judges, before
  school/city — named in NO statute slot; identical placement in both
  counties (practice under (6)(k)/(1) discretion).
- Corroboration: Lancaster 2024 sample
  (https://www.lancaster.ne.gov/DocumentCenter/View/25182/2024-General-Election-Sample-Ballot,
  coordinate-extracted; verify pass: countywide COMPILATION — four
  legislative districts on one sheet, not a per-precinct facsimile) —
  top-level sequence incl. County-before-Nonpartisan + statutory
  retention slot, but its nonpartisan section OPENS SBOE → Regents →
  Legislature (≠ statute, ≠ Douglas — see grade scope). Douglas 2024 + 2022 + 2018 + 2014
  (votedouglascounty-ne.gov GN24/GN22/G18/G14 SampleBallot.pdf) —
  executive order ×3 cycles, special-district placement, measures tail.
  SOS's own 2024 statewide sample
  (https://sos.nebraska.gov/sites/default/files/doc/elections/2024/Sample_Ballots/General/English-Federal-and-State.pdf)
  — Presidential → Senatorial → Congressional → State Ticket; SOS page
  link order mirrors statutory sequence. All %PDF-verified.
- Baseline delta: override-eligible ONLY within the A scope below.
  In-scope deltas: (i) `state_lower` suppressed (unicameral); (ii)
  statewide measures last, after local measures, as a separate ballot.
  Documented-but-excluded deltas (observed, county-alterable): Legislature
  + all nonpartisan offices (incl. retention + school) print after county
  in both sampled counties; judicial = mid-block retention; school after
  judicial in Douglas.
- GRADE SCOPE (rewritten twice by verify pass): A covers ONLY the
  statutory partisan ladder (Presidential Ticket → US Senatorial →
  Congressional → State Ticket), the Gov/LtGov single oval,
  measures-last-after-local-measures + separate statewide-measure ballot
  (§ 32-813(9)), and subdivision-proposals-follow-subdivision-offices
  (§ 32-813(1)). EXCLUDED from A: (a) County-vs-Nonpartisan relative
  position — statute says Nonpartisan (6) before County (7); BOTH
  counties lawfully print County first under the optical-scan reorder
  clause (statute-vs-practice conflict, recorded, cannot clear A);
  (b) the ENTIRE intra-nonpartisan sub-order — Lancaster 2024 prints SBOE
  → Regents → Legislature while Douglas prints Legislature first; the
  § 32-813(6) reorder clause makes every intra-section slot
  county-alterable (Legislature, SBOE/Regents, retention position,
  special-district slots); (c) executive INTERNAL order — § 32-813(5) is
  a pure delegation, no SOS prescription located, sample-only (Douglas
  ×3 cycles).
- Notes: section headers are statutory boldface strings. Gov/LtGov single
  oval. Offices not up are omitted, rest move up (§ 32-813(1)). BOTH
  county documents are countywide COMPILATIONS, not precinct facsimiles
  (verify pass — Lancaster carries 4 legislative districts, NRD
  subdistricts 1-10, 3 school districts, 12 municipalities; the
  section-header findings are robust to compilation, intra-section
  positions less so). Douglas real path =
  votedouglascounty-ne.gov/elections/{YEAR}/General/ (bare wp-content
  filenames don't resolve; discovered via /sample_ballots.aspx). Open:
  Lancaster 2022 ballot raster w/o text layer (unread); Douglas 2022
  amendment-vs-initiative sub-order low-confidence (coordinate-offset
  PDF); third-county check would strengthen. Failed: SOS 2022 sample
  page silently serves 2024 content; Wayback 503 all session.

### ID — Idaho (FIPS 16) — GRADE B (verify-pass downgrade from A)

- Authority: DELEGATING only — the statute prescribes exactly ONE ordering
  fact. Idaho Code § 34-906(2): "The office titles shall be listed in
  order beginning with the highest federal office. The secretary of state
  has the discretion and authority to arrange the above classifications of
  offices as provided by law" (2026 ch. 227 left "the above
  classifications" dangling — subsection (1) now contains no
  classifications). § 34-909(2): SOS sample-ballot layout due to clerks by
  Sept 7 — full quote (earlier ellipsis inflated it): "The sample ballot
  layout shall contain the proper office titles, order of offices and
  ballot layout for the general election, with instructions for placement
  of candidates seeking election for federal, state, legislative, county
  and precinct offices and candidates seeking judicial office or
  retention" (the office list modifies the placement INSTRUCTIONS, not
  "order of offices"). § 34-903(2) (SOS prescribes arrangement statewide
  AND non-statewide) —
  https://legislature.idaho.gov/statutesrules/idstat/title34/t34ch9/sect34-906/
  (accessed 2026-08-16). The PRESCRIPTIVE document (§ 34-909(2) layout
  packet) is transmitted SOS → 44 clerks and NOT published — first-party
  404 confirmed; SOS Directive 2015-3 (category hierarchy Federal → State
  → Legislative → County → Judicial → subdivisions) survives only on a
  Verified Voting MIRROR — mirror-class, caps at B per TN precedent.
  Executive internal order is constitutional text (Idaho Const. art. IV
  § 1: "a governor, lieutenant governor, secretary of state, state
  controller, state treasurer, attorney general and superintendent of
  public instruction" — verbatim match to print). No IDAPA rule governs
  contest order (live Title-34 chapters grepped — none touch ballots).
  B RATIONALE: strong sample leg (4 counties × 3 cycles incl. two genuine
  single-precinct ballots) + delegating statute; the tier detail
  (judicial-after-county, ACHD/CWI tiers, measures sub-order) is
  prescribed NOWHERE verifiable. Restore path to A: obtain the § 34-909(2)
  layout packet (public-records request to SOS Elections Division) or a
  first-party/archive-grade Directives retrieval. Retrieval attempt
  2026-08-16: a FIRST-PARTY copy is confirmed to have existed at
  https://sos.idaho.gov/elections/publications/Directives_Guide.pdf (search
  engines still index the title "DIRECTIVES - Idaho Secretary of State" and
  the exact hierarchy sentence at that URL), but the SOS's whole legacy
  /elections/publications/ tree now 404s after a site revamp
  (election_laws.pdf 404s too), archive.sos.idaho.gov does not carry it,
  and Wayback replay was down service-wide that day (root 200, replay 503).
  CONCRETE RETRY: pull that exact sos.idaho.gov URL from the Wayback Machine
  once replay recovers — an archive.org capture of the first-party URL
  satisfies this entry's restore path. Dead end logged: a Codex-suggested
  Owyhee County-hosted "2020 Election Handbook"
  (owyheecounty.net/wp-content/uploads/2020/02/2020-Election-Handbook.pdf)
  404s — treat that citation as unusable.
- Office order: [President, presidential years] → US Senator → US Rep →
  CANDIDATES FOR STATE OFFICES: Governor → LtGov → SOS → State Controller →
  State Treasurer → AG → Superintendent of Public Instruction (midterms;
  order tracks Idaho Const. art. IV § 1 verbatim) → State Senator → State
  Rep Position A → Position B → county offices (Commissioners → Sheriff →
  Prosecutor → Clerk of the District Court → Treasurer → Assessor →
  Coroner) → judicial (NONPARTISAN BALLOT header) → countywide highway
  district (Ada-only — see Notes) → community college trustees → soil &
  water conservation supervisors (conditional; observed Kootenai
  2022/2024, after college trustees, before measures) → measures.
  Governor AFTER US House.
- Judicial: prints in November under a literal "NONPARTISAN BALLOT" header
  immediately AFTER county offices, BEFORE special districts — not last.
  Content = magistrate RETENTION questions (§ 1-2220 form) as the normal
  case; Supreme Court + district judges settle at the May primary on
  majority (§ 34-1217 — names ONLY "justice of the supreme court" and
  "district judge"; the Court of Appeals leg is NOT covered by that
  section, verify-pass catch) and reach November only as runoffs
  (placement within the block inferred, never observed — no runoff in Ada
  2020/22/24).
- Measures: LAST, after special districts. Observed sub-order:
  constitutional amendment → Propositions (§ 34-1810(2) numbering) →
  advisory question (2022) → local levy/bond (school levy, fire levy,
  water bond).
- County discretion: none-to-minimal — §§ 34-903(2)(b) + 34-909(2) put
  non-statewide order in the SOS layout; counties slot local questions.
  One wobble: Ada printed CWI trustees before ACHD in 2020, after in
  2022/2024 (sub-order stability open).
- School/special: school trustees NEVER on even-year November (§ 33-503 =
  odd-Nov); municipal absent (§ 50-405(1) odd-Nov); most highway districts
  May odd (§ 40-1305) — EXCEPT single countywide districts (ACHD) elect at
  the general (§ 40-1404, nonpartisan § 34-905A); community college
  trustees biennial even years (§ 33-2106). School/fire levy QUESTIONS
  still appear, in the measures block. Only two elections/year statewide
  (§ 34-106, 2011 consolidation). Precinct committeemen = primary only
  (§ 34-624).
- Corroboration: Ada County ×3 cycles + 3 more counties (child-agent
  sweep), all %PDF-verified. Ada 2022 official sample ballot (all precinct
  styles,
  https://adacounty.id.gov/elections/wp-content/uploads/sites/38/214005_AdaSampleBallot_v2_10_18_22.pdf)
  — full printed sequence incl. 7 executives, NONPARTISAN BALLOT
  magistrate block after county, ACHD → CWI → SJR 102 → advisory → levy.
  Ada 2024 election-night results + 2020 official results —
  President→US Senator adjacency closed; Prop 1 + levies last. Kootenai
  2024 precinct ballot LEG 2 L
  (https://www.kcgov.us/DocumentCenter/View/24164/LEG-2-L) + Kootenai
  2022 LEG 2/LEG 4 (View/19146, View/19149) — replicate the 2022
  seven-executive chain + county → NONPARTISAN magistrate block → college
  trustees → soil & water → amendment → advisory. Canyon 2024 composite
  (https://elections.canyoncounty.id.gov/wp-content/uploads/2025/08/Full-Sample-Ballot.pdf)
  + Bingham 2024
  (https://www.binghamid.gov/media/Departments/Elections/Sample%20Ballots/2024/Sample%20Ballots%20November%202024.pdf)
  — same section order; amendment-before-Proposition confirmed in 3
  sources (Canyon's composite places Prop 1 pre-header — rendered to PNG,
  judged a layout artifact of the aggregated all-precinct sheet, noted).
- Baseline delta: documented but NOT override-eligible (grade B — no code
  change). Observed deviations: (1) judicial block directly after county
  (not last); (2) municipal + school tiers EMPTY (odd-year elections —
  these legs ARE statute-backed, §§ 33-503/50-405); (3) two inserted
  tiers after judicial: countywide highway district, then community
  college trustees + soil & water conservation (Kootenai); (4) measures
  last w/ sub-order amendment → propositions → advisory → local
  levy/bond.
- Notes: candidate rotation § 34-903(4)(a) for entities >25,000 registered
  voters (FindLaw's 100,000 figure is WRONG — primary text says
  twenty-five thousand); within-contest only. § 34-906(2) amended 2026
  ch. 227 (pre-2026 text unverifiable — justia 403, CC index empty;
  "ending with precinct offices" tail claim UNVERIFIED). § 34-905A
  2026-ch.-333 "excludes countywide districts" claim REFUTED by verify
  pass — the only textual diff between served versions is an added
  comma; claim unsupported as written, bill not traced. RCV prohibited (§ 34-903B). County-office internal
  order VARIES slightly by county/cycle (Ada 2024 Commissioner → Sheriff
  → Prosecutor; Kootenai 2022 adds Clerk → Treasurer → Assessor →
  Coroner; staggered terms explain most of it) — tier position constant.
  Highway-district tier = Ada-only (ACHD is the sole countywide district;
  other counties skip straight to college trustees). Verify-pass find:
  SOS Directive 2015-3 "Ballot Rotation" (Directives compilation Sept
  2022; SOS letterhead, issued under §§ 34-202 + 34-903(4); live SOS
  copy deleted — Verified Voting mirror
  https://verifiedvoting.org/wp-content/uploads/2024/10/ID_Directives_Guide-2022.pdf)
  prescribes the category hierarchy verbatim: "The ballot is laid out in
  the hierarchy of the offices (i.e., Federal, State, Legislative,
  County, Judicial, and any other political subdivision candidates,
  where applicable)" — and defers office-level order to the per-election
  certification packet ("will accompany the State's certification of
  candidates and ballot printing instructions"), which is transmitted
  SOS → clerks and never published. SOS-HOSTED statute reprint lives at
  https://archive.sos.idaho.gov/elections/publications/election_laws.pdf
  (2025-26 cycle). Open: the § 34-909(2) layout packet itself
  (public-records request is the realistic path);
  CWI-vs-ACHD sub-order (2020 inverted); judicial-runoff position within
  the nonpartisan block. Fetch: legislature.idaho.gov fine via WebFetch;
  Ada per-precinct GIS ballots session-gated (0 bytes); achdidaho.org 403
  → r.jina.ai; kcgov.us DocumentCenter lists are JS-rendered (probe IDs
  directly).

### WV — West Virginia (FIPS 54) — GRADE A (scoped)

- Authority: W. Va. Code § 3-5-13a "Order of offices and candidates on the
  ballot" ("The order of offices for state and county elections on all
  ballots within the state shall be as prescribed herein") —
  https://code.wvlegislature.gov/pdf/3-5-13A/ ; § 3-6-2 (general-ballot
  form; adopts the 13a order under National/State/County Ticket headings;
  measures clause) — https://code.wvlegislature.gov/pdf/3-6-2/ ;
  § 3-5-13(3) (column headings incl. Nonpartisan Judicial Ballot) —
  incorporation CORRECTED by verify pass: § 3-6-2(b) carries subdivision
  (3) into general ballots but NOT paragraph (2)(A) ("paragraphs (C) and
  (D), subdivision (2) … subdivision (3) of said section"), so the ICA
  slot cannot rest on (2)(A) via that route — it rests on the SOS Manual
  (below); § 3-10-3(c),(d)(3),(e) (judicial vacancies at the general).
  SECOND PRESCRIPTIVE AUTHORITY (verify-pass find): SOS Manual for
  Election Officials (https://sos.wv.gov/media/476/download?inline=,
  rev. 2026-05-13), printed p.77 heading "Order of Offices on State and
  County Ballots" — restates the full ladder and states ICA-SECOND
  outright: "NONPARTISAN JUDICIAL BALLOT: Supreme Court of Appeals,
  Intermediate Court of Appeals, Circuit Court Judge, Family Court
  Judge, Magistrate" (fn. 319 → § 3-5-13(2)(A)(i)-(v)); printed p.76
  adds: constitutional amendments placed after offices "and before
  public questions". All accessed 2026-08-16, %PDF verified. CSR Title
  153 has no order series (index reviewed).
- Office order: NATIONAL TICKET President → US Senator → US House → STATE
  TICKET Governor → SOS → Auditor → Treasurer → Commissioner of
  Agriculture → AG → State Senator → House of Delegates → multicounty
  offices → state executive committee → NONPARTISAN JUDICIAL BALLOT
  (SCOA → ICA → circuit → family → magistrate) → COUNTY TICKET Clerk of
  the Circuit Court → County Commissioner → Clerk of the County
  Commission → Prosecuting Attorney → Sheriff → Assessor → Surveyor →
  NONPARTISAN BALLOT (Board of Education → Conservation District
  Supervisor → any question) → DISTRICT TICKET (nonpresidential yr) /
  NATIONAL CONVENTION (presidential yr — primary-only in practice).
  Governor directly after US House; no LtGov (Senate President ex
  officio). Office-block print in practice with
  party initials + "NO CANDIDATE(S) NOMINATED" placeholders, though
  § 3-6-2(c) still describes party columns. Unexpired term prints
  immediately below the full term for the same office.
- Judicial: all judges nonpartisan, elected at the MAY PRIMARY (§§ 3-5-6a
  through 6d; ICA § 51-11-6(c)). November content = VACANCY/unexpired-term
  contests only (§ 3-10-3(d)(3): post-filing vacancy w/ >3yr unexpired
  term → "nonpartisan judicial election held concurrently with the
  general election"; magistrate vacancies "primary or general, whichever
  occurs first"; § 3-10-3(e) special August filing window). When present,
  slot = Nonpartisan Judicial Ballot BETWEEN State Ticket and County
  Ticket — NOT a late block. Precedent: Nov 6 2018 SCOA impeachment-
  vacancy elections.
- Measures: LAST — § 3-6-2(e): "Any constitutional amendment is to be
  placed following all offices, followed by any other issue." Local
  levy/bond questions (§ 11-8-16 via § 3-1-31) print after amendments as
  a separate "Official Levy Ballot" section.
- County discretion: none on order — 13a binds "all ballots within the
  state"; absent offices simply omitted. Ballot commissioners may vary
  pages/columns/rows only, "subject to approval by the Secretary of
  State" (§ 3-6-2(c)(4)); cannot add issues (§ 3-6-2(f)). Candidate order
  within office = drawing by lot, 70th day before the general
  (§ 3-6-2(d)(2)).
- School/special: BOE nonpartisan, elected at the May primary
  (§ 18-5-1b); November = unexpired terms only, own headed section
  ("Nonpartisan Board of Education", § 3-6-2(d)(5)), in the Nonpartisan
  Ballot tier after County Ticket. Conservation district supervisor same
  tier. School levy questions in the measures tail.
- Corroboration: 35 SOS-HOSTED 2024 county proofs swept (filename
  brute-force against apps.sos.wv.gov/elections/2024GeneralSampleBallots/
  — directory 403s, files 200), all %PDF-verified: National → State →
  County sequence + the 8-office State Ticket identical in ALL 35, no
  exception (real filename pattern: "SAMPLE - WV <County> 241105
  General_Proof <N>.pdf", proof-number tail varies per county — explains
  the 20 misses). Full-tail counties (verify pass CORRECTED — Kanawha is
  NOT full-tail: 368pp, zero BOE / levy / nonpartisan / judicial hits;
  its contribution = municipal AFTER amendments, p182 Dunbar): Berkeley
  (Conservation District Supervisor unexpired between County and
  amendments), Calhoun (County → unexpired-below-full Commissioner pair →
  Nonpartisan BOE unexpired → Amendment No. 1 → OFFICIAL LEVY BALLOT),
  Marion (Circuit Clerk unexpired FIRST in County Ticket → amendments →
  CITY OF FAIRMONT municipal → levy, all one sheet), Wood clerk-hosted
  precinct ballot (BOE unexpired + CITY OF PARKERSBURG municipal BEFORE
  amendments), Grant + Jefferson-2022 (Circuit-Clerk-first confirmed).
  Judicial: zero contests in all 35 2024 files + Jefferson 2022
  (grepped) — vacancy-only as expected; the one November judicial print
  found is Barbour 2018 (two SCOA unexpired divisions), vendor proof
  hosted on Ballotpedia CDN (mirror-class), verify-pass re-rendered: the
  judicial block occupies the RIGHTMOST COLUMN, header level with the
  State Ticket header — a COLUMN SWAP with County (cols 3↔4), not a
  demotion to the ballot end; still contradicts § 3-5-13(3)(A)
  left-to-right order — see grade scope. SOS Manual p.77 order section +
  p.90 "the order of offices on the ballot shall follow the same rules"
  (primary = general) re-verified first-party.
- Baseline delta: override required. (1) county internal order leads with
  Clerk of the Circuit Court; (2) school = BOE-unexpired-only after
  county, before measures; (3) judicial tier vacancy-only (usually empty)
  — position EXCLUDED from the override (see scope). Rest matches
  baseline.
- GRADE SCOPE: A covers National → State (8-office chain) → County
  (Circuit-Clerk-first) → nonpartisan BOE/conservation tail → amendments
  (35-county 2024 sweep + statute). EXCLUDED: (a) judicial-block
  POSITION — statute (§ 3-5-13a/§ 3-5-13(3)(A)) puts it between State and
  County Tickets, but the only observed November judicial print (Barbour
  2018, mirror-hosted vendor proof) prints it AFTER the County Ticket
  (column swap, cols 3↔4); conflict recorded, not resolved; November
  judicial is vacancy-only so the exclusion is cheap; (b) municipal +
  levy tail order — municipal prints after amendments in
  Kanawha/Putnam/Marion 2024 but BEFORE them in Wood 2024, and Barbour
  2018 printed the levy ballot before the amendments — county-variable,
  no authority (the SOS Manual p.76 "before public questions" clause
  orders amendments vs questions, not municipal).
- Notes: no straight-ticket device (§ 3-6-2(g)). Party-COLUMN order (not
  offices) by prior presidential vote. Printed judicial heading =
  "OFFICIAL NONPARTISAN BALLOT OF ELECTION OF JUDICIAL OFFICERS" (not
  the statute's "Nonpartisan Judicial Ballot" label). ICA statutory gap:
  § 3-5-13a's judicial list predates the 2021 ICA — § 3-5-13(2)(A)(ii) +
  SOS Manual insert ICA second; treat as slot 2. MUNICIPAL has no
  § 3-5-13a slot (§ 3-1-31(a) forces concurrent dates; prints as its own
  charter-governed section, position county-variable). Office-block
  print, 3-column snake, "NO CANDIDATE(S) NOMINATED" fillers,
  party-abbrev right of names. Open: 20 counties missed by the filename
  probe (naming variant unknown; directory 403); no first-party November
  ballot w/ a judicial contest alongside a full county ticket
  (2018/2020/2022 SOS directories 404; Wayback CDX 503). Fetch:
  code.wvlegislature.gov/pdf/ fine; live SOS portal
  (SampleBallots/Home/GetBallot?County=) currently serves the 2026
  primary; OmniBallot lookup per-voter.

### HI — Hawaii (FIPS 15) — GRADE A (scoped)

- Authority: HRS § 11-114 "Order of offices on ballot" ("shall be arranged
  substantially as follows: first, president and vice president … next,
  United States senators; next, United States house of representatives;
  next, governor and lieutenant governor; next, state senators; next, state
  representatives; and next, county offices") —
  https://www.capitol.hawaii.gov/hrscurrent/Vol01_Ch0001-0042F/HRS0011/HRS_0011-0114.htm
  (accessed 2026-08-16). OHA + measure placement = Office of Elections
  practice, documented in the official Candidate's Manual (manual
  republishes per cycle, re-pull each cycle): 2024 ed. p. 27,
  https://elections.hawaii.gov/wp-content/uploads/2024-Candidates-Manual.pdf;
  2026 ed. PDF p. 43 (printed page 37, "What's on the Ballot?"),
  https://elections.hawaii.gov/wp-content/uploads/2026-Candidates-Manual.pdf
  (63 pp, PDF metadata ModDate 2025-12-09; fetched + %PDF-verified +
  p. 43 read 2026-08-17: list runs US Rep → Governor → LtGov → State
  Senator → State Rep → OHA → County Mayor → County Councilmembers →
  state amendments → county charter amendments; NO US Senator, NO
  Prosecuting Attorney bullet).
  Supporting: HRS § 11-115 (joint Gov/LtGov box), § 11-112(b) (questions),
  § 11-3 (chapter binds county elections), § 13D-4(c)-(d) (OHA statewide),
  HAR § 3-172-71 (no order provision).
- Office order: President → US Senator → US Rep → Governor & LtGov (JOINT
  ticket, single box, § 11-115(d) "only one box shall be formed opposite
  their set of names") → State Senator → State Rep → OFFICE OF HAWAIIAN
  AFFAIRS trustees (own top-level section banner, statewide nonpartisan,
  every voter votes all seats) → County Mayor → County Prosecuting Attorney
  → County Councilmember → state constitutional amendments → county charter
  amendments. OHA sits between legislature and county — baseline has no
  slot for it.
- Judicial: EMPTY — Hawaii elects zero judges. HI Const. art. VI § 3:
  gubernatorial appointment from Judicial Selection Commission list;
  retention by the commission, not voters ("every justice and judge shall
  petition the judicial selection commission to be retained"). Zero
  judicial contests across 1,064 pages of 2022+2024 ballot proofs.
- Measures: LAST, reverse side; sub-order state constitutional amendments
  FIRST, county charter amendments SECOND (246/247 second-side pages 2024;
  sole exception Kalaupapa precinct 13-09 = state-only, Kalawao has no
  county government). HI Const. art. XVII § 3 "upon a separate ballot"
  satisfied by the separate reverse-side section.
- County discretion: none. HRS § 11-3 binds county elections; one
  consolidated state+county ballot printed centrally by the Office of
  Elections (§ 11-119). Section order machine-identical across all 494
  pages (2024) + 570 pages (2022), all four counties, zero exceptions.
- School/special: NONE. BOE appointed since 2011 (HI Const. art. X § 2, am.
  Nov 2010). No incorporated municipalities, no elected special districts —
  four counties are the only local tier.
- Corroboration: official ballot proofs, all 4 counties ×2 cycles —
  https://elections.hawaii.gov/wp-content/uploads/2024-General-Ballot-Proofs.pdf
  (494 pp) +
  https://elections.hawaii.gov/wp-content/uploads/2022-General-Ballot-Proofs.pdf
  (570 pp), %PDF-verified, cross-checked vs per-precinct samples
  (FAX001_0501/FAX001_1801). Observed section sequences ONLY ever Federal →
  State → OHA → County; 2022 Honolulu 18-01 shows "Governor and Lieutenant
  Governor" as one contest.
- Baseline delta: override. (1) OHA tier inserted between state house and
  county; (2) municipal + school + judicial tiers all EMPTY; (3) measures
  split state-amendments-then-county-charter. Baseline federal → executive
  → legislature → county spine otherwise holds.
- GRADE SCOPE: A covers Federal → State → OHA → County → state amendments
  → county charter (the tiers the proofs actually carry — 247/247 front
  pages machine-swept, zero exceptions). EXCLUDED: the County Prosecuting
  Attorney slot (Mayor → PA → Council) — manual-only, NEVER observed:
  zero PA contests in 2024 proofs AND 2022 proofs (all "Prosecuting
  Attorney" hits in 2022 are inside charter-question text), and the 2026
  manual drops the bullet entirely.
- Notes: § 11-114 is SILENT on OHA and measures and says "substantially as
  follows" (permissive) — those legs rest on the agency manual + 2-cycle
  zero-exception proofs; a verifier will not find a statutory cite, and
  the manual itself MIS-ATTRIBUTES the OHA/measure placement to
  §§ 11-114/11-115 (neither mentions them) — verify-pass finding. County
  contests routinely vanish from generals (primary majority = elected
  outright, HRS § 12-41 area — 2024: no-county districts are exactly 13
  (Kalaupapa) + 18-51 (Oahu); district 17 is Kaua'i and prints a county
  block). 2026 manual (p.43): no US Senator (no seat up), no PA bullet;
  Gov/LtGov as two bullets = primary only, joint box is general-only
  (§ 11-115(a)(3),(d)). Composite order assembled from statute + 2
  manuals — no single ballot shows every tier. Babson v. Cronin (138 H.
  228, 2016) suggests some OOE ballot practices are unpromulgated rules
  — not chased. Fetch: capitol.hawaii.gov 403s direct AND now via
  r.jina.ai (Cloudflare interstitial) — Claude Browser pane is the
  working route; elections.hawaii.gov 403s WebFetch → curl + Chrome UA;
  Constitution path = 05-CONST (03-CONST silently returns site search —
  trap).

## Batch 5

### NH — New Hampshire (FIPS 33) — GRADE A (scoped)
- Authority: RSA 656:7 "Order of Offices" (Title LXIII ch. 656),
  https://gc.nh.gov/rsa/html/LXIII/656/656-mrg.htm (accessed 2026-08-16;
  gencourt.state.nh.us DNS is DEAD — gc.nh.gov serves identical paths).
  Exact text: "The order of the officers on the ballot shall be as
  follows: president and vice-president of the United States, governor,
  United States senator, representative in congress, executive
  councilor, state senator, state representative and county officers."
  (unamended since 1994). Supporting: RSA 656:1 (SOS prepares/delivers
  ALL state ballots at state expense), 656:5 (party-column layout +
  statewide column rotation by senate district), 656:5-a (candidate
  name order via published random seed), 656:6 (offices column
  immediately LEFT of party columns, each prefixed "For"), 656:7-a
  (state-rep districts ascending numeric), 656:13 + RSA 663:1
  (questions after/beneath the offices column), 656:14/663:2/656:15
  (optional separate colored constitutional ballot), 656:16-18
  (uniformity, town name, samples); RSA 669:1 III + 671:2 + 670:1
  (no town/school/village elections with the biennial); RSA 661
  (elected county offices); RSA 7:1 (AG appointed); N.H. Const. Pt. 2
  Art. 67 (Secretary + Treasurer by legislative joint ballot), Art. 71
  (elected county officers), Art. 73 (judges hold office during good
  behavior).
- Office order: PARTY-COLUMN ballot (offices column left, party columns
  across; party-column left-right order ROTATES statewide by senate
  district — RSA 656:5 II-IV; contest order unaffected). Sequence per
  RSA 656:7: President/VP → GOVERNOR → US Senator → Representative in
  Congress → Executive Councilor → State Senator → State Representative
  (districts ascending, 656:7-a) → county officers (statute names no
  internal order). Governor = SLOT 2, ahead of BOTH US Senator and US
  House. Governor is the ONLY elected statewide exec (no Lt. Gov;
  SOS/Treasurer legislative; AG appointed); Executive Councilor =
  5-district office between US House and State Senate.
- Judicial: NONE ELECTED — positive finding: RSA 656:7's list is
  closed, no judicial office; Const. Pt. 2 Art. 73 good-behavior
  tenure (appointed via Governor + Executive Council). Confirmed by
  absence on Dover 2022 + 2024. CODER CAUTION: "Register of Probate"
  IS on the ballot — elected COUNTY records office (Const. Art. 71),
  NOT a judge; never classify judicial.
- Measures: last, after all offices — RSA 656:13 ("following the
  offices columns") + 663:1 ("beneath the offices column"). Separate
  colored constitutional ballot possible (656:14/663:2/656:15, amended
  2024) but BOTH recent cycles printed questions on the state ballot:
  2024 = CACR 6; 2022 = CACR (Arts. 71/81) then the decennial Art. 100
  convention question. Local-option questions (liquor 663:5, lottery
  663:7) print in the same after-offices slot on petition.
- County discretion: none — SOS prepares and delivers every ballot
  (656:1), towns only verify/reseal the package (656:20); zero
  town/county say over contest order.
- School/special: NOT on the state ballot — RSA 669:1 III ("No town
  election shall be held in conjunction with the biennial election"),
  671:2 (same for school districts), 670:1 (village districts Jan-May).
  Narrow 671:2 exceptions (Concord + Laconia boards of education):
  CONCORD proven to run on a SEPARATE district ballot handed out
  alongside — 2024 "BALLOT 1 OF 2 — ABSENTEE OFFICIAL BALLOT — CONCORD
  SCHOOL DISTRICT — CITY OF CONCORD, NEW HAMPSHIRE"
  (https://www.concordnh.gov/DocumentCenter/View/22875/Concord-School-District-Sample-Ballot);
  LACONIA's separate-ballot treatment UNVERIFIED (presumed same
  pattern — see Notes). Either way nothing prints on the SOS state
  ballot itself.
- Corroboration: (1) DECISIVE: Dover 2020 general sample ballots (all
  6 wards, official archive, text layer, positional extraction),
  https://www.dover.nh.gov/Assets/government/open-government/election-information/2020-general-election/sample-ballots/GENERAL%20ELECTION%202020_Sample%20Ballots.pdf
  — the FULL RSA 656:7 ladder in one cycle: President/VP (y=154.5) →
  Governor (251.1) → United States Senator (299.0) → Rep in Congress
  (353.1) → Exec Councilor → State Sen → State Reps D13 → D19
  (656:7-a ascending); back: Sheriff → County Attorney → County
  Treasurer → Register of Deeds → Register of Probate → County
  Commissioners. (2) Dover Ward 1 2022 general,
  https://www.dover.nh.gov/Assets/government/open-government/election-information/2022-general/sample-ballots/Ward%201.pdf
  — Governor (y=189.7) ABOVE United States Senator (y=254.5) → Rep in
  Congress → Exec Councilor → State Sen → State Reps D14 → D21; back:
  county block → 2022 amendment questions last. (NH Senate cycles:
  Class II seat 2014/2020/2026, Class III seat 2016/2022/2028 — so the
  2020 general (Class II) and the 2022 general (Class III) both
  co-print Governor with a Senate race; 2024 alone carried none, so a
  2024-only corroboration could not test the Governor-above-Senator
  slot.) (3) Dover
  Ward 1 2024 (scanned, rendered + read visually),
  https://www.dover.nh.gov/Assets/government/open-government/election-information/2024-general-election/sample-ballots/DoverWard1.pdf
  — President/VP → Governor → Rep in Congress → … → full Strafford
  county block → CACR 6 last; confirms 656:7-a (D14 before D21).
  (4) Salem 2024 (second county, text layer),
  https://www.salemnh.gov/DocumentCenter/View/4636/November-5-2024---Sample-Ballot---Salem
  — same sequence; Rockingham ran ONLY County Commissioner in 2024
  (slate fact, not ordering fact). (5) Child-agent sweep, all
  %PDF-verified: Goffstown 2022
  (https://goffstownnh.gov/DocumentCenter/View/2570/Sample-Ballot),
  2020 (…/View/2591/Sample-Ballot — President → Governor → US Senator
  all three co-printed), 2024 (…/View/4274/Sample-Ballot-PDF);
  Merrimack 2024
  (https://www.merrimacknh.gov/sites/g/files/vyhlif3456/f/pages/2024_general_election_-_sample_ballot.pdf);
  Bow 2024
  (https://bownh.gov/DocumentCenter/View/7537/Sample-Ballot---2024-General-Election-Ballot)
  — identical office sequence across all. (6) SOS winners report (38pp,
  https://www.sos.nh.gov/sites/g/files/ehbemt561/files/documents/2024-11/winners-report-11.18.24.pdf)
  — identical sequence; all 10 counties use the same internal county
  order (fetched via r.jina.ai during research; verify round found
  sos.nh.gov 403 via BOTH curl and r.jina.ai — the jina route is
  intermittent; leg re-confirmable via browser pane). All %PDF-verified
  2026-08-16. NO statute-vs-sample conflict.
- GRADE SCOPE: A covers the RSA 656:7 ladder (incl. Governor slot 2),
  questions-last, empty municipal/school/village/judicial tiers.
  EXCLUDED from A: county-block INTERNAL order (Sheriff → County
  Attorney → County Treasurer → Register of Deeds → Register of
  Probate → County Commissioner) — statute says only "county
  officers"; order rests on Dover 2022+2024 + Goffstown ×3 cycles +
  the SOS 10-county winners report. Reliable convention (SOS prints
  every ballot) but below-tier granularity anyway — encode nothing.
- Baseline delta: (1) GOVERNOR PROMOTED TO SLOT 2 — before US Senate
  and US House; statutory + printed (stronger than ME's version, which
  puts Gov after US Senate); (2) municipal, school, village-district,
  judicial tiers ALL EMPTY by statute; (3) Executive Councilor
  occupies the exec slot (district-elected); otherwise
  baseline-conforming (state senate → house → county → measures last).
- Notes: party-column rotation + candidate-seed rotation (656:5-a,
  2026-2028 table published) = informational. Primary same office
  order ("as nearly as practicable", 656:23). Salem 2024 county block =
  County Commissioner only (verified both sides). Open (recorded):
  Const. Art. 46 body unfetchable (TOC only on nh.gov — finding rests
  on Art. 73 + closed 656:7 list); separate colored constitutional
  ballot never observed in practice; Laconia exception unverified
  (presumed separate-ballot like Concord); Manchester/Nashua faces not
  obtained (Hillsborough covered via Goffstown + Merrimack). CLOSED by
  verify round: RSA 656:4-a's full heading is "Candidates for the
  Office of United States Senator and United States Representative.
  [Omitted.]" — a candidacy provision, not order-related.
  Fetch gotchas: gc.nh.gov wrong-title paths return HTTP 200 with an
  ~18.8KB 404 HTML page (size-match tell); RSA 669/670/671 under Title
  LXIII not LXIV; sos.nh.gov hard-403s curl/WebFetch — browser pane or
  r.jina.ai (PDFs incl.); mm.nh.gov = Akamai — UA alone insufficient,
  needs FULL Chrome header set (sec-ch-ua + Sec-Fetch-* + Referer);
  nh.gov constitution pages render only some article bodies via jina
  AND browser; CivicPlus DocumentCenter needs the full /View/<id>/<slug>
  (bare id returns HTML); concordnh.gov/bedfordnh.org purge to current
  cycle — dover.nh.gov keeps a full archive back to 2014 (best NH
  source); merrimacknh.gov HTML Cloudflare-403 but PDF paths open;
  NH Election Procedure Manual (301pp/18.5MB) has ZERO ballot-order
  content — don't burn the download.

### ME — Maine (FIPS 23) — GRADE A (scoped)
- Authority: 21-A M.R.S. §601 "Ballot preparation", subsec. (3) "Order of
  offices" verbatim: "President, United States Senator, Governor,
  Representative to Congress, State Senator and Representative to the
  Legislature, and the county offices in the following order: judge of
  probate, register of probate, county treasurer, register of deeds,
  sheriff, district attorney and county commissioner, except that the
  order may be modified to allow ranked-choice contests to be printed on
  the opposite side of the ballot…" [PL 2021, c. 273, §10],
  https://legislature.maine.gov/statutes/21-A/title21-Asec601.html
  (accessed 2026-08-16). Supporting: §601(1) RCV contests "must be
  grouped together"; §601(2)(B) alphabetical candidate order (no
  rotation); §604-A SOS MAY combine candidate/referendum/municipal
  ballots (discretionary); §906(1-A) referendum questions MAY share the
  candidate ballot "as determined by the Secretary of State"; §906(7)
  question order; §606 SOS furnishes state ballots; 30-A §2528(5)
  municipal clerk prepares municipal ballots. Me. Const. via official
  PDF https://legislature.maine.gov/doc/10674: art. V pt.1 §8 (Governor
  appoints all judicial officers EXCEPT probate judges/JPs), art. VI §6
  (probate judges/registers elected by county, 4-yr — 1967 conditional
  repeal never triggered), art. V pt.2 §1 + pt.3 §1 + art. IX §11
  (SOS/Treasurer/AG chosen by legislature).
- Office order: §601(3): President → US Senator → GOVERNOR → Rep. to
  Congress → State Senator → State Rep → county block in fixed order:
  judge of probate → register of probate → county treasurer → register
  of deeds → sheriff → district attorney → county commissioner. Maine
  elects NO other statewide executive (no Lt. Gov; SOS/Treasurer/AG =
  legislative joint ballot) — baseline exec tier otherwise EMPTY. In
  print the ballot is two-sided: RCV federal contests (Pres → US Sen →
  US House, statutory relative order kept) grouped on the BACK side per
  the §601(3) exception; side A starts at State Senator. SOS 2026
  Office Listing adds ACF/KCB/ACC county bodies after County
  Commissioner (statute silent — unconfirmed as ballot position).
- Judicial: only elected judicial office = Judge of Probate — NOT late,
  it HEADS the county block right after State Rep (Register of Probate
  = clerk office, follows). No general-jurisdiction judge elected.
- Measures: SEPARATE statewide "Referendum Election" ballot in practice
  (2024: distinct Style 1R ballot, Questions 1-5) — statute permissive
  not mandatory (§906(1-A) + §604-A SOS discretion; former separate-
  ballot mandate §906(1) repealed 1997). Question order fixed by
  §906(7): carry-overs → people's vetoes → initiatives → bond issues →
  constitutional amendments → other legislative referenda; random
  in-group order drawn in public; sequential numbering. Corroborated
  2024 guide (Q1 initiative, Q2-4 bonds, Q5 referendum) + 2023 guide
  (Q1-4 initiatives, Q5-8 amendments). County referenda ride the state
  referendum ballot (Somerset 2024 variant).
- County discretion: none — SOS prepares all state ballots (§§601, 603,
  606); county offices slotted by §601(3). Municipal ballots = separate
  clerk-prepared instrument (30-A §2528).
- School/special: NOT on the state ballot — school board + municipal
  contests/questions run on the municipality's own ballot (observed:
  South Portland 2024 = three ballot families — State General, State
  Referendum, Municipal General & Referendum w/ School Board + school
  bonds).
- Corroboration: Lewiston (Androscoggin) official clerk PDFs, Nov 2024,
  all %PDF-verified 2026-08-16: Style 176 front
  (https://www.lewistonmaine.gov/DocumentCenter/View/17321) — State
  Senator D21 → State Rep D93 → Register of Probate → County
  Commissioner D1; Style 179 back
  (https://www.lewistonmaine.gov/DocumentCenter/View/17320) —
  President/VP → US Senator → Rep. to Congress D2, RCV columns; Style 1R
  referendum ballot
  (https://www.lewistonmaine.gov/DocumentCenter/View/17329) — Questions
  1-5 separate. South Portland matches (three-family structure; ballots
  image-only rasters). SOS county-cycle PDF column order matches
  §601(3) county block. SOS 2020 York/Abbot RCV samples show the RCV
  block as its own page in an earlier cycle. GUBERNATORIAL-YEAR GENERAL
  faces (verify-round child, all %PDF-verified, image-only — rendered +
  read visually): 2022 Skowhegan Style 263
  (https://skowhegan.org/DocumentCenter/View/5799/State-of-Maine-General-Election-Ballot)
  + Gorham W1 Style 143
  (https://www.gorham-me.org/sites/g/files/vyhlif4456/f/uploads/ward_1-1_1-2_state_ballot.pdf)
  — Governor tops the plurality side (Governor → State Sen → State
  Rep | county column), Rep. to Congress alone on the RCV side; 2018
  Skowhegan Style 257
  (https://www.skowhegan.org/DocumentCenter/View/4282/State-of-Maine-November-2018-General-Election-Ballots)
  + Appleton Style 15
  (https://appleton.maine.gov/vertical/sites/%7B5CBE9B20-93F0-4ECA-B07C-188D88398A31%7D/uploads/2018_-_Sample_Election__Ballots(1).pdf)
  — RCV side prints US SENATOR then REP. TO CONGRESS (§601(3) relative
  order inside the RCV block, in a GENERAL); plurality side Governor →
  State Sen → State Rep | County Treasurer → Register of Deeds →
  Sheriff → DA → County Commissioner. In the RCV era Governor and Rep.
  to Congress NEVER share a printed column — direct print confirmation
  that the Governor/US-House adjacency is physically untestable on a
  general face (backs the GRADE SCOPE reasoning).
- GRADE SCOPE: A covers the full §601(3) ladder INCLUDING
  Governor-before-US-House (restored by the verify round — see Notes
  for the resolved false conflict), the federal internal order within
  the RCV block, state senate → state house → county block internal
  order, probate-judge-heads-county placement, and the
  measures-question ordering (§906(7)). Governor-leg evidence chain:
  §601(3) verbatim + the SOS's own 2026 Primary Candidate List xlsx
  (office sequence US → GOV → CG → SS → SR → JP → RP → CT → RD → SH →
  DA → CC = §601(3) order) + PRINTED June 2026 primary ballots on
  official municipal hosts — Blue Hill Style 46D
  (https://bluehillme.gov/wp-content/uploads/2026/05/Democratic-Sample-Ballot.pdf:
  US Senator y=382.7 → GOVERNOR y=615.2 → Rep. to Congress y=900.3)
  and Paris Style 194D
  (https://parismaine.org/uploads/sample-ballots-6-9-26.pdf: same
  sequence, second county) — both SOS-prepared "State of Maine Sample
  Ballot" style ballots. CAVEAT recorded: primary faces, not general;
  but §601 governs ballot preparation for both stages, and in a
  GENERAL the §601(3) RCV exception moves the federal contests to the
  opposite side — Governor and US House may NEVER print adjacent on a
  general face, so a general-print demand would exclude this leg
  permanently on a physical-layout artifact. The override encodes
  LOGICAL contest order, which §601(3) fixes and the SOS demonstrably
  follows. EXCLUDED from A: measures-separate-ballot as a durable
  rule — SOS discretion under §604-A/§906(1-A), reversible per cycle
  (record, don't encode); ACF/KCB/ACC placement (statute silent).
- Baseline delta: (1) Governor between US Senate and US House — IN the
  A scope (statute + SOS listing practice + 2026 primary print);
  (2) exec tier otherwise EMPTY; (3) judicial never late — probate
  judge leads the county block; (4) no municipal/school tiers on the
  state ballot; (5) measures not on the candidate ballot at all
  (separate statewide referendum ballot, SOS practice — excluded from
  A as a durable rule); (6) physical reading order differs from
  logical order (RCV federal block grouped on the other side — the
  state/county side starts at State Senator; which side is physically
  "front" is not printed — inference).
- Notes: candidate order alphabetical, never rotated (§601(2)(B)).
  "Style No." system = SOS ballot-style practice (the word "style"
  appears nowhere in §601; §601(4) authorizes distinctive COLOR
  markings per single-member district — verify round fixed the
  misattribution). Lewiston styles 176 and 179 are DIFFERENT ballot
  styles (SR D93 vs SR D96), each one side, both printing "Turn Over
  for Additional Contests" — not two sides of one sheet. RESOLVED
  FALSE CONFLICT (verify round): the SOS
  "2026 Candidate Office Order" PDF
  (https://www.maine.gov/sos/sites/maine.gov.sos/files/inline-files/2026%20Candidate%20Office%20Order.pdf)
  that appeared to reverse §601(3) (Rep-to-Congress before Governor)
  is internally titled "2026 Office Listing of Candidates Guide" — an
  Excel-produced staff ABBREVIATION table ("Office Abbreviation" /
  "Office Order" columns, no ballot language, even uses "JB" for Judge
  of Probate where real lists use "JP"), and the SOS's own 2026
  Primary Candidate List xlsx follows §601(3) order — the guide is not
  ballot-order evidence, conflict dead. Probate-judge-heads-county now
  PRINTED: Orland 190R 2026 primary p2 (Judge of Probate y=235.6 →
  Register of Deeds → Sheriff,
  https://cdn.townweb.com/townoforland.org/wp-content/uploads/2026/05/DOC097.pdf
  — path resolved + %PDF-verified 2026-08-16) + Blue Hill
  46D p2 (Judge of Probate → County Treasurer → Sheriff). Open
  (recorded): full 7-office county block never co-printed on one face
  (staggered terms); ACF/KCB/ACC placement unconfirmed; §604-A combine
  power never observed exercised; RCV block back-side vs own-sheet
  varies by cycle. Fetch gotchas: Maine
  Constitution = PDF at legislature.maine.gov/doc/10674 (/const/ is a JS
  shell; guessed paths 404); apps.web.maine.gov sample-ballot PDFs
  ephemeral (soft-404 HTML — check %PDF; directory 403s);
  portlandmaine.gov TLS-intercepted (curl -k) + r.jina.ai 403;
  Revize-CMS towns (yarmouth.me.us) delete old ballot PDFs but page text
  survives; South Portland DocumentCenter ballots = pure raster (render
  pages); CivicPlus DocumentCenter/View/<id> undated — date from PDF
  header text.

### MT — Montana (FIPS 30) — GRADE A
- Authority: MCA 13-12-207 "Order of placement" (MCA 2025) — complete
  contest-order rule, self-contained in statute,
  https://mca.legmt.gov/bills/mca/title_0130/chapter_0120/part_0020/section_0070/0130-0120-0020-0070.html
  (accessed 2026-08-16; NOTE current MCA host = mca.legmt.gov; leg.mt.gov
  301s to the archive.legmt.gov snapshot). Companions: 13-12-202 (SOS
  uniform ballot-form rules; amended Ch. 214, L. 2025), 13-14-212
  (retention form for unopposed judges), 13-12-205 (candidate rotation
  ONLY — not contest order; the plan's starting pointer was off by two),
  13-1-104 (odd-year municipal generals), 20-20-105 (May school
  elections), 13-1-504 (special-district dates; (2)(b) conservation
  districts must use primary/general day). STALENESS CLOSED (verify
  round): 13-12-207's History line ends "amd. Sec. 28, Ch. 242, L.
  2011" — unamended since 2011, so the 2021-revision SOS layout doc
  cannot be stale as to contest order. Admin layer: ARM 44.3.2408
  contains NO ordering text (rules.mt.gov = Esper SPA, API 403s; MAR
  Notice 44-2-181,
  https://sosmt.gov/wp-content/uploads/attachments/44-2-181pro-arm.pdf,
  is the 2013 PROPOSAL-hearing notice naming only "New Rule I" — the
  44.3.2408 identification is inference, not sourced text) — the
  operative document is the SOS "Ballot Form and Uniformity Pursuant
  to 13-12-202, MCA — Ballot Layout Instructions and Sample Ballots"
  (Revised 2021-12-16),
  https://sosmt.gov/docs/23/elections/57464/ballot-layout-instructions-and-sample-ballots
  (%PDF-verified, 16 pp; PDF p.7 restates 13-12-207 under "ORDER OF
  PLACEMENT OF OFFICES ON THE BALLOT"; byte-identical mirror:
  https://archive.legmt.gov/content/Committees/Interim/2023-2024/State-Administration-and-Veterans-Affairs/Rules/4.3-Ballot-Form-and-Uniformity-Pursuant-to-13-12-202-MCA.pdf).
- Office order: "FEDERAL AND STATE" block (one heading per SOS layout doc,
  "down to and including the legislative offices"): (a) President/VP
  (presidential years) → (b) US Senator → (c) US Representative →
  (d) Governor & Lt. Gov (joint oval) → (e) SOS → (f) AG → (g) State
  Auditor → (h) Supt of Public Instruction → (i) Public Service
  Commissioners → (j) Clerk of the Supreme Court (elected AND PARTISAN —
  2024 ballot shows party labels) → (k) Chief Justice → (l) Supreme Court
  Justices → (m) District Court Judges → (n) State Senate → (o) State
  House. Then "COUNTY" heading, 13-12-207(2): clerk of district court →
  county commissioner → clerk and recorder → sheriff → coroner → county
  attorney → county supt of schools → auditor → public administrator →
  assessor → treasurer → surveyor → justice of the peace. Unlisted
  offices: SOS designates placement EXCEPT municipal/charter/consolidated
  + wholly-in-county district offices = election administrator
  (13-12-207(3)). (5): absent offices omitted, relative order maintained.
  (6): full term before unexpired term.
- Judicial: MID-BALLOT, not late — biggest MT deviation. State judicial
  (Clerk of Supreme Court → Chief Justice → Justices → District Judges)
  prints inside FEDERAL AND STATE, after PSC and BEFORE the legislature.
  Nonpartisan (Title 13 ch. 14) but NOT a separate section — "NONPARTISAN"
  is just the label line; SOS layout doc explicit: general election
  interleaves ("not at the end of the ballot"). Judiciary SPLIT: Justice
  of the Peace = LAST county office. RETENTION: 13-14-212 — sole-candidate
  judicial office converts IN PLACE to yes/no question (no separate
  retention section).
- Measures: last, "BALLOT ISSUES" heading — 13-12-207(4): constitutional
  amendments → statewide referenda/initiatives → local (county/municipal/
  school/subdivision) issues in administrator-designated order. Statewide
  sequence = as certified by SOS; abbreviated statewide issue language
  prohibited.
- County discretion: narrow, express — administrator orders ONLY
  municipal/charter/consolidated offices, wholly-in-county district
  offices, and local ballot issues after statewide measures
  (13-12-207(3),(4)). Federal/state/county sequence locked by statute.
- School/special: NO school block in November — school elections are May
  (20-20-105(1)); school ballot ISSUES can reach November in the
  local-issues tail. Special districts elect in May (13-1-504(1)) except
  conservation districts (primary/general day — 13-1-504(2)(b), placed
  per 13-12-207(3)). NO municipal block in even Novembers (13-1-104
  odd-year municipal generals).
- Corroboration: three legs, zero conflicts, all fetched + %PDF-verified
  2026-08-16. (1) Lincoln County official 2024 general ballot (Libby 9
  style),
  https://lincolncountymt.us/wp-content/uploads/2024/10/2024-General-Sample-Ballot.pdf
  — full sequence incl. partisan Clerk of Supreme Court then NONPARTISAN
  Supreme Court contests ABOVE State Rep; county block; CI-126 → CI-127 →
  CI-128 last. (2) Lewis and Clark County 2024 publication ballot,
  https://www.lccountymt.gov/files/assets/county/v/1/treasurer-clerk-and-recorder/documents/elections/sample-ballots/2024-general-ballot.pdf
  (host 403s plain curl/WebFetch — needs full browser header set) — adds
  District Court Judge retentions between Justice #3 and State Senator,
  and JP retention as last county office before BALLOT ISSUES. (3) MT SOS
  2024 General Election Report State Canvass,
  https://sosmt.gov/docs/31/post-election/66775/2024-general-election-report-state-canvass
  (23 pp) — statewide contests tabulated in ballot order, retention
  wording verbatim. Cascade 2024 unofficial results (scanned,
  https://www.cascadecountymt.gov/DocumentCenter/View/6081/2024-General-Election-Unofficial-Results-Election-Night_001)
  = third-county consistency check. Verify round independently replayed
  both ballot faces (L&C via the full-browser-header route) — District
  Judge retentions between Justice #3 and State Senator, and JP-last,
  both exact.
- Baseline delta: (1) judicial mid-ballot between statewide execs/PSC and
  legislature (baseline late) — largest deviation; (2) judiciary split (JP
  = last county office); (3) partisan Clerk of Supreme Court heads
  judicial run (no baseline slot); (4) PSC closes exec block; (5) NO
  municipal or school office blocks in even-year November (empty tiers,
  not reordered); (6) matches baseline: federal head, senate before
  house, county after legislature, measures last (amendments →
  referenda/initiatives → local).
- Notes: 13-12-205 = rotation (alphabetical then rotated; Pres/VP +
  Gov/LtGov rotate as groups) — informational only. Open (recorded):
  local-issues-after-statewide = statute+manual only, no 2024 sample
  carried a local measure (Gallatin 2024 would close it — file removed,
  Wayback 503 all session); current ARM 44.3.2408 text unverified
  (SPA/403; amendments 44-2-269/-274 tokenized links expired) — not
  load-bearing, rule only incorporates SOS guidelines; SOS layout doc
  edition = 2021-12-16 revision (2024 ballots match it); county-list
  middle offices (sheriff/coroner/attorney/treasurer/public admin)
  statute-only in 2024; amendments-vs-referenda internal split untested
  (2024 slate = CI-126/127/128 only, per
  https://sosmt.gov/elections/ballot_issues/proposed-2024-ballot-issues);
  CI-132 (Nov 2026, judicial nonpartisanship) affects labels not
  sequence. Fetch gotchas: mca.legmt.gov pages carry anti-bot JS prelude
  (strip ~600 chars); populous counties (Yellowstone/Missoula/Flathead/
  Gallatin) purged 2024 samples — small counties + capital county still
  host; sosmt.gov stable paths = /wp-content/uploads/ + /docs/<id>/…
  (ARM-index admin-ajax links tokenized, expire).

### RI — Rhode Island (FIPS 44) — GRADE A (scoped)
- Authority: R.I. Gen. Laws § 17-19-6 ("Ballot — Arrangement") delegates
  order to the SOS — "The diagram shall determine the manner and order in
  which the ballot shall be arranged"
  (https://webserver.rilegislature.gov/Statutes/TITLE17/17-19/17-19-6.htm,
  accessed 2026-08-16; host needs Chrome UA + -L; chapter indexes =
  INDEX.HTM uppercase, sections lowercase .htm); § 17-5-5(a) SOS
  design/content rulemaking. Exercised in 100-RICR-20-00-1 "Placement of
  Candidates and Local Referenda/Questions on Election Ballots"
  § 1.4(C) "Order of the Races on the Ballot" — ACTIVE, effective
  2022-01-04 (technical refile, no text change; e-signed 2021-12-03 under
  SOS Gorbea): HTML https://rules.sos.ri.gov/regulations/part/100-20-00-1
  + official filed PDF
  https://risos-apa-production-public.s3.amazonaws.com/SOS/REG_11522_20211203215616.pdf
  (%PDF-verified, 14 pp, matches HTML verbatim; accessed 2026-08-16).
  Board of Elections rules (410-RICR-20-00-*) touch nothing on contest
  order — no competing authority.
- Office order: § 1.4(C)(1) verbatim: a. Presidential Electors → b. US
  Senator → c. US Representative → d. Governor → e. Lt. Governor →
  f. Secretary of State → g. Attorney General → h. General Treasurer →
  i. Senator in General Assembly → j. Representative in General
  Assembly → k. Local Offices ("in the order certified by local board of
  canvassers") → l.-p. party-committee offices (PRIMARY ONLY). Execs
  (d-h) = § 17-2-1 "general officers", quadrennial (2022/2026) — absent
  from 2024 faces, supplied by the 2022 compendium.
- Judicial: NO state judge elected — R.I. Const. Art. X §§ 4-5
  (nominating commission + life tenure,
  https://www.rilegislature.gov/riconstitution/Constitution/C10.aspx).
  TWO local exception classes (verify round widened this): (1) § 8-9-4
  town-elected Judge of Probate — compendium full-text scans found
  exactly one town in BOTH cycles, TIVERTON (2024 pp. 921-933; 2022
  pp. 959-971), INSIDE the local block mid-sequence (Council → Clerk →
  [Treasurer] → Judge of Probate → School → Budget); (2) Const. Art. X
  § 7 (inside "OF THE JUDICIAL POWER"): New Shoreham/Jamestown Wardens
  + town Justices of the Peace — First/Second Warden print only in New
  Shoreham (2024 p. 481, 2022 p. 377), mid-local-block; ZERO Justice
  of the Peace contests in either compendium. Nothing judicial ever
  prints late.
- Measures: last, statewide before local, CONTINUOUS numbering across
  the boundary — § 17-19-6.1 (statewide "numbered consecutively starting
  with the numeral I", locals "follow starting with the first available
  number", local questions on "a distinctive colored background") +
  § 17-5-5(a). Local-question internal order = municipality
  (100-RICR-20-00-1 § 1.16 Appendix D: "The order in which
  referenda/questions are listed below will be the order in which they
  will appear on the ballot"). Confirmed: Providence 2024 State Q1-5 →
  Local Q6; Cranston 2024 State 1-5 → Local 6-7.
- County discretion: none — RI has NO county government (Art. XIII home
  rule = cities/towns only; sheriffs state-appointed § 42-29-1; "County"
  appears zero times in the rule). Order fixed statewide by SOS for
  slots a-j; only local discretion = internal sequence of slot k + local
  questions.
- School/special: school committees ON the November ballot (§ 16-2-5,
  five charter carve-outs) but as LOCAL OFFICES inside slot k — placement
  is the local board's choice, commonly last but NOT guaranteed
  (Barrington/Cranston school last; Tiverton prints Budget Committee
  after it; New Shoreham prints Land Trust/Housing Board around it).
  Special districts seen in slot k: Fire Committee, Chariho regional
  school, Budget Committee, Land Trust, Housing Board.
- Corroboration: BOE statewide compendiums (every precinct, every
  municipality; curl-open, ~11MB each, real text layer). 2024 general:
  https://elections.ri.gov/sites/g/files/xkgbur756/files/2024-10/Gen%202024%28Mail%20Ballot%20Sample1%29.pdf
  (1,164 pp) — Providence 2801 (pp. 689-690) + Cranston 0701
  (pp. 143-144) + Tiverton (pp. 921-933) + New Shoreham (p. 481). 2022
  general (gubernatorial — supplies d-h):
  https://elections.ri.gov/sites/g/files/xkgbur756/files/2024-12/RIGEN22_Sample.pdf
  (1,144 pp) — Barrington p.1: Gov → LtGov → SOS → AG → General
  Treasurer exact § 1.4(C) match. Municipal cross-check:
  https://www.barrington.ri.gov/DocumentCenter/View/1890/Sample-Ballots-2024-November-Election.
  All fetched + %PDF-verified 2026-08-16. No conflicts.
- GRADE SCOPE: A covers slots a-j (federal head → execs → General
  Assembly), local-offices-after-state, and statewide-questions-before-
  local-questions (§ 17-19-6.1 numbering + Appendix D + samples).
  EXCLUDED from A: (1) internal order of slot k (local offices incl.
  school committee placement) — genuine local option by rule text,
  varies in print (encode nothing below state house);
  (2) questions-AFTER-offices position per se — verify-round ruling:
  § 17-19-6.1 and § 17-5-5(a) are NUMBERING statutes and § 1.4(C)
  ("Order of the Races") enumerates offices only, so the leg is
  argument-from-silence + practice = B-class. Practice evidence is
  overwhelming (verify round ran statewide scans: 544 contest pages
  2024 + 498 2022 with ZERO ladder violations; 668 + 678 question-
  bearing pages with ZERO office-after-question violations) but there
  is no authority sentence. NO CODE CONSEQUENCE — measures-last
  matches the baseline anyway (DE precedent).
- Baseline delta: (1) county tier ABSENT entirely; (2) judicial never
  late (zero state judges; lone probate judge = municipal mid-block);
  (3) school NOT a fixed tier — inside the local bucket, per-town order;
  (4) rest matches baseline exactly: President → US Senate → US House →
  execs (Gov, LtGov, SOS, AG, Treasurer) → state senate → state house →
  municipal → measures last w/ state-before-local.
- Notes: ballot = 3 columns/side, 2 sides, column-major reading —
  questions can start in front-side column 3 (layout, not order).
  Within-contest placement (endorsed first, lottery, § 17-19-9.1
  independents below party) = informational. AUTHORITY-CHAIN label
  (verify round): the § 17-19-6 + § 17-5-5(a) chain is the campaign's
  reconstruction — the RICR page's own "Regulation Authority" line
  cites Ch. 17-28 (Address Confidentiality, §§ 1-8 all repealed — an
  RICR data-entry error) and the rule's § 1.1 cites only the APA
  (Ch. 42-35); § 17-5-5(a) PRESUPPOSES SOS ballot-design rulemaking
  ("Notwithstanding the authority of the secretary of state to
  determine the design and content…") rather than granting it.
  § 17-19-6 "diagram" hunt CLOSED: by the statute's own words the
  diagram "shall be a copy of the actual computer ballot", held by the
  warden on election day — no published standalone instrument exists;
  100-RICR-20-00-1 (+ its Appendix A/B/C layout figures, "for
  Illustration Purposes Only") is the published binding arrangement
  instrument, and the published sample ballots are the diagram's
  online equivalent. § 16-2-5 ties school-committee elections to the
  regular city/town election, not to November per se (charter towns
  vary). Open (recorded): § 17-19-6.1 local-questions-without-
  statewide edge structurally unobservable (both cycles carried
  statewide questions); no pending-amendment docket check under SOS
  Amore. Fetch
  gotchas: vote.sos.ri.gov + www.sos.ri.gov HTML = Cloudflare 403 (curl,
  WebFetch, AND r.jina.ai — browser pane only) but PDF paths on the same
  hosts bypass the wall (curl 200); elections.ri.gov fully curl-open =
  best RI source (/elections/publications, compendiums back to 2020);
  RICR title trap: Dept of State elections = Title 100 ch. 20 (Title 400
  = Board of Accountancy); every RICR part has an official filed PDF on
  risos-apa-production-public.s3.amazonaws.com; RI Constitution NOT on
  webserver.rilegislature.gov (404) — use
  rilegislature.gov/riconstitution/Constitution/CNN.aspx; compendiums
  exceed WebFetch 10MB cap (curl to disk).

### DE — Delaware (FIPS 10) — GRADE A (scoped)
- Authority: 15 Del. C. § 4502 "Form and designation of ballots",
  https://delcode.delaware.gov/title15/c045/index.html (accessed
  2026-08-16), verified against the authenticated title PDF
  https://delcode.delaware.gov/title15/Title15.pdf (§ 4502 at PDF
  pp. 72-73 — proves the HTML design table is NOT truncated). § 4502(c)
  design table lists IN ORDER: For President / For Vice-President / For
  United States Senator / For Representative in Congress / For
  Governor / For Lieutenant Governor — THE TABLE ENDS THERE. § 4502(a)(4)
  President at top; § 4502(a)(2) ballot titles; § 4501 single ballot;
  § 4502(e) residual layout discretion = STATE (Department + Election
  Commissioner approval), never county. NEGATIVE sweeps (primary): full
  Title15.pdf sweep — no other ordering provision anywhere in Title 15;
  DE Admin Code Title 15 has exactly THREE regulations (100 Campaign
  Finance, 101 Audit Discrepancies, 200 Absentee Security — enumerated
  via the site's JSON API), none on ballot order.
- Office order: statutory ladder = President/VP → US Senator → US Rep →
  Governor → Lt. Governor. BELOW LtGov statute silent; printed practice
  (11 ballots, 3 cycles, identical): remaining statewide execs → State
  Senator → State Representative → county tier → municipal tier
  (Wilmington only, presidential years). 2024: … LtGov → Insurance
  Commissioner → State Sen → State Rep → county → Wilmington. 2022
  midterm: US Rep → AG → Auditor of Accounts → State Treasurer → State
  Sen → State Rep → county. Exec internal order consistent w/ Del.
  Const. art. III § 21 listing but UNPROVABLE — AG/Auditor/Treasurer
  (midterm cycle) and Insurance Commissioner (presidential cycle) never
  co-ballot (structurally untestable, SC/LA President-vs-Governor
  class). County tier as printed = row officers first, council/Levy
  Court last (six blocks: e.g. NCC 2024 Clerk of the Peace → County
  Executive → Council President → Council District; Kent 2022 Recorder →
  Sheriff → Levy Court At-Large) — INFERENCE, no sourced rule.
  Wilmington municipal order (Mayor → Treasurer → Council President →
  District → At-Large ×3) identical 2020/2024, no located authority.
  Party columns: § 4502(a)(5) Democratic col 1, Republican col 2, others
  Department order; no straight ticket, no rotation (zero hits in
  Title 15).
- Judicial: EMPTY — Delaware elects ZERO judges (Del. Const. art. IV
  §§ 3(a), 30 — all appointed by Governor w/ Senate consent,
  https://delcode.delaware.gov/constitution/constitution-05.shtml).
  Confirmed empirically: 2024 statewide results report has zero judicial
  contests (only "Court" strings = "Kent County Levy Court", a
  legislative body). NUANCE: elected county Register of Wills presides
  over the Register's Court (art. IV § 31) — functionally judicial but
  sits in the COUNTY tier; do not route to a judicial block.
- Measures: ABSENT from the general ballot in observed practice (zero
  questions statewide 2024, zero on all pulled 2020/2022 faces) —
  amendments never go to voters (art. XVI § 1: two successive General
  Assemblies, no ratification election;
  https://delcode.delaware.gov/constitution/constitution-17.shtml); no
  statewide initiative/referendum. FOUR rare paths to a general-
  election question exist, none exercised 2020/2022/2024 (second
  external-review round widened this from three): (1) art. XVI § 2
  convention question — and this one HAS a constitutional placement
  rule: art. XVI § 5 "Separate ballots on question of Convention" —
  "the ballots shall be separate from those cast for any person voted
  for at such election" (a SEPARATE ballot, never a slot in the
  contest sequence); (2) art. XIII § 1 local-option liquor
  (constitution-14.shtml); (3) 28 Del. C. § 1503 "Referendums in
  general elections" — bingo-license question per art. II § 17A
  district, "printed on the ballots used in the next succeeding
  general election" on General Assembly majority request
  (https://delcode.delaware.gov/title28/c015/sc01/index.html, accessed
  2026-08-17; § 1504 applies Title 15 generally — no placement rule);
  (4) art. II § 17B(b)(1) non-state-lottery district referendum —
  distinct from bingo, expressly "at the general election held in
  1984" with subsequent re-submissions (constitution-03.shtml,
  accessed 2026-08-17). Routine questions = standalone "referendum
  elections" (15 Del. C. § 101(11)(e) — excludes candidate selection;
  e.g. Feb 2026 school referenda). Placement: RULED for path (1)
  (separate ballot); unknown for paths (2)-(4) (see GRADE SCOPE).
- County discretion: NONE — single STATE Department of Elections
  (15 Del. C. § 201; county boards consolidated 2015-07-01, § 201A;
  https://delcode.delaware.gov/title15/c002/index.html); § 4503
  Department creates ballots. (Verify round fixed a miscite here:
  § 101(10) defines "Department", not "county offices" — the
  county-level election offices are Department organs via §§ 201/201A
  + 4503; note "county office" elsewhere in Title 15 carries two
  senses: Department branch (§§ 4509/6103) vs elected county office
  (§§ 4108/5015).)
- School/special: EMPTY in November — school boards elect the second
  Tuesday of May (14 Del. C. § 1072(c),
  https://delcode.delaware.gov/title14/c010/sc04/index.html;
  uncontested-filing walkover), other school elections board-set dates
  (§ 1072(d)); Department calendar confirms (May 12 2026 school boards ×
  16 districts). Zero school contests in 2024 results.
- Corroboration: Department's own sample-ballot repository (index
  https://elections.delaware.gov/elections/general/sampleballots/ge2024/index.shtml,
  533 links keyed RD-ED). Eleven ballots pulled + %PDF-verified across
  three cycles (2024 ×8 incl. 01-01 Wilmington full 15-contest face,
  11-05 Kent, 37-01 Sussex; 2022 ×5; 2020 ×2). Ballots = IMAGE-ONLY
  ExpressVote XL renders (get_pixmap + visual read, or crop left ~13.5%
  column + tesseract --psm 6 — OCR misreads small header digits, ID
  ballots by URL not header). Confirms: slots 1-5 exact statutory match;
  titles match § 4502(a)(2) verbatim per cycle; sub-statutory ladder
  identical on every face; State Senator ALWAYS before State Rep; zero
  judicial/questions on all eleven. Statewide cross-check: official
  GE2024 results report
  (https://elections.delaware.gov/reports/GE2024.html) — full roster in
  the same top sequence, zero judicial, zero questions (canvass order ≠
  print order — supporting only). One literal divergence recorded:
  § 4502(c) draws President and VP as two rows, machine prints one
  combined row — licensed by "conform as far as possible" (§ 4502(b),
  (c), (e)).
- GRADE SCOPE: A = statutory ladder slots 1-5 matched in print;
  judicial-empty (Const. + statewide confirmation); school-in-May
  (§ 1072(c) + calendar); no county discretion (§§ 201/4502(e)/4503).
  EXCLUDED from A: (1) entire ladder BELOW Lt. Governor (execs →
  legislature → county → Wilmington) — no statute/reg/directive,
  11-ballot B-class evidence; NO CODE CONSEQUENCE — the printed
  practice matches the baseline anyway; (2) MEASURES tier — formerly
  claimed empty inside A; external-review rounds surfaced FOUR rare
  question paths (see Measures), so measure PLACEMENT is excluded
  rather than the tier declared empty — with one carve-out: the
  convention question is SEPARATE-BALLOT by art. XVI § 5, i.e. it
  never enters the contest sequence at all, so no in-ballot placement
  question exists for it; in-ballot placement stays unknown only for
  the liquor/bingo/lottery district referenda (absent in all observed
  cycles remains true; § 101(11)(e) separation still keeps routine
  questions off the general ballot); (3) AG-vs-Insurance-Commissioner
  slot (structurally untestable).
- Baseline delta: NONE for tiers Delaware has — baseline spine exact.
  School + judicial tiers EMPTY (not late); measures tier empty in
  every observed cycle but not structurally impossible (four rare
  paths — A-excluded). NO OVERRIDE ROW NEEDED — encode empty tiers as
  empty (NJ/VA/MA judicial precedent). If a rare question ever fires:
  the convention question does NOT take the measures-last fallback —
  art. XVI § 5 puts it on a physically separate ballot outside the
  contest sequence; only the in-ballot district referenda
  (liquor/bingo/lottery) would default to baseline measures-last.
- Notes: § 4502(a)(6) unaffiliated-candidates heading untested in print.
  Non-Wilmington municipalities run their own dates (ch. 75 subch. IV).
  Open (recorded): county-tier internal order unsourced (future cycle
  could reorder freely); Wilmington charter unread (might fix municipal
  order); 2022/2020 zero-question claims checked on pulled faces only
  (2024 proven statewide). Fetch gotchas: regulations.delaware.gov =
  Angular SPA — real data via JSON API (GET /api/AdminCode/titles; POST
  /api/AdminCode/title {"regulationUrl":"/AdminCode/title15"}; regs
  served as PDFs by GUID; route names from the main.*.js bundle);
  delcode constitution files OFF BY ONE (constitution-NN.shtml = Article
  NN-1 — build map from index.shtml); authenticated title PDFs at
  /{title}/Title{N}.pdf; sample-ballot URL patterns change per cycle
  (2024 {RD}-{ED}_XL_Sample.pdf / 2022 GE2022-{RD}-{ED}-SampleBallot.pdf
  / 2020 {RD}-{ED}.pdf; ge2018 404s); ED numbering per-RD non-contiguous
  (RD 11 starts at ED 05 — enumerate index hrefs, never construct);
  RD number ≠ county (read county off contest names);
  elections.delaware.gov fully curl-open w/ Chrome UA.

### SD — South Dakota (FIPS 46) — GRADE A (scoped)
- Authority: SDCL 12-16-5 "Order of offices placed on ballot" — "The
  names of the candidates shall be placed upon the ballot in the
  following order: presidential electors, if any, United States Senator,
  if any, Representatives in Congress, state officials, legislative, and
  county candidates."
  (https://sdlegislature.gov/api/Statutes/Statute/12-16, accessed
  2026-08-16; sdlegislature.gov = Vue SPA — JSON API only). Silent past
  "county candidates" — the rest fixed by rule: SDCL 12-16-9 delegates
  form to the State Board of Elections (rulemaking SDCL 12-1-9(2)),
  executed as ARSD 05:02:06:01.04 "General election ballot for ballot
  marking device" (eff. 2017-08-08) enumerating the complete sequence
  (https://sdlegislature.gov/api/Rules/05:02 — 11MB article JSON, grep
  never dump). Related: 12-16-1 (auditor prepares, style/form mandate),
  12-16-1.1 (unopposed candidates auto-elected OFF the ballot — all
  offices except State Legislature), 12-13-4 (amendments lettered, IM/RL
  share one number series), 12-16-3.1 (party column lot draw),
  12-16-8 (candidate order by lot), 16-1-2 (SC retention at generals),
  46A-3B-5 (water development directors ride general ballots).
- Office order: ARSD 05:02:06:01.04: Presidential Electors → US
  Senator → US Representative → Governor & Lt. Governor (JOINT) → SOS →
  AG → State Auditor → State Treasurer → Commissioner of School and
  Public Lands → PUC → State Senator → State Representative (+ A/B) →
  County Treasurer/Finance Officer → County Auditor/Finance Officer →
  States Attorney → Sheriff → Register of Deeds → Coroner → County
  Commissioner (District) → County Commissioner At Large. Execs AFTER
  US House (baseline match); execs elected MIDTERM years only (2024
  ballot's sole "state official" = PUC).
- Judicial: mid-ballot "NONPOLITICAL BALLOT" header after last partisan
  county office, BEFORE all questions. Rule order: SC Justice Retention
  (YES/NO) → Circuit Judge → Water Development District Director →
  Consumers Power District Director → Conservation District Supervisor.
  CIRCUIT-JUDGE PLACEMENT CLOSED IN PRINT (verify round): 2022
  county-printed ballots — Minnehaha (Garretson Gazette publication,
  https://www.garretsongazette.com/wp-content/uploads/2022/10/Minnehaha_Publication-Sample-Ballot.pdf,
  incl. a CONTESTED Position C race), Beadle
  (https://beadlesd.org/DocumentCenter/View/482/2022-General-Election-Sample-Ballot),
  Charles Mix
  (https://charlesmixcounty.gov/files/2022/10/SampleBallot-GE.pdf), plus
  Brookings via scans embedded in 2025 legislative repeal testimony
  (https://mylrc.sdlegislature.gov/api/Documents/Attachment/279755.pdf?Year=2025)
  — ALL print `NONPOLITICAL BALLOT` → SC retention ×2 → Judge of the
  Circuit Court INLINE → measures, under ONE banner. The separate
  buff/tan judiciary ballot (ARSD 05:02:06:03 + statutory parallel SDCL
  12-16-11) is DEAD LETTER — the 2025 testimony seeking 12-16-11's
  repeal says so expressly ("requires a separate ballot, a separate
  piece of paper, that is not practical with the use of tabulators").
  SPECIAL-DISTRICT SLOT CONFLICT (recorded, evidence-class precise):
  VIP face docID=591026 prints East Dakota Water Development District
  Director BEFORE SC retention — verify round STRENGTHENED the
  within-face finding (correct column geometry; 156pt unused space
  below WDD rules out a column-fit artifact; control face 591051 same
  county conforms to the rule) — BUT the VIP viewer REFLOWS contests
  (its 2022 Minnehaha face docID=527155 renders a different order than
  the county's own publication ballot), so VIP faces are NOT
  print-layout evidence; the WDD slot's county-print status is UNKNOWN.
- Measures: last, after every candidate contest — ARSD 05:02:06:01.01
  (amendments) + 05:02:06:04.01 (IM/RL) "printed on the general election
  optical scan ballot"; 05:02:06:01.02 instruction-box placement proves
  questions = final portion. Internal order: Constitutional Amendments
  (lettered) → Initiated Measures → Referred Laws (SDCL 12-13-4).
  AMENDMENT-INTERNAL ORDER CORRECTED by verify round: 2024 E/F were
  legislature-referred and G/H BOTH petition-initiated (SOS's own
  petition doc titles H's an "initiated constitutional amendment
  petition") — so the printed E→F→G→H is consistent with BOTH
  plain-alphabetical AND legislature-before-initiated; the 2024 slate
  cannot discriminate, and Day County prints origin-grouped
  subheadings ("…submitted to the voters by the Legislature." over E/F;
  "…by petition." over G/H) pointing at origin grouping. Internal
  amendment order = UNTESTED, excluded from A. COUNTY questions print
  LAST after statewide (Day County Ordinance #2024-1 after RL 21).
- County discretion: essentially none over order — 12-16-1 "of the style
  and form prescribed", order statutory + rule-fixed; auditors choose
  only which local questions exist (+ publish facsimiles 12-16-16, post
  samples 12-16-15). Gaps: no rule orders MULTIPLE county questions;
  one county deviated in the nonpolitical block (above).
- School/special: NOT on the 2024 general ballot (~30 counties checked);
  school boards = separate ballot (ARSD 05:02:06:15). CHANGING: SDCL
  13-7-10.3 (even years: school elections combine w/ June primary or
  November general) + 9-13-1 as amended eff. 2026-01-01 (municipal June
  or November) — from 2026 school/municipal CAN appear in November on
  SEPARATE ballots, not merged (Minnehaha reportedly planning 324 styles
  for 2026 — unverified). Special districts DO ride the general ballot
  inside the nonpolitical block.
- Corroboration: three 2024 artifacts, %PDF-verified 2026-08-16:
  (a) official SOS ballot viewer, Minnehaha sample
  (https://vip.sdsos.gov/BallotViewer.aspx?docID=591051) — Presidential
  Electors → US Rep → PUC → State Sen → State Rep → County Comm At
  Large → NONPOLITICAL → SC Retention → Amendments E→F→G→H → IM 28 →
  IM 29 → RL 21; (b) docID=591026 (Minnehaha style w/ East Dakota WDD —
  the deviation face); (c) Day County county-printed official ballot
  (https://day.sdcounties.org/files/2024/09/DayCoSampleBallot.pdf) —
  same sequence + county ordinance last; (d) 2022 county-print set
  (Minnehaha publication, Beadle, Charles Mix — URLs in the Judicial
  bullet) — full midterm exec slate + circuit judges inline. VIP
  caveat: (a)/(b) are viewer faces (roster evidence — the viewer can
  reflow; see gotchas); the county-printed faces (c)/(d) are the
  layout evidence, and the partisan block = exact 12-16-5 match on
  every face of both classes.
- GRADE SCOPE: A covers the partisan ladder (12-16-5 + rule + 3 faces),
  NONPOLITICAL-block POSITION (after county, before questions), the
  retention → circuit-judge internal order (rule + 2022 county print ×4
  counties incl. a contested race — verify round closed it),
  measures-last + amendment/IM/RL CLASS order + county-questions-last.
  EXCLUDED from A: (1) special-district position WITHIN the
  nonpolitical block — VIP-face deviation (591026) vs rule, county-
  print status unknown (VIP reflows); (2) amendment INTERNAL order
  (alphabetical vs origin-grouped — 2024 slate non-discriminating, Day
  County subheads point at origin grouping); (3) multi-county-question
  internal order (no rule); (4) optical-scan-form leg — 05:02:06:01's
  form graphic missing from the API (BMD rule carries the order; not
  load-bearing).
- Baseline delta: (1) no municipal/school tiers in November through
  2024 (separate ballots from 2026 — re-check then); (2) special
  districts share a "NONPOLITICAL" tier WITH judicial after county —
  baseline has no such tier; (3) judicial right after county (not late
  past municipal/school) but still before measures; (4) county
  questions AFTER statewide measures (measures tier needs a
  state-before-local sub-rank); (5) presidential-year exec tier nearly
  empty; (6) unopposed candidates vanish from the ballot entirely
  (12-16-1.1) — tiers not always populated. Otherwise spine matches.
- Notes: 12-16-2.1's four ballot "types" no longer map to physical
  ballots — 2024 voter got ONE ballot, "NONPOLITICAL BALLOT" survives
  as a section header; "party" ballot = primary-only. Party COLUMN
  order = SOS lot (12-16-3.1); within-office candidate order = lot
  (12-16-8) — informational. Statute/rule text read = current 2026
  codification (no point-in-time API; 2024 ballots match ordering
  provisions; municipal/school DATE provisions demonstrably changed).
  Canvass PDF
  (https://sdsos.gov/elections-voting/assets/Archive/2024%20Assets/2024GeneralElectionCanvassWithCert.pdf)
  verified as PDF only (not read). When no circuit judge is up the
  heading is simply ABSENT (Day + Minnehaha 2024 — full-text regex).
  Open (recorded): brookingscountysd.gov/DocumentCenter/View/4246/
  "Nonpolitical-Ballot" (live 404, Wayback-archived, unretrieved) —
  read as a June-2022 PRIMARY NPA ballot by filename/siblings/timestamp
  (inference; the only artifact whose name matches the separate-ballot
  theory — close via Brookings auditor or Wayback when replay
  recovers); Pennington/Codington/Yankton/Davison/Union/Hughes/Brown
  counties never covered (wrong domains → unsearched, not
  searched-and-empty). Fetch gotchas:
  sdlegislature.gov JSON API = /api/Statutes/Statute/<cite> +
  /api/Rules/<article> (leading zero REQUIRED — 05:02 works, 5:02
  302s); article JSON has Word CSS/metadata litter (strip <style>);
  ARSD form graphics absent from API (archived-rule PDFs referenced but
  blob container 404s all guessed names); sdsos.gov restructured —
  legacy asset paths 404 (current: /elections-voting/assets/2026
  Documents/, /assets/Archive/…); vip.sdsos.gov/BallotViewer.aspx?docID=
  <id> = official ballot PDFs (Minnehaha 2024 ≈ 591020-591096; HEAD-scan
  585000-600000 → ~30 counties) BUT with three caveats (verify round):
  ID space is sparse — most probed IDs return HTTP 200 with a 752-byte
  "Buffer cannot be null" error body, so magic-byte check everything;
  2022 content EXISTS (docID=527155 = Minnehaha 2022) despite a 16-ID
  probe suggesting 2024-only; and the viewer REFLOWS contests
  (527155's order ≠ the county's own publication ballot) — VIP faces
  are useful for contest ROSTERS but are NOT print-layout evidence;
  prefer county publication ballots (garretsongazette.com hosts
  Minnehaha's); electionresults.sd.gov serves current election only;
  curl needs -g for CDX filter=[…]; r.jina.ai 403 on web.archive.org +
  sdsos.gov.

### ND — North Dakota (FIPS 38) — GRADE A (scoped)
- Authority (all ndlegis.gov official Century Code chapter PDFs,
  %PDF-verified, accessed 2026-08-16): NDCC § 16.1-01-01(2)(e),(k) — SOS
  "Prescribe the form of all ballots" + "Prescribe the order in which
  each political subdivision will appear on an election ballot"
  (https://ndlegis.gov/cencode/t16-1c01.pdf); § 16.1-06-05 general-ballot
  FORM (continuous listing, top left-hand side) —
  https://ndlegis.gov/cencode/t16-1c06.pdf; § 16.1-06-07.1(1) President/VP
  "must include … as the first listing" (STATUTORY President-first);
  § 16.1-06-08 separate NO-PARTY ballot at the general ("may be on the
  same paper … entitled 'no-party ballot'"); § 16.1-06-09(2) measures:
  "Constitutional measures shall be placed first on the ballot, initiated
  statutes second, and referred statutes third", legislature-submitted
  first within class, numbering consecutive across classes;
  § 16.1-11-26 office ladder (Congressional → Legislative → State
  offices w/ internal exec order) — TEXTUAL CAVEAT: opens "The primary
  election ballot for party nominations…"
  (https://ndlegis.gov/cencode/t16-1c11.pdf); § 16.1-13-05(2) auditor's
  sample ballot "must conform in all respects to the form prescribed by
  the secretary of state" (https://ndlegis.gov/cencode/t16-1c13.pdf).
  NDAC Title 72 art. 72-06 = CLEAN NEGATIVE (chapters 01-03: voting
  systems, absentee notice, tribal ID — no ballot-order rule).
- Office order (one continuous snaking list, three reverse-video titled
  segments): PARTY BALLOT: President/VP (elector bracket, single oval,
  § 16.1-06-07.1(2)) → US Senator → US Representative → State Senator →
  State Representative (ascending district; 04a/04b subdistricts in
  Ward) → Governor & Lt. Gov (joint) → SOS → State Auditor → State
  Treasurer → AG → Insurance Comm → Agriculture Comm → PSC → Tax Comm
  (execs = § 16.1-11-26(3) sequence exactly; absent offices omitted,
  order preserved — verified 2020/2022/2024). NO-PARTY BALLOT (after
  every partisan office): Supt of Public Instruction → Supreme Court
  Justice → District Judges (by judgeship no.) → county offices
  (Commissioner → Auditor/Treasurer → State's Attorney → Recorder →
  Sheriff) → special districts (Soil Conservation → Garrison Diversion
  Conservancy). MEASURES BALLOT last. Split is SECTION-based, not
  column-locked (NO-PARTY banner mid-column-2 in Burleigh 2024, top of
  column 3 in Ward 2024 — proves one continuous list).
- Judicial: elected Supreme Court + district judges, NONPARTISAN
  (§ 16.1-11-08 bars party reference), in the no-party segment — after
  ALL partisan contests but BEFORE county offices. SOPI-before-Supreme-
  Court rests on Burleigh 2020 (only co-appearance cycle).
- Measures: last, own titled segment, reverse side — § 16.1-06-09(2)
  class order matched in print: legislature-referred constitutional →
  initiated constitutional → initiated statutory → referred statutory
  (consecutive numbering) → local (city/county/district) measures last.
  Burleigh 2024: Const 1 (SCR 4001) → 2 (SCR 4013) → 3 (HCR 3033) →
  Init-Const 4 → Init-Stat 5 → Bismarck Measures 1-2.
- County discretion: essentially none over sequence — § 16.1-06-02
  auditor prints "subject to the supervision and approval of the
  secretary of state as to the legal sufficiency of the form";
  § 16.1-13-05(2) conform-in-all-respects; two independent 2024 counties
  printed identical contest sequence from the same vendor template (both
  stamped `Typ:01 Seq:0001 Spl:01`). Rotation within contests varies
  (§ 16.1-11-27 — informational only).
- School/special: NO school or municipal OFFICES on November ballots —
  school boards elect April-June (NDCC § 15.1-09-22(1),
  https://ndlegis.gov/cencode/t15-1c09.pdf); city elections = second
  Tuesday in June, even years (§ 40-21-02,
  https://ndlegis.gov/cencode/t40c21.pdf). City MEASURES can reach
  November (§ 16.1-11-11.1 + § 40-21-02(5)) — how Bismarck's 2024
  measures landed; they print last (practice — see GRADE SCOPE (d)).
- Corroboration: 4 faces, 3 cycles, 2 counties, zero conflicts —
  Burleigh 2024 official sample
  (https://www.burleigh.gov/media/4nthpev3/2024-general-election-sample-ballot.pdf),
  Ward 2024
  (https://www.co.ward.nd.us/DocumentCenter/View/7904/November-2024-Sample-Ballot),
  Burleigh 2022 publication ballot
  (https://www.burleigh.gov/media/zl4kvtud/22gndburleighpublication.pdf —
  Supreme Court slot, full county block, midterm exec sequence),
  Burleigh 2020 (Ballotpedia S3 mirror
  https://cdn.ballotpedia.org/images/9/93/2020_North_Dakota_sample_ballot_(Burleigh_County).pdf
  — provenance caveat; decisive on SOPI-before-Supreme-Court). All
  fetched + %PDF-verified 2026-08-16. Cass + Grand Forks hosts 403
  everything incl. via r.jina.ai — no Fargo ballot.
- GRADE SCOPE: A covers President/VP-first (§ 16.1-06-07.1(1)); the
  SEGMENT SEPARATION + LABELING (§ 16.1-06-08 mandates a separate
  no-party listing "entitled 'no-party ballot'" — it fixes separation
  and the label, NOT which segment comes first; external-review round
  narrowed this); within-MEASURES class order + consecutive numbering
  (§ 16.1-06-09(2)); auditor bound to SOS-prescribed form (§ 16.1-06-02
  for the official ballot; § 16.1-13-05(2) reaches the SAMPLE ballot —
  verify-round precision). EXCLUDED from A (B-class —
  print-corroborated, no general-election statutory hook; verify round
  ENLARGED this bucket for consistency): (a) intra-party office ladder
  incl. exec internal order — § 16.1-11-26 is textually primary-only
  (verify round read the whole four-line section: it really ends at the
  exec list and speaks only to "The primary election ballot for party
  nominations"), no general analogue in ch. 16.1-06; rests on SOS form
  power + 4 uniform faces (delegation-plus-practice, NE-class);
  (b) ENTIRE no-party internal order (SOPI → courts → county →
  districts) — no ladder anywhere in statute or NDAC; (c) MEASURES-
  AFTER-OFFICES position — verify round swept ch. 16.1-06/-11/-13:
  nothing places measures after offices (§ 16.1-06-09(2) orders only
  within-measures; closest is § 16.1-06-05(5)'s weak "approximating as
  far as possible"); print-only, 4 uniform faces; (d) local-measures-
  after-state sub-rank — no statute at all (city measures arrive via
  § 16.1-11-11.1/§ 40-21-02(5) with no placement rule); print-only;
  (e) SEGMENT RELATIVE ORDER (party before no-party before measures) —
  § 16.1-06-08 orders nothing between segments (external-review
  round); print-only, 4 uniform faces, same evidence class as (a)/(c).
- Baseline delta: (1) BIG — state legislature ABOVE statewide executives
  (US Sen → US House → State Sen → State House → Gov/execs), hard
  inversion of baseline [but in the A-excluded ladder scope];
  (2) statewide execs SPLIT — SOPI nonpartisan, prints far below in the
  no-party block; (3) judicial BEFORE county (below all partisan
  offices); (4) county offices nonpartisan, below judges; (5) municipal
  + school tiers ABSENT in November (June elections); (6) measures last
  matches baseline (+ state-before-local sub-order) — both in the
  B-class bucket per GRADE SCOPE (c)/(d), no code consequence since
  they match the baseline anyway.
- Notes: § 16.1-06-06 separate presidential-electors-only ballot for
  §§ 16.1-13-35/-36 voters (not the general ballot). SOS 2026 Election &
  Candidate Filing Guide
  (https://www.sos.nd.gov/sites/www/files/documents/elections/election-candidate-filing-info.pdf)
  groups Federal → Statewide Partisan →
  Legislative → … — DIFFERS from printed ballot (filing guide, NOT
  ballot-order authority — trap). ND runs measures at the June primary
  too — general-only override scoping correct. Burleigh 2022 printed a
  "County Official Newspaper" designation question INSIDE the no-party
  office block, not the measures segment — encoder must not assume all
  questions sort last. Open (recorded): no SOS-published general ballot
  form/template located (would lift the ladder to A); no published
  § 16.1-01-01(2)(k) subdivision-order directive; SOPI-vs-Supreme single-
  ballot basis (2026 won't re-test — no SOPI race); empty no-party
  segment behavior untested. Fetch gotchas: ndlegis.gov NDAC has no HTML
  index for Title 72 — probe /information/acdata/pdf/72-AA-CC.pdf (404s
  return ~69KB HTML bodies — always check %PDF); casscountynd.gov +
  gfcounty.nd.gov hard-403 incl. r.jina.ai; Ward County host =
  co.ward.nd.us (wardnd.com dead); 3-column ballots need coordinate
  extraction (blocks bucketed by x//180 then y — naive get_text()
  scrambles order).

### AK — Alaska (FIPS 02) — GRADE A (scoped)
- Authority: AS 15.15.030 "Preparation of official ballot" (Alaska
  Statutes 2025), full text via
  https://www.akleg.gov/basis/statutes.asp?media=print&secStart=15.15.030&secEnd=15.15.030
  (accessed 2026-08-16; akleg is a JS SPA — the media=print&secStart=…
  AJAX pattern, recovered from /scripts/statutes.js, is the only
  fetchable route). SCOPE WARNING: statute fixes groupings/format, NOT a
  top-to-bottom office sequence — (1) leaves "other similar matters of
  form not provided by law" to the Director of Elections. On point:
  (5) candidates "in separate sections … under the office designation";
  Lt. Governor + Governor "included under the same section"; white paper;
  (6) name rotation/randomization per house district (within-contest
  only); (7) President/VP tickets one section (no electors);
  (8) initiative/referendum/amendment "placed on the ballot in the
  manner prescribed by the director" (DELEGATED), numbered by petition;
  (9) constitutional-convention wording; (10) judicial retention: "a
  nonpartisan ballot shall be designed for each judicial district …
  divided into four parts" — (A) supreme court → (B) court of appeals →
  (C) superior court → (D) district court; (11) bond questions lettered.
  Regs: 6 AAC 25-28 (Part 1, Elections) contain NO contest-order rule
  (full-range negative check via aac.asp media=print; incl. 6 AAC 27.010
  REAA October elections + 6 AAC 27.175 combined municipal/state —
  municipal ballots on colored stock, "elections are separate").
- Office order (from official general samples, single column, two
  cycles combined, no contradiction): President/VP → US Senator → US
  Representative → Governor/Lt. Governor (ONE joint section per (5)) →
  State Senator (when up) → State Representative. 2022 HD20_JD3 (Gov +
  US Sen cycle) + 2024 HD20-JD3 (Pres cycle) pin the full ladder.
  2026 primary sample (HD20) corroborates federal-before-Gov/LtGov.
  RCV: top-four general still in force for 2026 (2024 repeal measure
  FAILED by ~664-743 votes after Dec 2024 recount; 2026 primary ballots
  labeled "Nonpartisan Top Four") — rank grid only, never contest order.
- Judicial: LAST — retention prints at the END, AFTER ballot measures,
  as a distinct nonpartisan section grouped by court in the statutory
  four-part order, scoped to the voter's judicial district (JD1-4;
  sample filenames literally HD<n>-JD<n>). Statute-vs-print nuance
  (recorded): (10) nominally describes "a nonpartisan ballot" (separate
  instrument); practice prints it as the back-side section of the same
  white card.
- Measures: BEFORE judicial retention — back-side top-left column
  (2024: Measure 1 (23AMLS) → Measure 2 (22AKHE), then retention
  columns; 2022: Measure 1 constitutional-convention question, then
  retention). Position delegated to director per (8) — practice, not
  statute. Bond questions lettered per (11); none printed 2022/2024 —
  letter-vs-number interleave UNKNOWN.
- County discretion: none — Alaska HAS NO COUNTIES (boroughs +
  unorganized borough). Zero borough/city/municipal offices or
  questions on the state November ballot. Municipal regulars = first
  Tuesday of October (AS 29.26.040); even the 6 AAC 27.175 same-day
  combine keeps municipal contests on a physically separate colored
  ballot.
- School/special: NOT on the state November ballot, incl. the state-run
  exception: REAA school boards (unorganized borough) are administered
  by the Division of Elections but on the first Tuesday in October
  (AS 14.08.071(b), 6 AAC 27.010) — confirmed by a real state-issued
  ballot "State of Alaska Official Ballot / October 7, 2025 / REAA
  11-1" (Iditarod REAA #11 School Board Seat B only). REAA advisory
  questions ride the October REAA ballot (AS 14.08.071(d)).
- Corroboration: 2024 general HD20-JD3 official DoE sample,
  https://www.elections.alaska.gov/election/2024/General/SampleBallots/HD20-JD3.pdf
  — side 1 President/VP → US Rep → State Sen J → State Rep 20; side 2
  measures then four-part retention. 2022 general HD20_JD3,
  https://www.elections.alaska.gov/election/2022/genr/HD20_JD3.pdf
  (filename recovered via Wayback CDX prefix query; file still live) —
  US Senator → US Rep → Gov/LtGov → State Sen J → State Rep 20; measure
  then retention. Cross-checks: 2024 HD14-JD3 + HD1-JD1 (different
  judicial district) identical structure; 2026 primary HD20. All
  fetched + %PDF-verified 2026-08-16. IMPORTANT extraction trap: plain
  get_text() streams retention column headers AHEAD of measures —
  falsely suggests judicial-before-measures; coordinate extraction
  (blocks w/ x/y: measures x≈49-220, retention x≈224-562) required.
- GRADE SCOPE: A covers the statute+print legs — Gov/LtGov joint
  section (5); President/VP single-section (7); judicial retention
  four-part INTERNAL order (10); municipal/school/county tiers ABSENT
  from the state ballot (AS 29.26.040, AS 14.08.071, 6 AAC 27.175 all
  + print). EXCLUDED from A (delegation-plus-practice, ND-ladder
  class): (a) the top-to-bottom office ladder — no ordering statute or
  reg; rests on AS 15.15.030(1) residual discretion + two cycles of
  uniform samples; (b) measures-BEFORE-retention position — delegated
  per (8), print-only; (c) bond-letter placement (never observed).
- Baseline delta: (1) offices match baseline where they exist —
  Gov/LtGov = only elected statewide execs (no AG/SOS/Treasurer);
  (2) NO county tier (no counties), NO municipal/school tiers on the
  state ballot (separate October elections); (3) LAST TWO INVERTED:
  measures before judicial retention, retention dead last [both in the
  A-excluded practice scope]; (4) RCV grid = format only.
- Notes: separate "Fed-Only" ballot exists for federal-only voters.
  Sample ballots post ~50 days out — 2026 general samples unpublished
  as of 2026-08-16 (/election/2026/General/ 404s). Alaska also runs
  measures on PRIMARY ballots (2026-08-18 primary carries Measure 1,
  23RCF2) — general-only override scoping correct. Open (recorded):
  bond-question position; constitutional-convention slot when
  initiatives co-appear (next 2032); no written DoE layout directive
  found (possible internal/vendor spec unlocated); pre-2022 cycles
  unreviewed (/Core/Archive/ bot-walled 405 + CAPTCHA). Fetch gotchas:
  akleg print output ISO-8859-1 (smart quotes → �); AAC sections
  as 6.25.010 not "6+AAC+25.010" (0 bytes); elections.alaska.gov
  legacy /Core/*.php = 405 to curl/WebFetch + CAPTCHA via r.jina.ai,
  but WordPress paths (/sample-ballots/…) + /election/** PDFs wide
  open; sample-ballot slugs LIE (24prim2 = 2026 primary, 24reaa2 =
  2025 REAA — read the table cells); per-cycle directory naming
  changes (2024 General/SampleBallots/HD20-JD3.pdf hyphen vs 2022
  genr/HD20_JD3.pdf underscore — probe: 403 = dir exists, 404 = not);
  Wayback CDX prefix queries worked while regex filter= 500'd and
  broad queries 503'd.

### VT — Vermont (FIPS 50) — GRADE A (scoped)
- Authority: 17 V.S.A. § 2471(a)(1) "General election ballot",
  https://legislature.vermont.gov/statutes/section/17/051/02471 (accessed
  2026-08-16; host serves an INCOMPLETE TLS chain — leaf only; curl exit
  60 + WebFetch fail; fetched via r.jina.ai proxy; section URLs need
  zero-padded 5-digit numbers /02471). Verbatim: "A consolidated ballot
  shall be used at a general election… The offices of President and Vice
  President of the United States, U.S. Senator, U.S. Representative,
  Governor, Lieutenant Governor, State Treasurer, Secretary of State,
  Auditor of Accounts, Attorney General, State Senator, Representative to
  the General Assembly, Judge of Probate, assistant judge, State's
  Attorney, sheriff, and high bailiff shall be listed in that order. Any
  statewide public question shall also be listed on the ballot, before
  the listing of all offices to be filled." SECOND PRIMARY leg (identical
  text, non-mirror — SOS's own compilation): "Vermont Election Laws" PDF
  p.107 (PDF p.111),
  https://outside.vermont.gov/dept/sos/Elections_Division/election_info_resources/election_law/vermont_election_laws.pdf
  (%PDF-verified; outside.vermont.gov has NO TLS problem — plain curl +
  Chrome UA). § 2472 = contents/alphabetical order only, NO ordering
  provision (the plan's § 2472 pointer was wrong — it's § 2471).
  Supporting: § 2471(a)(2) state expense under SOS direction; § 2471(b)
  JP ballots town-prepared, conforming format; §§ 1841-1844 amendment
  votes (even-year generals, SOS-prepared ballots); § 2640(a) March town
  meeting; § 2681a local ballots; § 2472(b)(2) alphabetical, no
  rotation. Vt. Const. ch. II §§ 32/34/43/52-53.
- Office order: [statewide public question(s) FIRST] → President/VP → US
  Senator → US Representative → Governor → Lt. Governor → State
  Treasurer → Secretary of State → Auditor of Accounts → Attorney
  General → State Senator → State Representative → Judge of Probate →
  Assistant Judge → State's Attorney → Sheriff → High Bailiff → [Justice
  of the Peace, town-supplied, prints last in practice]. Absent offices
  omitted, relative order kept. County block (Probate/Assistant/State's
  Attorney/Sheriff) = MIDTERM years only (4-yr terms); High Bailiff +
  JPs 2-yr, every general (2024 ballots print State Rep → High Bailiff
  with the four absent — matches SOS "Offices Elected in 2026" list).
- Judicial: NO Supreme/Superior Court contests ever — appointed w/
  Senate consent, retention by General Assembly vote (Vt. Const. ch. II
  §§ 32, 34). Elected judicial-titled offices lead the county block:
  Judge of Probate FIRST after State Rep, Assistant Judge second — AHEAD
  of State's Attorney/Sheriff/High Bailiff (opposite of judicial-late).
  JPs = elected town office voted in November (Const. ch. II § 43; term
  begins Feb 1), NOT in the § 2471(a)(1) list — town-prepared under
  § 2471(b), printed last when folded into the state ballot.
- Measures: FIRST — "before the listing of all offices to be filled"
  (§ 2471(a)(1)) — the biggest VT deviation. Only statewide questions =
  constitutional amendments ("Proposal N"), even-year generals
  (§ 1842(a)). Confirmed Burlington 2022: entire leftmost column =
  "OFFICIAL STATE CONSTITUTIONAL AMENDMENT BALLOT" w/ PROPOSAL 2 +
  PROPOSAL 5 before any office (first office starts column 2). Local
  town articles MAY be added to the general ballot (SOS 2026 Election
  Procedures PDF p.54: "All towns have the option to include Justice
  of the Peace candidates and local articles (public questions) on
  their general election ballots") — position unfixed by any TEXT; two
  decoded examples print them DEAD LAST after JP (see GRADE SCOPE).
- County discretion: none for state offices — ballot prepared at state
  expense under SOS direction, printed by state vendor, shipped to towns
  (SOS 2026 Election Procedures p.55). No county election
  administration; town choice = bolt-on only (include JPs + local
  articles or print own local ballots — Procedures p.54).
- School/special: NOT in November — town + school-district annual
  meetings = first Tuesday in March (§ 2640(a); SOS: "Town meeting
  happens every year on the first Tuesday in March"; 2026: Town Meeting
  3/3 vs General 11/3). Separate March ballot evidenced (Barre Town
  annual-meeting ballot: officers then ARTICLES 1-35).
- Corroboration: three ballots decoded via COORDINATE extraction
  (columns sorted x then y — plain get_text() interleaves): (1) Essex
  Junction City 2024 general,
  https://www.essexjunction.org/fileadmin/files/Administration/Clerk/District_23_General_Election_Sample_Ballot_2024.pdf
  — Pres/VP → US Sen → US Rep | Gov → LtGov → Treasurer → SOS →
  Auditor | AG → State Sen → State Rep → High Bailiff | p2 JP (vote for
  15). (2) Barre Town 2024 general (Washington County),
  https://www.barretown.org/Town_Clerk/Sample_Ballots/November%205%202024%20General%20Election%20Ballot.pdf
  — IDENTICAL sequence, second county, zero variation. (3) Burlington
  2022 midterm (Ballotpedia S3 mirror — provenance caveat; internal
  header "300050 / BURLINGTON / CHITTENDEN 13" consistent w/
  state-printed format),
  https://ballotpedia.s3.amazonaws.com/images/6/6e/2022_Vermont_sample_ballot_%28Burlington%29.pdf
  — proves BOTH measures-first AND the full county block (Probate
  Judge → Assistant Judge → State's Attorney → Sheriff → High Bailiff →
  JP) in exact statutory sequence. Child-agent sweep adds three more
  2024 towns, identical order incl. the full exec block (VT execs are
  2-year — printed every cycle): Winooski
  (https://www.winooskivt.gov/DocumentCenter/View/8745/Sample-Ballot),
  Montpelier
  (https://www.montpelier-vt.org/DocumentCenter/View/11311/140-MONTPELIER-WAS-4-SAMPLE-1),
  Barre Town (same clerk archive as above) — all print Pres/VP → US
  Sen → US Rep → Gov → LtGov → Treasurer → SOS → Auditor → AG → State
  Sen → State Rep → High Bailiff, JP alone on sheet 2 with NO title
  block of its own (supports separate-instrument reading of
  § 2471(b)); Colchester official 2024 results (OCR'd scan) confirms
  the same sequence per district. Second child sweep: South Burlington
  ×5 districts + Essex Junction ×2 + Putney + Hartford ×2 + Fair Haven
  2024 — 13-contest sequence INVARIANT across every 2024 face
  (differences = seat counts only); Fair Haven 2022 official ballot
  (https://fairhavenvt.gov/wp-content/uploads/2023/02/1-Sample-Ballot-November-2022.pdf)
  replicates the Burlington 2022 structure from an OFFICIAL host —
  separate-titled "OFFICIAL STATE CONSTITUTIONAL AMENDMENT BALLOT"
  column (Proposals 2+5) before the office ballot + full county block
  (Probate Judge p1c3 → Assistant Judge → State's Attorney → Sheriff →
  High Bailiff p2c1 → JP p2c2) — the 2022 mirror-provenance caveat is
  no longer load-bearing. KEY CLOSURE: Hartford 2024 (both W-4 + W-6,
  https://www.hartford-vt.org/DocumentCenter/View/10465 + /10462)
  printed a LOCAL BOND ARTICLE ($4.1M highway bond) on the state
  ballot — placed p2, AFTER Justice of the Peace, DEAD LAST. All
  %PDF-verified 2026-08-16. No conflicts.
- GRADE SCOPE: A covers the full § 2471(a)(1) ladder + statewide-
  measures-first + NO state-court or retention tier (Probate Judge and
  Assistant Judge are COUNTY-BLOCK offices inside the § 2471(a)(1)
  ladder — an override must not drop them under an "empty judicial"
  reading) + empty municipal/school November tiers. EXCLUDED from A: (1) local-article position when a town opts onto
  the state ballot — statute silent; TWO printed examples now observed,
  both DEAD LAST after JP: Hartford 2024 bond article (p2, column
  right of JP) and Burlington 2022 "BALLOT QUESTION" ($165M school
  bond, p2 rightmost column x=426.9 — decoded by the verify round from
  the same PDF the entry already cited) — consistent practice
  evidence, stays excluded (two towns, no rule text); (2) JP-block-
  last-among-OFFICES — practice + SOS workflow, eleven-for-eleven in
  print (JP always alone on p.2, "TURN BALLOT OVER AND CONTINUE
  VOTING" footer) but not express statutory text (§ 2471(b) says only
  town-prepared, conforming format); note a local article can print
  AFTER the JP block, so "JP last" holds only among offices.
- Baseline delta: (1) MEASURES FIRST, not last — hard inversion;
  (2) exec internal order Gov → LtGov → Treasurer → SOS → Auditor → AG
  (Treasurer before SOS; AG LAST); (3) judicial never late — probate
  judge + assistant judge LEAD the county block; (4) county block order
  statutory + fixed; (5) no municipal/school November tiers (March
  town meeting); (6) JP = lone town contest, very bottom; (7) no
  retention/appellate contests at all.
- Notes: every-voter mail ballots (§ 2537a) — SOS design is what
  virtually all voters see; one statewide design across 14 counties.
  Alphabetical candidate order, no rotation (§ 2472(b)(2)) —
  informational. Open (recorded): local-article placement; JP section =
  same print job vs town insert (both 2024 ballots print JPs alone on
  p.2 of the same PDF); charter-moved local elections unaudited
  (§ 2631); county-office 4-yr terms rest on SOS 2026 list + 2024
  absence (inference). CLOSED by verify round: Nov 2026 carries TWO
  statewide questions — Governor's proclamation 2026-07-28 puts
  Proposals 3 AND 4 on the ballot (governor.vermont.gov press
  release); both print first per § 2471(a)(1). Fetch gotchas:
  legislature.vermont.gov TLS
  = MISSING chain (r.jina.ai works, and `curl -sSLk` + Chrome UA also
  returns the statute pages; contrast MS batch-4 where AIA-fetching the
  intermediate fixed curl properly — untried here); wrong CHAPTER
  numbers on legislature.vermont.gov return HTTP 200 with a ~57.9KB
  generic page (same 200-but-404 trap as gc.nh.gov; § 1842 lives at
  chapter 032); /statutes/fullsearch/ 404s; Ballotpedia rate-limits
  repeat File:
  requests w/ HTTP 202 (not "missing"); morristownvt.gov blocks both
  jina (406) and curl (403); Harwood school ballot = image-only scan
  (zero text).

### WY — Wyoming (FIPS 56) — GRADE A
- Authority: W.S. § 22-6-117 "Order of listing offices in partisan elections"
  (partisan ballot) AND W.S. § 22-6-125 "Order of offices and ballot
  propositions on nonpartisan ballots" (nonpartisan ballot), both from the
  primary legislative text https://wyoleg.gov/statutes/compress/title22.pdf
  (full Title 22 PDF, %PDF-verified, accessed 2026-08-16) and independently
  confirmed word-for-word in the SOS's own 2026 Wyoming Election Code
  (effective 2026-07-01),
  https://sos.wyo.gov/Forms/Publications/ElectionCode.pdf (accessed
  2026-08-16). Supporting: § 22-6-102(a) (county clerk prints), § 22-6-123
  (nonpartisan ballot separate, yellow), § 22-6-124 (propositions follow all
  offices on the nonpartisan ballot), § 22-6-126 (statutory nonpartisan
  ballot FORM — opens with retention questions), § 22-2-121(b) (SOS
  rulemaking). SOS rule 002-22 Wyo. Code R. § 22-4 adds nothing independent —
  it expressly defers to § 22-6-117 (rule text seen only via the Cornell
  mirror,
  https://www.law.cornell.edu/regulations/wyoming/002-22-Wyo-Code-R-SS-22-4,
  NOT load-bearing; rules.wyo.gov unreachable to fetchers — see Notes).
- Office order: TWO statutory ballots per general. PARTISAN, § 22-6-117(a)
  verbatim: (i) President/VP → (ii) US Senator → (iii) US Representative →
  (iv) Governor, SOS, State Auditor, State Treasurer, Superintendent of
  Public Instruction (one paragraph, that internal order) → (vi) State
  Senate → (vii) State House → (ix) county commissioner, coroner, district
  attorney, county attorney, sheriff, clerk, treasurer, assessor, clerk of
  the district court (fixed nine-office statutory sequence — never nine in
  one county: DA and county attorney are alternatives, ≤8 print; Laramie
  2022 prints 8) → (xi) precinct offices — PRIMARY-ONLY in practice:
  § 22-4-101(b) elects precinct committeemen/women "at the regular
  biennial primary election"; neither Laramie face carries them in
  November (verify round — tier never populates at a general).
  ((v)/(viii)/(x) repealed.) Party order WITHIN contests = § 22-6-121
  (county's last US-Rep vote; independents last); name rotation by precinct
  §§ 22-6-122/-127 (informational only).
- Judicial: EARLY, NOT LATE — biggest WY deviation. Retention questions are
  the FIRST items on the nonpartisan ballot, § 22-6-125(a)(i)-(iv): supreme
  court → district court → circuit court → magistrates. They print right
  after the partisan county/precinct block and BEFORE municipal, community
  college, school, special districts, and all measures. § 22-6-126(b):
  primary nonpartisan ballot omits supreme/district/circuit retention
  (magistrates not named in that subsection — verify round precision).
- Measures: last, internally ordered — § 22-6-124 ("Following all offices on
  nonpartisan ballots"), § 22-6-125(a): (xi) constitutional amendments
  (lettered) → (xii) initiatives → (xiii) referenda → (xiv) other ballot
  propositions (county/local tax questions, dead last).
- County discretion: NONE over contest order — both lists mandatory ("shall
  contain the offices to be voted on in the following order"). Clerk
  discretion confined to layout: § 22-6-120(a)(vii) column/row designation,
  § 22-6-128 optional SEPARATE ballots for bond/school/community-college/
  special-district elections, § 22-6-113 multiple ballots on one machine if
  "clearly separated".
- School/special: on the November ballot, nonpartisan tier order
  § 22-6-125(a): (vi) municipal → (vii) community college trustees →
  (viii) school board trustees → (ix) special district directors →
  (x) other county-subdivision offices. Community college ABOVE school
  board. Verified in print: Laramie (LCCC trustees → SD#1 trustees →
  conservation supervisors) + Natrona (Casper College → SD#1 → Senior
  Citizens District → Fire Protection District → Conservation).
- Corroboration: two counties, two cycles, zero conflicts. (1) Laramie 2024
  general precinct 1-01 official clerk sample,
  https://maps.laramiecounty.com/ClerkDocs/SampleBallots/2024/General/1-1.pdf
  — federal head → state legislature → county → retention (Supreme Fenn/Fox,
  Circuit Williams) → Cheyenne Mayor/Council → college → school →
  conservation → Amendment A → county tax question (rural 4-3.pdf same minus
  municipal). (2) Laramie 2022 general precinct 1-01 (…/2022/General/1-1.pdf)
  — DECISIVE for executives + county internal order (midterm slate):
  Governor → SOS → Auditor → Treasurer → Supt, then all county offices in
  exact § 22-6-117(a)(ix) sequence, JUDICIAL RETENTION banner before
  MUNICIPAL. (3) Natrona 2024 Numbered Key Canvass (results doc in ballot
  order, NOT a facsimile),
  https://www.natronacounty-wy.gov/DocumentCenter/View/12139/Official-2024-General-Election-Numbered-Key-Canvass-PDF
  — full §§ 22-6-117 → 22-6-125 sequence incl. supreme/district/circuit
  retention tiers (magistrate retention never observed — see Notes). All
  fetched + %PDF-verified 2026-08-16.
- Baseline delta: (1) judicial retention EARLY — after county, before
  municipal/school/measures (baseline has judicial late) — largest
  deviation, statutory + confirmed both counties; (2) municipal AFTER
  judicial (baseline reverse); (3) community college trustees = own tier
  between municipal and school; (4) special districts = explicit slot after
  school; (5) two-ballot structure (partisan white + nonpartisan yellow)
  concatenated onto one card under banner headings. (Former delta
  "precinct offices = final partisan tier" DROPPED by verify round —
  precinct committee offices are primary-elected, § 22-4-101(b); the
  tier is empty at every general.) MATCHES baseline:
  federal head order, executives between US House and state senate, senate
  before house, county after legislature, measures dead last.
- Notes: statewide executives elected MIDTERM years only — presidential-year
  ballots skip slot (iv), not reorder. One at-large US House seat.
  § 22-6-105 sample-ballot rotation warning = within-contest only. Open
  (structural, low-risk): magistrate retention (a)(iv) and "other county
  subdivision offices" (a)(x) never observed in print; yellow-stock
  demarcation untestable from grayscale PDFs (media, not order); initiative/
  referendum internal split untested (2022/2024 carried amendments + local
  tax only); rules.wyo.gov primary rule text unreachable (search-form app,
  "No File Available" on guessed IDs) — Cornell mirror pointer only, not
  load-bearing. Fetch gotchas: Laramie sample archive path uses UNPADDED
  precinct slugs (1-1.pdf; padded 1-01.pdf 404s as HTML — magic-byte
  check); natronacounty-wy.gov DocumentCenter works with ?bidId= stripped;
  wyoleg.gov title PDFs + SOS ElectionCode.pdf both list sections twice
  (TOC then body — quote the body).

### DC — District of Columbia (FIPS 11) — GRADE A (scoped)
- Authority: 3 DCMR § 1202 "ORDER OF CONTESTS AND QUESTIONS", § 1202.1
  (current text effective 2023-09-22), official Office of Documents host —
  https://dcregs.dc.gov/Common/DCMR/SectionList.aspx?SectionNumber=3-1202
  (accessed 2026-08-16; actual rule text behind an ASP.NET postback that
  returns 31202.doc, an OLE2 Word binary — see Notes). Rule authority:
  D.C. Official Code § 1-1001.05(a)(14); source line 61 DCR 625 →
  61 DCR 10573 → 70 DCR 012730 (2023-09-22). Decisive quote: "Contests
  and questions in any Primary, General or Special Election, if
  applicable to that election, shall appear on the ballot in the
  following order:". Enabling statute delegates only — D.C. Code
  § 1-1001.08(e) "The form of the ballot shall be determined by the
  Board",
  https://code.dccouncil.gov/us/dc/council/code/sections/1-1001.08
  (accessed 2026-08-16). Order is fixed by REGULATION, not statute.
- Office order: § 1202.1 verbatim (general reading): (a) Electors for
  President/VP → (b) Delegate to the US House → (c) Mayor → (d) Council
  Chairman → (e) At-Large Council → (f) Ward Council → (g) Attorney
  General → (h) United States Senator [shadow] → (i) United States
  Representative [shadow] → (j) At-Large SBOE → (k) Ward SBOE → (l) ANC →
  (m)/(n) party committee offices [primary-only BY LAW — D.C. Code
  § 1-1001.10(a)(1): elections of the § 1-1001.01(1)-(4) party
  officials "shall be held, at the request of the party, during a
  primary election";
  https://code.dccouncil.gov/us/dc/council/code/sections/1-1001.10,
  accessed 2026-08-17] → (o) initiatives/referenda/Charter amendments →
  (p) recall measures.
  "If applicable" = absent contests close up, no reorder. Printed section
  headers: only President + Delegate under "FEDERAL"; everything from
  Council down under "DISTRICT OF COLUMBIA" (shadow congressional
  offices included).
- Judicial: ZERO elected judicial contests — no judicial office in the
  exhaustive § 1202.1 list. DC judges appointed 15-year terms via
  Judicial Nomination Commission + presidential nomination + US Senate
  confirmation (D.C. Code § 1-204.31(a),(c), § 1-204.34,
  https://code.dccouncil.gov/us/dc/council/code/sections/1-204.31).
- Measures: last — (o) then (p), after ANC. § 1200.5 permits measures on
  a physically separate ballot (order unaffected). Confirmed: Initiative
  83 (2024) + Initiative Measure No. 82 (2022) each printed on the
  reverse side after all offices.
- County discretion: none — no county tier exists; DCBOE prints every
  ballot; ward is a districting variable, not an ordering one.
- School/special: SBOE nonpartisan, late — (j) at-large then (k) ward,
  after shadow congressionals, before ANC. ANC = final office block
  before measures (DCBOE omits ANC candidate names from sample ballots;
  header position still confirms placement).
- Corroboration: (1) 2024 general Ward 8 official sample,
  https://dcboe.org/getmedia/f035b2da-e036-4829-a48f-d519fd23d269/General-24-Ward8.pdf
  — President → Delegate → At-Large Council → Ward 8 Council → US
  Senator → US Rep → At-Large SBOE → Ward 8 SBOE → ANC → Initiative 83:
  exact (a)(b)(e)(f)(h)(i)(j)(k)(l)(o) map (Mayor/Chairman/AG not up in
  2024). (2) 2024 non-citizen "LOCAL" ballot Wards 1/3/5/6,
  https://dcboe.org/getmedia/7ef0ddfe-cffd-4092-8e38-d6072c42ac0f/General-24-NC1356.pdf
  — local offices only, relative order preserved (confirms close-up-gaps
  behavior; Local Resident Voting Rights Amendment Act of 2022 — verify
  round fixed a miscite: 3 DCMR § 1200.4 is the OPPOSITE instrument,
  the federal-electors-only ballot restricted to President electors +
  Delegate). (3) DECISIVE for Mayor/Chairman/AG: 2026 Primary Voter Guide
  Ward 1 Democratic sample (guide p.17 / PDF p.19),
  https://dcboe.org/getmedia/50133a18-05de-4aaf-9212-9f731dd97301/DCBOE-Voter-Guide-PRIMARY-2026-WEB2.pdf
  — Delegate → Mayor → Chairman → At-Large Council → Ward 1 Council →
  AG → US Senator → US Rep = exact (b)-(i). (4) Second dcboe.org-hosted
  Mayor/AG confirmation: 2026 Democratic primary Ward 1 ballot
  https://www.dcboe.org/getmedia/c0377e57-6620-4ff8-91f9-e66572de0103/DEM-W-1.pdf
  — Delegate → Mayor → Chairman → At-Large → Ward 1 Council → AG → US
  Senator → US Rep → party offices. (5) Pointer-grade (vendor host
  omniballot.us): 2022 General Voter Guide — Ward 1 prints Delegate →
  Mayor → Chairman → At-Large → Ward 1 Council → AG → US Rep → Ward 1
  SBOE → ANC → Initiative 82 (verify round re-read it visually; exact
  § 1202.1 match in a real Mayor/AG GENERAL; shadow US Senator +
  At-Large SBOE legitimately absent in midterms). All fetched +
  %PDF-verified 2026-08-16. No conflicts. (No dcboe.org-hosted 2022
  ward ballot found — unproven absence: Wayback/Common Crawl/site
  search all failed; getmedia GUID is the key, filename segment
  ignored.)

- GRADE SCOPE: A covers (a)-(l) plus the corroborated portion of (o) —
  (o) is one slot spanning "initiative, referendum, and Charter
  amendment"; INITIATIVE prints (I-83 2024, I-82 2022) corroborate the
  slot's position. EXCLUDED from A (rule-text-only, never printed in
  examined cycles): (m)/(n) party-committee offices — primary-only BY
  LAW (§ 1-1001.10(a)(1)), can never fire on a general; the referendum and
  Charter-amendment PORTIONS of (o) — same slot by rule text, no
  printed face; (p) recall measures — these CAN fire on a general and
  have no printed face, so print corroboration is limited to the
  observed contest types
  (external-review round: the prior "every leg that can fire on a
  general is print-corroborated" claim was self-contradictory and is
  withdrawn; header scoped for parity with the rest of batch 5).
- Baseline delta: DC has NO state-legislature, county, or judicial tiers.
  Major inversion: "US Senator"/"US Representative" = shadow offices,
  print LATE ((h)/(i), after AG) — must NOT be encoded as baseline
  us_senate/us_house tiers 10/20. Statewide execs SPLIT: Mayor (c) right
  after Delegate, AG (g) after the whole Council block. Council
  (Chairman → At-Large → Ward) interleaves between the two execs. SBOE
  late + measures last match baseline; ANC = extra sub-municipal tier in
  the last office slot.
- Notes: candidate order within contests = per-contest draws at one
  lottery event, no rotation between precincts (D.C. Code
  § 1-1001.08(p), 3 DCMR § 1204.1; 2024 lottery 2024-09-13) —
  informational. § 1200 carries a fourth amendment (70 DCR 015793,
  2023-12-15) not listed in the § 1202 source line — it amends § 1200
  only; § 1202.1's currency unaffected. RCV in force for 2026 (Initiative 83) — changes marking
  UI, not contest sequence. Cycles: Mayor/Chairman/AG + Wards 1/3/5/6 =
  midterm years; Wards 2/4/7/8 Council + SBOE = presidential years.
  CLOSED (second external-review round): (m)/(n) never-on-general is
  no longer an inference — D.C. Code § 1-1001.10(a)(1) requires those
  party-official elections be held during a primary. Open (recorded):
  recall (p) + Charter-amendment
  placement rests on rule text alone (none printed in examined cycles);
  no dcboe.org-hosted GENERAL ballot from a Mayor/AG year located (2022
  ward ballots live on vendor host omniballot.us — authentic DCBOE
  content, pointer-grade; grade unaffected: rule text + 2026 primary
  guide close the placement). Fetch gotchas: dcregs.dc.gov rule text
  needs __VIEWSTATE/__EVENTVALIDATION postback (__EVENTTARGET=
  ctl00$MainContent$rpt_RuleList$ctl01$lnkFile) → .doc via textutil;
  dcrules.elaws.us mirror STALE (2017 — 14-item list, missing 2023
  (m)/(n): do not cite); dcboe.org year-in-path ignored
  (/elections/2024-elections byte-identical to 2026 page) — assets =
  opaque /getmedia/<guid>/ paths, search only; voter-guide ballot pages
  rasterized (render + read visually); multi-column ballots scramble
  naive text extraction (sort blocks x-column then y); WebFetch GUESSED
  a baseline-shaped order from compressed streams for Ward 8 — discarded
  (trap: plausible fabrication by tooling).

### Batch 5 fetch-gotcha bank (cross-state summary)

- Wayback REPLAY hard-down the entire batch (503 "Temporarily Offline"
  on every /web/<ts>id_/ form, ~150 attempts across agents); CDX
  intermittent (prefix queries best; regex filter= 500s; curl needs -g
  for bracketed filters). Recoverable snapshots are logged per entry.
- r.jina.ai proxy now Cloudflare-403s many hosts it used to defeat
  (portlandmaine.gov, casscountynd.gov, sdsos.gov, web.archive.org,
  merrimacknh.gov) — treat it as intermittent, not a reliable bypass.
- 200-but-404 traps: gc.nh.gov (~18.8KB 404 page), legislature.vermont
  .gov wrong-chapter (~57.9KB generic), ndlegis.gov NDAC (~69KB HTML on
  missing PDFs), vip.sdsos.gov (752B "Buffer cannot be null"),
  dcboe.org year-in-path ignored. ALWAYS magic-byte/size-check.
- JS-shell statute hosts + their real routes: akleg.gov →
  statutes.asp?media=print&secStart=…&secEnd=…; sdlegislature.gov →
  /api/Statutes/Statute/<cite> + /api/Rules/<article> (leading zero);
  regulations.delaware.gov → JSON API (POST /api/AdminCode/title);
  dcregs.dc.gov → ASP.NET __VIEWSTATE postback returns .doc;
  rules.mt.gov Esper SPA (API 403s — use sosmt.gov MAR PDFs);
  rules.wyo.gov search-form app (unreachable to fetchers).
- Akamai (mm.nh.gov): UA alone insufficient — needs full Chrome header
  set (sec-ch-ua + Sec-Fetch-* + Referer). Cloudflare walls where PDF
  paths still work: vote.sos.ri.gov, merrimacknh.gov.
- Multi-column ballot faces REQUIRE coordinate extraction (sort blocks
  by x-bucket then y; gap-based buckets, never fixed thirds — a wrong
  bucket "refutes" true claims); naive get_text() inverted AK
  measures-vs-retention and would scramble ND/VT/RI columns. Image-only
  faces (DE ExpressVote XL renders, ME/NH some towns, DC voter guides):
  render + read visually or crop columns + tesseract (OCR misreads
  small header digits — identify ballots by URL, not header).
- Purge patterns: county/town sites keep only the current cycle
  (concordnh.gov, bedfordnh.org, Burlington VT, MT populous counties,
  brookingscountysd.gov) — durable archives found: dover.nh.gov (back
  to 2014), goffstownnh.gov /478/Prior-Years, maps.laramiecounty.com
  per-precinct archive (UNPADDED precinct slugs), elections.ri.gov
  statewide compendiums, elections.delaware.gov per-cycle indexes
  (naming changes per cycle — enumerate index hrefs, never construct).

## November 2026 printed-ballot pass (2026-10-04)

Official November 3, 2026 ballots read against the encoded order. "Encoded" means a rule was added or changed in
`backend/src/pipeline/address/stateBallotOrderRules.ts`; "matches" means the existing rule or the baseline already printed
the same order.

| State / county | Printed ballot | Result |
| --- | --- | --- |
| CA — Los Angeles County | Voter's own official ballot, style 2E633 (Baldwin Park); Elec. Code § 13109.8 | Encoded as a county order (local first, federal last, measures inside each block) |
| CA — San Bernardino County | https://uploads.rov.sbcounty.gov/ROV/Elections/2026/1103/VIG.pdf | Matches § 13109 |
| CA — San Francisco | https://media.api.sf.gov/documents/N26_EN_VIP.pdf (p. 4) | Matches § 13109 |
| CA — Riverside County | https://docs.voteinfo.net/voterInformation/root1103/ballots/bt000009.pdf | Matches § 13109 |
| CA — San Diego County | https://www.sdvote.com/content/dam/rov/en/sb/SB-ENG-111.pdf | Matches § 13109 |
| CA — Santa Barbara County | https://www.sbcvote.com/SampleballotandpollplaceLookup/ballots/bt000001.pdf | Matches § 13109 |
| AK | https://www.elections.alaska.gov/election/2026/General/SampleBallots/HD16-JD3.pdf | Encoded: measures before retention |
| AL — Jefferson, Limestone, Madison, Marshall, Mobile, Montgomery, Morgan, Shelby, Tuscaloosa | https://www.sos.alabama.gov/alabama-votes/2026-general-election-sample-ballots | Encoded: second executive run after the appellate courts |
| FL — Miami-Dade County | https://www.miamidade.gov/elections/library/2026-11-03-general-election-sample-ballot.pdf | Encoded: nonpartisan county offices and city offices in the nonpartisan section |
| GA — Fulton County | https://www.fultoncountyga.gov/-/media/2026-Election/November-3-Election/Sample-Ballot--Consolidated--Nov-32026-General--Special-Election--9282026.pdf | Encoded: executives between US Senate and US House |
| ID — Canyon County | https://elections.canyoncounty.id.gov/wp-content/uploads/2026/10/Sample-Ballot-November-2026.jpg | Matches the baseline |
| KY — Kenton, Warren, Fayette, Jefferson | https://web.sos.ky.gov/electionballots/ (`<County> 2026G.pdf`; Jefferson precinct ballots on the county clerk site) | Encoded: judges and school boards after county offices, city offices last |
| MD — Montgomery County, Baltimore City | https://elections.maryland.gov/elections/2026/general_ballots/ | Matches |
| MO — Kansas City | https://kceb.org/sample-ballot-for-november-3-2026-election/ | Encoded: executives before US House |
| MS — statewide sample | https://www.sos.ms.gov/elections-voting (Sample Ballot 9-9-26) | Encoded: judicial after the legislature, before county and school |
| NC — Johnston County | https://www.johnstonnc.gov/joconcelections/content.cfm?pageid=220 | Matches |
| NE — Douglas County | https://www.votedouglascounty-ne.gov/elections/2026/General/GN26SampleBallot.pdf | Encoded: Legislature after the county ticket |
| NY — Suffolk County | https://www.suffolkcountyny.gov/Portals/0/formsdocs/boe/GeneralElection2026EmergencyBallotBooklet.pdf | Encoded: executives before US Senate and US House |
| PA — Mercer County | https://www.mercercountypa.gov/election/Ballots/2026/GENERAL/1.pdf | Encoded: executives between US Senate and US House |
| TN — Davidson County | https://www.nashville.gov/departments/elections/voters/sample-ballots | Matches |
| TX — Harris County | https://www.harrisvotes.com/Voter/Whats-on-my-Ballot | Matches |
| IA — Black Hawk County | https://blackhawkcountyelections.iowa.gov/elections/info/2026_general_election_2026_11_03/ | Matches |
| IL — McLean County | https://health.mcleancountyil.gov/1600/Ballots (2026 General specimen ballot) | Tier order matches; executive ladder encoded (Governor, Attorney General, Secretary of State, Comptroller, Treasurer) |
| KS — Johnson County | https://www.jocoelection.org/events-elections/november-3-2026-general-election (Notice of Election) | Matches |
| MI — Kent County | https://www.kentcountymi.gov/DocumentCenter/View/8870 (candidates and proposals by ballot section) | Encoded: nonpartisan city offices after the judges, before local school boards |
| MN — Hennepin County (SD 45B) | Secretary of State sample ballot for precinct style 45B | Matches |
| NM — Santa Fe County | https://www.santafecountynm.gov/clerk/elections/sample-ballots | Encoded: the presidential-year judicial placement also applies in governor years; executive ladder |
| OH — statewide | Secretary of State Directive 2026-45, "Order of offices for all ballots" | Encoded: Common Pleas and County Court judges before the county offices |
| VA — Fairfax County | https://www.fairfaxcounty.gov/elections/sample-ballots | Matches |

Not yet read (no public November 2026 ballot found as of 2026-10-04, or the sample ballot sits behind a voter-identity
lookup): AR, AZ, CO, CT, DC, DE, HI, IN, LA, MA, ME, MT, ND, NH, NJ, NV, OK, OR, RI, SC, SD, UT, VT, WA, WI, WV, WY, and the
California counties of Orange, Santa Clara, Alameda, Sacramento and Contra Costa. Several of these states mail
ballots in mid-October and had not posted samples yet.
