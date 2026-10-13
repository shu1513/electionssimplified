// Ballot-lookup finance loader for Phoenix (plan Phase 3). Copy of the San
// Diego loader — a bespoke loader over the ballotLookupFinanceShared
// primitives, NOT standardStateFinanceBallotLookupLoader (the shared factory
// hard-codes top_employers to [] and has no coverage-note columns). Both
// coverage notes are always set by the Phoenix sync, so readers always see
// the disclosure basis.
import type { Pool, PoolClient } from "pg";
import { isPhoenixCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  mapFinanceBreakdown,
  parseFinanceAmount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import {
  PAC_INTERESTS_NOT_LISTED,
  PAC_INTEREST_SLUGS,
  UNCLASSIFIED_PAC_INTEREST,
  pacInterestDisplayName,
} from "../finance/pacInterestClassifier.js";
import { isPhoenixCityFinanceEligibleElection } from "./phoenixFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type Candidate = { candidate_id: string; election_id: string };
type Election = {
  election_id: string;
  state: string;
  district_type?: string | null;
  geoid_compact?: string | null;
  office_scope?: string | null;
  office_canonical_name?: string | null;
  official_ballot_title?: string | null;
};
type SummaryRow = {
  candidate_id: string;
  election_id: string;
  cop_id: string;
  election_year: number;
  total_raised: string | number | null;
  total_spent: string | number | null;
  cash_on_hand: string | number | null;
  debts_owed: string | number | null;
  loans_received: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  direct_coverage_note: string | null;
  outside_coverage_note: string | null;
  source_url: string | null;
  last_synced_at: string;
};

export async function loadPhoenixCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly Candidate[],
  electionRows: readonly Election[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isPhoenixCampaignFinanceEnabled()) return new Map();
  const requests = buildStateFinanceSummaryRequests(
    "AZ",
    candidateRows,
    electionRows,
    (row) =>
      isPhoenixCityFinanceEligibleElection({
        state: row.state,
        districtType: row.district_type,
        geoidCompact: row.geoid_compact,
        officeScope: row.office_scope,
        officeCanonicalName: row.office_canonical_name,
        officialBallotTitle: row.official_ballot_title,
      }),
  );
  if (!requests.length) return new Map();
  const summaries = await db.query<SummaryRow>(
    `
      WITH requested AS (
        SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
        FROM jsonb_to_recordset($1::jsonb) x(candidate_id text,election_id text)
      )
      SELECT
        requested.candidate_id::text candidate_id,
        requested.election_id::text election_id,
        link.cop_id,
        summary.election_year,
        summary.total_raised,
        summary.total_spent,
        summary.cash_on_hand,
        summary.debts_owed,
        summary.loans_received,
        summary.outside_support_total,
        summary.outside_oppose_total,
        summary.direct_coverage_note,
        summary.outside_coverage_note,
        summary.source_url,
        summary.last_synced_at::text
      FROM requested
      JOIN public.phx_candidate_finance_links link
        ON link.candidate_id=requested.candidate_id
        AND link.election_id=requested.election_id
        AND link.link_status='active'
      JOIN public.phx_candidate_finance_summaries summary
        ON summary.link_id=link.id
        AND summary.election_year=link.election_year
    `,
    [JSON.stringify(requests)],
  );
  if (!summaries.rows.length) return new Map();
  const selected = summaries.rows.map((row) => ({
    candidate_id: row.candidate_id,
    election_id: row.election_id,
  }));
  const direct = await db.query<{
    candidate_id: string;
    election_id: string;
    category_type: "occupation" | "employer" | "industry" | "contribution_size";
    category_name: string;
    amount: string | number;
    contributor_count: string | number | null;
    source_url: string | null;
  }>(
    `
      WITH selected AS (
        SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
        FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
      ),ranked AS (
        SELECT
          selected.candidate_id::text candidate_id,
          selected.election_id::text election_id,
          b.category_type,
          b.category_name,
          b.amount,
          b.contributor_count,
          b.source_url,
          row_number() OVER(PARTITION BY selected.candidate_id,selected.election_id,b.category_type ORDER BY b.amount DESC,b.category_name) rn
        FROM selected
        JOIN public.phx_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.phx_candidate_finance_direct_breakdowns b
          ON b.link_id=l.id
          AND b.election_year=l.election_year
      )
      SELECT candidate_id,election_id,category_type,category_name,amount,contributor_count,source_url
      FROM ranked
      WHERE rn<=20
      ORDER BY candidate_id,election_id,category_type,amount DESC,category_name
    `,
    [JSON.stringify(selected)],
  );
  const outside = await db.query<{
    candidate_id: string;
    election_id: string;
    spender_filer_id: string;
    spender_name: string;
    support_oppose: "support" | "oppose";
    amount: string | number;
    expenditure_count: string | number | null;
    source_url: string | null;
  }>(
    `
      WITH selected AS (
        SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
        FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
      ),ranked AS (
        SELECT
          selected.candidate_id::text candidate_id,
          selected.election_id::text election_id,
          g.spender_filer_id,
          g.spender_name,
          g.support_oppose,
          g.amount,
          g.expenditure_count,
          g.source_url,
          row_number() OVER(PARTITION BY selected.candidate_id,selected.election_id,g.support_oppose ORDER BY g.amount DESC,g.spender_name,g.spender_filer_id) rn
        FROM selected
        JOIN public.phx_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.phx_candidate_finance_outside_groups g
          ON g.link_id=l.id
          AND g.election_year=l.election_year
      )
      SELECT candidate_id,election_id,spender_filer_id,spender_name,support_oppose,amount,expenditure_count,source_url
      FROM ranked
      WHERE rn<=5
      ORDER BY candidate_id,election_id,support_oppose,amount DESC,spender_name,spender_filer_id
    `,
    [JSON.stringify(selected)],
  );
  // The source pointer selects an accepted generation, including a genuinely
  // empty one. Sum signed positions before filtering or applying display caps.
  const pac = await db.query<PhoenixPacDonorRow>(
    `WITH selected AS (
      SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
      FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
    ), grouped AS (
      SELECT selected.candidate_id::text,selected.election_id::text,
        max(max(source.observed_at)) OVER (PARTITION BY selected.candidate_id,selected.election_id)::text AS observed_at,
        min(min(source.reported_through)) OVER (PARTITION BY selected.candidate_id,selected.election_id)::text AS reported_through,
        donor.committee_id,min(donor.committee_name) AS committee_name,
        sum(donor.amount) AS amount,min(donor.source_url) AS source_url
      FROM selected
      JOIN public.phx_candidate_finance_links link ON link.candidate_id=selected.candidate_id
        AND link.election_id=selected.election_id AND link.link_status='active'
      JOIN public.phx_candidate_finance_pac_sources source ON source.link_id=link.id
        AND source.election_year=link.election_year
      LEFT JOIN public.phx_candidate_finance_pac_donors donor ON donor.link_id=source.link_id
        AND donor.election_year=source.election_year AND donor.capture_digest=source.capture_digest
        AND donor.recognition_method='reported_type'
      GROUP BY selected.candidate_id,selected.election_id,donor.committee_id
    )
    SELECT grouped.*,classification.industry_slug,classification.classification_source,classification.confidence
    FROM grouped LEFT JOIN public.finance_label_classifications classification
      ON classification.label_type='committee'
      AND classification.normalized_label=public.normalize_finance_label(grouped.committee_name)
    ORDER BY candidate_id,election_id,amount DESC,committee_name`,
    [JSON.stringify(selected)],
  );
  const pacSources = new Map<
    string,
    { observedAt: string; reportedThrough: string }
  >();
  const pacInterests = new Map<
    string,
    Map<string, BallotLookupFinancePacInterest>
  >();
  for (const row of pac.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    pacSources.set(key, {
      observedAt: row.observed_at,
      reportedThrough: row.reported_through,
    });
    if (row.committee_id === null || row.committee_name === null) continue;
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0) continue;
    const classification = classifyFinanceLabel({
      rawLabel: row.committee_name,
      labelType: "committee",
    });
    const trusted =
      row.industry_slug &&
      (row.classification_source === "manual" ||
        (row.confidence === "high" &&
          ["rule", "ai"].includes(row.classification_source ?? "")))
        ? row.industry_slug
        : null;
    const rule =
      classification.classificationSource === "rule" &&
      classification.confidence === "high"
        ? classification.industrySlug
        : null;
    const proposed = trusted ?? rule;
    const interest =
      proposed && (PAC_INTEREST_SLUGS as readonly string[]).includes(proposed)
        ? proposed
        : UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest))
      continue;
    const byInterest =
      pacInterests.get(key) ??
      new Map<string, BallotLookupFinancePacInterest>();
    const group = byInterest.get(interest) ?? {
      interest,
      interest_name: pacInterestDisplayName(interest),
      amount: 0,
      pac_count: 0,
      pacs: [],
    };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count += 1;
    group.pacs.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      amount,
      source_url: row.source_url,
    });
    byInterest.set(interest, group);
    pacInterests.set(key, byInterest);
  }
  // The summary row carries the stable portal URL; breakdown/group rows store
  // the same URL today, but the fallback keeps the card's footer link alive
  // if a future sync stops writing per-row URLs (the SF lesson).
  const summarySourceUrlByKey = new Map(
    summaries.rows.map((row) => [
      candidateElectionKey(row.candidate_id, row.election_id),
      row.source_url,
    ]),
  );
  const maps = new Map<string, Map<string, BallotLookupFinanceBreakdown[]>>();
  for (const row of direct.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const byType = maps.get(key) ?? new Map();
    const list = byType.get(row.category_type) ?? [];
    list.push(mapFinanceBreakdown(row, summarySourceUrlByKey.get(key) ?? null));
    byType.set(row.category_type, list);
    maps.set(key, byType);
  }
  const groups = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  for (const row of outside.rows) {
    const key = `${candidateElectionKey(row.candidate_id, row.election_id)}|${row.support_oppose}`;
    const list = groups.get(key) ?? [];
    const expenditureCount =
      row.expenditure_count === null ? null : Number(row.expenditure_count);
    list.push({
      // COP ID for the portal-PAC channel; curated channels carry their own
      // identifiers — the (id, name) pair is the row's stable key.
      committee_id: row.spender_filer_id,
      committee_name: row.spender_name,
      support_oppose: row.support_oppose,
      amount: parseFinanceAmount(row.amount) ?? 0,
      expenditure_count: Number.isFinite(expenditureCount)
        ? expenditureCount
        : null,
      source_url:
        row.source_url ??
        summarySourceUrlByKey.get(
          candidateElectionKey(row.candidate_id, row.election_id),
        ) ??
        null,
    });
    groups.set(key, list);
  }
  return new Map(
    summaries.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const byType = maps.get(key) ?? new Map();
      const occupations = byType.get("occupation") ?? [];
      const pacSource = pacSources.get(key);
      const pacGroups = [...(pacInterests.get(key)?.values() ?? [])]
        .map((group) => ({
          ...group,
          pacs: group.pacs
            .sort(
              (a, b) =>
                b.amount - a.amount ||
                a.committee_id.localeCompare(b.committee_id),
            )
            .slice(0, 5),
        }))
        .sort(
          (a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest),
        );
      const directNote = pacSource
        ? [
            row.direct_coverage_note,
            `Reported PAC monetary receipts net of identified returns in accepted city reports through ${pacSource.reportedThrough}; source observed ${pacSource.observedAt}. In-kind, candidate committees and parties are excluded. Reported-name groups do not establish legal registration identity; donor detail and direct totals have separate source observations.`,
          ]
            .filter(Boolean)
            .join(" ")
        : row.direct_coverage_note;
      return [
        key,
        {
          source: "PHOENIX_CITY_CLERK",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.cop_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            // Donor money only: Σ Schedule A line 1(m) net monetary
            // contributions. Loans stay separate per the shared read contract.
            total_raised: parseFinanceAmount(row.total_raised),
            total_spent: parseFinanceAmount(row.total_spent),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: parseFinanceAmount(row.debts_owed),
            loans_received: parseFinanceAmount(row.loans_received),
            top_occupations: occupations,
            top_employers: byType.get("employer") ?? [],
            top_industries: byType.get("industry") ?? [],
            // contribution_size buckets are impossible for Phoenix (the
            // A(1)(b) aggregate) and deliberately absent.
            contribution_size_buckets: [],
            // Always set by the Phoenix sync (itemization-threshold basis).
            ...(directNote === null
              ? {}
              : { direct_coverage_note: directNote }),
            ...(pacSource ? { pac_money_by_interest: pacGroups } : {}),
          },
          outside_spending: {
            // Known groups are partial allocations; missing channels cannot certify totals.
            support_total: null,
            oppose_total: null,
            outside_coverage_note: [
              row.outside_coverage_note,
              "Known city-reported allocations may include earlier successful observations. Standing committees, noncommittee IE and Election Funding Disclosures are not fully measured; overall outside totals remain unknown.",
            ]
              .filter(Boolean)
              .join(" "),
            top_supporting_groups: groups.get(`${key}|support`) ?? [],
            top_opposing_groups: groups.get(`${key}|oppose`) ?? [],
            top_supporting_industries: [],
            top_opposing_industries: [],
          },
          backing_summary: {
            top_direct_donor_occupations: occupations,
            top_outside_supporting_industries: [],
          },
        } satisfies BallotLookupFinanceSummary,
      ] as const;
    }),
  );
}

type PhoenixPacDonorRow = {
  candidate_id: string;
  election_id: string;
  observed_at: string;
  reported_through: string;
  committee_id: string | null;
  committee_name: string | null;
  amount: string | number | null;
  source_url: string | null;
  industry_slug: string | null;
  classification_source: string | null;
  confidence: string | null;
};
