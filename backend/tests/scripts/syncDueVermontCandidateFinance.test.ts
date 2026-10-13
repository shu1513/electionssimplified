import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseSyncDueVermontCandidateFinanceScriptArgs,
  createVermontCommitteeCashCaptureSink,
  toSyncDueVermontCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueVermontCandidateFinance.js";

describe("syncDueVermontCandidateFinance script", () => {
  it("parses due-sync flags", () => {
    expect(
      parseSyncDueVermontCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=10",
        "--stale-after-days",
        "3",
        "--lookback-days=2",
        "--lookahead-days=400",
      ]),
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 10,
      staleAfterDays: 3,
      electionLookbackDays: 2,
      electionLookaheadDays: 400,
    });
  });

  it("rejects invalid or repeated positive integer flags", () => {
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs(["--max-candidates=10abc"]),
    ).toThrow("Invalid --max-candidates value");
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs(["--stale-after-days"]),
    ).toThrow("Missing --stale-after-days value");
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs([
        "--max-candidates=10",
        "--max-candidates",
        "20",
      ]),
    ).toThrow("Provide --max-candidates at most once");
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs([
        "--max-candidates=9007199254740993",
      ]),
    ).toThrow("Invalid --max-candidates value: 9007199254740993");
  });

  it("formats script output", () => {
    const output = toSyncDueVermontCandidateFinanceScriptOutput({
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      options: { dryRun: true, force: false },
      result: {
        dryRun: true,
        now: "2026-06-01T00:00:00.000Z",
        staleAfterDays: 7,
        maxCandidates: 25,
        dueCandidateCount: 0,
        selectedCandidateCount: 0,
        syncedCandidateCount: 0,
        failedCandidateCount: 0,
        autoLinkAttemptedCount: 0,
        autoLinkLinkedCount: 0,
        results: [],
      },
    });

    expect(output).toMatchObject({
      type: "vermont_candidate_finance_due_sync",
      started_at: "2026-06-01T00:00:00.000Z",
      dry_run: true,
      result: { selectedCandidateCount: 0 },
    });
  });
});

describe("Vermont isolated cash CLI", () => {
  it("accepts bounded opted-in source flags", () => {
    expect(
      parseSyncDueVermontCandidateFinanceScriptArgs([
        "--committee-cash-only",
        "--refresh",
        "--candidate-id=11111111-1111-4111-8111-111111111111",
        "--raw-cache-dir=/tmp/private-source",
      ]),
    ).toMatchObject({
      committeeCashOnly: true,
      refresh: true,
      candidateId: "11111111-1111-4111-8111-111111111111",
      rawCacheDir: "/tmp/private-source",
    });
  });
  it.each([
    ["--refresh"],
    ["--raw-cache-dir=/tmp/private-source"],
    ["--candidate-id=11111111-1111-4111-8111-111111111111"],
  ])("requires explicit isolation for %j", (flags) => {
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs([flags]),
    ).toThrow("require --committee-cash-only");
  });
  it("rejects malformed/repeated candidate selectors", () => {
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs([
        "--committee-cash-only",
        "--candidate-id=invalid",
      ]),
    ).toThrow("expected UUID");
    expect(() =>
      parseSyncDueVermontCandidateFinanceScriptArgs([
        "--committee-cash-only",
        "--candidate-id=a",
        "--candidate-id=b",
      ]),
    ).toThrow("at most once");
  });
  it("saves original bodies and genuine source times privately while ignoring extra headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-cash-cli-"));
    try {
      const sink = await createVermontCommitteeCashCaptureSink(dir);
      const body = new TextEncoder().encode('{"items":[],"totalItems":0}');
      const capture = {
        url: "https://api.campaignfinance.vermont.gov/api/PublicTransactionDetails/GetContributionsDetails",
        method: "POST",
        requestFields: { pageNumber: 1 },
        httpStatus: 200,
        startedAt: "2026-10-12T12:00:00Z",
        completedAt: "2026-10-12T12:00:01Z",
        sha256: createHash("sha256").update(body).digest("hex"),
        byteCount: body.length,
        body,
        headers: { Cookie: "never serialize" },
      };
      await sink(capture);
      const generation = (await readdir(dir))[0]!,
        base = join(dir, generation);
      const metadata = JSON.parse(
        await readFile(join(base, "000001.json"), "utf8"),
      );
      expect(metadata).toMatchObject({
        startedAt: capture.startedAt,
        completedAt: capture.completedAt,
        sha256: capture.sha256,
        byteCount: body.length,
      });
      expect(metadata).not.toHaveProperty("headers");
      expect(JSON.stringify(metadata)).not.toContain("never serialize");
      expect(await readFile(join(base, "000001.raw"))).toEqual(
        Buffer.from(body),
      );
      expect((await stat(base)).mode & 0o777).toBe(0o700);
      expect((await stat(join(base, "000001.raw"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
