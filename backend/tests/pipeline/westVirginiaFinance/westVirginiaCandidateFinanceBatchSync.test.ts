import { describe, expect, it, vi } from "vitest";
import { syncDueWestVirginiaCandidateFinance } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCandidateFinanceBatchSync.js";
import type { WestVirginiaCandidateFinanceDueRow } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCandidateFinanceDueList.js";
import type { syncWestVirginiaCandidateFinance } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCandidateFinanceSync.js";

function dueRow(entityId: string): WestVirginiaCandidateFinanceDueRow {
  return { candidateId: `candidate-${entityId}`, electionId: "election-2026", candidateName: `Candidate ${entityId}`,
    electionYear: 2026, officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "12",
    entityId, committeeName: `Committee ${entityId}`, linkSource: "cfrs_registry", sourceUrl: null, lastSyncedAt: null };
}

describe("West Virginia candidate finance batch preservation", () => {
  it("records a donor identity failure and continues with a shared cached loader for the next candidate", async () => {
    const rows = [dueRow("1010003610"), dueRow("1010003884")];
    const db = { query: vi.fn(), connect: vi.fn() };
    const log = vi.fn();
    const syncCandidate = vi.fn<typeof syncWestVirginiaCandidateFinance>();
    syncCandidate.mockRejectedValueOnce(new Error("Committee donor identities do not reconcile for 1010003610"));
    syncCandidate.mockResolvedValueOnce({ status: "synced", entityId: "1010003884", pacDonorCount: 2, pacDonorsWritten: 2 } as never);
    const result = await syncDueWestVirginiaCandidateFinance({ db: db as never, autoLinkMissingLinks: false,
      now: new Date("2026-10-11T00:00:00Z"), cacheDir: "/unused-wv-raw-cache", listDueRowsFn: vi.fn(async () => ({ rows, totalDueRows: 2 })), syncCandidateFn: syncCandidate, log });
    expect(result).toMatchObject({ totalDueRows: 2, attempted: 2, succeeded: 1, failed: 1, candidates: [
      { row: rows[0], ok: false, error: "Committee donor identities do not reconcile for 1010003610" },
      { row: rows[1], ok: true, result: { pacDonorsWritten: 2 } },
    ] });
    expect(syncCandidate).toHaveBeenCalledTimes(2);
    expect(syncCandidate.mock.calls[0]![0].loadArtifacts).toBe(syncCandidate.mock.calls[1]![0].loadArtifacts);
    expect(syncCandidate.mock.calls[0]![0].loadArtifacts?.registryRows).toBeTypeOf("function");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Committee donor identities do not reconcile"));
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });
});
