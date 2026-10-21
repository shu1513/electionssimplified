import { isDeepStrictEqual } from "node:util";
import {
  NM_REPORTED_PATHS,
  nmAdd,
  nmCents,
  nmCheck,
  nmCountedRows,
  nmDate,
  nmEmptyDistrictId,
  nmId,
  nmKey,
  nmObject,
  nmString,
  type NmNativeObject,
} from "./newMexicoReportedNative.js";
import {
  NewMexicoOriginalSequence,
  type NewMexicoOriginal,
} from "./newMexicoReportedOriginals.js";
import {
  nmPersonMatches,
  parseNewMexicoNativeCandidate,
  type NewMexicoNativeCandidate,
} from "./newMexicoReportedReceiver.js";

export type NewMexicoNativeReceivingScope = {
  nativeReceivingId: string;
  nativeRegistrationId: string;
  reportedName: string;
  officeId: number;
  districtId: number | null;
  electionId: number;
  electionYear: number;
  financialCycleId: number;
  rowCount: number;
};
export type NewMexicoReportedReceipt = {
  transactionId: number;
  version: number;
  financialCycleId: number;
  reportedName: string;
  nativeDonorId: string;
  amountCents: number;
  date: string;
  filedDate: string;
  category: "MOI" | "IKD";
  nameProof: "transaction" | "registered_member";
};
export type NewMexicoReportedAllocation = {
  transactionId: number;
  version: number;
  reportingName: string;
  reportingId: string;
  amountCents: number;
  date: string;
  filedDate: string | null;
  targetKind: "CAN" | "BQC";
  targetName: string | null;
  targetDescription: string | null;
  targetId: number | null;
  support: "support" | "oppose";
  historyCount: number;
};
export type NewMexicoNativeDataset = {
  registrations?: NewMexicoNativeCandidate[];
  receiver?: NmNativeObject;
  receivingScopes?: NewMexicoNativeReceivingScope[];
  receipts?: NewMexicoReportedReceipt[];
  receivingRows?: number;
  receivingAmountCents?: number;
  excludedRows?: number;
  excludedAmountCents?: number;
  financialCycleId?: number;
  currentCycleRows?: number;
  allocations?: NewMexicoReportedAllocation[];
};
const PAGE_SIZE = 1000;
const MAX_ROWS = 1_000_000;
const CONTRIBUTOR_CLASSES = new Set([
  "Individual",
  "Other (e.g. business entity)",
  "Political Committee",
  "Lobbying Organization",
  "Candidate",
  "Candidate/Officeholder",
]);
const CONTRIBUTION_TYPES = new Set([
  "Monetary",
  "In-Kind",
  "Anonymous",
  "Intra-Candidate Transfer",
]);
const POLITICAL_REGISTRATIONS = new Set([
  "Political Committee - Independent Expenditure",
  "Political Committee - Other",
  "Political Committee - Contribution or Coordination",
  "Political Committee - Political Party/Central Committee",
]);
const count = (value: unknown): number => {
  nmCheck(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "native_nonnegative_count",
  );
  return value;
};
const optionalDate = (value: unknown, observedAt: string): string | null =>
  value === null ? null : nmDate(value, observedAt);
const query = (path: string, values: Record<string, string | number>) =>
  path +
  "?" +
  new URLSearchParams(
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
  );
function currentStatus(row: NmNativeObject): void {
  for (const key of ["DeleteFlag", "StatusFlag", "Amended"])
    nmCheck(
      row[key] === null || row[key] === 0 || row[key] === false,
      "unsupported_transaction_status",
    );
}
function financialBinding(grid: NmNativeObject, detail: NmNativeObject): void {
  nmCheck(
    detail.TransactionId === grid.TransactionId &&
      detail.TransactionVersid === grid.TransactionVersionId &&
      nmCents(detail.TransactionAmount) === nmCents(grid.Amount) &&
      detail.TransactionDate === grid.TransactionDate &&
      detail.FiledDate === grid.FiledDate &&
      detail.TransactionCategoryDesc === grid.Type,
    "native_transaction_detail_changed",
  );
  currentStatus(detail);
}
function transactionQuery(
  year: number,
  kind: "committee" | "ie",
  selector: string | null,
  pageNumber: number,
): Record<string, unknown> {
  return {
    TransactionType: kind === "committee" ? "CON" : "IE",
    CommitteeType: null,
    ElectionYear: String(year),
    CommitteeName: selector,
    TransactionCategoryCode: null,
    AmountType: null,
    ContributorPayeeName: null,
    TransactionBeginDate: null,
    TransactionEndDate: null,
    TransactionAmount: null,
    TransactionUnderAmount: null,
    ValidationRequired: 0,
    DisplayId: null,
    pageNumber,
    pageSize: PAGE_SIZE,
    SortedBy: "TransactionDate",
    sortDir: "asc",
  };
}
function registryQuery(
  year: number,
  pageNumber: number,
): Record<string, unknown> {
  return {
    ElectionYear: String(year),
    Party: null,
    OfficeSought: null,
    JurisdictionType: null,
    Jurisdiction: null,
    FinanceType: null,
    TransactionType: null,
    TransactionAmount: null,
    DistrictId: null,
    IsCompliance: null,
    pageNumber,
    pageSize: PAGE_SIZE,
    sortDir: "asc",
    sortedBy: "CandidateName",
  };
}

/** Every page is count-controlled and compared with its complete closing
 * observation. Originals retain all fields and repeated occurrences. Only the
 * metric's parsed projection remains in RAM; a large ledger is never capped. */
async function population(
  sequence: NewMexicoOriginalSequence,
  visit: (row: NmNativeObject, original: NewMexicoOriginal) => Promise<void>,
): Promise<number> {
  const { kind, year, selector } = sequence.scope;
  nmCheck(
    kind === "registry" || kind === "committee" || kind === "ie",
    "population_kind",
  );
  const path =
    kind === "registry"
      ? NM_REPORTED_PATHS.registry
      : NM_REPORTED_PATHS.transactions;
  const body = (page: number) =>
    kind === "registry"
      ? registryQuery(year, page)
      : transactionQuery(year, kind, selector, page);
  const opening: { sha256: string; count: number }[] = [];
  let expected: number | undefined,
    offset = 0;
  do {
    const packet = await sequence.request(
      `${kind}_opening_${opening.length + 1}`,
      path,
      body(opening.length + 1),
    );
    const page = nmCountedRows(packet.value, offset, PAGE_SIZE, expected);
    expected ??= page.total;
    nmCheck(expected <= MAX_ROWS, "native_population_resource_limit");
    opening.push({ sha256: packet.original.sha256, count: page.rows.length });
    for (const row of page.rows) await visit(row, packet.original);
    offset += page.rows.length;
  } while (offset < expected);
  offset = 0;
  for (const [index, original] of opening.entries()) {
    const packet = await sequence.request(
      `${kind}_closing_${index + 1}`,
      path,
      body(index + 1),
    );
    const page = nmCountedRows(packet.value, offset, PAGE_SIZE, expected);
    nmCheck(
      packet.original.sha256 === original.sha256 &&
        page.rows.length === original.count,
      "native_closing_population_changed",
    );
    offset += page.rows.length;
  }
  nmCheck(offset === expected, "native_complete_population");
  return expected;
}

async function registry(
  sequence: NewMexicoOriginalSequence,
): Promise<NewMexicoNativeDataset> {
  const registrations: NewMexicoNativeCandidate[] = [];
  await population(sequence, async (row) => {
    registrations.push(parseNewMexicoNativeCandidate(row, sequence.scope.year));
  });
  return { registrations };
}
async function receiver(
  sequence: NewMexicoOriginalSequence,
): Promise<NewMexicoNativeDataset> {
  nmCheck(sequence.scope.selector, "receiving_locator");
  const path = query(NM_REPORTED_PATHS.receiver, {
    memberId: sequence.scope.selector,
  });
  const opening = await sequence.request("receiver_opening", path),
    closing = await sequence.request("receiver_closing", path);
  nmCheck(
    Array.isArray(opening.value) &&
      opening.value.length === 1 &&
      isDeepStrictEqual(opening.value, closing.value),
    "receiving_detail_population",
  );
  const row = nmObject(opening.value[0]);
  nmCheck(row.ElectionYear === sequence.scope.year, "receiving_detail_year");
  return { receiver: row };
}
async function committee(
  sequence: NewMexicoOriginalSequence,
): Promise<NewMexicoNativeDataset> {
  const scopes = new Map<string, NewMexicoNativeReceivingScope>(),
    receipts: NewMexicoReportedReceipt[] = [],
    ids = new Set<number>(),
    profileNames = new Map<string, Set<string>>();
  let receivingRows = 0,
    receivingAmountCents = 0,
    excludedRows = 0,
    excludedAmountCents = 0,
    currentCycleRows = 0;
  nmCheck(sequence.scope.selector, "receiving_name_selector");
  nmCheck(sequence.scope.memberId, "receiving_cycle_member_selector");
  const cyclePath = query(NM_REPORTED_PATHS.cycle, {
      memberID: sequence.scope.memberId,
    }),
    cycleOpening = await sequence.request("committee_cycle_opening", cyclePath);
  const cycles = nmObject(cycleOpening.value),
    matches = Object.entries(cycles).filter(
      ([, label]) =>
        typeof label === "string" &&
        label.match(/\b(?:19|20)\d{2}\b/g)?.join(",") ===
          String(sequence.scope.year),
    );
  nmCheck(
    matches.length === 1 && /^[1-9]\d*$/.test(matches[0]![0]),
    "unique_native_financial_cycle",
  );
  const financialCycleId = nmId(Number(matches[0]![0]));
  await population(sequence, async (row, original) => {
    const id = nmId(row.TransactionId),
      version = nmId(row.TransactionVersionId),
      amountCents = nmCents(row.Amount),
      date = nmDate(row.TransactionDate, original.startedAt);
    nmCheck(!ids.has(id), "duplicate_current_transaction_id");
    ids.add(id);
    nmCheck(
      row.ElectionYear === sequence.scope.year &&
        row.CommitteeTypeCode === "01" &&
        nmPersonMatches([sequence.scope.selector!], nmString(row.Name)),
      "native_receiving_query_scope",
    );
    const scope = {
      nativeReceivingId: nmString(row.CommitteeId),
      nativeRegistrationId: nmString(row.RegistrationID),
      reportedName: nmString(row.Name),
      officeId: nmId(row.OfficeId),
      districtId: nmEmptyDistrictId(row.DistrictId),
      electionId: nmId(row.ElectionId),
      electionYear: sequence.scope.year,
      financialCycleId: nmId(row.ElectionCycleId),
      rowCount: 0,
    };
    const scopeKey = JSON.stringify(scope),
      storedScope = scopes.get(scopeKey) ?? scope;
    storedScope.rowCount++;
    scopes.set(scopeKey, storedScope);
    receivingRows++;
    receivingAmountCents = nmAdd(receivingAmountCents, amountCents);
    // Registration-year labels are not a substitute for this actual financial
    // foreign key. Preserve other cycles in full raw/count/money controls.
    if (scope.financialCycleId !== financialCycleId) {
      excludedRows++;
      excludedAmountCents = nmAdd(excludedAmountCents, amountCents);
      return;
    }
    currentCycleRows++;
    const type = nmString(row.Type),
      contributor = row.EntityTypeDescription;
    nmCheck(
      CONTRIBUTION_TYPES.has(type) &&
        ((typeof contributor === "string" &&
          CONTRIBUTOR_CLASSES.has(contributor)) ||
          (contributor === null && type === "Anonymous")),
      "unknown_receipt_type_or_class",
    );
    if (
      contributor !== "Political Committee" ||
      type === "Intra-Candidate Transfer" ||
      amountCents === 0
    ) {
      excludedRows++;
      excludedAmountCents = nmAdd(excludedAmountCents, amountCents);
      return;
    }
    nmCheck(
      amountCents > 0 && (type === "Monetary" || type === "In-Kind"),
      "unsupported_political_receipt",
    );
    const filedDate = optionalDate(row.FiledDate, original.startedAt);
    nmCheck(filedDate, "political_receipt_without_filing_date");
    const detail = await sequence.request(
      `committee_detail_${receipts.length + 1}`,
      query(NM_REPORTED_PATHS.contribution, {
        transactionID: id,
        transactionVersID: version,
        transactionTypeCode: "CON",
      }),
    );
    nmCheck(
      Array.isArray(detail.value) && detail.value.length === 1,
      "political_receipt_detail_population",
    );
    const transaction = nmObject(detail.value[0]);
    financialBinding(row, transaction);
    nmCheck(
      transaction.ElectionId === row.ElectionCycleId,
      "political_receipt_financial_cycle_changed",
    );
    const category = type === "Monetary" ? "MOI" : "IKD";
    nmCheck(
      transaction.TransactionTypeCode === "CON" &&
        transaction.TransactionCategoryCode === category &&
        transaction.EntityTypeCode === "COM" &&
        transaction.EntityTypeCodeDesc === "Political Committee",
      "political_receipt_class_binding",
    );
    const reportedName = nmString(row.ContributorPayeeName),
      nativeDonorId = nmString(transaction.MemberId);
    let nameProof: NewMexicoReportedReceipt["nameProof"] = "transaction";
    if (nmKey(reportedName) !== nmKey(nmString(transaction.CommitteeName))) {
      let names = profileNames.get(nativeDonorId);
      if (!names) {
        const profile = await sequence.request(
          `committee_registered_name_${profileNames.size + 1}`,
          query(NM_REPORTED_PATHS.donor, { memberId: nativeDonorId }),
        );
        nmCheck(
          Array.isArray(profile.value) &&
            profile.value.length > 0 &&
            profile.value.length < 1000,
          "donor_registered_name_population",
        );
        names = new Set(
          profile.value
            .map(nmObject)
            .filter(
              (entry) =>
                typeof entry.CommitteeType === "string" &&
                POLITICAL_REGISTRATIONS.has(entry.CommitteeType),
            )
            .map((entry) => nmKey(nmString(entry.CommitteeName))),
        );
        profileNames.set(nativeDonorId, names);
      }
      // The actual financial donor MemberId scopes this public profile. Do not
      // equate default response IDs with legacy OrgIDs or invent name aliases.
      nmCheck(
        names.has(nmKey(reportedName)),
        "unresolved_political_donor_name",
      );
      nameProof = "registered_member";
    }
    receipts.push({
      transactionId: id,
      version,
      financialCycleId,
      reportedName,
      nativeDonorId,
      amountCents,
      date,
      filedDate,
      category,
      nameProof,
    });
  });
  const cycleClosing = await sequence.request(
    "committee_cycle_closing",
    cyclePath,
  );
  nmCheck(
    isDeepStrictEqual(cycleOpening.value, cycleClosing.value),
    "native_financial_cycle_changed",
  );
  nmCheck(
    currentCycleRows > 0 &&
      new Set(
        [...scopes.values()]
          .filter((scope) => scope.financialCycleId === financialCycleId)
          .map((scope) => scope.nativeReceivingId),
      ).size === 1,
    "native_current_receiving_population",
  );
  return {
    receipts,
    receivingScopes: [...scopes.values()],
    receivingRows,
    receivingAmountCents,
    excludedRows,
    excludedAmountCents,
    financialCycleId,
    currentCycleRows,
  };
}
async function ie(
  sequence: NewMexicoOriginalSequence,
): Promise<NewMexicoNativeDataset> {
  const allocations: NewMexicoReportedAllocation[] = [],
    ids = new Set<number>();
  await population(sequence, async (row, original) => {
    const id = nmId(row.TransactionId),
      version = nmId(row.TransactionVersionId),
      amountCents = nmCents(row.Amount),
      date = nmDate(row.TransactionDate, original.startedAt);
    nmCheck(
      !ids.has(id) &&
        row.ElectionYear === sequence.scope.year &&
        amountCents > 0,
      "native_ie_population_scope",
    );
    ids.add(id);
    const detail = await sequence.request(
      `ie_detail_${allocations.length + 1}`,
      query(NM_REPORTED_PATHS.expenditure, {
        transactionID: id,
        transactionVersID: version,
      }),
    );
    const body = nmObject(detail.value),
      transaction = nmObject(body.Transaction),
      target = nmObject(body.MemberCandidate);
    financialBinding(row, transaction);
    nmCheck(
      transaction.TransactionTypeCode === "IE" &&
        transaction.TransactionCategoryCode === "IIE" &&
        transaction.CommitteeVersid === row.CommitteeVersionId &&
        transaction.ElectionId === row.ElectionCycleId,
      "native_ie_detail_scope",
    );
    for (const field of [
      "AssociatedCandidateDetails",
      "Expenseslist",
      "IndependentContractorList",
      "AssociatedCandidatesList",
      "BallotQuestionTypeList",
    ])
      nmCheck(
        body[field] === null ||
          body[field] === undefined ||
          (Array.isArray(body[field]) && body[field].length === 0),
        "unsupported_multiple_target_allocation",
      );
    nmCheck(
      target.CandidateType === "CAN" || target.CandidateType === "BQC",
      "unknown_ie_target_type",
    );
    nmCheck(
      target.SupportFlag === 0 || target.SupportFlag === 1,
      "unknown_ie_stance",
    );
    const support = target.SupportFlag === 1 ? "support" : "oppose";
    nmCheck(
      row.Stance === (support === "support" ? "Support" : "Oppose"),
      "ie_stance_changed",
    );
    if (target.CandidateType === "CAN")
      nmCheck(
        target.BallotQuestion === null || target.BallotQuestion === "",
        "mixed_candidate_ballot_target",
      );
    nmCheck(
      target.TransactionAmount === null && target.Amount === null,
      "unsupported_single_target_amount",
    );
    allocations.push({
      transactionId: id,
      version,
      reportingName: nmString(row.Name),
      reportingId: nmString(row.CommitteeId),
      amountCents,
      date,
      filedDate: optionalDate(row.FiledDate, original.startedAt),
      targetKind: target.CandidateType,
      targetName:
        target.CandidateType === "CAN" ? nmString(target.CandidateName) : null,
      targetDescription:
        target.CandidateType === "CAN"
          ? nmString(target.CandidateDescription)
          : null,
      targetId:
        target.CandidateType === "CAN" ? nmId(target.CandidateId) : null,
      support,
      historyCount: count(transaction.TransactionHistory),
    });
  });
  return { allocations };
}
export async function runNewMexicoNativeProtocol(
  sequence: NewMexicoOriginalSequence,
): Promise<NewMexicoNativeDataset> {
  switch (sequence.scope.kind) {
    case "registry":
      return registry(sequence);
    case "receiver":
      return receiver(sequence);
    case "committee":
      return committee(sequence);
    case "ie":
      return ie(sequence);
  }
}
