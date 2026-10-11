import { firstNameVariants } from "../finance/personFirstNameNicknames.js";

export type OregonCandidateCommitteeSearchRow = {
  filerCommitteeId: string | null;
  filerCommitteeName: string | null;
  committeeUrl: string | null;
  candidateFirstName?: string | null;
  candidateLastName?: string | null;
  candidateOffice?: string | null;
  activeElection?: string | null;
};

export type OregonCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence:
    | "candidate_identity"
    | "candidate_identity_and_context"
    | "exact"
    | "name_contains_candidate";
  source: "orestar_public";
  sourceUrl: string | null;
  matchedCommitteeRowCount: number;
};

export type OregonCandidateCommitteeResolution =
  | ({ status: "matched" } & OregonCandidateCommitteeMatch)
  | {
      status: "no_match";
      reason: string;
      matchedCommitteeRowCount: number;
    }
  | {
      status: "ambiguous";
      reason: string;
      matches: OregonCandidateCommitteeMatch[];
      matchedCommitteeRowCount: number;
    };

export type OregonCandidateCommitteeResolver = (input: {
  candidateName: string;
  searchRows: readonly OregonCandidateCommitteeSearchRow[];
  electionYear?: number;
  officeName?: string;
  officeScope?: string;
  district?: string | null;
  sourceUrl?: string | null;
}) => Promise<OregonCandidateCommitteeResolution> | OregonCandidateCommitteeResolution;

export function normalizeOregonCandidateNameForStorage(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function committeeKey(input: { committeeId: string; committeeName: string }): string {
  return `${input.committeeId}\u0000${normalizeOregonCandidateNameForStorage(input.committeeName)}`;
}

function candidateTokens(candidateName: string): string[] {
  return normalizeOregonCandidateNameForStorage(candidateName)
    .split(" ")
    .filter((token) => token.length > 1);
}

// expandNicknames also accepts a nickname variant of the VoteApp first name
// ("Dan Farrington" → ORESTAR "Daniel"). VoteApp side only; see
// personFirstNameNicknames.ts.
function isStructuredCandidateNameMatch(input: {
  candidateName: string;
  candidateFirstName: string | null | undefined;
  candidateLastName: string | null | undefined;
  expandNicknames?: boolean;
}): boolean {
  const candidate = candidateTokens(input.candidateName);
  const first = candidateTokens(input.candidateFirstName ?? "");
  const last = candidateTokens(input.candidateLastName ?? "");
  if (candidate.length < 2 || first.length === 0 || last.length === 0) {
    return false;
  }
  const candidateFirst = candidate[0]!;
  const firstMatches =
    candidateFirst === first[0] ||
    (input.expandNicknames === true && firstNameVariants(candidateFirst).includes(first[0]!));
  return firstMatches && candidate.slice(-last.length).join(" ") === last.join(" ");
}

function activeElectionMatchesYear(value: string | null | undefined, electionYear: number): boolean {
  return new RegExp(`\\b${electionYear}\\b`).test(value ?? "");
}

function officeKey(value: string | null | undefined): string {
  const normalized = normalizeOregonCandidateNameForStorage(value ?? "");
  if (/STATE (?:LOWER CHAMBER LEGISLATOR|REPRESENTATIVE)/.test(normalized)) {
    return "STATE REPRESENTATIVE";
  }
  if (/STATE (?:UPPER CHAMBER LEGISLATOR|SENATOR)/.test(normalized)) {
    return "STATE SENATOR";
  }
  if (/SECRETARY OF STATE/.test(normalized)) {
    return "SECRETARY OF STATE";
  }
  if (/GOVERNOR/.test(normalized)) {
    return "GOVERNOR";
  }
  return normalized;
}

function officeMatches(input: {
  candidateOffice: string | null | undefined;
  officeName: string | undefined;
}): boolean {
  const candidateOffice = officeKey(input.candidateOffice);
  const officeName = officeKey(input.officeName);
  return Boolean(
    candidateOffice &&
      officeName &&
      (candidateOffice === officeName || candidateOffice.includes(officeName) || officeName.includes(candidateOffice))
  );
}

const KNOWN_OFFICE_KEYS = new Set(["STATE REPRESENTATIVE", "STATE SENATOR", "SECRETARY OF STATE", "GOVERNOR"]);

function districtNumber(value: string | null | undefined): string | null {
  return /\b(\d+)(?:ST|ND|RD|TH)?\b/.exec(normalizeOregonCandidateNameForStorage(value ?? ""))?.[1] ?? null;
}

// A nickname row is weaker evidence than a literal one, so it must not
// contradict the race. ORESTAR's office text is free-form ("17th District",
// "State Representative District 32"), so only a recognized office on both
// sides, or an explicit district number on both sides, can contradict;
// missing or unrecognized text is not a contradiction.
function rowContradictsRace(
  row: OregonCandidateCommitteeSearchRow,
  input: { officeName?: string; district?: string | null }
): boolean {
  const rowOffice = officeKey(row.candidateOffice);
  const wantedOffice = officeKey(input.officeName);
  if (KNOWN_OFFICE_KEYS.has(rowOffice) && KNOWN_OFFICE_KEYS.has(wantedOffice) && rowOffice !== wantedOffice) {
    return true;
  }
  const rowDistrict = districtNumber(row.candidateOffice);
  const wantedDistrict = districtNumber(input.district);
  return rowDistrict !== null && wantedDistrict !== null && rowDistrict !== wantedDistrict;
}

function officeDistrictMatches(candidateOffice: string | null | undefined, district: string | null | undefined): boolean {
  const normalizedDistrict = normalizeOregonCandidateNameForStorage(district ?? "");
  if (!normalizedDistrict) {
    return false;
  }
  const office = normalizeOregonCandidateNameForStorage(candidateOffice ?? "");
  return new RegExp(`\\b(?:DISTRICT\\s+)?${normalizedDistrict.replace(/\s+/g, "\\s+")}\\b`).test(office);
}

function isCommitteeNameCandidateMatch(input: { candidateName: string; committeeName: string }): boolean {
  const candidate = normalizeOregonCandidateNameForStorage(input.candidateName);
  const committee = normalizeOregonCandidateNameForStorage(input.committeeName);
  if (!candidate || !committee) {
    return false;
  }
  if (committee.includes(candidate)) {
    return true;
  }
  const tokens = candidateTokens(input.candidateName);
  return tokens.length >= 2 && tokens.every((token) => committee.includes(token));
}

export function resolveOregonCandidateCommitteeFromSearchRows(input: {
  candidateName: string;
  searchRows: readonly OregonCandidateCommitteeSearchRow[];
  electionYear?: number;
  officeName?: string;
  officeScope?: string;
  district?: string | null;
  sourceUrl?: string | null;
}): OregonCandidateCommitteeResolution {
  const candidateName = normalizeOregonCandidateNameForStorage(input.candidateName);
  if (!candidateName) {
    throw new Error("Oregon candidate name is required");
  }

  // Literal names first; nicknames only when nothing matched literally, so a
  // literal match never turns ambiguous because of a nickname row. A nickname
  // row also has to agree with the race: a lone "Daniel Smith" running for
  // Senate district 8 is not House district 17's "Dan Smith".
  const structuredMatchesFor = (expandNicknames: boolean) =>
    input.searchRows.filter((row) =>
      isStructuredCandidateNameMatch({
        candidateName: input.candidateName,
        candidateFirstName: row.candidateFirstName,
        candidateLastName: row.candidateLastName,
        expandNicknames,
      })
    );
  const literalStructuredMatches = structuredMatchesFor(false);
  const nicknameStructuredMatches = structuredMatchesFor(true);
  const otherRaceRows = new Set(
    literalStructuredMatches.length > 0 ? [] : nicknameStructuredMatches.filter((row) => rowContradictsRace(row, input))
  );
  const structuredNameMatches =
    literalStructuredMatches.length > 0
      ? literalStructuredMatches
      : nicknameStructuredMatches.filter((row) => !otherRaceRows.has(row));
  let selectedStructuredMatches = structuredNameMatches;
  let usedContext = false;
  if (selectedStructuredMatches.length > 1 && input.electionYear !== undefined) {
    const electionMatches = selectedStructuredMatches.filter((row) =>
      activeElectionMatchesYear(row.activeElection, input.electionYear!)
    );
    if (electionMatches.length > 0) {
      selectedStructuredMatches = electionMatches;
      usedContext = true;
    }
  }
  if (selectedStructuredMatches.length > 1 && input.officeName) {
    const officeMatchesForCandidate = selectedStructuredMatches.filter((row) =>
      officeMatches({ candidateOffice: row.candidateOffice, officeName: input.officeName })
    );
    if (officeMatchesForCandidate.length > 0) {
      selectedStructuredMatches = officeMatchesForCandidate;
      usedContext = true;
    }
  }
  if (selectedStructuredMatches.length > 1 && input.district) {
    const districtMatches = selectedStructuredMatches.filter((row) =>
      officeDistrictMatches(row.candidateOffice, input.district)
    );
    if (districtMatches.length > 0) {
      selectedStructuredMatches = districtMatches;
      usedContext = true;
    }
  }

  const rowsToMatch = structuredNameMatches.length > 0
    ? selectedStructuredMatches
    : input.searchRows.filter((row) => {
        // A row already placed in another race by its own candidate fields
        // does not come back through its committee name.
        if (otherRaceRows.has(row)) {
          return false;
        }
        const committeeName = row.filerCommitteeName?.trim();
        return Boolean(
          committeeName &&
            isCommitteeNameCandidateMatch({ candidateName: input.candidateName, committeeName })
        );
      });
  const matches = new Map<string, OregonCandidateCommitteeMatch>();
  let matchedCommitteeRowCount = 0;
  for (const row of rowsToMatch) {
    const committeeId = row.filerCommitteeId?.trim();
    const committeeName = row.filerCommitteeName?.trim();
    if (!committeeId || !committeeName) {
      continue;
    }
    matchedCommitteeRowCount += 1;
    const key = committeeKey({ committeeId, committeeName });
    const existing = matches.get(key);
    if (existing) {
      matches.set(key, {
        ...existing,
        matchedCommitteeRowCount: existing.matchedCommitteeRowCount + 1,
      });
      continue;
    }
    matches.set(key, {
      committeeId,
      committeeName,
      confidence: structuredNameMatches.length > 0
        ? usedContext
          ? "candidate_identity_and_context"
          : "candidate_identity"
        : normalizeOregonCandidateNameForStorage(committeeName).includes(candidateName)
          ? "exact"
          : "name_contains_candidate",
      source: "orestar_public",
      sourceUrl: row.committeeUrl ?? input.sourceUrl ?? null,
      matchedCommitteeRowCount: 1,
    });
  }

  const uniqueMatches = [...matches.values()].sort((left, right) =>
    left.committeeName.localeCompare(right.committeeName)
  );
  if (uniqueMatches.length === 0) {
    return {
      status: "no_match",
      reason: "No ORESTAR committee rows matched the structured candidate identity or committee name",
      matchedCommitteeRowCount,
    };
  }
  if (uniqueMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: structuredNameMatches.length > 0
        ? "Multiple ORESTAR committees matched the structured candidate identity and available context"
        : "Multiple ORESTAR committees matched the candidate name",
      matches: uniqueMatches,
      matchedCommitteeRowCount,
    };
  }
  return {
    status: "matched",
    ...uniqueMatches[0]!,
    matchedCommitteeRowCount,
  };
}
