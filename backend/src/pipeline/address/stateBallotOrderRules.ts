import type { BallotLookupElectionSummary } from "./ballotLookup.js";
import { judicialCourtOffset, stateBaselineContestRank } from "./ballotContestRank.js";
import { isJudicialRetentionTitle } from "../../ai/electionPartisanshipPolicy.js";

// ---------------------------------------------------------------------------
// Per-state contest-order overrides for the `state_baseline` ballot sort.
//
// Evidence source: docs/research/state-ballot-order.md (the 50-state + DC
// contest-order research campaign). Encoding policy, decided there:
//   - GRADE-A states, plus states whose order was later confirmed on
//     printed November 2026 ballots (PA, KY, MO, AK, MS, GA, NY). ID was checked
//     against its printed ballot and matches the baseline; AR keeps the
//     baseline until a printed ballot confirms its order.
//   - DEVIATIONS only: a rule returns a rank ONLY for contests the state
//     provably moves; everything else returns null and falls through to
//     stateBaselineContestRank. States whose verified order matches the
//     baseline get no entry at all.
//   - GENERAL elections only: the research graded general-election order,
//     so overrides fire only when election_stage === "general". Primaries,
//     runoffs, specials, and stage-unknown elections keep the baseline.
//   - Each entry respects its doc entry's GRADE SCOPE: legs the research
//     excluded from A (conflicts, delegation-only, below-tier evidence) are
//     NOT encoded, even when observed practice is consistent.
//
// Grade-A states with NO entry (deliberate — checked against the doc):
//   DE (10)  baseline spine exact for every tier Delaware has
//   RI (44)  A scope stops at the state house; local internals excluded
//   CO (08)  retention-block position matches the baseline's late block
//   WV (54)  in-scope legs already match the baseline shape
//   ND (38)  the legislature-above-executives inversion sits in the
//            A-excluded intra-party-ladder leg; in-scope legs match
//
// Granularity: overrides can only move whole tiers (office scope, judicial
// family + court level, measure district type). Within-tier office ladders
// (executive internal order, county-row sequences, DA/SBOE/township slots
// on unmodeled scopes) are below this resolution and stay unencoded even
// where the doc records them. Title tests are used only where a state's
// tier assignment itself hinges on one (same precedent as
// judicialCourtOffset) and the doc's evidence backs the split.
// ---------------------------------------------------------------------------

export type StateRankableElection = Pick<
  BallotLookupElectionSummary,
  | "race_type"
  | "discovery_contest_family"
  | "district"
  | "office"
  | "official_ballot_title"
  | "election_stage"
  | "election_date"
  | "is_partisan"
> &
  Partial<Pick<BallotLookupElectionSummary, "printed_ballot_label">>;

// Pre-derived contest facts shared by every state rule, so each rule stays a
// few-line declarative mapping.
type ContestFacts = {
  // Office scope, falling back to the district type (same resolution rule as
  // the baseline). For measures this is the measure's district type.
  scope: string;
  measure: boolean;
  judicial: boolean;
  senate: boolean;
  // judicialCourtOffset(title) for judicial contests, 0 otherwise. Rules add
  // it at their own tier position to keep supreme -> appeals -> trial.
  court: number;
  title: string;
  // Election year, for the one cycle-scoped entry (NM).
  year: number;
  // The stored partisan flag; null when the row does not say.
  partisan: boolean | null;
  // 5-digit FIPS of the voter's county, for the few state rules that carry
  // a one-county exception; null when the ballot does not resolve to one.
  county: string | null;
};

// A state's deviation map: rank for contests the state provably moves,
// null for everything the baseline already places correctly.
type StateOrderRule = (c: ContestFacts) => number | null;

function contestFacts(election: StateRankableElection, countyFips: string | null = null): ContestFacts {
  const judicial = election.discovery_contest_family === "judicial_office";
  return {
    scope: election.office?.scope ?? election.district.district_type,
    measure: election.race_type === "ballot_measure",
    judicial,
    senate: election.discovery_contest_family === "us_senate",
    court: judicial ? judicialCourtOffset(election.official_ballot_title) : 0,
    title: election.official_ballot_title,
    year: Number(election.election_date.slice(0, 4)),
    partisan: election.is_partisan ?? null,
    county: countyFips,
  };
}

// A statewide executive-branch contest: the tier most states relocate.
// Excludes US Senate (statewide scope, federal slot) and statewide courts.
function statewideExec(c: ContestFacts): boolean {
  return c.scope === "statewide" && !c.measure && !c.judicial && !c.senate;
}

function school(c: ContestFacts): boolean {
  return (
    !c.measure &&
    (c.scope === "school_elementary" || c.scope === "school_secondary" || c.scope === "school_unified")
  );
}

// California's executive ladder, identical in § 13109(c) and § 13109.8(d):
// Governor, Lieutenant Governor, Secretary of State, Controller, Treasurer,
// Attorney General, Insurance Commissioner, Board of Equalization. Returned
// as a sub-rank that never reaches the next tier.
const CA_EXECUTIVE_LADDER: readonly RegExp[] = [
  /^governor\b/i,
  /\blieutenant governor\b/i,
  /\bsecretary of state\b/i,
  /\bcontroller\b/i,
  /\btreasurer\b/i,
  /\battorney general\b/i,
  /\binsurance commissioner\b/i,
  /\bboard of equalization\b/i,
];

function caExecutiveOffset(title: string): number {
  const index = CA_EXECUTIVE_LADDER.findIndex((pattern) => pattern.test(title));
  return (index === -1 ? CA_EXECUTIVE_LADDER.length : index) * 0.01;
}

// California's judicial ladder, identical in § 13109(i) and § 13109.8(e):
// Supreme Court, then presiding justices of the Court of Appeal, then its
// associate justices (each run in division order), then everything else.
const DIVISION_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function caJudicialOffset(title: string): number {
  if (/\bsupreme\b/i.test(title)) {
    return 0;
  }
  if (!/\bcourt of appeal\b/i.test(title)) {
    return 0.6;
  }
  const division = /\bdivision (\w+)/i.exec(title);
  const divisionRank = division ? DIVISION_WORDS.indexOf(division[1].toLowerCase()) + 1 : 0;
  return (/\bpresiding\b/i.test(title) ? 0.3 : 0.4) + divisionRank * 0.01;
}

// Baseline tier anchors, for reading the numbers below: presidential 0,
// us_senate 10, us_house 20, statewide 30, state_executive_council 35,
// state_upper 40, state_lower 50,
// county 60, place 70, school 80, judicial 82-90, unknown 95, measures 100.

const STATE_ORDER_RULES: Record<string, StateOrderRule> = {
  // AK — ballot measures print before the judicial retention questions
  // (Supreme Court, then Superior, then District Court), which close the
  // ballot (House District 16 Nov 2026 official sample ballot).
  "02": (c) => (c.measure ? 81 : null),

  // AL — § 17-6-25 ladder items (2)-(21). Gov + LtGov (items 2-3) precede
  // US Senate/House; Supreme/appellate courts follow the legislature; trial
  // courts precede every county office. Attorney General keeps the slot
  // after US House; the second executive run (Secretary of State, Treasurer,
  // Auditor, Agriculture, Public Service Commission, State Board of
  // Education) prints after the appellate courts (Jefferson County Nov 2026
  // sample ballot). Not encoded: measure placement, the item-(22) county tier.
  "01": (c) => {
    if (statewideExec(c)) {
      if (/governor/i.test(c.title)) {
        return 5;
      }
      return /\battorney general\b/i.test(c.title) ? null : 55;
    }
    if (c.judicial) {
      return c.scope === "statewide" ? 52 + c.court : 57 + c.court;
    }
    return null;
  },

  // AZ — EPM ballot order + § 16-502. Only Governor precedes the
  // legislature; the remaining executives print after the state house.
  // Judicial retention opens the nonpartisan section (before school);
  // JP/constable are the LAST partisan contests, right after the county
  // offices; municipal is last among candidate races, after school.
  // A-excluded: contested Superior Court placement (La Paz 2022 vs 2025
  // EPM conflict) — those county-scoped contests keep the baseline.
  "04": (c) => {
    if (statewideExec(c)) {
      return /^governor\b/i.test(c.title) ? 35 : 55;
    }
    if (c.judicial) {
      if (c.scope === "statewide") {
        return 62 + c.court;
      }
      // County-scoped judicial splits three ways: JP/constable close the
      // partisan section; Superior Court RETENTION (Maricopa/Pima/Pinal/
      // Coconino) prints inside the nonpartisan-opening judicial block;
      // contested Superior Court stays baseline (the A-excluded conflict).
      if (/\b(justice of the peace|constable)\b/i.test(c.title)) {
        return 61;
      }
      if (isJudicialRetentionTitle(c.title)) {
        return 62 + c.court;
      }
      return null;
    }
    if (c.scope === "place" && !c.measure) {
      return 85;
    }
    return null;
  },

  // CA — Elec. Code § 13109: statewide executives before US Senate; judicial
  // in one block after the legislature; school before county and city.
  // (Los Angeles County prints the § 13109.8 alternate order instead — see
  // COUNTY_ORDER_RULES.)
  "06": (c) => {
    if (statewideExec(c)) {
      // Superintendent of Public Instruction is statewide-scoped in the
      // office catalog but is NOT in the § 13109(c) state block — it heads
      // the SCHOOL block (§ 13109(j)), after judicial, before the
      // school-district contests.
      return /\bsuperintendent\b/i.test(c.title) ? 54.5 : 5 + caExecutiveOffset(c.title);
    }
    if (c.judicial) {
      return 52 + caJudicialOffset(c.title);
    }
    if (school(c)) {
      return 55;
    }
    return null;
  },

  // CT — SOTS head order: Gov/LtGov above US Senate/House; the remaining
  // executives (SOS, Treasurer, Comptroller, AG) below the legislature;
  // probate judge = the last statutory office slot.
  "09": (c) => {
    if (statewideExec(c)) {
      return /^governor\b/i.test(c.title) ? 5 : 55;
    }
    if (c.judicial) {
      return 89;
    }
    return null;
  },

  // DC — BOE contest order (a)-(p). The us_house district carries the REAL
  // Delegate (titled "United States Representative, DC At-Large" in the
  // data, not "Delegate"), which keeps the baseline federal slot; the
  // SHADOW US Senator/Representative are DC-wide offices printing late,
  // after the Mayor/Council/AG block. Mayor rides the place-scoped city
  // district and prints right after the Delegate, ABOVE the statewide
  // Council run; ward councilmembers print inside that run; AG closes it;
  // SBOE then ANC close the office list. Measures-last matches the
  // baseline. (No elected judicial contests exist in DC.)
  "11": (c) => {
    if (c.measure || c.judicial) {
      return null;
    }
    if (c.senate || (c.scope !== "us_house" && /\bunited states senator\b/i.test(c.title))) {
      return 33; // shadow US Senator
    }
    if (c.scope !== "us_house" && /\bunited states representative\b/i.test(c.title)) {
      return 33.5; // shadow US Representative
    }
    if (/\bstate board of education\b/i.test(c.title)) {
      return 34; // SBOE (at-large and ward), after the shadow offices
    }
    if (c.scope === "place") {
      if (/\badvisory neighborhood\b/i.test(c.title)) {
        return 34.5; // ANC — the final office block before measures
      }
      return /\bmayor\b/i.test(c.title) ? 29 : 30.5;
    }
    if (c.scope === "statewide" && /\bchair/i.test(c.title)) {
      return 29.5; // Council Chairman: after Mayor, before the At-Large seats
    }
    if (c.scope === "statewide" && /\battorney general\b/i.test(c.title)) {
      return 31; // AG prints after the whole Council block, ward seats included
    }
    return null;
  },

  // FL — rule 1S-2.032(7): the nonpartisan section follows the partisan
  // offices and runs judicial, nonpartisan county offices, school board,
  // then municipal offices (Miami-Dade Nov 2026 sample ballot: retention,
  // Circuit Judge, County Commissioner, School Board, city offices,
  // districts, amendments, county and school referendums).
  "12": (c) => {
    if (c.judicial) {
      return 75 + c.court;
    }
    if (c.measure) {
      return null;
    }
    if (c.scope === "county" && c.partisan === false) {
      return 77;
    }
    if (c.scope === "place" && c.partisan !== true) {
      return 81;
    }
    return null;
  },

  // GA — statewide executives print after US Senate and before US House
  // (Fulton County consolidated Nov 2026 sample ballot: US Senate, Governor,
  // Lt. Governor, Secretary of State, Attorney General, Agriculture,
  // Insurance, School Superintendent, Labor, Public Service Commission, US
  // House, State Senate, State House, county, school, amendments).
  "13": (c) => (statewideExec(c) ? 15 : null),

  // HI — § 11-114 + 247/247 printed proofs: OHA trustees (statewide scope)
  // sit between the state house and county; county charter questions print
  // after state amendments. A-excluded: the Prosecuting Attorney slot
  // (never observed).
  "15": (c) => {
    if (statewideExec(c) && /hawaiian affairs/i.test(c.title)) {
      return 55;
    }
    if (c.measure && c.scope !== "statewide") {
      return 100.5;
    }
    return null;
  },

  // IL — statewide measures print FIRST (constitutional-amendment ballot
  // requirement), local referenda still last; statewide executives before
  // US House; Chicago school board prints after the judicial block.
  "17": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? -10 : null;
    }
    if (statewideExec(c)) {
      return 15;
    }
    if (school(c)) {
      return 91;
    }
    return null;
  },

  // IN — IC 3-11-2-12/12.4: public questions first (statewide then local);
  // statewide executives before US House; elected trial courts early (after
  // the state house), the retention block late — dead last, after school.
  // The retention block includes the authorized LOCAL retentions
  // (Lake/St. Joseph/Marion superior), which arrive county-scoped — keyed
  // on the retention title, not the scope. A-excluded (not encoded): the
  // at-large hoist (manual gloss and statute pull apart).
  "18": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? -10 : -5;
    }
    if (statewideExec(c)) {
      return 15;
    }
    if (c.judicial) {
      if (c.scope === "statewide" || isJudicialRetentionTitle(c.title)) {
        return 92 + c.court;
      }
      return 52 + c.court;
    }
    return null;
  },

  // IA — § 49.31 ff.: township + special-district contests sit between
  // county and the retention block, so retention drops below the unknown
  // tier; measure sub-order state -> county -> city.
  "19": (c) => {
    if (c.judicial) {
      return 96 + c.court;
    }
    if (c.measure && c.scope !== "statewide") {
      return c.scope === "county" ? 100.3 : 100.6;
    }
    return null;
  },

  // KS — § 25-611/613: partisan district judges/magistrates print between
  // the state house and county. A-excluded (not encoded): retention
  // placement at EVERY level — it is card-structure dependent (a county
  // choice under 25-601/618/620), so retention rows (statewide appellate
  // AND the nonpartisan-district retentions, which arrive county-scoped)
  // all keep the baseline late block.
  "20": (c) => {
    if (c.judicial && c.scope !== "statewide" && !isJudicialRetentionTitle(c.title)) {
      return 52 + c.court;
    }
    return null;
  },

  // KY — the nonpartisan tail prints after the county offices: judges, then
  // school boards, then city offices (Kenton and Warren Nov 2026 ballots on
  // the Secretary of State site; the judge/school order flips in some
  // counties, city follows both). The two merged city-county governments
  // print differently on their Nov 2026 ballots:
  //   Fayette (Lexington): judges, urban county mayor and council, school.
  //   Jefferson (Louisville): the baseline office order (county, metro
  //   mayor and council, school board, then the judicial ballot), with the
  //   constitutional amendment right after US Senator.
  "21": (c) => {
    if (c.county === "21111") {
      return c.measure && c.scope === "statewide" ? 12 : null;
    }
    if (c.judicial) {
      return 62 + c.court;
    }
    if (c.county === "21067" && c.scope === "place" && !c.measure) {
      return 63;
    }
    if (school(c)) {
      return 64;
    }
    return null;
  },

  // LA — R.S. 18:551: statewide executives above US Senate/House; appellate
  // courts inside the state block after US House; trial courts + DA atop
  // the parish block; school board before municipal.
  "22": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    if (c.judicial) {
      return c.scope === "statewide" ? 25 + c.court : 59 + c.court;
    }
    if (school(c)) {
      return 65;
    }
    return null;
  },

  // ME — 21-A § 601(3): Governor between US Senate and US House (Maine's
  // only statewide executive contest); probate judge heads the county
  // block (Maine's only elected judgeship). Measures-separate-ballot is
  // A-excluded (SOS discretion) — measure tier stays baseline.
  "23": (c) => {
    if (statewideExec(c)) {
      return 15;
    }
    if (c.judicial) {
      return 59 + c.court;
    }
    return null;
  },

  // MD — statewide executives above US Senate (Senate prints FIFTH);
  // judicial mid-ballot before county row offices, with the internal order
  // INVERTED: circuit (trial) first, then Supreme, then Appellate — so the
  // shared court offset is remapped, not added.
  "24": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    if (c.judicial) {
      // Own title tests, not the shared court offset: MD's 2022 renames
      // ("Supreme Court of Maryland", "Appellate Court of Maryland") mean
      // /appel/ must catch "Appellate", which the shared /\bappeal/ misses.
      if (/\bsupreme\b/i.test(c.title)) {
        return 55.3;
      }
      if (/appel/i.test(c.title)) {
        return 55.6;
      }
      return 55; // circuit (trial) courts print first
    }
    return null;
  },

  // MA — c.54 head order: statewide executives between US Senate and US
  // House. No judicial or municipal contests on state ballots (empty tiers
  // need no encoding); the Councillor tier has no modeled scope.
  "25": (c) => {
    if (statewideExec(c)) {
      return 15;
    }
    return null;
  },

  // MI — MCL 168.697: Gov/SOS/AG before US Senate/House; the partisan
  // education/university boards (also statewide scope) instead print
  // between the state legislature and county; judicial leads the
  // nonpartisan section, then nonpartisan city and village offices, then
  // local school districts (Kent County Nov 2026 candidate and proposal
  // listing: judicial, community college, city, village, local school).
  "26": (c) => {
    if (statewideExec(c)) {
      return /\b(university|state board of education|regents?|trustees?)\b/i.test(c.title) ? 55 : 5;
    }
    if (c.judicial) {
      return 75 + c.court;
    }
    if (c.scope === "place" && !c.measure && c.partisan !== true) {
      return 78;
    }
    return null;
  },

  // MN — Rule 8250.1810: legislature before the statewide executives;
  // statewide amendments right after the state offices (before county);
  // judicial offices dead last, after every question.
  "27": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? 57 : null;
    }
    if (statewideExec(c)) {
      return 55;
    }
    if (c.judicial) {
      return 105 + c.court;
    }
    return null;
  },

  // MS — the nonpartisan judicial election prints after the federal and
  // legislative contests and before the county and school elections
  // (Secretary of State Nov 2026 sample ballot: US Senate, US House, special
  // legislative and district attorney contests, Court of Appeals, Chancery,
  // Circuit).
  "28": (c) => (c.judicial ? 55 + c.court : null),

  // MO — statewide executives print before US Representative (Kansas City
  // Election Board Nov 2026 sample ballot: State Auditor, US Representative,
  // State Senator, State Representative, county, judicial ballot,
  // amendments; same spine on nine 2022-2024 county ballots).
  "29": (c) => (statewideExec(c) ? 15 : null),

  // MT — judicial mid-ballot between the statewide executives/PSC and the
  // legislature; JP is instead the last county office. Municipal/school
  // tiers are empty in November (no encoding needed).
  "30": (c) => {
    if (c.judicial) {
      return /justice of the peace/i.test(c.title) ? 65 : 35 + c.court;
    }
    return null;
  },

  // NE — § 32-813(9): the statewide-measure ballot comes LAST, after local
  // measures (inverting the usual state-before-local practice). The
  // nonpartisan ticket prints after the county ticket, and the Legislature
  // heads it (Douglas County Nov 2026 countywide sample ballot; Lancaster
  // 2024): US Senate, US House, state ticket, county ticket, Legislature,
  // boards, city, school, judges, special issues.
  "31": (c) => {
    if (c.measure && c.scope === "statewide") {
      return 101;
    }
    if (c.scope === "state_upper" && !c.measure && !c.judicial) {
      return 65;
    }
    return null;
  },

  // NV — sample-verified order: judicial early (Supreme/Appeals + District
  // after the partisan county offices), school after judicial but before
  // municipal, JPs last among offices (after city). JPs arrive
  // COUNTY-scoped (townships have no modeled district), so they are keyed
  // on the title, with municipal judicial.
  "32": (c) => {
    if (c.judicial) {
      if (c.scope === "place" || /\bjustice of the peace\b/i.test(c.title)) {
        return 75 + c.court;
      }
      return 62 + c.court;
    }
    if (school(c)) {
      return 65;
    }
    return null;
  },

  // NH — RSA 656:7 ladder: Governor promoted to slot 2, before US Senate
  // and US House (New Hampshire's only statewide executive contest).
  // Municipal/school/village/judicial tiers empty by statute. A-excluded:
  // county-block internal order (below tier granularity anyway).
  "33": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    return null;
  },

  // NJ — measures-last holds, but the internal order is statewide ->
  // municipal -> county. The Governor slot is odd-year-moot and the
  // judicial tier does not exist; school money questions ride with the
  // school contest (recorded, below granularity).
  "34": (c) => {
    if (c.measure && c.scope !== "statewide") {
      return c.scope === "place" ? 100.3 : c.scope === "county" ? 100.6 : 100.8;
    }
    return null;
  },

  // NM — § 1-10-8: partisan judicial before ALL county offices (county =
  // last offices), and retention leads the question block ahead of the
  // amendments. Same shape in presidential and gubernatorial years (Santa
  // Fe County Nov 2026 sample ballot: executives, State Representative,
  // Court of Appeals, District and Magistrate judges, county offices,
  // judicial retention, constitutional amendments).
  "35": (c) => {
    if (c.judicial) {
      // Shared retention matcher: catches both "Retention of Judge X" and
      // the standard question form "Shall Justice X be retained in office?".
      return isJudicialRetentionTitle(c.title) ? 99 + c.court : 55 + c.court;
    }
    return null;
  },

  // NY — Election Law § 7-104(11)(a): Governor and Lieutenant Governor,
  // Comptroller, Attorney General print before US Senator and
  // Representative in Congress (Suffolk County Nov 2026 ballot booklet).
  "36": (c) => (statewideExec(c) ? 5 : null),

  // NC — GS 163-165.6: judicial within level — appellate courts between the
  // Council of State and the legislature, trial courts between the state
  // house and county. The partisan/nonpartisan interleave below that is
  // under tier granularity.
  "37": (c) => {
    if (c.judicial) {
      return c.scope === "statewide" ? 31 + c.court : 51 + c.court;
    }
    return null;
  },

  // OH — RC 3505.03 and Secretary of State Directive 2026-45 (order of
  // offices for the Nov 2026 ballots): statewide executives, Supreme Court,
  // US Senator, Representative to Congress, State Senator, State
  // Representative, Court of Appeals, Common Pleas, County Court, then the
  // county offices.
  "39": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    if (c.judicial) {
      // court: supreme 0, appeals 0.3, trial 0.6 -> three distinct OH slots.
      return c.court === 0 ? 7 : c.court === 0.3 ? 55 : 56;
    }
    return null;
  },

  // OK — statewide executives before US Senate/House; contested trial
  // courts after county with appellate retention after them, both before
  // the State Questions. County questions/municipal/school ride separate
  // ballots outside this sequence (no encoding).
  "40": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    if (c.judicial) {
      return c.scope === "statewide" ? 67 + c.court : 65 + c.court;
    }
    return null;
  },

  // OR — ORS 254.135: judicial prints before the (mostly nonpartisan)
  // county/city/special-district contests. The partisan-before/nonpartisan-
  // after split around it and BOLI's slot are below tier granularity.
  "41": (c) => {
    if (c.judicial) {
      return 55 + c.court;
    }
    return null;
  },

  // PA — 25 P.S. § 2963 specimen: Governor and the other statewide
  // executives print after US Senator and before Representative in Congress
  // (Mercer County Nov 2026 official ballot; Montgomery County 2024).
  "42": (c) => (statewideExec(c) ? 15 : null),

  // SC — § 7-13-330/335 SEC template: state ticket before the congressional
  // ticket (statewide executives above US Senate/House). Everything from
  // the State Senate DOWN is county-arranged (graded B) — A-excluded, so
  // nothing below the executive move is encoded.
  "45": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    return null;
  },

  // SD — county questions print AFTER the statewide measures. The
  // NONPOLITICAL block's position (after county, before questions) already
  // matches the baseline because the municipal/school tiers are empty in
  // November; retention -> circuit internal order is the shared court split.
  "46": (c) => {
    if (c.measure && c.scope === "county") {
      return 100.5;
    }
    return null;
  },

  // TN — § 2-5-208: Governor in slot 2 before US Senate/House (Tennessee's
  // only statewide executive contest), state constitutional amendments
  // right behind (NOT last; local questions still trail), judicial after
  // the state house, school inside the county block before municipal.
  // County-scoped judicial rows split by CLASS: circuit/chancery/criminal
  // courts (items (J)-(L)) belong to the early block right after the state
  // house even though their judicial districts arrive county-scoped; only
  // the general-sessions class ((S)-(T)) rides just behind the county line.
  // Municipal judicial last ~= the baseline place-judicial slot (no move).
  "47": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? 7 : null;
    }
    if (statewideExec(c)) {
      return 5;
    }
    if (c.judicial) {
      // § 2-5-208(c)(3): retention questions go to the END of the ballot,
      // ahead of the other (local) questions — never the early block.
      if (isJudicialRetentionTitle(c.title)) {
        return 99 + c.court;
      }
      if (c.scope === "place") {
        return null;
      }
      if (c.scope === "county") {
        return /\b(general sessions|juvenile)\b/i.test(c.title) ? 61 : 52 + c.court;
      }
      return 52 + c.court;
    }
    if (school(c)) {
      return 65;
    }
    return null;
  },

  // TX — Elec. Code 52.092: judicial within level — statewide courts after
  // the statewide executives, appellate/district courts after the state
  // house, county courts LEADING the county block, JP at the tail of the
  // precinct offices before municipal. The district-block courts have no
  // modeled scope of their own: appeals courts, district judges, and DAs
  // arrive county-scoped, and JPs/constables are county-scoped precinct
  // offices — so the county tier splits by title. JP/constable/DA surface
  // under BOTH discovery families, so those checks sit outside the
  // judicial gate. Measure-class sub-order and the per-subdivision
  // proposition interleave are below tier granularity.
  "48": (c) => {
    if (c.measure) {
      return null;
    }
    if (c.scope === "county" && /\b(justice of the peace|constable)\b/i.test(c.title)) {
      return 65.6; // precinct tail: after county, before municipal
    }
    if (c.scope === "county" && /\bdistrict attorney\b/i.test(c.title)) {
      return 51.6; // DAs close the district block
    }
    if (c.judicial) {
      if (c.scope === "statewide") {
        return 31 + c.court;
      }
      if (c.scope === "place") {
        return 65 + c.court;
      }
      if (/\b(district|appeals)\b/i.test(c.title)) {
        return 51 + c.court; // district block, after the state house
      }
      if (c.scope === "county") {
        return 59 + c.court; // true county courts lead the county block
      }
      return 51 + c.court;
    }
    return null;
  },

  // UT — § 20A-6-305: local school board at the end of the county block,
  // BEFORE municipal; judicial = one retention block after all candidate
  // contests (including the unmodeled special-district tier at 95).
  "49": (c) => {
    if (school(c)) {
      return 65;
    }
    if (c.judicial) {
      return 96 + c.court;
    }
    return null;
  },

  // VT — 17 V.S.A. § 2471(a)(1): statewide measures FIRST (hard inversion);
  // probate + assistant judges lead the county block. JP-last-among-offices
  // is A-excluded (practice only) — and the baseline place-judicial slot
  // already lands JP at the bottom, so place judicial stays baseline.
  "50": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? -10 : null;
    }
    if (c.judicial && c.scope !== "place") {
      return 59 + c.court;
    }
    return null;
  },

  // VA — school board contests print inside the locality blocks (right
  // after the locality's governing offices), not as a late tier; measures
  // run statewide before local. Judicial tier does not exist (no encoding);
  // town-block-last is below place-tier granularity (recorded).
  "51": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? null : 100.5;
    }
    if (school(c)) {
      return 72;
    }
    return null;
  },

  // WA — RCW 29A.36.170: measures FIRST (state, then local); judicial after
  // county but before municipal/school. The fixed executive internal order
  // is below tier granularity.
  "53": (c) => {
    if (c.measure) {
      return c.scope === "statewide" ? -10 : -5;
    }
    if (c.judicial) {
      return 65 + c.court;
    }
    return null;
  },

  // WI — § 5.64(1): statewide executives above US Senate + US House. The
  // DA tier has no modeled scope; municipal/school/judicial tiers are
  // empty in November.
  "55": (c) => {
    if (statewideExec(c)) {
      return 5;
    }
    return null;
  },

  // WY — § 22-6-121: judicial retention EARLY — after county, before
  // municipal and school. Community-college/special-district tiers have no
  // modeled scope.
  "56": (c) => {
    if (c.judicial) {
      return 65 + c.court;
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// County-scoped orders. A county listed here prints a contest order of its
// own, so its rule REPLACES the state rule and the baseline for every contest
// on that county's ballots (total mapping — it never returns null, and its
// ranks are only compared with each other). Same evidence bar as the state
// entries: statute or rule text plus a matching printed ballot.
// ---------------------------------------------------------------------------
type CountyOrderRule = (c: ContestFacts) => number;

const COUNTY_ORDER_RULES: Record<string, CountyOrderRule> = {
  // Los Angeles County, CA — Elec. Code § 13109.8 alternate order (in use
  // under § 13109.9; matches the Nov 2026 official ballot, style 2E633):
  // CITY/LOCAL (mayor, council, school boards, college board, other city
  // offices, then State Senate, Assembly, US House, then city and school
  // measures) -> DISTRICT -> COUNTY (offices, Superior Court, county
  // measures) -> STATE (executives, Superintendent last, state measures) ->
  // STATE JUDICIAL -> NATIONAL (President, US Senate). Measures print inside
  // their own jurisdiction's block, not in one closing block.
  "06037": (c) => {
    if (c.measure) {
      switch (c.scope) {
        case "place":
          return 5;
        case "school_elementary":
        case "school_secondary":
        case "school_unified":
          return 6;
        case "county":
          return 11;
        case "statewide":
          return 13;
        default:
          return 8;
      }
    }
    if (c.judicial) {
      // Superior Court sits in the COUNTY block; the retention questions
      // form their own STATE JUDICIAL block after the state measures.
      if (/\bsuperior court\b/i.test(c.title)) {
        return 10;
      }
      return 14 + caJudicialOffset(c.title);
    }
    switch (c.scope) {
      case "place":
        // § 13109.8(a): Mayor, Council, the school and college boards, then
        // the remaining city offices.
        if (/\bmayor\b/i.test(c.title)) {
          return 1;
        }
        return /\bcouncil/i.test(c.title) ? 1.1 : 1.6;
      case "school_unified":
        return 1.2;
      case "school_secondary":
        return 1.3;
      case "school_elementary":
        return 1.4;
      case "state_upper":
        return 2;
      case "state_lower":
        return 3;
      case "us_house":
        return 4;
      case "county":
        if (/\bsupervisor\b/i.test(c.title)) {
          return 9;
        }
        if (/\bsheriff\b/i.test(c.title)) {
          return 9.1;
        }
        return /\bassessor\b/i.test(c.title) ? 9.2 : 9.5;
      case "statewide":
        if (c.senate) {
          return 16;
        }
        return /\bsuperintendent\b/i.test(c.title) ? 12.5 : 12 + caExecutiveOffset(c.title);
      case "presidential":
        return 15;
      default:
        // College boards close the school run; every other district board
        // prints under DISTRICT.
        return /\bcollege\b/i.test(c.title) ? 1.5 : 7;
    }
  },
};

// County FIPS codes carrying a county-scoped order, exported for the tests.
export const OVERRIDDEN_COUNTY_FIPS: readonly string[] = Object.keys(COUNTY_ORDER_RULES);

// Facts about the whole ballot that one contest row cannot carry.
export type BallotOrderContext = {
  // 5-digit FIPS of the voter's county, when the ballot resolves to exactly
  // one county.
  countyFips?: string | null;
  // Election dates on which this ballot carries at least one general-stage
  // contest. Ballot measures and retention questions are stored without a
  // stage, and a top-two runoff is stored as `runoff`, yet all of them print
  // on the general ballot — they take the state's general-election order
  // when they share a date with a general contest.
  generalDates?: ReadonlySet<string>;
};

function printsOnGeneralBallot(election: StateRankableElection, context: BallotOrderContext): boolean {
  if (election.election_stage === "general") {
    return true;
  }
  return election.election_stage !== "primary" && (context.generalDates?.has(election.election_date) ?? false);
}

// ---------------------------------------------------------------------------
// Within-tier ladder for statewide executives. The tier rules above place the
// executive BLOCK; inside it the generic tie-break is the title alphabet,
// which prints Attorney General above Governor. Every state lists Governor
// first; the rest of the ladder is the state's own where the research doc
// records one (statute or rule text, docs/research/state-ballot-order.md
// "Office order"), and the common national sequence otherwise.
// ---------------------------------------------------------------------------
const EXECUTIVE_OFFICE: Record<string, RegExp> = {
  governor: /(?<!lieutenant )\bgovernor\b/i,
  lieutenant: /\blieutenant governor\b/i,
  secretary: /\bsecretary of (?:state|the commonwealth)\b/i,
  attorney: /\battorney general\b/i,
  treasurer: /\btreasurer\b/i,
  auditor: /\bauditor\b/i,
  comptroller: /\b(?:comptroller|controller)\b/i,
  cfo: /\bchief financial officer\b/i,
  superintendent: /\bsuperintendent\b/i,
  agriculture: /\bagriculture\b/i,
  insurance: /\binsurance\b/i,
  labor: /\blabor\b/i,
  lands: /\blands?\b/i,
  utilities: /\b(?:railroad|public service|public utilit(?:y|ies)|corporation) commission/i,
  mine: /\bmine inspector\b/i,
};

const GENERIC_EXECUTIVE_LADDER = [
  "governor", "lieutenant", "secretary", "attorney", "treasurer", "auditor", "comptroller", "cfo",
  "superintendent", "agriculture", "insurance", "labor", "lands", "utilities", "mine",
];

// Ladders that differ from the generic sequence, keyed by state FIPS.
const STATE_EXECUTIVE_LADDERS: Record<string, readonly string[]> = {
  "01": ["governor", "lieutenant", "attorney", "secretary", "treasurer", "auditor", "agriculture", "utilities"], // AL § 17-6-25
  "04": ["governor", "secretary", "attorney", "treasurer", "superintendent", "mine", "utilities"], // AZ EPM
  "12": ["governor", "attorney", "cfo", "agriculture"], // FL § 101.151(2)(a)
  "13": [
    "governor", "lieutenant", "secretary", "attorney", "agriculture", "insurance", "superintendent", "labor",
    "utilities",
  ], // GA printed ballots
  "16": ["governor", "lieutenant", "secretary", "comptroller", "treasurer", "attorney", "superintendent"], // ID art. IV § 1
  "17": ["governor", "attorney", "secretary", "comptroller", "treasurer"], // IL printed ballots
  "18": ["governor", "secretary", "auditor", "treasurer", "attorney"], // IN
  "19": ["governor", "secretary", "auditor", "treasurer", "agriculture", "attorney"], // IA 721—21.203(3)
  "20": ["governor", "secretary", "attorney", "treasurer", "insurance"], // KS
  "24": ["governor", "comptroller", "attorney"], // MD § 9-210(a)
  "25": ["governor", "attorney", "secretary", "treasurer", "auditor"], // MA c.54
  "27": ["governor", "secretary", "auditor", "attorney"], // MN Rule 8250.1810
  "29": ["governor", "lieutenant", "secretary", "treasurer", "attorney", "auditor"], // MO printed ballots
  "30": ["governor", "secretary", "attorney", "auditor", "superintendent", "utilities"], // MT
  "31": ["governor", "secretary", "treasurer", "attorney", "auditor"], // NE SOS order
  "32": ["governor", "lieutenant", "secretary", "treasurer", "comptroller", "attorney"], // NV
  "35": ["governor", "secretary", "attorney", "auditor", "treasurer", "lands"], // NM § 1-10-8(B)
  "36": ["governor", "comptroller", "attorney"], // NY § 7-104(11)(a)
  "37": [
    "governor", "lieutenant", "attorney", "auditor", "agriculture", "insurance", "labor", "secretary",
    "superintendent", "treasurer",
  ], // NC 08 NCAC 06B .0103(b)
  "39": ["governor", "attorney", "auditor", "secretary", "treasurer"], // OH RC 3505.03(C)
  "42": ["governor", "attorney", "auditor", "treasurer"], // PA printed ballots
  "45": ["governor", "secretary", "treasurer", "attorney", "comptroller", "superintendent", "agriculture"], // SC
  "46": ["governor", "secretary", "attorney", "auditor", "treasurer", "lands", "utilities"], // SD ARSD 05:02:06:01.04
  "48": ["governor", "lieutenant", "attorney", "comptroller", "lands", "agriculture", "utilities"], // TX § 52.092(c)
  "50": ["governor", "lieutenant", "treasurer", "secretary", "auditor", "attorney"], // VT
  "53": [
    "governor", "lieutenant", "secretary", "treasurer", "auditor", "attorney", "lands", "superintendent",
    "insurance",
  ], // WA WAC 434-230-025
  "54": ["governor", "secretary", "auditor", "treasurer", "agriculture", "attorney"], // WV
  "55": ["governor", "attorney", "secretary", "treasurer"], // WI § 5.62(3)
  "56": ["governor", "secretary", "auditor", "treasurer", "superintendent"], // WY § 22-6-117(a)
};

// Sub-rank that orders statewide executives inside their tier; 0 for every
// other contest. Compared only between contests whose tier rank ties.
export function withinTierOfficeRank(election: StateRankableElection): number {
  const facts = contestFacts(election);
  if (!statewideExec(facts)) {
    return 0;
  }
  const stateFips = election.district.state_fips;
  const ladder = Object.hasOwn(STATE_EXECUTIVE_LADDERS, stateFips)
    ? STATE_EXECUTIVE_LADDERS[stateFips]
    : GENERIC_EXECUTIVE_LADDER;
  const index = ladder.findIndex((office) => EXECUTIVE_OFFICE[office].test(facts.title));
  if (index !== -1) {
    return index;
  }
  // An office the state's ladder does not name keeps the generic sequence,
  // after every office the ladder does name.
  const generic = GENERIC_EXECUTIVE_LADDER.findIndex((office) => EXECUTIVE_OFFICE[office].test(facts.title));
  return ladder.length + (generic === -1 ? GENERIC_EXECUTIVE_LADDER.length : generic);
}

// ---------------------------------------------------------------------------
// Printed labels. A state or county can print a contest under a different
// label than the stored title carries. Per-measure numbers live on the row
// (elections.printed_ballot_label); county-wide patterns are rules here. The stored title stays the contest's
// identity; this only changes what a voter in that county sees in the ballot
// list, so it matches the paper ballot in hand.
// ---------------------------------------------------------------------------
type PrintedTitleRule = (election: StateRankableElection) => string | null;

const COUNTY_PRINTED_TITLE_RULES: Record<string, PrintedTitleRule> = {
  // Los Angeles County prints state propositions as "STATE MEASURE N" and
  // its own measures as "COUNTY MEASURE A" (Nov 2026 official ballot, styles
  // 2E633 and 2E634). Every other California county read prints
  // "PROPOSITION N".
  "06037": (election) => {
    if (election.race_type !== "ballot_measure") {
      return null;
    }
    const title = election.official_ballot_title;
    if (election.district.district_type === "statewide") {
      const match = /^Proposition (\d+)\b/.exec(title);
      return match ? `State Measure ${match[1]}${title.slice(match[0].length)}` : null;
    }
    if (election.district.district_type === "county") {
      return /^Measure [A-Z]{1,3}\b/.test(title) ? `County ${title}` : null;
    }
    return null;
  },
};

// Stored title with the paper ballot's label applied. The label replaces the
// stored title's own leading label (the text before the first colon), or is
// prefixed when the stored title has none:
//   "Act 2026-341: Lieutenant Governor vacancy" -> "Statewide Amendment 1: Lieutenant Governor vacancy"
//   "Next Generation 9-1-1 Fund Amendment"      -> "Proposed Constitutional Amendment 3: Next Generation 9-1-1 Fund Amendment"
export function applyPrintedBallotLabel(title: string, printedLabel: string | null | undefined): string {
  const label = printedLabel?.trim();
  if (!label) {
    return title;
  }
  const colon = title.indexOf(":");
  const rest = colon === -1 ? title.trim() : title.slice(colon + 1).trim();
  return rest ? `${label}: ${rest}` : label;
}

// Title to show for a contest on this voter's ballot: the stored printed
// label where one is set, then the county's printed label where one is
// encoded, the stored title otherwise.
export function printedBallotTitle(election: StateRankableElection, context: BallotOrderContext = {}): string {
  const title = applyPrintedBallotLabel(election.official_ballot_title, election.printed_ballot_label);
  const countyFips = context.countyFips ?? null;
  if (
    countyFips &&
    countyFips.startsWith(election.district.state_fips) &&
    Object.hasOwn(COUNTY_PRINTED_TITLE_RULES, countyFips)
  ) {
    return COUNTY_PRINTED_TITLE_RULES[countyFips]({ ...election, official_ballot_title: title }) ?? title;
  }
  return title;
}

// FIPS codes carrying an override, exported for the tests' gate sweep.
export const OVERRIDDEN_STATE_FIPS: readonly string[] = Object.keys(STATE_ORDER_RULES);

// Rank of a summary election for the `state_baseline` sort: the county's
// own order where one is encoded, else the state's verified general-election
// deviation, else the generic baseline. Single entry point for the ordering
// decorator.
export function stateBallotContestRank(
  election: StateRankableElection,
  context: BallotOrderContext = {}
): number {
  // Own-key lookups: the districts table does not enforce the FIPS format,
  // so a malformed value must miss instead of resolving an inherited
  // Object.prototype member.
  const countyFips = context.countyFips ?? null;
  if (
    countyFips &&
    countyFips.startsWith(election.district.state_fips) &&
    Object.hasOwn(COUNTY_ORDER_RULES, countyFips)
  ) {
    return COUNTY_ORDER_RULES[countyFips](contestFacts(election));
  }
  if (printsOnGeneralBallot(election, context)) {
    const rule = Object.hasOwn(STATE_ORDER_RULES, election.district.state_fips)
      ? STATE_ORDER_RULES[election.district.state_fips]
      : undefined;
    if (rule) {
      const override = rule(contestFacts(election, countyFips));
      if (override !== null) {
        return override;
      }
    }
  }
  return stateBaselineContestRank(election);
}
