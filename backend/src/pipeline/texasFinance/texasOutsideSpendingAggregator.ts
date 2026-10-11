import { firstNamesConflict } from "../finance/personFirstNameNicknames.js";
import {
  normalizeTexasCandidateNameKeys,
  texasCandidateNameMiddleConflicts,
} from "./texasCandidateCommitteeResolver.js";
import {
  isTexasFinanceEligibleOffice,
  mapTexasTecOfficeCode,
  type TexasFinanceOfficeScope,
} from "./texasFinanceEligibleOffices.js";
import type {
  TexasTecCandidateRow,
  TexasTecExpenditureRow,
  TexasTecSpacRow,
  TexasTecPurposeRow,
} from "./texasTecCsvDatabaseReader.js";

export type TexasSupportOppose = "support" | "oppose";

export type TexasOutsideSpendingGroup = {
  committeeId: string;
  committeeName: string;
  supportOppose: TexasSupportOppose;
  amount: number;
  sourceUrl: string | null;
};

export type TexasOutsideSpendingSummary = {
  supportTotal: number;
  opposeTotal: number;
  groups: TexasOutsideSpendingGroup[];
  sourceUrl: string | null;
};

export type TexasOutsideSpendingAggregationInput = {
  candidateName: string;
  candidateCommitteeId: string;
  candidateCommitteeIds?: readonly string[];
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  candidateRows: readonly TexasTecCandidateRow[];
  expenditureRows: readonly TexasTecExpenditureRow[];
  spacRows: readonly TexasTecSpacRow[];
  purposeRows?: readonly TexasTecPurposeRow[];
  sourceUrl?: string | null;
  maxGroups?: number;
};

export type TexasOutsideSpendingAggregationResult = {
  summary: TexasOutsideSpendingSummary | null;
  // True when includable rows spanned conflicting formal first names and the
  // aggregation refused to attribute any of them. Callers must not persist a
  // zeroed snapshot over previously stored data in this case.
  firstNameConflict: boolean;
  matchedCandidateExpenditureRowCount: number;
  includedCandidateExpenditureRowCount: number;
  skippedCandidateExpenditureRowCount: number;
};

type SpacRelationship = {
  committeeId: string;
  committeeName: string;
  supportOppose: TexasSupportOppose;
};

type GroupAccumulator = {
  committeeId: string;
  committeeName: string;
  supportOppose: TexasSupportOppose;
  amountCents: number;
};

const DEFAULT_MAX_GROUPS = 50;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2014 || value > 2100) {
    throw new Error(`Invalid Texas outside spending aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Texas outside spending aggregation ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
}

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

function normalizeDistrict(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return String(numeric);
  }
  return normalizeTextKey(trimmed);
}

function canonicalOfficeNameForInput(officeName: string): string | null {
  switch (normalizeTextKey(officeName)) {
    case "GOVERNOR":
      return "Governor";
    case "LIEUTENANT GOVERNOR":
    case "LT GOVERNOR":
      return "Lieutenant Governor";
    case "ATTORNEY GENERAL":
      return "Attorney General";
    case "COMPTROLLER":
    case "COMPTROLLER PUBLIC ACCOUNTS":
      return "Comptroller";
    case "AGRICULTURE COMMISSIONER":
    case "COMMISSIONER AGRICULTURE":
      return "Agriculture Commissioner";
    case "LAND COMMISSIONER":
    case "COMMISSIONER GENERAL LAND OFFICE":
      return "Land Commissioner";
    case "RAILROAD COMMISSIONER":
    case "RAILROAD COMMISSION":
      return "Railroad Commissioner";
    case "STATE SENATOR":
    case "STATE SENATE":
      return "State Senator";
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "State Lower Chamber Legislator";
    default:
      return null;
  }
}

function normalizeOfficeScope(value: string): TexasFinanceOfficeScope | null {
  const normalized = value.trim();
  return normalized === "statewide" || normalized === "state_upper" || normalized === "state_lower"
    ? normalized
    : null;
}

function isLegislativeOffice(officeScope: TexasFinanceOfficeScope, officeCanonicalName: string): boolean {
  return (
    (officeScope === "state_upper" && officeCanonicalName === "State Senator") ||
    (officeScope === "state_lower" && officeCanonicalName === "State Lower Chamber Legislator")
  );
}

function rowOfficeMatches(input: {
  officeCode: string;
  officeDescription: string;
  district: string;
  officeScope: TexasFinanceOfficeScope;
  officeCanonicalName: string;
  expectedDistrict: string;
}): boolean {
  const mapping = mapTexasTecOfficeCode({ officeCode: input.officeCode });
  if (mapping) {
    if (mapping.officeScope !== input.officeScope || mapping.officeCanonicalName !== input.officeCanonicalName) {
      return false;
    }
  } else if (
    (input.officeCode.trim() && normalizeId(input.officeCode) !== "OTHER") ||
    canonicalOfficeNameForInput(input.officeDescription) !== input.officeCanonicalName
  ) {
    return false;
  }

  if (isLegislativeOffice(input.officeScope, input.officeCanonicalName)) {
    return normalizeDistrict(input.district) === input.expectedDistrict;
  }
  return true;
}

function parseAmountCents(raw: string): number | null {
  const normalized = raw.replace(/[$,]/g, "").trim();
  if (normalized.length === 0 || !/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) {
    return null;
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function parseTexasTecDate(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  const parts = /^(\d{4})(\d{2})(\d{2})$/.exec(value) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!parts && !slash) return null;
  const year = Number(parts?.[1] ?? slash?.[3]);
  const month = Number(parts?.[2] ?? slash?.[1]);
  const day = Number(parts?.[3] ?? slash?.[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function isCycleDate(date: string, electionYear: number): boolean {
  const year = Number(date.slice(0, 4));
  return year >= electionYear - 1 && year <= electionYear;
}

export function supportOpposeFromTexasSpacPosition(value: string): TexasSupportOppose | null {
  const normalized = normalizeTextKey(value);
  if (normalized === "SUPPORT" || normalized === "SUPPORTED") {
    return "support";
  }
  if (normalized === "OPPOSE" || normalized === "OPPOSED") {
    return "oppose";
  }
  return null;
}

function isCurrent(row: { infoOnlyFlag?: string }): boolean {
  // TEC explicitly marks current rows N and superseded reports Y.
  return row.infoOnlyFlag?.trim().toUpperCase() === "N";
}

function isRegularPoliticalExpense(row: { formTypeCd?: string; schedFormTypeCd?: string; politicalExpendCd?: string }): boolean {
  const form = row.formTypeCd?.trim().toUpperCase() ?? "";
  const schedule = row.schedFormTypeCd?.trim().toUpperCase() ?? "";
  return !form.startsWith("DAILY") && form !== "DIRE" && ["F1", "G"].includes(schedule) &&
    row.politicalExpendCd?.trim().toUpperCase() !== "N";
}

function isContributionExpense(row: { expendCatCd?: string; expendDescr?: string }): boolean {
  return row.expendCatCd?.trim().toUpperCase() === "DONATIONS" ||
    /^(?:IN[ -]KIND\s+)?(?:CAMPAIGN\s+|POLITICAL\s+)?(?:CONTRIBUTION|DONATION)S?\b/i.test(row.expendDescr?.trim() ?? "");
}

function candidateRowFirstNameToken(row: TexasTecCandidateRow): string | null {
  const token = normalizeTextKey(row.candidateNameFirst).split(" ")[0] ?? "";
  return token.length > 0 ? token : null;
}

// Purpose rows naming two conflicting first names (PATRICK and PATRICIA)
// are positive evidence that the nickname-expanded key set caught two
// distinct people; refuse the whole aggregation rather than pick a side,
// mirroring the committee resolver's both-families-filed rule. Only rows
// whose amounts would actually be included are consulted — a row that
// cannot contribute money (unrelated spender, missing or info-only
// expenditure, bad amount, wrong cycle) cannot mis-attribute it either, and
// must not zero out valid totals. Formal spellings of one name
// (STEPHEN/STEVEN) do not conflict.
function matchedRowsSpanConflictingFirstNames(rows: readonly TexasTecCandidateRow[]): boolean {
  const seen: string[] = [];
  for (const row of rows) {
    const token = candidateRowFirstNameToken(row);
    if (!token || seen.includes(token)) {
      continue;
    }
    if (seen.some((existing) => firstNamesConflict(existing, token))) {
      return true;
    }
    seen.push(token);
  }
  return false;
}

function candidateRowPersonName(row: TexasTecCandidateRow): string {
  return [row.candidateNameFirst, row.candidateNameLast].filter(Boolean).join(" ");
}

function candidateRowNameKeys(row: TexasTecCandidateRow): Set<string> {
  const keys = new Set<string>();
  for (const key of normalizeTexasCandidateNameKeys(candidateRowPersonName(row))) {
    keys.add(key);
  }
  for (const key of normalizeTexasCandidateNameKeys(row.candidateNameOrganization)) {
    keys.add(key);
  }
  return keys;
}

function candidateRowMatchesTarget(input: {
  row: TexasTecCandidateRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
  officeScope: TexasFinanceOfficeScope;
  officeCanonicalName: string;
  expectedDistrict: string;
}): boolean {
  let nameMatches = false;
  for (const key of candidateRowNameKeys(input.row)) {
    if (input.candidateNameKeys.has(key)) {
      nameMatches = true;
      break;
    }
  }
  if (!nameMatches) {
    return false;
  }
  // TEC has no middle-name column, but filers routinely type one into the
  // first-name field ("MARY LOU"), and the key set collapses to first+last.
  // A contradicting middle name rejects the row.
  if (
    texasCandidateNameMiddleConflicts({
      candidateName: input.candidateName,
      rowNames: [candidateRowPersonName(input.row)],
    })
  ) {
    return false;
  }
  return rowOfficeMatches({
    officeCode: input.row.candidateSeekOfficeCd,
    officeDescription: input.row.candidateSeekOfficeDescr,
    district: input.row.candidateSeekOfficeDistrict,
    officeScope: input.officeScope,
    officeCanonicalName: input.officeCanonicalName,
    expectedDistrict: input.expectedDistrict,
  });
}

function spacRowMatchesTarget(input: {
  row: TexasTecSpacRow;
  candidateCommitteeId: string;
  officeScope: TexasFinanceOfficeScope;
  officeCanonicalName: string;
  expectedDistrict: string;
}): boolean {
  if (normalizeId(input.row.candidateFilerIdent) !== input.candidateCommitteeId) {
    return false;
  }
  const candidateFilerType = normalizeTextKey(input.row.candidateFilerTypeCd);
  if (candidateFilerType && candidateFilerType !== "COH") {
    return false;
  }
  return rowOfficeMatches({
    officeCode: input.row.candidateSeekOfficeCd,
    officeDescription: input.row.candidateSeekOfficeDescr,
    district: input.row.candidateSeekOfficeDistrict,
    officeScope: input.officeScope,
    officeCanonicalName: input.officeCanonicalName,
    expectedDistrict: input.expectedDistrict,
  });
}

function reportKey(row: { filerIdent: string; reportInfoIdent?: string }): string {
  return `${normalizeId(row.filerIdent)}\u0000${normalizeId(row.reportInfoIdent ?? "")}`;
}

function expenditureKey(row: { filerIdent: string; reportInfoIdent?: string; expendInfoId: string }): string {
  return `${reportKey(row)}\u0000${normalizeId(row.expendInfoId)}`;
}

function beneficiaryKey(row: TexasTecCandidateRow): string {
  // Do not count two repeated links to the same person as two beneficiaries.
  // Full source names stay literal: unrelated, unlinked people still count.
  return JSON.stringify([
    normalizeTextKey(candidateRowPersonName(row)), normalizeTextKey(row.candidateNameOrganization),
    normalizeId(row.candidateSeekOfficeCd), normalizeTextKey(row.candidateSeekOfficeDescr),
    normalizeDistrict(row.candidateSeekOfficeDistrict), normalizeTextKey(row.candidateSeekOfficePlace),
    normalizeTextKey(row.candidateSeekOfficeCountyCd), normalizeTextKey(row.candidateSeekOfficeCountyDescr),
  ]);
}

function namesIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((key) => right.has(key));
}

function purposeDirection(input: {
  row: TexasTecCandidateRow;
  purposeRows: readonly TexasTecPurposeRow[];
  candidateName: string;
  officeScope: TexasFinanceOfficeScope;
  officeCanonicalName: string;
  expectedDistrict: string;
  electionYear: number;
}): { present: boolean; direction: TexasSupportOppose | null } {
  const names = candidateRowNameKeys(input.row);
  let present = false;
  let direction: TexasSupportOppose | null = null;
  let blocked = false;
  for (const purpose of input.purposeRows) {
    if (!isCurrent(purpose) || reportKey(purpose) !== reportKey(input.row) ||
      normalizeId(purpose.subjectCategoryCd) !== "CANDIDATE" ||
      !namesIntersect(names, normalizeTexasCandidateNameKeys(purpose.commActivityName)) ||
      texasCandidateNameMiddleConflicts({ candidateName: input.candidateName, rowNames: [purpose.commActivityName] }) ||
      texasCandidateNameMiddleConflicts({ candidateName: candidateRowPersonName(input.row), rowNames: [purpose.commActivityName] }) ||
      !rowOfficeMatches({ officeCode: purpose.activitySeekOfficeCd, officeDescription: purpose.activitySeekOfficeDescr,
        district: purpose.activitySeekOfficeDistrict, ...input })) continue;
    present = true;
    if (normalizeId(purpose.filerTypeCd) !== normalizeId(input.row.filerTypeCd)) {
      throw new Error(`Conflicting Texas PURPOSE/CAND filer types for ${reportKey(purpose)}`);
    }
    if (purpose.subjectElectionDt.trim()) {
      const date = parseTexasTecDate(purpose.subjectElectionDt);
      if (!date) throw new Error(`Invalid Texas PURPOSE election date for ${reportKey(purpose)}`);
      if (Number(date.slice(0, 4)) !== input.electionYear) continue;
    }
    const position = normalizeId(purpose.subjectPositionCd);
    const next = position === "SUPPORT" ? "support" : position === "OPPOSE" ? "oppose" : null;
    // ASSIST/unknown declarations cannot be turned into support by a SPAC fallback.
    if (!next) { blocked = true; continue; }
    if (direction && direction !== next) throw new Error(`Conflicting Texas PURPOSE directions for ${reportKey(purpose)}`);
    direction = next;
  }
  return { present, direction: blocked ? null : direction };
}

function expenditureEconomics(row: TexasTecExpenditureRow): string {
  return JSON.stringify([
    parseTexasTecDate(row.expendDt), parseAmountCents(row.expendAmount),
    row.schedFormTypeCd.trim().toUpperCase(), row.expendCatCd.trim().toUpperCase(), row.expendDescr.trim(),
    row.politicalExpendCd.trim().toUpperCase(), row.payeePersentTypeCd.trim().toUpperCase(),
    row.payeeNameOrganization.trim(), row.payeeNameFirst.trim(), row.payeeNameLast.trim(),
  ]);
}

function groupKey(input: { committeeId: string; supportOppose: TexasSupportOppose }): string {
  return `${input.committeeId}\u0000${input.supportOppose}`;
}

function buildSpacRelationships(input: {
  candidateCommitteeId: string;
  officeScope: TexasFinanceOfficeScope;
  officeCanonicalName: string;
  expectedDistrict: string;
  spacRows: readonly TexasTecSpacRow[];
}): Map<string, SpacRelationship | null> {
  const relationships = new Map<string, SpacRelationship | null>();
  for (const row of input.spacRows) {
    if (!spacRowMatchesTarget({ row, ...input })) {
      continue;
    }
    const committeeId = normalizeId(row.spacFilerIdent);
    const committeeName = row.spacFilerName.trim();
    const supportOppose = supportOpposeFromTexasSpacPosition(row.spacPositionCd);
    if (!committeeId || !committeeName || !supportOppose) {
      continue;
    }

    const existing = relationships.get(committeeId);
    if (existing === null) {
      continue;
    }
    if (existing && existing.supportOppose !== supportOppose) {
      relationships.set(committeeId, null);
      continue;
    }
    relationships.set(committeeId, {
      committeeId,
      committeeName,
      supportOppose,
    });
  }
  return relationships;
}

function toGroups(input: {
  groups: Iterable<GroupAccumulator>;
  maxGroups: number;
  sourceUrl: string | null;
}): TexasOutsideSpendingGroup[] {
  return [...input.groups]
    .sort(
      (left, right) =>
        right.amountCents - left.amountCents ||
        left.supportOppose.localeCompare(right.supportOppose) ||
        left.committeeName.localeCompare(right.committeeName)
    )
    .slice(0, input.maxGroups)
    .map((group) => ({
      committeeId: group.committeeId,
      committeeName: group.committeeName,
      supportOppose: group.supportOppose,
      amount: centsToDollars(group.amountCents),
      sourceUrl: input.sourceUrl,
    }));
}

export function aggregateTexasOutsideSpending(
  input: TexasOutsideSpendingAggregationInput
): TexasOutsideSpendingAggregationResult {
  const candidateCommitteeId = normalizeId(requireNonEmpty(input.candidateCommitteeId, "Texas candidate committee id"));
  // VoteApp alone expands nicknames. CAND and PURPOSE source names must
  // corroborate each other, and conflicting includable formal names abort.
  const candidateNameKeys = normalizeTexasCandidateNameKeys(input.candidateName, { expandNicknames: true });
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxGroups = normalizePositiveInteger(input.maxGroups, DEFAULT_MAX_GROUPS, "maxGroups");
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const expectedDistrict = normalizeDistrict(input.district);
  if (candidateNameKeys.size === 0) {
    return {
      summary: null,
      firstNameConflict: false,
      matchedCandidateExpenditureRowCount: 0,
      includedCandidateExpenditureRowCount: 0,
      skippedCandidateExpenditureRowCount: 0,
    };
  }
  if (!officeScope || !officeCanonicalName || !isTexasFinanceEligibleOffice({ officeScope, officeCanonicalName })) {
    throw new Error(`Unsupported Texas outside spending office: ${input.officeScope} ${input.officeName}`);
  }
  if (isLegislativeOffice(officeScope, officeCanonicalName) && !expectedDistrict) {
    throw new Error(`Texas outside spending district is required for ${officeCanonicalName}`);
  }

  const relationships = buildSpacRelationships({
    candidateCommitteeId,
    officeScope,
    officeCanonicalName,
    expectedDistrict,
    spacRows: input.spacRows,
  });
  const selfCommitteeIds = new Set([candidateCommitteeId, ...(input.candidateCommitteeIds ?? []).map(normalizeId)]);
  const expendituresByKey = new Map<string, TexasTecExpenditureRow[]>();
  const currentReportsByExpense = new Map<string, Set<string>>();
  for (const row of input.expenditureRows) {
    if (!isCurrent(row)) continue;
    const key = expenditureKey(row);
    const sourceExpenseKey = `${normalizeId(row.filerIdent)}\u0000${normalizeId(row.expendInfoId)}`;
    const reports = currentReportsByExpense.get(sourceExpenseKey) ?? new Set<string>();
    reports.add(normalizeId(row.reportInfoIdent));
    currentReportsByExpense.set(sourceExpenseKey, reports);
    const existing = expendituresByKey.get(key) ?? [];
    existing.push(row);
    expendituresByKey.set(key, existing);
  }
  const beneficiariesByExpense = new Map<string, Set<string>>();
  for (const row of input.candidateRows) {
    if (!isCurrent(row)) continue;
    const key = expenditureKey(row);
    const identities = beneficiariesByExpense.get(key) ?? new Set<string>();
    identities.add(beneficiaryKey(row));
    beneficiariesByExpense.set(key, identities);
  }
  const purposesByReport = new Map<string, TexasTecPurposeRow[]>();
  for (const row of input.purposeRows ?? []) {
    if (!isCurrent(row)) continue;
    const key = reportKey(row);
    const rows = purposesByReport.get(key) ?? [];
    rows.push(row);
    purposesByReport.set(key, rows);
  }

  const matchedRows = input.candidateRows.filter((row) =>
    isCurrent(row) && candidateRowMatchesTarget({
      row, candidateName: input.candidateName, candidateNameKeys, officeScope, officeCanonicalName, expectedDistrict,
    })
  );
  const matchedCandidateExpenditureRowCount = matchedRows.length;
  const includableRows: { row: TexasTecCandidateRow; relationship: SpacRelationship; amountCents: number }[] = [];
  let skippedCandidateExpenditureRowCount = 0;
  const seenExpenses = new Set<string>();
  for (const row of matchedRows) {
    const committeeId = normalizeId(row.filerIdent);
    const expenseKey = expenditureKey(row);
    if (!committeeId || selfCommitteeIds.has(committeeId) || !isRegularPoliticalExpense(row) || isContributionExpense(row) ||
      (beneficiariesByExpense.get(expenseKey)?.size ?? 0) !== 1) {
      skippedCandidateExpenditureRowCount += 1;
      continue;
    }
    const candidateDate = parseTexasTecDate(row.expendDt);
    if (!candidateDate) throw new Error(`Invalid Texas candidate expenditure date for ${expenseKey}`);
    if (!isCycleDate(candidateDate, electionYear)) {
      skippedCandidateExpenditureRowCount += 1;
      continue;
    }
    const spac = relationships.get(committeeId);
    const purpose = purposeDirection({ row, purposeRows: purposesByReport.get(reportKey(row)) ?? [],
      candidateName: input.candidateName, officeScope, officeCanonicalName, expectedDistrict, electionYear });
    const filerType = normalizeId(row.filerTypeCd);
    const direction = purpose.present ? purpose.direction : ["SPAC", "JSPC", "SCPC"].includes(filerType) ? spac?.supportOppose : null;
    if (!direction || !["GPAC", "MPAC", "SPAC", "JSPC", "SCPC"].includes(filerType)) {
      skippedCandidateExpenditureRowCount += 1;
      continue;
    }
    if (purpose.present && (spac === null || (spac && spac.supportOppose !== direction))) {
      throw new Error(`Conflicting Texas PURPOSE/SPAC directions for ${reportKey(row)}`);
    }
    if (!row.reportInfoIdent?.trim() || !row.expendInfoId.trim()) {
      throw new Error("Texas current expenditure report and expense identifiers are required");
    }
    const joined = expendituresByKey.get(expenseKey);
    const expenditure = joined?.[0];
    if (!expenditure) {
      throw new Error(`Missing current Texas EXPN join for applicable CAND ${expenseKey}`);
    }
    if (joined!.some((other) => expenditureEconomics(other) !== expenditureEconomics(expenditure))) {
      throw new Error(`Conflicting current Texas expenditure rows for ${expenseKey}`);
    }
    const date = parseTexasTecDate(expenditure.expendDt);
    const amountCents = parseAmountCents(expenditure.expendAmount);
    if (!date) throw new Error(`Invalid Texas expenditure date for ${expenseKey}`);
    if (amountCents === null) throw new Error(`Invalid Texas expenditure amount for ${expenseKey}`);
    if (candidateDate !== date || parseAmountCents(row.expendAmount) !== amountCents) {
      throw new Error(`Conflicting Texas CAND/EXPN economics for ${expenseKey}`);
    }
    if (normalizeId(expenditure.filerTypeCd) !== filerType) {
      throw new Error(`Conflicting Texas CAND/EXPN filer types for ${expenseKey}`);
    }
    if (!isRegularPoliticalExpense(expenditure) || isContributionExpense(expenditure) || amountCents <= 0) {
      skippedCandidateExpenditureRowCount += 1;
      continue;
    }
    if ((currentReportsByExpense.get(`${committeeId}\u0000${normalizeId(row.expendInfoId)}`)?.size ?? 0) > 1) {
      throw new Error(`Conflicting current Texas reports for expense ${committeeId}/${row.expendInfoId}`);
    }
    const payee = [expenditure.payeeNameFirst, expenditure.payeeNameLast].filter(Boolean).join(" ");
    const payeeNames = new Set([...normalizeTexasCandidateNameKeys(payee),
      ...normalizeTexasCandidateNameKeys(expenditure.payeeNameOrganization)]);
    if (namesIntersect(candidateNameKeys, payeeNames) &&
      !texasCandidateNameMiddleConflicts({ candidateName: input.candidateName, rowNames: [payee, expenditure.payeeNameOrganization] })) {
      skippedCandidateExpenditureRowCount += 1;
      continue;
    }
    if (seenExpenses.has(expenseKey)) {
      skippedCandidateExpenditureRowCount += 1;
      continue;
    }
    seenExpenses.add(expenseKey);
    includableRows.push({ row, relationship: { committeeId, committeeName: requireNonEmpty(spac?.committeeName ?? row.filerName, "Texas outside spender name"),
      supportOppose: direction }, amountCents });
  }

  if (matchedRowsSpanConflictingFirstNames(includableRows.map((entry) => entry.row))) {
    return {
      summary: null,
      firstNameConflict: true,
      matchedCandidateExpenditureRowCount,
      includedCandidateExpenditureRowCount: 0,
      skippedCandidateExpenditureRowCount: matchedCandidateExpenditureRowCount,
    };
  }

  const groups = new Map<string, GroupAccumulator>();
  let supportTotalCents = 0;
  let opposeTotalCents = 0;
  let includedCandidateExpenditureRowCount = 0;

  for (const { relationship, amountCents } of includableRows) {
    includedCandidateExpenditureRowCount += 1;
    if (relationship.supportOppose === "support") {
      supportTotalCents += amountCents;
    } else {
      opposeTotalCents += amountCents;
    }

    const key = groupKey({ committeeId: relationship.committeeId, supportOppose: relationship.supportOppose });
    const existing = groups.get(key);
    if (existing) {
      existing.amountCents += amountCents;
      continue;
    }
    groups.set(key, {
      committeeId: relationship.committeeId,
      committeeName: relationship.committeeName,
      supportOppose: relationship.supportOppose,
      amountCents,
    });
  }

  const grouped = toGroups({
    groups: groups.values(),
    maxGroups,
    sourceUrl: input.sourceUrl ?? null,
  });
  if (grouped.length === 0) {
    return {
      summary: null,
      firstNameConflict: false,
      matchedCandidateExpenditureRowCount,
      includedCandidateExpenditureRowCount,
      skippedCandidateExpenditureRowCount,
    };
  }

  return {
    summary: {
      supportTotal: centsToDollars(supportTotalCents),
      opposeTotal: centsToDollars(opposeTotalCents),
      groups: grouped,
      sourceUrl: input.sourceUrl ?? null,
    },
    firstNameConflict: false,
    matchedCandidateExpenditureRowCount,
    includedCandidateExpenditureRowCount,
    skippedCandidateExpenditureRowCount,
  };
}
