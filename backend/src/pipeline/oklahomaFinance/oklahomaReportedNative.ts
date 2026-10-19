import { createRequire } from "node:module";
import { okHold } from "./oklahomaReportedCore.js";
export const OK_GUARDIAN_ORIGIN="https://guardian.ok.gov";
const require=createRequire(import.meta.url);
export function okDocument(html:string,url=OK_GUARDIAN_ORIGIN):Document {
  // Load the parser only for enabled acquisition/replay, not every API startup.
  const {JSDOM}=require("jsdom") as {JSDOM:new(html:string,options:{url:string})=>{window:{document:Document}}};
  return new JSDOM(html,{url}).window.document;
}
export const okText=(v:string)=>v.replace(/\s+/g," ").trim();
export function okNativeUrl(raw:string,base:string):string {
  const u=new URL(raw,base);if(u.origin!==OK_GUARDIAN_ORIGIN||u.username||u.password||u.hash)okHold("native_origin");return u.href;
}
export function okNativeFields(doc:Document,target="",arg="",search=false):{url:string;body:URLSearchParams} {
  const form=doc.querySelector("form");if(form?.method!=="post")okHold("native_form");
  const body=new URLSearchParams();
  for(const e of Array.from(form.elements) as HTMLInputElement[]){if(!e.name||e.disabled||["submit","button","image","reset","file"].includes(e.type)||(["checkbox","radio"].includes(e.type)&&!e.checked))continue;body.append(e.name,e.value??"");}
  body.set("__EVENTTARGET",target);body.set("__EVENTARGUMENT",arg);
  if(search){const b=(Array.from(form.elements) as HTMLInputElement[]).find(e=>e.name.includes("$IEEC_SearchButton$"));if(!b)okHold("native_search_button");body.set(b.name,b.value);}
  return {url:okNativeUrl(form.action,doc.URL),body};
}
export function okNativeBack(a:Element):[string,string] {
  const m=/__doPostBack\('([^']+)','([^']*)'\)/.exec(a.getAttribute("href")??"");if(!m)okHold("native_postback");return [m[1]!,m[2]!];
}
export function okInventoryRows(doc:Document):HTMLTableRowElement[] {
  const t=Array.from(doc.querySelectorAll("table")).filter(t=>t.rows.length>=2&&Array.from(t.rows[0]!.cells).map(c=>okText(c.textContent??"")).join("|")==="Filer Name|Report|Period Begin|Period End|Filed Date|").at(-1);
  if(!t)okHold("native_inventory");
  const rows=Array.from(t.rows).slice(1).filter(r=>r.cells.length===6&&r.querySelector("a[href]"));
  if(!rows.length||rows.length>10)okHold("native_inventory_rows");return rows;
}
export const okInventoryContext=(r:HTMLTableRowElement):string[]=>Array.from(r.cells).slice(0,5).map(c=>okText(c.textContent??""));
export function okNextPage(doc:Document,page:number):[string,string]|null {
  for(const a of doc.querySelectorAll("a[href]")){const m=/__doPostBack\('([^']+)','([^']*)'\)/.exec(a.getAttribute("href")??"");if(m?.[2]===`Page$${page+1}`)return [m[1]!,m[2]];}
  return null;
}
export function okAmendmentRows(doc:Document):HTMLTableRowElement[]{
  const t=Array.from(doc.querySelectorAll("table")).find(t=>t.rows.length>=2&&Array.from(t.rows[0]!.cells).map(c=>okText(c.textContent??"")).join("|")==="Amendment|Report|Filed");
  if(!t||t.rows.length<2||t.rows.length>21)okHold("native_amendment_inventory");
  const rows=Array.from(t.rows).slice(1);if(rows.some(r=>r.cells.length!==3||!r.querySelector("a[href]")))okHold("native_amendment_inventory");return rows;
}
