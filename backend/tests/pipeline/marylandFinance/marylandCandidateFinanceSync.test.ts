import { describe, expect, it, vi } from "vitest";

import { syncMarylandCandidateFinance } from "../../../src/pipeline/marylandFinance/marylandCandidateFinanceSync.js";
import type {
  MarylandCfsCommitteeRow,
  MarylandCfsContributionRow,
  MarylandCfsExpenditureRow,
} from "../../../src/pipeline/marylandFinance/marylandCfsArtifactReader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://campaignfinance.maryland.gov/public/cf/downloads";

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

function committee(overrides: Partial<MarylandCfsCommitteeRow> = {}): MarylandCfsCommitteeRow {
  return {
    "Filing Entity Id": "16018290",
    "Committee Name": "Gallucci, Justin Friends of",
    "Abbreviated Committee Name": "Gallucci",
    "Committee Type": "Candidate Committee",
    Election: "2026 Gubernatorial",
    "Treasurer/Authorized Agent Name": "",
    "Treasurer/Authorized Agent Public Address1": "",
    "Treasurer/Authorized Agent Address2": "",
    "Treasurer/Authorized Agent City": "",
    "Treasurer/Authorized Agent State": "",
    "Treasurer/Authorized Agent Zip Code": "",
    "Chairperson/Principal Officer Name": "",
    "Chairperson/Principal Officer Public Address1": "",
    "Chairperson/Principal Officer Address2": "",
    "Chairperson/Principal Officer City": "",
    "Chairperson/Principal Officer State": "",
    "Chairperson/Principal Officer Zip Code": "",
    "Committee Mailing Address1": "",
    "Committee Mailing Address2": "",
    "Committee City": "Annapolis",
    "Committee State": "MD",
    "Committee ZipCode": '="21401"',
    "Committee Phone": "",
    "Committee Email": "",
    "Registration Submission Date": "",
    "Registration Approval Date": "",
    "Registration Dissolved Date": "",
    "Candidate LastName": "Gallucci",
    "Candidate First Name": "Justin",
    "Candidate Middle Name": "",
    "Candidate Suffix": "",
    "Candidate DOB": "",
    "Candidate Public Address1": "",
    "Candidate Address2": "",
    "Candidate City": "",
    "Candidate State": "",
    "Candidate Zip Code": "",
    "Candidate Email": "",
    "Candidate Public Phone": "",
    "Entity Type": "",
    "Entity Name": "",
    "Notifying Of Disbursements Made": "",
    "Notification Website": "",
    Jurisdiction: "Maryland State",
    "Office Sought": "State Senator",
    "Party Affiliation": "Democratic",
    "State The Committee IsLocated": "MD",
    "Supporting Organization": "",
    "Purpose Of The Committee": "",
    "Purpose Description": "",
    "Affiliated CommitteeName": "",
    Location: "",
    "Ballot Issue": "",
    "Official Ballot Name": "",
    "Petition Sponsor": "",
    Position: "",
    "Election Year": "2026",
    Website: "",
    Facebook: "",
    Instagram: "",
    "X (Twitter)": "",
    LinkedIn: "",
    ...overrides,
  };
}

function contribution(overrides: Partial<MarylandCfsContributionRow> = {}): MarylandCfsContributionRow {
  return {
    "Filing Entity Id": "16018290",
    "Committee Name": "Gallucci, Justin Friends of",
    "Abbreviated Committee Name": "",
    "Committee Type": "Candidate Committee",
    "Contributor Type": "Individual",
    "Contributor Company Name": "",
    "Contributor Last Name": "Doe",
    "Contributor First Name": "Jane",
    "Contributor Middle Name": "",
    "Contributor Mailing Address1": "100 Main St",
    "Contributor Mailing Address2": "",
    "Contributor City": "Annapolis",
    "Contributor State": "MD",
    "Contributor ZipCode": '="21401"',
    "Contributor County Of Residence": "Anne Arundel",
    "Transaction Type": "Contribution",
    "Transaction Date": "01/10/2026",
    "Transaction Amount": "$250.00",
    "Payment Type": "Check",
    "Fund Type": "Electoral",
    "Number Of People Purchasing Or Making Contributions": "",
    "Price Per Person Or Average Contribution": "",
    "Coordinated In-Kind": "False",
    "Public Funding Requested": "False",
    "Amount Eligible For Public Funding": "$0.00",
    Description: "",
    "Report Name": "2026 Pre-Primary",
    "Aggregate As Of Download Date": "$250.00",
    ...overrides,
  };
}

function expenditure(overrides: Partial<MarylandCfsExpenditureRow> = {}): MarylandCfsExpenditureRow {
  return {
    "Filing Entity Id": "16020184",
    "Committee Name": "Momentum Maryland PAC",
    "Abbreviated Committee Name": "Momentum MD",
    "Committee Type": "Political Action Committee",
    "Payee Type": "Business Entity",
    "Payee Company Name": "Media Vendor LLC",
    "Payee Last Name": "",
    "Payee First Name": "",
    "Payee Middle Name": "",
    "Payee Country": "United States",
    "Payee Mailing Address1": "",
    "Payee Mailing Address2": "",
    "Payee City": "Annapolis",
    "Payee State": "MD",
    "Payee Zip Code": "",
    "Vendor Type": "Advertising",
    "Vendor Name": "Media Vendor LLC",
    "Vendor Country": "United States",
    "Vendor Mailing Address1": "",
    "Vendor Mailing Address2": "",
    "Vendor City": "Annapolis",
    "Vendor State": "MD",
    "Vendor Zip Code": "",
    "Transaction Type": "Expenditure",
    "Transaction Date": "03/15/2026",
    "Transaction Amount": "$10,000.00",
    Category: "Media",
    Purpose: "Independent expenditure",
    "Fund Type": "Electoral",
    Description: "Digital ads",
    "Pay In-Kind Contribution": "False",
    "Committee Filing Entity ID": "",
    "Report Name": "2026 Pre-Primary",
    "Candidate/Ballot Issue": "Gallucci, Justin",
    "Office Sought": "State Senator",
    Position: "Support",
    "Amount Applied": "$7,500.00",
    ...overrides,
  };
}

describe("marylandCandidateFinanceSync", () => {
  it.each([
    { reason: "empty source", rows: [] },
    { reason: "unresolved committee target", rows: [expenditure({ "Candidate/Ballot Issue": "Gallucci, Justin Friends of" })] },
    { reason: "missing target office", rows: [expenditure({ "Office Sought": "" })] },
    { reason: "rejected stance", rows: [expenditure({ Position: "unknown" })] },
  ])("preserves outside evidence for $reason while direct processing proceeds", async ({ rows }) => {
    const db = createMockDb();
    const result = await syncMarylandCandidateFinance({
      db,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      candidateName: "Justin Gallucci",
      electionYear: 2026,
      officeScope: "state_upper",
      officeName: "State Senator",
      sourceUrl: SOURCE_URL,
      trustedCommittee: { committeeId: "16018290", committeeName: "Gallucci, Justin Friends of" },
      committeeRows: [],
      contributionRows: [contribution()],
      expenditureRows: rows,
      now: new Date("2026-07-08T09:10:11.000Z"),
    });
    expect(result).toMatchObject({ directContributionTotal: 250, summaryWritten: true,
      outsideSupportTotal: null, outsideOpposeTotal: null, outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0 });
    const outsideMutations = db.query.mock.calls.filter(call =>
      /(?:DELETE FROM|INSERT INTO) public\.md_candidate_finance_outside/.test(String(call[0])));
    expect(outsideMutations).toHaveLength(0);
    const summaryCall = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.md_candidate_finance_summaries"));
    expect(summaryCall?.[1]?.slice(6,8)).toEqual([null,null]);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("INSERT INTO public.md_candidate_finance_direct_breakdowns"))).toBe(true);
  });

  it("writes direct finance but preserves outside evidence even for a positive legacy aggregate", async () => {
    const db = createMockDb();

    const result = await syncMarylandCandidateFinance({
      db,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      candidateName: "Justin Gallucci",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      sourceUrl: SOURCE_URL,
      committeeRows: [committee({ "Office Sought": "Governor/Lieutenant Governor" })],
      contributionRows: [
        contribution({ "Transaction Amount": "$250.00" }),
        contribution({
          "Filing Entity Id": "16020184",
          "Committee Name": "Momentum Maryland PAC",
          "Committee Type": "Political Action Committee",
          "Contributor Type": "Business Entity",
          "Contributor Company Name": "Old Construction Company LLC",
          "Contributor Last Name": "",
          "Contributor First Name": "",
          "Transaction Amount": "$30,000.00",
        }),
      ],
      expenditureRows: [expenditure({ "Office Sought": "Governor/Lieutenant Governor" })],
      now: new Date("2026-07-08T09:10:11.000Z"),
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 0,
      totalReceipts: 250,
      directContributionTotal: 250,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 1,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
    });
    expect(result.resolution).toMatchObject({
      status: "matched",
      committeeId: "16018290",
    });
    expect(result.outsideGroupBreakdownsWritten).toBe(0);

    const sql = db.query.mock.calls.map((call) => String(call[0]));
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.md_candidate_finance_summaries"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.md_candidate_finance_direct_breakdowns"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.md_candidate_finance_outside_groups"))).toHaveLength(0);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.md_candidate_finance_outside_group_breakdowns"))).toHaveLength(0);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.finance_label_classifications"))).toHaveLength(0);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.md_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      250,
      250,
      null,
      null,
      null,
      null,
      SOURCE_URL,
      "2026-07-08T09:10:11.000Z",
    ]);

    expect(sql.some(statement => /DELETE FROM public\.md_candidate_finance_outside/.test(statement))).toBe(false);
    expect(String(summaryCall?.[0])).toContain(
      'outside_support_total = COALESCE(EXCLUDED.outside_support_total, md_candidate_finance_summaries.outside_support_total)'
    );
    expect(String(summaryCall?.[0])).toContain(
      'outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, md_candidate_finance_summaries.outside_oppose_total)'
    );
    expect(sql).toContain("COMMIT");
  });

  it("does not classify or persist legacy outside donors even when a donor cap is configured", async () => {
    const db = createMockDb();
    const classifier = vi.fn().mockResolvedValue([]);

    const result = await syncMarylandCandidateFinance({
      db,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      candidateName: "Justin Gallucci",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      sourceUrl: SOURCE_URL,
      committeeRows: [committee({ "Office Sought": "Governor/Lieutenant Governor" })],
      // A display cap is not source authority for any legacy outside writes.
      outsideMaxDonorBreakdownsPerGroup: 1,
      financeIndustryClassifier: classifier,
      contributionRows: [
        contribution({
          "Filing Entity Id": "16020184",
          "Committee Name": "Momentum Maryland PAC",
          "Committee Type": "Political Action Committee",
          "Contributor Type": "Political Committee",
          "Contributor Company Name": "IBEW Local 26 PAC",
          "Contributor Last Name": "",
          "Contributor First Name": "",
          "Transaction Amount": "$30,000.00",
        }),
        contribution({
          "Filing Entity Id": "16020184",
          "Committee Name": "Momentum Maryland PAC",
          "Committee Type": "Political Action Committee",
          "Contributor Type": "Political Committee",
          "Contributor Company Name": "IBEW Local 24 PAC",
          "Contributor Last Name": "",
          "Contributor First Name": "",
          "Transaction Amount": "$20,000.00",
        }),
      ],
      expenditureRows: [expenditure({ "Office Sought": "Governor/Lieutenant Governor" })],
      now: new Date("2026-07-08T09:10:11.000Z"),
    });

    expect(result).toMatchObject({
      summaryWritten: true,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      matchedOutsideContributionRowCount: 2,
      includedOutsideContributionRowCount: 2,
    });
    const sql = db.query.mock.calls.map(call => String(call[0]));
    expect(sql.some(statement => /(?:INSERT INTO|DELETE FROM) public\.md_candidate_finance_outside/.test(statement))).toBe(false);
    expect(sql.some(statement => statement.includes("finance_label_classifications"))).toBe(false);
    expect(classifier).not.toHaveBeenCalled();
    expect(sql).toContain("COMMIT");
  });

  it("does not write when resolution is unmatched or dry run is enabled", async () => {
    const unmatchedDb = createMockDb();
    const unmatched = await syncMarylandCandidateFinance({
      db: unmatchedDb,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      candidateName: "Missing Candidate",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      committeeRows: [committee({ "Office Sought": "Governor/Lieutenant Governor" })],
      contributionRows: [contribution()],
    });

    expect(unmatched.resolution.status).toBe("unmatched");
    expect(unmatched.linkWritten).toBe(false);
    expect(unmatchedDb.connect).not.toHaveBeenCalled();

    const dryRunDb = createMockDb();
    const dryRun = await syncMarylandCandidateFinance({
      db: dryRunDb,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      candidateName: "Justin Gallucci",
      electionYear: 2026,
      officeScope: "statewide",
      officeName: "Governor",
      committeeRows: [committee({ "Office Sought": "Governor/Lieutenant Governor" })],
      contributionRows: [contribution()],
      dryRun: true,
    });

    expect(dryRun.resolution.status).toBe("matched");
    expect(dryRun.directContributionTotal).toBe(250);
    expect(dryRun.linkWritten).toBe(false);
    expect(dryRunDb.connect).not.toHaveBeenCalled();
  });
});
