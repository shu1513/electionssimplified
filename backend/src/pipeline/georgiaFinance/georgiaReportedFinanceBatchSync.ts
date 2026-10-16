import type { Pool } from "pg";
import { isGeorgiaEthicsRawDataRefreshEnabled, isGeorgiaReportedIeEnabled,
  isGeorgiaReportedCommitteeContributionsEnabled } from "../../config/featureFlags.js";
import { createGeorgiaEthicsTransport } from "./georgiaEthicsClient.js";
import { fetchGeorgiaLinkedReceivingRegistration } from "./georgiaLinkedReceivingRegistration.js";
import { aggregateGeorgiaReportedIe, aggregateGeorgiaReportedCommitteeContributions } from "./georgiaReportedFinanceAggregation.js";
import { listDueGeorgiaReportedFinance, recordGeorgiaReportedFinanceAttempt } from "./georgiaReportedFinanceDueList.js";
import { createGeorgiaReportedFinanceSourceProducer, DEFAULT_GEORGIA_REPORTED_FINANCE_CACHE_DIR,
  GEORGIA_REPORTED_FINANCE_USER_AGENT, GeorgiaReportedFinanceSourceCacheError,
  readGeorgiaReportedIeSource, readGeorgiaReportedContributionSource,
  type GeorgiaReportedIeSource, type GeorgiaReportedContributionSource } from "./georgiaReportedFinanceSourceCache.js";
import { GeorgiaReportedFinanceWriteError, writeGeorgiaReportedCommitteeComponent,
  writeGeorgiaReportedIeComponent } from "./georgiaReportedFinanceWriter.js";

export type GeorgiaReportedFinanceBatchOptions = {db: Pool; now?: Date; dryRun?: boolean; refresh?: boolean;
  cacheDir?: string; filingYear?: number; electionYear?: number; maxCandidates?: number;
  staleAfterDays?: number; electionLookbackDays?: number; electionLookaheadDays?: number};
export type GeorgiaReportedFinanceBatchResult = {enabled: boolean; dryRun: boolean; now: string;
  filingYear: number; electionYear: number; eligibleCount: number; dueCount: number; selectedCount: number;
  attemptedCount: number; contextQualifiedCount: number; contextHeldCount: number;
  ieQualifiedCount: number; contributionQualifiedCount: number; ieWrittenCount: number; contributionWrittenCount: number;
  ieHeldCount: number; contributionHeldCount: number; sourceUnavailableCount: number; attemptRejectedCount: number};
function integer(n: number, low: number, high: number): number {
  if (!Number.isSafeInteger(n) || n < low || n > high) throw new Error("Invalid Georgia reported finance batch option");
  return n;
}
/** Ordinary independent component job. Acquisition publishes a validated
 * cache first; canonical money accepts only read-time replay of that cache.
 * Legacy direct report/transaction/funder acquisition is never called here. */
export async function syncDueGeorgiaReportedFinance(options: GeorgiaReportedFinanceBatchOptions): Promise<GeorgiaReportedFinanceBatchResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid Georgia reported finance batch clock");
  const filingYear = integer(options.filingYear ?? now.getUTCFullYear(), 2026, 2100);
  const electionYear = integer(options.electionYear ?? filingYear, 2026, 2100);
  const maxCandidates = integer(options.maxCandidates ?? 100, 1, 1000);
  const staleAfterDays = integer(options.staleAfterDays ?? 7, 1, 365);
  const electionLookbackDays = integer(options.electionLookbackDays ?? 30, 1, 365);
  const electionLookaheadDays = integer(options.electionLookaheadDays ?? 550, 1, 1000);
  const gates = {ie: isGeorgiaReportedIeEnabled(), contributions: isGeorgiaReportedCommitteeContributionsEnabled()};
  const result: GeorgiaReportedFinanceBatchResult = {enabled: gates.ie || gates.contributions,
    dryRun: options.dryRun === true, now: now.toISOString(), filingYear, electionYear,
    eligibleCount: 0, dueCount: 0, selectedCount: 0, attemptedCount: 0, contextQualifiedCount: 0, contextHeldCount: 0,
    ieQualifiedCount: 0, contributionQualifiedCount: 0, ieWrittenCount: 0, contributionWrittenCount: 0,
    ieHeldCount: 0, contributionHeldCount: 0, sourceUnavailableCount: 0, attemptRejectedCount: 0};
  if (!result.enabled) return result;
  const scope = {cacheDir: options.cacheDir ?? DEFAULT_GEORGIA_REPORTED_FINANCE_CACHE_DIR, filingYear, electionYear};
  const read = async <T>(fn: () => Promise<T | null>): Promise<T | null> => {
    try { return await fn(); } catch (error) {
      if (!(error instanceof GeorgiaReportedFinanceSourceCacheError)) throw error;
      return null;
    }
  };
  let ie: GeorgiaReportedIeSource | null = gates.ie ? await read(() => readGeorgiaReportedIeSource(scope)) : null;
  let contributions: GeorgiaReportedContributionSource | null = gates.contributions
    ? await read(() => readGeorgiaReportedContributionSource(scope)) : null;
  if (isGeorgiaEthicsRawDataRefreshEnabled()) {
    const producer = createGeorgiaReportedFinanceSourceProducer({cacheDir: scope.cacheDir});
    for (const kind of ["ie", "contributions"] as const) {
      if (!(kind === "ie" ? gates.ie : gates.contributions)) continue;
      const packet = kind === "ie" ? ie : contributions;
      if (!options.refresh && packet && now.getTime() - Date.parse(packet.sourceRetrievedAt) < 86_400_000) continue;
      try {
        if (kind === "ie") { await producer.refreshIe(scope); ie = await read(() => readGeorgiaReportedIeSource(scope)); }
        else { await producer.refreshContributions(scope); contributions = await read(() => readGeorgiaReportedContributionSource(scope)); }
      } catch (error) {
        if (!(error instanceof GeorgiaReportedFinanceSourceCacheError)) throw error;
        // Preserve the previously read qualified packet and its original clock.
      }
    }
  }
  result.sourceUnavailableCount = Number(gates.ie && !ie) + Number(gates.contributions && !contributions);
  const due = await listDueGeorgiaReportedFinance(options.db, {now, filingYear, electionYear, maxCandidates,
    staleAfterDays, electionLookbackDays, electionLookaheadDays, refresh: options.refresh === true,
    gates, ieSource: ie, contributionSource: contributions});
  result.eligibleCount = due.eligibleCount; result.dueCount = due.totalDueRows; result.selectedCount = due.rows.length;
  const transport = createGeorgiaEthicsTransport({maxAttempts: 1, timeoutMs: 45_000,
    userAgent: GEORGIA_REPORTED_FINANCE_USER_AGENT});
  for (const receiver of due.rows) {
    if (!result.dryRun) {
      if (!await recordGeorgiaReportedFinanceAttempt({db: options.db, receiver, now: new Date(), gates})) {
        result.attemptRejectedCount++; continue;
      }
      result.attemptedCount++;
    }
    if (!ie && !contributions) { result.contextHeldCount++; continue; }
    const receiving = await fetchGeorgiaLinkedReceivingRegistration({transport, candidateName: receiver.candidateName,
      committeeId: receiver.committeeId, electionYear});
    if (receiving.status !== "qualified") { result.contextHeldCount++; continue; }
    result.contextQualifiedCount++;
    const context = receiving.context;
    if (gates.ie) {
      const aggregation = ie ? aggregateGeorgiaReportedIe({rows: ie.rows, registrationGuid: context.registrationGuid, electionYear}) : null;
      if (!ie || !aggregation || aggregation.status !== "qualified") result.ieHeldCount++;
      else {
        result.ieQualifiedCount++;
        if (!result.dryRun) try {
          await writeGeorgiaReportedIeComponent({db: options.db, receiver, context, source: ie, aggregation});
          result.ieWrittenCount++;
        } catch (error) { if (!(error instanceof GeorgiaReportedFinanceWriteError)) throw error; result.ieHeldCount++; }
      }
    }
    if (gates.contributions) {
      const aggregation = contributions ? aggregateGeorgiaReportedCommitteeContributions({source: contributions,
        receivingCommitteeId: context.receivingCommitteeId, electionYear}) : null;
      if (!contributions || !aggregation || aggregation.status !== "qualified") result.contributionHeldCount++;
      else {
        result.contributionQualifiedCount++;
        if (!result.dryRun) try {
          await writeGeorgiaReportedCommitteeComponent({db: options.db, receiver, context, source: contributions, aggregation,
            heldReceivingCount: contributions.heldReceivingCommitteeIds.size});
          result.contributionWrittenCount++;
        } catch (error) { if (!(error instanceof GeorgiaReportedFinanceWriteError)) throw error; result.contributionHeldCount++; }
      }
    }
  }
  return result;
}
