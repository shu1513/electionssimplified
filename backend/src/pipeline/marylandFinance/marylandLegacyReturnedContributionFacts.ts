import { readMarylandReportPdfGeometry, type MarylandPdfCell, type MarylandPdfPage, type MarylandPdfBorder } from "./marylandReportPdfGeometry.js";
import { parseMarylandLegacyFinancialControls, type MarylandLegacyFinancialControls } from "./marylandLegacyReportFinancialControls.js";
import { bindMarylandNativeReportOccurrences } from "./marylandNativeReportBinding.js";
import { buildMarylandPublicReportInventoryRequest, decodeMarylandPublishedReport, type MarylandPublishedReport, type MarylandPublicReportInventoryRequest } from "./marylandPublicReportClient.js";
import { parseMarylandCfsMoney } from "./marylandCfsArtifactReader.js";
import {projectMarylandLegacyNativeFullAddress,type MarylandSourceStateDisplayDictionary} from "./marylandSourceStateDisplay.js";

type Row = Readonly<Record<string, unknown>>;
type ScheduleTotal = Readonly<{pageNumber:number;top:number;bottom:number;amountCents:number}>;
type ContinuationStrip = Readonly<{pageNumber:number;top:number;bottom:number;split:89.31|161.31;borders:readonly MarylandPdfBorder[]}>;
type SourceCell = Readonly<MarylandPdfCell & {pageNumber:number}>;
type Continuation = Readonly<{predecessorPageNumber:number; predecessorOrdinal:number; pageNumber:number; followingPageNumber:number; followingTop:number; ledgerBottom:number; followingPrefix:Readonly<{top:number;bottom:number;cells:readonly MarylandPdfCell[];borders:readonly MarylandPdfBorder[]}>|null; strips:readonly ContinuationStrip[]; cells:readonly SourceCell[]}>;
export type MarylandLegacyReturnedContributionOccurrence = Readonly<{
  pageNumber: number; ordinal: number; date: string; amountCents: number; rowTop:number; rowBottom:number;
  nameAddress: string; followingPageIdentityCells: number;
}>;
export type MarylandLegacyReturnedContributionFacts = Readonly<{
  sourceFacts: Readonly<{ sha256: string; byteCount: number; pageCount: number;
    returnCount: number; returnCents: number; sectionStarts: number; returnedContributionSectionCount:number; unknownContinuationCount: number; purposeContinuationCount:number; scheduleTotalCents:number|null;
    controls: MarylandLegacyFinancialControls }>;
  /** Private transient source text. Never log or persist. */
  privateOccurrences: readonly MarylandLegacyReturnedContributionOccurrence[];
  privateScheduleTotal: ScheduleTotal|null;
  privateUnknownContinuations: readonly Continuation[];
  /** Exact printed Expenditure Purpose blocks; values are never donor identity. */
  privatePurposeContinuations: readonly Continuation[];
}>;
export class MarylandLegacyReturnedContributionError extends Error {
  constructor(public readonly code: "geometry" | "header" | "border" | "date" | "amount" | "identity" |
    "continuation" | "control" | "invalid_native" | "duplicate" | "parent" | "over_refund" | "comparison" | "report") {
    super(`Maryland legacy returned contribution: ${code}`);
  }
}
function fail(code: MarylandLegacyReturnedContributionError["code"]): never { throw new MarylandLegacyReturnedContributionError(code); }
const clean = (s: string) => s.trim().replace(/\s+/g, " ");
const normalize = (s: string) => clean(s).toUpperCase();
const center = (c: MarylandPdfCell) => c.baselineTop - c.height * .3;
const apparentFinancial=/\$|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d[\d,]*\.\d{2}\b/;
const near = (a: number, b: number) => Math.abs(a-b) < .02;
const columns = [17.56, 89.31, 161.31, 305.31, 446.627, 503.31, 593.06];
const sections = new Set(["Contributions", "Transfers in", "Other Receipts and In-Kind Contributions", "Expenditures"]);
const returnedContributionCategory=(value:string)=>/\breturn(?:ed|s)?\b/i.test(value)&&/\bcontributions?\b/i.test(value);
const committeeClasses = new Set(["TCC", "TFED", "TPAC", "TPCC", "TPOC", "TRNFC", "TUNFC", "TSLATE", "TPCLB"]);
const allClasses = new Set([...committeeClasses, "TBSN", "TIND", "TLAB", "TNPO", "TSPDC"]);
const guid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number)>0;
function exactPrintedContact(identity: string, row: Row, dictionary?:MarylandSourceStateDisplayDictionary) {
  const name=normalize(row.contributorName as string);
  const projected=dictionary?projectMarylandLegacyNativeFullAddress(row,dictionary):null;
  const address=projected!==null?normalize(projected):typeof row.contributorFullAddress==="string"?normalize(row.contributorFullAddress):"";
  // The complete painted field must agree. A name/street prefix cannot
  // license an arbitrary or conflicting printed address suffix. A qualified
  // state presentation replaces the address; raw contact is no alternate.
  return identity===name || Boolean(address && identity===`${name} ${address}`);
}
function add(a: number, b: number) { const n=a+b; if (!Number.isSafeInteger(n)) fail("amount"); return n; }
function date(s: string) {
  const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); if (!m) return fail("date");
  const value=`${m[3]}-${m[1]}-${m[2]}`;
  if (Number(m[3])<1900 || Number(m[3])>2100 || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) fail("date");
  return value;
}
function money(s: string) {
  const m=/^\$((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/.exec(s); if (!m) return fail("amount");
  const n=Number(m[1]!.replaceAll(",", ""))*100+Number(m[2]); if (!positive(n)) fail("amount"); return n;
}
function vertical(p: MarylandPdfPage, x: number, top: number, bottom: number) {
  return p.borders.some(b=>near(b.x1,b.x2) && near(b.x1,x) && Math.min(b.y1,b.y2)<=top+.3 && Math.max(b.y1,b.y2)>=bottom-.3);
}
function horizontal(p:MarylandPdfPage,y:number) {
  let end=17.56;
  const parts=p.borders.filter(b=>near(b.y1,b.y2) && near(b.y1,y)).map(b=>[Math.min(b.x1,b.x2),Math.max(b.x1,b.x2)]).sort((a,b)=>a[0]!-b[0]!);
  for(const [left,right]of parts){if(right!<end)continue;if(left!>end+.3)break;end=Math.max(end,right!);if(end>=593.06-.3)return true;}return false;
}
function purposeLabel(cells:readonly MarylandPdfCell[]) {
  return cells.length===1 && clean(cells[0]!.text)==="Expenditure Purpose:" &&
    near(cells[0]!.left,19.296) && cells[0]!.right<=161.31;
}
function validatePage(p: MarylandPdfPage, expected: number) {
  if (p.pageNumber!==expected || p.width!==612 || p.height!==792 || p.cells.some(c=>typeof c.text!=="string" || !clean(c.text) || ![c.left,c.right,c.baselineTop,c.height].every(Number.isFinite) || c.left<0 || c.right>613 || c.right<=c.left || c.height<=0 || center(c)<0 || center(c)>792) || p.borders.some(b=>!Object.values(b).every(Number.isFinite))) fail("geometry");
}
/** Reads the entire document and complete painted Z schedule. This establishes
 * source occurrence/family facts only, never financial or currentness authority. */
async function readReturnedContributions(bytes: Uint8Array, observeUnknown: boolean): Promise<MarylandLegacyReturnedContributionFacts> {
  const data=new Uint8Array(bytes); // Retain before the PDF loader's first await.
  const privateOccurrences: MarylandLegacyReturnedContributionOccurrence[]=[];
  const controlPages: MarylandPdfPage[]=[];
  const privateUnknownContinuations: MarylandLegacyReturnedContributionFacts["privateUnknownContinuations"][number][]=[];
  const privatePurposeContinuations:Continuation[]=[];
  let deferredPurposeLabel:Readonly<{predecessor:MarylandLegacyReturnedContributionOccurrence;strip:ContinuationStrip;cells:readonly SourceCell[];ledgerBottom:number}>|null=null;
  let active=false, lastPage=0, sectionStarts=0, returnedContributionSectionCount=0, closed=false, afterReturnFooter=false, scheduleTotalCents:number|null=null;
  let pending: MarylandLegacyReturnedContributionOccurrence|undefined;
  let privateScheduleTotal:ScheduleTotal|null=null;
  let deferredTailIndex:Readonly<{index:number;purpose:boolean}>|null=null;
  const geometry=await readMarylandReportPdfGeometry(data,p=>{
    validatePage(p,++lastPage); if (p.pageNumber<=2) controlPages.push(p);
    const headings=p.cells.filter(c=>c.left>150 && c.left<350 && sections.has(clean(c.text))).sort((a,b)=>a.baselineTop-b.baselineTop);
    // Inspect section/category roles throughout the document, including
    // sections before or after Z. In-kind/unknown returned families cannot be
    // silently omitted from a universal cash-outflow proof.
    if(p.pageNumber>2)for(const heading of headings){
      const category=p.cells.filter(c=>c.baselineTop>heading.baselineTop+1 && c.baselineTop<heading.baselineTop+18).sort((a,b)=>a.baselineTop-b.baselineTop || a.left-b.left).map(c=>clean(c.text)).join(" ");
      if(returnedContributionCategory(category)){
        returnedContributionSectionCount++;
        if(clean(heading.text)!=="Expenditures"||category!=="Z - Returned Contribution")fail("header");
      }
    }
    const headers=p.cells.filter(c=>Math.abs(c.left-19.296)<.4 && clean(c.text)==="Date").map(anchor=>{
      const heading=headings.filter(c=>c.baselineTop<anchor.baselineTop-20).at(-1); if (!heading) return fail("header");
      const category=p.cells.filter(c=>c.baselineTop>heading.baselineTop+1 && c.baselineTop<heading.baselineTop+18).sort((a,b)=>a.baselineTop-b.baselineTop || a.left-b.left).map(c=>clean(c.text)).join(" ");
      if (returnedContributionCategory(category) && (clean(heading.text)!=="Expenditures" || category!=="Z - Returned Contribution")) fail("header");
      const returned=clean(heading.text)==="Expenditures" && category==="Z - Returned Contribution";
      if (returned) {
        sectionStarts++;
        const band=p.cells.filter(c=>c.baselineTop>=anchor.baselineTop-.5 && c.baselineTop<=anchor.baselineTop+12);
        for (const [text,x] of [["Date",19.296],["Name and Address of Payee",163.296],["Special",456.12],["Amount",505.296]] as const)
          if (band.filter(c=>clean(c.text)===text && Math.abs(c.left-x)<.4).length!==1) fail("header");
      }
      return {y:center(anchor),bottom:anchor.baselineTop+12,returned};
    }).sort((a,b)=>a.y-b.y);
    // A title cannot silently replace the schedule without its painted header.
    for (const heading of headings) if (p.pageNumber>2 && (active || clean(heading.text)==="Expenditures")) {
      if (!headers.some(h=>h.y>heading.baselineTop && h.y<heading.baselineTop+100)) fail("header");
    }
    const rawEdges=[...new Set(p.borders.filter(b=>near(b.y1,b.y2) && Math.min(b.x1,b.x2)<=17.57 && Math.max(b.x1,b.x2)>=89.30).map(b=>b.y1))].sort((a,b)=>a-b),edges:number[]=[];
    for(const y of rawEdges){
      const prior=edges.at(-1);
      if(prior!==undefined && y-prior<=.3){
        if(p.cells.some(c=>c.right>17.56 && c.left<593.06 && c.baselineTop>prior && c.baselineTop-c.height<y))fail("border");
        edges[edges.length-1]=y;
      }else edges.push(y);
    }
    const dates=p.cells.filter(c=>c.left>17.56 && c.left<89.31 && c.right<=89.31+.02 && center(c)>75 && center(c)<750 && /^\d{2}\/\d{2}\/\d{4}$/.test(clean(c.text))).sort((a,b)=>center(a)-center(b));
    for(const h of headers.filter(h=>h.returned)){
      const top=Math.max(...edges.filter(y=>y<h.y)),bottom=Math.min(...edges.filter(y=>y>h.y));
      if(!Number.isFinite(top)||!Number.isFinite(bottom)||!horizontal(p,top)||!horizontal(p,bottom)||!columns.every(x=>vertical(p,x,top,bottom)))fail("border");
    }
    const firstDate=dates[0], firstHeader=headers[0];
    function exactTotal(top:number,bottom:number):ScheduleTotal|null{
      const row=p.cells.filter(c=>center(c)>top && center(c)<bottom && c.right>17.56 && c.left<593.06);
      const labels=row.filter(c=>clean(c.text)==="Total" && near(c.left,477.36)),amounts=row.filter(c=>c.left>503.31 && c.right<=593.06);
      if(labels.length!==1 || row.length!==2 || amounts.length!==1 ||
        ![17.56,503.31,593.06].every(x=>vertical(p,x,top,bottom)) ||
        [89.31,161.31,305.31,446.627].some(x=>vertical(p,x,top,bottom)) ||
        !horizontal(p,top) || !horizontal(p,bottom) || Math.abs(labels[0]!.baselineTop-amounts[0]!.baselineTop)>.8 ||
        row.some(c=>c.baselineTop-c.height<top-.3 || c.baselineTop>bottom+.3))return null;
      return Object.freeze({pageNumber:p.pageNumber,top,bottom,amountCents:money(clean(amounts[0]!.text))});
    }
    const footerCandidate=(active || pending || headers.some(h=>h.returned))?edges.slice(0,-1).map((top,i)=>exactTotal(top,edges[i+1]!)).find(t=>t!==null)??null:null;
    if(deferredTailIndex!==null){
      const deferredCollection=deferredTailIndex.purpose?privatePurposeContinuations:privateUnknownContinuations;
      const unknown=deferredCollection[deferredTailIndex.index]!;
      if(p.pageNumber!==unknown.pageNumber+1 || (!firstDate && !footerCandidate) ||
        (firstHeader && (!firstDate || firstHeader.y<center(firstDate))))fail("continuation");
      const boundaryTop=firstDate?Math.max(...edges.filter(y=>y<center(firstDate))):footerCandidate!.top;
      const ledgerTop=edges.find(y=>y>=75);
      if(ledgerTop===undefined || ![78.606,78.646].some(y=>near(ledgerTop,y)) || boundaryTop<ledgerTop ||
        p.cells.some(c=>c.right>17.56 && c.left<593.06 && c.baselineTop>75 && c.baselineTop-c.height<boundaryTop))fail("continuation");
      if(boundaryTop>ledgerTop+.02 && (!horizontal(p,ledgerTop) || !horizontal(p,boundaryTop) ||
        ![17.56,593.06].every(x=>vertical(p,x,ledgerTop,boundaryTop))))fail("continuation");
      const prefixBorders=p.borders.filter(b=>Math.max(b.y1,b.y2)>=ledgerTop-.3 && Math.min(b.y1,b.y2)<=boundaryTop+.3);
      deferredCollection[deferredTailIndex.index]=Object.freeze({...unknown,followingTop:boundaryTop,followingPrefix:Object.freeze({top:ledgerTop,bottom:boundaryTop,cells:Object.freeze([]),borders:Object.freeze(prefixBorders.map(b=>Object.freeze({...b})))})});
      deferredTailIndex=null;
    }
    const continuationRows=new Set<string>(),purposeIncomingCells=new Set<MarylandPdfCell>();
    if(deferredPurposeLabel){
      const deferred=deferredPurposeLabel;
      if(!pending || pending.ordinal!==deferred.predecessor.ordinal || p.pageNumber!==deferred.strip.pageNumber+1 ||
        (!firstDate && !footerCandidate) || (firstHeader && (!firstDate || firstHeader.y<center(firstDate))))fail("continuation");
      const followingTop=firstDate?Math.max(...edges.filter(y=>y<center(firstDate))):footerCandidate!.top;
      const top=edges.find(y=>y>=75);
      if(top===undefined || ![78.606,78.646].some(y=>near(top,y)) || followingTop<=top ||
        edges.filter(y=>y>top+.02 && y<followingTop-.02).length ||
        ![17.56,89.31,503.31,593.06].every(x=>vertical(p,x,top,followingTop)) ||
        [161.31,305.31,446.627].some(x=>vertical(p,x,top,followingTop)) ||
        !horizontal(p,top) || !horizontal(p,followingTop))fail("continuation");
      const cells=p.cells.filter(c=>c.right>17.56 && c.left<593.06 && c.baselineTop>75 && c.baselineTop-c.height<followingTop);
      if(cells.some(c=>c.left<=89.31 || c.right>503.31 || c.baselineTop-c.height<top-.3 || c.baselineTop>followingTop+.3 ||
        apparentFinancial.test(c.text) || sections.has(clean(c.text)) || normalize(c.text)==="TOTAL" || clean(c.text)==="Expenditure Purpose:"))fail("continuation");
      const strip=Object.freeze({pageNumber:p.pageNumber,top,bottom:followingTop,split:89.31 as const,borders:Object.freeze(p.borders.filter(b=>Math.max(b.y1,b.y2)>=top-.3 && Math.min(b.y1,b.y2)<=followingTop+.3).map(b=>Object.freeze({...b})))});
      privatePurposeContinuations.push(Object.freeze({predecessorPageNumber:pending.pageNumber,predecessorOrdinal:pending.ordinal,pageNumber:deferred.strip.pageNumber,followingPageNumber:p.pageNumber,followingTop,ledgerBottom:deferred.ledgerBottom,followingPrefix:null,strips:Object.freeze([deferred.strip,strip]),cells:Object.freeze([...deferred.cells,...cells.map(c=>Object.freeze({...c,pageNumber:p.pageNumber}))])}));
      cells.forEach(c=>purposeIncomingCells.add(c));continuationRows.add(`${top}:${followingTop}`);deferredPurposeLabel=null;
    }
    function observeMerged(predecessor:MarylandLegacyReturnedContributionOccurrence,
      sourceStrips:readonly {top:number;bottom:number}[],followingTop:number,nextPage:boolean,followingPageNumber=p.pageNumber){
      const labelCells=p.cells.filter(c=>center(c)>sourceStrips[0]!.top && center(c)<sourceStrips[0]!.bottom && c.right>17.56 && c.left<593.06);
      const purpose=purposeLabel(labelCells);
      if((!observeUnknown && !purpose) || predecessor.followingPageIdentityCells || sourceStrips.length!==2 ||
        (nextPage ? ![78.606,78.646].some(y=>near(sourceStrips[0]!.top,y)) : !near(sourceStrips[0]!.top,predecessor.rowBottom)) ||
        !near(sourceStrips[0]!.bottom,sourceStrips[1]!.top) || !near(sourceStrips[1]!.bottom,followingTop))fail("continuation");
      const uncertain=sourceStrips.map((b,i)=>({...b,pageNumber:p.pageNumber,split:(i===0?161.31:89.31) as 89.31|161.31,borders:Object.freeze(p.borders.filter(edge=>Math.max(edge.y1,edge.y2)>=b.top-.3 && Math.min(edge.y1,edge.y2)<=b.bottom+.3).map(edge=>Object.freeze({...edge})))}));
      for(const b of uncertain){
        if(![17.56,b.split,503.31,593.06].every(x=>vertical(p,x,b.top,b.bottom)) ||
          [89.31,161.31,305.31,446.627].filter(x=>x!==b.split).some(x=>vertical(p,x,b.top,b.bottom)) ||
          !horizontal(p,b.top) || !horizontal(p,b.bottom))fail("continuation");
      }
      const cells=p.cells.filter(c=>uncertain.some(b=>center(c)>b.top && center(c)<b.bottom));
      if(purpose && cells.filter(c=>clean(c.text)==="Expenditure Purpose:").length!==1)fail("continuation");
      // split161.31 merges Date/Payment roles: all text remains unresolved.
      // split89.31 has a separate blank Date cell; Amount is always blank.
      if(!cells.length || cells.some(c=>c.left<=17.56 || c.right>503.31 || apparentFinancial.test(c.text) ||
        sections.has(clean(c.text)) || normalize(c.text)==="TOTAL" ||
        !uncertain.some(b=>c.baselineTop-c.height>=b.top-.3 && c.baselineTop<=b.bottom+.3 &&
          (b.split===89.31?c.left>89.31:!(c.left<161.31 && c.right>161.31+.02)))))fail("continuation");
      for(const b of uncertain)continuationRows.add(`${b.top}:${b.bottom}`);
      const event=Object.freeze({predecessorPageNumber:predecessor.pageNumber,predecessorOrdinal:predecessor.ordinal,pageNumber:p.pageNumber,followingPageNumber,followingTop:followingPageNumber===p.pageNumber?followingTop:0,ledgerBottom:edges.at(-1)!,followingPrefix:null,strips:Object.freeze(uncertain.map(b=>Object.freeze({...b}))),cells:Object.freeze(cells.map(c=>Object.freeze({...c,pageNumber:p.pageNumber})))});
      if(purpose){privatePurposeContinuations.push(event);return predecessor;}
      privateUnknownContinuations.push(event);
      return Object.freeze({...predecessor,followingPageIdentityCells:cells.length});
    }
    if (pending) {
      const stop=firstDate ? Math.max(...edges.filter(y=>y<center(firstDate))) : firstHeader?.y ?? footerCandidate?.top ?? 750;
      if(!firstDate && !firstHeader && !footerCandidate && p.cells.some(c=>c.right>161.31 && c.left<305.31 && center(c)>75 && center(c)<750))fail("continuation");
      const strips=edges.slice(0,-1).map((top,i)=>({top,bottom:edges[i+1]!})).filter(b=>b.top>=75 && b.bottom<=stop && [17.56,161.31,305.31].every(x=>vertical(p,x,b.top,b.bottom)));
      const leading=p.cells.filter(c=>!purposeIncomingCells.has(c) && c.right>17.56 && c.left<593.06 && ((((firstDate && (!firstHeader || center(firstDate)<firstHeader.y)) || (!firstDate && !firstHeader && footerCandidate)) && center(c)>75 && center(c)<stop) || (c.right>161.31 && c.left<305.31 && strips.some(b=>center(c)>b.top && center(c)<b.bottom))));
      if(!firstDate && !firstHeader && !footerCandidate && p.borders.some(b=>near(b.x1,b.x2) && [161.31,305.31].some(x=>near(b.x1,x)) && Math.min(b.y1,b.y2)<100) && p.cells.some(c=>c.right>161.31 && c.left<305.31 && center(c)>75 && center(c)<750))fail("continuation");
      // Do not drop or invent continuation text. A printed continuation holds
      // this name-only projection until that layout has independent support.
      if (leading.length && (!firstHeader || center(leading[0]!)<firstHeader.y)) {
        if((!firstDate && !footerCandidate) || (firstDate && firstHeader && firstHeader.y<center(firstDate)))fail("continuation");
        const uncertain=edges.slice(0,-1).map((top,i)=>({top,bottom:edges[i+1]!})).filter(b=>b.top>=75 && b.bottom<=stop);
        pending=observeMerged(pending,uncertain,stop,true);
      }
      privateOccurrences.push(pending);pending=undefined;
    }
    const seen=new Set<string>();
    for (let i=0;i<edges.length-1;i++) {
      const top=edges[i]!,bottom=edges[i+1]!;
      const header=headers.filter(h=>h.y<top).at(-1);
      const returned=header?.returned ?? active;
      const row=p.cells.filter(c=>center(c)>top && center(c)<bottom && c.right>17.56 && c.left<593.06);
      if(afterReturnFooter && header && !header.returned)afterReturnFooter=false;
      if(afterReturnFooter && top>=75 && bottom<=750 && row.length &&
        (columns.every(x=>vertical(p,x,top,bottom)) ||
         (row.some(c=>c.left>503.31 && c.right<=593.06 && apparentFinancial.test(c.text)) && [17.56,503.31,593.06].every(x=>vertical(p,x,top,bottom))) ||
         row.some(c=>c.left>17.56 && c.right<=89.31+.02 && /^\d{2}\/\d{2}\/\d{4}$/.test(clean(c.text)))))fail("control");
      if (!returned || (header && top<header.bottom-1) || top<75 || bottom>750) continue;
      if (!row.length || continuationRows.has(`${top}:${bottom}`)) continue;
      const totals=row.filter(c=>clean(c.text)==="Total" && near(c.left,477.36));
      if(totals.length){
        const footer=exactTotal(top,bottom);
        if(!footer || scheduleTotalCents!==null)fail("control");
        privateScheduleTotal=footer;scheduleTotalCents=footer.amountCents;
        const parsed=privateOccurrences.reduce((n,r)=>add(n,r.amountCents),pending?.amountCents??0);
        if(parsed!==scheduleTotalCents)fail("control");
        if(pending){privateOccurrences.push(pending);pending=undefined;}
        active=false;closed=true;afterReturnFooter=true;
        continue;
      }
      const full=columns.every(x=>vertical(p,x,top,bottom));
      if (!full) {
        if(row.some(c=>apparentFinancial.test(c.text) || (c.right>503.31 && c.left<593.06)))fail("border");
        if(!pending || pending.pageNumber!==p.pageNumber || !near(pending.rowBottom,top))fail("border");
        const followingDate=dates.filter(c=>center(c)>bottom).at(0);
        const nextRowTop=followingDate?Math.max(...edges.filter(y=>y<center(followingDate))):null;
        const followingTop=nextRowTop!==null && (!footerCandidate || nextRowTop<footerCandidate.top)?nextRowTop:footerCandidate?.top ?? edges.at(-1)!;
        const futurePage=nextRowTop===null && !footerCandidate;
        if(followingTop<=top || (futurePage && deferredTailIndex!==null))fail("continuation");
        if(headers.some(h=>h.y>pending!.rowBottom && h.y<followingTop))fail("continuation");
        const uncertain=edges.slice(0,-1).map((top,i)=>({top,bottom:edges[i+1]!})).filter(b=>b.top>=pending!.rowBottom-.02 && b.bottom<=followingTop+.02);
        // Restrict to the contiguous pair beginning at this physical row.
        const pair=uncertain.filter(b=>b.top>=pending!.rowBottom-.02);
        if(pair.length===1 && futurePage && purposeLabel(row)){
          const b=pair[0]!;
          if(![17.56,161.31,503.31,593.06].every(x=>vertical(p,x,b.top,b.bottom)) ||
            [89.31,305.31,446.627].some(x=>vertical(p,x,b.top,b.bottom)) || !horizontal(p,b.top) || !horizontal(p,b.bottom) ||
            row.some(c=>c.baselineTop-c.height<b.top-.3 || c.baselineTop>b.bottom+.3))fail("continuation");
          deferredPurposeLabel=Object.freeze({predecessor:pending,strip:Object.freeze({...b,pageNumber:p.pageNumber,split:161.31 as const,borders:Object.freeze(p.borders.filter(edge=>Math.max(edge.y1,edge.y2)>=b.top-.3 && Math.min(edge.y1,edge.y2)<=b.bottom+.3).map(edge=>Object.freeze({...edge})))}),cells:Object.freeze(row.map(c=>Object.freeze({...c,pageNumber:p.pageNumber}))),ledgerBottom:edges.at(-1)!});
          continuationRows.add(`${b.top}:${b.bottom}`);
        }else{
          const purposesBefore=privatePurposeContinuations.length;
          pending=observeMerged(pending,pair,followingTop,false,futurePage?p.pageNumber+1:p.pageNumber);
          if(futurePage)deferredTailIndex=Object.freeze({purpose:privatePurposeContinuations.length>purposesBefore,index:privatePurposeContinuations.length>purposesBefore?privatePurposeContinuations.length-1:privateUnknownContinuations.length-1});
        }
        continue;
      }
      if(!horizontal(p,top)||!horizontal(p,bottom))fail("border");
      for (const c of row) {
        const col=columns.findIndex((x,j)=>j<columns.length-1 && c.left>x && c.left<columns[j+1]!);
        if (col<0 || c.right>columns[col+1]!+.02 || c.baselineTop-c.height<top-.3 || c.baselineTop>bottom+.3) fail("geometry");
      }
      const ds=row.filter(c=>c.left>17.56 && c.left<89.31), amounts=row.filter(c=>c.left>503.31 && c.left<593.06);
      if (ds.length!==1) fail("date"); if (amounts.length!==1) fail("amount");
      const d=ds[0]!; if (d.right>89.31+.02 || seen.has(`${top}:${bottom}`)) fail("date");seen.add(`${top}:${bottom}`);
      const identity=row.filter(c=>c.left>161.31 && c.left<305.31).sort((a,b)=>Math.abs(a.baselineTop-b.baselineTop)>.8?a.baselineTop-b.baselineTop:a.left-b.left);
      if (!identity.length || identity.some((c,j)=>identity.slice(0,j).some(other=>Math.abs(center(c)-center(other))<Math.min(c.height,other.height)*.5 && c.left<other.right && c.right>other.left))) fail("identity");
      if (pending) privateOccurrences.push(pending);
      pending=Object.freeze({pageNumber:p.pageNumber,ordinal:privateOccurrences.length,rowTop:top,rowBottom:bottom,date:date(clean(d.text)),amountCents:money(clean(amounts[0]!.text)),nameAddress:clean(identity.map(c=>c.text).join(" ")),followingPageIdentityCells:0});
    }
    // Every source date in a return band must belong to a complete parsed row.
    for (const d of dates) { const h=headers.filter(h=>h.y<center(d)).at(-1); if (!(h?.returned??active)) continue;
      const top=Math.max(...edges.filter(y=>y<center(d))),bottom=Math.min(...edges.filter(y=>y>center(d)));
      if (!seen.has(`${top}:${bottom}`)) fail("border"); }
    if (headers.length) { if (active && !headers.at(-1)!.returned) closed=true;active=headers.at(-1)!.returned && !afterReturnFooter; }
    else if (active && !dates.length) {active=false;closed=true;}
  });
  if(deferredTailIndex!==null || deferredPurposeLabel!==null)fail("continuation");
  if (pending) { if (active && !closed) fail("continuation");privateOccurrences.push(pending); }
  if (sectionStarts!==1 || returnedContributionSectionCount!==1 || controlPages.length!==2) fail("header");
  const controls=parseMarylandLegacyFinancialControls({page1:controlPages[0]!,page2:controlPages[1]!});
  const total=privateOccurrences.reduce((n,r)=>add(n,r.amountCents),0);
  const z=controls.expenseControls.filter(c=>c.schedule==="2" && c.column==="Z");
  if (z.length!==1 || z[0]!.amountCents!==total || scheduleTotalCents===null || scheduleTotalCents!==total || privateScheduleTotal===null) fail("control");
  return Object.freeze({sourceFacts:Object.freeze({...geometry,returnCount:privateOccurrences.length,returnCents:total,sectionStarts,returnedContributionSectionCount,unknownContinuationCount:privateUnknownContinuations.length,purposeContinuationCount:privatePurposeContinuations.length,scheduleTotalCents,controls}),privateOccurrences:Object.freeze(privateOccurrences),privateScheduleTotal,privateUnknownContinuations:Object.freeze(privateUnknownContinuations),privatePurposeContinuations:Object.freeze(privatePurposeContinuations)});
}

/** Strict facts require every identity continuation to be classified. */
export function readMarylandLegacyReturnedContributionFacts(bytes: Uint8Array) {
  return readReturnedContributions(bytes,false);
}
/** Retains bounded nonfinancial uncertainty privately. Only complete fiscal
 * cohorts with no eligible original class may be isolated by the comparator. */
export function readMarylandLegacyReturnedContributionObservations(bytes: Uint8Array) {
  return readReturnedContributions(bytes,true);
}

export type MarylandLegacyBoundCommitteeReturn = Readonly<{
  transactionId: number; transactionGuid: string; reportGuid: string; reportVersionId: number;
  nativeReportGuid: string; nativeReportVersionId: number;
  originalTransactionId: number; originalTransactionGuid: string; originalClass: string;
  originalKind: string; documentFamily: "cash_outflow"; refundCents: number;
  pageNumber: number; ordinal: number;
}>;
/** Entire supplied collections and current inventory only. Prior rows provide
 * original-reference/lifetime facts, never invented historical period authority.
 * No legal donor-ID, acquisition-completeness or accepted-money claim follows. */
export type MarylandLegacyReturnComparisonInput={
  reports: readonly MarylandPublishedReport[]; inventoryRequest: MarylandPublicReportInventoryRequest;
  currentRows: readonly Row[]; priorRows: readonly Row[];
  pdfReports: readonly {report: MarylandPublishedReport;facts: MarylandLegacyReturnedContributionFacts}[];
  stateDisplayDictionary?:MarylandSourceStateDisplayDictionary;
};
export type MarylandLegacyReturnCashFamilyReport=Readonly<{
  report:MarylandPublishedReport;pdfSha256:string;pdfByteCount:number;pdfPageCount:number;
  returnCount:number;returnCents:number;documentFamily:"cash_outflow";
}>;
function compareReturnedContributionReports(input:MarylandLegacyReturnComparisonInput,mode:"identity"|"cash_family") {
  const retained=structuredClone(input), request=buildMarylandPublicReportInventoryRequest(retained.inventoryRequest);
  const reports=retained.reports.map(r=>decodeMarylandPublishedReport(r,request));
  const ids=new Set<number>(),guids=new Set<string>();
  function validate(row: Row, current: boolean) {
    const dollars=typeof row.transactionAmount==="number"?parseMarylandCfsMoney(String(row.transactionAmount)):null;
    if (!guid(row.filerRegistrationGuid) || row.filerRegistrationGuid.toLowerCase()!==request.filerRegistrationGuid.toLowerCase() || !positive(row.electionCycleId) || (current && String(row.electionCycleId)!==request.electionCycleId) || !positive(row.transactionId) || !guid(row.transactionGuid) || row.isActive!==true || typeof row.isReturn!=="boolean" || row.transactionTypeCode!==(row.isReturn?"TRCON":"TCON") || !["ANYMS","CMONT","TRFR","OTHRINCM","CINKIND"].includes(row.contributionTypeCode as string) || (row.contributorTypeCode!==null && !allClasses.has(row.contributorTypeCode as string)) || (row.contributorTypeCode===null && row.contributionTypeCode!=="ANYMS") || (row.contributionTypeCode!=="ANYMS" && (typeof row.contributorName!=="string" || !clean(row.contributorName))) || dollars===null || dollars<=0 || !Number.isSafeInteger(Math.round(dollars*100)) || typeof row.transactionDate!=="string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.transactionDate) || !Number.isFinite(Date.parse(`${row.transactionDate}Z`)) || new Date(`${row.transactionDate}Z`).toISOString().slice(0,19)!==row.transactionDate || (row.isReturn && (!positive(row.parentTransactionId) || (row.parentTransactionGuid!==null && !guid(row.parentTransactionGuid))))) fail("invalid_native");
    if (ids.has(row.transactionId) || guids.has(row.transactionGuid.toLowerCase())) fail("duplicate");
    ids.add(row.transactionId);guids.add(row.transactionGuid.toLowerCase());return {row,cents:Math.round(dollars*100)};
  }
  const current=retained.currentRows.map(r=>validate(r,true)),prior=retained.priorRows.map(r=>validate(r,false));
  const originals=new Map([...current,...prior].filter(r=>!r.row.isReturn).map(r=>[r.row.transactionId,r]));
  const currentParentIds=new Set(current.filter(r=>r.row.isReturn).map(r=>r.row.parentTransactionId));
  const totals=new Map<unknown,number>();
  for (const refund of [...prior,...current]) if (refund.row.isReturn && currentParentIds.has(refund.row.parentTransactionId)) {
    const parent=originals.get(refund.row.parentTransactionId);if (!parent || typeof parent.row.contributorTypeCode!=="string" || !allClasses.has(parent.row.contributorTypeCode) || typeof parent.row.contributorName!=="string" || typeof refund.row.contributorName!=="string" || !clean(parent.row.contributorName) || !clean(refund.row.contributorName)) fail("parent");
    if ((refund.row.parentTransactionGuid!==null && (refund.row.parentTransactionGuid as string).toLowerCase()!==(parent.row.transactionGuid as string).toLowerCase()) || normalize(refund.row.contributorName as string)!==normalize(parent.row.contributorName as string) || (refund.row.transactionDate as string)<(parent.row.transactionDate as string)) fail("parent");
    const total=add(totals.get(parent.row.transactionId)??0,refund.cents);totals.set(parent.row.transactionId,total);
    if (committeeClasses.has(parent.row.contributorTypeCode as string) && total>parent.cents) fail("over_refund");
  }
  const bound=bindMarylandNativeReportOccurrences({reports,request,nativeRows:retained.currentRows});
  const pdfKeys=new Set<string>(),privateBoundReturns: MarylandLegacyBoundCommitteeReturn[]=[],privateReportCashFamilies:MarylandLegacyReturnCashFamilyReport[]=[];
  let nativeReturns=0,pdfReturns=0,returnCents=0,eligibleReturns=0,eligibleReturnCents=0,noneligibleUnknownIdentityOccurrences=0;
  for (const {report:raw,facts} of retained.pdfReports) {
    const report=decodeMarylandPublishedReport(raw,request),key=`${report.reportGuid.toLowerCase()}:${report.reportVersionId}`;
    const bucket=bound.reports.find(b=>b.report.reportGuid.toLowerCase()===report.reportGuid.toLowerCase() && b.report.reportVersionId===report.reportVersionId);
    if (!bucket || JSON.stringify(bucket.report)!==JSON.stringify(report) || pdfKeys.has(key)) fail("report");pdfKeys.add(key);
    const rows=bucket.rows.filter(r=>r.isReturn), actual=facts.privateOccurrences;
    if (!facts.sourceFacts || !/^[0-9a-f]{64}$/.test(facts.sourceFacts.sha256) || !positive(facts.sourceFacts.byteCount) || !positive(facts.sourceFacts.pageCount) || facts.sourceFacts.sectionStarts!==1 || facts.sourceFacts.returnedContributionSectionCount!==1 || facts.sourceFacts.returnCount!==actual.length || facts.sourceFacts.returnCents!==actual.reduce((n,r)=>add(n,r.amountCents),0) || facts.sourceFacts.controls.expenseControls.filter(c=>c.column==="Z" && c.schedule==="2" && c.amountCents===facts.sourceFacts.returnCents).length!==1 || !facts.sourceFacts.controls.equations.cashBalance || !facts.sourceFacts.controls.equations.expensesSum) fail("control");
    const footer=facts.privateScheduleTotal;
    if(footer===null || facts.sourceFacts.scheduleTotalCents===null)fail("control");
    if(!positive(footer.pageNumber) || footer.pageNumber>facts.sourceFacts.pageCount || !Number.isFinite(footer.top) || !Number.isFinite(footer.bottom) || footer.top>=footer.bottom || footer.amountCents!==facts.sourceFacts.scheduleTotalCents || footer.amountCents!==facts.sourceFacts.returnCents)fail("control");
    if(facts.sourceFacts.scheduleTotalCents!==null && facts.sourceFacts.scheduleTotalCents!==facts.sourceFacts.returnCents)fail("control");
    const control=facts.sourceFacts.controls, cash=control.cashSummary;
    if (!Array.isArray(control.receiptControls) || !Array.isArray(control.expenseControls) ||
      !Object.values(cash).every(Number.isSafeInteger) ||
      control.receiptControls.some(c=>!Number.isSafeInteger(c.amountCents)) ||
      control.expenseControls.some(c=>!Number.isSafeInteger(c.amountCents)) ||
      control.receiptControls.reduce((n,c)=>add(n,c.amountCents),0)!==cash.totalReceiptsCents ||
      control.expenseControls.reduce((n,c)=>add(n,c.amountCents),0)!==cash.totalExpendituresCents ||
      add(add(cash.priorBalanceCents,cash.totalReceiptsCents),-cash.totalExpendituresCents)!==cash.cashBalanceCents) fail("control");
    if (rows.length!==actual.length) fail("comparison");
    const expectedDates=new Map<string,number>(),actualDates=new Map<string,number>(),physical=new Set<string>();
    const dk=(day: string,cents: number)=>JSON.stringify([day,cents]);
    for (const r of rows) { const k=dk((r.transactionDate as string).slice(0,10),Math.round((r.transactionAmount as number)*100));expectedDates.set(k,(expectedDates.get(k)??0)+1); }
    for (const p of actual) {
      if (!positive(p.pageNumber) || p.pageNumber>facts.sourceFacts.pageCount || !Number.isSafeInteger(p.ordinal) || p.ordinal<0 || !positive(p.amountCents) || !Number.isFinite(p.rowTop) || !Number.isFinite(p.rowBottom) || p.rowTop<75 || p.rowBottom>750 || p.rowTop>=p.rowBottom || typeof p.nameAddress!=="string" || !clean(p.nameAddress) || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isSafeInteger(p.followingPageIdentityCells) || p.followingPageIdentityCells<0 || physical.has(`${p.pageNumber}:${p.ordinal}`)) fail("comparison");
      const preceding=actual[p.ordinal-1];
      if(p.ordinal!==physical.size || (preceding && (p.pageNumber<preceding.pageNumber || (p.pageNumber===preceding.pageNumber && p.rowTop<preceding.rowBottom-.02))))fail("comparison");
      physical.add(`${p.pageNumber}:${p.ordinal}`);const k=dk(p.date,p.amountCents);actualDates.set(k,(actualDates.get(k)??0)+1);
    }
    if (expectedDates.size!==actualDates.size || [...expectedDates].some(([k,n])=>actualDates.get(k)!==n)) fail("comparison");
    if(!Array.isArray(facts.privateUnknownContinuations) || facts.sourceFacts.unknownContinuationCount!==facts.privateUnknownContinuations.length || !Array.isArray(facts.privatePurposeContinuations) || facts.sourceFacts.purposeContinuationCount!==facts.privatePurposeContinuations.length)fail("continuation");
    if(mode==="cash_family"&&facts.privateUnknownContinuations.length!==0)fail("continuation");
    const isolatedFiscalCohorts=new Set<string>(),uncertainPhysical=new Set<string>();
    const continuedPhysical=new Set<string>();
    for(const {unknown,purpose} of [...facts.privateUnknownContinuations.map((unknown:Continuation)=>({unknown,purpose:false})),...facts.privatePurposeContinuations.map((unknown:Continuation)=>({unknown,purpose:true}))]){
      const physicalKey=`${unknown.predecessorPageNumber}:${unknown.predecessorOrdinal}`;
      const predecessor=actual.filter(p=>p.pageNumber===unknown.predecessorPageNumber && p.ordinal===unknown.predecessorOrdinal);
      if(predecessor.length!==1 || continuedPhysical.has(physicalKey) || (unknown.pageNumber!==unknown.predecessorPageNumber && unknown.pageNumber!==unknown.predecessorPageNumber+1) || unknown.pageNumber>facts.sourceFacts.pageCount || ![unknown.pageNumber,unknown.pageNumber+1].includes(unknown.followingPageNumber) || unknown.followingPageNumber>facts.sourceFacts.pageCount || !Number.isFinite(unknown.followingTop) || !Number.isFinite(unknown.ledgerBottom) || !Array.isArray(unknown.strips) || unknown.strips.length!==2 || !Array.isArray(unknown.cells) || !unknown.cells.length || (purpose?predecessor[0]!.followingPageIdentityCells!==0:predecessor[0]!.followingPageIdentityCells!==unknown.cells.length))fail("continuation");
      continuedPhysical.add(physicalKey);if(!purpose)uncertainPhysical.add(physicalKey);
      const samePage=unknown.pageNumber===unknown.predecessorPageNumber;
      if(!samePage && actual.some(p=>p.pageNumber===unknown.predecessorPageNumber && p.rowTop>predecessor[0]!.rowTop))fail("continuation");
      const splitPage=unknown.strips[1]?.pageNumber!==unknown.pageNumber;
      if(splitPage && (!purpose || unknown.strips[1]?.pageNumber!==unknown.pageNumber+1 || !samePage || actual.some(p=>p.pageNumber===unknown.pageNumber && p.rowTop>predecessor[0]!.rowTop)))fail("continuation");
      const futurePage=unknown.followingPageNumber!==(unknown.strips[1]?.pageNumber??unknown.pageNumber);
      if(futurePage && (!samePage || actual.some(p=>p.pageNumber===unknown.pageNumber && p.rowTop>predecessor[0]!.rowTop)))fail("continuation");
      const following=actual.filter(p=>p.pageNumber===unknown.followingPageNumber && (p.pageNumber!==predecessor[0]!.pageNumber || p.rowTop>predecessor[0]!.rowTop)).sort((a,b)=>a.rowTop-b.rowTop)[0];
      const followingTop=following?.rowTop ?? (footer?.pageNumber===unknown.followingPageNumber?footer.top:undefined);
      if(followingTop!==unknown.followingTop)fail("continuation");
      if(futurePage){
        const prefix=unknown.followingPrefix;
        if(!prefix || ![78.606,78.646].some(y=>near(prefix.top,y)) || prefix.bottom!==followingTop ||
          !Array.isArray(prefix.cells) || prefix.cells.length || !Array.isArray(prefix.borders) ||
          prefix.borders.some((b:MarylandPdfBorder)=>!Object.values(b).every(Number.isFinite)))fail("continuation");
        const prefixPage={pageNumber:unknown.followingPageNumber,width:612,height:792,cells:prefix.cells,borders:prefix.borders};
        if(prefix.bottom>prefix.top+.02 && (!horizontal(prefixPage,prefix.top) || !horizontal(prefixPage,prefix.bottom) ||
          ![17.56,593.06].every(x=>vertical(prefixPage,x,prefix.top,prefix.bottom))))fail("continuation");
      }else if(unknown.followingPrefix!==null)fail("continuation");
      if(followingTop===undefined || !Array.isArray(unknown.strips) || unknown.strips.length!==2 || (samePage?!near(unknown.strips[0]!.top,predecessor[0]!.rowBottom):![78.606,78.646].some(y=>near(unknown.strips[0]!.top,y))) ||
        !near(unknown.strips[1]!.bottom,futurePage?unknown.ledgerBottom:followingTop) ||
        unknown.strips.some((b:ContinuationStrip,j:number)=>b.split!==(j===0?161.31:89.31) || !Number.isFinite(b.top) || !Number.isFinite(b.bottom) || ![89.31,161.31].includes(b.split) || b.top>=b.bottom || b.top<75 || b.bottom>750 ||
          b.pageNumber!==(j===1 && splitPage?unknown.pageNumber+1:unknown.pageNumber) ||
          (j>0 && (splitPage?![78.606,78.646].some(y=>near(b.top,y)):!near(b.top,unknown.strips[j-1]!.bottom))) ||
          !Array.isArray(b.borders) || b.borders.some((edge:MarylandPdfBorder)=>!Object.values(edge).every(Number.isFinite))))fail("continuation");
      if(splitPage && !near(unknown.strips[0]!.bottom,unknown.ledgerBottom))fail("continuation");
      for(const strip of unknown.strips){const page={pageNumber:strip.pageNumber,width:612,height:792,cells:[],borders:strip.borders};
        if(!horizontal(page,strip.top) || !horizontal(page,strip.bottom) || ![17.56,strip.split,503.31,593.06].every(x=>vertical(page,x,strip.top,strip.bottom)) ||
          [89.31,161.31,305.31,446.627].filter(x=>x!==strip.split).some(x=>vertical(page,x,strip.top,strip.bottom)))fail("continuation");}
      if(purpose && (unknown.cells.filter((c:SourceCell)=>clean(c.text)==="Expenditure Purpose:").length!==1 || !purposeLabel(unknown.cells.filter((c:SourceCell)=>c.pageNumber===unknown.strips[0]!.pageNumber && center(c)>unknown.strips[0]!.top && center(c)<unknown.strips[0]!.bottom))))fail("continuation");
      const physicalCells=new Set<string>();
      for(const cell of unknown.cells){
        const key=JSON.stringify([cell.pageNumber,cell.left,cell.right,cell.baselineTop,cell.height]);
        if(typeof cell.text!=="string" || !clean(cell.text) || ![cell.left,cell.right,cell.baselineTop,cell.height].every(Number.isFinite) || cell.height<=0 || cell.right<=cell.left || cell.left<=17.56 || cell.right>503.31 || !unknown.strips.some((b:ContinuationStrip)=>cell.pageNumber===b.pageNumber && cell.baselineTop-cell.height>=b.top-.3 && cell.baselineTop<=b.bottom+.3 && (b.split===89.31?cell.left>89.31:!(cell.left<161.31 && cell.right>161.31+.02))) || apparentFinancial.test(cell.text) || physicalCells.has(key))fail("continuation");
        if(unknown.cells.some((other:MarylandPdfCell)=>other!==cell && (other as SourceCell).pageNumber===cell.pageNumber && Math.abs(center(other)-center(cell))<Math.min(other.height,cell.height)*.5 && other.left<cell.right && other.right>cell.left))fail("continuation");
        physicalCells.add(key);
      }
      if(purpose)continue;
      const cohortKey=dk(predecessor[0]!.date,predecessor[0]!.amountCents);
      const fiscalCohort=rows.filter(r=>dk((r.transactionDate as string).slice(0,10),Math.round((r.transactionAmount as number)*100))===cohortKey);
      if(!fiscalCohort.length)fail("comparison");
      for(const row of fiscalCohort){const original=originals.get(row.parentTransactionId);if(!original || typeof original.row.contributorTypeCode!=="string" || !allClasses.has(original.row.contributorTypeCode) || committeeClasses.has(original.row.contributorTypeCode))fail("continuation");}
      isolatedFiscalCohorts.add(cohortKey);
    }
    for(const p of actual)if((p.followingPageIdentityCells>0)!==uncertainPhysical.has(`${p.pageNumber}:${p.ordinal}`))fail("continuation");
    if(mode==="cash_family"){
      privateReportCashFamilies.push(Object.freeze({report,pdfSha256:facts.sourceFacts.sha256,pdfByteCount:facts.sourceFacts.byteCount,pdfPageCount:facts.sourceFacts.pageCount,returnCount:actual.length,returnCents:facts.sourceFacts.returnCents,documentFamily:"cash_outflow"}));
      nativeReturns+=rows.length;pdfReturns+=actual.length;returnCents=add(returnCents,facts.sourceFacts.returnCents);
      continue;
    }
    // A painted source cell can have an unresolved native identity/address
    // boundary. Keep the entire fiscal cohort identity-held only if every
    // original class is explicitly noneligible; no prefix-only match is used.
    for(const p of actual){
      const key=dk(p.date,p.amountCents);
      if(isolatedFiscalCohorts.has(key))continue;
      const identity=normalize(p.nameAddress);
      const fiscal=rows.filter(r=>dk((r.transactionDate as string).slice(0,10),Math.round((r.transactionAmount as number)*100))===key);
      // A name multiset cannot prove capacity among repeated native names
      // with different contacts. Only a wholly noneligible cohort may be held
      // without qualifying those identities; mixed eligible cohorts stop.
      if(new Set(fiscal.map(r=>normalize(r.contributorName as string))).size!==fiscal.length){
        for(const r of fiscal){const original=originals.get(r.parentTransactionId);if(!original || typeof original.row.contributorTypeCode!=="string" || !allClasses.has(original.row.contributorTypeCode) || committeeClasses.has(original.row.contributorTypeCode))fail("identity");}
        isolatedFiscalCohorts.add(key);continue;
      }
      const names=new Set(fiscal.filter(r=>{
        return exactPrintedContact(identity,r,retained.stateDisplayDictionary);
      }).map(r=>normalize(r.contributorName as string)));
      if(names.size===1)continue;
      for(const r of fiscal){const original=originals.get(r.parentTransactionId);if(!original || typeof original.row.contributorTypeCode!=="string" || !allClasses.has(original.row.contributorTypeCode) || committeeClasses.has(original.row.contributorTypeCode))fail("identity");}
      isolatedFiscalCohorts.add(key);
    }
    noneligibleUnknownIdentityOccurrences+=rows.filter(r=>isolatedFiscalCohorts.has(dk((r.transactionDate as string).slice(0,10),Math.round((r.transactionAmount as number)*100)))).length;
    const expectedNames=new Map<string,number>(),actualNames=new Map<string,number>();
    const nk=(day:string,cents:number,name:string)=>JSON.stringify([day,cents,name]);
    for (const r of rows) {if(isolatedFiscalCohorts.has(dk((r.transactionDate as string).slice(0,10),Math.round((r.transactionAmount as number)*100))))continue;const k=nk((r.transactionDate as string).slice(0,10),Math.round((r.transactionAmount as number)*100),normalize(r.contributorName as string));expectedNames.set(k,(expectedNames.get(k)??0)+1);}
    for (const p of actual) {
      if(isolatedFiscalCohorts.has(dk(p.date,p.amountCents)))continue;
      const identity=normalize(p.nameAddress);
      const candidates=rows.filter(r=>{
        return (r.transactionDate as string).slice(0,10)===p.date && Math.round((r.transactionAmount as number)*100)===p.amountCents && exactPrintedContact(identity,r,retained.stateDisplayDictionary);
      });
      const names=new Set(candidates.map(r=>normalize(r.contributorName as string)));if(names.size!==1)fail("identity");
      const k=nk(p.date,p.amountCents,[...names][0]!);actualNames.set(k,(actualNames.get(k)??0)+1);
    }
    if(expectedNames.size!==actualNames.size || [...expectedNames].some(([k,n])=>actualNames.get(k)!==n))fail("identity");
    for (const r of rows) {
      const parent=originals.get(r.parentTransactionId);if (!parent) fail("parent");
      if (!committeeClasses.has(parent.row.contributorTypeCode as string)) continue;
      const cents=Math.round((r.transactionAmount as number)*100),name=normalize(r.contributorName as string);
      const nativeCohort=rows.filter(q=>(q.transactionDate as string)===(r.transactionDate as string) && Math.round((q.transactionAmount as number)*100)===cents && normalize(q.contributorName as string)===name);
      const candidates=actual.filter(p=>p.date===(r.transactionDate as string).slice(0,10) && p.amountCents===cents && exactPrintedContact(normalize(p.nameAddress),r,retained.stateDisplayDictionary));
      if (nativeCohort.length!==1 || candidates.length!==1) fail("identity");
      const p=candidates[0]!;
      privateBoundReturns.push(Object.freeze({transactionId:r.transactionId as number,transactionGuid:r.transactionGuid as string,reportGuid:report.reportGuid,reportVersionId:report.reportVersionId,nativeReportGuid:r.reportGuid as string,nativeReportVersionId:r.reportVersionId as number,originalTransactionId:parent.row.transactionId as number,originalTransactionGuid:parent.row.transactionGuid as string,originalClass:parent.row.contributorTypeCode as string,originalKind:parent.row.contributionTypeCode as string,documentFamily:"cash_outflow",refundCents:cents,pageNumber:p.pageNumber,ordinal:p.ordinal}));eligibleReturns++;eligibleReturnCents=add(eligibleReturnCents,cents);
    }
    nativeReturns+=rows.length;pdfReturns+=actual.length;returnCents=add(returnCents,facts.sourceFacts.returnCents);
  }
  // A supplied legacy document is a complete report component; callers cannot
  // omit one of its native returns or select an eligible subset of its rows.
  return Object.freeze({sourceFacts:Object.freeze({reportsCompared:pdfKeys.size,nativeReturns,pdfReturns,returnCents,eligibleReturns,eligibleReturnCents,noneligibleUnknownIdentityOccurrences}),privateBoundReturns:Object.freeze(privateBoundReturns),privateReportCashFamilies:Object.freeze(privateReportCashFamilies)});
}

/** Strict complete-contact occurrence correspondence, kept separate from the
 * universal report cash-family fact. */
export function compareMarylandLegacyCommitteeReturnOccurrences(input:MarylandLegacyReturnComparisonInput){
  const {sourceFacts,privateBoundReturns}=compareReturnedContributionReports(input,"identity");
  return Object.freeze({sourceFacts,privateBoundReturns});
}

/** Every physical Z row and every bound native TRCON in each supplied report
 * closes by complete day/cents multiplicity, Total and cash controls. This
 * proves a universal report family; it makes no per-transaction PDF identity,
 * contact or page/ordinal claim. The normal packet must recompute from its
 * same immutable complete sources; these plain facts grant no authority. */
export function proveMarylandLegacyReturnCashFamilies(input:MarylandLegacyReturnComparisonInput){
  const compared=compareReturnedContributionReports(input,"cash_family");
  const {reportsCompared,nativeReturns,pdfReturns,returnCents}=compared.sourceFacts;
  return Object.freeze({sourceFacts:Object.freeze({reportsCompared,nativeReturns,pdfReturns,returnCents,documentFamily:"cash_outflow" as const}),reports:compared.privateReportCashFamilies});
}
