import {afterEach,describe,expect,it} from "vitest";
import {mkdtemp,writeFile,rm,chmod,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {readMarylandSavedReportDocument as read} from "../../../src/pipeline/marylandFinance/marylandSavedReportDocumentReader.js";
import {buildMarylandPublishedReportPdfRequest,type MarylandPublishedReport} from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";
const owner="11111111-1111-4111-8111-111111111111",guid="22222222-2222-4222-8222-222222222222";
const report:MarylandPublishedReport={reportGuid:guid,reportVersionId:1,reportName:"Annual report",reportVersion:"Original",reportVersionCode:"RPTFLD",
  reportType:"Campaign Finance Report",reportTypeCode:"FPCFR",filingEntityId:1,filerRegistrationGuid:owner,committeeType:"Candidate Committee",committeeTypeCode:"CC",
  officeSought:"Governor",officeSoughtId:40,jurisdiction:"State",jurisdictionId:1,reportingCycle:"2023-2026",reportingCycleId:12023,reportingYear:2025,
  startDate:"2024-01-01T00:00:00",endDate:"2024-12-31T00:00:00",dueDate:"2025-01-17T00:00:00",filedDate:"2025-01-16T12:00:00",
  zeroActivity:false,hasChild:false,childResults:null};
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const digest=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
async function fixture(older=false) {
  const dir=await mkdtemp(join(tmpdir(),"md-document-"));directories.push(dir);await chmod(dir,0o700);
  const originalPath=join(dir,"original.pdf"),captureJournalPath=join(dir,"captures.json"),inventoryPath=join(dir,"inventory.json");
  const bytes=Buffer.from("%PDF-1.7\nsource original\n%%EOF\n");await writeFile(originalPath,bytes,{mode:0o600});
  const inventory=Buffer.from(JSON.stringify({succeeded:true,error:null,data:{items:[report],totalItems:1}}));
  await writeFile(inventoryPath,inventory,{mode:0o600});
  const common={url:"https://api-campaignfinance.maryland.gov/api/PublicFiledReportAndDownload/DownloadDocument",method:"POST",
    byteCount:bytes.length,sha256:digest(bytes),startedAt:"2026-10-13T04:49:24.482244+00:00",completedAt:"2026-10-13T04:49:27.198314+00:00"};
  const capture:Record<string,unknown>=older?{...common,rawPath:originalPath,requestFields:buildMarylandPublishedReportPdfRequest(report),status:200,eof:true,error:null,
    sourceInventoryPath:inventoryPath,sourceInventorySha256:digest(inventory)}:{...common,outputPath:originalPath,requestBody:buildMarylandPublishedReportPdfRequest(report),httpStatus:200,bodyComplete:true,errorCode:null,
    sourceParent:Object.fromEntries(["dueDate","endDate","filedDate","filerRegistrationGuid","reportGuid","reportName","reportVersionId","startDate"].map(k=>[k,report[k as keyof MarylandPublishedReport]]))};
  const save=async(value:unknown=older?capture:[capture])=>writeFile(captureJournalPath,JSON.stringify(value),{mode:0o600});
  await save();return {dir,bytes,capture,save,input:{report,originalPath,captureJournalPath},inventoryPath};
}
describe("Maryland original report document reopening",()=>{
  it.each([false,true])("reopens each genuine capture shape without retiming original microseconds: older=%s",async older=>{
    const f=await fixture(older),result=await read(f.input);
    expect(result.privateBytes).toEqual(f.bytes);expect(result.privateReport).toEqual(report);
    expect(result.sourceFacts).toEqual({byteCount:f.bytes.length,sha256:digest(f.bytes),startedAt:f.capture.startedAt,completedAt:f.capture.completedAt});
    expect(result.sourceFacts).not.toHaveProperty("bodyComplete");expect(result).not.toHaveProperty("qualified");
  });
  it.each([
    {httpStatus:403},{bodyComplete:false},{errorCode:"truncated"},{method:"GET"},{url:"https://example.com"},
    {byteCount:1},{sha256:"a".repeat(64)},{requestBody:{documentGuid:guid,fileName:"Different report",openInNewTab:true}},
    {completedAt:"2026-10-13T04:49:24.482243+00:00"},{startedAt:"2026-02-30T00:00:00.000000+00:00"},
    {sourceParent:{reportGuid:guid}},{sourceParent:null},{sourceParent:undefined},
  ])("holds changed source/capture evidence %j",async change=>{
    const f=await fixture();Object.assign(f.capture,change);await f.save();
    await expect(read(f.input)).rejects.toThrow(/^invalid_maryland_saved_report_document$/);
  });
  it("rejects duplicate and hybrid capture paths",async()=>{
    const f=await fixture();await f.save([f.capture,f.capture]);await expect(read(f.input)).rejects.toThrow("invalid_maryland_saved_report_document");
    f.capture.rawPath=f.input.originalPath;await f.save();await expect(read(f.input)).rejects.toThrow("invalid_maryland_saved_report_document");
  });
  it("requires original SHA, PDF EOF and private files, never exposing underlying private paths",async()=>{
    const f=await fixture();const changed=Buffer.from("%PDF-1.7\nsource original\n% cut\n");
    await writeFile(f.input.originalPath,changed);f.capture.byteCount=changed.length;f.capture.sha256=digest(changed);await f.save();
    await expect(read(f.input)).rejects.toThrow(/^invalid_maryland_saved_report_document$/);
    await writeFile(f.input.originalPath,f.bytes);f.capture.byteCount=f.bytes.length;f.capture.sha256=digest(f.bytes);await f.save();
    await chmod(f.input.originalPath,0o644);await expect(read(f.input)).rejects.toThrow("invalid_maryland_saved_report_document");
    await chmod(f.input.originalPath,0o600);const alias=join(f.dir,"alias.pdf");await symlink(f.input.originalPath,alias);
    f.capture.outputPath=alias;await f.save();await expect(read({...f.input,originalPath:alias})).rejects.toThrow("invalid_maryland_saved_report_document");
  });
  it("requires the older source inventory original to match complete current report metadata",async()=>{
    const f=await fixture(true);const inventory=Buffer.from(JSON.stringify({succeeded:true,error:null,data:{items:[{...report,reportVersionId:2}],totalItems:1}}));
    await writeFile(f.inventoryPath,inventory);f.capture.sourceInventorySha256=digest(inventory);await f.save();
    await expect(read(f.input)).rejects.toThrow("invalid_maryland_saved_report_document");
  });
});
