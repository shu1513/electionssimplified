import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  pdf: vi.fn(),
  extract: vi.fn(),
  qualify: vi.fn(),
  store: vi.fn(),
}));
vi.mock("../../../src/pipeline/phoenixFinance/phoenixEfilingClient.js", () => ({
  discoverPhoenixReportObservation: mocks.discover,
  fetchPhoenixReportPdf: mocks.pdf,
}));
vi.mock(
  "../../../src/pipeline/phoenixFinance/phoenixReportPdfParser.js",
  () => ({ extractPhoenixPdfPages: mocks.extract }),
);
vi.mock(
  "../../../src/pipeline/phoenixFinance/phoenixCommitteeCashQualification.js",
  () => ({ qualifyPhoenixCommitteeCash: mocks.qualify }),
);
vi.mock(
  "../../../src/pipeline/phoenixFinance/phoenixCommitteeCashWriter.js",
  () => ({ storePhoenixCommitteeCash: mocks.store }),
);
import { syncPhoenixCommitteeCash } from "../../../src/pipeline/phoenixFinance/phoenixCommitteeCashSync.js";

const input = {
  db: {} as never,
  candidateId: "c",
  electionId: "e",
  electionYear: 2026,
  copId: "CAN-25-4",
  committeeName: "Example Committee",
  officeSought: "Council Member District 4",
  portalCycleStart: "2025-04-01",
  portalCycleEnd: "2027-03-31",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.discover.mockResolvedValue({
    grids: {
      contributors: [],
      expenditures: [],
      loans: [],
      noActivityContributors: [],
      noActivityExpenditures: [],
    },
    refs: [{ reportPackageId: "first" }, { reportPackageId: "second" }],
  });
  mocks.pdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.extract.mockResolvedValue([{ pageNumber: 1, lines: [] }]);
  mocks.qualify.mockReturnValue({
    positions: [{ contributionCount: 2, netCents: 3275000 }],
    reportedThrough: "2026-06-30",
    reportPeriods: [],
  });
  mocks.store.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("Phoenix paired committee cash acquisition", () => {
  it("uses closing source completion time rather than delayed processing time", async () => {
    const start = Date.parse("2026-10-13T00:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    let parsed = 0;
    mocks.extract.mockImplementation(async () => {
      vi.setSystemTime(start + ++parsed * 60000);
      return [{ pageNumber: 1, lines: [] }];
    });
    await syncPhoenixCommitteeCash(input);
    expect(mocks.store.mock.calls[0]?.[0].observedAt.toISOString()).toBe("2026-10-13T00:03:00.000Z");
    expect(new Date().toISOString()).toBe("2026-10-13T00:04:00.000Z");
  });

  it("fetches every observed PDF in both genuine phases without cache reuse", async () => {
    const result = await syncPhoenixCommitteeCash({ ...input, dryRun: true });
    expect(mocks.discover).toHaveBeenCalledTimes(2);
    expect(
      mocks.pdf.mock.calls.map(([value]) => value.reportPackageId),
    ).toEqual(["first", "second", "first", "second"]);
    expect(mocks.pdf.mock.calls.every(([value]) => !("cache" in value))).toBe(
      true,
    );
    expect(mocks.qualify).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ reports: expect.any(Array) }),
        after: expect.objectContaining({ reports: expect.any(Array) }),
      }),
    );
    expect(mocks.store).not.toHaveBeenCalled();
    expect(result).toMatchObject({ netCents: 3275000, written: false });
  });

  it("stores only a qualified component with a source digest", async () => {
    await syncPhoenixCommitteeCash(input);
    expect(mocks.store).toHaveBeenCalledWith(
      expect.objectContaining({
        captureDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        observedAt: expect.any(Date),
      }),
    );
  });

  it("preserves stored evidence on a failed closing acquisition", async () => {
    mocks.discover
      .mockResolvedValueOnce({ grids: {}, refs: [] })
      .mockRejectedValueOnce(new Error("source unavailable"));
    await expect(syncPhoenixCommitteeCash(input)).rejects.toThrow(
      "source unavailable",
    );
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("preserves stored evidence when source qualification fails", async () => {
    mocks.qualify.mockImplementation(() => {
      throw new Error("overlapping editions");
    });
    await expect(syncPhoenixCommitteeCash(input)).rejects.toThrow(
      "overlapping editions",
    );
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("checks complete signed net totals before any write", async () => {
    mocks.qualify.mockReturnValue({
      positions: [
        { netCents: Number.MAX_SAFE_INTEGER, contributionCount: 1 },
        { netCents: 1, contributionCount: 1 },
      ],
      reportedThrough: "2026-06-30",
    });
    await expect(syncPhoenixCommitteeCash(input)).rejects.toThrow(
      "Unsafe Phoenix PAC net total",
    );
    expect(mocks.store).not.toHaveBeenCalled();
  });
});
