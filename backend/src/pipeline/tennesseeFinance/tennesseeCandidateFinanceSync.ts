import type { Pool, PoolClient } from "pg";

import {
  classifyFinanceLabel,
  normalizeFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import {
  aggregateTennesseeDirectContributions,
  type TennesseeDirectContributionAggregationResult,
} from "./tennesseeDirectContributionAggregator.js";
import {
  aggregateTennesseeOutsideGroupContributions,
  type TennesseeFinanceOutsideGroupBreakdown,
} from "./tennesseeOutsideGroupContributionAggregator.js";
import {
  aggregateTennesseeOutsideSpending,
  type TennesseeOutsideSpendingAggregationResult,
} from "./tennesseeOutsideSpendingAggregator.js";
import type { TennesseeCampContributionRecord, TennesseeCampExpenditureRecord } from "./tennesseeCampClient.js";
import {
  recordTennesseeCandidateFinanceSyncAttempt,
  replaceTennesseeCandidateFinanceSnapshot,
  type TennesseeFinanceLinkInput,
  type TennesseeFinanceLinkSource,
  type TennesseeFinanceOutsideGroupBreakdownInput,
  type TennesseeFinanceOutsideGroupInput,
  type TennesseeVerifiedFinanceSnapshot,
} from "./tennesseeFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TennesseeCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  campCandidateId: string;
  ownerName: string;
  committeeName?: string | null;
  linkSource?: TennesseeFinanceLinkSource;
  sourceUrl?: string | null;
  reportListUrl?: string | null;
  contributions?: readonly TennesseeCampContributionRecord[];
  verifiedFinance?: TennesseeVerifiedFinanceSnapshot;
  contributionSourceUrl?: string | null;
  expenditures?: readonly TennesseeCampExpenditureRecord[];
  expenditureSourceUrl?: string | null;
  outsideGroupContributionRecords?: readonly TennesseeCampContributionRecord[];
  outsideContributionSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  // Display cap on persisted label rows per (committee, direction,
  // category); classification always sees every donor/employer.
  outsideMaxBreakdownsPerCategory?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
};

export type TennesseeCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
  matchedExpenditureRowCount: number;
  includedExpenditureRowCount: number;
  skippedExpenditureRowCount: number;
  matchedOutsideContributionRowCount: number;
  includedOutsideContributionRowCount: number;
  skippedOutsideContributionRowCount: number;
  outsideGroupCount: number;
  pacDonorsWritten?: number;
  sourceVerificationDiagnostics?: readonly string[];
  outsideEvidenceAccepted?: boolean;
};

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
// Every donor/employer label is rule-classified regardless of size
// (maryland/ohio parity). Static rules are free, so the AI amount floor
// (aiClassificationMinAmount) must not gate them — otherwise many small
// same-industry donors sum to a large industry total that never gets
// counted.
const STATE_MIN_OUTSIDE_INDUSTRY_AMOUNT = 0;
// Display cap on PERSISTED label rows per (committee, direction, category),
// applied AFTER classification so a >cap-label group still gets industry
// totals built from every donor/employer. Industry rows are naturally
// bounded by the slug set and are never capped.
const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 20;
const DEFAULT_OUTSIDE_MAX_GROUPS = 20;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Tennessee finance election year: ${value}`);
  }
  return value;
}

function normalizeCandidateNameForStorage(value: string): string {
  return requireNonEmpty(value, "candidate name").replace(/\s+/g, " ").toUpperCase();
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Tennessee finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid Tennessee finance AI classification minimum amount: ${value}`);
  }
  return normalized;
}

function normalizeMaxBreakdownsPerCategory(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Tennessee finance outsideMaxBreakdownsPerCategory: ${value}`);
  }
  return normalized;
}

function capLabelBreakdowns(
  breakdowns: readonly TennesseeFinanceOutsideGroupBreakdownInput[],
  maxLabelsPerCategory: number
): TennesseeFinanceOutsideGroupBreakdownInput[] {
  const labelsByCategoryGroup = new Map<string, TennesseeFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType === "industry") {
      continue;
    }
    const key = [breakdown.committeeKey.trim().toUpperCase(), breakdown.supportOppose, breakdown.categoryType].join(
      "\u0000"
    );
    const list = labelsByCategoryGroup.get(key) ?? [];
    list.push(breakdown);
    labelsByCategoryGroup.set(key, list);
  }
  const kept = new Set<TennesseeFinanceOutsideGroupBreakdownInput>();
  for (const list of labelsByCategoryGroup.values()) {
    for (const label of list
      .sort((left, right) => right.amount - left.amount || left.categoryName.localeCompare(right.categoryName))
      .slice(0, maxLabelsPerCategory)) {
      kept.add(label);
    }
  }
  return breakdowns.filter((breakdown) => breakdown.categoryType === "industry" || kept.has(breakdown));
}

function toFinanceLink(input: TennesseeCandidateFinanceSyncInput & {
  electionYear: number;
  now: Date;
}): TennesseeFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    campCandidateId: requireNonEmpty(input.campCandidateId, "Tennessee CAMP candidate id"),
    ownerName: requireNonEmpty(input.ownerName, "Tennessee CAMP owner name"),
    committeeName: input.committeeName ?? null,
    linkSource: input.linkSource ?? "manual",
    sourceUrl: input.sourceUrl ?? null,
    reportListUrl: input.reportListUrl ?? null,
    lastVerifiedAt: input.now,
  };
}

function aggregateDirect(input: {
  ownerName: string;
  candidateName: string;
  electionYear: number;
  contributions: readonly TennesseeCampContributionRecord[];
  contributionSourceUrl: string | null | undefined;
  linkSourceUrl: string | null | undefined;
  maxBreakdownsPerCategory: number | undefined;
}): TennesseeDirectContributionAggregationResult {
  return aggregateTennesseeDirectContributions({
    candidate: {
      ownerName: input.ownerName,
      candidateName: input.candidateName,
    },
    electionYear: input.electionYear,
    contributions: input.contributions,
    sourceUrl: input.contributionSourceUrl ?? input.linkSourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
  });
}

function aggregateOutside(input: {
  ownerName: string;
  candidateName: string;
  electionYear: number;
  expenditures: readonly TennesseeCampExpenditureRecord[];
  expenditureSourceUrl: string | null | undefined;
  linkSourceUrl: string | null | undefined;
  maxGroups: number | undefined;
}): TennesseeOutsideSpendingAggregationResult {
  return aggregateTennesseeOutsideSpending({
    candidateName: input.candidateName,
    ownerName: input.ownerName,
    electionYear: input.electionYear,
    expenditureRecords: input.expenditures,
    sourceUrl: input.expenditureSourceUrl ?? input.linkSourceUrl ?? null,
    maxGroups: input.maxGroups,
  });
}

function toOutsideGroups(
  groups: NonNullable<TennesseeOutsideSpendingAggregationResult["summary"]>["groups"]
): TennesseeFinanceOutsideGroupInput[] {
  return groups.map((group) => ({
    committeeKey: group.committeeKey,
    committeeName: group.committeeName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    expenditureCount: group.expenditureCount,
    sourceUrl: group.sourceUrl,
  }));
}

function outsideBreakdownKey(input: TennesseeFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor" || input.categoryType === "employer"
      ? normalizeFinanceLabel(input.categoryName, input.categoryType)
      : input.categoryName.trim().toUpperCase();
  return `${input.committeeKey.trim().toUpperCase()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, TennesseeFinanceOutsideGroupBreakdownInput>,
  breakdown: TennesseeFinanceOutsideGroupBreakdownInput
): void {
  const key = outsideBreakdownKey(breakdown);
  const existing = breakdowns.get(key);
  if (!existing) {
    breakdowns.set(key, breakdown);
    return;
  }
  breakdowns.set(key, {
    ...existing,
    amount: Math.round((existing.amount + breakdown.amount) * 100) / 100,
    contributorCount:
      existing.contributorCount === null ||
      existing.contributorCount === undefined ||
      breakdown.contributorCount === null ||
      breakdown.contributorCount === undefined
        ? existing.contributorCount ?? breakdown.contributorCount ?? null
        : existing.contributorCount + breakdown.contributorCount,
    sourceUrl: existing.sourceUrl ?? breakdown.sourceUrl,
  });
}

function toWriterOutsideBreakdown(
  breakdown: TennesseeFinanceOutsideGroupBreakdown
): TennesseeFinanceOutsideGroupBreakdownInput {
  return {
    committeeKey: breakdown.committeeKey,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  };
}

function collectOutsideClassifications(
  breakdowns: Iterable<TennesseeFinanceOutsideGroupBreakdownInput>,
  minAmount: number
): Map<string, FinanceLabelClassification> {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of breakdowns) {
    if ((breakdown.categoryType !== "donor" && breakdown.categoryType !== "employer") || breakdown.amount < minAmount) {
      continue;
    }
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: breakdown.categoryName, labelType: breakdown.categoryType })
    );
  }
  return classifications;
}

function asClassifiableOutsideBreakdowns(breakdowns: Iterable<TennesseeFinanceOutsideGroupBreakdownInput>) {
  return [...breakdowns].map((breakdown) => ({
    committeeId: breakdown.committeeKey,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  }));
}

async function enrichOutsideGroupIndustryBreakdowns(input: {
  db: Queryable;
  outsideGroupBreakdowns: readonly TennesseeFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  maxBreakdownsPerCategory: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: TennesseeFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = new Map<string, TennesseeFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of input.outsideGroupBreakdowns) {
    if (breakdown.categoryType !== "industry") {
      addOutsideBreakdown(breakdowns, breakdown);
    }
  }

  const classifiableOutsideBreakdowns = asClassifiableOutsideBreakdowns(breakdowns.values());
  // Rule classification at the state floor (0) — only the AI call below
  // keeps the aiClassificationMinAmount gate.
  const classifications = collectOutsideClassifications(breakdowns.values(), STATE_MIN_OUTSIDE_INDUSTRY_AMOUNT);
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: [],
    outsideBreakdowns: classifiableOutsideBreakdowns,
    classifications,
    classifier: input.classifier,
    minAmount: input.aiClassificationMinAmount,
    dryRun: input.dryRun,
  });

  const industryBreakdowns = buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: [],
    outsideBreakdowns: classifiableOutsideBreakdowns,
    classifications,
  });
  for (const breakdown of industryBreakdowns.outsideIndustryBreakdowns) {
    addOutsideBreakdown(breakdowns, {
      committeeKey: breakdown.committeeId,
      supportOppose: breakdown.supportOppose,
      categoryType: "industry",
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    });
  }

  return {
    // Capped only HERE, after every label fed the classifications and the
    // rebuilt industry rows above.
    outsideGroupBreakdowns: capLabelBreakdowns([...breakdowns.values()], input.maxBreakdownsPerCategory),
    classifications: [...classifications.values()],
  };
}

export async function syncTennesseeCandidateFinance(
  input: TennesseeCandidateFinanceSyncInput
): Promise<TennesseeCandidateFinanceSyncResult> {
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const dryRun = input.dryRun === true;
  const link = toFinanceLink({ ...input, electionYear, now: syncedAt });
  if (input.verifiedFinance) {
    if (input.contributions !== undefined || input.expenditures !== undefined || input.outsideGroupContributionRecords !== undefined) {
      throw new Error("Tennessee verified finance cannot mix with legacy discovery records");
    }
    const snapshot = input.verifiedFinance;
    const hasAccepted = snapshot.summary !== undefined || snapshot.directBreakdowns !== undefined
      || snapshot.pacDonors !== undefined || Boolean(snapshot.outsideReportEvidence?.verifiedReports.length);
    const classifications = new Map<string, FinanceLabelClassification>();
    for (const donor of snapshot.pacDonors ?? []) {
      const classification = classifyFinanceLabel({ rawLabel: donor.committeeName,labelType: "committee" });
      classifications.set(classification.normalizedLabel,classification);
    }
    const write = !dryRun && hasAccepted ? await replaceTennesseeCandidateFinanceSnapshot({
      ...snapshot,db:input.db,link,syncedAt,classifications: [...classifications.values()] }) : undefined;
    if (!dryRun && !hasAccepted) await recordTennesseeCandidateFinanceSyncAttempt({ db: input.db,link,syncedAt });
    return { candidateId: link.candidateId,electionId: link.electionId,electionYear,dryRun,
      linkWritten: Boolean(write),summaryWritten: write?.summaryWritten ?? false,
      directBreakdownsWritten: write?.directBreakdownsWritten ?? 0,outsideGroupsWritten: write?.outsideGroupsWritten ?? 0,
      outsideGroupBreakdownsWritten: 0,pacDonorsWritten: write?.pacDonorsWritten ?? 0,
      totalReceipts: snapshot.summary?.totalReceipts ?? null,directContributionTotal: snapshot.summary?.directContributionTotal ?? null,
      outsideSupportTotal: write?.outsideSupportTotal ?? null,outsideOpposeTotal: write?.outsideOpposeTotal ?? null,
      matchedContributionRowCount: snapshot.pacSourceProvenance?.receipts.length ?? 0,
      includedContributionRowCount: snapshot.pacSourceProvenance?.receipts.length ?? 0,skippedContributionRowCount: 0,
      matchedExpenditureRowCount: snapshot.outsideReportEvidence?.verifiedReports.reduce((sum, report) => sum + report.occurrences.length,0) ?? 0,
      includedExpenditureRowCount: snapshot.outsideReportEvidence?.verifiedReports.reduce((sum, report) => sum + report.occurrences.length,0) ?? 0,
      skippedExpenditureRowCount: 0,matchedOutsideContributionRowCount: 0,includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,outsideGroupCount: write?.outsideGroupsWritten ?? 0,
      sourceVerificationDiagnostics: [...snapshot.diagnostics,...(write?.outsideEvidenceDiagnostics ?? [])],
      ...(write?.outsideEvidenceAccepted === undefined ? {} : { outsideEvidenceAccepted: write.outsideEvidenceAccepted }) };
  }
  if (input.contributions === undefined) throw new Error("Tennessee finance requires verified evidence or contribution records");
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);
  const directFinance = aggregateDirect({
    ownerName: link.ownerName,
    candidateName: input.candidateName,
    electionYear,
    contributions: input.contributions,
    contributionSourceUrl: input.contributionSourceUrl,
    linkSourceUrl: link.sourceUrl,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const outsideFinance = aggregateOutside({
    ownerName: link.ownerName,
    candidateName: input.candidateName,
    electionYear,
    expenditures: input.expenditures ?? [],
    expenditureSourceUrl: input.expenditureSourceUrl,
    linkSourceUrl: link.sourceUrl,
    maxGroups: input.outsideMaxGroups ?? DEFAULT_OUTSIDE_MAX_GROUPS,
  });
  // Discovery absence cannot prove a complete candidate outside zero.
  const outsideGroups = outsideFinance.summary ? toOutsideGroups(outsideFinance.summary.groups) : undefined;
  const rawOutsideGroupBreakdowns = outsideGroups && input.outsideGroupContributionRecords
    ? aggregateTennesseeOutsideGroupContributions({
        electionYear,
        outsideGroups: outsideFinance.summary?.groups ?? [],
        contributionRecords: input.outsideGroupContributionRecords,
        sourceUrl: input.outsideContributionSourceUrl ?? input.contributionSourceUrl ?? link.sourceUrl ?? null,
        minIndustryAmount: STATE_MIN_OUTSIDE_INDUSTRY_AMOUNT,
      })
    : null;
  const outsideGroupBreakdowns = rawOutsideGroupBreakdowns
    ? rawOutsideGroupBreakdowns.outsideGroupBreakdowns.map(toWriterOutsideBreakdown)
    : undefined;
  const outsideIndustryFinance = await enrichOutsideGroupIndustryBreakdowns({
    db: input.db,
    outsideGroupBreakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    maxBreakdownsPerCategory: normalizeMaxBreakdownsPerCategory(input.outsideMaxBreakdownsPerCategory),
    dryRun,
  });

  if (!dryRun) {
    await replaceTennesseeCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary: {
        ...directFinance.summary,
        outsideSupportTotal: outsideFinance.summary?.supportTotal,
        outsideOpposeTotal: outsideFinance.summary?.opposeTotal,
        sourceUrl: directFinance.summary.sourceUrl ?? outsideFinance.summary?.sourceUrl ?? null,
      },
      directBreakdowns: directFinance.directBreakdowns,
      outsideGroups,
      outsideGroupBreakdowns: outsideIndustryFinance.outsideGroupBreakdowns,
      classifications: outsideIndustryFinance.classifications,
    });
  }

  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear,
    dryRun,
    linkWritten: !dryRun,
    summaryWritten: !dryRun,
    directBreakdownsWritten: dryRun ? 0 : directFinance.directBreakdowns.length,
    outsideGroupsWritten: dryRun ? 0 : (outsideGroups?.length ?? 0),
    outsideGroupBreakdownsWritten: dryRun ? 0 : (outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0),
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: outsideFinance.summary?.supportTotal ?? null,
    outsideOpposeTotal: outsideFinance.summary?.opposeTotal ?? null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionRowCount: directFinance.includedContributionRowCount,
    skippedContributionRowCount: directFinance.skippedContributionRowCount,
    matchedExpenditureRowCount: outsideFinance.matchedExpenditureRowCount,
    includedExpenditureRowCount: outsideFinance.includedExpenditureRowCount,
    skippedExpenditureRowCount: outsideFinance.skippedExpenditureRowCount,
    matchedOutsideContributionRowCount: rawOutsideGroupBreakdowns?.matchedContributionRowCount ?? 0,
    includedOutsideContributionRowCount: rawOutsideGroupBreakdowns?.includedContributionRowCount ?? 0,
    skippedOutsideContributionRowCount: rawOutsideGroupBreakdowns?.skippedContributionRowCount ?? 0,
    outsideGroupCount: outsideGroups?.length ?? 0,
  };
}
