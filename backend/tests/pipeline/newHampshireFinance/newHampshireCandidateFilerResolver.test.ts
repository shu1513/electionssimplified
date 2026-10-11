import { describe, expect, it } from "vitest";

import {
  normalizeNewHampshireCandidateNameForStorage,
  normalizeNewHampshireCandidateNameKeys,
  resolveNewHampshireCandidateFiler,
  resolveNewHampshireCandidateFilerPreferringActive,
} from "../../../src/pipeline/newHampshireFinance/newHampshireCandidateFilerResolver.js";
import type { NewHampshireFilingEntityRow } from "../../../src/pipeline/newHampshireFinance/newHampshireCfsClient.js";

// Sanitized from the live 2026 CFS candidate-committee search shape. The
// official person fields identify Cindy Rosenwald; filer/committee text does not.
function filingEntity(
  overrides: Partial<NewHampshireFilingEntityRow> = {}
): NewHampshireFilingEntityRow {
  return {
    registrationGuid: "bc20d4a3-6458-47f9-ad86-075f1231ca36",
    filingEntityId: 207787,
    filerName: "Friends of Cindy Rosenwald",
    candidateName: "Cindy Rosenwald",
    firstName: "Cindy",
    lastName: "Rosenwald",
    committeeName: "Friends of Cindy Rosenwald",
    filerTypeCode: "PAC",
    filerSubTypeCode: "PACCC",
    filerSubTypeName: "Candidate Committee",
    officeName: "State Senate",
    county: null,
    district: "13",
    electionCycleId: 110,
    electionYear: 2026,
    electionCycle: "2026 Election Cycle",
    status: "Active",
    ...overrides,
  };
}

const senateInput = {
  candidateName: "Cindy Rosenwald",
  officeScope: "state_upper",
  officeName: "State Senator",
  district: "District 13",
  electionCycleId: 110,
} as const;

describe("newHampshireCandidateFilerResolver", () => {
  it("normalizes direct and comma-form names without fuzzy expansion", () => {
    expect([...normalizeNewHampshireCandidateNameKeys("ROSENWALD, Cindy Q.")]).toEqual([
      "ROSENWALD CINDY Q",
      "CINDY Q ROSENWALD",
    ]);
    expect(normalizeNewHampshireCandidateNameForStorage("ROSENWALD, Cindy Q.")).toBe(
      "CINDY Q ROSENWALD"
    );
  });

  it("resolves a live-shaped candidate committee from official person, office, and district fields", () => {
    const sourceUrl =
      "https://cfsapi.sos.nh.gov/api/PublicFilerDetails/GetFilingEntityDetails";
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        sourceUrl,
        filingEntityRows: [filingEntity()],
      })
    ).toEqual({
      status: "matched",
      filingEntityId: 207787,
      filerName: "Friends of Cindy Rosenwald",
      candidateAliases: ["Cindy Rosenwald"],
      officeName: "State Senate",
      district: "13",
      confidence: "exact",
      source: "cfs_registration",
      sourceUrl,
      matchedRegistrationRowCount: 1,
    });
  });

  it("matches a formal registration name through a VoteApp nickname", () => {
    // Live shape: VoteApp "Tom Ploszaj", CFS registration "Thomas Ploszaj".
    const thomas = filingEntity({
      filingEntityId: 301,
      candidateName: "Thomas Rosenwald",
      firstName: "Thomas",
    });
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        candidateName: "Tom Rosenwald",
        filingEntityRows: [thomas],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 301 });
  });

  it("prefers a literal first-name registration over a nickname one", () => {
    // Live: Jim Maggiore has both a "Jim" and a "James" registration; the
    // literal one stays linked instead of turning ambiguous.
    const jim = filingEntity({ filingEntityId: 401, candidateName: "Jim Rosenwald", firstName: "Jim" });
    const james = filingEntity({ filingEntityId: 402, candidateName: "James Rosenwald", firstName: "James" });
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        candidateName: "Jim Rosenwald",
        filingEntityRows: [jim, james],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 401 });
  });

  it("requires the exact official cycle, office, and district", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        filingEntityRows: [
          filingEntity({ filingEntityId: 1, electionCycleId: 111 }),
          filingEntity({ filingEntityId: 2, officeName: "State Representative" }),
          filingEntity({ filingEntityId: 3, district: "12" }),
          filingEntity({ filingEntityId: 4 }),
        ],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 4 });
  });

  // Live 2026 shape: 22 Active State Senate committees register without a
  // district (Abbas, Watters, Prentiss, ...).
  const abbasInput = {
    candidateName: "Daryl Abbas",
    officeScope: "state_upper",
    officeName: "State Senator",
    district: "22",
    electionCycleId: 110,
  } as const;
  const abbasBlankDistrict = (overrides: Partial<NewHampshireFilingEntityRow> = {}) =>
    filingEntity({
      filingEntityId: 208786,
      filerName: "Abbas for New Hampshire",
      committeeName: "Abbas for New Hampshire",
      candidateName: "Daryl Abbas",
      firstName: "Daryl",
      lastName: "Abbas",
      district: null,
      ...overrides,
    });

  it("accepts a district-blank State Senate committee when the name matches exactly one filer", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...abbasInput,
        filingEntityRows: [
          abbasBlankDistrict(),
          // Another district-blank Senate filer with a different name is not a conflict.
          abbasBlankDistrict({ filingEntityId: 1, candidateName: "David Watters", firstName: "David", lastName: "Watters" }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filingEntityId: 208786,
      filerName: "Abbas for New Hampshire",
      candidateAliases: ["Daryl Abbas"],
      district: "22",
      confidence: "unique_name",
      matchedRegistrationRowCount: 1,
    });
  });

  it("prefers an exact-district registration over a district-blank one", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...abbasInput,
        filingEntityRows: [
          abbasBlankDistrict(),
          abbasBlankDistrict({ filingEntityId: 9, filerName: "Abbas 2026", district: "22" }),
        ],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 9, confidence: "exact", district: "22" });
  });

  it("reports district-blank fallback as ambiguous when the name is not unique in the office", () => {
    const otherDistrict = resolveNewHampshireCandidateFiler({
      ...abbasInput,
      filingEntityRows: [
        abbasBlankDistrict(),
        abbasBlankDistrict({ filingEntityId: 9, filerName: "Abbas for Senate 3", district: "3" }),
      ],
    });
    expect(otherDistrict).toMatchObject({ status: "ambiguous", reason: "multiple_matching_filers" });
    expect(
      otherDistrict.status === "ambiguous"
        ? otherDistrict.matches.map((match) => [match.filingEntityId, match.district, match.confidence])
        : []
    ).toEqual([
      [9, "3", "unique_name"],
      [208786, "22", "unique_name"],
    ]);

    expect(
      resolveNewHampshireCandidateFiler({
        ...abbasInput,
        filingEntityRows: [abbasBlankDistrict(), abbasBlankDistrict({ filingEntityId: 9, filerName: "Abbas Two" })],
      })
    ).toMatchObject({ status: "ambiguous", reason: "multiple_matching_filers" });
  });

  it("treats a non-empty district the parser cannot read as conflicting evidence, not a blank", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...abbasInput,
        filingEntityRows: [abbasBlankDistrict({ district: "District 3 - Nashua" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_filer_match" });
    // Whitespace-only is a blank.
    expect(
      resolveNewHampshireCandidateFiler({
        ...abbasInput,
        filingEntityRows: [abbasBlankDistrict({ district: "  " })],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 208786, confidence: "unique_name" });
  });

  it("prefers Active registrations and falls back to any status only when Active finds nothing", () => {
    // Live SS9 shape: an Active district-blank committee plus a Closed exact-district one.
    const mcLaughlin = {
      candidateName: "Matthew McLaughlin",
      officeScope: "state_upper",
      officeName: "State Senator",
      district: "9",
      electionCycleId: 110,
    } as const;
    const activeBlank = filingEntity({
      filingEntityId: 243712,
      filerName: "Friend's of Matt McLaughlin",
      candidateName: "Matthew McLaughlin",
      firstName: "Matthew",
      lastName: "McLaughlin",
      district: null,
      status: "Active",
    });
    const closedExact = filingEntity({
      filingEntityId: 241471,
      filerName: "McLaughlin, Matthew",
      candidateName: "Matthew McLaughlin",
      firstName: "Matthew",
      lastName: "McLaughlin",
      filerTypeCode: "CC",
      filerSubTypeCode: null,
      district: "9",
      status: "Closed",
    });

    expect(
      resolveNewHampshireCandidateFilerPreferringActive({ ...mcLaughlin, filingEntityRows: [closedExact, activeBlank] })
    ).toMatchObject({ status: "matched", filingEntityId: 243712, confidence: "unique_name" });
    // Status-agnostic resolution still picks the exact-district row.
    expect(resolveNewHampshireCandidateFiler({ ...mcLaughlin, filingEntityRows: [closedExact, activeBlank] })).toMatchObject({
      status: "matched",
      filingEntityId: 241471,
      confidence: "exact",
    });
    // Only a Closed registration: still resolves (manual links to closed filers keep syncing).
    expect(resolveNewHampshireCandidateFilerPreferringActive({ ...mcLaughlin, filingEntityRows: [closedExact] })).toMatchObject({
      status: "matched",
      filingEntityId: 241471,
    });
    // Active ambiguity is not papered over by the fallback.
    expect(
      resolveNewHampshireCandidateFilerPreferringActive({
        ...mcLaughlin,
        filingEntityRows: [closedExact, activeBlank, { ...activeBlank, filingEntityId: 1, filerName: "Second" }],
      })
    ).toMatchObject({ status: "ambiguous" });
  });

  it("never applies the district-blank fallback to offices whose districts repeat by county", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        candidateName: "Wayne Campbell",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "State House District Strafford 4 (2024); New Hampshire",
        electionCycleId: 110,
        filingEntityRows: [
          filingEntity({
            filingEntityId: 244578,
            filerName: "Committee to Elect Packy Campbell",
            candidateName: "Wayne Campbell",
            firstName: "Wayne",
            lastName: "Campbell",
            officeName: "State Representative",
            county: null,
            district: null,
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_filer_match" });
  });

  it("drops an alias shared by a district-blank Senate filer and a same-named House filer", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...abbasInput,
        filingEntityRows: [
          abbasBlankDistrict(),
          abbasBlankDistrict({
            filingEntityId: 77,
            filerName: "Abbas, Daryl",
            filerTypeCode: "CAN",
            filerSubTypeCode: null,
            officeName: "State Representative",
            county: "Rockingham",
            district: "5",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 208786, candidateAliases: [] });
  });

  it("never derives candidate identity from committee or filer display text", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        filingEntityRows: [
          filingEntity({
            filerName: "Friends of Cindy Rosenwald",
            committeeName: "Friends of Cindy Rosenwald",
            candidateName: null,
            firstName: null,
            lastName: null,
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_filer_match" });
  });

  it("allows missing middle evidence but rejects conflicting middles and generations", () => {
    const resolve = (candidateName: string, officialName: string) =>
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        candidateName,
        filingEntityRows: [
          filingEntity({
            candidateName: officialName,
          }),
        ],
      });

    expect(resolve("Cindy Rosenwald", "Rosenwald, Cindy Q.")).toMatchObject({ status: "matched" });
    expect(resolve("Cindy Q. Rosenwald", "Rosenwald, Cindy Quinn")).toMatchObject({
      status: "matched",
    });
    expect(resolve("Cindy A. Rosenwald", "Rosenwald, Cindy B.")).toMatchObject({
      status: "unmatched",
    });
    expect(resolve("John Doe Jr.", "Doe, John III")).toMatchObject({ status: "unmatched" });
  });

  it("groups duplicate official rows by filing entity ID and retains trusted person aliases", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        candidateName: "Cindy Q. Rosenwald",
        filingEntityRows: [
          filingEntity({ candidateName: "Cindy Rosenwald" }),
          filingEntity({ candidateName: "Rosenwald, Cindy Q." }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filingEntityId: 207787,
      candidateAliases: ["Cindy Q. Rosenwald", "Cindy Rosenwald"],
      matchedRegistrationRowCount: 2,
    });
  });

  it("removes an outside-spending alias shared by distinct official race targets", () => {
    const result = resolveNewHampshireCandidateFiler({
      candidateName: "Dianne Schuett",
      officeScope: "state_lower",
      officeName: "State Representative",
      district: "Merrimack 12",
      electionCycleId: 110,
      filingEntityRows: [
        filingEntity({
          filingEntityId: 242692,
          filerName: "Schuett, Dianne",
          candidateName: "Dianne Schuett",
          firstName: "Dianne",
          lastName: "Schuett",
          filerTypeCode: "CAN",
          filerSubTypeCode: null,
          officeName: "State Representative",
          county: "Merrimack",
          district: "12",
        }),
        filingEntity({
          filingEntityId: 244443,
          filerName: "Schuett, Dianne E.",
          candidateName: "Dianne Schuett",
          firstName: "Dianne",
          lastName: "Schuett",
          filerTypeCode: "CAN",
          filerSubTypeCode: null,
          officeName: "County Treasurer",
          county: "Merrimack",
          district: null,
        }),
      ],
    });

    expect(result).toMatchObject({
      status: "matched",
      filingEntityId: 242692,
      candidateAliases: [],
    });
  });

  it("does not invent ambiguity from an incomplete duplicate registration", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        filingEntityRows: [filingEntity(), filingEntity({ district: null })],
      })
    ).toMatchObject({
      status: "matched",
      candidateAliases: ["Cindy Rosenwald"],
    });
  });

  it("returns multiple exact official registrations as ambiguous instead of guessing", () => {
    const result = resolveNewHampshireCandidateFiler({
      ...senateInput,
      filingEntityRows: [
        filingEntity({ filingEntityId: 100, filerName: "Committee One" }),
        filingEntity({ filingEntityId: 200, filerName: "Committee Two" }),
      ],
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_filers",
      candidateNameNormalized: "CINDY ROSENWALD",
      officeNameNormalized: "State Senate",
    });
    expect(result.status === "ambiguous" ? result.matches.map((match) => match.filingEntityId) : []).toEqual([
      100,
      200,
    ]);
  });

  it("supports direct-candidate registration codes without weakening office evidence", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        candidateName: "Patrick Abrami",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "State House District Rockingham 12 (2024); New Hampshire",
        electionCycleId: 110,
        filingEntityRows: [
          filingEntity({
            filingEntityId: 244398,
            filerName: "Abrami, Patrick",
            committeeName: null,
            candidateName: "Patrick Abrami",
            firstName: "Patrick",
            lastName: "Abrami",
            filerTypeCode: "CAN",
            filerSubTypeCode: null,
            filerSubTypeName: null,
            officeName: "State Representative",
            county: "Rockingham",
            district: "12",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 244398 });
  });

  it("requires the county-qualified NH House district and rejects the same number in another county", () => {
    const houseInput = {
      candidateName: "Patrick Abrami",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionCycleId: 110,
    } as const;
    const houseRegistration = (filingEntityId: number, county: string) =>
      filingEntity({
        filingEntityId,
        candidateName: "Patrick Abrami",
        firstName: "Patrick",
        lastName: "Abrami",
        filerTypeCode: "CAN",
        filerSubTypeCode: null,
        officeName: "State Representative",
        county,
        district: "12",
      });

    expect(
      resolveNewHampshireCandidateFiler({
        ...houseInput,
        district: "State House District Rockingham 12 (2024); New Hampshire",
        filingEntityRows: [
          houseRegistration(1, "Cheshire"),
          houseRegistration(2, "Rockingham"),
        ],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 2, district: "Rockingham 12" });
    expect(
      resolveNewHampshireCandidateFiler({
        ...houseInput,
        district: "12",
        filingEntityRows: [houseRegistration(2, "Rockingham")],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_required_district" });
  });

  it("requires official county jurisdiction for county offices", () => {
    const sheriff = (filingEntityId: number, county: string) =>
      filingEntity({
        filingEntityId,
        candidateName: "Chris Connelly",
        firstName: "Chris",
        lastName: "Connelly",
        filerTypeCode: "CAN",
        filerSubTypeCode: null,
        officeName: "Sheriff",
        county,
        district: null,
      });

    expect(
      resolveNewHampshireCandidateFiler({
        candidateName: "Chris Connelly",
        officeScope: "county",
        officeName: "Sheriff",
        district: "Hillsborough County, New Hampshire",
        electionCycleId: 110,
        filingEntityRows: [sheriff(1, "Merrimack"), sheriff(2, "Hillsborough")],
      })
    ).toMatchObject({ status: "matched", filingEntityId: 2, district: "Hillsborough" });
  });

  it.each([
    ["District Attorney", "County Attorney"],
    ["County Recorder", "Register of Deeds"],
    ["Clerk of Court", "Register of Probate"],
  ])(
    "maps VoteApp's %s canonical office to NH's %s registration",
    (officeName, registrationOfficeName) => {
      expect(
        resolveNewHampshireCandidateFiler({
          candidateName: "Alex Granite",
          officeScope: "county",
          officeName,
          district: "Hillsborough County, New Hampshire",
          electionCycleId: 110,
          filingEntityRows: [
            filingEntity({
              filingEntityId: 55,
              filerName: "Alex Granite",
              candidateName: "Alex Granite",
              firstName: "Alex",
              lastName: "Granite",
              filerTypeCode: "CAN",
              filerSubTypeCode: null,
              officeName: registrationOfficeName,
              county: "Hillsborough",
              district: null,
            }),
          ],
        })
      ).toMatchObject({ status: "matched", filingEntityId: 55, district: "Hillsborough" });
    }
  );

  it("fails closed on missing identity context, unsupported offices, and invalid cycle IDs", () => {
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        candidateName: " ",
        filingEntityRows: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_candidate_name" });
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        officeScope: "statewide",
        officeName: "President",
        filingEntityRows: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "unsupported_office" });
    expect(
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        district: null,
        filingEntityRows: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_required_district" });
    expect(() =>
      resolveNewHampshireCandidateFiler({
        ...senateInput,
        electionCycleId: 0,
        filingEntityRows: [],
      })
    ).toThrow("Invalid New Hampshire candidate filer election-cycle ID");
  });
});
