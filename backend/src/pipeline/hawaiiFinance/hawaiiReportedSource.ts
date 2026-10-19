import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isHawaiiReportedRawRefreshEnabled } from "../../config/featureFlags.js";
import { hiAdd, hiCents as hiSourceCents, hiFreeze, hiHash, hiHold, HawaiiReportedHold, type HawaiiReportedKind } from "./hawaiiReportedCore.js";
import { createHawaiiOriginalGraph, isHawaiiOriginalGraph, listHawaiiOriginalDirectories, readHawaiiOriginalGraph, type HawaiiOriginalGraph } from "./hawaiiReportedOriginals.js";
import { readHawaiiNativeFiler, readHawaiiRegistry, readHawaiiRoster, readHawaiiSoda } from "./hawaiiReportedProtocol.js";
import type { HawaiiNativeRegistryRow } from "./hawaiiReportedNative.js";
import type { HawaiiPublishedRow } from "./hawaiiReportedCommitteeAggregator.js";
import type { HawaiiIeParentControl } from "./hawaiiReportedIeAggregator.js";
import type { HawaiiOfficialCandidate } from "./hawaiiReportedIdentity.js";
export type HawaiiReportedPacket = Readonly<{
  kind: HawaiiReportedKind; sourceAt: string; capturedAt: string; acquisitionStartedAt: string; sourceHash: string;
  publisherUpdatedAt: string; roster: readonly HawaiiOfficialCandidate[]; rows: readonly HawaiiPublishedRow[];
  senderRows: readonly HawaiiPublishedRow[]; registry: readonly HawaiiNativeRegistryRow[]; candidateRegistry: readonly HawaiiNativeRegistryRow[];
  parentControls: readonly HawaiiIeParentControl[]; nativeVersions: number; supersededVersions: number;
}>;
const packets = new WeakSet<object>();
export const isHawaiiReportedPacket = (v: unknown): v is HawaiiReportedPacket => !!v && typeof v === "object" && packets.has(v);
export const hawaiiReportedCacheRoot = (cache?: string): string => resolve(cache ?? process.env.HAWAII_REPORTED_FINANCE_CACHE_DIR ?? "scratch/hawaii-reported-finance");
export function hiGraphFacts(graph: HawaiiOriginalGraph) {
  if (!graph.records.length) hiHold("empty_source_graph");
  return { sourceAt: graph.records[0]!.completedAt, acquisitionStartedAt: graph.records[0]!.startedAt,
    capturedAt: graph.records.at(-1)!.completedAt, sourceHash: hiHash(graph.records.map(r => r.sha256).join("\n")) };
}
export async function qualifyHawaiiReportedGraph(graph: HawaiiOriginalGraph, kind: HawaiiReportedKind): Promise<HawaiiReportedPacket> {
  if (!isHawaiiOriginalGraph(graph)) hiHold("unverified_original_graph");
  let reads = 0;
  const read: HawaiiOriginalGraph["read"] = async (...args) => { reads++; return graph.read(...args); };
  const data = await readHawaiiSoda(read, kind + "_soda", kind === "ie" ? "riiu-7d4b" : "jexd-xbcg",
    kind === "ie" ? "election_period = '2024-2026'" : "election_period in('2022-2026','2024-2026')");
  const roster = await readHawaiiRoster(read), registry = await readHawaiiRegistry(read, true);
  let senderRows: HawaiiPublishedRow[] = [], candidateRegistry: HawaiiNativeRegistryRow[] = [], nativeVersions = 0, supersededVersions = 0;
  const parentControls: HawaiiIeParentControl[] = [];
  if (kind === "committee") {
    const senders = await readHawaiiSoda(read, "sender_soda", "6huc-dcuw", "election_period in('2022-2024','2024-2026')");
    senderRows = senders.rows; candidateRegistry = await readHawaiiRegistry(read, false);
  } else {
    const parents = [...new Set(data.rows.filter(r => r.independent_expenditure === "Y").map(r => r.reg_no))];
    if (!parents.length || parents.length > 100) hiHold("ie_parent_population");
    for (const [index, registration] of parents.entries()) {
      if (typeof registration !== "string" || !registration) hiHold("spender_registration");
      const own = data.rows.filter(r => r.reg_no === registration), names = new Set(own.map(r => r.noncandidate_committee_name));
      if (names.size !== 1 || typeof own[0]?.noncandidate_committee_name !== "string") hiHold("spender_identity_changed");
      const name = own[0].noncandidate_committee_name;
      const control = await readHawaiiNativeFiler(read, { prefix: `ie_parent_${index}`, noncandidate: true, registry, name,
        electionPeriod: "2024-2026", asOfDay: new Date().toISOString().slice(0, 10) });
      const sum = own.reduce((n, r) => hiAdd(n, hiSourceCents(r.amount)), 0);
      if (control.cents !== sum) hiHold("ie_parent_control");
      parentControls.push({ registration, name, rows: own.length, cents: sum });
      nativeVersions += control.sourceVersions; supersededVersions += control.supersededVersions;
    }
  }
  if (reads !== graph.records.length) hiHold("source_graph_unconsumed");
  const packet: HawaiiReportedPacket = { kind, ...hiGraphFacts(graph), publisherUpdatedAt: data.publisherUpdatedAt,
    roster, rows: data.rows, registry, candidateRegistry, senderRows, parentControls, nativeVersions, supersededVersions };
  hiFreeze(packet); packets.add(packet); return packet;
}

/** Last qualified originals first. A failed refresh cannot retime saved bytes,
 * replace a complete packet with partial data, or authorize a successful zero. */
export async function loadHawaiiReportedPacket(kind: HawaiiReportedKind, options: {
  cacheDir?: string; refresh?: boolean; onRefreshError?: (code: string) => void;
} = {}): Promise<HawaiiReportedPacket | null> {
  const cache = hawaiiReportedCacheRoot(options.cacheDir); await mkdir(cache, { recursive: true, mode: 0o700 });
  let saved: HawaiiReportedPacket | null = null;
  for (const directory of await listHawaiiOriginalDirectories(cache)) {
    try {
      const g = await readHawaiiOriginalGraph(directory);
      if (g.records[0]?.role !== kind + "_soda_metadata_opening") continue;
      saved = await qualifyHawaiiReportedGraph(g, kind); break;
    } catch { /* incomplete/failed graphs never authorize money */ }
  }
  if ((!saved || options.refresh || Date.now() - Date.parse(saved.capturedAt) >= 86400000) && isHawaiiReportedRawRefreshEnabled()) {
    try { return await qualifyHawaiiReportedGraph(await createHawaiiOriginalGraph(cache), kind); }
    catch (e) { options.onRefreshError?.(e instanceof HawaiiReportedHold ? e.code : "source_unavailable"); }
  }
  return saved;
}
