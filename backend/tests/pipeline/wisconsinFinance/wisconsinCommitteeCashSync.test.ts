import { afterEach, describe, expect, it, vi } from "vitest";
const hooks=vi.hoisted(()=>({load:vi.fn(),write:vi.fn()}));
vi.mock("../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashSource.js",()=>({loadWisconsinCommitteeCashPacket:hooks.load}));
vi.mock("../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashWriter.js",()=>({replaceWisconsinCommitteeCash:hooks.write}));
import {syncDueWisconsinCommitteeCash} from "../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashSync.js";
const row={candidate_id:"candidate",election_id:"election",candidate_name:"Alex Example",candidate_last_name:"Example",election_year:2026,election_date:"2026-11-03",office_scope:"statewide",office_name:"State Treasurer",district:null,total_due:"1"};
function setup(){const db={query:vi.fn(async()=>({rows:[row]}))};return {db,options:{db:db as never,now:new Date("2026-10-23T00:00:00Z"),maxCandidates:1,staleAfterDays:7,electionLookbackDays:1,electionLookaheadDays:730,candidateId:"candidate",electionYear:2026}};}
afterEach(()=>vi.resetAllMocks());
describe("Wisconsin independent cash sync",()=>{
  it("selects canonical contexts without requiring legacy finance links",async()=>{
    const {db,options}=setup();hooks.load.mockResolvedValue({});hooks.write.mockResolvedValue(true);
    expect(await syncDueWisconsinCommitteeCash(options)).toMatchObject({accepted:1,written:1,held:0});
    const sql=db.query.mock.calls[0]![0];expect(sql).toContain("FROM public.candidate_elections");expect(sql).not.toContain("wi_candidate_finance_links");
    expect(hooks.load).toHaveBeenCalledWith(expect.objectContaining({candidateName:"Alex Example"}),expect.objectContaining({allowNetwork:false,refresh:false}));
  });
  it("records safe acquisition failure without calling the money writer",async()=>{
    const {db,options}=setup();hooks.load.mockRejectedValue(Error("Wisconsin reported finance held: cache_missing"));
    expect(await syncDueWisconsinCommitteeCash(options)).toMatchObject({accepted:0,written:0,held:1,failures:["cache_missing"]});
    expect(hooks.write).not.toHaveBeenCalled();expect(db.query.mock.calls[1]![0]).toContain("reported_cash_attempts");
  });
  it("suppresses unstructured errors and preserves the source on write failure",async()=>{
    const {options}=setup();hooks.load.mockResolvedValue({});hooks.write.mockRejectedValue(Error("private source identity"));
    expect((await syncDueWisconsinCommitteeCash(options)).failures).toEqual(["acquisition_or_write_failed"]);
  });
  it("dry run validates acquisition but writes neither money nor attempt",async()=>{
    const {db,options}=setup();hooks.load.mockResolvedValue({});
    expect(await syncDueWisconsinCommitteeCash({...options,dryRun:true})).toMatchObject({accepted:1,written:0});
    expect(hooks.write).not.toHaveBeenCalled();expect(db.query).toHaveBeenCalledTimes(1);
  });
  it("reports an idempotent source as accepted without rewriting it",async()=>{
    const {options}=setup();hooks.load.mockResolvedValue({});hooks.write.mockResolvedValue(false);
    expect(await syncDueWisconsinCommitteeCash(options)).toMatchObject({accepted:1,written:0,held:0});
  });
});
