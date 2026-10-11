import { createHash } from "node:crypto";
import type { FloridaContributionRow } from "./floridaCampaignFinanceRows.js";
import type { FloridaProcessedFinanceProof } from "./floridaProcessedFinanceSource.js";
import type { FloridaCommitteeRegistryLookupResult } from "./floridaCommitteeRegistrySource.js";
import {
  aggregateFloridaNetCommitteeDonors,
  type FloridaCashDonorResolution,
  type FloridaNetCommitteeAggregationResult,
} from "./floridaNetCommitteeDonorAggregator.js";

export type FloridaCommitteeDonorLookupInput = {
  reportedName: string; reportedAddress: string; reportedCityStateZip: string;
  transactionDate: string; receivingCommitteeId: string;
};
export type FloridaVerifiedCommitteeDonorProvenance = {
  version: 1; authority: "current_processed";
  context: FloridaProcessedFinanceProof["context"]; windowStart: string; windowEnd: string;
  financialFingerprint: string; reports: FloridaProcessedFinanceProof["reports"];
  sourceHashes: readonly string[]; sourceMetadata: FloridaProcessedFinanceProof["sourceMetadata"];
  registryLookups: readonly {
    occurrence: number; rowFingerprint: string; result: FloridaCommitteeRegistryLookupResult;
  }[];
};
export type FloridaVerifiedCommitteeDonorResult =
  | { status: "preserve"; reason: string; registrySourceHashes: readonly string[] }
  | (Extract<FloridaNetCommitteeAggregationResult, {status: "accepted"}> & {
      registrySourceHashes: readonly string[]; provenance: FloridaVerifiedCommitteeDonorProvenance;
    });

const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[1-9][0-9]*$/;
const INCLUDED = new Set(["PAC", "CCE", "PTY", "PAP"]);
const CASH = new Set(["CHE", "CAS", "MO"]);
const OTHER = new Set(["COF", "INK", "LOA", "INT"]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const exact = (value: string) => value.trim().replace(/\s+/gu, " ").toUpperCase();
const multiset = (rows: readonly unknown[]) => JSON.stringify(rows.map(r => JSON.stringify(r)).sort());
function fail(message: string): never { throw new Error(message); }
function day(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) fail("invalid_proof_date");
  return value;
}
function cents(value: string): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(value.trim())) fail("invalid_proof_cents");
  const raw = value.trim(), [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount)) fail("unsafe_proof_cents");
  return raw.startsWith("-") ? -amount : amount;
}
function publicAccount(value: string): boolean {
  return typeof value === "string" && ACCOUNT.test(value) && Number.isSafeInteger(Number(value));
}
function identity(row: FloridaContributionRow): unknown[] {
  return [row.contributionDate, cents(row.amount), row.contributorName, row.address,
    row.cityStateZip, row.occupation, row.transactionType, row.inKindDescription];
}
function officialUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash ||
    !["dos.elections.myflorida.com", "efs.dos.state.fl.us"].includes(u.hostname)) fail("invalid_proof_source_url");
  return u;
}

/** Structural proof boundary only. Source authority comes from the raw verifier;
 * matching hashes on caller-created objects are not cryptographic authentication. */
function validateProof(proof: FloridaProcessedFinanceProof): void {
  if (!proof || proof.version !== 1 || proof.authority !== "current_processed") fail("invalid_processed_authority");
  const c = proof.context;
  if (!c || !publicAccount(c.sourceAccount) ||
    ![c.candidateName, c.genericRecipientName, c.officeName].every(v => typeof v === "string" && v.trim()) ||
    !Number.isInteger(c.electionYear) || c.electionYear < 1996 || c.electionYear > 2100 ||
    (c.district !== null && (typeof c.district !== "string" || !ACCOUNT.test(c.district)))) fail("invalid_proof_context");
  if (day(proof.windowStart) > day(proof.windowEnd)) fail("invalid_proof_window");
  if (![proof.rows, proof.nativeRows, proof.reports, proof.sourceHashes, proof.sourceMetadata].every(Array.isArray) ||
    !HASH.test(proof.financialFingerprint) || proof.sourceMetadata.length < 8) fail("incomplete_processed_proof");
  for (const row of proof.rows) {
    if (!row || ![row.recipientName, row.contributionDate, row.amount, row.transactionType,
      row.contributorName, row.address, row.cityStateZip, row.occupation, row.inKindDescription]
      .every(v => typeof v === "string") || row.recipientName.trim().replace(/\s+/gu, " ") !== c.genericRecipientName.trim().replace(/\s+/gu, " ") ||
      day(row.contributionDate) < proof.windowStart || row.contributionDate > proof.windowEnd) fail("invalid_proof_row_scope");
    const amount = cents(row.amount), type = row.transactionType;
    if (CASH.has(type) ? amount <= 0 : type === "REF" ? amount >= 0 : !OTHER.has(type) || amount < 0)
      fail("invalid_proof_cash_type_or_sign");
    if ((CASH.has(type) || type === "REF") && !row.contributorName.trim()) fail("missing_proof_donor_name");
  }
  const generic = proof.rows.map(identity), native: unknown[][] = [];
  for (const row of proof.nativeRows) {
    if (!row || !Number.isSafeInteger(row.amountCents) || !Number.isInteger(row.reportYear) ||
      ![row.reportType, row.date, row.contributorName, row.address, row.cityStateZip,
        row.occupation, row.transactionType, row.inKindDescription].every(v => typeof v === "string"))
      fail("invalid_proof_native_row");
    const date = day(row.date);
    if (date >= proof.windowStart && date <= proof.windowEnd)
      native.push([date, row.amountCents, row.contributorName, row.address, row.cityStateZip,
        row.occupation, row.transactionType, row.inKindDescription]);
  }
  if (multiset(generic) !== multiset(native) || sha(multiset(generic)) !== proof.financialFingerprint)
    fail("processed_financial_fingerprint_mismatch");
  const sequences = new Set<number>();
  if (!proof.reports.length) fail("missing_current_reports");
  for (const r of proof.reports) {
    if (!r || r.account !== c.sourceAccount || r.candidateName !== c.candidateName ||
      r.electionYear !== c.electionYear || !Number.isSafeInteger(r.sequence) || r.sequence < 1 ||
      sequences.has(r.sequence) || day(r.periodStart) > day(r.periodEnd) ||
      !Number.isInteger(r.reportYear) || typeof r.reportType !== "string" || !r.reportType ||
      r.fileStatus !== "Filed Report" || r.reviewStatus !== "Reviewed" || r.queued !== 0 ||
      ![r.amended, r.waiver].every(v => typeof v === "boolean") ||
      !(r.completeness === "Complete Detail Records" ||
        (r.waiver && r.completeness === "No Detail Records Found" && r.contributionCount === 0)) ||
      !Number.isSafeInteger(r.contributionCount) || r.contributionCount < 0 ||
      ![r.monetaryCents, r.loanCents, r.inKindCents].every(Number.isSafeInteger) ||
      !HASH.test(r.financialFingerprint) || !r.fullMetadata || typeof r.fullMetadata !== "object")
      fail("invalid_current_report_proof");
    sequences.add(r.sequence);
  }
  if (proof.sourceHashes.length !== proof.sourceMetadata.length ||
    proof.sourceHashes.some((hash, i) => !HASH.test(hash) || hash !== proof.sourceMetadata[i]!.sha256))
    fail("invalid_processed_source_hashes");
  const before: number[] = [], after: number[] = [];
  for (const m of proof.sourceMetadata) {
    officialUrl(m.url);
    const start = Date.parse(m.startedAt), end = Date.parse(m.completedAt);
    if (m.status !== 200 || !Number.isSafeInteger(m.byteCount) || m.byteCount < 1 ||
      !Number.isFinite(start) || !Number.isFinite(end) || start > end ||
      !["GET", "POST"].includes(m.method) || typeof m.contentType !== "string" ||
      (m.method === "GET" ? m.financeFields !== null : !m.financeFields) ||
      (m.financeFields && Object.entries(m.financeFields).some(([k,v]) =>
        /token|password|secret|cookie|authorization|viewstate|validation/i.test(k) || typeof v !== "string")))
      fail("invalid_processed_source_metadata");
    if (m.phase === "before") before.push(end);
    else if (m.phase === "after") after.push(start);
    else fail("invalid_processed_source_phase");
  }
  if (before.length < 4 || after.length < 4 || Math.max(...before) > Math.min(...after))
    fail("invalid_processed_capture_bracket");
}
function resolution(result: FloridaCommitteeRegistryLookupResult, row: FloridaContributionRow,
  receivingId: string): FloridaCashDonorResolution {
  if (result.status === "unresolved") return {kind:"unresolved",reason:result.diagnostics.join("; ") || "registry_unavailable"};
  if (!Array.isArray(result.sourceHashes) || result.sourceHashes.length < 4 ||
    !result.sourceHashes.every(h => typeof h === "string" && HASH.test(h))) fail("invalid_registry_source_hashes");
  if (result.status === "not_found") {
    if (result.identity !== undefined) fail("contradictory_registry_absence");
    return {kind:"unmatched"};
  }
  const d = result.identity;
  if (result.status !== "resolved" || !d || !publicAccount(d.committeeId) ||
    typeof d.committeeName !== "string" || exact(d.committeeName) !== exact(row.contributorName) ||
    typeof d.committeeType !== "string" || !/^[A-Z][A-Z0-9]{1,7}$/.test(d.committeeType) ||
    !["unique_exact_name","dated_exact_address"].includes(d.resolution)) fail("invalid_resolved_registry_identity");
  const u = officialUrl(d.sourceUrl);
  if (u.hostname !== "dos.elections.myflorida.com" ||
    d.sourceUrl !== "https://dos.elections.myflorida.com/committees/ComDetail.asp?account=" + d.committeeId ||
    d.includedInCommitteeDonorScope !== (INCLUDED.has(d.committeeType) && d.committeeId !== receivingId))
    fail("contradictory_registry_scope");
  return d.includedInCommitteeDonorScope
    ? {kind:"committee",committeeId:d.committeeId,committeeName:d.committeeName,
        committeeType:d.committeeType as "PAC"|"CCE"|"PTY"|"PAP",sourceUrl:d.sourceUrl}
    : {kind:"excluded"};
}

export async function buildFloridaVerifiedCommitteeDonors(input: {
  proof: FloridaProcessedFinanceProof;
  lookupDonor: (input: FloridaCommitteeDonorLookupInput) => Promise<FloridaCommitteeRegistryLookupResult>;
}): Promise<FloridaVerifiedCommitteeDonorResult> {
  const registrySourceHashes: string[] = [];
  try {
    const proof = structuredClone(input.proof);
    const lookupDonor = input.lookupDonor;
    validateProof(proof);
    const mapped = new Map<FloridaContributionRow, FloridaCashDonorResolution>();
    const registryLookups: FloridaVerifiedCommitteeDonorProvenance["registryLookups"][number][] = [];
    for (const [occurrence, row] of proof.rows.entries()) {
      if (!CASH.has(row.transactionType) && row.transactionType !== "REF") continue;
      const result = structuredClone(await lookupDonor({
        reportedName: row.contributorName, reportedAddress: row.address,
        reportedCityStateZip: row.cityStateZip!, transactionDate: row.contributionDate,
        receivingCommitteeId: proof.context.sourceAccount,
      }));
      if (!result || !Array.isArray(result.diagnostics)) fail("invalid_registry_result");
      const r = resolution(result, row, proof.context.sourceAccount);
      if (r.kind === "unresolved") return {status:"preserve",reason:"donor_identity:" + r.reason,registrySourceHashes};
      registrySourceHashes.push(...result.sourceHashes);
      mapped.set(row, r);
      registryLookups.push({occurrence, rowFingerprint:sha(JSON.stringify(row)), result});
    }
    const aggregate = aggregateFloridaNetCommitteeDonors({
      contributionRows:proof.rows, recipientNames:[proof.context.genericRecipientName],
      selfContributorNames:[], receivingCommitteeId:proof.context.sourceAccount,
      windowStart:proof.windowStart, windowEnd:proof.windowEnd,
      resolveDonor:row=>mapped.get(row) ?? {kind:"unresolved",reason:"missing_registry_result"},
    });
    if (aggregate.status === "preserve") return {...aggregate,registrySourceHashes};
    return {...aggregate,registrySourceHashes,provenance:{
      version:1,authority:"current_processed",context:proof.context,
      windowStart:proof.windowStart,windowEnd:proof.windowEnd,
      financialFingerprint:proof.financialFingerprint,reports:proof.reports,
      sourceHashes:proof.sourceHashes,sourceMetadata:proof.sourceMetadata,registryLookups,
    }};
  } catch (error) {
    return {status:"preserve",reason:error instanceof Error ? error.message : "committee_source_unavailable",registrySourceHashes};
  }
}
