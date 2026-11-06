// Server-side data fetch for route loaders. Framework mode strips `loader`
// exports (and this module with them) from the client bundle, so this only
// ever runs in Node — first on the SSR document request, then via the
// framework's own .data requests on client navigations.
//
// Deliberately near-bare fetch: never forward the browser's cookies or auth
// headers. Both detail endpoints return session-dependent fields
// (is_following / follow) when a session cookie rides along; forwarding
// would bake one user's personalized state into server HTML that crawlers
// read and a CDN would cache for everyone. Personalization stays in
// client-side TanStack Query.
//
// The ONE header that does get relayed is the deployment's trusted
// client-IP header (ADDRESS_API_TRUSTED_CLIENT_IP_HEADER — same env var the
// API server reads). The API rate-limits per client IP; without the relay,
// every loader fetch arrives from the SSR server's own socket IP and the
// entire site's detail-page traffic shares a single rate-limit bucket — one
// sitemap-following crawler could 429 the bucket and take detail pages down
// for everyone. When the env var or header is absent (dev), nothing is sent
// and the API falls back to socket-IP keying as before.
//
// With EDGE_SHARED_SECRET set, the relay itself is gated: the edge Worker
// stamps X-Edge-Secret on every request it proxies (SSR-bound included),
// and the loader only relays the client-IP header when the incoming request
// carries the matching value. Otherwise a direct hit on the SSR's public
// *.onrender.com host could launder a spoofed IP through this relay — the
// loader would forward the fake IP together with its own valid secret and
// the API would trust it, re-opening per-IP rate-limit bypass for the
// endpoints loaders reach.

import { DEMO_API_HEADERS, isDemoMode } from "./demoMode";

// Generous for a loopback/private-network hop (normally milliseconds): a
// stalled API must fail the render fast instead of pinning SSR request
// handlers until undici's ~300s default timeouts fire.
const DEFAULT_LOADER_TIMEOUT_MS = 10_000;

/**
 * API_LOADER_TIMEOUT_MS raises the ceiling when the API needs time to answer
 * at all — concretely, a free-tier instance cold-starting from idle takes
 * about a minute to wake, and the default would 504 every wake-up request.
 * Invalid values fall back to the default.
 */
function resolveLoaderTimeoutMs(): number {
  const raw = process.env.API_LOADER_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_LOADER_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOADER_TIMEOUT_MS;
}

function rethrowTimeoutAs504(error: unknown): never {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    throw new Response("Upstream API timeout", { status: 504 });
  }
  throw error;
}

/**
 * API base resolution, most preferred first:
 * 1. API_INTERNAL_URL — explicit full URL; overrides everything (dev, or
 *    any topology the tiers below don't describe).
 * 2. API_INTERNAL_HOSTPORT — "host:port" on the private network, e.g. a
 *    Render blueprint `fromService` hostport reference that tracks the
 *    assigned internal hostname across service recreation. Plain http:
 *    private-network traffic isn't TLS-terminated. Preferred over the
 *    public tier so upgrading to private networking is one blueprint edit.
 * 3. API_PUBLIC_HOST — the API's public hostname (e.g. a Render
 *    RENDER_EXTERNAL_HOSTNAME reference), https. The free-tier fallback:
 *    free instances can send private-network traffic but not receive it.
 * 4. Loopback default for local dev.
 */
function resolveApiBase(): string {
  // Paths are appended verbatim and always start with "/"; a trailing slash
  // on any of these would produce "//api/..." — which the API server's
  // exact path matching 404s — so strip it rather than 404 every loader.
  const explicitUrl = process.env.API_INTERNAL_URL;
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/, "");
  }
  const hostport = process.env.API_INTERNAL_HOSTPORT;
  if (hostport) {
    return `http://${hostport.replace(/\/+$/, "")}`;
  }
  const publicHost = process.env.API_PUBLIC_HOST;
  if (publicHost) {
    return `https://${publicHost.replace(/\/+$/, "")}`;
  }
  return "http://127.0.0.1:3001";
}

// Constant-time string comparison without node:crypto (this module rides
// through the client bundler even though only the server executes it). The
// loop always runs over the longer input and folds the length difference
// into the result, so neither an early exit nor the iteration count leaks
// where a guess diverges from the secret.
function timingSafeStringEqual(presented: string, expected: string): boolean {
  const length = Math.max(presented.length, expected.length);
  // Unequal lengths already force a nonzero result here, so the loop's
  // out-of-range padding (charCodeAt is NaN past the end; NaN | 0 is 0)
  // can never turn a length mismatch into a match.
  let mismatch = presented.length ^ expected.length;
  for (let i = 0; i < length; i += 1) {
    mismatch |= (presented.charCodeAt(i) | 0) ^ (expected.charCodeAt(i) | 0);
  }
  return mismatch === 0;
}

export async function loadFromApi<T>(path: string, incomingRequest: Request): Promise<T> {
  const base = resolveApiBase();
  const headers = new Headers();
  // Same env var the API and the Worker hold; absent (dev) nothing is sent
  // and the relay below stays ungated, matching the API's legacy behavior.
  const edgeSharedSecret = process.env.EDGE_SHARED_SECRET?.trim();
  const trustedIpHeader = process.env.ADDRESS_API_TRUSTED_CLIENT_IP_HEADER;
  if (trustedIpHeader) {
    const clientIpValue = incomingRequest.headers.get(trustedIpHeader);
    // Relay only when the incoming request proves it came through the edge
    // Worker (see module comment): a direct hit on the SSR host carries no
    // proof and must not get its spoofed client IP laundered into a request
    // that DOES carry this server's valid secret.
    const incomingProof = incomingRequest.headers.get("x-edge-secret");
    const edgeVerified =
      !edgeSharedSecret || (incomingProof !== null && timingSafeStringEqual(incomingProof, edgeSharedSecret));
    if (clientIpValue && edgeVerified) {
      headers.set(trustedIpHeader, clientIpValue);
    }
  }
  // Proves to the API that this hop is trusted, so the relayed header above
  // is honored for per-user rate buckets instead of ignored.
  if (edgeSharedSecret) {
    headers.set("x-edge-secret", edgeSharedSecret);
  }
  // A /demo page's loader asks for demo data (lib/demoMode.ts).
  if (isDemoMode()) {
    for (const [name, value] of Object.entries(DEMO_API_HEADERS)) {
      headers.set(name, value);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers,
      signal: AbortSignal.timeout(resolveLoaderTimeoutMs()),
    });
  } catch (error) {
    rethrowTimeoutAs504(error);
  }
  // 400 covers malformed ids (the API rejects non-UUID path segments);
  // for a crawler or visitor that is the same thing as not existing.
  if (response.status === 404 || response.status === 400) {
    throw new Response("Not Found", { status: 404 });
  }
  // Pass rate limiting through as 429 (a crawler backs off on 429; a 502
  // reads as an outage) and keep the API's retry-after hint.
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new Response("Rate limited", {
      status: 429,
      headers: retryAfter ? { "retry-after": retryAfter } : undefined,
    });
  }
  if (!response.ok) {
    throw new Response("Upstream API error", { status: 502 });
  }
  try {
    // The timeout signal also aborts a stalled body read, not just the
    // connection.
    return (await response.json()) as T;
  } catch (error) {
    rethrowTimeoutAs504(error);
  }
}
