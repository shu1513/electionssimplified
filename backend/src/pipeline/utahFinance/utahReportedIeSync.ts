import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { assertSnapshotDbIsNotPoolClient } from "../finance/financeWriterPoolGuard.js";
import { UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./utahFinanceEligibleOffices.js";
import {
  assertUtahIePacket,
  ieCheck,
  loadUtahIePacket,
  type UtahIeContext,
  type UtahIePacket,
} from "./utahReportedIeSource.js";

type Db = Pick<Pool | PoolClient, "query">;
export const UTAH_IE_CONTEXT_SQL = `SELECT ce.candidate_id::text AS "candidateId",ce.election_id::text AS "electionId",
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) AS "candidateName",
  extract(year FROM e.election_date)::integer AS "electionYear",o.scope AS "officeScope",o.canonical_name AS "officeName",
  e.election_stage AS "electionType",CASE WHEN d.district_type IN ('state_upper','state_lower')
    THEN NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') ELSE NULL END AS district
  FROM public.candidate_elections ce JOIN public.candidates c ON c.id=ce.candidate_id
  JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id
  JOIN public.offices o ON o.id=e.office_id WHERE d.state='UT' AND e.race_type='office'
    AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
    AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])
    AND extract(year FROM e.election_date)::integer=$2::integer`;
export async function replaceUtahReportedIe(
  db: Pool,
  packet: UtahIePacket,
  context: UtahIeContext,
): Promise<boolean> {
  assertUtahIePacket(packet);
  assertSnapshotDbIsNotPoolClient("Utah reported IE", db);
  const allocation = packet.allocations.find(
    (a) =>
      a.context.candidateId === context.candidateId &&
      a.context.electionId === context.electionId,
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('utah-reported-ie'),hashtext($1))",
      [`${context.candidateId}:${context.electionId}`],
    );
    const locked = await client.query(
      `SELECT ce.id FROM public.candidate_elections ce
      JOIN public.candidates c ON c.id=ce.candidate_id JOIN public.elections e ON e.id=ce.election_id
      JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
      WHERE ce.candidate_id=$1::uuid AND ce.election_id=$2::uuid FOR UPDATE OF ce,c,e,d,o`,
      [context.candidateId, context.electionId],
    );
    ieCheck(locked.rows.length === 1, "canonical_context_changed");
    const fresh = await client.query<UtahIeContext>(UTAH_IE_CONTEXT_SQL, [
      UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS,
      packet.year,
    ]);
    const target = fresh.rows.filter(
      (c) =>
        c.candidateId === context.candidateId &&
        c.electionId === context.electionId,
    );
    ieCheck(
      target.length === 1 && isDeepStrictEqual(target[0], context),
      "canonical_context_changed",
    );
    if (allocation) {
      ieCheck(isDeepStrictEqual(allocation.context, context), "packet_context");
      // Requalify the whole source against the transaction's current candidate
      // universe, including ambiguity introduced after acquisition.
      const { parseUtahIePurpose, utahIePersonKey } =
        await import("./utahReportedIeSource.js");
      for (const o of allocation.occurrences) {
        const p = parseUtahIePurpose(o.purpose);
        ieCheck(p, "stored_target_clause");
        const matches = fresh.rows.filter(
          (c) =>
            c.officeScope === "state_upper" &&
            c.officeName === "State Senator" &&
            c.electionType === "general" &&
            Number(c.district) === Number(p.district) &&
            utahIePersonKey(c.candidateName) === utahIePersonKey(p.name),
        );
        ieCheck(
          matches.length === 1 &&
            matches[0]!.candidateId === context.candidateId &&
            matches[0]!.electionId === context.electionId,
          "canonical_ambiguity",
        );
      }
    }
    const existing = await client.query<{ observed_at: string }>(
      `SELECT observed_at::text FROM public.ut_reported_ie_sources WHERE candidate_id=$1::uuid AND election_id=$2::uuid FOR UPDATE`,
      [context.candidateId, context.electionId],
    );
    const prior = await client.query<{
      transaction_id: string;
      folder_id: string;
      report_url: string;
      payer_name: string;
      expense_date: string;
      amount_cents: string;
      stance: string;
      purpose: string;
    }>(
      `SELECT transaction_id,folder_id,report_url,payer_name,expense_date::text,amount_cents::text,stance,purpose FROM public.ut_reported_ie_occurrences WHERE candidate_id=$1::uuid AND election_id=$2::uuid`,
      [context.candidateId, context.electionId],
    );
    // No source revision authority has been established for changed/vanished
    // occurrences. Preserve the prior amount and its source clock on any change.
    for (const old of prior.rows) {
      const o = allocation?.occurrences.find(
        (o) => o.transactionId === old.transaction_id,
      );
      ieCheck(
        o &&
          o.folderId === old.folder_id &&
          o.reportUrl === old.report_url &&
          o.payerName === old.payer_name &&
          o.date === old.expense_date &&
          String(o.amountCents) === old.amount_cents &&
          o.stance === old.stance &&
          o.purpose === old.purpose,
        "prior_occurrence_changed",
      );
    }
    if (
      !allocation ||
      (existing.rows[0] &&
        Date.parse(existing.rows[0].observed_at) >=
          Date.parse(packet.observedAt))
    ) {
      await client.query("COMMIT");
      return false;
    }
    let total = 0;
    for (const o of allocation.occurrences) {
      total += o.amountCents;
      ieCheck(
        Number.isSafeInteger(total) &&
          o.payerName.length <= 500 &&
          o.purpose.length <= 2000,
        "unsafe_store_value",
      );
    }
    await client.query(
      `INSERT INTO public.ut_reported_ie_sources
      (candidate_id,election_id,election_year,candidate_name,office_scope,office_name,district,election_stage,observed_at,source_url,report_count,occurrence_count,attributed_count,estimate_cents)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14::bigint)
      ON CONFLICT(candidate_id,election_id) DO UPDATE SET candidate_name=EXCLUDED.candidate_name,office_scope=EXCLUDED.office_scope,
      office_name=EXCLUDED.office_name,district=EXCLUDED.district,election_stage=EXCLUDED.election_stage,observed_at=EXCLUDED.observed_at,
      source_url=EXCLUDED.source_url,report_count=EXCLUDED.report_count,occurrence_count=EXCLUDED.occurrence_count,attributed_count=EXCLUDED.attributed_count,estimate_cents=EXCLUDED.estimate_cents`,
      [
        context.candidateId,
        context.electionId,
        context.electionYear,
        context.candidateName,
        context.officeScope,
        context.officeName,
        context.district,
        context.electionType,
        packet.observedAt,
        packet.sourceUrl,
        packet.reportCount,
        packet.occurrenceCount,
        allocation.occurrences.length,
        total,
      ],
    );
    for (const o of allocation.occurrences)
      await client.query(
        `INSERT INTO public.ut_reported_ie_occurrences
      (candidate_id,election_id,transaction_id,folder_id,report_url,payer_name,expense_date,amount_cents,stance,purpose)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::date,$8::bigint,$9,$10) ON CONFLICT DO NOTHING`,
        [
          context.candidateId,
          context.electionId,
          o.transactionId,
          o.folderId,
          o.reportUrl,
          o.payerName,
          o.date,
          o.amountCents,
          o.stance,
          o.purpose,
        ],
      );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export type UtahIeSyncOptions = {
  db: Db;
  now: Date;
  maxCandidates: number;
  staleAfterDays: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  rawDataCacheDir?: string;
  candidateId?: string;
  electionYear?: number;
  dryRun?: boolean;
  refreshIe?: boolean;
  ieNetwork?: boolean;
  refreshCache?: boolean;
};
export async function syncDueUtahReportedIe(input: UtahIeSyncOptions) {
  const years = await input.db.query<{ year: number }>(
    `SELECT DISTINCT extract(year FROM e.election_date)::integer AS "year" FROM public.elections e JOIN public.districts d ON d.id=e.district_id WHERE d.state='UT' AND e.race_type='office' AND e.election_date BETWEEN ($1::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$2::integer) AND ($1::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$3::integer) AND ($4::integer IS NULL OR extract(year FROM e.election_date)::integer=$4) ORDER BY "year"`,
    [
      input.now.toISOString(),
      input.electionLookbackDays,
      input.electionLookaheadDays,
      input.electionYear ?? null,
    ],
  );
  let selected = 0,
    accepted = 0,
    written = 0,
    held = 0,
    unallocated = 0;
  const failures = new Set<string>();
  for (const { year } of years.rows) {
    const contexts = await input.db.query<UtahIeContext>(UTAH_IE_CONTEXT_SQL, [
      UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS,
      year,
    ]);
    const due = await input.db.query<{
      candidate_id: string;
      election_id: string;
    }>(
      `SELECT ce.candidate_id::text,ce.election_id::text FROM public.candidate_elections ce
      JOIN public.elections e ON e.id=ce.election_id LEFT JOIN public.ut_reported_ie_sources s USING(candidate_id,election_id)
      LEFT JOIN public.ut_reported_ie_attempts a USING(candidate_id,election_id)
      WHERE ce.candidate_id=ANY($1::uuid[]) AND extract(year FROM e.election_date)::integer=$2
        AND e.election_date BETWEEN ($3::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$4::integer) AND ($3::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$5::integer)
        AND ($6::uuid IS NULL OR ce.candidate_id=$6::uuid)
        AND ($7::boolean OR s.observed_at IS NULL OR s.observed_at<$3::timestamptz-make_interval(days=>$8::integer))
      ORDER BY a.attempted_at NULLS FIRST,ce.candidate_id,ce.election_id LIMIT $9`,
      [
        contexts.rows.map((c) => c.candidateId),
        year,
        input.now.toISOString(),
        input.electionLookbackDays,
        input.electionLookaheadDays,
        input.candidateId ?? null,
        input.refreshIe === true,
        input.staleAfterDays,
        input.maxCandidates - selected,
      ],
    );
    const chosen = contexts.rows.filter((c) =>
      due.rows.some(
        (d) =>
          d.candidate_id === c.candidateId && d.election_id === c.electionId,
      ),
    );
    selected += chosen.length;
    if (!chosen.length) continue;
    let packet: UtahIePacket | undefined,
      failure: string | null = null;
    try {
      packet = await loadUtahIePacket(year, contexts.rows, {
        cacheDir:
          input.rawDataCacheDir ?? "scratch/utah-campaign-finance/disclosures",
        now: input.now,
        refresh: input.refreshCache,
        allowNetwork: input.ieNetwork,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      failure = /^Utah reported IE held: [a-z_]+$/.test(message)
        ? message.slice(23)
        : "acquisition_failed";
    }
    for (const context of chosen) {
      let code = failure;
      try {
        if (packet) {
          const allocated = packet.allocations.some(
            (a) =>
              a.context.candidateId === context.candidateId &&
              a.context.electionId === context.electionId,
          );
          if (allocated) accepted++;
          else unallocated++;
          if (
            !input.dryRun &&
            (await replaceUtahReportedIe(input.db as Pool, packet, context))
          )
            written++;
        }
      } catch {
        code = "write_or_revision_held";
      }
      if (code) {
        held++;
        failures.add(code);
      }
      if (!input.dryRun)
        await input.db.query(
          `INSERT INTO public.ut_reported_ie_attempts(candidate_id,election_id,attempted_at,hold_code) VALUES($1::uuid,$2::uuid,$3::timestamptz,$4) ON CONFLICT(candidate_id,election_id) DO UPDATE SET attempted_at=EXCLUDED.attempted_at,hold_code=EXCLUDED.hold_code`,
          [
            context.candidateId,
            context.electionId,
            input.now.toISOString(),
            code,
          ],
        );
    }
    if (selected >= input.maxCandidates) break;
  }
  return {
    selected,
    accepted,
    written,
    held,
    unallocated,
    failures: [...failures],
  };
}
