import type { MinnesotaCampaignFinanceCsvRow } from "./minnesotaCampaignFinanceArtifactReader.js";

export type MinnesotaReportedCommitteeCashDonor = {
  reportedCommitteeId: string;
  reportedCommitteeName: string;
  amountCents: number;
  contributionCount: number;
};

export type MinnesotaReportedCommitteeCashAggregation = {
  donors: MinnesotaReportedCommitteeCashDonor[];
  totalAmountCents: number;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  excludedContributionRowCount: number;
  /** Otherwise eligible cash receipts whose native class is blank or Unknown/Null. */
  excludedUnknownClassRowCount: number;
  zeroContributionRowCount: number;
};

export type MinnesotaReportedCommitteeCashHoldReason =
  | "invalid_receiving_account"
  | "invalid_election_year"
  | "missing_recipient_account"
  | "invalid_reporting_year"
  | "unknown_recipient_type"
  | "unknown_contributor_type"
  | "unknown_receipt_type"
  | "unknown_in_kind_flag"
  | "invalid_reported_donor_account"
  | "invalid_reported_donor_name"
  | "invalid_receipt_date"
  | "invalid_amount"
  | "non_cent_precision"
  | "negative_cash_contribution"
  | "unsafe_amount";

/** A component hold, deliberately containing no source row values or identities. */
export class MinnesotaReportedCommitteeCashHoldError extends Error {
  constructor(readonly reason: MinnesotaReportedCommitteeCashHoldReason) {
    super(`Minnesota reported committee cash held: ${reason}`);
    this.name = "MinnesotaReportedCommitteeCashHoldError";
  }
}

// Exact native source classes. Blank/Unknown/Null never establish a committee role.
const EXCLUDED_CONTRIBUTOR_TYPES = new Set([
  "Individual", "Candidate Committee", "Party Unit", "Lobbyist", "Self", "Other",
  "Registered with Hennepin County",
]);
const EXCLUDED_RECEIPT_TYPES = new Set([
  "Miscellaneous Income", "Miscellaneous", "MiscellaneousIncome", "Loan Payable", "Loan Receivable",
]);
const EXCLUDED_RECIPIENT_TYPES = new Set(["PTU", "PCF"]);
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

function hold(reason: MinnesotaReportedCommitteeCashHoldReason): never {
  throw new MinnesotaReportedCommitteeCashHoldError(reason);
}

function literalName(value: string | undefined): string {
  if (value === undefined || /[\u0000-\u001f\u007f]/u.test(value)) {
    return hold("invalid_reported_donor_name");
  }
  // Preserve case, punctuation, accents and legal-looking suffixes. Only Unicode
  // representation and incidental whitespace normalize; no identity is inferred.
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return name || hold("invalid_reported_donor_name");
}

function validateReceiptDate(value: string | undefined): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return hold("invalid_receipt_date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return hold("invalid_receipt_date");
  }
}

function exactCashCents(value: string | undefined): number {
  // Official receipts have four fractional places, with zeros beyond cents in
  // this component. Leading-dot decimals are native, not malformed amounts.
  const match = /^(-?)(?:(\d+)(?:\.(\d+))?|\.(\d+))$/.exec(value?.trim() ?? "");
  if (!match) return hold("invalid_amount");
  const fraction = match[3] ?? match[4] ?? "";
  if (/[1-9]/.test(fraction.slice(2))) return hold("non_cent_precision");
  const unsigned = BigInt(match[2] ?? "0") * 100n + BigInt((fraction + "00").slice(0, 2));
  if (unsigned > MAX_SAFE_CENTS) return hold("unsafe_amount");
  if (match[1] === "-" && unsigned > 0n) return hold("negative_cash_contribution");
  return Number(unsigned);
}

function addCents(left: number, right: number): number {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : hold("unsafe_amount");
}

function compareLiteral(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reported itemized committee cash contributions, using the source's Year as
 * reporting-year authority. Receipt dates validate syntax/calendar only; they
 * do not replace that authority. This does not calculate net cash after later
 * returns or certify legal donor identity. Complete source qualification belongs
 * to the ordinary loader, not an approval flag supplied to this pure function.
 */
export function aggregateMinnesotaReportedCommitteeCash(input: {
  rows: readonly MinnesotaCampaignFinanceCsvRow[];
  committeeId: string;
  electionYear: number;
}): MinnesotaReportedCommitteeCashAggregation {
  const receivingAccount = input.committeeId.trim();
  if (!/^\d+$/.test(receivingAccount)) return hold("invalid_receiving_account");
  if (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) {
    return hold("invalid_election_year");
  }
  const result: MinnesotaReportedCommitteeCashAggregation = {
    donors: [], totalAmountCents: 0, matchedContributionRowCount: 0,
    includedContributionRowCount: 0, excludedContributionRowCount: 0, excludedUnknownClassRowCount: 0, zeroContributionRowCount: 0,
  };
  const donors = new Map<string, MinnesotaReportedCommitteeCashDonor>();
  for (const row of input.rows) {
    const recipientAccount = row["Recipient reg num"]?.trim();
    if (!recipientAccount) return hold("missing_recipient_account");
    if (recipientAccount !== receivingAccount) continue;
    result.matchedContributionRowCount += 1;
    const yearText = row.Year?.trim() ?? "";
    if (!/^\d{4}$/.test(yearText)) return hold("invalid_reporting_year");
    const year = Number(yearText);
    if (year < input.electionYear - 1 || year > input.electionYear) {
      result.excludedContributionRowCount += 1;
      continue;
    }
    const recipientType = row["Recipient type"]?.trim() ?? "";
    const contributorValue = row["Contrib type"];
    const contributorType = contributorValue?.trim() ?? "";
    const receiptType = row["Receipt type"]?.trim() ?? "";
    const inKind = row["In kind?"]?.trim() ?? "";
    // Any explicit exclusion closes this row's scope, even if another role is
    // unavailable. Unknown roles hold only rows that remain potentially eligible.
    if (EXCLUDED_RECIPIENT_TYPES.has(recipientType) || EXCLUDED_CONTRIBUTOR_TYPES.has(contributorType) ||
      EXCLUDED_RECEIPT_TYPES.has(receiptType) || inKind === "Yes") {
      result.excludedContributionRowCount += 1;
      continue;
    }
    if (recipientType !== "PCC") return hold("unknown_recipient_type");
    if (receiptType !== "Contribution") return hold("unknown_receipt_type");
    if (inKind !== "No") return hold("unknown_in_kind_flag");
    // After other explicit exclusions, these known native unknowns are omitted
    // from reported committee cash. Their omission does not erase classified
    // gifts. An absent property or a new class still signals unknown schema.
    if (contributorValue !== undefined && (contributorType === "" || contributorType === "Unknown/Null")) {
      result.excludedUnknownClassRowCount += 1;
      result.excludedContributionRowCount += 1;
      continue;
    }
    if (contributorType !== "Political Committee/Fund") return hold("unknown_contributor_type");
    const account = row["Contrib Reg Num"]?.trim() ?? "";
    if (!/^\d+$/.test(account)) return hold("invalid_reported_donor_account");
    const name = literalName(row.Contributor);
    validateReceiptDate(row["Receipt date"]);
    const amountCents = exactCashCents(row.Amount);
    if (amountCents === 0) {
      result.zeroContributionRowCount += 1;
      continue;
    }
    // JSON tuple encoding avoids separator collisions without folding different
    // names/accounts together. Every positive source occurrence counts.
    const key = JSON.stringify([account, name]);
    const donor = donors.get(key);
    if (donor) {
      donor.amountCents = addCents(donor.amountCents, amountCents);
      donor.contributionCount += 1;
    } else {
      donors.set(key, { reportedCommitteeId: account, reportedCommitteeName: name, amountCents, contributionCount: 1 });
    }
    result.totalAmountCents = addCents(result.totalAmountCents, amountCents);
    result.includedContributionRowCount += 1;
  }
  result.donors = [...donors.values()].sort((left, right) =>
    right.amountCents - left.amountCents || compareLiteral(left.reportedCommitteeId, right.reportedCommitteeId) ||
    compareLiteral(left.reportedCommitteeName, right.reportedCommitteeName));
  return result;
}
