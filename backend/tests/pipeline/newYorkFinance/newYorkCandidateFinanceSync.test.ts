import { describe, expect, it, vi } from "vitest";

import { syncNewYorkCandidateFinance } from "../../../src/pipeline/newYorkFinance/newYorkCandidateFinanceSync.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";

function createMockDb() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

const MATCHED_RESOLUTION = {
  status: "matched" as const,
  filerId: "16851",
  filerName: "Friends for Kathy Hochul",
  candidateFilerId: "27197",
  confidence: "exact" as const,
  source: "ny_soda_api" as const,
  sourceUrl: "https://data.ny.gov/d/7x2g-h32p",
};

const CFAR_GROUP = {
  filerId: "590891",
  filerName: "Citizens for Affordable Rates PAC",
  supportOppose: "support" as const,
  amount: 12_320_650.23,
  allocationCount: 47,
  sourceUrl: "https://data.ny.gov/d/e9ss-239a",
};

const OUTSIDE_COUNTERS = {
  allocationRowCount: 51,
  nameMatchedRowCount: 51,
  duplicateTransactionRowCount: 0,
  nonIeCommitteeRowCount: 4,
  unresolvedMappingRowCount: 5,
  acceptedRowCount: 42,
};

function baseSyncInput(db: ReturnType<typeof createMockDb>) {
  return {
    db,
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Kathy Hochul",
    electionYear: 2026,
    officeScope: "statewide",
    officeName: "Governor",
  };
}

describe("syncNewYorkCandidateFinance", () => {
  it("preserves prior outside components when no positive source allocations resolve", async () => {
    const db = createMockDb();
    const result = await syncNewYorkCandidateFinance({
      ...baseSyncInput(db), sodaClientOptions: {}, trustedCommittee: { filerId: "16851", filerName: "Friends for Kathy Hochul" },
      nyClient: {
        collectOutsideSpending: async () => ({ groups: [], supportTotal: 0, opposeTotal: 0, counters: { ...OUTSIDE_COUNTERS, acceptedRowCount: 0 } }),
        collectDirectCampaign: async () => ({ directContributionTotal: 100, totalDisbursements: null, breakdowns: [], pacDonors: [], receiptRowCount: 1, lumpRowCount: 0 }),
      },
    });
    expect(result).toMatchObject({ outsideSupportTotal: null, outsideOpposeTotal: null, knownOutsideSupportTotal: null, outsideGroupsWritten: 0 });
    const statements = db.client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some(sql => /DELETE FROM public\.ny_candidate_finance_outside/.test(sql))).toBe(false);
    const summary = db.client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ny_candidate_finance_summaries"));
    expect(summary?.[1]?.slice(6, 8)).toEqual([null, null]);
  });

  it("leaves all stored components untouched when a source fetch fails after IE acquisition", async () => {
    const db = createMockDb();
    await expect(syncNewYorkCandidateFinance({
      ...baseSyncInput(db), sodaClientOptions: {}, trustedCommittee: { filerId: "16851", filerName: "Friends for Kathy Hochul" },
      nyClient: {
        collectOutsideSpending: async () => ({ groups: [], supportTotal: 0, opposeTotal: 0, counters: OUTSIDE_COUNTERS }),
        collectDirectCampaign: async () => { throw new Error("Source paging failed"); },
      },
    })).rejects.toThrow("Source paging failed");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("writes a full snapshot with direct campaign data and rule-classified industries", async () => {
    const db = createMockDb();
    const nyClient = {
      searchAndResolveCandidateCommittee: vi.fn(async () => MATCHED_RESOLUTION),
      collectOutsideSpending: vi.fn(async () => ({
        groups: [CFAR_GROUP],
        supportTotal: CFAR_GROUP.amount,
        opposeTotal: 0,
        counters: OUTSIDE_COUNTERS,
      })),
      getOutsideGroupFunderBreakdowns: vi.fn(async () => ({
        funders: [
          {
            categoryType: "donor" as const,
            categoryName: "Uber Technologies Inc.",
            amount: 11_686_700.23,
            contributorCount: 23,
            sourceUrl: "https://data.ny.gov/d/e9ss-239a",
          },
        ],
        receiptRowCount: 28,
        organizationRowCount: 28,
        skippedIndividualRowCount: 0,
      })),
      collectDirectCampaign: vi.fn(async () => ({
        pacDonors: [{ committeeId: "reported:EXAMPLE PAC", committeeName: "Example PAC", sourceReportedClass: "Political Action Committee (PAC)" as const, amount: 5_000, contributionCount: 1, sourceUrl: "https://data.ny.gov/d/e9ss-239a" }],
        directContributionTotal: 5_454_286.73,
        totalDisbursements: 3_706_000.56,
        breakdowns: [
          {
            categoryType: "contribution_size" as const,
            categoryName: "$1-$99",
            amount: 120_000,
            contributorCount: 4_000,
            sourceUrl: "https://data.ny.gov/d/e9ss-239a",
          },
          {
            categoryType: "contributor_type" as const,
            categoryName: "Individual",
            amount: 4_001_893.48,
            contributorCount: 8_198,
            sourceUrl: "https://data.ny.gov/d/e9ss-239a",
          },
          {
            categoryType: "donor" as const,
            categoryName: "Lyft, Inc.",
            amount: 50_000,
            contributorCount: 2,
            sourceUrl: "https://data.ny.gov/d/e9ss-239a",
          },
        ],
        receiptRowCount: 8_442,
        lumpRowCount: 1,
      })),
    };

    const result = await syncNewYorkCandidateFinance({
      ...baseSyncInput(db),
      nyClient,
      sodaClientOptions: {},
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      directContributionTotal: 5_454_286.73,
      totalDisbursements: 3_706_000.56,
      directReceiptRowCount: 8_442,
      pacDonorsWritten: 1,
      pacReceiptTotal: 5_000,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      knownOutsideSupportTotal: 12_320_650.23,
      knownOutsideOpposeTotal: null,
      outsideGroupCount: 1,
      outsideFunderRowCount: 28,
      outsideCounters: OUTSIDE_COUNTERS,
    });

    const statements = db.client.query.mock.calls.map((call) => [String(call[0]), call[1]] as const);
    const linkInsert = statements.find(([sql]) => sql.includes("INSERT INTO public.ny_candidate_finance_links"));
    const donorInsert = statements.find(([sql]) => sql.includes("INSERT INTO public.ny_candidate_finance_pac_donors"));
    expect(donorInsert?.[1]).toContain("reported:EXAMPLE PAC");
    expect(linkInsert?.[1]).toContain("16851");

    const summaryInsert = statements.find(([sql]) => sql.includes("INSERT INTO public.ny_candidate_finance_summaries"));
    // Phase 2: direct totals fill in; cash_on_hand stays null (no opening balances).
    expect(summaryInsert?.[1]?.slice(2, 6)).toEqual([5_454_286.73, 5_454_286.73, 3_706_000.56, null]);
    expect(summaryInsert?.[1]?.slice(6, 8)).toEqual([null, null]);

    const directInserts = statements.filter(([sql]) =>
      sql.includes("INSERT INTO public.ny_candidate_finance_direct_breakdowns")
    );
    const directPairs = directInserts.map(([, params]) => [params?.[2], params?.[3]]);
    expect(directPairs).toContainEqual(["contribution_size", "$1-$99"]);
    expect(directPairs).toContainEqual(["contributor_type", "Individual"]);
    expect(directPairs).toContainEqual(["donor", "Lyft, Inc."]);
    // The exact classifier rule pins Lyft to transportation without AI.
    expect(directPairs).toContainEqual(["industry", "transportation"]);

    const breakdownInserts = statements.filter(([sql]) =>
      sql.includes("INSERT INTO public.ny_candidate_finance_outside_group_breakdowns")
    );
    expect(breakdownInserts).toHaveLength(2);
    const categoryPairs = breakdownInserts.map(([, params]) => [params?.[4], params?.[5]]);
    expect(categoryPairs).toContainEqual(["donor", "Uber Technologies Inc."]);
    // The exact classifier rule pins Uber to transportation without AI.
    expect(categoryPairs).toContainEqual(["industry", "transportation"]);
  });

  it("returns an empty result without writes when the committee does not resolve", async () => {
    const db = createMockDb();
    const nyClient = {
      searchAndResolveCandidateCommittee: vi.fn(async () => ({
        status: "unmatched" as const,
        reason: "no_candidate_committee_match" as const,
        candidateNameNormalized: "KATHY HOCHUL",
        officeNameNormalized: "Governor",
      })),
      collectOutsideSpending: vi.fn(),
      getOutsideGroupFunderBreakdowns: vi.fn(),
      collectDirectCampaign: vi.fn(),
    };

    const result = await syncNewYorkCandidateFinance({ ...baseSyncInput(db), nyClient, sodaClientOptions: {} });

    expect(result).toMatchObject({ linkWritten: false, outsideGroupCount: 0, outsideCounters: null });
    expect(nyClient.collectOutsideSpending).not.toHaveBeenCalled();
    expect(nyClient.collectDirectCampaign).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("uses the trusted committee without re-resolving and fetches funders once per filer", async () => {
    const db = createMockDb();
    const nyClient = {
      searchAndResolveCandidateCommittee: vi.fn(),
      collectOutsideSpending: vi.fn(async () => ({
        groups: [CFAR_GROUP, { ...CFAR_GROUP, supportOppose: "oppose" as const, amount: 10 }],
        supportTotal: CFAR_GROUP.amount,
        opposeTotal: 10,
        counters: OUTSIDE_COUNTERS,
      })),
      getOutsideGroupFunderBreakdowns: vi.fn(async () => ({
        funders: [],
        receiptRowCount: 0,
        organizationRowCount: 0,
        skippedIndividualRowCount: 0,
      })),
      collectDirectCampaign: vi.fn(async () => ({
        pacDonors: [],
        directContributionTotal: 0,
        totalDisbursements: null,
        breakdowns: [],
        receiptRowCount: 0,
        lumpRowCount: 0,
      })),
    };

    const result = await syncNewYorkCandidateFinance({
      ...baseSyncInput(db),
      nyClient,
      sodaClientOptions: {},
      trustedCommittee: { filerId: "16851", filerName: "Friends for Kathy Hochul" },
      dryRun: true,
    });

    expect(nyClient.searchAndResolveCandidateCommittee).not.toHaveBeenCalled();
    expect(nyClient.getOutsideGroupFunderBreakdowns).toHaveBeenCalledTimes(1);
    expect(nyClient.collectDirectCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ filerId: "16851", electionYear: 2026, cycleYears: 4 }),
      {}
    );
    expect(nyClient.getOutsideGroupFunderBreakdowns).toHaveBeenCalledWith(
      expect.objectContaining({ cycleYears: 4 }),
      {}
    );
    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      outsideGroupsWritten: 0,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      knownOutsideSupportTotal: 12_320_650.23,
      knownOutsideOpposeTotal: 10,
    });
    expect(db.connect).not.toHaveBeenCalled();
  });
});
