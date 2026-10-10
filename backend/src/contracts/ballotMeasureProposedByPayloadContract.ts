import { findBlockedSourceReason } from "../pipeline/candidates/candidateRecordSourcePolicy.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";

// Who put a ballot measure on the ballot, and who that is in plain words.
//
// A measure's title says what its author wants voters to hear; the proposer
// says whose idea it was. "Legislature (HB 300, Rep. Jane Smith)" or "Citizen
// initiative filed by Protect Our Parks" is the fact; `about` is the
// explainer most readers need ("Rep. Smith is a Republican from Baton Rouge"
// / "a group funded mainly by the state hospital association") — the same
// role the donor `about` line plays on the funding card.
//
// The object is optional in the measure payload (older payloads omit it) and
// nullable: an explicit null means "researched, no proposer could be
// sourced", which stamps proposed_by_researched_at without a name so the due
// list stops re-queuing the measure.

export const BALLOT_MEASURE_PROPOSED_BY_MAX_NAME_LENGTH = 120;
export const BALLOT_MEASURE_PROPOSED_BY_MAX_ABOUT_LENGTH = 200;

export type BallotMeasureProposedBy = {
  // Short and factual: the body or filer, plus the bill or petition when one
  // names it. Never a judgment.
  name: string;
  // Plain-language identity of the proposer: party and home for a sponsor,
  // what a group is and who funds it for a filer. A role, never a judgment.
  about: string;
  // The enabling bill page or the election authority's initiative filing.
  source_url: string;
};

export type BallotMeasureProposedByParse =
  | { ok: true; proposedBy: BallotMeasureProposedBy }
  | { ok: false; reason: string };

// A researcher who found nothing should say so with null, not a placeholder
// name the page would print.
const PLACEHOLDER_NAME_PATTERN = /^(unknown|n\/a|na|none|not found|not available|tbd|unclear)\.?$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function parseBallotMeasureProposedBy(value: unknown, label = "proposed_by"): BallotMeasureProposedByParse {
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${label} must be an object { name, about, source_url } or null` };
  }

  if (!isNonEmptyString(value.name)) {
    return { ok: false, reason: `${label} name must be non-empty string (who put the measure on the ballot)` };
  }
  const name = normalizeText(value.name);
  if (PLACEHOLDER_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `${label} name "${name}" is a placeholder; use ${label}: null when no proposer could be sourced` };
  }
  if (name.length > BALLOT_MEASURE_PROPOSED_BY_MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `${label} name is ${name.length} characters (max ${BALLOT_MEASURE_PROPOSED_BY_MAX_NAME_LENGTH}); keep the body or filer plus the bill or petition number`,
    };
  }

  if (!isNonEmptyString(value.about)) {
    return {
      ok: false,
      reason:
        `${label} about is required: say who "${name}" is in plain words ` +
        '("Rep. Smith is a Republican from Baton Rouge", "a group funded mainly by the state hospital association")',
    };
  }
  const about = normalizeText(value.about);
  if (about.length > BALLOT_MEASURE_PROPOSED_BY_MAX_ABOUT_LENGTH) {
    return {
      ok: false,
      reason: `${label} about is ${about.length} characters (max ${BALLOT_MEASURE_PROPOSED_BY_MAX_ABOUT_LENGTH}); one or two short plain sentences`,
    };
  }
  if (about.toLowerCase() === name.toLowerCase()) {
    return { ok: false, reason: `${label} about repeats the name; say who that is instead` };
  }

  if (!isNonEmptyString(value.source_url)) {
    return { ok: false, reason: `${label} source_url must be non-empty string (the enabling bill page or the initiative filing)` };
  }
  const sourceUrl = normalizeHttpUrl(value.source_url);
  if (!sourceUrl) {
    return { ok: false, reason: `${label} source_url must be valid http(s) URL: ${value.source_url}` };
  }
  const blockedReason = findBlockedSourceReason([sourceUrl]);
  if (blockedReason) {
    return { ok: false, reason: `${label} ${blockedReason}` };
  }

  return { ok: true, proposedBy: { name, about, source_url: sourceUrl } };
}

export type OptionalBallotMeasureProposedByParse =
  | {
      ok: true;
      // undefined = key absent: leave stored columns alone.
      // null = researched, nothing sourced: stamp researched_at, clear the name.
      proposedBy: BallotMeasureProposedBy | null | undefined;
    }
  | { ok: false; reason: string };

export function parseOptionalBallotMeasureProposedBy(
  value: unknown,
  label = "proposed_by"
): OptionalBallotMeasureProposedByParse {
  if (value === undefined) {
    return { ok: true, proposedBy: undefined };
  }
  if (value === null) {
    return { ok: true, proposedBy: null };
  }
  const parsed = parseBallotMeasureProposedBy(value, label);
  return parsed.ok ? { ok: true, proposedBy: parsed.proposedBy } : parsed;
}
