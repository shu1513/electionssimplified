import type { Pool, PoolClient } from "pg";

import { isMissouriCommitteeReceiptsEnabled } from "../../config/featureFlags.js";

import { classifyFinanceLabel, type FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
} from "../finance/financeIndustryClassificationService.js";
import { aggregateMissouriDirectFinance, type MissouriDirectFinanceAggregationResult } from "./missouriDirectContributionAggregator.js";
import {
  readMissouriMecCandidateFinanceArtifacts,
  readMissouriMecCommitteeReceiptArtifacts,
  readMissouriMecOutsideSpenderContributionArtifacts,
  readMissouriMecOutsideSpendingArtifacts,
} from "./missouriMecArtifactCache.js";
import { normalizeMissouriCandidateNameForStorage } from "./missouriCandidateCommitteeResolver.js";
import {
  isMissouriDirectFinanceEligibleOffice,
  normalizeMissouriMecJurisdiction,
  normalizeMissouriMecText,
} from "./missouriFinanceEligibleOffices.js";
import { replaceMissouriCandidateFinanceSnapshot, type MissouriFinanceLinkSource } from "./missouriFinanceWriter.js";
import {
  aggregateMissouriOutsideGroupContributions,
  type MissouriOutsideGroupContributionAggregationResult,
  type MissouriOutsideSpenderContributionArtifacts,
} from "./missouriOutsideGroupContributionAggregator.js";
import {
  aggregateMissouriOutsideSpending,
  type MissouriOutsideSpendingAggregationResult,
} from "./missouriOutsideSpendingAggregator.js";
import type {
  MissouriMecCommitteeInfo,
  MissouriMecContributionRow,
  MissouriMecExpenditureRow,
  MissouriMecOutsideSpenderIdentity,
  MissouriMecOutsideSpendingRow,
  MissouriMecReportInventoryRow,
} from "./missouriMecParsers.js";
import type { MissouriFinanceOutsideGroupBreakdownInput } from "./missouriFinanceWriter.js";
import {
  aggregateMissouriCommitteeMonetaryReceipts,
  type MissouriCommitteeMonetaryReceiptAggregation,
} from "./missouriCommitteeMonetaryReceiptAggregator.js";
import {
  prepareMissouriCommitteeMonetaryReceiptComponent,
  type MissouriCommitteeMonetaryReceiptComponent,
} from "./missouriCommitteeMonetaryReceiptWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

export type MissouriCandidateFinanceArtifacts = {
  committeeInfo: MissouriMecCommitteeInfo;
  inventory: readonly MissouriMecReportInventoryRow[];
  contributionRows: readonly MissouriMecContributionRow[];
  expenditureRows: readonly MissouriMecExpenditureRow[];
  contributionSourceUrl: string;
  expenditureSourceUrl: string;
};

export type MissouriOutsideSpendingArtifacts = {
  rows: readonly MissouriMecOutsideSpendingRow[];
  identities: readonly MissouriMecOutsideSpenderIdentity[];
  sourceUrl: string;
};

export type MissouriCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  dryRun: boolean;
  cycleStart: string;
  cycleEnd: string;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  aggregation: MissouriDirectFinanceAggregationResult | null;
  directSkippedReason?: string | null;
  committeeMonetaryReceipts?: Omit<MissouriCommitteeMonetaryReceiptAggregation, "committees"> | null;
  committeeReceiptGroupsWritten?: number;
  committeeReceiptsSkippedReason?: string | null;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  outsideSpending: Omit<MissouriOutsideSpendingAggregationResult, "outsideGroups"> | null;
  outsideSpendingSkippedReason: string | null;
  outsideFunders: Omit<MissouriOutsideGroupContributionAggregationResult, "outsideGroupBreakdowns"> | null;
  outsideFundersSkippedReason: string | null;
};

const DEFAULT_MAX_OUTSIDE_DONOR_BREAKDOWNS_PER_GROUP = 50;

function normalizeMaxOutsideDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_OUTSIDE_DONOR_BREAKDOWNS_PER_GROUP;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Missouri maxOutsideDonorBreakdownsPerGroup: ${value}`);
  }
  return normalized;
}

async function enrichMissouriOutsideIndustries(input: {
  db: Queryable;
  breakdowns: readonly MissouriFinanceOutsideGroupBreakdownInput[];
  maxDonorsPerGroup: number;
  dryRun: boolean;
}): Promise<{ breakdowns: MissouriFinanceOutsideGroupBreakdownInput[]; classifications: FinanceLabelClassification[] }> {
  const donorRows = input.breakdowns.filter((row) => row.categoryType === "donor");
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const donor of donorRows) {
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: donor.categoryName, labelType: "donor" })
    );
  }
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: [],
    outsideBreakdowns: donorRows,
    classifications,
    classifier: undefined,
    minAmount: 0,
    dryRun: input.dryRun,
  });
  const industryRows = new Map<string, MissouriFinanceOutsideGroupBreakdownInput>();
  for (const row of buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: [], outsideBreakdowns: donorRows, classifications,
  }).outsideIndustryBreakdowns) {
    const key = `${row.committeeId}\u0000${row.supportOppose}\u0000${row.categoryName}`;
    const existing = industryRows.get(key);
    if (existing) {
      existing.amount = Math.round((existing.amount + row.amount) * 100) / 100;
      existing.contributorCount = (existing.contributorCount ?? 0) + (row.contributorCount ?? 0);
    } else industryRows.set(key, { ...row });
  }
  const donorsByGroup = new Map<string, MissouriFinanceOutsideGroupBreakdownInput[]>();
  for (const donor of donorRows) {
    const key = `${donor.committeeId}\u0000${donor.supportOppose}`;
    const rows = donorsByGroup.get(key) ?? [];
    rows.push(donor);
    donorsByGroup.set(key, rows);
  }
  const cappedDonors = [...donorsByGroup.values()].flatMap((rows) =>
    rows.sort((left, right) => right.amount - left.amount || left.categoryName.localeCompare(right.categoryName)).slice(0, input.maxDonorsPerGroup)
  );
  return {
    breakdowns: [
      ...cappedDonors,
      ...[...industryRows.values()].sort((left, right) => left.committeeId.localeCompare(right.committeeId) || left.supportOppose.localeCompare(right.supportOppose) || right.amount - left.amount || left.categoryName.localeCompare(right.categoryName)),
    ],
    classifications: [...classifications.values()],
  };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function nextIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function resolveMissouriCandidateFinanceCycleWindow(input: {
  electionDate: string;
  committeeInfo: MissouriMecCommitteeInfo;
}): { cycleStart: string; cycleEnd: string; primaryElectionDate: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.electionDate)) {
    throw new Error(`Invalid Missouri target election date: ${input.electionDate}`);
  }
  const year = input.electionDate.slice(0, 4);
  const targetHistory = input.committeeInfo.electionHistory.find((row) => row.electionDate === input.electionDate);
  if (!targetHistory || !/GENERAL/i.test(targetHistory.electionType)) {
    throw new Error(`Missouri direct-finance v1 requires target general election in MEC history: ${input.electionDate}`);
  }
  const primaries = input.committeeInfo.electionHistory
    .filter((row) =>
      row.electionDate.startsWith(`${year}-`) &&
      row.electionDate < input.electionDate &&
      /PRIMARY/i.test(row.electionType) &&
      normalizeMissouriMecText(row.office) === normalizeMissouriMecText(targetHistory.office) &&
      normalizeMissouriMecJurisdiction(row.politicalSubdivision) ===
        normalizeMissouriMecJurisdiction(targetHistory.politicalSubdivision)
    )
    .sort((a, b) => b.electionDate.localeCompare(a.electionDate));
  const primary = primaries[0];
  if (!primary) {
    throw new Error(`Missouri MEC history has no matching same-year primary boundary before ${input.electionDate}`);
  }
  return { cycleStart: nextIsoDate(primary.electionDate), cycleEnd: input.electionDate, primaryElectionDate: primary.electionDate };
}

export type MissouriCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeName: string;
  district?: string | null;
  committee: {
    committeeId: string;
    committeeName: string;
    linkSource: MissouriFinanceLinkSource;
    sourceUrl?: string | null;
  };
  cacheDir?: string;
  artifacts?: MissouriCandidateFinanceArtifacts;
  now?: Date;
  dryRun?: boolean;
  maxOccupationBreakdowns?: number;
  maxOutsideGroups?: number;
  maxOutsideDonorBreakdownsPerGroup?: number;
  outsideArtifacts?: MissouriOutsideSpendingArtifacts | null;
  outsideSpenderArtifactsByMecid?: ReadonlyMap<string, MissouriOutsideSpenderContributionArtifacts>;
  refreshOutsideSpenderArtifacts?: (mecid: string) => Promise<void>;
  directArtifactsUnavailable?: boolean;
  receiptArtifacts?: Awaited<ReturnType<typeof readMissouriMecCommitteeReceiptArtifacts>> | null;
};

/** Keep the new receipt component independent while retaining the ordinary
 * protected transaction when the existing finance snapshot also qualifies. */
export async function syncMissouriCandidateFinance(input: MissouriCandidateFinanceSyncInput): Promise<MissouriCandidateFinanceSyncResult> {
  if (!isMissouriCommitteeReceiptsEnabled()) {
    if (input.directArtifactsUnavailable) throw new Error("Missouri MEC direct artifacts unavailable after receipt capture");
    return syncMissouriCandidateFinanceCore(input);
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid Missouri finance sync timestamp");
  const committeeId = input.committee.committeeId.trim().toUpperCase();
  let component: MissouriCommitteeMonetaryReceiptComponent | undefined;
  let receipts: MissouriCommitteeMonetaryReceiptAggregation | null = null;
  let skippedReason: string | null = null;
  try {
    if (!isMissouriDirectFinanceEligibleOffice({ officeScope: input.officeScope, officeCanonicalName: input.officeName }) ||
      !Number.isSafeInteger(input.electionYear) || input.electionYear < 2024 || input.electionYear > 2100 ||
      !/^[A-Z]\d{6}$/.test(committeeId)) throw new Error();
    const source = input.receiptArtifacts === undefined
      ? await readMissouriMecCommitteeReceiptArtifacts({ cacheDir: input.cacheDir, mecid: committeeId, year: input.electionYear })
      : input.receiptArtifacts;
    if (!source || source.committeeInfo.mecid !== committeeId ||
      source.contributionRows.some((row) => row.mecid !== committeeId)) throw new Error();
    const window = resolveMissouriCandidateFinanceCycleWindow({ electionDate: input.electionDate, committeeInfo: source.committeeInfo });
    receipts = aggregateMissouriCommitteeMonetaryReceipts({ inventory: source.inventory, contributionRows: source.contributionRows, ...window });
    if (receipts.status === "qualified") {
      component = prepareMissouriCommitteeMonetaryReceiptComponent({ receivingCommitteeId: committeeId,
        electionYear: input.electionYear, syncedAt: now, component: {
        receivingCommitteeId: committeeId, cycleStart: window.cycleStart, cycleEnd: window.cycleEnd,
        aggregation: receipts, sourceRetrievedAt: new Date(source.sourceRetrievedAt), sourceUrl: source.contributionSourceUrl,
        sourceSha256: source.sourceSha256, sourceByteSize: source.sourceByteSize, reportInventorySha256: source.reportInventorySha256 } });
    } else skippedReason = receipts.reason;
  } catch { skippedReason = "qualified receipt source or cycle unavailable"; }
  const safeReceipts = receipts === null ? null : (({ committees: _groups, ...safe }) => safe)(
    receipts.status === "qualified" ? receipts : { ...receipts, committees: undefined });
  const receiptResult = { committeeMonetaryReceipts: safeReceipts,
    committeeReceiptGroupsWritten: !input.dryRun && component?.aggregation.status === "qualified" ? component.aggregation.committees.length : 0,
    committeeReceiptsSkippedReason: skippedReason };
  try {
    if (input.directArtifactsUnavailable) throw new Error("Missouri MEC direct artifacts unavailable after receipt capture");
    return { ...await syncMissouriCandidateFinanceCore({ ...input, now, committeeMonetaryReceipts: component }), ...receiptResult };
  } catch (error) {
    if (!component || component.aggregation.status !== "qualified") throw error;
    // An unrelated direct/expenditure/outside failure cannot discard a qualified
    // receipt source. This path supplies no legacy money slices or timestamps.
    if (!input.dryRun) await replaceMissouriCandidateFinanceSnapshot({
      db: input.db, syncedAt: now, committeeMonetaryReceipts: component,
      link: { candidateId: input.candidateId, electionId: input.electionId, electionYear: input.electionYear,
        candidateNameNormalized: normalizeMissouriCandidateNameForStorage(requireText(input.candidateName, "candidate name")),
        officeName: requireText(input.officeName, "office name"), district: input.district ?? null,
        committeeId, committeeName: requireText(input.committee.committeeName, "Missouri committee name"),
        linkStatus: "active", linkSource: input.committee.linkSource,
        sourceUrl: input.committee.sourceUrl ?? component.sourceUrl, lastVerifiedAt: now },
    });
    return { candidateId: input.candidateId, electionId: input.electionId, electionYear: input.electionYear, committeeId,
      dryRun: input.dryRun === true, cycleStart: component.cycleStart, cycleEnd: component.cycleEnd,
      linkWritten: !input.dryRun, summaryWritten: false, directBreakdownsWritten: 0, aggregation: null,
      directSkippedReason: "direct finance component unavailable; prior snapshot preserved",
      outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0, outsideSupportTotal: null, outsideOpposeTotal: null,
      outsideSpending: null, outsideSpendingSkippedReason: "legacy snapshot unavailable; prior outside data preserved",
      outsideFunders: null, outsideFundersSkippedReason: "legacy snapshot unavailable; prior funder data preserved", ...receiptResult };
  }
}

async function syncMissouriCandidateFinanceCore(input: MissouriCandidateFinanceSyncInput & {
  committeeMonetaryReceipts?: MissouriCommitteeMonetaryReceiptComponent;
}): Promise<MissouriCandidateFinanceSyncResult> {
  const candidateId = requireText(input.candidateId, "candidate id");
  const electionId = requireText(input.electionId, "election id");
  const candidateName = requireText(input.candidateName, "candidate name");
  const officeScope = requireText(input.officeScope, "office scope");
  const officeName = requireText(input.officeName, "office name");
  if (!isMissouriDirectFinanceEligibleOffice({ officeScope, officeCanonicalName: officeName })) {
    throw new Error(`Missouri direct-finance v1 does not support office cycle ${officeScope}::${officeName}`);
  }
  const committeeId = requireText(input.committee.committeeId, "Missouri committee id").toUpperCase();
  if (!/^[A-Z]\d{6}$/.test(committeeId)) throw new Error(`Invalid Missouri MECID: ${committeeId}`);
  if (!Number.isSafeInteger(input.electionYear) || input.electionYear < 2024 || input.electionYear > 2100) {
    throw new Error(`Invalid Missouri finance election year: ${input.electionYear}`);
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid Missouri finance sync timestamp");
  const artifacts = input.artifacts ?? await readMissouriMecCandidateFinanceArtifacts({
    cacheDir: input.cacheDir,
    mecid: committeeId,
    year: input.electionYear,
  });
  if (artifacts.committeeInfo.mecid !== committeeId) {
    throw new Error(`Missouri MEC artifact mismatch: expected ${committeeId}, got ${artifacts.committeeInfo.mecid}`);
  }
  for (const row of [...artifacts.contributionRows, ...artifacts.expenditureRows]) {
    if (row.mecid !== committeeId) throw new Error(`Missouri MEC export contains unexpected committee ${row.mecid}`);
  }
  const window = resolveMissouriCandidateFinanceCycleWindow({
    electionDate: input.electionDate,
    committeeInfo: artifacts.committeeInfo,
  });
  const sourceUrl = artifacts.contributionSourceUrl || input.committee.sourceUrl || null;
  const aggregation = aggregateMissouriDirectFinance({
    inventory: artifacts.inventory,
    contributionRows: artifacts.contributionRows,
    expenditureRows: artifacts.expenditureRows,
    cycleStart: window.cycleStart,
    cycleEnd: window.cycleEnd,
    sourceUrl,
    maxOccupationBreakdowns: input.maxOccupationBreakdowns,
  });
  const reportDiagnostics = [
    ...aggregation.contributionReportDiagnostics,
    ...aggregation.expenditureReportDiagnostics,
  ];
  if (reportDiagnostics.length > 0) {
    const excludedRowCount = reportDiagnostics.reduce((sum, row) => sum + row.excludedRowCount, 0);
    const excludedAmountCents = reportDiagnostics.reduce((sum, row) => sum + row.excludedAmountCents, 0);
    throw new Error(
      `Missouri MEC in-cycle report lineage is not publishable: lineages=${reportDiagnostics.length}, rows=${excludedRowCount}, signedAmountCents=${excludedAmountCents}`
    );
  }
  if (aggregation.unrecognizedContributionKindRowCount > 0 || aggregation.unrecognizedExpenditureTypeRowCount > 0) {
    throw new Error(
      `Missouri MEC export has unrecognized transaction types: contributions=${aggregation.unrecognizedContributionKindRowCount}, expenditures=${aggregation.unrecognizedExpenditureTypeRowCount}`
    );
  }

  let outsideArtifacts = input.outsideArtifacts;
  let outsideSpendingSkippedReason: string | null = null;
  if (outsideArtifacts === null) {
    outsideSpendingSkippedReason = "yearly outside-spending artifact unavailable";
  } else if (outsideArtifacts === undefined) {
    try {
      outsideArtifacts = await readMissouriMecOutsideSpendingArtifacts({ cacheDir: input.cacheDir, year: input.electionYear });
    } catch (error) {
      outsideSpendingSkippedReason = error instanceof Error ? error.message : String(error);
    }
  }
  const outsideSpending = outsideArtifacts
    ? aggregateMissouriOutsideSpending({
        rows: outsideArtifacts.rows,
        identities: outsideArtifacts.identities,
        candidateName,
        officeName,
        district: input.district,
        cycleStart: window.cycleStart,
        cycleEnd: window.cycleEnd,
        sourceUrl: outsideArtifacts.sourceUrl,
        maxGroups: input.maxOutsideGroups,
      })
    : null;
  let outsideGroupBreakdowns: MissouriFinanceOutsideGroupBreakdownInput[] | undefined;
  let classifications: FinanceLabelClassification[] | undefined;
  let outsideFunders: Omit<MissouriOutsideGroupContributionAggregationResult, "outsideGroupBreakdowns"> | null = null;
  let outsideFundersSkippedReason: string | null = null;
  if (!outsideSpending) {
    outsideFundersSkippedReason = `outside leg skipped (${outsideSpendingSkippedReason ?? "unavailable"})`;
  } else if (outsideSpending.outsideGroups.length === 0) {
    outsideGroupBreakdowns = [];
    classifications = [];
    outsideFunders = {
      matchedContributionRowCount: 0, includedContributionRowCount: 0, individualContributionRowCount: 0,
      outsideCycleContributionRowCount: 0, nonPositiveContributionRowCount: 0, ambiguousOrganizationRowCount: 0,
      ambiguousOrganizationAmount: 0, unrecognizedContributionKindRowCount: 0,
      unrecognizedContributionKindAmount: 0, reportDiagnostics: [],
    };
  } else {
    const artifactsBySpender = new Map<string, MissouriOutsideSpenderContributionArtifacts>();
    for (const mecid of new Set(outsideSpending.outsideGroups.map((group) => group.committeeId))) {
      try {
        await input.refreshOutsideSpenderArtifacts?.(mecid);
        const injected = input.outsideSpenderArtifactsByMecid?.get(mecid);
        artifactsBySpender.set(
          mecid,
          injected ?? await readMissouriMecOutsideSpenderContributionArtifacts({ cacheDir: input.cacheDir, mecid, year: input.electionYear })
        );
      } catch (error) {
        outsideFundersSkippedReason = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (!outsideFundersSkippedReason) {
      const funders = aggregateMissouriOutsideGroupContributions({
        outsideGroups: outsideSpending.outsideGroups,
        artifactsBySpender,
        cycleStart: window.cycleStart,
        cycleEnd: window.cycleEnd,
        sourceUrl: outsideArtifacts?.sourceUrl,
      });
      const { outsideGroupBreakdowns: donorBreakdowns, ...diagnostics } = funders;
      if (funders.reportDiagnostics.length > 0 || funders.unrecognizedContributionKindRowCount > 0) {
        outsideFundersSkippedReason = `outside funder report data is ambiguous: lineages=${funders.reportDiagnostics.length}, kinds=${funders.unrecognizedContributionKindRowCount}`;
      } else {
        const enriched = await enrichMissouriOutsideIndustries({
          db: input.db,
          breakdowns: donorBreakdowns,
          maxDonorsPerGroup: normalizeMaxOutsideDonorBreakdowns(input.maxOutsideDonorBreakdownsPerGroup),
          dryRun: input.dryRun === true,
        });
        outsideGroupBreakdowns = enriched.breakdowns;
        classifications = enriched.classifications;
        outsideFunders = diagnostics;
      }
    }
  }
  const outsideSnapshot = outsideFundersSkippedReason === null ? outsideSpending : null;

  let summaryWritten = false;
  let directBreakdownsWritten = 0;
  let outsideGroupsWritten = 0;
  let outsideGroupBreakdownsWritten = 0;
  if (!input.dryRun) {
    const write = await replaceMissouriCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId,
        electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeMissouriCandidateNameForStorage(candidateName),
        officeName,
        district: input.district ?? null,
        committeeId,
        committeeName: requireText(input.committee.committeeName, "Missouri committee name"),
        linkStatus: "active",
        linkSource: input.committee.linkSource,
        sourceUrl: input.committee.sourceUrl ?? sourceUrl,
        lastVerifiedAt: now,
      },
      syncedAt: now,
      summary: {
        totalReceipts: null,
        directContributionTotal: aggregation.directContributionTotal,
        totalDisbursements: aggregation.totalDisbursements,
        cashOnHand: null,
        outsideSupportTotal: outsideSnapshot?.supportTotal ?? null,
        outsideOpposeTotal: outsideSnapshot?.opposeTotal ?? null,
        sourceUrl,
      },
      directBreakdowns: aggregation.directBreakdowns,
      outsideGroups: outsideSnapshot?.outsideGroups,
      outsideGroupBreakdowns,
      classifications,
      committeeMonetaryReceipts: input.committeeMonetaryReceipts,
    });
    summaryWritten = write.summaryWritten;
    directBreakdownsWritten = write.directBreakdownsWritten;
    outsideGroupsWritten = write.outsideGroupsWritten;
    outsideGroupBreakdownsWritten = write.outsideGroupBreakdownsWritten;
  }
  return {
    candidateId,
    electionId,
    electionYear: input.electionYear,
    committeeId,
    dryRun: input.dryRun === true,
    cycleStart: window.cycleStart,
    cycleEnd: window.cycleEnd,
    linkWritten: !input.dryRun,
    summaryWritten,
    directBreakdownsWritten,
    aggregation,
    outsideGroupsWritten,
    outsideGroupBreakdownsWritten,
    outsideSupportTotal: outsideSpending?.supportTotal ?? null,
    outsideOpposeTotal: outsideSpending?.opposeTotal ?? null,
    outsideSpending: outsideSpending
      ? (({ outsideGroups: _groups, ...diagnostics }) => diagnostics)(outsideSpending)
      : null,
    outsideSpendingSkippedReason,
    outsideFunders,
    outsideFundersSkippedReason,
  };
}
