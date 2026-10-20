import {
  NEBRASKA_COMMITTEE_CLASSES,
  neAdd,
  neCheck,
  neKey,
  type NebraskaNativeRegistration,
  type NebraskaReportedAllocation,
  type NebraskaReportedReceipt,
} from "./nebraskaReportedNative.js";
import {
  neAllocationOffice,
  neOfficeName,
  nePersonMatches,
  type NebraskaReportedReceiver,
  type NebraskaReportedReceivingContext,
} from "./nebraskaReportedReceiver.js";

export type NebraskaCommitteeGroup = {
  reportedName: string;
  key: string;
  amountCents: number;
  contributionCount: number;
};
export type NebraskaCommitteeAggregation = {
  totalAmountCents: number;
  contributionCount: number;
  sourceReceivingRows: number;
  excludedRows: number;
  groups: NebraskaCommitteeGroup[];
};
export type NebraskaOutsideGroup = {
  reportedName: string;
  key: string;
  stance: "support" | "oppose";
  amountCents: number;
  allocationCount: number;
};
export type NebraskaOutsideAggregation = {
  supportCents: number;
  opposeCents: number;
  allocationCount: number;
  unattributedSourceRows: number;
  groups: NebraskaOutsideGroup[];
};

const GIFTS = new Set([
  "MONETARY",
  "IN-KIND CONTRIBUTION",
  "EARMARKED MONETARY",
  "EARMARKED IN-KIND",
  "PLEDGE PAYMENT RECEIVED",
  "LOAN FORGIVENESS RECEIVED",
  "DEBT FORGIVENESS",
]);
const EXCLUDED = new Set([
  "LOAN",
  "PLEDGE",
  "OTHER FUNDS RECEIVED (MISCELLANEOUS RECEIPTS)",
  "PAYMENT RECEIVED FOR LOAN MADE",
]);
function name(value: string): string {
  neCheck(
    value.length > 0 &&
      value.length <= 4000 &&
      !/^(?:UNITEMIZED|LUMP SUM|ANONYMOUS|UNKNOWN)$/i.test(value),
    "unresolved_reported_name",
  );
  return value;
}
function binding(
  receiver: NebraskaReportedReceiver,
  context: NebraskaReportedReceivingContext,
): void {
  neCheck(
    context.receivingId === receiver.receivingId &&
      context.electionYear === receiver.electionYear &&
      context.officeName === receiver.officeName &&
      context.district === receiver.district &&
      nePersonMatches(receiver.candidateAliases, context.candidateName),
    "aggregation_receiving_context",
  );
}
export function aggregateNebraskaReportedCommittee(input: {
  receiver: NebraskaReportedReceiver;
  context: NebraskaReportedReceivingContext;
  receipts: readonly NebraskaReportedReceipt[];
}): NebraskaCommitteeAggregation {
  binding(input.receiver, input.context);
  const groups = new Map<string, NebraskaCommitteeGroup>();
  let totalAmountCents = 0,
    contributionCount = 0,
    sourceReceivingRows = 0,
    excludedRows = 0;
  for (const row of input.receipts) {
    if (row.receivingId !== input.context.receivingId) continue;
    sourceReceivingRows++;
    neCheck(
      neKey(row.receivingName) === neKey(input.context.committeeName),
      "native_receiving_name_changed",
    );
    neCheck(
      row.date >= `${input.receiver.electionYear - 1}-01-01` &&
        row.date <= `${input.receiver.electionYear}-12-31`,
      "receipt_cycle_scope",
    );
    neCheck(Number.isSafeInteger(row.amountCents), "receipt_amount");
    neCheck(
      Object.hasOwn(NEBRASKA_COMMITTEE_CLASSES, row.contributorClass),
      "unknown_committee_class",
    );
    neCheck(
      GIFTS.has(row.transactionType) || EXCLUDED.has(row.transactionType),
      "unknown_receipt_transaction_type",
    );
    if (EXCLUDED.has(row.transactionType) || row.amountCents === 0) {
      excludedRows++;
      continue;
    }
    neCheck(row.amountCents > 0, "negative_current_committee_receipt");
    const reportedName = name(row.reportedName),
      key = neKey(reportedName),
      group = groups.get(key) ?? {
        reportedName,
        key,
        amountCents: 0,
        contributionCount: 0,
      };
    group.amountCents = neAdd(group.amountCents, row.amountCents);
    group.contributionCount++;
    if (reportedName.localeCompare(group.reportedName) < 0)
      group.reportedName = reportedName;
    groups.set(key, group);
    totalAmountCents = neAdd(totalAmountCents, row.amountCents);
    contributionCount++;
  }
  return {
    totalAmountCents,
    contributionCount,
    sourceReceivingRows,
    excludedRows,
    groups: [...groups.values()].sort(
      (a, b) => b.amountCents - a.amountCents || a.key.localeCompare(b.key),
    ),
  };
}

export function aggregateNebraskaReportedOutside(input: {
  receiver: NebraskaReportedReceiver;
  context: NebraskaReportedReceivingContext;
  registrations: readonly NebraskaNativeRegistration[];
  allocations: readonly NebraskaReportedAllocation[];
}): NebraskaOutsideAggregation {
  binding(input.receiver, input.context);
  const aliases = [
      ...input.receiver.candidateAliases,
      input.context.candidateName,
    ],
    groups = new Map<string, NebraskaOutsideGroup>();
  let supportCents = 0,
    opposeCents = 0,
    allocationCount = 0;
  const unattributedSourceRows = input.allocations.filter(
    (row) => !row.targetName || !row.officeDistrict || !row.stance,
  ).length;
  for (const row of input.allocations) {
    const office = neAllocationOffice(row.officeDistrict),
      sameScope =
        office?.officeName === input.context.officeName &&
        office.district === input.context.district;
    if (!row.targetName) {
      neCheck(!sameScope, "unidentified_target_in_candidate_scope");
      continue;
    }
    if (!nePersonMatches(aliases, row.targetName)) continue;
    // A matching name without interpretable office evidence cannot be assigned
    // using a first/last fallback. Keep the previous component instead.
    neCheck(office, "unresolved_candidate_allocation_scope");
    if (!sameScope) continue;
    const possible = input.registrations.filter(
      (registration) =>
        registration.jurisdiction === "NEBRASKA" &&
        registration.election ===
          `${input.receiver.electionYear} STATEWIDE ELECTIONS` &&
        neOfficeName(registration.office) === office.officeName &&
        (office.district === null
          ? !registration.district
          : String(Number(registration.district)) === office.district) &&
        nePersonMatches([registration.candidateName], row.targetName),
    );
    neCheck(
      possible.length === 1 &&
        possible[0]!.receivingId === input.context.receivingId,
      "ambiguous_candidate_allocation",
    );
    neCheck(
      row.stance === "support" || row.stance === "oppose",
      "unresolved_candidate_allocation_stance",
    );
    neCheck(
      Number.isSafeInteger(row.amountCents) &&
        row.amountCents >= 0 &&
        row.date >= `${input.receiver.electionYear - 1}-01-01` &&
        row.date <= `${input.receiver.electionYear}-12-31`,
      "allocation_amount_or_cycle",
    );
    if (!row.amountCents) continue;
    const reportedName = name(row.reportedSpenderName),
      nameKey = neKey(reportedName),
      key = `${row.stance}:${nameKey}`;
    const group = groups.get(key) ?? {
      reportedName,
      key: nameKey,
      stance: row.stance,
      amountCents: 0,
      allocationCount: 0,
    };
    group.amountCents = neAdd(group.amountCents, row.amountCents);
    group.allocationCount++;
    if (reportedName.localeCompare(group.reportedName) < 0)
      group.reportedName = reportedName;
    groups.set(key, group);
    allocationCount++;
    if (row.stance === "support")
      supportCents = neAdd(supportCents, row.amountCents);
    else opposeCents = neAdd(opposeCents, row.amountCents);
  }
  neCheck(
    allocationCount > 0 || unattributedSourceRows === 0,
    "uncertified_zero_with_unattributed_source_rows",
  );
  return {
    supportCents,
    opposeCents,
    allocationCount,
    unattributedSourceRows,
    groups: [...groups.values()].sort(
      (a, b) =>
        b.amountCents - a.amountCents ||
        a.key.localeCompare(b.key) ||
        a.stance.localeCompare(b.stance),
    ),
  };
}
