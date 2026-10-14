import { afterEach, describe, expect, it, vi } from "vitest";

import { syncVermontCandidateFinance } from "../../../src/pipeline/vermontFinance/vermontCandidateFinanceSync.js";
import type { VermontCandidateCommitteeResolution } from "../../../src/pipeline/vermontFinance/vermontCandidateCommitteeResolver.js";
import type {
  VermontContributionRow,
  VermontExpenditureRow,
  VermontTransactionSearchInput,
} from "../../../src/pipeline/vermontFinance/vermontCampaignFinanceClient.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://campaignfinance.vermont.gov/";

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockDb() {
  const poolQuery = vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 });
  const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 });
  const client = { query: clientQuery, release: vi.fn() };
  return {
    query: poolQuery,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

function matchedResolution(
  overrides: Partial<Extract<VermontCandidateCommitteeResolution, { status: "matched" }>> = {}
): Extract<VermontCandidateCommitteeResolution, { status: "matched" }> {
  return {
    status: "matched",
    filerRegistrationGuid: "candidate-guid",
    filerName: "SCOTT, PHIL",
    candidateName: "PHIL SCOTT",
    officeId: 19,
    officeName: "Governor",
    officeDisplayName: "Governor",
    electionYear: 2024,
    electionId: 35,
    entityId: 33545,
    reportName: "07/01/2024 - GENERAL",
    confidence: "exact",
    source: "vermont_public_transactions",
    sourceUrl: SOURCE_URL,
    matchedTransactionRowCount: 2,
    ...overrides,
  };
}

function contribution(overrides: Partial<VermontContributionRow> = {}): VermontContributionRow {
  return {
    transactionId: 1,
    transactionVersionId: 1,
    guid: "contribution-guid-1",
    filerRegistrationGuid: "candidate-guid",
    filerName: "SCOTT, PHIL",
    transactionAmount: 100,
    transactionDate: "03/01/2024",
    sourceName: "DOE, JANE",
    sourceFirstName: "JANE",
    sourceLastName: "DOE",
    sourceMiddleName: null,
    transactionSource: "Individual",
    transactionSourceTypeCode: "TIND",
    transactionSubTypeCode: "ITMY",
    transactionSubTypeDescription: "Monetary Contribution",
    filerTypeCode: "CAN",
    filerTypeDescription: "Candidate",
    electionYear: 2024,
    electionCycle: "2024 General",
    electionId: 35,
    officeId: 19,
    officeType: "OTSTW",
    entityId: 33545,
    reportName: "07/01/2024 - GENERAL",
    candidateFirstName: "PHIL",
    candidateLastName: "SCOTT",
    candidateMiddleName: null,
    occupation: "Attorney",
    employer: "Acme Law",
    filingYear: 2024,
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "Montpelier",
    stateCode: "VT",
    zipCode: "05602",
    ...overrides,
  };
}

function expenditure(overrides: Partial<VermontExpenditureRow> = {}): VermontExpenditureRow {
  return {
    transactionId: 10,
    transactionVersionId: 1,
    guid: "expenditure-guid-1",
    filerRegistrationGuid: "pac-guid",
    filerName: "VERMONT FUTURE PAC",
    transactionAmount: 1000,
    transactionDate: "09/01/2024",
    transactionCategoryCode: "PUCON",
    transactionCategoryDescription: "Contribution to Candidate",
    expenditurePurpose: "Contribution to Candidate",
    description: null,
    isStanceSupport: null,
    payeeType: "Candidate",
    sourceName: "SCOTT, PHIL",
    transactionSource: "Candidate",
    filerTypeCode: "PAC",
    filerTypeDescription: "Political Action Committee",
    electionYear: 2024,
    electionCycle: "2024 General",
    electionId: 35,
    officeId: null,
    officeType: null,
    entityId: 33545,
    reportName: "10/01/2024 - GENERAL",
    candidateMentioned: null,
    candidateFirstName: "PHIL",
    candidateLastName: "SCOTT",
    candidateMiddleName: null,
    sourceAddressLine1: null,
    sourceAddressLine2: null,
    sourceCity: null,
    sourceState: null,
    sourceZipCode: null,
    ...overrides,
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Phil Scott",
    electionYear: 2024,
    officeScope: "statewide",
    officeName: "Governor",
    sourceUrl: SOURCE_URL,
    now: new Date("2026-06-02T03:04:05.000Z"),
  };
}

function createVermontClient(input: { resolution?: VermontCandidateCommitteeResolution } = {}) {
  return {
    searchAndResolveCandidateCommittee: vi.fn(async () => input.resolution ?? matchedResolution()),
    getContributionDetails: vi.fn(async () => ({
      totalItems: 2,
      items: [
        contribution({ transactionAmount: 100 }),
        contribution({
          transactionId: 2,
          guid: "contribution-guid-2",
          transactionAmount: 500,
          sourceName: "ACME LLC",
          transactionSource: "Business/Group/Organization",
          transactionSourceTypeCode: "TBSN",
        }),
      ],
    })),
    getExpenditureDetails: vi.fn(async (_input?: VermontTransactionSearchInput) => ({
      totalItems: 1,
      items: [expenditure()],
    })),
    fetchAndAggregateOutsideGroupContributions: vi.fn(async () => ({
      fetchedContributionRowCount: 2,
      matchedContributionRowCount: 2,
      includedContributionRowCount: 2,
      skippedContributionRowCount: 0,
      outsideDonorClassifications: [
        {
          rawLabel: "Sierra Club",
          labelType: "donor" as const,
          normalizedLabel: "SIERRA CLUB",
          industrySlug: "environmental_group" as const,
          confidence: "high" as const,
          classificationSource: "rule" as const,
          matchedRule: "environmental_group",
        },
      ],
      outsideGroupBreakdowns: [
        {
          filerRegistrationGuid: "pac-guid",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "Sierra Club",
          amount: 25000,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
        {
          filerRegistrationGuid: "pac-guid",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "environmental_group",
          amount: 25000,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
      ],
    })),
  };
}

describe("vermontCandidateFinanceSync", () => {
  it("restarts a moving statewide census and discards the abandoned rows", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();
    vermontClient.getExpenditureDetails
      .mockResolvedValueOnce({ totalItems: 3, items: [
        expenditure({ transactionId: 90, transactionAmount: 9000 }),
        expenditure({ transactionId: 91, transactionAmount: 9000 }),
      ] })
      .mockResolvedValueOnce({ totalItems: 4, items: [] })
      .mockResolvedValueOnce({ totalItems: 3, items: [
        expenditure({ transactionId: 1, guid: "fresh-1", transactionAmount: 100 }),
        expenditure({ transactionId: 2, guid: "fresh-2", transactionAmount: 200 }),
      ] })
      .mockResolvedValueOnce({ totalItems: 3, items: [
        expenditure({ transactionId: 3, guid: "fresh-3", transactionAmount: 300 }),
      ] });

    const result = await syncVermontCandidateFinance({
      db, ...baseInput(), pageSize: 2, vermontClient,
    });
    expect(result).toMatchObject({
      fetchedExpenditureRowCount: 3, outsideSupportTotal: 600, summaryWritten: true,
    });
    expect(vermontClient.getExpenditureDetails.mock.calls.map(
      (call) => call[0]?.pageNumber,
    )).toEqual([1, 2, 1, 2]);
    expect(vermontClient.getContributionDetails).toHaveBeenCalledTimes(1);
  });

  it("stops after three moving statewide censuses without writing", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();
    for (let attempt = 0; attempt < 3; attempt++) {
      vermontClient.getExpenditureDetails
        .mockResolvedValueOnce({ totalItems: 3, items: [
          expenditure({ transactionId: 1 }), expenditure({ transactionId: 2 }),
        ] })
        .mockResolvedValueOnce({ totalItems: 4, items: [] });
    }
    await expect(syncVermontCandidateFinance({
      db, ...baseInput(), pageSize: 2, vermontClient,
    })).rejects.toMatchObject({ name: "VermontCensusMovedError" });
    expect(vermontClient.getExpenditureDetails).toHaveBeenCalledTimes(6);
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    { totalItems: -1, items: [] },
    { totalItems: 1.5, items: [] },
    { totalItems: 3, items: [] },
    { totalItems: 3, items: [expenditure()] },
  ])("does not retry malformed or repeated statewide rows ($totalItems)", async (secondPage) => {
    const db = createMockDb();
    const vermontClient = createVermontClient();
    vermontClient.getExpenditureDetails
      .mockResolvedValueOnce({ totalItems: 3, items: [
        expenditure(), expenditure({ transactionId: 11 }),
      ] })
      .mockResolvedValueOnce(secondPage);
    await expect(syncVermontCandidateFinance({
      db, ...baseInput(), pageSize: 2, vermontClient,
    })).rejects.toThrow();
    expect(vermontClient.getExpenditureDetails).toHaveBeenCalledTimes(2);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("propagates statewide transport errors unchanged without retrying", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();
    const failure = new Error("source unavailable");
    vermontClient.getExpenditureDetails.mockRejectedValueOnce(failure);
    await expect(syncVermontCandidateFinance({
      db, ...baseInput(), vermontClient,
    })).rejects.toBe(failure);
    expect(vermontClient.getExpenditureDetails).toHaveBeenCalledTimes(1);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("resolves, fetches Vermont rows, aggregates direct/PAC support finance, and writes a snapshot", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();

    const result = await syncVermontCandidateFinance({
      db,
      ...baseInput(),
      pageSize: 10,
      maxPages: 1,
      vermontClient,
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2024,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 600,
      directContributionTotal: 600,
      outsideSupportTotal: 1000,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 2,
      includedContributionRowCount: 2,
      skippedContributionRowCount: 0,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 1,
      skippedExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 2,
      includedOutsideContributionRowCount: 2,
      skippedOutsideContributionRowCount: 0,
      fetchedContributionRowCount: 2,
      fetchedExpenditureRowCount: 1,
      fetchedOutsideContributionRowCount: 2,
      resolution: { status: "matched", filerRegistrationGuid: "candidate-guid" },
    });

    expect(vermontClient.searchAndResolveCandidateCommittee).toHaveBeenCalledWith(
      expect.objectContaining({ candidateName: "Phil Scott", officeName: "Governor", electionYear: 2024 }),
      undefined
    );
    expect(vermontClient.getContributionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ filerRegistrationGuid: "candidate-guid", electionYear: 2024, pageSize: 10 }),
      undefined
    );
    expect(vermontClient.getExpenditureDetails).toHaveBeenCalledWith(
      expect.objectContaining({ electionYear: 2024, transactionTypeCode: "TEXP", pageSize: 10 }),
      undefined
    );
    expect(vermontClient.fetchAndAggregateOutsideGroupContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        electionYear: 2024,
        outsideGroups: [
          expect.objectContaining({
            filerRegistrationGuid: "pac-guid",
            supportMechanism: "vt_pac_contribution_to_registrant",
          }),
        ],
      }),
      undefined
    );

    expect(db.client.query.mock.calls.some((call) => call[0] === "BEGIN")).toBe(true);
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const linkCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.vt_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2024,
      "PHIL SCOTT",
      "Governor",
      null,
      "candidate-guid",
      33545,
      "SCOTT, PHIL",
      "active",
      "vermont_public_transactions",
      SOURCE_URL,
      "2026-06-02T03:04:05.000Z",
    ]);

    const outsideGroupCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.vt_candidate_finance_outside_groups")
    );
    expect(outsideGroupCall?.[1]).toEqual([
      LINK_ID,
      2024,
      "pac-guid",
      "VERMONT FUTURE PAC",
      "support",
      "vt_pac_contribution_to_registrant",
      1000,
      SOURCE_URL,
      "2026-06-02T03:04:05.000Z",
    ]);

    const classificationCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.finance_label_classifications")
    );
    expect(classificationCall?.[1]).toEqual(expect.arrayContaining(["SIERRA CLUB"]));
  });

  it("does not write in dry-run mode but returns aggregation counts", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();

    const result = await syncVermontCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      pageSize: 10,
      maxPages: 1,
      vermontClient,
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 600,
      outsideSupportTotal: 1000,
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("returns an empty result when committee resolution is not matched", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient({
      resolution: {
        status: "unmatched",
        reason: "no_candidate_committee_match",
        candidateNameNormalized: "MISSING CANDIDATE",
        officeNameNormalized: "GOVERNOR",
      },
    });

    const result = await syncVermontCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Missing Candidate",
      vermontClient,
    });

    expect(result).toMatchObject({
      resolution: { status: "unmatched", reason: "no_candidate_committee_match" },
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
    });
    expect(vermontClient.getContributionDetails).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("treats ambiguous Vermont committee resolution as not linked", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient({
      resolution: {
        status: "ambiguous",
        reason: "multiple_matching_committees",
        candidateNameNormalized: "JANE DOE",
        officeNameNormalized: "GOVERNOR",
        matches: [
          matchedResolution({ filerRegistrationGuid: "candidate-guid-1", filerName: "DOE, JANE" }),
          matchedResolution({ filerRegistrationGuid: "candidate-guid-2", filerName: "JANE DOE" }),
        ],
      },
    });

    const result = await syncVermontCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Jane Doe",
      vermontClient,
    });

    expect(result).toMatchObject({
      resolution: { status: "ambiguous", reason: "multiple_matching_committees" },
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
    });
    expect(vermontClient.getContributionDetails).not.toHaveBeenCalled();
    expect(vermontClient.getExpenditureDetails).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("fails before writing when transaction pagination hits the maxPages cap", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();
    vermontClient.getContributionDetails.mockResolvedValue({
      totalItems: 2,
      items: [contribution({ transactionAmount: 100 })],
    });

    await expect(
      syncVermontCandidateFinance({
        db,
        ...baseInput(),
        pageSize: 1,
        maxPages: 1,
        vermontClient,
      })
    ).rejects.toThrow("maxPages=1");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("trusts an existing Vermont filer link instead of re-resolving by name", async () => {
    const db = createMockDb();
    const vermontClient = createVermontClient();

    await syncVermontCandidateFinance({
      db,
      ...baseInput(),
      pageSize: 10,
      maxPages: 1,
      vermontClient,
      trustedCommittee: {
        filerRegistrationGuid: "candidate-guid",
        filerName: "SCOTT, PHIL",
        entityId: 33545,
        sourceUrl: SOURCE_URL,
      },
    });

    expect(vermontClient.searchAndResolveCandidateCommittee).not.toHaveBeenCalled();
    expect(vermontClient.getContributionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ filerRegistrationGuid: "candidate-guid", electionYear: 2024 }),
      undefined
    );
  });
});
