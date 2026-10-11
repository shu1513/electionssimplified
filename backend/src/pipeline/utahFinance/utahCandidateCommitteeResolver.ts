import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  buildUtahAdvancedSearchUrl,
  fetchUtahEntityReportListHtml,
  parseUtahAdvancedSearchEntityRows,
  type UtahDisclosuresClientOptions,
  type UtahDisclosuresEntitySearchRow,
} from "./utahDisclosuresClient.js";

export type UtahCandidateCommitteeResolverInput = {
  candidateName: string;
  electionYear: number;
  officeName?: string | null;
  district?: string | null;
  trustedFolderId?: string | number | null;
  entityRows: readonly UtahDisclosuresEntitySearchRow[];
  sourceUrl?: string | null;
};

export type UtahCandidateCommitteeSearchInput = Omit<
  UtahCandidateCommitteeResolverInput,
  "entityRows" | "sourceUrl"
>;

export type UtahCandidateCommitteeMatch = {
  folderId: string;
  committeeName: string;
  reportYears: number[];
  confidence: "exact";
  source: "disclosures_advanced_search";
  sourceUrl: string | null;
  matchedEntityRowCount: number;
};

export type UtahCandidateCommitteeResolution =
  | ({ status: "matched" } & UtahCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason: "missing_candidate_name" | "no_candidate_committee_match";
      candidateNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      matches: UtahCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  folderId: string;
  committeeName: string;
  reportYears: Set<number>;
  officeName: string | null;
  district: string | null;
  sourceUrl: string | null;
  rows: UtahDisclosuresEntitySearchRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 1998 || value > 2100) {
    throw new Error(`Invalid Utah candidate committee election year: ${value}`);
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
    .replace(/\b(THE|OF|FOR|TO|ELECT|COMMITTEE|FRIENDS|CITIZENS|UTAH)\b/g, " ")
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

function normalizeDistrict(value: string | null | undefined): string | null {
  const normalized = normalizeTextKey(value);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^(?:(?:HOUSE|SENATE|DIST(?:RICT)?|HD|SD)\s*)?0*([1-9][0-9]?)$/);
  return match?.[1] ?? null;
}

function normalizeOfficeToken(value: string | null | undefined): string | null {
  const normalized = normalizeTextKey(value)
    .replace(/\b(CHAMBER|LEGISLATOR|MEMBER|STATE)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("GOVERNOR")) {
    return "GOVERNOR";
  }
  if (normalized.includes("ATTORNEY GENERAL")) {
    return "ATTORNEY GENERAL";
  }
  if (normalized.includes("AUDITOR")) {
    return "AUDITOR";
  }
  if (normalized.includes("TREASURER")) {
    return "TREASURER";
  }
  if (normalized.includes("SENATOR") || normalized.includes("SENATE")) {
    return "SENATE";
  }
  if (normalized.includes("HOUSE") || normalized.includes("REPRESENTATIVE") || normalized.includes("LOWER")) {
    return "HOUSE";
  }
  return normalized;
}

function parseUtahFolderTitleMetadata(value: string): {
  electionYear: number | null;
  officeName: string | null;
  district: string | null;
} {
  const parenthetical = [...value.matchAll(/\(([^()]+)\)/g)].map((match) => match[1] ?? "").join(" ");
  const text = parenthetical || value;
  const electionYear = Number.parseInt(text.match(/\b(19|20)\d{2}\b/)?.[0] ?? "", 10);
  const officeMatch = text.match(/\b(HOUSE|SENATE|GOVERNOR|ATTORNEY\s+GENERAL|AUDITOR|TREASURER)\b/i);
  const districtMatch = text.match(/\b(?:HOUSE|SENATE|HD|SD|DIST(?:RICT)?)\s*-?\s*0*([1-9][0-9]?)\b/i);
  return {
    electionYear: Number.isInteger(electionYear) ? electionYear : null,
    officeName: officeMatch?.[1] ? normalizeOfficeToken(officeMatch[1]) : null,
    district: districtMatch?.[1] ?? null,
  };
}

function buildUtahCandidateSearchTerms(candidateName: string): string[] {
  const cleaned = candidateName.replace(/\([^()]+\)/g, " ").replace(/\s+/g, " ").trim();
  const terms = new Set<string>();
  if (cleaned) {
    terms.add(cleaned);
  }

  const commaParts = cleaned
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaParts.length >= 2) {
    terms.add(commaParts[0] ?? "");
    terms.add(commaParts[commaParts.length - 1] ?? "");
  }

  const words = cleaned
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length >= 2) {
    terms.add(words[words.length - 1] ?? "");
    terms.add(words[0] ?? "");
  }

  return [...terms].filter(Boolean);
}

// expandNicknames adds first+last keys for the first name's nickname
// variants ("Walt Brooks" → "WALTER BROOKS"): disclosure folders carry the
// formal name while VoteApp stores the campaign name. Expand the VoteApp side
// only (personFirstNameNicknames.ts explains why). Nickname keys go last so
// the first key (used for storage) is unchanged.
export function normalizeUtahCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();
  const nicknameKeys = new Set<string>();

  function addName(raw: string): void {
    const normalized = normalizePersonName(raw);
    if (normalized) {
      keys.add(normalized);
    }

    const parts = normalized.split(" ").filter(Boolean);
    if (!raw.includes(",") && parts.length >= 2) {
      const first = parts[0] ?? "";
      const last = parts[parts.length - 1] ?? "";
      keys.add(`${first} ${last}`);
      if (options.expandNicknames) {
        for (const variant of firstNameVariants(first)) {
          nicknameKeys.add(`${variant} ${last}`);
        }
      }
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

  for (const key of nicknameKeys) {
    keys.add(key);
  }
  return keys;
}

function candidateNameNormalized(value: string): string {
  return [...normalizeUtahCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function entityNameMatchesCandidate(input: {
  entityName: string;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const entityKey = normalizeTextKey(input.entityName);
  if (!entityKey) {
    return false;
  }
  const entityTokens = new Set(entityKey.split(" ").filter(Boolean));
  let keyMatched = false;
  for (const key of input.candidateNameKeys) {
    const candidateTokens = key.split(" ").filter(Boolean);
    if (candidateTokens.length >= 2 && candidateTokens.every((token) => entityTokens.has(token))) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Token containment collapses names to first+last, so folder "Doe, Jane Q."
  // would match candidate "Jane R. Doe" as an "exact" committee whenever the
  // folder title's office, district, and year agree. A contradicting middle
  // name rejects the folder.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [input.entityName],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function rowMatchesElectionYear(row: UtahDisclosuresEntitySearchRow, electionYear: number): boolean {
  if (row.reportYears.includes(electionYear)) {
    return true;
  }
  const titleYear = parseUtahFolderTitleMetadata(row.entityName).electionYear;
  if (titleYear !== null) {
    return titleYear === electionYear;
  }
  return row.reportYears.length === 0;
}

function rowMatchesOfficeAndDistrict(input: {
  row: UtahDisclosuresEntitySearchRow;
  officeName?: string | null;
  district?: string | null;
}): boolean {
  const expectedOffice = normalizeOfficeToken(input.officeName);
  const expectedDistrict = normalizeDistrict(input.district);
  const parsed = parseUtahFolderTitleMetadata(input.row.entityName);
  if (expectedOffice && parsed.officeName && parsed.officeName !== expectedOffice) {
    return false;
  }
  if (expectedDistrict && parsed.district && parsed.district !== expectedDistrict) {
    return false;
  }
  return true;
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): UtahCandidateCommitteeMatch {
  return {
    folderId: input.accumulator.folderId,
    committeeName: input.accumulator.committeeName,
    reportYears: [...input.accumulator.reportYears].sort((left, right) => right - left),
    confidence: "exact",
    source: "disclosures_advanced_search",
    sourceUrl: input.accumulator.sourceUrl ?? input.sourceUrl,
    matchedEntityRowCount: input.accumulator.rows.length,
  };
}

export function resolveUtahCandidateCommittee(
  input: UtahCandidateCommitteeResolverInput
): UtahCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = normalizeUtahCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const trustedFolderId =
    input.trustedFolderId === null || input.trustedFolderId === undefined
      ? null
      : String(input.trustedFolderId).trim();

  if (trustedFolderId) {
    const trustedRows = input.entityRows.filter((row) => row.folderId.trim() === trustedFolderId);
    if (trustedRows.length > 0) {
      const accumulator: CandidateCommitteeAccumulator = {
        folderId: trustedFolderId,
        committeeName: trustedRows[0]?.entityName.trim() || trustedFolderId,
        reportYears: new Set<number>(),
        officeName: parseUtahFolderTitleMetadata(trustedRows[0]?.entityName ?? "").officeName,
        district: parseUtahFolderTitleMetadata(trustedRows[0]?.entityName ?? "").district,
        sourceUrl: trustedRows[0]?.sourceUrl || null,
        rows: trustedRows,
      };
      for (const row of trustedRows) {
        for (const reportYear of row.reportYears) {
          accumulator.reportYears.add(reportYear);
        }
      }
      return {
        status: "matched",
        ...toCommitteeMatch({ accumulator, sourceUrl: input.sourceUrl ?? null }),
      };
    }
  }

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
    };
  }

  // Literal names first; nickname keys only when no folder matched, so a
  // literal match never turns ambiguous because of a nickname folder.
  let rowsByFolder = collectMatchingFolders(input, electionYear, candidateNameKeys);
  if (rowsByFolder.size === 0) {
    rowsByFolder = collectMatchingFolders(
      input,
      electionYear,
      normalizeUtahCandidateNameKeys(input.candidateName, { expandNicknames: true })
    );
  }

  if (rowsByFolder.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
    };
  }

  const matches = [...rowsByFolder.values()]
    .map((accumulator) => toCommitteeMatch({ accumulator, sourceUrl: input.sourceUrl ?? null }))
    .sort((left, right) => left.folderId.localeCompare(right.folderId));

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
    matches,
  };
}

function collectMatchingFolders(
  input: UtahCandidateCommitteeResolverInput,
  electionYear: number,
  candidateNameKeys: ReadonlySet<string>
): Map<string, CandidateCommitteeAccumulator> {
  const rowsByFolder = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.entityRows) {
    const folderId = row.folderId.trim();
    const committeeName = row.entityName.trim();
    if (!folderId || !committeeName) {
      continue;
    }
    if (!rowMatchesElectionYear(row, electionYear)) {
      continue;
    }
    if (!rowMatchesOfficeAndDistrict({ row, officeName: input.officeName, district: input.district })) {
      continue;
    }
    if (
      !entityNameMatchesCandidate({
        entityName: committeeName,
        candidateName: input.candidateName,
        candidateNameKeys,
      })
    ) {
      continue;
    }

    const parsedTitle = parseUtahFolderTitleMetadata(committeeName);
    const accumulator = rowsByFolder.get(folderId) ?? {
      folderId,
      committeeName,
      reportYears: new Set<number>(),
      officeName: parsedTitle.officeName,
      district: parsedTitle.district,
      sourceUrl: row.sourceUrl || null,
      rows: [],
    };
    for (const reportYear of row.reportYears) {
      accumulator.reportYears.add(reportYear);
    }
    accumulator.rows.push(row);
    rowsByFolder.set(folderId, accumulator);
  }
  return rowsByFolder;
}

export async function searchAndResolveUtahCandidateCommittee(
  input: UtahCandidateCommitteeSearchInput,
  options: UtahDisclosuresClientOptions = {}
): Promise<UtahCandidateCommitteeResolution> {
  let ambiguousResolution: UtahCandidateCommitteeResolution | null = null;
  let unmatchedResolution: UtahCandidateCommitteeResolution | null = null;
  for (const search of buildUtahCandidateSearchTerms(input.candidateName)) {
    const html = await fetchUtahEntityReportListHtml(
      {
        search,
        entityType: "PCC",
        reportYear: input.electionYear,
        hideContributions: false,
        hideExpenditures: false,
        pageNumber: 1,
      },
      options
    );
    const resolution = resolveUtahCandidateCommittee({
      ...input,
      entityRows: parseUtahAdvancedSearchEntityRows(html, options.baseUrl, "PCC"),
      sourceUrl: buildUtahAdvancedSearchUrl(options.baseUrl),
    });
    if (resolution.status === "matched") {
      return resolution;
    }
    if (resolution.status === "ambiguous" && ambiguousResolution === null) {
      ambiguousResolution = resolution;
    }
    if (resolution.status === "unmatched") {
      unmatchedResolution = resolution;
    }
  }

  return (
    ambiguousResolution ??
    unmatchedResolution ?? {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameNormalized(input.candidateName),
    }
  );
}
