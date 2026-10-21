import { nmAdd, nmCheck, nmKey, nmString } from "./newMexicoReportedNative.js";
import {
  nmNativeDistrict,
  nmPersonMatches,
  nmPotentialPerson,
  qualifyNewMexicoReceiverDetail,
  qualifyNewMexicoReportedReceiver,
  type NewMexicoNativeCandidate,
  type NewMexicoReportedReceiver,
} from "./newMexicoReportedReceiver.js";
import type { NewMexicoNativeDataset } from "./newMexicoReportedProtocol.js";
import type { NmNativeObject } from "./newMexicoReportedNative.js";

export type NewMexicoReportedGroup = {
  key: string;
  reportedName: string;
  stance: "committee" | "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type NewMexicoReportedControls = Record<string, number>;
export type NewMexicoReportedAggregation = {
  groups: NewMexicoReportedGroup[];
  controls: NewMexicoReportedControls;
};
export type NewMexicoReportedContext = {
  registration: NewMexicoNativeCandidate;
  detail: {
    candidateName: string;
    officeName: string;
    electionYear: number;
    memberId: string;
  };
};
const integer = (value: unknown, positive = false): value is number =>
  Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
function name(value: string): string {
  nmString(value, "reported_financial_name");
  nmCheck(
    value.length <= 4000 && nmKey(value).length <= 4000,
    "reported_financial_name_length",
  );
  nmCheck(
    !/^(?:UNKNOWN|ANONYMOUS|UNITEMIZED|NOT PROVIDED|N\/A)$/i.test(value.trim()),
    "unresolved_financial_name",
  );
  return value;
}
export function qualifyNewMexicoReportedContext(
  receiver: NewMexicoReportedReceiver,
  registrations: readonly NewMexicoNativeCandidate[],
  detail: NmNativeObject,
): NewMexicoReportedContext {
  const registration = qualifyNewMexicoReportedReceiver(
    receiver,
    registrations,
  );
  qualifyNewMexicoReceiverDetail(receiver, registration, detail);
  return {
    registration,
    detail: {
      candidateName: nmString(detail.CandidateName),
      officeName: nmString(detail.OfficeName),
      electionYear: receiver.electionYear,
      memberId: nmString(detail.MemberID),
    },
  };
}
function add(
  groups: Map<string, NewMexicoReportedGroup>,
  reportedName: string,
  stance: NewMexicoReportedGroup["stance"],
  amount: number,
): void {
  name(reportedName);
  nmCheck(integer(amount, true), "positive_native_amount");
  const normalized = nmKey(reportedName),
    key = `${stance}:${normalized}`,
    group = groups.get(key) ?? {
      key: normalized,
      reportedName,
      stance,
      amountCents: 0,
      occurrenceCount: 0,
    };
  group.amountCents = nmAdd(group.amountCents, amount);
  group.occurrenceCount++;
  if (reportedName.localeCompare(group.reportedName) < 0)
    group.reportedName = reportedName;
  groups.set(key, group);
}
function sorted(
  groups: Map<string, NewMexicoReportedGroup>,
): NewMexicoReportedGroup[] {
  return [...groups.values()].sort(
    (a, b) =>
      b.amountCents - a.amountCents ||
      a.key.localeCompare(b.key) ||
      a.stance.localeCompare(b.stance),
  );
}
export function aggregateNewMexicoReportedCommittee(input: {
  receiver: NewMexicoReportedReceiver;
  context: NewMexicoReportedContext;
  financial: NewMexicoNativeDataset;
}): NewMexicoReportedAggregation {
  const { financial, context, receiver } = input,
    rows = financial.receipts,
    scopes = financial.receivingScopes;
  nmCheck(
    Array.isArray(rows) &&
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      integer(financial.receivingRows, true) &&
      integer(financial.currentCycleRows, true) &&
      integer(financial.financialCycleId, true) &&
      integer(financial.excludedRows) &&
      Number.isSafeInteger(financial.receivingAmountCents) &&
      Number.isSafeInteger(financial.excludedAmountCents),
    "complete_receiving_controls",
  );
  let count = 0,
    current = 0;
  for (const scope of scopes) {
    nmCheck(integer(scope.rowCount, true), "receiving_scope_count");
    count = nmAdd(count, scope.rowCount);
    if (scope.financialCycleId !== financial.financialCycleId) continue;
    current = nmAdd(current, scope.rowCount);
    nmCheck(
      scope.officeId === context.registration.officeId &&
        scope.electionId === context.registration.electionId &&
        scope.districtId === context.registration.districtId &&
        scope.electionYear === receiver.electionYear &&
        nmPersonMatches(
          [
            ...receiver.candidateAliases,
            context.registration.candidateName,
            context.detail.candidateName,
          ],
          scope.reportedName,
        ),
      "receiving_native_person_office_election_scope",
    );
  }
  nmCheck(
    count === financial.receivingRows && current === financial.currentCycleRows,
    "complete_receiving_scope_closure",
  );
  const groups = new Map<string, NewMexicoReportedGroup>();
  let total = 0;
  for (const row of rows) {
    nmCheck(
      row.financialCycleId === financial.financialCycleId &&
        ["MOI", "IKD"].includes(row.category) &&
        ["transaction", "registered_member"].includes(row.nameProof) &&
        !!row.filedDate,
      "qualified_committee_gift",
    );
    add(groups, row.reportedName, "committee", row.amountCents);
    total = nmAdd(total, row.amountCents);
  }
  nmCheck(
    rows.length + financial.excludedRows === financial.receivingRows &&
      nmAdd(total, financial.excludedAmountCents!) ===
        financial.receivingAmountCents,
    "whole_receiving_money_count_closure",
  );
  return {
    groups: sorted(groups),
    controls: {
      totalAmountCents: total,
      contributionCount: rows.length,
      sourceReceivingRows: financial.receivingRows,
      sourceReceivingAmountCents: financial.receivingAmountCents!,
      currentCycleRows: financial.currentCycleRows,
      financialCycleId: financial.financialCycleId,
      excludedRows: financial.excludedRows,
      excludedAmountCents: financial.excludedAmountCents!,
    },
  };
}
export function aggregateNewMexicoReportedIe(input: {
  receiver: NewMexicoReportedReceiver;
  context: NewMexicoReportedContext;
  registrations: readonly NewMexicoNativeCandidate[];
  financial: NewMexicoNativeDataset;
}): NewMexicoReportedAggregation {
  const { receiver, context } = input,
    allocations = input.financial.allocations;
  nmCheck(Array.isArray(allocations), "complete_ie_population");
  const aliases = [
      ...receiver.candidateAliases,
      context.registration.candidateName,
      context.detail.candidateName,
    ],
    groups = new Map<string, NewMexicoReportedGroup>();
  let supportCents = 0,
    opposeCents = 0,
    allocationCount = 0,
    excludedAllocationRows = 0;
  for (const row of allocations) {
    if (row.targetKind === "BQC") {
      excludedAllocationRows++;
      continue;
    }
    const names = [row.targetName, row.targetDescription].filter(
        (value): value is string => !!value,
      ),
      id = String(row.targetId) === receiver.receivingId;
    const possible = names.some((value) => nmPotentialPerson(aliases, value));
    if (!id && !possible) {
      excludedAllocationRows++;
      continue;
    }
    nmCheck(
      id &&
        names.length === 2 &&
        names.every((value) => nmPersonMatches(aliases, value)),
      "explicit_ie_target_id_person_conflict",
    );
    const registered = input.registrations.filter(
      (candidate) =>
        candidate.electionYear === receiver.electionYear &&
        nmPersonMatches(names, candidate.candidateName),
    );
    nmCheck(
      registered.length === 1 &&
        registered[0]!.locator === context.registration.locator &&
        nmNativeDistrict(registered[0]!) ===
          nmNativeDistrict(context.registration),
      "ambiguous_ie_registered_target_scope",
    );
    nmCheck(row.filedDate !== null, "ie_target_missing_filing_date");
    add(groups, row.reportingName, row.support, row.amountCents);
    allocationCount++;
    if (row.support === "support")
      supportCents = nmAdd(supportCents, row.amountCents);
    else opposeCents = nmAdd(opposeCents, row.amountCents);
  }
  nmCheck(
    allocationCount + excludedAllocationRows === allocations.length,
    "whole_ie_population_closure",
  );
  return {
    groups: sorted(groups),
    controls: {
      supportCents,
      opposeCents,
      allocationCount,
      sourceAllocationRows: allocations.length,
      excludedAllocationRows,
    },
  };
}
