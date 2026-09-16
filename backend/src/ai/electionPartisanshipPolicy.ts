import type { ElectionDraftPayload, ElectionRaceType } from "../types/election.js";

type ContestFamily = "all" | "non_judicial_office" | "judicial_office" | "ballot_measure" | "us_senate";
type SchoolPartisanshipMode = "partisan" | "mixed" | "nonpartisan";
type PartisanshipMode = "force_true" | "force_false" | "ask_ai";

const SCHOOL_DISTRICT_TYPES = new Set([
  "school_elementary",
  "school_secondary",
  "school_unified",
]);

const SCHOOL_PARTISAN_STATES = new Set(["AL", "CT", "IN", "LA", "PA"]);
const SCHOOL_MIXED_STATES = new Set(["GA", "NC", "RI", "SC", "TN"]);
// `is_partisan` is BALLOT-FACING: it records whether the party appears next to
// the candidate's name on the general-election ballot, not how the candidate
// was nominated. A partisan primary feeding a nonpartisan general is the single
// most common way a state-level summary (Ballotpedia/NCSC) misleads here, so
// every entry below is stated per court level and sourced to the ballot statute
// rather than to the selection-method summary.
//
// `partisan`/`nonpartisan` force the value and make the contract reject the
// other one. `ask` forces nothing: the researcher's or the model's value stands.
// `ask` is the honest answer where the ballot format varies by COUNTY rather
// than by title — this classifier only sees the state and the title, so a
// county-varying state must not be forced either way.
type JudicialBallotMode = "partisan" | "nonpartisan" | "ask";

type JudicialTitleRule = {
  pattern: RegExp;
  mode: JudicialBallotMode;
};

type StateJudicialBallotPolicy = {
  // Applies to any judicial title the rules below do not match.
  fallback: JudicialBallotMode;
  // First match wins, so order these most-specific first.
  titleRules?: readonly JudicialTitleRule[];
};

// Ohio prints the party for the two appellate courts ONLY. H.B. 149 / S.B. 80
// (134th G.A., enacted 2021) added judicial party designation to the office-type
// ballot: ORC 3505.03 lists chief justice, justice of the supreme court, and
// judge of the court of appeals among the offices whose candidates get "the
// name of the political party by which the candidate was nominated" printed
// under the name. ORC 3505.04 leaves "judges of a municipal court, county
// court, or court of common pleas" on the NONPARTISAN ballot, where "[n]o name
// or designation of any political party ... shall be printed under or after any
// nonpartisan candidate's name" — those judges are nominated at a party primary
// and still appear in November with no party. Forcing every Ohio judicial
// contest partisan rejected the legally correct common-pleas rows on rewrite
// (live 2026-08-08: near-identical common pleas titles stored as both t and f).
//
// Ohio is therefore expressed as nonpartisan-with-two-partisan-titles rather
// than the other way round. Enumerating the lower courts cannot be made safe:
// the probate and juvenile courts ARE divisions of the court of common pleas
// (ORC 2101.01 defines "probate court" as "the probate division of the court of
// common pleas" and its judge as "the judge of the court of common pleas who is
// judge of the probate division"), so a board that titles the contest "PROBATE
// COURT JUDGE, JUVENILE DIVISION" names no lower court a pattern could key on
// and would fall through to partisan. Naming the two courts that DO print a
// party is closed: ORC 3505.03 lists exactly the supreme court and the courts
// of appeals, and every other elected Ohio judge sits below them.
const OHIO_PARTISAN_JUDICIAL_TITLE = /\b(?:supreme court|court of appeals?)\b/i;

// Indiana runs partisan trial-court elections in most counties, but Vanderburgh
// puts its circuit and superior judges on the ballot "without party
// designation" by statute (Ind. Code 33-33-82-31), and Allen County's superior
// judges are nonpartisan as well (its circuit judge stays partisan). Lake,
// St. Joseph, and Marion counties use merit selection, so their judges reach
// the ballot as retention questions and never get here.
const INDIANA_NONPARTISAN_JUDICIAL_TITLE =
  /\bvanderburgh\b|\ballen\s+(?:county\s+)?superior\s+court\b|\bsuperior\s+court\b[^.]{0,24}\ballen\s+county\b/i;

// The county exceptions above are county-WIDE patterns, and a city or town
// court sits inside a county without being one of its courts. Indiana city and
// town court judges are elected at the municipal election under IC 33-35-1-1
// (via IC 3-10-6 / IC 3-10-7) with a party label, in every county — so a
// Vanderburgh or Allen County municipal bench must NOT inherit the county's
// nonpartisan rule. This rule is ordered ahead of that one to stop it.
//
// The alternative fix — narrowing the county patterns to name "circuit" and
// "superior" — reintroduces exactly the failure the Ohio comment above
// describes: a Vanderburgh title that names no court level ("VANDERBURGH
// COUNTY JUDGE") would match nothing and fall through to the partisan
// fallback, which is the wrong answer for the courts the statute covers.
// Matching the county broadly and carving out the municipal bench keeps both
// ends right. Redundant against the `partisan` fallback by design: its job is
// to win the first-match race, so do not "simplify" it away.
const INDIANA_PARTISAN_MUNICIPAL_COURT_TITLE = /\b(?:city|town)\s+court\b/i;

const STATE_JUDICIAL_BALLOT_POLICY = new Map<string, StateJudicialBallotPolicy>([
  // Every court but the municipal bench (appointed) is elected with a party
  // label; Alabama runs no judicial retention elections at all.
  ["AL", { fallback: "partisan" }],
  // Nonpartisan bench with one partisan precinct office: the Justice of the
  // Peace is printed in section one of the general ballot with the party in
  // bold-faced letters (A.R.S. § 16-502(C)(5)). Every other elected Arizona
  // judge is printed "without partisan or other designation" — Superior Court
  // judges in the counties that elect rather than retain them are nonpartisan
  // on the general ballot by constitutional command (Ariz. Const. art. 6
  // § 12(A)) and sit in section two with the appellate courts (A.R.S.
  // § 16-502(J)), whatever party nominated them in the primary.
  ["AZ", {
    fallback: "nonpartisan",
    titleRules: [{ pattern: /\bjustice of the peace\b/i, mode: "partisan" }],
  }],
  // Partisan initial election at every level; later terms are nonpartisan
  // retention questions, which the retention rule catches before this map.
  ["IL", { fallback: "partisan" }],
  ["IN", {
    fallback: "partisan",
    titleRules: [
      { pattern: INDIANA_PARTISAN_MUNICIPAL_COURT_TITLE, mode: "partisan" },
      { pattern: INDIANA_NONPARTISAN_JUDICIAL_TITLE, mode: "nonpartisan" },
    ],
  }],
  // 14 judicial districts elect district judges on the party ballot; the other
  // 17, plus the appellate courts, use merit selection and reach voters as
  // retention questions.
  ["KS", { fallback: "partisan" }],
  ["LA", { fallback: "partisan" }],
  // Maryland prints a party for exactly one bench: the Orphans' Court, whose
  // judges are nominated in party primaries and printed with the party on the
  // general ballot (Md. Const. art. IV § 40; live 2026 general ballots for
  // Baltimore City, Carroll, Charles and Frederick counties all print
  // "Democratic"/"Republican" under each Orphans' Court name). Circuit court
  // judges also run in the primaries, but the general ballot lists them
  // without any party (same Frederick County ballot: "Judge of the Circuit
  // Court, Circuit 6" with bare names), and the appellate bench stands for
  // retention. Without this entry the unmapped-state default forced all 14
  // upcoming Orphans' Court contests nonpartisan (live 2026-09-16) and the
  // contract rejected the researched true.
  ["MD", {
    fallback: "nonpartisan",
    titleRules: [{ pattern: /\borphans[’']?\s+court\b/i, mode: "partisan" }],
  }],
  // Partisan election in most circuits; the supreme court, court of appeals,
  // and the six Nonpartisan Court Plan circuits appear as retention questions.
  ["MO", { fallback: "partisan" }],
  ["NM", { fallback: "partisan" }],
  // Supreme court, county, surrogate, family, city, district, and town/village
  // justices are all elected on the party ballot; the Court of Appeals is
  // appointed and never appears.
  ["NY", { fallback: "partisan" }],
  // Partisan at every level again since the 2017-2018 statutes.
  ["NC", { fallback: "partisan" }],
  // Partisan initial election, then retention; magisterial district judges are
  // always partisan.
  ["PA", { fallback: "partisan" }],
  // The legislature elects the appellate and circuit bench, so the only South
  // Carolina judges who reach a ballot are the county probate judges, elected
  // with a party label.
  ["SC", { fallback: "partisan" }],
  // Tennessee forces nothing. Its appellate bench stands for retention (caught
  // by the retention rule before this map) and every trial level is decided by
  // the COUNTY, not by the title: circuit, chancery, and criminal judges are
  // partisan unless the county opts to run them nonpartisan, general sessions
  // judges are summarized statewide as nonpartisan but several counties do
  // print the party, and municipal judges follow each city's own ordinance.
  // Live 2026-08-06 August ballots show the split inside one title: Knox,
  // Davidson, Hamilton, and Montgomery general sessions contests carry a party
  // while Shelby's do not. A classifier that sees only the state and the title
  // cannot decide this, so the researched ballot-facing value stands.
  ["TN", { fallback: "ask" }],
  ["OH", {
    fallback: "nonpartisan",
    titleRules: [{ pattern: OHIO_PARTISAN_JUDICIAL_TITLE, mode: "partisan" }],
  }],
  ["TX", { fallback: "partisan" }],
]);

// States absent from the map print no party for any judicial contest.
function getJudicialBallotMode(input: {
  state: string;
  officialBallotTitle: string;
}): JudicialBallotMode {
  const policy = STATE_JUDICIAL_BALLOT_POLICY.get(normalizeState(input.state));
  if (!policy) {
    return "nonpartisan";
  }
  for (const rule of policy.titleRules ?? []) {
    if (rule.pattern.test(input.officialBallotTitle)) {
      return rule.mode;
    }
  }
  return policy.fallback;
}

function getJudicialPartisanshipMode(input: {
  state: string;
  officialBallotTitle: string;
}): PartisanshipMode {
  const mode = getJudicialBallotMode(input);
  if (mode === "partisan") {
    return "force_true";
  }
  if (mode === "nonpartisan") {
    return "force_false";
  }
  return "ask_ai";
}

function isWashingtonStateLegislativeContest(input: {
  districtType: string;
  state: string;
}): boolean {
  return normalizeState(input.state) === "WA" &&
    (input.districtType === "state_upper" || input.districtType === "state_lower");
}

function normalizeState(value: string): string {
  return value.trim().toUpperCase();
}

function isSchoolDistrictType(districtType: string): boolean {
  return SCHOOL_DISTRICT_TYPES.has(districtType);
}

function getSchoolPartisanshipMode(state: string): SchoolPartisanshipMode {
  const normalized = normalizeState(state);
  if (SCHOOL_PARTISAN_STATES.has(normalized)) {
    return "partisan";
  }
  if (SCHOOL_MIXED_STATES.has(normalized)) {
    return "mixed";
  }
  return "nonpartisan";
}

// A court clerk keeps the case files; they do not judge. The office catalog
// resolves "Clerk of Superior Court" and friends to the non-judicial county
// office "Clerk of Court", but the bare "superior court" token below swallowed
// them and handed the whole office to judicial policy (live 2026-08-08: Yuma
// County's partisan Clerk of Superior Court contest was rejected as a judge).
//
// The clerk is one case of a family: offices that administer or prosecute
// before a court name that court in their own title without being judgeships.
// Each one below was forced to the wrong answer by a judicial rule that has no
// business classifying it — "Constable, Justice Prec. 2" (Yuma County's
// constables are section-one partisan offices like the JP, and are stored that
// way, but the bare "justice" token routed them to Arizona's nonpartisan
// judicial fallback), "State Attorney, 4th Judicial Circuit" (Florida is not in
// the map above, so the unmapped-state default forced its partisan prosecutor
// nonpartisan), "Elkhart County Circuit Court Clerk", "Prosecuting Attorney of
// Elkhart County, 34th Judicial Circuit". Their partisanship follows the
// state's rule for ordinary county offices. Mirrors the office matcher's own
// non-judicial markers, which already carve constables out of the judge
// fallback for the same reason.
//
// Three more of the same shape. Virginia and Kentucky call the prosecutor a
// "Commonwealth's Attorney", the public defender is the other courtroom lawyer
// titled by the circuit (Florida elects one per circuit: "Public Defender, 20th
// Judicial Circuit"), and "City Attorney" completes the attorney set. Live
// 2026-08-08: Paulding County, Georgia hard-failed the payload contract on
// "District Attorney - Paulding Judicial Circuit", because O.C.G.A. 15-6-1
// names all 50+ Georgia circuits "<X> Judicial Circuit" while Georgia's bench
// is nonpartisan — its DAs are nominated in party primaries and printed with a
// party ("... - Rep" in the county's May 19 2026 certified results).
const NON_JUDICIAL_OFFICE_TITLE_MARKERS =
  /\b(clerks?|prosecut(?:or|ing attorney)|district attorney|state'?s? attorney|commonwealth'?s? attorney|county attorney|city attorney|attorney general|solicitor|public defenders?|constables?|sheriff|marshal|recorder|coroner)\b/i;

// Exported because the contest FAMILY must not outrank it: a pass labelled
// judicial_office can still carry one of these offices, and the office is the
// thing partisanship policy is about.
export function isNonJudicialOfficeTitle(title: string): boolean {
  return NON_JUDICIAL_OFFICE_TITLE_MARKERS.test(title);
}

// County EXECUTIVE and county LEGISLATIVE offices whose TITLE happens to contain
// a word the judicial regex keys on. Unlike the markers above these cannot be
// matched state-blind: "Magistrate" IS a judge in South Carolina and Georgia,
// and a bare "County Judge" IS a judge in Florida. So each entry names the
// state whose law makes the office non-judicial — the same three states whose
// bare executive titles migration 145 aliases to the County Executive office:
//
// - AR: the county judge is the county's chief executive officer (Ark. Const.
//   amend. 55 s 3), presiding over the quorum court and running county
//   government; Arkansas's trial bench is "Circuit Judge" / "District Judge".
// - KY: the county judge/executive is the county's chief executive (KRS 67.710)
//   and magistrates are the elected members of the fiscal court, the county's
//   legislative body (KRS 67.040). Kentucky's bench is titled "Circuit Judge",
//   "District Judge", "Family Court Judge" and the appellate courts, none of
//   which these patterns touch.
// - TX: the county judge presides over the commissioners court, the county's
//   governing body (Tex. Const. art. V s 15-16, Local Gov't Code ch. 81); the
//   judicial workload sits with the county courts at law and district courts,
//   whose titles name the court and are kept judicial by the veto below.
//
// Live 2026-08-19: without this, all six Laurel County KY magistrate/judge-
// executive shells plus Crawford County AR's county judge resolved through the
// judicial branch to their state's NONPARTISAN judicial ballot rule, and the
// contract then rejected the correct is_partisan=true — Kentucky and Arkansas
// county offices are partisan and print a party on the general ballot. Texas
// stored the right party by coincidence (its bench is partisan too) but its
// county judge still routed as a judicial contest, against the catalog.
//
// Arkansas's justice of the peace is the second entry of the same kind: since
// Amendment 55 the JPs are the elected members of the county quorum court, the
// county's legislative body, and are printed with a party like every other
// Arkansas county office. Everywhere else a JP is a judge (Arizona's is a
// partisan judicial office, Texas's a precinct court), so the carve-out stays
// state-scoped. Live 2026-09-11: 352 Arkansas JP rows stored is_partisan=false
// because the unmapped-state judicial default rejected the researched true.
const STATE_NON_JUDICIAL_TITLE_OVERRIDES: ReadonlyMap<string, RegExp> = new Map([
  ["AR", /\bcounty\s+judge\b|\bjustice\s+of\s+the\s+peace\b/i],
  // Clerks print the statutory "judge/executive" three ways: slash, hyphen, and
  // plain space ("County Judge Executive"). The separator is optional so all
  // three land here instead of falling through to the judicial regex on "judge".
  // Kentucky's magistrates are its justices of the peace (KRS 67.040), and
  // some counties print the older title.
  ["KY", /\bjudge\s*[/-]?\s*executive\b|\bmagistrate\b|\bjustice\s+of\s+the\s+peace\b/i],
  ["TX", /\bcounty\s+judge\b/i],
]);

// A title that goes on to NAME a court is a judgeship no matter which state
// word precedes it. Texas boards prefix the county onto real judgeships —
// "Erath County Judge, County Court at Law" and "San Patricio County Judge,
// 156th Judicial District" are both live in the corpus — and the bare-title
// override above must not swallow them. Applied to every override so a future
// entry cannot reintroduce the trap.
const TITLE_NAMES_A_COURT = /\bcourt\b|\bjudicial\s+(?:district|circuit)\b/i;

export function isStateNonJudicialOfficeTitle(state: string | undefined, title: string): boolean {
  if (!state) {
    return false;
  }
  const pattern = STATE_NON_JUDICIAL_TITLE_OVERRIDES.get(state.trim().toUpperCase());
  if (!pattern || !pattern.test(title)) {
    return false;
  }
  return !TITLE_NAMES_A_COURT.test(title);
}

// `state` is optional so the discovery-side caller that only has a title keeps
// working; the partisanship policy always passes it, because that is where a
// wrong answer becomes a stored is_partisan value.
export function isJudicialOfficeTitle(title: string, state?: string): boolean {
  if (isNonJudicialOfficeTitle(title)) {
    return false;
  }
  if (isStateNonJudicialOfficeTitle(state, title)) {
    return false;
  }
  return /\b(judge|justice|judicial|superior court|court of appeal(s)?|supreme court|retention|magistrate)\b/i.test(
    title
  );
}

/** Copy of packages/api-client/src/retention.ts isJudicialRetentionTitle — keep identical. */
export function isJudicialRetentionTitle(title: string): boolean {
  // California's retention question is prescribed wording used only for
  // judges ("Shall [Associate Justice] X be elected to the office for the
  // term provided by law?"), and the ballot sometimes omits the office
  // word ("Shall DAVID B. SAPP be elected to the office ..."), so the
  // phrase alone is enough.
  if (/\bbe elected to the office for the term provided by law\b/i.test(title)) {
    return true;
  }
  // Otherwise both halves are required: the retention verb alone would also
  // catch a non-judicial office such as "Water Retention District Director".
  return /\b(retention|retain(?:ed|ing)?)\b/i.test(title) && /\b(judge|justice|court|judicial|magistrate)\b/i.test(title);
}

function isJudicialContest(
  contestFamily: ContestFamily,
  raceType: ElectionRaceType,
  officialBallotTitle: string,
  state?: string
): boolean {
  if (raceType !== "office") {
    return false;
  }
  // Ordered ahead of the family shortcut on purpose. The family is a coarse
  // routing label chosen before the titles come back, so a research pass sent
  // out as judicial_office can return the circuit's prosecutor alongside its
  // judges — and the title is the office, while the family is only where the
  // question was asked. Without this, a Georgia DA that slipped into the
  // judicial pass would be stamped nonpartisan with no contract error to catch
  // it, because the contract checks the title alone.
  if (isNonJudicialOfficeTitle(officialBallotTitle)) {
    return false;
  }
  // Ordered ahead of the family shortcut for the same reason as the line above:
  // a Kentucky county's non-judicial magistrate race can be returned by a pass
  // labelled judicial_office, and the office is what partisanship is about.
  if (isStateNonJudicialOfficeTitle(state, officialBallotTitle)) {
    return false;
  }
  if (contestFamily === "judicial_office") {
    return true;
  }
  return isJudicialOfficeTitle(officialBallotTitle, state);
}

function getPartisanshipModeForContest(args: {
  draft: ElectionDraftPayload;
  contestFamily: ContestFamily;
  raceType: ElectionRaceType;
  officialBallotTitle: string;
}): PartisanshipMode {
  if (args.raceType === "ballot_measure" || args.contestFamily === "ballot_measure") {
    return "force_false";
  }

  if (args.contestFamily === "us_senate") {
    return "force_true";
  }

  // Washington's Top Two primary does not make legislative offices
  // nonpartisan: candidates state a party preference on the ballot.
  if (isWashingtonStateLegislativeContest({
    districtType: args.draft.district_type,
    state: args.draft.state,
  })) {
    return "force_true";
  }

  if (isSchoolDistrictType(args.draft.district_type)) {
    const schoolMode = getSchoolPartisanshipMode(args.draft.state);
    if (schoolMode === "partisan") {
      return "force_true";
    }
    if (schoolMode === "mixed") {
      return "ask_ai";
    }
    return "force_false";
  }

  if (isJudicialContest(args.contestFamily, args.raceType, args.officialBallotTitle, args.draft.state)) {
    if (isJudicialRetentionTitle(args.officialBallotTitle)) {
      return "force_false";
    }
    return getJudicialPartisanshipMode({
      state: args.draft.state,
      officialBallotTitle: args.officialBallotTitle,
    });
  }

  return "ask_ai";
}

function getPartisanshipModeForOfficeScope(input: {
  districtType: string;
  state: string;
  officialBallotTitle: string;
}): PartisanshipMode {
  if (isWashingtonStateLegislativeContest(input)) {
    return "force_true";
  }

  if (isSchoolDistrictType(input.districtType)) {
    const schoolMode = getSchoolPartisanshipMode(input.state);
    if (schoolMode === "partisan") {
      return "force_true";
    }
    if (schoolMode === "mixed") {
      return "ask_ai";
    }
    return "force_false";
  }

  if (isJudicialOfficeTitle(input.officialBallotTitle, input.state)) {
    if (isJudicialRetentionTitle(input.officialBallotTitle)) {
      return "force_false";
    }
    return getJudicialPartisanshipMode(input);
  }

  return "ask_ai";
}

export function resolveCandidateContestPartisanshipByPolicy(input: {
  districtType: string;
  state: string;
  officialBallotTitle: string;
}): boolean | undefined {
  const mode = getPartisanshipModeForOfficeScope(input);
  if (mode === "force_true") {
    return true;
  }
  if (mode === "force_false") {
    return false;
  }
  return undefined;
}

export function shouldIncludeCandidatePartyByPolicy(input: {
  districtType: string;
  state: string;
  officialBallotTitle: string;
}): boolean {
  const mode = getPartisanshipModeForOfficeScope(input);
  return mode !== "force_false";
}

export function shouldAskIsPartisanInPrompt(args: {
  draft: ElectionDraftPayload;
  contestFamily: ContestFamily;
}): boolean {
  const raceType: ElectionRaceType =
    args.contestFamily === "ballot_measure" ? "ballot_measure" : "office";
  const mode = getPartisanshipModeForContest({
    draft: args.draft,
    contestFamily: args.contestFamily,
    raceType,
    officialBallotTitle: "",
  });
  return mode === "ask_ai";
}

export function resolveElectionIsPartisan(args: {
  draft: ElectionDraftPayload;
  contestFamily: ContestFamily;
  raceType: ElectionRaceType;
  officialBallotTitle: string;
  aiValue: boolean | undefined;
}): boolean | undefined {
  const mode = getPartisanshipModeForContest({
    draft: args.draft,
    contestFamily: args.contestFamily,
    raceType: args.raceType,
    officialBallotTitle: args.officialBallotTitle,
  });

  if (mode === "force_true") {
    return true;
  }
  if (mode === "force_false") {
    return false;
  }
  if (typeof args.aiValue === "boolean") {
    return args.aiValue;
  }
  return undefined;
}
