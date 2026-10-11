export type MassachusettsFinanceEligibleOfficeKey = `${string}::${string}`;

export type MassachusettsFinanceOfficeScope = "statewide" | "state_upper" | "state_lower" | "place";

// OCPF's depository system covers municipal candidates statewide (45 cities in
// the 2025 mayoral feed), but VoteApp enables cities one at a time. The value
// is the city token OCPF prints after the office class in officeSought
// ("Mayoral, Boston" / "City Councilor, Boston"), pre-normalized with
// normalizeMassachusettsOcpfDistrict so it compares directly against parsed
// filer rows.
export const MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_BY_GEOID = new Map<string, string>([
  ["2507000", "BOSTON"],
]);

const MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_SET = new Set(MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_BY_GEOID.values());

export function massachusettsMunicipalFinanceCityForGeoid(geoid: string | null | undefined): string | null {
  return MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_BY_GEOID.get(geoid?.trim() ?? "") ?? null;
}

export type MassachusettsOcpfOfficeMapping = {
  officeScope: MassachusettsFinanceOfficeScope;
  officeCanonicalName: string;
  officeKey: MassachusettsFinanceEligibleOfficeKey;
  ocpfOffice: string;
  requiresDistrict: boolean;
  district: string | null;
};

export type MassachusettsOcpfOfficeSearchInput = {
  ocpfOffice: string;
  district: string | null;
};

export const MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS = [
  "statewide::Governor",
  "statewide::Lieutenant Governor",
  "statewide::Secretary of State",
  "statewide::Attorney General",
  "statewide::State Treasurer",
  "statewide::State Auditor",
  "state_upper::State Senator",
  "state_lower::State Lower Chamber Legislator",
  "place::Mayor",
  "place::City Council Member",
] as const satisfies readonly MassachusettsFinanceEligibleOfficeKey[];

const MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEY_SET = new Set<string>(
  MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS
);

type MassachusettsOcpfOfficeDefinition = {
  officeScope: MassachusettsFinanceOfficeScope;
  officeCanonicalName: string;
  ocpfOffice: string;
  requiresDistrict: boolean;
};

const MASSACHUSETTS_OCPF_STATEWIDE_OFFICE_DEFINITIONS = new Map<string, MassachusettsOcpfOfficeDefinition>([
  [
    "STATEWIDE GOVERNOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "Governor",
      ocpfOffice: "Statewide, Governor",
      requiresDistrict: false,
    },
  ],
  [
    "GOVERNOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "Governor",
      ocpfOffice: "Statewide, Governor",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE LIEUTENANT GOVERNOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "Lieutenant Governor",
      ocpfOffice: "Statewide, Lt. Governor",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE LT GOVERNOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "Lieutenant Governor",
      ocpfOffice: "Statewide, Lt. Governor",
      requiresDistrict: false,
    },
  ],
  [
    "LIEUTENANT GOVERNOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "Lieutenant Governor",
      ocpfOffice: "Statewide, Lt. Governor",
      requiresDistrict: false,
    },
  ],
  [
    "LT GOVERNOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "Lieutenant Governor",
      ocpfOffice: "Statewide, Lt. Governor",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE SECRETARY OF STATE",
    {
      officeScope: "statewide",
      officeCanonicalName: "Secretary of State",
      ocpfOffice: "Statewide, Secretary of State",
      requiresDistrict: false,
    },
  ],
  [
    "SECRETARY OF STATE",
    {
      officeScope: "statewide",
      officeCanonicalName: "Secretary of State",
      ocpfOffice: "Statewide, Secretary of State",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE SECRETARY OF COMMONWEALTH",
    {
      officeScope: "statewide",
      officeCanonicalName: "Secretary of State",
      ocpfOffice: "Statewide, Secretary of State",
      requiresDistrict: false,
    },
  ],
  [
    "SECRETARY OF COMMONWEALTH",
    {
      officeScope: "statewide",
      officeCanonicalName: "Secretary of State",
      ocpfOffice: "Statewide, Secretary of State",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE ATTORNEY GENERAL",
    {
      officeScope: "statewide",
      officeCanonicalName: "Attorney General",
      ocpfOffice: "Statewide, Attorney General",
      requiresDistrict: false,
    },
  ],
  [
    "ATTORNEY GENERAL",
    {
      officeScope: "statewide",
      officeCanonicalName: "Attorney General",
      ocpfOffice: "Statewide, Attorney General",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE TREASURER",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Treasurer",
      ocpfOffice: "Statewide, Treasurer",
      requiresDistrict: false,
    },
  ],
  // OCPF's live label for the office (Deborah Goldberg, Elizabeth Dionne);
  // "Statewide, Treasurer" alone matched no filer.
  [
    "STATEWIDE TREASURER OF THE COMMONWEALTH",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Treasurer",
      ocpfOffice: "Statewide, Treasurer",
      requiresDistrict: false,
    },
  ],
  [
    "TREASURER OF THE COMMONWEALTH",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Treasurer",
      ocpfOffice: "Statewide, Treasurer",
      requiresDistrict: false,
    },
  ],
  [
    "STATE TREASURER",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Treasurer",
      ocpfOffice: "Statewide, Treasurer",
      requiresDistrict: false,
    },
  ],
  [
    "TREASURER",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Treasurer",
      ocpfOffice: "Statewide, Treasurer",
      requiresDistrict: false,
    },
  ],
  [
    "STATEWIDE AUDITOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Auditor",
      ocpfOffice: "Statewide, Auditor",
      requiresDistrict: false,
    },
  ],
  [
    "STATE AUDITOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Auditor",
      ocpfOffice: "Statewide, Auditor",
      requiresDistrict: false,
    },
  ],
  [
    "AUDITOR",
    {
      officeScope: "statewide",
      officeCanonicalName: "State Auditor",
      ocpfOffice: "Statewide, Auditor",
      requiresDistrict: false,
    },
  ],
]);

// Municipal definitions use the district slot for the OCPF city token, so the
// resolver's existing office+district comparison doubles as the city match.
const MASSACHUSETTS_MUNICIPAL_MAYOR_DEFINITION: MassachusettsOcpfOfficeDefinition = {
  officeScope: "place",
  officeCanonicalName: "Mayor",
  ocpfOffice: "Mayoral",
  requiresDistrict: true,
};

const MASSACHUSETTS_MUNICIPAL_COUNCIL_DEFINITION: MassachusettsOcpfOfficeDefinition = {
  officeScope: "place",
  officeCanonicalName: "City Council Member",
  ocpfOffice: "City Councilor",
  requiresDistrict: true,
};

const MASSACHUSETTS_APP_OFFICE_DEFINITIONS: readonly MassachusettsOcpfOfficeDefinition[] = [
  ...MASSACHUSETTS_OCPF_STATEWIDE_OFFICE_DEFINITIONS.values(),
  {
    officeScope: "state_upper",
    officeCanonicalName: "State Senator",
    ocpfOffice: "Senate",
    requiresDistrict: true,
  },
  {
    officeScope: "state_lower",
    officeCanonicalName: "State Lower Chamber Legislator",
    ocpfOffice: "House",
    requiresDistrict: true,
  },
  MASSACHUSETTS_MUNICIPAL_MAYOR_DEFINITION,
  MASSACHUSETTS_MUNICIPAL_COUNCIL_DEFINITION,
];

const MASSACHUSETTS_APP_OFFICE_TO_OCPF = new Map<string, MassachusettsOcpfOfficeDefinition>(
  MASSACHUSETTS_APP_OFFICE_DEFINITIONS.map((definition) => [
    `${definition.officeScope}::${definition.officeCanonicalName}`,
    definition,
  ])
);

export function toMassachusettsFinanceOfficeKey(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
}): MassachusettsFinanceEligibleOfficeKey | null {
  const officeScope = input.officeScope?.trim();
  const officeCanonicalName = input.officeCanonicalName?.trim();
  if (!officeScope || !officeCanonicalName) {
    return null;
  }
  return `${officeScope}::${officeCanonicalName}`;
}

export function isMassachusettsFinanceEligibleOffice(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
}): boolean {
  const key = toMassachusettsFinanceOfficeKey(input);
  return key !== null && MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(key);
}

export function normalizeMassachusettsOcpfOfficeLabel(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return normalized ? normalized : null;
}

// Word-ordinal lookup for canonicalizing district names. Our catalog names
// Senate districts with word ordinals ("Third Suffolk District (2024);
// Massachusetts") while OCPF filer labels use numeric ordinals and ampersands
// ("Senate, 3rd Suffolk", "Senate, 1st Essex & Middlesex"). Both sides reduce
// to the same bare-number county-list form ("3 SUFFOLK", "1 ESSEX MIDDLESEX").
// Validated against the full inventory (2026): all 200 MA legislative
// districts canonicalize uniquely per chamber, and every current-district
// OCPF label maps onto exactly one catalog row (the only misses are filers
// still carrying pre-2021-redistricting office labels, which name districts
// that no longer exist).
const MASSACHUSETTS_WORD_ORDINALS = new Map<string, string>([
  ["FIRST", "1"],
  ["SECOND", "2"],
  ["THIRD", "3"],
  ["FOURTH", "4"],
  ["FIFTH", "5"],
  ["SIXTH", "6"],
  ["SEVENTH", "7"],
  ["EIGHTH", "8"],
  ["NINTH", "9"],
  ["TENTH", "10"],
  ["ELEVENTH", "11"],
  ["TWELFTH", "12"],
  ["THIRTEENTH", "13"],
  ["FOURTEENTH", "14"],
  ["FIFTEENTH", "15"],
  ["SIXTEENTH", "16"],
  ["SEVENTEENTH", "17"],
  ["EIGHTEENTH", "18"],
  ["NINETEENTH", "19"],
  ["TWENTIETH", "20"],
]);

const MASSACHUSETTS_WORD_ORDINAL_TENS = new Map<string, number>([
  ["TWENTY", 20],
  ["THIRTY", 30],
]);

const SIMPLE_WORD_ORDINAL_PATTERN = [...MASSACHUSETTS_WORD_ORDINALS.keys()].join("|");
const WORD_ORDINAL_TENS_PATTERN = [...MASSACHUSETTS_WORD_ORDINAL_TENS.keys()].join("|");

export function normalizeMassachusettsOcpfDistrict(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value
    .toUpperCase()
    // "(2024)" catalog vintage markers.
    .replace(/\([^)]*\)/g, " ")
    // Catalog names end "; Massachusetts" — everything after the first
    // semicolon is state suffix, never district identity.
    .split(";")[0]!
    // Punctuation, ampersands, and hyphens all join county lists; spaces
    // make the list-joiner style irrelevant.
    .replace(/[.,&/-]/g, " ")
    .replace(/\b(?:DISTRICT|DIST)\b/g, " ")
    // "AND" is a pure list joiner too ("Middlesex and Norfolk" ==
    // "Middlesex & Norfolk"); it never distinguishes two districts.
    .replace(/\bAND\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Compound word ordinals first ("TWENTY FIRST" -> "21")...
    .replace(
      new RegExp(`\\b(${WORD_ORDINAL_TENS_PATTERN}) (${SIMPLE_WORD_ORDINAL_PATTERN})\\b`, "g"),
      (_match, tens: string, ones: string) =>
        String(MASSACHUSETTS_WORD_ORDINAL_TENS.get(tens)! + Number(MASSACHUSETTS_WORD_ORDINALS.get(ones)!))
    )
    // ...then simple ones ("THIRD" -> "3")...
    .replace(
      new RegExp(`\\b(${SIMPLE_WORD_ORDINAL_PATTERN})\\b`, "g"),
      (match) => MASSACHUSETTS_WORD_ORDINALS.get(match)!
    )
    // ...and numeric ordinal suffixes ("3RD" -> "3") so both styles agree.
    .replace(/\b(\d+)(?:ST|ND|RD|TH)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized : null;
}

function splitOcpfLegislativeOfficeLabel(value: string | null | undefined): {
  ocpfOffice: "Senate" | "House";
  district: string | null;
} | null {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return null;
  }
  const match = /^(Senate|House)\s*,?\s*(.+)?$/i.exec(trimmed);
  if (!match?.[1]) {
    return null;
  }
  return {
    ocpfOffice: match[1].toLowerCase() === "senate" ? "Senate" : "House",
    district: normalizeMassachusettsOcpfDistrict(match[2]),
  };
}

// Exact observed OCPF municipal formats: "Mayoral, Boston",
// "City Councilor, Boston". Council district vs at-large is not encoded by
// OCPF, so the city is the only municipal identity OCPF contributes.
function splitOcpfMunicipalOfficeLabel(value: string | null | undefined): {
  definition: MassachusettsOcpfOfficeDefinition;
  city: string | null;
} | null {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return null;
  }
  const match = /^(Mayoral|City Councilor)\s*,\s*(.+)$/i.exec(trimmed);
  if (!match?.[1]) {
    return null;
  }
  return {
    definition:
      match[1].toLowerCase() === "mayoral"
        ? MASSACHUSETTS_MUNICIPAL_MAYOR_DEFINITION
        : MASSACHUSETTS_MUNICIPAL_COUNCIL_DEFINITION,
    city: normalizeMassachusettsOcpfDistrict(match[2]),
  };
}

export function mapMassachusettsOcpfOffice(input: {
  officeSought: string | null | undefined;
}): MassachusettsOcpfOfficeMapping | null {
  const municipal = splitOcpfMunicipalOfficeLabel(input.officeSought);
  if (municipal) {
    const officeKey = toMassachusettsFinanceOfficeKey(municipal.definition);
    if (!officeKey || !MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(officeKey) || !municipal.city) {
      return null;
    }
    return {
      ...municipal.definition,
      officeKey,
      district: municipal.city,
    };
  }

  const legislative = splitOcpfLegislativeOfficeLabel(input.officeSought);
  if (legislative) {
    const definition: MassachusettsOcpfOfficeDefinition = legislative.ocpfOffice === "Senate"
      ? {
          officeScope: "state_upper",
          officeCanonicalName: "State Senator",
          ocpfOffice: "Senate",
          requiresDistrict: true,
        }
      : {
          officeScope: "state_lower",
          officeCanonicalName: "State Lower Chamber Legislator",
          ocpfOffice: "House",
          requiresDistrict: true,
        };
    const officeKey = toMassachusettsFinanceOfficeKey(definition);
    if (!officeKey || !MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(officeKey) || !legislative.district) {
      return null;
    }
    return {
      ...definition,
      officeKey,
      district: legislative.district,
    };
  }

  const normalizedOffice = normalizeMassachusettsOcpfOfficeLabel(input.officeSought);
  if (!normalizedOffice) {
    return null;
  }
  const definition = MASSACHUSETTS_OCPF_STATEWIDE_OFFICE_DEFINITIONS.get(normalizedOffice);
  if (!definition) {
    return null;
  }
  const officeKey = toMassachusettsFinanceOfficeKey(definition);
  if (!officeKey || !MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(officeKey)) {
    return null;
  }
  return {
    ...definition,
    officeKey,
    district: null,
  };
}

export function toMassachusettsOcpfOfficeSearchInput(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
  district?: string | null | undefined;
}): MassachusettsOcpfOfficeSearchInput | null {
  const officeKey = toMassachusettsFinanceOfficeKey(input);
  if (!officeKey || !MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(officeKey)) {
    return null;
  }
  const definition = MASSACHUSETTS_APP_OFFICE_TO_OCPF.get(officeKey);
  if (!definition) {
    return null;
  }
  const district = definition.requiresDistrict ? normalizeMassachusettsOcpfDistrict(input.district) : null;
  if (definition.requiresDistrict && !district) {
    return null;
  }
  // Municipal search inputs carry the city in the district slot; refuse cities
  // outside the enabled allowlist so nothing links or syncs for them.
  if (definition.officeScope === "place" && (!district || !MASSACHUSETTS_MUNICIPAL_FINANCE_CITY_SET.has(district))) {
    return null;
  }
  return {
    ocpfOffice: definition.ocpfOffice,
    district,
  };
}

/**
 * Election-row eligibility for the ballot-lookup loader: statewide and
 * legislative offices keep the office-key check; place offices additionally
 * require a place district row whose GEOID is in the enabled municipal city
 * allowlist.
 */
export function isMassachusettsFinanceEligibleElectionRow(row: {
  district_type?: string | null;
  geoid_compact?: string | null;
  office_scope?: string | null;
  office_canonical_name?: string | null;
}): boolean {
  const input = { officeScope: row.office_scope, officeCanonicalName: row.office_canonical_name };
  if (!isMassachusettsFinanceEligibleOffice(input)) {
    return false;
  }
  if (row.office_scope?.trim() !== "place") {
    return true;
  }
  return (
    row.district_type?.trim() === "place" && massachusettsMunicipalFinanceCityForGeoid(row.geoid_compact) !== null
  );
}
