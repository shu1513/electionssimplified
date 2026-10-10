import type { Pool, PoolClient } from "pg";

import {
  normalizeConnecticutCandidateNameKeys,
  resolveConnecticutCandidateCommittee,
  type ConnecticutCandidateCommitteeResolution,
} from "./connecticutCandidateCommitteeResolver.js";
import { CONNECTICUT_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./connecticutFinanceEligibleOffices.js";
import { upsertConnecticutFinanceLink } from "./connecticutFinanceWriter.js";
import type { ConnecticutEcrisArtifactRow } from "./connecticutEcrisArtifactReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ConnecticutFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district: string | null;
};

export type ConnecticutFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: ConnecticutCandidateCommitteeResolution["status"] | "linked";
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
  office_name: string;
  district: string | null;
};

function normalizeCandidateNameForStorage(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): ConnecticutFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeName: row.office_name,
    district: row.district,
  };
}

function receiptValue(row: ConnecticutEcrisArtifactRow, key: string): string {
  return row[key]?.trim() ?? "";
}

function candidateNameFromReceiptRow(row: ConnecticutEcrisArtifactRow): string {
  return [
    receiptValue(row, "Candidate First Name"),
    receiptValue(row, "Candidate Middle Initial") || receiptValue(row, "Candidate Middle Intial"),
    receiptValue(row, "Candidate Last Name"),
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildConnecticutCandidateNamePredicate(
  candidates: readonly ConnecticutFinanceAutoLinkCandidateElection[]
): (row: ConnecticutEcrisArtifactRow) => boolean {
  const candidateNameKeysByYear = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const keys = candidateNameKeysByYear.get(candidate.electionYear) ?? new Set<string>();
    // VoteApp side of the prefilter expands nicknames so the resolver still
    // sees the rows it would match; the row side below stays literal.
    for (const key of normalizeConnecticutCandidateNameKeys(candidate.candidateName, { expandNicknames: true })) {
      keys.add(key);
    }
    candidateNameKeysByYear.set(candidate.electionYear, keys);
  }

  return (row) => {
    for (const keys of candidateNameKeysByYear.values()) {
      for (const rowKey of normalizeConnecticutCandidateNameKeys(candidateNameFromReceiptRow(row))) {
        if (keys.has(rowKey)) {
          return true;
        }
      }
    }
    return false;
  };
}

export async function listConnecticutCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<ConnecticutFinanceAutoLinkCandidateElection[]> {
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
        AND district.state = 'CT'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ct_candidate_finance_links AS link
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
      [...CONNECTICUT_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkConnecticutCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: ConnecticutFinanceAutoLinkCandidateElection;
  receiptRows: readonly ConnecticutEcrisArtifactRow[];
  sourceUrl: string | null;
  now: Date;
}): Promise<ConnecticutFinanceAutoLinkResult> {
  const resolution = resolveConnecticutCandidateCommittee({
    candidateName: input.candidateElection.candidateName,
    officeName: input.candidateElection.officeName,
    electionYear: input.candidateElection.electionYear,
    district: input.candidateElection.district,
    receiptRows: input.receiptRows,
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

  await upsertConnecticutFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "ecris_bulk",
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

export async function autoLinkMissingConnecticutCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  receiptRowsByYear: ReadonlyMap<number, readonly ConnecticutEcrisArtifactRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  candidateElections?: readonly ConnecticutFinanceAutoLinkCandidateElection[];
}): Promise<ConnecticutFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listConnecticutCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: ConnecticutFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkConnecticutCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          receiptRows: input.receiptRowsByYear.get(candidateElection.electionYear) ?? [],
          sourceUrl: input.sourceUrlByYear?.get(candidateElection.electionYear) ?? null,
          now: input.now,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Connecticut finance auto-link failed for candidate election; continuing:", {
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
