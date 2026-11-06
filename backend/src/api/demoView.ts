// Demo mode (the site's /demo pages; see usLocalDate.ts): the public read
// endpoints answer as if today were DEMO_TODAY_ISO. The demo clock already
// decides which elections count as upcoming. These functions take what is
// only known after that date out of a response: who won, and candidate
// records dated later.
//
// Pure functions over the response shapes; the API server applies them to
// demo requests only, so a normal response never passes through here.
import type { BallotLookupElection, BallotSummaryResult } from "../pipeline/address/ballotLookup.js";
import type { CandidateDetailResult } from "../pipeline/candidates/candidateDetailReader.js";
import type { UserElectionChoice } from "../pipeline/users/userElectionChoices.js";
import { DEMO_TODAY_ISO } from "../utils/usLocalDate.js";
import type { BrowseDistrictResult } from "./browseCatalog.js";

// The candidacy statuses that only an election result assigns. Before
// results a candidacy is "declared" (or "withdrawn", which stays).
const RESULT_STATUSES: ReadonlySet<string> = new Set(["won", "lost", "advanced", "runoff"]);

/** On the demo date this election has not been held yet. */
function isUndecided(electionDate: string): boolean {
  return electionDate >= DEMO_TODAY_ISO;
}

function withoutResultStatus<Row extends { status: string }>(row: Row): Row {
  return RESULT_STATUSES.has(row.status) ? ({ ...row, status: "declared" } as Row) : row;
}

function knownOnDemoDate(record: { event_date: string }): boolean {
  return record.event_date <= DEMO_TODAY_ISO;
}

// Generic because the saved-address update answers with a ballot summary
// plus fields of its own, which pass through untouched.
export function toDemoBallotSummary<Result extends BallotSummaryResult>(result: Result): Result {
  return {
    ...result,
    elections: result.elections.map((election) => {
      if (!isUndecided(election.election_date)) {
        return election;
      }
      return {
        ...election,
        has_results: false,
        current_result_outcome: null,
        current_result_winners: [],
        ...(election.preview
          ? { preview: { ...election.preview, candidates: election.preview.candidates.map(withoutResultStatus) } }
          : {}),
      };
    }),
  };
}

export function toDemoElectionDetail(election: BallotLookupElection): BallotLookupElection {
  const candidates = election.candidates.map((candidate) => ({
    ...candidate,
    records: candidate.records.filter(knownOnDemoDate),
  }));
  if (!isUndecided(election.election_date)) {
    return { ...election, candidates };
  }
  return {
    ...election,
    candidates: candidates.map(withoutResultStatus),
    results: [],
    ballot_measure: election.ballot_measure ? { ...election.ballot_measure, result: null, results: [] } : null,
  };
}

export function toDemoCandidateDetail(result: CandidateDetailResult): CandidateDetailResult {
  const { candidate } = result;
  return {
    ...result,
    candidate: {
      ...candidate,
      records: candidate.records.filter(knownOnDemoDate),
      elections: candidate.elections.map((election) =>
        isUndecided(election.election_date) ? withoutResultStatus(election) : election
      ),
    },
  };
}

export function toDemoBrowseDistrict(result: BrowseDistrictResult): BrowseDistrictResult {
  return {
    ...result,
    elections: result.elections.map((election) =>
      isUndecided(election.election_date)
        ? { ...election, candidates: election.candidates.map(withoutResultStatus) }
        : election
    ),
  };
}

/** One of the signed-in visitor's own picks (the list read and the read-back
 * after a write share this shape). */
export function toDemoElectionChoice(choice: UserElectionChoice): UserElectionChoice {
  if (!isUndecided(choice.election_date)) {
    return choice;
  }
  return {
    ...choice,
    picks: choice.picks.map((pick) =>
      RESULT_STATUSES.has(pick.candidacy_status) ? { ...pick, candidacy_status: "declared" } : pick
    ),
    measure_result: null,
    current_result_outcome: null,
    current_result_winners: [],
  };
}
