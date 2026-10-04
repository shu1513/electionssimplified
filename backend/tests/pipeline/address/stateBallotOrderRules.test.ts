import { describe, expect, it } from "vitest";

import { stateBaselineContestRank } from "../../../src/pipeline/address/ballotContestRank.js";
import {
  OVERRIDDEN_COUNTY_FIPS,
  OVERRIDDEN_STATE_FIPS,
  printedBallotTitle,
  stateBallotContestRank,
  withinTierOfficeRank,
  type StateRankableElection,
} from "../../../src/pipeline/address/stateBallotOrderRules.js";

type InputOverrides = {
  state_fips?: string;
  election_stage?: string | null;
  election_date?: string;
  race_type?: string;
  contest_family?: string | null;
  office_scope?: string | null;
  district_type?: string;
  title?: string;
  is_partisan?: boolean | null;
};

function input(overrides: InputOverrides): StateRankableElection {
  return {
    official_ballot_title: overrides.title ?? "Office Title",
    race_type: (overrides.race_type ?? "office") as StateRankableElection["race_type"],
    election_stage: (overrides.election_stage === undefined
      ? "general"
      : overrides.election_stage) as StateRankableElection["election_stage"],
    election_date: overrides.election_date ?? "2026-11-03",
    is_partisan: overrides.is_partisan === undefined ? true : overrides.is_partisan,
    discovery_contest_family: (overrides.contest_family ??
      (overrides.race_type === "ballot_measure"
        ? "ballot_measure"
        : "non_judicial_office")) as StateRankableElection["discovery_contest_family"],
    district: {
      id: "11111111-1111-4111-8111-111111111111",
      district_type: (overrides.district_type ??
        "county") as StateRankableElection["district"]["district_type"],
      geoid_compact: "99999",
      name: "Test District",
      state: "XX",
      state_fips: overrides.state_fips ?? "42",
      representation_power_score: null,
      population: null,
    },
    office:
      overrides.office_scope === null || overrides.race_type === "ballot_measure"
        ? null
        : {
            id: "12121212-1212-4212-8212-121212121212",
            scope: (overrides.office_scope ??
              "county") as NonNullable<StateRankableElection["office"]>["scope"],
            canonical_name: "Office",
            summary: "",
          },
  };
}

// Rank under the given state's general-election rules.
function rank(state_fips: string, overrides: InputOverrides): number {
  return stateBallotContestRank(input({ ...overrides, state_fips }));
}

// Common probe contests, one per baseline tier plus judicial/measure
// variants — used by the gate and no-row sweeps to compare full profiles.
const PROBES: InputOverrides[] = [
  { office_scope: "presidential", title: "President of the United States" },
  { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" },
  { office_scope: "us_house", title: "Representative in Congress" },
  { office_scope: "statewide", title: "Governor" },
  { office_scope: "statewide", title: "Secretary of State" },
  { office_scope: "state_upper", title: "State Senator" },
  { office_scope: "state_lower", title: "State Representative" },
  { office_scope: "county", title: "County Commissioner" },
  { office_scope: "place", title: "Mayor" },
  { office_scope: "school_unified", title: "School Board Member" },
  { office_scope: "statewide", contest_family: "judicial_office", title: "Justice of the Supreme Court" },
  { office_scope: "statewide", contest_family: "judicial_office", title: "Judge of the Court of Appeals" },
  { office_scope: "county", contest_family: "judicial_office", title: "Circuit Court Judge" },
  { office_scope: "place", contest_family: "judicial_office", title: "Municipal Court Judge" },
  { race_type: "ballot_measure", office_scope: null, district_type: "statewide", title: "Amendment 1" },
  { race_type: "ballot_measure", office_scope: null, district_type: "county", title: "County Question 1" },
  { race_type: "ballot_measure", office_scope: null, district_type: "place", title: "City Question 1" },
];

describe("stateBallotContestRank gating", () => {
  it("applies overrides to stage-less, runoff, and special rows that share a date with a general contest", () => {
    // Measures and retention questions carry no stage; a top-two runoff is
    // stored as `runoff`. All of them print on the general ballot.
    const context = { generalDates: new Set(["2026-11-03"]) };
    for (const fips of OVERRIDDEN_STATE_FIPS) {
      for (const probe of PROBES) {
        const asGeneral = rank(fips, probe);
        for (const stage of ["runoff", "special", null]) {
          const row = input({ ...probe, state_fips: fips, election_stage: stage });
          expect(stateBallotContestRank(row, context)).toBe(asGeneral);
          // A different date on the same ballot does not qualify.
          expect(stateBallotContestRank({ ...row, election_date: "2026-12-01" }, context)).toBe(
            stateBaselineContestRank(row)
          );
        }
        // A primary never takes the general-election order.
        const primary = input({ ...probe, state_fips: fips, election_stage: "primary" });
        expect(stateBallotContestRank(primary, context)).toBe(stateBaselineContestRank(primary));
      }
    }
  });

  it("applies overrides only when election_stage is 'general'", () => {
    for (const fips of OVERRIDDEN_STATE_FIPS) {
      for (const probe of PROBES) {
        const baseline = stateBaselineContestRank(input(probe));
        for (const stage of ["primary", "runoff", "special", null]) {
          expect(rank(fips, { ...probe, election_stage: stage })).toBe(baseline);
        }
      }
    }
  });

  it("every override entry moves at least one probe contest on a general", () => {
    // Guards against dead entries (a rule that never fires is either a typo'd
    // FIPS key or an encoding mistake). The sweep probes a presidential-year
    // date so presidential contests are in play.
    for (const fips of OVERRIDDEN_STATE_FIPS) {
      const moved = PROBES.some((probe) => {
        const generalRank = rank(fips, { ...probe, election_date: "2028-11-07" });
        return generalRank !== stateBaselineContestRank(input({ ...probe, election_date: "2028-11-07" }));
      });
      expect(moved, `override for FIPS ${fips} never fires`).toBe(true);
    }
  });

  it("falls back to the baseline for states without an entry", () => {
    // States whose printed order matches the baseline (ID, DE, RI, CO, WV,
    // ND), AR (no confirmed order yet) — plus a FIPS with no entry at all.
    const NO_ROW_FIPS = ["16", "05", "10", "44", "08", "54", "38", "72"];
    for (const fips of NO_ROW_FIPS) {
      expect(OVERRIDDEN_STATE_FIPS).not.toContain(fips);
      for (const probe of PROBES) {
        expect(rank(fips, probe)).toBe(stateBaselineContestRank(input(probe)));
      }
    }
  });
});

describe("per-state deviations", () => {
  it("AL: Governor/LtGov above US Senate; appellate after legislature; trial before county", () => {
    expect(rank("01", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("01", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    expect(rank("01", { office_scope: "statewide", title: "Lieutenant Governor" })).toBeLessThan(
      rank("01", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    // Attorney General keeps the baseline slot after US House.
    expect(rank("01", { office_scope: "statewide", title: "Attorney General" })).toBe(
      stateBaselineContestRank(input({ office_scope: "statewide", title: "Attorney General" }))
    );
    const supreme = rank("01", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Chief Justice of the Supreme Court",
    });
    expect(supreme).toBeGreaterThan(rank("01", { office_scope: "state_lower", title: "State Representative" }));
    const trial = rank("01", { office_scope: "county", contest_family: "judicial_office", title: "Circuit Judge" });
    expect(trial).toBeGreaterThan(supreme);
    expect(trial).toBeLessThan(rank("01", { office_scope: "county", title: "County Commission" }));
  });

  it("AZ: only Governor precedes the legislature; retention opens the nonpartisan tail; municipal last", () => {
    const governor = rank("04", { office_scope: "statewide", title: "Governor" });
    const sos = rank("04", { office_scope: "statewide", title: "Secretary of State" });
    expect(governor).toBeLessThan(rank("04", { office_scope: "state_upper", title: "State Senator" }));
    expect(sos).toBeGreaterThan(rank("04", { office_scope: "state_lower", title: "State Representative" }));
    const retention = rank("04", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(retention).toBeGreaterThan(rank("04", { office_scope: "county", title: "County Recorder" }));
    expect(retention).toBeLessThan(rank("04", { office_scope: "school_unified", title: "School Board" }));
    // Municipal after school, before measures.
    const city = rank("04", { office_scope: "place", title: "City Councilmember" });
    expect(city).toBeGreaterThan(rank("04", { office_scope: "school_unified", title: "School Board" }));
    expect(city).toBeLessThan(rank("04", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" }));
    // Superior Court RETENTION (county-scoped) joins the nonpartisan-opening
    // judicial block; JP/constable close the partisan section after county.
    const superiorRetention = rank("04", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "Judge of the Pinal County Superior Court (Retention)",
    });
    expect(superiorRetention).toBeGreaterThan(retention);
    expect(superiorRetention).toBeLessThan(rank("04", { office_scope: "school_unified", title: "School Board" }));
    const jp = rank("04", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "Justice of the Peace, Prec. 1",
    });
    expect(jp).toBeGreaterThan(rank("04", { office_scope: "county", title: "County Recorder" }));
    expect(jp).toBeLessThan(retention);
    // Contested Superior Court placement is A-excluded: it stays baseline.
    expect(rank("04", { office_scope: "county", contest_family: "judicial_office", title: "Superior Court Judge" })).toBe(
      stateBaselineContestRank(
        input({ office_scope: "county", contest_family: "judicial_office", title: "Superior Court Judge" })
      )
    );
  });

  it("CA: executives before US Senate; judicial after legislature; school before county and city", () => {
    expect(rank("06", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("06", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const judge = rank("06", { office_scope: "county", contest_family: "judicial_office", title: "Superior Court Judge" });
    expect(judge).toBeGreaterThan(rank("06", { office_scope: "state_lower", title: "Member of the State Assembly" }));
    // Superintendent of Public Instruction (statewide-scoped office) heads
    // the SCHOOL block instead of joining the executive run (§ 13109(j)).
    const superintendent = rank("06", { office_scope: "statewide", title: "Superintendent of Public Instruction" });
    expect(superintendent).toBeGreaterThan(
      rank("06", { office_scope: "county", contest_family: "judicial_office", title: "Superior Court Judge" })
    );
    const schoolBoard = rank("06", { office_scope: "school_unified", title: "Governing Board Member" });
    expect(superintendent).toBeLessThan(schoolBoard);
    expect(judge).toBeLessThan(schoolBoard);
    expect(schoolBoard).toBeLessThan(rank("06", { office_scope: "county", title: "Board of Supervisors" }));
    expect(schoolBoard).toBeLessThan(rank("06", { office_scope: "place", title: "City Council" }));
  });

  it("CT: Gov/LtGov above US Senate; remaining executives below the legislature; probate judge last office", () => {
    expect(rank("09", { office_scope: "statewide", title: "Governor and Lieutenant Governor" })).toBeLessThan(
      rank("09", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const treasurer = rank("09", { office_scope: "statewide", title: "Treasurer" });
    expect(treasurer).toBeGreaterThan(rank("09", { office_scope: "state_lower", title: "State Representative" }));
    const probate = rank("09", { office_scope: "place", contest_family: "judicial_office", title: "Judge of Probate" });
    expect(probate).toBeGreaterThan(treasurer);
    expect(probate).toBeLessThan(rank("09", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" }));
  });

  it("DC: shadow US Senator/Representative print late; the Delegate keeps the federal slot", () => {
    // Real scopes from the data: the Delegate is titled "United States
    // Representative, DC At-Large" on the us_house district; Mayor rides
    // the place-scoped city district; AG is statewide.
    const delegate = rank("11", { office_scope: "us_house", title: "United States Representative, DC At-Large" });
    const mayor = rank("11", { office_scope: "place", title: "Mayor of the District of Columbia" });
    const chairman = rank("11", { office_scope: "statewide", title: "Chairman of the Council" });
    const atLargeCouncil = rank("11", { office_scope: "statewide", title: "At-Large Member of the Council" });
    const wardCouncil = rank("11", { office_scope: "place", title: "Member of the Council Ward 3" });
    const attorneyGeneral = rank("11", { office_scope: "statewide", title: "Attorney General" });
    const shadowSenator = rank("11", {
      office_scope: "statewide",
      contest_family: "us_senate",
      title: "United States Senator",
    });
    const shadowRep = rank("11", { office_scope: "statewide", title: "United States Representative" });
    // § 1202.1 (b) -> (c) -> (d) -> (e) -> (f) -> (g) -> (h) -> (i)
    expect(delegate).toBeLessThan(mayor);
    expect(mayor).toBeLessThan(chairman);
    expect(chairman).toBeLessThan(atLargeCouncil);
    expect(atLargeCouncil).toBeLessThan(wardCouncil);
    expect(wardCouncil).toBeLessThan(attorneyGeneral);
    expect(attorneyGeneral).toBeLessThan(shadowSenator);
    expect(shadowSenator).toBeLessThan(shadowRep);
    // (j)/(k) SBOE after the shadow offices, regardless of modeled scope,
    // then (l) ANC as the final office block before measures.
    const sboe = rank("11", { office_scope: "statewide", title: "At-Large Member of the State Board of Education" });
    const anc = rank("11", { office_scope: "place", title: "Advisory Neighborhood Commissioner 3B01" });
    expect(sboe).toBeGreaterThan(shadowRep);
    expect(anc).toBeGreaterThan(sboe);
    expect(anc).toBeLessThan(
      rank("11", { race_type: "ballot_measure", office_scope: null, district_type: "statewide", title: "Initiative 83" })
    );
  });

  it("FL: the judicial section prints before school board", () => {
    const judge = rank("12", { office_scope: "county", contest_family: "judicial_office", title: "Circuit Judge" });
    expect(judge).toBeGreaterThan(rank("12", { office_scope: "place", title: "City Council" }));
    expect(judge).toBeLessThan(rank("12", { office_scope: "school_unified", title: "School Board" }));
  });

  it("HI: OHA trustees between state house and county; county charter questions after state amendments", () => {
    const oha = rank("15", { office_scope: "statewide", title: "Office of Hawaiian Affairs Trustee, At-Large" });
    expect(oha).toBeGreaterThan(rank("15", { office_scope: "state_lower", title: "State Representative" }));
    expect(oha).toBeLessThan(rank("15", { office_scope: "county", title: "Councilmember" }));
    // Non-OHA statewide contests keep the baseline slot.
    expect(rank("15", { office_scope: "statewide", title: "Governor" })).toBe(
      stateBaselineContestRank(input({ office_scope: "statewide", title: "Governor" }))
    );
    expect(rank("15", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeLessThan(
      rank("15", { race_type: "ballot_measure", office_scope: null, district_type: "county" })
    );
  });

  it("IL: statewide measures first; executives before US House; school after judicial", () => {
    expect(rank("17", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeLessThan(
      rank("17", { office_scope: "presidential", title: "President" })
    );
    // Local referenda still last.
    expect(rank("17", { race_type: "ballot_measure", office_scope: null, district_type: "place" })).toBeGreaterThan(
      rank("17", { office_scope: "school_unified", title: "Board of Education" })
    );
    const governor = rank("17", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeGreaterThan(
      rank("17", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    expect(governor).toBeLessThan(rank("17", { office_scope: "us_house", title: "Representative in Congress" }));
    expect(rank("17", { office_scope: "school_unified", title: "Board of Education" })).toBeGreaterThan(
      rank("17", { office_scope: "county", contest_family: "judicial_office", title: "Judge of the Circuit Court" })
    );
  });

  it("IN: questions first; executives before US House; trial courts early, retention dead last", () => {
    expect(rank("18", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeLessThan(
      rank("18", { race_type: "ballot_measure", office_scope: null, district_type: "county" })
    );
    expect(rank("18", { race_type: "ballot_measure", office_scope: null, district_type: "county" })).toBeLessThan(
      rank("18", { office_scope: "presidential", title: "President" })
    );
    const governor = rank("18", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeLessThan(rank("18", { office_scope: "us_house", title: "Representative in Congress" }));
    const trial = rank("18", { office_scope: "county", contest_family: "judicial_office", title: "Judge of the Circuit Court" });
    expect(trial).toBeGreaterThan(rank("18", { office_scope: "state_lower", title: "State Representative" }));
    expect(trial).toBeLessThan(rank("18", { office_scope: "county", title: "County Auditor" }));
    const retention = rank("18", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(retention).toBeGreaterThan(rank("18", { office_scope: "school_unified", title: "School Board" }));
    // Authorized LOCAL retentions (county-scoped) join the same dead-last
    // block instead of the early contested-court block.
    const localRetention = rank("18", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "Marion Superior Court (Retention) - Angela Davis",
    });
    expect(localRetention).toBeGreaterThan(rank("18", { office_scope: "school_unified", title: "School Board" }));
  });

  it("IA: retention after the township/special tier; measures state -> county -> city", () => {
    const retention = rank("19", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(retention).toBeGreaterThan(stateBaselineContestRank(input({ office_scope: "something_new" })));
    expect(retention).toBeLessThan(rank("19", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" }));
    expect(rank("19", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeLessThan(
      rank("19", { race_type: "ballot_measure", office_scope: null, district_type: "county" })
    );
    expect(rank("19", { race_type: "ballot_measure", office_scope: null, district_type: "county" })).toBeLessThan(
      rank("19", { race_type: "ballot_measure", office_scope: null, district_type: "place" })
    );
  });

  it("KS: partisan district judges between state house and county; retention stays late", () => {
    const districtJudge = rank("20", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "District Court Judge",
    });
    expect(districtJudge).toBeGreaterThan(rank("20", { office_scope: "state_lower", title: "State Representative" }));
    expect(districtJudge).toBeLessThan(rank("20", { office_scope: "county", title: "County Clerk" }));
    expect(
      rank("20", { office_scope: "statewide", contest_family: "judicial_office", title: "Justice of the Supreme Court" })
    ).toBe(
      stateBaselineContestRank(
        input({ office_scope: "statewide", contest_family: "judicial_office", title: "Justice of the Supreme Court" })
      )
    );
    // Nonpartisan-district RETENTION questions (county-scoped) are
    // card-structure dependent (A-excluded) — they stay baseline too.
    expect(
      rank("20", {
        office_scope: "county",
        contest_family: "judicial_office",
        title: "District Court Judge Retention, Third Judicial District",
      })
    ).toBe(
      stateBaselineContestRank(
        input({
          office_scope: "county",
          contest_family: "judicial_office",
          title: "District Court Judge Retention, Third Judicial District",
        })
      )
    );
  });

  it("LA: executives above US Senate; appellate in the state block; trial atop the parish block; school before municipal", () => {
    expect(rank("22", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("22", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const appellate = rank("22", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Judge, Court of Appeal",
    });
    expect(appellate).toBeGreaterThan(rank("22", { office_scope: "us_house", title: "United States Representative" }));
    expect(appellate).toBeLessThan(rank("22", { office_scope: "state_upper", title: "State Senator" }));
    const trial = rank("22", { office_scope: "county", contest_family: "judicial_office", title: "District Judge" });
    expect(trial).toBeLessThan(rank("22", { office_scope: "county", title: "Sheriff" }));
    const schoolBoard = rank("22", { office_scope: "school_unified", title: "School Board Member" });
    expect(schoolBoard).toBeGreaterThan(rank("22", { office_scope: "county", title: "Sheriff" }));
    expect(schoolBoard).toBeLessThan(rank("22", { office_scope: "place", title: "Mayor" }));
  });

  it("ME: Governor between US Senate and US House; probate judge heads the county block", () => {
    const governor = rank("23", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeGreaterThan(
      rank("23", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    expect(governor).toBeLessThan(rank("23", { office_scope: "us_house", title: "Representative to Congress" }));
    const probate = rank("23", { office_scope: "county", contest_family: "judicial_office", title: "Judge of Probate" });
    expect(probate).toBeGreaterThan(rank("23", { office_scope: "state_lower", title: "State Representative" }));
    expect(probate).toBeLessThan(rank("23", { office_scope: "county", title: "Sheriff" }));
  });

  it("MD: executives above US Senate; judicial mid-ballot with trial before Supreme before Appellate", () => {
    expect(rank("24", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("24", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const circuit = rank("24", { office_scope: "county", contest_family: "judicial_office", title: "Judge of the Circuit Court" });
    const supreme = rank("24", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court of Maryland",
    });
    const appellate = rank("24", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Judge of the Appellate Court of Maryland",
    });
    expect(circuit).toBeLessThan(supreme);
    expect(supreme).toBeLessThan(appellate);
    expect(appellate).toBeLessThan(rank("24", { office_scope: "county", title: "County Executive" }));
    expect(circuit).toBeGreaterThan(rank("24", { office_scope: "state_lower", title: "State Delegate" }));
  });

  it("MA: executives between US Senate and US House", () => {
    const governor = rank("25", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeGreaterThan(
      rank("25", { office_scope: "statewide", contest_family: "us_senate", title: "Senator in Congress" })
    );
    expect(governor).toBeLessThan(rank("25", { office_scope: "us_house", title: "Representative in Congress" }));
  });

  it("MI: Gov/SOS/AG before US Senate, education boards after the legislature; judicial before school", () => {
    expect(rank("26", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("26", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const regent = rank("26", { office_scope: "statewide", title: "Regent of the University of Michigan" });
    expect(regent).toBeGreaterThan(rank("26", { office_scope: "state_lower", title: "State Representative" }));
    expect(regent).toBeLessThan(rank("26", { office_scope: "county", title: "County Commissioner" }));
    const wsuGovernor = rank("26", { office_scope: "statewide", title: "Governor of Wayne State University" });
    expect(wsuGovernor).toBe(regent);
    const judge = rank("26", { office_scope: "county", contest_family: "judicial_office", title: "Judge of Circuit Court" });
    expect(judge).toBeGreaterThan(rank("26", { office_scope: "place", title: "City Council" }));
    expect(judge).toBeLessThan(rank("26", { office_scope: "school_unified", title: "Board of Education" }));
  });

  it("MN: legislature before executives; statewide amendments before county; judicial dead last", () => {
    const governor = rank("27", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeGreaterThan(rank("27", { office_scope: "state_lower", title: "State Representative" }));
    const amendment = rank("27", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" });
    expect(amendment).toBeGreaterThan(governor);
    expect(amendment).toBeLessThan(rank("27", { office_scope: "county", title: "County Commissioner" }));
    const judge = rank("27", { office_scope: "county", contest_family: "judicial_office", title: "Judge, District Court" });
    expect(judge).toBeGreaterThan(rank("27", { race_type: "ballot_measure", office_scope: null, district_type: "place" }));
  });

  it("MT: judicial between executives and legislature; JP is the last county office", () => {
    const supreme = rank("30", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(supreme).toBeGreaterThan(rank("30", { office_scope: "statewide", title: "Governor" }));
    expect(supreme).toBeLessThan(rank("30", { office_scope: "state_upper", title: "State Senator" }));
    const jp = rank("30", { office_scope: "county", contest_family: "judicial_office", title: "Justice of the Peace" });
    expect(jp).toBeGreaterThan(rank("30", { office_scope: "county", title: "County Commissioner" }));
    expect(jp).toBeLessThan(rank("30", { office_scope: "place", title: "Mayor" }));
  });

  it("NE: the statewide-measure ballot comes last, after local measures", () => {
    expect(rank("31", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeGreaterThan(
      rank("31", { race_type: "ballot_measure", office_scope: null, district_type: "place" })
    );
  });

  it("NV: judicial early, school after judicial before municipal, JPs last among offices", () => {
    const district = rank("32", { office_scope: "county", contest_family: "judicial_office", title: "District Court Judge" });
    expect(district).toBeGreaterThan(rank("32", { office_scope: "county", title: "County Commissioner" }));
    const schoolBoard = rank("32", { office_scope: "school_unified", title: "School Board Trustee" });
    expect(schoolBoard).toBeGreaterThan(district);
    expect(schoolBoard).toBeLessThan(rank("32", { office_scope: "place", title: "City Council" }));
    // JPs are county-scoped in the data (township districts are unmodeled):
    // the title keeps them last among offices, after the city contests.
    const jp = rank("32", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "JUSTICE OF THE PEACE, PAHRUMP, DEPT. B",
    });
    expect(jp).toBeGreaterThan(rank("32", { office_scope: "place", title: "City Council" }));
    expect(jp).toBeLessThan(rank("32", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" }));
  });

  it("NH: Governor in slot 2, before US Senate", () => {
    const governor = rank("33", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeGreaterThan(rank("33", { office_scope: "presidential", title: "President" }));
    expect(governor).toBeLessThan(
      rank("33", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
  });

  it("NJ: measures run statewide -> municipal -> county", () => {
    const statewide = rank("34", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" });
    const municipal = rank("34", { race_type: "ballot_measure", office_scope: null, district_type: "place" });
    const county = rank("34", { race_type: "ballot_measure", office_scope: null, district_type: "county" });
    expect(statewide).toBeLessThan(municipal);
    expect(municipal).toBeLessThan(county);
  });

  it("NM: partisan judicial before county; retention leads the question block", () => {
    const presYear = { election_date: "2028-11-07" };
    const partisanJudge = rank("35", {
      ...presYear,
      office_scope: "county",
      contest_family: "judicial_office",
      title: "Judge of the District Court",
    });
    expect(partisanJudge).toBeGreaterThan(rank("35", { ...presYear, office_scope: "state_lower", title: "State Representative" }));
    expect(partisanJudge).toBeLessThan(rank("35", { ...presYear, office_scope: "county", title: "County Clerk" }));
    const retention = rank("35", {
      ...presYear,
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Judicial Retention - Court of Appeals",
    });
    expect(retention).toBeGreaterThan(rank("35", { ...presYear, office_scope: "county", title: "County Clerk" }));
    expect(retention).toBeLessThan(
      rank("35", { ...presYear, race_type: "ballot_measure", office_scope: null, district_type: "statewide" })
    );
    // The standard question wording counts as retention too (shared matcher).
    const questionForm = rank("35", {
      ...presYear,
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Shall J. Miles Hanisee be retained as a Judge of the Court of Appeals?",
    });
    expect(questionForm).toBe(retention);
    // Gubernatorial years print the same shape (Santa Fe County Nov 2026).
    expect(
      rank("35", {
        election_date: "2026-11-03",
        office_scope: "county",
        contest_family: "judicial_office",
        title: "Judge of the District Court",
      })
    ).toBeLessThan(rank("35", { election_date: "2026-11-03", office_scope: "county", title: "County Sheriff" }));
  });

  it("NC: appellate courts before the legislature; trial courts between state house and county", () => {
    const appellate = rank("37", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Judge of the Court of Appeals",
    });
    expect(appellate).toBeGreaterThan(rank("37", { office_scope: "statewide", title: "Commissioner of Agriculture" }));
    expect(appellate).toBeLessThan(rank("37", { office_scope: "state_upper", title: "State Senator" }));
    const trial = rank("37", { office_scope: "county", contest_family: "judicial_office", title: "District Court Judge" });
    expect(trial).toBeGreaterThan(rank("37", { office_scope: "state_lower", title: "State Representative" }));
    expect(trial).toBeLessThan(rank("37", { office_scope: "county", title: "Register of Deeds" }));
  });

  it("OH: executives then Supreme Court then US Senate; appeals then trial courts after state house, before county", () => {
    const governor = rank("39", { office_scope: "statewide", title: "Governor and Lieutenant Governor" });
    const supreme = rank("39", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    const senate = rank("39", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" });
    expect(governor).toBeLessThan(supreme);
    expect(supreme).toBeLessThan(senate);
    const appeals = rank("39", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Judge of the Court of Appeals",
    });
    expect(appeals).toBeGreaterThan(rank("39", { office_scope: "state_lower", title: "State Representative" }));
    expect(appeals).toBeLessThan(rank("39", { office_scope: "county", title: "County Auditor" }));
    const trial = rank("39", { office_scope: "county", contest_family: "judicial_office", title: "Judge of the Court of Common Pleas" });
    expect(trial).toBeGreaterThan(appeals);
    expect(trial).toBeLessThan(rank("39", { office_scope: "county", title: "County Commissioner" }));
  });

  it("OK: executives before US Senate; trial then appellate retention after county, before State Questions", () => {
    expect(rank("40", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("40", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const trial = rank("40", { office_scope: "county", contest_family: "judicial_office", title: "District Judge" });
    const retention = rank("40", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(trial).toBeGreaterThan(rank("40", { office_scope: "county", title: "County Commissioner" }));
    expect(retention).toBeGreaterThan(trial);
    expect(retention).toBeLessThan(rank("40", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" }));
  });

  it("OR: judicial before county and city contests", () => {
    const judge = rank("41", { office_scope: "county", contest_family: "judicial_office", title: "Judge of the Circuit Court" });
    expect(judge).toBeGreaterThan(rank("41", { office_scope: "state_lower", title: "State Representative" }));
    expect(judge).toBeLessThan(rank("41", { office_scope: "county", title: "County Commissioner" }));
  });

  it("SC: executives above US Senate; nothing below the executive move is encoded", () => {
    expect(rank("45", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("45", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    // County-and-below is A-excluded (county-arranged, grade B).
    expect(rank("45", { office_scope: "county", contest_family: "judicial_office", title: "Probate Judge" })).toBe(
      stateBaselineContestRank(
        input({ office_scope: "county", contest_family: "judicial_office", title: "Probate Judge" })
      )
    );
  });

  it("SD: county questions after statewide measures", () => {
    expect(rank("46", { race_type: "ballot_measure", office_scope: null, district_type: "county" })).toBeGreaterThan(
      rank("46", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })
    );
  });

  it("TN: Governor slot 2; state amendments right behind; judicial after state house; school inside the county block", () => {
    const governor = rank("47", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeLessThan(
      rank("47", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    const amendment = rank("47", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" });
    expect(amendment).toBeGreaterThan(governor);
    expect(amendment).toBeLessThan(
      rank("47", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    // Local questions still trail.
    expect(rank("47", { race_type: "ballot_measure", office_scope: null, district_type: "county" })).toBeGreaterThan(
      rank("47", { office_scope: "place", title: "City Council" })
    );
    const supreme = rank("47", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(supreme).toBeGreaterThan(rank("47", { office_scope: "state_lower", title: "State Representative" }));
    expect(supreme).toBeLessThan(rank("47", { office_scope: "county", title: "County Commission" }));
    // County-scoped judicial splits by class: circuit/chancery/criminal
    // courts join the early block after the state house; general sessions
    // and juvenile judges ride behind the county line.
    const circuit = rank("47", { office_scope: "county", contest_family: "judicial_office", title: "Circuit Court Judge, Division 2" });
    expect(circuit).toBeGreaterThan(rank("47", { office_scope: "state_lower", title: "State Representative" }));
    expect(circuit).toBeLessThan(rank("47", { office_scope: "county", title: "County Commission" }));
    const generalSessions = rank("47", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "General Sessions Court Judge, Division 2",
    });
    expect(generalSessions).toBeGreaterThan(rank("47", { office_scope: "county", title: "County Commission" }));
    expect(generalSessions).toBeLessThan(rank("47", { office_scope: "place", title: "City Council" }));
    // § 2-5-208(c)(3): retention questions go to the END of the ballot,
    // after every office but ahead of the other (local) questions.
    const retentionQuestion = rank("47", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Shall Sarah K. Campbell be retained as a Justice of the Supreme Court?",
    });
    expect(retentionQuestion).toBeGreaterThan(rank("47", { office_scope: "place", title: "City Council" }));
    expect(retentionQuestion).toBeLessThan(
      rank("47", { race_type: "ballot_measure", office_scope: null, district_type: "county" })
    );
    const schoolBoard = rank("47", { office_scope: "school_unified", title: "School Board Member" });
    expect(schoolBoard).toBeGreaterThan(rank("47", { office_scope: "county", title: "County Commission" }));
    expect(schoolBoard).toBeLessThan(rank("47", { office_scope: "place", title: "City Council" }));
  });

  it("TX: judicial within level at every tier", () => {
    const supreme = rank("48", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice, Supreme Court",
    });
    expect(supreme).toBeGreaterThan(rank("48", { office_scope: "statewide", title: "Railroad Commissioner" }));
    expect(supreme).toBeLessThan(rank("48", { office_scope: "state_upper", title: "State Senator" }));
    // District judges arrive county-scoped (no judicial-district scope
    // exists); the title split sends them to the after-state-house slot.
    const district = rank("48", {
      office_scope: "county",
      contest_family: "judicial_office",
      title: "District Judge, 218th Judicial District",
    });
    expect(district).toBeGreaterThan(rank("48", { office_scope: "state_lower", title: "State Representative" }));
    expect(district).toBeLessThan(rank("48", { office_scope: "county", title: "County Clerk" }));
    // County courts lead the county block — and stay behind district courts.
    const countyCourt = rank("48", { office_scope: "county", contest_family: "judicial_office", title: "Judge, County Court at Law" });
    expect(countyCourt).toBeGreaterThan(district);
    expect(countyCourt).toBeLessThan(rank("48", { office_scope: "county", title: "County Clerk" }));
    // JPs are county-scoped precinct offices: after every county office,
    // before municipal.
    const jp = rank("48", { office_scope: "county", contest_family: "judicial_office", title: "Justice of the Peace, Precinct 1" });
    expect(jp).toBeGreaterThan(rank("48", { office_scope: "county", title: "County Clerk" }));
    expect(jp).toBeLessThan(rank("48", { office_scope: "place", title: "Mayor" }));
    // DA/JP/constable also surface under the NON-judicial discovery family —
    // the title checks must fire either way.
    const constable = rank("48", { office_scope: "county", title: "Rockwall County Constable, Precinct 3" });
    expect(constable).toBe(jp);
    const da = rank("48", { office_scope: "county", title: "Van Zandt County Criminal District Attorney" });
    expect(da).toBe(district);
  });

  it("UT: school board at the end of the county block; retention after every candidate contest", () => {
    const schoolBoard = rank("49", { office_scope: "school_unified", title: "Local School Board" });
    expect(schoolBoard).toBeGreaterThan(rank("49", { office_scope: "county", title: "County Council" }));
    expect(schoolBoard).toBeLessThan(rank("49", { office_scope: "place", title: "City Council" }));
    const retention = rank("49", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(retention).toBeGreaterThan(stateBaselineContestRank(input({ office_scope: "something_new" })));
    expect(retention).toBeLessThan(rank("49", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" }));
  });

  it("VT: statewide measures first; probate and assistant judges lead the county block; JP stays baseline", () => {
    expect(rank("50", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeLessThan(
      rank("50", { office_scope: "presidential", title: "President" })
    );
    const probate = rank("50", { office_scope: "county", contest_family: "judicial_office", title: "Judge of Probate" });
    expect(probate).toBeGreaterThan(rank("50", { office_scope: "state_lower", title: "State Representative" }));
    expect(probate).toBeLessThan(rank("50", { office_scope: "county", title: "High Bailiff" }));
    // JP-last-among-offices is A-excluded; the baseline place-judicial slot stands.
    expect(rank("50", { office_scope: "place", contest_family: "judicial_office", title: "Justice of the Peace" })).toBe(
      stateBaselineContestRank(
        input({ office_scope: "place", contest_family: "judicial_office", title: "Justice of the Peace" })
      )
    );
  });

  it("VA: school board inside the locality blocks; statewide measures before local", () => {
    const schoolBoard = rank("51", { office_scope: "school_unified", title: "School Board At Large" });
    expect(schoolBoard).toBeGreaterThan(rank("51", { office_scope: "place", title: "City Council" }));
    expect(schoolBoard).toBeLessThan(stateBaselineContestRank(input({ office_scope: "school_unified" })));
    expect(rank("51", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" })).toBeLessThan(
      rank("51", { race_type: "ballot_measure", office_scope: null, district_type: "county" })
    );
  });

  it("WA: measures first (state then local); judicial after county before municipal", () => {
    const stateMeasure = rank("53", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" });
    const countyMeasure = rank("53", { race_type: "ballot_measure", office_scope: null, district_type: "county" });
    expect(stateMeasure).toBeLessThan(countyMeasure);
    expect(countyMeasure).toBeLessThan(rank("53", { office_scope: "presidential", title: "President" }));
    const judge = rank("53", { office_scope: "county", contest_family: "judicial_office", title: "Judge of the Superior Court" });
    expect(judge).toBeGreaterThan(rank("53", { office_scope: "county", title: "County Assessor" }));
    expect(judge).toBeLessThan(rank("53", { office_scope: "place", title: "City Council" }));
  });

  it("WI: executives above US Senate", () => {
    expect(rank("55", { office_scope: "statewide", title: "Governor" })).toBeLessThan(
      rank("55", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
  });

  it("WY: judicial retention after county, before municipal and school", () => {
    const retention = rank("56", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Justice of the Supreme Court",
    });
    expect(retention).toBeGreaterThan(rank("56", { office_scope: "county", title: "County Commissioner" }));
    expect(retention).toBeLessThan(rank("56", { office_scope: "place", title: "Mayor" }));
    expect(retention).toBeLessThan(rank("56", { office_scope: "school_unified", title: "School Board" }));
  });
});

describe("orders confirmed on printed November 2026 ballots", () => {
  it("PA: statewide executives between US Senate and US House", () => {
    const governor = rank("42", { office_scope: "statewide", title: "Governor and Lieutenant Governor" });
    expect(governor).toBeGreaterThan(
      rank("42", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    expect(governor).toBeLessThan(rank("42", { office_scope: "us_house", title: "Representative in Congress" }));
  });

  it("KY: judges and school boards after county offices, city offices after both", () => {
    const county = rank("21", { office_scope: "county", title: "Sheriff" });
    const judge = rank("21", { office_scope: "county", contest_family: "judicial_office", title: "District Judge" });
    const schoolBoard = rank("21", { office_scope: "school_unified", title: "Board of Education Member" });
    const city = rank("21", { office_scope: "place", title: "Mayor" });
    expect(judge).toBeGreaterThan(county);
    expect(schoolBoard).toBeGreaterThan(judge);
    expect(city).toBeGreaterThan(schoolBoard);
  });

  it("MO: statewide executives before US House", () => {
    expect(rank("29", { office_scope: "statewide", title: "State Auditor" })).toBeLessThan(
      rank("29", { office_scope: "us_house", title: "United States Representative" })
    );
  });

  it("NE: the Legislature prints after the county ticket, before city offices", () => {
    const legislature = rank("31", { office_scope: "state_upper", title: "For Member of the Legislature" });
    expect(legislature).toBeGreaterThan(rank("31", { office_scope: "county", title: "County Sheriff" }));
    expect(legislature).toBeLessThan(rank("31", { office_scope: "place", title: "City Council" }));
  });

  it("MS: judges after the legislature, before county and school contests", () => {
    const judge = rank("28", { office_scope: "county", contest_family: "judicial_office", title: "Circuit Court Judge" });
    expect(judge).toBeGreaterThan(rank("28", { office_scope: "state_lower", title: "State House of Representatives" }));
    expect(judge).toBeLessThan(rank("28", { office_scope: "county", title: "Election Commissioner" }));
    expect(judge).toBeLessThan(rank("28", { office_scope: "school_unified", title: "School Board Member" }));
  });

  it("GA: statewide executives between US Senate and US House", () => {
    const governor = rank("13", { office_scope: "statewide", title: "Governor" });
    expect(governor).toBeGreaterThan(
      rank("13", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senate" })
    );
    expect(governor).toBeLessThan(rank("13", { office_scope: "us_house", title: "United States House" }));
  });

  it("NY: statewide executives before US Senate and US House", () => {
    const comptroller = rank("36", { office_scope: "statewide", title: "Comptroller" });
    expect(comptroller).toBeLessThan(
      rank("36", { office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    expect(comptroller).toBeLessThan(rank("36", { office_scope: "us_house", title: "Representative in Congress" }));
  });

  it("FL: nonpartisan county offices and city offices print in the nonpartisan section", () => {
    const judge = rank("12", { office_scope: "county", contest_family: "judicial_office", title: "Circuit Judge" });
    const schoolBoard = rank("12", { office_scope: "school_unified", title: "School Board Member" });
    const partisanCounty = rank("12", { office_scope: "county", title: "County Commissioner" });
    const nonpartisanCounty = rank("12", { office_scope: "county", title: "County Commissioner", is_partisan: false });
    const city = rank("12", { office_scope: "place", title: "Mayor", is_partisan: false });
    expect(partisanCounty).toBeLessThan(judge);
    expect(nonpartisanCounty).toBeGreaterThan(judge);
    expect(nonpartisanCounty).toBeLessThan(schoolBoard);
    expect(city).toBeGreaterThan(schoolBoard);
  });

  it("MI: nonpartisan city offices after the judges, before local school boards", () => {
    const city = rank("26", { office_scope: "place", title: "City Commissioner", is_partisan: false });
    expect(city).toBeGreaterThan(
      rank("26", { office_scope: "county", contest_family: "judicial_office", title: "Judge of District Court" })
    );
    expect(city).toBeLessThan(rank("26", { office_scope: "school_unified", title: "Board Member" }));
  });

  it("AK: ballot measures before the retention questions", () => {
    const measure = rank("02", { race_type: "ballot_measure", office_scope: null, district_type: "statewide" });
    expect(measure).toBeGreaterThan(rank("02", { office_scope: "state_lower", title: "State Representative" }));
    expect(measure).toBeLessThan(
      rank("02", { office_scope: "statewide", contest_family: "judicial_office", title: "Supreme Court Justice" })
    );
  });

  it("KY: Lexington prints its urban county government between the judges and the school board", () => {
    const fayette = (overrides: InputOverrides) =>
      stateBallotContestRank(input({ ...overrides, state_fips: "21" }), { countyFips: "21067" });
    const judge = fayette({ office_scope: "county", contest_family: "judicial_office", title: "District Judge" });
    const mayor = fayette({ office_scope: "place", title: "Mayor" });
    const schoolBoard = fayette({ office_scope: "school_unified", title: "Board of Education Member" });
    expect(mayor).toBeGreaterThan(judge);
    expect(mayor).toBeLessThan(schoolBoard);
  });

  it("KY: Louisville prints county, metro government, school board, then judges; amendment after US Senator", () => {
    const jefferson = (overrides: InputOverrides) =>
      stateBallotContestRank(input({ ...overrides, state_fips: "21" }), { countyFips: "21111" });
    const county = jefferson({ office_scope: "county", title: "Sheriff" });
    const metro = jefferson({ office_scope: "place", title: "Louisville Metro Council" });
    const schoolBoard = jefferson({ office_scope: "school_unified", title: "Jefferson County School Board" });
    const judge = jefferson({ office_scope: "county", contest_family: "judicial_office", title: "District Judge" });
    expect(metro).toBeGreaterThan(county);
    expect(schoolBoard).toBeGreaterThan(metro);
    expect(judge).toBeGreaterThan(schoolBoard);
    const amendment = jefferson({ race_type: "ballot_measure", office_scope: null, district_type: "statewide" });
    expect(amendment).toBeGreaterThan(
      jefferson({ office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
    );
    expect(amendment).toBeLessThan(jefferson({ office_scope: "us_house", title: "United States Representative" }));
  });

  it("AL: Attorney General before the legislature; the other executives after the appellate courts", () => {
    const senate = rank("01", { office_scope: "state_upper", title: "State Senator" });
    const appeals = rank("01", {
      office_scope: "statewide",
      contest_family: "judicial_office",
      title: "Court of Civil Appeals Judge",
    });
    const trial = rank("01", { office_scope: "county", contest_family: "judicial_office", title: "Circuit Court Judge" });
    expect(rank("01", { office_scope: "statewide", title: "Attorney General" })).toBeLessThan(senate);
    const secretary = rank("01", { office_scope: "statewide", title: "Secretary of State" });
    expect(secretary).toBeGreaterThan(appeals);
    expect(secretary).toBeLessThan(trial);
  });
});

describe("county-scoped orders", () => {
  const LA = { countyFips: "06037" };
  function la(overrides: InputOverrides): number {
    return stateBallotContestRank(input({ ...overrides, state_fips: "06" }), LA);
  }

  it("lists Los Angeles County", () => {
    expect(OVERRIDDEN_COUNTY_FIPS).toContain("06037");
  });

  it("Los Angeles County: local first, measures inside each block, federal last (Elec. Code 13109.8)", () => {
    const measure = (district_type: string) =>
      la({ race_type: "ballot_measure", office_scope: null, district_type, election_stage: null, title: "Measure" });
    const order = [
      la({ office_scope: "place", title: "Mayor" }),
      la({ office_scope: "place", title: "Member of the City Council" }),
      la({ office_scope: "school_unified", title: "Governing Board Member" }),
      la({ office_scope: "school_secondary", title: "Governing Board Member" }),
      la({ office_scope: "school_elementary", title: "Governing Board Member" }),
      la({ office_scope: "local_special", title: "Community College District Governing Board Member" }),
      la({ office_scope: "place", title: "City Clerk" }),
      la({ office_scope: "state_upper", title: "State Senator" }),
      la({ office_scope: "state_lower", title: "Member of the State Assembly" }),
      la({ office_scope: "us_house", title: "United States Representative" }),
      measure("place"),
      measure("school_unified"),
      la({ office_scope: "local_special", title: "Water District Director" }),
      measure("local_special"),
      la({ office_scope: "county", title: "County Supervisor", election_stage: "runoff" }),
      la({ office_scope: "county", title: "Sheriff", election_stage: "runoff" }),
      la({ office_scope: "county", title: "Assessor", election_stage: "runoff" }),
      la({ office_scope: "county", title: "District Attorney", election_stage: "runoff" }),
      la({
        office_scope: "county",
        contest_family: "judicial_office",
        title: "Judge of the Superior Court, Office No. 64",
        election_stage: "runoff",
      }),
      measure("county"),
      la({ office_scope: "statewide", title: "Governor" }),
      la({ office_scope: "statewide", title: "Superintendent of Public Instruction" }),
      measure("statewide"),
      la({
        office_scope: "statewide",
        contest_family: "judicial_office",
        title: "Shall Associate Justice of the Supreme Court A be elected?",
        election_stage: null,
      }),
      la({
        office_scope: "statewide",
        contest_family: "judicial_office",
        title: "Presiding Justice, Court of Appeal, Second District, Division Three: Shall B be elected?",
        election_stage: null,
      }),
      la({
        office_scope: "statewide",
        contest_family: "judicial_office",
        title: "Associate Justice, Court of Appeal, Second District, Division One: Shall C be elected?",
        election_stage: null,
      }),
      la({ office_scope: "presidential", title: "President and Vice President" }),
      la({ office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" }),
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i], `position ${i}`).toBeGreaterThan(order[i - 1]);
    }
  });

  it("California: executives and Court of Appeal questions follow the statutory ladder", () => {
    const titles = [
      "Governor",
      "Lieutenant Governor",
      "Secretary of State",
      "Controller",
      "Treasurer",
      "Attorney General",
      "Insurance Commissioner",
      "Member, State Board of Equalization, 3rd District",
    ];
    const courts = [
      "Shall Associate Justice of the Supreme Court A be elected?",
      "Presiding Justice, Court of Appeal, Second District, Division Three: Shall B be elected?",
      "Presiding Justice, Court of Appeal, Second District, Division Seven: Shall C be elected?",
      "Associate Justice, Court of Appeal, Second District, Division One: Shall D be elected?",
      "Associate Justice, Court of Appeal, Second District, Division Eight: Shall E be elected?",
    ];
    // Same ladders under the state rule (any other county) and the LA rule.
    for (const context of [{}, LA]) {
      const ranks = titles.map((title) =>
        stateBallotContestRank(input({ state_fips: "06", office_scope: "statewide", title }), context)
      );
      const courtRanks = courts.map((title) =>
        stateBallotContestRank(
          input({ state_fips: "06", office_scope: "statewide", contest_family: "judicial_office", title }),
          context
        )
      );
      for (const run of [ranks, courtRanks]) {
        for (let i = 1; i < run.length; i += 1) {
          expect(run[i], `position ${i}`).toBeGreaterThan(run[i - 1]);
        }
      }
    }
  });

  it("applies the county order at every stage, and only to that county's state", () => {
    // The alternate order governs LA primaries too.
    expect(la({ office_scope: "place", title: "Mayor", election_stage: "primary" })).toBeLessThan(
      la({ office_scope: "statewide", title: "Governor", election_stage: "primary" })
    );
    // Another California county keeps the state rule.
    const other = { countyFips: "06073" };
    const governor = input({ state_fips: "06", office_scope: "statewide", title: "Governor" });
    expect(stateBallotContestRank(governor, other)).toBe(stateBallotContestRank(governor));
    // A row from another state is never ranked by the LA rule.
    const texas = input({ state_fips: "48", office_scope: "statewide", title: "Governor" });
    expect(stateBallotContestRank(texas, LA)).toBe(stateBallotContestRank(texas));
  });
});

describe("withinTierOfficeRank", () => {
  const exec = (state_fips: string, title: string) =>
    withinTierOfficeRank(input({ state_fips, office_scope: "statewide", title }));

  it("prints Governor first in every state, never by title alphabet", () => {
    for (const fips of ["01", "13", "17", "36", "48", "53", "99"]) {
      expect(exec(fips, "Governor and Lieutenant Governor")).toBeLessThan(exec(fips, "Attorney General"));
      expect(exec(fips, "Governor")).toBeLessThan(exec(fips, "Lieutenant Governor"));
    }
  });

  it("uses the state's own ladder where one is recorded", () => {
    // Texas: Attorney General, then Comptroller, then Land Commissioner.
    expect(exec("48", "Attorney General")).toBeLessThan(exec("48", "Comptroller of Public Accounts"));
    expect(exec("48", "Comptroller of Public Accounts")).toBeLessThan(
      exec("48", "Commissioner of the General Land Office")
    );
    // Ohio: Attorney General and Auditor before Secretary of State.
    expect(exec("39", "Auditor of State")).toBeLessThan(exec("39", "Secretary of State"));
    // Generic sequence: Secretary of State before Attorney General.
    expect(exec("99", "Secretary of State")).toBeLessThan(exec("99", "Attorney General"));
    // An office the ladder omits prints after the ones it names.
    expect(exec("39", "Treasurer of State")).toBeLessThan(exec("39", "Member, State Board of Education"));
  });

  it("is zero for anything that is not a statewide executive", () => {
    expect(withinTierOfficeRank(input({ office_scope: "county", title: "Treasurer" }))).toBe(0);
    expect(
      withinTierOfficeRank(
        input({ office_scope: "statewide", contest_family: "us_senate", title: "United States Senator" })
      )
    ).toBe(0);
    expect(
      withinTierOfficeRank(
        input({ race_type: "ballot_measure", office_scope: null, district_type: "statewide", title: "Governor Recall" })
      )
    ).toBe(0);
  });
});

describe("printedBallotTitle", () => {
  const proposition = (state_fips: string) =>
    input({
      state_fips,
      race_type: "ballot_measure",
      office_scope: null,
      district_type: "statewide",
      election_stage: null,
      title: "Proposition 39: Voter Identification and Citizenship Verification",
    });

  it("Los Angeles County prints state propositions as State Measure N", () => {
    expect(printedBallotTitle(proposition("06"), { countyFips: "06037" })).toBe(
      "State Measure 39: Voter Identification and Citizenship Verification"
    );
  });

  it("keeps the stored title everywhere else", () => {
    expect(printedBallotTitle(proposition("06"), { countyFips: "06073" })).toBe(
      "Proposition 39: Voter Identification and Citizenship Verification"
    );
    expect(printedBallotTitle(proposition("06"))).toBe(
      "Proposition 39: Voter Identification and Citizenship Verification"
    );
    // County and city measures, and offices, keep their titles in Los Angeles County.
    const countyMeasure = input({
      state_fips: "06",
      race_type: "ballot_measure",
      office_scope: null,
      district_type: "county",
      election_stage: null,
      title: "Measure A: Charter Amendment",
    });
    expect(printedBallotTitle(countyMeasure, { countyFips: "06037" })).toBe("Measure A: Charter Amendment");
    const office = input({ state_fips: "06", office_scope: "statewide", title: "Governor" });
    expect(printedBallotTitle(office, { countyFips: "06037" })).toBe("Governor");
  });

  const measure = (state_fips: string, title: string, printed_ballot_label: string | null) => ({
    ...input({
      state_fips,
      race_type: "ballot_measure",
      office_scope: null,
      district_type: "statewide",
      election_stage: null,
      title,
    }),
    printed_ballot_label,
  });

  it("a stored printed label replaces the stored title's leading label", () => {
    expect(
      printedBallotTitle(
        measure("01", "Act 2026-341: Lieutenant Governor vacancy and legislative expenses", "Statewide Amendment 1")
      )
    ).toBe("Statewide Amendment 1: Lieutenant Governor vacancy and legislative expenses");
    expect(
      printedBallotTitle(
        measure("31", "LR19CA: Legislative Term Limits Constitutional Amendment", "Proposed Amendment No. 1")
      )
    ).toBe("Proposed Amendment No. 1: Legislative Term Limits Constitutional Amendment");
  });

  it("a stored printed label is prefixed when the stored title has no label", () => {
    expect(
      printedBallotTitle(
        measure("13", "Next Generation 9-1-1 Fund Amendment", "Proposed Constitutional Amendment 3")
      )
    ).toBe("Proposed Constitutional Amendment 3: Next Generation 9-1-1 Fund Amendment");
  });

  it("a null or blank printed label keeps the stored title", () => {
    expect(printedBallotTitle(measure("13", "Next Generation 9-1-1 Fund Amendment", null))).toBe(
      "Next Generation 9-1-1 Fund Amendment"
    );
    expect(printedBallotTitle(measure("13", "Next Generation 9-1-1 Fund Amendment", "  "))).toBe(
      "Next Generation 9-1-1 Fund Amendment"
    );
  });

  it("the county rule still applies on top of a stored printed label", () => {
    const labeled = measure("06", "Senate Constitutional Amendment 1: Recall Elections", "Proposition 40");
    expect(printedBallotTitle(labeled, { countyFips: "06073" })).toBe("Proposition 40: Recall Elections");
    expect(printedBallotTitle(labeled, { countyFips: "06037" })).toBe("State Measure 40: Recall Elections");
  });
});
