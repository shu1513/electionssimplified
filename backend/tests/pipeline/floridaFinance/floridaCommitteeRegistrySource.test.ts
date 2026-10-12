import { FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY, resolveFloridaCommitteeDonorIdentity } from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorIdentity.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";
import { buildFloridaCommitteeDonorPrefixes, createFloridaCommitteeRegistrySource,
  decodeFloridaCommitteeDetail, decodeFloridaCommitteeNameSearch, fingerprintFloridaCommitteeDetailSemantics,
  type FloridaCommitteeRegistryRequest, type FloridaReviewedCommitteeDates,
} from "../../../src/pipeline/floridaFinance/floridaCommitteeRegistrySource.js";
const origin = "https://dos.elections.myflorida.com";
const search = origin + "/committees/ComLkupByName.asp";
const url = (id: string) => origin + "/committees/ComDetail.asp?account=" + id;
type Row = { id: string; name: string; type: string; status: string; address?: string };
const current: Row = { id: "60813", name: "Florida Home Builders PAC", type: "PAC", status: "Active", address: "1319 Thomaswood Drive" };
const historical: Row = { ...current, id: "1997", type: "CCE", status: "Closed", address: "201 East Park Avenue" };
const descriptions: Record<string, string> = { PAC: "Political Committee", CCE: "Committee of Continuous Existence", PTY: "Party Executive Committee", PAP: "Affiliated Party Committee", ECO: "Electioneering Communications Organization", ECI: "Electioneering Communications Individual", IXO: "Independent Expenditures Organization" };
function list(prefix: string, rows: readonly Row[]) {
  return '<html><body><h2>Search for Committee by Name</h2><input name=ComName value="' + prefix +
    '"><table><tr><td>Committee</td><td>Type</td><td>Status</td></tr>' + rows.map(r =>
    '<tr><td><a href="ComDetail.asp?account=' + r.id + '">' + r.name + '</a></td><td>' +
    r.type + '</td><td>' + r.status + '</td></tr>').join("") + '</table></body></html>';
}
function detail(r: Row) {
  return '<html><body><h2>Committee Tracking System</h2><table><tr><td colspan=2><font size=+1><b>' +
    r.name + '</b></font></td></tr><tr><td><b>Type:</b></td><td>' + descriptions[r.type] +
    '</td></tr><tr><td><b>Status:</b></td><td>' + r.status + '</td></tr><tr><td><b>Address:</b></td><td>' +
    (r.address ?? "1 Main St") + '<br>Tallahassee, FL 32308<br></td></tr>' +
    '<tr><td><b>Chairperson:</b></td><td>Full Source Name<br>Published Address</td></tr></table>' +
    '<input type=hidden name=account value="' + r.id + '"></body></html>';
}
function envelope(body: string, req: FloridaCommitteeRegistryRequest, n = 0): FloridaProcessedRawEvidence {
  const bytesRaw = Buffer.from(body);
  return { bytesRaw, sha256: createHash("sha256").update(bytesRaw).digest("hex"),
    url: req.url, method: req.method, financeFields: req.financeFields, status: 200, contentType: "text/html",
    startedAt: new Date(Date.UTC(2026,9,11,20,0,n)).toISOString(),
    completedAt: new Date(Date.UTC(2026,9,11,20,0,n,500)).toISOString() };
}
function query(p = "Florida Home Builders", rows: readonly Row[] = [historical,current]) {
  return envelope(list(p, rows), {url:search,method:"POST",financeFields:{searchtype:"1",comName:p,LkupTypeName:"L",NameSearchBtn:"Search by Name"}});
}
function mock(rows: readonly Row[], change?: (raw: FloridaProcessedRawEvidence, req: FloridaCommitteeRegistryRequest, n:number) => FloridaProcessedRawEvidence) {
  const calls: FloridaCommitteeRegistryRequest[] = [];
  return { calls, request: async (req: FloridaCommitteeRegistryRequest) => {
    calls.push(req);
    const body = req.method === "POST" ? list(req.financeFields!.comName!, rows.filter(r =>
      r.name.toUpperCase().startsWith(req.financeFields!.comName!.toUpperCase()))) :
      detail(rows.find(r => r.id === new URL(req.url).searchParams.get("account"))!);
    const raw = envelope(body,req,calls.length);
    return change?.(raw,req,calls.length) ?? raw;
  }};
}
const receipt = {reportedName:current.name,reportedAddress:"1319 Thomaswood DR",
  reportedCityStateZip:"Tallahassee, FL 32308",transactionDate:"2026-05-14"};
describe("Florida bounded all-status registry source", () => {
  it("retains all source classes/statuses and exact public identities", () => {
    expect(decodeFloridaCommitteeNameSearch(query(),{prefix:"Florida Home Builders"}).map(r =>
      [r.committeeId,r.committeeType,r.status])).toEqual([["1997","CCE","Closed"],["60813","PAC","Active"]]);
  });
  it("selects the exact financial table before unrelated source form optional-row markup", () => {
    const p="Florida Home Builders";
    const source=list(p,[historical,current]).replace("<body>","<body>"+
      '<table><tr><td colspan=4>Search</td></tr><tr><td><table>'+
      '<tr><td>Name search form</td><tr><td>Starting With</td></tr></table></td></tr></table>');
    const raw=envelope(source,{url:search,method:"POST",financeFields:{
      searchtype:"1",comName:p,LkupTypeName:"L",NameSearchBtn:"Search by Name"}});
    expect(decodeFloridaCommitteeNameSearch(raw,{prefix:p})).toHaveLength(2);
  });
  it.each(["PAC","CCE","PTY","PAP","ECO","ECI","IXO"])("retains exact source legal class %s", type => {
    const r={...current,type}; const d=decodeFloridaCommitteeDetail(envelope(detail(r),
      {url:url(r.id),method:"GET",financeFields:null}),{committeeId:r.id});
    expect(d.committeeType).toBe(type);
    expect(d.addressLines).toEqual(["1319 Thomaswood Drive","Tallahassee, FL 32308"]);
    expect(d.fullFields.Chairperson).toContain("Published Address");
  });
  it.each([
    (s:string)=>s.replace("</table>",""),
    (s:string)=>s.replace("<td>CCE</td>","<td>CCE"),
    (s:string)=>s.replace("account=1997","account=1997&account=60813"),
    (s:string)=>s.replace("account=1997","account=%31%39%39%37"),
    (s:string)=>s.replace("account=1997","account=60813"),
    (s:string)=>s.replace("</body>",'<a href="?page=2">Next Page</a></body>'),
    (s:string)=>s.replace("</body>","First 50 results</body>"),
    (s:string)=>s.replace("Florida Home Builders","Wrong Prefix"),
  ])("rejects partial, duplicate, encoded, capped or wrong-scope results %#", f => {
    const raw=query(); const body=f(Buffer.from(raw.bytesRaw).toString());
    expect(()=>decodeFloridaCommitteeNameSearch(envelope(body,{url:raw.url,method:raw.method,financeFields:raw.financeFields}),
      {prefix:"Florida Home Builders"})).toThrow();
  });
  it("rejects wrong request filters, SHA/status, URL and capture chronology", () => {
    const raw=query();
    for(const change of [{financeFields:{...raw.financeFields,Status:"Active"}},{sha256:"a".repeat(64)},
      {status:500},{completedAt:"2026-01-01T00:00:00.000Z"},{url:search+"?page=2"}]) {
      expect(()=>decodeFloridaCommitteeNameSearch({...raw,...change},{prefix:"Florida Home Builders"})).toThrow();
    }
  });
  it("accepts only the exact observed no-record marker without conflicting finance results", () => {
    const p="Example Donor";
    const marker='<p><b><font size="2" face="Arial,Helvetica,Univers,Zurich BT"><br> ** No records found for criteria</font></b></p>';
    const source='<html><body>Search for Committee by Name<input name=ComName value="'+p+'">'+
      '<table><tr><td><table><tr><td>Name form</td><tr><td>Starting With</td></tr></table>'+marker+
      '</table></table></body></html>';
    const request={url:search,method:"POST" as const,financeFields:{
      searchtype:"1",comName:p,LkupTypeName:"L",NameSearchBtn:"Search by Name"}};
    expect(decodeFloridaCommitteeNameSearch(envelope(source,request),{prefix:p})).toEqual([]);
    for(const broken of [source.replace(marker,marker+marker),
      source.replace(marker,marker+'<a href="ComDetail.asp?account=60813">Contradiction</a>'),
      source.replace(marker,marker+'<table><tr><td>Committee</td><td>Type</td><td>Status</td></tr></table>'),
      source.replace("No records found for criteria","No records found"),
      source.replace("</body>","")]){
      expect(()=>decodeFloridaCommitteeNameSearch(envelope(broken,request),{prefix:p})).toThrow();
    }
  });
  it("reports valid scoped absence distinctly from lookup failure", async () => {
    const m=mock([]); const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.status).toBe("not_found"); expect(result.identity).toBeUndefined(); expect(m.calls).toHaveLength(4);
    const failed={request:async()=>{throw new Error("HTTP500");}};
    expect(await createFloridaCommitteeRegistrySource(failed).lookupDonor(receipt)).toMatchObject({status:"unresolved"});
  });
  it("brackets two literal prefixes and every selected detail with explicit fresh closing phase", async () => {
    const m=mock([current]); const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.identity?.committeeId).toBe("60813");
    expect(resolveFloridaCommitteeDonorIdentity({ ...receipt, registrations: result.registrations,
      queryProof: result.queryProof }).identity).toEqual(result.identity);
    expect(m.calls.map(c=>[c.method,c.phase])).toEqual([["POST","opening"],["POST","opening"],["GET","opening"],
      ["GET","closing"],["POST","closing"],["POST","closing"]]);
    expect(m.calls.filter(c=>c.method==="POST").every(c=>c.financeFields!.comName!.length<30&&c.financeFields!.LkupTypeName==="L")).toBe(true);
    expect(m.calls.filter(c=>c.method==="GET").every(c=>c.financeFields===null)).toBe(true);
  });
  it("retains the caller receipt before the first asynchronous source request", async () => {
    const input={...receipt,receivingCommitteeId:undefined as string|undefined};
    const m=mock([current],(raw,_req,n)=>{
      if(n===1){input.reportedName="Other Name";input.receivingCommitteeId="60813";}
      return raw;
    });
    const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(input);
    expect(result.identity?.committeeId).toBe("60813");
    expect(result.identity?.includedInCommitteeDonorScope).toBe(true);
  });
  it("requires injected reviewed PDF evidence for historical collisions, not HTML date inference", async () => {
    expect((await createFloridaCommitteeRegistrySource(mock([historical,current])).lookupDonor(receipt)).status).toBe("unresolved");
    const pdf=(n:number)=>({...envelope("%PDF-source-shaped-reviewed-fixture",{url:origin+
      "/campaign-docs/PDFHandler.ashx?AcctType=07/30/13&TrackNum="+n,method:"GET",financeFields:null}),contentType:"application/pdf"});
    const reviewedDates:FloridaReviewedCommitteeDates[]=[
      {committeeId:"1997",disbandment:{effectiveDate:"2013-08-31",document:pdf(100206658)}},
      {committeeId:"60813",registration:{effectiveDate:"2013-08-13",document:pdf(100208396)}},
    ];
    expect((await createFloridaCommitteeRegistrySource({...mock([historical,current]),reviewedDates}).lookupDonor(receipt)).identity?.resolution).toBe("dated_exact_address");
  });
  it("passes reviewed temporal bounds with untouched official PDF hashes and no guessed effective date", async () => {
    const pdf=(n:number)=>({...envelope("%PDF-source-shaped-reviewed-fixture",{url:origin+
      "/campaign-docs/PDFHandler.ashx?AcctType=08/01/13&TrackNum="+n,method:"GET",financeFields:null}),contentType:"application/pdf"});
    const registrationDocument=pdf(100207220);
    const closureDocument=pdf(100207222);
    const reviewedDates:FloridaReviewedCommitteeDates[]=[
      {committeeId:"1997",disbandment:{closedBy:"2013-08-01",document:closureDocument}},
      {committeeId:"60813",registration:{activeBy:"2013-08-01",document:registrationDocument}},
    ];
    const result=await createFloridaCommitteeRegistrySource({...mock([historical,current]),reviewedDates}).lookupDonor(receipt);
    expect(result.identity?.resolution).toBe("dated_exact_address");
    expect(result.registrations?.find(r=>r.committeeId==="60813")?.registration).toEqual({
      activeBy:"2013-08-01",sourceUrl:registrationDocument.url,sha256:registrationDocument.sha256});
    expect(result.registrations?.find(r=>r.committeeId==="1997")?.disbandment).toEqual({
      closedBy:"2013-08-01",sourceUrl:closureDocument.url,sha256:closureDocument.sha256});
    const onBound=await createFloridaCommitteeRegistrySource({...mock([historical,current]),reviewedDates})
      .lookupDonor({...receipt,transactionDate:"2013-08-01"});
    expect(onBound.status).toBe("unresolved");
  });
  it("rejects caller supplied mixed temporal bounds before donor acceptance", async () => {
    const document={...envelope("%PDF-reviewed-fixture",{url:origin+
      "/campaign-docs/PDFHandler.ashx?AcctType=08/01/13&TrackNum=100207220",method:"GET",financeFields:null}),contentType:"application/pdf"};
    const reviewedDates=[{committeeId:"60813",registration:{effectiveDate:"2013-08-01",activeBy:"2013-08-01",document}}];
    const result=await createFloridaCommitteeRegistrySource({...mock([current]),reviewedDates:reviewedDates as unknown as FloridaReviewedCommitteeDates[]}).lookupDonor(receipt);
    expect(result.status).toBe("unresolved");
  });
  it("compares actual protected email semantics while retaining both rotating raw encodings", async () => {
    const encode=(value:string,key:number)=>key.toString(16).padStart(2,"0")+
      [...Buffer.from(value)].map(v=>(v^key).toString(16).padStart(2,"0")).join("");
    const protectedRow=(key:number)=>'<tr><td><b>Email:</b></td><td><a href="/cdn-cgi/l/email-protection#'+
      encode("contact@example.org   ",key)+'"><span class="__cf_email__" data-cfemail="'+
      encode("contact@example.org",key+1)+'">[email&#160;protected]</span>   </a></td></tr>';
    const m=mock([current],(raw,req,n)=>req.method==="GET"?envelope(detail(current)
      .replace("</table>",protectedRow(req.phase==="opening"?10:20)+"</table>"),req,n):raw);
    const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.status).toBe("resolved");
    expect(result.registrations?.[0]?.rawFields?.detail).toMatchObject({
      fullFields:{Email:expect.stringContaining('data-cfemail="'+encode("contact@example.org",11)+'"')}});
    expect(result.sourceHashes[2]).not.toBe(result.sourceHashes[3]);
  });
  it("retains an observed protected numeric contact label without treating it as email or account evidence", async () => {
    const encode=(value:string,key:number)=>key.toString(16).padStart(2,"0")+
      [...Buffer.from(value)].map(v=>(v^key).toString(16).padStart(2,"0")).join("");
    const m=mock([current],(raw,req,n)=>req.method==="GET"?envelope(detail(current).replace("</table>",
      '<tr><td><b>Email:</b></td><td><a href="/cdn-cgi/l/email-protection#'+
      encode("61154   ",req.phase==="opening"?10:20)+'">61154   </a></td></tr></table>'),req,n):raw);
    const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.identity?.committeeId).toBe("60813");
    expect(result.registrations?.[0]?.rawFields?.detail).toMatchObject({fullFields:{
      Email:expect.stringContaining(">61154   </a>")}});
    const changed=mock([current],(raw,req,n)=>req.method==="GET"?envelope(detail(current).replace("</table>",
      '<tr><td><b>Email:</b></td><td><a href="/cdn-cgi/l/email-protection#'+
      encode(req.phase==="opening"?"61154":"61155",10)+'">61154</a></td></tr></table>'),req,n):raw);
    expect((await createFloridaCommitteeRegistrySource(changed).lookupDonor(receipt)).status).toBe("unresolved");
  });
  it.each(["changed_email","bad_hex","bad_utf8","conflicting_link","missing_span"])(
    "preserves malformed or changed protected email %s", async mode => {
    const encode=(value:Uint8Array,key:number)=>key.toString(16).padStart(2,"0")+
      [...value].map(v=>(v^key).toString(16).padStart(2,"0")).join("");
    const m=mock([current],(raw,req,n)=>{
      if(req.method!=="GET")return raw;
      const closing=req.phase==="closing";
      const email=closing&&mode==="changed_email"?"changed@example.org":"contact@example.org";
      let span=encode(Buffer.from(email),10),link=encode(Buffer.from(email),20);
      if(closing&&mode==="bad_hex")span="0a0";
      if(closing&&mode==="bad_utf8")span=encode(new Uint8Array([255]),10);
      if(closing&&mode==="conflicting_link")link=encode(Buffer.from("other@example.org"),20);
      const visible=closing&&mode==="missing_span"?"[email protected]":
        '<span class="__cf_email__" data-cfemail="'+span+'">[email&#160;protected]</span>';
      const row='<tr><td><b>Email:</b></td><td><a href="/cdn-cgi/l/email-protection#'+link+'">'+visible+'</a></td></tr>';
      return envelope(detail(current).replace("</table>",row+"</table>"),req,n);
    });
    expect((await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt)).status).toBe("unresolved");
  });
  it.each(["query","detail","transport","old_capture"])("preserves failed/changed closing %s", async mode => {
    const m=mock([current],(raw,req,n)=>{
      if(req.phase!=="closing")return raw;
      if(mode==="transport")return {...raw,status:500};
      if(mode==="old_capture")return {...raw,startedAt:"2026-01-01T00:00:00.000Z",completedAt:"2026-01-01T00:00:01.000Z"};
      if(mode==="query"&&req.method==="POST")return envelope(list(req.financeFields!.comName!,[]),req,n);
      if(mode==="detail"&&req.method==="GET")return envelope(detail(current).replace("Full Source Name","Changed Source Name"),req,n);
      return raw;
    });
    expect((await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt)).status).toBe("unresolved");
  });
  it("permits query row order changes without dropping the historical account", async () => {
    const m=mock([historical,current],(raw,req,n)=>req.phase==="closing"&&req.method==="POST"?
      envelope(list(req.financeFields!.comName!,[current,historical]),req,n):raw);
    const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.registrations).toHaveLength(2); expect(result.status).toBe("unresolved");
  });
  it("rejects wrong account payload/type, missing address and incomplete detail", () => {
    for(const body of [detail(current).replace('value="60813"','value="1997"'),
      detail(current).replace("Political Committee","Unknown Type"),detail(current).replace("Address:","Missing:"),
      detail(current).replace("</table>","")]) {
      expect(()=>decodeFloridaCommitteeDetail(envelope(body,{url:url("60813"),method:"GET",financeFields:null}),{committeeId:"60813"})).toThrow();
    }
  });
  it("accepts only the observed account orphan-wrapper tail after complete financial rows", () => {
    const source=detail(historical).replace("</table>","</table>\n</td>\n</tr>\n</table>");
    const request={url:url("1997"),method:"GET" as const,financeFields:null};
    expect(decodeFloridaCommitteeDetail(envelope(source,request),{committeeId:"1997"}))
      .toMatchObject({committeeId:"1997",committeeType:"CCE",status:"Closed"});
    for(const broken of [source.replace("</td>\n</tr>\n</table>","</div></table>"),
      source.replace("</td></tr>","</tr>"),source.replace("</table>\n</td>","</td>")]){
      expect(()=>decodeFloridaCommitteeDetail(envelope(broken,request),{committeeId:"1997"})).toThrow();
    }
  });
  it("isolates the observed optional Purpose continuation while retaining its full raw context", () => {
    const continuation='<tr><td><b>Purpose:</b></td><td>&nbsp;</td></tr>'+
      '<tr><td>&nbsp;</td><td><b>Utilities</b><br />Electric'+
      '<tr><td><b>Affiliations:</b></td><td>&nbsp;</td></tr>';
    const source=detail(historical).replace("</table>",continuation+"</table>");
    const request={url:url("1997"),method:"GET" as const,financeFields:null};
    const d=decodeFloridaCommitteeDetail(envelope(source,request),{committeeId:"1997"});
    expect(d.committeeType).toBe("CCE");
    expect(d.fullFields.__sourceAccountTables).toContain("<b>Utilities</b><br />Electric");
    expect(()=>decodeFloridaCommitteeDetail(envelope(source.replace("Purpose:","Address:"),request),
      {committeeId:"1997"})).toThrow();
    expect(()=>decodeFloridaCommitteeDetail(envelope(source.replace("Affiliations:","Status:"),request),
      {committeeId:"1997"})).toThrow();
  });
  it("keeps source punctuation and standard numeric C1 entity semantics", () => {
    const r={...current,name:"FIC&#146;S PAC"};
    expect(decodeFloridaCommitteeDetail(envelope(detail(r),{url:url(r.id),method:"GET",financeFields:null}),
      {committeeId:r.id}).committeeName).toBe("FIC’S PAC");
  });
  it("uses narrow literal all-status prefixes for a short Florida name and retains closed competing accounts", async () => {
    const renamed={...current,name:"FLORIDA ACRE"};
    const m=mock([renamed]);
    const result=await createFloridaCommitteeRegistrySource(m).lookupDonor({...receipt,reportedName:"FLORIDA ACRE"});
    expect(result.status).toBe("resolved");
    expect(m.calls.filter(c=>c.method==="POST").map(c=>c.financeFields!.comName))
      .toEqual(["FLORIDA ACR","FLORIDA ACRE","FLORIDA ACR","FLORIDA ACRE"]);
    expect(m.calls.filter(c=>c.method==="POST").every(c=>c.financeFields!.searchtype==="1")).toBe(true);
  });
  it("does not guess non-UTF8 encoding", () => {
    const raw=query(),bytesRaw=Buffer.from([255,255]);
    expect(()=>decodeFloridaCommitteeNameSearch({...raw,bytesRaw,sha256:createHash("sha256").update(bytesRaw).digest("hex")},
      {prefix:"Florida Home Builders"})).toThrow();
  });
  it("bounds literal prefixes without inventing a safe50-character server limit", () => {
    expect(buildFloridaCommitteeDonorPrefixes(current.name)).toEqual([current.name.slice(0,-1),current.name]);
    const p=buildFloridaCommitteeDonorPrefixes("Associated Industries of Florida Political Action Committee");
    expect(p.every(x=>x.length<30)).toBe(true); expect(p[1].startsWith(p[0])).toBe(true);
    expect(buildFloridaCommitteeDonorPrefixes("FLORIDA ACRE")).toEqual(["FLORIDA ACR","FLORIDA ACRE"]);
    expect(buildFloridaCommitteeDonorPrefixes("FLORIDA PROFESSIONAL EMPLOYER ORGANIZATION PAC"))
      .toEqual(["FLORIDA PROFESSIONAL EMPLOYE","FLORIDA PROFESSIONAL EMPLOYER"]);
    expect(buildFloridaCommitteeDonorPrefixes("Florida Name (Exact) Political Action Committee").every(x=>
      "Florida Name (Exact) Political Action Committee".startsWith(x))).toBe(true);
    expect(()=>buildFloridaCommitteeDonorPrefixes("A")).toThrow();
  });
});

describe("distinct certification authority at raw registry boundary", () => {
  it("does not trust forged enrolled-PDF metadata while preserving financial query captures", async () => {
    const a = FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY;
    const source = mock([historical,current]);
    const body = Buffer.from("%PDF-1.4\nnot the reviewed enrolled law");
    const document: FloridaProcessedRawEvidence = { bytesRaw: body, sha256: a.sha256, url: a.sourceUrl,
      method: "GET", financeFields: null, status: 200, contentType: "application/pdf",
      startedAt: "2026-10-11T19:00:00.000Z", completedAt: "2026-10-11T19:00:01.000Z" };
    const result = await createFloridaCommitteeRegistrySource({ request: source.request, reviewedDates: [{
      committeeId: "1997", certificationRevocation: { revokedOn: a.revokedOn, section: a.section, document },
    }] }).lookupDonor(receipt);
    expect(result.status).toBe("unresolved");
    expect(result.diagnostics.join(" ")).toContain("raw response/hash/status");
    expect(source.calls).toHaveLength(8);
  });
  it("exports full source detail semantics without dropping address or legal identity fields", () => {
    const raw = envelope(detail(current), { url: url(current.id), method: "GET", financeFields: null });
    const d = decodeFloridaCommitteeDetail(raw,{committeeId:current.id});
    const fp = fingerprintFloridaCommitteeDetailSemantics(d);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintFloridaCommitteeDetailSemantics({ ...d, address: "Changed Street" })).not.toBe(fp);
    expect(fingerprintFloridaCommitteeDetailSemantics({ ...d, committeeType: "CCE" })).not.toBe(fp);
    expect(d.fullFields.Chairperson).toContain("Published Address");
  });
});
