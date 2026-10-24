import { aggregateLosAngelesReportedCommitteeCash } from "./losAngelesReportedCommitteeCash.js";
import type { Pool, PoolClient } from "pg";
import {
  classifyFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import {
  getLosAngelesIndependentSpending,
  type LosAngelesCityEthicsClientOptions,
  type LosAngelesEthicsCandidateTotal,
} from "./losAngelesCityEthicsClient.js";
import {
  aggregateLosAngelesDirectContributions,
  type LosAngelesDirectBreakdown,
} from "./losAngelesDirectContributionAggregator.js";
import { replaceLosAngelesCandidateFinanceSnapshot } from "./losAngelesFinanceWriter.js";
import {
  defaultLosAngelesOpenDataClientOptions,
  getLosAngelesCommitteeContributions,
  type LosAngelesOpenDataClientOptions,
} from "./losAngelesOpenDataClient.js";
import { aggregateLosAngelesOutsideSpending } from "./losAngelesOutsideSpendingAggregator.js";
import { normalizeLosAngelesCandidateName } from "./losAngelesCandidateCommitteeResolver.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & Pick<Pool, "connect">;
export async function syncLosAngelesCandidateFinance(input: {
  db: PoolLike;
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateName: string;
  officeName: string;
  seatNumber?: number | null;
  total: LosAngelesEthicsCandidateTotal;
  ethicsClientOptions?: LosAngelesCityEthicsClientOptions;
  openDataClientOptions?: LosAngelesOpenDataClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  dryRun?: boolean;
  now?: Date;
}): Promise<{
  linkWritten: boolean;
  reportedCommitteeCashGroupCount: number;
  reportedCommitteeCashCents: number;
  reportedCommitteeCashGiftCount: number;
  directBreakdownCount: number;
  outsideGroupCount: number;
  reconciledContributionTotal: number;
  headlineContributionTotal: number;
  reconciliationDifference: number;
}> {
  const receivingIds = [...(input.total.fppcCommitteeIds ?? [input.total.fppcCommitteeId])].sort();
  if (!receivingIds.length || receivingIds.length > 2 || new Set(receivingIds).size !== receivingIds.length ||
    !receivingIds.includes(input.total.fppcCommitteeId) || receivingIds.some(id => !/^\d{4,12}$/.test(id)))
    throw new Error("Invalid Los Angeles receiving committee scope");
  const [ledgers, supportRows, opposeRows] = await Promise.all([
    Promise.all(receivingIds.map(committeeId => getLosAngelesCommitteeContributions(
      { committeeId, electionYear: input.electionYear },
      { ...defaultLosAngelesOpenDataClientOptions(), ...input.openDataClientOptions },
    ))),
    getLosAngelesIndependentSpending(
      {
        electionSeatCandidateId: input.total.electionSeatCandidateId,
        supportOppose: "support",
      },
      input.ethicsClientOptions,
    ),
    getLosAngelesIndependentSpending(
      {
        electionSeatCandidateId: input.total.electionSeatCandidateId,
        supportOppose: "oppose",
      },
      input.ethicsClientOptions,
    ),
  ]);
  const records = ledgers.flat();
  if (receivingIds.length > 1 && (!input.total.sourceElectionDates || input.total.sourceElectionDates.length !== 2 ||
    input.total.sourceElectionDates.some(date => !date.startsWith(`${input.electionYear}-`)) ||
    records.some(row => !row.electionDate || !input.total.sourceElectionDates!.includes(row.electionDate.slice(0, 10)))))
    throw new Error("Los Angeles paired ledgers do not match the published election calendar");
  const direct = aggregateLosAngelesDirectContributions({ records });
  const outside = aggregateLosAngelesOutsideSpending([
    ...supportRows,
    ...opposeRows,
  ]);
  const cents = (value: number): number => {
    const result = Math.round(value * 100);
    if (!Number.isSafeInteger(result)) throw new Error("Los Angeles finance exceeds safe cent precision");
    return result;
  };
  if (cents(direct.reconciledContributionTotal) !== cents(input.total.totalContributions))
    throw new Error("Los Angeles full receiving scope does not reconcile to the headline");
  if (cents(outside.supportTotal) !== cents(input.total.outsideSupportTotal) || cents(outside.opposeTotal) !== cents(input.total.outsideOpposeTotal))
    throw new Error("Los Angeles independent spending does not reconcile to the headline");
  const reportedCommitteeCash = aggregateLosAngelesReportedCommitteeCash({ records, receivingCommitteeIds: receivingIds,
    candidateName: input.candidateName, electionYear: input.electionYear, reportedThrough: input.total.reportedThrough });
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const row of direct.breakdowns)
    if (row.categoryType === "employer")
      mergeFinanceLabelClassification(
        classifications,
        classifyFinanceLabel({
          rawLabel: row.categoryName,
          labelType: "employer",
        }),
      );
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: direct.breakdowns,
    outsideBreakdowns: [],
    classifications,
    classifier: input.financeIndustryClassifier,
    minAmount: input.aiClassificationMinAmount ?? 25_000,
    dryRun: Boolean(input.dryRun),
  });
  const industryRaw = buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: direct.breakdowns,
    outsideBreakdowns: [],
    classifications,
  }).directIndustryBreakdowns;
  const industries = new Map<string, LosAngelesDirectBreakdown>();
  for (const row of industryRaw) {
    const old = industries.get(row.categoryName);
    industries.set(row.categoryName, {
      categoryType: "industry",
      categoryName: row.categoryName,
      amount: Math.round(((old?.amount ?? 0) + row.amount) * 100) / 100,
      contributorCount:
        (old?.contributorCount ?? 0) + (row.contributorCount ?? 0),
      sourceUrl: row.sourceUrl ?? input.total.sourceUrl,
    });
  }
  const breakdowns = [
    ...direct.breakdowns,
    ...industries.values(),
  ] as LosAngelesDirectBreakdown[];
  if (!input.dryRun)
    await replaceLosAngelesCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeLosAngelesCandidateName(
          input.candidateName,
        ),
        officeName: input.officeName,
        seatNumber: input.seatNumber,
        ethicsElectionId: input.total.electionId,
        ethicsCandidatePersonId: input.total.candidatePersonId,
        ethicsSeatCandidateId: input.total.electionSeatCandidateId,
        fppcCommitteeId: input.total.fppcCommitteeId,
        fppcCommitteeIds: receivingIds,
        committeeName: input.total.committeeName,
        internalCommitteePersonId: input.total.internalCommitteePersonId,
        linkStatus: "active",
        linkSource: "lacity_ethics",
        sourceUrl: input.total.sourceUrl,
        lastVerifiedAt: input.now ?? new Date(),
      },
      summary: {
        totalReceipts: input.total.totalContributions,
        totalDisbursements: input.total.totalExpenditures,
        cashOnHand: input.total.cashOnHand,
        matchingFunds: input.total.matchingFunds,
        outsideSupportTotal: input.total.outsideSupportTotal,
        outsideOpposeTotal: input.total.outsideOpposeTotal,
        membershipSupportTotal: input.total.membershipSupportTotal,
        membershipOpposeTotal: input.total.membershipOpposeTotal,
        sourceUrl: input.total.sourceUrl,
        reportedThrough: input.total.reportedThrough,
      },
      directBreakdowns: breakdowns,
      outsideGroups: outside.groups,
      reportedCommitteeCash,
      classifications: [...classifications.values()],
      syncedAt: input.now,
    });
  return {
    linkWritten: !input.dryRun,
    reportedCommitteeCashGroupCount: reportedCommitteeCash.donors.length,
    reportedCommitteeCashCents: reportedCommitteeCash.amountCents,
    reportedCommitteeCashGiftCount: reportedCommitteeCash.contributionCount,
    directBreakdownCount: breakdowns.length,
    outsideGroupCount: outside.groups.length,
    reconciledContributionTotal: direct.reconciledContributionTotal,
    headlineContributionTotal: input.total.totalContributions,
    reconciliationDifference:
      Math.round(
        (direct.reconciledContributionTotal - input.total.totalContributions) *
          100,
      ) / 100,
  };
}
