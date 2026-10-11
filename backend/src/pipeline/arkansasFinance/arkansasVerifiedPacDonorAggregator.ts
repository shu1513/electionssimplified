import type { ArkansasFinanceLinkInput } from "./arkansasFinanceWriter.js";
import type { ArkansasVerifiedCurrentCashProof } from "./arkansasCurrentOriginalFinancialSource.js";
import {
  fingerprintArkansasVerifiedRawRows,
  type ArkansasVerifiedCollection,
  type ArkansasVerifiedRegistryRow,
} from "./arkansasVerifiedSourceClient.js";
import {
  addArkansasPacCents, arkansasExactOwnerNameEquivalent, arkansasPacReceivingSourceUrl, assertArkansasPacPriorAuthorityRetained,
  isArkansasTypedPacCash, normalizeArkansasReportedPacName, validateArkansasPacSnapshot,
  type ArkansasFinancePacDonor, type ArkansasPacSourceGroup, type ArkansasPacSourceProvenance,
} from "./arkansasPacSourceEvidence.js";

export type ArkansasVerifiedPacDonorInput = {
  link: ArkansasFinanceLinkInput;
  financialEvidence: ArkansasVerifiedCurrentCashProof;
  registryBefore: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  registryAfter: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  priorPacSourceProvenance?: unknown;
};
export type ArkansasVerifiedPacDonorResult = {
  pacDonors?: readonly ArkansasFinancePacDonor[];
  pacSourceProvenance?: ArkansasPacSourceProvenance;
  diagnostics: readonly string[];
};
function fail(message: string): never { throw new Error("Arkansas PAC registry: " + message); }
function nullable(v: unknown): unknown { return typeof v === "string" && !v.trim() ? null : v; }
export function validateArkansasVerifiedFullRegistry(c: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>): void {
  if (c.complete !== true || !c.rows.length || c.totalItems !== c.rows.length ||
    c.fingerprint !== fingerprintArkansasVerifiedRawRows(c.rows)) fail("incomplete or fingerprint-mismatched full registry");
  const pages = Math.ceil(c.totalItems / 1000);
  if (c.requests.length !== pages) fail("incomplete full-registry requests");
  for (const [index, r] of c.requests.entries()) {
    if (r.url !== "https://api-ethics-disclosures.sos.arkansas.gov/api/PublicFilerDetails/GetCandidateCommitteDetails" ||
      r.method !== "POST" || r.status !== 200 || !Number.isSafeInteger(r.bytes) || r.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(r.sha256) || r.requestBody.pageNumber !== index + 1 ||
      r.requestBody.pageSize !== 1000 || Object.keys(r.requestBody).sort().join(",") !== "pageNumber,pageSize") fail("filtered/incomplete registry request scope");
  }
  const ids = new Set<string>();
  for (const row of c.rows) {
    if (!Number.isSafeInteger(row.filerEntityId) || row.filerEntityId < 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.registrationGuid) ||
      ids.has(row.registrationGuid) || typeof row.filerTypeCode !== "string" || !row.filerTypeCode ||
      typeof row.filerType !== "string" || !row.filerType ||
      typeof row.filerStatus !== "string" || !row.filerStatus ||
      ![true, false, null].includes(row.isPaperFiler)) fail("invalid registry identity");
    ids.add(row.registrationGuid);
    const raw = row.rawFields;
    // Typed projection must remain tied to the full raw source identity fingerprint.
    for (const [typed, source] of [
      ["registrationGuid", "guid"], ["filerEntityId", "filerEntityID"],
      ["filerTypeCode", "filerTypeCode"], ["filerType", "filerType"],
      ["filerStatus", "filerStatus"], ["committeeName", "committeeName"],
      ["filerName", "filerName"], ["isPaperFiler", "isPaperFiler"],
    ] as const) {
      const expected = source === "guid" && typeof raw[source] === "string" ? String(raw[source]).toLowerCase() : nullable(raw[source]);
      if (row[typed] !== expected) fail("registry typed/raw identity mismatch");
    }
    if (raw.totalRows !== c.totalItems) fail("registry total count mismatch");
  }
}
type LegalIdentity = { id: string; rows: ArkansasVerifiedRegistryRow[]; names: Set<string> };
function legalUniverse(rows: readonly ArkansasVerifiedRegistryRow[]): {
  byName: Map<string, Set<string>>; byId: Map<string, LegalIdentity>;
} {
  const byId = new Map<string, LegalIdentity>(), byName = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = String(row.filerEntityId);
    let legal = byId.get(id);
    if (!legal) { legal = { id, rows: [], names: new Set() }; byId.set(id, legal); }
    legal.rows.push(row);
    for (const raw of [row.committeeName, row.filerName]) {
      if (!raw) continue;
      const name = normalizeArkansasReportedPacName(raw);
      if (!name) continue;
      legal.names.add(name);
      const matches = byName.get(name) ?? new Set<string>();
      matches.add(id); byName.set(name, matches);
    }
  }
  return { byId, byName };
}

/** No source acquisition or financial reconstruction: consumes the complete current cash proof. */
export function aggregateArkansasVerifiedPacDonors(input: ArkansasVerifiedPacDonorInput): ArkansasVerifiedPacDonorResult {
  try {
    validateArkansasVerifiedFullRegistry(input.registryBefore); validateArkansasVerifiedFullRegistry(input.registryAfter);
    if (input.registryBefore.fingerprint !== input.registryAfter.fingerprint) fail("registry generation changed");
    const proof = input.financialEvidence;
    if (!proof || proof.version !== 1) fail("missing current cash proof");
    const { byId, byName } = legalUniverse(input.registryBefore.rows);
    const receivingNames = new Set([input.link.filerName, input.link.candidateNameNormalized, proof.receiver.sourceName]
      .map(normalizeArkansasReportedPacName));
    const groups = new Map<string, ArkansasPacSourceGroup>();
    for (const row of proof.cashRows) {
      if (!isArkansasTypedPacCash(row)) continue;
      const name = normalizeArkansasReportedPacName(row.reportedName);
      if (!name || receivingNames.has(name) || arkansasExactOwnerNameEquivalent(row.reportedName, proof.receiver.sourceName)) fail("missing/self typed PAC name");
      const matches = byName.get(name) ?? new Set<string>();
      if (matches.size > 1) fail("ambiguous full-name legal identity");
      let id: string, label: string;
      if (matches.size === 1) {
        const identity = byId.get([...matches][0]!)!;
        if (identity.id === String(input.link.filingEntityId)) fail("self donor identity");
        if (identity.names.size !== 1 || identity.rows.some(r => r.filerTypeCode !== "PAC" || r.filerType !== "Political Action Committee")) fail("conflicting or excluded legal class/name");
        id = identity.id;
        // Annual registrations can repeat one legal entity. Choose an exact official label deterministically.
        label = identity.rows.map(r => r.committeeName || r.filerName || "").filter(Boolean).sort()[0]!;
      } else {
        id = "reported:" + name; label = row.reportedName;
      }
      const group = groups.get(id);
      if (group && id.startsWith("reported:") && group.committeeName !== label) fail("normalized reported-name collision");
      if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) fail("invalid typed PAC cents");
      if (group) {
        groups.set(id, { ...group, amountCents: addArkansasPacCents(group.amountCents, row.amountCents),
          contributionCount: group.contributionCount + 1, receiptGuids: [...group.receiptGuids, row.guid] });
      } else {
        groups.set(id, { committeeId: id, committeeName: label, committeeType: "Political Action Committee",
          amountCents: row.amountCents, contributionCount: 1, receiptGuids: [row.guid] });
      }
    }
    const sourceUrl = arkansasPacReceivingSourceUrl(proof.receiver.registrationGuid);
    const orderedGroups = [...groups.values()].sort((a, b) => b.amountCents - a.amountCents || a.committeeId.localeCompare(b.committeeId));
    const pacDonors = orderedGroups.map(g => ({ committeeId: g.committeeId, committeeName: g.committeeName,
      committeeType: g.committeeType, amount: g.amountCents / 100, contributionCount: g.contributionCount, sourceUrl }));
    const pacSourceProvenance: ArkansasPacSourceProvenance = {
      version: 1, scope: "current_original_reported_pac_cash",
      link: { candidateId: input.link.candidateId, electionId: input.link.electionId, electionYear: input.link.electionYear,
        filingEntityId: String(input.link.filingEntityId), filerName: input.link.filerName },
      receiver: { ...proof.receiver }, windowStart: proof.windowStart, windowEnd: proof.windowEnd,
      publishedThrough: proof.reports.map(r => r.periodEnd).sort().at(-1) ?? "",
      sourceUrl, monetaryCashCents: proof.monetaryCashCents,
      pacCashCents: orderedGroups.reduce((sum, g) => addArkansasPacCents(sum, g.amountCents), 0),
      reports: proof.reports.map(r => ({ ...r })),
      cashRows: proof.cashRows.map(({ reportedAddress: _address, ...row }) => ({ ...row })),
      groups: orderedGroups,
      sourceFingerprints: { ...proof.sourceFingerprints,
        registryBefore: input.registryBefore.fingerprint, registryAfter: input.registryAfter.fingerprint },
      rawResponseHashes: [...proof.rawResponseHashes, ...input.registryBefore.requests.map(r => r.sha256),
        ...input.registryAfter.requests.map(r => r.sha256)],
    };
    validateArkansasPacSnapshot({ link: input.link, pacDonors, pacSourceProvenance });
    assertArkansasPacPriorAuthorityRetained(pacSourceProvenance, input.priorPacSourceProvenance);
    return { pacDonors, pacSourceProvenance, diagnostics: [] };
  } catch (error) {
    return { diagnostics: ["PAC preserved: " + (error instanceof Error ? error.message : String(error))] };
  }
}
