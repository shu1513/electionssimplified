import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  parseNevadaCurrencyCents,
  parseNevadaCsvDate,
} from "./nevadaAuroraCsv.js";
import type { NevadaFinancePacDonorSource } from "./nevadaFinanceWriter.js";
import {
  aggregateNevadaObservedPacDonors,
  NEVADA_PUBLIC_FINANCE_SEARCH_URL,
  type NevadaObservedCashOccurrence,
} from "./nevadaPacDonorAggregator.js";
import {
  classifyNevadaReportName,
  nevadaReportPeriod,
  selectNevadaCycleReports,
  type NevadaReportListRow,
} from "./nevadaReportSummary.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Nevada observation must contain structured objects");
  }
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Nevada observation array is missing");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Nevada observation text is missing");
  }
  return value.trim();
}
function timestamp(value: unknown): number {
  const raw = text(value);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new Error("Nevada observation timestamp is invalid");
  }
  return parsed;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Nevada observation integer is invalid");
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([key]) => key !== "observedAt")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function manifest(value: unknown): {
  rows: NevadaReportListRow[];
  times: number[];
  signature: string;
} {
  const pages = array(value).map(object);
  if (pages.length === 0 || pages.length > 200) {
    throw new Error("Nevada manifest page scope is invalid");
  }
  let total: number | undefined;
  const rows: NevadaReportListRow[] = [];
  const times: number[] = [];
  for (const [index, page] of pages.entries()) {
    const timestring = timestamp(page.observedAt);
    if (index > 0 && timestring < times[index - 1])
      throw new Error("Nevada manifest time order is invalid");
    times.push(timestring);
    const pagers = array(page.pager).map(text);
    if (pagers.length === 0)
      throw new Error("Nevada manifest has no published count");
    let expectedRows: number | undefined;
    for (const pager of pagers) {
      const match = pager
        .replace(/\s+/g, " ")
        .match(/Page (\d+) of (\d+), items (\d+) to (\d+) of (\d+)\./);
      if (!match) throw new Error("Nevada manifest pager is unrecognized");
      const [, pageNumber, pageCount, start, end, count] = match.map(Number);
      if (
        pageNumber !== index + 1 ||
        pageCount !== pages.length ||
        start !== index * 25 + 1 ||
        end !== Math.min(count, (index + 1) * 25) ||
        count <= 0 ||
        Math.ceil(count / 25) !== pages.length ||
        (total !== undefined && total !== count)
      ) {
        throw new Error("Nevada manifest count/page closure failed");
      }
      total = count;
      expectedRows = end - start + 1;
    }
    const sourceRows = array(page.rows);
    if (sourceRows.length !== expectedRows)
      throw new Error("Nevada manifest is missing physical rows");
    for (const sourceRow of sourceRows) {
      const fields = array(sourceRow).map(text);
      if (fields.length !== 5 || !/^\d{4}$/.test(fields[1])) {
        throw new Error("Nevada manifest row schema is unrecognized");
      }
      rows.push({
        reportName: fields[0],
        year: Number(fields[1]),
        fileDate: parseNevadaCsvDate(fields[2], "manifest date"),
        office: fields[3],
        // A public descriptor, explicitly not a retained source token/URL.
        syn: JSON.stringify(fields),
      });
    }
  }
  if (
    rows.length !== total ||
    new Set(rows.map((row) => row.syn)).size !== rows.length
  ) {
    throw new Error(
      "Nevada manifest has missing or ambiguous report descriptors",
    );
  }
  return {
    rows,
    times,
    signature: canonical(
      pages.map((page) => ({ pager: page.pager, rows: page.rows })),
    ),
  };
}

function amount(value: unknown): number {
  const raw = text(value);
  try {
    return /^\$\s*-/.test(raw)
      ? -parseNevadaCurrencyCents(
          raw.replace(/^\$\s*-\s*/, "$"),
          "observed amount",
        )
      : parseNevadaCurrencyCents(raw, "observed amount");
  } catch {
    throw new Error("Nevada observed currency format is invalid");
  }
}
function summaryPeriod(summary: ObjectValue, line: number): number {
  const cells = array(summary[String(line)]);
  const expectedLength = line === 13 ? 1 : line === 8 || line === 12 ? 2 : 3;
  if (
    cells.length !== expectedLength ||
    (expectedLength === 3 && amount(cells[0]) !== 10_000)
  ) {
    throw new Error("Nevada candidate summary column schema changed");
  }
  return amount(cells[expectedLength === 3 ? 1 : 0]);
}

export function validateNevadaCommitteeDonorObservation(
  value: unknown,
  options: { now?: Date; captureDigest: string },
) {
  const root = object(value);
  if (
    root.version !== 1 ||
    root.sourceMode !== "browser_financial_observation" ||
    root.locatorValuesOmitted !== true ||
    root.httpResponseMetadataClaimed !== false
  ) {
    throw new Error("Nevada donor observation acquisition mode is unsupported");
  }
  const paths = object(root.sourceCanonicalPaths);
  if (
    paths.search !== NEVADA_PUBLIC_FINANCE_SEARCH_URL ||
    paths.candidate !==
      "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/CandidateDetails.aspx" ||
    paths.report !==
      "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/ViewCCEReport.aspx"
  ) {
    throw new Error("Nevada observation has an unsupported source entrypoint");
  }
  const context = object(root.context);
  const labels = object(root.summaryLineLabels);
  if (
    !/^1\. Total Monetary Contributions Received in Excess of \$100$/.test(
      text(labels["1"]).replace(/\s+/g, " "),
    ) ||
    !/^8\. Total Amount of All Contributions \(Add Lines 1 through 7\)$/.test(
      text(labels["8"]).replace(/\s+/g, " "),
    ) ||
    !/^13\. Fund balance at the end of the reporting period$/.test(
      text(labels["13"]).replace(/\s+/g, " "),
    )
  ) {
    throw new Error("Nevada candidate cash summary roles changed");
  }
  const filerName = text(context.candidateName);
  const sourceOffice = text(context.office);
  const electionYear = integer(context.electionYear);
  if (
    context.jurisdiction !== "NV SOS" ||
    electionYear < 2004 ||
    electionYear > 2100
  ) {
    throw new Error("Nevada observation jurisdiction/year is unsupported");
  }
  if (!/^[a-f0-9]{64}$/.test(options.captureDigest))
    throw new Error("Nevada observation digest is invalid");
  const opening = manifest(root.openingManifest);
  const closing = manifest(root.closingManifest);
  if (opening.signature !== closing.signature)
    throw new Error("Nevada manifest changed during observation");
  const now = (options.now ?? new Date()).getTime();
  const first = opening.times[0];
  const last = closing.times.at(-1)!;
  if (
    last > now ||
    first > last ||
    now - first > 36 * 60 * 60 * 1000 ||
    last - first > 2 * 60 * 60 * 1000
  ) {
    throw new Error(
      "Nevada donor observation is stale or has invalid capture times",
    );
  }
  const selection = selectNevadaCycleReports({
    rows: opening.rows,
    electionYear,
  });
  if (selection.selected.length === 0)
    throw new Error("Nevada current cash reports are missing");
  for (const row of opening.rows) {
    const name = classifyNevadaReportName(row.reportName);
    if (
      row.year >= electionYear - 1 &&
      row.year <= electionYear &&
      !name.isLegalDefenseFund &&
      nevadaReportPeriod(name.baseName, row.year) &&
      !selection.selected.some(
        (selected) =>
          selected.year === row.year &&
          selected.name.baseName === name.baseName,
      )
    ) {
      throw new Error("Nevada overlapping current cash reports require review");
    }
    if (
      row.year >= electionYear - 1 &&
      row.year <= electionYear &&
      !nevadaReportPeriod(
        classifyNevadaReportName(row.reportName).baseName,
        row.year,
      ) &&
      !/financial disclosure/i.test(row.reportName)
    ) {
      throw new Error("Nevada current report kind requires review");
    }
  }
  const observed = array(root.financialObservations).map(object);
  const prior = array(root.priorFinancialObservations).map(object);
  if (
    observed.length !== selection.selected.length ||
    prior.length !== observed.length
  ) {
    throw new Error(
      "Nevada whole current report observation scope is incomplete",
    );
  }
  const cashRows: NevadaObservedCashOccurrence[] = [];
  let cashCents = 0;
  let expectedStart = `${electionYear - 1}-01-01`;
  const periodStart = expectedStart;
  let periodEnd = "";
  for (const selected of selection.selected) {
    const indistinguishableEditions = opening.rows.filter((row) => {
      const name = classifyNevadaReportName(row.reportName);
      return (
        row.year === selected.year &&
        name.baseName === selected.name.baseName &&
        name.isAmended === selected.name.isAmended &&
        !name.isLegalDefenseFund
      );
    });
    if (indistinguishableEditions.length !== 1) {
      throw new Error(
        "Nevada financial observation cannot bind multiple report editions",
      );
    }
    if (
      selected.period.start !== expectedStart ||
      selected.office !== sourceOffice
    ) {
      throw new Error(
        "Nevada current cash periods or office ownership are incomplete",
      );
    }
    const isMatch = (report: ObjectValue) =>
      report.reportYear === selected.year &&
      classifyNevadaReportName(text(report.reportLabel)).baseName ===
        selected.name.baseName;
    const matches = observed.filter(isMatch);
    const oldMatches = prior.filter(isMatch);
    if (
      matches.length !== 1 ||
      oldMatches.length !== 1 ||
      canonical(matches[0]) !== canonical(oldMatches[0])
    ) {
      throw new Error(
        "Nevada current report financial content changed or is ambiguous",
      );
    }
    const report = matches[0];
    const observedAt = timestamp(report.observedAt);
    if (
      timestamp(oldMatches[0].observedAt) >= first ||
      observedAt < Math.max(...opening.times) ||
      observedAt > Math.min(...closing.times) ||
      selected.fileDate > new Date(observedAt).toISOString().slice(0, 10)
    ) {
      throw new Error(
        "Nevada report observations do not bracket current source",
      );
    }
    const flags = array(report.reportFlags).map(object);
    function checked(suffix: string, expected: boolean) {
      const values = flags.filter((flag) => text(flag.id).endsWith(suffix));
      if (values.length !== 1 || values[0].checked !== expected)
        throw new Error("Nevada report affirmation/version flags disagree");
    }
    checked("chkCANDIDATE", true);
    checked("chkLEGALDEFENSE", false);
    checked("chkAMENDED", selected.name.isAmended);
    checked("chkDeclaration", true);
    checked("chkTerms", true);
    const periods = array(report.periodChoices)
      .map(object)
      .filter((choice) => choice.checked === true);
    if (periods.length !== 1)
      throw new Error("Nevada report has ambiguous checked periods");
    const dates = text(periods[0].label).match(
      /Period:\s*([A-Za-z]{3}) (\d{2}), (\d{4})\s*-\s*([A-Za-z]{3}) (\d{2}), (\d{4})/,
    );
    if (!dates) throw new Error("Nevada report period label is unrecognized");
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const start = parseNevadaCsvDate(
      `${months.indexOf(dates[1]) + 1}/${dates[2]}/${dates[3]}`,
      "checked period start",
    );
    const end = parseNevadaCsvDate(
      `${months.indexOf(dates[4]) + 1}/${dates[5]}/${dates[6]}`,
      "checked period end",
    );
    if (
      start !== selected.period.start ||
      end !== selected.period.end ||
      end > new Date(now).toISOString().slice(0, 10)
    ) {
      throw new Error("Nevada report checked period disagrees with manifest");
    }
    if (
      report.loanColumnHeading !== "CHECK HERE IF LOAN" ||
      report.expenseReturnLiteralCount !== 0
    ) {
      throw new Error("Nevada loan/return evidence requires review");
    }
    const summary = object(report.summary);
    // This first seam accepts fully itemized cash-only reports. Other money
    // classes require their own reviewed scope, rather than loose 1% controls.
    for (const line of [2, 3, 4, 5, 6, 7]) {
      if (summaryPeriod(summary, line) !== 0)
        throw new Error("Nevada non-cash/unitemized scope requires review");
    }
    const reportRows = array(report.cashRows).map(object);
    let reportCash = 0;
    for (const [index, row] of reportRows.entries()) {
      if (
        row.occurrence !== index ||
        row.loanCellBlank !== true ||
        row.loanCheckboxChecked !== null
      ) {
        throw new Error(
          "Nevada cash occurrence/loan-column scope is incomplete",
        );
      }
      const date = parseNevadaCsvDate(text(row.date), "observed cash date");
      if (date < start || date > end)
        throw new Error(
          "Nevada cash occurrence lies outside its report period",
        );
      const cents = amount(row.amount);
      reportCash += cents;
      if (!Number.isSafeInteger(reportCash))
        throw new Error("Nevada cash control is out of range");
      cashRows.push({
        contributorName: text(row.contributorName),
        date,
        amountCents: cents,
        loanCellBlank: true,
        loanCheckboxChecked: null,
      });
    }
    if (
      reportCash !== summaryPeriod(summary, 1) ||
      summaryPeriod(summary, 8) !== reportCash
    ) {
      throw new Error(
        "Nevada complete cash occurrence sum disagrees with report controls",
      );
    }
    if (
      summaryPeriod(summary, 9) +
        summaryPeriod(summary, 10) +
        summaryPeriod(summary, 11) !==
      summaryPeriod(summary, 12)
    ) {
      throw new Error("Nevada expense cover controls disagree");
    }
    summaryPeriod(summary, 13);
    cashCents += reportCash;
    if (!Number.isSafeInteger(cashCents))
      throw new Error("Nevada whole cash scope is out of range");
    periodEnd = end;
    expectedStart = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  const pacDonorSource: NevadaFinancePacDonorSource = {
    observedAt: new Date(last),
    periodStart,
    periodEnd,
    captureDigest: options.captureDigest,
  };
  return {
    filerName,
    sourceOffice,
    electionYear,
    manifestRows: opening.rows,
    cashRowCount: cashRows.length,
    cashCents,
    reportCount: observed.length,
    pacDonorSource,
    // Current safe query publishes no numeric count. Retain its positive
    // research witness without promoting it into a complete registry match.
    pacDonors: aggregateNevadaObservedPacDonors({ cashRows, groupQueries: [] }),
    warnings: [
      "Only literal reported PAC names are identified; registry-name acceptance requires complete query authority.",
    ],
  };
}

export async function readNevadaCommitteeDonorObservation(
  path: string,
  now?: Date,
) {
  const bytes = await readFile(path);
  if (bytes.length > 5 * 1024 * 1024)
    throw new Error("Nevada donor observation exceeds size limit");
  return validateNevadaCommitteeDonorObservation(
    JSON.parse(bytes.toString("utf8")),
    {
      now,
      captureDigest: createHash("sha256").update(bytes).digest("hex"),
    },
  );
}
