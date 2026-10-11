import { describe, expect, it } from "vitest";

import {
  DELAWARE_CFRS_BASE_URL,
  DELAWARE_CFRS_ERROR_SENTINEL,
  DELAWARE_CFRS_PAGES,
  DelawareCfrsClientError,
  buildDelawareCfrsUrl,
  buildDelawareCommitteeSearchFields,
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
  buildDelawareReceiptsSearchFields,
  createDelawareCfrsSession,
  isDelawareCfrsErrorBody,
  looksLikeDelawareCfrsHtml,
  type DelawareCfrsFetchFn,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function recordingFetch(responses: Response[]): { fetchImpl: DelawareCfrsFetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: DelawareCfrsFetchFn = (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected extra request: ${url}`);
    }
    return Promise.resolve(next);
  };
  return { fetchImpl, requests };
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    ...init,
  });
}

const noSleep = () => Promise.resolve();

describe("delawareCfrsClient", () => {
  it("builds portal URLs with query parameters", () => {
    expect(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsThirdPartyExportCsv)).toBe(
      "https://cfrs.elections.delaware.gov/Public/ExportCSVNew_TP"
    );
    expect(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry)).toBe(
      "https://cfrs.elections.delaware.gov/Public/ViewReceiptsMain"
    );
    expect(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, { theme: "vista" })).toBe(
      "https://cfrs.elections.delaware.gov/Public/ViewReceipts?theme=vista"
    );
    expect(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.findRegistrants, { q: "Meyer for Delaware" })).toBe(
      "https://cfrs.elections.delaware.gov/Public/FindRegistrants?q=Meyer+for+Delaware"
    );
  });

  it("detects the portal rejection sentinel and HTML bodies", () => {
    expect(isDelawareCfrsErrorBody("Unable to process the request.")).toBe(true);
    expect(isDelawareCfrsErrorBody("  Unable to process the request. \n")).toBe(true);
    expect(isDelawareCfrsErrorBody("Contribution Date,Contributor Name")).toBe(false);
    expect(looksLikeDelawareCfrsHtml("<!DOCTYPE HTML PUBLIC")).toBe(true);
    expect(looksLikeDelawareCfrsHtml("<html><body>")).toBe(true);
    expect(looksLikeDelawareCfrsHtml("Contribution Date,Contributor Name")).toBe(false);
  });

  it("pins the full receipts-search field set (a missing field draws the portal rejection)", () => {
    const fields = buildDelawareReceiptsSearchFields({ MemberId: "558171", FilingYear: "2024" });
    expect(fields.btnSearch).toBe("Search");
    expect(fields.MemberId).toBe("558171");
    expect(fields.FilingYear).toBe("2024");
    // Every non-override field posts blank, and the pinned set is complete.
    expect(Object.keys(fields)).toHaveLength(29);
    expect(fields.txtReceivingRegistrant).toBe("");
    expect(fields.hdnTP).toBe("");
    expect(fields.txtAmountRangeFrom).toBe("");
  });

  it("pins the expenses, committee, and filed-reports field sets", () => {
    const expenses = buildDelawareExpensesSearchFields({ MemberId: "558171", CommitteeType: "04", FilingYear: "2026" });
    expect(expenses.Submit).toBe("Search");
    expect(Object.keys(expenses)).toHaveLength(29);
    expect(expenses).toMatchObject({
      CommitteeType: "04", FilingYear: "2026", FilingPeriodName: "",
      ddlPayeeType: "", ddlState: "", ddlExpenCategory: "", ddlExpensePurpose: "",
    });
    // The portal's own misspelling is part of the contract.
    expect(expenses).toHaveProperty("expensePruposeData", "");

    const committees = buildDelawareCommitteeSearchFields({ CommitteeType: "04" });
    expect(committees.btnSearch).toBe("Search");
    expect(committees.CommitteeType).toBe("04");
    expect(Object.keys(committees)).toHaveLength(24);

    const filedReports = buildDelawareFiledReportsSearchFields({ MemberId: "558171" });
    expect(filedReports.btnSearch).toBe("Search");
    expect(Object.keys(filedReports)).toHaveLength(25);
    expect(filedReports.hdnViewCurrent).toBe("");
  });

  it("sends form POSTs with cookies, referer, and the xhr header when asked", async () => {
    const { fetchImpl, requests } = recordingFetch([
      new Response("ok", { status: 200, headers: { "Set-Cookie": "ASP.NET_SessionId=abc123; path=/" } }),
      new Response('{"data":[],"total":0}', { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep });

    await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));
    await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeGridJson, { theme: "vista" }),
      { page: "1", size: "500" },
      { referer: `${DELAWARE_CFRS_BASE_URL}/Public/ViewCommittees`, xhr: true }
    );

    expect(requests).toHaveLength(2);
    const post = requests[1]!;
    expect(post.method).toBe("POST");
    expect(post.headers.Cookie).toBe("ASP.NET_SessionId=abc123");
    expect(post.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(post.headers.Referer).toBe("https://cfrs.elections.delaware.gov/Public/ViewCommittees");
    expect(post.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(post.body).toBe("page=1&size=500");
  });

  it("fails closed on the portal rejection sentinel without retrying", async () => {
    const { fetchImpl, requests } = recordingFetch([htmlResponse("Unable to process the request.")]);
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep });

    await expect(
      session.postForm(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch), { incomplete: "yes" })
    ).rejects.toMatchObject({ code: "portal_rejection" });
    expect(requests).toHaveLength(1);
  });

  it("retries transient failures but not client errors", async () => {
    const { fetchImpl, requests } = recordingFetch([
      new Response("busy", { status: 503 }),
      htmlResponse("<html>fine</html>"),
    ]);
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep });
    const response = await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch));
    expect(response.text()).toBe("<html>fine</html>");
    expect(requests).toHaveLength(2);

    const notFound = recordingFetch([new Response("gone", { status: 404 })]);
    const second = createDelawareCfrsSession({ fetchImpl: notFound.fetchImpl, sleep: noSleep });
    await expect(second.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch))).rejects.toMatchObject({
      code: "http_error",
      status: 404,
    });
    expect(notFound.requests).toHaveLength(1);
  });

  it("returns redirects as data instead of following them", async () => {
    const { fetchImpl } = recordingFetch([
      new Response(null, { status: 302, headers: { Location: "/Public/HandleUnknown" } }),
    ]);
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep });
    const response = await session.postForm(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearch), {});
    expect(response.status).toBe(302);
    expect(response.redirectLocation).toBe("/Public/HandleUnknown");
  });

  it("rejects non-CFRS URLs and oversize responses", async () => {
    const { fetchImpl } = recordingFetch([new Response("x".repeat(64), { status: 200 })]);
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep, maxResponseBytes: 16 });
    await expect(session.get("https://example.com/steal")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch))).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("runs requests single-flight in submission order", async () => {
    const order: string[] = [];
    const fetchImpl: DelawareCfrsFetchFn = async (url) => {
      order.push(`start ${url.slice(-1)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${url.slice(-1)}`);
      return htmlResponse("ok");
    };
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep });
    await Promise.all([
      session.get(`${DELAWARE_CFRS_BASE_URL}/Public/a`),
      session.get(`${DELAWARE_CFRS_BASE_URL}/Public/b`),
    ]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("exposes the error class shape", () => {
    const error = new DelawareCfrsClientError("bad_response", "boom", 200);
    expect(error.name).toBe("DelawareCfrsClientError");
    expect(error.code).toBe("bad_response");
    expect(error.status).toBe(200);
    expect(DELAWARE_CFRS_ERROR_SENTINEL).toBe("Unable to process the request.");
  });
});
