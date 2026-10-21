import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  write: vi.fn(),
  load: vi.fn(),
}));
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedSource.js",
  () => ({ getNewMexicoReportedSource: mocks.source }),
);
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedStore.js",
  () => ({
    NM_REPORTED_REVISION: "ne-current-native-v1",
    writeNewMexicoReportedComponent: mocks.write,
  }),
);
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedEligibility.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../src/pipeline/newMexicoFinance/newMexicoReportedEligibility.js")
    >()),
    loadNewMexicoReportedReceiver: mocks.load,
  }),
);
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedReceiver.js",
  () => ({
    qualifyNewMexicoReportedReceiver: () => ({ locator: "synthetic-native" }),
  }),
);
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedAggregation.js",
  () => ({
    qualifyNewMexicoReportedContext: () => ({
      detail: { candidateName: "Avery Sample", memberId: "synthetic-member" },
    }),
  }),
);
import {
  listDueNewMexicoReportedFinance,
  syncDueNewMexicoReportedFinance,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedBatchSync.js";
import { NewMexicoReportedSourceError } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedNative.js";
const receiver = {
  linkId: "synthetic-link",
  candidateId: "synthetic-candidate",
  electionId: "synthetic-election",
  electionYear: 2026,
};
function database() {
  const query = vi.fn(async () => ({
      rows: [{ ...receiver, dueComponents: ["committee", "ie"] }],
    })),
    client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  return { query, connect: vi.fn(async () => client), client };
}
beforeEach(() => {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_REPORTED_COMMITTEE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "true");
  mocks.source.mockReset();
  mocks.write.mockReset();
  mocks.load.mockReset();
  mocks.load.mockResolvedValue(receiver);
  mocks.source.mockImplementation(async ({ scope }) => ({
    kind: scope.kind,
    registrations: [],
    receiver: {},
  }));
  mocks.write.mockResolvedValue({ groups: 2, idempotent: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("NewMexico independent native due sync", () => {
  it("keeps both native features off when their flags are absent or the state master is off", async () => {
    vi.stubEnv("NEW_MEXICO_REPORTED_COMMITTEE_ENABLED", undefined);
    vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", undefined);
    const db = database();
    expect(
      (await syncDueNewMexicoReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    vi.stubEnv("NEW_MEXICO_REPORTED_COMMITTEE_ENABLED", "true");
    vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "true");
    vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(
      (await syncDueNewMexicoReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("does nothing, including no DB access, when both default-off gates are off", async () => {
    vi.stubEnv("NEW_MEXICO_REPORTED_COMMITTEE_ENABLED", "false");
    vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "false");
    const db = database();
    expect(
      (await syncDueNewMexicoReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("uses original observation age, independent attempt fairness and a 98-day loser-inclusive closeout", async () => {
    const db = database();
    await listDueNewMexicoReportedFinance({ db: db as never });
    const [sql, values] = db.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("s.source_observed_at<");
    expect(sql).toContain("min(a.last_attempted_at) ASC NULLS FIRST");
    expect(sql).toContain("ce.status<>'withdrawn'");
    expect(sql).not.toContain("'lost'");
    expect(sql).not.toContain("nm_candidate_finance_summaries");
    expect(values.slice(3, 6)).toEqual([98, 730, 7]);
    expect(values[7]).toBe(false);
    await listDueNewMexicoReportedFinance({
      db: db as never,
      forceRawDataRefresh: true,
    });
    expect(
      (db.query.mock.calls[1] as unknown as [string, unknown[]])[1][7],
    ).toBe(true);
  });
  it("re-acquires originals for a held retry and replays saved originals otherwise", async () => {
    const db = database();
    await syncDueNewMexicoReportedFinance({ db: db as never });
    expect(mocks.source).toHaveBeenCalled();
    for (const call of mocks.source.mock.calls)
      expect(call[0]).toMatchObject({ refresh: false });
    mocks.source.mockClear();
    db.query.mockResolvedValue({
      rows: [{ ...receiver, dueComponents: ["committee", "ie"], retry: true }],
    } as never);
    await syncDueNewMexicoReportedFinance({ db: db as never });
    expect(mocks.source).toHaveBeenCalled();
    for (const call of mocks.source.mock.calls)
      expect(call[0]).toMatchObject({ refresh: true });
    expect(mocks.load).toHaveBeenCalledWith(
      expect.anything(),
      receiver.linkId,
      true,
    );
    const [sql] = db.query.mock.calls[0] as unknown as [string];
    expect(sql).toContain('a.last_attempted_at>s.last_synced_at)) "retry"');
  });
  it("commits IE work when committee source acquisition fails", async () => {
    mocks.source.mockImplementation(async ({ scope: { kind } }) => {
      if (kind === "committee")
        throw new NewMexicoReportedSourceError("public_fetch_failed");
      return { kind, registrations: [], receiver: {} };
    });
    const db = database(),
      result = await syncDueNewMexicoReportedFinance({ db: db as never });
    expect(result).toMatchObject({
      attemptedComponents: 2,
      writtenComponents: 1,
      heldComponents: 1,
      holds: { public_fetch_failed: 1 },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        financial: expect.objectContaining({ kind: "ie" }),
      }),
    );
    expect(
      db.client.query.mock.calls.filter((call) => call[0] === "COMMIT"),
    ).toHaveLength(2);
  });
  it("keeps committee success when the separate IE storage transaction fails", async () => {
    mocks.write.mockImplementation(async ({ financial }) => {
      if (financial.kind === "ie") throw Error("synthetic storage failure");
      return { groups: 2, idempotent: false };
    });
    const result = await syncDueNewMexicoReportedFinance({
      db: database() as never,
    });
    expect(result).toMatchObject({
      writtenComponents: 1,
      heldComponents: 1,
      holds: { storage_unavailable: 1 },
    });
  });
  it("records no attempt and acquires no source in a dry run", async () => {
    const db = database(),
      result = await syncDueNewMexicoReportedFinance({
        db: db as never,
        dryRun: true,
      });
    expect(result.selectedCandidates).toBe(1);
    expect(db.connect).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
});
