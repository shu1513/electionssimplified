import { describe, expect, it, vi } from "vitest";
import { syncDelawareVerifiedCandidateFinance } from "../../../src/pipeline/delawareFinance/delawareVerifiedCandidateFinanceSync.js";
import type { DelawareCandidateFinanceDueRow } from "../../../src/pipeline/delawareFinance/delawareCandidateFinanceDueList.js";

const row: DelawareCandidateFinanceDueRow = {
  candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
  candidateName: "Jane Example", electionYear: 2026, electionDate: "2026-11-03",
  officeScope: "statewide", officeName: "Attorney General", district: "Delaware",
  cfId: "01009999", committeeName: "Friends of Jane", linkSource: "cfrs_portal",
  sourceUrl: "https://cfrs.elections.delaware.gov/Public/ViewReceiptsMain", lastSyncedAt: null,
};
function setup(source: object) {
  const db = { query: vi.fn().mockResolvedValue({ rows: [{ outside_report_provenance: { version: 1 } }] }), connect: vi.fn() };
  const loadContextFn = vi.fn().mockResolvedValue({ receivingCfId: row.cfId });
  const loadSourceFn = vi.fn().mockResolvedValue({ outsideEvidence: [], diagnostics: [], ...source });
  const writeSnapshotFn = vi.fn().mockResolvedValue({ linkId: "link", summaryWritten: false, directBreakdownsWritten: 0, outsideGroupsWritten: 0 });
  return { input: { db: db as never, row, loadContextFn, loadSourceFn, writeSnapshotFn }, db, loadContextFn, loadSourceFn, writeSnapshotFn };
}
const cash = { reportedReceiptsCents: 10025, directContributionCents: 9025, reportedExpendituresCents: 2025,
  cashOnHandCents: 8000, debtCents: 1000, sourceProvenance: {} };

describe("ordinary verified Delaware candidate sync", () => {
  it("passes canonical context, saved provenance and refresh into the source loader", async () => {
    const s = setup({ cash });
    await syncDelawareVerifiedCandidateFinance({ ...s.input, refresh: true, cacheDir: "/tmp/de" });
    expect(s.loadSourceFn).toHaveBeenCalledWith(expect.objectContaining({ context: { receivingCfId: row.cfId },
      priorOutsideProvenance: { version: 1 }, refresh: true, cacheDir: "/tmp/de" }));
    expect(s.db.query.mock.calls[0]?.[1]).toEqual([row.candidateId, row.electionId, row.cfId, 2026]);
  });
  it("maps cash independently, preserving sibling accounts and existing charts", async () => {
    const s = setup({ cash });
    const result = await syncDelawareVerifiedCandidateFinance(s.input);
    const written = s.writeSnapshotFn.mock.calls[0]![0];
    expect(written).toMatchObject({ summary: { totalReceipts: 100.25, directContributionTotal: 90.25,
      totalDisbursements: 20.25, cashOnHand: 80 }, linkReplacementPolicy: "retain", link: { district: "Delaware" } });
    expect(written).not.toHaveProperty("directBreakdowns");
    expect(written).not.toHaveProperty("pacEvidence");
    expect(result.directContributionTotal).toBe(90.25);
  });
  it("uses null to preserve unknown Raised while writing accepted cash", async () => {
    const s = setup({ cash: { ...cash, directContributionCents: undefined } });
    await syncDelawareVerifiedCandidateFinance(s.input);
    expect(s.writeSnapshotFn.mock.calls[0]![0].summary.directContributionTotal).toBeNull();
  });
  it("passes PAC and outside authority through one snapshot without requiring cash", async () => {
    const pac = { donors: [], sourceProvenance: { version: 1 } };
    const outsideEvidence = [{ receivingCfId: row.cfId }];
    const s = setup({ pac, outsideEvidence, diagnostics: ["Cash preserved"] });
    const result = await syncDelawareVerifiedCandidateFinance(s.input);
    expect(s.writeSnapshotFn).toHaveBeenCalledTimes(1);
    expect(s.writeSnapshotFn.mock.calls[0]![0]).toMatchObject({ pacEvidence: pac, outsideEvidence, summary: undefined });
    expect(result).toMatchObject({ totalReceipts: null, diagnostics: ["Cash preserved"] });
  });
  it("does not write or fall back to old cache when no source component is accepted", async () => {
    const s = setup({ diagnostics: ["Changed report"] });
    await expect(syncDelawareVerifiedCandidateFinance(s.input)).rejects.toThrow("stored data preserved");
    expect(s.writeSnapshotFn).not.toHaveBeenCalled();
  });
  it("rejects ambiguous prior evidence before acquisition", async () => {
    const s = setup({ cash });
    s.db.query.mockResolvedValue({ rows: [{ outside_report_provenance: {} }, { outside_report_provenance: {} }] });
    await expect(syncDelawareVerifiedCandidateFinance(s.input)).rejects.toThrow("ambiguous prior");
    expect(s.loadSourceFn).not.toHaveBeenCalled();
  });
  it("propagates transaction failures without reporting a successful sync", async () => {
    const s = setup({ cash });
    s.writeSnapshotFn.mockRejectedValue(new Error("transaction rolled back"));
    await expect(syncDelawareVerifiedCandidateFinance(s.input)).rejects.toThrow("transaction rolled back");
  });
});
