import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import { parseMarylandCfsMoney, type MarylandCfsExpenditureRow } from "./marylandCfsArtifactReader.js";
import { normalizeMarylandCandidateNameKeys } from "./marylandCandidateCommitteeResolver.js";
import type { MarylandFinanceOutsideGroupInput, MarylandFinanceSupportOppose } from "./marylandFinanceWriter.js";

export type MarylandOutsideSpendingSummary = {
  supportTotal: number;
  opposeTotal: number;
  groups: MarylandFinanceOutsideGroupInput[];
  sourceUrl: string | null;
};

export type MarylandOutsideSpendingAggregationInput = {
  candidateName: string;
  officeName: string;
  electionYear: number;
  expenditureRows: readonly MarylandCfsExpenditureRow[];
  sourceUrl?: string | null;
  maxGroups?: number;
};

export type MarylandOutsideSpendingAggregationResult = {
  summary: MarylandOutsideSpendingSummary | null;
  matchedExpenditureRowCount: number;
  includedExpenditureRowCount: number;
  skippedExpenditureRowCount: number;
};

type GroupAccumulator = {
  committeeId: string;
  committeeName: string;
  supportOppose: MarylandFinanceSupportOppose;
  amountCents: number;
};

const DEFAULT_MAX_GROUPS = 50;

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Maryland outside spending aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Maryland outside spending aggregation ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeTextKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|OF|FOR|TO|ELECT|COMMITTEE|FRIENDS|CITIZENS)\b/g, " ")
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

function normalizePositionKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmountCents(raw: string): number | null {
  const amount = parseMarylandCfsMoney(raw);
  if (amount === null || !Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function parseMarylandCfsDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
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

function isCycleYear(input: { rawDate: string; electionYear: number }): boolean {
  const year = parseMarylandCfsDateYear(input.rawDate);
  return year !== null && year >= input.electionYear - 1 && year <= input.electionYear;
}

function canonicalOfficeKey(value: string | null | undefined): string {
  switch (normalizeTextKey(value)) {
    case "GOVERNOR":
    case "GOVERNOR LIEUTENANT GOVERNOR":
      return "GOVERNOR";
    case "LIEUTENANT GOVERNOR":
    case "LT GOVERNOR":
      return "LIEUTENANT GOVERNOR";
    case "ATTORNEY GENERAL":
      return "ATTORNEY GENERAL";
    case "COMPTROLLER":
    case "STATE COMPTROLLER":
      return "COMPTROLLER";
    case "STATE SENATOR":
    case "STATE SENATE":
    case "SENATE":
      return "STATE SENATOR";
    case "HOUSE DELEGATES":
    case "HOUSE DELEGATE":
    case "STATE DELEGATE":
    case "STATE REPRESENTATIVE":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "STATE DELEGATE";
    default:
      return normalizeTextKey(value);
  }
}

function officeMatches(input: { rowOfficeName: string; officeName: string }): boolean {
  const rowOfficeKey = canonicalOfficeKey(input.rowOfficeName);
  const inputOfficeKey = canonicalOfficeKey(input.officeName);
  if (!rowOfficeKey || !inputOfficeKey) {
    return false;
  }
  if (inputOfficeKey === "LIEUTENANT GOVERNOR" && rowOfficeKey === "GOVERNOR") {
    return true;
  }
  return rowOfficeKey === inputOfficeKey;
}

function targetMatchesCandidate(input: {
  candidateBallotIssue: string;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  // Registry-name normalization is useful for discovering a receiver, but a
  // committee label is not independent evidence of its candidate's identity.
  // Keep these targets unresolved until an exact source-account bridge exists.
  if (/\b(?:COMMITTEE|FRIENDS|CITIZENS|FOR|ELECT|PAC)\b/.test(normalizePositionKey(input.candidateBallotIssue))) {
    return false;
  }
  const targetKeys = normalizeMarylandCandidateNameKeys(input.candidateBallotIssue);
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
  // Key overlap collapses names to first+last, so outside spending targeting
  // "John B. Smith" would be attributed to "John A. Smith" in the same race.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [input.candidateBallotIssue],
    normalizePersonName,
  });
}

function supportOpposeFromPosition(value: string): MarylandFinanceSupportOppose | null {
  const normalized = normalizePositionKey(value);
  if (normalized === "SUPPORT" || normalized === "SUPPORTED" || normalized === "FOR" || normalized === "IN SUPPORT") {
    return "support";
  }
  if (normalized === "OPPOSE" || normalized === "OPPOSED" || normalized === "AGAINST" || normalized === "IN OPPOSITION") {
    return "oppose";
  }
  return null;
}

function isCandidateCommitteeType(value: string): boolean {
  const committeeType = normalizeTextKey(value);
  return (
    committeeType === "CANDIDATE" ||
    committeeType === "CANDIDATE COMMITTEE" ||
    committeeType === "PUBLIC FINANCING" ||
    committeeType === "PUBLIC FINANCING COMMITTEE"
  );
}

function expenditureAmountCents(row: MarylandCfsExpenditureRow): number | null {
  const appliedAmountCents = parseAmountCents(row["Amount Applied"]);
  if (appliedAmountCents !== null && appliedAmountCents > 0) {
    return appliedAmountCents;
  }
  return parseAmountCents(row["Transaction Amount"]);
}

function groupKey(input: { committeeId: string; supportOppose: MarylandFinanceSupportOppose }): string {
  return `${normalizeId(input.committeeId)}\u0000${input.supportOppose}`;
}

function toGroups(input: {
  groups: Iterable<GroupAccumulator>;
  maxGroups: number;
  sourceUrl: string | null;
}): MarylandFinanceOutsideGroupInput[] {
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

export function aggregateMarylandOutsideSpending(
  input: MarylandOutsideSpendingAggregationInput
): MarylandOutsideSpendingAggregationResult {
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxGroups = normalizePositiveInteger(input.maxGroups, DEFAULT_MAX_GROUPS, "maxGroups");
  const candidateNameKeys = normalizeMarylandCandidateNameKeys(input.candidateName);
  const officeKey = canonicalOfficeKey(input.officeName);
  if (candidateNameKeys.size === 0 || !officeKey) {
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
    if (
      !targetMatchesCandidate({
        candidateBallotIssue: row["Candidate/Ballot Issue"],
        candidateName: input.candidateName,
        candidateNameKeys,
      }) ||
      !officeMatches({ rowOfficeName: row["Office Sought"], officeName: input.officeName })
    ) {
      continue;
    }
    matchedExpenditureRowCount += 1;

    const committeeId = normalizeId(row["Filing Entity Id"]);
    const committeeName = row["Committee Name"].trim();
    const supportOppose = supportOpposeFromPosition(row.Position);
    const amountCents = expenditureAmountCents(row);
    if (
      !committeeId ||
      !committeeName ||
      !supportOppose ||
      amountCents === null ||
      amountCents <= 0 ||
      isCandidateCommitteeType(row["Committee Type"]) ||
      !isCycleYear({ rawDate: row["Transaction Date"], electionYear })
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
