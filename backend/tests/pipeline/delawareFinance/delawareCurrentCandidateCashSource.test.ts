import {
  verifyDelawareCurrentCandidateCash,
  type DelawareCurrentCandidateCashInput,
} from "../../../src/pipeline/delawareFinance/delawareCurrentCandidateCashSource.js";
import { buildDelawareCommitteeSearchFields } from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import type { DelawareCfrsResponseCapture } from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import type { DelawareCfrsCandidateSourcePacket } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactAcquisition.js";
import { parseDelawareFiledReportsHtml } from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type DelawareCandidateFinancialBindingInput,
  type DelawareCandidateFinancialObservation,
} from "../../../src/pipeline/delawareFinance/delawareCandidateFinancialBindings.js";
import {
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
  buildDelawareReceiptsSearchFields,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import {
  DELAWARE_EXPENSE_CSV_COLUMNS,
  DELAWARE_RECEIPT_CSV_COLUMNS,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import {
  closeDelawareNativeLedger,
  decodeDelawareExpenseNativePage,
  decodeDelawareReceiptNativePage,
  DELAWARE_NATIVE_EXPENSE_FIELDS,
  DELAWARE_NATIVE_RECEIPT_FIELDS,
  projectDelawareNativeExpenseCsvRow,
  projectDelawareNativeReceiptCsvRow,
  type DelawareNativeLedgerPage,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import type {
  DelawareCandidateFinancialReport,
  DelawareCandidatePdfOccurrence,
  DelawareCandidateScheduleName,
} from "../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js";

// The facts parser has its own positioned-PDF tests and genuine seven-PDF replay.
// These protocol packets encode sanitized parsed facts so monetary/scope negatives
// exercise the real inventory, native schema, CSV closure and binder validators.
vi.mock("../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js", () => ({
  readDelawareCandidateFinancialReport: async (body: Buffer) => ({
    ...JSON.parse(body.toString()),
    pdfSha256: createHash("sha256").update(body).digest("hex"),
    byteCount: body.length,
  }),
}));
const owner = {
  cfId: "01000001",
  memberId: 733862,
  committeeName: "Friends of Example Candidate",
};
const file = "CampaignFinanceReport_Prelim_733862_1273_example.pdf";
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const origin = "https://cfrs.elections.delaware.gov";
let clock = 0;
function capture(
  path: string,
  method: "GET" | "POST",
  body: string,
  fields: Record<string, string> | null = null,
): DelawareCandidateFinancialObservation {
  const bytes = Buffer.from(body);
  const startedAt = new Date(Date.UTC(2026, 9, 11, 12, 0, clock++)).toISOString(),
    completedAt = new Date(Date.UTC(2026, 9, 11, 12, 0, clock++)).toISOString();
  return {
    body: bytes,
    url: origin + path,
    method,
    financeFields: fields,
    requestScopeRedacted: false,
    attempt: 1,
    status: 200,
    startedAt,
    completedAt,
    contentType: "text/plain",
    byteCount: bytes.length,
    sha256: sha(bytes),
  };
}
function receipt(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(DELAWARE_NATIVE_RECEIPT_FIELDS.map((key) => [key, ""])),
    ContributionType: "Check",
    TransactionDate: "/Date(1786507200000)/",
    Transaction_id: id,
    ContributorName: "Example PAC",
    ContributionAmount: 600,
    ContributorType: "Political Action Committee",
    ReceivingCommitteeName: owner.committeeName,
    GabId: "123456",
    WC_ID: owner.cfId,
    Office: null,
    Branch: null,
    EmployerAddress: null,
    EmployerAddressLine1: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    FilingPeriodName: "2026 2026 General Election 11/03/2026 30 Day",
    ContributorAddress: "SOURCE ADDRESS",
    AddressLine1: "SANITIZED ADDRESS",
    City: "Example",
    State_Code: "DE",
    Zip_Code: "19901",
    ...overrides,
  };
}
function expense(id = 2, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(DELAWARE_NATIVE_EXPENSE_FIELDS.map((key) => [key, ""])),
    Transaction_Id: id,
    RegistrantName: owner.committeeName,
    PayeeName: "Example Vendor",
    PayeeType: "Corporation, Partnership, and Other Entity",
    TransactionDate: "/Date(1786507200000)/",
    ExpenseAmount: 100,
    ExpenseCategory: "Other Expenses",
    ExpensePurpose: "Other",
    ExpenseMethod: "Check",
    District: null,
    FilingYear: null,
    CommitteeID: null,
    Comments: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    CCF_ID: owner.cfId,
    FilingPeriodName: "2026 30 Day General",
    Address: "SOURCE ADDRESS",
    AddressLine1: "SANITIZED ADDRESS",
    City: "Example",
    State: "DE",
    ZipCode: "19901",
    ...overrides,
  };
}
function occurrence(name: string, amount: number, index = 0): DelawareCandidatePdfOccurrence {
  return {
    occurrence: index,
    pageNumber: 3,
    pageNumbers: [3],
    date: "2026-08-12",
    columns: {
      date: "08/12/2026",
      name,
      address: "SOURCE ADDRESS",
      vendor: "",
    },
    monetaryColumns: { amount, aggregate: amount },
    rawCells: [],
  };
}
function facts(): DelawareCandidateFinancialReport {
  const keys: DelawareCandidateScheduleName[] = [
    "receipts",
    "expenditures",
    "inKindReceipts",
    "inKindExpenditures",
    "loansReceived",
    "loansOutstanding",
    "reimbursementsReceived",
    "reimbursementsPaid",
    "assets",
    "assetsEliminated",
  ];
  const schedules = Object.fromEntries(
    keys.map((key) => [key, { rows: [], controls: { totalCents: 0 } }]),
  ) as unknown as DelawareCandidateFinancialReport["schedules"];
  const mutable = schedules as Record<
    string,
    { rows: DelawareCandidatePdfOccurrence[]; controls: Record<string, number> }
  >;
  mutable.receipts = {
    rows: [occurrence("Example PAC", 60000)],
    controls: {
      itemizedCents: 60000,
      anonymousCents: 124000,
      grandCents: 184000,
    },
  };
  mutable.expenditures = {
    rows: [occurrence("Example Vendor", 10000)],
    controls: { itemizedCents: 10000, anonymousCents: 0, grandCents: 10000 },
  };
  mutable.inKindReceipts = {
    rows: [],
    controls: { itemizedCents: 0, anonymousCents: 0, grandCents: 0 },
  };
  mutable.inKindExpenditures = {
    rows: [],
    controls: { itemizedCents: 0, anonymousCents: 0, grandCents: 0 },
  };
  mutable.loansOutstanding = {
    rows: [],
    controls: {
      previousCents: 3400000,
      paymentsCents: 0,
      balanceCents: 3400000,
    },
  };
  return {
    pdfSha256: "",
    byteCount: 0,
    accountNumber: owner.cfId,
    organizationName: owner.committeeName,
    periodStart: "2026-01-01",
    periodEnd: "2026-10-04",
    reportDate: "2026-10-05",
    cover: {
      pageNumber: 2,
      beginningBalanceCents: 0,
      receiptsCents: 184000,
      expendituresCents: 10000,
      endingBalanceCents: 174000,
      reportingPeriodFrom: "01/01/2026",
      reportingPeriodTo: "10/04/2026",
      documentVersion: 1,
      method: "rows",
    },
    supplementaryCoverControls: {
      assetsCents: 0,
      assetsEliminatedCents: 0,
      loansOutstandingCents: 3400000,
    },
    schedules,
    sourcePages: [],
  };
}
function csv(page: DelawareNativeLedgerPage) {
  const receipt = page.kind === "receipts",
    columns = receipt ? DELAWARE_RECEIPT_CSV_COLUMNS : DELAWARE_EXPENSE_CSV_COLUMNS;
  return (
    columns.join(",") +
    ",\n" +
    page.rows
      .map((row) => {
        const projected = (
          receipt ? projectDelawareNativeReceiptCsvRow : projectDelawareNativeExpenseCsvRow
        )(row);
        const dateKey = receipt ? "Contribution Date" : "Expenditure Date",
          amountKey = receipt ? "Contribution Amount" : "Amount($)";
        const [y, m, d] = projected[dateKey]!.split("-");
        projected[dateKey] = `${Number(m)}/${Number(d)}/${y}`;
        projected[amountKey] = (Number(projected[amountKey]) / 100).toFixed(4);
        return columns.map((key) => projected[key]).join(",");
      })
      .join("\n") +
    "\n"
  );
}
function nativeGroup(rows: Record<string, unknown>[], kind: "receipts" | "expenses") {
  const receipt = kind === "receipts",
    json = JSON.stringify({ data: rows, total: 999999 }),
    page = (receipt ? decodeDelawareReceiptNativePage : decodeDelawareExpenseNativePage)(json),
    sourceCsv = csv(page);
  const query = capture(
    receipt ? "/Public/ViewReceipts?theme=vista" : "/Public/OtherSearch?theme=vista",
    "POST",
    `jQuery('#Grid').tGrid({total:${rows.length}});`,
    receipt
      ? buildDelawareReceiptsSearchFields({
          txtReceivingRegistrant: owner.committeeName,
          MemberId: String(owner.memberId),
        })
      : buildDelawareExpensesSearchFields({
          txtRegistrant: owner.committeeName,
          MemberId: String(owner.memberId),
          CommitteeType: "01",
        }),
  );
  const native = capture(
    (receipt ? "/Public/_ViewReceiptsCustom" : "/Public/_ViewExpensesCustom") +
      "?Grid-size=15&theme=vista",
    "POST",
    json,
    { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" },
  );
  const exported = capture(
    (receipt ? "/Public/ExportCSVNew" : "/Public/ExportExpensestoCsv") +
      "?page=1&orderBy=~&filter=~&Grid-size=15&theme=vista",
    "GET",
    sourceCsv,
  );
  return {
    ledger: closeDelawareNativeLedger({
      pages: [{ pageNumber: 1, pageSize: 500, page }],
      renderedCount: rows.length,
      csv: sourceCsv,
    }),
    captures: [query, native, exported],
  };
}
function packet(
  options: {
    receipts?: Record<string, unknown>[];
    expenses?: Record<string, unknown>[];
    facts?: DelawareCandidateFinancialReport;
  } = {},
): DelawareCandidateFinancialBindingInput {
  clock = 0;
  const report = options.facts ?? facts();
  const search = capture(
    "/Public/ViewFiledReports?theme=vista",
    "POST",
    "inventory search",
    buildDelawareFiledReportsSearchFields({
      MemberId: String(owner.memberId),
      txtCommitteeName: owner.committeeName,
    }),
  );
  const html = `jQuery('#Grid').tGrid({total:1});<div id="Grid"><table><tbody><tr><td>2026 30 Day 2026 General Election 11/03/2026</td><td><a onclick="downloadReport(&#39;${file}&#39;,&#39;733862&#39;,&#39;1273&#39;)">Amended Financial Statement</a></td><td>${owner.cfId}</td><td>${owner.committeeName}</td><td>Candidate Committee</td><td>10/05/2026</td><td>2026</td><td>State Office - State Representative</td><td>Active</td></tr></tbody></table></div>`;
  const inventory = capture(
    "/Public/_ViewFiledReports?ajax=True&Grid-page=1&Grid-orderBy=~&Grid-groupBy=~&Grid-filter=~&Grid-size=500&theme=vista",
    "GET",
    html,
  );
  const receipts = nativeGroup(options.receipts ?? [receipt()], "receipts"),
    expenses = nativeGroup(options.expenses ?? [expense()], "expenses");
  const pdfCapture = capture(
    `/Public/FiledReports?FileName=${file}&CommitteeID=733862&FilingCalendarID=1273`,
    "GET",
    JSON.stringify(report),
  );
  report.pdfSha256 = pdfCapture.sha256;
  report.byteCount = pdfCapture.byteCount;
  return {
    owner: { ...owner },
    inventoryCaptures: [search, inventory],
    reports: [{ facts: report, pdfCapture }],
    receipts,
    expenses,
  };
}
function replaceBody(c: DelawareCandidateFinancialObservation, body: string) {
  c.body = Buffer.from(body);
  c.byteCount = c.body.length;
  c.sha256 = sha(c.body);
}

const target = {
  candidateId: "00000000-0000-4000-8000-000000000001",
  electionId: "00000000-0000-4000-8000-000000000002",
  candidateName: "Example Candidate",
  officeName: "State Representative",
  district: "38",
  party: "Republican",
  electionYear: 2026,
  electionDate: "2026-11-03",
  electionStage: "general" as const,
  receivingCfId: owner.cfId,
  receivingMemberId: owner.memberId,
  receivingCommitteeName: owner.committeeName,
};
function soa() {
  return `<table><tr><td>Committee Name:</td><td>${owner.committeeName}</td></tr><tr><td>Date of Origination:</td><td>01/01/2026</td></tr></table>
  <table id="Viewelection"><tr><td>State Office</td><td>Na</td><td>State Representative</td><td>District 38</td><td>Republican</td></tr></table>
  <table id="CandidateList"><tr><td>Example Candidate</td><td></td><td></td><td></td></tr></table>`;
}
function modern(c: DelawareCandidateFinancialObservation): DelawareCfrsResponseCapture {
  return { ...c, body: Buffer.from(c.body), attempt: 1, requestScopeRedacted: false };
}
function regRows() {
  return [
    {
      MemberID: 733862,
      MemberVersID: 1,
      Committee_Id: owner.cfId,
      CommitteeName: owner.committeeName,
      CommitteeTypeCode: "01",
      CommitteeType: "Candidate Committee",
      CommitteeStatus: "Active",
      Formtype: "SO",
      Office: "State Office - State Representative",
      District: "District 38",
    },
    {
      MemberID: 10,
      MemberVersID: 1,
      Committee_Id: "02000010",
      CommitteeName: "Example PAC",
      CommitteeTypeCode: "02",
      CommitteeType: "Political Action Committee",
      CommitteeStatus: "Active",
      RegisteredDateStr: "01/01/2020",
      Formtype: "SO",
    },
  ];
}
function registryPacket(rows = regRows(), broad = false): DelawareCfrsResponseCapture[] {
  return [
    capture("/Public/ViewCommittees", "GET", "form"),
    capture(
      "/Public/Search?theme=vista",
      "POST",
      `jQuery('#Grid').tGrid({total:${rows.length}});`,
      buildDelawareCommitteeSearchFields(
        broad ? {} : { CommitteeType: "01", txtCommitteeID: owner.cfId },
      ),
    ),
    capture(
      "/Public/_ViewCommittees?theme=vista",
      "POST",
      JSON.stringify({ data: rows, total: rows.length }),
      { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" },
    ),
  ].map(modern);
}
function phasePacket(
  options: Parameters<typeof packet>[0] = {},
): DelawareCfrsCandidateSourcePacket {
  const copy = structuredClone(options);
  const f = copy.facts ?? facts();
  for (const key of ["receipts", "expenditures", "inKindReceipts", "inKindExpenditures"] as const) {
    const schedule = f.schedules[key];
    const itemized = schedule.rows.reduce((n, r) => n + r.monetaryColumns.amount!, 0);
    (schedule.controls as Record<string, number>).itemizedCents = itemized;
    (schedule.controls as Record<string, number>).grandCents =
      itemized + schedule.controls.anonymousCents!;
  }
  f.cover.receiptsCents =
    f.schedules.receipts.controls.grandCents! + f.schedules.inKindReceipts.controls.grandCents!;
  f.cover.expendituresCents =
    f.schedules.expenditures.controls.grandCents! +
    f.schedules.inKindExpenditures.controls.grandCents!;
  f.cover.endingBalanceCents =
    f.cover.beginningBalanceCents + f.cover.receiptsCents - f.cover.expendituresCents;
  const base = packet({ ...copy, facts: f });
  const registry = registryPacket();
  const so = modern(
    capture(
      `/Public/ShowReview?memberID=${owner.memberId}&memVersID=1&cTypeCode=01&ftype=SO&fpath=&fname=&isPublic=true`,
      "GET",
      soa(),
    ),
  );
  const latestSearch = modern(
    capture("/Public/ViewFiledReports?theme=vista", "POST", "current search", {
      ...buildDelawareFiledReportsSearchFields({
        MemberId: String(owner.memberId),
        txtCommitteeName: owner.committeeName,
      }),
      hdnViewCurrent: "true",
      chkViewCurrReport: "on",
    }),
  );
  const latestPage = {
    ...modern(base.inventoryCaptures[1]!),
    body: Buffer.from(base.inventoryCaptures[1]!.body),
  };
  const receiptEntry = modern(capture("/Public/ViewReceiptsMain", "GET", "form"));
  const expenseEntry = modern(capture("/Public/ViewExpenses", "GET", "form"));
  for (const c of [base.receipts.captures[0]!, base.expenses.captures[0]!])
    c.financeFields = { ...c.financeFields, dtStartDate: "", dtEndDate: "" };
  const caps = [
    ...registry,
    so,
    ...base.inventoryCaptures.map(modern),
    latestSearch,
    latestPage,
    ...base.reports.map((r) => ({ ...modern(r.pdfCapture), contentType: "application/pdf" })),
    receiptEntry,
    ...base.receipts.captures.map(modern),
    expenseEntry,
    ...base.expenses.captures.map(modern),
  ];
  const rows = parseDelawareFiledReportsHtml(base.inventoryCaptures[1]!.body.toString()).rows;
  return {
    sourceCaptures: caps,
    registryRows: regRows(),
    organizationUrls: [so.url],
    diagnostics: [],
    requestWindow: null,
    queryScope: { kind: "whole_member" },
    allVersionReportRows: rows,
    latestAccountReportRows: rows,
    reportPdfs: [],
    receiptsCsv: "",
    expensesCsv: "",
    receiptRenderedCount: base.receipts.ledger.rows.length,
    expenseRenderedCount: base.expenses.ledger.rows.length,
    receipts: base.receipts.ledger,
    expenses: base.expenses.ledger,
  };
}
function retime(caps: readonly DelawareCfrsResponseCapture[], start: number) {
  // Synthetic source protocol only: no real captures or money claims are retimed.
  caps.forEach((c, i) => {
    c.startedAt = new Date(start + i * 2000).toISOString();
    c.completedAt = new Date(start + i * 2000 + 1000).toISOString();
  });
}
function input(options: Parameters<typeof packet>[0] = {}): DelawareCurrentCandidateCashInput {
  const before = phasePacket(options),
    after = phasePacket(options);
  const donorRegistryBefore = registryPacket(regRows(), true),
    donorRegistryAfter = registryPacket(regRows(), true);
  let start = Date.UTC(2026, 9, 11, 12);
  for (const caps of [
    donorRegistryBefore,
    before.sourceCaptures,
    after.sourceCaptures,
    donorRegistryAfter,
  ]) {
    retime(caps, start);
    start += caps.length * 2000 + 1000;
  }
  return {
    target: { ...target },
    campaignAuthority: { kind: "new_account" },
    before,
    after,
    donorRegistryBefore,
    donorRegistryAfter,
  };
}
function find(p: DelawareCfrsCandidateSourcePacket, route: string, method = "GET") {
  return p.sourceCaptures.find((c) => new URL(c.url).pathname === route && c.method === method)!;
}
function replaceRegistry(p: DelawareCurrentCandidateCashInput, rows: ReturnType<typeof regRows>) {
  for (const caps of [p.donorRegistryBefore, p.donorRegistryAfter]) {
    replaceBody(caps[1]!, `jQuery('#Grid').tGrid({total:${rows.length}});`);
    replaceBody(caps[2]!, JSON.stringify({ data: rows, total: rows.length }));
  }
}
const columns = [
  "Candidate Name",
  "Party Name",
  "Machine Votes",
  "Absentee Votes",
  "Early Voting Votes",
  "Total Votes",
  "Percentage",
];
function resultRow(name: string, party: string, values: string[]) {
  return `<tr>${[name, party, ...values].map((value, index) => `<td data-label="${columns[index]}">${value}</td>`).join("")}</tr>`;
}
const resultTable =
  `<table><thead><tr>${columns.map((value) => `<th>${value}</th>`).join("")}</tr></thead><tbody>` +
  resultRow("KATHY JENNINGS", "Democratic Party", [
    "122,087",
    "16,162",
    "33,588",
    "171,837",
    "53.83",
  ]) +
  resultRow("OTHER CANDIDATE", "Republican Party", [
    "119,946",
    "6,256",
    "21,167",
    "147,369",
    "46.17",
  ]) +
  "</tbody></table>";
const election =
  `<h1>2022 General Election Report</h1><h2 class="electionDate">November 8th 2022</h2>` +
  `<span class="resultsType"><span>OFFICIAL RESULTS</span></span>` +
  `<div id="statewide"><h3>Attorney General</h3>${resultTable}</div>` +
  `<div id="district"><h3>Attorney General</h3>${resultTable.replace(/KATHY JENNINGS/g, "DISTRICT CANDIDATE")}</div>`;
const ballotTable =
  `<table><thead><tr><th>Race</th><th>Instruction</th><th>Democratic Party</th><th>Republican Party</th><th>Write-in</th></tr></thead>` +
  `<tbody><tr><td data-label="Race">Attorney General</td><td data-label="Instruction">Vote for 1</td>` +
  `<td data-label="Democratic Party">KATHY JENNINGS</td><td data-label="Republican Party">OTHER CANDIDATE</td>` +
  `<td data-label="Write-in">Write-in</td></tr></tbody></table>`;
const sample = `<h1>Sample Ballot</h1><ul><li>November 3, 2026 General Election</li></ul>${ballotTable}`;

function incumbentInput(): DelawareCurrentCandidateCashInput {
  const p = input();
  p.target = {
    ...p.target,
    candidateName: "Kathy Jennings",
    officeName: "Attorney General",
    district: null,
    party: "Democratic",
    receivingCfId: "01004199",
    receivingMemberId: 458984,
    receivingCommitteeName: "Friends of Kathy Jennings",
  };
  for (const phase of [p.before, p.after]) {
    for (const c of phase.sourceCaptures) {
      c.url = c.url.replaceAll(String(owner.memberId), "458984");
      if (c.financeFields)
        c.financeFields = Object.fromEntries(
          Object.entries(c.financeFields).map(([k, v]) => [
            k,
            v
              .replaceAll(String(owner.memberId), "458984")
              .replaceAll(owner.cfId, "01004199")
              .replaceAll(owner.committeeName, "Friends of Kathy Jennings"),
          ]),
        );
      replaceBody(
        c,
        c.body
          .toString()
          .replaceAll(String(owner.memberId), "458984")
          .replaceAll(owner.cfId, "01004199")
          .replaceAll(owner.committeeName, "Friends of Kathy Jennings")
          .replaceAll("State Representative", "Attorney General")
          .replaceAll("District 38", "-- Select District --")
          .replaceAll("Republican", "Democratic")
          .replaceAll("Example Candidate", "Ms. Kathleen Jennings")
          .replaceAll("2026-01-01", "2023-01-01"),
      );
    }
    const searches = phase.sourceCaptures.filter(
      (c) => new URL(c.url).pathname === "/Public/ViewFiledReports" && c.method === "POST",
    );
    phase.allVersionReportRows = parseDelawareFiledReportsHtml(
      phase.sourceCaptures
        .find((c) => new URL(c.url).pathname === "/Public/_ViewFiledReports")!
        .body.toString(),
    ).rows;
    phase.latestAccountReportRows = phase.allVersionReportRows;
    for (const kind of ["receipts", "expenses"] as const) {
      const native = find(
        phase,
        kind === "receipts" ? "/Public/_ViewReceiptsCustom" : "/Public/_ViewExpensesCustom",
        "POST",
      );
      const csv = find(
        phase,
        kind === "receipts" ? "/Public/ExportCSVNew" : "/Public/ExportExpensestoCsv",
      );
      phase[kind] = closeDelawareNativeLedger({
        pages: [
          {
            pageNumber: 1,
            pageSize: 500,
            page: (kind === "receipts"
              ? decodeDelawareReceiptNativePage
              : decodeDelawareExpenseNativePage)(native.body.toString()),
          },
        ],
        renderedCount: phase[kind].rows.length,
        csv: csv.body.toString(),
      });
    }
    phase.requestWindow = { start: "2023-01-01", end: "2026-12-31" };
    phase.queryScope = { kind: "bounded_window", ...phase.requestWindow };
    for (const c of phase.sourceCaptures)
      if (
        c.method === "POST" &&
        ["/Public/ViewReceipts", "/Public/OtherSearch"].includes(new URL(c.url).pathname)
      )
        c.financeFields = {
          ...c.financeFields,
          dtStartDate: "01/01/2023",
          dtEndDate: "12/31/2026",
        };
  }
  const official = (path: string, body: string, start: number) => {
    const c = modern(capture(path, "GET", body));
    c.url = "https://elections.delaware.gov" + path;
    retime([c], start);
    return c;
  };
  for (const caps of [p.donorRegistryBefore, p.donorRegistryAfter])
    for (const c of caps)
      replaceBody(
        c,
        c.body
          .toString()
          .replaceAll(String(owner.memberId), "458984")
          .replaceAll(owner.cfId, "01004199")
          .replaceAll(owner.committeeName, "Friends of Kathy Jennings"),
      );
  const base = Date.UTC(2026, 9, 11, 12);
  p.campaignAuthority = {
    kind: "incumbent_same_office",
    before: {
      result: official("/reports/GE2022.html", election, base - 10000),
      ballot: official("/elections/general/sampleballots/GE2026/15-10.html", sample, base - 8000),
    },
    after: {
      result: official("/reports/GE2022.html", election, base + 1000000),
      ballot: official(
        "/elections/general/sampleballots/GE2026/15-10.html",
        sample,
        base + 1002000,
      ),
    },
  };
  return p;
}
describe("qualified current Delaware candidate cash/PAC source", () => {
  it("accepts a sole amended current report, full raw closure, anonymous PDF controls and PAC subset without double Raised", async () => {
    const r = await verifyDelawareCurrentCandidateCash(input());
    expect(r.diagnostics).toEqual([]);
    expect(r.cash?.reportedReceiptsCents).toBe(184000);
    expect(r.cash?.directContributionCents).toBe(184000);
    expect(r.cash?.debtCents).toBe(3400000);
    expect(r.pac?.donors).toEqual([
      expect.objectContaining({
        committeeId: "02000010",
        cashAmountCents: 60000,
        inKindAmountCents: 0,
        contributionCount: 1,
        committeeType: "Political Action Committee",
      }),
    ]);
    expect(JSON.stringify(r)).not.toMatch(/SANITIZED ADDRESS|SOURCE ADDRESS|sourcePages|rawFields/);
  });
  it("retains equal gifts with distinct native IDs and occurrence counts", async () => {
    const f = facts();
    (f.schedules.receipts.rows as DelawareCandidatePdfOccurrence[]).push(
      occurrence("Example PAC", 60000, 1),
    );
    const r = await verifyDelawareCurrentCandidateCash(
      input({ facts: f, receipts: [receipt(1), receipt(3)] }),
    );
    expect(r.pac?.donors[0]?.cashAmountCents).toBe(120000);
    expect(r.pac?.donors[0]?.contributionCount).toBe(2);
  });
  it.each(["member", "seat", "person", "party", "stage", "query"])(
    "preserves forged %s context/scope",
    async (kind) => {
      const p = input();
      if (kind === "member") p.target.receivingMemberId++;
      if (kind === "seat") p.target.district = "39";
      if (kind === "person") p.target.candidateName = "Another Candidate";
      if (kind === "party") p.target.party = "Democratic";
      if (kind === "stage") p.target.electionStage = "primary" as "general";
      if (kind === "query") p.before.requestWindow = { start: "2026-01-01", end: "2026-12-31" };
      const r = await verifyDelawareCurrentCandidateCash(p);
      expect(r.cash).toBeUndefined();
      expect(r.pac).toBeUndefined();
    },
  );
  it("preserves changed same-dollar full native identity before donor composition", async () => {
    const p = input();
    const c = find(p.after, "/Public/_ViewReceiptsCustom", "POST");
    const b = JSON.parse(c.body.toString());
    b.data[0].ContributorName = "Another PAC";
    replaceBody(c, JSON.stringify(b));
    expect((await verifyDelawareCurrentCandidateCash(p)).cash).toBeUndefined();
  });
  it("preserves changed SO content including unknown scripts", async () => {
    const p = input();
    const c = find(p.after, "/Public/ShowReview");
    replaceBody(c, c.body.toString() + "<script>unknown</script>");
    expect((await verifyDelawareCurrentCandidateCash(p)).cash).toBeUndefined();
  });
  it("omits PAC independently for missing full registry while cash remains valid", async () => {
    const p = input();
    p.donorRegistryAfter = [];
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.cash?.reportedReceiptsCents).toBe(184000);
    expect(r.pac).toBeUndefined();
  });
  it("keeps explicit committee no-hit identity honest and source URL observed", async () => {
    const p = input();
    replaceRegistry(p, [regRows()[0]!]);
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.pac?.donors[0]?.committeeId).toMatch(/^reported:[a-f0-9]{64}$/);
    expect(r.pac?.donors[0]?.registeredCommitteeId).toBeNull();
    expect(r.pac?.donors[0]?.sourceUrl).toContain("/Public/FiledReports?");
  });
  it("preserves PAC for all-type same-name candidate ambiguity without PAC keyword promotion", async () => {
    const p = input();
    replaceRegistry(p, [...regRows(), { ...regRows()[0]!, CommitteeName: "Example PAC" }]);
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.cash).toBeDefined();
    expect(r.pac).toBeUndefined();
  });
  it("rejects missing latest pointer rather than selecting the largest footer", async () => {
    const p = input();
    const c = p.before.sourceCaptures.filter(
      (c) => new URL(c.url).pathname === "/Public/_ViewFiledReports",
    )[1]!;
    replaceBody(c, "jQuery('#Grid').tGrid({total:0});");
    expect((await verifyDelawareCurrentCandidateCash(p)).cash).toBeUndefined();
  });
  it("rejects forged original byte hash and redacted source envelope", async () => {
    const p = input();
    p.before.sourceCaptures[0]!.sha256 = "a".repeat(64);
    expect((await verifyDelawareCurrentCandidateCash(p)).cash).toBeUndefined();
    const q = input();
    q.before.sourceCaptures[0]!.requestScopeRedacted = true;
    expect((await verifyDelawareCurrentCandidateCash(q)).cash).toBeUndefined();
  });
  it("rejects partial anonymous native cohorts without invented remainder", async () => {
    const p = input({
      receipts: [
        receipt(),
        receipt(4, {
          ContributorType: "Total of Contributions not exceeding $100",
          ContributionType: "Total of Contributions not exceeding $100",
          ContributionAmount: 100,
        }),
      ],
    });
    expect((await verifyDelawareCurrentCandidateCash(p)).cash).toBeUndefined();
  });
  it("accepts validated empty named donors while retaining anonymous receipts", async () => {
    const r = await verifyDelawareCurrentCandidateCash(
      input({ receipts: [receipt(1, { ContributorType: "Individual" })] }),
    );
    expect(r.cash).toBeDefined();
    expect(r.pac?.donors).toEqual([]);
  });
  it("excludes genuine vendor Refund/Rebate from donor-money Raised without changing cover receipts or PAC", async () => {
    const f = facts();
    (f.schedules.receipts.rows as DelawareCandidatePdfOccurrence[]).push(
      occurrence("Example Vendor", 975838, 1),
    );
    const r = await verifyDelawareCurrentCandidateCash(
      input({
        facts: f,
        receipts: [
          receipt(),
          receipt(4, {
            ContributorName: "Example Vendor",
            ContributorType: "Corporation, Partnership, and Other Entity",
            ContributionType: "Refund/Rebate",
            ContributionAmount: 9758.38,
          }),
        ],
      }),
    );
    expect(r.cash?.directContributionCents).toBe(184000);
    expect(r.pac?.donors[0]?.cashAmountCents).toBe(60000);
  });
  it.each([600, 700])(
    "retains zero/negative signed committee positions after an attributable return %s",
    async (amount) => {
      const f = facts();
      f.schedules.expenditures.rows[0]!.columns.name = "Example PAC (Return Contributions)";
      f.schedules.expenditures.rows[0]!.monetaryColumns.amount = amount * 100;
      const r = await verifyDelawareCurrentCandidateCash(
        input({
          facts: f,
          expenses: [
            expense(2, {
              PayeeName: "Example PAC",
              PayeeType: "Political Action Committee",
              ExpenseCategory: "Return Contributions",
              ExpenseAmount: amount,
            }),
          ],
        }),
      );
      expect(r.pac?.donors[0]?.cashAmountCents).toBe(60000 - amount * 100);
      expect(r.pac?.donors[0]?.contributionCount).toBe(1);
      expect(r.cash?.directContributionCents).toBe(184000 - amount * 100);
    },
  );
  it("keeps unattributed potential committee returns unknown independently", async () => {
    const f = facts();
    f.schedules.expenditures.rows[0]!.columns.name = "Unresolved Entity (Return Contributions)";
    const r = await verifyDelawareCurrentCandidateCash(
      input({
        facts: f,
        expenses: [
          expense(2, {
            PayeeName: "Unresolved Entity",
            PayeeType: "Corporation, Partnership, and Other Entity",
            ExpenseCategory: "Return Contributions",
          }),
        ],
      }),
    );
    expect(r.cash).toBeDefined();
    expect(r.pac).toBeUndefined();
  });
  it("promotes a uniquely source-registered generic donor and retains literal reported class", async () => {
    const r = await verifyDelawareCurrentCandidateCash(
      input({
        receipts: [receipt(1, { ContributorType: "Corporation, Partnership, and Other Entity" })],
      }),
    );
    expect(r.pac?.donors[0]).toMatchObject({
      committeeId: "02000010",
      reportedContributorType: "Corporation, Partnership, and Other Entity",
      committeeType: "Political Action Committee",
    });
  });
  it("does not promote an unmatched generic PAC-looking business name", async () => {
    const p = input({
      receipts: [receipt(1, { ContributorType: "Corporation, Partnership, and Other Entity" })],
    });
    replaceRegistry(p, [regRows()[0]!]);
    expect((await verifyDelawareCurrentCandidateCash(p)).pac?.donors).toEqual([]);
  });
  it("requires original source registration dates and closing registry after every financial closing", async () => {
    const p = input();
    replaceRegistry(p, [regRows()[0]!, { ...regRows()[1]!, RegisteredDateStr: "12/31/2026" }]);
    expect((await verifyDelawareCurrentCandidateCash(p)).pac).toBeUndefined();
    const q = input();
    retime(q.donorRegistryAfter, Date.UTC(2026, 9, 11, 0));
    expect((await verifyDelawareCurrentCandidateCash(q)).pac).toBeUndefined();
  });

  it("qualifies exact current receiving account through independently paired official winner/ballot facts", async () => {
    const r = await verifyDelawareCurrentCandidateCash(incumbentInput());
    expect(r.cash?.directContributionCents).toBe(184000);
    expect(r.cash?.sourceProvenance.window.sources).toHaveLength(4);
  });
  it.each(["changed", "hash", "closing"])(
    "preserves changed/unclosed official authority %s",
    async (kind) => {
      const p = incumbentInput();
      if (p.campaignAuthority.kind !== "incumbent_same_office") throw Error("fixture");
      if (kind === "changed")
        replaceBody(
          p.campaignAuthority.after.ballot,
          p.campaignAuthority.after.ballot.body
            .toString()
            .replaceAll("KATHY JENNINGS", "OTHER NAME"),
        );
      if (kind === "hash") p.campaignAuthority.after.result.sha256 = "a".repeat(64);
      if (kind === "closing") retime([p.campaignAuthority.after.result], Date.UTC(2026, 9, 11, 0));
      expect((await verifyDelawareCurrentCandidateCash(p)).cash).toBeUndefined();
    },
  );

  it("accepts genuine client projection of excluded blank registry controls, not active or missing retained filters", async () => {
    const p = input();
    for (const caps of [p.donorRegistryBefore, p.donorRegistryAfter]) {
      const f = { ...caps[1]!.financeFields };
      for (const k of ["txtAcronym", "hdnAcronymId", "txtResOfficer", "hdnPersonID"]) delete f[k];
      caps[1]!.financeFields = f;
    }
    expect((await verifyDelawareCurrentCandidateCash(p)).pac?.donors[0]?.cashAmountCents).toBe(
      60000,
    );
    const q = input();
    q.donorRegistryBefore[1]!.financeFields = {
      ...q.donorRegistryBefore[1]!.financeFields,
      txtAcronym: "limited",
    };
    expect((await verifyDelawareCurrentCandidateCash(q)).pac).toBeUndefined();
  });
  it("combines corroborated registered gifts with multiple literal reported classes", async () => {
    const f = facts();
    (f.schedules.receipts.rows as DelawareCandidatePdfOccurrence[]).push(
      occurrence("Example PAC", 20000, 1),
    );
    const r = await verifyDelawareCurrentCandidateCash(
      input({
        facts: f,
        receipts: [
          receipt(),
          receipt(3, {
            ContributorType: "Corporation, Partnership, and Other Entity",
            ContributionAmount: 200,
          }),
        ],
      }),
    );
    expect(r.pac?.donors).toHaveLength(1);
    expect(r.pac?.donors[0]?.reportedContributorType).toBe(
      "Corporation, Partnership, and Other Entity | Political Action Committee",
    );
    expect(r.pac?.donors[0]?.contributionCount).toBe(2);
  });
  it("preserves contradictory class/member context on a sole registry CF", async () => {
    const p = input();
    replaceRegistry(p, [...regRows(), { ...regRows()[1]!, MemberID: 11 }]);
    expect((await verifyDelawareCurrentCandidateCash(p)).pac).toBeUndefined();
  });
  it("retains in-kind separately and includes it once in donor-money Raised", async () => {
    const f = facts();
    (f.schedules.inKindReceipts.rows as DelawareCandidatePdfOccurrence[]).push(
      occurrence("Example PAC", 10000, 1),
    );
    const r = await verifyDelawareCurrentCandidateCash(
      input({
        facts: f,
        receipts: [receipt(), receipt(5, { ContributionType: "In-Kind", ContributionAmount: 100 })],
      }),
    );
    expect(r.cash?.directContributionCents).toBe(194000);
    expect(r.pac?.donors[0]).toMatchObject({
      cashAmountCents: 60000,
      inKindAmountCents: 10000,
      contributionCount: 2,
    });
  });
  it("retains unrelated out-of-window ambiguity without selecting or requiring those PDFs", async () => {
    const p = incumbentInput();
    for (const phase of [p.before, p.after]) {
      const c = phase.sourceCaptures.find(
        (c) => new URL(c.url).pathname === "/Public/_ViewFiledReports",
      )!;
      const html = c.body.toString();
      const tr = /<tr><td>([\s\S]*?)<\/tr>/.exec(html)![0];
      const currentFile = phase.allVersionReportRows[0]!.document!.publicReportFileName;
      const old = tr
        .replaceAll("2026 30 Day 2026 General Election 11/03/2026", "2022 Year End Annual")
        .replaceAll(currentFile, currentFile.replace("1273_example", "1260_old"))
        .replaceAll("1273", "1260")
        .replaceAll("<td>2026</td>", "<td>2022</td>");
      const older = old.replaceAll("1260_old", "1260_older");
      replaceBody(
        c,
        html.replace("total:1", "total:3").replace("</tbody>", old + older + "</tbody>"),
      );
      phase.allVersionReportRows = parseDelawareFiledReportsHtml(c.body.toString()).rows;
    }
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.cash?.directContributionCents).toBe(184000);
  });
  it("rejects multiple relevant actual report identities despite one latest pointer", async () => {
    const p = input();
    for (const phase of [p.before, p.after]) {
      const c = phase.sourceCaptures.find(
        (c) => new URL(c.url).pathname === "/Public/_ViewFiledReports",
      )!;
      const html = c.body.toString();
      const tr = /<tr><td>([\s\S]*?)<\/tr>/.exec(html)![0];
      const other = tr
        .replaceAll(file, file.replace("example", "earlier"))
        .replaceAll("Amended Financial Statement", "Original Financial Statement");
      replaceBody(c, html.replace("total:1", "total:2").replace("</tbody>", other + "</tbody>"));
      phase.allVersionReportRows = parseDelawareFiledReportsHtml(c.body.toString()).rows;
    }
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.cash).toBeUndefined();
  });
  it("retains the entire caller generation before asynchronous PDF extraction", async () => {
    const p = input();
    const running = verifyDelawareCurrentCandidateCash(p);
    p.target.candidateName = "Mutated";
    p.before.sourceCaptures[0]!.body.fill(0);
    find(p.after, "/Public/_ViewReceiptsCustom", "POST").body.fill(0);
    const r = await running;
    expect(r.cash?.directContributionCents).toBe(184000);
    expect(r.pac?.donors[0]?.cashAmountCents).toBe(60000);
  });

  it("preserves no-hit same-name PAC-class drift on an outgoing return rather than splitting a false positive position", async () => {
    const f = facts();
    f.schedules.expenditures.rows[0]!.columns.name = "Example PAC (Return Contributions)";
    const p = input({
      facts: f,
      expenses: [
        expense(2, {
          PayeeName: "Example PAC",
          PayeeType: "PAC",
          ExpenseCategory: "Return Contributions",
        }),
      ],
    });
    replaceRegistry(p, [regRows()[0]!]);
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.cash?.directContributionCents).toBe(174000);
    expect(r.pac).toBeUndefined();
    expect(r.diagnostics.join(" ")).toContain("class drift");
  });
  it("still nets source class variants through independently unique registered CF", async () => {
    const f = facts();
    f.schedules.expenditures.rows[0]!.columns.name = "Example PAC (Return Contributions)";
    const r = await verifyDelawareCurrentCandidateCash(
      input({
        facts: f,
        expenses: [
          expense(2, {
            PayeeName: "Example PAC",
            PayeeType: "PAC",
            ExpenseCategory: "Return Contributions",
          }),
        ],
      }),
    );
    expect(r.pac?.donors[0]?.cashAmountCents).toBe(50000);
    expect(r.pac?.donors[0]?.reportedContributorType).toBe("PAC | Political Action Committee");
  });

  it.each(["Individual", "Self (Candidate)", "Candidate Committee"])(
    "does not promote explicit %s through an exact eligible registry-name collision",
    async (contributorType) => {
      const r = await verifyDelawareCurrentCandidateCash(
        input({ receipts: [receipt(1, { ContributorType: contributorType })] }),
      );
      expect(r.cash?.directContributionCents).toBe(184000);
      expect(r.pac?.donors).toEqual([]);
    },
  );
  it("preserves unqualified broad federal/out-of-state class instead of assuming eligible PAC", async () => {
    const p = input({
      receipts: [receipt(1, { ContributorType: "Out-of-State or Federal Committee" })],
    });
    replaceRegistry(p, [regRows()[0]!]);
    const r = await verifyDelawareCurrentCandidateCash(p);
    expect(r.cash?.directContributionCents).toBe(184000);
    expect(r.pac).toBeUndefined();
  });
});
