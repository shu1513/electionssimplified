/**
 * Cloudflare Worker: path router for electionssimplified.com.
 *
 * Implements the reverse-proxy split from docs/deploy-checklist.md on
 * Cloudflare instead of a self-managed proxy: /api/* and /sitemap.xml go to
 * the API service, everything else to the SSR server. Both origins are the
 * services' public *.onrender.com hosts (Render routes by Host header, so
 * the upstream URL's hostname is all that changes).
 *
 * Client IP: Cloudflare sets CF-Connecting-IP on every proxied request and
 * always overwrites a client-supplied copy, so its value is trustworthy at
 * this hop — but the servers must NOT read it directly. Both origins sit
 * behind Render's own Cloudflare, which rejects (403) outside clients that
 * present the reserved CF-Connecting-IP header — and would overwrite it with
 * the sender's socket IP even if it let the request through — so the SSR
 * loader could never relay that header to the API's public host. This
 * worker therefore copies the value into the custom X-Voteapp-Client-IP
 * header (CLIENT_IP_HEADER below), which passes through Render's edge
 * untouched; both servers read it via
 * ADDRESS_API_TRUSTED_CLIENT_IP_HEADER=X-Voteapp-Client-IP.
 *
 * Worker vars (set in the dashboard or wrangler.toml):
 *   API_ORIGIN — e.g. "voteapp-api.onrender.com"
 *   SSR_ORIGIN — e.g. "voteapp-ssr.onrender.com"
 *
 * Both must be BARE hostnames. They are validated, not trusted: assigning an
 * invalid value to url.hostname is a silent no-op per the URL spec, so an
 * unvalidated "https://host" or "  " would leave the public hostname in
 * place and make the Worker fetch its own URL instead of failing.
 *
 * Route: electionssimplified.com/* and www.electionssimplified.com/* (www 301s to
 * the apex so the canonical origin matches SITE_ORIGIN and robots.txt).
 *
 * Every response — proxied, redirect, or error — is stamped with the
 * baseline security headers (SECURITY_HEADERS below); neither origin sets
 * them, and note direct *.onrender.com responses bypass this stamping.
 */

// IndexNow ownership proof. The protocol scopes a key file to the directory
// it lives in (a key under /api/ could only vouch for /api/* URLs), so the
// public path is at the root and the Worker maps it onto the API route that
// serves the key from env (backend INDEXNOW_KEY_PATH).
export const INDEXNOW_PUBLIC_PATH = "/indexnow-key.txt";
export const INDEXNOW_API_PATH = "/api/indexnow-key.txt";

export function isApiPath(pathname) {
  return pathname === "/sitemap.xml" || pathname === INDEXNOW_PUBLIC_PATH || pathname === "/api" || pathname.startsWith("/api/");
}

/** The path recorded in a crawler log line: never a share-link token. */
export function crawlerLogPath(pathname) {
  // /picks/<token> and its API twin /api/pick-cards/<token>[/og-image.png]:
  // the token IS the authorization for a voter's shared picks, so it must
  // never land in persisted logs.
  if (/^\/picks\/[^/]+/i.test(pathname)) {
    return "/picks/:token";
  }
  if (/^\/api\/pick-cards\/[^/]+/i.test(pathname)) {
    return "/api/pick-cards/:token";
  }
  return pathname;
}

// ------------------------------------------------------------- crawlers ----
// Search and AI crawlers we want to see in the Workers Logs stream
// (wrangler.toml [observability]): one structured line per hit answers
// "is ChatGPT / Claude / Perplexity actually reading us, and which pages?"
// — the coverage question behind answer-engine optimization. robots.txt
// welcomes all of them; this is the read-side check that they come.
// Matched on the User-Agent token each vendor documents; order matters only
// where a token could appear in two rows (none today).
const CRAWLER_TOKENS = [
  ["openai", /\b(?:GPTBot|OAI-SearchBot|ChatGPT-User)\b/i],
  ["anthropic", /\b(?:ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai)\b/i],
  ["perplexity", /\b(?:PerplexityBot|Perplexity-User)\b/i],
  ["google", /\b(?:Googlebot|Google-Extended|GoogleOther)\b/i],
  ["bing", /\bbingbot\b/i],
  ["apple", /\bApplebot\b/i],
  ["meta", /\b(?:meta-externalagent|FacebookBot)\b/i],
  ["amazon", /\bAmazonbot\b/i],
  ["commoncrawl", /\bCCBot\b/i],
  ["duckduckgo", /\bDuckDuckBot\b/i],
];

/** The vendor name for a known search/AI crawler User-Agent, else null. */
export function classifyCrawler(userAgent) {
  if (!userAgent) {
    return null;
  }
  for (const [name, pattern] of CRAWLER_TOKENS) {
    if (pattern.test(userAgent)) {
      return name;
    }
  }
  return null;
}

// Custom (non-reserved) client-IP header both servers trust via
// ADDRESS_API_TRUSTED_CLIENT_IP_HEADER — see the module comment for why the
// reserved CF-Connecting-IP cannot be used past this hop. Cloudflare only
// protects its own CF-* headers, so the Worker must strip client-supplied
// copies itself before stamping.
export const CLIENT_IP_HEADER = "X-Voteapp-Client-IP";

// Baseline security headers, stamped on every response the Worker returns
// (proxied, redirect, or error) — neither origin sets them itself. The edge
// is authoritative: values here overwrite any upstream copy so the policy
// has one home. HSTS is safe because Cloudflare terminates TLS for every
// proxied record on the zone; skip `preload` so the commitment stays
// revocable.
//
// CSP ships Report-Only first: violations surface in the browser console
// without ever blocking a resource. There is deliberately no report-uri
// yet, so "observation" means the operator browsing the site with devtools
// open — adequate at this traffic level. Enforced since 2026-09-05 (see
// SECURITY_HEADERS); when a Sentry DSN goes live, add its security-report
// endpoint as report-uri so real-traffic violations become visible.
// Inventory behind the policy (2026-07, re-verified 2026-09-05): every loaded resource is
// same-origin (no fonts/analytics/CDN; external URLs in the app are plain
// hyperlinks). connect-src allows *.sentry.io because the frontend ships
// dark Sentry support (VITE_SENTRY_DSN, errorMonitoring.ts) — enforcing
// without it would silence error reporting the day the DSN is set.
// 'unsafe-inline' is required in script-src because React Router SSR
// hydrates via inline scripts (dropping it needs nonce plumbing between
// this Worker and the SSR origin), and in style-src for React inline style
// attributes. Browsers ignore frame-ancestors in Report-Only mode; it's
// staged here for the enforced policy, and X-Frame-Options DENY covers
// framing today.
// The accounts.google.com sources are Sign in with Google (GIS): the button
// script, its styles, the credential iframe, and its status requests —
// Google's documented CSP set for the web sign-in flow.
// The cloudflareinsights.com sources are Cloudflare Web Analytics: the zone
// setting injects beacon.min.js from static.cloudflareinsights.com into
// every HTML response and the beacon posts to cloudflareinsights.com;
// enforcing without them silently ended analytics collection (2026-09-05).
const CSP_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; " +
  "img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self' https://*.sentry.io https://accounts.google.com/gsi/ https://cloudflareinsights.com; " +
  // 'self': the instructions page frames our own /embed as its live example.
  "frame-src 'self' https://accounts.google.com/gsi/; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // Enforcing since 2026-09-05. The Report-Only phase never had a report-uri
  // (the report-to header on responses is Cloudflare NEL, not CSP), so it
  // collected nothing; the resource inventory above was re-verified by hand
  // instead: no <img>, @font-face, iframe, or form action reaches a host
  // outside 'self' plus the Google GIS and Sentry allowances.
  "Content-Security-Policy": CSP_POLICY,
};

// Pages whose URLs carry single-use auth tokens in the query string
// (email links land here). Under the default policy a same-origin request
// from these pages sends the full URL — token included — as the Referer,
// duplicating the secret into API request logs; no-referrer suppresses it.
// Deliberately NOT global: no-referrer makes browsers send "Origin: null"
// on non-CORS-mode POSTs (HTML form submissions), and the API's CORS
// middleware 403s unknown origins — a global policy would break the
// API-served unsubscribe confirmation form. SPA fetch() calls are
// CORS-mode, so their Origin header is unaffected by this policy.
const NO_REFERRER_PATHS = new Set(["/verify-email", "/verify-email-change", "/reset-password"]);

// The newsroom embed (frontend/public/embed.js) frames /embed (the landing
// page's address search) on third-party pages, so that one route must be
// allowed in any frame. Only that route: everything else keeps DENY +
// frame-ancestors 'none'. The pages a
// reader reaches from the box are client-side navigations inside the frame,
// never frame loads, and a third-party frame carries no session cookie, so
// clickjacking has no signed-in action to reach.
const EMBED_FRAMEABLE_PATH = /^\/embed\/?$/;
const EMBED_CSP_POLICY = CSP_POLICY.replace("frame-ancestors 'none'", "frame-ancestors *");

export function isFrameablePath(pathname) {
  return EMBED_FRAMEABLE_PATH.test(pathname.toLowerCase());
}

export function referrerPolicyForPath(pathname) {
  // React Router matches routes case-insensitively and ignores trailing
  // slashes, so /VERIFY-email or /verify-email/ still renders the token
  // page — normalize the same way or those variants leak the Referer.
  const normalized = pathname.toLowerCase().replace(/\/+$/, "");
  return NO_REFERRER_PATHS.has(normalized) ? "no-referrer" : SECURITY_HEADERS["Referrer-Policy"];
}

/**
 * Copies the response (upstream headers are immutable) and stamps the set.
 *
 * Content-Security-Policy is APPENDED when the upstream already sent one:
 * browsers enforce every CSP header on a response, so the stricter upstream
 * policy keeps applying and the site-wide one adds to it. Today that is the
 * API's unsubscribe page (default-src 'none' on a token-bearing URL) —
 * overwriting it would re-allow inline scripts there. Every other header
 * is overwritten so the edge stays authoritative.
 */
export function withSecurityHeaders(response, pathname = "") {
  const wrapped = new Response(response.body, response);
  const frameable = isFrameablePath(pathname);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (name === "X-Frame-Options" && frameable) {
      wrapped.headers.delete(name);
      continue;
    }
    if (name === "Content-Security-Policy" && frameable) {
      // Replace rather than append: browsers enforce every CSP header on a
      // response, so an upstream frame-ancestors 'none' would still block
      // the frame. Only our own SSR page is served on this path.
      wrapped.headers.set(name, EMBED_CSP_POLICY);
    } else if (name === "Content-Security-Policy" && wrapped.headers.has(name)) {
      wrapped.headers.append(name, value);
    } else {
      wrapped.headers.set(name, value);
    }
  }
  wrapped.headers.set("Referrer-Policy", referrerPolicyForPath(pathname));
  return wrapped;
}

// ---------------------------------------------------------------- cache ----
// Edge caching for public pages: the SSR loaders on these routes are
// anonymous by design (personalization happens client-side after hydration
// — see frontend/src/pages/CandidatePage.tsx), so their HTML is identical
// for every visitor and safe to share from cache. The origin can't declare
// this itself: frontend/server.js serves prerendered HTML with max-age=0
// and SSR responses with no Cache-Control at all, so the Worker owns the
// policy. Mechanism notes, learned the hard way:
//   - Zone Cache Rules never apply: Workers run before the zone cache, and
//     the subrequest goes to the *.onrender.com host, which zone rules
//     never match.
//   - fetch cf options (cacheEverything/cacheTtlByStatus) are silently
//     ignored here too: the *.onrender.com upstream sits on ANOTHER
//     Cloudflare account's zone (Render's), and a Worker can only drive its
//     own zone's cache — verified empirically 2026-08-07 (no CF-Cache-Status
//     on subrequests, no latency change).
//   - So the Worker uses the Cache API (caches.default) explicitly: match
//     by public URL, store only status-200 cookie-free responses with
//     s-maxage. Per-colo cache (each Cloudflare datacenter holds its own
//     copy) — exactly what spike absorption needs.
//
// Eligibility is deliberately narrow, all four conditions required:
//   GET + SSR-bound + allowlisted path + no session cookie on the request.
// The allowlist keeps /me/*, /picks/:token (token-authorized content),
// auth/token pages, and the 404 catch-all out of cache — the last also
// stops random-URL requests from filling the cache. The cookie gate means a
// logged-in user's request is never even cache-eligible, so a response
// generated for one can never be stored.
export const SESSION_COOKIE_NAME = "voteapp_auth_session";
export const EDGE_CACHE_TTL_SECONDS = 60;

const CACHEABLE_EXACT_PATHS = new Set(["/", "/ballot", "/browse", "/mission", "/methodology", "/stats", "/embed-instructions", "/support", "/support/member", "/support/once", "/disclaimer", "/terms", "/privacy"]);
// Exactly one path segment, mirroring the declared routes /elections/:id,
// /candidates/:id and /districts/:id (frontend/src/routes.ts). Nested paths
// like /elections/x/junk render the 404 catch-all and must stay
// cache-ineligible.
const CACHEABLE_DETAIL_PATH = /^\/(?:elections|candidates|districts)\/[^/]+$/;
// /browse/:state — the state's district list; two letters, nothing nested.
const CACHEABLE_BROWSE_STATE_PATH = /^\/browse\/[a-z]{2}$/;
// The newsroom box's front page: anonymous and publisher-neutral (the
// publisher code rides in the URL fragment, which never reaches the edge),
// so one cached copy serves every newsroom.
const CACHEABLE_EMBED_PATH = /^\/embed$/;

export function isCacheablePublicPage(pathname) {
  // React Router matches case-insensitively and ignores trailing slashes
  // (same normalization as referrerPolicyForPath). "/elections/" collapses
  // to "/elections", which matches neither list — that's the 404 catch-all
  // and stays uncached.
  const normalized = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return (
    CACHEABLE_EXACT_PATHS.has(normalized) ||
    CACHEABLE_DETAIL_PATH.test(normalized) ||
    CACHEABLE_BROWSE_STATE_PATH.test(normalized) ||
    CACHEABLE_EMBED_PATH.test(normalized)
  );
}

export function hasSessionCookie(cookieHeader) {
  if (!cookieHeader) {
    return false;
  }
  return new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=`).test(cookieHeader);
}

// Static files are identical for every visitor, cookie or not, so they get
// a wider edge policy than pages. Two kinds:
//   - /assets/<name>-<hash>.<ext>: the build stamps a content hash into the
//     filename (Vite/rolldown), so a URL can never point at different bytes;
//     origin already sends max-age=1y immutable, the edge just mirrors it.
//     Without this every first visit fetched ~500 KB of JS/CSS from Render.
//   - Root icons and share images (/favicon.ico, /ballot-logo.png,
//     /og-card.jpg ...): origin serves them with max-age=0. Changes ride on
//     a ?v= query (frontend/src/root.tsx, pageMeta.ts), which is part of the
//     cache key, so an hour of caching is safe and covers a plain rename too.
export const ASSET_CACHE_TTL_SECONDS = 31536000;
export const ROOT_FILE_CACHE_TTL_SECONDS = 3600;
const HASHED_ASSET_PATH = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
const ROOT_FILE_PATH = /^\/[a-z0-9-]+\.(?:png|jpg|ico|svg|webp)$/;

/** Cache-Control for a static file, shared by browser and edge, or null. */
export function staticCacheControl(pathname) {
  if (HASHED_ASSET_PATH.test(pathname)) {
    return `public, max-age=${ASSET_CACHE_TTL_SECONDS}, immutable`;
  }
  if (ROOT_FILE_PATH.test(pathname)) {
    return `public, max-age=${ROOT_FILE_CACHE_TTL_SECONDS}`;
  }
  return null;
}

// RFC 1123 label: 1-63 chars, alphanumeric at both ends, alphanumeric or
// hyphen inside. Deliberately stricter than the URL parser, which (with the
// non-strict IDNA browsers use) happily accepts ".", "foo..bar",
// "-bad.example", or "_bad.example" — values that would only fail later as
// an uncaught fetch() error instead of a controlled 503.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidDnsHostname(hostname) {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }
  return hostname.split(".").every((label) => DNS_LABEL.test(label));
}

/** Returns the validated, canonicalized bare hostname, or null. */
export function resolveUpstreamHost(raw) {
  const value = (raw ?? "").trim();
  if (!value) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    return null;
  }
  // A bare hostname round-trips exactly; a scheme, port, path, credentials,
  // or query string all leave residue that breaks the equality. The FQDN
  // trailing dot ("host.example.") is canonicalized away on BOTH sides
  // before comparing — the WHATWG spec keeps it in .hostname, but stripping
  // first makes the check hold even on a parser that normalizes it away,
  // and the self-proxy guard's equality can't be dodged by a dot that DNS
  // ignores.
  const hostname = parsed.hostname.replace(/\.$/, "");
  if (hostname !== value.toLowerCase().replace(/\.$/, "")) {
    return null;
  }
  return isValidDnsHostname(hostname) ? hostname : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The redirect reads no origin config — keep www working (301 to apex)
    // even while the vars are broken.
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice("www.".length);
      return withSecurityHeaders(Response.redirect(url.toString(), 301), url.pathname);
    }

    const apiHost = resolveUpstreamHost(env.API_ORIGIN);
    const ssrHost = resolveUpstreamHost(env.SSR_ORIGIN);
    if (!apiHost || !ssrHost) {
      return withSecurityHeaders(
        new Response(
          "Worker misconfigured: API_ORIGIN and SSR_ORIGIN must both be set to bare hostnames",
          { status: 503 }
        )
      );
    }

    const apiBound = isApiPath(url.pathname);
    const upstreamHost = apiBound ? apiHost : ssrHost;

    // One log line per crawler hit (see CRAWLER_TOKENS). Path only — no
    // query string, cookie, or IP, and share-link tokens redacted
    // (crawlerLogPath) — so the stream never holds a token or a reader's
    // identity. Filter the Workers Logs view on `event:crawler`.
    const crawler = classifyCrawler(request.headers.get("User-Agent"));
    if (crawler) {
      console.log(JSON.stringify({ event: "crawler", crawler, method: request.method, path: crawlerLogPath(url.pathname) }));
    }
    // The Worker owns both the apex and its www variant; an origin equal to
    // either would send traffic back into hostnames this Worker serves (or
    // their placeholder DNS records) instead of a real upstream.
    if (upstreamHost === url.hostname || upstreamHost === `www.${url.hostname}`) {
      return withSecurityHeaders(
        new Response(
          "Worker misconfigured: upstream origin equals the public hostname",
          { status: 503 }
        )
      );
    }

    url.hostname = upstreamHost;
    url.protocol = "https:";
    url.port = "";
    if (url.pathname === INDEXNOW_PUBLIC_PATH) {
      url.pathname = INDEXNOW_API_PATH;
    }

    // Re-wrap so method, headers, and body stream pass through; fetch()
    // rewrites the Host header to the new hostname automatically.
    const upstreamRequest = new Request(url.toString(), request);
    // Prove to the origin that this hop is the edge: with EDGE_SHARED_SECRET
    // set (Worker secret + the API/SSR env), the API only trusts the
    // client-IP header on requests carrying it, closing the direct
    // *.onrender.com header-spoofing bypass. Deliberately stamped on
    // SSR-bound requests too, not just API paths: the SSR loaders verify it
    // before relaying the client IP to the API, so a direct hit on the SSR
    // host can't launder a spoofed IP through the relay
    // (frontend/src/lib/loadFromApi.ts). Always drop a client-supplied copy
    // so the header only ever holds this Worker's value.
    upstreamRequest.headers.delete("X-Edge-Secret");
    const edgeSharedSecret = typeof env.EDGE_SHARED_SECRET === "string" ? env.EDGE_SHARED_SECRET.trim() : "";
    if (edgeSharedSecret) {
      upstreamRequest.headers.set("X-Edge-Secret", edgeSharedSecret);
    }
    // Copy Cloudflare's trusted client IP into the custom header the servers
    // read (module comment: the reserved CF-Connecting-IP can't cross
    // Render's own Cloudflare edge). Stamped on SSR-bound requests too so
    // the loaders can relay it to the API. Always drop a client-supplied
    // copy first — unlike CF-Connecting-IP, nothing else overwrites it.
    upstreamRequest.headers.delete(CLIENT_IP_HEADER);
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) {
      upstreamRequest.headers.set(CLIENT_IP_HEADER, clientIp);
    }
    // Edge cache for public pages (see the cache section above). Keyed by
    // the PUBLIC url (request.url, query included), never the upstream one,
    // so a service recreation that changes the onrender.com hostname can't
    // orphan or split cache entries. Only exact status 200 is stored:
    // unknown-id 404s, loader redirects, and origin errors during a Render
    // cold start must never become the shared response for a URL, and
    // cache.put throws on 206. A Set-Cookie response is never stored (none
    // is expected from SSR — belt and braces). The stored copy's
    // s-maxage=60 gives the shared cache its TTL while max-age=0 keeps
    // browsers revalidating; X-Voteapp-Edge-Cache: HIT/MISS is stamped for
    // verification (the zone's own cf-cache-status always reads DYNAMIC for
    // Worker responses). Served stale worst case: 60s — fine for pages that
    // change via research imports, not user actions.
    // Static files (see staticCacheControl) skip the path allowlist and the
    // cookie gate: a logged-in visitor's JS bundle is the same bytes, and
    // the shared Cache-Control is stamped on the served copy too so the
    // browser holds it as long as the edge does.
    const staticControl = request.method === "GET" && !apiBound ? staticCacheControl(url.pathname) : null;
    const pageEligible =
      request.method === "GET" &&
      !apiBound &&
      isCacheablePublicPage(url.pathname) &&
      !hasSessionCookie(request.headers.get("Cookie"));
    if (staticControl || pageEligible) {
      const cache = caches.default;
      const cached = await cache.match(request.url);
      if (cached) {
        const response = withSecurityHeaders(cached, url.pathname);
        response.headers.set("X-Voteapp-Edge-Cache", "HIT");
        return response;
      }
      const upstreamResponse = await fetch(upstreamRequest);
      if (upstreamResponse.status === 200 && !upstreamResponse.headers.has("Set-Cookie")) {
        const copy = upstreamResponse.clone();
        const stored = new Response(copy.body, copy);
        stored.headers.set(
          "Cache-Control",
          staticControl ?? `public, max-age=0, s-maxage=${EDGE_CACHE_TTL_SECONDS}`
        );
        // A failed put (e.g. a Vary: * response) must never break serving;
        // the next request just misses again.
        const storing = cache.put(request.url, stored).catch(() => {});
        if (ctx?.waitUntil) {
          ctx.waitUntil(storing);
        } else {
          await storing;
        }
      }
      const response = withSecurityHeaders(upstreamResponse, url.pathname);
      response.headers.set("X-Voteapp-Edge-Cache", "MISS");
      if (staticControl && upstreamResponse.status === 200) {
        response.headers.set("Cache-Control", staticControl);
      }
      return response;
    }
    return withSecurityHeaders(await fetch(upstreamRequest), url.pathname);
  },
};
