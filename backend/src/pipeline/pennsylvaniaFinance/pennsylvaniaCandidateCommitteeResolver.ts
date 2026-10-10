import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import { normalizePennsylvaniaCampaignFinanceExportYear } from "./pennsylvaniaCampaignFinanceArtifactCache.js";
import type { PennsylvaniaCampaignFinanceFilerRow } from "./pennsylvaniaCampaignFinanceReader.js";
import {
  mapPennsylvaniaFinanceOffice,
  mapPennsylvaniaFinanceOfficeCode,
  normalizePennsylvaniaFinanceLegislativeDistrict,
  toPennsylvaniaFinanceOfficeSearchInput,
  type PennsylvaniaFinanceOfficeSearchInput,
} from "./pennsylvaniaFinanceEligibleOffices.js";

export type PennsylvaniaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  filerRows: readonly PennsylvaniaCampaignFinanceFilerRow[];
  sourceUrl?: string | null;
};

export type PennsylvaniaCandidateCommitteeMatch = {
  filerId: string;
  filerName: string;
  filerType: string | null;
  confidence: "exact";
  source: "pa_bulk";
  sourceUrl: string | null;
  matchedFilerRowCount: number;
};

export type PennsylvaniaCandidateCommitteeResolution =
  | ({ status: "matched" } & PennsylvaniaCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_legislative_district"
        | "no_candidate_filer_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_filers";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: PennsylvaniaCandidateCommitteeMatch[];
    };

type CandidateFilerAccumulator = {
  filerId: string;
  filerName: string;
  filerType: string | null;
  rows: PennsylvaniaCampaignFinanceFilerRow[];
};

function normalizeTextKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    // "La'Tasha" / "O'Neal" file as LATASHA / ONEAL; an apostrophe is not a
    // word break.
    .replace(/['\u2019]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCommitteeTextKey(value: string | null | undefined): string {
  return normalizeTextKey(value)
    .replace(/\b(THE|OF|FOR|COMMITTEE|FRIENDS|TO|ELECT|CITIZENS|CAMPAIGN|PEOPLE|PENNSYLVANIANS|PENNSYLVANIA|PA|INC|STATE|REPRESENTATIVE|REP|SENATOR|SENATE|HOUSE)\b/g, " ")
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

// expandNicknames adds first+last keys for the first name's nickname
// variants ("Josh Shapiro" → "JOSHUA SHAPIRO"). PA files candidates under
// formal names ("SHAPIRO, JOSHUA D") while VoteApp stores campaign names.
// Expand the VoteApp side only (personFirstNameNicknames.ts explains why);
// filer rows are keyed literally.
export function normalizePennsylvaniaCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();
  const nicknameKeys = new Set<string>();

  function addFirstLast(first: string, last: string): void {
    keys.add(`${first} ${last}`);
    if (options.expandNicknames) {
      for (const variant of firstNameVariants(first)) {
        nicknameKeys.add(`${variant} ${last}`);
      }
    }
  }

  function addName(raw: string): void {
    const hasComma = raw.includes(",");
    const normalized = normalizePersonName(raw);
    if (normalized) {
      keys.add(normalized);
    }

    const parts = normalized.split(" ").filter(Boolean);
    if (!hasComma && parts.length >= 2) {
      addFirstLast(parts[0] ?? "", parts[parts.length - 1] ?? "");
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
          addFirstLast(flippedParts[0] ?? "", flippedParts[flippedParts.length - 1] ?? "");
        }
      }
    }
  }

  addName(trimmed.replace(/\([^()]+\)/g, " "));
  for (const match of trimmed.matchAll(/\(([^()]+)\)/g)) {
    if (match[1]) {
      addName(match[1]);
      // "NATALIE NICOLE STUCK (MIHALEK)": a one-word parenthetical after a
      // full name is the surname the candidate runs under.
      const outerFirst = normalizePersonName(trimmed.replace(/\([^()]+\)/g, " ")).split(" ")[0] ?? "";
      const inner = normalizePersonName(match[1]);
      if (outerFirst && inner && !inner.includes(" ")) {
        addFirstLast(outerFirst, inner);
      }
    }
  }

  // Nickname keys go last so the first key (used for storage) is unchanged.
  for (const key of nicknameKeys) {
    keys.add(key);
  }
  return keys;
}

// The candidate's surname: the last token of the first+last key.
function candidateSurname(value: string): string {
  const keys = [...normalizePennsylvaniaCandidateNameKeys(value)];
  const firstLast = keys.find((key) => key.split(" ").length === 2) ?? keys[0] ?? "";
  const tokens = firstLast.split(" ").filter(Boolean);
  return tokens[tokens.length - 1] ?? "";
}

// Statewide committees are often named by surname alone ("Shapiro for
// Pennsylvania", "Garrity for PA"), so no first+last key can match them.
// Accept such a committee only when its own row names THIS office (blank
// OFFICE rows never reach here) and the committee name, minus wrappers, is
// exactly the candidate's surname. The caller also requires the candidate's
// own office-matched registration row before admitting the committee.
function committeeMatchesSurnameOnly(input: {
  row: PennsylvaniaCampaignFinanceFilerRow;
  surname: string;
}): boolean {
  if (!input.surname) {
    return false;
  }
  // A registration row (FILERTYPE 1) is sometimes filed under the committee
  // name ("BENNINGHOFF FOR REPRESENTATIVE"); a plain person name on a
  // registration row never qualifies, so a same-surname stranger's own
  // registration cannot match through here.
  const isCommittee = input.row.FILERTYPE.trim() === "2";
  return filerNameVariants(input.row).some((variant) => {
    const key = normalizeCommitteeTextKey(variant);
    if (key !== input.surname) {
      return false;
    }
    return isCommittee || normalizeTextKey(variant) !== key;
  });
}

function candidateNameNormalized(value: string): string {
  return [...normalizePennsylvaniaCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

export function normalizePennsylvaniaCandidateNameForStorage(value: string): string {
  return candidateNameNormalized(value);
}

function stripFilerWrapper(value: string): string {
  return value
    .replace(/\bC\/O\b.*$/i, " ")
    .replace(/\bCARE OF\b.*$/i, " ")
    .replace(/\bTREASURER\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function filerNameVariants(row: PennsylvaniaCampaignFinanceFilerRow): string[] {
  const raw = row.FILERNAME.trim();
  return [raw, stripFilerWrapper(raw)];
}

function filerNameKeys(row: PennsylvaniaCampaignFinanceFilerRow): Set<string> {
  const keys = new Set<string>();
  for (const candidate of filerNameVariants(row)) {
    for (const key of normalizePennsylvaniaCandidateNameKeys(candidate)) {
      keys.add(key);
    }
    const committeeKey = normalizeCommitteeTextKey(candidate);
    if (committeeKey) {
      keys.add(committeeKey);
      // "LATASHA D. MAYES FOR STATE REPRESENTATIVE" minus wrappers is a
      // person name with a middle initial; key it like one so first+last
      // can meet the candidate.
      for (const key of normalizePennsylvaniaCandidateNameKeys(committeeKey)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function tokensContainCandidateName(input: {
  candidateNameKeys: ReadonlySet<string>;
  filerKeys: ReadonlySet<string>;
}): boolean {
  for (const candidateKey of input.candidateNameKeys) {
    const candidateTokens = candidateKey.split(" ").filter(Boolean);
    if (candidateTokens.length < 2) {
      continue;
    }
    for (const filerKey of input.filerKeys) {
      const filerTokens = filerKey.split(" ").filter(Boolean);
      for (let index = 0; index <= filerTokens.length - candidateTokens.length; index += 1) {
        if (candidateTokens.every((token, offset) => filerTokens[index + offset] === token)) {
          return true;
        }
      }
    }
  }
  return false;
}

function rowMatchesCandidateName(input: {
  row: PennsylvaniaCampaignFinanceFilerRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const keys = filerNameKeys(input.row);
  let keyMatched = false;
  for (const key of keys) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    keyMatched = tokensContainCandidateName({
      candidateNameKeys: input.candidateNameKeys,
      filerKeys: keys,
    });
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, so "SMITH, JOHN B." would match
  // candidate "John A. Smith" as an "exact" filer whenever office, district,
  // and year agree. A contradicting middle name rejects the row. Committee-name
  // keys carry a wrapper token first ("FRIENDS OF ...") and never align on
  // first+last, so the committee path is untouched.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: filerNameVariants(input.row),
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function isLikelyCandidateFiler(row: PennsylvaniaCampaignFinanceFilerRow): boolean {
  if (!row.FILERID.trim() || !row.FILERNAME.trim()) {
    return false;
  }
  const name = normalizeTextKey(row.FILERNAME);
  if (/\b(?:PAC|POLITICAL ACTION|PARTY|CAUCUS|BALLOT|REFERENDUM|SUPER PAC|SUPERPAC)\b/.test(name)) {
    return false;
  }
  return true;
}

function parseYear(raw: string): number | null {
  const normalized = raw.trim();
  if (!/^\d{4}$/.test(normalized)) {
    return null;
  }
  return Number.parseInt(normalized, 10);
}

function rowMatchesElectionYear(row: PennsylvaniaCampaignFinanceFilerRow, electionYear: number): boolean {
  const rowYear = parseYear(row.EYEAR);
  return rowYear === null || rowYear === electionYear;
}

function zip5(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 5);
}

function phoneDigits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function rowMatchesOfficeContext(input: {
  row: PennsylvaniaCampaignFinanceFilerRow;
  officeSearchInput: PennsylvaniaFinanceOfficeSearchInput;
}): boolean {
  const mapped = mapPennsylvaniaFinanceOffice({
    office: input.row.OFFICE,
    district: input.row.DISTRICT,
  });
  return (
    mapped !== null &&
    mapped.paOfficeCode === input.officeSearchInput.paOfficeCode &&
    mapped.district === input.officeSearchInput.district
  );
}

function isLegislativeInput(input: { officeScope: string; officeName: string }): boolean {
  return (
    (input.officeScope === "state_upper" && input.officeName.trim() === "State Senator") ||
    (input.officeScope === "state_lower" && input.officeName.trim() === "State Lower Chamber Legislator")
  );
}

function hasValidLegislativeDistrict(input: { officeScope: string; officeName: string; district?: string | null }): boolean {
  if (input.officeScope === "state_upper" && input.officeName.trim() === "State Senator") {
    return normalizePennsylvaniaFinanceLegislativeDistrict(input.district, 50) !== null;
  }
  if (input.officeScope === "state_lower" && input.officeName.trim() === "State Lower Chamber Legislator") {
    return normalizePennsylvaniaFinanceLegislativeDistrict(input.district, 203) !== null;
  }
  return true;
}

function toFilerMatch(input: {
  accumulator: CandidateFilerAccumulator;
  sourceUrl: string | null;
}): PennsylvaniaCandidateCommitteeMatch {
  return {
    filerId: input.accumulator.filerId,
    filerName: input.accumulator.filerName,
    filerType: input.accumulator.filerType,
    confidence: "exact",
    source: "pa_bulk",
    sourceUrl: input.sourceUrl,
    matchedFilerRowCount: input.accumulator.rows.length,
  };
}

// True when a person-name key of the row ends in the candidate's surname.
function rowCarriesSurname(input: { row: PennsylvaniaCampaignFinanceFilerRow; surname: string }): boolean {
  if (!input.surname) {
    return false;
  }
  for (const variant of filerNameVariants(input.row)) {
    for (const key of normalizePennsylvaniaCandidateNameKeys(variant)) {
      const tokens = key.split(" ");
      if (tokens.length >= 2 && tokens[tokens.length - 1] === input.surname) {
        return true;
      }
    }
  }
  return false;
}

function dedupeSameNameCommittees(accumulators: CandidateFilerAccumulator[]): CandidateFilerAccumulator[] {
  const byName = new Map<string, CandidateFilerAccumulator>();
  for (const accumulator of accumulators) {
    // Only a literally identical name (wrappers kept) is a duplicate.
    const name = normalizeTextKey(stripFilerWrapper(accumulator.filerName));
    const current = byName.get(name);
    if (!current) {
      byName.set(name, accumulator);
      continue;
    }
    const latest = (rows: PennsylvaniaCampaignFinanceFilerRow[]): string =>
      rows.reduce((max, row) => ((row.SubmittedDate ?? "").trim() > max ? (row.SubmittedDate ?? "").trim() : max), "");
    const replace =
      accumulator.rows.length > current.rows.length ||
      (accumulator.rows.length === current.rows.length && latest(accumulator.rows) > latest(current.rows));
    if (replace) {
      byName.set(name, accumulator);
    }
  }
  return [...byName.values()].sort((left, right) => left.filerId.localeCompare(right.filerId));
}

export function resolvePennsylvaniaCandidateCommittee(
  input: PennsylvaniaCandidateCommitteeResolverInput
): PennsylvaniaCandidateCommitteeResolution {
  const electionYear = normalizePennsylvaniaCampaignFinanceExportYear(input.electionYear);
  const candidateNameKeys = normalizePennsylvaniaCandidateNameKeys(input.candidateName, { expandNicknames: true });
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const surname = candidateSurname(input.candidateName);
  const officeSearchInput = toPennsylvaniaFinanceOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  const officeNameNormalized = officeSearchInput?.paOfficeCode ?? normalizeTextKey(input.officeName);

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
        isLegislativeInput(input) && !hasValidLegislativeDistrict(input)
          ? "missing_legislative_district"
          : "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const rowsByFiler = new Map<string, CandidateFilerAccumulator>();
  const surnameOnlyByFiler = new Map<string, CandidateFilerAccumulator>();
  // Another person with the candidate's surname registered for THIS race
  // (John Smith vs Jane Smith). A surname-only filer could then be either
  // one's, so none is admitted.
  let rivalSurnameRegistration = false;
  for (const row of input.filerRows) {
    const filerId = row.FILERID.trim().toUpperCase();
    const filerName = row.FILERNAME.trim();
    if (!filerId || !filerName) {
      continue;
    }
    if (!rowMatchesElectionYear(row, electionYear)) {
      continue;
    }
    if (!isLikelyCandidateFiler(row)) {
      continue;
    }
    if (!rowMatchesOfficeContext({ row, officeSearchInput })) {
      continue;
    }
    const fullNameMatch = rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys });
    const target = fullNameMatch
      ? rowsByFiler
      : committeeMatchesSurnameOnly({ row, surname })
        ? surnameOnlyByFiler
        : null;
    if (!target) {
      if (row.FILERTYPE.trim() === "1" && rowCarriesSurname({ row, surname })) {
        rivalSurnameRegistration = true;
      }
      continue;
    }

    const accumulator = target.get(filerId) ?? {
      filerId,
      filerName,
      filerType: row.FILERTYPE.trim() || null,
      rows: [],
    };
    accumulator.rows.push(row);
    target.set(filerId, accumulator);
  }

  // Surname-only filers are admitted only when no same-surname rival
  // registered for this race. A surname-only registration row
  // ("BENNINGHOFF FOR REPRESENTATIVE", FILERTYPE 1) is the candidacy itself;
  // a surname-only committee also needs the candidate's own office-matched
  // registration row, whose explicit OFFICE/DISTRICT ties it to this race.
  if (!rivalSurnameRegistration) {
    for (const [filerId, accumulator] of surnameOnlyByFiler) {
      if (accumulator.filerType === "1" && !rowsByFiler.has(filerId)) {
        rowsByFiler.set(filerId, accumulator);
      }
    }
    const hasRegistrationRow = [...rowsByFiler.values()].some((accumulator) => accumulator.filerType === "1");
    if (hasRegistrationRow) {
      for (const [filerId, accumulator] of surnameOnlyByFiler) {
        if (!rowsByFiler.has(filerId)) {
          rowsByFiler.set(filerId, accumulator);
        }
      }
    }
  }

  // Most PA committee rows carry no usable office context (3,428 of 4,060
  // in the 2026 export leave OFFICE blank; another 278 name an office but no
  // district), so the office filter above cannot see the funded committee and
  // the candidate resolves to their moneyless FILERTYPE 1 registration row.
  // Recall such a committee ONLY with corroboration: the candidacy is proven
  // by an office-matched registration row from the first pass, the committee
  // name matches the candidate, the row is active this cycle, and the
  // committee shares a ZIP or phone number with that registration row — a
  // same-name stranger's committee shares neither. Name-only committees stay
  // out.
  const registrationRows = [...rowsByFiler.values()]
    .filter((accumulator) => accumulator.filerType === "1")
    .flatMap((accumulator) => accumulator.rows);
  if (registrationRows.length > 0) {
    const registrationZips = new Set(
      registrationRows.map((row) => zip5(row.ZIPCODE)).filter((zip) => zip.length === 5)
    );
    const registrationPhones = new Set(
      registrationRows.map((row) => phoneDigits(row.PHONE)).filter((phone) => phone.length >= 7)
    );

    // The FILER, not the row, is what gets recalled — so every populated
    // OFFICE/DISTRICT across a filer's current-cycle rows must agree with
    // the race: a populated office must denote THIS office, a populated
    // district must normalize to THIS district (statewide races admit none),
    // and junk district values veto too. One conflicting sibling row vetoes
    // the whole filer even when the row under consideration is blank (live:
    // 90 committees carry both blank and populated DISTRICT rows). Rows from
    // other election years do not veto — committees legitimately carried
    // other districts in past cycles.
    const committeeRowsByFilerId = new Map<string, PennsylvaniaCampaignFinanceFilerRow[]>();
    for (const row of input.filerRows) {
      if (row.FILERTYPE.trim() !== "2") {
        continue;
      }
      const filerId = row.FILERID.trim().toUpperCase();
      if (!filerId) {
        continue;
      }
      const rows = committeeRowsByFilerId.get(filerId) ?? [];
      rows.push(row);
      committeeRowsByFilerId.set(filerId, rows);
    }
    // Registration rows in this cycle for ANY other race whose person name
    // matches the candidate: a same-name stranger. While one exists, a
    // blank-OFFICE committee matched by name alone could be theirs.
    const strangerRegistrationExists = input.filerRows.some(
      (row) =>
        row.FILERTYPE.trim() === "1" &&
        rowMatchesElectionYear(row, electionYear) &&
        !rowsByFiler.has(row.FILERID.trim().toUpperCase()) &&
        rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys })
    );
    const filerContextVerdicts = new Map<string, boolean>();
    const filerContextAgreesWithRace = (filerId: string): boolean => {
      const cached = filerContextVerdicts.get(filerId);
      if (cached !== undefined) {
        return cached;
      }
      let agrees = true;
      for (const sibling of committeeRowsByFilerId.get(filerId) ?? []) {
        if (!rowMatchesElectionYear(sibling, electionYear)) {
          continue;
        }
        const siblingOffice = sibling.OFFICE.trim();
        if (siblingOffice && mapPennsylvaniaFinanceOfficeCode(siblingOffice) !== officeSearchInput.paOfficeCode) {
          agrees = false;
          break;
        }
        const siblingDistrict = sibling.DISTRICT.trim();
        if (
          siblingDistrict &&
          (officeSearchInput.district === null ||
            normalizePennsylvaniaFinanceLegislativeDistrict(siblingDistrict, 203) !== officeSearchInput.district)
        ) {
          agrees = false;
          break;
        }
      }
      filerContextVerdicts.set(filerId, agrees);
      return agrees;
    };

    for (const row of input.filerRows) {
      const filerId = row.FILERID.trim().toUpperCase();
      const filerName = row.FILERNAME.trim();
      if (!filerId || !filerName || rowsByFiler.has(filerId)) {
        continue;
      }
      if (row.FILERTYPE.trim() !== "2") {
        continue;
      }
      if (!filerContextAgreesWithRace(filerId)) {
        continue;
      }
      if (!rowMatchesElectionYear(row, electionYear)) {
        continue;
      }
      if (!isLikelyCandidateFiler(row)) {
        continue;
      }
      const fullNameMatch = rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys });
      if (!fullNameMatch && (rivalSurnameRegistration || !committeeMatchesSurnameOnly({ row, surname }))) {
        continue;
      }
      const rowZip = zip5(row.ZIPCODE);
      const rowPhone = phoneDigits(row.PHONE);
      const corroborated =
        (rowZip.length === 5 && registrationZips.has(rowZip)) ||
        (rowPhone.length >= 7 && registrationPhones.has(rowPhone));
      // A committee carrying the candidate's full name ("FRIENDS OF CAMERA
      // BARTOLOTTA") is theirs unless a same-name stranger also registered
      // this cycle; committees in Harrisburg rarely share the candidate's
      // home ZIP or phone. A surname-only committee ("GAYDOS FOR PA") still
      // needs the ZIP or phone corroboration.
      if (!corroborated && !(fullNameMatch && !strangerRegistrationExists)) {
        continue;
      }

      const accumulator = rowsByFiler.get(filerId) ?? {
        filerId,
        filerName,
        filerType: "2",
        rows: [],
      };
      accumulator.rows.push(row);
      rowsByFiler.set(filerId, accumulator);
    }
  }

  if (rowsByFiler.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_filer_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const sourceUrl = input.sourceUrl?.trim() || null;
  const matches = [...rowsByFiler.values()]
    .map((accumulator) => toFilerMatch({ accumulator, sourceUrl }))
    .sort((left, right) => left.filerId.localeCompare(right.filerId));

  if (matches.length === 1) {
    return {
      status: "matched",
      ...matches[0],
    };
  }

  // PA registers the same candidacy twice: a candidate filer (FILERTYPE 1,
  // the person's own registration) and their political committee (FILERTYPE
  // 2). Contribution reports are filed under the committee's filer id, so
  // when the match set is exactly one committee plus candidate registrations
  // for the same office/district/year, the committee is the funded vehicle.
  // Two committees (or two candidate registrations with no committee) stay
  // ambiguous — there is no evidence which vehicle carries the money.
  // PA sometimes carries one committee under two filer ids with the same
  // name ("FRIENDS OF PAT HARKINS" as 2005299 and 8300058). Keep the id that
  // filed the most reports this cycle; the other is a dormant duplicate.
  const committeeMatches = dedupeSameNameCommittees(
    [...rowsByFiler.values()].filter((accumulator) => accumulator.filerType === "2")
  ).map((accumulator) => toFilerMatch({ accumulator, sourceUrl }));
  const candidateMatches = matches.filter((match) => match.filerType === "1");
  if (committeeMatches.length === 1 && candidateMatches.length + committeeMatches.length <= matches.length) {
    return {
      status: "matched",
      ...committeeMatches[0],
    };
  }

  return {
    status: "ambiguous",
    reason: "multiple_matching_filers",
    candidateNameNormalized: candidateNameKey,
    officeNameNormalized,
    matches,
  };
}
