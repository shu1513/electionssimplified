import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DelawareCfrsFetchFn } from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import { acquireDelawareCfrsCommitteeArtifacts } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactAcquisition.js";
import { readDelawareCfrsCommitteeArtifacts } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactCache.js";

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
  return html(`<script>jQuery('#Grid').tGrid({columns:[], pageSize:15, total:${total}, currentPage:1});</script>`);
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
    { match: (url, body) => url.includes("/Public/ViewCommittees") && body === undefined, response: () => html("<html>form</html>") },
    { match: (url) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
    { match: (url) => url.includes("/Public/_ViewCommittees"), response: () => json(registryJson()) },
    { match: (url, body) => new URL(url).pathname === "/Public/ViewReceiptsMain" && body === undefined, response: () => html("<html>form</html>") },
    { match: (url, body) => new URL(url).pathname === "/Public/ViewReceipts" && body !== undefined, response: () => searchResultsHtml(2) },
    { match: (url) => url.includes("/Public/ExportCSVNew"), response: () => csv(RECEIPTS_CSV) },
    { match: (url, body) => url.includes("/Public/ViewExpenses") && body === undefined, response: () => html("<html>form</html>") },
    {
      match: (url, body) => url.includes("/Public/OtherSearch") &&
        ["CommitteeType", "FilingYear", "FilingPeriodName", "ddlPayeeType", "ddlState", "ddlExpenCategory", "ddlExpensePurpose"]
          .every((field) => new URLSearchParams(body).has(field)),
      response: () => searchResultsHtml(1),
    },
    { match: (url) => url.includes("/Public/ExportExpensestoCsv"), response: () => csv(EXPENSES_CSV) },
    { match: (url, body) => url.includes("/Public/ViewFiledReports") && body === undefined, response: () => html("<html>form</html>") },
    { match: (url, body) => url.includes("/Public/ViewFiledReports") && body !== undefined, response: () => html("<html>results</html>") },
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
    const receiptsSearch = requests.find((request) => (request.body ?? "").includes("txtReceivingRegistrant="));
    expect(receiptsSearch?.body).toContain(`MemberId=${MEMBER_ID}`);
    // A legacy ViewReceipts GET leaves the native ledger uninitialized.
    const receiptsRequests = requests.filter((request) => new URL(request.url).pathname.startsWith("/Public/ViewReceipts"));
    expect(new URL(receiptsRequests[0]!.url).pathname).toBe("/Public/ViewReceiptsMain");
    expect(receiptsRequests[0]!.body).toBeUndefined();
    expect(new URL(receiptsRequests[1]!.url).pathname).toBe("/Public/ViewReceipts");
    const expenseSearch = requests.find((request) => new URL(request.url).pathname === "/Public/OtherSearch");
    const expenseFields = new URLSearchParams(expenseSearch?.body);
    for (const field of ["CommitteeType", "FilingYear", "FilingPeriodName", "ddlPayeeType", "ddlState", "ddlExpenCategory", "ddlExpensePurpose"]) {
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
    await expect(acquire(fetchImpl)).rejects.toThrow(/receipts CSV rows \(2\) != rendered search total \(3\)/);
    await expect(readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID })).rejects.toThrow(
      /No Delaware CFRS artifact bundle cached/
    );
  });

  it("fails closed when an export answers HTML instead of CSV", async () => {
    const script = happyScript();
    script[5] = { match: (url) => url.includes("/Public/ExportCSVNew"), response: () => html("<html>Session expired</html>") };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(/receipts export answered HTML/);
  });

  it("fails closed when the registry has no row for the CF_ID", async () => {
    const script = happyScript().slice(0, 3);
    script[2] = { match: (url) => url.includes("/Public/_ViewCommittees"), response: () => json(registryJson("01000001")) };
    const { fetchImpl } = scriptedFetch(script);
    await expect(acquire(fetchImpl)).rejects.toThrow(/no CFRS type-01 registry row carries CF_ID 01009999/);
  });

  it("fails closed when a report download is not a PDF", async () => {
    const script = happyScript();
    script[12] = { match: (url) => url.includes("/Public/FiledReports"), response: () => html("<html>error</html>") };
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
    await expect(acquire(scriptedFetch(noTotal).fetchImpl)).rejects.toThrow(/filed-reports grid rendered no total/);

    const noDocument = happyScript().slice(0, 12);
    noDocument[11] = {
      match: (url) => url.includes("/Public/_ViewFiledReports"),
      response: () =>
        html(FILED_REPORTS_HTML.replace(/<a onclick=downloadReport[^<]*<\/a>/, "Original Financial Statement")),
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
      { match: (url, body) => url.includes("/Public/ViewCommittees") && body === undefined, response: () => html("<html>form</html>") },
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
