import {
  buildFloridaCommitteeDonorPrefixes,
  decodeFloridaCommitteeDetail,
  decodeFloridaCommitteeNameSearch,
  fingerprintFloridaCommitteeDetailSemantics,
  type FloridaCommitteeDetail,
  type FloridaCommitteeNameRow,
  type FloridaCommitteeRegistryRequest,
} from "./floridaCommitteeRegistrySource.js";
import { parseFloridaExplicitIePurpose } from "./floridaExplicitIndependentExpenditure.js";
import type { FloridaExpenditureDiscoveryRow } from "./floridaIndependentExpenditureDiscovery.js";
import type { FloridaLocalFinanceContext } from "./floridaLocalFinanceContext.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";

const exact = (value: string) => value.trim().replace(/\s+/gu, " ").toUpperCase();
const SEARCH = "https://dos.elections.myflorida.com/committees/ComLkupByName.asp";
type Metadata = Omit<FloridaProcessedRawEvidence, "bytesRaw"> & { byteCount: number };
export type FloridaOutsidePayerResult =
  | { status: "resolved"; authority: "payer_identity_only"; owner: FloridaCommitteeDetail;
      payerType: "PAC" | "IXO"; payerLabel: string; sourceMetadata: readonly Metadata[];
      rawSource: readonly FloridaProcessedRawEvidence[] }
  | { status: "preserve"; diagnostics: readonly string[] };

/** Discovery leads retain occurrences. Name/office/seat matching supplies no
 * source election, current-report, allocation, completeness or zero authority. */
export function selectFloridaOutsidePayerLeads(input: {
  rows: readonly FloridaExpenditureDiscoveryRow[];
  localContext: FloridaLocalFinanceContext;
}): FloridaExpenditureDiscoveryRow[] {
  const context = input.localContext;
  if (!context.candidateId || !context.electionId || !context.candidateName?.trim() ||
    context.electionYear !== 2026 || context.electionDate !== "2026-11-03" ||
    context.officeScope !== "state_lower" || context.officeCanonicalName !== "State Lower Chamber Legislator" ||
    !/^(?:[1-9]\d?|1[01]\d|120)$/.test(context.district ?? "")) return [];
  return input.rows.filter(row => {
    if (row.sourceType !== "IEC" || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) return false;
    const result = parseFloridaExplicitIePurpose(row.purpose);
    return result.status === "parsed" && result.target.officeScope === context.officeScope &&
      result.target.officeName === context.officeCanonicalName && result.target.district === context.district &&
      exact(result.target.candidateName) === exact(context.candidateName);
  }).map(row => structuredClone(row));
}

function union(sets: readonly (readonly FloridaCommitteeNameRow[])[]): FloridaCommitteeNameRow[] {
  const rows = new Map<string, FloridaCommitteeNameRow>();
  for (const set of sets) for (const row of set) {
    const old = rows.get(row.committeeId);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) throw new Error("conflicting overlapping payer identities");
    rows.set(row.committeeId, row);
  }
  return [...rows.values()].sort((a, b) => a.committeeId.localeCompare(b.committeeId));
}
const multiset = (rows: readonly FloridaCommitteeNameRow[]) => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());

/** All-type/status registry scope is acquired before exact full annotation
 * selection. Current Active status and vendor addresses never choose an owner.
 * Same-annotation numeric-account collisions preserve rather than guess.
 */
export function createFloridaOutsidePayerSource(options: {
  request: (request: FloridaCommitteeRegistryRequest, options?: { savedFirst?: boolean }) => Promise<FloridaProcessedRawEvidence>;
  refresh?: boolean;
}) {
  return {
    async load(input: { payerLabel: string }): Promise<FloridaOutsidePayerResult> {
      const payerLabel = input.payerLabel;
      try {
        if (typeof payerLabel !== "string" || payerLabel.length > 300 || /[\x00-\x1f\x7f]/.test(payerLabel))
          throw new Error("invalid full payer label");
        const label = /^(.+) \((PAC|IXO)\)$/i.exec(payerLabel.trim().replace(/\s+/gu, " "));
        if (!label) throw new Error("unsupported exact payer annotation");
        const name = label[1]!, payerType = label[2]!.toUpperCase() as "PAC" | "IXO";
        const prefixes = buildFloridaCommitteeDonorPrefixes(name);
        const metadata: Metadata[] = [];
        const rawSource: FloridaProcessedRawEvidence[] = [];
        let openingEnd = 0;
        async function request(req: FloridaCommitteeRegistryRequest, closing: boolean) {
          const raw = structuredClone(await options.request(req, { savedFirst: !closing && !options.refresh }));
          // Decoders below bind the request, bytes, hash, status and capture interval.
          if (closing && Date.parse(raw.startedAt) < openingEnd) throw new Error("payer closing predates opening");
          if (!closing) openingEnd = Math.max(openingEnd, Date.parse(raw.completedAt));
          const { bytesRaw, ...source } = raw;
          metadata.push({ ...source, byteCount: bytesRaw.length });
          rawSource.push(structuredClone(raw));
          return raw;
        }
        async function search(prefix: string, closing: boolean) {
          return decodeFloridaCommitteeNameSearch(await request({ url: SEARCH, method: "POST",
            financeFields: { searchtype: "1", comName: prefix, LkupTypeName: "L", NameSearchBtn: "Search by Name" },
            phase: closing ? "closing" : "opening" }, closing), { prefix });
        }
        const opening: (readonly FloridaCommitteeNameRow[])[] = [];
        for (const prefix of prefixes) opening.push(await search(prefix, false));
        const discovered = union(opening).filter(row => exact(row.committeeName) === exact(name));
        const owners = new Map<string, FloridaCommitteeDetail>();
        for (const row of discovered) {
          const owner = decodeFloridaCommitteeDetail(await request({ url: row.sourceUrl, method: "GET",
            financeFields: null, phase: "opening" }, false), { committeeId: row.committeeId });
          if (exact(owner.committeeName) !== exact(row.committeeName) || owner.committeeType !== row.committeeType ||
            owner.status !== row.status) throw new Error("payer search/detail identity mismatch");
          owners.set(row.committeeId, owner);
        }
        for (const row of discovered) {
          const owner = decodeFloridaCommitteeDetail(await request({ url: row.sourceUrl, method: "GET",
            financeFields: null, phase: "closing" }, true), { committeeId: row.committeeId });
          if (fingerprintFloridaCommitteeDetailSemantics(owner) !==
            fingerprintFloridaCommitteeDetailSemantics(owners.get(row.committeeId)!)) throw new Error("changed full payer detail");
        }
        const closing: (readonly FloridaCommitteeNameRow[])[] = [];
        for (const prefix of prefixes) closing.push(await search(prefix, true));
        union(closing);
        if (opening.some((rows, index) => multiset(rows) !== multiset(closing[index]!))) throw new Error("changed all-status payer query");
        const matches = [...owners.values()].filter(owner =>
          exact(`${owner.committeeName} (${owner.committeeType})`) === exact(payerLabel));
        if (matches.length !== 1) throw new Error("full annotated payer account is absent or ambiguous");
        return { status: "resolved", authority: "payer_identity_only", owner: matches[0]!, payerType,
          payerLabel, sourceMetadata: metadata, rawSource };
      } catch (error) {
        return { status: "preserve", diagnostics: [error instanceof Error ? error.message : "Payer identity unavailable."] };
      }
    },
  };
}

/** Replays genuine captured registry evidence through the acquisition checks.
 * This is validation of original source times, not a fresh fetch. No arbitrary
 * resolved object can supply payer uniqueness to an atomic writer.
 */
export async function verifyFloridaOutsidePayerIdentity(input: {
  payerLabel: string;
  rawSource: readonly FloridaProcessedRawEvidence[];
}): Promise<FloridaOutsidePayerResult> {
  try {
    input = structuredClone(input);
    if (!Array.isArray(input.rawSource) || input.rawSource.length > 164)
      throw new Error("invalid bounded payer source packet");
    let index = 0;
    const result = await createFloridaOutsidePayerSource({ request: async expected => {
      const raw = input.rawSource[index++];
      const fields = (value: Readonly<Record<string, string>> | null) => JSON.stringify(value && Object.entries(value).sort());
      if (!raw || raw.url !== expected.url || raw.method !== expected.method ||
        fields(raw.financeFields) !== fields(expected.financeFields)) throw new Error("payer source packet request order/scope mismatch");
      return raw;
    } }).load({ payerLabel: input.payerLabel });
    if (index !== input.rawSource.length) throw new Error("extra unused payer source evidence");
    return result;
  } catch (error) {
    return { status: "preserve", diagnostics: [error instanceof Error ? error.message : "Payer source replay failed."] };
  }
}
