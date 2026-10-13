/** Pure projection of caller-qualified current cash facts; no acquisition or version selection. */
export type SanFranciscoCommitteeCashOccurrence = {
  occurrenceId: string;
  formType: string;
  transactionCode: string | null;
  entityCode: string | null;
  reportedName: string | null;
  /** Reported evidence only: this can conflict with the legal donor identity. */
  reportedCommitteeId: string | null;
  amountCents: number;
  memoCode: boolean | null;
};

export type SanFranciscoCommitteeCashPosition = {
  committeeId: string;
  committeeName: string;
  sourceReportedClass: "COM" | "SCC";
  amountCents: number;
  contributionCount: number;
  giftOccurrenceIds: string[];
  returnOccurrenceIds: string[];
  reportedCommitteeIds: string[];
};

export type SanFranciscoCommitteeCashResult = {
  positions: SanFranciscoCommitteeCashPosition[];
  totalAmountCents: number;
  diagnostics: {
    excludedMemoCount: number;
    excludedOtherFormCount: number;
    excludedOtherClassCount: number;
  };
};

const KNOWN_ENTITY_CODES = new Set(["IND", "COM", "SCC", "PTY", "OTH"]);

const nameKey = (name: string) =>
  name.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
function addCents(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum))
    throw new Error("SF committee cash sum exceeds safe cents");
  return sum;
}

/**
 * A is monetary; C/in-kind, B1 loans and public funds are not committee cash.
 * unpairedCashF497Rows MUST already exclude re-reported, loan and public-fund
 * occurrences under the caller's source-backed association rules. E/RFD uses
 * the published nonnegative expense magnitude, not a guessed original gift.
 * Source coverage/currentness and known candidate/party exclusions are caller
 * responsibilities. This result claims reported COM/SCC positions, not PACs.
 */
export function aggregateSanFranciscoCommitteeCash(input: {
  scheduleARows: readonly SanFranciscoCommitteeCashOccurrence[];
  unpairedCashF497Rows: readonly SanFranciscoCommitteeCashOccurrence[];
  scheduleEReturnRows: readonly SanFranciscoCommitteeCashOccurrence[];
}): SanFranciscoCommitteeCashResult {
  const positions = new Map<string, SanFranciscoCommitteeCashPosition>();
  const sourceIds = new Set<string>();
  const pendingReturns: {
    row: SanFranciscoCommitteeCashOccurrence;
    key: string;
  }[] = [];
  const diagnostics = {
    excludedMemoCount: 0,
    excludedOtherFormCount: 0,
    excludedOtherClassCount: 0,
  };
  const groups = [
    { rows: input.scheduleARows, form: "A" },
    { rows: input.unpairedCashF497Rows, form: "F497P1" },
    { rows: input.scheduleEReturnRows, form: "E" },
  ];
  for (const { rows, form } of groups)
    for (const row of rows) {
      if (!row.occurrenceId.trim() || sourceIds.has(row.occurrenceId))
        throw new Error(
          "SF committee cash requires unique source occurrence IDs",
        );
      sourceIds.add(row.occurrenceId);
      if (
        (row.formType === "A" ||
          (row.formType === "E" && row.transactionCode === "RFD")) &&
        (!row.entityCode || !KNOWN_ENTITY_CODES.has(row.entityCode))
      )
        throw new Error("SF committee cash donor/return class unavailable");
      if (row.memoCode === true) {
        diagnostics.excludedMemoCount += 1;
        continue;
      }
      if (
        row.formType !== form ||
        (form === "E" && row.transactionCode !== "RFD")
      ) {
        diagnostics.excludedOtherFormCount += 1;
        continue;
      }
      if (row.entityCode !== "COM" && row.entityCode !== "SCC") {
        diagnostics.excludedOtherClassCount += 1;
        continue;
      }
      const normalizedName =
        row.reportedName === null ? "" : nameKey(row.reportedName);
      if (!normalizedName)
        throw new Error(
          `SF committee cash donor unavailable: ${row.occurrenceId}`,
        );
      if (!Number.isSafeInteger(row.amountCents))
        throw new Error(
          `SF committee cash amount is not safe cents: ${row.occurrenceId}`,
        );
      if ((form === "E" || form === "F497P1") && row.amountCents < 0)
        throw new Error(
          `SF committee cash reversal is unresolved: ${row.occurrenceId}`,
        );
      const key = `reported:${row.entityCode}:${normalizedName}`;
      const position = positions.get(key) ?? {
        committeeId: key,
        committeeName: row.reportedName!.trim(),
        sourceReportedClass: row.entityCode,
        amountCents: 0,
        contributionCount: 0,
        giftOccurrenceIds: [],
        returnOccurrenceIds: [],
        reportedCommitteeIds: [],
      };
      // Only observed case/whitespace-equivalent names group; punctuation remains.
      if (row.reportedName!.trim() < position.committeeName)
        position.committeeName = row.reportedName!.trim();
      if (row.reportedCommitteeId !== null)
        position.reportedCommitteeIds.push(row.reportedCommitteeId);
      const cents = form === "E" ? -row.amountCents : row.amountCents;
      position.amountCents = addCents(position.amountCents, cents);
      if (cents > 0) {
        position.giftOccurrenceIds.push(row.occurrenceId);
        position.contributionCount += 1;
        if (position.contributionCount > 2_147_483_647)
          throw new Error("SF committee cash count exceeds int32");
      } else if (cents < 0) {
        position.returnOccurrenceIds.push(row.occurrenceId);
        pendingReturns.push({ row, key });
      }
      positions.set(key, position);
    }
  for (const { row, key } of pendingReturns) {
    const position = positions.get(key)!;
    const matchingNames = [...positions.values()].filter(
      (p) => nameKey(p.committeeName) === nameKey(row.reportedName!),
    );
    if (matchingNames.length !== 1)
      throw new Error(
        `SF committee return class/name ambiguity: ${row.occurrenceId}`,
      );
    const reportedIds = new Set(
      position.reportedCommitteeIds.map((id) => id.trim()).filter(Boolean),
    );
    if (reportedIds.size > 1)
      throw new Error(
        `SF committee return reported ID ambiguity: ${row.occurrenceId}`,
      );
  }
  const sorted = [...positions.values()].sort((a, b) =>
    a.committeeId.localeCompare(b.committeeId),
  );
  let totalAmountCents = 0;
  for (const position of sorted) {
    position.giftOccurrenceIds.sort();
    position.returnOccurrenceIds.sort();
    position.reportedCommitteeIds = [
      ...new Set(position.reportedCommitteeIds),
    ].sort();
    totalAmountCents = addCents(totalAmountCents, position.amountCents);
  }
  return { positions: sorted, totalAmountCents, diagnostics };
}
