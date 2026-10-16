import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isNorthCarolinaNcsbeRawDataRefreshEnabled, isNorthCarolinaReportedCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import { discoverNcsbeAcquisitionCommittees } from "./northCarolinaNcsbeAcquisitionDiscovery.js";
import { DEFAULT_NCSBE_REQUEST_SPACING_MS } from "./northCarolinaNcsbeClient.js";
import { createNorthCarolinaReportedReceiptDiscoveryTransport } from "./northCarolinaReportedReceiptDiscoveryTransport.js";
import { acquireNorthCarolinaReportedReceiptSource } from "./northCarolinaReportedReceiptSourceAcquisition.js";
import { NorthCarolinaReportedReceiptSourceError, readNorthCarolinaReportedReceiptSource, resolveNorthCarolinaReportedReceiptCacheDir } from "./northCarolinaReportedReceiptSourceCache.js";
import { listDueNorthCarolinaReportedReceiptFinance, recordNorthCarolinaReportedReceiptFinanceAttempt } from "./northCarolinaReportedReceiptFinanceDueList.js";
import { NorthCarolinaReportedReceiptFinanceWriteError, validateNorthCarolinaReportedReceiptPacket, writeNorthCarolinaReportedReceiptComponent } from "./northCarolinaReportedReceiptFinanceWriter.js";
import type { Qualified } from "./northCarolinaReportedReceiptSourceTypes.js";

export type NorthCarolinaReportedReceiptFinanceBatchOptions = {
  db: Pool; now?: Date; dryRun?: boolean; force?: boolean; refresh?: boolean;
  maxCandidates?: number; staleAfterDays?: number; electionLookbackDays?: number; electionLookaheadDays?: number;
  electionYear?: number; cacheDir?: string;
};
export type NorthCarolinaReportedReceiptFinanceBatchResult = {
  enabled: boolean; dryRun: boolean; now: string; eligibleCount: number; totalDueRows: number;
  attemptedCount: number; qualifiedCount: number; writtenCount: number; heldCount: number;
  sourceRefreshedCount: number; acquisitionStopped: boolean;
};
function integer(value: number, minimum: number, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid North Carolina reported receipt batch option");
  return value;
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NorthCarolinaReportedReceiptSourceError();
  await chmod(path, 0o700);
}
// The ordinary discovery cache retains its native format. Its unique pass
// directory is never renamed, and all retained files remain private.
async function restrictDiscovery(path: string, maximum: number): Promise<void> {
  let count = 0;
  async function visit(file: string): Promise<void> {
    if (++count > maximum) throw new NorthCarolinaReportedReceiptSourceError();
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new NorthCarolinaReportedReceiptSourceError();
    if (stat.isDirectory()) {
      await chmod(file, 0o700);
      for (const name of await readdir(file)) await visit(join(file, name));
    } else if (stat.isFile()) await chmod(file, 0o600);
    else throw new NorthCarolinaReportedReceiptSourceError();
  }
  await visit(path);
}

/** Independent ordinary entry point. Failed acquisition never falls back to
 * an older capture as newly observed money; the writer owns current context. */
export async function syncDueNorthCarolinaReportedReceiptFinance(options: NorthCarolinaReportedReceiptFinanceBatchOptions): Promise<NorthCarolinaReportedReceiptFinanceBatchResult> {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid North Carolina reported receipt batch clock");
  const maxCandidates = integer(options.maxCandidates ?? 25, 1, 100_000);
  const staleAfterDays = integer(options.staleAfterDays ?? 7, 1);
  const electionLookbackDays = integer(options.electionLookbackDays ?? 1, 0);
  const electionLookaheadDays = integer(options.electionLookaheadDays ?? 730, 0);
  if (options.electionYear !== undefined) integer(options.electionYear, 2000, 2100);
  if (options.refresh !== undefined && typeof options.refresh !== "boolean") throw new Error("Invalid North Carolina reported receipt batch option");
  const result: NorthCarolinaReportedReceiptFinanceBatchResult = { enabled: isNorthCarolinaReportedCommitteeReceiptsEnabled(),
    dryRun: options.dryRun === true, now: now.toISOString(), eligibleCount: 0, totalDueRows: 0,
    attemptedCount: 0, qualifiedCount: 0, writtenCount: 0, heldCount: 0, sourceRefreshedCount: 0, acquisitionStopped: false };
  if (!result.enabled) return result;
  const cacheDir = resolveNorthCarolinaReportedReceiptCacheDir(options.cacheDir);
  const due = await listDueNorthCarolinaReportedReceiptFinance(options.db, { now, maxCandidates, staleAfterDays,
    electionLookbackDays, electionLookaheadDays, refresh: options.refresh, electionYear: options.electionYear, cacheDir });
  result.eligibleCount = due.eligibleCount; result.totalDueRows = due.totalDueRows;
  const rawRefresh = isNorthCarolinaNcsbeRawDataRefreshEnabled();
  const packets = new Map<string, Qualified | null>();
  const discoveryDir = rawRefresh ? join(cacheDir, "discovery", `pass-${randomUUID()}`) : null;
  if (discoveryDir) {
    await privateDirectory(cacheDir); await privateDirectory(join(cacheDir, "discovery")); await privateDirectory(discoveryDir);
  }
  const transport = discoveryDir ? createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: discoveryDir }) : null;
  let previousAcquisition = false;
  try {
    for (const receiver of due.rows) {
      result.attemptedCount++;
      if (!result.dryRun && !await recordNorthCarolinaReportedReceiptFinanceAttempt({ db: options.db, receiver, now: new Date(), cacheDir })) {
        result.heldCount++; continue;
      }
      try {
        const key = JSON.stringify([receiver.committeeId, receiver.electionYear]);
        if (!packets.has(key)) {
          packets.set(key, null);
          if (rawRefresh) {
            if (result.acquisitionStopped) { result.heldCount++; continue; }
            // Separate ordinary/discovery transports must also respect the
            // portal's minimum spacing at their request boundaries.
            if (previousAcquisition) await delay(DEFAULT_NCSBE_REQUEST_SPACING_MS);
            previousAcquisition = true;
            const found = await discoverNcsbeAcquisitionCommittees({ transport: transport!, cacheDir: discoveryDir!, force: true, roster: [{
              candidateId: receiver.candidateId, electionId: receiver.electionId, candidateName: receiver.candidateName,
              electionYear: receiver.electionYear, officeScope: receiver.officeScope, officeName: receiver.officeName,
              district: receiver.district, linkedCommitteeId: receiver.committeeId, linkedCommitteeName: receiver.committeeName }] });
            if (found.searchFailures.length) throw new NorthCarolinaReportedReceiptSourceError();
            if (found.committees.length !== 1 || found.ogidFailures.length || found.committees[0]!.sboeId !== receiver.committeeId)
              throw new NorthCarolinaReportedReceiptSourceError("held", "receiving_committee");
            await delay(DEFAULT_NCSBE_REQUEST_SPACING_MS);
            await acquireNorthCarolinaReportedReceiptSource({ cacheDir, receivingCommitteeId: receiver.committeeId,
              electionYear: receiver.electionYear, orgGroupId: found.committees[0]!.orgGroupId });
            result.sourceRefreshedCount++;
          }
          packets.set(key, await readNorthCarolinaReportedReceiptSource({ cacheDir,
            receivingCommitteeId: receiver.committeeId, electionYear: receiver.electionYear }));
        }
        const packet = packets.get(key);
        if (!packet) { result.heldCount++; continue; }
        validateNorthCarolinaReportedReceiptPacket({ packet, receivingCommitteeId: receiver.committeeId,
          electionYear: receiver.electionYear, syncedAt: new Date() });
        result.qualifiedCount++;
        if (!result.dryRun) {
          await writeNorthCarolinaReportedReceiptComponent({ db: options.db, receiver, packet });
          result.writtenCount++;
        }
      } catch (error) {
        if (error instanceof NorthCarolinaReportedReceiptSourceError) {
          if (rawRefresh && error.code === "unavailable") result.acquisitionStopped = true;
        } else if (!(error instanceof NorthCarolinaReportedReceiptFinanceWriteError)) throw error;
        result.heldCount++;
      } finally {
        if (!result.dryRun) await recordNorthCarolinaReportedReceiptFinanceAttempt({ db: options.db, receiver, now: new Date(), cacheDir });
      }
    }
    return result;
  } finally {
    if (discoveryDir) await restrictDiscovery(discoveryDir, 6 * maxCandidates + 8);
  }
}
