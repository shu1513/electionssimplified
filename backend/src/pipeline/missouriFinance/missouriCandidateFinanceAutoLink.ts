import type { Pool, PoolClient } from "pg";

import {
  missouriCandidateCommitteeSearchKey,
  normalizeMissouriCandidateNameForStorage,
  resolveMissouriCandidateCommittee,
  searchAndResolveMissouriCandidateCommittee,
  searchMissouriMecCandidateCommitteeRecords,
  type MissouriCandidateCommitteeResolution,
  type MissouriCandidateCommitteeSearchInput,
  type MissouriMecCandidateCommitteeRecord,
} from "./missouriCandidateCommitteeResolver.js";
import { MISSOURI_DIRECT_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./missouriFinanceEligibleOffices.js";
import { upsertMissouriFinanceLink } from "./missouriFinanceWriter.js";
import type { MissouriMecSessionOptions } from "./missouriMecClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MissouriFinanceAutoLinkCandidateElection = MissouriCandidateCommitteeSearchInput & {
  candidateId: string;
  electionId: string;
  electionYear: number;
};

export type MissouriFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: MissouriCandidateCommitteeResolution["status"] | "linked";
      mecid?: string;
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
  election_date: string | Date;
  election_year: number;
  office_scope: string;
  office_name: string;
  ballot_title: string;
  district_name: string | null;
  legislative_district: string | null;
};

export type MissouriCandidateCommitteeResolver = (
  input: MissouriCandidateCommitteeSearchInput,
  options?: MissouriMecSessionOptions
) => Promise<MissouriCandidateCommitteeResolution>;

export type MissouriCandidateCommitteeRecordSearch = (
  input: MissouriCandidateCommitteeSearchInput,
  options?: MissouriMecSessionOptions
) => Promise<MissouriMecCandidateCommitteeRecord[]>;

function toIsoDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1]) {
    return match[1];
  }
  throw new Error(`Invalid Missouri candidate election date from database: ${value}`);
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): MissouriFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionDate: toIsoDate(row.election_date),
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    ballotTitle: row.ballot_title,
    districtName: row.district_name,
    legislativeDistrict: row.legislative_district,
  };
}

function toResolverInput(candidate: MissouriFinanceAutoLinkCandidateElection): MissouriCandidateCommitteeSearchInput {
  return {
    candidateName: candidate.candidateName,
    electionDate: candidate.electionDate,
    officeScope: candidate.officeScope,
    officeName: candidate.officeName,
    ballotTitle: candidate.ballotTitle,
    districtName: candidate.districtName,
    legislativeDistrict: candidate.legislativeDistrict,
  };
}

export async function listMissouriCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<MissouriFinanceAutoLinkCandidateElection[]> {
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
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        election.official_ballot_title AS ballot_title,
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
        AND district.state = 'MO'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.mo_candidate_finance_links AS link
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
      [...MISSOURI_DIRECT_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkMissouriCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: MissouriFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: MissouriCandidateCommitteeResolver;
  mecClientOptions?: MissouriMecSessionOptions;
}): Promise<MissouriFinanceAutoLinkResult> {
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveMissouriCandidateCommittee;
  const resolution = await resolveCandidateCommittee(
    toResolverInput(input.candidateElection),
    input.mecClientOptions
  );
  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertMissouriFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeMissouriCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.legislativeDistrict ?? input.candidateElection.districtName,
      committeeId: resolution.mecid,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "mec_portal",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    mecid: resolution.mecid,
  };
}

export async function autoLinkMissingMissouriCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly MissouriFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: MissouriCandidateCommitteeResolver;
  searchCandidateCommitteeRecords?: MissouriCandidateCommitteeRecordSearch;
  mecClientOptions?: MissouriMecSessionOptions;
}): Promise<MissouriFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listMissouriCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  let resolveCandidateCommittee = input.resolveCandidateCommittee;
  if (resolveCandidateCommittee === undefined) {
    const searchRecords = input.searchCandidateCommitteeRecords ?? searchMissouriMecCandidateCommitteeRecords;
    const recordsByRace = new Map<string, Promise<MissouriMecCandidateCommitteeRecord[]>>();
    resolveCandidateCommittee = async (resolverInput, options) => {
      const key = missouriCandidateCommitteeSearchKey(resolverInput);
      let records = recordsByRace.get(key);
      if (records === undefined) {
        records = searchRecords(resolverInput, options);
        recordsByRace.set(key, records);
      }
      return resolveMissouriCandidateCommittee({ ...resolverInput, records: await records });
    };
  }

  const results: MissouriFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkMissouriCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee,
          mecClientOptions: input.mecClientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Missouri finance auto-link failed for candidate election; continuing:", {
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        electionDate: candidateElection.electionDate,
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
