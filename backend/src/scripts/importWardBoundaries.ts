import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { clearLocalSpecialBoundaryCache } from "../pipeline/address/localSpecialDistrictEligibility.js";
import {
  fetchWardLayer,
  importWardBoundaries,
  parseWardBoundaryImport,
  planWardElections,
} from "../pipeline/address/wardBoundaryImport.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Loads one body's council wards or trustee areas as reviewed local_special
// boundaries and moves the ward seats' elections off the city / school row.
// A dry run fetches the official map, prints its hash and which election
// moves to which ward; a write refetches and requires that hash in the
// payload's expected_source_sha256:
//   npm run manual:ward-boundaries:import -- --file payload.json
//   npm run manual:ward-boundaries:import -- --file payload.json --write --reviewed
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
  assertKnownCliFlags("manual:ward-boundaries:import", argv, [
    { name: "--file", value: "space" },
    { name: "--write", value: "none" },
    { name: "--reviewed", value: "none" },
  ]);
  const write = argv.includes("--write");
  if (write !== argv.includes("--reviewed")) {
    throw new Error("--write and --reviewed must be supplied together after official geometry and ballot review");
  }
  const payload = parseWardBoundaryImport(JSON.parse(await readFile(readFlag(argv, "--file"), "utf8")));
  const layer = await fetchWardLayer(payload);

  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL ?? "";
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const plan = await planWardElections(client, payload);
    if (!write) {
      console.log(JSON.stringify({
        dryRun: true,
        bodyKey: payload.body_key,
        jurisdiction: plan.jurisdiction_name,
        boundarySourceUrl: layer.sourceUrl,
        sourceSha256: layer.sourceSha256,
        seats: layer.boundaries.map((boundary) => ({
          seat: boundary.seat,
          districtKey: boundary.district_key,
          districtName: boundary.district_name,
          pieces: countPieces(boundary.geometry),
          elections: plan.seats.find((entry) => entry.seat === boundary.seat)?.elections.map((election) => election.official_ballot_title) ?? [],
        })),
        unmatchedTitles: plan.unmatched.map((entry) => entry.official_ballot_title),
      }, null, 2));
      return;
    }
    const result = await importWardBoundaries(client, payload, layer, plan);
    clearLocalSpecialBoundaryCache();
    console.log(JSON.stringify({ dryRun: false, bodyKey: payload.body_key, ...result }));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Ward boundary import failed:", error);
    process.exitCode = 1;
  });
}
