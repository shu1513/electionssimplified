import type { Pool, PoolClient } from "pg";
import {
  candidateElectionKey,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
  type BallotLookupFinanceOutsideGroup,
} from "../address/ballotLookupFinanceShared.js";
type Row = {
  candidate_id: string;
  election_id: string;
  election_year: number;
  support_cents: string;
  oppose_cents: string;
  group_count: number;
  allocation_count: number;
  source_observed_at: string;
  last_synced_at: string;
  financial_basis: string;
  payer_guid: string | null;
  filing_entity_id: string | null;
  committee_name: string | null;
  stance: "support" | "oppose" | null;
  amount_cents: string | null;
  source_url: string | null;
};
const cents = (v: unknown) => {
  if (
    typeof v !== "string" ||
    !/^\d+$/.test(v) ||
    !Number.isSafeInteger(Number(v))
  )
    throw Error("invalid_outside_component");
  return Number(v);
};
function empty(row: Row): BallotLookupFinanceSummary {
  return {
    source: "MARYLAND_CFS",
    cycle: row.election_year,
    fec_candidate_id: null,
    controlled_committee_id: null,
    last_synced_at: new Date(row.source_observed_at).toISOString(),
    direct_campaign: {
      total_raised: null,
      total_spent: null,
      cash_on_hand: null,
      debts_owed: null,
      top_occupations: [],
      top_employers: [],
      top_industries: [],
      contribution_size_buckets: [],
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
}
/** Validate every stored group before display caps. There is no dependency on
 * a receiving link or direct summary, and direct/donor money is preserved. */
export async function attachMarylandIndependentOutsideFinance(input: {
  db: Pick<Pool | PoolClient, "query">;
  summaries: Map<string, BallotLookupFinanceSummary>;
  requests: readonly StateFinanceSummaryRequest[];
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!input.requests.length) return input.summaries;
  let rows: Row[];
  try {
    const result = await input.db.query<Row>(
      `WITH selected AS (SELECT candidate_id,election_id
      FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid,election_id uuid))
      SELECT s.candidate_id::text,s.election_id::text,s.election_year,s.support_cents::text,s.oppose_cents::text,
        s.group_count,s.allocation_count,s.source_observed_at::text,s.last_synced_at::text,s.financial_basis,
        g.payer_guid::text,g.filing_entity_id::text,g.committee_name,g.stance,g.amount_cents::text,g.source_url
      FROM selected r JOIN public.md_candidate_finance_ie_sources s USING(candidate_id,election_id)
      JOIN public.candidate_elections ce USING(candidate_id,election_id)
      JOIN public.candidates c ON c.id=s.candidate_id JOIN public.elections e ON e.id=s.election_id
      JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
      LEFT JOIN public.md_candidate_finance_ie_groups g USING(candidate_id,election_id)
      WHERE d.state='MD' AND c.deleted_at IS NULL AND c.merged_into_candidate_id IS NULL
        AND ce.status NOT IN ('withdrawn','lost') AND e.race_type='office' AND e.election_stage='general'
        AND s.election_year=EXTRACT(YEAR FROM e.election_date)::integer
        AND s.canonical_context->>'candidateName'=c.display_name AND s.canonical_context->>'party'=c.party
        AND s.canonical_context->>'officeScope'=o.scope AND s.canonical_context->>'officeName'=o.canonical_name
        AND s.canonical_context->>'districtGeoidCompact'=d.geoid_compact
        AND s.canonical_context->>'electionDate'=e.election_date::text
        AND s.canonical_context->>'electionStage'=e.election_stage
      ORDER BY s.candidate_id,s.election_id,g.payer_guid,g.stance`,
      [JSON.stringify(input.requests)],
    );
    rows = result.rows;
  } catch {
    return input.summaries;
  }
  const candidates = new Map<string, Row[]>();
  for (const r of rows) {
    const k = candidateElectionKey(r.candidate_id, r.election_id),
      group = candidates.get(k) ?? [];
    group.push(r);
    candidates.set(k, group);
  }
  const output = new Map(input.summaries);
  for (const [k, stored] of candidates)
    try {
      const source = stored[0]!;
      if (
        !Number.isInteger(source.election_year) ||
        !Number.isSafeInteger(source.group_count) ||
        source.group_count < 0 ||
        !Number.isSafeInteger(source.allocation_count) ||
        source.allocation_count < source.group_count ||
        source.financial_basis !==
          "complete_native_ie_with_current_report_controls" ||
        !Number.isFinite(Date.parse(source.source_observed_at)) ||
        !Number.isFinite(Date.parse(source.last_synced_at)) ||
        Date.parse(source.source_observed_at) >
          Date.parse(source.last_synced_at)
      )
        throw Error();
      const groups: BallotLookupFinanceOutsideGroup[] = [],
        ids = new Set<string>();
      let support = 0,
        oppose = 0;
      for (const row of stored) {
        if (row.payer_guid === null) {
          if (
            stored.length !== 1 ||
            source.group_count !== 0 ||
            row.amount_cents !== null
          )
            throw Error();
          continue;
        }
        const identity = `${row.payer_guid}:${row.stance}`;
        if (
          ids.has(identity) ||
          !row.committee_name?.trim() ||
          !row.filing_entity_id ||
          !/^[1-9]\d*$/.test(row.filing_entity_id) ||
          !["support", "oppose"].includes(row.stance ?? "")
        )
          throw Error();
        ids.add(identity);
        const amount = cents(row.amount_cents);
        if (!amount) throw Error();
        if (row.stance === "support") support += amount;
        else oppose += amount;
        if (!Number.isSafeInteger(support) || !Number.isSafeInteger(oppose))
          throw Error();
        groups.push({
          committee_id: row.filing_entity_id,
          committee_name: row.committee_name,
          support_oppose: row.stance!,
          amount: amount / 100,
          source_url: row.source_url,
        });
      }
      if (
        groups.length !== source.group_count ||
        support !== cents(source.support_cents) ||
        oppose !== cents(source.oppose_cents)
      )
        throw Error();
      const existing = output.get(k),
        summary = existing ? structuredClone(existing) : empty(source);
      if (
        summary.cycle !== source.election_year ||
        summary.source !== "MARYLAND_CFS"
      )
        continue;
      summary.last_synced_at = new Date(
        Math.min(
          Date.parse(summary.last_synced_at),
          Date.parse(source.source_observed_at),
        ),
      ).toISOString();
      groups.sort(
        (a, b) =>
          b.amount - a.amount || a.committee_id.localeCompare(b.committee_id),
      );
      summary.outside_spending = {
        ...summary.outside_spending,
        support_total: support / 100,
        oppose_total: oppose / 100,
        top_supporting_groups: groups
          .filter((g) => g.support_oppose === "support")
          .slice(0, 5),
        top_opposing_groups: groups
          .filter((g) => g.support_oppose === "oppose")
          .slice(0, 5),
        top_supporting_industries: [],
        top_opposing_industries: [],
        outside_coverage_note:
          "Reported independent expenditures in Maryland’s public ledger; electioneering communications are excluded.",
      };
      summary.backing_summary = {
        ...summary.backing_summary,
        top_outside_supporting_industries: [],
      };
      output.set(k, summary);
    } catch {
      /* malformed component cannot replace existing valid direct/donor finance */
    }
  return output;
}
