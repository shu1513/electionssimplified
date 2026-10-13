import {
  getSanFranciscoCommitteeCashTransactions,
  getSanFranciscoCommitteeCurrentForm460Filings,
  getSanFranciscoCommitteeSummaryRows,
  type SanFranciscoOpenDataClientOptions,
  type SanFranciscoSummaryRow,
} from "./sanFranciscoOpenDataClient.js";
import { qualifySanFranciscoCommitteeCash } from "./sanFranciscoCommitteeCashQualification.js";

const ordered = <T extends { filingNid: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => a.filingNid.localeCompare(b.filingNid));
const coreSummary = (rows: readonly SanFranciscoSummaryRow[]) =>
  JSON.stringify(
    ordered(rows).map((r) => [
      r.filingNid,
      r.filingIdNumber,
      r.filingType,
      r.formType,
      r.periodStart,
      r.periodEnd,
      r.monetaryContributionsCents,
      r.line2Cents,
      r.contributionsCents,
      r.expendituresCents,
      r.endingCashCents,
      r.outstandingDebtsCents,
      r.loansReceivedCents,
      r.syncFlag,
    ]),
  );

/** The caller binds the receiving account to an exact election manifest. */
export async function acquireSanFranciscoCommitteeCash(input: {
  fppcId: string;
  electionYear: number;
  expectedSummaryRows: readonly SanFranciscoSummaryRow[];
  options?: SanFranciscoOpenDataClientOptions;
}) {
  const context = () =>
    Promise.all([
      getSanFranciscoCommitteeSummaryRows(
        { fppcId: input.fppcId, strictCommitteeCash: true },
        input.options,
      ),
      getSanFranciscoCommitteeCurrentForm460Filings(
        { fppcId: input.fppcId, strictCommitteeCash: true },
        input.options,
      ),
    ]);
  const [summaryRows, currentFilings] = await context();
  if (coreSummary(summaryRows) !== coreSummary(input.expectedSummaryRows))
    throw new Error(
      "SF committee cash core summary changed during acquisition",
    );
  // Published current periods define this exact account's scope, including
  // preparation before January 1. Never guess a calendar-cycle start.
  const starts = currentFilings
    .map((r) => r.periodStart?.slice(0, 10) ?? "")
    .sort();
  const ends = currentFilings
    .map((r) => r.periodEnd?.slice(0, 10) ?? "")
    .sort();
  const windowStart = starts[0] ?? "";
  const windowEnd = ends.at(-1) ?? "";
  const transactions = await getSanFranciscoCommitteeCashTransactions(
    {
      fppcId: input.fppcId,
      transactionDateFrom: windowStart,
      transactionDateTo: windowEnd
        ? new Date(Date.parse(`${windowEnd}T00:00:00Z`) + 86400000)
            .toISOString()
            .slice(0, 10)
        : "",
    },
    input.options,
  );
  const [closingSummaries, closingFilings] = await context();
  if (
    JSON.stringify(ordered(summaryRows)) !==
      JSON.stringify(ordered(closingSummaries)) ||
    JSON.stringify(ordered(currentFilings)) !==
      JSON.stringify(ordered(closingFilings))
  )
    throw new Error(
      "SF committee cash current filing context changed during acquisition",
    );
  return qualifySanFranciscoCommitteeCash({
    fppcId: input.fppcId,
    electionYear: input.electionYear,
    windowStart,
    windowEnd,
    currentFilings,
    summaryRows,
    transactions,
  });
}
