// Legacy due selection stays unchanged while independent components are off.
// Enabled components use actual source age and separate fair retry ordering.

import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueListQuery,
  type StandardStateFinanceDueQueryRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { isMissouriCommitteeReceiptsEnabled, isMissouriRegisteredIeEnabled } from "../../config/featureFlags.js";
import { MISSOURI_FINANCE_ATTEMPT_RETRY_HOURS, type MissouriFinanceAttemptComponentMask } from "./missouriCandidateFinanceAttempts.js";
import { MISSOURI_DIRECT_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./missouriFinanceEligibleOffices.js";
import type { MissouriFinanceLinkSource } from "./missouriFinanceWriter.js";

export type MissouriCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  linkSource: MissouriFinanceLinkSource;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
  /** Internal protected scheduling context, present only with an enabled component. */
  linkId?: string;
  attemptComponentMask?: MissouriFinanceAttemptComponentMask;
};

const listLegacyDue: StandardStateFinanceDueListQuery<MissouriCandidateFinanceDueRow> =
  createStandardStateFinanceDueListQuery({
    state: "MO",
    tables: {
      links: "mo_candidate_finance_links",
      summaries: "mo_candidate_finance_summaries",
    },
    // The office-key constant is a Set; the builder binds a readonly array.
    eligibleOfficeKeys: [...MISSOURI_DIRECT_FINANCE_ELIGIBLE_OFFICE_KEYS],
    electionStage: "general",
    selectElectionDate: true,
    linkColumns: ["committee_id", "committee_name", "link_source"],
    mapRow: (row) => ({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionYear: row.election_year,
      electionDate: (row.election_date as string).slice(0, 10),
      officeScope: row.office_scope,
      officeName: row.office_name,
      district: row.district,
      committeeId: row.committee_id as string,
      committeeName: row.committee_name as string,
      linkSource: row.link_source as MissouriFinanceLinkSource,
      sourceUrl: row.source_url,
      lastSyncedAt: row.last_synced_at,
    }),
  });


export const listDueMissouriCandidateFinanceSyncRows: StandardStateFinanceDueListQuery<MissouriCandidateFinanceDueRow> = async (db, input) => {
  const receiptsEnabled = isMissouriCommitteeReceiptsEnabled();
  const ieEnabled = isMissouriRegisteredIeEnabled();
  if (!receiptsEnabled && !ieEnabled) return listLegacyDue(db, input);
  const mask = ((receiptsEnabled ? 2 : 0) | (ieEnabled ? 4 : 0)) as MissouriFinanceAttemptComponentMask;
  if (input.candidateId !== undefined && (typeof input.candidateId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.candidateId)))
    throw new Error("Invalid standard finance due-list candidateId: expected UUID");
  if (input.electionYear !== undefined && (!Number.isSafeInteger(input.electionYear) || input.electionYear < 1900 || input.electionYear > 2100))
    throw new Error("Invalid standard finance due-list electionYear");
  if (input.refresh !== undefined && typeof input.refresh !== "boolean") throw new Error("Invalid standard finance due-list refresh");
  const parameters: unknown[] = [input.now.toISOString(), input.staleAfterDays, input.maxCandidates,
    input.electionLookbackDays, input.electionLookaheadDays, [...MISSOURI_DIRECT_FINANCE_ELIGIBLE_OFFICE_KEYS], mask,
    MISSOURI_FINANCE_ATTEMPT_RETRY_HOURS];
  let scope = "";
  if (input.candidateId !== undefined) scope += ` AND link.candidate_id=$${parameters.push(input.candidateId)}::uuid`;
  if (input.electionYear !== undefined) {
    const parameter = parameters.push(input.electionYear);
    scope += ` AND link.election_year=$${parameter}::int AND EXTRACT(YEAR FROM election.election_date)::int=$${parameter}::int`;
  }
  const joins = [receiptsEnabled ? `
    LEFT JOIN public.mo_candidate_finance_committee_receipt_sources receipt
      ON receipt.link_id=link.id AND receipt.election_year=link.election_year
      AND receipt.receiving_committee_id=link.committee_id AND receipt.cycle_end=election.election_date::date` : "",
    ieEnabled ? `
    LEFT JOIN public.mo_candidate_finance_registered_ie_sources ie
      ON ie.candidate_id=link.candidate_id AND ie.election_id=link.election_id AND ie.election_year=link.election_year
      AND ie.cycle_end=election.election_date::date
    LEFT JOIN public.mo_candidate_finance_links ie_link ON ie_link.id=ie.qualifying_link_id
      AND ie_link.candidate_id=ie.candidate_id AND ie_link.election_id=ie.election_id
      AND ie_link.election_year=ie.election_year AND ie_link.committee_id=ie.receiving_committee_id
      AND ie_link.link_status='active'` : ""].join("");
  const financiallyDue = ["summary.last_synced_at IS NULL OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))",
    receiptsEnabled ? "receipt.link_id IS NULL OR receipt.source_retrieved_at < ($1::timestamptz - make_interval(days => $2::int)) OR receipt.source_retrieved_at > $1::timestamptz" : "",
    ieEnabled ? "ie_link.id IS NULL OR ie.source_retrieved_at < ($1::timestamptz - make_interval(days => $2::int)) OR ie.source_retrieved_at > $1::timestamptz" : ""]
    .filter(Boolean).join(" OR ");
  const effectiveAttempt = "CASE WHEN attempt.component_mask=$7::smallint THEN attempt.last_attempted_at ELSE NULL END";
  const result = await db.query<StandardStateFinanceDueQueryRow & { link_id: string }>(`
    WITH due AS (
      SELECT link.id::text AS link_id, link.candidate_id::text AS candidate_id, link.election_id::text AS election_id,
        COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''), link.candidate_name_normalized) AS candidate_name,
        link.election_year, election.election_date::text AS election_date, office.scope AS office_scope,
        link.office_name, link.district, link.committee_id, link.committee_name, link.link_source, link.source_url,
        summary.last_synced_at::text AS last_synced_at, COUNT(*) OVER () AS total_due_rows
      FROM public.mo_candidate_finance_links link
      JOIN public.candidates candidate ON candidate.id=link.candidate_id
      JOIN public.candidate_elections candidate_election ON candidate_election.candidate_id=link.candidate_id AND candidate_election.election_id=link.election_id
      JOIN public.elections election ON election.id=link.election_id
      JOIN public.districts district ON district.id=election.district_id
      LEFT JOIN public.offices office ON office.id=election.office_id
      LEFT JOIN public.mo_candidate_finance_summaries summary ON summary.link_id=link.id AND summary.election_year=link.election_year
      LEFT JOIN public.mo_candidate_finance_sync_attempts attempt ON attempt.link_id=link.id AND attempt.election_year=link.election_year
      ${joins}
      WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND district.state='MO'
        AND election.race_type='office' AND election.election_stage = 'general'
        AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
        AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($6::text[]) ${scope}
        AND (${input.refresh === true ? "TRUE" : financiallyDue})
        AND (attempt.last_attempted_at IS NULL OR attempt.component_mask<>$7::smallint
          OR attempt.last_attempted_at <= ($1::timestamptz - make_interval(hours => $8::int)))
      ORDER BY ${effectiveAttempt} ASC NULLS FIRST, summary.last_synced_at ASC NULLS FIRST,
        election.election_date ASC, link.candidate_name_normalized ASC, link.id ASC
      LIMIT $3::int
    ) SELECT * FROM due`, parameters);
  return {
    rows: result.rows.map(row => ({candidateId: row.candidate_id, electionId: row.election_id, candidateName: row.candidate_name,
      electionYear: row.election_year, electionDate: row.election_date!.slice(0, 10), officeScope: row.office_scope,
      officeName: row.office_name, district: row.district, committeeId: row.committee_id as string,
      committeeName: row.committee_name as string, linkSource: row.link_source as MissouriFinanceLinkSource,
      sourceUrl: row.source_url, lastSyncedAt: row.last_synced_at, linkId: row.link_id, attemptComponentMask: mask})),
    totalDueRows: Number(result.rows[0]?.total_due_rows ?? 0),
  };
};
