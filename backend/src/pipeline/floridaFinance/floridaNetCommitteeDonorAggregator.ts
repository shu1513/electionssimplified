import type { FloridaContributionRow } from "./floridaCampaignFinanceRows.js";

export type FloridaCommitteeDonorType = "PAC" | "CCE" | "PTY" | "PAP";

export type FloridaCommitteeCashIdentity = {
  kind: "committee";
  committeeId: string;
  committeeName: string;
  committeeType: FloridaCommitteeDonorType;
  sourceUrl: string;
};

export type FloridaCashDonorResolution =
  | FloridaCommitteeCashIdentity
  // A positively identified entity outside the committee-donor scope.
  | { kind: "excluded" }
  // A complete scoped lookup found no exact registered legal name. Its cash
  // remains unclassified; a refund cannot safely be assumed unrelated.
  | { kind: "unmatched" }
  // Failed lookup, conflicting identities, or unresolved historical ownership.
  | { kind: "unresolved"; reason: string };

export type FloridaNetCommitteeDonor = Omit<FloridaCommitteeCashIdentity, "kind"> & {
  amount: number;
  grossAmount: number;
  refundAmount: number;
  contributionCount: number;
  refundCount: number;
};

export type FloridaNetCommitteeAggregationResult =
  | { status: "preserve"; reason: string }
  | {
      status: "accepted";
      donors: FloridaNetCommitteeDonor[];
      netCommitteeAmount: number;
      unclassifiedPositiveCashAmount: number;
      unclassifiedPositiveCashCount: number;
    };

type Aggregate = {
  identity: FloridaCommitteeCashIdentity;
  grossCents: number;
  refundCents: number;
  contributionCount: number;
  refundCount: number;
};

const CASH_TYPES = new Set(["CHE", "CAS", "MO"]);
const NON_GIFT_TYPES = new Set(["COF", "INK", "LOA", "INT"]);
const COMMITTEE_TYPES = new Set(["PAC", "CCE", "PTY", "PAP"]);

function exactName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function dateKey(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
    ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const iso = match[1].length === 4;
  const year = Number(match[iso ? 1 : 3]);
  const month = Number(match[iso ? 2 : 1]);
  const day = Number(match[iso ? 3 : 2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1996 || year > 2100 || date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function exactCents(value: string): number | null {
  const raw = value.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? (raw.startsWith("-") ? -cents : cents) : null;
}

function preserve(reason: string): FloridaNetCommitteeAggregationResult {
  return { status: "preserve", reason };
}

/**
 * Pure aggregation of an independently accepted CURRENT processed snapshot.
 * The source verifier establishes ownership/completeness/currentness; the
 * registry resolver establishes each donor identity. This function alone is
 * not source evidence and is deliberately not called by the normal sync yet.
 * Counts are positive reported occurrences, not invented transaction IDs.
 */
export function aggregateFloridaNetCommitteeDonors(input: {
  contributionRows: readonly FloridaContributionRow[];
  recipientNames: readonly string[];
  selfContributorNames: readonly string[];
  receivingCommitteeId?: string;
  windowStart: string;
  windowEnd: string;
  resolveDonor: (row: FloridaContributionRow) => FloridaCashDonorResolution;
}): FloridaNetCommitteeAggregationResult {
  const start = dateKey(input.windowStart);
  const end = dateKey(input.windowEnd);
  const recipients = new Set(input.recipientNames.map(exactName).filter(Boolean));
  const selves = new Set(input.selfContributorNames.map(exactName).filter(Boolean));
  if (!start || !end || start > end || recipients.size === 0) return preserve("invalid_scope");
  const aggregates = new Map<string, Aggregate>();
  let unclassifiedCents = 0;
  let unclassifiedCount = 0;

  for (const row of input.contributionRows) {
    if (!recipients.has(exactName(row.recipientName))) return preserve("recipient_mismatch");
    const date = dateKey(row.contributionDate);
    if (!date) return preserve("invalid_contribution_date");
    if (date < start || date > end) continue;
    const cents = exactCents(row.amount);
    if (cents === null) return preserve("invalid_contribution_cents");
    const type = row.transactionType.trim().toUpperCase();
    if (NON_GIFT_TYPES.has(type)) {
      if (cents < 0) return preserve("negative_non_refund");
      continue;
    }
    const refund = type === "REF";
    if (!refund && !CASH_TYPES.has(type)) return preserve("unknown_contribution_type");
    if (refund ? cents >= 0 : cents <= 0) return preserve("invalid_cash_sign");
    if (!exactName(row.contributorName)) return preserve("missing_cash_donor_name");
    if (selves.has(exactName(row.contributorName))) continue;

    const resolution = input.resolveDonor(row);
    if (resolution.kind === "unresolved") return preserve(`donor_identity:${resolution.reason}`);
    if (resolution.kind === "excluded") continue;
    if (resolution.kind === "unmatched") {
      if (refund) return preserve("unresolved_refund_identity");
      unclassifiedCents += cents;
      if (!Number.isSafeInteger(unclassifiedCents)) return preserve("unsafe_cash_sum");
      unclassifiedCount++;
      continue;
    }
    if (!/^\d+$/.test(resolution.committeeId) || Number(resolution.committeeId) <= 0
        || !exactName(resolution.committeeName) || !COMMITTEE_TYPES.has(resolution.committeeType)
        || !resolution.sourceUrl.trim()) return preserve("invalid_committee_identity");
    if (resolution.committeeId === input.receivingCommitteeId) continue;
    let aggregate = aggregates.get(resolution.committeeId);
    if (!aggregate) {
      aggregate = { identity: resolution, grossCents: 0, refundCents: 0, contributionCount: 0, refundCount: 0 };
      aggregates.set(resolution.committeeId, aggregate);
    } else if (exactName(aggregate.identity.committeeName) !== exactName(resolution.committeeName)
               || aggregate.identity.committeeType !== resolution.committeeType) {
      return preserve("conflicting_committee_identity");
    }
    if (refund) {
      aggregate.refundCents -= cents;
      aggregate.refundCount++;
    } else {
      aggregate.grossCents += cents;
      aggregate.contributionCount++;
    }
    if (!Number.isSafeInteger(aggregate.grossCents) || !Number.isSafeInteger(aggregate.refundCents)) {
      return preserve("unsafe_cash_sum");
    }
  }

  const donors: FloridaNetCommitteeDonor[] = [];
  let totalCents = 0;
  for (const aggregate of aggregates.values()) {
    const netCents = aggregate.grossCents - aggregate.refundCents;
    if (netCents < 0) return preserve("negative_committee_net");
    if (netCents === 0) continue;
    totalCents += netCents;
    if (!Number.isSafeInteger(totalCents)) return preserve("unsafe_cash_sum");
    const { kind: _kind, ...identity } = aggregate.identity;
    donors.push({
      ...identity,
      amount: netCents / 100,
      grossAmount: aggregate.grossCents / 100,
      refundAmount: aggregate.refundCents / 100,
      contributionCount: aggregate.contributionCount,
      refundCount: aggregate.refundCount,
    });
  }
  donors.sort((a, b) => b.amount - a.amount || a.committeeId.localeCompare(b.committeeId));
  return {
    status: "accepted", donors, netCommitteeAmount: totalCents / 100,
    unclassifiedPositiveCashAmount: unclassifiedCents / 100,
    unclassifiedPositiveCashCount: unclassifiedCount,
  };
}
