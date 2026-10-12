// Delaware direct-contribution aggregation (docs/plans/plan-delaware-finance.md fact 2).
//
// Money model, pinned against the live per-period reconciliation evidence
// (every period's CSV rows sum cent-exact to the cover's 2E subtotal, which
// includes in-kind, loans and other income):
// - total_receipts   = summed canonical cover receipts (computed by the
//   sync from the inventory, not here).
// - direct_contribution_total = every window row EXCEPT Candidate Loan and
//   Other Income (donor money only; in-kind and the sub-$100 aggregate rows
//   count, refunds/negative rows subtract).
// - contribution-size buckets = POSITIVE itemized monetary rows only — no
//   aggregate rows, no in-kind, no loans/other income, no negative rows.
// - occupation breakdown = disclosed-only (hard fact 1): positive monetary
//   rows from Individual contributors whose Employer Occupation is
//   non-blank, published verbatim. No "Unknown" bucket — a committee with
//   zero disclosed occupations renders no chart — and never any industry
//   classification of the text.
// Unknown Contribution Types are counted, never guessed; the sync fails
// closed when any appear.

import {
  DELAWARE_SUB_100_AGGREGATE_TYPE,
  parseDelawareAmountCents,
  type DelawareReceiptCsvRow,
} from "./delawareCfrsParsers.js";
import { delawareFilingPeriodKey } from "./delawareReportInventory.js";

/** Known cash labels, including the full EFT label published in 2026. */
const MONETARY_CONTRIBUTION_TYPES = new Set(["Check", "Credit Card", "EFT", "Electronic Fund Transfer", "Cash"]);
const IN_KIND_CONTRIBUTION_TYPE = "In-Kind";
const EXCLUDED_FROM_DIRECT_CONTRIBUTION_TYPES = new Set(["Candidate Loan", "Other Income"]);

export type DelawareFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
};

export type DelawareDirectFinanceAggregationResult = {
  /** Signed sum of every window row — must equal the window cover receipts. */
  windowRowTotalCents: number;
  /** Donor money only (fact 2): window rows minus loans and other income. */
  directContributionCents: number;
  inKindCents: number;
  candidateLoanCents: number;
  otherIncomeCents: number;
  sub100AggregateCents: number;
  includedRowCount: number;
  negativeOrZeroRowCount: number;
  unrecognizedContributionTypeRowCount: number;
  unrecognizedContributionTypes: string[];
  breakdowns: DelawareFinanceDirectBreakdown[];
};

function sizeBucket(amountCents: number): string {
  if (amountCents < 10_000) return "$1-$99";
  if (amountCents < 25_000) return "$100-$249";
  if (amountCents < 50_000) return "$250-$499";
  if (amountCents < 100_000) return "$500-$999";
  if (amountCents < 500_000) return "$1,000-$4,999";
  return "$5,000+";
}

export function aggregateDelawareDirectFinance(input: {
  receiptRows: readonly DelawareReceiptCsvRow[];
  /** Normalized period keys of the resolved election-period window. */
  windowPeriodKeys: ReadonlySet<string>;
  maxOccupationBreakdowns?: number;
}): DelawareDirectFinanceAggregationResult {
  const maxOccupationBreakdowns = input.maxOccupationBreakdowns ?? 50;
  let windowRowTotalCents = 0;
  let directContributionCents = 0;
  let inKindCents = 0;
  let candidateLoanCents = 0;
  let otherIncomeCents = 0;
  let sub100AggregateCents = 0;
  let includedRowCount = 0;
  let negativeOrZeroRowCount = 0;
  let unrecognizedContributionTypeRowCount = 0;
  const unrecognizedContributionTypes = new Set<string>();
  const bucketTotals = new Map<string, { cents: number; contributors: Set<string> }>();
  const occupationTotals = new Map<string, { cents: number; contributors: Set<string> }>();

  for (const row of input.receiptRows) {
    if (!input.windowPeriodKeys.has(delawareFilingPeriodKey(row["Filing Period"]))) {
      continue;
    }
    const amountCents = parseDelawareAmountCents(row["Contribution Amount"]);
    const contributionType = row["Contribution Type"].trim();
    const contributorType = row["Contributor Type"].trim();
    windowRowTotalCents += amountCents;
    includedRowCount += 1;

    if (
      contributionType === DELAWARE_SUB_100_AGGREGATE_TYPE ||
      contributorType === DELAWARE_SUB_100_AGGREGATE_TYPE
    ) {
      sub100AggregateCents += amountCents;
      directContributionCents += amountCents;
      continue;
    }
    if (EXCLUDED_FROM_DIRECT_CONTRIBUTION_TYPES.has(contributionType)) {
      if (contributionType === "Candidate Loan") {
        candidateLoanCents += amountCents;
      } else {
        otherIncomeCents += amountCents;
      }
      continue;
    }
    if (contributionType === IN_KIND_CONTRIBUTION_TYPE) {
      inKindCents += amountCents;
      directContributionCents += amountCents;
      continue;
    }
    if (!MONETARY_CONTRIBUTION_TYPES.has(contributionType)) {
      unrecognizedContributionTypeRowCount += 1;
      unrecognizedContributionTypes.add(contributionType);
      continue;
    }

    directContributionCents += amountCents;
    if (amountCents <= 0) {
      negativeOrZeroRowCount += 1;
      continue;
    }
    const contributorKey = `${row["Contributor Name"]}\u0000${row["Contributor Zip"]}`.toUpperCase();
    const bucket = sizeBucket(amountCents);
    const bucketEntry = bucketTotals.get(bucket) ?? { cents: 0, contributors: new Set<string>() };
    bucketEntry.cents += amountCents;
    bucketEntry.contributors.add(contributorKey);
    bucketTotals.set(bucket, bucketEntry);

    const occupation = row["Employer Occupation"].trim();
    if (contributorType === "Individual" && occupation !== "") {
      const occupationEntry = occupationTotals.get(occupation) ?? { cents: 0, contributors: new Set<string>() };
      occupationEntry.cents += amountCents;
      occupationEntry.contributors.add(contributorKey);
      occupationTotals.set(occupation, occupationEntry);
    }
  }

  const breakdowns: DelawareFinanceDirectBreakdown[] = [];
  const occupations = [...occupationTotals.entries()]
    .sort((left, right) => right[1].cents - left[1].cents || left[0].localeCompare(right[0]))
    .slice(0, maxOccupationBreakdowns);
  for (const [name, entry] of occupations) {
    breakdowns.push({
      categoryType: "occupation",
      categoryName: name,
      amount: entry.cents / 100,
      contributorCount: entry.contributors.size,
    });
  }
  for (const [name, entry] of [...bucketTotals.entries()].sort(
    (left, right) => right[1].cents - left[1].cents || left[0].localeCompare(right[0])
  )) {
    breakdowns.push({
      categoryType: "contribution_size",
      categoryName: name,
      amount: entry.cents / 100,
      contributorCount: entry.contributors.size,
    });
  }

  return {
    windowRowTotalCents,
    directContributionCents,
    inKindCents,
    candidateLoanCents,
    otherIncomeCents,
    sub100AggregateCents,
    includedRowCount,
    negativeOrZeroRowCount,
    unrecognizedContributionTypeRowCount,
    unrecognizedContributionTypes: [...unrecognizedContributionTypes].sort(),
    breakdowns,
  };
}
