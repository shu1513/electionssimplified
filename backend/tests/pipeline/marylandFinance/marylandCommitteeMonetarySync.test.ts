import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
vi.mock("../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryContext.js",()=>({loadMarylandCommitteeMonetaryContext:vi.fn()}));
vi.mock("../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryPacketLoader.js",()=>({loadMarylandCommitteeMonetaryPacket:vi.fn()}));
vi.mock("../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryWriter.js",()=>({replaceMarylandCommitteeMonetarySnapshot:vi.fn()}));
vi.mock("../../../src/pipeline/marylandFinance/marylandNativeOutsideObservationLoader.js",()=>({loadMarylandNativeOutsideObservation:vi.fn().mockResolvedValue({status:"preserve",diagnostics:["fixture_source_unavailable"]})}));
import {loadMarylandCommitteeMonetaryContext as context} from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryContext.js";
import {loadMarylandCommitteeMonetaryPacket as load} from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryPacketLoader.js";
import {replaceMarylandCommitteeMonetarySnapshot as write} from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryWriter.js";
import {syncMarylandCommitteeMonetaryPackets as sync,type MarylandCommitteeMonetaryPacketConfiguration} from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetarySync.js";
import {syncDueMarylandCandidateFinance as batch} from "../../../src/pipeline/marylandFinance/marylandCandidateFinanceBatchSync.js";
const scope={candidateId:"11111111-1111-4111-8111-111111111111",electionId:"22222222-2222-4222-8222-222222222222",electionYear:2026,committeeId:"123"};
const now=new Date("2026-10-15T10:00:00Z");
const packet=()=>({...scope,source:{currentCensusDirectory:"/before"},receivingSources:{}} as unknown as MarylandCommitteeMonetaryPacketConfiguration);
const aggregation={positions:[{}],grossCents:100000,refundCents:120000,netCents:-20000};
const ready=()=>({status:"ready",privateSnapshot:{...scope,aggregation},diagnostics:[],sourceFacts:{},reports:[]} as unknown as Awaited<ReturnType<typeof load>>);
const db={query:vi.fn(),connect:vi.fn()} as never;
const dirs:string[]=[];
beforeEach(()=>{vi.clearAllMocks();vi.mocked(context).mockResolvedValue({...scope,linkId:"33333333-3333-4333-8333-333333333333"} as never);
  vi.mocked(load).mockResolvedValue(ready());vi.mocked(write).mockResolvedValue({positionsWritten:1});});
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
describe("independent ordinary Maryland committee component",()=>{
  it("writes a qualified signed component through its normal writer, returning only safe aggregates",async()=>{
    const result=await sync({db,dueRows:[scope],packets:[packet()],dryRun:false,now});
    expect(write).toHaveBeenCalledTimes(1);expect(result).toMatchObject({writtenCandidates:1,preservedCandidates:0,
      results:[{status:"written",positionCount:1,grossCents:100000,refundCents:120000,netCents:-20000}]});
    expect(JSON.stringify(result)).not.toContain(scope.committeeId);expect(JSON.stringify(result)).not.toContain("privateSnapshot");
  });
  it("verifies a dry run without calling the writer",async()=>{
    const result=await sync({db,dueRows:[scope],packets:[packet()],dryRun:true,now});
    expect(load).toHaveBeenCalledTimes(1);expect(write).not.toHaveBeenCalled();expect(result.results[0]!.status).toBe("ready");
  });
  it("preserves held source packets and failed atomic writes without emitting private error details",async()=>{
    vi.mocked(load).mockResolvedValueOnce({status:"preserve",diagnostics:["receipt_controls"],sourceFacts:{},reports:[]} as never);
    expect((await sync({db,dueRows:[scope],packets:[packet()],dryRun:false,now})).results[0]).toMatchObject({status:"preserve",diagnostics:["receipt_controls"]});
    expect(write).not.toHaveBeenCalled();vi.mocked(write).mockRejectedValueOnce(Error("private source row"));
    const failed=await sync({db,dueRows:[scope],packets:[packet()],dryRun:false,now});
    expect(failed.preservedCandidates).toBe(1);expect(JSON.stringify(failed)).not.toContain("private source row");
  });
  it("does not select unmatched packets or choose between duplicate scopes",async()=>{
    expect((await sync({db,dueRows:[scope],packets:[{...packet(),committeeId:"456"}],dryRun:false,now})).selectedPackets).toBe(0);
    expect((await sync({db,dueRows:[scope],packets:[packet(),packet()],dryRun:false,now})).results[0]!.diagnostics).toEqual(["ambiguous_packet_configuration"]);
    expect(context).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
  });
  it("preserves missing canonical contexts and malformed configuration",async()=>{
    vi.mocked(context).mockResolvedValueOnce(null);
    expect((await sync({db,dueRows:[scope],packets:[packet()],dryRun:false,now})).preservedCandidates).toBe(1);
    expect((await sync({db,dueRows:[scope],packets:[{...packet(),candidateId:null} as never],dryRun:false,now})).results[0]!.diagnostics).toEqual(["invalid_packet_configuration"]);
    expect(load).not.toHaveBeenCalled();
  });
  it("retains nested source descriptors and clock before canonical lookup yields",async()=>{
    let resume!:(value:Awaited<ReturnType<typeof context>>)=>void;
    vi.mocked(context).mockImplementationOnce(()=>new Promise(resolve=>{resume=resolve;}));
    const p=packet(),date=new Date(now),pending=sync({db,dueRows:[scope],packets:[p],dryRun:false,now:date});
    (p.source as {currentCensusDirectory:string}).currentCensusDirectory="/after";date.setUTCFullYear(2030);resume({...scope} as never);
    await pending;expect(vi.mocked(load).mock.calls[0]![0]).toMatchObject({source:{currentCensusDirectory:"/before"},now});
  });
  it("runs through the ordinary batch before broken legacy receipt artifacts can stop it",async()=>{
    const raw=await mkdtemp(join(tmpdir(),"md-component-batch-"));dirs.push(raw);vi.spyOn(console,"warn").mockImplementation(()=>{});
    const query=vi.fn().mockResolvedValue({rows:[{candidate_id:scope.candidateId,election_id:scope.electionId,election_year:2026,candidate_name:"Fixture Candidate",
      office_scope:"statewide",office_name:"Governor",district:null,committee_id:"123",committee_name:"Fixture Committee",source_url:null,last_synced_at:null,total_due_rows:1}]});
    const result=await batch({db:{query,connect:vi.fn()} as never,rawDataCacheDir:raw,autoLinkMissingLinks:false,dryRun:false,now});
    expect(result.failedCandidateCount).toBe(1);expect(write).not.toHaveBeenCalled();
    const withPacket=await batch({db:{query,connect:vi.fn()} as never,rawDataCacheDir:raw,autoLinkMissingLinks:false,dryRun:false,now,committeeMonetaryPackets:[packet()]});
    expect(withPacket.failedCandidateCount).toBe(1);expect(withPacket.committeeMonetary?.writtenCandidates).toBe(1);expect(write).toHaveBeenCalledTimes(1);
  });
});
