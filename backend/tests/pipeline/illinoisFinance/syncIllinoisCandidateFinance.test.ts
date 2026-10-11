import { describe, expect, it, vi } from "vitest";

import { syncIllinoisCandidateFinance } from "../../../src/pipeline/illinoisFinance/syncIllinoisCandidateFinance.js";
import type {
  IllinoisSbeContributionRecord,
  IllinoisSbeExpenditureRecord,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeClient.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCandidates.aspx";

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

function contribution(overrides: Partial<IllinoisSbeContributionRecord> = {}): IllinoisSbeContributionRecord {
  return {
    contributorName: "Pat Person",
    contributorAddress: "1 Main St",
    occupation: "Attorney",
    employer: "Law LLP",
    amount: 250,
    receivedDate: "3/1/2022",
    reportReceivedDate: null,
    contributionType: "Individual Contributions",
    recipientCommitteeName: "Friends of Jane",
    description: null,
    vendorName: null,
    vendorAddress: null,
    sourceUrl: SOURCE_URL,
    ...overrides,
  };
}

function expenditure(overrides: Partial<IllinoisSbeExpenditureRecord> = {}): IllinoisSbeExpenditureRecord {
  return {
    payeeName: "Media Vendor",
    payeeAddress: null,
    amount: 2500,
    expendedDate: "10/1/2022",
    reportReceivedDate: null,
    expenditureType: "Independent Expenditures",
    expendingCommitteeName: "Illinois Conservation Action",
    purpose: "Digital ads",
    candidateName: "Jane Doe",
    officeDistrict: "Governor",
    supportOppose: "support",
    sourceUrl: "https://www.elections.il.gov/CampaignDisclosure/ExpenditureSearchByAllExpenditures.aspx",
    ...overrides,
  };
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Jane Doe",
    electionYear: 2022,
    officeName: "Governor",
    committeeKey: "FRIENDS OF JANE",
    committeeName: "Friends of Jane",
    sourceUrl: SOURCE_URL,
    now: new Date("2022-07-08T09:10:11.000Z"),
  };
}

describe("syncIllinoisCandidateFinance", () => {
  it("aggregates Illinois SBE rows and writes a finance snapshot", async () => {
    const db = createMockDb();

    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      directContributionRecords: [
        contribution({ amount: 100, occupation: "Attorney", contributorName: "Pat Person" }),
        contribution({ amount: 250, occupation: "Attorney", contributorName: "Sam Person" }),
        contribution({ amount: 5000, occupation: "Teacher", contributorName: "Alex Person" }),
      ],
      outsideExpenditureRecords: [expenditure()],
      outsideGroupContributionRecords: [
        contribution({
          contributorName: "Sierra Club",
          contributorAddress: null,
          occupation: null,
          employer: null,
          amount: 35_000,
          contributionType: "Transfers In",
          recipientCommitteeName: "Illinois Conservation Action",
          receivedDate: "8/1/2022",
          sourceUrl: "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCommittees.aspx",
        }),
      ],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2022,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 5,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 5350,
      directContributionTotal: 5350,
      outsideExpenditureDataAvailable: true,
      outsideGroupContributionDataAvailable: true,
      outsideSupportTotal: 2500,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 3,
      includedContributionRowCount: 3,
      skippedContributionRowCount: 0,
      matchedOutsideExpenditureRowCount: 1,
      includedOutsideExpenditureRowCount: 1,
      skippedOutsideExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
    });

    // The pool handle only serves the read-only cached-classification
    // lookup; every write goes through the transactional client.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.finance_label_classifications");
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const linkCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2022,
      "JANE DOE",
      "Governor",
      null,
      null,
      null,
      null,
      null,
      "FRIENDS OF JANE",
      "Friends of Jane",
      "active",
      "illinois_sbe",
      SOURCE_URL,
      "2022-07-08T09:10:11.000Z",
    ]);

    const outsideBreakdownCalls = db.client.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual([
      [
        LINK_ID,
        2022,
        "ILLINOIS CONSERVATION ACTION",
        "support",
        "donor",
        "Sierra Club",
        35000,
        1,
        "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCommittees.aspx",
        "2022-07-08T09:10:11.000Z",
      ],
      [
        LINK_ID,
        2022,
        "ILLINOIS CONSERVATION ACTION",
        "support",
        "industry",
        "environmental_group",
        35000,
        1,
        "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCommittees.aspx",
        "2022-07-08T09:10:11.000Z",
      ],
    ]);
  });

  it("aggregates but does not write in dry-run mode", async () => {
    const db = createMockDb();

    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      directContributionRecords: [contribution({ amount: 1000 })],
      outsideExpenditureRecords: [expenditure()],
      outsideGroupContributionRecords: [
        contribution({
          contributorName: "Sierra Club",
          contributorAddress: null,
          amount: 35_000,
          recipientCommitteeName: "Illinois Conservation Action",
          receivedDate: "8/1/2022",
        }),
      ],
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 1000,
      outsideExpenditureDataAvailable: true,
      outsideGroupContributionDataAvailable: true,
      outsideSupportTotal: 2500,
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("preserves outside group breakdowns when outside funder rows were not fetched", async () => {
    const db = createMockDb();

    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      directContributionRecords: [contribution({ amount: 1000 })],
      outsideExpenditureRecords: [expenditure()],
    });

    expect(result).toMatchObject({
      outsideExpenditureDataAvailable: true,
      outsideGroupContributionDataAvailable: false,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    });
    const statements = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_outside_groups"))).toBe(true);
    expect(
      statements.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_outside_group_breakdowns"))
    ).toBe(false);
    expect(
      statements.some((statement) => statement.includes("DELETE FROM public.il_candidate_finance_outside_group_breakdowns"))
    ).toBe(false);
  });

  it("marks outside data unavailable when outside expenditure rows were not supplied", async () => {
    const db = createMockDb();

    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      directContributionRecords: [contribution({ amount: 1000 })],
    });

    expect(result).toMatchObject({
      outsideExpenditureDataAvailable: false,
      outsideGroupContributionDataAvailable: false,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      matchedOutsideExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
    });

    const summaryCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2022,
      1000,
      1000,
      null,
      null,
      null,
      null,
      null,
      SOURCE_URL,
      "2022-07-08T09:10:11.000Z",
      false,
    ]);
    const statements = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_outside_groups"))).toBe(false);
    expect(
      statements.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_outside_group_breakdowns"))
    ).toBe(false);
  });

  it("uses D-2 summaries for local totals instead of itemized receipt sums", async () => {
    const db = createMockDb();
    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      electionYear: 2025,
      officeScope: "place",
      officeName: "Mayor",
      district: "Aurora",
      sbeCandidateId: "101",
      sbeDistrictType: "City",
      sbeOffice: "Mayor",
      isAtLarge: false,
      sbeCommitteeId: "201",
      committeeKey: "SBE:201",
      committeeName: "Aurora Forward",
      directContributionRecords: [contribution({ amount: 250, receivedDate: "3/1/2025" })],
      d2ReportSummaries: [
        {
          reportId: "q1",
          committeeId: "201",
          periodStart: "2024-01-01",
          periodEnd: "2024-03-31",
          filedAt: "2024-04-15T12:00:00.000Z",
          totalReceipts: 1200,
          totalDisbursements: 550,
          cashOnHand: 800,
          debtsOwed: 90,
          sourceUrl: "https://www.elections.il.gov/CampaignDisclosure/CommitteeDetail.aspx?ID=201",
        },
      ],
    });

    expect(result).toMatchObject({
      totalReceipts: 1200,
      directContributionTotal: null,
      totalDisbursements: 550,
      cashOnHand: 800,
      debtsOwed: 90,
    });
    const summaryCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2025,
      1200,
      null,
      550,
      800,
      90,
      null,
      null,
      "https://www.elections.il.gov/CampaignDisclosure/CommitteeDetail.aspx?ID=201",
      "2022-07-08T09:10:11.000Z",
      true,
    ]);
  });

  it("does not overwrite a local D-2 summary when D-2 data was unavailable", async () => {
    const db = createMockDb();
    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      electionYear: 2025,
      officeScope: "place",
      officeName: "Mayor",
      district: "Aurora",
      sbeCandidateId: "101",
      sbeDistrictType: "City",
      sbeOffice: "Mayor",
      isAtLarge: false,
      sbeCommitteeId: "201",
      committeeKey: "SBE:201",
      committeeName: "Aurora Forward",
      directContributionRecords: [contribution({ amount: 250, receivedDate: "3/1/2025" })],
    });

    expect(result).toMatchObject({
      linkWritten: true,
      summaryWritten: false,
      totalReceipts: null,
      totalDisbursements: null,
      cashOnHand: null,
      debtsOwed: null,
    });
    const statements = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_links"))).toBe(true);
    expect(statements.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_summaries"))).toBe(false);
  });

  it("uses shared AI classification for high-dollar unknown PAC funders", async () => {
    const db = createMockDb();
    const classifier = vi.fn().mockResolvedValue([
      {
        rawLabel: "Made Up Homes LLC",
        labelType: "donor",
        normalizedLabel: "MADE UP HOMES",
        industrySlug: "real_estate",
        confidence: "medium",
        classificationSource: "ai",
        matchedRule: null,
      },
    ]);

    await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      financeIndustryClassifier: classifier,
      aiClassificationMinAmount: 25_000,
      directContributionRecords: [contribution({ amount: 100 })],
      outsideExpenditureRecords: [expenditure()],
      outsideGroupContributionRecords: [
        contribution({
          contributorName: "Made Up Homes LLC",
          contributorAddress: null,
          occupation: null,
          employer: null,
          amount: 25_000,
          contributionType: "Transfers In",
          recipientCommitteeName: "Illinois Conservation Action",
          receivedDate: "8/1/2022",
        }),
      ],
    });

    expect(classifier).toHaveBeenCalledWith({
      labels: [
        {
          rawLabel: "Made Up Homes LLC",
          labelType: "donor",
          normalizedLabel: "MADE UP HOMES",
          amount: 25000,
        },
      ],
    });
    const params = db.client.query.mock.calls.map((call) => call[1]).filter(Array.isArray);
    expect(params.some((paramList) => paramList.includes("real_estate"))).toBe(true);
  });
});

describe("syncIllinoisCandidateFinance without an itemized contribution source", () => {
  it("preserves existing direct breakdowns instead of deleting them", async () => {
    const db = createMockDb();

    // The documented artifact invocation supplies D-2 summaries only. Passing
    // an empty breakdown list would make the writer delete every stored
    // occupation and size row, so a summaries-only refresh must send undefined.
    const result = await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      d2ReportSummaries: [],
    });

    expect(result.directBreakdownsWritten).toBe(0);
    const deletedBreakdowns = db.client.query.mock.calls.some((call) =>
      String(call[0]).includes("DELETE FROM public.il_candidate_finance_direct_breakdowns")
    );
    expect(deletedBreakdowns).toBe(false);
  });

  it("still replaces breakdowns when an itemized source is present but empty", async () => {
    const db = createMockDb();

    // Receipts were loaded and this committee genuinely had none: that is a
    // real zero, so the stale rows must go.
    await syncIllinoisCandidateFinance({
      db,
      ...baseInput(),
      directContributionRecords: [],
      d2ReportSummaries: [],
    });

    const deletedBreakdowns = db.client.query.mock.calls.some((call) =>
      String(call[0]).includes("DELETE FROM public.il_candidate_finance_direct_breakdowns")
    );
    expect(deletedBreakdowns).toBe(true);
  });
});


// These mocks exercise the real transactional writer without opening a database.
function quarterlyDb(previous: { source_reports: unknown }[] = []) {
  const txQuery = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
    if (sql.includes("SELECT groups.source_reports")) return { rows: previous, rowCount: previous.length };
    if (sql.includes("INSERT INTO public.il_candidate_finance_links")) return { rows: [{ id: LINK_ID }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const client = { query: txQuery, release: vi.fn() };
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn(async () => client), client };
}

function quarterlyOutsideProof(overrides = {}) {
  return {
    committeeId: "615", filedDocId: "1023410", periodStart: "2026-07-01", periodEnd: "2026-09-30",
    receivedAt: "2026-10-07 15:46:19.163000000", fingerprint: "a".repeat(64), ...overrides,
  };
}

function quarterlyInput() {
  return { ...baseInput(), candidateName: "Darren Bailey", electionYear: 2026,
    committeeKey: "SBE:34092", committeeName: "Bailey for Illinois", sbeCommitteeId: "34092",
    verifiedQuarterly: true, now: new Date("2026-10-11T12:00:00Z") };
}

function quarterlyExpense(overrides: Partial<IllinoisSbeExpenditureRecord> = {}) {
  // Source-proven positive: 615/current Quarterly 1023410, separately allocated $66.50.
  return expenditure({ committeeId: "615", sourceDocumentId: "1023410", documentName: "Quarterly",
    reportingPeriodStart: "7/1/2026", reportingPeriodEnd: "9/30/2026", reportReceivedDate: "10/7/2026",
    candidateName: "Bailey for Illinois", officeDistrict: "Illinois Governor", expendedDate: "9/9/2026",
    expendingCommitteeName: "Kane County Republican Central Cmte", amount: 66.50, ...overrides });
}

function quarterlyD2() {
  return { reportId: "1023500", committeeId: "34092", periodStart: "2026-07-01", periodEnd: "2026-09-30",
    filedAt: "2026-10-07T12:00:00Z", totalReceipts: 5000, totalDisbursements: 2000, cashOnHand: 3000,
    debtsOwed: 0, sourceUrl: SOURCE_URL };
}

function quarterlyPac() {
  return { committeeId: "1028", committeeName: "Community BANCPAC", committeeType: "Political Action" as const,
    totalAmount: 1000, contributionCount: 1, sourceUrl: SOURCE_URL };
}

function outsideMutations(db: ReturnType<typeof quarterlyDb>) {
  return db.client.query.mock.calls.filter(([sql]) =>
    /(?:INSERT INTO|DELETE FROM) public\.il_candidate_finance_outside_|UPDATE public\.il_candidate_finance_summaries SET outside_/.test(sql));
}

function summaryParams(db: ReturnType<typeof quarterlyDb>) {
  return db.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_summaries"))?.[1];
}

describe("verified Quarterly sync source boundaries", () => {
  it("persists exact SBE spender identity and per-group report provenance through the actual writer", async () => {
    const db = quarterlyDb();
    const proof = quarterlyOutsideProof();
    const other = quarterlyOutsideProof({ committeeId: "777", filedDocId: "1023411", fingerprint: "b".repeat(64) });
    const result = await syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(),
      outsideExpenditureRecords: [quarterlyExpense(), quarterlyExpense({ committeeId: "777", sourceDocumentId: "1023411" })],
      outsideReportEvidence: [proof, other], d2ReportSummaries: [quarterlyD2()], pacDonors: [quarterlyPac()] });
    expect(result).toMatchObject({ outsideGroupsWritten: 2, outsidePreserved: false,
      outsideSupportTotal: 133, outsideOpposeTotal: 0, pacDonorsWritten: 1, totalReceipts: 5000,
      directContributionTotal: null });
    const groups = db.client.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_outside_groups"));
    expect(groups.map(([, params]) => params?.[2]).sort()).toEqual(["SBE:615", "SBE:777"]);
    for (const [, params] of groups) {
      expect(JSON.parse(String(params?.[8]))).toEqual([params?.[2] === "SBE:615" ? proof : other]);
    }
    const previousIndex = db.client.query.mock.calls.findIndex(([sql]) => sql.includes("SELECT groups.source_reports"));
    const firstMutation = db.client.query.mock.calls.findIndex(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_outside_groups"));
    expect(previousIndex).toBeGreaterThan(0);
    expect(previousIndex).toBeLessThan(firstMutation);
    expect(summaryParams(db)?.slice(2, 9)).toEqual([5000, null, 2000, 3000, 0, 133, 0]);
    expect(db.client.query.mock.calls.filter(([sql]) => sql.includes("UPDATE public.il_candidate_finance_summaries SET outside_")).length).toBe(1);
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["legacy groups without provenance", null],
    ["a previously accepted report absent from the new source", [quarterlyOutsideProof({ committeeId: "888", filedDocId: "1023000" })]],
    ["changed transactions under the same report ID", [quarterlyOutsideProof({ fingerprint: "c".repeat(64) })]],
  ])("preserves %s while allowing independent Raised and PAC writes", async (_label, source_reports) => {
    const db = quarterlyDb([{ source_reports }]);
    const result = await syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(),
      outsideExpenditureRecords: [quarterlyExpense()], outsideReportEvidence: [quarterlyOutsideProof()],
      d2ReportSummaries: [quarterlyD2()], pacDonors: [quarterlyPac()] });
    expect(result).toMatchObject({ outsidePreserved: true, outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0,
      outsideSupportTotal: null, outsideOpposeTotal: null, totalReceipts: 5000, pacDonorsWritten: 1 });
    expect(outsideMutations(db)).toEqual([]);
    expect(summaryParams(db)?.slice(2, 9)).toEqual([5000, null, 2000, 3000, 0, null, null]);
    expect(summaryParams(db)?.[11]).toBe(true);
    expect(db.client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_pac_donors"))).toBe(true);
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("accepts a source-proven archived document replacement rather than adding its old amount", async () => {
    const old = quarterlyOutsideProof({ filedDocId: "1023000", fingerprint: "c".repeat(64) });
    const db = quarterlyDb([{ source_reports: [old] }]);
    const current = quarterlyOutsideProof({ supersededDocumentIds: ["1023000"] });
    const result = await syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(),
      outsideExpenditureRecords: [quarterlyExpense()], outsideReportEvidence: [current] });
    expect(result).toMatchObject({ outsidePreserved: false, outsideGroupsWritten: 1, outsideSupportTotal: 66.5,
      totalReceipts: null, directContributionTotal: null });
    const group = db.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_outside_groups"));
    expect(group?.[1]?.[5]).toBe(66.5);
    expect(JSON.parse(String(group?.[1]?.[8]))).toEqual([current]);
  });

  it("keeps unverified modern CSV receipts and expenditures out of Raised and replacement deletes", async () => {
    const db = quarterlyDb();
    const result = await syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(), verifiedQuarterly: false,
      directContributionRecords: [contribution({ committeeId: "34092", documentName: "Quarterly", amount: 9000, receivedDate: "9/9/2026" })],
      outsideExpenditureRecords: [quarterlyExpense({ sourceDocumentId: undefined })] });
    expect(result).toMatchObject({ totalReceipts: null, directContributionTotal: null, directBreakdownsWritten: 0,
      includedContributionRowCount: 0, outsideGroupsWritten: 0, outsideExpenditureDataAvailable: false,
      outsideSupportTotal: null, outsideOpposeTotal: null });
    expect(summaryParams(db)?.slice(2, 9)).toEqual([null, null, null, null, null, null, null]);
    expect(summaryParams(db)?.[11]).toBe(false);
    expect(outsideMutations(db)).toEqual([]);
    expect(db.client.query.mock.calls.some(([sql]) => sql.includes("DELETE FROM public.il_candidate_finance_direct_breakdowns"))).toBe(false);
  });

  it("uses exact receiving IDs for verified cash despite a changed committee label and excludes another recipient", async () => {
    const db = quarterlyDb();
    const result = await syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(),
      committeeName: "Stored old committee alias", d2ReportSummaries: [quarterlyD2()],
      directContributionRecords: [
        contribution({ committeeId: "34092", documentName: "Quarterly", recipientCommitteeName: "Bailey for Illinois", amount: 250, receivedDate: "9/9/2026" }),
        contribution({ committeeId: "999", documentName: "Quarterly", recipientCommitteeName: "Stored old committee alias", amount: 9000, receivedDate: "9/9/2026" }),
      ] });
    expect(result).toMatchObject({ totalReceipts: 5000, directContributionTotal: null,
      includedContributionRowCount: 1, directBreakdownsWritten: 2, outsideSupportTotal: null });
    const rows = db.client.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_direct_breakdowns"));
    expect(rows.map(([, params]) => params?.[4])).toEqual([250, 250]);
    expect(outsideMutations(db)).toEqual([]);
  });

  it("updates independent D2 totals while unknown cash, PAC and outside components remain untouched", async () => {
    const db = quarterlyDb();
    const result = await syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(), d2ReportSummaries: [quarterlyD2()] });
    expect(result).toMatchObject({ totalReceipts: 5000, directContributionTotal: null, pacDonorsWritten: 0,
      directBreakdownsWritten: 0, outsideGroupsWritten: 0, outsideExpenditureDataAvailable: false,
      outsideSupportTotal: null, outsideOpposeTotal: null });
    expect(summaryParams(db)?.slice(2, 9)).toEqual([5000, null, 2000, 3000, 0, null, null]);
    expect(summaryParams(db)?.[11]).toBe(true);
    expect(outsideMutations(db)).toEqual([]);
    expect(db.client.query.mock.calls.some(([sql]) => /(?:INSERT INTO|DELETE FROM) public\.il_candidate_finance_(?:direct_breakdowns|pac_donors)/.test(sql))).toBe(false);
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("does not infer a verified zero from an empty outside array", async () => {
    const db = quarterlyDb();
    await expect(syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(),
      outsideExpenditureRecords: [], outsideReportEvidence: [quarterlyOutsideProof()] }))
      .rejects.toThrow("empty IE snapshot requires independent current empty proof");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("rejects positive rows whose document ID cannot attach the supplied current proof", async () => {
    const db = quarterlyDb();
    await expect(syncIllinoisCandidateFinance({ db: db as never, ...quarterlyInput(),
      outsideExpenditureRecords: [quarterlyExpense({ sourceDocumentId: "1023999" })],
      outsideReportEvidence: [quarterlyOutsideProof()] })).rejects.toThrow("matching current report evidence");
    expect(db.connect).not.toHaveBeenCalled();
  });
});
