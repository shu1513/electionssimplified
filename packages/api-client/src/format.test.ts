import { describe, expect, it } from "vitest";
import {
  buildResultChipParts,
  competitivenessChip,
  financeSourceLabel,
  formatDistrictName,
  formatDistrictType,
  formatElectionDate,
  formatFinanceCategory,
  formatMoney,
  formatNameList,
  formatOutcome,
  formatOutsideEvidenceLines,
  formatResultChipLabel,
  formatRosterStatus,
  resultChipTone,
  formatSourceHost,
  formatVotePowerLabel,
  formatWinnerNames,
  groupSourcesByHost,
  sortContributionSizeBuckets,
} from "./format";
import type { FinanceOutsideIndustryEvidence } from "./types";

describe("formatElectionDate", () => {
  it("renders YYYY-MM-DD as a local calendar date without timezone drift", () => {
    // new Date("2026-11-03") would be UTC midnight = Nov 2 in US timezones.
    expect(formatElectionDate("2026-11-03")).toBe("November 3, 2026");
  });

  it("passes through unparseable values", () => {
    expect(formatElectionDate("TBD")).toBe("TBD");
  });
});

describe("competitivenessChip", () => {
  const historical = {
    display_label: "Historically competitive",
    display_description: "Based on the 2024 Governor result.",
    source: "MIT_2024",
    source_url: null,
    election_year: 2024,
    margin_percent: 8.4,
    competitiveness_label: "competitive",
    stale_after_redistricting: false,
  };
  const current = {
    display_label: "Currently a toss-up",
    display_description: "Based on current race ratings from Inside Elections as of August 6, 2026.",
    competitiveness_label: "toss_up",
    method: "outlet_consensus",
    confidence: "medium",
    as_of: "2026-08-06",
  };

  it("prefers the current-cycle rating over the historic one", () => {
    expect(competitivenessChip({ current_competitiveness: current, historical_competitiveness: historical })).toEqual({
      label: "Currently a toss-up",
      description: current.display_description,
    });
    expect(competitivenessChip({ historical_competitiveness: historical })).toEqual({
      label: "Historically competitive",
      description: historical.display_description,
    });
  });

  it("renders nothing for the safe tier or when no rating exists", () => {
    expect(competitivenessChip({ historical_competitiveness: null })).toBeNull();
    expect(
      competitivenessChip({ historical_competitiveness: { ...historical, competitiveness_label: "safe" } })
    ).toBeNull();
    // A safe current rating hides the chip even when the historic one was close.
    expect(
      competitivenessChip({
        current_competitiveness: { ...current, competitiveness_label: "safe" },
        historical_competitiveness: historical,
      })
    ).toBeNull();
  });
});

describe("formatRosterStatus", () => {
  it("includes the re-check date only when present", () => {
    expect(formatRosterStatus({ reason: "awaiting_official_roster", check_after: "2026-08-27" })).toEqual({
      short: "Candidate list not final",
      long: "We haven't found a final candidate list from election officials for this race yet. We'll check again after August 27, 2026.",
    });
    expect(formatRosterStatus({ reason: "awaiting_official_roster", check_after: null }).long).toBe(
      "We haven't found a final candidate list from election officials for this race yet."
    );
  });

  it("describes staged rosters as processing", () => {
    expect(formatRosterStatus({ reason: "roster_processing", check_after: null })).toEqual({
      short: "Candidate details coming soon",
      long: "A candidate list is available — candidate profiles are being prepared.",
    });
  });

  it("falls back to unavailable copy for the generic and unknown reasons", () => {
    const unavailable = {
      short: "Candidate list unavailable",
      long: "Candidate information for this race isn't available yet.",
    };
    expect(formatRosterStatus({ reason: "candidate_information_unavailable", check_after: null })).toEqual(
      unavailable
    );
    // Forward-compat: a newer backend may add reasons this client predates.
    expect(formatRosterStatus({ reason: "some_future_reason", check_after: null })).toEqual(unavailable);
  });
});

describe("formatMoney", () => {
  it("formats whole dollars and dashes null", () => {
    expect(formatMoney(1234567)).toBe("$1,234,567");
    expect(formatMoney(null)).toBe("—");
  });
});

describe("formatDistrictType", () => {
  it("maps known types and humanizes unknown ones", () => {
    expect(formatDistrictType("state_upper")).toBe("State senate district");
    expect(formatDistrictType("us_house")).toBe("U.S. House district");
    expect(formatDistrictType("water_board_zone")).toBe("water board zone");
  });
});

describe("formatDistrictName", () => {
  it("strips the redistricting-vintage year, wherever it sits", () => {
    expect(formatDistrictName("Assembly District 54 (2024); California")).toBe(
      "Assembly District 54; California"
    );
    expect(formatDistrictName("State House District 1 (2024); Alaska")).toBe(
      "State House District 1; Alaska"
    );
    expect(formatDistrictName("City of Pleasantville")).toBe("City of Pleasantville");
    // A parenthetical that is not a year must survive.
    expect(formatDistrictName("Ward 3 (at-large); Ohio")).toBe("Ward 3 (at-large); Ohio");
  });

  it("strips the Congress vintage on U.S. House districts", () => {
    expect(formatDistrictName("Congressional District 1 (119th Congress), Kentucky")).toBe(
      "Congressional District 1, Kentucky"
    );
    expect(formatDistrictName("Congressional District 22 (120th Congress), Texas")).toBe(
      "Congressional District 22, Texas"
    );
    expect(formatDistrictName("Congressional District (at Large) (119th Congress), Alaska")).toBe(
      "Congressional District (at Large), Alaska"
    );
    // County disambiguators on places are identity, not vintage.
    expect(formatDistrictName("Franklin city (Simpson County), Kentucky")).toBe(
      "Franklin city (Simpson County), Kentucky"
    );
  });
});

describe("formatSourceHost", () => {
  it("extracts the hostname and strips www", () => {
    expect(formatSourceHost("https://www.capitol.texas.gov/BillLookup/History.aspx?Bill=SB2")).toBe(
      "capitol.texas.gov"
    );
    expect(formatSourceHost("not a url")).toBe("not a url");
  });
});

describe("groupSourcesByHost", () => {
  it("names each host once in first-seen order and keeps every distinct URL", () => {
    expect(
      groupSourcesByHost([
        "https://elections.ny.gov/certification-2026",
        "https://ballotpedia.org/New_York",
        "https://elections.ny.gov/certification-2026",
        "https://www.elections.ny.gov/ballot-certifications",
      ])
    ).toEqual([
      {
        host: "elections.ny.gov",
        urls: ["https://elections.ny.gov/certification-2026", "https://www.elections.ny.gov/ballot-certifications"],
      },
      { host: "ballotpedia.org", urls: ["https://ballotpedia.org/New_York"] },
    ]);
    expect(groupSourcesByHost([])).toEqual([]);
  });
});

describe("formatVotePowerLabel", () => {
  it("maps known labels and passes unknown ones through untouched", () => {
    expect(formatVotePowerLabel("very_low")).toBe("Very low");
    // "Low" reads as a verdict on the voter; the chip says "Below average".
    expect(formatVotePowerLabel("low")).toBe("Below average");
    // "Medium" is a size word; it ships as "Average" (the statewide baseline).
    expect(formatVotePowerLabel("medium")).toBe("Average");
    expect(formatVotePowerLabel("above_average")).toBe("Above average");
    expect(formatVotePowerLabel("unknown")).toBe("Unknown");
    expect(formatVotePowerLabel("super_high")).toBe("super_high");
  });
});

describe("formatOutcome", () => {
  it("sentence-cases snake_case outcomes", () => {
    expect(formatOutcome("too_close")).toBe("Too close");
    expect(formatOutcome("won")).toBe("Won");
  });

  it("returns empty or whitespace-only input unchanged", () => {
    expect(formatOutcome("")).toBe("");
    expect(formatOutcome("  ")).toBe("  ");
    expect(formatOutcome("___")).toBe("___");
  });
});

describe("formatFinanceCategory", () => {
  it("maps known industry slugs to display names", () => {
    expect(formatFinanceCategory("oil_gas_energy")).toBe("Oil, gas, and energy");
    expect(formatFinanceCategory("labor_unions")).toBe("Labor unions");
  });

  it("sentence-cases unknown slugs", () => {
    expect(formatFinanceCategory("crypto_assets")).toBe("Crypto assets");
  });

  it("passes free-text occupation names through unchanged", () => {
    expect(formatFinanceCategory("Retired")).toBe("Retired");
    expect(formatFinanceCategory("Software Engineer")).toBe("Software Engineer");
  });
});

describe("financeSourceLabel", () => {
  it("maps known source enums to display names", () => {
    expect(financeSourceLabel("FEC")).toBe("FEC");
    expect(financeSourceLabel("MASSACHUSETTS_OCPF")).toBe("Massachusetts OCPF");
    expect(financeSourceLabel("UTAH_DISCLOSURES")).toBe("Utah Financial Disclosures");
    expect(financeSourceLabel("NEW_YORK_CITY_CFB")).toBe("NYC Campaign Finance Board");
    expect(financeSourceLabel("OHIO_SOS")).toBe("Ohio Secretary of State");
    expect(financeSourceLabel("NORTH_CAROLINA_SBE")).toBe("North Carolina State Board of Elections");
    expect(financeSourceLabel("GEORGIA_ETHICS")).toBe("Georgia Ethics Commission");
    expect(financeSourceLabel("MISSOURI_MEC")).toBe("Missouri Ethics Commission");
    expect(financeSourceLabel("MONTANA_COPP")).toBe("Montana Commissioner of Political Practices");
    expect(financeSourceLabel("ALABAMA_FCPA")).toBe("Alabama FCPA Reporting System");
    expect(financeSourceLabel("ARKANSAS_CFIS")).toBe("Arkansas Secretary of State");
    expect(financeSourceLabel("WEST_VIRGINIA_CFRS")).toBe("West Virginia Campaign Finance Reporting System");
    expect(financeSourceLabel("NORTH_DAKOTA_CFRS")).toBe("North Dakota Campaign Finance Reporting System");
    expect(financeSourceLabel("DELAWARE_CFRS")).toBe("Delaware Campaign Finance Reporting System");
    expect(financeSourceLabel("NEVADA_AURORA")).toBe("Nevada Secretary of State");
    expect(financeSourceLabel("NEW_HAMPSHIRE_CFS")).toBe("New Hampshire Campaign Finance System");
    expect(financeSourceLabel("IDAHO_SUNSHINE")).toBe("Idaho Secretary of State Sunshine Portal");
    expect(financeSourceLabel("KANSAS_SOS")).toBe("Kansas Secretary of State");
    expect(financeSourceLabel("MISSISSIPPI_SOS")).toBe("Mississippi Secretary of State");
    expect(financeSourceLabel("RHODE_ISLAND_ERTS")).toBe("Rhode Island Board of Elections");
    expect(financeSourceLabel("SOUTH_CAROLINA_CAMPAIGN_FINANCE")).toBe("South Carolina State Ethics Commission");
    expect(financeSourceLabel("SAN_FRANCISCO_ETHICS")).toBe("San Francisco Ethics Commission");
    expect(financeSourceLabel("PHOENIX_CITY_CLERK")).toBe("City of Phoenix City Clerk Department");
    expect(financeSourceLabel("SAN_DIEGO_CITY_CLERK")).toBe("City of San Diego Office of the City Clerk");
    expect(financeSourceLabel("SAN_JOSE_CITY_CLERK")).toBe("City of San José Office of the City Clerk");
    expect(financeSourceLabel("HOUSTON_CAMPAIGN_FINANCE")).toBe("City of Houston / Texas Ethics Commission");
    expect(financeSourceLabel("AUSTIN_CITY_CLERK")).toBe("Austin City Clerk");
    expect(financeSourceLabel("DENVER_CLERK_RECORDER")).toBe("Denver Office of the Clerk and Recorder");
  });

  it("title-cases unknown enums instead of leaking raw values", () => {
    expect(financeSourceLabel("NEW_STATE_PORTAL")).toBe("New State Portal");
  });
});

describe("formatNameList", () => {
  it("joins one, two, and three-plus names with Oxford-comma grammar", () => {
    expect(formatNameList(["Google"])).toBe("Google");
    expect(formatNameList(["Google", "Anthropic"])).toBe("Google and Anthropic");
    expect(formatNameList(["Google", "Anthropic", "Amazon"])).toBe("Google, Anthropic, and Amazon");
  });

  it("drops duplicates and whitespace-only entries, returning '' when nothing survives", () => {
    expect(formatNameList(["Google", " Google", "Google "])).toBe("Google");
    expect(formatNameList(["  ", "", "\t"])).toBe("");
    expect(formatNameList([])).toBe("");
  });
});

describe("sortContributionSizeBuckets", () => {
  it("orders buckets largest-first by the leading dollar amount", () => {
    const rows = [
      { category_name: "$1-$99" },
      { category_name: "$5,000+" },
      { category_name: "$500-$999" },
      { category_name: "$1,000-$4,999" },
    ];
    expect(sortContributionSizeBuckets(rows).map((row) => row.category_name)).toEqual([
      "$5,000+",
      "$1,000-$4,999",
      "$500-$999",
      "$1-$99",
    ]);
  });

  it("keeps unparseable labels last in their original relative order", () => {
    const rows = [
      { category_name: "Unitemized" },
      { category_name: "$100-$499" },
      { category_name: "Other receipts" },
      { category_name: "$5,000+" },
    ];
    expect(sortContributionSizeBuckets(rows).map((row) => row.category_name)).toEqual([
      "$5,000+",
      "$100-$499",
      "Unitemized",
      "Other receipts",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [{ category_name: "$1-$99" }, { category_name: "$5,000+" }];
    sortContributionSizeBuckets(rows);
    expect(rows.map((row) => row.category_name)).toEqual(["$1-$99", "$5,000+"]);
  });
});

describe("formatOutsideEvidenceLines", () => {
  const evidence = (overrides: Partial<FinanceOutsideIndustryEvidence>): FinanceOutsideIndustryEvidence => ({
    organization_name: "Google",
    organization_type: "donor",
    amount: 1000,
    contributor_count: null,
    committee_id: "pac-1",
    committee_name: "Growth PAC",
    source_url: null,
    ...overrides,
  });

  it("presents donor rows as the organization's own money", () => {
    expect(formatOutsideEvidenceLines([evidence({})])).toEqual(["Money from Google, given to Growth PAC."]);
  });

  it("presents employer rows as contributors' money, never the company's", () => {
    expect(formatOutsideEvidenceLines([evidence({ organization_type: "employer" })])).toEqual([
      "Money from contributors employed by Google, given to Growth PAC.",
    ]);
  });

  it("combines donor and employer rows for one committee in a single line", () => {
    expect(
      formatOutsideEvidenceLines([
        evidence({}),
        evidence({ organization_name: "Anthropic", organization_type: "employer" }),
      ])
    ).toEqual(["Money from Google, and from contributors employed by Anthropic, given to Growth PAC."]);
  });

  it("keeps each organization paired with its own committee across lines", () => {
    expect(
      formatOutsideEvidenceLines([
        evidence({}),
        evidence({
          organization_name: "Anthropic",
          organization_type: "employer",
          committee_id: "pac-2",
          committee_name: "Future PAC",
        }),
      ])
    ).toEqual([
      "Money from Google, given to Growth PAC.",
      "Money from contributors employed by Anthropic, given to Future PAC.",
    ]);
  });

  it("returns no lines for empty or name-less evidence", () => {
    expect(formatOutsideEvidenceLines([])).toEqual([]);
    expect(formatOutsideEvidenceLines([evidence({ organization_name: "  " })])).toEqual([]);
  });
});

describe("formatWinnerNames", () => {
  it("joins names with parties, dropping nameless entries", () => {
    expect(
      formatWinnerNames([
        { candidate_name: "Jocelyn Benson", party: "Democratic" },
        { candidate_name: "John James", party: "Republican" },
        { party: "Green" },
      ])
    ).toBe("Jocelyn Benson (Democratic), John James (Republican)");
  });

  it("omits the party when absent and returns empty for nothing", () => {
    expect(formatWinnerNames([{ candidate_name: "Dana Reyes" }])).toBe("Dana Reyes");
    expect(formatWinnerNames([])).toBe("");
  });
});

describe("formatResultChipLabel", () => {
  it("names the winners on decisive outcomes", () => {
    expect(
      formatResultChipLabel("advanced", [
        { candidate_name: "Jocelyn Benson", party: "Democratic" },
        { candidate_name: "John James", party: "Republican" },
      ])
    ).toBe("Result: Advanced — Jocelyn Benson (Democratic), John James (Republican)");
  });

  it("suppresses names on a non-decisive outcome", () => {
    // The contract permits winners on a too_close row (a recorded leader);
    // "Result: Too close — Jane Smith" would read as calling the race.
    expect(formatResultChipLabel("too_close", [{ candidate_name: "Jane Smith" }])).toBe(
      "Result: Too close"
    );
  });

  it("falls back to the outcome alone with no named winners", () => {
    expect(formatResultChipLabel("passed", [])).toBe("Result: Passed");
    expect(formatResultChipLabel("won", [{ party: "Independent" }])).toBe("Result: Won");
  });
});

describe("buildResultChipParts", () => {
  const WINNERS = [
    { candidate_id: "c-1", candidate_name: "Jocelyn Benson", party: "Democratic" },
    { candidate_id: "c-2", candidate_name: "John James", party: "Republican" },
  ];

  it("marks the viewer's pick among the winners and offers the advanced marker", () => {
    const parts = buildResultChipParts("advanced", WINNERS, new Set(["c-1"]));
    expect(parts.heading).toBe("Result: Advanced");
    expect(parts.winners).toEqual([
      { label: "Jocelyn Benson (Democratic)", isMyPick: true },
      { label: "John James (Republican)", isMyPick: false },
    ]);
    expect(parts.myPickMarker).toBe("My pick advanced ✓");
  });

  it('says "won" only when the outcome claims the seat', () => {
    expect(buildResultChipParts("won", WINNERS, new Set(["c-1"])).myPickMarker).toBe("My pick won ✓");
    // A runoff berth is a round forward, not the seat.
    expect(buildResultChipParts("runoff", WINNERS, new Set(["c-1"])).myPickMarker).toBe(
      "My pick advanced ✓"
    );
  });

  it("stays silent when the pick is not among the winners", () => {
    // A losing pick gets nothing — no marker, no flag.
    const parts = buildResultChipParts("advanced", WINNERS, new Set(["c-9"]));
    expect(parts.winners.every((winner) => !winner.isMyPick)).toBe(true);
    expect(parts.myPickMarker).toBe(null);
  });

  it("never marks a non-decisive outcome, even when the pick leads", () => {
    // too_close rows may carry a recorded leader; a marker there would call
    // the race for the viewer's pick.
    const parts = buildResultChipParts("too_close", WINNERS, new Set(["c-1"]));
    expect(parts.winners).toEqual([]);
    expect(parts.myPickMarker).toBe(null);
  });

  it("matches by candidate id only, and drops nameless winners", () => {
    const parts = buildResultChipParts(
      "won",
      [{ candidate_id: "c-1", party: "Independent" }, { candidate_name: "Jocelyn Benson" }],
      new Set(["c-1"])
    );
    // The id-matched winner is nameless (dropped), and the named winner has
    // no id — neither can claim the marker. Deliberate, not an oversight:
    // the marker renders inline after its winner's name, so a nameless
    // winner gives it no anchor — and the id-with-no-name shape is
    // unproducible anyway (the result matcher's toMatchedWinner backfills
    // the roster display name in the same assignment that sets
    // candidate_id). See the myPickMarker comment in buildResultChipParts.
    expect(parts.winners).toEqual([{ label: "Jocelyn Benson", isMyPick: false }]);
    expect(parts.myPickMarker).toBe(null);
  });

  it("agrees with formatResultChipLabel when no pick set is given", () => {
    const parts = buildResultChipParts("advanced", WINNERS);
    expect(`${parts.heading} — ${parts.winners.map((winner) => winner.label).join(", ")}`).toBe(
      formatResultChipLabel("advanced", WINNERS)
    );
  });
});

describe("resultChipTone", () => {
  it("greens decided-forward outcomes, reds failed, neutrals the undecided", () => {
    expect(resultChipTone("won")).toBe("positive");
    expect(resultChipTone("advanced")).toBe("positive");
    expect(resultChipTone("runoff")).toBe("positive");
    expect(resultChipTone("passed")).toBe("positive");
    expect(resultChipTone("failed")).toBe("negative");
    expect(resultChipTone("too_close")).toBe("neutral");
    expect(resultChipTone("unknown")).toBe("neutral");
    expect(resultChipTone(null)).toBe("neutral");
  });
});
