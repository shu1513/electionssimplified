import { describe, expect, it, vi } from "vitest";

import {
  replaceSouthCarolinaCandidateFinanceSnapshot,
  upsertSouthCarolinaFinanceLink,
  type SouthCarolinaFinancePacDonorInput,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://ethicsfiling.sc.gov/public";
const VERIFIED_AT = new Date("2026-08-27T00:00:00.000Z");

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "PAMELA EVETTE",
    officeName: "Governor",
    district: null,
    candidateFilerId: 54395,
    filerName: "Evette, Pamela S",
    linkSource: "ethics_filer_search" as const,
    sourceUrl: SOURCE_URL,
    lastVerifiedAt: VERIFIED_AT,
  };
}

function successfulQuery(sql: unknown) {
  if (String(sql).includes("INSERT INTO public.sc_candidate_finance_links")) {
    return Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

describe("southCarolinaFinanceWriter", () => {
  it("writes candidate-filer link identity and protects manual links", async () => {
    const db = { query: vi.fn(successfulQuery) };

    await expect(
      upsertSouthCarolinaFinanceLink({ db, link: baseLink() }),
    ).resolves.toEqual({
      linkId: LINK_ID,
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "link_source='manual'",
    );
    const insert = db.query.mock.calls[1];
    expect(String(insert?.[0])).toContain("candidate_filer_id");
    expect(String(insert?.[0])).toContain("candidate_filer_name");
    expect(insert?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "PAMELA EVETTE",
      "Governor",
      null,
      "54395",
      "Evette, Pamela S",
      "active",
      "ethics_filer_search",
      SOURCE_URL,
      VERIFIED_AT.toISOString(),
    ]);
  });

  it("updates filed direct money without replacing unavailable outside components", async () => {
    const client = { query: vi.fn(successfulQuery), release: vi.fn() };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        syncedAt: new Date("2026-08-27T00:00:00.000Z"),
        summary: {
          totalReceipts: 6_195_452.22,
          directContributionTotal: 4_943_600.56,
          totalDisbursements: 2_944_738.53,
          cashOnHand: 552_415.77,
          sourceUrl: SOURCE_URL,
        },
        directBreakdowns: [
          {
            categoryType: "occupation",
            categoryName: "Attorney",
            amount: 6_000,
          },
          {
            categoryType: "contribution_size",
            categoryName: "$100-$249",
            amount: 4_000,
          },
        ],
      }),
    ).resolves.toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
    });

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();

    const calls = client.query.mock.calls;
    const summary = calls.find((call) =>
      String(call[0]).includes("sc_candidate_finance_summaries"),
    );
    const summarySql = String(summary?.[0]);
    // Missing direct and outside amounts preserve prior values independently.
    expect(summarySql).toContain(
      "total_receipts = COALESCE(EXCLUDED.total_receipts, sc_candidate_finance_summaries.total_receipts)",
    );
    expect(summarySql).toContain(
      "outside_support_total = COALESCE(EXCLUDED.outside_support_total, sc_candidate_finance_summaries.outside_support_total)",
    );
    expect(summarySql).toContain(
      "outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, sc_candidate_finance_summaries.outside_oppose_total)",
    );
    // NULL means unavailable, not a verified zero.
    expect(summary?.[1]?.slice(2, 9)).toEqual([
      6_195_452.22,
      4_943_600.56,
      2_944_738.53,
      552_415.77,
      null,
      null,
      SOURCE_URL,
    ]);

    const directInserts = calls.filter((call) =>
      String(call[0]).includes(
        "INSERT INTO public.sc_candidate_finance_direct_breakdowns",
      ),
    );
    expect(directInserts.map((call) => call[1]?.[2])).toEqual([
      "occupation",
      "contribution_size",
    ]);

    // No outside acquisition means no replacement or deletion.
    expect(
      calls.some((call) =>
        String(call[0]).includes(
          "INSERT INTO public.sc_candidate_finance_outside_groups",
        ),
      ),
    ).toBe(false);
    expect(
      calls.some((call) =>
        String(call[0]).includes(
          "DELETE FROM public.sc_candidate_finance_outside_groups",
        ),
      ),
    ).toBe(false);
    expect(
      calls.some((call) =>
        String(call[0]).includes(
          "DELETE FROM public.sc_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toBe(false);

    const supersede = calls.find(
      (call) =>
        String(call[0]).includes("UPDATE public.sc_candidate_finance_links") &&
        String(call[0]).includes("id <>"),
    );
    expect(String(supersede?.[0])).toContain(
      "link_source = 'ethics_filer_search'",
    );
  });

  it("accepts a negative cash-on-hand balance (signed ending balance)", async () => {
    const client = { query: vi.fn(successfulQuery), release: vi.fn() };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await replaceSouthCarolinaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: {
        totalReceipts: 1_000,
        directContributionTotal: 1_000,
        totalDisbursements: 1_500,
        cashOnHand: -500,
        sourceUrl: SOURCE_URL,
      },
    });

    const summary = client.query.mock.calls.find((call) =>
      String(call[0]).includes("sc_candidate_finance_summaries"),
    );
    expect(summary?.[1]?.[5]).toBe(-500);
  });

  it("writes zeros and clears stale direct rows after a filed-zero run", async () => {
    const client = { query: vi.fn(successfulQuery), release: vi.fn() };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await replaceSouthCarolinaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: {
        totalReceipts: 0,
        directContributionTotal: 0,
        totalDisbursements: 0,
        cashOnHand: 0,
        sourceUrl: SOURCE_URL,
      },
      directBreakdowns: [],
    });

    const calls = client.query.mock.calls;
    const summary = calls.find((call) =>
      String(call[0]).includes("sc_candidate_finance_summaries"),
    );
    expect(summary?.[1]?.slice(2, 9)).toEqual([
      0,
      0,
      0,
      0,
      null,
      null,
      SOURCE_URL,
    ]);
    expect(
      calls.some((call) =>
        String(call[0]).includes(
          "DELETE FROM public.sc_candidate_finance_direct_breakdowns",
        ),
      ),
    ).toBe(true);
  });

  it("rejects non-positive and non-integer candidate filer IDs before database writes", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };

    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db: db as never,
        link: { ...baseLink(), candidateFilerId: 0 },
      }),
    ).rejects.toThrow("Invalid South Carolina candidate filer ID: 0");
    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db: db as never,
        link: { ...baseLink(), candidateFilerId: 1.5 },
      }),
    ).rejects.toThrow("Invalid South Carolina candidate filer ID: 1.5");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back and releases the client when a snapshot query fails", async () => {
    const client = {
      query: vi.fn((sql: unknown) => {
        if (String(sql).includes("sc_candidate_finance_summaries")) {
          return Promise.reject(new Error("summary failed"));
        }
        return successfulQuery(sql);
      }),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        summary: {
          totalReceipts: 1,
          directContributionTotal: 1,
          totalDisbursements: 0,
          cashOnHand: 1,
          sourceUrl: SOURCE_URL,
        },
      }),
    ).rejects.toThrow("summary failed");

    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some((call) => call[0] === "COMMIT")).toBe(
      false,
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});

function reportedDonor(
  overrides: Partial<SouthCarolinaFinancePacDonorInput> = {},
): SouthCarolinaFinancePacDonorInput {
  return {
    committeeId: "reported:SOURCE PAC",
    committeeName: "Source PAC",
    amount: 100,
    contributionCount: 1,
    sourceUrl: SOURCE_URL,
    recognitionMethod: "political_name_hint",
    sourceReportedClass: "group_yes",
    ...overrides,
  };
}
function donorDb(fail = false) {
  const client = {
    query: vi.fn((sql: unknown) =>
      fail && String(sql).includes("sc_candidate_finance_pac_donors")
        ? Promise.reject(new Error("donor failed"))
        : successfulQuery(sql),
    ),
    release: vi.fn(),
  };
  return {
    client,
    db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) },
  };
}
describe("SC reported donor snapshot", () => {
  it("omission preserves donor/outside rows even with no summary", async () => {
    const { client, db } = donorDb();
    const result = await replaceSouthCarolinaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
    });
    expect(result).not.toHaveProperty("pacDonorsWritten");
    expect(
      client.query.mock.calls.some(([sql]) =>
        /sc_candidate_finance_(?:pac_donors|outside)/.test(String(sql)),
      ),
    ).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("explicit complete empty clears only link/year donors in the snapshot transaction", async () => {
    const { client, db } = donorDb();
    const result = await replaceSouthCarolinaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      pacDonors: [],
    });
    expect(result.pacDonorsWritten).toBe(0);
    const deletion = client.query.mock.calls.find(([sql]) =>
      String(sql).includes(
        "DELETE FROM public.sc_candidate_finance_pac_donors",
      ),
    );
    expect(deletion?.[1]).toEqual([LINK_ID, 2026, []]);
    expect(String(deletion?.[0])).toContain(
      "donor.link_id = $1::uuid AND donor.election_year = $2",
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("stores signed/zero positions and punctuation with honest source markers", async () => {
    const { client, db } = donorDb();
    const result = await replaceSouthCarolinaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      pacDonors: [
        reportedDonor({ amount: -0.29, contributionCount: 2 }),
        reportedDonor({
          committeeId: "reported:OTHER P.A.C.",
          committeeName: "Other P.A.C.",
          amount: 0,
        }),
      ],
    });
    expect(result.pacDonorsWritten).toBe(2);
    const inserts = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes(
        "INSERT INTO public.sc_candidate_finance_pac_donors",
      ),
    );
    expect(inserts.map((c) => c[1]?.slice(2, 9))).toEqual([
      [
        "reported:SOURCE PAC",
        "Source PAC",
        -0.29,
        2,
        SOURCE_URL,
        "political_name_hint",
        "group_yes",
      ],
      [
        "reported:OTHER P.A.C.",
        "Other P.A.C.",
        0,
        1,
        SOURCE_URL,
        "political_name_hint",
        "group_yes",
      ],
    ]);
  });
  it("donor hook failure rolls back direct summary too", async () => {
    const { client, db } = donorDb(true);
    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        pacDonors: [reportedDonor()],
        summary: {
          totalReceipts: 100,
          directContributionTotal: 100,
          totalDisbursements: 0,
          cashOnHand: 100,
          sourceUrl: SOURCE_URL,
        },
      }),
    ).rejects.toThrow("donor failed");
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "INSERT INTO public.sc_candidate_finance_summaries",
        ),
      ),
    ).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(
      false,
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
  it.each([
    { committeeId: "123" },
    { committeeId: "reported:SOURCE" },
    { committeeName: "" },
    { amount: 0.001 },
    { amount: NaN },
    { amount: Infinity },
    { amount: 90071992547410 },
    { contributionCount: 0 },
    { contributionCount: 1.5 },
    { contributionCount: 2147483648 },
    { recognitionMethod: "other" as "political_name_hint" },
    { sourceReportedClass: "group_no" as "group_yes" },
  ])("rejects bad donor before connect: %j", async (overrides) => {
    const { db } = donorDb();
    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        pacDonors: [reportedDonor(overrides)],
      }),
    ).rejects.toThrow();
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("rejects duplicate identities before connect", async () => {
    const { db } = donorDb();
    await expect(
      replaceSouthCarolinaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        pacDonors: [reportedDonor(), reportedDonor()],
      }),
    ).rejects.toThrow("Duplicate");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("snapshots caller identity and donor money before awaiting connection", async () => {
    const { client, db } = donorDb();
    const link = baseLink(),
      donor = reportedDonor();
    db.connect.mockImplementation(async () => {
      link.candidateFilerId = 999;
      donor.amount = 999;
      donor.committeeName = "Changed";
      return client;
    });
    await replaceSouthCarolinaCandidateFinanceSnapshot({
      db,
      link,
      pacDonors: [donor],
    });
    const linkInsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.sc_candidate_finance_links"),
    );
    const donorInsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes(
        "INSERT INTO public.sc_candidate_finance_pac_donors",
      ),
    );
    expect(linkInsert?.[1]?.[6]).toBe("54395");
    expect(donorInsert?.[1]?.slice(3, 5)).toEqual(["Source PAC", 100]);
  });
});
