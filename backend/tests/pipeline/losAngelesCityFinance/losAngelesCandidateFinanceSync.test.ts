import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncLosAngelesCandidateFinance } from "../../../src/pipeline/losAngelesCityFinance/losAngelesCandidateFinanceSync.js";
import { getLosAngelesCommitteeContributions } from "../../../src/pipeline/losAngelesCityFinance/losAngelesOpenDataClient.js";
import { getLosAngelesIndependentSpending, type LosAngelesEthicsCandidateTotal } from "../../../src/pipeline/losAngelesCityFinance/losAngelesCityEthicsClient.js";
import { replaceLosAngelesCandidateFinanceSnapshot } from "../../../src/pipeline/losAngelesCityFinance/losAngelesFinanceWriter.js";
vi.mock("../../../src/pipeline/losAngelesCityFinance/losAngelesOpenDataClient.js", async original => ({...await original<object>(),getLosAngelesCommitteeContributions:vi.fn()}));
vi.mock("../../../src/pipeline/losAngelesCityFinance/losAngelesCityEthicsClient.js", async original => ({...await original<object>(),getLosAngelesIndependentSpending:vi.fn()}));
vi.mock("../../../src/pipeline/losAngelesCityFinance/losAngelesFinanceWriter.js", async original => ({...await original<object>(),replaceLosAngelesCandidateFinanceSnapshot:vi.fn()}));
const total: LosAngelesEthicsCandidateTotal = {electionId:"76",electionSeatId:"1",electionSeatCandidateId:"2",candidatePersonId:"3",candidateName:"Alex Example",officeName:"Mayor",reportedThrough:"2026-10-17",fppcCommitteeId:"1111111",fppcCommitteeIds:["1111111","2222222"],sourceElectionDates:["2026-06-02","2026-11-03"],committeeName:"Example Campaign",internalCommitteePersonId:null,totalContributions:100,totalExpenditures:50,cashOnHand:50,matchingFunds:0,outsideSupportTotal:40,outsideOpposeTotal:0,membershipSupportTotal:13,membershipOpposeTotal:0,sourceUrl:"https://ethics.lacity.gov/elections/"};
const input = () => ({db:{query:vi.fn().mockResolvedValue({rows:[]}),connect:vi.fn()} as never,candidateId:"c",electionId:"e",electionYear:2026,candidateName:"Alex Example",officeName:"Mayor",total:structuredClone(total)});
beforeEach(() => {
 vi.clearAllMocks();vi.mocked(replaceLosAngelesCandidateFinanceSnapshot).mockResolvedValue({linkId:"link"});
 vi.mocked(getLosAngelesCommitteeContributions).mockImplementation(async ({committeeId}) => [{sourceRowId:"row-"+committeeId,contributionDate:"2026-10-10",contributorName:"Example PAC",occupation:null,employer:null,committeeName:"Example Campaign",committeeId,candidateName:"Alex Example",seatDescription:null,contributionType:"Monetary Contributions (Itemized)",amount:committeeId==="1111111"?25:75,amountPaidOrForgiven:0,schedule:"A",periodBeginDate:"2026-10-01",periodEndDate:"2026-10-17",electionDate:committeeId==="1111111"?"2026-06-02":"2026-11-03"}]);
 vi.mocked(getLosAngelesIndependentSpending).mockImplementation(async ({supportOppose}) => supportOppose==="support"?[{expenditureId:"ie-one",spenderId:"1480000",spenderName:"Example Outside PAC",candidateName:"Alex Example",officeName:"Mayor",supportOppose:"support",amount:40,reportUrl:null}]:[]);
});
describe("Los Angeles complete receiving-scope sync", () => {
 it("acquires both ledgers, qualified cash and IE, keeping membership communications separate", async () => {
  const result=await syncLosAngelesCandidateFinance(input());expect(result).toMatchObject({linkWritten:true,reportedCommitteeCashCents:10000,reportedCommitteeCashGroupCount:1,reportedCommitteeCashGiftCount:2,outsideGroupCount:1,reconciliationDifference:0});
  expect(vi.mocked(getLosAngelesCommitteeContributions).mock.calls.map(c=>c[0].committeeId)).toEqual(["1111111","2222222"]);
  const write=vi.mocked(replaceLosAngelesCandidateFinanceSnapshot).mock.calls[0]![0];expect(write.link.fppcCommitteeIds).toEqual(["1111111","2222222"]);expect(write.summary.membershipSupportTotal).toBe(13);expect(write.summary.outsideSupportTotal).toBe(40);
 });
 it.each(["receipt closure","outside closure","calendar","scope"])("holds %s failure before the writer", async kind => {
  const value=input();if(kind==="receipt closure")value.total.totalContributions++;if(kind==="outside closure")value.total.outsideSupportTotal++;if(kind==="calendar")value.total.sourceElectionDates=["2026-06-03","2026-11-03"];if(kind==="scope")value.total.fppcCommitteeIds=["1111111","1111111"];
  await expect(syncLosAngelesCandidateFinance(value)).rejects.toThrow();expect(replaceLosAngelesCandidateFinanceSnapshot).not.toHaveBeenCalled();
 });
 it("does not call the writer when an ordinary source fails", async () => {
  vi.mocked(getLosAngelesCommitteeContributions).mockRejectedValue(Error("source unavailable"));await expect(syncLosAngelesCandidateFinance(input())).rejects.toThrow("source unavailable");expect(replaceLosAngelesCandidateFinanceSnapshot).not.toHaveBeenCalled();
 });
});
