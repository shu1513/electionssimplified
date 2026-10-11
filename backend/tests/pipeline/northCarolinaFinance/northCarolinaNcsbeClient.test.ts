import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createNcsbeTransport,
  extractNcsbeAntiForgeryToken,
  fetchNcsbeReceiptPages,
  ncsbeCommitteeSearchUrl,
  ncsbeCsvExportUrl,
  ncsbeDocumentInventoryUrl,
  ncsbeExpendituresUrl,
  ncsbeIeDocTypeInventoryUrl,
  ncsbeReceiptsUrl,
  ncsbeReportDetailUrl,
  ncsbeTransactionForm,
  type NcsbeFetchFn,
  type NcsbeFormBody,
  type NcsbeTransport,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/northCarolinaFinance/${name}`, import.meta.url)),
    "utf8"
  );
}

function transactionBody(recordCount: number, rowCount: number, startIndex = 0): string {
  const results = Array.from({ length: rowCount }, (_, index) => ({
    GroupID: startIndex + index + 1,
    OccurDate: "01/02/2026",
    OrgName: `Donor ${startIndex + index + 1}`,
    IsOrg: false,
    Amount: 25,
    SumToDate: 25,
    Profession: "",
    EmployersName: "",
    IsAggregated: false,
    ReceiptTypeDesc: "Individual Contribution",
    ReceiptTypeCode: "IND ",
    AccountAbbr: "1",
    FormOfPaymentDesc: "Check",
    Purpose: null,
  }));
  return JSON.stringify({
    ContentEncoding: null,
    ContentType: null,
    Data: { recordCountKey: recordCount, responseDataKey: "results", results },
    JsonRequestBehavior: 1,
    MaxJsonLength: null,
    RecursionLimit: null,
  });
}

describe("NCSBE url builders", () => {
  it("builds the exact routes the spike verified", () => {
    expect(ncsbeCommitteeSearchUrl("gadson")).toBe(
      "https://cf.ncsbe.gov/CFOrgLkup/CommitteeGeneralResult/?name=gadson&useOrgName=True&useCandName=True&useInHouseName=True&useAcronym=False"
    );
    expect(ncsbeDocumentInventoryUrl({ orgGroupId: 57190, sboeId: "STA-JV516O-C-001" })).toBe(
      "https://cf.ncsbe.gov/CFOrgLkup/DocumentGeneralResult/?OGID=57190&SID=STA-JV516O-C-001"
    );
    expect(ncsbeReportDetailUrl("229931")).toBe("https://cf.ncsbe.gov/CFOrgLkup/ReportDetail/?RID=229931&TP=ALL");
    expect(ncsbeReceiptsUrl("229931")).toBe(
      "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?rid=229931&handler=ReadReceipts"
    );
    expect(ncsbeExpendituresUrl("232624")).toBe(
      "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?rid=232624&handler=ReadExpenditures"
    );
    expect(ncsbeCsvExportUrl("229931", "Gadson Q1")).toBe(
      "https://cf.ncsbe.gov/CFOrgLkup/ExportDetailResults/?ReportID=229931&Type=ALL&Title=Gadson%20Q1"
    );
  });

  it("sends the 1-based wire page and the token in the POST form", () => {
    expect(ncsbeTransactionForm(0, "tok")).toEqual({
      page: "1",
      pageSize: "300",
      __RequestVerificationToken: "tok",
    });
    expect(ncsbeTransactionForm(2, "tok").page).toBe("3");
    expect(() => ncsbeTransactionForm(0, " ")).toThrow(/needs an anti-forgery token/);
  });

  it("reads the anti-forgery token from the redesigned report page", () => {
    expect(extractNcsbeAntiForgeryToken(fixture("report-cover-redesign-900001.html"))).toBe("test-antiforgery-token");
    expect(() => extractNcsbeAntiForgeryToken("<html></html>")).toThrow(/no anti-forgery token/);
  });

  it("single-quotes the IE doc-type codes — the unquoted form is an error page", () => {
    expect(ncsbeIeDocTypeInventoryUrl(2026)).toBe(
      "https://cf.ncsbe.gov/CFDocLkup/DocumentResult/?year=2026&reports=%27IRIEX%27,%27IRCIX%27,%27RPIER%27"
    );
  });

  it("rejects malformed report ids and years", () => {
    expect(() => ncsbeReportDetailUrl("229931; DROP")).toThrow(/Invalid NCSBE report id/);
    expect(() => ncsbeIeDocTypeInventoryUrl(1888)).toThrow(/Invalid NCSBE year/);
  });
});

describe("createNcsbeTransport", () => {
  it("serializes requests and spaces every request after the first", async () => {
    const events: string[] = [];
    const fetchFn: NcsbeFetchFn = async (url) => {
      events.push(`fetch ${url}`);
      return { status: 200, body: "ok" };
    };
    const transport = createNcsbeTransport({
      fetch: fetchFn,
      sleep: async (ms) => {
        events.push(`sleep ${ms}`);
      },
      spacingMs: 2_000,
    });
    // Fired concurrently on purpose — the transport must still run them one
    // at a time, in order (decision 10: one request in flight).
    await Promise.all([transport.fetchText("u1"), transport.fetchText("u2"), transport.fetchText("u3")]);
    expect(events).toEqual(["fetch u1", "sleep 2000", "fetch u2", "sleep 2000", "fetch u3"]);
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const statuses = [429, 500, 200];
    const sleeps: number[] = [];
    const transport = createNcsbeTransport({
      fetch: async () => ({ status: statuses.shift()!, body: "body" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      spacingMs: 2_000,
      retryBackoffMs: 100,
    });
    expect(await transport.fetchText("u")).toBe("body");
    // No sleep before the very first request; growing backoff per retry.
    expect(sleeps).toEqual([200, 300]);
  });

  it("gives up after bounded attempts", async () => {
    let calls = 0;
    const transport = createNcsbeTransport({
      fetch: async () => {
        calls += 1;
        return { status: 503, body: "" };
      },
      sleep: async () => {},
      maxAttempts: 3,
    });
    await expect(transport.fetchText("u")).rejects.toThrow(/failed after 3 attempts/);
    expect(calls).toBe(3);
  });

  it("fails a non-retryable status immediately", async () => {
    let calls = 0;
    const transport = createNcsbeTransport({
      fetch: async () => {
        calls += 1;
        return { status: 404, body: "" };
      },
      sleep: async () => {},
    });
    await expect(transport.fetchText("u")).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  it("keeps serving after a failed request", async () => {
    let calls = 0;
    const transport = createNcsbeTransport({
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return { status: 404, body: "" };
        }
        return { status: 200, body: "ok" };
      },
      sleep: async () => {},
    });
    await expect(transport.fetchText("bad")).rejects.toThrow(/HTTP 404/);
    expect(await transport.fetchText("good")).toBe("ok");
  });
});

// Hands the handler the 0-based cache page decoded from the POST form.
function directTransport(handler: (page: number, url: string, form?: NcsbeFormBody) => string): NcsbeTransport {
  return { fetchText: async (url, form) => handler(Number(form?.page) - 1, url, form) };
}

describe("fetchNcsbeReceiptPages", () => {
  it("fetches a single-page report whole", async () => {
    const body = fixture("receipts-gadson-229931-p0.json");
    const requests: Array<{ url: string; form?: NcsbeFormBody }> = [];
    const result = await fetchNcsbeReceiptPages(
      directTransport((_page, url, form) => {
        requests.push({ url, form });
        return body;
      }),
      "229931",
      "tok"
    );
    expect(requests).toEqual([
      {
        url: "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?rid=229931&handler=ReadReceipts",
        form: { page: "1", pageSize: "300", __RequestVerificationToken: "tok" },
      },
    ]);
    expect(result.recordCount).toBe(19);
    expect(result.rows).toHaveLength(19);
    expect(result.pages).toHaveLength(1);
  });

  it("pages until the row count equals recordCountKey (fixed 300-row pages)", async () => {
    const result = await fetchNcsbeReceiptPages(
      directTransport((page) => {
        if (page === 0) return transactionBody(335, 300, 0);
        return transactionBody(335, 35, 300);
      }),
      "1",
      "tok"
    );
    expect(result.recordCount).toBe(335);
    expect(result.rows).toHaveLength(335);
    expect(result.pages.map((page) => page.rowCount)).toEqual([300, 35]);
  });

  it("accepts an empty report (recordCountKey 0)", async () => {
    const result = await fetchNcsbeReceiptPages(directTransport(() => transactionBody(0, 0)), "1", "tok");
    expect(result.recordCount).toBe(0);
    expect(result.rows).toHaveLength(0);
    expect(result.pages).toHaveLength(1);
  });

  it("fails closed when a page is empty before the count is reached", async () => {
    await expect(
      fetchNcsbeReceiptPages(
        directTransport((page) => {
          if (page === 0) return transactionBody(400, 300, 0);
          // The server claims 400 rows but serves nothing more.
          return transactionBody(400, 0, 300);
        }),
        "1",
        "tok"
      )
    ).rejects.toThrow(/page 1 returned 0 rows, expected 100 under the fixed 300-row page contract/);
  });

  it("fails closed when recordCountKey drifts mid-fetch", async () => {
    await expect(
      fetchNcsbeReceiptPages(
        directTransport((page) => {
          if (page === 0) return transactionBody(400, 300, 0);
          return transactionBody(500, 100, 300);
        }),
        "1",
        "tok"
      )
    ).rejects.toThrow(/recordCountKey changed mid-fetch \(400 -> 500 on page 1\)/);
  });

  it("fails closed on an overshoot", async () => {
    await expect(
      fetchNcsbeReceiptPages(directTransport(() => transactionBody(250, 300)), "1", "tok")
    ).rejects.toThrow(/page 0 returned 300 rows, expected 250 under the fixed 300-row page contract/);
  });

  it("rejects a non-final page shorter than the fixed 300-row contract", async () => {
    // 400 rows served as 100-row pages would satisfy pure completeness but
    // break every downstream ceil(recordCountKey / 300) page enumeration —
    // the pinned page layout is part of the contract, so it fails closed.
    await expect(
      fetchNcsbeReceiptPages(
        directTransport((page) => {
          return transactionBody(400, 100, page * 100);
        }),
        "1",
        "tok"
      )
    ).rejects.toThrow(/page 0 returned 100 rows, expected 300 under the fixed 300-row page contract/);
  });

  it("fails closed on an HTML error body", async () => {
    await expect(
      fetchNcsbeReceiptPages(directTransport(() => "<html>An error occurred</html>"), "1", "tok")
    ).rejects.toThrow(/does not parse/);
  });

  it("fails closed on an absurd recordCountKey instead of paging for hours", async () => {
    await expect(
      fetchNcsbeReceiptPages(directTransport(() => transactionBody(5_000_000, 300)), "1", "tok")
    ).rejects.toThrow(/recordCountKey 5000000 exceeds the sanity ceiling/);
  });
});
