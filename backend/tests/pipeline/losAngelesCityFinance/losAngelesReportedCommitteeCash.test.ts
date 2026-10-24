import { describe, expect, it } from "vitest";
import { aggregateLosAngelesReportedCommitteeCash as aggregate } from "../../../src/pipeline/losAngelesCityFinance/losAngelesReportedCommitteeCash.js";
import type { LosAngelesContributionRecord } from "../../../src/pipeline/losAngelesCityFinance/losAngelesOpenDataClient.js";
const row = (over: Partial<LosAngelesContributionRecord> = {}): LosAngelesContributionRecord => ({ sourceRowId:"row-one",contributionDate:"2026-10-10",contributorName:"Example PAC",occupation:null,employer:null,
 committeeName:"Alex Example Council Committee",committeeId:"1111111",candidateName:"Alex Example",seatDescription:null,contributionType:"Monetary Contributions (Itemized)",amount:100.01,amountPaidOrForgiven:0,schedule:"A",periodBeginDate:"2026-10-01",periodEndDate:"2026-10-17",electionDate:"2026-11-03",...over });
const run = (records: LosAngelesContributionRecord[]) => aggregate({records,receivingCommitteeIds:["1111111","2222222"],candidateName:"Alex Example",electionYear:2026});
describe("Los Angeles reported committee cash", () => {
 it("preserves equal native gifts across both receiving accounts and closes gross cents", () => {
  expect(run([row(),row({sourceRowId:"row-two",committeeId:"2222222",contributorName:"Example PÀC"})])).toMatchObject({amountCents:20002,contributionCount:2,reportedThrough:"2026-10-17",receivingCommitteeIds:["1111111","2222222"],donors:[{committeeKey:"EXAMPLE PAC",amountCents:20002,contributionCount:2}]});
 });
 it.each([{schedule:"C"},{schedule:"B"},{schedule:"I"},{contributionType:"Monetary Contributions (Untemized)"},{occupation:"Teacher"},{contributorName:"Alex Example Council Committee"},{contributorName:"Example Company"},{amount:0}])("excludes unqualified cash %j", over => expect(run([row(over)]).amountCents).toBe(0));
 it.each([{amount:-1},{amount:1.001},{sourceRowId:null},{committeeId:"3333333"},{candidateName:"Other Person"},{electionDate:"2025-11-03"},{contributionDate:null},{periodBeginDate:null},{contributionDate:"2026-10-18"},{contributionDate:"2026-02-30"},{memo:"unresolved memo"},{amountPaidOrForgiven:1}])("holds unsafe evidence %j", over => expect(() => run([row(over)])).toThrow());
 it("holds duplicate publication IDs even for equal monetary occurrences", () => expect(() => run([row(),row()])).toThrow(/duplicate/));
 it("holds safe-cent overflow", () => expect(() => run([row({amount:Number.MAX_SAFE_INTEGER/100}),row({sourceRowId:"row-two"})])).toThrow());
 it("does not invent a report date for an empty source", () => expect(run([])).toMatchObject({donors:[],amountCents:0,reportedThrough:null}));
});
