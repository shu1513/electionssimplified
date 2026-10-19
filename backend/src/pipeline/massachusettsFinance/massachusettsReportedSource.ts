import { resolve } from "node:path";
import { isMassachusettsReportedRawRefreshEnabled } from "../../config/featureFlags.js";
import { createMassachusettsOriginalCapture, maOriginalDirectories, maReportedCache, readMassachusettsOriginalDirectory,
  type MassachusettsOriginalDirectory, type MassachusettsOriginalCapture } from "./massachusettsReportedOriginals.js";
import { maArray, maCurrentReport, maId, maReportItems, maSameHeader, maSameReceiptSweeps, maSameReportSet, maReceiptSweep, maUniqueReports } from "./massachusettsReportedNative.js";
import { maCanonical, maFreeze, maHash, maHold, type MassachusettsReportedKind } from "./massachusettsReportedCore.js";
import { validateMassachusettsReportedReceiver, type MassachusettsReportedReceiver } from "./massachusettsReportedReceiver.js";

type Leaf = { value: any; meta: MassachusettsOriginalCapture };
export type MassachusettsReportedPacket = {
  kind: MassachusettsReportedKind; sourceAt: string; sourceHash: string; acquisitionStartedAt: string;
  oldestBodyAt: string; newestBodyAt: string; registry: any[];
  reports: { iepac: boolean; value: any }[]; sourceRows: number; reportCount: number;
};
export type MassachusettsReceiverPacket = {
  packet: MassachusettsReportedPacket; receiver: MassachusettsReportedReceiver; rows: any[];
  sourceAt: string; sourceHash: string; profileAt: string; profileHash: string; profileStartedAt: string;
};
const packets = new WeakSet<object>(), receivers = new WeakSet<object>();
export const isMassachusettsReportedPacket = (v: MassachusettsReportedPacket): boolean => packets.has(v);
export const isMassachusettsReceiverPacket = (v: MassachusettsReceiverPacket): boolean => receivers.has(v);
const YEAR = 2026, pageSize = 500;
const years = (): number[] => new Date().getUTCFullYear() > YEAR ? [YEAR, YEAR + 1] : [YEAR];
const paths = (year: number) => ({
  iepac: `/miscreports/iepacs/reports/${year}`,
  iepac_controls: `/miscreports/iepacs/reports/summary/${year}`,
  ordinary: `/miscreports/reports/${year}?reportTypeDescription=IE&pageSize=1000`,
  ordinary_controls: `/miscreports/reports/summary/${year}?reportType=IE`,
});
function reportListUrl(owner: number, type: number, year: number): string {
  const q = new URLSearchParams({ BaseReportTypeId: String(type), OnlyCurrent: "true", ReportYear: String(year), PageSize: "1000", CurrentIndex: "1", withSummary: "true" });
  return `/reports/reportList/${owner}?${q}`;
}
function nativeBaseType(value: any): number {
  const types = maArray(value).filter(r => r.baseReportTypeDescription === "7day/24 Hour Reports");
  if (types.length !== 1) maHold("native_report_type");
  return maId(types[0].baseReportTypeId);
}
async function directories(cache: string): Promise<MassachusettsOriginalDirectory[]> {
  const out: MassachusettsOriginalDirectory[] = [];
  for (const name of await maOriginalDirectories(cache)) {
    try { out.push(await readMassachusettsOriginalDirectory(resolve(cache, name))); }
    catch { /* Incomplete/failed original graphs have no authority. */ }
  }
  return out;
}
async function reportLeaves(dirs: MassachusettsOriginalDirectory[], before: string): Promise<Leaf[]> {
  const out: Leaf[] = [];
  for (const d of dirs) for (const m of d.records) {
    if (!/^(?:iepac_(?:report|missing|leaf)|ordinary_(?:report|leaf))_\d+$/.test(m.role) || m.completedAt > before) continue;
    try { out.push({ value: await d.json(m.role), meta: m }); } catch { /* Try another genuine original. */ }
  }
  return out;
}
function chooseLeaf(leaves: Leaf[], header: any, iepac: boolean, before: string, freshOnly: boolean): Leaf | undefined {
  const matches = leaves.filter(l => l.meta.completedAt <= before && maSameHeader(l.value, header, iepac) &&
    (!freshOnly || Date.now() - Date.parse(l.meta.completedAt) <= 7 * 86400000));
  const financial = (v: any) => maCanonical(v.expenditures);
  if (new Set(matches.map(l => financial(l.value))).size > 1) maHold("same_version_financial_conflict");
  return matches.sort((a, b) => b.meta.completedAt.localeCompare(a.meta.completedAt))[0];
}
async function unchanged(d: MassachusettsOriginalDirectory, role: string): Promise<any> {
  const a = await d.json(role + "_opening"), b = await d.json(role + "_closing");
  if (maCanonical(a) !== maCanonical(b)) maHold("source_changed_before_closure");
  return a;
}
function validRegistry(v: any): any[] {
  const registry = maArray(v), ids = registry.map(r => maId(r.cpfId));
  if (!ids.length || new Set(ids).size !== ids.length) maHold("native_registry_identity");
  return registry;
}
/** Replays originals and native current membership every time. Manifest roles
 * are local provenance, not financial controls or an exported success audit. */
async function replayIe(d: MassachusettsOriginalDirectory, dirs: MassachusettsOriginalDirectory[]): Promise<MassachusettsReportedPacket> {
  const closed = d.records.find(r => r.role === "registry_closing");
  if (!closed || d.records.at(-1)?.role !== "registry_closing") maHold("incomplete_ie_graph");
  const registry = validRegistry(await unchanged(d, "registry")), reports: MassachusettsReportedPacket["reports"] = [];
  const selected: Leaf[] = [], leaves = await reportLeaves(dirs, closed.completedAt);
  for (const year of years()) {
    const heads = maArray(await unchanged(d, `iepac_${year}`)), ordinary = maArray(await unchanged(d, `ordinary_${year}`));
    maUniqueReports(heads); maUniqueReports(ordinary);
    if (heads.length >= 1000 || ordinary.length >= 1000 ||
      (await unchanged(d, `iepac_controls_${year}`)).count !== heads.length ||
      (await unchanged(d, `ordinary_controls_${year}`)).count !== ordinary.length) maHold("inventory_count_or_limit");
    const owners = [...new Set<number>(heads.map(r => maId(r.cpfId)))].sort((a, b) => a - b), current: any[] = [];
    for (const [i, owner] of owners.entries()) {
      nativeBaseType(await d.json(`types_${year}_${i}`));
      const rows = maReportItems(await unchanged(d, `current_${year}_${i}`));
      for (const v of rows) {
        maCurrentReport(v, true, year);
        if (v.cpfId !== owner) maHold("current_report_owner");
      }
      current.push(...rows);
    }
    maSameReportSet(current, heads);
    for (const [iepac, rows] of [[true, current], [false, ordinary]] as const) for (const header of rows) {
      maCurrentReport(header, iepac, year);
      const leaf = chooseLeaf(leaves, header, iepac, closed.completedAt, false);
      if (!leaf) maHold("financial_report_body_missing");
      maArray(leaf.value.expenditures);
      selected.push(leaf); reports.push({ iepac, value: leaf.value });
    }
  }
  if (!reports.length) maHold("ie_inventory_empty");
  const bodyClocks = selected.map(l => l.meta.completedAt).sort();
  const p: MassachusettsReportedPacket = { kind: "ie", sourceAt: closed.completedAt,
    sourceHash: maHash(maCanonical([d.records.map(r => r.sha256), selected.map(l => l.meta.sha256)])),
    acquisitionStartedAt: [d.records[0]!.startedAt, ...selected.map(l => l.meta.startedAt)].sort()[0]!,
    oldestBodyAt: bodyClocks[0]!, newestBodyAt: bodyClocks.at(-1)!, registry, reports,
    sourceRows: reports.reduce((s, r) => s + r.value.expenditures.length, 0), reportCount: reports.length };
  packets.add(p); maFreeze(p); return p;
}
async function acquireIe(cache: string): Promise<void> {
  const dirs = await directories(cache), leaves = await reportLeaves(dirs, new Date().toISOString());
  const { capture } = await createMassachusettsOriginalCapture(cache, "ie");
  await capture("registry_opening", "/filers/listings/A");
  const closings: { role: string; path: string }[] = [];
  let ordinal = 0;
  for (const year of years()) {
    const opening: Record<string, any> = {};
    for (const [key, path] of Object.entries(paths(year))) {
      opening[key] = (await capture(`${key}_${year}_opening`, path)).value;
      closings.push({ role: `${key}_${year}_closing`, path });
    }
    const heads = maArray(opening.iepac), ordinary = maArray(opening.ordinary), current: any[] = [];
    maUniqueReports(heads); maUniqueReports(ordinary);
    if (heads.length >= 1000 || ordinary.length >= 1000) maHold("inventory_limit");
    const owners = [...new Set<number>(heads.map(r => maId(r.cpfId)))].sort((a, b) => a - b);
    for (const [i, owner] of owners.entries()) {
      const types = await capture(`types_${year}_${i}`, `/reports/baseReportTypes/${owner}`), type = nativeBaseType(types.value);
      const path = reportListUrl(owner, type, year), role = `current_${year}_${i}`;
      current.push(...maReportItems((await capture(role + "_opening", path)).value));
      closings.push({ role: role + "_closing", path });
    }
    maSameReportSet(current, heads);
    for (const [iepac, rows] of [[true, current], [false, ordinary]] as const) for (const header of rows) {
      maCurrentReport(header, iepac, year);
      if (!chooseLeaf(leaves, header, iepac, new Date().toISOString(), true)) {
        const leaf = await capture(`${iepac ? "iepac" : "ordinary"}_leaf_${++ordinal}`, `/${iepac ? "report" : "miscreport"}/${maId(header.reportId)}`);
        if (!maSameHeader(leaf.value, header, iepac)) maHold("new_report_header_changed");
      }
    }
  }
  // Final witnesses occur after every reused or newly fetched body.
  for (const c of closings) await capture(c.role, c.path);
  await capture("registry_closing", "/filers/listings/A");
}
export async function loadMassachusettsReportedPacket(kind: MassachusettsReportedKind, options: {
  cacheDir?: string; refresh?: boolean; onRefreshError?: () => void;
} = {}): Promise<MassachusettsReportedPacket> {
  const cache = maReportedCache(options.cacheDir);
  let dirs = await directories(cache), saved: MassachusettsReportedPacket | undefined;
  async function latest() {
    const candidates = dirs.filter(d => d.directory.split("/").at(-1)!.startsWith("ie-originals-")).sort((a, b) => b.records.at(-1)!.completedAt.localeCompare(a.records.at(-1)!.completedAt));
    for (const d of candidates) try { return await replayIe(d, dirs); } catch { /* Retain older closed source. */ }
    return undefined;
  }
  if (kind === "ie") {
    saved = await latest();
    if (isMassachusettsReportedRawRefreshEnabled() && (options.refresh || !saved || Date.now() - Date.parse(saved.sourceAt) > 7 * 86400000)) {
      try { await acquireIe(cache); dirs = await directories(cache); const fresh = await latest(); if (!fresh || (saved && fresh.sourceAt <= saved.sourceAt)) maHold("refresh_not_closed"); saved = fresh; }
      catch { options.onRefreshError?.(); }
    }
    if (!saved) maHold("ie_source_unavailable");
    return saved;
  }
  // Committee acquisition has per-receiver full-ledger closure; it must not
  // depend on the IE graph or legacy direct-finance summary.
  const contexts = dirs.filter(d => d.directory.includes("/profile-originals-") && d.records.at(-1)?.role === "registry_closing");
  const latestContext = contexts.map(d => d.records.at(-1)!.completedAt).sort().at(-1);
  if (isMassachusettsReportedRawRefreshEnabled() && (options.refresh || !latestContext || Date.now() - Date.parse(latestContext) > 7 * 86400000)) {
    try { const c = await createMassachusettsOriginalCapture(cache, "profile"); await c.capture("registry_opening", "/filers/listings/A"); await c.capture("registry_closing", "/filers/listings/A"); dirs = await directories(cache); }
    catch { options.onRefreshError?.(); }
  }
  for (const d of dirs.filter(d => d.directory.includes("/profile-originals-")).sort((a,b) => b.records.at(-1)!.completedAt.localeCompare(a.records.at(-1)!.completedAt))) {
    try {
      const registry = validRegistry(await unchanged(d, "registry")), last = d.records.at(-1)!;
      if (last.role !== "registry_closing") continue;
      const p: MassachusettsReportedPacket = { kind, registry, reports: [], sourceAt: last.completedAt,
        acquisitionStartedAt: d.records[0]!.startedAt, oldestBodyAt: last.completedAt, newestBodyAt: last.completedAt,
        sourceHash: maHash(maCanonical(d.records.map(r => r.sha256))), sourceRows: 0, reportCount: 0 };
      packets.add(p); maFreeze(p); return p;
    } catch { /* No zero from a failed context. */ }
  }
  return maHold("committee_context_unavailable");
}

function receiptUrl(cpf: string, offset: number): string {
  const q = new URLSearchParams({ cpfId: cpf, startDate: "1/1/2026", endDate: "12/31/2026", pageSize: String(pageSize), currentIndex: String(offset), withSummary: "true", searchTypeCategory: "A" });
  return `/search/items?${q}`;
}
export async function loadMassachusettsReceiverPacket(receiver: MassachusettsReportedReceiver, packet: MassachusettsReportedPacket, options: {
  cacheDir?: string; refresh?: boolean;
} = {}): Promise<MassachusettsReceiverPacket> {
  if (!isMassachusettsReportedPacket(packet)) maHold("unverified_source");
  const cache = maReportedCache(options.cacheDir), prefix = packet.kind === "ie" ? "profile" : "receipt";
  async function replay(d: MassachusettsOriginalDirectory): Promise<MassachusettsReceiverPacket> {
    const profile = await unchanged(d, "profile"), first = d.records[0]!, last = d.records.at(-1)!;
    if (last.role !== "profile_closing") maHold("receiver_graph_incomplete");
    validateMassachusettsReportedReceiver(receiver, packet.registry, profile);
    let rows: any[] = [];
    if (packet.kind === "committee") {
      const sweeps: any[][] = [];
      for (const phase of ["opening", "closing"]) {
        const pages = [];
        for (let i = 0; i < 200; i++) {
          const role = `receipts_${phase}_${i}`;
          if (!d.records.some(r => r.role === role)) break;
          pages.push(await d.json(role));
        }
        sweeps.push(maReceiptSweep(pages));
      }
      maSameReceiptSweeps(sweeps[0]!, sweeps[1]!); rows = sweeps[1]!;
      if (rows.some(r => String(r.filerCpfId) !== receiver.entityId)) maHold("receipt_receiver");
    }
    const s: MassachusettsReceiverPacket = { packet, receiver: { ...receiver }, rows, sourceAt: packet.kind === "ie" ? packet.sourceAt : last.completedAt,
      sourceHash: maHash(packet.sourceHash + maCanonical(d.records.map(r => r.sha256))), profileAt: last.completedAt,
      profileStartedAt: first.startedAt, profileHash: maHash(maCanonical([first.sha256, last.sha256])) };
    receivers.add(s); maFreeze(s); return s;
  }
  const ds = (await directories(cache)).filter(d => d.directory.includes(`/${prefix}-originals-`)).sort((a,b) => b.records.at(-1)!.completedAt.localeCompare(a.records.at(-1)!.completedAt));
  let saved: MassachusettsReceiverPacket | undefined;
  for (const d of ds) try { saved = await replay(d); break; } catch { /* A different receiver or incomplete acquisition. */ }
  if (isMassachusettsReportedRawRefreshEnabled() && (options.refresh || !saved || Date.now() - Date.parse(saved.profileAt) > 7 * 86400000)) {
    try {
      const c = await createMassachusettsOriginalCapture(cache, prefix);
      await c.capture("profile_opening", `/filer/${maId(Number(receiver.entityId))}`);
      if (packet.kind === "committee") for (const phase of ["opening", "closing"]) {
        let count = 1;
        for (let i = 0; i * pageSize < count && i < 200; i++) {
          const page = await c.capture(`receipts_${phase}_${i}`, receiptUrl(receiver.entityId, 1 + i * pageSize));
          count = page.value?.summary?.count;
          if (!Number.isSafeInteger(count) || count < 1 || count > 100000) maHold("receipt_controls");
        }
      }
      await c.capture("profile_closing", `/filer/${receiver.entityId}`);
      saved = await replay(await readMassachusettsOriginalDirectory(c.directory));
    } catch { /* Preserve a previously qualified component, with its real clocks. */ }
  }
  if (!saved) maHold("receiving_source_unavailable");
  return saved;
}
