import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {Pool} from "pg";
import type {GeorgiaReportedFinanceReceiver} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceTypes.js";
import type {GeorgiaReportedContributionSource,GeorgiaReportedIeSource,GeorgiaReportedSourceFacts}
  from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js";
import type {GeorgiaReportedContributionExportDiagnostics} from "../../../src/pipeline/georgiaFinance/georgiaReportedContributionExport.js";
const calls=vi.hoisted(()=>({readIe:vi.fn(),readContributions:vi.fn(),refreshIe:vi.fn(),refreshContributions:vi.fn(),producer:vi.fn(),
  due:vi.fn(),attempt:vi.fn(),registration:vi.fn(),transport:vi.fn(),writeIe:vi.fn(),writeContributions:vi.fn(),
  legacyDirect:vi.fn(),legacyReports:vi.fn(),legacyTransactions:vi.fn(),legacyFunder:vi.fn(),legacyWriter:vi.fn(),order:[] as string[]}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js",async original=>({
  ...await original<typeof import("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js")>(),
  readGeorgiaReportedIeSource:calls.readIe,readGeorgiaReportedContributionSource:calls.readContributions,
  createGeorgiaReportedFinanceSourceProducer:calls.producer,
}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceDueList.js",()=>({
  listDueGeorgiaReportedFinance:calls.due,recordGeorgiaReportedFinanceAttempt:calls.attempt,
}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaLinkedReceivingRegistration.js",()=>({fetchGeorgiaLinkedReceivingRegistration:calls.registration}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceWriter.js",async original=>({
  ...await original<typeof import("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceWriter.js")>(),
  writeGeorgiaReportedIeComponent:calls.writeIe,writeGeorgiaReportedCommitteeComponent:calls.writeContributions,
}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js",async original=>({
  ...await original<typeof import("../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js")>(),
  createGeorgiaEthicsTransport:calls.transport,fetchGeorgiaFiledReportRows:calls.legacyReports,
  fetchGeorgiaTransactionRows:calls.legacyTransactions,fetchGeorgiaTransactionRowsStable:calls.legacyTransactions,
  fetchGeorgiaTransactionRowsWindowed:calls.legacyTransactions,
}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaCandidateFinanceSync.js",()=>({
  syncGeorgiaCandidateFinance:calls.legacyDirect,fetchGeorgiaSpenderContributionRows:calls.legacyFunder,
}));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaFinanceWriter.js",()=>({
  replaceGeorgiaCandidateFinanceSnapshot:calls.legacyWriter,upsertGeorgiaFinanceLink:calls.legacyWriter,
}));
import {GeorgiaReportedFinanceSourceCacheError} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js";
import {GeorgiaReportedFinanceWriteError} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceWriter.js";
import {syncDueGeorgiaReportedFinance} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceBatchSync.js";

const NOW=new Date("2026-10-21T12:00:00.000Z"),CAPTURE="2026-10-21T10:00:00.000Z",OLD="2026-10-15T10:00:00.000Z";
const GUID="00000000-0000-4000-8000-000000000010";
const receiver:GeorgiaReportedFinanceReceiver={linkId:"00000000-0000-4000-8000-000000000001",
  candidateId:"00000000-0000-4000-8000-000000000002",electionId:"00000000-0000-4000-8000-000000000003",
  candidateName:"Fixture Candidate",electionYear:2026,electionDate:"2026-11-03",officeScope:"statewide",officeName:"Governor",
  district:null,committeeId:"10",committeeName:"Fixture Receiver",linkSource:"manual",sourceUrl:null,lastSyncedAt:null};
function facts(at=CAPTURE):GeorgiaReportedSourceFacts{return {filingYear:2026,electionYear:2026,sourceRetrievedAt:at,sourceCompletedAt:at,
  sourceManifestSha256:"a".repeat(64),sourceUrl:"https://ethics.ga.gov/records-search-all/",sourceRowCount:1,sourceByteSize:100,sourceControls:[]};}
function ie(at=CAPTURE):GeorgiaReportedIeSource{return {...facts(at),nativeTotal:1,passCount:2,rows:[{guid:"fixture-transaction",transactionId:1,
  amountApplied:100,filerRegistrationGuid:"fixture-spender",filerName:"Fixture Reporting Committee",filerReportGuid:null,timedFiledReportGuid:"fixture-timed",
  filerReportVersionId:1,transactionDate:"2026-10-15",transactionStatusCode:"TFIL",transactionTypeCode:"TIE",electionYear:2026,
  candidateMeasures:[{candidateMeasureTitle:"Fixture Candidate",stance:"Support",reasonTypeCode:"CAN",filerRegistrationGuid:GUID}]}]};}
function contributions(at=CAPTURE):GeorgiaReportedContributionSource{return {...facts(at),sourceBasis:"reported_committee_itemized_contributions",
  heldReceivingCommitteeIds:new Set(),rowsByReceivingCommitteeId:new Map([["10",[{receivingCommitteeId:"10",transactionId:"1",
    contributorType:"Non-Candidate Committee",contributorName:"Fixture Contribution Committee",amountCents:20000,allocatedElectionYear:2026,
    transactionDate:"2026-10-15",amended:"N",timedReportName:null,timedReportFiledDate:null,periodicReportName:"Fixture Report",periodicReportFiledDate:"2026-10-20"}]]]),
  // Financial parser accounting is separately tested; this orchestration mock
  // represents a qualified immutable source-reader boundary, not money proof.
  diagnostics:{} as GeorgiaReportedContributionExportDiagnostics};}
const db={query:vi.fn(),connect:vi.fn()} as unknown as Pool;
const run=(options:Partial<Parameters<typeof syncDueGeorgiaReportedFinance>[0]>={})=>syncDueGeorgiaReportedFinance({db,now:NOW,cacheDir:"/private/synthetic-cache",...options});
beforeEach(()=>{
  vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(NOW);calls.order.length=0;
  for(const name of ["CANDIDATE_FINANCE_ENABLED","GEORGIA_CAMPAIGN_FINANCE_ENABLED","GEORGIA_REPORTED_IE_ENABLED","GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED"])vi.stubEnv(name,"true");
  vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","false");
  calls.readIe.mockResolvedValue(ie());calls.readContributions.mockResolvedValue(contributions());
  calls.producer.mockReturnValue({refreshIe:calls.refreshIe,refreshContributions:calls.refreshContributions});
  calls.due.mockResolvedValue({eligibleCount:1,totalDueRows:1,rows:[receiver]});
  calls.attempt.mockImplementation(async()=>{calls.order.push("attempt");return true;});
  calls.registration.mockImplementation(async()=>{calls.order.push("context");return {status:"qualified",context:{receivingCommitteeId:"10",registrationGuid:GUID}};});
  calls.transport.mockReturnValue({postJson:vi.fn().mockRejectedValue(new Error("synthetic transport must not fetch"))});
  calls.writeIe.mockResolvedValue({sourceWritten:true,groupCount:1,idempotent:false});
  calls.writeContributions.mockResolvedValue({sourceWritten:true,groupCount:1,idempotent:false});
  for(const trap of [calls.legacyDirect,calls.legacyReports,calls.legacyTransactions,calls.legacyFunder,calls.legacyWriter])
    trap.mockImplementation(()=>{throw new Error("legacy direct/funder path must not run");});
});
afterEach(()=>{
  for(const trap of [calls.legacyDirect,calls.legacyReports,calls.legacyTransactions,calls.legacyFunder,calls.legacyWriter])expect(trap).not.toHaveBeenCalled();
  vi.useRealTimers();vi.unstubAllEnvs();
});

describe("Georgia ordinary independent reported finance batch",()=>{
  it.each(["children","master"] as const)("does no source/DB/context work with %s gates disabled even on refresh",async gate=>{
    if(gate==="children"){vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED","false");vi.stubEnv("GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED","false");}
    else vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED","false");
    vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","true");
    expect(await run({refresh:true})).toMatchObject({enabled:false,selectedCount:0,attemptedCount:0});
    for(const f of [calls.readIe,calls.readContributions,calls.producer,calls.due,calls.attempt,calls.registration,calls.transport,calls.writeIe,calls.writeContributions])expect(f).not.toHaveBeenCalled();
  });
  it.each(["ie","contributions"] as const)("reads, refreshes and writes only the enabled %s component",async kind=>{
    vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED",String(kind==="ie"));vi.stubEnv("GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED",String(kind==="contributions"));
    vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","true");await run({refresh:true});
    expect(kind==="ie"?calls.readIe:calls.readContributions).toHaveBeenCalledTimes(2);
    expect(kind==="ie"?calls.refreshIe:calls.refreshContributions).toHaveBeenCalledTimes(1);
    expect(kind==="ie"?calls.writeIe:calls.writeContributions).toHaveBeenCalledTimes(1);
    for(const f of kind==="ie"?[calls.readContributions,calls.refreshContributions,calls.writeContributions]:[calls.readIe,calls.refreshIe,calls.writeIe])expect(f).not.toHaveBeenCalled();
  });
  it("refresh cannot bypass the separate raw-source acquisition gate",async()=>{
    expect(await run({refresh:true})).toMatchObject({ieWrittenCount:1,contributionWrittenCount:1});
    expect(calls.producer).not.toHaveBeenCalled();expect(calls.refreshIe).not.toHaveBeenCalled();expect(calls.refreshContributions).not.toHaveBeenCalled();
  });
  it("uses the ordinary aggregate default scope without a candidate/name selector",async()=>{
    await run();expect(calls.due).toHaveBeenCalledWith(db,expect.objectContaining({now:NOW,maxCandidates:100,staleAfterDays:7,
      electionLookbackDays:30,electionLookaheadDays:550,filingYear:2026,electionYear:2026,gates:{ie:true,contributions:true}}));
    const input=calls.due.mock.calls[0]![1];expect(input).not.toHaveProperty("candidateId");expect(input).not.toHaveProperty("candidateName");
  });
  it("reads the configured process cache directory when the job passes none",async()=>{
    vi.stubEnv("GEORGIA_REPORTED_FINANCE_CACHE_DIR"," /private/env-cache ");vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","true");
    await run({cacheDir:undefined,refresh:true});
    for(const f of [calls.readIe,calls.readContributions])expect(f).toHaveBeenCalledWith(expect.objectContaining({cacheDir:"/private/env-cache"}));
    expect(calls.producer).toHaveBeenCalledWith({cacheDir:"/private/env-cache"});
    vi.stubEnv("GEORGIA_REPORTED_FINANCE_CACHE_DIR","");vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","false");
    vi.resetAllMocks();calls.due.mockResolvedValue({eligibleCount:0,totalDueRows:0,rows:[]});
    await run({cacheDir:undefined});
    expect(calls.readIe).toHaveBeenCalledWith(expect.objectContaining({cacheDir:expect.stringMatching(/\/scratch\/georgia-reported-finance$/)}));
  });
  it("does not recapture young qualified packets unless refresh is explicit",async()=>{
    vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","true");await run();
    expect(calls.refreshIe).not.toHaveBeenCalled();expect(calls.refreshContributions).not.toHaveBeenCalled();
  });
  it("records an actual-clock attempt before receiving-context lookup and preserves capture clocks",async()=>{
    const scheduled=new Date("2026-10-21T11:00:00.000Z");await run({now:scheduled});
    expect(calls.order).toEqual(["attempt","context"]);
    expect(calls.attempt).toHaveBeenCalledWith({db,receiver,now:NOW,gates:{ie:true,contributions:true}});
    expect(calls.writeIe.mock.calls[0]![0].source.sourceRetrievedAt).toBe(CAPTURE);
    expect(calls.writeContributions.mock.calls[0]![0].source.sourceRetrievedAt).toBe(CAPTURE);
    expect(calls.writeIe.mock.calls[0]![0].source.sourceRetrievedAt).not.toBe(scheduled.toISOString());
  });
  it("dry-run can qualify native receiving context but makes zero attempt/component/DB writes",async()=>{
    expect(await run({dryRun:true})).toMatchObject({selectedCount:1,attemptedCount:0,contextQualifiedCount:1,
      ieQualifiedCount:1,contributionQualifiedCount:1,ieWrittenCount:0,contributionWrittenCount:0});
    expect(calls.registration).toHaveBeenCalledTimes(1);
    for(const f of [calls.attempt,calls.writeIe,calls.writeContributions,db.query,db.connect])expect(f).not.toHaveBeenCalled();
  });
  it("rotates a receiver even when every source is unavailable without publishing a fake zero",async()=>{
    calls.readIe.mockRejectedValue(new GeorgiaReportedFinanceSourceCacheError());calls.readContributions.mockResolvedValue(null);
    expect(await run()).toMatchObject({sourceUnavailableCount:2,attemptedCount:1,contextHeldCount:1,ieWrittenCount:0,contributionWrittenCount:0});
    expect(calls.attempt).toHaveBeenCalledTimes(1);expect(calls.registration).not.toHaveBeenCalled();
    expect(calls.writeIe).not.toHaveBeenCalled();expect(calls.writeContributions).not.toHaveBeenCalled();
  });
  it("a rejected protected attempt prevents context lookup and both money writes",async()=>{
    calls.attempt.mockResolvedValue(false);expect(await run()).toMatchObject({attemptRejectedCount:1,attemptedCount:0,contextQualifiedCount:0});
    expect(calls.registration).not.toHaveBeenCalled();expect(calls.writeIe).not.toHaveBeenCalled();expect(calls.writeContributions).not.toHaveBeenCalled();
  });
  it.each(["held","unavailable"] as const)("keeps an actual attempt but writes neither component for %s receiving context",async status=>{
    calls.registration.mockResolvedValue({status,reason:status==="held"?"missing_or_ambiguous_receiving_registration":"receiving_index_unavailable"});
    expect(await run()).toMatchObject({attemptedCount:1,contextHeldCount:1,ieWrittenCount:0,contributionWrittenCount:0});
    expect(calls.writeIe).not.toHaveBeenCalled();expect(calls.writeContributions).not.toHaveBeenCalled();
  });
  it("an unavailable IE source cannot block independently qualified committee contributions",async()=>{
    calls.readIe.mockResolvedValue(null);expect(await run()).toMatchObject({sourceUnavailableCount:1,ieHeldCount:1,contributionWrittenCount:1});
    expect(calls.writeIe).not.toHaveBeenCalled();expect(calls.writeContributions).toHaveBeenCalledTimes(1);
  });
  it("holds invalid target stance while independently writing valid committee contributions",async()=>{
    const packet=ie();packet.rows[0]!.candidateMeasures[0]!.stance=null;calls.readIe.mockResolvedValue(packet);
    expect(await run()).toMatchObject({ieHeldCount:1,ieWrittenCount:0,contributionWrittenCount:1});expect(calls.writeIe).not.toHaveBeenCalled();
  });
  it("a held receiving contribution export does not block independent IE",async()=>{
    const packet=contributions();packet.heldReceivingCommitteeIds=new Set(["10"]);calls.readContributions.mockResolvedValue(packet);
    expect(await run()).toMatchObject({contributionHeldCount:1,contributionWrittenCount:0,ieWrittenCount:1});expect(calls.writeContributions).not.toHaveBeenCalled();
  });
  it("an expected IE writer refusal preserves that component and still writes the sibling",async()=>{
    calls.writeIe.mockRejectedValue(new GeorgiaReportedFinanceWriteError("stale_source"));
    expect(await run()).toMatchObject({ieQualifiedCount:1,ieHeldCount:1,ieWrittenCount:0,contributionWrittenCount:1});
  });
  it("retains a qualified prior packet and its actual old clock when acquisition fails, while the sibling refreshes",async()=>{
    vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","true");const priorIe=ie(OLD),priorCash=contributions(OLD),newCash=contributions();
    calls.readIe.mockResolvedValue(priorIe);calls.readContributions.mockResolvedValueOnce(priorCash).mockResolvedValueOnce(newCash);
    calls.refreshIe.mockRejectedValue(new GeorgiaReportedFinanceSourceCacheError());
    expect(await run()).toMatchObject({sourceUnavailableCount:0,ieWrittenCount:1,contributionWrittenCount:1});
    expect(calls.writeIe.mock.calls[0]![0].source).toBe(priorIe);expect(priorIe.sourceRetrievedAt).toBe(OLD);
    expect(calls.writeContributions.mock.calls[0]![0].source).toBe(newCash);expect(calls.readIe).toHaveBeenCalledTimes(1);
  });
  it("accepts only committed-cache replay after refresh, never the producer return's bare rows",async()=>{
    vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED","true");vi.stubEnv("GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED","false");
    const committed=ie(),bare=ie("2026-10-21T11:59:00.000Z");bare.rows[0]!.amountApplied=999;
    calls.readIe.mockResolvedValueOnce(ie(OLD)).mockResolvedValueOnce(committed);calls.refreshIe.mockResolvedValue(bare);
    await run();const written=calls.writeIe.mock.calls[0]![0];
    expect(written.source).toBe(committed);expect(written.aggregation.supportTotalCents).toBe(10000);expect(written.source).not.toBe(bare);
  });
  it("does not conceal source programming errors as unavailable or record unrelated attempts",async()=>{
    calls.readIe.mockRejectedValue(new TypeError("synthetic programming fault"));await expect(run()).rejects.toThrow("synthetic programming fault");
    expect(calls.attempt).not.toHaveBeenCalled();expect(calls.writeContributions).not.toHaveBeenCalled();
  });
  it.each([{maxCandidates:0},{maxCandidates:1001},{filingYear:2025},{electionYear:2101},{staleAfterDays:0},{now:new Date(NaN)}])
  ("rejects invalid ordinary scope before source or DB work: %j",async options=>{
    await expect(run(options)).rejects.toThrow("Invalid Georgia reported finance batch");expect(calls.readIe).not.toHaveBeenCalled();expect(calls.due).not.toHaveBeenCalled();
  });
});
