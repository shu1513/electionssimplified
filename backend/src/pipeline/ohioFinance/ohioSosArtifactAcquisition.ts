import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOhioSos31uOriginals } from "./ohioSos31uOriginals.js";

import {
  ohioSos31uDetailUrl,
  parseOhioSos31uDetailTable,
  reconcileOhioSos31uReport,
  OHIO_SOS_31U_DETAIL_HEADER,
  type OhioSos31uDetailRow,
  type OhioSos31uReconciliation,
} from "./ohioSos31uDetail.js";
import {
  getOhioSosArtifactPaths,
  ohioSosArtifactFileName,
  ohioSosCycleArtifacts,
  storeOhioSosArtifact,
  type OhioSosArtifactManifest,
  type OhioSosProductKey,
} from "./ohioSosArtifactCache.js";
import {
  isOhioSos31uExpenditureRow,
  streamOhioSosBulkFile,
  OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY,
  OHIO_SOS_PAC_EXPENDITURES_FAMILY,
  OHIO_SOS_PARTY_EXPENDITURES_FAMILY,
  type OhioSosExpenditureRow,
} from "./ohioSosBulkFiles.js";
import {
  closeOhioSosChromeTab,
  evaluateInOhioSosChromeTab,
  navigateOhioSosChromeTab,
  openOhioSosChromeTab,
  type OhioSosChromeSession,
  type OhioSosChromeTab,
} from "./ohioSosChromeClient.js";

// Acquisition for the Ohio SoS bulk artifacts. Retrieval only: files are
// discovered by label, downloaded through the user's own Chrome, validated,
// hashed, and installed in the cache. Nothing here writes to the database.
//
// Operational rules from the 2026-08-04 spike (docs/plans/ohio_plan.md decision 9):
// downloads must be strictly sequential with a delay — rapid requests get
// HTTP 429 — and the `P72_GETID` download ids are non-sequential and get
// reissued, so they are always rediscovered from the file labels.

export const OHIO_SOS_FILE_LIST_BASE_URL = "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:73";
export const OHIO_SOS_FILE_DOWNLOAD_BASE_URL = "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:72";

// The four listing tabs on the file-transfer page.
export const OHIO_SOS_FILE_LIST_TYPES = ["NEW", "CAN", "PAC", "PARTY"] as const;
export type OhioSosFileListType = (typeof OHIO_SOS_FILE_LIST_TYPES)[number];

// Delay between downloads. 8 s cleared a 17-file, 305 MB cycle without a
// single 429 during the spike.
export const DEFAULT_OHIO_SOS_REQUEST_SPACING_MS = 8_000;

export function ohioSosFileListUrl(listType: OhioSosFileListType): string {
  return `${OHIO_SOS_FILE_LIST_BASE_URL}:::::P73_TYPE:${listType}`;
}

export function ohioSosFileDownloadUrl(downloadId: string): string {
  const trimmed = downloadId.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid Ohio SoS download id: ${downloadId}`);
  }
  return `${OHIO_SOS_FILE_DOWNLOAD_BASE_URL}:::NO::P72_GETID:${trimmed}`;
}

export type OhioSosListedFile = {
  listType: OhioSosFileListType;
  productKey: OhioSosProductKey;
  transactionYear: number | undefined;
  // Cache file name for the matched product, e.g. "CAC_CON_2026.CSV". The
  // portal listing does NOT publish file names (see the label table below),
  // so this is derived from the product, not read off the page.
  fileName: string;
  downloadId: string;
  dateModified: string | null;
};

// The file-transfer page lists PRODUCT LABELS, never file names — the file
// name only appears on the download itself. Each product is therefore
// identified by its exact label on its own list page (decision 9: discover
// by label, never hardcode P72_GETID).
//
// Exactness is load-bearing. The NEW list carries per-committee files whose
// labels differ from the statewide annual ones only by the committee name
// between single dashes:
//
//   "Candidate Contributions--2026"                       <- statewide annual
//   "Candidate Contributions-DAVE YOST FOR OHIO-2026"     <- ONE committee
//
// A prefix or substring match would silently install one committee's file
// as the whole state's annual contributions. Matching is a full-string
// comparison, scoped to the product's own list type, so the NEW page can
// never satisfy a required artifact.
const OHIO_SOS_PORTAL_PRODUCT_LABELS: Readonly<
  Record<OhioSosProductKey, { listType: OhioSosFileListType; labelPattern: string }>
> = {
  candidate_list: { listType: "CAN", labelPattern: "Active Candidate List" },
  pac_list: { listType: "PAC", labelPattern: "Active PAC List" },
  candidate_cover: { listType: "CAN", labelPattern: "Candidate Cover Pages" },
  // Observed uppercase ("PAC COVER PAGES"); matching is case-insensitive.
  pac_cover: { listType: "PAC", labelPattern: "PAC Cover Pages" },
  party_cover: { listType: "PARTY", labelPattern: "Party Cover Pages" },
  candidate_contributions: { listType: "CAN", labelPattern: "Candidate Contributions--<YEAR>" },
  candidate_expenditures: { listType: "CAN", labelPattern: "Candidate Expenditures--<YEAR>" },
  pac_contributions: { listType: "PAC", labelPattern: "PAC Contributions--<YEAR>" },
  pac_expenditures: { listType: "PAC", labelPattern: "PAC Expenditures--<YEAR>" },
  party_contributions: { listType: "PARTY", labelPattern: "Party Contributions--<YEAR>" },
  party_expenditures: { listType: "PARTY", labelPattern: "Party Expenditures--<YEAR>" },
};

function normalizePortalLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

function portalLabelMatcher(labelPattern: string): RegExp {
  const normalized = normalizePortalLabel(labelPattern);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace("<YEAR>", "(\\d{4})")}$`);
}

// Exported for tests: resolves one listing row to the product it publishes,
// or null when the row is not a required statewide artifact.
export function ohioSosProductFromListingRow(input: {
  listType: OhioSosFileListType;
  cells: readonly string[];
}): { productKey: OhioSosProductKey; transactionYear: number | undefined } | null {
  for (const [productKey, definition] of Object.entries(OHIO_SOS_PORTAL_PRODUCT_LABELS) as Array<
    [OhioSosProductKey, { listType: OhioSosFileListType; labelPattern: string }]
  >) {
    if (definition.listType !== input.listType) {
      continue;
    }
    const matcher = portalLabelMatcher(definition.labelPattern);
    for (const cell of input.cells) {
      const match = matcher.exec(normalizePortalLabel(cell));
      if (!match) {
        continue;
      }
      const year = match[1] === undefined ? undefined : Number(match[1]);
      return { productKey, transactionYear: year };
    }
  }
  return null;
}

// Reads the listing table straight out of the rendered page. Anchor hrefs
// carry the `P72_GETID` value; the label column carries the file name.
const LIST_PAGE_EXTRACTOR = `(() => {
  const files = [];
  for (const anchor of document.querySelectorAll('a[href*="P72_GETID"]')) {
    const match = /P72_GETID[,:]([0-9]+)/.exec(anchor.getAttribute('href') || '');
    if (!match) continue;
    const row = anchor.closest('tr');
    const cells = row ? Array.from(row.querySelectorAll('td,th')).map((cell) => (cell.textContent || '').trim()) : [];
    files.push({
      downloadId: match[1],
      label: (anchor.textContent || '').trim(),
      cells,
    });
  }
  return files;
})()`;

function looksLikeDate(value: string): boolean {
  return /\d{1,2}\/\d{1,2}\/\d{4}/.test(value);
}


export async function listOhioSosPortalFiles(input: {
  session: OhioSosChromeSession;
  tab: OhioSosChromeTab;
  listTypes?: readonly OhioSosFileListType[];
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<OhioSosListedFile[]> {
  const spacingMs = input.spacingMs ?? DEFAULT_OHIO_SOS_REQUEST_SPACING_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const listTypes = input.listTypes ?? OHIO_SOS_FILE_LIST_TYPES;
  const files: OhioSosListedFile[] = [];

  for (const [index, listType] of listTypes.entries()) {
    if (index > 0) {
      await sleep(spacingMs);
    }
    await navigateOhioSosChromeTab(input.session, input.tab, ohioSosFileListUrl(listType));
    const listed = await evaluateInOhioSosChromeTab<
      Array<{ downloadId: string; label: string; cells: string[] }>
    >(input.session, input.tab, LIST_PAGE_EXTRACTOR);
    if (!listed || listed.length === 0) {
      throw new Error(
        `Ohio SoS file list ${listType} returned no download links. The portal may have served a ` +
          "Cloudflare interstitial — open the page in the same Chrome window and check."
      );
    }
    for (const entry of listed) {
      const product = ohioSosProductFromListingRow({ listType, cells: entry.cells });
      if (!product) {
        continue;
      }
      files.push({
        listType,
        productKey: product.productKey,
        transactionYear: product.transactionYear,
        fileName: ohioSosArtifactFileName({
          productKey: product.productKey,
          transactionYear: product.transactionYear,
        }),
        downloadId: entry.downloadId,
        dateModified: entry.cells.find(looksLikeDate) ?? null,
      });
    }
    input.log?.(`Listed ${listed.length} files under P73_TYPE=${listType}`);
  }

  return files;
}

export type OhioSosDownloadPlanEntry = {
  productKey: OhioSosProductKey;
  transactionYear: number | undefined;
  fileName: string;
  downloadId: string;
  dateModified: string | null;
};

export type OhioSosDownloadPlan = {
  entries: OhioSosDownloadPlanEntry[];
  missingFileNames: string[];
};

// Maps the cycle's required artifacts onto the listing by file name. A
// required file that is not listed is reported rather than guessed at.
export function planOhioSosCycleDownloads(input: {
  cycleYear: number;
  listedFiles: readonly OhioSosListedFile[];
}): OhioSosDownloadPlan {
  const byFileName = new Map<string, OhioSosListedFile>();
  for (const file of input.listedFiles) {
    // Later tabs repeat some files; the first listing wins.
    if (!byFileName.has(file.fileName)) {
      byFileName.set(file.fileName, file);
    }
  }

  const entries: OhioSosDownloadPlanEntry[] = [];
  const missingFileNames: string[] = [];
  for (const artifact of ohioSosCycleArtifacts(input.cycleYear)) {
    const listed = byFileName.get(artifact.fileName);
    if (!listed) {
      missingFileNames.push(artifact.fileName);
      continue;
    }
    entries.push({
      productKey: artifact.productKey,
      transactionYear: artifact.transactionYear,
      fileName: artifact.fileName,
      downloadId: listed.downloadId,
      dateModified: listed.dateModified,
    });
  }
  return { entries, missingFileNames };
}

type DownloadWatcher = {
  wait: (input: { timeoutMs: number }) => Promise<{ filePath: string }>;
  dispose: () => void;
};

// Exported for tests only.
export function watchOhioSosDownload(
  session: OhioSosChromeSession,
  stagingDir: string,
  tab: OhioSosChromeTab
): DownloadWatcher {
  let guid: string | null = null;
  let settle: ((result: { filePath: string }) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  // A small file can finish while the Page.navigate acknowledgement is still
  // in flight, before wait() has armed its callbacks — the terminal event is
  // stored here and replayed by wait().
  let pendingResult: { filePath: string } | null = null;
  let pendingError: Error | null = null;

  const off = session.on((event) => {
    if (event.method === "Browser.downloadWillBegin") {
      // Only the navigation this watcher started may claim the download. The
      // attached Chrome is the user's own profile, so any download they start
      // mid-run would otherwise hijack the watcher (and be deleted after
      // install). The main frame id of a page target equals its target id.
      if (guid === null && String(event.params.frameId) === tab.targetId) {
        guid = String(event.params.guid);
      }
      return;
    }
    if (event.method !== "Browser.downloadProgress" || guid === null || String(event.params.guid) !== guid) {
      return;
    }
    const state = String(event.params.state);
    if (state === "completed") {
      const result = { filePath: join(stagingDir, guid) };
      if (settle) {
        settle(result);
      } else {
        pendingResult = result;
      }
    } else if (state === "canceled") {
      const error = new Error("Chrome canceled the download");
      if (fail) {
        fail(error);
      } else {
        pendingError = error;
      }
    }
  });

  return {
    wait: ({ timeoutMs }) =>
      new Promise<{ filePath: string }>((resolve, reject) => {
        if (pendingResult) {
          resolve(pendingResult);
          return;
        }
        if (pendingError) {
          reject(pendingError);
          return;
        }
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for the download to finish")), timeoutMs);
        settle = (result) => {
          clearTimeout(timeout);
          resolve(result);
        };
        fail = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
      }),
    dispose: off,
  };
}

export type OhioSosDownloadResult = {
  entry: OhioSosDownloadPlanEntry;
  manifest: OhioSosArtifactManifest;
};

export type OhioSosAcquisitionResult = {
  cycleYear: number;
  cacheDir: string;
  downloaded: OhioSosDownloadResult[];
  skipped: OhioSosDownloadPlanEntry[];
  missingFileNames: string[];
  failures: Array<{ fileName: string; message: string }>;
};

export async function downloadOhioSosCycleArtifacts(input: {
  session: OhioSosChromeSession;
  tab: OhioSosChromeTab;
  cycleYear: number;
  cacheDir: string;
  plan: OhioSosDownloadPlan;
  spacingMs?: number;
  downloadTimeoutMs?: number;
  // Products already cached and unchanged, skipped by the caller.
  skip?: ReadonlySet<string>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  now?: Date;
}): Promise<OhioSosAcquisitionResult> {
  const spacingMs = input.spacingMs ?? DEFAULT_OHIO_SOS_REQUEST_SPACING_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stagingDir = await mkdtemp(join(tmpdir(), "ohio-sos-download-"));
  const downloaded: OhioSosDownloadResult[] = [];
  const skipped: OhioSosDownloadPlanEntry[] = [];
  const failures: Array<{ fileName: string; message: string }> = [];

  // Browser-level download behaviour: "allowAndName" saves each file under
  // its download GUID, which sidesteps Chrome's repeated-download guard that
  // silently dropped batched downloads during the spike.
  await input.session.send("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    downloadPath: stagingDir,
    eventsEnabled: true,
  });

  try {
    let downloadIndex = 0;
    for (const entry of input.plan.entries) {
      if (input.skip?.has(entry.fileName)) {
        skipped.push(entry);
        continue;
      }
      if (downloadIndex > 0) {
        await sleep(spacingMs);
      }
      downloadIndex += 1;

      const watcher = watchOhioSosDownload(input.session, stagingDir, input.tab);
      try {
        await input.session.send(
          "Page.navigate",
          { url: ohioSosFileDownloadUrl(entry.downloadId) },
          input.tab.sessionId
        );
        const { filePath } = await watcher.wait({ timeoutMs: input.downloadTimeoutMs ?? 300_000 });
        const manifest = await storeOhioSosArtifact({
          cacheDir: input.cacheDir,
          productKey: entry.productKey,
          transactionYear: entry.transactionYear,
          downloadPath: filePath,
          portalDateModified: entry.dateModified,
          now: input.now,
        });
        downloaded.push({ entry, manifest });
        input.log?.(
          `${entry.fileName}: ${manifest.rowCount.toLocaleString()} rows, ${manifest.byteSize.toLocaleString()} bytes, sha256 ${manifest.sha256.slice(0, 12)}…`
        );
        await rm(filePath, { force: true });
      } catch (error) {
        // One bad file must not abandon the rest of the cycle; the cached
        // snapshot for this product is left untouched.
        failures.push({ fileName: entry.fileName, message: (error as Error).message });
        input.log?.(`${entry.fileName}: FAILED — ${(error as Error).message}`);
      } finally {
        watcher.dispose();
      }
    }
  } finally {
    // setDownloadBehavior outlives the CDP connection: without this reset the
    // user's own downloads would keep landing, GUID-named, in the deleted
    // staging directory.
    await input.session.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    cycleYear: input.cycleYear,
    cacheDir: input.cacheDir,
    downloaded,
    skipped,
    missingFileNames: input.plan.missingFileNames,
    failures,
  };
}

// --- Stage two: Form 31-U detail --------------------------------------------

const EXPENDITURE_FAMILIES: ReadonlyArray<{
  productKey: OhioSosProductKey;
  family: typeof OHIO_SOS_PAC_EXPENDITURES_FAMILY;
}> = [
  { productKey: "candidate_expenditures", family: OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY },
  { productKey: "pac_expenditures", family: OHIO_SOS_PAC_EXPENDITURES_FAMILY },
  { productKey: "party_expenditures", family: OHIO_SOS_PARTY_EXPENDITURES_FAMILY },
];

export type OhioSos31uAnnualTotals = Map<string, { totalCents: number; rowCount: number }>;

// Stage one of decision 4: read the cached annual expenditure files and sum
// their 31-U rows per report key. These totals are reconciliation data only
// and are never added to the detail amounts.
export async function collectOhioSos31uAnnualTotals(input: {
  cacheDir: string;
  cycleYear: number;
  now?: Date;
}): Promise<OhioSos31uAnnualTotals> {
  const totals: OhioSos31uAnnualTotals = new Map();
  for (const { productKey, family } of EXPENDITURE_FAMILIES) {
    for (const transactionYear of [input.cycleYear - 1, input.cycleYear]) {
      const { filePath } = getOhioSosArtifactPaths({ cacheDir: input.cacheDir, productKey, transactionYear });
      try {
        await streamOhioSosBulkFile<OhioSosExpenditureRow>({
          path: filePath,
          family,
          now: input.now,
          visit: (row) => {
            if (!isOhioSos31uExpenditureRow(row) || row.amountCents === null) {
              return;
            }
            const existing = totals.get(row.reportKey);
            if (existing) {
              existing.totalCents += row.amountCents;
              existing.rowCount += 1;
            } else {
              totals.set(row.reportKey, { totalCents: row.amountCents, rowCount: 1 });
            }
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return totals;
}

const DETAIL_TABLE_EXTRACTOR = `(() => {
  const tables = Array.from(document.querySelectorAll('table'));
  for (const table of tables) {
    const headerCells = Array.from(table.querySelectorAll('th')).map((cell) => (cell.textContent || '').trim());
    if (headerCells.length < 10) continue;
    const rows = Array.from(table.querySelectorAll('tr'))
      .map((row) => Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent || '').trim()))
      .filter((cells) => cells.length === headerCells.length);
    if (rows.length > 0) {
      return { headers: headerCells, rows };
    }
  }
  return null;
})()`;

export type OhioSos31uDetailFetchResult = {
  reportKey: string;
  rows: OhioSos31uDetailRow[];
  reconciliation: OhioSos31uReconciliation;
};

export type OhioSos31uAcquisitionResult = {
  cycleYear: number;
  detailPath: string;
  // False when a prior bundle was kept because this run had failures — the
  // reports below were scraped but are NOT what detailPath contains.
  written: boolean;
  reports: OhioSos31uDetailFetchResult[];
  failures: Array<{ reportKey: string; message: string }>;
};

export function ohioSos31uDetailCachePath(input: { cacheDir: string; cycleYear: number }): string {
  return join(input.cacheDir, `31U_DETAIL_${input.cycleYear}.json`);
}

export type OhioSos31uDetailBundleReport = {
  reportKey: string;
  rows: OhioSos31uDetailRow[];
};

// Reads the cached 31-U detail bundle for the sync (fail-closed: any shape
// surprise throws rather than silently dropping reports). Two formats are
// accepted:
// - the version-1 payload fetchOhioSos31uDetails writes (reports with
//   already-parsed rows), and
// - the 2026-08-04 spike's checkpoint format ({ rows: [{ key, rows }] }
//   with raw table cells), which is what the existing cache holds — parsing
//   it through the pinned-header table parser keeps that 305 MB cache
//   usable without another attended Chrome session.
export async function readOhioSos31uDetailBundle(input: {
  cacheDir: string;
  cycleYear: number;
}): Promise<OhioSos31uDetailBundleReport[]> {
  const originals = await readOhioSos31uOriginals(input);
  const detailPath = ohioSos31uDetailCachePath(input);
  // The attended raw refresh still writes only the parsed bundle. Newest data
  // wins: a bundle whose own retrievedAt is later than every native original
  // replaces them; an older, undated or unreadable bundle never does. The
  // mtime check only avoids parsing a large bundle that cannot be newer.
  const newestOriginal = originals === null ? null : Date.parse(originals.retrievedAt ?? "1970-01-01T00:00:00.000Z");
  if (originals !== null) {
    const bundleStat = await stat(detailPath).catch(() => null);
    if (!bundleStat?.isFile() || bundleStat.mtimeMs <= newestOriginal!) return originals.reports;
  }
  let payload: {
    version?: number;
    cycleYear?: number;
    retrievedAt?: unknown;
    reports?: Array<{ reportKey?: unknown; rows?: unknown }>;
    rows?: Array<{ key?: unknown; rows?: unknown }>;
  };
  try {
    payload = JSON.parse(await readFile(detailPath, "utf8"));
  } catch (error) {
    if (originals !== null) return originals.reports;
    throw error;
  }
  if (originals !== null && !(payload.version === 1 && typeof payload.retrievedAt === "string" && Date.parse(payload.retrievedAt) > newestOriginal!)) {
    return originals.reports;
  }

  if (payload.version === 1 && Array.isArray(payload.reports)) {
    if (payload.cycleYear !== input.cycleYear) {
      throw new Error(
        `Ohio SoS 31-U detail bundle at ${detailPath} is for cycle ${payload.cycleYear}, expected ${input.cycleYear}`
      );
    }
    return payload.reports.map((report) => {
      if (typeof report.reportKey !== "string" || !Array.isArray(report.rows)) {
        throw new Error(`Ohio SoS 31-U detail bundle at ${detailPath} has a malformed report entry`);
      }
      const reportKey = report.reportKey;
      // Every field the aggregator consumes is validated, not cast: a
      // damaged or hand-edited bundle must throw here, never mis-aggregate.
      // In particular a direction outside {support, oppose, null} would
      // fall into the aggregator's oppose branch.
      const rows = report.rows.map((rawRow, rowIndex) => {
        const row = rawRow as Partial<OhioSos31uDetailRow>;
        const malformed = (field: string): Error =>
          new Error(
            `Ohio SoS 31-U detail bundle at ${detailPath} report ${reportKey} row ${rowIndex + 1} has a malformed ${field}`
          );
        if (row.reportKey !== reportKey) {
          throw malformed("reportKey");
        }
        if (typeof row.spenderCommitteeName !== "string") {
          throw malformed("spenderCommitteeName");
        }
        if (row.amountCents !== null && !Number.isInteger(row.amountCents)) {
          throw malformed("amountCents");
        }
        if (row.direction !== null && row.direction !== "support" && row.direction !== "oppose") {
          throw malformed("direction");
        }
        if (row.candidateNameOrBallotIssue !== null && typeof row.candidateNameOrBallotIssue !== "string") {
          throw malformed("candidateNameOrBallotIssue");
        }
        if (row.office !== null && typeof row.office !== "string") {
          throw malformed("office");
        }
        return row as OhioSos31uDetailRow;
      });
      return { reportKey, rows };
    });
  }

  if (payload.version === undefined && Array.isArray(payload.rows)) {
    return payload.rows.map((report) => {
      if (typeof report.key !== "string" || !Array.isArray(report.rows)) {
        throw new Error(`Ohio SoS 31-U detail bundle at ${detailPath} has a malformed legacy report entry`);
      }
      return {
        reportKey: report.key,
        rows: parseOhioSos31uDetailTable(
          { headers: [...OHIO_SOS_31U_DETAIL_HEADER], rows: report.rows as string[][] },
          { reportKey: report.key }
        ),
      };
    });
  }

  throw new Error(`Ohio SoS 31-U detail bundle at ${detailPath} has an unrecognized format`);
}

export async function fetchOhioSos31uDetails(input: {
  session: OhioSosChromeSession;
  tab: OhioSosChromeTab;
  cacheDir: string;
  cycleYear: number;
  annualTotals: OhioSos31uAnnualTotals;
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  retrievedAt?: Date;
}): Promise<OhioSos31uAcquisitionResult> {
  const spacingMs = input.spacingMs ?? DEFAULT_OHIO_SOS_REQUEST_SPACING_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reports: OhioSos31uDetailFetchResult[] = [];
  const failures: Array<{ reportKey: string; message: string }> = [];
  const reportKeys = [...input.annualTotals.keys()].sort();

  for (const [index, reportKey] of reportKeys.entries()) {
    if (index > 0) {
      await sleep(spacingMs);
    }
    try {
      await navigateOhioSosChromeTab(input.session, input.tab, ohioSos31uDetailUrl(reportKey));
      const table = await evaluateInOhioSosChromeTab<{ headers: string[]; rows: string[][] } | null>(
        input.session,
        input.tab,
        DETAIL_TABLE_EXTRACTOR
      );
      if (!table) {
        throw new Error("detail page had no data table");
      }
      const rows = parseOhioSos31uDetailTable(table, { reportKey });
      const reconciliation = reconcileOhioSos31uReport({
        reportKey,
        annualTotalCents: input.annualTotals.get(reportKey)?.totalCents ?? 0,
        detailRows: rows,
      });
      reports.push({ reportKey, rows, reconciliation });
      input.log?.(
        `31-U ${reportKey}: ${rows.length} rows, ${reconciliation.matches ? "reconciled" : `MISMATCH ${reconciliation.differenceCents / 100}`}`
      );
    } catch (error) {
      failures.push({ reportKey, message: (error as Error).message });
      input.log?.(`31-U ${reportKey}: FAILED — ${(error as Error).message}`);
    }
  }

  const detailPath = ohioSos31uDetailCachePath(input);
  // A run with failures must not destroy an intact bundle from an earlier
  // run — recovering one means another full paced scrape. With no prior
  // bundle the partial result is still written: the failures ride along in
  // the payload and the scraped rows are better than nothing.
  if (failures.length > 0) {
    const existing = await stat(detailPath).catch(() => null);
    if (existing?.isFile()) {
      input.log?.(
        `31-U: ${failures.length} report(s) failed; keeping the existing ${detailPath} untouched`
      );
      return { cycleYear: input.cycleYear, detailPath, written: false, reports, failures };
    }
  }
  const payload = {
    version: 1 as const,
    cycleYear: input.cycleYear,
    retrievedAt: (input.retrievedAt ?? new Date()).toISOString(),
    header: OHIO_SOS_31U_DETAIL_HEADER,
    reports: reports.map((report) => ({
      reportKey: report.reportKey,
      annualTotalCents: report.reconciliation.annualTotalCents,
      detailTotalCents: report.reconciliation.detailTotalCents,
      reconciled: report.reconciliation.matches,
      rows: report.rows,
    })),
    failures,
  };
  // A details-only run never goes through storeOhioSosArtifact, so the cache
  // directory may not exist yet.
  await mkdir(input.cacheDir, { recursive: true });
  const tmpDetailPath = `${detailPath}.tmp-${process.pid}`;
  await writeFile(tmpDetailPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    await rename(tmpDetailPath, detailPath);
  } catch (error) {
    await rm(tmpDetailPath, { force: true }).catch(() => {});
    throw error;
  }

  return { cycleYear: input.cycleYear, detailPath, written: true, reports, failures };
}

export async function withOhioSosChromeTab<T>(
  session: OhioSosChromeSession,
  run: (tab: OhioSosChromeTab) => Promise<T>
): Promise<T> {
  const tab = await openOhioSosChromeTab(session);
  try {
    return await run(tab);
  } finally {
    await closeOhioSosChromeTab(session, tab);
  }
}

// Exported for the script's dry-run mode: shows what is already cached
// without touching the portal.
export async function listOhioSosCacheContents(cacheDir: string): Promise<string[]> {
  try {
    return (await readdir(cacheDir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
