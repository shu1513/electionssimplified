import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inForm, inHtml } from "../../../src/pipeline/indianaFinance/indianaNativeProtocol.js";
import { inHash, type IndianaNativeOriginal } from "../../../src/pipeline/indianaFinance/indianaNativeOriginals.js";
import { readIndianaNativeReceiptEvidence, readIndianaNativeReceiptRuns } from "../../../src/pipeline/indianaFinance/indianaNativeReceiptEvidence.js";

import * as financialEvidence from "../../../src/pipeline/indianaFinance/indianaNativeFinancialEvidence.js";
import { IndianaNativePacSource } from "../../../src/pipeline/indianaFinance/indianaNativePacSource.js";
import { IndianaNativePacCollector } from "../../../src/pipeline/indianaFinance/indianaNativePacCollector.js";
import type { IndianaNativeReceiver } from "../../../src/pipeline/indianaFinance/indianaNativeReceiver.js";

const base="https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionSearch.aspx";
const field=(id:string,type="text",value="")=>`<input id="_ctl0_Content_${id}" name="${id}" type="${type}" value="${value}">`;
const state=(v:string)=>`<input name="__VIEWSTATE" type="hidden" value="${v}"><input name="__EVENTVALIDATION" type="hidden" value="synthetic-validation">`;
const form=`<form>${state("synthetic-form")}${field("txtLastName")}${field("rblLastNameSearchType_0","radio","contains")}${field("ucCommitteeCandidateSearch_txtCommitteeName")}${field("ucCommitteeCandidateSearch_rblCommitteeNameSearchType_0","radio","contains")}${field("ucCommitteeCandidateSearch_txtCommitteeID")}${field("txtContributionDateBegin")}${field("txtContributionDateEnd")}${field("ucCommitteeCandidateSearch_rblCommitteeCandidateSelection_0","radio","committee")}<select id="_ctl0_Content_ddlContributorType" name="donor"><option value="Select all contributor types...">Select all contributor types...</option><option value="10">Political Action Committee</option></select><select id="_ctl0_Content_ucCommitteeCandidateSearch_ddlCommitteeType" name="recipient"><option value="candidate">Candidate</option></select>${field("btnSearch","submit","Search")}</form>`;
function result(rows=1,size=10,day="10/1/2026",token="") {
 return `<form>${state("synthetic-result")}<span id="_ctl0_Content_lblRecordsFound">${rows} records found</span><span id="_ctl0_Content_lblTotalContributions">$${rows*100}.00</span><table id="_ctl0_Content_dgdSearchResults"><tr>${["Contributor","City, State","Type","Amount","Date","Candidate/Committee Name","In Kind?","Large?",""] .map(v=>`<th>${v}</th>`).join("")}</tr>${Array.from({length:rows},(_,i)=>`<tr><td>Synthetic PAC ${i}</td><td>Example, IN</td><td>Direct</td><td>$100.00</td><td>${day}</td><td>Synthetic Committee</td><td></td><td></td><td><a onclick="window.open('/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=${token}${i}')">View</a></td></tr>`).join("")}<tr><td colspan="9"><span>1</span><select name="synthetic_size" onchange="__doPostBack('synthetic_size','')">${[10,25,50].map(n=>`<option value="${n}" ${n===size?"selected":""}>${n}</option>`).join("")}</select></td></tr></table></form>`;
}
function original(index:number,url:string,raw:string,request:string|null=null,location:string|null=null):IndianaNativeOriginal {
 const bytes=Buffer.from(raw),time=new Date(Date.now()-20000+index*1000).toISOString();
 return {directory:"/synthetic-originals",raw:bytes,request,meta:{role:"synthetic",url,file:`${index}.original`,method:request===null?"GET":"POST",requestFile:request===null?null:`${index}.request`,requestSha256:request===null?null:inHash(request),status:location?302:200,location,contentType:"text/html",startedAt:time,completedAt:time,bytes:bytes.length,sha256:inHash(bytes),eof:true}};
}
function walk({file="synthetic-file",begin="1/1/2026",end="10/21/2026",kind="pac",day="10/1/2026",token=""}: {
 file?:string;begin?:string;end?:string;kind?:"all"|"pac";day?:string;token?:string;
} = {}) {
 const d=inHtml(Buffer.from(form),base),p=inForm(d);
 p.set("ucCommitteeCandidateSearch_txtCommitteeID",file);p.set("txtContributionDateBegin",begin);p.set("txtContributionDateEnd",end);p.set("ucCommitteeCandidateSearch_rblCommitteeCandidateSelection_0","committee");p.set("donor",kind==="pac"?"10":"Select all contributor types...");p.set("btnSearch","Search");d.defaultView?.close();
 const u=new URL(base);for(const [k,v]of Object.entries({CommitteeID:file,FinanceCategoryID:kind==="pac"?"10":"-32768",ContributionDateBegin:begin,ContributionDateEnd:end}))u.searchParams.set(k,v);
 const first=inHtml(Buffer.from(result(1,10,day,token)),u.href),post=inForm(first);post.set("synthetic_size","50");post.set("__EVENTTARGET","synthetic_size");post.set("__EVENTARGUMENT","");first.defaultView?.close();
 return [original(0,base,form),original(1,base,"",p.toString(),u.href),original(2,u.href,result(1,10,day,token)),original(3,u.href,result(1,50,day,token),post.toString())];
}

describe("Indiana genuine receipt-walk provenance",()=>{
 it("accepts a real scoped search/postback chain when results omit search controls",()=>{
  const runs=readIndianaNativeReceiptRuns(walk());expect(runs).toHaveLength(1);expect(runs[0]!.scope.kind).toBe("pac");expect(runs[0]!.pages[0]!.rows).toHaveLength(1);
 });
 it("rejects a saved result URL without its fresh form/search submission",()=>{
  expect(readIndianaNativeReceiptRuns(walk().slice(2))).toEqual([]);
 });
 it("rejects a page that broadens the initial scoped count or money",()=>{
  const source=walk(),old=source[3]!;source[3]=original(3,old.meta.url,result(2,50),old.request);const diagnostics:Record<string,number>={};
  expect(readIndianaNativeReceiptRuns(source,diagnostics)).toEqual([]);expect(diagnostics.receipt_paging_scope_changed).toBe(1);
 });
 it("rejects a postback with unrelated native viewstate",()=>{
  const source=walk(),old=source[3]!,p=new URLSearchParams(old.request!);p.set("__VIEWSTATE","different-synthetic-state");source[3]=original(3,old.meta.url,result(1,50),p.toString());const diagnostics:Record<string,number>={};
  expect(readIndianaNativeReceiptRuns(source,diagnostics)).toEqual([]);expect(diagnostics.receipt_postback_state_conflict).toBe(1);
 });
 it("rejects a redirect that drops the selected literal PAC class",()=>{
  const source=walk(),old=source[1]!,u=new URL(old.meta.location!);u.searchParams.set("FinanceCategoryID","-32768");source[1]=original(1,base,"",old.request,u.href);const diagnostics:Record<string,number>={};
  expect(readIndianaNativeReceiptRuns(source,diagnostics)).toEqual([]);expect(diagnostics.receipt_query_redirect_scope).toBe(1);
 });
});


// Keep receipt provenance and closure real; isolate only the independent
// filing/report qualification to exercise source caching and packet facts.
const receiver = {
  receivingId: "synthetic-file",
  committeeName: "Synthetic Committee",
  electionYear: 2026,
} as IndianaNativeReceiver;
function savedRuns(
  end = "10/21/2026",
  file = receiver.receivingId,
  offset = 0,
) {
  return [
    ["1/1/2025", "12/31/2025"],
    ["1/1/2026", end],
  ].flatMap(([begin, end], period) =>
    (["all", "pac"] as const).flatMap((kind, mode) =>
      [0, 1].flatMap((repeat) => {
        const index = offset + period * 4 + mode * 2 + repeat;
        const day = `10/1/${begin!.slice(-4)}`,
          token = `${file}-${begin!.slice(-4)}-`;
        const detail = Object.entries({
          lblCommID: file,
          lblCommitteeName: receiver.committeeName,
          lblCommitteeType: "Candidate",
          lblContributorType: "Political Action Committee",
          lblContributorName: "Synthetic PAC 0",
          lblContributionType: "Direct",
          lblReceiptDate: day,
          lblAmount: "$100.00",
        })
          .map(([id, value]) => `<span id="${id}">${value}</span>`)
          .join("");
        const records = [
          ...walk({ file, begin, end, kind, day, token }),
          original(
            4,
            `https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=${token}0`,
            detail,
          ),
        ];
        return records.map((o, step) => {
          const time = new Date(
            Date.parse("2026-10-21T10:00:00.000Z") +
              index * 10000 +
              step * 1000,
          ).toISOString();
          return {
            ...o,
            directory: `/synthetic/source-originals-${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`,
            meta: {
              ...o.meta,
              file: `${String(step).padStart(5, "0")}.original`,
              startedAt: time,
              completedAt: time,
            },
          };
        });
      }),
    ),
  );
}
describe("Indiana saved receipt cutoffs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-22T12:00:00.000Z");
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", "false");
    vi.spyOn(
      financialEvidence,
      "readIndianaNativeFinancialEvidence",
    ).mockImplementation((originals, receiver, through) => {
      const receipts = readIndianaNativeReceiptEvidence(originals, {
        file: receiver.receivingId,
        committee: receiver.committeeName,
        year: receiver.electionYear,
        through,
      });
      return {
        receiver,
        receipts,
        originals: receipts.originals,
        supplements: [],
        reports: [
          {
            period: {
              begin: "2025-01-01",
              end: "2026-10-09",
              filed: "2026-10-20T10:00:00",
            },
            rows: receipts.periods.flatMap((p) => p.all),
            report: {
              file: receiver.receivingId,
              committee: receiver.committeeName,
              committeeClass: "Candidate",
              reportingPeriod: "Synthetic",
              itemizedReceipts: 20000,
              unitemizedReceipts: 0,
              itemizedExpenses: 0,
              unitemizedExpenses: 0,
              contributionsUrl: base,
              expendituresUrl: base,
              returnsUrl: base,
            },
          },
        ],
      };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it.each(["false", "true"])(
    "reuses yesterday's closed evidence with raw refresh %s",
    async (raw) => {
      vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", raw);
      const originals = savedRuns(),
        read = vi.fn().mockResolvedValue(originals);
      const diagnostics: Record<string, number> = {};
      expect(
        readIndianaNativeReceiptRuns(originals, diagnostics).length,
        JSON.stringify(diagnostics),
      ).toBe(8);
      const collect = vi
        .spyOn(IndianaNativePacCollector.prototype, "collect")
        .mockResolvedValue();
      const packet = await new IndianaNativePacSource({ read } as never).get(
        receiver,
        "2026-10-22",
      );
      expect(packet.facts.through).toBe("2026-10-21");
      expect(packet.facts.observedAt).toBe(originals[0]!.meta.startedAt);
      expect(packet.facts.completedAt).toBe(originals.at(-1)!.meta.completedAt);
      expect(packet.facts.observations).toHaveLength(34);
      expect(packet.controls.totalCents).toBe(20000);
      expect(read).toHaveBeenCalledOnce();
      expect(collect).not.toHaveBeenCalled();
    },
  );
  it("selects the greatest eligible cutoff despite later observations of a shorter scope", async () => {
    const originals = [
      ...savedRuns("10/22/2026"),
      ...savedRuns("10/21/2026", receiver.receivingId, 8),
    ];
    const packet = await new IndianaNativePacSource({
      read: async () => originals,
    } as never).get(receiver, "2026-10-22");
    expect(packet.facts.through).toBe("2026-10-22");
  });
  it("ignores other receivers and scopes beyond the requested cutoff", async () => {
    const originals = [
      ...savedRuns(),
      ...savedRuns("10/22/2026", "other-file", 8),
      ...savedRuns("10/23/2026", receiver.receivingId, 16),
    ];
    const packet = await new IndianaNativePacSource({
      read: async () => originals,
    } as never).get(receiver, "2026-10-22");
    expect(packet.facts.through).toBe("2026-10-21");
  });
  it("does not fall back to an older cutoff when the latest scope lacks independent closure", async () => {
    const originals = [
      ...savedRuns(),
      ...savedRuns("10/22/2026", receiver.receivingId, 8).slice(20, 25),
    ];
    const read = vi.mocked(
      financialEvidence.readIndianaNativeFinancialEvidence,
    );
    await expect(
      new IndianaNativePacSource({ read: async () => originals } as never).get(
        receiver,
        "2026-10-22",
      ),
    ).rejects.toThrow("receipt_independent_closing_search_missing");
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(originals, receiver, "2026-10-22");
  });
  it("bounds archived cutoffs by the election year during January refreshes", async () => {
    vi.setSystemTime("2027-01-21T12:00:00.000Z");
    const shift =
      Date.parse("2027-01-20T10:00:00.000Z") -
      Date.parse("2026-10-21T10:00:00.000Z");
    const originals = [
      ...savedRuns("12/30/2026"),
      ...savedRuns("1/1/2027", receiver.receivingId, 8),
    ].map((o) => ({
      ...o,
      meta: {
        ...o.meta,
        startedAt: new Date(Date.parse(o.meta.startedAt) + shift).toISOString(),
        completedAt: new Date(
          Date.parse(o.meta.completedAt) + shift,
        ).toISOString(),
      },
    }));
    const packet = await new IndianaNativePacSource({
      read: async () => originals,
    } as never).get(receiver, "2027-01-21");
    expect(packet.facts.through).toBe("2026-12-30");
    expect(packet.facts.observedAt.slice(0, 10)).toBe("2027-01-20");
  });
  it("never reuses expired originals", async () => {
    const originals = savedRuns();
    vi.setSystemTime("2026-10-29T12:00:00.000Z");
    await expect(
      new IndianaNativePacSource({ read: async () => originals } as never).get(
        receiver,
        "2026-10-29",
      ),
    ).rejects.toThrow("receipt_independent_closing_search_missing");
  });
  it("collects through today when cached qualification fails and raw refresh is enabled", async () => {
    vi.stubEnv("INDIANA_NATIVE_PAC_RAW_REFRESH_ENABLED", "true");
    const read = vi
      .fn()
      .mockResolvedValueOnce(savedRuns().slice(0, -5))
      .mockResolvedValue(savedRuns("10/22/2026"));
    const collect = vi
      .spyOn(IndianaNativePacCollector.prototype, "collect")
      .mockResolvedValue();
    const packet = await new IndianaNativePacSource({ read } as never).get(
      receiver,
      "2026-10-22",
    );
    expect(collect).toHaveBeenCalledWith(receiver, "2026-10-22");
    expect(packet.facts.through).toBe("2026-10-22");
  });
});
