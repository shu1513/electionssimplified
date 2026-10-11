import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTennesseeVerifiedFinanceLoader, type TennesseeVerifiedFinanceLoaderOptions,
  type TennesseeVerifiedFinanceRawEvent } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedFinanceLoader.js";
import type { TennesseeFinanceLinkInput } from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceWriter.js";
import type { TennesseeVerifiedDirectEvidence } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedDirectEvidence.js";
import type { TennesseeCurrentReportManifest, TennesseeCurrentReportManifestRow } from "../../../src/pipeline/tennesseeFinance/tennesseeCurrentReportClient.js";
import type { TennesseeNativeResult, TennesseeVerifiedNativeIndependentExpenditureRow,
  TennesseeVerifiedNativePacRegistryRow, TennesseeVerifiedNativeCandidateRow } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedNativeClient.js";

// Synthetic acquisition fixtures exercise the orchestration contract; real
// completeness and monetary policy remain in the independently tested verifiers.
const hash=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const H=hash("synthetic");
const url=(id:string)=>"https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId="+id;
function native<T>(rows:T[],query:Record<string,string>):TennesseeNativeResult<T> {
  return {rows,query,complete:true,declaredCount:rows.length,
    fingerprint:hash(JSON.stringify(rows.map(r=>JSON.stringify(r)).sort())),
    sourceUrl:"https://apps.tn.gov/tncamp/public/cesearch.htm",requests:[],chunks:[]};
}
const link:TennesseeFinanceLinkInput={candidateId:"local-candidate",electionId:"local-election",electionYear:2026,
  candidateNameNormalized:"JANE DOE",officeName:"State Senator",district:"3",campCandidateId:"794",ownerName:"DOE, JANE",linkStatus:"active"};
function row(id:string,reportName:string,campId="794"):TennesseeCurrentReportManifestRow {
  return {campId,ownerName:campId==="794"?link.ownerName:"Synthetic payer",reportId:id,
    reportName,reportYear:Number(reportName.slice(-4)),electionYear:campId==="794"?2026:null,
    submittedDate:"2026-07-29",amended:false,sourceUrl:url(id)};
}
function manifest(rows:TennesseeCurrentReportManifestRow[]):TennesseeCurrentReportManifest {
  return {rows,fingerprint:hash(JSON.stringify(rows)),rawPages:[{url:"https://apps.tn.gov/tncamp/public/replist.htm",
    bytes:new Uint8Array(),byteCount:0,sha256:H,encoding:"utf-8"}]};
}
function directEvidence(gross:number|undefined=30000):TennesseeVerifiedDirectEvidence {
  return {itemizedCashCents:12345,...(gross!==undefined?{grossCashRaisedCents:gross}:{}),
    cashReceipts:[],directBreakdowns:[],coverage:{windowStart:"2025-01-01",windowEnd:"2026-12-31",
      publishedThrough:"2026-07-27",reportIds:["128008"],sourceUrl:url("128008")}};
}
function harness() {
  const state={
    ieEmpty:false,failIE:false,failRegistry:false,failCandidateReport:false,closePayerChanged:false,
    currentPayerId:"128190",removeCandidatePredecessor:false,duplicatePredecessor:false,failPayerManifest:false,
    staleNative:false,nativePayerAmbiguous:false,closeContextChanged:false,wrongSourceName:false,sourceOwnerWhitespace:false,
  };
  const events:TennesseeVerifiedFinanceRawEvent[]=[];
  const actions:string[]=[];
  const searchQueries:{scope:"context"|"cash";name:string}[]=[];
  const manifestQueries:{campId:string;ownerName:string}[]=[];
  const queryCounts=new Map<string,number>();
  const sourceBytes=new Uint8Array([1,2,3]);
  const candidateRows=[
    row("115084","Early Mid Year Supplemental 2024"),row("120784","Early Year End Supplemental 2024"),
    row("122149","Early Mid Year Supplemental 2025"),row("123786","Early Year End Supplemental 2025"),
    row("125419","1st Quarter 2026"),row("126857","2nd Quarter 2026"),row("128008","Pre-Primary 2026"),
  ];
  const pacRow:TennesseeVerifiedNativePacRegistryRow={campId:"136",name:"Synthetic payer",ownerName:"Synthetic payer",
    committeeType:"PAC",committeeAffiliation:"",created:null,closed:null,
    reportListUrl:"https://apps.tn.gov/tncamp/public/replist.htm?id=136&owner=Synthetic+payer",rawFields:{}};
  const candidate:TennesseeVerifiedNativeCandidateRow={campId:"794",name:link.ownerName,ownerName:link.ownerName,
    officeSought:"Senate",district:"03",electionYear:2026,committeeAffiliation:"",created:null,closed:null,
    reportListUrl:"https://apps.tn.gov/tncamp/public/replist.htm?id=794&owner=DOE%2C+JANE",rawFields:{}};
  const ieRow=():TennesseeVerifiedNativeIndependentExpenditureRow=>({occurrence:0,reportId:state.currentPayerId,
    reportUrl:url(state.currentPayerId),type:"Independent",adjustment:"N",amountCents:591062,date:"2026-07-27",
    electionYear:null,reportName:"Pre-Primary",payerName:pacRow.name,vendorName:"Vendor",
    vendorAddress:"100 MAIN ST, NASHVILLE, TN, 37201",vendorAddressLines:["100 MAIN ST","NASHVILLE, TN, 37201"],
    purpose:"CONTRIBUTION",targetName:link.ownerName,supportOpposeCode:"S",rawFields:{}});
  async function emit(callback:((raw:any)=>void|Promise<void>)|undefined,action:string,sourceUrl:string) {
    actions.push(action);queryCounts.set(action,(queryCounts.get(action)??0)+1);
    await callback?.({url:sourceUrl,method:"GET",fetchedAt:"2026-10-11T00:00:00Z",
      bytes:sourceBytes,byteCount:sourceBytes.length,sha256:hash(sourceBytes),encoding:"utf-8"});
  }
  const verifyDirect=vi.fn((_input:Parameters<NonNullable<TennesseeVerifiedFinanceLoaderOptions["verifyDirect"]>>[0])=>{
    actions.push("verify-direct");return {evidence:directEvidence(),diagnostics:[]};
  });
  const options:TennesseeVerifiedFinanceLoaderOptions={
    onRawResponse:event=>{events.push(event);},
    verifyDirect,
    createNativeClient:o=>({
      fetchPacRegistry:async()=>{
        await emit(o.onRawResponse,"registry","https://apps.tn.gov/tncamp/public/search.htm");
        if(state.failRegistry)throw Error("registry unavailable");
        const sourcePac={...pacRow,ownerName:state.sourceOwnerWhitespace?pacRow.ownerName+" ":pacRow.ownerName};
        return native(state.nativePayerAmbiguous?[sourcePac,{...sourcePac,campId:"137"}]:[sourcePac],{searchType:"pac"});
      },
      fetchIndependentExpenditures:async({reportYear})=>{
        await emit(o.onRawResponse,"ie-"+reportYear,"https://apps.tn.gov/tncamp/public/cesearch.htm");
        if(state.failIE)throw Error("IE unavailable");
        const rows=reportYear===2026&&!state.ieEmpty?[ieRow()]:[];
        if(reportYear===2026&&state.staleNative)rows.push({...ieRow(),reportId:"128191",reportUrl:url("128191"),occurrence:1});
        return native(rows,{typeOf:"independent",yearSelection:String(reportYear)});
      },
      fetchCandidateContext:async({name,electionYear})=>{
        searchQueries.push({scope:"context",name});
        await emit(o.onRawResponse,"context","https://apps.tn.gov/tncamp/public/search.htm");
        const r={...candidate};
        if(state.sourceOwnerWhitespace)r.ownerName+=" ";
        if(state.wrongSourceName){r.name=r.ownerName="DOE, JANET";}
        if(state.closeContextChanged&&(queryCounts.get("context")??0)%2===0)r.committeeAffiliation="changed";
        return native([r],{searchType:"candidate",electionYearSelection:String(electionYear)});
      },
      fetchContributions:async({receiverName,reportYear,donorScope,electionYear,recipientType})=>{
        searchQueries.push({scope:"cash",name:receiverName});
        await emit(o.onRawResponse,"cash-"+donorScope+"-"+reportYear,"https://apps.tn.gov/tncamp/public/cesearch.htm");
        return native([],{searchType:"contributions",toType:recipientType,recipientName:receiverName,
          yearSelection:String(reportYear),typeOf:"all",electionYearSelection:String(electionYear),fromPAC:"true",
          ...(donorScope==="all"?{fromCandidate:"true",fromIndividual:"true",fromOrganization:"true"}:{})});
      },
    }),
    createReportClient:o=>({
      fetchManifest:async({campId,ownerName})=>{
        manifestQueries.push({campId,ownerName});
        if(ownerName!==ownerName.trim())throw Error("Tennessee owner name required");
        await emit(o.onRawResponse,"manifest-"+campId,"https://apps.tn.gov/tncamp/public/replist.htm");
        if(campId==="136"&&state.failPayerManifest)throw Error("payer manifest unavailable");
        let rows=campId==="794"?structuredClone(candidateRows):[row("126431","2nd Quarter 2026","136"),row(state.currentPayerId,"Pre-Primary 2026","136")];
        if(campId==="794"&&state.removeCandidatePredecessor)rows=rows.filter(r=>r.reportId!=="115084");
        if(campId==="794"&&state.duplicatePredecessor)rows.push({...rows[0],reportId:"115085"});
        return manifest(rows);
      },
      fetchReport:async({manifestRow,expectedPeriod})=>{
        await emit(o.onRawResponse,"report-"+manifestRow.reportId,manifestRow.sourceUrl);
        if(state.failCandidateReport&&manifestRow.campId==="794")throw Error("candidate report unavailable");
        return {manifestRow,heading:"Synthetic full report",reportedOwnerName:manifestRow.ownerName,
          period:expectedPeriod??null,covers:[],schedules:[],cashLedger:[],
          expenseLedger:manifestRow.campId==="136"&&!state.ieEmpty?[{
            occurrence:1,vendorName:"Vendor",publishedIdentityLines:["Vendor","100 MAIN ST","NASHVILLE, TN, 37201"],
            sourceClass:"" as const,purpose:"CONTRIBUTION",inKind:null,independentTargetName:link.ownerName,
            supportOppose:"S" as const,date:"2026-07-27",amountCents:591062,rawCells:[],
          }]:[],
          rawSource:{url:manifestRow.sourceUrl,bytes:new Uint8Array(),byteCount:0,sha256:H,encoding:"utf-8" as const},
          fingerprint:state.closePayerChanged&&manifestRow.campId==="136"&&(queryCounts.get("report-"+manifestRow.reportId)??0)%2===0?hash("changed"):H,
          completeFullReport:true,
        };
      },
    }),
  };
  return {state,events,actions,queryCounts,sourceBytes,options,verifyDirect,candidateRows,searchQueries,manifestQueries};
}

describe("Tennessee verified source preparation",()=>{
  it("closes both full report rounds and fresh globals before returning immutable writer components",async()=>{
    const h=harness(),loader=createTennesseeVerifiedFinanceLoader(h.options);
    const [result]=await loader.loadBatch([{link}]);
    expect(result.summary).toMatchObject({directContributionTotal:123.45,totalReceipts:300});
    expect(result.outsideReportEvidence?.verifiedReports[0]).toMatchObject({payerCampId:"136",reportId:"128190",occurrences:[{amountCents:591062}]});
    expect(h.actions.at(-1)).toBe("verify-direct");
    const firstAfter=h.events.findIndex(e=>e.phase==="after");
    expect(h.events.slice(firstAfter).every(e=>e.phase==="after")).toBe(true);
    expect(h.events.at(-1)).toMatchObject({phase:"after",scope:"registry"});
    expect(h.queryCounts.get("registry")).toBe(2);
    expect(h.queryCounts.get("manifest-794")).toBe(2);
    expect(h.queryCounts.get("manifest-136")).toBe(2);
    for(const y of [2024,2025,2026])expect(h.queryCounts.get("ie-"+y)).toBe(2);
    expect(h.queryCounts.get("report-115084")).toBeUndefined();
    expect(h.verifyDirect.mock.calls[0][0].before.reports).toHaveLength(6);
    expect(h.verifyDirect.mock.calls[0][0].before.reports[0].period).toMatchObject({start:"2024-07-01",end:"2025-01-15"});
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.link)).toBe(true);
    expect(Object.isFrozen(result.outsideReportEvidence?.verifiedReports[0].occurrences)).toBe(true);
    expect(Object.isFrozen(link)).toBe(false);
  });
  it("trims only request owner copies after ownership checks, retaining raw candidate/PAC source metadata",async()=>{
    const h=harness();h.state.sourceOwnerWhitespace=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary).toBeDefined();expect(r.outsideReportEvidence).toBeDefined();
    expect(h.manifestQueries.filter(q=>q.campId==="794")).toEqual([
      {campId:"794",ownerName:"DOE, JANE"},{campId:"794",ownerName:"DOE, JANE"},
    ]);
    expect(h.manifestQueries.filter(q=>q.campId==="136")).toEqual([
      {campId:"136",ownerName:"Synthetic payer"},{campId:"136",ownerName:"Synthetic payer"},
    ]);
    const input=h.verifyDirect.mock.calls[0][0];
    expect(input.candidateContextBefore.rows[0].ownerName).toBe("DOE, JANE ");
    expect(input.candidateContextAfter.rows[0].ownerName).toBe("DOE, JANE ");
    expect(input.before.registry.rows[0].ownerName).toBe("Synthetic payer ");
    expect(input.after.registry.rows[0].ownerName).toBe("Synthetic payer ");
    expect(input.candidateContextBefore.fingerprint).toBe(hash(JSON.stringify(input.candidateContextBefore.rows.map(r=>JSON.stringify(r)).sort())));
    expect(input.before.registry.fingerprint).toBe(hash(JSON.stringify(input.before.registry.rows.map(r=>JSON.stringify(r)).sort())));
  });
  it("uses only the deterministic source-owner search token in both fresh rounds",async()=>{
    const h=harness();
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary).toBeDefined();
    expect(h.searchQueries.filter(q=>q.scope==="context")).toEqual([
      {scope:"context",name:"DOE"},{scope:"context",name:"DOE"},
    ]);
    expect(h.searchQueries.filter(q=>q.scope==="cash")).toHaveLength(12);
    expect(h.searchQueries.filter(q=>q.scope==="cash").every(q=>q.name==="DOE")).toBe(true);
    const input=h.verifyDirect.mock.calls[0][0];
    expect(input.link.ownerName).toBe("DOE, JANE");
    expect(input.candidateContextBefore.rows[0].name).toBe("DOE, JANE");
    expect(input.before.manifest.rows.every(r=>r.ownerName==="DOE, JANE")).toBe(true);
  });
  it("retains the complete non-comma local search string while cash uses the observed source-owner token",async()=>{
    const h=harness();
    await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link:{...link,ownerName:"JANE DOE"}}]);
    expect(h.searchQueries.filter(q=>q.scope==="context").every(q=>q.name==="JANE DOE")).toBe(true);
    expect(h.searchQueries.filter(q=>q.scope==="cash").every(q=>q.name==="DOE")).toBe(true);
  });
  it("a matching surname cannot authorize another source person's campaign",async()=>{
    const h=harness();h.state.wrongSourceName=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(h.searchQueries.filter(q=>q.scope==="context").every(q=>q.name==="DOE")).toBe(true);
    expect(r.summary).toBeUndefined();expect(r.pacDonors).toBeUndefined();
    expect(r.outsideReportEvidence).toBeUndefined();expect(h.verifyDirect).not.toHaveBeenCalled();
    expect(h.searchQueries.filter(q=>q.scope==="cash")).toEqual([]);
    expect(r.diagnostics.join()).toContain("ownership unavailable");
  });
  it("omits unavailable Raised while keeping independently verified dated cash",async()=>{
    const h=harness();const evidence=directEvidence();delete evidence.grossCashRaisedCents;
    h.options.verifyDirect=()=>({evidence,diagnostics:["boundary unitemized unknown"]});
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary?.directContributionTotal).toBe(123.45);expect(r.summary).not.toHaveProperty("totalReceipts");
    expect(r.pacDonors).toBeUndefined();expect(r.coverage.direct?.grossCashRaisedAvailable).toBe(false);
  });
  it("IE acquisition failure preserves outside independently of accepted direct cash",async()=>{
    const h=harness();h.state.failIE=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary?.totalReceipts).toBe(300);expect(r.outsideReportEvidence).toBeUndefined();
    expect(r.diagnostics.join()).toContain("IE unavailable");
  });
  it("direct full-body failure permits independently closed positive outside evidence",async()=>{
    const h=harness();h.state.failCandidateReport=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary).toBeUndefined();expect(r.pacDonors).toBeUndefined();
    expect(r.outsideReportEvidence?.verifiedReports[0].occurrences).toHaveLength(1);
    expect(h.verifyDirect).not.toHaveBeenCalled();
  });
  it("surfaces a shared failed payer manifest for every affected candidate without outside zero authority",async()=>{
    const h=harness();h.state.failPayerManifest=true;
    const results=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([
      {link},{link:{...link,electionId:"another-eligible-election"}},
    ]);
    expect(h.queryCounts.get("manifest-136")).toBe(1);
    for(const result of results){
      expect(result.summary?.totalReceipts).toBe(300);
      expect(result.outsideReportEvidence).toBeUndefined();
      expect(result.coverage.outside).toBeUndefined();
      expect(result.diagnostics.join()).toContain("Payer manifest before: payer manifest unavailable");
    }
    expect(h.queryCounts.get("report-128190")).toBeUndefined();
  });
  it("never produces empty outside authority from empty discovery without prior report proof",async()=>{
    const h=harness();h.state.ieEmpty=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.outsideReportEvidence).toBeUndefined();expect(h.queryCounts.get("manifest-136")).toBeUndefined();
  });
  it("reacquires prior payer and same ordinary period even when current discovery is empty",async()=>{
    const h=harness(),loader=createTennesseeVerifiedFinanceLoader(h.options);
    const [first]=await loader.loadBatch([{link}]);
    const e=first.outsideReportEvidence!;
    const prior={version:1,candidateContext:e.candidateContext,reports:e.verifiedReports.map(r=>({...r,candidateContextFingerprint:e.candidateContext.candidateContextFingerprint}))};
    h.state.ieEmpty=true;h.state.currentPayerId="128191";
    const [second]=await loader.loadBatch([{link,priorOutsideReportProvenance:prior}]);
    expect(second.outsideReportEvidence?.verifiedReports).toMatchObject([{reportId:"128191",periodIdentity:"Pre-Primary 2026",occurrences:[]}]);
    expect(h.queryCounts.get("report-128191")).toBe(2);
    expect(h.queryCounts.get("registry")).toBe(4);
  });
  it("malformed prior authority preserves outside while current cash can refresh",async()=>{
    const h=harness();
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link,priorOutsideReportProvenance:{version:1}}]);
    expect(r.outsideReportEvidence).toBeUndefined();expect(r.summary?.totalReceipts).toBe(300);
    expect(r.diagnostics.join()).toContain("prior authority");
  });
  it.each(["removeCandidatePredecessor","duplicatePredecessor"] as const)("preserves cash on unproven or ambiguous period predecessor: %s",async flag=>{
    const h=harness();h.state[flag]=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary).toBeUndefined();expect(h.verifyDirect).not.toHaveBeenCalled();
    expect(r.outsideReportEvidence).toBeDefined();
  });
  it.each(["closePayerChanged","closeContextChanged","staleNative","nativePayerAmbiguous"] as const)("does not expose outside money on %s",async flag=>{
    const h=harness();h.state[flag]=true;
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.outsideReportEvidence).toBeUndefined();
  });
  it("uses fresh opening and closing globals for every batch, serializing concurrent preparations",async()=>{
    const h=harness(),loader=createTennesseeVerifiedFinanceLoader(h.options);
    await Promise.all([loader.loadBatch([{link}]),loader.loadBatch([{link}])]);
    expect(h.queryCounts.get("registry")).toBe(4);
    for(const y of [2024,2025,2026])expect(h.queryCounts.get("ie-"+y)).toBe(4);
    const starts=h.events.map((e,i)=>e.scope==="registry"&&e.phase==="before"?i:-1).filter(i=>i>=0);
    expect(starts).toHaveLength(2);
    expect(h.events[starts[1]-1]).toMatchObject({scope:"registry",phase:"after"});
  });
  it("records immutable scoped raw metadata without exposing cookies or allowing byte mutation of client evidence",async()=>{
    const h=harness();
    h.options.onRawResponse=event=>{h.events.push(event);event.raw.bytes[0]=99;};
    await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(h.sourceBytes[0]).toBe(1);
    expect(h.events[0]).toMatchObject({scope:"registry",phase:"before",raw:{sha256:hash(h.sourceBytes),method:"GET"}});
    expect(Object.isFrozen(h.events[0])).toBe(true);expect(Object.isFrozen(h.events[0].raw)).toBe(true);
    expect(h.events[0].raw).not.toHaveProperty("headers");
    expect(h.events.find(e=>e.scope==="report"&&e.campId==="136")).toBeDefined();
  });
  it("journal persistence failure is source acquisition failure, preserving every component",async()=>{
    const h=harness();h.options.onRawResponse=()=>{throw Error("raw journal unavailable");};
    const [r]=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link}]);
    expect(r.summary).toBeUndefined();expect(r.outsideReportEvidence).toBeUndefined();
    expect(r.diagnostics.join()).toContain("raw journal unavailable");
  });
  it("rejects every duplicate due request before acquiring shared source",async()=>{
    const h=harness();
    const results=await createTennesseeVerifiedFinanceLoader(h.options).loadBatch([{link},{link}]);
    expect(results.every(r=>r.summary===undefined&&r.outsideReportEvidence===undefined)).toBe(true);
    expect(h.events).toEqual([]);
  });
  it("unsupported cycle and empty batch do not query government sources",async()=>{
    const h=harness(),loader=createTennesseeVerifiedFinanceLoader(h.options);
    expect(await loader.loadBatch([])).toEqual([]);
    const [r]=await loader.loadBatch([{link:{...link,electionYear:2024}}]);
    expect(r.summary).toBeUndefined();expect(h.events).toEqual([]);
  });
});
