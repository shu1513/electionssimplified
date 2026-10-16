import { pathToFileURL } from "node:url";
import {
  isGeorgiaEthicsRawDataRefreshEnabled,
  isGeorgiaReportedIeEnabled,
  isGeorgiaReportedCommitteeContributionsEnabled,
} from "../config/featureFlags.js";
import {
  createGeorgiaReportedFinanceSourceProducer,
  GeorgiaReportedFinanceSourceCacheError,
  resolveGeorgiaReportedFinanceCacheDir,
  type GeorgiaReportedSourceFacts,
} from "../pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js";

export type RefreshGeorgiaReportedFinanceSourcesOptions = {
  cacheDir: string; filingYear: number; electionYear: number; force: boolean;
};
const VALUES = new Set(["--cache-dir", "--filing-year", "--election-year"]);
export function parseRefreshGeorgiaReportedFinanceSourcesArgs(args: readonly string[]): RefreshGeorgiaReportedFinanceSourcesOptions {
  const values = new Map<string, string>();
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--force" && !force) { force = true; continue; }
    if (!VALUES.has(flag) || values.has(flag)) throw new Error("Invalid Georgia reported source refresh flag");
    const value = args[++i]?.trim();
    if (!value || value.startsWith("--")) throw new Error("Missing Georgia reported source refresh flag value");
    values.set(flag, value);
  }
  const year = (value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!/^\d{4}$/.test(value) || !Number.isInteger(n) || n < 2026 || n > 2100) throw new Error("Invalid Georgia reported source year");
    return n;
  };
  const filingYear = year(values.get("--filing-year"), new Date().getUTCFullYear());
  return { filingYear, electionYear: year(values.get("--election-year"), filingYear), force,
    cacheDir: resolveGeorgiaReportedFinanceCacheDir(values.get("--cache-dir")) };
}

type RefreshResult = { component: "ie" | "contributions"; status: "disabled" | "refreshed" | "unavailable";
  sourceRetrievedAt?: string; sourceCompletedAt?: string; sourceRowCount?: number;
  originalCount?: number; sourceByteSize?: number; failureCode?: string };
function refreshed(component: RefreshResult["component"], source: GeorgiaReportedSourceFacts): RefreshResult {
  return { component, status: "refreshed", sourceRetrievedAt: source.sourceRetrievedAt,
    sourceCompletedAt: source.sourceCompletedAt, sourceRowCount: source.sourceRowCount,
    originalCount: source.sourceControls.length, sourceByteSize: source.sourceByteSize };
}

/** The ordinary source producer is separate from canonical money sync. It
 * reads process configuration only; operators pass flags inline. Originals
 * stay in the private cache and never enter this aggregate CLI output. */
export async function refreshGeorgiaReportedFinanceSources(options: RefreshGeorgiaReportedFinanceSourcesOptions) {
  const ie = isGeorgiaReportedIeEnabled(), contributions = isGeorgiaReportedCommitteeContributionsEnabled();
  const enabled = (ie || contributions) && isGeorgiaEthicsRawDataRefreshEnabled(options.force);
  if (!enabled) return { type: "georgia_reported_finance_source_refresh", enabled: false, results: [] as RefreshResult[] };
  const producer = createGeorgiaReportedFinanceSourceProducer({ cacheDir: options.cacheDir });
  const scope = { filingYear: options.filingYear, electionYear: options.electionYear };
  const results: RefreshResult[] = [];
  for (const component of ["ie", "contributions"] as const) {
    if (!(component === "ie" ? ie : contributions)) { results.push({ component, status: "disabled" }); continue; }
    try {
      const source = component === "ie" ? await producer.refreshIe(scope) : await producer.refreshContributions(scope);
      results.push(refreshed(component, source));
    } catch (error) {
      if (!(error instanceof GeorgiaReportedFinanceSourceCacheError)) throw error;
      results.push({ component, status: "unavailable", failureCode: error.code });
    }
  }
  return { type: "georgia_reported_finance_source_refresh", enabled: true,
    filingYear: options.filingYear, electionYear: options.electionYear, results };
}

async function main(): Promise<void> {
  const result = await refreshGeorgiaReportedFinanceSources(parseRefreshGeorgiaReportedFinanceSourcesArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (result.results.some(row => row.status === "unavailable")) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error("Georgia reported finance source refresh failed"); process.exitCode = 1; });
}
