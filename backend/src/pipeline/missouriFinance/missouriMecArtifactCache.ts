import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  MISSOURI_MEC_PARSER_VERSION,
  parseMissouriMecCommitteeInfo,
  parseMissouriMecContributionExport,
  parseMissouriMecExpenditureExport,
  parseMissouriMecFullDisclosureCount,
  parseMissouriMecOutsideSpenderIdentities,
  parseMissouriMecOutsideSpendingExport,
  parseMissouriMecOutsideSpendingGridPage,
  parseMissouriMecReportInventory,
  type MissouriMecOutsideSpenderIdentity,
} from "./missouriMecParsers.js";

export const DEFAULT_MISSOURI_MEC_CACHE_DIR = "scratch/missouri-campaign-finance/mec";
export const MISSOURI_MEC_ARTIFACT_SCHEMA_VERSION = 1;

export type MissouriMecCandidateArtifactType =
  | "committee_info"
  | "committee_profile"
  | "report_inventory"
  | "contributions"
  | "expenditures"
  | "outside_spender_report_inventory"
  | "outside_spender_contributions";

export type MissouriMecOutsideArtifactType = "outside_spending" | "outside_spender_identities";

export type MissouriMecArtifactType = MissouriMecCandidateArtifactType | MissouriMecOutsideArtifactType;

export type MissouriMecArtifactKey =
  | { type: MissouriMecCandidateArtifactType; mecid: string; year: number }
  | { type: MissouriMecOutsideArtifactType; year: number };

export type MissouriMecArtifactManifest = {
  version: typeof MISSOURI_MEC_ARTIFACT_SCHEMA_VERSION;
  parserVersion: number;
  key: MissouriMecArtifactKey;
  sourceUrl: string;
  retrievedAt: string;
  sha256: string;
  byteSize: number;
  rowCount: number;
};

type MissouriMecOutsideArtifactKey = Extract<MissouriMecArtifactKey, { type: MissouriMecOutsideArtifactType }>;

function isOutsideArtifactKey(key: MissouriMecArtifactKey): key is MissouriMecOutsideArtifactKey {
  return key.type === "outside_spending" || key.type === "outside_spender_identities";
}

function normalizeKey(key: MissouriMecArtifactKey): MissouriMecArtifactKey {
  if (!Number.isSafeInteger(key.year) || key.year < 2002 || key.year > 2100) {
    throw new Error(`Invalid Missouri MEC artifact year: ${key.year}`);
  }
  if (isOutsideArtifactKey(key)) {
    if (key.year < 2019) throw new Error(`Invalid Missouri MEC outside-spending artifact year: ${key.year}`);
    return key;
  }
  const mecid = key.mecid.trim().toUpperCase();
  if (!/^[A-Z]\d{6}$/.test(mecid)) throw new Error("Invalid Missouri MEC artifact MECID");
  return { ...key, mecid };
}

function artifactRelativePath(key: MissouriMecArtifactKey): string {
  const normalized = normalizeKey(key);
  if (isOutsideArtifactKey(normalized)) {
    return normalized.type === "outside_spending"
      ? `_outside/${normalized.year}/outside_spending.xls.html`
      : `_outside/${normalized.year}/outside_spender_identities.json`;
  }
  const extension = normalized.type === "contributions" || normalized.type === "expenditures" || normalized.type === "outside_spender_contributions" ? "xls.html" : "html";
  return `${normalized.mecid}/${normalized.year}/${normalized.type}.${extension}`;
}

function artifactPaths(cacheDir: string, key: MissouriMecArtifactKey): { file: string; manifest: string } {
  const file = resolve(cacheDir, artifactRelativePath(key));
  return { file, manifest: `${file}.manifest.json` };
}

function artifactKeyLabel(key: MissouriMecArtifactKey): string {
  return `${key.type} ${key.year}`;
}

function validateBody(key: MissouriMecArtifactKey, body: string): number {
  switch (key.type) {
    case "committee_info":
    case "committee_profile":
      return parseMissouriMecCommitteeInfo(body).electionHistory.length;
    case "report_inventory":
    case "outside_spender_report_inventory":
      return parseMissouriMecReportInventory(body).length;
    case "contributions":
    case "outside_spender_contributions":
      return parseMissouriMecContributionExport(body).length;
    case "expenditures":
      return parseMissouriMecExpenditureExport(body).length;
    case "outside_spending":
      return parseMissouriMecOutsideSpendingExport(body).length;
    case "outside_spender_identities":
      return parseMissouriMecOutsideSpenderIdentities(body).length;
  }
}

async function atomicWrite(path: string, body: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, body, { encoding: "utf8", mode });
  try {
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function storeMissouriMecArtifact(input: {
  cacheDir?: string;
  key: MissouriMecArtifactKey;
  sourceUrl: string;
  body: string;
  retrievedAt?: Date;
}): Promise<MissouriMecArtifactManifest> {
  const key = normalizeKey(input.key);
  const retrievedAt = input.retrievedAt ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) throw new Error("Invalid Missouri MEC artifact timestamp");
  const rowCount = validateBody(key, input.body);
  const bytes = Buffer.from(input.body, "utf8");
  const paths = artifactPaths(input.cacheDir ?? DEFAULT_MISSOURI_MEC_CACHE_DIR, key);
  await mkdir(dirname(paths.file), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.file), 0o700);
  await atomicWrite(paths.file, input.body, 0o600);
  const manifest: MissouriMecArtifactManifest = {
    version: MISSOURI_MEC_ARTIFACT_SCHEMA_VERSION,
    parserVersion: MISSOURI_MEC_PARSER_VERSION,
    key,
    sourceUrl: input.sourceUrl,
    retrievedAt: retrievedAt.toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    rowCount,
  };
  await atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifest;
}

function sameKey(left: MissouriMecArtifactKey, right: MissouriMecArtifactKey): boolean {
  const a = normalizeKey(left);
  const b = normalizeKey(right);
  if (a.type !== b.type || a.year !== b.year) return false;
  if (isOutsideArtifactKey(a)) return true;
  return !isOutsideArtifactKey(b) && a.mecid === b.mecid;
}

async function readArtifactFromRoot(input: {
  cacheDir?: string;
  key: MissouriMecArtifactKey;
}): Promise<{ body: string; manifest: MissouriMecArtifactManifest }> {
  const key = normalizeKey(input.key);
  const paths = artifactPaths(input.cacheDir ?? DEFAULT_MISSOURI_MEC_CACHE_DIR, key);
  let body: string;
  let manifest: MissouriMecArtifactManifest;
  try {
    [body, manifest] = await Promise.all([
      readFile(paths.file, "utf8"),
      readFile(paths.manifest, "utf8").then((value) => JSON.parse(value) as MissouriMecArtifactManifest),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing Missouri MEC artifact: ${artifactKeyLabel(key)}`);
    }
    throw error;
  }
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    manifest.version !== MISSOURI_MEC_ARTIFACT_SCHEMA_VERSION ||
    manifest.parserVersion !== MISSOURI_MEC_PARSER_VERSION ||
    typeof manifest.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.retrievedAt)) ||
    !sameKey(manifest.key, key) ||
    manifest.sha256 !== sha256 ||
    manifest.byteSize !== bytes.byteLength ||
    manifest.rowCount !== validateBody(key, body)
  ) {
    throw new Error(`Stale or invalid Missouri MEC artifact: ${artifactKeyLabel(key)}`);
  }
  return { body, manifest };
}

const CANDIDATE_BUNDLE_TYPES = ["committee_info", "report_inventory", "contributions", "expenditures"] as const;
const RECEIPT_BUNDLE_TYPES = ["committee_info", "report_inventory", "contributions"] as const;
type CandidateBundleType = typeof CANDIDATE_BUNDLE_TYPES[number];
type CandidateBundleArtifact = { type: CandidateBundleType; body: string; sourceUrl: string };
type CandidateBundleControls = {
  transactionResultBodies: { contributions: string; expenditures?: string };
  closingInventoryBody: string;
};
const CONTROL_FILES = ["contribution_results.html", "expenditure_results.html", "closing_inventory.html"] as const;
const RECEIPT_CONTROL_FILES = ["contribution_results.html", "closing_inventory.html"] as const;

function candidateBundlePaths(input: { cacheDir?: string; mecid: string; year: number }, receiptsOnly = false) {
  const key = normalizeKey({ type: "committee_info", mecid: input.mecid, year: input.year });
  if (isOutsideArtifactKey(key)) throw new Error("Invalid Missouri MEC candidate bundle key");
  const base = resolve(input.cacheDir ?? DEFAULT_MISSOURI_MEC_CACHE_DIR, key.mecid, String(key.year));
  const name = receiptsOnly ? "committee-receipts" : "candidate";
  return { base, pointer: resolve(base, `${name}-current.json`), generations: resolve(base, `${name}-generations`) };
}

async function publishedCandidateRoot(input: { cacheDir?: string; mecid: string; year: number }, receiptsOnly = false): Promise<string | null> {
  const paths = candidateBundlePaths(input, receiptsOnly);
  let raw: string;
  try { raw = await readFile(paths.pointer, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const pointer = JSON.parse(raw) as { version: number; generation: string };
    if (pointer.version !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pointer.generation)) throw new Error();
    return resolve(paths.generations, pointer.generation);
  } catch { throw new Error("Invalid Missouri MEC candidate bundle pointer"); }
}

function qualifyCandidateBundle(input: {
  mecid: string; artifacts: readonly CandidateBundleArtifact[];
} & CandidateBundleControls, receiptsOnly = false): void {
  try {
    const types = receiptsOnly ? RECEIPT_BUNDLE_TYPES : CANDIDATE_BUNDLE_TYPES;
    if (input.artifacts.length !== types.length || new Set(input.artifacts.map((artifact) => artifact.type)).size !== types.length) throw new Error();
    const bodies = new Map(input.artifacts.map((artifact) => [artifact.type, artifact.body]));
    for (const type of types) if (!bodies.has(type)) throw new Error();
    const profile = parseMissouriMecCommitteeInfo(bodies.get("committee_info")!);
    const contributions = parseMissouriMecContributionExport(bodies.get("contributions")!);
    const expenditures = receiptsOnly ? [] : parseMissouriMecExpenditureExport(bodies.get("expenditures")!);
    if (profile.mecid !== input.mecid || [...contributions, ...expenditures].some((row) => row.mecid !== input.mecid)) throw new Error();
    if (contributions.length !== parseMissouriMecFullDisclosureCount(input.transactionResultBodies.contributions) ||
      (!receiptsOnly && expenditures.length !== parseMissouriMecFullDisclosureCount(input.transactionResultBodies.expenditures!))) throw new Error();
    const canonical = (body: string) => parseMissouriMecReportInventory(body)
      .map((row) => JSON.stringify([row.reportId, row.report, row.dateFiled, row.isAmended, row.lineageKey])).sort();
    if (JSON.stringify(canonical(bodies.get("report_inventory")!)) !== JSON.stringify(canonical(input.closingInventoryBody))) throw new Error();
  } catch { throw new Error("Missouri MEC candidate bundle failed source qualification"); }
}

/** Install all four artifacts and their raw completeness controls with one atomic pointer. */
export async function storeMissouriMecCandidateArtifactBundle(input: {
  cacheDir?: string; mecid: string; year: number; retrievedAt: Date;
  artifacts: readonly CandidateBundleArtifact[];
  transactionResultBodies: { contributions: string; expenditures: string };
  closingInventoryBody: string;
}): Promise<void> {
  return storeCandidateBundle(input, false);
}

/** A separately qualified receipt source survives an unavailable expenditure export. */
export async function storeMissouriMecCommitteeReceiptArtifactBundle(input: {
  cacheDir?: string; mecid: string; year: number; retrievedAt: Date;
  artifacts: readonly { type: typeof RECEIPT_BUNDLE_TYPES[number]; body: string; sourceUrl: string }[];
  transactionResultBodies: { contributions: string };
  closingInventoryBody: string;
}): Promise<void> {
  return storeCandidateBundle(input, true);
}

async function storeCandidateBundle(input: {
  cacheDir?: string; mecid: string; year: number; retrievedAt: Date;
  artifacts: readonly CandidateBundleArtifact[];
} & CandidateBundleControls, receiptsOnly: boolean): Promise<void> {
  const mecid = input.mecid.trim().toUpperCase();
  const paths = candidateBundlePaths({ ...input, mecid }, receiptsOnly);
  qualifyCandidateBundle({ ...input, mecid }, receiptsOnly);
  if (Number.isNaN(input.retrievedAt.getTime())) throw new Error("Invalid Missouri MEC artifact timestamp");
  const generation = randomUUID();
  const root = resolve(paths.generations, generation);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    for (const artifact of input.artifacts) await storeMissouriMecArtifact({
      cacheDir: root, key: { type: artifact.type, mecid, year: input.year },
      sourceUrl: artifact.sourceUrl, body: artifact.body, retrievedAt: input.retrievedAt,
    });
    const controls = receiptsOnly
      ? [input.transactionResultBodies.contributions, input.closingInventoryBody]
      : [input.transactionResultBodies.contributions, input.transactionResultBodies.expenditures!, input.closingInventoryBody];
    const files = [];
    for (const [index, file] of (receiptsOnly ? RECEIPT_CONTROL_FILES : CONTROL_FILES).entries()) {
      const body = controls[index]!;
      await writeFile(resolve(root, file), body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      files.push({ file, sha256: createHash("sha256").update(body, "utf8").digest("hex"), byteSize: Buffer.byteLength(body, "utf8") });
    }
    await writeFile(resolve(root, "qualification.json"), JSON.stringify({ version: 1, files }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Read the generation back before publishing; the current pointer remains untouched on any failure.
    await readCandidateBundleAtRoot({ ...input, cacheDir: root, mecid }, true, receiptsOnly);
    await atomicWrite(paths.pointer, `${JSON.stringify({ version: 1, generation })}\n`, 0o600);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readMissouriMecArtifact(input: { cacheDir?: string; key: MissouriMecArtifactKey }): Promise<{
  body: string; manifest: MissouriMecArtifactManifest;
}> {
  const key = normalizeKey(input.key);
  const root = !isOutsideArtifactKey(key) && CANDIDATE_BUNDLE_TYPES.some((type) => type === key.type)
    ? await publishedCandidateRoot({ ...input, mecid: key.mecid, year: key.year }) : null;
  return readArtifactFromRoot({ ...input, cacheDir: root ?? input.cacheDir, key });
}

async function readCandidateBundleAtRoot(input: { cacheDir?: string; mecid: string; year: number }, qualified: boolean, receiptsOnly = false) {
  const types = receiptsOnly ? RECEIPT_BUNDLE_TYPES : CANDIDATE_BUNDLE_TYPES;
  const files = receiptsOnly ? RECEIPT_CONTROL_FILES : CONTROL_FILES;
  const artifacts = await Promise.all(types.map((type) => readArtifactFromRoot({
    cacheDir: input.cacheDir, key: { type, mecid: input.mecid, year: input.year },
  })));
  if (qualified) {
    try {
      const root = input.cacheDir!;
      const metadata = JSON.parse(await readFile(resolve(root, "qualification.json"), "utf8")) as {
        version: number; files: { file: string; sha256: string; byteSize: number }[];
      };
      if (metadata.version !== 1 || metadata.files.length !== files.length) throw new Error();
      const controls = await Promise.all(files.map(async (file, index) => {
        const body = await readFile(resolve(root, file), "utf8");
        const expected = metadata.files[index]!;
        if (expected.file !== file || expected.byteSize !== Buffer.byteLength(body, "utf8") ||
          expected.sha256 !== createHash("sha256").update(body, "utf8").digest("hex")) throw new Error();
        return body;
      }));
      qualifyCandidateBundle({ mecid: input.mecid.trim().toUpperCase(),
        artifacts: artifacts.map((artifact, index) => ({ type: types[index]!, body: artifact.body, sourceUrl: artifact.manifest.sourceUrl })),
        transactionResultBodies: { contributions: controls[0]!, ...(receiptsOnly ? {} : { expenditures: controls[1]! }) },
        closingInventoryBody: controls[receiptsOnly ? 1 : 2]!,
      }, receiptsOnly);
    } catch { throw new Error("Missouri MEC candidate bundle failed source qualification"); }
  }
  return artifacts;
}

/** Independently acquired nonfinancial boundary context, never money or a financial observation. */
export async function readMissouriMecCommitteeProfile(input: { cacheDir?: string; mecid: string; year: number }) {
  const artifact = await readArtifactFromRoot({ ...input, key: { type: "committee_profile", mecid: input.mecid, year: input.year } });
  const profile = parseMissouriMecCommitteeInfo(artifact.body);
  if (profile.mecid !== input.mecid.trim().toUpperCase()) throw new Error("Missouri MEC committee profile identity mismatch");
  return profile;
}

export async function readMissouriMecCommitteeReceiptArtifacts(input: { cacheDir?: string; mecid: string; year: number }) {
  const root = await publishedCandidateRoot(input, true);
  if (root === null) throw new Error("Missing qualified Missouri MEC committee receipt source");
  const artifacts = await readCandidateBundleAtRoot({ ...input, cacheDir: root }, true, true);
  if (new Set(artifacts.map((artifact) => artifact.manifest.retrievedAt)).size !== 1) {
    throw new Error("Mixed-vintage Missouri MEC committee receipt source");
  }
  const [profile, inventory, contributions] = artifacts;
  return {
    committeeInfo: parseMissouriMecCommitteeInfo(profile!.body),
    inventory: parseMissouriMecReportInventory(inventory!.body),
    contributionRows: parseMissouriMecContributionExport(contributions!.body),
    contributionSourceUrl: contributions!.manifest.sourceUrl,
    sourceRetrievedAt: contributions!.manifest.retrievedAt,
    sourceSha256: contributions!.manifest.sha256,
    sourceByteSize: contributions!.manifest.byteSize,
    reportInventorySha256: inventory!.manifest.sha256,
  };
}

export async function readMissouriMecCandidateFinanceArtifacts(input: {
  cacheDir?: string;
  mecid: string;
  year: number;
}): Promise<{
  committeeInfo: Awaited<ReturnType<typeof parseMissouriMecCommitteeInfo>>;
  inventory: ReturnType<typeof parseMissouriMecReportInventory>;
  contributionRows: ReturnType<typeof parseMissouriMecContributionExport>;
  expenditureRows: ReturnType<typeof parseMissouriMecExpenditureExport>;
  contributionSourceUrl: string;
  expenditureSourceUrl: string;
}> {
  const root = await publishedCandidateRoot(input);
  const artifacts = await readCandidateBundleAtRoot({ ...input, cacheDir: root ?? input.cacheDir }, root !== null);
  const retrievalTimes = new Set(artifacts.map((artifact) => artifact.manifest.retrievedAt));
  if (retrievalTimes.size !== 1) {
    throw new Error(`Mixed-vintage Missouri MEC artifact bundle: ${input.year}`);
  }
  const [committeeInfo, inventory, contributions, expenditures] = artifacts;
  return {
    committeeInfo: parseMissouriMecCommitteeInfo(committeeInfo!.body),
    inventory: parseMissouriMecReportInventory(inventory!.body),
    contributionRows: parseMissouriMecContributionExport(contributions!.body),
    expenditureRows: parseMissouriMecExpenditureExport(expenditures!.body),
    contributionSourceUrl: contributions!.manifest.sourceUrl,
    expenditureSourceUrl: expenditures!.manifest.sourceUrl,
  };
}

function assertOutsideIdentityCoverage(input: {
  rows: ReturnType<typeof parseMissouriMecOutsideSpendingExport>;
  identities: readonly MissouriMecOutsideSpenderIdentity[];
}): void {
  const rowNames = new Set(input.rows.map((row) => row.reportingCommittee));
  const identityNames = new Set(input.identities.map((row) => row.reportingCommittee));
  const missing = [...rowNames].filter((name) => !identityNames.has(name));
  const extra = [...identityNames].filter((name) => !rowNames.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Missouri MEC outside-spender identity coverage mismatch: missing=${missing.length}, extra=${extra.length}`
    );
  }
}

type OutsideSourceControls = { resultsBody: string; gridPageBodies: readonly string[] };
export type MissouriMecOutsideSourceControl = { file: string; sha256: string; byteSize: number };

function outsideBundlePaths(input: { cacheDir?: string; year: number }, snapshot = false) {
  const key = normalizeKey({ type: "outside_spending", year: input.year });
  const base = resolve(input.cacheDir ?? DEFAULT_MISSOURI_MEC_CACHE_DIR, "_outside", String(key.year));
  const name = snapshot ? "registered-ie-export" : "registered-ie";
  return { pointer: resolve(base, `${name}-current.json`), generations: resolve(base, `${name}-generations`) };
}
async function publishedOutsideRoot(input: { cacheDir?: string; year: number }, snapshot = false): Promise<string | null> {
  const paths = outsideBundlePaths(input, snapshot);
  let raw: string;
  try { raw = await readFile(paths.pointer, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const pointer = JSON.parse(raw) as { version: number; generation: string };
    if (pointer.version !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pointer.generation)) throw new Error();
    return resolve(paths.generations, pointer.generation);
  } catch { throw new Error("Invalid Missouri MEC yearly outside source pointer"); }
}
export function parseMissouriMecOutsideSpendingResultCount(body: string): number {
  try {
  const labels = [...body.replace(/<[^>]+>/g, " ").matchAll(/(\S+)\s+records found/gi)];
  if (!labels.length) throw new Error();
  const counts = labels.map(label => {
    const text = label[1]!;
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text)) throw new Error();
    const count = Number(text.replace(/,/g, ""));
    if (!Number.isSafeInteger(count)) throw new Error();
    return count;
  });
  if (new Set(counts).size !== 1) throw new Error();
  return counts[0]!;
  } catch { throw new Error("Invalid Missouri MEC outside-spending result count"); }
}
/** Native full-year completeness controls; equal occurrences remain separate. */
export function qualifyMissouriMecOutsideSpendingSource(input: { exportBody: string } & OutsideSourceControls): void {
  try {
    const rows = parseMissouriMecOutsideSpendingExport(input.exportBody);
    if (parseMissouriMecOutsideSpendingResultCount(input.resultsBody) !== rows.length || !Array.isArray(input.gridPageBodies)) throw new Error();
    if (rows.length === 0) {
      if (input.gridPageBodies.length !== 0 || /grvExpenditures_lblName_\d+"/i.test(input.resultsBody)) throw new Error();
      return;
    }
    if (input.gridPageBodies.length === 0 || input.gridPageBodies.length > Math.ceil(rows.length / 25) + 1 ||
      input.gridPageBodies[0] !== input.resultsBody) throw new Error();
    const key = (row: ReturnType<typeof parseMissouriMecOutsideSpendingExport>[number]) => JSON.stringify([
      row.candidateNameAndAddress, row.officeSought, row.supportOppose, row.expenditureDate,
      row.amountCents, row.reportingCommittee, row.report,
    ]);
    const occurrences = new Map<string, number>();
    for (const row of rows) { const k = key(row); occurrences.set(k, (occurrences.get(k) ?? 0) + 1); }
    let count = 0;
    for (const [index, body] of input.gridPageBodies.entries()) {
      const page = parseMissouriMecOutsideSpendingGridPage(body);
      if (page.currentPage !== index + 1 || count >= rows.length) throw new Error();
      for (const row of page.rows) {
        count++; const k = key(row), remaining = occurrences.get(k) ?? 0;
        if (remaining === 0) throw new Error(); occurrences.set(k, remaining - 1);
      }
      if (count < rows.length && !page.nextPageEventTarget) throw new Error();
    }
    if (count !== rows.length || [...occurrences.values()].some(n => n !== 0)) throw new Error();
  } catch { throw new Error("Missouri MEC yearly outside source failed qualification"); }
}
function qualifyOutsideBundle(input: { exportBody: string; identities: readonly MissouriMecOutsideSpenderIdentity[] } & OutsideSourceControls): void {
  qualifyMissouriMecOutsideSpendingSource(input);
  try {
    const rows = parseMissouriMecOutsideSpendingExport(input.exportBody);
    const identities = parseMissouriMecOutsideSpenderIdentities(JSON.stringify(input.identities));
    assertOutsideIdentityCoverage({ rows, identities });
  } catch { throw new Error("Missouri MEC yearly outside source failed qualification"); }
}

/** The export and auxiliary identities publish as one immutable year generation.
 * Null native identities remain valid source data; they do not erase reported spend. */
export async function storeMissouriMecOutsideSpendingArtifactBundle(input: {
  cacheDir?: string; year: number; sourceUrl: string; exportBody: string;
  identities: readonly MissouriMecOutsideSpenderIdentity[]; retrievedAt: Date;
} & OutsideSourceControls): Promise<void> {
  const stable = structuredClone(input);
  const paths = outsideBundlePaths(stable);
  qualifyOutsideBundle(stable);
  if (!Number.isFinite(stable.retrievedAt.getTime())) throw new Error("Invalid Missouri MEC artifact timestamp");
  const generation = randomUUID(), root = resolve(paths.generations, generation);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const identityBody = `${JSON.stringify([...stable.identities].sort((a, b) => a.reportingCommittee.localeCompare(b.reportingCommittee)), null, 2)}\n`;
    for (const artifact of [{ type: "outside_spending" as const, body: stable.exportBody },
      { type: "outside_spender_identities" as const, body: identityBody }]) {
      await storeMissouriMecArtifact({ cacheDir: root, key: { type: artifact.type, year: stable.year },
        sourceUrl: stable.sourceUrl, body: artifact.body, retrievedAt: stable.retrievedAt });
    }
    const controls = [{ file: "results.html", body: stable.resultsBody },
      ...stable.gridPageBodies.slice(1).map((body, index) => ({ file: `grid-${String(index + 2).padStart(3, "0")}.html`, body }))];
    const files: MissouriMecOutsideSourceControl[] = [];
    for (const control of controls) {
      await writeFile(resolve(root, control.file), control.body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      files.push({ file: control.file, sha256: createHash("sha256").update(control.body, "utf8").digest("hex"), byteSize: Buffer.byteLength(control.body, "utf8") });
    }
    await writeFile(resolve(root, "qualification.json"), JSON.stringify({ version: 1, gridPageCount: stable.gridPageBodies.length, files }),
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    await readQualifiedOutsideAtRoot({ cacheDir: root, year: stable.year });
    await atomicWrite(paths.pointer, `${JSON.stringify({ version: 1, generation })}\n`, 0o600);
  } catch { await rm(root, { recursive: true, force: true }).catch(() => {});
    throw new Error("Missouri MEC yearly outside source publication failed"); }
}

async function readQualifiedOutsideAtRoot(input: { cacheDir: string; year: number }) {
  try {
    const [outside, identity] = await Promise.all(["outside_spending", "outside_spender_identities"].map(type =>
      readArtifactFromRoot({ ...input, key: { type: type as MissouriMecOutsideArtifactType, year: input.year } })));
    if (outside!.manifest.retrievedAt !== identity!.manifest.retrievedAt || outside!.manifest.sourceUrl !== identity!.manifest.sourceUrl) throw new Error();
    const metadata = JSON.parse(await readFile(resolve(input.cacheDir, "qualification.json"), "utf8")) as {
      version: number; gridPageCount: number; files: MissouriMecOutsideSourceControl[];
    };
    const rows = parseMissouriMecOutsideSpendingExport(outside!.body);
    if (metadata.version !== 1 || !Number.isSafeInteger(metadata.gridPageCount) || metadata.gridPageCount < 0 ||
      metadata.gridPageCount > Math.ceil(rows.length / 25) + 1 || !Array.isArray(metadata.files)) throw new Error();
    const expectedFiles = ["results.html", ...Array.from({ length: Math.max(0, metadata.gridPageCount - 1) }, (_, index) => `grid-${String(index + 2).padStart(3, "0")}.html`)];
    if (metadata.files.length !== expectedFiles.length) throw new Error();
    const bodies = await Promise.all(expectedFiles.map(async (file, index) => {
      const expected = metadata.files[index]!;
      const bytes = await readFile(resolve(input.cacheDir, file));
      if (expected.file !== file || expected.byteSize !== bytes.byteLength || expected.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }));
    const identities = parseMissouriMecOutsideSpenderIdentities(identity!.body);
    qualifyOutsideBundle({ exportBody: outside!.body, identities, resultsBody: bodies[0]!, gridPageBodies: metadata.gridPageCount === 0 ? [] : bodies });
    return { rows, identities, sourceKind: "grid_reconciled_export" as const, sourceUrl: outside!.manifest.sourceUrl, sourceRetrievedAt: outside!.manifest.retrievedAt,
      sourceSha256: outside!.manifest.sha256, sourceByteSize: outside!.manifest.byteSize,
      sourceRowCount: rows.length, sourcePageCount: metadata.gridPageCount, sourceControls: metadata.files.map(({ file, sha256, byteSize }) => ({ file, sha256, byteSize })) };
  } catch { throw new Error("Missouri MEC yearly outside source failed qualification"); }
}

/** One native financial export response, tied to its advertised count/year.
 * This does not certify amendment precedence or net economic effects. */
export function qualifyMissouriMecOutsideSpendingExportSnapshot(input: { year: number; exportBody: string; resultsBody: string }): void {
  try {
    if (!Number.isSafeInteger(input.year) || input.year < 2019 || input.year > 2100) throw new Error();
    const selects = [...input.resultsBody.matchAll(/<select\b[^>]*id="[^"]*ddYear"[^>]*>([\s\S]*?)<\/select>/gi)];
    if (selects.length !== 1) throw new Error();
    const selected = [...selects[0]![1]!.matchAll(/<option\b([^>]*)>[\s\S]*?<\/option>/gi)]
      .filter(match => /\bselected(?:\s*=\s*(?:"selected"|'selected'|selected))?(?:\s|$)/i.test(match[1]!));
    if (selected.length !== 1 || /\bvalue="([^"]*)"/i.exec(selected[0]![1]!)?.[1] !== String(input.year)) throw new Error();
    // The observed native Excel response is one complete outer table. It must
    // not silently accept a truncated table, trailing table or discarded cells.
    if (!/^\s*<table\b[^>]*>[\s\S]*<\/table\s*>\s*$/i.test(input.exportBody) ||
      [...input.exportBody.matchAll(/<table\b/gi)].length !== 1 || [...input.exportBody.matchAll(/<\/table\s*>/gi)].length !== 1) throw new Error();
    for (const body of [input.exportBody, input.resultsBody]) {
      const roundTrip = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(body, "utf8"));
      if (roundTrip !== body) throw new Error();
    }
    const rows = parseMissouriMecOutsideSpendingExport(input.exportBody);
    if (rows.length !== parseMissouriMecOutsideSpendingResultCount(input.resultsBody)) throw new Error();
  } catch { throw new Error("Missouri MEC export snapshot failed qualification"); }
}

/** Publish export-only financial authority separately from grid/identity packets. */
export async function storeMissouriMecOutsideSpendingExportSnapshot(input: {
  cacheDir?: string; year: number; sourceUrl: string; exportBody: string; resultsBody: string; retrievedAt: Date;
}): Promise<void> {
  const stable = structuredClone(input), paths = outsideBundlePaths(stable, true);
  qualifyMissouriMecOutsideSpendingExportSnapshot(stable);
  if (!Number.isFinite(stable.retrievedAt.getTime())) throw new Error("Invalid Missouri MEC artifact timestamp");
  const generation = randomUUID(), root = resolve(paths.generations, generation);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await storeMissouriMecArtifact({ cacheDir: root, key: { type: "outside_spending", year: stable.year },
      sourceUrl: stable.sourceUrl, body: stable.exportBody, retrievedAt: stable.retrievedAt });
    await writeFile(resolve(root, "results.html"), stable.resultsBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const files = [{ file: "results.html", sha256: createHash("sha256").update(stable.resultsBody, "utf8").digest("hex"), byteSize: Buffer.byteLength(stable.resultsBody, "utf8") }];
    await writeFile(resolve(root, "qualification.json"), JSON.stringify({ version: 1, sourceKind: "native_export_snapshot", year: stable.year, files }),
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    await readOutsideExportSnapshotAtRoot({ cacheDir: root, year: stable.year });
    await atomicWrite(paths.pointer, `${JSON.stringify({ version: 1, generation })}\n`, 0o600);
  } catch { await rm(root, { recursive: true, force: true }).catch(() => {});
    throw new Error("Missouri MEC export snapshot publication failed"); }
}

async function readOutsideExportSnapshotAtRoot(input: { cacheDir: string; year: number }) {
  try {
    const artifact = await readArtifactFromRoot({ ...input, key: { type: "outside_spending", year: input.year } });
    const bytes = await readFile(artifactPaths(input.cacheDir, { type: "outside_spending", year: input.year }).file);
    if (bytes.byteLength !== artifact.manifest.byteSize || createHash("sha256").update(bytes).digest("hex") !== artifact.manifest.sha256) throw new Error();
    const exportBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const metadata = JSON.parse(await readFile(resolve(input.cacheDir, "qualification.json"), "utf8")) as {
      version: number; sourceKind: string; year: number; files: MissouriMecOutsideSourceControl[];
    };
    if (metadata.version !== 1 || metadata.sourceKind !== "native_export_snapshot" || metadata.year !== input.year || !Array.isArray(metadata.files) || metadata.files.length !== 1) throw new Error();
    const expected = metadata.files[0]!;
    const resultBytes = await readFile(resolve(input.cacheDir, "results.html"));
    if (expected.file !== "results.html" || expected.byteSize !== resultBytes.byteLength || expected.sha256 !== createHash("sha256").update(resultBytes).digest("hex")) throw new Error();
    const resultsBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(resultBytes);
    qualifyMissouriMecOutsideSpendingExportSnapshot({ year: input.year, exportBody, resultsBody });
    const rows = parseMissouriMecOutsideSpendingExport(exportBody);
    return { rows, sourceKind: "native_export_snapshot" as const, sourcePageCount: null,
      sourceUrl: artifact.manifest.sourceUrl, sourceRetrievedAt: artifact.manifest.retrievedAt,
      sourceSha256: artifact.manifest.sha256, sourceByteSize: artifact.manifest.byteSize, sourceRowCount: rows.length,
      sourceControls: [{ file: expected.file, sha256: expected.sha256, byteSize: expected.byteSize }] };
  } catch { throw new Error("Missouri MEC export snapshot failed qualification"); }
}

/** New independent IE money requires its own qualified generation, never a loose cache pair. */
export async function readMissouriMecQualifiedOutsideSpendingArtifacts(input: { cacheDir?: string; year: number }) {
  const snapshot = await publishedOutsideRoot(input, true);
  if (snapshot !== null) return readOutsideExportSnapshotAtRoot({ cacheDir: snapshot, year: input.year });
  const root = await publishedOutsideRoot(input);
  if (root === null) throw new Error("Missing qualified Missouri MEC yearly outside source");
  return readQualifiedOutsideAtRoot({ cacheDir: root, year: input.year });
}

export async function storeMissouriMecOutsideSpendingArtifacts(input: {
  cacheDir?: string;
  year: number;
  sourceUrl: string;
  exportBody: string;
  identities: readonly MissouriMecOutsideSpenderIdentity[];
  retrievedAt?: Date;
}): Promise<{ rowCount: number; identityCount: number }> {
  const rows = parseMissouriMecOutsideSpendingExport(input.exportBody);
  const identities = parseMissouriMecOutsideSpenderIdentities(JSON.stringify(input.identities));
  assertOutsideIdentityCoverage({ rows, identities });
  const retrievedAt = input.retrievedAt ?? new Date();
  const identityBody = `${JSON.stringify(
    [...identities].sort((left, right) => left.reportingCommittee.localeCompare(right.reportingCommittee)),
    null,
    2
  )}\n`;
  await Promise.all([
    storeMissouriMecArtifact({
      cacheDir: input.cacheDir,
      key: { type: "outside_spending", year: input.year },
      sourceUrl: input.sourceUrl,
      body: input.exportBody,
      retrievedAt,
    }),
    storeMissouriMecArtifact({
      cacheDir: input.cacheDir,
      key: { type: "outside_spender_identities", year: input.year },
      sourceUrl: input.sourceUrl,
      body: identityBody,
      retrievedAt,
    }),
  ]);
  return { rowCount: rows.length, identityCount: identities.length };
}

export async function readMissouriMecOutsideSpendingArtifacts(input: {
  cacheDir?: string;
  year: number;
}): Promise<{
  rows: ReturnType<typeof parseMissouriMecOutsideSpendingExport>;
  identities: MissouriMecOutsideSpenderIdentity[];
  sourceUrl: string;
}> {
  const root = await publishedOutsideRoot(input);
  if (root !== null) return readQualifiedOutsideAtRoot({ cacheDir: root, year: input.year });
  // Legacy compatibility only: new independently stored IE must use the qualified reader.
  const [outside, identityArtifact] = await Promise.all([
    readMissouriMecArtifact({ ...input, key: { type: "outside_spending", year: input.year } }),
    readMissouriMecArtifact({ ...input, key: { type: "outside_spender_identities", year: input.year } }),
  ]);
  if (outside.manifest.retrievedAt !== identityArtifact.manifest.retrievedAt) {
    throw new Error(`Mixed-vintage Missouri MEC outside-spending artifact bundle: ${input.year}`);
  }
  const rows = parseMissouriMecOutsideSpendingExport(outside.body);
  const identities = parseMissouriMecOutsideSpenderIdentities(identityArtifact.body);
  assertOutsideIdentityCoverage({ rows, identities });
  return { rows, identities, sourceUrl: outside.manifest.sourceUrl };
}

export async function readMissouriMecOutsideSpenderContributionArtifacts(input: {
  cacheDir?: string;
  mecid: string;
  year: number;
}): Promise<{
  inventory: ReturnType<typeof parseMissouriMecReportInventory>;
  contributionRows: ReturnType<typeof parseMissouriMecContributionExport>;
  sourceUrl: string;
}> {
  const [inventory, contributions] = await Promise.all([
    readMissouriMecArtifact({ ...input, key: { type: "outside_spender_report_inventory", mecid: input.mecid, year: input.year } }),
    readMissouriMecArtifact({ ...input, key: { type: "outside_spender_contributions", mecid: input.mecid, year: input.year } }),
  ]);
  if (inventory.manifest.retrievedAt !== contributions.manifest.retrievedAt) {
    throw new Error(`Mixed-vintage Missouri MEC outside-spender artifact bundle: ${input.year}`);
  }
  return {
    inventory: parseMissouriMecReportInventory(inventory.body),
    contributionRows: parseMissouriMecContributionExport(contributions.body),
    sourceUrl: contributions.manifest.sourceUrl,
  };
}
