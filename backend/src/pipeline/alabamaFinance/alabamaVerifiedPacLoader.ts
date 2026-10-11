import { createHash } from "node:crypto";
import type { AlabamaCashRowsLoader } from "./alabamaCandidateFinanceSync.js";
import {
  getAlabamaExtractCatalog, getAlabamaCommitteeRegistry,
  getAlabamaNativeContributionRows, getAlabamaCompleteCommitteeFilings,
  type AlabamaFcpaClientOptions, type AlabamaExtractCatalogRow,
  type AlabamaCommitteeFilingRow,
} from "./alabamaFcpaClient.js";
import { createAlabamaCycleCoversLoader } from "./alabamaCommitteeCycleCovers.js";
import type { AlabamaFcpaArtifactCacheMetadata } from "./alabamaFcpaArtifactCache.js";
import type { AlabamaPacDonorAggregationResult } from "./alabamaPacDonorAggregator.js";
import { parseAlabamaWallClockMs } from "./alabamaPhaseZero.js";
import { verifyAlabamaPacCashSource } from "./verifyAlabamaPacCashSource.js";

export type AlabamaVerifiedPacLoaderInput = {
  internalCommitteeId: number;
  fcpaCommitteeNumber: string;
  windowStart: string;
  windowEnd: string;
  extractYears: readonly number[];
  coversCashCents: number;
  authoritativeCoverCount: number;
};
export type AlabamaVerifiedPacLoader = (input: AlabamaVerifiedPacLoaderInput) => Promise<AlabamaPacDonorAggregationResult>;
export type AlabamaVerifiedPacLoaderOptions = {
  /** Must verify raw artifact SHA/path integrity before returning parsed rows and metadata. */
  loadCashRows: AlabamaCashRowsLoader;
  clientOptions?: AlabamaFcpaClientOptions;
  fetchCatalog?: typeof getAlabamaExtractCatalog;
  fetchRegistry?: typeof getAlabamaCommitteeRegistry;
  fetchNativeContributions?: typeof getAlabamaNativeContributionRows;
  fetchFilings?: typeof getAlabamaCompleteCommitteeFilings;
  fetchCoverHtml?: NonNullable<Parameters<typeof createAlabamaCycleCoversLoader>[0]>["fetchCoverHtml"];
  createCoversLoader?: typeof createAlabamaCycleCoversLoader;
};

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
function civilDate(raw: string): string {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) ?? (us ? [us[0], us[3], us[1], us[2]] : null);
  if (!match) throw new Error("Invalid source civil date");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error("Invalid source civil date");
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}
/** Validate ranges before the shared wall-clock parser, which otherwise permits Date.UTC rollover. */
function wallClock(raw: string): number {
  const numeric = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(raw.trim());
  const worded = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i.exec(raw.trim());
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let hour: number, minute: number, second: number;
  if (numeric) {
    civilDate(`${numeric[3]}-${numeric[1]}-${numeric[2]}`);
    hour = Number(numeric[4]); minute = Number(numeric[5]); second = 0;
  } else if (worded) {
    const month = months.indexOf(worded[1]!.toLowerCase()) + 1;
    civilDate(`${worded[3]}-${String(month).padStart(2, "0")}-${worded[2]!.padStart(2, "0")}`);
    hour = Number(worded[4]); minute = Number(worded[5]); second = Number(worded[6]);
  } else {
    throw new Error("Invalid source wall-clock timestamp");
  }
  if (hour < 1 || hour > 12 || minute > 59 || second > 59) throw new Error("Invalid source wall-clock timestamp");
  return parseAlabamaWallClockMs(raw);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function fingerprint(rows: readonly unknown[]): string {
  return createHash("sha256").update(rows.map(canonical).sort().join("\n")).digest("hex");
}
function validateMetadata(year: number, loaded: Awaited<ReturnType<AlabamaCashRowsLoader>>): AlabamaFcpaArtifactCacheMetadata {
  const metadata = loaded.metadata;
  if (!metadata || metadata.version !== 1 || metadata.artifact?.kind !== "cash" || metadata.artifact.year !== year
    || metadata.source?.dataType !== "Cash Contribution" || !positive(metadata.source.downloadId)
    || typeof metadata.source.lastUpdatedRaw !== "string"
    || !Array.isArray(loaded.rows) || !nonnegative(loaded.quarantinedCount)
    || !nonnegative(metadata.recordCount) || !nonnegative(metadata.quarantinedCount)
    || metadata.quarantinedCount !== loaded.quarantinedCount
    || metadata.recordCount !== loaded.rows.length + loaded.quarantinedCount
    || !positive(metadata.zipBytes)
    || !/^[a-f0-9]{64}$/.test(metadata.zipSha256) || !/^[a-f0-9]{64}$/.test(metadata.csvSha256)
    || [metadata.filePath, metadata.metadataPath, metadata.fileName, metadata.downloadedAt].some((value) => typeof value !== "string" || !value.trim())
    || !Number.isFinite(Date.parse(metadata.downloadedAt))) {
    throw new Error(`Missing or invalid verified cash artifact metadata for ${year}`);
  }
  wallClock(metadata.source.lastUpdatedRaw);
  return metadata;
}
function catalogRows(catalog: readonly AlabamaExtractCatalogRow[], years: readonly number[]): AlabamaExtractCatalogRow[] {
  if (!Array.isArray(catalog)) throw new Error("Invalid current cash catalog");
  return years.map((year) => {
    const matches = catalog.filter((row) => row?.YEAR === year && row.DATATYPE === "Cash Contribution");
    const row = matches[0];
    if (matches.length !== 1 || !row || !positive(row.DOWNLOAD) || typeof row.LASTUPDATED !== "string"
      || typeof row.LASTUPDATEDRAW !== "string") throw new Error(`Missing or ambiguous current cash catalog for ${year}`);
    wallClock(row.LASTUPDATEDRAW);
    return row;
  });
}
function checkFilingsFreshness(filings: readonly AlabamaCommitteeFilingRow[], input: AlabamaVerifiedPacLoaderInput, earliestExtract: number): void {
  if (!Array.isArray(filings)) throw new Error("Invalid complete current filing list");
  for (const filing of filings) {
    // An unknown period cannot safely be classified outside the term.
    if (typeof filing.PERIODBEGIN !== "string") throw new Error("Current filing has unknown coverage");
    const begin = civilDate(filing.PERIODBEGIN);
    if (begin < input.windowStart || begin > input.windowEnd) continue;
    if (typeof filing.FILEDDATE !== "string" || wallClock(filing.FILEDDATE) > earliestExtract) {
      throw new Error("Current term filing is newer than the applicable cached cash extraction");
    }
  }
}

/** Source acquisition only. Any missing proof omits the PAC snapshot; no source failures become zero. */
export function createAlabamaVerifiedPacLoader(options: AlabamaVerifiedPacLoaderOptions): AlabamaVerifiedPacLoader {
  const fetchCatalog = options.fetchCatalog ?? getAlabamaExtractCatalog;
  const fetchRegistry = options.fetchRegistry ?? getAlabamaCommitteeRegistry;
  const fetchNative = options.fetchNativeContributions ?? getAlabamaNativeContributionRows;
  const fetchFilings = options.fetchFilings ?? getAlabamaCompleteCommitteeFilings;
  const createCovers = options.createCoversLoader ?? createAlabamaCycleCoversLoader;
  return async (input) => {
    let phase = "request";
    try {
      const start = civilDate(input.windowStart), end = civilDate(input.windowEnd);
      if (start !== input.windowStart || end !== input.windowEnd || start > end
        || !positive(input.internalCommitteeId) || !/^[1-9]\d*$/.test(input.fcpaCommitteeNumber)
        || !positive(Number(input.fcpaCommitteeNumber)) || !nonnegative(input.coversCashCents) || !positive(input.authoritativeCoverCount)) {
        throw new Error("Invalid receiving identity, term window or authoritative cash covers");
      }
      const years = [...input.extractYears].sort((a, b) => a - b);
      const first = Number(start.slice(0, 4)), last = Number(end.slice(0, 4));
      if (years.length !== last - first + 1 || years.some((year, index) =>
        !Number.isSafeInteger(year) || year < 2013 || year > 2100 || year !== first + index)) {
        throw new Error("Cached extract years do not cover the complete term window");
      }
      phase = "cache";
      // All caches precede native/registry requests. Existing batch loader memoizes verified artifacts.
      const cached = await Promise.all(years.map((year) => options.loadCashRows(year)));
      const metadata = cached.map((loaded, index) => validateMetadata(years[index]!, loaded));
      phase = "catalog";
      const beforeCatalog = catalogRows(await fetchCatalog(options.clientOptions), years);
      for (let i = 0; i < years.length; i += 1) {
        if (beforeCatalog[i]!.DOWNLOAD !== metadata[i]!.source.downloadId
          || beforeCatalog[i]!.LASTUPDATEDRAW !== metadata[i]!.source.lastUpdatedRaw) {
          throw new Error(`Cached cash artifact ${years[i]} does not match the current catalog`);
        }
      }
      const catalogFingerprint = fingerprint(beforeCatalog);
      const earliestExtract = Math.min(...beforeCatalog.map((row) => wallClock(row.LASTUPDATEDRAW)));
      phase = "registry";
      const registryBefore = await fetchRegistry(options.clientOptions);
      if (!Array.isArray(registryBefore) || registryBefore.length === 0) throw new Error("Complete committee registry unavailable");
      const registryFingerprint = fingerprint(registryBefore);
      phase = "filings";
      const filingsBefore = await fetchFilings(input.internalCommitteeId, options.clientOptions);
      checkFilingsFreshness(filingsBefore, input, earliestExtract);
      const filingFingerprint = fingerprint(filingsBefore);
      const nativeInput = { fcpaCommitteeNumber: input.fcpaCommitteeNumber, internalCommitteeId: input.internalCommitteeId };
      phase = "native before";
      const [nativeAllBefore, nativePacBefore] = await Promise.all([
        fetchNative(nativeInput, options.clientOptions),
        fetchNative({ ...nativeInput, pacOnly: true }, options.clientOptions),
      ]);
      const allFingerprint = fingerprint(nativeAllBefore), pacFingerprint = fingerprint(nativePacBefore);
      phase = "covers";
      const covers = await createCovers({
        clientOptions: options.clientOptions, fetchCoverHtml: options.fetchCoverHtml,
        fetchFilings: async () => filingsBefore,
      })(input.internalCommitteeId, input.windowStart);
      if (covers.windowStart !== input.windowStart || covers.cashCents !== input.coversCashCents
        || covers.windowFilingCount !== input.authoritativeCoverCount || covers.filingCount !== filingsBefore.length) {
        throw new Error("Fresh current covers disagree with the authoritative sync cash or filing count");
      }
      phase = "native after";
      const [nativeAllAfter, nativePacAfter, filingsAfter] = await Promise.all([
        fetchNative(nativeInput, options.clientOptions),
        fetchNative({ ...nativeInput, pacOnly: true }, options.clientOptions),
        fetchFilings(input.internalCommitteeId, options.clientOptions),
      ]);
      if (allFingerprint !== fingerprint(nativeAllAfter) || pacFingerprint !== fingerprint(nativePacAfter)
        || filingFingerprint !== fingerprint(filingsAfter)) throw new Error("Complete native receipt or filing metadata changed");
      checkFilingsFreshness(filingsAfter, input, earliestExtract);
      phase = "closing source bracket";
      const [registryAfter, afterCatalog] = await Promise.all([
        fetchRegistry(options.clientOptions), fetchCatalog(options.clientOptions),
      ]);
      if (registryFingerprint !== fingerprint(registryAfter)) throw new Error("Complete committee registry changed");
      if (catalogFingerprint !== fingerprint(catalogRows(afterCatalog, years))) throw new Error("Current cash catalog changed");
      phase = "cash proof";
      return verifyAlabamaPacCashSource({
        ...input, cashRows: cached.flatMap((loaded) => loaded.rows), committeeRegistryRows: registryBefore,
        nativeAllBefore, nativeAllAfter, nativePacBefore, nativePacAfter, filingsBefore, filingsAfter,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { diagnostics: [`Alabama verified PAC ${phase} unavailable: ${reason.slice(0, 500)}`] };
    }
  };
}
