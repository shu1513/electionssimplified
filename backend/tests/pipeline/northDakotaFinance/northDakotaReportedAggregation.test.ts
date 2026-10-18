import { describe, expect, it } from "vitest";
import type { NorthDakotaCommitteeRow, NorthDakotaTransactionRow } from "../../../src/pipeline/northDakotaFinance/northDakotaCfrsClient.js";
import type { NorthDakotaContributionCsvRow } from "../../../src/pipeline/northDakotaFinance/northDakotaCfrsCsv.js";
import { aggregateNorthDakotaReportedCommittees, ndReceivingPersonMatches, validateNorthDakotaReportedContributions } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedAggregation.js";

const receiving: NorthDakotaCommitteeRow = {
  orgID: 50, entityId: "1010000050", orgName: "Friends of Example", candidateName: "Example, Jane Marie",
  orgType: "Candidate/Candidate Committee", orgTypeCode: "101", orgSubType: null, orgSubTypeCode: null,
  election: "2026 Election - Statewide", office: "State Senator", district: "District 1", party: null, orgStatus: "Active", registrationYear: "2026",
};
const donor: NorthDakotaCommitteeRow = { ...receiving, orgID: 70, entityId: "1020000070", orgName: "Example Association PAC", candidateName: null, orgType: "Committee/PAC", orgTypeCode: "102", office: null, district: null };
const csv: NorthDakotaContributionCsvRow = {
  line: 2, registrantId: receiving.entityId, committeeName: receiving.orgName!, candidateName: "Jane Example", transactionType: "Contributions",
  transactionCategory: "Monetary", transactionDate: "2026-09-01", amountCents: 10000, contributorType: "Committee/PAC", contributorName: donor.orgName!, employerName: null, filedDate: "2026-10-01", recovered: false,
};
const api: NorthDakotaTransactionRow = {
  transactionID: 1, entityID: receiving.entityId, orgID: receiving.orgID, committeeName: receiving.orgName, candidateName: receiving.candidateName,
  transactionAmount: 100, transactionDate: csv.transactionDate, filedDate: csv.filedDate, entityTypeDesc: csv.contributorType, transactionCategoryDesc: csv.transactionCategory,
  transactionTypeDesc: "Contributions", transactionPurpose: null, contributorPayeeName: csv.contributorName, contributorPayeeID: 999,
  employerName: null, employerOccupation: null, transactionTotalYTD: null, amendedFlag: false, reportVersionID: null, reportFileName: null,
  s3ReportFilePath: null, stanceDescription: null, candidateNameAssocation: null, electionYear: null, orgType: receiving.orgType,
};
const validate = (c: NorthDakotaContributionCsvRow[] = [csv], a: NorthDakotaTransactionRow[] = [api], r: NorthDakotaCommitteeRow[] = [receiving, donor]) => validateNorthDakotaReportedContributions({ year: 2026, csv: c, api: a, registry: r });

describe("North Dakota reported committee source controls", () => {
  it("corroborates typed literal names without joining contact IDs to registry IDs", () => {
    expect(() => validate()).not.toThrow();
    expect(() => validate([csv], [{ ...api, contributorPayeeID: receiving.orgID }])).not.toThrow();
  });
  it("accepts omitted middles and natural/surname-first display order", () => {
    expect(ndReceivingPersonMatches("Dr. Example, Jane Marie", "Jane Example")).toBe(true);
    expect(ndReceivingPersonMatches("Example, Jane M.", "Jane Marie Example")).toBe(true);
  });
  it("rejects conflicting middles, suffixes and incomplete names", () => {
    expect(ndReceivingPersonMatches("Example, Jane Marie", "Jane Anne Example")).toBe(false);
    expect(ndReceivingPersonMatches("Example Sr., Jane", "Jane Example Jr.")).toBe(false);
    expect(ndReceivingPersonMatches("Example, Jane", "Example")).toBe(false);
    expect(() => validate([{ ...csv, candidateName: "Jane Anne Example" }])).toThrow(/csv_receiving_identity/);
  });
  it.each([
    { contributorName: "Different PAC" }, { contributorType: "Party Committee" },
    { filedDate: "2026-10-02" }, { employerName: "Different employer" },
  ])("rejects named tuple changes despite unchanged money: %o", change => {
    expect(() => validate([{ ...csv, ...change }])).toThrow();
  });
  it("holds donor registry ambiguity and class disagreement", () => {
    expect(() => validate([csv], [api], [receiving, donor, { ...donor, entityId: "1020000071", orgID: 71 }])).toThrow(/registry_class/);
    expect(() => validate([csv], [api], [receiving, { ...donor, orgType: "Business or Organization" }])).toThrow(/registry_class/);
  });
  it("retains legitimate equal occurrences and rejects repeated native transaction IDs", () => {
    expect(() => validate([csv, csv], [api, { ...api, transactionID: 2 }])).not.toThrow();
    expect(() => validate([csv, csv], [api, api])).toThrow(/transaction_identity/);
    expect(() => validate([csv, csv], [api])).toThrow(/multiset/);
  });
  it("rejects wrong native receiving organization despite an equal label", () => {
    expect(() => validate([csv], [{ ...api, orgID: 99 }])).toThrow(/api_receiving_identity/);
    expect(() => validate([{ ...csv, recovered: true }])).toThrow(/csv_receiving_identity/);
  });
});

describe("North Dakota signed reported committee receipts", () => {
  const aggregate = (rows: NorthDakotaContributionCsvRow[]) => aggregateNorthDakotaReportedCommittees({ entityId: receiving.entityId, windowStart: "2025-01-01", windowEnd: "2026-12-31", rows });
  it("includes both years, signed monetary/in-kind and repeated legitimate occurrences", () => {
    const result = aggregate([csv, csv, { ...csv, transactionDate: "2025-06-01", transactionCategory: "In-Kind", amountCents: -5000 }]);
    expect(result.cents).toBe(15000); expect(result.occurrences).toBe(3); expect(result.groups[0]!.occurrences).toBe(3);
  });
  it("excludes individual/business/self/lumps/reimbursements and other receiving committees", () => {
    const rows = ["Individual", "Business or Organization", "Candidate", "Self", ""].map(contributorType => ({ ...csv, contributorType }));
    expect(aggregate([...rows, { ...csv, transactionCategory: "Reimbursement of Expenditure" }, { ...csv, registrantId: "1010000099" }]).cents).toBe(0);
  });
  it("does not reorder organization names or cap groups before reconciliation", () => {
    const rows = Array.from({ length: 8 }, (_, n) => ({ ...csv, contributorName: `Organization ${n}, PAC` }));
    expect(aggregate(rows).groups).toHaveLength(8);
    expect(aggregate([csv, { ...csv, contributorName: "PAC Example Association" }]).groups).toHaveLength(2);
  });
  it("rejects unsafe signed totals", () => {
    expect(() => aggregate([{ ...csv, amountCents: Number.MAX_SAFE_INTEGER }, csv])).toThrow(/unsafe_money/);
  });
});
