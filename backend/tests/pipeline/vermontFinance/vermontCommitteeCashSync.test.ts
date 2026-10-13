import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  syncVermontCommitteeCash,
  type VermontCommitteeCashSyncInput,
} from "../../../src/pipeline/vermontFinance/vermontCommitteeCashSync.js";
import type { VermontCommitteeCashContext } from "../../../src/pipeline/vermontFinance/vermontCommitteeCashContext.js";
import type { VermontQualifiedCommitteeCash } from "../../../src/pipeline/vermontFinance/vermontCommitteeCashWriter.js";
const ID = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const CONTEXT: VermontCommitteeCashContext = {
  linkId: ID,
  candidateId: ID,
  electionId: ID,
  electionYear: 2026,
  candidateName: "Person Test",
  receivingFilerName: "TEST, PERSON",
  filerRegistrationGuid: ID,
  entityId: 123,
  officeId: 19,
  officeName: "Governor",
  electionDate: "2026-11-03",
  electionType: "general",
  sourceElectionId: 45,
  sourceElection: { electionId: 45, name: "General Election 2026" },
};
const OBSERVED = new Date("2026-10-12T12:00:00Z");
function harness(prior: unknown[] = []) {
  const query = vi.fn(async () => ({ rows: prior }));
  const connect = vi.fn();
  const db = { query, connect } as unknown as Pick<Pool, "query" | "connect">;
  const load = vi.fn(async () => structuredClone(CONTEXT));
  const phase = {
    queries: { reports: [], contributions: [], expenditures: [] },
    reports: [],
  };
  const acquire = vi.fn(async () => ({
    context: structuredClone(CONTEXT),
    before: phase,
    after: phase,
    observedAt: OBSERVED,
  }));
  const qualified: VermontQualifiedCommitteeCash = {
    status: "qualified",
    positions: [
      {
        committeeId: "reported:TEST PAC",
        committeeName: "Test PAC",
        committeeType: "Political Action Committee",
        amountCents: 50000,
        contributionCount: 1,
        giftTransactions: [
          {
            transactionId: 1,
            transactionVersionId: 1,
            guid: ID,
            reportGuid: REPORT,
            date: "2026-09-01",
            amountCents: 50000,
          },
        ],
        sourceUrl: "https://campaignfinance.vermont.gov/",
      },
    ],
    periodStart: "2024-12-13",
    periodEnd: "2026-09-28",
    reportPeriods: [
      {
        filerReportGuid: REPORT,
        filerReportVersionId: 1,
        periodStart: "2024-12-13",
        periodEnd: "2026-09-28",
        pdfSha256: "a".repeat(64),
      },
    ],
    sourceElectionId: 45,
    monetaryCashCents: 100000,
    unclassifiedCashCents: 10000,
    unclassifiedCashCount: 1,
    captureDigest: "b".repeat(64),
    diagnostics: ["Reported subset"],
  };
  const qualify = vi.fn(() => qualified);
  const store = vi.fn(async () => ({
    linkId: ID,
    captureDigest: qualified.captureDigest,
    positionsWritten: 1,
  }));
  const input: VermontCommitteeCashSyncInput = {
    db,
    candidateId: ID,
    electionId: ID,
    loadContextFn: load,
    acquireFn: acquire as VermontCommitteeCashSyncInput["acquireFn"],
    qualifyFn: qualify,
    storeFn: store,
  };
  return { input, query, connect, load, acquire, qualify, qualified, store };
}
describe("isolated Vermont committee cash sync", () => {
  it("loads exact canonical context and prior periods, acquires paired source then writes actual observed time", async () => {
    const h = harness([
      {
        report_periods: [
          { periodStart: "2024-12-13", periodEnd: "2026-09-28" },
        ],
      },
    ]);
    const capture = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    h.input.onCapture = capture;
    h.input.clientOptions = { fetchImpl, timeoutMs: 90000 };
    await expect(syncVermontCommitteeCash(h.input)).resolves.toMatchObject({
      status: "qualified",
      written: true,
      donorCount: 1,
      contributionCount: 1,
      netCents: 50000,
      cashControlCents: 100000,
      observedAt: OBSERVED.toISOString(),
    });
    expect(h.load).toHaveBeenCalledWith({
      db: h.input.db,
      candidateId: ID,
      electionId: ID,
      clientOptions: { fetchImpl, timeoutMs: 90000 },
    });
    expect(h.query.mock.calls[0]![0]).toContain("SELECT report_periods");
    expect(h.acquire).toHaveBeenCalledWith({
      context: CONTEXT,
      fetchImpl,
      timeoutMs: 90000,
      onCapture: capture,
    });
    expect(h.qualify.mock.calls[0]![0]).toMatchObject({
      priorReportPeriods: [
        { periodStart: "2024-12-13", periodEnd: "2026-09-28" },
      ],
    });
    expect(h.store).toHaveBeenCalledWith({
      db: h.input.db,
      context: CONTEXT,
      qualified: h.qualified,
      observedAt: OBSERVED,
    });
    expect(h.connect).not.toHaveBeenCalled(); // only the isolated writer may start a transaction.
  });
  it("dry run proves source but never invokes writer", async () => {
    const h = harness();
    h.input.dryRun = true;
    await expect(syncVermontCommitteeCash(h.input)).resolves.toMatchObject({
      status: "qualified",
      written: false,
      dryRun: true,
    });
    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.store).not.toHaveBeenCalled();
  });
  it("real qualifier holds incomplete observations without manufacturing zero", async () => {
    const h = harness();
    delete h.input.qualifyFn;
    const result = await syncVermontCommitteeCash(h.input);
    expect(result).toMatchObject({ status: "held", written: false });
    expect(result).not.toHaveProperty("netCents");
    expect(result).not.toHaveProperty("cashControlCents");
    expect(h.store).not.toHaveBeenCalled();
  });
  it.each(["context", "acquisition", "write"])(
    "reports %s failure and does not expose raw private error",
    async (stage) => {
      const h = harness();
      if (stage === "context")
        h.load.mockRejectedValueOnce(new Error("private source field"));
      if (stage === "acquisition")
        h.acquire.mockRejectedValueOnce(new Error("private source field"));
      if (stage === "write")
        h.store.mockRejectedValueOnce(new Error("private source field"));
      const result = await syncVermontCommitteeCash(h.input);
      expect(result).toMatchObject({
        status: "failed",
        written: false,
        failureStage: stage,
      });
      expect(JSON.stringify(result)).not.toContain("private source field");
      if (stage !== "write") expect(h.store).not.toHaveBeenCalled();
    },
  );
  it.each([[], null, [{ periodStart: "2024-12-13" }]])(
    "refuses malformed present prior periods before acquisition %j",
    async (periods) => {
      const h = harness([{ report_periods: periods }]);
      await expect(syncVermontCommitteeCash(h.input)).resolves.toMatchObject({
        status: "failed",
        failureStage: "prior_source",
      });
      expect(h.acquire).not.toHaveBeenCalled();
      expect(h.store).not.toHaveBeenCalled();
    },
  );
  it("writes accepted empty positions and retains an explicit subset scope", async () => {
    const h = harness();
    h.qualified.positions = [];
    await expect(syncVermontCommitteeCash(h.input)).resolves.toMatchObject({
      status: "qualified",
      written: true,
      donorCount: 0,
      netCents: 0,
      diagnostics: ["Reported subset"],
    });
    expect(h.store).toHaveBeenCalledOnce();
  });
});
