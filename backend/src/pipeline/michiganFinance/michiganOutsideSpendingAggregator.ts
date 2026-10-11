import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import { normalizeMichiganCandidateNameKeys, normalizePersonName } from "./michiganCandidateCommitteeResolver.js";
import { type MichiganMitnOfficeSearchInput, toMichiganMitnOfficeSearchInput } from "./michiganFinanceEligibleOffices.js";
import { normalizeMichiganMitnLegacyArchiveYear } from "./michiganMitnLegacyRowTypes.js";
import type { MichiganMitnLegacyExpenditureRow } from "./michiganMitnLegacyRowTypes.js";

export type MichiganSupportOppose = "support" | "oppose";

export type MichiganOutsideSpendingGroup = {
  committeeId: string;
  committeeName: string;
  supportOppose: MichiganSupportOppose;
  amount: number;
  sourceUrl: string | null;
};

export type MichiganOutsideSpendingSummary = {
  supportTotal: number;
  opposeTotal: number;
  groups: MichiganOutsideSpendingGroup[];
  sourceUrl: string | null;
};

export type MichiganOutsideSpendingAggregationInput = {
  candidateName: string;
  /** Exact unique candidate-registry match verified by the batch. */
  targetCommitteeName?: string;
  targetCommitteeNames?: readonly string[];
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  expenditureRows: readonly MichiganMitnLegacyExpenditureRow[];
  sourceUrl?: string | null;
  maxGroups?: number;
};

export type MichiganOutsideSpendingAggregationResult = {
  summary: MichiganOutsideSpendingSummary | null;
  matchedExpenditureRowCount: number;
  includedExpenditureRowCount: number;
  skippedExpenditureRowCount: number;
};

type GroupAccumulator = {
  committeeId: string;
  committeeName: string;
  supportOppose: MichiganSupportOppose;
  amountCents: number;
};

const DEFAULT_MAX_GROUPS = 50;

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Michigan outside spending aggregation ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, "") : normalized;
}

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmountCents(raw: string): number | null {
  const normalized = raw.replace(/[$,]/g, "").trim();
  if (!normalized || !/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) {
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

function parseStatementYear(raw: string): number | null {
  const normalized = raw.trim();
  if (!/^\d{4}$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function isCycleStatementYear(input: { rawYear: string; electionYear: number }): boolean {
  const year = parseStatementYear(input.rawYear);
  return year !== null && year >= input.electionYear - 1 && year <= input.electionYear;
}

export function isMichiganIndependentExpenditureSchedule(value: string): boolean {
  const normalized = normalizeTextKey(value);
  return (
    /\bINDEPENDENT\b/.test(normalized) ||
    // The official MiTN legacy expenditure CSV truncates this schedule code to INDEPENDEN.
    /\bINDEPENDEN\b/.test(normalized)
  );
}

export function supportOpposeFromMichiganSuppOpp(value: string): MichiganSupportOppose | null {
  const normalized = normalizeTextKey(value);
  if (["1", "S", "SUPPORT", "SUPPORTED", "FOR"].includes(normalized)) {
    return "support";
  }
  if (["2", "O", "OPPOSE", "OPPOSED", "AGAINST"].includes(normalized)) {
    return "oppose";
  }
  return null;
}

function targetMatchesCandidate(input: {
  canOrBallot: string;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const targetKeys = normalizeMichiganCandidateNameKeys(input.canOrBallot);
  if (targetKeys.size === 0) {
    return false;
  }
  let keyMatched = false;
  for (const key of targetKeys) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses the expenditure target to first+last, so spending
  // aimed at "WHITMER, GRETCHEN B" would be credited to a "Gretchen A.
  // Whitmer" in the same race. A contradicting middle name rejects the row.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [input.canOrBallot],
    normalizePersonName,
  });
}

function targetOfficeText(row: MichiganMitnLegacyExpenditureRow): string {
  const record = row as Record<string, string>;
  return normalizeTextKey(
    [
      record._column_29,
      record.office,
      record.office_name,
      record.office_desc,
      record.office_sought,
      record.county,
      record.extra_desc,
      record.purpose,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function officeAliasesForSearchInput(officeSearchInput: MichiganMitnOfficeSearchInput): string[] {
  switch (officeSearchInput.mitnOffice) {
    case "State Senate":
      return ["STATE SENATE", "SENATE", "SENATOR"];
    case "State House":
      return ["STATE HOUSE", "HOUSE", "REPRESENTATIVE"];
    default:
      return [officeSearchInput.mitnOffice.toUpperCase()];
  }
}

function districtAliasesForSearchInput(officeSearchInput: MichiganMitnOfficeSearchInput): string[] {
  if (!officeSearchInput.district) {
    return [];
  }
  const district = officeSearchInput.district.replace(/^0+/, "");
  if (officeSearchInput.mitnOffice === "State Senate") {
    return [`STATE SENATE ${district}`, `SENATE DISTRICT ${district}`, `SENATE ${district}`, `SD ${district}`];
  }
  return [`STATE HOUSE ${district}`, `HOUSE DISTRICT ${district}`, `HOUSE ${district}`, `HD ${district}`];
}

function rowMatchesOfficeContext(input: {
  row: MichiganMitnLegacyExpenditureRow;
  officeSearchInput: MichiganMitnOfficeSearchInput;
}): boolean {
  const text = targetOfficeText(input.row);
  if (!text) {
    return false;
  }
  if (!officeAliasesForSearchInput(input.officeSearchInput).some((alias) => text.includes(normalizeTextKey(alias)))) {
    return false;
  }
  const districtAliases = districtAliasesForSearchInput(input.officeSearchInput);
  return districtAliases.length === 0 || districtAliases.some((alias) => text.includes(normalizeTextKey(alias)));
}

function groupKey(input: { committeeId: string; supportOppose: MichiganSupportOppose }): string {
  return `${input.committeeId}\u0000${input.supportOppose}`;
}

function toGroups(input: {
  groups: Iterable<GroupAccumulator>;
  maxGroups: number;
  sourceUrl: string | null;
}): MichiganOutsideSpendingGroup[] {
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

export function aggregateMichiganOutsideSpending(
  input: MichiganOutsideSpendingAggregationInput
): MichiganOutsideSpendingAggregationResult {
  const electionYear = normalizeMichiganMitnLegacyArchiveYear(input.electionYear);
  const maxGroups = normalizePositiveInteger(input.maxGroups, DEFAULT_MAX_GROUPS, "maxGroups");
  const officeSearchInput = toMichiganMitnOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  const candidateNameKeys = normalizeMichiganCandidateNameKeys(input.candidateName);
  if (!officeSearchInput || candidateNameKeys.size === 0) {
    return {
      summary: null,
      matchedExpenditureRowCount: 0,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 0,
    };
  }

  const groups = new Map<string, GroupAccumulator>();
  let supportTotalCents = 0;
  let opposeTotalCents = 0;
  let matchedExpenditureRowCount = 0;
  let includedExpenditureRowCount = 0;
  let skippedExpenditureRowCount = 0;

  for (const row of input.expenditureRows) {
    const modernTarget = row.target_committee_name;
    const targetMatches = modernTarget !== undefined
      ? [...(input.targetCommitteeNames ?? []), ...(input.targetCommitteeName ? [input.targetCommitteeName] : [])]
        .some((name) => normalizeTextKey(modernTarget) === normalizeTextKey(name))
      : targetMatchesCandidate({ canOrBallot: row.can_or_ballot, candidateName: input.candidateName, candidateNameKeys });
    if (!targetMatches) {
      continue;
    }
    matchedExpenditureRowCount += 1;
    // Modern exports identify a unique candidate committee plus an explicit
    // office. The trusted registry/link resolves the district; no district is
    // inferred from a person-name or free-text purpose match.
    const officeMatches = modernTarget !== undefined
      ? row.target_office === officeSearchInput.mitnOffice
      : rowMatchesOfficeContext({ row, officeSearchInput });
    if (!officeMatches) {
      skippedExpenditureRowCount += 1;
      continue;
    }

    const committeeId = normalizeId(row.cfr_com_id);
    const committeeName = row.com_legal_name.trim() || row.common_name.trim();
    const supportOppose = supportOpposeFromMichiganSuppOpp(row.supp_opp);
    const amountCents = parseAmountCents(row.amount);
    if (
      !committeeId ||
      !committeeName ||
      !supportOppose ||
      amountCents === null ||
      amountCents <= 0 ||
      !isMichiganIndependentExpenditureSchedule(row.schedule_desc) ||
      !isCycleStatementYear({ rawYear: row.doc_stmnt_year, electionYear })
    ) {
      skippedExpenditureRowCount += 1;
      continue;
    }

    includedExpenditureRowCount += 1;
    if (supportOppose === "support") {
      supportTotalCents += amountCents;
    } else {
      opposeTotalCents += amountCents;
    }

    const key = groupKey({ committeeId, supportOppose });
    const existing = groups.get(key);
    if (existing) {
      existing.amountCents += amountCents;
      continue;
    }
    groups.set(key, {
      committeeId,
      committeeName,
      supportOppose,
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
      matchedExpenditureRowCount,
      includedExpenditureRowCount,
      skippedExpenditureRowCount,
    };
  }

  return {
    summary: {
      supportTotal: centsToDollars(supportTotalCents),
      opposeTotal: centsToDollars(opposeTotalCents),
      groups: grouped,
      sourceUrl: input.sourceUrl ?? null,
    },
    matchedExpenditureRowCount,
    includedExpenditureRowCount,
    skippedExpenditureRowCount,
  };
}
