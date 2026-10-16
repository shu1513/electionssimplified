import type { Pool, PoolClient } from "pg";
import type { MinnesotaReportedCommitteeCashAggregation } from "./minnesotaReportedCommitteeCashAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export const MINNESOTA_COMMITTEE_CASH_BASIS = "reported_itemized_committee_cash_contributions";

export type MinnesotaCommitteeCashSnapshot = {
  aggregate: MinnesotaReportedCommitteeCashAggregation;
  source: {
    observedAt: string;
    sha256: string;
    byteCount: number;
    rowCount: number;
    url: string;
  };
};

const MAX_COUNT = 2_147_483_647;

function invalid(field: string): never {
  // Do not expose source donor names, account numbers, or other row values.
  throw new Error(`Invalid Minnesota committee cash ${field}`);
}

function count(value: number, field: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_COUNT) invalid(field);
  return value;
}

function cents(value: number, field: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) invalid(field);
  return value;
}

function moneyString(value: number): string {
  const exact = BigInt(value);
  return `${exact / 100n}.${String(exact % 100n).padStart(2, "0")}`;
}

function addSafe(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalid(field);
  return result;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}

function officialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "cfb.mn.gov" || url.hostname.endsWith(".cfb.mn.gov"));
  } catch {
    return false;
  }
}

/** Validate the entire component before the parent transaction acquires a link. */
export function validateMinnesotaCommitteeCashSnapshot(snapshot: MinnesotaCommitteeCashSnapshot): void {
  const { aggregate, source } = snapshot;
  if (!source || !aggregate || !Array.isArray(aggregate.donors)) invalid("snapshot");
  if (typeof source.observedAt !== "string" || !validTimestamp(source.observedAt)) invalid("source observation time");
  if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256)) invalid("source digest");
  if (!Number.isSafeInteger(source.byteCount) || source.byteCount <= 0) invalid("source byte count");
  count(source.rowCount, "source row count", true);
  if (typeof source.url !== "string" || !officialUrl(source.url)) invalid("source URL");
  cents(aggregate.totalAmountCents, "total amount");
  count(aggregate.matchedContributionRowCount, "matched count");
  count(aggregate.includedContributionRowCount, "included count");
  count(aggregate.excludedContributionRowCount, "excluded count");
  count(aggregate.zeroContributionRowCount, "zero count");
  count(aggregate.excludedUnknownClassRowCount, "unknown class count");
  if (source.rowCount < aggregate.matchedContributionRowCount ||
      aggregate.matchedContributionRowCount !== aggregate.includedContributionRowCount +
        aggregate.excludedContributionRowCount + aggregate.zeroContributionRowCount ||
      aggregate.excludedUnknownClassRowCount > aggregate.excludedContributionRowCount) invalid("count agreement");

  let donorCents = 0;
  let donorCount = 0;
  const keys = new Set<string>();
  for (const donor of aggregate.donors) {
    if (typeof donor.reportedCommitteeId !== "string" || !/^[0-9]+$/.test(donor.reportedCommitteeId)) {
      invalid("reported account");
    }
    const name = donor.reportedCommitteeName;
    if (typeof name !== "string" || !name || /[\u0000-\u001f\u007f]/u.test(name) ||
        name !== name.normalize("NFC").trim().replace(/\s+/gu, " ")) invalid("reported name");
    const key = JSON.stringify([donor.reportedCommitteeId, name]);
    if (keys.has(key)) invalid("duplicate reported group");
    keys.add(key);
    donorCents = addSafe(donorCents, cents(donor.amountCents, "donor amount", true), "donor amount sum");
    donorCount = addSafe(donorCount, count(donor.contributionCount, "donor count", true), "donor count sum");
  }
  if (donorCents !== aggregate.totalAmountCents || donorCount !== aggregate.includedContributionRowCount) {
    invalid("donor agreement");
  }
}

/**
 * Replaces one current component inside the caller's existing snapshot transaction.
 * This helper deliberately neither begins nor commits a transaction.
 */
export async function writeMinnesotaCommitteeCash(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  snapshot: MinnesotaCommitteeCashSnapshot;
  syncedAt: Date;
}): Promise<{ donorsWritten: number }> {
  validateMinnesotaCommitteeCashSnapshot(input.snapshot);
  if (!input.linkId.trim()) invalid("link");
  if (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) invalid("election year");
  if (!Number.isFinite(input.syncedAt.getTime())) invalid("sync time");
  const { aggregate, source } = input.snapshot;
  const syncedAt = input.syncedAt.toISOString();
  await input.db.query(
    "DELETE FROM public.mn_candidate_finance_pac_donors WHERE link_id = $1::uuid AND election_year = $2",
    [input.linkId, input.electionYear]
  );
  await input.db.query(
    `INSERT INTO public.mn_candidate_finance_pac_sources (
      link_id, election_year, basis, source_url, source_sha256, source_byte_count, source_row_count,
      source_observed_at, total_amount, matched_contribution_row_count, included_contribution_row_count,
      excluded_contribution_row_count, zero_contribution_row_count, excluded_unknown_class_row_count, last_synced_at
    ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,$13,$14,$15::timestamptz)
    ON CONFLICT (link_id,election_year) DO UPDATE SET
      basis=EXCLUDED.basis, source_url=EXCLUDED.source_url, source_sha256=EXCLUDED.source_sha256,
      source_byte_count=EXCLUDED.source_byte_count, source_row_count=EXCLUDED.source_row_count,
      source_observed_at=EXCLUDED.source_observed_at, total_amount=EXCLUDED.total_amount,
      matched_contribution_row_count=EXCLUDED.matched_contribution_row_count,
      included_contribution_row_count=EXCLUDED.included_contribution_row_count,
      excluded_contribution_row_count=EXCLUDED.excluded_contribution_row_count,
      zero_contribution_row_count=EXCLUDED.zero_contribution_row_count,
      excluded_unknown_class_row_count=EXCLUDED.excluded_unknown_class_row_count,
      last_synced_at=EXCLUDED.last_synced_at`,
    [input.linkId, input.electionYear, MINNESOTA_COMMITTEE_CASH_BASIS, source.url, source.sha256,
      source.byteCount, source.rowCount, source.observedAt, moneyString(aggregate.totalAmountCents),
      aggregate.matchedContributionRowCount, aggregate.includedContributionRowCount,
      aggregate.excludedContributionRowCount, aggregate.zeroContributionRowCount,
      aggregate.excludedUnknownClassRowCount, syncedAt]
  );
  for (const donor of aggregate.donors) {
    await input.db.query(
      `INSERT INTO public.mn_candidate_finance_pac_donors (
        link_id,election_year,reported_committee_id,reported_committee_name,reported_type,
        amount,contribution_count,source_sha256,last_synced_at
      ) VALUES ($1::uuid,$2,$3,$4,'Political Committee/Fund',$5,$6,$7,$8::timestamptz)`,
      [input.linkId, input.electionYear, donor.reportedCommitteeId, donor.reportedCommitteeName,
        moneyString(donor.amountCents), donor.contributionCount, source.sha256, syncedAt]
    );
  }
  return { donorsWritten: aggregate.donors.length };
}
