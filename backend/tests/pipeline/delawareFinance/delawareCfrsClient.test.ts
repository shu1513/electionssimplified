import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

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
  isDelawareCfrsPublicReportFileName,
  looksLikeDelawareCfrsHtml,
  type DelawareCfrsFetchFn,
  type DelawareCfrsResponseCapture,
} from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function recordingFetch(responses: Response[]): {
  fetchImpl: DelawareCfrsFetchFn;
  requests: RecordedRequest[];
} {
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
    const expenses = buildDelawareExpensesSearchFields({
      MemberId: "558171",
      CommitteeType: "04",
      FilingYear: "2026",
    });
    expect(expenses.Submit).toBe("Search");
    expect(Object.keys(expenses)).toHaveLength(29);
    expect(expenses).toMatchObject({
      CommitteeType: "04",
      FilingYear: "2026",
      FilingPeriodName: "",
      ddlPayeeType: "",
      ddlState: "",
      ddlExpenCategory: "",
      ddlExpensePurpose: "",
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
    await expect(session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch))).rejects.toMatchObject(
      {
        code: "bad_response",
      }
    );
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

  it("captures original binary bytes, safe scope, genuine times and SHA for each HTTP attempt", async () => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const { fetchImpl, requests } = recordingFetch([
      new Response("busy", { status: 503, headers: { "Content-Type": "text/html" } }),
      new Response(new Uint8Array([0, 255, 128, 65]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    ]);
    const session = createDelawareCfrsSession({
      fetchImpl,
      sleep: noSleep,
      onResponseCapture: (capture) => {
        captures.push(capture);
      },
    });
    const started = Date.now();
    await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsGridJson, { "Grid-size": "15", theme: "vista" }),
      { page: "1", size: "500", MemberId: "458984" }
    );
    const completed = Date.now();
    expect(requests).toHaveLength(2);
    expect(captures.map((capture) => [capture.attempt, capture.status])).toEqual([
      [1, 503],
      [2, 200],
    ]);
    expect(captures[0]?.body.toString()).toBe("busy");
    expect([...captures[1]!.body]).toEqual([0, 255, 128, 65]);
    expect(captures[1]).toMatchObject({
      method: "POST",
      contentType: "application/pdf",
      byteCount: 4,
      financeFields: { page: "1", size: "500", MemberId: "458984" },
      requestScopeRedacted: false,
    });
    for (const capture of captures) {
      expect(capture.sha256).toBe(createHash("sha256").update(capture.body).digest("hex"));
      expect(Date.parse(capture.startedAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(capture.completedAt)).toBeGreaterThanOrEqual(Date.parse(capture.startedAt));
      expect(Date.parse(capture.completedAt)).toBeLessThanOrEqual(completed);
    }
    expect(Date.parse(captures[1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(captures[0]!.completedAt));
  });

  it.each([
    { status: 403, body: "<html>denied</html>" },
    { status: 404, body: "gone" },
    { status: 200, body: "Unable to process the request." },
  ])("captures bounded error body before rejection: %j", async ({ status, body }) => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const { fetchImpl } = recordingFetch([htmlResponse(body, { status })]);
    const session = createDelawareCfrsSession({
      fetchImpl,
      sleep: noSleep,
      maxAttempts: 1,
      onResponseCapture: (capture) => {
        captures.push(capture);
      },
    });
    await expect(session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry))).rejects.toThrow();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ status, byteCount: Buffer.byteLength(body), attempt: 1 });
    expect(captures[0]?.body.toString()).toBe(body);
  });

  it("does not retry or silently replace evidence after observer failure", async () => {
    const failure = new Error("journal unavailable");
    const { fetchImpl, requests } = recordingFetch([
      new Response("busy", { status: 503 }),
      htmlResponse("ok"),
    ]);
    const observer = vi.fn(() => {
      throw failure;
    });
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep, onResponseCapture: observer });
    await expect(session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry))).rejects.toMatchObject({
      code: "capture_error",
      cause: failure,
    });
    expect(requests).toHaveLength(1);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("isolates caller/observer bytes and snapshots the submitted request fields", async () => {
    const original = new Uint8Array([0, 255, 128, 65]);
    const response = new Response(null, { status: 200 });
    response.arrayBuffer = async () => original.buffer;
    let captured: DelawareCfrsResponseCapture | undefined;
    const fields = { MemberId: "458984", FilingYear: "2026" };
    const options = {
      fetchImpl: async () => response,
      sleep: noSleep,
      onResponseCapture: (capture: DelawareCfrsResponseCapture) => {
        captured = capture;
        capture.body[0] = 7;
        original.fill(9);
      },
    };
    const session = createDelawareCfrsSession(options);
    const pending = session.postForm(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch), fields);
    fields.FilingYear = "9999";
    options.onResponseCapture = () => {
      throw new Error("mutated observer");
    };
    const result = await pending;
    expect([...result.body]).toEqual([0, 255, 128, 65]);
    expect(captured?.financeFields).toEqual({ MemberId: "458984", FilingYear: "2026" });
    expect(captured?.sha256).toBe(
      createHash("sha256")
        .update(new Uint8Array([0, 255, 128, 65]))
        .digest("hex")
    );
    result.body[2] = 17;
    expect(captured?.body[2]).toBe(128);
    expect(captured?.body).not.toBe(result.body);
  });

  it("awaits capture before the next queued request starts", async () => {
    const order: string[] = [];
    let release!: () => void;
    let ready!: () => void;
    const firstCapture = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const session = createDelawareCfrsSession({
      sleep: noSleep,
      fetchImpl: async () => {
        order.push("fetch");
        return htmlResponse("ok");
      },
      onResponseCapture: async () => {
        count += 1;
        order.push(`capture${count}`);
        if (count === 1) {
          ready();
          await hold;
        }
        order.push(`saved${count}`);
      },
    });
    const first = session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry));
    const second = session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));
    await firstCapture;
    expect(order).toEqual(["fetch", "capture1"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["fetch", "capture1", "saved1", "fetch", "capture2", "saved2"]);
  });

  it("never captures headers, unsafe query/body values, street filters or supplied timestamps", async () => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const messages: string[] = [];
    const { fetchImpl } = recordingFetch([
      new Response("ok", { headers: { "Set-Cookie": "ASP.NET_SessionId=secret-cookie" } }),
      new Response("gone", { status: 404 }),
    ]);
    const session = createDelawareCfrsSession({
      fetchImpl,
      sleep: noSleep,
      log: (message) => messages.push(message),
      onResponseCapture: (capture) => {
        captures.push(capture);
      },
      retrievedAt: new Date("1900-01-01"),
    } as never);
    await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));
    await expect(
      session.postForm(
        buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, {
          theme: "vista",
          token: "secret-url",
          fpath: "secret-opaque",
        }),
        {
          MemberId: "458984",
          FilingYear: "2026",
          txtStreet: "secret-street",
          Authorization: "secret-auth",
          Cookie: "secret-cookie",
          __RequestVerificationToken: "secret-csrf",
          privateField: "secret-private",
        },
        { referer: "https://example.invalid/secret-referer", xhr: true }
      )
    ).rejects.toThrow();
    expect(captures[1]).toMatchObject({
      url: buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, { theme: "vista" }),
      financeFields: { MemberId: "458984", FilingYear: "2026" },
      requestScopeRedacted: true,
    });
    expect(captures[1]?.startedAt).not.toContain("1900");
    expect(JSON.stringify(captures)).not.toContain("secret-");
    expect(JSON.stringify(captures)).not.toContain("headers");
    expect(messages.join(" ")).not.toContain("secret-");
  });

  it("preserves exact public report/SO URL identity and omits blank private form controls", async () => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const { fetchImpl } = recordingFetch([htmlResponse("ok"), htmlResponse("ok"), htmlResponse("ok")]);
    const session = createDelawareCfrsSession({
      fetchImpl,
      sleep: noSleep,
      onResponseCapture: (capture) => {
        captures.push(capture);
      },
    });
    const soo = `${DELAWARE_CFRS_BASE_URL}/Public/ShowReview?memberID=739099&memVersID=1&cTypeCode=04&ftype=SO&fpath=&fname=&isPublic=true`;
    const report = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportPdf, {
      FileName: "CampaignFinanceReport_Prelim_739099_315_829eb639-f068-43f2-8f7a-38576c55fbc6.pdf",
      CommitteeID: "739099",
      FilingCalendarID: "315",
    });
    await session.get(soo);
    await session.get(report);
    await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch),
      buildDelawareReceiptsSearchFields({ MemberId: "458984" })
    );
    expect(captures[0]).toMatchObject({ url: soo, financeFields: null, requestScopeRedacted: false });
    expect(captures[1]).toMatchObject({ url: report, financeFields: null, requestScopeRedacted: false });
    expect(captures[2]?.requestScopeRedacted).toBe(false);
    expect(captures[2]?.financeFields).not.toHaveProperty("txtStreet");
  });

  it("retains the observed current-report checkbox in source scope", async () => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const { fetchImpl } = recordingFetch([htmlResponse("ok")]);
    const session = createDelawareCfrsSession({
      fetchImpl, sleep: noSleep,
      onResponseCapture: (capture) => { captures.push(capture); },
    });
    const fields = { MemberId: "458984", hdnViewCurrent: "true", chkViewCurrReport: "on" };
    await session.postForm(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsSearch), fields);
    expect(captures[0]).toMatchObject({ financeFields: fields, requestScopeRedacted: false });
  });

  it("retains the observed native expense route and paging scope", async () => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const { fetchImpl } = recordingFetch([htmlResponse("ok")]);
    const session = createDelawareCfrsSession({
      fetchImpl, sleep: noSleep,
      onResponseCapture: (capture) => { captures.push(capture); },
    });
    const url = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesGridJson, { theme: "vista" });
    const fields = { page: "1", size: "500", orderBy: "", groupBy: "", filter: "" };
    await session.postForm(url, fields, { xhr: true });
    expect(captures[0]).toMatchObject({ url, financeFields: fields, requestScopeRedacted: false });
  });

  it.each([
    "CampaignFinance_502c0273-3327-4d1d-9f75-073872897dce.pdf",
    "CampaignFinance_458984_623_b7770710-ecc1-43c4-848d-b846bbc4cb3d.pdf",
  ])("captures the published legacy financial filename %s without redaction", async (fileName) => {
    const captures: DelawareCfrsResponseCapture[] = [];
    const { fetchImpl } = recordingFetch([htmlResponse("ok")]);
    const session = createDelawareCfrsSession({ fetchImpl, sleep: noSleep,
      onResponseCapture: capture => { captures.push(capture); } });
    const url = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportPdf, {
      FileName: fileName, CommitteeID: "458984", FilingCalendarID: "623",
    });
    await session.get(url);
    expect(captures[0]).toMatchObject({ url, requestScopeRedacted: false });
  });

  it("refuses unrelated or path-like legacy filename controls", () => {
    for (const fileName of ["CampaignFinance_secret.pdf", "CampaignFinance_../secret.pdf",
      "CampaignFinance_0_623_b7770710-ecc1-43c4-848d-b846bbc4cb3d.pdf"]) {
      expect(isDelawareCfrsPublicReportFileName(fileName)).toBe(false);
    }
  });

  it("does not hand oversize bytes to the observer", async () => {
    const observer = vi.fn();
    const { fetchImpl } = recordingFetch([htmlResponse("x".repeat(100))]);
    const session = createDelawareCfrsSession({
      fetchImpl,
      sleep: noSleep,
      maxResponseBytes: 10,
      onResponseCapture: observer,
    });
    await expect(session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry))).rejects.toMatchObject({
      code: "bad_response",
    });
    expect(observer).not.toHaveBeenCalled();
  });

  it("exposes the error class shape", () => {
    const error = new DelawareCfrsClientError("bad_response", "boom", 200);
    expect(error.name).toBe("DelawareCfrsClientError");
    expect(error.code).toBe("bad_response");
    expect(error.status).toBe(200);
    expect(DELAWARE_CFRS_ERROR_SENTINEL).toBe("Unable to process the request.");
  });
});
