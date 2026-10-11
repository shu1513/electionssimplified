import { describe, expect, it, vi } from "vitest";

import { syncDistrictOfColumbiaCandidateFinance } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateFinanceSync.js";
import type {
  DistrictOfColumbiaOcfContributionRecord,
  DistrictOfColumbiaOcfExpenditureRecord,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaOcfClient.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://efiling.ocf.dc.gov/DataDownload/Export?exportType=CSV";

function createMockDb() {
  const poolQuery = vi.fn(async (sql: string) => {
    if (String(sql).includes("FROM public.finance_label_classifications AS classification")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [{ id: LINK_ID }], rowCount: 1 };
  });
  const clientQuery = vi.fn(async () => ({ rows: [{ id: LINK_ID }], rowCount: 1 }));
  const client = {
    query: clientQuery,
    release: vi.fn(),
  };
  return {
    query: poolQuery,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

function directContribution(overrides: Partial<DistrictOfColumbiaOcfContributionRecord> = {}): DistrictOfColumbiaOcfContributionRecord {
  return {
    committeeName: "Committee To Elect Jane Doe",
    committeeKey: "COMMITTEE TO ELECT JANE DOE",
    candidateName: "Jane Doe",
    contributorName: "Pat Person",
    contributorType: "Individual",
    occupation: "Attorney",
    amount: 250,
    date: "01/10/2026",
    ...overrides,
  };
}

function expenditure(overrides: Partial<DistrictOfColumbiaOcfExpenditureRecord> = {}): DistrictOfColumbiaOcfExpenditureRecord {
  return {
    committeeName: "DCCSA IEC",
    committeeKey: "DCCSA IEC",
    payeeName: "Media Vendor",
    purpose: "Independent Expenditures",
    furtherExplanation: "Digital ads supporting Jane Doe",
    amount: 2500,
    date: "05/01/2026",
    ...overrides,
  };
}

function outsideContribution(overrides: Partial<DistrictOfColumbiaOcfContributionRecord> = {}): DistrictOfColumbiaOcfContributionRecord {
  return {
    committeeName: "DCCSA IEC",
    committeeKey: "DCCSA IEC",
    contributorName: "Guzman Construction Solutions LLC",
    contributorType: "Business Entity",
    amount: 35_000,
    date: "03/12/2026",
    ...overrides,
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Jane Doe",
    electionYear: 2026,
    officeScope: "place",
    officeName: "Mayor",
    sourceUrl: SOURCE_URL,
    now: new Date("2026-07-08T09:10:11.000Z"),
  };
}

describe("districtOfColumbiaCandidateFinanceSync", () => {
  it("resolves a committee, aggregates direct and outside data, and writes a snapshot", async () => {
    const db = createMockDb();

    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      contributionRecords: [
        directContribution({ amount: 100, occupation: "Attorney", contributorName: "Pat Person" }),
        directContribution({ amount: 250, occupation: "Attorney", contributorName: "Sam Person" }),
        directContribution({ amount: 5000, occupation: "Teacher", contributorName: "Alex Person" }),
      ],
      expenditureRecords: [expenditure()],
      outsideContributionRecords: [outsideContribution()],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 5,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 5350,
      directContributionTotal: 5350,
      totalDisbursements: null,
      outsideSupportTotal: 2500,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 3,
      includedContributionRowCount: 3,
      skippedContributionRowCount: 0,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 1,
      skippedExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
      outsideGroupCount: 1,
      resolution: {
        status: "matched",
        committeeKey: "COMMITTEE TO ELECT JANE DOE",
      },
    });

    // The pool handle only serves the read-only cached-classification
    // lookup; every write goes through the transactional client.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.finance_label_classifications");
    expect(db.client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const linkCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.dc_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "JANE DOE",
      "Mayor",
      null,
      "COMMITTEE TO ELECT JANE DOE",
      "Committee To Elect Jane Doe",
      "active",
      "ocf_export",
      SOURCE_URL,
      "2026-07-08T09:10:11.000Z",
    ]);

    const summaryCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.dc_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      5350,
      5350,
      null,
      null,
      2500,
      0,
      SOURCE_URL,
      "2026-07-08T09:10:11.000Z",
    ]);

    expect(
      db.client.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.dc_candidate_finance_direct_breakdowns")
      )
    ).toHaveLength(5);
    expect(
      db.client.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.dc_candidate_finance_outside_groups")
      )
    ).toHaveLength(1);
    const outsideBreakdownCalls = db.client.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.dc_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual([
      [LINK_ID, 2026, "DCCSA IEC", "support", "donor", "Guzman Construction Solutions LLC", 35000, 1, SOURCE_URL, "2026-07-08T09:10:11.000Z"],
      [LINK_ID, 2026, "DCCSA IEC", "support", "industry", "construction", 35000, 1, SOURCE_URL, "2026-07-08T09:10:11.000Z"],
    ]);
  });

  it("classifies every outside donor but caps the persisted donor rows per group", async () => {
    const db = createMockDb();

    // Cap of 1: the smaller Anacostia donor must be dropped from the WRITTEN
    // donor rows, yet still feed the classifications and the rebuilt
    // construction industry total.
    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      outsideMaxBreakdownsPerCategory: 1,
      contributionRecords: [directContribution({ amount: 250 })],
      expenditureRecords: [expenditure()],
      outsideContributionRecords: [
        outsideContribution({ amount: 50_000 }),
        outsideContribution({ contributorName: "Anacostia Builders LLC", amount: 25_000 }),
      ],
    });

    // 1 capped donor row + 1 industry row built from BOTH donors.
    expect(result.outsideGroupBreakdownsWritten).toBe(2);
    const breakdownInsertParams = db.client.query.mock.calls
      .filter((call) => String(call[0]).includes("dc_candidate_finance_outside_group_breakdowns"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(breakdownInsertParams).toContain("Guzman Construction Solutions LLC");
    expect(breakdownInsertParams).not.toContain("Anacostia Builders LLC");
    // The rebuilt industry total covers the dropped donor too.
    expect(breakdownInsertParams).toContain("construction");
    expect(breakdownInsertParams).toContain(75_000);
    // Both donors persisted classification rows.
    const classificationParams = db.client.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(classificationParams).toContain("Guzman Construction Solutions LLC");
    expect(classificationParams).toContain("Anacostia Builders LLC");
  });

  it("aggregates but does not write in dry-run mode", async () => {
    const db = createMockDb();

    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      contributionRecords: [directContribution({ amount: 1000 })],
      expenditureRecords: [expenditure()],
      outsideContributionRecords: [outsideContribution()],
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 1000,
      outsideSupportTotal: 2500,
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("reports outside totals from all matched groups even when persisted groups are capped", async () => {
    const db = createMockDb();

    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      trustedCommittee: {
        committeeKey: "COMMITTEE TO ELECT JANE DOE",
        committeeName: "Committee To Elect Jane Doe",
        sourceUrl: SOURCE_URL,
      },
      outsideMaxGroups: 1,
      expenditureRecords: [
        expenditure({ committeeName: "Small IEC", committeeKey: "SMALL IEC", amount: 500 }),
        expenditure({ committeeName: "Large IEC", committeeKey: "LARGE IEC", amount: 2500 }),
        expenditure({
          committeeName: "Oppose IEC",
          committeeKey: "OPPOSE IEC",
          furtherExplanation: "Digital ads opposing Jane Doe",
          amount: 1000,
        }),
      ],
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupCount: 1,
      outsideSupportTotal: 3000,
      outsideOpposeTotal: 1000,
    });

    const summaryCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.dc_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      null,
      null,
      null,
      null,
      3000,
      1000,
      SOURCE_URL,
      "2026-07-08T09:10:11.000Z",
    ]);
    expect(
      db.client.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.dc_candidate_finance_outside_groups")
      )
    ).toHaveLength(1);
  });

  it("does not write when committee resolution is unmatched", async () => {
    const db = createMockDb();

    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      contributionRecords: [],
    });

    expect(result).toMatchObject({
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      totalReceipts: null,
      resolution: { status: "unmatched", reason: "no_candidate_committee_match" },
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("uses the shared classifier for high-dollar unknown outside organization donors", async () => {
    const db = createMockDb();
    const financeIndustryClassifier = vi.fn(async ({ labels }) =>
      labels.map((label) => ({
        rawLabel: label.rawLabel,
        labelType: label.labelType,
        normalizedLabel: label.normalizedLabel,
        industrySlug: "technology" as const,
        confidence: "medium" as const,
        classificationSource: "ai" as const,
        matchedRule: null,
      }))
    );

    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      trustedCommittee: {
        committeeKey: "COMMITTEE TO ELECT JANE DOE",
        committeeName: "Committee To Elect Jane Doe",
        sourceUrl: SOURCE_URL,
      },
      expenditureRecords: [expenditure()],
      outsideContributionRecords: [
        outsideContribution({
          contributorName: "Evergreen Strategic Holdings",
          contributorType: "Business",
          amount: 30_000,
        }),
      ],
      financeIndustryClassifier,
      aiClassificationMinAmount: 25_000,
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      outsideSupportTotal: 2500,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
    });
    expect(financeIndustryClassifier).toHaveBeenCalledWith({
      labels: [
        expect.objectContaining({
          rawLabel: "Evergreen Strategic Holdings",
          labelType: "donor",
          amount: 30000,
        }),
      ],
    });

    const outsideBreakdownCalls = db.client.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.dc_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        [LINK_ID, 2026, "DCCSA IEC", "support", "industry", "technology", 30000, 1, SOURCE_URL, "2026-07-08T09:10:11.000Z"],
      ])
    );
  });

  it("writes Fair Elections public funds and spending for a program committee", async () => {
    const db = createMockDb();
    const committeeKey = "DC FAIR ELECTIONS 159";
    const fairElections = (overrides: Partial<DistrictOfColumbiaOcfContributionRecord>) =>
      directContribution({
        committeeName: "Brian for DC 2026",
        committeeKey,
        candidateName: "Brian L. Schwalb",
        office: "Attorney General",
        electionYear: 2026,
        receiptKind: "contribution",
        ...overrides,
      });

    const result = await syncDistrictOfColumbiaCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Brian Schwalb",
      officeScope: "statewide",
      officeName: "Attorney General",
      contributionRecords: [
        fairElections({ amount: 200, occupation: "CEO" }),
        fairElections({ amount: 3000, receiptKind: "public_funds", contributorName: undefined, occupation: undefined }),
        fairElections({ amount: 50, receiptKind: "other", contributorName: undefined, occupation: undefined }),
      ],
      committeeExpenditureRecords: [
        { committeeName: "Brian for DC 2026", committeeKey, amount: 1200.5 },
        { committeeName: "Brian for DC 2026", committeeKey, amount: 99.5 },
        { committeeName: "Other", committeeKey: "DC FAIR ELECTIONS 174", amount: 5000 },
      ],
    });

    expect(result).toMatchObject({
      resolution: { status: "matched", committeeKey },
      totalReceipts: 3250,
      directContributionTotal: 200,
      publicFundsReceived: 3000,
      totalDisbursements: 1300,
    });
    const summaryCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.dc_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]?.slice(2, 5)).toEqual([3250, 200, 1300]);
    // Public funds land in the same transaction as the summary.
    const publicFundsCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("SET public_funds_received")
    );
    expect(publicFundsCall?.[1]).toEqual([LINK_ID, 2026, 3000]);
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
});
