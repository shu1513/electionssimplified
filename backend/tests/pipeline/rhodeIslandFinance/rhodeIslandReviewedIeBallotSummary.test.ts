import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRhodeIslandReviewedIeSummaries as append } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedIeBallotSummary.js";
import { rhodeIslandReviewedIeSpenderKey } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedIeWriter.js";
import { isRhodeIslandReportedIeEnabled } from "../../../src/config/featureFlags.js";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { url } from "../../helpers/rhodeIslandCf8Fixtures.js";
const request={candidate_id:"11111111-1111-4111-8111-111111111111",election_id:"22222222-2222-4222-8222-222222222222"};
const key=candidateElectionKey(request.candidate_id,request.election_id);
function row() {return {...request,id:"33333333-3333-4333-8333-333333333333",election_year:2026,
  spender_name:"Example Spender",spender_key:rhodeIslandReviewedIeSpenderKey("Example Spender"),candidate_name:"Example Person",
  office_scope:"statewide",office_name:"Governor",district:null,observed_at:"2026-10-25T09:00:00Z",completed_at:"2026-10-25T09:01:00Z",
  source_digest:"a".repeat(64),source_url:url(),source_report_count:2,ie_report_count:1,occurrence_count:2,support_cents:"1000000",oppose_cents:"0",
  reports:[{filingGuid:"00000000-0000-0000-0000-000000000001",sourceUrl:url(),sourceSha256:"b".repeat(64),filedDate:"2026-10-10",
    reportedSpenderName:"Example Spender",reportedCandidateName:"Example Person",supportOppose:"support",reportedYearToDateCents:"1000000",occurrenceCount:2,reportCents:"1000000",
    lines:[{lineNumber:1,disbursementDate:"2026-10-10",amountCents:"500000"},{lineNumber:2,disbursementDate:"2026-10-10",amountCents:"500000"}]}]};}
function db(rows:object[], drift=false) {return {query:vi.fn(async (sql:string) => ({rows:sql.includes("FROM public.candidates candidate") ? drift ? [] : [{candidate_name:"Example Person",
  election_year:2026,office_scope:"statewide",office_name:"Governor",district:null,district_type:"statewide",geoid_compact:"44"}] : rows}))} as any;}
afterEach(() => vi.unstubAllEnvs());
describe("reviewed RI IE read closure", () => {
  it("defaults publication off and requires state master", () => {
    vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED","true"); vi.stubEnv("RHODE_ISLAND_REPORTED_IE_ENABLED",undefined);
    expect(isRhodeIslandReportedIeEnabled()).toBe(false); vi.stubEnv("RHODE_ISLAND_REPORTED_IE_ENABLED","true"); expect(isRhodeIslandReportedIeEnabled()).toBe(true);
    vi.stubEnv("RHODE_ISLAND_CAMPAIGN_FINANCE_ENABLED","false"); expect(isRhodeIslandReportedIeEnabled()).toBe(false);
  });
  it("shows a complete reviewed group without a receiving link or broad totals", async () => {
    const summaries=new Map<string,BallotLookupFinanceSummary>(), database=db([row()]); await append(database,[request],summaries);
    expect(summaries.get(key)!.outside_spending).toMatchObject({support_total:null,oppose_total:null,amount_basis:"reported_ie_disbursements",
      top_supporting_groups:[expect.objectContaining({amount:10000,expenditure_count:2})],top_opposing_groups:[]});
    expect(summaries.get(key)!.outside_spending.outside_coverage_note).toContain("cash payment is not established");
    expect(database.query.mock.calls[0][0]).not.toContain("ri_candidate_finance_links");
  });
  it.each(["familyCount","lineCount","lineMoney","ytd","sourceUrl","sourceHash","target","duplicateLine","unsafe","payerKey"])("holds corrupt %s before display", async kind => {
    const f=row(); if(kind==="familyCount") f.ie_report_count=2; if(kind==="lineCount") f.reports[0]!.occurrenceCount=3;
    if(kind==="lineMoney") f.reports[0]!.lines[0]!.amountCents="1"; if(kind==="ytd") f.reports[0]!.reportedYearToDateCents="1";
    if(kind==="sourceUrl") f.reports[0]!.sourceUrl="https://example.org/file.pdf"; if(kind==="sourceHash") f.reports[0]!.sourceSha256="bad";
    if(kind==="target") f.reports[0]!.reportedCandidateName="Other Person"; if(kind==="duplicateLine") f.reports[0]!.lines[1]!.lineNumber=1;
    if(kind==="unsafe") f.support_cents="9007199254740992"; if(kind==="payerKey") f.spender_key="f".repeat(64);
    const summaries=new Map<string,BallotLookupFinanceSummary>(); await append(db([f]),[request],summaries); expect(summaries.size).toBe(0);
  });
  it("rechecks canonical drift", async () => { const summaries=new Map<string,BallotLookupFinanceSummary>(); await append(db([row()],true),[request],summaries); expect(summaries.size).toBe(0); });
  it("checks every family before applying the five-group cap", async () => {
    const rows=Array.from({length:6},(_,i) => {const f=row(); f.spender_name=`Example ${i}`;f.spender_key=rhodeIslandReviewedIeSpenderKey(f.spender_name);
      f.reports[0]!.filingGuid=`00000000-0000-0000-0000-00000000000${i+1}`;f.source_url=f.reports[0]!.sourceUrl=url(f.reports[0]!.filingGuid);return f;});
    const summaries=new Map<string,BallotLookupFinanceSummary>(); await append(db(rows),[request],summaries); expect(summaries.get(key)!.outside_spending.top_supporting_groups).toHaveLength(5);
    rows[5]!.support_cents="1"; summaries.clear(); await append(db(rows),[request],summaries); expect(summaries.size).toBe(0);
  });
  it("preserves direct finance and its clock, and preserves legacy outside evidence if overlap is unknown", async () => {
    const summaries=new Map<string,BallotLookupFinanceSummary>(); await append(db([row()]),[request],summaries);
    const summary=summaries.get(key)!; summary.outside_spending={support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]};
    summary.last_synced_at="2026-10-01T00:00:00Z";summary.direct_campaign.total_raised=12345;
    await append(db([row()]),[request],summaries);expect(summary.last_synced_at).toBe("2026-10-01T00:00:00Z"); expect(summary.direct_campaign.total_raised).toBe(12345);
    summary.outside_spending.support_total=999;const before=structuredClone(summary);await append(db([row()]),[request],summaries);expect(summary).toEqual(before);
  });
});
