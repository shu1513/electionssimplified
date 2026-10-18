import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  streamOhioSosBulkFile,
  OHIO_SOS_CANDIDATE_CONTRIBUTIONS_FAMILY,
  OHIO_SOS_CANDIDATE_COVER_FAMILY,
  OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY,
  OHIO_SOS_CANDIDATE_LIST_FAMILY,
  OHIO_SOS_PAC_CONTRIBUTIONS_FAMILY,
  OHIO_SOS_PAC_COVER_FAMILY,
  OHIO_SOS_PAC_EXPENDITURES_FAMILY,
  OHIO_SOS_PAC_LIST_FAMILY,
  OHIO_SOS_PARTY_CONTRIBUTIONS_FAMILY,
  OHIO_SOS_PARTY_COVER_FAMILY,
  OHIO_SOS_PARTY_EXPENDITURES_FAMILY,
  type OhioSosBulkFileFamily,
} from "./ohioSosBulkFiles.js";

// Artifact cache for the Ohio SoS bulk downloads. Retrieval and parsing stay
// separate (docs/plans/ohio_plan.md decision 9): the acquisition script hands each
// downloaded file to this module, which validates it against its pinned
// schema, hashes it, and atomically replaces the cached snapshot plus its
// manifest. The finance sync reads the cache only and never touches the
// portal.

export const DEFAULT_OHIO_SOS_CACHE_DIR = "scratch/ohio-campaign-finance/sos";

// Bumped whenever a pinned header or a manifest field changes, so a stale
// snapshot is re-validated rather than trusted.
export const OHIO_SOS_ARTIFACT_SCHEMA_VERSION = 1;

export const OHIO_SOS_FILE_TRANSFER_PAGE_URL =
  "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:73";

export type OhioSosProductKey =
  | "candidate_list"
  | "pac_list"
  | "candidate_cover"
  | "pac_cover"
  | "party_cover"
  | "candidate_contributions"
  | "candidate_expenditures"
  | "pac_contributions"
  | "pac_expenditures"
  | "party_contributions"
  | "party_expenditures";

export type OhioSosProduct = {
  key: OhioSosProductKey;
  // Published file name on the file-transfer page. `<YEAR>` is substituted
  // with the transaction year for the annual products. This label is what
  // the acquisition script matches on — download IDs are discovered from it
  // and never hardcoded (decision 9).
  fileNamePattern: string;
  // Annual products exist once per transaction year; the rest are single
  // cumulative files.
  perYear: boolean;
  family: OhioSosBulkFileFamily<unknown>;
};

function product(input: OhioSosProduct): OhioSosProduct {
  return input;
}

export const OHIO_SOS_PRODUCTS: Readonly<Record<OhioSosProductKey, OhioSosProduct>> = {
  candidate_list: product({
    key: "candidate_list",
    fileNamePattern: "ACT_CAN_LIST.CSV",
    perYear: false,
    family: OHIO_SOS_CANDIDATE_LIST_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  pac_list: product({
    key: "pac_list",
    fileNamePattern: "ACT_PAC_LIST.CSV",
    perYear: false,
    family: OHIO_SOS_PAC_LIST_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  candidate_cover: product({
    key: "candidate_cover",
    fileNamePattern: "CAN_COVER.CSV",
    perYear: false,
    family: OHIO_SOS_CANDIDATE_COVER_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  pac_cover: product({
    key: "pac_cover",
    fileNamePattern: "PAC_COV.CSV",
    perYear: false,
    family: OHIO_SOS_PAC_COVER_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  party_cover: product({
    key: "party_cover",
    fileNamePattern: "PAR_COVER.CSV",
    perYear: false,
    family: OHIO_SOS_PARTY_COVER_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  candidate_contributions: product({
    key: "candidate_contributions",
    fileNamePattern: "CAC_CON_<YEAR>.CSV",
    perYear: true,
    family: OHIO_SOS_CANDIDATE_CONTRIBUTIONS_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  candidate_expenditures: product({
    key: "candidate_expenditures",
    fileNamePattern: "CAC_EXP_<YEAR>.CSV",
    perYear: true,
    family: OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  pac_contributions: product({
    key: "pac_contributions",
    fileNamePattern: "PAC_CON_<YEAR>.CSV",
    perYear: true,
    family: OHIO_SOS_PAC_CONTRIBUTIONS_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  pac_expenditures: product({
    key: "pac_expenditures",
    fileNamePattern: "PAC_EXP_<YEAR>.CSV",
    perYear: true,
    family: OHIO_SOS_PAC_EXPENDITURES_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  party_contributions: product({
    key: "party_contributions",
    fileNamePattern: "PPC_CON_<YEAR>.CSV",
    perYear: true,
    family: OHIO_SOS_PARTY_CONTRIBUTIONS_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
  party_expenditures: product({
    key: "party_expenditures",
    fileNamePattern: "PPC_EXP_<YEAR>.CSV",
    perYear: true,
    family: OHIO_SOS_PARTY_EXPENDITURES_FAMILY as OhioSosBulkFileFamily<unknown>,
  }),
};

export function normalizeOhioSosTransactionYear(year: number): number {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    throw new Error(`Invalid Ohio SoS transaction year: ${year}`);
  }
  return year;
}

export function ohioSosArtifactFileName(input: {
  productKey: OhioSosProductKey;
  transactionYear?: number;
}): string {
  const productDefinition = OHIO_SOS_PRODUCTS[input.productKey];
  if (!productDefinition) {
    throw new Error(`Unknown Ohio SoS product: ${input.productKey}`);
  }
  if (!productDefinition.perYear) {
    if (input.transactionYear !== undefined) {
      throw new Error(`Ohio SoS product ${input.productKey} is not published per year`);
    }
    return productDefinition.fileNamePattern;
  }
  if (input.transactionYear === undefined) {
    throw new Error(`Ohio SoS product ${input.productKey} requires a transaction year`);
  }
  return productDefinition.fileNamePattern.replace(
    "<YEAR>",
    String(normalizeOhioSosTransactionYear(input.transactionYear))
  );
}

// A cycle needs the current and prior transaction year: Ohio reports span the
// two-year cycle (docs/plans/ohio_plan.md "Required artifacts per cycle Y").
export function ohioSosCycleArtifacts(cycleYear: number): Array<{
  productKey: OhioSosProductKey;
  transactionYear?: number;
  fileName: string;
}> {
  const year = normalizeOhioSosTransactionYear(cycleYear);
  const artifacts: Array<{ productKey: OhioSosProductKey; transactionYear?: number; fileName: string }> = [];
  for (const productDefinition of Object.values(OHIO_SOS_PRODUCTS)) {
    const years = productDefinition.perYear ? [year - 1, year] : [undefined];
    for (const transactionYear of years) {
      artifacts.push({
        productKey: productDefinition.key,
        transactionYear,
        fileName: ohioSosArtifactFileName({ productKey: productDefinition.key, transactionYear }),
      });
    }
  }
  return artifacts;
}

export type OhioSosArtifactManifest = {
  version: typeof OHIO_SOS_ARTIFACT_SCHEMA_VERSION;
  productKey: OhioSosProductKey;
  // Published file name this artifact was downloaded as.
  fileName: string;
  transactionYear: number | null;
  filePath: string;
  manifestPath: string;
  fileTransferPageUrl: string;
  // Portal-reported "date modified" for the product, when the acquisition
  // script captured it.
  portalDateModified: string | null;
  retrievedAt: string;
  sha256: string;
  byteSize: number;
  rowCount: number;
  encoding: "windows-1252";
  rowSeparator: string | null;
  minTransactionDateIso: string | null;
  maxTransactionDateIso: string | null;
  implausibleDateRowCount: number;
  missingDateRowCount: number;
  missingAmountRowCount: number;
  malformedRowCount: number;
  reportKeys31u: string[];
};

export type OhioSosArtifactPaths = {
  cacheDir: string;
  filePath: string;
  manifestPath: string;
};

export function getOhioSosArtifactPaths(input: {
  cacheDir: string;
  productKey: OhioSosProductKey;
  transactionYear?: number;
}): OhioSosArtifactPaths {
  const fileName = ohioSosArtifactFileName(input);
  const cacheDir = resolve(input.cacheDir);
  return {
    cacheDir,
    filePath: resolve(cacheDir, fileName),
    manifestPath: resolve(cacheDir, `${fileName}.manifest.json`),
  };
}

export async function hashOhioSosFile(path: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    byteSize += buffer.byteLength;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

export async function readOhioSosArtifactManifest(manifestPath: string): Promise<OhioSosArtifactManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<OhioSosArtifactManifest>;
    if (
      parsed.version !== OHIO_SOS_ARTIFACT_SCHEMA_VERSION ||
      typeof parsed.productKey !== "string" ||
      !(parsed.productKey in OHIO_SOS_PRODUCTS) ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.filePath !== "string" ||
      typeof parsed.sha256 !== "string" ||
      typeof parsed.byteSize !== "number" ||
      typeof parsed.rowCount !== "number" ||
      typeof parsed.retrievedAt !== "string" ||
      !Array.isArray(parsed.reportKeys31u)
    ) {
      return null;
    }
    return parsed as OhioSosArtifactManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.warn(`Unexpected error reading Ohio SoS artifact manifest at ${manifestPath}:`, error);
    return null;
  }
}

// Validates a freshly downloaded file against its pinned schema, then
// atomically installs it into the cache with a manifest. Validation runs on
// the incoming path before anything is replaced, so a bad download can never
// destroy a good snapshot.
export async function storeOhioSosArtifact(input: {
  cacheDir: string;
  productKey: OhioSosProductKey;
  transactionYear?: number;
  // Path the acquisition script wrote the download to.
  downloadPath: string;
  portalDateModified?: string | null;
  retrievedAt?: Date;
  now?: Date;
}): Promise<OhioSosArtifactManifest> {
  const productDefinition = OHIO_SOS_PRODUCTS[input.productKey];
  if (!productDefinition) {
    throw new Error(`Unknown Ohio SoS product: ${input.productKey}`);
  }
  const retrievedAt = input.retrievedAt ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) {
    throw new Error("Invalid Ohio SoS artifact retrieval timestamp");
  }
  const paths = getOhioSosArtifactPaths(input);
  const fileName = ohioSosArtifactFileName(input);

  const stats = await streamOhioSosBulkFile({
    path: input.downloadPath,
    family: productDefinition.family,
    now: input.now,
  });
  if (stats.rowCount === 0) {
    throw new Error(`Ohio SoS ${fileName} download has no data rows`);
  }
  const { sha256, byteSize } = await hashOhioSosFile(input.downloadPath);

  // The verified receipt reader requires private originals. Enforce this
  // here rather than depending on the acquisition process's ambient umask.
  await mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  await chmod(paths.cacheDir, 0o700);
  const tmpPath = `${paths.filePath}.tmp-${process.pid}-${retrievedAt.getTime()}`;
  await copyFile(input.downloadPath, tmpPath);
  try {
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, paths.filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  const manifest: OhioSosArtifactManifest = {
    version: OHIO_SOS_ARTIFACT_SCHEMA_VERSION,
    productKey: input.productKey,
    fileName,
    transactionYear: input.transactionYear ?? null,
    filePath: paths.filePath,
    manifestPath: paths.manifestPath,
    fileTransferPageUrl: OHIO_SOS_FILE_TRANSFER_PAGE_URL,
    portalDateModified: input.portalDateModified ?? null,
    retrievedAt: retrievedAt.toISOString(),
    sha256,
    byteSize,
    rowCount: stats.rowCount,
    encoding: "windows-1252",
    rowSeparator: stats.rowSeparator,
    minTransactionDateIso: stats.minTransactionDateIso,
    maxTransactionDateIso: stats.maxTransactionDateIso,
    implausibleDateRowCount: stats.implausibleDateRowCount,
    missingDateRowCount: stats.missingDateRowCount,
    missingAmountRowCount: stats.missingAmountRowCount,
    malformedRowCount: stats.malformedRowCount,
    reportKeys31u: stats.reportKeys31u,
  };
  // Written via rename so a crash can never leave a torn manifest. The data
  // rename above and this rename are still two steps; a crash between them
  // leaves the new bytes with the old manifest. A size change surfaces that
  // as "stale"; a same-size replacement would not be detected without
  // hashing on every status check, which the ~90 MB files rule out. The
  // window is milliseconds in an attended run and the installed bytes were
  // already validated, so the residual risk is stale metadata, not bad data.
  const tmpManifestPath = `${paths.manifestPath}.tmp-${process.pid}-${retrievedAt.getTime()}`;
  await writeFile(tmpManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(tmpManifestPath, paths.manifestPath);
  } catch (error) {
    await rm(tmpManifestPath, { force: true }).catch(() => {});
    throw error;
  }
  return manifest;
}

export type OhioSosArtifactCacheStatus = {
  productKey: OhioSosProductKey;
  transactionYear: number | null;
  fileName: string;
  filePath: string;
  // "ready" — file and manifest agree; "stale" — the cached bytes no longer
  // match the manifest (a partial write or an outside edit); "missing" — not
  // downloaded yet.
  status: "ready" | "stale" | "missing";
  manifest: OhioSosArtifactManifest | null;
};

export async function getOhioSosArtifactStatus(input: {
  cacheDir: string;
  productKey: OhioSosProductKey;
  transactionYear?: number;
}): Promise<OhioSosArtifactCacheStatus> {
  const paths = getOhioSosArtifactPaths(input);
  const fileName = ohioSosArtifactFileName(input);
  const base = {
    productKey: input.productKey,
    transactionYear: input.transactionYear ?? null,
    fileName,
    filePath: paths.filePath,
  };
  const manifest = await readOhioSosArtifactManifest(paths.manifestPath);
  let fileStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    fileStat = await stat(paths.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (!manifest || !fileStat?.isFile()) {
    return { ...base, status: "missing", manifest };
  }
  // Size is the cheap check; the sync re-parses the file anyway, and hashing
  // ~90 MB on every status call would not earn its cost.
  if (fileStat.size !== manifest.byteSize) {
    return { ...base, status: "stale", manifest };
  }
  return { ...base, status: "ready", manifest };
}

export async function getOhioSosCycleArtifactStatus(input: {
  cacheDir: string;
  cycleYear: number;
}): Promise<OhioSosArtifactCacheStatus[]> {
  const statuses: OhioSosArtifactCacheStatus[] = [];
  for (const artifact of ohioSosCycleArtifacts(input.cycleYear)) {
    statuses.push(
      await getOhioSosArtifactStatus({
        cacheDir: input.cacheDir,
        productKey: artifact.productKey,
        transactionYear: artifact.transactionYear,
      })
    );
  }
  return statuses;
}
