import { createRequire } from "node:module";
import { hiAdd, hiCents, hiDay, hiHold, hiLiteral, hiNameKey, hiRequired } from "./hawaiiReportedCore.js";
const require = createRequire(import.meta.url);
export const HI_NATIVE_ORIGIN = "https://csc.hawaii.gov";
export function hiDocument(html: string, url = HI_NATIVE_ORIGIN): Document {
  const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { url: string }) => { window: { document: Document } } };
  return new JSDOM(html, { url }).window.document;
}
export function hiNativeUrl(raw: string, base: string): string {
  const u = new URL(raw, base);
  if (u.origin !== HI_NATIVE_ORIGIN || u.username || u.password || u.hash) hiHold("native_origin");
  return u.href;
}
export type HawaiiNativeReport = { type: string; period: string; amended: string; filed: string; href: string };
export function hiFiledDay(raw: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(hiRequired(raw));
  if (!m) hiHold("native_filing_date");
  return hiDay(`${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
}
export function hiReportPhase(period: string): number {
  const v = period.toLowerCase();
  if (v.includes("preliminary") && v.includes("general")) return /2nd|second/.test(v) ? 6 : /1st|first/.test(v) ? 5 : -1;
  if (v.includes("final") && v.includes("primary")) return 4;
  if (v.includes("preliminary") && v.includes("primary")) return /1st|first/.test(v) ? 1 : /2nd|second/.test(v) ? 2 : 3;
  if (v.includes("final") && !v.includes("primary")) return 7;
  if (v.includes("supplemental")) return 0;
  return -1;
}

/** Resolve amendment families using exact native report label + PERIOD, never
 * selector order. Candidate static covers use distinct document links; they
 * are grouped by exact report label, with the same explicit lineage rules. */
export function selectHawaiiNativeReport(rows: readonly HawaiiNativeReport[], electionPeriod: string, base: string, asOfDay: string,
  noncandidate: boolean): { report: HawaiiNativeReport; sourceVersions: number; supersededVersions: number } {
  const period = hiRequired(electionPeriod), asOf = hiDay(asOfDay);
  if (!/^20\d\d-20\d\d$/.test(period)) hiHold("native_election_period");
  const normalized = (s: string) => s.replace(/\s*[-–]\s*/g, "-");
  const selected = rows.filter(r => r.type === "Disclosure" && (noncandidate ? normalized(r.period).includes(period)
    : new RegExp(`,\\s*${period.slice(-4)}$`).test(r.period)));
  if (!selected.length) hiHold("native_disclosure_missing");
  const families = new Map<string, HawaiiNativeReport[]>();
  for (const r of selected) {
    if (!["No", "Yes"].includes(r.amended) || hiReportPhase(r.period) < 0 || hiFiledDay(r.filed) > asOf) hiHold("native_version_metadata");
    const u = new URL(hiNativeUrl(r.href, base));
    if (noncandidate && (u.searchParams.size !== 2 || !u.searchParams.get("PERIOD") || !u.searchParams.get("RPT_DTS"))) hiHold("native_version_link");
    const key = JSON.stringify([r.period, noncandidate ? u.searchParams.get("PERIOD") : "candidate-static"]);
    const family = families.get(key) ?? []; family.push(r); families.set(key, family);
  }
  const current: HawaiiNativeReport[] = []; let superseded = 0;
  for (const family of families.values()) {
    if (new Set(family.map(r => hiFiledDay(r.filed))).size !== family.length) hiHold("native_version_clock_tie");
    const versions = [...family].sort((a, b) => hiFiledDay(a.filed).localeCompare(hiFiledDay(b.filed)));
    if (versions.length > 1 && (versions.filter(r => r.amended === "No").length !== 1 || versions[0]!.amended !== "No"
      || versions.at(-1)!.amended !== "Yes")) hiHold("native_amendment_lineage");
    current.push(versions.at(-1)!); superseded += versions.length - 1;
  }
  current.sort((a, b) => hiReportPhase(b.period) - hiReportPhase(a.period) || hiFiledDay(b.filed).localeCompare(hiFiledDay(a.filed)));
  if (current.length > 1 && hiReportPhase(current[0]!.period) === hiReportPhase(current[1]!.period)
    && hiFiledDay(current[0]!.filed) === hiFiledDay(current[1]!.filed)) hiHold("native_current_report_tie");
  return { report: current[0]!, sourceVersions: selected.length, supersededVersions: superseded };
}

export type HawaiiNativeMoneyControl = { label: string; reportCents: number; electionCents: number };
export function parseHawaiiNativeCover(html: string, filerName: string): HawaiiNativeMoneyControl[] {
  const doc = hiDocument(html); doc.querySelectorAll("script,style").forEach(e => e.remove());
  if (!hiNameKey(doc.body.textContent ?? "").includes(hiNameKey(hiRequired(filerName)))) hiHold("cover_filer_identity");
  const controls: HawaiiNativeMoneyControl[] = [];
  for (const tr of doc.querySelectorAll("tr")) {
    if (tr.children.length !== 3) continue;
    const [label, a, b] = [...tr.children].map(c => hiLiteral(c.textContent ?? ""));
    if (![a, b].every(v => /^\$?\s*[-(]?\s*\d[\d,]*\.\d{2}\)?$/.test(v!))) continue;
    controls.push({ label: label!, reportCents: hiCents(a), electionCents: hiCents(b) });
  }
  if (!controls.length) hiHold("native_cover_controls");
  return controls;
}
export function hiB2CoverCents(controls: readonly HawaiiNativeMoneyControl[]): number {
  const rows = controls.filter(c => c.label === "13. Expenditures Made (Schedule B2)");
  if (rows.length !== 1 || rows[0]!.electionCents < 0) hiHold("native_b2_control");
  return rows[0]!.electionCents;
}
export function hiItemizedCoverCents(controls: readonly HawaiiNativeMoneyControl[]): number {
  const rows = controls.filter(c => c.label === "(ii) Monetary and Non-Monetary Contributions of More Than $100 (Schedule A)");
  if (rows.length !== 2 || rows.some(c => c.electionCents < 0)) hiHold("native_itemized_control");
  return hiAdd(rows[0]!.electionCents, rows[1]!.electionCents);
}

export function hiFormFields(form: HTMLFormElement): URLSearchParams {
  if (form.method !== "post") hiHold("native_form_method");
  const fields = new URLSearchParams();
  for (const e of [...form.elements] as HTMLInputElement[]) {
    if (!e.name || e.disabled || ["submit", "button", "image", "reset", "file"].includes(e.type)
      || (["checkbox", "radio"].includes(e.type) && !e.checked)) continue;
    if (/password|credential|auth/i.test(e.name)) hiHold("native_credential_field");
    fields.append(e.name, e.value ?? "");
  }
  return fields;
}
export type HawaiiNativeRegistryRow = { name: string; office: string; inactive: string; reportLink: string; orgLink: string };
export function hiGrid(html: string, url: string, field: string): Document {
  let response: { setValue?: { value?: unknown }[] };
  try { response = JSON.parse(html); } catch { return hiHold("native_grid_json"); }
  const fragments = response.setValue?.filter(v => typeof v.value === "string" && v.value.includes(`id_sc_field_${field}_`));
  if (fragments?.length !== 1) hiHold("native_grid_fragment");
  return hiDocument(fragments[0]!.value as string, url);
}
export function hiRegistryRows(doc: Document, noncandidate: boolean): HawaiiNativeRegistryRow[] {
  const field = noncandidate ? "or_cc_committee_name" : "or_cc_candidate_name";
  return [...doc.querySelectorAll<HTMLAnchorElement>(`a[id^="id_sc_field_${field}_"]`)].map(a => {
    const n = /_(\d+)$/.exec(a.id)?.[1]; if (!n) hiHold("native_registry_identity");
    return { name: hiRequired(a.textContent), office: hiLiteral(doc.getElementById(`id_sc_field_of_office_${n}`)?.textContent ?? ""),
      inactive: hiRequired(doc.getElementById(`id_sc_field_inactive_${n}`)?.textContent),
      reportLink: hiRequired(a.getAttribute("href")), orgLink: hiRequired(doc.getElementById(`id_sc_field_org_rpt_${n}`)?.getAttribute("href")) };
  });
}
export function hiNativeProfileRequest(link: string, fields: URLSearchParams, base: string, noncandidate: boolean, organization: boolean): { url: string; body: URLSearchParams } {
  // Parse only the observed literal call. Never evaluate native JavaScript.
  const m = /^javascript:\s*nm_gp_submit5\((.*)\);?\s*$/s.exec(link);
  if (!m) hiHold("native_profile_call");
  const args: string[] = []; let rest = m[1]!.trim();
  while (rest) {
    const arg = /^(['"])((?:\\[\\'"]|(?!\1)[^\\])*)\1\s*(,|$)/s.exec(rest);
    if (!arg) hiHold("native_profile_arguments");
    args.push(arg[2]!.replace(/\\([\\'"])/g, "$1")); rest = rest.slice(arg[0].length).trim();
  }
  const directory = noncandidate ? "/NCFSPublic/" : "/CFSPublic/";
  if (args.length !== 10 || hiNativeUrl(args[0]!, base) !== HI_NATIVE_ORIGIN + directory + (organization ? "cc_xorg_report/" : "report_detail/")
    || hiNativeUrl(args[1]!, base) !== base || args[3] !== "_self" || !args[2]) hiHold("native_profile_scope");
  const body = new URLSearchParams(fields);
  body.set("nmgp_url_saida", args[1]!); body.set("nmgp_parms", args[2]!.replace(/@percent@/g, "%"));
  body.set("nmgp_opcao", args[4] ? "grid" : ""); body.set("nmgp_outra_jan", "");
  return { url: hiNativeUrl(args[0]!, base), body };
}
export function hiInventoryRows(doc: Document, noncandidate: boolean): HawaiiNativeReport[] {
  return [...doc.querySelectorAll('[id^="id_sc_field_report_file_rpt_type_"]')].map(e => {
    const n = /_(\d+)$/.exec(e.id)?.[1]; if (!n) hiHold("native_report_row");
    const type = hiRequired(e.textContent);
    const field = (key: string) => {
      const value = doc.getElementById(`id_sc_field_${key}_${n}`)?.textContent;
      return type === "Disclosure" && ["rpt_name", "report_period"].includes(key) ? hiRequired(value) : hiLiteral(value ?? "");
    };
    const view = doc.getElementById(`id_sc_field_vreport_${n}`), a = view?.closest("a") ?? view?.querySelector("a");
    return { type, period: field(noncandidate ? "rpt_name" : "report_period"),
      amended: field("report_file_rpt_amend"), filed: field("report_file_rpt_date_file"), href: a?.getAttribute("href") ?? "" };
  });
}
export function hiNativeCount(doc: Document, max: number): number {
  const m = /\[\s*1\s+to\s+\d+\s+of\s+(\d+)\s*\]/.exec(doc.body.textContent ?? "");
  const count = Number(m?.[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > max) hiHold("native_inventory_count");
  return count;
}
