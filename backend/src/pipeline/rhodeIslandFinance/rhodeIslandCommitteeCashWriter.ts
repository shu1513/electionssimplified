import type { Pool, PoolClient } from "pg";
import { assertRhodeIslandCashPacket, type RhodeIslandCashPacket } from "./rhodeIslandCommitteeCashSource.js";
import { riCommitteeCashCheck as check } from "./rhodeIslandCommitteeCashAggregator.js";
import { loadRhodeIslandCanonicalCashContext } from "./rhodeIslandCommitteeCashContext.js";
import { normalizeRhodeIslandCandidateNameForStorage } from "./rhodeIslandCandidateCommitteeResolver.js";
import { replaceRhodeIslandCandidateFinanceSnapshot } from "./rhodeIslandFinanceWriter.js";

type Db = Pick<Pool, "query"> & { connect: () => Promise<PoolClient> };
class AlreadyApplied extends Error { constructor(readonly linkId: string) { super("already_applied"); } }
type Link = { id: string; candidate_id: string; election_id: string; election_year: number;
  committee_id: string; committee_name: string; candidate_name_normalized: string; office_name: string;
  district: string | null; link_status: string; link_source: string };

/** Scoped manual import: review of ballot/office/registration identity precedes
 * this call. One shared transaction writes legacy direct finance and the new
 * source/donor rows. Outside data is omitted and preserved. Failed source,
 * stale context, older clocks or conflicts cannot advance accepted clocks.
 */
export async function writeRhodeIslandCashPacket(input: {
  db: Db; packet: RhodeIslandCashPacket; reviewedMapping: true;
}): Promise<{ status: "written" | "unchanged"; linkId: string; donorsWritten: number; reportedCashCents: number }> {
  const { db, packet: p } = input;
  assertRhodeIslandCashPacket(p);
  check(input.reviewedMapping === true, "manual_mapping_review_required");
  const c = p.context, normalizedName = normalizeRhodeIslandCandidateNameForStorage(c.candidateName);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  check(uuid.test(c.candidateId) && uuid.test(c.electionId), "canonical_context_identity");
  // A reviewed manual import records the reviewed mapping as manual, including
  // when the same account was originally linked by the name-only resolver.
  const link = { candidateId: c.candidateId, electionId: c.electionId, electionYear: c.electionYear,
    candidateNameNormalized: normalizedName, officeName: c.officeName, district: c.district,
    committeeId: c.committeeId, committeeName: c.committeeName, linkSource: "manual" as const,
    sourceUrl: p.sourceUrl, lastVerifiedAt: new Date(p.observedAt) };
  try {
    const result = await replaceRhodeIslandCandidateFinanceSnapshot({ db, link, syncedAt: new Date(p.observedAt),
      summary: p.summary, directBreakdowns: p.directBreakdowns,
      beforeSnapshotWrite: async ({ db: tx }) => {
        for (const key of [`ri-cash:context:${c.candidateId}:${c.electionId}`, `ri-cash:account:${c.committeeId}:${c.electionYear}`].sort()) {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
        }
        const actual = await loadRhodeIslandCanonicalCashContext(tx, c.candidateId, c.electionId, true);
        check(actual && actual.candidate_name === c.candidateName && actual.last_name === c.searchLastName && actual.election_year === c.electionYear &&
          actual.office_scope === c.officeScope && actual.office_name === c.officeName && actual.district === c.district, "canonical_context_changed");
        const seat = Number(actual.geoid_compact.slice(2));
        check(actual.office_scope === "statewide"
          ? actual.district_type === "statewide" && actual.geoid_compact === "44" && actual.district === null
          : actual.district_type === actual.office_scope && /^44\d{3}$/.test(actual.geoid_compact) && String(seat) === actual.district &&
            seat >= 1 && seat <= (actual.office_scope === "state_upper" ? 38 : 75), "canonical_district_ownership");
        const siblings = await tx.query<Link>(`SELECT id::text,candidate_id::text,election_id::text,election_year,
          committee_id,committee_name,candidate_name_normalized,office_name,district,link_status,link_source
          FROM public.ri_candidate_finance_links WHERE (candidate_id=$1::uuid AND election_id=$2::uuid)
            OR (committee_id=$3 AND election_year=$4) ORDER BY id FOR UPDATE`,
        [c.candidateId, c.electionId, c.committeeId, c.electionYear]);
        check(siblings.rows.length <= 1, "ambiguous_receiving_ownership");
        const existing = siblings.rows[0];
        if (existing) {
          check(existing.candidate_id === c.candidateId && existing.election_id === c.electionId && existing.election_year === c.electionYear &&
            existing.committee_id === c.committeeId && existing.committee_name === c.committeeName && existing.candidate_name_normalized === normalizedName &&
            existing.office_name === c.officeName && existing.district === c.district && existing.link_status === "active" &&
            (existing.link_source === "manual" || existing.link_source === "erts_portal"), "receiving_link_changed");
          const source = await tx.query<{ newer: boolean; equal: boolean; source_digest: string; receiving_committee_id: string }>(`
            SELECT observed_at>$3::timestamptz newer,observed_at=$3::timestamptz equal,source_digest,receiving_committee_id
            FROM public.ri_candidate_finance_pac_sources WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`,
          [existing.id, c.electionYear, p.observedAt]);
          const previous = source.rows[0];
          if (previous) {
            check(previous.receiving_committee_id === c.committeeId && !previous.newer, "older_source_clock");
            if (previous.equal) {
              check(previous.source_digest === p.sourceDigest, "same_clock_source_conflict");
              throw new AlreadyApplied(existing.id);
            }
          }
          const summary = await tx.query<{ newer: boolean }>(`SELECT last_synced_at>$3::timestamptz newer
            FROM public.ri_candidate_finance_summaries WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`,
          [existing.id, c.electionYear, p.observedAt]);
          check(!summary.rows.some(s => s.newer), "newer_direct_finance_clock");
        }
      },
      afterSnapshotWrite: async ({ db: tx, linkId, electionYear }) => {
        await tx.query(`INSERT INTO public.ri_candidate_finance_pac_sources
          (link_id,election_year,receiving_committee_id,observed_at,source_digest,period_start,period_end,source_url,
            report_count,receiving_rows,selected_occurrences,group_count,cash_cents)
          VALUES($1::uuid,$2,$3,$4::timestamptz,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13::bigint)
          ON CONFLICT(link_id,election_year) DO UPDATE SET receiving_committee_id=EXCLUDED.receiving_committee_id,
            observed_at=EXCLUDED.observed_at,source_digest=EXCLUDED.source_digest,period_start=EXCLUDED.period_start,
            period_end=EXCLUDED.period_end,source_url=EXCLUDED.source_url,report_count=EXCLUDED.report_count,
            receiving_rows=EXCLUDED.receiving_rows,selected_occurrences=EXCLUDED.selected_occurrences,
            group_count=EXCLUDED.group_count,cash_cents=EXCLUDED.cash_cents`,
        [linkId, electionYear, c.committeeId, p.observedAt, p.sourceDigest, `${electionYear - 1}-01-01`, p.coverageThrough,
          p.sourceUrl, p.reportCount, p.receivingRows, p.selectedOccurrences, p.donors.length, p.totalCents]);
        await tx.query("DELETE FROM public.ri_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2", [linkId, electionYear]);
        for (const donor of p.donors) await tx.query(`INSERT INTO public.ri_candidate_finance_pac_donors
          (link_id,election_year,reported_key,committee_name,source_class,amount_cents,contribution_count)
          VALUES($1::uuid,$2,$3,$4,$5,$6::bigint,$7)`,
        [linkId, electionYear, donor.key, donor.name, donor.sourceClass, donor.amountCents, donor.contributionCount]);
      },
    });
    return { status: "written", linkId: result.linkId, donorsWritten: p.donors.length, reportedCashCents: p.totalCents };
  } catch (error) {
    if (error instanceof AlreadyApplied) return { status: "unchanged", linkId: error.linkId, donorsWritten: 0, reportedCashCents: p.totalCents };
    throw error;
  }
}
