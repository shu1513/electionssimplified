import { describe, expect, it, vi } from "vitest";

import {
  CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS,
  CENSUS_ADDRESS_GEOCODER_MIN_RETRY_WINDOW_MS,
  CensusAddressGeocoderError,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_RETRY_DELAY_MS,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS,
  buildCensusAddressCandidates,
  buildCensusAddressGeocoderUrl,
  buildCensusCoordinatesGeocoderUrl,
  geocodeAddressWithCensus,
  geocodeAddressWithCensusFallbacks,
  geocodeCoordinatesWithCensus,
  parseCensusAddressGeocoderPayload,
  parseCensusCoordinatesGeocoderPayload,
} from "../../../src/pipeline/address/censusAddressGeocoder.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    statusText: "OK",
    ...init,
  });
}

function fetchMockReturning(response: Response): typeof fetch {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("censusAddressGeocoder", () => {
  it("builds a Census geocoder URL with defaults and encoded address", () => {
    const url = new URL(buildCensusAddressGeocoderUrl("3921 Harlan Ave Baldwin Park CA 91706"));

    expect(url.origin + url.pathname).toBe("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
    expect(url.searchParams.get("address")).toBe("3921 Harlan Ave Baldwin Park CA 91706");
    expect(url.searchParams.get("benchmark")).toBe("Public_AR_Current");
    expect(url.searchParams.get("vintage")).toBe("ACS2024_Current");
    expect(url.searchParams.get("layers")).toBe("all");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("allows benchmark, vintage, and layers to be pinned by caller", () => {
    const url = new URL(
      buildCensusAddressGeocoderUrl("3921 Harlan Ave Baldwin Park CA 91706", {
        benchmark: "Public_AR_Census2020",
        vintage: "Census2020_Census2020",
        layers: "States,Counties",
      })
    );

    expect(url.searchParams.get("benchmark")).toBe("Public_AR_Census2020");
    expect(url.searchParams.get("vintage")).toBe("Census2020_Census2020");
    expect(url.searchParams.get("layers")).toBe("States,Counties");
  });

  it("rejects empty addresses before calling Census", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(geocodeAddressWithCensus("   ", { fetchImpl })).rejects.toMatchObject({
      code: "invalid_address",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses the first address match and keeps raw geographies", () => {
    const geographies = {
      Counties: [{ GEOID: "06037", NAME: "Los Angeles County", MTFCC: "G4020" }],
    };

    expect(
      parseCensusAddressGeocoderPayload({
        result: {
          addressMatches: [
            {
              matchedAddress: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
              coordinates: { x: -117.981072355887, y: 34.082500135664 },
              geographies,
            },
            {
              matchedAddress: "OTHER MATCH",
              coordinates: { x: -1, y: 1 },
              geographies: {},
            },
          ],
        },
      })
    ).toEqual({
      matched_address: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
      coordinates: { lat: 34.082500135664, lng: -117.981072355887 },
      geographies,
      address_match_count: 2,
    });
  });

  it("throws a typed not_found error when Census returns zero matches", () => {
    expect(() =>
      parseCensusAddressGeocoderPayload({
        result: { addressMatches: [] },
      })
    ).toThrow(CensusAddressGeocoderError);

    try {
      parseCensusAddressGeocoderPayload({ result: { addressMatches: [] } });
      throw new Error("expected parse to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "not_found" });
    }
  });

  it("fetches and parses a successful Census response", async () => {
    const fetchImpl = fetchMockReturning(
      jsonResponse({
        result: {
          addressMatches: [
            {
              matchedAddress: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
              coordinates: { x: -117.981072355887, y: 34.082500135664 },
              geographies: { States: [{ GEOID: "06", MTFCC: "G4000" }] },
            },
          ],
        },
      })
    );

    const result = await geocodeAddressWithCensus("3921 Harlan Ave Baldwin Park CA 91706", { fetchImpl });

    expect(result).toMatchObject({
      matched_address: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
      coordinates: { lat: 34.082500135664, lng: -117.981072355887 },
      address_match_count: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toContain("geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
    expect(init).toMatchObject({ method: "GET", redirect: "follow" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws typed http_error, carrying the status, once a 5xx has been retried", async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = vi.fn(
      async () => new Response("upstream unavailable", { status: 503, statusText: "Service Unavailable" })
    ) as unknown as typeof fetch;

    await expect(
      geocodeAddressWithCensus("3921 Harlan Ave Baldwin Park CA 91706", { fetchImpl, retryDelayMs: 0 })
    ).rejects.toMatchObject({
      code: "http_error",
      status: 503,
      message: expect.stringContaining("status=503 Service Unavailable"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS);
  });

  it("throws typed http_error without a retry for a 4xx", async () => {
    const fetchImpl = fetchMockReturning(new Response("bad request", { status: 400, statusText: "Bad Request" }));

    await expect(
      geocodeAddressWithCensus("3921 Harlan Ave Baldwin Park CA 91706", { fetchImpl, retryDelayMs: 0 })
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws typed bad_response for non-JSON responses", async () => {
    const fetchImpl = fetchMockReturning(new Response("<html>nope</html>", { status: 200, statusText: "OK" }));

    await expect(geocodeAddressWithCensus("3921 Harlan Ave Baldwin Park CA 91706", { fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
      status: null,
      message: expect.stringContaining("non-JSON"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps AbortError to a timeout error", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const fetchImpl = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    await expect(
      geocodeAddressWithCensus("3921 Harlan Ave Baldwin Park CA 91706", { fetchImpl, timeoutMs: 1234, retryDelayMs: 0 })
    ).rejects.toMatchObject({
      code: "timeout",
      message: "Census geocoder request timed out after 1234ms",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS);
  });

  it("wraps non-abort fetch failures in a typed network_error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;

    await expect(
      geocodeAddressWithCensus("3921 Harlan Ave Baldwin Park CA 91706", { fetchImpl, retryDelayMs: 0 })
    ).rejects.toMatchObject({
      name: "CensusAddressGeocoderError",
      code: "network_error",
      message: "Census geocoder request failed: fetch failed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS);
  });
});

describe("buildCensusAddressCandidates", () => {
  it("derives country-stripped, street+zip, and no-zip variants from a Google formattedAddress", () => {
    expect(buildCensusAddressCandidates("1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA")).toEqual([
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA",
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073",
      "1 MetLife Stadium Dr, 07073",
      "1 MetLife Stadium Dr, East Rutherford, NJ",
    ]);
  });

  it("collapses ZIP+4 to ZIP5", () => {
    expect(buildCensusAddressCandidates("3921 Harlan Ave, Baldwin Park, CA 91706-1234")).toEqual([
      "3921 Harlan Ave, Baldwin Park, CA 91706-1234",
      "3921 Harlan Ave, Baldwin Park, CA 91706",
      "3921 Harlan Ave, 91706",
      "3921 Harlan Ave, Baldwin Park, CA",
    ]);
  });

  it("returns a single candidate when there is nothing to vary", () => {
    expect(buildCensusAddressCandidates("3921 Harlan Ave Baldwin Park CA 91706")).toEqual([
      "3921 Harlan Ave Baldwin Park CA 91706",
    ]);
  });

  it("only strips a country that follows a comma", () => {
    expect(buildCensusAddressCandidates("10 Route US")).toEqual(["10 Route US"]);
  });

  it("returns no candidates for blank input", () => {
    expect(buildCensusAddressCandidates("   ")).toEqual([]);
  });
});

describe("geocodeAddressWithCensusFallbacks", () => {
  const MATCH_PAYLOAD = {
    result: {
      addressMatches: [
        {
          matchedAddress: "1 METLIFE STADIUM DR, EAST RUTHERFORD, NJ, 07073",
          coordinates: { x: -74.0741, y: 40.8135 },
          geographies: { Counties: [] },
        },
      ],
    },
  };
  const NO_MATCH_PAYLOAD = { result: { addressMatches: [] } };

  it("returns the first candidate's match without trying later candidates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(MATCH_PAYLOAD)) as unknown as typeof fetch;

    const result = await geocodeAddressWithCensusFallbacks(
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA",
      { fetchImpl }
    );

    expect(result.matched_address).toBe("1 METLIFE STADIUM DR, EAST RUTHERFORD, NJ, 07073");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls through not_found to the next candidate", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(NO_MATCH_PAYLOAD))
      .mockResolvedValueOnce(jsonResponse(MATCH_PAYLOAD)) as unknown as typeof fetch;

    const result = await geocodeAddressWithCensusFallbacks(
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA",
      { fetchImpl }
    );

    expect(result.matched_address).toBe("1 METLIFE STADIUM DR, EAST RUTHERFORD, NJ, 07073");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(new URL(calls[0][0]).searchParams.get("address")).toBe(
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA"
    );
    expect(new URL(calls[1][0]).searchParams.get("address")).toBe(
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073"
    );
  });

  it("throws not_found when every candidate misses", async () => {
    // Fresh Response per call: a shared body errors on the second read.
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(NO_MATCH_PAYLOAD))) as unknown as typeof fetch;

    await expect(
      geocodeAddressWithCensusFallbacks("1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA", { fetchImpl })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("stops at the first candidate when the upstream failure survives its retry", async () => {
    // A retried-and-still-failing upstream must not multiply the wait across
    // candidate spellings: only a definitive not_found moves down the ladder.
    const fetchImpl = vi.fn(
      async () => jsonResponse({ error: "boom" }, { status: 500, statusText: "Internal Server Error" })
    ) as unknown as typeof fetch;

    await expect(
      geocodeAddressWithCensusFallbacks("1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA", { fetchImpl, retryDelayMs: 0 })
    ).rejects.toMatchObject({ code: "http_error", status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS);
  });

  it("rejects blank addresses before calling Census", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(geocodeAddressWithCensusFallbacks("   ", { fetchImpl })).rejects.toMatchObject({
      code: "invalid_address",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("censusCoordinatesGeocoder", () => {
  it("builds a coordinates URL mapping lng to x and lat to y with defaults", () => {
    const url = new URL(buildCensusCoordinatesGeocoderUrl({ lat: 40.8135, lng: -74.0741 }));

    expect(url.origin + url.pathname).toBe("https://geocoding.geo.census.gov/geocoder/geographies/coordinates");
    expect(url.searchParams.get("x")).toBe("-74.0741");
    expect(url.searchParams.get("y")).toBe("40.8135");
    expect(url.searchParams.get("benchmark")).toBe("Public_AR_Current");
    expect(url.searchParams.get("vintage")).toBe("ACS2024_Current");
    expect(url.searchParams.get("layers")).toBe("all");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => buildCensusCoordinatesGeocoderUrl({ lat: 91, lng: 0 })).toThrowError(CensusAddressGeocoderError);
    expect(() => buildCensusCoordinatesGeocoderUrl({ lat: 0, lng: 181 })).toThrowError(CensusAddressGeocoderError);
    expect(() => buildCensusCoordinatesGeocoderUrl({ lat: Number.NaN, lng: 0 })).toThrowError(
      CensusAddressGeocoderError
    );
  });

  it("parses geographies from a coordinates response", () => {
    const geographies = { Counties: [{ GEOID: "34003" }] };

    expect(parseCensusCoordinatesGeocoderPayload({ result: { geographies } })).toEqual({ geographies });
  });

  it("rejects a coordinates response without geographies as bad_response", () => {
    expect(() => parseCensusCoordinatesGeocoderPayload({ result: {} })).toThrowError(/geographies/);
    expect(() => parseCensusCoordinatesGeocoderPayload({})).toThrowError(CensusAddressGeocoderError);
  });

  it("geocodes coordinates end to end via fetch", async () => {
    const geographies = { Counties: [{ GEOID: "34003" }] };
    const fetchImpl = fetchMockReturning(jsonResponse({ result: { geographies } }));

    const result = await geocodeCoordinatesWithCensus({ lat: 40.8135, lng: -74.0741 }, { fetchImpl });

    expect(result).toEqual({ geographies });
  });
});

describe("Census geocoder retry", () => {
  const ADDRESS = "143 Grizzley Peak Dr, Almont, CO 81210, USA";
  const MATCH_PAYLOAD = {
    result: {
      addressMatches: [
        {
          matchedAddress: "143 GRIZZLEY PEAK DR, ALMONT, CO, 81210",
          coordinates: { x: -106.846, y: 38.664 },
          geographies: { States: [{ GEOID: "08" }] },
        },
      ],
    },
  };
  const GATEWAY_PAYLOAD = { errors: ["gateway got an invalid response"], status: "502" };
  const abortError = () => new DOMException("aborted", "AbortError");

  it("keeps two attempts plus the pause inside the browser's 15s request budget", () => {
    expect(
      CENSUS_ADDRESS_GEOCODER_MAX_ATTEMPTS * DEFAULT_CENSUS_ADDRESS_GEOCODER_TIMEOUT_MS +
        DEFAULT_CENSUS_ADDRESS_GEOCODER_RETRY_DELAY_MS
    ).toBeLessThan(15_000);
  });

  it("retries once after a 5xx reply and returns the second answer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(GATEWAY_PAYLOAD, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(MATCH_PAYLOAD)) as unknown as typeof fetch;

    const result = await geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: 0 });
    expect(result.matched_address).toBe("143 GRIZZLEY PEAK DR, ALMONT, CO, 81210");
    expect(result.coordinates).toEqual({ lat: 38.664, lng: -106.846 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries once after a timeout", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(jsonResponse(MATCH_PAYLOAD)) as unknown as typeof fetch;

    await expect(geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: 0 })).resolves.toMatchObject({
      address_match_count: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries once after a connection error", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(MATCH_PAYLOAD)) as unknown as typeof fetch;

    await geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second failure with that attempt's error", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(jsonResponse(GATEWAY_PAYLOAD, { status: 503 })) as unknown as typeof fetch;

    await expect(geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: 0 })).rejects.toMatchObject({
      code: "http_error",
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a definitive not-found", async () => {
    const fetchImpl = fetchMockReturning(jsonResponse({ result: { addressMatches: [] } }));

    await expect(geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: 0 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits the configured pause before retrying", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(GATEWAY_PAYLOAD, { status: 502 }))
        .mockResolvedValueOnce(jsonResponse(MATCH_PAYLOAD)) as unknown as typeof fetch;

      const pending = geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: 250 });
      await vi.advanceTimersByTimeAsync(249);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ address_match_count: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a negative retry pause before calling Census", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(geocodeAddressWithCensus(ADDRESS, { fetchImpl, retryDelayMs: -1 })).rejects.toMatchObject({
      code: "invalid_address",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries the coordinates lookup the same way", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(jsonResponse({ result: { geographies: { States: [{ GEOID: "08" }] } } })) as unknown as typeof fetch;

    const result = await geocodeCoordinatesWithCensus({ lat: 38.664, lng: -106.846 }, { fetchImpl, retryDelayMs: 0 });
    expect(result.geographies).toEqual({ States: [{ GEOID: "08" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Census geocoder deadline", () => {
  const ADDRESS = "143 Grizzley Peak Dr, Almont, CO 81210, USA";

  // Resolves only by abort, like a hung upstream.
  function hangingFetch(): typeof fetch {
    return vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    ) as unknown as typeof fetch;
  }

  it("clips an attempt's timeout to the time left before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = hangingFetch();
      const pending = geocodeAddressWithCensus(ADDRESS, {
        fetchImpl,
        timeoutMs: 6_000,
        retryDelayMs: 0,
        deadlineAt: Date.now() + 500,
      });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).rejects.toMatchObject({
        code: "timeout",
        message: "Census geocoder request timed out after 500ms",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the retry when too little of the budget is left for it", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const fetchImpl = hangingFetch();
      const pending = geocodeAddressWithCensus(ADDRESS, {
        fetchImpl,
        timeoutMs: 600,
        retryDelayMs: 0,
        deadlineAt: start + 600 + CENSUS_ADDRESS_GEOCODER_MIN_RETRY_WINDOW_MS,
      });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).rejects.toMatchObject({ code: "timeout" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a call once the deadline has passed", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(geocodeAddressWithCensus(ADDRESS, { fetchImpl, deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("time budget is exhausted"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-finite deadline before calling Census", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(geocodeAddressWithCensus(ADDRESS, { fetchImpl, deadlineAt: Number.NaN })).rejects.toMatchObject({
      code: "invalid_address",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
