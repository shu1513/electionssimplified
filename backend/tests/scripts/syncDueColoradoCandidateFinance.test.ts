import { describe, expect, it } from "vitest";

import {
  parseSyncDueColoradoCandidateFinanceScriptArgs,
  toSyncDueColoradoCandidateFinanceScriptOutput
} from "../../src/scripts/syncDueColoradoCandidateFinance.js";

describe("syncDueColoradoCandidateFinance script", () => {
  it("parses due sync options", () => {
    expect(
      parseSyncDueColoradoCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=5",
        "--stale-after-days",
        "3",
        "--lookback-days=2",
        "--lookahead-days=365",
        "--raw-cache-dir=/tmp/tracer",
        "--raw-zip=/tmp/tracer.zip"
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 5,
      staleAfterDays: 3,
      electionLookbackDays: 2,
      electionLookaheadDays: 365,
      rawCacheDir: "/tmp/tracer",
      rawZipPath: "/tmp/tracer.zip"
    });
  });

  it("parses independent IE controls without requiring a direct ZIP", () => {
    expect(
      parseSyncDueColoradoCandidateFinanceScriptArgs([
        "--ie-only",
        "--refresh-ie",
        "--ie-cache-dir=/tmp/native-co",
        "--ie-link-id=00000000-0000-4000-8000-000000000001"
      ])
    ).toMatchObject({
      ieOnly: true,
      refreshIe: true,
      ieCacheDir: "/tmp/native-co",
      ieLinkId: "00000000-0000-4000-8000-000000000001"
    });
  });
  it("rejects unknown flags instead of silently ignoring typos", () => {
    expect(() => parseSyncDueColoradoCandidateFinanceScriptArgs(["--dryrun"])).toThrow(
      "Unknown Colorado candidate finance due sync flag: --dryrun"
    );
  });
  it("parses native receipt controls independently of IE and direct ZIPs", () => {
    expect(parseSyncDueColoradoCandidateFinanceScriptArgs([
      "--receipts-only", "--refresh-receipts", "--receipts-cache-dir=/tmp/co-receipts",
      "--receipts-link-id=00000000-0000-4000-8000-000000000001"
    ])).toMatchObject({receiptsOnly:true,refreshReceipts:true,receiptsCacheDir:"/tmp/co-receipts",receiptsLinkId:"00000000-0000-4000-8000-000000000001"});
    expect(()=>parseSyncDueColoradoCandidateFinanceScriptArgs(["--ie-only","--receipts-only"])).toThrow("Select only one Colorado finance component");
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() => parseSyncDueColoradoCandidateFinanceScriptArgs(["--max-candidates=9007199254740993"])).toThrow(
      "Invalid --max-candidates value: 9007199254740993"
    );
  });

  it("rejects boolean flags with explicit values", () => {
    expect(() => parseSyncDueColoradoCandidateFinanceScriptArgs(["--dry-run=true"])).toThrow(
      "Boolean flag does not accept a value: --dry-run"
    );
    expect(() => parseSyncDueColoradoCandidateFinanceScriptArgs(["--force=false"])).toThrow(
      "Boolean flag does not accept a value: --force"
    );
  });

  it("includes force in script output for audit logs", () => {
    const output = toSyncDueColoradoCandidateFinanceScriptOutput({
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
      options: {
        dryRun: true,
        force: true,
        maxCandidates: 2
      },
      result: {
        dryRun: true,
        now: "2026-01-02T03:04:05.000Z",
        staleAfterDays: 7,
        maxCandidates: 2,
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
        syncedCandidateCount: 1,
        failedCandidateCount: 1,
        results: []
      }
    });

    expect(output).toMatchObject({
      type: "colorado_candidate_finance_due_sync",
      started_at: "2026-01-02T03:04:05.000Z",
      dry_run: true,
      force: true
    });
    expect(typeof output.ts).toBe("string");
  });
});
