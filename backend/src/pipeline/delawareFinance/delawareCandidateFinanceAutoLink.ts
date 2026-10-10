// Delaware finance auto-link: creates missing candidate -> committee links
// (links only, never summaries). Mirrors the Missouri shape: list candidate
// elections in eligible offices with no active link, resolve each through
// the office-filtered committee search, and write only exact matches with
// linkSource "cfrs_portal" — the writer's manual-link protection guarantees
// operator links always win. Per-race searches are deduplicated so one
// office+district race hits the portal once.

import type { Pool, PoolClient } from "pg";

import type { DelawareCfrsSessionOptions } from "./delawareCfrsClient.js";
import {
  normalizeDelawareCandidateNameForStorage,
  searchAndResolveDelawareCandidateCommittee,
  type DelawareCandidateCommitteeSearchInput,
  type DelawareCommitteeResolution,
} from "./delawareCandidateCommitteeResolver.js";
import { DELAWARE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./delawareFinanceEligibleOffices.js";
import { upsertDelawareFinanceLink } from "./delawareFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type DelawareFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionDate: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  districtName: string | null;
  legislativeDistrict: string | null;
};

export type DelawareFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "unmatched" | "ambiguous" | "error";
  reason?: string;
  cfId?: string;
  committeeName?: string;
  error?: string;
};

export type DelawareCandidateCommitteeResolver = (
  input: DelawareCandidateCommitteeSearchInput,
  options?: DelawareCfrsSessionOptions
) => Promise<DelawareCommitteeResolution>;

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_date: string | Date;
  election_year: number;
  office_scope: string;
  office_name: string;
  district_name: string | null;
  legislative_district: string | null;
};

function toIsoDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1]) {
    return match[1];
  }
  throw new Error(`Invalid Delaware candidate election date from database: ${value}`);
}

export async function listDelawareCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<DelawareFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        election.election_date,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        office.canonical_name AS office_name,
        district.name AS district_name,
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
        END AS legislative_district
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
        AND district.state = 'DE'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.de_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $2::int
    `,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...DELAWARE_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionDate: toIsoDate(row.election_date),
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    districtName: row.district_name,
    legislativeDistrict: row.legislative_district,
  }));
}

export async function autoLinkDelawareCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: DelawareFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: DelawareCandidateCommitteeResolver;
  cfrsClientOptions?: DelawareCfrsSessionOptions;
}): Promise<DelawareFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const resolve = input.resolveCandidateCommittee ?? searchAndResolveDelawareCandidateCommittee;
  const resolution = await resolve(
    {
      candidateName: candidate.candidateName,
      officeScope: candidate.officeScope,
      officeName: candidate.officeName,
      district: candidate.legislativeDistrict ?? candidate.districtName,
    },
    input.cfrsClientOptions
  );
  if (resolution.status !== "matched") {
    return {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }
  await upsertDelawareFinanceLink({
    db: input.db,
    link: {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      electionYear: candidate.electionYear,
      candidateNameNormalized: normalizeDelawareCandidateNameForStorage(candidate.candidateName),
      officeName: candidate.officeName,
      district: candidate.legislativeDistrict ?? candidate.districtName,
      committeeId: resolution.cfId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "cfrs_portal",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });
  return {
    candidateId: candidate.candidateId,
    electionId: candidate.electionId,
    status: "linked",
    cfId: resolution.cfId,
    committeeName: resolution.committeeName,
  };
}

export async function autoLinkMissingDelawareCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly DelawareFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: DelawareCandidateCommitteeResolver;
  cfrsClientOptions?: DelawareCfrsSessionOptions;
}): Promise<DelawareFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listDelawareCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const resolve = input.resolveCandidateCommittee ?? searchAndResolveDelawareCandidateCommittee;

  // One live search per office+district race, shared across its candidates.
  const raceResolutions = new Map<string, Map<string, DelawareCommitteeResolution>>();
  const results: DelawareFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      const raceKey = `${candidate.officeScope}::${candidate.officeName}::${candidate.legislativeDistrict ?? candidate.districtName ?? ""}`;
      let byCandidate = raceResolutions.get(raceKey);
      if (byCandidate === undefined) {
        byCandidate = new Map();
        raceResolutions.set(raceKey, byCandidate);
      }
      let resolution = byCandidate.get(candidate.candidateName);
      if (resolution === undefined) {
        resolution = await resolve(
          {
            candidateName: candidate.candidateName,
            officeScope: candidate.officeScope,
            officeName: candidate.officeName,
            district: candidate.legislativeDistrict ?? candidate.districtName,
          },
          input.cfrsClientOptions
        );
        byCandidate.set(candidate.candidateName, resolution);
      }
      results.push(
        await autoLinkDelawareCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          now: input.now,
          resolveCandidateCommittee: async () => resolution!,
        })
      );
    } catch (error) {
      results.push({
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
