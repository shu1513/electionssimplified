import type { Pool, PoolClient } from "pg";
import {
  isKentuckyReportedCommitteeEnabled,
  isKentuckyReportedIeEnabled,
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
  kyCanonical,
  listKentuckyReportedReceivers,
  validateKentuckyReportedClosure,
  validateKentuckyReportedStoredFacts,
} from "./kentuckyReportedStore.js";
import {
  KentuckyReportedHold,
  KY_REPORTED_URL,
  kyAdd,
  kyHash,
  kyHold,
  type KentuckyReportedKind,
} from "./kentuckyReportedSource.js";
import type {
  KentuckyReportedAggregation,
  KentuckyReportedGroup,
  KentuckyReportedReceiver,
} from "./kentuckyReportedAggregation.js";

type Row = Record<string, any>;
function iso(v: unknown): string {
  const d = new Date(v as string);
  if (!Number.isFinite(d.getTime())) kyHold("stored_clock");
  return d.toISOString();
}
function positiveInteger(v: unknown): number {
  const n = typeof v === "string" && /^(?:0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1)
    kyHold("stored_group_integer");
  return n;
}
export function readStoredKentuckyReportedComponent(
  row: Row,
  groups: Row[],
  receiver: KentuckyReportedReceiver,
): KentuckyReportedAggregation {
  const kind: KentuckyReportedKind = row.component;
  if (
    !["committee", "ie"].includes(kind) ||
    row.link_id !== receiver.linkId ||
    row.election_year !== 2026 ||
    row.candidate_id !== receiver.candidateId ||
    row.election_id !== receiver.electionId ||
    kyCanonical(row.receiver_context) !== kyCanonical(receiver)
  )
    kyHold("stored_receiver_context");
  const synced = iso(row.last_synced_at);
  validateKentuckyReportedStoredFacts(row.source_facts, kind, synced);
  if (iso(row.source_retrieved_at) !== row.source_facts.retrievedAt)
    kyHold("stored_source_clock");
  const a: KentuckyReportedAggregation = {
    ...row.aggregation_controls,
    groups: groups
      .map((g) => {
        if (
          g.link_id !== receiver.linkId ||
          g.election_year !== 2026 ||
          g.component !== kind
        )
          kyHold("stored_group_scope");
        return {
          key: g.group_key,
          name: g.reported_name,
          sourceClass: g.source_class,
          stance: g.stance,
          cents: positiveInteger(g.amount_cents),
          occurrences: positiveInteger(g.occurrence_count),
        };
      })
      .sort((x, y) => x.key.localeCompare(y.key)),
  };
  validateKentuckyReportedClosure(a, kind);
  if (
    a.sourceRows !== row.source_facts.sourceRows ||
    a.censusRows !== row.source_facts.censusRows
  )
    kyHold("stored_source_count");
  return a;
}
function empty(
  r: KentuckyReportedReceiver,
  clock: string,
): BallotLookupFinanceSummary {
  return {
    source: "KENTUCKY_KREF",
    cycle: 2026,
    fec_candidate_id: null,
    controlled_committee_id: r.committeeKey,
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
  groups: KentuckyReportedGroup[],
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
    b.cents = kyAdd(b.cents, g.cents);
    b.pacs.push({
      committee_id: `ky-reported:${kyHash(g.key)}`,
      committee_name: g.name,
      amount: g.cents / 100,
      source_url: KY_REPORTED_URL,
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
export async function attachKentuckyReportedFinance(input: {
  db: Pick<Pool | PoolClient, "query">;
  requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  const kinds: KentuckyReportedKind[] = [
    ...(isKentuckyReportedCommitteeEnabled() ? ["committee" as const] : []),
    ...(isKentuckyReportedIeEnabled() ? ["ie" as const] : []),
  ];
  if (!kinds.length || !input.requests.length) return input.summaries;
  const output = new Map(input.summaries),
    wanted = new Set(
      input.requests.map((r) =>
        candidateElectionKey(r.candidate_id, r.election_id),
      ),
    ),
    receivers = (await listKentuckyReportedReceivers(input.db)).filter((r) =>
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
              "Previously stored Kentucky independent spending is retained until a qualified component is available. Its acquisition date is unavailable; the headline update date may reflect campaign receipts.",
          },
        });
    }
  if (!receivers.length) return output;
  const ids = receivers.map((r) => r.linkId),
    sources = (
      await input.db.query<Row>(
        `SELECT * FROM public.ky_reported_finance_components WHERE link_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])`,
        [ids, kinds],
      )
    ).rows,
    groups = (
      await input.db.query<Row>(
        `SELECT * FROM public.ky_reported_finance_groups WHERE link_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])`,
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
        const a = readStoredKentuckyReportedComponent(
            s,
            groups.filter(
              (g) => g.link_id === r.linkId && g.component === kind,
            ),
            r,
          ),
          key = candidateElectionKey(r.candidateId, r.electionId);
        const current = output.get(key) ?? empty(r, s.source_facts.retrievedAt);
        if (current.cycle !== 2026) kyHold("summary_cycle");
        const observed = s.source_facts.retrievedAt.slice(0, 10);
        if (kind === "committee")
          output.set(key, {
            ...current,
            direct_campaign: {
              ...current.direct_campaign,
              pac_money_by_interest: interests(a.groups),
              pac_money_basis: "reported_committee_itemized_contributions",
              pac_money_coverage_note: `Signed itemized receipts from reported PACs, party/caucus and campaign committees, and contributing organizations in Kentucky's current 2026 primary/general public ledger. These are reported entities, not verified legal donor identities. Includes in-kind receipts; excludes individuals, generic Other, transfers and loans. Separate expenditure returns are outside this ledger. Observed ${observed}.`,
            },
          });
        else {
          const mapped = a.groups
            .map((g) => ({
              committee_id: `ky-reported-ie:${g.key}`,
              committee_name: g.name,
              support_oppose: g.stance as "support" | "oppose",
              amount: g.cents / 100,
              expenditure_count: g.occurrences,
              source_url: KY_REPORTED_URL,
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
              outside_coverage_note: `Explicit single-candidate independent spending in Kentucky's current 2026 primary/general ledger, matched to the complete candidate census and district. Ambiguous targets are held. Source observed ${observed}; the headline update date may reflect campaign receipts.`,
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
        if (!(e instanceof KentuckyReportedHold)) throw e;
      }
    }
  return output;
}
