import type { Pool, PoolClient } from "pg";
import { isPhoenixReviewedEfdEnabled } from "../../config/featureFlags.js";
import { candidateElectionKey, type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceSummary } from "../address/ballotLookupFinanceShared.js";
import { phoenixPersonNameMatchesCandidate } from "./phoenixCandidateCommitteeResolver.js";
import { efdCheck, efdNameKey, PHOENIX_EFD_INDEX_URL, PHOENIX_EFD_REVIEW,
  validatePhoenixReviewedEfd, phoenixEfdObservationDay } from "./phoenixReviewedEfd.js";
import { loadPhoenixEfdContext, phoenixEfdContextMatches, type PhoenixEfdContext } from "./phoenixReviewedEfdContext.js";
import type { StoredPhoenixEfdReport } from "./phoenixReviewedEfdWriter.js";

type Family = {
  id: string; candidate_id: string; election_id: string; election_year: number;
  spender_name: string; spender_name_key: string; canonical_context: PhoenixEfdContext;
  observed_at: string; completed_at: string; source_digest: string; source_url: string;
  occurrence_count: number; support_cents: string; oppose_cents: string; reports: StoredPhoenixEfdReport[];
};
function cents(value: string): number {
  efdCheck(typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value), "stored_exact_cents");
  const result = Number(value); efdCheck(Number.isSafeInteger(result), "stored_safe_cents"); return result;
}

/** All reports and controls are checked before display caps. These are
 * reported EFD allocations, not statutory IE totals or donor receipts. */
export async function appendPhoenixReviewedEfdSummaries(db: Pick<Pool | PoolClient, "query">,
  requests: readonly { candidate_id: string; election_id: string }[], summaries: Map<string, BallotLookupFinanceSummary>): Promise<void> {
  if (!isPhoenixReviewedEfdEnabled() || !requests.length) return;
  const result = await db.query<Family>(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) r(candidate_id uuid,election_id uuid)
    ) SELECT f.*,f.observed_at::text,f.completed_at::text,f.support_cents::text,f.oppose_cents::text,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('document_id',r.document_id,'source_url',r.source_url,
        'source_sha256',r.source_sha256,'filed_date',r.filed_date::text,'reported_spender_name',r.reported_spender_name,
        'reported_candidate_name',r.reported_candidate_name,'reported_office',r.reported_office,
        'reported_district_number',r.reported_district_number,'vendor_name',r.vendor_name,
        'expenditure_date',r.expenditure_date::text,'amount_cents',r.amount_cents::text,'stance',r.stance,
        'reviewed_page_count',r.reviewed_page_count) ORDER BY r.document_id)
        FROM public.phx_reported_efd_reports r WHERE r.family_id=f.id),'[]'::jsonb) reports
    FROM requested JOIN public.phx_reported_efd_families f USING(candidate_id,election_id)
    ORDER BY f.candidate_id,f.election_id,f.id`, [JSON.stringify(requests)]);
  if (!result.rows.length) return;
  // The legacy display query is capped. Overlap must use every stored payer,
  // including one hidden below that cap, before adding an EFD allocation.
  const legacyPayers = await db.query<{ candidate_id: string; election_id: string; spender_name: string }>(`
    WITH requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) r(candidate_id uuid,election_id uuid))
    SELECT l.candidate_id::text,l.election_id::text,g.spender_name FROM requested
    JOIN public.phx_candidate_finance_links l USING(candidate_id,election_id)
    JOIN public.phx_candidate_finance_outside_groups g ON g.link_id=l.id AND g.election_year=l.election_year
    WHERE l.link_status='active'`, [JSON.stringify(requests)]);
  const allLegacyNames = new Map<string, Set<string>>();
  for (const row of legacyPayers.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id), names = allLegacyNames.get(key) ?? new Set<string>();
    names.add(efdNameKey(row.spender_name)); allLegacyNames.set(key, names);
  }
  const candidates = new Map<string, Family[]>();
  for (const f of result.rows) {
    const key = candidateElectionKey(f.candidate_id, f.election_id), rows = candidates.get(key) ?? [];
    rows.push(f); candidates.set(key, rows);
  }
  for (const [key, families] of candidates) {
    const first = families[0]!, previous = summaries.get(key);
    const legacy = [...(previous?.outside_spending.top_supporting_groups ?? []), ...(previous?.outside_spending.top_opposing_groups ?? [])];
    const legacyNames = new Set([...legacy.map(group => efdNameKey(group.committee_name)), ...(allLegacyNames.get(key) ?? [])]);
    const groups: BallotLookupFinanceOutsideGroup[] = [];
    let reportCount = 0, filerCount = 0, overlaps = 0, earliest = Infinity, latest = -Infinity;
    try {
      const actual = await loadPhoenixEfdContext(db, first.candidate_id, first.election_id);
      const names = new Set<string>(), documents = new Set<string>();
      for (const f of families) {
        efdCheck(phoenixEfdContextMatches(actual, f.canonical_context) && f.election_year === actual.electionYear &&
          f.spender_name_key === efdNameKey(f.spender_name) && !names.has(f.spender_name_key), "stored_canonical_family");
        names.add(f.spender_name_key);
        const observed = Date.parse(f.observed_at), completed = Date.parse(f.completed_at);
        efdCheck(Number.isFinite(observed) && Number.isFinite(completed) && completed >= observed &&
          completed <= Date.now() + 300_000 && /^[a-f0-9]{64}$/u.test(f.source_digest) &&
          f.source_url === PHOENIX_EFD_INDEX_URL && Array.isArray(f.reports) && f.reports.length === f.occurrence_count,
        "stored_source_controls");
        const reports = f.reports.map(r => {
          efdCheck(!documents.has(r.document_id), "stored_document_owned_twice"); documents.add(r.document_id);
          efdCheck(phoenixPersonNameMatchesCandidate(r.reported_candidate_name, actual.candidateName) &&
            (r.reported_district_number === null || r.reported_district_number === actual.districtNumber), "stored_target_conflict");
          return { documentId: r.document_id, sourceUrl: r.source_url, sourceSha256: r.source_sha256,
            filedDate: r.filed_date, reportedSpenderName: r.reported_spender_name,
            reportedCandidateName: r.reported_candidate_name, reportedOffice: r.reported_office,
            reportedDistrictNumber: r.reported_district_number, vendorName: r.vendor_name,
            expenditureDate: r.expenditure_date, amountCents: cents(r.amount_cents), supportOppose: r.stance,
            reviewedPageCount: r.reviewed_page_count, review: PHOENIX_EFD_REVIEW };
        });
        const draft = validatePhoenixReviewedEfd({ spenderName: f.spender_name, electionDate: actual.electionDate,
          asOfDate: phoenixEfdObservationDay(f.observed_at), reports,
          family: reports.map(r => ({ documentId: r.documentId, sourceUrl: r.sourceUrl, filedDate: r.filedDate, spenderName: f.spender_name })) });
        efdCheck(draft.supportCents === cents(f.support_cents) && draft.opposeCents === cents(f.oppose_cents) &&
          draft.occurrenceCount === f.occurrence_count, "stored_full_report_reconciliation");
        if (legacyNames.has(f.spender_name_key)) { overlaps++; continue; }
        for (const stance of ["support", "oppose"] as const) {
          const amount = stance === "support" ? draft.supportCents : draft.opposeCents;
          if (amount > 0) groups.push({ committee_id: `efd:${f.id}:${stance}`, committee_name: f.spender_name,
            support_oppose: stance, amount: amount / 100,
            expenditure_count: reports.filter(r => r.supportOppose === stance).length, source_url: PHOENIX_EFD_INDEX_URL });
        }
        reportCount += draft.occurrenceCount; filerCount++;
        earliest = Math.min(earliest, observed); latest = Math.max(latest, completed);
      }
    } catch { continue; } // Invalid stored data never becomes a plausible partial total.
    if (!groups.length && !previous) continue;
    const summary = previous ?? { source: "PHOENIX_CITY_CLERK" as const, cycle: first.election_year,
      fec_candidate_id: null, last_synced_at: new Date(earliest).toISOString(),
      direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
        top_occupations: [], top_industries: [] },
      outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [],
        top_supporting_industries: [], top_opposing_industries: [] },
      backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } } satisfies BallotLookupFinanceSummary;
    const note = filerCount ? `Selected, manually reviewed Election Funding Disclosures report ${reportCount} ${reportCount === 1 ? "expenditure" : "expenditures"} from ${filerCount} named ${filerCount === 1 ? "filer" : "filers"}. ` +
      "These reports do not establish statutory independence, cash payment, or complete outside spending. Names are as reported; undisclosed original funders are not inferred. " +
      `Source checked ${phoenixEfdObservationDay(new Date(earliest).toISOString())} through ${phoenixEfdObservationDay(new Date(latest).toISOString())}; other components may cover different reports.` : "";
    const merged = [...legacy, ...groups].sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id));
    summary.outside_spending = { ...summary.outside_spending, support_total: null, oppose_total: null,
      top_supporting_groups: merged.filter(g => g.support_oppose === "support").slice(0, 5),
      top_opposing_groups: merged.filter(g => g.support_oppose === "oppose").slice(0, 5),
      outside_coverage_note: [summary.outside_spending.outside_coverage_note, note,
        overlaps ? "Additional EFD amounts with overlapping payer names are withheld until overlap is resolved." : "",
        "Overall outside support and opposition totals remain unknown."].filter(Boolean).join(" ") };
    summaries.set(key, summary);
  }
}
