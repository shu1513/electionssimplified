import type { Pool, PoolClient } from "pg";
import {
  isMassachusettsReportedCommitteeEnabled,
  isMassachusettsIndependentIeEnabled,
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
  listMassachusettsReportedReceivers,
  validateMassachusettsReportedClosure,
  validateMassachusettsReportedFacts,
} from "./massachusettsReportedStore.js";
import { maCanonical,maHash,maAdd,maHold,MassachusettsReportedHold,type MassachusettsReportedKind } from "./massachusettsReportedCore.js";

const MASSACHUSETTS_OCPF_SOURCE_URL="https://www.ocpf.us/";
import type {
  MassachusettsReportedAggregation,
  MassachusettsReportedGroup,
  MassachusettsReportedReceiver,
} from "./massachusettsReportedStore.js";

type Row = Record<string, any>;
function iso(v: unknown): string {
  const d = new Date(v as string);
  if (!Number.isFinite(d.getTime())) maHold("stored_clock");
  return d.toISOString();
}
function integer(v: unknown, signed = false): number {
  const n = typeof v === "string" && /^-?(?:0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || (!signed && n < 1))
    maHold("stored_group_integer");
  return n;
}
export function readStoredMassachusettsReportedComponent(
  row: Row,
  groups: Row[],
  receiver: MassachusettsReportedReceiver,
): MassachusettsReportedAggregation {
  const kind: MassachusettsReportedKind = row.component;
  if (
    !["committee", "ie"].includes(kind) ||
    row.link_id !== receiver.linkId ||
    row.election_year !== 2026 ||
    row.candidate_id !== receiver.candidateId ||
    row.election_id !== receiver.electionId ||
    maCanonical(row.receiver_context) !== maCanonical(receiver)
  )
    maHold("stored_receiver_context");
  const synced = iso(row.last_synced_at);
  validateMassachusettsReportedFacts(row.source_facts, kind, synced);
  if (iso(row.source_observed_at) !== row.source_facts.sourceAt)
    maHold("stored_source_clock");
  const a: MassachusettsReportedAggregation = {
    ...row.aggregation_controls,
    groups: groups
      .map((g) => {
        if (
          g.link_id !== receiver.linkId ||
          g.election_year !== 2026 ||
          g.component !== kind
        )
          maHold("stored_group_scope");
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
  validateMassachusettsReportedClosure(a, kind);
  if (
    a.sourceRows !== row.source_facts.sourceRows
  )
    maHold("stored_source_count");
  return a;
}
function empty(
  r: MassachusettsReportedReceiver,
  clock: string,
): BallotLookupFinanceSummary {
  return {
    source: "MASSACHUSETTS_OCPF",
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
  groups: MassachusettsReportedGroup[],
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
    b.cents = maAdd(b.cents, g.cents);
    b.pacs.push({
      committee_id: `ma-reported:${maHash(g.key)}`,
      committee_name: g.name,
      amount: g.cents / 100,
      source_url: MASSACHUSETTS_OCPF_SOURCE_URL,
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
export async function attachMassachusettsReportedFinance(input: {
  db: Pick<Pool | PoolClient, "query">;
  requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  const kinds: MassachusettsReportedKind[] = [
    ...(isMassachusettsReportedCommitteeEnabled() ? ["committee" as const] : []),
    ...(isMassachusettsIndependentIeEnabled() ? ["ie" as const] : []),
  ];
  if (!kinds.length || !input.requests.length) return input.summaries;
  const output = new Map(input.summaries),
    wanted = new Set(
      input.requests.map((r) =>
        candidateElectionKey(r.candidate_id, r.election_id),
      ),
    ),
    receivers = (await listMassachusettsReportedReceivers(input.db)).filter((r) =>
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
              "Previously stored Massachusetts independent spending is retained until a qualified component is available. Its acquisition date is unavailable; the headline update date may reflect campaign receipts.",
          },
        });
    }
  if (!receivers.length) return output;
  const ids = receivers.map((r) => r.linkId),
    sources = (
      await input.db.query<Row>(
        `SELECT * FROM public.ma_reported_finance_components WHERE link_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])`,
        [ids, kinds],
      )
    ).rows,
    groups = (
      await input.db.query<Row>(
        `SELECT * FROM public.ma_reported_finance_groups WHERE link_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])`,
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
        const a = readStoredMassachusettsReportedComponent(
            s,
            groups.filter(
              (g) => g.link_id === r.linkId && g.component === kind,
            ),
            r,
          ),
          key = candidateElectionKey(r.candidateId, r.electionId);
        const current = output.get(key) ?? empty(r, s.source_facts.sourceAt);
        if (current.cycle !== 2026) maHold("summary_cycle");
        const observed = s.source_facts.sourceAt.slice(0, 10);
        if (kind === "committee")
          output.set(key, {
            ...current,
            direct_campaign: {
              ...current.direct_campaign,
              pac_money_by_interest: interests(a.groups),
              pac_money_basis: "reported_committee_itemized_contributions",
              pac_money_coverage_note: `Gross positive monetary and in-kind receipts dated in calendar 2026, explicitly reported as committee contributions. Names and native contacts are reported labels, not verified legal donor identities. Excludes other receipt classes and transfers. Separate expenditure-side returns are outside this metric; this is not net PAC funding. Receivers with unresolved refunds, prior-year flags or unknown committee types are held. Ledger checked ${observed}.`,
            },
          });
        else {
          const mapped = a.groups
            .map((g) => ({
              committee_id: `ma-reported-ie:${g.key}`,
              committee_name: g.name,
              support_oppose: g.stance as "support" | "oppose",
              amount: g.cents / 100,
              expenditure_count: g.occurrences,
              source_url: MASSACHUSETTS_OCPF_SOURCE_URL,
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
              outside_coverage_note: `Individually allocated payments dated in calendar 2026 from current IEPAC and ordinary IE reports. Native receiving CPF and current candidate profile establish candidate, office and district. Electioneering communications are excluded. Unreconciled parents, unknown preliminary amounts and unresolved allocations hold affected candidates. Current report set checked ${observed}; report bodies retrieved ${s.source_facts.oldestBodyAt.slice(0,10)} through ${s.source_facts.newestBodyAt.slice(0,10)}. The headline update date may reflect campaign receipts.`,
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
        if (!(e instanceof MassachusettsReportedHold)) throw e;
      }
    }
  return output;
}
