import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { createIdahoPacSourceProducer } from "../../../src/pipeline/idahoFinance/idahoReportedPacCache.js";
import { aggregateIdahoPacRows } from "../../../src/pipeline/idahoFinance/idahoReportedPacSource.js";
import { idahoPacFacts } from "../../../src/pipeline/idahoFinance/idahoReportedPacWriter.js";
import { overlayIdahoReportedPacReceipts } from "../../../src/pipeline/idahoFinance/idahoReportedPacReader.js";
import { candidateElectionKey,type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { idahoPacFixture,pacGuid,pacReceipt,pacReceiver as receiver,pacScope } from "./idahoReportedPacFixtures.js";
const candidates=[{candidate_id:receiver.candidate_id,election_id:receiver.election_id}],elections=[{election_id:receiver.election_id,state:"ID",office_scope:"state_upper",office_canonical_name:"State Senator"}],key=candidateElectionKey(receiver.candidate_id,receiver.election_id);
let cacheDir:string,row:Record<string,unknown>;
beforeEach(async()=>{
  cacheDir=await mkdtemp(join(tmpdir(),"id-pac-reader-"));vi.stubEnv("IDAHO_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("IDAHO_REPORTED_PAC_RECEIPTS_ENABLED","true");
  const f=idahoPacFixture();f.state.rows=Array.from({length:40},(_,i)=>pacReceipt(i+1,`Synthetic PAC ${i}`,10,"ITMY",i+1));f.state.categoryCents=40000;
  const p=(await createIdahoPacSourceProducer({cacheDir,fetchImpl:f.fetchImpl,minimumGapMs:0}).refresh(pacScope))!,{groups,...a}=aggregateIdahoPacRows(p.rows);
  row={...receiver,pac_source:{link_id:receiver.link_id,election_year:2026,candidate_id:receiver.candidate_id,election_id:receiver.election_id,
    receiving_registration_guid:receiver.registration_guid,native_entity_id:1000,native_registration_id:2000,total_cents:a.totalCents,group_count:groups.length,
    source_row_count:a.selectedRowCount,source_facts:idahoPacFacts(p),aggregation_controls:a,source_retrieved_at:p.sourceRetrievedAt,source_completed_at:p.sourceCompletedAt,
    source_manifest_sha256:p.sourceManifestSha256,source_byte_size:p.sourceByteSize,last_synced_at:new Date().toISOString()},
    pac_groups:groups.map(g=>({link_id:receiver.link_id,election_year:2026,reported_source_key:g.key,reported_name:g.name,amount_cents:g.cents,source_row_count:g.rowCount}))};
});
afterEach(async()=>{vi.unstubAllEnvs();await rm(cacheDir,{recursive:true,force:true});});
const dbFor=(rows:unknown[])=>({query:vi.fn(async()=>({rows}))})as unknown as Pool;
describe("Idaho production reported PAC reader",()=>{
  it("validates forty groups before five named details and retains unsorted full totals",async()=>{
    const s=(await overlayIdahoReportedPacReceipts(dbFor([row]),new Map(),candidates,elections)).get(key)!;
    expect(s.direct_campaign.pac_money_by_interest).toMatchObject([{interest:"unclassified",interest_name:"Not yet sorted",amount:400,pac_count:40}]);
    expect(s.direct_campaign.pac_money_by_interest![0]!.pacs).toHaveLength(5);expect(s.direct_campaign.total_raised).toBeNull();expect(s.outside_spending.support_total).toBeNull();
    expect(s.direct_campaign.pac_money_coverage_note).toContain("Separate contribution returns are not subtracted");expect(s.direct_campaign.pac_money_basis).toBe("reported_committee_itemized_contributions");
  });
  it("preserves fundraising, IE and headline clocks",async()=>{
    const s=(await overlayIdahoReportedPacReceipts(dbFor([row]),new Map(),candidates,elections)).get(key)!;delete s.direct_campaign.pac_money_by_interest;delete s.direct_campaign.pac_money_basis;delete s.direct_campaign.pac_money_coverage_note;
    s.direct_campaign.total_raised=999;s.outside_spending.support_total=55;s.last_synced_at="2026-10-01T00:00:00.000Z";const before=structuredClone(s),map=new Map<string,BallotLookupFinanceSummary>([[key,s]]);
    await overlayIdahoReportedPacReceipts(dbFor([row]),map,candidates,elections);expect(map.get(key)!.direct_campaign.total_raised).toBe(999);expect(map.get(key)!.outside_spending).toEqual(before.outside_spending);expect(map.get(key)!.last_synced_at).toBe(before.last_synced_at);
  });
  it("performs no new-table query when either gate is off or office is ineligible",async()=>{
    for(const flag of["IDAHO_CAMPAIGN_FINANCE_ENABLED","IDAHO_REPORTED_PAC_RECEIPTS_ENABLED"]){vi.stubEnv(flag,"false");const db=dbFor([row]);expect((await overlayIdahoReportedPacReceipts(db,new Map(),candidates,elections)).size).toBe(0);expect(db.query).not.toHaveBeenCalled();vi.stubEnv(flag,"true");}
    const db=dbFor([row]);await overlayIdahoReportedPacReceipts(db,new Map(),candidates,[{...elections[0]!,office_scope:"federal",office_canonical_name:"US Senator"}]);expect(db.query).not.toHaveBeenCalled();
  });
  it("holds truncated groups, duplicate components and retargeted native registration",async()=>{
    for(const rows of[[{...row,pac_groups:(row.pac_groups as unknown[]).slice(0,5)}],[row,row],[{...row,registration_guid:pacGuid(90)}]])expect((await overlayIdahoReportedPacReceipts(dbFor(rows),new Map(),candidates,elections)).size).toBe(0);
  });
});
