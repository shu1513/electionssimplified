import type { Pool, PoolClient } from "pg";

import { captureError } from "../../observability/sentry.js";
import { describeError } from "../../observability/scrubText.js";
import type { BallotLookupFinanceSummary } from "./ballotLookupFinanceShared.js";

type Queryable = Pick<Pool | PoolClient, "query">;

type FinanceCommitteeLabelRow = {
  source: string;
  committee_id: string;
  cycle: number;
  label: string;
  source_urls: string[];
};

// (source, committee_id, cycle) — committee ids are only unique within one
// disclosing agency's namespace, and labels are cycle-scoped because funder
// claims can change between cycles. NUL-separated (candidateElectionKey's
// convention): committee ids come from ~34 disclosure systems with no
// guaranteed format, so a printable separator could collide. Exported for
// the manual due/write script, which keys the same triple.
export function committeeLabelKey(source: string, committeeId: string, cycle: number): string {
  return `${source}\u0000${committeeId}\u0000${cycle}`;
}

/**
 * Attaches manually researched committee labels (finance_committee_labels)
 * to the outside-spending group rows and the conduit group rows of
 * already-built finance summaries.
 * Mutates the summaries in place: matching groups gain `label` plus the
 * `label_source_urls` evidence behind it.
 *
 * Runs as the LAST query of each ballot-lookup entry point and is fault
 * isolated: labels enrich the payload, so a missing table (migration not
 * yet applied) or any query failure degrades to unlabeled groups instead of
 * failing the lookup. Issues no query when the summaries carry no groups.
 */
/** Every row of a summary that can carry a researched committee label. */
export function labelableFinanceCommittees(
  summary: BallotLookupFinanceSummary
): { committee_id: string; label?: string; label_source_urls?: string[] }[] {
  return [
    ...summary.outside_spending.top_supporting_groups,
    ...summary.outside_spending.top_opposing_groups,
    ...(summary.direct_campaign.conduit_donations ?? []),
  ];
}

export async function applyFinanceCommitteeLabels(
  db: Queryable,
  summaries: Iterable<BallotLookupFinanceSummary | null | undefined>
): Promise<void> {
  const summaryList = [...summaries].filter(
    (summary): summary is BallotLookupFinanceSummary => summary != null
  );
  const sources: string[] = [];
  const committeeIds: string[] = [];
  const cycles: number[] = [];
  const seen = new Set<string>();
  for (const summary of summaryList) {
    for (const group of labelableFinanceCommittees(summary)) {
      const key = committeeLabelKey(summary.source, group.committee_id, summary.cycle);
      if (!seen.has(key)) {
        seen.add(key);
        sources.push(summary.source);
        committeeIds.push(group.committee_id);
        cycles.push(summary.cycle);
      }
    }
  }
  if (sources.length === 0) {
    return;
  }

  let labelByKey: Map<string, FinanceCommitteeLabelRow>;
  try {
    const result = await db.query<FinanceCommitteeLabelRow>(
      `
        SELECT l.source, l.committee_id, l.cycle, l.label, l.source_urls
        FROM public.finance_committee_labels AS l
        JOIN unnest($1::text[], $2::text[], $3::int[]) AS wanted(source, committee_id, cycle)
          ON wanted.source = l.source
         AND wanted.committee_id = l.committee_id
         AND wanted.cycle = l.cycle
      `,
      [sources, committeeIds, cycles]
    );
    labelByKey = new Map(
      result.rows.map((row) => [committeeLabelKey(row.source, row.committee_id, row.cycle), row])
    );
  } catch (error) {
    console.warn("finance committee labels failed; continuing with unlabeled groups:", {
      reason: describeError(error),
    });
    captureError(error, { finance_loader: "applyFinanceCommitteeLabels" });
    return;
  }

  for (const summary of summaryList) {
    for (const group of labelableFinanceCommittees(summary)) {
      const row = labelByKey.get(committeeLabelKey(summary.source, group.committee_id, summary.cycle));
      if (row !== undefined) {
        group.label = row.label;
        group.label_source_urls = row.source_urls;
      }
    }
  }
}
