import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { DEFAULT_NEVADA_AURORA_ARTIFACT_DIR } from "../pipeline/nevadaFinance/nevadaAuroraArtifacts.js";
import { importNevadaCandidateFinance } from "../pipeline/nevadaFinance/nevadaCandidateFinanceImport.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

const SCRIPT_LABEL = "nevada-candidates:finance:import";

function usage(): string {
  return [
    "Usage:",
    "  npm run nevada-candidates:finance:import -- [--artifact-dir DIR] [--election-date 2026-11-03] [--filer NAME] [--committee-donor-artifact FILE] [--write]",
    "",
    "Builds cycle summaries + direct breakdowns from harvested AURORA artifacts",
    "for every active Nevada finance link. Candidates failing the reconciliation",
    "gates are quarantined and reported, never written. Dry-run is the default;",
    "--write is restricted to a local database.",
    "--committee-donor-artifact imports only a complete candidate cash/PAC component",
    "from browser financial observations; direct totals and outside data are preserved.",
  ].join("\n");
}

export function parseNevadaImportArgs(argv: readonly string[]): {
  artifactDir: string;
  electionDate: string;
  onlyFiler: string | null;
  write: boolean;
  committeeDonorArtifactPath?: string;
} {
  assertKnownCliFlags(SCRIPT_LABEL, argv, [
    { name: "--artifact-dir", value: "space" },
    { name: "--election-date", value: "space" },
    { name: "--filer", value: "space" },
    { name: "--write", value: "none" },
    { name: "--committee-donor-artifact", value: "space" },
  ]);
  let artifactDir = DEFAULT_NEVADA_AURORA_ARTIFACT_DIR;
  let electionDate = "2026-11-03";
  let onlyFiler: string | null = null;
  let write = false;
  let committeeDonorArtifactPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write") {
      write = true;
      continue;
    }
    if (
      token === "--artifact-dir" ||
      token === "--election-date" ||
      token === "--filer" ||
      token === "--committee-donor-artifact"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}.\n${usage()}`);
      }
      if (token === "--artifact-dir") artifactDir = value;
      else if (token === "--election-date") electionDate = value;
      else if (token === "--committee-donor-artifact")
        committeeDonorArtifactPath = value;
      else onlyFiler = value;
      index += 1;
    }
  }
  return {
    artifactDir,
    electionDate,
    onlyFiler,
    write,
    ...(committeeDonorArtifactPath === undefined
      ? {}
      : { committeeDonorArtifactPath }),
  };
}

export async function runImportNevadaCandidateFinance(
  argv: readonly string[],
): Promise<void> {
  const args = parseNevadaImportArgs(argv);
  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for Nevada candidate-finance import",
    );
  }
  if (args.write) {
    requireLocalDatabaseTarget(databaseUrl);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await importNevadaCandidateFinance({
      db: pool,
      artifactDir: args.artifactDir,
      electionDate: args.electionDate,
      write: args.write,
      onlyFiler: args.onlyFiler,
      committeeDonorArtifactPath: args.committeeDonorArtifactPath,
    });
    console.log(JSON.stringify({ dryRun: !args.write, ...result }, null, 2));
    if (result.quarantinedCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  runImportNevadaCandidateFinance(process.argv.slice(2)).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
