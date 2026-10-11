import { describe, expect, it } from "vitest";
import {
  aggregateWestVirginiaElectronicOutsideSpending,
  WEST_VIRGINIA_ELECTRONIC_IE_COVERAGE_NOTE,
  type WestVirginiaElectronicOutsideSpendingInput,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaElectronicOutsideSpendingAggregator.js";
import type { WestVirginiaCommitteeRow, WestVirginiaCurrentFilingRow, WestVirginiaTransactionRow } from
  "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";

const TARGET: WestVirginiaCommitteeRow = {
  orgID: 3582, entityId: "1010003582", orgName: "Committee to Elect Vernon Criss",
  candidateName: "Criss, Vernon", orgType: "State Candidate", orgTypeCode: "101", orgSubType: "Candidate",
  office: "House of Delegates", district: "12", party: "Republican", election: "2026 Election",
  registrationYear: "2025", orgStatus: "Active",
};
const SPENDER: WestVirginiaCommitteeRow = {
  orgID: 2875, entityId: "1040002875", orgName: "West Virginia Strong,  Inc.", candidateName: null,
  orgType: "Independent Expenditure Committee", orgTypeCode: "104", orgSubType: "Organization",
  office: null, district: null, party: null, election: "2018 Election", registrationYear: "2022", orgStatus: "Active",
};
// Sanitized live current Q1 row: the API says amendedFlag=false although the
// current report is amended v2 and its PDF strikes out a deleted $3,000 row.
const IE: WestVirginiaTransactionRow = {
  transactionID: 562631, entityID: SPENDER.entityId, orgID: SPENDER.orgID, committeeName: SPENDER.orgName,
  candidateName: null, transactionAmount: 897.1, transactionDate: "2026-02-06T00:00:00",
  filedDate: "2026-04-29T00:00:00", entityTypeDesc: "Business or Organization",
  transactionCategoryDesc: "Monetary", transactionTypeDesc: "Independent Expenditures", transactionPurpose: "Direct Mail",
  contributorPayeeName: "Dunbar Printing", employerName: null, employerOccupation: null, transactionTotalYTD: "10192.6200",
  amendedFlag: false, reportVersionID: "2", reportFileName: "2026 1st Quarter Report",
  s3ReportFilePath: "prd/Reports/2875/9357de47-f931-4240-a6aa-6d15a4cac5c1.pdf",
  stanceDescription: "Support", candidateNameAssocation: "Criss, Vernon", ballotMeasureDescription: null,
  orgType: "Independent Expenditure Committee", electionYear: 2026,
};
const FILING: WestVirginiaCurrentFilingRow = {
  orgID: 2875, reportID: 32245, reportVersionID: 2, registrantID: SPENDER.entityId, committeeName: SPENDER.orgName!,
  reportFileName: "2026 1st Quarter Report", reportFormType: "Campaign Financial Statement",
  startDate: "2026-01-01T00:00:00", endDate: "2026-03-31T00:00:00", dueDate: "2026-04-07T00:00:00",
  filedDate: "2026-04-29T00:00:00", reportStatus: "Amended", documentBarCode: "F5BA3496AFAF45AE",
};
function input(overrides: Partial<WestVirginiaElectronicOutsideSpendingInput> = {}): WestVirginiaElectronicOutsideSpendingInput {
  return {
    candidateName: "Vernon Criss", entityId: TARGET.entityId, electionYear: 2026,
    officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "Delegate District 12 (2024); West Virginia",
    window: { windowStart: "2025-07-01", windowEnd: "2026-12-31" }, registryRows: [TARGET, SPENDER],
    transactionRows: [IE], currentFilingsByOrg: new Map([[2875, [FILING]]]), ...overrides,
  };
}
function resultForRow(overrides: Partial<WestVirginiaTransactionRow>) {
  return aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [{ ...IE, ...overrides }] }));
}
function expectUnknown(result: ReturnType<typeof aggregateWestVirginiaElectronicOutsideSpending>, diagnostic: RegExp) {
  expect(result.summary).toBeUndefined();
  expect(result.provenance).toEqual([]);
  expect(result.diagnostics.join(" ")).toMatch(diagnostic);
}

describe("WV positive-only electronic regular-report IE", () => {
  it("accepts verified Criss $897.10 in current amended v2 without trusting amendedFlag", () => {
    const result = aggregateWestVirginiaElectronicOutsideSpending(input());
    expect(result.summary).toMatchObject({ supportTotal: 897.1, opposeTotal: 0, groups: [{
      committeeId: SPENDER.entityId, committeeName: "West Virginia Strong, Inc.", supportOppose: "support", amount: 897.1,
    }] });
    expect(result.includedRowCount).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.provenance).toEqual([expect.objectContaining({ transactionID: 562631, spenderEntityId: SPENDER.entityId,
      orgID: 2875, reportID: 32245, reportVersionID: 2, reportFileName: FILING.reportFileName, filedDate: "2026-04-29",
      transactionDate: "2026-02-06", amount: 897.1, supportOppose: "support", targetEntityId: TARGET.entityId,
      documentBarCode: "F5BA3496AFAF45AE" })]);
    expect(WEST_VIRGINIA_ELECTRONIC_IE_COVERAGE_NOTE).toMatch(/Scanned paper.*separate rapid IE.*excluded/);
  });

  it("excludes a superseded original $3,000 row rather than adding deleted PDF text", () => {
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [
      { ...IE, transactionID: 562630, reportVersionID: "1", filedDate: "2026-04-09T00:00:00",
        transactionDate: "2026-02-02T00:00:00", transactionAmount: 3000, contributorPayeeName: "Barnes Agency" }, IE,
    ] }));
    expect(result.summary?.supportTotal).toBe(897.1);
    expect(result.excludedRowCount).toBe(1);
  });

  it("excludes ignored query-mode ordinary rows before validating their outside evidence", () => {
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [
      { ...IE, transactionID: -1, transactionTypeDesc: "Contributions", electionYear: null, transactionDate: "bad",
        transactionAmount: Number.NaN, stanceDescription: null, candidateNameAssocation: null },
      { ...IE, transactionTypeDesc: "Expenditures", electionYear: null }, IE,
    ] }));
    expect(result.summary?.supportTotal).toBe(897.1);
    expect(result.excludedRowCount).toBe(2);
  });

  it("deduplicates identical rows across query modes while keeping two actual equal-valued transactions", () => {
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [IE, { ...IE }, { ...IE, transactionID: 562632 }] }));
    expect(result.summary?.supportTotal).toBe(1794.2);
    expect(result.includedRowCount).toBe(2);
    expect(result.excludedRowCount).toBe(1);
  });

  it.each([
    { transactionAmount: 900 }, { stanceDescription: "Oppose" }, { contributorPayeeName: "Other Vendor" },
    { candidateNameAssocation: "Keys, Cara" }, { electionYear: 2024 },
  ])("refuses conflicting current transaction IDs, including another beneficiary", (overrides) => {
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [IE, { ...IE, ...overrides }] })), /conflicting_ie_transaction_id/);
  });

  it("sums support and oppose independently without cutting groups or provenance", () => {
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [IE,
      { ...IE, transactionID: 562632, stanceDescription: "Oppose", transactionAmount: 125.25 }] }));
    expect(result.summary).toMatchObject({ supportTotal: 897.1, opposeTotal: 125.25 });
    expect(result.summary?.groups).toHaveLength(2);
    expect(result.provenance).toHaveLength(2);
  });

  it("uses target election year rather than transaction date or old spender election label", () => {
    const priorDate = { ...IE, transactionDate: "2025-12-31T00:00:00", reportFileName: "2025 4th Quarter Report" };
    const filing = { ...FILING, reportFileName: priorDate.reportFileName, startDate: "2025-10-01", endDate: "2025-12-31" };
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [priorDate],
      currentFilingsByOrg: new Map([[2875, [filing]]]) }));
    expect(result.summary?.supportTotal).toBe(897.1);
    expectUnknown(resultForRow({ electionYear: null }), /target_election_year/);
    expectUnknown(resultForRow({ electionYear: undefined }), /target_election_year/);
  });

  it("excludes other election years and dates outside the existing candidacy window", () => {
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [
      { ...IE, transactionID: 1, electionYear: 2024 }, { ...IE, transactionID: 2, transactionDate: "2025-06-30" }, IE,
    ] }));
    expect(result.summary?.supportTotal).toBe(897.1);
    expect(result.excludedRowCount).toBe(2);
  });

  it("filters older active candidate registries before exact source target identity", () => {
    const old = { ...TARGET, orgID: 2997, entityId: "1010002997", election: "2024 Election" };
    expect(aggregateWestVirginiaElectronicOutsideSpending(input({ registryRows: [old, TARGET, SPENDER] })).summary?.supportTotal).toBe(897.1);
  });

  it.each([
    { orgID: 9999, entityId: "1010009999" },
    { orgID: 9999, entityId: "1010009999", office: "State Senator", district: "1" },
    { office: "Undeclared" },
  ])("refuses ambiguous year-specific identities or undeclared target office", (changes) => {
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ registryRows: [TARGET, { ...TARGET, ...changes }, SPENDER] })), /target_/);
  });

  it("does not attribute Robert Fluharty paper/source evidence to Shawn Fluharty", () => {
    const shawn = { ...TARGET, orgID: 3860, entityId: "1010003860", candidateName: "Fluharty, Shawn Lucas",
      office: "State Senator", district: "1" };
    const result = aggregateWestVirginiaElectronicOutsideSpending(input({ candidateName: "Shawn Lucas Fluharty", entityId: shawn.entityId,
      officeScope: "state_upper", officeName: "State Senator", district: "State Senate District 1", registryRows: [shawn, SPENDER],
      transactionRows: [{ ...IE, candidateNameAssocation: "Robert Fluharty", transactionAmount: 5250 }] }));
    expectUnknown(result, /no_accepted_electronic/);
  });

  it("requires matching local office, district and receiving link", () => {
    for (const changes of [{ district: "13" }, { entityId: "1010002997" },
      { officeScope: "state_upper", officeName: "State Senator" }]) {
      expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input(changes)), /target_/);
    }
  });

  it("requires full exact source name, excluding a surname and source-side nickname", () => {
    expectUnknown(resultForRow({ candidateNameAssocation: "Criss" }), /no_accepted/);
    expectUnknown(resultForRow({ candidateNameAssocation: "Criss, Vern" }), /no_accepted/);
  });

  it("preserves when current report manifest is absent, empty or ambiguous", () => {
    for (const manifests of [new Map(), new Map([[2875, []]]),
      new Map([[2875, [FILING, { ...FILING, reportID: 32246 }]]])]) {
      expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ currentFilingsByOrg: manifests })), /manifest|current_report/);
    }
  });

  it.each([
    { reportVersionID: "3" }, { reportVersionID: null }, { filedDate: "2026-04-30" },
    { reportFileName: "Another Report" }, { transactionDate: "2026-04-01" },
    { s3ReportFilePath: "prd/Reports/9999/report.pdf" }, { s3ReportFilePath: null },
    { s3ReportFilePath: "https://signed.example/report.pdf?token=secret" },
  ])("requires current version, period, file date and valid spender report path", (changes) => {
    expectUnknown(resultForRow(changes), /report|current/);
  });

  it("excludes standalone rapid IE reports from the regular-report scope", () => {
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ currentFilingsByOrg:
      new Map([[2875, [{ ...FILING, reportFormType: "Independent Expenditure Report" }]]]) })), /no_accepted/);
  });

  it("an empty current version or all-superseded harvest never produces authoritative zero", () => {
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [] })), /zero_requires_independent/);
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ currentFilingsByOrg:
      new Map([[2875, [{ ...FILING, reportVersionID: 3 }]]]) })), /zero_requires_independent/);
  });

  it.each([
    { stanceDescription: null }, { stanceDescription: "Assist" }, { transactionCategoryDesc: "In-Kind" },
    { transactionAmount: -10 }, { transactionAmount: 0 }, { transactionAmount: 1.005 },
    { transactionDate: "2026-02-30" }, { ballotMeasureDescription: "Question One" },
  ])("returns unknown for applicable unsupported or invalid IE evidence", (changes) => {
    expectUnknown(resultForRow(changes), /ie_|candidate_and_ballot/);
  });

  it("requires the typed registry spender identity rather than a generic organization name", () => {
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ registryRows: [TARGET] })), /spender_registry/);
    expectUnknown(resultForRow({ orgType: "State Candidate" }), /spender_registry/);
    expectUnknown(resultForRow({ committeeName: "Unknown Org" }), /spender_registry/);
  });

  it("does not return partial positive money when another applicable row is unresolved", () => {
    expectUnknown(aggregateWestVirginiaElectronicOutsideSpending(input({ transactionRows: [IE,
      { ...IE, transactionID: 562632, stanceDescription: null }] })), /missing_ie_support/);
  });
});
