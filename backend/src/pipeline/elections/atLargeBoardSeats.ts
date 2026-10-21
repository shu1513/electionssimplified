// Many governing boards number their seats by DISTRICT but still elect every
// seat AT LARGE — the district is only a residency requirement for the
// candidate. North Carolina's association calls this "by district at large";
// Florida's constitution makes it the default for counties, and several Florida
// cities do the same. In those places a "District 6" seat is on every voter's
// ballot, so flagging it as possibly-not-yours (see subDistrictSeat.ts) states
// the opposite of the truth.
//
// Measured against the live corpus 2026-08-08: without this table, 82 of the
// 178 flagged NC+FL county-board rows were wrong — 46% of them — plus every
// Idaho and Indiana commissioner row.
//
// Sources (all authoritative, all verified 2026-08-08):
//   NC — NC Association of County Commissioners, "North Carolina's Boards of
//        County Commissioners: Board Sizes and Election Methods as of January
//        2024". Counties listed as "by district at large", or as a combination
//        of at-large and by-district-at-large seats.
//   FL — Florida Association of Counties, County Districting. Art. VIII s.1(e)
//        Fla. Const. elects commissioners countywide unless the county adopts
//        single-member districts by referendum under s.124.011 Fla. Stat.
//   ID — Idaho Code tit. 31 ch. 7: commissioners must reside in their district
//        but are elected by the whole county.
//   IN — Indiana county commissioners are elected "from separate districts (in
//        which they must reside) but by vote of the county as a whole".
//        (Indiana COUNTY COUNCIL seats are true district seats — not listed.)
//
// This data changes only by referendum, charter amendment or local act, so it
// is a table rather than a lookup. Re-check the association tables when a cycle
// turns over.

const COUNTY_BOARD_OFFICES: ReadonlySet<string> = new Set(["County Commissioner", "County Supervisor"]);

// City councils and commissions have the same residency-district pattern, but
// with a crucial difference: there is NO national or per-state table of
// municipal election methods, so each city here was read off its own charter.
// Unlisted cities are assumed to elect their districts for real, which is right
// for the large majority (Fort Worth, Austin, Phoenix, Seattle) but means a
// newly-seeded at-large city is flagged until someone checks it.
const MUNICIPAL_BOARD_OFFICES: ReadonlySet<string> = new Set(["City Council Member", "Town Council Member"]);

// School boards. Florida elects school board members "by the qualified
// electors of the entire district" (s. 1001.36 Fla. Stat.) unless a county
// adopts single-member districts by referendum (s. 1001.361). Several large
// counties have (Broward, Miami-Dade, Palm Beach, Orange, Duval), so the
// statewide rule under-warns there; it never over-warns, which is the safe
// direction. List the single-member counties as exemptions once each
// county's method has been read off its own referendum record.
const SCHOOL_BOARD_OFFICES: ReadonlySet<string> = new Set(["School Board Member"]);
const AT_LARGE_SCHOOL_BOARD_STATES: ReadonlySet<string> = new Set(["FL"]);

// Whole states where a county commissioner's district is residency-only.
const AT_LARGE_BOARD_STATES: ReadonlySet<string> = new Set(["ID", "IN"]);

// Indiana's county COUNCIL is districted for real, so the state rule above must
// not swallow it. Keyed by the office the council maps onto in the catalog.
const STATE_RULE_EXEMPT_OFFICES: Readonly<Record<string, ReadonlySet<string>>> = {
  IN: new Set(["County Supervisor"]),
};

const NORTH_CAROLINA_AT_LARGE_BOARDS: ReadonlySet<string> = new Set([
  "Anson",
  "Bertie",
  "Brunswick",
  "Camden",
  "Carteret",
  "Chatham",
  "Cherokee",
  "Currituck",
  "Dare",
  "Forsyth",
  "Gaston",
  "Gates",
  "Greene",
  "Henderson",
  "Hertford",
  "Hyde",
  "Jackson",
  "Johnston",
  "Macon",
  "Mecklenburg",
  "Moore",
  "Northampton",
  "Pender",
  "Randolph",
  "Rutherford",
  "Scotland",
  "Stanly",
  "Surry",
  "Warren",
]);

const FLORIDA_AT_LARGE_BOARDS: ReadonlySet<string> = new Set([
  "Alachua",
  "Baker",
  "Bay",
  "Charlotte",
  "Citrus",
  "Clay",
  "DeSoto",
  "Dixie",
  "Flagler",
  "Gilchrist",
  "Glades",
  "Hardee",
  "Hernando",
  "Highlands",
  "Holmes",
  "Indian River",
  "Lafayette",
  "Lake",
  "Lee",
  "Levy",
  "Liberty",
  "Marion",
  "Martin",
  "Monroe",
  "Nassau",
  "Okaloosa",
  "Okeechobee",
  "Osceola",
  "Pasco",
  "Polk",
  "Putnam",
  "Santa Rosa",
  "Seminole",
  "St. Johns",
  "St. Lucie",
  "Sumter",
  "Suwannee",
  "Wakulla",
  "Walton",
  "Washington",
]);

// Cities whose council seats carry a district/ward/precinct label but go on
// every city voter's ballot. Each verified against the city's own charter or
// clerk, because no table covers municipalities.
const MUNICIPAL_AT_LARGE_BOARDS: Readonly<Record<string, ReadonlySet<string>>> = {
  FL: new Set([
    // Charter: council members "qualify in their respective districts but are
    // elected at large" — every voter votes for all seven.
    "Cape Coral",
    // 2020 charter: "Voters citywide are entitled to vote for candidates
    // running for the two at-large seats and all three precinct seats."
    "Crestview",
  ]),
};

// Boards that split themselves: some numbered districts are true single-member
// seats and the rest are elected at large. Only the at-large numbers belong
// here. Both verified against the counties' own published descriptions.
const SPLIT_BOARD_DISTRICTS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  FL: {
    // Districts 1-4 are single-member; 5, 6 and 7 are "Countywide Districts".
    Hillsborough: new Set(["5", "6", "7"]),
    // Inverted from Hillsborough, and easy to get backwards: Pinellas elects
    // districts 4-7 as single-member and 1-3 countywide.
    Pinellas: new Set(["1", "2", "3"]),
  },
};

// Boards whose electorate depends on the STAGE. Orange County NC is the only
// one in the corpus: NCACC records its 5 districted seats as "primary elections
// are conducted purely by district and general elections are conducted by
// district at large", so the same seat has a district electorate in March and a
// countywide one in November. An unknown stage is treated as at large — the
// conservative direction, since a wrong warning is worse than a missing one.
const STAGE_DEPENDENT_AT_LARGE: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  NC: {
    Orange: new Set(["general", "runoff"]),
  },
};

/**
 * The bare jurisdiction name from a district row's name. Census-style suffixes
 * differ in case by design — county types are capitalized ("Anson County") and
 * place types are not ("Cape Coral city") — so the place strip is
 * case-sensitive, or "Kansas City city" would reduce to "Kansas".
 */
export function toJurisdictionKey(districtName: string | null | undefined): string | null {
  if (typeof districtName !== "string") {
    return null;
  }
  const head = districtName.split(",")[0]?.trim() ?? "";
  const bare = head
    .replace(/\s+(County|Parish|Census Area|City and Borough|Municipality|Borough)$/, "")
    .replace(/\s+(city|town|village|borough|CDP)$/, "")
    .trim();
  return bare.length > 0 ? bare : null;
}

/**
 * True when this seat goes on the WHOLE jurisdiction's ballot despite carrying
 * a district number — i.e. when the sub-district flag would be a false alarm.
 *
 * `seatNumber` is the digits from the extracted label ("District 06" -> "06"),
 * used only by the split boards; a lettered or named seat simply misses those
 * sets, which is the safe direction for a board that is otherwise districted
 * for real. `electionStage` matters only where a board's electorate changes
 * between the primary and the general.
 */
export function isAtLargeBoardSeat(input: {
  officeCanonicalName: string | null | undefined;
  state: string | null | undefined;
  districtName: string | null | undefined;
  seatNumber?: string | null;
  electionStage?: string | null;
}): boolean {
  const { officeCanonicalName, state } = input;
  if (typeof officeCanonicalName !== "string") {
    return false;
  }
  const isCountyBoard = COUNTY_BOARD_OFFICES.has(officeCanonicalName);
  const isMunicipalBoard = MUNICIPAL_BOARD_OFFICES.has(officeCanonicalName);
  const isSchoolBoard = SCHOOL_BOARD_OFFICES.has(officeCanonicalName);
  if (!isCountyBoard && !isMunicipalBoard && !isSchoolBoard) {
    return false;
  }
  if (typeof state !== "string" || state.length === 0) {
    return false;
  }
  const stateKey = state.toUpperCase();

  if (isSchoolBoard) {
    return AT_LARGE_SCHOOL_BOARD_STATES.has(stateKey);
  }

  if (
    isCountyBoard &&
    AT_LARGE_BOARD_STATES.has(stateKey) &&
    !STATE_RULE_EXEMPT_OFFICES[stateKey]?.has(officeCanonicalName)
  ) {
    return true;
  }

  const jurisdiction = toJurisdictionKey(input.districtName);
  if (jurisdiction === null) {
    return false;
  }

  if (isMunicipalBoard) {
    return MUNICIPAL_AT_LARGE_BOARDS[stateKey]?.has(jurisdiction) ?? false;
  }

  const stageRule = STAGE_DEPENDENT_AT_LARGE[stateKey]?.[jurisdiction];
  if (stageRule) {
    const stage = typeof input.electionStage === "string" ? input.electionStage.trim().toLowerCase() : "";
    return stage.length === 0 || stageRule.has(stage);
  }

  const split = SPLIT_BOARD_DISTRICTS[stateKey]?.[jurisdiction];
  if (split) {
    // Leading zeros are cosmetic on these ballots ("District 06"), so compare
    // on the parsed integer rather than the raw digits.
    const normalized = input.seatNumber ? String(Number(input.seatNumber)) : null;
    return normalized !== null && split.has(normalized);
  }

  if (stateKey === "NC") {
    return NORTH_CAROLINA_AT_LARGE_BOARDS.has(jurisdiction);
  }
  if (stateKey === "FL") {
    return FLORIDA_AT_LARGE_BOARDS.has(jurisdiction);
  }
  return false;
}
