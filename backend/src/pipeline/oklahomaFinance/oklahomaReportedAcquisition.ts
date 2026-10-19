import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { okHash,okHold } from "./oklahomaReportedCore.js";
import { OK_GUARDIAN_ORIGIN as origin,okDocument,okNativeUrl,okNativeFields,okNativeBack,okInventoryRows,okInventoryContext,okNextPage,okAmendmentRows } from "./oklahomaReportedNative.js";

export type OklahomaOriginalCapture={role:string;file:string;method:"GET"|"POST";status:number;contentType:string|null;startedAt:string;completedAt:string;bytes:number;sha256:string;eof:true};
const UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36";
/** Saves untouched response bytes before decoding. Public selectors/ViewState
 * are sent only to the native origin; anonymous cookies remain in memory. */
export async function createOklahomaOriginalCapture(cache:string,prefix="source-originals-") {
  const directory=resolve(cache,prefix+randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
  const captures:OklahomaOriginalCapture[]=[],cookies=new Map<string,string>();let total=0;
  async function capture(role:string,url:string,body?:URLSearchParams){
    okNativeUrl(url,origin);if(captures.length>=700)okHold("source_request_limit");
    const startedAt=new Date().toISOString(),headers:Record<string,string>={"User-Agent":UA,Accept:"text/html,application/xhtml+xml,application/pdf,application/zip,*/*",Origin:origin,Referer:origin+"/PublicSite/Reports/Reports.aspx"};
    if(cookies.size)headers.Cookie=[...cookies].map(([k,v])=>`${k}=${v}`).join("; ");if(body)headers["Content-Type"]="application/x-www-form-urlencoded";
    const response=await fetch(url,{method:body?"POST":"GET",headers,...(body?{body:body.toString()}:{}),redirect:"error",signal:AbortSignal.timeout(120000)});
    for(const c of response.headers.getSetCookie?.()??[]){const pair=c.split(";")[0]!,i=pair.indexOf("=");if(i>0)cookies.set(pair.slice(0,i),pair.slice(i+1));}
    const declared=response.headers.get("content-length");if(declared!==null&&Number(declared)>32*1024*1024)okHold("source_byte_limit");
    const bytes=Buffer.from(await response.arrayBuffer()),completedAt=new Date().toISOString();total+=bytes.length;
    if(bytes.length>32*1024*1024||total>128*1024*1024)okHold("source_byte_limit");
    const file=String(captures.length+1).padStart(4,"0")+".original";
    await writeFile(resolve(directory,file),bytes,{mode:0o600,flag:"wx"});
    const meta:OklahomaOriginalCapture={role,file,method:body?"POST":"GET",status:response.status,contentType:response.headers.get("content-type"),startedAt,completedAt,bytes:bytes.length,sha256:okHash(bytes),eof:true};
    captures.push(meta);await appendFile(resolve(directory,"manifest.ndjson"),JSON.stringify(meta)+"\n",{mode:0o600});
    if(response.status!==200||(!response.headers.get("content-encoding")&&declared!==null&&Number(declared)!==bytes.length))okHold("source_status_or_eof");
    await new Promise(r=>setTimeout(r,1000));
    return {bytes,meta,html:()=>new TextDecoder("utf-8",{fatal:true}).decode(bytes)};
  }
  return {directory,capture};
}

export async function acquireOklahomaIeOriginals(cache:string):Promise<string>{
  const {directory,capture}=await createOklahomaOriginalCapture(cache);
  const catalog=await capture("report_catalog",origin+"/PublicSite/Reports/Reports.aspx"),cdoc=okDocument(catalog.html(),origin+"/PublicSite/Reports/Reports.aspx");
  const link=Array.from(cdoc.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(a=>/Independent Expenditures/.test(a.textContent??"")&&new URL(a.href).pathname.endsWith("/Search.aspx"));
  if(link.length!==1)okHold("native_ie_catalog");
  const initial=await capture("ie_search",okNativeUrl(link[0]!.href,origin)),doc=okDocument(initial.html(),link[0]!.href),request=okNativeFields(doc);
  const elements=Array.from(doc.querySelector("form")!.elements) as HTMLInputElement[],from=elements.find(e=>e.name.includes("$DateFrom$")),through=elements.find(e=>e.name.includes("$DateThrough$"));
  const kind=Array.from(doc.querySelectorAll("select")).find(e=>e.name.includes("$DisbursementCodeHook$")),submit=elements.find(e=>e.name.includes("$IEEC_SearchButton$"));
  const ie=kind&&Array.from(kind.options).find(o=>o.textContent?.trim()==="Independent Expenditure");
  if(!from||!through||!kind||!submit||!ie)okHold("native_ie_controls");
  const now=new Date(),end=`${String(now.getUTCMonth()+1).padStart(2,"0")}/${String(now.getUTCDate()).padStart(2,"0")}/${now.getUTCFullYear()}`;
  request.body.set(from.name,"01/01/2025");request.body.set(through.name,end);request.body.set(kind.name,ie.value);request.body.set(submit.name,submit.value);
  const first=await capture("ie_search_results",request.url,request.body);let current=okDocument(first.html(),request.url);
  const contexts:string[][]=[];let pageCount=0,complete=false;
  async function document(role:string,response:{bytes:Buffer;html:()=>string},url:string){
    if(response.bytes.subarray(0,5).toString()==="%PDF-")return;
    const html=response.html(),embedded=Array.from(html.matchAll(/data:application\/pdf;base64,([A-Za-z0-9+/=]+)/g));if(embedded.length===1)return;
    const links=Array.from(html.matchAll(/window\.open\(\s*["']([^"']+)["']/g));if(embedded.length||links.length!==1)okHold("native_pdf_link");
    const pdf=await capture(role,okNativeUrl(links[0]![1]!,url));if(pdf.bytes.subarray(0,5).toString()!=="%PDF-")okHold("native_pdf_bytes");
  }
  for(let page=1;page<=100;page++){
    pageCount=page;const opening=okInventoryRows(current).map(okInventoryContext);contexts.push(...opening);
    for(let index=0;index<opening.length;index++){
      const row=okInventoryRows(current)[index]!,a=Array.from(row.querySelectorAll<HTMLAnchorElement>("a[href]")).find(a=>a.textContent?.trim()==="View Report");if(!a)okHold("native_report_link");
      if(a.href.includes("FilingAmendmentSelect.aspx?")){
        const selector=await capture(`ie_amendment_selector_${page}_${index}`,okNativeUrl(a.href,current.URL));let adoc=okDocument(selector.html(),a.href);
        const versions=okAmendmentRows(adoc),openingVersions=versions.map(r=>r.innerHTML);
        // No marker/date inference: retain every native version. This family
        // is held for affected candidates until current-version authority exists.
        for(let version=0;version<versions.length;version++){
          const rows=okAmendmentRows(adoc);if(JSON.stringify(rows.map(r=>r.innerHTML))!==JSON.stringify(openingVersions))okHold("native_amendment_changed");
          const button=rows[version]!.querySelector("a[href]")!,back=okNativeBack(button),r=okNativeFields(adoc,...back),pdf=await capture(`ie_family_version_${page}_${index}_${version}`,r.url,r.body);
          await document(`ie_family_document_${page}_${index}_${version}`,pdf,r.url);
          // Re-read the selector before the next stateful postback.
          const again=await capture(`ie_family_selector_${page}_${index}_${version}`,a.href);adoc=okDocument(again.html(),a.href);
        }
        if(JSON.stringify(okAmendmentRows(adoc).map(r=>r.innerHTML))!==JSON.stringify(openingVersions))okHold("native_amendment_changed");
      }else{
        const back=okNativeBack(a),r=okNativeFields(current,...back),pdf=await capture(`ie_current_report_${page}_${index}`,r.url,r.body);await document(`ie_current_report_document_${page}_${index}`,pdf,r.url);current=okDocument(pdf.html(),r.url);
        if(JSON.stringify(okInventoryRows(current).map(okInventoryContext))!==JSON.stringify(opening))okHold("native_inventory_changed");
      }
    }
    const next=okNextPage(current,page);if(!next){complete=true;break;}const r=okNativeFields(current,...next),res=await capture(`ie_inventory_page_${page+1}`,r.url,r.body);current=okDocument(res.html(),r.url);
  }
  if(!complete)okHold("native_page_limit");
  const close=okNativeFields(current,"","",true),res=await capture("ie_closing_inventory_1",close.url,close.body);current=okDocument(res.html(),close.url);
  const closing:string[][]=[];let closed=false;
  for(let page=1;page<=100;page++){closing.push(...okInventoryRows(current).map(okInventoryContext));const next=okNextPage(current,page);if(!next){closed=page===pageCount;break;}const r=okNativeFields(current,...next),res=await capture(`ie_closing_inventory_${page+1}`,r.url,r.body);current=okDocument(res.html(),r.url);}
  if(!closed||JSON.stringify(contexts)!==JSON.stringify(closing))okHold("native_closing_inventory");
  return directory;
}

export async function acquireOklahomaReceiptOriginals(cache:string):Promise<string>{
  const {directory,capture}=await createOklahomaOriginalCapture(cache),catalog=await capture("download_catalog",origin+"/PublicSite/DataDownload.aspx"),doc=okDocument(catalog.html(),origin+"/PublicSite/DataDownload.aspx");
  for(const year of [2025,2026]){
    const links=Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(a=>new URL(a.href).pathname.endsWith(`/${year}_ContributionLoanExtract.csv.zip`));if(links.length!==1)okHold("native_receipt_catalog");
    await capture(`${year}_ContributionLoanExtract.csv.zip`,okNativeUrl(links[0]!.href,doc.URL));
  }
  return directory;
}
