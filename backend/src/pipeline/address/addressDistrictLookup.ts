import type { Pool, PoolClient } from "pg";

import type { AddressDistrictKey, AddressDistrictType } from "./addressDistrictResolver.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type AddressDistrictLookupKey = {
  district_type: AddressDistrictType;
  geoid_compact: string;
};

export type AddressResolvedDistrict = {
  id: string;
  district_type: AddressDistrictType;
  geoid_compact: string;
  name: string;
  state: string;
  state_fips: string;
  population: number | null;
  representation_power_score: number | null;
};

export type AddressDistrictLookupResult = {
  districts: AddressResolvedDistrict[];
  missing_district_keys: AddressDistrictLookupKey[];
};

type DistrictRow = {
  id: string;
  district_type: AddressDistrictType;
  geoid_compact: string;
  name: string;
  state: string;
  state_fips: string;
  population: number | null;
  representation_power_score: string | number | null;
  // The key the caller asked for, which is not the row we return when the
  // requested row is a suppressed duplicate of another government's row.
  requested_district_type: AddressDistrictType;
  requested_geoid_compact: string;
};

function normalizeLookupKeys(keys: readonly (AddressDistrictKey | AddressDistrictLookupKey)[]): AddressDistrictLookupKey[] {
  const normalized: AddressDistrictLookupKey[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const districtType = key.district_type;
    const geoidCompact = key.geoid_compact.trim();
    if (geoidCompact.length === 0) {
      continue;
    }

    const dedupeKey = `${districtType}::${geoidCompact}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      district_type: districtType,
      geoid_compact: geoidCompact,
    });
  }

  return normalized;
}

function parseRepresentationPowerScore(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function toResolvedDistrict(row: DistrictRow): AddressResolvedDistrict {
  return {
    id: row.id,
    district_type: row.district_type,
    geoid_compact: row.geoid_compact,
    name: row.name,
    state: row.state,
    state_fips: row.state_fips,
    population: row.population,
    representation_power_score: parseRepresentationPowerScore(row.representation_power_score),
  };
}

export async function lookupAddressDistricts(
  db: Queryable,
  keys: readonly (AddressDistrictKey | AddressDistrictLookupKey)[]
): Promise<AddressDistrictLookupResult> {
  const normalizedKeys = normalizeLookupKeys(keys);
  if (normalizedKeys.length === 0) {
    return {
      districts: [],
      missing_district_keys: [],
    };
  }

  const districtTypes = normalizedKeys.map((key) => key.district_type);
  const geoidCompacts = normalizedKeys.map((key) => key.geoid_compact);

  const result = await db.query<DistrictRow>(
    `
      WITH requested AS (
        SELECT district_type, geoid_compact, ord
        FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS keys(district_type, geoid_compact, ord)
      )
      SELECT
        COALESCE(owner.id, d.id) AS id,
        COALESCE(owner.district_type, d.district_type) AS district_type,
        COALESCE(owner.geoid_compact, d.geoid_compact) AS geoid_compact,
        COALESCE(owner.name, d.name) AS name,
        COALESCE(owner.state, d.state) AS state,
        COALESCE(owner.state_fips, d.state_fips) AS state_fips,
        COALESCE(owner.population, d.population) AS population,
        COALESCE(owner.representation_power_score, d.representation_power_score) AS representation_power_score,
        d.district_type AS requested_district_type,
        d.geoid_compact AS requested_geoid_compact
      FROM requested
      JOIN public.districts AS d
        ON d.district_type = requested.district_type
       AND d.geoid_compact = requested.geoid_compact
      LEFT JOIN public.districts AS owner
        ON owner.id = d.canonical_district_id
      ORDER BY requested.ord ASC
    `,
    [districtTypes, geoidCompacts]
  );

  // An Arlington, Virginia address geocodes into both the counties layer (51013)
  // and the places layer (Arlington CDP, 5103000), and the CDP is not a
  // government — it collapses onto the county, yielding the same district twice.
  // Keep the first occurrence: `requested.ord` preserves the caller's ordering,
  // which the ballot relies on.
  const districts: AddressResolvedDistrict[] = [];
  const seenDistrictIds = new Set<string>();
  for (const row of result.rows) {
    if (seenDistrictIds.has(row.id)) {
      continue;
    }
    seenDistrictIds.add(row.id);
    districts.push(toResolvedDistrict(row));
  }

  // Resolution is judged on the key the caller asked for. A key that matched a
  // suppressed row was found, even though the row handed back is its owner.
  const foundKeys = new Set(
    result.rows.map((row) => `${row.requested_district_type}::${row.requested_geoid_compact}`)
  );
  const missingDistrictKeys = normalizedKeys.filter(
    (key) => !foundKeys.has(`${key.district_type}::${key.geoid_compact}`)
  );

  return {
    districts,
    missing_district_keys: missingDistrictKeys,
  };
}
