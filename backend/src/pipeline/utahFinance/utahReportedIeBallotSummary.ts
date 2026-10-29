import type { Pool, PoolClient } from "pg";
import type {
  BallotLookupFinanceOutsideGroup,
  BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import {
  parseUtahIePurpose,
  utahIePersonKey,
  utahIeRegistryUrl,
} from "./utahReportedIeSource.js";

type Row = {
  candidate_id: string;
  election_id: string;
  election_year: number;
  candidate_name: string;
  district: string;
  observed_at: string;
  source_url: string;
  attributed_count: number;
  estimate_cents: string;
  transaction_id: string | null;
  folder_id: string | null;
  report_url: string | null;
  payer_name: string | null;
  amount_cents: string | null;
  stance: string | null;
  purpose: string | null;
};
export const UTAH_IE_ESTIMATE_NOTE =
  "Filer-reported estimates from current filed Utah Independent Expenditures statements with explicit single-candidate targets. Amounts are estimates, not verified cash payments. Unallocated expenses and other filing classes are excluded; candidate-wide support and opposition totals remain unknown.";
export async function appendUtahReportedIeSummaries(
  db: Pick<Pool | PoolClient, "query">,
  requests: readonly { candidate_id: string; election_id: string }[],
  summaries: Map<string, BallotLookupFinanceSummary>,
): Promise<void> {
  const result = await db.query<Row>(
    `WITH requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid,election_id uuid))
    SELECT s.candidate_id::text,s.election_id::text,s.election_year,s.candidate_name,s.district,s.observed_at::text,s.source_url,
      s.attributed_count,s.estimate_cents::text,x.transaction_id,x.folder_id,x.report_url,x.payer_name,x.amount_cents::text,x.stance,x.purpose
    FROM requested JOIN public.ut_reported_ie_sources s USING(candidate_id,election_id)
    JOIN public.candidate_elections ce USING(candidate_id,election_id) JOIN public.candidates c ON c.id=ce.candidate_id
    JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
    LEFT JOIN public.ut_reported_ie_occurrences x ON x.candidate_id=s.candidate_id AND x.election_id=s.election_id
    WHERE c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost') AND d.state='UT' AND e.race_type='office'
      AND e.election_stage=s.election_stage AND extract(year FROM e.election_date)::integer=s.election_year
      AND o.scope=s.office_scope AND o.canonical_name=s.office_name AND o.scope='state_upper' AND o.canonical_name='State Senator'
      AND COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name))=s.candidate_name
      AND NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') IS NOT DISTINCT FROM s.district
    ORDER BY s.candidate_id,s.election_id,x.folder_id,x.transaction_id`,
    [JSON.stringify(requests)],
  );
  const candidates = new Map<string, Row[]>();
  for (const row of result.rows) {
    const k = `${row.candidate_id}\0${row.election_id}`;
    const rows = candidates.get(k) ?? [];
    rows.push(row);
    candidates.set(k, rows);
  }
  for (const [k, rows] of candidates) {
    const first = rows[0]!,
      groups = new Map<string, BallotLookupFinanceOutsideGroup>(),
      ids = new Set<string>();
    let total = 0,
      valid = true;
    try {
      if (
        rows.length !== first.attributed_count ||
        !Number.isFinite(Date.parse(first.observed_at)) ||
        utahIeRegistryUrl(first.election_year) !== first.source_url
      )
        continue;
      for (const row of rows) {
        const cents = Number(row.amount_cents),
          target = parseUtahIePurpose(row.purpose ?? "");
        if (
          !row.transaction_id ||
          !/^\d+$/.test(row.transaction_id) ||
          ids.has(row.transaction_id) ||
          !row.folder_id ||
          !/^\d+$/.test(row.folder_id) ||
          !row.payer_name?.trim() ||
          row.payer_name.length > 500 ||
          !Number.isSafeInteger(cents) ||
          cents <= 0 ||
          !target ||
          target.stance !== row.stance ||
          utahIePersonKey(target.name) !==
            utahIePersonKey(first.candidate_name) ||
          Number(target.district) !== Number(first.district) ||
          !row.report_url ||
          !/^https:\/\/disclosures[.]utah[.]gov\/Search\/PublicSearch\/Report\/\d+$/.test(
            row.report_url,
          )
        ) {
          valid = false;
          break;
        }
        ids.add(row.transaction_id);
        total += cents;
        if (!Number.isSafeInteger(total)) {
          valid = false;
          break;
        }
        const groupKey = `${row.folder_id}\0${row.stance}`,
          group = groups.get(groupKey) ?? {
            committee_id: `INDEXP:${row.folder_id}`,
            committee_name: row.payer_name,
            support_oppose: row.stance as "support" | "oppose",
            amount: 0,
            expenditure_count: 0,
            source_url: row.report_url,
          };
        if (group.committee_name !== row.payer_name) {
          valid = false;
          break;
        }
        const groupCents = Math.round(group.amount * 100) + cents;
        if (
          !Number.isSafeInteger(groupCents) ||
          Math.round((groupCents / 100) * 100) !== groupCents
        ) {
          valid = false;
          break;
        }
        group.amount = groupCents / 100;
        group.expenditure_count = (group.expenditure_count ?? 0) + 1;
        groups.set(groupKey, group);
      }
    } catch {
      valid = false;
    }
    if (!valid || String(total) !== first.estimate_cents) continue;
    let summary = summaries.get(k);
    if (!summary) {
      summary = {
        source: "UTAH_DISCLOSURES",
        cycle: first.election_year,
        fec_candidate_id: null,
        last_synced_at: first.observed_at,
        direct_campaign: {
          total_raised: null,
          total_spent: null,
          cash_on_hand: null,
          debts_owed: null,
          top_occupations: [],
          top_employers: [],
          top_industries: [],
        },
        outside_spending: {
          support_total: null,
          oppose_total: null,
          top_supporting_groups: [],
          top_opposing_groups: [],
          top_supporting_industries: [],
          top_opposing_industries: [],
        },
        backing_summary: {
          top_direct_donor_occupations: [],
          top_outside_supporting_industries: [],
        },
      };
      summaries.set(k, summary);
    }
    const sorted = [...groups.values()].sort(
      (a, b) =>
        b.amount - a.amount || a.committee_id.localeCompare(b.committee_id),
    );
    summary.outside_spending = {
      ...summary.outside_spending,
      support_total: null,
      oppose_total: null,
      spending_basis: "reported_estimates",
      top_supporting_groups: sorted
        .filter((g) => g.support_oppose === "support")
        .slice(0, 5),
      top_opposing_groups: sorted
        .filter((g) => g.support_oppose === "oppose")
        .slice(0, 5),
      outside_coverage_note: `${UTAH_IE_ESTIMATE_NOTE} IE statements observed ${new Date(first.observed_at).toISOString().slice(0, 10)}; direct and donor data may cover different reports.`,
    };
  }
}
