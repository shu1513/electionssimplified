// Phase 0A only: validates the ND CFRS acquisition contracts (bulk CSVs,
// transaction/committee APIs, chart controls, presigned downloads) and
// produces the evidence for the plan's seven gates. No database, cache,
// scheduler, or published snapshot.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  NORTH_DAKOTA_CANDIDATE_COMMITTEE_ORG_TYPE,
  NORTH_DAKOTA_ORG_TYPE_CODES,
  downloadNorthDakotaPresignedFile,
  getAllNorthDakotaCommittees,
  getAllNorthDakotaTransactions,
  getNorthDakotaChartData,
  getNorthDakotaDataDownloadCatalog,
  getNorthDakotaDataDownloadFileUrl,
  getNorthDakotaTlsFallbackUseCount,
  type NorthDakotaCfrsClientOptions,
  type NorthDakotaDataDownloadCatalogRow,
  type NorthDakotaTransactionRow,
} from "../pipeline/northDakotaFinance/northDakotaCfrsClient.js";
import {
  decodeNorthDakotaCsvBytes,
  parseNorthDakotaContributionCsv,
  parseNorthDakotaExpenditureCsv,
  parseNorthDakotaFiledReportCsv,
  parseNorthDakotaReportingScheduleCsv,
  type NorthDakotaContributionCsvRow,
  type NorthDakotaExpenditureCsvRow,
} from "../pipeline/northDakotaFinance/northDakotaCfrsCsv.js";
import {
  NORTH_DAKOTA_YEAR_END_EXPENDITURE_TYPE,
  apiAmountToCents,
  checkNorthDakotaCycleWindow,
  checkNorthDakotaYtdSemantics,
  checkNorthDakotaRegistryJoin,
  evaluateNorthDakotaPhaseZeroGates,
  indexNorthDakotaCommittees,
  reconcileNorthDakotaChart,
  reconcileNorthDakotaCommittee,
  summarizeNorthDakotaContributionCsv,
  summarizeNorthDakotaExpenditureCsv,
  summarizeNorthDakotaFiledReports,
  summarizeNorthDakotaIndependentExpenditures,
  summarizeNorthDakotaOccupations,
  summarizeNorthDakotaRegistry,
  summarizeNorthDakotaReportingCycles,
} from "../pipeline/northDakotaFinance/northDakotaPhaseZero.js";

export type NorthDakotaPhaseZeroArgs = {
  years: number[];
  scratchDir: string;
  pageSize: number;
  timeoutMs: number;
  courtesyDelayMs: number;
  reconcileEntityIds: string[];
  currentElection: string;
};

const PROBE_RUN_ID = `${process.pid}-${Date.now()}`;

const DEFAULT_ARGS: NorthDakotaPhaseZeroArgs = {
  // Every year the catalog offers for Contributions/Expenditures; the chart
  // controls are all-years totals, so the run refuses a partial year list.
  years: [2025, 2026],
  scratchDir: "scratch/north-dakota-campaign-finance/phase0",
  pageSize: 2_000,
  timeoutMs: 120_000,
  // One incident of rapid in-page fetches wedged the SPA (plan): conservative
  // single-flight spacing, not a measured limit.
  courtesyDelayMs: 2_000,
  reconcileEntityIds: [],
  currentElection: "2026 Election - Statewide",
};

// Vocabularies observed live 2026-09-01 (gate 3). Anything outside these sets
// is a gate failure, not a silent bucket.
const KNOWN_CONTRIBUTION_CATEGORIES = new Set([
  "Monetary",
  "In-Kind",
  "Reimbursement of Expenditure",
  "Total - $200 or less",
  "Total - $100 or less",
]);
// "Monetary" is the year-end expenditure-by-category lump (see
// NORTH_DAKOTA_YEAR_END_EXPENDITURE_TYPE) — the only shape candidate
// committees appear in.
const KNOWN_EXPENDITURE_TYPES = new Set([
  "Itemized - greater than $200",
  "Itemized - greater than $100",
  "Lumpsum - $200 or less",
  "Lumpsum - $100 or less",
  NORTH_DAKOTA_YEAR_END_EXPENDITURE_TYPE,
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseFlags(args: readonly string[], names: readonly string[]): Record<string, string | null> {
  const values = Object.fromEntries(names.map((name) => [name, null])) as Record<string, string | null>;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (!names.includes(name)) throw new Error(`Unknown argument: ${name}`);
    if (values[name] !== null) throw new Error(`Provide ${name} at most once`);
    if (equalsIndex >= 0) {
      const value = arg.slice(equalsIndex + 1).trim();
      if (!value) throw new Error(`Missing ${name} value`);
      values[name] = value;
    } else {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing ${name} value`);
      values[name] = next.trim();
      index += 1;
    }
  }
  return values;
}

function nonNegativeInteger(value: string | null, fallback: number, name: string): number {
  const raw = value ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}: ${raw}`);
  return Number(raw);
}

function positiveInteger(value: string | null, fallback: number, name: string): number {
  const parsed = nonNegativeInteger(value, fallback, name);
  if (parsed === 0) throw new Error(`Invalid ${name}: ${parsed}`);
  return parsed;
}

export function parseProbeNorthDakotaCandidateFinanceArgs(args: readonly string[]): NorthDakotaPhaseZeroArgs {
  const values = parseFlags(args, [
    "--years",
    "--scratch-dir",
    "--page-size",
    "--timeout-ms",
    "--courtesy-delay-ms",
    "--reconcile-entity-ids",
    "--current-election",
  ]);
  const years =
    values["--years"] === null
      ? [...DEFAULT_ARGS.years]
      : values["--years"].split(",").map((year) => positiveInteger(year.trim(), 0, "--years"));
  if (years.length === 0 || new Set(years).size !== years.length) {
    throw new Error("--years must be a non-empty comma list of distinct years");
  }
  const reconcileEntityIds =
    values["--reconcile-entity-ids"] === null
      ? []
      : values["--reconcile-entity-ids"].split(",").map((id) => {
          const trimmed = id.trim();
          if (!/^\d{10}$/.test(trimmed)) throw new Error(`Invalid --reconcile-entity-ids entry: ${id}`);
          return trimmed;
        });
  return {
    years: years.sort((a, b) => a - b),
    scratchDir: values["--scratch-dir"] ?? DEFAULT_ARGS.scratchDir,
    pageSize: positiveInteger(values["--page-size"], DEFAULT_ARGS.pageSize, "--page-size"),
    timeoutMs: positiveInteger(values["--timeout-ms"], DEFAULT_ARGS.timeoutMs, "--timeout-ms"),
    courtesyDelayMs: nonNegativeInteger(values["--courtesy-delay-ms"], DEFAULT_ARGS.courtesyDelayMs, "--courtesy-delay-ms"),
    reconcileEntityIds,
    currentElection: values["--current-election"] ?? DEFAULT_ARGS.currentElection,
  };
}

export type NorthDakotaPhaseZeroClient = {
  getCatalog: typeof getNorthDakotaDataDownloadCatalog;
  getDownloadFileUrl: typeof getNorthDakotaDataDownloadFileUrl;
  downloadPresignedFile: typeof downloadNorthDakotaPresignedFile;
  getAllCommittees: typeof getAllNorthDakotaCommittees;
  getAllTransactions: typeof getAllNorthDakotaTransactions;
  getChartData: typeof getNorthDakotaChartData;
};

const DEFAULT_CLIENT: NorthDakotaPhaseZeroClient = {
  getCatalog: getNorthDakotaDataDownloadCatalog,
  getDownloadFileUrl: getNorthDakotaDataDownloadFileUrl,
  downloadPresignedFile: downloadNorthDakotaPresignedFile,
  getAllCommittees: getAllNorthDakotaCommittees,
  getAllTransactions: getAllNorthDakotaTransactions,
  getChartData: getNorthDakotaChartData,
};

function catalogYears(catalog: readonly NorthDakotaDataDownloadCatalogRow[], dataType: string): number[] {
  return catalog
    .filter((row) => row.dataType === dataType)
    .map((row) => Number(row.year))
    .sort((a, b) => a - b);
}

async function downloadCatalogArtifact(input: {
  client: NorthDakotaPhaseZeroClient;
  clientOptions: NorthDakotaCfrsClientOptions;
  catalog: readonly NorthDakotaDataDownloadCatalogRow[];
  dataType: string;
  year: number;
  scratchDir: string;
}): Promise<{ sha256: string; bytesWritten: number; text: string }> {
  const row = input.catalog.find((entry) => entry.dataType === input.dataType && entry.year === String(input.year));
  if (!row) {
    throw new Error(`North Dakota catalog is missing ${input.dataType} ${input.year}`);
  }
  const url = await input.client.getDownloadFileUrl(row.id, input.clientOptions);
  // Downloads are immutable originals (exclusive create), so each run gets its
  // own file name instead of failing on a previous run's artifact.
  const outputPath = join(input.scratchDir, `${input.dataType.replaceAll(" ", "_")}_${input.year}.${PROBE_RUN_ID}.csv`);
  const download = await input.client.downloadPresignedFile({ url, outputPath }, input.clientOptions);
  const text = decodeNorthDakotaCsvBytes(await readFile(download.outputPath));
  return { sha256: download.sha256, bytesWritten: download.bytesWritten, text };
}

function requireCleanParse<T>(label: string, result: { rows: T[]; errors: Array<{ line: number; reason: string }> }): T[] {
  if (result.errors.length > 0) {
    const sample = result.errors
      .slice(0, 3)
      .map((error) => `line ${error.line}: ${error.reason}`)
      .join("; ");
    throw new Error(`North Dakota ${label} parse produced ${result.errors.length} errors (${sample})`);
  }
  return result.rows;
}

function unknownValues(observed: Iterable<string>, known: ReadonlySet<string>): string[] {
  return [...new Set(observed)].filter((value) => !known.has(value)).sort();
}

export async function runProbeNorthDakotaCandidateFinance(input: {
  args: NorthDakotaPhaseZeroArgs;
  client?: NorthDakotaPhaseZeroClient;
  now?: Date;
}) {
  const { args } = input;
  const client = input.client ?? DEFAULT_CLIENT;
  const clientOptions: NorthDakotaCfrsClientOptions = { timeoutMs: args.timeoutMs };
  const pause = () => sleep(args.courtesyDelayMs);
  const latestYear = args.years[args.years.length - 1];
  const priorYear = args.years[0];

  // Gate 1: catalog (exact pagination body semantics live in the client).
  const catalog = await client.getCatalog(clientOptions);
  for (const dataType of ["Contributions", "Expenditures"]) {
    const offered = catalogYears(catalog, dataType);
    const missing = offered.filter((year) => !args.years.includes(year));
    if (offered.length === 0 || missing.length > 0) {
      throw new Error(
        `North Dakota catalog offers ${dataType} for [${offered.join(", ")}]; pass --years covering every year (chart totals are all-years)`
      );
    }
  }
  await pause();

  // Gate 3: bulk artifacts download + parse + vocabulary.
  const contributionsByYear: Array<{ year: number; sha256: string; bytes: number; rows: NorthDakotaContributionCsvRow[] }> = [];
  const expendituresByYear: Array<{ year: number; sha256: string; bytes: number; rows: NorthDakotaExpenditureCsvRow[] }> = [];
  for (const year of args.years) {
    const contributions = await downloadCatalogArtifact({ client, clientOptions, catalog, dataType: "Contributions", year, scratchDir: args.scratchDir });
    contributionsByYear.push({
      year,
      sha256: contributions.sha256,
      bytes: contributions.bytesWritten,
      rows: requireCleanParse(`contributions ${year}`, parseNorthDakotaContributionCsv(contributions.text)),
    });
    await pause();
    const expenditures = await downloadCatalogArtifact({ client, clientOptions, catalog, dataType: "Expenditures", year, scratchDir: args.scratchDir });
    expendituresByYear.push({
      year,
      sha256: expenditures.sha256,
      bytes: expenditures.bytesWritten,
      rows: requireCleanParse(`expenditures ${year}`, parseNorthDakotaExpenditureCsv(expenditures.text)),
    });
    await pause();
  }
  const allContributionRows = contributionsByYear.flatMap((entry) => entry.rows);
  const allExpenditureRows = expendituresByYear.flatMap((entry) => entry.rows);

  // Reporting schedules (every year offered — they run ahead of the data
  // years) and the latest filed-report list (amendment lineage).
  const reportingScheduleRows = [];
  for (const year of catalogYears(catalog, "Reporting Schedules")) {
    const artifact = await downloadCatalogArtifact({ client, clientOptions, catalog, dataType: "Reporting Schedules", year, scratchDir: args.scratchDir });
    reportingScheduleRows.push(...requireCleanParse(`reporting-schedules ${year}`, parseNorthDakotaReportingScheduleCsv(artifact.text)));
    await pause();
  }
  const filedReportYears = catalogYears(catalog, "Filed reports");
  const filedReportYear = filedReportYears[filedReportYears.length - 1];
  const filedReportArtifact = await downloadCatalogArtifact({ client, clientOptions, catalog, dataType: "Filed reports", year: filedReportYear, scratchDir: args.scratchDir });
  const filedReportRows = requireCleanParse(`filed-reports ${filedReportYear}`, parseNorthDakotaFiledReportCsv(filedReportArtifact.text));
  await pause();

  // Gate 1: acquisition determinism — a second mint+download of the same
  // daily object must be byte-identical.
  const scheduleYears = catalogYears(catalog, "Reporting Schedules");
  const determinismYear = scheduleYears[scheduleYears.length - 1];
  const determinismFirst = await downloadCatalogArtifact({ client, clientOptions, catalog, dataType: "Reporting Schedules", year: determinismYear, scratchDir: join(args.scratchDir, "determinism") });
  await pause();
  const determinismSecond = await downloadCatalogArtifact({ client, clientOptions, catalog, dataType: "Reporting Schedules", year: determinismYear, scratchDir: join(args.scratchDir, "determinism-repeat") });
  if (determinismFirst.sha256 !== determinismSecond.sha256) {
    throw new Error("North Dakota determinism gate failed: repeated download hashes differ");
  }
  await pause();

  // Gate 7: registry sweep + RegistrantID join.
  const committees = await client.getAllCommittees({ pageSize: args.pageSize }, clientOptions);
  const committeesById = indexNorthDakotaCommittees(committees);
  const registryJoin = checkNorthDakotaRegistryJoin({
    csvRegistrantIds: new Set([...allContributionRows, ...allExpenditureRows].map((row) => row.registrantId)),
    committeesById,
  });
  await pause();

  // Gate 3: chart controls (all-years totals) vs CSV sums.
  const contributionSummaryAllYears = summarizeNorthDakotaContributionCsv(allContributionRows, committeesById);
  const expenditureSummaryAllYears = summarizeNorthDakotaExpenditureCsv(allExpenditureRows, committeesById);
  const contributionChart = reconcileNorthDakotaChart({
    chart: await client.getChartData("contributions", clientOptions),
    csvTotalCents: contributionSummaryAllYears.totalCents,
    csvSlices: {
      "By Contributor Type": contributionSummaryAllYears.byContributorType,
      "By Committee Type": contributionSummaryAllYears.byCommitteeType,
      "By Contribution Type": contributionSummaryAllYears.byCategory,
    },
  });
  await pause();
  const expenditureChart = reconcileNorthDakotaChart({
    chart: await client.getChartData("expenditures", clientOptions),
    csvTotalCents: expenditureSummaryAllYears.totalCents,
    csvSlices: {
      "By Recipient Type": expenditureSummaryAllYears.byRecipientType,
      "By Committee Type": expenditureSummaryAllYears.byCommitteeType,
      "By Purpose Type": expenditureSummaryAllYears.yearEndCategoryLumps.byPurpose,
    },
  });
  await pause();
  const independentExpenditureChart = await client.getChartData("independentExpenditures", clientOptions);
  const independentExpenditureChartTotalCents =
    independentExpenditureChart.length > 0 ? apiAmountToCents(independentExpenditureChart[0].totalAmount) : 0;
  await pause();

  // Gate 5 + 6: API contribution harvest per year (all filer types; the CON
  // dataset mirrors the bulk file) and CSV<->API reconciliation.
  const apiRowsByYear = new Map<number, NorthDakotaTransactionRow[]>();
  for (const year of args.years) {
    apiRowsByYear.set(year, await client.getAllTransactions({ transactionCategory: "CON", transactionYear: year, pageSize: args.pageSize }, clientOptions));
    await pause();
  }
  const latestApiRows = apiRowsByYear.get(latestYear) ?? [];
  const filedReports = summarizeNorthDakotaFiledReports(filedReportRows, committeesById);

  const reconcileIds = new Set(args.reconcileEntityIds);
  const latestCandidateTotals = new Map<string, number>();
  for (const row of contributionsByYear[contributionsByYear.length - 1].rows) {
    if (committeesById.get(row.registrantId)?.orgType !== NORTH_DAKOTA_CANDIDATE_COMMITTEE_ORG_TYPE) continue;
    latestCandidateTotals.set(row.registrantId, (latestCandidateTotals.get(row.registrantId) ?? 0) + row.amountCents);
  }
  for (const [entityId] of [...latestCandidateTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) reconcileIds.add(entityId);
  for (const entityId of filedReports.amendedRegistrantIds.slice(0, 3)) reconcileIds.add(entityId);

  const reconciliations = [];
  for (const entityId of [...reconcileIds].sort()) {
    for (const entry of contributionsByYear) {
      if (!entry.rows.some((row) => row.registrantId === entityId)) continue;
      reconciliations.push({
        year: entry.year,
        amendedFilings: filedReports.amendedFilingsByRegistrant[entityId] ?? 0,
        ...reconcileNorthDakotaCommittee({ entityId, csvRows: entry.rows, apiRows: apiRowsByYear.get(entry.year) ?? [] }),
      });
    }
  }

  // Gate 2 + hard fact 4: IE dataset under the pinned selector.
  const independentExpenditures = summarizeNorthDakotaIndependentExpenditures(
    await client.getAllTransactions(
      { transactionCategory: "IE", orgTypeCode: NORTH_DAKOTA_ORG_TYPE_CODES.independentExpenditureCommittee, pageSize: args.pageSize },
      clientOptions
    )
  );

  // Gate 4: cycle window. Gate 6: occupation. Gate 7: resolver gold set.
  const reportingCycles = summarizeNorthDakotaReportingCycles(reportingScheduleRows);
  const cycleWindow = checkNorthDakotaCycleWindow({
    priorYear,
    priorYearRows: contributionsByYear[0].rows,
    committeesById,
  });
  const occupations = summarizeNorthDakotaOccupations(latestApiRows, committeesById);
  const registry = summarizeNorthDakotaRegistry(committees, args.currentElection);

  const gateFailures = evaluateNorthDakotaPhaseZeroGates({
    contributionChart,
    expenditureChart,
    unknownContributionCategories: unknownValues(allContributionRows.map((row) => row.transactionCategory), KNOWN_CONTRIBUTION_CATEGORIES),
    unknownExpenditureTypes: unknownValues(allExpenditureRows.map((row) => row.expenditureType), KNOWN_EXPENDITURE_TYPES),
    registryJoin,
    reconciliations,
    independentExpenditures,
    independentExpenditureChartTotalCents,
    currentElection: args.currentElection,
    cycleWindow,
    reportingCycles,
    occupations,
    registry,
  });

  return {
    type: "north_dakota_campaign_finance_phase_zero_probe" as const,
    ts: (input.now ?? new Date()).toISOString(),
    ok: gateFailures.length === 0,
    gate_failures: gateFailures,
    tls_fallback_uses: getNorthDakotaTlsFallbackUseCount(),
    catalog: {
      artifactCount: catalog.length,
      byDataType: Object.fromEntries(
        [...new Set(catalog.map((row) => row.dataType))].sort().map((dataType) => [dataType, catalogYears(catalog, dataType)])
      ),
    },
    bulk: {
      contributions: contributionsByYear.map((entry) => ({
        year: entry.year,
        sha256: entry.sha256,
        bytes: entry.bytes,
        summary: summarizeNorthDakotaContributionCsv(entry.rows, committeesById),
      })),
      expenditures: expendituresByYear.map((entry) => ({
        year: entry.year,
        sha256: entry.sha256,
        bytes: entry.bytes,
        summary: summarizeNorthDakotaExpenditureCsv(entry.rows, committeesById),
      })),
      determinism: { dataType: "Reporting Schedules", year: determinismYear, sha256: determinismFirst.sha256 },
    },
    charts: {
      contributions: contributionChart,
      expenditures: expenditureChart,
      independentExpenditures: { chartTotalCents: independentExpenditureChartTotalCents, uniqueRowTotalCents: independentExpenditures.totalCents },
    },
    registry: { ...registry, join: registryJoin },
    reporting_cycles: reportingCycles,
    cycle_window: cycleWindow,
    filed_reports: {
      year: filedReportYear,
      rowCount: filedReports.rowCount,
      byReportTypeAndVersion: filedReports.byReportTypeAndVersion,
      amendedRegistrantCount: filedReports.amendedRegistrantIds.length,
      amendedRegistrantIds: filedReports.amendedRegistrantIds.slice(0, 25),
    },
    api: {
      rowsByYear: [...apiRowsByYear.entries()].map(([year, rows]) => ({
        year,
        rowCount: rows.length,
        amendedRowCount: rows.filter((row) => row.amendedFlag).length,
        donorYtd: checkNorthDakotaYtdSemantics(rows),
        categoryCounts: rows.reduce<Record<string, number>>((counts, row) => {
          const category = row.transactionCategoryDesc ?? "<null>";
          counts[category] = (counts[category] ?? 0) + 1;
          return counts;
        }, {}),
      })),
    },
    reconciliation: reconciliations,
    independent_expenditures: independentExpenditures,
    occupations,
    publication: "disabled_phase_zero" as const,
  };
}

async function main(): Promise<void> {
  const output = await runProbeNorthDakotaCandidateFinance({
    args: parseProbeNorthDakotaCandidateFinanceArgs(process.argv.slice(2)),
  });
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    console.error(`North Dakota campaign-finance Phase 0A gates failed: ${output.gate_failures.join("; ")}`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("North Dakota campaign-finance Phase 0A probe failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
