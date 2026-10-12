import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseRefreshMaineCampaignFinanceRawDataScriptArgs as parseArgs,
  runRefreshMaineCampaignFinanceRawDataScript as run,
} from "../../src/scripts/refreshMaineCampaignFinanceRawData.js";

const captures = vi.hoisted(() => ({ maplight: vi.fn(), legacy: vi.fn() }));
vi.mock(
  "../../src/pipeline/maineFinance/maineMapLightDatasetClient.js",
  () => ({ captureMaineMapLightDatasets: captures.maplight }),
);
vi.mock(
  "../../src/pipeline/maineFinance/maineCfisArtifactCache.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/pipeline/maineFinance/maineCfisArtifactCache.js")
    >()),
    refreshMaineCfisArtifactCache: captures.legacy,
  }),
);
beforeEach(() => {
  captures.maplight.mockReset();
  captures.legacy.mockReset();
});

describe("refreshMaineCampaignFinanceRawData script", () => {
  it("parses CFIS raw-data refresh options", () => {
    expect(
      parseArgs([
        "--filing-year=2026",
        "--artifact-kind=expenditures",
        "--url=https://mainecampaignfinance.com/api/export",
        "--cache-dir=/cache",
        "--timeout-ms=5000",
        "--force",
      ]),
    ).toEqual({
      filingYear: 2026,
      artifactKind: "expenditures",
      url: "https://mainecampaignfinance.com/api/export",
      cacheDir: "/cache",
      timeoutMs: 5000,
      force: true,
    });
  });

  it("defaults to contribution artifacts for the official CSV endpoint", () => {
    expect(parseArgs(["--year=2026"])).toMatchObject({
      filingYear: 2026,
      artifactKind: "contributions",
      url: "https://mainecampaignfinance.com/api/DataDownload/CSVDownloadReport",
    });
  });

  it("parses Maine artifact aliases", () => {
    expect(parseArgs(["--year=2026", "--artifact-kind=CON"])).toMatchObject({
      artifactKind: "contributions",
    });
    expect(parseArgs(["--year=2026", "--artifact-kind=EXP"])).toMatchObject({
      artifactKind: "expenditures",
    });
  });

  it("rejects malformed values", () => {
    expect(() => parseArgs(["--year=2026x"])).toThrow(
      "Invalid --filing-year value: 2026x",
    );
    expect(() => parseArgs(["--timeout-ms=5x"])).toThrow(
      "Invalid --timeout-ms value: 5x",
    );
    expect(() => parseArgs(["--artifact-kind=committees"])).toThrow(
      "Invalid Maine CFIS artifact kind",
    );
    expect(() => parseArgs(["--url=http://example.test/export"])).toThrow(
      "Only https is allowed",
    );
    expect(() => parseArgs(["--url=https://example.test/export"])).toThrow(
      "Invalid --url host",
    );
  });

  it("rejects missing or duplicate values", () => {
    expect(() => parseArgs(["--url"])).toThrow("Missing --url value");
    expect(() => parseArgs(["--year=2026", "--filing-year=2025"])).toThrow(
      "Provide --filing-year at most once",
    );
  });

  it("rejects unknown flags before refreshing raw data", () => {
    expect(() => parseArgs(["--artifact-knd=expenditures"])).toThrow(
      "Unknown Maine CFIS raw data refresh flag",
    );
  });
});

describe("Maine raw refresh --maplight", () => {
  it("selects both publisher datasets with the longer bounded capture timeout", () => {
    expect(
      parseArgs([
        "--maplight",
        "--year=2026",
        "--cache-dir=/temporary/test-cache",
      ]),
    ).toMatchObject({
      maplight: true,
      filingYear: 2026,
      force: false,
      timeoutMs: 60_000,
      cacheDir: "/temporary/test-cache",
    });
    expect(parseArgs(["--year=2026"])).not.toHaveProperty("maplight");
  });
  it.each(
    [
      ["--url=https://mainecampaignfinance.com/api/export"],
      ["--url", "https://mainecampaignfinance.com/api/export"],
      ["--artifact-kind=EXP"],
      ["--artifact-kind", "contributions"],
    ].map((override) => ({ override })),
  )("rejects ignored source overrides in discovery mode %#", ({ override }) => {
    expect(() => parseArgs(["--maplight", ...override])).toThrow(
      "--url and --artifact-kind are not supported",
    );
  });
  it.each(["--maplight=true", "--maplight=false"])(
    "rejects a valued boolean flag %s",
    (flag) => {
      expect(() => parseArgs([flag])).toThrow();
    },
  );
  it.each(
    [
      ["--year=2026x"],
      ["--timeout-ms=60000x"],
      ["--year=2026", "--filing-year=2026"],
      ["--year"],
    ].map((flags) => ({ flags })),
  )("rejects malformed maplight arguments before transport %#", ({ flags }) => {
    expect(() => parseArgs(["--maplight", ...flags])).toThrow();
    expect(captures.maplight).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "dispatches discovery and forwards --force=%s as genuine refresh intent",
    async (force) => {
      const options = parseArgs([
        "--maplight",
        "--year=2026",
        "--cache-dir=/temporary/test-cache",
        "--timeout-ms=2000",
        ...(force ? ["--force"] : []),
      ]);
      captures.maplight.mockResolvedValue({
        status: "unavailable",
        previousCacheVerified: true,
        diagnostic: "Preserve existing source",
      });
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const output = await run({ options, fetchImpl });
      expect(captures.maplight).toHaveBeenCalledOnce();
      expect(captures.maplight).toHaveBeenCalledWith({
        cacheDir: "/temporary/test-cache",
        year: 2026,
        refresh: force,
        timeoutMs: 2000,
        fetchImpl,
      });
      expect(captures.legacy).not.toHaveBeenCalled();
      expect(output).toMatchObject({
        type: "maine_maplight_raw_data_refresh",
        filing_year: 2026,
        status: "unavailable",
        previous_cache_verified: true,
        diagnostic: "Preserve existing source",
      });
      expect(output).not.toHaveProperty("datasets");
    },
  );
  it("reports both captured publication metadata without financial acceptance or old CFIS request", async () => {
    const body = {
      path: "/temporary/test-cache/generation/data.csv",
      bytes: 300,
      sha256: "a".repeat(64),
      reused: true,
    };
    captures.maplight.mockResolvedValue({
      status: "captured",
      capture: {
        directory: "/temporary/test-cache/generation",
        captureDigest: "b".repeat(64),
        capturedAt: "2026-10-12T20:00:00Z",
        selections: {
          all_filers: {
            descriptor: { lastUpdatedRaw: "October 11, 2026 9:59 AM ET" },
            attachment: {
              title: "2026 Transactions - All Filers 10112026 0959AM.csv",
            },
          },
          independent_expenditures: {
            descriptor: { lastUpdatedRaw: "October 11, 2026 9:55 AM ET" },
            attachment: {
              title: "2026 Independent Expenditures 10112026 0955AM.csv",
            },
          },
        },
        datasets: {
          all_filers: body,
          independent_expenditures: { ...body, reused: false },
        },
      },
    });
    const output = await run({
      options: parseArgs(["--maplight", "--year=2026"]),
    });
    expect(output).toMatchObject({
      type: "maine_maplight_raw_data_refresh",
      status: "captured",
      capture_digest: "b".repeat(64),
      datasets: [
        {
          dataset: "all_filers",
          published_as_of: "October 11, 2026 9:59 AM ET",
          bytes: 300,
          reused: true,
        },
        {
          dataset: "independent_expenditures",
          published_as_of: "October 11, 2026 9:55 AM ET",
          reused: false,
        },
      ],
    });
    expect(captures.legacy).not.toHaveBeenCalled();
    expect(output).not.toHaveProperty("financialAuthority");
  });
  it("retains the ordinary legacy refresh dispatcher and timeout without --maplight", async () => {
    captures.legacy.mockResolvedValue({
      status: "refreshed",
      cacheDir: "/temporary/test-cache",
      filePath: "/temporary/test-cache/raw.csv",
      metadataPath: "/temporary/test-cache/meta.json",
      remote: {},
      previous: null,
      current: {},
    });
    const options = parseArgs([
      "--year=2026",
      "--artifact-kind=EXP",
      "--cache-dir=/temporary/test-cache",
      "--timeout-ms=1000",
      "--force",
    ]);
    const output = await run({ options });
    expect(captures.maplight).not.toHaveBeenCalled();
    expect(captures.legacy).toHaveBeenCalledWith(
      expect.objectContaining({
        filingYear: 2026,
        artifactKind: "expenditures",
        force: true,
        timeoutMs: 1000,
        cacheDir: "/temporary/test-cache",
      }),
    );
    expect(output.type).toBe("maine_cfis_raw_data_refresh");
  });
});
