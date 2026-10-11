import { describe, expect, it, vi } from "vitest";

import {
  deactivatePennsylvaniaFinanceLinksForCandidateElection,
  replacePennsylvaniaCandidateFinanceSnapshot,
  upsertPennsylvaniaFinanceLink,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_URL = "https://www.pa.gov/content/dam/copapwp-pagov/en/dos/resources/voting-and-elections/campaign-finance/campaign-finance-data/2026.zip";

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "JANE DOE",
    officeName: "Governor",
    filerId: "12345",
    filerName: "JANE DOE FOR GOVERNOR",
    linkSource: "pa_bulk" as const,
    sourceUrl: SOURCE_URL,
    lastVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("pennsylvaniaFinanceWriter", () => {
  it("upserts Pennsylvania finance links and returns the link id", async () => {
    const db = createMockDb();

    await expect(upsertPennsylvaniaFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.pa_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, filer_id)");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("WHEN pa_candidate_finance_links.link_source = 'manual'");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "JANE DOE",
      "Governor",
      null,
      "12345",
      "JANE DOE FOR GOVERNOR",
      "active",
      "pa_bulk",
      SOURCE_URL,
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("does not deactivate manually curated Pennsylvania finance links", async () => {
    const db = createMockDb();

    await expect(
      deactivatePennsylvaniaFinanceLinksForCandidateElection({
        db,
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    ).resolves.toBe(1);

    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_source IS DISTINCT FROM 'manual'");
  });

  it("replaces a Pennsylvania finance snapshot inside a transaction", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    const result = await replacePennsylvaniaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-02-03T04:05:06.000Z"),
      summary: {
        totalReceipts: 350,
        directContributionTotal: 350,
        sourceUrl: SOURCE_URL,
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 350,
          contributorCount: 2,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideGroups: [
        {
          groupId: "outside:1",
          groupName: "PENNSYLVANIANS FOR ACTION",
          supportOppose: "support",
          amount: 1000,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideGroupBreakdowns: [
        {
          groupId: "outside:1",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "real_estate",
          amount: 1000,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      pacDonorsWritten: 0,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
    });
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);

    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_summaries"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.pa_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("INSERT INTO public.pa_candidate_finance_outside_group_breakdowns"))).toBe(true);
  });

  it("replaces committee donors for the cycle and skips zero-amount rows", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    const result = await replacePennsylvaniaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-02-03T04:05:06.000Z"),
      pacDonors: [
        { committeeId: "7001", committeeName: "Greater PA Carpenters PAC", amount: 1500, contributionCount: 2, sourceUrl: SOURCE_URL },
        { committeeId: "7002", committeeName: "Friends of Kim Ward", amount: 0, contributionCount: 0, sourceUrl: SOURCE_URL },
      ],
    });

    expect(result.pacDonorsWritten).toBe(1);
    const calls = client.query.mock.calls.map((call) => [String(call[0]), call[1]] as const);
    const insert = calls.find(([sql]) => sql.includes("INSERT INTO public.pa_candidate_finance_pac_donors"));
    expect(insert?.[1]).toEqual([LINK_ID, 2026, "7001", "Greater PA Carpenters PAC", 1500, 2, SOURCE_URL, "2026-02-03T04:05:06.000Z"]);
    const stale = calls.find(([sql]) => sql.includes("DELETE FROM public.pa_candidate_finance_pac_donors"));
    expect(stale?.[1]).toEqual([LINK_ID, 2026, ["7001"]]);
  });

  it("preserves prior outside totals when a partial refresh does not have expenditure data", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    await replacePennsylvaniaCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-02-03T04:05:06.000Z"),
      summary: {
        totalReceipts: 350,
        directContributionTotal: 350,
        outsideSupportTotal: null,
        outsideOpposeTotal: null,
      },
    });

    const summaryCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.pa_candidate_finance_summaries")
    );
    expect(String(summaryCall?.[0])).toContain(
      "outside_support_total = COALESCE(\n          EXCLUDED.outside_support_total,\n          pa_candidate_finance_summaries.outside_support_total\n        )"
    );
    expect(String(summaryCall?.[0])).toContain(
      "outside_oppose_total = COALESCE(\n          EXCLUDED.outside_oppose_total,\n          pa_candidate_finance_summaries.outside_oppose_total\n        )"
    );
    expect(summaryCall?.[1]?.[6]).toBeNull();
    expect(summaryCall?.[1]?.[7]).toBeNull();
  });

  it("rejects outside breakdown snapshots without matching outside groups", async () => {
    const db = createMockDb();

    await expect(
      replacePennsylvaniaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroups: [
          {
            groupId: "outside:1",
            groupName: "PENNSYLVANIANS FOR ACTION",
            supportOppose: "support",
            amount: 1000,
          },
        ],
        outsideGroupBreakdowns: [
          {
            groupId: "outside:1",
            supportOppose: "oppose",
            categoryType: "industry",
            categoryName: "real_estate",
            amount: 1000,
          },
        ],
      })
    ).rejects.toThrow("outside group breakdowns must reference outside groups");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects snapshot writes with query-only handles", async () => {
    const db = createMockDb();

    await expect(
      replacePennsylvaniaCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        syncedAt: new Date("2026-02-03T04:05:06.000Z"),
        summary: {
          totalReceipts: 350,
          directContributionTotal: 350,
          sourceUrl: SOURCE_URL,
        },
      })
    ).rejects.toThrow("connect-capable Pool");
    expect(db.query).not.toHaveBeenCalled();
  });
});
