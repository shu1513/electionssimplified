import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { isColoradoReportedIeEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { listColoradoIeReceivers } from "./coloradoReportedIeReceiver.js";
import {
  validateColoradoIeStored,
  type ColoradoIeStoredFacts,
} from "./coloradoReportedIeStore.js";
import type { ColoradoNativeCandidateProof } from "./coloradoNativeCandidateIdentity.js";
import type { ColoradoReportedIeProjection } from "./coloradoReportedIeAggregation.js";
const SOURCE =
  "https://tracer.sos.colorado.gov/PublicSite/Reports/Reports.aspx";
const storedClock = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
export async function overlayColoradoReportedIe(
  db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[],
  elections: readonly StateFinanceRequestElectionRow[],
) {
  if (!isColoradoReportedIeEnabled()) return summaries;
  const requests = new Set(
    buildStateFinanceSummaryRequests("CO", candidates, elections).map((r) =>
      candidateElectionKey(r.candidate_id, r.election_id),
    ),
  );
  if (!requests.size) return summaries;
  const receivers = (await listColoradoIeReceivers(db)).filter((r) =>
    requests.has(candidateElectionKey(r.candidateId, r.electionId)),
  );
  if (!receivers.length) return summaries;
  const result = await db.query<Record<string, unknown>>(
    `SELECT s.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('key',g.reported_key,'reportedName',g.reported_name,'stance',g.stance,'amountCents',g.amount_cents,'occurrenceCount',g.occurrence_count)) FROM public.co_reported_ie_groups g WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) groups FROM public.co_reported_ie_sources s WHERE s.link_id=ANY($1::uuid[])`,
    [receivers.map((r) => r.linkId)],
  );
  for (const r of receivers) {
    const matches = result.rows.filter(
      (s) =>
        s.link_id === r.linkId && Number(s.election_year) === r.electionYear,
    );
    if (matches.length !== 1) continue;
    try {
      const s = matches[0]!,
        facts = s.source_facts as ColoradoIeStoredFacts,
        identity = s.native_identity as ColoradoNativeCandidateProof,
        projection: ColoradoReportedIeProjection = {
          groups: s.groups as ColoradoReportedIeProjection["groups"],
          controls:
            s.aggregation_controls as ColoradoReportedIeProjection["controls"],
        };
      if (
        s.candidate_id !== r.candidateId ||
        s.election_id !== r.electionId ||
        !isDeepStrictEqual(s.receiver_context, r)
      )
        continue;
      validateColoradoIeStored(r, identity, facts, projection);
      const observed = [
          facts.dataset.observedAt,
          facts.candidate.observedAt,
        ].sort()[0]!,
        completed = [facts.dataset.completedAt, facts.candidate.completedAt]
          .sort()
          .at(-1)!;
      if (
        storedClock(s.source_observed_at) !== observed ||
        storedClock(s.source_completed_at) !== completed ||
        Date.parse(storedClock(s.last_synced_at)) < Date.parse(completed) ||
        Date.parse(storedClock(s.last_synced_at)) > Date.now() + 300000 ||
        !projection.groups.length
      )
        continue;
      const key = candidateElectionKey(r.candidateId, r.electionId),
        base: BallotLookupFinanceSummary = summaries.get(key) ?? {
          source: "COLORADO_TRACER",
          cycle: r.electionYear,
          fec_candidate_id: null,
          controlled_committee_id: r.receivingId,
          last_synced_at: completed,
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
      const groups = (stance: "support" | "oppose") =>
        projection.groups
          .filter((g) => g.stance === stance)
          .sort(
            (a, b) =>
              b.amountCents - a.amountCents || a.key.localeCompare(b.key),
          )
          .slice(0, 5)
          .map((g) => ({
            committee_id: `co-reported-name:${encodeURIComponent(g.key)}`,
            committee_name: g.reportedName,
            support_oppose: g.stance,
            amount: g.amountCents / 100,
            expenditure_count: g.occurrenceCount,
            source_url: SOURCE,
          }));
      summaries.set(key, {
        ...base,
        outside_spending: {
          ...base.outside_spending,
          support_total:
            projection.controls.supportCents > 0
              ? projection.controls.supportCents / 100
              : null,
          oppose_total:
            projection.controls.opposeCents > 0
              ? projection.controls.opposeCents / 100
              : null,
          top_supporting_groups: groups("support"),
          top_opposing_groups: groups("oppose"),
          outside_coverage_note: `Partial Colorado coverage: signed native IE expenses naming one candidate with ${identity.districtName ? "matching party, office and district across independently checked campaign periods" : "matching party and office"}, ${identity.cycleStart} through ${facts.endDate}, net of reported credits. Shared expenses without candidate allocations and unresolved identities, parties or stances are excluded. Groups use exact reported names verified in the IE committee registry; these are not legal-entity counts. Filings checked ${facts.dataset.observedAt.slice(0, 10)}–${facts.dataset.completedAt.slice(0, 10)}; candidate profile checked ${facts.candidate.observedAt.slice(0, 10)}. Later and unfiled expenses may be absent. The headline update date may reflect campaign receipts.`,
        },
      });
    } catch {
      /* Preserve existing components and clocks when stored evidence fails. */
    }
  }
  return summaries;
}
