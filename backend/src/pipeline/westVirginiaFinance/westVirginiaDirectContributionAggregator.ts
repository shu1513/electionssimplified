// West Virginia direct-finance aggregation (plan hard facts 1, 2 and 10).
//
// Sources: the bulk CSVs are the totals authority (every row the committee
// filed, current versions only — the sync re-proves that against the API
// every run); the API rows are the attribute authority for occupation, the
// one field the CSVs lack. Every category / contributor-type / expenditure
// -type value was pinned from the live 2025-2026 files (2026-09-01); a
// value outside the pinned vocabulary is counted and surfaced, never
// guessed — the sync fails closed on any.
//
// Money model:
// - total_receipts = every contribution-file row in the window, Returns
//   subtracted (Return rows carry POSITIVE amounts in both files).
// - direct_contribution_total (the card's "Raised") = Monetary + In-Kind
//   from donors — individuals, businesses, PACs, party committees — minus
//   Returns to those donors. The candidate's own money (Self / Candidate
//   rows), Other Income and transfers from the candidate's other committee
//   are excluded; loans live in a separate bulk file and never enter.
// - total_disbursements = Monetary + Disbursement of Excess Funds
//   expenditures minus Returns (vendor refunds).
// - Contribution-size buckets = positive itemized Monetary rows from
//   individuals (CSV).
// - Occupation breakdown = API Monetary + In-Kind rows from individuals,
//   the state's controlled label published verbatim after whitespace
//   normalization; blank and "Unknown" excluded, nothing inferred.
// - Industry breakdown = the CSV employer field of the same donor rows,
//   through the shared rule classifier only, and ONLY for statements filed
//   before 2027-01-01: W. Va. Code §3-8-6a bars public release of the
//   employer ("major business affiliation") on statements filed on or after
//   that date, so those rows produce no employer-derived output even if the
//   state keeps exporting the column. Recovered (bad-width) rows skip the
//   employer field too — the parser flags it unreliable on those rows.

import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import type { WestVirginiaCommitteeRow, WestVirginiaTransactionRow } from "./westVirginiaCfrsClient.js";
import type { WestVirginiaContributionCsvRow, WestVirginiaExpenditureCsvRow } from "./westVirginiaCfrsCsv.js";
import { normalizeWestVirginiaCommitteeDonorName, westVirginiaCommitteeDonorRegistryType } from "./westVirginiaCommitteeDonorReconciliation.js";
import { apiAmountToCents } from "./westVirginiaPhaseZero.js";
import { isWestVirginiaDateInWindow, type WestVirginiaCycleWindow } from "./westVirginiaReportingCycleWindows.js";

const CATEGORY_MONETARY = "Monetary";
const CATEGORY_IN_KIND = "In-Kind";
const CATEGORY_OTHER_INCOME = "Other Income";
const CATEGORY_TRANSFER_IN = "Receipt of Transfer of Excess Funds";
const CATEGORY_RETURN = "Return";

/** Category vocabulary of the contributions bulk file (verified live). */
export const WEST_VIRGINIA_CONTRIBUTION_FILE_CATEGORIES: ReadonlySet<string> = new Set([
  CATEGORY_MONETARY,
  CATEGORY_IN_KIND,
  CATEGORY_OTHER_INCOME,
  CATEGORY_TRANSFER_IN,
  CATEGORY_RETURN,
]);

/** Donor-money categories (the API CON selector also returns loan subtypes). */
export const WEST_VIRGINIA_DIRECT_DONATION_CATEGORIES: ReadonlySet<string> = new Set([
  CATEGORY_MONETARY,
  CATEGORY_IN_KIND,
]);

const CONTRIBUTOR_TYPE_INDIVIDUAL = "Individual";
const DONOR_CONTRIBUTOR_TYPES: ReadonlySet<string> = new Set([
  CONTRIBUTOR_TYPE_INDIVIDUAL,
  "Business or Organization",
  "Political Action Committee",
  "Political Party Committee / Caucus Campaign Committee",
]);
const SELF_CONTRIBUTOR_TYPES: ReadonlySet<string> = new Set(["Self", "Candidate"]);

const EXPENDITURE_TYPE_MONETARY = "Monetary";
const EXPENDITURE_TYPE_DISBURSEMENT_OF_EXCESS_FUNDS = "Disbursement of Excess Funds";
const EXPENDITURE_TYPE_RETURN = "Return";

/** §3-8-6a: statements filed on or after this date carry no public employer. */
export const WEST_VIRGINIA_EMPLOYER_REDACTION_FILED_DATE = "2027-01-01";

const EXCLUDED_OCCUPATION_LABELS: ReadonlySet<string> = new Set(["unknown"]);

export const WEST_VIRGINIA_DIRECT_COVERAGE_NOTE =
  "Raised counts contributions from individuals, businesses, PACs, and party committees, minus money returned to donors; the candidate's own money, loans, transfers between the candidate's committees, and other income are not included.";

export type WestVirginiaFinanceDirectBreakdown = {
  categoryType: "occupation" | "industry" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
};

export type WestVirginiaFinancePacDonor = {
  committeeId: string;
  committeeName: string;
  /** Exact CFRS registry class; 102 PAC, 103 party/caucus. */
  committeeType: "102" | "103";
  totalAmount: number;
  contributionCount: number;
  sourceUrl: string;
};

export type WestVirginiaDirectFinanceAggregationResult = {
  /** Omitted without an authoritative registry; [] is a successful empty replacement. */
  pacDonors?: WestVirginiaFinancePacDonor[];
  /** Signed sum of every recognized contribution-file row in the window. */
  totalReceiptsCents: number;
  /** Donor money only (see the money model above). */
  directContributionCents: number;
  returnedContributionCents: number;
  selfFundingCents: number;
  otherIncomeCents: number;
  transferInCents: number;
  /** Signed sum of every recognized expenditure row in the window. */
  totalDisbursementsCents: number;
  returnedExpenditureCents: number;
  contributionRowCount: number;
  expenditureRowCount: number;
  apiDonationRowCount: number;
  /** Donor rows whose employer was withheld under §3-8-6a. */
  employerRedactedRowCount: number;
  unrecognizedContributionCategories: string[];
  unrecognizedContributorTypes: string[];
  unrecognizedExpenditureTypes: string[];
  breakdowns: WestVirginiaFinanceDirectBreakdown[];
};

/** Delaware bucket edges — the fleet's contribution-size vocabulary. */
function sizeBucket(amountCents: number): string {
  if (amountCents < 10_000) return "$1-$99";
  if (amountCents < 25_000) return "$100-$249";
  if (amountCents < 50_000) return "$250-$499";
  if (amountCents < 100_000) return "$500-$999";
  if (amountCents < 500_000) return "$1,000-$4,999";
  return "$5,000+";
}

type Totals = Map<string, { cents: number; contributors: Set<string> }>;

function add(totals: Totals, name: string, cents: number, contributorKey: string): void {
  const entry = totals.get(name) ?? { cents: 0, contributors: new Set<string>() };
  entry.cents += cents;
  entry.contributors.add(contributorKey);
  totals.set(name, entry);
}

function sorted(totals: Totals): Array<[string, { cents: number; contributors: Set<string> }]> {
  return [...totals.entries()].sort((left, right) => right[1].cents - left[1].cents || left[0].localeCompare(right[0]));
}

/** Verbatim state label, whitespace-normalized; null for blank / "Unknown". */
export function normalizeWestVirginiaOccupationLabel(value: string | null): string | null {
  const label = (value ?? "").replace(/\s+/g, " ").trim();
  if (label === "" || EXCLUDED_OCCUPATION_LABELS.has(label.toLowerCase())) {
    return null;
  }
  return label;
}

function aggregateCommitteeDonors(input: {
  entityId: string;
  window: Pick<WestVirginiaCycleWindow, "windowStart" | "windowEnd">;
  contributionRows: readonly WestVirginiaContributionCsvRow[];
  committeeRegistryRows: readonly WestVirginiaCommitteeRow[];
}): WestVirginiaFinancePacDonor[] {
  // Include every type/status/year in name uniqueness BEFORE accepting source classes.
  const registryByName = new Map<string, Map<string, WestVirginiaCommitteeRow>>();
  for (const committee of input.committeeRegistryRows) {
    const name = normalizeWestVirginiaCommitteeDonorName(committee.orgName ?? "");
    if (!name) continue;
    const identities = registryByName.get(name) ?? new Map<string, WestVirginiaCommitteeRow>();
    // Repeated registry rows describe one donor only when all source identity
    // fields agree; status/election labels do not create another legal entity.
    const identity = JSON.stringify([committee.entityId, committee.orgTypeCode, committee.orgID]);
    if (!identities.has(identity)) identities.set(identity, committee);
    registryByName.set(name, identities);
  }
  const donors = new Map<string, { committee: WestVirginiaCommitteeRow; committeeType: "102" | "103"; cents: number; count: number }>();
  for (const row of input.contributionRows) {
    if (row.registrantId !== input.entityId || !isWestVirginiaDateInWindow(row.transactionDate, input.window)) continue;
    const committeeType = westVirginiaCommitteeDonorRegistryType(row.contributorType);
    if (!committeeType || ![CATEGORY_MONETARY, CATEGORY_IN_KIND, CATEGORY_RETURN].includes(row.transactionCategory)) continue;
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0 || (row.transactionCategory === CATEGORY_RETURN && row.amountCents === 0)) {
      throw new Error(`Invalid West Virginia committee donor amount for ${input.entityId}`);
    }
    const matches = [...(registryByName.get(normalizeWestVirginiaCommitteeDonorName(row.contributorName))?.values() ?? [])];
    if (matches.length !== 1 || matches[0]!.orgTypeCode !== committeeType) continue;
    const committee = matches[0]!;
    const entry = donors.get(committee.entityId) ?? { committee, committeeType, cents: 0, count: 0 };
    if (row.transactionCategory === CATEGORY_RETURN) entry.cents -= row.amountCents;
    else {
      entry.cents += row.amountCents;
      if (row.amountCents > 0) entry.count += 1;
    }
    if (!Number.isSafeInteger(entry.cents)) throw new Error(`Unsafe West Virginia committee donor total for ${committee.entityId}`);
    donors.set(committee.entityId, entry);
  }
  return [...donors.values()].flatMap(({ committee, committeeType, cents, count }) => {
    if (cents < 0) throw new Error(`Negative West Virginia committee donor total for ${committee.entityId}`);
    if (cents === 0) return [];
    return [{ committeeId: committee.entityId, committeeName: committee.orgName!, committeeType, totalAmount: cents / 100, contributionCount: count, sourceUrl: "https://cfrs.wvsos.gov/" }];
  }).sort((left, right) => right.totalAmount - left.totalAmount || left.committeeId.localeCompare(right.committeeId));
}

export function aggregateWestVirginiaDirectFinance(input: {
  entityId: string;
  window: Pick<WestVirginiaCycleWindow, "windowStart" | "windowEnd">;
  contributionRows: readonly WestVirginiaContributionCsvRow[];
  expenditureRows: readonly WestVirginiaExpenditureCsvRow[];
  apiRows: readonly WestVirginiaTransactionRow[];
  maxOccupationBreakdowns?: number;
  committeeRegistryRows?: readonly WestVirginiaCommitteeRow[];
}): WestVirginiaDirectFinanceAggregationResult {
  const maxOccupationBreakdowns = input.maxOccupationBreakdowns ?? 50;
  let totalReceiptsCents = 0;
  let directContributionCents = 0;
  let returnedContributionCents = 0;
  let selfFundingCents = 0;
  let otherIncomeCents = 0;
  let transferInCents = 0;
  let totalDisbursementsCents = 0;
  let returnedExpenditureCents = 0;
  let contributionRowCount = 0;
  let expenditureRowCount = 0;
  let apiDonationRowCount = 0;
  let employerRedactedRowCount = 0;
  const unrecognizedContributionCategories = new Set<string>();
  const unrecognizedContributorTypes = new Set<string>();
  const unrecognizedExpenditureTypes = new Set<string>();
  const bucketTotals: Totals = new Map();
  const occupationTotals: Totals = new Map();
  const industryTotals: Totals = new Map();

  for (const row of input.contributionRows) {
    if (row.registrantId !== input.entityId || !isWestVirginiaDateInWindow(row.transactionDate, input.window)) {
      continue;
    }
    contributionRowCount += 1;
    const cents = row.amountCents;
    const category = row.transactionCategory;
    const contributorType = row.contributorType;
    const isDonor = DONOR_CONTRIBUTOR_TYPES.has(contributorType);
    const isSelf = SELF_CONTRIBUTOR_TYPES.has(contributorType);

    if (category === CATEGORY_OTHER_INCOME) {
      totalReceiptsCents += cents;
      otherIncomeCents += cents;
      continue;
    }
    if (category === CATEGORY_TRANSFER_IN) {
      totalReceiptsCents += cents;
      transferInCents += cents;
      continue;
    }
    if (category === CATEGORY_RETURN) {
      if (!isDonor && !isSelf) {
        unrecognizedContributorTypes.add(contributorType);
        continue;
      }
      totalReceiptsCents -= cents;
      if (isDonor) {
        directContributionCents -= cents;
        returnedContributionCents += cents;
      } else {
        selfFundingCents -= cents;
      }
      continue;
    }
    if (category !== CATEGORY_MONETARY && category !== CATEGORY_IN_KIND) {
      unrecognizedContributionCategories.add(category);
      continue;
    }
    if (!isDonor && !isSelf) {
      unrecognizedContributorTypes.add(contributorType);
      continue;
    }
    totalReceiptsCents += cents;
    if (isSelf) {
      selfFundingCents += cents;
      continue;
    }
    directContributionCents += cents;
    if (contributorType !== CONTRIBUTOR_TYPE_INDIVIDUAL || cents <= 0) {
      continue;
    }
    const contributorKey = row.contributorName.toUpperCase();
    if (category === CATEGORY_MONETARY) {
      add(bucketTotals, sizeBucket(cents), cents, contributorKey);
    }
    if (row.employerName === null || row.recovered) {
      continue;
    }
    if (row.filedDate >= WEST_VIRGINIA_EMPLOYER_REDACTION_FILED_DATE) {
      employerRedactedRowCount += 1;
      continue;
    }
    const industry = classifyFinanceLabel({ rawLabel: row.employerName, labelType: "employer" }).industrySlug;
    if (industry !== null) {
      add(industryTotals, industry, cents, contributorKey);
    }
  }

  for (const row of input.expenditureRows) {
    if (row.registrantId !== input.entityId || !isWestVirginiaDateInWindow(row.transactionDate, input.window)) {
      continue;
    }
    expenditureRowCount += 1;
    if (row.expenditureType === EXPENDITURE_TYPE_MONETARY || row.expenditureType === EXPENDITURE_TYPE_DISBURSEMENT_OF_EXCESS_FUNDS) {
      totalDisbursementsCents += row.amountCents;
    } else if (row.expenditureType === EXPENDITURE_TYPE_RETURN) {
      totalDisbursementsCents -= row.amountCents;
      returnedExpenditureCents += row.amountCents;
    } else {
      unrecognizedExpenditureTypes.add(row.expenditureType);
    }
  }

  for (const row of input.apiRows) {
    if (
      row.entityID !== input.entityId ||
      row.entityTypeDesc !== CONTRIBUTOR_TYPE_INDIVIDUAL ||
      row.transactionCategoryDesc === null ||
      !WEST_VIRGINIA_DIRECT_DONATION_CATEGORIES.has(row.transactionCategoryDesc) ||
      !isWestVirginiaDateInWindow(row.transactionDate, input.window)
    ) {
      continue;
    }
    const cents = apiAmountToCents(row.transactionAmount);
    if (cents <= 0) {
      continue;
    }
    apiDonationRowCount += 1;
    const occupation = normalizeWestVirginiaOccupationLabel(row.employerOccupation);
    if (occupation === null) {
      continue;
    }
    add(occupationTotals, occupation, cents, (row.contributorPayeeName ?? `#${row.transactionID}`).toUpperCase());
  }

  const breakdowns: WestVirginiaFinanceDirectBreakdown[] = [];
  const push = (categoryType: WestVirginiaFinanceDirectBreakdown["categoryType"], totals: Totals, limit?: number) => {
    for (const [name, entry] of sorted(totals).slice(0, limit)) {
      breakdowns.push({ categoryType, categoryName: name, amount: entry.cents / 100, contributorCount: entry.contributors.size });
    }
  };
  push("occupation", occupationTotals, maxOccupationBreakdowns);
  push("industry", industryTotals);
  push("contribution_size", bucketTotals);

  return {
    ...(input.committeeRegistryRows === undefined ? {} : { pacDonors: aggregateCommitteeDonors({ ...input, committeeRegistryRows: input.committeeRegistryRows }) }),
    totalReceiptsCents,
    directContributionCents,
    returnedContributionCents,
    selfFundingCents,
    otherIncomeCents,
    transferInCents,
    totalDisbursementsCents,
    returnedExpenditureCents,
    contributionRowCount,
    expenditureRowCount,
    apiDonationRowCount,
    employerRedactedRowCount,
    unrecognizedContributionCategories: [...unrecognizedContributionCategories].sort(),
    unrecognizedContributorTypes: [...unrecognizedContributorTypes].sort(),
    unrecognizedExpenditureTypes: [...unrecognizedExpenditureTypes].sort(),
    breakdowns,
  };
}
