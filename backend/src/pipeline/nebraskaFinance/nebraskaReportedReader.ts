import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import {
  isNebraskaReportedCommitteeEnabled,
  isNebraskaReportedIeEnabled,
} from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { isNebraskaFinanceEligibleOffice } from "./nebraskaFinanceEligibleOffices.js";
import {
  NE_REPORTED_FROM,
  NE_REPORTED_SELECT,
  NE_REPORTED_WHERE,
  NE_REPORTED_OFFICES,
} from "./nebraskaReportedEligibility.js";
import {
  readNebraskaReportedComponent,
  type NebraskaReportedComponent,
  type NebraskaStoredComponent,
} from "./nebraskaReportedStore.js";
import type { NebraskaReportedReceiver } from "./nebraskaReportedReceiver.js";
const URL = "https://nadc-e.nebraska.gov/PublicSite/";
const reportedId = (name: string) =>
  `ne-reported:${createHash("sha256").update(name).digest("hex")}`;
export function overlayNebraskaReportedComponent(
  summary: BallotLookupFinanceSummary | undefined,
  value: NebraskaStoredComponent,
): BallotLookupFinanceSummary {
  const r = value.receiver,
    base: BallotLookupFinanceSummary = summary ?? {
      source: "NEBRASKA_NADC",
      cycle: r.electionYear,
      fec_candidate_id: null,
      controlled_committee_id: r.receivingId,
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
    ),
    dates = `Originals observed ${value.observedAt.slice(0, 10)}–${value.completedAt.slice(0, 10)}.`;
  if (value.facts.component === "committee")
    return {
      ...base,
      direct_campaign: {
        ...base.direct_campaign,
        pac_money_by_interest: groups.length
          ? [
              {
                interest: "unclassified",
                interest_name: "Not yet sorted",
                amount: value.controls.totalAmountCents! / 100,
                pac_count: groups.length,
                pacs: groups
                  .slice(0, 5)
                  .map((g) => ({
                    committee_id: reportedId(g.key),
                    committee_name: g.reportedName,
                    amount: g.amountCents / 100,
                    source_url: URL,
                  })),
              },
            ]
          : [],
        pac_money_basis: "reported_committee_itemized_contributions",
        pac_money_coverage_note: `Reported Nebraska political-committee gifts for ${r.electionYear - 1}–${r.electionYear}: monetary, in-kind, paid pledges and forgiveness; excludes loans and unpaid pledges. Gross receipts before separately reported expenditure-side returns. All six reported committee classes included; legal PAC status and interests are not inferred. ${dates}`,
      },
    };
  const unknown = value.controls.unattributedSourceRows!;
  return {
    ...base,
    outside_spending: {
      ...base.outside_spending,
      support_total:
        unknown && !value.controls.supportCents
          ? null
          : value.controls.supportCents! / 100,
      oppose_total:
        unknown && !value.controls.opposeCents
          ? null
          : value.controls.opposeCents! / 100,
      outside_coverage_note: `Reported identifiable Nebraska independent-expenditure allocations for ${r.electionYear - 1}–${r.electionYear}. ${unknown} source rows lack target, office or stance and remain unassigned; figures may omit spending. ${dates}`,
      top_supporting_groups: groups
        .filter((g) => g.stance === "support")
        .slice(0, 5)
        .map((g) => ({
          committee_id: reportedId(g.key),
          committee_name: g.reportedName,
          support_oppose: "support" as const,
          amount: g.amountCents / 100,
          expenditure_count: g.occurrenceCount,
          source_url: URL,
        })),
      top_opposing_groups: groups
        .filter((g) => g.stance === "oppose")
        .slice(0, 5)
        .map((g) => ({
          committee_id: reportedId(g.key),
          committee_name: g.reportedName,
          support_oppose: "oppose" as const,
          amount: g.amountCents / 100,
          expenditure_count: g.occurrenceCount,
          source_url: URL,
        })),
      top_supporting_industries: [],
      top_opposing_industries: [],
    },
  };
}
export async function overlayNebraskaReportedFinance(
  db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[],
  elections: readonly StateFinanceRequestElectionRow[],
) {
  const kinds: NebraskaReportedComponent[] = [];
  if (isNebraskaReportedCommitteeEnabled()) kinds.push("committee");
  if (isNebraskaReportedIeEnabled()) kinds.push("ie");
  if (!kinds.length) return summaries;
  const requests = buildStateFinanceSummaryRequests(
    "NE",
    candidates,
    elections,
    (r) => isNebraskaFinanceEligibleOffice(officeInputFromElectionRow(r)),
  );
  if (!requests.length) return summaries;
  type Row = NebraskaReportedReceiver & {
    stored: Record<string, unknown>;
    groups: Record<string, unknown>[];
  };
  const result = await db.query<Row>(
    `SELECT ${NE_REPORTED_SELECT},to_jsonb(s) stored,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.ne_reported_finance_groups g WHERE g.link_id=s.link_id AND g.election_year=s.election_year AND g.component=s.component),'[]'::jsonb) groups
    ${NE_REPORTED_FROM} JOIN jsonb_to_recordset($2::jsonb) requested(candidate_id uuid,election_id uuid)
    ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.ne_reported_finance_components s ON s.link_id=l.id AND s.election_year=l.election_year AND s.component=ANY($3::text[])
    WHERE ${NE_REPORTED_WHERE}`,
    [NE_REPORTED_OFFICES, JSON.stringify(requests), kinds],
  );
  const seen = new Set<string>(),
    duplicates = new Set<string>();
  for (const row of result.rows) {
    const key = `${candidateElectionKey(row.candidateId, row.electionId)}:${row.stored.component}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  for (const row of result.rows) {
    const { stored, groups, ...receiver } = row,
      kind = stored.component as NebraskaReportedComponent,
      key = candidateElectionKey(receiver.candidateId, receiver.electionId);
    if (duplicates.has(`${key}:${kind}`)) continue;
    try {
      const value = readNebraskaReportedComponent(
        stored,
        groups,
        receiver,
        kind,
      );
      summaries.set(
        key,
        overlayNebraskaReportedComponent(summaries.get(key), value),
      );
    } catch {
      /* Invalid components retain the old money and clocks. */
    }
  }
  return summaries;
}
