import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { fetchDcSmdLayer, insertDcSmdBoundaries } from "../pipeline/address/dcAncSmdBoundaryImport.js";
import { clearLocalSpecialBoundaryCache } from "../pipeline/address/localSpecialDistrictEligibility.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Loads the 345 DC Advisory Neighborhood Commission single-member districts
// as reviewed local_special boundaries. A dry run prints the layer hash; a
// write refetches and requires that hash:
//   npm run manual:dc-anc-smd:import
//   npm run manual:dc-anc-smd:import -- --write --reviewed --expected-sha <hash>
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("manual:dc-anc-smd:import", argv, [
    { name: "--write", value: "none" },
    { name: "--reviewed", value: "none" },
    { name: "--expected-sha", value: "space" },
  ]);
  const write = argv.includes("--write");
  if (write !== argv.includes("--reviewed")) {
    throw new Error("--write and --reviewed must be supplied together after the layer has been reviewed");
  }
  const layer = await fetchDcSmdLayer();
  if (!write) {
    console.log(JSON.stringify({
      dryRun: true,
      sourceUrl: layer.sourceUrl,
      sourceSha256: layer.sourceSha256,
      districts: layer.boundaries.length,
      commissions: new Set(layer.boundaries.map((entry) => entry.anc_id)).size,
      first: layer.boundaries[0]?.smd_id,
      last: layer.boundaries[layer.boundaries.length - 1]?.smd_id,
    }, null, 2));
    return;
  }
  const shaIndex = argv.indexOf("--expected-sha");
  const expected = shaIndex < 0 ? "" : argv[shaIndex + 1] ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("--expected-sha <hash from the dry run> is required with --write");

  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL ?? "";
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const result = await insertDcSmdBoundaries(client, layer, expected);
    clearLocalSpecialBoundaryCache();
    console.log(JSON.stringify({ dryRun: false, ...result }));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("DC ANC SMD import failed:", error);
    process.exitCode = 1;
  });
}
