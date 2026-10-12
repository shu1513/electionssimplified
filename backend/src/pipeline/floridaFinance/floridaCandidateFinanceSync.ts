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
import type { FloridaContributionRow } from "./floridaCampaignFinanceRows.js";
import type { FloridaCommitteeDonorFinanceInput } from "./floridaCommitteeDonorWriter.js";
import {
  aggregateFloridaDirectContributions,
  type FloridaDirectContributionAggregationResult,
} from "./floridaDirectContributionAggregator.js";
import {
  aggregateFloridaOutsideGroupContributions,
  type FloridaFinanceOutsideGroupBreakdown,
  type FloridaOutsideFinanceGroup,
  type FloridaSupportOppose,
} from "./floridaOutsideGroupContributionAggregator.js";
import {
  listFloridaOutsideGroupSupportLinks,
  replaceFloridaCandidateFinanceSnapshot,
  type FloridaFinanceDirectBreakdownInput,
  type FloridaFinanceLinkInput,
  type FloridaFinanceLinkSource,
  type FloridaFinanceOutsideGroupBreakdownInput,
  type FloridaFinanceOutsideGroupInput,
  type FloridaFinanceSummaryInput,
  type FloridaFinanceSnapshotWriteResult,
  type FloridaOutsideGroupSupportLinkInput,
  type FloridaOutsideGroupSupportLinkRow,
} from "./floridaFinanceWriter.js";
import {
  resolveFloridaOutsideGroupSupport,
  type FloridaOutsideGroupSupportEvidenceInput,
} from "./floridaOutsideGroupSupportResolver.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
// Display cap on PERSISTED donor rows per (committee, direction), applied
// AFTER classification so a >cap-donor group still gets industry totals
// built from every donor. Industry rows are naturally bounded by the slug
// set and are never capped.
const DEFAULT_MAX_DONOR_BREAKDOWNS_PER_GROUP = 50;

export type FloridaCandidateFinanceTrustedCommittee = {
  committeeId: string;
  committeeName: string;
  recipientNames?: readonly string[];
  sourceUrl?: string | null;
};

export type FloridaCandidateFinanceTrustedOutsideGroup = {
  committeeId: string;
  committeeName: string;
  supportOppose: FloridaSupportOppose;
  amount: number;
  sourceUrl?: string | null;
  committeeNames?: readonly string[];
};

export type FloridaCandidateFinanceCommitteeResolution = {
  status: "matched";
  committeeId: string;
  committeeName: string;
  recipientNames: string[];
  confidence: "exact";
  source: "manual" | "dos_export";
  sourceUrl: string | null;
};

export type FloridaCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  candidateElectionId?: string | null;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  trustedCommittee: FloridaCandidateFinanceTrustedCommittee;
  contributionRows: readonly FloridaContributionRow[];
  pacFinance?: FloridaCommitteeDonorFinanceInput;
  trustedOutsideGroups?: readonly FloridaCandidateFinanceTrustedOutsideGroup[];
  outsideGroupSupportEvidence?: readonly FloridaOutsideGroupSupportEvidenceInput[];
  // Outside-group finance is opt-in until Florida support/IE discovery is reliable enough for scheduled syncs.
  includeOutsideGroupFinance?: boolean;
  includeStoredOutsideGroupSupportEvidence?: boolean;
  includeOutsideGroupNameHeuristics?: boolean;
  outsideContributionRows?: readonly FloridaContributionRow[];
  sourceUrl?: string | null;
  contributionSourceUrl?: string | null;
  outsideSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  linkSource?: FloridaFinanceLinkSource;
  directMaxBreakdownsPerCategory?: number;
  // Display cap on persisted donor rows per (committee, direction);
  // classification always sees every donor.
  outsideMaxBreakdownsPerCategory?: number;
  outsideMinIndustryAmount?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
};

export type FloridaCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: FloridaCandidateFinanceCommitteeResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  outsideGroupSupportLinksWritten: number;
  resolvedOutsideGroupCount: number;
  outsideGroupSupportEvidenceCount: number;
  heuristicOutsideGroupCount: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
  matchedOutsideContributionRowCount: number;
  includedOutsideContributionRowCount: number;
  skippedOutsideContributionRowCount: number;
  pacDonorsWritten?: number;
  netCommitteeAmount?: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 1996 || value > 2100) {
    throw new Error(`Invalid Florida finance election year: ${value}`);
  }
  return value;
}

function normalizeCandidateNameForStorage(value: string): string {
  return requireNonEmpty(value, "candidate name")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Florida finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid Florida finance AI classification minimum amount: ${value}`);
  }
  return normalized;
}

function normalizeMaxDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_DONOR_BREAKDOWNS_PER_GROUP;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Florida finance outsideMaxBreakdownsPerCategory: ${value}`);
  }
  return normalized;
}

function normalizeAmount(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a nonnegative number`);
  }
  return value;
}

function normalizeOptionalIdentifier(value: string | null | undefined, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function supportEvidenceFromStoredLink(
  link: FloridaOutsideGroupSupportLinkRow
): FloridaOutsideGroupSupportEvidenceInput {
  return {
    candidateElectionId: link.candidateElectionId,
    committeeId: link.committeeId,
    committeeName: link.committeeName,
    supportOppose: link.supportOppose,
    confidence: link.confidence,
    amount: link.amount,
    evidenceUrl: link.evidenceUrl,
    evidenceNote: link.evidenceNote,
    linkSource: link.linkSource,
  };
}

function supportLinkInputFromEvidence(input: {
  evidence: FloridaOutsideGroupSupportEvidenceInput;
  fallbackCandidateElectionId: string | null;
}): FloridaOutsideGroupSupportLinkInput {
  const candidateElectionId =
    normalizeOptionalIdentifier(input.evidence.candidateElectionId, "candidate election id") ??
    input.fallbackCandidateElectionId;
  if (!candidateElectionId) {
    throw new Error("candidate election id is required for Florida outside group support evidence");
  }
  return {
    candidateElectionId,
    committeeId: input.evidence.committeeId,
    committeeName: input.evidence.committeeName,
    supportOppose: input.evidence.supportOppose,
    confidence: input.evidence.confidence,
    amount: input.evidence.amount,
    evidenceUrl: input.evidence.evidenceUrl,
    evidenceNote: input.evidence.evidenceNote,
    linkSource: input.evidence.linkSource,
  };
}

function resolveTrustedCommittee(input: {
  trustedCommittee: FloridaCandidateFinanceTrustedCommittee;
  linkSource: FloridaFinanceLinkSource;
}): FloridaCandidateFinanceCommitteeResolution {
  const committeeId = requireNonEmpty(input.trustedCommittee.committeeId, "trusted Florida committee id");
  const committeeName = requireNonEmpty(input.trustedCommittee.committeeName, "trusted Florida committee name");
  const recipientNames = [
    ...new Set(
      [committeeName, ...(input.trustedCommittee.recipientNames ?? [])]
        .map((name) => name.trim().replace(/\s+/g, " "))
        .filter(Boolean)
    ),
  ];
  return {
    status: "matched",
    committeeId,
    committeeName,
    recipientNames,
    confidence: "exact",
    source: input.linkSource,
    sourceUrl: input.trustedCommittee.sourceUrl ?? null,
  };
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  resolution: FloridaCandidateFinanceCommitteeResolution;
  sourceUrl?: string | null;
  verifiedAt: Date;
  linkSource: FloridaFinanceLinkSource;
}): FloridaFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.resolution.committeeId, "Florida committee id"),
    committeeName: requireNonEmpty(input.resolution.committeeName, "Florida committee name"),
    linkStatus: "active",
    linkSource: input.linkSource,
    sourceUrl: input.resolution.sourceUrl ?? input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function toDirectBreakdowns(
  breakdowns: FloridaDirectContributionAggregationResult["directBreakdowns"]
): FloridaFinanceDirectBreakdownInput[] {
  return breakdowns.map((breakdown) => ({
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  }));
}

function toOutsideGroups(
  groups: readonly FloridaCandidateFinanceTrustedOutsideGroup[] | undefined
): FloridaFinanceOutsideGroupInput[] | undefined {
  return groups?.map((group) => ({
    committeeId: requireNonEmpty(group.committeeId, "trusted Florida outside group committee id"),
    committeeName: requireNonEmpty(group.committeeName, "trusted Florida outside group committee name"),
    supportOppose: group.supportOppose,
    amount: normalizeAmount(group.amount, "outside group amount"),
    sourceUrl: group.sourceUrl ?? null,
  }));
}

function toAggregatorOutsideGroups(
  groups: readonly FloridaCandidateFinanceTrustedOutsideGroup[]
): FloridaOutsideFinanceGroup[] {
  return groups.map((group) => ({
    committeeId: requireNonEmpty(group.committeeId, "trusted Florida outside group committee id"),
    committeeName: requireNonEmpty(group.committeeName, "trusted Florida outside group committee name"),
    supportOppose: group.supportOppose,
    amount: normalizeAmount(group.amount, "outside group amount"),
    sourceUrl: group.sourceUrl ?? null,
    committeeNames: group.committeeNames,
  }));
}

function sumOutsideGroups(input: {
  groups: readonly FloridaCandidateFinanceTrustedOutsideGroup[] | undefined;
  supportOppose: FloridaSupportOppose;
}): number | null {
  if (!input.groups) {
    return null;
  }
  const amount = input.groups
    .filter((group) => group.supportOppose === input.supportOppose)
    .reduce((sum, group) => sum + normalizeAmount(group.amount, "outside group amount"), 0);
  return Math.round(amount * 100) / 100;
}

function toSummary(input: {
  directFinance: FloridaDirectContributionAggregationResult;
  trustedOutsideGroups: readonly FloridaCandidateFinanceTrustedOutsideGroup[] | undefined;
  fallbackSourceUrl?: string | null;
}): FloridaFinanceSummaryInput {
  return {
    totalReceipts: input.directFinance.summary.totalReceipts,
    directContributionTotal: input.directFinance.summary.directContributionTotal,
    outsideSupportTotal: sumOutsideGroups({ groups: input.trustedOutsideGroups, supportOppose: "support" }),
    outsideOpposeTotal: sumOutsideGroups({ groups: input.trustedOutsideGroups, supportOppose: "oppose" }),
    sourceUrl: input.directFinance.summary.sourceUrl ?? input.fallbackSourceUrl ?? null,
  };
}

function toWriterOutsideBreakdown(
  breakdown: FloridaFinanceOutsideGroupBreakdown
): FloridaFinanceOutsideGroupBreakdownInput {
  return {
    committeeId: breakdown.committeeId,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  };
}

function outsideBreakdownKey(input: FloridaFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${input.committeeId.trim().toUpperCase()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, FloridaFinanceOutsideGroupBreakdownInput>,
  breakdown: FloridaFinanceOutsideGroupBreakdownInput
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

function collectOutsideClassifications(
  breakdowns: Iterable<FloridaFinanceOutsideGroupBreakdownInput>,
  minAmount: number
): Map<string, FinanceLabelClassification> {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor" || breakdown.amount < minAmount) {
      continue;
    }
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: breakdown.categoryName, labelType: "donor" })
    );
  }
  return classifications;
}

function capDonorBreakdowns(
  breakdowns: readonly FloridaFinanceOutsideGroupBreakdownInput[],
  maxDonorsPerGroup: number
): FloridaFinanceOutsideGroupBreakdownInput[] {
  const donorsByGroup = new Map<string, FloridaFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    const key = `${breakdown.committeeId.trim().toUpperCase()}\u0000${breakdown.supportOppose}`;
    const list = donorsByGroup.get(key) ?? [];
    list.push(breakdown);
    donorsByGroup.set(key, list);
  }
  const kept = new Set<FloridaFinanceOutsideGroupBreakdownInput>();
  for (const list of donorsByGroup.values()) {
    for (const donor of list
      .sort((left, right) => right.amount - left.amount || left.categoryName.localeCompare(right.categoryName))
      .slice(0, maxDonorsPerGroup)) {
      kept.add(donor);
    }
  }
  return breakdowns.filter((breakdown) => breakdown.categoryType !== "donor" || kept.has(breakdown));
}

async function enrichOutsideGroupIndustryBreakdowns(input: {
  db: Queryable;
  outsideGroupBreakdowns: readonly FloridaFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  maxDonorBreakdownsPerGroup: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: FloridaFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = new Map<string, FloridaFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of input.outsideGroupBreakdowns) {
    if (breakdown.categoryType !== "industry") {
      addOutsideBreakdown(breakdowns, breakdown);
    }
  }

  const classifications = collectOutsideClassifications(breakdowns.values(), input.aiClassificationMinAmount);
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: [],
    outsideBreakdowns: breakdowns.values(),
    classifications,
    classifier: input.classifier,
    minAmount: input.aiClassificationMinAmount,
    dryRun: input.dryRun,
  });

  const industryBreakdowns = buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: [],
    outsideBreakdowns: breakdowns.values(),
    classifications,
  });
  for (const breakdown of industryBreakdowns.outsideIndustryBreakdowns) {
    addOutsideBreakdown(breakdowns, {
      committeeId: breakdown.committeeId,
      supportOppose: breakdown.supportOppose,
      categoryType: "industry",
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    });
  }

  return {
    // Capped only HERE, after every donor fed the classifications and the
    // rebuilt industry rows above.
    outsideGroupBreakdowns: capDonorBreakdowns([...breakdowns.values()], input.maxDonorBreakdownsPerGroup),
    classifications: [...classifications.values()],
  };
}

function aggregateOutsideBreakdowns(input: {
  trustedOutsideGroups: readonly FloridaCandidateFinanceTrustedOutsideGroup[] | undefined;
  outsideContributionRows: readonly FloridaContributionRow[] | undefined;
  electionYear: number;
  sourceUrl?: string | null;
  minIndustryAmount?: number;
}): {
  breakdowns: FloridaFinanceOutsideGroupBreakdownInput[] | undefined;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
} {
  if (!input.trustedOutsideGroups || !input.outsideContributionRows) {
    return {
      breakdowns: undefined,
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
    };
  }

  const result = aggregateFloridaOutsideGroupContributions({
    electionYear: input.electionYear,
    outsideGroups: toAggregatorOutsideGroups(input.trustedOutsideGroups),
    contributionRows: input.outsideContributionRows,
    sourceUrl: input.sourceUrl ?? null,
    minIndustryAmount: input.minIndustryAmount,
  });

  return {
    breakdowns: result.outsideGroupBreakdowns.map(toWriterOutsideBreakdown),
    matchedContributionRowCount: result.matchedContributionRowCount,
    includedContributionRowCount: result.includedContributionRowCount,
    skippedContributionRowCount: result.skippedContributionRowCount,
  };
}

export async function syncFloridaCandidateFinance(
  input: FloridaCandidateFinanceSyncInput
): Promise<FloridaCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const candidateElectionId = normalizeOptionalIdentifier(input.candidateElectionId, "candidate election id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const linkSource = input.linkSource ?? "dos_export";
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);
  const resolution = resolveTrustedCommittee({ trustedCommittee: input.trustedCommittee, linkSource });
  const hasExplicitOutsideGroupInputs =
    input.trustedOutsideGroups !== undefined ||
    input.outsideGroupSupportEvidence !== undefined ||
    input.includeStoredOutsideGroupSupportEvidence === true ||
    input.includeOutsideGroupNameHeuristics === true;
  const includeOutsideGroupFinance =
    input.includeOutsideGroupFinance !== false &&
    (input.includeOutsideGroupFinance === true || hasExplicitOutsideGroupInputs);
  const storedSupportEvidence =
    includeOutsideGroupFinance &&
    !input.dryRun &&
    candidateElectionId &&
    input.includeStoredOutsideGroupSupportEvidence !== false
      ? (await listFloridaOutsideGroupSupportLinks({ db: input.db, candidateElectionId })).map(
          supportEvidenceFromStoredLink
        )
      : [];
  const supportEvidence = includeOutsideGroupFinance
    ? [...storedSupportEvidence, ...(input.outsideGroupSupportEvidence ?? [])]
    : [];
  const outsideGroupSupport = includeOutsideGroupFinance
    ? resolveFloridaOutsideGroupSupport({
        candidateName,
        trustedOutsideGroups: input.trustedOutsideGroups,
        supportEvidence,
        outsideContributionRows: input.outsideContributionRows,
        includeNameHeuristics: input.includeOutsideGroupNameHeuristics === true,
        heuristicSourceUrl: input.outsideSourceUrl ?? input.sourceUrl ?? null,
      })
    : {
        outsideGroups: [],
        trustedGroupCount: 0,
        evidenceLinkCount: 0,
        heuristicGroupCount: 0,
      };
  const resolvedOutsideGroups = outsideGroupSupport.outsideGroups;
  const resolvedOutsideGroupsForFinance =
    resolvedOutsideGroups.length > 0 ? resolvedOutsideGroups : undefined;
  const outsideGroupSupportLinks = includeOutsideGroupFinance
    ? input.outsideGroupSupportEvidence?.map((evidence) =>
        supportLinkInputFromEvidence({ evidence, fallbackCandidateElectionId: candidateElectionId })
      )
    : undefined;

  const directFinance = aggregateFloridaDirectContributions({
    recipientName: resolution.committeeName,
    recipientNames: resolution.recipientNames,
    electionYear,
    contributionRows: input.contributionRows,
    sourceUrl: input.contributionSourceUrl ?? resolution.sourceUrl ?? input.sourceUrl ?? null,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const outsideGroups = toOutsideGroups(resolvedOutsideGroupsForFinance);
  const outsideBreakdowns = aggregateOutsideBreakdowns({
    trustedOutsideGroups: resolvedOutsideGroupsForFinance,
    outsideContributionRows: input.outsideContributionRows,
    electionYear,
    sourceUrl: input.outsideSourceUrl ?? input.sourceUrl ?? null,
    minIndustryAmount: input.outsideMinIndustryAmount,
  });
  const outsideIndustryFinance = await enrichOutsideGroupIndustryBreakdowns({
    db: input.db,
    outsideGroupBreakdowns: outsideBreakdowns.breakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    maxDonorBreakdownsPerGroup: normalizeMaxDonorBreakdowns(input.outsideMaxBreakdownsPerCategory),
    dryRun: input.dryRun === true,
  });
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    resolution,
    sourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? null,
    verifiedAt: syncedAt,
    linkSource,
  });
  const summary = toSummary({
    directFinance,
    trustedOutsideGroups: resolvedOutsideGroupsForFinance,
    fallbackSourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? input.outsideSourceUrl ?? null,
  });
  const directBreakdowns = toDirectBreakdowns(directFinance.directBreakdowns);

  let writeResult: FloridaFinanceSnapshotWriteResult | undefined;
  if (!input.dryRun) {
    writeResult = await replaceFloridaCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns,
      outsideGroups,
      outsideGroupBreakdowns: outsideIndustryFinance.outsideGroupBreakdowns,
      outsideGroupSupportLinks,
      classifications: outsideIndustryFinance.classifications,
      pacFinance: input.pacFinance,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun: input.dryRun === true,
    resolution,
    ...(input.pacFinance ? {
      pacDonorsWritten: writeResult?.pacDonorsWritten ?? 0,
      ...(input.dryRun ? { netCommitteeAmount: input.pacFinance.finance.netCommitteeAmount }
        : writeResult?.netCommitteeAmount === undefined ? {} : { netCommitteeAmount: writeResult.netCommitteeAmount }),
    } : {}),
    linkWritten: !input.dryRun,
    summaryWritten: !input.dryRun,
    directBreakdownsWritten: input.dryRun ? 0 : directBreakdowns.length,
    outsideGroupsWritten: input.dryRun ? 0 : outsideGroups?.length ?? 0,
    outsideGroupBreakdownsWritten: input.dryRun ? 0 : outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0,
    outsideGroupSupportLinksWritten: input.dryRun ? 0 : outsideGroupSupportLinks?.length ?? 0,
    resolvedOutsideGroupCount: resolvedOutsideGroups.length,
    outsideGroupSupportEvidenceCount: supportEvidence.length,
    heuristicOutsideGroupCount: outsideGroupSupport.heuristicGroupCount,
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: summary.outsideSupportTotal ?? null,
    outsideOpposeTotal: summary.outsideOpposeTotal ?? null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionRowCount: directFinance.includedContributionRowCount,
    skippedContributionRowCount: directFinance.skippedContributionRowCount,
    matchedOutsideContributionRowCount: outsideBreakdowns.matchedContributionRowCount,
    includedOutsideContributionRowCount: outsideBreakdowns.includedContributionRowCount,
    skippedOutsideContributionRowCount: outsideBreakdowns.skippedContributionRowCount,
  };
}
