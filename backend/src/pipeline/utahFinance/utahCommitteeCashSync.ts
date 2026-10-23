import type { Pool, PoolClient } from "pg";
import { UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./utahFinanceEligibleOffices.js";
import { loadUtahCashPacket, type UtahCashContext } from "./utahCommitteeCashSource.js";
import { replaceUtahCommitteeCash } from "./utahCommitteeCashWriter.js";

type Queryable = Pick<Pool | PoolClient,"query">;
export type UtahCommitteeCashSyncOptions = {
  db: Queryable; now: Date; maxCandidates: number; staleAfterDays: number;
  electionLookbackDays: number; electionLookaheadDays: number; rawDataCacheDir?: string;
  candidateId?: string; electionYear?: number; dryRun?: boolean; refreshCommitteeCash?: boolean;
  committeeCashNetwork?: boolean; refreshCache?: boolean;
};
export async function syncDueUtahCommitteeCash(input: UtahCommitteeCashSyncOptions) {
  const result = await input.db.query<{
    link_id:string; candidate_id:string; election_id:string; candidate_name:string; election_year:number;
    folder_id:string; office_scope:string; office_name:string; district:string|null; total_due:string;
  }>(`SELECT l.id::text link_id,l.candidate_id::text,l.election_id::text,
      COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,
      l.election_year,l.folder_id,o.scope office_scope,o.canonical_name office_name,CASE WHEN d.district_type IN ('state_upper','state_lower') THEN NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') ELSE NULL END district,
      count(*) OVER()::text total_due
    FROM public.ut_candidate_finance_links l
    JOIN public.candidates c ON c.id=l.candidate_id
    JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
    JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id
    JOIN public.offices o ON o.id=e.office_id
    LEFT JOIN public.ut_candidate_finance_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year AND s.folder_id=l.folder_id
    WHERE l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
      AND d.state='UT' AND e.race_type='office' AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])
      AND extract(year FROM e.election_date)::integer=l.election_year
      AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days=>$3::integer))
      AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days=>$4::integer))
      AND ($5::uuid IS NULL OR l.candidate_id=$5::uuid) AND ($6::integer IS NULL OR l.election_year=$6::integer)
      AND ($7::boolean OR s.last_synced_at IS NULL OR s.last_synced_at < $2::timestamptz-make_interval(days=>$8::integer))
    ORDER BY s.last_synced_at NULLS FIRST,l.candidate_name_normalized,l.id LIMIT $9::integer`,
    [UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS,input.now.toISOString(),input.electionLookbackDays,input.electionLookaheadDays,
      input.candidateId??null,input.electionYear??null,input.refreshCommitteeCash===true,input.staleAfterDays,input.maxCandidates]);
  let accepted=0, written=0, held=0;
  const failures: string[]=[];
  for(const row of result.rows){
    const context:UtahCashContext={linkId:row.link_id,candidateId:row.candidate_id,electionId:row.election_id,
      candidateName:row.candidate_name,electionYear:row.election_year,folderId:row.folder_id,
      officeScope:row.office_scope,officeName:row.office_name,district:row.district};
    try{
      const packet=await loadUtahCashPacket(context,{cacheDir:input.rawDataCacheDir??"scratch/utah-campaign-finance/disclosures",
        now:input.now,refresh:input.refreshCache,allowNetwork:input.committeeCashNetwork});
      accepted++;
      if(!input.dryRun && await replaceUtahCommitteeCash(input.db as Pool,packet))written++;
    }catch(e){held++;const message=e instanceof Error?e.message:"";failures.push(/^Utah committee cash held: [a-z_]+$/.test(message)?message:"Utah committee cash held: acquisition_or_write_failed");}
  }
  return {due:Number(result.rows[0]?.total_due??0),selected:result.rows.length,accepted,written,held,failures};
}
