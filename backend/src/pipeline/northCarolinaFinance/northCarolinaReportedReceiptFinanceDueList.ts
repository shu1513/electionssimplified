import type { Pool, PoolClient } from "pg";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueListInput,
} from "../finance/standardStateFinanceDueListQuery.js";
import { NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./northCarolinaFinanceEligibleOffices.js";
import type { NorthCarolinaFinanceLinkSource } from "./northCarolinaFinanceWriter.js";
import type { NorthCarolinaReportedReceiptFinanceReceiver } from "./northCarolinaReportedReceiptFinanceTypes.js";
import {
  NorthCarolinaReportedReceiptSourceError,
  readNorthCarolinaReportedReceiptSourceRevision,
  type NorthCarolinaReportedReceiptSourceRevision,
} from "./northCarolinaReportedReceiptSourceCache.js";

type Queryable = Pick<Pool | PoolClient, "query">;
const ENUMERATION_LIMIT = 100_000;
const DAY_MS = 86_400_000;
const ERROR = "North Carolina reported receipt scheduling unavailable";
const fail = (): never => { throw new Error(ERROR); };

// Eligibility and its stable order remain the canonical factory's contract.
// Only the component's independent freshness and durable rotation differ.
const listEligible = createStandardStateFinanceDueListQuery({
  state: "NC", tables: { links: "nc_candidate_finance_links", summaries: "nc_candidate_finance_summaries" },
  eligibleOfficeKeys: NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  selectElectionDate: true,
  linkColumns: ["id", "committee_id", "committee_name", "link_source"],
  mapRow: (row): NorthCarolinaReportedReceiptFinanceReceiver => ({
    linkId: String(row.id), candidateId: row.candidate_id, electionId: row.election_id,
    candidateName: row.candidate_name, electionYear: row.election_year, electionDate: row.election_date!,
    officeScope: row.office_scope, officeName: row.office_name, district: row.district,
    committeeId: String(row.committee_id), committeeName: String(row.committee_name),
    linkSource: row.link_source as NorthCarolinaFinanceLinkSource,
    sourceUrl: row.source_url, lastSyncedAt: row.last_synced_at,
  }),
});

type Metadata = {
  link_id: string;
  source_clock: string | null;
  source_manifest: string | null;
  source_receiver: string | null;
  last_attempted_at: string | null;
  attempt_receiver: string | null;
  attempt_manifest: string | null;
};

export type NorthCarolinaReportedReceiptFinanceDueInput = StandardStateFinanceDueListInput & { cacheDir?: string };
export type NorthCarolinaReportedReceiptFinanceDueResult = {
  eligibleCount: number;
  totalDueRows: number;
  rows: NorthCarolinaReportedReceiptFinanceReceiver[];
};
const clock = (value: string | null | undefined): number => value ? Date.parse(value) : NaN;
function validNow(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
}
function boundedInteger(value: number, minimum: number, maximum = 2_147_483_647): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
}
async function revision(receiver: Pick<NorthCarolinaReportedReceiptFinanceReceiver, "committeeId" | "electionYear">, cacheDir?: string): Promise<NorthCarolinaReportedReceiptSourceRevision | null> {
  try {
    return await readNorthCarolinaReportedReceiptSourceRevision({ cacheDir, receivingCommitteeId: receiver.committeeId, electionYear: receiver.electionYear });
  } catch (error) {
    // A missing/corrupt hint never supplies accepted money. Programming errors
    // remain visible instead of silently altering scheduling decisions.
    if (error instanceof NorthCarolinaReportedReceiptSourceError) return null;
    throw error;
  }
}

export async function listDueNorthCarolinaReportedReceiptFinance(db: Queryable, input: NorthCarolinaReportedReceiptFinanceDueInput): Promise<NorthCarolinaReportedReceiptFinanceDueResult> {
  validNow(input.now);
  boundedInteger(input.maxCandidates, 1, ENUMERATION_LIMIT);
  boundedInteger(input.staleAfterDays, 1);
  boundedInteger(input.electionLookbackDays, 0);
  boundedInteger(input.electionLookaheadDays, 0);
  if (input.refresh !== undefined && typeof input.refresh !== "boolean") fail();
  const eligible = await listEligible(db, { ...input, maxCandidates: ENUMERATION_LIMIT, refresh: true });
  if (eligible.rows.length !== eligible.totalDueRows || new Set(eligible.rows.map((row) => row.linkId)).size !== eligible.rows.length) fail();
  if (eligible.rows.length === 0) return { eligibleCount: 0, totalDueRows: 0, rows: [] };
  const metadata = await db.query<Metadata>(`
    SELECT link.id::text AS link_id,
      source.source_retrieved_at::text AS source_clock,
      source.source_manifest_sha256 AS source_manifest,
      source.receiving_committee_id AS source_receiver,
      attempt.last_attempted_at::text,
      attempt.receiving_committee_id AS attempt_receiver,
      attempt.source_manifest_sha256 AS attempt_manifest
    FROM public.nc_candidate_finance_links link
    LEFT JOIN public.nc_reported_receipt_sources source
      ON source.link_id = link.id AND source.election_year = link.election_year
    LEFT JOIN public.nc_reported_receipt_attempts attempt
      ON attempt.link_id = link.id AND attempt.election_year = link.election_year
    WHERE link.id = ANY($1::uuid[])`, [eligible.rows.map((row) => row.linkId)]);
  const byLink = new Map(metadata.rows.map((row) => [row.link_id, row]));
  if (byLink.size !== eligible.rows.length || metadata.rows.length !== eligible.rows.length
    || eligible.rows.some((row) => !byLink.has(row.linkId))) fail();

  const revisions = new Map<string, NorthCarolinaReportedReceiptSourceRevision | null>();
  for (const row of eligible.rows) {
    const key = JSON.stringify([row.committeeId, row.electionYear]);
    if (!revisions.has(key)) revisions.set(key, await revision(row, input.cacheDir));
  }
  const now = input.now.getTime(), stale = now - input.staleAfterDays * DAY_MS;
  const due = eligible.rows.map((row, order) => ({ row, order })).filter(({ row }) => {
    const meta = byLink.get(row.linkId)!;
    const hint = revisions.get(JSON.stringify([row.committeeId, row.electionYear]));
    const sourceClock = clock(meta.source_clock);
    const needs = input.refresh === true || !Number.isFinite(sourceClock) || sourceClock > now || sourceClock < stale
      || meta.source_receiver !== row.committeeId || typeof meta.source_manifest !== "string" || !/^[a-f0-9]{64}$/.test(meta.source_manifest)
      || !!hint && meta.source_manifest !== hint.sourceManifestSha256;
    if (!needs) return false;
    const attempted = clock(meta.last_attempted_at);
    return input.refresh === true || !Number.isFinite(attempted) || attempted > now || attempted <= now - DAY_MS
      || meta.attempt_receiver !== row.committeeId || !!hint && meta.attempt_manifest !== hint.sourceManifestSha256;
  });
  const attemptClock = (row: NorthCarolinaReportedReceiptFinanceReceiver): number => {
    const value = clock(byLink.get(row.linkId)!.last_attempted_at);
    return Number.isFinite(value) && value <= now ? value : -Infinity;
  };
  due.sort((left, right) => {
    const a = attemptClock(left.row), b = attemptClock(right.row);
    return (a === b ? 0 : a < b ? -1 : 1) || left.order - right.order;
  });
  return { eligibleCount: eligible.rows.length, totalDueRows: due.length, rows: due.slice(0, input.maxCandidates).map(({ row }) => row) };
}

/** Call before processing and after completion with the actual current Date.
 * This rotates held contexts without changing financial/source freshness.
 * The current cache revision is read again, so a newly captured held writer
 * does not repeatedly bypass the unchanged-revision cooldown.
 */
export async function recordNorthCarolinaReportedReceiptFinanceAttempt(input: {
  db: Queryable;
  receiver: NorthCarolinaReportedReceiptFinanceReceiver;
  now: Date;
  cacheDir?: string;
}): Promise<boolean> {
  validNow(input.now);
  const r = input.receiver;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![r.linkId, r.candidateId, r.electionId].every((value) => typeof value === "string" && uuid.test(value))
    || !Number.isSafeInteger(r.electionYear) || r.electionYear < 2000 || r.electionYear > 2100
    || !["manual", "ncsbe_portal"].includes(r.linkSource)
    || typeof r.committeeId !== "string" || r.committeeId.trim() === ""
    || typeof r.officeScope !== "string" || typeof r.officeName !== "string"
    || (r.district !== null && typeof r.district !== "string") || !/^\d{4}-\d\d-\d\d$/.test(r.electionDate)
    || !Number.isFinite(Date.parse(`${r.electionDate}T00:00:00.000Z`))
    || new Date(`${r.electionDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== r.electionDate) fail();
  const hint = await revision(r, input.cacheDir);
  const result = await input.db.query(`
    INSERT INTO public.nc_reported_receipt_attempts
      (link_id, election_year, last_attempted_at, receiving_committee_id, source_manifest_sha256)
    SELECT link.id, link.election_year, $8::timestamptz, link.committee_id, $9::text
    FROM public.nc_candidate_finance_links link
    JOIN public.candidates candidate ON candidate.id = link.candidate_id
    JOIN public.candidate_elections candidate_election
      ON candidate_election.candidate_id = link.candidate_id AND candidate_election.election_id = link.election_id
    JOIN public.elections election ON election.id = link.election_id
    JOIN public.districts district ON district.id = election.district_id
    JOIN public.offices office ON office.id = election.office_id
    WHERE link.id = $1::uuid AND link.election_year = $2::int
      AND link.candidate_id = $3::uuid AND link.election_id = $4::uuid
      AND link.committee_id = $5 AND link.link_source = $6
      AND link.link_source IN ('manual', 'ncsbe_portal') AND link.link_status = 'active'
      AND candidate.deleted_at IS NULL AND candidate_election.status NOT IN ('withdrawn', 'lost')
      AND district.state = 'NC' AND election.race_type = 'office'
      AND election.election_date = $7::date AND EXTRACT(YEAR FROM election.election_date)::int = $2::int
      AND (office.scope || '::' || office.canonical_name) = ANY($10::text[])
      AND office.scope = $11 AND link.office_name = $12 AND link.district IS NOT DISTINCT FROM $13::text
    ON CONFLICT (link_id, election_year) DO UPDATE SET
      last_attempted_at = EXCLUDED.last_attempted_at,
      receiving_committee_id = EXCLUDED.receiving_committee_id,
      source_manifest_sha256 = EXCLUDED.source_manifest_sha256
    WHERE nc_reported_receipt_attempts.last_attempted_at < EXCLUDED.last_attempted_at
      OR (nc_reported_receipt_attempts.last_attempted_at = EXCLUDED.last_attempted_at
        AND nc_reported_receipt_attempts.receiving_committee_id = EXCLUDED.receiving_committee_id
        AND nc_reported_receipt_attempts.source_manifest_sha256 IS NOT DISTINCT FROM EXCLUDED.source_manifest_sha256)
    RETURNING link_id`, [r.linkId, r.electionYear, r.candidateId, r.electionId, r.committeeId, r.linkSource,
    r.electionDate, input.now.toISOString(), hint?.sourceManifestSha256 ?? null,
    [...NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS], r.officeScope, r.officeName, r.district]);
  return result.rowCount === 1;
}
