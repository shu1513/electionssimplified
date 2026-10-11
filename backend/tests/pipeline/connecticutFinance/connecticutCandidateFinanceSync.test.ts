import { describe, expect, it, vi } from "vitest";

import { syncConnecticutCandidateFinance } from "../../../src/pipeline/connecticutFinance/connecticutCandidateFinanceSync.js";
import type { ConnecticutEcrisArtifactRow } from "../../../src/pipeline/connecticutFinance/connecticutEcrisArtifactReader.js";
import type { ConnecticutEcrisIndependentExpenditureRow } from "../../../src/pipeline/connecticutFinance/connecticutEcrisIndependentExpenditureParsers.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const IE_SOURCE_URL = "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx";

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function receipt(overrides: Partial<ConnecticutEcrisArtifactRow> = {}): ConnecticutEcrisArtifactRow {
  return {
    Committee: "ACKERT FOR THE 8TH",
    "Contributor Name": "Carolyn Gerrity",
    District: "8",
    "Office Sought": "State Representative",
    Employer: "RTX-Pratt Whitney",
    "Receipt Type": "Itemized Contributions from Individuals",
    "Committee Type": "Candidate Committee",
    "Transaction Date": "03/31/2026",
    "File To State": "04/01/2026",
    Amount: "50.00",
    "Receipt State": "Original",
    Occupation: "Business Manager",
    ElectionYear: "2026",
    "Committee ID": "14376",
    "Candidate First Name": "Timothy",
    "Candidate Middle Intial": "J",
    "Candidate Last Name": "Ackert",
    ...overrides,
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Timothy Ackert",
    electionYear: 2026,
    officeName: "State Lower Chamber Legislator",
    district: "08",
    sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
    receiptSourceUrl:
      "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
    now: new Date("2026-02-03T04:05:06.000Z"),
  };
}

describe("connecticutCandidateFinanceSync", () => {
  it("resolves a candidate committee, aggregates direct receipts, and writes a snapshot", async () => {
    const db = createMockDb();

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      receiptRows: [
        receipt({ Amount: "100.00", Occupation: "Attorney" }),
        receipt({ Amount: "250.00", Occupation: "Teacher" }),
        receipt({
          "Committee ID": "OTHER",
          "Candidate First Name": "Other",
          "Candidate Last Name": "Candidate",
          Amount: "900.00",
          Occupation: "Doctor",
        }),
      ],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      totalReceipts: 350,
      matchedReceiptRowCount: 2,
      includedReceiptRowCount: 2,
      skippedReceiptRowCount: 0,
      resolution: {
        status: "matched",
        committeeId: "14376",
        committeeName: "ACKERT FOR THE 8TH",
      },
    });

    expect(db.query).toHaveBeenCalledTimes(10);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const linkCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ct_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "TIMOTHY ACKERT",
      "State Lower Chamber Legislator",
      "08",
      "14376",
      "ACKERT FOR THE 8TH",
      "active",
      "ecris_bulk",
      "https://seec.ct.gov/portal/ecris/CurPreYears",
      "2026-02-03T04:05:06.000Z",
    ]);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ct_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      350,
      null,
      null,
      null,
      "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
      "2026-02-03T04:05:06.000Z",
    ]);
    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.ct_candidate_finance_direct_breakdowns")
      )
    ).toHaveLength(4);
    expect(
      db.query.mock.calls.some((call) => String(call[0]).includes("DELETE FROM public.ct_candidate_finance_direct_breakdowns"))
    ).toBe(true);
  });

  it("writes outside-spending totals and groups when the year's independent expenditures are supplied", async () => {
    const db = createMockDb();
    const expenditure = (overrides: Partial<ConnecticutEcrisIndependentExpenditureRow> = {}): ConnecticutEcrisIndependentExpenditureRow => ({
      rootExpenditureId: "0",
      committeeName: "Nutmeg Forward",
      formTag: "SEEC40",
      documentUrl: "https://seec.ct.gov/eCrisReporting/Data/Attachment/Unassigned/SEEC40_July_10_Filing_1.PDF",
      reportType: "July 10 Filing",
      documentType: "Original",
      payee: "Shoreline Digital LLC",
      receivedDate: "2026-06-30",
      fileYear: 2026,
      periodStartDate: "2026-04-01",
      periodEndDate: "2026-06-30",
      amountCents: 125_000,
      formSection: "G. Expenses Paid by Committee",
      supportingCandidates: ["Tim Ackert"],
      supportingOffices: ["State Representative"],
      opposingCandidates: [],
      opposingOffices: [],
      dataSource: "eFile",
      ...overrides,
    });

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      receiptRows: [receipt({ Amount: "100.00" })],
      independentExpenditureRows: [
        expenditure(),
        expenditure({ committeeName: "Hands Off Our Schools", amountCents: 50_000, supportingCandidates: [], supportingOffices: [], opposingCandidates: ["Timothy Ackert"], opposingOffices: ["State Representative"] }),
        expenditure({ supportingCandidates: ["Someone Else"] }),
      ],
      independentExpenditureSourceUrl: IE_SOURCE_URL,
    });

    expect(result).toMatchObject({
      linkWritten: true,
      outsideGroupsWritten: 2,
      outsideSupportTotal: 1250,
      outsideOpposeTotal: 500,
      outsideAggregation: { sourceRowCount: 3, targetedRowCount: 2, includedRowCount: 2 },
    });

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ct_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      100,
      null,
      1250,
      500,
      "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
      "2026-02-03T04:05:06.000Z",
    ]);
    const groupCalls = db.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.ct_candidate_finance_outside_groups")
    );
    expect(groupCalls.map((call) => call[1])).toEqual([
      [LINK_ID, 2026, "NUTMEG FORWARD", "Nutmeg Forward", "support", 1250, IE_SOURCE_URL, "2026-02-03T04:05:06.000Z"],
      [LINK_ID, 2026, "HANDS OFF OUR SCHOOLS", "Hands Off Our Schools", "oppose", 500, IE_SOURCE_URL, "2026-02-03T04:05:06.000Z"],
    ]);
    expect(
      db.query.mock.calls.some((call) => String(call[0]).includes("DELETE FROM public.ct_candidate_finance_outside_groups"))
    ).toBe(true);
  });

  it("writes zero outside totals and clears groups when the year's expenditures name nobody", async () => {
    const db = createMockDb();

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      receiptRows: [receipt({ Amount: "100.00" })],
      independentExpenditureRows: [],
    });

    expect(result).toMatchObject({ outsideGroupsWritten: 0, outsideSupportTotal: 0, outsideOpposeTotal: 0 });
    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.ct_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]?.slice(2, 6)).toEqual([100, null, 0, 0]);
    const deleteCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("DELETE FROM public.ct_candidate_finance_outside_groups")
    );
    expect(deleteCall?.[1]).toEqual([LINK_ID, 2026, "[]"]);
  });

  it("leaves stored outside-spending data untouched when no expenditures are supplied", async () => {
    const db = createMockDb();

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      receiptRows: [receipt({ Amount: "100.00" })],
    });

    expect(result).toMatchObject({ outsideGroupsWritten: 0, outsideSupportTotal: null, outsideOpposeTotal: null, outsideAggregation: null });
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("ct_candidate_finance_outside_groups"))).toBe(false);
  });

  it("aggregates but does not write in dry-run mode", async () => {
    const db = createMockDb();

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      receiptRows: [receipt({ Amount: "250.00" })],
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      totalReceipts: 250,
      matchedReceiptRowCount: 1,
      includedReceiptRowCount: 1,
      resolution: { status: "matched", committeeId: "14376" },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not write when committee resolution is unmatched", async () => {
    const db = createMockDb();

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Different Candidate",
      receiptRows: [receipt({ Amount: "250.00" })],
    });

    expect(result).toMatchObject({
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      totalReceipts: null,
      resolution: { status: "unmatched", reason: "no_candidate_office_year_match" },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not write when committee resolution is ambiguous", async () => {
    const db = createMockDb();

    const result = await syncConnecticutCandidateFinance({
      db,
      ...baseInput(),
      receiptRows: [
        receipt({ Amount: "250.00" }),
        receipt({ Committee: "FRIENDS OF TIM ACKERT", "Committee ID": "99999", Amount: "300.00" }),
      ],
    });

    expect(result).toMatchObject({
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      totalReceipts: null,
      resolution: { status: "ambiguous", reason: "multiple_matching_committees" },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("validates required sync inputs before resolving or writing", async () => {
    const db = createMockDb();

    await expect(
      syncConnecticutCandidateFinance({
        db,
        ...baseInput(),
        candidateName: " ",
        receiptRows: [],
      })
    ).rejects.toThrow("candidate name is required");

    await expect(
      syncConnecticutCandidateFinance({
        db,
        ...baseInput(),
        electionYear: 2007,
        receiptRows: [],
      })
    ).rejects.toThrow("Invalid Connecticut finance election year");

    expect(db.query).not.toHaveBeenCalled();
  });
});

it("writes committee donors and source-backed campaign transfer types through the real sync path", async () => {
  const db = createMockDb();
  const result = await syncConnecticutCandidateFinance({
    db, ...baseInput(),
    committeeRegistry: [{ committeeId: "999", committeeName: "Exploratory Donor", committeeType: "Exploratory Committee" }],
    receiptRows: [
      receipt({ "Contributor Name": "Exploratory Donor", "Receipt Type": "Contributions from Other Committees", Amount: "125" }),
      receipt({ "Contributor Name": "Unknown PAC", "Receipt Type": "Contributions from Other Committees", Amount: "50" }),
    ],
  });
  expect(result).toMatchObject({ totalReceipts: 175, pacDonorsWritten: 2 });
  const donorCalls = db.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.ct_candidate_finance_pac_donors"));
  expect(donorCalls).toHaveLength(2);
  expect(donorCalls[0]?.[1]?.slice(2, 7)).toEqual(["999", "Exploratory Donor", "Exploratory Committee", 125, 1]);
});
