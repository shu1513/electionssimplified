import type { Pool, PoolClient } from "pg";
import type { DelawareCandidateFinanceDueRow } from "./delawareCandidateFinanceDueList.js";
import { normalizeDelawareCandidateNameForStorage } from "./delawareCandidateCommitteeResolver.js";
import { loadDelawareVerifiedFinanceLocalContext } from "./delawareVerifiedFinanceLocalContext.js";
import { loadDelawareVerifiedFinanceSource } from "./delawareVerifiedFinanceSourceLoader.js";
import { replaceDelawareCandidateFinanceSnapshot } from "./delawareFinanceWriter.js";

type ConnectableQueryable = Pick<Pool, "query"> & { connect: () => Promise<PoolClient> };

/** A current source refresh preserves each component lacking its own authority. */
export async function syncDelawareVerifiedCandidateFinance(input: {
  db: ConnectableQueryable;
  row: DelawareCandidateFinanceDueRow;
  cacheDir?: string;
  refresh?: boolean;
  log?: (message: string) => void;
  loadContextFn?: typeof loadDelawareVerifiedFinanceLocalContext;
  loadSourceFn?: typeof loadDelawareVerifiedFinanceSource;
  writeSnapshotFn?: typeof replaceDelawareCandidateFinanceSnapshot;
}) {
  const context = await (input.loadContextFn ?? loadDelawareVerifiedFinanceLocalContext)({
    db: input.db, row: input.row,
  });
  const prior = await input.db.query<{ outside_report_provenance: unknown }>(`
    SELECT summary.outside_report_provenance
    FROM public.de_candidate_finance_summaries summary
    JOIN public.de_candidate_finance_links link ON link.id = summary.link_id
    WHERE link.candidate_id = $1::uuid AND link.election_id = $2::uuid
      AND link.committee_id = $3::text AND link.link_status = 'active'
      AND summary.election_year = $4::integer`,
  [input.row.candidateId, input.row.electionId, input.row.cfId, input.row.electionYear]);
  if (prior.rows.length > 1) throw new Error("Delaware finance has ambiguous prior receiving account evidence");
  const source = await (input.loadSourceFn ?? loadDelawareVerifiedFinanceSource)({
    context, cacheDir: input.cacheDir, refresh: input.refresh,
    priorOutsideProvenance: prior.rows[0]?.outside_report_provenance,
    log: input.log,
  });
  if (!source.cash && !source.pac && !source.outsideEvidence.length) {
    throw new Error("Delaware current source has no accepted finance component; stored data preserved");
  }
  const money = (cents: number) => {
    if (!Number.isSafeInteger(cents)) throw new Error("Delaware source has unsafe monetary cents");
    return cents / 100;
  };
  const cash = source.cash;
  const summary = cash === undefined ? undefined : {
    totalReceipts: money(cash.reportedReceiptsCents),
    directContributionTotal: cash.directContributionCents === undefined ? null : money(cash.directContributionCents),
    totalDisbursements: money(cash.reportedExpendituresCents),
    cashOnHand: money(cash.cashOnHandCents),
    sourceUrl: input.row.sourceUrl,
  };
  // Source observations supply their own actual timestamps. This timestamp
  // records persistence after those observations; it does not retime them.
  const syncedAt = new Date();
  const result = await (input.writeSnapshotFn ?? replaceDelawareCandidateFinanceSnapshot)({
    db: input.db,
    link: {
      candidateId: input.row.candidateId, electionId: input.row.electionId,
      electionYear: input.row.electionYear,
      candidateNameNormalized: normalizeDelawareCandidateNameForStorage(input.row.candidateName),
      officeName: input.row.officeName, district: input.row.district,
      committeeId: input.row.cfId, committeeName: input.row.committeeName,
      linkStatus: "active", linkSource: input.row.linkSource,
      sourceUrl: input.row.sourceUrl, lastVerifiedAt: syncedAt,
    },
    syncedAt, summary,
    ...(source.pac === undefined ? {} : { pacEvidence: source.pac }),
    ...(source.outsideEvidence.length ? { outsideEvidence: source.outsideEvidence } : {}),
    linkReplacementPolicy: "retain",
  });
  return {
    dryRun: false as const,
    ...result,
    totalReceipts: summary?.totalReceipts ?? null,
    directContributionTotal: summary?.directContributionTotal ?? null,
    totalDisbursements: summary?.totalDisbursements ?? null,
    cashOnHand: summary?.cashOnHand ?? null,
    diagnostics: [...source.diagnostics, ...(result.pacDiagnostics ?? []), ...(result.outsideDiagnostics ?? [])],
  };
}

export type DelawareVerifiedCandidateFinanceSyncResult = Awaited<ReturnType<typeof syncDelawareVerifiedCandidateFinance>>;
