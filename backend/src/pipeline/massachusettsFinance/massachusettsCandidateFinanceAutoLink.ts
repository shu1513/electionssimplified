import type { Pool, PoolClient } from "pg";

import {
  normalizeMassachusettsCandidateNameKeys,
  searchAndResolveMassachusettsCandidateCommittee,
  type MassachusettsCandidateCommitteeResolution,
} from "./massachusettsCandidateCommitteeResolver.js";
import {
  MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_BY_GEOID,
  massachusettsMunicipalFinanceCityForGeoid,
  normalizeMassachusettsOcpfDistrict,
} from "./massachusettsFinanceEligibleOffices.js";
import { upsertMassachusettsFinanceLink } from "./massachusettsFinanceWriter.js";
import type { MassachusettsOcpfClientOptions } from "./massachusettsOcpfClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MassachusettsFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type MassachusettsFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: MassachusettsCandidateCommitteeResolution["status"] | "linked";
      candidateCpfId?: string;
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
  office_scope: string;
  office_name: string;
  district: string | null;
  district_type: string | null;
  geoid_compact: string | null;
};

export type MassachusettsCandidateCommitteeResolver = (
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
    district?: string | null;
  },
  options?: MassachusettsOcpfClientOptions
) => Promise<MassachusettsCandidateCommitteeResolution>;

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeMassachusettsCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): MassachusettsFinanceAutoLinkCandidateElection {
  // Municipal rows carry the OCPF city token in the district slot; the SQL
  // gate already restricted place rows to allowlisted GEOIDs. Legislative
  // rows carry the catalog district NAME — OCPF identifies legislative
  // districts by county-list name ("Senate, Middlesex and Norfolk"), so a
  // GEOID-derived token could never match a filer's office label.
  const district =
    row.office_scope === "place"
      ? massachusettsMunicipalFinanceCityForGeoid(row.geoid_compact)
      : normalizeMassachusettsOcpfDistrict(row.district);
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district,
  };
}

export async function listMassachusettsCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<MassachusettsFinanceAutoLinkCandidateElection[]> {
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
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(trim(district.name), '')
          ELSE NULL
        END AS district,
        district.district_type AS district_type,
        district.geoid_compact AS geoid_compact
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
        AND district.state = 'MA'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND (
          office.scope <> 'place'
          OR (district.district_type = 'place' AND district.geoid_compact = ANY($6::text[]))
        )
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ma_candidate_finance_links AS link
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
      [...MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS],
      [...MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_BY_GEOID.keys()],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkMassachusettsCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: MassachusettsFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: MassachusettsCandidateCommitteeResolver;
  ocpfClientOptions?: MassachusettsOcpfClientOptions;
}): Promise<MassachusettsFinanceAutoLinkResult> {
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveMassachusettsCandidateCommittee;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: input.candidateElection.candidateName,
      officeScope: input.candidateElection.officeScope,
      officeName: input.candidateElection.officeName,
      electionYear: input.candidateElection.electionYear,
      district: input.candidateElection.district,
    },
    input.ocpfClientOptions
  );

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertMassachusettsFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      candidateCpfId: resolution.candidateCpfId,
      filerName: resolution.filerName,
      committeeName: resolution.committeeName ?? resolution.filerName,
      linkStatus: "active",
      linkSource: "ocpf_api",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    candidateCpfId: resolution.candidateCpfId,
  };
}

export async function autoLinkMissingMassachusettsCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly MassachusettsFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: MassachusettsCandidateCommitteeResolver;
  ocpfClientOptions?: MassachusettsOcpfClientOptions;
}): Promise<MassachusettsFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listMassachusettsCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: MassachusettsFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkMassachusettsCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          ocpfClientOptions: input.ocpfClientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Massachusetts finance auto-link failed for candidate election; continuing:", {
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
  return results;
}
