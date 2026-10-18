import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOhioSos31uOriginals } from "../../../src/pipeline/ohioFinance/ohioSos31uOriginals.js";
import { readOhioSos31uDetailBundle } from "../../../src/pipeline/ohioFinance/ohioSosArtifactAcquisition.js";
import { OHIO_SOS_31U_DETAIL_HEADER, ohioSos31uDetailUrl } from "../../../src/pipeline/ohioFinance/ohioSos31uDetail.js";

let cacheDir: string, root: string;
const csv = () => [...OHIO_SOS_31U_DETAIL_HEADER].join(",") + "\r" +
  ["", "Synthetic Vendor", "", "", "OH", "", "PRE-GENERAL", "100.00", "2026", "10/01/2026", "", "Synthetic purpose", "Synthetic PAC", "HOUSE", "Synthetic Candidate", "SUPPORT"].join(",") + "\r";
const sha = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");
async function capture(change: Record<string, unknown> = {}, body = Buffer.from(csv())) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entry = { reportKey: "300", file: "300.csv", sourceUrl: ohioSos31uDetailUrl("300"), captureMethod: "native-browser-completed-download",
    sourceRetrievedAt: "2026-01-01T00:00:00.000Z", bytes: body.length, sha256: sha(body), ...change };
  await writeFile(join(root, "300.csv"), body, { mode: 0o600 });
  await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, cycleYear: 2026, entries: [entry] }), { mode: 0o600 });
}
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "oh-native-ie-")); root = join(cacheDir, "original-details", "2026"); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
describe("saved native Ohio 31-U original replay", () => {
  it("returns null only when no original capture exists, leaving legacy readers usable", async () => {
    expect(await readOhioSos31uOriginals({ cacheDir, cycleYear: 2026 })).toBeNull();
    await writeFile(join(cacheDir, "31U_DETAIL_2026.json"), JSON.stringify({ version: 1, cycleYear: 2026, reports: [] }));
    expect(await readOhioSos31uDetailBundle({ cacheDir, cycleYear: 2026 })).toEqual([]);
  });
  it("replays genuine CSV shape before an older parsed bundle", async () => {
    await capture(); await writeFile(join(cacheDir, "31U_DETAIL_2026.json"), "invalid older bundle");
    expect(await readOhioSos31uDetailBundle({ cacheDir, cycleYear: 2026 })).toMatchObject([{ reportKey: "300", rows: [{ amountCents: 10000, direction: "support", year: 2026 }] }]);
  });
  it("holds an incomplete new capture instead of falling back to an older bundle", async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(cacheDir, "31U_DETAIL_2026.json"), JSON.stringify({ version: 1, cycleYear: 2026, reports: [] }));
    await expect(readOhioSos31uDetailBundle({ cacheDir, cycleYear: 2026 })).rejects.toThrow();
  });
  it.each([{ sha256: "0".repeat(64) }, { bytes: 1 }, { sourceUrl: ohioSos31uDetailUrl("301") },
    { file: "../other.csv" }, { captureMethod: "invented" }, { sourceRetrievedAt: "2999-01-01T00:00:00.000Z" }])("holds a corrupt or misbound original %j", async change => {
    await capture(change); await writeFile(join(cacheDir, "31U_DETAIL_2026.json"), JSON.stringify({ version: 1, cycleYear: 2026, reports: [] }));
    await expect(readOhioSos31uDetailBundle({ cacheDir, cycleYear: 2026 })).rejects.toThrow();
  });
  it("rejects symlinks and invalid original encoding rather than substituting cached money", async () => {
    await capture(); await rm(join(root, "300.csv")); await writeFile(join(cacheDir, "outside.csv"), csv(), { mode: 0o600 });
    await symlink(join(cacheDir, "outside.csv"), join(root, "300.csv"));
    await expect(readOhioSos31uOriginals({ cacheDir, cycleYear: 2026 })).rejects.toThrow();
    await rm(join(root, "300.csv")); await capture({}, Buffer.from([255]));
    await expect(readOhioSos31uOriginals({ cacheDir, cycleYear: 2026 })).rejects.toThrow();
  });
});
