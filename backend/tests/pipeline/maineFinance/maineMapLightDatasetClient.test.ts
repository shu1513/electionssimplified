import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureMaineMapLightDatasets as capture,
  type MaineMapLightDatasetCaptureResult,
} from "../../../src/pipeline/maineFinance/maineMapLightDatasetClient.js";
import {
  MAINE_MAPLIGHT_DATASET_ORIGIN as ORIGIN,
  MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL as GUIDE,
  MAINE_MAPLIGHT_DATASET_CATALOG_URL as CATALOG,
} from "../../../src/pipeline/maineFinance/maineMapLightDatasetCatalog.js";
import { MAINE_MAPLIGHT_ALL_FILER_HEADERS as CASH } from "../../../src/pipeline/maineFinance/maineMapLightAllFilerCsv.js";
import { MAINE_MAPLIGHT_INDEPENDENT_EXPENDITURE_HEADERS as IE } from "../../../src/pipeline/maineFinance/maineMapLightIndependentExpenditureCsv.js";
const sha = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");
const guide = `---\ntitle: "Maine Campaign Finance Datasets"\ncanonical: "${ORIGIN}/space/MESUPPORT/2763390977/Maine%20Campaign%20Finance%20Datasets"\nformat: markdown\n---\n- 2026 Transactions - All Filers | Last Updated: October 11, 2026 9:59 AM ET\n  - \n- 2026 Independent Expenditures | Last Updated: October 11, 2026 9:55 AM ET\n  - \n`;
function csv(headers: readonly string[], values: Record<string, string>) {
  return (
    headers.join(",") +
    "\n" +
    headers.map((k) => values[k] ?? "").join(",") +
    "\n"
  );
}
const ie = Buffer.from(
  csv(IE, {
    "Transaction ID": `a_${"a".repeat(26)}`,
    "Filer ID": `f_${"b".repeat(26)}`,
    "Filer Name": "Example PAC",
    "Transaction Type": "independent_expenditure",
    "Transaction Date": "2026-10-09",
    "Total Transaction Amount": "$100.00",
    Description: "Mail",
    Purpose: "Candidate mail",
    "Candidate Name": "Alex Example",
    "Candidate ID": `f_${"c".repeat(26)}`,
    "Support or Oppose": "support",
    "Amount Spent on Candidate": "$100.00",
  }),
);
const cash = Buffer.from(
  csv(CASH, {
    "Transaction ID": `a_${"d".repeat(26)}`,
    "Filer ID": `f_${"b".repeat(26)}`,
    "Filer Name": "Example PAC",
    "Transaction Type": "contribution - monetary",
    "Transaction Date": "2026-10-09",
    Amount: "$100.00",
    "Contact Type": "political_action_committee",
    "Contact Name": "Example PAC",
  }),
);
const iePath =
  "/rest/api/content/2763390977/child/attachment/att3044048898/download";
const cashPath =
  "/rest/api/content/2763390977/child/attachment/att3044147202/download";
function record(id: string, title: string, size: number) {
  const downloadLink = `/rest/api/content/2763390977/child/attachment/${id}/download`;
  return {
    id,
    title,
    pageId: "2763390977",
    status: "current",
    mediaType: "text/csv",
    fileSize: size,
    version: { number: 1, authorId: "UNEXPORTED_AUTHOR" },
    createdAt: "2026-10-11T14:07:32.106Z",
    downloadLink,
    _links: { download: downloadLink },
  };
}
function catalog(ieBody = ie, cashBody = cash) {
  return {
    results: [
      record(
        "att3044048898",
        "2026 Independent Expenditures 10112026 0955AM.csv",
        ieBody.length,
      ),
      record(
        "att3044147202",
        "2026 Transactions - All Filers 10112026 0959AM.csv",
        cashBody.length,
      ),
    ],
    _links: { base: "https://maplight.atlassian.net/wiki" },
  };
}
function network(
  options: {
    year?: number;
    ieBody?: Buffer;
    cashBody?: Buffer;
    override?: (url: string, phase: number) => Response | undefined;
  } = {},
) {
  let guideCount = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === GUIDE) guideCount++;
    const override = options.override?.(url, guideCount);
    if (override) return override;
    const forYear = (body: string) =>
      body.replaceAll("2026", String(options.year ?? 2026));
    if (url === GUIDE) return new Response(forYear(guide));
    if (url === CATALOG)
      return new Response(
        forYear(JSON.stringify(catalog(options.ieBody, options.cashBody))),
      );
    if (url === ORIGIN + iePath)
      return new Response(
        options.year
          ? forYear((options.ieBody ?? ie).toString())
          : (options.ieBody ?? ie),
      );
    if (url === ORIGIN + cashPath)
      return new Response(
        options.year
          ? forYear((options.cashBody ?? cash).toString())
          : (options.cashBody ?? cash),
      );
    throw new Error("Unexpected request SECRET");
  }) as ReturnType<typeof vi.fn> & typeof fetch;
}
const dirs: string[] = [];
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "maine-maplight-test-"));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
function accepted(result: MaineMapLightDatasetCaptureResult) {
  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error("Test capture failed");
  return result.capture;
}
async function pointer(dir: string, year = 2026) {
  return readFile(join(dir, `current-${year}.json`), "utf8");
}
async function alterManifest(dir: string, alter: (manifest: any) => void) {
  const p = JSON.parse(await pointer(dir));
  const mp = join(dir, p.generation, "manifest.json");
  const m = JSON.parse(await readFile(mp, "utf8"));
  alter(m);
  const raw = JSON.stringify(m);
  await writeFile(mp, raw);
  p.manifestSha256 = sha(raw);
  await writeFile(join(dir, "current-2026.json"), JSON.stringify(p));
}

describe("Maine MapLight ordinary dataset capture", () => {
  it("keeps each year's saved capture available after another year is refreshed", async () => {
    const cacheDir = await temp();
    const first = accepted(
      await capture({ cacheDir, year: 2026, fetchImpl: network() }),
    );
    const second = accepted(
      await capture({
        cacheDir,
        year: 2024,
        fetchImpl: network({ year: 2024 }),
      }),
    );
    const fetchImpl = network();
    expect(
      accepted(
        await capture({ cacheDir, year: 2026, cacheOnly: true, fetchImpl }),
      ),
    ).toEqual(first);
    expect(
      accepted(
        await capture({ cacheDir, year: 2024, cacheOnly: true, fetchImpl }),
      ),
    ).toEqual(second);
    expect(fetchImpl).not.toHaveBeenCalled();
    accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("reuses a verified legacy pointer only for its manifest year without changing source times", async () => {
    const cacheDir = await temp();
    const original = accepted(
      await capture({ cacheDir, year: 2026, fetchImpl: network() }),
    );
    await rename(
      join(cacheDir, "current-2026.json"),
      join(cacheDir, "current.json"),
    );
    const fetchImpl = network();
    expect(
      accepted(
        await capture({ cacheDir, year: 2026, cacheOnly: true, fetchImpl }),
      ),
    ).toEqual(original);
    expect(
      await capture({ cacheDir, year: 2024, cacheOnly: true, fetchImpl }),
    ).toMatchObject({ status: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    accepted(
      await capture({
        cacheDir,
        year: 2024,
        fetchImpl: network({ year: 2024 }),
      }),
    );
    expect(
      accepted(await capture({ cacheDir, year: 2026, cacheOnly: true })),
    ).toEqual(original);
    accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(await pointer(cacheDir)).toBeTruthy();
  });
  it("does not fall back to a legacy pointer when a year-specific pointer is corrupt", async () => {
    const cacheDir = await temp();
    accepted(await capture({ cacheDir, year: 2026, fetchImpl: network() }));
    await writeFile(join(cacheDir, "current.json"), await pointer(cacheDir));
    await writeFile(join(cacheDir, "current-2026.json"), "corrupt");
    expect(
      await capture({ cacheDir, year: 2026, cacheOnly: true }),
    ).toMatchObject({ status: "unavailable" });
  });
  it("captures both physical CSVs, exact source requests, original SHA/bytes and genuine intervals", async () => {
    const cacheDir = await temp(),
      fetchImpl = network(),
      start = Date.now();
    const r = accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    const end = Date.now();
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      GUIDE,
      CATALOG,
      ORIGIN + iePath,
      ORIGIN + cashPath,
      GUIDE,
      CATALOG,
    ]);
    for (const [key, body] of [
      ["independent_expenditures", ie],
      ["all_filers", cash],
    ] as const) {
      const artifact = r.datasets[key];
      expect(await readFile(artifact.path)).toEqual(body);
      expect(artifact.bytes).toBe(body.length);
      expect(artifact.sha256).toBe(sha(body));
      expect(Date.parse(artifact.startedAt)).toBeGreaterThanOrEqual(start);
      expect(Date.parse(artifact.completedAt)).toBeLessThanOrEqual(end);
      expect(Date.parse(artifact.completedAt)).toBeGreaterThanOrEqual(
        Date.parse(artifact.startedAt),
      );
      expect(artifact.reused).toBe(false);
      expect(artifact.publicPath).toBe(
        key === "all_filers" ? cashPath : iePath,
      );
    }
    const raw = await readFile(join(r.directory, "manifest.json"));
    expect(sha(raw)).toBe(r.captureDigest);
    expect(JSON.parse(await pointer(cacheDir)).manifestSha256).toBe(sha(raw));
    expect((await stat(r.directory)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(r.directory)) {
      expect((await stat(join(r.directory, file))).mode & 0o777).toBe(0o600);
    }
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
      });
      expect((init as RequestInit).headers).not.toHaveProperty("Cookie");
    }
    expect(JSON.stringify(r)).not.toContain("UNEXPORTED_AUTHOR");
  });
  it("cacheOnly returns verified original generation/times without any transport or pointer mutation", async () => {
    const cacheDir = await temp();
    const original = accepted(
      await capture({ cacheDir, year: 2026, fetchImpl: network() }),
    );
    const oldPointer = await pointer(cacheDir);
    const fetchImpl = vi.fn(() => {
      throw new Error("Network forbidden");
    }) as unknown as typeof fetch;
    const result = accepted(
      await capture({
        cacheDir,
        year: 2026,
        cacheOnly: true,
        refresh: true,
        fetchImpl,
      }),
    );
    expect(result).toEqual(original);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await pointer(cacheDir)).toBe(oldPointer);
  });
  it("cacheOnly preserves missing/corrupt source as unavailable without repairing or networking", async () => {
    const cacheDir = await temp();
    const fetchImpl = vi.fn(() => {
      throw new Error("Network forbidden");
    }) as unknown as typeof fetch;
    expect(
      await capture({ cacheDir, year: 2026, cacheOnly: true, fetchImpl }),
    ).toMatchObject({ status: "unavailable", previousCacheVerified: false });
    const original = accepted(
      await capture({ cacheDir, year: 2026, fetchImpl: network() }),
    );
    const oldPointer = await pointer(cacheDir);
    await writeFile(original.datasets.all_filers.path, "corrupt source");
    expect(
      await capture({ cacheDir, year: 2026, cacheOnly: true, fetchImpl }),
    ).toMatchObject({ status: "unavailable", previousCacheVerified: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await pointer(cacheDir)).toBe(oldPointer);
    expect(await readFile(original.datasets.all_filers.path, "utf8")).toBe(
      "corrupt source",
    );
  });
  it("reuses saved verified publication bytes but retains original HTTP times", async () => {
    const cacheDir = await temp();
    const first = accepted(
      await capture({ cacheDir, year: 2026, fetchImpl: network() }),
    );
    const fetchImpl = network();
    const second = accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      GUIDE,
      CATALOG,
      GUIDE,
      CATALOG,
    ]);
    expect(second.directory).not.toBe(first.directory);
    for (const key of ["all_filers", "independent_expenditures"] as const) {
      expect(second.datasets[key]).toMatchObject({
        reused: true,
        sha256: first.datasets[key].sha256,
        bytes: first.datasets[key].bytes,
        startedAt: first.datasets[key].startedAt,
        completedAt: first.datasets[key].completedAt,
      });
      expect(await readFile(second.datasets[key].path)).toEqual(
        await readFile(first.datasets[key].path),
      );
    }
  });
  it("reads verified saved cache before the first request", async () => {
    const cacheDir = await temp();
    await capture({ cacheDir, year: 2026, fetchImpl: network() });
    const fetchImpl = vi.fn(async () => {
      await writeFile(
        join(cacheDir, "current-2026.json"),
        "broken after saved read",
      );
      return new Response("blocked", { status: 503 });
    }) as unknown as typeof fetch;
    expect(await capture({ cacheDir, year: 2026, fetchImpl })).toMatchObject({
      status: "unavailable",
      previousCacheVerified: true,
    });
  });
  it("refresh downloads both datasets even when saved selections match", async () => {
    const cacheDir = await temp();
    await capture({ cacheDir, year: 2026, fetchImpl: network() });
    const fetchImpl = network();
    const r = accepted(
      await capture({ cacheDir, year: 2026, refresh: true, fetchImpl }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(r.datasets.all_filers.reused).toBe(false);
    expect(r.datasets.independent_expenditures.reused).toBe(false);
  });
  it("snapshots caller year/cache directory/refresh before asynchronous work", async () => {
    const cacheDir = await temp(),
      other = await temp();
    await capture({ cacheDir, year: 2026, fetchImpl: network() });
    const fetchImpl = network({
      override: () => {
        input.year = 2025;
        input.cacheDir = other;
        input.refresh = false;
        return undefined;
      },
    });
    const input = { cacheDir, year: 2026, refresh: true, fetchImpl };
    const r = accepted(await capture(input));
    expect(r.directory.startsWith(cacheDir)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(r.selections.all_filers.descriptor.year).toBe(2026);
    await expect(pointer(other)).rejects.toThrow();
  });
  it("corrupt saved bytes prevent reuse and require a new whole capture", async () => {
    const cacheDir = await temp();
    const old = accepted(
      await capture({ cacheDir, year: 2026, fetchImpl: network() }),
    );
    await writeFile(old.datasets.all_filers.path, "corrupt bytes");
    const fetchImpl = network();
    const r = accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(r.datasets.all_filers.reused).toBe(false);
    expect(await readFile(r.datasets.all_filers.path)).toEqual(cash);
  });
  it.each(["guide", "catalog", "selection", "csv-schema", "truncated-stream"])(
    "preserves good pointer on fresh %s failure",
    async (failure) => {
      const cacheDir = await temp();
      const old = accepted(
        await capture({ cacheDir, year: 2026, fetchImpl: network() }),
      );
      const oldPointer = await pointer(cacheDir);
      const oldFiles = (await readdir(cacheDir)).sort();
      const bad = Buffer.from(
        cash.toString().replace("Amount,", "WrongHeader,"),
      );
      const fetchImpl = network({
        ...(failure === "csv-schema" ? { cashBody: bad } : {}),
        override: (url, phase) => {
          if (failure === "guide" && phase === 2 && url === GUIDE)
            return new Response("SECRET challenge", { status: 403 });
          if (failure === "catalog" && phase === 2 && url === CATALOG)
            return new Response("<html>SECRET login</html>");
          if (failure === "selection" && phase === 2 && url === CATALOG) {
            const x = catalog();
            x.results[0].version.number = 2;
            return new Response(JSON.stringify(x));
          }
          if (failure === "truncated-stream" && url === ORIGIN + cashPath)
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(cash.subarray(0, 12));
                  c.error(new Error("SECRET storage failure"));
                },
              }),
            );
        },
      });
      const r = await capture({
        cacheDir,
        year: 2026,
        refresh: true,
        fetchImpl,
      });
      expect(r).toMatchObject({
        status: "unavailable",
        previousCacheVerified: true,
      });
      expect(JSON.stringify(r)).not.toContain("SECRET");
      expect(await pointer(cacheDir)).toBe(oldPointer);
      expect((await readdir(cacheDir)).sort()).toEqual(oldFiles);
      expect(
        await readFile(old.datasets.independent_expenditures.path),
      ).toEqual(ie);
    },
  );
  it("rejects truncated quoted CSV EOF even when its byte count matches the catalog", async () => {
    const cacheDir = await temp(),
      bad = Buffer.from(cash.toString().replace("Example PAC", '"Example PAC'));
    expect(
      (
        await capture({
          cacheDir,
          year: 2026,
          fetchImpl: network({ cashBody: bad }),
        })
      ).status,
    ).toBe("unavailable");
    await expect(pointer(cacheDir)).rejects.toThrow();
    expect(await readdir(cacheDir)).toEqual([]);
  });
  it("bounds declared and streamed sizes without changing a good pointer", async () => {
    const cacheDir = await temp();
    await capture({ cacheDir, year: 2026, fetchImpl: network() });
    const old = await pointer(cacheDir);
    expect(
      (
        await capture({
          cacheDir,
          year: 2026,
          refresh: true,
          maxDatasetBytes: Math.min(ie.length, cash.length) - 1,
          fetchImpl: network(),
        })
      ).status,
    ).toBe("unavailable");
    expect(await pointer(cacheDir)).toBe(old);
    const oversize = network({
      override: (url) =>
        url === ORIGIN + iePath
          ? new Response(Buffer.alloc(2000, 65))
          : undefined,
    });
    expect(
      (
        await capture({
          cacheDir,
          year: 2026,
          refresh: true,
          maxDatasetBytes: 1000,
          fetchImpl: oversize,
        })
      ).status,
    ).toBe("unavailable");
    expect(await pointer(cacheDir)).toBe(old);
  });
  it("rejects oversized guide and mismatched selected download path before arbitrary fetch", async () => {
    const cacheDir = await temp();
    const huge = network({
      override: (url) =>
        url === GUIDE ? new Response("x".repeat(1024 * 1024 + 1)) : undefined,
    });
    expect(
      (await capture({ cacheDir, year: 2026, fetchImpl: huge })).status,
    ).toBe("unavailable");
    expect(huge).toHaveBeenCalledTimes(1);
    const wrong = network({
      override: (url) => {
        if (url === CATALOG) {
          const c = catalog();
          c.results[0].downloadLink = "https://private.invalid/SECRET";
          return new Response(JSON.stringify(c));
        }
      },
    });
    expect(
      (await capture({ cacheDir, year: 2026, fetchImpl: wrong })).status,
    ).toBe("unavailable");
    expect(wrong).toHaveBeenCalledTimes(2);
  });
  it("follows actual returned catalog pagination and does not guess a cursor", async () => {
    const cacheDir = await temp(),
      next = CATALOG + "&cursor=observed_cursor",
      rows = Array.from({ length: 250 }, (_, i) =>
        record(`att${i + 1}`, `history ${i}.csv`, 10),
      );
    const fetchImpl = network({
      override: (url) =>
        url === CATALOG
          ? new Response(JSON.stringify({ results: rows, _links: { next } }))
          : url === next
            ? new Response(JSON.stringify(catalog()))
            : undefined,
    });
    accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]) === next),
    ).toHaveLength(2);
  });
  it("pagination budget exhaustion preserves old pointer", async () => {
    const cacheDir = await temp();
    await capture({ cacheDir, year: 2026, fetchImpl: network() });
    const old = await pointer(cacheDir),
      next = CATALOG + "&cursor=observed_cursor",
      rows = Array.from({ length: 250 }, (_, i) =>
        record(`att${i + 1}`, `history ${i}.csv`, 10),
      );
    const fetchImpl = network({
      override: (url) =>
        url === CATALOG
          ? new Response(JSON.stringify({ results: rows, _links: { next } }))
          : undefined,
    });
    expect(
      (await capture({ cacheDir, year: 2026, maxCatalogPages: 1, fetchImpl }))
        .status,
    ).toBe("unavailable");
    expect(await pointer(cacheDir)).toBe(old);
    expect(fetchImpl.mock.calls.some((c) => String(c[0]) === next)).toBe(false);
  });
  it("follows one observed signed public redirect but persists only public starting route", async () => {
    const cacheDir = await temp(),
      signed =
        "https://public-storage.example/object.csv?X-Amz-Signature=SECRET_SIGNATURE&token=SECRET_TOKEN";
    const fetchImpl = network({
      override: (url) =>
        url === ORIGIN + iePath
          ? new Response(null, { status: 302, headers: { location: signed } })
          : url === signed
            ? new Response(ie)
            : undefined,
    });
    const r = accepted(await capture({ cacheDir, year: 2026, fetchImpl }));
    expect(r.datasets.independent_expenditures.redirected).toBe(true);
    expect(r.datasets.independent_expenditures.publicPath).toBe(iePath);
    for (const file of await readdir(r.directory)) {
      expect(await readFile(join(r.directory, file), "utf8")).not.toMatch(
        /SECRET_SIGNATURE|SECRET_TOKEN|X-Amz-Signature|public-storage\.example/,
      );
    }
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
  it.each([
    "https://127.0.0.1/file",
    "https://[::1]/file",
    "https://10.0.0.8/file",
    "https://localhost/file",
    "https://example.internal/file",
    "http://public.example/file",
    "https://user:SECRET@public.example/file",
    "https://public.example/file#SECRET",
  ])(
    "rejects unsafe observed redirect without fetching it %#",
    async (location) => {
      const cacheDir = await temp();
      const fetchImpl = network({
        override: (url) =>
          url === ORIGIN + iePath
            ? new Response(null, { status: 302, headers: { location } })
            : undefined,
      });
      const r = await capture({ cacheDir, year: 2026, fetchImpl });
      expect(r.status).toBe("unavailable");
      expect(fetchImpl.mock.calls.some((c) => String(c[0]) === location)).toBe(
        false,
      );
      expect(JSON.stringify(r)).not.toContain("SECRET");
    },
  );
  it("does not follow catalog redirects or multiple-hop storage redirects", async () => {
    const cacheDir = await temp();
    const fetchImpl = network({
      override: (url) =>
        url === CATALOG
          ? new Response(null, {
              status: 302,
              headers: { location: "https://public.example/catalog" },
            })
          : undefined,
    });
    expect((await capture({ cacheDir, year: 2026, fetchImpl })).status).toBe(
      "unavailable",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const redirect = "https://public.example/data",
      chained = network({
        override: (url) =>
          [ORIGIN + iePath, redirect].includes(url)
            ? new Response(null, {
                status: 302,
                headers: { location: redirect },
              })
            : undefined,
      });
    expect(
      (await capture({ cacheDir, year: 2026, fetchImpl: chained })).status,
    ).toBe("unavailable");
  });
  it.each(["dataset", "guide", "catalog"])(
    "binds saved %s path even with internally consistent manifest SHA",
    async (facet) => {
      const cacheDir = await temp();
      await capture({ cacheDir, year: 2026, fetchImpl: network() });
      await alterManifest(cacheDir, (m) => {
        const a =
          facet === "dataset"
            ? m.datasets.all_filers
            : facet === "guide"
              ? m.openingGuide
              : m.openingCatalog[0];
        a.publicPath =
          "/rest/api/content/2763390977/child/attachment/att999/download";
      });
      const r = await capture({
        cacheDir,
        year: 2026,
        fetchImpl: network({
          override: () => new Response("unavailable", { status: 503 }),
        }),
      });
      expect(r).toMatchObject({
        status: "unavailable",
        previousCacheVerified: false,
      });
    },
  );
  it("rejects invalid UTF-8 financial text instead of replacing it", async () => {
    const cacheDir = await temp(),
      invalid = Buffer.from(ie),
      index = invalid.indexOf(Buffer.from("Candidate mail"));
    invalid[index] = 255;
    expect(
      (
        await capture({
          cacheDir,
          year: 2026,
          fetchImpl: network({ ieBody: invalid }),
        })
      ).status,
    ).toBe("unavailable");
  });
});
