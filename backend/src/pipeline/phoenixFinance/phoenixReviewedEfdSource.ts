import type { Pool, PoolClient } from "pg";
import { isPhoenixReviewedEfdRawRefreshEnabled, isPhoenixReviewedEfdSyncEnabled } from "../../config/featureFlags.js";
import { phoenixPersonNameMatchesCandidate } from "./phoenixCandidateCommitteeResolver.js";
import { efdCheck, PhoenixEfdHold, validatePhoenixReviewedEfd, phoenixEfdObservationDay,
  type PhoenixReviewedEfdDraft, type PhoenixReviewedEfdReport } from "./phoenixReviewedEfd.js";
import { loadPhoenixEfdContext, type PhoenixEfdContext } from "./phoenixReviewedEfdContext.js";
import { readPhoenixEfdOriginals, refreshPhoenixEfdOriginals } from "./phoenixReviewedEfdOriginals.js";

const packets = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export type PhoenixReviewedEfdPacket = Readonly<PhoenixReviewedEfdDraft & {
  context: PhoenixEfdContext; observedAt: string; completedAt: string; sourceDigest: string;
}>;

/** Explicit reviewed-paper sync, independently of receiving committee links.
 * Financial review values remain in RAM until the production writer. A scan
 * hash binds that review to the whole source; declarations are not OCR. */
export async function loadPhoenixReviewedEfdPacket(input: {
  db: Pick<Pool | PoolClient, "query">; cacheDir?: string; candidateId: string; electionId: string;
  spenderName: string; reports: readonly PhoenixReviewedEfdReport[]; reviewedMapping: true;
  fetchImpl?: typeof fetch; requestIntervalMs?: number;
}): Promise<PhoenixReviewedEfdPacket> {
  efdCheck(isPhoenixReviewedEfdSyncEnabled(), "reviewed_sync_disabled");
  efdCheck(input.reviewedMapping === true, "explicit_manual_mapping_review_required");
  const context = await loadPhoenixEfdContext(input.db, input.candidateId, input.electionId);
  const sourceInput = { cacheDir: input.cacheDir, spenderName: input.spenderName, electionDate: context.electionDate };
  let originals = await readPhoenixEfdOriginals(sourceInput);
  if (isPhoenixReviewedEfdRawRefreshEnabled()) {
    try { originals = await refreshPhoenixEfdOriginals({ ...sourceInput, fetchImpl: input.fetchImpl, requestIntervalMs: input.requestIntervalMs, replay: originals }); }
    catch (error) {
      // An unavailable fetch may replay a genuine recently observed edition,
      // provided nothing the failed refresh did obtain contradicts it.
      // Changed content/census/ballot is never hidden behind cached evidence.
      if (!(error instanceof PhoenixEfdHold) || error.reason !== "source_unavailable" || !originals) throw error;
    }
  }
  efdCheck(originals, "recent_whole_original_cache_required");
  const checked = validatePhoenixReviewedEfd({ spenderName: input.spenderName, electionDate: context.electionDate,
    asOfDate: phoenixEfdObservationDay(originals.observedAt), family: originals.family, reports: input.reports });
  const official = originals.ballot.filter(row => row.certifiedDate !== null && phoenixPersonNameMatchesCandidate(row.name, context.candidateName));
  efdCheck(official.length === 1 && official[0]!.district === context.districtNumber, "official_ballot_context_conflict");
  for (const report of checked.reports) {
    const scan = originals.scans.find(s => s.row.documentId === report.documentId);
    efdCheck(scan && scan.sha256 === report.sourceSha256 && scan.pageCount === report.reviewedPageCount,
      "reviewed_whole_original_changed");
    efdCheck(phoenixPersonNameMatchesCandidate(report.reportedCandidateName, context.candidateName) &&
      (report.reportedDistrictNumber === null || report.reportedDistrictNumber === context.districtNumber), "reported_target_conflict");
  }
  const value = freeze({ ...checked, context, observedAt: originals.observedAt,
    completedAt: originals.completedAt, sourceDigest: originals.sourceDigest });
  packets.add(value); return value;
}
export function assertPhoenixReviewedEfdPacket(value: PhoenixReviewedEfdPacket): void {
  efdCheck(value && typeof value === "object" && packets.has(value) && Object.isFrozen(value), "whole_source_packet_required");
}
