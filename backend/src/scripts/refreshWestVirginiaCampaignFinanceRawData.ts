// The only live-portal caller on the West Virginia direct path. For each
// election year it refreshes the three schedule files that can carry the
// candidate cycle's periods, resolves the cycle window from them (the same
// rule the sync applies), then refreshes the contributions, expenditures
// and org-101 API harvest for every year the window spans — so the cache
// always holds exactly what the sync will ask for.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadProjectEnv } from "../config/env.js";
import { isWestVirginiaCampaignFinanceRawDataRefreshEnabled } from "../config/featureFlags.js";
import {
  DEFAULT_WEST_VIRGINIA_CFRS_CACHE_DIR,
  normalizeWestVirginiaArtifactYear,
  readWestVirginiaBulkArtifact,
  refreshWestVirginiaApiContributionsArtifact,
  refreshWestVirginiaBulkArtifact,
  type WestVirginiaArtifactRefreshResult,
} from "../pipeline/westVirginiaFinance/westVirginiaCfrsArtifactCache.js";
import {
  getWestVirginiaDataDownloadCatalog,
  type WestVirginiaCfrsClientOptions,
} from "../pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";
import { refreshWestVirginiaElectronicOutsideSpendingArtifact } from "../pipeline/westVirginiaFinance/westVirginiaElectronicOutsideSpendingCache.js";
import { refreshWestVirginiaCommitteeRegistryArtifact } from "../pipeline/westVirginiaFinance/westVirginiaCfrsRegistryCache.js";
import { parseWestVirginiaReportingScheduleCsv } from "../pipeline/westVirginiaFinance/westVirginiaCfrsCsv.js";
import {
  resolveWestVirginiaCandidateCycleWindow,
  westVirginiaCycleWindowYears,
  westVirginiaScheduleYearsForElection,
} from "../pipeline/westVirginiaFinance/westVirginiaReportingCycleWindows.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";

export type RefreshWestVirginiaCampaignFinanceRawDataScriptOptions = {
  /** Candidate election years to refresh, deduped, in argument order. */
  electionYears: number[];
  cacheDir: string;
  /** Bypasses only the refresh feature sub-gate, never cache safety. */
  force: boolean;
  /** Forwarded as the cache's force: lets a 0-row artifact displace a populated one. */
  acceptEmpty: boolean;
  timeoutMs: number | undefined;
};

const BOOLEAN_FLAGS = new Set(["--force", "--accept-empty"]);
const VALUE_FLAGS = new Set(["--election-year", "--cache-dir", "--timeout-ms"]);

function readValueFlag(args: readonly string[], name: string): string | undefined {
  const values = readStrictFlagValues(args, name);
  if (values.length > 1) throw new Error(`Provide ${name} at most once`);
  return values[0];
}

function parseElectionYear(value: string): number {
  if (!/^\d{4}$/.test(value)) {
    throw new Error(`Invalid --election-year value: ${value}`);
  }
  return normalizeWestVirginiaArtifactYear(Number(value));
}

export function parseRefreshWestVirginiaCampaignFinanceRawDataScriptArgs(
  args: readonly string[]
): RefreshWestVirginiaCampaignFinanceRawDataScriptOptions {
  assertKnownCliFlags(args, "West Virginia CFRS raw data refresh", BOOLEAN_FLAGS, VALUE_FLAGS);
  const electionYears = [...new Set(readStrictFlagValues(args, "--election-year").map(parseElectionYear))];
  if (electionYears.length === 0) {
    electionYears.push(normalizeWestVirginiaArtifactYear(new Date().getUTCFullYear()));
  }
  const timeoutValue = readValueFlag(args, "--timeout-ms");
  if (timeoutValue !== undefined && !/^[1-9]\d*$/.test(timeoutValue)) {
    throw new Error(`Invalid --timeout-ms value: ${timeoutValue}`);
  }
  return {
    electionYears,
    cacheDir: resolve(
      readValueFlag(args, "--cache-dir") ??
        (process.env.WEST_VIRGINIA_CFRS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_WEST_VIRGINIA_CFRS_CACHE_DIR)
    ),
    force: args.includes("--force"),
    acceptEmpty: args.includes("--accept-empty"),
    timeoutMs: timeoutValue === undefined ? undefined : Number(timeoutValue),
  };
}

function summarize(refresh: WestVirginiaArtifactRefreshResult) {
  return {
    kind: refresh.current.artifact.kind,
    year: refresh.current.artifact.year,
    status: refresh.status,
    file_path: refresh.filePath,
    record_count: refresh.current.recordCount,
    recovered_row_count: refresh.current.recoveredRowCount,
    sha256: refresh.current.sha256,
  };
}

export async function runRefreshWestVirginiaCampaignFinanceRawDataScript(input: {
  options: RefreshWestVirginiaCampaignFinanceRawDataScriptOptions;
  clientOptions?: WestVirginiaCfrsClientOptions;
  refreshBulk?: typeof refreshWestVirginiaBulkArtifact;
  refreshApi?: typeof refreshWestVirginiaApiContributionsArtifact;
  refreshRegistry?: typeof refreshWestVirginiaCommitteeRegistryArtifact;
  refreshIE?: typeof refreshWestVirginiaElectronicOutsideSpendingArtifact;
  fetchCatalog?: typeof getWestVirginiaDataDownloadCatalog;
  readBulk?: typeof readWestVirginiaBulkArtifact;
}) {
  const clientOptions: WestVirginiaCfrsClientOptions = {
    ...input.clientOptions,
    ...(input.options.timeoutMs === undefined ? {} : { timeoutMs: input.options.timeoutMs }),
  };
  const refreshBulk = input.refreshBulk ?? refreshWestVirginiaBulkArtifact;
  const refreshApi = input.refreshApi ?? refreshWestVirginiaApiContributionsArtifact;
  const readBulk = input.readBulk ?? readWestVirginiaBulkArtifact;
  const { cacheDir, acceptEmpty } = input.options;
  // One catalog read for the whole run.
  const catalog = await (input.fetchCatalog ?? getWestVirginiaDataDownloadCatalog)({}, clientOptions);

  // Registry identity is not scoped to a candidate election year. Fetch the
  // complete all-type/status snapshot once for the whole acquisition run.
  const registryRefresh = await (input.refreshRegistry ?? refreshWestVirginiaCommitteeRegistryArtifact)({
    cacheDir, clientOptions,
  });
  const registry = {
    status: registryRefresh.status,
    file_path: registryRefresh.filePath,
    record_count: registryRefresh.current.recordCount,
    sha256: registryRefresh.current.sha256,
    downloaded_at: registryRefresh.current.downloadedAt,
    source_url: registryRefresh.current.sourceUrl,
  };
  const artifacts: ReturnType<typeof summarize>[] = [];
  const windows = [];
  const refreshedBulk = new Set<string>();
  const refreshedApi = new Set<number>();
  for (const electionYear of input.options.electionYears) {
    const scheduleRows = [];
    for (const year of westVirginiaScheduleYearsForElection(electionYear)) {
      const key = `reporting_schedules:${year}`;
      if (!refreshedBulk.has(key)) {
        refreshedBulk.add(key);
        artifacts.push(
          summarize(
            await refreshBulk({ kind: "reporting_schedules", year, cacheDir, catalog, force: acceptEmpty, clientOptions })
          )
        );
      }
      const parsed = parseWestVirginiaReportingScheduleCsv(
        (await readBulk({ kind: "reporting_schedules", year, cacheDir })).csvText
      );
      scheduleRows.push(...parsed.rows);
    }
    const window = resolveWestVirginiaCandidateCycleWindow({ scheduleRows, electionYear });
    const windowYears = westVirginiaCycleWindowYears(window);
    windows.push({
      election_year: electionYear,
      reporting_cycle: window.reportingCycle,
      window_start: window.windowStart,
      window_end: window.windowEnd,
      window_years: windowYears,
    });
    for (const year of windowYears) {
      for (const kind of ["contributions", "expenditures"] as const) {
        const key = `${kind}:${year}`;
        if (refreshedBulk.has(key)) continue;
        refreshedBulk.add(key);
        artifacts.push(summarize(await refreshBulk({ kind, year, cacheDir, catalog, force: acceptEmpty, clientOptions })));
      }
      if (!refreshedApi.has(year)) {
        refreshedApi.add(year);
        artifacts.push(summarize(await refreshApi({ year, cacheDir, force: acceptEmpty, clientOptions })));
      }
    }
  }
  const ieRefresh = await (input.refreshIE ?? refreshWestVirginiaElectronicOutsideSpendingArtifact)({
    years: [...refreshedApi].sort((left, right) => left - right), cacheDir, clientOptions,
  });
  const electronicIe = {
    status: ieRefresh.status, scope: ieRefresh.current.scope, years: ieRefresh.current.years,
    file_path: ieRefresh.filePath, record_count: ieRefresh.current.recordCount,
    sha256: ieRefresh.current.sha256, registry_sha256: ieRefresh.current.registrySha256,
  };
  return {
    type: "west_virginia_cfrs_raw_data_refresh",
    ts: new Date().toISOString(),
    cache_dir: cacheDir,
    windows,
    registry,
    electronic_ie: electronicIe,
    artifacts,
  };
}

async function main(): Promise<void> {
  loadProjectEnv();
  const options = parseRefreshWestVirginiaCampaignFinanceRawDataScriptArgs(process.argv.slice(2));
  if (!isWestVirginiaCampaignFinanceRawDataRefreshEnabled(options.force)) {
    console.log("West Virginia CFRS raw data refresh disabled; no artifact refreshed");
    return;
  }
  console.log(JSON.stringify(await runRefreshWestVirginiaCampaignFinanceRawDataScript({ options }), null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("West Virginia CFRS raw data refresh failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
