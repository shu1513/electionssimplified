import { describe, expect, it, vi } from "vitest";

import { syncKentuckyCandidateFinance } from "../../../src/pipeline/kentuckyFinance/kentuckyCandidateFinanceSync.js";
import type {
  KentuckyKrefContributionRecord,
  KentuckyKrefIndependentExpenditureRecord,
} from "../../../src/pipeline/kentuckyFinance/kentuckyKrefClient.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";

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

function contribution(overrides: Partial<KentuckyKrefContributionRecord> = {}): KentuckyKrefContributionRecord {
  return {
    recipientName: "Andy Beshear",
    candidateName: "Andy Beshear",
    office: "GOVERNOR",
    location: "STATEWIDE",
    electionDate: "11/7/2023",
    electionYear: 2023,
    electionType: "GENERAL",
    contributorName: "Jane Doe",
    contributorType: "INDIVIDUAL",
    contributionMode: "DIRECT",
    occupation: "Attorney",
    employer: "Law Firm",
    amount: 250,
    receiptDate: "10/1/2023",
    ...overrides,
  };
}

function independentExpenditure(
  overrides: Partial<KentuckyKrefIndependentExpenditureRecord> = {}
): KentuckyKrefIndependentExpenditureRecord {
  return {
    spenderName: "Kentucky Future Project Action Fund",
    candidateName: "Andy Beshear",
    supportOppose: "support",
    officeOrBallotMeasure: "GOVERNOR",
    electionDate: "11/7/2023",
    electionYear: 2023,
    amount: 10_000,
    ...overrides,
  };
}

function outsideContribution(overrides: Partial<KentuckyKrefContributionRecord> = {}): KentuckyKrefContributionRecord {
  return {
    recipientName: "Kentucky Future Project Action Fund",
    toOrganizationName: "Kentucky Future Project Action Fund",
    contributorName: "IBEW Local 369 PAC",
    contributorType: "KY Political Action Committee",
    contributionMode: "DIRECT",
    amount: 25_000,
    receiptDate: "10/25/2023",
    electionYear: 2023,
    ...overrides,
  };
}

function createKrefClient() {
  return {
    downloadCandidateContributions: vi.fn(async () => [
      contribution({ amount: 250 }),
      contribution({ contributorName: "John Roe", amount: 500 }),
      contribution({ contributorName: "Kentucky PAC", contributorType: "KYPAC", occupation: "", amount: 1000 }),
    ]),
    downloadIndependentExpenditures: vi.fn(async () => [independentExpenditure()]),
    downloadIeOnlyCommitteeContributions: vi.fn(async () => [outsideContribution()]),
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Beshear, Andy",
    electionYear: 2023,
    electionDate: "11/7/2023",
    officeName: "Governor",
    location: "Statewide",
    sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/ToCandidateSearch",
    now: new Date("2026-06-02T03:04:05.000Z"),
    trustedLink: {
      candidateKey: "andy beshear|governor|statewide|2023-11-07",
      committeeKey: "beshear campaign committee",
      committeeName: "Beshear Campaign Committee",
      sourceUrl: "https://secure.kentucky.gov/kref/publicsearch/ToCandidateSearch",
    },
  };
}

describe("kentuckyCandidateFinanceSync", () => {
  it("aggregates KREF direct, outside spending, outside donor industries, and writes a snapshot", async () => {
    const db = createMockDb();
    const krefClient = createKrefClient();

    const result = await syncKentuckyCandidateFinance({
      db,
      ...baseInput(),
      krefClient,
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2023,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 1750,
      directContributionTotal: 750,
      outsideSupportTotal: 10_000,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 3,
      includedContributionRowCount: 2,
      skippedContributionRowCount: 1,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 1,
      skippedExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
      candidateContributionRowCount: 3,
      independentExpenditureRowCount: 1,
      outsideContributionRowCount: 1,
    });

    expect(krefClient.downloadCandidateContributions).toHaveBeenCalledWith(
      {
        candidateFirstName: "Andy",
        candidateLastName: "Beshear",
      },
      undefined
    );
    expect(krefClient.downloadIndependentExpenditures).toHaveBeenCalledWith(
      {
        candidateFirstName: "Andy",
        candidateLastName: "Beshear",
      },
      undefined
    );
    expect(krefClient.downloadIeOnlyCommitteeContributions).toHaveBeenCalledWith(
      { organizationName: "Kentucky Future Project Action Fund" },
      undefined
    );

    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledTimes(1);

    const linkCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ky_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2023,
      "ANDY BESHEAR",
      "Governor",
      "Statewide",
      "ANDY BESHEAR|GOVERNOR|STATEWIDE|2023-11-07",
      "BESHEAR CAMPAIGN COMMITTEE",
      "Beshear Campaign Committee",
      "active",
      "kref_public_search",
      "https://secure.kentucky.gov/kref/publicsearch/ToCandidateSearch",
      "2026-06-02T03:04:05.000Z",
    ]);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ky_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2023,
      1750,
      750,
      null,
      null,
      10_000,
      0,
      expect.stringContaining("ExportContributors"),
      "2026-06-02T03:04:05.000Z",
      false,
    ]);

    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.ky_candidate_finance_direct_breakdowns")
      )
    ).toHaveLength(3);
    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.ky_candidate_finance_outside_groups")
      )
    ).toHaveLength(1);
    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.ky_candidate_finance_outside_group_breakdowns")
      )
    ).toHaveLength(2);
  });

  it("lets the filed committee name steer the KREF search only when it names the same person", async () => {
    // "Andrew Beshear" is a formal variant of Andy: search with it. "Friends
    // of Andy Beshear" shares the surname but its first word is not a name:
    // keep the candidate's own search name instead of searching for "Friends".
    for (const [committeeName, expectedFirstName] of [
      ["Andrew Beshear", "Andrew"],
      ["Friends of Andy Beshear", "Andy"],
    ] as const) {
      const krefClient = createKrefClient();
      await syncKentuckyCandidateFinance({
        db: createMockDb(),
        ...baseInput(),
        trustedLink: { ...baseInput().trustedLink, committeeName },
        krefClient,
      });
      expect(krefClient.downloadCandidateContributions).toHaveBeenCalledWith(
        { candidateFirstName: expectedFirstName, candidateLastName: "Beshear" },
        undefined
      );
    }
  });

  it("aggregates only the literal name's rows when they exist, widening to nicknames otherwise", async () => {
    const andrew = contribution({ recipientName: "Andrew Beshear", candidateName: "Andrew Beshear", amount: 9000 });
    const mixed = createKrefClient();
    mixed.downloadCandidateContributions = vi.fn(async () => [contribution({ amount: 250 }), andrew]);
    await expect(
      syncKentuckyCandidateFinance({ db: createMockDb(), ...baseInput(), krefClient: mixed, dryRun: true })
    ).resolves.toMatchObject({ totalReceipts: 250, matchedContributionRowCount: 1 });

    const formalOnly = createKrefClient();
    formalOnly.downloadCandidateContributions = vi.fn(async () => [andrew]);
    await expect(
      syncKentuckyCandidateFinance({ db: createMockDb(), ...baseInput(), krefClient: formalOnly, dryRun: true })
    ).resolves.toMatchObject({ totalReceipts: 9000, matchedContributionRowCount: 1 });
  });

  it("skips independent expenditures for legislative candidates (KREF IE rows carry no district)", async () => {
    const db = createMockDb();
    const krefClient = createKrefClient();

    const result = await syncKentuckyCandidateFinance({
      db,
      ...baseInput(),
      officeName: "State Lower Chamber Legislator",
      location: "45",
      trustedLink: {
        candidateKey: "andy beshear|state lower chamber legislator|state lower|2023-11-07",
        committeeKey: "beshear campaign committee",
        committeeName: "Beshear Campaign Committee",
      },
      krefClient,
    });

    // Two same-name legislative candidates in different districts cannot be
    // told apart in the IE export, so no outside spending is fetched at all.
    expect(krefClient.downloadIndependentExpenditures).not.toHaveBeenCalled();
    expect(result.outsideSupportTotal).toBe(0);
    expect(result.outsideGroupsWritten).toBe(0);
    // Direct contributions ARE district-scoped and still sync.
    expect(krefClient.downloadCandidateContributions).toHaveBeenCalled();
  });

  it("uses district as the direct contribution location when location is omitted", async () => {
    const db = createMockDb();
    const krefClient = createKrefClient();

    const result = await syncKentuckyCandidateFinance({
      db,
      ...baseInput(),
      location: null,
      district: "Statewide",
      krefClient,
    });

    expect(result.directContributionTotal).toBe(750);
    expect(result.includedContributionRowCount).toBe(2);
  });

  it("does not write in dry-run mode but still returns aggregation counts", async () => {
    const db = createMockDb();
    const krefClient = createKrefClient();

    const result = await syncKentuckyCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      krefClient,
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 1750,
      directContributionTotal: 750,
      outsideSupportTotal: 10_000,
      outsideContributionRowCount: 1,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("validates trusted-link inputs before fetching from KREF", async () => {
    const db = createMockDb();
    const krefClient = createKrefClient();

    await expect(
      syncKentuckyCandidateFinance({
        db,
        ...baseInput(),
        trustedLink: {
          candidateKey: " ",
          committeeKey: "beshear campaign committee",
          committeeName: "Beshear Campaign Committee",
        },
        krefClient,
      })
    ).rejects.toThrow("trusted Kentucky candidate key is required");

    expect(krefClient.downloadCandidateContributions).not.toHaveBeenCalled();
    expect(krefClient.downloadIndependentExpenditures).not.toHaveBeenCalled();
    expect(krefClient.downloadIeOnlyCommitteeContributions).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});
