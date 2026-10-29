import { loadPhoenixReviewedEfdPacket } from "./phoenixReviewedEfdSource.js";
import { writePhoenixReviewedEfdPacket } from "./phoenixReviewedEfdWriter.js";

/** Normal explicit operator sync for scanned EFDs. Review input is supplied
 * in memory; only genuine originals and validated production DB rows persist. */
export async function syncPhoenixReviewedEfd(input: Parameters<typeof loadPhoenixReviewedEfdPacket>[0] & {
  db: Parameters<typeof writePhoenixReviewedEfdPacket>[0]["db"];
}) {
  const packet = await loadPhoenixReviewedEfdPacket(input);
  const result = await writePhoenixReviewedEfdPacket({ db: input.db, packet, reviewedMapping: input.reviewedMapping });
  return { ...result, sourceReportCount: packet.reports.length, sourceObservedAt: packet.observedAt,
    sourceCompletedAt: packet.completedAt, overallOutsideTotalsKnown: false as const };
}
