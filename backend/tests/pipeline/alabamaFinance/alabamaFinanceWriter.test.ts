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

function pacDonor(overrides: Partial<import("../../../src/pipeline/alabamaFinance/alabamaFinanceWriter.js").AlabamaFinancePacDonorInput> = {}) {
  return {
    committeeId: "24906", committeeName: "Electric Cooperatives of Alabama PAC",
    committeeType: "Political Action Committee" as const, amount: 1500,
    contributionCount: 1, sourceUrl: "https://fcpa.alabamavotes.gov/", ...overrides,
  };
}

describe("Alabama optional PAC snapshots", () => {
  it("writes public donor identities and removes stale donors inside the direct snapshot transaction", async () => {
    const { db, client } = writingDb();
    const result = await replaceAlabamaCandidateFinanceSnapshot({
      db, link, syncedAt,
      summary: { totalReceipts: 38000, directContributionTotal: 38000,
        totalDisbursements: 0, cashOnHand: 38000, sourceUrl: null },
      pacDonors: [pacDonor({ committeeId: " 24906 ", committeeName: " Electric Cooperatives of Alabama PAC " }),
        pacDonor({ committeeId: "24907", committeeName: "Other PAC", amount: 0.29,
          contributionCount: 2, sourceUrl: " " })],
    });
    const inserts = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO public.al_candidate_finance_pac_donors"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[1]).toEqual([LINK_ID, 2026, "24906",
      "Electric Cooperatives of Alabama PAC", "Political Action Committee", 1500, 1,
      "https://fcpa.alabamavotes.gov/", syncedAt.toISOString()]);
    expect(inserts[1]?.[1]?.slice(5, 8)).toEqual([0.29, 2, null]);
    const cleanup = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM public.al_candidate_finance_pac_donors"));
    expect(cleanup?.[1]).toEqual([LINK_ID, 2026, ["24906", "24907"]]);
    expect(result.pacDonorsWritten).toBe(2);
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.findIndex(sql => sql.includes("al_candidate_finance_summaries"))).toBeLessThan(
      statements.findIndex(sql => sql.includes("INSERT INTO public.al_candidate_finance_pac_donors")));
    assertNoOutsideMutations(client.query.mock.calls);
  });

  it("preserves omitted PAC snapshots and clears only an explicit empty snapshot", async () => {
    const omitted = writingDb();
    const omittedResult = await replaceAlabamaCandidateFinanceSnapshot({
      db: omitted.db, link, syncedAt,
    });
    expect(omittedResult).not.toHaveProperty("pacDonorsWritten");
    expect(omitted.client.query.mock.calls.some(([sql]) =>
      String(sql).includes("al_candidate_finance_pac_donors"))).toBe(false);
    const empty = writingDb();
    const emptyResult = await replaceAlabamaCandidateFinanceSnapshot({
      db: empty.db, link, syncedAt, pacDonors: [],
    });
    const cleanup = empty.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM public.al_candidate_finance_pac_donors"));
    expect(cleanup?.[1]).toEqual([LINK_ID, 2026, []]);
    expect(emptyResult.pacDonorsWritten).toBe(0);
    assertNoOutsideMutations(empty.client.query.mock.calls);
  });

  it.each([
    { amount: 0 }, { amount: -1 }, { amount: NaN }, { amount: Infinity },
    { amount: 0.001 }, { amount: 0.1 + 0.2 }, { amount: Number.MAX_SAFE_INTEGER },
    { contributionCount: 0 }, { contributionCount: 1.5 },
    { contributionCount: 2_147_483_648 }, { contributionCount: Number.MAX_SAFE_INTEGER },
    { committeeId: "0" }, { committeeId: "00123" }, { committeeId: "33A" },
    { committeeId: "9007199254740992" }, { committeeName: " " },
    { committeeType: "Principal Campaign Committee" as never },
  ])("rejects an invalid donor snapshot before any transaction: %j", async overrides => {
    const { db, client } = writingDb();
    await expect(replaceAlabamaCandidateFinanceSnapshot({
      db, link, pacDonors: [pacDonor(overrides)],
    })).rejects.toThrow(/Alabama PAC donor/);
    expect(db.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects duplicate trimmed public donor identities before writes", async () => {
    const { db } = writingDb();
    await expect(replaceAlabamaCandidateFinanceSnapshot({
      db, link, pacDonors: [pacDonor(), pacDonor({ committeeId: " 24906 " })],
    })).rejects.toThrow("duplicate public committee ids");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back the direct summary if PAC stale deletion fails", async () => {
    const { db, client } = writingDb();
    client.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("DELETE FROM public.al_candidate_finance_pac_donors")) {
        throw new Error("PAC delete failed");
      }
      return String(sql).includes("INSERT INTO public.al_candidate_finance_links")
        ? { rows: [{ id: LINK_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
    });
    await expect(replaceAlabamaCandidateFinanceSnapshot({
      db, link, syncedAt, pacDonors: [pacDonor()],
      summary: { totalReceipts: 100, directContributionTotal: 100,
        totalDisbursements: 0, cashOnHand: 100, sourceUrl: null },
    })).rejects.toThrow("PAC delete failed");
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some(sql => sql.includes("INSERT INTO public.al_candidate_finance_summaries"))).toBe(true);
    expect(statements.some(sql => sql.includes("INSERT INTO public.al_candidate_finance_pac_donors"))).toBe(true);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
