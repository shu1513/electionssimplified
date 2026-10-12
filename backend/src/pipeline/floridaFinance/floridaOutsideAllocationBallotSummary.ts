import type { Pool, PoolClient } from "pg";
import type { BallotLookupFinanceOutsideGroup } from "../address/ballotLookupFinanceShared.js";
type Row = { candidate_id: string; election_id: string; payer_account: string; payer_name: string;
  support_amount: string | number; source_url: string; last_synced_at: string };
export type FloridaOutsideAllocationCard = { groups: BallotLookupFinanceOutsideGroup[]; coverageNote: string };

/** One candidate-election/payer source row prevents duplicated money across
 * receiving links. These explicit groups never replace headline totals.
 */
export async function loadFloridaOutsideAllocationCards(db: Pick<Pool | PoolClient, "query">,
  requests: readonly { candidate_id: string; election_id: string }[]
): Promise<Map<string, FloridaOutsideAllocationCard>> {
  const cards = new Map<string, FloridaOutsideAllocationCard>();
  if (!requests.length) return cards;
  const result = await db.query<Row>(`
    WITH requested AS (
      SELECT candidate_id::uuid, election_id::uuid
      FROM jsonb_to_recordset($1::jsonb) AS item(candidate_id text, election_id text)
    )
    SELECT candidate_election.candidate_id::text, candidate_election.election_id::text,
      source.payer_account, source.payer_name, source.support_amount,
      source.source_url, source.last_synced_at::text
    FROM requested
    JOIN public.candidate_elections candidate_election
      ON candidate_election.candidate_id = requested.candidate_id
      AND candidate_election.election_id = requested.election_id
    JOIN public.fl_candidate_finance_ie_sources source
      ON source.candidate_election_id = candidate_election.id
    JOIN public.fl_candidate_finance_links link ON link.id = source.link_id
      AND link.candidate_id = candidate_election.candidate_id
      AND link.election_id = candidate_election.election_id AND link.link_status = 'active'
    WHERE source.election_year = 2026
      AND source.provenance->>'authority' = 'current_processed_expense_ledger'
      AND source.provenance->>'version' = '1'
      AND source.provenance->>'candidateWideZeroAuthority' = 'false'
    ORDER BY candidate_election.candidate_id, candidate_election.election_id,
      source.support_amount DESC, source.payer_name, source.payer_account
  `, [JSON.stringify(requests)]);
  for (const row of result.rows) {
    const amount = Number(row.support_amount);
    if (!Number.isFinite(amount) || amount < 0 || !/^[1-9]\d*$/.test(row.payer_account) || !row.payer_name?.trim()) continue;
    const key = `${row.candidate_id}\u0000${row.election_id}`;
    const card = cards.get(key) ?? { groups: [], coverageNote:
      "Groups show verified expenses explicitly naming this candidate. Other spenders, unnamed targets and late filings remain incomplete; outside-spending totals are unavailable." };
    if (amount > 0 && card.groups.length < 5) card.groups.push({ committee_id: row.payer_account,
      committee_name: row.payer_name, support_oppose: "support", amount, source_url: row.source_url });
    cards.set(key, card);
  }
  return cards;
}
