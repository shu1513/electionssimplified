import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMocks = vi.hoisted(() => ({ receipts: vi.fn(), independent: vi.fn() }));
vi.mock("../../src/pipeline/connecticutFinance/connecticutEcrisArtifactCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/pipeline/connecticutFinance/connecticutEcrisArtifactCache.js")>(),
  refreshConnecticutEcrisArtifactCache: refreshMocks.receipts,
}));
vi.mock("../../src/scripts/refreshConnecticutEcrisIndependentExpenditures.js", () => ({
  runRefreshConnecticutEcrisIndependentExpendituresScript: refreshMocks.independent,
}));

import { runRefreshConnecticutEcrisRawDataScript, parseRefreshConnecticutEcrisRawDataScriptArgs } from "../../src/scripts/refreshConnecticutEcrisRawData.js";

describe("refreshConnecticutEcrisRawData script", () => {
  it("parses default candidate receipt CSV refresh options", () => {
    expect(parseRefreshConnecticutEcrisRawDataScriptArgs(["--year=2026"])).toMatchObject({
      year: 2026,
      transactionType: "receipts",
      committeeType: "candidate_exploratory",
      period: "election",
      format: "csv",
      url: "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
      force: false,
      timeoutMs: 30_000,
    });
  });

  it("parses explicit artifact refresh options", () => {
    expect(
      parseRefreshConnecticutEcrisRawDataScriptArgs([
        "--year=2024",
        "--transaction-type=disbursements",
        "--committee-type=party_pac",
        "--period=calendar",
        "--format=xlsx",
        "--url=https://example.test/ct-disbursements.xlsx",
        "--cache-dir=/cache",
        "--timeout-ms=5000",
        "--force",
      ])
    ).toEqual({
      year: 2024,
      transactionType: "disbursements",
      committeeType: "party_pac",
      period: "calendar",
      format: "xlsx",
      url: "https://example.test/ct-disbursements.xlsx",
      cacheDir: "/cache",
      timeoutMs: 5000,
      force: true,
    });
  });

  it("rejects malformed values", () => {
    expect(() => parseRefreshConnecticutEcrisRawDataScriptArgs(["--year=2026x"])).toThrow(
      "Invalid --year value: 2026x"
    );
    expect(() => parseRefreshConnecticutEcrisRawDataScriptArgs(["--year="])).toThrow("Missing --year value");
    expect(() => parseRefreshConnecticutEcrisRawDataScriptArgs(["--url", "   "])).toThrow("Missing --url value");
    expect(() => parseRefreshConnecticutEcrisRawDataScriptArgs(["--timeout-ms=5x"])).toThrow(
      "Invalid --timeout-ms value: 5x"
    );
    expect(() => parseRefreshConnecticutEcrisRawDataScriptArgs(["--url=http://example.test/ct.csv"])).toThrow(
      "Only https is allowed"
    );
    expect(() => parseRefreshConnecticutEcrisRawDataScriptArgs(["--transaction-type=unknown"])).toThrow(
      "Invalid --transaction-type value: unknown"
    );
    expect(() =>
      parseRefreshConnecticutEcrisRawDataScriptArgs([
        "--year=2026",
        "--committee-type=candidate_exploratory",
        "--period=calendar",
      ])
    ).toThrow("candidate/exploratory artifacts use election-year files");
  });
});

describe("candidate receipt refresh includes independent expenditures", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    refreshMocks.receipts.mockResolvedValue({ status: "refreshed", filePath: "/cache/receipts.csv" });
    refreshMocks.independent.mockResolvedValue({ file_path: "/cache/2026_independent_expenditures.json", row_count: 2 });
  });

  it.each(["refreshed", "unchanged"])("refreshes IE when receipts are %s", async (status) => {
    refreshMocks.receipts.mockResolvedValue({ status });
    const options = parseRefreshConnecticutEcrisRawDataScriptArgs(["--year=2026", "--cache-dir=/cache"]);
    const now = new Date("2026-10-11T12:00:00Z");
    const output = await runRefreshConnecticutEcrisRawDataScript({ options, now });
    expect(refreshMocks.independent).toHaveBeenCalledWith({ options, fetchImpl: undefined, now });
    expect(output).toMatchObject({ status, independent_expenditures: { status: "refreshed", row_count: 2 } });
  });

  it("reports failed IE without losing successful receipts", async () => {
    refreshMocks.independent.mockRejectedValue(new Error("HTTP 503"));
    const output = await runRefreshConnecticutEcrisRawDataScript({
      options: parseRefreshConnecticutEcrisRawDataScriptArgs(["--year=2026"]),
    });
    expect(output).toMatchObject({
      status: "refreshed", independent_expenditures: { status: "failed", error: "HTTP 503" },
    });
  });

  it.each([
    ["--transaction-type=disbursements"],
    ["--committee-type=party_pac", "--period=calendar"],
  ])("skips IE for noncandidate receipt modes %j", async (...args) => {
    const output = await runRefreshConnecticutEcrisRawDataScript({
      options: parseRefreshConnecticutEcrisRawDataScriptArgs(["--year=2026", ...args]),
    });
    expect(refreshMocks.independent).not.toHaveBeenCalled();
    expect(output.independent_expenditures).toBeNull();
  });

  it("does not fetch IE after a failed receipt refresh", async () => {
    refreshMocks.receipts.mockRejectedValue(new Error("Bad receipt artifact"));
    await expect(runRefreshConnecticutEcrisRawDataScript({
      options: parseRefreshConnecticutEcrisRawDataScriptArgs(["--year=2026"]),
    })).rejects.toThrow("Bad receipt artifact");
    expect(refreshMocks.independent).not.toHaveBeenCalled();
  });
});
