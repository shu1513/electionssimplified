import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {buildFloridaVerifiedCommitteeDonors} from "../../../src/pipeline/floridaFinance/floridaVerifiedCommitteeDonorSource.js";
import type {FloridaContributionRow} from "../../../src/pipeline/floridaFinance/floridaCampaignFinanceRows.js";
import type {FloridaProcessedFinanceProof} from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";
import type {FloridaCommitteeRegistryLookupResult} from "../../../src/pipeline/floridaFinance/floridaCommitteeRegistrySource.js";
// Synthetic composed-proof fixtures only. The normal raw verifier establishes actual authority.
const h="a".repeat(64), source="https://dos.elections.myflorida.com";
const context={sourceAccount:"88773",candidateName:"Example Candidate",genericRecipientName:"Candidate, Example (DEM)(STR)",
 electionYear:2026,officeName:"State Representative",district:"9"};
function row(change:Partial<FloridaContributionRow>={}):FloridaContributionRow{
 return {recipientName:context.genericRecipientName,contributionDate:"2026-01-01",amount:"1000.00",transactionType:"CHE",
 contributorName:"Example PAC",address:"1 Main St.",cityStateZip:"City FL 12345",city:"",state:"",zip:"",
 occupation:"",inKindDescription:"",...change};
}
function proof(rows:FloridaContributionRow[]=[row()]):FloridaProcessedFinanceProof{
 const nativeRows=rows.map(r=>({reportYear:2026,reportType:"Q1",date:r.contributionDate,
 amountCents:Math.round(Number(r.amount)*100),contributorName:r.contributorName,address:r.address,
 cityStateZip:r.cityStateZip!,occupation:r.occupation,transactionType:r.transactionType,inKindDescription:r.inKindDescription}));
 const identities=nativeRows.map(r=>[r.date,r.amountCents,r.contributorName,r.address,r.cityStateZip,r.occupation,r.transactionType,r.inKindDescription]);
 const financialFingerprint=createHash("sha256").update(JSON.stringify(identities.map(r=>JSON.stringify(r)).sort())).digest("hex");
 const metadata=Array.from({length:8},(_,i)=>({url:source+"/candidates/CanDetail.asp?account=88773",
 method:"GET" as const,financeFields:null,status:200,contentType:"text/html",sha256:h,byteCount:100,
 startedAt:new Date(Date.UTC(2026,9,11,20,0,i)).toISOString(),completedAt:new Date(Date.UTC(2026,9,11,20,0,i,100)).toISOString(),
 phase:i<4?"before" as const:"after" as const}));
 return {version:1,authority:"current_processed",context:{...context},windowStart:"2025-01-01",windowEnd:"2026-12-31",
 rows,nativeRows,reports:[{account:context.sourceAccount,candidateName:context.candidateName,electionYear:2026,
 sequence:6,reportYear:2026,reportType:"Q1",periodStart:"2026-01-01",periodEnd:"2026-03-31",dueDate:"2026-04-10",
 filedAt:"2026-04-10",reviewedAt:"2026-04-11",fileStatus:"Filed Report",reviewStatus:"Reviewed",completeness:"Complete Detail Records",
 queued:0,contributionCount:rows.length,amended:true,waiver:false,fullMetadata:{current:true},nativeSequence:6,
 monetaryCents:100000,loanCents:0,inKindCents:0,financialFingerprint:h}],financialFingerprint,
 sourceHashes:metadata.map(m=>m.sha256),sourceMetadata:metadata};
}
function resolved(name="Example PAC",type="PAC",id="64858"):FloridaCommitteeRegistryLookupResult{
 return {status:"resolved",diagnostics:[],sourceHashes:Array(6).fill(h),
 identity:{committeeId:id,committeeName:name,committeeType:type,sourceUrl:source+"/committees/ComDetail.asp?account="+id,
 includedInCommitteeDonorScope:["PAC","CCE","PTY","PAP"].includes(type)&&id!==context.sourceAccount,resolution:"unique_exact_name"}};
}
const absent=():FloridaCommitteeRegistryLookupResult=>({status:"not_found",diagnostics:[],sourceHashes:Array(4).fill(h)});
describe("Florida processed-proof committee donor composition",()=>{
 it("nets signed refunds and preserves equal distinct positive occurrences",async()=>{
  const p=proof([row(),row(),row({transactionType:"REF",amount:"-500.00"})]);
  const calls:unknown[]=[];
  const r=await buildFloridaVerifiedCommitteeDonors({proof:p,lookupDonor:async input=>{calls.push(input);return resolved();}});
  expect(r.status).toBe("accepted");
  if(r.status!=="accepted")throw Error(r.reason);
  expect(r.donors).toMatchObject([{amount:1500,grossAmount:2000,refundAmount:500,contributionCount:2,refundCount:1}]);
  expect(r.netCommitteeAmount).toBe(1500);expect(calls).toHaveLength(3);
  expect(r.provenance.registryLookups.map(x=>x.occurrence)).toEqual([0,1,2]);
  expect(r.provenance.registryLookups[0].rowFingerprint).toBe(r.provenance.registryLookups[1].rowFingerprint);
  expect(r.provenance.reports[0].amended).toBe(true);
 });
 it("accepts only receiving-label whitespace serialization while preserving both raw values",async()=>{
  const p=proof([row({recipientName:"Candidate, Example  (DEM)(STR)"})]);
  const r=await buildFloridaVerifiedCommitteeDonors({proof:p,lookupDonor:async()=>resolved()});
  expect(r.status).toBe("accepted");
  expect(p.rows[0].recipientName).toBe("Candidate, Example  (DEM)(STR)");
  const wrong=proof([row({recipientName:"Candidate Example (DEM)(STR)"})]);
  expect(await buildFloridaVerifiedCommitteeDonors({proof:wrong,lookupDonor:async()=>resolved()}))
    .toMatchObject({status:"preserve"});
 });
 it.each(["PAC","CCE","PTY","PAP"])("retains exact committee class %s",async type=>{
  const r=await buildFloridaVerifiedCommitteeDonors({proof:proof(),lookupDonor:async()=>resolved("Example PAC",type)});
  expect(r.status==="accepted"&&r.donors[0].committeeType).toBe(type);
 });
 it.each(["ECO","ECI","IXO","CAN"])("excludes positively resolved distinct class %s without PAC promotion",async type=>{
  const r=await buildFloridaVerifiedCommitteeDonors({proof:proof(),lookupDonor:async()=>resolved("Example PAC",type)});
  expect(r).toMatchObject({status:"accepted",donors:[],netCommitteeAmount:0,unclassifiedPositiveCashAmount:0});
 });
 it("excludes source account self identity rather than personal-name guesses",async()=>{
  const r=await buildFloridaVerifiedCommitteeDonors({proof:proof(),lookupDonor:async()=>resolved("Example PAC","PAC","88773")});
  expect(r).toMatchObject({status:"accepted",donors:[],netCommitteeAmount:0});
 });
 it("keeps unmatched positive cash unclassified but preserves unmatched REF",async()=>{
  const r=await buildFloridaVerifiedCommitteeDonors({proof:proof(),lookupDonor:async()=>absent()});
  expect(r).toMatchObject({status:"accepted",donors:[],unclassifiedPositiveCashAmount:1000,unclassifiedPositiveCashCount:1});
  expect(await buildFloridaVerifiedCommitteeDonors({proof:proof([row(),row({amount:"-500",transactionType:"REF",contributorName:"Unknown Alias"})]),
   lookupDonor:async x=>x.reportedName==="Unknown Alias"?absent():resolved()})).toMatchObject({status:"preserve",reason:"unresolved_refund_identity"});
 });
 it("preserves unresolved positive registry and lookup transport failures",async()=>{
  for(const lookup of [async()=>({status:"unresolved",diagnostics:["ambiguous class/date"],sourceHashes:[]} as FloridaCommitteeRegistryLookupResult),
   async()=>{throw Error("HTTP500");}]){
   expect(await buildFloridaVerifiedCommitteeDonors({proof:proof(),lookupDonor:lookup})).toMatchObject({status:"preserve"});
  }
 });
 it("does not query non-gift source types",async()=>{
  let calls=0;
  const r=await buildFloridaVerifiedCommitteeDonors({proof:proof(["COF","INK","LOA","INT"].map(transactionType=>row({transactionType}))),
   lookupDonor:async()=>{calls++;return resolved();}});
  expect(r).toMatchObject({status:"accepted",donors:[],netCommitteeAmount:0});expect(calls).toBe(0);
 });
 it("passes exact full address/location/date/receiver without alias or locality splitting",async()=>{
  const r=row({contributorName:"Exact (P.A.C.)",address:"101 Main St., Suite 2",cityStateZip:"Foreign City 99"});
  let input:unknown;
  await buildFloridaVerifiedCommitteeDonors({proof:proof([r]),lookupDonor:async x=>{input=x;return resolved("Exact (P.A.C.)");}});
  expect(input).toEqual({reportedName:r.contributorName,reportedAddress:r.address,reportedCityStateZip:r.cityStateZip,
   transactionDate:"2026-01-01",receivingCommitteeId:"88773"});
 });
 it.each([
  (p:FloridaProcessedFinanceProof)=>{p.version=2 as 1;},
  (p:FloridaProcessedFinanceProof)=>{p.authority="original" as "current_processed";},
  (p:FloridaProcessedFinanceProof)=>{p.context.sourceAccount="088773";},
  (p:FloridaProcessedFinanceProof)=>{p.context.district="unknown";},
  (p:FloridaProcessedFinanceProof)=>{p.windowStart="2026-02-30";},
  (p:FloridaProcessedFinanceProof)=>{p.windowEnd="2024-01-01";},
  (p:FloridaProcessedFinanceProof)=>{p.rows[0].recipientName="Wrong Receiver";},
  (p:FloridaProcessedFinanceProof)=>{p.rows[0].contributionDate="2024-01-01";},
  (p:FloridaProcessedFinanceProof)=>{p.rows[0].amount="1.001";},
  (p:FloridaProcessedFinanceProof)=>{p.rows[0].amount="-1000";},
  (p:FloridaProcessedFinanceProof)=>{p.rows[0].transactionType="UNKNOWN";},
  (p:FloridaProcessedFinanceProof)=>{p.rows[0].contributorName="";},
  (p:FloridaProcessedFinanceProof)=>{p.financialFingerprint="b".repeat(64);},
  (p:FloridaProcessedFinanceProof)=>{p.nativeRows=[];},
  (p:FloridaProcessedFinanceProof)=>{p.reports=[];},
  (p:FloridaProcessedFinanceProof)=>{p.reports[0].account="123";},
  (p:FloridaProcessedFinanceProof)=>{p.reports[0].queued=1;},
  (p:FloridaProcessedFinanceProof)=>{p.reports=[p.reports[0],p.reports[0]];},
  (p:FloridaProcessedFinanceProof)=>{p.sourceHashes=[];},
  (p:FloridaProcessedFinanceProof)=>{p.sourceMetadata[0].url="https://example.com";},
  (p:FloridaProcessedFinanceProof)=>{p.sourceMetadata[0].status=500;},
  (p:FloridaProcessedFinanceProof)=>{p.sourceMetadata[4].startedAt=p.sourceMetadata[0].startedAt;},
 ])("rejects malformed processed proof before any registry request %#",async change=>{
  const p=proof();change(p);let calls=0;
  expect(await buildFloridaVerifiedCommitteeDonors({proof:p,lookupDonor:async()=>{calls++;return resolved();}})).toMatchObject({status:"preserve"});
  expect(calls).toBe(0);
 });
 it.each([
  ()=>({...resolved(),identity:{...resolved().identity!,committeeName:"Guessed Alias"}}),
  ()=>({...resolved(),identity:{...resolved().identity!,sourceUrl:"https://example.com"}}),
  ()=>({...resolved(),identity:{...resolved().identity!,includedInCommitteeDonorScope:false}}),
  ()=>({...resolved(),identity:{...resolved().identity!,committeeId:"00064858"}}),
  ()=>({...resolved(),sourceHashes:[]}),
  ()=>({...absent(),identity:resolved().identity}),
 ])("rejects malformed or contradictory registry callback %#",async make=>{
  expect(await buildFloridaVerifiedCommitteeDonors({proof:proof(),lookupDonor:async()=>make()})).toMatchObject({status:"preserve"});
 });
 it("clones proof and each callback result around asynchronous acquisition",async()=>{
  const p=proof([row(),row()]),result=resolved();let calls=0;
  const r=await buildFloridaVerifiedCommitteeDonors({proof:p,lookupDonor:async()=>{
   calls++;if(calls===1){p.rows[1].amount="999999";p.context.sourceAccount="123";}
   if(calls===2){result.identity!.committeeName="Changed after earlier callback";}
   return calls===1?result:resolved();
  }});
  expect(r.status).toBe("accepted");
  if(r.status!=="accepted")throw Error(r.reason);
  expect(r.netCommitteeAmount).toBe(2000);
  expect(r.provenance.context.sourceAccount).toBe("88773");
  expect(r.provenance.registryLookups[0].result.identity?.committeeName).toBe("Example PAC");
 });
 it("preserves when refunds exceed current positive gifts",async()=>{
  expect(await buildFloridaVerifiedCommitteeDonors({proof:proof([row(),row({amount:"-2000",transactionType:"REF"})]),
   lookupDonor:async()=>resolved()})).toMatchObject({status:"preserve",reason:"negative_committee_net"});
 });
});
