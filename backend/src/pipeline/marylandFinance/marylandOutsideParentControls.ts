import { appendFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  buildMarylandPublicOutsideDetailRequest,
  buildMarylandPublicOutsideAllocationChildrenRequest,
  buildMarylandPublicOutsideReturnedChildrenRequest,
  captureMarylandPublicOutsideDetailPost,
  captureMarylandPublicOutsideAllocationChildrenPost,
  captureMarylandPublicOutsideReturnedChildrenPost,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";
type Row = Readonly<Record<string, unknown>>;
type Capture = MarylandCurrentCycleCapture<unknown>;
type Scope = {
  transactionGuid: string;
  transactionId: number;
  outputDirectory: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (): never => {
  throw new Error("maryland_outside_parent_controls_unavailable");
};
const api =
  "https://api-campaignfinance.maryland.gov/api/PublicTransactionDetails/";
const instant = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;
function page(value: unknown) {
  if (
    !object(value) ||
    value.succeeded !== true ||
    value.error !== null ||
    !object(value.data) ||
    !Number.isSafeInteger(value.data.totalItems) ||
    (value.data.totalItems as number) < 0 ||
    !Array.isArray(value.data.items) ||
    value.data.items.some((r) => !object(r))
  )
    return fail();
  return {
    rows: value.data.items as Row[],
    total: value.data.totalItems as number,
  };
}
export async function acquireMarylandOutsideParentControls(
  input: Scope & {
    fetchImpl?: typeof fetch;
    onCapture?: (capture: Capture) => void | Promise<void>;
  },
) {
  const dir = resolve(input.outputDirectory);
  buildMarylandPublicOutsideReturnedChildrenRequest({
    transactionGuid: input.transactionGuid,
    transactionId: input.transactionId,
    pageNumber: 1,
  });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const observer = async (capture: Capture) => {
    await appendFile(
      join(dir, "captures.private.jsonl"),
      JSON.stringify(capture) + "\n",
      { mode: 0o600 },
    );
    await input.onCapture?.(capture);
  };
  const options = { fetchImpl: input.fetchImpl, onCapture: observer };
  await captureMarylandPublicOutsideDetailPost(
    buildMarylandPublicOutsideDetailRequest(input.transactionGuid),
    { ...options, outputPath: join(dir, "detail.original.json") },
  );
  for (const kind of ["allocations", "returns"] as const) {
    let total: number | undefined,
      physical = 0;
    for (let number = 1; number <= 100; number++) {
      const outputPath = join(
        dir,
        `${kind}-${String(number).padStart(3, "0")}.original.json`,
      );
      const capture =
        kind === "allocations"
          ? await captureMarylandPublicOutsideAllocationChildrenPost(
              buildMarylandPublicOutsideAllocationChildrenRequest({
                transactionGuid: input.transactionGuid,
                pageNumber: number,
              }),
              { ...options, outputPath },
            )
          : await captureMarylandPublicOutsideReturnedChildrenPost(
              buildMarylandPublicOutsideReturnedChildrenRequest({
                transactionGuid: input.transactionGuid,
                transactionId: input.transactionId,
                pageNumber: number,
              }),
              { ...options, outputPath },
            );
      const p = page(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readFile(capture.outputPath),
          ),
        ),
      );
      if (total !== undefined && total !== p.total) return fail();
      total = p.total;
      physical += p.rows.length;
      if (physical === total) break;
      if (physical > total || p.rows.length !== 10 || number === 100)
        return fail();
    }
  }
  return readMarylandOutsideParentControls(input);
}
/** Reopens complete originals and actual request envelopes. Parsed money and
 * identities stay in RAM; no caller-supplied success/qualification flag exists. */
export async function readMarylandOutsideParentControls(input: Scope) {
  try {
    const dir = resolve(input.outputDirectory),
      info = await lstat(dir);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700
    )
      return fail();
    const privateFile = async (path: string, maximum: number) => {
      const f = await lstat(path);
      if (
        !f.isFile() ||
        f.isSymbolicLink() ||
        (f.mode & 0o777) !== 0o600 ||
        f.size < 1 ||
        f.size > maximum
      )
        return fail();
      return readFile(path);
    };
    const journal = new TextDecoder("utf-8", { fatal: true }).decode(
      await privateFile(join(dir, "captures.private.jsonl"), 1024 * 1024),
    );
    if (!journal.endsWith("\n") || journal.includes("\r")) return fail();
    const entries = journal
      .slice(0, -1)
      .split("\n")
      .map((s) => JSON.parse(s));
    if (!entries.length || entries.length > 201) return fail();
    let index = 0,
      previous: string | undefined;
    const captures: Capture[] = [],
      files = new Set(["captures.private.jsonl"]);
    async function read(
      name: string,
      route: string,
      request: Readonly<Record<string, unknown>>,
    ) {
      const c = entries[index++];
      const keys = [
        "url",
        "method",
        "requestBody",
        "outputPath",
        "startedAt",
        "completedAt",
        "httpStatus",
        "byteCount",
        "sha256",
        "bodyComplete",
        "errorCode",
      ];
      if (
        !object(c) ||
        Object.keys(c).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(c, k)) ||
        c.url !== api + route ||
        c.method !== "POST" ||
        JSON.stringify(c.requestBody) !== JSON.stringify(request) ||
        c.outputPath !== join(dir, name) ||
        c.httpStatus !== 200 ||
        c.bodyComplete !== true ||
        c.errorCode !== null ||
        !instant(c.startedAt) ||
        !instant(c.completedAt) ||
        c.completedAt < c.startedAt ||
        (previous && c.startedAt < previous) ||
        typeof c.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(c.sha256)
      )
        return fail();
      const raw = await privateFile(c.outputPath as string, 4 * 1024 * 1024);
      if (
        raw.length !== c.byteCount ||
        createHash("sha256").update(raw).digest("hex") !== c.sha256
      )
        return fail();
      files.add(name);
      previous = c.completedAt;
      captures.push(c as Capture);
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
      if (
        !object(value) ||
        value.succeeded !== true ||
        value.error !== null ||
        !object(value.data)
      )
        return fail();
      return value;
    }
    const detail = (
      await read(
        "detail.original.json",
        "GetTransactionDetailsByGuid",
        buildMarylandPublicOutsideDetailRequest(input.transactionGuid),
      )
    ).data as Row;
    const sections: { allocations: Row[]; returns: Row[] } = {
      allocations: [],
      returns: [],
    };
    for (const kind of ["allocations", "returns"] as const) {
      let total: number | undefined;
      for (let number = 1; number <= 100; number++) {
        const request =
          kind === "allocations"
            ? buildMarylandPublicOutsideAllocationChildrenRequest({
                transactionGuid: input.transactionGuid,
                pageNumber: number,
              })
            : buildMarylandPublicOutsideReturnedChildrenRequest({
                transactionGuid: input.transactionGuid,
                transactionId: input.transactionId,
                pageNumber: number,
              });
        const p = page(
          await read(
            `${kind}-${String(number).padStart(3, "0")}.original.json`,
            kind === "allocations"
              ? "GetPublicCandidateMeasureList"
              : "GetChildTransactionDetails",
            request,
          ),
        );
        if (total !== undefined && total !== p.total) return fail();
        total = p.total;
        sections[kind].push(...p.rows);
        if (sections[kind].length === total) break;
        if (
          sections[kind].length > total ||
          p.rows.length !== 10 ||
          number === 100
        )
          return fail();
      }
    }
    const actual = await readdir(dir);
    if (
      index !== entries.length ||
      actual.length !== files.size ||
      actual.some((f) => !files.has(f))
    )
      return fail();
    return Object.freeze({
      detail,
      allocations: Object.freeze(sections.allocations),
      returns: Object.freeze(sections.returns),
      captures: Object.freeze(captures),
      startedAt: captures[0]!.startedAt,
      completedAt: captures.at(-1)!.completedAt,
    });
  } catch {
    return fail();
  }
}
