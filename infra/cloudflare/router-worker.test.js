import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import worker, {
  ASSET_CACHE_TTL_SECONDS,
  CLIENT_IP_HEADER,
  EDGE_CACHE_TTL_SECONDS,
  ROOT_FILE_CACHE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  classifyCrawler,
  crawlerLogPath,
  hasSessionCookie,
  isApiPath,
  isCacheablePublicPage,
  isFrameablePath,
  resolveUpstreamHost,
  staticCacheControl,
  withSecurityHeaders,
} from "./router-worker.js";

const ENV = {
  API_ORIGIN: "voteapp-api-pzns.onrender.com",
  SSR_ORIGIN: "voteapp-ssr-abcd.onrender.com",
};

const realFetch = globalThis.fetch;

/** Stubs global fetch, recording each proxied Request. */
function stubFetch() {
  const calls = [];
  globalThis.fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push(request);
    return new Response("upstream ok", { status: 200 });
  };
  return calls;
}

// Node has no `caches` global; the worker touches caches.default on
// cache-eligible paths, so every test gets a fresh in-memory fake.
beforeEach(() => {
  const entries = new Map();
  globalThis.caches = {
    default: {
      async match(url) {
        const stored = entries.get(url);
        return stored ? stored.clone() : undefined;
      },
      async put(url, response) {
        entries.set(url, response);
      },
    },
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});

describe("resolveUpstreamHost", () => {
  const accepted = [
    ["plain Render hostname", "voteapp-api-pzns.onrender.com", "voteapp-api-pzns.onrender.com"],
    ["surrounding whitespace trimmed", "  voteapp-api-pzns.onrender.com  ", "voteapp-api-pzns.onrender.com"],
    ["uppercase lowercased", "HOST.Example.COM", "host.example.com"],
    ["FQDN trailing dot canonicalized", "host.example.com.", "host.example.com"],
    ["single label", "localhost", "localhost"],
  ];
  for (const [name, input, expected] of accepted) {
    it(`accepts ${name}`, () => {
      assert.equal(resolveUpstreamHost(input), expected);
    });
  }

  const rejected = [
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["scheme prefix", "https://api.example.com"],
    ["port", "host.example.com:8443"],
    ["path", "host.example.com/path"],
    ["credentials", "user:pass@host.example.com"],
    ["query string", "host.example.com?x=1"],
    ["bare dot", "."],
    ["empty label", "foo..bar"],
    ["label starting with hyphen", "-bad.example"],
    ["label ending with hyphen", "bad-.example"],
    ["underscore label", "_bad.example"],
    ["label over 63 chars", `${"a".repeat(64)}.example`],
    ["hostname over 253 chars", `${`${"a".repeat(63)}.`.repeat(4)}${"b".repeat(10)}`],
    ["spaces inside", "not a host"],
  ];
  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      assert.equal(resolveUpstreamHost(input), null);
    });
  }
});

describe("isApiPath", () => {
  it("routes API and sitemap paths to the API service", () => {
    for (const path of ["/api", "/api/", "/api/elections/x", "/sitemap.xml"]) {
      assert.equal(isApiPath(path), true, path);
    }
  });

  it("routes everything else to SSR", () => {
    for (const path of ["/", "/apifoo", "/elections/x", "/sitemap.xml.bak"]) {
      assert.equal(isApiPath(path), false, path);
    }
  });
});

describe("fetch handler", () => {
  it("301s www to the apex even with no origin config", async () => {
    const response = await worker.fetch(new Request("https://www.electionssimplified.com/ballot?d=1"), {});
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "https://electionssimplified.com/ballot?d=1");
  });

  it("503s when either origin var is missing", async () => {
    for (const env of [{}, { API_ORIGIN: ENV.API_ORIGIN }, { SSR_ORIGIN: ENV.SSR_ORIGIN }]) {
      const response = await worker.fetch(new Request("https://electionssimplified.com/"), env);
      assert.equal(response.status, 503);
    }
  });

  it("503s on malformed origins instead of proxying", async () => {
    for (const bad of ["   ", "https://api.example.com", "foo..bar", "-bad.example"]) {
      const response = await worker.fetch(new Request("https://electionssimplified.com/"), {
        ...ENV,
        SSR_ORIGIN: bad,
      });
      assert.equal(response.status, 503, bad);
      // Malformed values must be rejected by validation, not reach the
      // self-proxy guard.
      assert.match(await response.text(), /must both be set/, new Error(bad));
    }
  });

  it("503s when an origin points back at the apex, www, or dotted self", async () => {
    for (const self of ["electionssimplified.com", "www.electionssimplified.com", "electionssimplified.com."]) {
      const response = await worker.fetch(new Request("https://electionssimplified.com/"), {
        ...ENV,
        SSR_ORIGIN: self,
      });
      assert.equal(response.status, 503, self);
      // The body pins WHICH guard fired: these are syntactically valid
      // hostnames that must reach and trip the self-proxy check (the dotted
      // form specifically proves canonicalization ran before the equality).
      assert.match(await response.text(), /upstream origin equals/, new Error(self));
    }
  });

  it("proxies API paths to the API origin and the rest to SSR", async () => {
    const calls = stubFetch();

    await worker.fetch(new Request("https://electionssimplified.com/api/elections/x?y=1"), ENV);
    await worker.fetch(new Request("https://electionssimplified.com/sitemap.xml"), ENV);
    await worker.fetch(new Request("https://electionssimplified.com/elections/x"), ENV);

    assert.deepEqual(
      calls.map((request) => new URL(request.url).hostname),
      [ENV.API_ORIGIN, ENV.API_ORIGIN, ENV.SSR_ORIGIN]
    );
    assert.equal(new URL(calls[0].url).search, "?y=1");
  });

  it("attaches the edge shared secret when configured and strips client-supplied copies", async () => {
    const calls = stubFetch();

    await worker.fetch(
      new Request("https://electionssimplified.com/api/auth/login", {
        method: "POST",
        headers: { "x-edge-secret": "attacker-guess" },
        body: "{}",
      }),
      { ...ENV, EDGE_SHARED_SECRET: "real-secret-value" }
    );
    await worker.fetch(
      new Request("https://electionssimplified.com/api/elections", {
        headers: { "x-edge-secret": "attacker-guess" },
      }),
      ENV
    );

    // Configured: the Worker's value replaces the client's.
    assert.equal(calls[0].headers.get("x-edge-secret"), "real-secret-value");
    // Not configured: the client-supplied copy must still be dropped.
    assert.equal(calls[1].headers.get("x-edge-secret"), null);
  });

  it("copies CF-Connecting-IP into the custom client-IP header and strips client-supplied copies", async () => {
    const calls = stubFetch();

    // Real edge request: Cloudflare stamped cf-connecting-ip, the client
    // tried to smuggle its own copy of the custom header.
    await worker.fetch(
      new Request("https://electionssimplified.com/api/elections", {
        headers: { "cf-connecting-ip": "203.0.113.9", [CLIENT_IP_HEADER]: "198.51.100.99" },
      }),
      ENV
    );
    // SSR-bound request: stamped there too so loaders can relay it.
    await worker.fetch(
      new Request("https://electionssimplified.com/elections/x", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      ENV
    );
    // No CF-Connecting-IP (e.g. tests): the spoofed copy must still die.
    await worker.fetch(
      new Request("https://electionssimplified.com/api/elections", {
        headers: { [CLIENT_IP_HEADER]: "198.51.100.99" },
      }),
      ENV
    );

    assert.equal(calls[0].headers.get(CLIENT_IP_HEADER), "203.0.113.9");
    assert.equal(calls[1].headers.get(CLIENT_IP_HEADER), "203.0.113.9");
    assert.equal(calls[2].headers.get(CLIENT_IP_HEADER), null);
  });

  it("preserves method and headers on the proxied request", async () => {
    const calls = stubFetch();

    await worker.fetch(
      new Request("https://electionssimplified.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: "{}",
      }),
      ENV
    );

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("cf-connecting-ip"), "203.0.113.9");
    assert.equal(new URL(calls[0].url).pathname, "/api/auth/login");
  });
});

describe("isCacheablePublicPage", () => {
  const cacheable = [
    "/",
    "/ballot",
    "/mission",
    "/support",
    "/support/member",
    "/support/once",
    "/disclaimer",
    "/terms",
    "/privacy",
    "/elections/abc123",
    "/candidates/abc123",
    "/districts/abc123",
    "/browse",
    "/browse/ky",
    "/Browse/KY/",
    "/embed",
    "/Embed/",
    // React Router renders these variants too — same normalization rules
    // as the referrer policy.
    "/Elections/ABC",
    "/candidates/abc/",
    "/ballot///",
  ];
  for (const path of cacheable) {
    it(`caches ${path}`, () => {
      assert.equal(isCacheablePublicPage(path), true, path);
    });
  }

  const uncacheable = [
    // Personalized / token-authorized pages.
    "/me/picks",
    "/me/ballot",
    "/me/settings",
    "/picks/share-token-123",
    // Auth and token-bearing pages.
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/verify-email-change",
    // Bare prefixes are the 404 catch-all, as is any random URL — keeping
    // them out stops junk URLs from filling the cache.
    "/elections",
    "/elections/",
    "/candidates",
    "/anything-else",
    // Nested paths under the detail routes are also the 404 catch-all: the
    // declared routes are exactly /elections/:id and /candidates/:id.
    "/elections/x/junk",
    "/candidates/x/settings",
    "/districts",
    "/districts/x/junk",
    // /browse/:state is two letters; anything else is the catch-all.
    "/browse/kentucky",
    "/browse/ky/junk",
  ];
  for (const path of uncacheable) {
    it(`does not cache ${path}`, () => {
      assert.equal(isCacheablePublicPage(path), false, path);
    });
  }
});

describe("hasSessionCookie", () => {
  it("detects the session cookie in any position", () => {
    assert.equal(hasSessionCookie(`${SESSION_COOKIE_NAME}=abc`), true);
    assert.equal(hasSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=abc; more=2`), true);
  });

  it("ignores absent, empty, and lookalike cookies", () => {
    assert.equal(hasSessionCookie(null), false);
    assert.equal(hasSessionCookie(""), false);
    assert.equal(hasSessionCookie("other=1; unrelated=2"), false);
    // A cookie whose name merely contains the session name must not match.
    assert.equal(hasSessionCookie(`x${SESSION_COOKIE_NAME}=abc`), false);
  });
});

describe("edge cache", () => {
  it("serves the second identical anonymous request from cache", async () => {
    const calls = stubFetch();

    const first = await worker.fetch(new Request("https://electionssimplified.com/elections/x"), ENV);
    const second = await worker.fetch(new Request("https://electionssimplified.com/elections/x"), ENV);

    assert.equal(first.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(second.headers.get("x-voteapp-edge-cache"), "HIT");
    // The origin was reached exactly once; the hit came from the cache.
    assert.equal(calls.length, 1);
    assert.equal(await second.text(), "upstream ok");
    // Stored copy carries the shared-cache TTL; max-age=0 keeps browsers
    // revalidating so only Cloudflare's edge holds the page for 60s.
    assert.equal(second.headers.get("cache-control"), `public, max-age=0, s-maxage=${EDGE_CACHE_TTL_SECONDS}`);
    // Cached responses are stamped like any other.
    assert.equal(second.headers.get("x-frame-options"), "DENY");
  });

  it("keys the cache by full URL including the query string", async () => {
    const calls = stubFetch();

    await worker.fetch(new Request("https://electionssimplified.com/elections/x"), ENV);
    const other = await worker.fetch(new Request("https://electionssimplified.com/elections/x?tab=finance"), ENV);

    assert.equal(other.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(calls.length, 2);
  });

  it("never stores non-200 responses", async () => {
    let originHits = 0;
    globalThis.fetch = async () => {
      originHits += 1;
      return new Response("not found", { status: 404 });
    };

    const first = await worker.fetch(new Request("https://electionssimplified.com/elections/gone"), ENV);
    const second = await worker.fetch(new Request("https://electionssimplified.com/elections/gone"), ENV);

    assert.equal(first.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(second.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(originHits, 2);
  });

  it("never stores Set-Cookie responses", async () => {
    let originHits = 0;
    globalThis.fetch = async () => {
      originHits += 1;
      return new Response("ok", { status: 200, headers: { "set-cookie": "sneaky=1" } });
    };

    await worker.fetch(new Request("https://electionssimplified.com/ballot"), ENV);
    const second = await worker.fetch(new Request("https://electionssimplified.com/ballot"), ENV);

    assert.equal(second.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(originHits, 2);
  });

  it("bypasses the cache entirely for ineligible requests", async () => {
    const calls = stubFetch();

    // Warm the cache anonymously, then prove a logged-in request for the
    // SAME url still reaches the origin instead of the stored copy.
    await worker.fetch(new Request("https://electionssimplified.com/elections/x"), ENV);
    const cookied = await worker.fetch(
      new Request("https://electionssimplified.com/elections/x", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=session-value`, "cf-connecting-ip": "203.0.113.9" },
      }),
      ENV
    );
    assert.equal(cookied.headers.get("x-voteapp-edge-cache"), null);
    assert.equal(calls.length, 2);
    // The rest of the proxy pipeline (client-IP stamping) is unaffected.
    assert.equal(calls[1].headers.get(CLIENT_IP_HEADER), "203.0.113.9");

    // API paths (even GET), non-GET, and unlisted paths never touch cache.
    const api = await worker.fetch(new Request("https://electionssimplified.com/api/elections"), ENV);
    const post = await worker.fetch(
      new Request("https://electionssimplified.com/ballot", { method: "POST", body: "{}" }),
      ENV
    );
    const unlisted = await worker.fetch(new Request("https://electionssimplified.com/me/picks"), ENV);
    for (const response of [api, post, unlisted]) {
      assert.equal(response.headers.get("x-voteapp-edge-cache"), null);
    }
    assert.equal(calls.length, 5);
  });
});

describe("staticCacheControl", () => {
  it("marks hashed build assets immutable for a year", () => {
    for (const path of ["/assets/entry.client-Cf5aF4Cg.js", "/assets/root-BJo8eCSe.css", "/assets/RouteError-DJEVEI-1.js"]) {
      assert.equal(staticCacheControl(path), `public, max-age=${ASSET_CACHE_TTL_SECONDS}, immutable`, path);
    }
  });

  it("caches root icons and share images for an hour", () => {
    for (const path of ["/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png", "/ballot-logo.png", "/og-card.jpg"]) {
      assert.equal(staticCacheControl(path), `public, max-age=${ROOT_FILE_CACHE_TTL_SECONDS}`, path);
    }
  });

  it("leaves pages, API paths, and unhashed asset names alone", () => {
    for (const path of ["/", "/elections/x", "/api/elections", "/assets/entry.client.js", "/assets/nested/x-Cf5aF4Cg.js", "/robots.txt", "/sitemap.xml", "/me/picks.png"]) {
      assert.equal(staticCacheControl(path), null, path);
    }
  });
});

describe("static edge cache", () => {
  it("serves hashed assets from cache even for logged-in visitors", async () => {
    const calls = stubFetch();
    const url = "https://electionssimplified.com/assets/entry.client-Cf5aF4Cg.js";

    const first = await worker.fetch(new Request(url), ENV);
    const second = await worker.fetch(
      new Request(url, { headers: { cookie: `${SESSION_COOKIE_NAME}=session-value` } }),
      ENV
    );

    assert.equal(first.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(second.headers.get("x-voteapp-edge-cache"), "HIT");
    assert.equal(calls.length, 1);
    // Browser and edge share the same year-long immutable policy.
    const expected = `public, max-age=${ASSET_CACHE_TTL_SECONDS}, immutable`;
    assert.equal(first.headers.get("cache-control"), expected);
    assert.equal(second.headers.get("cache-control"), expected);
  });

  it("caches root icons for an hour, keyed by the version query", async () => {
    const calls = stubFetch();

    const first = await worker.fetch(new Request("https://electionssimplified.com/favicon.ico?v=2"), ENV);
    const second = await worker.fetch(new Request("https://electionssimplified.com/favicon.ico?v=2"), ENV);
    const bumped = await worker.fetch(new Request("https://electionssimplified.com/favicon.ico?v=3"), ENV);

    assert.equal(first.headers.get("cache-control"), `public, max-age=${ROOT_FILE_CACHE_TTL_SECONDS}`);
    assert.equal(second.headers.get("x-voteapp-edge-cache"), "HIT");
    assert.equal(bumped.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(calls.length, 2);
  });

  it("never stores or relabels a missing asset", async () => {
    let originHits = 0;
    globalThis.fetch = async () => {
      originHits += 1;
      return new Response("not found", { status: 404 });
    };
    const url = "https://electionssimplified.com/assets/gone-Cf5aF4Cg.js";

    const first = await worker.fetch(new Request(url), ENV);
    const second = await worker.fetch(new Request(url), ENV);

    assert.equal(first.headers.get("cache-control"), null);
    assert.equal(second.headers.get("x-voteapp-edge-cache"), "MISS");
    assert.equal(originHits, 2);
  });
});

describe("security headers", () => {
  const EXPECTED = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com; " +
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; " +
      "img-src 'self' data:; font-src 'self'; " +
      "connect-src 'self' https://*.sentry.io https://accounts.google.com/gsi/ https://cloudflareinsights.com; " +
      "frame-src 'self' https://accounts.google.com/gsi/; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  };

  function assertSecurityHeaders(response) {
    for (const [name, value] of Object.entries(EXPECTED)) {
      assert.equal(response.headers.get(name), value, name);
    }
  }

  it("stamps proxied responses while preserving status, body, and upstream headers", async () => {
    globalThis.fetch = async () =>
      new Response("upstream body", { status: 201, headers: { "x-upstream": "kept" } });

    const response = await worker.fetch(new Request("https://electionssimplified.com/api/elections"), ENV);

    assertSecurityHeaders(response);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-upstream"), "kept");
    assert.equal(await response.text(), "upstream body");
  });

  it("overwrites upstream copies so the edge stays authoritative", async () => {
    globalThis.fetch = async () =>
      new Response("ok", { headers: { "x-frame-options": "ALLOWALL" } });

    const response = await worker.fetch(new Request("https://electionssimplified.com/"), ENV);

    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  it("stamps the www redirect and misconfiguration responses", async () => {
    const redirect = await worker.fetch(new Request("https://www.electionssimplified.com/ballot"), {});
    assertSecurityHeaders(redirect);
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "https://electionssimplified.com/ballot");

    const misconfigured = await worker.fetch(new Request("https://electionssimplified.com/"), {});
    assertSecurityHeaders(misconfigured);
    assert.equal(misconfigured.status, 503);
  });

  it("uses no-referrer on token-bearing auth pages and the default elsewhere", async () => {
    stubFetch();

    // Includes case and trailing-slash variants: React Router still renders
    // the token page for those, so the policy must cover them too.
    for (const path of [
      "/verify-email",
      "/verify-email-change",
      "/reset-password",
      "/VERIFY-email",
      "/verify-email/",
      "/reset-password///",
    ]) {
      const response = await worker.fetch(
        new Request(`https://electionssimplified.com${path}?token=secret`),
        ENV
      );
      assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
    }

    // The API-served unsubscribe page must keep the default: no-referrer
    // would make its HTML form POST send "Origin: null", which the API's
    // CORS allowlist rejects.
    for (const path of ["/", "/api/email/unsubscribe", "/login"]) {
      const response = await worker.fetch(new Request(`https://electionssimplified.com${path}`), ENV);
      assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    }
  });

  it("withSecurityHeaders lets only the embed routes be framed", () => {
    for (const path of ["/embed", "/embed/"]) {
      const home = withSecurityHeaders(new Response("ok"), path);
      assert.equal(home.headers.get("X-Frame-Options"), null, path);
      assert.match(home.headers.get("Content-Security-Policy"), /frame-ancestors \*/, path);
    }
    const framed = withSecurityHeaders(new Response("ok"), "/embed");
    assert.equal(framed.headers.get("X-Frame-Options"), null);
    assert.match(framed.headers.get("Content-Security-Policy"), /frame-ancestors \*/);
    assert.doesNotMatch(framed.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    // Everything else the site-wide policy says still applies there.
    assert.match(framed.headers.get("Content-Security-Policy"), /default-src 'self'/);
    assert.equal(framed.headers.get("X-Content-Type-Options"), "nosniff");

    // The pages a reader reaches from the box (ballot, races, candidates,
    // draft) are client-side navigations only: loading them in a frame stays
    // refused.
    for (const path of ["/embed/city/austin-tx", "/embed/anything", "/embedded", "/", "/ballot", "/draft", "/candidates/abc"]) {
      const plain = withSecurityHeaders(new Response("ok"), path);
      assert.equal(plain.headers.get("X-Frame-Options"), "DENY", path);
      assert.match(plain.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/, path);
    }
  });

  it("withSecurityHeaders replaces an upstream CSP on the embed route instead of appending", () => {
    const upstream = new Response("ok", { headers: { "Content-Security-Policy": "frame-ancestors 'none'" } });
    const framed = withSecurityHeaders(upstream, "/embed");
    const policies = framed.headers.get("Content-Security-Policy");
    assert.doesNotMatch(policies, /frame-ancestors 'none'/);
    assert.match(policies, /frame-ancestors \*/);
    assert.equal(policies.split(",").length, 1);
  });

  it("isFrameablePath matches the embed route only", () => {
    assert.equal(isFrameablePath("/embed"), true);
    assert.equal(isFrameablePath("/Embed/"), true);
    assert.equal(isFrameablePath("/embedded"), false);
    assert.equal(isFrameablePath("/embed/city/austin-tx"), false);
    assert.equal(isFrameablePath("/embed.js"), false);
  });

  it("withSecurityHeaders enforces the CSP rather than only reporting it", () => {
    const stamped = withSecurityHeaders(new Response("ok"));
    const csp = stamped.headers.get("content-security-policy");

    assert.ok(csp, "Content-Security-Policy header must be set");
    assert.equal(stamped.headers.get("content-security-policy-report-only"), null);
    // The allowances the live pages depend on: SSR hydration inline
    // scripts, Google Sign-In, and Sentry error reporting.
    assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/accounts\.google\.com\/gsi\/client/);
    assert.match(csp, /connect-src 'self' https:\/\/\*\.sentry\.io https:\/\/accounts\.google\.com\/gsi\//);
    assert.match(csp, /frame-ancestors 'none'/);
    // Cloudflare Web Analytics beacon, injected by the zone into every page.
    assert.match(csp, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
    assert.match(csp, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
  });

  it("withSecurityHeaders keeps an upstream CSP and appends the site-wide one instead of replacing it", () => {
    const upstreamCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    const stamped = withSecurityHeaders(
      new Response("<!doctype html>", { headers: { "content-security-policy": upstreamCsp, "x-frame-options": "SAMEORIGIN" } }),
      "/api/email/unsubscribe"
    );

    // Headers.get joins repeated headers with ", "; browsers enforce each
    // policy independently, so the stricter upstream one still applies.
    const csp = stamped.headers.get("content-security-policy");
    assert.ok(csp.startsWith(upstreamCsp + ", default-src 'self';"), csp);
    // Every other baseline header is still overwritten by the edge value.
    assert.equal(stamped.headers.get("x-frame-options"), "DENY");
  });

  it("classifyCrawler names the documented search and AI crawler tokens and nothing else", () => {
    assert.equal(classifyCrawler("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"), "openai");
    assert.equal(classifyCrawler("Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)"), "openai");
    assert.equal(classifyCrawler("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), "anthropic");
    assert.equal(classifyCrawler("Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot)"), "anthropic");
    assert.equal(classifyCrawler("Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"), "perplexity");
    assert.equal(classifyCrawler("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), "bing");
    assert.equal(classifyCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), "google");
    // A browser, an empty header, and a missing header are all "not a crawler".
    assert.equal(classifyCrawler("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36"), null);
    assert.equal(classifyCrawler(""), null);
    assert.equal(classifyCrawler(null), null);
  });

  it("logs one structured line per crawler hit with the path only", async () => {
    stubFetch();
    const lines = [];
    const realLog = console.log;
    console.log = (line) => lines.push(line);
    try {
      await worker.fetch(
        new Request("https://electionssimplified.com/elections/e-1?utm_source=chatgpt.com", {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", Cookie: `${SESSION_COOKIE_NAME}=secret` },
        }),
        ENV
      );
      await worker.fetch(new Request("https://electionssimplified.com/", { headers: { "User-Agent": "Mozilla/5.0 Chrome/128.0" } }), ENV);
    } finally {
      console.log = realLog;
    }
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { event: "crawler", crawler: "anthropic", method: "GET", path: "/elections/e-1" });
    // Neither the query string nor the cookie reaches the log.
    assert.ok(!lines[0].includes("utm_source"));
    assert.ok(!lines[0].includes("secret"));
  });

  it("redacts share-link tokens from the crawler log path", () => {
    assert.equal(crawlerLogPath("/picks/abc123TOKEN"), "/picks/:token");
    assert.equal(crawlerLogPath("/PICKS/abc123TOKEN/"), "/picks/:token");
    assert.equal(crawlerLogPath("/elections/e-1"), "/elections/e-1");
    assert.equal(crawlerLogPath("/picks"), "/picks");
  });

  it("serves the IndexNow key from the site root by mapping it onto the API route", async () => {
    const calls = stubFetch();
    await worker.fetch(new Request("https://electionssimplified.com/indexnow-key.txt"), ENV);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).hostname, ENV.API_ORIGIN);
    assert.equal(new URL(calls[0].url).pathname, "/api/indexnow-key.txt");
    assert.equal(isApiPath("/indexnow-key.txt"), true);
  });

  it("withSecurityHeaders copies immutable-header responses instead of mutating", () => {
    const original = Response.redirect("https://electionssimplified.com/", 301);
    const stamped = withSecurityHeaders(original);

    assert.equal(stamped.headers.get("x-content-type-options"), "nosniff");
    assert.equal(stamped.headers.get("location"), "https://electionssimplified.com/");
    assert.equal(original.headers.get("x-content-type-options"), null);
  });
});
