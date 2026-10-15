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
  parseMissouriMecReportInventory,
  type MissouriMecOutsideSpenderIdentity,
} from "./missouriMecParsers.js";

export const DEFAULT_MISSOURI_MEC_CACHE_DIR = "scratch/missouri-campaign-finance/mec";
export const MISSOURI_MEC_ARTIFACT_SCHEMA_VERSION = 1;

export type MissouriMecCandidateArtifactType =
  | "committee_info"
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
type CandidateBundleType = typeof CANDIDATE_BUNDLE_TYPES[number];
type CandidateBundleArtifact = { type: CandidateBundleType; body: string; sourceUrl: string };
type CandidateBundleControls = {
  transactionResultBodies: { contributions: string; expenditures: string };
  closingInventoryBody: string;
};
const CONTROL_FILES = ["contribution_results.html", "expenditure_results.html", "closing_inventory.html"] as const;

function candidateBundlePaths(input: { cacheDir?: string; mecid: string; year: number }) {
  const key = normalizeKey({ type: "committee_info", mecid: input.mecid, year: input.year });
  if (isOutsideArtifactKey(key)) throw new Error("Invalid Missouri MEC candidate bundle key");
  const base = resolve(input.cacheDir ?? DEFAULT_MISSOURI_MEC_CACHE_DIR, key.mecid, String(key.year));
  return { base, pointer: resolve(base, "candidate-current.json"), generations: resolve(base, "candidate-generations") };
}

async function publishedCandidateRoot(input: { cacheDir?: string; mecid: string; year: number }): Promise<string | null> {
  const paths = candidateBundlePaths(input);
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
} & CandidateBundleControls): void {
  try {
    if (input.artifacts.length !== 4 || new Set(input.artifacts.map((artifact) => artifact.type)).size !== 4) throw new Error();
    const bodies = new Map(input.artifacts.map((artifact) => [artifact.type, artifact.body]));
    for (const type of CANDIDATE_BUNDLE_TYPES) if (!bodies.has(type)) throw new Error();
    const profile = parseMissouriMecCommitteeInfo(bodies.get("committee_info")!);
    const contributions = parseMissouriMecContributionExport(bodies.get("contributions")!);
    const expenditures = parseMissouriMecExpenditureExport(bodies.get("expenditures")!);
    if (profile.mecid !== input.mecid || [...contributions, ...expenditures].some((row) => row.mecid !== input.mecid)) throw new Error();
    if (contributions.length !== parseMissouriMecFullDisclosureCount(input.transactionResultBodies.contributions) ||
      expenditures.length !== parseMissouriMecFullDisclosureCount(input.transactionResultBodies.expenditures)) throw new Error();
    const canonical = (body: string) => parseMissouriMecReportInventory(body)
      .map((row) => JSON.stringify([row.reportId, row.report, row.dateFiled, row.isAmended, row.lineageKey])).sort();
    if (JSON.stringify(canonical(bodies.get("report_inventory")!)) !== JSON.stringify(canonical(input.closingInventoryBody))) throw new Error();
  } catch { throw new Error("Missouri MEC candidate bundle failed source qualification"); }
}

/** Install all four artifacts and their raw completeness controls with one atomic pointer. */
export async function storeMissouriMecCandidateArtifactBundle(input: {
  cacheDir?: string; mecid: string; year: number; retrievedAt: Date;
  artifacts: readonly CandidateBundleArtifact[];
} & CandidateBundleControls): Promise<void> {
  const mecid = input.mecid.trim().toUpperCase();
  const paths = candidateBundlePaths({ ...input, mecid });
  qualifyCandidateBundle({ ...input, mecid });
  if (Number.isNaN(input.retrievedAt.getTime())) throw new Error("Invalid Missouri MEC artifact timestamp");
  const generation = randomUUID();
  const root = resolve(paths.generations, generation);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    for (const artifact of input.artifacts) await storeMissouriMecArtifact({
      cacheDir: root, key: { type: artifact.type, mecid, year: input.year },
      sourceUrl: artifact.sourceUrl, body: artifact.body, retrievedAt: input.retrievedAt,
    });
    const controls = [input.transactionResultBodies.contributions, input.transactionResultBodies.expenditures, input.closingInventoryBody];
    const files = [];
    for (const [index, file] of CONTROL_FILES.entries()) {
      const body = controls[index]!;
      await writeFile(resolve(root, file), body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      files.push({ file, sha256: createHash("sha256").update(body, "utf8").digest("hex"), byteSize: Buffer.byteLength(body, "utf8") });
    }
    await writeFile(resolve(root, "qualification.json"), JSON.stringify({ version: 1, files }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Read the generation back before publishing; the current pointer remains untouched on any failure.
    await readCandidateBundleAtRoot({ ...input, cacheDir: root, mecid }, true);
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

async function readCandidateBundleAtRoot(input: { cacheDir?: string; mecid: string; year: number }, qualified: boolean) {
  const artifacts = await Promise.all(CANDIDATE_BUNDLE_TYPES.map((type) => readArtifactFromRoot({
    cacheDir: input.cacheDir, key: { type, mecid: input.mecid, year: input.year },
  })));
  if (qualified) {
    try {
      const root = input.cacheDir!;
      const metadata = JSON.parse(await readFile(resolve(root, "qualification.json"), "utf8")) as {
        version: number; files: { file: string; sha256: string; byteSize: number }[];
      };
      if (metadata.version !== 1 || metadata.files.length !== CONTROL_FILES.length) throw new Error();
      const controls = await Promise.all(CONTROL_FILES.map(async (file, index) => {
        const body = await readFile(resolve(root, file), "utf8");
        const expected = metadata.files[index]!;
        if (expected.file !== file || expected.byteSize !== Buffer.byteLength(body, "utf8") ||
          expected.sha256 !== createHash("sha256").update(body, "utf8").digest("hex")) throw new Error();
        return body;
      }));
      qualifyCandidateBundle({ mecid: input.mecid.trim().toUpperCase(),
        artifacts: artifacts.map((artifact, index) => ({ type: CANDIDATE_BUNDLE_TYPES[index]!, body: artifact.body, sourceUrl: artifact.manifest.sourceUrl })),
        transactionResultBodies: { contributions: controls[0]!, expenditures: controls[1]! }, closingInventoryBody: controls[2]!,
      });
    } catch { throw new Error("Missouri MEC candidate bundle failed source qualification"); }
  }
  return artifacts;
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
