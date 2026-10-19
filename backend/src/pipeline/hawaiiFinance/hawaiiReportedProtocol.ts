import { hiAdd, hiCanonical, hiCents, hiDay, hiHold, hiLiteral, hiNameKey, hiRequired } from "./hawaiiReportedCore.js";
import { hiDocument, hiFormFields, hiGrid, hiInventoryRows, hiNativeCount, hiNativeProfileRequest, hiNativeUrl,
  hiRegistryRows, HI_NATIVE_ORIGIN, selectHawaiiNativeReport, parseHawaiiNativeCover, hiB2CoverCents, hiItemizedCoverCents,
  type HawaiiNativeRegistryRow } from "./hawaiiReportedNative.js";
import type { HawaiiSourceRead } from "./hawaiiReportedOriginals.js";
import type { HawaiiPublishedRow } from "./hawaiiReportedCommitteeAggregator.js";
import { parseHawaiiOfficialRoster } from "./hawaiiReportedIdentity.js";

export const HI_SODA_ORIGIN = "https://hicscdata.hawaii.gov";
export const HI_ROSTER_URL = "https://olvr.hawaii.gov/Controls/CandidateFiling.aspx?elid=94";
const canonical = hiCanonical;
const form = (doc: Document, name: string): HTMLFormElement => {
  const f = doc.forms.namedItem(name); if (!f) hiHold("native_form_missing"); return f;
};
function init(doc: Document): string {
  const e = form(doc, "F4").elements.namedItem("script_case_init") as HTMLInputElement | null;
  return hiRequired(e?.value);
}
function paging(initial: string, offset: number): URLSearchParams {
  return new URLSearchParams({ nmgp_opcao: "ajax_navigate", script_case_init: initial,
    opc: offset ? "rec" : "muda_qt_linhas", parm: String(offset ? offset + 1 : 50) });
}
const json = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return hiHold("source_json"); } };

export async function readHawaiiSoda(read: HawaiiSourceRead, role: string, dataset: string, where: string): Promise<{
  rows: HawaiiPublishedRow[]; publisherUpdatedAt: string; cents: number;
}> {
  const query = (params: Record<string, string>) => HI_SODA_ORIGIN + `/resource/${dataset}.json?` + new URLSearchParams(params);
  const metaUrl = `${HI_SODA_ORIGIN}/api/views/${dataset}.json`;
  const openingMeta = json(await read(role + "_metadata_opening", metaUrl)) as { id?: string; rowsUpdatedAt?: number };
  const controlUrl = query({ $select: "count(*) as n,count(amount) as amount_count,sum(amount) as total,min(date) as first_date,max(date) as last_date", $where: where });
  const control = json(await read(role + "_controls_opening", controlUrl)) as Record<string, string>[];
  if (!Array.isArray(control) || control.length !== 1 || !/^\d+$/.test(control[0]?.n ?? "")) hiHold("source_count");
  const count = Number(control[0]!.n);
  if (count < 1 || count > 100000 || control[0]!.amount_count !== String(count)) hiHold("source_count");
  const sweeps: HawaiiPublishedRow[][] = [];
  for (const phase of ["opening", "closing"]) {
    const rows: HawaiiPublishedRow[] = [], seen = new Set<string>(); let sum = 0;
    for (let offset = 0; offset < count; offset += 5000) {
      const page = json(await read(`${role}_${phase}_${offset / 5000}`, query({ $select: "*,:id as source_row_id", $where: where, $order: ":id ASC", $limit: "5000", $offset: String(offset) })));
      if (!Array.isArray(page) || page.length !== Math.min(5000, count - offset)) hiHold("source_page_count");
      for (const r of page as HawaiiPublishedRow[]) {
        const id = hiRequired(r.source_row_id); if (seen.has(id)) hiHold("published_row_identity"); seen.add(id);
        hiDay(r.date); sum = hiAdd(sum, hiCents(r.amount)); rows.push(r);
      }
    }
    if (sum !== hiCents(control[0]!.total)) hiHold("source_money_control"); sweeps.push(rows);
  }
  const closing = json(await read(role + "_controls_closing", controlUrl));
  const closingMeta = json(await read(role + "_metadata_closing", metaUrl)) as typeof openingMeta;
  if (canonical(sweeps[0]) !== canonical(sweeps[1]) || canonical(control) !== canonical(closing)
    || openingMeta.id !== dataset || closingMeta.id !== dataset || openingMeta.rowsUpdatedAt !== closingMeta.rowsUpdatedAt
    || !Number.isSafeInteger(openingMeta.rowsUpdatedAt) || openingMeta.rowsUpdatedAt! * 1000 > Date.now() + 300000) hiHold("source_generation_changed");
  return { rows: sweeps[1]!, cents: hiCents(control[0]!.total), publisherUpdatedAt: new Date(openingMeta.rowsUpdatedAt! * 1000).toISOString() };
}

export async function readHawaiiRoster(read: HawaiiSourceRead) {
  const csv: string[] = [];
  for (let sweep = 0; sweep < 2; sweep++) {
    const doc = hiDocument(await read(`roster_form_${sweep}`, HI_ROSTER_URL), HI_ROSTER_URL), f = doc.querySelector("form");
    if (!f || new URL(f.action, HI_ROSTER_URL).href !== HI_ROSTER_URL) hiHold("roster_export_form");
    const controls = [...f.elements] as HTMLInputElement[], exportButton = controls.filter(e => e.id.endsWith("_ExportToCsvButton"));
    if (exportButton.length !== 1 || !exportButton[0]!.name) hiHold("roster_export_button");
    const fields = hiFormFields(f); fields.set(exportButton[0]!.name, exportButton[0]!.value);
    csv.push(await read(`roster_csv_${sweep}`, HI_ROSTER_URL, fields));
  }
  if (csv[0] !== csv[1]) hiHold("roster_changed");
  return parseHawaiiOfficialRoster(csv[0]!);
}

export async function readHawaiiRegistry(read: HawaiiSourceRead, noncandidate: boolean): Promise<HawaiiNativeRegistryRow[]> {
  const prefix = noncandidate ? "noncandidate" : "candidate", base = HI_NATIVE_ORIGIN + (noncandidate ? "/NCFSPublic/" : "/CFSPublic/") + "report_list/";
  const field = noncandidate ? "or_cc_committee_name" : "or_cc_candidate_name", sweeps: HawaiiNativeRegistryRow[][] = [];
  let expected = 0;
  for (let sweep = 0; sweep < 2; sweep++) {
    const root = hiDocument(await read(`${prefix}_registry_root_${sweep}`, base), base), count = hiNativeCount(root, 5000), initial = init(root);
    if (expected && expected !== count) hiHold("registry_count_changed"); expected = count;
    const rows: HawaiiNativeRegistryRow[] = [];
    for (let offset = 0; offset < count; offset += 50) {
      const grid = hiGrid(await read(`${prefix}_registry_${sweep}_page_${offset}`, base + "index.php", paging(initial, offset)), base, field);
      const page = hiRegistryRows(grid, noncandidate);
      if (page.length !== Math.min(50, count - offset)) hiHold("registry_page_count"); rows.push(...page);
    }
    if (new Set(rows.map(r => r.reportLink)).size !== count) hiHold("registry_duplicate_selector");
    sweeps.push(rows);
  }
  const identities = (rows: HawaiiNativeRegistryRow[]) => rows.map(({ name, office, inactive }) => ({ name, office, inactive }));
  if (canonical(identities(sweeps[0]!)) !== canonical(identities(sweeps[1]!))) hiHold("registry_changed");
  return sweeps[1]!;
}

async function readNativePrintable(read: HawaiiSourceRead, prefix: string, url: string): Promise<string> {
  let raw = await read(prefix + "_cover", url);
  for (let depth = 0; depth < 4; depth++) {
    const doc = hiDocument(raw, url), scripts = [...doc.scripts].map(e => e.textContent ?? ""), f = doc.forms.namedItem("Fini");
    if (f && scripts.some(s => /^\s*document\.Fini\.nmgp_navegator_print\.value\s*=\s*navigator\.appName;\s*document\.Fini\.submit\(\);\s*$/.test(s))) {
      const dest = hiNativeUrl(f.getAttribute("action") || url, url), fields = hiFormFields(f);
      if (!["/CFSPublic/", "/NCFSPublic/"].some(p => new URL(dest).pathname.startsWith(p))) hiHold("native_print_scope");
      fields.set("nmgp_navegator_print", "Netscape"); url = dest; raw = await read(`${prefix}_print_${depth}`, dest, fields); continue;
    }
    const redirect = scripts.length === 1 ? /^\s*window\.location\s*=\s*(["'])([^\\\r\n]*?)\1\s*;?\s*$/.exec(scripts[0]!) : null;
    if (redirect) { url = hiNativeUrl(redirect[2]!, url); raw = await read(`${prefix}_redirect_${depth}`, url); continue; }
    return raw;
  }
  return hiHold("native_print_depth");
}

export async function readHawaiiNativeFiler(read: HawaiiSourceRead, input: {
  prefix: string; noncandidate: boolean; registry: readonly HawaiiNativeRegistryRow[]; name: string; office?: string; district?: string | null;
  electionPeriod: string; asOfDay: string;
}): Promise<{ cents: number; filedDay: string; sourceVersions: number; supersededVersions: number; orgOffice: string; orgDistrict: string | null }> {
  const { prefix, noncandidate } = input, base = HI_NATIVE_ORIGIN + (noncandidate ? "/NCFSPublic/" : "/CFSPublic/") + "report_list/";
  const matches = input.registry.flatMap((r, index) => hiNameKey(r.name) === hiNameKey(input.name)
    && (noncandidate || r.office === input.office) ? [{ r, index }] : []);
  if (matches.length !== 1) hiHold("native_registry_filer_ambiguous");
  // Anonymous selectors are bound to a live registry-page context. Re-select
  // freshly for every filer, instead of replaying another page's token.
  const root = hiDocument(await read(prefix + "_registry_root", base), base), initial = init(root), fields = hiFormFields(form(root, "F3"));
  const pageStart = Math.floor(matches[0]!.index / 50) * 50; let chosen: HawaiiNativeRegistryRow | undefined;
  for (const offset of [...new Set([0, pageStart])]) {
    const grid = hiGrid(await read(`${prefix}_registry_page_${offset}`, base + "index.php", paging(initial, offset)), base, noncandidate ? "or_cc_committee_name" : "or_cc_candidate_name");
    const candidates = hiRegistryRows(grid, noncandidate).filter(r => hiNameKey(r.name) === hiNameKey(input.name) && (noncandidate || r.office === input.office));
    if (candidates.length > 1) hiHold("native_fresh_registry_ambiguous"); if (candidates.length === 1) chosen = candidates[0];
  }
  if (!chosen) hiHold("native_fresh_registry_missing");
  const orgReq = hiNativeProfileRequest(chosen.orgLink, fields, base, noncandidate, true);
  const org = hiDocument(await read(prefix + "_org", orgReq.url, orgReq.body), orgReq.url);
  org.querySelectorAll("script,style").forEach(e => e.remove());
  if (!hiNameKey(org.body.textContent ?? "").includes(hiNameKey(input.name))) hiHold("native_org_identity");
  const fieldValue = (label: RegExp) => [...org.querySelectorAll("strong")].find(e => label.test(e.textContent ?? ""))?.closest("td")?.nextElementSibling?.textContent?.trim() ?? "";
  const orgOffice = fieldValue(/Office Sought/i), rawDistrict = fieldValue(/District \/ County/i).split("/")[0]!.trim();
  const orgDistrict = rawDistrict && /^0*[1-9]\d?$/.test(rawDistrict) ? String(Number(rawDistrict)) : null;
  if (!noncandidate && (orgOffice !== input.office || (input.district && orgDistrict !== input.district))) hiHold("native_org_seat");
  const inventoryReq = hiNativeProfileRequest(chosen.reportLink, fields, base, noncandidate, false);
  const inventory = hiDocument(await read(prefix + "_inventory", inventoryReq.url, inventoryReq.body), inventoryReq.url);
  const count = hiNativeCount(inventory, 4000), inventoryInit = init(inventory), records = [];
  for (let offset = 0; offset < count; offset += 50) {
    const grid = hiGrid(await read(`${prefix}_inventory_page_${offset}`, inventoryReq.url + "index.php", paging(inventoryInit, offset)), inventoryReq.url, "report_file_rpt_type");
    const page = hiInventoryRows(grid, noncandidate); if (page.length !== Math.min(50, count - offset)) hiHold("native_report_page_count"); records.push(...page);
  }
  if (new Set(records.map(canonical)).size !== records.length) hiHold("native_report_duplicate");
  const selected = selectHawaiiNativeReport(records, input.electionPeriod, inventoryReq.url, input.asOfDay, noncandidate);
  const cover = await readNativePrintable(read, prefix, hiNativeUrl(selected.report.href, inventoryReq.url));
  if (!noncandidate) {
    const headings = [...hiDocument(cover).querySelectorAll("th")].map(e => hiLiteral(e.textContent ?? "")).filter(t => /^20\d\d\s*[-–]\s*20\d\d\s/.test(t));
    const expected = `${input.electionPeriod} ${selected.report.period}`;
    if (headings.length !== 1 || headings[0] !== expected) hiHold("native_receiving_cover_period");
  }
  const controls = parseHawaiiNativeCover(cover, input.name);
  return { cents: noncandidate ? hiB2CoverCents(controls) : hiItemizedCoverCents(controls),
    filedDay: selected.report.filed, sourceVersions: selected.sourceVersions, supersededVersions: selected.supersededVersions, orgOffice, orgDistrict };
}
