import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredMassachusettsReportedComponent, attachMassachusettsReportedFinance } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedReader.js";
import { MA_REPORTED_REVISION } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedCore.js";
import { isMassachusettsIndependentIeEnabled, isMassachusettsReportedCommitteeEnabled, isMassachusettsReportedRawRefreshEnabled } from "../../../src/config/featureFlags.js";
import type { MassachusettsReportedReceiver } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedReceiver.js";
const receiver = { linkId:"link",candidateId:"candidate",electionId:"election",electionYear:2026 } as MassachusettsReportedReceiver;
const clock="2026-10-18T00:00:00.000Z";
const fixture = () => ({ link_id:"link",candidate_id:"candidate",election_id:"election",election_year:2026,component:"committee",receiver_context:{...receiver},
  source_observed_at:clock,last_synced_at:clock,source_facts:{revision:MA_REPORTED_REVISION,kind:"committee",electionYear:2026,sourceAt:clock,
    acquisitionStartedAt:clock,profileAt:clock,oldestBodyAt:clock,newestBodyAt:clock,sourceHash:"a".repeat(64),profileHash:"b".repeat(64),sourceRows:60,reportCount:0,windowStart:"2026-01-01",windowEnd:"2026-12-31"},
  aggregation_controls:{totalCents:6000,supportCents:0,opposeCents:0,sourceRows:60,includedRows:60} });
const groups = () => Array.from({length:60},(_,i)=>({link_id:"link",election_year:2026,component:"committee",group_key:JSON.stringify(["Committee","",`EXAMPLE ${i}`]),reported_name:`Example ${i}`,source_class:"Committee",stance:"direct",amount_cents:"100",occurrence_count:1}));
afterEach(()=>vi.unstubAllEnvs());
describe("Massachusetts stored components",()=>{
  it("validates every group before the presentation cap",()=>expect(readStoredMassachusettsReportedComponent(fixture(),groups(),receiver).groups).toHaveLength(60));
  it.each(["missing final group","late corrupted cents","duplicate key","wrong context","source clock mismatch","future sync","wrong calendar","bad source hash","wrong receipt count"])("holds %s",kind=>{
    const row=fixture(),g=groups();
    if(kind==="missing final group")g.pop();
    if(kind==="late corrupted cents")g[59]!.amount_cents="101";
    if(kind==="duplicate key")g[59]!.group_key=g[0]!.group_key;
    if(kind==="wrong context")row.receiver_context.candidateId="other";
    if(kind==="source clock mismatch")row.source_observed_at="2026-10-17T00:00:00.000Z";
    if(kind==="future sync")row.last_synced_at="2099-01-01T00:00:00.000Z";
    if(kind==="wrong calendar")row.source_facts.windowStart="2025-01-01";
    if(kind==="bad source hash")row.source_facts.sourceHash="";
    if(kind==="wrong receipt count")row.source_facts.sourceRows=61;
    expect(()=>readStoredMassachusettsReportedComponent(row,g,receiver)).toThrow();
  });
  it("disabled readers preserve the supplied map without DB access",async()=>{
    vi.stubEnv("MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED","false");const query=vi.fn(),summaries=new Map();
    expect(await attachMassachusettsReportedFinance({db:{query},requests:[{candidate_id:"candidate",election_id:"election"} as any],summaries})).toBe(summaries);expect(query).not.toHaveBeenCalled();
  });
  it.each([isMassachusettsIndependentIeEnabled,isMassachusettsReportedCommitteeEnabled,isMassachusettsReportedRawRefreshEnabled])("force cannot grant a component or acquisition gate",fn=>{
    vi.stubEnv("MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED","true");
    for(const key of ["MASSACHUSETTS_INDEPENDENT_IE_ENABLED","MASSACHUSETTS_REPORTED_COMMITTEE_ENABLED","MASSACHUSETTS_REPORTED_RAW_REFRESH_ENABLED"])vi.stubEnv(key,"false");
    expect((fn as any)(true)).toBe(false);
  });
});
