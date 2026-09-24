import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { agentCloseMock, agentOptionsMock, dnsLookupMock } = vi.hoisted(() => ({
  agentCloseMock: vi.fn(),
  agentOptionsMock: vi.fn(),
  dnsLookupMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: dnsLookupMock,
}));

vi.mock("undici", () => ({
  Agent: class MockAgent {
    constructor(options: unknown) {
      agentOptionsMock(options);
    }

    close() {
      return agentCloseMock();
    }
  },
}));

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
  defaultCaCertificates,
  extraCaCertificatesForHost,
  GODADDY_SECURE_CA_G2_PEM,
  resetDefaultCaCertificatesForTests,
} from "../../src/ai/knownIncompleteChainHosts.js";
import {
  classifyCitationVerificationFailure,
  decodeLatin1MisreadHeader,
  isResourceChangingRedirect,
  isTlsCertificateReachabilityFailure,
  resetCitationHostCooldownsForTests,
  verifyHttpUrlReachability,
} from "../../src/ai/urlReachability.js";

describe("urlReachability", () => {
  it("detects TLS certificate reachability failures", () => {
    expect(
      isTlsCertificateReachabilityFailure(
        "citation URL fetch failed: fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      )
    ).toBe(true);
    expect(
      isTlsCertificateReachabilityFailure(
        "citation URL fetch failed: unable to get local issuer certificate"
      )
    ).toBe(true);
    expect(
      isTlsCertificateReachabilityFailure("citation URL fetch failed: self-signed certificate")
    ).toBe(true);
    expect(
      isTlsCertificateReachabilityFailure("citation URL fetch failed: self signed certificate")
    ).toBe(true);
    expect(
      isTlsCertificateReachabilityFailure("citation URL fetch failed: DEPTH_ZERO_SELF_SIGNED_CERT")
    ).toBe(true);
    expect(
      isTlsCertificateReachabilityFailure("citation URL fetch failed: SELF_SIGNED_CERT_IN_CHAIN")
    ).toBe(true);
    expect(isTlsCertificateReachabilityFailure("citation URL fetch failed: CERT_HAS_EXPIRED")).toBe(
      true
    );
  });

  it("does not classify ordinary reachability failures as TLS certificate issues", () => {
    expect(isTlsCertificateReachabilityFailure("citation fetch returned status 404")).toBe(false);
    expect(isTlsCertificateReachabilityFailure("citation URL fetch timed out")).toBe(false);
    expect(isTlsCertificateReachabilityFailure("citation URL is not a valid http(s) URL")).toBe(
      false
    );
    expect(isTlsCertificateReachabilityFailure("unable to verify hostname")).toBe(false);
  });
});

describe("extraCaCertificatesForHost", () => {
  it("matches the listed host and its subdomains, case-insensitively", () => {
    expect(extraCaCertificatesForHost("cga.ct.gov")).toEqual([GODADDY_SECURE_CA_G2_PEM]);
    expect(extraCaCertificatesForHost("WWW.CGA.CT.GOV.")).toEqual([GODADDY_SECURE_CA_G2_PEM]);
  });

  it("never matches a lookalike host", () => {
    expect(extraCaCertificatesForHost("notcga.ct.gov")).toBeNull();
    expect(extraCaCertificatesForHost("cga.ct.gov.example.com")).toBeNull();
    expect(extraCaCertificatesForHost("example.com")).toBeNull();
  });
});

describe("defaultCaCertificates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetDefaultCaCertificatesForTests();
  });

  it("keeps a NODE_EXTRA_CA_CERTS certificate in the default trust set", () => {
    const extraFile = join(tmpdir(), `extra-ca-${process.pid}.pem`);
    writeFileSync(extraFile, `${GODADDY_SECURE_CA_G2_PEM}\n`);
    try {
      vi.stubEnv("NODE_EXTRA_CA_CERTS", extraFile);
      resetDefaultCaCertificatesForTests();
      const certificates = defaultCaCertificates();
      expect(certificates.length).toBeGreaterThan(50);
      // Node >= 24 reports NODE_EXTRA_CA_CERTS only when it was set at startup,
      // so compare the fallback path's behaviour where the env var is read live.
      if (typeof (tls as { getCACertificates?: unknown }).getCACertificates !== "function") {
        expect(certificates.some((pem) => pem.trim() === GODADDY_SECURE_CA_G2_PEM.trim())).toBe(true);
      }
    } finally {
      rmSync(extraFile, { force: true });
    }
  });

  it("keeps a legacy X509 CERTIFICATE block and skips a TRUSTED CERTIFICATE block, like Node", () => {
    const legacyLabel = GODADDY_SECURE_CA_G2_PEM.replace("BEGIN CERTIFICATE", "BEGIN X509 CERTIFICATE").replace(
      "END CERTIFICATE",
      "END X509 CERTIFICATE"
    );
    const trustedLabel = GODADDY_SECURE_CA_G2_PEM.replace("BEGIN CERTIFICATE", "BEGIN TRUSTED CERTIFICATE").replace(
      "END CERTIFICATE",
      "END TRUSTED CERTIFICATE"
    );
    const extraFile = join(tmpdir(), `extra-ca-labels-${process.pid}.pem`);
    writeFileSync(extraFile, `${legacyLabel}\n${trustedLabel}\n`);
    try {
      vi.stubEnv("NODE_EXTRA_CA_CERTS", extraFile);
      resetDefaultCaCertificatesForTests();
      const certificates = defaultCaCertificates();
      if (typeof (tls as { getCACertificates?: unknown }).getCACertificates !== "function") {
        expect(certificates.filter((pem) => pem.includes("X509 CERTIFICATE"))).toHaveLength(1);
        expect(certificates.some((pem) => pem.includes("TRUSTED CERTIFICATE"))).toBe(false);
      }
    } finally {
      rmSync(extraFile, { force: true });
    }
  });

  it("falls back to the bundled roots when no extra file is set", () => {
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "");
    resetDefaultCaCertificatesForTests();
    expect(defaultCaCertificates().length).toBeGreaterThan(50);
  });
});

describe("decodeLatin1MisreadHeader", () => {
  it("recovers UTF-8 bytes that were surfaced as latin-1", () => {
    expect(decodeLatin1MisreadHeader("/News/Ford\u00c2\u00a0Secure")).toBe("/News/Ford\u00a0Secure");
  });

  it("leaves pure ASCII untouched", () => {
    expect(decodeLatin1MisreadHeader("/plain/path?a=1")).toBe("/plain/path?a=1");
  });

  it("leaves bytes that are not valid UTF-8 untouched", () => {
    // 0xFF never starts a valid UTF-8 sequence, so strict decoding rejects it
    // and a genuine latin-1 path survives.
    const latin1Only = "/caf\u00ff";
    expect(decodeLatin1MisreadHeader(latin1Only)).toBe(latin1Only);
  });

  it("leaves an already-correct non-latin1 string untouched", () => {
    expect(decodeLatin1MisreadHeader("/\u4e2d\u6587")).toBe("/\u4e2d\u6587");
  });

  it("leaves a mixed string (mojibake run plus a real wide char) untouched", () => {
    // A char above 0xFF proves the value was never a latin-1 byte read, so
    // the mojibake-looking prefix must NOT be reinterpreted \u2014 partial
    // decoding would corrupt the value.
    const mixed = "/a\u00c2\u00a0\u4e2d";
    expect(decodeLatin1MisreadHeader(mixed)).toBe(mixed);
  });
});

describe("isResourceChangingRedirect", () => {
  it("ignores scheme upgrades and trailing-slash canonicalization", () => {
    expect(isResourceChangingRedirect("http://example.gov/a", "https://example.gov/a")).toBe(false);
    expect(isResourceChangingRedirect("https://example.gov/a", "https://example.gov/a/")).toBe(
      false
    );
    expect(isResourceChangingRedirect("https://EXAMPLE.gov/a", "https://example.gov/a")).toBe(false);
  });

  it("ignores apex <-> www canonicalization when the path and query match", () => {
    expect(
      isResourceChangingRedirect("https://example.gov/a", "https://www.example.gov/a")
    ).toBe(false);
    expect(
      isResourceChangingRedirect("https://www.example.gov/a", "https://example.gov/a")
    ).toBe(false);
    // The combined common case: bare http apex -> canonical https www.
    expect(
      isResourceChangingRedirect("http://example.gov/a", "https://www.example.gov/a/")
    ).toBe(false);
    // www with a DIFFERENT path is a move, not canonicalization.
    expect(
      isResourceChangingRedirect("https://example.gov/a", "https://www.example.gov/Error")
    ).toBe(true);
  });

  it("flags host, path and query changes", () => {
    expect(isResourceChangingRedirect("https://example.gov/a", "https://cdn.example.gov/a")).toBe(
      true
    );
    expect(isResourceChangingRedirect("https://example.gov/a", "https://example.gov/Error")).toBe(
      true
    );
    expect(isResourceChangingRedirect("https://example.gov/a?x=1", "https://example.gov/a")).toBe(
      true
    );
  });

  it("flags a port change and a scheme downgrade", () => {
    expect(
      isResourceChangingRedirect("https://example.gov/a", "https://example.gov:8443/a")
    ).toBe(true);
    expect(isResourceChangingRedirect("https://example.gov/a", "http://example.gov/a")).toBe(true);
  });

  it("treats unparseable input as changed so the confirming GET still runs", () => {
    expect(isResourceChangingRedirect("not a url", "https://example.gov/a")).toBe(true);
  });
});

describe("verifyHttpUrlReachability HEAD->GET fallback", () => {
  beforeEach(() => {
    // Cooldowns AND GET-preferred hosts are module-global; several tests
    // below (redirect confirmation, 429s) record hosts like example.gov that
    // other tests reuse, so every test starts from a clean slate.
    resetCitationHostCooldownsForTests();
    agentCloseMock.mockReset();
    agentCloseMock.mockResolvedValue(undefined);
    agentOptionsMock.mockReset();
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type StubStep = {
    status: number;
    location?: string;
    contentType?: string;
    contentLength?: number;
    retryAfter?: string;
  };

  function stubFetch(handler: (method: string, url: string) => StubStep) {
    const calls: { method: string; url: string }[] = [];
    const dispatchers: unknown[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      async (
        url: string,
        init?: { dispatcher?: unknown; method?: string; signal?: AbortSignal }
      ) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        dispatchers.push(init?.dispatcher);
        signals.push(init?.signal);
        const { status, location, contentLength, contentType, retryAfter } = handler(method, url);
        return {
          ok: status >= 200 && status < 300,
          status,
          url,
          headers: {
            get: (name: string) => {
              const lowerName = name.toLowerCase();
              if (lowerName === "location") {
                return location ?? null;
              }
              if (lowerName === "content-type") {
                return contentType ?? null;
              }
              if (lowerName === "content-length") {
                return contentLength === undefined ? null : String(contentLength);
              }
              if (lowerName === "retry-after") {
                return retryAfter ?? null;
              }
              return null;
            },
          },
          body: null,
        } as unknown as Response;
      }
    );
    return { calls, dispatchers, signals };
  }

  it("falls back to GET when HEAD fails at the transport level and marks the host GET-preferred", async () => {
    resetCitationHostCooldownsForTests();
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "HEAD") {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          });
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => null },
          body: null,
        } as unknown as Response;
      }
    );

    const result = await verifyHttpUrlReachability("https://oregonvotes.example/filing");

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);

    // Host is now GET-preferred: the next verification skips HEAD entirely.
    const second = await verifyHttpUrlReachability("https://oregonvotes.example/other");
    expect(second.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET", "GET"]);
  });

  it("does not repeat GET when the transport-level fallback GET fails by status", async () => {
    resetCitationHostCooldownsForTests();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        if (method === "HEAD") {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          });
        }
        return {
          ok: false,
          status: 404,
          url,
          headers: { get: () => null },
          body: null,
        } as unknown as Response;
      }
    );

    const result = await verifyHttpUrlReachability("https://resets-head.example/missing");

    expect(result).toEqual({ ok: false, reason: "citation fetch returned status 404" });
    // The fallback GET is already the authoritative method; a second
    // status-confirmation GET must not run.
    expect(calls).toEqual(["HEAD", "GET"]);
  });

  it("does not fall back to GET when the HEAD attempt times out", async () => {
    resetCitationHostCooldownsForTests();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: string, init?: { method?: string; signal?: AbortSignal }) => {
        calls.push(init?.method ?? "GET");
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
    );

    const result = await verifyHttpUrlReachability("https://slow.example/page");

    expect(result).toEqual({ ok: false, reason: "citation URL fetch timed out" });
    expect(calls).toEqual(["HEAD"]);
  });

  it("blocks an IPv4-mapped IPv6 loopback literal before fetch", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));

    const result = await verifyHttpUrlReachability("http://[::ffff:127.0.0.1]:9/internal");

    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: "citation URL points to a blocked/private host" });
  });

  it.each([
    "http://0.0.0.0/source",
    "http://10.0.0.1/source",
    "http://100.64.0.1/source",
    "http://127.0.0.1/source",
    "http://169.254.169.254/source",
    "http://172.16.0.1/source",
    "http://192.0.2.1/source",
    "http://192.168.0.1/source",
    "http://198.18.0.1/source",
    // upper half of the RFC 2544 benchmarking /15 (198.18.0.0-198.19.255.255)
    "http://198.19.0.1/source",
    "http://224.0.0.1/source",
    "http://240.0.0.1/source",
    "http://[::]/source",
    "http://[::1]/source",
    "http://[fc00::1]/source",
    "http://[fe80::1]/source",
    "http://[ff02::1]/source",
    "http://[2001:db8::1]/source",
    "http://[::ffff:10.0.0.1]/source",
    // IPv4-mapped benchmarking address must be caught after unmapping
    "http://[::ffff:198.18.0.1]/source",
    // RFC 6052 well-known NAT64 prefix embedding loopback
    "http://[64:ff9b::7f00:1]/source",
    // RFC 8215 local-use NAT64 prefix embedding loopback (ipaddr.js labels
    // it plain unicast, so it needs the explicit range check)
    "http://[64:ff9b:1::7f00:1]/source",
  ])("blocks reserved IP literal %s before fetch", async (url) => {
    const { calls } = stubFetch(() => ({ status: 200 }));

    const result = await verifyHttpUrlReachability(url);

    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: "citation URL points to a blocked/private host" });
  });

  it("rejects a hostname that resolves to a local-use NAT64 address", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    dnsLookupMock.mockResolvedValueOnce([{ address: "64:ff9b:1::7f00:1", family: 6 }]);

    const result = await verifyHttpUrlReachability("https://nat64-rebind.example/source");

    expect(calls).toEqual([]);
    expect(result).toEqual({
      ok: false,
      reason: "citation URL hostname resolves to a blocked/private IP",
    });
  });

  it("never contacts a local-use NAT64 redirect target", async () => {
    const { calls } = stubFetch(() => ({
      status: 302,
      location: "http://[64:ff9b:1::7f00:1]/internal-admin",
    }));

    const result = await verifyHttpUrlReachability("https://example.gov/redirects-to-nat64");

    expect(calls).toEqual([
      { method: "HEAD", url: "https://example.gov/redirects-to-nat64" },
    ]);
    expect(result).toEqual({ ok: false, reason: "citation URL points to a blocked/private host" });
  });

  it("fails closed when hostname resolution fails", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    dnsLookupMock.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    );

    const result = await verifyHttpUrlReachability("https://does-not-resolve.example/source");

    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: "citation URL hostname could not be resolved" });
  });

  it("reports a transient reason for resolver failures like EAI_AGAIN", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    dnsLookupMock.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" })
    );

    const result = await verifyHttpUrlReachability("https://flaky-resolver.example/source");

    expect(calls).toEqual([]);
    // "dns lookup failed transiently" is matched by every
    // classifyCitationVerificationFailure copy, keeping resolver outages
    // retryable while ENOTFOUND stays permanent.
    expect(result).toEqual({
      ok: false,
      reason: "citation URL DNS lookup failed transiently: EAI_AGAIN",
    });
  });

  it("bounds DNS resolution with the same timeout budget as the fetch", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    dnsLookupMock.mockImplementationOnce(() => new Promise(() => {}));

    const result = await verifyHttpUrlReachability("https://stalled-resolver.example/source", {
      timeoutMs: 25,
    });

    expect(calls).toEqual([]);
    // "timed out" already classifies as transient downstream.
    expect(result).toEqual({ ok: false, reason: "citation URL DNS lookup timed out" });
  });

  it("rejects a hostname if any resolved address is private", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    dnsLookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);

    const result = await verifyHttpUrlReachability("https://mixed-addresses.example/source");

    expect(calls).toEqual([]);
    expect(result).toEqual({
      ok: false,
      reason: "citation URL hostname resolves to a blocked/private IP",
    });
  });

  it("completes the certificate chain for hosts that omit their intermediate", async () => {
    stubFetch(() => ({ status: 200 }));

    const result = await verifyHttpUrlReachability("https://www.cga.ct.gov/2024/JUDdata/Tmy/test.PDF");

    expect(result.ok).toBe(true);
    const agentOptions = agentOptionsMock.mock.calls[0]?.[0] as {
      connect?: { ca?: string[] };
    };
    const ca = agentOptions.connect?.ca;
    expect(Array.isArray(ca)).toBe(true);
    // System roots stay trusted (connect.ca replaces the default store).
    expect(ca!.length).toBeGreaterThan(50);
    expect(ca).toContain(GODADDY_SECURE_CA_G2_PEM);
  });

  it("leaves the default trust store alone for every other host", async () => {
    stubFetch(() => ({ status: 200 }));

    const result = await verifyHttpUrlReachability("https://pinned.example/source");

    expect(result.ok).toBe(true);
    const agentOptions = agentOptionsMock.mock.calls[0]?.[0] as { connect?: { ca?: string[] } };
    expect(agentOptions.connect?.ca).toBeUndefined();
  });

  it("pins the connection lookup to the already-validated DNS answers", async () => {
    const { dispatchers } = stubFetch(() => ({ status: 200 }));
    dnsLookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    const result = await verifyHttpUrlReachability("https://pinned.example/source");

    expect(result.ok).toBe(true);
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
    expect(dispatchers[0]).toBeDefined();
    expect(agentCloseMock).toHaveBeenCalledTimes(1);

    const agentOptions = agentOptionsMock.mock.calls[0]?.[0] as {
      connect?: {
        lookup?: (
          hostname: string,
          options: { all: boolean; family: number },
          callback: (
            error: Error | null,
            addresses: string | Array<{ address: string; family: number }>,
            family?: number
          ) => void
        ) => void;
      };
    };
    const lookup = agentOptions.connect?.lookup;
    expect(lookup).toBeTypeOf("function");
    const pinnedAddresses = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        lookup?.("pinned.example", { all: true, family: 0 }, (error, addresses) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(addresses as Array<{ address: string; family: number }>);
        });
      }
    );
    expect(pinnedAddresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a rejected dispatcher close mask a successful response", async () => {
    stubFetch(() => ({ status: 200 }));
    agentCloseMock.mockRejectedValueOnce(new Error("lingering connection"));

    const result = await verifyHttpUrlReachability("https://example.gov/fine");

    expect(result.ok).toBe(true);
  });

  it("supports a direct GET check and returns final response metadata", async () => {
    const { calls } = stubFetch(() => ({
      status: 200,
      contentType: "text/html; charset=utf-8",
      contentLength: 1234,
    }));

    const result = await verifyHttpUrlReachability("https://example.gov/source", {
      method: "GET",
    });

    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(result).toEqual({
      ok: true,
      normalizedUrl: "https://example.gov/source",
      finalUrl: "https://example.gov/source",
      status: 200,
      contentType: "text/html; charset=utf-8",
      contentLength: 1234,
    });
  });

  it("accepts a URL whose host answers HEAD 404 but GET 200 (CivicPlus DocumentCenter)", async () => {
    const { calls, signals } = stubFetch((method) => ({ status: method === "HEAD" ? 404 : 200 }));

    const result = await verifyHttpUrlReachability("https://ropl.org/DocumentCenter/View/33411/Minutes");

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(result.ok).toBe(true);
    // Every request runs on its own AbortController, so a slow hop cannot
    // starve the next one's timeout budget.
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[1]).not.toBe(signals[0]);
  });

  it("still retries GET on method-not-allowed hosts", async () => {
    const { calls } = stubFetch((method) => ({ status: method === "HEAD" ? 405 : 200 }));

    const result = await verifyHttpUrlReachability("https://example.gov/doc");

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(result.ok).toBe(true);
  });

  it("fails with the GET status when both methods fail", async () => {
    const { calls } = stubFetch(() => ({ status: 404 }));

    const result = await verifyHttpUrlReachability("https://example.gov/really-gone");

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(result).toEqual({ ok: false, reason: "citation fetch returned status 404" });
  });

  it("does not issue a GET when HEAD already succeeded", async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));

    const result = await verifyHttpUrlReachability("https://example.gov/fine");

    expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
    expect(result.ok).toBe(true);
  });

  it("confirms with GET when a succeeding HEAD was redirected onto an error page (OLIS)", async () => {
    // Live behaviour: olis.oregonlegislature.gov 302s every HEAD of a measure
    // overview to /liz/<session>/Error, which answers 200. Trusting HEAD's
    // chain stores the error page as the citation.
    const overview = "https://olis.oregonlegislature.gov/liz/2025R1/Measures/Overview/HB2545";
    const errorPage = "https://olis.oregonlegislature.gov/liz/2025R1/Error";
    const { calls } = stubFetch((method, url) => {
      if (method === "HEAD" && url === overview) {
        return { status: 302, location: errorPage };
      }
      return { status: 200 };
    });

    const result = await verifyHttpUrlReachability(overview);

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD", "GET"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.finalUrl).toBe(overview);

    // The host's HEAD answers are misleading by demonstration, so it is
    // marked GET-preferred: the next URL on it skips the wasted HEAD walk.
    const second = await verifyHttpUrlReachability(
      "https://olis.oregonlegislature.gov/liz/2025R1/Measures/Overview/HB2541"
    );
    expect(second.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD", "GET", "GET"]);
  });

  it("accepts an allowlisted 403 behind a resource-changing redirect without a confirming GET", async () => {
    // The caller's allowlist (403 anti-bot default) already declared this
    // status acceptable; a confirming GET could only flip acceptance into a
    // failure (WAFs often escalate GET harder than HEAD).
    const { calls } = stubFetch((_method, url) => {
      if (url === "https://example.gov/wafd") {
        return { status: 302, location: "https://example.gov/blocked" };
      }
      return { status: 403 };
    });

    const result = await verifyHttpUrlReachability("https://example.gov/wafd");

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
    expect(result.ok).toBe(true);
    // The 403 proved reachability, not content: the /blocked target is
    // unverified and must not be handed to callers for storage — the input
    // URL is the citation.
    expect(result.ok && result.finalUrl).toBe("https://example.gov/wafd");
  });

  it("keeps the input URL when the rescuing GET ends on an allowlisted 403 behind a redirect", async () => {
    // HEAD 404 triggers the GET rescue; the GET chain lands on a WAF page
    // answering an allowlisted 403. Same rule as the HEAD path: an
    // unverified redirect target is not stored.
    const { calls } = stubFetch((method, url) => {
      if (method === "HEAD") {
        return { status: 404 };
      }
      if (url === "https://example.gov/doc.pdf") {
        return { status: 302, location: "https://example.gov/access-denied" };
      }
      return { status: 403 };
    });

    const result = await verifyHttpUrlReachability("https://example.gov/doc.pdf");

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET", "GET"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.finalUrl).toBe("https://example.gov/doc.pdf");
  });

  it("resolves a redirect whose Location header arrived as mis-decoded UTF-8", async () => {
    // Live: ag.nv.gov answers the slashless press-release path with a 301
    // whose Location holds raw UTF-8 bytes for a non-breaking space.
    const misdecoded = "/News/PR/2026/Ford\u00c2\u00a0Secure/";
    const { calls } = stubFetch((_method, url) =>
      url === "https://ag.example.gov/News/PR/2026/Ford%C2%A0Secure"
        ? { status: 301, location: misdecoded }
        : { status: 200 }
    );

    const result = await verifyHttpUrlReachability(
      "https://ag.example.gov/News/PR/2026/Ford%C2%A0Secure"
    );

    expect(result.ok).toBe(true);
    // Single-encoded (%C2%A0), not the doubled %C3%82%C2%A0 that 404s.
    expect(result.ok && result.finalUrl).toBe(
      "https://ag.example.gov/News/PR/2026/Ford%C2%A0Secure/"
    );
    expect(calls.every((call) => !call.url.includes("%C3%82"))).toBe(true);
  });

  it("does not issue a confirming GET for a trailing-slash-only redirect", async () => {
    const { calls } = stubFetch((_method, url) =>
      url === "https://example.gov/page"
        ? { status: 301, location: "https://example.gov/page/" }
        : { status: 200 }
    );

    const result = await verifyHttpUrlReachability("https://example.gov/page");

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
    expect(result.ok).toBe(true);
  });

  it("does not issue a GET when the HEAD status is in the default allowlist", async () => {
    const { calls } = stubFetch(() => ({ status: 403 }));

    const result = await verifyHttpUrlReachability("https://example.gov/anti-bot");

    expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
    expect(result.ok).toBe(true);
  });

  it("follows public redirects hop by hop and reports the final URL", async () => {
    const { calls } = stubFetch((_method, url) => {
      if (url === "https://example.gov/start") {
        return { status: 301, location: "https://example.gov/middle" };
      }
      if (url === "https://example.gov/middle") {
        return { status: 302, location: "https://docs.example.gov/final" };
      }
      return { status: 200 };
    });

    const result = await verifyHttpUrlReachability("https://example.gov/start");

    // The chain is walked twice: HEAD first, then the confirming GET, because
    // the redirect changed the resource (see isResourceChangingRedirect).
    expect(calls).toEqual([
      { method: "HEAD", url: "https://example.gov/start" },
      { method: "HEAD", url: "https://example.gov/middle" },
      { method: "HEAD", url: "https://docs.example.gov/final" },
      { method: "GET", url: "https://example.gov/start" },
      { method: "GET", url: "https://example.gov/middle" },
      { method: "GET", url: "https://docs.example.gov/final" },
    ]);
    expect(result).toEqual(
      expect.objectContaining({ ok: true, finalUrl: "https://docs.example.gov/final", status: 200 })
    );
  });

  it("never contacts a private redirect target reached by HEAD", async () => {
    const { calls } = stubFetch((method) =>
      method === "HEAD"
        ? { status: 302, location: "http://127.0.0.1:8080/internal-admin" }
        : { status: 200 }
    );

    const result = await verifyHttpUrlReachability("https://example.gov/redirects-internally");

    expect(calls).toEqual([{ method: "HEAD", url: "https://example.gov/redirects-internally" }]);
    expect(result).toEqual({ ok: false, reason: "citation URL points to a blocked/private host" });
  });

  it("never contacts an IPv4-mapped IPv6 private redirect target", async () => {
    const { calls } = stubFetch(() => ({
      status: 302,
      location: "http://[::ffff:127.0.0.1]:8080/internal-admin",
    }));

    const result = await verifyHttpUrlReachability(
      "https://example.gov/redirects-to-mapped-loopback"
    );

    expect(calls).toEqual([
      { method: "HEAD", url: "https://example.gov/redirects-to-mapped-loopback" },
    ]);
    expect(result).toEqual({ ok: false, reason: "citation URL points to a blocked/private host" });
  });

  it("never contacts a redirect hostname that resolves to a private address", async () => {
    const { calls } = stubFetch((_method, url) =>
      url === "https://example.gov/start"
        ? { status: 302, location: "https://private-after-redirect.example/internal" }
        : { status: 200 }
    );
    dnsLookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "192.168.1.20", family: 4 }]);

    const result = await verifyHttpUrlReachability("https://example.gov/start");

    expect(calls).toEqual([{ method: "HEAD", url: "https://example.gov/start" }]);
    expect(result).toEqual({
      ok: false,
      reason: "citation URL hostname resolves to a blocked/private IP",
    });
  });

  it("never contacts a private redirect target reached only by the GET fallback", async () => {
    // HEAD 404s in place; the GET (method-specific behavior) redirects to a
    // private host. The Location must be rejected before any request to it.
    const { calls } = stubFetch((method) =>
      method === "HEAD"
        ? { status: 404 }
        : { status: 302, location: "http://169.254.169.254/latest/meta-data/" }
    );

    const result = await verifyHttpUrlReachability("https://example.gov/head-404-get-redirects");

    expect(calls.map((call) => call.url)).toEqual([
      "https://example.gov/head-404-get-redirects",
      "https://example.gov/head-404-get-redirects",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(result).toEqual({ ok: false, reason: "citation URL points to a blocked/private host" });
  });

  it("fails a genuine self-redirect as a loop on the first repeat instead of burning the hop limit", async () => {
    const { calls } = stubFetch(() => ({ status: 301, location: "https://example.gov/loop" }));

    const result = await verifyHttpUrlReachability("https://example.gov/loop");

    // One request proves the cycle; the reason names the walked hops so the
    // repeated target is diagnosable.
    expect(calls.length).toBe(1);
    const hop = "https://example.gov/loop";
    expect(result).toEqual({
      ok: false,
      reason: `citation URL redirect loop detected (chain: ${hop} -> ${hop})`,
    });
  });

  it("follows a slashless-to-trailing-slash redirect instead of walking a synthetic self-loop", async () => {
    // The stored citation is normalized slashless; the host 301s to the
    // trailing-slash form. Before the fix the hop target was re-normalized
    // slashless, recreating the original URL until the redirect limit —
    // rejecting ordinary readable pages (Open States, Copper Courier,
    // campaign /about/ pages, all live).
    const { calls } = stubFetch((_method, url) =>
      url === "https://example.org/about"
        ? { status: 301, location: "https://example.org/about/" }
        : { status: 200 }
    );

    const result = await verifyHttpUrlReachability("https://example.org/about");

    expect(calls.map((call) => call.url)).toEqual([
      "https://example.org/about",
      "https://example.org/about/",
    ]);
    expect(result).toEqual(
      expect.objectContaining({ ok: true, finalUrl: "https://example.org/about/", status: 200 })
    );
  });

  it("catches a root self-loop one hop late because the slash-stripped input is a different visited form", async () => {
    // The input normalizes slashless while hop targets keep their slash, so
    // the first redirect to the slashed root is deliberately treated as a new
    // URL (slash-insensitive matching would falsely flag legitimate
    // slashless->slashed redirects as loops). The cycle is still caught on
    // the second, exact-form repeat — one extra request, well inside the hop
    // limit.
    const { calls } = stubFetch(() => ({ status: 301, location: "https://example.org/" }));

    const result = await verifyHttpUrlReachability("https://example.org/");

    expect(calls.map((call) => call.url)).toEqual([
      "https://example.org",
      "https://example.org/",
    ]);
    // The reported chain re-parses each hop, so the slashless first entry
    // renders with the root slash restored.
    expect(result).toEqual({
      ok: false,
      reason:
        "citation URL redirect loop detected (chain: https://example.org/ -> https://example.org/ -> https://example.org/)",
    });
  });

  it("detects an https/http scheme-oscillation cycle as a redirect loop", async () => {
    // Arizona Capitol Times live: https redirects to http, which redirects
    // back to https — a genuine cycle that must fail fast with the loop
    // reason, not the hop-limit reason.
    const { calls } = stubFetch((_method, url) => ({
      status: 302,
      location: url.startsWith("https://")
        ? url.replace("https://", "http://")
        : url.replace("http://", "https://"),
    }));

    const result = await verifyHttpUrlReachability("https://news.example.com/story");

    expect(calls.length).toBe(2);
    expect(result).toEqual({
      ok: false,
      reason:
        "citation URL redirect loop detected (chain: https://news.example.com/story -> http://news.example.com/story -> https://news.example.com/story)",
    });
  });

  it("redacts credentials and query strings from the reported redirect chain", async () => {
    // The signed hop was never in the citation payload; the reason must not
    // persist its token, userinfo, or fragment.
    const signedHop = "https://user:secretpass@files.gov/document.pdf?X-Amz-Signature=secret123#frag";
    stubFetch(() => ({ status: 302, location: signedHop }));

    const result = await verifyHttpUrlReachability("https://portal.gov/doc");

    expect(result.ok).toBe(false);
    const reason = (result as { ok: false; reason: string }).reason;
    expect(reason).toContain("citation URL redirect loop detected");
    expect(reason).toContain("https://files.gov/document.pdf?[redacted]");
    expect(reason).not.toContain("secret123");
    expect(reason).not.toContain("secretpass");
    expect(reason).not.toContain("X-Amz-Signature");
    expect(reason).not.toContain("#frag");
  });

  it("resolves relative Location headers against the current hop", async () => {
    const { calls } = stubFetch((_method, url) =>
      url.endsWith("/start") ? { status: 302, location: "/moved/here" } : { status: 200 }
    );

    const result = await verifyHttpUrlReachability("https://example.gov/start");

    expect(calls).toEqual([
      { method: "HEAD", url: "https://example.gov/start" },
      { method: "HEAD", url: "https://example.gov/moved/here" },
      { method: "GET", url: "https://example.gov/start" },
      { method: "GET", url: "https://example.gov/moved/here" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails a redirect that has no Location header", async () => {
    const { calls } = stubFetch((method) => (method === "HEAD" ? { status: 302 } : { status: 200 }));

    const result = await verifyHttpUrlReachability("https://example.gov/broken-redirect");

    expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
    expect(result).toEqual({ ok: false, reason: "citation URL redirect is missing a Location header" });
  });

  describe("429 Retry-After and per-host cooldown", () => {
    beforeEach(() => {
      resetCitationHostCooldownsForTests();
    });

    afterEach(() => {
      resetCitationHostCooldownsForTests();
      vi.useRealTimers();
    });

    it("surfaces a delta-seconds Retry-After on 429 in the reason and as a field", async () => {
      const { calls } = stubFetch(() => ({ status: 429, retryAfter: "7" }));

      const result = await verifyHttpUrlReachability("https://ratelimited-a.example.gov/page");

      expect(result).toEqual({
        ok: false,
        reason: "citation fetch returned status 429 (retry-after: 7s)",
        retryAfterSeconds: 7,
      });
      // Rate limiting is method-agnostic: a HEAD 429 is authoritative and
      // must NOT trigger the immediate GET confirmation — that would double
      // the burst and could mask the 429 behind a different GET status.
      expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
    });

    it("returns a plain 429 reason when Retry-After is absent or unparseable", async () => {
      stubFetch(() => ({ status: 429, retryAfter: "soon" }));

      const result = await verifyHttpUrlReachability("https://ratelimited-b.example.gov/page");

      expect(result).toEqual({ ok: false, reason: "citation fetch returned status 429" });
    });

    it("parses an HTTP-date Retry-After", async () => {
      stubFetch(() => ({
        status: 429,
        retryAfter: new Date(Date.now() + 10_000).toUTCString(),
      }));

      const result = await verifyHttpUrlReachability("https://ratelimited-c.example.gov/page");

      expect(result.ok).toBe(false);
      const failure = result as { retryAfterSeconds?: number };
      expect(failure.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(failure.retryAfterSeconds).toBeLessThanOrEqual(10);
    });

    it("caps an hour-scale Retry-After at the sanity ceiling", async () => {
      stubFetch(() => ({ status: 429, retryAfter: "3600" }));

      const result = await verifyHttpUrlReachability("https://ratelimited-d.example.gov/page");

      expect(result).toEqual({
        ok: false,
        reason: "citation fetch returned status 429 (retry-after: 900s)",
        retryAfterSeconds: 900,
      });
    });

    it("cools down the 429ing host before the next verification contacts it", async () => {
      vi.useFakeTimers();
      const { calls } = stubFetch((_method, url) =>
        url.includes("/limited") ? { status: 429, retryAfter: "2" } : { status: 200 }
      );

      const first = await verifyHttpUrlReachability("https://ratelimited-e.example.gov/limited");
      expect(first.ok).toBe(false);
      const callsAfterFirst = calls.length;

      let secondSettled = false;
      const second = verifyHttpUrlReachability("https://ratelimited-e.example.gov/other").then(
        (result) => {
          secondSettled = true;
          return result;
        }
      );

      // Before the cooldown elapses the second verification must not have
      // touched the host at all.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.length).toBe(callsAfterFirst);
      expect(secondSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      const secondResult = await second;
      expect(secondResult.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it("does not spend a confirming GET on a 429 that arrived behind a resource-changing redirect", async () => {
      // The redirect-confirmation arm is gated on response.ok, so a 429 at
      // the end of a redirected HEAD chain must fall through to the 429
      // branch (cooldown + Retry-After) instead of immediately re-walking
      // with GET — which would double the burst at the host that just asked
      // us to back off, and could mask the 429 behind a GET 200.
      const { calls } = stubFetch((_method, url) => {
        if (url === "https://frontdoor2.example.gov/doc") {
          return { status: 302, location: "https://cdn2.example.gov/doc.pdf" };
        }
        return { status: 429, retryAfter: "7" };
      });

      const result = await verifyHttpUrlReachability("https://frontdoor2.example.gov/doc");

      expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
      expect(result).toEqual({
        ok: false,
        reason: "citation fetch returned status 429 (retry-after: 7s)",
        retryAfterSeconds: 7,
      });
    });

    it("cools down the redirect target that actually returned the 429, not just the input host", async () => {
      vi.useFakeTimers();
      const { calls } = stubFetch((_method, url) => {
        if (url.includes("frontdoor.example.gov")) {
          return { status: 302, location: "https://cdn-docs.example.gov/file.pdf" };
        }
        if (url.includes("cdn-docs.example.gov/file.pdf")) {
          return { status: 429, retryAfter: "2" };
        }
        return { status: 200 };
      });

      const first = await verifyHttpUrlReachability("https://frontdoor.example.gov/doc");
      expect(first.ok).toBe(false);
      const callsAfterFirst = calls.length;

      // A later citation pointing DIRECTLY at the rate-limited CDN host must
      // wait out its cooldown even though the 429 arrived via a redirect.
      let directSettled = false;
      const direct = verifyHttpUrlReachability("https://cdn-docs.example.gov/other.pdf").then(
        (result) => {
          directSettled = true;
          return result;
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.length).toBe(callsAfterFirst);
      expect(directSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect((await direct).ok).toBe(true);
    });

    it("keeps a cooldown extended by a concurrent 429 alive across another waiter's wake-up", async () => {
      vi.useFakeTimers();
      stubFetch((_method, url) => {
        if (url.includes("/limited-short")) {
          return { status: 429, retryAfter: "1" };
        }
        if (url.includes("/limited-long")) {
          return { status: 429, retryAfter: "3" };
        }
        return { status: 200 };
      });

      const first = await verifyHttpUrlReachability("https://ratelimited-g.example.gov/limited-short");
      expect(first.ok).toBe(false);

      // Both wake when the 1s cooldown lapses; waiterB then 429s again and
      // extends the cooldown by 3s. waiterA's wake-path cleanup must not
      // erase that newer entry.
      const waiterA = verifyHttpUrlReachability("https://ratelimited-g.example.gov/ok");
      const waiterB = verifyHttpUrlReachability("https://ratelimited-g.example.gov/limited-long");
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await waiterA).ok).toBe(true);
      expect((await waiterB).ok).toBe(false);

      let lateSettled = false;
      const late = verifyHttpUrlReachability("https://ratelimited-g.example.gov/ok2").then(
        (result) => {
          lateSettled = true;
          return result;
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lateSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(3_000);
      expect((await late).ok).toBe(true);
    });

    it("keeps the longer deadline when a concurrent shorter 429 lands after a longer one", async () => {
      vi.useFakeTimers();
      // Two requests in flight before any cooldown exists: the long
      // Retry-After lands first, the short one 500ms later. A blind
      // replacement would let traffic resume after the SHORT deadline.
      vi.stubGlobal(
        "fetch",
        async (url: string | URL) => {
          const target = String(url);
          const respond = (retryAfter: string) =>
            ({
              ok: false,
              status: 429,
              headers: {
                get: (name: string) =>
                  name.toLowerCase() === "retry-after" ? retryAfter : null,
              },
              body: null,
            }) as unknown as Response;
          if (target.includes("/long")) {
            return respond("10");
          }
          if (target.includes("/short")) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return respond("1");
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: null,
          } as unknown as Response;
        }
      );

      const long = verifyHttpUrlReachability("https://ratelimited-h.example.gov/long");
      const short = verifyHttpUrlReachability("https://ratelimited-h.example.gov/short");
      await vi.advanceTimersByTimeAsync(0);
      expect((await long).ok).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect((await short).ok).toBe(false);

      let lateSettled = false;
      const late = verifyHttpUrlReachability("https://ratelimited-h.example.gov/ok").then(
        (result) => {
          lateSettled = true;
          return result;
        }
      );
      // Well past the short deadline (t=1500ms) but before the long one
      // (t=10000ms): the verification must still be waiting.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(lateSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(7_000);
      expect((await late).ok).toBe(true);
    });

    it("starts with GET on a host whose limiter has 429ed a HEAD before", async () => {
      vi.useFakeTimers();
      // This limiter throttles HEAD but serves GET — retrying HEAD would 429
      // forever and the citation would never be tested with GET.
      const { calls } = stubFetch((method) => (method === "HEAD" ? { status: 429 } : { status: 200 }));

      const first = await verifyHttpUrlReachability("https://headhostile.example.gov/doc");
      expect(first.ok).toBe(false);
      expect(calls.map((call) => call.method)).toEqual(["HEAD"]);

      await vi.advanceTimersByTimeAsync(1_000);
      const second = await verifyHttpUrlReachability("https://headhostile.example.gov/doc");
      expect(second.ok).toBe(true);
      expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    });

    it("refuses contact entirely while a Retry-After deadline beyond the wait bound is running", async () => {
      const { calls } = stubFetch(() => ({ status: 429, retryAfter: "900" }));

      const first = await verifyHttpUrlReachability("https://ratelimited-i.example.gov/limited");
      expect(first.ok).toBe(false);
      const callsAfterFirst = calls.length;

      // The host asked for 900s; the in-call bound is 15s. The verifier must
      // not sleep the bound and then contact the host anyway — it fails fast
      // with the remaining cooldown and performs ZERO network requests.
      const second = await verifyHttpUrlReachability("https://ratelimited-i.example.gov/other");
      expect(calls.length).toBe(callsAfterFirst);
      expect(second.ok).toBe(false);
      const failure = second as { reason: string; retryAfterSeconds?: number };
      expect(failure.reason).toMatch(
        /^citation fetch skipped: host rate-limit cooldown has \d+s remaining \(retry-after\)$/
      );
      expect(failure.retryAfterSeconds).toBeGreaterThan(880);
      expect(failure.retryAfterSeconds).toBeLessThanOrEqual(900);
      // Retryable by definition: the deadline passes on its own.
      expect(classifyCitationVerificationFailure(failure.reason)).toBe("transient");
    });

    it("does not delay verifications against other hosts", async () => {
      vi.useFakeTimers();
      const { calls } = stubFetch((_method, url) =>
        url.includes("ratelimited-f") ? { status: 429, retryAfter: "60" } : { status: 200 }
      );

      const first = await verifyHttpUrlReachability("https://ratelimited-f.example.gov/limited");
      expect(first.ok).toBe(false);

      let otherSettled = false;
      const other = verifyHttpUrlReachability("https://calm.example.gov/page").then((result) => {
        otherSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(otherSettled).toBe(true);
      expect((await other).ok).toBe(true);
      expect(calls.some((call) => call.url.includes("calm.example.gov"))).toBe(true);
    });
  });

  describe("fetch failure cause unwrapping", () => {
    it("surfaces the TLS cause hidden inside undici's bare fetch failed error", async () => {
      vi.stubGlobal(
        "fetch",
        async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("unable to verify the first certificate"), {
              code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            }),
          });
        }
      );

      const result = await verifyHttpUrlReachability("https://badcert.example.gov/page");

      expect(result).toEqual({
        ok: false,
        reason:
          "citation URL fetch failed: fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
      });
      // The unwrapped reason is what makes TLS failures classifiable at all:
      // the top-level message alone never matched the certificate patterns.
      expect(isTlsCertificateReachabilityFailure((result as { reason: string }).reason)).toBe(true);
      expect(classifyCitationVerificationFailure((result as { reason: string }).reason)).toBe(
        "permanent"
      );
    });

    it("classifies a hostname/SAN mismatch as a permanent TLS failure (wrong.host.badssl.com)", async () => {
      vi.stubGlobal(
        "fetch",
        async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(
              new Error(
                "Hostname/IP does not match certificate's altnames: Host: wrong.host.badssl.com. is not in the cert's altnames: DNS:*.badssl.com, DNS:badssl.com"
              ),
              { code: "ERR_TLS_CERT_ALTNAME_INVALID" }
            ),
          });
        }
      );

      const result = await verifyHttpUrlReachability("https://wrong.host.example.gov/page");

      expect(result.ok).toBe(false);
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(isTlsCertificateReachabilityFailure(reason)).toBe(true);
      expect(classifyCitationVerificationFailure(reason)).toBe("permanent");
    });

    it("falls back to the code when a cause has an empty message", async () => {
      vi.stubGlobal(
        "fetch",
        async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
          });
        }
      );

      const result = await verifyHttpUrlReachability("https://refused.example.gov/page");

      expect(result).toEqual({
        ok: false,
        reason: "citation URL fetch failed: fetch failed: ECONNREFUSED",
      });
    });

    it("surfaces socket-level codes and keeps them transient", async () => {
      vi.stubGlobal(
        "fetch",
        async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          });
        }
      );

      const result = await verifyHttpUrlReachability("https://flaky.example.gov/page");

      expect(result).toEqual({
        ok: false,
        reason: "citation URL fetch failed: fetch failed: read ECONNRESET (ECONNRESET)",
      });
      expect(classifyCitationVerificationFailure((result as { reason: string }).reason)).toBe(
        "transient"
      );
    });

    it("still reports a timeout as timed out, not as a generic failure", async () => {
      vi.stubGlobal(
        "fetch",
        async () => {
          throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        }
      );

      const result = await verifyHttpUrlReachability("https://slow.example.gov/page");

      expect(result).toEqual({ ok: false, reason: "citation URL fetch timed out" });
    });
  });
});

describe("classifyCitationVerificationFailure", () => {
  it("classifies TLS certificate failures as permanent even inside fetch failed wrappers", () => {
    expect(
      classifyCitationVerificationFailure(
        "citation URL fetch failed: fetch failed: certificate has expired (CERT_HAS_EXPIRED)"
      )
    ).toBe("permanent");
  });

  it("keeps rate limits and server errors transient", () => {
    expect(classifyCitationVerificationFailure("citation fetch returned status 429 (retry-after: 7s)")).toBe(
      "transient"
    );
    expect(classifyCitationVerificationFailure("citation fetch returned status 503")).toBe("transient");
    expect(classifyCitationVerificationFailure("citation URL fetch timed out")).toBe("transient");
    expect(classifyCitationVerificationFailure("citation URL DNS lookup failed transiently: EAI_AGAIN")).toBe(
      "transient"
    );
  });

  it("keeps missing pages and dead names permanent", () => {
    expect(classifyCitationVerificationFailure("citation fetch returned status 404")).toBe("permanent");
    expect(classifyCitationVerificationFailure("citation URL hostname could not be resolved")).toBe(
      "permanent"
    );
  });
});
