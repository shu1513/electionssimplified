import type { Pool } from "pg";
import { assertSnapshotDbIsNotPoolClient } from "../finance/financeWriterPoolGuard.js";
import { assertWisconsinCashPacket, type WisconsinCashPacket } from "./wisconsinCommitteeCashSource.js";
import { WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./wisconsinFinanceEligibleOffices.js";
import { WI_CASH_CANDIDATE_NAME_SQL, WI_CASH_DISTRICT_SQL } from "./wisconsinReportedCashSql.js";
import { wisconsinSourceCheck as check } from "./wisconsinSunshineArtifactCache.js";

/** The canonical membership lock also serializes the first snapshot, when no
 * source row yet exists. Failed or older packets never replace donor rows. */
export async function replaceWisconsinCommitteeCash(db: Pool, packet: WisconsinCashPacket): Promise<boolean> {
  assertWisconsinCashPacket(packet);
  assertSnapshotDbIsNotPoolClient("Wisconsin reported cash", db);
  const context = packet.context;
  let total = 0;
  for (const donor of packet.donors) {
    total += donor.amountCents;
    check(Number.isSafeInteger(total), "unsafe_cent_sum");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ id: string }>(`SELECT ce.id::text
      FROM public.candidate_elections ce
      JOIN public.candidates c ON c.id=ce.candidate_id
      JOIN public.elections e ON e.id=ce.election_id
      JOIN public.districts d ON d.id=e.district_id
      JOIN public.offices o ON o.id=e.office_id
      WHERE ce.candidate_id=$1::uuid AND ce.election_id=$2::uuid
        AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
        AND d.state='WI' AND e.race_type='office' AND e.election_stage='general'
        AND ${WI_CASH_CANDIDATE_NAME_SQL}=$3 AND c.last_name=$4
        AND extract(year FROM e.election_date)::integer=$5::integer AND e.election_date=$6::date
        AND o.scope=$7 AND o.canonical_name=$8
        AND (${WI_CASH_DISTRICT_SQL}) IS NOT DISTINCT FROM $9::text
        AND (o.scope||'::'||o.canonical_name)=ANY($10::text[])
      FOR UPDATE OF ce FOR SHARE OF c,e,d,o`, [context.candidateId, context.electionId, context.candidateName,
      context.candidateLastName, context.electionYear, context.electionDate, context.officeScope,
      context.officeName, context.district, WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS]);
    check(locked.rows.length === 1, "canonical_context_changed");
    const existing = await client.query<{ observed_at: Date | string }>(`SELECT observed_at
      FROM public.wi_candidate_finance_reported_cash_sources
      WHERE candidate_id=$1::uuid AND election_id=$2::uuid FOR UPDATE`, [context.candidateId, context.electionId]);
    if (existing.rows[0] && new Date(existing.rows[0].observed_at).getTime() >= Date.parse(packet.observedAt)) {
      await client.query("COMMIT"); return false;
    }
    const stored = await client.query(`INSERT INTO public.wi_candidate_finance_reported_cash_sources AS prior
      (candidate_id,election_id,election_year,candidate_name,candidate_last_name,office_scope,office_name,district,
       election_date,entity_id,committee_id,committee_name,observed_at,source_url,regular_coverage_through,
       report_count,occurrence_count,monetary_receipt_count,excluded_in_kind_count,excluded_loan_count,
       excluded_other_income_count,returned_contribution_count,group_count,cash_cents)
      VALUES ($1::uuid,$2::uuid,$3::smallint,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13::timestamptz,$14,$15::date,
        $16::integer,$17::integer,$18::integer,$19::integer,$20::integer,$21::integer,$22::integer,$23::integer,$24::bigint)
      ON CONFLICT (candidate_id,election_id) DO UPDATE SET
        election_year=EXCLUDED.election_year,candidate_name=EXCLUDED.candidate_name,candidate_last_name=EXCLUDED.candidate_last_name,
        office_scope=EXCLUDED.office_scope,office_name=EXCLUDED.office_name,district=EXCLUDED.district,
        election_date=EXCLUDED.election_date,entity_id=EXCLUDED.entity_id,committee_id=EXCLUDED.committee_id,
        committee_name=EXCLUDED.committee_name,observed_at=EXCLUDED.observed_at,source_url=EXCLUDED.source_url,
        regular_coverage_through=EXCLUDED.regular_coverage_through,report_count=EXCLUDED.report_count,
        occurrence_count=EXCLUDED.occurrence_count,monetary_receipt_count=EXCLUDED.monetary_receipt_count,
        excluded_in_kind_count=EXCLUDED.excluded_in_kind_count,excluded_loan_count=EXCLUDED.excluded_loan_count,
        excluded_other_income_count=EXCLUDED.excluded_other_income_count,returned_contribution_count=EXCLUDED.returned_contribution_count,
        group_count=EXCLUDED.group_count,cash_cents=EXCLUDED.cash_cents
      WHERE prior.observed_at < EXCLUDED.observed_at RETURNING candidate_id`,
      [context.candidateId,context.electionId,context.electionYear,context.candidateName,context.candidateLastName,
        context.officeScope,context.officeName,context.district,context.electionDate,packet.entityId,packet.committeeId,
        packet.committeeName,packet.observedAt,packet.sourceUrl,packet.regularCoverageThrough,packet.reportCount,
        packet.occurrenceCount,packet.monetaryReceiptCount,packet.excludedInKindCount,packet.excludedLoanCount,
        packet.excludedOtherIncomeCount,packet.returnedContributionCount,packet.donors.length,total]);
    if (stored.rows.length !== 1) { await client.query("COMMIT"); return false; }
    await client.query(`DELETE FROM public.wi_candidate_finance_reported_cash_donors
      WHERE candidate_id=$1::uuid AND election_id=$2::uuid`, [context.candidateId,context.electionId]);
    for (const donor of packet.donors) await client.query(`INSERT INTO public.wi_candidate_finance_reported_cash_donors
      (candidate_id,election_id,committee_id,committee_name,amount_cents,contribution_count,evidence_type,source_url)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::integer,$7,$8)`,
      [context.candidateId,context.electionId,donor.committeeId,donor.committeeName,donor.amountCents,
        donor.contributionCount,donor.evidence,donor.sourceUrl]);
    await client.query("COMMIT"); return true;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
