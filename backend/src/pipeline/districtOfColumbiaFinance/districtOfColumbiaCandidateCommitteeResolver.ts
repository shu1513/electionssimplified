import {
  committeeNameMiddleEvidenceRowNames,
  hasMiddleNameConflict,
} from "../finance/personNameMiddleEvidence.js";
import {
  DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES,
  buildDistrictOfColumbiaOcfDataDownloadUrl,
  fetchDistrictOfColumbiaOcfContributionRecords,
  type DistrictOfColumbiaOcfClientOptions,
  type DistrictOfColumbiaOcfContributionRecord,
} from "./districtOfColumbiaOcfClient.js";
import {
  normalizeDistrictOfColumbiaOcfSeat,
  mapDistrictOfColumbiaOcfOffice,
  toDistrictOfColumbiaOcfOfficeSearchInput,
} from "./districtOfColumbiaFinanceEligibleOffices.js";

export type DistrictOfColumbiaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  seat?: string | null;
  contributionRecords: readonly DistrictOfColumbiaOcfContributionRecord[];
  sourceUrl?: string | null;
};

export type DistrictOfColumbiaCandidateCommitteeSearchInput = Omit<
  DistrictOfColumbiaCandidateCommitteeResolverInput,
  "contributionRecords" | "sourceUrl"
>;

export type DistrictOfColumbiaCandidateCommitteeMatch = {
  committeeKey: string;
  committeeName: string;
  confidence: "exact";
  source: "ocf_export";
  sourceUrl: string | null;
  matchedContributionRowCount: number;
};

export type DistrictOfColumbiaCandidateCommitteeResolution =
  | ({ status: "matched" } & DistrictOfColumbiaCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_seat"
        | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: DistrictOfColumbiaCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeKey: string;
  committeeName: string;
  rows: DistrictOfColumbiaOcfContributionRecord[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid D.C. candidate committee election year: ${value}`);
  }
  return value;
}

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|OF|FOR|TO|ELECT|COMMITTEE|FRIENDS|CITIZENS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string): string {
  return normalizeTextKey(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDistrictOfColumbiaCandidateNameKeys(value: string): Set<string> {
  const trimmed = value.trim();
  const normalized = normalizePersonName(trimmed);
  const keys = new Set<string>();
  if (normalized) {
    keys.add(normalized);
  }

  const commaParts = trimmed
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
    return keys;
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
  }
  return keys;
}

function candidateNameNormalized(value: string): string {
  return [...normalizeDistrictOfColumbiaCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function recordNameMatchesCandidate(input: {
  record: DistrictOfColumbiaOcfContributionRecord;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const recordCandidateName = input.record.candidateName;
  if (recordCandidateName) {
    for (const key of normalizeDistrictOfColumbiaCandidateNameKeys(recordCandidateName)) {
      if (input.candidateNameKeys.has(key)) {
        // Key overlap collapses names to first+last, which would link
        // "John A. Smith" to a row naming "John B. Smith" as an "exact" match
        // whenever the office and cycle agree. A contradicting middle name
        // rejects the row (georgia pattern).
        return !hasMiddleNameConflict({
          candidateName: input.candidateName,
          rowNames: [recordCandidateName],
          normalizePersonName,
        });
      }
    }
    return false;
  }

  const committeeNameKey = normalizeTextKey(input.record.committeeName ?? "");
  if (!committeeNameKey) {
    return false;
  }
  for (const key of input.candidateNameKeys) {
    const tokens = key.split(" ").filter(Boolean);
    if (tokens.length >= 2 && tokens.every((token) => committeeNameKey.split(" ").includes(token))) {
      // The token-containment test accepts "Committee to Elect John B. Smith"
      // for candidate "John A. Smith" — another Smith's committee.
      // normalizePersonName strips the committee wrappers (TO/ELECT/...), so
      // the remaining text parses as a person name and the middle gate
      // applies here too. The expansion also evaluates year-stripped and
      // "for"-delimited segments, so trailing office/year text cannot hide
      // the contradicting middle by blocking surname alignment.
      return !hasMiddleNameConflict({
        candidateName: input.candidateName,
        rowNames: committeeNameMiddleEvidenceRowNames(input.record.committeeName ?? ""),
        normalizePersonName,
      });
    }
  }
  return false;
}

function parseYearFromDate(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  const slashMatch = /^\d{1,2}\/\d{1,2}\/(\d{4})\b/.exec(trimmed);
  if (slashMatch?.[1]) {
    return Number.parseInt(slashMatch[1], 10);
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  return isoMatch?.[1] ? Number.parseInt(isoMatch[1], 10) : null;
}

function recordMatchesElectionCycle(record: DistrictOfColumbiaOcfContributionRecord, electionYear: number): boolean {
  if (record.electionYear !== undefined) {
    return record.electionYear === electionYear;
  }
  const dateYear = parseYearFromDate(record.date);
  return dateYear !== null && dateYear >= electionYear - 1 && dateYear <= electionYear;
}

function recordMatchesOffice(input: {
  record: DistrictOfColumbiaOcfContributionRecord;
  expectedOcfOffice: string;
  expectedSeat: string | null;
}): boolean {
  if (input.record.office) {
    const mappedOffice = mapDistrictOfColumbiaOcfOffice({
      office: input.record.office,
      seat: input.record.seat,
    });
    if (!mappedOffice || mappedOffice.ocfOffice !== input.expectedOcfOffice) {
      return false;
    }
    if (input.expectedSeat !== null) {
      return mappedOffice.seat === input.expectedSeat;
    }
    return true;
  }

  if (input.expectedSeat === null) {
    return true;
  }

  const rowSeat = normalizeDistrictOfColumbiaOcfSeat(input.record.seat);
  if (rowSeat === input.expectedSeat) {
    return true;
  }

  // The committee name often carries the seat ("Doe for Ward 7", "Doe At
  // Large"). The seat normalizer reads every spelling the seat column would
  // ("Ward 07", "AtLarge", "citywide"), so read the name with it rather than
  // a second regex that drifts from it.
  const nameSeat = normalizeDistrictOfColumbiaOcfSeat(normalizeTextKey(input.record.committeeName ?? ""));
  if (nameSeat === input.expectedSeat) {
    return true;
  }

  // OCF's contribution export carries no office or seat, and a ward
  // committee's name often omits the ward (live: "Committee to Re - Elect
  // Zachary Parker 2026", Ward 5, 612 rows). A row that names the candidate
  // and says nothing about any seat cannot contradict the ward, so accept it;
  // the name and cycle checks still apply. A row that names some other seat
  // stays out.
  return rowSeat === null && nameSeat === null && Boolean(input.record.candidateName?.trim());
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): DistrictOfColumbiaCandidateCommitteeMatch {
  return {
    committeeKey: input.accumulator.committeeKey,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "ocf_export",
    sourceUrl: input.sourceUrl,
    matchedContributionRowCount: input.accumulator.rows.length,
  };
}

function isSeatRequiredInput(input: {
  officeScope: string;
  officeName: string;
}): boolean {
  return (
    (input.officeScope === "place" || input.officeScope === "state_upper") &&
    input.officeName.trim() === "City Council Member"
  );
}

export function resolveDistrictOfColumbiaCandidateCommittee(
  input: DistrictOfColumbiaCandidateCommitteeResolverInput
): DistrictOfColumbiaCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = normalizeDistrictOfColumbiaCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeSearchInput = toDistrictOfColumbiaOcfOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    seat: input.seat,
  });
  const officeNameNormalized = officeSearchInput?.ocfOffice ?? normalizeTextKey(input.officeName);

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
      reason:
        isSeatRequiredInput(input) && normalizeDistrictOfColumbiaOcfSeat(input.seat) === null
          ? "missing_seat"
          : "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const record of input.contributionRecords) {
    const committeeName = record.committeeName?.trim();
    const committeeKey = record.committeeKey?.trim() || (committeeName ? normalizeTextKey(committeeName) : "");
    if (!committeeName || !committeeKey) {
      continue;
    }
    if (!recordMatchesElectionCycle(record, electionYear)) {
      continue;
    }
    if (
      !recordMatchesOffice({
        record,
        expectedOcfOffice: officeSearchInput.ocfOffice,
        expectedSeat: officeSearchInput.seat,
      })
    ) {
      continue;
    }
    if (!recordNameMatchesCandidate({ record, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }

    const accumulator = rowsByCommittee.get(committeeKey) ?? {
      committeeKey,
      committeeName,
      rows: [],
    };
    accumulator.rows.push(record);
    rowsByCommittee.set(committeeKey, accumulator);
  }

  if (rowsByCommittee.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const matches = [...rowsByCommittee.values()]
    .map((accumulator) => toCommitteeMatch({ accumulator, sourceUrl: input.sourceUrl ?? null }))
    .sort((left, right) => left.committeeKey.localeCompare(right.committeeKey));

  if (matches.length === 1) {
    return {
      status: "matched",
      ...matches[0],
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

function cycleStartDate(electionYear: number): string {
  return `01/01/${electionYear - 1}`;
}

function cycleEndDate(electionYear: number): string {
  return `12/31/${electionYear}`;
}

export async function searchAndResolveDistrictOfColumbiaCandidateCommittee(
  input: DistrictOfColumbiaCandidateCommitteeSearchInput,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaCandidateCommitteeResolution> {
  const officeSearchInput = toDistrictOfColumbiaOcfOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    seat: input.seat,
  });
  if (!officeSearchInput) {
    return resolveDistrictOfColumbiaCandidateCommittee({ ...input, contributionRecords: [] });
  }

  const contributionRecords = await fetchDistrictOfColumbiaOcfContributionRecords(
    {
      filerTypeId: DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES.principalCampaignCommittee,
      fromDate: cycleStartDate(input.electionYear),
      toDate: cycleEndDate(input.electionYear),
    },
    options
  );
  return resolveDistrictOfColumbiaCandidateCommittee({
    ...input,
    contributionRecords,
    sourceUrl: buildDistrictOfColumbiaOcfDataDownloadUrl(),
  });
}
