import type { Pool, PoolClient } from "pg";
import { loadWisconsinCommitteeCashPacket, type WisconsinCashContext } from "./wisconsinCommitteeCashSource.js";
import { replaceWisconsinCommitteeCash } from "./wisconsinCommitteeCashWriter.js";
import { WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./wisconsinFinanceEligibleOffices.js";
import { WI_CASH_CANDIDATE_NAME_SQL, WI_CASH_DISTRICT_SQL, WI_CASH_SOURCE_MATCH_SQL } from "./wisconsinReportedCashSql.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export type WisconsinCommitteeCashSyncOptions = {
  db: Queryable; now: Date; maxCandidates: number; staleAfterDays: number;
  electionLookbackDays: number; electionLookaheadDays: number; candidateId?: string; electionYear?: number;
  rawDataCacheDir?: string; refreshCommitteeCash?: boolean; allowNetwork?: boolean; refreshCache?: boolean; dryRun?: boolean;
};
type DueRow = {
  candidate_id: string; election_id: string; candidate_name: string; candidate_last_name: string;
  election_year: number; election_date: string; office_scope: string; office_name: string; district: string | null; total_due: string;
};
export async function syncDueWisconsinCommitteeCash(input: WisconsinCommitteeCashSyncOptions) {
  // Canonical contexts, not legacy direct-finance links, drive this component.
  const due = await input.db.query<DueRow>(`SELECT ce.candidate_id::text,ce.election_id::text,
      ${WI_CASH_CANDIDATE_NAME_SQL} candidate_name,c.last_name candidate_last_name,
      extract(year FROM e.election_date)::integer election_year,e.election_date::text,
      o.scope office_scope,o.canonical_name office_name,(${WI_CASH_DISTRICT_SQL}) district,
      count(*) OVER()::text total_due
    FROM public.candidate_elections ce
    JOIN public.candidates c ON c.id=ce.candidate_id
    JOIN public.elections e ON e.id=ce.election_id
    JOIN public.districts d ON d.id=e.district_id
    JOIN public.offices o ON o.id=e.office_id
    LEFT JOIN public.wi_candidate_finance_reported_cash_sources s
      ON s.candidate_id=ce.candidate_id AND s.election_id=ce.election_id
    LEFT JOIN public.wi_candidate_finance_reported_cash_attempts a
      ON a.candidate_id=ce.candidate_id AND a.election_id=ce.election_id
    WHERE c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
      AND d.state='WI' AND e.race_type='office' AND e.election_stage='general'
      AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])
      AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::integer))
      AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::integer))
      AND ($5::uuid IS NULL OR ce.candidate_id=$5::uuid)
      AND ($6::integer IS NULL OR extract(year FROM e.election_date)::integer=$6::integer)
      AND ($7::boolean OR s.candidate_id IS NULL OR NOT (${WI_CASH_SOURCE_MATCH_SQL})
        OR s.observed_at < $2::timestamptz-make_interval(days=>$8::integer))
    ORDER BY a.attempted_at NULLS FIRST,${WI_CASH_CANDIDATE_NAME_SQL},ce.id LIMIT $9::integer`,
    [WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS,input.now.toISOString(),input.electionLookbackDays,input.electionLookaheadDays,
      input.candidateId??null,input.electionYear??null,input.refreshCommitteeCash===true,input.staleAfterDays,input.maxCandidates]);
  let accepted = 0, written = 0, held = 0;
  const failures: string[] = [];
  for (const row of due.rows) {
    const context: WisconsinCashContext = { candidateId: row.candidate_id,electionId: row.election_id,
      candidateName: row.candidate_name,candidateLastName: row.candidate_last_name,electionYear: row.election_year,
      electionDate: row.election_date,officeScope: row.office_scope,officeName: row.office_name,district: row.district };
    let holdCode: string | null = null;
    try {
      const packet = await loadWisconsinCommitteeCashPacket(context, {
        cacheDir: input.rawDataCacheDir ?? "scratch/wisconsin-campaign-finance/reported-cash",
        allowNetwork: input.allowNetwork === true,refresh: input.refreshCache === true,
      });
      accepted++;
      if (!input.dryRun && await replaceWisconsinCommitteeCash(input.db as Pool, packet)) written++;
    } catch (e) {
      held++;
      const message = e instanceof Error ? e.message : "";
      holdCode = /^Wisconsin reported finance held: [a-z_]+$/.test(message)
        ? message.slice("Wisconsin reported finance held: ".length) : "acquisition_or_write_failed";
      failures.push(holdCode);
    }
    if (!input.dryRun) await input.db.query(`INSERT INTO public.wi_candidate_finance_reported_cash_attempts
      (candidate_id,election_id,attempted_at,hold_code) VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4)
      ON CONFLICT(candidate_id,election_id) DO UPDATE SET attempted_at=EXCLUDED.attempted_at,hold_code=EXCLUDED.hold_code`,
      [row.candidate_id,row.election_id,new Date().toISOString(),holdCode]);
  }
  return { due: Number(due.rows[0]?.total_due??0),selected: due.rows.length,accepted,written,held,failures };
}
