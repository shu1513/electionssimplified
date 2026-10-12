import { createHash } from "node:crypto";
import type { DelawareNativeLedger } from "./delawareNativeLedger.js";

/** Published contributor classes, not keyword or employer-name guesses. */
const COMMITTEE_TYPES = new Set([
  "Political Action Committee", "Political Committee", "PAC", "Candidate Committee",
  "Out-of-State or Federal Committee", "Dem or Rep National Sub-Committees",
]);
const CASH_TYPES = new Set(["Check", "Credit Card", "EFT", "Electronic Fund Transfer", "Cash"]);
const NON_GIFT_TYPES = new Set(["Candidate Loan", "Other Income", "Refund/Rebate"]);
const PERSONAL_TYPES = new Set(["Individual", "Self (Candidate)"]);
const REPORTED_AGGREGATE_TYPE = "Total of Contributions not exceeding $100";

export type DelawareReportedCommitteeFact = {
  /** Reported-name namespace; never presented as a registered legal CF_ID. */
  reportedIdentity: string;
  reportedName: string;
  reportedContributorType: string;
  cashCents: number;
  inKindCents: number;
  giftTransactionIds: number[];
  refundTransactionIds: number[];
};
export type DelawareReportedCommitteeFacts = {
  donors: DelawareReportedCommitteeFact[];
  unresolvedReceiptIds: number[];
  unresolvedReturnIds: number[];
  possibleSelfReceiptIds: number[];
  nonGiftReceiptIds: number[];
  /** Published aggregate-class rows; PDF binding decides itemized vs anonymous control. */
  reportedAggregateReceiptIds: number[];
  receiptFingerprint: string;
  expenseFingerprint: string;
};

function add(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("Delaware committee facts: unsafe amount");
  return value;
}
function field(raw: Readonly<Record<string, unknown>>, name: string): string {
  const value = raw[name];
  if (typeof value !== "string") throw new Error("Delaware committee facts: missing " + name);
  return value.trim();
}

/**
 * Source facts only. The caller must independently verify financial reports,
 * registry enrichment, campaign scope, currentness and acquisition brackets
 * before persisting money. Unresolved IDs prevent a complete donor component;
 * an empty facts array is not financial zero authority.
 */
export function aggregateDelawareReportedCommitteeFacts(input: {
  receipts: DelawareNativeLedger;
  expenses: DelawareNativeLedger;
  receivingCfId: string;
  receivingCommitteeName: string;
}): DelawareReportedCommitteeFacts {
  if (input.receipts.kind !== "receipts" || input.expenses.kind !== "expenses" ||
      !/^\d{8}$/.test(input.receivingCfId) || !input.receivingCommitteeName.trim()) {
    throw new Error("Delaware committee facts: invalid receiving scope");
  }
  const donors = new Map<string, DelawareReportedCommitteeFact>();
  const unresolvedReceiptIds: number[] = [];
  const unresolvedReturnIds: number[] = [];
  const possibleSelfReceiptIds: number[] = [];
  const nonGiftReceiptIds: number[] = [];
  const reportedAggregateReceiptIds: number[] = [];
  for (const row of input.receipts.rows) {
    const raw = row.rawFields;
    if (field(raw, "WC_ID") !== input.receivingCfId) {
      throw new Error("Delaware committee facts: receipt receiver mismatch");
    }
    const type = field(raw, "ContributionType");
    const contributorType = field(raw, "ContributorType");
    const name = field(raw, "ContributorName");
    if (contributorType === REPORTED_AGGREGATE_TYPE) {
      // Actual sources use this class for both an itemized cash row and
      // native representations of separate anonymous PDF controls. Neither
      // supplies a named committee; do not guess its financial placement.
      reportedAggregateReceiptIds.push(row.transactionId);
      continue;
    }
    if (NON_GIFT_TYPES.has(type)) {
      nonGiftReceiptIds.push(row.transactionId);
      continue;
    }
    if (!CASH_TYPES.has(type) && type !== "In-Kind") {
      unresolvedReceiptIds.push(row.transactionId);
      continue;
    }
    if (PERSONAL_TYPES.has(contributorType)) continue;
    if (!COMMITTEE_TYPES.has(contributorType) || name === "") {
      // A complete legal registry proof may resolve businesses/Other later.
      unresolvedReceiptIds.push(row.transactionId);
      continue;
    }
    if (name === input.receivingCommitteeName.trim()) {
      possibleSelfReceiptIds.push(row.transactionId);
      continue;
    }
    const reportedIdentity = "reported:" + createHash("sha256")
      .update(JSON.stringify([contributorType, name])).digest("hex");
    const donor = donors.get(reportedIdentity) ?? {
      reportedIdentity, reportedName: name, reportedContributorType: contributorType,
      cashCents: 0, inKindCents: 0, giftTransactionIds: [], refundTransactionIds: [],
    };
    if (type === "In-Kind") donor.inKindCents = add(donor.inKindCents, row.amountCents);
    else donor.cashCents = add(donor.cashCents, row.amountCents);
    if (row.amountCents > 0) donor.giftTransactionIds.push(row.transactionId);
    else if (row.amountCents < 0) donor.refundTransactionIds.push(row.transactionId);
    donors.set(reportedIdentity, donor);
  }
  for (const row of input.expenses.rows) {
    const raw = row.rawFields;
    if (field(raw, "CCF_ID") !== input.receivingCfId) {
      throw new Error("Delaware committee facts: expense receiver mismatch");
    }
    if (field(raw, "ExpenseCategory") !== "Return Contributions") continue;
    const name = field(raw, "PayeeName");
    const type = field(raw, "PayeeType");
    const matches = [...donors.values()].filter((donor) => donor.reportedName === name);
    // An explicitly individual return unrelated to any committee name does
    // not reduce committee gifts. Other identities require registry proof.
    if (type === "Individual" && matches.length === 0) continue;
    if (matches.length !== 1 || matches[0]!.reportedContributorType !== type) {
      unresolvedReturnIds.push(row.transactionId);
      continue;
    }
    const donor = matches[0]!;
    const method = field(raw, "ExpenseMethod");
    if (method === "In-Kind") donor.inKindCents = add(donor.inKindCents, -row.amountCents);
    else if (CASH_TYPES.has(method) || method === "Wire Transfer") {
      donor.cashCents = add(donor.cashCents, -row.amountCents);
    } else {
      unresolvedReturnIds.push(row.transactionId);
      continue;
    }
    donor.refundTransactionIds.push(row.transactionId);
  }
  return {
    donors: [...donors.values()].sort((a, b) => a.reportedIdentity.localeCompare(b.reportedIdentity)),
    unresolvedReceiptIds, unresolvedReturnIds, possibleSelfReceiptIds, nonGiftReceiptIds,
    reportedAggregateReceiptIds,
    receiptFingerprint: input.receipts.rawRowFingerprint,
    expenseFingerprint: input.expenses.rawRowFingerprint,
  };
}
