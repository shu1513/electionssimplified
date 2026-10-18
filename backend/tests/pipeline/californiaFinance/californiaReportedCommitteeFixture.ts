import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {deflateRawSync} from "node:zlib";
import type {CaliforniaCommitteeReceiver} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeReceiver.js";
export const caReceiver:CaliforniaCommitteeReceiver={link_id:"11111111-1111-4111-8111-111111111111",candidate_id:"22222222-2222-4222-8222-222222222222",election_id:"33333333-3333-4333-8333-333333333333",election_year:2026,committee_id:"100",link_source:"cal_access",link_candidate_name:"SYNTHETIC CANDIDATE",link_committee_name:"Synthetic Candidate Assembly 2026",link_office_name:"State Lower Chamber Legislator",candidate_name:"Synthetic Candidate",full_name:"Synthetic Candidate",office_scope:"state_lower",office_name:"State Lower Chamber Legislator",district:"12",election_date:"2026-11-03"};
export type NativeRow=Record<string,string>;
export const caCover=(changes:NativeRow={}):NativeRow=>({FILING_ID:"10",AMEND_ID:"1",REC_TYPE:"CVR",FORM_TYPE:"F460",FILER_ID:"100",FILER_NAML:"Synthetic Candidate Assembly 2026",CONTROL_YN:"Y",CMTTE_TYPE:"C",FROM_DATE:"01/01/2026",THRU_DATE:"06/30/2026",ELECT_DATE:"11/03/2026",CAND_NAML:"Candidate",CAND_NAMF:"Synthetic",CAND_NAMT:"",CAND_NAMS:"",OFFICE_CD:"ASM",OFFIC_DSCR:"",JURIS_CD:"STA",DIST_NO:"12",...changes});
export const caReceipt=(changes:NativeRow={}):NativeRow=>({FILING_ID:"10",AMEND_ID:"1",LINE_ITEM:"1",REC_TYPE:"RCPT",FORM_TYPE:"A",TRAN_ID:"gift",ENTITY_CD:"COM",CTRIB_NAML:"Synthetic Committee",CTRIB_NAMF:"",CTRIB_NAMT:"",CTRIB_NAMS:"",CTRIB_CITY:"Sacramento",CTRIB_ST:"CA",CTRIB_ZIP4:"",CMTE_ID:"200",AMOUNT:"100.00",RCPT_DATE:"06/01/2026",MEMO_CODE:"",BAKREF_TID:"",TRAN_TYPE:"",...changes});
export const caSummary=(changes:NativeRow={}):NativeRow=>({FILING_ID:"10",AMEND_ID:"1",REC_TYPE:"SMRY",FORM_TYPE:"A",LINE_ITEM:"1",AMOUNT_A:"100.00",...changes});
export const caFilerName=(changes:NativeRow={}):NativeRow=>({FILER_ID:"100",FILER_TYPE:"RECIPIENT COMMITTEE",STATUS:"ACTIVE",NAML:"Synthetic Candidate Assembly 2026",NAMF:"",NAMT:"",NAMS:"",...changes});
export async function californiaSourceFixture(input:{covers?:NativeRow[];receipts?:NativeRow[];summaries?:NativeRow[];filerNames?:NativeRow[];capturedAt?:string}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ca-reported-")),local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  const tables=[["CVR_CAMPAIGN_DISCLOSURE_CD.TSV",input.covers??[caCover()],caCover()],["RCPT_CD.TSV",input.receipts??[caReceipt()],caReceipt()],["SMRY_CD.TSV",input.summaries??[caSummary()],caSummary()],["FILERNAME_CD.TSV",input.filerNames??[],caFilerName()]] as const;
  for(const [name,rows,defaults]of tables){
    const headers=[...new Set([...Object.keys(defaults),...rows.flatMap(r=>Object.keys(r))])],body=Buffer.from(headers.join("\t")+"\n"+rows.map(r=>headers.map(k=>r[k]??"").join("\t")).join("\n")+(rows.length?"\n":"")),compressed=deflateRawSync(body),file=Buffer.from("CalAccess/DATA/"+name),a=Buffer.alloc(30),b=Buffer.alloc(46);
    a.writeUInt32LE(0x04034b50);a.writeUInt16LE(20,4);a.writeUInt16LE(8,8);a.writeUInt32LE(compressed.length,18);a.writeUInt32LE(body.length,22);a.writeUInt16LE(file.length,26);
    b.writeUInt32LE(0x02014b50);b.writeUInt16LE(20,4);b.writeUInt16LE(20,6);b.writeUInt16LE(8,10);b.writeUInt32LE(compressed.length,20);b.writeUInt32LE(body.length,24);b.writeUInt16LE(file.length,28);b.writeUInt32LE(offset,42);local.push(a,file,compressed);central.push(b,file);offset+=a.length+file.length+compressed.length;
  }
  const c=Buffer.concat(central),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(tables.length,8);e.writeUInt16LE(tables.length,10);e.writeUInt32LE(c.length,12);e.writeUInt32LE(offset,16);const zip=Buffer.concat([...local,c,e]),zipPath=path.join(dir,"dbwebexport.zip");await fs.writeFile(zipPath,zip);
  const metadata={version:1,zipPath,metadataPath:path.join(dir,"dbwebexport.metadata.json"),downloadedAt:input.capturedAt??"2026-10-17T00:00:00.000Z",bytesWritten:zip.length,remote:{url:"https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",contentLength:zip.length}};await fs.writeFile(metadata.metadataPath,JSON.stringify(metadata));return {dir,metadata};
}
