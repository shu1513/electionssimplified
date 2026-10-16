import type { Pool } from "pg";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import { GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./georgiaFinanceEligibleOffices.js";
import type { GeorgiaFinanceLinkSource } from "./georgiaFinanceWriter.js";
import type { GeorgiaReportedFinanceReceiver } from "./georgiaReportedFinanceTypes.js";
import type { GeorgiaReportedSourceFacts } from "./georgiaReportedFinanceSourceCache.js";

// Reuse the canonical eligibility query. These independent components need
// capture-aware freshness and durable failure rotation instead of direct
// summary freshness, so only scheduling the complete eligible result differs.
const listEligible = createStandardStateFinanceDueListQuery({
  state: "GA", tables: {links: "ga_candidate_finance_links", summaries: "ga_candidate_finance_summaries"},
  eligibleOfficeKeys: GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS, selectElectionDate: true,
  linkColumns: ["id", "committee_id", "committee_name", "link_source"],
  mapRow: (r): GeorgiaReportedFinanceReceiver => ({linkId: String(r.id), candidateId: r.candidate_id,
    electionId: r.election_id, candidateName: r.candidate_name, electionYear: r.election_year,
    electionDate: r.election_date!, officeScope: r.office_scope, officeName: r.office_name,
    district: r.district, committeeId: String(r.committee_id), committeeName: String(r.committee_name),
    linkSource: r.link_source as GeorgiaFinanceLinkSource, sourceUrl: r.source_url, lastSyncedAt: r.last_synced_at}),
});
export type GeorgiaReportedFinanceGates = {ie: boolean; contributions: boolean};
export const georgiaReportedComponentMask = (g: GeorgiaReportedFinanceGates): number => (g.ie ? 2 : 0) | (g.contributions ? 4 : 0);
type Metadata = {link_id: string; last_attempted_at: string | null; component_mask: number | null;
  ie_clock?: string | null; ie_manifest?: string | null; ie_receiver?: string | null; ie_filing_year?: number | null;
  contributions_clock?: string | null; contributions_manifest?: string | null;
  contributions_receiver?: string | null; contributions_filing_year?: number | null};
export type GeorgiaReportedFinanceDueInput = {
  now: Date; electionYear: number; filingYear: number; maxCandidates: number; staleAfterDays: number;
  electionLookbackDays: number; electionLookaheadDays: number; refresh: boolean;
  gates: GeorgiaReportedFinanceGates;
  ieSource: GeorgiaReportedSourceFacts | null; contributionSource: GeorgiaReportedSourceFacts | null;
};
const clock = (s: string | null | undefined): number => s ? Date.parse(s) : NaN;
export async function listDueGeorgiaReportedFinance(db: Pick<Pool, "query">, input: GeorgiaReportedFinanceDueInput) {
  const mask = georgiaReportedComponentMask(input.gates);
  if (!mask) return {eligibleCount: 0, totalDueRows: 0, rows: [] as GeorgiaReportedFinanceReceiver[]};
  const eligible = await listEligible(db, {...input, maxCandidates: 100_000, refresh: true});
  if (eligible.rows.length !== eligible.totalDueRows) throw new Error("Georgia reported finance eligibility enumeration incomplete");
  if (!eligible.rows.length) return {eligibleCount: 0, totalDueRows: 0, rows: [] as GeorgiaReportedFinanceReceiver[]};
  const selects = ["link.id::text AS link_id", "attempt.last_attempted_at::text", "attempt.component_mask"];
  const joins = ["LEFT JOIN public.ga_reported_finance_attempts attempt ON attempt.link_id = link.id AND attempt.election_year = link.election_year"];
  for (const [enabled, alias, table] of [
    [input.gates.ie, "ie", "ga_reported_ie_sources"],
    [input.gates.contributions, "contributions", "ga_reported_committee_sources"],
  ] as const) {
    if (!enabled) continue;
    selects.push(`${alias}.source_retrieved_at::text AS ${alias}_clock`, `${alias}.source_manifest_sha256 AS ${alias}_manifest`,
      `${alias}.receiving_committee_id AS ${alias}_receiver`, `${alias}.filing_year AS ${alias}_filing_year`);
    joins.push(`LEFT JOIN public.${table} ${alias} ON ${alias}.link_id = link.id AND ${alias}.election_year = link.election_year`);
  }
  const result = await db.query<Metadata>(`SELECT ${selects.join(", ")} FROM public.ga_candidate_finance_links link
    ${joins.join("\n")} WHERE link.id = ANY($1::uuid[])`, [eligible.rows.map(r => r.linkId)]);
  const byLink = new Map(result.rows.map(r => [r.link_id, r]));
  if (byLink.size !== eligible.rows.length) throw new Error("Georgia reported finance scheduling context incomplete");
  const now = input.now.getTime(), stale = now - input.staleAfterDays * 86_400_000;
  const newestCapture = Math.max(-Infinity, ...[input.gates.ie ? clock(input.ieSource?.sourceRetrievedAt) : NaN,
    input.gates.contributions ? clock(input.contributionSource?.sourceRetrievedAt) : NaN].filter(Number.isFinite));
  const due = eligible.rows.filter(row => {
    const meta = byLink.get(row.linkId)!;
    const needs = (kind: "ie" | "contributions", source: GeorgiaReportedSourceFacts | null): boolean => {
      const stored = clock(meta[`${kind}_clock`]);
      return !Number.isFinite(stored) || stored > now || stored < stale || meta[`${kind}_receiver`] !== row.committeeId ||
        meta[`${kind}_filing_year`] !== input.filingYear || !!source &&
        (stored < clock(source.sourceRetrievedAt) || stored === clock(source.sourceRetrievedAt) &&
          meta[`${kind}_manifest`] !== source.sourceManifestSha256);
    };
    if (!input.refresh && !(input.gates.ie && needs("ie", input.ieSource) ||
      input.gates.contributions && needs("contributions", input.contributionSource))) return false;
    const attempted = clock(meta.last_attempted_at);
    return input.refresh || !Number.isFinite(attempted) || attempted > now || attempted <= now - 86_400_000 ||
      meta.component_mask !== mask || newestCapture > attempted;
  });
  due.sort((a, b) => {
    const am = byLink.get(a.linkId)!, bm = byLink.get(b.linkId)!;
    const attempt = (m: Metadata) => Number.isFinite(clock(m.last_attempted_at)) ? clock(m.last_attempted_at) : -Infinity;
    return attempt(am) - attempt(bm) || a.electionDate.localeCompare(b.electionDate) ||
      a.candidateName.localeCompare(b.candidateName) || a.linkId.localeCompare(b.linkId);
  });
  return {eligibleCount: eligible.rows.length, totalDueRows: due.length, rows: due.slice(0, input.maxCandidates)};
}

/** Nonfinancial attempts may rotate held ambiguous links; money writers
 * independently lock and require a unique current receiving context. */
export async function recordGeorgiaReportedFinanceAttempt(input: {
  db: Pick<Pool, "query">; receiver: GeorgiaReportedFinanceReceiver; now: Date; gates: GeorgiaReportedFinanceGates;
}): Promise<boolean> {
  const r = input.receiver, mask = georgiaReportedComponentMask(input.gates);
  if (!mask) return false;
  const result = await input.db.query(`INSERT INTO public.ga_reported_finance_attempts
    (link_id, election_year, last_attempted_at, component_mask)
    SELECT link.id, link.election_year, $8::timestamptz, $9::int
    FROM public.ga_candidate_finance_links link
    JOIN public.candidates c ON c.id = link.candidate_id
    JOIN public.candidate_elections ce ON ce.candidate_id = link.candidate_id AND ce.election_id = link.election_id
    JOIN public.elections e ON e.id = link.election_id
    JOIN public.districts d ON d.id = e.district_id
    JOIN public.offices o ON o.id = e.office_id
    WHERE link.id = $1::uuid AND link.election_year = $2::int AND link.candidate_id = $3::uuid
      AND link.election_id = $4::uuid AND link.committee_id = $5 AND link.link_source = $6
      AND link.link_status = 'active' AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn', 'lost')
      AND d.state = 'GA' AND e.race_type = 'office' AND e.election_date = $7::date
      AND EXTRACT(YEAR FROM e.election_date)::int = $2::int
      AND (o.scope || '::' || o.canonical_name) = ANY($10::text[])
    ON CONFLICT (link_id, election_year) DO UPDATE SET last_attempted_at = EXCLUDED.last_attempted_at,
      component_mask = EXCLUDED.component_mask
    WHERE ga_reported_finance_attempts.last_attempted_at < EXCLUDED.last_attempted_at OR
      (ga_reported_finance_attempts.last_attempted_at = EXCLUDED.last_attempted_at AND
       ga_reported_finance_attempts.component_mask = EXCLUDED.component_mask)
    RETURNING link_id`, [r.linkId, r.electionYear, r.candidateId, r.electionId, r.committeeId, r.linkSource,
    r.electionDate, input.now.toISOString(), mask, [...GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS]]);
  return result.rowCount === 1;
}
