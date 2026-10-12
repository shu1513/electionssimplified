import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDelawareVerifiedFinanceSource } from "../../../src/pipeline/delawareFinance/delawareVerifiedFinanceSourceLoader.js";
import * as artifactCache from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactCache.js";
import { readDelawareCfrsCommitteeArtifacts } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactCache.js";
import {
  DELAWARE_NATIVE_RECEIPT_FIELDS,
  DELAWARE_NATIVE_EXPENSE_FIELDS,
  decodeDelawareReceiptNativePage,
  decodeDelawareExpenseNativePage,
  projectDelawareNativeReceiptCsvRow,
  projectDelawareNativeExpenseCsvRow,
  type DelawareNativeLedgerPage,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import {
  DELAWARE_RECEIPT_CSV_COLUMNS,
  DELAWARE_EXPENSE_CSV_COLUMNS,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import type {
  DelawareThirdPartyPdfCell,
  DelawareThirdPartyPdfExtraction,
} from "../../../src/pipeline/delawareFinance/delawareThirdPartyFinancialReport.js";
import type {
  DelawareCandidateFinancialReport,
  DelawareCandidatePdfOccurrence,
  DelawareCandidateScheduleName,
} from "../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js";
import type {
  DelawareCfrsFetchFn,
  DelawareCfrsResponseCapture,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
// Only positioned PDF extraction is represented by sanitized source facts. The
// actual producer, native/CSV decoders, currentness and monetary verifiers run.
// Every request and response timestamp below is a synthetic protocol fixture.
vi.mock(
  "../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js",
  () => ({
    readDelawareCandidateFinancialReport: async (body: Buffer) => ({
      ...JSON.parse(body.toString().slice(9)),
      pdfSha256: createHash("sha256").update(body).digest("hex"),
      byteCount: body.length,
    }),
  }),
);
const owner = {
  cfId: "01000001",
  memberId: 733862,
  committeeName: "Friends of Example Candidate",
};
const file = "CampaignFinanceReport_Prelim_733862_1273_example.pdf";

function receipt(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      DELAWARE_NATIVE_RECEIPT_FIELDS.map((key) => [key, ""]),
    ),
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
    ...Object.fromEntries(
      DELAWARE_NATIVE_EXPENSE_FIELDS.map((key) => [key, ""]),
    ),
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
function occurrence(
  name: string,
  amount: number,
  index = 0,
): DelawareCandidatePdfOccurrence {
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
    columns = receipt
      ? DELAWARE_RECEIPT_CSV_COLUMNS
      : DELAWARE_EXPENSE_CSV_COLUMNS;
  return (
    columns.join(",") +
    ",\n" +
    page.rows
      .map((row) => {
        const projected = (
          receipt
            ? projectDelawareNativeReceiptCsvRow
            : projectDelawareNativeExpenseCsvRow
        )(row);
        const dateKey = receipt ? "Contribution Date" : "Expenditure Date",
          amountKey = receipt ? "Contribution Amount" : "Amount($)";
        const [y, m, d] = projected[dateKey]!.split("-");
        projected[dateKey] = `${Number(m)}/${Number(d)}/${y}`;
        projected[amountKey] = (Number(projected[amountKey]) / 100).toFixed(4);
        return columns
          .map((key) => {
            const value = projected[key]!;
            return /[",\n\r]/.test(value)
              ? `"${value.replaceAll('"', '""')}"`
              : value;
          })
          .join(",");
      })
      .join("\n") +
    "\n"
  );
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
  return `<table><tr><td>Committee Name:</td><td>${owner.committeeName}</td></tr><tr><td>Date of Origination:</td><td>01/01/2026</td></tr></tbody></table>
  <table id="Viewelection"><tbody><tr><td>State Office</td><td>Na</td><td>State Representative</td><td>District 38</td><td>Republican</td></tr></tbody></table>
  <table id="CandidateList"><tbody><tr><td>Example Candidate</td><td></td><td></td><td></td></tr></tbody></table>`;
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

vi.mock(
  "../../../src/pipeline/delawareFinance/delawareThirdPartyFinancialReport.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../src/pipeline/delawareFinance/delawareThirdPartyFinancialReport.js")
      >();
    return {
      ...actual,
      extractDelawareThirdPartyFinancialPdf: async (body: Buffer) => {
        if (body.toString().startsWith("%PDF-1.4\n{")) {
          const f = JSON.parse(body.toString().slice(9));
          return {
            sha256: createHash("sha256").update(body).digest("hex"),
            byteCount: body.length,
            cover: f.cover,
            pages: [
              {
                pageNumber: 1,
                width: 792,
                height: 612,
                cells: [
                  {
                    text: "ACCOUNT NUMBER :",
                    x: 38,
                    y: 408,
                    width: 20,
                    height: 9,
                  },
                  {
                    text: f.accountNumber,
                    x: 264,
                    y: 408,
                    width: 20,
                    height: 9,
                  },
                ],
              },
            ],
          };
        }
        return actual.extractDelawareThirdPartyFinancialPdf(body);
      },
    };
  },
);

const cell = (
  text: string,
  x: number,
  y: number,
): DelawareThirdPartyPdfCell => ({ text, x, y, width: 20, height: 9 });
function outsideFixture(): DelawareThirdPartyPdfExtraction {
  const pages = Array.from({ length: 11 }, (_, i) => ({
    pageNumber: i + 1,
    width: 792,
    height: 612,
    cells: [] as DelawareThirdPartyPdfCell[],
  }));
  pages[0]!.cells = [
    cell("FULL ORGANIZATION NAME:", 38, 428),
    cell("THE STATEHOUSE FUND", 426, 428),
    cell("ACCOUNT NUMBER :", 38, 408),
    cell("04006716", 264, 408),
    cell("DATE OF THIS REPORT :", 438, 408),
    cell("08/18/2026", 616, 408),
    cell("REPORTING PERIOD START :", 38, 388),
    cell("08/05/2026", 262, 388),
    cell("REPORTING PERIOD END :", 438, 388),
    cell("08/18/2026", 616, 388),
  ];
  for (const p of pages.slice(1))
    p.cells = [
      cell("ACCOUNT NUMBER :", 38, 440),
      cell("04006716", 264, 440),
      cell("REPORTING PERIOD :", 330, 440),
      cell("08/05/2026", 485, 440),
      cell("08/18/2026", 659, 440),
    ];
  pages[1]!.cells.push(
    cell("STATEMENT OF ACCOUNT BALANCE", 275, 500),
    cell("A. SCHEDULE A - TOTAL RECEIPTS", 55, 390),
    cell("$525,000.00", 650, 390),
    cell("F. SCHEDULE B - TOTAL EXPENDITURES", 55, 287),
    cell("$499,015.00", 650, 287),
  );
  pages[1]!.cells.push(
    cell("1. BEGINNING BALANCE", 55, 424),
    cell("$0.00", 670, 424),
    cell("E. SUBTOTAL (Total of A,B,C,D)", 55, 320),
    cell("$525,000.00", 646, 320),
    cell("J. SUBTOTAL (Total of F,G,H,I)", 55, 219),
    cell("$499,015.00", 647, 219),
    cell("4. ENDING BALANCE", 55, 193),
    cell("$25,985.00", 650, 193),
  );
  pages[2]!.cells.push(
    cell("SCHEDULE A - TOTAL RECEIPTS", 292, 494),
    cell("Date Received", 60, 355),
    cell("Contributor Name", 204, 355),
    cell("Contributor Mailing Address", 382, 355),
    cell("Aggregate Amount", 554, 355),
    cell("Amount Received", 659, 355),
    cell("08/07/2026", 60, 338),
    cell("Public First Action", 146, 338),
    cell("SANITIZED ADDRESS", 330, 338),
    cell("$525,000.00", 598, 338),
    cell("$525,000.00", 703, 338),
    cell("TOTAL ITEMIZED RECEIPTS", 39, 313),
    cell("$525,000.00", 703, 313),
    cell("TOTAL OF CONTRIBUTIONS NOT EXCEEDING $100", 39, 295),
    cell("$0.00", 727, 295),
    cell("GRAND TOTAL RECEIPTS", 39, 277),
    cell("$525,000.00", 703, 277),
  );
  pages[3]!.cells.push(
    cell("SCHEDULE B - TOTAL EXPENDITURES", 281, 490),
    cell("Date Expended", 49, 344),
    cell("Payee Name", 175, 344),
    cell("Payee Mailing Address", 304, 344),
    cell("Vendor", 492, 344),
    cell("Aggregate", 604, 349),
    cell("Amount", 604, 338),
    cell("Amount", 685, 349),
    cell("Expended", 685, 338),
    cell("08/17/2026", 60, 324),
    cell("Bryson Gillette, LLC", 129, 324),
    cell("SANITIZED ADDRESS", 300, 324),
    cell("$499,015.00", 621, 324),
    cell("$499,015.00", 700, 324),
    cell("Support of Kathleen Jennings - State", 129, 304),
    cell("Office - Attorney General - Democratic", 129, 294),
    cell("TOTAL ITEMIZED EXPENDITURES", 38, 279),
    cell("$499,015.00", 700, 279),
    cell("TOTAL OF EXPENDITURES NOT EXCEEDING $100", 38, 261),
    cell("$0.00", 725, 261),
    cell("GRAND TOTAL EXPENDITURES", 38, 243),
    cell("$499,015.00", 700, 243),
  );
  const extras = [
    ["SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS", "GRAND TOTAL RECEIPTS", 1],
    [
      "SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES",
      "GRAND TOTAL EXPENDITURES",
      1,
    ],
    [
      "SCHEDULE D-1 - TOTAL LOANS RECEIVED AND DEBTS INCURRED",
      "TOTAL LOANS RECEIVED",
      1,
    ],
    ["SCHEDULE D-2 - TOTAL LOANS AND DEBTS OUTSTANDING", "TOTAL LOANS", 3],
    [
      "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
      "TOTAL REIMBURSEMENTS RECEIVED",
      2,
    ],
    ["SCHEDULE F - NON-CASH ASSETS", "TOTAL ASSET VALUE", 1],
    ["SCHEDULE G - ELIMINATION OF ASSETS", "TOTAL ASSETS ELIMINATED", 1],
  ] as const;
  extras.forEach(([title, label, count], i) => {
    const p = pages[i + 4]!;
    p.cells.push(
      cell(title, 250, 490),
      cell(label, 38, 300),
      ...Array.from({ length: count }, (_, j) =>
        cell("$0.00", 600 + j * 50, 300),
      ),
    );
    if (i === 4)
      p.cells.push(
        cell("TOTAL REIMBURSEMENTS PAID", 38, 200),
        cell("$0.00", 645, 200),
        cell("$0.00", 725, 200),
      );
  });
  return {
    sha256: "a".repeat(64),
    byteCount: 132876,
    pages,
    cover: {
      pageNumber: 2,
      beginningBalanceCents: 0,
      receiptsCents: 52500000,
      expendituresCents: 49901500,
      endingBalanceCents: 2598500,
      reportingPeriodFrom: "08/05/2026",
      reportingPeriodTo: "08/18/2026",
      documentVersion: 1,
      method: "rows",
    },
  };
}
function bornDigitalPdf(e: DelawareThirdPartyPdfExtraction): Buffer {
  const esc = (s: string) => s.replace(/([\\()])/g, "\\$1");
  const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ],
    kids: number[] = [];
  for (const p of e.pages) {
    const id = objects.length + 1;
    kids.push(id);
    const stream = p.cells
      .map((c) => `BT /F1 9 Tf 1 0 0 1 ${c.x} ${c.y} Tm (${esc(c.text)}) Tj ET`)
      .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((x) => x + " 0 R").join(" ")}] >>`;
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((s, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${s}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((x) => String(x).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

const payer = {
  cfId: "04006716",
  memberId: 739099,
  committeeName: "THE STATEHOUSE FUND",
  committeeType: "04" as const,
};
const payerFile =
  "CampaignFinanceReport_Prelim_739099_315_829eb639-f068-43f2-8f7a-38576c55fbc6.pdf";
function outsidePdf() {
  const f = outsideFixture();
  for (const i of [4, 5])
    f.pages[i]!.cells.push(
      cell(
        i === 4
          ? "TOTAL ITEMIZED IN-KIND CONTRIBUTIONS"
          : "TOTAL ITEMIZED IN-KIND EXPENDITURES",
        38,
        315,
      ),
      cell("$0.00", 700, 315),
      cell(
        i === 4
          ? "TOTAL OF IN-KIND CONTRIBUTIONS NOT EXCEEDING $100"
          : "TOTAL OF IN-KIND EXPENDITURES NOT EXCEEDING $100",
        38,
        307,
      ),
      cell("$0.00", 700, 307),
    );
  f.pages.slice(4).forEach((p) => p.cells.push(cell("Date Received", 60, 340)));
  f.pages[8]!.cells.push(cell("Date Paid", 60, 240));
  for (const p of f.pages)
    for (const c of p.cells) {
      c.text = c.text
        .replace(
          "Support of Kathleen Jennings - State",
          "Support of Example Candidate - State",
        )
        .replace(
          "Office - Attorney General - Democratic",
          "Office - Attorney General - Republican",
        );
    }
  return bornDigitalPdf(f);
}
function outsideReceipt() {
  return {
    ...receipt(786013),
    ContributionType: "Cash",
    TransactionDate: "/Date(" + Date.parse("2026-08-07T00:00:00Z") + ")/",
    ContributorName: "Public First Action ",
    OccupationTitle: "Other",
    ContributionAmount: 525000,
    ContributorType: "Individual",
    ReceivingCommitteeName: payer.committeeName,
    WC_ID: payer.cfId,
    ContributorAddress: "SANITIZED ADDRESS",
    AddressLine1: "SANITIZED ADDRESS",
    City: "",
    State_Code: "",
    Zip_Code: "",
    FilingPeriodName: "Aug 18, 2026 Filing 1.0 11:07 AM",
    FileAmendedVersion: "07 Aug 2026 Version 1.012:00AM",
  };
}
function outsideExpense() {
  return {
    ...expense(786022),
    RegistrantName: payer.committeeName,
    PayeeName: "Bryson Gillette, LLC",
    PayeeType: "Business/Group/Organization",
    TransactionDate: "/Date(" + Date.parse("2026-08-17T00:00:00Z") + ")/",
    ExpenseAmount: 499015,
    ExpenseMethod: "Wire Transfer",
    ExpensePurpose: "",
    CCF_ID: payer.cfId,
    Address: "SANITIZED ADDRESS",
    AddressLine1: "SANITIZED ADDRESS",
    City: "",
    State: "",
    ZipCode: "",
    FilingPeriodName: "Aug 18, 2026 Filing 1.0 11:07 AM",
    FileAmendedVersion: "17 Aug 2026 Version 1.012:00AM",
  };
}
function payerOrganization() {
  return `<table><tr><td>Committee Name:</td><td>${payer.committeeName}</td></tr></tbody></table><table id="ViewCandiate"><tbody><tr><td>${owner.committeeName}</td><td>Example Candidate</td><td>Attorney General</td><td>Republican</td><td>Support</td><td>Active</td></tr></tbody></table>`;
}

type Scenario = {
  publishedHonorific?: boolean;
  incumbent?: boolean;
  changedOfficialClosing?: boolean;
  payer?: boolean;
  missingPayerSoo?: boolean;
  payerPdfFailure?: boolean;
  payerNoReports?: boolean;
  payerPacketMissingSoo?: boolean;
  payerNativeEmptyReads?: number;
  payerClosingCallbackFailure?: boolean;
  retryOnce?: boolean;
  transientZero?: boolean;
  closingRegistryUnavailable?: boolean;
  registryFailure?:
    "closing_search_503" | "opening_get_503" | "opening_network";
  allRegistryUnavailable?: boolean;
  changedCashAfterPacket?: number;
  failedPdfAfterPacket?: number;
  callbackFailure?: boolean;
};
function network(scenario: Scenario = {}) {
  const statewide = !!(scenario.payer || scenario.incumbent);
  let ballots = 0,
    payerNativeReads = 0,
    payerSearches = 0;
  const requests: {
    path: string;
    fields: Record<string, string>;
    method: string;
  }[] = [];
  const captures: DelawareCfrsResponseCapture[] = [];
  const allRows = () => [
    ...regRows(),
    ...(scenario.payer
      ? [
          {
            MemberID: payer.memberId,
            MemberVersID: 1,
            Committee_Id: payer.cfId,
            CommitteeName: payer.committeeName,
            CommitteeTypeCode: "04",
            CommitteeType: "3rd Party Advertisers",
            CommitteeStatus: "Active",
            Formtype: "SO",
            RegisteredDateStr: "08/04/2026",
          },
        ]
      : []),
  ];
  let receiptMember = String(owner.memberId),
    expenseMember = String(owner.memberId),
    reportMember = String(owner.memberId);
  let registryRows = allRows(),
    broadSearches = 0,
    registryForms = 0,
    packetNumber = 0,
    retry = false,
    zero = false;
  const render = (n: number) => `jQuery('#Grid').tGrid({total:${n}});`;
  const respond = (body: string, type = "text/html", status = 200) =>
    new Response(body, { status, headers: { "Content-Type": type } });
  const fetchImpl: DelawareCfrsFetchFn = async (rawUrl, init) => {
    vi.setSystemTime(Date.now() + 1000);
    const url = new URL(rawUrl),
      route = url.pathname;
    const fields = Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ path: route, fields, method: init.method ?? "GET" });
    if (url.origin === "https://elections.delaware.gov" && scenario.incumbent) {
      if (route === "/reports/GE2022.html") {
        const columns = [
          "Candidate Name",
          "Party Name",
          "Machine Votes",
          "Absentee Votes",
          "Early Voting Votes",
          "Total Votes",
          "Percentage",
        ];
        const row = (values: string[]) =>
          "<tr>" +
          values
            .map((v, i) => `<td data-label="${columns[i]}">${v}</td>`)
            .join("") +
          "</tr>";
        return respond(
          '<h1>2022 General Election Report</h1><h2 class="electionDate">November 8th 2022</h2><span class="resultsType">OFFICIAL RESULTS</span><div id="statewide"><h3>Attorney General</h3><table><thead><tr>' +
            columns.map((v) => `<th>${v}</th>`).join("") +
            "</tr></thead><tbody>" +
            row([
              "Example Candidate",
              "Republican Party",
              "6",
              "2",
              "2",
              "10",
              "66.67",
            ]) +
            row([
              "Other Candidate",
              "Democratic Party",
              "3",
              "1",
              "1",
              "5",
              "33.33",
            ]) +
            "</tbody></table></div>",
        );
      }
      ballots++;
      const name =
        scenario.changedOfficialClosing && ballots >= 2
          ? "Changed Candidate"
          : "Example Candidate";
      return respond(
        `<h1>Sample Ballot</h1><li>November 3, 2026 General Election</li><table><thead><tr><th>Race</th><th>Instruction</th><th>Republican Party</th><th>Democratic Party</th><th>Write-in</th></tr></thead><tbody><tr><td data-label="Race">Attorney General</td><td data-label="Instruction">Vote for 1</td><td data-label="Republican Party">${name}</td><td data-label="Democratic Party">Other Candidate</td><td data-label="Write-in">Write-in</td></tr></tbody></table>`,
      );
    }
    const currentRows = () => {
      const rows = [receipt()];
      if (
        scenario.changedCashAfterPacket !== undefined &&
        packetNumber >= scenario.changedCashAfterPacket
      )
        rows[0]!.ContributionAmount = 700;
      return rows;
    };
    if (route === "/Public/ViewCommittees") {
      registryForms++;
      if (registryForms <= 3) {
        if (scenario.registryFailure === "opening_network")
          throw new Error("synthetic registry transport unavailable");
        if (scenario.registryFailure === "opening_get_503")
          return respond("registry unavailable", "text/html", 503);
      }
      return respond("form");
    }
    if (route === "/Public/Search") {
      const broad = !fields.CommitteeType && !fields.txtCommitteeID;
      if (broad) broadSearches++;
      if (fields.CommitteeType === "04") payerSearches++;
      if (
        broad &&
        broadSearches >= 2 &&
        scenario.registryFailure === "closing_search_503"
      )
        return respond("registry unavailable", "text/html", 503);
      registryRows = allRows().filter(
        (r) =>
          (!fields.CommitteeType ||
            r.CommitteeTypeCode === fields.CommitteeType) &&
          (!fields.txtCommitteeID || r.Committee_Id === fields.txtCommitteeID),
      );
      if (!broad && fields.txtCommitteeID === owner.cfId) packetNumber++;
      if (
        broad &&
        (scenario.allRegistryUnavailable ||
          (scenario.closingRegistryUnavailable && broadSearches >= 2))
      )
        return respond("no independently published count");
      const found = registryRows[0]!;
      const so = `/Public/ShowReview?memberID=${found.MemberID}&memVersID=1&cTypeCode=${found.CommitteeTypeCode}&ftype=SO&fpath=&fname=&isPublic=true`;
      return respond(
        render(registryRows.length) +
          (fields.CommitteeType === "04" &&
          (scenario.missingPayerSoo ||
            (scenario.payerPacketMissingSoo && payerSearches > 1))
            ? ""
            : `<a href="${so.replaceAll("&", "&amp;")}">Statement of Organization</a>`),
      );
    }
    if (route === "/Public/_ViewCommittees")
      return respond(
        JSON.stringify({ data: registryRows, total: registryRows.length }),
        "application/json",
      );
    if (route === "/Public/ShowReview")
      return respond(
        (url.searchParams.get("memberID") === String(payer.memberId)
          ? payerOrganization()
          : statewide
            ? soa()
                .replaceAll("State Representative", "Attorney General")
                .replaceAll("District 38", "-- Select District --")
            : soa()
        ).replaceAll(
          "<td>Example Candidate</td>",
          scenario.publishedHonorific
            ? "<td>Ms. Example Candidate</td>"
            : "<td>Example Candidate</td>",
        ),
      );
    if (route === "/Public/ViewFiledReports") {
      if (init.method === "POST") reportMember = fields.MemberId!;
      return respond("report form");
    }
    if (
      route === "/Public/_ViewFiledReports" &&
      reportMember === String(payer.memberId)
    ) {
      if (scenario.payerNoReports)
        return respond(
          `${render(0)}<div id="Grid"><table><tbody></tbody></table></div>`,
        );
      return respond(
        `${render(1)}<div id="Grid"><table><tbody><tr>${["18 Aug 2026 Filing 1.0 11:07 AM", `<a onclick="downloadReport(&#39;${payerFile}&#39;,&#39;739099&#39;,&#39;315&#39;)">Original Financial Statement</a>`, payer.cfId, payer.committeeName, "3rd Party Advertisers", "08/18/2026", "2026", "", "Active"].map((v) => `<td>${v}</td>`).join("")}</tr></tbody></table></div>`,
      );
    }
    if (route === "/Public/_ViewFiledReports")
      return respond(
        `${render(1)}<div id="Grid"><table><tbody><tr><td>2026 30 Day 2026 General Election 11/03/2026</td><td><a onclick="downloadReport(&#39;${file}&#39;,&#39;${owner.memberId}&#39;,&#39;1273&#39;)">Amended Financial Statement</a></td><td>${owner.cfId}</td><td>${owner.committeeName}</td><td>Candidate Committee</td><td>10/05/2026</td><td>2026</td><td>State Office - ${statewide ? "Attorney General" : "State Representative"}</td><td>Active</td></tr></tbody></table></div>`,
      );
    if (
      route === "/Public/FiledReports" &&
      url.searchParams.get("CommitteeID") === String(payer.memberId)
    )
      return new Response(
        scenario.payerPdfFailure ? Buffer.from("bad source PDF") : outsidePdf(),
        { status: 200, headers: { "Content-Type": "application/pdf" } },
      );
    if (route === "/Public/FiledReports") {
      if (
        scenario.failedPdfAfterPacket !== undefined &&
        packetNumber >= scenario.failedPdfAfterPacket
      )
        return respond("not a PDF", "text/html");
      const f = facts();
      if (scenario.incumbent) {
        f.periodStart = "2023-01-01";
        f.cover.reportingPeriodFrom = "01/01/2023";
      }
      if (
        scenario.changedCashAfterPacket !== undefined &&
        packetNumber >= scenario.changedCashAfterPacket
      ) {
        f.schedules.receipts.rows[0]!.monetaryColumns.amount = 70000;
        f.schedules.receipts.rows[0]!.monetaryColumns.aggregate = 70000;
        (
          f.schedules.receipts.controls as Record<string, number>
        ).itemizedCents = 70000;
        (f.schedules.receipts.controls as Record<string, number>).grandCents =
          194000;
        f.cover.receiptsCents = 194000;
        f.cover.endingBalanceCents = 184000;
      }
      return respond("%PDF-1.4\n" + JSON.stringify(f), "application/pdf");
    }
    if (
      route === "/Public/ViewReceiptsMain" ||
      route === "/Public/ViewExpenses"
    )
      return respond("ledger form");
    if (route === "/Public/ViewReceipts") {
      receiptMember = fields.MemberId!;
      if (scenario.retryOnce && !retry) {
        retry = true;
        return respond("temporarily unavailable", "text/plain", 503);
      }
      if (scenario.transientZero && !zero) {
        zero = true;
        return respond(render(0));
      }
      return respond(render(1));
    }
    if (route === "/Public/OtherSearch") {
      expenseMember = fields.MemberId!;
      return respond(render(1));
    }
    if (route === "/Public/_ViewReceiptsCustom") {
      if (receiptMember === String(payer.memberId)) {
        payerNativeReads++;
        if (payerNativeReads <= (scenario.payerNativeEmptyReads ?? 0))
          return respond(
            JSON.stringify({ data: [], total: 0 }),
            "application/json",
          );
      }
      return respond(
        JSON.stringify({
          data:
            receiptMember === String(payer.memberId)
              ? [outsideReceipt()]
              : currentRows(),
          total: 999999,
        }),
        "application/json",
      );
    }
    if (route === "/Public/_ViewExpensesCustom")
      return respond(
        JSON.stringify({
          data:
            expenseMember === String(payer.memberId)
              ? [outsideExpense()]
              : [expense()],
          total: 999999,
        }),
        "application/json",
      );
    if (route === "/Public/ExportCSVNew_TP")
      return respond(
        "Contribution Date,Contributor Name,Contributor Address,Employer Name,Filed Reports,Employer Occupation,Contribution Amount,Receiving Committee,\n08/07/2026,Public First Action,SANITIZED ADDRESS,,Other,07 Aug 2026 Version 1.012:00AM,525000.0000,THE STATEHOUSE FUND,\n",
        "application/octet-stream",
      );
    if (route === "/Public/ExportCSVNew")
      return respond(
        csv(
          decodeDelawareReceiptNativePage(
            JSON.stringify({
              data:
                receiptMember === String(payer.memberId)
                  ? [outsideReceipt()]
                  : currentRows(),
              total: 999999,
            }),
          ),
        ),
        "application/octet-stream",
      );
    if (route === "/Public/ExportExpensestoCsv")
      return respond(
        csv(
          decodeDelawareExpenseNativePage(
            JSON.stringify({
              data:
                expenseMember === String(payer.memberId)
                  ? [outsideExpense()]
                  : [expense()],
              total: 999999,
            }),
          ),
        ),
        "application/octet-stream",
      );
    throw new Error("Unexpected synthetic source route");
  };
  return {
    requests,
    captures,
    fetchImpl,
    statewide,
    sessionOptions: {
      fetchImpl,
      spacingMs: 0,
      sleep: async () => {},
      onResponseCapture: async (c: DelawareCfrsResponseCapture) => {
        captures.push({
          ...c,
          body: Buffer.from(c.body),
          financeFields:
            c.financeFields === null ? null : { ...c.financeFields },
        });
        if (
          scenario.callbackFailure ||
          (scenario.payerClosingCallbackFailure &&
            new URL(c.url).pathname === "/Public/_ViewReceiptsCustom" &&
            receiptMember === String(payer.memberId) &&
            payerNativeReads >= 2)
        )
          throw new Error("synthetic observer failed");
      },
    },
  };
}
let cacheDir: string;
const { receivingMemberId: _member, ...context } = target;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "de-verified-loader-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(cacheDir, { recursive: true, force: true });
});
async function load(source: ReturnType<typeof network>, refresh = false) {
  return loadDelawareVerifiedFinanceSource({
    context: source.statewide
      ? { ...context, officeName: "Attorney General", district: null }
      : context,
    cacheDir,
    refresh,
    sessionOptions: source.sessionOptions,
  });
}
function packetCount(source: ReturnType<typeof network>) {
  return source.requests.filter((r) => r.path === "/Public/ViewReceiptsMain")
    .length;
}
describe("ordinary Delaware verified source loader", () => {
  it("composes real producers and verifiers, independently closes cash/PAC, and journals original metadata", async () => {
    const n = network();
    const result = await load(n);
    expect(result.cash?.directContributionCents).toBe(184000);
    expect(result.pac?.donors).toMatchObject([
      { committeeId: "02000010", cashAmountCents: 60000, contributionCount: 1 },
    ]);
    expect(result.outsideEvidence).toEqual([]);
    expect(packetCount(n)).toBe(2);
    expect(result.diagnostics).toContain(
      "Independently timestamped public observations; later filings/amendments remain unknown and require post-deadline reruns",
    );
    const saved = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    expect(
      saved.sourceCaptures?.map((c) => [
        c.sha256,
        c.startedAt,
        c.completedAt,
        c.attempt,
      ]),
    ).toEqual(
      n.captures.map((c) => [c.sha256, c.startedAt, c.completedAt, c.attempt]),
    );
    expect(saved.sourcePacketIndex?.requestWindow).toBeNull();
    const idx = saved.sourcePacketIndex!,
      caps = saved.sourceCaptures!;
    expect(
      Date.parse(caps[idx.registryOpeningCaptureIndices.at(-1)!]!.completedAt),
    ).toBeLessThanOrEqual(
      Date.parse(caps[idx.candidateCaptureIndices[0]!]!.startedAt),
    );
    expect(
      Date.parse(caps[idx.registryClosingCaptureIndices[0]!]!.startedAt),
    ).toBeGreaterThanOrEqual(
      Date.parse(caps[idx.candidateCaptureIndices.at(-1)!]!.completedAt),
    );
    const search = n.requests.filter((r) => r.path === "/Public/ViewReceipts");
    expect(
      search.every(
        (r) => r.fields.dtStartDate === "" && r.fields.dtEndDate === "",
      ),
    ).toBe(true);
  });
  it("reads a saved opening but always acquires a genuine fresh closing", async () => {
    await load(network());
    const n = network();
    const result = await load(n);
    expect(result.cash?.directContributionCents).toBe(184000);
    expect(result.pac?.donors[0]?.cashAmountCents).toBe(60000);
    expect(packetCount(n)).toBe(1);
    const saved = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    expect(
      saved.sourceCaptures?.some(
        (c) => c.startedAt === "2026-10-11T12:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      saved.sourcePacketIndex!.candidateCaptureIndices.every((i) =>
        n.captures.some(
          (c) =>
            c.sha256 === saved.sourceCaptures![i]!.sha256 &&
            c.startedAt === saved.sourceCaptures![i]!.startedAt,
        ),
      ),
    ).toBe(true);
  });
  it("refresh bypasses a compatible saved opening", async () => {
    await load(network());
    const n = network();
    const result = await load(n, true);
    expect(packetCount(n)).toBe(2);
    expect(result.cash).toBeDefined();
  });
  it("keeps the prior atomic bundle and emits no stale cash after malformed fresh PDF", async () => {
    await load(network());
    const old = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    const result = await load(network({ failedPdfAfterPacket: 1 }), true);
    expect(result.cash).toBeUndefined();
    expect(result.pac).toBeUndefined();
    const now = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    expect(now.sourceCaptures?.map((c) => [c.sha256, c.startedAt])).toEqual(
      old.sourceCaptures?.map((c) => [c.sha256, c.startedAt]),
    );
  });
  it("registry closing failure preserves PAC independently while current cash remains verified", async () => {
    const result = await load(network({ closingRegistryUnavailable: true }));
    expect(result.cash?.directContributionCents).toBe(184000);
    expect(result.pac).toBeUndefined();
  });
  it.each([
    "closing_search_503",
    "opening_get_503",
    "opening_network",
  ] as const)(
    "retains verified cash and original failed registry evidence after %s",
    async (registryFailure) => {
      const result = await load(network({ registryFailure }));
      expect(result.cash?.directContributionCents).toBe(184000);
      expect(result.pac).toBeUndefined();
      const saved = await readDelawareCfrsCommitteeArtifacts({
        cacheDir,
        cfId: owner.cfId,
      });
      const indices =
        registryFailure === "closing_search_503"
          ? saved.sourcePacketIndex!.registryClosingCaptureIndices
          : saved.sourcePacketIndex!.registryOpeningCaptureIndices;
      const captures = indices.map((i) => saved.sourceCaptures![i]!);
      if (registryFailure === "opening_network") {
        expect(captures).toEqual([]);
      } else {
        const failed = captures.filter((c) => c.status === 503);
        expect(failed).toHaveLength(3);
        expect(failed.map((c) => c.attempt)).toEqual([1, 2, 3]);
        expect(
          failed.every((c) => c.body.toString() === "registry unavailable"),
        ).toBe(true);
      }
      // Reuse candidate evidence, but failed registry evidence cannot grant PAC authority.
      const healthy = network();
      const replay = await load(healthy);
      expect(packetCount(healthy)).toBe(1);
      expect(replay.cash?.directContributionCents).toBe(184000);
      if (registryFailure !== "closing_search_503")
        expect(replay.pac).toBeUndefined();
      const recovered = await load(network());
      expect(recovered.cash?.directContributionCents).toBe(184000);
      expect(recovered.pac?.donors[0]?.cashAmountCents).toBe(60000);
    },
  );
  it("resolves actual CF01 independently when the complete catalog fails", async () => {
    const result = await load(network({ allRegistryUnavailable: true }));
    expect(result.cash?.directContributionCents).toBe(184000);
    expect(result.pac).toBeUndefined();
    expect(result.diagnostics).toContain(
      "Receiving owner resolved independently; whole donor registry remains unavailable",
    );
  });
  it("retains an actual failed retry in the journal and only uses its successful same-scope authority", async () => {
    const n = network({ retryOnce: true });
    const result = await load(n);
    expect(result.cash?.directContributionCents).toBe(184000);
    const saved = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    const failed = saved.sourceCaptures?.filter((c) => c.status === 503);
    expect(failed).toHaveLength(1);
    expect(failed![0]!.attempt).toBe(1);
    expect(
      saved.sourceCaptures?.some(
        (c) =>
          c.status === 200 &&
          c.attempt === 2 &&
          c.url === failed![0]!.url &&
          c.startedAt >= failed![0]!.completedAt,
      ),
    ).toBe(true);
  });
  it("keeps transient-zero search evidence but closes only the final exact full-scope search", async () => {
    const n = network({ transientZero: true });
    const result = await load(n);
    expect(result.cash?.directContributionCents).toBe(184000);
    const saved = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    expect(
      saved.sourceCaptures?.filter(
        (c) =>
          new URL(c.url).pathname === "/Public/ViewReceipts" &&
          c.status === 200,
      ),
    ).toHaveLength(3);
  });
  it("restarts a mismatching saved opening once using genuine new source generations", async () => {
    await load(network());
    const n = network({ changedCashAfterPacket: 1 });
    const result = await load(n);
    expect(packetCount(n)).toBe(2);
    expect(result.cash?.directContributionCents).toBe(194000);
    expect(result.pac?.donors[0]?.cashAmountCents).toBe(70000);
    expect(result.diagnostics).toContain(
      "Saved opening changed/unresolved; one genuine fresh restart",
    );
  });
  it("does not swallow a raw journal callback failure", async () => {
    await expect(
      load(network({ callbackFailure: true })),
    ).rejects.toMatchObject({ code: "capture_error" });
  });
});

it("closes a full payer source packet through the real positioned parser and emits only explicit allocations", async () => {
  const n = network({ payer: true });
  const result = await load(n);
  expect(result.cash?.directContributionCents).toBe(184000);
  expect(result.outsideEvidence, result.diagnostics.join("; ")).toHaveLength(1);
  expect(result.outsideEvidence[0]).toMatchObject({
    payer: { cfId: payer.cfId },
    candidateWideZeroAuthority: false,
    allocations: [
      {
        transactionId: 786022,
        amountCents: 49901500,
        direction: "support",
        sourceNativeCategory: "Other Expenses",
      },
    ],
  });
  const saved = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  expect(saved.sourcePacketIndex?.payers).toHaveLength(1);
  expect(
    saved.sourcePacketIndex?.payers[0]?.facets.thirdPartyReceiptExport.length,
  ).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain("SANITIZED ADDRESS");
});
it("an observed affiliation without complete current PDF proof cannot authorize outside money", async () => {
  const result = await load(network({ payer: true, payerPdfFailure: true }));
  expect(result.cash?.directContributionCents).toBe(184000);
  expect(result.pac?.donors[0]?.cashAmountCents).toBe(60000);
  expect(result.outsideEvidence).toEqual([]);
});
it.each([
  "fresh",
  "failed_opening",
  "cached_opening",
  "missing_organization",
] as const)(
  "keeps candidate components when an affiliated payer closing has an empty facet: %s",
  async (kind) => {
    if (kind === "cached_opening") await load(network({ payer: true }));
    const source = network({
      payer: true,
      payerNoReports: kind !== "missing_organization",
      payerPacketMissingSoo: kind === "missing_organization",
      ...(kind === "failed_opening" ? { payerNativeEmptyReads: 1 } : {}),
    });
    const result = await load(source);
    expect(
      result.cash?.directContributionCents,
      result.diagnostics.join("; "),
    ).toBe(184000);
    expect(result.pac?.donors[0]?.cashAmountCents).toBe(60000);
    expect(result.outsideEvidence).toEqual([]);
    const saved = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: owner.cfId,
    });
    expect(saved.sourcePacketIndex!.payers).toEqual([]);
    // Excluding reuse does not discard original observed responses.
    expect(
      source.captures.every((capture) =>
        saved.sourceCaptures!.some(
          (savedCapture) =>
            savedCapture.sha256 === capture.sha256 &&
            savedCapture.startedAt === capture.startedAt,
        ),
      ),
    ).toBe(true);
    if (kind !== "missing_organization") {
      expect(
        saved.sourceCaptures!.some(
          (c) =>
            new URL(c.url).pathname === "/Public/_ViewFiledReports" &&
            c.body.toString().includes("total:0"),
        ),
      ).toBe(true);
      expect(
        source.captures.some(
          (c) =>
            new URL(c.url).pathname === "/Public/FiledReports" &&
            new URL(c.url).searchParams.get("CommitteeID") ===
              String(payer.memberId),
        ),
      ).toBe(false);
    }
    const healthy = network({ payer: true });
    const recovered = await load(healthy);
    expect(recovered.outsideEvidence).toHaveLength(1);
    expect(
      healthy.requests.filter(
        (r) => r.path === "/Public/ViewReceipts" && r.fields.hdnTP === "1",
      ),
    ).toHaveLength(2);
  },
);
it("missing observed payer organization editions preserve outside discovery without narrowing cash", async () => {
  const result = await load(network({ payer: true, missingPayerSoo: true }));
  expect(result.outsideEvidence).toEqual([]);
  expect(result.cash).toBeDefined();
  expect(result.diagnostics.join(" ")).toContain("prior evidence preserved");
});
it("reuses a compatible saved payer opening and reacquires a complete fresh closing", async () => {
  await load(network({ payer: true }));
  const n = network({ payer: true });
  const result = await load(n);
  expect(result.outsideEvidence, result.diagnostics.join("; ")).toHaveLength(1);
  const tpSearches = n.requests.filter(
    (r) => r.path === "/Public/ViewReceipts" && r.fields.hdnTP === "1",
  );
  expect(tpSearches).toHaveLength(1);
  const saved = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  const f = saved.sourcePacketIndex!.payers[0]!.facets;
  expect(
    f.reportPdfs.every((i) =>
      n.captures.some(
        (c) =>
          c.startedAt === saved.sourceCaptures![i]!.startedAt &&
          c.sha256 === saved.sourceCaptures![i]!.sha256,
      ),
    ),
  ).toBe(true);
});
it("retains a valid closing after an incompatible opening only for the next genuinely closed run", async () => {
  const first = network({ payer: true, payerNativeEmptyReads: 1 });
  const refused = await load(first);
  expect(refused.outsideEvidence).toEqual([]);
  expect(refused.cash).toBeDefined();
  expect(refused.diagnostics.join(" ")).toContain("future saved opening");
  const saved = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  expect(saved.sourcePacketIndex!.payers).toHaveLength(1);
  const native = first.captures.filter(
    (c) =>
      new URL(c.url).pathname === "/Public/_ViewReceiptsCustom" &&
      JSON.parse(c.body.toString()).data.some(
        (r: Record<string, unknown>) => r.WC_ID === payer.cfId,
      ),
  );
  expect(native).toHaveLength(1);
  const refs = saved.sourcePacketIndex!.payers[0]!.facets.genericMemberReceipts;
  expect(
    refs.some(
      (i) =>
        saved.sourceCaptures![i]!.sha256 === native[0]!.sha256 &&
        saved.sourceCaptures![i]!.startedAt === native[0]!.startedAt,
    ),
  ).toBe(true);
  expect(
    saved.sourceCaptures!.some(
      (c) =>
        new URL(c.url).pathname === "/Public/_ViewReceiptsCustom" &&
        c.body.toString() === JSON.stringify({ data: [], total: 0 }),
    ),
  ).toBe(true);
  const second = network({ payer: true });
  const accepted = await load(second);
  expect(
    accepted.outsideEvidence,
    accepted.diagnostics.join("; "),
  ).toHaveLength(1);
  expect(accepted.outsideEvidence[0]!.allocations[0]!.amountCents).toBe(
    49901500,
  );
  expect(
    second.requests.filter(
      (r) => r.path === "/Public/ViewReceipts" && r.fields.hdnTP === "1",
    ),
  ).toHaveLength(1);
});
it("does not index an incompatible closing after the opening fails", async () => {
  const refused = await load(
    network({ payer: true, payerNativeEmptyReads: 2 }),
  );
  expect(refused.outsideEvidence).toEqual([]);
  const saved = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  expect(saved.sourcePacketIndex!.payers).toEqual([]);
});
it("propagates a failed closing observer instead of committing a future payer opening", async () => {
  await expect(
    load(
      network({
        payer: true,
        payerNativeEmptyReads: 1,
        payerClosingCallbackFailure: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "capture_error" });
  await expect(
    readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: owner.cfId }),
  ).rejects.toThrow();
});
it("does not let mutation of the input context during a fetch change source authority", async () => {
  const n = network();
  const original = { ...context };
  let first = true;
  const result = await loadDelawareVerifiedFinanceSource({
    context: original,
    cacheDir,
    sessionOptions: {
      ...n.sessionOptions,
      fetchImpl: async (url, init) => {
        if (first) {
          first = false;
          original.candidateName = "Other Candidate";
          original.receivingCfId = "01000099";
        }
        return n.fetchImpl(url, init);
      },
    },
  });
  expect(result.cash?.directContributionCents).toBe(184000);
  expect(result.pac?.sourceProvenance.target.candidateName).toBe(
    "Example Candidate",
  );
});

it("acquires genuinely paired official same-office sources and bounded candidate reports with original metadata", async () => {
  const n = network({ incumbent: true });
  const result = await load(n);
  expect(
    result.cash?.directContributionCents,
    result.diagnostics.join("; "),
  ).toBe(184000);
  expect(result.pac?.donors[0]?.cashAmountCents).toBe(60000);
  const searches = n.requests.filter((r) => r.path === "/Public/ViewReceipts");
  expect(
    searches.every(
      (r) =>
        r.fields.dtStartDate === "01/01/2023" &&
        r.fields.dtEndDate === "12/31/2026",
    ),
  ).toBe(true);
  const saved = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  expect(saved.officialElectionSources).toHaveLength(4);
  const idx = saved.sourcePacketIndex!,
    caps = saved.sourceCaptures!;
  expect(
    saved
      .officialElectionSources!.slice(0, 2)
      .every(
        (c) =>
          c.completedAt <= caps[idx.candidateCaptureIndices[0]!]!.startedAt,
      ),
  ).toBe(true);
  expect(
    saved
      .officialElectionSources!.slice(2)
      .every(
        (c) =>
          c.startedAt >= caps[idx.candidateCaptureIndices.at(-1)!]!.completedAt,
      ),
  ).toBe(true);
});
it("reuses saved preceding official observations with a fresh official closing", async () => {
  await load(network({ incumbent: true }));
  const n = network({ incumbent: true });
  const result = await load(n);
  expect(
    result.cash?.directContributionCents,
    result.diagnostics.join("; "),
  ).toBe(184000);
  expect(packetCount(n)).toBe(1);
});
it("changed official closing preserves candidate cash and PAC instead of guessing continued candidacy", async () => {
  const result = await load(
    network({ incumbent: true, changedOfficialClosing: true }),
  );
  expect(result.cash).toBeUndefined();
  expect(result.pac).toBeUndefined();
});

it("retains the exact published SO honorific for affiliation discovery rather than losing a literal same-source edge", async () => {
  const result = await load(network({ payer: true, publishedHonorific: true }));
  expect(result.outsideEvidence, result.diagnostics.join("; ")).toHaveLength(1);
});

it("delivers genuine official packets to the external journal observer without exposing mutable authority bytes", async () => {
  const n = network({ incumbent: true });
  const result = await loadDelawareVerifiedFinanceSource({
    context: { ...context, officeName: "Attorney General", district: null },
    cacheDir,
    sessionOptions: {
      ...n.sessionOptions,
      onResponseCapture: async (c) => {
        await n.sessionOptions.onResponseCapture(c);
        if (new URL(c.url).origin === "https://elections.delaware.gov") {
          c.body.fill(0);
          c.sha256 = "0".repeat(64);
        }
      },
    },
  });
  expect(
    result.cash?.directContributionCents,
    result.diagnostics.join("; "),
  ).toBe(184000);
  const official = n.captures.filter(
    (c) => new URL(c.url).origin === "https://elections.delaware.gov",
  );
  expect(official).toHaveLength(4);
  const saved = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  expect(
    saved.officialElectionSources?.map((c) => [
      c.sha256,
      c.startedAt,
      c.completedAt,
    ]),
  ).toEqual(official.map((c) => [c.sha256, c.startedAt, c.completedAt]));
  expect(
    saved.sourceCaptures!.every(
      (c) => new URL(c.url).origin === "https://cfrs.elections.delaware.gov",
    ),
  ).toBe(true);
});
it("propagates an official raw journal observer failure before financial acceptance", async () => {
  const n = network({ incumbent: true });
  await expect(
    loadDelawareVerifiedFinanceSource({
      context: { ...context, officeName: "Attorney General", district: null },
      cacheDir,
      sessionOptions: {
        ...n.sessionOptions,
        onResponseCapture: async (c) => {
          if (new URL(c.url).origin === "https://elections.delaware.gov")
            throw Error("synthetic official observer failure");
        },
      },
    }),
  ).rejects.toMatchObject({ code: "capture_error" });
  expect(n.requests.some((r) => r.path === "/Public/ViewReceiptsMain")).toBe(
    false,
  );
});

it("withholds every writable modern component when atomic source storage fails and leaves the preceding bundle unchanged", async () => {
  await load(network({ payer: true }));
  const old = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  vi.spyOn(
    artifactCache,
    "storeDelawareCfrsCommitteeArtifacts",
  ).mockRejectedValue(new Error("synthetic durable cache failure"));
  const result = await load(
    network({
      payer: true,
      changedCashAfterPacket: 1,
      payerNativeEmptyReads: 1,
    }),
    true,
  );
  expect(result.cash).toBeUndefined();
  expect(result.pac).toBeUndefined();
  expect(result.outsideEvidence).toEqual([]);
  expect(result.diagnostics).toContain(
    "Current source bundle could not commit atomically; old bundle unchanged",
  );
  const now = await readDelawareCfrsCommitteeArtifacts({
    cacheDir,
    cfId: owner.cfId,
  });
  expect(
    now.sourceCaptures!.map((c) => [c.sha256, c.startedAt, c.completedAt]),
  ).toEqual(
    old.sourceCaptures!.map((c) => [c.sha256, c.startedAt, c.completedAt]),
  );
});
