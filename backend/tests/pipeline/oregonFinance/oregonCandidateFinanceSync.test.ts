import { describe, expect, it, vi } from "vitest";

import { syncOregonCandidateFinance } from "../../../src/pipeline/oregonFinance/oregonCandidateFinanceSync.js";
import type { OregonOrestarTransactionDetail } from "../../../src/pipeline/oregonFinance/oregonOrestarParser.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do";
const NOW = new Date("2026-06-25T20:00:00.000Z");

function createMockDb() {
  const client = { query: vi.fn(async () => ({ rows: [{ id: LINK_ID }], rowCount: 1 })), release: vi.fn() };
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

function detail(overrides: Partial<OregonOrestarTransactionDetail> = {}): OregonOrestarTransactionDetail {
  return {
    transactionId: "4458653",
    transactionDate: "10/12/2022",
    transactionType: "Contribution",
    transactionSubType: "Cash Contribution",
    filedDate: "10/13/2022",
    amount: 10_000,
    aggregate: 10_000,
    processStatus: "Original",
    purpose: null,
    filerCommitteeName: "Friends of Tina Kotek",
    filerCommitteeId: "4792",
    addressBookType: "Individual",
    contributorPayeeName: "John Ramsbacher",
    address: "123 Main St",
    occupation: "Partner",
    employerName: "A&A Health Services LLC",
    outsideAssociations: [],
    sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
    ...overrides,
  };
}

function baseInput(transactionDetails: OregonOrestarTransactionDetail[]) {
  return {
    db: createMockDb(),
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Tina Kotek",
    electionYear: 2022,
    officeName: "Governor",
    committeeId: "4792",
    committeeName: "Friends of Tina Kotek",
    sourceUrl: SOURCE_URL,
    now: NOW,
    transactionDetails,
  };
}

function transactionDetails(): OregonOrestarTransactionDetail[] {
  return [
    detail({ transactionId: "1", amount: 10_000, occupation: "Partner", contributorPayeeName: "John Ramsbacher" }),
    detail({ transactionId: "2", amount: 150, occupation: "Teacher", contributorPayeeName: "Pat Lane" }),
    detail({
      transactionId: "3",
      transactionType: "Expenditure",
      transactionSubType: "Independent Expenditure",
      filerCommitteeName: "2022 Our Oregon Voter Guide",
      filerCommitteeId: "22333",
      contributorPayeeName: "Mail Vendor",
      addressBookType: "Business Entity",
      occupation: null,
      employerName: null,
      amount: 67_766.61,
      outsideAssociations: [
        {
          associationType: "in_kind_expenditure",
          supportOppose: "support",
          targetCommitteeName: "Friends of Tina Kotek",
          targetCommitteeId: "4792",
          amount: 67_766.61,
          rawText: "In-Kind Expenditure - Friends of Tina Kotek (4792) - $67,766.61",
        },
        {
          associationType: "independent_expenditure",
          supportOppose: "support",
          targetCommitteeName: "Friends of Tina Kotek",
          targetCommitteeId: "4792",
          amount: 67_766.61,
          rawText: "Independent Expenditure in Support - Friends of Tina Kotek (4792) - $67,766.61",
        },
      ],
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4406263",
    }),
    detail({
      transactionId: "4",
      filerCommitteeName: "2022 Our Oregon Voter Guide",
      filerCommitteeId: "22333",
      contributorPayeeName: "SEIU Local 503",
      addressBookType: "Labor Organization",
      occupation: null,
      employerName: null,
      amount: 35_000,
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5001",
    }),
    detail({
      transactionId: "5",
      filerCommitteeName: "2022 Our Oregon Voter Guide",
      filerCommitteeId: "22333",
      contributorPayeeName: "Sierra Club",
      addressBookType: "Organization",
      occupation: null,
      employerName: null,
      amount: 30_000,
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5002",
    }),
    detail({
      transactionId: "6",
      filerCommitteeName: "2022 Our Oregon Voter Guide",
      filerCommitteeId: "22333",
      contributorPayeeName: "Jane Person",
      addressBookType: "Individual",
      occupation: null,
      employerName: null,
      amount: 50_000,
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5003",
    }),
  ];
}

describe("oregonCandidateFinanceSync", () => {
  it("aggregates parsed ORESTAR transaction details and writes an Oregon snapshot", async () => {
    const input = { ...baseInput(transactionDetails()), outsideTransactionDetails: transactionDetails() };
    const result = await syncOregonCandidateFinance(input);

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2022,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 4,
      directContributionTotal: 10_150,
      outsideSupportTotal: 67_766.61,
      outsideOpposeTotal: 0,
      transactionDetailCount: 6,
      matchedDirectContributionRowCount: 2,
      includedDirectContributionRowCount: 2,
      skippedDirectContributionRowCount: 0,
      matchedExpenditureRowCount: 1,
      includedOutsideAssociationCount: 1,
      skippedOutsideAssociationCount: 1,
      matchedOutsideGroupContributionRowCount: 3,
      includedOutsideGroupContributionRowCount: 2,
      skippedOutsideGroupContributionRowCount: 1,
    });

    expect(input.db.query).not.toHaveBeenCalled();
    expect(input.db.client.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "INSERT INTO public.or_candidate_finance_links",
      "INSERT INTO public.or_candidate_finance_summaries",
      "INSERT INTO public.or_candidate_finance_direct_breakdowns",
      "INSERT INTO public.or_candidate_finance_direct_breakdowns",
      "INSERT INTO public.or_candidate_finance_direct_breakdowns",
      "INSERT INTO public.or_candidate_finance_direct_breakdowns",
      "DELETE FROM public.or_candidate_finance_direct_breakdowns",
      "INSERT INTO public.or_candidate_finance_outside_groups",
      "INSERT INTO public.or_candidate_finance_outside_group_breakdowns",
      "INSERT INTO public.or_candidate_finance_outside_group_breakdowns",
      "INSERT INTO public.or_candidate_finance_outside_group_breakdowns",
      "INSERT INTO public.or_candidate_finance_outside_group_breakdowns",
      "DELETE FROM public.or_candidate_finance_outside_group_breakdowns",
      "DELETE FROM public.or_candidate_finance_outside_groups",
      "INSERT INTO public.finance_label_classifications",
      "INSERT INTO public.finance_label_classifications",
      "COMMIT",
    ]);

    const linkCall = input.db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.or_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
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
      SOURCE_URL,
      "2026-06-25T20:00:00.000Z",
    ]);

    const summaryCall = input.db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.or_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2022,
      null,
      10_150,
      null,
      null,
      67_766.61,
      0,
      SOURCE_URL,
      "2026-06-25T20:00:00.000Z",
    ]);
  });

  it("does not write in dry-run mode but returns aggregation counts", async () => {
    const input = { ...baseInput(transactionDetails()), outsideTransactionDetails: transactionDetails() };
    const result = await syncOregonCandidateFinance({ ...input, dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      directContributionTotal: 10_150,
      outsideSupportTotal: 67_766.61,
      outsideOpposeTotal: 0,
    });
    expect(input.db.connect).not.toHaveBeenCalled();
    expect(input.db.query).not.toHaveBeenCalled();
  });

  it("preserves outside data when the receiving committee has no contributions", async () => {
    const input = baseInput([]);
    const result = await syncOregonCandidateFinance(input);

    expect(result).toMatchObject({
      directContributionTotal: 0,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      transactionDetailCount: 0,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
    });
    expect(input.db.client.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "INSERT INTO public.or_candidate_finance_links",
      "INSERT INTO public.or_candidate_finance_summaries",
      "DELETE FROM public.or_candidate_finance_direct_breakdowns",
      "COMMIT",
    ]);
  });

  it("never treats receiving receipts or in-kind associations as outside-source coverage", async () => {
    const input = baseInput(transactionDetails());
    const result = await syncOregonCandidateFinance(input);

    expect(result).toMatchObject({
      directContributionTotal: 10_150,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      includedOutsideAssociationCount: 0,
    });
    const sql = input.db.client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("or_candidate_finance_outside_"))).toBe(false);
    const summaryCall = input.db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.or_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID, 2022, null, 10_150, null, null, null, null, SOURCE_URL, NOW.toISOString(),
    ]);
  });

  it("validates required fields and limits before writing", async () => {
    const input = baseInput(transactionDetails());

    await expect(syncOregonCandidateFinance({ ...input, committeeId: " " })).rejects.toThrow(
      "Oregon ORESTAR committee ID is required"
    );
    await expect(syncOregonCandidateFinance({ ...input, electionYear: 1999 })).rejects.toThrow(
      "Invalid Oregon finance election year"
    );
    await expect(syncOregonCandidateFinance({ ...input, outsideMaxGroups: 0 })).rejects.toThrow(
      "Invalid Oregon finance outsideMaxGroups"
    );
    expect(input.db.connect).not.toHaveBeenCalled();
  });
});
