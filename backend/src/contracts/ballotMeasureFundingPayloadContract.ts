import { findBlockedSourceReason } from "../pipeline/candidates/candidateRecordSourcePolicy.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";

// Payload contract for manual:ballot-measure-funding:write. One payload
// describes one measure: the committees registered for and against it in the
// official campaign finance system, and the largest donors behind each side.
//
// The page shows donors, not committee names — a committee name ("Consumers
// for Smart Solar") can hide who is paying. Committees are still stored so a
// later refresh reads the same filings and a reviewer can audit the numbers.

export const BALLOT_MEASURE_FUNDING_SIDES = ["support", "oppose"] as const;
export type BallotMeasureFundingSide = (typeof BALLOT_MEASURE_FUNDING_SIDES)[number];

export const BALLOT_MEASURE_FUNDING_MAX_TOP_DONORS = 5;
export const BALLOT_MEASURE_FUNDING_MAX_COMMITTEES = 20;

export type BallotMeasureFundingCommittee = {
  name: string;
  committee_id?: string;
  total_raised: number;
  // Money this committee received from another listed committee on the same
  // side. Subtracted from the side total so a transfer is not counted twice.
  from_same_side_committees: number;
  // True when the committee also backs or fights other measures, so its money
  // cannot be assigned to this measure alone.
  also_covers_other_measures: boolean;
  source_url: string;
};

export type BallotMeasureFundingDonor = {
  name: string;
  amount: number;
  type: "organization" | "individual";
  state?: string;
};

export type BallotMeasureFundingSideRecord = {
  total_raised: number;
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

// Totals are computed here from the committee rows. A payload that carries
// its own total was built by agent arithmetic, which is what we reject.
const DERIVED_SIDE_FIELDS = ["total_raised", "total_from_top_donors"] as const;

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

function parseMoney(value: unknown, label: string, options: { allowZero: boolean }): number | { reason: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { reason: `${label} must be a number (dollars, no quotes or symbols): ${String(value)}` };
  }
  if (value < 0 || (!options.allowZero && value === 0)) {
    return { reason: `${label} must be ${options.allowZero ? "zero or more" : "greater than zero"}: ${value}` };
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

  const totalRaised = parseMoney(value.total_raised, `${label} total_raised`, { allowZero: true });
  if (typeof totalRaised !== "number") {
    return { ok: false, reason: totalRaised.reason };
  }
  const fromSameSide =
    value.from_same_side_committees === undefined
      ? 0
      : parseMoney(value.from_same_side_committees, `${label} from_same_side_committees`, { allowZero: true });
  if (typeof fromSameSide !== "number") {
    return { ok: false, reason: fromSameSide.reason };
  }
  if (toCents(fromSameSide) > toCents(totalRaised)) {
    return {
      ok: false,
      reason: `${label} from_same_side_committees (${fromSameSide}) cannot exceed its total_raised (${totalRaised})`,
    };
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
      total_raised: totalRaised,
      from_same_side_committees: fromSameSide,
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
  const amount = parseMoney(value.amount, `${label} amount`, { allowZero: false });
  if (typeof amount !== "number") {
    return { ok: false, reason: amount.reason };
  }
  if (!isNonEmptyString(value.type) || !DONOR_TYPES.has(value.type.trim())) {
    return { ok: false, reason: `${label} type must be organization or individual: ${String(value.type)}` };
  }
  if (value.state !== undefined && (!isNonEmptyString(value.state) || !STATE_PATTERN.test(value.state.trim()))) {
    return { ok: false, reason: `${label} state must be a two-letter uppercase code when present: ${String(value.state)}` };
  }

  return {
    ok: true,
    donor: {
      name,
      amount,
      type: value.type.trim() as BallotMeasureFundingDonor["type"],
      ...(value.state !== undefined ? { state: (value.state as string).trim() } : {}),
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
  for (const field of DERIVED_SIDE_FIELDS) {
    if (field in value) {
      return { ok: false, reason: `${side} ${field} is computed from the committees and must not appear in the payload` };
    }
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
          "record that transfer as from_same_side_committees on the receiving committee and list the original donors instead",
      };
    }
    donorKeys.add(key);
    donors.push(parsed.donor);
  }

  if (donors.length > 0 && committees.length === 0) {
    return { ok: false, reason: `${side} top_donors needs at least one committee the donors gave to` };
  }

  const totalCents = committees.reduce(
    (sum, committee) => sum + toCents(committee.total_raised) - toCents(committee.from_same_side_committees),
    0
  );
  for (const donor of donors) {
    if (toCents(donor.amount) > totalCents) {
      return {
        ok: false,
        reason:
          `${side} top_donors "${donor.name}" gave ${donor.amount}, more than the side's total raised (${totalCents / 100}); ` +
          "the committee totals and donor amounts must come from filings of the same date",
      };
    }
  }

  // Largest first; ties keep payload order.
  const sortedDonors = donors
    .map((donor, index) => ({ donor, index }))
    .sort((a, b) => b.donor.amount - a.donor.amount || a.index - b.index)
    .map((entry) => entry.donor);

  return {
    ok: true,
    record: { total_raised: totalCents / 100, committees, top_donors: sortedDonors },
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
  for (const committee of oppose.record.committees) {
    if (supportKeys.has(nameKey(committee.name))) {
      return { ok: false, reason: `committee "${committee.name}" is listed under both support and oppose` };
    }
  }

  return { ok: true, payload: { as_of: asOf, sides: { support: support.record, oppose: oppose.record } } };
}
