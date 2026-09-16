import type { Pool, PoolClient } from "pg";

import {
  buildAddressLookupCacheKey,
  DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS,
  readAddressLookupCache,
  type AddressLookupCacheClient,
  writeAddressLookupCache,
} from "./addressResolutionCache.js";
import {
  type CensusAddressCoordinates,
  type CensusAddressGeocodeResult,
  type CensusAddressGeocoderOptions,
  CensusAddressGeocoderError,
  type CensusCoordinatesGeocodeResult,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS,
  DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE,
  geocodeAddressWithCensusFallbacks,
  geocodeCoordinatesWithCensus,
} from "./censusAddressGeocoder.js";
import {
  type AddressDistrictKey,
  type AddressDistrictResolverWarning,
  resolveAddressDistrictKeysFromGeographies,
} from "./addressDistrictResolver.js";
import {
  type AddressDistrictLookupKey,
  type AddressResolvedDistrict,
  lookupAddressDistricts,
} from "./addressDistrictLookup.js";
import {
  applyUsHouse2026Redistricting,
  locateCensusBlockInteriorPoint,
  lookupUsHouse120thDistrict,
  type UsHouse120thLookup,
  usHouseKeyNeedsRedistrictingOverride,
} from "./usHouse2026Redistricting.js";

import { STATE_FIPS_BY_ABBREVIATION, STATE_NAME_BY_FIPS } from "../../constants/usStates.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// A coarse (ZIP or region) input the exact pipeline cannot serve. Distinct
// codes because each needs different user copy
// (docs/plans/partial-address-scope.md); apiErrors maps them all to 422 like
// address_not_found.
export type ZipDistrictResolutionErrorCode =
  | "full_address_required"
  | "zip_not_found"
  | "zip_multi_state"
  | "zip_unsupported_region"
  | "region_unsupported";

export class ZipDistrictResolutionError extends Error {
  readonly code: ZipDistrictResolutionErrorCode;

  constructor(code: ZipDistrictResolutionErrorCode, message: string) {
    super(message);
    this.name = "ZipDistrictResolutionError";
    this.code = code;
  }
}

export type AddressResolutionResult = {
  matched_address: string;
  /** null for coarse-scope results — the partial paths never geocode. */
  coordinates: {
    lat: number;
    lng: number;
  } | null;
  /** "exact" = geocoded street address (all district types); "zip" =
   * crosswalk-resolved partial ballot (statewide, plus county when the ZCTA
   * has exactly one county); "region" = area-selection partial ballot
   * (statewide, plus the incorporated place when the locality name matches
   * exactly one). */
  scope: "exact" | "zip" | "region";
  address_match_count: number;
  district_keys: AddressDistrictKey[];
  districts: AddressResolvedDistrict[];
  missing_district_keys: AddressDistrictLookupKey[];
  warnings: AddressDistrictResolverWarning[];
};

export type AddressResolverServiceOptions = {
  geocodeAddress?: (address: string) => Promise<CensusAddressGeocodeResult>;
  geocodeCoordinates?: (coordinates: CensusAddressCoordinates) => Promise<CensusCoordinatesGeocodeResult>;
  geocoderOptions?: CensusAddressGeocoderOptions;
  /**
   * Point lookup against TIGERweb's 120th Congressional Districts layer, used
   * only for addresses in the states that vote on redrawn House lines in
   * November 2026 (usHouse2026Redistricting.ts). Injectable for tests; the
   * default shares the geocoder's fetch and timeout settings.
   */
  lookupUsHouse120thDistrict?: UsHouse120thLookup;
  /**
   * Interior point of the address's census block, used as the 120th-layer
   * lookup point on the address-string path: the one-line geocoder places
   * the address on the street centerline, and a centerline point on a
   * boundary street matches both districts. Null falls back to the address
   * point. Injectable for tests; the default is one extra geocoder call.
   */
  locateCensusBlockInteriorPoint?: (address: string) => Promise<CensusAddressCoordinates | null>;
  cache?: AddressLookupCacheClient;
  cacheTtlSeconds?: number;
  /**
   * Client-supplied coordinates for the address (from the Google Places
   * autocomplete selection). When present the resolver looks districts up by
   * point instead of re-parsing the address string with the Census one-line
   * geocoder — venue-style addresses (stadiums, campuses) are routinely
   * absent from the Census street-range data even though Google locates
   * them. The address-string path stays as the fallback.
   */
  coordinates?: CensusAddressCoordinates;
  /**
   * Opt-in to the ZIP partial-ballot path. Default false so every existing
   * caller — most importantly the authenticated saved-address updater, which
   * must never replace a complete district set with a coarse one — keeps
   * exact-only behavior: a ZIP-shaped input fails fast with
   * full_address_required instead of dying in the geocoder.
   */
  allowPartial?: boolean;
  /**
   * Two-letter state from the server-classified Google region selection
   * (retrieve response `state`). Presence routes the request to the region
   * partial-ballot path — only under allowPartial, like the ZIP path.
   */
  regionState?: string;
  /**
   * Locality name from the same region selection ("Los Angeles"), when
   * Google named one. Used only to look for the matching incorporated
   * place's races; no match just means statewide only.
   */
  regionLocality?: string;
};

function effectiveGeocoderCacheContext(options: CensusAddressGeocoderOptions | undefined): {
  benchmark: string;
  vintage: string;
  layers: string;
} {
  return {
    benchmark: options?.benchmark?.trim() || DEFAULT_CENSUS_ADDRESS_GEOCODER_BENCHMARK,
    vintage: options?.vintage?.trim() || DEFAULT_CENSUS_ADDRESS_GEOCODER_VINTAGE,
    layers: options?.layers?.trim() || DEFAULT_CENSUS_ADDRESS_GEOCODER_LAYERS,
  };
}

// A bare ZIP (optionally ZIP+4). Anything else — including "Austin, TX
// 78701, USA" — stays on the exact geocoder pipeline.
const ZIP_INPUT_PATTERN = /^(\d{5})(?:-\d{4})?$/;

// The districts table covers 50 states + DC; these county-FIPS state
// prefixes exist in the crosswalk (149 ZCTAs) but have no districts.
const TERRITORY_STATE_FIPS = new Set(["60", "66", "69", "72", "78"]);

async function resolveZipToDistricts(db: Queryable, zip5: string): Promise<AddressResolutionResult> {
  const crosswalk = await db.query<{ county_geoid: string }>(
    `SELECT county_geoid FROM public.address_zcta_county WHERE zcta5 = $1 ORDER BY county_geoid`,
    [zip5]
  );
  if (crosswalk.rows.length === 0) {
    throw new ZipDistrictResolutionError(
      "zip_not_found",
      `ZIP code ${zip5} is not in the Census ZCTA data — enter a full street address`
    );
  }

  const countyGeoids = crosswalk.rows.map((row) => row.county_geoid);
  const stateFipsSet = new Set(countyGeoids.map((geoid) => geoid.slice(0, 2)));
  if (stateFipsSet.size > 1) {
    // 137 ZCTAs cross a state line; even the statewide races are ambiguous
    // there, and land-dominance is not address-dominance — refuse rather
    // than guess (docs/plans/partial-address-scope.md).
    throw new ZipDistrictResolutionError(
      "zip_multi_state",
      `ZIP code ${zip5} crosses state lines — enter a full street address`
    );
  }
  const stateFips = countyGeoids[0].slice(0, 2);
  if (TERRITORY_STATE_FIPS.has(stateFips)) {
    throw new ZipDistrictResolutionError(
      "zip_unsupported_region",
      `ZIP code ${zip5} is outside the covered 50 states and DC`
    );
  }

  // Statewide always; county only in the unambiguous single-county case.
  // Multi-county ZCTAs get statewide only — the visitor may live in any of
  // the counties, and a partial ballot must never show someone else's races.
  const districtKeys: AddressDistrictKey[] = [
    {
      district_type: "statewide",
      geoid_compact: stateFips,
      source: "layer_name",
      layer_name: "zcta_county_crosswalk",
    },
    ...(countyGeoids.length === 1
      ? [
          {
            district_type: "county",
            geoid_compact: countyGeoids[0],
            source: "layer_name",
            layer_name: "zcta_county_crosswalk",
          } satisfies AddressDistrictKey,
        ]
      : []),
  ];

  // Place races (mayor etc.) when the ZCTA lies wholly inside one legally
  // incorporated place — the import baked that containment decision into
  // address_zcta_place, so presence of a row IS the proof. Independent of
  // the county rule: an NYC ZIP spans boroughs (no single county) yet sits
  // entirely inside the city.
  const placeRow = await db.query<{ place_geoid: string }>(
    `SELECT place_geoid FROM public.address_zcta_place WHERE zcta5 = $1`,
    [zip5]
  );
  if (placeRow.rows.length === 1) {
    districtKeys.push({
      district_type: "place",
      geoid_compact: placeRow.rows[0].place_geoid,
      source: "layer_name",
      layer_name: "zcta_place_crosswalk",
    });
  }

  const districtLookup = await lookupAddressDistricts(db, districtKeys);
  return {
    matched_address: zip5,
    coordinates: null,
    scope: "zip",
    address_match_count: 1,
    district_keys: districtKeys,
    districts: districtLookup.districts,
    missing_district_keys: districtLookup.missing_district_keys,
    warnings: [],
  };
}

// Census place names carry the legal type and state ("Los Angeles city,
// California"; Alaska's consolidated "Juneau city and borough, Alaska").
// Only incorporated forms — a CDP is not a government, has no races, and is
// exactly the mailing-name trap the plan warns about; a Google locality that
// is really a CDP simply finds no match and stays statewide.
const INCORPORATED_PLACE_NAME_SUFFIXES = [
  "city",
  "city and borough",
  "town",
  "village",
  "borough",
  "municipality",
];

async function resolveRegionToDistricts(
  db: Queryable,
  input: { state: string; locality: string | null; matchedAddress: string }
): Promise<AddressResolutionResult> {
  const stateFips = STATE_FIPS_BY_ABBREVIATION[input.state];
  if (!stateFips) {
    throw new ZipDistrictResolutionError(
      "region_unsupported",
      `That area is outside the covered 50 states and DC — enter a city, ZIP code, or street address in the US`
    );
  }

  // Statewide is always safe: a city, neighborhood, or county never crosses
  // a state line. Everything finer needs identity, not geometry.
  const districtKeys: AddressDistrictKey[] = [
    {
      district_type: "statewide",
      geoid_compact: stateFips,
      source: "layer_name",
      layer_name: "region_selection",
    },
  ];

  // Place races only on an exact, unique name match: the Google locality name
  // plus the Census legal-type suffix must equal exactly one place district
  // in the state. Zero matches (CDPs, unincorporated communities,
  // consolidated governments with decorated names) or several fall back to
  // statewide only — a partial ballot must never show someone else's races.
  const locality = input.locality?.trim();
  if (locality) {
    const stateName = STATE_NAME_BY_FIPS[stateFips];
    // The bare form first: a handful of places carry the legal type inside
    // the proper name and get no suffix ("Carson City, Nevada"). CDPs can
    // never collide with it — their names always end " CDP".
    const candidateNames = [
      `${locality}, ${stateName}`,
      ...INCORPORATED_PLACE_NAME_SUFFIXES.map((suffix) => `${locality} ${suffix}, ${stateName}`),
    ].map((name) => name.toLowerCase());
    const places = await db.query<{ geoid_compact: string }>(
      `SELECT geoid_compact FROM public.districts
       WHERE district_type = 'place' AND state = $1 AND lower(name) = ANY($2)`,
      [input.state, candidateNames]
    );
    if (places.rows.length === 1) {
      districtKeys.push({
        district_type: "place",
        geoid_compact: places.rows[0].geoid_compact,
        source: "layer_name",
        layer_name: "region_selection",
      });
    }
  }

  const districtLookup = await lookupAddressDistricts(db, districtKeys);
  return {
    matched_address: input.matchedAddress,
    coordinates: null,
    scope: "region",
    address_match_count: 1,
    district_keys: districtKeys,
    districts: districtLookup.districts,
    missing_district_keys: districtLookup.missing_district_keys,
    warnings: [],
  };
}

export async function resolveAddressToDistricts(
  db: Queryable,
  address: string,
  options: AddressResolverServiceOptions = {}
): Promise<AddressResolutionResult> {
  const zipMatch = ZIP_INPUT_PATTERN.exec(address.trim());
  if (zipMatch) {
    if (!options.allowPartial) {
      throw new ZipDistrictResolutionError(
        "full_address_required",
        "A full street address is required — a ZIP code alone cannot determine your districts"
      );
    }
    return resolveZipToDistricts(db, zipMatch[1]);
  }

  // Region selection (city/neighborhood/county/state picked from the
  // autocomplete). The state comes from the server-classified retrieve
  // response relayed by the client — an honest chain, and the worst a forged
  // value can produce is a public statewide ballot the caller asked for.
  if (options.regionState !== undefined) {
    if (!options.allowPartial) {
      throw new ZipDistrictResolutionError(
        "full_address_required",
        "A full street address is required — an area alone cannot determine your districts"
      );
    }
    return resolveRegionToDistricts(db, {
      state: options.regionState,
      locality: options.regionLocality ?? null,
      matchedAddress: address.trim(),
    });
  }

  const geocodeAddress =
    options.geocodeAddress ?? ((input: string) => geocodeAddressWithCensusFallbacks(input, options.geocoderOptions));
  const lookupUsHouse120th =
    options.lookupUsHouse120thDistrict ??
    ((point: CensusAddressCoordinates) =>
      lookupUsHouse120thDistrict(point, {
        fetchImpl: options.geocoderOptions?.fetchImpl,
        timeoutMs: options.geocoderOptions?.timeoutMs,
      }));
  const locateBlockInteriorPoint =
    options.locateCensusBlockInteriorPoint ??
    ((input: string) => locateCensusBlockInteriorPoint(input, options.geocoderOptions));

  // Coordinate-first path. Never cached: the coordinates come from a Google
  // Places response, and Google's ToS forbids persisting Places data — the
  // redis cache would store them for 14 days. A dropped cache is acceptable
  // here; this path runs once per explicit dropdown selection.
  let coordinateGeocodeError: CensusAddressGeocoderError | null = null;
  if (options.coordinates) {
    const geocodeCoordinates =
      options.geocodeCoordinates ??
      ((input: CensusAddressCoordinates) => geocodeCoordinatesWithCensus(input, options.geocoderOptions));
    try {
      const located = await geocodeCoordinates(options.coordinates);
      const keyResolution = await applyUsHouse2026Redistricting(
        resolveAddressDistrictKeysFromGeographies(located.geographies),
        options.coordinates,
        lookupUsHouse120th
      );
      // Zero keys means the point matched no supported geography (bad
      // coordinates, or a Census data gap) — let the address-string path
      // below try, and fail with its clearer not_found if it also misses.
      if (keyResolution.district_keys.length > 0) {
        const districtLookup = await lookupAddressDistricts(db, keyResolution.district_keys);
        return {
          matched_address: address.trim(),
          coordinates: options.coordinates,
          scope: "exact",
          address_match_count: 1,
          district_keys: keyResolution.district_keys,
          districts: districtLookup.districts,
          missing_district_keys: districtLookup.missing_district_keys,
          warnings: keyResolution.warnings,
        };
      }
    } catch (error) {
      // Geocoder trouble (timeout, 5xx, malformed body) falls back to the
      // address-string path; anything else (e.g. the district DB lookup) is
      // a real failure and propagates. The error is kept: if the fallback
      // ends in not_found — predictable for the venue addresses this path
      // exists for — the response must say "upstream trouble, retry", not
      // "check your address".
      if (!(error instanceof CensusAddressGeocoderError)) {
        throw error;
      }
      coordinateGeocodeError = error;
    }
  }

  const cacheContext = effectiveGeocoderCacheContext(options.geocoderOptions);
  const cacheKey = buildAddressLookupCacheKey({ address, ...cacheContext });
  const cached = options.cache
    ? await readAddressLookupCache(options.cache, cacheKey).catch(() => null)
    : null;

  const resolved = cached
    ? cached
    : await (async () => {
        const geocoded = await geocodeAddress(address).catch((error: unknown) => {
          // not_found after a failed coordinate lookup: the string parser
          // predictably misses venue addresses, so the honest error is the
          // coordinate path's retryable one, not "address not found".
          if (coordinateGeocodeError && error instanceof CensusAddressGeocoderError && error.code === "not_found") {
            throw coordinateGeocodeError;
          }
          throw error;
        });
        const geocodedKeys = resolveAddressDistrictKeysFromGeographies(geocoded.geographies);
        // The block lookup is one more geocoder round trip, so it runs only
        // for addresses the override applies to. (The coordinate path above
        // needs none: Google points are rooftop, not centerline.)
        const lookupPoint = usHouseKeyNeedsRedistrictingOverride(geocodedKeys.district_keys)
          ? ((await locateBlockInteriorPoint(address)) ?? geocoded.coordinates)
          : geocoded.coordinates;
        const keyResolution = await applyUsHouse2026Redistricting(geocodedKeys, lookupPoint, lookupUsHouse120th);
        const value = {
          matched_address: geocoded.matched_address,
          coordinates: geocoded.coordinates,
          address_match_count: geocoded.address_match_count,
          district_keys: keyResolution.district_keys,
          warnings: keyResolution.warnings,
        };
        if (options.cache) {
          await writeAddressLookupCache(
            options.cache,
            cacheKey,
            value,
            options.cacheTtlSeconds ?? DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS
          ).catch(() => undefined);
        }
        return value;
      })();

  const districtLookup = await lookupAddressDistricts(db, resolved.district_keys);

  return {
    matched_address: resolved.matched_address,
    coordinates: resolved.coordinates,
    scope: "exact",
    address_match_count: resolved.address_match_count,
    district_keys: resolved.district_keys,
    districts: districtLookup.districts,
    missing_district_keys: districtLookup.missing_district_keys,
    warnings: resolved.warnings,
  };
}
