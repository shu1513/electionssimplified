// Immutable public JSON observations. Read the saved generation before making
// fresh requests; only a complete observation replaces its pointer. Street
// addresses stay in restricted raw files, never in product tables or logs.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type Capture = {
  key: string; url: string; method: string; requestBody: string | null;
  startedAt: string; completedAt: string; status: number; contentType: string;
  bytes: number; sha256: string; file: string;
};
type Observation = { version: 1; captures: Capture[] };
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const MAX_BYTES = 8 * 1024 * 1024;

// API arrays may reorder between requests. Versions are ordered newest first;
// keep that order so a current-version change cannot disappear in comparison.
function canonical(value: unknown, field = ""): string {
  if (Array.isArray(value)) {
    const items = value.map(item => canonical(item));
    return JSON.stringify(field === "versions" ? items : items.sort());
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item, key)]));
  }
  return JSON.stringify(value);
}

function requestKey(url: string, method: string, requestBody: string | null): string {
  return sha(Buffer.from(JSON.stringify([url, method, requestBody])));
}

async function readObservation(directory: string): Promise<Map<string, { capture: Capture; body: Buffer }> | null> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Observation;
  if (manifest.version !== 1 || !Array.isArray(manifest.captures) || manifest.captures.length > 30) {
    throw new Error("Invalid South Carolina source observation");
  }
  const result = new Map<string, { capture: Capture; body: Buffer }>();
  for (const capture of manifest.captures) {
    if (typeof capture.file !== "string" || basename(capture.file) !== capture.file
      || !/^\d+\.raw$/.test(capture.file) || capture.status !== 200
      || !capture.contentType?.includes("application/json")
      || !Number.isSafeInteger(capture.bytes) || capture.bytes > MAX_BYTES || capture.bytes < 0
      || capture.key !== requestKey(capture.url, capture.method, capture.requestBody)
      || !Number.isFinite(Date.parse(capture.startedAt))
      || !Number.isFinite(Date.parse(capture.completedAt))
      || Date.parse(capture.completedAt) < Date.parse(capture.startedAt)) {
      throw new Error("Invalid South Carolina source capture metadata");
    }
    const body = await readFile(join(directory, capture.file));
    if (body.length !== capture.bytes || sha(body) !== capture.sha256) {
      throw new Error("South Carolina source capture hash mismatch");
    }
    const prior = result.get(capture.key);
    if (prior && canonical(JSON.parse(prior.body.toString())) !== canonical(JSON.parse(body.toString()))) {
      throw new Error("South Carolina source changed inside an observation");
    }
    result.set(capture.key, { capture, body });
  }
  return result.size ? result : null;
}

export async function createSouthCarolinaSourceSession(input: {
  cacheDir: string; candidateFilerId: number; electionYear: number; fetchImpl?: typeof fetch;
}): Promise<{
  fetchImpl: typeof fetch;
  finish: () => Promise<{ stablePair: boolean; diagnostics: string[]; directory: string }>;
}> {
  if (!Number.isSafeInteger(input.candidateFilerId) || input.candidateFilerId <= 0
    || !Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) {
    throw new Error("Invalid South Carolina source cache scope");
  }
  const scope = resolve(input.cacheDir, `${input.candidateFilerId}-${input.electionYear}`);
  await mkdir(scope, { recursive: true, mode: 0o700 });
  await chmod(scope, 0o700);
  let saved: Awaited<ReturnType<typeof readObservation>> = null;
  const diagnostics: string[] = [];
  try {
    const pointer = JSON.parse(await readFile(join(scope, "latest.json"), "utf8")) as { generation: string };
    if (!/^observation-[a-zA-Z0-9]+$/.test(pointer.generation)) throw new Error("Invalid source pointer");
    saved = await readObservation(join(scope, pointer.generation));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    diagnostics.push(code === "ENOENT" ? "No saved complete financial observation" : "Saved financial observation failed integrity checks");
  }
  // All saved bytes are now in memory. A partial fresh generation never changes
  // the pointer, and cannot be mistaken for an independently acquired opening.
  const directory = await mkdtemp(join(scope, "observation-"));
  const captures: Capture[] = [];
  const sourceFetch = input.fetchImpl ?? fetch;
  let totalBytes = 0;
  let captureUnavailable = false;
  let requestCount = 0;
  const fetchImpl: typeof fetch = async (request, init) => {
    const url = String(request);
    const method = init?.method ?? "GET";
    const requestBody = typeof init?.body === "string" ? init.body : null;
    if (!/^https:\/\/ethicsfiling\.sc\.gov\/api\/(?:Ethics\/Get\/Public\/Candidate\/Reports|Ethics\/Get\/Public\/Candidate\/Report\/Details\/\d+|Candidate\/Contribution\/Search\/)\/?$/.test(url)
      || !["GET", "POST"].includes(method)) {
      throw new Error("South Carolina source request outside bounded public scope");
    }
    requestCount++;
    if (requestCount > 30) captureUnavailable = true;
    const headers = new Headers(init?.headers);
    if (headers.has("authorization") || headers.has("cookie")) {
      throw new Error("South Carolina public source request must be unauthenticated");
    }
    headers.set("User-Agent", "Mozilla/5.0");
    const startedAt = new Date().toISOString();
    const response = await sourceFetch(request, { ...init, headers });
    if (captureUnavailable) return response;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // Read a clone so hitting a journal bound leaves the original stream intact.
    const reader = response.clone().body?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        totalBytes += next.value.length;
        if (bytes > MAX_BYTES || totalBytes > 60 * 1024 * 1024) {
          captureUnavailable = true;
          // Tee cancellation waits for the other branch; let the direct client consume it.
          void reader.cancel().catch(() => {});
          return response;
        }
        chunks.push(next.value);
      }
    }
    const body = Buffer.concat(chunks);
    const capture: Capture = {
      key: requestKey(url, method, requestBody), url, method, requestBody,
      startedAt, completedAt: new Date().toISOString(), status: response.status,
      contentType: response.headers.get("content-type") ?? "", bytes,
      sha256: sha(body), file: `${String(captures.length).padStart(4, "0")}.raw`,
    };
    if (!captureUnavailable) {
      try {
        await writeFile(join(directory, capture.file), body, { mode: 0o600, flag: "wx" });
        captures.push(capture);
        await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 1, captures }), { mode: 0o600 });
      } catch {
        // The direct client can still validate the original HTTP response.
        // This generation can never authorize a donor replacement.
        captureUnavailable = true;
      }
    }
    return response;
  };
  return {
    fetchImpl,
    finish: async () => {
      if (captureUnavailable) throw new Error("South Carolina raw capture unavailable");
      const fresh = await readObservation(directory);
      if (!fresh) throw new Error("Empty South Carolina financial observation");
      let stablePair = Boolean(saved && saved.size === fresh.size);
      for (const [key, current] of fresh) {
        const opening = saved?.get(key);
        if (!opening || Date.parse(opening.capture.completedAt) > Date.parse(current.capture.startedAt)
          || canonical(JSON.parse(opening.body.toString())) !== canonical(JSON.parse(current.body.toString()))) {
          stablePair = false;
        }
      }
      if (saved && !stablePair) diagnostics.push("Financial source changed; saved closing requires another fresh observation");
      const temporary = join(scope, `${basename(directory)}.pointer.tmp`);
      await writeFile(temporary, JSON.stringify({ generation: basename(directory) }), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(scope, "latest.json"));
      return { stablePair, diagnostics, directory };
    },
  };
}
