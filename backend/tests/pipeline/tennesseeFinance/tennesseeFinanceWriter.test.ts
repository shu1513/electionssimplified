import { describe, expect, it, vi } from "vitest";

import {
  replaceTennesseeCandidateFinanceSnapshot,
  upsertTennesseeFinanceLink,
} from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "JANE DOE",
    officeName: "State Senator",
    district: "4",
    campCandidateId: "1234",
    ownerName: "DOE, JANE",
    committeeName: "DOE, JANE",
    linkStatus: "active" as const,
    linkSource: "tncamp_search" as const,
    sourceUrl: "https://apps.tn.gov/tncamp/public/cpsearch.htm",
    reportListUrl: "https://apps.tn.gov/tncamp/public/replist.htm?id=1234&owner=DOE,%20JANE",
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

describe("tennesseeFinanceWriter", () => {
  it("upserts Tennessee finance links", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    };

    await expect(upsertTennesseeFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.tn_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, camp_candidate_id)");
  });

  it("replaces a Tennessee snapshot with outside groups", async () => {
    const db = createMockDb();

    const result = await replaceTennesseeCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      summary: {
        totalReceipts: 120000,
        directContributionTotal: 120000,
        outsideSupportTotal: 35000,
        outsideOpposeTotal: 5000,
        sourceUrl: "https://apps.tn.gov/tncamp/public/ceresults.htm?d-1341904-e=1&6578706f7274=1",
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 90000,
          contributorCount: 12,
        },
      ],
      outsideGroups: [
        {
          committeeKey: " right  tennessee ",
          committeeName: "RIGHT TENNESSEE",
          supportOppose: "support",
          amount: 35000,
          expenditureCount: 3,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeKey: "RIGHT TENNESSEE",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "TENNESSEE BANK PAC",
          amount: 25000,
          contributorCount: 1,
        },
        {
          committeeKey: "RIGHT TENNESSEE",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "finance_investment",
          amount: 25000,
          contributorCount: 1,
        },
      ],
      classifications: [
        {
          rawLabel: "TENNESSEE BANK PAC",
          labelType: "donor",
          normalizedLabel: "TENNESSEE BANK PAC",
          industrySlug: "finance_investment",
          confidence: "medium",
          classificationSource: "rule",
          matchedRule: "organization_pattern_finance",
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledTimes(1);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries")
    );
    expect(String(summaryCall?.[0])).toContain("outside_support_total = CASE WHEN $9::boolean THEN EXCLUDED.outside_support_total");
    expect(String(summaryCall?.[0])).not.toContain("outside_support_total = COALESCE");
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      120000,
      120000,
      35000,
      5000,
      "https://apps.tn.gov/tncamp/public/ceresults.htm?d-1341904-e=1&6578706f7274=1",
      "2026-07-08T09:10:11.000Z",
      true,
      true,
    ]);
    const outsideGroupCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_outside_groups")
    );
    expect(outsideGroupCall?.[1]?.[2]).toBe("RIGHT TENNESSEE");
    expect(outsideGroupCall?.[1]?.[6]).toBe(3);
    const outsideBreakdownCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCall?.[1]?.slice(2, 7)).toEqual([
      "RIGHT TENNESSEE",
      "support",
      "donor",
      "TENNESSEE BANK PAC",
      25000,
    ]);
    expect(
      db.query.mock.calls.some((call) =>
        String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_group_breakdowns")
      )
    ).toBe(true);
    expect(
      db.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
    ).toBe(true);
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_groups"))).toBe(
      true
    );
  });

  it("deletes stale outside group breakdowns when outside groups are replaced without PAC breakdown data", async () => {
    const db = createMockDb();

    await replaceTennesseeCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-08T09:10:11.000Z"),
      outsideGroups: [],
    });

    const staleBreakdownDelete = db.query.mock.calls.find((call) =>
      String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_group_breakdowns")
    );
    expect(staleBreakdownDelete).toBeDefined();
    expect(staleBreakdownDelete?.[1]).toEqual([LINK_ID, 2026, "[]"]);
  });

  it("preserves outside scalars, groups and breakdowns on a direct-only update", async () => {
    const db = createMockDb();
    await replaceTennesseeCandidateFinanceSnapshot({
      db, link: baseLink(), summary: { totalReceipts: 1000, directContributionTotal: 1000 },
    });
    const summaryCall = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries"));
    expect(summaryCall?.[1]?.slice(4, 6)).toEqual([null, null]);
    expect(summaryCall?.[1]?.slice(8)).toEqual([false, false]);
    expect(String(summaryCall?.[0])).toContain("ELSE tn_candidate_finance_summaries.outside_support_total END");
    expect(String(summaryCall?.[0])).toContain("ELSE tn_candidate_finance_summaries.outside_oppose_total END");
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside"))).toBe(false);
  });

  it("distinguishes explicit removal from unavailable scalars instead of coalescing old money", async () => {
    const db = createMockDb();
    await replaceTennesseeCandidateFinanceSnapshot({
      db, link: baseLink(), summary: { outsideSupportTotal: null }, outsideGroups: [],
    });
    const summaryCall = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries"));
    expect(summaryCall?.[1]?.slice(8)).toEqual([true, false]);
    expect(String(summaryCall?.[0])).not.toContain("outside_support_total = COALESCE");
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside_groups"))).toBe(true);
  });
});

describe("tennesseeFinanceWriter pool boundary", () => {
  it("rejects a supplied PoolClient before issuing any statement, so it can never commit an outer transaction", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      connect: vi.fn(),
      release: vi.fn(),
    };

    await expect(
      replaceTennesseeCandidateFinanceSnapshot({
        db: client as never,
        link: baseLink(),
        syncedAt: new Date("2026-02-03T04:05:06.000Z"),
        summary: { totalReceipts: 1000 },
      } as never)
    ).rejects.toThrow("Tennessee finance snapshot writes must receive a Pool, not a PoolClient");
    expect(client.query).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });
});
