import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RhodeIslandCashPacket } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js";
import { assertRhodeIslandCashPacket } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js";
import { writeRhodeIslandCashPacket as write } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashWriter.js";
// Packet integrity is covered with real synthetic cache artifacts in the source
// suite. These tests isolate the writer's SQL/transaction/ownership boundary.
vi.mock("../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js", () => ({ assertRhodeIslandCashPacket: vi.fn() }));
const id = "33333333-3333-4333-8333-333333333333";
function packet(): RhodeIslandCashPacket {
  return { context: { candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
    electionYear: 2026, candidateName: "Jordan Example", officeScope: "statewide", officeName: "Governor", district: null,
    committeeId: "123", committeeName: "JORDAN EXAMPLE", searchLastName: "Example" },
  observedAt: "2026-10-24T09:00:00.000Z", sourceDigest: "a".repeat(64), coverageThrough: "2026-10-05", reportCount: 1,
  sourceUrl: "https://www.ricampaignfinance.com/RIPublic/Reporting/TransactionReport.aspx?OrgID=123&BeginDate=01/01/2025&EndDate=12/31/2026",
  receivingRows: 1, totalCents: 100_000, selectedOccurrences: 1,
  donors: [{ key: '["PAC","EXAMPLE PAC"]', name: "Example PAC", sourceClass: "PAC", amountCents: 100_000, contributionCount: 1 }],
  summary: { totalReceipts: 1000, directContributionTotal: 1000, totalDisbursements: 0, cashOnHand: 1000,
    sourceUrl: "https://www.ricampaignfinance.com/RIPublic/Homepage.aspx" }, directBreakdowns: [] };
}
function database(options: { canonical?: object[]; siblings?: object[]; source?: object[]; newerSummary?: boolean; failDonor?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.candidates candidate")) return { rows: options.canonical ?? [{ candidate_name: "Jordan Example", election_year: 2026,
      office_scope: "statewide", office_name: "Governor", district: null, district_type: "statewide", geoid_compact: "44" }] };
    if (sql.includes("FROM public.ri_candidate_finance_links WHERE")) return { rows: options.siblings ?? [] };
    if (sql.includes("FROM public.ri_candidate_finance_pac_sources WHERE")) return { rows: options.source ?? [] };
    if (sql.includes("FROM public.ri_candidate_finance_summaries WHERE")) return { rows: [{ newer: options.newerSummary ?? false }] };
    if (sql.includes("INSERT INTO public.ri_candidate_finance_pac_donors") && options.failDonor) throw Error("synthetic_donor_failure");
    return { rows: [{ id }], rowCount: 1 };
  });
  const client = { query, release: vi.fn() }, db = { query: vi.fn(), connect: vi.fn(async () => client) };
  return { db: db as any, query, client, statements: () => query.mock.calls.map(c => c[0]) };
}
function existing() {
  const c = packet().context;
  return { id, candidate_id: c.candidateId, election_id: c.electionId, election_year: 2026, committee_id: "123", committee_name: c.committeeName,
    candidate_name_normalized: "JORDAN EXAMPLE", office_name: "Governor", district: null, link_status: "active", link_source: "manual" };
}
beforeEach(() => vi.mocked(assertRhodeIslandCashPacket).mockReset());
describe("Rhode Island committee cash transactional writer", () => {
  it("checks a verified packet before opening any DB connection", async () => {
    vi.mocked(assertRhodeIslandCashPacket).mockImplementationOnce(() => { throw Error("unverified_packet"); });
    const d = database(); await expect(write({ db: d.db, packet: packet(), reviewedMapping: true })).rejects.toThrow(/unverified_packet/);
    expect(d.db.connect).not.toHaveBeenCalled();
  });
  it("writes direct and committee source/donors inside one shared transaction, preserving outside rows", async () => {
    const d = database(); expect(await write({ db: d.db, packet: packet(), reviewedMapping: true })).toMatchObject({ status: "written", donorsWritten: 1, reportedCashCents: 100_000 });
    const sql = d.statements(); expect(sql[0]).toBe("BEGIN"); expect(sql[sql.length - 1]).toBe("COMMIT");
    const source = sql.findIndex(s => s.includes("INSERT INTO public.ri_candidate_finance_pac_sources"));
    expect(source).toBeGreaterThan(sql.findIndex(s => s.includes("INSERT INTO public.ri_candidate_finance_summaries")));
    expect(sql.some(s => /(?:INSERT INTO|DELETE FROM|UPDATE) public\.ri_candidate_finance_outside/.test(s))).toBe(false);
    const sourceCall = d.query.mock.calls[source] as unknown as [string, unknown[]];
    expect(sourceCall[1]).toContain(packet().observedAt);
    expect(d.client.release).toHaveBeenCalledOnce();
  });
  it("rolls back direct and source writes if a donor insert fails", async () => {
    const d = database({ failDonor: true }); await expect(write({ db: d.db, packet: packet(), reviewedMapping: true })).rejects.toThrow(/synthetic_donor_failure/);
    expect(d.statements()).toContain("ROLLBACK"); expect(d.statements()).not.toContain("COMMIT");
  });
  it("rejects changed canonical context before the first finance mutation", async () => {
    const d = database({ canonical: [] }); await expect(write({ db: d.db, packet: packet(), reviewedMapping: true })).rejects.toThrow(/canonical_context_changed/);
    expect(d.statements().some(s => /INSERT INTO|DELETE FROM|UPDATE public\./.test(s))).toBe(false);
    expect(d.statements()).toContain("ROLLBACK");
  });
  it("rejects duplicate active ownership or inactive account resurrection", async () => {
    for (const siblings of [[existing(), existing()], [{ ...existing(), link_status: "inactive" }]]) {
      const d = database({ siblings }); await expect(write({ db: d.db, packet: packet(), reviewedMapping: true })).rejects.toThrow(/receiving_ownership|receiving_link_changed/);
      expect(d.statements()).toContain("ROLLBACK");
    }
  });
  it("makes an identical source clock/digest a true no-op", async () => {
    const d = database({ siblings: [existing()], source: [{ newer: false, equal: true, source_digest: packet().sourceDigest, receiving_committee_id: "123" }] });
    expect(await write({ db: d.db, packet: packet(), reviewedMapping: true })).toMatchObject({ status: "unchanged", donorsWritten: 0 });
    expect(d.statements()).toContain("ROLLBACK"); expect(d.statements().some(s => s.includes("INSERT INTO"))).toBe(false);
  });
  it.each([
    { newer: true, equal: false, source_digest: "a".repeat(64), receiving_committee_id: "123" },
    { newer: false, equal: true, source_digest: "b".repeat(64), receiving_committee_id: "123" },
  ])("holds older/conflicting source without changing clocks", async source => {
    const d = database({ siblings: [existing()], source: [source] });
    await expect(write({ db: d.db, packet: packet(), reviewedMapping: true })).rejects.toThrow(/older_source_clock|same_clock_source_conflict/);
    expect(d.statements()).toContain("ROLLBACK"); expect(d.statements().some(s => s.includes("INSERT INTO"))).toBe(false);
  });
  it("holds a source older than the current direct-finance snapshot", async () => {
    const d = database({ siblings: [existing()], newerSummary: true });
    await expect(write({ db: d.db, packet: packet(), reviewedMapping: true })).rejects.toThrow(/newer_direct_finance_clock/);
    expect(d.statements()).toContain("ROLLBACK");
  });
});
