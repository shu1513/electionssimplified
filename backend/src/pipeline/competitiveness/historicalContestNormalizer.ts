import { getStateAbbreviationByFips } from "../../constants/usStates.js";
import {
  calculateHistoricalContestMargin,
  type HistoricalContestCompetitivenessLabel,
} from "./competitivenessLabels.js";
import {
  expectedDistrictTypeForHistoricalOffice,
  fromMitDistrict,
  mapHistoricalOfficeTypeToMitOffice,
  type HistoricalContestDistrictType,
  type HistoricalContestOfficeType,
} from "./historicalContestKeys.js";

export type MedslHistoricalContestCandidateRow = {
  year: string | number;
  state_po: string;
  state_fips: string | number;
  office: string;
  district: string | number;
  candidate?: string | null;
  candidatevotes: string | number;
  totalvotes: string | number;
  party_simplified?: string | null;
  party_detailed?: string | null;
  stage?: string | null;
  special?: string | null;
};

// One candidate's total in a past contest; the record keeps every line so a
// multi-seat lookup can re-rank (see candidate_lines below).
export type HistoricalContestCandidateLine = {
  votes: number;
  party: string | null;
};

export type HistoricalContestMarginRecord = {
  source: string;
  source_url: string | null;
  election_year: number;
  state: string;
  state_fips: string;
  office_type: HistoricalContestOfficeType;
  district_type: HistoricalContestDistrictType;
  district_key: string;
  mit_office: string;
  mit_district: string;
  winner_party: string | null;
  runner_up_party: string | null;
  winner_votes: number;
  runner_up_votes: number;
  total_votes: number;
  margin_percent: number;
  competitiveness_label: HistoricalContestCompetitivenessLabel;
  stale_after_redistricting: boolean;
  // Every candidate line sorted by votes descending. winner/runner-up above
  // are lines [0] and [1]; a multi-seat lookup reads [seats - 1] and [seats].
  candidate_lines: HistoricalContestCandidateLine[];
};

export type HistoricalContestNormalizationSkippedRow = {
  reason:
    | "invalid_source"
    | "invalid_year"
    | "invalid_state"
    | "non_general_stage"
    | "special_election"
    | "unsupported_office"
    | "excluded_office"
    | "invalid_district"
    | "invalid_votes";
  row: MedslHistoricalContestCandidateRow;
};

export type HistoricalContestNormalizationResult = {
  records: HistoricalContestMarginRecord[];
  skippedRows: HistoricalContestNormalizationSkippedRow[];
};

type ContestAccumulator = {
  key: string;
  source: string;
  sourceUrl: string | null;
  electionYear: number;
  state: string;
  stateFips: string;
  officeType: HistoricalContestOfficeType;
  districtType: HistoricalContestDistrictType;
  districtKey: string;
  mitOffice: string;
  mitDistrict: string;
  staleAfterRedistricting: boolean;
  totalVotes: number;
  rows: MedslHistoricalContestCandidateRow[];
  candidates: ContestCandidateLine[];
};

type ContestCandidateLine = {
  votes: number;
  party: string | null;
  candidateName: string | null;
};

type AggregatedContestCandidate = {
  votes: number;
  party: string | null;
};

const MIT_OFFICE_TO_HISTORICAL_TYPE: Record<string, HistoricalContestOfficeType> = {
  "US PRESIDENT": "US_PRESIDENT",
  "US SENATE": "US_SENATE",
  "US HOUSE": "US_HOUSE",
  GOVERNOR: "GOVERNOR",
  "LIEUTENANT GOVERNOR": "LIEUTENANT_GOVERNOR",
  "SECRETARY OF STATE": "SECRETARY_OF_STATE",
  "ATTORNEY GENERAL": "ATTORNEY_GENERAL",
  "STATE ATTORNEY GENERAL": "ATTORNEY_GENERAL",
  "COMMONWEALTH ATTORNEY GENERAL": "ATTORNEY_GENERAL",
  "ATTORNEY GENERAL AND REPORTER": "ATTORNEY_GENERAL",
  "STATE TREASURER": "STATE_TREASURER",
  "TREASURER OF STATE": "STATE_TREASURER",
  "COMMONWEALTH TREASURER": "STATE_TREASURER",
  "STATE AUDITOR": "STATE_AUDITOR",
  "AUDITOR OF STATE": "STATE_AUDITOR",
  "AUDITOR OF PUBLIC ACCOUNTS": "STATE_AUDITOR",
  "STATE AUDITOR AND INSPECTOR": "STATE_AUDITOR",
  "STATE AUDITOR OF ACCOUNTS": "STATE_AUDITOR",
  "STATE CONTROLLER": "COMPTROLLER",
  "STATE COMPTROLLER": "COMPTROLLER",
  "COMPTROLLER OF PUBLIC ACCOUNTS": "COMPTROLLER",
  "COMPTROLLER OF THE TREASURY": "COMPTROLLER",
  "SUPERINTENDENT OF PUBLIC INSTRUCTION": "SUPERINTENDENT_OF_PUBLIC_INSTRUCTION",
  "AGRICULTURE COMMISSIONER": "COMMISSIONER_OF_AGRICULTURE",
  "COMMISSIONER OF AGRICULTURE": "COMMISSIONER_OF_AGRICULTURE",
  "INSURANCE COMMISSIONER": "COMMISSIONER_OF_INSURANCE",
  "COMMISSIONER OF INSURANCE": "COMMISSIONER_OF_INSURANCE",
  "LABOR COMMISSIONER": "LABOR_COMMISSIONER",
  "COMMISSIONER OF LABOR": "LABOR_COMMISSIONER",
  "COMMISSIONER OF LABOR AND INDUSTRIES": "LABOR_COMMISSIONER",
  "LABOR AND INDUSTRIES COMMISSIONER": "LABOR_COMMISSIONER",
  "LAND COMMISSIONER": "LAND_COMMISSIONER",
  "COMMISSIONER OF PUBLIC LANDS": "LAND_COMMISSIONER",
  "COMMISSIONER OF STATE LANDS": "LAND_COMMISSIONER",
  "COMMISSIONER OF THE GENERAL LAND OFFICE": "LAND_COMMISSIONER",
  "GENERAL LAND OFFICE COMMISSIONER": "LAND_COMMISSIONER",
  "STATE SENATE": "STATE_SENATE",
  "STATE HOUSE": "STATE_HOUSE",
  "COUNTY SHERIFF": "COUNTY_SHERIFF",
  "DISTRICT ATTORNEY": "DISTRICT_ATTORNEY",
  "COUNTY CLERK": "COUNTY_CLERK",
  "COUNTY ASSESSOR": "COUNTY_ASSESSOR",
  "COUNTY AUDITOR": "COUNTY_AUDITOR",
  "COUNTY TREASURER": "COUNTY_TREASURER",
  "COUNTY RECORDER": "COUNTY_RECORDER",
  "COUNTY CORONER": "COUNTY_CORONER",
};

function normalizeText(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

function parseNonNegativeInteger(value: string | number): number | null {
  const normalized = normalizeText(value);
  if (!/^[0-9]+$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseElectionYear(value: string | number): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed >= 1800 && parsed <= 2100 ? parsed : null;
}

function normalizeStateFips(value: string | number): string | null {
  const normalized = normalizeText(value);
  if (!/^[0-9]+$/.test(normalized)) {
    return null;
  }
  const stateFips = normalized.padStart(2, "0");
  return /^[0-9]{2}$/.test(stateFips) ? stateFips : null;
}

function stateAbbreviationForFips(stateFips: string): string | null {
  try {
    return getStateAbbreviationByFips(stateFips);
  } catch {
    return null;
  }
}

function normalizeMitOffice(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export function isStatewideHistoricalContestMitOffice(value: string): boolean {
  const officeType = MIT_OFFICE_TO_HISTORICAL_TYPE[normalizeMitOffice(value)];
  return officeType ? expectedDistrictTypeForHistoricalOffice(officeType) === "statewide" : false;
}

function normalizeMitDistrict(value: string | number): string {
  const normalized = normalizeText(value).toUpperCase();
  if (/^[0-9]+$/.test(normalized)) {
    return String(Number(normalized)).padStart(3, "0");
  }
  return normalized.replace(/\s+/g, " ");
}

function normalizeParty(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ").toUpperCase();
  return normalized ? normalized : null;
}

function normalizeCandidateName(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ").toUpperCase();
  return normalized ? normalized : null;
}

function addPartyVotes(partyVotes: Map<string, number>, party: string | null, votes: number): void {
  if (!party) {
    return;
  }
  partyVotes.set(party, (partyVotes.get(party) ?? 0) + votes);
}

function chooseLargestVoteParty(partyVotes: Map<string, number>): string | null {
  const [winner] = [...partyVotes.entries()].sort(
    ([leftParty, leftVotes], [rightParty, rightVotes]) =>
      rightVotes - leftVotes || leftParty.localeCompare(rightParty)
  );
  return winner?.[0] ?? null;
}

function aggregateCandidateLines(lines: readonly ContestCandidateLine[]): AggregatedContestCandidate[] {
  const candidatesByName = new Map<string, { votes: number; partyVotes: Map<string, number> }>();
  const candidates: AggregatedContestCandidate[] = [];

  for (const line of lines) {
    if (!line.candidateName) {
      candidates.push({ votes: line.votes, party: line.party });
      continue;
    }

    const existing = candidatesByName.get(line.candidateName) ?? {
      votes: 0,
      partyVotes: new Map<string, number>(),
    };
    existing.votes += line.votes;
    addPartyVotes(existing.partyVotes, line.party, line.votes);
    candidatesByName.set(line.candidateName, existing);
  }

  for (const candidate of candidatesByName.values()) {
    candidates.push({
      votes: candidate.votes,
      party: chooseLargestVoteParty(candidate.partyVotes),
    });
  }

  return candidates;
}

function isGeneralElectionStage(stage: string | null | undefined): boolean {
  const normalized = stage?.trim().toUpperCase();
  return !normalized || normalized === "GEN" || normalized === "GENERAL";
}

function isSpecialElection(value: string | null | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return normalized === "TRUE" || normalized === "YES" || normalized === "Y" || normalized === "1";
}

function canBeStaleAfterRedistricting(districtType: HistoricalContestDistrictType): boolean {
  return districtType === "us_house" || districtType === "state_upper" || districtType === "state_lower";
}

function toContestKey(input: {
  source: string;
  electionYear: number;
  state: string;
  officeType: HistoricalContestOfficeType;
  districtType: HistoricalContestDistrictType;
  districtKey: string;
}): string {
  return [
    input.source,
    input.electionYear,
    input.state,
    input.officeType,
    input.districtType,
    input.districtKey,
  ].join("|");
}

function rowToContestAccumulator(input: {
  source: string;
  sourceUrl: string | null;
  row: MedslHistoricalContestCandidateRow;
  staleAfterRedistricting: boolean;
  allowedOfficeTypes: ReadonlySet<HistoricalContestOfficeType> | null;
}):
  | { ok: true; accumulator: Omit<ContestAccumulator, "candidates" | "rows">; candidate: ContestCandidateLine }
  | { ok: false; skipped: HistoricalContestNormalizationSkippedRow } {
  const electionYear = parseElectionYear(input.row.year);
  if (electionYear === null) {
    return { ok: false, skipped: { reason: "invalid_year", row: input.row } };
  }

  const stateFips = normalizeStateFips(input.row.state_fips);
  if (!stateFips) {
    return { ok: false, skipped: { reason: "invalid_state", row: input.row } };
  }

  const expectedState = stateAbbreviationForFips(stateFips);
  const state = normalizeText(input.row.state_po).toUpperCase() || expectedState;
  if (!expectedState || !state || !/^[A-Z]{2}$/.test(state) || state !== expectedState) {
    return { ok: false, skipped: { reason: "invalid_state", row: input.row } };
  }

  if (!isGeneralElectionStage(input.row.stage)) {
    return { ok: false, skipped: { reason: "non_general_stage", row: input.row } };
  }

  if (isSpecialElection(input.row.special)) {
    return { ok: false, skipped: { reason: "special_election", row: input.row } };
  }

  const mitOffice = normalizeMitOffice(input.row.office);
  const officeType = MIT_OFFICE_TO_HISTORICAL_TYPE[mitOffice];
  if (!officeType) {
    return { ok: false, skipped: { reason: "unsupported_office", row: input.row } };
  }
  if (input.allowedOfficeTypes && !input.allowedOfficeTypes.has(officeType)) {
    return { ok: false, skipped: { reason: "excluded_office", row: input.row } };
  }

  const districtType = expectedDistrictTypeForHistoricalOffice(officeType);
  const mitDistrict =
    districtType === "statewide"
      ? "STATEWIDE"
      : districtType === "county"
        ? normalizeText(input.row.district).toUpperCase()
        : normalizeMitDistrict(input.row.district);
  const districtKey = fromMitDistrict({ districtType, mitDistrict, stateFips });
  if (!districtKey) {
    return { ok: false, skipped: { reason: "invalid_district", row: input.row } };
  }

  const candidateVotes = parseNonNegativeInteger(input.row.candidatevotes);
  const totalVotes = parseNonNegativeInteger(input.row.totalvotes);
  if (candidateVotes === null || totalVotes === null) {
    return { ok: false, skipped: { reason: "invalid_votes", row: input.row } };
  }

  return {
    ok: true,
    accumulator: {
      key: toContestKey({
        source: input.source,
        electionYear,
        state,
        officeType,
        districtType,
        districtKey,
      }),
      source: input.source,
      sourceUrl: input.sourceUrl,
      electionYear,
      state,
      stateFips,
      officeType,
      districtType,
      districtKey,
      mitOffice: mapHistoricalOfficeTypeToMitOffice(officeType),
      mitDistrict,
      staleAfterRedistricting: canBeStaleAfterRedistricting(districtType) && input.staleAfterRedistricting,
      totalVotes,
    },
    candidate: {
      votes: candidateVotes,
      party: normalizeParty(input.row.party_simplified) ?? normalizeParty(input.row.party_detailed),
      candidateName: normalizeCandidateName(input.row.candidate),
    },
  };
}

function contestToRecord(contest: ContestAccumulator): HistoricalContestMarginRecord | null {
  const sortedCandidates = aggregateCandidateLines(contest.candidates).sort((left, right) => right.votes - left.votes);
  const winner = sortedCandidates[0];
  if (!winner) {
    return null;
  }

  const runnerUp = sortedCandidates[1] ?? { votes: 0, party: null };
  const margin = calculateHistoricalContestMargin({
    winnerVotes: winner.votes,
    runnerUpVotes: runnerUp.votes,
    totalVotes: contest.totalVotes,
  });
  if (!margin) {
    return null;
  }

  return {
    source: contest.source,
    source_url: contest.sourceUrl,
    election_year: contest.electionYear,
    state: contest.state,
    state_fips: contest.stateFips,
    office_type: contest.officeType,
    district_type: contest.districtType,
    district_key: contest.districtKey,
    mit_office: contest.mitOffice,
    mit_district: contest.mitDistrict,
    winner_party: winner.party,
    runner_up_party: runnerUp.party,
    winner_votes: winner.votes,
    runner_up_votes: runnerUp.votes,
    total_votes: contest.totalVotes,
    margin_percent: margin.marginPercent,
    competitiveness_label: margin.competitivenessLabel,
    stale_after_redistricting: contest.staleAfterRedistricting,
    candidate_lines: sortedCandidates.map((candidate) => ({ votes: candidate.votes, party: candidate.party })),
  };
}

export function normalizeMedslHistoricalContestMargins(input: {
  source: string;
  sourceUrl?: string | null;
  rows: readonly MedslHistoricalContestCandidateRow[];
  officeTypes?: readonly HistoricalContestOfficeType[];
  staleAfterRedistricting?: boolean;
}): HistoricalContestNormalizationResult {
  const source = input.source.trim();
  if (!source) {
    return {
      records: [],
      skippedRows: input.rows.map((row) => ({ reason: "invalid_source", row })),
    };
  }

  const contests = new Map<string, ContestAccumulator>();
  const skippedRows: HistoricalContestNormalizationSkippedRow[] = [];
  const sourceUrl = input.sourceUrl?.trim() || null;
  const staleAfterRedistricting = input.staleAfterRedistricting ?? false;
  const allowedOfficeTypes = input.officeTypes?.length ? new Set(input.officeTypes) : null;

  for (const row of input.rows) {
    const parsed = rowToContestAccumulator({
      source,
      sourceUrl,
      row,
      staleAfterRedistricting,
      allowedOfficeTypes,
    });
    if (!parsed.ok) {
      skippedRows.push(parsed.skipped);
      continue;
    }

    const existing = contests.get(parsed.accumulator.key);
    if (existing) {
      existing.totalVotes = Math.max(existing.totalVotes, parsed.accumulator.totalVotes);
      existing.rows.push(row);
      existing.candidates.push(parsed.candidate);
      continue;
    }

    contests.set(parsed.accumulator.key, {
      ...parsed.accumulator,
      rows: [row],
      candidates: [parsed.candidate],
    });
  }

  const records: HistoricalContestMarginRecord[] = [];
  for (const contest of contests.values()) {
    const record = contestToRecord(contest);
    if (record) {
      records.push(record);
      continue;
    }
    skippedRows.push(...contest.rows.map((row) => ({ reason: "invalid_votes" as const, row })));
  }

  records.sort((left, right) =>
    left.state.localeCompare(right.state) ||
    left.office_type.localeCompare(right.office_type) ||
    left.district_key.localeCompare(right.district_key) ||
    left.election_year - right.election_year
  );

  return { records, skippedRows };
}
