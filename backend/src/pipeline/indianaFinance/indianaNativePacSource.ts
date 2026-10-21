import { isIndianaNativePacRawRefreshEnabled } from "../../config/featureFlags.js";
import { IndianaNativePacCollector } from "./indianaNativePacCollector.js";
import { basename } from "node:path";
import {
  inAdd,
  inCheck,
  inKey,
  inPublicUrl,
  type IndianaNativePacGift,
} from "./indianaNativeProtocol.js";
import {
  IndianaNativeOriginalArchive,
  inHash,
  type IndianaNativeOriginalMeta,
} from "./indianaNativeOriginals.js";
import { readIndianaNativeFinancialEvidence } from "./indianaNativeFinancialEvidence.js";
import type { IndianaNativeReceiver } from "./indianaNativeReceiver.js";

export const IN_NATIVE_PAC_REVISION = "in-native-pac-v1";
export type IndianaNativePacGroup = {
  key: string;
  name: string;
  cashCents: number;
  inKindCents: number;
  occurrences: number;
};
export type IndianaNativePacControls = {
  cashCents: number;
  inKindCents: number;
  totalCents: number;
  occurrences: number;
  allRows: number;
  pacRows: number;
  excludedNonGiftRows: number;
  regularReports: number;
  coveredSupplements: number;
};
export type IndianaNativePacObservation = {
  directory: string;
  meta: IndianaNativeOriginalMeta;
};
export type IndianaNativePacFacts = {
  revision: string;
  from: string;
  through: string;
  regularThrough: string;
  observedAt: string;
  completedAt: string;
  manifestSha256: string;
  observations: IndianaNativePacObservation[];
};
export type IndianaNativePacPacket = {
  receiver: IndianaNativeReceiver;
  groups: IndianaNativePacGroup[];
  controls: IndianaNativePacControls;
  facts: IndianaNativePacFacts;
};
const verified = new WeakSet<object>();
export const isVerifiedIndianaNativePacPacket = (p: IndianaNativePacPacket) =>
  verified.has(p);
export const inPacManifestHash = (
  observations: readonly IndianaNativePacObservation[],
) =>
  inHash(
    JSON.stringify(
      observations.map((o) => [
        o.directory,
        Object.fromEntries(
          Object.entries(o.meta).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
    ),
  );
const freeze = <T>(o: T): T => {
  if (o && typeof o === "object") {
    Object.values(o).forEach(freeze);
    Object.freeze(o);
  }
  return o;
};
export function aggregateIndianaNativePacGifts(
  gifts: readonly IndianaNativePacGift[],
): IndianaNativePacGroup[] {
  const groups = new Map<string, IndianaNativePacGroup>();
  for (const r of gifts) {
    const key = inKey(r.name);
    inCheck(
      key &&
        key.length <= 4000 &&
        r.name.length <= 4000 &&
        r.donorClass === "Political Action Committee" &&
        ["Direct", "In-Kind"].includes(r.kind),
      "invalid_native_pac_gift",
    );
    const g = groups.get(key) ?? {
      key,
      name: r.name,
      cashCents: 0,
      inKindCents: 0,
      occurrences: 0,
    };
    if (r.kind === "Direct") g.cashCents = inAdd(g.cashCents, r.cents);
    else g.inKindCents = inAdd(g.inKindCents, r.cents);
    g.occurrences = inAdd(g.occurrences, 1);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export function validateIndianaNativePacClosure(
  controls: IndianaNativePacControls,
  groups: readonly IndianaNativePacGroup[],
): void {
  const keys = [
    "cashCents",
    "inKindCents",
    "totalCents",
    "occurrences",
    "allRows",
    "pacRows",
    "excludedNonGiftRows",
    "regularReports",
    "coveredSupplements",
  ];
  inCheck(
    controls &&
      Object.keys(controls).sort().join("|") === keys.sort().join("|") &&
      Object.entries(controls).every(
        ([key, n]) =>
          Number.isSafeInteger(n) && (key.endsWith("Cents") || n >= 0),
      ),
    "invalid_native_pac_controls",
  );
  let cash = 0,
    inKind = 0,
    count = 0;
  const seen = new Set<string>();
  for (const g of groups) {
    inCheck(
      g &&
        typeof g.name === "string" &&
        g.name.length > 0 &&
        g.name.length <= 4000 &&
        g.key === inKey(g.name) &&
        !seen.has(g.key) &&
        Number.isSafeInteger(g.cashCents) &&
        Number.isSafeInteger(g.inKindCents) &&
        Number.isSafeInteger(g.occurrences) &&
        g.occurrences > 0,
      "invalid_native_pac_group",
    );
    seen.add(g.key);
    cash = inAdd(cash, g.cashCents);
    inKind = inAdd(inKind, g.inKindCents);
    count = inAdd(count, g.occurrences);
  }
  inCheck(
    cash === controls.cashCents &&
      inKind === controls.inKindCents &&
      inAdd(cash, inKind) === controls.totalCents &&
      count === controls.occurrences &&
      inAdd(count, controls.excludedNonGiftRows) === controls.pacRows &&
      controls.allRows >= controls.pacRows &&
      controls.regularReports > 0,
    "native_pac_full_group_closure",
  );
}
export function validateIndianaNativePacFacts(f: IndianaNativePacFacts): void {
  const iso = (v: string) =>
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  inCheck(
    f?.revision === IN_NATIVE_PAC_REVISION &&
      /^\d{4}-\d{2}-\d{2}$/.test(f.from) &&
      /^\d{4}-\d{2}-\d{2}$/.test(f.through) &&
      /^\d{4}-\d{2}-\d{2}$/.test(f.regularThrough) &&
      f.from <= f.regularThrough &&
      f.regularThrough <= f.through &&
      iso(f.observedAt) &&
      iso(f.completedAt) &&
      f.observedAt <= f.completedAt &&
      Date.parse(f.completedAt) <= Date.now() &&
      Array.isArray(f.observations) &&
      f.observations.length > 0,
    "invalid_native_pac_facts",
  );
  for (const o of f.observations) {
    const m = o.meta;
    inCheck(
      /^source-originals-[a-f0-9-]{36}$/.test(o.directory) &&
        m &&
        /^[0-9]{4,6}\.original$/.test(m.file) &&
        /^[a-f0-9]{64}$/.test(m.sha256) &&
        m.eof &&
        [200, 301, 302, 303, 307, 308].includes(m.status) &&
        iso(m.startedAt) &&
        iso(m.completedAt) &&
        m.startedAt >= f.observedAt &&
        m.completedAt <= f.completedAt &&
        m.startedAt <= m.completedAt,
      "invalid_native_pac_observation",
    );
    inPublicUrl(m.url, m.url);
  }
  inCheck(
    f.manifestSha256 === inPacManifestHash(f.observations),
    "native_pac_manifest_conflict",
  );
}
/** Only this complete source path brands packets eligible for the protected
 * writer. Receipt primitives or edited JSON controls do not grant admission. */
export class IndianaNativePacSource {
  constructor(private readonly archive = new IndianaNativeOriginalArchive()) {}
  async get(
    receiver: IndianaNativeReceiver,
    through: string,
  ): Promise<IndianaNativePacPacket> {
    const originals = await this.archive.read();
    try {
      return this.qualify(originals, receiver, through);
    } catch (error) {
      if (!isIndianaNativePacRawRefreshEnabled()) throw error;
      await new IndianaNativePacCollector(this.archive).collect(
        receiver,
        through,
      );
      return this.qualify(await this.archive.read(), receiver, through);
    }
  }
  private qualify(
    originals: Awaited<ReturnType<IndianaNativeOriginalArchive["read"]>>,
    receiver: IndianaNativeReceiver,
    through: string,
  ): IndianaNativePacPacket {
    const evidence = readIndianaNativeFinancialEvidence(
        originals,
        receiver,
        through,
      ),
      gifts = evidence.receipts.periods.flatMap((p) => p.gifts),
      groups = aggregateIndianaNativePacGifts(gifts);
    const cashCents = evidence.receipts.periods.reduce(
        (n, p) => inAdd(n, p.cashCents),
        0,
      ),
      inKindCents = evidence.receipts.periods.reduce(
        (n, p) => inAdd(n, p.inKindCents),
        0,
      );
    const controls: IndianaNativePacControls = {
      cashCents,
      inKindCents,
      totalCents: inAdd(cashCents, inKindCents),
      occurrences: gifts.length,
      allRows: evidence.receipts.periods.reduce(
        (n, p) => inAdd(n, p.all.length),
        0,
      ),
      pacRows: evidence.receipts.periods.reduce(
        (n, p) => inAdd(n, p.pac.length),
        0,
      ),
      excludedNonGiftRows: evidence.receipts.periods.reduce(
        (n, p) => inAdd(n, p.excludedNonGiftRows),
        0,
      ),
      regularReports: evidence.reports.length,
      coveredSupplements: evidence.supplements.length,
    };
    const observations = evidence.originals.map((o) => ({
      directory: basename(o.directory),
      meta: structuredClone(o.meta),
    }));
    const facts: IndianaNativePacFacts = {
      revision: IN_NATIVE_PAC_REVISION,
      from: `${receiver.electionYear - 1}-01-01`,
      through,
      regularThrough: evidence.reports
        .map((r) => r.period.end)
        .sort()
        .at(-1)!,
      observedAt: observations.map((o) => o.meta.startedAt).sort()[0]!,
      completedAt: observations
        .map((o) => o.meta.completedAt)
        .sort()
        .at(-1)!,
      manifestSha256: inPacManifestHash(observations),
      observations,
    };
    validateIndianaNativePacClosure(controls, groups);
    validateIndianaNativePacFacts(facts);
    const packet = freeze({
      receiver: structuredClone(receiver),
      groups,
      controls,
      facts,
    });
    verified.add(packet);
    return packet;
  }
}
