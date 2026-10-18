import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  getOhioSosArtifactPaths,
  getOhioSosArtifactStatus,
  getOhioSosCycleArtifactStatus,
  hashOhioSosFile,
  ohioSosArtifactFileName,
  ohioSosCycleArtifacts,
  readOhioSosArtifactManifest,
  storeOhioSosArtifact,
  OHIO_SOS_ARTIFACT_SCHEMA_VERSION,
} from "../../../src/pipeline/ohioFinance/ohioSosArtifactCache.js";

const NOW = new Date("2026-08-04T17:00:00Z");

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/ohioFinance/${name}`, import.meta.url));
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ohio-sos-cache-"));
});

describe("ohioSosArtifactFileName", () => {
  it("names cumulative and per-year products", () => {
    expect(ohioSosArtifactFileName({ productKey: "candidate_list" })).toBe("ACT_CAN_LIST.CSV");
    expect(ohioSosArtifactFileName({ productKey: "candidate_contributions", transactionYear: 2026 })).toBe(
      "CAC_CON_2026.CSV"
    );
  });

  it("refuses a year on a cumulative product and a missing year on an annual one", () => {
    expect(() => ohioSosArtifactFileName({ productKey: "candidate_list", transactionYear: 2026 })).toThrow(
      /not published per year/
    );
    expect(() => ohioSosArtifactFileName({ productKey: "candidate_contributions" })).toThrow(
      /requires a transaction year/
    );
  });

  it("rejects an implausible transaction year", () => {
    expect(() => ohioSosArtifactFileName({ productKey: "pac_contributions", transactionYear: 1899 })).toThrow(
      /Invalid Ohio SoS transaction year/
    );
  });
});

describe("ohioSosCycleArtifacts", () => {
  it("covers the cycle year and the year before it for the annual products", () => {
    const fileNames = ohioSosCycleArtifacts(2026).map((artifact) => artifact.fileName);

    expect(fileNames).toContain("ACT_CAN_LIST.CSV");
    expect(fileNames).toContain("CAN_COVER.CSV");
    expect(fileNames).toContain("CAC_CON_2025.CSV");
    expect(fileNames).toContain("CAC_CON_2026.CSV");
    // Five cumulative files plus six annual products across two years.
    expect(fileNames).toHaveLength(17);
    expect(new Set(fileNames).size).toBe(17);
  });
});

describe("storeOhioSosArtifact", () => {
  it("installs private originals and manifests regardless of incoming permissions", async () => {
    const incoming = join(cacheDir, "incoming.csv");
    await writeFile(incoming, await readFile(fixturePath("act_can_list_sample.csv")));
    await chmod(incoming, 0o644);
    await chmod(cacheDir, 0o755);
    const manifest = await storeOhioSosArtifact({ cacheDir, productKey: "candidate_list", downloadPath: incoming, retrievedAt: NOW, now: NOW });
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(manifest.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(manifest.manifestPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(manifest.filePath)).toEqual(await readFile(incoming));
  });
  it("validates, hashes, and installs a download with a manifest", async () => {
    const manifest = await storeOhioSosArtifact({
      cacheDir,
      productKey: "candidate_list",
      downloadPath: fixturePath("act_can_list_sample.csv"),
      portalDateModified: "08/04/2026 10:30 AM",
      retrievedAt: NOW,
      now: NOW,
    });

    const paths = getOhioSosArtifactPaths({ cacheDir, productKey: "candidate_list" });
    expect(manifest).toMatchObject({
      version: OHIO_SOS_ARTIFACT_SCHEMA_VERSION,
      productKey: "candidate_list",
      fileName: "ACT_CAN_LIST.CSV",
      transactionYear: null,
      filePath: paths.filePath,
      portalDateModified: "08/04/2026 10:30 AM",
      retrievedAt: NOW.toISOString(),
      rowCount: 5,
      encoding: "windows-1252",
      rowSeparator: "\r",
      malformedRowCount: 0,
      reportKeys31u: [],
    });

    const { sha256, byteSize } = await hashOhioSosFile(fixturePath("act_can_list_sample.csv"));
    expect(manifest.sha256).toBe(sha256);
    expect(manifest.byteSize).toBe(byteSize);

    // Bytes are copied verbatim — no re-encoding on the way into the cache.
    expect(await readFile(paths.filePath)).toEqual(await readFile(fixturePath("act_can_list_sample.csv")));
    expect(await readOhioSosArtifactManifest(paths.manifestPath)).toEqual(manifest);
  });

  it("records the 31-U report keys found in an expenditure download", async () => {
    const manifest = await storeOhioSosArtifact({
      cacheDir,
      productKey: "pac_expenditures",
      transactionYear: 2026,
      downloadPath: fixturePath("pac_exp_31u_sample.csv"),
      retrievedAt: NOW,
      now: NOW,
    });

    expect(manifest.fileName).toBe("PAC_EXP_2026.CSV");
    expect(manifest.transactionYear).toBe(2026);
    expect(manifest.reportKeys31u).toEqual(["501544249"]);
  });

  it("rejects a download whose header does not match the pinned schema, leaving the cache untouched", async () => {
    const good = await storeOhioSosArtifact({
      cacheDir,
      productKey: "candidate_list",
      downloadPath: fixturePath("act_can_list_sample.csv"),
      retrievedAt: NOW,
      now: NOW,
    });

    const wrong = join(cacheDir, "download.csv");
    await writeFile(wrong, "COM_NAME,MASTER_KEY\rA,1\r", "latin1");
    await expect(
      storeOhioSosArtifact({
        cacheDir,
        productKey: "candidate_list",
        downloadPath: wrong,
        retrievedAt: NOW,
        now: NOW,
      })
    ).rejects.toThrow(/header does not match the pinned schema/);

    const paths = getOhioSosArtifactPaths({ cacheDir, productKey: "candidate_list" });
    expect(await readOhioSosArtifactManifest(paths.manifestPath)).toEqual(good);
  });

  it("rejects a download with no data rows", async () => {
    const empty = join(cacheDir, "empty.csv");
    await writeFile(
      empty,
      "COM_NAME,MASTER_KEY,COM_ADDRESS,COM_CITY,COM_STATE,COM_ZIP,PAC_REG_NO,TREA_FIRST_NAME,TREA_LAST_NAME,TREA_MIDDLE_NAME,TREA_SUFFIX,TREA_ADDRESS,TREA_CITY,TREA_STATE,TREA_ZIP,DEP_FIRST_NAME,DEP_LAST_NAME,SPONSOR\r",
      "latin1"
    );

    await expect(
      storeOhioSosArtifact({ cacheDir, productKey: "pac_list", downloadPath: empty, retrievedAt: NOW, now: NOW })
    ).rejects.toThrow(/has no data rows/);
  });
});

describe("getOhioSosArtifactStatus", () => {
  it("reports a product that has never been downloaded as missing", async () => {
    const status = await getOhioSosArtifactStatus({ cacheDir, productKey: "candidate_list" });
    expect(status).toMatchObject({ status: "missing", fileName: "ACT_CAN_LIST.CSV", manifest: null });
  });

  it("reports a freshly stored artifact as ready", async () => {
    await storeOhioSosArtifact({
      cacheDir,
      productKey: "candidate_list",
      downloadPath: fixturePath("act_can_list_sample.csv"),
      retrievedAt: NOW,
      now: NOW,
    });
    const status = await getOhioSosArtifactStatus({ cacheDir, productKey: "candidate_list" });
    expect(status.status).toBe("ready");
  });

  it("reports a truncated or overwritten file as stale rather than ready", async () => {
    await storeOhioSosArtifact({
      cacheDir,
      productKey: "candidate_list",
      downloadPath: fixturePath("act_can_list_sample.csv"),
      retrievedAt: NOW,
      now: NOW,
    });
    const paths = getOhioSosArtifactPaths({ cacheDir, productKey: "candidate_list" });
    await writeFile(paths.filePath, "COM_NAME\r", "latin1");

    const status = await getOhioSosArtifactStatus({ cacheDir, productKey: "candidate_list" });
    expect(status.status).toBe("stale");
  });

  it("summarizes the whole cycle", async () => {
    await storeOhioSosArtifact({
      cacheDir,
      productKey: "candidate_list",
      downloadPath: fixturePath("act_can_list_sample.csv"),
      retrievedAt: NOW,
      now: NOW,
    });
    const statuses = await getOhioSosCycleArtifactStatus({ cacheDir, cycleYear: 2026 });

    expect(statuses).toHaveLength(17);
    expect(statuses.filter((status) => status.status === "ready").map((status) => status.fileName)).toEqual([
      "ACT_CAN_LIST.CSV",
    ]);
    expect(statuses.filter((status) => status.status === "missing")).toHaveLength(16);
  });
});

describe("readOhioSosArtifactManifest", () => {
  it("returns null for a missing or unreadable manifest instead of throwing", async () => {
    expect(await readOhioSosArtifactManifest(join(cacheDir, "nope.manifest.json"))).toBeNull();

    const broken = join(cacheDir, "broken.manifest.json");
    await writeFile(broken, "{ not json", "utf8");
    expect(await readOhioSosArtifactManifest(broken)).toBeNull();
  });

  it("rejects a manifest written by an older schema version", async () => {
    const path = join(cacheDir, "old.manifest.json");
    await writeFile(path, JSON.stringify({ version: 0, productKey: "candidate_list" }), "utf8");
    expect(await readOhioSosArtifactManifest(path)).toBeNull();
  });
});
