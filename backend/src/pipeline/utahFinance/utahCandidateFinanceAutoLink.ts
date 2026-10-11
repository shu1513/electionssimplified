import type { Pool, PoolClient } from "pg";

import {
  normalizeUtahCandidateNameKeys,
  searchAndResolveUtahCandidateCommittee,
  type UtahCandidateCommitteeResolution,
  type UtahCandidateCommitteeSearchInput,
} from "./utahCandidateCommitteeResolver.js";
import type { UtahDisclosuresClientOptions } from "./utahDisclosuresClient.js";
import { UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./utahFinanceEligibleOffices.js";
import { upsertUtahFinanceLink } from "./utahFinanceWriter.js";

// Utah had no auto-link step: the due sync only refreshes existing links, and
// nothing created them, so every Utah candidate stayed unlinked. This step
// finds candidate elections without a link, searches disclosures.utah.gov by
// name (the existing resolver), and writes the link when exactly one folder
// matches.

type Queryable = Pick<Pool | PoolClient, "query">;

export type UtahFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  // Bare legislative district number ("57"); null for statewide offices.
  district: string | null;
};

export type UtahFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: "linked";
      folderId: string;
      committeeName: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: Exclude<UtahCandidateCommitteeResolution["status"], "matched">;
      reason: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "error";
      reason: "auto_link_failed";
      error: string;
    };

export type UtahCandidateCommitteeSearchResolver = (
  input: UtahCandidateCommitteeSearchInput,
  options?: UtahDisclosuresClientOptions
) => Promise<UtahCandidateCommitteeResolution>;

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
};

export async function listUtahCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<UtahFinanceAutoLinkCandidateElection[]> {
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
        office.scope AS office_scope,
        office.canonical_name AS office_name,
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
        AND district.state = 'UT'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ut_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Random order, biased toward upcoming races, so unmatched candidates
      -- do not starve the rest under the row cap (same as Washington).
      ORDER BY random() + CASE WHEN election.election_date < CURRENT_DATE THEN 0.5 ELSE 0 END
      LIMIT $2::int
    `,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
  }));
}

function normalizeCandidateNameForStorage(value: string): string {
  return [...normalizeUtahCandidateNameKeys(value)][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

export async function autoLinkUtahCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: UtahFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: UtahCandidateCommitteeSearchResolver;
  disclosuresClientOptions?: UtahDisclosuresClientOptions;
}): Promise<UtahFinanceAutoLinkResult> {
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveUtahCandidateCommittee;
  const candidateElection = input.candidateElection;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: candidateElection.candidateName,
      electionYear: candidateElection.electionYear,
      officeName: candidateElection.officeName,
      district: candidateElection.district,
    },
    input.disclosuresClientOptions
  );

  if (resolution.status !== "matched") {
    return {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertUtahFinanceLink({
    db: input.db,
    link: {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      electionYear: candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(candidateElection.candidateName),
      officeName: candidateElection.officeName,
      district: candidateElection.district,
      folderId: resolution.folderId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "disclosures_advanced_search",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: candidateElection.candidateId,
    electionId: candidateElection.electionId,
    status: "linked",
    folderId: resolution.folderId,
    committeeName: resolution.committeeName,
  };
}

export async function autoLinkMissingUtahCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  candidateElections: readonly UtahFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: UtahCandidateCommitteeSearchResolver;
  disclosuresClientOptions?: UtahDisclosuresClientOptions;
}): Promise<UtahFinanceAutoLinkResult[]> {
  const results: UtahFinanceAutoLinkResult[] = [];
  for (const candidateElection of input.candidateElections) {
    try {
      results.push(
        await autoLinkUtahCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          disclosuresClientOptions: input.disclosuresClientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Utah finance auto-link failed for candidate election; continuing:", {
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
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
  return results;
}
