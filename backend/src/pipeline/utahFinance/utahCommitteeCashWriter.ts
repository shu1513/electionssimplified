import type { Pool } from "pg";
import { assertSnapshotDbIsNotPoolClient } from "../finance/financeWriterPoolGuard.js";
import { assertUtahCashPacket, check, type UtahCashPacket } from "./utahCommitteeCashSource.js";

/** Only the acquisition/verifier can mint packets. All rows and the separate
 * source clock change atomically under the active link's identity lock. */
export async function replaceUtahCommitteeCash(db: Pool, packet: UtahCashPacket): Promise<boolean> {
  assertUtahCashPacket(packet);
  assertSnapshotDbIsNotPoolClient("Utah committee cash", db);
  const context = packet.context;
  let total = 0;
  for (const d of packet.donors) {
    check(d.committeeId.length <= 600 && d.committeeName.length <= 500, "donor_name_size");
    total += d.amountCents; check(Number.isSafeInteger(total), "unsafe_total");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ id: string }>(`
      SELECT l.id FROM public.ut_candidate_finance_links l
      JOIN public.candidates c ON c.id=l.candidate_id
      JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
      JOIN public.elections e ON e.id=l.election_id
      JOIN public.districts d ON d.id=e.district_id
      JOIN public.offices o ON o.id=e.office_id
      WHERE l.id=$1::uuid AND l.candidate_id=$2::uuid AND l.election_id=$3::uuid
        AND l.election_year=$4::integer AND l.folder_id=$5 AND l.link_status='active'
        AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost') AND d.state='UT'
        AND e.race_type='office' AND extract(year FROM e.election_date)::integer=$4::integer
        AND COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name))=$6
        AND o.scope=$7 AND o.canonical_name=$8 AND (CASE WHEN d.district_type IN ('state_upper','state_lower') THEN NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') ELSE NULL END) IS NOT DISTINCT FROM $9
      FOR UPDATE OF l`, [context.linkId, context.candidateId, context.electionId, context.electionYear,
        context.folderId, context.candidateName, context.officeScope, context.officeName, context.district]);
    check(locked.rows.length === 1, "link_changed");
    const existing = await client.query<{ folder_id: string; last_synced_at: Date }>(`
      SELECT folder_id,last_synced_at FROM public.ut_candidate_finance_pac_sources
      WHERE link_id=$1::uuid AND election_year=$2::integer FOR UPDATE`, [context.linkId, context.electionYear]);
    if (existing.rows[0] && new Date(existing.rows[0].last_synced_at).getTime() >= Date.parse(packet.observedAt)) {
      await client.query("COMMIT"); return false;
    }
    await client.query(`INSERT INTO public.ut_candidate_finance_pac_sources
      (link_id,election_year,folder_id,last_synced_at,source_url,report_count,occurrence_count,excluded_unfiled_count,group_count,cash_cents)
      VALUES ($1::uuid,$2::integer,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10::bigint)
      ON CONFLICT(link_id,election_year) DO UPDATE SET folder_id=EXCLUDED.folder_id,last_synced_at=EXCLUDED.last_synced_at,
        source_url=EXCLUDED.source_url,report_count=EXCLUDED.report_count,occurrence_count=EXCLUDED.occurrence_count,
        excluded_unfiled_count=EXCLUDED.excluded_unfiled_count,group_count=EXCLUDED.group_count,cash_cents=EXCLUDED.cash_cents`,
      [context.linkId,context.electionYear,context.folderId,packet.observedAt,packet.sourceUrl,packet.reportCount,
        packet.occurrenceCount,packet.excludedUnfiledCount,packet.donors.length,total]);
    await client.query("DELETE FROM public.ut_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2::integer", [context.linkId,context.electionYear]);
    for (const d of packet.donors) await client.query(`INSERT INTO public.ut_candidate_finance_pac_donors
      (link_id,election_year,committee_id,committee_name,amount_cents,contribution_count)
      VALUES ($1::uuid,$2::integer,$3,$4,$5::bigint,$6::integer)`, [context.linkId,context.electionYear,d.committeeId,d.committeeName,d.amountCents,d.contributionCount]);
    await client.query("COMMIT"); return true;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
