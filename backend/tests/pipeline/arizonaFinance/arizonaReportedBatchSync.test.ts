import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const h=vi.hoisted(()=>({list:vi.fn(),lock:vi.fn(),write:vi.fn(),aggregate:vi.fn(),load:vi.fn(),factory:vi.fn()}));
vi.mock("../../../src/pipeline/arizonaFinance/arizonaReportedStore.js",()=>({listArizonaReportedReceivers:h.list,lockArizonaReportedReceiver:h.lock,writeArizonaReportedComponent:h.write,aggregateArizonaReported:h.aggregate}));
vi.mock("../../../src/pipeline/arizonaFinance/arizonaReportedSource.js",()=>({createArizonaReportedSource:h.factory}));
import {syncDueArizonaReportedFinance}from"../../../src/pipeline/arizonaFinance/arizonaReportedBatchSync.js";
import {ArizonaReportedHold}from"../../../src/pipeline/arizonaFinance/arizonaReportedCore.js";
const r=(i=1)=>({linkId:`synthetic-link-${String(i).padStart(3,"0")}`,candidateId:`synthetic-candidate-${i}`,electionId:"synthetic-election",electionDate:"2026-11-03",electionYear:2026});
const now=new Date("2026-10-19T18:00:00.000Z");
let stored:any[]=[],attempts:any[]=[];
const client={query:vi.fn(async()=>({rows:[{one:1}]})),release:vi.fn()},db={connect:vi.fn(async()=>client),query:vi.fn(async(s:string)=>({rows:s.includes("_components")?stored:attempts}))};
beforeEach(()=>{
  vi.clearAllMocks();stored=[];attempts=[];
  for(const k of["CANDIDATE_FINANCE_ENABLED","CANDIDATE_FINANCE_SYNC_ENABLED","ARIZONA_CAMPAIGN_FINANCE_ENABLED","ARIZONA_CAMPAIGN_FINANCE_SYNC_ENABLED","ARIZONA_REPORTED_COMMITTEE_ENABLED","ARIZONA_INDEPENDENT_IE_ENABLED"])vi.stubEnv(k,"true");
  vi.stubEnv("ARIZONA_REPORTED_RAW_REFRESH_ENABLED","false");
  h.list.mockResolvedValue([r()]);h.factory.mockResolvedValue({load:h.load});h.load.mockImplementation(async(receiver,kind)=>({receiver,kind}));
  h.aggregate.mockImplementation((_,s)=>({groups:[],totalCents:s.kind==="committee"?1000:2000,supportCents:s.kind==="ie"?2000:0,opposeCents:0}));h.write.mockResolvedValue({groups:0,idempotent:false});
});
afterEach(()=>vi.unstubAllEnvs());
describe("Arizona independent component due selection",()=>{
  it("writes IE when receipt acquisition fails, without advancing receipt success",async()=>{
    h.load.mockImplementation(async(receiver,kind)=>{if(kind==="committee")throw new ArizonaReportedHold("income_unavailable");return{receiver,kind};});
    const result=await syncDueArizonaReportedFinance({db:db as any,now});
    expect(result.committeeWrittenCount).toBe(0);expect(result.ieWrittenCount).toBe(1);expect(result.heldReasons).toEqual({income_unavailable:1});
    expect(h.write).toHaveBeenCalledTimes(1);expect(h.write.mock.calls[0]![0].source.kind).toBe("ie");
  });
  it("uses ordinary 25-candidate batches and rotates past recent failed attempts",async()=>{
    h.list.mockResolvedValue(Array.from({length:30},(_,i)=>r(i+1)));
    const first=await syncDueArizonaReportedFinance({db:db as any,now});expect(first.selectedCount).toBe(25);expect(first.attemptedCount).toBe(50);
    const selected=h.load.mock.calls.map(([receiver])=>receiver.linkId);h.load.mockClear();
    attempts=Array.from(new Set(selected)).flatMap(link_id=>["committee","ie"].map(component=>({link_id,component,receiver_context:r(Number(link_id.slice(-3))),source_revision:"old-revision",last_attempted_at:now.toISOString()})));
    // Attempt revisions changed: all remain due, but never-attempted candidates
    // sort before the previously attempted prefix under the same default cap.
    const second=await syncDueArizonaReportedFinance({db:db as any,now});expect(second.selectedCount).toBe(25);
    expect(h.load.mock.calls.slice(0,10).map(([receiver])=>receiver.linkId)).toEqual(Array.from({length:5},(_,i)=>[r(i+26).linkId,r(i+26).linkId]).flat());
  });
  it("includes post-election receivers through the January filing deadline",async()=>{
    const result=await syncDueArizonaReportedFinance({db:db as any,now:new Date("2027-01-18T18:00:00.000Z")});expect(result.selectedCount).toBe(1);
    expect((await syncDueArizonaReportedFinance({db:db as any,now:new Date("2027-03-01T18:00:00.000Z")})).selectedCount).toBe(0);
  });
  it("does not perform DB or source work when global/state/component/sync flags are disabled",async()=>{
    for(const key of["CANDIDATE_FINANCE_ENABLED","CANDIDATE_FINANCE_SYNC_ENABLED","ARIZONA_CAMPAIGN_FINANCE_ENABLED","ARIZONA_CAMPAIGN_FINANCE_SYNC_ENABLED"]){
      vi.stubEnv(key,"false");const result=await syncDueArizonaReportedFinance({db:db as any,now,refresh:true});expect(result.enabled).toBe(false);vi.stubEnv(key,"true");
    }
    expect(h.list).not.toHaveBeenCalled();expect(h.factory).not.toHaveBeenCalled();
  });
  it("raw refresh grants neither a disabled component nor live-source permission",async()=>{
    vi.stubEnv("ARIZONA_REPORTED_COMMITTEE_ENABLED","false");
    const result=await syncDueArizonaReportedFinance({db:db as any,now,refresh:true});expect(result.committeeWrittenCount).toBe(0);expect(result.ieWrittenCount).toBe(1);
    expect(h.factory).toHaveBeenCalledWith(expect.objectContaining({allowLive:false}));
  });
  it("holds every selected component when source cache initialization fails",async()=>{
    h.factory.mockRejectedValue(Object.assign(Error("EACCES: permission denied"),{code:"EACCES"}));
    const result=await syncDueArizonaReportedFinance({db:db as any,now,refresh:true});
    expect(result.attemptedCount).toBe(2);expect(result.writtenCount).toBe(0);expect(result.heldReasons).toEqual({source_unavailable:2});
    expect(result.sourceUnavailableCount).toBe(2);expect(result.refreshFailedCount).toBe(2);expect(h.load).not.toHaveBeenCalled();
  });
  it("reports unavailable source requests separately from context/closure holds",async()=>{
    h.load.mockImplementation(async(receiver,kind)=>{if(kind==="committee")throw new ArizonaReportedHold("source_unavailable");return{receiver,kind};});
    const result=await syncDueArizonaReportedFinance({db:db as any,now});expect(result.sourceUnavailableCount).toBe(1);expect(result.refreshFailedCount).toBe(0);expect(result.ieWrittenCount).toBe(1);
    expect((await syncDueArizonaReportedFinance({db:db as any,now,refresh:true})).refreshFailedCount).toBe(1);
  });
});
