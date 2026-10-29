import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMarylandNativeOutsideObservation } from "../../../src/pipeline/marylandFinance/marylandNativeOutsideObservationLoader.js";
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
function row(amount = 1) {
  return {
    filerRegistrationGuid: id(1),
    transactionGuid: id(2),
    transactionId: 2,
    filingEntityId: 100,
    committeeName: "private committee",
    committeeType: "Independent",
    committeeTypeCode: "IEC",
    electionYear: 2023,
    candidateBallotIssueName: "private target",
    officeSought: "",
    officeSoughtId: null,
    position: "Support",
    positionCode: "STSUPP",
    amountApplied: amount,
    isCandidateActivity: true,
    transactionDate: "2022-12-21T00:00:00",
    transactionAmount: 100,
    expenditureType: "Independent Expenditure",
    expenditureTypeCode: "TIEXP",
    fundType: "Electoral",
    fundTypeCode: "ELECT",
    report: "Private report",
    reportTypeCode: "IEXPR",
    electionCycleId: 12023,
    reportId: 10,
    reportVersionId: 1,
    reportGuId: id(3),
    isActive: true,
    createdDate: "2023-01-01T00:00:00",
    candidateGuid: id(4),
    filedDate: "2023-01-01T00:00:00",
    isAmended: false,
    transactionStatusCode: "FIL",
    transactionVersionID: 1,
    candidateMeasureGuid: id(5),
    parentTransactionGuid: null,
  };
}
const dirs: string[] = [];
async function dir() {
  const d = await mkdtemp(join(tmpdir(), "md-outside-obs-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
function packets(
  options: {
    amounts?: number[];
    cycleChange?: boolean;
    failAllocation?: number;
    reverseKeys?: boolean;
  } = {},
) {
  let allocations = 0,
    cycles = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("GetAllFilingCycleList")) {
      cycles++;
      return new Response(
        JSON.stringify({
          succeeded: true,
          error: null,
          data: [
            {
              value: "12023",
              name:
                options.cycleChange && cycles > 1 ? "2027-2030" : "2023-2026",
              isDefault: true,
            },
          ],
        }),
      );
    }
    expect(String(url)).toBe(
      "https://api-campaignfinance.maryland.gov/api/PublicGrid/GetIndependentExpenditureList",
    );
    expect(JSON.parse(String(init!.body))).toMatchObject({
      pageNumber: 1,
      pageSize: 100,
      sortType: "desc",
    });
    allocations++;
    if (options.failAllocation === allocations)
      return new Response("source failure", { status: 503 });
    const r = row(options.amounts?.[allocations - 1] ?? 1);
    const value =
      options.reverseKeys && allocations === 2
        ? Object.fromEntries(Object.entries(r).reverse())
        : r;
    return new Response(
      JSON.stringify({
        succeeded: true,
        error: null,
        data: { items: [value], totalItems: 1, pageNumber: 0, pageSize: 0 },
      }),
    );
  });
  return {
    fetchImpl,
    get allocations() {
      return allocations;
    },
    get cycles() {
      return cycles;
    },
  };
}
const pointer = (root: string) =>
  join(root, "native-outside/latest-observation.json");
describe(
  "ordinary source-only outside observations",
  { timeout: 30_000 },
  () => {
    it("acquires real closed before/after packets but returns no rows/selectors/money", async () => {
      const rawCacheDir = await dir(),
        p = packets();
      const result = await loadMarylandNativeOutsideObservation({
        electionYears: [2026, 2026],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(result.status).toBe("observed");
      expect(p.allocations).toBe(2);
      expect(p.cycles).toBe(2);
      expect(result.observation).toMatchObject({
        cycleLabel: "2023-2026",
        physicalAllocationCount: 1,
        declaredAllocationCount: 1,
        sourceCaptureCount: 4,
        compatibleElectionYears: [2026],
      });
      const serialized = JSON.stringify(result);
      for (const value of [
        "private target",
        "private committee",
        id(4),
        "amountApplied",
        "electionCycleId",
        "requestBody",
        "rows",
      ])
        expect(serialized).not.toContain(value);
      expect(result.diagnostics).toContain(
        "outside_financial_target_and_current_report_authority_unresolved",
      );
    });
    it("uses genuine saved opening and one new closing without retiming originals", async () => {
      const rawCacheDir = await dir(),
        first = packets();
      const before = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: first.fetchImpl,
      });
      const old = await readFile(
        join(before.observation!.closingDirectory, "captures.private.jsonl"),
        "utf8",
      );
      const second = packets();
      const after = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: second.fetchImpl,
      });
      expect(after.status).toBe("observed");
      expect(second.allocations).toBe(1);
      expect(after.observation!.openingDirectory).toBe(
        before.observation!.closingDirectory,
      );
      expect(
        await readFile(
          join(after.observation!.openingDirectory, "captures.private.jsonl"),
          "utf8",
        ),
      ).toBe(old);
      const fresh = JSON.parse(
        (
          await readFile(
            join(after.observation!.closingDirectory, "captures.private.jsonl"),
            "utf8",
          )
        ).trim(),
      );
      expect(fresh.startedAt >= JSON.parse(old.trim()).completedAt).toBe(true);
    });
    it("refresh bypasses saved opening; a failed refresh preserves original pointer", async () => {
      const rawCacheDir = await dir();
      await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets().fetchImpl,
      });
      const original = await readFile(pointer(rawCacheDir), "utf8"),
        p = packets({ failAllocation: 2 });
      const result = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        refresh: true,
        fetchImpl: p.fetchImpl,
      });
      expect(result.status).toBe("preserve");
      expect(result.observation).toBeUndefined();
      expect(p.allocations).toBe(2);
      expect(await readFile(pointer(rawCacheDir), "utf8")).toBe(original);
    });
    it("restarts at most once using the actual new closing as next opening", async () => {
      const rawCacheDir = await dir(),
        p = packets({ amounts: [1, 2, 2] });
      const r = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(r.status).toBe("observed");
      expect(p.allocations).toBe(3);
      expect(r.observation!.openingDirectory.endsWith("/closing")).toBe(true);
      expect(r.observation!.closingDirectory.endsWith("/closing-restart")).toBe(
        true,
      );
      expect(r.diagnostics).toContain("outside_observation_changed_restarted");
    });
    it("changed-again pair yields no observation but retains exact structurally complete future opening", async () => {
      const rawCacheDir = await dir(),
        p = packets({ amounts: [1, 2, 3] });
      const r = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(r.status).toBe("preserve");
      expect(r.observation).toBeUndefined();
      expect(p.allocations).toBe(3);
      const saved = JSON.parse(await readFile(pointer(rawCacheDir), "utf8"));
      expect(saved.censusDirectory.endsWith("/closing-restart")).toBe(true);
      const original = JSON.parse(
        await readFile(
          join(saved.censusDirectory, "page-0001.original.json"),
          "utf8",
        ),
      );
      expect(original.data.items[0].amountApplied).toBe(3);
    });
    it("canonical full row comparison tolerates key ordering but preserves all field changes", async () => {
      const rawCacheDir = await dir(),
        p = packets({ reverseKeys: true });
      const r = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(r.status).toBe("observed");
      expect(p.allocations).toBe(2);
    });
    it("holds changed lookup cycle after complete allocation closing without updating pointer", async () => {
      const rawCacheDir = await dir();
      await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets().fetchImpl,
      });
      const old = await readFile(pointer(rawCacheDir), "utf8");
      const r = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets({ cycleChange: true }).fetchImpl,
      });
      expect(r.status).toBe("preserve");
      expect(r.diagnostics).toContain("source_cycle_changed");
      expect(await readFile(pointer(rawCacheDir), "utf8")).toBe(old);
    });
    it("selects the published prior cycle for annual reports after default rollover", async () => {
      const p = packets();
      const fetchImpl: typeof fetch = async (url, init) => String(url).endsWith("GetAllFilingCycleList")
        ? new Response(JSON.stringify({succeeded:true,error:null,data:[
          {value:"12023",name:"2023-2026",isDefault:false},
          {value:"12027",name:"2027-2030",isDefault:true}]}))
        : p.fetchImpl(url,init);
      const result = await loadMarylandNativeOutsideObservation({electionYears:[2026],rawCacheDir:await dir(),fetchImpl});
      expect(result.status).toBe("observed");expect(result.observation!.cycleLabel).toBe("2023-2026");
      expect(p.fetchImpl.mock.calls.every(([,init])=>JSON.parse(String(init!.body)).electionCycle==="12023")).toBe(true);
    });
    it("makes no network request for no due elections or incompatible default-cycle year", async () => {
      const p = packets(),
        rawCacheDir = await dir();
      expect(
        (
          await loadMarylandNativeOutsideObservation({
            electionYears: [],
            rawCacheDir,
            fetchImpl: p.fetchImpl,
          })
        ).status,
      ).toBe("preserve");
      expect(p.fetchImpl).not.toHaveBeenCalled();
      const r = await loadMarylandNativeOutsideObservation({
        electionYears: [2030],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(r.diagnostics).toContain(
        "default_cycle_incompatible_with_due_elections",
      );
      expect(p.allocations).toBe(0);
    });
    it("corrupt saved original is held and replaced only by new complete real producer packets", async () => {
      const rawCacheDir = await dir();
      const old = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets().fetchImpl,
      });
      await writeFile(
        join(old.observation!.closingDirectory, "page-0001.original.json"),
        "{}",
      );
      const p = packets(),
        r = await loadMarylandNativeOutsideObservation({
          electionYears: [2026],
          rawCacheDir,
          fetchImpl: p.fetchImpl,
        });
      expect(r.status).toBe("observed");
      expect(r.diagnostics).toContain("saved_outside_observation_unavailable");
      expect(p.allocations).toBe(2);
    });
    it("holds observer rejection with safe diagnostics and no pointer", async () => {
      const rawCacheDir = await dir(),
        r = await loadMarylandNativeOutsideObservation({
          electionYears: [2026],
          rawCacheDir,
          fetchImpl: packets().fetchImpl,
          onCapture: () => {
            throw new Error("private error must not leak");
          },
        });
      expect(r.status).toBe("preserve");
      expect(JSON.stringify(r)).not.toContain("private error");
      await expect(readFile(pointer(rawCacheDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    it("whole timer bounds stuck observer and aggregate request/byte limits cover every phase", async () => {
      const rawCacheDir = await dir();
      let entered!: () => void;
      const observerEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const operation = loadMarylandNativeOutsideObservation({
          electionYears: [2026],
          rawCacheDir,
          fetchImpl: packets().fetchImpl,
          totalTimeoutMs: 1_000,
          onCapture: () => {
            entered();
            return new Promise<void>(() => {});
          },
        });
        await observerEntered;
        await vi.advanceTimersByTimeAsync(1_001);
        const timeout = await operation;
        expect(timeout.status).toBe("preserve");
        expect(timeout.diagnostics).toContain("outside_observation_timeout");
      } finally {
        clock.mockRestore();
        vi.useRealTimers();
      }
      for (const limit of [{ maxRequests: 2 }, { maxTotalBytes: 10 }]) {
        const p = packets(),
          r = await loadMarylandNativeOutsideObservation({
            electionYears: [2026],
            rawCacheDir: await dir(),
            fetchImpl: p.fetchImpl,
            ...limit,
          });
        expect(r.status).toBe("preserve");
        expect(r.observation).toBeUndefined();
      }
    });
    it("cache publication failure emits no observation", async () => {
      const rawCacheDir = await dir();
      await mkdir(join(rawCacheDir, "native-outside"), { mode: 0o700 });
      await mkdir(pointer(rawCacheDir));
      const r = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets().fetchImpl,
      });
      expect(r.status).toBe("preserve");
      expect(r.observation).toBeUndefined();
    });
    it("rejects unsafe saved-cycle permissions and noncanonical pointer timestamps without retiming originals", async () => {
      const rawCacheDir = await dir();
      await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets().fetchImpl,
      });
      const saved = JSON.parse(await readFile(pointer(rawCacheDir), "utf8"));
      const original = await readFile(saved.cycleCapture.outputPath);
      await chmod(saved.cycleCapture.outputPath, 0o644);
      const p = packets();
      const result = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(result.diagnostics).toContain(
        "saved_outside_observation_unavailable",
      );
      expect(p.allocations).toBe(2);
      expect(await readFile(saved.cycleCapture.outputPath)).toEqual(original);
      const next = JSON.parse(await readFile(pointer(rawCacheDir), "utf8"));
      next.cycleCapture.startedAt = next.cycleCapture.startedAt.replace(
        ".000Z",
        "Z",
      );
      if (next.cycleCapture.startedAt.endsWith("Z"))
        next.cycleCapture.startedAt = next.cycleCapture.startedAt.replace(
          /Z$/,
          "+00:00",
        );
      await writeFile(pointer(rawCacheDir), JSON.stringify(next));
      const q = packets();
      const held = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: q.fetchImpl,
      });
      expect(held.diagnostics).toContain(
        "saved_outside_observation_unavailable",
      );
      expect(q.allocations).toBe(2);
    });
    it("preserves every unknown raw field in pair comparison and bounds requests across phases", async () => {
      const rawCacheDir = await dir();
      let allocations = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("GetAllFilingCycleList"))
          return new Response(
            JSON.stringify({
              succeeded: true,
              error: null,
              data: [{ value: "12023", name: "2023-2026", isDefault: true }],
            }),
          );
        allocations++;
        return new Response(
          JSON.stringify({
            succeeded: true,
            error: null,
            data: {
              items: [
                {
                  ...row(),
                  unknownSourceMetadata: allocations === 1 ? "old" : "new",
                },
              ],
              totalItems: 1,
              pageNumber: 0,
              pageSize: 0,
            },
          }),
        );
      });
      const result = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl,
      });
      expect(result.status).toBe("observed");
      expect(allocations).toBe(3);
      expect(result.diagnostics).toContain(
        "outside_observation_changed_restarted",
      );
      const p = packets();
      await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir: await dir(),
        fetchImpl: p.fetchImpl,
        maxRequests: 2,
      });
      expect(p.fetchImpl).toHaveBeenCalledTimes(2);
    });
    it("never pairs internally valid future saved captures with earlier live closings", async () => {
      const rawCacheDir = await dir();
      await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: packets().fetchImpl,
      });
      const old = JSON.parse(await readFile(pointer(rawCacheDir), "utf8"));
      const shift = (s: string) =>
        new Date(Date.parse(s) + 30 * 86400000).toISOString();
      old.cycleCapture.startedAt = shift(old.cycleCapture.startedAt);
      old.cycleCapture.completedAt = shift(old.cycleCapture.completedAt);
      const journal = join(old.censusDirectory, "captures.private.jsonl");
      const captures = (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      for (const c of captures) {
        c.startedAt = shift(c.startedAt);
        c.completedAt = shift(c.completedAt);
      }
      await writeFile(
        journal,
        captures.map((c) => JSON.stringify(c)).join("\n") + "\n",
      );
      await writeFile(pointer(rawCacheDir), JSON.stringify(old));
      const p = packets();
      const result = await loadMarylandNativeOutsideObservation({
        electionYears: [2026],
        rawCacheDir,
        fetchImpl: p.fetchImpl,
      });
      expect(result.status).toBe("observed");
      expect(p.allocations).toBe(2);
      expect(result.diagnostics).toContain(
        "saved_outside_observation_not_prior",
      );
      expect(result.observation!.openingDirectory).not.toBe(
        old.censusDirectory,
      );
    });
  },
);
