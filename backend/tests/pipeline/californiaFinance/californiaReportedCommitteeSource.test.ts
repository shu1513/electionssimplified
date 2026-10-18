import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs/promises";
import {readCaliforniaCommitteePacket,californiaCommitteeComponent,californiaCommitteeFacts,assertCaliforniaCommitteePacket} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeSource.js";
import {qualifyCaliforniaCommitteeReceiver} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeReceiver.js";
import {caCover,caReceipt,caSummary,californiaSourceFixture,caReceiver} from "./californiaReportedCommitteeFixture.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs)await fs.rm(d,{recursive:true,force:true});dirs.length=0;});
async function fixture(input:Parameters<typeof californiaSourceFixture>[0]={}){const f=await californiaSourceFixture(input);dirs.push(f.dir);return readCaliforniaCommitteePacket(["100"],f.dir);}
describe("California current reported committee source",()=>{
  it("uses current amendments as replacements and binds a complete original ZIP",async()=>{
    const p=await fixture({covers:[caCover({AMEND_ID:"0"}),caCover()],receipts:[caReceipt({AMEND_ID:"0",AMOUNT:"900.00"}),caReceipt()],summaries:[caSummary({AMEND_ID:"0",AMOUNT_A:"900.00"}),caSummary()]});
    expect(californiaCommitteeComponent(p,"100",2026)).toMatchObject({totalCents:10000,selectedRows:1,groups:[{name:"Synthetic Committee",cents:10000,entityCode:"COM"}]});
    expect(p.sourceRetrievedAt).toBe("2026-10-17T00:00:00.000Z");expect(()=>assertCaliforniaCommitteePacket({...p})).toThrow(/unverified_source_packet/);
    const facts=californiaCommitteeFacts(p,"100",2026);qualifyCaliforniaCommitteeReceiver(caReceiver,facts.reports);facts.reports[0]!.CAND_NAML="Changed";qualifyCaliforniaCommitteeReceiver(caReceiver,californiaCommitteeFacts(p,"100",2026).reports);
  });
  it("closes all itemized money before selecting committees, excluding transfers/memos/other entities",async()=>{
    const receipts=[caReceipt(),caReceipt({LINE_ITEM:"2",TRAN_TYPE:"R",AMOUNT:"-20.00"}),caReceipt({LINE_ITEM:"3",TRAN_TYPE:"X",AMOUNT:"1000.00"}),caReceipt({LINE_ITEM:"4",ENTITY_CD:"OTH",AMOUNT:"50.00"}),caReceipt({LINE_ITEM:"5",MEMO_CODE:"X",AMOUNT:"100.00"}),caReceipt({LINE_ITEM:"6",FORM_TYPE:"C",AMOUNT:"25.00",ENTITY_CD:"PTY",CMTE_ID:"300",CTRIB_NAML:"Synthetic party"})];
    const p=await fixture({receipts,summaries:[caSummary({AMOUNT_A:"1130.00"}),caSummary({FORM_TYPE:"C",AMOUNT_A:"25.00"})]});
    expect(californiaCommitteeComponent(p,"100",2026)).toMatchObject({totalCents:10500,positiveCents:12500,negativeCents:-2000,selectedRows:3,receivingRows:6,groups:[{cents:8000,giftCount:1,correctionCount:1},{cents:2500,entityCode:"PTY"}]});
  });
  it("holds the component on itemized control mismatch, duplicate rows or negative balances",async()=>{
    const mismatch=await fixture({summaries:[caSummary({AMOUNT_A:"101.00"})]});expect(()=>californiaCommitteeComponent(mismatch,"100",2026)).toThrow(/does_not_close/);
    const duplicate=await fixture({receipts:[caReceipt(),caReceipt()],summaries:[caSummary({AMOUNT_A:"200.00"})]});expect(()=>californiaCommitteeComponent(duplicate,"100",2026)).toThrow(/duplicate/);
    const negative=await fixture({receipts:[caReceipt({TRAN_TYPE:"R",AMOUNT:"-10.00"})],summaries:[caSummary({AMOUNT_A:"-10.00"})]});expect(()=>californiaCommitteeComponent(negative,"100",2026)).toThrow(/negative_committee_balance/);
  });
  it("accounts for fully canceled groups and accepts omitted zero controls only after complete source scans",async()=>{
    const p=await fixture({receipts:[caReceipt(),caReceipt({LINE_ITEM:"2",TRAN_TYPE:"R",AMOUNT:"-100.00"})],summaries:[]});expect(californiaCommitteeComponent(p,"100",2026)).toMatchObject({totalCents:0,selectedRows:2,canceledGroupCount:1,canceledRowCount:2,groups:[]});
    const zero=await fixture({receipts:[],summaries:[]});expect(californiaCommitteeComponent(zero,"100",2026)).toMatchObject({totalCents:0,selectedRows:0,receivingRows:0,groups:[]});
  });
  it("rejects overlapping periods, wrong office/district/person and source dates before report completion",async()=>{
    const p=await fixture({covers:[caCover(),caCover({FILING_ID:"11",FROM_DATE:"06/01/2026",THRU_DATE:"09/30/2026"})]});expect(()=>californiaCommitteeComponent(p,"100",2026)).toThrow(/overlapping/);
    const good=await fixture(),facts=californiaCommitteeFacts(good,"100",2026);expect(()=>qualifyCaliforniaCommitteeReceiver({...caReceiver,district:"13"},facts.reports)).toThrow(/office_cycle/);expect(()=>qualifyCaliforniaCommitteeReceiver({...caReceiver,candidate_name:"Other Candidate",link_candidate_name:"OTHER CANDIDATE"},facts.reports)).toThrow(/receiver_mismatch/);
    const future=await fixture({capturedAt:"2026-01-01T00:00:00.000Z"});expect(()=>californiaCommitteeComponent(future,"100",2026)).toThrow(/future_report_period/);
  });
});
