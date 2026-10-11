import { describe, expect, it, vi } from "vitest";

import { replaceAlabamaCandidateFinanceSnapshot } from "../../../src/pipeline/alabamaFinance/alabamaFinanceWriter.js";

const LINK_ID = "33333333-3333-4333-8333-333333333333";
const link = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  electionId: "22222222-2222-4222-8222-222222222222",
  electionYear: 2026,
  candidateNameNormalized: "JANE DOE",
  officeName: "Governor",
  internalCommitteeId: 206,
  committeeName: "Jane Doe",
  linkSource: "fcpa_race_search" as const,
};
const syncedAt = new Date("2026-10-11T12:00:00.000Z");

function writingDb() {
  const query = vi.fn(async (sql: unknown, _params?: unknown[]) =>
    String(sql).includes("INSERT INTO public.al_candidate_finance_links")
      ? { rows: [{ id: LINK_ID }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  );
  const client = { query, release: vi.fn() };
  return { db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }, client };
}

function assertNoOutsideMutations(calls: readonly unknown[][]) {
  const outsideMutations = calls.filter(([sql]) =>
    /(?:INSERT INTO|UPDATE|DELETE FROM) public\.al_candidate_finance_outside_(?:groups|group_breakdowns)\b/.test(String(sql))
  );
  expect(outsideMutations).toEqual([]);
}

describe("Alabama outside unknown preservation", () => {
  it("updates verified direct figures while preserving stored outside totals, groups and breakdowns", async () => {
    const { db, client } = writingDb();

    const result = await replaceAlabamaCandidateFinanceSnapshot({
      db, link, syncedAt,
      summary: {
        totalReceipts: 38_000,
        directContributionTotal: 38_000,
        totalDisbursements: 1_000,
        cashOnHand: 37_000,
        sourceUrl: "https://fcpa.alabamavotes.gov/",
      },
      directBreakdowns: [],
    });

    const summary = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.al_candidate_finance_summaries")
    );
    expect(summary).toBeDefined();
    for (const column of ["outside_support_total", "outside_oppose_total"]) {
      expect(String(summary?.[0])).toContain(
        column + " = COALESCE(EXCLUDED." + column + ", al_candidate_finance_summaries." + column + ")"
      );
    }
    expect(summary?.[1]).toEqual([
      LINK_ID, 2026, 38_000, 38_000, 1_000, 37_000, null, null,
      "https://fcpa.alabamavotes.gov/", syncedAt.toISOString(),
    ]);
    assertNoOutsideMutations(client.query.mock.calls);
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM public.al_candidate_finance_direct_breakdowns")
    )).toBe(true);
    expect(result).toMatchObject({
      summaryWritten: true, directBreakdownsWritten: 0,
      outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0,
    });
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves outside components when no summary was acquired", async () => {
    const { db, client } = writingDb();
    const result = await replaceAlabamaCandidateFinanceSnapshot({ db, link, syncedAt });

    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO public.al_candidate_finance_summaries")
    )).toBe(false);
    assertNoOutsideMutations(client.query.mock.calls);
    expect(result.summaryWritten).toBe(false);
  });

  it.each([null, 0])("continues replacing cash on hand with %s without erasing outside evidence", async (cashOnHand) => {
    const { db, client } = writingDb();
    await replaceAlabamaCandidateFinanceSnapshot({
      db, link, syncedAt,
      summary: {
        totalReceipts: 100, directContributionTotal: 100,
        totalDisbursements: 200, cashOnHand, sourceUrl: null,
      },
    });

    const summary = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.al_candidate_finance_summaries")
    );
    // NULL represents the existing overdraft policy; zero is a filed balance.
    expect(String(summary?.[0])).toContain("cash_on_hand = EXCLUDED.cash_on_hand");
    expect(String(summary?.[0])).not.toContain("cash_on_hand = COALESCE");
    expect(summary?.[1]?.[5]).toBe(cashOnHand);
    assertNoOutsideMutations(client.query.mock.calls);
  });
});
