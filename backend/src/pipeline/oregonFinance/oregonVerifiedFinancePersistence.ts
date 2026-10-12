import type { Pool, PoolClient } from "pg";
import { normalizeOregonCandidateNameForStorage } from "./oregonCandidateCommitteeResolver.js";
import type { OregonFinanceLinkInput } from "./oregonFinanceWriter.js";
import type { OregonPacCandidateContext, OregonVerifiedPacDonor, OregonVerifiedPacProvenance } from "./oregonVerifiedPacSource.js";
import type { OregonVerifiedOutsideEvidence } from "./oregonVerifiedOutsideSource.js";
import { prepareOregonVerifiedPacUpdate, prepareOregonVerifiedOutsideUpdate } from "./oregonVerifiedFinanceUpdates.js";
import { projectOregonVerifiedLocalCandidateContext, type OregonVerifiedLocalCandidateRow } from "./oregonVerifiedLocalCandidateContext.js";
import { fingerprintOregonVerifiedRows } from "./oregonVerifiedSourceDecoders.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export type OregonVerifiedFinanceComponents = {
  candidateContext: OregonPacCandidateContext;
  pac?: { donors: readonly OregonVerifiedPacDonor[]; provenance: OregonVerifiedPacProvenance };
  positiveOutsideEvidence?: readonly OregonVerifiedOutsideEvidence[];
};
export type OregonVerifiedFinanceWriteCounts = {
  pacDonorsWritten: number;
  verifiedOutsideGroupsWritten: number;
  verifiedFinanceDiagnostics: string[];
};

/** Actual local context, not a district-name heuristic or a source-derived election. */
export async function loadOregonVerifiedLocalCandidateRow(db: Queryable, input: {
  candidateId: string; electionId: string; committeeId: string; lock?: boolean;
}): Promise<OregonVerifiedLocalCandidateRow | undefined> {
  const result = await db.query<OregonVerifiedLocalCandidateRow>(`
    SELECT candidate.id::text AS "candidateId", election.id::text AS "electionId",
      $3::text AS "committeeId",
      COALESCE(NULLIF(trim(candidate.display_name), ''),
        NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) AS "candidateName",
      election.election_date::text AS "electionDate", election.election_stage AS "electionStage",
      office.canonical_name AS "officeName", district.name AS "districtName",
      district.state AS "districtState", district.district_type AS "districtType",
      district.geoid_compact AS "geoidCompact"
    FROM public.candidates candidate
    JOIN public.candidate_elections ce ON ce.candidate_id=candidate.id AND ce.election_id=$2::uuid
    JOIN public.elections election ON election.id=ce.election_id
    JOIN public.offices office ON office.id=election.office_id
    JOIN public.districts district ON district.id=election.district_id
    WHERE candidate.id=$1::uuid AND candidate.deleted_at IS NULL
      AND ce.status NOT IN ('withdrawn', 'lost') AND election.race_type='office'
    ${input.lock ? "FOR SHARE OF candidate, ce, election, office, district" : ""}
  `, [input.candidateId, input.electionId, input.committeeId]);
  return result.rows.length === 1 ? result.rows[0] : undefined;
}

// pg numeric arrives as a decimal string. Reject rounding and unsafe cents.
function storedAmount(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[0-9]+\.[0-9]{2}$/.test(value)) return undefined;
  const cents = Number(value.replace(".", ""));
  const amount = cents / 100;
  return Number.isSafeInteger(cents) && cents > 0 && Math.round(amount * 100) === cents ? amount : undefined;
}

/** Hooks are used only inside the shared writer's existing transaction. */
export function createOregonVerifiedFinancePersistence(input: {
  link: OregonFinanceLinkInput;
  components: OregonVerifiedFinanceComponents;
}) {
  // Snapshot authority before the first await, including caller-owned arrays.
  const link = structuredClone(input.link);
  const components = structuredClone(input.components);
  const counts: OregonVerifiedFinanceWriteCounts = {
    pacDonorsWritten: 0, verifiedOutsideGroupsWritten: 0, verifiedFinanceDiagnostics: [],
  };
  let ownerId: string | undefined;
  const beforeSnapshotWrite = async ({ db }: { db: Queryable }): Promise<void> => {
    // Brief state-table lock also serializes standalone automatic link inserts.
    // Row locks alone cannot prevent a new competing owner appearing mid-write.
    await db.query("LOCK TABLE public.or_candidate_finance_links IN SHARE ROW EXCLUSIVE MODE");
    const local = await loadOregonVerifiedLocalCandidateRow(db, { ...link, lock: true });
    const projected = local && projectOregonVerifiedLocalCandidateContext({ row: local, expectedYear: link.electionYear }).candidateContext;
    if (!projected || fingerprintOregonVerifiedRows([projected]) !== fingerprintOregonVerifiedRows([components.candidateContext]) ||
        link.officeName !== local!.officeName || link.district !== local!.districtName ||
        link.candidateNameNormalized !== normalizeOregonCandidateNameForStorage(projected.candidateName) ||
        (link.linkStatus ?? "active") !== "active") {
      throw new Error("Oregon verified finance local candidate/election/office/seat changed");
    }
    const owners = await db.query<{
      id: string; candidate_id: string; election_id: string; committee_id: string;
      election_year: number; link_status: string; link_source: string;
    }>(`SELECT id::text, candidate_id::text, election_id::text, committee_id,
        election_year, link_status, link_source FROM public.or_candidate_finance_links
      WHERE (candidate_id=$1::uuid AND election_id=$2::uuid)
         OR (committee_id=$3 AND election_year=$4 AND link_status='active')
      FOR UPDATE`, [link.candidateId, link.electionId, link.committeeId, link.electionYear]);
    const same = (row: typeof owners.rows[number]) => row.candidate_id === link.candidateId &&
      row.election_id === link.electionId && row.committee_id === link.committeeId && row.election_year === link.electionYear;
    const active = owners.rows.filter(row => row.link_status === "active");
    if (active.length !== 1 || !same(active[0]!) || owners.rows.some(row =>
      row.link_source === "manual" && row.candidate_id === link.candidateId && row.election_id === link.electionId &&
      ((row.committee_id === link.committeeId && (!same(row) || row.link_status !== "active")) ||
       (row.committee_id !== link.committeeId && row.link_status === "active")))) {
      throw new Error("Oregon verified finance active or manual ownership changed");
    }
    ownerId = active[0]!.id;
  };
  const afterSnapshotWrite = async ({ db, linkId, electionYear, syncedAt }: {
    db: Queryable; linkId: string; electionYear: number; syncedAt: Date;
  }): Promise<void> => {
    if (!ownerId || ownerId !== linkId || electionYear !== link.electionYear) throw new Error("Oregon verified finance owner changed during snapshot");
    if (components.pac !== undefined) {
      const summary = await db.query<{ pac_source_provenance: unknown }>(
        "SELECT pac_source_provenance FROM public.or_candidate_finance_summaries WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE", [linkId, electionYear]);
      const rows = await db.query<Record<string, unknown>>(`SELECT committee_id, committee_name, committee_type,
        amount::text, contribution_count, source_url FROM public.or_candidate_finance_pac_donors
        WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`, [linkId, electionYear]);
      const donors = rows.rows.map(row => ({ committeeId: row.committee_id, committeeName: row.committee_name,
        committeeType: row.committee_type, amount: storedAmount(row.amount), contributionCount: row.contribution_count, sourceUrl: row.source_url }));
      const prepared = prepareOregonVerifiedPacUpdate({ expectedContext: components.candidateContext,
        previous: { provenance: summary.rows[0]?.pac_source_provenance, donors }, incoming: components.pac });
      counts.verifiedFinanceDiagnostics.push(...prepared.diagnostics);
      if (prepared.update) {
        for (const donor of prepared.update.donors) {
          await db.query(`INSERT INTO public.or_candidate_finance_pac_donors
            (link_id,election_year,committee_id,committee_name,committee_type,amount,contribution_count,source_url,last_synced_at)
            VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)
            ON CONFLICT (link_id,election_year,committee_id) DO UPDATE SET committee_name=EXCLUDED.committee_name,
              committee_type=EXCLUDED.committee_type,amount=EXCLUDED.amount,contribution_count=EXCLUDED.contribution_count,
              source_url=EXCLUDED.source_url,last_synced_at=EXCLUDED.last_synced_at`,
            [linkId,electionYear,donor.committeeId,donor.committeeName,donor.committeeType,donor.amount,donor.contributionCount,donor.sourceUrl,syncedAt]);
        }
        // No deletion: the preparation requires every prior accepted gift/donor to survive.
        await db.query(`INSERT INTO public.or_candidate_finance_summaries (link_id,election_year,pac_source_provenance,last_synced_at)
          VALUES ($1::uuid,$2,$3::jsonb,$4::timestamptz)
          ON CONFLICT (link_id,election_year) DO UPDATE SET pac_source_provenance=EXCLUDED.pac_source_provenance`,
          [linkId,electionYear,JSON.stringify(prepared.update.provenance),syncedAt]);
        counts.pacDonorsWritten = prepared.update.donors.length;
      }
    }
    const payerCounts = new Map<string, number>();
    for (const evidence of components.positiveOutsideEvidence ?? []) {
      const id = evidence?.payer?.committeeId;
      if (typeof id === "string") payerCounts.set(id, (payerCounts.get(id) ?? 0) + 1);
    }
    for (const evidence of components.positiveOutsideEvidence ?? []) {
      const payer = evidence?.payer?.committeeId;
      if (typeof payer !== "string" || payerCounts.get(payer) !== 1) {
        counts.verifiedFinanceDiagnostics.push("Invalid or duplicate Oregon outside payer");
        continue;
      }
      const proof = await db.query<{ source_provenance: unknown }>(`SELECT source_provenance
        FROM public.or_candidate_finance_outside_source_proofs WHERE link_id=$1::uuid AND election_year=$2
          AND payer_committee_id=$3 FOR UPDATE`, [linkId,electionYear,payer]);
      const rows = await db.query<Record<string, unknown>>(`SELECT sponsor_id,sponsor_name,support_oppose,amount::text,source_url
        FROM public.or_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2 AND sponsor_id=$3 FOR UPDATE`, [linkId,electionYear,payer]);
      const breakdown = await db.query(`SELECT 1 FROM public.or_candidate_finance_outside_group_breakdowns
        WHERE link_id=$1::uuid AND election_year=$2 AND sponsor_id=$3 LIMIT 1`, [linkId,electionYear,payer]);
      if (breakdown.rows.length) {
        counts.verifiedFinanceDiagnostics.push(`Payer ${payer}: stored outside donor breakdown has independent coverage`);
        continue;
      }
      const groups = rows.rows.map(row => ({ sponsorId: row.sponsor_id, sponsorName: row.sponsor_name,
        supportOppose: row.support_oppose, amount: storedAmount(row.amount), sourceUrl: row.source_url }));
      const prepared = prepareOregonVerifiedOutsideUpdate({ expectedContext: components.candidateContext,
        payerCommitteeId: payer, previous: { provenance: proof.rows[0]?.source_provenance, groups }, incoming: evidence });
      counts.verifiedFinanceDiagnostics.push(...prepared.diagnostics.map(message => `Payer ${payer}: ${message}`));
      if (!prepared.update) continue;
      for (const group of prepared.update.groups) {
        await db.query(`INSERT INTO public.or_candidate_finance_outside_groups
          (link_id,election_year,sponsor_id,sponsor_name,support_oppose,amount,source_url,last_synced_at)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)
          ON CONFLICT (link_id,election_year,sponsor_id,support_oppose) DO UPDATE SET
            sponsor_name=EXCLUDED.sponsor_name,amount=EXCLUDED.amount,source_url=EXCLUDED.source_url,last_synced_at=EXCLUDED.last_synced_at`,
          [linkId,electionYear,group.sponsorId,group.sponsorName,group.supportOppose,group.amount,group.sourceUrl,syncedAt]);
      }
      await db.query(`INSERT INTO public.or_candidate_finance_outside_source_proofs
        (link_id,election_year,payer_committee_id,source_provenance,last_synced_at)
        VALUES ($1::uuid,$2,$3,$4::jsonb,$5::timestamptz)
        ON CONFLICT (link_id,election_year,payer_committee_id) DO UPDATE SET
          source_provenance=EXCLUDED.source_provenance,last_synced_at=EXCLUDED.last_synced_at`,
        [linkId,electionYear,payer,JSON.stringify(prepared.update.provenance),syncedAt]);
      // Clear only a disproved zero. Scoped allocations cannot replace an
      // existing positive headline or establish coverage of the other stance.
      await db.query(`UPDATE public.or_candidate_finance_summaries SET
        outside_support_total=CASE WHEN outside_support_total=0 AND $3::bigint>0 THEN NULL ELSE outside_support_total END,
        outside_oppose_total=CASE WHEN outside_oppose_total=0 AND $4::bigint>0 THEN NULL ELSE outside_oppose_total END
        WHERE link_id=$1::uuid AND election_year=$2`,
        [linkId,electionYear,prepared.update.supportCents,prepared.update.opposeCents]);
      counts.verifiedOutsideGroupsWritten += prepared.update.groups.length;
    }
  };
  return { beforeSnapshotWrite, afterSnapshotWrite, counts };
}
