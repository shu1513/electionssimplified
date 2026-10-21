import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import {
  isVirginiaReportedCommitteeEnabled,
  isVirginiaReportedIeEnabled,
} from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  officeInputFromElectionRow,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { isVirginiaFinanceEligibleOffice } from "./virginiaFinanceEligibleOffices.js";
import {
  VA_REPORTED_FROM,
  VA_REPORTED_SELECT,
  VA_REPORTED_WHERE,
  VA_REPORTED_OFFICES,
} from "./virginiaReportedEligibility.js";
import {
  readVirginiaReportedComponent,
  type VirginiaReportedComponent,
  type VirginiaStoredComponent,
} from "./virginiaReportedStore.js";
import type { VirginiaReportedReceiver } from "./virginiaReportedReceiver.js";
import { VIRGINIA_REPORTED_URLS } from "./virginiaReportedNative.js";
const reportedId = (name: string) =>
  `va-reported:${createHash("sha256").update(name).digest("hex")}`;
export function overlayVirginiaReportedComponent(
  summary: BallotLookupFinanceSummary | undefined,
  value: VirginiaStoredComponent,
): BallotLookupFinanceSummary {
  const r = value.receiver,
    base: BallotLookupFinanceSummary = summary ?? {
      source: "VIRGINIA_CFREPORTS",
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
                pacs: groups.slice(0, 5).map((g) => ({
                  committee_id: reportedId(g.key),
                  committee_name: g.reportedName,
                  amount: g.amountCents / 100,
                  source_url: VIRGINIA_REPORTED_URLS.campaign,
                })),
              },
            ]
          : [],
        pac_money_basis: "reported_committee_itemized_contributions",
        pac_money_coverage_note: `Virginia ${r.electionYear} itemized cash and in-kind gifts matched to one current registered PAC and a full postal address in its own filing dated by the gift. Gross receiving-side contributions; excludes loans and unresolved identities. ${value.controls.unverifiedPacRows} PAC-name items remain unassigned. Current registration does not establish historical legal status. ${dates}`,
      },
    };
  return {
    ...base,
    outside_spending: {
      ...base.outside_spending,
      support_total: value.controls.supportCents / 100,
      oppose_total: value.controls.opposeCents / 100,
      outside_coverage_note: `Virginia ${r.electionYear} calendar-year independent expenditures in ELECT's electronic publication (available from July 1, 2025), allocated by explicit candidate committee, office, stance and percentage. Earlier paper reports are outside this coverage. ${dates}`,
      top_supporting_groups: groups
        .filter((g) => g.stance === "support")
        .slice(0, 5)
        .map((g) => ({
          committee_id: reportedId(g.key),
          committee_name: g.reportedName,
          support_oppose: "support" as const,
          amount: g.amountCents / 100,
          expenditure_count: g.occurrenceCount,
          source_url: VIRGINIA_REPORTED_URLS.ie,
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
          source_url: VIRGINIA_REPORTED_URLS.ie,
        })),
      top_supporting_industries: [],
      top_opposing_industries: [],
    },
    backing_summary: {
      ...base.backing_summary,
      top_outside_supporting_industries: [],
    },
  };
}
export async function overlayVirginiaReportedFinance(
  db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[],
  elections: readonly StateFinanceRequestElectionRow[],
) {
  const kinds: VirginiaReportedComponent[] = [];
  if (isVirginiaReportedCommitteeEnabled()) kinds.push("committee");
  if (isVirginiaReportedIeEnabled()) kinds.push("ie");
  if (!kinds.length) return summaries;
  const requests = buildStateFinanceSummaryRequests(
    "VA",
    candidates,
    elections,
    (r) => isVirginiaFinanceEligibleOffice(officeInputFromElectionRow(r)),
  );
  if (!requests.length) return summaries;
  type Row = VirginiaReportedReceiver & {
    stored: Record<string, unknown>;
    groups: Record<string, unknown>[];
  };
  const result = await db.query<Row>(
    `SELECT ${VA_REPORTED_SELECT},to_jsonb(s) stored,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.va_reported_finance_groups g WHERE g.link_id=s.link_id AND g.election_year=s.election_year AND g.component=s.component),'[]'::jsonb) groups
    ${VA_REPORTED_FROM} JOIN jsonb_to_recordset($2::jsonb) requested(candidate_id uuid,election_id uuid)
    ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.va_reported_finance_components s ON s.link_id=l.id AND s.election_year=l.election_year AND s.component=ANY($3::text[])
    WHERE ${VA_REPORTED_WHERE}`,
    [VA_REPORTED_OFFICES, JSON.stringify(requests), kinds],
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
      kind = stored.component as VirginiaReportedComponent,
      key = candidateElectionKey(receiver.candidateId, receiver.electionId);
    if (duplicates.has(`${key}:${kind}`)) continue;
    try {
      const value = readVirginiaReportedComponent(
        stored,
        groups,
        receiver,
        kind,
      );
      summaries.set(
        key,
        overlayVirginiaReportedComponent(summaries.get(key), value),
      );
    } catch {
      /* Invalid components retain the old money and clocks. */
    }
  }
  return summaries;
}
