import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GOOGLE_PLACES_TIMEOUT_MS,
  GOOGLE_PLACES_AUTOCOMPLETE_URL,
  GOOGLE_PLACES_DETAILS_URL_PREFIX,
  GooglePlacesAutocompleteError,
  parseGooglePlacesRetrievePayload,
  parseGooglePlacesSuggestPayload,
  retrieveSuggestedAddressWithGooglePlaces,
  suggestAddressesWithGooglePlaces,
} from "../../../src/pipeline/address/googlePlacesAutocomplete.js";

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

const OPTIONS = { apiKey: "test-api-key" };

const SUGGEST_INPUT = { input: "1600 Penn", sessionToken: "0aa2ee7a-8f0f-4b3f-9c53-1b6f9d6a2f11" };
const RETRIEVE_INPUT = { placeId: "ChIJGVtI4by3t4kRr51d_Qm_x58", sessionToken: SUGGEST_INPUT.sessionToken };

function suggestionPayload(placeId: string, text: string, mainText?: string, secondaryText?: string): unknown {
  return {
    placePrediction: {
      placeId,
      text: { text },
      ...(mainText || secondaryText
        ? {
            structuredFormat: {
              ...(mainText ? { mainText: { text: mainText } } : {}),
              ...(secondaryText ? { secondaryText: { text: secondaryText } } : {}),
            },
          }
        : {}),
    },
  };
}

describe("googlePlacesAutocomplete suggest", () => {
  it("posts the input with session token and US region restriction", async () => {
    const fetchImpl = fetchMockReturning(
      jsonResponse({
        suggestions: [
          suggestionPayload(
            "place-1",
            "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA",
            "1600 Pennsylvania Avenue NW",
            "Washington, DC 20500, USA"
          ),
        ],
      })
    );

    const suggestions = await suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl });

    expect(suggestions).toEqual([
      {
        place_id: "place-1",
        description: "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA",
        main_text: "1600 Pennsylvania Avenue NW",
        secondary_text: "Washington, DC 20500, USA",
      },
    ]);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_PLACES_AUTOCOMPLETE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-api-key");
    expect(headers["x-goog-fieldmask"]).toContain("suggestions.placePrediction.placeId");
    expect(JSON.parse(String(init.body))).toEqual({
      input: "1600 Penn",
      sessionToken: SUGGEST_INPUT.sessionToken,
      includedRegionCodes: ["us"],
    });
  });

  it("returns an empty list when Google omits suggestions", async () => {
    const fetchImpl = fetchMockReturning(jsonResponse({}));

    await expect(suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl })).resolves.toEqual([]);
  });

  it("skips malformed suggestion entries and falls back main_text to description", () => {
    const suggestions = parseGooglePlacesSuggestPayload({
      suggestions: [
        { unexpected: true },
        { placePrediction: { placeId: "  ", text: { text: "missing id" } } },
        // place_id outside the shared charset would be rejected by the
        // retrieve endpoint, so it must never be surfaced as a suggestion.
        { placePrediction: { placeId: "bad/id+chars=", text: { text: "unusable id" } } },
        { placePrediction: { placeId: "place-2", text: { text: "123 Main St, Austin, TX, USA" } } },
      ],
    });

    expect(suggestions).toEqual([
      {
        place_id: "place-2",
        description: "123 Main St, Austin, TX, USA",
        main_text: "123 Main St, Austin, TX, USA",
        secondary_text: "",
      },
    ]);
  });

  it("rejects a non-array suggestions field as bad_response", () => {
    expect(() => parseGooglePlacesSuggestPayload({ suggestions: "nope" })).toThrowError(GooglePlacesAutocompleteError);
    expect(() => parseGooglePlacesSuggestPayload({ suggestions: "nope" })).toThrowError(/not an array/);
  });

  it("rejects empty input and session token before calling Google", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      suggestAddressesWithGooglePlaces({ input: "  ", sessionToken: "token-1234" }, { ...OPTIONS, fetchImpl })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      suggestAddressesWithGooglePlaces({ input: "1600 Penn", sessionToken: " " }, { ...OPTIONS, fetchImpl })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps non-OK responses to http_error with truncated body", async () => {
    const fetchImpl = fetchMockReturning(
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" })
    );

    await expect(suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl })).rejects.toMatchObject({
      code: "http_error",
      message: expect.stringContaining("status=429"),
    });
  });

  it("maps non-JSON bodies to bad_response", async () => {
    const fetchImpl = fetchMockReturning(new Response("<html>oops</html>", { status: 200 }));

    await expect(suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("maps aborts to timeout", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const fetchImpl = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    await expect(
      suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl, timeoutMs: 25 })
    ).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("25ms"),
    });
  });

  it("wraps network failures as network_error instead of leaking TypeError", async () => {
    // Node fetch rejects DNS/connection failures with a plain TypeError; if it
    // leaked, the API layer would map it to 400 invalid_request.
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;

    await expect(suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl })).rejects.toMatchObject({
      name: "GooglePlacesAutocompleteError",
      code: "network_error",
      message: expect.stringContaining("fetch failed"),
    });
  });

  it("rejects invalid timeout configuration", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      suggestAddressesWithGooglePlaces(SUGGEST_INPUT, { ...OPTIONS, fetchImpl, timeoutMs: 0 })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(DEFAULT_GOOGLE_PLACES_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("googlePlacesAutocomplete retrieve", () => {
  it("fetches place details with the session token and field mask", async () => {
    const fetchImpl = fetchMockReturning(
      jsonResponse({ formattedAddress: "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA" })
    );

    const result = await retrieveSuggestedAddressWithGooglePlaces(RETRIEVE_INPUT, { ...OPTIONS, fetchImpl });

    expect(result).toEqual({
      address: "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA",
      location: null,
      granularity: "address",
      postal_code: null,
      state: null,
      locality: null,
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(url.startsWith(GOOGLE_PLACES_DETAILS_URL_PREFIX)).toBe(true);
    expect(parsedUrl.pathname).toBe(`/v1/places/${RETRIEVE_INPUT.placeId}`);
    expect(parsedUrl.searchParams.get("sessionToken")).toBe(RETRIEVE_INPUT.sessionToken);
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-api-key");
    expect(headers["x-goog-fieldmask"]).toBe("formattedAddress,location,types,addressComponents");
  });

  it("rejects a response without formattedAddress as bad_response", () => {
    expect(() => parseGooglePlacesRetrievePayload({ id: "place-1" })).toThrowError(/formattedAddress/);
    expect(() => parseGooglePlacesRetrievePayload({ formattedAddress: "  " })).toThrowError(
      GooglePlacesAutocompleteError
    );
  });

  it("passes through an in-range location and nulls a missing or malformed one", () => {
    expect(
      parseGooglePlacesRetrievePayload({
        formattedAddress: "1 Main St",
        location: { latitude: 40.8135, longitude: -74.0741 },
        types: ["street_address"],
      }).location
    ).toEqual({ lat: 40.8135, lng: -74.0741 });
    expect(
      parseGooglePlacesRetrievePayload({ formattedAddress: "1 Main St", types: ["street_address"] }).location
    ).toBeNull();
    expect(
      parseGooglePlacesRetrievePayload({
        formattedAddress: "1 Main St",
        location: { latitude: "40.8" },
        types: ["street_address"],
      }).location
    ).toBeNull();
  });

  it("nulls an out-of-range location instead of forwarding it", () => {
    // The resolve validator 400s out-of-range coordinates, which would kill
    // the whole search; the parser must drop them so the string path runs.
    for (const location of [
      { latitude: 91, longitude: 0 },
      { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: -181 },
      { latitude: Number.NaN, longitude: 0 },
    ]) {
      expect(parseGooglePlacesRetrievePayload({ formattedAddress: "1 Main St", location }).location).toBeNull();
    }
  });

  it("classifies a postal_code selection as zip, with the five-digit ZIP and no location", () => {
    // Real payload shape (live check 2026-08-25): Google returns an EMPTY
    // postalAddress for postal_code places — the ZIP lives only in the
    // postal_code address component, alongside locality/state components.
    const result = parseGooglePlacesRetrievePayload({
      formattedAddress: "Austin, TX 78701, USA",
      location: { latitude: 30.27, longitude: -97.74 },
      types: ["postal_code"],
      addressComponents: [
        { longText: "78701", shortText: "78701", types: ["postal_code"] },
        { longText: "Austin", shortText: "Austin", types: ["locality", "political"] },
        { longText: "Texas", shortText: "TX", types: ["administrative_area_level_1", "political"] },
      ],
    });
    // The centroid must not leak: an area's point would resolve to a full
    // exact ballot for whatever districts the point happens to sit in.
    expect(result).toEqual({
      address: "Austin, TX 78701, USA",
      location: null,
      granularity: "zip",
      postal_code: "78701",
      state: null,
      locality: null,
    });
  });

  it("trims a ZIP+4 postal_code component to five digits", () => {
    const result = parseGooglePlacesRetrievePayload({
      formattedAddress: "Austin, TX 78701, USA",
      types: ["postal_code"],
      addressComponents: [{ longText: "78701-2401", shortText: "78701-2401", types: ["postal_code"] }],
    });
    expect(result.granularity).toBe("zip");
    expect(result.postal_code).toBe("78701");
  });

  it("downgrades a postal_code selection without a usable postal_code component to region", () => {
    for (const addressComponents of [
      undefined,
      [],
      [{ longText: "Austin", shortText: "Austin", types: ["locality", "political"] }],
      [{ longText: "ABC", shortText: "ABC", types: ["postal_code"] }],
      [{ longText: "7870", shortText: "7870", types: ["postal_code"] }],
      [{ shortText: "78701", types: ["postal_code"] }],
      "not-an-array",
    ]) {
      const result = parseGooglePlacesRetrievePayload({
        formattedAddress: "Austin, TX 78701, USA",
        location: { latitude: 30.27, longitude: -97.74 },
        types: ["postal_code"],
        ...(addressComponents !== undefined ? { addressComponents } : {}),
      });
      expect(result.granularity).toBe("region");
      expect(result.postal_code).toBeNull();
      expect(result.location).toBeNull();
    }
  });

  it("classifies locality and other area selections as region with no location", () => {
    for (const types of [
      ["locality", "political"],
      ["neighborhood", "political"],
      ["administrative_area_level_2", "political"],
      ["sublocality_level_1", "sublocality", "political"],
    ]) {
      const result = parseGooglePlacesRetrievePayload({
        formattedAddress: "Austin, TX, USA",
        location: { latitude: 30.27, longitude: -97.74 },
        types,
      });
      expect(result.granularity).toBe("region");
      expect(result.location).toBeNull();
      expect(result.postal_code).toBeNull();
    }
  });

  it("carries state and locality on region selections, shape-checked", () => {
    const result = parseGooglePlacesRetrievePayload({
      formattedAddress: "Los Angeles, CA, USA",
      location: { latitude: 34.05, longitude: -118.24 },
      types: ["locality", "political"],
      addressComponents: [
        { longText: "Los Angeles", shortText: "Los Angeles", types: ["locality", "political"] },
        { longText: "California", shortText: "CA", types: ["administrative_area_level_1", "political"] },
        { longText: "United States", shortText: "US", types: ["country", "political"] },
      ],
    });
    expect(result.granularity).toBe("region");
    expect(result.location).toBeNull();
    expect(result.state).toBe("CA");
    expect(result.locality).toBe("Los Angeles");

    // A neighborhood pick carries the containing city's locality component,
    // but neighborhoods can straddle city lines — it must NOT become a place
    // lookup; only the state passes through.
    const neighborhood = parseGooglePlacesRetrievePayload({
      formattedAddress: "Hollywood, Los Angeles, CA, USA",
      types: ["neighborhood", "political"],
      addressComponents: [
        { longText: "Hollywood", shortText: "Hollywood", types: ["neighborhood", "political"] },
        { longText: "Los Angeles", shortText: "Los Angeles", types: ["locality", "political"] },
        { longText: "California", shortText: "CA", types: ["administrative_area_level_1", "political"] },
      ],
    });
    expect(neighborhood.granularity).toBe("region");
    expect(neighborhood.state).toBe("CA");
    expect(neighborhood.locality).toBeNull();

    // A malformed state code or missing components must read as null, and a
    // state selection has no locality component at all.
    const noComponents = parseGooglePlacesRetrievePayload({
      formattedAddress: "California, USA",
      types: ["administrative_area_level_1", "political"],
      addressComponents: [
        { longText: "California", shortText: "Calif.", types: ["administrative_area_level_1", "political"] },
      ],
    });
    expect(noComponents.state).toBeNull();
    expect(noComponents.locality).toBeNull();

    // Address selections never carry region fields.
    const address = parseGooglePlacesRetrievePayload({
      formattedAddress: "1 Main St, Springfield, IL 62701, USA",
      location: { latitude: 39.8, longitude: -89.65 },
      types: ["street_address"],
      addressComponents: [
        { longText: "Springfield", shortText: "Springfield", types: ["locality", "political"] },
        { longText: "Illinois", shortText: "IL", types: ["administrative_area_level_1", "political"] },
      ],
    });
    expect(address.state).toBeNull();
    expect(address.locality).toBeNull();
  });

  it("carries the ZIP on a street (route) selection but keeps it region, and never on other areas", () => {
    // "14 Dickey Dr, Gustavus" — Google knows the street, not the house.
    const street = parseGooglePlacesRetrievePayload({
      formattedAddress: "Dickey Dr, Gustavus, AK 99826, USA",
      location: { latitude: 58.41, longitude: -135.77 },
      types: ["route"],
      addressComponents: [
        { longText: "Dickey Drive", shortText: "Dickey Dr", types: ["route"] },
        { longText: "Gustavus", shortText: "Gustavus", types: ["locality", "political"] },
        { longText: "Alaska", shortText: "AK", types: ["administrative_area_level_1", "political"] },
        { longText: "99826", shortText: "99826", types: ["postal_code"] },
      ],
    });
    // Like a neighborhood, a road can cross city lines: the ZIP rides along
    // (its crosswalks decide what is safe), the locality does not.
    expect(street).toMatchObject({
      granularity: "region",
      location: null,
      postal_code: "99826",
      state: "AK",
      locality: null,
    });

    // A locality pick that happens to carry a postal_code component is a
    // whole town, not a street: no ZIP rides along.
    const town = parseGooglePlacesRetrievePayload({
      formattedAddress: "Gustavus, AK 99826, USA",
      types: ["locality", "political"],
      addressComponents: [
        { longText: "Gustavus", shortText: "Gustavus", types: ["locality", "political"] },
        { longText: "Alaska", shortText: "AK", types: ["administrative_area_level_1", "political"] },
        { longText: "99826", shortText: "99826", types: ["postal_code"] },
      ],
    });
    expect(town.granularity).toBe("region");
    expect(town.postal_code).toBeNull();
  });

  it("keeps the location for street addresses and venues", () => {
    for (const types of [["street_address"], ["premise"], ["establishment", "point_of_interest", "stadium"]]) {
      const result = parseGooglePlacesRetrievePayload({
        formattedAddress: "1 Main St, Springfield, IL 62701, USA",
        location: { latitude: 39.8, longitude: -89.65 },
        types,
      });
      expect(result.granularity).toBe("address");
      expect(result.location).toEqual({ lat: 39.8, lng: -89.65 });
    }
  });

  it("classifies a bare road as region — its point is arbitrary along the way", () => {
    const result = parseGooglePlacesRetrievePayload({
      formattedAddress: "US-101, California, USA",
      location: { latitude: 36.5, longitude: -121.9 },
      types: ["route"],
    });
    expect(result.granularity).toBe("region");
    expect(result.location).toBeNull();
  });

  it("fails closed on missing or empty types: address granularity, but no location", () => {
    // The type list is the proof that coordinates are a real point; without
    // it the string path still runs, but the centroid must not.
    for (const payload of [
      { formattedAddress: "1 Main St, Springfield, IL 62701, USA", location: { latitude: 39.8, longitude: -89.65 } },
      {
        formattedAddress: "1 Main St, Springfield, IL 62701, USA",
        location: { latitude: 39.8, longitude: -89.65 },
        types: [],
      },
      {
        formattedAddress: "1 Main St, Springfield, IL 62701, USA",
        location: { latitude: 39.8, longitude: -89.65 },
        types: "street_address",
      },
    ]) {
      const result = parseGooglePlacesRetrievePayload(payload);
      expect(result.granularity).toBe("address");
      expect(result.location).toBeNull();
    }
  });

  it("rejects empty placeId before calling Google", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      retrieveSuggestedAddressWithGooglePlaces({ placeId: " ", sessionToken: "token-1234" }, { ...OPTIONS, fetchImpl })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty apiKey before calling Google", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      retrieveSuggestedAddressWithGooglePlaces(RETRIEVE_INPUT, { apiKey: "  ", fetchImpl })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
