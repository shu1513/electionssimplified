import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjectEnv } from "../config/env.js";
import { isMaineCfisRawDataRefreshEnabled } from "../config/featureFlags.js";
import {
  DEFAULT_MAINE_CFIS_CACHE_DIR,
  refreshMaineCfisArtifactCache,
} from "../pipeline/maineFinance/maineCfisArtifactCache.js";
import {
  MAINE_CFIS_CSV_DOWNLOAD_API_URL,
  MAINE_CFIS_FETCH_TIMEOUT_MS,
  normalizeMaineCfisArtifactKind,
  parseMaineCfisHttpsUrl,
  type MaineCfisArtifactKind,
} from "../pipeline/maineFinance/maineCfisClient.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";
import { captureMaineMapLightDatasets } from "../pipeline/maineFinance/maineMapLightDatasetClient.js";

export { DEFAULT_MAINE_CFIS_CACHE_DIR };

export type RefreshMaineCampaignFinanceRawDataScriptOptions = {
  filingYear: number;
  artifactKind: MaineCfisArtifactKind;
  url: string;
  cacheDir: string;
  force: boolean;
  timeoutMs: number;
  maplight?: true;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--force", "--maplight"]);
const KNOWN_VALUE_FLAGS = new Set([
  "--filing-year",
  "--year",
  "--artifact-kind",
  "--url",
  "--cache-dir",
  "--timeout-ms",
]);

function validateKnownFlags(args: readonly string[]): void {
  assertKnownCliFlags(
    args,
    "Maine CFIS raw data refresh",
    KNOWN_BOOLEAN_FLAGS,
    KNOWN_VALUE_FLAGS,
  );
}

function readValueFlag(
  args: readonly string[],
  name: string,
): string | undefined {
  const values = readStrictFlagValues(args, name);
  if (values.length > 1) {
    throw new Error(`Provide ${name} at most once`);
  }
  return values[0];
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  flagName: string,
): number {
  if (!value) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${flagName} value: ${value}`);
  }
  return Number(value);
}

function parseFilingYear(value: string | undefined): number {
  return parsePositiveInteger(
    value,
    new Date().getUTCFullYear(),
    "--filing-year",
  );
}

function readFilingYearFlag(args: readonly string[]): string | undefined {
  const values = [
    ...readStrictFlagValues(args, "--filing-year"),
    ...readStrictFlagValues(args, "--year"),
  ];
  if (values.length > 1) {
    throw new Error("Provide --filing-year at most once");
  }
  return values[0];
}

function parseLocalPath(
  value: string | undefined,
  fallback: string,
  flagName: string,
): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length === 0) {
    throw new Error(`${flagName} is required`);
  }
  return resolve(normalized);
}

function parseArtifactKind(value: string | undefined): MaineCfisArtifactKind {
  return normalizeMaineCfisArtifactKind(value?.trim() || "contributions");
}

export function parseRefreshMaineCampaignFinanceRawDataScriptArgs(
  args: readonly string[],
): RefreshMaineCampaignFinanceRawDataScriptOptions {
  validateKnownFlags(args);
  const filingYear = parseFilingYear(readFilingYearFlag(args));
  const maplight = args.includes("--maplight");
  if (
    maplight &&
    (args.some((arg) => arg === "--url" || arg.startsWith("--url=")) ||
      args.some(
        (arg) =>
          arg === "--artifact-kind" || arg.startsWith("--artifact-kind="),
      ))
  ) {
    throw new Error(
      "MapLight capture discovers both dataset URLs; --url and --artifact-kind are not supported",
    );
  }
  return {
    filingYear,
    artifactKind: parseArtifactKind(readValueFlag(args, "--artifact-kind")),
    url: parseMaineCfisHttpsUrl(
      readValueFlag(args, "--url")?.trim() || MAINE_CFIS_CSV_DOWNLOAD_API_URL,
      "--url",
    ),
    cacheDir: parseLocalPath(
      readValueFlag(args, "--cache-dir"),
      process.env.MAINE_CFIS_RAW_DATA_CACHE_DIR?.trim() ||
        DEFAULT_MAINE_CFIS_CACHE_DIR,
      "--cache-dir",
    ),
    force: args.includes("--force"),
    timeoutMs: parsePositiveInteger(
      readValueFlag(args, "--timeout-ms"),
      maplight ? 60_000 : MAINE_CFIS_FETCH_TIMEOUT_MS,
      "--timeout-ms",
    ),
    ...(maplight ? { maplight: true as const } : {}),
  };
}

export async function runRefreshMaineCampaignFinanceRawDataScript(input: {
  options: RefreshMaineCampaignFinanceRawDataScriptOptions;
  fetchImpl?: typeof fetch;
  now?: Date;
}) {
  const startedAt = input.now ?? new Date();
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error("Invalid Maine CFIS raw data refresh timestamp");
  }

  if (input.options.maplight) {
    const result = await captureMaineMapLightDatasets({
      cacheDir: input.options.cacheDir,
      year: input.options.filingYear,
      refresh: input.options.force,
      timeoutMs: input.options.timeoutMs,
      fetchImpl: input.fetchImpl,
    });
    return {
      type: "maine_maplight_raw_data_refresh",
      ts: new Date().toISOString(),
      started_at: startedAt.toISOString(),
      filing_year: input.options.filingYear,
      status: result.status,
      ...(result.status === "captured"
        ? {
            capture_directory: result.capture.directory,
            capture_digest: result.capture.captureDigest,
            captured_at: result.capture.capturedAt,
            datasets: Object.entries(result.capture.selections).map(
              ([dataset, selection]) => ({
                dataset,
                filename: selection.attachment.title,
                published_as_of: selection.descriptor.lastUpdatedRaw,
                file_path:
                  result.capture.datasets[
                    dataset as "all_filers" | "independent_expenditures"
                  ].path,
                bytes:
                  result.capture.datasets[
                    dataset as "all_filers" | "independent_expenditures"
                  ].bytes,
                sha256:
                  result.capture.datasets[
                    dataset as "all_filers" | "independent_expenditures"
                  ].sha256,
                reused:
                  result.capture.datasets[
                    dataset as "all_filers" | "independent_expenditures"
                  ].reused,
              }),
            ),
          }
        : {
            diagnostic: result.diagnostic,
            previous_cache_verified: result.previousCacheVerified,
          }),
    };
  }

  const refresh = await refreshMaineCfisArtifactCache({
    filingYear: input.options.filingYear,
    artifactKind: input.options.artifactKind,
    cacheDir: input.options.cacheDir,
    url: input.options.url,
    force: input.options.force,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.options.timeoutMs,
    now: startedAt,
  });

  return {
    type: "maine_cfis_raw_data_refresh",
    ts: new Date().toISOString(),
    started_at: startedAt.toISOString(),
    filing_year: input.options.filingYear,
    artifact_kind: input.options.artifactKind,
    cache_dir: refresh.cacheDir,
    file_path: refresh.filePath,
    metadata_path: refresh.metadataPath,
    status: refresh.status,
    remote: refresh.remote,
    previous: refresh.previous,
    current: refresh.current,
  };
}

async function main(): Promise<void> {
  loadProjectEnv();
  const options = parseRefreshMaineCampaignFinanceRawDataScriptArgs(
    process.argv.slice(2),
  );
  if (!isMaineCfisRawDataRefreshEnabled(options.force)) {
    console.log("Maine CFIS raw data refresh disabled; no artifact refreshed");
    return;
  }
  const output = await runRefreshMaineCampaignFinanceRawDataScript({ options });
  console.log(JSON.stringify(output, null, 2));
  if (output.status === "unavailable") process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Maine CFIS raw data refresh failed:", message);
    process.exitCode = 1;
  });
}
