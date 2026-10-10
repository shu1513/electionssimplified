import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import type { ColoradoTracerContributionRow } from "./coloradoTracerContributionReader.js";

export type ColoradoCandidateCommitteeResolution =
  | {
      status: "matched";
      committeeId: string;
      committeeName: string;
      sourceUrl: string | null;
    }
  | {
      status: "unmatched" | "ambiguous";
      reason: string;
    };

type CandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
};

function normalizeTextKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeColoradoCandidateNameKeys(value: string): Set<string> {
  const keys = new Set<string>();
  const trimmed = value.trim();
  const direct = normalizeTextKey(trimmed);
  if (direct) {
    keys.add(direct);
  }

  const commaParts = trimmed.split(",");
  if (commaParts.length >= 2) {
    const lastName = commaParts[0]?.trim() ?? "";
    const firstNames = commaParts.slice(1).join(" ").trim();
    const flipped = normalizeTextKey(`${firstNames} ${lastName}`);
    if (flipped) {
      keys.add(flipped);
    }
  }

  return keys;
}

function parseColoradoTracerDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  return null;
}

function isElectionCycleContribution(row: ColoradoTracerContributionRow, electionYear: number): boolean {
  const year = parseColoradoTracerDateYear(row.ContributionDate);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function isCandidateCommittee(row: ColoradoTracerContributionRow): boolean {
  return normalizeTextKey(row.CommitteeType).includes("CANDIDATE");
}

function normalizePersonName(value: string): string {
  return normalizeTextKey(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowMatchesCandidateName(input: {
  row: ColoradoTracerContributionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  for (const key of normalizeColoradoCandidateNameKeys(input.row.CandidateName)) {
    if (input.candidateNameKeys.has(key)) {
      return true;
    }
  }
  // The key set carries only full-string and comma-flip keys, so a name that
  // differs in middle content on one side ("John A. Smith" vs "Smith, John")
  // never overlaps and the link silently strands. Recover it through the
  // middle-evidence gate: first+last alignment matches unless the middles
  // contradict.
  // TRACER carries the formal name ("PHILIP WEISER") while VoteApp stores
  // the campaign name ("Phil Weiser"); nickname equivalence is one-sided,
  // VoteApp → row (personFirstNameNicknames.ts explains why).
  return personNamesMatchWithMiddleEvidence({
    candidateName: input.candidateName,
    rowNames: [input.row.CandidateName],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

export function resolveColoradoCandidateCommittee(input: {
  candidateName: string;
  electionYear: number;
  contributionRows: readonly ColoradoTracerContributionRow[];
  sourceUrl?: string | null;
}): ColoradoCandidateCommitteeResolution {
  if (!Number.isInteger(input.electionYear) || input.electionYear < 2001 || input.electionYear > 2100) {
    throw new Error(`Invalid Colorado candidate committee election year: ${input.electionYear}`);
  }

  const candidateNameKeys = normalizeColoradoCandidateNameKeys(input.candidateName);
  if (candidateNameKeys.size === 0) {
    return { status: "unmatched", reason: "missing_candidate_name" };
  }

  const matches = new Map<string, CandidateCommitteeMatch>();
  for (const row of input.contributionRows) {
    const committeeId = row.CO_ID.trim().toUpperCase();
    const committeeName = row.CommitteeName.trim();
    if (!committeeId || !committeeName) {
      continue;
    }
    if (!isCandidateCommittee(row) || !isElectionCycleContribution(row, input.electionYear)) {
      continue;
    }
    if (!rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }
    matches.set(committeeId, {
      committeeId,
      committeeName,
    });
  }

  if (matches.size === 0) {
    return { status: "unmatched", reason: "no_candidate_committee_match" };
  }
  if (matches.size > 1) {
    return { status: "ambiguous", reason: "multiple_matching_committees" };
  }

  const match = [...matches.values()][0];
  if (!match) {
    return { status: "unmatched", reason: "no_candidate_committee_match" };
  }
  return {
    status: "matched",
    committeeId: match.committeeId,
    committeeName: match.committeeName,
    sourceUrl: input.sourceUrl ?? null,
  };
}
