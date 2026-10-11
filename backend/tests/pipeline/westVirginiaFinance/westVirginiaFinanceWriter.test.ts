import { describe, expect, it, vi } from "vitest";
import { replaceWestVirginiaCandidateFinanceSnapshot } from "../../../src/pipeline/westVirginiaFinance/westVirginiaFinanceWriter.js";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const link = { candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
  electionYear: 2026, candidateNameNormalized: "BARRY MARCUM", officeName: "State Lower Chamber Legislator",
  entityId: "1010003884", committeeName: "Committee to Elect Barry Marcum" };
const donor = { committeeId: "1020001470", committeeName: "West Virginia Trial Lawyers Association (LAWPAC)",
  committeeType: "102", totalAmount: 5600, contributionCount: 2 };
const summary = { totalReceipts: 10850, directContributionTotal: 5850, totalDisbursements: 400, sourceUrl: "https://cfrs.wvsos.gov/" };
function mockDb(failOn?: string) {
  const client = { query: vi.fn(async (sql: string, _args?: unknown[]) => {
    if (failOn && sql.includes(failOn)) throw new Error("snapshot write failed");
    return { rows: [{ id: LINK_ID }], rowCount: 1 };
  }), release: vi.fn() };
  return { client, db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } };
}
describe("West Virginia finance writer supplemental snapshots", () => {
  it("writes typed donors in the same transaction without adding them to Raised", async () => {
    const { db, client } = mockDb();
    const result = await replaceWestVirginiaCandidateFinanceSnapshot({ db, link, summary, pacDonors: [donor] });
    expect(result).toMatchObject({ summaryWritten: true, pacDonorsWritten: 1 });
    const calls = client.query.mock.calls;
    expect(calls[0]![0]).toBe("BEGIN"); expect(calls.at(-1)![0]).toBe("COMMIT");
    const receipt = calls.find(([sql]) => sql.includes("INSERT INTO public.wv_candidate_finance_summaries"))!;
    expect(receipt[1]?.slice(2, 5)).toEqual([10850, 5850, 400]);
    const insert = calls.find(([sql]) => sql.includes("INSERT INTO public.wv_candidate_finance_pac_donors"))!;
    expect(insert[1]?.slice(0, 8)).toEqual([LINK_ID, 2026, donor.committeeId, donor.committeeName, "102", 5600, 2, null]);
  });
  it("preserves omitted donors and unavailable outside totals and groups", async () => {
    const { db, client } = mockDb();
    await replaceWestVirginiaCandidateFinanceSnapshot({ db, link, summary });
    const sql = client.query.mock.calls.map(([statement]) => statement);
    expect(sql.some((s) => s.includes("wv_candidate_finance_pac_donors"))).toBe(false);
    expect(sql.some((s) => s.includes("DELETE FROM public.wv_candidate_finance_outside"))).toBe(false);
    const upsert = sql.find((s) => s.includes("INSERT INTO public.wv_candidate_finance_summaries"))!;
    expect(upsert).toContain("COALESCE(EXCLUDED.outside_support_total");
    expect(upsert).toContain("COALESCE(EXCLUDED.outside_oppose_total");
  });
  it("clears a validated empty donor-only snapshot without modifying summary/outside", async () => {
    const { db, client } = mockDb();
    const result = await replaceWestVirginiaCandidateFinanceSnapshot({ db, link, pacDonors: [] });
    expect(result).toMatchObject({ summaryWritten: false, pacDonorsWritten: 0 });
    const calls = client.query.mock.calls;
    expect(calls.find(([s]) => s.includes("DELETE FROM public.wv_candidate_finance_pac_donors"))?.[1]).toEqual([LINK_ID, 2026, []]);
    expect(calls.some(([s]) => s.includes("wv_candidate_finance_summaries"))).toBe(false);
  });
  it.each(["INSERT INTO public.wv_candidate_finance_pac_donors", "DELETE FROM public.wv_candidate_finance_pac_donors", "SET source_transactions"])(
    "rolls back all money and evidence when %s fails", async (failOn) => {
      const { db, client } = mockDb(failOn);
      await expect(replaceWestVirginiaCandidateFinanceSnapshot({ db, link, summary, pacDonors: [donor],
        outsideGroups: [{ committeeId: "1040002875", committeeName: "West Virginia Strong", supportOppose: "support",
          amount: 897.1, sourceTransactions: [{ transactionID: 562631, reportID: 32245, reportVersionID: "2" }] }],
      })).rejects.toThrow("snapshot write failed");
      const sql = client.query.mock.calls.map(([s]) => s);
      expect(sql.at(-1)).toBe("ROLLBACK"); expect(sql).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalledOnce(); expect(db.query).not.toHaveBeenCalled();
  });
  it("writes electronic IE provenance after its group in the same transaction", async () => {
    const { db, client } = mockDb();
    const sourceTransactions = [{ transactionID: 562631, reportID: 32245, reportVersionID: "2" }];
    await replaceWestVirginiaCandidateFinanceSnapshot({ db, link, summary: { ...summary, outsideSupportTotal: 897.1, outsideOpposeTotal: 0 },
      outsideGroups: [{ committeeId: "1040002875", committeeName: "West Virginia Strong", supportOppose: "support", amount: 897.1, sourceTransactions }] });
    const calls = client.query.mock.calls;
    const groupIndex = calls.findIndex(([s]) => s.includes("INSERT INTO public.wv_candidate_finance_outside_groups"));
    const proofIndex = calls.findIndex(([s]) => s.includes("SET source_transactions"));
    expect(proofIndex).toBeGreaterThan(groupIndex);
    expect(calls[proofIndex]![1]).toEqual([LINK_ID, 2026, "1040002875", "support", JSON.stringify(sourceTransactions)]);
  });
  it.each([{ totalAmount: -1 }, { totalAmount: Number.NaN }, { contributionCount: 0 }, { contributionCount: 1.5 },
    { committeeType: "101" }, { committeeType: "103" }, { committeeId: "invalid" }, { committeeName: " " }])(
    "rejects invalid donor evidence before acquiring a connection: %j", async (invalid) => {
      const { db } = mockDb();
      await expect(replaceWestVirginiaCandidateFinanceSnapshot({ db, link, pacDonors: [{ ...donor, ...invalid }] })).rejects.toThrow();
      expect(db.connect).not.toHaveBeenCalled();
  });
  it("rejects duplicate identities and outside groups without evidence before writing", async () => {
    const { db } = mockDb();
    await expect(replaceWestVirginiaCandidateFinanceSnapshot({ db, link, pacDonors: [donor, donor] })).rejects.toThrow("duplicate ids");
    await expect(replaceWestVirginiaCandidateFinanceSnapshot({ db, link, outsideGroups: [{
      committeeId: "1040002875", committeeName: "West Virginia Strong", supportOppose: "support", amount: 897.1, sourceTransactions: [],
    }] })).rejects.toThrow("source transaction provenance");
    expect(db.connect).not.toHaveBeenCalled();
  });
});
