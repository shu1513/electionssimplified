import { afterEach, describe, expect, it, vi } from "vitest";

import { syncDueMissouriCandidateFinance } from "../../../src/pipeline/missouriFinance/missouriCandidateFinanceBatchSync.js";

afterEach(() => vi.unstubAllEnvs());

function due(candidate: string, committee: string) {
  return {
    candidate_id: candidate, election_id: `e-${candidate}`, candidate_name: `Candidate ${candidate}`,
    election_year: 2026, election_date: "2026-11-03", office_scope: "state_lower",
    office_name: "State Lower Chamber Legislator", district: "1", committee_id: committee,
    committee_name: `Committee ${committee}`, link_source: "mec_portal", source_url: "https://example.test",
    last_synced_at: null, total_due_rows: "2",
  };
}

describe("syncDueMissouriCandidateFinance", () => {
  it("continues independent IE after recipient exports fail without refreshing old cash", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({ summaryWritten: false, registeredIeGroupsWritten: 1 });
    const result = await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockRejectedValue(new Error("recipient export unavailable")),
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ directArtifactsUnavailable: true, receiptArtifacts: null }));
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
  });

  it("marks both outside readers unavailable after a failed fresh annual acquisition", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({});
    await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      acquireOutsideArtifactsFn: vi.fn().mockRejectedValue(new Error("annual source unavailable")),
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ outsideArtifacts: null, registeredIeArtifacts: null }));
  });

  it("passes independent receipt availability through when explicitly enabled", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({ summaryWritten: false, committeeReceiptGroupsWritten: 1 });
    const result = await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({ receiptArtifactsAvailable: true, directArtifactsAvailable: false,
        expenditureCount: null, directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture" }) as never,
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ directArtifactsUnavailable: true }));
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
  });

  it("does not refresh a stale direct snapshot after only receipts were captured", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] });
    const sync = vi.fn();
    const result = await syncDueMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({ receiptArtifactsAvailable: true,
        directArtifactsAvailable: false, expenditureCount: null,
        directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture" }) as never,
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ syncedCandidateCount: 0, failedCandidateCount: 1 });
  });

  it("refreshes then syncs each due candidate independently", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [due("c1", "C263985"), due("c2", "A233052")] });
    const acquire = vi.fn().mockResolvedValue({});
    const acquireOutside = vi.fn().mockResolvedValue({});
    const sync = vi.fn()
      .mockResolvedValueOnce({ candidateId: "c1" })
      .mockRejectedValueOnce(new Error("bad amendment lineage"));
    const result = await syncDueMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-08-19T00:00:00Z"),
      autoLinkMissingLinks: false,
      acquireArtifactsFn: acquire as never,
      acquireOutsideArtifactsFn: acquireOutside as never,
      syncCandidateFn: sync as never,
      session: {} as never,
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquireOutside).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[3]).toBe(38);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ officeScope: "state_lower" }));
    expect(result).toMatchObject({
      dueCandidateCount: 2, selectedCandidateCount: 2, syncedCandidateCount: 1, failedCandidateCount: 1,
      outsideArtifactYearCount: 1, failedOutsideArtifactYearCount: 0,
    });
    expect(result.results[1]).toMatchObject({ ok: false, error: "bad amendment lineage" });
  });

  it("continues direct candidate sync when the yearly outside refresh fails", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] });
    const sync = vi.fn().mockResolvedValue({ candidateId: "c1" });
    const result = await syncDueMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-08-19T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      acquireOutsideArtifactsFn: vi.fn().mockRejectedValue(new Error("portal unavailable")) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ outsideArtifacts: null }));
    expect(result).toMatchObject({
      syncedCandidateCount: 1, failedCandidateCount: 0,
      outsideArtifactYearCount: 0, failedOutsideArtifactYearCount: 1,
    });
  });
});
