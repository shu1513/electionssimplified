import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {acquireMontanaCersOutsideSpendingArtifacts} from "../../../src/pipeline/montanaFinance/montanaOutsideSpendingAcquisition.js";
import {readMontanaCersArtifact} from "../../../src/pipeline/montanaFinance/montanaCersArtifactCache.js";
import {readMontanaIndependentIeSource,montanaIePacketAggregation,montanaIePacketCandidates} from "../../../src/pipeline/montanaFinance/montanaIndependentIeSource.js";
import {createMontanaIeHttpArchive} from "../../../src/pipeline/montanaFinance/montanaNativeHttpArchive.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs)await fs.rm(d,{recursive:true,force:true});dirs.length=0;});
const table=(rows:unknown[])=>({iTotalRecords:rows.length,iTotalDisplayRecords:rows.length,aaData:rows});
async function source(options:{version?:string;wrongCount?:boolean}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"mt-ie-source-"));dirs.push(dir);
  const fetchImpl=async(input:string)=>{
    const name=new URL(input).pathname.split("/").at(-1);let value:unknown='<title>CERS (searchResults)</title>';
    if(name==="listFinancialCommitteeResults")value=table([{committeeId:200,committeeName:"Synthetic committee",committeeTypeCode:"PA",electionYear:"2026"}]);
    if(name==="viewFinancialEntities")value={resultCount:options.wrongCount?2:1};
    if(name==="listViewFinancialEntityResults")value=table([{transId:1,transTypeDesr:"Independent Expenditure",amountTypeDescr:"General",cashAmt:100,inKindAmt:25,totalAmt:125,
      datePaid:Date.UTC(2026,5,1),candidateIssue:"Synthetic Q Candidate (HD-12)",purposeDescr:"Synthetic mailing",electioneeringInd:"N",previousTransactionInd:options.version??"N"}]);
    if(name==="listCandidateResults")value=table([{candidateId:100,electionYear:"2026",personDTO:{firstName:"Synthetic",middleInitial:"Q",lastName:"Candidate"},officeTitle:"House District No. 12"}]);
    return new Response(typeof value==="string"?value:JSON.stringify(value),{status:200});
  };
  return {dir,acquire:()=>acquireMontanaCersOutsideSpendingArtifacts({year:2026,cacheDir:dir,sessionOptions:{fetchImpl,spacingMs:0,sleep:async()=>{}}})};
}
describe("Montana independent IE original source",()=>{
  it("qualifies complete native responses and actual clocks independently of any candidate filing",async()=>{
    const f=await source();await f.acquire();const p=await readMontanaIndependentIeSource(2026,f.dir);expect(p).not.toBeNull();
    expect(p!.sourceOriginalCount).toBe(6);expect(Date.parse(p!.sourceRetrievedAt)).toBeLessThanOrEqual(Date.parse(p!.sourceCompletedAt));
    expect(montanaIePacketAggregation(p!,100)).toMatchObject({supportTotal:125,opposeTotal:null,outsideGroups:[{committeeId:"200",amount:125}]});
    const copy=montanaIePacketCandidates(p!);copy[0]!.firstName="Changed";expect(montanaIePacketCandidates(p!)[0]!.firstName).toBe("Synthetic");
    expect(()=>montanaIePacketCandidates({...p!})).toThrow(/unverified_original_packet/);
    // No report-inventory or direct contribution artifact exists in this flow.
    await expect(readMontanaCersArtifact({cacheDir:f.dir,key:{type:"report_inventory",candidateId:100,year:2026}})).rejects.toThrow();
  });
  it("refuses old/noncurrent rows even when a legacy sweep can be parsed",async()=>{
    const f=await source({version:"Y"});await f.acquire();expect(await readMontanaIndependentIeSource(2026,f.dir)).toBeNull();
  });
  it("refuses corrupted original bytes and preserves the saved source date",async()=>{
    const f=await source();await f.acquire();const saved=await readMontanaCersArtifact({cacheDir:f.dir,key:{type:"ie_sweep",year:2026}}),original=JSON.parse(saved.body).originalArchiveDirectory;
    const records=(await fs.readFile(path.join(f.dir,original,"manifest.ndjson"),"utf8")).trim().split("\n").map(x=>JSON.parse(x)),chosen=records.find(x=>x.url.includes("listViewFinancialEntityResults"));
    await fs.writeFile(path.join(f.dir,original,String(chosen.ordinal).padStart(4,"0")+".original"),"changed");
    expect(await readMontanaIndependentIeSource(2026,f.dir)).toBeNull();expect((await readMontanaCersArtifact({cacheDir:f.dir,key:{type:"ie_sweep",year:2026}})).manifest.retrievedAt).toBe(saved.manifest.retrievedAt);
  });
  it("does not qualify partial native count controls",async()=>{
    const f=await source({wrongCount:true});await expect(f.acquire()).rejects.toThrow();expect(await readMontanaIndependentIeSource(2026,f.dir)).toBeNull();
  });
  it("installs private raw originals under a restrictive umask",async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"mt-ie-mode-"));dirs.push(dir);const previous=process.umask(0o777);
    try{const a=await createMontanaIeHttpArchive(2026,dir,{spacingMs:0,fetchImpl:async()=>new Response('{}')}),r=await a.sessionOptions.fetchImpl!("https://cers-ext.mt.gov/CampaignTracker/public/search/candidateSearch",{method:"GET",headers:{},redirect:"manual",signal:AbortSignal.timeout(1000)});await r.arrayBuffer();
      const folder=path.join(dir,a.relativeDirectory);expect((await fs.stat(folder)).mode&0o777).toBe(0o700);for(const file of await fs.readdir(folder))expect((await fs.stat(path.join(folder,file))).mode&0o777).toBe(0o600);
    }finally{process.umask(previous);}
  });
});
