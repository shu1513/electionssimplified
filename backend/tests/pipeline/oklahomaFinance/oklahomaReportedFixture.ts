import { mkdir,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { zipSync,strToU8 } from "fflate";
import { okHash,type OklahomaReportedKind } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedCore.js";
import { OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS } from "../../../src/pipeline/oklahomaFinance/oklahomaGuardianContributionReader.js";
import { readOklahomaReportedPacket,loadOklahomaReceiverPacket } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedSource.js";
import type { OklahomaReportedReceiver } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedReceiver.js";
export const receiver:OklahomaReportedReceiver={linkId:"11111111-1111-4111-8111-111111111111",candidateId:"22222222-2222-4222-8222-222222222222",electionId:"33333333-3333-4333-8333-333333333333",electionYear:2026,electionDate:"2026-11-03",candidateName:"Jane Example",fullName:"Jane Example",officeScope:"state_upper",canonicalOffice:"State Senator",canonicalDistrict:"1",entityId:"100",committeeName:"Friends of Example",linkSource:"guardian_bulk",linkOffice:"State Senator",linkDistrict:"1"};
export function syntheticOklahomaPdf(options:{continuation?:boolean;continuationTarget?:string;total?:string;target?:string;office?:string;amount?:string;filer?:string;payee?:string;wrappedFiler?:boolean;blankReceivingCommitteeName?:boolean;continuationBorders?:"none"|"amountRightMissing"}={}) {
  const total=options.total??(options.continuation?"200.02":"100.01"),text=(x:number,y:number,s:string)=>`BT /F1 6 Tf ${x} ${y} Td (${s.replace(/[()\\]/g,"\\$&")}) Tj ET\n`;
  const xs=[20,190,290,360,420,500,590];
  function page(header:boolean){let s=options.wrappedFiler?text(20,750,"Example")+text(300,745,"Other cover column")+text(20,740,"PAC"):text(20,750,options.filer??"Example PAC");
    if(header)s+=text(20,700,"$"+total);
    const ys=header?[600,570,500]:[600,530];
    const verticals=header||!options.continuationBorders?xs:options.continuationBorders==="none"?[]:xs.filter(x=>x!==290);
    for(const x of verticals)s+=`${x} ${ys[0]} m ${x} ${ys.at(-1)} l S\n`;
    for(const y of ys)s+=`20 ${y} m 590 ${y} l S\n`;
    if(header)["Candidate Name Office (Support/Oppose)","Amount","Type","Date Expense","Description","Expenditure Name Address"].forEach((v,i)=>s+=text(xs[i]!+2,582,v));
    const y=header?550:580;
    s+=text(22,y,(!header?options.continuationTarget:undefined)??options.target??`Jane Example ${options.office??"State Senator"} (Support)`);
    s+=text(192,y,"$"+(options.amount??"100."))+text(192,y-10,options.amount?"":"01");
    s+=text(292,y,"INDEPENDENT")+text(292,y-10,"EXPENDITURE")+text(362,y,"10/01/2026");
    if(options.payee)s+=text(502,y,options.payee);
    s+="20 100 570 25 re S\n"+text(295,110,"Footer");return s;
  }
  const streams=[page(true),...(options.continuation?[page(false)]:[])];
  const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>",`<< /Type /Pages /Kids [${streams.map((_,i)=>`${4+i*2} 0 R`).join(" ")}] /Count ${streams.length} >>`,`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`];
  for(let i=0;i<streams.length;i++){objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);objects.push(`<< /Length ${Buffer.byteLength(streams[i]!)} >>\nstream\n${streams[i]}endstream`);}
  let pdf="%PDF-1.4\n",offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(pdf);
}
export async function oklahomaFixture(root:string,kind:OklahomaReportedKind,options:Parameters<typeof syntheticOklahomaPdf>[0]={}){
 const dir=resolve(root,"source-originals-"+randomUUID()),profileDir=resolve(root,"profile-originals-"+randomUUID());await mkdir(dir,{mode:0o700});await mkdir(profileDir,{mode:0o700});
 async function originals(directory:string,rows:{role:string;body:Uint8Array|string;mime?:string}[]){const records=[];for(const r of rows){const bytes=typeof r.body==="string"?Buffer.from(r.body):Buffer.from(r.body),at=new Date().toISOString(),file=String(records.length+1).padStart(4,"0")+".original";await writeFile(resolve(directory,file),bytes,{mode:0o600});records.push({role:r.role,file,method:"GET",status:200,contentType:r.mime??"text/html",startedAt:at,completedAt:at,bytes:bytes.length,sha256:okHash(bytes),eof:true});}await writeFile(resolve(directory,"manifest.ndjson"),records.map(r=>JSON.stringify(r)).join("\n")+"\n",{mode:0o600});return records;}
 if(kind==="committee"){
  const zip=(year:number)=>{const row=Object.fromEntries(OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map(k=>[k,""]));Object.assign(row,{"Receipt ID":String(year),"Org ID":"100","Receipt Type":"Monetary","Receipt Date":`10/1/${year}`,"Receipt Amount":"100.01","Receipt Source Type":"Political Action Committee (Registered)","Last Name":"Example PAC","Filed Date":`10/2/${year}`,"Committee Type":"Candidate Committee","Committee Name":options.blankReceivingCommitteeName?"":"Friends of Example","Candidate Name":"Jane Example",Amended:"N"});return zipSync({[`${year}_ContributionLoanExtract.csv`]:strToU8(OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.join(",")+"\n"+OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map(k=>JSON.stringify(row[k])).join(",")+"\n")});};
  await originals(dir,[{role:"download_catalog",body:[2025,2026].map(y=>`<a href="/data/${y}_ContributionLoanExtract.csv.zip">Download</a>`).join("")},...[2025,2026].map(y=>({role:`${y}_ContributionLoanExtract.csv.zip`,body:zip(y),mime:"application/zip"}))]);
 }else{
  const form=`<form method="post" action="/PublicSite/SearchPages/Search.aspx"><input name="ctl$DateFrom$x" value="01/01/2025"><input name="ctl$DateThrough$x" value="10/18/2026"><select name="ctl$DisbursementCodeHook$x"><option selected value="IE">Independent Expenditure</option></select></form>`;
  const table=`<table><tr>${["Filer Name","Report","Period Begin","Period End","Filed Date", ""].map(v=>`<th>${v}</th>`).join("")}</tr><tr><td>Example PAC</td><td>Independent report</td><td>01/01/2025</td><td>10/18/2026</td><td>10/18/2026</td><td><a href="javascript:__doPostBack('ctl$ViewReportNotAmended','')">View Report</a></td></tr></table>`,html=form+table;
  await originals(dir,[{role:"report_catalog",body:'<a href="/PublicSite/SearchPages/Search.aspx">Independent Expenditures</a>'},{role:"ie_search",body:form},{role:"ie_search_results",body:html},{role:"ie_current_report_1_0",body:html+`<embed src="data:application/pdf;base64,${syntheticOklahomaPdf(options).toString("base64")}">`},{role:"ie_closing_inventory_1",body:html}]);
 }
 await originals(profileDir,[{role:"candidate_profile",body:'<span id="ctl00_Content_lblCandID">100</span><span id="ctl00_Content_lblCandName">Jane Example</span><span id="ctl00_Content_lblCandOffice">State Senator</span><span id="ctl00_Content_lblCandDistrict">1</span><span id="dgdCampaigns_x_lblElection">2026</span>'}]);
 const packet=await readOklahomaReportedPacket(dir,kind),source=await loadOklahomaReceiverPacket(packet,"100",{cacheDir:root});return {dir,source,packet};
}
