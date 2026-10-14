import type { Pool } from "pg";
import type { VermontCommitteeCashContext } from "./vermontCommitteeCashContext.js";
import type { VermontCommitteeCashQualificationResult } from "./vermontCommitteeCashQualification.js";
import { toVermontOfficeSearchInput } from "./vermontFinanceEligibleOffices.js";

export type VermontQualifiedCommitteeCash = Extract<
  VermontCommitteeCashQualificationResult,
  { status: "qualified" }
>;
export type VermontCommitteeCashWriteInput = {
  db: Pick<Pool, "connect">;
  context: VermontCommitteeCashContext;
  qualified: VermontQualifiedCommitteeCash;
  observedAt: Date;
};
export type VermontCommitteeCashReceivingContext = Omit<
  VermontCommitteeCashContext,
  "sourceElection"
>;
export function projectVermontCommitteeCashReceivingContext(
  c: VermontCommitteeCashContext,
): VermontCommitteeCashReceivingContext {
  return {
    linkId: c.linkId,
    candidateId: c.candidateId,
    electionId: c.electionId,
    electionYear: c.electionYear,
    candidateName: c.candidateName,
    receivingFilerName: c.receivingFilerName,
    filerRegistrationGuid: c.filerRegistrationGuid,
    entityId: c.entityId,
    officeId: c.officeId,
    officeName: c.officeName,
    electionDate: c.electionDate,
    electionType: c.electionType,
    sourceElectionId: c.sourceElectionId,
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const SOURCE = "https://campaignfinance.vermont.gov/";
const norm = (s: string) =>
  s.normalize("NFKC").toUpperCase().replace(/\s+/gu, " ").trim();
function fail(): never {
  throw new Error("Invalid Vermont qualified committee cash input");
}
function day(s: string): boolean {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + "T00:00:00Z")) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s
  );
}
function cents(n: number): string {
  const b = BigInt(n),
    a = b < 0n ? -b : b;
  return `${b < 0n ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}
function periodKeys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) fail();
  const keys = value.map((p) => {
    if (
      !p ||
      !UUID.test(p.filerReportGuid) ||
      !Number.isSafeInteger(p.filerReportVersionId) ||
      p.filerReportVersionId < 1 ||
      !SHA.test(p.pdfSha256) ||
      !day(p.periodStart) ||
      !day(p.periodEnd) ||
      p.periodStart > p.periodEnd
    )
      fail();
    return `${p.periodStart}/${p.periodEnd}`;
  });
  if (new Set(keys).size !== keys.length) fail();
  return keys.sort();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Advances a source pointer while retaining every prior donor generation. No direct or outside writes. */
export async function storeVermontCommitteeCash(
  input: VermontCommitteeCashWriteInput,
): Promise<{
  linkId: string;
  captureDigest: string;
  positionsWritten: number;
}> {
  const db = input.db;
  const {
    context: c,
    qualified: q,
    observedAt,
  } = structuredClone({
    context: input.context,
    qualified: input.qualified,
    observedAt: input.observedAt,
  });
  if (
    !(observedAt instanceof Date) ||
    !Number.isFinite(observedAt.getTime()) ||
    q.status !== "qualified" ||
    ![c.linkId, c.candidateId, c.electionId, c.filerRegistrationGuid].every(
      (x) => UUID.test(x),
    ) ||
    !Number.isSafeInteger(c.electionYear) ||
    c.electionYear < 2000 ||
    c.electionYear > 2100 ||
    !day(c.electionDate) ||
    Number(c.electionDate.slice(0, 4)) !== c.electionYear ||
    c.electionType !== "general" ||
    ![c.entityId, c.officeId, c.sourceElectionId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    c.sourceElection.electionId !== c.sourceElectionId ||
    !c.sourceElection.name?.trim() ||
    !c.candidateName?.trim() ||
    !c.receivingFilerName?.trim() ||
    !c.officeName?.trim() ||
    q.sourceElectionId !== c.sourceElectionId ||
    !SHA.test(q.captureDigest) ||
    !day(q.periodStart) ||
    !day(q.periodEnd) ||
    q.periodStart > q.periodEnd ||
    q.periodEnd > observedAt.toISOString().slice(0, 10) ||
    !Number.isSafeInteger(q.monetaryCashCents) ||
    q.monetaryCashCents < 0 ||
    !Number.isSafeInteger(q.unclassifiedCashCents) ||
    q.unclassifiedCashCents < 0 ||
    q.unclassifiedCashCents > q.monetaryCashCents ||
    !Number.isSafeInteger(q.unclassifiedCashCount) ||
    q.unclassifiedCashCount < 0 ||
    !Array.isArray(q.positions)
  )
    fail();
  const receivingContext = projectVermontCommitteeCashReceivingContext(c);
  const incomingPeriods = periodKeys(q.reportPeriods);
  const sortedPeriods = [...q.reportPeriods].sort((a, b) =>
    a.periodStart.localeCompare(b.periodStart),
  );
  if (
    sortedPeriods[0]!.periodStart !== q.periodStart ||
    sortedPeriods.at(-1)!.periodEnd !== q.periodEnd ||
    sortedPeriods.some(
      (p, i) => i > 0 && p.periodStart <= sortedPeriods[i - 1]!.periodEnd,
    ) ||
    new Set(q.reportPeriods.map((p) => p.filerReportGuid)).size !==
      q.reportPeriods.length
  )
    fail();
  const ids = new Set<string>(),
    gifts = new Set<string>();
  for (const p of q.positions) {
    if (
      !p.committeeName?.trim() ||
      p.committeeId !== `reported:${norm(p.committeeName)}` ||
      ids.has(p.committeeId) ||
      p.committeeType !== "Political Action Committee" ||
      p.sourceUrl !== SOURCE ||
      !Number.isSafeInteger(p.amountCents) ||
      !Number.isSafeInteger(p.contributionCount) ||
      p.contributionCount < 0 ||
      !Array.isArray(p.giftTransactions)
    )
      fail();
    ids.add(p.committeeId);
    let totalCents = 0;
    let positiveCount = 0;
    for (const gift of p.giftTransactions) {
      const report = q.reportPeriods.find(
        (r) => r.filerReportGuid === gift.reportGuid,
      );
      if (
        !report ||
        !UUID.test(gift.guid) ||
        !Number.isSafeInteger(gift.transactionId) ||
        gift.transactionId < 1 ||
        !Number.isSafeInteger(gift.transactionVersionId) ||
        gift.transactionVersionId < 1 ||
        !Number.isSafeInteger(gift.amountCents) ||
        !day(gift.date) ||
        gift.date < report.periodStart ||
        gift.date > report.periodEnd ||
        gifts.has(String(gift.transactionId))
      )
        fail();
      gifts.add(String(gift.transactionId));
      totalCents += gift.amountCents;
      if (!Number.isSafeInteger(totalCents)) fail();
      if (gift.amountCents > 0) positiveCount += 1;
    }
    if (totalCents !== p.amountCents || positiveCount !== p.contributionCount)
      fail();
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`vt-pac:${c.candidateId}:${c.electionId}`],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [
        `vt-pac-filer:${c.filerRegistrationGuid.toLowerCase()}:${c.electionYear}`,
      ],
    );
    const conflictingOwners = await client.query(
      `
      SELECT other_link.id::text
      FROM public.vt_candidate_finance_links other_link
      JOIN public.candidates candidate ON candidate.id=other_link.candidate_id
      JOIN public.candidate_elections ce ON ce.candidate_id=other_link.candidate_id AND ce.election_id=other_link.election_id
      JOIN public.elections election ON election.id=other_link.election_id
      JOIN public.districts district ON district.id=election.district_id
      WHERE lower(other_link.filer_registration_guid)=lower($1) AND other_link.election_year=$2::integer
        AND other_link.link_status='active' AND candidate.deleted_at IS NULL
        AND candidate.merged_into_candidate_id IS NULL AND ce.status='declared'
        AND district.state='VT' AND election.race_type='office' AND election.election_stage='general'
        AND EXTRACT(YEAR FROM election.election_date)::integer=$2::integer
        AND (other_link.candidate_id<>$3::uuid OR other_link.election_id<>$4::uuid)
      FOR UPDATE OF other_link,candidate,ce,election,district`,
      [c.filerRegistrationGuid, c.electionYear, c.candidateId, c.electionId],
    );
    if (conflictingOwners.rows.length)
      throw new Error(
        "Vermont receiving filer has conflicting active General owners",
      );
    const locked = await client.query(
      `
      SELECT link.id::text AS link_id, link.election_year, link.filer_registration_guid, link.entity_id,
        link.filer_name, link.office_name AS link_office_name,
        COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) AS candidate_name,
        office.scope AS office_scope, office.canonical_name AS office_name,
        election.election_date::text AS election_date, district.district_type, district.geoid_compact
      FROM public.vt_candidate_finance_links link
      JOIN public.candidates candidate ON candidate.id=link.candidate_id
      JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id AND ce.election_id=link.election_id
      JOIN public.elections election ON election.id=link.election_id
      JOIN public.offices office ON office.id=election.office_id
      JOIN public.districts district ON district.id=election.district_id
      WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND link.link_status='active'
        AND candidate.deleted_at IS NULL AND candidate.merged_into_candidate_id IS NULL AND ce.status='declared' AND district.state='VT'
        AND election.race_type='office' AND election.election_stage='general'
      FOR UPDATE OF link,candidate,ce,election,office,district`,
      [c.candidateId, c.electionId],
    );
    const row = locked.rows[0];
    const office =
      row &&
      toVermontOfficeSearchInput({
        officeScope: row.office_scope,
        officeCanonicalName: row.office_name,
      });
    if (
      locked.rows.length !== 1 ||
      !row ||
      row.link_id !== c.linkId ||
      row.election_year !== c.electionYear ||
      row.filer_registration_guid !== c.filerRegistrationGuid ||
      row.entity_id !== c.entityId ||
      row.filer_name !== c.receivingFilerName ||
      row.candidate_name !== c.candidateName ||
      row.election_date !== c.electionDate ||
      row.link_office_name !== row.office_name ||
      row.office_scope !== "statewide" ||
      row.district_type !== "statewide" ||
      row.geoid_compact !== "50" ||
      !office ||
      office.officeId !== c.officeId ||
      office.officeName !== c.officeName
    ) {
      throw new Error(
        "Vermont cash needs one unchanged active canonical receiving link",
      );
    }
    const marker = await client.query(
      `SELECT observed_at::text,period_start::text,period_end::text,report_periods,receiving_context,
      source_election_id,capture_digest,cash_control_total::text,unclassified_cash_amount::text,unclassified_cash_count
      FROM public.vt_candidate_finance_pac_sources WHERE link_id=$1::uuid AND election_year=$2::integer FOR UPDATE`,
      [c.linkId, c.electionYear],
    );
    if (marker.rows.length > 1)
      throw new Error("Vermont source pointer ambiguous");
    const previous = marker.rows[0];
    if (previous) {
      if (
        canonical(previous.receiving_context) !== canonical(receivingContext)
      ) {
        throw new Error(
          "Vermont stored receiving context differs from current canonical ownership",
        );
      }
      const oldPeriods = periodKeys(previous.report_periods);
      const previousTime = Date.parse(previous.observed_at);
      if (
        !Number.isFinite(previousTime) ||
        previousTime > observedAt.getTime() ||
        previous.period_start < q.periodStart ||
        previous.period_end > q.periodEnd ||
        oldPeriods.some((p) => !incomingPeriods.includes(p)) ||
        previous.source_election_id !== q.sourceElectionId ||
        ((previousTime === observedAt.getTime() ||
          previous.capture_digest === q.captureDigest) &&
          (previous.capture_digest !== q.captureDigest ||
            canonical(previous.report_periods) !== canonical(q.reportPeriods) ||
            previous.cash_control_total !== cents(q.monetaryCashCents) ||
            previous.unclassified_cash_amount !==
              cents(q.unclassifiedCashCents) ||
            previous.unclassified_cash_count !== q.unclassifiedCashCount))
      ) {
        throw new Error(
          "Vermont source is older, shorter, missing prior periods or conflicts with its watermark",
        );
      }
    }
    for (const p of q.positions) {
      const inserted = await client.query(
        `INSERT INTO public.vt_candidate_finance_pac_donors
        (link_id,election_year,capture_digest,committee_id,committee_name,reported_type,amount,contribution_count,source_url,last_synced_at)
        VALUES ($1::uuid,$2::integer,$3,$4,$5,$6,$7::numeric,$8::integer,$9,$10::timestamptz)
        ON CONFLICT (link_id,election_year,capture_digest,committee_id) DO UPDATE SET committee_id=EXCLUDED.committee_id
        WHERE vt_candidate_finance_pac_donors.committee_name=EXCLUDED.committee_name
          AND vt_candidate_finance_pac_donors.reported_type=EXCLUDED.reported_type
          AND vt_candidate_finance_pac_donors.amount=EXCLUDED.amount
          AND vt_candidate_finance_pac_donors.contribution_count=EXCLUDED.contribution_count
          AND vt_candidate_finance_pac_donors.source_url=EXCLUDED.source_url
        RETURNING committee_id`,
        [
          c.linkId,
          c.electionYear,
          q.captureDigest,
          p.committeeId,
          p.committeeName,
          p.committeeType,
          cents(p.amountCents),
          p.contributionCount,
          p.sourceUrl,
          observedAt,
        ],
      );
      if (inserted.rows.length !== 1)
        throw new Error("Vermont retained donor generation conflicts");
    }
    const count = await client.query(
      `SELECT count(*)::integer AS count FROM public.vt_candidate_finance_pac_donors
      WHERE link_id=$1::uuid AND election_year=$2::integer AND capture_digest=$3`,
      [c.linkId, c.electionYear, q.captureDigest],
    );
    if (count.rows[0]?.count !== q.positions.length)
      throw new Error("Vermont retained donor generation membership conflicts");
    await client.query(
      `INSERT INTO public.vt_candidate_finance_pac_sources
      (link_id,election_year,observed_at,period_start,period_end,report_periods,source_election_id,capture_digest,cash_control_total,unclassified_cash_amount,unclassified_cash_count,receiving_context)
      VALUES ($1::uuid,$2::integer,$3::timestamptz,$4::date,$5::date,$6::jsonb,$7::integer,$8,$9::numeric,$10::numeric,$11::integer,$12::jsonb)
      ON CONFLICT (link_id,election_year) DO UPDATE SET observed_at=EXCLUDED.observed_at,period_start=EXCLUDED.period_start,
        period_end=EXCLUDED.period_end,report_periods=EXCLUDED.report_periods,source_election_id=EXCLUDED.source_election_id,
        capture_digest=EXCLUDED.capture_digest,cash_control_total=EXCLUDED.cash_control_total,
        unclassified_cash_amount=EXCLUDED.unclassified_cash_amount,unclassified_cash_count=EXCLUDED.unclassified_cash_count,
        receiving_context=EXCLUDED.receiving_context`,
      [
        c.linkId,
        c.electionYear,
        observedAt,
        q.periodStart,
        q.periodEnd,
        JSON.stringify(q.reportPeriods),
        q.sourceElectionId,
        q.captureDigest,
        cents(q.monetaryCashCents),
        cents(q.unclassifiedCashCents),
        q.unclassifiedCashCount,
        JSON.stringify(receivingContext),
      ],
    );
    await client.query("COMMIT");
    return {
      linkId: c.linkId,
      captureDigest: q.captureDigest,
      positionsWritten: q.positions.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
