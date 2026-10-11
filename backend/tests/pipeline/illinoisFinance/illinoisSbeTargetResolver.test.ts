import { describe, expect, it } from "vitest";
import {
  resolveIllinoisSbeExpenditureTarget,
  resolveIllinoisSbeExpenditureTargetOffice,
  type IllinoisSbeTargetResolverInput,
  type IllinoisSbeTargetCandidate,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeTargetResolver.js";

// Sanitized complete-source identities: the same receiving committee links
// old House/Senate candidates and the actual 2026 Governor candidate.
const BAILEY: IllinoisSbeTargetCandidate = {
  candidateId: "45309", candidateName: "Darren Bailey", office: "Governor", districtType: "Statewide", district: "Illinois",
};
const HISTORICAL = [
  { candidateId: "40575", candidateName: "Daren Bailey", office: "State Representative", districtType: "Representative", district: "109" },
  { candidateId: "42969", candidateName: "Darren Bailey", office: "State Senator", districtType: "Senate", district: "55" },
];
function input(overrides: Partial<IllinoisSbeTargetResolverInput> = {}): IllinoisSbeTargetResolverInput {
  return {
    targetName: "Bailey for Illinois", targetOffice: "Illinois Governor",
    target: { candidateId: "45309", candidateName: "Darren Bailey", electionYear: 2026, electionType: "GE",
      officeScope: "statewide", officeName: "Governor", district: "Illinois" },
    sourceCandidates: [...HISTORICAL, BAILEY],
    sourceElections: [
      { candidateId: "40575", electionYear: 2018, electionType: "GE" },
      { candidateId: "42969", electionYear: 2020, electionType: "GE" },
      { candidateId: "45309", electionYear: 2022, electionType: "GE" },
      { candidateId: "45309", electionYear: 2026, electionType: "GP" },
      { candidateId: "45309", electionYear: 2026, electionType: "GE" },
    ],
    sourceCommittees: [
      { committeeId: "34092", committeeName: "Bailey for Illinois", committeeType: "Candidate", committeeStatus: "A" },
      { committeeId: "615", committeeName: "Kane County Republican Central Cmte", committeeType: "Political Party", committeeStatus: "A" },
      { committeeId: "32515", committeeName: "Democratic Governors Association-Illinois", committeeType: "Political Action", committeeStatus: "F" },
    ],
    sourceCommitteeCandidateLinks: HISTORICAL.concat(BAILEY).map((row) => ({ candidateId: row.candidateId, committeeId: "34092" })),
    ...overrides,
  };
}
function resolve(overrides: Partial<IllinoisSbeTargetResolverInput> = {}) {
  return resolveIllinoisSbeExpenditureTarget(input(overrides));
}
function expectRejected(overrides: Partial<IllinoisSbeTargetResolverInput>, reason: RegExp) {
  const result = resolve(overrides);
  expect(result.status).not.toBe("matched");
  if (result.status !== "matched") expect(result.reason).toMatch(reason);
}

describe("Illinois strict source target identity", () => {
  it("resolves actual Bailey committee-label target to unique2026Governor, not historical House/Senate", () => {
    expect(resolve()).toEqual({ status: "matched", candidateId: "45309", sourceCandidateName: "Darren Bailey",
      committeeId: "34092", matchType: "committee", office: { officeScope: "statewide", officeName: "Governor", district: null } });
  });

  it("accepts exact full person name including Last,First order without stripping middle evidence", () => {
    expect(resolve({ targetName: "Bailey, Darren" })).toMatchObject({ status: "matched", candidateId: "45309", matchType: "person" });
    const candidate = { ...BAILEY, candidateName: "John A. Smith Jr." };
    expect(resolve({ targetName: "Smith, John A., Jr.", target: { ...input().target, candidateName: candidate.candidateName },
      sourceCandidates: [candidate] })).toMatchObject({ status: "matched", candidateId: "45309" });
  });

  it("preserves an explicit comma-before-suffix source name without reversing the given name", () => {
    const candidate = { ...BAILEY, candidateName: "Edgar Gonzalez, Jr" };
    expect(resolve({ targetName: "Gonzalez, Edgar, Jr.",
      target: { ...input().target, candidateName: "Edgar Gonzalez Jr." }, sourceCandidates: [candidate] }))
      .toMatchObject({ status: "matched", sourceCandidateName: "Edgar Gonzalez, Jr" });
    expectRejected({ targetName: "Edgar Gonzalez", target: { ...input().target, candidateName: "Edgar Gonzalez Jr." },
      sourceCandidates: [candidate] }, /unresolved/);
  });

  it.each(["Darren B. Bailey", "Dan Bailey", "Bailey", "Darren Bailey and JB Pritzker", "Friends of Darren Bailey"])(
    "rejects guessed or partial source person identity: %s", (targetName) => {
      expectRejected({ targetName }, /unresolved/);
    });

  it("rejects middle-name disagreement between persisted and official candidate", () => {
    expectRejected({ target: { ...input().target, candidateName: "Darren B Bailey" } }, /name_or_seat/);
  });

  it("normalizes punctuation/case without expanding a committee label into a person", () => {
    expect(resolve({ targetName: "BAILEY-FOR-ILLINOIS" })).toMatchObject({ status: "matched", committeeId: "34092" });
    expectRejected({ targetName: "Bailey for Illlinois" }, /unresolved/);
  });

  it.each([2024, 2025])("does not use a different source election year: %s", (electionYear) => {
    expectRejected({ sourceElections: [{ candidateId: "45309", electionYear, electionType: "GE" }] }, /election_missing/);
  });

  it("does not substitute a primary-only registry election for the local general", () => {
    expectRejected({ sourceElections: [{ candidateId: "45309", electionYear: 2026, electionType: "GP" }] }, /election_missing/);
  });

  it("checks persisted candidate source ID as well as matching name and seat", () => {
    expectRejected({ target: { ...input().target, candidateId: "99999" } }, /missing_from_source/);
  });

  it("rejects two source candidate IDs with the same full name/year/seat", () => {
    expectRejected({ targetName: "Darren Bailey", sourceCandidates: [BAILEY, { ...BAILEY, candidateId: "99999" }],
      sourceElections: [...input().sourceElections, { candidateId: "99999", electionYear: 2026, electionType: "GE" }] }, /identity_ambiguous/);
  });

  it("rejects conflicting source rows for a persisted candidate ID", () => {
    expectRejected({ sourceCandidates: [BAILEY, { ...BAILEY, district: "5" }] }, /source_identity_conflict/);
  });

  it("allows exact duplicate source identities without creating false ambiguity", () => {
    expect(resolve({ sourceCandidates: [...input().sourceCandidates, { ...BAILEY }],
      sourceCommittees: [...input().sourceCommittees, { ...input().sourceCommittees[0]! }] })).toMatchObject({ status: "matched" });
  });

  it("checks normalized committee name uniqueness across ALL types before Candidate permission", () => {
    expect(resolve({ sourceCommittees: [...input().sourceCommittees,
      { committeeId: "99999", committeeName: "BAILEY-FOR-ILLINOIS", committeeType: "Political Action", committeeStatus: "F" }] }))
      .toEqual({ status: "ambiguous", reason: "registry_committee_name_ambiguous_across_all_types" });
  });

  it("rejects conflicting committee registry metadata for the same source ID", () => {
    expectRejected({ sourceCommittees: [...input().sourceCommittees,
      { committeeId: "34092", committeeName: "Bailey for Illinois", committeeType: "Political Action" }] }, /committee_identity_conflict/);
  });

  it("does not filter legal candidate committees by final status or historical creation year", () => {
    expect(resolve({ sourceCommittees: [{ ...input().sourceCommittees[0]!, committeeStatus: "F" }] })).toMatchObject({ status: "matched" });
  });

  it("rejects DGA as Pritzker-owned even though the official association is real and2026GEexists", () => {
    const candidate = { ...BAILEY, candidateId: "39266", candidateName: "JB Pritzker" };
    expectRejected({ targetName: "Democratic Governors Association-Illinois",
      target: { ...input().target, candidateId: "39266", candidateName: "JB Pritzker" },
      sourceCandidates: [candidate], sourceElections: [{ candidateId: "39266", electionYear: 2026, electionType: "GE" }],
      sourceCommitteeCandidateLinks: [{ committeeId: "32515", candidateId: "39266" }] }, /non_candidate_committee/);
  });

  it("does not infer ownership of an actual party committee from its associated candidate", () => {
    expectRejected({ targetName: "Kane County Republican Central Cmte",
      sourceCommitteeCandidateLinks: [{ committeeId: "615", candidateId: "45309" }] }, /non_candidate_committee/);
  });

  it("rejects disagreement between person and candidate-committee target resolutions", () => {
    const other = { ...BAILEY, candidateId: "99999", candidateName: "Other Person" };
    expectRejected({ targetName: "Darren Bailey", sourceCandidates: [BAILEY, other],
      sourceElections: [...input().sourceElections, { candidateId: "99999", electionYear: 2026, electionType: "GE" }],
      sourceCommittees: [{ committeeId: "555", committeeName: "Darren Bailey", committeeType: "Candidate" }],
      sourceCommitteeCandidateLinks: [{ committeeId: "555", candidateId: "99999" }] }, /candidate_identity_ambiguous/);
  });

  it("does not attribute another uniquely resolved source candidate to a persisted ID", () => {
    const other = { ...BAILEY, candidateId: "99999", candidateName: "Other Person" };
    expectRejected({ targetName: "Other Person", sourceCandidates: [BAILEY, other],
      sourceElections: [...input().sourceElections, { candidateId: "99999", electionYear: 2026, electionType: "GE" }] }, /disagrees_with_persisted/);
  });

  it("requires registry office and district type to agree", () => {
    expectRejected({ sourceCandidates: [{ ...BAILEY, districtType: "Representative" }] }, /name_or_seat/);
  });

  it("does not borrow a missing legislative source district from the local target", () => {
    const candidate = { ...BAILEY, office: "State Representative", district: "52", districtType: "Representative" };
    expectRejected({ sourceCandidates: [candidate], targetOffice: "State Representative",
      target: { ...input().target, officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "52" } }, /unsupported_source_target_office/);
  });

  it.each(["IL House Dist. 5", "IL Senate Dist. 52"])("keeps wrong chamber/district separate fromHouse52: %s", (targetOffice) => {
    const candidate = { ...BAILEY, office: "State Representative", district: "52", districtType: "Representative" };
    expectRejected({ sourceCandidates: [candidate], targetOffice,
      target: { ...input().target, officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "52" } }, /office_or_district_mismatch/);
  });

  it("accepts current source House52committee identity with exact observed abbreviated office", () => {
    const candidate = { candidateId: "43112", candidateName: "Martin McLaughlin", office: "State Representative", district: "52", districtType: "Representative" };
    expect(resolve({ sourceCandidates: [candidate], targetName: "Martin McLaughlin for State Representative", targetOffice: "IL House Dist. 52",
      sourceElections: [{ candidateId: "43112", electionYear: 2026, electionType: "GE" }],
      sourceCommittees: [{ committeeId: "35707", committeeName: "Martin McLaughlin For State Representative", committeeType: "Candidate" }],
      sourceCommitteeCandidateLinks: [{ committeeId: "35707", candidateId: "43112" }],
      target: { ...input().target, candidateId: "43112", candidateName: "Martin McLaughlin", officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "052" } }))
      .toMatchObject({ status: "matched", office: { officeScope: "state_lower", district: "52" } });
  });
});

describe("Illinois observed whole-field target office aliases", () => {
  it.each([
    ["IL House Dist. 52", "state_lower", "State Lower Chamber Legislator", "52"],
    ["IL  House, Dist. 49", "state_lower", "State Lower Chamber Legislator", "49"],
    ["IL Senate, Dist. 26", "state_upper", "State Senator", "26"],
    ["Illinois Governor", "statewide", "Governor", null],
    ["Illinois Attorney General", "statewide", "Attorney General", null],
    ["Secretary of State", "statewide", "Secretary of State", null],
    ["Illinois State Comptroller", "statewide", "Comptroller", null],
    ["Illinois State Treasurer", "statewide", "State Treasurer", null],
  ])("maps actual source label %s", (value, officeScope, officeName, district) => {
    expect(resolveIllinoisSbeExpenditureTargetOffice(value!)).toEqual({ officeScope, officeName, district });
  });

  it.each(["U.S Congress, Dist. 8", "U.S Senate", "Circuit Judge Madison 3rd Judicial Circuit", "County Board Dist. 5",
    "Chicago Board of Education 3B", "Governor and Lieutenant Governor", "Illinois Governor 52", "IL House Dist. 52 OTHER",
    "State Representative", "IL House Dist. 0", "IL House Dist. 119", "IL Senate Dist. 60", "", "House Dist. 8"])(
    "rejects unsupported, missing, mixed or misleading office %s", (value) => {
      expect(resolveIllinoisSbeExpenditureTargetOffice(value)).toBeNull();
    });
});
