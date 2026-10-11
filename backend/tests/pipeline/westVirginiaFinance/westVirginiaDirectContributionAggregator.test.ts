import { describe, expect, it } from "vitest";

import type { WestVirginiaCommitteeRow, WestVirginiaTransactionRow } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";
import type {
  WestVirginiaContributionCsvRow,
  WestVirginiaExpenditureCsvRow,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsCsv.js";
import {
  aggregateWestVirginiaDirectFinance,
  normalizeWestVirginiaOccupationLabel,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaDirectContributionAggregator.js";

const ENTITY = "1010003610";
const WINDOW = { windowStart: "2025-07-01", windowEnd: "2026-12-31" };

function con(overrides: Partial<WestVirginiaContributionCsvRow>): WestVirginiaContributionCsvRow {
  return {
    line: 2,
    registrantId: ENTITY,
    committeeName: "Committee to Elect Dean Jeffries",
    candidateName: "Warren Dean Jeffries",
    transactionType: "Contributions",
    transactionCategory: "Monetary",
    transactionDate: "2026-03-01",
    amountCents: 50_000,
    contributorType: "Individual",
    contributorName: "Jane Doe",
    employerName: null,
    filedDate: "2026-04-07",
    recovered: false,
    ...overrides,
  };
}

function exp(overrides: Partial<WestVirginiaExpenditureCsvRow>): WestVirginiaExpenditureCsvRow {
  return {
    line: 2,
    registrantId: ENTITY,
    committeeName: "Committee to Elect Dean Jeffries",
    candidateName: "Warren Dean Jeffries",
    transactionType: "Expenditures",
    expenditureType: "Monetary",
    expenditurePurpose: "Advertising",
    transactionDate: "2026-03-05",
    amountCents: 12_000,
    recipientType: "Business or Organization",
    recipientName: "Acme Print",
    filedDate: "2026-04-07",
    recovered: false,
    ...overrides,
  };
}

function api(overrides: Partial<WestVirginiaTransactionRow>): WestVirginiaTransactionRow {
  return {
    transactionID: 1,
    entityID: ENTITY,
    orgID: 3610,
    committeeName: "Committee to Elect Dean Jeffries",
    candidateName: "Jeffries, Warren Dean",
    transactionAmount: 500,
    transactionDate: "2026-03-01T00:00:00",
    filedDate: "2026-04-07T00:00:00",
    entityTypeDesc: "Individual",
    transactionCategoryDesc: "Monetary",
    transactionTypeDesc: "Contributions",
    transactionPurpose: null,
    contributorPayeeName: "Doe Jane",
    employerName: "Charleston General Hospital",
    employerOccupation: "Healthcare/Medical",
    transactionTotalYTD: null,
    amendedFlag: false,
    reportVersionID: "1",
    reportFileName: null,
    s3ReportFilePath: null,
    stanceDescription: null,
    candidateNameAssocation: null,
    ballotMeasureDescription: null,
    orgType: "State Candidate",
    ...overrides,
  };
}

function committee(overrides: Partial<WestVirginiaCommitteeRow> = {}): WestVirginiaCommitteeRow {
  return {
    orgID: 1446, entityId: "1020001446", orgName: "UMWA PAC", candidateName: null,
    orgType: "State Political Action Committee", orgTypeCode: "102", orgSubType: "Regular PAC",
    office: null, district: null, party: null, election: "2018 General Election",
    registrationYear: "2018", orgStatus: "Terminated", ...overrides,
  };
}

function aggregateDonors(rows: WestVirginiaContributionCsvRow[], registry?: WestVirginiaCommitteeRow[]) {
  return aggregateWestVirginiaDirectFinance({ entityId: ENTITY, window: WINDOW,
    contributionRows: rows, expenditureRows: [], apiRows: [], committeeRegistryRows: registry });
}

describe("aggregateWestVirginiaDirectFinance", () => {
  it("applies the pinned money model with Returns subtracted and self money excluded", () => {
    const result = aggregateWestVirginiaDirectFinance({
      entityId: ENTITY,
      window: WINDOW,
      contributionRows: [
        con({}), // $500 individual
        con({ line: 3, contributorType: "Political Action Committee", contributorName: "WV Realtors PAC", amountCents: 100_000 }),
        con({ line: 4, transactionCategory: "In-Kind", amountCents: 2_500, contributorName: "Sam Smith" }),
        con({ line: 5, contributorType: "Self", amountCents: 300_000 }),
        con({ line: 6, transactionCategory: "Other Income", contributorType: "Business or Organization", amountCents: 19 }),
        con({ line: 7, transactionCategory: "Receipt of Transfer of Excess Funds", contributorType: "Candidate", amountCents: 40_000 }),
        con({ line: 8, transactionCategory: "Return", amountCents: 5_000, contributorName: "Jane Doe" }),
        // Outside the window and another committee: ignored entirely.
        con({ line: 9, transactionDate: "2025-06-30", amountCents: 999_999 }),
        con({ line: 10, registrantId: "1010009999", amountCents: 999_999 }),
      ],
      expenditureRows: [
        exp({}), // $120
        exp({ line: 3, expenditureType: "Disbursement of Excess Funds", amountCents: 1_000 }),
        exp({ line: 4, expenditureType: "Return", amountCents: 700 }),
        exp({ line: 5, transactionDate: "2027-01-05", amountCents: 999_999 }),
      ],
      apiRows: [],
    });
    // 500 + 1000 + 25 + 3000 + 0.19 + 400 - 50
    expect(result.totalReceiptsCents).toBe(50_000 + 100_000 + 2_500 + 300_000 + 19 + 40_000 - 5_000);
    // donors only: 500 + 1000 + 25 - 50
    expect(result.directContributionCents).toBe(50_000 + 100_000 + 2_500 - 5_000);
    expect(result.returnedContributionCents).toBe(5_000);
    expect(result.selfFundingCents).toBe(300_000);
    expect(result.otherIncomeCents).toBe(19);
    expect(result.transferInCents).toBe(40_000);
    expect(result.totalDisbursementsCents).toBe(12_000 + 1_000 - 700);
    expect(result.returnedExpenditureCents).toBe(700);
    expect(result.contributionRowCount).toBe(7);
    expect(result.expenditureRowCount).toBe(3);
    expect(result.unrecognizedContributionCategories).toEqual([]);
    expect(result.unrecognizedContributorTypes).toEqual([]);
    expect(result.unrecognizedExpenditureTypes).toEqual([]);
    // Buckets: positive Monetary individual rows only (the $500 gift).
    expect(result.breakdowns.filter((breakdown) => breakdown.categoryType === "contribution_size")).toEqual([
      { categoryType: "contribution_size", categoryName: "$500-$999", amount: 500, contributorCount: 1 },
    ]);
  });

  it("surfaces vocabulary outside the pinned sets instead of guessing", () => {
    const result = aggregateWestVirginiaDirectFinance({
      entityId: ENTITY,
      window: WINDOW,
      contributionRows: [
        con({ transactionCategory: "Loan" }),
        con({ line: 3, contributorType: "Union" }),
        con({ line: 4, transactionCategory: "Return", contributorType: "Bank" }),
      ],
      expenditureRows: [exp({ expenditureType: "Refund" })],
      apiRows: [],
    });
    expect(result.unrecognizedContributionCategories).toEqual(["Loan"]);
    expect(result.unrecognizedContributorTypes).toEqual(["Bank", "Union"]);
    expect(result.unrecognizedExpenditureTypes).toEqual(["Refund"]);
    expect(result.totalReceiptsCents).toBe(0);
    expect(result.totalDisbursementsCents).toBe(0);
  });

  it("publishes occupation labels verbatim from individual donation API rows, excluding blank and Unknown", () => {
    const result = aggregateWestVirginiaDirectFinance({
      entityId: ENTITY,
      window: WINDOW,
      contributionRows: [],
      expenditureRows: [],
      apiRows: [
        api({ transactionID: 1, employerOccupation: "Attorney/Legal", transactionAmount: 1000, contributorPayeeName: "Roe Rick" }),
        api({ transactionID: 2, employerOccupation: "  Attorney/Legal ", transactionAmount: 250, contributorPayeeName: "Roe Rick" }),
        api({ transactionID: 3, employerOccupation: "Unknown", transactionAmount: 5000 }),
        api({ transactionID: 4, employerOccupation: null, transactionAmount: 5000 }),
        api({ transactionID: 5, employerOccupation: "Retired", transactionCategoryDesc: "In-Kind", transactionAmount: 40 }),
        // Not donations / not individuals / other committee / out of window.
        api({ transactionID: 6, employerOccupation: "Retired", transactionCategoryDesc: "Loans", transactionTypeDesc: "Loans" }),
        api({ transactionID: 7, employerOccupation: "Retired", entityTypeDesc: "Business or Organization" }),
        api({ transactionID: 8, employerOccupation: "Retired", entityID: "1010009999" }),
        api({ transactionID: 9, employerOccupation: "Retired", transactionDate: "2025-06-30T00:00:00" }),
      ],
    });
    expect(result.apiDonationRowCount).toBe(5);
    expect(result.breakdowns.filter((breakdown) => breakdown.categoryType === "occupation")).toEqual([
      { categoryType: "occupation", categoryName: "Attorney/Legal", amount: 1250, contributorCount: 1 },
      { categoryType: "occupation", categoryName: "Retired", amount: 40, contributorCount: 1 },
    ]);
    expect(normalizeWestVirginiaOccupationLabel("unknown")).toBeNull();
    expect(normalizeWestVirginiaOccupationLabel("Business  Owner")).toBe("Business Owner");
  });

  it("derives industry from the employer only for statements filed before 2027 (§3-8-6a)", () => {
    const preRedaction = aggregateWestVirginiaDirectFinance({
      entityId: ENTITY,
      window: WINDOW,
      contributionRows: [
        con({ employerName: "Charleston General Hospital", filedDate: "2026-12-31" }),
        // Recovered rows carry an unreliable employer column.
        con({ line: 3, employerName: "Charleston General Hospital", recovered: true, contributorName: "Rec Overed" }),
        // Non-individual donors never feed the employer path.
        con({ line: 4, employerName: "Charleston General Hospital", contributorType: "Business or Organization" }),
      ],
      expenditureRows: [],
      apiRows: [],
    });
    expect(preRedaction.employerRedactedRowCount).toBe(0);
    expect(preRedaction.breakdowns.filter((breakdown) => breakdown.categoryType === "industry")).toEqual([
      { categoryType: "industry", categoryName: "healthcare", amount: 500, contributorCount: 1 },
    ]);

    // Same rows filed on/after 2027-01-01: zero employer-derived output even
    // though the state still exported the column.
    const redacted = aggregateWestVirginiaDirectFinance({
      entityId: ENTITY,
      window: WINDOW,
      contributionRows: [
        con({ employerName: "Charleston General Hospital", filedDate: "2027-01-01" }),
        con({ line: 3, employerName: "Mountain State Bank", filedDate: "2027-04-07", contributorName: "Bob Banks" }),
      ],
      expenditureRows: [],
      apiRows: [],
    });
    expect(redacted.employerRedactedRowCount).toBe(2);
    expect(redacted.breakdowns.filter((breakdown) => breakdown.categoryType === "industry")).toEqual([]);
    // Totals and buckets are unaffected by the redaction.
    expect(redacted.directContributionCents).toBe(100_000);
    expect(redacted.breakdowns.filter((breakdown) => breakdown.categoryType === "contribution_size")).toHaveLength(1);
  });
});

describe("West Virginia typed committee donors", () => {
  it("preserves PAC replacements when the registry is unavailable and makes valid empty registries authoritative", () => {
    const rows = [con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC" })];
    expect(aggregateDonors(rows)).not.toHaveProperty("pacDonors");
    expect(aggregateDonors(rows, []).pacDonors).toEqual([]);
    expect(aggregateDonors([], [committee()]).pacDonors).toEqual([]);
  });

  it("nets Monetary/In-Kind and positive Returns, counting every separate equal gift", () => {
    const pac = { contributorType: "Political Action Committee", contributorName: "  umwa   pac " };
    const result = aggregateDonors([
      con({ ...pac }), con({ ...pac, line: 3 }), // Equal receipts have no shared stable row ID.
      con({ ...pac, transactionCategory: "In-Kind", amountCents: 2500 }),
      con({ ...pac, transactionCategory: "Return", amountCents: 5000 }),
    ], [committee()]);
    expect(result.pacDonors).toEqual([{ committeeId: "1020001446", committeeName: "UMWA PAC", committeeType: "102",
      totalAmount: 975, contributionCount: 3, sourceUrl: "https://cfrs.wvsos.gov/" }]);
    expect(result.directContributionCents).toBe(97500);
  });

  it("retains typed party/caucus identities without restricting registration year or status", () => {
    const result = aggregateDonors([
      con({ contributorType: "Political Party Committee / Caucus Campaign Committee", contributorName: "West Virginia Republican Labor Caucus", amountCents: 100000 }),
      con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC", amountCents: 25000 }),
    ], [committee(), committee({ entityId: "1030002641", orgID: 2641, orgName: "West Virginia Republican Labor Caucus", orgTypeCode: "103", orgType: "State Political Party Committee", orgSubType: "Caucus Committee" })]);
    expect(result.pacDonors).toMatchObject([
      { committeeId: "1030002641", committeeType: "103", totalAmount: 1000, contributionCount: 1 },
      { committeeId: "1020001446", committeeType: "102", totalAmount: 250, contributionCount: 1 },
    ]);
  });

  it("counts repeated registry rows for one legal identity as one donor without deduplicating gifts", () => {
    const gift = con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC" });
    const result = aggregateDonors([gift, con({ ...gift, line: 3 })], [
      committee(), committee(),
      committee({ orgName: "  umwa   pac ", orgStatus: "Active", election: "2026 General Election", registrationYear: "2026" }),
    ]);
    expect(result.pacDonors).toEqual([{
      committeeId: "1020001446", committeeName: "UMWA PAC", committeeType: "102",
      totalAmount: 1000, contributionCount: 2, sourceUrl: "https://cfrs.wvsos.gov/",
    }]);
    expect(result.directContributionCents).toBe(100000);
  });

  it.each([
    ["entity ID", { entityId: "1020009999" }],
    ["committee class", { orgTypeCode: "104", orgType: "Independent Expenditure Committee" }],
    ["organization ID", { orgID: 9999 }],
  ] as const)("retains ambiguity when repeated names differ in %s", (_field, identity) => {
    const gift = con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC" });
    const result = aggregateDonors([gift], [committee(), committee(), committee(identity)]);
    expect(result.pacDonors).toEqual([]);
    expect(result.directContributionCents).toBe(50000);
  });

  it("checks all registry types for ambiguity before the legal-type allowlist", () => {
    const rows = [con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC" })];
    expect(aggregateDonors(rows, [committee(), committee({ entityId: "1040003984", orgTypeCode: "104", orgStatus: "Active", orgType: "Independent Expenditure Committee" })]).pacDonors).toEqual([]);
    expect(aggregateDonors(rows, [committee(), committee({ entityId: "1020009999" })]).pacDonors).toEqual([]);
  });

  it("omits unmatched, wrong-class, generic, individual, self and candidate donors without name inference", () => {
    const rows = [
      con({ contributorType: "Political Action Committee", contributorName: "Unknown PAC" }),
      con({ contributorType: "Political Party Committee / Caucus Campaign Committee", contributorName: "UMWA PAC" }),
      ...["Business or Organization", "Individual", "Self", "Candidate"].map((contributorType) => con({ contributorType, contributorName: "UMWA PAC" })),
    ];
    expect(aggregateDonors(rows, [committee()]).pacDonors).toEqual([]);
    expect(aggregateDonors([con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC" })], [committee({ orgTypeCode: "101" })]).pacDonors).toEqual([]);
  });

  it("excludes loans, other income, transfers, other recipients and dates outside the cycle", () => {
    const pac = { contributorType: "Political Action Committee", contributorName: "UMWA PAC" };
    const rows = [
      ...["Loans", "Other Income", "Receipt of Transfer of Excess Funds"].map((transactionCategory) => con({ ...pac, transactionCategory })),
      con({ ...pac, registrantId: "1010009999" }), con({ ...pac, transactionDate: "2025-06-30" }),
      con({ ...pac, transactionDate: "2027-01-01" }),
    ];
    expect(aggregateDonors(rows, [committee()]).pacDonors).toEqual([]);
  });

  it("omits net-zero donors and zero gifts", () => {
    const pac = { contributorType: "Political Action Committee", contributorName: "UMWA PAC" };
    expect(aggregateDonors([con(pac), con({ ...pac, transactionCategory: "Return" }), con({ ...pac, amountCents: 0 })], [committee()]).pacDonors).toEqual([]);
  });

  it("rejects a net-negative donor even when unrelated gifts keep the overall raised total positive", () => {
    const pac = { contributorType: "Political Action Committee", contributorName: "UMWA PAC" };
    expect(() => aggregateDonors([con(pac), con({ ...pac, transactionCategory: "Return", amountCents: 60000 }), con({ amountCents: 100000 })], [committee()])).toThrow("Negative West Virginia committee donor total");
  });

  it.each([-1, 0, 1.5])("rejects invalid positive-Return cents %s", (amountCents) => {
    expect(() => aggregateDonors([con({ contributorType: "Political Action Committee", contributorName: "UMWA PAC", transactionCategory: "Return", amountCents })], [committee()])).toThrow("Invalid West Virginia committee donor amount");
  });

  it("matches formatting only, with no aliases or fuzzy organization matching", () => {
    const row = con({ contributorType: "Political Action Committee", contributorName: "U.M.W.A. PAC" });
    expect(aggregateDonors([row], [committee()]).pacDonors?.[0]?.committeeId).toBe("1020001446");
    expect(aggregateDonors([con({ ...row, contributorName: "United Mine Workers PAC" })], [committee()]).pacDonors).toEqual([]);
  });
});
