import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSanFranciscoCommitteeCash } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashAcquisition.js";
import {
  getSanFranciscoCommitteeCashTransactions,
  getSanFranciscoCommitteeCurrentForm460Filings,
  getSanFranciscoCommitteeSummaryRows,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoOpenDataClient.js";
import { qualifySanFranciscoCommitteeCash } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashQualification.js";
vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoOpenDataClient.js",
  () => ({
    getSanFranciscoCommitteeCashTransactions: vi.fn(),
    getSanFranciscoCommitteeCurrentForm460Filings: vi.fn(),
    getSanFranciscoCommitteeSummaryRows: vi.fn(),
  }),
);
vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashQualification.js",
  () => ({ qualifySanFranciscoCommitteeCash: vi.fn() }),
);
const summary = {
  filingNid: "1",
  periodStart: "2025-12-15",
  periodEnd: "2026-09-19",
  contributionsCents: 10000,
} as never;
const filing = {
  filingNid: "1",
  periodStart: "2025-12-15",
  periodEnd: "2026-09-19",
  filingActivityNid: "edition-2",
} as never;
const input = {
  fppcId: "1483804",
  electionYear: 2026,
  expectedSummaryRows: [summary],
};
beforeEach(() => {
  vi.mocked(getSanFranciscoCommitteeSummaryRows)
    .mockReset()
    .mockResolvedValue([summary]);
  vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings)
    .mockReset()
    .mockResolvedValue([filing]);
  vi.mocked(getSanFranciscoCommitteeCashTransactions)
    .mockReset()
    .mockResolvedValue([]);
  vi.mocked(qualifySanFranciscoCommitteeCash)
    .mockReset()
    .mockReturnValue({ positions: [], totalAmountCents: 0 } as never);
});
describe("SF committee cash ordinary acquisition", () => {
  it("brackets financial rows with fresh current context and uses published preparation periods", async () => {
    await expect(
      acquireSanFranciscoCommitteeCash(input),
    ).resolves.toMatchObject({ positions: [] });
    expect(getSanFranciscoCommitteeSummaryRows).toHaveBeenCalledTimes(2);
    expect(getSanFranciscoCommitteeCurrentForm460Filings).toHaveBeenCalledTimes(
      2,
    );
    expect(getSanFranciscoCommitteeCashTransactions).toHaveBeenCalledWith(
      {
        fppcId: "1483804",
        transactionDateFrom: "2025-12-15",
        transactionDateTo: "2026-09-20",
      },
      undefined,
    );
    expect(qualifySanFranciscoCommitteeCash).toHaveBeenCalledWith(
      expect.objectContaining({
        windowStart: "2025-12-15",
        windowEnd: "2026-09-19",
        currentFilings: [filing],
      }),
    );
  });
  it("refuses changed core money before named acquisition", async () => {
    vi.mocked(getSanFranciscoCommitteeSummaryRows).mockResolvedValue([
      { ...(summary as object), contributionsCents: 20000 } as never,
    ]);
    await expect(acquireSanFranciscoCommitteeCash(input)).rejects.toThrow(
      /core summary changed/,
    );
    expect(getSanFranciscoCommitteeCashTransactions).not.toHaveBeenCalled();
  });
  it("refuses a new report edition appearing between opening and closing captures", async () => {
    vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings)
      .mockResolvedValueOnce([filing])
      .mockResolvedValueOnce([
        { ...(filing as object), filingActivityNid: "edition-3" } as never,
      ]);
    await expect(acquireSanFranciscoCommitteeCash(input)).rejects.toThrow(
      /context changed/,
    );
    expect(qualifySanFranciscoCommitteeCash).not.toHaveBeenCalled();
  });
  it("propagates source failure without manufacturing an empty component", async () => {
    vi.mocked(getSanFranciscoCommitteeCashTransactions).mockRejectedValue(
      new Error("HTTP428"),
    );
    await expect(acquireSanFranciscoCommitteeCash(input)).rejects.toThrow(
      "HTTP428",
    );
    expect(qualifySanFranciscoCommitteeCash).not.toHaveBeenCalled();
  });
});
