import type { Pool, PoolClient } from "pg";
import type { BallotLookupFinancePacInterest } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

type Row = {
  candidate_id: string; election_id: string; committee_id: string | null;
  committee_name: string | null; committee_type: string | null;
  amount: string | number | null; source_url: string | null; verified_at: string;
};
export type FloridaCommitteeDonorCard = { groups: BallotLookupFinancePacInterest[]; coverageNote: string };

export function groupFloridaCommitteeDonorCards(rows: readonly Row[]): Map<string, FloridaCommitteeDonorCard> {
  const cards = new Map<string, { verifiedAt: string; groups: Map<string, BallotLookupFinancePacInterest> }>();
  for (const row of rows) {
    const key = `${row.candidate_id}\u0000${row.election_id}`;
    if (!Number.isFinite(Date.parse(row.verified_at))) continue;
    const card = cards.get(key) ?? { verifiedAt: row.verified_at, groups: new Map() };
    if (Date.parse(row.verified_at) < Date.parse(card.verifiedAt)) card.verifiedAt = row.verified_at;
    cards.set(key, card);
    if (!row.committee_id || !row.committee_name || !["PAC", "CCE", "PTY", "PAP"].includes(row.committee_type ?? "")) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const interest = classifyPacInterest({ committeeName: row.committee_name, committeeType: null,
      designation: null, organizationType: null, connectedOrganization: null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
    const group = card.groups.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count++;
    group.pacs.push({ committee_id: row.committee_id, committee_name: row.committee_name, amount, source_url: row.source_url });
    card.groups.set(interest, group);
  }
  return new Map([...cards].map(([key, card]) => [key, {
    groups: [...card.groups.values()].map(group => ({ ...group,
      pacs: group.pacs.sort((a,b) => b.amount-a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0,5),
    })).sort((a,b) => b.amount-a.amount || a.interest.localeCompare(b.interest)).slice(0,5),
    coverageNote: `PAC figures use exact registered Florida committees and parties, net of cash refunds, from the last accepted processed reports (verified ${new Date(card.verifiedAt).toISOString().slice(0,10)}). Unmatched donor names remain unclassified. Carryover, loans, in-kind and interest are excluded; Raised uses the existing contribution calculation and may have different coverage.`,
  }]));
}

export async function loadFloridaCommitteeDonorCards(
  db: Pick<Pool | PoolClient, "query">,
  requests: readonly { candidate_id: string; election_id: string }[],
): Promise<Map<string, FloridaCommitteeDonorCard>> {
  if (!requests.length) return new Map();
  const result = await db.query<Row>(`
    WITH requested AS (
      SELECT candidate_id::uuid, election_id::uuid
      FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
    ), owners AS (
      SELECT DISTINCT ON (link.candidate_id, link.election_id, source.source_account)
        link.candidate_id, link.election_id, link.id AS link_id, link.election_year,
        source.source_account, source.last_synced_at
      FROM requested JOIN public.fl_candidate_finance_links link
        ON link.candidate_id=requested.candidate_id AND link.election_id=requested.election_id AND link.link_status='active'
      JOIN public.fl_candidate_finance_pac_sources source
        ON source.link_id=link.id AND source.election_year=link.election_year
      ORDER BY link.candidate_id, link.election_id, source.source_account, source.last_synced_at DESC, link.id
    ) SELECT owners.candidate_id::text, owners.election_id::text,
      donor.committee_id, min(donor.committee_name) AS committee_name,
      min(donor.committee_type) AS committee_type, sum(donor.amount) AS amount,
      min(donor.source_url) AS source_url, min(owners.last_synced_at)::text AS verified_at
    FROM owners LEFT JOIN public.fl_candidate_finance_pac_donors donor
      ON donor.link_id=owners.link_id AND donor.election_year=owners.election_year
    GROUP BY owners.candidate_id, owners.election_id, donor.committee_id
    ORDER BY owners.candidate_id, owners.election_id, amount DESC NULLS LAST, donor.committee_id
  `, [JSON.stringify(requests)]);
  return groupFloridaCommitteeDonorCards(result.rows);
}
