import type { Pool } from "pg";
import type { qualifyPhoenixCommitteeCash } from "./phoenixCommitteeCashQualification.js";

type QualifiedCash = ReturnType<typeof qualifyPhoenixCommitteeCash>;
const dollars = (cents: number): string => {
  if (!Number.isSafeInteger(cents))
    throw new Error("Phoenix PAC cash requires safe integer cents");
  const absolute = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
};

/** Retain donor generations; advance only the separately accepted component. */
export async function storePhoenixCommitteeCash(input: {
  db: Pick<Pool, "connect">;
  candidateId: string;
  electionId: string;
  electionYear: number;
  copId: string;
  portalCycleStart: string;
  portalCycleEnd: string;
  observedAt: Date;
  captureDigest: string;
  cash: QualifiedCash;
}): Promise<void> {
  const observedAt = input.observedAt.toISOString();
  if (!/^[a-f0-9]{64}$/.test(input.captureDigest))
    throw new Error("Invalid Phoenix PAC capture digest");
  const seen = new Set<string>();
  const donors = input.cash.positions.map((position) => {
    if (
      !position.committeeId.startsWith("reported:") ||
      !position.committeeName.trim() ||
      seen.has(position.committeeId) ||
      !Number.isSafeInteger(position.contributionCount) ||
      position.contributionCount < 0 ||
      !Number.isSafeInteger(position.refundCount) ||
      position.refundCount < 0 ||
      !Number.isSafeInteger(position.grossCents - position.refundCents) ||
      position.grossCents - position.refundCents !== position.netCents ||
      !/^https:\/\/apps-secure\.phoenix\.gov\/CampaignFinance\/Reports\/PrintReport\/[0-9a-f-]{36}$/.test(
        position.sourceUrl,
      )
    )
      throw new Error("Invalid Phoenix PAC donor position");
    seen.add(position.committeeId);
    return [
      position.committeeId,
      position.committeeName,
      dollars(position.grossCents),
      dollars(position.refundCents),
      dollars(position.netCents),
      position.contributionCount,
      position.refundCount,
      position.sourceUrl,
    ];
  });
  const periods = JSON.parse(
    JSON.stringify(input.cash.reportPeriods),
  ) as QualifiedCash["reportPeriods"];
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const links = await client.query<{ id: string }>(
      `SELECT id::text FROM public.phx_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND election_year=$3 AND cop_id=$4 AND portal_cycle_start=$5::date AND portal_cycle_end=$6::date AND link_status='active' FOR UPDATE`,
      [
        input.candidateId,
        input.electionId,
        input.electionYear,
        input.copId,
        input.portalCycleStart,
        input.portalCycleEnd,
      ],
    );
    if (links.rows.length !== 1)
      throw new Error("Phoenix PAC receiving link changed during acquisition");
    const linkId = links.rows[0]!.id;
    const prior = await client.query<{
      observed_at: Date | string;
      report_periods: QualifiedCash["reportPeriods"];
    }>(
      `SELECT observed_at,report_periods FROM public.phx_candidate_finance_pac_sources WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`,
      [linkId, input.electionYear],
    );
    for (const source of prior.rows) {
      if (new Date(source.observed_at).getTime() > input.observedAt.getTime())
        throw new Error("Phoenix PAC snapshot is older than stored evidence");
      for (const period of source.report_periods) {
        if (
          !periods.some(
            (next) =>
              next.periodFrom === period.periodFrom &&
              next.periodTo === period.periodTo,
          )
        )
          throw new Error("Phoenix PAC prior reporting period disappeared");
      }
    }
    await client.query(
      `INSERT INTO public.phx_candidate_finance_pac_sources(link_id,election_year,observed_at,reported_through,capture_digest,report_periods) VALUES($1::uuid,$2,$3::timestamptz,$4::date,$5,$6::jsonb) ON CONFLICT(link_id,election_year) DO UPDATE SET observed_at=EXCLUDED.observed_at,reported_through=EXCLUDED.reported_through,capture_digest=EXCLUDED.capture_digest,report_periods=EXCLUDED.report_periods`,
      [
        linkId,
        input.electionYear,
        observedAt,
        input.cash.reportedThrough,
        input.captureDigest,
        JSON.stringify(periods),
      ],
    );
    for (const donor of donors) {
      await client.query(
        `INSERT INTO public.phx_candidate_finance_pac_donors(link_id,election_year,capture_digest,committee_id,committee_name,recognition_method,gross_amount,refund_amount,amount,contribution_count,refund_count,source_url,last_synced_at) VALUES($1::uuid,$2,$3,$4,$5,'reported_type',$6,$7,$8,$9,$10,$11,$12::timestamptz) ON CONFLICT(link_id,election_year,capture_digest,committee_id) DO NOTHING`,
        [linkId, input.electionYear, input.captureDigest, ...donor, observedAt],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
