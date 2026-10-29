import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildUtahGenerateReportUrl,
  UTAH_DISCLOSURES_BASE_URL,
} from "./utahDisclosuresClient.js";
import {
  parseUtahNativeExport,
  type UtahNativeExportRow,
} from "./utahNativeExport.js";
import { utahFiledInventory } from "./utahCommitteeCashSource.js";

export type UtahIeContext = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  electionType: string;
};
export type UtahIeOccurrence = {
  transactionId: string;
  folderId: string;
  reportUrl: string;
  payerName: string;
  date: string;
  amountCents: number;
  stance: "support" | "oppose";
  purpose: string;
};
export type UtahIePacket = {
  year: number;
  observedAt: string;
  sourceUrl: string;
  reportCount: number;
  occurrenceCount: number;
  allocations: readonly {
    context: UtahIeContext;
    occurrences: readonly UtahIeOccurrence[];
  }[];
};
export type UtahIeOriginal = {
  url: string;
  observedAt: string;
  body: string;
  kind: "http" | "saved-http-body" | "browser-dom";
};
const accepted = new WeakSet<object>();
export function ieCheck(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`Utah reported IE held: ${code}`);
}
export function assertUtahIePacket(packet: UtahIePacket): void {
  ieCheck(accepted.has(packet), "unverified_packet");
}
const text = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => text(s.normalize("NFKC")).toUpperCase();
export function utahIePersonKey(s: string): string {
  const p = s.split(",");
  return key(p.length === 2 ? `${p[1]} ${p[0]}` : s).replace(/[^A-Z0-9]/g, "");
}
function doc(html: string, url: string): Document {
  ieCheck(
    !/[\u0000\uFFFD]/.test(html) &&
      !/What code is in the image|Verify you are human/i.test(html),
    "source_challenge_or_encoding",
  );
  const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole() }).window
    .document;
}
function field(d: Document, label: string, optional = false): string {
  const es = [...d.querySelectorAll("label")].filter(
    (e) => text(e.textContent ?? "") === label,
  );
  ieCheck(
    es.length === 1 || (optional && es.length === 0),
    "native_field_count",
  );
  return es[0]
    ? text(
        [...es[0].parentElement!.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(" "),
      )
    : "";
}
export function utahIeCents(s: string): number {
  s = text(s);
  const parentheses = s.startsWith("(") && s.endsWith(")");
  if (parentheses) s = s.slice(1, -1);
  const m = /^(-?)\$?((?:\d+|\d{1,3}(?:,\d{3})+))\.(\d{2})$/.exec(s);
  ieCheck(m && !(parentheses && m[1]), "native_money");
  const value = Number(
    (BigInt(m[2]!.replaceAll(",", "")) * 100n + BigInt(m[3]!)) *
      (parentheses || m[1] ? -1n : 1n),
  );
  ieCheck(Number.isSafeInteger(value), "unsafe_cents");
  return value;
}
function add(a: number, b: number): number {
  const value = a + b;
  ieCheck(Number.isSafeInteger(value), "unsafe_sum");
  return value;
}
function day(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  ieCheck(m, "native_date");
  const date = new Date(Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!));
  ieCheck(
    date.getUTCFullYear() === +m[3]! &&
      date.getUTCMonth() + 1 === +m[1]! &&
      date.getUTCDate() === +m[2]!,
    "native_date",
  );
  return date.toISOString().slice(0, 10);
}
export function utahIeUrl(raw: string): string {
  const u = new URL(raw, UTAH_DISCLOSURES_BASE_URL);
  ieCheck(
    u.origin === UTAH_DISCLOSURES_BASE_URL &&
      !u.username &&
      !u.password &&
      !u.hash &&
      /^\/(?:Search\/PublicSearch\/(?:FolderDetails|Report)\/\d+|Registration\/EntityDetails\/\d+|Search\/AdvancedSearch\/(?:GenerateReport(?:\/\d+)?|GetEntityReportList))$/.test(
        u.pathname,
      ),
    "source_url",
  );
  ieCheck(
    [...u.searchParams.keys()].every((k) =>
      ["ReportYear", "EntityType", "PageNumber"].includes(k),
    ),
    "source_query",
  );
  return u.href;
}
export function utahIeRegistryUrl(year: number): string {
  return `${UTAH_DISCLOSURES_BASE_URL}/Search/AdvancedSearch/GetEntityReportList?EntityType=INDEXP&ReportYear=${year}&PageNumber=1`;
}
type Entry = {
  folderId: string;
  folderUrl: string;
  exportUrl: string;
  primary: string;
  aliases: string[];
};
export function parseUtahIeRegistry(
  html: string,
  url: string,
  year: number,
): Entry[] {
  const d = doc(html, url),
    tables = [...d.querySelectorAll("table")];
  ieCheck(tables.length === 1, "registry_table");
  const table = tables[0]!,
    rows = [...table.rows];
  ieCheck(
    rows.length >= 4 &&
      text(rows.at(-1)!.textContent ?? "") === "1" &&
      !rows.at(-1)!.querySelector("a,button"),
    "registry_paging",
  );
  const entries: Entry[] = [],
    allFolders = new Set<string>();
  for (const r of rows) {
    const a = r.querySelector<HTMLAnchorElement>('a[href*="/FolderDetails/"]');
    if (!a) continue;
    ieCheck(
      [...r.cells].some(
        (c) => text(c.textContent ?? "") === "Independent Expenditures",
      ),
      "registry_type",
    );
    const folderUrl = utahIeUrl(a.href),
      folderId = new URL(folderUrl).pathname.split("/").at(-1)!;
    ieCheck(!allFolders.has(folderId), "duplicate_filer");
    allFolders.add(folderId);
    const downloads = [
      ...r.querySelectorAll<HTMLAnchorElement>('a[href*="/GenerateReport/"]'),
    ].filter(
      (e) => new URL(e.href).searchParams.get("ReportYear") === String(year),
    );
    if (!downloads.length) continue;
    ieCheck(downloads.length === 1, "duplicate_current_export");
    const label = text(a.textContent ?? ""),
      aka = /^(.*?)\s*\(aka\.\s*([^()]+)\)$/.exec(label);
    ieCheck(
      label.length > 0 &&
        label.length <= 500 &&
        (!label.includes("(aka") || aka),
      "registry_name",
    );
    const exportUrl = utahIeUrl(downloads[0]!.href);
    ieCheck(
      new URL(exportUrl).pathname.endsWith(`/${folderId}`),
      "export_folder_identity",
    );
    entries.push({
      folderId,
      folderUrl,
      exportUrl,
      primary: aka ? text(aka[1]!) : label,
      aliases: [label, ...(aka ? [text(aka[1]!), text(aka[2]!)] : [])],
    });
  }
  ieCheck(
    allFolders.size > 0 && entries.length > 0 && entries.length <= 30,
    "registry_scope",
  );
  return entries;
}
function payer(entry: Entry, original: UtahIeOriginal): string {
  const d = doc(original.body, original.url),
    organization = field(d, "Organization"),
    orgName = field(d, "Organization Name", true);
  const person = ["First", "Middle", "Last", "Suffix"]
    .map((l) => field(d, l))
    .filter(Boolean)
    .join(" ");
  const aliases = new Set(entry.aliases.map(key));
  ieCheck(
    utahIePersonKey(person) === utahIePersonKey(entry.primary) ||
      aliases.has(key(organization)),
    "registration_identity",
  );
  if (orgName)
    ieCheck(
      aliases.has(key(orgName)) && key(orgName) === key(organization),
      "registered_alias",
    );
  return orgName || entry.primary;
}
/** Only this complete single-beneficiary declaration is admitted. Estimates are
 * not payments, and this recognized subset cannot establish candidate totals. */
export function parseUtahIePurpose(
  purpose: string,
): { name: string; district: string; stance: "support" | "oppose" } | null {
  const m =
    /^Other - Independent Expenditure: Estimated Direct Mail, Phone Calls & Digital Ads (Supporting|Opposing) ([A-Za-z][A-Za-z .,'’\-]{1,150}) \(SD-(\d{1,3})\)$/.exec(
      text(purpose),
    );
  if (!m) return null;
  ieCheck(
    !/\b(?:and|or|supporting|opposing|percent|split|portion)\b/i.test(m[2]!),
    "ambiguous_target",
  );
  return {
    name: m[2]!,
    district: String(Number(m[3])),
    stance: m[1] === "Supporting" ? "support" : "oppose",
  };
}
function snapshot(html: string, url: string): unknown {
  const d = doc(html, url);
  return {
    fields: [...d.querySelectorAll("label")].map((e) => [
      text(e.textContent ?? ""),
      field(d, text(e.textContent ?? "")),
    ]),
    tables: [...d.querySelectorAll("table")].map((t) =>
      [...t.rows].map((r) =>
        [...r.cells].map((c) => text(c.textContent ?? "")),
      ),
    ),
    flags: [
      ...d.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].map((e) => [e.checked, e.disabled]),
    links: [...d.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map(
      (a) => a.outerHTML,
    ),
  };
}
function multiset(values: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const v of values) {
    const k = JSON.stringify(v);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}
export function verifyUtahIeStatement(input: {
  original: UtahIeOriginal;
  closing: UtahIeOriginal;
  entry: Entry;
  label: string;
  year: number;
  rows: readonly UtahNativeExportRow[];
  payerName: string;
}): UtahIeOccurrence[] {
  const { original, closing, entry, label, year, rows } = input,
    d = doc(original.body, original.url);
  ieCheck(
    isDeepStrictEqual(
      snapshot(original.body, original.url),
      snapshot(closing.body, closing.url),
    ),
    "statement_changed",
  );
  ieCheck(
    field(d, "Report Name") === `${year} ${label} Report` &&
      entry.aliases.some((a) => key(a) === key(field(d, "Name"))),
    "statement_identity",
  );
  const begin = day(field(d, "Begin Date")),
    end = day(field(d, "End Date")),
    submit = day(field(d, "SubmitDate"));
  ieCheck(
    begin <= end &&
      begin.startsWith(String(year)) &&
      end.startsWith(String(year)) &&
      submit <= original.observedAt.slice(0, 10),
    "statement_period",
  );
  const flags = [
    ...d.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  ieCheck(
    flags.length === 1 && flags[0]!.disabled && !flags[0]!.checked,
    "amendment",
  );
  const tables = [...d.querySelectorAll("table")];
  ieCheck(tables.length === 3, "statement_tables");
  // This component does not guess treatment of receipts, refunds, loans or in-kind.
  ieCheck(
    rows.every(
      (r) =>
        r.transactionType === "Expenditure" &&
        r.amountCents < 0 &&
        !r.inKind &&
        !r.loan &&
        !r.amends &&
        r.filed === "X",
    ),
    "unsupported_occurrence",
  );
  const contributions = [...tables[1]!.rows];
  ieCheck(
    contributions.length === 3 &&
      text(contributions.at(-1)!.cells[0]?.textContent ?? "").startsWith(
        "Total Contributions Received",
      ) &&
      utahIeCents(text(contributions.at(-1)!.cells[1]?.textContent ?? "")) ===
        0,
    "contribution_control",
  );
  const native = [...tables[2]!.rows],
    headers = [...native[1]!.cells].map((c) => text(c.textContent ?? ""));
  ieCheck(
    isDeepStrictEqual(headers, [
      "Exp. Date",
      "Name of Recipient",
      "Address",
      "Purpose",
      "I",
      "L",
      "A",
      "Expenditure Amount",
    ]),
    "expense_headers",
  );
  const unused = new Set(rows.map((_, i) => i)),
    observed: unknown[] = [],
    exports: unknown[] = [],
    occurrences: UtahIeOccurrence[] = [];
  let total = 0;
  for (const tr of native.slice(2, -1)) {
    const cells = [...tr.cells].map((c) => text(c.textContent ?? ""));
    ieCheck(
      cells.length === 8 &&
        cells[4] === "" &&
        cells[5] === "" &&
        cells[6] === "",
      "native_flags",
    );
    const date = day(cells[0]!),
      amountCents = utahIeCents(cells[7]!);
    ieCheck(
      amountCents > 0 && date >= begin && date <= end,
      "expense_period_or_sign",
    );
    total = add(total, amountCents);
    observed.push([date, key(cells[1]!), amountCents]);
    // Occurrence accounting retains duplicate financial tuples. The native CSV
    // category is a prefix; the filed statement contains the complete purpose.
    const matches = [...unused].filter((i) => {
      const r = rows[i]!;
      return (
        day(r.transactionDate!) === date &&
        key(r.name ?? "") === key(cells[1]!) &&
        -r.amountCents === amountCents &&
        (cells[3] === (r.purpose ?? "") ||
          cells[3]!.startsWith(`${r.purpose}: `) ||
          cells[3]!.startsWith(`${r.purpose} - `))
      );
    });
    ieCheck(matches.length > 0, "native_export_occurrence");
    if (matches.length > 1) {
      // Identical financial tuples may be distinct native occurrences. Only
      // interchange their transaction IDs when their whole filed purposes are
      // identical too; otherwise the beneficiary-to-ID mapping is unknown.
      const peers = native
        .slice(2, -1)
        .map((r) => [...r.cells].map((c) => text(c.textContent ?? "")))
        .filter(
          (c) =>
            c.length === 8 &&
            day(c[0]!) === date &&
            key(c[1]!) === key(cells[1]!) &&
            utahIeCents(c[7]!) === amountCents,
        );
      ieCheck(
        peers.every((c) => c[3] === cells[3]),
        "ambiguous_occurrence_identity",
      );
    }
    const index = matches[0]!;
    unused.delete(index);
    const r = rows[index]!;
    exports.push([date, key(r.name!), -r.amountCents]);
    occurrences.push({
      transactionId: r.transactionId,
      folderId: entry.folderId,
      reportUrl: original.url,
      payerName: input.payerName,
      date,
      amountCents,
      purpose: cells[3]!,
      stance: "support",
    });
  }
  ieCheck(
    unused.size === 0 &&
      isDeepStrictEqual(multiset(observed), multiset(exports)),
    "complete_occurrences",
  );
  const footer = [...native.at(-1)!.cells].map((c) =>
    text(c.textContent ?? ""),
  );
  ieCheck(
    footer.length === 2 &&
      footer[0] === "Total Expenditures Made" &&
      utahIeCents(footer[1]!) === total,
    "expense_footer",
  );
  const cover = new Map(
    [...tables[0]!.rows]
      .filter(
        (r) =>
          r.cells.length === 4 &&
          /^[1-5]$/.test(text(r.cells[0]!.textContent ?? "")),
      )
      .map((r) => [
        text(r.cells[0]!.textContent ?? ""),
        [
          utahIeCents(text(r.cells[2]!.textContent ?? "")),
          text(r.cells[3]!.textContent ?? ""),
        ],
      ]),
  );
  ieCheck(
    cover.size === 5 &&
      cover.get("2")![0] === 0 &&
      cover.get("4")![0] === total &&
      add(Number(cover.get("1")![0]), Number(cover.get("2")![0])) ===
        cover.get("3")![0] &&
      Number(cover.get("3")![0]) - total === cover.get("5")![0],
    "cover_cash_controls",
  );
  for (const [line, [value, ytd]] of cover)
    ieCheck(
      ["2", "4"].includes(line)
        ? utahIeCents(String(ytd)) === value
        : ytd === "",
      "cover_ytd_controls",
    );
  return occurrences;
}
export function utahIeOriginalPath(
  cacheDir: string,
  phase: string,
  url: string,
): string {
  return join(
    cacheDir,
    "utah-reported-ie",
    createHash("sha256")
      .update(JSON.stringify([phase, url]))
      .digest("hex") + ".json",
  );
}
export async function loadUtahIePacket(
  year: number,
  contexts: readonly UtahIeContext[],
  options: {
    cacheDir: string;
    now?: Date;
    refresh?: boolean;
    allowNetwork?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<UtahIePacket> {
  ieCheck(
    Number.isInteger(year) &&
      year >= 1998 &&
      year <= 2100 &&
      contexts.every((c) => c.electionYear === year),
    "context_year",
  );
  const now = options.now ?? new Date(),
    times: number[] = [];
  let bytesRead = 0,
    requests = 0;
  const started = Date.now();
  async function original(
    phase: string,
    rawUrl: string,
  ): Promise<UtahIeOriginal> {
    const url = utahIeUrl(rawUrl),
      path = utahIeOriginalPath(options.cacheDir, phase, url);
    let o: UtahIeOriginal | undefined;
    if (!options.refresh) {
      try {
        o = JSON.parse(await readFile(path, "utf8"));
      } catch (e) {
        ieCheck(
          (e as NodeJS.ErrnoException).code === "ENOENT",
          "saved_original_invalid",
        );
      }
    }
    if (!o) {
      ieCheck(
        options.allowNetwork &&
          ++requests <= 100 &&
          Date.now() - started < 360_000,
        "saved_original_missing_or_budget",
      );
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(url, {
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
          headers: {
            "User-Agent": "Mozilla/5.0",
            Accept: "text/html,text/csv,*/*",
          },
        });
      } catch {
        throw new Error("Utah reported IE held: source_unavailable");
      }
      ieCheck(response.ok, "source_status");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const length = response.headers.get("content-length");
      ieCheck(
        bytes.length <= 16 * 1024 * 1024 &&
          (response.headers.get("content-encoding") ||
            length === null ||
            +length === bytes.length),
        "source_size_or_eof",
      );
      o = {
        url,
        observedAt: new Date().toISOString(),
        body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        kind: "http",
      };
      // Challenge originals are never promoted to the normal source cache.
      ieCheck(
        !/What code is in the image|Verify you are human/i.test(o.body),
        "source_challenge",
      );
      await mkdir(join(options.cacheDir, "utah-reported-ie"), {
        recursive: true,
        mode: 0o700,
      });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(o), { mode: 0o600 });
      await rename(temp, path);
    }
    const time = Date.parse(o.observedAt);
    bytesRead += Buffer.byteLength(o.body ?? "");
    // Future-dating is judged against the wall clock: `now` is the job clock,
    // fixed at start, while downloads carry their own completion time.
    ieCheck(
      o.url === url &&
        ["http", "saved-http-body", "browser-dom"].includes(o.kind) &&
        typeof o.body === "string" &&
        Number.isFinite(time) &&
        time <= Date.now() + 60_000 &&
        now.getTime() - time <= 86_400_000 &&
        bytesRead <= 64 * 1024 * 1024,
      "original_identity_age_or_budget",
    );
    if (o.kind === "browser-dom")
      ieCheck(
        !new URL(url).pathname.includes("/GenerateReport") &&
          /^<html(?:\s|>)/i.test(o.body) &&
          /<\/html>\s*$/i.test(o.body),
        "complete_browser_original",
      );
    times.push(time);
    return o;
  }
  const sourceUrl = utahIeRegistryUrl(year),
    opening = await original("registry-open", sourceUrl),
    entries = parseUtahIeRegistry(opening.body, sourceUrl, year);
  const annualUrl = buildUtahGenerateReportUrl({
      entityType: "INDEXP",
      reportYear: year,
    }),
    annual = await original("annual-open", annualUrl),
    annualRows = parseUtahNativeExport(annual.body, "INDEXP", "annual");
  ieCheck(
    annualRows.length > 0 &&
      annualRows.every((r) => r.filed === "X" && !r.amends),
    "annual_filed_scope",
  );
  const accounted = new Set<string>(),
    all: UtahIeOccurrence[] = [],
    graphClosings: number[] = [];
  let reportCount = 0;
  for (const entry of entries) {
    const first = await original("folder-open", entry.folderUrl),
      inventory = utahFiledInventory(first.body, first.url, year),
      identity = await original("registration", inventory.registrationUrl),
      payerName = payer(entry, identity);
    const exported = await original("ledger-open", entry.exportUrl),
      rows = parseUtahNativeExport(exported.body, "INDEXP", "folder");
    ieCheck(
      rows.length > 0 &&
        rows.every(
          (r) =>
            entry.aliases.some((a) => key(a) === key(r.entityName ?? "")) &&
            day(r.transactionDate!).startsWith(String(year)) &&
            inventory.reports.some((p) => p.label === r.report),
        ),
      "folder_export_scope",
    );
    const annualScope = annualRows.filter((r) =>
      entry.aliases.some((a) => key(a) === key(r.entityName ?? "")),
    );
    ieCheck(
      isDeepStrictEqual(
        rows
          .map(({ filed: _filed, ...r }) => r)
          .sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
        annualScope
          .map(({ filed: _filed, ...r }) => r)
          .sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
      ),
      "annual_folder_occurrences",
    );
    for (const r of annualScope) {
      ieCheck(!accounted.has(r.transactionId), "duplicate_annual_identity");
      accounted.add(r.transactionId);
    }
    for (const report of inventory.reports) {
      const raw = await original("statement", report.url),
        close = await original("statement-close", report.url);
      ieCheck(
        Date.parse(close.observedAt) >= Date.parse(raw.observedAt),
        "statement_clock",
      );
      graphClosings.push(Date.parse(close.observedAt));
      all.push(
        ...verifyUtahIeStatement({
          original: raw,
          closing: close,
          entry,
          label: report.label,
          year,
          rows: annualScope.filter((r) => r.report === report.label),
          payerName,
        }),
      );
      reportCount++;
    }
    const last = await original("ledger-close", entry.exportUrl),
      folderClose = await original("folder-close", entry.folderUrl);
    graphClosings.push(Date.parse(folderClose.observedAt));
    ieCheck(
      isDeepStrictEqual(
        rows,
        parseUtahNativeExport(last.body, "INDEXP", "folder"),
      ) && Date.parse(last.observedAt) >= Date.parse(exported.observedAt),
      "ledger_changed",
    );
    ieCheck(
      isDeepStrictEqual(
        inventory,
        utahFiledInventory(folderClose.body, folderClose.url, year),
      ) && Date.parse(folderClose.observedAt) >= Date.parse(first.observedAt),
      "folder_changed",
    );
  }
  const closing = await original("registry-close", sourceUrl),
    annualClose = await original("annual-close", annualUrl);
  ieCheck(
    accounted.size === annualRows.length &&
      isDeepStrictEqual(
        entries,
        parseUtahIeRegistry(closing.body, sourceUrl, year),
      ) &&
      Date.parse(closing.observedAt) >=
        Math.max(Date.parse(opening.observedAt), ...graphClosings),
    "registry_closure",
  );
  ieCheck(
    isDeepStrictEqual(
      annualRows,
      parseUtahNativeExport(annualClose.body, "INDEXP", "annual"),
    ) && Date.parse(annualClose.observedAt) >= Date.parse(annual.observedAt),
    "annual_changed",
  );
  const allocations = new Map<
    string,
    { context: UtahIeContext; occurrences: UtahIeOccurrence[] }
  >();
  for (const occurrence of all) {
    const target = parseUtahIePurpose(occurrence.purpose);
    if (!target) {
      ieCheck(
        !/\b(?:support\w*|oppos\w*|elect|defeat)\b/i.test(occurrence.purpose) &&
          !contexts.some((c) =>
            utahIePersonKey(occurrence.purpose).includes(
              utahIePersonKey(c.candidateName),
            ),
          ),
        "unresolved_candidate_clause",
      );
      continue;
    }
    const matches = contexts.filter(
      (c) =>
        c.officeScope === "state_upper" &&
        c.officeName === "State Senator" &&
        c.electionType === "general" &&
        c.district !== null &&
        Number(c.district) === Number(target.district) &&
        utahIePersonKey(c.candidateName) === utahIePersonKey(target.name),
    );
    ieCheck(matches.length === 1, "canonical_target");
    const context = matches[0]!,
      k = `${context.candidateId}\0${context.electionId}`;
    const allocation = allocations.get(k) ?? {
      context: { ...context },
      occurrences: [],
    };
    allocation.occurrences.push({ ...occurrence, stance: target.stance });
    allocations.set(k, allocation);
  }
  ieCheck(
    Math.max(...times) - Math.min(...times) <= 43_200_000,
    "capture_window",
  );
  const packet: UtahIePacket = {
    year,
    observedAt: new Date(Math.max(...times)).toISOString(),
    sourceUrl,
    reportCount,
    occurrenceCount: all.length,
    allocations: [...allocations.values()],
  };
  for (const a of packet.allocations) {
    a.occurrences.forEach(Object.freeze);
    Object.freeze(a.occurrences);
    Object.freeze(a.context);
    Object.freeze(a);
  }
  Object.freeze(packet.allocations);
  Object.freeze(packet);
  accepted.add(packet);
  return packet;
}
