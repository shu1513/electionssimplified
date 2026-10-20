import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  write: vi.fn(),
  load: vi.fn(),
}));
vi.mock(
  "../../../src/pipeline/nebraskaFinance/nebraskaReportedSource.js",
  () => ({ getNebraskaReportedSource: mocks.source }),
);
vi.mock(
  "../../../src/pipeline/nebraskaFinance/nebraskaReportedStore.js",
  () => ({
    NE_REPORTED_REVISION: "ne-current-native-v1",
    writeNebraskaReportedComponent: mocks.write,
  }),
);
vi.mock(
  "../../../src/pipeline/nebraskaFinance/nebraskaReportedEligibility.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../src/pipeline/nebraskaFinance/nebraskaReportedEligibility.js")
    >()),
    loadNebraskaReportedReceiver: mocks.load,
  }),
);
import {
  listDueNebraskaReportedFinance,
  syncDueNebraskaReportedFinance,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedBatchSync.js";
import { NebraskaReportedSourceError } from "../../../src/pipeline/nebraskaFinance/nebraskaReportedNative.js";
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
  vi.stubEnv("NEBRASKA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("NEBRASKA_REPORTED_COMMITTEE_ENABLED", "true");
  vi.stubEnv("NEBRASKA_REPORTED_IE_ENABLED", "true");
  mocks.source.mockReset();
  mocks.write.mockReset();
  mocks.load.mockReset();
  mocks.load.mockResolvedValue(receiver);
  mocks.source.mockImplementation(async ({ kind }) => ({ kind }));
  mocks.write.mockResolvedValue({ groups: 2, idempotent: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("Nebraska independent native due sync", () => {
  it("keeps both native features off when their flags are absent or the state master is off", async () => {
    vi.stubEnv("NEBRASKA_REPORTED_COMMITTEE_ENABLED", undefined);
    vi.stubEnv("NEBRASKA_REPORTED_IE_ENABLED", undefined);
    const db = database();
    expect(
      (await syncDueNebraskaReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    vi.stubEnv("NEBRASKA_REPORTED_COMMITTEE_ENABLED", "true");
    vi.stubEnv("NEBRASKA_REPORTED_IE_ENABLED", "true");
    vi.stubEnv("NEBRASKA_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(
      (await syncDueNebraskaReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("does nothing, including no DB access, when both default-off gates are off", async () => {
    vi.stubEnv("NEBRASKA_REPORTED_COMMITTEE_ENABLED", "false");
    vi.stubEnv("NEBRASKA_REPORTED_IE_ENABLED", "false");
    const db = database();
    expect(
      (await syncDueNebraskaReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("uses original observation age, independent attempt fairness and a 98-day loser-inclusive closeout", async () => {
    const db = database();
    await listDueNebraskaReportedFinance({ db: db as never });
    const [sql, values] = db.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("s.source_observed_at<");
    expect(sql).toContain("min(a.last_attempted_at) ASC NULLS FIRST");
    expect(sql).toContain("ce.status<>'withdrawn'");
    expect(sql).not.toContain("'lost'");
    expect(sql).not.toContain("ne_candidate_finance_summaries");
    expect(values.slice(3, 6)).toEqual([98, 730, 7]);
    expect(values[7]).toBe(false);
    await listDueNebraskaReportedFinance({
      db: db as never,
      forceRawDataRefresh: true,
    });
    expect(
      (db.query.mock.calls[1] as unknown as [string, unknown[]])[1][7],
    ).toBe(true);
  });
  it("commits IE work when committee source acquisition fails", async () => {
    mocks.source.mockImplementation(async ({ kind }) => {
      if (kind === "committee")
        throw new NebraskaReportedSourceError("public_fetch_failed");
      return { kind };
    });
    const db = database(),
      result = await syncDueNebraskaReportedFinance({ db: db as never });
    expect(result).toMatchObject({
      attemptedComponents: 2,
      writtenComponents: 1,
      heldComponents: 1,
      holds: { public_fetch_failed: 1 },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ financial: { kind: "ie" } }),
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
    const result = await syncDueNebraskaReportedFinance({
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
      result = await syncDueNebraskaReportedFinance({
        db: db as never,
        dryRun: true,
      });
    expect(result.selectedCandidates).toBe(1);
    expect(db.connect).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
});
