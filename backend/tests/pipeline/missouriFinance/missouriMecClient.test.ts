import { describe, expect, it } from "vitest";

import {
  MISSOURI_MEC_PAGES,
  MISSOURI_MEC_SEARCH_FIELD_PREFIX,
  MissouriMecClientError,
  buildMissouriMecUrl,
  createMissouriMecSession,
  isMissouriMecChallengeBody,
  parseMissouriMecHiddenFields,
  type MissouriMecFetchFn,
} from "../../../src/pipeline/missouriFinance/missouriMecClient.js";

/** Byte-for-byte the challenge stub the bare host served to plain curl (2026-08-12). */
const INCAPSULA_CHALLENGE_STUB = `<html>
<head>
<META NAME="robots" CONTENT="noindex,nofollow">
<script src="/_Incapsula_Resource?SWJIYLWA=5074a744e2e3d891814e9a2dace20bd4,719d34d31c8e3a6e6fffd425f7e032f3">
</script>
<body>
</body></html>`;

const SEARCH_PAGE_HTML = `<form method="post" action="./CF12_ContrExpend.aspx">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="dDwtMTA5&#43;abc/==" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="ABCD1234" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="a&quot;b&amp;c&#39;d" />
<input name="ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$txtLName" type="text" />
</form>`;

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    ...init,
  });
}

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function recordingFetch(responses: Response[]): { fetchImpl: MissouriMecFetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: MissouriMecFetchFn = (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected extra request: ${url}`);
    }
    return Promise.resolve(next);
  };
  return { fetchImpl, requests };
}

const noSleep = () => Promise.resolve();

describe("missouriMecClient", () => {
  it("detects the Incapsula challenge stub and block page, passes real pages", () => {
    expect(isMissouriMecChallengeBody(INCAPSULA_CHALLENGE_STUB)).toBe(true);
    expect(isMissouriMecChallengeBody("Request unsuccessful. Incapsula incident ID: 92000-1")).toBe(true);
    expect(isMissouriMecChallengeBody(SEARCH_PAGE_HTML)).toBe(false);
    // A full WebForms page that merely embeds the telemetry script (as every
    // real MEC page does) is NOT a challenge — the discriminator is size +
    // absence of __VIEWSTATE, not the marker substring.
    const realPageWithTelemetry =
      SEARCH_PAGE_HTML +
      '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d3&ns=10&cb=1162649131"></script>' +
      "x".repeat(60_000);
    expect(isMissouriMecChallengeBody(realPageWithTelemetry)).toBe(false);
    // A small body carrying the marker but with __VIEWSTATE is still treated
    // as a real (if truncated) page, not a challenge.
    expect(isMissouriMecChallengeBody('<input name="__VIEWSTATE"><script src="/_Incapsula_Resource?x"></script>')).toBe(
      false
    );
  });

  it("parses WebForms hidden fields with entity decoding", () => {
    const fields = parseMissouriMecHiddenFields(SEARCH_PAGE_HTML);
    expect(fields).toEqual({
      __VIEWSTATE: "dDwtMTA5+abc/==",
      __VIEWSTATEGENERATOR: "ABCD1234",
      __EVENTVALIDATION: `a"b&c'd`,
    });
    // Single-pass decoding: &#38;lt; is the literal text "&lt;", not "<" —
    // a chained decode would double-decode it and corrupt the echoed field.
    const doubleEncoded = parseMissouriMecHiddenFields(
      '<input type="hidden" name="__EVENTVALIDATION" value="x&#38;lt;y&#x26;amp;z" />'
    );
    expect(doubleEncoded.__EVENTVALIDATION).toBe("x&lt;y&amp;z");
  });

  it("builds campaign-finance URLs with optional query", () => {
    expect(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch)).toBe(
      "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx"
    );
    expect(buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeInfo, { MECID: "A222073" })).toBe(
      "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=A222073"
    );
  });

  it("fails closed on a challenge body without retrying", async () => {
    const { fetchImpl, requests } = recordingFetch([htmlResponse(INCAPSULA_CHALLENGE_STUB)]);
    const session = createMissouriMecSession({ fetchImpl, sleep: noSleep });
    await expect(session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch))).rejects.toMatchObject({
      name: "MissouriMecClientError",
      code: "waf_challenge",
    });
    expect(requests).toHaveLength(1);
  });

  it("stops queued and subsequent source legs after a session challenge", async () => {
    const { fetchImpl, requests } = recordingFetch([htmlResponse(INCAPSULA_CHALLENGE_STUB)]);
    const session = createMissouriMecSession({ fetchImpl, sleep: noSleep });
    const results = await Promise.allSettled([
      session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch)),
      session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionResults)),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "waf_challenge" }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "waf_challenge" }) }),
    ]);
    await expect(session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.committeeInfo))).rejects.toMatchObject({
      code: "waf_challenge",
    });
    expect(requests).toHaveLength(1);
  });

  it("carries cookies from Set-Cookie into later requests in the same session", async () => {
    const first = htmlResponse("<html>ok</html>");
    first.headers.append("Set-Cookie", "ASP.NET_SessionId=abc123; path=/; HttpOnly");
    first.headers.append("Set-Cookie", "incap_ses_92=xyz==; path=/; Domain=.mec.mo.gov");
    const second = htmlResponse("<html>ok</html>");
    const { fetchImpl, requests } = recordingFetch([first, second]);
    const session = createMissouriMecSession({ fetchImpl, sleep: noSleep });
    await session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch));
    await session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionResults));
    expect(requests[0]!.headers.Cookie).toBeUndefined();
    expect(requests[1]!.headers.Cookie).toBe("ASP.NET_SessionId=abc123; incap_ses_92=xyz==");
  });

  it("posts urlencoded WebForms fields and surfaces a 302 Location without following it", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/MEC/Campaign_Finance/CommInfo.aspx?mecid=A222073" },
    });
    const { fetchImpl, requests } = recordingFetch([redirect]);
    const session = createMissouriMecSession({ fetchImpl, sleep: noSleep });
    const searchUrl = buildMissouriMecUrl(MISSOURI_MEC_PAGES.outsideSpendingSearch);
    const response = await session.postForm(
      searchUrl,
      {
        __VIEWSTATE: "dDwtMTA5+abc/==",
        [`${MISSOURI_MEC_SEARCH_FIELD_PREFIX}ddYear`]: "2026",
      },
      { referer: searchUrl }
    );
    expect(response.status).toBe(302);
    expect(response.redirectLocation).toBe("/MEC/Campaign_Finance/CommInfo.aspx?mecid=A222073");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(requests[0]!.headers.Referer).toBe(searchUrl);
    expect(requests[0]!.body).toBe(
      "__VIEWSTATE=dDwtMTA5%2Babc%2F%3D%3D&ctl00%24ctl00%24ContentPlaceHolder%24ContentPlaceHolder1%24ddYear=2026"
    );
  });

  it("spaces requests after the first and runs them single-flight", async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = recordingFetch([htmlResponse("<html>1</html>"), htmlResponse("<html>2</html>")]);
    const session = createMissouriMecSession({
      fetchImpl,
      spacingMs: 2_000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const url = buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch);
    await Promise.all([session.get(url), session.get(url)]);
    expect(sleeps).toEqual([2_000]);
  });

  it("retries transient 500s with backoff but not client errors", async () => {
    const transient = recordingFetch([
      htmlResponse("<html>oops</html>", { status: 500 }),
      htmlResponse("<html>ok</html>"),
    ]);
    const sleeps: number[] = [];
    const session = createMissouriMecSession({
      fetchImpl: transient.fetchImpl,
      retryBackoffMs: 5_000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const url = buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch);
    const response = await session.get(url);
    expect(response.text()).toBe("<html>ok</html>");
    expect(transient.requests).toHaveLength(2);
    expect(sleeps).toEqual([10_000]); // attempt 2 backoff, no spacing before the first request

    const notFound = recordingFetch([htmlResponse("<html>gone</html>", { status: 404 })]);
    const session2 = createMissouriMecSession({ fetchImpl: notFound.fetchImpl, sleep: noSleep });
    await expect(session2.get(url)).rejects.toMatchObject({ code: "http_error", status: 404 });
    expect(notFound.requests).toHaveLength(1);
  });

  it("rejects non-MEC URLs and oversized responses", async () => {
    const { fetchImpl } = recordingFetch([htmlResponse("x".repeat(32))]);
    const session = createMissouriMecSession({ fetchImpl, sleep: noSleep, maxResponseBytes: 16 });
    await expect(session.get("https://example.com/MEC/page.aspx")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      session.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch))
    ).rejects.toMatchObject({ code: "bad_response" });

    // A declared Content-Length over the limit is rejected before the body
    // is buffered at all.
    const declared = new Response("tiny", {
      status: 200,
      headers: { "Content-Type": "text/html", "Content-Length": "999999" },
    });
    const declaredFetch = recordingFetch([declared]);
    const session3 = createMissouriMecSession({
      fetchImpl: declaredFetch.fetchImpl,
      sleep: noSleep,
      maxResponseBytes: 1_000,
    });
    await expect(
      session3.get(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionSearch))
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("exposes export headers on binary responses", async () => {
    const exportBody = '<table><tr><th>MECID</th></tr></table>';
    const response = new Response(exportBody, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ms-excel",
        "Content-Disposition": "attachment;filename=Contribution_Search.xls",
      },
    });
    const { fetchImpl } = recordingFetch([response]);
    const session = createMissouriMecSession({ fetchImpl, sleep: noSleep });
    const result = await session.postForm(buildMissouriMecUrl(MISSOURI_MEC_PAGES.contributionResults), {});
    expect(result.contentType).toBe("application/vnd.ms-excel");
    expect(result.contentDisposition).toBe("attachment;filename=Contribution_Search.xls");
    expect(result.body.toString("utf-8")).toBe(exportBody);
  });
});
