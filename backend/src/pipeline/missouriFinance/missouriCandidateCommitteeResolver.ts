import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import {
  normalizeMissouriMecJurisdiction,
  normalizeMissouriMecPoliticalDistrict,
  normalizeMissouriMecText,
  toMissouriMecOfficeSearchInput,
} from "./missouriFinanceEligibleOffices.js";
import {
  normalizeMissouriMecElectionDate,
  parseMissouriMecCandidateExportWithDiagnostics,
  parseMissouriMecCommitteeInfo,
  parseMissouriMecSelectOptions,
  type MissouriMecSelectOption,
  MissouriMecCandidateExportRow,
  MissouriMecCommitteeInfo,
} from "./missouriMecParsers.js";
import {
  buildMissouriMecUrl,
  createMissouriMecSession,
  MISSOURI_MEC_PAGES,
  MISSOURI_MEC_SEARCH_FIELD_PREFIX,
  MissouriMecClientError,
  parseMissouriMecHiddenFields,
  type MissouriMecResponse,
  type MissouriMecSessionOptions,
} from "./missouriMecClient.js";

export type MissouriMecCandidateCommitteeRecord = MissouriMecCandidateExportRow & {
  searchElectionDate: string;
  searchPoliticalOffice: string;
  searchPoliticalSubdivision: string | null;
  searchPoliticalDistrict: string | null;
  committeeInfo: MissouriMecCommitteeInfo;
};

export type MissouriCandidateCommitteeResolverInput = {
  candidateName: string;
  electionDate: string;
  officeScope: string;
  officeName: string;
  ballotTitle: string;
  districtName: string | null;
  legislativeDistrict?: string | null;
  records: readonly MissouriMecCandidateCommitteeRecord[];
};

export type MissouriCandidateCommitteeSearchInput = Omit<MissouriCandidateCommitteeResolverInput, "records">;

export type MissouriCandidateCommitteeMatch = {
  mecid: string;
  committeeName: string;
  candidateName: string;
  officeSought: string;
  confidence: "election_history_exact";
  source: "mec_portal";
  sourceUrl: string;
  matchedCandidateRowCount: number;
};

export type MissouriCandidateCommitteeResolution =
  | ({ status: "matched" } & MissouriCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_legislative_district"
        | "missing_jurisdiction"
        | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: MissouriCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  mecid: string;
  committeeName: string;
  candidateName: string;
  officeSought: string;
  sourceUrl: string;
  rows: MissouriMecCandidateCommitteeRecord[];
};

function normalizePersonName(value: string): string {
  return normalizeMissouriMecText(value)
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMissouriCandidateNameForStorage(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const commaParts = trimmed
    .split(",")
    .map((part) => normalizePersonName(part))
    .filter(Boolean);
  if (commaParts.length >= 2) {
    return normalizePersonName(`${commaParts.slice(1).join(" ")} ${commaParts[0]}`);
  }
  return normalizePersonName(trimmed.replace(/\([^()]+\)/g, " "));
}

function normalizeIsoElectionDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid Missouri candidate election date: ${value}`);
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid Missouri candidate election date: ${value}`);
  }
  return value.trim();
}

function toMecElectionDate(value: string): string {
  const iso = normalizeIsoElectionDate(value);
  const [year, month, day] = iso.split("-");
  return `${Number.parseInt(month!, 10)}/${Number.parseInt(day!, 10)}/${year}`;
}

function requirePage(response: MissouriMecResponse, label: string): string {
  if (response.status !== 200 || response.redirectLocation !== null) {
    throw new MissouriMecClientError(
      "bad_response",
      `Missouri MEC ${label} returned status ${response.status} redirect ${response.redirectLocation ?? "none"}`,
      response.status
    );
  }
  return response.text();
}

function selectExactOption(
  options: readonly MissouriMecSelectOption[],
  expected: string,
  normalize: (value: string) => string | null
): MissouriMecSelectOption | null {
  const expectedKey = normalize(expected);
  if (expectedKey === null || expectedKey === "") {
    return null;
  }
  const matches = options.filter((option) => {
    if (!option.value || option.value === "0") {
      return false;
    }
    return normalize(option.label) === expectedKey || normalize(option.value) === expectedKey;
  });
  return matches.length === 1 ? matches[0]! : null;
}

// MEC Committee Info carries the formal first name ("Raymond E Bruno") while
// VoteApp stores the campaign name ("Ray Bruno"). The equivalence is
// one-sided: the VoteApp first name expands to its nickname variants, the
// MEC name is read literally (personFirstNameNicknames.ts).
function nicknameFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

function namesMatch(candidateName: string, sourceName: string, expandNicknames = false): boolean {
  // MEC publishes public-name aliases in quotes (Michael 'Mike' A Seabaugh).
  // The shared name matcher understands parenthetical aliases and preserves
  // their outer middle/surname evidence, so translate only balanced quoted
  // alphabetic aliases into that equivalent shape. This is explicit source
  // evidence, not a nickname dictionary or fuzzy expansion.
  const normalizeQuotedAlias = (value: string) =>
    value.replace(
      /(^|\s)(['"])([A-Za-z][A-Za-z .-]{1,40})\2(?=\s|$)/g,
      (_match, prefix: string, _quote: string, alias: string) => `${prefix}(${alias})`
    );
  return personNamesMatchWithMiddleEvidence({
    candidateName: normalizeQuotedAlias(candidateName),
    rowNames: [normalizeQuotedAlias(sourceName)],
    normalizePersonName,
    firstNamesEquivalent: expandNicknames ? nicknameFirstNamesEquivalent : undefined,
  });
}

function isKnownCandidateCommitteeStatus(status: string): boolean {
  const normalized = normalizeMissouriMecText(status);
  return normalized === "A" || normalized === "ACTIVE" || normalized === "T" || normalized === "TERMINATED";
}

function sourceOfficeMatches(value: string, expectedOffice: string): boolean {
  const source = normalizeMissouriMecText(value);
  const expected = normalizeMissouriMecText(expectedOffice);
  return source === expected || source.startsWith(`${expected} `);
}

function historyMatches(input: {
  info: MissouriMecCommitteeInfo;
  electionDate: string;
  politicalOffice: string;
  expectedHistorySubdivision: string | null;
  expectedJurisdiction: string | null;
}): boolean {
  return input.info.electionHistory.some((row) => {
    if (row.electionDate !== input.electionDate || !sourceOfficeMatches(row.office, input.politicalOffice)) {
      return false;
    }
    const rowSubdivision = normalizeMissouriMecJurisdiction(row.politicalSubdivision);
    if (input.expectedHistorySubdivision !== null) {
      return rowSubdivision === normalizeMissouriMecJurisdiction(input.expectedHistorySubdivision);
    }
    if (input.expectedJurisdiction !== null) {
      return rowSubdivision === input.expectedJurisdiction;
    }
    return true;
  });
}

function toCommitteeMatch(accumulator: CandidateCommitteeAccumulator): MissouriCandidateCommitteeMatch {
  return {
    mecid: accumulator.mecid,
    committeeName: accumulator.committeeName,
    candidateName: accumulator.candidateName,
    officeSought: accumulator.officeSought,
    confidence: "election_history_exact",
    source: "mec_portal",
    sourceUrl: accumulator.sourceUrl,
    matchedCandidateRowCount: accumulator.rows.length,
  };
}

// Literal names first; nickname equivalence only when nothing matches
// literally, so a race with both a "Jim" and a "James" committee keeps the
// literal one instead of turning ambiguous.
export function resolveMissouriCandidateCommittee(
  input: MissouriCandidateCommitteeResolverInput
): MissouriCandidateCommitteeResolution {
  const literal = resolveMissouriCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveMissouriCandidateCommitteeByName(input, true);
}

function resolveMissouriCandidateCommitteeByName(
  input: MissouriCandidateCommitteeResolverInput,
  expandNicknames: boolean
): MissouriCandidateCommitteeResolution {
  const electionDate = normalizeIsoElectionDate(input.electionDate);
  const candidateNameNormalized = normalizeMissouriCandidateNameForStorage(input.candidateName);
  const officeSearch = toMissouriMecOfficeSearchInput({
    officeScope: input.officeScope,
    officeName: input.officeName,
    ballotTitle: input.ballotTitle,
    legislativeDistrict: input.legislativeDistrict,
  });
  const officeNameNormalized = officeSearch?.politicalOffice ?? normalizeMissouriMecText(input.officeName);

  if (!candidateNameNormalized) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (officeSearch === null) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  const isLegislative = input.officeScope === "state_upper" || input.officeScope === "state_lower";
  if (isLegislative && officeSearch.politicalDistrict === null) {
    return {
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const expectedJurisdiction = officeSearch.requiresSubdivision
    ? normalizeMissouriMecJurisdiction(input.districtName)
    : null;
  if (officeSearch.requiresSubdivision && expectedJurisdiction === null) {
    return {
      status: "unmatched",
      reason: "missing_jurisdiction",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const matches = new Map<string, CandidateCommitteeAccumulator>();
  for (const record of input.records) {
    if (!isKnownCandidateCommitteeStatus(record.status)) {
      continue;
    }
    if (record.searchElectionDate !== electionDate) {
      continue;
    }
    if (normalizeMissouriMecText(record.searchPoliticalOffice) !== normalizeMissouriMecText(officeSearch.politicalOffice)) {
      continue;
    }
    if (
      expectedJurisdiction !== null &&
      normalizeMissouriMecJurisdiction(record.searchPoliticalSubdivision) !== expectedJurisdiction
    ) {
      continue;
    }
    if (officeSearch.politicalDistrict !== null) {
      const searchedDistrict = normalizeMissouriMecPoliticalDistrict(record.searchPoliticalDistrict);
      // MEC does not expose a Political District control for every local
      // office (verified Alderperson Ward 3, City of Jackson). In that shape
      // the export's Office Sought still carries the ward and is required
      // below. Legislative searches always expose and must select a district.
      if ((isLegislative || searchedDistrict !== null) && searchedDistrict !== officeSearch.politicalDistrict) {
        continue;
      }
    }
    if (!sourceOfficeMatches(record.officeSought, officeSearch.politicalOffice)) {
      continue;
    }
    if (
      officeSearch.politicalDistrict !== null &&
      normalizeMissouriMecPoliticalDistrict(record.officeSought) !== officeSearch.politicalDistrict
    ) {
      continue;
    }
    if (record.committeeInfo.mecid !== record.mecid) {
      continue;
    }
    if (!namesMatch(input.candidateName, record.committeeInfo.candidateName, expandNicknames)) {
      continue;
    }
    // Candidate-by-election exports often omit the public alias and middle
    // name present on Committee Info ("Michael Seabaugh" vs
    // "Michael 'Mike' A Seabaugh"). MECID binds the two source rows; require
    // their names to corroborate, then use the richer profile for the roster
    // comparison above.
    if (!namesMatch(record.committeeInfo.candidateName, record.candidateName)) {
      continue;
    }
    if (
      !historyMatches({
        info: record.committeeInfo,
        electionDate,
        politicalOffice: officeSearch.politicalOffice,
        expectedHistorySubdivision: officeSearch.historySubdivision,
        expectedJurisdiction,
      })
    ) {
      continue;
    }

    const accumulator = matches.get(record.mecid) ?? {
      mecid: record.mecid,
      committeeName: record.committeeInfo.committeeName,
      candidateName: record.committeeInfo.candidateName,
      officeSought: record.officeSought,
      sourceUrl: record.committeeInfo.sourceUrl,
      rows: [],
    };
    accumulator.rows.push(record);
    matches.set(record.mecid, accumulator);
  }

  if (matches.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const resolvedMatches = [...matches.values()]
    .map(toCommitteeMatch)
    .sort((left, right) => left.mecid.localeCompare(right.mecid));
  if (resolvedMatches.length === 1) {
    return { status: "matched", ...resolvedMatches[0]! };
  }
  return {
    status: "ambiguous",
    reason: "multiple_matching_committees",
    candidateNameNormalized,
    officeNameNormalized,
    matches: resolvedMatches,
  };
}

export function missouriCandidateCommitteeSearchKey(input: MissouriCandidateCommitteeSearchInput): string {
  return [
    input.electionDate,
    input.officeScope,
    input.officeName,
    input.ballotTitle,
    input.districtName ?? "",
    input.legislativeDistrict ?? "",
  ].join("\u0000");
}

export async function searchMissouriMecCandidateCommitteeRecords(
  input: MissouriCandidateCommitteeSearchInput,
  options: MissouriMecSessionOptions = {}
): Promise<MissouriMecCandidateCommitteeRecord[]> {
  const electionDate = normalizeIsoElectionDate(input.electionDate);
  const mecElectionDate = toMecElectionDate(electionDate);
  const electionYear = electionDate.slice(0, 4);
  const officeSearch = toMissouriMecOfficeSearchInput({
    officeScope: input.officeScope,
    officeName: input.officeName,
    ballotTitle: input.ballotTitle,
    legislativeDistrict: input.legislativeDistrict,
  });
  if (officeSearch === null || (officeSearch.requiresSubdivision && !input.districtName)) {
    return [];
  }
  if (
    (input.officeScope === "state_upper" || input.officeScope === "state_lower") &&
    officeSearch.politicalDistrict === null
  ) {
    return [];
  }

  const session = createMissouriMecSession(options);
  const searchUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.electionSearch);
  const prefix = MISSOURI_MEC_SEARCH_FIELD_PREFIX;
  const yearField = `${prefix}ddElectionYear`;
  const dateField = `${prefix}ddElectionDate`;
  const officeField = `${prefix}ddPoliticalOffice`;
  const subdivisionField = `${prefix}ddPoliticalSubdivision`;
  const districtField = `${prefix}ddPoliticalDistrict`;
  const statusField = `${prefix}ddStatus`;

  const initialHtml = requirePage(await session.get(searchUrl), "candidate search page");
  const yearHtml = requirePage(
    await session.postForm(
      searchUrl,
      {
        ...parseMissouriMecHiddenFields(initialHtml),
        __EVENTTARGET: yearField,
        __EVENTARGUMENT: "",
        [yearField]: electionYear,
      },
      { referer: searchUrl }
    ),
    "candidate search year cascade"
  );
  const dateOption = selectExactOption(
    parseMissouriMecSelectOptions(yearHtml, "ddElectionDate"),
    mecElectionDate,
    (value) => {
      try {
        return normalizeMissouriMecElectionDate(value);
      } catch {
        return null;
      }
    }
  );
  if (dateOption === null) {
    return [];
  }

  const dateHtml = requirePage(
    await session.postForm(
      searchUrl,
      {
        ...parseMissouriMecHiddenFields(yearHtml),
        __EVENTTARGET: dateField,
        __EVENTARGUMENT: "",
        [yearField]: electionYear,
        [dateField]: dateOption.value,
      },
      { referer: searchUrl }
    ),
    "candidate search date cascade"
  );
  const officeOption = selectExactOption(
    parseMissouriMecSelectOptions(dateHtml, "ddPoliticalOffice"),
    officeSearch.politicalOffice,
    (value) => normalizeMissouriMecText(value)
  );
  if (officeOption === null) {
    return [];
  }

  const officeFields = {
    [yearField]: electionYear,
    [dateField]: dateOption.value,
    [officeField]: officeOption.value,
  };
  let cascadeHtml = requirePage(
    await session.postForm(
      searchUrl,
      {
        ...parseMissouriMecHiddenFields(dateHtml),
        __EVENTTARGET: officeField,
        __EVENTARGUMENT: "",
        ...officeFields,
      },
      { referer: searchUrl }
    ),
    "candidate search office cascade"
  );

  let subdivisionOption: MissouriMecSelectOption | null = null;
  if (officeSearch.requiresSubdivision) {
    subdivisionOption = selectExactOption(
      parseMissouriMecSelectOptions(cascadeHtml, "ddPoliticalSubdivision"),
      input.districtName ?? "",
      normalizeMissouriMecJurisdiction
    );
    if (subdivisionOption === null) {
      return [];
    }
    cascadeHtml = requirePage(
      await session.postForm(
        searchUrl,
        {
          ...parseMissouriMecHiddenFields(cascadeHtml),
          __EVENTTARGET: subdivisionField,
          __EVENTARGUMENT: "",
          ...officeFields,
          [subdivisionField]: subdivisionOption.value,
        },
        { referer: searchUrl }
      ),
      "candidate search subdivision cascade"
    );
  }

  let districtOption: MissouriMecSelectOption | null = null;
  if (officeSearch.politicalDistrict !== null) {
    const districtOptions = parseMissouriMecSelectOptions(cascadeHtml, "ddPoliticalDistrict");
    districtOption = selectExactOption(
      districtOptions,
      officeSearch.politicalDistrict,
      normalizeMissouriMecPoliticalDistrict
    );
    const sourceOffersDistrictFilter = districtOptions.some(
      (option) => normalizeMissouriMecPoliticalDistrict(option.label || option.value) !== null
    );
    if (districtOption === null && sourceOffersDistrictFilter) {
      return [];
    }
  }

  const selectedFields = {
    ...officeFields,
    ...(subdivisionOption === null ? {} : { [subdivisionField]: subdivisionOption.value }),
    ...(districtOption === null ? {} : { [districtField]: districtOption.value }),
    [statusField]: "All",
  };
  const resultsHtml = requirePage(
    await session.postForm(
      searchUrl,
      {
        ...parseMissouriMecHiddenFields(cascadeHtml),
        __EVENTTARGET: "",
        __EVENTARGUMENT: "",
        ...selectedFields,
        [`${prefix}btnSearch`]: "Search",
      },
      { referer: searchUrl }
    ),
    "candidate search results"
  );
  const recordCountMatch = /\b([\d,]+)\s+records found\b/i.exec(resultsHtml);
  if (recordCountMatch?.[1] === undefined) {
    throw new MissouriMecClientError("bad_response", "Missouri MEC candidate results lack records-found count");
  }
  const recordCount = Number.parseInt(recordCountMatch[1].replace(/,/g, ""), 10);
  if (recordCount === 0) {
    return [];
  }
  if (!resultsHtml.includes("btnExport")) {
    throw new MissouriMecClientError("bad_response", "Missouri MEC candidate results lack Excel export control");
  }

  const exportResponse = await session.postForm(
    searchUrl,
    {
      ...parseMissouriMecHiddenFields(resultsHtml),
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      ...selectedFields,
      [`${prefix}btnExport`]: "Excel Export",
    },
    { referer: searchUrl }
  );
  if (
    exportResponse.status !== 200 ||
    exportResponse.redirectLocation !== null ||
    !(exportResponse.contentType ?? "").toLowerCase().includes("application/vnd.ms-excel") ||
    !(exportResponse.contentDisposition ?? "").toLowerCase().includes("cf_searchelection.xls")
  ) {
    throw new MissouriMecClientError(
      "bad_response",
      `Missouri MEC candidate export contract changed: status ${exportResponse.status}, content-type ${exportResponse.contentType ?? "none"}`,
      exportResponse.status
    );
  }
  const candidateExport = parseMissouriMecCandidateExportWithDiagnostics(exportResponse.text());
  if (candidateExport.sourceRowCount !== recordCount) {
    throw new MissouriMecClientError(
      "bad_response",
      `Missouri MEC candidate export row count ${candidateExport.sourceRowCount} does not match results count ${recordCount}`
    );
  }
  const exportRows = candidateExport.rows;
  const infoByMecid = new Map<string, MissouriMecCommitteeInfo>();
  for (const mecid of new Set(exportRows.map((row) => row.mecid))) {
    const infoUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeInfo, { MECID: mecid });
    const infoHtml = requirePage(await session.get(infoUrl, { referer: searchUrl }), `Committee Info ${mecid}`);
    const info = parseMissouriMecCommitteeInfo(infoHtml);
    if (info.mecid !== mecid) {
      throw new MissouriMecClientError(
        "bad_response",
        `Missouri MEC Committee Info identity mismatch: requested ${mecid}, received ${info.mecid}`
      );
    }
    infoByMecid.set(mecid, info);
  }

  return exportRows.map((row) => ({
    ...row,
    searchElectionDate: electionDate,
    searchPoliticalOffice: officeOption.label,
    searchPoliticalSubdivision: subdivisionOption?.label ?? null,
    searchPoliticalDistrict: districtOption?.label ?? null,
    committeeInfo: infoByMecid.get(row.mecid)!,
  }));
}

export async function searchAndResolveMissouriCandidateCommittee(
  input: MissouriCandidateCommitteeSearchInput,
  options: MissouriMecSessionOptions = {}
): Promise<MissouriCandidateCommitteeResolution> {
  const officeSearch = toMissouriMecOfficeSearchInput({
    officeScope: input.officeScope,
    officeName: input.officeName,
    ballotTitle: input.ballotTitle,
    legislativeDistrict: input.legislativeDistrict,
  });
  if (officeSearch === null) {
    return resolveMissouriCandidateCommittee({ ...input, records: [] });
  }
  const records = await searchMissouriMecCandidateCommitteeRecords(input, options);
  return resolveMissouriCandidateCommittee({ ...input, records });
}
