import { describe, expect, it, vi } from "vitest";

import {
  newYorkCandidateFirstLastName,
  normalizeNewYorkCandidateNameKeys,
  resolveNewYorkCandidateCommittee,
  searchAndResolveNewYorkCandidateCommittee,
} from "../../../src/pipeline/newYorkFinance/newYorkCandidateCommitteeResolver.js";
import type { NewYorkFilerRecord } from "../../../src/pipeline/newYorkFinance/newYorkSodaClient.js";

function filer(overrides: Partial<NewYorkFilerRecord>): NewYorkFilerRecord {
  return {
    filerId: "1",
    filerName: "Filer",
    complianceType: "COMMITTEE",
    committeeType: "Authorized Single Candidate Committee",
    filerStatus: "ACTIVE",
    filerType: "State",
    officeDesc: null,
    district: null,
    countyDesc: null,
    ...overrides,
  };
}

const HOCHUL_CANDIDATE = filer({
  filerId: "27197",
  filerName: "Kathy C. Hochul",
  complianceType: "CANDIDATE",
  committeeType: null,
  officeDesc: "Governor",
});
const HOCHUL_COMMITTEE = filer({ filerId: "16851", filerName: "Friends for Kathy Hochul" });

const GOVERNOR_INPUT = {
  candidateName: "Kathy Hochul",
  officeScope: "statewide",
  officeName: "Governor",
  electionYear: 2026,
};

describe("newYorkCandidateCommitteeResolver", () => {
  it("normalizes candidate names into match keys and first/last pairs", () => {
    expect(normalizeNewYorkCandidateNameKeys("Hochul, Kathy C.")).toContain("KATHY HOCHUL");
    expect(normalizeNewYorkCandidateNameKeys("Kathy C. Hochul Jr.")).toContain("KATHY HOCHUL");
    expect(newYorkCandidateFirstLastName("Kathy C. Hochul")).toEqual({ firstName: "KATHY", lastName: "HOCHUL" });
    expect(newYorkCandidateFirstLastName("Cher")).toBeNull();
  });

  it("matches exactly one registered candidate plus one authorized committee containing the name", () => {
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateFilers: [HOCHUL_CANDIDATE],
      committeeFilers: [HOCHUL_COMMITTEE, filer({ filerId: "999", filerName: "New Yorkers for Progress" })],
    });

    expect(resolution).toMatchObject({
      status: "matched",
      filerId: "16851",
      filerName: "Friends for Kathy Hochul",
      candidateFilerId: "27197",
      source: "ny_soda_api",
    });
  });

  it("requires the candidate to exist in the registry for the office", () => {
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateFilers: [filer({ ...HOCHUL_CANDIDATE, filerName: "Somebody Else" })],
      committeeFilers: [HOCHUL_COMMITTEE],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_registered_candidate" });
  });

  it("rejects a registered filer whose middle name contradicts the candidate", () => {
    // Same office and district — only the middle evidence differs. Without the
    // middle gate this filer registered as an "exact" match and the other
    // Hochul's authorized committee became this candidate's finance link.
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Kathy A. Hochul",
      candidateFilers: [HOCHUL_CANDIDATE],
      committeeFilers: [HOCHUL_COMMITTEE],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_registered_candidate" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Kathy Christine Hochul",
      candidateFilers: [HOCHUL_CANDIDATE],
      committeeFilers: [HOCHUL_COMMITTEE],
    });
    expect(resolution).toMatchObject({ status: "matched", candidateFilerId: "27197" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Kathy Hochul",
      candidateFilers: [HOCHUL_CANDIDATE],
      committeeFilers: [HOCHUL_COMMITTEE],
    });
    expect(resolution).toMatchObject({ status: "matched", candidateFilerId: "27197" });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it has to survive
    // normalization as middle evidence on EITHER side of the comparison.
    const resolve = (candidateName: string, filerName: string) =>
      resolveNewYorkCandidateCommittee({
        ...GOVERNOR_INPUT,
        candidateName,
        candidateFilers: [filer({ ...HOCHUL_CANDIDATE, filerName })],
        committeeFilers: [HOCHUL_COMMITTEE],
      });

    expect(resolve("Kathy V. Hochul", "Hochul, Kathy C.")).toMatchObject({
      status: "unmatched",
      reason: "no_registered_candidate",
    });
    expect(resolve("Kathy C. Hochul", "Hochul, Kathy V")).toMatchObject({
      status: "unmatched",
      reason: "no_registered_candidate",
    });
    expect(resolve("Kathy V. Hochul", "Hochul, Kathy V")).toMatchObject({
      status: "matched",
      candidateFilerId: "27197",
    });
    expect(resolve("Kathy Hochul", "Hochul, Kathy V")).toMatchObject({
      status: "matched",
      candidateFilerId: "27197",
    });
  });

  it("skips when several distinct registered candidates share the name", () => {
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateFilers: [HOCHUL_CANDIDATE, filer({ ...HOCHUL_CANDIDATE, filerId: "27198" })],
      committeeFilers: [HOCHUL_COMMITTEE],
    });
    expect(resolution).toMatchObject({ status: "ambiguous", reason: "multiple_registered_candidates" });
  });

  it("requires the committee name to contain both first and last name unless it is the bare surname", () => {
    expect(
      resolveNewYorkCandidateCommittee({
        ...GOVERNOR_INPUT,
        candidateFilers: [HOCHUL_CANDIDATE],
        committeeFilers: [filer({ filerId: "555", filerName: "Friends of Mary Hochul" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
    // Live: "Blakeman for New York" and "James for NY 2026" carry no first name.
    expect(
      resolveNewYorkCandidateCommittee({
        ...GOVERNOR_INPUT,
        candidateName: "Bruce Blakeman",
        candidateFilers: [filer({ filerId: "165157", filerName: "Bruce   Blakeman", complianceType: "CANDIDATE", committeeType: null, officeDesc: "Governor" })],
        committeeFilers: [
          filer({ filerId: "580499", filerName: "Blakeman for New York", committeeType: "Public Campaign Finance Committee" }),
          // A second surname-only committee would make this ambiguous; a
          // place name is not a wrapper, so "Blakeman for Nassau" is not one.
          filer({ filerId: "165158", filerName: "Blakeman for Nassau" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "580499", confidence: "surname_committee" });
    expect(
      resolveNewYorkCandidateCommittee({
        ...GOVERNOR_INPUT,
        candidateName: "Bruce Blakeman",
        candidateFilers: [filer({ filerId: "165157", filerName: "Bruce Blakeman", complianceType: "CANDIDATE", committeeType: null, officeDesc: "Governor" })],
        committeeFilers: [
          filer({ filerId: "580499", filerName: "Blakeman for New York" }),
          filer({ filerId: "580500", filerName: "Friends of Blakeman" }),
        ],
      })
    ).toMatchObject({ status: "ambiguous", reason: "multiple_matching_committees" });
    expect(
      resolveNewYorkCandidateCommittee({
        ...GOVERNOR_INPUT,
        candidateName: "Letitia James",
        officeName: "Attorney General",
        candidateFilers: [filer({ filerId: "27937", filerName: "Letitia  James", complianceType: "CANDIDATE", committeeType: null, officeDesc: "Attorney General" })],
        committeeFilers: [
          filer({ filerId: "308810", filerName: "James for NY 2026", committeeType: "Public Campaign Finance Committee" }),
          filer({ filerId: "320329", filerName: "James Schuler for NYS Assembly", committeeType: "Public Campaign Finance Committee" }),
          filer({ filerId: "404128", filerName: "Friends of James Meyers", committeeType: "Public Campaign Finance Committee" }),
          filer({ filerId: "591076", filerName: "Friends of Mariama James", committeeType: "Public Campaign Finance Committee" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "308810", confidence: "surname_committee" });
  });

  it("never admits a surname-only committee for a legislative race or one naming another office", () => {
    expect(
      resolveNewYorkCandidateCommittee({
        ...GOVERNOR_INPUT,
        candidateFilers: [HOCHUL_CANDIDATE],
        committeeFilers: [filer({ filerId: "556", filerName: "Hochul for Assembly" })],
      })
    ).toMatchObject({ status: "unmatched" });
    expect(
      resolveNewYorkCandidateCommittee({
        candidateName: "Bruce Blakeman",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "7",
        electionYear: 2026,
        candidateFilers: [filer({ filerId: "9", filerName: "Bruce Blakeman", complianceType: "CANDIDATE", committeeType: null, officeDesc: "State Senator", district: "7" })],
        committeeFilers: [filer({ filerId: "580499", filerName: "Blakeman for New York" })],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("skips when several committees contain the candidate name", () => {
    const resolution = resolveNewYorkCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateFilers: [HOCHUL_CANDIDATE],
      committeeFilers: [HOCHUL_COMMITTEE, filer({ filerId: "16852", filerName: "Kathy Hochul for New York" })],
    });
    expect(resolution).toMatchObject({ status: "ambiguous", reason: "multiple_matching_committees" });
  });

  it("reports missing districts for legislative offices and unsupported offices", () => {
    expect(
      resolveNewYorkCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2026,
        district: null,
        candidateFilers: [],
        committeeFilers: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_district" });

    expect(
      resolveNewYorkCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "city",
        officeName: "Mayor",
        electionYear: 2026,
        candidateFilers: [],
        committeeFilers: [],
      })
    ).toMatchObject({ status: "unmatched", reason: "unsupported_office" });
  });

  it("searches the registry with office labels, district, and last-name fragment", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const where = url.searchParams.get("$where") ?? "";
      if (where.includes("compliance_type_desc='CANDIDATE'")) {
        expect(where).toContain("office_desc IN ('Member of Assembly')");
        expect(where).toContain("district='70'");
        return new Response(
          JSON.stringify([
            {
              filer_id: "42",
              filer_name: "Conrad Blackburn",
              compliance_type_desc: "CANDIDATE",
              filer_status: "ACTIVE",
              filer_type_desc: "State",
              office_desc: "Member of Assembly",
              district: "70",
            },
          ])
        );
      }
      expect(where).toContain("upper(filer_name) like '%BLACKBURN%'");
      return new Response(
        JSON.stringify([
          {
            filer_id: "77",
            filer_name: "Conrad Blackburn for Assembly",
            compliance_type_desc: "COMMITTEE",
            committee_type_desc: "Authorized Single Candidate Committee",
            filer_status: "ACTIVE",
            filer_type_desc: "State",
          },
        ])
      );
    });

    const resolution = await searchAndResolveNewYorkCandidateCommittee(
      {
        candidateName: "Conrad Blackburn",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        district: "AD 70",
      },
      { fetchImpl }
    );

    expect(resolution).toMatchObject({ status: "matched", filerId: "77", candidateFilerId: "42" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
