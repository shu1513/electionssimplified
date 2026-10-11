import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAME } from "../../constants/brand.js";
import type { MichiganMitnLegacyExpenditureRow } from "./michiganMitnLegacyRowTypes.js";
import {
  fetchMichiganMitnCommitteeSearch,
  MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL,
  MICHIGAN_MITN_STATEMENT_YEAR_IDS,
  parseMichiganMitnCommitteeSearchHtml,
  parseMichiganMitnExportXlsxRows,
  type MichiganMitnCommitteeSearchRow,
  type MichiganMitnFetchFn,
} from "./michiganMitnPublicSearchClient.js";
import { fetchMichiganMitnCurrentExpenditureRows } from "./michiganMitnFilingPolicy.js";

export const DEFAULT_MICHIGAN_MITN_RAW_CACHE_DIR = fileURLToPath(
  new URL("../../../scratch/michigan-campaign-finance/mitn/", import.meta.url)
);

/** Verified official 2026-10-11 contract, including the source's "Opposing" typo. */
export const MICHIGAN_MITN_IE_EXPORT_HEADER = [
  "Record Type (1=Parent, 2=Child)", "Expense ID", "Filing Status (C=Complete,I=Incomplete)",
  "Document Statement Year", "Document Statement Type", "Expense Category",
  "Expending Committee Name", "Expending Committee ID#", "Expending Committee Type",
  "Type of Expenditure", "Type of In-Kind Expenditure", "Loan", "Payee First Name",
  "Organization Name/Payee Last Name", "Payee Address", "Payee City", "Payee State", "Payee Zip",
  "Support/Opposing (S=Support,O=Opposing)", "Candidate or Ballot Issue", "Office Sought (if candidate)",
  "Fundraising Event Name", "Date of Expenditure", "Amount of Expenditure", "Cumulative Expense Amount",
  "Purpose of Expenditure", "Vendor's Name and Information", "Ballot Question Information", "Campaign Information",
] as const;

function validateIeTable(rows: readonly (readonly string[])[]): void {
  const header = rows[0];
  if (!header || header.length !== MICHIGAN_MITN_IE_EXPORT_HEADER.length ||
      MICHIGAN_MITN_IE_EXPORT_HEADER.some((name, i) => header[i] !== name)) {
    throw new Error("Michigan MiTN IE export has missing or unexpected headers");
  }
}

/** No version metadata exists in IE exports. Conflicts must preserve stored finances. */
export function dedupeMichiganMitnIndependentExpenditureExportRows(
  rows: readonly (readonly string[])[]
): string[][] {
  validateIeTable(rows);
  const parents = new Map<string, { fingerprint: string; row: string[] }>();
  for (const raw of rows.slice(1)) {
    const row = MICHIGAN_MITN_IE_EXPORT_HEADER.map((_, i) => raw[i]?.trim() ?? "");
    if (row.every((cell) => cell === "")) continue;
    if (row[0] === "2") continue;
    if (row[0] !== "1" || !row[1] || !/^\d+$/.test(row[7]!)) {
      throw new Error("Michigan MiTN IE export has an invalid parent expense identity");
    }
    const key = `${row[7]!.replace(/^0+(?=\d)/, "")}:${row[1]}`;
    // Filing completion, filing year and period can differ without changing the
    // economic transaction; every other exported field must remain identical.
    const fingerprint = JSON.stringify(row.filter((_, i) => ![2, 3, 4].includes(i)));
    const previous = parents.get(key);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new Error(`Michigan MiTN IE export has conflicting versions of expense ${key}`);
    }
    if (!previous) parents.set(key, { fingerprint, row });
  }
  return [[...MICHIGAN_MITN_IE_EXPORT_HEADER], ...[...parents.values()].map(({ row }) => row)];
}

const TARGET_OFFICES: ReadonlyMap<string, string> = new Map([
  ["State Senator", "State Senate"], ["Representative in State Legislature", "State House"],
  ["Governor", "Governor"], ["Lieutenant Governor", "Lieutenant Governor"],
  ["Secretary of State", "Secretary of State"], ["Attorney General", "Attorney General"],
]);

function targetFromRow(row: readonly string[]): { committeeName: string; office: string } | null {
  if (row[19] !== "Candidate") return null;
  const value = row[28] ?? "";
  const match = /^Candidate - State & Judicial,\s*([^,]+),\s*(.+) - (Support|Oppose)$/.exec(value);
  if (!match) return null;
  const office = TARGET_OFFICES.get(match[1]!.trim());
  const committeeName = match[2]!.trim();
  if (!office || !committeeName || /Candidate -| - (?:Support|Oppose)|[\r\n|;]/.test(committeeName)) return null;
  if ((match[3] === "Support" ? "S" : "O") !== row[18]) return null;
  return { committeeName, office };
}

function transactionYear(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error(`Michigan MiTN IE export has an invalid expenditure date: ${value}`);
  const [, month, day, year] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 ||
      parsed.getUTCDate() !== Number(day)) {
    throw new Error(`Michigan MiTN IE export has an invalid expenditure date: ${value}`);
  }
  return year!;
}

/**
 * Scope both full and amended tables before filing reconciliation. Original
 * eligible rows remain present even if an amendment removes or retargets every
 * eligible expense; the filing manifest can then replace that period with zero.
 * Do not deduplicate versions here: an amendment may legitimately change money.
 */
export function scopeMichiganMitnIndependentExpenditureExportRows(
  rows: readonly (readonly string[])[], transactionYears: readonly number[]
): string[][] {
  validateIeTable(rows);
  if (transactionYears.some((year) => !Number.isInteger(year) || year < 1000 || year > 9999)) {
    throw new Error("Michigan MiTN IE scope has an invalid transaction year");
  }
  const years = new Set(transactionYears);
  const result: string[][] = [[...MICHIGAN_MITN_IE_EXPORT_HEADER]];
  for (const raw of rows.slice(1)) {
    const row = MICHIGAN_MITN_IE_EXPORT_HEADER.map((_, i) => raw[i]?.trim() ?? "");
    if (row.every((cell) => cell === "")) continue;
    if (!["1", "2"].includes(row[0]!) || !row[1] || !/^\d+$/.test(row[7]!) ||
        !/^\d{4}$/.test(row[3]!) || !row[4] || !row[6]) {
      throw new Error("Michigan MiTN IE export has invalid expense identity or statement metadata");
    }
    if (row[5] !== "Independent Expenditures") {
      throw new Error("Michigan MiTN IE export contains a different expenditure schedule");
    }
    const year = Number(transactionYear(row[22]!));
    // Explicit dates outside the requested cycle cannot affect its totals.
    // Migrated Annual CS2025 includes an out-of-cycle2024 placeholder with a
    // blank amount; avoid interpreting its money while retaining date checks.
    if (!years.has(year)) continue;
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(row[23]!) || !Number.isFinite(Number(row[23]))) {
      throw new Error("Michigan MiTN IE export has an invalid expenditure amount");
    }
    if (row[0] !== "1" || Number(row[23]) <= 0 || !targetFromRow(row)) continue;
    result.push(row);
  }
  return result;
}

/** Maps vetted current rows only; the caller must first select current filings. */
export function michiganMitnIndependentExpenditureExportRowsToLegacy(
  rows: readonly (readonly string[])[]
): MichiganMitnLegacyExpenditureRow[] {
  const result: MichiganMitnLegacyExpenditureRow[] = [];
  for (const row of dedupeMichiganMitnIndependentExpenditureExportRows(rows).slice(1)) {
    if (row[5] !== "Independent Expenditures") {
      throw new Error("Michigan MiTN IE export contains a different expenditure schedule");
    }
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(row[23]!) || !row[6]) {
      throw new Error("Michigan MiTN IE export has an invalid expenditure amount or committee name");
    }
    const year = transactionYear(row[22]!);
    const target = targetFromRow(row);
    if (!target) continue;
    result.push({
      doc_seq_no: row[1]!, doc_stmnt_year: year, doc_type_desc: row[4]!,
      com_legal_name: row[6]!, common_name: row[6]!, cfr_com_id: row[7]!, com_type: row[8]!,
      schedule_desc: row[5]!, supp_opp: row[18]!, can_or_ballot: target.committeeName,
      _column_29: row[28]!, amount: row[23]!, target_committee_name: target.committeeName,
      target_office: target.office,
    });
  }
  return result;
}

async function savedRaw(filePath: string): Promise<Buffer | null> {
  try { return await readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveValidatedRaw(filePath: string, raw: Buffer | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, raw);
  await rename(temporary, filePath);
}

function parseIeAttachment(buffer: Buffer): string[][] {
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
    throw new Error("Michigan MiTN IE export did not return an xlsx attachment");
  }
  const rows = parseMichiganMitnExportXlsxRows(buffer);
  validateIeTable(rows);
  return rows;
}

export async function fetchMichiganMitnIndependentExpenditureRows(input: {
  statementYears: number[]; transactionYears?: readonly number[]; rawCacheDir?: string; refresh?: boolean; fetchFn: MichiganMitnFetchFn;
}): Promise<MichiganMitnLegacyExpenditureRow[]> {
  const rawCacheDir = input.rawCacheDir ?? DEFAULT_MICHIGAN_MITN_RAW_CACHE_DIR;
  const rawRows: string[][] = [[...MICHIGAN_MITN_IE_EXPORT_HEADER]];
  const amendedRows: string[][] = [[...MICHIGAN_MITN_IE_EXPORT_HEADER]];
  const pending: { filePath: string; raw: Buffer }[] = [];
  const statementYears = [...new Set(input.statementYears)];
  // Reject unsupported years before making requests or writing raw files.
  for (const year of statementYears) {
    if (!MICHIGAN_MITN_STATEMENT_YEAR_IDS.has(year)) throw new Error(`No Michigan MiTN statement-year id for ${year}`);
  }
  const saved = new Map<string, Buffer>();
  if (!input.refresh) {
    for (const year of statementYears) {
      for (const suffix of ["", "-amended"]) {
        const filePath = path.join(rawCacheDir, `independent-expenditures-${year}${suffix}.xlsx`);
        const raw = await savedRaw(filePath);
        if (raw) saved.set(filePath, raw);
      }
    }
  }
  // Full exports, amended exports and filing manifests must be one generation.
  // A missing member refreshes the entire requested set instead of mixing old
  // spreadsheets with a newly filed amendment (which could falsely erase IE).
  const refresh = Boolean(input.refresh) || saved.size !== statementYears.length * 2;
  const page = "page.miboeCommitteeExpenditureAnalysisPublicSearch";
  for (const year of statementYears) {
    for (const amended of [false, true]) {
      const filePath = path.join(rawCacheDir, `independent-expenditures-${year}${amended ? "-amended" : ""}.xlsx`);
      let raw = refresh ? null : saved.get(filePath) ?? null;
      if (!raw) {
        const body = new URLSearchParams([
          ["form.campaignStatementYear", MICHIGAN_MITN_STATEMENT_YEAR_IDS.get(year)!],
          ["form.expenditureOption", "individual"], ["form.expenditureSchedule", "195"],
        ]);
        if (amended) body.set("form.campaignStatementType", "17");
        const response = await input.fetchFn(`${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=${page}&action=export`, {
          method: "POST", body: body.toString(), headers: {
            "user-agent": `Mozilla/5.0 (${APP_NAME} campaign finance sync)`,
            "content-type": "application/x-www-form-urlencoded", "hx-request": "true",
            origin: new URL(MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL).origin,
            referer: `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=${page}`,
          },
        });
        if (!response.ok) throw new Error(`Michigan MiTN IE export failed: status ${response.status}`);
        raw = Buffer.from(await response.arrayBuffer());
        pending.push({ filePath, raw });
      }
      (amended ? amendedRows : rawRows).push(...parseIeAttachment(raw).slice(1));
    }
  }
  // The manifest policy handles deletions by replacing an amended period in
  // full, including an amendment with no IE rows. Ambiguous versions throw.
  const currentRows = await fetchMichiganMitnCurrentExpenditureRows({
    statementYears,
    rawRows: scopeMichiganMitnIndependentExpenditureExportRows(rawRows, input.transactionYears ?? statementYears),
    amendedRows: scopeMichiganMitnIndependentExpenditureExportRows(amendedRows, input.transactionYears ?? statementYears),
    rawCacheDir, refresh, fetchFn: input.fetchFn,
  });
  for (const { filePath, raw } of pending) await saveValidatedRaw(filePath, raw);
  return currentRows;
}

function validatedRegistryHtml(html: string): MichiganMitnCommitteeSearchRow[] {
  const rows = parseMichiganMitnCommitteeSearchHtml(html);
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const noRecords = /id=["']search-results-top["']/.test(html) &&
    /No records found based on the criteria you entered/.test(text);
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].find((match) =>
    ["Committee ID", "Committee Type", "Committee Name", "Status"].every((label) => match[1]!.includes(label))
  );
  if (!table && !noRecords) throw new Error("Michigan MiTN registry response is not a results table or valid empty search");
  if (table && rows.length === 0) throw new Error("Michigan MiTN registry results table has no parseable committees");
  const range = /\b([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+)\b/.exec(text);
  if (range) {
    const [first, last, total] = range.slice(1).map((value) => Number(value.replace(/,/g, "")));
    if (first !== 1 || last !== total || total !== rows.length) {
      throw new Error("Michigan MiTN registry name search has incomplete paginated results");
    }
  } else {
    // The native standalone page span is distinct from the record range.
    // A loose "2 of 2" match also catches a complete "1 - 2 of 2" range.
    const page = /<span\b[^>]*>\s*(\d+)\s+of\s+(\d+)\s*<\/span>/.exec(html);
    if (page && (Number(page[1]) !== 1 || Number(page[2]) !== 1)) {
      throw new Error("Michigan MiTN registry name search has incomplete paginated results");
    }
  }
  return rows;
}

export async function fetchMichiganMitnRegistryForNames(input: {
  names: readonly string[]; rawCacheDir?: string; refresh?: boolean; fetchFn: MichiganMitnFetchFn;
}): Promise<MichiganMitnCommitteeSearchRow[]> {
  const rawCacheDir = input.rawCacheDir ?? DEFAULT_MICHIGAN_MITN_RAW_CACHE_DIR;
  const names = new Map(input.names.map((name) => [name.trim().replace(/\s+/g, " ").toUpperCase(), name.trim()]));
  const result = new Map<string, MichiganMitnCommitteeSearchRow>();
  for (const [normalizedName, name] of names) {
    if (!normalizedName) continue;
    const key = createHash("sha256").update(normalizedName).digest("hex");
    const filePath = path.join(rawCacheDir, `registry-${key}.html`);
    const saved = input.refresh ? null : await savedRaw(filePath);
    let html = saved?.toString("utf8");
    if (html === undefined) {
      await fetchMichiganMitnCommitteeSearch({ committeeName: name, committeeType: "", fetchFn: async (url, init) => {
        const response = await input.fetchFn(url, init);
        if (!response.ok) return response;
        html = await response.text();
        validatedRegistryHtml(html);
        return { ok: response.ok, status: response.status, text: async () => html!,
          arrayBuffer: () => response.arrayBuffer() };
      } });
      if (html === undefined) throw new Error("Michigan MiTN registry search returned no response body");
      validatedRegistryHtml(html);
      await saveValidatedRaw(filePath, html);
    }
    for (const row of validatedRegistryHtml(html)) {
      const prior = result.get(row.committeeId);
      if (prior && (prior.committeeName !== row.committeeName || prior.committeeType !== row.committeeType)) {
        throw new Error(`Michigan MiTN registry has conflicting identities for committee ${row.committeeId}`);
      }
      result.set(row.committeeId, row);
    }
  }
  return [...result.values()];
}
