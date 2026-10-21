import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { isDcReportedCommitteeEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { isDistrictOfColumbiaFinanceEligibleOffice } from "./districtOfColumbiaFinanceEligibleOffices.js";
import {
  DC_COMMITTEE_SELECT,
  DC_COMMITTEE_FROM,
  DC_COMMITTEE_WHERE,
  DC_COMMITTEE_OFFICES,
  type DcCommitteeReceiver,
} from "./dcCommitteeReceiver.js";
import {
  readDcCommitteeComponent,
  type DcCommitteeStored,
} from "./dcCommitteeStore.js";
const URL = "https://efiling.ocf.dc.gov/DataDownload";
export function overlayDcCommitteeComponent(
  summary: BallotLookupFinanceSummary | undefined,
  value: DcCommitteeStored,
): BallotLookupFinanceSummary {
  const r = value.receiver,
    base: BallotLookupFinanceSummary = summary ?? {
      source: "DISTRICT_OF_COLUMBIA_OCF",
      cycle: r.electionYear,
      fec_candidate_id: null,
      controlled_committee_id: r.receivingKey,
      last_synced_at: value.observedAt,
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
  const groups = [...value.groups].sort(
    (a, b) => b.amountCents - a.amountCents || a.key.localeCompare(b.key),
  );
  return {
    ...base,
    direct_campaign: {
      ...base.direct_campaign,
      pac_money_by_interest: groups.length
        ? [
            {
              interest: "unclassified",
              interest_name: "Not yet sorted",
              amount: value.controls.totalAmountCents / 100,
              pac_count: groups.length,
              pacs: groups
                .slice(0, 5)
                .map((g) => ({
                  committee_id: `dc-reported:${createHash("sha256").update(g.key).digest("hex")}`,
                  committee_name: g.reportedName,
                  amount: g.amountCents / 100,
                  source_url: URL,
                })),
            },
          ]
        : [],
      pac_money_basis: "reported_committee_itemized_contributions",
      pac_money_coverage_note: `Reported traditional DC party, PAC and other authorized-committee gifts for ${r.electionYear - 1}–${r.electionYear}, including cash and in-kind receipts. Gross receipts before separately reported expenditure-side returns; excludes self receipts, loans, other receipts and interest. Legal PAC status and interests are not inferred. Fair Elections receipts are outside this component. Originals observed ${value.observedAt.slice(0, 10)}–${value.completedAt.slice(0, 10)}.`,
    },
  };
}
export async function overlayDcCommitteeFinance(
  db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[],
  elections: readonly StateFinanceRequestElectionRow[],
) {
  if (!isDcReportedCommitteeEnabled()) return summaries;
  const requests = buildStateFinanceSummaryRequests(
    "DC",
    candidates,
    elections,
    (r) =>
      isDistrictOfColumbiaFinanceEligibleOffice(officeInputFromElectionRow(r)),
  );
  if (!requests.length) return summaries;
  type Row = DcCommitteeReceiver & {
    stored: Record<string, unknown>;
    groups: Record<string, unknown>[];
  };
  const result = await db.query<Row>(
    `SELECT ${DC_COMMITTEE_SELECT},to_jsonb(s) stored,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.dc_committee_finance_groups g WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) groups
    ${DC_COMMITTEE_FROM} JOIN jsonb_to_recordset($2::jsonb) requested(candidate_id uuid,election_id uuid) ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.dc_committee_finance_components s ON s.link_id=l.id AND s.election_year=l.election_year WHERE ${DC_COMMITTEE_WHERE}`,
    [DC_COMMITTEE_OFFICES, JSON.stringify(requests)],
  );
  const counts = new Map<string, number>();
  result.rows.forEach((r) => {
    const k = candidateElectionKey(r.candidateId, r.electionId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  for (const row of result.rows) {
    const { stored, groups, ...receiver } = row,
      key = candidateElectionKey(receiver.candidateId, receiver.electionId);
    if (counts.get(key) !== 1) continue;
    try {
      const value = readDcCommitteeComponent(stored, groups, receiver);
      summaries.set(
        key,
        overlayDcCommitteeComponent(summaries.get(key), value),
      );
    } catch {
      /* Retain prior money and clocks on any failed uncapped closure. */
    }
  }
  return summaries;
}
