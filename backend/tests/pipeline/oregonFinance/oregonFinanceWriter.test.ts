import { describe, expect, it, vi } from "vitest";

import {
  replaceOregonCandidateFinanceSnapshot,
  upsertOregonFinanceLink,
} from "../../../src/pipeline/oregonFinance/oregonFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-06-25T19:00:00.000Z");

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function createTransactionalMockDb() {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 });
  const client = { query, release: vi.fn() };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2022,
    candidateNameNormalized: "TINA KOTEK",
    officeName: "Governor",
    district: null,
    committeeId: "4792",
    committeeName: "Friends of Tina Kotek",
    linkSource: "orestar" as const,
    sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
    lastVerifiedAt: NOW,
  };
}

describe("oregonFinanceWriter", () => {
  it("preserves accepted outside totals and groups on a contribution-only refresh", async () => {
    const db = createTransactionalMockDb();
    await replaceOregonCandidateFinanceSnapshot({
      db, link: baseLink(), summary: { directContributionTotal: 1000 }, syncedAt: NOW,
    });
    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.or_candidate_finance_summaries")
    );
    expect(String(summaryCall?.[0])).toContain(
      "outside_support_total = COALESCE(EXCLUDED.outside_support_total, or_candidate_finance_summaries.outside_support_total)"
    );
    expect(String(summaryCall?.[0])).toContain(
      "outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, or_candidate_finance_summaries.outside_oppose_total)"
    );
    expect(summaryCall?.[1]?.slice(6, 8)).toEqual([null, null]);
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("or_candidate_finance_outside_"))).toBe(false);
  });
  it("upserts Oregon finance links and returns the link id", async () => {
    const db = createMockDb();

    await expect(upsertOregonFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.or_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, committee_id)");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2022,
      "TINA KOTEK",
      "Governor",
      null,
      "4792",
      "Friends of Tina Kotek",
      "active",
      "orestar",
      "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
      "2026-06-25T19:00:00.000Z",
    ]);
  });

  it("defaults optional link metadata safely", async () => {
    const db = createMockDb();

    await expect(
      upsertOregonFinanceLink({
        db,
        link: {
          ...baseLink(),
          district: " Statewide ",
          linkSource: undefined,
          sourceUrl: " ",
          lastVerifiedAt: null,
        },
      })
    ).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2022,
      "TINA KOTEK",
      "Governor",
      "Statewide",
      "4792",
      "Friends of Tina Kotek",
      "active",
      "manual",
      null,
      null,
    ]);
  });

  it("replaces an Oregon finance snapshot inside one transaction", async () => {
    const db = createTransactionalMockDb();

    const result = await replaceOregonCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-06-26T03:04:05.000Z"),
      summary: {
        totalReceipts: 12_000_000,
        directContributionTotal: 10_549.99,
        outsideSupportTotal: 67_766.61,
        outsideOpposeTotal: 75_000,
        sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Partner",
          amount: 10_000,
          contributorCount: 1,
          sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
        },
        {
          categoryType: "contribution_size",
          categoryName: "$5,000+",
          amount: 10_000,
          contributorCount: 1,
          sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
        },
      ],
      outsideGroups: [
        {
          sponsorId: "22333",
          sponsorName: "2022 Our Oregon Voter Guide",
          supportOppose: "support",
          amount: 67_766.61,
          sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4406263",
        },
      ],
      outsideGroupBreakdowns: [
        {
          sponsorId: "22333",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "SEIU Local 503",
          amount: 35_000,
          contributorCount: 1,
          sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5001",
        },
        {
          sponsorId: "22333",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "labor_unions",
          amount: 35_000,
          contributorCount: 1,
          sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5001",
        },
      ],
      classifications: [
        {
          rawLabel: "SEIU Local 503",
          labelType: "donor",
          normalizedLabel: "SEIU LOCAL 503",
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
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledTimes(1);

    const sql = db.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.or_candidate_finance_summaries"))).toBe(true);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.or_candidate_finance_direct_breakdowns"))).toHaveLength(2);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.or_candidate_finance_outside_groups"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.or_candidate_finance_outside_group_breakdowns"))).toHaveLength(2);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.finance_label_classifications"))).toHaveLength(1);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.or_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.or_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.or_candidate_finance_outside_group_breakdowns"))).toBe(true);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.or_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2022,
      12_000_000,
      10_549.99,
      null,
      null,
      67_766.61,
      75_000,
      "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
      "2026-06-26T03:04:05.000Z",
    ]);
  });

  it("deletes stale keys only for supplied snapshot sections", async () => {
    const db = createTransactionalMockDb();

    await replaceOregonCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: NOW,
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Teacher",
          amount: 450,
          contributorCount: 2,
        },
      ],
    });

    expect(db.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "INSERT INTO public.or_candidate_finance_links",
      "INSERT INTO public.or_candidate_finance_direct_breakdowns",
      "DELETE FROM public.or_candidate_finance_direct_breakdowns",
      "COMMIT",
    ]);
    expect(db.query.mock.calls.at(-2)?.[1]).toEqual([
      LINK_ID,
      2022,
      JSON.stringify([{ category_type: "occupation", category_name: "Teacher" }]),
    ]);
  });

  it("rejects query-only and PoolClient-like snapshot writers so writes stay atomic", async () => {
    const queryOnlyDb = { query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }) };
    await expect(
      replaceOregonCandidateFinanceSnapshot({
        db: queryOnlyDb as never,
        link: baseLink(),
        summary: { directContributionTotal: 1000 },
      })
    ).rejects.toThrow("Oregon finance snapshot writes must receive a Pool");
    expect(queryOnlyDb.query).not.toHaveBeenCalled();

    const clientLikeDb = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    await expect(
      replaceOregonCandidateFinanceSnapshot({
        db: clientLikeDb as never,
        link: baseLink(),
        summary: { directContributionTotal: 1000 },
      })
    ).rejects.toThrow("Oregon finance snapshot writes must receive a Pool, not a PoolClient");
    expect(clientLikeDb.query).not.toHaveBeenCalled();
  });

  it("rejects outside group breakdowns without same-snapshot outside groups", async () => {
    const db = createTransactionalMockDb();

    await expect(
      replaceOregonCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroupBreakdowns: [
          {
            sponsorId: "22333",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "SEIU Local 503",
            amount: 35_000,
          },
        ],
      })
    ).rejects.toThrow("Oregon outside group breakdowns require outside groups in the same snapshot");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("validates required fields and nonnegative amounts", async () => {
    const db = createMockDb();
    await expect(
      upsertOregonFinanceLink({ db, link: { ...baseLink(), committeeId: " " } })
    ).rejects.toThrow("Oregon ORESTAR committee ID is required");

    await expect(
      replaceOregonCandidateFinanceSnapshot({
        db: createTransactionalMockDb(),
        link: baseLink(),
        directBreakdowns: [
          {
            categoryType: "occupation",
            categoryName: "Attorney",
            amount: -1,
          },
        ],
      })
    ).rejects.toThrow("direct breakdown amount must be a nonnegative number");
  });
});
