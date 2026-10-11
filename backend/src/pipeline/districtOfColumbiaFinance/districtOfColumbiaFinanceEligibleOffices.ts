export type DistrictOfColumbiaFinanceEligibleOfficeKey = `${string}::${string}`;

export type DistrictOfColumbiaFinanceOfficeScope = "place" | "state_upper" | "statewide";

export type DistrictOfColumbiaOcfSeat = "AT-LARGE" | `WARD ${number}` | null;

export type DistrictOfColumbiaOcfOfficeMapping = {
  officeScope: DistrictOfColumbiaFinanceOfficeScope;
  officeCanonicalName: string;
  officeKey: DistrictOfColumbiaFinanceEligibleOfficeKey;
  ocfOffice: string;
  requiresSeat: boolean;
  seat: DistrictOfColumbiaOcfSeat;
};

export type DistrictOfColumbiaOcfOfficeSearchInput = {
  ocfOffice: string;
  seat: DistrictOfColumbiaOcfSeat;
};

export const DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS = [
  "place::Mayor",
  "place::City Council Member",
  // DC's ward Council seats sit on the ward rows, which are typed state_upper
  // (migration 320).
  "state_upper::City Council Member",
  "statewide::Attorney General",
] as const satisfies readonly DistrictOfColumbiaFinanceEligibleOfficeKey[];

const DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEY_SET = new Set<string>(
  DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS
);

type DistrictOfColumbiaOcfOfficeDefinition = {
  officeScope: DistrictOfColumbiaFinanceOfficeScope;
  officeCanonicalName: string;
  ocfOffice: string;
  requiresSeat: boolean;
};

const DISTRICT_OF_COLUMBIA_OCF_OFFICE_DEFINITIONS = new Map<string, DistrictOfColumbiaOcfOfficeDefinition>([
  [
    "MAYOR",
    { officeScope: "place", officeCanonicalName: "Mayor", ocfOffice: "Mayor", requiresSeat: false },
  ],
  [
    "ATTORNEY GENERAL",
    {
      officeScope: "statewide",
      officeCanonicalName: "Attorney General",
      ocfOffice: "Attorney General",
      requiresSeat: false,
    },
  ],
  [
    "CHAIRMAN OF THE COUNCIL",
    {
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      ocfOffice: "Chairman of the Council",
      requiresSeat: false,
    },
  ],
  [
    "CHAIRPERSON OF THE COUNCIL",
    {
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      ocfOffice: "Chairman of the Council",
      requiresSeat: false,
    },
  ],
  [
    "COUNCILMEMBER",
    {
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      ocfOffice: "Councilmember",
      requiresSeat: true,
    },
  ],
  [
    "MEMBER OF THE COUNCIL",
    {
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      ocfOffice: "Councilmember",
      requiresSeat: true,
    },
  ],
]);

const DISTRICT_OF_COLUMBIA_APP_OFFICE_DEFINITIONS: DistrictOfColumbiaOcfOfficeDefinition[] = [
  { officeScope: "place", officeCanonicalName: "Mayor", ocfOffice: "Mayor", requiresSeat: false },
  {
    officeScope: "place",
    officeCanonicalName: "City Council Member",
    ocfOffice: "Councilmember",
    requiresSeat: true,
  },
  {
    officeScope: "state_upper",
    officeCanonicalName: "City Council Member",
    ocfOffice: "Councilmember",
    requiresSeat: true,
  },
  {
    officeScope: "statewide",
    officeCanonicalName: "Attorney General",
    ocfOffice: "Attorney General",
    requiresSeat: false,
  },
];

const DISTRICT_OF_COLUMBIA_APP_OFFICE_TO_OCF = new Map<string, DistrictOfColumbiaOcfOfficeDefinition>(
  DISTRICT_OF_COLUMBIA_APP_OFFICE_DEFINITIONS.map((definition) => [
    `${definition.officeScope}::${definition.officeCanonicalName}`,
    definition,
  ])
);

export function isCouncilChairSeatText(value: string | null | undefined): boolean {
  const normalized = normalizeDistrictOfColumbiaOcfOfficeLabel(value);
  return (
    normalized !== null &&
    /\b(?:CHAIRMAN|CHAIRPERSON|CHAIR)\b/.test(normalized) &&
    /\bCOUNCIL\b/.test(normalized)
  );
}

export function toDistrictOfColumbiaFinanceOfficeKey(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
}): DistrictOfColumbiaFinanceEligibleOfficeKey | null {
  const officeScope = input.officeScope?.trim();
  const officeCanonicalName = input.officeCanonicalName?.trim();
  if (!officeScope || !officeCanonicalName) {
    return null;
  }
  return `${officeScope}::${officeCanonicalName}`;
}

export function isDistrictOfColumbiaFinanceEligibleOffice(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
}): boolean {
  const key = toDistrictOfColumbiaFinanceOfficeKey(input);
  return key !== null && DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(key);
}

export function normalizeDistrictOfColumbiaOcfOfficeLabel(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .replace(/[.]/g, "")
    .replace(/\bD\s*C\b/gi, "DC")
    .replace(/\s+/g, " ")
    .toUpperCase();
  return normalized ? normalized : null;
}

export function normalizeDistrictOfColumbiaOcfSeat(value: string | null | undefined): DistrictOfColumbiaOcfSeat {
  const normalized = value
    ?.trim()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (!normalized) {
    return null;
  }
  if (/\b(?:AT\s*LARGE|AT-LARGE|CITYWIDE)\b/.test(normalized)) {
    return "AT-LARGE";
  }
  const match =
    normalized.match(/^(?:WARD|DIST(?:RICT)?|W)\s*0*([1-8])$/) ??
    normalized.match(/\bWARD\s*0*([1-8])\b/) ??
    normalized.match(/^0*([1-8])$/);
  if (!match?.[1]) {
    return null;
  }
  return `WARD ${Number.parseInt(match[1], 10)}` as DistrictOfColumbiaOcfSeat;
}

function officeKeyForDefinition(
  definition: Pick<DistrictOfColumbiaOcfOfficeDefinition, "officeScope" | "officeCanonicalName">
): DistrictOfColumbiaFinanceEligibleOfficeKey | null {
  const officeKey = toDistrictOfColumbiaFinanceOfficeKey(definition);
  return officeKey && DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(officeKey) ? officeKey : null;
}

export function mapDistrictOfColumbiaOcfOffice(input: {
  office: string | null | undefined;
  seat?: string | null | undefined;
}): DistrictOfColumbiaOcfOfficeMapping | null {
  const normalizedOffice = normalizeDistrictOfColumbiaOcfOfficeLabel(input.office);
  if (!normalizedOffice) {
    return null;
  }
  const definition = DISTRICT_OF_COLUMBIA_OCF_OFFICE_DEFINITIONS.get(normalizedOffice);
  if (!definition) {
    return null;
  }
  const seat = definition.requiresSeat ? normalizeDistrictOfColumbiaOcfSeat(input.seat) : null;
  if (definition.requiresSeat && !seat) {
    return null;
  }
  const officeKey = officeKeyForDefinition(definition);
  if (!officeKey) {
    return null;
  }
  return {
    ...definition,
    officeKey,
    seat,
  };
}

export function toDistrictOfColumbiaOcfOfficeSearchInput(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
  seat?: string | null | undefined;
}): DistrictOfColumbiaOcfOfficeSearchInput | null {
  const officeKey = toDistrictOfColumbiaFinanceOfficeKey(input);
  if (!officeKey || !DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(officeKey)) {
    return null;
  }
  const definition = DISTRICT_OF_COLUMBIA_APP_OFFICE_TO_OCF.get(officeKey);
  if (!definition) {
    return null;
  }
  if (officeKey === "place::City Council Member" && isCouncilChairSeatText(input.seat)) {
    return {
      ocfOffice: "Chairman of the Council",
      seat: null,
    };
  }
  const seat = definition.requiresSeat ? normalizeDistrictOfColumbiaOcfSeat(input.seat) : null;
  if (definition.requiresSeat && !seat) {
    return null;
  }
  return {
    ocfOffice: definition.ocfOffice,
    seat,
  };
}
