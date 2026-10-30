export const CENSUS_ADDRESS_GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
export const CENSUS_COORDINATES_GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";

export const DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK = "Public_AR_Current";
export const DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE = "ACS2024_Current";
export const DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS = "all";
// Per-attempt budget. The browser abandons any API request after 15s
// (packages/api-client REQUEST_TIMEOUT_MS), so two attempts plus the retry
// pause must finish inside that window: an outage then reaches the visitor
// as a 503 with its own wording instead of a client-side timeout.
export const DEFAULT_CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS = 6_000;
export const DEFAULT_CENSUS_ADDRESS_GEOCODER_RETRY_DELAY_MS = 500;
export const CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS = 2;
// A retry that could not get at least this long before the deadline is not
// started: a clipped attempt would only replace the real error with a timeout.
export const CENSUS_ADDRESS_GEOCODER_MIN_RETRY_WINDOW_MS = 1_000;

export type CensusAddressGeocoderErrorCode =
  | "invalid_address"
  | "not_found"
  | "http_error"
  | "bad_response"
  | "timeout"
  | "network_error";

export class CensusAddressGeocoderError extends Error {
  readonly code: CensusAddressGeocoderErrorCode;
  /** HTTP status for http_error; null for every other code. */
  readonly status: number | null;

  constructor(code: CensusAddressGeocoderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "CensusAddressGeocoderError";
    this.code = code;
    this.status = status;
  }
}

export type CensusAddressGeocoderOptions = {
  benchmark?: string;
  vintage?: string;
  layers?: string;
  timeoutMs?: number;
  /** Pause before the single retry of a transient failure; 0 disables the pause. */
  retryDelayMs?: number;
  /**
   * Absolute Date.now() timestamp shared by every upstream call of one
   * lookup. Each attempt's timeout is clipped to the time left, nothing
   * starts after it passes, and a retry needs CENSUS_ADDRESS_GEOCODER_MIN_RETRY_WINDOW_MS.
   */
  deadlineAt?: number;
  fetchImpl?: typeof fetch;
};

/** Milliseconds until the deadline, or null when none is set. */
export function msUntilDeadline(deadlineAt: number | undefined): number | null {
  if (deadlineAt === undefined) {
    return null;
  }
  if (!Number.isFinite(deadlineAt)) {
    throw new CensusAddressGeocoderError("invalid_address", `deadlineAt must be a finite timestamp, got ${deadlineAt}`);
  }
  return deadlineAt - Date.now();
}

/** The per-call timeout clipped to the time left; a timeout error once the deadline has passed. */
export function clampTimeoutToDeadline(timeoutMs: number, deadlineAt: number | undefined, what: string): number {
  const remaining = msUntilDeadline(deadlineAt);
  if (remaining === null) {
    return timeoutMs;
  }
  if (remaining <= 0) {
    throw new CensusAddressGeocoderError("timeout", `${what} skipped: the lookup's time budget is exhausted`);
  }
  return Math.min(timeoutMs, Math.ceil(remaining));
}

export type CensusAddressCoordinates = {
  lat: number;
  lng: number;
};

export type CensusAddressGeocodeResult = {
  matched_address: string;
  coordinates: CensusAddressCoordinates;
  geographies: unknown;
  address_match_count: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}

function normalizeRequiredString(value: string | undefined, fallback: string, fieldName: string): string {
  const normalized = (value ?? fallback).trim();
  if (normalized.length === 0) {
    throw new CensusAddressGeocoderError("invalid_address", `${fieldName} must not be empty`);
  }
  return normalized;
}

function normalizeTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CensusAddressGeocoderError("invalid_address", `timeoutMs must be a positive integer, got ${timeoutMs}`);
  }
  return timeoutMs;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function buildCensusAddressGeocoderUrl(address: string, options: CensusAddressGeocoderOptions = {}): string {
  const normalizedAddress = address.trim();
  if (normalizedAddress.length === 0) {
    throw new CensusAddressGeocoderError("invalid_address", "address must not be empty");
  }

  const benchmark = normalizeRequiredString(
    options.benchmark,
    DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK,
    "benchmark"
  );
  const vintage = normalizeRequiredString(options.vintage, DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE, "vintage");
  const layers = normalizeRequiredString(options.layers, DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS, "layers");

  const url = new URL(CENSUS_ADDRESS_GEOCODER_URL);
  url.searchParams.set("address", normalizedAddress);
  url.searchParams.set("benchmark", benchmark);
  url.searchParams.set("vintage", vintage);
  url.searchParams.set("layers", layers);
  url.searchParams.set("format", "json");
  return url.toString();
}

function parseCoordinates(value: unknown): CensusAddressCoordinates | null {
  if (!isRecord(value)) {
    return null;
  }
  const lng = typeof value.x === "number" ? value.x : Number.NaN;
  const lat = typeof value.y === "number" ? value.y : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
}

export function parseCensusAddressGeocoderPayload(payload: unknown): CensusAddressGeocodeResult {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder response is missing result object");
  }

  const matches = payload.result.addressMatches;
  if (!Array.isArray(matches)) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder response is missing addressMatches array");
  }
  if (matches.length === 0) {
    throw new CensusAddressGeocoderError("not_found", "Census geocoder could not locate the address");
  }

  const firstMatch = matches[0];
  if (!isRecord(firstMatch)) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder first address match is malformed");
  }

  const matchedAddress = typeof firstMatch.matchedAddress === "string" ? firstMatch.matchedAddress.trim() : "";
  if (matchedAddress.length === 0) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder first address match is missing matchedAddress");
  }

  const coordinates = parseCoordinates(firstMatch.coordinates);
  if (!coordinates) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder first address match is missing coordinates");
  }

  if (!isRecord(firstMatch.geographies)) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder first address match is missing geographies");
  }

  return {
    matched_address: matchedAddress,
    coordinates,
    geographies: firstMatch.geographies,
    address_match_count: matches.length,
  };
}

// The one-line parser is fed Google Places formattedAddress verbatim, which
// always carries a trailing country ("..., NJ 07073, USA") the Census parser
// does not expect, and sometimes a ZIP+4. Both degrade marginal matches. The
// candidates go from most to least specific; later ones drop components the
// parser mismatches on more often than it needs them.
export function buildCensusAddressCandidates(address: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  const original = address.trim();
  push(original);

  // Country suffix must follow a comma so a street name ending in "US" is
  // never clipped; ZIP+4 collapses to the ZIP5 the benchmark indexes.
  const noCountry = original.replace(/,\s*(?:USA|U\.S\.A\.|US|U\.S\.|United States(?: of America)?)\s*$/i, "");
  const zip5 = noCountry.replace(/\b(\d{5})-\d{4}\b/, "$1");
  push(zip5);

  const parts = zip5
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length >= 3) {
    const street = parts[0];
    const last = parts[parts.length - 1];
    const zipMatch = last.match(/\b\d{5}\b/);
    if (zipMatch) {
      push(`${street}, ${zipMatch[0]}`);
      const lastWithoutZip = last.replace(/\b\d{5}\b/, "").trim();
      if (lastWithoutZip.length > 0) {
        push([...parts.slice(0, -1), lastWithoutZip].join(", "));
      }
    }
  }

  return candidates;
}

// Retry ladder over buildCensusAddressCandidates: only a definitive
// not_found moves to the next candidate — upstream failures (timeout, 5xx,
// malformed body) propagate immediately, and the not_found finally thrown is
// the ORIGINAL address's, so error semantics match the single-shot geocode.
export async function geocodeAddressWithCensusFallbacks(
  address: string,
  options: CensusAddressGeocoderOptions = {}
): Promise<CensusAddressGeocodeResult> {
  const candidates = buildCensusAddressCandidates(address);
  if (candidates.length === 0) {
    throw new CensusAddressGeocoderError("invalid_address", "address must not be empty");
  }
  let firstNotFound: CensusAddressGeocoderError | null = null;
  for (const candidate of candidates) {
    try {
      return await geocodeAddressWithCensus(candidate, options);
    } catch (error) {
      if (error instanceof CensusAddressGeocoderError && error.code === "not_found") {
        firstNotFound ??= error;
        continue;
      }
      throw error;
    }
  }
  throw firstNotFound as CensusAddressGeocoderError;
}

function normalizeRetryDelayMs(value: number | undefined): number {
  const delayMs = value ?? DEFAULT_CENSUS_ADDRESS_GEOCODER_RETRY_DELAY_MS;
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new CensusAddressGeocoderError("invalid_address", `retryDelayMs must be a non-negative integer, got ${delayMs}`);
  }
  return delayMs;
}

// Transient upstream failures only: a timeout, a connection error, or a 5xx
// reply. Definitive answers (2xx, 4xx) and malformed bodies are never retried.
function isRetryableCensusError(error: unknown): boolean {
  if (!(error instanceof CensusAddressGeocoderError)) {
    return false;
  }
  if (error.code === "timeout" || error.code === "network_error") {
    return true;
  }
  return error.code === "http_error" && error.status !== null && error.status >= 500;
}

// One retry after a short pause. The Census geocoder has answered with
// gateway errors for a minute at a time while healthy calls take well under
// a second, so a second attempt usually turns a blip into an answer. The
// error thrown after the last attempt is that attempt's own.
async function fetchCensusGeocoderPayload(url: string, options: CensusAddressGeocoderOptions): Promise<unknown> {
  const retryDelayMs = normalizeRetryDelayMs(options.retryDelayMs);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchCensusGeocoderPayloadOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS || !isRetryableCensusError(error)) {
        throw error;
      }
      const remaining = msUntilDeadline(options.deadlineAt);
      if (remaining !== null && remaining <= retryDelayMs + CENSUS_ADDRESS_GEOCODER_MIN_RETRY_WINDOW_MS) {
        throw error;
      }
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError;
}

async function fetchCensusGeocoderPayloadOnce(url: string, options: CensusAddressGeocoderOptions): Promise<unknown> {
  const timeoutMs = clampTimeoutToDeadline(normalizeTimeoutMs(options.timeoutMs), options.deadlineAt, "Census geocoder request");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    const bodyText = await response.text();

    if (!response.ok) {
      throw new CensusAddressGeocoderError(
        "http_error",
        `Census geocoder request failed: status=${response.status} ${response.statusText}; body=${truncate(bodyText)}`,
        response.status
      );
    }

    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new CensusAddressGeocoderError(
        "bad_response",
        `Census geocoder returned non-JSON response; body=${truncate(bodyText)}`
      );
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new CensusAddressGeocoderError(
        "timeout",
        `Census geocoder request timed out after ${timeoutMs}ms`
      );
    }
    if (error instanceof CensusAddressGeocoderError) {
      throw error;
    }
    // Node fetch surfaces DNS/connection failures as plain TypeError; wrap them
    // so the API layer maps them to 503 instead of the generic TypeError->400.
    throw new CensusAddressGeocoderError(
      "network_error",
      `Census geocoder request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function geocodeAddressWithCensus(
  address: string,
  options: CensusAddressGeocoderOptions = {}
): Promise<CensusAddressGeocodeResult> {
  const payload = await fetchCensusGeocoderPayload(buildCensusAddressGeocoderUrl(address, options), options);
  return parseCensusAddressGeocoderPayload(payload);
}

export type CensusCoordinatesGeocodeResult = {
  geographies: unknown;
};

export function buildCensusCoordinatesGeocoderUrl(
  coordinates: CensusAddressCoordinates,
  options: CensusAddressGeocoderOptions = {}
): string {
  const { lat, lng } = coordinates;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new CensusAddressGeocoderError("invalid_address", `coordinates are out of range: lat=${lat}, lng=${lng}`);
  }

  const benchmark = normalizeRequiredString(
    options.benchmark,
    DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK,
    "benchmark"
  );
  const vintage = normalizeRequiredString(options.vintage, DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE, "vintage");
  const layers = normalizeRequiredString(options.layers, DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS, "layers");

  const url = new URL(CENSUS_COORDINATES_GEOCODER_URL);
  url.searchParams.set("x", String(lng));
  url.searchParams.set("y", String(lat));
  url.searchParams.set("benchmark", benchmark);
  url.searchParams.set("vintage", vintage);
  url.searchParams.set("layers", layers);
  url.searchParams.set("format", "json");
  return url.toString();
}

export function parseCensusCoordinatesGeocoderPayload(payload: unknown): CensusCoordinatesGeocodeResult {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder response is missing result object");
  }
  // Unlike onelineaddress there is no addressMatches array: the coordinate
  // lookup answers with the geographies containing the point, or an empty
  // object when the point falls outside every layer.
  if (!isRecord(payload.result.geographies)) {
    throw new CensusAddressGeocoderError("bad_response", "Census geocoder response is missing geographies");
  }
  return { geographies: payload.result.geographies };
}

export async function geocodeCoordinatesWithCensus(
  coordinates: CensusAddressCoordinates,
  options: CensusAddressGeocoderOptions = {}
): Promise<CensusCoordinatesGeocodeResult> {
  const payload = await fetchCensusGeocoderPayload(buildCensusCoordinatesGeocoderUrl(coordinates, options), options);
  return parseCensusCoordinatesGeocoderPayload(payload);
}
