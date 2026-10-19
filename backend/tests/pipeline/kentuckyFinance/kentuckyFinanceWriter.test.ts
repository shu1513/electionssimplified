import { afterEach, describe, expect, it, vi } from "vitest";

import {
  replaceKentuckyCandidateFinanceSnapshot,
  upsertKentuckyFinanceLink,
} from "../../../src/pipeline/kentuckyFinance/kentuckyFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2023,
    candidateNameNormalized: "ANDY BESHEAR",
    officeName: "Governor",
    district: " ",
    candidateKey: " andy beshear|governor|statewide|2023 ",
    committeeKey: " beshear campaign committee ",
    committeeName: "Beshear Campaign Committee",
    linkStatus: "active" as const,
    linkSource: "kref_public_search" as const,
    sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/ToCandidateSearch",
    lastVerifiedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function createMockDb() {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 });
  const client = {
    query,
    release: vi.fn(),
  };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

describe("kentuckyFinanceWriter", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("preserves 2026 legacy IE totals and all outside rows when the independent IE gate is on", async () => {
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("KENTUCKY_REPORTED_IE_ENABLED", "true");
    const db = createMockDb();
    const result = await replaceKentuckyCandidateFinanceSnapshot({db,link:{...baseLink(),electionYear:2026},
      summary:{totalReceipts:1000,outsideSupportTotal:0,outsideOpposeTotal:0}});
    expect(result.outsideGroupsWritten).toBe(0);
    const sql = db.query.mock.calls.map(call => String(call[0]));
    expect(sql.some(s => /(?:INSERT INTO|DELETE FROM) public\.ky_candidate_finance_outside/.test(s))).toBe(false);
    const summary = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.ky_candidate_finance_summaries"));
    expect(summary?.[1]?.slice(6,8)).toEqual([null,null]);
    expect(summary?.[1]?.[10]).toBe(true);
    expect(String(summary?.[0])).toContain("CASE WHEN $11::boolean THEN ky_candidate_finance_summaries.outside_support_total");
  });
  it("upserts Kentucky finance links with normalized keys and nullable fields", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    };

    await expect(upsertKentuckyFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });

    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.ky_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, committee_key)");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2023,
      "ANDY BESHEAR",
      "Governor",
      null,
      "ANDY BESHEAR|GOVERNOR|STATEWIDE|2023",
      "BESHEAR CAMPAIGN COMMITTEE",
      "Beshear Campaign Committee",
      "active",
      "kref_public_search",
      "https://secure.kentucky.gov/kref/publicsearch/ToCandidateSearch",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("replaces a Kentucky finance snapshot inside a transaction", async () => {
    const db = createMockDb();

    const result = await replaceKentuckyCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      summary: {
        totalReceipts: 5_000_000,
        directContributionTotal: 4_750_000,
        cashOnHand: -12_500,
        outsideSupportTotal: 900_000,
        outsideOpposeTotal: 125_000,
        sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/ExportContributors",
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 500_000,
          contributorCount: 1200,
          sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/ExportContributors",
        },
      ],
      outsideGroups: [
        {
          committeeKey: " kentucky future project action fund ",
          committeeName: "Kentucky Future Project Action Fund",
          supportOppose: "support",
          amount: 900_000,
          sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/IndependentExpenditureSearch",
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeKey: "Kentucky Future Project Action Fund",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "labor_unions",
          amount: 900_000,
          contributorCount: 3,
          sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/ToOrganizationSearch",
        },
      ],
      classifications: [
        {
          rawLabel: "Kentucky Labor PAC",
          labelType: "donor",
          normalizedLabel: "KENTUCKY LABOR PAC",
          industrySlug: "labor_unions",
          confidence: "medium",
          classificationSource: "rule",
          matchedRule: "organization_pattern_labor_unions",
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledTimes(1);

    const sql = db.query.mock.calls.map((call) => String(call[0]));
    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ky_candidate_finance_summaries")
    );
    expect(String(summaryCall?.[0])).toContain("total_receipts = EXCLUDED.total_receipts");
    expect(String(summaryCall?.[0])).toContain("cash_on_hand = EXCLUDED.cash_on_hand");
    expect(String(summaryCall?.[0])).toContain("source_url = EXCLUDED.source_url");
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2023,
      5_000_000,
      4_750_000,
      null,
      -12_500,
      900_000,
      125_000,
      "https://secure.kentucky.gov/kref/publicsearch/ExportContributors",
      "2026-07-08T09:10:11.000Z",
      false,
    ]);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.ky_candidate_finance_direct_breakdowns"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.ky_candidate_finance_outside_groups"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.ky_candidate_finance_outside_group_breakdowns"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.finance_label_classifications"))).toHaveLength(1);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.ky_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.ky_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.ky_candidate_finance_outside_group_breakdowns"))).toBe(true);
  });

  it("normalizes outside committee keys consistently for groups, breakdowns, and stale deletes", async () => {
    const db = createMockDb();

    await replaceKentuckyCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      outsideGroups: [
        {
          committeeKey: " kentucky  future project action fund ",
          committeeName: "Kentucky Future Project Action Fund",
          supportOppose: "support",
          amount: 900_000,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeKey: "Kentucky Future Project Action Fund",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "education",
          amount: 900_000,
        },
      ],
    });

    const outsideGroupCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ky_candidate_finance_outside_groups")
    );
    const outsideBreakdownCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ky_candidate_finance_outside_group_breakdowns")
    );
    const deleteOutsideBreakdownsCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("DELETE FROM public.ky_candidate_finance_outside_group_breakdowns")
    );
    const deleteOutsideGroupsCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("DELETE FROM public.ky_candidate_finance_outside_groups")
    );

    expect(outsideGroupCall?.[1]?.[2]).toBe("KENTUCKY FUTURE PROJECT ACTION FUND");
    expect(outsideBreakdownCall?.[1]?.[2]).toBe("KENTUCKY FUTURE PROJECT ACTION FUND");
    expect(JSON.parse(String(deleteOutsideBreakdownsCall?.[1]?.[2]))).toEqual([
      {
        committee_key: "KENTUCKY FUTURE PROJECT ACTION FUND",
        support_oppose: "support",
        category_type: "industry",
        category_name: "education",
      },
    ]);
    expect(JSON.parse(String(deleteOutsideGroupsCall?.[1]?.[2]))).toEqual([
      {
        committee_key: "KENTUCKY FUTURE PROJECT ACTION FUND",
        support_oppose: "support",
      },
    ]);
  });

  it("deletes omitted breakdown sections when replacing a snapshot", async () => {
    const db = createMockDb();

    const result = await replaceKentuckyCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      summary: {
        outsideSupportTotal: 0,
        outsideOpposeTotal: 0,
      },
    });

    expect(result).toMatchObject({
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
    });
    const sql = db.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("DELETE FROM public.ky_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.ky_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.ky_candidate_finance_outside_group_breakdowns"))).toBe(true);
  });

  it("rejects outside group breakdowns without matching outside groups", async () => {
    const db = createMockDb();

    await expect(
      replaceKentuckyCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroups: [],
        outsideGroupBreakdowns: [
          {
            committeeKey: "Kentucky Future Project Action Fund",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Kentucky Labor PAC",
            amount: 1000,
          },
        ],
      })
    ).rejects.toThrow("Kentucky outside group breakdowns require matching outside groups in the same snapshot");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects invalid link inputs before querying", async () => {
    const db = {
      query: vi.fn(),
    };

    await expect(
      upsertKentuckyFinanceLink({
        db,
        link: {
          ...baseLink(),
          candidateKey: " ",
        },
      })
    ).rejects.toThrow("Kentucky candidate key is required");

    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects query-only and PoolClient-like snapshot writers so writes stay atomic", async () => {
    const queryOnlyDb = { query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }) };
    await expect(
      replaceKentuckyCandidateFinanceSnapshot({
        db: queryOnlyDb as never,
        link: baseLink(),
        summary: { totalReceipts: 1000 },
      })
    ).rejects.toThrow("Kentucky finance snapshot writes must receive a Pool");
    expect(queryOnlyDb.query).not.toHaveBeenCalled();

    const clientLikeDb = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    await expect(
      replaceKentuckyCandidateFinanceSnapshot({
        db: clientLikeDb as never,
        link: baseLink(),
        summary: { totalReceipts: 1000 },
      })
    ).rejects.toThrow("Kentucky finance snapshot writes must receive a Pool, not a PoolClient");
    expect(clientLikeDb.query).not.toHaveBeenCalled();
  });

  it("rolls back and releases the client when a transactional write fails", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockRejectedValueOnce(new Error("write failed"))
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    await expect(
      replaceKentuckyCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        summary: { totalReceipts: 1000 },
      })
    ).rejects.toThrow("write failed");

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
