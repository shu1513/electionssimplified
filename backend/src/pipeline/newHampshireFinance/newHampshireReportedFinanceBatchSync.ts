import type { Pool } from "pg";
import { isNewHampshireReportedCommitteeReceiptsEnabled, isNewHampshireReportedIeEnabled,
  isNewHampshireCfsRawDataRefreshEnabled } from "../../config/featureFlags.js";
import { normalizeNewHampshireCandidateAlias } from "./newHampshireOutsideSpendingAggregator.js";
import { aggregateNewHampshireReportedCommitteeReceipts, aggregateNewHampshireReportedIe } from "./newHampshireReportedFinanceAggregation.js";
import { listEligibleNewHampshireReportedFinance, recordNewHampshireReportedAttempt,
  selectDueNewHampshireReportedFinance } from "./newHampshireReportedFinanceDueList.js";
import { qualifyNewHampshireReportedReceiver, newHampshireAmbiguousSourceTargetAliases } from "./newHampshireReportedReceiver.js";
import { createNewHampshireReportedSourceProducer, readNewHampshireReportedBase,
  readNewHampshireReportedSource, readNewHampshireReportedSourceHint,
  type NewHampshireBasePacket, type NewHampshireReportedSourcePacket } from "./newHampshireReportedSourceCache.js";
import { NewHampshireReportedSourceError } from "./newHampshireReportedSourceGraph.js";
import { writeNewHampshireReportedComponent } from "./newHampshireReportedFinanceWriter.js";

export type NewHampshireReportedFinanceBatchOptions = {
  db: Pool; now?: Date; dryRun?: boolean; refresh?: boolean; cacheDir?: string; electionYear?: number;
  maxCandidates?: number; staleAfterDays?: number; electionLookbackDays?: number; electionLookaheadDays?: number;
};
export type NewHampshireReportedFinanceBatchResult = {
  enabled: boolean; dryRun: boolean; now: string; eligibleCount: number; dueCount: number; selectedCount: number;
  attemptedCount: number; attemptRejectedCount: number; committeeQualifiedCount: number; ieQualifiedCount: number;
  committeeWrittenCount: number; ieWrittenCount: number; committeeHeldCount: number; ieHeldCount: number;
  committeePositiveCandidateCount: number; iePositiveCandidateCount: number; acquisitionHeldCount: number;
  failedCount: number; heldReasons: Record<string, number>;
};
function integer(n: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error("Invalid New Hampshire reported finance option");
  return n;
}
/** Ordinary independent job: saved originals first; network refresh is gated
 * separately. Neither direct legacy acquisition nor its writer is called. */
export async function syncDueNewHampshireReportedFinance(options: NewHampshireReportedFinanceBatchOptions): Promise<NewHampshireReportedFinanceBatchResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid New Hampshire reported finance clock");
  const gates = { ie: isNewHampshireReportedIeEnabled(), committee: isNewHampshireReportedCommitteeReceiptsEnabled() };
  const result: NewHampshireReportedFinanceBatchResult = { enabled: gates.ie || gates.committee, dryRun: options.dryRun === true,
    now: now.toISOString(), eligibleCount: 0, dueCount: 0, selectedCount: 0, attemptedCount: 0, attemptRejectedCount: 0,
    committeeQualifiedCount: 0, ieQualifiedCount: 0, committeeWrittenCount: 0, ieWrittenCount: 0, committeeHeldCount: 0,
    ieHeldCount: 0, committeePositiveCandidateCount: 0, iePositiveCandidateCount: 0, acquisitionHeldCount: 0, failedCount: 0, heldReasons: {} };
  if (!result.enabled) return result;
  const maxCandidates = integer(options.maxCandidates ?? 25, 1, 1000), staleAfterDays = integer(options.staleAfterDays ?? 7, 1, 365);
  const scope = { now, electionLookbackDays: integer(options.electionLookbackDays ?? 30, 1, 365),
    electionLookaheadDays: integer(options.electionLookaheadDays ?? 730, 1, 1000),
    electionYear: options.electionYear === undefined ? undefined : integer(options.electionYear, 2016, 2100) };
  const eligible = await listEligibleNewHampshireReportedFinance(options.db, scope);
  result.eligibleCount = eligible.length;
  if (!eligible.length) return result;
  const hold = (error: unknown, acquisition = false) => {
    if (!(error instanceof NewHampshireReportedSourceError)) { result.failedCount++; return; }
    result.heldReasons[error.code] = (result.heldReasons[error.code] ?? 0) + 1;
    if (acquisition) result.acquisitionHeldCount++;
  };
  const read = async <T>(fn: () => Promise<T | null>): Promise<T | null> => {
    try { return await fn(); } catch (error) { hold(error); return null; }
  };
  const rawEnabled = isNewHampshireCfsRawDataRefreshEnabled();
  const producer = rawEnabled ? createNewHampshireReportedSourceProducer({ cacheDir: options.cacheDir }) : null;
  const bases = new Map<number, NewHampshireBasePacket | null>(), ieSources = new Map<number, NewHampshireReportedSourcePacket | null>();
  for (const electionYear of new Set(eligible.map(r => r.electionYear))) {
    const cacheScope = { cacheDir: options.cacheDir, electionYear };
    let base = await read(() => readNewHampshireReportedBase(cacheScope));
    let ie = gates.ie ? await read(() => readNewHampshireReportedSource({ ...cacheScope, kind: "ie" })) : null;
    if (producer) {
      if (options.refresh || !base || Date.now() - Date.parse(base.controls.at(-1)!.completedAt) >= 86_400_000) {
        try { base = await producer.refreshBase(electionYear); } catch (error) { hold(error, true); }
      }
      if (gates.ie && base && (options.refresh || !ie || Date.now() - Date.parse(ie.sourceRetrievedAt) >= 86_400_000)) {
        try { ie = await producer.refreshComponent({ kind: "ie", electionYear, base: base.reference }); }
        catch (error) {
          if(error instanceof NewHampshireReportedSourceError&&error.code==="registration_inventory_changed"){
            try{base=await producer.refreshBase(electionYear);if(base)ie=await producer.refreshComponent({kind:"ie",electionYear,base:base.reference});}
            catch(retryError){hold(retryError,true);}
          }else hold(error,true);
        }
      }
    }
    bases.set(electionYear, base); ieSources.set(electionYear, ie);
  }
  const hints = new Map<string, { ie: Awaited<ReturnType<typeof readNewHampshireReportedSourceHint>>;
    committee: Awaited<ReturnType<typeof readNewHampshireReportedSourceHint>> }>();
  for (const receiver of eligible) {
    const source = ieSources.get(receiver.electionYear);
    const committee = gates.committee ? await read(() => readNewHampshireReportedSourceHint({ cacheDir: options.cacheDir,
      kind: "committee", electionYear: receiver.electionYear, filingEntityId: receiver.filingEntityId })) : null;
    hints.set(receiver.linkId, { ie: source ? { manifestSha256: source.sourceManifestSha256, retrievedAt: source.sourceRetrievedAt } : null, committee });
  }
  const allDue = selectDueNewHampshireReportedFinance({ rows: eligible, now, gates, hints, staleAfterDays,
    maxCandidates: eligible.length, refresh: options.refresh === true });
  const selected = allDue.slice(0, maxCandidates); result.dueCount = allDue.length; result.selectedCount = selected.length;
  const owners = new Map<number, Map<string, Set<string>>>();
  for (const receiver of eligible) {
    const source = ieSources.get(receiver.electionYear);
    let names = receiver.candidateAliases;
    if (source) try { names = qualifyNewHampshireReportedReceiver(receiver,source.base).candidateAliases; } catch { /* The per-component path records the hold. */ }
    const cycleOwners = owners.get(receiver.electionYear) ?? new Map<string,Set<string>>();
    for (const name of names) {
      const alias = normalizeNewHampshireCandidateAlias(name), ids = cycleOwners.get(alias) ?? new Set<string>();
      ids.add(`${receiver.candidateId}:${receiver.electionId}`); cycleOwners.set(alias, ids);
    }
    owners.set(receiver.electionYear,cycleOwners);
  }
  const ambiguousByYear = new Map([...owners].map(([year,cycleOwners])=>[year,new Set([
    ...[...cycleOwners].filter(([,ids])=>ids.size>1).map(([alias])=>alias),
    ...(ieSources.get(year)?newHampshireAmbiguousSourceTargetAliases(ieSources.get(year)!.base):[])])]));
  for (const receiver of selected) {
    if (!result.dryRun) {
      if (!await recordNewHampshireReportedAttempt({ db: options.db, receiver, now: new Date(), gates })) { result.attemptRejectedCount++; continue; }
      result.attemptedCount++;
    }
    if (gates.ie) {
      const source = ieSources.get(receiver.electionYear);
      if (!source) result.ieHeldCount++;
      else try {
        const context = qualifyNewHampshireReportedReceiver(receiver, source.base), ambiguousAliases = ambiguousByYear.get(receiver.electionYear);
        const aggregation = aggregateNewHampshireReportedIe({ source, candidateAliases: context.candidateAliases, ambiguousAliases });
        result.ieQualifiedCount++;
        if (aggregation.supportTotalCents + aggregation.opposeTotalCents > 0) result.iePositiveCandidateCount++;
        if (!result.dryRun) { await writeNewHampshireReportedComponent({ db: options.db, receiver, source, ambiguousAliases }); result.ieWrittenCount++; }
      } catch (error) { result.ieHeldCount++; hold(error); }
    }
    if (gates.committee) {
      const sourceScope = { cacheDir: options.cacheDir, kind: "committee" as const, electionYear: receiver.electionYear, filingEntityId: receiver.filingEntityId };
      let source = await read(() => readNewHampshireReportedSource(sourceScope));
      let base = bases.get(receiver.electionYear);
      if (producer && base && (options.refresh || !source || Date.now() - Date.parse(source.sourceRetrievedAt) >= 86_400_000)) {
        try { source = await producer.refreshComponent({ ...sourceScope, base: base.reference }); }
        catch (error) {
          if(error instanceof NewHampshireReportedSourceError&&error.code==="registration_inventory_changed"){
            try{base=await producer.refreshBase(receiver.electionYear);bases.set(receiver.electionYear,base);
              if(base)source=await producer.refreshComponent({...sourceScope,base:base.reference});}
            catch(retryError){hold(retryError,true);}
          }else hold(error,true);
        }
      }
      if (!source) result.committeeHeldCount++;
      else try {
        qualifyNewHampshireReportedReceiver(receiver, source.base);
        const aggregation = aggregateNewHampshireReportedCommitteeReceipts(source); result.committeeQualifiedCount++;
        if (aggregation.totalAmountCents > 0) result.committeePositiveCandidateCount++;
        if (!result.dryRun) { await writeNewHampshireReportedComponent({ db: options.db, receiver, source }); result.committeeWrittenCount++; }
      } catch (error) { result.committeeHeldCount++; hold(error); }
    }
  }
  return result;
}
