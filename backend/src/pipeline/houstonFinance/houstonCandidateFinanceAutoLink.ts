import type { Pool } from "pg";
import { loadHoustonCandidateFinanceReports } from "./houstonCampaignFinanceReportSource.js";
import { resolveHoustonCandidateCommittee } from "./houstonCandidateCommitteeResolver.js";
import { upsertHoustonFinanceLink } from "./houstonFinanceWriter.js";
import { HOUSTON_CITY_GEOID } from "./houstonFinanceEligibleOffices.js";
import {
  HOUSTON_FINANCE_OFFICE_NAMES,
  resolveHoustonElectionOfficeTarget,
  type HoustonFinanceOfficeTarget,
} from "./houstonFinanceOfficeTargets.js";

export type HoustonFinanceAutoLinkCandidate = {
  candidateId: string; electionId: string; candidateName: string; firstName: string; lastName: string;
  electionYear: number; electionDate: string;
  officeTarget: HoustonFinanceOfficeTarget;
};

export async function listHoustonCandidateElectionsMissingFinanceLinks(input: {
  db: Pick<Pool, "query">; now: Date; maxCandidates: number; lookbackDays: number; lookaheadDays: number;
}): Promise<HoustonFinanceAutoLinkCandidate[]> {
  const result = await input.db.query<{
    candidate_id: string; election_id: string; candidate_name: string; first_name: string; last_name: string;
    election_year: number; election_date: string; office_name: string; official_ballot_title: string;
  }>(`
    SELECT candidate.id::text AS candidate_id, election.id::text AS election_id,
      COALESCE(NULLIF(trim(candidate.display_name), ''), trim(candidate.first_name || ' ' || candidate.last_name)) AS candidate_name,
      candidate.first_name, candidate.last_name,
      extract(year FROM election.election_date)::int AS election_year,
      election.election_date::text AS election_date,
      office.canonical_name AS office_name, election.official_ballot_title
    FROM public.candidate_elections candidate_election
    JOIN public.candidates candidate ON candidate.id = candidate_election.candidate_id
    JOIN public.elections election ON election.id = candidate_election.election_id
    JOIN public.districts district ON district.id = election.district_id
    JOIN public.offices office ON office.id = election.office_id
    WHERE candidate.deleted_at IS NULL AND candidate.merged_into_candidate_id IS NULL
      AND district.state = 'TX' AND district.district_type = 'place' AND district.geoid_compact = $5
      AND office.scope = 'place' AND office.canonical_name = ANY($6::text[]) AND election.race_type = 'office'
      AND election.election_date BETWEEN ($1::date - make_interval(days => $3)) AND ($1::date + make_interval(days => $4))
      AND candidate_election.status NOT IN ('withdrawn', 'lost')
      AND NOT EXISTS (SELECT 1 FROM public.hou_candidate_finance_links link
        WHERE link.candidate_id = candidate.id AND link.election_id = election.id AND link.link_status = 'active')
    -- Upcoming races first, then random: unmatched candidates never get a
    -- link, so a stable order under a row cap retried the same prefix every
    -- run and starved the tail (Katie Hobbs was never attempted).
    ORDER BY (election.election_date < CURRENT_DATE) ASC, random() LIMIT $2
  `, [input.now.toISOString(), input.maxCandidates, input.lookbackDays, input.lookaheadDays, HOUSTON_CITY_GEOID, HOUSTON_FINANCE_OFFICE_NAMES]);
  return result.rows.flatMap((row) => {
    const officeTarget = resolveHoustonElectionOfficeTarget({
      officeCanonicalName: row.office_name,
      officialBallotTitle: row.official_ballot_title,
    });
    return officeTarget ? [{
      candidateId: row.candidate_id, electionId: row.election_id, candidateName: row.candidate_name,
      firstName: row.first_name, lastName: row.last_name, electionYear: row.election_year,
      electionDate: row.election_date, officeTarget,
    }] : [];
  });
}

export async function autoLinkHoustonCandidateFinance(input: {
  db: Pick<Pool, "query">; candidate: HoustonFinanceAutoLinkCandidate; now: Date; cacheDir?: string; dryRun?: boolean;
}): Promise<{ status: "linked" | "not_found" | "ambiguous"; committeeId?: string }> {
  const reports = await loadHoustonCandidateFinanceReports({
    candidateName: input.candidate.candidateName, firstName: input.candidate.firstName, lastName: input.candidate.lastName,
    electionYear: input.candidate.electionYear, officeTarget: input.candidate.officeTarget, cacheDir: input.cacheDir,
  });
  const resolution = resolveHoustonCandidateCommittee({
    candidateName: input.candidate.candidateName, electionYear: input.candidate.electionYear,
    officeTarget: input.candidate.officeTarget, reports,
  });
  if (resolution.status !== "matched") return { status: resolution.status };
  if (!input.dryRun) await upsertHoustonFinanceLink({ db: input.db, link: {
    candidateId: input.candidate.candidateId, electionId: input.candidate.electionId,
    electionYear: input.candidate.electionYear, candidateNameNormalized: input.candidate.candidateName.toUpperCase(),
    officeName: input.candidate.officeTarget.officeName, district: input.candidate.officeTarget.seat,
    committeeId: resolution.committeeId,
    committeeName: resolution.committeeName, linkSource: "houston_reports", sourceUrl: resolution.sourceUrl,
    lastVerifiedAt: input.now,
  }});
  return { status: "linked", committeeId: resolution.committeeId };
}
