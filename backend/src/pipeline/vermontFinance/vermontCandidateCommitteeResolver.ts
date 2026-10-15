import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  getVermontContributionDetails,
  getVermontExpenditureDetails,
  type VermontCampaignFinanceClientOptions,
  type VermontContributionRow,
  type VermontExpenditureRow,
} from "./vermontCampaignFinanceClient.js";
import { fetchAllVermontTransactionRows as fetchAllCandidateSearchRows } from "./vermontTransactionPaging.js";
import { mapVermontOfficeSought, toVermontOfficeSearchInput } from "./vermontFinanceEligibleOffices.js";

export type VermontCandidateCommitteeTransactionRow = {
  transactionId?: number | null;
  guid?: string | null;
  filerRegistrationGuid: string;
  filerName: string;
  filerTypeCode: string | null;
  filerTypeDescription: string | null;
  electionYear: number | null;
  electionId: number | null;
  officeId: number | null;
  officeType?: string | null;
  entityId: number | null;
  reportName: string | null;
  candidateFirstName: string | null;
  candidateMiddleName: string | null;
  candidateLastName: string | null;
};

export type VermontCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  district?: string | null;
  electionYear: number;
  transactionRows: readonly VermontCandidateCommitteeTransactionRow[];
};

export type VermontCandidateCommitteeSearchInput = Omit<
  VermontCandidateCommitteeResolverInput,
  "transactionRows"
>;

export type VermontCandidateCommitteeMatch = {
  filerRegistrationGuid: string;
  filerName: string;
  candidateName: string | null;
  officeId: number;
  officeName: string;
  officeDisplayName: string;
  electionYear: number;
  electionId: number | null;
  entityId: number | null;
  reportName: string | null;
  confidence: "exact";
  source: "vermont_public_transactions";
  sourceUrl: string;
  matchedTransactionRowCount: number;
};

export type VermontCandidateCommitteeResolution =
  | ({ status: "matched" } & VermontCandidateCommitteeMatch)
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
      matches: VermontCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  filerRegistrationGuid: string;
  filerName: string;
  candidateName: string | null;
  officeId: number;
  officeName: string;
  officeDisplayName: string;
  electionYear: number;
  electionId: number | null;
  entityId: number | null;
  reportName: string | null;
  rows: VermontCandidateCommitteeTransactionRow[];
};

const VERMONT_CAMPAIGN_FINANCE_SOURCE_URL = "https://campaignfinance.vermont.gov/";
const VERMONT_CANDIDATE_COMMITTEE_SEARCH_PAGE_SIZE = 1_000;

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Vermont candidate committee election year: ${value}`);
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
    .replace(/\b(THE|OF|FOR|COMMITTEE|FRIENDS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string | null | undefined): string {
  return normalizeTextKey(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Shared with vermontOutsideSpendingAggregator so its middle-name gate uses the
// same normalizer as normalizeVermontCandidateNameKeys.
export { normalizePersonName as normalizeVermontPersonName };

export function normalizeVermontCandidateNameKeys(value: string): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();

  function addName(raw: string): void {
    const hasComma = raw.includes(",");
    const normalized = normalizePersonName(raw);
    if (normalized) {
      keys.add(normalized);
    }

    const parts = normalized.split(" ").filter(Boolean);
    if (!hasComma && parts.length >= 2) {
      keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
    }

    const commaParts = raw
      .split(",")
      .map((part) => normalizePersonName(part))
      .filter(Boolean);
    if (commaParts.length >= 2) {
      const lastName = commaParts[0] ?? "";
      const firstNames = commaParts.slice(1).join(" ").trim();
      const flipped = normalizePersonName(`${firstNames} ${lastName}`);
      if (flipped) {
        keys.add(flipped);
        const flippedParts = flipped.split(" ").filter(Boolean);
        if (flippedParts.length >= 2) {
          keys.add(`${flippedParts[0]} ${flippedParts[flippedParts.length - 1]}`);
        }
      }
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

export function buildVermontCandidateSearchPhrases(candidateName: string): string[] {
  const trimmed = candidateName.trim();
  if (!trimmed) {
    return [];
  }

  const phrases = new Set<string>([trimmed]);
  const normalized = normalizePersonName(trimmed);
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    if (lastName) {
      phrases.add(lastName);
    }
    if (firstName && lastName) {
      phrases.add(`${lastName}, ${firstName}`);
    }
  }

  return [...phrases];
}

function candidateNameNormalized(value: string): string {
  return [...normalizeVermontCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function candidateFullName(row: VermontCandidateCommitteeTransactionRow): string | null {
  const name = [row.candidateFirstName, row.candidateMiddleName, row.candidateLastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return name || null;
}

function rowMatchesCandidateName(input: {
  row: VermontCandidateCommitteeTransactionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const names = [candidateFullName(input.row), input.row.filerName].filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0
  );
  let keyMatched = false;
  for (const name of names) {
    for (const key of normalizeVermontCandidateNameKeys(name)) {
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
  // Key overlap collapses names to first+last, so a row carrying
  // candidateMiddleName "B" would match candidate "John A. Smith" as an
  // "exact" filer whenever office and election year agree. A contradicting
  // middle name rejects the row.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: names,
    normalizePersonName,
  });
}

function isCandidateFiler(row: VermontCandidateCommitteeTransactionRow): boolean {
  const filerType = normalizeTextKey(`${row.filerTypeCode ?? ""} ${row.filerTypeDescription ?? ""}`);
  return /\b(CAN|CANDIDATE)\b/.test(filerType);
}

function toCommitteeMatch(accumulator: CandidateCommitteeAccumulator): VermontCandidateCommitteeMatch {
  return {
    filerRegistrationGuid: accumulator.filerRegistrationGuid,
    filerName: accumulator.filerName,
    candidateName: accumulator.candidateName,
    officeId: accumulator.officeId,
    officeName: accumulator.officeName,
    officeDisplayName: accumulator.officeDisplayName,
    electionYear: accumulator.electionYear,
    electionId: accumulator.electionId,
    entityId: accumulator.entityId,
    reportName: accumulator.reportName,
    confidence: "exact",
    source: "vermont_public_transactions",
    sourceUrl: VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
    matchedTransactionRowCount: accumulator.rows.length,
  };
}

function dominantCommitteeMatch(
  matches: readonly VermontCandidateCommitteeMatch[]
): VermontCandidateCommitteeMatch | null {
  const sorted = [...matches].sort(
    (left, right) => right.matchedTransactionRowCount - left.matchedTransactionRowCount
  );
  const first = sorted[0];
  const second = sorted[1];
  if (!first || !second) {
    return first ?? null;
  }
  const totalRows = sorted.reduce((sum, match) => sum + match.matchedTransactionRowCount, 0);
  const hasEnoughEvidence = first.matchedTransactionRowCount >= 25;
  const isDominantShare = first.matchedTransactionRowCount / totalRows >= 0.9;
  const isDominantRatio = first.matchedTransactionRowCount >= second.matchedTransactionRowCount * 10;
  return hasEnoughEvidence && isDominantShare && isDominantRatio ? first : null;
}

export function resolveVermontCandidateCommittee(
  input: VermontCandidateCommitteeResolverInput
): VermontCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = normalizeVermontCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeSearchInput = toVermontOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
  });
  const officeNameNormalized = officeSearchInput?.officeName ?? normalizeTextKey(input.officeName);

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (!officeSearchInput) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const rowsByFilerRegistrationGuid = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.transactionRows) {
    const filerRegistrationGuid = row.filerRegistrationGuid.trim();
    const filerName = row.filerName.trim();
    if (!filerRegistrationGuid || !filerName) {
      continue;
    }
    if (!isCandidateFiler(row)) {
      continue;
    }
    if (row.electionYear !== electionYear) {
      continue;
    }

    const mappedOffice = mapVermontOfficeSought({ officeId: row.officeId });
    if (!mappedOffice || mappedOffice.officeId !== officeSearchInput.officeId) {
      continue;
    }
    if (!rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }

    const accumulator = rowsByFilerRegistrationGuid.get(filerRegistrationGuid) ?? {
      filerRegistrationGuid,
      filerName,
      candidateName: candidateFullName(row),
      officeId: mappedOffice.officeId,
      officeName: mappedOffice.officeCanonicalName,
      officeDisplayName: mappedOffice.officeName,
      electionYear,
      electionId: row.electionId,
      entityId: row.entityId,
      reportName: row.reportName,
      rows: [],
    };
    accumulator.rows.push(row);
    rowsByFilerRegistrationGuid.set(filerRegistrationGuid, accumulator);
  }

  if (rowsByFilerRegistrationGuid.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const matches = [...rowsByFilerRegistrationGuid.values()]
    .map(toCommitteeMatch)
    .sort((left, right) => left.filerRegistrationGuid.localeCompare(right.filerRegistrationGuid));

  if (matches.length === 1) {
    return {
      status: "matched",
      ...matches[0],
    };
  }
  const dominantMatch = dominantCommitteeMatch(matches);
  if (dominantMatch) {
    return {
      status: "matched",
      ...dominantMatch,
    };
  }

  return {
    status: "ambiguous",
    reason: "multiple_matching_committees",
    candidateNameNormalized: candidateNameKey,
    officeNameNormalized,
    matches,
  };
}

function appendUniqueRows(
  rowsByGuid: Map<string, VermontCandidateCommitteeTransactionRow>,
  rows: readonly (VermontContributionRow | VermontExpenditureRow)[]
): void {
  for (const row of rows) {
    const key = row.guid || `${row.transactionId}:${row.filerRegistrationGuid}`;
    if (!rowsByGuid.has(key)) {
      rowsByGuid.set(key, row);
    }
  }
}

export async function searchAndResolveVermontCandidateCommittee(
  input: VermontCandidateCommitteeSearchInput,
  options: VermontCampaignFinanceClientOptions = {}
): Promise<VermontCandidateCommitteeResolution> {
  const officeSearchInput = toVermontOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
  });
  if (!officeSearchInput) {
    return resolveVermontCandidateCommittee({ ...input, transactionRows: [] });
  }

  const candidateSearchPhrases = buildVermontCandidateSearchPhrases(input.candidateName);
  if (candidateSearchPhrases.length === 0) {
    return resolveVermontCandidateCommittee({ ...input, transactionRows: [] });
  }

  const rowsByGuid = new Map<string, VermontCandidateCommitteeTransactionRow>();
  for (const filerName of candidateSearchPhrases) {
    const [contributions, expenditures] = await Promise.all([
      fetchAllCandidateSearchRows({
        pageSize: VERMONT_CANDIDATE_COMMITTEE_SEARCH_PAGE_SIZE,
        fetchPage: (pageNumber) =>
          getVermontContributionDetails(
            {
              pageNumber,
              pageSize: VERMONT_CANDIDATE_COMMITTEE_SEARCH_PAGE_SIZE,
              filerName,
              electionYear: input.electionYear,
              transactionTypeCode: "TCON",
            },
            options
          ),
      }),
      fetchAllCandidateSearchRows({
        pageSize: VERMONT_CANDIDATE_COMMITTEE_SEARCH_PAGE_SIZE,
        fetchPage: (pageNumber) =>
          getVermontExpenditureDetails(
            {
              pageNumber,
              pageSize: VERMONT_CANDIDATE_COMMITTEE_SEARCH_PAGE_SIZE,
              filerName,
              electionYear: input.electionYear,
              transactionTypeCode: "TEXP",
            },
            options
          ),
      }),
    ]);
    appendUniqueRows(rowsByGuid, contributions);
    appendUniqueRows(rowsByGuid, expenditures);
  }

  return resolveVermontCandidateCommittee({ ...input, transactionRows: [...rowsByGuid.values()] });
}
