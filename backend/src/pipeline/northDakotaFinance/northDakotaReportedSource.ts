import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isNorthDakotaCfrsRawDataRefreshEnabled } from "../../config/featureFlags.js";
import {
  downloadNorthDakotaPresignedFile, getAllNorthDakotaCommittees, getAllNorthDakotaTransactions,
  getNorthDakotaChartData, getNorthDakotaDataDownloadCatalog, getNorthDakotaDataDownloadFileUrl,
  NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL, parseNorthDakotaChartSeries,
  parseNorthDakotaCommitteeRow, parseNorthDakotaTransactionRow,
  type NorthDakotaCfrsClientOptions, type NorthDakotaCommitteeRow, type NorthDakotaTransactionRow,
} from "./northDakotaCfrsClient.js";
import {
  decodeNorthDakotaCsvBytes, parseNorthDakotaContributionCsv, parseNorthDakotaFiledReportCsv,
  parseNorthDakotaReportingScheduleCsv, type NorthDakotaContributionCsvRow,
} from "./northDakotaCfrsCsv.js";
import { apiAmountToCents, checkNorthDakotaYtdSemantics, summarizeNorthDakotaContributionCsv } from "./northDakotaPhaseZero.js";
import { ndAdd, ndHold, ndLiteral, NorthDakotaReportedHold, validateNorthDakotaReportedContributions } from "./northDakotaReportedAggregation.js";
import { resolveNorthDakotaCandidateCycleWindow } from "./northDakotaReportingCycleWindows.js";

export type NorthDakotaReportedKind = "committee" | "ie";
export const ND_REPORTED_REVISION = "nd-original-components-1";
export const ndHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export function ndCanonical(value: unknown): string {
  return JSON.stringify(value, (_, x) => x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
}
type Capture = {
  role: string; file: string; url: string; method: "GET" | "POST"; body: Record<string, unknown> | null;
  status: number; contentType: string | null; startedAt: string; completedAt: string; bytes: number; sha256: string;
};
type Manifest = { version: 1; kind: NorthDakotaReportedKind; electionYear: 2026; captures: Capture[] };
export type NorthDakotaReportedPacket = Readonly<{
  kind: NorthDakotaReportedKind; electionYear: 2026; registry: readonly NorthDakotaCommitteeRow[];
  contributions: readonly NorthDakotaContributionCsvRow[]; ie: readonly NorthDakotaTransactionRow[];
  windowStart: string; windowEnd: string; sourceAt: string; acquisitionStartedAt: string;
  sourceHash: string; sourceRows: number; sourceCents: number; excludedIeRows: number; excludedIeCents: number;
}>;
const qualified = new WeakSet<object>();
function freeze(value: any): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const x of Object.values(value)) freeze(x); }
}
export function isNorthDakotaReportedPacket(value: unknown): value is NorthDakotaReportedPacket {
  return !!value && typeof value === "object" && qualified.has(value);
}
const root = (cacheDir?: string): string => resolve(cacheDir ?? process.env.NORTH_DAKOTA_CFRS_RAW_DATA_CACHE_DIR ?? "scratch/north-dakota-campaign-finance/cfrs", "reported-components");
const sameRows = (a: readonly unknown[], b: readonly unknown[]): boolean => ndCanonical(a.map(ndCanonical).sort()) === ndCanonical(b.map(ndCanonical).sort());
function timestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
async function privateFile(path: string): Promise<Buffer> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.size > 64 * 1024 * 1024) ndHold("private_original_file");
  return readFile(path);
}

/** Replay original bytes, not a normalized harvest relabeled as a response.
 * Native paging, closing census and official charts are checked again here. */
export async function readNorthDakotaReportedPacket(directory: string): Promise<NorthDakotaReportedPacket> {
  const dir = resolve(directory), ds = await lstat(dir);
  if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o077)) ndHold("private_packet_directory");
  const manifestBytes = await privateFile(resolve(dir, "manifest.json"));
  const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as Manifest;
  if (m.version !== 1 || !["committee", "ie"].includes(m.kind) || m.electionYear !== 2026 || !Array.isArray(m.captures) || m.captures.length < 7 || m.captures.length > 1000) ndHold("packet_manifest");
  const records = new Map<string, { capture: Capture; native: any; bytes: Buffer }[]>();
  let previous = "", started = "", completed = "";
  for (let i = 0; i < m.captures.length; i++) {
    const c = m.captures[i]!;
    if (c.file !== `${String(i + 1).padStart(4, "0")}.original` || !timestamp(c.startedAt) || !timestamp(c.completedAt) || c.startedAt > c.completedAt || c.startedAt < previous || c.status !== 200 || !Number.isSafeInteger(c.bytes) || c.bytes <= 0) ndHold("capture_metadata");
    previous = c.completedAt; started ||= c.startedAt; completed = c.completedAt;
    const bytes = await privateFile(resolve(dir, c.file));
    if (bytes.length !== c.bytes || ndHash(bytes) !== c.sha256) ndHold("original_integrity");
    let native: any = null;
    if (!c.role.startsWith("file:")) {
      if (!c.url.startsWith(NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL + "/") || new URL(c.url).search || !c.contentType?.toLowerCase().includes("application/json")) ndHold("json_origin");
      const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (envelope.isSuccess !== true) ndHold("native_envelope");
      native = envelope.responseData;
    }
    const list = records.get(c.role) ?? []; list.push({ capture: c, native, bytes }); records.set(c.role, list);
  }
  const used = new Set<string>();
  function one(role: string) {
    used.add(role); const rows = records.get(role);
    if (rows?.length !== 1) ndHold("missing_source_role");
    return rows[0]!;
  }
  function pages(role: string, endpoint: string, baseBody: Record<string, unknown>): any[] {
    used.add(role); const entries = records.get(role); if (!entries?.length) ndHold("missing_native_pages");
    let count = -1; const rows: any[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { capture: c, native: n } = entries[i]!;
      if (c.url !== `${NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL}/${endpoint}` || c.method !== "POST" || ndCanonical(c.body) !== ndCanonical({ ...baseBody, pageNumber: i + 1, pageSize: 2000 }) || !Number.isSafeInteger(n?.totalRecords) || n.totalRecords < 0 || !Array.isArray(n.data) || n.data.length > 2000) ndHold("native_page_contract");
      if (count === -1) count = n.totalRecords;
      if (n.totalRecords !== count || (i < entries.length - 1 && n.data.length !== 2000) || (i > 0 && rows.length >= count)) ndHold("native_page_count");
      rows.push(...n.data);
    }
    if (rows.length !== count) ndHold("native_count");
    return rows;
  }
  const registryRaw = pages("registry:open", "Committee/getPublicCandidatesCommitteeDataList", {});
  if (!sameRows(registryRaw, pages("registry:close", "Committee/getPublicCandidatesCommitteeDataList", {}))) ndHold("registry_changed");
  const registry = registryRaw.map(parseNorthDakotaCommitteeRow);
  if (!registry.length || new Set(registry.map(r => r.entityId)).size !== registry.length || new Set(registry.map(r => r.orgID)).size !== registry.length) ndHold("registry_identity");
  const tx: NorthDakotaTransactionRow[] = [], category = m.kind === "committee" ? "CON" : "IE";
  for (const year of [2025, 2026]) {
    const body = { transactionCategory: category, sortColumn: "transactionDate", sortDirection: "DESC", transactionYear: String(year), ...(m.kind === "ie" ? { orgTypeCode: "104" } : {}) };
    const opening = pages(`transactions:${year}:open`, "CommitteeTransactions/getAllPublicTransactionDataList", body);
    if (!sameRows(opening, pages(`transactions:${year}:close`, "CommitteeTransactions/getAllPublicTransactionDataList", body))) ndHold("transactions_changed");
    tx.push(...opening.map(parseNorthDakotaTransactionRow));
  }
  if (new Set(tx.map(r => r.transactionID)).size !== tx.length) ndHold("transaction_identity");
  const chartEndpoint = m.kind === "committee" ? "getContributionChartData" : "getIndependentExpenditureChartData";
  const chartCapture = one("chart");
  if (chartCapture.capture.url !== `${NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL}/CommitteeTransactions/${chartEndpoint}` || chartCapture.capture.method !== "GET" || chartCapture.capture.body !== null || !Array.isArray(chartCapture.native)) ndHold("chart_contract");
  const chart = chartCapture.native.map(parseNorthDakotaChartSeries);
  let contributions: NorthDakotaContributionCsvRow[] = [], windowStart = "2025-01-01", windowEnd = "2026-12-31", sourceCents = 0;
  const slices: Record<string, Map<string, number>> = {};
  const addSlice = (name: string, label: string, cents: number) => { const s = slices[name] ??= new Map(); s.set(label, ndAdd(s.get(label) ?? 0, cents)); };
  if (m.kind === "committee") {
    const catalog = one("catalog");
    if (catalog.capture.url !== `${NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL}/AccessReport/getDataDownloadDataList` || catalog.capture.method !== "POST" || ndCanonical(catalog.capture.body) !== ndCanonical({ pageNumber: 1, pageSize: 500 }) || !Array.isArray(catalog.native?.data) || catalog.native.totalRecords !== catalog.native.data.length) ndHold("catalog_contract");
    function file(type: string, year: number): Buffer {
      const match = catalog.native.data.filter((r: any) => r.dataType === type && String(r.year) === String(year));
      if (match.length !== 1 || !Number.isSafeInteger(match[0].id) || match[0].id <= 0) ndHold("catalog_selection");
      const mint = one(`mint:${type}:${year}`), f = one(`file:${type}:${year}`);
      if (mint.capture.url !== `${NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL}/AccessReport/getDataDownloadfile/${match[0].id}` || mint.capture.method !== "POST" || ndCanonical(mint.capture.body) !== "{}") ndHold("mint_contract");
      const u = new URL(mint.native?.fileUrl);
      if (u.protocol !== "https:" || u.username || u.password || u.port || !/^.+\.s3[.-]us-gov-west-1\.amazonaws\.com$/.test(u.hostname) || f.capture.url !== `${u.origin}${u.pathname}` || f.capture.method !== "GET" || f.capture.body !== null) ndHold("native_file_binding");
      return f.bytes;
    }
    const schedules = [2026, 2027].flatMap(year => { const p = parseNorthDakotaReportingScheduleCsv(decodeNorthDakotaCsvBytes(file("Reporting Schedules", year))); if (p.errors.length || p.recoveredRowCount || !p.rows.length) ndHold("schedule_csv"); return p.rows; });
    const window = resolveNorthDakotaCandidateCycleWindow({ scheduleRows: schedules, electionYear: 2026 });
    windowStart = window.windowStart; windowEnd = window.windowEnd;
    if (windowStart !== "2025-01-01") ndHold("cycle_window");
    const filed = parseNorthDakotaFiledReportCsv(decodeNorthDakotaCsvBytes(file("Filed reports", 2026)));
    if (filed.errors.length || filed.recoveredRowCount || !filed.rows.length) ndHold("filed_inventory");
    for (const year of [2025, 2026]) {
      const parsed = parseNorthDakotaContributionCsv(decodeNorthDakotaCsvBytes(file("Contributions", year)));
      if (parsed.errors.length || parsed.recoveredRowCount) ndHold("contribution_csv");
      validateNorthDakotaReportedContributions({ year, csv: parsed.rows, api: tx.filter(r => r.transactionDate.startsWith(`${year}-`)), registry });
      contributions.push(...parsed.rows);
    }
    const summary = summarizeNorthDakotaContributionCsv(contributions, new Map(registry.map(r => [r.entityId, r])));
    for (const [name, buckets] of Object.entries({ "By Contributor Type": summary.byContributorType, "By Committee Type": summary.byCommitteeType, "By Contribution Type": summary.byCategory }))
      for (const [label, bucket] of Object.entries(buckets)) addSlice(name, label, bucket.totalCents);
    sourceCents = contributions.reduce((n, r) => ndAdd(n, r.amountCents), 0);
  } else {
    for (const r of tx) {
      const registered = registry.find(s => s.entityId === r.entityID), cents = apiAmountToCents(r.transactionAmount);
      if (!registered || registered.orgID !== r.orgID || ndLiteral(registered.orgName) !== ndLiteral(r.committeeName) || r.transactionTypeDesc !== "Independent Expenditures" || r.orgType !== "Independent Expenditure Committee" || !/^202[56]-/.test(r.transactionDate) || !Number.isSafeInteger(cents) || cents <= 0) ndHold("ie_dataset");
      sourceCents = ndAdd(sourceCents, cents);
      addSlice("By Recipient Type", r.entityTypeDesc || "Lumpsum", cents); addSlice("By Committee Type", registered.orgType, cents);
    }
    const ytd = checkNorthDakotaYtdSemantics(tx);
    if (ytd.mismatches.length || ytd.missingControlGroupCount || ytd.matchingGroupCount !== ytd.groupCount) ndHold("ie_ytd");
  }
  const expectedSeries = Object.keys(slices);
  if (chart.length !== 3 || new Set(chart.map(s => s.name)).size !== 3) ndHold("chart_schema");
  for (const s of chart) {
    const slice = slices[s.name];
    if (!slice) { if (m.kind !== "ie" || s.name !== "By Purpose Type" || s.totalAmount !== 0 || s.data.length) ndHold("chart_schema"); continue; }
    if (apiAmountToCents(s.totalAmount) !== sourceCents || s.data.length !== slice.size || new Set(s.data.map(p => p.description)).size !== s.data.length || s.data.reduce((n, p) => ndAdd(n, apiAmountToCents(p.amount)), 0) !== sourceCents || s.data.some(p => slice.get(p.description) !== apiAmountToCents(p.amount))) ndHold("chart_closure");
  }
  if (expectedSeries.some(name => !chart.some(s => s.name === name)) || [...records.keys()].some(role => !used.has(role))) ndHold("unclosed_source_graph");
  const excluded = m.kind === "ie" ? tx.filter(r => !r.candidateNameAssocation?.trim()) : [];
  const packet: NorthDakotaReportedPacket = { kind: m.kind, electionYear: 2026, registry, contributions, ie: m.kind === "ie" ? tx : [], windowStart, windowEnd,
    sourceAt: completed, acquisitionStartedAt: started, sourceHash: ndHash(manifestBytes), sourceRows: tx.length, sourceCents,
    excludedIeRows: excluded.length, excludedIeCents: excluded.reduce((n, r) => ndAdd(n, apiAmountToCents(r.transactionAmount)), 0) };
  freeze(packet); qualified.add(packet); return packet;
}

/** Each kind owns its complete original graph. IE never requests contribution
 * CSV, contribution JSON, filed-report inventory or reporting schedules. */
export async function acquireNorthDakotaReportedPacket(kind: NorthDakotaReportedKind, options: {
  cacheDir?: string; clientOptions?: Omit<NorthDakotaCfrsClientOptions, "onJsonResponse">;
} = {}): Promise<NorthDakotaReportedPacket> {
  if (!isNorthDakotaCfrsRawDataRefreshEnabled()) ndHold("raw_refresh_disabled");
  const cache = root(options.cacheDir), name = `${kind}-${randomUUID()}`, dir = resolve(cache, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const captures: Capture[] = []; let role = "";
  async function save(c: Omit<Capture, "file" | "sha256" | "bytes">, bytes: Uint8Array) {
    if (captures.length >= 1000) ndHold("capture_budget");
    const file = `${String(captures.length + 1).padStart(4, "0")}.original`;
    await writeFile(resolve(dir, file), bytes, { mode: 0o600, flag: "wx" });
    const capture = { ...c, file, sha256: ndHash(bytes), bytes: bytes.length }; captures.push(capture);
    await appendFile(resolve(dir, "captures.ndjson"), JSON.stringify(capture) + "\n", { mode: 0o600 });
  }
  const clientOptions: NorthDakotaCfrsClientOptions = { ...options.clientOptions, onJsonResponse: async c => {
    await save({ role, url: c.url, method: c.method, body: c.requestBody, status: c.status, contentType: c.contentType, startedAt: c.startedAt, completedAt: c.completedAt }, c.bytes);
    // Conservative single-flight portal pacing. Tests supply their own
    // transport; ordinary acquisition retains the native verified-TLS client.
    if (!options.clientOptions?.fetchImpl) await new Promise(resolve => setTimeout(resolve, 2000));
  } };
  role = "registry:open"; await getAllNorthDakotaCommittees({}, clientOptions);
  const category = kind === "committee" ? "CON" : "IE";
  async function transactions(phase: "open" | "close") {
    for (const year of [2025, 2026]) { role = `transactions:${year}:${phase}`; await getAllNorthDakotaTransactions({ transactionCategory: category, transactionYear: year, ...(kind === "ie" ? { orgTypeCode: "104" } : {}) }, clientOptions); }
  }
  await transactions("open");
  if (kind === "committee") {
    role = "catalog"; const catalog = await getNorthDakotaDataDownloadCatalog(clientOptions);
    for (const [type, year] of [["Reporting Schedules", 2026], ["Reporting Schedules", 2027], ["Contributions", 2025], ["Contributions", 2026], ["Filed reports", 2026]] as const) {
      const match = catalog.filter(r => r.dataType === type && String(r.year) === String(year));
      if (match.length !== 1) ndHold("catalog_selection");
      role = `mint:${type}:${year}`; const url = await getNorthDakotaDataDownloadFileUrl(match[0]!.id, clientOptions);
      const u = new URL(url); if (u.protocol !== "https:" || u.username || u.password || u.port || !/^.+\.s3[.-]us-gov-west-1\.amazonaws\.com$/.test(u.hostname)) ndHold("native_file_origin");
      const file = `${String(captures.length + 1).padStart(4, "0")}.original`;
      const result = await downloadNorthDakotaPresignedFile({ url, outputPath: resolve(dir, file) }, options.clientOptions);
      const capture: Capture = { role: `file:${type}:${year}`, file, url: result.redactedUrl, method: "GET", body: null, status: result.status, contentType: result.contentType,
        startedAt: result.startedAt, completedAt: result.completedAt, bytes: result.bytesWritten, sha256: result.sha256 };
      captures.push(capture); await appendFile(resolve(dir, "captures.ndjson"), JSON.stringify(capture) + "\n", { mode: 0o600 });
    }
  }
  await transactions("close");
  role = "registry:close"; await getAllNorthDakotaCommittees({}, clientOptions);
  role = "chart"; await getNorthDakotaChartData(kind === "committee" ? "contributions" : "independentExpenditures", clientOptions);
  const manifest: Manifest = { version: 1, kind, electionYear: 2026, captures };
  await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  const packet = await readNorthDakotaReportedPacket(dir);
  const temporary = resolve(cache, `${kind}-${randomUUID()}.pointer`);
  await writeFile(temporary, name, { mode: 0o600, flag: "wx" }); await rename(temporary, resolve(cache, `${kind}.latest`));
  return packet;
}
export async function loadNorthDakotaReportedPacket(kind: NorthDakotaReportedKind, options: { cacheDir?: string; refresh?: boolean } = {}): Promise<NorthDakotaReportedPacket> {
  const cache = root(options.cacheDir);
  let cached: NorthDakotaReportedPacket | undefined;
  try {
    const name = (await privateFile(resolve(cache, `${kind}.latest`))).toString("utf8");
    if (!new RegExp(`^${kind}-[0-9a-f-]{36}$`).test(name)) ndHold("cache_pointer");
    cached = await readNorthDakotaReportedPacket(resolve(cache, name));
    if (cached.kind !== kind) ndHold("cache_kind");
  } catch (e) {
    if (!(e instanceof NorthDakotaReportedHold) && !(e instanceof SyntaxError) && !(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    cached = undefined;
  }
  if (isNorthDakotaCfrsRawDataRefreshEnabled() && (options.refresh || !cached || Date.now() - Date.parse(cached.sourceAt) >= 86400000)) return acquireNorthDakotaReportedPacket(kind, options);
  if (!cached) ndHold("source_unavailable");
  return cached;
}
