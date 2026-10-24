import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createErtsTransport,
  ertsContributionReportUrl,
  ertsExpenditureReportUrl,
  ertsFilingVersionsUrl,
  ertsHiddenFields,
  ertsPostBody,
  ertsSelectDefaults,
  fetchErtsFilingPdf,
  isErtsPortalUrl,
  requireErtsDownloadFileUrl,
  requireErtsPage,
  type ErtsHttpResponse,
} from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsClient.js";
import { ERTS_CONTRIBUTION_TYPE_CODES } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsParsers.js";

function response(overrides: Partial<ErtsHttpResponse> & { body?: string | Uint8Array } = {}): ErtsHttpResponse {
  const body = overrides.body ?? "";
  return {
    status: overrides.status ?? 200,
    finalUrl: overrides.finalUrl ?? "https://www.ricampaignfinance.com/RIPublic/",
    contentType: overrides.contentType ?? "text/html",
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  };
}

describe("report URLs", () => {
  it("builds the portal's own contribution report URL", () => {
    const url = new URL(ertsContributionReportUrl({ orgId: "2235", begin: "04/01/2026", end: "06/30/2026" }));
    expect(url.pathname).toBe("/RIPublic/Reporting/TransactionReport.aspx");
    expect(url.searchParams.get("OrgID")).toBe("2235");
    expect(url.searchParams.get("ContType")).toBe("0");
    expect(url.searchParams.get("ReportType")).toBe("Contrib");
  });

  it("passes a contribution-type filter through", () => {
    const url = new URL(
      ertsContributionReportUrl({
        orgId: "2235",
        begin: "04/01/2026",
        end: "06/30/2026",
        contributionTypeCode: ERTS_CONTRIBUTION_TYPE_CODES["Other Receipt"],
      })
    );
    expect(url.searchParams.get("ContType")).toBe("17");
  });

  it("rejects a non-numeric organization key and a malformed date", () => {
    expect(() => ertsContributionReportUrl({ orgId: "2235; DROP", begin: "04/01/2026", end: "06/30/2026" })).toThrow(
      /Invalid ERTS organization key/
    );
    expect(() => ertsExpenditureReportUrl({ orgId: "2235", begin: "2026-04-01", end: "06/30/2026" })).toThrow(
      /Invalid BeginDate/
    );
  });

  it("builds and validates the filing-versions URL", () => {
    expect(ertsFilingVersionsUrl({ filingId: "230557", formName: "RICF2" })).toBe(
      "https://secure.ricampaignfinance.com/RhodeIslandCF/Candidate/FilingAmendmentSelect.aspx?X=T&FilingID=230557&FormName=RICF2"
    );
    expect(() => ertsFilingVersionsUrl({ filingId: "abc", formName: "RICF2" })).toThrow(/Invalid ERTS filing id/);
    expect(() => ertsFilingVersionsUrl({ filingId: "1", formName: "../x" })).toThrow(/Invalid ERTS form name/);
  });
});

describe("portal URL pinning", () => {
  it("recognizes only https portal hosts — session cookies never leave them", () => {
    expect(isErtsPortalUrl("https://www.ricampaignfinance.com/RIPublic/Contributions.aspx")).toBe(true);
    expect(isErtsPortalUrl("https://secure.ricampaignfinance.com/RhodeIslandCF/x.aspx")).toBe(true);
    expect(isErtsPortalUrl("https://ricampaignfinance.com/ExportDocs/x.pdf")).toBe(true);
    expect(isErtsPortalUrl("http://www.ricampaignfinance.com/RIPublic/")).toBe(false);
    expect(isErtsPortalUrl("https://evil.example/steal")).toBe(false);
    expect(isErtsPortalUrl("https://ricampaignfinance.com.evil.example/")).toBe(false);
    expect(isErtsPortalUrl("not a url")).toBe(false);
  });

  it("accepts only the pinned DownloadFile route for the echoed export URL", () => {
    // The live portal prints http:; the upgrade is part of the pin.
    expect(
      requireErtsDownloadFileUrl("http://www.ricampaignfinance.com/RIPublic/Reporting/DownloadFile.aspx?path=x&file=y.csv")
    ).toBe("https://www.ricampaignfinance.com/RIPublic/Reporting/DownloadFile.aspx?path=x&file=y.csv");
    expect(() => requireErtsDownloadFileUrl("https://evil.example/steal")).toThrow(/outside the pinned portal route/);
    expect(() =>
      requireErtsDownloadFileUrl("https://www.ricampaignfinance.com/RIPublic/Reporting/Other.aspx?file=y.csv")
    ).toThrow(/outside the pinned portal route/);
    expect(() => requireErtsDownloadFileUrl("::::")).toThrow(/unparseable DownloadFile URL/);
  });
});

describe("WebForms field capture", () => {
  const html =
    '<input type="hidden" name="__VIEWSTATE" value="a&amp;b" />' +
    '<input type="hidden" name="__EVENTVALIDATION" value="" />' +
    '<select name="lstContributionType"><option value="0">All</option>' +
    '<option value="2" selected>Individual</option></select>' +
    '<select name="lstSort1"><option value="ReceiptDate">Date</option></select>';

  it("captures hidden fields with entities decoded", () => {
    expect(ertsHiddenFields(html)).toEqual({ __VIEWSTATE: "a&b", __EVENTVALIDATION: "" });
  });

  it("carries each dropdown's selected option, falling back to the first", () => {
    expect(ertsSelectDefaults(html)).toEqual({ lstContributionType: "2", lstSort1: "ReceiptDate" });
  });

  it("builds a postback body with overrides winning", () => {
    const body = ertsPostBody(html, { __EVENTTARGET: "lnkExport", lstSort1: "None" });
    expect(body.get("__VIEWSTATE")).toBe("a&b");
    expect(body.get("__EVENTTARGET")).toBe("lnkExport");
    expect(body.get("lstSort1")).toBe("None");
  });
});

describe("requireErtsPage", () => {
  it("passes a page carrying its marker and fails anything else", () => {
    expect(requireErtsPage("<div id='x'>ok</div>", "id='x'", "ctx")).toContain("ok");
    expect(() => requireErtsPage("<p>No Contributions were found for the Search criteria you entered.</p>", "grid", "ctx")).toThrow(
      /No Contributions were found/
    );
  });
});

describe("createErtsTransport", () => {
  it("runs one request at a time with spacing before every request after the first", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const transport = createErtsTransport({
      fetch: async (url) => {
        calls.push(url);
        return response({ body: "ok" });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      spacingMs: 2_000,
    });
    await Promise.all([transport.fetch("https://a"), transport.fetch("https://b"), transport.fetch("https://c")]);
    expect(calls).toEqual(["https://a", "https://b", "https://c"]);
    // No sleep before the first request; fixed spacing before each later one.
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it("retries 5xx with backoff and then succeeds", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const transport = createErtsTransport({
      fetch: async () => {
        attempts += 1;
        return attempts < 3 ? response({ status: 500 }) : response({ body: "ok" });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      spacingMs: 2_000,
      retryBackoffMs: 5_000,
    });
    const result = await transport.fetch("https://a");
    expect(new TextDecoder().decode(result.body)).toBe("ok");
    expect(attempts).toBe(3);
    // Retry backoff scales with the attempt number.
    expect(sleeps).toEqual([10_000, 15_000]);
  });

  it("fails a 404 immediately — it will not become a 200 by asking again", async () => {
    let attempts = 0;
    const transport = createErtsTransport({
      fetch: async () => {
        attempts += 1;
        return response({ status: 404 });
      },
      sleep: async () => {},
    });
    await expect(transport.fetch("https://a")).rejects.toThrow(/HTTP 404/);
    expect(attempts).toBe(1);
  });

  it("gives up after bounded attempts on persistent failure", async () => {
    let attempts = 0;
    const transport = createErtsTransport({
      fetch: async () => {
        attempts += 1;
        throw new Error("socket hang up");
      },
      sleep: async () => {},
      maxAttempts: 3,
    });
    await expect(transport.fetch("https://a")).rejects.toThrow(/failed after 3 attempts/);
    expect(attempts).toBe(3);
  });
});

describe("fetchErtsFilingPdf", () => {
  it("refuses a PDF URL outside /ExportDocs/", async () => {
    const transport = createErtsTransport({ fetch: async () => response(), sleep: async () => {} });
    await expect(fetchErtsFilingPdf(transport, "https://evil.example/x.pdf")).rejects.toThrow(/non-ExportDocs/);
  });

  it("fails closed when the body is not a PDF", async () => {
    const transport = createErtsTransport({
      fetch: async () => response({ body: "<html>error</html>" }),
      sleep: async () => {},
    });
    await expect(
      fetchErtsFilingPdf(transport, "https://ricampaignfinance.com/ExportDocs/2235-RICF2-1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf")
    ).rejects.toThrow(/did not start with %PDF-/);
  });
});

describe("default HTTP redirect handling", () => {
  afterEach(() => vi.unstubAllGlobals());
  const start = "https://www.ricampaignfinance.com/RIPublic/Reporting/TransactionReport.aspx";
  function nativeResponse(url: string, status: number, location?: string): Response {
    const result = new Response(status === 200 ? "No Contributions were found for the Search criteria you entered" : "redirect", {
      status,
      headers: { "content-type": "text/html", ...(location ? { location } : {}) },
    });
    Object.defineProperty(result, "url", { value: url });
    return result;
  }

  it("upgrades the native HTTP empty-window redirect before sending, with pacing", async () => {
    const next = "https://ricampaignfinance.com/RIPublic/Contributions.aspx";
    const fetch = vi.fn().mockImplementationOnce(async (url: string) =>
      nativeResponse(url, 302, next.replace("https:", "http:")))
      .mockImplementationOnce(async (url: string) => nativeResponse(url, 200));
    vi.stubGlobal("fetch", fetch);
    const sleep = vi.fn(async () => {});
    const result = await createErtsTransport({ sleep, maxAttempts: 1 }).fetch(start);
    expect(result.finalUrl).toBe(next);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([start, next]);
    expect(fetch.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it.each([
    "https://example.com/", "http://example.com/", "https://user:pass@ricampaignfinance.com/",
    "https://ricampaignfinance.com:444/", "file:///tmp/private",
  ])("refuses an untrusted redirect before another request: %s", async (location) => {
    const fetch = vi.fn(async (url: string) => nativeResponse(url, 302, location));
    vi.stubGlobal("fetch", fetch);
    await expect(createErtsTransport({ sleep: async () => {}, maxAttempts: 1 }).fetch(start))
      .rejects.toThrow(/outside the HTTPS portal/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([302, 303, 307, 308])("preserves redirect method semantics for %i", async (status) => {
    const fetch = vi.fn().mockImplementationOnce(async (url: string) =>
      nativeResponse(url, status, "/RIPublic/Contributions.aspx"))
      .mockImplementationOnce(async (url: string) => nativeResponse(url, 200));
    vi.stubGlobal("fetch", fetch);
    const body = new URLSearchParams({ __EVENTTARGET: "test" });
    await createErtsTransport({ sleep: async () => {}, maxAttempts: 1 }).fetch(start, body);
    const options = fetch.mock.calls[1]![1];
    expect(options.method).toBe(status >= 307 ? "POST" : "GET");
    expect(options.body).toBe(status >= 307 ? body : undefined);
  });

  it("bounds portal redirect loops", async () => {
    const fetch = vi.fn(async (url: string) => nativeResponse(url, 302, start));
    vi.stubGlobal("fetch", fetch);
    await expect(createErtsTransport({ sleep: async () => {}, maxAttempts: 1 }).fetch(start))
      .rejects.toThrow(/redirect limit/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
