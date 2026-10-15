import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, lstat } from "node:fs/promises";
import { join, resolve, sep, dirname, basename } from "node:path";
import {
  getMarylandCurrentFilingCycles,
  decodeMarylandPublishedFilingCycles,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";
import {
  acquireMarylandPublicIndependentExpenditureCensus,
  readMarylandPublicIndependentExpenditureCensus,
} from "./marylandPublicIndependentExpenditureClient.js";
type Census = Awaited<
  ReturnType<typeof readMarylandPublicIndependentExpenditureCensus>
>;
type Cycle = Awaited<ReturnType<typeof getMarylandCurrentFilingCycles>>;
type Capture = MarylandCurrentCycleCapture<unknown>;
export type MarylandNativeOutsideObservationResult = {
  status: "observed" | "preserve";
  observation?: {
    cycleLabel: string;
    compatibleElectionYears: readonly number[];
    openingDirectory: string;
    closingDirectory: string;
    observedAt: string;
    physicalAllocationCount: number;
    declaredAllocationCount: number;
    sourceCaptureCount: number;
    capturedBytes: number;
  };
  diagnostics: string[];
};
export type MarylandNativeOutsideObservationInput = {
  electionYears: readonly number[];
  rawCacheDir: string;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  onCapture?: (capture: Capture) => void | Promise<void>;
  totalTimeoutMs?: number;
  maxTotalBytes?: number;
  maxRequests?: number;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function hold(code: string): never {
  throw Object.assign(
    new Error("Maryland outside source observation unavailable"),
    { code },
  );
}
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  !v.startsWith("0000") &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const positive = (v: number) => Number.isSafeInteger(v) && v > 0;
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// Full semantic raw rows: key order and transport row order do not erase values or multiplicity.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const rowMultiset = (c: Census) =>
  c.rows.map((r) => JSON.stringify(canonical(r))).sort();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const cycleFacts = (c: Cycle) =>
  [...c.cycles].sort((a, b) => a.value.localeCompare(b.value));
async function savedCycle(
  capture: MarylandCurrentCycleCapture<null>,
  root: string,
) {
  if (
    !capture ||
    capture.url !==
      "https://api-campaignfinance.maryland.gov/api/PublicLookup/GetAllFilingCycleList" ||
    capture.method !== "POST" ||
    capture.requestBody !== null ||
    capture.httpStatus !== 200 ||
    capture.bodyComplete !== true ||
    capture.errorCode !== null ||
    !positive(capture.byteCount) ||
    capture.byteCount > 4 * 1024 * 1024 ||
    typeof capture.outputPath !== "string" ||
    !resolve(capture.outputPath).startsWith(root + sep) ||
    !instant(capture.startedAt) ||
    !instant(capture.completedAt) ||
    typeof capture.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(capture.sha256) ||
    Date.parse(capture.startedAt) > Date.parse(capture.completedAt) ||
    Date.parse(capture.completedAt) - Date.parse(capture.startedAt) > 30_000
  )
    hold("invalid_saved_cycle");
  const parent = await lstat(dirname(capture.outputPath));
  const info = await lstat(capture.outputPath);
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    (parent.mode & 0o777) !== 0o700 ||
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size !== capture.byteCount
  )
    hold("invalid_saved_cycle");
  const bytes = await readFile(capture.outputPath);
  if (bytes.length !== capture.byteCount || digest(bytes) !== capture.sha256)
    hold("invalid_saved_cycle");
  return {
    capture,
    ...decodeMarylandPublishedFilingCycles(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
    ),
  };
}
/** Ordinary observation only. It never calls a finance writer or exposes source rows/selectors. */
export async function loadMarylandNativeOutsideObservation(
  input: MarylandNativeOutsideObservationInput,
): Promise<MarylandNativeOutsideObservationResult> {
  const years = Array.isArray(input.electionYears)
    ? [...new Set(input.electionYears)]
    : [];
  if (!years.length)
    return { status: "preserve", diagnostics: ["no_due_elections"] };
  const timeout = input.totalTimeoutMs ?? 3600000,
    maxBytes = input.maxTotalBytes ?? 512 * 1024 * 1024,
    maxRequests = input.maxRequests ?? 4506;
  if (
    years.some((y) => !Number.isSafeInteger(y) || y < 2000 || y > 2100) ||
    typeof input.rawCacheDir !== "string" ||
    !input.rawCacheDir.trim() ||
    !positive(timeout) ||
    timeout > 3600000 ||
    !positive(maxBytes) ||
    maxBytes > 1024 * 1024 * 1024 ||
    !positive(maxRequests) ||
    maxRequests > 4506
  )
    return {
      status: "preserve",
      diagnostics: ["invalid_outside_observation_request"],
    };
  const fetchImpl = input.fetchImpl ?? fetch,
    observer = input.onCapture,
    refresh = input.refresh === true;
  const root = join(resolve(input.rawCacheDir), "native-outside"),
    generations = join(root, "generations"),
    pointerPath = join(root, "latest-observation.json");
  const diagnostics: string[] = [];
  let journal: Awaited<ReturnType<typeof open>> | undefined;
  const controller = new AbortController(),
    end = performance.now() + timeout;
  let timedOut = false,
    requests = 0,
    capturedBytes = 0;
  let rejectDeadline!: (e: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  void deadline.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(
      Object.assign(new Error("source deadline"), {
        code: "outside_observation_timeout",
      }),
    );
  }, timeout);
  const check = () => {
    if (timedOut || performance.now() >= end)
      hold("outside_observation_timeout");
  };
  const boundedFetch: typeof fetch = (url, init) => {
    check();
    if (requests >= maxRequests) hold("outside_observation_request_limit");
    requests++;
    return Promise.race([
      fetchImpl(url, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
      deadline,
    ]);
  };
  const capture = async (c: Capture) => {
    capturedBytes += c.byteCount;
    await Promise.race([
      Promise.resolve().then(async () => {
        await journal!.appendFile(`${JSON.stringify(c)}\n`);
        await observer?.(structuredClone(c));
      }),
      deadline,
    ]);
    if (capturedBytes > maxBytes) hold("outside_observation_byte_limit");
    check();
  };
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(generations, { recursive: true, mode: 0o700 });
    for (const directory of [root, generations]) {
      const info = await lstat(directory);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (info.mode & 0o777) !== 0o700
      )
        hold("unsafe_outside_cache_directory");
    }
    const generation = join(generations, randomUUID());
    await mkdir(generation, { mode: 0o700 });
    journal = await open(
      join(generation, "attempts.private.jsonl"),
      "wx",
      0o600,
    );
    let saved: { census: Census; directory: string; cycle: Cycle } | undefined;
    if (!refresh) {
      try {
        const info = await lstat(pointerPath);
        if (
          info.isSymbolicLink() ||
          !info.isFile() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 65536
        )
          hold("invalid_saved_pointer");
        const p = JSON.parse(await readFile(pointerPath, "utf8"));
        if (
          !object(p) ||
          p.version !== 1 ||
          typeof p.censusDirectory !== "string" ||
          !resolve(p.censusDirectory).startsWith(generations + sep) ||
          !object(p.cycleCapture) ||
          typeof p.cycleCapture.outputPath !== "string" ||
          dirname(p.cycleCapture.outputPath) !== dirname(p.censusDirectory) ||
          basename(p.cycleCapture.outputPath) !==
            "cycle-opening.original.json" ||
          !["closing", "closing-restart"].includes(basename(p.censusDirectory))
        )
          hold("invalid_saved_pointer");
        const cycle = await savedCycle(
          p.cycleCapture as MarylandCurrentCycleCapture<null>,
          generations,
        );
        const census = await Promise.race([
          readMarylandPublicIndependentExpenditureCensus({
            outputDirectory: p.censusDirectory,
            electionCycle: cycle.defaultCycle.value,
          }),
          deadline,
        ]);
        if (
          Date.parse(cycle.capture.completedAt) > Date.parse(census.startedAt)
        )
          hold("invalid_saved_cycle_order");
        saved = { cycle, census, directory: p.censusDirectory };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          diagnostics.push("saved_outside_observation_unavailable");
      }
    }
    const freshCycle = async (name: string) => {
      check();
      if (capturedBytes >= maxBytes) hold("outside_observation_byte_limit");
      return getMarylandCurrentFilingCycles({
        outputPath: join(generation, `${name}.original.json`),
        fetchImpl: boundedFetch,
        timeoutMs: Math.min(
          30000,
          Math.max(1, Math.floor(end - performance.now())),
        ),
        maxBytes: Math.min(
          4 * 1024 * 1024,
          Math.max(1, maxBytes - capturedBytes),
        ),
        onCapture: (c) => capture(c),
      });
    };
    const beforeCycle = await freshCycle("cycle-opening");
    if (
      saved &&
      Date.parse(saved.census.completedAt) >
        Date.parse(beforeCycle.capture.startedAt)
    ) {
      saved = undefined;
      diagnostics.push("saved_outside_observation_not_prior");
    }
    const match = /^(\d{4})-(\d{4})$/.exec(beforeCycle.defaultCycle.name);
    if (!match) hold("invalid_source_cycle_label");
    const compatible = years.filter(
      (y) => y >= Number(match[1]) && y <= Number(match[2]),
    );
    if (!compatible.length)
      hold("default_cycle_incompatible_with_due_elections");
    if (compatible.length !== years.length)
      diagnostics.push("some_due_elections_outside_default_cycle");
    if (saved && !same(cycleFacts(saved.cycle), cycleFacts(beforeCycle))) {
      saved = undefined;
      diagnostics.push("saved_cycle_changed");
    }
    const census = async (name: string) => {
      check();
      if (capturedBytes >= maxBytes) hold("outside_observation_byte_limit");
      const directory = join(generation, name);
      await acquireMarylandPublicIndependentExpenditureCensus({
        electionCycle: beforeCycle.defaultCycle.value,
        outputDirectory: directory,
        fetchImpl: boundedFetch,
        totalTimeoutMs: Math.max(1, Math.floor(end - performance.now())),
        maxTotalBytes: Math.min(maxBytes - capturedBytes, 1024 * 1024 * 1024),
        onCapture: (c) => capture(c),
      });
      check();
      return {
        directory,
        census: await Promise.race([
          readMarylandPublicIndependentExpenditureCensus({
            outputDirectory: directory,
            electionCycle: beforeCycle.defaultCycle.value,
          }),
          deadline,
        ]),
      };
    };
    let opening = saved
      ? { directory: saved.directory, census: saved.census }
      : await census("opening");
    if (
      Date.parse((saved?.cycle ?? beforeCycle).capture.completedAt) >
      Date.parse(opening.census.startedAt)
    )
      hold("outside_observation_order");
    let closing = await census("closing");
    let afterCycle = await freshCycle("cycle-closing");
    if (!same(cycleFacts(beforeCycle), cycleFacts(afterCycle)))
      hold("source_cycle_changed");
    if (
      Date.parse(opening.census.completedAt) >
        Date.parse(closing.census.startedAt) ||
      Date.parse(closing.census.completedAt) >
        Date.parse(afterCycle.capture.startedAt)
    )
      hold("outside_observation_order");
    let stable = same(rowMultiset(opening.census), rowMultiset(closing.census));
    if (!stable) {
      diagnostics.push("outside_observation_changed_restarted");
      opening = closing;
      closing = await census("closing-restart");
      afterCycle = await freshCycle("cycle-closing-restart");
      if (!same(cycleFacts(beforeCycle), cycleFacts(afterCycle)))
        hold("source_cycle_changed");
      if (
        Date.parse(opening.census.completedAt) >
          Date.parse(closing.census.startedAt) ||
        Date.parse(closing.census.completedAt) >
          Date.parse(afterCycle.capture.startedAt)
      )
        hold("outside_observation_order");
      stable = same(rowMultiset(opening.census), rowMultiset(closing.census));
    }
    // A completed genuine closing can seed a future opening, even when this pair changed.
    const temporary = join(root, `pointer-${randomUUID()}.tmp`),
      file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          version: 1,
          censusDirectory: closing.directory,
          cycleCapture: beforeCycle.capture,
        }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    check();
    await journal.sync();
    check();
    await rename(temporary, pointerPath);
    if (!stable)
      return {
        status: "preserve",
        diagnostics: [...diagnostics, "outside_observation_changed_again"],
      };
    return {
      status: "observed",
      observation: {
        cycleLabel: beforeCycle.defaultCycle.name,
        compatibleElectionYears: Object.freeze(compatible),
        openingDirectory: opening.directory,
        closingDirectory: closing.directory,
        observedAt: afterCycle.capture.completedAt,
        physicalAllocationCount: closing.census.physicalRows,
        declaredAllocationCount: closing.census.declaredRows,
        sourceCaptureCount: requests,
        capturedBytes,
      },
      diagnostics: [
        ...diagnostics,
        "outside_financial_target_and_current_report_authority_unresolved",
      ],
    };
  } catch (e) {
    const code =
      object(e) && typeof e.code === "string" && /^[a-z_]+$/.test(e.code)
        ? e.code
        : "outside_observation_unavailable";
    return {
      status: "preserve",
      diagnostics: [
        ...diagnostics,
        timedOut ? "outside_observation_timeout" : code,
      ],
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await journal?.close().catch(() => {});
  }
}
