import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { assertSnapshotDbIsNotPoolClient } from "../finance/financeWriterPoolGuard.js";
import { efdCheck, efdNameKey, PHOENIX_EFD_INDEX_URL, type PhoenixReviewedEfdReport } from "./phoenixReviewedEfd.js";
import { loadPhoenixEfdContext, phoenixEfdContextMatches } from "./phoenixReviewedEfdContext.js";
import { assertPhoenixReviewedEfdPacket, type PhoenixReviewedEfdPacket } from "./phoenixReviewedEfdSource.js";

type Db = Pick<Pool, "query"> & { connect(): Promise<PoolClient> };
export type StoredPhoenixEfdReport = {
  document_id: string; source_url: string; source_sha256: string; filed_date: string;
  reported_spender_name: string; reported_candidate_name: string; reported_office: string;
  reported_district_number: number | null; vendor_name: string; expenditure_date: string;
  amount_cents: string; stance: "support" | "oppose"; reviewed_page_count: number;
};
export const phoenixEfdReportProjection = (report: PhoenixReviewedEfdReport): StoredPhoenixEfdReport => ({
  document_id: report.documentId, source_url: report.sourceUrl, source_sha256: report.sourceSha256,
  filed_date: report.filedDate, reported_spender_name: report.reportedSpenderName,
  reported_candidate_name: report.reportedCandidateName, reported_office: report.reportedOffice,
  reported_district_number: report.reportedDistrictNumber, vendor_name: report.vendorName,
  expenditure_date: report.expenditureDate, amount_cents: String(report.amountCents),
  stance: report.supportOppose, reviewed_page_count: report.reviewedPageCount,
});

/** One whole reviewed filer family, with globally owned single-target paper
 * references. No legacy direct, donor or outside snapshot is rewritten. */
export async function writePhoenixReviewedEfdPacket(input: {
  db: Db; packet: PhoenixReviewedEfdPacket; reviewedMapping: true;
}): Promise<{ status: "written" | "unchanged"; reportsWritten: number }> {
  assertPhoenixReviewedEfdPacket(input.packet);
  efdCheck(input.reviewedMapping === true, "explicit_manual_mapping_review_required");
  assertSnapshotDbIsNotPoolClient("Phoenix reviewed EFD", input.db);
  const p = input.packet, c = p.context, spenderKey = efdNameKey(p.spenderName);
  const tx = await input.db.connect();
  try {
    await tx.query("BEGIN");
    const locks = [`phx-efd:context:${c.candidateId}:${c.electionId}`, `phx-efd:filer:${spenderKey}:${c.electionYear}`,
      ...p.reports.map(r => `phx-efd:document:${r.documentId}`), ...p.reports.map(r => `phx-efd:url:${r.sourceUrl}`)].sort();
    for (const lock of locks) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [lock]);
    efdCheck(phoenixEfdContextMatches(await loadPhoenixEfdContext(tx, c.candidateId, c.electionId, true), c), "canonical_context_changed");
    const previous = await tx.query<{
      id: string; newer: boolean; equal: boolean; source_digest: string; support_cents: string;
      oppose_cents: string; occurrence_count: number; canonical_context: unknown; spender_name: string;
    }>(`SELECT id::text,(observed_at>$5::timestamptz OR completed_at>$6::timestamptz) newer,observed_at=$5::timestamptz equal,
      source_digest,support_cents::text,oppose_cents::text,occurrence_count,canonical_context,spender_name
      FROM public.phx_reported_efd_families WHERE candidate_id=$1::uuid AND election_id=$2::uuid
        AND election_year=$3 AND spender_name_key=$4 FOR UPDATE`,
    [c.candidateId, c.electionId, c.electionYear, spenderKey, p.observedAt, p.completedAt]);
    efdCheck(previous.rows.length <= 1, "family_ownership_ambiguous");
    const prior = previous.rows[0];
    efdCheck(!prior?.newer, "older_source_clock");
    if (prior?.equal) {
      const stored = await tx.query<StoredPhoenixEfdReport>(`SELECT document_id,source_url,source_sha256,filed_date::text,
        reported_spender_name,reported_candidate_name,reported_office,reported_district_number,vendor_name,
        expenditure_date::text,amount_cents::text,stance,reviewed_page_count
        FROM public.phx_reported_efd_reports WHERE family_id=$1::uuid ORDER BY document_id`, [prior.id]);
      efdCheck(prior.source_digest === p.sourceDigest && prior.support_cents === String(p.supportCents) &&
        prior.oppose_cents === String(p.opposeCents) && prior.occurrence_count === p.occurrenceCount &&
        prior.spender_name === p.spenderName && isDeepStrictEqual(prior.canonical_context, c) &&
        isDeepStrictEqual(stored.rows, [...p.reports].sort((a, b) => a.documentId.localeCompare(b.documentId)).map(phoenixEfdReportProjection)),
      "same_clock_review_conflict");
      await tx.query("COMMIT"); return { status: "unchanged", reportsWritten: 0 };
    }
    if (prior) {
      const accepted = await tx.query<{ document_id: string }>(`SELECT document_id FROM public.phx_reported_efd_reports
        WHERE family_id=$1::uuid ORDER BY document_id FOR UPDATE`, [prior.id]);
      const incoming = new Set(p.reports.map(r => r.documentId));
      efdCheck(accepted.rows.every(row => incoming.has(row.document_id)), "accepted_document_disappeared_without_lineage");
    }
    const owners = await tx.query<{ family_id: string }>(`SELECT family_id::text FROM public.phx_reported_efd_reports
      WHERE document_id=ANY($1::text[]) OR source_url=ANY($2::text[]) ORDER BY document_id FOR UPDATE`,
    [p.reports.map(r => r.documentId), p.reports.map(r => r.sourceUrl)]);
    efdCheck(owners.rows.every(row => row.family_id === prior?.id), "single_target_report_owned_elsewhere");
    const family = await tx.query<{ id: string }>(`INSERT INTO public.phx_reported_efd_families
      (candidate_id,election_id,election_year,spender_name,spender_name_key,canonical_context,observed_at,completed_at,
       source_digest,source_url,occurrence_count,support_cents,oppose_cents)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz,$9,$10,$11,$12::bigint,$13::bigint)
      ON CONFLICT(candidate_id,election_id,election_year,spender_name_key) DO UPDATE SET
        spender_name=EXCLUDED.spender_name,canonical_context=EXCLUDED.canonical_context,observed_at=EXCLUDED.observed_at,
        completed_at=EXCLUDED.completed_at,source_digest=EXCLUDED.source_digest,source_url=EXCLUDED.source_url,
        occurrence_count=EXCLUDED.occurrence_count,support_cents=EXCLUDED.support_cents,oppose_cents=EXCLUDED.oppose_cents
      RETURNING id::text`, [c.candidateId, c.electionId, c.electionYear, p.spenderName, spenderKey, JSON.stringify(c),
      p.observedAt, p.completedAt, p.sourceDigest, PHOENIX_EFD_INDEX_URL, p.occurrenceCount, p.supportCents, p.opposeCents]);
    efdCheck(family.rows.length === 1, "family_write_identity");
    const id = family.rows[0]!.id;
    await tx.query("DELETE FROM public.phx_reported_efd_reports WHERE family_id=$1::uuid", [id]);
    for (const r of p.reports) await tx.query(`INSERT INTO public.phx_reported_efd_reports
      (document_id,family_id,source_url,source_sha256,filed_date,reported_spender_name,reported_candidate_name,
       reported_office,reported_district_number,vendor_name,expenditure_date,amount_cents,stance,reviewed_page_count)
      VALUES($1,$2::uuid,$3,$4,$5::date,$6,$7,$8,$9,$10,$11::date,$12::bigint,$13,$14)`,
    [r.documentId, id, r.sourceUrl, r.sourceSha256, r.filedDate, r.reportedSpenderName, r.reportedCandidateName,
      r.reportedOffice, r.reportedDistrictNumber, r.vendorName, r.expenditureDate, r.amountCents, r.supportOppose, r.reviewedPageCount]);
    await tx.query("COMMIT"); return { status: "written", reportsWritten: p.reports.length };
  } catch (error) { await tx.query("ROLLBACK").catch(() => {}); throw error; }
  finally { tx.release(); }
}
