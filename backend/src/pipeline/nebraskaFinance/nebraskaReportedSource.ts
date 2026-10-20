import fs from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  neCheck,
  neHold,
  type NebraskaSourceKind,
} from "./nebraskaReportedNative.js";
import {
  NebraskaOriginalSequence,
  NEBRASKA_REPORTED_CACHE,
  nePrivateDirectory,
  nePrivateRead,
  neSha,
  type NebraskaOriginal,
  type NebraskaOriginalManifest,
  type NebraskaOriginalTransport,
} from "./nebraskaReportedOriginals.js";
import {
  runNebraskaNativeProtocol,
  type NebraskaNativeDataset,
} from "./nebraskaReportedProtocol.js";

export type NebraskaReportedSourceFacts = {
  manifestSha256: string;
  observedAt: string;
  completedAt: string;
  observations: readonly Readonly<
    Omit<NebraskaOriginal, "requestFile" | "requestSha256" | "file">
  >[];
};
export type NebraskaReportedSourcePacket = Readonly<
  NebraskaNativeDataset & {
    kind: NebraskaSourceKind;
    year: number;
    source: Readonly<NebraskaReportedSourceFacts>;
  }
>;
type Pointer = {
  version: 1;
  kind: NebraskaSourceKind;
  year: number;
  directory: string;
  manifestSha256: string;
};
const verified = new WeakSet<object>();
export const isVerifiedNebraskaReportedSource = (
  value: unknown,
): value is NebraskaReportedSourcePacket =>
  !!value && typeof value === "object" && verified.has(value);
function seal(
  kind: NebraskaSourceKind,
  year: number,
  data: NebraskaNativeDataset,
  manifest: NebraskaOriginalManifest,
  digest: string,
): NebraskaReportedSourcePacket {
  neCheck(manifest.records.length > 0, "empty_source_observations");
  const observations = manifest.records.map(
    ({
      requestFile: _request,
      requestSha256: _requestSha,
      file: _file,
      ...record
    }) => Object.freeze(record),
  );
  const observedAt = observations.map((record) => record.startedAt).sort()[0]!,
    completedAt = observations
      .map((record) => record.completedAt)
      .sort()
      .at(-1)!;
  for (const rows of [data.registrations, data.receipts, data.allocations])
    if (rows) {
      rows.forEach(Object.freeze);
      Object.freeze(rows);
    }
  const source = Object.freeze({
    manifestSha256: digest,
    observedAt,
    completedAt,
    observations: Object.freeze(observations),
  });
  const packet = Object.freeze({ ...data, kind, year, source });
  verified.add(packet);
  return packet;
}
async function replay(
  directory: string,
  manifest: NebraskaOriginalManifest,
  digest: string,
): Promise<NebraskaReportedSourcePacket> {
  const sequence = await NebraskaOriginalSequence.reopen(directory, manifest),
    data = await runNebraskaNativeProtocol(sequence);
  sequence.finish();
  return seal(manifest.kind, manifest.year, data, manifest, digest);
}
async function saved(
  root: string,
  kind: NebraskaSourceKind,
  year: number,
): Promise<NebraskaReportedSourcePacket | null> {
  try {
    const pointer = JSON.parse(
      (
        await nePrivateRead(resolve(root, `source-${kind}-${year}.json`), 65536)
      ).toString("utf8"),
    ) as Pointer;
    neCheck(
      pointer.version === 1 &&
        pointer.kind === kind &&
        pointer.year === year &&
        /^packet-[a-f0-9-]{36}$/.test(pointer.directory) &&
        /^[a-f0-9]{64}$/.test(pointer.manifestSha256),
      "source_pointer",
    );
    const directory = resolve(root, pointer.directory),
      raw = await nePrivateRead(
        resolve(directory, "manifest.json"),
        16 * 1024 * 1024,
      );
    neCheck(neSha(raw) === pointer.manifestSha256, "source_manifest_integrity");
    const manifest = JSON.parse(
      raw.toString("utf8"),
    ) as NebraskaOriginalManifest;
    neCheck(
      manifest.kind === kind && manifest.year === year,
      "source_manifest_scope",
    );
    return await replay(directory, manifest, pointer.manifestSha256);
  } catch {
    return null;
  }
}

/** Saved originals are replayed before any network access. Only the complete
 * native protocol can seal a packet; pointer health, mtime and arbitrary DTOs
 * cannot grant monetary authority or advance original observation clocks. */
export async function getNebraskaReportedSource(input: {
  kind: NebraskaSourceKind;
  year: number;
  cacheDir?: string;
  refresh?: boolean;
  transport?: NebraskaOriginalTransport;
}): Promise<NebraskaReportedSourcePacket> {
  neCheck(
    ["registry", "ie", "committee"].includes(input.kind) &&
      Number.isSafeInteger(input.year) &&
      input.year >= 2021 &&
      input.year <= 2100,
    "source_scope",
  );
  const root = resolve(input.cacheDir ?? NEBRASKA_REPORTED_CACHE);
  await nePrivateDirectory(root);
  if (!input.refresh) {
    const packet = await saved(root, input.kind, input.year);
    if (
      packet &&
      Date.now() - Date.parse(packet.source.observedAt) <= 7 * 86400000
    )
      return packet;
  }
  const sequence = await NebraskaOriginalSequence.capture(
    input.kind,
    input.year,
    root,
    input.transport,
  );
  try {
    await runNebraskaNativeProtocol(sequence);
    const manifest = sequence.finish(),
      raw = Buffer.from(JSON.stringify(manifest) + "\n"),
      digest = neSha(raw);
    await fs.writeFile(resolve(sequence.directory, "manifest.json"), raw, {
      mode: 0o600,
      flag: "wx",
    });
    // Reopen the immutable originals, including request/body integrity, EOF,
    // real clocks and complete scope, before accepting the captured dataset.
    const packet = await replay(sequence.directory, manifest, digest);
    const pointer: Pointer = {
        version: 1,
        kind: input.kind,
        year: input.year,
        directory: sequence.directory.split(/[\\/]/).at(-1)!,
        manifestSha256: digest,
      },
      temporary = resolve(root, `pointer-${randomUUID()}.json`);
    await fs.writeFile(temporary, JSON.stringify(pointer) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(
      temporary,
      resolve(root, `source-${input.kind}-${input.year}.json`),
    );
    return packet;
  } catch (error) {
    if (error instanceof Error && error.name === "NebraskaReportedSourceError")
      throw error;
    return neHold("native_acquisition_or_replay_failed");
  }
}
