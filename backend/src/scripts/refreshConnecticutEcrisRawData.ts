import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjectEnv } from "../config/env.js";
import {
  CONNECTICUT_ECRIS_FETCH_TIMEOUT_MS,
  DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR,
  buildConnecticutEcrisArtifactUrl,
  parseConnecticutEcrisHttpsUrl,
  refreshConnecticutEcrisArtifactCache,
  type ConnecticutEcrisArtifactCommitteeType,
  type ConnecticutEcrisArtifactFormat,
  type ConnecticutEcrisArtifactPeriod,
  type ConnecticutEcrisArtifactTransactionType,
} from "../pipeline/connecticutFinance/connecticutEcrisArtifactCache.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";

import { runRefreshConnecticutEcrisIndependentExpendituresScript } from "./refreshConnecticutEcrisIndependentExpenditures.js";

export { DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR };

export type RefreshConnecticutEcrisRawDataScriptOptions = {
  year: number;
  transactionType: ConnecticutEcrisArtifactTransactionType;
  committeeType: ConnecticutEcrisArtifactCommitteeType;
  period: ConnecticutEcrisArtifactPeriod;
  format: ConnecticutEcrisArtifactFormat;
  url: string;
  cacheDir: string;
  force: boolean;
  timeoutMs: number;
};

function readValueFlag(args: readonly string[], name: string): string | undefined {
  const values = readStrictFlagValues(args, name);
  if (values.length > 1) {
    throw new Error(`Provide ${name} at most once`);
  }
  return values[0];
}

function parsePositiveInteger(value: string | undefined, fallback: number, flagName: string): number {
  if (!value) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${flagName} value: ${value}`);
  }
  return Number(value);
}

function parseLocalPath(value: string | undefined, fallback: string, flagName: string): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length === 0) {
    throw new Error(`${flagName} is required`);
  }
  return resolve(normalized);
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, flagName: string): T {
  const normalized = (value?.trim() || fallback) as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`Invalid ${flagName} value: ${value ?? ""}`);
  }
  return normalized;
}

function parseYear(value: string | undefined): number {
  return parsePositiveInteger(value, new Date().getUTCFullYear(), "--year");
}

const KNOWN_BOOLEAN_FLAGS = new Set(["--force"]);
const KNOWN_VALUE_FLAGS = new Set(["--cache-dir", "--committee-type", "--format", "--period", "--timeout-ms", "--transaction-type", "--url", "--year"]);

export function parseRefreshConnecticutEcrisRawDataScriptArgs(
  args: readonly string[]
): RefreshConnecticutEcrisRawDataScriptOptions {
  assertKnownCliFlags(args, "Connecticut eCRIS raw data refresh", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  const year = parseYear(readValueFlag(args, "--year"));
  const transactionType = parseEnum<ConnecticutEcrisArtifactTransactionType>(
    readValueFlag(args, "--transaction-type"),
    ["receipts", "disbursements"],
    "receipts",
    "--transaction-type"
  );
  const committeeType = parseEnum<ConnecticutEcrisArtifactCommitteeType>(
    readValueFlag(args, "--committee-type"),
    ["candidate_exploratory", "party_pac"],
    "candidate_exploratory",
    "--committee-type"
  );
  const period = parseEnum<ConnecticutEcrisArtifactPeriod>(
    readValueFlag(args, "--period"),
    ["election", "calendar"],
    "election",
    "--period"
  );
  const format = parseEnum<ConnecticutEcrisArtifactFormat>(
    readValueFlag(args, "--format"),
    ["csv", "xlsx", "xls"],
    "csv",
    "--format"
  );
  const defaultUrl = buildConnecticutEcrisArtifactUrl({ year, transactionType, committeeType, period, format });

  return {
    year,
    transactionType,
    committeeType,
    period,
    format,
    url: parseConnecticutEcrisHttpsUrl(readValueFlag(args, "--url")?.trim() || defaultUrl, "--url"),
    cacheDir: parseLocalPath(readValueFlag(args, "--cache-dir"), DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR, "--cache-dir"),
    force: args.includes("--force"),
    timeoutMs: parsePositiveInteger(
      readValueFlag(args, "--timeout-ms"),
      CONNECTICUT_ECRIS_FETCH_TIMEOUT_MS,
      "--timeout-ms"
    ),
  };
}

export async function runRefreshConnecticutEcrisRawDataScript(input: {
  options: RefreshConnecticutEcrisRawDataScriptOptions;
  fetchImpl?: typeof fetch;
  now?: Date;
}) {
  const startedAt = input.now ?? new Date();
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error("Invalid Connecticut eCRIS raw data refresh timestamp");
  }

  const refresh = await refreshConnecticutEcrisArtifactCache({
    cacheDir: input.options.cacheDir,
    year: input.options.year,
    transactionType: input.options.transactionType,
    committeeType: input.options.committeeType,
    period: input.options.period,
    format: input.options.format,
    url: input.options.url,
    force: input.options.force,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.options.timeoutMs,
    now: startedAt,
  });

  // Receipt and IE publication are independent; an unchanged receipt export
  // must not prevent new IE filings from reaching the yearly cache.
  let independentExpenditures:
    | ({ status: "refreshed" } & Awaited<ReturnType<typeof runRefreshConnecticutEcrisIndependentExpendituresScript>>)
    | { status: "failed"; error: string }
    | null = null;
  if (input.options.transactionType === "receipts" && input.options.committeeType === "candidate_exploratory") {
    try {
      independentExpenditures = {
        status: "refreshed",
        ...await runRefreshConnecticutEcrisIndependentExpendituresScript({
          options: input.options,
          fetchImpl: input.fetchImpl,
          now: startedAt,
        }),
      };
    } catch (error) {
      // The IE runner replaces its cache only after a complete successful fetch.
      independentExpenditures = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    type: "connecticut_ecris_raw_data_refresh",
    ts: new Date().toISOString(),
    started_at: startedAt.toISOString(),
    year: input.options.year,
    transaction_type: input.options.transactionType,
    committee_type: input.options.committeeType,
    period: input.options.period,
    format: input.options.format,
    cache_dir: refresh.cacheDir,
    file_path: refresh.filePath,
    metadata_path: refresh.metadataPath,
    status: refresh.status,
    remote: refresh.remote,
    previous: refresh.previous,
    current: refresh.current,
    independent_expenditures: independentExpenditures,
  };
}

async function main(): Promise<void> {
  loadProjectEnv();
  const options = parseRefreshConnecticutEcrisRawDataScriptArgs(process.argv.slice(2));
  const output = await runRefreshConnecticutEcrisRawDataScript({ options });
  console.log(JSON.stringify(output, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Connecticut eCRIS raw data refresh failed:", message);
    process.exitCode = 1;
  });
}
