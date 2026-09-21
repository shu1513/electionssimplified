// Pure parsing and aggregation for the FEC bulk files that name the committees
// behind a candidate's money. No I/O here: callers feed lines in and read the
// per-candidate result out, so every rule below is unit-testable.
//
// Sources (column order verified against the FEC file descriptions at
// https://www.fec.gov/data/browse-data/?tab=bulk-data):
// - cm (committee master): committee name, type, connected organization.
// - ccl (candidate-committee linkage): which committees belong to a candidate.
// - pas2 (contributions from committees to candidates): what each committee
//   reported giving to a candidate. 24K = contribution, 24Z = in-kind
//   contribution. Reported by the giving committee.
// - indiv (contributions by individuals): type 15E rows filed by the
//   candidate's own committee are itemized individual contributions that came
//   through a conduit; OTHER_ID holds the conduit's committee id.
//
// Counting rules:
// 1. Memo entries (MEMO_CD = X) are skipped in both files. The FEC keeps them
//    out of report totals because they repeat money shown on another line.
// 2. A pas2 row whose memo text says the money was earmarked is a conduit
//    passing on an individual's contribution, not the committee's own money.
//    It is left out of the committee-donor list. Conduit totals come only
//    from the candidate committee's own 15E rows, so the conduit's copy of
//    the same contribution (its 24I/24T/15E rows, or an earmark-marked 24K)
//    is never added on top.
// 3. Negative amounts (refunds, voided checks, redesignations) net against
//    the same committee. A committee whose net is zero or less is dropped.
//    Refunds also appear on the candidate's side as 22Z rows in another file;
//    those are not read, because most are already reported as negative 24K
//    rows by the giving committee and subtracting both would double count.
// 4. In-kind contributions (24Z) count toward a committee's total, as they do
//    on line 11C of the candidate's report.
// 5. Committees linked to the same candidate (other authorized committees,
//    joint fundraising committees, a sponsored leadership PAC) are never
//    listed as donors or conduits for that candidate. Party committees are
//    left out of the donor list as well: the FEC reports them on a separate
//    line from other political committees.
// 6. A conduit is marked as a payment platform when it forwarded money to at
//    least PAYMENT_PLATFORM_MIN_RECIPIENT_COMMITTEES committees in the cycle
//    and reported no contributions of its own. The rule is computed from the
//    files; no committee is named in code.

export const PAYMENT_PLATFORM_MIN_RECIPIENT_COMMITTEES = 500;

const COMMITTEE_ID_PATTERN = /^C\d{8}$/;
const CANDIDATE_ID_PATTERN = /^[HPS][0-9A-Z]{8}$/;
const EARMARK_MEMO_PATTERN = /\bEARMARK/i;
const PARTY_COMMITTEE_TYPES = new Set(["X", "Y", "Z"]);
const DIRECT_COMMITTEE_DESIGNATIONS = new Set(["P", "A"]);
const PAS2_CONTRIBUTION_TYPES = new Set(["24K", "24Z"]);
const EARMARKED_RECEIPT_TYPE = "15E";

export type FecBulkCommittee = {
  committeeId: string;
  name: string;
  committeeType: string | null;
  designation: string | null;
  organizationType: string | null;
  connectedOrganization: string | null;
  candidateId: string | null;
};

export type FecBulkCandidateCommitteeLink = {
  candidateId: string;
  fecElectionYear: number;
  committeeId: string;
  designation: string | null;
};

export type FecBulkCommitteeContribution = {
  committeeId: string;
  candidateId: string;
  recipientCommitteeId: string | null;
  transactionType: string;
  amount: number;
  isMemo: boolean;
  isEarmarkForward: boolean;
};

export type FecBulkEarmarkedReceipt = {
  recipientCommitteeId: string;
  conduitCommitteeId: string;
  amount: number;
  isMemo: boolean;
};

export type CandidateFinancePacDonor = {
  committeeId: string;
  committeeName: string;
  connectedOrganization: string | null;
  amount: number;
  contributionCount: number;
  /** Every committee of the candidate the amount went to, largest share first. */
  recipientCommitteeIds: string[];
};

export type CandidateFinanceConduitTotal = {
  committeeId: string;
  committeeName: string;
  isPaymentPlatform: boolean;
  amount: number;
  contributionCount: number;
  /** Every committee of the candidate that reported the receipts, largest share first. */
  recipientCommitteeIds: string[];
};

export type CandidateFinanceContributors = {
  fecCandidateId: string;
  pacDonors: CandidateFinancePacDonor[];
  conduits: CandidateFinanceConduitTotal[];
};

function splitBulkLine(line: string): string[] {
  return line.replace(/\r?\n$/, "").split("|");
}

function cleanText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function cleanCommitteeId(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return COMMITTEE_ID_PATTERN.test(normalized) ? normalized : null;
}

function cleanCandidateId(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return CANDIDATE_ID_PATTERN.test(normalized) ? normalized : null;
}

function parseAmount(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

// The FEC writes "NONE" when a committee has no connected organization.
function cleanConnectedOrganization(value: string | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned || /^(none|n\/a|na)$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/** cm columns: 1 CMTE_ID, 2 CMTE_NM, 9 CMTE_DSGN, 10 CMTE_TP, 13 ORG_TP, 14 CONNECTED_ORG_NM, 15 CAND_ID. */
export function parseFecCommitteeMasterLine(line: string): FecBulkCommittee | null {
  const columns = splitBulkLine(line);
  const committeeId = cleanCommitteeId(columns[0]);
  const name = cleanText(columns[1]);
  if (!committeeId || !name) {
    return null;
  }
  return {
    committeeId,
    name,
    designation: cleanText(columns[8])?.toUpperCase() ?? null,
    committeeType: cleanText(columns[9])?.toUpperCase() ?? null,
    organizationType: cleanText(columns[12])?.toUpperCase() ?? null,
    connectedOrganization: cleanConnectedOrganization(columns[13]),
    candidateId: cleanCandidateId(columns[14]),
  };
}

/** ccl columns: 1 CAND_ID, 3 FEC_ELECTION_YR, 4 CMTE_ID, 6 CMTE_DSGN. */
export function parseFecCandidateCommitteeLinkLine(line: string): FecBulkCandidateCommitteeLink | null {
  const columns = splitBulkLine(line);
  const candidateId = cleanCandidateId(columns[0]);
  const committeeId = cleanCommitteeId(columns[3]);
  const fecElectionYear = Number.parseInt(columns[2] ?? "", 10);
  if (!candidateId || !committeeId || !Number.isInteger(fecElectionYear)) {
    return null;
  }
  return {
    candidateId,
    fecElectionYear,
    committeeId,
    designation: cleanText(columns[5])?.toUpperCase() ?? null,
  };
}

/**
 * pas2 columns: 1 CMTE_ID (the giving committee), 6 TRANSACTION_TP,
 * 15 TRANSACTION_AMT, 16 OTHER_ID (the receiving committee), 17 CAND_ID,
 * 20 MEMO_CD, 21 MEMO_TEXT. Returns null for rows that are not 24K/24Z.
 */
export function parseFecCommitteeContributionLine(line: string): FecBulkCommitteeContribution | null {
  const columns = splitBulkLine(line);
  const transactionType = cleanText(columns[5])?.toUpperCase() ?? "";
  if (!PAS2_CONTRIBUTION_TYPES.has(transactionType)) {
    return null;
  }
  const committeeId = cleanCommitteeId(columns[0]);
  const candidateId = cleanCandidateId(columns[16]);
  const amount = parseAmount(columns[14]);
  if (!committeeId || !candidateId || amount === null) {
    return null;
  }
  return {
    committeeId,
    candidateId,
    recipientCommitteeId: cleanCommitteeId(columns[15]),
    transactionType,
    amount,
    isMemo: cleanText(columns[19])?.toUpperCase() === "X",
    isEarmarkForward: EARMARK_MEMO_PATTERN.test(columns[20] ?? ""),
  };
}

/**
 * indiv columns: 1 CMTE_ID (the committee that filed the row), 6
 * TRANSACTION_TP, 15 TRANSACTION_AMT, 16 OTHER_ID, 19 MEMO_CD. Returns null
 * unless the row is a 15E receipt that names a conduit committee.
 */
export function parseFecEarmarkedReceiptLine(line: string): FecBulkEarmarkedReceipt | null {
  // The file has tens of millions of rows; skip the split for the rest.
  if (!line.includes("|15E|")) {
    return null;
  }
  const columns = splitBulkLine(line);
  if (cleanText(columns[5])?.toUpperCase() !== EARMARKED_RECEIPT_TYPE) {
    return null;
  }
  const recipientCommitteeId = cleanCommitteeId(columns[0]);
  const conduitCommitteeId = cleanCommitteeId(columns[15]);
  const amount = parseAmount(columns[14]);
  if (!recipientCommitteeId || !conduitCommitteeId || amount === null) {
    return null;
  }
  return {
    recipientCommitteeId,
    conduitCommitteeId,
    amount,
    isMemo: cleanText(columns[18])?.toUpperCase() === "X",
  };
}

type RunningTotal = {
  amount: number;
  contributionCount: number;
  byRecipientCommittee: Map<string, number>;
};

function addToRunningTotal(totals: Map<string, RunningTotal>, key: string, amount: number, recipientCommitteeId: string | null): void {
  const total = totals.get(key) ?? { amount: 0, contributionCount: 0, byRecipientCommittee: new Map<string, number>() };
  total.amount += amount;
  if (amount > 0) {
    total.contributionCount += 1;
  }
  if (recipientCommitteeId) {
    total.byRecipientCommittee.set(
      recipientCommitteeId,
      (total.byRecipientCommittee.get(recipientCommitteeId) ?? 0) + amount
    );
  }
  totals.set(key, total);
}

// The amount sums every receiving committee, so the evidence link must name
// them all or a reader checking the number sees less than the card shows.
// fec.gov filters accept at most ten ids.
const MAX_RECIPIENT_COMMITTEES_IN_LINK = 10;

function recipientCommittees(total: RunningTotal): string[] {
  return [...total.byRecipientCommittee]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_RECIPIENT_COMMITTEES_IN_LINK)
    .map(([committeeId]) => committeeId);
}

/**
 * Collects the four files for one two-year cycle and answers, per candidate,
 * which committees gave and which conduits individual money came through.
 * Feed order: committees and links first, then contributions and receipts.
 */
export class FecBulkContributorAggregator {
  private readonly cycle: number;
  private readonly targetCandidateIds: Set<string>;
  private readonly committees = new Map<string, FecBulkCommittee>();
  private readonly linkedCommitteesByCandidate = new Map<string, Set<string>>();
  private readonly candidatesByDirectCommittee = new Map<string, Set<string>>();
  private readonly pacTotalsByCandidate = new Map<string, Map<string, RunningTotal>>();
  private readonly conduitTotalsByCandidate = new Map<string, Map<string, RunningTotal>>();
  private readonly conduitRecipientCommittees = new Map<string, Set<string>>();
  private readonly committeesWithOwnContributions = new Set<string>();

  constructor(input: { cycle: number; fecCandidateIds: Iterable<string> }) {
    this.cycle = input.cycle;
    this.targetCandidateIds = new Set([...input.fecCandidateIds].map((id) => id.trim().toUpperCase()));
  }

  addCommittee(committee: FecBulkCommittee): void {
    this.committees.set(committee.committeeId, committee);
    if (committee.candidateId && this.targetCandidateIds.has(committee.candidateId)) {
      this.linkCommittee(committee.candidateId, committee.committeeId, committee.designation);
    }
  }

  addCandidateCommitteeLink(link: FecBulkCandidateCommitteeLink): void {
    if (link.fecElectionYear !== this.cycle || !this.targetCandidateIds.has(link.candidateId)) {
      return;
    }
    this.linkCommittee(link.candidateId, link.committeeId, link.designation);
  }

  private linkCommittee(candidateId: string, committeeId: string, designation: string | null): void {
    const linked = this.linkedCommitteesByCandidate.get(candidateId) ?? new Set<string>();
    linked.add(committeeId);
    this.linkedCommitteesByCandidate.set(candidateId, linked);
    if (designation && DIRECT_COMMITTEE_DESIGNATIONS.has(designation)) {
      const candidates = this.candidatesByDirectCommittee.get(committeeId) ?? new Set<string>();
      candidates.add(candidateId);
      this.candidatesByDirectCommittee.set(committeeId, candidates);
    }
  }

  addCommitteeContribution(row: FecBulkCommitteeContribution): void {
    if (row.isMemo || row.isEarmarkForward) {
      return;
    }
    if (row.amount > 0) {
      this.committeesWithOwnContributions.add(row.committeeId);
    }
    if (!this.targetCandidateIds.has(row.candidateId)) {
      return;
    }
    const totals = this.pacTotalsByCandidate.get(row.candidateId) ?? new Map<string, RunningTotal>();
    addToRunningTotal(totals, row.committeeId, row.amount, row.recipientCommitteeId);
    this.pacTotalsByCandidate.set(row.candidateId, totals);
  }

  addEarmarkedReceipt(row: FecBulkEarmarkedReceipt): void {
    if (row.isMemo) {
      return;
    }
    const recipients = this.conduitRecipientCommittees.get(row.conduitCommitteeId) ?? new Set<string>();
    recipients.add(row.recipientCommitteeId);
    this.conduitRecipientCommittees.set(row.conduitCommitteeId, recipients);

    // Only rows filed by the candidate's own committee count. A conduit's own
    // rows describe the same contribution from the other side.
    const candidates = this.candidatesByDirectCommittee.get(row.recipientCommitteeId);
    if (!candidates) {
      return;
    }
    for (const candidateId of candidates) {
      const totals = this.conduitTotalsByCandidate.get(candidateId) ?? new Map<string, RunningTotal>();
      addToRunningTotal(totals, row.conduitCommitteeId, row.amount, row.recipientCommitteeId);
      this.conduitTotalsByCandidate.set(candidateId, totals);
    }
  }

  /** The FEC registration facts for one committee, when the master file has it. */
  getCommittee(committeeId: string): FecBulkCommittee | null {
    return this.committees.get(committeeId) ?? null;
  }

  private isPaymentPlatform(committeeId: string): boolean {
    const recipientCount = this.conduitRecipientCommittees.get(committeeId)?.size ?? 0;
    return (
      recipientCount >= PAYMENT_PLATFORM_MIN_RECIPIENT_COMMITTEES &&
      !this.committeesWithOwnContributions.has(committeeId)
    );
  }

  private isLinkedToCandidate(candidateId: string, committeeId: string): boolean {
    return this.linkedCommitteesByCandidate.get(candidateId)?.has(committeeId) === true;
  }

  getContributors(fecCandidateId: string): CandidateFinanceContributors {
    const candidateId = fecCandidateId.trim().toUpperCase();

    const pacDonors: CandidateFinancePacDonor[] = [];
    for (const [committeeId, total] of this.pacTotalsByCandidate.get(candidateId) ?? []) {
      const committee = this.committees.get(committeeId);
      const amount = roundCents(total.amount);
      if (
        amount <= 0 ||
        this.isLinkedToCandidate(candidateId, committeeId) ||
        (committee?.committeeType && PARTY_COMMITTEE_TYPES.has(committee.committeeType))
      ) {
        continue;
      }
      pacDonors.push({
        committeeId,
        committeeName: committee?.name ?? committeeId,
        connectedOrganization: committee?.connectedOrganization ?? null,
        amount,
        contributionCount: total.contributionCount,
        recipientCommitteeIds: recipientCommittees(total),
      });
    }

    const conduits: CandidateFinanceConduitTotal[] = [];
    for (const [committeeId, total] of this.conduitTotalsByCandidate.get(candidateId) ?? []) {
      const amount = roundCents(total.amount);
      const recipientCommitteeIds = recipientCommittees(total);
      if (amount <= 0 || recipientCommitteeIds.length === 0 || this.isLinkedToCandidate(candidateId, committeeId)) {
        continue;
      }
      conduits.push({
        committeeId,
        committeeName: this.committees.get(committeeId)?.name ?? committeeId,
        isPaymentPlatform: this.isPaymentPlatform(committeeId),
        amount,
        contributionCount: total.contributionCount,
        recipientCommitteeIds,
      });
    }

    const byAmountThenName = (
      left: { amount: number; committeeName: string },
      right: { amount: number; committeeName: string }
    ): number => right.amount - left.amount || left.committeeName.localeCompare(right.committeeName);

    return {
      fecCandidateId: candidateId,
      pacDonors: pacDonors.sort(byAmountThenName),
      conduits: conduits.sort(byAmountThenName),
    };
  }
}
