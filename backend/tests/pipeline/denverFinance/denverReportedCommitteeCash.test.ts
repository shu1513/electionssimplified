import { describe, expect, it } from "vitest";
import { aggregateDenverReportedCommitteeCash as aggregate } from "../../../src/pipeline/denverFinance/denverReportedCommitteeCash.js";
import type { DenverContributionTransaction } from "../../../src/pipeline/denverFinance/denverSearchlightClient.js";
const row = (over: Partial<DenverContributionTransaction> = {}): DenverContributionTransaction => ({ transactionId: 1, transactionSubType: "Monetary", recipientCommitteeId: 10, recipientName: null, recipientCommitteeName: null, officeSought: null, district: null, contributorName: "Example PAC", contributorId: 99, amountCents: 10001, date: "2026-10-14T06:00:00", contributorEmployer: null, contributorOccupation: null, contributorCity: null, contributorStateCode: null, contactTypeId: 3, txnPurpose: null, fefTransaction: false, ...over });
const run = (rows: DenverContributionTransaction[]) => aggregate({ rows, committeeEntityIds: [10] });
describe("Denver reported committee cash", () => {
 it("keeps distinct equal native gifts and combines normalized reported labels", () => {
  expect(run([row(),row({ transactionId:2, contributorName:"Example PÀC" })])).toMatchObject({ amountCents:20002, contributionCount:2, transactionThrough:"2026-10-14", donors:[{committeeKey:"EXAMPLE PAC",amountCents:20002,contributionCount:2}] });
 });
 it("admits native Committee and explicit political Organization names, including organization-only labels", () => {
  expect(run([row({contributorName:"Friends of Example"}),row({transactionId:2,contactTypeId:2,contributorName:null,organizationName:"Example Political Fund"})]).donors).toHaveLength(2);
 });
 it.each([
  {contactTypeId:1}, {contactTypeId:2,contributorName:"Example Credit Union"},
  {contactTypeId:2,contributorName:"Example Association"}, {contactTypeId:2,contributorOccupation:"Teacher"},
  {transactionSubType:"In-Kind"}, {transactionSubType:"Loan"}, {transactionSubType:"Fair Elections Payments"},
  {recipientCommitteeId:20}, {amountCents:0},
 ])("excludes unqualified receipts %j", over => expect(run([row(over)]).amountCents).toBe(0));
 it.each([
  [{amountCents:-1}], [{amountCents:1.5}], [{contributorName:null}], [{date:null}], [{date:"2026-02-30"}],
  [{organizationName:"Different PAC"}], [{contactTypeId:null}], [{transactionId:0}],
 ])("holds unsafe identified receipts %j", over => expect(() => run([row(over)])).toThrow());
 it("holds duplicate IDs before monetary selection", () => expect(() => run([row(),row({transactionSubType:"Loan"})])).toThrow(/duplicate/));
 it("does not silently net an identified refund", () => expect(() => run([row(),row({transactionId:2,amountCents:-100})])).toThrow(/signed/));
 it("holds cent overflow", () => expect(() => run([row({amountCents:Number.MAX_SAFE_INTEGER}),row({transactionId:2})])).toThrow(/precision/));
 it("requires receiving identities and represents a genuinely empty feed without inventing a transaction date", () => {
  expect(() => aggregate({rows:[],committeeEntityIds:[]})).toThrow(); expect(run([])).toEqual({donors:[],amountCents:0,contributionCount:0,transactionThrough:null});
 });
});
