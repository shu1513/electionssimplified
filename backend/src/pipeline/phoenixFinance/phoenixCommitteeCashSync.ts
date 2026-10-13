import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  discoverPhoenixReportObservation,
  fetchPhoenixReportPdf,
} from "./phoenixEfilingClient.js";
import { extractPhoenixPdfPages } from "./phoenixReportPdfParser.js";
import {
  qualifyPhoenixCommitteeCash,
  type PhoenixCommitteeCashObservation,
} from "./phoenixCommitteeCashQualification.js";
import { storePhoenixCommitteeCash } from "./phoenixCommitteeCashWriter.js";

// Include the interpretation version in retained donor-generation identities.
const METHODOLOGY_VERSION = "phx-pac-cash-2026.1";

/** Always acquire genuine opening/closing publications, without immutable-cache assumptions. */
async function acquire(input: {
  copId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ observation: PhoenixCommitteeCashObservation; digest: string; observedAt: Date }> {
  const publication = await discoverPhoenixReportObservation(input);
  let observedAt = new Date();
  const hash = createHash("sha256").update(JSON.stringify(publication.grids));
  const reports: PhoenixCommitteeCashObservation["reports"][number][] = [];
  for (const ref of publication.refs) {
    const bytes = await fetchPhoenixReportPdf({
      reportPackageId: ref.reportPackageId,
      timeoutMs: input.timeoutMs,
      fetchImpl: input.fetchImpl,
    });
    // Capture source body completion before asynchronous PDF processing.
    observedAt = new Date();
    hash.update(ref.reportPackageId).update(bytes);
    reports.push({
      reportPackageId: ref.reportPackageId,
      pages: await extractPhoenixPdfPages(bytes),
    });
  }
  return {
    observation: { grids: publication.grids, reports },
    digest: hash.digest("hex"),
    observedAt,
  };
}

export async function syncPhoenixCommitteeCash(input: {
  db: Pick<Pool, "query" | "connect">;
  candidateId: string;
  electionId: string;
  electionYear: number;
  copId: string;
  committeeName: string;
  officeSought: string;
  portalCycleStart: string;
  portalCycleEnd: string;
  dryRun?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam for unchanged source observations, not financial amounts. */
  acquireObservation?: typeof acquire;
}): Promise<{
  donorCount: number;
  contributionCount: number;
  netCents: number;
  reportedThrough: string;
  written: boolean;
}> {
  const acquireObservation = input.acquireObservation ?? acquire;
  const before = await acquireObservation(input);
  const after = await acquireObservation(input);
  const cash = qualifyPhoenixCommitteeCash({
    copId: input.copId,
    committeeName: input.committeeName,
    officeSought: input.officeSought,
    portalCycleStart: input.portalCycleStart,
    portalCycleEnd: input.portalCycleEnd,
    before: before.observation,
    after: after.observation,
  });
  const captureDigest = createHash("sha256")
    .update(METHODOLOGY_VERSION)
    .update(before.digest)
    .update(after.digest)
    .digest("hex");
  const netCents = cash.positions.reduce((sum, position) => {
    const next = sum + position.netCents;
    if (!Number.isSafeInteger(next))
      throw new Error("Unsafe Phoenix PAC net total");
    return next;
  }, 0);
  if (!input.dryRun) {
    await storePhoenixCommitteeCash({
      ...input,
      cash,
      captureDigest,
      observedAt: after.observedAt,
    });
  }
  return {
    donorCount: cash.positions.length,
    contributionCount: cash.positions.reduce(
      (sum, position) => sum + position.contributionCount,
      0,
    ),
    netCents,
    reportedThrough: cash.reportedThrough,
    written: !input.dryRun,
  };
}
