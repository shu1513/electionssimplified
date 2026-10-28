import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isPhoenixReviewedEfdRawRefreshEnabled } from "../../config/featureFlags.js";
import { PHOENIX_EFD_BALLOT_URL, PHOENIX_EFD_INDEX_URL, PhoenixEfdHold, assertPhoenixEfdCmsUrl, efdCheck,
  parsePhoenixCouncilBallot, parsePhoenixEfdIndex, selectPhoenixEfdFamily, phoenixEfdObservationDay,
  type PhoenixCouncilBallotRow, type PhoenixEfdIndexRow } from "./phoenixReviewedEfd.js";

type Original = {
  role: string; file: string; url: string; method: "GET"; status: number; contentType: string | null;
  startedAt: string; completedAt: string; bytes: number; sha256: string; eof: boolean;
  declaredLength?: number | null; contentEncoding?: string | null;
};
export type PhoenixEfdOriginals = {
  family: PhoenixEfdIndexRow[]; ballot: PhoenixCouncilBallotRow[];
  scans: { row: PhoenixEfdIndexRow; sha256: string; pageCount: number }[];
  observedAt: string; completedAt: string; sourceDigest: string;
};
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const html = (raw: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(raw);
const clock = (s: unknown): s is string => typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(s) && Number.isFinite(Date.parse(s));
async function directory(path: string): Promise<void> {
  efdCheck(!basename(path).startsWith(".env"), "private_cache_path");
  const stat = await lstat(path);
  efdCheck(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077), "private_cache_directory");
}
async function privateBytes(path: string, limit: number): Promise<Buffer> {
  const stat = await lstat(path);
  efdCheck(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.size <= limit, "private_whole_original");
  return readFile(path);
}
const rootPath = (cacheDir?: string) => {
  const path = resolve(cacheDir ?? "scratch/phoenix-reviewed-efd");
  efdCheck(!path.split(/[\\/]/u).some(part => part.startsWith(".env")), "private_cache_path");
  return path;
};

type OriginalFiles = { metas: Original[]; bodies: Buffer[] };
/** Integrity of a saved capture: every manifest row is a complete, whole 200
 * response. Says nothing yet about which filer or edition it proves. */
async function readOriginalFiles(path: string): Promise<OriginalFiles> {
  await directory(path);
  const metas: Original[] = html(await privateBytes(resolve(path, "manifest.ndjson"), 2 * 1024 * 1024))
    .trim().split("\n").map(line => JSON.parse(line));
  efdCheck(metas.length >= 6 && metas.length <= 204, "whole_original_manifest");
  const bodies: Buffer[] = [];
  let previous = -Infinity, total = 0;
  for (const [i, meta] of metas.entries()) {
    const pdf = meta.role.includes("_pdf_");
    efdCheck(meta.file === `${String(i + 1).padStart(4, "0")}.original.${pdf ? "pdf" : "html"}` &&
      meta.method === "GET" && meta.status === 200 && meta.eof === true &&
      clock(meta.startedAt) && clock(meta.completedAt) && Date.parse(meta.startedAt) >= previous &&
      Date.parse(meta.completedAt) >= Date.parse(meta.startedAt) && Date.parse(meta.completedAt) <= Date.now() + 300_000 &&
      Number.isSafeInteger(meta.bytes) && meta.bytes > 0 && /^[a-f0-9]{64}$/u.test(meta.sha256), "original_provenance_or_clock");
    previous = Date.parse(meta.completedAt);
    const raw = await privateBytes(resolve(path, meta.file), 32 * 1024 * 1024);
    total += raw.length;
    efdCheck(total <= 64 * 1024 * 1024 && raw.length === meta.bytes && hash(raw) === meta.sha256, "whole_original_integrity");
    efdCheck(meta.declaredLength === undefined || meta.declaredLength === null ||
      (Number.isSafeInteger(meta.declaredLength) && meta.declaredLength >= 0 &&
        (Boolean(meta.contentEncoding) || meta.declaredLength === raw.length)), "declared_original_length");
    if (pdf) efdCheck(raw.subarray(0, 5).toString() === "%PDF-" && /%%EOF\s*$/u.test(raw.subarray(-1024).toString("latin1")), "whole_pdf_structure");
    else efdCheck(meta.contentType?.toLowerCase().includes("text/html"), "whole_html_type");
    bodies.push(raw);
  }
  return { metas, bodies };
}
/** Reasons proving the published source moved under a capture. A capture that
 * fails this way is evidence of change, not noise, and blocks replay of older ones. */
const SOURCE_CHANGED = new Set(["publication_census_changed", "certified_ballot_changed", "whole_pdf_edition_changed"]);
async function qualifyOriginals({ metas, bodies }: OriginalFiles, spenderName: string, electionDate: string): Promise<PhoenixEfdOriginals> {
  const at = (role: string, url: string) => {
    const indexes = metas.flatMap((m, i) => m.role === role ? [i] : []);
    efdCheck(indexes.length === 1 && metas[indexes[0]!]!.url === url, "whole_original_role_or_url");
    return { meta: metas[indexes[0]!]!, raw: bodies[indexes[0]!]! };
  };
  const opening = at("opening_index", PHOENIX_EFD_INDEX_URL), closing = at("closing_index", PHOENIX_EFD_INDEX_URL);
  const rows = parsePhoenixEfdIndex(html(opening.raw));
  efdCheck(isDeepStrictEqual(rows, parsePhoenixEfdIndex(html(closing.raw))), "publication_census_changed");
  const asOfDay = phoenixEfdObservationDay(opening.meta.startedAt);
  const family = selectPhoenixEfdFamily(rows, spenderName, electionDate, asOfDay);
  efdCheck(metas.length === family.length * 2 + 4, "whole_original_scope");
  efdCheck(isDeepStrictEqual(metas.map(m => m.role), ["opening_index", "opening_ballot",
    ...family.map((_, i) => `opening_pdf_${i}`), "closing_index", "closing_ballot",
    ...family.map((_, i) => `closing_pdf_${i}`)]), "whole_original_phase_order");
  const firstBallot = at("opening_ballot", PHOENIX_EFD_BALLOT_URL), lastBallot = at("closing_ballot", PHOENIX_EFD_BALLOT_URL);
  const ballot = parsePhoenixCouncilBallot(html(firstBallot.raw));
  efdCheck(isDeepStrictEqual(ballot, parsePhoenixCouncilBallot(html(lastBallot.raw))), "certified_ballot_changed");
  efdCheck(ballot.every(row => row.certifiedDate === null || row.certifiedDate <= asOfDay), "certified_ballot_future");
  const scans: PhoenixEfdOriginals["scans"] = [];
  for (const [i, row] of family.entries()) {
    assertPhoenixEfdCmsUrl(row.sourceUrl);
    const first = at(`opening_pdf_${i}`, row.sourceUrl), last = at(`closing_pdf_${i}`, row.sourceUrl);
    efdCheck(first.raw.equals(last.raw), "whole_pdf_edition_changed");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({ data: new Uint8Array(first.raw), isEvalSupported: false }).promise;
    try {
      efdCheck(pdf.numPages >= 1 && pdf.numPages <= 50, "whole_report_page_bound");
      scans.push({ row, sha256: first.meta.sha256, pageCount: pdf.numPages });
    } finally { await pdf.destroy(); }
  }
  return { family, ballot, scans, observedAt: metas[0]!.startedAt, completedAt: metas.at(-1)!.completedAt,
    sourceDigest: hash(Buffer.from(JSON.stringify(metas))) };
}
const readBundle = async (path: string, spenderName: string, electionDate: string): Promise<PhoenixEfdOriginals> =>
  qualifyOriginals(await readOriginalFiles(path), spenderName, electionDate);

/** Saved genuine originals keep their own observation clocks. They are not
 * transcriptions and never receive a new source timestamp on replay. Captures
 * are read newest first: a newer complete capture that proves the source
 * changed leaves nothing replayable, so an older edition is never certified
 * over it. Failed, partial or unrelated captures are skipped. */
export async function readPhoenixEfdOriginals(input: {
  cacheDir?: string; spenderName: string; electionDate: string;
}): Promise<PhoenixEfdOriginals | null> {
  const root = rootPath(input.cacheDir);
  try { await directory(root); } catch { return null; }
  const captures: OriginalFiles[] = [];
  for (const name of (await readdir(root)).filter(n => /^source-originals-[a-f0-9-]{36}$/u.test(n))) {
    try {
      const files = await readOriginalFiles(resolve(root, name));
      if (Date.now() - Date.parse(files.metas.at(-1)!.completedAt) <= 48 * 60 * 60 * 1000) captures.push(files);
    } catch { /* Failed/partial originals cannot grant authority. */ }
  }
  captures.sort((a, b) => b.metas.at(-1)!.completedAt.localeCompare(a.metas.at(-1)!.completedAt));
  for (const files of captures) {
    try { return await qualifyOriginals(files, input.spenderName, input.electionDate); }
    catch (error) { if (error instanceof PhoenixEfdHold && SOURCE_CHANGED.has(error.reason)) return null; }
  }
  return null;
}

/** Fetch only published CMS links. Every attempted response is retained as a
 * genuine original, including failed/partial bodies. No archive agreement,
 * credentials, selector guessing or OCR is involved. */
export async function refreshPhoenixEfdOriginals(input: {
  cacheDir?: string; spenderName: string; electionDate: string; fetchImpl?: typeof fetch;
  /** Test/transport pacing seam; the operator CLI always uses one second. */
  requestIntervalMs?: number;
  /** The saved edition the caller would replay if the source is unavailable.
   * Every page this refresh did obtain must still match it; otherwise the
   * source is known to have changed and no replay is permitted. */
  replay?: PhoenixEfdOriginals | null;
}): Promise<PhoenixEfdOriginals> {
  efdCheck(isPhoenixReviewedEfdRawRefreshEnabled(), "raw_refresh_disabled");
  const root = rootPath(input.cacheDir);
  await mkdir(root, { recursive: true, mode: 0o700 }); await directory(root);
  const path = resolve(root, `source-originals-${randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  let count = 0, total = 0, last = 0;
  const started = Date.now();
  const interval = input.requestIntervalMs ?? 1000;
  efdCheck(Number.isSafeInteger(interval) && interval >= 0 && interval <= 5000, "request_interval");
  const obtained: { raw: Buffer; meta: Original }[] = [];
  async function request(url: string, role: string, pdf = false): Promise<{ raw: Buffer; meta: Original }> {
    if (pdf) assertPhoenixEfdCmsUrl(url);
    else efdCheck([PHOENIX_EFD_INDEX_URL, PHOENIX_EFD_BALLOT_URL].includes(url), "public_html_scope");
    efdCheck(++count <= 204 && Date.now() - started <= 15 * 60 * 1000, "source_request_bound");
    const wait = Math.max(0, interval - (Date.now() - last));
    if (wait) await new Promise(resolveWait => setTimeout(resolveWait, wait));
    last = Date.now();
    const startedAt = new Date().toISOString(), chunks: Uint8Array[] = [];
    let response: Response | undefined, bytes = 0, eof = false;
    try {
      response = await (input.fetchImpl ?? fetch)(url, { method: "GET", credentials: "omit", redirect: "error",
        headers: { "User-Agent": "Mozilla/5.0 VoteApp public campaign finance source sync", Accept: pdf ? "application/pdf" : "text/html" },
        signal: AbortSignal.timeout(45_000) });
      const reader = response.body?.getReader();
      efdCheck(reader, "source_body");
      while (true) {
        const next = await reader.read();
        if (next.done) { eof = true; break; }
        bytes += next.value.byteLength;
        if (bytes > 32 * 1024 * 1024 || total + bytes > 64 * 1024 * 1024) { await reader.cancel(); break; }
        chunks.push(next.value);
      }
    } catch { /* Preserve any genuine partial response before failing closed. */ }
    const raw = Buffer.concat(chunks); total += raw.length;
    const length = response?.headers.get("content-length");
    const meta: Original = { role, file: `${String(count).padStart(4, "0")}.original.${pdf ? "pdf" : "html"}`,
      url, method: "GET", status: response?.status ?? 0, contentType: response?.headers.get("content-type") ?? null,
      startedAt, completedAt: new Date().toISOString(), bytes: raw.length, sha256: hash(raw), eof,
      declaredLength: length == null ? null : Number(length), contentEncoding: response?.headers.get("content-encoding") ?? null };
    await writeFile(resolve(path, meta.file), raw, { mode: 0o600, flag: "wx" });
    await appendFile(resolve(path, "manifest.ndjson"), JSON.stringify(meta) + "\n", { mode: 0o600 });
    efdCheck(response && response.status === 200 && eof && raw.length > 0 &&
      (meta.declaredLength === null || (Number.isSafeInteger(meta.declaredLength) && meta.declaredLength! >= 0 &&
        (Boolean(meta.contentEncoding) || meta.declaredLength === raw.length))), "source_unavailable");
    obtained.push({ raw, meta });
    return { raw, meta };
  }
  try {
    const opening = await request(PHOENIX_EFD_INDEX_URL, "opening_index");
    const family = selectPhoenixEfdFamily(parsePhoenixEfdIndex(html(opening.raw)), input.spenderName,
      input.electionDate, phoenixEfdObservationDay(opening.meta.startedAt));
    await request(PHOENIX_EFD_BALLOT_URL, "opening_ballot");
    for (const [i, row] of family.entries()) await request(row.sourceUrl, `opening_pdf_${i}`, true);
    await request(PHOENIX_EFD_INDEX_URL, "closing_index");
    await request(PHOENIX_EFD_BALLOT_URL, "closing_ballot");
    for (const [i, row] of family.entries()) await request(row.sourceUrl, `closing_pdf_${i}`, true);
    return await readBundle(path, input.spenderName, input.electionDate);
  } catch (error) {
    if (error instanceof PhoenixEfdHold && error.reason === "source_unavailable" && input.replay) {
      // An incomplete refresh may still have seen a new filing, a changed
      // ballot or a re-issued PDF. That knowledge outranks the saved edition.
      for (const { raw, meta } of obtained) {
        if (meta.url === PHOENIX_EFD_INDEX_URL) efdCheck(isDeepStrictEqual(selectPhoenixEfdFamily(parsePhoenixEfdIndex(html(raw)),
          input.spenderName, input.electionDate, phoenixEfdObservationDay(meta.startedAt)), input.replay.family), "publication_census_changed");
        else if (meta.url === PHOENIX_EFD_BALLOT_URL) efdCheck(isDeepStrictEqual(parsePhoenixCouncilBallot(html(raw)), input.replay.ballot), "certified_ballot_changed");
        else efdCheck(input.replay.scans.some(s => s.row.sourceUrl === meta.url && s.sha256 === meta.sha256), "whole_pdf_edition_changed");
      }
    }
    throw error;
  }
}
