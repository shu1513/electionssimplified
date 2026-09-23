import { describe, expect, it, vi } from "vitest";

import { OfficeMatcher } from "../../src/pipeline/elections/officeMatcher.js";
import { normalizeElectionTitleKey } from "../../src/utils/normalizeElectionTitleKey.js";

type QueryResultRow = Record<string, unknown>;

function createMatcherDataClient(input: {
  aliasesByScope: Record<string, Array<{ office_id: string; normalized_alias: string }>>;
  officesByScope: Record<string, Array<{ id: string; canonical_name: string }>>;
}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const scope = String(params?.[0] ?? "");
    if (sql.includes("FROM public.office_title_aliases")) {
      return { rows: (input.aliasesByScope[scope] ?? []) as QueryResultRow[] };
    }
    if (sql.includes("FROM public.offices")) {
      return { rows: (input.officesByScope[scope] ?? []) as QueryResultRow[] };
    }
    throw new Error(`unexpected query in officeMatcher test: ${sql.slice(0, 120)}`);
  });
  return { query };
}

describe("OfficeMatcher", () => {
  it("maps Washington's exact bare county Clerk title to Clerk of Court without learning a global alias", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Spokane County, Washington",
      state: "WA",
      officialBallotTitle: "Clerk",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result).toMatchObject({
      officeId: "office-clerk-of-court",
      method: "deterministic_fallback",
      confidence: 1,
      aliasMemoryKey: "clerk",
      shouldPersistAlias: false,
    });
  });

  it("maps an Arkansas justice of the peace to County Commissioner over a learned JP alias", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [{ office_id: "office-jp", normalized_alias: "justice of the peace" }],
      },
      officesByScope: {
        county: [
          { id: "office-jp", canonical_name: "Justice of the Peace" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    for (const discoveryContestFamily of ["judicial_office", "non_judicial_office"] as const) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Columbia County, Arkansas",
        state: "AR",
        officialBallotTitle: "Justice of the Peace District 3",
        discoveryContestFamily,
      });

      expect(result).toMatchObject({
        officeId: "office-county-commissioner",
        method: "deterministic_fallback",
        shouldPersistAlias: false,
      });
    }
  });

  it("keeps a Texas justice of the peace on the judicial JP office", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-jp", canonical_name: "Justice of the Peace" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Morris County, Texas",
      state: "TX",
      officialBallotTitle: "Justice of the Peace, Precinct 1",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-jp");
  });

  it("maps a Kentucky magistrate to the Magistrate office but leaves a Kentucky justice of the peace alone", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [{ office_id: "office-jp", normalized_alias: "justice of the peace" }],
      },
      officesByScope: {
        county: [
          { id: "office-jp", canonical_name: "Justice of the Peace" },
          { id: "office-county-judge", canonical_name: "County Level Judge" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-magistrate", canonical_name: "Magistrate" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);
    const resolve = (districtName: string, officialBallotTitle: string) =>
      matcher.resolve({
        scope: "county",
        districtName,
        state: "KY",
        officialBallotTitle,
        discoveryContestFamily: "non_judicial_office",
      });

    expect(await resolve("Fayette County, Kentucky", "Magistrate 1st Magisterial District")).toMatchObject({
      officeId: "office-magistrate",
      method: "deterministic_fallback",
      shouldPersistAlias: false,
    });
    // Daviess elects commissioners; its justices of the peace hold no seat on
    // the fiscal court, so the title takes no county-legislator redirect.
    const jp = await resolve("Daviess County, Kentucky", "Daviess County Justice of the Peace, East District");
    expect(jp.officeId).not.toBe("office-county-commissioner");
    expect(jp.officeId).not.toBe("office-magistrate");
  });

  it("keeps a bare county Clerk title ambiguous outside Washington", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Example County, Oregon",
      state: "OR",
      officialBallotTitle: "Clerk",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("ambiguous");
    expect(result.shouldPersistAlias).toBe(false);
  });

  const COURT_CLERK_TITLE_CASES = [
    // Nebraska: every county words the seat this way.
    { title: "Sarpy County Clerk of the District Court", districtName: "Sarpy County, Nebraska", state: "NE" },
    // Wisconsin: both official wordings, in counties that elect the clerk.
    {
      title: "Milwaukee County Clerk of Circuit Court",
      districtName: "Milwaukee County, Wisconsin",
      state: "WI",
    },
    { title: "Waukesha County Clerk of Courts", districtName: "Waukesha County, Wisconsin", state: "WI" },
    {
      title: "Mecklenburg County Clerk of Superior Court",
      districtName: "Mecklenburg County, North Carolina",
      state: "NC",
    },
    {
      title: "Marion County Clerk of the Circuit Court",
      districtName: "Marion County, Indiana",
      state: "IN",
    },
  ];

  for (const testCase of COURT_CLERK_TITLE_CASES) {
    it(`routes "${testCase.title}" to Clerk of Court, not the county's own clerk`, async () => {
      const client = createMatcherDataClient({
        aliasesByScope: { county: [] },
        officesByScope: {
          county: [
            { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
            { id: "office-county-clerk", canonical_name: "County Clerk" },
          ],
        },
      });
      const matcher = new OfficeMatcher(client as never);

      const result = await matcher.resolve({
        scope: "county",
        districtName: testCase.districtName,
        state: testCase.state,
        officialBallotTitle: testCase.title,
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBe("office-clerk-of-court");
      expect(result.method).toBe("deterministic_fallback");
      expect(result.shouldPersistAlias).toBe(false);
    });
  }

  it("ignores a learned non-judge alias for a judicial-family title", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          // Learned from Kentucky fiscal-court magistrates (county legislators).
          { office_id: "office-magistrate", normalized_alias: "magistrate" },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-magistrate", canonical_name: "Magistrate" },
          { id: "office-county-judge", canonical_name: "County Level Judge" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Georgia's magistrate is a judge; the alias must not pull it into the
    // Kentucky legislative office.
    const georgia = await matcher.resolve({
      scope: "county",
      districtName: "Putnam County, Georgia",
      state: "GA",
      officialBallotTitle: "Magistrate",
      discoveryContestFamily: "judicial_office",
    });
    expect(georgia.officeId).toBe("office-county-judge");

    // The alias still serves the non-judicial family it was learned from.
    const kentucky = await matcher.resolve({
      scope: "county",
      districtName: "Marion County, Kentucky",
      state: "KY",
      officialBallotTitle: "Magistrate",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(kentucky.officeId).toBe("office-magistrate");
  });

  it("ignores an already-learned county-clerk alias for a court-clerk title", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          // The mis-scored alias this defect persisted across live runs.
          { office_id: "office-county-clerk", normalized_alias: "county clerk of the district court" },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Douglas County, Nebraska",
      state: "NE",
      officialBallotTitle: "Douglas County Clerk of the District Court",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-clerk-of-court");
    expect(result.method).toBe("deterministic_fallback");
  });

  // Texas elects a District Clerk (the district courts' record keeper)
  // separately from the County Clerk. The two seeded aliases from migration
  // 285 carry both title forms. A small county's combined office stays on
  // County Clerk through the raw-title rule: "&" and "/" vanish in the
  // normalized key, so those titles would otherwise hit the "county district
  // clerk" alias.
  const TEXAS_DISTRICT_CLERK_CASES = [
    { title: "District Clerk", district: "Anderson County, Texas", expected: "office-clerk-of-court", method: "alias_exact" },
    { title: "DISTRICT CLERK", district: "Hamilton County, Texas", expected: "office-clerk-of-court", method: "alias_exact" },
    { title: "Anderson County District Clerk", district: "Anderson County, Texas", expected: "office-clerk-of-court", method: "alias_exact" },
    { title: "Anderson County Clerk", district: "Anderson County, Texas", expected: "office-county-clerk", method: "alias_exact" },
    { title: "County & District Clerk", district: "Dickens County, Texas", expected: "office-county-clerk", method: "deterministic_fallback" },
    { title: "Hemphill County & District Clerk", district: "Hemphill County, Texas", expected: "office-county-clerk", method: "deterministic_fallback" },
    { title: "La Salle County/District Clerk", district: "La Salle County, Texas", expected: "office-county-clerk", method: "deterministic_fallback" },
    { title: "District/County Clerk", district: "Brooks County, Texas", expected: "office-county-clerk", method: "deterministic_fallback" },
    { title: "Dallam County and District Clerk", district: "Dallam County, Texas", expected: "office-county-clerk", method: "deterministic_fallback" },
  ];

  it.each(TEXAS_DISTRICT_CLERK_CASES)(
    "resolves the Texas clerk title $title to the right clerk office",
    async ({ title, district, expected, method }) => {
      const client = createMatcherDataClient({
        aliasesByScope: {
          county: [
            { office_id: "office-clerk-of-court", normalized_alias: "district clerk" },
            { office_id: "office-clerk-of-court", normalized_alias: "county district clerk" },
            { office_id: "office-county-clerk", normalized_alias: "county and district clerk" },
            { office_id: "office-county-clerk", normalized_alias: "county clerk" },
          ],
        },
        officesByScope: {
          county: [
            { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
            { id: "office-county-clerk", canonical_name: "County Clerk" },
          ],
        },
      });
      const matcher = new OfficeMatcher(client as never);

      const result = await matcher.resolve({
        scope: "county",
        districtName: district,
        state: "TX",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBe(expected);
      expect(result.method).toBe(method);
    }
  );

  it("leaves Nebraska's Clerk Register of Deeds with the County Clerk", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Sarpy County, Nebraska",
      state: "NE",
      officialBallotTitle: "Sarpy County Clerk Register of Deeds",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-clerk");
  });

  it("declines a court-clerk title when no Clerk of Court office is in scope", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [{ id: "office-county-clerk", canonical_name: "County Clerk" }],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Sarpy County, Nebraska",
      state: "NE",
      officialBallotTitle: "Sarpy County Clerk of the District Court",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBeNull();
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("resolves County Register through the seeded County Recorder alias", async () => {
    expect(normalizeElectionTitleKey("County Register")).toBe("county register");
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          {
            office_id: "office-county-recorder",
            normalized_alias: normalizeElectionTitleKey("County Register"),
          },
        ],
      },
      officesByScope: {
        county: [{ id: "office-county-recorder", canonical_name: "County Recorder" }],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "county",
      districtName: "Hudson County, New Jersey",
      state: "NJ",
      officialBallotTitle: "Hudson County Register",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-recorder");
    expect(result.method).toBe("alias_exact");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("resolves 'Council Member for District N' through the seeded place alias (Fort Worth)", async () => {
    // The official title omits "City"; before the 'for district N' seat strip
    // the matcher key kept a dangling "for" ("council member for"), missed
    // the seeded alias, and tied City vs Town Council Member into an
    // ambiguous NULL office for all ten council contests (live).
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [{ office_id: "office-city-council-member", normalized_alias: "council member" }],
      },
      officesByScope: {
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-town-council-member", canonical_name: "Town Council Member" },
          { id: "office-mayor", canonical_name: "Mayor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Fort Worth city, Texas",
      state: "TX",
      officialBallotTitle: "Council Member for District 2",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-city-council-member");
    expect(result.method).toBe("alias_exact");
  });

  it("resolves one-word 'Councilmember' titles through the two-word place alias (Flagstaff)", async () => {
    // "City of Flagstaff Councilmember" previously produced the single token
    // "councilmember" — zero overlap with the catalog, method=none,
    // office_id NULL (live).
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [{ office_id: "office-city-council-member", normalized_alias: "council member" }],
      },
      officesByScope: {
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-town-council-member", canonical_name: "Town Council Member" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Flagstaff city, Arizona",
      state: "AZ",
      officialBallotTitle: "City of Flagstaff Councilmember",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-city-council-member");
    expect(result.method).toBe("alias_exact");
  });

  it("strips a Texas 'Place N' seat so 'Councilmember, Place 1' hits the place alias (Amarillo)", async () => {
    // "City of Amarillo Councilmember, Place 1" through "Place 4" all wrote
    // NULL-office shells (live): the surviving "place 1" tokens left the
    // title tied between City and Town Council Member at ambiguous 0.571.
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [{ office_id: "office-city-council-member", normalized_alias: "council member" }],
      },
      officesByScope: {
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-town-council-member", canonical_name: "Town Council Member" },
          { id: "office-place-level-judge", canonical_name: "Place Level Judge" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Amarillo city, Texas",
      state: "TX",
      officialBallotTitle: "City of Amarillo Councilmember, Place 1",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-city-council-member");
    expect(result.method).toBe("alias_exact");
    expect(result.aliasMemoryKey).toBe("council member");
  });

  it("folds 'Councilor-at-Large (To Fill Vacancy)' to the place council alias (Syracuse)", async () => {
    // Onondaga County's certified list titles the seat "COUNCILOR - AT -
    // LARGE (TO FILL VACANCY)". The one-word "councilor" shared no token with
    // the catalog and "to fill" survived the vacancy strip, so the contest
    // wrote a NULL-office shell (live).
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [{ office_id: "office-city-council-member", normalized_alias: "council member" }],
      },
      officesByScope: {
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-town-council-member", canonical_name: "Town Council Member" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Syracuse city, New York",
      state: "NY",
      officialBallotTitle: "City of Syracuse Councilor-at-Large (To Fill Vacancy)",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-city-council-member");
    expect(result.method).toBe("alias_exact");
    expect(result.aliasMemoryKey).toBe("council member");
  });

  it("routes a DC ward's State Board of Education seat to the state_upper board office, not the chamber seat", async () => {
    // DC ward rows are typed state_upper for the Council seat; the same ward
    // ballot elects the ward's member of the DC State Board of Education.
    const client = createMatcherDataClient({
      aliasesByScope: { state_upper: [] },
      officesByScope: {
        state_upper: [
          { id: "office-state-senator", canonical_name: "State Senator" },
          { id: "office-dc-state-board", canonical_name: "State Board of Education Member" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "state_upper",
      districtName: "Ward 5 (2024); District of Columbia",
      state: "DC",
      officialBallotTitle: "Ward 5 Member of the State Board of Education",
    });

    expect(result).toMatchObject({
      officeId: "office-dc-state-board",
      method: "deterministic_fallback",
      confidence: 1,
      shouldPersistAlias: false,
    });

    // The ward's Council seat still takes the chamber office.
    const council = await matcher.resolve({
      scope: "state_upper",
      districtName: "Ward 5 (2024); District of Columbia",
      state: "DC",
      officialBallotTitle: "Ward 5 Member of the Council",
    });
    expect(council.officeId).toBe("office-state-senator");

    // Any other state's row keeps the chamber route: no state elects a state
    // board seat from a senate district.
    const other = await matcher.resolve({
      scope: "state_upper",
      districtName: "State Senate District 5, Texas",
      state: "TX",
      officialBallotTitle: "District 5 Member of the State Board of Education",
    });
    expect(other.officeId).toBe("office-state-senator");
  });

  it("resolves 'Council District No. N' seat titles through the place alias (Seattle)", async () => {
    // "City of Seattle Council District No. 5" wrote a NULL-office shell
    // (live): the interposed "No." survived the seat strip, and even a plain
    // strip would leave the bare token "council", which under-tokenizes
    // against City Council Member.
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [{ office_id: "office-city-council-member", normalized_alias: "council member" }],
      },
      officesByScope: {
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-mayor", canonical_name: "Mayor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Seattle city, Washington",
      state: "WA",
      officialBallotTitle: "City of Seattle Council District No. 5",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-city-council-member");
    expect(result.method).toBe("alias_exact");
  });

  it("resolves Honolulu's 'Councilmember Dist II' Roman-numeral seat form", async () => {
    // Honolulu's official titles abbreviate the seat as "Dist II"; the Roman
    // numeral survived the numeric-only seat strip and left the key
    // "council member dist ii", missing the alias table (live, 4 shells).
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [{ office_id: "office-city-council-member", normalized_alias: "council member" }],
      },
      officesByScope: {
        place: [{ id: "office-city-council-member", canonical_name: "City Council Member" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Honolulu county, Hawaii",
      state: "HI",
      officialBallotTitle: "Councilmember Dist II",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-city-council-member");
    expect(result.method).toBe("alias_exact");
  });

  it("matches 'MEMBER, BOARD OF SUPERVISORS DISTRICT NO. N' to County Supervisor (San Diego)", async () => {
    // The California body-form title tokenizes into zero overlap with the
    // catalog ("supervisors" never equals "supervisor") and wrote a
    // NULL-office shell (live).
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-supervisor", canonical_name: "County Supervisor" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "San Diego County, California",
      state: "CA",
      officialBallotTitle: "MEMBER, BOARD OF SUPERVISORS DISTRICT NO. 5",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-supervisor");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("matches 'TREASURER/TAX COLLECTOR' to County Treasurer (San Diego)", async () => {
    // The combined-office form scored 1-of-3 token overlap against County
    // Treasurer, below the confidence floor, and wrote a NULL-office shell
    // (live).
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-supervisor", canonical_name: "County Supervisor" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "San Diego County, California",
      state: "CA",
      officialBallotTitle: "TREASURER/TAX COLLECTOR",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-treasurer");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("resolves 'Snohomish County Prosecuting Attorney' through the bare 'prosecuting attorney' alias", async () => {
    // The jurisdiction strip keeps the generic civic word ("county
    // prosecuting attorney"), but Washington's seeded county alias is the
    // bare office ("prosecuting attorney" → District Attorney). Pierce and
    // Snohomish both wrote NULL-office shells at confidence 0.400 (live).
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [{ office_id: "office-district-attorney", normalized_alias: "prosecuting attorney" }],
      },
      officesByScope: {
        county: [
          { id: "office-district-attorney", canonical_name: "District Attorney" },
          { id: "office-county-supervisor", canonical_name: "County Supervisor" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Snohomish County, Washington",
      state: "WA",
      officialBallotTitle: "Snohomish County Prosecuting Attorney",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-district-attorney");
    expect(result.method).toBe("alias_exact");
  });

  it("matches the plural 'Middlesex County Commissioners' to County Commissioner", async () => {
    // The official NJ plural body form tokenized "commissioners" ≠
    // "commissioner" and wrote a NULL-office shell (live).
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Middlesex County, New Jersey",
      state: "NJ",
      officialBallotTitle: "Middlesex County Commissioners",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-commissioner");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("matches 'Utah County Commission Seat A' to County Commissioner", async () => {
    // The governing-body form plus lettered seat left "county commission a"
    // after the seat strip — near-zero overlap, four NULL-office shells
    // (live).
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Utah County, Utah",
      state: "UT",
      officialBallotTitle: "Utah County Commission Seat A",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-commissioner");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("keeps the Cook County board president out of the County Commissioner member office", async () => {
    // Regression guard for the plural rewrite: "President of the Cook County
    // Board of Commissioners" is the county executive; singularizing its
    // "commissioners" would over-match the member office.
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-executive", canonical_name: "County Executive" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Cook County, Illinois",
      state: "IL",
      officialBallotTitle: "President of the Cook County Board of Commissioners",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).not.toBe("office-county-commissioner");
  });

  it.each([
    ["President, Middlesex County Commissioners"],
    ["Chair, Middlesex County Commissioners"],
    ["Chair, Cook County Board of Commissioners"],
  ])("keeps board leadership title %s out of the County Commissioner member office", async (officialBallotTitle) => {
    // Comma-form leadership titles lose their connectors in normalization, so
    // the fixed "president of the" lookbehind never saw them; singularizing
    // the body plural scored them ~0.92 into the member office. The
    // leadership-word guard must leave the plural intact so they fall to
    // no-match instead.
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-executive", canonical_name: "County Executive" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Middlesex County, New Jersey",
      state: "NJ",
      officialBallotTitle,
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).not.toBe("office-county-commissioner");
  });

  it("keeps the Texas 'Commissioners Court' body plural so its key stays faithful", async () => {
    // "Commissioners Court Precinct 2" has no "of" before "commissioners";
    // singularizing it would persist an unfaithful "commissioner court" alias
    // key. The court lookahead leaves the official plural in place, and the
    // truncated body form must not confidently misroute anywhere.
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-judge", canonical_name: "County Level Judge" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Harris County, Texas",
      state: "TX",
      officialBallotTitle: "Commissioners Court Precinct 2",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBeNull();
    expect(result.aliasMemoryKey).toBe("commissioners court");
  });

  it("does not score a non-judicial county contest into a judge office (TX County Judge)", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-judge-judicial", canonical_name: "County Level Judge" },
          { id: "office-county-executive", canonical_name: "County Executive" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Bexar County, Texas",
      state: "TX",
      officialBallotTitle: "County Judge",
      discoveryContestFamily: "non_judicial_office",
    });

    // "county judge" does not clear the scoring threshold against County
    // Executive; the seeded alias (migration 145) resolves real traffic. The
    // essential assertion is that the judge office is no longer reachable.
    expect(result.officeId).not.toBe("office-county-judge-judicial");
    expect(result.officeId).toBeNull();
  });

  it("ignores a learned judge-office alias when the entry family is non-judicial", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          { office_id: "office-county-judge-judicial", normalized_alias: normalizeElectionTitleKey("County Judge") },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-county-judge-judicial", canonical_name: "County Level Judge" },
          { id: "office-county-executive", canonical_name: "County Executive" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Bexar County, Texas",
      state: "TX",
      officialBallotTitle: "County Judge",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).not.toBe("office-county-judge-judicial");
  });

  it("resolves official state schools-chief title variants via the seeded aliases", async () => {
    // Guards the normalizer-parity invariant for migration 164's aliases: the
    // seed layer stores normalizeElectionTitleKey(alias) while the matcher
    // looks titles up under its own normalization — if the two ever diverge
    // for these official ballot titles (GA/SC/WI-CA forms), the alias silently
    // stops matching and the shell strands with office_id = NULL again.
    const superintendentOfficeId = "office-superintendent-of-public-instruction";
    const aliasTitles = [
      "State School Superintendent",
      "State Superintendent of Public Instruction",
      "State Superintendent of Education",
    ];
    const client = createMatcherDataClient({
      aliasesByScope: {
        statewide: aliasTitles.map((title) => ({
          office_id: superintendentOfficeId,
          normalized_alias: normalizeElectionTitleKey(title),
        })),
      },
      officesByScope: {
        statewide: [
          { id: superintendentOfficeId, canonical_name: "Superintendent of Public Instruction" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    for (const title of aliasTitles) {
      const result = await matcher.resolve({
        scope: "statewide",
        districtName: "Georgia",
        state: "GA",
        officialBallotTitle: title,
      });
      expect(result.officeId).toBe(superintendentOfficeId);
      expect(result.method).toBe("alias_exact");
    }
  });

  it("resolves the SF county Assessor-Recorder and Public Defender titles via the seeded aliases", async () => {
    // Guards the normalizer-parity invariant for migration 165's aliases: the
    // seed layer stores normalizeElectionTitleKey(alias) while the matcher
    // looks titles up under its own normalization — if the two ever diverge
    // for these official ballot titles (SF's hyphenated combined office and
    // the elected Public Defender), the alias silently stops matching and the
    // shell strands with office_id = NULL again.
    const assessorRecorderOfficeId = "office-county-assessor-recorder";
    const publicDefenderOfficeId = "office-public-defender";

    // Pin migration 165's hand-written normalized_alias literals to the
    // current normalizer output. Without these, both sides of the test below
    // run through normalizeElectionTitleKey, so the test would keep passing
    // even after a normalizer change left the migration's stored DB rows
    // stale.
    expect(normalizeElectionTitleKey("Assessor-Recorder")).toBe("assessor recorder");
    expect(normalizeElectionTitleKey("County Assessor-Recorder")).toBe("county assessor recorder");
    expect(normalizeElectionTitleKey("Public Defender")).toBe("public defender");

    const aliasCases: Array<{ title: string; officeId: string }> = [
      { title: "Assessor-Recorder", officeId: assessorRecorderOfficeId },
      { title: "County Assessor-Recorder", officeId: assessorRecorderOfficeId },
      { title: "Public Defender", officeId: publicDefenderOfficeId },
    ];
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: aliasCases.map(({ title, officeId }) => ({
          office_id: officeId,
          normalized_alias: normalizeElectionTitleKey(title),
        })),
      },
      officesByScope: {
        county: [
          { id: assessorRecorderOfficeId, canonical_name: "County Assessor-Recorder" },
          { id: publicDefenderOfficeId, canonical_name: "Public Defender" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    for (const { title, officeId } of aliasCases) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: "San Francisco County, California",
        state: "CA",
        officialBallotTitle: title,
      });
      expect(result.officeId).toBe(officeId);
      expect(result.method).toBe("alias_exact");
    }
  });

  it("resolves Weld County's source-exact Clerk and Recorder title via the combined office alias", async () => {
    const officeId = "office-county-clerk-and-recorder";
    expect(normalizeElectionTitleKey("Clerk and Recorder")).toBe("clerk and recorder");

    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [{ office_id: officeId, normalized_alias: "clerk and recorder" }],
      },
      officesByScope: {
        county: [{ id: officeId, canonical_name: "County Clerk and Recorder" }],
      },
    });

    const result = await new OfficeMatcher(client as never).resolve({
      scope: "county",
      districtName: "Weld County, Colorado",
      state: "CO",
      officialBallotTitle: "Clerk and Recorder",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe(officeId);
    expect(result.method).toBe("alias_exact");
  });

  it("resolves the migration 169 alias gaps: City Representative, County Mayor, NY judicial districts", async () => {
    // Guards the normalizer-parity invariant for migration 169's aliases,
    // same as the 164/165 tests above: pin the migration's hand-written
    // normalized_alias literals to the current normalizer output, then prove
    // each official title resolves through the matcher.
    expect(normalizeElectionTitleKey("City Representative")).toBe("city representative");
    expect(normalizeElectionTitleKey("County Mayor")).toBe("county mayor");
    expect(normalizeElectionTitleKey("Supreme Court Justice - 1st Judicial District")).toBe(
      "supreme court justice 1st judicial district"
    );

    const cityCouncilOfficeId = "office-city-council-member";
    const countyExecutiveOfficeId = "office-county-executive";
    const countyJudgeOfficeId = "office-county-judge-judicial";

    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [
          { office_id: cityCouncilOfficeId, normalized_alias: normalizeElectionTitleKey("City Representative") },
        ],
        county: [
          { office_id: countyExecutiveOfficeId, normalized_alias: normalizeElectionTitleKey("County Mayor") },
          {
            office_id: countyJudgeOfficeId,
            normalized_alias: normalizeElectionTitleKey("Supreme Court Justice - 1st Judicial District"),
          },
        ],
      },
      officesByScope: {
        place: [{ id: cityCouncilOfficeId, canonical_name: "City Council Member" }],
        county: [
          { id: countyExecutiveOfficeId, canonical_name: "County Executive" },
          { id: countyJudgeOfficeId, canonical_name: "County Level Judge" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);

    // El Paso's full seat title reduces to the generic "city representative"
    // key via jurisdiction + seat stripping, so one alias covers every seat.
    const elPaso = await matcher.resolve({
      scope: "place",
      districtName: "El Paso city, Texas",
      state: "TX",
      officialBallotTitle: "City Representative District 1, City of El Paso",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(elPaso.officeId).toBe(cityCouncilOfficeId);
    expect(elPaso.method).toBe("alias_exact");

    const countyMayor = await matcher.resolve({
      scope: "county",
      districtName: "Orange County, Florida",
      state: "FL",
      officialBallotTitle: "County Mayor",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(countyMayor.officeId).toBe(countyExecutiveOfficeId);
    expect(countyMayor.method).toBe("alias_exact");

    const nyJustice = await matcher.resolve({
      scope: "county",
      districtName: "New York County, New York",
      state: "NY",
      officialBallotTitle: "Supreme Court Justice - 1st Judicial District",
      discoveryContestFamily: "judicial_office",
    });
    expect(nyJustice.officeId).toBe(countyJudgeOfficeId);
    expect(nyJustice.method).toBe("alias_exact");
  });

  it("still honors a judge-office alias when the entry family is judicial", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          { office_id: "office-county-judge-judicial", normalized_alias: normalizeElectionTitleKey("Judge of the County Court") },
        ],
      },
      officesByScope: {
        county: [{ id: "office-county-judge-judicial", canonical_name: "County Level Judge" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Erie County, New York",
      state: "NY",
      officialBallotTitle: "Judge of the County Court",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-county-judge-judicial");
    expect(result.method).toBe("alias_exact");
  });


  it("scores a joint governor ticket into the Governor office, not Lieutenant Governor", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-lt-governor", canonical_name: "Lieutenant Governor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "Ohio",
      state: "OH",
      officialBallotTitle: "Governor and Lieutenant Governor",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("scores a slash-form joint governor ticket into the Governor office", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-lt-governor", canonical_name: "Lieutenant Governor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "Alabama",
      state: "AL",
      officialBallotTitle: "Governor / Lieutenant Governor",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("still scores a standalone Lieutenant Governor title into the Lieutenant Governor office", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-lt-governor", canonical_name: "Lieutenant Governor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "Alabama",
      state: "AL",
      officialBallotTitle: "Lieutenant Governor",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-lt-governor");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("keeps a learned alias authoritative for joint governor tickets", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        statewide: [
          {
            office_id: "office-governor",
            normalized_alias: normalizeElectionTitleKey("Governor and Lieutenant Governor"),
          },
        ],
      },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-lt-governor", canonical_name: "Lieutenant Governor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "Ohio",
      state: "OH",
      officialBallotTitle: "Governor and Lieutenant Governor",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("alias_exact");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("returns exact alias match when normalized alias exists", async () => {
    const title = "California State Governor";
    const client = createMatcherDataClient({
      aliasesByScope: {
        statewide: [
          { office_id: "office-governor", normalized_alias: normalizeElectionTitleKey(title) },
        ],
      },
      officesByScope: {
        statewide: [{ id: "office-governor", canonical_name: "Governor" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: title,
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("alias_exact");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("uses deterministic fallback for lieutenant governor vs governor", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-lt-governor", canonical_name: "Lieutenant Governor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "California State Lieutenant Governor",
    });

    expect(result.officeId).toBe("office-lt-governor");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("respects scope and avoids cross-scope office matching", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          {
            office_id: "office-county-supervisor",
            normalized_alias: normalizeElectionTitleKey("Los Angeles County Board of Supervisors, District 1"),
          },
        ],
        statewide: [],
      },
      officesByScope: {
        county: [{ id: "office-county-supervisor", canonical_name: "County Supervisor" }],
        statewide: [{ id: "office-governor", canonical_name: "Governor" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);

    const statewideResult = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "Board of Supervisors, District 1",
    });
    expect(statewideResult.officeId).toBeNull();
    expect(statewideResult.method).toBe("none");

    const countyResult = await matcher.resolve({
      scope: "county",
      districtName: "Los Angeles County",
      state: "CA",
      officialBallotTitle: "Los Angeles County Board of Supervisors, District 1",
    });
    expect(countyResult.officeId).toBe("office-county-supervisor");
    expect(countyResult.method).toBe("alias_exact");
  });

  it("does not match township supervisor to county supervisor", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [{ id: "office-county-supervisor", canonical_name: "County Supervisor" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Example County",
      state: "OH",
      officialBallotTitle: "Township Supervisor",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
  });

  it("does not match South Carolina's bare circuit Solicitor to Solicitor General", async () => {
    // SC's Solicitor is the chief FELONY prosecutor (a District Attorney by
    // another name), not Georgia's misdemeanor State Court solicitor-general.
    // "general" is a stopword, so the office tokenizes to ["solicitor"] and
    // this title is token-identical to it: without the phrase guard it matches
    // at a perfect 1.0, unopposed.
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-solicitor-general", canonical_name: "Solicitor General" },
          { id: "office-district-attorney", canonical_name: "District Attorney" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Richland County",
      state: "SC",
      // Bare, because the circuit is the district: the jurisdiction strip
      // takes "5th Judicial Circuit" off "Solicitor, 5th Judicial Circuit"
      // and leaves the one word, which is the shape the guard exists for.
      officialBallotTitle: "Solicitor",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
  });

  it("matches a Georgia county Solicitor General title to the Solicitor General office", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-solicitor-general", canonical_name: "Solicitor General" },
          { id: "office-district-attorney", canonical_name: "District Attorney" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Hall County, Georgia",
      state: "GA",
      officialBallotTitle: "Hall County Solicitor General",
    });

    expect(result.officeId).toBe("office-solicitor-general");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("ignores election-stage words when matching office titles", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [{ id: "office-governor", canonical_name: "Governor" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "Primary Election for California Governor",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("returns ambiguous when top office scores are too close", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { place: [] },
      officesByScope: {
        place: [
          { id: "office-city-clerk", canonical_name: "City Clerk" },
          { id: "office-town-clerk", canonical_name: "Town Clerk" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Springfield",
      state: "IL",
      officialBallotTitle: "Clerk",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("ambiguous");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("normalizes U.S. marker and punctuation for senate title matching", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [{ id: "office-us-senator", canonical_name: "United States Senator" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "U.S. Senator (Unexpired Term)",
    });

    expect(result.officeId).toBe("office-us-senator");
    expect(result.method).toBe("deterministic_fallback");
  });

  it("maps clear statewide U.S. Senate titles to United States Senator and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-us-senator", canonical_name: "United States Senator" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "U.S. Senate (Special Election)",
    });

    expect(result.officeId).toBe("office-us-senator");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("united states senate special election");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("maps us_senate family entries to United States Senator even with generic senate title", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-us-senator", canonical_name: "United States Senator" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "Senator",
      discoveryContestFamily: "us_senate",
    });

    expect(result.officeId).toBe("office-us-senator");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("senator");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("does not force non-Senate statewide titles to United States Senator", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-us-senator", canonical_name: "United States Senator" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "California Governor",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.officeId).not.toBe("office-us-senator");
  });

  it("does not let us_senate family provenance override a clearly different office title", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-us-senator", canonical_name: "United States Senator" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "Governor",
      discoveryContestFamily: "us_senate",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.officeId).not.toBe("office-us-senator");
  });

  it("does not treat state senate titles as compatible with us_senate provenance", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-governor", canonical_name: "Governor" },
          { id: "office-us-senator", canonical_name: "United States Senator" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "State Senator",
      discoveryContestFamily: "us_senate",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.officeId).not.toBe("office-us-senator");
  });

  it("uses stripped matcher key for alias-memory persistence", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { us_house: [] },
      officesByScope: {
        us_house: [{ id: "office-us-house", canonical_name: "United States Representative" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "us_house",
      districtName: "Congressional District 31 (119th Congress), California",
      state: "CA",
      officialBallotTitle: "United States Representative, 31st District",
    });

    expect(result.officeId).toBe("office-us-house");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.normalizedAlias).toBe("united states representative 31st district");
    expect(result.aliasMemoryKey).toBe("united states representative");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("reads learned alias memory from stripped key on subsequent resolve", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { us_house: [] },
      officesByScope: {
        us_house: [{ id: "office-us-house", canonical_name: "United States Representative" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);

    const first = await matcher.resolve({
      scope: "us_house",
      districtName: "Congressional District 31 (119th Congress), California",
      state: "CA",
      officialBallotTitle: "United States Representative, 31st District",
    });
    expect(first.method).toBe("deterministic_fallback");
    expect(first.officeId).toBe("office-us-house");
    expect(first.aliasMemoryKey).toBe("united states representative");

    matcher.rememberAlias("us_house", first.aliasMemoryKey, "office-us-house");

    const second = await matcher.resolve({
      scope: "us_house",
      districtName: "Congressional District 31 (119th Congress), California",
      state: "CA",
      officialBallotTitle: "United States Representative, 31st District",
    });
    expect(second.method).toBe("alias_exact");
    expect(second.officeId).toBe("office-us-house");
    expect(second.shouldPersistAlias).toBe(false);
  });

  it("maps us_house office titles to United States Representative and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { us_house: [] },
      officesByScope: {
        us_house: [{ id: "office-us-house", canonical_name: "United States Representative" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "us_house",
      districtName: "Congressional District 31 (119th Congress), California",
      state: "CA",
      officialBallotTitle: "Member of Congress, 31st District",
    });

    expect(result.officeId).toBe("office-us-house");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("member of congress");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("returns none for us_house when United States Representative office row is missing", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { us_house: [] },
      officesByScope: {
        us_house: [],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "us_house",
      districtName: "Congressional District 31 (119th Congress), California",
      state: "CA",
      officialBallotTitle: "Member of Congress, 31st District",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("maps state_upper office titles to State Senator and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { state_upper: [] },
      officesByScope: {
        state_upper: [{ id: "office-state-senator", canonical_name: "State Senator" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "state_upper",
      districtName: "California State Senate District 12",
      state: "CA",
      officialBallotTitle: "Member of the Legislature, District 12",
    });

    expect(result.officeId).toBe("office-state-senator");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("member of the legislature");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("returns none for state_upper when State Senator office row is missing", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { state_upper: [] },
      officesByScope: {
        state_upper: [],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "state_upper",
      districtName: "California State Senate District 12",
      state: "CA",
      officialBallotTitle: "Member of the Legislature, District 12",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("maps state_lower office titles to State Lower Chamber Legislator and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { state_lower: [] },
      officesByScope: {
        state_lower: [
          { id: "office-state-lower", canonical_name: "State Lower Chamber Legislator" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "state_lower",
      districtName: "Massachusetts State House District 7",
      state: "MA",
      officialBallotTitle: "Representative in General Court, District 7",
    });

    expect(result.officeId).toBe("office-state-lower");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("representative in general court");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("returns none for state_lower when State Lower Chamber Legislator office row is missing", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { state_lower: [] },
      officesByScope: {
        state_lower: [],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "state_lower",
      districtName: "Massachusetts State House District 7",
      state: "MA",
      officialBallotTitle: "Representative in General Court, District 7",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("maps statewide judicial-family titles to State Level Judge and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [{ id: "office-state-judge", canonical_name: "State Level Judge" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "Justice of the Supreme Court",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-state-judge");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("justice of the supreme court");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("maps county judicial-family titles to County Level Judge and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [{ id: "office-county-judge", canonical_name: "County Level Judge" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Los Angeles County",
      state: "CA",
      officialBallotTitle: "Superior Court Judge, Office No. 7",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-county-judge");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("superior court judge");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("maps place judicial-family titles to Place Level Judge and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { place: [] },
      officesByScope: {
        place: [{ id: "office-place-judge", canonical_name: "Place Level Judge" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "place",
      districtName: "Sample City",
      state: "CA",
      officialBallotTitle: "Municipal Judge",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-place-judge");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("municipal judge");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("does not force-map a mis-stamped statewide non-judicial title to State Level Judge", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { statewide: [] },
      officesByScope: {
        statewide: [
          { id: "office-state-judge", canonical_name: "State Level Judge" },
          { id: "office-governor", canonical_name: "Governor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "statewide",
      districtName: "California",
      state: "CA",
      officialBallotTitle: "Governor",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-governor");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("does not force-map District Attorney to County Level Judge under judicial provenance", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-judge", canonical_name: "County Level Judge" },
          { id: "office-district-attorney", canonical_name: "District Attorney" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Washoe County",
      state: "NV",
      officialBallotTitle: "District Attorney",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBe("office-district-attorney");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("returns none for a judicial-family title with no judicial marker or office match", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [{ id: "office-county-judge", canonical_name: "County Level Judge" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Washoe County",
      state: "NV",
      officialBallotTitle: "Public Administrator",
      discoveryContestFamily: "judicial_office",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("maps school-scope office titles to School Board Member and persists alias memory", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { school_unified: [] },
      officesByScope: {
        school_unified: [{ id: "office-school-board", canonical_name: "School Board Member" }],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "school_unified",
      districtName: "Baldwin Park Unified School District",
      state: "CA",
      officialBallotTitle: "Governing Board Trustee, Area 3",
    });

    expect(result.officeId).toBe("office-school-board");
    expect(result.method).toBe("deterministic_fallback");
    expect(result.confidence).toBe(1);
    expect(result.aliasMemoryKey).toBe("governing board trustee area 3");
    expect(result.shouldPersistAlias).toBe(true);
  });

  it("returns none for school scopes when School Board Member office row is missing", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { school_elementary: [] },
      officesByScope: {
        school_elementary: [],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "school_elementary",
      districtName: "Sample Elementary School District",
      state: "CA",
      officialBallotTitle: "Governing Board Member",
    });

    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("matches a county-name-prefixed executive title via the bare-title alias (Harris County Judge)", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [{ office_id: "office-county-executive", normalized_alias: "county judge" }],
      },
      officesByScope: {
        county: [
          { id: "office-county-executive", canonical_name: "County Executive" },
          { id: "office-county-judge-judicial", canonical_name: "County Level Judge" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Harris County, Texas",
      state: "TX",
      officialBallotTitle: "Harris County Judge",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-executive");
    expect(result.method).toBe("alias_exact");
  });

  it("matches a county board president title via alias after stripping the county name", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          {
            office_id: "office-county-executive",
            normalized_alias: "president of the county board of commissioners",
          },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-county-executive", canonical_name: "County Executive" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Cook County, Illinois",
      state: "IL",
      officialBallotTitle: "President of the Cook County Board of Commissioners",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-executive");
    expect(result.method).toBe("alias_exact");
  });

  it("scores a county-name-prefixed standard title into the right office without an alias", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-clerk", canonical_name: "County Clerk" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Dallas County, Texas",
      state: "TX",
      officialBallotTitle: "Dallas County Clerk",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-clerk");
  });

  it("scores NC 'COUNTY BOARD OF COMMISSIONERS' seat titles into County Commissioner without aliases", async () => {
    // North Carolina certifications title every commission seat by its
    // governing body; ~150 live shells stranded with office_id NULL because
    // the plural body form near-zero-overlaps "County Commissioner". The seat
    // descriptors are deliberately varied: numbered districts, at-large
    // (lettered and with trailing SEAT), townships, named districts,
    // chairman, and unexpired terms all reduce to a scoreable key.
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-supervisor", canonical_name: "County Supervisor" },
          { id: "office-county-executive", canonical_name: "County Executive" },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const titles: Array<[district: string, title: string]> = [
      ["Alamance County, North Carolina", "ALAMANCE COUNTY BOARD OF COMMISSIONERS"],
      ["Anson County, North Carolina", "ANSON COUNTY BOARD OF COMMISSIONERS DISTRICT 02"],
      ["Moore County, North Carolina", "MOORE COUNTY BOARD OF COMMISSIONERS DISTRICT III"],
      ["Caswell County, North Carolina", "CASWELL COUNTY BOARD OF COMMISSIONERS AT-LARGE (UNEXPIRED)"],
      ["Franklin County, North Carolina", "FRANKLIN COUNTY BOARD OF COMMISSIONERS AT-LARGE SEAT"],
      ["Chowan County, North Carolina", "CHOWAN COUNTY BOARD OF COMMISSIONERS DISTRICT 01 SEAT"],
      ["Gaston County, North Carolina", "GASTON COUNTY BOARD OF COMMISSIONERS DALLAS TWP"],
      ["Camden County, North Carolina", "CAMDEN COUNTY BOARD OF COMMISSIONERS SHILOH DISTRICT"],
      ["Jackson County, North Carolina", "JACKSON COUNTY BOARD OF COMMISSIONERS CHAIRMAN"],
      ["Cumberland County, North Carolina", "CUMBERLAND COUNTY BOARD OF COMMISSIONERS DISTRICT"],
      ["Forsyth County, North Carolina", "FORSYTH COUNTY BOARD OF COMMISSIONERS DISTRICT A"],
      ["Wake County, North Carolina", "Wake County Board of Commissioners At-Large"],
    ];
    for (const [districtName, officialBallotTitle] of titles) {
      const result = await matcher.resolve({
        scope: "county",
        districtName,
        state: "NC",
        officialBallotTitle,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, officialBallotTitle).toBe("office-county-commissioner");
      expect(result.method, officialBallotTitle).toBe("deterministic_fallback");
    }
  });

  it("keeps the Cook County board PRESIDENT on its County Executive alias despite the body rewrite", async () => {
    // The county-board-of-commissioners rewrite must not fire after
    // "president of the": the board president is the county executive with
    // its own alias, and a rewritten key would misroute the race into the
    // member office via the token scorer.
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          {
            office_id: "office-county-executive",
            normalized_alias: "president of the county board of commissioners",
          },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-county-executive", canonical_name: "County Executive" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Cook County, Illinois",
      state: "IL",
      officialBallotTitle: "President of the Cook County Board of Commissioners",
      discoveryContestFamily: "non_judicial_office",
    });

    expect(result.officeId).toBe("office-county-executive");
    expect(result.method).toBe("alias_exact");
  });

  it("strips ward/zone/seat/part/justice-precinct numbered seat suffixes and at-large designators", async () => {
    // Each form wrote a live NULL-office shell; the essential contract is the
    // matcher KEY each title reduces to (pinned via aliasMemoryKey with an
    // empty catalog), because the migration-184 aliases and new offices key
    // on exactly these reduced forms.
    const matcher = new OfficeMatcher(
      createMatcherDataClient({ aliasesByScope: {}, officesByScope: {} }) as never
    );

    const cases: Array<[district: string, state: string, title: string, expectedKey: string]> = [
      ["Callaway city, Florida", "FL", "Callaway City Commission Ward 1", "city commission"],
      ["Ormond Beach city, Florida", "FL", "Ormond Beach City Commission Zone 4", "city commission"],
      ["Kissimmee city, Florida", "FL", "Kissimmee City Commission Seat 2", "city commission"],
      ["Sarasota city, Florida", "FL", "Sarasota City Commission At-Large", "city commission"],
      ["Daytona Beach city, Florida", "FL", "Daytona Beach City Commissioner Zone 5", "city commissioner"],
      ["Carson City, Nevada", "NV", "Carson City Board of Supervisors, Ward 1", "city board of supervisors"],
      ["Howard County, Maryland", "MD", "For Member of County Council (District 1)", "member of county council"],
      ["Anne Arundel County, Maryland", "MD", "County Council At Large", "county council"],
      ["Anne Arundel County, Maryland", "MD", "County Council At-Large A", "county council"],
      ["Davidson County, Tennessee", "TN", "Chancellor Part II, District 30, Unexpired Term", "chancellor"],
      ["Maricopa County, Arizona", "AZ", "Constable, Justice Prec. 2", "constable"],
      ["Maricopa County, Arizona", "AZ", "Justice of the Peace, Prec. 2", "justice of the peace"],
      // Ordinal-FIRST ward numbering (Grand Rapids MI live): the ordinal-last
      // rule alone left "city commissioner 1st ward", which matched nothing
      // and aborted the whole payload.
      ["Grand Rapids city, Michigan", "MI", "City Commissioner 1st Ward", "city commissioner"],
      ["Grand Rapids city, Michigan", "MI", "City Commissioner 2nd Ward", "city commissioner"],
      ["Grand Rapids city, Michigan", "MI", "City Commissioner 3rd Ward", "city commissioner"],
      ["Detroit city, Michigan", "MI", "City Council Member 4th District", "city council member"],
      // Ordinal-first must win over the ordinal-last rule when a term suffix
      // follows: matching "Ward 4" out of "1st Ward 4 Year Term" would strand
      // the leading "1st". The residual "4 year term" is a SEPARATE, unfixed
      // gap — see the term-suffix test below for what it still costs.
      [
        "Grand Rapids city, Michigan",
        "MI",
        "City Commissioner 1st Ward 4 Year Term",
        "city commissioner 4 year term",
      ],
      // Michigan's spelling of the vacancy descriptor, end date included.
      [
        "Grand Rapids city, Michigan",
        "MI",
        "Library Board Partial Term Ending 12/31/2028",
        "library board",
      ],
      [
        "Lansing city, Michigan",
        "MI",
        "Lansing School Board Member, Partial Term Ending 12/31/2030",
        "school board member",
      ],
    ];
    for (const [districtName, state, officialBallotTitle, expectedKey] of cases) {
      const result = await matcher.resolve({
        scope: districtName.includes("County") ? "county" : "place",
        districtName,
        state,
        officialBallotTitle,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.aliasMemoryKey, officialBallotTitle).toBe(expectedKey);
    }
  });

  it("resolves the migration 184 alias gaps end-to-end from the live ballot titles", async () => {
    // Guards the normalizer-parity invariant for migration 184's aliases
    // (same guard pattern as migrations 164/165/169): the migration stores
    // hand-written normalized_alias literals while the seed layer stores
    // normalizeElectionTitleKey(aliasText) — pin the non-obvious ones so a
    // normalizer change cannot silently strand these titles again.
    expect(normalizeElectionTitleKey("State's Attorney")).toBe("state s attorney");
    expect(normalizeElectionTitleKey("Register of Probate County")).toBe(
      "register of probate county"
    );
    expect(normalizeElectionTitleKey("Member of County Council")).toBe("member of county council");
    expect(normalizeElectionTitleKey("City Board of Supervisors")).toBe(
      "city board of supervisors"
    );

    const aliasRow = (officeId: string, aliasText: string) => ({
      office_id: officeId,
      normalized_alias: normalizeElectionTitleKey(aliasText),
    });
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          aliasRow("office-county-supervisor", "County Council"),
          aliasRow("office-county-supervisor", "County Council Chair"),
          aliasRow("office-county-supervisor", "Member of County Council"),
          aliasRow("office-county-supervisor", "Council Member"),
          aliasRow("office-district-attorney", "State's Attorney"),
          aliasRow("office-district-attorney", "County Attorney"),
          aliasRow("office-county-recorder", "County Register of Deeds"),
          aliasRow("office-clerk-of-court", "County Register of Probate"),
          aliasRow("office-clerk-of-court", "Register of Probate County"),
          aliasRow("office-clerk-of-court", "County Circuit Court Clerk"),
          aliasRow("office-county-treasurer", "County Trustee"),
          aliasRow("office-county-level-judge", "Chancellor"),
          aliasRow("office-constable", "Constable"),
          aliasRow(
            "office-soil-water-supervisor",
            "County Soil and Water Conservation District Supervisor"
          ),
        ],
        statewide: [aliasRow("office-comptroller", "Tax Commissioner")],
        place: [
          aliasRow("office-city-council-member", "City Commission"),
          aliasRow("office-city-council-member", "City Board of Supervisors"),
          aliasRow("office-city-council-member", "Louisville Metro Council Member"),
        ],
      },
      officesByScope: {
        // County Clerk and Clerk of Court both sit in the catalog: before the
        // alias, "Davidson County Circuit Court Clerk" tied them into an
        // ambiguous NULL office (live).
        county: [
          { id: "office-county-supervisor", canonical_name: "County Supervisor" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-district-attorney", canonical_name: "District Attorney" },
          { id: "office-county-recorder", canonical_name: "County Recorder" },
          { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
          { id: "office-county-level-judge", canonical_name: "County Level Judge" },
          { id: "office-constable", canonical_name: "Constable" },
          {
            id: "office-soil-water-supervisor",
            canonical_name: "Soil and Water Conservation District Supervisor",
          },
          { id: "office-county-surveyor", canonical_name: "County Surveyor" },
        ],
        statewide: [
          { id: "office-comptroller", canonical_name: "Comptroller" },
          { id: "office-state-auditor", canonical_name: "State Auditor" },
        ],
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-town-council-member", canonical_name: "Town Council Member" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const cases: Array<{
      scope: "county" | "statewide" | "place";
      districtName: string;
      state: string;
      title: string;
      family?: "non_judicial_office" | "judicial_office";
      expected: string;
    }> = [
      {
        scope: "county",
        districtName: "Anne Arundel County, Maryland",
        state: "MD",
        title: "County Council At-Large A",
        expected: "office-county-supervisor",
      },
      {
        scope: "county",
        districtName: "Howard County, Maryland",
        state: "MD",
        title: "For Member of County Council (District 5)",
        expected: "office-county-supervisor",
      },
      {
        scope: "county",
        districtName: "Spartanburg County, South Carolina",
        state: "SC",
        title: "County Council Chair",
        expected: "office-county-supervisor",
      },
      {
        scope: "county",
        districtName: "Honolulu County, Hawaii",
        state: "HI",
        title: "Honolulu Councilmember, Dist II",
        expected: "office-county-supervisor",
      },
      {
        scope: "county",
        districtName: "Baltimore city, Maryland",
        state: "MD",
        title: "State's Attorney",
        expected: "office-district-attorney",
      },
      {
        scope: "county",
        districtName: "Jefferson County, Kentucky",
        state: "KY",
        title: "Jefferson County Attorney",
        expected: "office-district-attorney",
      },
      {
        scope: "county",
        districtName: "Yadkin County, North Carolina",
        state: "NC",
        title: "YADKIN COUNTY REGISTER OF DEEDS",
        expected: "office-county-recorder",
      },
      {
        scope: "county",
        districtName: "Suffolk County, Massachusetts",
        state: "MA",
        title: "Suffolk County Register of Probate",
        expected: "office-clerk-of-court",
      },
      {
        scope: "county",
        districtName: "Middlesex County, Massachusetts",
        state: "MA",
        title: "Register of Probate, Middlesex County",
        expected: "office-clerk-of-court",
      },
      {
        scope: "county",
        districtName: "Davidson County, Tennessee",
        state: "TN",
        title: "Davidson County Circuit Court Clerk",
        expected: "office-clerk-of-court",
      },
      {
        scope: "county",
        districtName: "Shelby County, Tennessee",
        state: "TN",
        title: "Shelby County Trustee",
        expected: "office-county-treasurer",
      },
      {
        scope: "county",
        districtName: "Davidson County, Tennessee",
        state: "TN",
        title: "Chancellor Part II, District 30, Unexpired Term",
        family: "judicial_office",
        expected: "office-county-level-judge",
      },
      {
        scope: "county",
        districtName: "Maricopa County, Arizona",
        state: "AZ",
        title: "Constable, Justice Prec. 2",
        expected: "office-constable",
      },
      {
        scope: "county",
        districtName: "Jefferson County, Kentucky",
        state: "KY",
        title: "Jefferson County Soil and Water Conservation District Supervisor",
        expected: "office-soil-water-supervisor",
      },
      {
        scope: "county",
        districtName: "Boulder County, Colorado",
        state: "CO",
        title: "Boulder County Surveyor",
        expected: "office-county-surveyor",
      },
      {
        scope: "statewide",
        districtName: "North Dakota",
        state: "ND",
        title: "Tax Commissioner",
        expected: "office-comptroller",
      },
      {
        scope: "place",
        districtName: "Callaway city, Florida",
        state: "FL",
        title: "Callaway City Commission Ward 1",
        expected: "office-city-council-member",
      },
      {
        scope: "place",
        districtName: "Carson City, Nevada",
        state: "NV",
        title: "Carson City Board of Supervisors, Ward 1",
        expected: "office-city-council-member",
      },
      {
        scope: "place",
        districtName: "Louisville/Jefferson County metro government, Kentucky",
        state: "KY",
        title: "Louisville Metro Council Member, District 23",
        expected: "office-city-council-member",
      },
    ];
    for (const testCase of cases) {
      const result = await matcher.resolve({
        scope: testCase.scope,
        districtName: testCase.districtName,
        state: testCase.state,
        officialBallotTitle: testCase.title,
        discoveryContestFamily: testCase.family ?? "non_judicial_office",
      });
      expect(result.officeId, testCase.title).toBe(testCase.expected);
    }
  });

  it("resolves the Grand Rapids ordinal-first ward and library board titles", async () => {
    // Grand Rapids MI ballots number the commission seat ordinal-FIRST ("City
    // Commissioner 1st Ward"). Only the ordinal-LAST form ("Ward 1") was
    // stripped, so these three Nov-3-2026 contests resolved to no office and
    // electionsWriter aborted the ENTIRE payload on the first one — taking the
    // two Library Board contests (migration 220's office) down with them.
    const aliasRow = (officeId: string, aliasText: string) => ({
      office_id: officeId,
      normalized_alias: normalizeElectionTitleKey(aliasText),
    });
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [
          aliasRow("office-city-council-member", "City Commissioner"),
          aliasRow("office-city-council-member", "City Commission"),
          aliasRow("office-library-board-member", "Library Board"),
        ],
      },
      officesByScope: {
        place: [
          { id: "office-city-council-member", canonical_name: "City Council Member" },
          { id: "office-library-board-member", canonical_name: "Library Board Member" },
          { id: "office-mayor", canonical_name: "Mayor" },
        ],
      },
    });

    const matcher = new OfficeMatcher(client as never);
    const cases: Array<[title: string, expected: string]> = [
      ["City Commissioner 1st Ward", "office-city-council-member"],
      ["City Commissioner 2nd Ward", "office-city-council-member"],
      ["City Commissioner 3rd Ward", "office-city-council-member"],
      // The ordinal-last form the fix must leave green.
      ["City Commissioner Ward 1", "office-city-council-member"],
      // The other two contests the same payload abort took down.
      ["Library Board", "office-library-board-member"],
      ["Library Board Partial Term Ending 12/31/2028", "office-library-board-member"],
    ];
    for (const [officialBallotTitle, expected] of cases) {
      const result = await matcher.resolve({
        scope: "place",
        districtName: "Grand Rapids city, Michigan",
        state: "MI",
        officialBallotTitle,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, officialBallotTitle).toBe(expected);
      expect(result.method, officialBallotTitle).toBe("alias_exact");
    }
  });

  it("pins the unfixed 'N Year Term' suffix gap", async () => {
    // Kent County prints the term length on the heading line ("City
    // Commissioner 1st Ward 4 Year Term"). Nothing strips "N Year Term", so
    // the residual key misses the alias table and the token scorer falls
    // under its floor. This is NOT ward-specific — plain "City Comptroller
    // 4 Year Term" fails the same way — so it is deliberately out of scope
    // for the ordinal-first fix and pinned here instead of hidden.
    //
    // The district's written rows follow the corpus convention and drop the
    // term boilerplate ("City Comptroller"), so the live data path is
    // unaffected. When the suffix strip lands, this test flips to expecting
    // a match.
    const aliasRow = (officeId: string, aliasText: string) => ({
      office_id: officeId,
      normalized_alias: normalizeElectionTitleKey(aliasText),
    });
    const matcher = new OfficeMatcher(
      createMatcherDataClient({
        aliasesByScope: {
          place: [
            aliasRow("office-city-council-member", "City Commissioner"),
            aliasRow("office-comptroller", "City Comptroller"),
          ],
        },
        officesByScope: {
          place: [
            { id: "office-city-council-member", canonical_name: "City Council Member" },
            { id: "office-comptroller", canonical_name: "Comptroller" },
            { id: "office-mayor", canonical_name: "Mayor" },
          ],
        },
      }) as never
    );

    for (const officialBallotTitle of [
      "City Commissioner 1st Ward 4 Year Term",
      "City Comptroller 4 Year Term",
    ]) {
      const result = await matcher.resolve({
        scope: "place",
        districtName: "Grand Rapids city, Michigan",
        state: "MI",
        officialBallotTitle,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, officialBallotTitle).toBeNull();
      expect(result.method, officialBallotTitle).toBe("none");
    }
  });

  describe("Louisiana justice-of-the-peace and constable seat forms", () => {
    const louisianaCountyOffices = [
      { id: "office-justice-of-the-peace", canonical_name: "Justice of the Peace" },
      { id: "office-constable", canonical_name: "Constable" },
      { id: "office-county-level-judge", canonical_name: "County Level Judge" },
      { id: "office-district-attorney", canonical_name: "District Attorney" },
    ];

    function createLouisianaMatcher(
      aliases: Array<{ office_id: string; normalized_alias: string }> = []
    ) {
      const client = createMatcherDataClient({
        aliasesByScope: { county: aliases },
        officesByScope: { county: louisianaCountyOffices },
      });
      return new OfficeMatcher(client as never);
    }

    it("strips a Florida CDD's proper name so the live Bay County seat titles resolve", async () => {
      // "Lake Powell Residential Golf Community Development District, Seat 2"
      // (Bay County live) returned method=none at 0.222 and stranded four
      // qualified candidates across two contested seats. The CDD's proper name
      // is the seat's jurisdiction, and the ordinary jurisdiction strip cannot
      // remove it: that keys on the districts row, which is the COUNTY.
      const createCddMatcher = () =>
        new OfficeMatcher(
          createMatcherDataClient({
            aliasesByScope: {
              county: [
                {
                  office_id: "office-cdd-supervisor",
                  normalized_alias: "community development district",
                },
              ],
            },
            officesByScope: { county: louisianaCountyOffices },
          }) as never
        );

      for (const title of [
        "Lake Powell Residential Golf Community Development District, Seat 2",
        "Lake Powell Residential Golf Community Development District, Seat 5",
      ]) {
        const result = await createCddMatcher().resolve({
          scope: "county",
          districtName: "Bay County, Florida",
          state: "FL",
          officialBallotTitle: title,
          discoveryContestFamily: "non_judicial_office",
        });

        expect(result).toMatchObject({
          officeId: "office-cdd-supervisor",
          method: "alias_exact",
          confidence: 1,
        });
      }
    });

    it("folds the abbreviated CDD form to the same civic phrase", async () => {
      // County candidate lists abbreviate the phrase; the strip folds the
      // bare token so the same alias wins.
      const result = await new OfficeMatcher(
        createMatcherDataClient({
          aliasesByScope: {
            county: [
              {
                office_id: "office-cdd-supervisor",
                normalized_alias: "community development district",
              },
            ],
          },
          officesByScope: { county: louisianaCountyOffices },
        }) as never
      ).resolve({
        scope: "county",
        districtName: "Bay County, Florida",
        state: "FL",
        officialBallotTitle: "Lake Powell Residential Golf CDD, Seat 2",
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result).toMatchObject({
        officeId: "office-cdd-supervisor",
        method: "alias_exact",
        confidence: 1,
      });
    });

    it("refuses to strip a CDD prefix that carries a different function noun", async () => {
      // "Treasurer, <name> Community Development District" names a DIFFERENT
      // job. Deleting the prefix would hand it the supervisor office at full
      // confidence — the silent-wrong-match class again. The role word blocks
      // the strip, and the untouched title must NOT land on the CDD office.
      const matcher = () =>
        new OfficeMatcher(
          createMatcherDataClient({
            aliasesByScope: {
              county: [
                {
                  office_id: "office-cdd-supervisor",
                  normalized_alias: "community development district",
                },
              ],
            },
            officesByScope: { county: louisianaCountyOffices },
          }) as never
        );

      for (const title of [
        "Treasurer, Lake Powell Residential Golf Community Development District",
        "Director of Lake Powell Residential Golf Community Development District, Seat 2",
      ]) {
        const result = await matcher().resolve({
          scope: "county",
          districtName: "Bay County, Florida",
          state: "FL",
          officialBallotTitle: title,
          discoveryContestFamily: "non_judicial_office",
        });

        expect(result.officeId).not.toBe("office-cdd-supervisor");
      }

      // "Supervisor" IS this office, so a supervisor-led form still strips.
      const supervisorLed = await matcher().resolve({
        scope: "county",
        districtName: "Bay County, Florida",
        state: "FL",
        officialBallotTitle:
          "Supervisor, Lake Powell Residential Golf Community Development District, Seat 2",
        discoveryContestFamily: "non_judicial_office",
      });
      expect(supervisorLed).toMatchObject({
        officeId: "office-cdd-supervisor",
        method: "alias_exact",
        confidence: 1,
      });
    });

    it("leaves a title alone when it names no community development district", async () => {
      // The strip is anchored on the civic phrase, so an ordinary county
      // contest keeps its own jurisdiction handling.
      const result = await createLouisianaMatcher([
        { office_id: "office-constable", normalized_alias: "constable" },
      ]).resolve({
        scope: "county",
        districtName: "Jefferson Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Constable 2nd Justice Court",
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result).toMatchObject({ officeId: "office-constable", confidence: 1 });
    });

    it("resolves the doubled SOS justice-of-the-peace title to the JP office, not the trial court", async () => {
      const result = await createLouisianaMatcher().resolve({
        scope: "county",
        districtName: "Caddo Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Justice of the Peace Justice of the Peace Ward 1",
        discoveryContestFamily: "judicial_office",
      });

      expect(result).toMatchObject({
        officeId: "office-justice-of-the-peace",
        method: "deterministic_fallback",
        confidence: 1,
        aliasMemoryKey: "justice of the peace",
      });
    });

    it("strips Caddo's named ward sub-district from the justice-of-the-peace seat key", async () => {
      const result = await createLouisianaMatcher().resolve({
        scope: "county",
        districtName: "Caddo Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Justice of the Peace Justice of the Peace Ward 2, Vivian Dist.",
        discoveryContestFamily: "judicial_office",
      });

      expect(result).toMatchObject({
        officeId: "office-justice-of-the-peace",
        aliasMemoryKey: "justice of the peace",
      });
    });

    it("resolves Jefferson's numbered-justice-court JP seat form", async () => {
      const result = await createLouisianaMatcher().resolve({
        scope: "county",
        districtName: "Jefferson Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Justice of the Peace 2nd Justice Court",
        discoveryContestFamily: "judicial_office",
      });

      expect(result).toMatchObject({
        officeId: "office-justice-of-the-peace",
        aliasMemoryKey: "justice of the peace",
      });
    });

    it("resolves Jefferson's 'Constable 2nd Justice Court', which scored 0.520 and failed the writer", async () => {
      const result = await createLouisianaMatcher([
        { office_id: "office-constable", normalized_alias: "constable" },
      ]).resolve({
        scope: "county",
        districtName: "Jefferson Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Constable 2nd Justice Court",
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result).toMatchObject({
        officeId: "office-constable",
        method: "alias_exact",
        confidence: 1,
      });
    });

    it("folds the '(s)' optional-plural marker on both St. Tammany seat forms", async () => {
      // 19 live St. Tammany rows title the seat "Constable(s) Justice of the
      // Peace Ward N" / "Justice(s) of the Peace ...". Punctuation folding alone
      // leaves a stray "s" token mid-phrase, which broke the constable form at
      // exactly 0.520 — the same failure as Jefferson's.
      const matcher = createLouisianaMatcher([
        { office_id: "office-constable", normalized_alias: "constable" },
        { office_id: "office-justice-of-the-peace", normalized_alias: "justice of the peace" },
      ]);

      const constable = await matcher.resolve({
        scope: "county",
        districtName: "St. Tammany Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Constable(s) Justice of the Peace Ward 10",
        discoveryContestFamily: "non_judicial_office",
      });
      expect(constable).toMatchObject({ officeId: "office-constable", method: "alias_exact" });

      const justiceOfThePeace = await matcher.resolve({
        scope: "county",
        districtName: "St. Tammany Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Justice(s) of the Peace Justice of the Peace Ward 1",
        discoveryContestFamily: "judicial_office",
      });
      expect(justiceOfThePeace).toMatchObject({
        officeId: "office-justice-of-the-peace",
        method: "alias_exact",
      });
    });

    it("resolves Caddo's 'Constable Justice of the Peace Ward N' to Constable, not the JP office", async () => {
      const result = await createLouisianaMatcher([
        { office_id: "office-constable", normalized_alias: "constable" },
      ]).resolve({
        scope: "county",
        districtName: "Caddo Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Constable Justice of the Peace Ward 7",
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBe("office-constable");
    });

    it("keeps a judicial-family constable seat out of the judge fallback", async () => {
      // Every word of "Constable 1st City Court" past the office name is a
      // judicial allow-marker; a mis-tagged family must not hand the seat to a
      // judge office. Deliberately no constable alias here: the point is that
      // the judge fallback does not fire.
      const result = await createLouisianaMatcher().resolve({
        scope: "county",
        districtName: "Orleans Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Constable 1st City Court",
        discoveryContestFamily: "judicial_office",
      });

      expect(result.officeId).toBe("office-constable");
      expect(result.officeId).not.toBe("office-county-level-judge");
    });

    it("routes Orleans' municipal constable seat to Municipal Constable in place scope", async () => {
      const client = createMatcherDataClient({
        aliasesByScope: {
          place: [{ office_id: "office-municipal-constable", normalized_alias: "constable" }],
        },
        officesByScope: {
          place: [
            { id: "office-municipal-constable", canonical_name: "Municipal Constable" },
            { id: "office-place-level-judge", canonical_name: "Place Level Judge" },
            { id: "office-city-council-member", canonical_name: "City Council Member" },
          ],
        },
      });
      const matcher = new OfficeMatcher(client as never);

      const result = await matcher.resolve({
        scope: "place",
        districtName: "New Orleans city, Louisiana",
        state: "LA",
        officialBallotTitle: "Constable 1st City Court",
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result).toMatchObject({
        officeId: "office-municipal-constable",
        method: "alias_exact",
      });
    });

    it("leaves a judge title's own court words alone", async () => {
      const result = await createLouisianaMatcher().resolve({
        scope: "county",
        districtName: "Jefferson Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Judge 1st Parish Court, Division A",
        discoveryContestFamily: "judicial_office",
      });

      expect(result.officeId).toBe("office-county-level-judge");
    });

    it("does not guess a JP office for a non-judicial-family entry", async () => {
      const result = await createLouisianaMatcher().resolve({
        scope: "county",
        districtName: "Caddo Parish, Louisiana",
        state: "LA",
        officialBallotTitle: "Justice of the Peace Ward 5",
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBeNull();
      expect(result.method).toBe("none");
    });
  });

  it("folds district-named Florida fire-district seat titles onto the fire-district office", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-fire-district", canonical_name: "Fire Control District Commissioner" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          {
            id: "office-soil-water-supervisor",
            canonical_name: "Soil and Water Conservation District Supervisor",
          },
          { id: "office-sheriff", canonical_name: "Sheriff" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Every form on the Santa Rosa County, FL Nov 2026 ballot. The district's
    // own proper noun is unenumerable, so these must resolve without an alias.
    const titles = [
      "Holley-Navarre Fire District Seat 3",
      "Navarre Beach Fire Rescue District, Seat 5",
      "Avalon Beach-Mulat Fire Protection District Seat 1",
      "Midway Fire District Seat 2",
      "Pace Fire Rescue District Seat 4",
    ];
    for (const title of titles) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Santa Rosa County, Florida",
        state: "FL",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBe("office-fire-district");
      // The folded key is the canonical office's own, so the alias the writer
      // learns is district-agnostic rather than one row per fire district.
      expect(result.aliasMemoryKey, title).toBe("fire control district commissioner");
    }
  });

  it("leaves non-board fire-district roles unmatched instead of folding them into the board seat", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-fire-district", canonical_name: "Fire Control District Commissioner" },
          { id: "office-county-treasurer", canonical_name: "County Treasurer" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // New York's Town Law §174 seats an elected district treasurer alongside
    // the board of fire commissioners; the district phrase is common to both.
    // The catalog has no office for these roles, so no match is the honest
    // answer — and nothing may be persisted as a learned alias.
    const titles = [
      "Smithtown Fire District Treasurer",
      "Smithtown Fire District Secretary",
      "Fire District Clerk",
      "Treasurer, Smithtown Fire District",
    ];
    for (const title of titles) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Suffolk County, New York",
        state: "NY",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBeNull();
      expect(result.shouldPersistAlias, title).toBe(false);
    }

    // The board seat itself still folds, including the comma form the
    // non-board guard has to see past.
    const board = await matcher.resolve({
      scope: "county",
      districtName: "Suffolk County, New York",
      state: "NY",
      officialBallotTitle: "Commissioner, Smithtown Fire District",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(board.officeId).toBe("office-fire-district");
  });

  it("matches the seeded bare Fire Commissioner alias without touching other county offices", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          {
            office_id: "office-fire-district",
            normalized_alias: normalizeElectionTitleKey("Fire Commissioner"),
          },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-fire-district", canonical_name: "Fire Control District Commissioner" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const fire = await matcher.resolve({
      scope: "county",
      districtName: "Santa Rosa County, Florida",
      state: "FL",
      officialBallotTitle: "Fire Commissioner",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(fire).toMatchObject({ officeId: "office-fire-district", method: "alias_exact" });

    // The fire mapping keys on "fire ... district"; a plain county-commission
    // seat in the same county must stay with County Commissioner.
    const commissioner = await matcher.resolve({
      scope: "county",
      districtName: "Santa Rosa County, Florida",
      state: "FL",
      officialBallotTitle: "Santa Rosa County Board of Commissioners District 4",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(commissioner.officeId).toBe("office-county-commissioner");
  });

  const ALABAMA_TAX_OFFICE_ALIASES = [
    { office_id: "office-revenue-commissioner", alias: "Revenue Commissioner" },
    { office_id: "office-revenue-commissioner", alias: "County Revenue Commissioner" },
    { office_id: "office-county-assessor", alias: "Tax Assessor" },
    { office_id: "office-county-assessor", alias: "County Tax Assessor" },
    { office_id: "office-collector-of-revenue", alias: "Tax Collector" },
    { office_id: "office-collector-of-revenue", alias: "County Tax Collector" },
    { office_id: "office-license-commissioner", alias: "License Commissioner" },
    { office_id: "office-license-commissioner", alias: "County License Commissioner" },
    { office_id: "office-license-commissioner", alias: "Commissioner of Licenses" },
    { office_id: "office-license-commissioner", alias: "County Commissioner of Licenses" },
    { office_id: "office-commissioner-of-revenue", alias: "Commissioner of the Revenue" },
    { office_id: "office-commissioner-of-revenue", alias: "Commissioner of Revenue" },
    { office_id: "office-commissioner-of-revenue", alias: "County Commissioner of the Revenue" },
    { office_id: "office-commissioner-of-revenue", alias: "County Commissioner of Revenue" },
  ];

  function createAlabamaTaxOfficeClient(input: { withAliases: boolean }) {
    return createMatcherDataClient({
      aliasesByScope: {
        county: input.withAliases
          ? ALABAMA_TAX_OFFICE_ALIASES.map((entry) => ({
              office_id: entry.office_id,
              normalized_alias: normalizeElectionTitleKey(entry.alias),
            }))
          : [],
      },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-assessor", canonical_name: "County Assessor" },
          { id: "office-collector-of-revenue", canonical_name: "Collector of Revenue" },
          { id: "office-license-collector", canonical_name: "License Collector" },
          ...(input.withAliases
            ? [
                { id: "office-revenue-commissioner", canonical_name: "Revenue Commissioner" },
                { id: "office-license-commissioner", canonical_name: "License Commissioner" },
                { id: "office-commissioner-of-revenue", canonical_name: "Commissioner of the Revenue" },
              ]
            : []),
        ],
      },
    });
  }

  const ALABAMA_TAX_OFFICE_CASES = [
    { district: "Lee County, Alabama", title: "Lee County Revenue Commissioner", expected: "office-revenue-commissioner" },
    { district: "Lee County, Alabama", title: "Revenue Commissioner", expected: "office-revenue-commissioner" },
    { district: "Jefferson County, Alabama", title: "Jefferson County Tax Assessor", expected: "office-county-assessor" },
    { district: "Jefferson County, Alabama", title: "Tax Assessor", expected: "office-county-assessor" },
    { district: "Jefferson County, Alabama", title: "Jefferson County Tax Collector", expected: "office-collector-of-revenue" },
    { district: "Jefferson County, Alabama", title: "Tax Collector", expected: "office-collector-of-revenue" },
    { district: "Tuscaloosa County, Alabama", title: "Tuscaloosa County License Commissioner", expected: "office-license-commissioner" },
    { district: "Calhoun County, Alabama", title: "Calhoun County Commissioner of Licenses", expected: "office-license-commissioner" },
    { district: "Chesterfield County, Virginia", title: "Chesterfield County Commissioner of the Revenue", expected: "office-commissioner-of-revenue" },
    // Virginia's office must not land on Alabama's merged Revenue
    // Commissioner: "commissioner of the revenue" tokenizes identically to
    // "revenue commissioner", so adding the Alabama office alone scored the
    // bare Virginia title 1.000 into it.
    { district: "Chesterfield County, Virginia", title: "Commissioner of the Revenue", expected: "office-commissioner-of-revenue" },
  ];

  it.each(ALABAMA_TAX_OFFICE_CASES)(
    "resolves the county tax office title $title to its own office",
    async ({ district, title, expected }) => {
      const matcher = new OfficeMatcher(createAlabamaTaxOfficeClient({ withAliases: true }) as never);

      const result = await matcher.resolve({
        scope: "county",
        districtName: district,
        state: district.endsWith("Virginia") ? "VA" : "AL",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBe(expected);
      expect(result.method).toBe("alias_exact");
    }
  );

  const QUALIFIED_COMMISSIONER_TITLES = [
    { district: "Lee County, Alabama", title: "Lee County Revenue Commissioner", state: "AL" },
    { district: "Tuscaloosa County, Alabama", title: "Tuscaloosa County License Commissioner", state: "AL" },
    // The "commissioner of X" word order scored 0.920, not 0.800: "county
    // commissioner" sits inside it contiguously and takes the containment boost.
    { district: "Calhoun County, Alabama", title: "Calhoun County Commissioner of Licenses", state: "AL" },
    { district: "Chesterfield County, Virginia", title: "Chesterfield County Commissioner of the Revenue", state: "VA" },
    // Georgia's county tax office has no catalog entry; no-match is the
    // honest outcome there, not a confident wrong one.
    { district: "Fulton County, Georgia", title: "Fulton County Tax Commissioner", state: "GA" },
  ];

  it("never scores a qualified commissioner title into County Commissioner", async () => {
    // The jurisdiction strip keeps the generic civic word, so "Lee County
    // Revenue Commissioner" reached the scorer as "county revenue
    // commissioner": two of its three tokens are County Commissioner's whole
    // name, which scored 0.800 — over the floor, over the margin, and
    // persisted as a learned alias onto the county's LEGISLATIVE body.
    const matcher = new OfficeMatcher(createAlabamaTaxOfficeClient({ withAliases: false }) as never);

    for (const { district, title, state } of QUALIFIED_COMMISSIONER_TITLES) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: district,
        state,
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBeNull();
      expect(result.method).toBe("none");
      expect(result.shouldPersistAlias).toBe(false);
    }
  });

  it("ignores a stored County Commissioner alias for a qualified commissioner title", async () => {
    // An exact alias hit returns before scoreOfficeMatch runs, so the score
    // guard alone does not fail safe on a database that already learned the
    // mis-match. Same shape as the court-clerk alias guard.
    for (const { district, title, state } of QUALIFIED_COMMISSIONER_TITLES) {
      const learned = new OfficeMatcher(
        createMatcherDataClient({
          aliasesByScope: {
            county: [
              { office_id: "office-county-commissioner", normalized_alias: normalizeElectionTitleKey(title) },
              {
                office_id: "office-county-commissioner",
                normalized_alias: normalizeElectionTitleKey(title.replace(/^[A-Za-z]+ /, "")),
              },
            ],
          },
          officesByScope: {
            county: [{ id: "office-county-commissioner", canonical_name: "County Commissioner" }],
          },
        }) as never
      );

      const result = await learned.resolve({
        scope: "county",
        districtName: district,
        state,
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBeNull();
      expect(result.method).toBe("none");
    }
  });

  it("keeps ordinary county commission seats on County Commissioner", async () => {
    const matcher = new OfficeMatcher(createAlabamaTaxOfficeClient({ withAliases: true }) as never);

    for (const title of [
      "Member, Lee County Commission, District No. 2",
      "Lee County Commissioner",
      "Lee County Board of Commissioners District 4",
    ]) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Lee County, Alabama",
        state: "AL",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });

      expect(result.officeId).toBe("office-county-commissioner");
    }
  });

  it("resolves prosecutor titles carrying an 'of <County> County' phrase and a numbered judicial circuit", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          { office_id: "office-district-attorney", normalized_alias: "prosecuting attorney" },
          { office_id: "office-district-attorney", normalized_alias: "district attorney" },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-district-attorney", canonical_name: "District Attorney" },
          { id: "office-county-level-judge", canonical_name: "County Level Judge" },
          { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Indiana titles every county prosecutor this way; the "of <County> County"
    // phrase plus the ordinal circuit previously scored 0.250 and blocked the
    // contest in every Indiana county.
    const indiana = await matcher.resolve({
      scope: "county",
      districtName: "Elkhart County, Indiana",
      state: "IN",
      officialBallotTitle: "Prosecuting Attorney of Elkhart County, 34th Judicial Circuit",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(indiana).toMatchObject({
      officeId: "office-district-attorney",
      method: "alias_exact",
    });

    const withCourtSuffix = await matcher.resolve({
      scope: "county",
      districtName: "Caddo Parish, Louisiana",
      state: "LA",
      officialBallotTitle: "District Attorney, 1st Judicial District Court",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(withCourtSuffix.officeId).toBe("office-district-attorney");

    // The "of <jurisdiction>" strip must not swallow an office's own words:
    // this title keeps "Clerk of the Circuit Court" and only loses the county.
    const clerkOfCircuitCourt = await matcher.resolve({
      scope: "county",
      districtName: "Cook County, Illinois",
      state: "IL",
      officialBallotTitle: "Clerk of the Circuit Court of Cook County",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(clerkOfCircuitCourt.officeId).toBe("office-clerk-of-court");

    // The jurisdiction strip must not fire when the county phrase names the
    // governing body that follows it: taking "of Cook County" here left
    // "member board of commissioners", which mis-scored into a different
    // county board office.
    const bodyForm = await matcher.resolve({
      scope: "county",
      districtName: "Cook County, Illinois",
      state: "IL",
      officialBallotTitle: "Member of Cook County Board of Commissioners",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(bodyForm.officeId).toBe("office-county-commissioner");

    // A judge OF that circuit is still a judgeship.
    const circuitJudge = await matcher.resolve({
      scope: "county",
      districtName: "Elkhart County, Indiana",
      state: "IN",
      officialBallotTitle: "Judge of the 34th Judicial Circuit",
      discoveryContestFamily: "judicial_office",
    });
    expect(circuitJudge.officeId).toBe("office-county-level-judge");
  });

  it("resolves Florida's 'State Attorney' circuit title to District Attorney", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          // Migration 219 adds "state attorney"; "state s attorney" (migration
          // 184, Maryland/Illinois) is a different normalized key and does not
          // cover Florida's non-possessive form.
          { office_id: "office-district-attorney", normalized_alias: "state attorney" },
          { office_id: "office-district-attorney", normalized_alias: "state s attorney" },
          { office_id: "office-district-attorney", normalized_alias: "district attorney" },
          { office_id: "office-public-defender", normalized_alias: "public defender" },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-district-attorney", canonical_name: "District Attorney" },
          { id: "office-public-defender", canonical_name: "Public Defender" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Florida elects its felony prosecutor by judicial circuit, so one circuit
    // spans several counties (the 4th covers Duval, Clay and Nassau). The
    // circuit strip reduces the title to "state attorney", which scores 0.500
    // against "District Attorney" — under the floor — so the alias is what
    // carries it.
    const stateAttorney = await matcher.resolve({
      scope: "county",
      districtName: "Duval County, Florida",
      state: "FL",
      officialBallotTitle: "State Attorney, 4th Judicial Circuit",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(stateAttorney).toMatchObject({
      officeId: "office-district-attorney",
      method: "alias_exact",
      aliasMemoryKey: "state attorney",
    });

    // Florida elects a Public Defender on the same circuits; it was checked for
    // the same catalog gap and does not have one. Asserted here so the new
    // prosecutor alias cannot pull the defense-side office onto District
    // Attorney, which carries a research-area set the defender must not get.
    const publicDefender = await matcher.resolve({
      scope: "county",
      districtName: "Duval County, Florida",
      state: "FL",
      officialBallotTitle: "Public Defender, 4th Judicial Circuit",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(publicDefender).toMatchObject({
      officeId: "office-public-defender",
      method: "alias_exact",
      aliasMemoryKey: "public defender",
    });
  });

  it("routes a Louisiana city marshal to its own office instead of the place judge", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [
          { office_id: "office-city-marshal", normalized_alias: normalizeElectionTitleKey("City Marshal") },
          { office_id: "office-place-judge", normalized_alias: normalizeElectionTitleKey("Municipal Judge") },
        ],
      },
      officesByScope: {
        place: [
          { id: "office-city-marshal", canonical_name: "City Marshal" },
          { id: "office-place-judge", canonical_name: "Place Level Judge" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // The title names the court the marshal serves, which is what used to
    // trip the judicial fast path into Place Level Judge at confidence 1.
    for (const title of [
      "City Marshal, City Court of Shreveport",
      "Marshal, City Court of Shreveport",
    ]) {
      const result = await matcher.resolve({
        scope: "place",
        districtName: "Shreveport, Louisiana",
        state: "LA",
        officialBallotTitle: title,
        discoveryContestFamily: "judicial_office",
      });
      expect(result.officeId, title).toBe("office-city-marshal");
    }

    // The judge seat on the same court is untouched.
    const judge = await matcher.resolve({
      scope: "place",
      districtName: "Shreveport, Louisiana",
      state: "LA",
      officialBallotTitle: "City Judge, Shreveport City Court",
      discoveryContestFamily: "judicial_office",
    });
    expect(judge.officeId).toBe("office-place-judge");
  });

  it("refuses a marshal title that names neither a city nor a court", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        place: [
          { office_id: "office-city-marshal", normalized_alias: normalizeElectionTitleKey("City Marshal") },
        ],
      },
      officesByScope: {
        place: [
          { id: "office-city-marshal", canonical_name: "City Marshal" },
          { id: "office-place-judge", canonical_name: "Place Level Judge" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Indiana and Colorado call the town's chief police officer a "Marshal" —
    // a different job, which this office's voter-facing summary would
    // misdescribe. There is deliberately no bare "Marshal" alias either.
    for (const title of ["Marshal", "Town Marshal", "Village Marshal"]) {
      const result = await matcher.resolve({
        scope: "place",
        districtName: "Zionsville, Indiana",
        state: "IN",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBeNull();
      expect(result.shouldPersistAlias, title).toBe(false);
    }
  });

  it("refuses the judge fast path for a marshal title when no marshal office exists", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { place: [] },
      officesByScope: {
        place: [{ id: "office-place-judge", canonical_name: "Place Level Judge" }],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const result = await matcher.resolve({
      scope: "place",
      districtName: "Shreveport, Louisiana",
      state: "LA",
      officialBallotTitle: "City Marshal, City Court of Shreveport",
      discoveryContestFamily: "judicial_office",
    });

    // A loud no-match is recoverable — the researcher excludes and defers.
    // A confident wrong office writes and mis-files every later stage.
    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("refuses an office whose canonical name lacks the title's own function noun", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
          { id: "office-county-assessor", canonical_name: "County Assessor" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Alabama's consolidated assessor/collector: two of three tokens shared
    // with County Commissioner scored 0.800 before the guard.
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Baldwin County, Alabama",
      state: "AL",
      officialBallotTitle: "County Revenue Commissioner",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(result.officeId).toBeNull();
    expect(result.method).toBe("none");
    expect(result.shouldPersistAlias).toBe(false);
  });

  it("matches the revenue commissioner office once the catalog carries it", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: {
        county: [
          {
            office_id: "office-revenue-commissioner",
            normalized_alias: normalizeElectionTitleKey("Revenue Commissioner"),
          },
        ],
      },
      officesByScope: {
        county: [
          { id: "office-revenue-commissioner", canonical_name: "Revenue Commissioner" },
          { id: "office-county-commissioner", canonical_name: "County Commissioner" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    const revenue = await matcher.resolve({
      scope: "county",
      districtName: "Baldwin County, Alabama",
      state: "AL",
      officialBallotTitle: "Revenue Commissioner, Baldwin County, Alabama",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(revenue.officeId).toBe("office-revenue-commissioner");

    // The office it used to collide with still resolves.
    const commissioner = await matcher.resolve({
      scope: "county",
      districtName: "Baldwin County, Alabama",
      state: "AL",
      officialBallotTitle: "County Commissioner District 2",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(commissioner.officeId).toBe("office-county-commissioner");
  });

  it("keeps a combined office in the running when it covers one of the title's function nouns", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-sheriff", canonical_name: "Sheriff" },
          { id: "office-coroner", canonical_name: "County Coroner" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // California counties elect a combined "Sheriff-Coroner". A covers-ALL test
    // vetoed both halves and returned no match; the veto is meant for an office
    // the catalog is MISSING, not one it has, so covering one noun is enough.
    for (const title of ["Sheriff-Coroner", "Sheriff/Coroner"]) {
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Riverside County, California",
        state: "CA",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBe("office-sheriff");
    }
  });

  it("keeps offices whose state synonym differs from the title's wording", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { county: [] },
      officesByScope: {
        county: [
          { id: "office-clerk-and-recorder", canonical_name: "County Clerk and Recorder" },
          { id: "office-county-clerk", canonical_name: "County Clerk" },
          { id: "office-county-auditor", canonical_name: "County Auditor" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // Idaho and Utah fold the auditor and recorder into the clerk's office;
    // "auditor" and "recorder" are therefore NOT function nouns that veto.
    const result = await matcher.resolve({
      scope: "county",
      districtName: "Ada County, Idaho",
      state: "ID",
      officialBallotTitle: "Clerk, Auditor and Recorder",
      discoveryContestFamily: "non_judicial_office",
    });
    expect(result.officeId).toBe("office-clerk-and-recorder");
  });

  it("strips a letter-designated seat the same way it strips a numbered one", async () => {
    const client = createMatcherDataClient({
      aliasesByScope: { place: [] },
      officesByScope: {
        place: [
          { id: "office-city-council", canonical_name: "City Council Member" },
          { id: "office-mayor", canonical_name: "Mayor" },
        ],
      },
    });
    const matcher = new OfficeMatcher(client as never);

    // New Orleans and Shreveport run council districts A-E; before the letter
    // was consumed the stray token dropped these to no-match while the
    // numbered form resolved.
    for (const title of [
      "Council Member, District A",
      "Councilmember District B",
      "Council Member for District D",
      "City Council District E",
      "City Council Seat C",
      "City Council Ward B",
    ]) {
      const result = await matcher.resolve({
        scope: "place",
        districtName: "New Orleans, Louisiana",
        state: "LA",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBe("office-city-council");
    }
  });

  describe("county board seats vs the Board of Review", () => {
    const countyOffices = [
      { id: "office-supervisor", canonical_name: "County Supervisor" },
      { id: "office-review", canonical_name: "County Board of Review Member" },
      { id: "office-commissioner", canonical_name: "County Commissioner" },
    ];

    it("sends Illinois, Virginia and New York county board seats to County Supervisor", async () => {
      const matcher = new OfficeMatcher(
        createMatcherDataClient({ aliasesByScope: { county: [] }, officesByScope: { county: countyOffices } }) as never
      );
      const cases: Array<[string, string, string]> = [
        ["County Board Member #10", "Sangamon County, Illinois", "IL"],
        ["DeKalb County Board Member - District 5 (2-year unexpired term)", "DeKalb County, Illinois", "IL"],
        ["Knox County Board District 1", "Knox County, Illinois", "IL"],
        ["Jasper County Board District 1, 2-Year Term", "Jasper County, Illinois", "IL"],
        ["Stephenson County Board B District Member", "Stephenson County, Illinois", "IL"],
        ["Vermilion County Board Members", "Vermilion County, Illinois", "IL"],
        ["Powhatan County Board of Supervisors District 5 Special Election", "Powhatan County, Virginia", "VA"],
        ["Lewis County Board of Legislators District 1", "Lewis County, New York", "NY"],
      ];
      for (const [title, districtName, state] of cases) {
        const result = await matcher.resolve({
          scope: "county",
          districtName,
          state,
          officialBallotTitle: title,
          discoveryContestFamily: "non_judicial_office",
        });
        expect(result.officeId, title).toBe("office-supervisor");
      }
    });

    it("keeps real Board of Review titles on the Board of Review", async () => {
      const matcher = new OfficeMatcher(
        createMatcherDataClient({ aliasesByScope: { county: [] }, officesByScope: { county: countyOffices } }) as never
      );
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Vermilion County, Illinois",
        state: "IL",
        officialBallotTitle: "Vermilion County Board of Review Members",
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId).toBe("office-review");
    });

    it("never scores a non-review title into the Board of Review", async () => {
      const matcher = new OfficeMatcher(
        createMatcherDataClient({ aliasesByScope: { county: [] }, officesByScope: { county: countyOffices } }) as never
      );
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Kiowa County, Kansas",
        state: "KS",
        officialBallotTitle: "Kiowa County Hospital Board",
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId).not.toBe("office-review");
    });

    it("ignores a learned Board of Review alias for a title without 'review'", async () => {
      const client = createMatcherDataClient({
        aliasesByScope: {
          county: [{ office_id: "office-review", normalized_alias: normalizeElectionTitleKey("County Board Member #10") }],
        },
        officesByScope: { county: countyOffices },
      });
      const matcher = new OfficeMatcher(client as never);
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Sangamon County, Illinois",
        state: "IL",
        officialBallotTitle: "County Board Member #10",
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId).toBe("office-supervisor");
      expect(result.method).not.toBe("alias_exact");
    });

    it("leaves other 'County Board of ...' bodies alone, whatever separates the words", async () => {
      const matcher = new OfficeMatcher(
        createMatcherDataClient({ aliasesByScope: { county: [] }, officesByScope: { county: countyOffices } }) as never
      );
      const cases: Array<[string, string, string]> = [
        ["Member of Cook County Board of Commissioners", "Cook County, Illinois", "IL"],
        ["Alamance County Board of Commissioners District 02", "Alamance County, North Carolina", "NC"],
        ["Alamance County Board  of Commissioners District 02", "Alamance County, North Carolina", "NC"],
        ["Alamance County Board-of-Commissioners District 02", "Alamance County, North Carolina", "NC"],
        ["Alamance County Board\tof Commissioners District 02", "Alamance County, North Carolina", "NC"],
      ];
      for (const [title, districtName, state] of cases) {
        const result = await matcher.resolve({
          scope: "county",
          districtName,
          state,
          officialBallotTitle: title,
          discoveryContestFamily: "non_judicial_office",
        });
        expect(result.officeId, JSON.stringify(title)).toBe("office-commissioner");
      }
    });
  });

  describe("NULL-office repairs from the Nov 2026 records sweep", () => {
    const aliasRow = (officeId: string, aliasText: string) => ({
      office_id: officeId,
      normalized_alias: normalizeElectionTitleKey(aliasText),
    });
    const makeMatcher = () =>
      new OfficeMatcher(
        createMatcherDataClient({
          aliasesByScope: {
            county: [
              aliasRow("office-county-supervisor", "County Council Member"),
              aliasRow("office-district-attorney", "State's Attorney"),
              aliasRow("office-clerk-of-court", "Register of Wills"),
              aliasRow("office-county-recorder", "Register of Deeds"),
              aliasRow("office-county-assessor", "Property Valuation Administrator"),
              aliasRow("office-county-commissioner", "Chairman County Commission"),
              aliasRow("office-county-commissioner", "President County Commission"),
              aliasRow("office-water-sewer", "Water and Sewer Commissioner"),
            ],
          },
          officesByScope: {
            county: [
              { id: "office-county-supervisor", canonical_name: "County Supervisor" },
              { id: "office-county-commissioner", canonical_name: "County Commissioner" },
              { id: "office-county-executive", canonical_name: "County Executive" },
              { id: "office-district-attorney", canonical_name: "District Attorney" },
              { id: "office-clerk-of-court", canonical_name: "Clerk of Court" },
              { id: "office-county-recorder", canonical_name: "County Recorder" },
              { id: "office-county-assessor", canonical_name: "County Assessor" },
              { id: "office-county-treasurer", canonical_name: "County Treasurer" },
              { id: "office-water-sewer", canonical_name: "Water and Sewer Commissioner" },
            ],
          },
        }) as never
      );

    it("resolves the live titles that wrote NULL-office shells", async () => {
      const matcher = makeMatcher();
      const cases: Array<[string, string, string, string]> = [
        ["Maui County, Hawaii", "HI", "Maui County Councilmember - Lanai", "office-county-supervisor"],
        ["Maui County, Hawaii", "HI", "Maui County Councilmember - Makawao-Haiku-Paia", "office-county-supervisor"],
        ["Maui County, Hawaii", "HI", "Maui County Councilmember - West Maui", "office-county-supervisor"],
        ["Washington County, Maryland", "MD", "State's Attorney, Washington County", "office-district-attorney"],
        ["Washington County, Maryland", "MD", "Register of Wills, Washington County", "office-clerk-of-court"],
        ["Penobscot County, Maine", "ME", "Register of Deeds, Penobscot County", "office-county-recorder"],
        ["Aroostook County, Maine", "ME", "Register of Deeds, Northern District", "office-county-recorder"],
        ["Aroostook County, Maine", "ME", "Register of Deeds, Southern District", "office-county-recorder"],
        ["Boone County, Kentucky", "KY", "Property Valuation Administrator, Boone County", "office-county-assessor"],
        ["St. Clair County, Alabama", "AL", "Chairman, St. Clair County Commission", "office-county-commissioner"],
        ["DeKalb County, Alabama", "AL", "President, DeKalb County Commission", "office-county-commissioner"],
        [
          "Glynn County, Georgia",
          "GA",
          "Brunswick-Glynn County Joint Water & Sewer Commissioner, At Large Post 2",
          "office-water-sewer",
        ],
      ];
      for (const [districtName, state, officialBallotTitle, expected] of cases) {
        const result = await matcher.resolve({
          scope: "county",
          districtName,
          state,
          officialBallotTitle,
          discoveryContestFamily: "non_judicial_office",
        });
        expect(result.officeId, officialBallotTitle).toBe(expected);
      }
    });

    it("leaves leadership dash seats and non-board utility roles unmatched", async () => {
      const matcher = makeMatcher();
      // The short utility forms matter: the long Brunswick-Glynn name alone
      // pulls the token score under the floor, so only the bare ones prove the
      // scoring guard.
      for (const officialBallotTitle of [
        "Maui County Councilmember - Chair",
        "Treasurer, Brunswick-Glynn County Joint Water & Sewer Commission",
        "Treasurer, Water and Sewer Commission",
        "Water and Sewer Board Clerk",
        "Water and Sewer Commission Secretary",
      ]) {
        const result = await matcher.resolve({
          scope: "county",
          districtName: officialBallotTitle.startsWith("Maui") ? "Maui County, Hawaii" : "Glynn County, Georgia",
          state: officialBallotTitle.startsWith("Maui") ? "HI" : "GA",
          officialBallotTitle,
          discoveryContestFamily: "non_judicial_office",
        });
        expect(result.officeId, officialBallotTitle).not.toBe("office-county-supervisor");
        expect(result.officeId, officialBallotTitle).not.toBe("office-water-sewer");
      }
    });

    it("drops a trailing civic word only when the title ends with the district's own name", async () => {
      const matcher = makeMatcher();
      // "Register of Wills, Frederick County" filed on the Washington County row
      // is not this county's jurisdiction phrase, so the fallback must not fire.
      const result = await matcher.resolve({
        scope: "county",
        districtName: "Washington County, Maryland",
        state: "MD",
        officialBallotTitle: "Register of Wills, Frederick County",
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.method).not.toBe("alias_exact");
    });
  });
});
