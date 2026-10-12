import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DelawareCfrsFetchFn,
  DelawareCfrsResponseCapture,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import {
  acquireDelawareCfrsCommitteeArtifacts,
  fetchDelawareCfrsCandidateSourcePacket,
} from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactAcquisition.js";
import { readDelawareCfrsCommitteeArtifacts } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactCache.js";

import {
  DELAWARE_NATIVE_RECEIPT_FIELDS,
  DELAWARE_NATIVE_EXPENSE_FIELDS,
  decodeDelawareReceiptNativePage,
  decodeDelawareExpenseNativePage,
  projectDelawareNativeReceiptCsvRow,
  projectDelawareNativeExpenseCsvRow,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import {
  DELAWARE_RECEIPT_CSV_COLUMNS,
  DELAWARE_EXPENSE_CSV_COLUMNS,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";

const CF_ID = "01009999";
const MEMBER_ID = 600001;

const RECEIPTS_CSV = [
  "Contribution Date,Contributor Name,Contributor Address Line 1,Contributor Address Line 2,Contributor City,Contributor State,Contributor Zip,Contributor Type,Employer Name,Employer Occupation,Contribution Type,Contribution Amount,CF_ID,Receiving Committee,Filing Period,Office,Fixed Asset,",
  `6/30/2026,Jane Donor,1 Example St,,Wilmington,DE,19801,Individual,,Attorney,Check,500.0000,${CF_ID},Jane Example for Delaware,2026 2026 General Election 11/03/2026 30 Day,(Attorney General),No`,
  `7/01/2026,Sam Donor,2 Example St,,Dover,DE,19901,Individual,,,Check,200.0000,${CF_ID},Jane Example for Delaware,2026 2026 General Election 11/03/2026 30 Day,(Attorney General),No`,
].join("\r\n");

const EXPENSES_CSV = [
  "Expenditure Date,Payee Name,Payee Address Line 1,Payee Address Line 2,Payee City,Payee State,Payee Zip,Payee Type,Amount($),CF ID,Committee Name,Expense Category,Expense Purpose,Expense Method,Filing Period,Fixed Asset,",
  `7/02/2026,Example Vendor,3 Example Rd,,Hockessin,DE,19707,Business/Group/Organization,300.0000,${CF_ID},Jane Example for Delaware,Media,Ads,Check,2026 30 Day General,No,`,
].join("\r\n");

const FILED_REPORTS_HTML = `<script>jQuery('#Grid').tGrid({columns:[], pageSize:15, total:1});</script>
<table><thead><tr><th>Filing Period</th></tr></thead><tbody>
<tr><td>2026 30 Day 2026 General Election 11/03/2026</td><td> <a onclick=downloadReport(&#39;Report_${MEMBER_ID}_900_abc.pdf&#39;,&#39;${MEMBER_ID}&#39;,&#39;900&#39;) > Original Financial Statement </a> </td><td>${CF_ID}</td><td>Jane Example for Delaware</td><td>Candidate Committee</td><td>10/06/2026</td><td>2026</td><td>(Attorney General)</td><td>Active</td></tr>
</tbody></table>`;

function registryJson(cfId = CF_ID) {
  return {
    data: [
      {
        MemberID: MEMBER_ID,
        Committee_Id: cfId,
        CommitteeName: "Jane Example for Delaware",
        CommitteeTypeCode: "01",
        CommitteeType: "Candidate Committee",
        CommitteeStatus: "Active",
        OfficeSought: "",
        DistrictName: "",
        County: "",
        RegisteredDateStr: "1/1/2026",
        Formtype: "SO",
      },
    ],
    total: 1,
  };
}

function searchResultsHtml(total: number): Response {
  return html(
    `<script>jQuery('#Grid').tGrid({columns:[], pageSize:15, total:${total}, currentPage:1});</script>`
  );
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function csv(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment" },
  });
}
function pdf(): Response {
  return new Response("%PDF-1.4 test", { status: 200, headers: { "Content-Type": "application/pdf" } });
}

type Scripted = { match: (url: string, body: string | undefined) => boolean; response: () => Response };

function scriptedFetch(script: Scripted[]): {
  fetchImpl: DelawareCfrsFetchFn;
  requests: { url: string; body: string | undefined }[];
} {
  const requests: { url: string; body: string | undefined }[] = [];
  const remaining = [...script];
  const fetchImpl: DelawareCfrsFetchFn = (url, init) => {
    requests.push({ url, body: init.body });
    const next = remaining.shift();
    if (next === undefined || !next.match(url, init.body)) {
      throw new Error(`unexpected request #${requests.length}: ${url} body=${init.body ?? ""}`);
    }
    return Promise.resolve(next.response());
  };
  return { fetchImpl, requests };
}

/** The full happy-path exchange; individual tests splice in failures. */
function happyScript(): Scripted[] {
  return [
    {
      match: (url, body) => url.includes("/Public/ViewCommittees") && body === undefined,
      response: () => html("<html>form</html>"),
    },
    { match: (url) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
    { match: (url) => url.includes("/Public/_ViewCommittees"), response: () => json(registryJson()) },
    {
      match: (url, body) => new URL(url).pathname === "/Public/ViewReceiptsMain" && body === undefined,
      response: () => html("<html>form</html>"),
    },
    {
      match: (url, body) => new URL(url).pathname === "/Public/ViewReceipts" && body !== undefined,
      response: () => searchResultsHtml(2),
    },
    { match: (url) => url.includes("/Public/ExportCSVNew"), response: () => csv(RECEIPTS_CSV) },
    {
      match: (url, body) => url.includes("/Public/ViewExpenses") && body === undefined,
      response: () => html("<html>form</html>"),
    },
    {
      match: (url, body) =>
        url.includes("/Public/OtherSearch") &&
        [
          "CommitteeType",
          "FilingYear",
          "FilingPeriodName",
          "ddlPayeeType",
          "ddlState",
          "ddlExpenCategory",
          "ddlExpensePurpose",
        ].every((field) => new URLSearchParams(body).has(field)),
      response: () => searchResultsHtml(1),
    },
    { match: (url) => url.includes("/Public/ExportExpensestoCsv"), response: () => csv(EXPENSES_CSV) },
    {
      match: (url, body) => url.includes("/Public/ViewFiledReports") && body === undefined,
      response: () => html("<html>form</html>"),
    },
    {
      match: (url, body) => url.includes("/Public/ViewFiledReports") && body !== undefined,
      response: () => html("<html>results</html>"),
    },
    { match: (url) => url.includes("/Public/_ViewFiledReports"), response: () => html(FILED_REPORTS_HTML) },
    { match: (url) => url.includes("/Public/FiledReports"), response: () => pdf() },
  ];
}

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "de-cfrs-acquire-"));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const sessionOptions = { sleep: () => Promise.resolve(), spacingMs: 0 } as const;

function acquire(fetchImpl: DelawareCfrsFetchFn) {
  return acquireDelawareCfrsCommitteeArtifacts({
    cfId: CF_ID,
    cacheDir,
    sessionOptions: { ...sessionOptions, fetchImpl },
    retrievedAt: new Date("2026-08-28T00:00:00.000Z"),
    log: () => {},
  });
}

describe("acquireDelawareCfrsCommitteeArtifacts", () => {
  it("fetches the full artifact set and commits a readable bundle", async () => {
    const { fetchImpl, requests } = scriptedFetch(happyScript());
    const result = await acquire(fetchImpl);
    expect(result).toMatchObject({
      committeeName: "Jane Example for Delaware",
      receiptRowCount: 2,
      expenseRowCount: 1,
      filedReportCount: 1,
      reportPdfCount: 1,
    });
    expect(result.manifest.memberId).toBe(MEMBER_ID);
    expect(result.manifest.receiptsSearchTotal).toBe(2);
    expect(result.manifest.expensesSearchTotal).toBe(1);

    // The receipts search POST carried the registry identity.
    const receiptsSearch = requests.find((request) =>
      (request.body ?? "").includes("txtReceivingRegistrant=")
    );
    expect(receiptsSearch?.body).toContain(`MemberId=${MEMBER_ID}`);
    // A legacy ViewReceipts GET leaves the native ledger uninitialized.
    const receiptsRequests = requests.filter((request) =>
      new URL(request.url).pathname.startsWith("/Public/ViewReceipts")
    );
    expect(new URL(receiptsRequests[0]!.url).pathname).toBe("/Public/ViewReceiptsMain");
    expect(receiptsRequests[0]!.body).toBeUndefined();
    expect(new URL(receiptsRequests[1]!.url).pathname).toBe("/Public/ViewReceipts");
    const expenseSearch = requests.find((request) => new URL(request.url).pathname === "/Public/OtherSearch");
    const expenseFields = new URLSearchParams(expenseSearch?.body);
    for (const field of [
      "CommitteeType",
      "FilingYear",
      "FilingPeriodName",
      "ddlPayeeType",
      "ddlState",
      "ddlExpenCategory",
      "ddlExpensePurpose",
    ]) {
      expect(expenseFields.get(field)).toBe("");
    }
    // PDF download carried the acquisition MemberID + FilingCalendarID.
    expect(requests.at(-1)?.url).toContain(`CommitteeID=${MEMBER_ID}`);
    expect(requests.at(-1)?.url).toContain("FilingCalendarID=900");

    const stored = await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID });
    expect(stored.receiptRows).toHaveLength(2);
    expect(stored.expenseRows).toHaveLength(1);
    expect(stored.filedReportRows).toHaveLength(1);
    expect(stored.reportPdfs[0]).toMatchObject({ filingCalendarId: 900 });
  });

  it("re-POSTs a search that renders the transient total:0", async () => {
    const script = happyScript();
    // Splice a transient-zero render before the real receipts search result.
    script.splice(4, 0, {
      match: (url, body) => url.includes("/Public/ViewReceipts") && body !== undefined,
      response: () => searchResultsHtml(0),
    });
    const { fetchImpl, requests } = scriptedFetch(script);
    const result = await acquire(fetchImpl);
    expect(result.receiptRowCount).toBe(2);
    const receiptsSearchPosts = requests.filter(
      (request) => request.url.includes("/Public/ViewReceipts") && request.body !== undefined
    );
    expect(receiptsSearchPosts).toHaveLength(2);
  });

  it("rejects the bundle when CSV rows disagree with the rendered total, leaving no cache entry", async () => {
    const script = happyScript();
    script[4] = {
      match: (url, body) => url.includes("/Public/ViewReceipts") && body !== undefined,
      response: () => searchResultsHtml(3),
    };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(
      /receipts CSV rows \(2\) != rendered search total \(3\)/
    );
    await expect(readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID })).rejects.toThrow(
      /No Delaware CFRS artifact bundle cached/
    );
  });

  it("fails closed when an export answers HTML instead of CSV", async () => {
    const script = happyScript();
    script[5] = {
      match: (url) => url.includes("/Public/ExportCSVNew"),
      response: () => html("<html>Session expired</html>"),
    };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(/receipts export answered HTML/);
  });

  it("fails closed when the registry has no row for the CF_ID", async () => {
    const script = happyScript().slice(0, 3);
    script[2] = {
      match: (url) => url.includes("/Public/_ViewCommittees"),
      response: () => json(registryJson("01000001")),
    };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(/no CFRS type-01 registry row carries CF_ID 01009999/);
  });

  it("fails closed when a report download is not a PDF", async () => {
    const script = happyScript();
    script[12] = {
      match: (url) => url.includes("/Public/FiledReports"),
      response: () => html("<html>error</html>"),
    };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(/not a PDF/);
    await expect(readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID })).rejects.toThrow(
      /No Delaware CFRS artifact bundle cached/
    );
  });

  it("fails closed when the filed-reports grid renders no total or a document-less row", async () => {
    const noTotal = happyScript();
    noTotal[11] = {
      match: (url) => url.includes("/Public/_ViewFiledReports"),
      response: () => html(FILED_REPORTS_HTML.replace(", total:1", "")),
    };
    await expect(acquire(scriptedFetch(noTotal).fetchImpl)).rejects.toThrow(
      /filed-reports grid rendered no total/
    );

    const noDocument = happyScript().slice(0, 12);
    noDocument[11] = {
      match: (url) => url.includes("/Public/_ViewFiledReports"),
      response: () =>
        html(
          FILED_REPORTS_HTML.replace(/<a onclick=downloadReport[^<]*<\/a>/, "Original Financial Statement")
        ),
    };
    await expect(acquire(scriptedFetch(noDocument).fetchImpl)).rejects.toThrow(/has no document link/);
  });

  it("fails loudly when the registry page cap ends the sweep with a full last page", async () => {
    const fullPage = {
      data: Array.from({ length: 500 }, (_, index) => ({
        ...registryJson("01000001").data[0]!,
        MemberID: 700000 + index,
      })),
      total: 99_999,
    };
    const script: Scripted[] = [
      {
        match: (url, body) => url.includes("/Public/ViewCommittees") && body === undefined,
        response: () => html("<html>form</html>"),
      },
      { match: (url) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
      ...Array.from({ length: 40 }, (): Scripted => ({
        match: (url) => url.includes("/Public/_ViewCommittees"),
        response: () => json(fullPage),
      })),
    ];
    await expect(acquire(scriptedFetch(script).fetchImpl)).rejects.toThrow(/40-page cap without exhausting/);
  });

  it("rejects a mis-scoped receipts export before caching", async () => {
    const script = happyScript();
    script[5] = {
      match: (url) => url.includes("/Public/ExportCSVNew"),
      response: () => csv(RECEIPTS_CSV.replaceAll(CF_ID, "01000001")),
    };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(/receipts export carries CF_ID 01000001/);
  });
});

const packetName = "Jane Example for Delaware";
const packetFile = `CampaignFinanceReport_Prelim_${MEMBER_ID}_900_00000000-0000-4000-8000-000000000001.pdf`;
const packetReports = FILED_REPORTS_HTML.replace(`Report_${MEMBER_ID}_900_abc.pdf`, packetFile);
function nativeReceipt(id = 1, date = "2026-06-30") {
  return {
    ...Object.fromEntries(DELAWARE_NATIVE_RECEIPT_FIELDS.map((k) => [k, ""])),
    Transaction_id: id,
    TransactionDate: `/Date(${Date.parse(date + "T12:00:00Z")})/`,
    ContributionAmount: 500,
    ContributorName: "Jane Donor",
    ContributorType: "Individual",
    ContributionType: "Check",
    WC_ID: CF_ID,
    ReceivingCommitteeName: packetName,
    FilingPeriodName: "2026 30 Day General",
    District: "(Attorney General)",
    AddressLine1: "1 Example St",
    City: "Wilmington",
    State_Code: "DE",
    Zip_Code: "19801",
    Fixed_Asset: "No",
    FileAmendedVersion: "30 Jun 2026 Version 1.0",
    EmployerAddress: null,
    EmployerAddressLine1: null,
    Fund_Type: null,
  };
}
function nativeExpense() {
  return {
    ...Object.fromEntries(DELAWARE_NATIVE_EXPENSE_FIELDS.map((k) => [k, ""])),
    Transaction_Id: 2,
    TransactionDate: `/Date(${Date.parse("2026-07-01T12:00:00Z")})/`,
    ExpenseAmount: 300,
    PayeeName: "Vendor",
    PayeeType: "Individual",
    ExpenseMethod: "Check",
    ExpenseCategory: "Media",
    ExpensePurpose: "Ads",
    RegistrantName: packetName,
    CCF_ID: CF_ID,
    AddressLine1: "2 Example Rd",
    City: "Dover",
    State: "DE",
    ZipCode: "19901",
    FilingPeriodName: "2026 30 Day General",
    Fixed_Asset: "No",
    FileAmendedVersion: "1 Jul 2026 Version 1.0",
    District: null,
    FilingYear: null,
    CommitteeID: null,
    Comments: null,
    Fund_Type: null,
  };
}
function packetCsv(rows: Record<string, unknown>[], kind: "receipts" | "expenses") {
  const decodedRows = Array.from(
    { length: Math.ceil(rows.length / 500) },
    (_, i) =>
      (kind === "receipts" ? decodeDelawareReceiptNativePage : decodeDelawareExpenseNativePage)(
        JSON.stringify({ data: rows.slice(i * 500, (i + 1) * 500), total: 0 })
      ).rows
  ).flat();
  const columns = kind === "receipts" ? DELAWARE_RECEIPT_CSV_COLUMNS : DELAWARE_EXPENSE_CSV_COLUMNS;
  const dateKey = kind === "receipts" ? "Contribution Date" : "Expenditure Date";
  const amountKey = kind === "receipts" ? "Contribution Amount" : "Amount($)";
  return [
    columns.join(",") + ",",
    ...decodedRows.map((r) => {
      const p = (
        kind === "receipts" ? projectDelawareNativeReceiptCsvRow : projectDelawareNativeExpenseCsvRow
      )(r);
      return columns
        .map((k) =>
          k === dateKey
            ? `${p[k]!.slice(5, 7)}/${p[k]!.slice(8, 10)}/${p[k]!.slice(0, 4)}`
            : k === amountKey
              ? (Number(p[k]) / 100).toFixed(4)
              : p[k]
        )
        .join(",");
    }),
  ].join("\r\n");
}
function packetRegistry() {
  return {
    data: [
      { ...registryJson().data[0], MemberVersID: 7, Formtype: "SO", sourceUnknownField: "retained" },
      { ...registryJson().data[0], MemberVersID: 2, Formtype: "FF", sourceUnknownField: "historical" },
    ],
    total: 2,
  };
}
const observedSoo = `<a href='/Public/ShowReview?memberID=${MEMBER_ID} &memVersID=7 &cTypeCode=01 &ftype=SO &fpath= &fname= &isPublic=true'>${packetName}</a>`;
function packetScript(): Scripted[] {
  const get = (route: string, response: () => Response): Scripted => ({
    match: (u, b) => new URL(u).pathname === route && b === undefined,
    response,
  });
  const post = (route: string, response: () => Response): Scripted => ({
    match: (u, b) => new URL(u).pathname === route && b !== undefined,
    response,
  });
  return [
    get("/Public/ViewCommittees", () => html("form")),
    post("/Public/Search", () => html(observedSoo)),
    post("/Public/_ViewCommittees", () => json(packetRegistry())),
    get("/Public/ShowReview", () => html("published SO")),
    get("/Public/ViewFiledReports", () => html("form")),
    post("/Public/ViewFiledReports", () => html("results")),
    get("/Public/_ViewFiledReports", () => html(packetReports)),
    get("/Public/ViewFiledReports", () => html("form")),
    post("/Public/ViewFiledReports", () => html("results")),
    get("/Public/_ViewFiledReports", () => html(packetReports)),
    get("/Public/FiledReports", () => pdf()),
    get("/Public/ViewReceiptsMain", () => html("form")),
    post("/Public/ViewReceipts", () => searchResultsHtml(1)),
    post("/Public/_ViewReceiptsCustom", () => json({ data: [nativeReceipt()], total: 99999 })),
    get("/Public/ExportCSVNew", () => csv(packetCsv([nativeReceipt()], "receipts"))),
    get("/Public/ViewExpenses", () => html("form")),
    post("/Public/OtherSearch", () => searchResultsHtml(1)),
    post("/Public/_ViewExpensesCustom", () => json({ data: [nativeExpense()], total: 0 })),
    get("/Public/ExportExpensestoCsv", () => csv(packetCsv([nativeExpense()], "expenses"))),
  ];
}
function packetInput(
  fetchImpl: DelawareCfrsFetchFn,
  observer?: (c: DelawareCfrsResponseCapture) => void | Promise<void>
) {
  return {
    cfId: CF_ID,
    memberId: MEMBER_ID,
    committeeName: packetName,
    requestWindow: { start: "2023-01-01", end: "2026-12-31" },
    sessionOptions: { ...sessionOptions, fetchImpl, maxAttempts: 1, onResponseCapture: observer },
  };
}
describe("Delaware candidate source packet transport", () => {
  it("fetches exact scoped complete native/CSV facts, all source versions and actual SO href without current/money claims or cache writes", async () => {
    const { fetchImpl, requests } = scriptedFetch(packetScript());
    const start = Date.now();
    const r = await fetchDelawareCfrsCandidateSourcePacket(packetInput(fetchImpl));
    expect(r.receipts.rows).toHaveLength(1);
    expect(r.expenses.rows).toHaveLength(1);
    expect(r.registryRows).toHaveLength(2);
    expect(r.registryRows[1]!.MemberVersID).toBe(2);
    expect(r.registryRows[0]!.sourceUnknownField).toBe("retained");
    expect(new URL(r.organizationUrls[0]!).searchParams.get("memVersID")).toBe("7");
    expect(r.allVersionReportRows).toHaveLength(1);
    expect(r.latestAccountReportRows).toHaveLength(1);
    expect(r.reportPdfs).toHaveLength(1);
    expect(r.sourceCaptures).toHaveLength(requests.length);
    expect(
      r.sourceCaptures.every(
        (c) =>
          Date.parse(c.startedAt) >= start &&
          Date.parse(c.completedAt) <= Date.now() &&
          c.requestScopeRedacted === false
      )
    ).toBe(true);
    expect(r).not.toHaveProperty("verified");
    expect(r).not.toHaveProperty("current");
    for (const route of ["/Public/ViewReceipts", "/Public/OtherSearch"]) {
      const fields = new URLSearchParams(requests.find((q) => new URL(q.url).pathname === route)!.body);
      expect(fields.get("dtStartDate")).toBe("01/01/2023");
      expect(fields.get("dtEndDate")).toBe("12/31/2026");
      expect(fields.get("FilingYear")).toBe("");
      expect(fields.get("FilingPeriodName")).toBe("");
    }
    const reports = requests.filter((q) => new URL(q.url).pathname === "/Public/ViewFiledReports" && q.body);
    expect(new URLSearchParams(reports[0]!.body).get("hdnViewCurrent")).toBe("");
    expect(new URLSearchParams(reports[1]!.body).get("chkViewCurrReport")).toBe("on");
    await expect(readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID })).rejects.toThrow(
      /No Delaware/
    );
  });
  it("retains every genuine HTTP retry and isolates observers from the returned journal and parsers", async () => {
    const script = packetScript();
    script.splice(13, 0, { ...script[13]!, response: () => new Response("temporary", { status: 503 }) });
    const seen: DelawareCfrsResponseCapture[] = [];
    const input = packetInput(scriptedFetch(script).fetchImpl, (c) => {
      seen.push(c);
      c.body.fill(0);
      if (c.financeFields) (c.financeFields as Record<string, string>).page = "99";
    });
    input.sessionOptions.maxAttempts = 2;
    const r = await fetchDelawareCfrsCandidateSourcePacket(input);
    expect(r.sourceCaptures).toHaveLength(20);
    expect(r.sourceCaptures.find((c) => c.status === 503)!.body.toString()).toBe("temporary");
    const native = r.sourceCaptures.filter((c) => new URL(c.url).pathname === "/Public/_ViewReceiptsCustom");
    expect(native.map((c) => c.attempt)).toEqual([1, 2]);
    expect(native[1]!.financeFields!.page).toBe("1");
    expect(seen[0]!.body.every((x) => x === 0)).toBe(true);
    expect(r.sourceCaptures[0]!.body.toString()).toBe("form");
  });
  it("propagates capture failure without retrying or fetching later facets", async () => {
    const { fetchImpl, requests } = scriptedFetch(packetScript());
    await expect(
      fetchDelawareCfrsCandidateSourcePacket(
        packetInput(fetchImpl, () => {
          throw new Error("journal unavailable");
        })
      )
    ).rejects.toMatchObject({ code: "capture_error" });
    expect(requests).toHaveLength(1);
  });
  it("snapshots request bounds and callback/options before the first async request", async () => {
    const { fetchImpl, requests } = scriptedFetch(packetScript());
    let captures = 0;
    const input = packetInput(fetchImpl, () => {
      captures++;
    });
    const pending = fetchDelawareCfrsCandidateSourcePacket(input);
    input.requestWindow.start = "1999-01-01";
    input.committeeName = "other";
    input.sessionOptions.onResponseCapture = () => {
      throw new Error("mutated callback");
    };
    const r = await pending;
    expect(r.requestWindow.start).toBe("2023-01-01");
    expect(captures).toBe(requests.length);
  });
  it("closes multi-page source identity with only the proved exact boundary overlap while retaining equal distinct gift IDs", async () => {
    const script = packetScript();
    const rows = Array.from({ length: 520 }, (_, i) => nativeReceipt(i + 1));
    script[12] = { ...script[12]!, response: () => searchResultsHtml(520) };
    script[13] = { ...script[13]!, response: () => json({ data: rows.slice(0, 500), total: 0 }) };
    script[14] = { ...script[14]!, response: () => csv(packetCsv(rows, "receipts")) };
    script.splice(14, 0, {
      match: (u, b) =>
        new URL(u).pathname === "/Public/_ViewReceiptsCustom" && new URLSearchParams(b).get("page") === "2",
      response: () => json({ data: rows.slice(499), total: 7 }),
    });
    const r = await fetchDelawareCfrsCandidateSourcePacket(packetInput(scriptedFetch(script).fetchImpl));
    expect(r.receipts.rows).toHaveLength(520);
    expect(r.receipts.physicalRowCount).toBe(521);
    expect(r.receipts.transportOverlapCount).toBe(1);
  });
  it.each([
    "invented_so",
    "registry_owner",
    "registry_count",
    "report_count",
    "wrong_report_owner",
    "non_pdf",
    "wrong_native_account",
    "out_of_window",
    "native_count",
    "unknown_native_field",
  ])("rejects incomplete or mis-scoped packet %s", async (kind) => {
    const script = packetScript();
    if (kind === "invented_so")
      script[1] = { ...script[1]!, response: () => html(observedSoo.replace("memVersID=7", "memVersID=99")) };
    if (kind === "registry_owner")
      script[2] = {
        ...script[2]!,
        response: () =>
          json({ ...packetRegistry(), data: packetRegistry().data.map((r) => ({ ...r, MemberID: 999 })) }),
      };
    if (kind === "registry_count")
      script[2] = { ...script[2]!, response: () => json({ ...packetRegistry(), total: 3 }) };
    if (kind === "report_count")
      script[6] = { ...script[6]!, response: () => html(packetReports.replace("total:1", "total:501")) };
    if (kind === "wrong_report_owner")
      script[6] = { ...script[6]!, response: () => html(packetReports.replaceAll(CF_ID, "01000001")) };
    if (kind === "non_pdf")
      script[10] = {
        ...script[10]!,
        response: () => new Response("HTML", { headers: { "Content-Type": "application/pdf" } }),
      };
    if (["wrong_native_account", "out_of_window", "unknown_native_field"].includes(kind)) {
      const row = nativeReceipt(1, kind === "out_of_window" ? "2022-01-01" : "2026-06-30");
      if (kind === "wrong_native_account") row.WC_ID = "01000001";
      if (kind === "unknown_native_field") delete (row as Record<string, unknown>).FileAmendedVersion;
      script[13] = { ...script[13]!, response: () => json({ data: [row], total: 0 }) };
      if (kind !== "unknown_native_field")
        script[14] = { ...script[14]!, response: () => csv(packetCsv([row], "receipts")) };
    }
    if (kind === "native_count") script[12] = { ...script[12]!, response: () => searchResultsHtml(2) };
    await expect(
      fetchDelawareCfrsCandidateSourcePacket(packetInput(scriptedFetch(script).fetchImpl))
    ).rejects.toThrow();
  });
  it.each(["2026-02-30", "2026-1-01", "invalid"])(
    "rejects malformed window date %s before any request",
    async (start) => {
      const { fetchImpl, requests } = scriptedFetch(packetScript());
      const input = packetInput(fetchImpl);
      input.requestWindow.start = start;
      await expect(fetchDelawareCfrsCandidateSourcePacket(input)).rejects.toThrow();
      expect(requests).toHaveLength(0);
    }
  );
});

describe("Delaware observed organization editions", () => {
  it("returns every published SO URL without selecting a current numeric/order winner", async () => {
    const script = packetScript();
    script[1] = {
      ...script[1]!,
      response: () => html(observedSoo + observedSoo.replace("memVersID=7", "memVersID=2")),
    };
    script.splice(4, 0, {
      match: (u, b) => new URL(u).pathname === "/Public/ShowReview" && b === undefined,
      response: () => html("published older SO"),
    });
    const r = await fetchDelawareCfrsCandidateSourcePacket(packetInput(scriptedFetch(script).fetchImpl));
    expect(r.organizationUrls.map((u) => new URL(u).searchParams.get("memVersID"))).toEqual(["7", "2"]);
    expect(r).not.toHaveProperty("currentOrganizationUrl");
  });
  it("retains missing observed SO authority as diagnostics rather than inventing a link", async () => {
    const script = packetScript();
    script[1] = { ...script[1]!, response: () => html("no published SO link") };
    script.splice(3, 1);
    const r = await fetchDelawareCfrsCandidateSourcePacket(packetInput(scriptedFetch(script).fetchImpl));
    expect(r.organizationUrls).toEqual([]);
    expect(r.diagnostics.join(" ")).toMatch(/No observed organization links/);
    expect(r.receipts.rows).toHaveLength(1);
  });
});

describe("Delaware packet report pagination", () => {
  it("fetches every actual all-version page and document while retaining the separate latest-account pointer", async () => {
    const script = packetScript();
    const row = /<tr><td>[\s\S]*?<\/tr>/.exec(packetReports)![0];
    const rows = Array.from({ length: 501 }, (_, i) =>
      i === 0
        ? row
        : row
            .replaceAll(packetFile, packetFile.replace("_900_", `_${900 + i}_`))
            .replace("&#39;900&#39;", `&#39;${900 + i}&#39;`)
    );
    const reportPage = (part: string[]) =>
      packetReports
        .replace("total:1", "total:501")
        .replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${part.join("")}</tbody>`);
    script[6] = { ...script[6]!, response: () => html(reportPage(rows.slice(0, 500))) };
    script.splice(7, 0, {
      match: (u, b) =>
        new URL(u).pathname === "/Public/_ViewFiledReports" &&
        new URL(u).searchParams.get("Grid-page") === "2" &&
        b === undefined,
      response: () => html(reportPage(rows.slice(500))),
    });
    const downloads = Array.from({ length: 501 }, (): Scripted => ({
      match: (u, b) => new URL(u).pathname === "/Public/FiledReports" && b === undefined,
      response: () => pdf(),
    }));
    script.splice(11, 1, ...downloads);
    const r = await fetchDelawareCfrsCandidateSourcePacket(packetInput(scriptedFetch(script).fetchImpl));
    expect(r.allVersionReportRows).toHaveLength(501);
    expect(r.latestAccountReportRows).toHaveLength(1);
    expect(r.reportPdfs).toHaveLength(501);
    expect(new Set(r.reportPdfs.map((p) => p.publicReportFileName)).size).toBe(501);
  });
});
