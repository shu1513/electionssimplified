import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertRhodeIslandReviewedIePacket, type RhodeIslandReviewedIePacket } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedCf8Source.js";
import { writeRhodeIslandReviewedIePacket as write } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedIeWriter.js";
vi.mock("../../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedCf8Source.js", async original => ({
  ...await original<object>(), assertRhodeIslandReviewedIePacket: vi.fn(),
}));
const id = "33333333-3333-4333-8333-333333333333";
const context = {candidateId:"11111111-1111-4111-8111-111111111111",electionId:"22222222-2222-4222-8222-222222222222",
  candidateName:"Example Person",electionYear:2026,officeScope:"statewide",officeName:"Governor",district:null};
const packet = () => ({context,spenderName:"Example Spender",electionYear:2026,observedAt:"2026-10-26T09:00:00Z",
  completedAt:"2026-10-26T09:01:00Z",sourceDigest:"a".repeat(64),sourceUrl:"https://www.ricampaignfinance.com/ReportsScanned/example.pdf",
  sourceReportCount:2,excludedNonIeReportCount:1,occurrenceCount:2,supportCents:200,opposeCents:0,
  reports:[{filingGuid:"00000000-0000-0000-0000-000000000001",filedDate:"2026-10-10",sourceUrl:"https://www.ricampaignfinance.com/ReportsScanned/example.pdf",
    sourceSha256:"b".repeat(64),reportedSpenderName:"Example Spender",reportedCandidateName:"Example Person",supportOppose:"support",
    reportedYearToDateCents:200,lines:[{lineNumber:1,disbursementDate:"2026-10-10",amountCents:100},{lineNumber:2,disbursementDate:"2026-10-10",amountCents:100}]}]}) as RhodeIslandReviewedIePacket;
function database(options: {prior?:object[];owners?:object[];canonical?:object[];failLine?:boolean} = {}) {
  const query = vi.fn(async (sql:string) => {
    if (sql.includes("FROM public.candidates candidate")) return {rows:options.canonical ?? [{candidate_name:context.candidateName,election_year:2026,
      office_scope:"statewide",office_name:"Governor",district:null,district_type:"statewide",geoid_compact:"44"}]};
    if (sql.includes("FROM public.ri_reported_ie_families")) return {rows:options.prior ?? []};
    if (sql.includes("FROM public.ri_reported_ie_reports WHERE filing_guid")) return {rows:options.owners ?? []};
    if (options.failLine && sql.includes("INSERT INTO public.ri_reported_ie_lines")) throw Error("line_failure");
    return {rows:[{id}]};
  });
  const client = {query,release:vi.fn()},db = {query:vi.fn(),connect:vi.fn(async () => client)};
  return {db:db as any,client,query,sql:() => query.mock.calls.map(c => c[0])};
}
beforeEach(() => vi.mocked(assertRhodeIslandReviewedIePacket).mockReset());
describe("reviewed RI IE atomic writer", () => {
  it("rejects unminted packets before opening a connection", async () => {
    vi.mocked(assertRhodeIslandReviewedIePacket).mockImplementationOnce(() => {throw Error("cache_backed_packet_required");});
    const d=database(); await expect(write({db:d.db,packet:packet(),reviewedMapping:true})).rejects.toThrow("cache_backed_packet_required");
    expect(d.db.connect).not.toHaveBeenCalled();
  });
  it("preserves equal occurrences and all receiving/legacy tables and clocks", async () => {
    const d=database(); expect(await write({db:d.db,packet:packet(),reviewedMapping:true})).toMatchObject({status:"written",reportsWritten:1,occurrencesWritten:2});
    const sql=d.sql(); expect(sql[0]).toBe("BEGIN"); expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.filter(s => s.includes("INSERT INTO public.ri_reported_ie_lines"))).toHaveLength(2);
    expect(sql.some(s => /(?:INSERT INTO|UPDATE|DELETE FROM) public\.(?!ri_reported_ie_)/u.test(s))).toBe(false);
    expect(sql.some(s => s.includes("ri_candidate_finance_links"))).toBe(false); expect(d.client.release).toHaveBeenCalledOnce();
  });
  it("holds canonical drift before money mutation", async () => {
    const d=database({canonical:[]}); await expect(write({db:d.db,packet:packet(),reviewedMapping:true})).rejects.toThrow("canonical_context_changed");
    expect(d.sql().some(s => /INSERT INTO|DELETE FROM/u.test(s))).toBe(false); expect(d.sql().at(-1)).toBe("ROLLBACK");
  });
  it("rolls back a partial family/report write on line failure", async () => {
    const d=database({failLine:true}); await expect(write({db:d.db,packet:packet(),reviewedMapping:true})).rejects.toThrow("line_failure");
    expect(d.sql().at(-1)).toBe("ROLLBACK"); expect(d.sql()).not.toContain("COMMIT");
  });
  it.each([{newer:true,equal:false,source_digest:"a".repeat(64)},{newer:false,equal:true,source_digest:"c".repeat(64)}])("holds old/conflicting observations", async prior => {
    const d=database({prior:[{id,...prior}]}); await expect(write({db:d.db,packet:packet(),reviewedMapping:true})).rejects.toThrow(/older_source_clock|same_clock_source_conflict/u);
    expect(d.sql().some(s => /INSERT INTO|DELETE FROM/u.test(s))).toBe(false);
  });
  it("makes identical original clocks/digest a true no-op", async () => {
    const d=database({prior:[{id,newer:false,equal:true,source_digest:packet().sourceDigest}]});
    expect(await write({db:d.db,packet:packet(),reviewedMapping:true})).toMatchObject({status:"unchanged",reportsWritten:0,occurrencesWritten:0});
    expect(d.sql().some(s => /INSERT INTO|DELETE FROM/u.test(s))).toBe(false);
  });
  it("prevents moving a single-target native GUID to another owner", async () => {
    const d=database({owners:[{family_id:"other"}]}); await expect(write({db:d.db,packet:packet(),reviewedMapping:true})).rejects.toThrow("single_target_report_owned_elsewhere");
    expect(d.sql().some(s => /INSERT INTO|DELETE FROM/u.test(s))).toBe(false);
  });
});
