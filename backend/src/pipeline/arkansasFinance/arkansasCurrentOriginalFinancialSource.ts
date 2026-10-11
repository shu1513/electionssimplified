import type {
  ArkansasVerifiedCollection,
  ArkansasVerifiedCurrentReportRow,
  ArkansasVerifiedTransactionRow,
  ArkansasVerifiedTransactionDetail,
  ArkansasVerifiedRawResponseMetadata,
} from "./arkansasVerifiedSourceClient.js";
import type { ArkansasParsedFinancialReport } from "./arkansasFinancialReportPdfParser.js";

export type ArkansasFinancialSourceIdentity = {
  entityId: string;
  registrationGuid: string;
  sourceName: string;
  electionYear: number;
  officeName: string | null;
  district: string | null;
};
export type ArkansasVerifiedOriginalReportProof = {
  reportGuid: string;
  reportVersion: 1;
  reportName: string;
  periodStart: string;
  periodEnd: string;
  filedAtRaw: string;
  filePath: string;
  pdfSha256: string;
  reportFingerprint: string;
  returnedCashCents: 0;
  returnProof: "explicit_section19_zero" | "checked_no_activity_zero";
};
export type ArkansasVerifiedCashOccurrence = {
  guid: string;
  reportGuid: string;
  reportedName: string;
  reportedAddress: string;
  transactionDate: string;
  amountCents: number;
  transactionSource: string;
  transactionSubTypeDescription: string;
  nativeFingerprint: string;
  /** Detail-only IDs are never invented for native rows without details. */
  transactionId?: number;
  transactionVersionId?: number;
  transactionTypeCode?: string;
  transactionSubTypeCode?: string;
  transactionSourceTypeCode?: string;
  electionTypeCode?: string | null;
  sourceElectionYear?: number | null;
  detailFingerprint?: string;
};
export type ArkansasVerifiedCurrentCashProof = {
  version: 1;
  receiver: ArkansasFinancialSourceIdentity;
  windowStart: string;
  windowEnd: string;
  monetaryCashCents: number;
  reports: readonly ArkansasVerifiedOriginalReportProof[];
  cashRows: readonly ArkansasVerifiedCashOccurrence[];
  sourceFingerprints: { reportsBefore: string; reportsAfter: string; nativeBefore: string; nativeAfter: string };
  rawResponseHashes: readonly string[];
};
export type ArkansasVerifiedIeOccurrence = ArkansasVerifiedCashOccurrence & {
  purpose: string;
  nativeCategory: string | null;
  detailOtherCategory: string | null;
  transactionId: number;
  transactionVersionId: number;
  transactionTypeCode: "TEXP";
  transactionSubTypeCode: "ITMY";
  sourceElectionYear: number | null;
  electionTypeCode: string | null;
};
export type ArkansasVerifiedCurrentIeProof = {
  version: 1;
  payer: ArkansasFinancialSourceIdentity;
  windowStart: string;
  windowEnd: string;
  expenditureCents: number;
  reports: readonly Omit<ArkansasVerifiedOriginalReportProof, "returnedCashCents" | "returnProof">[];
  expenseRows: readonly ArkansasVerifiedIeOccurrence[];
  sourceFingerprints: ArkansasVerifiedCurrentCashProof["sourceFingerprints"];
  rawResponseHashes: readonly string[];
  coverElectionConflicts: readonly { reportGuid: string; electionTypeRaw: string | null; electionDateRaw: string | null }[];
};
export type ArkansasVerifiedDetailSource = {
  row: ArkansasVerifiedTransactionDetail;
  fingerprint: string;
  request: ArkansasVerifiedRawResponseMetadata;
};
export type ArkansasFinancialPdfSource = {
  reportGuid: string;
  parsed: ArkansasParsedFinancialReport;
  request: ArkansasVerifiedRawResponseMetadata;
};
export type ArkansasCurrentOriginalFinancialInput = {
  identity: ArkansasFinancialSourceIdentity;
  windowStart: string;
  windowEnd: string;
  reportsBefore: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>;
  reportsAfter: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>;
  nativeBefore: ArkansasVerifiedCollection<ArkansasVerifiedTransactionRow>;
  nativeAfter: ArkansasVerifiedCollection<ArkansasVerifiedTransactionRow>;
  details: readonly ArkansasVerifiedDetailSource[];
  pdfs: readonly ArkansasFinancialPdfSource[];
};

import { fingerprintArkansasVerifiedRawRows } from "./arkansasVerifiedSourceClient.js";
import { arkansasFinancialDate, type ArkansasPdfOccurrence } from "./arkansasFinancialReportPdfParser.js";
const API = "https://api-ethics-disclosures.sos.arkansas.gov/api/";
const HASH = /^[a-f0-9]{64}$/;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const normalized = (s: string): string => s.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
const exactText = (s: string): string => s.replace(/\s+/g," ").trim();
/** Stable row identity ignores only the paging count, never source content.
 * Complete collection brackets above continue to hash every raw field. */
export function fingerprintArkansasFinancialRawRow(row: {rawFields:Readonly<Record<string,unknown>>}):string {
  const rawFields=Object.fromEntries(Object.entries(row.rawFields).filter(([key])=>key!=="totalRows"));
  return fingerprintArkansasVerifiedRawRows([{rawFields}]);
}
function reject(message: string): never { throw new Error(`Arkansas original source: ${message}`); }
function cents(n: number): number {
  if(typeof n!=="number"||!Number.isFinite(n)||n<0)reject("invalid/negative amount");
  const token=String(n);if(!/^\d+(?:\.\d{1,2})?$/.test(token))reject("non-cent amount");
  const [whole,fraction=""] = token.split(".");const value=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  if(!Number.isSafeInteger(value)||value/100!==n)reject("unsafe amount");return value;
}
function add(a:number,b:number):number { if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<0||!Number.isSafeInteger(a+b))reject("unsafe cent sum");return a+b; }
function request(r:ArkansasVerifiedRawResponseMetadata, endpoint:string):void {
  if(r.url!==API+endpoint||r.method!=="POST"||r.status!==200||!HASH.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<1)reject("invalid request-bound source metadata");
  const start=Date.parse(r.startedAt),end=Date.parse(r.endedAt);if(!Number.isFinite(start)||!Number.isFinite(end)||start>end)reject("invalid request interval");
}
function collection<T extends {rawFields:Readonly<Record<string,unknown>>}>(c:ArkansasVerifiedCollection<T>,endpoint:string):void {
  if(c.complete!==true||c.totalItems!==c.rows.length||!Number.isSafeInteger(c.totalItems)||c.totalItems<0||!c.requests.length||fingerprintArkansasVerifiedRawRows(c.rows)!==c.fingerprint)reject("incomplete or changed source collection");
  for(const r of c.requests)request(r,endpoint);
}
function nameOwner(s:string,identity:ArkansasFinancialSourceIdentity):boolean {
  if(normalized(s)===normalized(identity.sourceName))return true;
  // The candidate source explicitly publishes native Last, First versus cover First Last.
  if(identity.officeName!==null){
    const display=(value:string):string|undefined=>{
      if(!value.includes(","))return normalized(value);
      const parts=value.split(",");if(parts.length!==2||!parts[0]!.trim()||!parts[1]!.trim())return undefined;
      return normalized(`${parts[1]} ${parts[0]}`);
    };
    const left=display(s),right=display(identity.sourceName);return left!==undefined&&right!==undefined&&left===right;
  }
  return false;
}
function binding(input:ArkansasCurrentOriginalFinancialInput,kind:"candidate"|"independent") {
  const id=input.identity;
  if(!/^[1-9]\d*$/.test(id.entityId)||!Number.isSafeInteger(Number(id.entityId))||!GUID.test(id.registrationGuid)||!id.sourceName.trim()||!Number.isInteger(id.electionYear)||id.electionYear<1900||id.electionYear>2100)reject("invalid receiving identity");
  const start=arkansasFinancialDate(input.windowStart),end=arkansasFinancialDate(input.windowEnd);
  if(start!==input.windowStart||end!==input.windowEnd||start>end)reject("invalid civil source window");
  collection(input.reportsBefore,"PublicFilerDetails/GetPublicFilerProfileFiling");collection(input.reportsAfter,"PublicFilerDetails/GetPublicFilerProfileFiling");
  collection(input.nativeBefore,"PublicTransactionDetails/GetTransactionDetails");collection(input.nativeAfter,"PublicTransactionDetails/GetTransactionDetails");
  if(input.reportsBefore.fingerprint!==input.reportsAfter.fingerprint||input.nativeBefore.fingerprint!==input.nativeAfter.fingerprint)reject("source changed inside bracket");
  for(const c of [input.reportsBefore,input.reportsAfter,input.nativeBefore,input.nativeAfter])for(const r of c.requests)if(r.requestBody.filerRegistrationGuid!==id.registrationGuid)reject("source request receiver differs");
  for(const c of [input.nativeBefore,input.nativeAfter])for(const r of c.requests)if(r.requestBody.transactionTypeCode!==(kind==="candidate"?"TCON":"TEXP"))reject("wrong native source stream");
  const opening=Math.max(...[...input.reportsBefore.requests,...input.nativeBefore.requests].map(r=>Date.parse(r.endedAt)));
  const closing=Math.min(...[...input.reportsAfter.requests,...input.nativeAfter.requests].map(r=>Date.parse(r.startedAt)));
  if(opening>closing)reject("source bracket is reversed");
  const reports=new Map<string,ArkansasVerifiedCurrentReportRow>();
  for(const r of input.reportsBefore.rows){
    if(!GUID.test(r.filerReportGuid)||reports.has(r.filerReportGuid)||r.registrationGuid!==id.registrationGuid)reject("duplicate/wrong-receiver report identity");
    if(r.startDate===null||r.endDate===null)reject("unknown report period");
    const from=arkansasFinancialDate(r.startDate),to=arkansasFinancialDate(r.endDate);if(from>to)reject("reversed current report period");
    if(to<start||from>end)continue;
    if(from<start||to>end)reject("current report crosses source window");
    if(r.filerReportVersionId!==1||r.reportStatus!=="Original"||r.reportVersion!=="Original"||r.hasChild!==false||r.isPaperFile!==false||!r.filePath||r.filedDate===null||!r.reportName.trim())reject(`unsupported current report ${r.filerReportGuid}`);
    const raw=r.rawFields;
    for(const [key,value] of Object.entries({filerReportGuid:r.filerReportGuid,filerReportVersionID:r.filerReportVersionId,reportName:r.reportName,reportStatus:r.reportStatus,reportVersion:r.reportVersion,startDate:r.startDate,endDate:r.endDate,filedDate:r.filedDate,filePath:r.filePath,hasChild:r.hasChild,isPaperFile:r.isPaperFile}))if(raw[key]!==value)reject("report DTO/raw identity differs");
    reports.set(r.filerReportGuid,r);
  }
  if(!reports.size)reject("no current authoritative report");
  const periods=[...reports.values()].sort((a,b)=>a.startDate!.localeCompare(b.startDate!));
  for(let i=1;i<periods.length;i++)if(arkansasFinancialDate(periods[i]!.startDate!)<=arkansasFinancialDate(periods[i-1]!.endDate!))reject("overlapping current reports");
  const parsed=new Map<string,ArkansasParsedFinancialReport>();
  for(const pdf of input.pdfs){
    if(parsed.has(pdf.reportGuid))reject("duplicate report PDF");
    const r=reports.get(pdf.reportGuid);if(!r)reject("PDF outside current report inventory");
    request(pdf.request,"PublicFiledReportAndDownload/DownloadDocument");
    if(pdf.request.requestBody.filerReportGuid!==r.filerReportGuid||pdf.request.requestBody.fileName!==`${r.reportName} V1`||pdf.request.requestBody.openInNewTab!==true||pdf.request.sha256!==pdf.parsed.sha256||pdf.request.bytes!==pdf.parsed.byteCount)reject("PDF/request identity differs");
    if(Date.parse(pdf.request.startedAt)<opening||Date.parse(pdf.request.endedAt)>closing)reject("PDF outside source bracket");
    const p=pdf.parsed;
    if(p.kind!==kind||!nameOwner(p.ownerName,id)||p.filerId!==null&&p.filerId!==id.entityId||p.periodStart!==arkansasFinancialDate(r.startDate!)||p.periodEnd!==arkansasFinancialDate(r.endDate!)||p.filedAt!==r.filedDate!.slice(0,19)||p.amendment==="checked_vector")reject(`PDF/current identity mismatch ${r.filerReportGuid}`);
    const expected=kind==="candidate"?`${r.reportName} - ${p.electionTypeRaw}`:r.reportName;
    if(exactText(p.reportLabel)!==exactText(expected))reject(`PDF report label mismatch ${r.filerReportGuid}`);
    if(kind==="candidate"&&(normalized(p.officeName??"")!==normalized(id.officeName??"")||normalized(p.district??"")!==normalized(id.district??"")||p.electionYear===null||p.electionYear<Number(start.slice(0,4))||p.electionYear>id.electionYear))reject("PDF candidate office/year differs");
    parsed.set(pdf.reportGuid,p);
  }
  if(parsed.size!==reports.size)reject("missing current report PDF");
  if(kind==="candidate"){
    const latest=[...reports.values()].sort((a,b)=>b.endDate!.localeCompare(a.endDate!))[0]!;
    if(parsed.get(latest.filerReportGuid)!.electionYear!==id.electionYear)reject("latest cover does not establish current candidate year");
  }
  const native=new Map<string,ArkansasVerifiedTransactionRow>();
  for(const r of input.nativeBefore.rows){
    if(!GUID.test(r.guid)||native.has(r.guid)||r.filerRegistrationGuid!==id.registrationGuid||r.hasChild!==false||!nameOwner(r.filerName,id))reject("duplicate/corrected/wrong native identity");
    for(const[key,value]of Object.entries({guid:r.guid,filerRegistrationGuid:r.filerRegistrationGuid,transactionAmount:r.transactionAmount,transactionDate:r.transactionDate,sourceName:r.sourceName,sourceAddress:r.sourceAddress,transactionSource:r.transactionSource,transactionCategory:r.transactionCategory,reportName:r.reportName,transactionSubTypeDesc:r.transactionSubTypeDescription,hasChild:r.hasChild}))if(r.rawFields[key]!==value)reject("native DTO/raw identity differs");
    const date=arkansasFinancialDate(r.transactionDate);if(date<start||date>end)continue;
    cents(r.transactionAmount);native.set(r.guid,r);
  }
  const details=new Map<string,ArkansasVerifiedDetailSource>(),detailIds=new Set<number>();
  for(const d of input.details){
    request(d.request,"PublicTransactionDetails/GetTransactionDetailsByGuid");
    if(details.has(d.row.guid)||!native.has(d.row.guid)||d.request.requestBody.transactionGuid!==d.row.guid||d.fingerprint!==fingerprintArkansasVerifiedRawRows([d.row])||Date.parse(d.request.startedAt)<opening||Date.parse(d.request.endedAt)>closing)reject("duplicate/changed/out-of-bracket detail");
    if(!Number.isSafeInteger(d.row.transactionId)||d.row.transactionId<1||detailIds.has(d.row.transactionId)||d.row.transactionVersionId!==1)reject("duplicate/corrected/invalid transaction detail version");
    detailIds.add(d.row.transactionId);
    for(const[key,value]of Object.entries({guid:d.row.guid,transactionID:d.row.transactionId,transactionVersionID:d.row.transactionVersionId,transactionTypeCode:d.row.transactionTypeCode,transactionSubTypeCode:d.row.transactionSubTypeCode,transactionSourceTypeCode:d.row.transactionSourceTypeCode,electionTypeCode:d.row.electionTypeCode,transactionDate:d.row.transactionDate,contributor:d.row.contributor,filerName:d.row.filerName,comments:d.row.comments,valueOfNonMoneyItem:d.row.valueOfNonMoneyItem}))if(d.row.rawFields[key]!==value)reject("detail DTO/raw identity differs");
    const rawYear=d.row.rawFields.electionYear;if((rawYear===null||rawYear===""?null:Number(rawYear))!==d.row.electionYear)reject("detail raw year differs");
    details.set(d.row.guid,d);
  }
  return{reports,parsed,native,details,start,end,sourceFingerprints:{reportsBefore:input.reportsBefore.fingerprint,reportsAfter:input.reportsAfter.fingerprint,nativeBefore:input.nativeBefore.fingerprint,nativeAfter:input.nativeAfter.fingerprint},rawResponseHashes:[...input.reportsBefore.requests,...input.reportsAfter.requests,...input.nativeBefore.requests,...input.nativeAfter.requests,...input.pdfs.map(p=>p.request),...input.details.map(d=>d.request)].map(r=>r.sha256)};
}
function reportProof(r:ArkansasVerifiedCurrentReportRow,p:ArkansasParsedFinancialReport):Omit<ArkansasVerifiedOriginalReportProof,"returnProof"|"returnedCashCents"> {return{reportGuid:r.filerReportGuid,reportVersion:1,reportName:r.reportName,periodStart:p.periodStart,periodEnd:p.periodEnd,filedAtRaw:r.filedDate!,filePath:r.filePath!,pdfSha256:p.sha256,reportFingerprint:fingerprintArkansasFinancialRawRow(r)};}
function assigned(row:ArkansasVerifiedTransactionRow,reports:Map<string,ArkansasVerifiedCurrentReportRow>):ArkansasVerifiedCurrentReportRow {
  const date=arkansasFinancialDate(row.transactionDate);
  const found=[...reports.values()].filter(r=>r.reportName===row.reportName&&date>=arkansasFinancialDate(r.startDate!)&&date<=arkansasFinancialDate(r.endDate!));
  if(found.length!==1)reject(`unresolved current report assignment ${row.guid}`);return found[0]!;
}
function rowKey(date:string,amount:number,nameAddress:string):string { return JSON.stringify([date,amount,normalized(nameAddress)]); }
function matchRows(native:ArkansasVerifiedTransactionRow[],pdfRows:readonly ArkansasPdfOccurrence[],label:string,accept:(row:ArkansasVerifiedTransactionRow,pdf:ArkansasPdfOccurrence)=>boolean=()=>true):Map<string,ArkansasPdfOccurrence> {
  const pdf=new Map<string,ArkansasPdfOccurrence[]>();
  for(const row of pdfRows){const key=rowKey(row.date,row.amountCents,row.nameAddress);const q=pdf.get(key)??[];q.push(row);pdf.set(key,q);}
  const matched=new Map<string,ArkansasPdfOccurrence>();
  for(const row of native){
    if(!row.sourceName?.trim()||!row.sourceAddress?.trim())reject(`missing named ${label} identity ${row.guid}`);
    const key=rowKey(arkansasFinancialDate(row.transactionDate),cents(row.transactionAmount),`${row.sourceName} ${row.sourceAddress}`);
    const candidates=pdf.get(key)??[],index=candidates.findIndex(p=>accept(row,p));
    const occurrence=index<0?undefined:candidates.splice(index,1)[0];if(!occurrence)reject(`native/PDF identity mismatch ${row.guid} ${row.sourceName}`);matched.set(row.guid,occurrence);
  }
  if([...pdf.values()].some(q=>q.length))reject(`unmatched PDF ${label} occurrence`);return matched;
}
function occurrence(row:ArkansasVerifiedTransactionRow,reportGuid:string,d?:ArkansasVerifiedDetailSource):ArkansasVerifiedCashOccurrence {
  const base:ArkansasVerifiedCashOccurrence={guid:row.guid,reportGuid,reportedName:row.sourceName!,reportedAddress:row.sourceAddress!,transactionDate:arkansasFinancialDate(row.transactionDate),amountCents:cents(row.transactionAmount),transactionSource:row.transactionSource!,transactionSubTypeDescription:row.transactionSubTypeDescription!,nativeFingerprint:fingerprintArkansasFinancialRawRow(row)};
  if(d)Object.assign(base,{transactionId:d.row.transactionId,transactionVersionId:d.row.transactionVersionId,transactionTypeCode:d.row.transactionTypeCode,transactionSubTypeCode:d.row.transactionSubTypeCode,transactionSourceTypeCode:d.row.transactionSourceTypeCode,electionTypeCode:d.row.electionTypeCode,sourceElectionYear:d.row.electionYear,detailFingerprint:d.fingerprint});
  return base;
}
function checkDetail(row:ArkansasVerifiedTransactionRow,d:ArkansasVerifiedDetailSource|undefined,type:"TCON"|"TEXP",identity:ArkansasFinancialSourceIdentity):void {
  if(!d)reject(`missing typed detail ${row.guid}`);
  const x=d.row;
  if(x.guid!==row.guid||x.transactionTypeCode!==type||x.transactionSubTypeCode!=="ITMY"||x.valueOfNonMoneyItem===null||cents(x.valueOfNonMoneyItem)!==cents(row.transactionAmount)||arkansasFinancialDate(x.transactionDate)!==arkansasFinancialDate(row.transactionDate)||!x.contributor||normalized(x.contributor)!==normalized(row.sourceName??"")||!x.filerName||!nameOwner(x.filerName,identity))reject(`typed detail identity mismatch ${row.guid}`);
}
export function verifyArkansasCurrentOriginalCashSource(input:ArkansasCurrentOriginalFinancialInput):{proof?:ArkansasVerifiedCurrentCashProof;diagnostics:readonly string[]} {
  try{
    const b=binding(input,"candidate"),cashRows:ArkansasVerifiedCashOccurrence[]=[],reports:ArkansasVerifiedOriginalReportProof[]=[];let total=0;
    const byReport=new Map<string,ArkansasVerifiedTransactionRow[]>();
    for(const r of b.native.values()){
      if(r.transactionSubTypeDescription!=="Itemized Monetary"&&r.transactionSubTypeDescription!=="Itemized Nonmoney")reject(`unsupported receipt subtype ${r.guid}`);
      if(!["Individual","Candidate","Political Action Committee","Business/Organization/Unlisted PAC"].includes(r.transactionSource??""))reject(`unsupported source cash category ${r.guid}`);
      const report=assigned(r,b.reports);const q=byReport.get(report.filerReportGuid)??[];q.push(r);byReport.set(report.filerReportGuid,q);
    }
    for(const r of b.reports.values()){
      const p=b.parsed.get(r.filerReportGuid)!,rows=byReport.get(r.filerReportGuid)??[],cash=rows.filter(r=>r.transactionSubTypeDescription==="Itemized Monetary"),nonmoney=rows.filter(r=>r.transactionSubTypeDescription==="Itemized Nonmoney");
      matchRows(cash,p.cashRows,"cash");matchRows(nonmoney,p.nonmoneyRows,"nonmoney");
      const reportCash=cash.reduce((sum,r)=>add(sum,cents(r.transactionAmount)),0);if(reportCash!==p.currentCashCents)reject(`whole cover Line7 mismatch ${r.filerReportGuid}`);
      let returnProof:ArkansasVerifiedOriginalReportProof["returnProof"];
      if(p.returnedCashCents===0)returnProof="explicit_section19_zero";
      else if(p.returnedCashCents===null&&p.noActivity==="checked_vector"&&p.currentCashCents===0&&p.currentLoanCents===0&&p.currentExpenseCents===0&&rows.length===0)returnProof="checked_no_activity_zero";
      else reject(`unknown/nonzero returned contribution ${r.filerReportGuid}`);
      if(p.sectionTotals["17"]!==undefined&&p.sectionTotals["17"]!==0)reject("unresolved nonitemized cash");
      if(p.sectionTotals["14"]!==undefined&&nonmoney.reduce((sum,r)=>add(sum,cents(r.transactionAmount)),0)!==p.sectionTotals["14"])reject("nonmoney total differs");
      for(const row of cash){
        const d=b.details.get(row.guid);
        if(row.transactionSource==="Political Action Committee"){
          checkDetail(row,d,"TCON",input.identity);if(d!.row.transactionSourceTypeCode!=="TPAC")reject(`native/detail PAC category differs ${row.guid}`);
        } else if(d){checkDetail(row,d,"TCON",input.identity);if(d.row.transactionSourceTypeCode==="TPAC")reject(`native/detail category differs ${row.guid}`);}
        cashRows.push(occurrence(row,r.filerReportGuid,d));
      }
      total=add(total,p.currentCashCents);reports.push({...reportProof(r,p),returnedCashCents:0,returnProof});
    }
    return{proof:{version:1,receiver:input.identity,windowStart:b.start,windowEnd:b.end,monetaryCashCents:total,reports,cashRows,sourceFingerprints:b.sourceFingerprints,rawResponseHashes:b.rawResponseHashes},diagnostics:[]};
  }catch(error){return{diagnostics:[error instanceof Error?error.message:String(error)]};}
}
export function verifyArkansasCurrentOriginalIeSource(input:ArkansasCurrentOriginalFinancialInput):{proof?:ArkansasVerifiedCurrentIeProof;diagnostics:readonly string[]} {
  try{
    const b=binding(input,"independent"),expenseRows:ArkansasVerifiedIeOccurrence[]=[],reports:ArkansasVerifiedCurrentIeProof["reports"][number][]=[],conflicts:ArkansasVerifiedCurrentIeProof["coverElectionConflicts"][number][]=[];let total=0;
    const byReport=new Map<string,ArkansasVerifiedTransactionRow[]>();
    for(const row of b.native.values()){if(row.transactionSubTypeDescription!=="Itemized Monetary")reject("unsupported expenditure subtype");const r=assigned(row,b.reports);const q=byReport.get(r.filerReportGuid)??[];q.push(row);byReport.set(r.filerReportGuid,q);}
    for(const r of b.reports.values()){
      const p=b.parsed.get(r.filerReportGuid)!,rows=byReport.get(r.filerReportGuid)??[];
      for(const row of rows)checkDetail(row,b.details.get(row.guid),"TEXP",input.identity);
      // Match explicit purposes before using the blank bank-fee fallback.
      const pdfExpenses=[...p.expenseRows].sort((a,b)=>Number(!a.description)-Number(!b.description));
      const matched=matchRows(rows,pdfExpenses,"expense",(row,pdf)=>{
        const d=b.details.get(row.guid)!,comments=normalized(d.row.comments??"");
        if(pdf.description)return normalized(pdf.description)===comments;
        const explicitFee=normalized(String(d.row.rawFields.otherCategory??""))==="BANK FEE"&&normalized(row.transactionCategory??"")==="OTHER LIST BANK FEE";
        return explicitFee&&(comments===""||comments==="BANK FEE");
      });
      const sum=rows.reduce((s,row)=>add(s,cents(row.transactionAmount)),0);if(sum!==p.currentExpenseCents)reject(`whole IE cover mismatch ${r.filerReportGuid}`);
      if(p.sectionTotals["21"]!==undefined&&p.sectionTotals["21"]!==0||p.sectionTotals["20"]!==undefined&&p.sectionTotals["20"]!==sum||p.sectionTotals["22"]!==undefined&&p.sectionTotals["22"]!==sum)reject("IE schedule totals differ");
      if(p.noActivity==="checked_vector"&&(rows.length||p.currentCashCents||p.currentLoanCents||p.currentExpenseCents))reject("IE noactivity conflicts with source activity");
      for(const row of rows){
        const d=b.details.get(row.guid);
        const purpose=matched.get(row.guid)!.description;
        if(/\b(?:SUPPORT|OPPOSE|OPPOSITION)\b/.test(normalized(purpose))){if(d!.row.electionYear!==input.identity.electionYear||d!.row.electionTypeCode!=="PRMELEC")reject(`unsupported allocated IE year/type ${row.guid}`);}
        expenseRows.push({...occurrence(row,r.filerReportGuid,d),purpose,nativeCategory:row.transactionCategory,detailOtherCategory:typeof d!.row.rawFields.otherCategory==="string"?d!.row.rawFields.otherCategory:null,transactionId:d!.row.transactionId,transactionVersionId:d!.row.transactionVersionId,transactionTypeCode:"TEXP",transactionSubTypeCode:"ITMY",sourceElectionYear:d!.row.electionYear,electionTypeCode:d!.row.electionTypeCode});
      }
      if(rows.some(row=>/\b(?:SUPPORT|OPPOSE|OPPOSITION)\b/.test(normalized(matched.get(row.guid)!.description))))conflicts.push({reportGuid:r.filerReportGuid,electionTypeRaw:p.electionTypeRaw,electionDateRaw:p.electionDateRaw});
      total=add(total,sum);reports.push(reportProof(r,p));
    }
    return{proof:{version:1,payer:input.identity,windowStart:b.start,windowEnd:b.end,expenditureCents:total,reports,expenseRows,sourceFingerprints:b.sourceFingerprints,rawResponseHashes:b.rawResponseHashes,coverElectionConflicts:conflicts},diagnostics:conflicts.map(c=>`Application row-year authority retains raw IE cover election fields for ${c.reportGuid}`)};
  }catch(error){return{diagnostics:[error instanceof Error?error.message:String(error)]};}
}
