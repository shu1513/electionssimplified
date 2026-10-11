import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FloridaFinanceLinkInput } from "./floridaFinanceWriter.js";
import type { FloridaCandidateProcessedSourceResult } from "./floridaCandidateProcessedFinanceSource.js";
import { loadFloridaLocalFinanceContext } from "./floridaLocalFinanceContext.js";
import {
  buildFloridaVerifiedCommitteeDonors,
  type FloridaVerifiedCommitteeDonorResult,
} from "./floridaVerifiedCommitteeDonorSource.js";

export type FloridaCommitteeDonorFinanceInput = {
  source: Extract<
    FloridaCandidateProcessedSourceResult,
    { status: "verified" }
  >;
  finance: Extract<FloridaVerifiedCommitteeDonorResult, { status: "accepted" }>;
};
export type PreparedFloridaCommitteeDonorFinance =
  FloridaCommitteeDonorFinanceInput;
type Queryable = Pick<Pool | PoolClient, "query">;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exact = (s: string) => s.trim().replace(/\s+/gu, " ").toUpperCase();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fail(message: string): never {
  throw new Error("Florida committee donor write: " + message);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
function cents(value: number): number {
  const integer = Math.round(value * 100);
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(integer) ||
    integer / 100 !== value
  )
    fail("unsafe or inexact monetary amount");
  return integer;
}
function count(value: number, positive = false): void {
  if (
    !Number.isInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > 2147483647
  )
    fail("invalid contribution/refund count");
}
function storageName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function assertContext(
  prepared: PreparedFloridaCommitteeDonorFinance,
  link: FloridaFinanceLinkInput,
): void {
  const local = prepared.source.localContext,
    source = prepared.source.proof.context;
  if (
    !local ||
    !source ||
    ![local.candidateId, local.electionId, local.candidateElectionId].every(
      (v) => typeof v === "string" && UUID.test(v),
    ) ||
    local.candidateId !== link.candidateId ||
    local.electionId !== link.electionId ||
    local.committeeId !== link.committeeId ||
    local.electionYear !== link.electionYear ||
    local.electionYear !== source.electionYear ||
    local.electionDate !== "2026-11-03" ||
    local.electionYear !== 2026 ||
    link.linkStatus === "inactive" ||
    typeof local.candidateName !== "string" ||
    !local.candidateName.trim() ||
    exact(local.candidateName) !== exact(source.candidateName) ||
    storageName(local.candidateName) !== link.candidateNameNormalized ||
    local.officeCanonicalName !== link.officeName ||
    local.district !== (link.district ?? null) ||
    local.district !== source.district ||
    local.genericRecipientName !== link.committeeName ||
    local.genericRecipientName !== source.genericRecipientName ||
    source.officeName !==
      (local.officeScope === "state_lower"
        ? "State Representative"
        : local.officeCanonicalName)
  )
    fail("local/link/source context mismatch");
}

/** Rebuild materialization from the accepted source proof and its exact occurrence
 * lookup results before opening a transaction. This is structural validation,
 * not authentication of caller-created hashes; raw verification is upstream.
 */
export async function prepareFloridaCommitteeDonorFinance(input: {
  pacFinance: FloridaCommitteeDonorFinanceInput;
  link: FloridaFinanceLinkInput;
}): Promise<PreparedFloridaCommitteeDonorFinance> {
  const { pacFinance, link } = structuredClone(input);
  if (
    pacFinance?.source?.status !== "verified" ||
    pacFinance?.finance?.status !== "accepted"
  )
    fail("requires verified source and accepted committee finance");
  if (
    !Array.isArray(pacFinance.source.accountCatalogHashes) ||
    pacFinance.source.accountCatalogHashes.length < 2 ||
    !pacFinance.source.accountCatalogHashes.every(
      (h) => typeof h === "string" && HASH.test(h),
    )
  )
    fail("missing source account catalog evidence");
  assertContext(pacFinance, link);
  const lookups = pacFinance.finance.provenance?.registryLookups;
  const rows = pacFinance.source.proof.rows;
  if (!Array.isArray(lookups) || !Array.isArray(rows))
    fail("missing registry occurrence evidence");
  const required = rows.flatMap((row, occurrence) =>
    ["CHE", "CAS", "MO", "REF"].includes(row.transactionType)
      ? [{ row, occurrence }]
      : [],
  );
  if (lookups.length !== required.length)
    fail("registry occurrence coverage mismatch");
  for (const [i, expected] of required.entries()) {
    const lookup = lookups[i];
    if (
      !lookup ||
      lookup.occurrence !== expected.occurrence ||
      lookup.rowFingerprint !== sha(JSON.stringify(expected.row))
    )
      fail("registry occurrence identity mismatch");
  }
  let index = 0;
  const rebuilt = await buildFloridaVerifiedCommitteeDonors({
    proof: pacFinance.source.proof,
    lookupDonor: async (query) => {
      const expected = required[index],
        lookup = lookups[index++];
      if (
        !expected ||
        !lookup ||
        query.reportedName !== expected.row.contributorName ||
        query.reportedAddress !== expected.row.address ||
        query.reportedCityStateZip !== expected.row.cityStateZip ||
        query.transactionDate !== expected.row.contributionDate ||
        query.receivingCommitteeId !==
          pacFinance.source.proof.context.sourceAccount
      )
        fail("registry replay query mismatch");
      return lookup.result;
    },
  });
  if (rebuilt.status !== "accepted")
    fail("source materialization rejected: " + rebuilt.reason);
  if (
    index !== required.length ||
    canonical(rebuilt) !== canonical(pacFinance.finance)
  )
    fail("accepted finance differs from source materialization");
  let net = 0;
  for (const donor of rebuilt.donors) {
    const amount = cents(donor.amount),
      gross = cents(donor.grossAmount),
      refund = cents(donor.refundAmount);
    if (amount <= 0 || gross <= 0 || gross - refund !== amount)
      fail("invalid net/gross/refund relationship");
    count(donor.contributionCount, true);
    count(donor.refundCount);
    net += amount;
    if (!Number.isSafeInteger(net)) fail("unsafe donor total");
  }
  if (net !== cents(rebuilt.netCommitteeAmount))
    fail("net donor total mismatch");
  cents(rebuilt.unclassifiedPositiveCashAmount);
  count(rebuilt.unclassifiedPositiveCashCount);
  return { source: pacFinance.source, finance: rebuilt };
}

/** Recheck the actual race/link under the snapshot transaction before link writes.
 * Same-link serialization avoids concurrent shared-lock upgrades to the upsert.
 */
export async function assertFloridaCommitteeDonorLocalOwnership(input: {
  db: Queryable;
  prepared: PreparedFloridaCommitteeDonorFinance;
  link: FloridaFinanceLinkInput;
}): Promise<void> {
  await input.db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [
      "florida-committee-donors:" +
        JSON.stringify([
          input.link.candidateId,
          input.link.electionId,
          input.link.committeeId,
        ]),
    ],
  );
  const actual = await loadFloridaLocalFinanceContext({
    db: input.db,
    candidateId: input.link.candidateId,
    electionId: input.link.electionId,
    committeeId: input.link.committeeId,
    lock: true,
  });
  if (actual.status !== "resolved") fail(actual.reason);
  if (
    canonical(actual.context) !== canonical(input.prepared.source.localContext)
  )
    fail("actual local ownership changed since source verification");
  assertContext(input.prepared, input.link);
}

/** Called only inside the existing snapshot transaction, after ownership recheck. */
export async function writeFloridaCommitteeDonorFinance(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  syncedAt: Date;
  prepared: PreparedFloridaCommitteeDonorFinance;
}): Promise<number> {
  const { finance, source } = input.prepared;
  for (const donor of finance.donors) {
    await input.db.query(
      `
      INSERT INTO public.fl_candidate_finance_pac_donors (
        link_id, election_year, committee_id, committee_name, committee_type,
        amount, gross_amount, refund_amount, contribution_count, refund_count, source_url, last_synced_at
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
      ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET
        committee_name = EXCLUDED.committee_name, committee_type = EXCLUDED.committee_type,
        amount = EXCLUDED.amount, gross_amount = EXCLUDED.gross_amount, refund_amount = EXCLUDED.refund_amount,
        contribution_count = EXCLUDED.contribution_count, refund_count = EXCLUDED.refund_count,
        source_url = EXCLUDED.source_url, last_synced_at = EXCLUDED.last_synced_at
    `,
      [
        input.linkId,
        input.electionYear,
        donor.committeeId,
        donor.committeeName,
        donor.committeeType,
        donor.amount,
        donor.grossAmount,
        donor.refundAmount,
        donor.contributionCount,
        donor.refundCount,
        donor.sourceUrl,
        input.syncedAt.toISOString(),
      ],
    );
  }
  const provenance = {
    ...finance.provenance,
    localContext: source.localContext,
    accountCatalogHashes: source.accountCatalogHashes,
  };
  await input.db.query(
    `
    INSERT INTO public.fl_candidate_finance_pac_sources (
      link_id, election_year, source_account, net_amount, unclassified_cash_amount,
      unclassified_cash_count, provenance, last_synced_at
    ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
    ON CONFLICT (link_id, election_year) DO UPDATE SET
      source_account = EXCLUDED.source_account, net_amount = EXCLUDED.net_amount,
      unclassified_cash_amount = EXCLUDED.unclassified_cash_amount,
      unclassified_cash_count = EXCLUDED.unclassified_cash_count,
      provenance = EXCLUDED.provenance, last_synced_at = EXCLUDED.last_synced_at
  `,
    [
      input.linkId,
      input.electionYear,
      source.proof.context.sourceAccount,
      finance.netCommitteeAmount,
      finance.unclassifiedPositiveCashAmount,
      finance.unclassifiedPositiveCashCount,
      JSON.stringify(provenance),
      input.syncedAt.toISOString(),
    ],
  );
  await input.db.query(
    `
    DELETE FROM public.fl_candidate_finance_pac_donors
    WHERE link_id = $1::uuid AND election_year = $2 AND committee_id <> ALL($3::text[])
  `,
    [
      input.linkId,
      input.electionYear,
      finance.donors.map((d) => d.committeeId),
    ],
  );
  return finance.donors.length;
}
