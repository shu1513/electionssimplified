// Missouri Ethics Commission (MEC) portal client (docs/plans/plan-missouri-finance.md).
//
// The MEC campaign-finance searches are ASP.NET WebForms pages on
// www.mec.mo.gov: every interaction is a form POST carrying the page's
// __VIEWSTATE/__EVENTVALIDATION hidden fields, and the contribution search
// stores its results in the server session (the search POST answers with
// window.open('CF12_ContrExpendResults.aspx') and the results page must be
// fetched with the same ASP.NET_SessionId). This client is the module's
// single fetch layer:
// - HTTPS to exactly www.mec.mo.gov. The bare host (mec.mo.gov) serves an
//   Imperva/Incapsula JS challenge to plain HTTP clients; the www host serves
//   full pages (verified live 2026-08-12). Challenge detection FAILS CLOSED:
//   any body carrying the Incapsula markers aborts with waf_challenge — no
//   challenge solving, no retry, ever.
// - One request in flight per session, courteous spacing between requests,
//   bounded retries on transient failures only (network, 429, 5xx).
// - Redirects are never followed automatically: a 302's Location is DATA
//   here (the outside-spending committee-link postback answers with a 302 to
//   CommInfo.aspx?mecid=... — that Location IS the spender identity), and an
//   unexpected redirect (session loss lands on /mec/Error.aspx) must fail
//   loudly, not be silently followed.
// - PII: contribution artifacts carry contributor street addresses. This
//   layer returns raw bytes; callers keep artifacts in restricted storage
//   and must never log or persist address fields (plan cache PII rules).

export const MISSOURI_MEC_WWW_BASE_URL = "https://www.mec.mo.gov";
export const MISSOURI_MEC_BARE_BASE_URL = "https://mec.mo.gov";
export const MISSOURI_MEC_CAMPAIGN_FINANCE_PATH_PREFIX = "/MEC/Campaign_Finance/";

/** Campaign-finance pages exercised by the probe (paths verified live 2026-08-12). */
export const MISSOURI_MEC_PAGES = {
  contributionSearch: "CF12_ContrExpend.aspx",
  contributionResults: "CF12_ContrExpendResults.aspx",
  outsideSpendingSearch: "CF_SearchDirExp.aspx",
  electionSearch: "CF12_SearchElection.aspx",
  committeeInfo: "CommInfo.aspx",
  committeeActivity: "CF_SearchCommNew.aspx",
  nonCommitteeExpenditures: "CF14_nonCommExp.aspx",
} as const;

/**
 * WebForms control-name prefixes differ by master page: the search pages nest
 * two content placeholders, the results popup only one (verified live).
 */
export const MISSOURI_MEC_SEARCH_FIELD_PREFIX = "ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$";
export const MISSOURI_MEC_RESULTS_FIELD_PREFIX = "ctl00$ContentPlaceHolder$";

export const DEFAULT_MISSOURI_MEC_USER_AGENT =
  "VoteApp election research (https://electionssimplified.com)";
export const DEFAULT_MISSOURI_MEC_REQUEST_SPACING_MS = 2_000;
// A full-office election-search render was observed taking 45+ s live.
export const DEFAULT_MISSOURI_MEC_REQUEST_TIMEOUT_MS = 120_000;
// The 2026 outside-spending export is ~2.4 MB; a full-year contribution
// export is larger but bounded. Anything past this is drift, not data.
export const MISSOURI_MEC_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type MissouriMecClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "waf_challenge"
  | "bad_response";

export class MissouriMecClientError extends Error {
  constructor(
    public readonly code: MissouriMecClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "MissouriMecClientError";
  }
}

// Incapsula injects a `_Incapsula_Resource` telemetry script into EVERY
// legitimate MEC page (verified live 2026-08-12: the 60 KB search page, the
// 358 KB results page, and the POST responses all carry it), so the marker
// alone does not indicate a challenge. A real challenge is a tiny bootstrap
// stub (~212 bytes captured from the bare host) whose whole body is that
// script and which carries no page content — no __VIEWSTATE. Detection is
// therefore shape-based, and real pages far exceed this bound.
export const MISSOURI_MEC_CHALLENGE_MAX_BYTES = 4_096;

/**
 * True when a body is the Imperva/Incapsula WAF challenge or block page.
 * Fail closed on: an "Incapsula incident" block page (any size), or the tiny
 * JS-challenge stub — a small body that references `_Incapsula_Resource` yet
 * has none of the WebForms page content (__VIEWSTATE) every real page
 * carries. A full page that merely embeds the telemetry script is NOT a
 * challenge.
 */
export function isMissouriMecChallengeBody(body: string): boolean {
  if (/incapsula incident/i.test(body)) {
    return true;
  }
  return (
    body.length < MISSOURI_MEC_CHALLENGE_MAX_BYTES &&
    body.includes("_Incapsula_Resource") &&
    !body.includes("__VIEWSTATE")
  );
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
};

function decodeHtmlAttribute(value: string): string {
  // WebForms attribute-encodes state values (base64 '+' arrives as &#43;).
  // Single pass: chained replaces would double-decode (&#38;lt; must yield
  // the literal &lt;, not <) and the echoed field would then be wrong.
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|amp|lt|gt|quot);/g, (entity, hex?: string, decimal?: string) => {
    if (hex !== undefined) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (decimal !== undefined) {
      return String.fromCodePoint(Number.parseInt(decimal, 10));
    }
    return HTML_ENTITY_MAP[entity] ?? entity;
  });
}

/**
 * Extracts every hidden input (name -> value) from a WebForms page. The
 * postback state fields (__VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION)
 * must be echoed verbatim on the next POST or the server rejects it.
 */
export function parseMissouriMecHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g;
  for (const match of html.matchAll(pattern)) {
    fields[decodeHtmlAttribute(match[1]!)] = decodeHtmlAttribute(match[2]!);
  }
  return fields;
}

export type MissouriMecResponse = {
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  /** Location header when the server answered with a redirect; never followed. */
  redirectLocation: string | null;
  body: Buffer;
  text: () => string;
};

export type MissouriMecFetchFn = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    redirect: "manual";
    signal: AbortSignal;
  }
) => Promise<Response>;

export type MissouriMecSessionOptions = {
  fetchImpl?: MissouriMecFetchFn;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  userAgent?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  log?: (message: string) => void;
};

export type MissouriMecSession = {
  get: (url: string, options?: { referer?: string }) => Promise<MissouriMecResponse>;
  postForm: (
    url: string,
    fields: Record<string, string>,
    options?: { referer?: string }
  ) => Promise<MissouriMecResponse>;
};

export function buildMissouriMecUrl(page: string, query?: Record<string, string>): string {
  const url = new URL(`${MISSOURI_MEC_CAMPAIGN_FINANCE_PATH_PREFIX}${page}`, MISSOURI_MEC_WWW_BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Cookie jar: single host, session lifetime — name/value only, attributes ignored. */
function parseSetCookieHeader(header: string): { name: string; value: string } | null {
  const pair = header.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  return { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() };
}

/**
 * A session owns a cookie jar (Incapsula visitor cookies + ASP.NET_SessionId)
 * and a single-flight request queue with courteous spacing. Create one
 * session per acquisition run; the contribution results page only exists in
 * the session that ran its search POST.
 */
export function createMissouriMecSession(options: MissouriMecSessionOptions = {}): MissouriMecSession {
  const spacingMs = options.spacingMs ?? DEFAULT_MISSOURI_MEC_REQUEST_SPACING_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBackoffMs = options.retryBackoffMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MISSOURI_MEC_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MISSOURI_MEC_MAX_RESPONSE_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_MISSOURI_MEC_USER_AGENT;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl: MissouriMecFetchFn = options.fetchImpl ?? ((url, init) => fetch(url, init));

  const cookies = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  let anyRequestStarted = false;
  let challengeBlocked = false;

  function requireMecUrl(url: string): void {
    if (!url.startsWith(`${MISSOURI_MEC_WWW_BASE_URL}/`) && !url.startsWith(`${MISSOURI_MEC_BARE_BASE_URL}/`)) {
      throw new MissouriMecClientError("invalid_request", `not a mec.mo.gov URL: ${url}`);
    }
  }

  async function performOnce(
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    referer: string | undefined
  ): Promise<MissouriMecResponse> {
    const headers: Record<string, string> = { "User-Agent": userAgent };
    if (referer !== undefined) {
      headers.Referer = referer;
    }
    if (cookies.size > 0) {
      headers.Cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MissouriMecClientError("network_error", `MEC request failed: ${method} ${url} — ${message}`);
    }

    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookieHeader(header);
      if (cookie !== null) {
        cookies.set(cookie.name, cookie.value);
      }
    }

    // Reject a declared oversize before buffering; the post-read check below
    // still covers responses without a Content-Length. (Streaming with a
    // running count is deliberately skipped — this is a single-flight client
    // against one known host, and the limit is drift detection, not DoS
    // defense.)
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxResponseBytes) {
      throw new MissouriMecClientError(
        "bad_response",
        `MEC response declares ${declaredLength} bytes, over the ${maxResponseBytes} limit: ${url}`
      );
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MissouriMecClientError("network_error", `MEC response body read failed: ${url} — ${message}`);
    }
    if (bytes.byteLength > maxResponseBytes) {
      throw new MissouriMecClientError(
        "bad_response",
        `MEC response exceeds ${maxResponseBytes} bytes (${bytes.byteLength}): ${url}`
      );
    }

    const buffer = Buffer.from(bytes);
    const result: MissouriMecResponse = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentDisposition: response.headers.get("content-disposition"),
      redirectLocation: response.headers.get("location"),
      body: buffer,
      text: () => buffer.toString("utf-8"),
    };

    // Fail closed on the WAF before any status handling: challenge pages can
    // arrive with 200 as well as error statuses.
    if ((result.contentType ?? "").includes("text/html") || result.contentType === null) {
      if (isMissouriMecChallengeBody(result.text())) {
        throw new MissouriMecClientError(
          "waf_challenge",
          `MEC served an Incapsula challenge (fail closed, do not retry): ${url}`,
          response.status
        );
      }
    }

    if (response.status >= 400) {
      throw new MissouriMecClientError(
        "http_error",
        `MEC request failed with HTTP ${response.status}: ${url}`,
        response.status
      );
    }
    return result;
  }

  function enqueue(
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    referer: string | undefined
  ): Promise<MissouriMecResponse> {
    try {
      requireMecUrl(url);
    } catch (error) {
      return Promise.reject(error);
    }
    const run = queue.then(async () => {
      if (challengeBlocked) {
        throw new MissouriMecClientError("waf_challenge", "MEC session stopped after a challenge");
      }
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (anyRequestStarted) {
          await sleep(attempt === 1 ? spacingMs : attempt * retryBackoffMs);
        }
        anyRequestStarted = true;
        try {
          return await performOnce(url, method, body, referer);
        } catch (error) {
          if (error instanceof MissouriMecClientError) {
            if (error.code === "waf_challenge") challengeBlocked = true;
            const retryable =
              error.code === "network_error" ||
              (error.code === "http_error" && (error.status === 429 || (error.status ?? 0) >= 500));
            if (!retryable) {
              throw error;
            }
            lastError = error;
          } else {
            lastError = error as Error;
          }
        }
        options.log?.(`MEC attempt ${attempt}/${maxAttempts} failed for ${url}: ${lastError.message}`);
      }
      throw new MissouriMecClientError(
        "network_error",
        `MEC request failed after ${maxAttempts} attempts: ${url} — ${lastError?.message}`
      );
    });
    // Later requests wait for this one to settle, success or failure.
    queue = run.catch(() => {});
    return run;
  }

  return {
    get: (url, getOptions) => enqueue(url, "GET", undefined, getOptions?.referer),
    postForm: (url, fields, postOptions) => {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(fields)) {
        params.append(name, value);
      }
      return enqueue(url, "POST", params.toString(), postOptions?.referer);
    },
  };
}
