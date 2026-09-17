import type { ElectionRaceType } from "../../types/election.js";
import type { HistoricalContestCompetitivenessLabel } from "../competitiveness/competitivenessLabels.js";
import { binMeanIntensity } from "../competitiveness/currentRaceRatingConsensus.js";
import { isJudicialRetentionTitle } from "../../ai/electionPartisanshipPolicy.js";

// Fixed ruler for the state-anchored representation model: a district this
// many times smaller than its state scores 100. Data-derived 2026-08-24
// (docs/plans/vote-power-state-anchored-representation.md): the valid band is
// ~3,600 (median US House district must stay below "high") to ~105,000
// (median state senate district must reach "high"). A constant — not the
// smallest district in the DB — so scores never drift when new districts are
// imported.
export const REPRESENTATION_RULER_K = 50000;

// Six graded tiers plus unknown. "medium" is the statewide baseline (shown as
// "Average"); "above_average" sits between it and "high" so a county, city, or
// US House vote — a few times the weight of a statewide one — is not lumped in
// with the statewide baseline itself. "retention" is not a grade: a judicial
// retention race (Yes/No on keeping one judge) gets no rating at all — the
// one-candidate rule would call it uncontested, which it is not, and there
// is no decisiveness source for it — so the label names the race kind
// instead, and the score is null.
export type VotePowerLabel =
  | "very_low"
  | "low"
  | "medium"
  | "above_average"
  | "high"
  | "very_high"
  | "unknown"
  | "retention";

// The labels the level matrix can produce (everything but the two
// non-grades).
type GradedVotePowerLabel = Exclude<VotePowerLabel, "unknown" | "retention">;

export type VotePowerConfidence = "high" | "medium" | "low";

export type VotePowerRepresentationLevel = "low" | "medium" | "above_average" | "high" | "unknown";

export type VotePowerDecisivenessLevel = "none" | "low" | "medium" | "high" | "unknown";

export type VotePowerFactor =
  | "high_representation"
  | "above_average_representation"
  | "medium_representation"
  | "low_representation"
  | "high_decisiveness"
  | "medium_decisiveness"
  | "low_decisiveness"
  | "uncontested_race"
  | "direct_vote_on_policy"
  | "missing_representation_data"
  | "missing_decisiveness_data";

export type VotePowerInput = {
  raceType: ElectionRaceType;
  candidateCount: number;
  // Only read to recognise a judicial retention race (see VotePowerLabel);
  // optional so the many direct unit-test calls need not carry a title.
  officialBallotTitle?: string | null;
  representationPowerScore: number | null | undefined;
  competitivenessLabel: HistoricalContestCompetitivenessLabel | null | undefined;
};

export type VotePowerResult = {
  // User-facing label is authoritative. Score is a continuous sorting signal;
  // clients should not re-bucket it into their own display labels.
  score: number | null;
  label: VotePowerLabel;
  confidence: VotePowerConfidence;
  representation_level: VotePowerRepresentationLevel;
  decisiveness_level: VotePowerDecisivenessLevel;
  factors: VotePowerFactor[];
};

// Detail-page-only companion to VotePowerResult: ready-to-render copy so
// clients never re-derive rating language. Kept off the ballot list payload
// (dozens of elections per response) — only the election detail lookup
// attaches it.
//
// parts render as a compact formula: one row per graded measure with this
// election's actual numbers (score, population, past margin), then `result`
// states how the grades combine into the displayed rating.
export type VotePowerExplanationPart = {
  title: string;
  grade: string;
  stat: string | null;
  detail: string;
  // The exact scoring formula with this election's real numbers plugged in,
  // plus the grade cutoffs. null when the measure has no numeric input
  // (unknown data, uncontested, the ballot-measure step).
  formula: string | null;
};

export type VotePowerExplanation = {
  how: string;
  parts: VotePowerExplanationPart[];
  result: string;
  caveat: string | null;
};

// The current-cycle rating that drove the decisiveness label, when one did.
// outlet keys are the storage enum ("inside_elections", "sabato"); display
// names are this module's concern so copy stays consistent across callers.
export type VotePowerCurrentRating = {
  asOf: string;
  method: "outlet_consensus" | "mayoral_rubric";
  confidence: "high" | "medium";
  outlets: { outlet: string; rawRating: string; intensity: number }[];
};

// Extra context that qualifies the explanation copy only — the rating math
// in calculateVotePower deliberately ignores all of it, so it lives outside
// VotePowerInput rather than implying the rating reads it.
export type VotePowerExplanationContext = VotePowerInput & {
  // Present when competitivenessLabel came from a current race rating rather
  // than historic margins. The margin fields below stay null/absent then —
  // the explanation must not mix the two sources.
  currentRating?: VotePowerCurrentRating | null;
  staleAfterRedistricting?: boolean;
  districtPopulation?: number | null;
  marginPercent?: number | null;
  // Every contest year behind marginPercent: one entry for a plain margin,
  // several when it is a weighted multi-year blend (the stat must not pin a
  // blended number on a single year).
  marginElectionYears?: number[] | null;
  // The district's own state population (the anchor of the loader's
  // representation-score SQL) plus a human name for the baseline, so the
  // formula can show the real numbers.
  representationScope?: {
    statePopulation: number;
    description: string;
  } | null;
  // Per-contest inputs behind a weighted multi-year margin, so the formula
  // can show the actual blend arithmetic.
  marginContests?: { marginPercent: number; electionYear: number; weight: number }[] | null;
};

const LABELS: readonly GradedVotePowerLabel[] = [
  "very_low",
  "low",
  "medium",
  "above_average",
  "high",
  "very_high",
];

const DECISIVENESS_SCORE_BY_LABEL: Record<HistoricalContestCompetitivenessLabel, number> = {
  toss_up: 1,
  very_competitive: 0.85,
  competitive: 0.65,
  somewhat_competitive: 0.45,
  safe: 0.2,
};

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeRepresentationPowerScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

export function representationLevelFromScore(value: number | null | undefined): VotePowerRepresentationLevel {
  const score = normalizeRepresentationPowerScore(value);
  if (score === null) {
    return "unknown";
  }
  if (score >= 66) {
    return "high";
  }
  // 55 ≈ a district one third of its state or smaller (ln(3) / ln(50,000) ×
  // 50 ≈ 5): a county that covers most of its state stays at the statewide
  // baseline instead of flipping on a fraction of a point.
  if (score >= 55) {
    return "above_average";
  }
  if (score >= 33) {
    return "medium";
  }
  return "low";
}

export function decisivenessLevelFromContest(input: {
  raceType: ElectionRaceType;
  candidateCount: number;
  competitivenessLabel: HistoricalContestCompetitivenessLabel | null | undefined;
}): VotePowerDecisivenessLevel {
  // Only exactly one known candidate is uncontested; zero can mean the roster has not loaded yet.
  if (input.raceType === "office" && input.candidateCount === 1) {
    return "none";
  }

  switch (input.competitivenessLabel) {
    case "toss_up":
    case "very_competitive":
      return "high";
    case "competitive":
    case "somewhat_competitive":
      return "medium";
    case "safe":
      return "low";
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function matrixLabel(
  representationLevel: Exclude<VotePowerRepresentationLevel, "unknown">,
  decisivenessLevel: Exclude<VotePowerDecisivenessLevel, "unknown">
): GradedVotePowerLabel {
  if (representationLevel === "high") {
    switch (decisivenessLevel) {
      case "none":
        return "low";
      case "low":
        return "medium";
      case "medium":
        return "high";
      case "high":
        return "very_high";
    }
  }

  if (representationLevel === "above_average") {
    switch (decisivenessLevel) {
      case "none":
        return "low";
      case "low":
        return "medium";
      case "medium":
        return "above_average";
      case "high":
        return "high";
    }
  }

  if (representationLevel === "medium") {
    switch (decisivenessLevel) {
      case "none":
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
    }
  }

  switch (decisivenessLevel) {
    case "none":
      return "very_low";
    case "low":
    case "medium":
      return "low";
    case "high":
      return "medium";
  }
}

function labelFromKnownAxis(input: {
  representationLevel: VotePowerRepresentationLevel;
  decisivenessLevel: VotePowerDecisivenessLevel;
}): VotePowerLabel {
  if (input.representationLevel !== "unknown" && input.decisivenessLevel !== "unknown") {
    return matrixLabel(input.representationLevel, input.decisivenessLevel);
  }

  if (input.representationLevel !== "unknown") {
    return input.representationLevel;
  }

  if (input.decisivenessLevel !== "unknown") {
    return input.decisivenessLevel === "none" ? "low" : input.decisivenessLevel;
  }

  return "unknown";
}

function capLabel(label: VotePowerLabel, maxLabel: GradedVotePowerLabel): VotePowerLabel {
  if (label === "unknown" || label === "retention") {
    return label;
  }
  const labelIndex = LABELS.indexOf(label);
  const maxIndex = LABELS.indexOf(maxLabel);
  return LABELS[Math.min(labelIndex, maxIndex)] ?? label;
}

function bumpLabel(label: VotePowerLabel): VotePowerLabel {
  if (label === "unknown" || label === "retention") {
    return label;
  }
  return LABELS[Math.min(LABELS.indexOf(label) + 1, LABELS.length - 1)] ?? label;
}

function calculateScore(input: {
  representationPowerScore: number | null;
  representationLevel: VotePowerRepresentationLevel;
  decisivenessLevel: VotePowerDecisivenessLevel;
  competitivenessLabel: HistoricalContestCompetitivenessLabel | null | undefined;
  hasMissingCoreAxis: boolean;
}): number | null {
  const representationPowerScore = input.representationPowerScore;
  const decisivenessLevel = input.decisivenessLevel;
  const hasRepresentation = input.representationLevel !== "unknown" && representationPowerScore !== null;
  const hasDecisiveness = decisivenessLevel !== "unknown";

  if (!hasRepresentation && !hasDecisiveness) {
    return null;
  }

  let raw: number;
  if (representationPowerScore !== null && input.representationLevel !== "unknown" && decisivenessLevel !== "unknown") {
    const representationNorm = representationPowerScore / 100;
    const decisivenessNorm =
      decisivenessLevel === "none" ? 0 : DECISIVENESS_SCORE_BY_LABEL[input.competitivenessLabel!];
    raw = 100 * (0.45 * representationNorm + 0.55 * decisivenessNorm);
  } else if (representationPowerScore !== null && input.representationLevel !== "unknown") {
    raw = representationPowerScore;
  } else if (decisivenessLevel !== "unknown") {
    raw = decisivenessLevel === "none" ? 0 : 100 * DECISIVENESS_SCORE_BY_LABEL[input.competitivenessLabel!];
  } else {
    return null;
  }

  if (decisivenessLevel === "none") {
    raw = Math.min(raw, 25);
  }
  if (input.hasMissingCoreAxis) {
    raw = Math.min(raw, 79);
  }

  return clampScore(raw);
}

function confidenceFor(input: {
  representationLevel: VotePowerRepresentationLevel;
  decisivenessLevel: VotePowerDecisivenessLevel;
  hasMissingCoreAxis: boolean;
}): VotePowerConfidence {
  if (!input.hasMissingCoreAxis) {
    return "high";
  }
  if (input.representationLevel !== "unknown" || input.decisivenessLevel !== "unknown") {
    return "medium";
  }
  return "low";
}

function factorsFor(input: {
  raceType: ElectionRaceType;
  representationLevel: VotePowerRepresentationLevel;
  decisivenessLevel: VotePowerDecisivenessLevel;
  omitMissingDecisiveness: boolean;
}): VotePowerFactor[] {
  const factors: VotePowerFactor[] = [];

  switch (input.representationLevel) {
    case "high":
      factors.push("high_representation");
      break;
    case "above_average":
      factors.push("above_average_representation");
      break;
    case "medium":
      factors.push("medium_representation");
      break;
    case "low":
      factors.push("low_representation");
      break;
    case "unknown":
      factors.push("missing_representation_data");
      break;
  }

  switch (input.decisivenessLevel) {
    case "none":
      factors.push("uncontested_race");
      break;
    case "high":
      factors.push("high_decisiveness");
      break;
    case "medium":
      factors.push("medium_decisiveness");
      break;
    case "low":
      factors.push("low_decisiveness");
      break;
    case "unknown":
      if (!input.omitMissingDecisiveness) {
        factors.push("missing_decisiveness_data");
      }
      break;
  }

  if (input.raceType === "ballot_measure") {
    factors.push("direct_vote_on_policy");
  }

  return factors;
}

// Describes the LABEL algorithm (the level matrix), not the numeric score:
// the 45/55 weighted score is a sorting signal only and never shown on the
// detail page, so surfacing its formula here would misattribute the rating.
// The lead deliberately doesn't count the parts: measures without history
// skip the decisiveness row, so any "two things" claim would contradict
// some panels. The decisiveness tail names both sources it can rest on
// (analyst ratings when one exists, past results otherwise); the part row
// says which one applied here.
//
// Ballot measures get their own copy: they have no candidates or analyst
// ratings, so the decisiveness paragraph would describe an axis the panel
// never shows; the direct-vote step takes its place. A measure can only
// carry a decisiveness grade through a direct unit-test call — in the lookup,
// historic margins key on the office's canonical name (measures have none)
// and current ratings load for office rows only — so this copy does not
// model that path.
function howCalculated(raceType: ElectionRaceType): string {
  // Blank lines between the lead and the two axes: clients render this with
  // newlines preserved (whitespace-pre-line on web), so each point reads as
  // its own short paragraph instead of one dense block.
  const representation =
    "Representation: how much weight one vote carries here compared with a statewide vote — the smaller the district, the more each vote counts.";
  if (raceType === "ballot_measure") {
    return `What determines the vote power rating for ballot measures:\n\n${representation}\n\nYou have more power in ballot measures because you vote directly on the policy.`;
  }
  return `What determines the vote power rating:\n\n${representation}\n\nDecisiveness: how likely this race is to be close, based on past results or current analyst ratings, plus the number of candidates.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Display word for an axis level or rating: "medium" ships as "average" (the
// statewide baseline; see the api-client's formatVotePowerLabel) and
// "above_average" as "above average". Internal level keys stay as-is.
function levelDisplayWord(level: string): string {
  if (level === "medium") {
    return "average";
  }
  return level.replace(/_/g, " ");
}

// 12 -> "12", 3.25 -> "3.25", 2.04 -> "2.04": two decimals at most — the
// SAME precision classifyHistoricalContestMargin grades on. Coarser display
// rounding would let a 2.04 margin render as "2" beside a "very competitive"
// grade whose own rule says ≤2 is a toss-up.
function formatMarginPoints(marginPercent: number): string {
  return `${Math.round(marginPercent * 100) / 100}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

// First-match thresholds, not ranges: "33–54 average" would leave a 54.6
// score in no bucket, and the grader itself works on >= comparisons.
const REPRESENTATION_GRADE_SCALE =
  "grades: 66+ high, 55+ above average, 33+ average, otherwise low; a statewide race is the 50 baseline";

// The loader's state-anchored fixed-ruler model, spelled out with this
// district's real numbers (see recomputeRepresentationPowerScores in
// districtsLoader.ts — this string must describe that SQL faithfully,
// including its 50..100 clamp and two-decimal rounding).
//
// The value after "=" is the STORED score the rating graded on, while the
// expression's inputs are the CURRENT populations from a live subselect. The
// numeric equation therefore only renders after re-evaluating the model
// here and confirming it reproduces the stored score; any drift (population
// edits since the last scoring run, a stored score from the retired
// within-type model, or SQL-numeric vs float rounding at a .005 boundary)
// degrades to the symbolic form, which shows the stored score without
// claiming the live inputs derive it.
function representationFormula(input: {
  representationPowerScore: number;
  districtPopulation: number | null;
  representationScope: { statePopulation: number; description: string } | null;
}): string {
  const score = Math.round(input.representationPowerScore * 100) / 100;
  if (input.districtPopulation !== null && input.representationScope !== null) {
    const scope = input.representationScope;
    const raw =
      50 +
      (50 * Math.log(scope.statePopulation / input.districtPopulation)) / Math.log(REPRESENTATION_RULER_K);
    const rawRounded = Math.round(raw * 100) / 100;
    const recomputed = Math.round(Math.min(100, Math.max(50, raw)) * 100) / 100;
    if (recomputed === score) {
      // When the 50..100 clamp engaged (a district more than K times smaller
      // than its state hits the 100 cap; a data-error ratio below 1 hits the
      // 50 floor), say so — otherwise the equation would print arithmetic
      // that does not produce the stored score.
      const clampSuffix =
        rawRounded === recomputed ? "" : rawRounded > 100 ? ", capped at 100" : ", raised to the 50 floor";
      return `score = 50 + 50 × ln(state population ÷ this district's) ÷ ln(${formatCount(REPRESENTATION_RULER_K)}) = 50 + 50 × ln(${formatCount(scope.statePopulation)} ÷ ${formatCount(input.districtPopulation)}) ÷ ln(${formatCount(REPRESENTATION_RULER_K)}) = ${rawRounded}${clampSuffix}, measured against ${scope.description} (${REPRESENTATION_GRADE_SCALE})`;
    }
  }
  return `score = 50 + 50 × ln(state population ÷ this district's population) ÷ ln(${formatCount(REPRESENTATION_RULER_K)}), kept between 50 and 100 and rounded to 2 decimals = ${score} (${REPRESENTATION_GRADE_SCALE})`;
}

function representationPart(input: {
  representationLevel: VotePowerRepresentationLevel;
  representationPowerScore: number | null;
  districtPopulation: number | null;
  representationScope: { statePopulation: number; description: string } | null;
}): VotePowerExplanationPart {
  if (input.representationLevel === "unknown" || input.representationPowerScore === null) {
    return {
      title: "Representation",
      grade: "Unknown",
      stat: null,
      detail: "We don't have a representation score for this district yet.",
      formula: null,
    };
  }

  // "low" is unreachable under the state-anchored model (scores floor at the
  // statewide 50 baseline) but stays renderable: stored scores from the
  // retired within-type model can still grade low until the recompute runs.
  const detailByLevel: Record<Exclude<VotePowerRepresentationLevel, "unknown">, string> = {
    high: "This district is a small slice of its state, so each vote here carries much more weight than a vote in a statewide race.",
    above_average:
      "This district is a good deal smaller than its state, so each vote here carries more weight than a vote in a statewide race.",
    medium: "This district covers a large share of its state, so each vote carries about average weight — like a vote in a statewide race.",
    low: "This district is large, so each vote is a smaller slice of the outcome.",
  };
  const populationSuffix =
    input.districtPopulation === null ? "" : ` About ${input.districtPopulation.toLocaleString("en-US")} people live here.`;

  return {
    title: "Representation",
    grade: capitalize(levelDisplayWord(input.representationLevel)),
    // Floor, not round: the grade thresholds are the integers 33, 55 and 66,
    // so flooring can never display a number that sits in a higher bucket
    // than the unrounded value (65.6 must not render as the high-threshold 66).
    stat: `${Math.floor(input.representationPowerScore)} out of 100`,
    detail: `${detailByLevel[input.representationLevel]}${populationSuffix}`,
    formula: representationFormula({
      representationPowerScore: input.representationPowerScore,
      districtPopulation: input.districtPopulation,
      representationScope: input.representationScope,
    }),
  };
}

// First-match thresholds so boundary margins read unambiguously: a 2.04
// margin is "not ≤2, so ≤5 → very competitive", never inside a "0–2" range.
const MARGIN_GRADE_SCALE =
  "margins, first match: ≤2 toss-up, ≤5 very competitive, ≤10 competitive, ≤15 somewhat competitive, otherwise not competitive; toss-up and very competitive grade high, competitive and somewhat competitive grade average, not competitive grades low";

// The margin-to-grade pipeline with this contest's real numbers (see
// classifyHistoricalContestMargin — this string must match its cutoffs).
function decisivenessFormula(input: {
  decisivenessLevel: "low" | "medium" | "high";
  competitivenessLabel: HistoricalContestCompetitivenessLabel | null | undefined;
  marginPercent: number | null;
  marginContests: { marginPercent: number; electionYear: number; weight: number }[] | null;
}): string | null {
  if (input.marginPercent === null || input.competitivenessLabel == null) {
    return null;
  }
  const labelText = input.competitivenessLabel === "toss_up" ? "toss-up" : input.competitivenessLabel.replace(/_/g, " ");
  const contests = input.marginContests ?? [];
  const marginExpression =
    contests.length > 1
      ? `margin = ${contests
          .map((contest) => `${formatWeight(contest.weight)} × ${formatMarginPoints(contest.marginPercent)} (${contest.electionYear})`)
          .join(" + ")} = ${formatMarginPoints(input.marginPercent)} points`
      : `margin = ${formatMarginPoints(input.marginPercent)} points`;
  return `${marginExpression} → "${labelText}" → grade ${levelDisplayWord(input.decisivenessLevel)} (${MARGIN_GRADE_SCALE})`;
}

// 0.6 -> "0.6", 0.625 -> "0.625": up to four decimals, because rounding a
// real 0.625/0.375 pair to 0.63/0.38 would display arithmetic whose product
// sum no longer equals the blended total on the right of the "=".
function formatWeight(weight: number): string {
  return `${Math.round(weight * 10000) / 10000}`;
}

// Short names for the formula row, full names for the prose detail. Unknown
// outlet keys (a future source) fall back to the raw key rather than lying.
const RATING_OUTLET_DISPLAY: Record<string, { short: string; full: string }> = {
  inside_elections: { short: "IE", full: "Inside Elections" },
  sabato: { short: "Sabato", full: "University of Virginia's Sabato's Crystal Ball" },
};

export function ratingOutletDisplay(outlet: string): { short: string; full: string } {
  return RATING_OUTLET_DISPLAY[outlet] ?? { short: outlet, full: outlet };
}

// as_of is a plain YYYY-MM-DD; render it in UTC so the stated date never
// shifts with the server's timezone.
export function formatRatingDate(asOf: string): string {
  const parsed = Date.parse(`${asOf}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    return asOf;
  }
  return new Date(parsed).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function competitivenessLabelText(label: HistoricalContestCompetitivenessLabel): string {
  // "safe" is analyst jargon — voters read it as "safe seat for whom?"; the
  // decisiveness prose already says "not competitive", so the label word matches.
  if (label === "safe") {
    return "not competitive";
  }
  return label === "toss_up" ? "toss-up" : label.replace(/_/g, " ");
}

// Mirrors deriveConsensusLabel's ladder and bins (currentRaceRatingConsensus)
// the way MARGIN_GRADE_SCALE mirrors classifyHistoricalContestMargin.
const RATING_GRADE_SCALE =
  "d: toss-up 0, tilt 2, lean(s) 3, likely 4, solid/safe 5; mean, first match: <1 toss-up, <2.5 very competitive, <3.5 competitive, <4.5 somewhat competitive, otherwise not competitive; toss-up and very competitive grade high, competitive and somewhat competitive grade average, not competitive grades low";

// The rating-to-grade pipeline with the real per-outlet observations. When a
// consensus guardrail (opposite favored sides, or safe requiring all-Solid)
// moved the label off the plain mean bin, the formula says so instead of
// rendering an arrow chain the arithmetic alone doesn't produce.
function currentRatingFormula(input: {
  decisivenessLevel: "low" | "medium" | "high";
  competitivenessLabel: HistoricalContestCompetitivenessLabel;
  currentRating: VotePowerCurrentRating;
}): string | null {
  const outlets = input.currentRating.outlets;
  // mayoral_rubric (v1.1) derives from margins, not an outlet mean — this
  // formula would misdescribe it, so it degrades to no formula.
  if (input.currentRating.method !== "outlet_consensus" || outlets.length === 0) {
    return null;
  }
  const mean = outlets.reduce((sum, entry) => sum + entry.intensity, 0) / outlets.length;
  const meanText = `${Math.round(mean * 100) / 100}`;
  const labelText = competitivenessLabelText(input.competitivenessLabel);
  const labelStep =
    binMeanIntensity(mean) === input.competitivenessLabel
      ? `mean ${meanText} → "${labelText}"`
      : `mean ${meanText} → "${labelText}" after consensus guardrails`;
  const terms = outlets
    .map((entry) => `${ratingOutletDisplay(entry.outlet).short} "${entry.rawRating}" (d=${entry.intensity})`)
    .join(" + ");
  return `${terms} → ${labelStep} → grade ${levelDisplayWord(input.decisivenessLevel)} (${RATING_GRADE_SCALE})`;
}

// "Inside Elections" / "Inside Elections and University of Virginia's Sabato's Crystal Ball".
function ratingSourceNames(outlets: VotePowerCurrentRating["outlets"]): string {
  const names = outlets.map((entry) => ratingOutletDisplay(entry.outlet).full);
  return names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(", ");
}

function currentRatingPart(input: {
  decisivenessLevel: "low" | "medium" | "high";
  competitivenessLabel: HistoricalContestCompetitivenessLabel;
  currentRating: VotePowerCurrentRating;
}): VotePowerExplanationPart {
  const detailByLevel: Record<"low" | "medium" | "high", string> = {
    high: "Election analysts currently rate this race very close — a small number of votes could decide the winner.",
    medium: "Election analysts currently rate this race somewhat close.",
    low: "Election analysts currently rate this race not competitive.",
  };
  const sourceSuffix =
    input.currentRating.outlets.length > 0
      ? ` Rating from ${ratingSourceNames(input.currentRating.outlets)}.`
      : "";
  return {
    title: "Decisiveness",
    grade: capitalize(levelDisplayWord(input.decisivenessLevel)),
    stat: `rated ${competitivenessLabelText(input.competitivenessLabel)} as of ${formatRatingDate(input.currentRating.asOf)}`,
    detail: `${detailByLevel[input.decisivenessLevel]}${sourceSuffix}`,
    formula: currentRatingFormula(input),
  };
}

function decisivenessPart(input: {
  decisivenessLevel: VotePowerDecisivenessLevel;
  competitivenessLabel: HistoricalContestCompetitivenessLabel | null | undefined;
  currentRating: VotePowerCurrentRating | null;
  marginPercent: number | null;
  marginElectionYears: number[] | null;
  marginContests: { marginPercent: number; electionYear: number; weight: number }[] | null;
  staleAfterRedistricting: boolean;
}): VotePowerExplanationPart {
  if (input.decisivenessLevel === "none") {
    return {
      title: "Decisiveness",
      grade: "None",
      stat: "only 1 candidate",
      detail: "One candidate is running unopposed, so votes can't change the outcome.",
      formula: null,
    };
  }
  if (input.decisivenessLevel === "unknown") {
    return {
      title: "Decisiveness",
      grade: "Unknown",
      stat: null,
      detail: "No analyst ratings or past results for this contest yet.",
      formula: null,
    };
  }

  // A graded level with a current rating in context means the rating drove
  // the label (uncontested and unknown returned above) — historic margin
  // copy would misattribute the source.
  if (input.currentRating && input.competitivenessLabel != null) {
    return currentRatingPart({
      decisivenessLevel: input.decisivenessLevel,
      competitivenessLabel: input.competitivenessLabel,
      currentRating: input.currentRating,
    });
  }

  const detailByLevel: Record<"low" | "medium" | "high", string> = {
    high: "Past results here were very close — a small number of votes could decide the winner.",
    medium: "Past results here were somewhat close.",
    low: "Past results here were not competitive.",
  };
  // Only these grades rest on historical results, so only they carry the
  // redistricting qualifier; staleness says nothing about representation,
  // uncontested races, or missing data.
  const staleSuffix = input.staleAfterRedistricting
    ? " District lines have changed since then, so older results are a weaker guide."
    : "";
  return {
    title: "Decisiveness",
    grade: capitalize(levelDisplayWord(input.decisivenessLevel)),
    stat: marginStat(input.marginPercent, input.marginElectionYears),
    detail: `${detailByLevel[input.decisivenessLevel]}${staleSuffix}`,
    formula: decisivenessFormula({
      decisivenessLevel: input.decisivenessLevel,
      competitivenessLabel: input.competitivenessLabel,
      marginPercent: input.marginPercent,
      marginContests: input.marginContests,
    }),
  };
}

// "12 and 2022" reads as a typo; spell the blend out. Years arrive in the
// lookup's order (latest first) and render as given.
function formatYearList(years: number[]): string {
  if (years.length === 1) {
    return `${years[0]}`;
  }
  if (years.length === 2) {
    return `${years[0]} and ${years[1]}`;
  }
  return `${years.slice(0, -1).join(", ")}, and ${years[years.length - 1]}`;
}

// A multi-year margin is a weighted blend; pinning it on the single latest
// year would claim a number that election never produced.
function marginStat(marginPercent: number | null, marginElectionYears: number[] | null): string | null {
  if (marginPercent === null) {
    return null;
  }
  const points = `${formatMarginPoints(marginPercent)}-point`;
  const years = marginElectionYears ?? [];
  if (years.length === 0) {
    return `${points} margin`;
  }
  if (years.length === 1) {
    return `${points} margin in ${years[0]}`;
  }
  return `${points} weighted margin across ${formatYearList(years)}`;
}

function explanationResultFor(
  result: VotePowerResult,
  options: { skipDecisiveness: boolean; isBallotMeasure: boolean }
): string {
  if (result.label === "unknown") {
    return "Not enough data → no rating yet.";
  }
  // Unreachable in practice (explainVotePower returns before building
  // parts for a retention race); kept so the label map below stays total.
  if (result.label === "retention") {
    return "Retention race";
  }

  // Unknown axes stay out of the sum: their part rows and the missing-data
  // caveat already disclose the gap, and "high representation + unknown
  // decisiveness" reads as nonsense arithmetic. Only known inputs combine.
  // (Both axes unknown means an unknown label, which returned above.)
  const pieces: string[] = [];
  if (result.representation_level !== "unknown") {
    pieces.push(`${levelDisplayWord(result.representation_level)} representation`);
  }
  if (!options.skipDecisiveness) {
    if (result.decisiveness_level === "none") {
      pieces.push("an uncontested race");
    } else if (result.decisiveness_level !== "unknown") {
      pieces.push(`${levelDisplayWord(result.decisiveness_level)} decisiveness`);
    }
  }
  // The direct-vote step is part of the rating (calculateVotePower bumps
  // every rated measure one tier), so the sum names it or the arithmetic
  // would not produce the displayed label.
  if (options.isBallotMeasure) {
    pieces.push("a direct vote on the policy");
  }
  return `${capitalize(pieces.join(" + "))} → My vote power: ${capitalize(RESULT_LABEL_TEXT[result.label])}.`;
}

// Display words for the rating in the result line. "low" reads as a verdict
// on the voter and "medium" as a size word, so they ship as "below average"
// and "average" (mirrors the api-client's formatVotePowerLabel chip copy).
const RESULT_LABEL_TEXT: Record<GradedVotePowerLabel, string> = {
  very_low: "very low",
  low: "below average",
  medium: "average",
  above_average: "above average",
  high: "high",
  very_high: "very high",
};

// The cap clause only matters when the cap could have bitten: a partial
// rating already below "High" was never held down by it, so naming the
// ceiling there just raises a question the rating never asked.
function explanationCaveatFor(result: VotePowerResult): string | null {
  switch (result.confidence) {
    case "high":
      return null;
    case "medium":
      return result.label === "high"
        ? 'Some data is missing, so this rating is based on partial information and capped at "High".'
        : "Some data is missing, so this rating is based on partial information.";
    case "low":
      return "Not enough data to rate this election yet.";
  }
}

// A medium-confidence current rating means exactly one of two things (see
// deriveConsensusLabel): a single outlet rated the race, or the outlets
// favor opposite sides. Qualifies the copy only — confidenceFor's axis
// logic never reads the rating.
function currentRatingCaveat(currentRating: VotePowerCurrentRating | null): string | null {
  if (!currentRating || currentRating.confidence !== "medium") {
    return null;
  }
  return currentRating.outlets.length > 1
    ? "Election analysts disagree on which side is favored here, so the current rating is less certain."
    : "The current race rating comes from a single analyst source, so it is less certain.";
}

// Deterministic, backend-owned explanation of a computed rating. Parts derive
// from the same levels the rating used, so the explanation can never drift
// from the rating logic that produced it.
export function explainVotePower(input: VotePowerExplanationContext, result: VotePowerResult): VotePowerExplanation {
  if (result.label === "retention") {
    // Nothing was graded, so there are no parts to show; the copy says why.
    return { how: RETENTION_EXPLANATION, parts: [], result: "Retention race", caveat: null };
  }
  const isBallotMeasure = input.raceType === "ballot_measure";
  // Measures with a known representation grade rate fine without history
  // (mirrors factorsFor's omitMissingDecisiveness): a "no past results"
  // row would read as a data gap the rating doesn't actually suffer from.
  const skipDecisiveness =
    isBallotMeasure && result.decisiveness_level === "unknown" && result.representation_level !== "unknown";

  const parts: VotePowerExplanationPart[] = [
    representationPart({
      representationLevel: result.representation_level,
      representationPowerScore: normalizeRepresentationPowerScore(input.representationPowerScore),
      districtPopulation: input.districtPopulation ?? null,
      representationScope: input.representationScope ?? null,
    }),
  ];
  if (!skipDecisiveness) {
    parts.push(
      decisivenessPart({
        decisivenessLevel: result.decisiveness_level,
        competitivenessLabel: input.competitivenessLabel,
        currentRating: input.currentRating ?? null,
        marginPercent: input.marginPercent ?? null,
        marginElectionYears: input.marginElectionYears ?? null,
        marginContests: input.marginContests ?? null,
        staleAfterRedistricting: input.staleAfterRedistricting === true,
      })
    );
  }

  // The current rating only claims the "how" copy when it actually drove a
  // graded decisiveness level (uncontested and unknown grades never read it).
  const currentRatingUsed =
    input.currentRating != null &&
    !skipDecisiveness &&
    (result.decisiveness_level === "low" ||
      result.decisiveness_level === "medium" ||
      result.decisiveness_level === "high");
  const caveats = [
    explanationCaveatFor(result),
    currentRatingUsed ? currentRatingCaveat(input.currentRating ?? null) : null,
  ].filter((caveat): caveat is string => caveat !== null);

  return {
    how: howCalculated(input.raceType),
    parts,
    result: explanationResultFor(result, { skipDecisiveness, isBallotMeasure }),
    caveat: caveats.length > 0 ? caveats.join(" ") : null,
  };
}

export function isRetentionVotePowerInput(input: Pick<VotePowerInput, "raceType" | "officialBallotTitle">): boolean {
  return (
    input.raceType === "office" &&
    typeof input.officialBallotTitle === "string" &&
    isJudicialRetentionTitle(input.officialBallotTitle)
  );
}

// Shown under the "Retention race" value on the detail page: a reader who
// has never met the term needs both what the race is and why no rating.
const RETENTION_EXPLANATION =
  "A retention race asks Yes or No on keeping one judge in office. With no competing candidates, the normal vote power rating methods don't apply.";

export function calculateVotePower(input: VotePowerInput): VotePowerResult {
  // Checked before the uncontested rule: a retention race has exactly one
  // candidate but is decided by the Yes/No vote, so "uncontested" would be
  // wrong, and no data source grades how close a retention vote will be.
  if (isRetentionVotePowerInput(input)) {
    return {
      score: null,
      label: "retention",
      confidence: "high",
      representation_level: "unknown",
      decisiveness_level: "unknown",
      factors: [],
    };
  }
  const representationPowerScore = normalizeRepresentationPowerScore(input.representationPowerScore);
  const representationLevel = representationLevelFromScore(representationPowerScore);
  const decisivenessLevel = decisivenessLevelFromContest(input);
  const ballotMeasureWithRepresentation =
    input.raceType === "ballot_measure" && representationLevel !== "unknown" && decisivenessLevel === "unknown";
  const missingCoreAxis =
    representationLevel === "unknown" || (decisivenessLevel === "unknown" && !ballotMeasureWithRepresentation);

  let label = labelFromKnownAxis({ representationLevel, decisivenessLevel });
  if (missingCoreAxis) {
    label = capLabel(label, "high");
  }
  // Ballot measures are a direct vote on the policy itself, with no
  // representative in between: one tier up. "Very high" stays reserved for
  // measures with close-race evidence — a small district alone tops out at
  // "high", the same ceiling a partial-data rating has. Label only: the score
  // carries no bonus, because score bands already overlap across tiers (an
  // office "very high" starts near 76 while "high" runs to about 81), so a
  // bonus could not make the sort follow the labels — it would only push
  // evidence-free small-district measures over toss-up offices.
  if (input.raceType === "ballot_measure") {
    label = bumpLabel(label);
    if (missingCoreAxis || decisivenessLevel === "unknown") {
      label = capLabel(label, "high");
    }
  }

  return {
    score: calculateScore({
      representationPowerScore,
      representationLevel,
      decisivenessLevel,
      competitivenessLabel: input.competitivenessLabel,
      hasMissingCoreAxis: missingCoreAxis,
    }),
    label,
    confidence: confidenceFor({ representationLevel, decisivenessLevel, hasMissingCoreAxis: missingCoreAxis }),
    representation_level: representationLevel,
    decisiveness_level: decisivenessLevel,
    factors: factorsFor({
      raceType: input.raceType,
      representationLevel,
      decisivenessLevel,
      omitMissingDecisiveness: ballotMeasureWithRepresentation,
    }),
  };
}
