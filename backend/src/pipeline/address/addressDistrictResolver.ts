export const ADDRESS_DISTRICT_TYPES = [
  "statewide",
  "us_house",
  "state_upper",
  "state_lower",
  // No Census layer carries these; they come back from the district lookup
  // through district_components, never from a geocoder key.
  "state_executive_council",
  "county",
  "place",
  "school_unified",
  "school_secondary",
  "school_elementary",
] as const;

export type AddressDistrictType = (typeof ADDRESS_DISTRICT_TYPES)[number];

export type AddressDistrictKeyResolutionSource = "mtfcc" | "layer_name";

export type AddressDistrictKey = {
  district_type: AddressDistrictType;
  geoid_compact: string;
  source: AddressDistrictKeyResolutionSource;
  layer_name: string;
  mtfcc?: string;
  name?: string;
};

export type AddressDistrictResolverWarning = {
  layer_name: string;
  geoid?: string;
  mtfcc?: string;
  reason: string;
};

// Census units that are not districts themselves but are building blocks of
// districts Census does not publish (district_components). New Hampshire's
// Executive Council districts are whole towns, which Census calls county
// subdivisions.
export type AddressComponentType = "county_subdivision";

export type AddressComponentKey = {
  component_type: AddressComponentType;
  geoid: string;
};

export type AddressDistrictResolution = {
  district_keys: AddressDistrictKey[];
  component_keys: AddressComponentKey[];
  warnings: AddressDistrictResolverWarning[];
};

export const CENSUS_MTFCC_TO_COMPONENT_TYPE: Readonly<Record<string, AddressComponentType>> = {
  G4040: "county_subdivision",
};

export const CENSUS_MTFCC_TO_DISTRICT_TYPE: Readonly<Record<string, AddressDistrictType>> = {
  G4000: "statewide",
  G5200: "us_house",
  G5210: "state_upper",
  G5220: "state_lower",
  G4020: "county",
  G4110: "place",
  G5420: "school_unified",
  G5410: "school_secondary",
  G5400: "school_elementary",
};

const DISTRICT_TYPE_ORDER = new Map<AddressDistrictType, number>(
  ADDRESS_DISTRICT_TYPES.map((districtType, index) => [districtType, index])
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function districtTypeFromMtfcc(mtfcc: unknown): AddressDistrictType | null {
  if (typeof mtfcc !== "string") {
    return null;
  }
  return CENSUS_MTFCC_TO_DISTRICT_TYPE[mtfcc.trim().toUpperCase()] ?? null;
}

export function districtTypeFromLayerName(layerName: string): AddressDistrictType | null {
  const normalized = layerName.trim().toLowerCase();
  if (normalized === "states") {
    return "statewide";
  }
  if (/\bcongressional districts?\b/.test(normalized)) {
    return "us_house";
  }
  if (/\bstate legislative districts?\b/.test(normalized) && /\bupper\b/.test(normalized)) {
    return "state_upper";
  }
  if (/\bstate legislative districts?\b/.test(normalized) && /\blower\b/.test(normalized)) {
    return "state_lower";
  }
  if (normalized === "counties") {
    return "county";
  }
  if (/\bincorporated places?\b/.test(normalized)) {
    return "place";
  }
  if (/\bunified school districts?\b/.test(normalized)) {
    return "school_unified";
  }
  if (/\bsecondary school districts?\b/.test(normalized)) {
    return "school_secondary";
  }
  if (/\belementary school districts?\b/.test(normalized)) {
    return "school_elementary";
  }
  return null;
}

function componentTypeFromLayerName(layerName: string): AddressComponentType | undefined {
  return layerName.trim().toLowerCase() === "county subdivisions" ? "county_subdivision" : undefined;
}

function componentTypeFromMtfcc(mtfcc: unknown): AddressComponentType | undefined {
  if (typeof mtfcc !== "string") {
    return undefined;
  }
  return CENSUS_MTFCC_TO_COMPONENT_TYPE[mtfcc.trim().toUpperCase()];
}

function sortDistrictKeys(keys: AddressDistrictKey[]): AddressDistrictKey[] {
  return [...keys].sort((left, right) => {
    const leftOrder = DISTRICT_TYPE_ORDER.get(left.district_type) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = DISTRICT_TYPE_ORDER.get(right.district_type) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.geoid_compact.localeCompare(right.geoid_compact);
  });
}

function preferDistrictKey(existing: AddressDistrictKey, next: AddressDistrictKey): AddressDistrictKey {
  if (existing.source === "layer_name" && next.source === "mtfcc") {
    return next;
  }
  return existing;
}

// True when the warning's layer or MTFCC maps to a supported district type or
// a component unit, i.e. a district the app tracks failed to resolve into a
// key (missing GEOID, MTFCC/layer conflict, malformed feature). A lost town is
// a lost component-built district (the council seat), so it counts too.
// Warnings from layers the geocoder returns but the app ignores (tracts,
// blocks — layers=all requests everything) stay non-blocking.
export function warningAffectsSupportedDistrict(warning: AddressDistrictResolverWarning): boolean {
  return (
    districtTypeFromLayerName(warning.layer_name) !== null ||
    districtTypeFromMtfcc(warning.mtfcc) !== null ||
    componentTypeFromLayerName(warning.layer_name) !== undefined ||
    componentTypeFromMtfcc(warning.mtfcc) !== undefined
  );
}

export function resolveAddressDistrictKeysFromGeographies(geographies: unknown): AddressDistrictResolution {
  const warnings: AddressDistrictResolverWarning[] = [];
  const deduped = new Map<string, AddressDistrictKey>();
  const componentKeys = new Map<string, AddressComponentKey>();

  if (!isRecord(geographies)) {
    return {
      district_keys: [],
      component_keys: [],
      warnings: [{ layer_name: "", reason: "geographies must be an object" }],
    };
  }

  for (const [layerName, rawFeatures] of Object.entries(geographies)) {
    if (!Array.isArray(rawFeatures)) {
      warnings.push({ layer_name: layerName, reason: "geography layer is not an array" });
      continue;
    }

    const layerDistrictType = districtTypeFromLayerName(layerName);
    for (const rawFeature of rawFeatures) {
      if (!isRecord(rawFeature)) {
        warnings.push({ layer_name: layerName, reason: "geography feature is not an object" });
        continue;
      }

      const geoid = readNonEmptyString(rawFeature, "GEOID");
      const mtfcc = readNonEmptyString(rawFeature, "MTFCC");
      const mtfccDistrictType = districtTypeFromMtfcc(mtfcc);
      const name = readNonEmptyString(rawFeature, "NAME") ?? undefined;

      if (!geoid) {
        warnings.push({ layer_name: layerName, mtfcc: mtfcc ?? undefined, reason: "geography feature is missing GEOID" });
        continue;
      }

      const componentType = mtfcc ? componentTypeFromMtfcc(mtfcc) : componentTypeFromLayerName(layerName);
      if (componentType) {
        componentKeys.set(`${componentType}::${geoid}`, { component_type: componentType, geoid });
        continue;
      }

      if (mtfccDistrictType && layerDistrictType && mtfccDistrictType !== layerDistrictType) {
        warnings.push({
          layer_name: layerName,
          geoid,
          mtfcc: mtfcc ?? undefined,
          reason: `MTFCC maps to ${mtfccDistrictType} but layer name maps to ${layerDistrictType}`,
        });
        continue;
      }

      const districtType = mtfccDistrictType ?? layerDistrictType;
      if (!districtType) {
        continue;
      }

      const key: AddressDistrictKey = {
        district_type: districtType,
        geoid_compact: geoid,
        source: mtfccDistrictType ? "mtfcc" : "layer_name",
        layer_name: layerName,
        ...(mtfcc ? { mtfcc } : {}),
        ...(name ? { name } : {}),
      };
      const dedupeKey = `${key.district_type}::${key.geoid_compact}`;
      const existing = deduped.get(dedupeKey);
      deduped.set(dedupeKey, existing ? preferDistrictKey(existing, key) : key);
    }
  }

  return {
    district_keys: sortDistrictKeys([...deduped.values()]),
    component_keys: [...componentKeys.values()].sort((left, right) => left.geoid.localeCompare(right.geoid)),
    warnings,
  };
}

export function extractAddressDistrictKeysFromGeographies(geographies: unknown): AddressDistrictKey[] {
  return resolveAddressDistrictKeysFromGeographies(geographies).district_keys;
}
