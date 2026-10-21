import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  committee: true,
  ie: true,
  get: vi.fn(),
  write: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../../src/config/featureFlags.js", () => ({
  isVirginiaReportedCommitteeEnabled: () => mocks.committee,
  isVirginiaReportedIeEnabled: () => mocks.ie,
  isVirginiaReportedRawRefreshEnabled: () => false,
}));
vi.mock(
  "../../../src/pipeline/virginiaFinance/virginiaReportedSource.js",
  () => ({
    VirginiaReportedSource: class {
      get = mocks.get;
    },
  }),
);
vi.mock(
  "../../../src/pipeline/virginiaFinance/virginiaReportedStore.js",
  () => ({
    VA_REPORTED_REVISION: "synthetic-v1",
    writeVirginiaReportedComponent: mocks.write,
  }),
);
vi.mock(
  "../../../src/pipeline/virginiaFinance/virginiaReportedEligibility.js",
  () => ({
    VA_REPORTED_SELECT: "synthetic",
    VA_REPORTED_FROM: "FROM synthetic",
    VA_REPORTED_WHERE: "true",
    VA_REPORTED_OFFICES: ["state_lower::State Lower Chamber Legislator"],
    loadVirginiaReportedReceiver: mocks.load,
  }),
);
import { syncDueVirginiaReportedFinance } from "../../../src/pipeline/virginiaFinance/virginiaReportedBatchSync.js";
import { VirginiaReportedSourceError } from "../../../src/pipeline/virginiaFinance/virginiaReportedNative.js";
const receiver = {
  linkId: "synthetic",
  candidateId: "synthetic-person",
  electionId: "synthetic-election",
  electionYear: 2026,
};
function database() {
  const query = vi.fn(async () => ({ rows: [] })),
    release = vi.fn(),
    db = {
      query: vi.fn(async () => ({
        rows: [{ ...receiver, dueComponents: ["committee", "ie"] }],
      })),
      connect: vi.fn(async () => ({ query, release })),
    };
  return { db, query, release };
}
afterEach(() => {
  vi.clearAllMocks();
  mocks.committee = true;
  mocks.ie = true;
});
describe("Virginia independent native batch", () => {
  it("runs IE despite a committee-source failure, with default batch and closeout window", async () => {
    const { db, query } = database();
    mocks.load.mockResolvedValue(receiver);
    mocks.get.mockImplementation(async (_r, kind) => {
      if (kind === "committee")
        throw new VirginiaReportedSourceError("synthetic_receiving_hold");
      return {};
    });
    mocks.write.mockResolvedValue({ groups: 1, idempotent: false });
    const result = await syncDueVirginiaReportedFinance({ db: db as never });
    expect(result).toMatchObject({
      attemptedComponents: 2,
      writtenComponents: 1,
      heldComponents: 1,
      groups: 1,
      holds: { synthetic_receiving_hold: 1 },
    });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.filter((c) =>
        String(c[0]).includes(
          "INSERT INTO public.va_reported_finance_attempts",
        ),
      ),
    ).toHaveLength(2);
    const params = db.query.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe(112);
    expect(params[5]).toBe(7);
    expect(String(db.query.mock.calls[0]![0])).toContain("interval '24 hours'");
  });
  it("does not access DB when both publication flags are off", async () => {
    mocks.committee = false;
    mocks.ie = false;
    const { db } = database();
    expect(
      await syncDueVirginiaReportedFinance({ db: db as never }),
    ).toMatchObject({ enabled: false, writtenComponents: 0 });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("dry run selects without acquisition, attempts or monetary writes", async () => {
    const { db } = database();
    expect(
      await syncDueVirginiaReportedFinance({ db: db as never, dryRun: true }),
    ).toMatchObject({ selectedCandidates: 1, attemptedComponents: 0 });
    expect(db.connect).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rechecks canonical ownership before any acquisition or success write", async () => {
    const { db, query } = database();
    mocks.load.mockResolvedValue({ ...receiver, candidateId: "changed" });
    const r = await syncDueVirginiaReportedFinance({ db: db as never });
    expect(r.heldComponents).toBe(2);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => c[0] === "ROLLBACK")).toBe(true);
  });
});
