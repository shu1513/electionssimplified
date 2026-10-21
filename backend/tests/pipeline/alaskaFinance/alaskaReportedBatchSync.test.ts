import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  write: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../../src/pipeline/alaskaFinance/alaskaReportedSource.js", () => ({
  AlaskaReportedSource: class {
    get(receiver: unknown, component: string) {
      return mocks.source({ kind: component });
    }
  },
}));
vi.mock("../../../src/pipeline/alaskaFinance/alaskaReportedStore.js", () => ({
  AK_REPORTED_REVISION: "ak-current-native-v3",
  writeAlaskaReportedComponent: mocks.write,
}));
vi.mock(
  "../../../src/pipeline/alaskaFinance/alaskaReportedEligibility.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../src/pipeline/alaskaFinance/alaskaReportedEligibility.js")
    >()),
    loadAlaskaReportedReceiver: mocks.load,
  }),
);
import {
  listDueAlaskaReportedFinance,
  syncDueAlaskaReportedFinance,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedBatchSync.js";
import { AlaskaReportedSourceError } from "../../../src/pipeline/alaskaFinance/alaskaReportedNative.js";
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
  vi.stubEnv("ALASKA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("ALASKA_REPORTED_COMMITTEE_ENABLED", "true");
  vi.stubEnv("ALASKA_REPORTED_IE_ENABLED", "true");
  mocks.source.mockReset();
  mocks.write.mockReset();
  mocks.load.mockReset();
  mocks.load.mockResolvedValue(receiver);
  mocks.source.mockImplementation(async ({ kind }) => ({ kind }));
  mocks.write.mockResolvedValue({ groups: 2, idempotent: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("Alaska independent native due sync", () => {
  it("keeps both native features off when their flags are absent or the state master is off", async () => {
    vi.stubEnv("ALASKA_REPORTED_COMMITTEE_ENABLED", undefined);
    vi.stubEnv("ALASKA_REPORTED_IE_ENABLED", undefined);
    const db = database();
    expect(
      (await syncDueAlaskaReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    vi.stubEnv("ALASKA_REPORTED_COMMITTEE_ENABLED", "true");
    vi.stubEnv("ALASKA_REPORTED_IE_ENABLED", "true");
    vi.stubEnv("ALASKA_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(
      (await syncDueAlaskaReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("does nothing, including no DB access, when both default-off gates are off", async () => {
    vi.stubEnv("ALASKA_REPORTED_COMMITTEE_ENABLED", "false");
    vi.stubEnv("ALASKA_REPORTED_IE_ENABLED", "false");
    const db = database();
    expect(
      (await syncDueAlaskaReportedFinance({ db: db as never })).enabled,
    ).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("uses original observation age, independent attempt fairness and a 112-day loser-inclusive closeout", async () => {
    const db = database();
    await listDueAlaskaReportedFinance({ db: db as never });
    const [sql, values] = db.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("s.source_observed_at<");
    expect(sql).toContain("min(a.last_attempted_at) ASC NULLS FIRST");
    expect(sql).toContain("ce.status<>'withdrawn'");
    expect(sql).not.toContain("'lost'");
    expect(sql).not.toContain("ak_candidate_finance_summaries");
    expect(values.slice(3, 6)).toEqual([112, 730, 7]);
    expect(values[7]).toBe(false);
    await listDueAlaskaReportedFinance({
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
        throw new AlaskaReportedSourceError("public_fetch_failed");
      return { kind };
    });
    const db = database(),
      result = await syncDueAlaskaReportedFinance({ db: db as never });
    expect(result).toMatchObject({
      attemptedComponents: 2,
      writtenComponents: 1,
      heldComponents: 1,
      holds: { public_fetch_failed: 1 },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ packet: { kind: "ie" } }),
    );
    expect(
      db.client.query.mock.calls.filter((call) => call[0] === "COMMIT"),
    ).toHaveLength(2);
  });
  it("keeps committee success when the separate IE storage transaction fails", async () => {
    mocks.write.mockImplementation(async ({ packet }) => {
      if (packet.kind === "ie") throw Error("synthetic storage failure");
      return { groups: 2, idempotent: false };
    });
    const result = await syncDueAlaskaReportedFinance({
      db: database() as never,
    });
    expect(result).toMatchObject({
      writtenComponents: 1,
      heldComponents: 1,
      holds: { storage_unavailable: 1 },
    });
  });
  it("reports a failed due query instead of throwing", async () => {
    const db = database();
    db.query.mockRejectedValueOnce(new Error("synthetic due query timeout"));
    const result = await syncDueAlaskaReportedFinance({ db: db as never });
    expect(result).toMatchObject({
      enabled: true,
      failure: "synthetic due query timeout",
      attemptedComponents: 0,
    });
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("records no attempt and acquires no source in a dry run", async () => {
    const db = database(),
      result = await syncDueAlaskaReportedFinance({
        db: db as never,
        dryRun: true,
      });
    expect(result.selectedCandidates).toBe(1);
    expect(db.connect).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
  });
});
