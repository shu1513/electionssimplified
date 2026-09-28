import type { Pool, PoolClient } from "pg";

import type { AddressComponentKey, AddressDistrictKey, AddressDistrictType } from "./addressDistrictResolver.js";

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
  population: number;
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
  population: number;
  representation_power_score: string | number | null;
  // The key the caller asked for, which is not the row we return when the
  // requested row is a suppressed duplicate of another government's row.
  // NULL for a district found through district_components.
  requested_district_type: AddressDistrictType | null;
  requested_geoid_compact: string | null;
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

// Districts Census does not publish (New Hampshire's floterial House seats
// and Executive Council districts) are stored as the union of Census units in
// district_components. The address is inside such a district when any of its
// units is: a base House district from the keys, or a town from the
// component keys.
function componentLookupPairs(
  keys: readonly AddressDistrictLookupKey[],
  componentKeys: readonly AddressComponentKey[]
): { types: string[]; geoids: string[] } {
  const pairs = new Map<string, [string, string]>();
  for (const key of keys) {
    if (key.district_type === "state_lower") {
      pairs.set(`state_lower::${key.geoid_compact}`, ["state_lower", key.geoid_compact]);
    }
  }
  for (const key of componentKeys) {
    const geoid = key.geoid.trim();
    if (geoid.length > 0) {
      pairs.set(`${key.component_type}::${geoid}`, [key.component_type, geoid]);
    }
  }
  const values = [...pairs.values()];
  return { types: values.map(([type]) => type), geoids: values.map(([, geoid]) => geoid) };
}

export async function lookupAddressDistricts(
  db: Queryable,
  keys: readonly (AddressDistrictKey | AddressDistrictLookupKey)[],
  componentKeys: readonly AddressComponentKey[] = []
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
  const components = componentLookupPairs(normalizedKeys, componentKeys);

  const directSql = `
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
      d.geoid_compact AS requested_geoid_compact,
      requested.ord AS ord
    FROM requested
    JOIN public.districts AS d
      ON d.district_type = requested.district_type
     AND d.geoid_compact = requested.geoid_compact
    LEFT JOIN public.districts AS owner
      ON owner.id = d.canonical_district_id
  `;
  // Component-built districts join only when the address has a unit that can
  // be a component; the partial (ZIP/region) paths never do.
  const compositeSql = `
    SELECT DISTINCT
      d.id,
      d.district_type,
      d.geoid_compact,
      d.name,
      d.state,
      d.state_fips,
      d.population,
      d.representation_power_score,
      NULL::text AS requested_district_type,
      NULL::text AS requested_geoid_compact,
      NULL::bigint AS ord
    FROM unnest($3::text[], $4::text[]) AS unit(component_type, component_geoid)
    JOIN public.district_components AS dc
      ON dc.component_type = unit.component_type
     AND dc.component_geoid = unit.component_geoid
    JOIN public.districts AS d
      ON d.id = dc.district_id
  `;
  const hasComponents = components.types.length > 0;

  const result = await db.query<DistrictRow>(
    `
      WITH requested AS (
        SELECT district_type, geoid_compact, ord
        FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS keys(district_type, geoid_compact, ord)
      )
      ${directSql}
      ${hasComponents ? `UNION ALL ${compositeSql}` : ""}
      ORDER BY ord ASC NULLS LAST, district_type ASC, geoid_compact ASC
    `,
    hasComponents
      ? [districtTypes, geoidCompacts, components.types, components.geoids]
      : [districtTypes, geoidCompacts]
  );

  // An Arlington, Virginia address geocodes into both the counties layer (51013)
  // and the places layer (Arlington CDP, 5103000), and the CDP is not a
  // government — it collapses onto the county, yielding the same district twice.
  // Keep the first occurrence: `requested.ord` preserves the caller's ordering,
  // which the ballot relies on. Component-built districts sort after it.
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
    result.rows
      .filter((row) => row.requested_district_type !== null)
      .map((row) => `${row.requested_district_type}::${row.requested_geoid_compact}`)
  );
  const missingDistrictKeys = normalizedKeys.filter(
    (key) => !foundKeys.has(`${key.district_type}::${key.geoid_compact}`)
  );

  return {
    districts,
    missing_district_keys: missingDistrictKeys,
  };
}
