import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HawaiiReportedHold } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedCore.js";
const mocks = vi.hoisted(() => ({ create: vi.fn(), discard: vi.fn(), list: vi.fn() }));
vi.mock("../../../src/pipeline/hawaiiFinance/hawaiiReportedOriginals.js", async () => ({
  ...await vi.importActual("../../../src/pipeline/hawaiiFinance/hawaiiReportedOriginals.js"),
  createHawaiiOriginalGraph: mocks.create, discardHawaiiOriginalGraph: mocks.discard,
  listHawaiiOriginalDirectories: mocks.list, isHawaiiOriginalGraph: () => true,
}));
import { loadHawaiiReportedPacket } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedSource.js";

afterEach(() => vi.unstubAllEnvs());
describe("Hawaii original capture cache", () => {
  it("discards a capture that fails qualification instead of replaying it on every load", async () => {
    for (const k of ["CANDIDATE_FINANCE_ENABLED", "HAWAII_CAMPAIGN_FINANCE_ENABLED", "HAWAII_REPORTED_RAW_REFRESH_ENABLED"]) vi.stubEnv(k, "true");
    const directory = "/synthetic/source-originals-failed";
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ directory, records: [], read: vi.fn(async () => { throw new HawaiiReportedHold("source_status_or_eof"); }) });
    const codes: string[] = [];
    const packet = await loadHawaiiReportedPacket("ie", { cacheDir: await mkdtemp(join(tmpdir(), "hi-reported-")), onRefreshError: c => codes.push(c) });
    expect(packet).toBeNull(); expect(codes).toEqual(["source_status_or_eof"]);
    expect(mocks.discard).toHaveBeenCalledWith(directory);
  });
});
