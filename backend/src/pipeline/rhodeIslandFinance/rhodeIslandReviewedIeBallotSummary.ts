import type { Pool, PoolClient } from "pg";
import { candidateElectionKey, type BallotLookupFinanceSummary, type BallotLookupFinanceOutsideGroup } from "../address/ballotLookupFinanceShared.js";
import { loadRhodeIslandCanonicalCashContext } from "./rhodeIslandCommitteeCashContext.js";
import { rhodeIslandReviewedIeContextMatches } from "./rhodeIslandReviewedCf8Source.js";
import { rhodeIslandReviewedIeSpenderKey } from "./rhodeIslandReviewedIeWriter.js";
import { rhodeIslandOrganizationNameMatchesCandidate } from "./rhodeIslandCandidateCommitteeResolver.js";
import { validateRhodeIslandReviewedCf8, type RhodeIslandReviewedCf8Report } from "./rhodeIslandReviewedCf8.js";

type StoredReport = Omit<RhodeIslandReviewedCf8Report, "review" | "reportedYearToDateCents" | "lines"> & {
  reportedYearToDateCents: string; occurrenceCount: number; reportCents: string;
  lines: { lineNumber: number; disbursementDate: string; amountCents: string }[];
};
type Family = {
  id: string; candidate_id: string; election_id: string; election_year: number; spender_key: string; spender_name: string;
  candidate_name: string; office_scope: string; office_name: string; district: string | null;
  observed_at: string; completed_at: string; source_digest: string; source_url: string; source_report_count: number;
  ie_report_count: number; occurrence_count: number; support_cents: string; oppose_cents: string; reports: StoredReport[];
};
function check(v: unknown): asserts v { if (!v) throw Error("stored_reviewed_ie_controls"); }
function cents(s: string): number { check(typeof s === "string" && /^(0|[1-9]\d*)$/u.test(s)); const n = Number(s); check(Number.isSafeInteger(n)); return n; }
const review = { purpose: "independent_expenditure", candidateCount: 1, referendumCount: 0, wholeReportRead: true,
  completeDisbursements: true, payerIdentityVerified: true, candidateElectionVerified: true } as const;

/** All stored reports/occurrences are checked before display caps. This is
 * selective manually reviewed coverage: candidate-wide totals remain unknown.
 * Existing legacy outside evidence is preserved until overlap is qualified.
 */
export async function appendRhodeIslandReviewedIeSummaries(db: Pick<Pool | PoolClient, "query">,
  requests: readonly { candidate_id: string; election_id: string }[], summaries: Map<string, BallotLookupFinanceSummary>) {
  if (!requests.length) return;
  const result = await db.query<Family>(`WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid,election_id uuid)
  ) SELECT f.*,f.observed_at::text,f.completed_at::text,f.support_cents::text,f.oppose_cents::text,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('filingGuid',r.filing_guid,'sourceUrl',r.source_url,
      'sourceSha256',r.source_sha256,'filedDate',r.filed_date::text,'reportedSpenderName',r.reported_spender_name,
      'reportedCandidateName',r.reported_candidate_name,'supportOppose',r.stance,'reportedYearToDateCents',r.reported_ytd_cents::text,
      'occurrenceCount',r.occurrence_count,'reportCents',r.report_cents::text,'lines',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('lineNumber',l.line_number,'disbursementDate',l.disbursement_date::text,
          'amountCents',l.amount_cents::text) ORDER BY l.line_number) FROM public.ri_reported_ie_lines l WHERE l.filing_guid=r.filing_guid
      ),'[]'::jsonb)) ORDER BY r.filing_guid) FROM public.ri_reported_ie_reports r WHERE r.family_id=f.id),'[]'::jsonb) reports
    FROM requested JOIN public.ri_reported_ie_families f USING(candidate_id,election_id)
    ORDER BY f.candidate_id,f.election_id,f.id`, [JSON.stringify(requests)]);
  const byCandidate = new Map<string, Family[]>();
  for (const f of result.rows) { const key = candidateElectionKey(f.candidate_id,f.election_id);
    const rows = byCandidate.get(key) ?? []; rows.push(f); byCandidate.set(key,rows); }
  for (const [key, families] of byCandidate) {
    const first = families[0]!, previous = summaries.get(key), outside = previous?.outside_spending;
    if (outside && (outside.support_total !== null || outside.oppose_total !== null || outside.top_supporting_groups.length ||
      outside.top_opposing_groups.length || outside.top_supporting_industries.length || outside.top_opposing_industries.length ||
      outside.unallocated_candidate_edges?.length)) continue;
    const actual = await loadRhodeIslandCanonicalCashContext(db, first.candidate_id,first.election_id, { anyElectionDate: true });
    const groups: BallotLookupFinanceOutsideGroup[] = [], seen = new Set<string>();
    let earliest = Infinity, latest = -Infinity;
    try {
      for (const f of families) {
        check(rhodeIslandReviewedIeContextMatches(actual, { candidateId:f.candidate_id,electionId:f.election_id,
          candidateName:f.candidate_name,electionYear:f.election_year,officeScope:f.office_scope,officeName:f.office_name,district:f.district }));
        check(!seen.has(f.spender_key) && f.spender_key === rhodeIslandReviewedIeSpenderKey(f.spender_name)); seen.add(f.spender_key);
        const observed = Date.parse(f.observed_at), completed = Date.parse(f.completed_at);
        check(Number.isFinite(observed) && Number.isFinite(completed) && completed >= observed && completed <= Date.now()+300_000 &&
          /^[a-f0-9]{64}$/u.test(f.source_digest) && Number.isInteger(f.source_report_count) &&
          f.source_report_count >= f.ie_report_count && f.source_report_count <= 100);
        check(Array.isArray(f.reports) && f.reports.length === f.ie_report_count);
        const reports = f.reports.map(r => {
          check(rhodeIslandOrganizationNameMatchesCandidate(r.reportedCandidateName,f.candidate_name) && Array.isArray(r.lines) && r.lines.length === r.occurrenceCount);
          const lines = r.lines.map(l => ({ ...l, amountCents:cents(l.amountCents) }));
          const total = lines.reduce((sum,l) => sum+l.amountCents,0);
          check(Number.isSafeInteger(total) && total === cents(r.reportCents));
          return { ...r, review, reportedYearToDateCents:cents(r.reportedYearToDateCents), lines };
        });
        const draft = validateRhodeIslandReviewedCf8({ electionYear:f.election_year, spenderName:f.spender_name,
          asOfDate:new Date(completed).toISOString().slice(0,10), reports,
          family: reports.map(r => ({ filedDate:r.filedDate,filingType:"INDEPENDENT EXPENDITURE",organizationName:f.spender_name,sourceUrl:r.sourceUrl })) });
        check(draft.supportCents === cents(f.support_cents) && draft.opposeCents === cents(f.oppose_cents) && draft.occurrenceCount === f.occurrence_count);
        const latestReport = [...reports].sort((a,b) => b.filedDate.localeCompare(a.filedDate) || a.filingGuid.localeCompare(b.filingGuid))[0];
        check(latestReport && latestReport.sourceUrl === f.source_url);
        for (const stance of ["support","oppose"] as const) {
          const subset = reports.filter(r => r.supportOppose === stance), amount = stance === "support" ? draft.supportCents : draft.opposeCents;
          if (amount > 0) groups.push({ committee_id:`reviewed:${f.spender_key}:${stance}`,committee_name:f.spender_name,
            support_oppose:stance,amount:amount/100,expenditure_count:subset.reduce((n,r) => n+r.lines.length,0),
            source_url:[...subset].sort((a,b) => b.filedDate.localeCompare(a.filedDate))[0]!.sourceUrl });
        }
        earliest = Math.min(earliest,observed); latest = Math.max(latest,completed);
      }
    } catch { continue; }
    const summary = previous ?? { source:"RHODE_ISLAND_ERTS" as const,cycle:first.election_year,fec_candidate_id:null,
      last_synced_at:new Date(earliest).toISOString(),direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_industries:[]},
      outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]},
      backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]} } satisfies BallotLookupFinanceSummary;
    groups.sort((a,b) => b.amount-a.amount || a.committee_id.localeCompare(b.committee_id));
    summary.outside_spending = { ...summary.outside_spending, amount_basis:"reported_ie_disbursements", support_total:null,oppose_total:null,
      top_supporting_groups:groups.filter(g => g.support_oppose === "support").slice(0,5),top_opposing_groups:groups.filter(g => g.support_oppose === "oppose").slice(0,5),
      outside_coverage_note:`Selected manually reviewed single-candidate CF-8 reports from ${families.length} filer ${families.length === 1 ? "family" : "families"}. `+
        "Amounts are reported IE disbursements, made on first public dissemination; cash payment is not established. Candidate-wide support and opposition totals are unknown. "+
        "Other unreviewed filings, multi-target filings without a stated split, covered transfers and electioneering communications are excluded. "+
        `Originals observed ${new Date(earliest).toISOString()} through ${new Date(latest).toISOString()}; other components may cover different reports.` };
    summaries.set(key,summary);
  }
}
