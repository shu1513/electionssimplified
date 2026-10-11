import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  searchVirginiaCandidateCommittees,
  type VirginiaCampaignFinanceClientOptions,
  type VirginiaCommitteeSearchResult,
  type VirginiaReportHeader,
} from "./virginiaCampaignFinanceClient.js";
import { isVirginiaFinanceEligibleOffice } from "./virginiaFinanceEligibleOffices.js";

export type VirginiaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  committeeResults: readonly VirginiaCommitteeSearchResult[];
  reportHeaders?: readonly VirginiaReportHeader[];
};

export type VirginiaCandidateCommitteeSearchInput = Omit<
  VirginiaCandidateCommitteeResolverInput,
  "committeeResults" | "reportHeaders"
> & {
  reportHeadersByCommitteeId?: ReadonlyMap<string, readonly VirginiaReportHeader[]>;
};

export type VirginiaCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  committeeCode: string | null;
  candidateName: string | null;
  confidence: "exact";
  source: "cfreports_search";
  sourceUrl: string | null;
  matchedReportHeaderCount: number;
};

export type VirginiaCandidateCommitteeResolution =
  | ({ status: "matched" } & VirginiaCandidateCommitteeMatch)
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
      matches: VirginiaCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  candidateName: string | null;
  sourceUrl: string | null;
  reportHeaders: VirginiaReportHeader[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Virginia candidate committee election year: ${value}`);
  }
  return value;
}

function normalizeTextKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|OF|FOR)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string | null | undefined): string {
  // A quoted nickname ('Nathaniel "Nate" Fritzen') is not a middle name; read
  // as one it contradicted the filed middle name ("Nathaniel Alexander
  // Fritzen") and vetoed the match.
  return normalizeTextKey((value ?? "").replace(/["\u201c\u201d][^"\u201c\u201d]*["\u201c\u201d]/g, " "))
    // cfreports prefixes candidate names with a title ("Ms Sonia Ruth Vasquez
    // Luna", "Mr Nathaniel Alexander Fritzen"); left in, it became the first
    // name and no candidate key ever matched.
    .replace(/^(MR|MRS|MS|MISS|DR)\s+/, "")
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeVirginiaCandidateNameKeys(value: string): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();

  function addName(raw: string): void {
    const normalized = normalizePersonName(raw);
    if (normalized) {
      keys.add(normalized);
    }
    const parts = normalized.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
    }
    const commaParts = raw
      .split(",")
      .map((part) => normalizePersonName(part))
      .filter(Boolean);
    if (commaParts.length >= 2) {
      const lastName = commaParts[0] ?? "";
      const firstNames = commaParts.slice(1).join(" ");
      addName(`${firstNames} ${lastName}`);
    }
  }

  addName(trimmed.replace(/\([^()]+\)/g, " "));
  for (const match of trimmed.matchAll(/\(([^()]+)\)/g)) {
    if (match[1]) {
      addName(match[1]);
    }
  }
  return keys;
}

function candidateNameNormalized(value: string): string {
  return [...normalizeVirginiaCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function candidateResultMatchesName(input: {
  result: VirginiaCommitteeSearchResult;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const values = [input.result.candidateName, input.result.committeeName].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  let keyMatched = false;
  for (const value of values) {
    for (const key of normalizeVirginiaCandidateNameKeys(value)) {
      if (input.candidateNameKeys.has(key)) {
        keyMatched = true;
        break;
      }
    }
    if (keyMatched) {
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, so committee candidate
  // "Smith, John B." would match candidate "John A. Smith" as an "exact"
  // committee whenever the office is eligible. A contradicting middle name
  // rejects the result.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: values,
    normalizePersonName,
  });
}

function virginiaOfficeNameFromReportOfficeSought(value: string | null | undefined): string | null {
  const normalized = normalizeTextKey(value);
  if (!normalized) {
    return null;
  }
  if (normalized === "GOVERNOR") {
    return "Governor";
  }
  if (normalized === "LIEUTENANT GOVERNOR" || normalized === "LT GOVERNOR") {
    return "Lieutenant Governor";
  }
  if (normalized === "ATTORNEY GENERAL") {
    return "Attorney General";
  }
  if (/\bSENATE\b/.test(normalized) || /\bSENATOR\b/.test(normalized)) {
    return "State Senator";
  }
  if (/\bHOUSE\b/.test(normalized) || /\bDELEGATE\b/.test(normalized)) {
    return "State Lower Chamber Legislator";
  }
  return null;
}

function reportHeaderMatchesInput(input: {
  header: VirginiaReportHeader;
  officeName: string;
  electionYear: number;
}): boolean {
  const reportOffice = virginiaOfficeNameFromReportOfficeSought(input.header.officeSought);
  if (reportOffice !== input.officeName.trim()) {
    return false;
  }
  const electionCycleYear = input.header.electionCycle?.match(/\b(\d{4})\b/g)?.at(-1);
  if (electionCycleYear && Number.parseInt(electionCycleYear, 10) !== input.electionYear) {
    return false;
  }
  return true;
}

function toCommitteeCode(reportHeaders: readonly VirginiaReportHeader[]): string | null {
  for (const header of reportHeaders) {
    const code = header.committeeCode?.trim();
    if (code) {
      return code;
    }
  }
  return null;
}

function toCommitteeMatch(accumulator: CandidateCommitteeAccumulator): VirginiaCandidateCommitteeMatch {
  return {
    committeeId: accumulator.committeeId,
    committeeName: accumulator.committeeName,
    committeeCode: toCommitteeCode(accumulator.reportHeaders),
    candidateName: accumulator.candidateName,
    confidence: "exact",
    source: "cfreports_search",
    sourceUrl: accumulator.sourceUrl,
    matchedReportHeaderCount: accumulator.reportHeaders.length,
  };
}

export function resolveVirginiaCandidateCommittee(
  input: VirginiaCandidateCommitteeResolverInput
): VirginiaCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = normalizeVirginiaCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeNameNormalized = input.officeName.trim() || normalizeTextKey(input.officeName);

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (!isVirginiaFinanceEligibleOffice({ officeScope: input.officeScope, officeCanonicalName: input.officeName })) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const matches = new Map<string, CandidateCommitteeAccumulator>();
  for (const result of input.committeeResults) {
    const committeeId = result.committeeId.trim();
    const committeeName = result.committeeName.trim();
    if (!committeeId || !committeeName) {
      continue;
    }
    if (normalizeTextKey(result.committeeType) !== "CANDIDATE CAMPAIGN COMMITTEE") {
      continue;
    }
    if (!candidateResultMatchesName({ result, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }

    const reportHeaders = (input.reportHeaders ?? []).filter(
      (header) =>
        (!header.committeeName || normalizeTextKey(header.committeeName) === normalizeTextKey(result.committeeName)) &&
        reportHeaderMatchesInput({ header, officeName: input.officeName, electionYear })
    );
    if (input.reportHeaders && reportHeaders.length === 0) {
      continue;
    }

    matches.set(committeeId, {
      committeeId,
      committeeName,
      candidateName: result.candidateName,
      sourceUrl: result.sourceUrl,
      reportHeaders,
    });
  }

  if (matches.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const committeeMatches = [...matches.values()]
    .map(toCommitteeMatch)
    .sort((left, right) => left.committeeId.localeCompare(right.committeeId));

  if (committeeMatches.length === 1 && committeeMatches[0]) {
    return {
      status: "matched",
      ...committeeMatches[0],
    };
  }

  return {
    status: "ambiguous",
    reason: "multiple_matching_committees",
    candidateNameNormalized: candidateNameKey,
    officeNameNormalized,
    matches: committeeMatches,
  };
}

// cfreports matches the search text as one substring, so "Nathaniel Fritzen"
// finds nothing when the filing reads "Nathaniel Alexander Fritzen". Search
// the full name first and the surname second. The resolver still requires a
// first+last name match.
export function virginiaCandidateCommitteeSearchQueries(candidateName: string): string[] {
  const queries = [candidateName];
  const surname = normalizePersonName(candidateName).split(" ").filter(Boolean).at(-1);
  if (surname && surname !== normalizePersonName(candidateName)) {
    queries.push(surname);
  }
  return queries;
}

// Runs the search queries in order and resolves each result set; the next
// query runs only while the previous one resolved no committee. A full-name
// hit that the resolver rejects (another committee type, another office's
// filings) therefore still gets the surname retry, while a match or an
// ambiguity on the full name is final.
export async function resolveVirginiaCandidateCommitteeAcrossSearches(input: {
  candidateName: string;
  search: (query: string) => Promise<readonly VirginiaCommitteeSearchResult[]>;
  resolve: (
    committeeResults: readonly VirginiaCommitteeSearchResult[]
  ) => Promise<VirginiaCandidateCommitteeResolution> | VirginiaCandidateCommitteeResolution;
}): Promise<VirginiaCandidateCommitteeResolution> {
  const queries = virginiaCandidateCommitteeSearchQueries(input.candidateName);
  let resolution = await input.resolve(await input.search(queries[0] ?? input.candidateName));
  for (const query of queries.slice(1)) {
    if (resolution.status !== "unmatched" || resolution.reason !== "no_candidate_committee_match") {
      break;
    }
    resolution = await input.resolve(await input.search(query));
  }
  return resolution;
}

export async function searchAndResolveVirginiaCandidateCommittee(
  input: VirginiaCandidateCommitteeSearchInput,
  options: VirginiaCampaignFinanceClientOptions = {}
): Promise<VirginiaCandidateCommitteeResolution> {
  if (!isVirginiaFinanceEligibleOffice({ officeScope: input.officeScope, officeCanonicalName: input.officeName })) {
    return resolveVirginiaCandidateCommittee({ ...input, committeeResults: [], reportHeaders: [] });
  }

  return resolveVirginiaCandidateCommitteeAcrossSearches({
    candidateName: input.candidateName,
    search: (query) => searchVirginiaCandidateCommittees({ committeeName: query }, options),
    resolve: (committeeResults) => {
      const reportHeaders = committeeResults.flatMap(
        (result) => input.reportHeadersByCommitteeId?.get(result.committeeId) ?? []
      );
      return resolveVirginiaCandidateCommittee({
        ...input,
        committeeResults,
        ...(reportHeaders.length > 0 ? { reportHeaders } : {}),
      });
    },
  });
}
