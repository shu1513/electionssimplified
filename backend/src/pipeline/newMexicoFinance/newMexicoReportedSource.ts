import fs from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NewMexicoReportedSourceError } from "./newMexicoReportedNative.js";
import {
  NM_REPORTED_CACHE,
  NewMexicoOriginalSequence,
  nmPrivateDirectory,
  nmPrivateRead,
  nmSha,
  nmSourceScope,
  type NewMexicoOriginal,
  type NewMexicoOriginalManifest,
  type NewMexicoReportedScope,
} from "./newMexicoReportedOriginals.js";
import {
  runNewMexicoNativeProtocol,
  type NewMexicoNativeDataset,
} from "./newMexicoReportedProtocol.js";

export type NewMexicoReportedSourceFacts = {
  manifestSha256: string;
  observedAt: string;
  completedAt: string;
  observations: readonly Readonly<
    Omit<NewMexicoOriginal, "file" | "requestFile" | "requestSha256">
  >[];
};
export type NewMexicoReportedSourcePacket = Readonly<
  NewMexicoNativeDataset & {
    scope: Readonly<NewMexicoReportedScope>;
    source: Readonly<NewMexicoReportedSourceFacts>;
  }
>;
const verified = new WeakSet<object>();
export function isVerifiedNewMexicoReportedSource(
  value: unknown,
): value is NewMexicoReportedSourcePacket {
  return value !== null && typeof value === "object" && verified.has(value);
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
function seal(
  data: NewMexicoNativeDataset,
  manifest: NewMexicoOriginalManifest,
  digest: string,
): NewMexicoReportedSourcePacket {
  const observations = manifest.records.map(
    ({
      file: _file,
      requestFile: _requestFile,
      requestSha256: _requestSha,
      ...original
    }) => original,
  );
  const source = {
    manifestSha256: digest,
    observedAt: observations.map((x) => x.startedAt).sort()[0]!,
    completedAt: observations
      .map((x) => x.completedAt)
      .sort()
      .at(-1)!,
    observations,
  };
  const packet = { ...data, scope: { ...manifest.scope }, source };
  freeze(packet);
  verified.add(packet);
  return packet;
}
async function replay(
  directory: string,
  manifest: NewMexicoOriginalManifest,
  digest: string,
): Promise<NewMexicoReportedSourcePacket> {
  const sequence = await NewMexicoOriginalSequence.reopen(directory, manifest),
    data = await runNewMexicoNativeProtocol(sequence);
  sequence.finish();
  return seal(data, manifest, digest);
}

/** Generic UUID directories carry no derived per-person filenames. A matching
 * manifest is only a replay candidate; every original, clock, request, native
 * population and monetary control must qualify again. */
async function saved(
  root: string,
  scope: NewMexicoReportedScope,
): Promise<NewMexicoReportedSourcePacket | null> {
  const candidates: {
    directory: string;
    raw: Buffer;
    manifest: NewMexicoOriginalManifest;
    first: number;
  }[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^packet-[a-f0-9-]{36}$/.test(entry.name)
    )
      continue;
    try {
      const directory = resolve(root, entry.name),
        raw = await nmPrivateRead(
          resolve(directory, "manifest.json"),
          32 * 1024 * 1024,
        ),
        manifest = JSON.parse(
          raw.toString("utf8"),
        ) as NewMexicoOriginalManifest;
      if (
        manifest.version !== 1 ||
        !isDeepStrictEqual(manifest.scope, scope) ||
        !Array.isArray(manifest.records) ||
        !manifest.records.length
      )
        continue;
      const first = Date.parse(manifest.records[0]!.startedAt);
      if (
        !Number.isFinite(first) ||
        first > Date.now() ||
        Date.now() - first > 7 * 86400000
      )
        continue;
      candidates.push({ directory, raw, manifest, first });
    } catch {
      /* Incomplete captures never stand for absence or money. */
    }
  }
  candidates.sort((a, b) => b.first - a.first);
  for (const candidate of candidates) {
    try {
      return await replay(
        candidate.directory,
        candidate.manifest,
        nmSha(candidate.raw),
      );
    } catch {
      /* Try another complete original, then acquire live. */
    }
  }
  return null;
}
export async function getNewMexicoReportedSource(input: {
  scope: NewMexicoReportedScope;
  cacheDir?: string;
  refresh?: boolean;
  transport?: typeof fetch;
}): Promise<NewMexicoReportedSourcePacket> {
  nmSourceScope(input.scope);
  const scope: NewMexicoReportedScope = {
    kind: input.scope.kind,
    year: input.scope.year,
    selector: input.scope.selector,
    ...(input.scope.kind === "committee"
      ? { memberId: input.scope.memberId! }
      : {}),
  };
  const root = resolve(input.cacheDir ?? NM_REPORTED_CACHE);
  await nmPrivateDirectory(root);
  if (!input.refresh) {
    const packet = await saved(root, scope);
    if (packet) return packet;
  }
  const sequence = await NewMexicoOriginalSequence.capture(
    scope,
    root,
    input.transport,
  );
  try {
    await runNewMexicoNativeProtocol(sequence);
    const manifest = sequence.finish(),
      raw = Buffer.from(JSON.stringify(manifest) + "\n");
    await fs.writeFile(resolve(sequence.directory, "manifest.json"), raw, {
      mode: 0o600,
      flag: "wx",
    });
    // Re-read the originals instead of trusting an acquisition success marker.
    return await replay(sequence.directory, manifest, nmSha(raw));
  } catch (error) {
    if (error instanceof NewMexicoReportedSourceError) throw error;
    throw new NewMexicoReportedSourceError(
      "native_acquisition_or_replay_failed",
    );
  }
}
