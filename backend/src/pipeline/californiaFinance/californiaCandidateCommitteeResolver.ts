import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict, personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";

export type CalAccessCampaignCoverRow = Record<string, string | null | undefined>;
export type CalAccessFilerNameRow = Record<string, string | null | undefined>;

export type CaliforniaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeName: string;
  electionYear: number;
  campaignCoverRows: readonly CalAccessCampaignCoverRow[];
  filerNameRows?: readonly CalAccessFilerNameRow[];
  sourceUrl?: string | null;
};

export type CaliforniaCandidateCommitteeMatch = {
  controlledCommitteeId: string;
  controlledCommitteeName: string;
  confidence: "exact";
  source: "cal_access";
  sourceUrl: string | null;
  matchedCoverRowCount: number;
};

export type CaliforniaCandidateCommitteeResolution =
  | ({ status: "matched" } & CaliforniaCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason: "no_candidate_office_year_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: CaliforniaCandidateCommitteeMatch[];
    };

const CAL_ACCESS_OFFICE_CODE_LABELS: Record<string, readonly string[]> = {
  GOV: ["governor"],
  LTG: ["lieutenant governor", "lt governor"],
  SOS: ["secretary of state"],
  // Cal-Access files Attorney General as ATT and Superintendent of Public
  // Instruction as SUP (2026 F460 covers); ATG/SPI are kept for older rows.
  ATT: ["attorney general"],
  ATG: ["attorney general"],
  CON: ["controller", "state controller", "comptroller"],
  TRE: ["treasurer", "state treasurer"],
  INS: ["insurance commissioner", "commissioner of insurance"],
  SUP: ["superintendent of public instruction", "superintendent"],
  SPI: ["superintendent of public instruction", "superintendent"],
  SEN: ["state senator", "state senate"],
  ASM: [
    "assembly",
    "state assembly",
    "member of the state assembly",
    "assembly member",
    "state lower chamber legislator",
  ],
  BOE: ["board of equalization", "state board of equalization member"],
};

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2001 || value > 2100) {
    throw new Error(`Invalid California committee resolver election year: ${value}`);
  }
  return value;
}

function value(row: Record<string, string | null | undefined>, key: string): string {
  return row[key]?.trim() ?? "";
}

function normalizeText(value: string): string {
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

function normalizePersonName(value: string): string {
  return normalizeText(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameKeysFromDisplayName(input: string): Set<string> {
  const normalized = normalizePersonName(input);
  const keys = new Set<string>();
  if (normalized.length === 0) {
    return keys;
  }
  keys.add(normalized);

  const commaParts = input
    .split(",")
    .map((part) => normalizePersonName(part))
    .filter(Boolean);
  if (commaParts.length === 2) {
    keys.add(`${commaParts[1]} ${commaParts[0]}`.replace(/\s+/g, " ").trim());
    const firstParts = commaParts[1]?.split(" ").filter(Boolean) ?? [];
    const lastParts = commaParts[0]?.split(" ").filter(Boolean) ?? [];
    if (firstParts.length > 0 && lastParts.length > 0) {
      keys.add(`${firstParts[0]} ${lastParts[lastParts.length - 1]}`);
    }
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
  }

  return keys;
}

function candidateNameFromCoverRow(row: CalAccessCampaignCoverRow): string {
  return [value(row, "CAND_NAMF"), value(row, "CAND_NAMT"), value(row, "CAND_NAML")]
    .filter(Boolean)
    .join(" ");
}

function candidateMatches(input: {
  candidateName: string;
  candidateNameKeys: Set<string>;
  row: CalAccessCampaignCoverRow;
}): boolean {
  if (input.candidateNameKeys.size === 0) {
    return false;
  }
  const rowCandidateName = candidateNameFromCoverRow(input.row);
  let keyMatched = false;
  for (const key of nameKeysFromDisplayName(rowCandidateName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    // Recall fallback for call names: the roster says "Steve Hilton" or
    // "Donald P. (Don) Wagner" while the F460 cover says STEPHEN / DON.
    // Nicknames expand on the VoteApp side only (personFirstNameNicknames
    // design rule), and the shared verdict still rejects middle conflicts.
    return personNamesMatchWithMiddleEvidence({
      candidateName: input.candidateName.replace(/"([^"]+)"/g, " ($1) "),
      rowNames: [rowCandidateName],
      normalizePersonName,
      firstNamesEquivalent: (candidateFirst, rowFirst) =>
        candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
    });
  }
  // Key overlap collapses names to first+last, which would link
  // "John A. Smith" to a cover row naming "John B. Smith" as an "exact" match
  // whenever the office and election date agree. A contradicting middle name
  // rejects the row (georgia pattern).
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [rowCandidateName],
    normalizePersonName,
  });
}

function officeKeysFromName(input: string): Set<string> {
  const normalized = normalizeText(input);
  const keys = new Set<string>();
  if (normalized.length > 0) {
    keys.add(normalized);
  }
  for (const [officeCode, labels] of Object.entries(CAL_ACCESS_OFFICE_CODE_LABELS)) {
    if (labels.some((label) => normalizeText(label) === normalized)) {
      keys.add(officeCode);
      for (const label of labels) {
        keys.add(normalizeText(label));
      }
    }
  }
  return keys;
}

function officeKeysFromCoverRow(row: CalAccessCampaignCoverRow): Set<string> {
  const keys = new Set<string>();
  const officeDescription = normalizeText(value(row, "OFFIC_DSCR"));
  const officeCode = normalizeText(value(row, "OFFICE_CD"));
  if (officeDescription.length > 0) {
    keys.add(officeDescription);
  }
  if (officeCode.length > 0) {
    keys.add(officeCode);
    for (const label of CAL_ACCESS_OFFICE_CODE_LABELS[officeCode] ?? []) {
      keys.add(normalizeText(label));
    }
  }
  return keys;
}

function officeMatches(inputKeys: Set<string>, row: CalAccessCampaignCoverRow): boolean {
  const rowKeys = officeKeysFromCoverRow(row);
  for (const key of rowKeys) {
    if (inputKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function parseCalAccessDateYear(raw: string): number | null {
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

function electionYearMatches(row: CalAccessCampaignCoverRow, electionYear: number): boolean {
  return parseCalAccessDateYear(value(row, "ELECT_DATE")) === electionYear;
}

/**
 * Independent-expenditure reports (F496 late IE, F465 supplemental IE) name
 * the candidate a committee spent FOR or AGAINST — they are never evidence
 * that the filer is the candidate's own committee. Same for cover rows whose
 * declared committee type is present but not "C" (G = general purpose,
 * B = ballot measure): those committees name the controlling candidate on
 * their filings without being the candidate-election committee.
 */
const INDEPENDENT_EXPENDITURE_FORM_TYPES = new Set(["F496", "F465"]);

function isCandidateCommitteeEvidenceRow(row: CalAccessCampaignCoverRow): boolean {
  const formType = value(row, "FORM_TYPE").toUpperCase();
  if (INDEPENDENT_EXPENDITURE_FORM_TYPES.has(formType)) {
    return false;
  }
  const committeeType = value(row, "CMTTE_TYPE").toUpperCase();
  if (committeeType.length > 0 && committeeType !== "C") {
    return false;
  }
  // A candidate-controlled ballot-measure committee ("Safe Communities,
  // Strong Futures: A Nick Schultz Ballot Measure Committee") files CMTTE_TYPE
  // "C" covers naming the candidate and office, so only its name tells it
  // apart from the election committee.
  if (/\bBALLOT MEASURE COMMITTEE\b/i.test(value(row, "FILER_NAML"))) {
    return false;
  }
  return true;
}

function hasControlledFiling(rows: readonly CalAccessCampaignCoverRow[]): boolean {
  return rows.some((row) => value(row, "CONTROL_YN").toUpperCase() === "Y");
}

function committeeIdFromCoverRow(row: CalAccessCampaignCoverRow): string {
  return value(row, "FILER_ID") || value(row, "CMTTE_ID");
}

function committeeNameFromFilerRow(row: CalAccessFilerNameRow): string {
  return [value(row, "NAMF"), value(row, "NAMT"), value(row, "NAML")].filter(Boolean).join(" ");
}

function buildFilerNameLookup(rows: readonly CalAccessFilerNameRow[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const row of rows) {
    const filerId = value(row, "FILER_ID");
    if (!filerId || lookup.has(filerId)) {
      continue;
    }
    const name = committeeNameFromFilerRow(row);
    if (name) {
      lookup.set(filerId, name);
    }
  }
  return lookup;
}

function committeeNameForMatch(input: {
  committeeId: string;
  rows: readonly CalAccessCampaignCoverRow[];
  filerNames: Map<string, string>;
}): string {
  for (const row of input.rows) {
    const filerName = value(row, "FILER_NAML");
    if (filerName) {
      return filerName;
    }
  }
  return input.filerNames.get(input.committeeId) ?? input.committeeId;
}

function toCommitteeMatch(input: {
  committeeId: string;
  rows: readonly CalAccessCampaignCoverRow[];
  filerNames: Map<string, string>;
  sourceUrl: string | null;
}): CaliforniaCandidateCommitteeMatch {
  return {
    controlledCommitteeId: input.committeeId,
    controlledCommitteeName: committeeNameForMatch(input),
    confidence: "exact",
    source: "cal_access",
    sourceUrl: input.sourceUrl,
    matchedCoverRowCount: input.rows.length,
  };
}

export function resolveCaliforniaCandidateCommittee(
  input: CaliforniaCandidateCommitteeResolverInput
): CaliforniaCandidateCommitteeResolution {
  const candidateName = requireNonEmpty(input.candidateName, "California candidate committee resolver candidateName");
  const officeName = requireNonEmpty(input.officeName, "California candidate committee resolver officeName");
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = nameKeysFromDisplayName(candidateName);
  const officeKeys = officeKeysFromName(officeName);
  const candidateNameNormalized = [...candidateNameKeys][0] ?? normalizePersonName(candidateName);
  const officeNameNormalized = [...officeKeys][0] ?? normalizeText(officeName);
  const rowsByCommittee = new Map<string, CalAccessCampaignCoverRow[]>();

  for (const row of input.campaignCoverRows) {
    if (!candidateMatches({ candidateName, candidateNameKeys, row })) {
      continue;
    }
    if (!officeMatches(officeKeys, row)) {
      continue;
    }
    if (!electionYearMatches(row, electionYear)) {
      continue;
    }
    if (!isCandidateCommitteeEvidenceRow(row)) {
      continue;
    }

    const committeeId = committeeIdFromCoverRow(row);
    if (!committeeId) {
      continue;
    }
    const rows = rowsByCommittee.get(committeeId) ?? [];
    rows.push(row);
    rowsByCommittee.set(committeeId, rows);
  }

  if (rowsByCommittee.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_office_year_match",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const filerNames = buildFilerNameLookup(input.filerNameRows ?? []);

  // Disambiguate a candidate's OWN committees. A candidate's controlled
  // ballot-measure committee files F460s with CONTROL_YN "N" (or committee
  // type G/B) while the candidate-election committee declares CONTROL_YN "Y",
  // so prefer committees with a controlled filing. When several controlled
  // committees remain (an old cycle's committee still filing against the new
  // election date), FPPC committee names carry the election year — pick the
  // sole committee named for the target year, and stay ambiguous otherwise.
  let survivingEntries = [...rowsByCommittee.entries()];
  if (survivingEntries.length > 1) {
    const controlledEntries = survivingEntries.filter(([, rows]) => hasControlledFiling(rows));
    if (controlledEntries.length > 0) {
      survivingEntries = controlledEntries;
    }
    if (survivingEntries.length > 1) {
      const yearPattern = new RegExp(`\\b${electionYear}\\b`);
      const namedForYearEntries = survivingEntries.filter(([committeeId, rows]) =>
        yearPattern.test(committeeNameForMatch({ committeeId, rows, filerNames }))
      );
      if (namedForYearEntries.length === 1) {
        survivingEntries = namedForYearEntries;
      }
    }
  }

  const matches = survivingEntries
    .map(([committeeId, rows]) =>
      toCommitteeMatch({
        committeeId,
        rows,
        filerNames,
        sourceUrl: input.sourceUrl ?? null,
      })
    )
    .sort((left, right) => left.controlledCommitteeId.localeCompare(right.controlledCommitteeId));

  if (matches.length === 1) {
    return {
      status: "matched",
      ...matches[0],
    };
  }

  return {
    status: "ambiguous",
    reason: "multiple_matching_committees",
    candidateNameNormalized,
    officeNameNormalized,
    matches,
  };
}
