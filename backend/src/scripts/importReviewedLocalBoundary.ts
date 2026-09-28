import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { fetchLocalBoundarySource, insertReviewedLocalBoundary, parseLocalBoundaryImport } from "../pipeline/address/localSpecialBoundaryImport.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

function readFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function countPieces(geometry: unknown): number {
  const value = geometry as { type: string; coordinates: unknown[] };
  return value.type === "Polygon" ? 1 : value.coordinates.length;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("manual:local-boundary:import", argv, [
    { name: "--file", value: "space" },
    { name: "--write", value: "none" },
    { name: "--reviewed", value: "none" },
  ]);
  const write = argv.includes("--write");
  if (write !== argv.includes("--reviewed")) {
    throw new Error("--write and --reviewed must be supplied together after official geometry and ballot review");
  }
  const payload = parseLocalBoundaryImport(JSON.parse(await readFile(readFlag(argv, "--file"), "utf8")));
  const source = await fetchLocalBoundarySource(payload);
  if (!write) {
    console.log(JSON.stringify({
      dryRun: true,
      districtKey: payload.district_key,
      districtName: payload.district_name,
      boundarySourceUrls: source.sourceUrls,
      sourceSha256: source.sourceSha256,
      eligibilitySourceUrl: payload.eligibility_source_url,
      geometryType: (source.geometry as { type: string }).type,
      pieces: countPieces(source.geometry),
      exclusionPieces: source.exclusionGeometry === null ? 0 : countPieces(source.exclusionGeometry),
    }, null, 2));
    return;
  }

  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL ?? "";
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const districtId = await insertReviewedLocalBoundary(client, payload, source);
    console.log(JSON.stringify({ dryRun: false, districtKey: payload.district_key, districtId }));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Local boundary import failed:", error);
    process.exitCode = 1;
  });
}
