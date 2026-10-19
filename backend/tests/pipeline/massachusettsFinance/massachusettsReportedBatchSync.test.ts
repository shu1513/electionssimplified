import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MassachusettsReportedHold } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedCore.js";
const mocks = vi.hoisted(()=>({list:vi.fn(),lock:vi.fn(),write:vi.fn(),aggregate:vi.fn(),packet:vi.fn(),receiver:vi.fn()}));
vi.mock("../../../src/pipeline/massachusettsFinance/massachusettsReportedStore.js",()=>({listMassachusettsReportedReceivers:mocks.list,lockMassachusettsReportedReceiver:mocks.lock,writeMassachusettsReportedComponent:mocks.write,aggregateMassachusettsReported:mocks.aggregate}));
vi.mock("../../../src/pipeline/massachusettsFinance/massachusettsReportedSource.js",()=>({loadMassachusettsReportedPacket:mocks.packet,loadMassachusettsReceiverPacket:mocks.receiver}));
import { syncDueMassachusettsReportedFinance } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedBatchSync.js";
const r={linkId:"link",electionDate:"2026-11-03",electionYear:2026};
function database(stored:any[]=[],attempts:any[]=[]) {
  const client={query:vi.fn(async(sql:string)=>({rows:sql.startsWith("INSERT")?[{}]:[]})),release:vi.fn()};
  const query=vi.fn(async(sql:string)=>({rows:sql.includes("components")?stored:attempts}));
  return {query,connect:vi.fn(async()=>client)} as any;
}
beforeEach(()=>{
  vi.clearAllMocks();for(const k of ["MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED","MASSACHUSETTS_REPORTED_COMMITTEE_ENABLED","MASSACHUSETTS_INDEPENDENT_IE_ENABLED"])vi.stubEnv(k,"true");
  mocks.list.mockResolvedValue([r]);mocks.lock.mockResolvedValue(undefined);mocks.write.mockResolvedValue({groups:0,idempotent:false});
  mocks.packet.mockImplementation(async(kind:string)=>({kind}));mocks.receiver.mockImplementation(async(receiver:any,packet:any)=>({receiver,packet}));
  mocks.aggregate.mockReturnValue({groups:[],totalCents:0,supportCents:0,opposeCents:0});
});
afterEach(()=>vi.unstubAllEnvs());
describe("Massachusetts independent component scheduling",()=>{
  it("disabled gates do no DB or source work",async()=>{
    vi.stubEnv("MASSACHUSETTS_CAMPAIGN_FINANCE_ENABLED","false");const db=database();
    expect((await syncDueMassachusettsReportedFinance({db})).enabled).toBe(false);expect(mocks.list).not.toHaveBeenCalled();expect(mocks.packet).not.toHaveBeenCalled();
  });
  it("empty cohort does not acquire global IE",async()=>{
    mocks.list.mockResolvedValue([]);await syncDueMassachusettsReportedFinance({db:database()});expect(mocks.packet).not.toHaveBeenCalled();
  });
  it("committee acquisition failure does not suppress IE storage",async()=>{
    mocks.packet.mockImplementation(async(kind:string)=>{if(kind==="committee")throw Error("unavailable");return{kind}});
    const result=await syncDueMassachusettsReportedFinance({db:database()});expect(result.sourceUnavailableCount).toBe(1);expect(result.ieWrittenCount).toBe(1);expect(result.committeeWrittenCount).toBe(0);
  });
  it("held committee ledger does not suppress IE storage",async()=>{
    mocks.receiver.mockImplementation(async(receiver:any,packet:any)=>{if(packet.kind==="committee")throw new MassachusettsReportedHold("unknown_receipt_type");return{receiver,packet}});
    const result=await syncDueMassachusettsReportedFinance({db:database()});expect(result.heldCount).toBe(1);expect(result.ieWrittenCount).toBe(1);
  });
  it("fresh components do not acquire sources",async()=>{
    const now=new Date("2026-10-19T00:00:00.000Z"),stored=["committee","ie"].map(component=>({link_id:"link",component,receiver_context:r,last_synced_at:now.toISOString()}));
    expect((await syncDueMassachusettsReportedFinance({db:database(stored),now})).selectedCount).toBe(0);expect(mocks.packet).not.toHaveBeenCalled();
  });
  it("default batch caps receivers, not source reports or donor groups",async()=>{
    mocks.list.mockResolvedValue(Array.from({length:30},(_,i)=>({...r,linkId:String(i).padStart(2,"0")})));
    const result=await syncDueMassachusettsReportedFinance({db:database()});expect(result.selectedCount).toBe(25);expect(result.attemptedCount).toBe(50);
  });
  it("post-election year-end grace retains the general cohort",async()=>{
    const result=await syncDueMassachusettsReportedFinance({db:database(),now:new Date("2027-01-23T00:00:00.000Z")});expect(result.eligibleCount).toBe(1);
    const expired=await syncDueMassachusettsReportedFinance({db:database(),now:new Date("2027-02-11T00:00:00.000Z")});expect(expired.eligibleCount).toBe(0);
  });
});
