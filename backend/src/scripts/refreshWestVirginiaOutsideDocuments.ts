// Live-portal caller for the West Virginia outside-documents path: refreshes
// the committee registry, then enumerates and downloads every IE / EC report
// document that registered IEC/ECC committees received in the given years.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjectEnv } from "../config/env.js";
import { isWestVirginiaCampaignFinanceRawDataRefreshEnabled } from "../config/featureFlags.js";
import { DEFAULT_WEST_VIRGINIA_CFRS_CACHE_DIR } from "../pipeline/westVirginiaFinance/westVirginiaCfrsArtifactCache.js";
import type { WestVirginiaCfrsClientOptions } from "../pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";
import { refreshWestVirginiaCommitteeRegistryArtifact } from "../pipeline/westVirginiaFinance/westVirginiaCfrsRegistryCache.js";
import { refreshWestVirginiaOutsideDocumentInventory } from "../pipeline/westVirginiaFinance/westVirginiaOutsideDocumentInventory.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";

const BOOLEAN_FLAGS = new Set(["--force", "--skip-registry"]);
const VALUE_FLAGS = new Set(["--received-year", "--cache-dir", "--timeout-ms"]);

export type RefreshWestVirginiaOutsideDocumentsScriptOptions = {
  receivedYears: number[];
  cacheDir: string;
  force: boolean;
  skipRegistry: boolean;
  timeoutMs: number | undefined;
};

export function parseRefreshWestVirginiaOutsideDocumentsScriptArgs(args: readonly string[]): RefreshWestVirginiaOutsideDocumentsScriptOptions {
  assertKnownCliFlags(args, "West Virginia outside documents refresh", BOOLEAN_FLAGS, VALUE_FLAGS);
  const receivedYears = [...new Set(readStrictFlagValues(args, "--received-year").map((value) => {
    if (!/^\d{4}$/.test(value)) throw new Error(`Invalid --received-year: ${value}`);
    return Number(value);
  }))];
  if (!receivedYears.length) throw new Error("--received-year is required (repeatable)");
  const cacheDirValues = readStrictFlagValues(args, "--cache-dir");
  const timeoutValues = readStrictFlagValues(args, "--timeout-ms");
  if (cacheDirValues.length > 1 || timeoutValues.length > 1) throw new Error("--cache-dir and --timeout-ms accept one value");
  const timeoutMs = timeoutValues[0] === undefined ? undefined : Number(timeoutValues[0]);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error("Invalid --timeout-ms");
  return {
    receivedYears,
    cacheDir: resolve(cacheDirValues[0] ?? (process.env.WEST_VIRGINIA_CFRS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_WEST_VIRGINIA_CFRS_CACHE_DIR)),
    force: args.includes("--force"),
    skipRegistry: args.includes("--skip-registry"),
    timeoutMs,
  };
}

export async function runRefreshWestVirginiaOutsideDocumentsScript(input: {
  options: RefreshWestVirginiaOutsideDocumentsScriptOptions;
  clientOptions?: WestVirginiaCfrsClientOptions;
  refreshRegistry?: typeof refreshWestVirginiaCommitteeRegistryArtifact;
  refreshInventory?: typeof refreshWestVirginiaOutsideDocumentInventory;
  log?: (line: string) => void;
}) {
  const clientOptions: WestVirginiaCfrsClientOptions = {
    ...input.clientOptions,
    ...(input.options.timeoutMs === undefined ? {} : { timeoutMs: input.options.timeoutMs }),
  };
  const { cacheDir } = input.options;
  const registry = input.options.skipRegistry
    ? null
    : await (input.refreshRegistry ?? refreshWestVirginiaCommitteeRegistryArtifact)({ cacheDir, clientOptions });
  const result = await (input.refreshInventory ?? refreshWestVirginiaOutsideDocumentInventory)({
    cacheDir, years: input.options.receivedYears, clientOptions, log: input.log,
  });
  return {
    cache_dir: cacheDir,
    registry: registry ? { status: registry.status, record_count: registry.current.recordCount, sha256: registry.current.sha256 } : "skipped",
    inventory_path: result.inventoryPath,
    committee_count: result.committeeCount,
    document_count: result.documentCount,
    downloaded: result.downloaded,
    reused: result.reused,
    by_committee: result.inventory.committees.filter((c) => c.ieDocumentCount > 0)
      .sort((a, b) => b.ieDocumentCount - a.ieDocumentCount)
      .map((c) => ({ orgID: c.orgID, name: c.orgName, type: c.orgTypeCode, ie_documents: c.ieDocumentCount })),
  };
}

async function main(): Promise<void> {
  loadProjectEnv();
  const options = parseRefreshWestVirginiaOutsideDocumentsScriptArgs(process.argv.slice(2));
  if (!isWestVirginiaCampaignFinanceRawDataRefreshEnabled(options.force)) {
    console.log("West Virginia CFRS raw data refresh disabled; no documents refreshed");
    return;
  }
  const result = await runRefreshWestVirginiaOutsideDocumentsScript({ options, log: (line) => console.error(line) });
  console.log(JSON.stringify(result, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("West Virginia outside documents refresh failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
