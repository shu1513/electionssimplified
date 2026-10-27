import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { loadRhodeIslandCanonicalCashContext, type RhodeIslandCanonicalCashContext } from "./rhodeIslandCommitteeCashContext.js";
import { rhodeIslandOrganizationNameMatchesCandidate } from "./rhodeIslandCandidateCommitteeResolver.js";
import { readRhodeIslandCf8FilerCache } from "./rhodeIslandCf8FilerCache.js";
import { validateRhodeIslandReviewedCf8, type RhodeIslandReviewedCf8Draft, type RhodeIslandReviewedCf8Report } from "./rhodeIslandReviewedCf8.js";

const packets = new WeakSet<object>();
const key = (s: string) => s.trim().replace(/\s+/gu, " ").toUpperCase();
function check(v: unknown, reason: string): asserts v { if (!v) throw new Error(`Rhode Island reviewed IE source: ${reason}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
export type RhodeIslandReviewedIeContext = {
  candidateId: string; electionId: string; candidateName: string; electionYear: number;
  officeScope: string; officeName: string; district: string | null;
};
export type RhodeIslandReviewedIePacket = Readonly<RhodeIslandReviewedCf8Draft & {
  context: RhodeIslandReviewedIeContext;
  observedAt: string;
  completedAt: string;
  sourceDigest: string;
  sourceReportCount: number;
  sourceUrl: string;
}>;

/** Same canonical identity/district guard at packet selection and write lock. */
export function rhodeIslandReviewedIeContextMatches(actual: RhodeIslandCanonicalCashContext | null,
  expected: RhodeIslandReviewedIeContext): boolean {
  if (!actual || actual.candidate_name !== expected.candidateName || actual.election_year !== expected.electionYear ||
    actual.office_scope !== expected.officeScope || actual.office_name !== expected.officeName || actual.district !== expected.district) return false;
  if (actual.office_scope === "statewide") return actual.district_type === "statewide" && actual.geoid_compact === "44" && actual.district === null;
  const seat = Number(actual.geoid_compact.slice(2));
  return (actual.office_scope === "state_upper" || actual.office_scope === "state_lower") &&
    actual.district_type === actual.office_scope && /^44\d{3}$/u.test(actual.geoid_compact) && String(seat) === actual.district &&
    seat >= 1 && seat <= (actual.office_scope === "state_upper" ? 38 : 75);
}

/** Explicit reviewed-paper import, following RI's curated CF8 design. The
 * operator must read every report, classify purpose/stance, verify body payer
 * aliases and the official ballot mapping before supplying the transcription.
 * Review declarations are not OCR claims. Complete current index/scan bytes,
 * hashes, original clocks and canonical ownership are rechecked here.
 */
export async function loadRhodeIslandReviewedIePacket(input: {
  db: Pick<Pool | PoolClient, "query">;
  cacheDir: string; candidateId: string; electionId: string; electionYear: number;
  spenderName: string; reviewedSpenderNames: readonly string[]; reports: readonly RhodeIslandReviewedCf8Report[];
  reviewedMapping: true;
}): Promise<RhodeIslandReviewedIePacket> {
  check(input.reviewedMapping === true, "manual_mapping_review_required");
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  check(uuid.test(input.candidateId) && uuid.test(input.electionId), "canonical_identity");
  const actual = await loadRhodeIslandCanonicalCashContext(input.db, input.candidateId, input.electionId);
  check(actual, "current_canonical_context");
  const context: RhodeIslandReviewedIeContext = { candidateId: input.candidateId, electionId: input.electionId,
    candidateName: actual.candidate_name, electionYear: actual.election_year, officeScope: actual.office_scope,
    officeName: actual.office_name, district: actual.district };
  check(context.electionYear === input.electionYear && rhodeIslandReviewedIeContextMatches(actual, context), "canonical_context_or_district");
  const cache = await readRhodeIslandCf8FilerCache(input);
  check(Date.now() - Date.parse(cache.completedAt) <= 48 * 60 * 60 * 1000, "mutable_source_refresh_required");
  const draft = validateRhodeIslandReviewedCf8({ electionYear: input.electionYear, spenderName: input.spenderName,
    asOfDate: cache.indexObservedAt.slice(0, 10), family: cache.family, reports: input.reports });
  check(Array.isArray(input.reviewedSpenderNames) && input.reviewedSpenderNames.length > 0 && input.reviewedSpenderNames.length <= 20 &&
    input.reviewedSpenderNames.every(n => typeof n === "string" && n.trim() && n.length <= 500 && !/[\x00-\x1f\x7f]/u.test(n)), "explicit_reviewed_payer_names");
  const aliases = new Set(input.reviewedSpenderNames.map(key));
  check(aliases.size === input.reviewedSpenderNames.length && aliases.has(key(input.spenderName)), "explicit_reviewed_payer_names");
  for (const report of draft.reports) {
    const original = cache.scans.find(s => s.guid === report.filingGuid);
    check(original && original.sha256 === report.sourceSha256 && original.row.sourceUrl === report.sourceUrl && original.pageCount > 0,
      "reviewed_original_changed");
    check(aliases.has(key(report.reportedSpenderName)), "unreviewed_payer_body_name");
    check(rhodeIslandOrganizationNameMatchesCandidate(report.reportedCandidateName, context.candidateName), "reviewed_target_conflict");
  }
  const value = { ...draft, context, observedAt: cache.observedAt, completedAt: cache.completedAt,
    sourceReportCount: cache.scans.length, sourceUrl: draft.reports[0]!.sourceUrl,
    sourceDigest: createHash("sha256").update(JSON.stringify({ source: cache.sourceDigest, context, draft })).digest("hex") };
  const packet = freeze(value); packets.add(packet); return packet;
}

export function assertRhodeIslandReviewedIePacket(value: RhodeIslandReviewedIePacket): void {
  check(value && typeof value === "object" && packets.has(value) && Object.isFrozen(value), "cache_backed_packet_required");
}
