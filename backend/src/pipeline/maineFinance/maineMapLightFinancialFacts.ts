import type { MaineMapLightAllFilerTransaction } from "./maineMapLightAllFilerCsv.js";
import type { MaineMapLightIndependentExpenditureAllocation } from "./maineMapLightIndependentExpenditureCsv.js";
import {
  parseMaineMapLightCivilDate,
  parseMaineMapLightSourceId,
} from "./maineMapLightCsvPrimitives.js";
import { parseMaineMapLightReportControls } from "./maineMapLightReportControls.js";

export interface MaineMapLightFinancialSourceContext {
  filerId: string;
  filerName: string;
  office: string;
  district: string;
  electionYear: number;
  publishedAsOfDate: string;
}
export interface MaineMapLightCommitteeDonorPosition {
  committeeId: string;
  committeeName: string;
  sourceReportedClass:
    "political_action_committee" | "political_party_committee";
  amountCents: number;
  contributionCount: number;
  giftTransactionIds: string[];
  returnedTransactionIds: string[];
}
export interface MaineMapLightOrdinaryReturnReportSource {
  html: string;
  sourceUrl: string;
}
export interface MaineMapLightFinancialFacts {
  sourceContext: MaineMapLightFinancialSourceContext;
  /** Published-year facts, including other election labels and noncash mechanisms. */
  candidateTransactions: MaineMapLightAllFilerTransaction[];
  committeeDonorPositions?: MaineMapLightCommitteeDonorPosition[];
  /** All exact-ID target facts; unknown payers remain here, not in usable allocations. */
  targetedAllocationFacts: MaineMapLightIndependentExpenditureAllocation[];
  outsideAllocations?: MaineMapLightIndependentExpenditureAllocation[];
  outsideOmittedPayers: {
    filerId: string;
    filerName: string;
    reason: string;
  }[];
  diagnostics: string[];
}

function fail(reason: string): never {
  throw new Error(`Maine MapLight financial facts: ${reason}`);
}
function safeSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value))
      fail("unsafe exact-cent control");
    total += value;
  }
  return total;
}
function reportedKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}
function committeeClass(
  value: string,
): value is MaineMapLightCommitteeDonorPosition["sourceReportedClass"] {
  return (
    value === "political_action_committee" ||
    value === "political_party_committee"
  );
}
function copyTransaction(
  row: MaineMapLightAllFilerTransaction,
): MaineMapLightAllFilerTransaction {
  const {
    occurrence,
    transactionId,
    filerId,
    filerName,
    filerFirstName,
    filerLastName,
    filerOffice,
    filerDistrict,
    filerCounty,
    sourceRole,
    transactionDate,
    amount,
    amountCents,
    election,
    description,
    counterpartyClass,
    counterpartyName,
    purpose,
    expenditureTargets,
  } = row;
  return {
    occurrence,
    transactionId,
    filerId,
    filerName,
    filerFirstName,
    filerLastName,
    filerOffice,
    filerDistrict,
    filerCounty,
    sourceRole,
    transactionDate,
    amount,
    amountCents,
    election,
    description,
    counterpartyClass,
    counterpartyName,
    purpose,
    expenditureTargets,
  };
}
function copyAllocation(
  row: MaineMapLightIndependentExpenditureAllocation,
): MaineMapLightIndependentExpenditureAllocation {
  const {
    occurrence,
    transactionId,
    filerId,
    filerName,
    transactionType,
    transactionDate,
    totalTransactionAmount,
    totalTransactionAmountCents,
    description,
    purpose,
    candidateName,
    candidateId,
    supportOppose,
    amountSpentOnCandidate,
    amountSpentOnCandidateCents,
  } = row;
  return {
    occurrence,
    transactionId,
    filerId,
    filerName,
    transactionType,
    transactionDate,
    totalTransactionAmount,
    totalTransactionAmountCents,
    description,
    purpose,
    candidateName,
    candidateId,
    supportOppose,
    amountSpentOnCandidate,
    amountSpentOnCandidateCents,
  };
}

/** Reconcile complete export transaction sets, not repeated filing references or targets by name. */
function reconcileIndependentTransactions(
  transactions: readonly MaineMapLightAllFilerTransaction[],
  allocations: readonly MaineMapLightIndependentExpenditureAllocation[],
): void {
  const allIds = new Set<string>();
  const expenditureMap = new Map<string, MaineMapLightAllFilerTransaction>();
  for (const transaction of transactions) {
    if (allIds.has(transaction.transactionId))
      fail("duplicate all-filer transaction ID");
    allIds.add(transaction.transactionId);
    if (!Number.isSafeInteger(transaction.amountCents))
      fail("unsafe source amount");
    if (
      transaction.sourceRole ===
      "independent_expenditure - independent_expenditure"
    )
      expenditureMap.set(transaction.transactionId, transaction);
  }
  const grouped = new Map<string, number[]>();
  const keys = new Set<string>();
  for (const allocation of allocations) {
    const transaction = expenditureMap.get(allocation.transactionId);
    if (
      !transaction ||
      allocation.transactionType !== "independent_expenditure" ||
      transaction.filerId !== allocation.filerId ||
      transaction.filerName !== allocation.filerName ||
      transaction.transactionDate !== allocation.transactionDate ||
      transaction.amountCents !== allocation.totalTransactionAmountCents
    ) {
      fail("independent export transaction identity/control mismatch");
    }
    const key = JSON.stringify([
      allocation.transactionId,
      allocation.candidateId === null
        ? ["name", allocation.candidateName]
        : ["id", allocation.candidateId],
      allocation.supportOppose,
    ]);
    if (keys.has(key)) fail("duplicate independent allocation key");
    keys.add(key);
    if (
      allocation.supportOppose !== "support" &&
      allocation.supportOppose !== "oppose"
    )
      fail("unknown allocation direction");
    grouped.set(allocation.transactionId, [
      ...(grouped.get(allocation.transactionId) ?? []),
      allocation.amountSpentOnCandidateCents,
    ]);
  }
  if (grouped.size !== expenditureMap.size)
    fail("independent export transaction set mismatch");
  for (const [id, amounts] of grouped) {
    if (safeSum(amounts) !== expenditureMap.get(id)!.amountCents)
      fail("independent allocation sum mismatch");
  }
}

function sourceCashPositions(
  rows: readonly MaineMapLightAllFilerTransaction[],
  context: MaineMapLightFinancialSourceContext,
  diagnostics: string[],
): MaineMapLightCommitteeDonorPosition[] | undefined {
  const cash = rows.filter(
    (row) =>
      row.sourceRole === "contribution - monetary" ||
      row.sourceRole === "returned - returned_monetary",
  );
  const selected: MaineMapLightAllFilerTransaction[] = [];
  const reviewedReturnClasses = new Set([
    "individual",
    "business",
    "financial_institution",
    "nonprofit_organization",
    "political_action_committee",
    "candidate",
    "political_party_committee",
    "candidate_committee",
    "ballot_question_committee",
  ]);
  for (const row of cash) {
    const explicitYear = /^(\d{4}) (?:Primary|General) Election$/.exec(
      row.election,
    )?.[1];
    if (explicitYear && Number(explicitYear) !== context.electionYear) continue;
    if (
      row.election !== `${context.electionYear} Primary Election` &&
      row.election !== `${context.electionYear} General Election`
    ) {
      diagnostics.push("candidate_cash_election_context_unknown");
      return undefined;
    }
    if (row.amountCents < 0) {
      diagnostics.push("candidate_cash_signed_role_unreviewed");
      return undefined;
    }
    if (
      row.sourceRole === "returned - returned_monetary" &&
      (!reviewedReturnClasses.has(row.counterpartyClass) ||
        !row.counterpartyName.trim())
    ) {
      diagnostics.push("candidate_cash_return_identity_unknown");
      return undefined;
    }
    selected.push(row);
  }
  const classes = new Map<string, Set<string>>();
  for (const row of selected) {
    if (!row.counterpartyName.trim()) {
      if (committeeClass(row.counterpartyClass)) {
        diagnostics.push("committee_reported_name_missing");
        return undefined;
      }
      continue;
    }
    const key = reportedKey(row.counterpartyName);
    const set = classes.get(key) ?? new Set<string>();
    set.add(row.counterpartyClass);
    classes.set(key, set);
  }
  for (const [name, set] of classes) {
    if (
      [...set].some(committeeClass) &&
      (set.size !== 1 || name === reportedKey(context.filerName))
    ) {
      diagnostics.push("committee_reported_identity_ambiguous");
      return undefined;
    }
  }
  const groups = new Map<string, MaineMapLightCommitteeDonorPosition>();
  for (const row of selected) {
    if (!committeeClass(row.counterpartyClass)) continue;
    const committeeId = `reported:${reportedKey(row.counterpartyName)}`;
    const group = groups.get(committeeId) ?? {
      committeeId,
      committeeName: row.counterpartyName,
      sourceReportedClass: row.counterpartyClass,
      amountCents: 0,
      contributionCount: 0,
      giftTransactionIds: [],
      returnedTransactionIds: [],
    };
    const isGift = row.sourceRole === "contribution - monetary";
    group.amountCents = safeSum([
      group.amountCents,
      isGift ? row.amountCents : -row.amountCents,
    ]);
    if (isGift) {
      group.giftTransactionIds.push(row.transactionId);
      if (row.amountCents > 0) group.contributionCount += 1;
    } else group.returnedTransactionIds.push(row.transactionId);
    groups.set(committeeId, group);
  }
  return groups.size ? [...groups.values()] : undefined;
}

function sameSchedule(
  sourceRows: readonly MaineMapLightAllFilerTransaction[],
  reportRows: readonly {
    transactionId: string;
    date: string;
    amountCents: number;
  }[],
): boolean {
  const source = new Map(sourceRows.map((row) => [row.transactionId, row]));
  if (
    source.size !== sourceRows.length ||
    reportRows.length !== sourceRows.length
  )
    return false;
  const seen = new Set<string>();
  for (const row of reportRows) {
    const match = source.get(row.transactionId);
    if (
      seen.has(row.transactionId) ||
      !match ||
      match.transactionDate !== row.date ||
      match.amountCents !== row.amountCents
    )
      return false;
    seen.add(row.transactionId);
  }
  return true;
}

/** Exact source report sections classify only their joined ordinary returns. No latest-report selection. */
function classifyOrdinaryReturns(
  rows: readonly MaineMapLightAllFilerTransaction[],
  reports: readonly MaineMapLightOrdinaryReturnReportSource[],
  context: MaineMapLightFinancialSourceContext,
  diagnostics: string[],
): Set<string> {
  const qualified = new Set<string>();
  const contradicted = new Set<string>();
  for (const source of reports) {
    try {
      const report = parseMaineMapLightReportControls(
        source.html,
        source.sourceUrl,
      );
      const payerRows = rows.filter((row) => row.filerId === report.filerId);
      for (const row of report.returnedIndependentExpenditures.rows)
        contradicted.add(row.transactionId);
      const periodRows = payerRows.filter(
        (row) =>
          row.transactionDate >= report.periodStart &&
          row.transactionDate <= report.periodEnd,
      );
      const expenses = periodRows.filter(
        (row) => row.sourceRole === "expenditure - expenditure",
      );
      const returns = periodRows.filter(
        (row) => row.sourceRole === "returned - returned_expenditure",
      );
      const independent = periodRows.filter(
        (row) =>
          row.sourceRole ===
          "independent_expenditure - independent_expenditure",
      );
      const ieControl = report.summaryControls.find(
        (control) => control.label === "Total Independent Expenditures",
      )?.amountCents;
      const expenditureControl = report.summaryControls.find(
        (control) => control.label === "Total Expenditures",
      )?.amountCents;
      if (
        !payerRows.length ||
        payerRows.some((row) => row.filerName !== report.filerName) ||
        report.periodStart < `${context.electionYear}-01-01` ||
        report.periodEnd > context.publishedAsOfDate ||
        report.sourceSubmittedAt.slice(0, 10) > context.publishedAsOfDate ||
        !sameSchedule(expenses, report.expenditures.rows) ||
        !sameSchedule(returns, report.returnedExpenditures.rows) ||
        !sameSchedule(independent, report.independentExpenditures.rows) ||
        report.returnedIndependentExpenditures.rows.length !== 0 ||
        report.returnedIndependentExpenditures.totalCents !== 0 ||
        report.returnedIndependentExpenditures.emptyStatement === null ||
        report.independentExpenditures.totalCents !== ieControl ||
        safeSum([
          report.expenditures.totalCents,
          -report.returnedExpenditures.totalCents,
        ]) !== expenditureControl ||
        returns.some((row) => row.amountCents <= 0)
      ) {
        diagnostics.push("ordinary_return_report_source_join_unavailable");
        continue;
      }
      for (const row of returns) qualified.add(row.transactionId);
    } catch {
      diagnostics.push("ordinary_return_report_source_unavailable");
    }
  }
  for (const id of contradicted) qualified.delete(id);
  return qualified;
}

/**
 * Published-year itemized source positions and allocation facts, never canonical finance authority.
 * Missing prior-year/paper/current-version coverage is not repaired here. Empty facts are not zeros.
 */
export function produceMaineMapLightFinancialFacts(input: {
  sourceContext: MaineMapLightFinancialSourceContext;
  allFilerTransactions: readonly MaineMapLightAllFilerTransaction[];
  ieAllocations: readonly MaineMapLightIndependentExpenditureAllocation[];
  ordinaryReturnReports?: readonly MaineMapLightOrdinaryReturnReportSource[];
}): MaineMapLightFinancialFacts {
  const context = { ...input.sourceContext };
  parseMaineMapLightSourceId(context.filerId, "f", fail);
  parseMaineMapLightCivilDate(context.publishedAsOfDate, fail);
  if (
    !context.filerName.trim() ||
    !Number.isInteger(context.electionYear) ||
    context.electionYear < 2024 ||
    context.electionYear > 2100 ||
    context.publishedAsOfDate < `${context.electionYear}-01-01`
  )
    fail("invalid candidate source context");
  reconcileIndependentTransactions(
    input.allFilerTransactions,
    input.ieAllocations,
  );
  const diagnostics: string[] = [];
  const start = `${context.electionYear}-01-01`;
  const end =
    context.publishedAsOfDate < `${context.electionYear}-12-31`
      ? context.publishedAsOfDate
      : `${context.electionYear}-12-31`;
  const inScope = (date: string) => date >= start && date <= end;
  const candidateTransactions = input.allFilerTransactions
    .filter(
      (row) => row.filerId === context.filerId && inScope(row.transactionDate),
    )
    .map(copyTransaction);
  const cashContextMatches =
    candidateTransactions.length > 0 &&
    candidateTransactions.every(
      (row) =>
        row.filerName === context.filerName &&
        row.filerOffice === context.office &&
        row.filerDistrict === context.district,
    );
  const committeeDonorPositions = cashContextMatches
    ? sourceCashPositions(candidateTransactions, context, diagnostics)
    : undefined;
  if (!cashContextMatches)
    diagnostics.push("candidate_cash_source_context_unavailable");
  const targeted = input.ieAllocations.filter(
    (row) =>
      row.candidateId === context.filerId && inScope(row.transactionDate),
  );
  const targetedAllocationFacts = targeted.map(copyAllocation);
  const outsideOmittedPayers: MaineMapLightFinancialFacts["outsideOmittedPayers"] =
    [];
  const knownOrdinaryReturns = classifyOrdinaryReturns(
    input.allFilerTransactions,
    input.ordinaryReturnReports ?? [],
    context,
    diagnostics,
  );
  const usable: MaineMapLightIndependentExpenditureAllocation[] = [];
  const payerIds = new Set(targeted.map((row) => row.filerId));
  for (const payerId of payerIds) {
    const allocations = targeted.filter((row) => row.filerId === payerId);
    const returns = input.allFilerTransactions.filter(
      (row) =>
        row.filerId === payerId &&
        row.sourceRole === "returned - returned_expenditure" &&
        inScope(row.transactionDate),
    );
    let reason: string | undefined;
    if (allocations.some((row) => row.candidateName !== context.filerName))
      reason = "target_reported_name_mismatch";
    else if (allocations.some((row) => row.amountSpentOnCandidateCents <= 0))
      reason = "outside_signed_or_zero_role_unreviewed";
    else if (
      returns.some((row) => !knownOrdinaryReturns.has(row.transactionId))
    )
      reason = "outside_return_role_unknown";
    if (reason)
      outsideOmittedPayers.push({
        filerId: payerId,
        filerName: allocations[0].filerName,
        reason,
      });
    else usable.push(...allocations.map(copyAllocation));
  }
  return {
    sourceContext: context,
    candidateTransactions,
    committeeDonorPositions,
    targetedAllocationFacts,
    outsideAllocations: usable.length ? usable : undefined,
    outsideOmittedPayers,
    diagnostics,
  };
}
