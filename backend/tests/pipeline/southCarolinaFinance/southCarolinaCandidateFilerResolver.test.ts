import { describe, expect, it } from "vitest";

import {
  filterSouthCarolinaFilersByExactSurname,
  resolveSouthCarolinaCandidateFiler,
  southCarolinaFilerSearchTerm,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaCandidateFilerResolver.js";
import {
  isSouthCarolinaFinanceEligibleOffice,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaFinanceEligibleOffices.js";
import type {
  SouthCarolinaCandidateReportRow,
  SouthCarolinaFilerSearchRow,
} from "../../../src/pipeline/southCarolinaFinance/southCarolinaEthicsClient.js";

function filerRow(overrides: Partial<SouthCarolinaFilerSearchRow>): SouthCarolinaFilerSearchRow {
  return {
    candidate: "Evette, Pamela S",
    candidateFilerId: 54395,
    officeName: "4",
    lastCampaignDisclosureReport: "07/14/2026",
    ...overrides,
  };
}

function reportRow(overrides: Partial<SouthCarolinaCandidateReportRow>): SouthCarolinaCandidateReportRow {
  return {
    reportId: 430061,
    reportName: "Pre-Election Report 2026",
    reportType: "Pre-Election Quarterly",
    electionDate: "6/9/2026",
    contributions: 3497154.3,
    expenses: 2944738.53,
    balance: 552415.77,
    dateSubmitted: "2026-07-14T10:00:00",
    campaignId: 77609,
    candidateFilerId: 54395,
    filingStartDate: "2026-04-01T04:00:00",
    filingEndDate: "2026-05-20T00:00:00",
    isPrimary: true,
    isGeneral: false,
    isPreElection: true,
    isFinal: false,
    ...overrides,
  };
}

describe("South Carolina finance eligible offices", () => {
  it("accepts v1 statewide and legislative offices", () => {
    expect(
      isSouthCarolinaFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "Governor" })
    ).toBe(true);
    expect(
      isSouthCarolinaFinanceEligibleOffice({
        officeScope: "state_lower",
        officeCanonicalName: "State Lower Chamber Legislator",
      })
    ).toBe(true);
    expect(
      isSouthCarolinaFinanceEligibleOffice({ officeScope: "state_upper", officeCanonicalName: "State Senator" })
    ).toBe(true);
  });

  it("rejects federal, county, and missing offices", () => {
    expect(
      isSouthCarolinaFinanceEligibleOffice({
        officeScope: "statewide",
        officeCanonicalName: "United States Senator",
      })
    ).toBe(false);
    expect(
      isSouthCarolinaFinanceEligibleOffice({
        officeScope: "us_house",
        officeCanonicalName: "United States Representative",
      })
    ).toBe(false);
    expect(
      isSouthCarolinaFinanceEligibleOffice({ officeScope: "county", officeCanonicalName: "Sheriff" })
    ).toBe(false);
    expect(
      isSouthCarolinaFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: null })
    ).toBe(false);
  });
});

describe("southCarolinaFilerSearchTerm", () => {
  it("uses the final surname word and strips generational suffixes", () => {
    expect(southCarolinaFilerSearchTerm("Alan Wilson")).toBe("Wilson");
    expect(southCarolinaFilerSearchTerm("Mary Johnson-Wilson")).toBe("Johnson-Wilson");
    expect(southCarolinaFilerSearchTerm("Lester L. Wilks Jr.")).toBe("Wilks");
    expect(southCarolinaFilerSearchTerm("Hao Wu")).toBe("Wu");
    expect(southCarolinaFilerSearchTerm("Wilson, Alan")).toBe("Wilson");
    expect(southCarolinaFilerSearchTerm("Julius Walker, Jr.")).toBe("Walker");
  });

  it("returns null when no searchable surname word remains", () => {
    expect(southCarolinaFilerSearchTerm("J O")).toBeNull();
    expect(southCarolinaFilerSearchTerm("  ")).toBeNull();
  });
});

describe("filterSouthCarolinaFilersByExactSurname", () => {
  it("keeps exact surnames and drops fuzzy contains-matches and SEI-only rows", () => {
    const rows = [
      filerRow({ candidate: "Wilson, Michael A", candidateFilerId: 54344 }),
      filerRow({ candidate: "Johnson-Wilson, Mary", candidateFilerId: 61000 }),
      filerRow({ candidate: "Wilson, Amy F.", candidateFilerId: 0 }),
    ];
    const kept = filterSouthCarolinaFilersByExactSurname("Alan Wilson", rows);
    expect(kept.map((row) => row.candidateFilerId)).toEqual([54344]);
  });

  it("reads a comma-separated generational suffix as a suffix, not a Last, First boundary", () => {
    const rows = [
      filerRow({ candidate: "Walker, Julius", candidateFilerId: 62000 }),
      filerRow({ candidate: "Davis, Donnie L", candidateFilerId: 62001 }),
    ];
    expect(
      filterSouthCarolinaFilersByExactSurname("Julius Walker, Jr.", rows).map((row) => row.candidateFilerId)
    ).toEqual([62000]);
    expect(
      filterSouthCarolinaFilersByExactSurname("Donnie Davis, II", rows).map((row) => row.candidateFilerId)
    ).toEqual([62001]);
  });

  it("matches hyphenated surnames exactly", () => {
    const rows = [
      filerRow({ candidate: "Johnson-Wilson, Mary", candidateFilerId: 61000 }),
      filerRow({ candidate: "Wilson, Michael A", candidateFilerId: 54344 }),
    ];
    const kept = filterSouthCarolinaFilersByExactSurname("Mary Johnson-Wilson", rows);
    expect(kept.map((row) => row.candidateFilerId)).toEqual([61000]);
  });
});

describe("resolveSouthCarolinaCandidateFiler", () => {
  const election = "2026-11-03";

  it("matches one full-name filer with cycle evidence, ignoring the broken statewide office label", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "Pamela Evette",
      electionDate: election,
      filerReportSets: [
        {
          // officeName is the literal "4" for 2026 statewide runs — never consulted.
          filer: filerRow({ candidate: "Evette, Pamela S", candidateFilerId: 54395, officeName: "4" }),
          reports: [
            reportRow({ electionDate: "6/9/2026" }),
            reportRow({ reportId: 426000, reportName: "Quarter 2, 2026 Report", electionDate: "6/9/2026" }),
            reportRow({ reportId: 300000, electionDate: "11/8/2022", campaignId: 50000 }),
          ],
        },
      ],
    });
    expect(resolution).toMatchObject({
      status: "matched",
      candidateFilerId: 54395,
      filerName: "Evette, Pamela S",
      matchedElectionDates: ["6/9/2026"],
      cycleReportCount: 2,
      confidence: "exact",
    });
  });

  it("requires manual confirmation when only the surname matches (Wilson legal-name divergence)", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "Alan Wilson",
      electionDate: election,
      filerReportSets: [
        {
          filer: filerRow({ candidate: "Wilson, Michael A", candidateFilerId: 54344 }),
          reports: [reportRow({ candidateFilerId: 54344, campaignId: 77574 })],
        },
      ],
    });
    expect(resolution.status).toBe("manual_confirm_required");
    if (resolution.status === "manual_confirm_required") {
      expect(resolution.candidates).toHaveLength(1);
      expect(resolution.candidates[0]).toMatchObject({
        candidateFilerId: 54344,
        filerName: "Wilson, Michael A",
        matchedElectionDates: ["6/9/2026"],
      });
    }
  });

  it("matches a formal filer name through a VoteApp nickname, literal first", () => {
    // Live: VoteApp "Joe Bustos", filer search "Bustos, Joseph M.".
    const joseph = {
      filer: filerRow({ candidate: "Bustos, Joseph M.", candidateFilerId: 80001 }),
      reports: [reportRow({ candidateFilerId: 80001 })],
    };
    expect(
      resolveSouthCarolinaCandidateFiler({ candidateName: "Joe Bustos", electionDate: election, filerReportSets: [joseph] })
    ).toMatchObject({ status: "matched", candidateFilerId: 80001 });
    const joe = {
      filer: filerRow({ candidate: "Bustos, Joe", candidateFilerId: 80002 }),
      reports: [reportRow({ candidateFilerId: 80002 })],
    };
    expect(
      resolveSouthCarolinaCandidateFiler({
        candidateName: "Joe Bustos",
        electionDate: election,
        filerReportSets: [joseph, joe],
      })
    ).toMatchObject({ status: "matched", candidateFilerId: 80002 });
  });

  it("completes the filer search's 18-character truncated given name", () => {
    // Live: the API returns "Cobb-Hunter, Gild..." and "Burkhold, Michael...".
    const gilda = {
      filer: filerRow({ candidate: "Cobb-Hunter, Gild...", candidateFilerId: 45419 }),
      reports: [reportRow({ candidateFilerId: 45419 })],
    };
    expect(
      resolveSouthCarolinaCandidateFiler({
        candidateName: "Gilda Cobb-Hunter",
        electionDate: election,
        filerReportSets: [gilda],
      })
    ).toMatchObject({ status: "matched", candidateFilerId: 45419 });
    const michael = {
      filer: filerRow({ candidate: "Burkhold, Michael...", candidateFilerId: 80003 }),
      reports: [reportRow({ candidateFilerId: 80003 })],
    };
    expect(
      resolveSouthCarolinaCandidateFiler({
        candidateName: "Mike Burkhold",
        electionDate: election,
        filerReportSets: [michael],
      })
    ).toMatchObject({ status: "matched", candidateFilerId: 80003 });
    // A fragment that does not start the VoteApp name stays a mismatch.
    expect(
      resolveSouthCarolinaCandidateFiler({
        candidateName: "Heath Sessions",
        electionDate: election,
        filerReportSets: [
          {
            filer: filerRow({ candidate: "Sessions, Christo...", candidateFilerId: 80004 }),
            reports: [reportRow({ candidateFilerId: 80004 })],
          },
        ],
      }).status
    ).toBe("manual_confirm_required");
  });

  it("routes a middle-initial conflict to manual confirmation instead of auto-linking", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "John A. Smith",
      electionDate: election,
      filerReportSets: [
        {
          filer: filerRow({ candidate: "Smith, John B", candidateFilerId: 70001 }),
          reports: [reportRow({ candidateFilerId: 70001 })],
        },
      ],
    });
    expect(resolution.status).toBe("manual_confirm_required");
  });

  it("returns ambiguous when two full-name filers both carry cycle evidence", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "John Smith",
      electionDate: election,
      filerReportSets: [
        {
          filer: filerRow({ candidate: "Smith, John A", candidateFilerId: 70001 }),
          reports: [reportRow({ candidateFilerId: 70001 })],
        },
        {
          filer: filerRow({ candidate: "Smith, John B", candidateFilerId: 70002 }),
          reports: [reportRow({ candidateFilerId: 70002 })],
        },
      ],
    });
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status === "ambiguous") {
      expect(resolution.matches.map((match) => match.candidateFilerId)).toEqual([70001, 70002]);
    }
  });

  it("prefers the single full-name match over surname-only alternatives", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "John Smith",
      electionDate: election,
      filerReportSets: [
        {
          filer: filerRow({ candidate: "Smith, John A", candidateFilerId: 70001 }),
          reports: [reportRow({ candidateFilerId: 70001 })],
        },
        {
          filer: filerRow({ candidate: "Smith, Rebecca", candidateFilerId: 70002 }),
          reports: [reportRow({ candidateFilerId: 70002 })],
        },
      ],
    });
    expect(resolution).toMatchObject({ status: "matched", candidateFilerId: 70001 });
  });

  it("reports no_cycle_filings when the name matches but no reports fall in the election year", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "Hao Wu",
      electionDate: election,
      filerReportSets: [
        {
          filer: filerRow({ candidate: "Wu, Hao", candidateFilerId: 31444 }),
          reports: [reportRow({ candidateFilerId: 31444, electionDate: "11/2/2021" })],
        },
      ],
    });
    expect(resolution).toEqual({ status: "unmatched", reason: "no_cycle_filings" });
  });

  it("reports no_matching_filer when no surname matches", () => {
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "Alan Wilson",
      electionDate: election,
      filerReportSets: [
        {
          filer: filerRow({ candidate: "Johnson-Wilson, Mary", candidateFilerId: 61000 }),
          reports: [reportRow({ candidateFilerId: 61000 })],
        },
      ],
    });
    expect(resolution).toEqual({ status: "unmatched", reason: "no_matching_filer" });
  });

  it("dedupes repeated filer report sets by candidateFilerId", () => {
    const set = {
      filer: filerRow({ candidate: "Evette, Pamela S", candidateFilerId: 54395 }),
      reports: [reportRow({})],
    };
    const resolution = resolveSouthCarolinaCandidateFiler({
      candidateName: "Pamela Evette",
      electionDate: election,
      filerReportSets: [set, set],
    });
    expect(resolution).toMatchObject({ status: "matched", candidateFilerId: 54395 });
  });

  it("throws on a malformed election date", () => {
    expect(() =>
      resolveSouthCarolinaCandidateFiler({
        candidateName: "Pamela Evette",
        electionDate: "11/03/2026",
        filerReportSets: [],
      })
    ).toThrow(/election date/);
  });
});
