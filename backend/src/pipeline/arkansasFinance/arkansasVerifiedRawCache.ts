import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ArkansasVerifiedRawResponse } from "./arkansasVerifiedSourceClient.js";

export type ArkansasVerifiedRawCapture = {
  component: "pac" | "outside" | "identity";
  phase: "registry_before" | "registry_after" | "reports_before" | "native_before"
    | "detail" | "pdf" | "native_after" | "reports_after";
  electionYear: number;
  registrationGuid?: string;
  entityId?: string;
  raw: ArkansasVerifiedRawResponse;
};

/** A fresh immutable generation of untouched public response bytes. */
export async function createArkansasVerifiedRawCache(rootDir: string): Promise<{
  directory: string;
  capture: (event: ArkansasVerifiedRawCapture) => Promise<void>;
}> {
  if (!isAbsolute(rootDir)) throw new Error("Arkansas raw cache directory must be absolute");
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(rootDir, "ar-sync-"));
  let sequence = 0;
  return { directory, capture: async event => {
    const { bytesRaw, ...metadata } = event.raw;
    if (bytesRaw.byteLength !== metadata.bytes
      || createHash("sha256").update(bytesRaw).digest("hex") !== metadata.sha256) {
      throw new Error("Arkansas raw source response hash/length mismatch");
    }
    const prefix = String(++sequence).padStart(6, "0");
    const bodyFile = `${prefix}.body`;
    await writeFile(join(directory, bodyFile), bytesRaw, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, `${prefix}.json`), JSON.stringify({
      component: event.component, phase: event.phase, electionYear: event.electionYear,
      registrationGuid: event.registrationGuid, entityId: event.entityId,
      ...metadata, bodyFile,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } };
}
