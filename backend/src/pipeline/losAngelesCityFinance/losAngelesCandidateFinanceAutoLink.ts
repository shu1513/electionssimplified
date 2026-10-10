import type { Pool, PoolClient } from "pg";
import {
  getLosAngelesEthicsCandidateTotals,
  getLosAngelesEthicsElections,
  type LosAngelesCityEthicsClientOptions,
} from "./losAngelesCityEthicsClient.js";
import {
  normalizeLosAngelesCandidateName,
  resolveLosAngelesCandidateCommittee,
  resolveLosAngelesEthicsElection,
} from "./losAngelesCandidateCommitteeResolver.js";
import {
  LOS_ANGELES_CITY_FINANCE_ELIGIBLE_OFFICE_NAMES,
  parseLosAngelesCityCouncilSeatNumber,
  parseLosAngelesSchoolBoardSeatNumber,
  toLosAngelesEthicsOfficeName,
} from "./losAngelesCityFinanceEligibleOffices.js";
import { upsertLosAngelesFinanceLink } from "./losAngelesFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export type LosAngelesFinanceAutoLinkCandidate = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeName: string;
  seatNumber: number | null;
};

export async function listLosAngelesCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  },
): Promise<LosAngelesFinanceAutoLinkCandidate[]> {
  const result = await db.query<{
    candidate_id: string;
    election_id: string;
    candidate_name: string;
    election_year: number;
    election_date: string;
    office_name: string;
    official_ballot_title: string;
  }>(
    `SELECT candidate.id::text candidate_id,election.id::text election_id,COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name||' '||candidate.last_name),'')) candidate_name,extract(year from election.election_date)::int election_year,election.election_date::text election_date,office.canonical_name office_name,election.official_ballot_title FROM public.candidate_elections candidate_election JOIN public.candidates candidate ON candidate.id=candidate_election.candidate_id JOIN public.elections election ON election.id=candidate_election.election_id JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id WHERE candidate.deleted_at IS NULL AND district.state='CA' AND ((district.district_type='place' AND district.geoid_compact='0644000' AND office.scope='place') OR (district.district_type='school_unified' AND district.geoid_compact='0622710' AND office.scope='school_unified')) AND office.canonical_name=ANY($5::text[]) AND election.race_type='office' AND election.election_date>=($1::date-make_interval(days=>$3::int)) AND election.election_date<=($1::date+make_interval(days=>$4::int)) AND candidate_election.status NOT IN ('withdrawn','lost') AND NOT EXISTS (SELECT 1 FROM public.lacity_candidate_finance_links link WHERE link.candidate_id=candidate.id AND link.election_id=election.id AND link.link_status='active') ORDER BY (election.election_date < CURRENT_DATE) ASC, random() LIMIT $2::int`,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      LOS_ANGELES_CITY_FINANCE_ELIGIBLE_OFFICE_NAMES,
    ],
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    electionDate: row.election_date.slice(0, 10),
    officeName: row.office_name,
    seatNumber:
      row.office_name === "City Council Member"
        ? parseLosAngelesCityCouncilSeatNumber(row.official_ballot_title)
        : row.office_name === "School Board Member"
          ? parseLosAngelesSchoolBoardSeatNumber(row.official_ballot_title)
          : null,
  }));
}

export async function autoLinkMissingLosAngelesCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  candidates: readonly LosAngelesFinanceAutoLinkCandidate[];
  ethicsClientOptions?: LosAngelesCityEthicsClientOptions;
}): Promise<
  Array<{
    candidateId: string;
    electionId: string;
    status: "linked" | "not_found" | "ambiguous" | "error";
    reason?: string;
  }>
> {
  const results: Array<{
    candidateId: string;
    electionId: string;
    status: "linked" | "not_found" | "ambiguous" | "error";
    reason?: string;
  }> = [];
  const elections = await getLosAngelesEthicsElections(
    input.ethicsClientOptions,
  );
  const totalsByElection = new Map<
    string,
    Awaited<ReturnType<typeof getLosAngelesEthicsCandidateTotals>>
  >();
  for (const candidate of input.candidates) {
    try {
      const election = resolveLosAngelesEthicsElection({
        elections,
        electionYear: candidate.electionYear,
      });
      if (!election) {
        results.push({
          candidateId: candidate.candidateId,
          electionId: candidate.electionId,
          status: "not_found",
          reason: "No unique Los Angeles Ethics election",
        });
        continue;
      }
      const ethicsOfficeName = toLosAngelesEthicsOfficeName({
        officeScope:
          candidate.officeName === "School Board Member"
            ? "school_unified"
            : "place",
        officeCanonicalName: candidate.officeName,
        seatNumber: candidate.seatNumber,
      });
      if (!ethicsOfficeName) {
        results.push({
          candidateId: candidate.candidateId,
          electionId: candidate.electionId,
          status: "not_found",
          reason:
            candidate.officeName === "City Council Member"
              ? "Council seat number could not be parsed from the official ballot title"
              : candidate.officeName === "School Board Member"
                ? "School board seat number could not be parsed from the official ballot title"
                : "Office is not eligible for Los Angeles City finance",
        });
        continue;
      }
      const totalsCacheKey = `${election.electionId}:${ethicsOfficeName}`;
      let totals = totalsByElection.get(totalsCacheKey);
      if (!totals) {
        totals = await getLosAngelesEthicsCandidateTotals(
          { electionId: election.electionId, officeName: ethicsOfficeName },
          input.ethicsClientOptions,
        );
        totalsByElection.set(totalsCacheKey, totals);
      }
      const resolution = resolveLosAngelesCandidateCommittee({
        candidateName: candidate.candidateName,
        officeName: ethicsOfficeName,
        candidates: totals,
      });
      if (resolution.status !== "matched") {
        results.push({
          candidateId: candidate.candidateId,
          electionId: candidate.electionId,
          status: resolution.status,
          reason: resolution.reason,
        });
        continue;
      }
      const total = resolution.candidate;
      await upsertLosAngelesFinanceLink({
        db: input.db,
        link: {
          candidateId: candidate.candidateId,
          electionId: candidate.electionId,
          electionYear: candidate.electionYear,
          candidateNameNormalized: normalizeLosAngelesCandidateName(
            candidate.candidateName,
          ),
          officeName: candidate.officeName,
          seatNumber: candidate.seatNumber,
          ethicsElectionId: total.electionId,
          ethicsCandidatePersonId: total.candidatePersonId,
          ethicsSeatCandidateId: total.electionSeatCandidateId,
          fppcCommitteeId: total.fppcCommitteeId,
          committeeName: total.committeeName,
          internalCommitteePersonId: total.internalCommitteePersonId,
          linkStatus: "active",
          linkSource: "lacity_ethics",
          sourceUrl: total.sourceUrl,
          lastVerifiedAt: input.now,
        },
      });
      results.push({
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        status: "linked",
      });
    } catch (error) {
      results.push({
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
