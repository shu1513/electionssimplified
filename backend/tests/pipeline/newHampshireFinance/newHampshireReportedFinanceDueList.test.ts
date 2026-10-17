import { describe, expect, it } from "vitest";
import { selectDueNewHampshireReportedFinance as select, type NewHampshireReportedEligibleRow } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceDueList.js";
import { guid } from "./newHampshireReportedTestFixtures.js";

const now=new Date("2026-10-16T00:00:00.000Z"),fresh="2026-10-15T00:00:00.000Z";
function row(n=1):NewHampshireReportedEligibleRow{return{linkId:guid(n),candidateId:guid(100+n),electionId:guid(200+n),
  electionYear:2026,electionDate:"2026-11-03",candidateName:"Synthetic Candidate",candidateAliases:["Synthetic Candidate"],officeScope:"statewide",officeName:"Governor",district:null,
  filingEntityId:1000+n,filerName:"Synthetic filer",linkSource:"cfs_registration",attemptedAt:null,componentMask:null,
  ieClock:null,ieManifest:null,ieReceiver:null,committeeClock:null,committeeManifest:null,committeeReceiver:null,ieContextValid:true,committeeContextValid:true};}
function run(rows:NewHampshireReportedEligibleRow[],options:Partial<Parameters<typeof select>[0]>={}){
  return select({rows,now,staleAfterDays:7,maxCandidates:25,refresh:false,gates:{ie:true,committee:true},hints:new Map(),...options});
}
describe("New Hampshire independent component scheduling",()=>{
  it("selects missing components independently of any legacy direct summary freshness",()=>{
    expect(run([row()])).toHaveLength(1);
    const r={...row(),ieClock:fresh,ieReceiver:"1001",committeeClock:fresh,committeeReceiver:"1001"};
    expect(run([r])).toHaveLength(0);
    expect(run([{...r,committeeClock:null}])).toHaveLength(1);
  });
  it("rotates held attempts behind unattempted links",()=>{
    const first={...row(1),attemptedAt:fresh,componentMask:6};
    expect(run([first,row(2)],{maxCandidates:1})[0]!.linkId).toBe(guid(2));
  });
  it("suppresses a recent held attempt until source, gates or the refresh request changes",()=>{
    const r={...row(),attemptedAt:"2026-10-15T23:00:00.000Z",componentMask:6};
    expect(run([r])).toHaveLength(0);
    expect(run([r],{refresh:true})).toHaveLength(1);
    expect(run([r],{gates:{ie:true,committee:false}})).toHaveLength(1);
    expect(run([r],{hints:new Map([[r.linkId,{ie:{manifestSha256:"new",retrievedAt:"2026-10-15T23:30:00.000Z"},committee:null}]])})).toHaveLength(1);
  });
  it("detects retargeted source context and newer captures",()=>{
    const r={...row(),ieClock:fresh,ieReceiver:"1001",committeeClock:fresh,committeeReceiver:"1001"};
    expect(run([{...r,ieContextValid:false}])).toHaveLength(1);
    expect(run([r],{hints:new Map([[r.linkId,{ie:{manifestSha256:"new",retrievedAt:"2026-10-15T12:00:00.000Z"},committee:null}]])})).toHaveLength(1);
  });
  it("never lets disabled sources trigger an attempt",()=>{
    const r={...row(),attemptedAt:"2026-10-15T23:00:00.000Z",componentMask:2};
    expect(run([r],{gates:{ie:true,committee:false},hints:new Map([[r.linkId,{ie:null,committee:{manifestSha256:"unused",retrievedAt:"2026-10-15T23:30:00.000Z"}}]])})).toHaveLength(0);
    expect(run([row()],{refresh:true,gates:{ie:false,committee:false}})).toHaveLength(0);
  });
});
