import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncDueColoradoCandidateFinance } from "../../../src/pipeline/coloradoFinance/coloradoCandidateFinanceBatchSync.js";
import { syncDueColoradoReportedIe } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeBatchSync.js";
import { listColoradoIeReceivers } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js";
import { overlayColoradoReportedIe } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeReader.js";
import { validateColoradoIeStored } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeStore.js";
import type {
  BallotLookupFinanceSummary,
  StateFinanceRequestCandidateRow,
  StateFinanceRequestElectionRow,
} from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeBatchSync.js",
  () => ({ syncDueColoradoReportedIe: vi.fn() }),
);
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeReceiver.js",
  async (original) => ({
    ...(await original<object>()),
    listColoradoIeReceivers: vi.fn(),
  }),
);
vi.mock(
  "../../../src/pipeline/coloradoFinance/coloradoReportedIeStore.js",
  async (original) => ({
    ...(await original<object>()),
    validateColoradoIeStored: vi.fn(),
  }),
);
const receiver = {
  linkId: "00000000-0000-4000-8000-000000000001",
  candidateId: "00000000-0000-4000-8000-000000000002",
  electionId: "00000000-0000-4000-8000-000000000003",
  candidateName: "Ada Example",
  fullName: "Ada Example",
  linkCandidateName: "ADA EXAMPLE",
  party: "Democratic",
  officeName: "Governor",
  linkOffice: "Governor",
  linkSource: "manual",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingId: "202600001",
  receivingName: "Example Campaign",
  tracerCandidateId: "202600002",
};
const candidates = [
  { candidate_id: receiver.candidateId, election_id: receiver.electionId },
] as StateFinanceRequestCandidateRow[];
const elections = [
  {
    election_id: receiver.electionId,
    election_date: "2026-11-03",
    state: "CO",
  },
] as StateFinanceRequestElectionRow[];
const key = candidateElectionKey(receiver.candidateId, receiver.electionId);
function stored() {
  const time = new Date().toISOString();
  return {
    link_id: receiver.linkId,
    election_year: 2026,
    candidate_id: receiver.candidateId,
    election_id: receiver.electionId,
    receiver_context: receiver,
    native_identity: { cycleStart: "2022-12-09" },
    source_facts: {
      dataset: { observedAt: time, completedAt: time },
      candidate: { observedAt: time, completedAt: time },
      endDate: "2026-10-22",
    },
    source_observed_at: new Date(time),
    source_completed_at: new Date(time),
    last_synced_at: new Date(time),
    aggregation_controls: { supportCents: 2100, opposeCents: 0 },
    groups: Array.from({ length: 6 }, (_, i) => ({
      key: `EXAMPLE ACTION ${i}`,
      reportedName: `Example Action ${i}`,
      stance: "support",
      amountCents: (i + 1) * 100,
      occurrenceCount: 1,
    })),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const k of [
    "CANDIDATE_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_ENABLED",
    "COLORADO_CAMPAIGN_FINANCE_SYNC_ENABLED",
    "COLORADO_REPORTED_IE_ENABLED",
  ])
    vi.stubEnv(k, "true");
  vi.mocked(listColoradoIeReceivers).mockResolvedValue([receiver]);
});
afterEach(() => vi.unstubAllEnvs());
describe("Colorado IE independent integration", () => {
  it("runs IE-only before any direct due query or missing ZIP discovery", async () => {
    const reportedIe = {
      enabled: true,
      dryRun: false,
      totalDueRows: 1,
      selectedCandidates: 1,
      attemptedComponents: 1,
      writtenComponents: 1,
      idempotentComponents: 0,
      heldComponents: 0,
      groups: 1,
      holds: {},
    };
    vi.mocked(syncDueColoradoReportedIe).mockResolvedValue(reportedIe);
    const query = vi
        .fn()
        .mockRejectedValue(Error("legacy_direct_query_forbidden")),
      connect = vi.fn();
    const result = await syncDueColoradoCandidateFinance({
      db: { query, connect } as never,
      ieOnly: true,
      rawDataZipPath: "/nonexistent.zip",
    });
    expect(result.reportedIe).toEqual(reportedIe);
    expect(query).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
  });
  it("does not let IE-only bypass its component gate", async () => {
    vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
    const query = vi.fn();
    const result = await syncDueColoradoCandidateFinance({
      db: { query } as never,
      ieOnly: true,
    });
    expect(result.reportedIe).toBeUndefined();
    expect(syncDueColoradoReportedIe).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("validates all groups before display limits and works without direct money", async () => {
    const s = stored(),
      query = vi.fn().mockResolvedValue({ rows: [s] });
    const result = await overlayColoradoReportedIe(
      { query } as never,
      new Map(),
      candidates,
      elections,
    );
    expect(validateColoradoIeStored).toHaveBeenCalled();
    expect(
      vi.mocked(validateColoradoIeStored).mock.calls[0]![3].groups,
    ).toHaveLength(6);
    const summary = result.get(key)!;
    expect(summary.direct_campaign.total_raised).toBeNull();
    expect(summary.outside_spending.support_total).toBe(21);
    expect(summary.outside_spending.oppose_total).toBeNull();
    expect(summary.outside_spending.top_supporting_groups).toHaveLength(5);
    expect(summary.outside_spending.outside_coverage_note).toContain(
      "Partial Colorado coverage",
    );
  });
  it("preserves a prior summary when canonical intent changes", async () => {
    const s = stored();
    s.receiver_context = { ...receiver, party: "Republican" };
    const prior = {
        last_synced_at: "2025-01-01",
      } as BallotLookupFinanceSummary,
      map = new Map([[key, prior]]);
    await overlayColoradoReportedIe(
      { query: vi.fn().mockResolvedValue({ rows: [s] }) } as never,
      map,
      candidates,
      elections,
    );
    expect(map.get(key)).toBe(prior);
    expect(validateColoradoIeStored).not.toHaveBeenCalled();
  });
  it("preserves all prior money and clocks when stored closure fails", async () => {
    vi.mocked(validateColoradoIeStored).mockImplementation(() => {
      throw Error("bad_closure");
    });
    const prior = {
        last_synced_at: "2025-01-01",
      } as BallotLookupFinanceSummary,
      map = new Map([[key, prior]]);
    await overlayColoradoReportedIe(
      { query: vi.fn().mockResolvedValue({ rows: [stored()] }) } as never,
      map,
      candidates,
      elections,
    );
    expect(map.get(key)).toBe(prior);
  });
  it("performs no source queries when the component gate is off", async () => {
    vi.stubEnv("COLORADO_REPORTED_IE_ENABLED", "false");
    const query = vi.fn();
    await overlayColoradoReportedIe(
      { query } as never,
      new Map(),
      candidates,
      elections,
    );
    expect(query).not.toHaveBeenCalled();
    expect(listColoradoIeReceivers).not.toHaveBeenCalled();
  });
});
