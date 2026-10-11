import { describe, expect, it, vi } from "vitest";

import { syncTennesseeCandidateFinance } from "../../../src/pipeline/tennesseeFinance/tennesseeCandidateFinanceSync.js";
import type { TennesseeCampContributionRecord } from "../../../src/pipeline/tennesseeFinance/tennesseeCampClient.js";
import type { TennesseeCampExpenditureRecord } from "../../../src/pipeline/tennesseeFinance/tennesseeCampClient.js";
import type { TennesseeVerifiedFinanceSnapshot } from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceWriter.js";

function contribution(overrides: Partial<TennesseeCampContributionRecord> = {}): TennesseeCampContributionRecord {
  return {
    type: "Monetary",
    adjustment: "N",
    amount: 250,
    date: "02/18/2022",
    electionYear: 2022,
    reportName: "1st Quarter",
    recipientName: "LEE, BILL",
    contributorName: "DOE, JANE",
    contributorOccupation: "Attorney",
    contributorEmployer: "Acme",
    ...overrides,
  };
}

function expenditure(overrides: Partial<TennesseeCampExpenditureRecord> = {}): TennesseeCampExpenditureRecord {
  return {
    type: "Independent",
    adjustment: "N",
    amount: 533,
    date: "10/01/2022",
    electionYear: 2022,
    reportName: "Pre-General",
    candidatePacName: "RIGHT TENNESSEE",
    vendorName: "Media Vendor",
    purpose: "Mail",
    candidateFor: "LEE, BILL",
    supportOpposeCode: "S",
    ...overrides,
  };
}

function createMockDb() {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 });
  const client = {
    query,
    release: vi.fn(),
  };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

describe("Tennessee verified finance sync path", () => {
  const identity = { candidateId: "11111111-1111-4111-8111-111111111111",electionId: "22222222-2222-4222-8222-222222222222",
    candidateName: "Jane Doe",electionYear: 2026,officeName: "State Senator",district: "3",campCandidateId: "794",ownerName: "DOE, JANE" };
  const sourceUrl = "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=123786";
  const pacSnapshot = (): TennesseeVerifiedFinanceSnapshot => ({ diagnostics: [],pacDonors: [{ committeeId: "reported:EXAMPLE PAC",
    committeeName: "Example PAC",committeeType: "Political Action Committee",amount: 1000,contributionCount: 1,sourceUrl }],
    pacSourceProvenance: { version: 1,candidateId: identity.candidateId,electionId: identity.electionId,campCandidateId: "794",electionYear: 2026,
      windowStart: "2025-01-01",windowEnd: "2026-12-31",registryFingerprint: "a".repeat(64),currentManifestFingerprint: "b".repeat(64),
      nativeAllFingerprint: "c".repeat(64),nativePacFingerprint: "d".repeat(64),candidateContextFingerprint: "a".repeat(64),
      reports: [{ reportId: "123786",periodIdentity: "Early Year End Supplemental 2025",periodStart: "2025-07-01",periodEnd: "2026-01-15",
        rawSha256: "e".repeat(64),semanticFingerprint: "f".repeat(64),sourceUrl }],
      receipts: [{ reportId: "123786",occurrence: 1,donorId: "reported:EXAMPLE PAC",date: "2025-08-19",amountCents: 100000 }] } });

  it("persists all verified labels and PAC rows without legacy aggregation or provider calls", async () => {
    const db = createMockDb(), classifier = vi.fn();
    const verifiedFinance = { ...pacSnapshot(),summary: { totalReceipts: 10000,directContributionTotal: 10000,sourceUrl },
      directBreakdowns: Array.from({ length: 30 }, (_,i) => ({ categoryType: "occupation" as const,categoryName: `Reported ${i}`,amount: 100,contributorCount: 1,sourceUrl })) };
    const synced = await syncTennesseeCandidateFinance({ db,...identity,verifiedFinance,financeIndustryClassifier: classifier });
    expect(synced).toMatchObject({ totalReceipts: 10000,directContributionTotal: 10000,pacDonorsWritten: 1,directBreakdownsWritten: 30,
      outsideSupportTotal: null,outsideOpposeTotal: null,sourceVerificationDiagnostics: [] });
    expect(classifier).not.toHaveBeenCalled();
    expect(db.query.mock.calls.filter(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_direct_breakdowns"))).toHaveLength(30);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside"))).toBe(false);
  });
  it("omits unavailable Raised while persisting independently verified dated PAC receipts", async () => {
    const db = createMockDb();
    const synced = await syncTennesseeCandidateFinance({ db,...identity,verifiedFinance: pacSnapshot() });
    expect(synced).toMatchObject({ totalReceipts: null,directContributionTotal: null,pacDonorsWritten: 1 });
    expect(db.query.mock.calls.some(call => String(call[0]).includes("total_receipts,"))).toBe(false);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("pac_source_provenance"))).toBe(true);
  });
  it("records only the attempt time for a diagnostics-only result, preserving every stored component", async () => {
    const db = createMockDb(), now = new Date("2026-10-11T16:00:00Z");
    const synced = await syncTennesseeCandidateFinance({ db,...identity,now,verifiedFinance: { diagnostics: ["Current report unavailable"] } });
    expect(synced).toMatchObject({ linkWritten: false,summaryWritten: false,totalReceipts: null,pacDonorsWritten: 0,
      sourceVerificationDiagnostics: ["Current report unavailable"] });
    expect(db.connect).not.toHaveBeenCalled();
    const sql = db.query.mock.calls.map(call => String(call[0]));
    expect(sql.some(s => s.includes("INSERT INTO public.tn_candidate_finance_links") || s.includes("total_receipts")
      || s.includes("pac_source_provenance") || s.includes("DELETE"))).toBe(false);
    const touch = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries"));
    expect(String(touch?.[0])).toContain("DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at");
    expect(touch?.[1]).toEqual(["33333333-3333-4333-8333-333333333333",2026,now.toISOString()]);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
  it("does not record an attempt time without an active link or on a dry run", async () => {
    const missing = createMockDb();
    missing.query.mockResolvedValueOnce({ rows: [],rowCount: 0 });
    await syncTennesseeCandidateFinance({ db: missing,...identity,verifiedFinance: { diagnostics: ["Current report unavailable"] } });
    expect(missing.query).toHaveBeenCalledTimes(1);
    const dry = createMockDb();
    await syncTennesseeCandidateFinance({ db: dry,...identity,dryRun: true,verifiedFinance: { diagnostics: ["Current report unavailable"] } });
    expect(dry.query).not.toHaveBeenCalled();
  });
  it("retains trusted sync identity and verification time when prepared source DTO includes its own link", async () => {
    const db=createMockDb(),now=new Date("2026-10-11T16:00:00Z");
    const prepared={...pacSnapshot(),link:{...identity,candidateNameNormalized:"JANE DOE",lastVerifiedAt:undefined},coverage:{}};
    await syncTennesseeCandidateFinance({db,...identity,now,verifiedFinance:prepared});
    const upsert=db.query.mock.calls.find(call=>String(call[0]).includes("INSERT INTO public.tn_candidate_finance_links"));
    expect(upsert?.[1]?.[13]).toBe(now.toISOString());
    expect(upsert?.[1]?.[0]).toBe(identity.candidateId);
  });
  it("dry run emits verified cash values while avoiding all persistence", async () => {
    const db = createMockDb();
    const synced = await syncTennesseeCandidateFinance({ db,...identity,dryRun: true,verifiedFinance: {
      ...pacSnapshot(),summary: { totalReceipts: 10000,directContributionTotal: 10000 } } });
    expect(synced).toMatchObject({ totalReceipts: 10000,linkWritten: false,pacDonorsWritten: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it("rejects legacy discovery mixed with verified evidence", async () => {
    const db = createMockDb();
    await expect(syncTennesseeCandidateFinance({ db,...identity,contributions: [],verifiedFinance: pacSnapshot() })).rejects.toThrow("cannot mix");
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("tennesseeCandidateFinanceSync", () => {
  it("aggregates and skips writes during dry runs", async () => {
    const db = { query: vi.fn() };
    await expect(
      syncTennesseeCandidateFinance({
        db,
        candidateId: "candidate-1",
        electionId: "election-1",
        candidateName: "Bill Lee",
        electionYear: 2022,
        officeName: "Governor",
        campCandidateId: "6496",
        ownerName: "LEE, BILL",
        contributions: [contribution()],
        expenditures: [expenditure()],
        outsideGroupContributionRecords: [
          contribution({
            amount: 50000,
            recipientName: "RIGHT TENNESSEE",
            contributorName: "TENNESSEE BANK PAC",
            contributorOccupation: null,
            contributorEmployer: null,
          }),
        ],
        now: new Date("2026-01-01T00:00:00.000Z"),
        dryRun: true,
      })
    ).resolves.toMatchObject({
      dryRun: true,
      linkWritten: false,
      totalReceipts: 250,
      directContributionTotal: 250,
      outsideSupportTotal: 533,
      outsideOpposeTotal: 0,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      outsideGroupCount: 1,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("classifies every donor but caps the persisted label rows per category", async () => {
    const db = createMockDb();
    const result = await syncTennesseeCandidateFinance({
      db,
      candidateId: "candidate-1",
      electionId: "election-1",
      candidateName: "Bill Lee",
      electionYear: 2022,
      officeName: "Governor",
      campCandidateId: "6496",
      ownerName: "LEE, BILL",
      contributions: [contribution()],
      expenditures: [expenditure()],
      // Cap of 1: the smaller NASHVILLE BANK PAC donor must be dropped from
      // the WRITTEN donor rows, yet still feed the classifications and the
      // rebuilt finance_investment industry total.
      outsideMaxBreakdownsPerCategory: 1,
      outsideGroupContributionRecords: [
        contribution({
          amount: 50_000,
          recipientName: "RIGHT TENNESSEE",
          contributorName: "TENNESSEE BANK PAC",
          contributorOccupation: null,
          contributorEmployer: null,
        }),
        contribution({
          amount: 30_000,
          recipientName: "RIGHT TENNESSEE",
          contributorName: "NASHVILLE BANK PAC",
          contributorOccupation: null,
          contributorEmployer: null,
        }),
        // Below the $25k AI floor: rule classification must still run, so
        // this donor feeds the industry total (and the classification
        // rows) despite never being sent to AI.
        contribution({
          amount: 10_000,
          recipientName: "RIGHT TENNESSEE",
          contributorName: "MEMPHIS BANK PAC",
          contributorOccupation: null,
          contributorEmployer: null,
        }),
      ],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    // 1 capped donor row + 1 industry row built from ALL THREE donors.
    expect(result.outsideGroupBreakdownsWritten).toBe(2);
    const breakdownParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("tn_candidate_finance_outside_group_breakdowns"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(breakdownParams).toContain("TENNESSEE BANK PAC");
    expect(breakdownParams).not.toContain("NASHVILLE BANK PAC");
    expect(breakdownParams).not.toContain("MEMPHIS BANK PAC");
    // The rebuilt industry total covers the dropped donors too — including
    // the sub-$25k one.
    expect(breakdownParams).toContain("finance_investment");
    expect(breakdownParams).toContain(90_000);
    // All three donors persisted classification rows.
    const classificationParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(classificationParams).toContain("TENNESSEE BANK PAC");
    expect(classificationParams).toContain("NASHVILLE BANK PAC");
    expect(classificationParams).toContain("MEMPHIS BANK PAC");
  });

  it("preserves unknown outside totals as null when outside spending data is absent", async () => {
    const db = createMockDb();

    await syncTennesseeCandidateFinance({
      db,
      candidateId: "candidate-1",
      electionId: "election-1",
      candidateName: "Bill Lee",
      electionYear: 2022,
      officeName: "Governor",
      campCandidateId: "6496",
      ownerName: "LEE, BILL",
      contributions: [contribution()],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]?.slice(4, 6)).toEqual([null, null]);
    expect(summaryCall?.[1]?.slice(8, 10)).toEqual([false, false]);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside"))).toBe(false);
  });

  it("does not clear outside evidence from an empty discovery search or its empty donor search", async () => {
    const db = createMockDb();
    await syncTennesseeCandidateFinance({
      db, candidateId: "candidate-1", electionId: "election-1", candidateName: "Bill Lee",
      electionYear: 2022, officeName: "Governor", campCandidateId: "6496", ownerName: "LEE, BILL",
      contributions: [contribution()], expenditures: [], outsideGroupContributionRecords: [],
    });
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tn_candidate_finance_outside"))).toBe(false);
    const summaryCall = db.query.mock.calls.find(call => String(call[0]).includes("INSERT INTO public.tn_candidate_finance_summaries"));
    expect(summaryCall?.[1]?.slice(8, 10)).toEqual([false, false]);
  });
});
