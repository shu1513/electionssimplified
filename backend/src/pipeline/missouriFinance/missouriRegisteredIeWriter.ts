import type { Pool, PoolClient } from "pg";
import type { MissouriReportedRegisteredIeAggregation } from "./missouriReportedRegisteredIeAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export const MISSOURI_REGISTERED_IE_BASIS = "reported_registered_committee_independent_expenditures";
export type MissouriRegisteredIeComponent = {
  candidateId: string; electionId: string; receivingCommitteeId: string;
  cycleStart: string; cycleEnd: string;
  aggregation: MissouriReportedRegisteredIeAggregation;
  sourceUrl: string; sourceRetrievedAt: Date; sourceSha256: string; sourceByteSize: number;
  sourceRowCount?: number; sourcePageCount?: number;
};
export type PreparedMissouriRegisteredIeComponent = Omit<MissouriRegisteredIeComponent, "aggregation"> & {
  aggregation: Extract<MissouriReportedRegisteredIeAggregation, { status: "qualified" }>;
};
type WriteCode = "invalid_component" | "receiving_link_changed" | "older_source" |
  "source_conflict" | "source_not_current" | "write_failed";
export class MissouriRegisteredIeWriteError extends Error {
  constructor(readonly code: WriteCode) {
    super("Missouri registered IE " + code);
    this.name = "MissouriRegisteredIeWriteError";
  }
}
const invalid = (): never => { throw new MissouriRegisteredIeWriteError("invalid_component"); };
const uuid = (s: unknown): s is string => typeof s === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
const count = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 2_147_483_647;
const cents = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const clean = (s: string) => s.normalize("NFC").trim().replace(/\s+/gu, " ");
const name = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" &&
  !/[\u0000-\u001f\u007f]/u.test(s);
function add(a: number, b: number): number { const n = a + b; return Number.isSafeInteger(n) ? n : invalid(); }
function isoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00.000Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function officialSource(s: unknown): s is string {
  return typeof s === "string" && s.trim() === s &&
    /^https:\/\/(www\.)?mec\.mo\.gov\/MEC\/Campaign_Finance\/CF_SearchDirExp\.aspx$/i.test(s);
}

/** Validate/copy before connecting. Missing/held preserves prior rows and time,
 * rather than becoming zero. Whole-source qualification remains the ordinary
 * loader's responsibility; this module does not authorize publication. */
export function prepareMissouriRegisteredIeComponent(input: {
  component?: MissouriRegisteredIeComponent;
  candidateId: string; electionId: string; electionYear: number;
  receivingCommitteeId: string; syncedAt: Date;
}): PreparedMissouriRegisteredIeComponent | undefined {
  try {
    if (input.component === undefined || input.component?.aggregation?.status === "held") return undefined;
    const s: MissouriRegisteredIeComponent = structuredClone(input.component);
    if (!s || s.aggregation?.status !== "qualified" || !uuid(s.candidateId) || !uuid(s.electionId) ||
      !uuid(input.candidateId) || !uuid(input.electionId) ||
      s.candidateId.toLowerCase() !== input.candidateId.toLowerCase() ||
      s.electionId.toLowerCase() !== input.electionId.toLowerCase() ||
      typeof s.receivingCommitteeId !== "string" || typeof input.receivingCommitteeId !== "string" ||
      !/^[A-Z]\d{6}$/.test(s.receivingCommitteeId.trim().toUpperCase()) ||
      s.receivingCommitteeId.trim().toUpperCase() !== input.receivingCommitteeId.trim().toUpperCase() ||
      !Number.isInteger(input.electionYear) || input.electionYear < 2024 || input.electionYear > 2100 ||
      !isoDate(s.cycleStart) || !isoDate(s.cycleEnd) || s.cycleStart > s.cycleEnd ||
      Number(s.cycleEnd.slice(0, 4)) !== input.electionYear ||
      !(s.sourceRetrievedAt instanceof Date) || !Number.isFinite(s.sourceRetrievedAt.getTime()) ||
      !(input.syncedAt instanceof Date) || !Number.isFinite(input.syncedAt.getTime()) ||
      s.sourceRetrievedAt > input.syncedAt || !officialSource(s.sourceUrl) ||
      typeof s.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(s.sourceSha256) ||
      !cents(s.sourceByteSize) || s.sourceByteSize === 0 ||
      (s.sourcePageCount !== undefined && !count(s.sourcePageCount))) return invalid();
    const a = s.aggregation;
    if (!Array.isArray(a.groups) || !cents(a.supportAmountCents) || !cents(a.opposeAmountCents) ||
      ![a.sourceRowCount,a.candidateNameRowCount,a.candidateOfficeMismatchRowCount,a.outsideCycleRowCount,
        a.matchedRowCount,a.zeroAmountRowCount,a.includedExpenditureRowCount,a.negativeAmountRowCount,
        a.ambiguousLineageRowCount,a.timelyOverlapRowCount].every(count) ||
      (s.sourceRowCount !== undefined && s.sourceRowCount !== a.sourceRowCount) ||
      (s.sourcePageCount === 0 && a.sourceRowCount > 0) ||
      a.candidateNameRowCount > a.sourceRowCount ||
      a.candidateNameRowCount !== a.candidateOfficeMismatchRowCount + a.outsideCycleRowCount + a.matchedRowCount ||
      a.matchedRowCount !== a.zeroAmountRowCount + a.includedExpenditureRowCount ||
      a.negativeAmountRowCount !== 0 || a.ambiguousLineageRowCount !== 0 || a.timelyOverlapRowCount !== 0 ||
      !count(a.groups.length)) return invalid();
    let support = 0, oppose = 0, occurrences = 0;
    const seen = new Set<string>();
    for (const group of a.groups) {
      const optionalId = (group as { reportedCommitteeId?: unknown }).reportedCommitteeId;
      if (!name(group.reportedCommitteeName) || clean(group.reportedCommitteeName) !== group.reportedCommitteeName ||
        !name(group.reportedNameKey) || group.reportedNameKey !== group.reportedCommitteeName.toUpperCase() ||
        !["support", "oppose"].includes(group.supportOppose) ||
        !cents(group.amountCents) || group.amountCents === 0 ||
        !count(group.expenditureCount) || group.expenditureCount === 0 ||
        (optionalId !== undefined && optionalId !== null &&
          (typeof optionalId !== "string" || !/^[A-Z]\d{6}$/.test(optionalId)))) return invalid();
      const key = JSON.stringify([group.reportedNameKey,group.supportOppose]);
      if (seen.has(key)) return invalid();
      seen.add(key);
      if (group.supportOppose === "support") support = add(support,group.amountCents);
      else oppose = add(oppose,group.amountCents);
      occurrences = add(occurrences,group.expenditureCount);
    }
    const total = add(support,oppose);
    if (support !== a.supportAmountCents || oppose !== a.opposeAmountCents ||
      occurrences !== a.includedExpenditureRowCount || a.groups.length > occurrences ||
      (a.groups.length === 0) !== (occurrences === 0) ||
      (a.groups.length === 0) !== (total === 0)) return invalid();
    return { ...s,candidateId:s.candidateId.toLowerCase(),electionId:s.electionId.toLowerCase(),
      receivingCommitteeId:s.receivingCommitteeId.trim().toUpperCase(),sourceRowCount:a.sourceRowCount,aggregation:a };
  } catch { return invalid(); }
}

const sourceColumns = [
  "candidate_id","election_id","election_year","qualifying_link_id","receiving_committee_id","cycle_start","cycle_end",
  "support_amount_cents","oppose_amount_cents","group_count","expenditure_count","source_year","source_row_count",
  "source_page_count","candidate_name_row_count","candidate_office_mismatch_row_count","outside_cycle_row_count",
  "matched_row_count","zero_amount_row_count","negative_amount_row_count","ambiguous_lineage_row_count",
  "timely_overlap_row_count","source_url","source_retrieved_at","source_sha256","source_byte_size","last_synced_at",
] as const;
const sourceContextColumns = sourceColumns.filter(c => ![
  "candidate_id","election_id","election_year","qualifying_link_id","receiving_committee_id",
  "source_url","source_retrieved_at","source_sha256","last_synced_at",
].includes(c));
// Identifiers are fixed module constants; all source values remain parameters.
const upsertSourceSql = "INSERT INTO public.mo_candidate_finance_registered_ie_sources (" +
  sourceColumns.join(",") + ") VALUES (" + sourceColumns.map((_c,i) => "$" + (i+1)).join(",") +
  ") ON CONFLICT(candidate_id,election_id,election_year) DO UPDATE SET " +
  sourceColumns.slice(3).map(c => c + "=EXCLUDED." + c).join(",") +
  " WHERE mo_candidate_finance_registered_ie_sources.source_retrieved_at<EXCLUDED.source_retrieved_at" +
  " OR (mo_candidate_finance_registered_ie_sources.source_retrieved_at=EXCLUDED.source_retrieved_at" +
  " AND mo_candidate_finance_registered_ie_sources.source_sha256=EXCLUDED.source_sha256" +
  sourceContextColumns.map(c => " AND mo_candidate_finance_registered_ie_sources." + c +
    " IS NOT DISTINCT FROM EXCLUDED." + c).join("") + ") RETURNING candidate_id";

/** Only from the protected parent's transaction. Never begins/commits a second
 * transaction or touches legacy direct/IE/funder tables or their clocks. */
export async function replaceMissouriRegisteredIeRows(input: {
  db: Queryable; linkId: string; electionYear: number; syncedAt: Date;
  component: PreparedMissouriRegisteredIeComponent;
}): Promise<void> {
  if (!uuid(input.linkId) || !input.component || typeof input.component !== "object") return invalid();
  const s = prepareMissouriRegisteredIeComponent({
    component:input.component,candidateId:input.component.candidateId,electionId:input.component.electionId,
    receivingCommitteeId:input.component.receivingCommitteeId,electionYear:input.electionYear,syncedAt:input.syncedAt,
  });
  if (!s) return invalid();
  const a = s.aggregation;
  const sourceValues = [s.candidateId,s.electionId,input.electionYear,input.linkId,s.receivingCommitteeId,s.cycleStart,s.cycleEnd,
      String(a.supportAmountCents),String(a.opposeAmountCents),a.groups.length,a.includedExpenditureRowCount,input.electionYear,
      a.sourceRowCount,s.sourcePageCount ?? null,a.candidateNameRowCount,a.candidateOfficeMismatchRowCount,
      a.outsideCycleRowCount,a.matchedRowCount,a.zeroAmountRowCount,a.negativeAmountRowCount,a.ambiguousLineageRowCount,
      a.timelyOverlapRowCount,s.sourceUrl,s.sourceRetrievedAt.toISOString(),s.sourceSha256,String(s.sourceByteSize),input.syncedAt.toISOString()];
  try {
    const link = await input.db.query("SELECT id FROM public.mo_candidate_finance_links" +
      " WHERE id=$1::uuid AND election_year=$2 AND candidate_id=$3::uuid AND election_id=$4::uuid" +
      " AND committee_id=$5 AND link_status='active' FOR UPDATE",
    [input.linkId,input.electionYear,s.candidateId,s.electionId,s.receivingCommitteeId]);
    if (link.rows.length !== 1) throw new MissouriRegisteredIeWriteError("receiving_link_changed");
    const prior = await input.db.query<Record<string,unknown> & { source_retrieved_at:Date|string;source_sha256:string }>(
      "SELECT source_retrieved_at,source_sha256," +
      sourceContextColumns.map(c => c === "cycle_start" || c === "cycle_end" ? c + "::text AS " + c : c).join(",") +
      " FROM public.mo_candidate_finance_registered_ie_sources" +
      " WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND election_year=$3 FOR UPDATE",
      [s.candidateId,s.electionId,input.electionYear]);
    if (prior.rows.length > 1) throw new MissouriRegisteredIeWriteError("write_failed");
    for (const row of prior.rows) {
      const observed = new Date(row.source_retrieved_at).getTime();
      if (!Number.isFinite(observed)) throw new MissouriRegisteredIeWriteError("write_failed");
      if (observed > s.sourceRetrievedAt.getTime()) throw new MissouriRegisteredIeWriteError("older_source");
      if (observed === s.sourceRetrievedAt.getTime() && (row.source_sha256 !== s.sourceSha256 ||
        sourceContextColumns.some(c => {
          const expected = sourceValues[sourceColumns.indexOf(c)];
          return expected === null ? row[c] !== null : String(row[c]) !== String(expected);
        }))) {
        throw new MissouriRegisteredIeWriteError("source_conflict");
      }
    }
    const source = await input.db.query(upsertSourceSql,sourceValues);
    // Also protects a concurrent first insert through another receiving link,
    // where SELECT FOR UPDATE found no prior source row.
    if (source.rows.length !== 1) throw new MissouriRegisteredIeWriteError("source_not_current");
    await input.db.query("DELETE FROM public.mo_candidate_finance_registered_ie_groups" +
      " WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND election_year=$3",
    [s.candidateId,s.electionId,input.electionYear]);
    for (const group of a.groups) {
      const optionalId = (group as { reportedCommitteeId?:string|null }).reportedCommitteeId;
      await input.db.query("INSERT INTO public.mo_candidate_finance_registered_ie_groups" +
        " (candidate_id,election_id,election_year,reported_committee_name,reported_name_key,support_oppose," +
        "reported_committee_id,amount_cents,expenditure_count) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::bigint,$9)",
      [s.candidateId,s.electionId,input.electionYear,group.reportedCommitteeName,group.reportedNameKey,
        group.supportOppose,optionalId ?? null,String(group.amountCents),group.expenditureCount]);
    }
  } catch (error) {
    if (error instanceof MissouriRegisteredIeWriteError) throw error;
    throw new MissouriRegisteredIeWriteError("write_failed");
  }
}
