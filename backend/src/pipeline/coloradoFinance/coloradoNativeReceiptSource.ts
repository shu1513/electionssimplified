import fs from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isColoradoNativeReceiptsEnabled,
  isColoradoNativeReceiptsRawRefreshEnabled,
} from "../../config/featureFlags.js";
import {
  ColoradoReportError,
  coloradoReportCents,
  coloradoReportDate,
  coloradoReportedNameKey,
} from "./coloradoTracerReports.js";
import {
  COLORADO_COMMITTEE_CLASSES,
  coloradoReceiptCheck as check,
  coloradoReceiptDocument as document,
  coloradoReceiptText as clean,
  coloradoReceiptXmlSnapshot,
  coloradoReceiptAdd,
  coloradoReceiptFiledMinute,
  parseColoradoCommitteeRegistry,
  parseColoradoNativeReceiptReport,
  parseColoradoNativeMajorNotice,
  type ColoradoNativeCommittee,
  type ColoradoNativeReceiptReport,
  type ColoradoNativeMajorNotice,
} from "./coloradoNativeReceiptReports.js";
import {
  aggregateColoradoNativeReceipts,
  type ColoradoNativeReceiptGroup,
  type ColoradoNativeReceiptControls,
} from "./coloradoNativeReceiptAggregation.js";
import {
  qualifyColoradoNativeCandidateProfile,
  type ColoradoNativeCandidateProof,
} from "./coloradoNativeCandidateIdentity.js";
import {
  validateColoradoIeReceiverIdentity,
  type ColoradoIeReceiver,
} from "./coloradoReportedIeReceiver.js";
import {
  parseColoradoNativePostback,
  type ColoradoNativePostback,
} from "./coloradoNativePeerIdentity.js";
import {
  ColoradoTracerObservations,
  COLORADO_TRACER_REPORTS,
  coloradoPrivateOriginal,
  coloradoOriginalSha,
  coloradoSourceDay,
  coloradoSourceUrl,
  type ColoradoObservationManifest,
  type ColoradoObservationReply,
} from "./coloradoTracerObservations.js";
import type { ColoradoSourceFacts } from "./coloradoReportedIeSource.js";

export const CO_NATIVE_RECEIPTS_REVISION = "co-native-cash-v1";
export type ColoradoNativeReceiptFacts = {
  revision: typeof CO_NATIVE_RECEIPTS_REVISION;
  cycleStart: string;
  regularThrough: string;
  sourceThrough: string;
  registry: ColoradoSourceFacts;
  receipts: ColoradoSourceFacts;
};
export type ColoradoNativeReceiptsPacket = {
  receiver: ColoradoIeReceiver;
  identity: ColoradoNativeCandidateProof;
  groups: ColoradoNativeReceiptGroup[];
  controls: ColoradoNativeReceiptControls;
  facts: ColoradoNativeReceiptFacts;
};
type Options = { cacheDir?: string; refresh?: boolean; fetchFn?: typeof fetch };
type Registry = {
  rows: ColoradoNativeCommittee[];
  source: ColoradoSourceFacts;
  asOf: string;
};
const registries = new WeakSet<object>(),
  packets = new WeakSet<object>();
export const isVerifiedColoradoNativeReceiptsPacket = (
  p: unknown,
): p is ColoradoNativeReceiptsPacket =>
  !!p && typeof p === "object" && packets.has(p);
const freeze = (o: unknown): void => {
  if (o && typeof o === "object") {
    Object.values(o).forEach(freeze);
    Object.freeze(o);
  }
};
function form(d: Document): HTMLFormElement {
  const f = d.querySelector("form");
  check(f, "receipt_native_form");
  return f;
}
function values(f: HTMLFormElement): URLSearchParams {
  const p = new URLSearchParams();
  for (const item of f.elements) {
    const e = item as HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
    if (
      !e.name ||
      e.disabled ||
      ["submit", "button", "image", "reset", "file"].includes(e.type) ||
      (["checkbox", "radio"].includes(e.type) &&
        !(e as HTMLInputElement).checked)
    )
      continue;
    check(e.type !== "select-multiple", "receipt_native_multiselect");
    p.append(e.name, e.value ?? "");
  }
  return p;
}
function input(d: Document, id: string): HTMLInputElement {
  const e = d.getElementById(id);
  check(e?.tagName === "INPUT", "receipt_native_input");
  return e as HTMLInputElement;
}
function select(d: Document, id: string): HTMLSelectElement {
  const e = d.getElementById(id);
  check(e?.tagName === "SELECT", "receipt_native_select");
  return e as HTMLSelectElement;
}
function setOption(
  e: HTMLSelectElement,
  label: string,
  p: URLSearchParams,
): void {
  const o = [...e.options].filter((o) => clean(o.textContent ?? "") === label);
  check(o.length === 1, "receipt_native_option");
  p.set(e.name, o[0]!.value);
}
function action(
  f: HTMLFormElement,
  base: string,
  post?: ColoradoNativePostback,
): string {
  return coloradoSourceUrl(
    post?.action || f.getAttribute("action") || base,
    base,
  ).href;
}
function link(d: Document, label: string, base: string): string {
  const urls = [
    ...new Set(
      [...d.querySelectorAll("a[href]")]
        .filter((a) => clean(a.textContent ?? "") === label)
        .map((a) => coloradoSourceUrl(a.getAttribute("href")!, base).href),
    ),
  ];
  check(urls.length === 1, "receipt_native_catalog_link");
  return urls[0]!;
}
const nativeDay = (day: string) =>
  `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
async function post(
  s: ColoradoTracerObservations,
  role: string,
  page: ColoradoObservationReply,
  a: ColoradoNativePostback,
  p?: URLSearchParams,
) {
  const d = document(page.bytes, page.url),
    f = form(d),
    v = p ?? values(f);
  v.set("__EVENTTARGET", a.target);
  v.set("__EVENTARGUMENT", a.argument);
  const url = action(f, page.url, a);
  check(
    new URL(url).pathname === new URL(page.url).pathname,
    "receipt_postback_path",
  );
  return s.request(role, url, v);
}
async function exportReport(
  s: ColoradoTracerObservations,
  prefix: string,
  generated: ColoradoObservationReply,
) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    generated.bytes,
  );
  const path = /window\.open\(['"]([^'"]*ReportViewer\.aspx[^'"]*)['"]/u.exec(
    text,
  )?.[1];
  check(path, "receipt_native_viewer");
  const viewer = await s.request(
    prefix + "_viewer",
    coloradoSourceUrl(path.replaceAll("&amp;", "&"), generated.url).href,
  );
  const html = new TextDecoder("utf-8", { fatal: true }).decode(viewer.bytes),
    base =
      /["']([^"']*Reserved\.ReportViewerWebControl\.axd\?[^"']*OpType=Export[^"']*Format=)["']/u.exec(
        html,
      )?.[1];
  check(base, "receipt_native_export");
  const csv = await s.request(
      prefix + "_csv",
      coloradoSourceUrl(base.replaceAll("&amp;", "&") + "CSV", viewer.url).href,
    ),
    xml = await s.request(
      prefix + "_xml",
      coloradoSourceUrl(base.replaceAll("&amp;", "&") + "XML", viewer.url).href,
    );
  return { csv: csv.bytes, xml: xml.bytes };
}
async function sourceFacts(
  s: ColoradoTracerObservations,
): Promise<ColoradoSourceFacts> {
  const raw = await coloradoPrivateOriginal(
      resolve(s.directory, "manifest.json"),
      8 * 1024 * 1024,
    ),
    r = s.manifest.records;
  return {
    packetDirectory: basename(s.directory),
    observedAt: r[0]!.startedAt,
    completedAt: r.at(-1)!.completedAt,
    manifestSha256: coloradoOriginalSha(raw),
    originals: r.map((r) => ({
      file: r.file,
      sha256: r.sha256,
      bytes: r.bytes,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    })),
  };
}
async function matchesReceiver(
  directory: string,
  m: ColoradoObservationManifest,
  receiver: ColoradoIeReceiver,
): Promise<boolean> {
  const f = m.records.find((r) => r.role === "opening_profile_form"),
    q = m.records.find((r) => r.role === "opening_profile_search");
  if (!f || !q) return false;
  const raw = await coloradoPrivateOriginal(resolve(directory, f.file)),
    req = await coloradoPrivateOriginal(resolve(directory, q.requestFile));
  check(
    coloradoOriginalSha(raw) === f.sha256 &&
      coloradoOriginalSha(req) === q.requestSha256,
    "receipt_cached_scope_integrity",
  );
  const d = document(raw),
    name = input(d, "_ctl0_Content_txtCommitteeID").name,
    original = JSON.parse(req.toString("utf8")) as { body: string };
  return new URLSearchParams(original.body).get(name) === receiver.receivingId;
}
async function source<T>(
  options: Options & {
    kind: "committee-registry" | "named-receipts";
    year: number;
    receiver?: ColoradoIeReceiver;
    run: (s: ColoradoTracerObservations) => Promise<T>;
  },
): Promise<T & { source: ColoradoSourceFacts }> {
  check(isColoradoNativeReceiptsEnabled(), "colorado_native_receipts_disabled");
  const root = resolve(options.cacheDir ?? "scratch/colorado-native-receipts");
  if (!options.refresh) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ColoradoReportError("receipt_cache_unavailable");
    }
    const candidates: {
      directory: string;
      manifest: ColoradoObservationManifest;
      first: string;
    }[] = [];
    for (const entry of entries) {
      if (!/^packet-[a-f0-9-]{36}$/u.test(entry)) continue;
      const directory = resolve(root, entry);
      let m: ColoradoObservationManifest;
      try {
        m = JSON.parse(
          (
            await coloradoPrivateOriginal(
              resolve(directory, "manifest.json"),
              8 * 1024 * 1024,
            )
          ).toString("utf8"),
        ) as ColoradoObservationManifest;
      } catch {
        continue;
      }
      if (
        m.kind === options.kind &&
        m.year === options.year &&
        m.complete &&
        m.records?.length &&
        (!options.receiver ||
          (await matchesReceiver(directory, m, options.receiver)))
      )
        candidates.push({
          directory,
          manifest: m,
          first: m.records[0]!.startedAt,
        });
    }
    const saved = candidates.sort((a, b) => b.first.localeCompare(a.first))[0];
    if (saved) {
      const s = await ColoradoTracerObservations.reopen(
          saved.directory,
          saved.manifest,
        ),
        result = await options.run(s);
      await s.finish();
      return { ...result, source: await sourceFacts(s) };
    }
  }
  check(
    isColoradoNativeReceiptsRawRefreshEnabled(),
    "native_receipt_source_unavailable",
  );
  const s = await ColoradoTracerObservations.create(
      root,
      options.kind,
      options.year,
      options.fetchFn,
    ),
    result = await options.run(s);
  await s.finish();
  return { ...result, source: await sourceFacts(s) };
}
async function registryProtocol(s: ColoradoTracerObservations) {
  const catalog = await s.request("registry_catalog", COLORADO_TRACER_REPORTS),
    url = link(
      document(catalog.bytes, catalog.url),
      "Committee Listing",
      catalog.url,
    ),
    asOf = coloradoSourceDay(s.manifest.records[0]!.startedAt),
    opening = new Map<string, string>(),
    rows: ColoradoNativeCommittee[] = [];
  let choicesOpening: string | undefined;
  for (const phase of ["opening", "closing"]) {
    const page = await s.request(phase + "_registry_form", url),
      d = document(page.bytes, page.url),
      f = form(d),
      type = select(d, "ctl00_Content_ucCommitteeType_ucddlOrganizationType"),
      jur = select(d, "ctl00_Content_ucJurisdiction_ucddlCounty");
    const types = [...type.options].map((o) => ({
      value: o.value,
      label: clean(o.textContent ?? ""),
    }));
    check(
      types.length === COLORADO_COMMITTEE_CLASSES.length &&
        types.every((o) =>
          (COLORADO_COMMITTEE_CLASSES as readonly string[]).includes(o.label),
        ) &&
        new Set(types.map((o) => o.label)).size === types.length,
      "receipt_registry_complete_classes",
    );
    const choices = JSON.stringify({
      types,
      jur: [...jur.options].map((o) => [o.value, clean(o.textContent ?? "")]),
    });
    if (choicesOpening === undefined) choicesOpening = choices;
    else check(choices === choicesOpening, "receipt_registry_choices_changed");
    for (const [ti, cl] of COLORADO_COMMITTEE_CLASSES.entries())
      for (const [ji, jurisdiction] of [
        "All Counties",
        "STATEWIDE",
        "FEDERAL",
      ].entries()) {
        const prefix = `${phase}_registry_${ti + 1}_${ji + 1}`,
          p = values(f);
        setOption(type, cl, p);
        setOption(jur, jurisdiction, p);
        p.set(input(d, "ctl00_Content_dteBegin").name, "01/01/1900");
        p.set(input(d, "ctl00_Content_dteEnd").name, nativeDay(asOf));
        p.delete(input(d, "ctl00_Content_chklstCheckboxes_0").name);
        p.set("__EVENTTARGET", "");
        p.set("__EVENTARGUMENT", "");
        const submit = input(d, "ctl00_Content_btnGenerateReport");
        p.set(submit.name, submit.value);
        const generated = await s.request(
            prefix + "_generate",
            action(f, page.url),
            p,
          ),
          pair = await exportReport(s, prefix, generated),
          parsed = parseColoradoCommitteeRegistry({
            ...pair,
            committeeType: cl,
            jurisdiction,
            asOf,
          }),
          snapshot = coloradoReceiptXmlSnapshot(pair.xml),
          key = `${ti}:${ji}`;
        if (phase === "opening") {
          opening.set(key, snapshot);
          rows.push(...parsed);
        } else
          check(
            opening.get(key) === snapshot,
            "receipt_registry_closing_changed",
          );
      }
  }
  check(rows.length > 0, "receipt_registry_positive_population");
  return { rows, asOf };
}
export async function getColoradoNativeReceiptRegistry(
  options: Options & { electionYear: number },
): Promise<Registry> {
  check(
    Number.isSafeInteger(options.electionYear) &&
      options.electionYear >= 2026 &&
      options.electionYear <= 2100,
    "receipt_source_year",
  );
  const result = await source({
    cacheDir: options.cacheDir,
    refresh: options.refresh,
    fetchFn: options.fetchFn,
    kind: "committee-registry",
    year: options.electionYear,
    run: registryProtocol,
  });
  freeze(result);
  registries.add(result);
  return result;
}

type HistoryRow = {
  cells: string[];
  page: ColoradoObservationReply;
  action: ColoradoNativePostback;
};
const historySnapshot = (rows: readonly HistoryRow[]) =>
  JSON.stringify(rows.map((r) => JSON.stringify(r.cells)).sort());
function primary(page: ColoradoObservationReply, r: ColoradoIeReceiver) {
  check(
    new URL(page.url).pathname ===
      "/PublicSite/SearchPages/CandidateDetail.aspx",
    "receipt_primary_route",
  );
  const identity = qualifyColoradoNativeCandidateProfile(page.bytes, r);
  validateColoradoIeReceiverIdentity(r, identity);
  return identity;
}
async function profile(
  s: ColoradoTracerObservations,
  prefix: string,
  url: string,
  r: ColoradoIeReceiver,
) {
  const page = await s.request(prefix + "_profile_form", url),
    d = document(page.bytes, page.url),
    f = form(d),
    p = values(f),
    id = input(d, "_ctl0_Content_txtCommitteeID"),
    submit = input(d, "_ctl0_Content_btnSearch");
  p.set(id.name, r.receivingId);
  p.set(submit.name, submit.value);
  const reply = await s.request(
    prefix + "_profile_search",
    action(f, page.url),
    p,
  );
  primary(reply, r);
  return reply;
}
async function history(
  s: ColoradoTracerObservations,
  prefix: string,
  page: ColoradoObservationReply,
  r: ColoradoIeReceiver,
  label: string,
) {
  const d = document(page.bytes, page.url),
    f = form(d),
    p = values(f);
  setOption(select(d, "_ctl0_Content_ddlFilingsFilterBy"), label, p);
  const submit = input(d, "_ctl0_Content_btnFilingsApplyFilter");
  p.set(submit.name, submit.value);
  let reply = await s.request(prefix + "_filter", action(f, page.url), p);
  primary(reply, r);
  const filtered = document(reply.bytes, reply.url),
    sizes = [...filtered.querySelectorAll<HTMLSelectElement>("select")].filter(
      (e) => e.id.includes("dgdFilingHistoryPageSizeDropDown"),
    );
  check(sizes.length === 1, "receipt_history_pagesize");
  const v = values(form(filtered));
  setOption(sizes[0]!, "50", v);
  const raw = sizes[0]!.getAttribute("onchange") ?? "",
    head = "javascript:setTimeout('",
    tail = "', 0)";
  check(
    raw.startsWith(head) && raw.endsWith(tail),
    "receipt_history_pagesize_action",
  );
  const inner = raw.slice(head.length, -tail.length);
  check(
    !inner.replaceAll("\\'", "").includes("\\"),
    "receipt_history_pagesize_escape",
  );
  reply = await post(
    s,
    prefix + "_fifty",
    reply,
    parseColoradoNativePostback("javascript:" + inner.replaceAll("\\'", "'")),
    v,
  );
  const rows: HistoryRow[] = [],
    seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber++) {
    check(pageNumber <= 100, "receipt_history_page_limit");
    primary(reply, r);
    const doc = document(reply.bytes, reply.url),
      filter = select(doc, "_ctl0_Content_ddlFilingsFilterBy");
    check(
      clean(filter.selectedOptions[0]?.textContent ?? "") === label,
      "receipt_history_filter_echo",
    );
    const t = doc.getElementById(
      "_ctl0_Content_dgdFilingHistory",
    ) as HTMLTableElement | null;
    check(
      t &&
        JSON.stringify(
          [...t.querySelectorAll("th")].map((e) => clean(e.textContent ?? "")),
        ) ===
          JSON.stringify([
            "Candidate/Committee",
            "Description",
            "Period Begin",
            "Period End",
            "Due Date",
            "Filed Date",
            "Amended",
            "Status",
          ]),
      "receipt_history_headers",
    );
    const data = [...t.rows].filter(
      (row) => row.cells.length === 8 && !row.querySelector("th"),
    );
    check(
      data.length > 0 && data.length <= 50,
      "receipt_history_empty_or_overflow",
    );
    for (const row of data) {
      const cells = [...row.cells].map((e) => clean(e.textContent ?? "")),
        key = JSON.stringify(cells),
        a = row.cells[1]!.querySelector("a[href]");
      check(a && !seen.has(key), "receipt_history_repeated_or_unlinked_row");
      seen.add(key);
      rows.push({
        cells,
        page: reply,
        action: parseColoradoNativePostback(a.getAttribute("href")!),
      });
    }
    const pager = [...t.rows].find(
      (row) => row.cells.length === 1 && row.cells[0]!.colSpan === 8,
    );
    if (!pager) {
      check(pageNumber === 1, "receipt_history_missing_pager");
      break;
    }
    const current = [...pager.querySelectorAll("span")].filter((e) =>
      /^\d+$/u.test(clean(e.textContent ?? "")),
    );
    check(
      current.length === 1 && Number(current[0]!.textContent) === pageNumber,
      "receipt_history_page_order",
    );
    const links = [...pager.querySelectorAll("a[href]")],
      next = links.filter(
        (a) => clean(a.textContent ?? "") === String(pageNumber + 1),
      ),
      more = links.filter(
        (a) =>
          clean(a.textContent ?? "") === "..." &&
          (current[0]!.compareDocumentPosition(a) & 4) !== 0,
      );
    check(
      next.length <= 1 && more.length <= 1,
      "receipt_history_pager_ambiguous",
    );
    const go = next[0] ?? more[0];
    if (!go) {
      check(
        !links.some(
          (a) =>
            /^\d+$/u.test(clean(a.textContent ?? "")) &&
            Number(a.textContent) > pageNumber,
        ),
        "receipt_history_page_gap",
      );
      break;
    }
    reply = await post(
      s,
      prefix + "_page_" + (pageNumber + 1),
      reply,
      parseColoradoNativePostback(go.getAttribute("href")!),
    );
  }
  return rows;
}
type Choice = { id: string; label: string; start: string; end: string };
async function receivingChoices(
  s: ColoradoTracerObservations,
  prefix: string,
  url: string,
  r: ColoradoIeReceiver,
) {
  const page = await s.request(prefix + "_receiving_form", url),
    d = document(page.bytes, page.url),
    f = form(d),
    p = values(f),
    id = input(d, "ctl00_Content_ucCommitteeSearch_txtSearchSOSID"),
    submit = input(d, "ctl00_Content_ucCommitteeSearch_btnSearch");
  p.set(id.name, r.receivingId);
  p.set(submit.name, submit.value);
  const result = await s.request(
      prefix + "_receiving_search",
      action(f, page.url),
      p,
    ),
    doc = document(result.bytes, result.url),
    grid = doc.getElementById(
      "ctl00_Content_ucCommitteeSearch_grdSearchResults",
    ) as HTMLTableElement | null;
  check(
    grid?.rows.length === 2 &&
      input(doc, "ctl00_Content_ucCommitteeSearch_txtSearchSOSID").value ===
        r.receivingId,
    "receipt_receiving_unique_hard_id",
  );
  const row = grid.rows[1]!,
    cells = [...row.cells].map((e) =>
      coloradoReportedNameKey(e.textContent ?? ""),
    ),
    name = coloradoReportedNameKey(r.receivingName);
  check(
    cells.includes(name) && cells.includes("CANDIDATE COMMITTEE"),
    "receipt_receiving_name_class",
  );
  const anchors = [...row.querySelectorAll("a[href]")].filter(
    (a) => coloradoReportedNameKey(a.textContent ?? "") === name,
  );
  check(anchors.length === 1, "receipt_receiving_record_action");
  const selected = await post(
      s,
      prefix + "_receiving_selected",
      result,
      parseColoradoNativePostback(anchors[0]!.getAttribute("href")!),
    ),
    sd = document(selected.bytes, selected.url),
    filings = select(sd, "ctl00_Content_ucCommitteeSearch_cboFiling");
  check(
    filings.options.length > 0 && filings.options.length <= 2000,
    "receipt_filing_choice_limit",
  );
  const choices = [...filings.options].map((o) => {
    const label = clean(o.textContent ?? ""),
      dates = label.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/gu);
    check(
      /^[1-9]\d{0,19}$/u.test(o.value) && dates?.length === 2,
      "receipt_filing_choice_grammar",
    );
    return {
      id: o.value,
      label,
      start: coloradoReportDate(dates[0]!),
      end: coloradoReportDate(dates[1]!),
    };
  });
  check(
    new Set(choices.map((o) => o.id)).size === choices.length,
    "receipt_duplicate_filing_choice",
  );
  return { page: selected, choices };
}
const period = (c: string[]) =>
  [coloradoReportDate(c[2]!), coloradoReportDate(c[3]!)] as const;
function currentHistory(
  rows: HistoryRow[],
  identity: ColoradoNativeCandidateProof,
  r: ColoradoIeReceiver,
): HistoryRow[] {
  return rows
    .filter((row) => {
      const [a, z] = period(row.cells);
      return a <= identity.cycleEnd && z >= identity.cycleStart;
    })
    .map((row) => {
      const [a, z] = period(row.cells);
      check(
        a >= identity.cycleStart &&
          z <= identity.cycleEnd &&
          a <= z &&
          coloradoReportedNameKey(row.cells[0]!) ===
            coloradoReportedNameKey(r.receivingName) &&
          row.cells[6] === "No" &&
          row.cells[7] === "Filed",
        "receipt_unqualified_current_version",
      );
      return row;
    });
}
const MONEY_FIELDS = [
  "lblReportingPeriodBeginBal",
  "lblItemContributionsTotal",
  "lblNonItemContributionsTotal",
  "lblContributionsTotal",
  "lblContributionsRetTotal",
  "lblNonMonContributionsTotal",
  "lblItemExpendituresTotal",
  "lblNonItemExpendituresTotal",
  "lblExpendituresTotal",
  "lblExpendituresRetTotal",
  "lblNonMonExpendituresTotal",
  "lblLoansReceived",
  "lblLoanRepaymentsMade",
  "lblMiscReceipts",
  "lblReportingPeriodEndingBal",
] as const;
function parent(
  page: ColoradoObservationReply,
  r: ColoradoIeReceiver,
  choice: Choice,
  report: ColoradoNativeReceiptReport,
) {
  const url = new URL(page.url);
  check(
    url.pathname === "/PublicSite/SearchPages/FilingDetail.aspx" &&
      url.searchParams.get("FilingID") === choice.id,
    "receipt_parent_filing_id",
  );
  const d = document(page.bytes, page.url),
    field = (id: string) => {
      const e = d.getElementById("_ctl0_Content_" + id);
      check(e, "receipt_parent_field");
      return clean(e.textContent ?? "");
    };
  const dates = field("lblReportingPeriod").match(
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/gu,
  );
  check(
    field("lblSOSID") === r.receivingId &&
      coloradoReportedNameKey(field("lblCommName")) ===
        coloradoReportedNameKey(r.receivingName) &&
      field("lblCommType") === "Candidate Committee" &&
      new RegExp(`\\b${r.electionYear}\\b`, "u").test(
        field("lblElectionCycle"),
      ) &&
      dates?.length === 2 &&
      coloradoReportDate(dates[0]!) === choice.start &&
      coloradoReportDate(dates[1]!) === choice.end,
    "receipt_parent_scope",
  );
  const m = Object.fromEntries(
    MONEY_FIELDS.map((k) => [k, coloradoReportCents(field(k))]),
  ) as Record<(typeof MONEY_FIELDS)[number], number>;
  check(
    coloradoReportDate(field("lblDateFiled")) ===
      coloradoReportDate(report.filed) &&
      coloradoReportDate(field("lblDateDue")) ===
        coloradoReportDate(report.due),
    "receipt_parent_filed_clock",
  );
  check(
    m.lblItemContributionsTotal === report.itemizedCents &&
      m.lblNonItemContributionsTotal === report.nonitemizedCents &&
      m.lblContributionsRetTotal === report.returnedCents &&
      m.lblContributionsTotal ===
        coloradoReceiptAdd(report.itemizedCents, report.nonitemizedCents) &&
      m.lblExpendituresTotal ===
        coloradoReceiptAdd(
          m.lblItemExpendituresTotal,
          m.lblNonItemExpendituresTotal,
        ) &&
      m.lblNonMonContributionsTotal === 0 &&
      m.lblExpendituresRetTotal === 0,
    "receipt_parent_subtotals",
  );
  const cash =
    BigInt(m.lblReportingPeriodBeginBal) +
    BigInt(m.lblContributionsTotal) -
    BigInt(m.lblExpendituresTotal) +
    BigInt(m.lblLoansReceived) -
    BigInt(m.lblLoanRepaymentsMade) +
    BigInt(m.lblMiscReceipts) +
    BigInt(m.lblContributionsRetTotal);
  check(
    cash === BigInt(m.lblReportingPeriodEndingBal),
    "receipt_parent_cash_control",
  );
  return {
    money: m,
    filed: field("lblDateFiled"),
    due: field("lblDateDue"),
    cycle: field("lblElectionCycle"),
    id: choice.id,
  };
}
async function major(
  s: ColoradoTracerObservations,
  prefix: string,
  record: HistoryRow,
  r: ColoradoIeReceiver,
) {
  const versions = await post(
      s,
      prefix + "_versions",
      record.page,
      record.action,
    ),
    d = document(versions.bytes, versions.url),
    t = d.getElementById(
      "_ctl0_Content_grdAmendments",
    ) as HTMLTableElement | null;
  check(
    new URL(versions.url).pathname ===
      "/PublicSite/SearchPages/FilingAmendmentSelect.aspx" &&
      t &&
      JSON.stringify(
        [...t.querySelectorAll("th")].map((e) => clean(e.textContent ?? "")),
      ) === JSON.stringify(["Amendment", "Report", "Filed", ""]),
    "receipt_major_version_table",
  );
  const rows = [...t.rows].filter((row) => !row.querySelector("th"));
  check(
    rows.length === 1 && rows[0]!.cells.length === 4,
    "receipt_major_unqualified_versions",
  );
  const a = rows[0]!.cells[1]!.querySelector("a[href]");
  check(a, "receipt_major_view_action");
  const generated = await post(
      s,
      prefix + "_view",
      versions,
      parseColoradoNativePostback(a.getAttribute("href")!),
    ),
    pair = await exportReport(s, prefix, generated),
    [from, to] = period(record.cells);
  check(from === to, "receipt_major_day_scope");
  const notice = parseColoradoNativeMajorNotice({
    ...pair,
    receivingId: r.receivingId,
    receivingName: r.receivingName,
    date: from,
  });
  return {
    notice,
    snapshot: JSON.stringify({
      versions: rows.map((row) =>
        [...row.cells].map((e) => clean(e.textContent ?? "")),
      ),
      xml: coloradoReceiptXmlSnapshot(pair.xml),
    }),
  };
}
async function receiptProtocol(
  s: ColoradoTracerObservations,
  r: ColoradoIeReceiver,
) {
  const catalog = await s.request("receipt_catalog", COLORADO_TRACER_REPORTS),
    navigation = document(catalog.bytes, catalog.url),
    profileUrl = link(navigation, "Committee Search", catalog.url),
    receiptUrl = link(
      navigation,
      "Contributions Received by a Committee – Detail",
      catalog.url,
    ),
    sourceThrough = coloradoSourceDay(s.manifest.records[0]!.startedAt);
  let opening:
    | {
        identity: ColoradoNativeCandidateProof;
        regular: string;
        major: string;
        choices: string;
      }
    | undefined;
  const observations = new Map<string, string>(),
    reports: ColoradoNativeReceiptReport[] = [],
    notices: ColoradoNativeMajorNotice[] = [];
  let regularThrough = "",
    cycleTotal: number | undefined;
  for (const phase of ["opening", "closing", "final"]) {
    const page = await profile(s, phase, profileUrl, r),
      identity = primary(page, r),
      regular = await history(
        s,
        phase + "_regular",
        page,
        r,
        "Report of Contributions and Expenditures",
      ),
      majors = await history(
        s,
        phase + "_major",
        page,
        r,
        "Notice of Major Contributor",
      ),
      selected = await receivingChoices(s, phase, receiptUrl, r);
    const state = {
      identity,
      regular: historySnapshot(regular),
      major: historySnapshot(majors),
      choices: JSON.stringify(selected.choices),
    };
    if (!opening) opening = state;
    else
      check(
        isDeepStrictEqual(opening, state),
        "receipt_complete_inventory_changed",
      );
    const total = document(page.bytes, page.url).getElementById(
      "_ctl0_Content_lblTotalCont_EC",
    );
    check(total, "receipt_cycle_total_missing");
    const nativeTotal = coloradoReportCents(clean(total.textContent ?? ""));
    if (cycleTotal === undefined) cycleTotal = nativeTotal;
    else check(cycleTotal === nativeTotal, "receipt_cycle_total_changed");
    if (phase === "final") break;
    const current = currentHistory(regular, identity, r),
      currentMajors = currentHistory(majors, identity, r),
      choices = selected.choices.filter(
        (c) => c.start <= identity.cycleEnd && c.end >= identity.cycleStart,
      ),
      byPeriod = new Map<string, Choice>();
    check(
      current.length > 0 && current.length === choices.length,
      "receipt_current_inventory_population",
    );
    for (const c of choices) {
      check(
        c.start >= identity.cycleStart &&
          c.end <= identity.cycleEnd &&
          !byPeriod.has(c.start + "|" + c.end),
        "receipt_current_choice_versions",
      );
      byPeriod.set(c.start + "|" + c.end, c);
    }
    const ordered = current
      .map((row) => ({ row, bounds: period(row.cells) }))
      .sort((a, b) => a.bounds[0].localeCompare(b.bounds[0]));
    let edge = identity.cycleStart,
      previousBalance: number | undefined,
      net = 0;
    for (const [
      index,
      {
        row,
        bounds: [from, to],
      },
    ] of ordered.entries()) {
      check(
        from === edge && to <= sourceThrough,
        "receipt_current_period_gap_or_overlap",
      );
      edge = new Date(Date.parse(to + "T00:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
      regularThrough = to;
      const choice = byPeriod.get(from + "|" + to);
      check(choice, "receipt_history_choice_period");
      const sd = document(selected.page.bytes, selected.page.url),
        f = form(sd),
        p = values(f),
        filings = select(sd, "ctl00_Content_ucCommitteeSearch_cboFiling"),
        submit = input(sd, "ctl00_Content_btnGenerateReport");
      p.set(filings.name, choice.id);
      p.set("__EVENTTARGET", "");
      p.set("__EVENTARGUMENT", "");
      p.set(submit.name, submit.value);
      const prefix = phase + "_receipt_" + (index + 1),
        generated = await s.request(
          prefix + "_generate",
          action(f, selected.page.url),
          p,
        ),
        pair = await exportReport(s, prefix, generated),
        report = parseColoradoNativeReceiptReport({
          ...pair,
          receivingName: r.receivingName,
          year: r.electionYear,
          start: from,
          end: to,
        });
      check(
        report.filed.slice(0, 16) ===
          coloradoReceiptFiledMinute(row.cells[5]!) &&
          coloradoReportDate(report.due) === coloradoReportDate(row.cells[4]!),
        "receipt_history_export_filed_clock",
      );
      const pd = await post(s, prefix + "_parent", row.page, row.action),
        control = parent(pd, r, choice, report),
        snapshot = JSON.stringify({
          parent: control,
          xml: coloradoReceiptXmlSnapshot(pair.xml),
        }),
        key = from + "|" + to;
      check(
        previousBalance === undefined ||
          previousBalance === control.money.lblReportingPeriodBeginBal,
        "receipt_consecutive_balance",
      );
      previousBalance = control.money.lblReportingPeriodEndingBal;
      net = coloradoReceiptAdd(
        net,
        coloradoReceiptAdd(
          coloradoReceiptAdd(report.itemizedCents, report.nonitemizedCents),
          report.returnedCents,
        ),
      );
      if (phase === "opening") {
        observations.set(key, snapshot);
        reports.push(report);
      } else
        check(
          observations.get(key) === snapshot,
          "receipt_complete_parent_or_rows_changed",
        );
    }
    check(net === cycleTotal, "receipt_native_cycle_control");
    for (const [index, row] of currentMajors.entries()) {
      const result = await major(s, phase + "_major_" + (index + 1), row, r),
        key = "major:" + JSON.stringify(row.cells);
      check(
        !observations.has(key) || phase !== "opening",
        "receipt_duplicate_major_record",
      );
      if (phase === "opening") {
        observations.set(key, result.snapshot);
        notices.push(result.notice);
      } else
        check(
          observations.get(key) === result.snapshot,
          "receipt_major_closing_changed",
        );
    }
  }
  check(opening && regularThrough, "receipt_scope_incomplete");
  return {
    identity: opening.identity,
    reports,
    notices,
    regularThrough,
    sourceThrough,
  };
}
export async function getColoradoNativeReceiptsPacket(
  options: Options & { receiver: ColoradoIeReceiver; registry?: Registry },
): Promise<ColoradoNativeReceiptsPacket> {
  check(isColoradoNativeReceiptsEnabled(), "colorado_native_receipts_disabled");
  check(
    options.receiver &&
      /^[1-9]\d{0,19}$/u.test(options.receiver.receivingId) &&
      typeof options.receiver.receivingName === "string" &&
      options.receiver.receivingName.trim().length > 0 &&
      Number.isSafeInteger(options.receiver.electionYear) &&
      options.receiver.electionYear >= 2026 &&
      options.receiver.electionYear <= 2100,
    "receipt_expected_context",
  );
  const registry =
    options.registry ??
    (await getColoradoNativeReceiptRegistry({
      ...options,
      electionYear: options.receiver.electionYear,
    }));
  check(registries.has(registry), "receipt_unverified_registry");
  const result = await source({
    ...options,
    kind: "named-receipts",
    year: options.receiver.electionYear,
    run: (s) => receiptProtocol(s, options.receiver),
  });
  check(
    registry.asOf === result.sourceThrough,
    "receipt_registry_observation_day",
  );
  const projection = aggregateColoradoNativeReceipts({
    reports: result.reports,
    registry: registry.rows,
    notices: result.notices,
  });
  const packet: ColoradoNativeReceiptsPacket = {
    receiver: options.receiver,
    identity: result.identity,
    ...projection,
    facts: {
      revision: CO_NATIVE_RECEIPTS_REVISION,
      cycleStart: result.identity.cycleStart,
      regularThrough: result.regularThrough,
      sourceThrough: result.sourceThrough,
      registry: registry.source,
      receipts: result.source,
    },
  };
  freeze(packet);
  packets.add(packet);
  return packet;
}
