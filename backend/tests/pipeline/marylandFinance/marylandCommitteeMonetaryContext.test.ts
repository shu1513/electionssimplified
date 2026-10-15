import {describe,expect,it,vi} from "vitest";
import {loadMarylandCommitteeMonetaryContext as load} from "../../../src/pipeline/marylandFinance/marylandCommitteeMonetaryContext.js";
const scope={candidateId:"11111111-1111-4111-8111-111111111111",electionId:"22222222-2222-4222-8222-222222222222",electionYear:2026,committeeId:"123"};
describe("ordinary Maryland committee canonical context",()=>{
  it("binds each due selector and preserves the actual DB context without inventing eligibility",async()=>{
    const row={candidateId:scope.candidateId,electionId:scope.electionId,candidateDeleted:true,activeReceivingLinkCount:2};
    const query=vi.fn().mockResolvedValue({rows:[row]});const result=await load({query} as never,scope);
    expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0]![1]).toEqual([scope.candidateId,scope.electionId,2026,"123"]);
    expect(result).toEqual(row);expect(Object.isFrozen(result)).toBe(true);
    row.candidateDeleted=false;expect(result!.candidateDeleted).toBe(true);
  });
  it.each([{rows:[]},{rows:[{},{}]}])("holds missing or ambiguous exact receiving links",async({rows})=>{
    const query=vi.fn().mockResolvedValue({rows});expect(await load({query} as never,scope)).toBeNull();
  });
  it.each([{candidateId:"bad"},{electionId:"00000000-0000-0000-0000-000000000000"},{electionYear:2026.5},{committeeId:"1; DROP TABLE"}])("rejects malformed scope before DB access %j",async change=>{
    const query=vi.fn();await expect(load({query} as never,{...scope,...change})).rejects.toThrow("invalid_maryland_committee_context");expect(query).not.toHaveBeenCalled();
  });
});
