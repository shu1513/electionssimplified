import { findBlockedSourceReason } from "../pipeline/candidates/candidateRecordSourcePolicy.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";

// Payload contract for manual:ballot-measure-funding:write. One payload
// describes one measure: the largest donors behind each side, and the
// committees those donors gave to, from the official campaign finance system.
//
// The page shows donors, not committee names — a committee name ("Consumers
// for Smart Solar") can hide who is paying. Committees are still stored so a
// later refresh reads the same filings and a reviewer can audit the numbers.
//
// There is deliberately no "total raised". Readers want to know which
// interests are paying, and states do not publish a total on the same date
// as their donor lists (California's totals run weeks behind its top-10
// lists), so a total next to the donors would mix two dates.

export const BALLOT_MEASURE_FUNDING_SIDES = ["support", "oppose"] as const;
export type BallotMeasureFundingSide = (typeof BALLOT_MEASURE_FUNDING_SIDES)[number];

export const BALLOT_MEASURE_FUNDING_MAX_TOP_DONORS = 5;
export const BALLOT_MEASURE_FUNDING_MAX_COMMITTEES = 20;

export type BallotMeasureFundingCommittee = {
  name: string;
  committee_id?: string;
  // True when the committee also backs or fights other measures, so a gift to
  // it cannot be assigned to this measure alone.
  also_covers_other_measures: boolean;
  source_url: string;
};

export type BallotMeasureFundingDonor = {
  name: string;
  amount: number;
  type: "organization" | "individual";
  state?: string;
  // Who is behind a pass-through donor, as the filing agency names them
  // (California prints "Top Donors to Contributor" under such a donor).
  // Without it "Building a Better California" hides the people paying.
  funded_by?: string[];
  // What the donor is, in a few plain words ("Google co-founder", "teachers
  // union"). Most readers do not know the names. A role, never a judgment.
  about: string;
};

export const BALLOT_MEASURE_FUNDING_MAX_FUNDED_BY = 3;
export const BALLOT_MEASURE_FUNDING_MAX_ABOUT_LENGTH = 60;

export type BallotMeasureFundingSideRecord = {
  committees: BallotMeasureFundingCommittee[];
  top_donors: BallotMeasureFundingDonor[];
};

export type BallotMeasureFundingPayload = {
  as_of: string;
  sides: Record<BallotMeasureFundingSide, BallotMeasureFundingSideRecord>;
};

type ParseOptions = {
  today?: Date;
};

type ParseResult =
  | { ok: true; payload: BallotMeasureFundingPayload }
  | { ok: false; reason: string };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATE_PATTERN = /^[A-Z]{2}$/;
const DONOR_TYPES = new Set(["organization", "individual"]);

// Totals were part of this payload once. Rejecting them (rather than dropping
// them silently) tells the researcher they are not stored or shown.
const REMOVED_TOTAL_FIELDS = ["total_raised", "from_same_side_committees", "total_from_top_donors"] as const;

function findRemovedTotalField(value: Record<string, unknown>, label: string): string | null {
  const field = REMOVED_TOTAL_FIELDS.find((name) => name in value);
  return field ? `${label} ${field} is no longer part of this payload; totals are not stored, list only committees and top_donors` : null;
}

// Money figures must be read from the official filing system. These sites
// re-report filings, so their numbers can be stale or netted differently.
const SECONDARY_SOURCE_DOMAINS = ["ballotpedia.org", "opensecrets.org", "followthemoney.org", "wikipedia.org"] as const;

function isSecondarySource(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return SECONDARY_SOURCE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

// Filing systems roll small gifts into one line. That line is not a donor.
const AGGREGATE_DONOR_NAME_PATTERN = /^(small contributions|unitemized|un-itemized|anonymous|miscellaneous|for the calendar year)\b/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  // Date.parse rolls impossible days over (2026-02-30 -> March 2), so a
  // round-trip back to the input string is the actual calendar check.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function parseMoney(value: unknown, label: string): number | { reason: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { reason: `${label} must be a number (dollars, no quotes or symbols): ${String(value)}` };
  }
  if (value <= 0) {
    return { reason: `${label} must be greater than zero: ${value}` };
  }
  return toCents(value) / 100;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function nameKey(value: string): string {
  return normalizeName(value).toLowerCase();
}

function parseCommittee(
  value: unknown,
  label: string
): { ok: true; committee: BallotMeasureFundingCommittee } | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${label} must be an object` };
  }
  if (!isNonEmptyString(value.name)) {
    return { ok: false, reason: `${label} name must be non-empty string` };
  }
  if (value.committee_id !== undefined && !isNonEmptyString(value.committee_id)) {
    return { ok: false, reason: `${label} committee_id must be non-empty string when present` };
  }

  const removedField = findRemovedTotalField(value, label);
  if (removedField) {
    return { ok: false, reason: removedField };
  }

  if (value.also_covers_other_measures !== undefined && typeof value.also_covers_other_measures !== "boolean") {
    return { ok: false, reason: `${label} also_covers_other_measures must be true or false when present` };
  }

  if (!isNonEmptyString(value.source_url)) {
    return { ok: false, reason: `${label} source_url must be non-empty string` };
  }
  const sourceUrl = normalizeHttpUrl(value.source_url);
  if (!sourceUrl) {
    return { ok: false, reason: `${label} source_url must be valid http(s) URL: ${value.source_url}` };
  }
  if (isSecondarySource(sourceUrl)) {
    return {
      ok: false,
      reason: `${label} source_url must be the official campaign finance filing system, not a site that re-reports it: ${sourceUrl}`,
    };
  }
  const blockedReason = findBlockedSourceReason([sourceUrl]);
  if (blockedReason) {
    return { ok: false, reason: `${label} ${blockedReason}` };
  }

  return {
    ok: true,
    committee: {
      name: normalizeName(value.name),
      ...(value.committee_id !== undefined ? { committee_id: value.committee_id.trim() } : {}),
      also_covers_other_measures: value.also_covers_other_measures === true,
      source_url: sourceUrl,
    },
  };
}

function parseDonor(
  value: unknown,
  label: string
): { ok: true; donor: BallotMeasureFundingDonor } | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${label} must be an object` };
  }
  if (!isNonEmptyString(value.name)) {
    return { ok: false, reason: `${label} name must be non-empty string` };
  }
  const name = normalizeName(value.name);
  if (AGGREGATE_DONOR_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `${label} "${name}" is a roll-up line for many small gifts, not a donor; leave it out` };
  }
  const amount = parseMoney(value.amount, `${label} amount`);
  if (typeof amount !== "number") {
    return { ok: false, reason: amount.reason };
  }
  if (!isNonEmptyString(value.type) || !DONOR_TYPES.has(value.type.trim())) {
    return { ok: false, reason: `${label} type must be organization or individual: ${String(value.type)}` };
  }
  if (value.state !== undefined && (!isNonEmptyString(value.state) || !STATE_PATTERN.test(value.state.trim()))) {
    return { ok: false, reason: `${label} state must be a two-letter uppercase code when present: ${String(value.state)}` };
  }

  let fundedBy: string[] | undefined;
  if (value.funded_by !== undefined) {
    if (
      !Array.isArray(value.funded_by) ||
      value.funded_by.length === 0 ||
      value.funded_by.length > BALLOT_MEASURE_FUNDING_MAX_FUNDED_BY ||
      !value.funded_by.every(isNonEmptyString)
    ) {
      return {
        ok: false,
        reason: `${label} funded_by must list 1 to ${BALLOT_MEASURE_FUNDING_MAX_FUNDED_BY} names when present; leave it out otherwise`,
      };
    }
    fundedBy = value.funded_by.map(normalizeName);
  }

  // Required: a bare name ("1800 Capital, Inc.") tells a reader nothing. When
  // research finds nothing, say that ("Austin, Texas LLC; owner not named in
  // filings") — anonymous money is itself worth knowing.
  if (!isNonEmptyString(value.about) || normalizeName(value.about).length > BALLOT_MEASURE_FUNDING_MAX_ABOUT_LENGTH) {
    return {
      ok: false,
      reason:
        `${label} about is required: say what "${name}" is in at most ${BALLOT_MEASURE_FUNDING_MAX_ABOUT_LENGTH} characters ` +
        '("Google co-founder", "teachers union"); if research finds nothing, say so ("Texas LLC; owner not named in filings")',
    };
  }

  return {
    ok: true,
    donor: {
      name,
      amount,
      type: value.type.trim() as BallotMeasureFundingDonor["type"],
      ...(value.state !== undefined ? { state: (value.state as string).trim() } : {}),
      ...(fundedBy !== undefined ? { funded_by: fundedBy } : {}),
      about: normalizeName(value.about),
    },
  };
}

function parseSide(
  value: unknown,
  side: BallotMeasureFundingSide
): { ok: true; record: BallotMeasureFundingSideRecord } | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      reason: `${side} must be an object with committees and top_donors (use empty arrays when no committee reported money)`,
    };
  }
  const removedField = findRemovedTotalField(value, side);
  if (removedField) {
    return { ok: false, reason: removedField };
  }
  if (!Array.isArray(value.committees)) {
    return { ok: false, reason: `${side} committees must be an array` };
  }
  if (!Array.isArray(value.top_donors)) {
    return { ok: false, reason: `${side} top_donors must be an array` };
  }
  if (value.committees.length > BALLOT_MEASURE_FUNDING_MAX_COMMITTEES) {
    return { ok: false, reason: `${side} committees has more than ${BALLOT_MEASURE_FUNDING_MAX_COMMITTEES} entries` };
  }
  if (value.top_donors.length > BALLOT_MEASURE_FUNDING_MAX_TOP_DONORS) {
    return {
      ok: false,
      reason: `${side} top_donors has more than ${BALLOT_MEASURE_FUNDING_MAX_TOP_DONORS} entries; keep only the largest`,
    };
  }

  const committees: BallotMeasureFundingCommittee[] = [];
  const committeeKeys = new Set<string>();
  const committeeIdKeys = new Set<string>();
  for (const [index, entry] of value.committees.entries()) {
    const parsed = parseCommittee(entry, `${side} committees[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    const key = nameKey(parsed.committee.name);
    if (committeeKeys.has(key)) {
      return { ok: false, reason: `${side} committees lists "${parsed.committee.name}" more than once` };
    }
    committeeKeys.add(key);
    // The filing id catches the same committee entered under two spellings,
    // which would count its money twice. source_url is no such signal: one
    // agency page (California's top-contributors list) can cover many
    // committees.
    const idKey = parsed.committee.committee_id?.toLowerCase();
    if (idKey !== undefined) {
      if (committeeIdKeys.has(idKey)) {
        return {
          ok: false,
          reason: `${side} committees lists committee_id ${parsed.committee.committee_id} more than once ("${parsed.committee.name}")`,
        };
      }
      committeeIdKeys.add(idKey);
    }
    committees.push(parsed.committee);
  }

  const donors: BallotMeasureFundingDonor[] = [];
  const donorKeys = new Set<string>();
  for (const [index, entry] of value.top_donors.entries()) {
    const parsed = parseDonor(entry, `${side} top_donors[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    const key = nameKey(parsed.donor.name);
    if (donorKeys.has(key)) {
      return { ok: false, reason: `${side} top_donors lists "${parsed.donor.name}" more than once; add the amounts into one entry` };
    }
    if (committeeKeys.has(key)) {
      return {
        ok: false,
        reason:
          `${side} top_donors "${parsed.donor.name}" is itself a ${side} committee in this payload; ` +
          "money moved between committees on one side is not a donation, so list that committee's own donors instead",
      };
    }
    donorKeys.add(key);
    donors.push(parsed.donor);
  }

  if (donors.length > 0 && committees.length === 0) {
    return { ok: false, reason: `${side} top_donors needs at least one committee the donors gave to` };
  }

  // Largest first; ties keep payload order.
  const sortedDonors = donors
    .map((donor, index) => ({ donor, index }))
    .sort((a, b) => b.donor.amount - a.donor.amount || a.index - b.index)
    .map((entry) => entry.donor);

  return {
    ok: true,
    record: { committees, top_donors: sortedDonors },
  };
}

export function parseBallotMeasureFundingPayload(payload: unknown, options: ParseOptions = {}): ParseResult {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  if (!isNonEmptyString(payload.as_of) || !isValidIsoDate(payload.as_of.trim())) {
    return { ok: false, reason: `as_of must be a valid YYYY-MM-DD date: ${String(payload.as_of)}` };
  }
  const asOf = payload.as_of.trim();
  const today = options.today ?? new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (Date.parse(`${asOf}T00:00:00.000Z`) > todayUtc) {
    return { ok: false, reason: `as_of must not be in the future: ${asOf}` };
  }

  const support = parseSide(payload.support, "support");
  if (!support.ok) {
    return support;
  }
  const oppose = parseSide(payload.oppose, "oppose");
  if (!oppose.ok) {
    return oppose;
  }

  // The same committee cannot be on both sides of one measure.
  const supportKeys = new Set(support.record.committees.map((committee) => nameKey(committee.name)));
  const supportIdKeys = new Set(
    support.record.committees.flatMap((committee) => (committee.committee_id ? [committee.committee_id.toLowerCase()] : []))
  );
  for (const committee of oppose.record.committees) {
    if (
      supportKeys.has(nameKey(committee.name)) ||
      (committee.committee_id !== undefined && supportIdKeys.has(committee.committee_id.toLowerCase()))
    ) {
      return { ok: false, reason: `committee "${committee.name}" is listed under both support and oppose` };
    }
  }

  return { ok: true, payload: { as_of: asOf, sides: { support: support.record, oppose: oppose.record } } };
}
