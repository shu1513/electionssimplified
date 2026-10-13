import { describe, expect, it, vi } from "vitest";
import { parseSyncDueSouthCarolinaCandidateFinanceScriptArgs } from "../../../src/scripts/syncDueSouthCarolinaCandidateFinance.js";
import { syncDueSouthCarolinaCandidateFinance } from "../../../src/pipeline/southCarolinaFinance/southCarolinaCandidateFinanceBatchSync.js";

describe("SC scoped genuine refresh", () => {
  it("parses independent flag override, refresh, scope and restricted source directory", () => {
    expect(parseSyncDueSouthCarolinaCandidateFinanceScriptArgs([
      "--force", "--refresh", "--candidate-id=09f72416-21e9-4a08-b172-a6e958d2f660",
      "--election-year", "2026", "--source-cache-dir", "/tmp/sc-test", "--no-auto-link",
    ])).toMatchObject({ force: true, refresh: true, candidateId: "09f72416-21e9-4a08-b172-a6e958d2f660", electionYear: 2026, sourceCacheDir: "/tmp/sc-test", autoLinkMissingLinks: false });
    expect(parseSyncDueSouthCarolinaCandidateFinanceScriptArgs(["--force"]).refresh).toBe(false);
    expect(() => parseSyncDueSouthCarolinaCandidateFinanceScriptArgs(["--candidate-id", "invalid"])).toThrow("UUID");
    expect(() => parseSyncDueSouthCarolinaCandidateFinanceScriptArgs(["--election-year", "3000"])).toThrow("year");
  });
  it("skips unscoped autolinking and passes refresh scopes to the due query", async () => {
    const autoLinkFn = vi.fn();
    const listDueRowsFn = vi.fn().mockResolvedValue({ rows: [], totalDueRows: 0 });
    await syncDueSouthCarolinaCandidateFinance({
      db: { query: vi.fn(), connect: vi.fn() } as never,
      refresh: true, candidateId: "09f72416-21e9-4a08-b172-a6e958d2f660", electionYear: 2026,
      autoLinkFn, listDueRowsFn, log: vi.fn(),
    });
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(listDueRowsFn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ refresh: true, candidateId: "09f72416-21e9-4a08-b172-a6e958d2f660", electionYear: 2026 }));
  });
});
