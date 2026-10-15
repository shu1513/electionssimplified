import { describe, expect, it, vi } from "vitest";

import {
  replaceMinnesotaCandidateFinanceSnapshot,
  upsertMinnesotaFinanceLink,
} from "../../../src/pipeline/minnesotaFinance/minnesotaFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function linkInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "PEGGY FLANAGAN",
    officeName: "Governor",
    district: null,
    committeeId: "18642",
    committeeName: "Flanagan for Minnesota",
    linkStatus: "active" as const,
    linkSource: "mn_board" as const,
    sourceUrl: "https://cfb.mn.gov/reports/campaign-finance/committee/18642",
    lastVerifiedAt: NOW,
  };
}

describe("minnesotaFinanceWriter", () => {
  it("upserts a Minnesota finance link and keeps manual links protected", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "link-1" }], rowCount: 1 }) };

    await expect(upsertMinnesotaFinanceLink({ db, link: linkInput() })).resolves.toEqual({ linkId: "link-1" });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("INSERT INTO public.mn_candidate_finance_links");
    expect(sql).toContain("WHEN mn_candidate_finance_links.link_source = 'manual' AND EXCLUDED.link_source <> 'manual' THEN mn_candidate_finance_links.link_status");
    expect(sql).toContain("WHEN mn_candidate_finance_links.link_source = 'manual' AND EXCLUDED.link_source <> 'manual' THEN mn_candidate_finance_links.link_source");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "PEGGY FLANAGAN",
      "Governor",
      null,
      "18642",
      "Flanagan for Minnesota",
      "active",
      "mn_board",
      "https://cfb.mn.gov/reports/campaign-finance/committee/18642",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("transactionally replaces summary and outside groups, preserving prior totals via COALESCE", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };

    await expect(
      replaceMinnesotaCandidateFinanceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        summary: {
          totalReceipts: 250000,
          outsideSupportTotal: 90000,
          sourceUrl: "https://cfb.mn.gov/reports/campaign-finance/committee/18642",
        },
        outsideGroups: [
          {
            committeeId: "41099",
            committeeName: "ALLIANCE FOR A BETTER MINNESOTA",
            supportOppose: "support",
            amount: 90000,
            sourceUrl: "https://cfb.mn.gov/reports/campaign-finance/committee/41099",
          },
        ],
      })
    ).resolves.toEqual({
      linkId: "link-1",
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 0,
    });

    expect(client.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "INSERT INTO public.mn_candidate_finance_links",
      "INSERT INTO public.mn_candidate_finance_summaries",
      "INSERT INTO public.mn_candidate_finance_outside_groups",
      "DELETE FROM public.mn_candidate_finance_outside_groups",
      "COMMIT",
    ]);
    const summarySql = String(client.query.mock.calls[2]?.[0]);
    expect(summarySql).toContain("total_receipts = COALESCE(EXCLUDED.total_receipts, mn_candidate_finance_summaries.total_receipts)");
    expect(summarySql).toContain("cash_on_hand = COALESCE(EXCLUDED.cash_on_hand, mn_candidate_finance_summaries.cash_on_hand)");
    expect(client.query.mock.calls.at(-2)?.[1]).toEqual([
      "link-1",
      2026,
      JSON.stringify([{ committee_id: "41099", support_oppose: "support" }]),
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("transactionally replaces outside group breakdowns", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };

    await expect(
      replaceMinnesotaCandidateFinanceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroups: [
          {
            committeeId: "41099",
            committeeName: "ALLIANCE FOR A BETTER MINNESOTA",
            supportOppose: "support",
            amount: 90000,
            sourceUrl: "https://cfb.mn.gov/reports/campaign-finance/committee/41099",
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "41099",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Education Minnesota",
            amount: 50000,
            contributorCount: 1,
            sourceUrl: "https://cfb.mn.gov/reports/campaign-finance/committee/41099",
          },
          {
            committeeId: "41099",
            supportOppose: "support",
            categoryType: "industry",
            categoryName: "labor_union",
            amount: 50000,
            contributorCount: 1,
            sourceUrl: "https://cfb.mn.gov/reports/campaign-finance/committee/41099",
          },
        ],
      })
    ).resolves.toEqual({
      linkId: "link-1",
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
    });

    expect(client.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "INSERT INTO public.mn_candidate_finance_links",
      "INSERT INTO public.mn_candidate_finance_outside_groups",
      "INSERT INTO public.mn_candidate_finance_outside_group_breakdowns",
      "INSERT INTO public.mn_candidate_finance_outside_group_breakdowns",
      "DELETE FROM public.mn_candidate_finance_outside_group_breakdowns",
      "DELETE FROM public.mn_candidate_finance_outside_groups",
      "COMMIT",
    ]);
    expect(client.query.mock.calls.at(-3)?.[1]).toEqual([
      "link-1",
      2026,
      JSON.stringify([
        {
          committee_id: "41099",
          support_oppose: "support",
          category_type: "donor",
          category_name: "Education Minnesota",
        },
        {
          committee_id: "41099",
          support_oppose: "support",
          category_type: "industry",
          category_name: "labor_union",
        },
      ]),
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects outside group breakdowns without outside groups", async () => {
    const db = { connect: vi.fn(), query: vi.fn() };

    await expect(
      replaceMinnesotaCandidateFinanceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroupBreakdowns: [
          {
            committeeId: "41099",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Education Minnesota",
            amount: 50000,
          },
        ],
      })
    ).rejects.toThrow("Minnesota outside group breakdowns require outside groups in the same snapshot");

    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects breakdowns that do not pair with a supplied outside group", async () => {
    const db = { connect: vi.fn(), query: vi.fn() };

    await expect(
      replaceMinnesotaCandidateFinanceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroups: [
          {
            committeeId: "41099",
            committeeName: "ALLIANCE FOR A BETTER MINNESOTA",
            supportOppose: "support",
            amount: 90000,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "41099",
            supportOppose: "oppose",
            categoryType: "donor",
            categoryName: "Education Minnesota",
            amount: 50000,
          },
        ],
      })
    ).rejects.toThrow("Minnesota outside group breakdowns must reference outside groups in the same snapshot");

    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects a PoolClient instead of a Pool", async () => {
    const client = { query: vi.fn(), release: vi.fn() };

    await expect(
      replaceMinnesotaCandidateFinanceSnapshot({
        db: client,
        link: linkInput(),
        syncedAt: NOW,
      })
    ).rejects.toThrow("Minnesota finance snapshot writes must receive a Pool, not a PoolClient");

    expect(client.query).not.toHaveBeenCalled();
  });

  it("rolls back and releases the client on write failure", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockRejectedValueOnce(new Error("link insert failed"))
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };

    await expect(
      replaceMinnesotaCandidateFinanceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
      })
    ).rejects.toThrow("link insert failed");

    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO public.mn_candidate_finance_links"),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  function cashSnapshot(): import("../../../src/pipeline/minnesotaFinance/minnesotaCommitteeCashWriter.js").MinnesotaCommitteeCashSnapshot {
    return {
      aggregate: {
        donors: [{ reportedCommitteeId: "100", reportedCommitteeName: "Example Fund", amountCents: 50000, contributionCount: 2 }],
        totalAmountCents: 50000, matchedContributionRowCount: 3, includedContributionRowCount: 2,
        excludedContributionRowCount: 1, zeroContributionRowCount: 0, excludedUnknownClassRowCount: 1,
      },
      source: {
        observedAt: "2026-05-31T12:00:00.000Z", sha256: "a".repeat(64), byteCount: 1200, rowCount: 8,
        url: "https://register.cfb.mn.gov/reports-and-data/self-help/data-downloads/campaign-finance/",
      },
    };
  }

  it("leaves committee cash rows and observation/sync times untouched when omitted", async () => {
    const db = {
      query: vi.fn().mockImplementation(async (sql: string) => ({
        rows: sql.includes("INSERT INTO public.mn_candidate_finance_links") ? [{ id: "link-1" }] : [],
      })),
    };
    await replaceMinnesotaCandidateFinanceSnapshot({ db, link: linkInput(), syncedAt: NOW });
    expect(db.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN", "INSERT INTO public.mn_candidate_finance_links", "COMMIT",
    ]);
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("mn_candidate_finance_pac_"))).toBe(false);
  });

  it("validates the whole cash component before opening a transaction", async () => {
    const db = { connect: vi.fn(), query: vi.fn() };
    const reportedCommitteeCash = cashSnapshot();
    reportedCommitteeCash.aggregate.totalAmountCents += 1;
    await expect(replaceMinnesotaCandidateFinanceSnapshot({
      db, link: linkInput(), syncedAt: NOW, reportedCommitteeCash,
    })).rejects.toThrow("donor agreement");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("writes the optional cash component inside the protected-link snapshot transaction", async () => {
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => ({
        rows: sql.includes("INSERT INTO public.mn_candidate_finance_links") ? [{ id: "link-1" }] : [],
      })),
      release: vi.fn(),
    };
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    await replaceMinnesotaCandidateFinanceSnapshot({
      db, link: linkInput(), syncedAt: NOW, summary: { totalReceipts: 1000 }, reportedCommitteeCash: cashSnapshot(),
    });
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.map((value) => value.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN", "INSERT INTO public.mn_candidate_finance_links", "INSERT INTO public.mn_candidate_finance_summaries",
      "DELETE FROM public.mn_candidate_finance_pac_donors", "INSERT INTO public.mn_candidate_finance_pac_sources",
      "INSERT INTO public.mn_candidate_finance_pac_donors", "COMMIT",
    ]);
    expect(db.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back summary, donor deletion and provenance when the donor insert fails", async () => {
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("INSERT INTO public.mn_candidate_finance_pac_donors")) throw new Error("cash insert failed");
        return { rows: sql.includes("INSERT INTO public.mn_candidate_finance_links") ? [{ id: "link-1" }] : [] };
      }),
      release: vi.fn(),
    };
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    await expect(replaceMinnesotaCandidateFinanceSnapshot({
      db, link: linkInput(), syncedAt: NOW, summary: { totalReceipts: 1000 }, reportedCommitteeCash: cashSnapshot(),
    })).rejects.toThrow("cash insert failed");
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql).toContainEqual(expect.stringContaining("INSERT INTO public.mn_candidate_finance_summaries"));
    expect(sql).toContainEqual(expect.stringContaining("INSERT INTO public.mn_candidate_finance_pac_sources"));
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

});
