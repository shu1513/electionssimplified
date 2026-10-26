import type { Pool, PoolClient } from "pg";
import {
  marylandOutsideGuid,
  type MarylandOutsideQualifiedSnapshot,
} from "./marylandIndependentOutsideQualification.js";
const fail = (): never => {
  throw new Error("invalid_maryland_independent_outside_snapshot");
};
const sum = (a: number, b: number) =>
  Number.isSafeInteger(a + b) ? a + b : fail();
export async function replaceMarylandIndependentOutsideSnapshot(input: {
  db: Pick<Pool, "connect">;
  snapshot: MarylandOutsideQualifiedSnapshot;
  syncedAt?: Date;
}) {
  const s = structuredClone(input.snapshot),
    c = s.context,
    syncedAt = new Date(input.syncedAt?.getTime() ?? Date.now());
  marylandOutsideGuid(c.candidateId);
  marylandOutsideGuid(c.electionId);
  if (
    c.electionYear !== 2026 ||
    c.electionStage !== "general" ||
    c.electionDate !== "2026-11-03" ||
    !["state_upper", "state_lower"].includes(c.officeScope) ||
    !c.candidateName?.trim() ||
    !c.party?.trim() ||
    !s.targetAccountGuids.length ||
    new Set(s.targetAccountGuids.map(marylandOutsideGuid)).size !==
      s.targetAccountGuids.length ||
    !Number.isSafeInteger(s.allocationCount) ||
    s.allocationCount < 0 ||
    !s.generationDirectory?.trim() ||
    !s.nativeDirectory?.trim() ||
    !Number.isFinite(Date.parse(s.sourceObservedAt)) ||
    !Number.isFinite(syncedAt.getTime()) ||
    Date.parse(s.sourceObservedAt) > syncedAt.getTime()
  )
    return fail();
  let support = 0,
    oppose = 0;
  const keys = new Set<string>(),
    payerIds = new Map<string, number>();
  for (const g of s.groups) {
    const payer = marylandOutsideGuid(g.payerGuid),
      key = `${payer}:${g.stance}`;
    if (
      keys.has(key) ||
      !["support", "oppose"].includes(g.stance) ||
      !g.committeeName.trim() ||
      !Number.isSafeInteger(g.filingEntityId) ||
      g.filingEntityId < 1 ||
      !Number.isSafeInteger(g.amountCents) ||
      g.amountCents <= 0 ||
      (payerIds.has(payer) && payerIds.get(payer) !== g.filingEntityId)
    )
      return fail();
    keys.add(key);
    payerIds.set(payer, g.filingEntityId);
    if (g.stance === "support") support = sum(support, g.amountCents);
    else oppose = sum(oppose, g.amountCents);
  }
  if (
    support !== s.supportCents ||
    oppose !== s.opposeCents ||
    s.groups.length > s.allocationCount
  )
    return fail();
  const client: PoolClient = await input.db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT c.display_name, c.party, o.scope, o.canonical_name, d.geoid_compact,
      e.election_date::text, e.election_stage FROM public.candidate_elections ce
      JOIN public.candidates c ON c.id=ce.candidate_id JOIN public.elections e ON e.id=ce.election_id
      JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
      WHERE ce.candidate_id=$1::uuid AND ce.election_id=$2::uuid AND c.deleted_at IS NULL
        AND c.merged_into_candidate_id IS NULL AND ce.status NOT IN ('withdrawn','lost')
        AND d.state='MD' AND e.race_type='office'
      FOR UPDATE OF ce,c,e FOR SHARE OF d,o`,
      [c.candidateId, c.electionId],
    );
    const row = current.rows[0];
    if (
      current.rows.length !== 1 ||
      row.display_name !== c.candidateName ||
      row.party !== c.party ||
      row.scope !== c.officeScope ||
      row.canonical_name !== c.officeName ||
      row.geoid_compact !== c.districtGeoidCompact ||
      row.election_date !== c.electionDate ||
      row.election_stage !== c.electionStage
    )
      throw new Error("maryland_outside_canonical_context_changed");
    const old = await client.query(
      `SELECT candidate_id FROM public.md_candidate_finance_ie_sources
      WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND
        (source_observed_at>$3::timestamptz OR last_synced_at>$4::timestamptz)`,
      [c.candidateId, c.electionId, s.sourceObservedAt, syncedAt.toISOString()],
    );
    if (old.rows.length) throw new Error("maryland_outside_older_source");
    await client.query(
      `INSERT INTO public.md_candidate_finance_ie_sources
      (candidate_id,election_id,election_year,canonical_context,target_account_guids,support_cents,oppose_cents,
       group_count,allocation_count,source_observed_at,last_synced_at,generation_directory,native_directory,financial_basis)
      VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid[],$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,
        'complete_native_ie_with_current_report_controls')
      ON CONFLICT(candidate_id,election_id) DO UPDATE SET election_year=EXCLUDED.election_year,
       canonical_context=EXCLUDED.canonical_context,target_account_guids=EXCLUDED.target_account_guids,
       support_cents=EXCLUDED.support_cents,oppose_cents=EXCLUDED.oppose_cents,group_count=EXCLUDED.group_count,
       allocation_count=EXCLUDED.allocation_count,source_observed_at=EXCLUDED.source_observed_at,
       last_synced_at=EXCLUDED.last_synced_at,generation_directory=EXCLUDED.generation_directory,
       native_directory=EXCLUDED.native_directory,financial_basis=EXCLUDED.financial_basis`,
      [
        c.candidateId,
        c.electionId,
        c.electionYear,
        JSON.stringify(c),
        s.targetAccountGuids,
        String(s.supportCents),
        String(s.opposeCents),
        s.groups.length,
        s.allocationCount,
        s.sourceObservedAt,
        syncedAt.toISOString(),
        s.generationDirectory,
        s.nativeDirectory,
      ],
    );
    await client.query(
      `DELETE FROM public.md_candidate_finance_ie_groups WHERE candidate_id=$1::uuid AND election_id=$2::uuid`,
      [c.candidateId, c.electionId],
    );
    for (const g of s.groups)
      await client.query(
        `INSERT INTO public.md_candidate_finance_ie_groups
      (candidate_id,election_id,payer_guid,filing_entity_id,committee_name,stance,amount_cents,source_url)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,
        [
          c.candidateId,
          c.electionId,
          g.payerGuid,
          String(g.filingEntityId),
          g.committeeName,
          g.stance,
          String(g.amountCents),
          `https://campaignfinance.maryland.gov/public/cf/candidateprofile?guid=${g.payerGuid}&tabName=TIECOM`,
        ],
      );
    await client.query("COMMIT");
    return {
      groupsWritten: s.groups.length,
      allocationsQualified: s.allocationCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
