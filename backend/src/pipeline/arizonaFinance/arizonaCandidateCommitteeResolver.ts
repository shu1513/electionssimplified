import {
  searchArizonaSpotlightCandidateCommittees,
  type ArizonaSpotlightCandidateCommitteeMatch,
  type ArizonaSpotlightClientOptions,
} from "./arizonaSpotlightClient.js";
import { normalizeArizonaFinanceOffice } from "./arizonaFinanceEligibleOffices.js";

export type ArizonaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  limit?: number;
};

export type ArizonaCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "single_committee" | "surname_committee";
  source: "spotlight";
  sourceUrl: string | null;
  matchedIncomeRowCount: number;
  totalIncomeAmount: number;
};

export type ArizonaCandidateCommitteeResolution =
  | ({ status: "matched" } & ArizonaCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason: "missing_candidate_name" | "unsupported_office" | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: ArizonaCandidateCommitteeMatch[];
    };

export type ArizonaCandidateCommitteeResolverClient = {
  searchCandidateCommittees: typeof searchArizonaSpotlightCandidateCommittees;
};

const DEFAULT_CLIENT: ArizonaCandidateCommitteeResolverClient = {
  searchCandidateCommittees: searchArizonaSpotlightCandidateCommittees,
};

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|OF|FOR)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeArizonaCandidateNameForStorage(value: string): string {
  return normalizeTextKey(value) || value.trim().replace(/\s+/g, " ").toUpperCase();
}

// Spotlight's FilerName search is a substring match on the committee name,
// and its CandidateName filter is ignored (live: it returns unrelated rows).
// Statewide committees are often named by surname alone ("Fontes for AZ"),
// so a full-name search finds nothing for them. The surname fallback below
// is limited to statewide races and admits a committee only when its name,
// minus wrappers and office words, is exactly the surname, and any office
// word in the name agrees with the race.
const STATEWIDE_OFFICE_WORDS: Record<string, readonly string[]> = {
  Governor: ["GOVERNOR", "GOV"],
  "Secretary of State": ["SECRETARY", "SOS"],
  "Attorney General": ["ATTORNEY", "AG"],
  "State Treasurer": ["TREASURER"],
  "Superintendent of Public Instruction": ["SUPERINTENDENT", "SCHOOLS", "EDUCATION"],
};
const ALL_OFFICE_WORDS = new Set([
  ...Object.values(STATEWIDE_OFFICE_WORDS).flat(),
  "SENATE", "SENATOR", "HOUSE", "REPRESENTATIVE", "REP", "LEGISLATURE", "LD", "DISTRICT",
  "MAYOR", "COUNCIL", "SUPERVISOR", "SHERIFF", "JUDGE", "JUSTICE", "COURT", "SCHOOL", "BOARD",
  "ASSESSOR", "RECORDER", "CLERK", "CONGRESS", "SENATE", "US", "U", "S",
]);
const COMMITTEE_WRAPPER_WORDS = new Set([
  "THE", "OF", "FOR", "TO", "ELECT", "VOTE", "COMMITTEE", "FRIENDS", "CITIZENS", "PEOPLE",
  "AZ", "ARIZONA", "ARIZONANS", "CAMPAIGN", "INC", "AND", "A", "OUR", "NEW", "KEEP", "RE",
  "RE-ELECT", "REELECT", "TEAM", "STRONG", "FUTURE", "ALL", "ONE",
]);

// The surname as written (Spotlight gets the raw token) plus its key.
function candidateSurname(candidateName: string): { raw: string; key: string } | null {
  const tokens = candidateName
    .trim()
    .split(/\s+/)
    .filter((token) => token && !/^(jr|sr|ii|iii|iv)\.?$/i.test(token));
  const raw = tokens.length >= 2 ? tokens[tokens.length - 1]! : "";
  const key = normalizeTextKey(raw);
  return raw && key && !key.includes(" ") ? { raw, key } : null;
}

function committeeNameIsSurnameOnly(input: {
  committeeName: string;
  surname: string;
  officeCanonicalName: string;
}): boolean {
  const tokens = normalizeTextKey(input.committeeName).split(" ").filter(Boolean);
  const raceWords = new Set(STATEWIDE_OFFICE_WORDS[input.officeCanonicalName] ?? []);
  const nameTokens: string[] = [];
  for (const token of tokens) {
    if (COMMITTEE_WRAPPER_WORDS.has(token)) {
      continue;
    }
    if (ALL_OFFICE_WORDS.has(token)) {
      if (!raceWords.has(token)) {
        return false;
      }
      continue;
    }
    if (/^\d{4}$/.test(token)) {
      continue;
    }
    nameTokens.push(token);
  }
  return nameTokens.length === 1 && nameTokens[0] === input.surname;
}

function toResolverMatch(match: ArizonaSpotlightCandidateCommitteeMatch): ArizonaCandidateCommitteeMatch {
  return {
    committeeId: match.committeeId,
    committeeName: match.committeeName,
    confidence: "single_committee",
    source: "spotlight",
    sourceUrl: match.sourceUrl,
    matchedIncomeRowCount: match.rowCount,
    totalIncomeAmount: match.amount,
  };
}

export async function resolveArizonaCandidateCommittee(
  input: ArizonaCandidateCommitteeResolverInput,
  options: ArizonaSpotlightClientOptions = {},
  client: Partial<ArizonaCandidateCommitteeResolverClient> = {}
): Promise<ArizonaCandidateCommitteeResolution> {
  const candidateNameNormalized = normalizeTextKey(input.candidateName);
  const officeNameNormalized = normalizeTextKey(input.officeName);
  if (!candidateNameNormalized) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const office = normalizeArizonaFinanceOffice({
    officeScope: input.officeScope,
    officeName: input.officeName,
  });
  if (!office) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const resolverClient = { ...DEFAULT_CLIENT, ...client };
  const matches = (
    await resolverClient.searchCandidateCommittees(
      {
        candidateName: input.candidateName,
        officeName: office.officeCanonicalName,
        electionYear: input.electionYear,
        limit: input.limit,
      },
      options
    )
  ).map(toResolverMatch);

  if (matches.length === 0) {
    const surname = candidateSurname(input.candidateName);
    if (office.officeScope === "statewide" && surname) {
      const surnameMatches = (
        await resolverClient.searchCandidateCommittees(
          {
            candidateName: surname.raw,
            officeName: office.officeCanonicalName,
            electionYear: input.electionYear,
            limit: input.limit,
          },
          options
        )
      )
        .filter((match) =>
          committeeNameIsSurnameOnly({
            committeeName: match.committeeName,
            surname: surname.key,
            officeCanonicalName: office.officeCanonicalName,
          })
        )
        .map((match) => ({ ...toResolverMatch(match), confidence: "surname_committee" as const }));
      if (surnameMatches.length === 1) {
        return { status: "matched", ...surnameMatches[0]! };
      }
      if (surnameMatches.length > 1) {
        return {
          status: "ambiguous",
          reason: "multiple_matching_committees",
          candidateNameNormalized,
          officeNameNormalized,
          matches: surnameMatches,
        };
      }
    }
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized,
      officeNameNormalized,
      matches,
    };
  }
  return { status: "matched", ...matches[0]! };
}
