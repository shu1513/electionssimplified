import type { NevadaFinancePacDonorInput } from "./nevadaFinanceWriter.js";

export const NEVADA_PUBLIC_FINANCE_SEARCH_URL =
  "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx";

export type NevadaObservedCashOccurrence = {
  contributorName: string;
  date: string;
  amountCents: number;
  loanCellBlank: boolean;
  loanCheckboxChecked: boolean | null;
};

/** A complete all-class name query, not a legal committee identity. */
export type NevadaObservedGroupNameQuery = {
  nameQuery: string;
  groupTypeBlank: true;
  resultCount: number;
  rows: readonly { name: string; type: string }[];
};

export function nevadaReportedCommitteeNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("en-US");
}

export function isNevadaReportedPacName(name: string): boolean {
  // A literal PAC token is narrower than PA's general committee-name rule.
  // Do not turn HealthPAC, generic associations, caucuses or acronyms into
  // a registered PAC, or expand a reported name to a different group name.
  const literal = name.normalize("NFKC");
  return (
    /(?:\bPAC\b|\bP\s*\.\s*A\s*\.\s*C(?:\s*\.)?(?=\s|$))/.test(literal) ||
    /\bpolitical action committee\b/i.test(literal)
  );
}

function recognitionMethod(
  name: string,
  queries: readonly NevadaObservedGroupNameQuery[],
): NevadaFinancePacDonorInput["recognitionMethod"] | null {
  const key = nevadaReportedCommitteeNameKey(name);
  const matchingTypes = new Set<string>();
  for (const query of queries) {
    if (
      query.groupTypeBlank !== true ||
      !query.nameQuery.trim() ||
      !Number.isSafeInteger(query.resultCount) ||
      query.resultCount < 0 ||
      query.resultCount !== query.rows.length
    ) {
      throw new Error("Nevada group name query is incomplete");
    }
    if (!key.includes(nevadaReportedCommitteeNameKey(query.nameQuery)))
      continue;
    for (const row of query.rows) {
      if (nevadaReportedCommitteeNameKey(row.name) === key) {
        matchingTypes.add(nevadaReportedCommitteeNameKey(row.type));
      }
    }
  }
  const pacTypes = new Set(["PAC", "POLITICAL ACTION COMMITTEE"]);
  if (matchingTypes.size > 0) {
    const hasPac = [...matchingTypes].some((type) => pacTypes.has(type));
    const hasOther = [...matchingTypes].some((type) => !pacTypes.has(type));
    if (hasPac && hasOther) {
      throw new Error("Nevada donor name has conflicting group classes");
    }
    return hasPac ? "registry_name" : null;
  }
  return isNevadaReportedPacName(name) ? "reported_name" : null;
}

/** Called only after the source verifier closes the entire current cash scope. */
export function aggregateNevadaObservedPacDonors(input: {
  cashRows: readonly NevadaObservedCashOccurrence[];
  groupQueries: readonly NevadaObservedGroupNameQuery[];
}): NevadaFinancePacDonorInput[] {
  const donors = new Map<
    string,
    { donor: NevadaFinancePacDonorInput; cents: number }
  >();
  for (const row of input.cashRows) {
    if (!Number.isSafeInteger(row.amountCents) || !row.contributorName.trim()) {
      throw new Error("Nevada cash occurrence has an invalid name or amount");
    }
    if (row.loanCheckboxChecked === true) continue;
    if (row.loanCellBlank !== true || row.loanCheckboxChecked !== null) {
      throw new Error(
        "Nevada cash occurrence has unreviewed loan-column evidence",
      );
    }
    const method = recognitionMethod(row.contributorName, input.groupQueries);
    if (method === null) continue;
    const name = row.contributorName.trim().replace(/\s+/g, " ");
    const id = `reported:${nevadaReportedCommitteeNameKey(name)}`;
    const existing = donors.get(id);
    if (existing) {
      existing.cents += row.amountCents;
      if (!Number.isSafeInteger(existing.cents)) {
        throw new Error("Nevada committee cash position is out of range");
      }
      existing.donor.contributionCount += row.amountCents > 0 ? 1 : 0;
      continue;
    }
    donors.set(id, {
      cents: row.amountCents,
      donor: {
        committeeId: id,
        committeeName: name,
        recognitionMethod: method,
        totalAmount: 0,
        contributionCount: row.amountCents > 0 ? 1 : 0,
        sourceUrl: NEVADA_PUBLIC_FINANCE_SEARCH_URL,
      },
    });
  }
  // Retain signed/zero positions; the reader nets across receiving links
  // before choosing positive display entries. Equal gifts remain occurrences.
  return [...donors.values()]
    .map(({ donor, cents }) => ({ ...donor, totalAmount: cents / 100 }))
    .sort(
      (a, b) =>
        b.totalAmount - a.totalAmount ||
        a.committeeName.localeCompare(b.committeeName),
    );
}
