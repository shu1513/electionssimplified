import { describe, expect, it } from "vitest";
import { aggregateMarylandNativePacPositions } from "../../../src/pipeline/marylandFinance/marylandNativePacAggregator.js";
const OWNER = "11111111-1111-4111-8111-111111111111";
const uuid = (id: number) => `${String(id).padStart(8, "0")}-1111-4111-8111-111111111111`;
function gift(id: number, override: Record<string, unknown> = {}) {
  return {transactionId: id, transactionGuid: uuid(id), filerRegistrationGuid: OWNER,
    electionCycleId: 12023, isActive: true, isReturn: false, transactionTypeCode: "TCON",
    contributionTypeCode: "TRFR", contributorTypeCode: "TPAC", contributorType: "Political Action Committee",
    contributorName: "Reported PAC", transactionAmount: 1000, transactionDate: "2023-01-12T00:00:00",
    parentTransactionId: null, parentTransactionGuid: null, ...override};
}
function refund(id: number, parent: number, override: Record<string, unknown> = {}) {
  return gift(id, {transactionTypeCode: "TRCON", isReturn: true, parentTransactionId: parent,
    parentTransactionGuid: uuid(parent), contributionTypeCode: "CMONT", contributorTypeCode: "TPOC",
    contributorType: "Participating Organization Committee", transactionDate: "2023-01-13T00:00:00", ...override});
}
const scope = {receivingGuid: OWNER, currentCycle: "12023", priorCycle: "12019"};
function aggregate(currentRows: Record<string, unknown>[], priorRows: Record<string, unknown>[] = []) {
  return aggregateMarylandNativePacPositions({...scope, currentRows, priorRows,
    declaredCurrentRows: currentRows.length, declaredPriorRows: priorRows.length});
}
describe("Maryland whole native PAC arithmetic facts", () => {
  it("nets a class-shifted refund against its actual PAC gift and retains a zero position", () => {
    const result = aggregate([gift(1), refund(2, 1)]);
    expect(result).toMatchObject({sourceRows: 2, resolvedRefunds: 1, giftCount: 1,
      refundCount: 1, grossCents: 100000, refundCents: 100000, netCents: 0});
    expect(result.positions).toHaveLength(1);
    expect(result).not.toHaveProperty("qualified");
  });
  it("resolves a source-null parent GUID by exact prior-cycle numeric identity without rewriting it", () => {
    const original = gift(1, {electionCycleId: 12019, transactionDate: "2022-08-22T00:00:00"});
    const returned = refund(3, 1, {parentTransactionGuid: null, transactionAmount: 250});
    const result = aggregate([gift(2), returned], [original]);
    expect(result.netCents).toBe(75000);
    expect(returned.parentTransactionGuid).toBeNull();
  });
  it("keeps distinct equal gifts and literal names, without name-based PAC inference", () => {
    const result = aggregate([gift(1), gift(2), gift(3, {contributorName: "Reported PAC, Inc."}),
      gift(4, {contributorName: "Reported PAC Inc."}),
      gift(5, {contributorName: "A business PAC", contributorTypeCode: "TBSN", contributorType: "Business/Group/Organization"})]);
    expect(result.giftCount).toBe(4);
    expect(result.positions).toHaveLength(3);
    expect(result.positions[0]).toMatchObject({giftCount: 2, netCents: 200000});
  });
  it("excludes explicit in-kind PAC gifts and bank income while preserving whole physical count", () => {
    const result = aggregate([gift(1), gift(2, {contributionTypeCode: "CINKIND"}),
      gift(3, {contributionTypeCode: "OTHRINCM", contributorTypeCode: "TBSN", contributorType: "Business/Group/Organization"}),
      gift(4, {contributionTypeCode: "ANYMS", contributorTypeCode: null, contributorType: null, contributorName: null})]);
    expect(result.sourceRows).toBe(4);
    expect(result.giftCount).toBe(1);
  });
  it("retains published political-club/slate source classes without promoting them to PAC", () => {
    const result = aggregate([gift(1), gift(2, {contributorTypeCode: "TPCLB", contributorType: "Political Club"}),
      gift(3, {contributorTypeCode: "TSLATE", contributorType: "Slate Committee"})]);
    expect(result).toMatchObject({sourceRows: 3, giftCount: 1, netCents: 100000});
  });
  it("holds an unresolvable individual refund beside a positive PAC gift", () => {
    expect(() => aggregate([gift(1), refund(2, 999, {contributorTypeCode: "TIND", contributorName: "Person"})]))
      .toThrow("unresolved_parent");
  });
  it.each([
    {parentTransactionGuid: uuid(99)}, {contributorName: "Other PAC"},
    {transactionDate: "2023-01-11T00:00:00"},
  ])("holds inconsistent parent identity %j", override => {
    expect(() => aggregate([gift(1), refund(2, 1, override)])).toThrow("parent_identity");
  });
  it("checks cumulative refunds including the prior cycle", () => {
    const original = gift(1, {electionCycleId: 12019, transactionDate: "2022-08-22T00:00:00"});
    const priorRefund = refund(2, 1, {electionCycleId: 12019, transactionDate: "2022-08-23T00:00:00", transactionAmount: 400});
    expect(() => aggregate([gift(4), refund(3, 1, {transactionAmount: 650})], [original, priorRefund]))
      .toThrow("refund_exceeds_gift");
  });
  it("retains the actual non-PAC over-refund anomaly without qualifying an overall cash total", () => {
    const person = {contributorTypeCode: "TIND", contributorType: "Individual", contributorName: "Person", transactionAmount: 1};
    const result = aggregate([gift(1), gift(2, person), refund(3, 2, person), refund(4, 2, person)]);
    expect(result).toMatchObject({sourceRows: 4, resolvedRefunds: 2, netCents: 100000, nonPacOverRefundParentCount: 1});
    expect(result).not.toHaveProperty("totalReceipts");
    expect(result).not.toHaveProperty("qualified");
  });
  it("holds a PAC cash refund of an in-kind original instead of treating it as a cash gift", () => {
    expect(() => aggregate([gift(1, {contributionTypeCode: "CINKIND"}), refund(2, 1)]))
      .toThrow("parent_identity");
  });
  it("holds repeated identities across cycles instead of merging them", () => {
    expect(() => aggregate([gift(1)], [gift(1, {electionCycleId: 12019})])).toThrow("duplicate_identity");
  });
  it.each([
    {transactionAmount: "1000"}, {transactionAmount: 1.001}, {transactionAmount: -1000},
    {isActive: false}, {transactionDate: "2023-02-30T00:00:00"}, {transactionTypeCode: "TRCON"},
    {contributionTypeCode: "UNKNOWN"}, {contributorTypeCode: "UNKNOWN"},
    {filerRegistrationGuid: uuid(99)}, {electionCycleId: 12019},
    {contributorType: "Individual"}, {contributorName: ""},
  ])("holds malformed or outside-scope rows without selecting a positive subset %j", override => {
    expect(() => aggregate([gift(1), gift(2, override)])).toThrow("invalid_row");
  });
  it("requires physical arrays to close their declared source counts", () => {
    expect(() => aggregateMarylandNativePacPositions({...scope, currentRows: [gift(1)], priorRows: [],
      declaredCurrentRows: 2, declaredPriorRows: 0})).toThrow("incomplete_collection");
  });
  it("holds unsafe aggregate cents and negative positions instead of dropping them", () => {
    expect(() => aggregate([gift(1, {transactionAmount: 80000000000000}), gift(2, {transactionAmount: 80000000000000})])).toThrow("unsafe_total");
    expect(() => aggregate([refund(2, 1)], [gift(1, {electionCycleId: 12019})])).toThrow("negative_position");
  });
});
