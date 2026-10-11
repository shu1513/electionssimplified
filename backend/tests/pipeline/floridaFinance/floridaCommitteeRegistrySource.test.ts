import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";
import { buildFloridaCommitteeDonorPrefixes, createFloridaCommitteeRegistrySource,
  decodeFloridaCommitteeDetail, decodeFloridaCommitteeNameSearch,
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
  it("reports valid scoped absence distinctly from lookup failure", async () => {
    const m=mock([]); const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.status).toBe("not_found"); expect(result.identity).toBeUndefined(); expect(m.calls).toHaveLength(4);
    const failed={request:async()=>{throw new Error("HTTP500");}};
    expect(await createFloridaCommitteeRegistrySource(failed).lookupDonor(receipt)).toMatchObject({status:"unresolved"});
  });
  it("brackets two literal prefixes and every selected detail with explicit fresh closing phase", async () => {
    const m=mock([current]); const result=await createFloridaCommitteeRegistrySource(m).lookupDonor(receipt);
    expect(result.identity?.committeeId).toBe("60813");
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
  it("keeps source punctuation and standard numeric C1 entity semantics", () => {
    const r={...current,name:"FIC&#146;S PAC"};
    expect(decodeFloridaCommitteeDetail(envelope(detail(r),{url:url(r.id),method:"GET",financeFields:null}),
      {committeeId:r.id}).committeeName).toBe("FIC’S PAC");
  });
  it("does not guess non-UTF8 encoding", () => {
    const raw=query(),bytesRaw=Buffer.from([255,255]);
    expect(()=>decodeFloridaCommitteeNameSearch({...raw,bytesRaw,sha256:createHash("sha256").update(bytesRaw).digest("hex")},
      {prefix:"Florida Home Builders"})).toThrow();
  });
  it("bounds literal prefixes without inventing a safe50-character server limit", () => {
    expect(buildFloridaCommitteeDonorPrefixes(current.name)).toEqual(["Florida Home Builders",current.name]);
    const p=buildFloridaCommitteeDonorPrefixes("Associated Industries of Florida Political Action Committee");
    expect(p.every(x=>x.length<30)).toBe(true); expect(p[1].startsWith(p[0])).toBe(true);
    expect(()=>buildFloridaCommitteeDonorPrefixes("A")).toThrow();
  });
});
