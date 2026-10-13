import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMarylandCurrentCycleExportRequest,
  decodeMarylandPublishedFilingCycles,
  downloadMarylandCurrentCycleExport,
  getMarylandCurrentFilingCycles,
  MarylandCurrentCycleExportError,
  type MarylandCurrentCycleCapture,
} from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";

const dirs: string[] = [];
async function path() {
  const d = await mkdtemp(join(tmpdir(), "md-current-source-"));
  dirs.push(d);
  return join(d, "original.raw");
}
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const cycles = () => ({
  succeeded: true,
  error: null,
  data: [
    { value: "12023", name: "2023-2026", isDefault: true, code: null },
    { value: "12019", name: "2019-2022", isDefault: false, code: null },
  ],
});
async function failure(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw Error("expected rejection");
  } catch (e) {
    expect(e).toBeInstanceOf(MarylandCurrentCycleExportError);
    expect((e as MarylandCurrentCycleExportError).code).toBe(code);
    return e as MarylandCurrentCycleExportError;
  }
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("Maryland observed current-cycle export transport", () => {
  it.each([
    ["contributions", "TCOC", "Contributions and Loan Download"],
    ["expenditures", "TEXC", "Expenditure Download Data"],
    ["committees", "TCMC", "Committee Download"],
  ] as const)(
    "uses the exact lowercase current-scope body for %s",
    (kind, code, base) => {
      expect(
        buildMarylandCurrentCycleExportRequest(
          kind,
          new Date(2026, 9, 12, 13, 7),
        ),
      ).toEqual({
        filingYear: "0",
        transactionTypeCode: code,
        type: "CSV",
        fileName: `${base}_10/12/2026, 1:07 PM`,
      });
      expect(
        buildMarylandCurrentCycleExportRequest(
          kind,
          new Date(2026, 9, 12, 0, 0),
        ).fileName,
      ).toMatch(/12:00 AM$/);
    },
  );
  it("rejects invalid date and prototype artifact names before source work", () => {
    expect(() =>
      buildMarylandCurrentCycleExportRequest("contributions", new Date(NaN)),
    ).toThrow(MarylandCurrentCycleExportError);
    expect(() =>
      buildMarylandCurrentCycleExportRequest("__proto__" as never),
    ).toThrow(MarylandCurrentCycleExportError);
  });
  it("retains original signed/legacy byte lexemes, hashes exactly and stores no response headers", async () => {
    const outputPath = await path(),
      bytes = Uint8Array.from([65, 44, 45, 50, 53, 46, 53, 48, 10, 233]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "set-cookie": "not retained",
          "content-length": "999",
          etag: "not retained",
        },
      }),
    );
    const seen: MarylandCurrentCycleCapture[] = [];
    const r = await downloadMarylandCurrentCycleExport({
      artifactKind: "contributions",
      outputPath,
      fetchImpl,
      onCapture: (c) => {
        seen.push(c);
      },
    });
    expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
    expect(r).toMatchObject({
      httpStatus: 200,
      bodyComplete: true,
      errorCode: null,
      byteCount: bytes.length,
      sha256: sha(bytes),
    });
    await expect(stat(outputPath).then((s) => s.mode & 0o777)).resolves.toBe(
      0o600,
    );
    expect(r).not.toHaveProperty("headers");
    expect(r).not.toHaveProperty("etag");
    expect(JSON.stringify(r)).not.toContain("not retained");
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.requestBody)).toBe(true);
    expect(seen).toEqual([r]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://api-campaignfinance.maryland.gov/api/ExportPublicData/GetExportPublicDownloadData",
    );
    expect(JSON.parse(init!.body as string)).toEqual(r.requestBody);
    expect(init!.redirect).toBe("manual");
    expect(new Headers(init!.headers).has("authorization")).toBe(false);
  });
  it("records completion at actual EOF, not request start or the observer callback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date(2026, 9, 12, 13, 7);
    vi.setSystemTime(start);
    const outputPath = await path();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("signed,-25.50\n"));
            },
            pull(c) {
              vi.setSystemTime(start.getTime() + 5000);
              c.close();
            },
          }),
        ),
    );
    const r = await downloadMarylandCurrentCycleExport({
      artifactKind: "contributions",
      outputPath,
      fetchImpl,
      onCapture: () => {
        vi.setSystemTime(start.getTime() + 10000);
      },
    });
    expect(r.startedAt).toBe(start.toISOString());
    expect(r.completedAt).toBe(new Date(start.getTime() + 5000).toISOString());
  });
  it("never fetches, overwrites, unlinks or falls back when the output already exists", async () => {
    const outputPath = await path();
    await writeFile(outputPath, "previous-original", { mode: 0o600 });
    const fetchImpl = vi.fn<typeof fetch>();
    await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "contributions",
        outputPath,
        fetchImpl,
      }),
      "output_exists",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(outputPath, "utf8")).toBe("previous-original");
    expect(await readdir(join(outputPath, ".."))).toEqual(["original.raw"]);
  });
  it("snapshots transport and observer before asynchronous work", async () => {
    const outputPath = await path();
    const originalObserver = vi.fn();
    const replacementObserver = vi.fn();
    const replacementFetch = vi.fn<typeof fetch>();
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("source"));
    const input = {
      artifactKind: "contributions" as const,
      outputPath,
      fetchImpl: originalFetch,
      onCapture: originalObserver,
    };
    const pending = downloadMarylandCurrentCycleExport(input);
    input.fetchImpl = replacementFetch;
    input.onCapture = replacementObserver;
    const captured = await pending;
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(replacementFetch).not.toHaveBeenCalled();
    expect(originalObserver).toHaveBeenCalledTimes(1);
    expect(originalObserver).toHaveBeenCalledWith(captured);
    expect(replacementObserver).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 1024 * 1024 * 1024 + 1])(
    "rejects invalid export byte budget %s before fetch",
    async (maxBytes) => {
      const outputPath = await path(),
        fetchImpl = vi.fn<typeof fetch>();
      await failure(
        downloadMarylandCurrentCycleExport({
          artifactKind: "expenditures",
          outputPath,
          maxBytes,
          fetchImpl,
        }),
        "invalid_request",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it.each([0, 1.5, 120001])("rejects invalid timeout %s", async (timeoutMs) => {
    const outputPath = await path();
    await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "committees",
        outputPath,
        timeoutMs,
        fetchImpl: vi.fn<typeof fetch>(),
      }),
      "invalid_request",
    );
  });
  it("keeps a truthful exact prefix and cancels on the byte cap, without synthetic EOF", async () => {
    const outputPath = await path(),
      cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("ab"));
        c.enqueue(new TextEncoder().encode("cdef"));
      },
      cancel,
    });
    const observed: MarylandCurrentCycleCapture[] = [];
    const e = await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "contributions",
        outputPath,
        maxBytes: 3,
        fetchImpl: async () => new Response(body),
        onCapture: (c) => {
          observed.push(c);
        },
      }),
      "body_limit",
    );
    expect(await readFile(outputPath, "utf8")).toBe("abc");
    expect(e.capture).toMatchObject({
      byteCount: 3,
      sha256: sha("abc"),
      bodyComplete: false,
      errorCode: "body_limit",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([e.capture]);
  });
  it("accepts an exact-cap file only when a genuine next read reaches EOF", async () => {
    const outputPath = await path();
    const r = await downloadMarylandCurrentCycleExport({
      artifactKind: "committees",
      outputPath,
      maxBytes: 3,
      fetchImpl: async () => new Response("abc"),
    });
    expect(r).toMatchObject({
      byteCount: 3,
      bodyComplete: true,
      sha256: sha("abc"),
    });
  });
  it("captures non-2xx original status/body and safely fails instead of activating it", async () => {
    const outputPath = await path();
    const e = await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "expenditures",
        outputPath,
        fetchImpl: async () =>
          new Response("failure-original", { status: 403 }),
      }),
      "http_status",
    );
    expect(e.capture).toMatchObject({
      httpStatus: 403,
      bodyComplete: true,
      sha256: sha("failure-original"),
    });
    expect(await readFile(outputPath, "utf8")).toBe("failure-original");
    expect(e.message).not.toContain("failure-original");
  });
  it("times out pending response headers and retains original empty failure metadata", async () => {
    const outputPath = await path();
    let signal: AbortSignal | undefined;
    const observed: MarylandCurrentCycleCapture[] = [];
    const e = await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "contributions",
        outputPath,
        timeoutMs: 20,
        fetchImpl: async (_u, i) => {
          signal = i?.signal ?? undefined;
          return new Promise(() => {});
        },
        onCapture: (c) => {
          observed.push(c);
        },
      }),
      "timeout",
    );
    expect(signal?.aborted).toBe(true);
    expect(e.capture).toMatchObject({
      httpStatus: null,
      byteCount: 0,
      sha256: sha(""),
      bodyComplete: false,
      errorCode: "timeout",
    });
    expect(observed).toHaveLength(1);
  });
  it("times out a stalled body even if the injected stream ignores the abort signal", async () => {
    const outputPath = await path(),
      cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("prefix"));
      },
      cancel,
    });
    const e = await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "contributions",
        outputPath,
        timeoutMs: 30,
        fetchImpl: async () => new Response(body),
      }),
      "timeout",
    );
    expect(e.capture).toMatchObject({
      httpStatus: 200,
      byteCount: 6,
      bodyComplete: false,
      sha256: sha("prefix"),
    });
    expect(cancel).toHaveBeenCalled();
    expect(await readFile(outputPath, "utf8")).toBe("prefix");
  });
  it("preserves a completed prefix on stream errors with safe diagnostics", async () => {
    const outputPath = await path();
    let once = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!once) {
          once = true;
          c.enqueue(new TextEncoder().encode("prefix"));
        } else c.error(Error("private source text"));
      },
    });
    const e = await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "expenditures",
        outputPath,
        fetchImpl: async () => new Response(body),
      }),
      "body_read_failed",
    );
    expect(e.message).not.toContain("private source text");
    expect(e.capture?.bodyComplete).toBe(false);
    expect(await readFile(outputPath, "utf8")).toBe("prefix");
  });
  it("observer failures propagate with the original complete capture retained", async () => {
    const outputPath = await path();
    const e = await failure(
      downloadMarylandCurrentCycleExport({
        artifactKind: "committees",
        outputPath,
        fetchImpl: async () => new Response("source"),
        onCapture: () => {
          throw Error("private observer diagnostic");
        },
      }),
      "capture_callback_failed",
    );
    expect(e.capture).toMatchObject({
      sha256: sha("source"),
      bodyComplete: true,
      errorCode: null,
    });
    expect(await readFile(outputPath, "utf8")).toBe("source");
    expect(e.message).not.toContain("private observer");
  });
});

describe("Maryland factual default filing cycle lookup", () => {
  it("uses exact POST null and preserves the publisher default instead of selecting max ID", async () => {
    const outputPath = await path(),
      payload = cycles();
    payload.data.reverse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(payload)));
    const r = await getMarylandCurrentFilingCycles({ outputPath, fetchImpl });
    expect(r.defaultCycle).toEqual({
      value: "12023",
      name: "2023-2026",
      isDefault: true,
    });
    expect(r.cycles).toHaveLength(2);
    expect(r.capture.requestBody).toBeNull();
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://api-campaignfinance.maryland.gov/api/PublicLookup/GetAllFilingCycleList",
    );
    expect(fetchImpl.mock.calls[0]![1]!.body).toBe("null");
    expect(r).not.toHaveProperty("current");
    expect(r).not.toHaveProperty("qualified");
  });
  it("returns a changed future default as a literal fact, without granting 2026 authority", () => {
    const d = cycles();
    d.data[0] = {
      value: "12027",
      name: "2027-2030",
      isDefault: true,
      code: null,
    };
    expect(decodeMarylandPublishedFilingCycles(d).defaultCycle.name).toBe(
      "2027-2030",
    );
  });
  it.each([
    "missingDefault",
    "twoDefaults",
    "duplicateValue",
    "numericValue",
    "badRange",
    "missingFlag",
    "failureEnvelope",
  ])("rejects malformed cycle authority %s", (kind) => {
    const d = cycles();
    if (kind === "missingDefault") d.data[0]!.isDefault = false;
    if (kind === "twoDefaults") d.data[1]!.isDefault = true;
    if (kind === "duplicateValue") d.data[1]!.value = d.data[0]!.value;
    if (kind === "numericValue") d.data[0]!.value = 12023 as never;
    if (kind === "badRange") d.data[0]!.name = "2026-2023";
    if (kind === "missingFlag")
      delete (d.data[0] as Partial<(typeof d.data)[0]>).isDefault;
    if (kind === "failureEnvelope") d.succeeded = false;
    expect(() => decodeMarylandPublishedFilingCycles(d)).toThrow(
      MarylandCurrentCycleExportError,
    );
  });
  it("rejects lookup budgets above 4MiB and retains invalid original JSON", async () => {
    const p = await path(),
      fetchImpl = vi.fn<typeof fetch>();
    await failure(
      getMarylandCurrentFilingCycles({
        outputPath: p,
        fetchImpl,
        maxBytes: 4 * 1024 * 1024 + 1,
      }),
      "invalid_request",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    const outputPath = await path();
    const e = await failure(
      getMarylandCurrentFilingCycles({
        outputPath,
        fetchImpl: async () => new Response("not json"),
      }),
      "invalid_cycle_lookup",
    );
    expect(e.capture?.sha256).toBe(sha("not json"));
    expect(await readFile(outputPath, "utf8")).toBe("not json");
  });
  it("checks original bytes against capture integrity before decoding after an observer", async () => {
    const outputPath = await path();
    await failure(
      getMarylandCurrentFilingCycles({
        outputPath,
        fetchImpl: async () => new Response(JSON.stringify(cycles())),
        onCapture: async () => {
          await writeFile(
            outputPath,
            JSON.stringify({
              ...cycles(),
              data: [{ value: "12027", name: "2027-2030", isDefault: true }],
            }),
          );
        },
      }),
      "invalid_cycle_lookup",
    );
  });
});
