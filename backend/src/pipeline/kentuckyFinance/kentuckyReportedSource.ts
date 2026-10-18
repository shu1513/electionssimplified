import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type KentuckyReportedKind = "committee" | "ie";
export type KentuckyReportedRow = Record<string, string>;
export const KY_REPORTED_URL = "https://secure.kentucky.gov/kref/publicsearch";
export const KY_REPORTED_DATES = ["2026-05-19", "2026-11-03"] as const;
export const KY_CENSUS_COLUMNS =
  "Last Name|First Name|Office Sought|Is Active|Location|Election Date|Election Type|Exemption Status|Total Receipts|Total Disburse".split(
    "|",
  );
export const KY_RECEIPT_COLUMNS =
  "To Organization|From Organization Name|Contributor Last Name|Contributor First Name|Recipient Last Name|Recipient First Name|Office Sought|Location|Election Date|Election Type|Exemption Status|OtherText|Address 1|Address 2|City|State|Zip|Amount|Contribution Type|Contribution Mode|Occupation|Other Occupation|Employer|Spouse Prefix|Spouse Last Name|Spouse First Name|Spouse Middle Initial|Spouse Suffix|Spouse Occupation|Spouse Employer|Number Of Contributors|In kind Description|Receipt Date|Statement Type".split(
    "|",
  );
export const KY_IE_COLUMNS =
  "To Whome Made|Name|Date|Candidate Name|Support / Oppose|Office / Ballot Measure|Election Date|Amount".split(
    "|",
  );
export class KentuckyReportedHold extends Error {
  constructor(public readonly code: string) {
    super(`Kentucky reported finance held: ${code}`);
  }
}
export function kyHold(code: string): never {
  throw new KentuckyReportedHold(code);
}
export const kyHash = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");
export function kyAdd(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) kyHold("unsafe_sum");
  return n;
}
/** Strict dollars to signed cents. Blank, malformed grouping, precision loss,
 * non-finite amounts and a second sign are never interpreted as zero. */
export function kyCents(raw: string): number {
  const s = raw.trim();
  const m =
    /^(\()?(-)?\$?((?:\d+|\d{1,3}(?:,\d{3})+))(?:\.(\d{2}))?(\))?$/.exec(s);
  if (!m || Boolean(m[1]) !== Boolean(m[5]) || (m[1] && m[2]))
    kyHold("invalid_amount");
  const n = Number(m[3]!.replaceAll(",", "")) * 100 + Number(m[4] ?? 0);
  if (!Number.isSafeInteger(n)) kyHold("unsafe_amount");
  return m[1] || m[2] ? -n : n;
}
/** RFC4180 with optional CRLF, BOM and empty physical lines. Exact headers,
 * duplicate multiplicities, embedded newlines and complete EOF are retained. */
export function parseKentuckyReportedCsv(
  text: string,
  columns: readonly string[],
): KentuckyReportedRow[] {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  function endCell() {
    row.push(cell);
    cell = "";
    closed = false;
  }
  function endRow() {
    endCell();
    if (row.length !== 1 || row[0] !== "") records.push(row);
    row = [];
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === ",") endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || c === '"' || c === "\u0000") kyHold("malformed_csv");
      cell += c;
    }
  }
  if (quoted) kyHold("unterminated_csv");
  if (cell !== "" || row.length || closed) endRow();
  if (
    JSON.stringify(records.shift()) !== JSON.stringify(columns) ||
    new Set(columns).size !== columns.length
  )
    kyHold("csv_schema");
  if (records.length > 1_000_000) kyHold("row_budget");
  return records.map((values) => {
    if (values.length !== columns.length) kyHold("csv_width");
    return Object.fromEntries(columns.map((key, i) => [key, values[i]!]));
  });
}
export function kyMultiset(rows: readonly KentuckyReportedRow[]): string[] {
  return rows.map((r) => JSON.stringify(r)).sort();
}
export function kyNativeCount(html: string): number {
  const counts = [...html.matchAll(/([\d,]+)\s*Results?\b/gi)].map((m) =>
    Number(m[1]!.replaceAll(",", "")),
  );
  if (counts.length !== 1 || !Number.isSafeInteger(counts[0]) || counts[0]! < 0)
    kyHold("native_count");
  return counts[0]!;
}
export type KentuckyReportedControl = {
  file: string;
  url: string;
  status: number;
  bytes: number;
  sha256: string;
  startedAt: string;
  completedAt: string;
};
export type KentuckyReportedPacket = {
  kind: KentuckyReportedKind;
  year: 2026;
  rows: readonly KentuckyReportedRow[];
  census: readonly KentuckyReportedRow[];
  retrievedAt: string;
  completedAt: string;
  manifestHash: string;
  byteSize: number;
  controls: readonly KentuckyReportedControl[];
};
const verified = new WeakSet<object>();
function freeze<T extends object>(o: T): T {
  for (const x of Object.values(o)) if (x && typeof x === "object") freeze(x);
  return Object.freeze(o);
}
export function isKentuckyReportedPacket(
  o: unknown,
): o is KentuckyReportedPacket {
  return !!o && typeof o === "object" && verified.has(o);
}
const GENERATION = /^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_RESPONSE = 32 * 1024 * 1024,
  MAX_TOTAL = 160 * 1024 * 1024;
export function kentuckyReportedCacheDir(path?: string): string {
  return resolve(path ?? (process.env.KENTUCKY_REPORTED_CACHE_DIR?.trim() || "scratch/kentucky-campaign-finance/reported"));
}
export function kentuckyReportedUrls(kind: KentuckyReportedKind, date: string) {
  const censusHtml = `${KY_REPORTED_URL}/CandidateSearch?ElectionDate=${date}&ExemptionStatus=All`;
  const censusCsv = `${KY_REPORTED_URL}/ExportSearch?ElectionDate=${date}&ExemptionStatus=All`;
  const query =
    kind === "committee"
      ? `ContributionSearchType=Candidate&ElectionDate=${date}`
      : `ElectionDate=${date}`;
  const html = `${KY_REPORTED_URL}/${kind === "committee" ? "ToCandidateSearch" : "IndependentExpenditureSearch"}?${query}`;
  const csv = `${KY_REPORTED_URL}/${kind === "committee" ? "ExportContributors" : "IndependentExpenditureSearch/ExportIndependentExpenditures"}?${query}`;
  return [censusHtml, censusCsv, html, csv, csv, html, censusCsv, censusHtml];
}
async function privateDir(path: string) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700)
    kyHold("unsafe_cache_dir");
}
async function bytes(path: string, max: number): Promise<Buffer> {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    (s.mode & 0o777) !== 0o600 ||
    s.size < 1 ||
    s.size > max
  )
    kyHold("unsafe_cache_file");
  const b = await readFile(path);
  if (b.length !== s.size) kyHold("cache_changed");
  return b;
}
function decode(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return kyHold("source_encoding");
  }
}
function parseJson(b: Uint8Array): any {
  try {
    return JSON.parse(decode(b));
  } catch {
    return kyHold("cache_json");
  }
}
function instant(v: unknown): v is string {
  return (
    typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
/** Replay the exact prescribed source graph; no normalized cache or caller
 * supplied groups can become a verified monetary input. */
async function replay(
  root: string,
  kind: KentuckyReportedKind,
  generation: string,
  manifestHash: string,
): Promise<KentuckyReportedPacket> {
  if (!GENERATION.test(generation) || !/^[a-f0-9]{64}$/.test(manifestHash))
    kyHold("cache_reference");
  await privateDir(root);
  await privateDir(resolve(root, generation));
  const raw = await bytes(
    resolve(root, generation, "manifest.json"),
    128 * 1024,
  );
  if (kyHash(raw) !== manifestHash) kyHold("manifest_hash");
  const m = parseJson(raw);
  if (
    m.version !== 1 ||
    m.year !== 2026 ||
    m.kind !== kind ||
    !Array.isArray(m.controls) ||
    m.controls.length !== 16
  )
    kyHold("manifest_scope");
  const controls: KentuckyReportedControl[] = m.controls,
    rows: KentuckyReportedRow[] = [],
    census: KentuckyReportedRow[] = [];
  let total = 0,
    previous = -Infinity;
  for (const [di, date] of KY_REPORTED_DATES.entries()) {
    const texts: string[] = [];
    for (const [j, url] of kentuckyReportedUrls(kind, date).entries()) {
      const index = di * 8 + j,
        c = controls[index]!;
      if (
        !c ||
        c.file !== `${generation}/${String(index + 1).padStart(4, "0")}.raw` ||
        c.url !== url ||
        c.status !== 200 ||
        !Number.isSafeInteger(c.bytes) ||
        c.bytes < 1 ||
        c.bytes > MAX_RESPONSE ||
        !/^[a-f0-9]{64}$/.test(c.sha256) ||
        !instant(c.startedAt) ||
        !instant(c.completedAt) ||
        Date.parse(c.startedAt) < previous ||
        c.startedAt > c.completedAt ||
        Date.parse(c.completedAt) > Date.now()
      )
        kyHold("capture_control");
      total = kyAdd(total, c.bytes);
      if (total > MAX_TOTAL) kyHold("source_budget");
      previous = Date.parse(c.completedAt);
      const b = await bytes(resolve(root, c.file), MAX_RESPONSE);
      if (b.length !== c.bytes || kyHash(b) !== c.sha256)
        kyHold("original_hash");
      texts.push(decode(b));
    }
    const a = parseKentuckyReportedCsv(texts[1]!, KY_CENSUS_COLUMNS),
      b = parseKentuckyReportedCsv(texts[6]!, KY_CENSUS_COLUMNS);
    const r = parseKentuckyReportedCsv(
      texts[3]!,
      kind === "committee" ? KY_RECEIPT_COLUMNS : KY_IE_COLUMNS,
    );
    const s = parseKentuckyReportedCsv(
      texts[4]!,
      kind === "committee" ? KY_RECEIPT_COLUMNS : KY_IE_COLUMNS,
    );
    if (
      kyNativeCount(texts[0]!) !== a.length ||
      kyNativeCount(texts[7]!) !== a.length ||
      !a.length ||
      kyNativeCount(texts[2]!) !== r.length ||
      kyNativeCount(texts[5]!) !== r.length ||
      JSON.stringify(kyMultiset(a)) !== JSON.stringify(kyMultiset(b)) ||
      JSON.stringify(kyMultiset(r)) !== JSON.stringify(kyMultiset(s))
    )
      kyHold("source_moved_or_incomplete");
    // An export returning another date/year must not authorize a financial zero.
    const dateKey = (v: string) => {
      const n = /^0?(\d{1,2})\/0?(\d{1,2})\/2026(?:\s.*)?$/.exec(v.trim());
      return n
        ? `2026-${n[1]!.padStart(2, "0")}-${n[2]!.padStart(2, "0")}`
        : "";
    };
    if (
      [...a, ...r].some((row) => dateKey(row["Election Date"] ?? "") !== date)
    )
      kyHold("export_election_scope");
    census.push(...a);
    rows.push(...r);
  }
  const packet: KentuckyReportedPacket = freeze({
    kind,
    year: 2026,
    rows,
    census,
    retrievedAt: controls[0]!.startedAt,
    completedAt: controls.at(-1)!.completedAt,
    manifestHash,
    byteSize: total,
    controls,
  });
  verified.add(packet);
  return packet;
}
export async function readKentuckyReportedSource(input: {
  cacheDir?: string;
  kind: KentuckyReportedKind;
}): Promise<KentuckyReportedPacket | null> {
  const root = kentuckyReportedCacheDir(input.cacheDir);
  let p: any;
  try {
    p = parseJson(
      await bytes(resolve(root, `${input.kind}-2026.latest.json`), 4096),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!p || typeof p.generation !== "string" || typeof p.sha256 !== "string")
    kyHold("cache_pointer");
  return replay(root, input.kind, p.generation, p.sha256);
}
/** Originals first, complete replay second, atomic pointer last. A failed
 * acquisition leaves the previous published generation and date untouched. */
export async function refreshKentuckyReportedSource(input: {
  cacheDir?: string;
  kind: KentuckyReportedKind;
  fetchImpl?: typeof fetch;
}): Promise<KentuckyReportedPacket> {
  const root = kentuckyReportedCacheDir(input.cacheDir),
    generation = `generation-${randomUUID()}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDir(root);
  const dir = resolve(root, generation);
  await mkdir(dir, { mode: 0o700 });
  const controls: KentuckyReportedControl[] = [];
  let total = 0;
  for (const date of KY_REPORTED_DATES)
    for (const [j, url] of kentuckyReportedUrls(input.kind, date).entries()) {
      const startedAt = new Date().toISOString();
      let response: Response;
      try {
        response = await (input.fetchImpl ?? fetch)(url, {
          method: "GET",
          redirect: "error",
          headers: {
            accept: [0, 2, 5, 7].includes(j)
              ? "text/html"
              : "text/csv,text/plain;q=0.9,*/*;q=0.1",
          },
          signal: AbortSignal.timeout(90_000),
        });
      } catch {
        return kyHold("source_network");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) kyHold("source_body");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          total += item.value.length;
          if (size > MAX_RESPONSE || total > MAX_TOTAL) {
            await reader.cancel();
            kyHold("source_budget");
          }
          chunks.push(item.value);
        }
      } catch (e) {
        if (e instanceof KentuckyReportedHold) throw e;
        return kyHold("source_body");
      }
      const raw = Buffer.concat(chunks),
        file = `${generation}/${String(controls.length + 1).padStart(4, "0")}.raw`;
      await writeFile(resolve(root, file), raw, { mode: 0o600, flag: "wx" });
      const c = {
        file,
        url,
        status: response.status,
        bytes: raw.length,
        sha256: kyHash(raw),
        startedAt,
        completedAt: new Date().toISOString(),
      };
      controls.push(c);
      await writeFile(
        resolve(dir, "capture-progress.json"),
        JSON.stringify({ kind: input.kind, controls }),
        { mode: 0o600 },
      );
      if (response.status !== 200) kyHold("source_http");
    }
  const manifest = JSON.stringify({
      version: 1,
      year: 2026,
      kind: input.kind,
      controls,
    }),
    sha256 = kyHash(manifest);
  await writeFile(resolve(dir, "manifest.json"), manifest, {
    mode: 0o600,
    flag: "wx",
  });
  const packet = await replay(root, input.kind, generation, sha256);
  const pending = resolve(root, `${generation}.pointer`);
  await writeFile(pending, JSON.stringify({ generation, sha256 }), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(pending, resolve(root, `${input.kind}-2026.latest.json`));
  return packet;
}
