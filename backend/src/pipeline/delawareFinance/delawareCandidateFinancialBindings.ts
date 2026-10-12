import { createHash } from "node:crypto";
import {
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
  buildDelawareReceiptsSearchFields,
  DELAWARE_CFRS_EXPORT_QUERY,
  type DelawareCfrsResponseCapture,
} from "./delawareCfrsClient.js";
import {
  extractDelawareGridTotal,
  parseDelawareFiledReportsHtml,
  type DelawareFiledReportRow,
} from "./delawareCfrsParsers.js";
import {
  closeDelawareNativeLedger,
  decodeDelawareExpenseNativePage,
  decodeDelawareReceiptNativePage,
  type DelawareNativeLedger,
  type DelawareNativeLedgerRow,
} from "./delawareNativeLedger.js";
import {
  readDelawareCandidateFinancialReport,
  type DelawareCandidateFinancialReport,
  type DelawareCandidatePdfOccurrence,
  type DelawareCandidateScheduleName,
} from "./delawareCandidateFinancialReport.js";

/** Legacy observations are source facts only; omitted modern metadata is never synthesized. */
export type DelawareCandidateFinancialObservation = Omit<
  DelawareCfrsResponseCapture,
  "attempt" | "requestScopeRedacted"
> &
  Partial<
    Pick<DelawareCfrsResponseCapture, "attempt" | "requestScopeRedacted">
  >;
export type DelawareCandidateFinancialOwner = {
  cfId: string;
  memberId: number;
  committeeName: string;
};
export type DelawareCandidateFinancialBindingInput = {
  owner: DelawareCandidateFinancialOwner;
  reports: readonly {
    facts: DelawareCandidateFinancialReport;
    pdfCapture: DelawareCandidateFinancialObservation;
  }[];
  inventoryCaptures: readonly DelawareCandidateFinancialObservation[];
  receipts: {
    ledger: DelawareNativeLedger;
    captures: readonly DelawareCandidateFinancialObservation[];
  };
  expenses: {
    ledger: DelawareNativeLedger;
    captures: readonly DelawareCandidateFinancialObservation[];
  };
};
export type DelawareFinancialOccurrenceEquivalence = {
  date: string;
  amountCents: number;
  monetaryName: string;
  nativeTransactionIds: readonly number[];
  nativeRows: readonly DelawareNativeLedgerRow[];
  pdfOccurrences: readonly DelawareCandidatePdfOccurrence[];
  sourceClass: string;
  sourceMechanism: string;
  /** Preserved original values are restricted source facts, not product fields. */
  addressDiagnostics: readonly {
    nativeTransactionIds: readonly number[];
    pdfOccurrences: readonly number[];
    reason: string;
  }[];
  categoryAnnotations: readonly {
    occurrence: number;
    literal: "(Return Contributions)";
  }[];
};
export type DelawareFinancialAggregatePlacement = {
  schedule: "receipts" | "expenditures";
  controlCents: number;
  representedNativeCents: number;
  nativeTransactionIds: readonly number[];
  /** Independently printed aggregate only; never a fabricated gift/ID/count. */
  pdfOnlyAggregateCents: number;
};
export type DelawareCandidateFinancialBindingReport = {
  inventoryRow: DelawareFiledReportRow;
  facts: DelawareCandidateFinancialReport;
  bindings: Readonly<
    Partial<
      Record<
        DelawareCandidateScheduleName,
        readonly DelawareFinancialOccurrenceEquivalence[]
      >
    >
  >;
  aggregates: readonly DelawareFinancialAggregatePlacement[];
  unsupportedMechanisms: readonly {
    schedule: DelawareCandidateScheduleName | null;
    nativeTransactionIds: readonly number[];
    reason: string;
  }[];
};
export type DelawareCandidateFinancialBindings = {
  scope: "candidate_financial_source_facts";
  owner: DelawareCandidateFinancialOwner;
  reports: readonly DelawareCandidateFinancialBindingReport[];
  /** Neither a current-edition determination nor a qualified campaign/PAC acceptance. */
  diagnostics: readonly string[];
  sourceMetadata: readonly Omit<
    DelawareCandidateFinancialObservation,
    "body"
  >[];
};
const origin = "https://cfrs.elections.delaware.gov";
const display = (value: string) => value.replace(/\s+/gu, " ").trim();
const monetaryName = (value: string) => display(value.replace(/,/g, " "));
const fingerprint = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
  throw new Error(`Delaware candidate financial bindings: ${message}`);
}
function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(ordered)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : input;
  return JSON.stringify(ordered(value));
}
function field(row: DelawareNativeLedgerRow, key: string): string {
  const value = row.rawFields[key];
  if (typeof value !== "string") fail(`missing native ${key}`);
  return value;
}
function text(capture: DelawareCandidateFinancialObservation): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(capture.body);
  } catch {
    return fail("invalid source text encoding");
  }
}
function url(capture: DelawareCandidateFinancialObservation): URL {
  const result = new URL(capture.url);
  if (
    result.origin !== origin ||
    result.username ||
    result.password ||
    result.hash
  )
    fail("unrecognized source URL");
  return result;
}
function observations(
  input: readonly DelawareCandidateFinancialObservation[],
  diagnostics: string[],
): DelawareCandidateFinancialObservation[] {
  return input.map((source) => {
    const body = Buffer.from(source.body);
    if (
      source.status !== 200 ||
      body.length !== source.byteCount ||
      body.length > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      fingerprint(body) !== source.sha256 ||
      !Number.isFinite(Date.parse(source.startedAt)) ||
      !Number.isFinite(Date.parse(source.completedAt)) ||
      Date.parse(source.startedAt) > Date.parse(source.completedAt) ||
      source.requestScopeRedacted === true
    )
      fail("invalid source observation integrity/status/scope/time");
    if (source.method !== "GET" && source.method !== "POST")
      fail("invalid observation method");
    if (
      source.attempt !== undefined &&
      (!Number.isSafeInteger(source.attempt) || source.attempt < 1)
    )
      fail("invalid provided observation attempt");
    if (
      source.requestScopeRedacted !== undefined &&
      source.requestScopeRedacted !== false
    )
      fail("invalid provided observation scope metadata");
    if (
      source.attempt === undefined ||
      source.requestScopeRedacted === undefined
    )
      diagnostics.push(
        `Legacy source-facts envelope: ${url(source).pathname}; missing modern attempt/redaction metadata.`,
      );
    // Copy only the source DTO. Unknown headers/cookies/caller properties are not serialized.
    return {
      body,
      url: source.url,
      method: source.method,
      financeFields:
        source.financeFields === null ? null : { ...source.financeFields },
      ...(source.attempt === undefined ? {} : { attempt: source.attempt }),
      ...(source.requestScopeRedacted === undefined
        ? {}
        : { requestScopeRedacted: source.requestScopeRedacted }),
      startedAt: source.startedAt,
      completedAt: source.completedAt,
      status: source.status,
      contentType: source.contentType,
      byteCount: source.byteCount,
      sha256: source.sha256,
    };
  });
}
function queryKeys(request: URL, allowed: readonly string[]): void {
  const keys = [...request.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !allowed.includes(key))
  )
    fail("unknown/duplicate source URL query scope");
}
function one(
  captures: readonly DelawareCandidateFinancialObservation[],
  path: string,
  method: "GET" | "POST",
): DelawareCandidateFinancialObservation {
  const found = captures.filter(
    (capture) => url(capture).pathname === path && capture.method === method,
  );
  if (found.length !== 1) fail(`missing/ambiguous ${path} capture`);
  return found[0]!;
}
function scope(
  capture: DelawareCandidateFinancialObservation,
  expected: Record<string, string>,
  allowed: readonly string[] = [],
): Record<string, string> {
  const request = url(capture);
  queryKeys(
    request,
    request.pathname.endsWith("Custom") ? ["Grid-size", "theme"] : ["theme"],
  );
  if (request.searchParams.get("theme") !== "vista")
    fail("wrong source search theme");
  const fields = capture.financeFields;
  if (
    !fields ||
    Object.keys(expected).some(
      (key) =>
        !Object.hasOwn(fields, key) ||
        (!allowed.includes(key) && fields[key] !== expected[key]),
    ) ||
    Object.entries(fields).some(
      ([key, value]) =>
        typeof value !== "string" ||
        (!Object.hasOwn(expected, key) &&
          !allowed.includes(key) &&
          value !== ""),
    )
  )
    fail("missing/narrowed/wrong source query scope");
  return { ...fields };
}
function civil(raw: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) fail("invalid query date");
  const value = `${match[3]}-${match[1]}-${match[2]}`;
  if (
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail("invalid query date");
  return value;
}
function inventory(
  captures: readonly DelawareCandidateFinancialObservation[],
  owner: DelawareCandidateFinancialOwner,
): DelawareFiledReportRow[] {
  const search = one(captures, "/Public/ViewFiledReports", "POST");
  scope(
    search,
    buildDelawareFiledReportsSearchFields({
      MemberId: String(owner.memberId),
      txtCommitteeName: owner.committeeName,
    }),
  );
  const pages = captures.filter(
    (capture) =>
      url(capture).pathname === "/Public/_ViewFiledReports" &&
      capture.method === "GET",
  );
  if (!pages.length) fail("missing report inventory pages");
  let count: number | null = null;
  const rows: DelawareFiledReportRow[] = [];
  for (const [index, capture] of pages.entries()) {
    const request = url(capture);
    queryKeys(request, [
      "ajax",
      "Grid-page",
      "Grid-size",
      "Grid-orderBy",
      "Grid-groupBy",
      "Grid-filter",
      "theme",
    ]);
    const params = request.searchParams;
    if (params.get("theme") !== "vista") fail("wrong report inventory theme");
    const size = Number(params.get("Grid-size"));
    if (
      Number(params.get("Grid-page")) !== index + 1 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 500 ||
      params.get("ajax") !== "True" ||
      ["Grid-orderBy", "Grid-groupBy", "Grid-filter"].some(
        (key) => params.get(key) !== "~",
      ) ||
      Date.parse(capture.startedAt) < Date.parse(search.completedAt)
    )
      fail("invalid report inventory request sequence");
    const parsed = parseDelawareFiledReportsHtml(text(capture));
    if (
      parsed.total === null ||
      !Number.isSafeInteger(parsed.total) ||
      parsed.total < 0 ||
      (count !== null && parsed.total !== count) ||
      parsed.rows.length > size ||
      (index < pages.length - 1 && parsed.rows.length !== size)
    )
      fail("incomplete/changed report inventory");
    count = parsed.total;
    rows.push(...parsed.rows);
  }
  if (
    rows.length !== count ||
    rows.some(
      (row) =>
        row.cfId !== owner.cfId ||
        display(row.committeeName) !== owner.committeeName ||
        row.committeeType !== "Candidate Committee" ||
        !row.document ||
        row.document.memberId !== owner.memberId,
    ) ||
    new Set(rows.map((row) => row.document!.publicReportFileName)).size !==
      rows.length
  )
    fail("wrong/duplicate/incomplete report identity");
  return rows;
}
function reclose(
  input: DelawareCandidateFinancialBindingInput["receipts"],
  kind: "receipts" | "expenses",
  captures: readonly DelawareCandidateFinancialObservation[],
  owner: DelawareCandidateFinancialOwner,
): DelawareNativeLedger {
  const receipt = kind === "receipts";
  const search = one(
    captures,
    receipt ? "/Public/ViewReceipts" : "/Public/OtherSearch",
    "POST",
  );
  const expected = receipt
    ? buildDelawareReceiptsSearchFields({
        txtReceivingRegistrant: owner.committeeName,
        MemberId: String(owner.memberId),
      })
    : buildDelawareExpensesSearchFields({
        txtRegistrant: owner.committeeName,
        MemberId: String(owner.memberId),
        CommitteeType: "01",
      });
  const fields = scope(search, expected, ["dtStartDate", "dtEndDate"]);
  if (Boolean(fields.dtStartDate) !== Boolean(fields.dtEndDate))
    fail("partial native date scope");
  const start = fields.dtStartDate ? civil(fields.dtStartDate) : null;
  const end = fields.dtEndDate ? civil(fields.dtEndDate) : null;
  if (start && end && start > end) fail("reversed native date scope");
  const renderedCount = extractDelawareGridTotal(text(search));
  if (renderedCount === null) fail("missing independent rendered count");
  const rawPages = captures.filter(
    (capture) =>
      url(capture).pathname ===
        (receipt
          ? "/Public/_ViewReceiptsCustom"
          : "/Public/_ViewExpensesCustom") && capture.method === "POST",
  );
  const pages = rawPages.map((capture) => {
    const params = url(capture).searchParams;
    if (
      params.get("Grid-size") !== "15" ||
      params.get("theme") !== "vista" ||
      Date.parse(capture.startedAt) < Date.parse(search.completedAt)
    )
      fail("wrong native stored-query context");
    const fields = scope(
      capture,
      { page: "", size: "", orderBy: "", groupBy: "", filter: "" },
      ["page", "size"],
    );
    return {
      pageNumber: Number(fields.page),
      pageSize: Number(fields.size),
      page: (receipt
        ? decodeDelawareReceiptNativePage
        : decodeDelawareExpenseNativePage)(text(capture)),
    };
  });
  const csv = one(
    captures,
    receipt ? "/Public/ExportCSVNew" : "/Public/ExportExpensestoCsv",
    "GET",
  );
  const csvRequest = url(csv);
  queryKeys(csvRequest, Object.keys(DELAWARE_CFRS_EXPORT_QUERY));
  if (
    [...csvRequest.searchParams].some(
      ([key, value]) =>
        value !== (DELAWARE_CFRS_EXPORT_QUERY as Record<string, string>)[key],
    )
  )
    fail("narrowed/changed source CSV query");
  if (Date.parse(csv.startedAt) < Date.parse(search.completedAt))
    fail("export before stored query");
  const closed = closeDelawareNativeLedger({
    pages,
    renderedCount,
    csv: text(csv),
  });
  if (canonical(closed) !== canonical(input.ledger))
    fail("supplied native ledger differs from original reclosure");
  for (const row of closed.rows) {
    if (
      field(row, receipt ? "WC_ID" : "CCF_ID") !== owner.cfId ||
      display(
        field(row, receipt ? "ReceivingCommitteeName" : "RegistrantName"),
      ) !== owner.committeeName ||
      (start && row.date < start) ||
      (end && row.date > end)
    )
      fail("wrong native owner/date scope");
  }
  return closed;
}
/** Exact published inventory-to-native display permutations witnessed in the source. */
function periodAliases(row: DelawareFiledReportRow): {
  receipts: string;
  expenses: string;
} {
  const period = display(row.filingPeriodName);
  const year = row.filingYear;
  if (!/^\d{4}$/.test(year)) fail("invalid inventory year");
  if (period === `${year} Annual`)
    return { receipts: period, expenses: period };
  const match =
    /^(\d{4}) (30|8) Day (\d{4}) (Primary|General) Election (\d{2}\/\d{2}\/\d{4})$/.exec(
      period,
    );
  if (
    !match ||
    match[1] !== year ||
    match[3] !== year ||
    civil(match[5]!).slice(0, 4) !== year
  )
    fail("unsupported published inventory/native period grammar");
  return {
    receipts: `${year} ${year} ${match[4]} Election ${match[5]} ${match[2]} Day`,
    expenses: `${year} ${match[2]} Day ${match[4]}`,
  };
}
function tuple(date: string, amount: number, name: string): string {
  return JSON.stringify([date, amount, monetaryName(name)]);
}
function sum(rows: readonly number[]): number {
  const value = rows.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(value)) fail("unsafe monetary sum");
  return value;
}
const cashTypes = new Set([
  "Check",
  "Credit Card",
  "Cash",
  "EFT",
  "Electronic Fund Transfer",
  "Refund/Rebate",
]);
function bindOccurrences(
  native: readonly DelawareNativeLedgerRow[],
  pdf: readonly DelawareCandidatePdfOccurrence[],
  receipt: boolean,
): DelawareFinancialOccurrenceEquivalence[] {
  const nativeGroups = new Map<string, DelawareNativeLedgerRow[]>();
  for (const row of native) {
    const key = tuple(
      row.date,
      row.amountCents,
      field(row, receipt ? "ContributorName" : "PayeeName"),
    );
    const group = nativeGroups.get(key) ?? [];
    group.push(row);
    nativeGroups.set(key, group);
  }
  const pdfGroups = new Map<
    string,
    {
      rows: DelawareCandidatePdfOccurrence[];
      annotations: { occurrence: number; literal: "(Return Contributions)" }[];
    }
  >();
  for (const row of pdf) {
    let name = row.columns.name!;
    let annotation = false;
    const suffix = " (Return Contributions)";
    if (!receipt && name.endsWith(suffix)) {
      const counterpart = nativeGroups.get(
        tuple(
          row.date,
          row.monetaryColumns.amount!,
          name.slice(0, -suffix.length),
        ),
      );
      if (
        counterpart?.length !== 1 ||
        field(counterpart[0]!, "ExpenseCategory") !== "Return Contributions"
      )
        fail("unbound/ambiguous Return Contributions annotation");
      name = name.slice(0, -suffix.length);
      annotation = true;
    }
    const key = tuple(row.date, row.monetaryColumns.amount!, name);
    const group = pdfGroups.get(key) ?? { rows: [], annotations: [] };
    group.rows.push(row);
    if (annotation)
      group.annotations.push({
        occurrence: row.occurrence,
        literal: "(Return Contributions)",
      });
    pdfGroups.set(key, group);
  }
  if (nativeGroups.size !== pdfGroups.size)
    fail("missing/extra monetary identity groups");
  return [...pdfGroups].map(([key, group]) => {
    const nativeRows = nativeGroups.get(key);
    if (!nativeRows || nativeRows.length !== group.rows.length)
      fail("complete monetary occurrence multiset mismatch");
    const classes = new Set(
      nativeRows.map((row) =>
        field(row, receipt ? "ContributorType" : "PayeeType"),
      ),
    );
    const mechanisms = new Set(
      nativeRows.map((row) =>
        field(row, receipt ? "ContributionType" : "ExpenseCategory"),
      ),
    );
    const periods = new Set(
      nativeRows.map((row) => display(field(row, "FilingPeriodName"))),
    );
    if (classes.size !== 1 || mechanisms.size !== 1 || periods.size !== 1)
      fail("conflicting repeated monetary class/mechanism/period");
    const ids = nativeRows
      .map((row) => row.transactionId)
      .sort((a, b) => a - b);
    const nativeAddresses = nativeRows
      .map((row) =>
        monetaryName(field(row, receipt ? "ContributorAddress" : "Address")),
      )
      .sort();
    const pdfAddresses = group.rows
      .map((row) => monetaryName(row.columns.address!))
      .sort();
    return {
      date: nativeRows[0]!.date,
      amountCents: nativeRows[0]!.amountCents,
      monetaryName: monetaryName(
        field(nativeRows[0]!, receipt ? "ContributorName" : "PayeeName"),
      ),
      nativeTransactionIds: ids,
      nativeRows,
      pdfOccurrences: group.rows,
      sourceClass: [...classes][0]!,
      sourceMechanism: [...mechanisms][0]!,
      categoryAnnotations: group.annotations,
      addressDiagnostics:
        canonical(nativeAddresses) === canonical(pdfAddresses)
          ? []
          : [
              {
                nativeTransactionIds: ids,
                pdfOccurrences: group.rows.map((row) => row.occurrence),
                reason:
                  "Native live composite and filed PDF address values differ; both raw values retained without rewriting.",
              },
            ],
    };
  });
}
function splitAggregate(
  native: readonly DelawareNativeLedgerRow[],
  pdf: readonly DelawareCandidatePdfOccurrence[],
  receipt: boolean,
): {
  itemized: DelawareNativeLedgerRow[];
  aggregates: DelawareNativeLedgerRow[];
} {
  const keys = new Set(
    pdf.map((row) =>
      tuple(row.date, row.monetaryColumns.amount!, row.columns.name!),
    ),
  );
  const label = receipt
    ? "Total of Contributions not exceeding $100"
    : "Total of Expenditures not exceeding $100";
  const itemized: DelawareNativeLedgerRow[] = [],
    aggregates: DelawareNativeLedgerRow[] = [];
  for (const row of native) {
    const type = field(row, receipt ? "ContributionType" : "ExpenseCategory");
    const entity = field(row, receipt ? "ContributorType" : "PayeeType");
    if (
      type === label &&
      entity === label &&
      !keys.has(
        tuple(
          row.date,
          row.amountCents,
          field(row, receipt ? "ContributorName" : "PayeeName"),
        ),
      )
    )
      aggregates.push(row);
    else itemized.push(row);
  }
  return { itemized, aggregates };
}

/** Financial source correspondence only; never current-edition, statutory-window or PAC authority. */
export async function bindDelawareCandidateFinancialFacts(
  original: DelawareCandidateFinancialBindingInput,
): Promise<DelawareCandidateFinancialBindings> {
  const owner = {
    ...original.owner,
    committeeName: display(original.owner.committeeName),
  };
  if (
    !/^01\d{6}$/.test(owner.cfId) ||
    !Number.isSafeInteger(owner.memberId) ||
    owner.memberId < 1 ||
    !owner.committeeName ||
    !original.reports.length
  )
    fail("invalid owner/report input");
  const diagnostics: string[] = [];
  const inventoryCaptures = observations(
    original.inventoryCaptures,
    diagnostics,
  );
  const receiptCaptures = observations(original.receipts.captures, diagnostics);
  const expenseCaptures = observations(original.expenses.captures, diagnostics);
  const pdfCaptures = observations(
    original.reports.map((report) => report.pdfCapture),
    diagnostics,
  );
  const reportInputs = original.reports.map((report) =>
    structuredClone(report.facts),
  );
  const nativeInputs = {
    receipts: structuredClone(original.receipts.ledger),
    expenses: structuredClone(original.expenses.ledger),
  };
  const allRows = inventory(inventoryCaptures, owner);
  const receipts = reclose(
    { ledger: nativeInputs.receipts, captures: receiptCaptures },
    "receipts",
    receiptCaptures,
    owner,
  );
  const expenses = reclose(
    { ledger: nativeInputs.expenses, captures: expenseCaptures },
    "expenses",
    expenseCaptures,
    owner,
  );
  const decoded: {
    row: DelawareFiledReportRow;
    facts: DelawareCandidateFinancialReport;
    aliases: { receipts: string; expenses: string };
  }[] = [];
  for (const [index, capture] of pdfCaptures.entries()) {
    const request = url(capture);
    queryKeys(request, ["FileName", "CommitteeID", "FilingCalendarID"]);
    if (
      request.pathname !== "/Public/FiledReports" ||
      capture.method !== "GET" ||
      request.searchParams.get("CommitteeID") !== String(owner.memberId) ||
      [...request.searchParams.keys()].some(
        (key) => !["FileName", "CommitteeID", "FilingCalendarID"].includes(key),
      )
    )
      fail("wrong report PDF source request");
    const found = allRows.filter(
      (row) =>
        row.document!.publicReportFileName ===
          request.searchParams.get("FileName") &&
        String(row.document!.filingCalendarId) ===
          request.searchParams.get("FilingCalendarID"),
    );
    if (found.length !== 1)
      fail("report PDF not uniquely bound to complete inventory");
    const facts = await readDelawareCandidateFinancialReport(capture.body);
    if (
      canonical(facts) !== canonical(reportInputs[index]) ||
      facts.accountNumber !== owner.cfId ||
      display(facts.organizationName) !== owner.committeeName ||
      facts.periodEnd.slice(0, 4) !== found[0]!.filingYear
    )
      fail("supplied PDF facts or source identity mismatch");
    decoded.push({ row: found[0]!, facts, aliases: periodAliases(found[0]!) });
  }
  if (
    new Set(decoded.map((report) => report.row.document!.filingCalendarId))
      .size !== decoded.length
  )
    fail("multiple supplied editions of one source calendar period");
  for (const kind of ["receipts", "expenses"] as const) {
    for (const row of (kind === "receipts" ? receipts : expenses).rows) {
      const matches = decoded.filter(
        (report) =>
          report.aliases[kind] === display(field(row, "FilingPeriodName")),
      );
      if (matches.length !== 1)
        fail(
          "native source period missing/ambiguous in supplied report inventory",
        );
    }
  }
  const reports: DelawareCandidateFinancialBindingReport[] = decoded.map(
    ({ row: inventoryRow, facts, aliases }) => {
      const receiptRows = receipts.rows.filter(
        (row) => display(field(row, "FilingPeriodName")) === aliases.receipts,
      );
      const expenseRows = expenses.rows.filter(
        (row) => display(field(row, "FilingPeriodName")) === aliases.expenses,
      );
      const unsupported: DelawareCandidateFinancialBindingReport["unsupportedMechanisms"][number][] =
        [];
      const cashReceiptRows = receiptRows.filter(
        (row) =>
          cashTypes.has(field(row, "ContributionType")) ||
          field(row, "ContributionType") ===
            "Total of Contributions not exceeding $100",
      );
      const inKindReceiptRows = receiptRows.filter(
        (row) => field(row, "ContributionType") === "In-Kind",
      );
      const inKindExpenseRows = expenseRows.filter(
        (row) => field(row, "ExpenseCategory") === "In-Kind",
      );
      const cashExpenseRows = expenseRows.filter(
        (row) => field(row, "ExpenseCategory") !== "In-Kind",
      );
      const a = splitAggregate(
        cashReceiptRows,
        facts.schedules.receipts.rows,
        true,
      );
      const b = splitAggregate(
        cashExpenseRows,
        facts.schedules.expenditures.rows,
        false,
      );
      const bindings = {
        receipts: bindOccurrences(
          a.itemized,
          facts.schedules.receipts.rows,
          true,
        ),
        expenditures: bindOccurrences(
          b.itemized,
          facts.schedules.expenditures.rows,
          false,
        ),
        inKindReceipts: bindOccurrences(
          inKindReceiptRows,
          facts.schedules.inKindReceipts.rows,
          true,
        ),
        inKindExpenditures: bindOccurrences(
          inKindExpenseRows,
          facts.schedules.inKindExpenditures.rows,
          false,
        ),
      };
      const aggregates: DelawareFinancialAggregatePlacement[] = [
        ["receipts", a.aggregates],
        ["expenditures", b.aggregates],
      ].map(([key, source]) => {
        const schedule = key as "receipts" | "expenditures",
          rows = source as DelawareNativeLedgerRow[];
        const controlCents = facts.schedules[schedule].controls.anonymousCents!;
        const representedNativeCents = sum(rows.map((row) => row.amountCents));
        if (
          controlCents < 0 ||
          representedNativeCents < 0 ||
          representedNativeCents > controlCents ||
          (rows.length > 0 && representedNativeCents !== controlCents)
        )
          fail("anonymous aggregate excess/partial/negative/double count");
        return {
          schedule,
          controlCents,
          representedNativeCents,
          nativeTransactionIds: rows
            .map((row) => row.transactionId)
            .sort((a, b) => a - b),
          pdfOnlyAggregateCents: controlCents - representedNativeCents,
        };
      });
      const known = new Set(
        [...cashReceiptRows, ...inKindReceiptRows].map(
          (row) => row.transactionId,
        ),
      );
      const unknown = receiptRows.filter(
        (row) => !known.has(row.transactionId),
      );
      if (unknown.length)
        unsupported.push({
          schedule: null,
          nativeTransactionIds: unknown.map((row) => row.transactionId),
          reason:
            "Native receipt mechanisms need separate loan/reimbursement/supplemental schedule correspondence.",
        });
      for (const schedule of [
        "loansReceived",
        "loansOutstanding",
        "reimbursementsReceived",
        "reimbursementsPaid",
        "assets",
        "assetsEliminated",
      ] as const) {
        // Outstanding balances are retained facts, not current loan receipts or offsets.
        if (schedule === "loansOutstanding") {
          if (facts.schedules[schedule].controls.paymentsCents !== 0)
            unsupported.push({
              schedule,
              nativeTransactionIds: [],
              reason:
                "Published loan payments need their own native payment correspondence; outstanding principal retained separately.",
            });
        } else if (
          facts.schedules[schedule].rows.length ||
          Object.values(facts.schedules[schedule].controls).some(
            (value) => value !== 0,
          )
        )
          unsupported.push({
            schedule,
            nativeTransactionIds: [],
            reason:
              "Published supplemental mechanism retained; its independent native projection is not yet established.",
          });
      }
      for (const row of [...receiptRows, ...expenseRows])
        if (row.date > facts.periodEnd || row.date < facts.periodStart)
          diagnostics.push(
            `Native transaction ${row.transactionId} is ${row.date < facts.periodStart ? "before" : "after"} its bound published report period; no scope/currentness acceptance inferred.`,
          );
      return {
        inventoryRow,
        facts,
        bindings,
        aggregates,
        unsupportedMechanisms: unsupported,
      };
    },
  );
  return {
    scope: "candidate_financial_source_facts",
    owner,
    reports,
    diagnostics,
    sourceMetadata: [
      ...inventoryCaptures,
      ...receiptCaptures,
      ...expenseCaptures,
      ...pdfCaptures,
    ].map(({ body: _body, ...metadata }) => metadata),
  };
}
