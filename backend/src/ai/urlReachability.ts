import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";
import { defaultCaCertificates, extraCaCertificatesForHost } from "./knownIncompleteChainHosts.js";

type UrlReachabilityOptions = {
  timeoutMs?: number;
  allowStatusCodes?: readonly number[];
  method?: "HEAD" | "GET";
};

export type UrlReachabilitySuccess = {
  ok: true;
  normalizedUrl: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  contentLength?: number;
};

export type UrlReachabilityFailure = {
  ok: false;
  reason: string;
  // Present when the server answered 429 with a parseable Retry-After header:
  // callers with retry loops can wait at least this long instead of their
  // default backoff.
  retryAfterSeconds?: number;
};

export type UrlReachabilityResult = UrlReachabilitySuccess | UrlReachabilityFailure;

const TLS_CERTIFICATE_FAILURE_PATTERNS = [
  "unable_to_verify_leaf_signature",
  "unable to verify the first certificate",
  "unable to get local issuer certificate",
  "self-signed certificate",
  "self signed certificate",
  "depth_zero_self_signed_cert",
  "self_signed_cert_in_chain",
  "certificate has expired",
  "cert_has_expired",
  "unable_to_get_issuer_cert",
  // Hostname/SAN mismatch (live: wrong.host.badssl.com) — as permanent as an
  // expired certificate, and previously misclassified transient because only
  // the "fetch failed" wrapper text reached the classifier.
  "err_tls_cert_altname_invalid",
  "does not match certificate's altnames",
];

export function isTlsCertificateReachabilityFailure(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return TLS_CERTIFICATE_FAILURE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Single owner of the reason-string retry contract (this module produces
 * every reason these substrings match). TLS certificate failures classify
 * permanent FIRST: they arrive wrapped in undici's "fetch failed" (which is
 * otherwise transient), and retrying an expired or self-signed certificate
 * can never succeed.
 */
export function classifyCitationVerificationFailure(reason: string): "transient" | "permanent" {
  if (isTlsCertificateReachabilityFailure(reason)) {
    return "permanent";
  }
  const normalized = reason.toLowerCase();
  if (
    normalized.includes("timed out") ||
    normalized.includes("dns lookup failed transiently") ||
    normalized.includes("fetch failed") ||
    normalized.includes("status 429") ||
    // Synthetic no-contact failure while a host's Retry-After deadline is
    // still running — retryable by definition.
    normalized.includes("rate-limit cooldown") ||
    normalized.includes("status 500") ||
    normalized.includes("status 502") ||
    normalized.includes("status 503") ||
    normalized.includes("status 504")
  ) {
    return "transient";
  }
  return "permanent";
}

/**
 * Recovers a Location header whose non-ASCII bytes were decoded as latin-1.
 *
 * HTTP headers carry bytes, and undici surfaces them as latin-1 — so a host
 * that emits a UTF-8 path in Location hands us one char per byte. Resolving
 * that against the base URL percent-encodes each of those chars separately,
 * doubling the encoding: the UTF-8 bytes C2 A0 (a non-breaking space) arrive
 * as "Â " and re-encode to %C3%82%C2%A0, which the origin then 404s.
 * (Live: ag.nv.gov redirects a press-release path this way; the mojibake URL
 * was stored as a citation and resolved to the site's error page.)
 *
 * The bytes are only reinterpreted when every char fits in a byte (a char
 * above 0xFF means the value was NOT a latin-1 byte read in the first place,
 * and reinterpreting would corrupt it) AND they decode as strict UTF-8 — a
 * genuine latin-1 path is left alone, since arbitrary latin-1 rarely parses
 * as UTF-8.
 */
export function decodeLatin1MisreadHeader(headerValue: string): string {
  if (!/[\u0080-\u00FF]/.test(headerValue) || /[^\u0000-\u00FF]/.test(headerValue)) {
    return headerValue;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(headerValue, "latin1"));
  } catch {
    return headerValue;
  }
}

/**
 * True when a redirect landed somewhere that could serve different content
 * than the requested URL. Cosmetic canonicalization — the http -> https
 * upgrade, apex <-> www on the same path, a purely trailing slash — is not a
 * move; anything else (host, port, path, query, or a scheme DOWNGRADE) is.
 *
 * Used to decide whether a HEAD-derived redirect chain still needs a GET to
 * confirm it. Unparseable input is treated as changed: failing toward the
 * extra GET keeps a bad finalUrl out of storage, which is the direction that
 * matters.
 */
export function isResourceChangingRedirect(fromUrl: string, toUrl: string): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return true;
  }
  // Only the plain http -> https upgrade is cosmetic. A downgrade (or any
  // other scheme change) can land on a different server entirely — the same
  // laundering class this check exists to catch.
  if (from.protocol !== to.protocol && !(from.protocol === "http:" && to.protocol === "https:")) {
    return true;
  }
  // apex <-> www with an identical path and query is canonicalization by
  // construction — and the single most common redirect on the public web,
  // so flagging it would double request volume across the health sweeps.
  // (URL lowercases hostnames at parse time; no case handling needed.)
  const stripLeadingWww = (hostname: string): string =>
    hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  if (stripLeadingWww(from.hostname) !== stripLeadingWww(to.hostname)) {
    return true;
  }
  // URL.hostname excludes the port, so it is compared separately: a port
  // change is a different service on the same machine. Scheme-default ports
  // are already dropped at parse time, so "" === "" for the common case.
  if (from.port !== to.port) {
    return true;
  }
  if (from.search !== to.search) {
    return true;
  }
  const stripTrailingSlash = (pathname: string): string =>
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return stripTrailingSlash(from.pathname) !== stripTrailingSlash(to.pathname);
}

function stripIpv6Brackets(hostnameOrIp: string): string {
  return hostnameOrIp.toLowerCase().replace(/^\[|\]$/g, "");
}

// RFC 8215 local-use NAT64 prefix. ipaddr.js only special-cases the
// well-known RFC 6052 prefix (64:ff9b::/96, range "rfc6052"), so this one
// comes back plain "unicast" — but on a network with a NAT64 translator it
// maps onto arbitrary IPv4, including loopback and RFC 1918.
const NAT64_LOCAL_USE_RANGE = ipaddr.IPv6.parseCIDR("64:ff9b:1::/48");

// RFC 2544 benchmarking range. ipaddr.js only labels it "benchmarking" from
// v2.x; the installed 1.x returns plain "unicast", so check it explicitly.
const BENCHMARKING_RANGE = ipaddr.IPv4.parseCIDR("198.18.0.0/15");

/** Only ordinary globally routable unicast addresses are safe citation targets. */
function isBlockedIpLiteral(hostnameOrIp: string): boolean {
  const host = stripIpv6Brackets(hostnameOrIp);
  if (!ipaddr.isValid(host)) {
    return true;
  }

  let address = ipaddr.parse(host);
  if (address instanceof ipaddr.IPv6) {
    if (address.isIPv4MappedAddress()) {
      address = address.toIPv4Address();
    } else if (address.match(NAT64_LOCAL_USE_RANGE)) {
      return true;
    }
  }

  if (address instanceof ipaddr.IPv4 && address.match(BENCHMARKING_RANGE)) {
    return true;
  }

  return address.range() !== "unicast";
}

function isBlockedHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata"
  ) {
    return true;
  }

  return isIP(host) > 0 && isBlockedIpLiteral(host);
}

type ResolvedUrlTarget = {
  hostname: string;
  addresses: LookupAddress[];
};

type UrlTargetResolution =
  | { target: ResolvedUrlTarget }
  | { failure: UrlReachabilityFailure };

// dns.lookup error codes that indicate the resolver (not the name) failed.
// These must stay retryable downstream; ENOTFOUND/ENODATA stay permanent.
const TRANSIENT_DNS_LOOKUP_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ETIMEOUT",
  "ETIMEDOUT",
  "ESERVFAIL",
  "EREFUSED",
]);

const DNS_LOOKUP_TIMEOUT_CODE = "DNS_LOOKUP_TIMEOUT";

async function resolveSafeUrlTarget(url: string, timeoutMs: number): Promise<UrlTargetResolution> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { failure: { ok: false, reason: "citation URL is not parseable" } };
  }

  if (isBlockedHostname(parsed.hostname)) {
    return {
      failure: { ok: false, reason: "citation URL points to a blocked/private host" },
    };
  }

  const hostname = stripIpv6Brackets(parsed.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily > 0) {
    return {
      target: {
        hostname,
        addresses: [{ address: hostname, family: literalFamily }],
      },
    };
  }

  // dns.lookup has no abort support, so race it against a timer: the fetch
  // timeout only starts after resolution, and a stalled resolver must not
  // hold the verifier far past its advertised budget. On timeout the
  // in-flight getaddrinfo call is abandoned (it settles into a no-op).
  //
  // Reason strings are a contract with classifyCitationVerificationFailure
  // (exported below): "timed out" and "dns lookup failed transiently"
  // classify as transient/retryable, the bare could-not-be-resolved reason
  // as permanent.
  let records: LookupAddress[];
  let dnsTimeoutTimer: NodeJS.Timeout | undefined;
  try {
    records = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        dnsTimeoutTimer = setTimeout(() => {
          reject(
            Object.assign(new Error("DNS lookup timed out"), { code: DNS_LOOKUP_TIMEOUT_CODE })
          );
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === DNS_LOOKUP_TIMEOUT_CODE) {
      return { failure: { ok: false, reason: "citation URL DNS lookup timed out" } };
    }
    if (TRANSIENT_DNS_LOOKUP_ERROR_CODES.has(code)) {
      return {
        failure: { ok: false, reason: `citation URL DNS lookup failed transiently: ${code}` },
      };
    }
    return {
      failure: { ok: false, reason: "citation URL hostname could not be resolved" },
    };
  } finally {
    clearTimeout(dnsTimeoutTimer);
  }

  if (records.length === 0) {
    return {
      failure: { ok: false, reason: "citation URL hostname could not be resolved" },
    };
  }

  if (
    records.some(
      (record) =>
        (record.family !== 4 && record.family !== 6) ||
        isIP(record.address) !== record.family ||
        isBlockedIpLiteral(record.address)
    )
  ) {
    return {
      failure: {
        ok: false,
        reason: "citation URL hostname resolves to a blocked/private IP",
      },
    };
  }

  const uniqueRecords = records.filter(
    (record, index) =>
      records.findIndex(
        (candidate) =>
          candidate.family === record.family && candidate.address === record.address
      ) === index
  );

  return { target: { hostname, addresses: uniqueRecords } };
}

function createPinnedLookup(target: ResolvedUrlTarget): LookupFunction {
  // Return only the addresses already classified above. The socket never gets
  // a second DNS answer that could differ from the one we validated.
  return (hostname, options, callback) => {
    if (stripIpv6Brackets(hostname) !== target.hostname) {
      const error = Object.assign(new Error("Pinned DNS lookup received an unexpected hostname"), {
        code: "ENOTFOUND",
      });
      callback(error, "", 0);
      return;
    }

    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const addresses =
      family === 0
        ? target.addresses
        : target.addresses.filter((address) => address.family === family);
    if (addresses.length === 0) {
      const error = Object.assign(
        new Error("Pinned DNS lookup has no address for the requested family"),
        { code: "EAI_ADDRFAMILY" }
      );
      callback(error, "", 0);
      return;
    }

    if (options.all) {
      callback(null, addresses);
      return;
    }
    const [address] = addresses;
    callback(null, address.address, address.family);
  };
}

const MAX_REDIRECT_HOPS = 5;

const FOLLOWABLE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Keeps a failure reason readable when a hop URL carries a huge query string.
const REDIRECT_CHAIN_HOP_MAX_LENGTH = 200;

/**
 * Intermediate redirect targets can carry live credentials the original
 * citation never contained (presigned S3 signatures, auth codes, session
 * tokens in query strings, userinfo). The reason string is persisted to
 * staging failure debug and fed back to AI retries, so every hop is
 * sanitized to origin + path before it is reported.
 */
function sanitizeHopUrlForReason(hopUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(hopUrl);
  } catch {
    return "[unparseable-url]";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  const hadQuery = parsed.search.length > 0;
  parsed.search = "";
  return hadQuery ? `${parsed.toString()}?[redacted]` : parsed.toString();
}

function formatRedirectChain(hops: readonly string[]): string {
  return hops
    .map((hop) => sanitizeHopUrlForReason(hop))
    .map((hop) =>
      hop.length > REDIRECT_CHAIN_HOP_MAX_LENGTH
        ? `${hop.slice(0, REDIRECT_CHAIN_HOP_MAX_LENGTH)}…`
        : hop
    )
    .join(" -> ");
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: do not mask the primary result.
  }
}

type HopResponse = {
  ok: boolean;
  status: number;
  location: string | null;
  contentType: string | null;
  contentLength: number | null;
  retryAfterSeconds: number | null;
};

// Retry-After sanity ceiling: some hosts send hour-scale values; anything a
// verifier or its callers would actually wait is far below this, and the
// cap keeps a hostile header from parking a worker.
const RETRY_AFTER_MAX_SECONDS = 900;

/** Parses Retry-After in both delta-seconds and HTTP-date forms. */
function parseRetryAfterSeconds(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.min(seconds, RETRY_AFTER_MAX_SECONDS) : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const seconds = Math.ceil((dateMs - Date.now()) / 1000);
  return seconds > 0 ? Math.min(seconds, RETRY_AFTER_MAX_SECONDS) : 0;
}

async function fetchPinnedUrl(
  url: string,
  target: ResolvedUrlTarget,
  method: "HEAD" | "GET",
  timeoutMs: number
): Promise<HopResponse> {
  // Hosts on the known-incomplete-chain list get Node's default trust set
  // (bundled roots + NODE_EXTRA_CA_CERTS) plus their missing intermediate;
  // `connect.ca` replaces the default store, so the defaults must be
  // re-included. Verification itself is never relaxed.
  const extraCaCertificates = extraCaCertificatesForHost(target.hostname);
  const dispatcher = new Agent({
    connect: {
      lookup: createPinnedLookup(target),
      ...(extraCaCertificates
        ? { ca: [...defaultCaCertificates(), ...extraCaCertificates] }
        : {}),
    },
    autoSelectFamily:
      target.addresses.some((address) => address.family === 4) &&
      target.addresses.some((address) => address.family === 6),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | null = null;
  try {
    response = await fetch(url, {
      method,
      // Official result hosts (results.okelections.gov, waynecountymi.gov,
      // sos.mo.gov) answer 403 to undici's default "node"/"undici" agent and
      // 200 to a browser; the 403 then degrades the source to "weak".
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
      redirect: "manual",
      signal: controller.signal,
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    return {
      ok: response.ok,
      status: response.status,
      location: response.headers.get("location"),
      contentType: response.headers.get("content-type"),
      contentLength: (() => {
        const raw = response.headers.get("content-length");
        if (!raw) {
          return null;
        }
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      })(),
      retryAfterSeconds:
        response.status === 429 ? parseRetryAfterSeconds(response.headers.get("retry-after")) : null,
    };
  } finally {
    clearTimeout(timeout);
    if (response) {
      await cancelResponseBody(response);
    }
    try {
      await dispatcher.close();
    } catch {
      // Best effort: do not mask the primary result.
    }
  }
}

/**
 * SSRF-safe fetch: redirects are followed manually so every Location target
 * is safety-checked BEFORE it is contacted. `redirect: "follow"` would let a
 * public URL bounce the backend into a private/internal address and only
 * reject it after the request already happened. Each hop gets its own
 * timeout window; abort errors propagate to the caller's catch.
 */
async function fetchWithValidatedRedirects(
  startUrl: string,
  method: "HEAD" | "GET",
  timeoutMs: number
): Promise<{ response: HopResponse; finalUrl: string } | { failure: UrlReachabilityFailure }> {
  let currentUrl = startUrl;
  const visitedUrls: string[] = [startUrl];
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const resolution = await resolveSafeUrlTarget(currentUrl, timeoutMs);
    if ("failure" in resolution) {
      return resolution;
    }
    const response = await fetchPinnedUrl(currentUrl, resolution.target, method, timeoutMs);

    if (!FOLLOWABLE_REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.location;
    if (!location) {
      return { failure: { ok: false, reason: "citation URL redirect is missing a Location header" } };
    }
    let resolvedLocation: string;
    try {
      resolvedLocation = new URL(decodeLatin1MisreadHeader(location), currentUrl).toString();
    } catch {
      return { failure: { ok: false, reason: "citation final URL is invalid after redirects" } };
    }
    // Hop targets keep their trailing slash: many hosts redirect the slashless
    // path TO the trailing-slash form, so the comparison-oriented default
    // (stripTrailingSlash) would recreate the slashless URL and walk a
    // synthetic self-loop until the hop limit (hit live on ordinary readable
    // pages across four run reports). Normalization here only validates the
    // scheme and drops the fragment.
    const nextUrl = normalizeHttpUrl(resolvedLocation, { stripTrailingSlash: false });
    if (!nextUrl) {
      return { failure: { ok: false, reason: "citation final URL is invalid after redirects" } };
    }
    // A repeated URL is a genuine redirect cycle (host anti-bot behavior or
    // scheme oscillation) — fail it immediately with its own reason instead of
    // burning the remaining hops as "exceeded the redirect limit". Membership
    // is exact-form on purpose: visitedUrls[0] is the slash-stripped input, so
    // a slashless->slashed redirect is correctly treated as a NEW URL (the
    // very case the hop normalization above preserves); comparing
    // slash-insensitively would re-flag it as a false loop. The only cost is
    // that a root URL redirecting to itself is caught one hop later, when its
    // slashed form repeats.
    if (visitedUrls.includes(nextUrl)) {
      return {
        failure: {
          ok: false,
          reason: `citation URL redirect loop detected (chain: ${formatRedirectChain([...visitedUrls, nextUrl])})`,
        },
      };
    }
    currentUrl = nextUrl;
    visitedUrls.push(nextUrl);
  }
  // Expose the walked chain so the terminal hop is diagnosable from the
  // failure reason alone (live run reports could not tell where a loop landed).
  return {
    failure: {
      ok: false,
      reason: `citation URL exceeded the redirect limit (chain: ${formatRedirectChain(visitedUrls)})`,
    },
  };
}

/**
 * undici's fetch reports every network-level failure as a bare
 * `TypeError: fetch failed` and hides the real error (TLS certificate codes,
 * ECONNRESET, ECONNREFUSED, ...) in the `cause` chain. Reasons built from the
 * top-level message alone made every such failure look identical AND
 * misclassified permanent TLS failures as transient (live: ERR-321/329).
 * Walk the chain and surface each distinct message/code.
 */
function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code =
      "code" in current && typeof (current as { code?: unknown }).code === "string"
        ? ((current as { code: string }).code)
        : undefined;
    const message = current.message?.trim();
    // "||" not "??": an empty trimmed message must fall through to the code.
    const label = message && code && message !== code ? `${message} (${code})` : (message || code);
    if (label && !parts.includes(label)) {
      parts.push(label);
    }
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(": ") : String(error);
}

// Adaptive per-host cooldown: set only when a host answers 429, so the
// normal path pays nothing. Later verifications against the same host wait
// out the cooldown (Retry-After when given, a short default otherwise)
// instead of re-bursting a host that just told us to slow down (ERR-022).
const HOST_COOLDOWN_DEFAULT_MS = 1_000;
const HOST_COOLDOWN_MAX_WAIT_MS = 15_000;
const HOST_COOLDOWN_MAP_MAX_ENTRIES = 200;

const hostCooldownUntilMs = new Map<string, number>();

// Drops expired entries on every record. Entries inside an active cooldown
// are never evicted, even past HOST_COOLDOWN_MAP_MAX_ENTRIES: evicting one
// would let the verifier re-contact a host whose Retry-After deadline is
// still running. Every entry expires within RETRY_AFTER_MAX_SECONDS, so the
// map is bounded by the number of distinct hosts 429ing inside one such
// window — hostname strings, negligible next to that correctness cost.
function pruneExpiredHostCooldowns(nowMs: number): void {
  for (const [host, untilMs] of hostCooldownUntilMs) {
    if (untilMs <= nowMs) {
      hostCooldownUntilMs.delete(host);
    }
  }
}

// Waits out the host's active cooldown when it fits inside
// HOST_COOLDOWN_MAX_WAIT_MS; when the deadline lies beyond what we are
// willing to wait in-call, returns the remaining seconds WITHOUT sleeping so
// the caller can refuse contact — a request before the advertised
// Retry-After deadline is exactly what the cooldown exists to prevent.
// Re-reads the map after every sleep: another in-flight verification can 429
// and EXTEND the entry while this one sleeps, and deleting unconditionally
// on wake would erase that newer cooldown. Entries are only deleted when the
// observed value is still current.
async function awaitHostCooldown(hostname: string): Promise<number | null> {
  const waitDeadlineMs = Date.now() + HOST_COOLDOWN_MAX_WAIT_MS;
  while (true) {
    const untilMs = hostCooldownUntilMs.get(hostname);
    if (untilMs === undefined) {
      return null;
    }
    const nowMs = Date.now();
    if (untilMs <= nowMs) {
      if (hostCooldownUntilMs.get(hostname) === untilMs) {
        hostCooldownUntilMs.delete(hostname);
      }
      return null;
    }
    if (untilMs > waitDeadlineMs) {
      return Math.ceil((untilMs - nowMs) / 1_000);
    }
    await new Promise((resolve) => setTimeout(resolve, untilMs - nowMs));
  }
}

function recordHostCooldown(hostname: string, retryAfterSeconds: number | null): void {
  const nowMs = Date.now();
  pruneExpiredHostCooldowns(nowMs);
  const cooldownMs =
    retryAfterSeconds !== null && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : HOST_COOLDOWN_DEFAULT_MS;
  // Max-merge: two in-flight requests can both 429 with different
  // Retry-After values, and a later, shorter answer must not shorten the
  // deadline a longer one already established.
  const existingUntilMs = hostCooldownUntilMs.get(hostname);
  const nextUntilMs = nowMs + cooldownMs;
  hostCooldownUntilMs.set(
    hostname,
    existingUntilMs !== undefined && existingUntilMs > nextUntilMs ? existingUntilMs : nextUntilMs
  );
}

// Hosts whose rate limiter has answered a HEAD with 429. Some WAFs throttle
// HEAD while serving GET, so retrying the same HEAD would 429 forever and a
// valid citation would never be tested with the method that matters. Later
// verifications against these hosts skip the HEAD optimization and start
// with GET (the authoritative method). Bounded: cleared wholesale if it ever
// grows past the cooldown map's cap — hosts simply re-learn.
const getPreferredHosts = new Set<string>();

function recordGetPreferredHost(hostname: string): void {
  if (getPreferredHosts.size > HOST_COOLDOWN_MAP_MAX_ENTRIES) {
    getPreferredHosts.clear();
  }
  getPreferredHosts.add(hostname);
}

/** Test-only: cooldown state is module-global and must not leak across tests. */
export function resetCitationHostCooldownsForTests(): void {
  hostCooldownUntilMs.clear();
  getPreferredHosts.clear();
}

export async function verifyHttpUrlReachability(
  rawUrl: string,
  options: UrlReachabilityOptions = {}
): Promise<UrlReachabilityResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const allowStatusCodes = new Set(options.allowStatusCodes ?? [403]);
  const normalizedInputUrl = normalizeHttpUrl(rawUrl);
  if (!normalizedInputUrl) {
    return { ok: false, reason: "citation URL is not a valid http(s) URL" };
  }
  const inputHostname = (() => {
    try {
      return new URL(normalizedInputUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  })();
  // An explicit caller method always wins; otherwise skip the HEAD
  // optimization for hosts that have rate-limited a HEAD before (their
  // limiter may serve GET fine, and GET is the authoritative method).
  const initialMethod =
    options.method ?? (inputHostname && getPreferredHosts.has(inputHostname) ? "GET" : "HEAD");
  if (inputHostname) {
    const coolingSeconds = await awaitHostCooldown(inputHostname);
    if (coolingSeconds !== null) {
      // Contacting the host before its advertised Retry-After deadline is
      // exactly what the cooldown exists to prevent; fail fast (transient,
      // zero network contact) instead of sleeping the in-call bound and
      // then requesting anyway.
      return {
        ok: false,
        reason: `citation fetch skipped: host rate-limit cooldown has ${coolingSeconds}s remaining (retry-after)`,
        retryAfterSeconds: coolingSeconds,
      };
    }
  }

  try {
    // Tracks the method the current `response` actually came from: the
    // transport-level fallback below already switches to GET, and the
    // status-based GET confirmation further down must not run again after it
    // (a second identical GET doubles traffic and can trip rate limits).
    let effectiveMethod = initialMethod;
    let initialResult: Awaited<ReturnType<typeof fetchWithValidatedRedirects>>;
    try {
      initialResult = await fetchWithValidatedRedirects(normalizedInputUrl, initialMethod, timeoutMs);
    } catch (error) {
      // Some hosts kill HEAD at the transport level while serving GET fine
      // (live: oregonvotes.gov resets every HEAD). The status-based GET
      // fallback below never runs for a thrown transport error, so the URL
      // could never be cited. Retry with GET before failing. Timeouts are
      // excluded: a host too slow for HEAD is too slow for GET, and the
      // doubled wait would blow the advertised budget.
      const message = error instanceof Error ? error.message : String(error);
      if (initialMethod !== "HEAD" || message.toLowerCase().includes("aborted")) {
        throw error;
      }
      initialResult = await fetchWithValidatedRedirects(normalizedInputUrl, "GET", timeoutMs);
      effectiveMethod = "GET";
      if (inputHostname) {
        recordGetPreferredHost(inputHostname);
      }
    }
    if ("failure" in initialResult) {
      return initialResult.failure;
    }
    let response = initialResult.response;
    let finalUrl = initialResult.finalUrl;

    // HEAD is an optimization, not the authoritative answer, in two ways.
    //
    // Failing status: beyond hosts that reject the method outright
    // (405/501), some servers answer HEAD with a different status than GET
    // for the same resource (CivicPlus DocumentCenter PDFs return HEAD 404 /
    // GET 200, verified live), so any failing HEAD status is confirmed with
    // a GET before the URL is failed. EXCEPT 429: an immediate GET would
    // double the burst at a host that just asked us to back off, and a
    // differing GET status would silently discard the 429 and its
    // Retry-After. The 429 branch below instead records the cooldown and
    // marks the host GET-preferred, so the post-cooldown retry tests the
    // resource with GET directly — covering limiters that throttle HEAD but
    // serve GET. Allowlisted statuses (the 403 anti-bot default) are
    // likewise accepted as-is: the caller already declared them acceptable,
    // and a GET could only flip that acceptance into a failure.
    //
    // Succeeding redirect: a HEAD that SUCCEEDED after a resource-changing
    // redirect is no more trustworthy about its chain. Some hosts 302 HEAD
    // onto an error page that then answers 200, so the call reports ok with
    // finalUrl pointing at the error page while GET serves the real resource
    // (live: olis.oregonlegislature.gov 302s every HEAD of a
    // Measures/Overview page to /liz/<session>/Error, which returns 200; GET
    // returns the measure). Callers store the resolved finalUrl, so without
    // the confirmation the verifier launders a working citation into a
    // stored error-page URL — the exact defect found on 60 stored Oregon
    // records. The `response.ok` gate keeps this arm off the 429 and
    // allowlisted-status paths above, and isResourceChangingRedirect keeps
    // it off cosmetic canonicalization (https upgrade, apex<->www, trailing
    // slash), which would otherwise double traffic for no signal. The host
    // is also marked GET-preferred: its HEAD answers are misleading by
    // demonstration, so later URLs on it start with GET and skip the wasted
    // double walk.
    //
    // Either way the GET re-walks the redirect chain from the original URL
    // with the same per-hop validation — HEAD and GET can redirect
    // differently, so HEAD's chain proves nothing about GET's. If the GET
    // walk itself fails, the failure is returned rather than falling back to
    // the HEAD result: storing a HEAD-derived finalUrl that GET could not
    // confirm is the defect this exists to prevent, and a skipped
    // verification is retryable while a stored error page is not.
    if (effectiveMethod === "HEAD") {
      const failingStatusNeedsGet =
        !response.ok && response.status !== 429 && !allowStatusCodes.has(response.status);
      const redirectNeedsGet =
        response.ok && isResourceChangingRedirect(normalizedInputUrl, finalUrl);
      if (failingStatusNeedsGet || redirectNeedsGet) {
        if (redirectNeedsGet && inputHostname) {
          recordGetPreferredHost(inputHostname);
        }
        const getResult = await fetchWithValidatedRedirects(normalizedInputUrl, "GET", timeoutMs);
        if ("failure" in getResult) {
          return getResult.failure;
        }
        response = getResult.response;
        finalUrl = getResult.finalUrl;
      }
    }

    if (!response.ok && !allowStatusCodes.has(response.status)) {
      if (response.status === 429) {
        // The 429 comes from the FINAL hop (a redirect can land on a CDN or
        // document host), so cool that host down; the input host is cooled
        // too because retries re-enter through the input URL. Cooldowns are
        // still only awaited at entry, not per redirect hop — a different
        // citation that merely redirects onto the limited host won't wait.
        // Accepted: this pacing is a best-effort burst damper, not a rate
        // limiter.
        const finalHostname = (() => {
          try {
            return new URL(finalUrl).hostname.toLowerCase();
          } catch {
            return null;
          }
        })();
        for (const hostname of new Set(
          [inputHostname, finalHostname].filter((host): host is string => host !== null)
        )) {
          recordHostCooldown(hostname, response.retryAfterSeconds);
          if (initialMethod === "HEAD") {
            recordGetPreferredHost(hostname);
          }
        }
        return {
          ok: false,
          reason:
            response.retryAfterSeconds !== null
              ? `citation fetch returned status 429 (retry-after: ${response.retryAfterSeconds}s)`
              : "citation fetch returned status 429",
          ...(response.retryAfterSeconds !== null
            ? { retryAfterSeconds: response.retryAfterSeconds }
            : {}),
        };
      }
      return { ok: false, reason: `citation fetch returned status ${response.status}` };
    }

    // Reaching here with a non-2xx means the status was allowlisted (403
    // anti-bot): reachability is accepted, but nothing verified that the
    // final hop serves the cited resource. If the chain also MOVED the
    // resource, canonicalizing finalUrl onto that unverified target would
    // store a WAF's /blocked interstitial as the citation — the same
    // laundering the redirect confirmation above exists to prevent, arriving
    // through the allowlist instead. Keep the input URL: it is what the
    // citation claims, and it still redirects for human readers. Only a 2xx
    // earns finalUrl canonicalization across a resource-changing redirect.
    const verifiedFinalUrl =
      !response.ok && isResourceChangingRedirect(normalizedInputUrl, finalUrl)
        ? normalizedInputUrl
        : finalUrl;
    return {
      ok: true,
      normalizedUrl: normalizedInputUrl,
      finalUrl: verifiedFinalUrl,
      status: response.status,
      ...(response.contentType ? { contentType: response.contentType } : {}),
      ...(response.contentLength !== null ? { contentLength: response.contentLength } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("aborted")) {
      return { ok: false, reason: "citation URL fetch timed out" };
    }
    return { ok: false, reason: `citation URL fetch failed: ${describeFetchError(error)}` };
  }
}
