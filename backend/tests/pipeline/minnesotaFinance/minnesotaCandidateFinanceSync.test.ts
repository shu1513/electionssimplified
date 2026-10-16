import { describe, expect, it, vi } from "vitest";

import { syncMinnesotaCandidateFinance } from "../../../src/pipeline/minnesotaFinance/minnesotaCandidateFinanceSync.js";
import type { MinnesotaCampaignFinanceCsvRow } from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactReader.js";

function candidateRow(overrides: Partial<MinnesotaCampaignFinanceCsvRow> = {}): MinnesotaCampaignFinanceCsvRow {
  return {
    "Committee ID": "1001",
    "Committee Name": "FRIENDS OF JANE DOE",
    Candidate: "Jane Doe",
    Office: "Governor",
    District: "",
    Status: "Active",
    Year: "2026",
    ...overrides,
  };
}

function outsideExpenditureRow(overrides: Partial<MinnesotaCampaignFinanceCsvRow> = {}): MinnesotaCampaignFinanceCsvRow {
  return {
    "Spender": "Better Minnesota",
    "Spender Reg Num": "SP123",
    "Spender sub-type": "Independent expenditure",
    "Affected Comte Name": "Friends of Jane Doe",
    "Affected Cmte Reg Num": "1001",
    "For /Against": "For",
    "Type": "Independent Expenditure",
    "Amount": "70000.00",
    "Purpose": "Support for Example",
    Year: "2026",
    ...overrides,
  };
}

function outsideContributionRow(overrides: Partial<MinnesotaCampaignFinanceCsvRow> = {}): MinnesotaCampaignFinanceCsvRow {
  return {
    "Recipient reg num": "SP123",
    "Recipient": "Better Minnesota",
    "Amount": "20000.00",
    "Receipt date": "2026-09-01",
    "Year": "2026",
    "Contributor": "Google LLC",
    "Contrib type": "Business",
    "Receipt type": "Contribution",
    ...overrides,
  };
}

describe("Minnesota candidate finance sync", () => {
  const nativeReceipt = {
    "Recipient reg num": "1001", "Recipient type": "PCC", Year: "2026",
    "Contrib type": "Political Committee/Fund", "Contrib Reg Num": "3001", Contributor: "Example Committee",
    "Receipt type": "Contribution", "In kind?": "No", "Receipt date": "2026-01-01", Amount: "100.25",
  };
  const cashSource = { observedAt: "2026-05-01T00:00:00.000Z", sha256: "a".repeat(64),
    byteCount: 1000, rowCount: 3, url: "https://register.cfb.mn.gov/downloads/receipts.csv" };
  function cashSyncInput(rows = [nativeReceipt]) {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    return { queries, input: {
      db: { query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values }); return { rows: text.includes("INSERT INTO public.mn_candidate_finance_links") ? [{ id: "link-1" }] : [] };
      } }, candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, officeScope: "statewide", officeName: "Governor",
      contributionRows: rows, reportedCommitteeCashSource: cashSource,
      trustedCommittee: { committeeId: "1001", committeeName: "Friends of Jane Doe" }, now: new Date("2026-06-01T00:00:00.000Z"),
    } };
  }

  it("writes classified cash independently of unavailable direct totals and outside sources", async () => {
    const { input, queries } = cashSyncInput();
    const result = await syncMinnesotaCandidateFinance(input);
    expect(result).toMatchObject({ reportedCommitteeCashStatus: "ready", reportedCommitteeCashTotal: 100.25,
      reportedCommitteeCashDonorsWritten: 1, includedContributionRowCount: 1, totalReceipts: null, outsideSupportTotal: null });
    expect(queries.some((query) => query.text.includes("INSERT INTO public.mn_candidate_finance_pac_donors"))).toBe(true);
    expect(queries.find((query) => query.text.includes("INSERT INTO public.mn_candidate_finance_pac_sources"))?.values)
      .toContain(cashSource.observedAt);
  });

  it("preserves cash on a component hold while independent IE still writes", async () => {
    const { input, queries } = cashSyncInput([{ ...nativeReceipt, Amount: "not money" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await syncMinnesotaCandidateFinance({ ...input, expenditureRows: [outsideExpenditureRow()] });
      expect(result).toMatchObject({ reportedCommitteeCashStatus: "held", reportedCommitteeCashTotal: null,
        reportedCommitteeCashDonorsWritten: 0, outsideSupportTotal: 70000 });
      expect(queries.some((query) => /mn_candidate_finance_pac_/.test(query.text))).toBe(false);
      expect(queries.some((query) => query.text.includes("INSERT INTO public.mn_candidate_finance_outside_groups"))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it.each([".25", "$.25", "0.25"])("includes source decimal amount %s in allocated IE", async (amount) => {
    const result = await syncMinnesotaCandidateFinance({
      db: { query: async () => ({ rows: [] }) },
      candidateId: "11111111-1111-1111-1111-111111111111",
      electionId: "22222222-2222-2222-2222-222222222222",
      candidateName: "Jane Doe",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      contributionRows: [],
      trustedCommittee: { committeeId: "1001", committeeName: "FRIENDS OF JANE DOE" },
      expenditureRows: [outsideExpenditureRow({ Amount: amount })],
      dryRun: true,
    });

    expect(result.outsideSupportTotal).toBe(0.25);
    expect(result.includedOutsideExpenditureRowCount).toBe(1);
    expect(result.skippedOutsideExpenditureRowCount).toBe(0);
  });

  it("writes authoritative direct totals with outside groups and backtrace rows", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const db = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text.includes("INSERT INTO public.mn_candidate_finance_links")) {
          return { rows: [{ id: "link-1" }] };
        }
        return { rows: [] };
      },
    };

    const result = await syncMinnesotaCandidateFinance({
      db,
      candidateId: "11111111-1111-1111-1111-111111111111",
      electionId: "22222222-2222-2222-2222-222222222222",
      candidateName: "Jane Doe",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      contributionRows: [candidateRow()],
      expenditureRows: [outsideExpenditureRow()],
      outsideContributionRows: [outsideContributionRow()],
      financialSummary: {
        committeeId: "1001",
        electionYear: 2026,
        totalReceipts: 710214.46,
        directContributionTotal: 710176.98,
        totalDisbursements: 166272.24,
        sourceUrl:
          "https://register.cfb.mn.gov/reports-and-data/viewers/campaign-finance/candidates/1001/2026/",
      },
      now: new Date("2026-10-01T00:00:00Z"),
    });

    expect(result.resolution).toMatchObject({
      status: "matched",
      committeeId: "1001",
      committeeName: "FRIENDS OF JANE DOE",
    });
    expect(result.linkWritten).toBe(true);
    expect(result.summaryWritten).toBe(true);
    expect(result.totalReceipts).toBe(710214.46);
    expect(result.directContributionTotal).toBe(710176.98);
    expect(result.totalDisbursements).toBe(166272.24);
    expect(result.outsideSupportTotal).toBe(70000);
    expect(result.outsideOpposeTotal).toBe(0);
    expect(result.outsideGroupsWritten).toBe(1);
    expect(result.outsideGroupBreakdownsWritten).toBeGreaterThan(0);
    expect(result.matchedOutsideExpenditureRowCount).toBe(1);
    expect(result.includedOutsideExpenditureRowCount).toBe(1);
    expect(result.skippedOutsideExpenditureRowCount).toBe(0);
    expect(result.matchedOutsideContributionRowCount).toBe(1);
    expect(result.includedOutsideContributionRowCount).toBe(1);
    expect(result.skippedOutsideContributionRowCount).toBe(0);

    expect(queries.some(({ text }) => text.includes("mn_candidate_finance_links"))).toBe(true);
    expect(queries.some(({ text }) => text.includes("mn_candidate_finance_summaries"))).toBe(true);
    expect(queries.some(({ text }) => text.includes("mn_candidate_finance_outside_groups"))).toBe(true);
    expect(queries.some(({ text }) => text.includes("mn_candidate_finance_outside_group_breakdowns"))).toBe(true);

    const summaryQuery = queries.find(({ text }) => text.includes("INSERT INTO public.mn_candidate_finance_summaries"));
    expect(summaryQuery?.values.slice(2, 6)).toEqual([710214.46, 710176.98, 166272.24, null]);
  });

  it("does not apply a financial summary when no committee resolves", async () => {
    const result = await syncMinnesotaCandidateFinance({
      db: { query: async () => ({ rows: [] }) },
      candidateId: "11111111-1111-1111-1111-111111111111",
      electionId: "22222222-2222-2222-2222-222222222222",
      candidateName: "Jane Doe",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      contributionRows: [candidateRow({ Candidate: "Different Person" })],
      financialSummary: {
        committeeId: "1001",
        electionYear: 2026,
        totalReceipts: 100,
        directContributionTotal: 90,
        totalDisbursements: 50,
        sourceUrl: "https://example.invalid/summary",
      },
    });

    expect(result.resolution.status).not.toBe("matched");
    expect(result.summaryWritten).toBe(false);
    expect(result.totalReceipts).toBeNull();
    expect(result.directContributionTotal).toBeNull();
    expect(result.totalDisbursements).toBeNull();
  });

  it("rejects a financial summary for a different committee", async () => {
    await expect(
      syncMinnesotaCandidateFinance({
        db: { query: async () => ({ rows: [] }) },
        candidateId: "11111111-1111-1111-1111-111111111111",
        electionId: "22222222-2222-2222-2222-222222222222",
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        contributionRows: [],
        trustedCommittee: {
          committeeId: "1001",
          committeeName: "FRIENDS OF JANE DOE",
        },
        financialSummary: {
          committeeId: "9999",
          electionYear: 2026,
          totalReceipts: 100,
          directContributionTotal: 90,
          totalDisbursements: 50,
          sourceUrl: "https://example.invalid/summary",
        },
      })
    ).rejects.toThrow("Minnesota financial summary identity mismatch");
  });

  it("rejects a financial summary for a different election year", async () => {
    await expect(
      syncMinnesotaCandidateFinance({
        db: { query: async () => ({ rows: [] }) },
        candidateId: "11111111-1111-1111-1111-111111111111",
        electionId: "22222222-2222-2222-2222-222222222222",
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        contributionRows: [],
        trustedCommittee: {
          committeeId: "1001",
          committeeName: "FRIENDS OF JANE DOE",
        },
        financialSummary: {
          committeeId: "1001",
          electionYear: 2024,
          totalReceipts: 100,
          directContributionTotal: 90,
          totalDisbursements: 50,
          sourceUrl: "https://example.invalid/summary",
        },
      })
    ).rejects.toThrow("Minnesota financial summary identity mismatch");
  });
});
