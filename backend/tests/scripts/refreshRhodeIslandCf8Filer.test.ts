import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), transport: vi.fn(), acquire: vi.fn(), loadEnv: vi.fn(),
}));
vi.mock("../../src/config/env.js", () => ({ loadProjectEnv: mocks.loadEnv }));
vi.mock("../../src/config/featureFlags.js", () => ({ isRhodeIslandErtsRawDataRefreshEnabled: mocks.enabled }));
vi.mock("../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsClient.js", () => ({ createErtsTransport: mocks.transport }));
vi.mock("../../src/pipeline/rhodeIslandFinance/rhodeIslandCf8FilerCache.js", () => ({ acquireRhodeIslandCf8Filer: mocks.acquire }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

async function runCli() {
  process.argv = [process.execPath, fileURLToPath(new URL("../../src/scripts/refreshRhodeIslandCf8Filer.ts", import.meta.url)),
    "--cycle-year", "2026", "--filer", "Synthetic Filer", "--cache-dir", "/unused/synthetic-cache"];
  vi.spyOn(process, "umask").mockReturnValue(0o022);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../src/scripts/refreshRhodeIslandCf8Filer.js");
  await vi.waitFor(() => expect(stderr).toHaveBeenCalledOnce());
  expect(process.exitCode).toBe(1);
  return JSON.parse(String(stderr.mock.calls[0]![0]));
}

describe("Rhode Island CF8 refresh failure diagnostics", () => {
  it.each([new Error("Rhode Island CF8 cache: current_index_changed"), "upstream_unavailable"])(
    "prints the hold reason and preserves failure status for %s", async error => {
      mocks.enabled.mockReturnValue(true);
      mocks.acquire.mockRejectedValue(error);
      expect(await runCli()).toEqual({ status: "held", previousGenerationPreserved: true,
        reason: error instanceof Error ? error.message : error });
      expect(mocks.acquire).toHaveBeenCalledOnce();
    },
  );
  it("reports the disabled refresh flag before creating a transport or acquiring source", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await runCli()).toEqual({ status: "held", previousGenerationPreserved: true,
      reason: "Rhode Island raw refresh is disabled" });
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});
