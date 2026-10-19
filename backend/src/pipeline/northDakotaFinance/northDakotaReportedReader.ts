import type { Pool, PoolClient } from "pg";
import {
  isNorthDakotaReportedCommitteeEnabled,
  isNorthDakotaIndependentIeEnabled,
} from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceSummary,
  BallotLookupFinancePacInterest,
  StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import { candidateElectionKey } from "../address/ballotLookupFinanceShared.js";
import {
  classifyPacInterest,
  PAC_INTERESTS_NOT_LISTED,
  pacInterestDisplayName,
  UNCLASSIFIED_PAC_INTEREST,
} from "../finance/pacInterestClassifier.js";
import {
  listNorthDakotaReportedReceivers,
  validateNorthDakotaReportedClosure,
  validateNorthDakotaReportedFacts,
} from "./northDakotaReportedStore.js";
import { ndCanonical, ndHash, type NorthDakotaReportedKind } from "./northDakotaReportedSource.js";
import { NorthDakotaReportedHold, ndAdd, ndHold } from "./northDakotaReportedAggregation.js";
import { NORTH_DAKOTA_CFRS_SOURCE_URL } from "./northDakotaFinanceWriter.js";
import type {
  NorthDakotaReportedAggregation,
  NorthDakotaReportedGroup,
  NorthDakotaReportedReceiver,
} from "./northDakotaReportedStore.js";

type Row = Record<string, any>;
function iso(v: unknown): string {
  const d = new Date(v as string);
  if (!Number.isFinite(d.getTime())) ndHold("stored_clock");
  return d.toISOString();
}
function integer(v: unknown, signed = false): number {
  const n = typeof v === "string" && /^-?(?:0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || (!signed && n < 1))
    ndHold("stored_group_integer");
  return n;
}
export function readStoredNorthDakotaReportedComponent(
  row: Row,
  groups: Row[],
  receiver: NorthDakotaReportedReceiver,
): NorthDakotaReportedAggregation {
  const kind: NorthDakotaReportedKind = row.component;
  if (
    !["committee", "ie"].includes(kind) ||
    row.link_id !== receiver.linkId ||
    row.election_year !== 2026 ||
    row.candidate_id !== receiver.candidateId ||
    row.election_id !== receiver.electionId ||
    ndCanonical(row.receiver_context) !== ndCanonical(receiver)
  )
    ndHold("stored_receiver_context");
  const synced = iso(row.last_synced_at);
  validateNorthDakotaReportedFacts(row.source_facts, kind, synced);
  if (iso(row.source_observed_at) !== row.source_facts.sourceAt)
    ndHold("stored_source_clock");
  const a: NorthDakotaReportedAggregation = {
    ...row.aggregation_controls,
    groups: groups
      .map((g) => {
        if (
          g.link_id !== receiver.linkId ||
          g.election_year !== 2026 ||
          g.component !== kind
        )
          ndHold("stored_group_scope");
        return {
          key: g.group_key,
          name: g.reported_name,
          sourceClass: g.source_class,
          stance: g.stance,
          cents: integer(g.amount_cents, true),
          occurrences: integer(g.occurrence_count),
        };
      })
      .sort((x, y) => x.key.localeCompare(y.key)),
  };
  validateNorthDakotaReportedClosure(a, kind);
  if (
    a.sourceRows !== row.source_facts.sourceRows
  )
    ndHold("stored_source_count");
  return a;
}
function empty(
  r: NorthDakotaReportedReceiver,
  clock: string,
): BallotLookupFinanceSummary {
  return {
    source: "NORTH_DAKOTA_CFRS",
    cycle: 2026,
    fec_candidate_id: null,
    controlled_committee_id: r.entityId,
    last_synced_at: clock,
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
function interests(
  groups: NorthDakotaReportedGroup[],
): BallotLookupFinancePacInterest[] {
  const buckets = new Map<
    string,
    { cents: number; pacs: BallotLookupFinancePacInterest["pacs"] }
  >();
  for (const g of groups) {
    const c = classifyPacInterest({
        committeeName: g.name,
        committeeType: null,
        designation: null,
        organizationType: null,
        connectedOrganization: null,
      }),
      interest =
        c.interestSlug === null ||
        PAC_INTERESTS_NOT_LISTED.includes(c.interestSlug)
          ? UNCLASSIFIED_PAC_INTEREST
          : c.interestSlug,
      b = buckets.get(interest) ?? { cents: 0, pacs: [] };
    b.cents = ndAdd(b.cents, g.cents);
    b.pacs.push({
      committee_id: `nd-reported:${ndHash(g.key)}`,
      committee_name: g.name,
      amount: g.cents / 100,
      source_url: NORTH_DAKOTA_CFRS_SOURCE_URL,
    });
    buckets.set(interest, b);
  }
  return [...buckets]
    .map(([interest, b]) => ({
      interest,
      interest_name: pacInterestDisplayName(interest),
      amount: b.cents / 100,
      pac_count: b.pacs.length,
      pacs: b.pacs
        .sort(
          (a, b) =>
            b.amount - a.amount || a.committee_id.localeCompare(b.committee_id),
        )
        .slice(0, 5),
    }))
    .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest))
    .slice(0, 5);
}
/** Validate every stored group before presentation caps. A missing, ambiguous
 * or inconsistent component preserves the existing summary and its clocks. */
export async function attachNorthDakotaReportedFinance(input: {
  db: Pick<Pool | PoolClient, "query">;
  requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  const kinds: NorthDakotaReportedKind[] = [
    ...(isNorthDakotaReportedCommitteeEnabled() ? ["committee" as const] : []),
    ...(isNorthDakotaIndependentIeEnabled() ? ["ie" as const] : []),
  ];
  if (!kinds.length || !input.requests.length) return input.summaries;
  const output = new Map(input.summaries),
    wanted = new Set(
      input.requests.map((r) =>
        candidateElectionKey(r.candidate_id, r.election_id),
      ),
    ),
    receivers = (await listNorthDakotaReportedReceivers(input.db)).filter((r) =>
      wanted.has(candidateElectionKey(r.candidateId, r.electionId)),
    );
  if (kinds.includes("ie"))
    for (const key of wanted) {
      const s = output.get(key);
      if (s)
        output.set(key, {
          ...s,
          outside_spending: {
            ...s.outside_spending,
            outside_coverage_note:
              "Previously stored North Dakota independent spending is retained until a qualified component is available. Its acquisition date is unavailable; the headline update date may reflect campaign receipts.",
          },
        });
    }
  if (!receivers.length) return output;
  const ids = receivers.map((r) => r.linkId),
    sources = (
      await input.db.query<Row>(
        `SELECT * FROM public.nd_reported_finance_components WHERE link_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])`,
        [ids, kinds],
      )
    ).rows,
    groups = (
      await input.db.query<Row>(
        `SELECT * FROM public.nd_reported_finance_groups WHERE link_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])`,
        [ids, kinds],
      )
    ).rows;
  for (const r of receivers)
    for (const kind of kinds) {
      const rows = sources.filter(
        (s) => s.link_id === r.linkId && s.component === kind,
      );
      if (rows.length !== 1) continue;
      const s = rows[0]!;
      try {
        const a = readStoredNorthDakotaReportedComponent(
            s,
            groups.filter(
              (g) => g.link_id === r.linkId && g.component === kind,
            ),
            r,
          ),
          key = candidateElectionKey(r.candidateId, r.electionId);
        const current = output.get(key) ?? empty(r, s.source_facts.sourceAt);
        if (current.cycle !== 2026) ndHold("summary_cycle");
        const observed = s.source_facts.sourceAt.slice(0, 10);
        if (kind === "committee")
          output.set(key, {
            ...current,
            direct_campaign: {
              ...current.direct_campaign,
              pac_money_by_interest: interests(a.groups),
              pac_money_basis: "reported_committee_itemized_contributions",
              pac_money_coverage_note: `Signed cash and in-kind receipts in the 2025–2026 candidacy window, reported as Committee/PAC or Party Committee and corroborated by the registry's literal name and class. These are reported entities, not verified legal donor identities. Excludes individuals, businesses, self-funding, lumps, loans and reimbursements. Separate expenditure-side returns are outside this metric; this is not net PAC funding. Observed ${observed}.`,
            },
          });
        else {
          const mapped = a.groups
            .map((g) => ({
              committee_id: `nd-reported-ie:${g.key}`,
              committee_name: g.name,
              support_oppose: g.stance as "support" | "oppose",
              amount: g.cents / 100,
              expenditure_count: g.occurrences,
              source_url: NORTH_DAKOTA_CFRS_SOURCE_URL,
            }))
            .sort(
              (a, b) =>
                b.amount - a.amount ||
                a.committee_id.localeCompare(b.committee_id),
            );
          output.set(key, {
            ...current,
            outside_spending: {
              ...current.outside_spending,
              support_total: a.supportCents / 100,
              oppose_total: a.opposeCents / 100,
              top_supporting_groups: mapped
                .filter((g) => g.support_oppose === "support")
                .slice(0, 5),
              top_opposing_groups: mapped
                .filter((g) => g.support_oppose === "oppose")
                .slice(0, 5),
              top_supporting_industries: [],
              top_opposing_industries: [],
              outside_coverage_note: `Explicit candidate allocations in North Dakota's 2026 independent-expenditure ledger, matched to the candidate registry, office and district. Ballot-measure and unallocated spending are excluded; ambiguous targets are held. Source observed ${observed}; the headline update date may reflect campaign receipts.`,
            },
            backing_summary: {
              ...current.backing_summary,
              top_outside_supporting_industries: [],
              top_pac_backed_industries: [],
              top_supporting_committee_industries: [],
            },
          });
        }
      } catch (e) {
        if (!(e instanceof NorthDakotaReportedHold)) throw e;
      }
    }
  return output;
}
