import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyDelawareThirdPartyOutsideSource,
  fingerprintDelawareThirdPartyOrganizationHtml,
  type DelawareOutsideSourcePacket,
  type DelawareOutsideCandidateScope,
  type DelawareOutsidePayerScope,
} from "../../../src/pipeline/delawareFinance/delawareThirdPartyOutsideSource.js";
import {
  type DelawareCfrsResponseCapture,
  buildDelawareReceiptsSearchFields,
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import { DELAWARE_EXPENSE_CSV_COLUMNS } from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import {
  projectDelawareNativeExpenseCsvRow,
  decodeDelawareExpenseNativePage,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import {
  type DelawareThirdPartyPdfCell,
  type DelawareThirdPartyPdfExtraction,
} from "../../../src/pipeline/delawareFinance/delawareThirdPartyFinancialReport.js";
// Sanitized positioned source-shaped facts. No real addresses or fetched PDF bodies.
const cell = (
  text: string,
  x: number,
  y: number,
): DelawareThirdPartyPdfCell => ({ text, x, y, width: 20, height: 9 });
function fixture(): DelawareThirdPartyPdfExtraction {
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
function pdf(e: DelawareThirdPartyPdfExtraction): Buffer {
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
const payer: DelawareOutsidePayerScope = {
  cfId: "04006716",
  memberId: 739099,
  committeeName: "THE STATEHOUSE FUND",
  committeeType: "04",
};
const candidate: DelawareOutsideCandidateScope = {
  candidateId: "3f85bd1d-aa20-4a5d-8de1-b1112c609653",
  electionId: "dd3af13f-08bc-4547-a5d6-d27a558fc0e9",
  electionYear: 2026,
  electionDate: "2026-11-03",
  electionStage: "general",
  candidateName: "Kathy Jennings",
  officeName: "Attorney General",
  district: null,
  party: "Democratic",
  receivingCfId: "01004199",
  receivingMemberId: 458984,
  receivingCommitteeName: "Friends of Kathy Jennings",
};
const file =
    "CampaignFinanceReport_Prelim_739099_315_829eb639-f068-43f2-8f7a-38576c55fbc6.pdf",
  receiverFile =
    "CampaignFinanceReport_Prelim_458984_1272_829eb639-f068-43f2-8f7a-38576c55fbc6.pdf";
function fixturePdf(receiver = false) {
  const f = fixture();
  for (const i of [4, 5])
    (f.pages[i]!.cells as DelawareThirdPartyPdfCell[]).push(
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
  f.pages
    .slice(4)
    .forEach((p) =>
      (p.cells as DelawareThirdPartyPdfCell[]).push(
        cell("Date Received", 60, 340),
      ),
    );
  (f.pages[8]!.cells as DelawareThirdPartyPdfCell[]).push(
    cell("Date Paid", 60, 240),
  );
  if (receiver)
    f.pages.forEach((p) =>
      p.cells.forEach((c) => {
        if (c.text === "04006716") c.text = "01004199";
        if (c.text === "08/05/2026") c.text = "08/11/2026";
        if (c.text === "08/18/2026") c.text = "09/07/2026";
      }),
    );
  return f;
}
function nativeReceipt() {
  return {
    ContributionType: "Cash",
    TransactionDate: `/Date(${Date.parse("2026-08-07T00:00:00Z")})/`,
    Transaction_id: 786013,
    ContributorName: "Public First Action ",
    ContributionAmount: 525000,
    ContributorAddress: "SANITIZED ADDRESS",
    EmployerAddress: null,
    OccupationTitle: "Other",
    EmployerName: "",
    EmployerAddressLine1: "",
    ContributorType: "Individual",
    ReceivingCommitteeName: payer.committeeName,
    GabId: "",
    WC_ID: payer.cfId,
    Office: null,
    District: "",
    Branch: null,
    FilingPeriodName: "Aug 18, 2026 Filing 1.0 11:07 AM",
    Fund_Type: null,
    Fixed_Asset: "No",
    FileAmendedVersion: "07 Aug 2026 Version 1.012:00AM",
    AddressLine1: "SANITIZED ADDRESS",
    AddressLine2: "",
    City: "",
    State_Code: "",
    Zip_Code: "",
    Zip_Ext: "",
  };
}
function nativeExpense() {
  return {
    Transaction_Id: 786022,
    RegistrantName: payer.committeeName,
    PayeeName: "Bryson Gillette, LLC",
    PayeeType: "Business/Group/Organization",
    Address: "SANITIZED ADDRESS",
    TransactionDate: `/Date(${Date.parse("2026-08-17T00:00:00Z")})/`,
    ExpensePurpose: "",
    ExpenseCategory: "Other Expenses",
    ExpenseMethod: "Wire Transfer",
    ExpenseAmount: 499015,
    District: null,
    FilingYear: null,
    FilingPeriodName: "Aug 18, 2026 Filing 1.0 11:07 AM",
    CommitteeID: null,
    VendorName: "",
    VendorAddress: "",
    Comments: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    Fixed_Asset_Desc: "",
    Fixed_Asset_Location: "",
    CCF_ID: payer.cfId,
    FileAmendedVersion: "17 Aug 2026 Version 1.012:00AM",
    AddressLine1: "SANITIZED ADDRESS",
    AddressLine2: "",
    City: "",
    State: "",
    ZipCode: "",
  };
}
const grid = (n: number) =>
  `<script>jQuery('#Grid').tGrid({total:${n}});</script>`;
function reportHtml(receiver = false) {
  const mem = receiver ? 458984 : 739099;
  return (
    grid(1) +
    `<div id="Grid"><table><tbody><tr>${[receiver ? "2026 8 Day 2026 Primary Election 09/15/2026" : "18 Aug 2026 Filing 1.0 11:07 AM", `<a onclick="downloadReport(&#39;${receiver ? receiverFile : file}&#39;,&#39;${mem}&#39;,&#39;${receiver ? 1272 : 315}&#39;)">Original Financial Statement</a>`, receiver ? candidate.receivingCfId : payer.cfId, receiver ? candidate.receivingCommitteeName : payer.committeeName, receiver ? "Candidate Committee" : "3rd Party Advertisers", "08/18/2026", "2026", receiver ? "State Office - Attorney General" : "", "Active"].map((x) => `<td>${x}</td>`).join("")}</tr></tbody></table></div>`
  );
}
function phase(after = false): DelawareOutsideSourcePacket {
  let n = after ? 1000 : 0;
  const cap = (
    p: string,
    body: Buffer | string,
    fields: Record<string, string> | null = null,
  ): DelawareCfrsResponseCapture => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    n += 2;
    return {
      body: bytes,
      url: "https://cfrs.elections.delaware.gov" + p,
      method: fields === null ? "GET" : "POST",
      financeFields: fields,
      requestScopeRedacted: false,
      attempt: 1,
      startedAt: new Date(Date.UTC(2026, 9, 11, 12, 0, n)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 9, 11, 12, 0, n + 1)).toISOString(),
      status: 200,
      contentType: p.includes("FiledReports?")
        ? "application/pdf"
        : "text/html; charset=utf-8",
      byteCount: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const registry = (r = false) => [
    cap("/Public/Search", grid(1), {
      CommitteeType: r ? "01" : "04",
      btnSearch: "Search",
    }),
    cap(
      "/Public/_ViewCommittees",
      JSON.stringify({
        total: 1,
        data: [
          {
            MemberID: r ? 458984 : 739099,
            MemberVersID: r ? 7 : 1,
            Committee_Id: r ? candidate.receivingCfId : payer.cfId,
            CommitteeName: r
              ? candidate.receivingCommitteeName
              : payer.committeeName,
            CommitteeTypeCode: r ? "01" : "04",
            CommitteeStatus: "Active",
          },
        ],
      }),
      { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" },
    ),
  ];
  const soo = (r = false) =>
    cap(
      `/Public/ShowReview?memberID=${r ? 458984 : 739099}&memVersID=${r ? 7 : 1}&cTypeCode=${r ? "01" : "04"}&ftype=SO&fpath=&fname=&isPublic=true`,
      `<table><tr><td>Committee Name:</td><td>${r ? candidate.receivingCommitteeName : payer.committeeName}</td></tr></table>` +
        (r
          ? `<table id='Viewelection'><tbody><tr><td>State Office</td><td>Na</td><td>Attorney General</td><td>-- Select District --</td><td>Democratic</td></tr></tbody></table><table id='CandidateList'><tbody><tr><td>Ms. Kathleen Jennings</td><td></td><td>SANITIZED ADDRESS</td><td></td></tr></tbody></table>`
          : `<table id='ViewCandiate'><tbody><tr><td>Friends of Kathy Jennings</td><td>Ms. Kathleen Jennings</td><td>Attorney General</td><td>Democratic</td><td>Support</td><td>Active</td></tr></tbody></table>`),
    );
  const report = (r = false, current = false) => [
    cap("/Public/ViewFiledReports?theme=vista", grid(1), {
      ...buildDelawareFiledReportsSearchFields({
        MemberId: String(r ? 458984 : 739099),
        txtCommitteeName: r
          ? candidate.receivingCommitteeName
          : payer.committeeName,
      }),
      ...(current ? { hdnViewCurrent: "true", chkViewCurrReport: "on" } : {}),
    }),
    cap(
      "/Public/_ViewFiledReports?ajax=True&Grid-page=1&Grid-size=500&Grid-filter=~&theme=vista",
      reportHtml(r),
    ),
  ];
  const reportPdf = (r = false) =>
    cap(
      `/Public/FiledReports?FileName=${r ? receiverFile : file}&CommitteeID=${r ? 458984 : 739099}&FilingCalendarID=${r ? 1272 : 315}`,
      pdf(fixturePdf(r)),
    );
  const sf = buildDelawareReceiptsSearchFields({
      MemberId: "739099",
      txtReceivingRegistrant: payer.committeeName,
    }),
    expense = nativeExpense();
  const csv = projectDelawareNativeExpenseCsvRow(
    decodeDelawareExpenseNativePage(
      JSON.stringify({ data: [expense], total: 1 }),
    ).rows[0]!,
  );
  csv["Expenditure Date"] = "08/17/2026";
  csv["Amount($)"] = "499015.0000";
  return {
    registry: registry(),
    payerOrganization: [soo()],
    receiverIdentity: [...registry(true), soo(true)],
    candidateCycleAuthority: [...report(true), reportPdf(true)],
    allVersionReports: report(),
    latestAccountReport: report(false, true),
    genericMemberReceipts: [
      cap("/Public/ViewReceiptsMain", "<form></form>"),
      cap("/Public/ViewReceipts?theme=vista", grid(1), sf),
      cap(
        "/Public/_ViewReceiptsCustom?Grid-size=15&theme=vista",
        JSON.stringify({ data: [nativeReceipt()], total: 999 }),
        { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" },
      ),
    ],
    thirdPartyReceiptExport: [
      cap("/Public/ViewReceiptsMain", "<form></form>"),
      cap("/Public/ViewReceipts?theme=vista", grid(1), {
        ...sf,
        hdnTP: "1",
        chkTP: "3",
      }),
      cap(
        "/Public/ExportCSVNew_TP?page=1&orderBy=~&filter=~&Grid-size=15&theme=vista",
        "Contribution Date,Contributor Name,Contributor Address,Employer Name,Filed Reports,Employer Occupation,Contribution Amount,Receiving Committee,\n08/07/2026,Public First Action,SANITIZED ADDRESS,,Other,07 Aug 2026 Version 1.012:00AM,525000.0000,THE STATEHOUSE FUND,\n",
      ),
    ],
    expenses: [
      cap(
        "/Public/OtherSearch?theme=vista",
        grid(1),
        buildDelawareExpensesSearchFields({
          MemberId: "739099",
          txtRegistrant: payer.committeeName,
          CommitteeType: "04",
        }),
      ),
      cap(
        "/Public/_ViewExpensesCustom?Grid-size=15&theme=vista",
        JSON.stringify({ data: [expense], total: 99 }),
        { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" },
      ),
      cap(
        "/Public/ExportExpensestoCsv?page=1&orderBy=~&filter=~&Grid-size=15&theme=vista",
        DELAWARE_EXPENSE_CSV_COLUMNS.join(",") +
          ",\n" +
          DELAWARE_EXPENSE_CSV_COLUMNS.map((k) => csv[k]).join(",") +
          ",\n",
      ),
    ],
    reportPdfs: [reportPdf()],
  };
}
function changed(c: DelawareCfrsResponseCapture, f: (s: string) => string) {
  c.body = Buffer.from(f(c.body.toString()));
  c.byteCount = c.body.length;
  c.sha256 = createHash("sha256").update(c.body).digest("hex");
}
function input() {
  return {
    payer: { ...payer },
    candidate: { ...candidate },
    before: phase(),
    after: phase(true),
  };
}
describe("Delaware pure TP outside full source binder (synthetic protocol)", () => {
  it("binds separate whole native/TP8 facets, literal target and reported candidacy period", async () => {
    const r = await verifyDelawareThirdPartyOutsideSource(input());
    expect(r.diagnostics.join()).not.toContain("Delaware outside source:");
    expect(r.proof?.allocations).toMatchObject([
      {
        transactionId: 786022,
        amountCents: 49901500,
        sourceNativeCategory: "Other Expenses",
        direction: "support",
        qualificationReportFileName: receiverFile,
      },
    ]);
    expect(r.proof?.candidateWideZeroAuthority).toBe(false);
  });
  it("accepts a sole actual Amended edition without a guessed max-footer rule", async () => {
    const i = input();
    for (const p of [i.before, i.after])
      for (const c of [...p.allVersionReports, ...p.latestAccountReport])
        if (c.url.includes("_ViewFiledReports"))
          changed(c, (s) =>
            s.replace(
              "Original Financial Statement",
              "Amended Financial Statement",
            ),
          );
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeDefined();
  });
  it.each([
    "wrong_cf",
    "wrong_member",
    "party",
    "local_name",
    "year",
    "office",
    "special",
    "missing",
    "hash",
    "redacted",
    "time",
    "native_field",
    "donor_name",
    "address",
    "misleading_header",
    "tp_zero",
    "current_pointer",
    "supplemental",
    "unqualified_date",
  ])("preserves %s", async (kind) => {
    const i = input();
    if (kind === "wrong_cf") i.payer.cfId = "04000000";
    if (kind === "wrong_member") i.payer.memberId = 1;
    if (kind === "party") i.candidate.party = "Republican";
    if (kind === "local_name") i.candidate.candidateName = "Not Kathy Jennings";
    if (kind === "year") i.candidate.electionYear = 2024;
    if (kind === "office") i.candidate.officeName = "Governor";
    if (kind === "special") i.candidate.electionStage = "special" as "general";
    if (kind === "missing") i.after.reportPdfs = [];
    if (kind === "hash") i.after.reportPdfs[0]!.sha256 = "0".repeat(64);
    if (kind === "redacted") i.after.expenses[1]!.requestScopeRedacted = true;
    if (kind === "time")
      i.after.reportPdfs[0]!.startedAt = i.before.reportPdfs[0]!.startedAt;
    if (kind === "native_field")
      changed(i.after.expenses[1]!, (s) =>
        s.replace('"Comments":null', '"Comments":"changed"'),
      );
    if (kind === "donor_name")
      changed(i.after.genericMemberReceipts[2]!, (s) =>
        s.replace("Public First Action", "Same Money Different Donor"),
      );
    if (kind === "address")
      changed(i.after.genericMemberReceipts[2]!, (s) =>
        s.replace("SANITIZED ADDRESS", "DIFFERENT ADDRESS"),
      );
    if (kind === "misleading_header")
      changed(i.after.thirdPartyReceiptExport[2]!, (s) =>
        s.replace(
          "Other,07 Aug 2026 Version 1.012:00AM",
          "Aug 18 Filing,Other",
        ),
      );
    if (kind === "tp_zero")
      changed(i.after.thirdPartyReceiptExport[1]!, (s) =>
        s.replace("total:1", "total:0"),
      );
    if (kind === "current_pointer")
      changed(i.after.latestAccountReport[1]!, (s) =>
        s.replace(file, file.replace("829eb639", "00000000")),
      );
    if (kind === "supplemental") {
      const e = fixturePdf();
      (e.pages[4]!.cells as DelawareThirdPartyPdfCell[]).push(
        cell("$100.00", 600, 315),
        cell("($100.00)", 650, 315),
      );
      const c = i.after.reportPdfs[0]!;
      c.body = pdf(e);
      c.byteCount = c.body.length;
      c.sha256 = createHash("sha256").update(c.body).digest("hex");
    }
    if (kind === "unqualified_date")
      for (const p of [i.before, i.after]) {
        const c = p.candidateCycleAuthority.at(-1)!,
          e = fixturePdf(true);
        e.pages.forEach((p) =>
          p.cells.forEach((c) => {
            if (c.text === "08/11/2026") c.text = "08/18/2026";
          }),
        );
        c.body = pdf(e);
        c.byteCount = c.body.length;
        c.sha256 = createHash("sha256").update(c.body).digest("hex");
      }
    const r = await verifyDelawareThirdPartyOutsideSource(i);
    expect(r.proof).toBeUndefined();
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
  it("does not retag unsupported TP-native0 as authoritative zero", async () => {
    const i = input();
    i.before.unsupportedFacets = [
      {
        ...i.before.genericMemberReceipts[2]!,
        body: Buffer.from('{"data":[],"total":0}'),
      },
    ];
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeDefined();
  });
  it("rejects cached openings masquerading as fresh closing", async () => {
    const i = input();
    i.after.registry = i.before.registry;
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeUndefined();
  });
  it("retains raw bytes and context before async PDF extraction yields", async () => {
    const i = input(),
      p = verifyDelawareThirdPartyOutsideSource(i);
    i.payer.committeeName = "Mutated";
    i.after.reportPdfs[0]!.body.fill(0);
    expect((await p).proof?.payer.committeeName).toBe(payer.committeeName);
  });
  it("preserves unequal/missing SO editions instead of choosing the largest source version", async () => {
    const i = input();
    for (const p of [i.before, i.after])
      changed(p.receiverIdentity[1]!, (s) => {
        const j = JSON.parse(s);
        j.total = 2;
        j.data.push({ ...j.data[0], MemberVersID: 6 });
        return JSON.stringify(j);
      });
    const r = await verifyDelawareThirdPartyOutsideSource(i);
    expect(r.proof).toBeUndefined();
    expect(r.diagnostics.join()).toContain(
      "missing complete published SO editions",
    );
  });
  it("accepts fully captured equivalent person/office/party SO identities without guessing current edition", async () => {
    const i = input();
    for (const p of [i.before, i.after]) {
      changed(p.receiverIdentity[1]!, (s) => {
        const j = JSON.parse(s);
        j.total = 2;
        j.data.push({ ...j.data[0], MemberVersID: 6 });
        return JSON.stringify(j);
      });
      const cap = {
        ...p.receiverIdentity[2]!,
        body: Buffer.from(p.receiverIdentity[2]!.body),
        url: p.receiverIdentity[2]!.url.replace("memVersID=7", "memVersID=6"),
      };
      cap.startedAt = cap.completedAt;
      p.receiverIdentity = [...p.receiverIdentity, cap];
    }
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeDefined();
    changed(i.after.receiverIdentity[3]!, (s) =>
      s.replace("Attorney General", "Governor"),
    );
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeUndefined();
  });
  it("rejects equal-dollar missing/repeated stable native identities and nonblank hidden source filters", async () => {
    for (const kind of ["repeat", "filter", "route", "query"]) {
      const i = input();
      if (kind === "repeat")
        changed(i.after.genericMemberReceipts[2]!, (s) => {
          const j = JSON.parse(s);
          j.data.push(j.data[0]);
          return JSON.stringify(j);
        });
      if (kind === "filter")
        i.after.genericMemberReceipts[1]!.financeFields = {
          ...i.after.genericMemberReceipts[1]!.financeFields!,
          ContributorType: "Individual",
        };
      if (kind === "route")
        i.after.genericMemberReceipts[2]!.url =
          i.after.genericMemberReceipts[2]!.url.replace(
            "_ViewReceiptsCustom",
            "Unrecognized",
          );
      if (kind === "query")
        i.after.thirdPartyReceiptExport[2]!.url =
          i.after.thirdPartyReceiptExport[2]!.url.replace(
            "filter=~",
            "filter=positiveOnly",
          );
      expect(
        (await verifyDelawareThirdPartyOutsideSource(i)).proof,
      ).toBeUndefined();
    }
  });
  it("preserves multiple same-period report identities even when all money/footer facts match", async () => {
    const i = input();
    for (const p of [i.before, i.after]) {
      const old = p.reportPdfs[0]!,
        next = {
          ...old,
          body: Buffer.from(old.body),
          url: old.url.replace("829eb639", "00000000"),
          startedAt: old.completedAt,
        };
      p.reportPdfs = [old, next];
      changed(p.allVersionReports[1]!, (s) =>
        s
          .replace("total:1", "total:2")
          .replace(
            "</tbody>",
            s.match(/<tr>.*<\/tr>/)![0].replace("829eb639", "00000000") +
              "</tbody>",
          ),
      );
    }
    const r = await verifyDelawareThirdPartyOutsideSource(i);
    expect(r.proof).toBeUndefined();
    expect(r.diagnostics.join()).toContain("multiple current-period");
  });
  it("retains legitimate identical expense occurrences with distinct stable IDs and literal target rows", async () => {
    const i = input();
    for (const phase of [i.before, i.after]) {
      const first = { ...nativeExpense(), ExpenseAmount: 249507.5 },
        second = { ...first, Transaction_Id: 786023 };
      changed(phase.expenses[0]!, (s) => s.replace("total:1", "total:2"));
      changed(phase.expenses[1]!, () =>
        JSON.stringify({ data: [first, second], total: 99 }),
      );
      changed(
        phase.expenses[2]!,
        () =>
          DELAWARE_EXPENSE_CSV_COLUMNS.join(",") +
          ",\n" +
          [first, second]
            .map((raw) => {
              const r = decodeDelawareExpenseNativePage(
                  JSON.stringify({ data: [raw], total: 99 }),
                ).rows[0]!,
                csv = projectDelawareNativeExpenseCsvRow(r);
              csv["Expenditure Date"] = "08/17/2026";
              csv["Amount($)"] = "249507.50";
              return (
                DELAWARE_EXPENSE_CSV_COLUMNS.map((k) => csv[k]).join(",") + ","
              );
            })
            .join("\n") +
          "\n",
      );
      const e = fixturePdf(),
        page = e.pages[3]!;
      page.cells.forEach((c) => {
        if (c.y === 324 && c.x === 700) c.text = "$249,507.50";
        if (c.y === 279) c.y = 237;
        if (c.y === 261) c.y = 219;
        if (c.y === 243) c.y = 201;
      });
      (page.cells as DelawareThirdPartyPdfCell[]).push(
        cell("08/17/2026", 60, 278),
        cell("Bryson Gillette, LLC", 129, 278),
        cell("SANITIZED ADDRESS", 300, 278),
        cell("$499,015.00", 621, 278),
        cell("$249,507.50", 700, 278),
        cell("Support of Kathleen Jennings - State", 129, 258),
        cell("Office - Attorney General - Democratic", 129, 248),
      );
      const cap = phase.reportPdfs[0]!;
      cap.body = pdf(e);
      cap.byteCount = cap.body.length;
      cap.sha256 = createHash("sha256").update(cap.body).digest("hex");
    }
    const result = await verifyDelawareThirdPartyOutsideSource(i);
    expect(
      result.proof?.allocations.map((r) => [
        r.transactionId,
        r.occurrence,
        r.amountCents,
      ]),
    ).toEqual([
      [786022, 0, 24950750],
      [786023, 1, 24950750],
    ]);
  });
  it("retains multiple FF/SO registry form rows for one actual SO edition, while rejecting conflicting owner contexts", async () => {
    const i = input();
    for (const p of [i.before, i.after])
      changed(p.receiverIdentity[1]!, (s) => {
        const j = JSON.parse(s);
        j.total = 5;
        j.data = [
          ...Array.from({ length: 4 }, () => ({
            ...j.data[0],
            Formtype: "FF",
          })),
          { ...j.data[0], Formtype: "SO" },
        ];
        return JSON.stringify(j);
      });
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeDefined();
    changed(i.after.receiverIdentity[1]!, (s) => {
      const j = JSON.parse(s);
      j.data[0].Office = "State Office - Governor";
      return JSON.stringify(j);
    });
    const r = await verifyDelawareThirdPartyOutsideSource(i);
    expect(r.proof).toBeUndefined();
    expect(r.diagnostics.join()).toContain("conflicting owner/context");
  });
  it("requires complete same-CF registry scope and exact known GET selectors", async () => {
    for (const kind of ["wrong_cf", "name_filter", "extra_get"]) {
      const i = input();
      if (kind === "wrong_cf")
        i.before.registry[0]!.financeFields = {
          ...i.before.registry[0]!.financeFields!,
          txtCommitteeID: "04000000",
        };
      if (kind === "name_filter")
        i.before.registry[0]!.financeFields = {
          ...i.before.registry[0]!.financeFields!,
          txtCommitteeName: payer.committeeName,
        };
      if (kind === "extra_get")
        i.before.thirdPartyReceiptExport[2]!.url +=
          "&ContributorType=Individual";
      expect(
        (await verifyDelawareThirdPartyOutsideSource(i)).proof,
      ).toBeUndefined();
    }
    const i = input();
    for (const p of [i.before, i.after])
      p.registry[0]!.financeFields = {
        ...p.registry[0]!.financeFields!,
        txtCommitteeID: payer.cfId,
        txtCommitteeName: "",
      };
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeDefined();
  });
  it("rejects registry rows from a stored prior search even if the new Search has the expected fields", async () => {
    const i = input(),
      search = i.before.registry[0]!,
      grid = i.before.registry[1]!;
    grid.startedAt = search.startedAt;
    grid.completedAt = search.completedAt;
    search.startedAt = new Date(
      Date.parse(grid.completedAt) + 1000,
    ).toISOString();
    search.completedAt = search.startedAt;
    i.before.registry = [grid, search];
    const r = await verifyDelawareThirdPartyOutsideSource(i);
    expect(r.proof).toBeUndefined();
    expect(r.diagnostics.join()).toContain("registry rows precede");
  });
  it("compares exact decoded public email despite source obfuscation and preserves changed email/content", async () => {
    const email = (value: string, key: number) =>
      Buffer.from([key, ...Buffer.from(value).map((b) => b ^ key)]).toString(
        "hex",
      );
    const element = (value: string, key: number) =>
      `<a data-cfemail="${email(value, key)}" href="/cdn-cgi/l/email-protection#${email(value, key)}">[email protected]</a>`;
    expect(
      fingerprintDelawareThirdPartyOrganizationHtml(
        element("source@example.test", 1),
      ),
    ).toBe(
      fingerprintDelawareThirdPartyOrganizationHtml(
        element("source@example.test", 2),
      ),
    );
    const i = input();
    changed(
      i.before.payerOrganization[0]!,
      (s) => s + element("source@example.test", 1),
    );
    changed(
      i.after.payerOrganization[0]!,
      (s) => s + element("source@example.test", 2),
    );
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeDefined();
    changed(i.after.payerOrganization[0]!, (s) =>
      s.replace(
        element("source@example.test", 2),
        element("changed@example.test", 2),
      ),
    );
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeUndefined();
  });
  it("retains ordinary or unknown script and changed affiliations, rather than broadly stripping content", async () => {
    const i = input();
    changed(
      i.after.payerOrganization[0]!,
      (s) => s + "<script>unknownSourceContent()</script>",
    );
    expect(
      (await verifyDelawareThirdPartyOutsideSource(i)).proof,
    ).toBeUndefined();
    const j = input();
    changed(j.after.payerOrganization[0]!, (s) =>
      s.replace("<td>Support</td>", "<td>Oppose</td>"),
    );
    expect(
      (await verifyDelawareThirdPartyOutsideSource(j)).proof,
    ).toBeUndefined();
    expect(() =>
      fingerprintDelawareThirdPartyOrganizationHtml(
        "<script>window.__CF$cv$params={r:'aa',t:'bb'};unknown()</script>",
      ),
    ).toThrow("unknown Cloudflare challenge structure");
  });
});
