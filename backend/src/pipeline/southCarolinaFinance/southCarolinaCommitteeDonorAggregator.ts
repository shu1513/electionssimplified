import { aggregateSouthCarolinaDirectFinance } from "./southCarolinaDirectContributionAggregator.js";
import {
  parseSouthCarolinaCivilDate,
  type SouthCarolinaCandidateReportRow,
  type SouthCarolinaContributionSearchRow,
  type SouthCarolinaReportDetails,
  type SouthCarolinaItemizedContribution,
} from "./southCarolinaEthicsClient.js";

export type SouthCarolinaReportedCommitteeDonor = {
  committeeId: string;
  committeeName: string;
  amount: number;
  contributionCount: number;
  sourceUrl: string | null;
  recognitionMethod: "political_name_hint";
  sourceReportedClass: "group_yes";
};
export type SouthCarolinaCommitteeDonorResult = {
  pacDonors?: SouthCarolinaReportedCommitteeDonor[];
  diagnostics: string[];
};
export type SouthCarolinaCommitteeDonorInput = {
  candidateFilerId: number;
  electionYear: number;
  acceptedElectionDates: readonly string[];
  reports: readonly SouthCarolinaCandidateReportRow[];
  detailsByReportId: ReadonlyMap<number, SouthCarolinaReportDetails>;
  contributionRows: readonly SouthCarolinaContributionSearchRow[];
  filerName?: string;
  sourceUrl?: string | null;
};

// This is reported identity, not a legal-name alias or registry ID.
export function normalizeSouthCarolinaReportedCommitteeName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}
const text = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ");
const nameKey = normalizeSouthCarolinaReportedCommitteeName;
const controlKey = (value: string) => nameKey(value).replace(/[^A-Z0-9]+/g, " ");
const fail = (message: string): never => {
  throw new Error(message);
};
function cents(value: number): number {
  const result = Math.round(value * 100);
  if (!Number.isFinite(value) || !Number.isSafeInteger(result) || Math.abs(value * 100 - result) > 1e-6) {
    return fail("Non-cent-exact financial amount");
  }
  return result;
}
function sum(values: readonly number[]): number {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) return fail("Financial cents overflow");
  return result;
}
function tuple(
  date: string,
  amount: number,
  name: string,
  occupation: string | null,
  description: string | null,
): string {
  return JSON.stringify([date, amount, nameKey(name), text(occupation), text(description)]);
}
function detailTuple(row: SouthCarolinaItemizedContribution): string {
  return tuple(row.civilDate, row.amountCents, row.name, row.occupation, row.description);
}
function controls(lines: SouthCarolinaReportDetails["income"]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of lines) {
    const key = controlKey(row.type);
    if (map.has(key)) return fail("Duplicate financial control");
    map.set(key, cents(row.filingPeriod));
  }
  return map;
}
function control(map: Map<string, number>, key: string): number {
  if (!map.has(key)) return fail(`Missing ${key} control`);
  return map.get(key)!;
}
function politicalName(name: string): boolean {
  return /\b(PAC|POLITICAL|COMMITTEE)\b/i.test(name) || /\bP\s*\.\s*A\s*\.\s*C\.?(?=$|[^A-Z])/i.test(name);
}
function fullPersonKey(value: string): string {
  const parts = value.split(",");
  return nameKey(parts.length === 2 ? `${parts[1]} ${parts[0]}` : value);
}

/**
 * Financial/source facts only. The caller must independently acquire and compare
 * complete observations before publishing this optional component. No legal PAC
 * type, Original-only rule, individual alias, or gift-level refund join is inferred.
 */
export function aggregateSouthCarolinaCommitteeDonors(
  input: SouthCarolinaCommitteeDonorInput,
): SouthCarolinaCommitteeDonorResult {
  const diagnostics: string[] = [];
  try {
    if (
      !Number.isSafeInteger(input.candidateFilerId) ||
      input.candidateFilerId <= 0 ||
      !Number.isSafeInteger(input.electionYear)
    ) {
      return fail("Invalid candidate context");
    }
    const dates = new Set(input.acceptedElectionDates.map(parseSouthCarolinaCivilDate));
    if (!dates.size || [...dates].some((d) => !d.startsWith(String(input.electionYear) + "-")))
      return fail("Invalid accepted election context");
    const reports = input.reports.filter((r) => dates.has(parseSouthCarolinaCivilDate(r.electionDate)));
    if (!reports.length) return fail("No applicable filed reports");
    const seenReports = new Set<number>();
    const periods = reports
      .map((report) => {
        if (report.candidateFilerId !== input.candidateFilerId || seenReports.has(report.reportId))
          return fail("Wrong or duplicate current report identity");
        seenReports.add(report.reportId);
        const start = parseSouthCarolinaCivilDate(report.filingStartDate);
        const end = parseSouthCarolinaCivilDate(report.filingEndDate);
        if (start > end) return fail("Invalid report period");
        const detail = input.detailsByReportId.get(report.reportId);
        if (!detail || !detail.itemizedContributions || !detail.itemizedExpenditures)
          return fail("Full itemized report unavailable");
        if (
          detail.versions[0]?.id !== report.reportId ||
          new Set(detail.versions.map((v) => v.id)).size !== detail.versions.length
        )
          return fail("Current report/version identity mismatch");
        if (parseSouthCarolinaCivilDate(detail.electionDate) !== parseSouthCarolinaCivilDate(report.electionDate))
          return fail("Report election mismatch");
        const printedPeriod = detail.filingPeriod.split(" - ");
        if (
          printedPeriod.length !== 2 ||
          parseSouthCarolinaCivilDate(printedPeriod[0]!) !== start ||
          parseSouthCarolinaCivilDate(printedPeriod[1]!) !== end
        )
          return fail("Report period mismatch");
        if (input.filerName && fullPersonKey(detail.filerName) !== fullPersonKey(input.filerName))
          return fail("Report owner mismatch");
        return { report, detail, start, end };
      })
      .sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < periods.length; i++) {
      const previous = periods[i - 1]!;
      const current = periods[i]!;
      const next = new Date(previous.end + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      if (current.start !== next.toISOString().slice(0, 10))
        return fail("Current report periods overlap or leave a hole");
    }
    const runIds = new Set(reports.map((r) => r.campaignId));
    const annual = input.contributionRows.filter(
      (r) => r.candidateId === input.candidateFilerId && runIds.has(r.officeRunId),
    );
    const seenIds = new Set<number>();
    const annualByTuple = new Map<string, SouthCarolinaContributionSearchRow[]>();
    const organizations = new Map<
      string,
      {
        name: string;
        gross: number;
        returned: number;
        count: number;
        occupationBlank: boolean;
        profiles: Set<number>;
      }
    >();
    for (const row of annual) {
      if (seenIds.has(row.contributionId) || !Number.isSafeInteger(row.contributionId) || row.contributionId <= 0)
        return fail("Duplicate or invalid annual receipt ID");
      seenIds.add(row.contributionId);
      const day = parseSouthCarolinaCivilDate(row.date);
      const period = periods.filter((p) => p.report.campaignId === row.officeRunId && day >= p.start && day <= p.end);
      if (period.length !== 1 || !dates.has(parseSouthCarolinaCivilDate(row.electionDate)))
        return fail("Annual receipt outside current period/context");
      if (row.group !== "Yes" && row.group !== "No") return fail("Unknown reported contributor class");
      if (input.filerName && fullPersonKey(row.candidateName) !== fullPersonKey(input.filerName))
        return fail("Annual receipt owner mismatch");
      const key = tuple(day, cents(row.amount), row.contributorName, row.contributorOccupation, row.description);
      const matches = annualByTuple.get(key) ?? [];
      matches.push(row);
      annualByTuple.set(key, matches);
      if (row.group === "Yes") {
        const owner = nameKey(row.contributorName);
        if (!owner || owner === nameKey(input.filerName ?? "")) return fail("Blank or self organization identity");
        const g = organizations.get(owner) ?? {
          name: text(row.contributorName),
          gross: 0,
          returned: 0,
          count: 0,
          occupationBlank: true,
          profiles: new Set<number>(),
        };
        g.gross = sum([g.gross, cents(row.amount)]);
        g.count++;
        g.occupationBlank &&= !text(row.contributorOccupation);
        organizations.set(owner, g);
      }
    }
    const matchedOrganizationTuples = new Map<string, number>();
    const returnRows: { name: string; amount: number; date: string }[] = [];
    const refundNotices: {
      name: string;
      description: string;
      periodEnd: string;
    }[] = [];
    let ignoredIndividualProjection = 0;
    for (const { report, detail, start, end } of periods) {
      const income = controls(detail.income);
      const expense = controls(detail.expenditures);
      const allowedIncome = new Set([
        "CASH CONTRIBUTIONS",
        "IN KIND CONTRIBUTIONS",
        "PERSONAL CONTRIBUTIONS",
        "LOANS",
        "ACCOUNT CREDITS",
        "DEBT SETOFF FUNDS",
        "TOTAL",
      ]);
      const allowedExpense = new Set(["EXPENDITURES", "RETURNED CONTRIBUTIONS", "IN KIND EXPENDITURES", "TOTAL"]);
      if (
        [...income].some(([k, v]) => !allowedIncome.has(k) && v !== 0) ||
        [...expense].some(([k, v]) => !allowedExpense.has(k) && v !== 0)
      )
        return fail("Unexplained financial control");
      // Without a source per-row mechanism, mixed contribution tables cannot
      // be silently assigned to cash. Loans/credits remain separate controls.
      if (
        control(income, "IN KIND CONTRIBUTIONS") !== 0 ||
        control(income, "PERSONAL CONTRIBUTIONS") !== 0 ||
        control(income, "DEBT SETOFF FUNDS") !== 0 ||
        control(expense, "IN KIND EXPENDITURES") !== 0
      )
        return fail("Itemized financial mechanism unresolved");
      const cash = control(income, "CASH CONTRIBUTIONS");
      if (
        cash !== cents(detail.contributionsTotal) ||
        cash !== sum(detail.itemizedContributions!.map((r) => r.amountCents))
      )
        return fail("Cash occurrence/control mismatch");
      if (control(income, "TOTAL") !== sum([...income].filter(([k]) => k !== "TOTAL").map(([, v]) => v)))
        return fail("Income total/control mismatch");
      if (
        control(expense, "TOTAL") !== cents(detail.expendituresTotal) ||
        cents(detail.expendituresTotal) !== sum(detail.itemizedExpenditures!.map((r) => r.amountCents))
      )
        return fail("Expense occurrence/control mismatch");
      if (control(expense, "TOTAL") !== sum([...expense].filter(([k]) => k !== "TOTAL").map(([, v]) => v)))
        return fail("Expense total/control mismatch");
      const annualPeriod = annual.filter(
        (r) =>
          r.officeRunId === report.campaignId &&
          parseSouthCarolinaCivilDate(r.date) >= start &&
          parseSouthCarolinaCivilDate(r.date) <= end,
      );
      if (
        sum(annualPeriod.map((r) => cents(r.amount))) !== cash ||
        annualPeriod.length !== detail.itemizedContributions!.length
      )
        return fail("Annual cash count/control mismatch");
      const detailCounts = new Map<string, number>();
      for (const row of detail.itemizedContributions!) {
        if (
          !Number.isSafeInteger(row.amountCents) ||
          row.civilDate < start ||
          row.civilDate > end ||
          !Number.isSafeInteger(row.contributorId) ||
          row.contributorId <= 0
        )
          return fail("Invalid itemized contribution period/identity");
        if (/\b(refund|return|returned|reversal|chargeback|recredit)\b/i.test(text(row.description))) {
          refundNotices.push({
            name: row.name,
            description: text(row.description),
            periodEnd: end,
          });
        }
        const key = detailTuple(row);
        detailCounts.set(key, (detailCounts.get(key) ?? 0) + 1);
        const matches = annualByTuple.get(key) ?? [];
        const classes = new Set(matches.map((r) => r.group));
        if (classes.size > 1) return fail("Ambiguous contributor class tuple");
        if (matches.some((r) => r.group === "Yes")) {
          matchedOrganizationTuples.set(key, (matchedOrganizationTuples.get(key) ?? 0) + 1);
          organizations.get(nameKey(row.name))!.profiles.add(row.contributorId);
        } else if (!matches.length) ignoredIndividualProjection++;
      }
      for (const row of annualPeriod.filter((r) => r.group === "Yes")) {
        const key = tuple(
          parseSouthCarolinaCivilDate(row.date),
          cents(row.amount),
          row.contributorName,
          row.contributorOccupation,
          row.description,
        );
        const expected = annualByTuple.get(key)!.length;
        if (detailCounts.get(key) !== expected) return fail("Organization occurrence identity mismatch");
      }
      const actualReturns = detail.itemizedExpenditures!.filter((r) =>
        /^returned with check #\s*\d+$/i.test(text(r.description)),
      );
      const suspicious = detail.itemizedExpenditures!.filter(
        (r) =>
          /\b(return|returned|refund|refunded|chargeback|reversal)\b/i.test(text(r.description)) &&
          !actualReturns.includes(r),
      );
      if (
        suspicious.length ||
        actualReturns.some((r) => r.amountCents <= 0) ||
        sum(actualReturns.map((r) => r.amountCents)) !== control(expense, "RETURNED CONTRIBUTIONS")
      )
        return fail("Returned contribution purpose/control unresolved");
      for (const row of detail.itemizedExpenditures!) {
        if (
          !Number.isSafeInteger(row.amountCents) ||
          row.civilDate < start ||
          row.civilDate > end ||
          !Number.isSafeInteger(row.paidToId) ||
          row.paidToId <= 0
        )
          return fail("Invalid itemized expenditure period/identity");
      }
      for (const row of actualReturns)
        returnRows.push({
          name: row.name,
          amount: row.amountCents,
          date: row.civilDate,
        });
    }
    for (const [key, rows] of annualByTuple) {
      if (rows[0]!.group === "Yes" && matchedOrganizationTuples.get(key) !== rows.length)
        return fail("Organization multiset incomplete");
    }
    let organizationReturnCount = 0;
    for (const returned of returnRows) {
      const owner = nameKey(returned.name);
      const classes = new Set(annual.filter((r) => nameKey(r.contributorName) === owner).map((r) => r.group));
      if (!owner || classes.size !== 1)
        return fail("Returned reported owner is unknown or ambiguous");
      // A literal, unambiguous individual refund reconciles expenses without reducing PAC totals.
      if (classes.has("No")) continue;
      const g = organizations.get(owner);
      if (!g) return fail("Returned reported owner is unknown or ambiguous");
      g.returned = sum([g.returned, returned.amount]);
      organizationReturnCount++;
    }
    for (const notice of refundNotices) {
      const match = /^Sent refund check, hasn't cleared bank as of ([A-Z][a-z]+) (\d{1,2})\.$/.exec(notice.description);
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      const statedMonthDay = match
        ? `${String(months.indexOf(match[1]!) + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`
        : null;
      if (
        !match ||
        statedMonthDay !== notice.periodEnd.slice(5) ||
        !returnRows.some((r) => nameKey(r.name) === nameKey(notice.name) && r.date <= notice.periodEnd)
      ) {
        return fail("Contribution refund/recredit description unresolved");
      }
    }
    // Period controls alone cannot prove that the first observed report includes earlier activity.
    // Reuse the direct component's cumulative reset/continuation rules, separately for each run.
    for (const runId of runIds) {
      const runPeriods = periods.filter((p) => p.report.campaignId === runId);
      const cumulative = aggregateSouthCarolinaDirectFinance({
        ...input,
        reports: runPeriods.map((p) => p.report),
      });
      if (
        cumulative.status !== "aggregated" ||
        cents(cumulative.directContributionTotal) !== sum(runPeriods.map((p) => cents(p.detail.contributionsTotal))) ||
        cents(cumulative.totalDisbursements) !== sum(runPeriods.map((p) => cents(p.detail.expendituresTotal)))
      )
        return fail("Cumulative financial coverage incomplete");
    }
    if (ignoredIndividualProjection)
      diagnostics.push(
        `${ignoredIndividualProjection} individual name projections retained outside organization matching`,
      );
    if (organizationReturnCount)
      diagnostics.push(`${organizationReturnCount} explicit reported-owner returns netted without gift-ID inference`);
    const donors: SouthCarolinaReportedCommitteeDonor[] = [];
    for (const [key, g] of organizations) {
      if (!g.occupationBlank || !politicalName(g.name)) continue;
      donors.push({
        committeeId: `reported:${key}`,
        committeeName: g.name,
        amount: sum([g.gross, -g.returned]) / 100,
        contributionCount: g.count,
        sourceUrl: input.sourceUrl ?? null,
        recognitionMethod: "political_name_hint",
        sourceReportedClass: "group_yes",
      });
    }
    donors.sort((a, b) => b.amount - a.amount || a.committeeName.localeCompare(b.committeeName));
    return { pacDonors: donors, diagnostics };
  } catch (error) {
    return {
      diagnostics: [error instanceof Error ? error.message : "Committee source unavailable"],
    };
  }
}
