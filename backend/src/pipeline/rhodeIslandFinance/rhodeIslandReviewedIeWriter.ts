import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertSnapshotDbIsNotPoolClient } from "../finance/financeWriterPoolGuard.js";
import { loadRhodeIslandCanonicalCashContext } from "./rhodeIslandCommitteeCashContext.js";
import { assertRhodeIslandReviewedIePacket, rhodeIslandReviewedIeContextMatches,
  type RhodeIslandReviewedIePacket } from "./rhodeIslandReviewedCf8Source.js";

type Db = Pick<Pool, "query"> & { connect: () => Promise<PoolClient> };
function check(v: unknown, reason: string): asserts v { if (!v) throw new Error(`Rhode Island reviewed IE writer: ${reason}`); }
export const rhodeIslandReviewedIeSpenderKey = (name: string) =>
  createHash("sha256").update(name.trim().replace(/\s+/gu, " ").toUpperCase()).digest("hex");

/** One reviewed filer family, independently of receiving links and money.
 * Only loader-minted packets may enter. Accepted original clocks are monotone;
 * an identical packet is a no-op. All report/line replacement is atomic and
 * globally owned single-target GUIDs cannot move to another candidate/family.
 */
export async function writeRhodeIslandReviewedIePacket(input: {
  db: Db; packet: RhodeIslandReviewedIePacket; reviewedMapping: true;
}): Promise<{ status: "written" | "unchanged"; familyId: string; reportsWritten: number; occurrencesWritten: number }> {
  assertRhodeIslandReviewedIePacket(input.packet);
  check(input.reviewedMapping === true, "manual_mapping_review_required");
  assertSnapshotDbIsNotPoolClient("Rhode Island reviewed IE", input.db);
  const p = input.packet, c = p.context, spenderKey = rhodeIslandReviewedIeSpenderKey(p.spenderName);
  const tx = await input.db.connect();
  try {
    await tx.query("BEGIN");
    const locks = [`ri-ie:context:${c.candidateId}:${c.electionId}`, `ri-ie:filer:${spenderKey}:${c.electionYear}`,
      ...p.reports.map(r => `ri-ie:guid:${r.filingGuid}`)].sort();
    for (const value of locks) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [value]);
    const actual = await loadRhodeIslandCanonicalCashContext(tx, c.candidateId, c.electionId, true);
    check(rhodeIslandReviewedIeContextMatches(actual, c), "canonical_context_changed");
    const previous = await tx.query<{ id: string; newer: boolean; equal: boolean; source_digest: string }>(`
      SELECT id::text,observed_at>$5::timestamptz newer,observed_at=$5::timestamptz equal,source_digest
      FROM public.ri_reported_ie_families
      WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND election_year=$3 AND spender_key=$4 FOR UPDATE`,
    [c.candidateId,c.electionId,c.electionYear,spenderKey,p.observedAt]);
    check(previous.rows.length <= 1, "family_ownership_ambiguous");
    const prior = previous.rows[0];
    check(!prior?.newer, "older_source_clock");
    if (prior?.equal) {
      check(prior.source_digest === p.sourceDigest, "same_clock_source_conflict");
      await tx.query("COMMIT");
      return { status: "unchanged", familyId: prior.id, reportsWritten: 0, occurrencesWritten: 0 };
    }
    const owners = await tx.query<{ family_id: string }>(`
      SELECT family_id::text FROM public.ri_reported_ie_reports WHERE filing_guid=ANY($1::uuid[]) ORDER BY filing_guid FOR UPDATE`,
    [p.reports.map(r => r.filingGuid)]);
    check(owners.rows.every(r => r.family_id === prior?.id), "single_target_report_owned_elsewhere");
    const values = [c.candidateId,c.electionId,c.electionYear,spenderKey,p.spenderName,c.candidateName,c.officeScope,c.officeName,c.district,
      p.observedAt,p.completedAt,p.sourceDigest,p.sourceUrl,p.sourceReportCount,p.reports.length,p.occurrenceCount,p.supportCents,p.opposeCents];
    const family = await tx.query<{ id: string }>(`
      INSERT INTO public.ri_reported_ie_families(candidate_id,election_id,election_year,spender_key,spender_name,candidate_name,
        office_scope,office_name,district,observed_at,completed_at,source_digest,source_url,source_report_count,ie_report_count,
        occurrence_count,support_cents,oppose_cents)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$16,$17::bigint,$18::bigint)
      ON CONFLICT(candidate_id,election_id,election_year,spender_key) DO UPDATE SET
        spender_name=EXCLUDED.spender_name,candidate_name=EXCLUDED.candidate_name,office_scope=EXCLUDED.office_scope,
        office_name=EXCLUDED.office_name,district=EXCLUDED.district,observed_at=EXCLUDED.observed_at,completed_at=EXCLUDED.completed_at,
        source_digest=EXCLUDED.source_digest,source_url=EXCLUDED.source_url,source_report_count=EXCLUDED.source_report_count,
        ie_report_count=EXCLUDED.ie_report_count,occurrence_count=EXCLUDED.occurrence_count,support_cents=EXCLUDED.support_cents,
        oppose_cents=EXCLUDED.oppose_cents RETURNING id::text`, values);
    check(family.rows.length === 1, "family_write_identity");
    const id = family.rows[0]!.id;
    await tx.query("DELETE FROM public.ri_reported_ie_reports WHERE family_id=$1::uuid", [id]);
    for (const report of p.reports) {
      await tx.query(`INSERT INTO public.ri_reported_ie_reports(filing_guid,family_id,filed_date,source_url,source_sha256,
        reported_spender_name,reported_candidate_name,stance,reported_ytd_cents,occurrence_count,report_cents)
        VALUES($1::uuid,$2::uuid,$3::date,$4,$5,$6,$7,$8,$9::bigint,$10,$11::bigint)`,
      [report.filingGuid,id,report.filedDate,report.sourceUrl,report.sourceSha256,report.reportedSpenderName,report.reportedCandidateName,
        report.supportOppose,report.reportedYearToDateCents,report.lines.length,report.lines.reduce((n,r) => n+r.amountCents,0)]);
      for (const line of report.lines) await tx.query(`INSERT INTO public.ri_reported_ie_lines
        (filing_guid,line_number,disbursement_date,amount_cents) VALUES($1::uuid,$2,$3::date,$4::bigint)`,
      [report.filingGuid,line.lineNumber,line.disbursementDate,line.amountCents]);
    }
    await tx.query("COMMIT");
    return { status: "written", familyId: id, reportsWritten: p.reports.length, occurrencesWritten: p.occurrenceCount };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {}); throw error;
  } finally { tx.release(); }
}
