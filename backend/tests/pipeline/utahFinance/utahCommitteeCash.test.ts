import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { loadUtahCashPacket, utahCashOriginalPath, assertUtahCashPacket, type UtahCashContext } from "../../../src/pipeline/utahFinance/utahCommitteeCashSource.js";
import { replaceUtahCommitteeCash } from "../../../src/pipeline/utahFinance/utahCommitteeCashWriter.js";
import { appendUtahCommitteeCashSummaries } from "../../../src/pipeline/utahFinance/utahCommitteeCashBallotSummary.js";
const context:UtahCashContext={linkId:"11111111-1111-4111-8111-111111111111",candidateId:"22222222-2222-4222-8222-222222222222",electionId:"33333333-3333-4333-8333-333333333333",candidateName:"Example Person",electionYear:2026,folderId:"123",officeScope:"state_lower",officeName:"State Lower Chamber Legislator",district:"7"};
const origin="https://disclosures.utah.gov",folder=origin+"/Search/PublicSearch/FolderDetails/123",ledger=origin+"/Search/AdvancedSearch/GenerateReport/123?ReportYear=2026",report=origin+"/Search/PublicSearch/Report/456",registration=origin+"/Registration/EntityDetails/789",pac=origin+"/Search/AdvancedSearch/GenerateReport?ReportYear=2026&EntityType=PAC";
const fields=["PCC","REPORT","TRAN_ID","TRAN_TYPE","TRAN_DATE","TRAN_AMT","INKIND","LOAN","AMENDS","NAME","PURPOSE","ADDRESS1","ADDRESS2","CITY","STATE","ZIP","INKIND_COMMENTS"];
const row=(id:string,amount:string,kind="Contribution",inKind="",loan="",label="Convention")=>["Person, Example",label,id,kind,"3/1/2026",amount,inKind,loan,"","Example Committee","","","","","","",""];
const rows=[row("1","100.00"),row("2","100.00"),row("3","50.00","Contribution","","X"),row("4","25.00","Contribution","X"),row("5","-10.00","Expenditure"),row("6","999.00","Contribution","","","General")];
const csv=(values:string[][])=>[fields,...values].map(r=>r.map(s=>`"${s.replaceAll('"','""')}"`).join(",")).join("\r\n");
const field=(label:string,value:string)=>`<div><label>${label}</label>${value}</div>`;
const nativeRow=(amount:string,i="",l="")=>`<tr><td>3/1/2026</td><td>Example Committee</td><td>Example</td><td>${i}</td><td></td><td>${l}</td><td></td><td>${amount}</td></tr>`;
const table=(contribution:boolean,body:string,total:string)=>`<table><tr><th>Itemized ${contribution?"Contributions Received":"Expenditures Made"} I = In-kind</th></tr><tr>${(contribution?["Date Received","Name of Contributor","Complete Mailing Address","I","P","L","A","Contribution Amount"]:["Exp. Date","Name of Recipient","Purpose","I","P","L","A","Expenditure Amount"]).map(s=>`<th>${s}</th>`).join("")}</tr>${body}<tr><td>Total ${contribution?"Contributions Received (In-kind amounts do not affect totals.)":"Expenditures Made"}</td><td>${total}</td></tr></table>`;
const statement=field("Report Name","2026 Convention Report")+field("Name","Example Person")+field("SubmitDate","4/1/2026")+`<table><tr><td>2</td><td>Total Contributions Received</td><td>$250.00</td><td>$250.00</td></tr><tr><td>4</td><td>Total Expenditures Made</td><td>$10.00</td><td>$10.00</td></tr></table>`+table(true,nativeRow("$100.00")+nativeRow("$100.00")+nativeRow("$50.00","","✓")+nativeRow("$25.00","[I1]"),"$250.00")+table(false,nativeRow("$10.00"),"$10.00");
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const cacheDir=await mkdtemp(join(tmpdir(),"utah-cash-test-"));dirs.push(cacheDir);await mkdir(join(cacheDir,"utah-committee-cash"));
 async function save(phase:string,url:string,body:string){await writeFile(utahCashOriginalPath(cacheDir,phase,url),JSON.stringify({url,observedAt:"2026-10-23T12:00:00.000Z",body,kind:"saved-http-body"}));}
 const folderBody=`<iframe src="${registration}"></iframe><a href="javascript:openReport('/Search/PublicSearch/Report/456');">2026 - Convention</a>`;
 await save("folder-open",folder,folderBody);await save("folder-close",folder,folderBody);
 await save("registration",registration,field("First","Example")+field("Middle","")+field("Last","Person")+field("Office","House")+field("District #","7"));
 await save("ledger-open",ledger,csv(rows));await save("ledger-close",ledger,csv([...rows,row("7","1.00","Contribution","","","General")]));await save("statement",report,statement);
 const header=['FILED','PAC',...fields.slice(1)],values=['4/1/2026','Example Committee',...row('99','1.00').slice(1)];
 await save("typed-pac",pac,[header,values].map(r=>r.map(s=>`"${s}"`).join(',')).join('\r\n'));
 return {cacheDir,save,load:()=>loadUtahCashPacket(context,{cacheDir,now:new Date("2026-10-23T13:00:00.000Z")})};
}
describe("Utah complete filed committee-cash source",()=>{
 it("keeps repeated occurrences, excludes loans/in-kind/unfiled receipts, permits unfiled growth and mints an immutable packet",async()=>{
  const f=await fixture(),p=await f.load();expect(p).toMatchObject({reportCount:1,occurrenceCount:5,excludedUnfiledCount:2,donors:[{committeeName:"Example Committee",amountCents:20000,contributionCount:2}]});expect(Object.isFrozen(p.donors[0])).toBe(true);expect(()=>assertUtahCashPacket(p)).not.toThrow();
 });
 it("rejects cloned packets before connecting to the DB",async()=>{const f=await fixture(),p=await f.load(),db={connect:vi.fn()};await expect(replaceUtahCommitteeCash(db as unknown as Pool,{...p})).rejects.toThrow("unverified_packet");expect(db.connect).not.toHaveBeenCalled();});
 it.each([
  ["statement",report,statement.replace(nativeRow("$100.00"),"")],
  ["statement",report,statement.replace("$250.00","$249.00")],
  ["statement",report,statement.replace("Example Person","Different Person")],
  ["statement",report,"<html>Verify you are human</html>"],
  ["registration",registration,field("First","Example")+field("Middle","")+field("Last","Person")+field("Office","House")+field("District #","8")],
  ["ledger-close",ledger,csv(rows.map((r,i)=>i===0?row("1","99.00"):r))],
  ["folder-close",folder,`<iframe src="${registration}"></iframe>`],
  ["typed-pac",pac,"<html>Challenge</html>"],
 ])("holds missing, contradictory or challenged whole source: %s",async(phase,url,body)=>{const f=await fixture();await f.save(phase,url,body);await expect(f.load()).rejects.toThrow();});
 it("rejects nonempty amendment linkages",async()=>{const f=await fixture(),changed=rows.map(r=>[...r]);changed[0][8]="77";await f.save("ledger-open",ledger,csv(changed));await expect(f.load()).rejects.toThrow("receiving_export_scope");});
 it("holds stale saved originals without network fallback",async()=>{const f=await fixture(),path=utahCashOriginalPath(f.cacheDir,"folder-open",folder),o=JSON.parse(await readFile(path,"utf8"));o.observedAt="2026-10-20T12:00:00.000Z";await writeFile(path,JSON.stringify(o));await expect(f.load()).rejects.toThrow("original_identity_or_age");});
});
describe("Utah atomic committee-cash writer",()=>{
 it.each(["write","idempotent","failure","changed-link"])("%s preserves the independent component boundary",async(mode)=>{
  const f=await fixture(),p=await f.load();const statements:string[]=[];const client={release:vi.fn(),query:vi.fn(async(sql:string)=>{statements.push(sql);if(sql.includes("SELECT l.id"))return {rows:mode==="changed-link"?[]:[{id:context.linkId}]};if(sql.includes("SELECT folder_id"))return {rows:mode==="idempotent"?[{folder_id:context.folderId,last_synced_at:new Date(p.observedAt)}]:[]};if(mode==="failure"&&sql.includes("INSERT INTO public.ut_candidate_finance_pac_donors"))throw Error("synthetic write failure");return {rows:[]};})};const db={connect:async()=>client};
  if(mode==="failure"||mode==="changed-link")await expect(replaceUtahCommitteeCash(db as unknown as Pool,p)).rejects.toThrow();else expect(await replaceUtahCommitteeCash(db as unknown as Pool,p)).toBe(mode==="write");
  expect(statements.at(-1)).toBe(mode==="failure"||mode==="changed-link"?"ROLLBACK":"COMMIT");expect(client.release).toHaveBeenCalledOnce();expect(statements.some(s=>/ut_candidate_finance_summaries/.test(s))).toBe(false);if(mode==="idempotent"||mode==="changed-link")expect(statements.some(s=>s.startsWith("DELETE"))).toBe(false);
 });
});
describe("Utah donor-only real reader",()=>{
 it("keeps totals unknown and sums every donor before display caps",async()=>{
  const db={query:vi.fn(async()=>({rows:Array.from({length:8},(_,i)=>({candidate_id:context.candidateId,election_id:context.electionId,election_year:2026,observed_at:"2026-10-23T12:00:00Z",committee_id:`reported:EXAMPLE ${i}`,committee_name:`Example ${i}`,amount_cents:"10000",source_url:folder,industry_slug:null,classification_source:null,confidence:null}))}))};const map=new Map();await appendUtahCommitteeCashSummaries(db,[{candidate_id:context.candidateId,election_id:context.electionId}],map);const summary=map.values().next().value;
  expect(summary.direct_campaign.total_raised).toBeNull();expect(summary.outside_spending.support_total).toBeNull();expect(summary.direct_campaign.pac_money_basis).toBe("reported_itemized_committee_cash_contributions");expect(summary.direct_campaign.pac_money_by_interest[0]).toMatchObject({amount:800,pac_count:8});expect(summary.direct_campaign.pac_money_by_interest[0].pacs).toHaveLength(5);expect(summary.direct_campaign.pac_money_coverage_note).toContain("limited recognized subset");
 });
});
