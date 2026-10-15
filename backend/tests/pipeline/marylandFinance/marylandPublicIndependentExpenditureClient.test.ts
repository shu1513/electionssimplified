import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMarylandPublicIndependentExpenditurePost } from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";
import {
  acquireMarylandPublicIndependentExpenditureCensus,
  buildMarylandPublicIndependentExpenditureRequest,
  decodeMarylandPublicIndependentExpenditurePage,
  fetchMarylandPublicIndependentExpenditurePage,
  readMarylandPublicIndependentExpenditureCensus,
} from "../../../src/pipeline/marylandFinance/marylandPublicIndependentExpenditureClient.js";
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const scope = { electionCycle: "12023", pageNumber: 1 };
function row(n = 1, extra: Record<string, unknown> = {}) {
  return {
    filerRegistrationGuid: id(1),
    transactionGuid: id(2),
    transactionId: 2,
    filingEntityId: 100,
    committeeName: "Committee",
    committeeType: "Independent",
    committeeTypeCode: "IEC",
    electionYear: 2026,
    candidateBallotIssueName: "Target",
    officeSought: "",
    officeSoughtId: null,
    position: "Support",
    positionCode: "STSUPP",
    amountApplied: 25.29,
    isCandidateActivity: true,
    transactionDate: "2026-10-01T00:00:00",
    transactionAmount: 100,
    expenditureType: "Independent Expenditure",
    expenditureTypeCode: "TIEXP",
    fundType: "Electoral",
    fundTypeCode: "ELECT",
    report: "Report",
    reportTypeCode: "IEXPR",
    electionCycleId: 12023,
    reportId: 10,
    reportVersionId: 1,
    reportGuId: id(3),
    isActive: true,
    createdDate: "2026-10-02T12:30:45.12",
    candidateGuid: id(4),
    filedDate: "2026-10-02T12:30:45",
    isAmended: false,
    transactionStatusCode: "FIL",
    transactionVersionID: 1,
    candidateMeasureGuid: id(n + 100),
    parentTransactionGuid: null,
    unknownField: { literal: "retained" },
    ...extra,
  };
}
function env(rows = [row()], totalItems = rows.length) {
  return {
    succeeded: true,
    error: null,
    data: { items: rows, totalItems, pageNumber: 0, pageSize: 0 },
  };
}
const dirs: string[] = [];
async function dir() {
  const d = await mkdtemp(join(tmpdir(), "md-ie-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const req = () => buildMarylandPublicIndependentExpenditureRequest(scope);
const fake = (v: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(v)));
async function census(
  total = 101,
  edit?: (p: number, rows: ReturnType<typeof row>[]) => unknown,
) {
  return {
    electionCycle: "12023",
    outputDirectory: join(await dir(), "generation"),
    fetchImpl: vi.fn<typeof fetch>(async (_u, init) => {
      const p = JSON.parse(String(init!.body)).pageNumber;
      const rs = Array.from(
        { length: Math.min(100, Math.max(0, total - (p - 1) * 100)) },
        (_, i) => row((p - 1) * 100 + i + 1),
      );
      return new Response(JSON.stringify(edit ? edit(p, rs) : env(rs, total)));
    }),
  };
}
describe("Maryland saved allocation census", () => {
  async function saved(total = 101) {
    const input = await census(total);
    await acquireMarylandPublicIndependentExpenditureCensus(input);
    const scope = {outputDirectory: input.outputDirectory, electionCycle: input.electionCycle};
    const journalPath = join(input.outputDirectory, "captures.private.jsonl");
    const captures = (await readFile(journalPath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    return {scope, journalPath, captures};
  }
  async function journal(state: Awaited<ReturnType<typeof saved>>) {
    await writeFile(state.journalPath, state.captures.map(c => JSON.stringify(c)).join("\n") + "\n");
  }
  type Saved = Awaited<ReturnType<typeof saved>>;
  it("reopens actual producer originals, preserving parent repeats, editions and original times", async () => {
    const s = await saved();
    const result = await readMarylandPublicIndependentExpenditureCensus(s.scope);
    expect(result).toMatchObject({physicalRows: 101, declaredRows: 101,
      startedAt: s.captures[0].startedAt, completedAt: s.captures[1].completedAt});
    expect(result.captures).toHaveLength(2);
    expect(result.rows).toHaveLength(101);
    expect(result.rows[0]).toMatchObject({unknownField: {literal: "retained"}});
    expect(result).not.toHaveProperty("qualified");
  });
  it("accepts one genuine empty page without granting financial zero", async () => {
    const s = await saved(0);
    const result = await readMarylandPublicIndependentExpenditureCensus(s.scope);
    expect(result).toMatchObject({physicalRows: 0, declaredRows: 0});
    expect(result).not.toHaveProperty("outsideSupportTotal");
  });
  it.each([
    (s: Saved) => {s.captures[0].requestBody.stance = "STSUPP";},
    (s: Saved) => {s.captures[0].requestBody.electionCycle = "12019";},
    (s: Saved) => {s.captures[0].requestBody.extra = true;},
    (s: Saved) => {s.captures[0].requestBody.pageNumber = 2;},
    (s: Saved) => {s.captures[0].url += "?filter=1";},
    (s: Saved) => {s.captures[0].method = "GET";},
    (s: Saved) => {s.captures[0].httpStatus = 403;},
    (s: Saved) => {s.captures[0].bodyComplete = false;},
    (s: Saved) => {s.captures[0].errorCode = "timeout";},
    (s: Saved) => {s.captures[0].outputPath += ".other";},
    (s: Saved) => {s.captures[0].sha256 = "unknown";},
    (s: Saved) => {s.captures[0].byteCount = 4 * 1024 * 1024 + 1;},
    (s: Saved) => {s.captures[0].startedAt = "2026-02-30T00:00:00.000Z";},
    (s: Saved) => {s.captures[0].completedAt = "2020-01-01T00:00:00.000Z";},
    (s: Saved) => {s.captures[1].startedAt = "2020-01-01T00:00:00.000Z";},
    (s: Saved) => {s.captures.reverse();},
  ])("holds incompatible, failed or reordered capture metadata %#", async mutate => {
    const s = await saved(); mutate(s); await journal(s);
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow("invalid_capture");
  });
  it("rejects truncated journals and omitted physical pages", async () => {
    const s = await saved();
    await writeFile(s.journalPath, JSON.stringify(s.captures[0]));
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow("invalid_capture");
    s.captures.pop(); await journal(s);
    await rm(join(s.scope.outputDirectory, "page-0002.original.json"));
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow("count_drift");
  });
  it("refuses unrecorded source pages and public-readable originals", async () => {
    const s = await saved();
    const extra = join(s.scope.outputDirectory, "page-0003.original.json");
    await writeFile(extra, "{}");
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow("invalid_capture");
    await rm(extra);
    await chmod(s.captures[0].outputPath, 0o644);
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow("changed_original");
  });
  it("rejects changed originals despite an advisory success proof", async () => {
    const s = await saved();
    await writeFile(join(s.scope.outputDirectory, "safe-whole-source-proof.json"), '{"complete":true}');
    await writeFile(s.captures[0].outputPath, "{}");
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow("changed_original");
  });
  it.each(["duplicate", "conflict", "count"])("checks complete union %s independently of per-page validity", async kind => {
    const s = await saved();
    const capture = s.captures[1];
    const value = JSON.parse(await readFile(capture.outputPath, "utf8"));
    if (kind === "count") value.data.totalItems = 102;
    else {
      value.data.items[0].candidateMeasureGuid = id(101);
      if (kind === "conflict") value.data.items[0].candidateGuid = id(99);
    }
    const raw = JSON.stringify(value);
    await writeFile(capture.outputPath, raw);
    capture.byteCount = Buffer.byteLength(raw); capture.sha256 = createHash("sha256").update(raw).digest("hex");
    await journal(s);
    await expect(readMarylandPublicIndependentExpenditureCensus(s.scope)).rejects.toThrow(
      kind === "duplicate" ? "duplicate_occurrence" : kind === "conflict" ? "conflicting_allocation" : "invalid_independent_expenditure_page");
  });
});
describe("Maryland allocation facts only", () => {
  it("builds exact20 fields, absent amount/type selectors and no owner", () => {
    expect(Object.keys(req())).toHaveLength(20);
    expect(req()).toMatchObject({
      ReportType: null,
      pageSize: 100,
      sortBy: "TransactionDate",
      sortType: "desc",
      electionYear: null,
    });
    for (const k of [
      "filerRegistrationGuid",
      "amountAppliedMin",
      "amountAppliedMax",
      "expenditureType",
    ])
      expect(req()).not.toHaveProperty(k);
    expect(Object.isFrozen(req())).toBe(true);
  });
  it.each([
    { electionCycle: "0" },
    { electionCycle: 12023 },
    { electionCycle: "9007199254740992" },
    { pageNumber: 0 },
    { pageNumber: 1.5 },
    { stance: null },
    { pageSize: 100 },
  ])("rejects invalid/extended scope %j", (extra) => {
    expect(() =>
      buildMarylandPublicIndependentExpenditureRequest({
        ...scope,
        ...extra,
      } as never),
    ).toThrow("invalid_request");
  });
  it("rejects hidden capture filters without a request", async () => {
    const f = fake(env());
    expect(() =>
      captureMarylandPublicIndependentExpenditurePost(
        { ...req(), amountAppliedMin: 0 } as never,
        { outputPath: join("/tmp", "unused"), fetchImpl: f },
      ),
    ).toThrow("invalid_request");
    expect(f).not.toHaveBeenCalled();
  });
  it("keeps split-parent targets, source-unknown role/stance and historical editions", () => {
    const value = env([
      row(),
      row(2, {
        candidateGuid: null,
        isCandidateActivity: false,
        position: "Unknown",
        positionCode: "UNKNOWN",
        expenditureType: "Other",
        expenditureTypeCode: "OTHER",
        isActive: false,
        isAmended: true,
        amountApplied: -1.01,
      }),
      row(1, { transactionVersionID: 2, reportVersionId: 2 }),
    ]);
    const p = decodeMarylandPublicIndependentExpenditurePage(value, req());
    expect(p.rows).toHaveLength(3);
    expect(p.sourcePageNumber).toBe(0);
    expect(p.rows[1]!.amountApplied).toBe(-1.01);
    value.data.items[0]!.unknownField = { literal: "mutated" };
    expect(p.rows[0]!.unknownField).toEqual({ literal: "retained" });
    expect(p).not.toHaveProperty("current");
    expect(p).not.toHaveProperty("accepted");
  });
  it("holds duplicate occurrence and target change in the same allocation edition", () => {
    for (const rs of [
      [row(), row()],
      [row(), row(1, { candidateGuid: id(9) })],
    ])
      expect(() =>
        decodeMarylandPublicIndependentExpenditurePage(env(rs), req()),
      ).toThrow("invalid_independent_expenditure_page");
  });
  it.each([
    { amountApplied: 0.001 },
    { transactionAmount: 90071992547409.9 },
    { amountApplied: "10" },
    { candidateMeasureGuid: null },
    { candidateGuid: "bad" },
    { reportGuId: undefined },
    { reportVersionId: 0 },
    { transactionVersionID: 1.5 },
    { electionCycleId: 12019 },
    { isActive: 1 },
    { isCandidateActivity: null },
    { transactionDate: "2026-02-30T00:00:00" },
    { filedDate: "2026-10-02T24:00:00" },
    { createdDate: "2026-10-02T12:30:45Z" },
    { positionCode: null },
  ])("holds bad scalar or identity %j", (extra) => {
    expect(() =>
      decodeMarylandPublicIndependentExpenditurePage(
        env([row(1, extra)]),
        req(),
      ),
    ).toThrow("invalid_independent_expenditure_page");
  });
  it("requires exact interior/final counts and zero remains a count fact", () => {
    expect(() =>
      decodeMarylandPublicIndependentExpenditurePage(env([row()], 101), req()),
    ).toThrow();
    const last = buildMarylandPublicIndependentExpenditureRequest({
      ...scope,
      pageNumber: 2,
    });
    expect(
      decodeMarylandPublicIndependentExpenditurePage(env([row()], 101), last)
        .totalItems,
    ).toBe(101);
    expect(() =>
      decodeMarylandPublicIndependentExpenditurePage(env([], 100), last),
    ).toThrow();
    expect(
      decodeMarylandPublicIndependentExpenditurePage(env([], 0), req()).rows,
    ).toEqual([]);
  });
  it("rejects unexpected echoes/source errors", () => {
    const v = env();
    v.data.pageNumber = 9;
    expect(() =>
      decodeMarylandPublicIndependentExpenditurePage(v, req()),
    ).toThrow();
    expect(() =>
      decodeMarylandPublicIndependentExpenditurePage(
        { ...env(), error: "source" },
        req(),
      ),
    ).toThrow();
  });
  it("returns safe counts and original SHA/bytes with no source rows/headers", async () => {
    const raw = JSON.stringify(env());
    const f = vi.fn<typeof fetch>(async () => new Response(raw));
    const result = await fetchMarylandPublicIndependentExpenditurePage({
      ...scope,
      outputPath: join(await dir(), "raw"),
      fetchImpl: f,
    });
    expect(result.physicalCount).toBe(1);
    expect(result).not.toHaveProperty("rows");
    expect(await readFile(result.capture.outputPath, "utf8")).toBe(raw);
    expect(result.capture.sha256).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect((await stat(result.capture.outputPath)).mode & 0o777).toBe(0o600);
    expect(result.capture).not.toHaveProperty("headers");
    expect(f.mock.calls[0]![0]).toBe(
      "https://api-campaignfinance.maryland.gov/api/PublicGrid/GetIndependentExpenditureList",
    );
  });
  it("detects changed originals and protects existing paths", async () => {
    const outputPath = join(await dir(), "raw"),
      f = fake(env());
    await expect(
      fetchMarylandPublicIndependentExpenditurePage({
        ...scope,
        outputPath,
        fetchImpl: f,
        onCapture: async () => {
          await writeFile(outputPath, "{}");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_independent_expenditure_page" });
    await expect(
      fetchMarylandPublicIndependentExpenditurePage({
        ...scope,
        outputPath,
        fetchImpl: f,
      }),
    ).rejects.toMatchObject({ code: "output_exists" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
describe("bounded whole allocation census", () => {
  it("closes100+66 allocations retaining physical parent repeats and all original metadata", async () => {
    const input = await census(166),
      r = await acquireMarylandPublicIndependentExpenditureCensus(input);
    expect(r).toMatchObject({
      declaredRows: 166,
      physicalRows: 166,
      requestedPages: 2,
      completedPages: 2,
    });
    expect(r).not.toHaveProperty("rows");
    const cs = (await readFile(r.journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(cs.map((c) => c.requestBody.pageNumber)).toEqual([1, 2]);
    for (const c of cs) {
      const b = await readFile(c.outputPath);
      expect(c.sha256).toBe(createHash("sha256").update(b).digest("hex"));
      expect(c).not.toHaveProperty("headers");
    }
    expect((await stat(input.outputDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(r.journalPath)).mode & 0o777).toBe(0o600);
  });
  it("holds count drift even when changed total has same physical final cardinality", async () => {
    const input = await census(200, (p, rs) => env(rs, p === 2 ? 201 : 200));
    await expect(
      acquireMarylandPublicIndependentExpenditureCensus(input),
    ).rejects.toMatchObject({ code: "count_drift" });
    expect(
      (
        await readFile(
          join(input.outputDirectory, "captures.private.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n"),
    ).toHaveLength(2);
  });
  it.each([false, true])(
    "holds cross-page duplicate/target conflict %s",
    async (conflict) => {
      const input = await census(101, (p, rs) =>
        env(
          p === 2 ? [row(1, conflict ? { candidateGuid: id(9) } : {})] : rs,
          101,
        ),
      );
      await expect(
        acquireMarylandPublicIndependentExpenditureCensus(input),
      ).rejects.toMatchObject({
        code: conflict ? "conflicting_allocation" : "duplicate_occurrence",
      });
      expect(
        JSON.parse(
          await readFile(
            join(input.outputDirectory, "page-0002.original.json"),
            "utf8",
          ),
        ).data.items,
      ).toHaveLength(1);
    },
  );
  it("holds page cap after retaining page1", async () => {
    const input = await census();
    await expect(
      acquireMarylandPublicIndependentExpenditureCensus({
        ...input,
        maxPages: 1,
      }),
    ).rejects.toMatchObject({ code: "page_limit" });
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retains HTTP error body and does not advance", async () => {
    const input = await census();
    input.fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("source failure", { status: 403 }),
    );
    await expect(
      acquireMarylandPublicIndependentExpenditureCensus(input),
    ).rejects.toMatchObject({ code: "http_status" });
    const c = JSON.parse(
      (
        await readFile(
          join(input.outputDirectory, "captures.private.jsonl"),
          "utf8",
        )
      ).trim(),
    );
    expect(c.httpStatus).toBe(403);
    expect(await readFile(c.outputPath, "utf8")).toBe("source failure");
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retains exact capped bytes on failed whole collection", async () => {
    const input = await census();
    await expect(
      acquireMarylandPublicIndependentExpenditureCensus({
        ...input,
        maxTotalBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "body_limit" });
    const c = JSON.parse(
      (
        await readFile(
          join(input.outputDirectory, "captures.private.jsonl"),
          "utf8",
        )
      ).trim(),
    );
    expect(c.byteCount).toBe(10);
    expect(c.bodyComplete).toBe(false);
  });
  it("callback failure holds but does not lose completed original journal", async () => {
    const input = await census();
    await expect(
      acquireMarylandPublicIndependentExpenditureCensus({
        ...input,
        onCapture: () => {
          throw new Error("private must not leak");
        },
      }),
    ).rejects.toMatchObject({ code: "capture_callback_failed" });
    expect(
      (
        await readFile(
          join(input.outputDirectory, "captures.private.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });
  it.each(["observer", "progress"])(
    "total deadline bounds never-resolving %s",
    async (kind) => {
      const input = await census(1);
      const never = () => new Promise<void>(() => {});
      await expect(
        acquireMarylandPublicIndependentExpenditureCensus({
          ...input,
          totalTimeoutMs: 40,
          ...(kind === "observer"
            ? { onCapture: never }
            : { onProgress: never }),
        }),
      ).rejects.toMatchObject({ code: "census_timeout" });
    },
  );
  it.each([
    { maxPages: 0 },
    { maxPages: 1501 },
    { maxTotalBytes: 1.5 },
    { timeoutMs: 30001 },
    { totalTimeoutMs: 3600001 },
    { maxBytes: 4194305 },
  ])("rejects invalid bound before requests %j", async (extra) => {
    const input = await census();
    await expect(
      acquireMarylandPublicIndependentExpenditureCensus({ ...input, ...extra }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });
});
