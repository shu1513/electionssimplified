import type { Pool, PoolClient } from "pg";

import {
  normalizeOhioCandidateNameForStorage,
  resolveOhioCandidateCommittee,
  type OhioCandidateCommitteeResolution,
} from "./ohioCandidateCommitteeResolver.js";
import { OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./ohioFinanceEligibleOffices.js";
import { upsertOhioFinanceLink } from "./ohioFinanceWriter.js";
import type { OhioSosCandidateCommitteeListRow } from "./ohioSosBulkFiles.js";

// Auto-link for Ohio candidate finance, maryland pattern
// (marylandCandidateCommitteeAutoLinker.ts): list candidate elections that
// still lack an active oh_candidate_finance_links row, resolve each against
// the active-candidate list, and write only exact single-committee matches.
// Ohio's list is cumulative (current registrations, no year column), so the
// caller passes one row set rather than maryland's per-year map.

type Queryable = Pick<Pool | PoolClient, "query">;

export type OhioFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  // ISO date of the election; also the leading component of the page cursor.
  electionDate: string;
  officeScope: string;
  officeName: string;
  district: string | null;
};

// Keyset cursor: strictly-after position in the due list's
// (election_date, election_id, candidate_id) ordering.
export type OhioFinanceAutoLinkCursor = {
  electionDate: string;
  electionId: string;
  candidateId: string;
};

export type OhioFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: OhioCandidateCommitteeResolution["status"] | "linked";
      committeeId?: string;
      reason?: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "error";
      reason: "auto_link_failed";
      error: string;
    };

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  election_date: string;
  office_scope: string;
  office_name: string;
  district: string | null;
};

function mapCandidateElectionRow(row: CandidateElectionQueryRow): OhioFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    electionDate: row.election_date,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
  };
}

export async function listOhioCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
    // Resume strictly after this position. Without it the query always
    // returns the first page, and rows that stay unmatched would occupy it
    // forever, starving everything behind them.
    after?: OhioFinanceAutoLinkCursor;
  }
): Promise<OhioFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        election.election_date::text AS election_date,
        office.scope AS office_scope,
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(
              regexp_replace(
                substring(district.geoid_compact from char_length(district.state_fips) + 1),
                '^0+',
                ''
              ),
              ''
            )
          ELSE NULL
        END AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE candidate.deleted_at IS NULL
        AND district.state = 'OH'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.oh_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
        AND (
          $6::date IS NULL
          OR (election.election_date, election.id, candidate.id) > ($6::date, $7::uuid, $8::uuid)
        )
      ORDER BY election.election_date ASC, election.id ASC, candidate.id ASC
      LIMIT $2::int
    `,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS],
      input.after?.electionDate ?? null,
      input.after?.electionId ?? null,
      input.after?.candidateId ?? null,
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkOhioCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: OhioFinanceAutoLinkCandidateElection;
  candidateListRows: readonly OhioSosCandidateCommitteeListRow[];
  sourceUrl: string | null;
  now: Date;
}): Promise<OhioFinanceAutoLinkResult> {
  const resolution = resolveOhioCandidateCommittee({
    candidateName: input.candidateElection.candidateName,
    officeScope: input.candidateElection.officeScope,
    officeName: input.candidateElection.officeName,
    electionYear: input.candidateElection.electionYear,
    district: input.candidateElection.district,
    candidateListRows: input.candidateListRows,
    sourceUrl: input.sourceUrl,
  });

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertOhioFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeOhioCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "sos_bulk_export",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    committeeId: resolution.committeeId,
  };
}

// Walks the ENTIRE bounded election window in pages of maxCandidates —
// resolution is local compute, so there is no reason to stop early, and a
// fixed first-page limit would let permanently unmatched rows starve every
// candidate behind them.
export async function autoLinkMissingOhioCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateListRows: readonly OhioSosCandidateCommitteeListRow[];
  sourceUrl?: string | null;
  candidateElections?: readonly OhioFinanceAutoLinkCandidateElection[];
}): Promise<OhioFinanceAutoLinkResult[]> {
  const results: OhioFinanceAutoLinkResult[] = [];

  async function processPage(candidates: readonly OhioFinanceAutoLinkCandidateElection[]): Promise<void> {
    for (const candidateElection of candidates) {
      try {
        results.push(
          await autoLinkOhioCandidateFinanceForCandidateElection({
            db: input.db,
            candidateElection,
            candidateListRows: input.candidateListRows,
            sourceUrl: input.sourceUrl ?? null,
            now: input.now,
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("Ohio finance auto-link failed for candidate election; continuing:", {
          candidateId: candidateElection.candidateId,
          electionId: candidateElection.electionId,
          electionYear: candidateElection.electionYear,
          error: message,
        });
        results.push({
          candidateId: candidateElection.candidateId,
          electionId: candidateElection.electionId,
          status: "error",
          reason: "auto_link_failed",
          error: message,
        });
      }
    }
  }

  if (input.candidateElections) {
    await processPage(input.candidateElections);
    return results;
  }

  let after: OhioFinanceAutoLinkCursor | undefined;
  for (;;) {
    const page = await listOhioCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
      after,
    });
    if (page.length === 0) {
      break;
    }
    await processPage(page);
    if (page.length < input.maxCandidates) {
      break;
    }
    const last = page[page.length - 1]!;
    after = { electionDate: last.electionDate, electionId: last.electionId, candidateId: last.candidateId };
  }
  return results;
}
