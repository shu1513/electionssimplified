import {afterEach,describe,expect,it} from "vitest";
import {mkdtemp,writeFile,chmod,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readMarylandCommitteePacketConfiguration as read} from "../../../src/pipeline/marylandFinance/marylandCommitteePacketConfiguration.js";
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const packet={candidateId:"11111111-1111-4111-8111-111111111111",electionId:"22222222-2222-4222-8222-222222222222",electionYear:2026,committeeId:"123",
  source:{currentCensusDirectory:"/private/current",priorCensusDirectory:"/private/prior",priorCycle:"12019",inventoryDirectory:"/private/inventory",documents:[]},
  receivingSources:{numericRegistration:{captures:[]},nameRegistration:{captures:[]},rosterCapture:{},dateCapture:{},cycleCapture:{}}};
async function file(value:unknown={version:1,packets:[packet]}){
  const dir=await mkdtemp(join(tmpdir(),"md-packet-configuration-"));dirs.push(dir);await chmod(dir,0o700);
  const path=join(dir,"packets.json");await writeFile(path,JSON.stringify(value),{mode:0o600});return {dir,path};
}
describe("Maryland private source packet configuration",()=>{
  it("reads source descriptors without granting financial readiness",async()=>{
    const f=await file(),result=await read(f.path);expect(result).toEqual([packet]);expect(result[0]).not.toHaveProperty("ready");
  });
  it.each([{version:2,packets:[packet]},{version:1,packets:[{...packet,approved:true}]},{version:1,packets:[{...packet,canonical:{}}]},
    {version:1,packets:[{...packet,electionYear:2026.5}]},{version:1,packets:[{...packet,committeeId:"unscoped"}]},{version:1,packets:[null]},
    {version:1,packets:[{...packet,source:{...packet.source,approved:true}}]},
    {version:1,packets:[{...packet,receivingSources:{...packet.receivingSources,canonical:{}}}]},
    {version:1,packets:[{...packet,source:{...packet.source,documents:[{reportGuid:packet.candidateId,reportVersionId:1,originalPath:"/private/report.pdf",captureJournalPath:"/private/captures.json",money:10}]}}]}])("holds invalid configuration without leaking its contents %j",async value=>{
    const f=await file(value);await expect(read(f.path)).rejects.toThrow(/^invalid_maryland_committee_packet_configuration$/);
  });
  it("requires a private regular file and directory",async()=>{
    const f=await file();await chmod(f.path,0o644);await expect(read(f.path)).rejects.toThrow("invalid_maryland_committee_packet_configuration");
    await chmod(f.path,0o600);await chmod(f.dir,0o755);await expect(read(f.path)).rejects.toThrow("invalid_maryland_committee_packet_configuration");
    await chmod(f.dir,0o700);const alias=join(f.dir,"alias.json");await symlink(f.path,alias);await expect(read(alias)).rejects.toThrow("invalid_maryland_committee_packet_configuration");
  });
});
