import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  georgiaCandidateNameMatchesRowNames,
  georgiaLastNameSearchToken,
  normalizeGeorgiaCandidateNameForStorage,
  normalizeGeorgiaCandidateNameKeys,
  resolveGeorgiaCandidateCommittee,
  searchAndResolveGeorgiaCandidateCommittee,
} from "../../../src/pipeline/georgiaFinance/georgiaCandidateCommitteeResolver.js";
import type {
  GeorgiaCandidateIndexRow,
  GeorgiaEthicsTransport,
} from "../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/georgiaFinance");

// The PeachFile Carr fixture row, as the client parses it.
const CARR_ROW: GeorgiaCandidateIndexRow = {
  filerEntityId: 100035,
  filerRegistrationId: 35,
  guid: "d973ab3b-54c2-416e-81ce-f5b1ee9a6f57",
  filerName: "Carr, Christopher M.",
  committeeName: "Carr for Georgia, Inc.",
  candidateFirstName: "Christopher",
  candidateMiddleName: "Michael",
  candidateLastName: "Carr",
  ballotFullName: null,
  office: "Governor",
  districtName: null,
  filerStatusCode: "FACT",
  filingCycleName: "2026 Candidate/Committee Filing Cycle",
  electionCycleName: "2026 Georgia State Election",
  totalContributions: 5374711.06,
  totalExpenditures: 4168947.51,
  cashOnHand: 1167791.24,
};

const GOVERNOR_INPUT = {
  candidateName: "Christopher Carr",
  officeScope: "statewide",
  officeName: "Governor",
  electionYear: 2026,
  district: null,
};

describe("name normalization", () => {
  it("matches app-format and PeachFile comma-format names through shared keys", () => {
    const appKeys = normalizeGeorgiaCandidateNameKeys("Christopher Carr");
    const indexKeys = normalizeGeorgiaCandidateNameKeys("Carr, Christopher M.");
    expect([...appKeys].some((key) => indexKeys.has(key))).toBe(true);
  });

  it("derives the last-name search token from either name order", () => {
    expect(georgiaLastNameSearchToken("Christopher Carr")).toBe("CARR");
    expect(georgiaLastNameSearchToken("Carr, Christopher M.")).toBe("CARR");
  });

  it("produces a stable storage key", () => {
    expect(normalizeGeorgiaCandidateNameForStorage("Christopher  Carr Jr.")).toBe("CHRISTOPHER CARR");
  });
});

describe("georgiaCandidateNameMatchesRowNames (middle-name evidence)", () => {
  it("rejects conflicting middle initials even when first and last agree", () => {
    expect(georgiaCandidateNameMatchesRowNames("John A. Smith", ["Smith, John B."])).toBe(false);
    expect(georgiaCandidateNameMatchesRowNames("John Anthony Smith", ["Smith, John B."])).toBe(false);
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(georgiaCandidateNameMatchesRowNames("John Anthony Smith", ["Smith, John A."])).toBe(true);
    expect(georgiaCandidateNameMatchesRowNames("Christopher Michael Carr", ["Carr, Christopher M."])).toBe(true);
  });

  it("falls back to first+last only when a side lacks middle information", () => {
    expect(georgiaCandidateNameMatchesRowNames("John Smith", ["Smith, John B."])).toBe(true);
    expect(georgiaCandidateNameMatchesRowNames("John A. Smith", ["Smith, John"])).toBe(true);
  });

  it("lets a middle conflict veto a middle-less variant of the same row", () => {
    // The row's ballot name lacks the middle, but its filerName carries a
    // conflicting one — the evidence must win over the weaker variant.
    expect(georgiaCandidateNameMatchesRowNames("John A. Smith", ["Smith, John B.", "John Smith"])).toBe(false);
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it must stay as
    // middle evidence on either side instead of being stripped as a suffix.
    expect(georgiaCandidateNameMatchesRowNames("John V. Smith", ["Smith, John B."])).toBe(false);
    expect(georgiaCandidateNameMatchesRowNames("John B. Smith", ["Smith, John V"])).toBe(false);
    expect(georgiaCandidateNameMatchesRowNames("John V. Smith", ["Smith, John V"])).toBe(true);
    expect(georgiaCandidateNameMatchesRowNames("John Smith", ["Smith, John V"])).toBe(true);
  });

  it("rejects a conflict past the first middle token", () => {
    // The MICHAEL agreement must not short-circuit before ANDREW-vs-BERNARD
    // is compared — every shared middle position carries evidence.
    expect(
      georgiaCandidateNameMatchesRowNames("John Michael Andrew Smith", ["SMITH, JOHN MICHAEL BERNARD"])
    ).toBe(false);
    expect(georgiaCandidateNameMatchesRowNames("John Michael Andrew Smith", ["SMITH, JOHN MICHAEL A."])).toBe(
      true
    );
  });

  it("still matches multi-word surnames across name orders", () => {
    expect(georgiaCandidateNameMatchesRowNames("Mary Van Dyke", ["Van Dyke, Mary A."])).toBe(true);
  });

  it("judges middle evidence only at the longest aligned surname", () => {
    // Space-form "MARY B VAN DYKE" also emits a bogus DYKE-surname split that
    // reads VAN-vs-B as a middle conflict; the real VAN DYKE alignment wins.
    expect(georgiaCandidateNameMatchesRowNames("Mary Van Dyke", ["MARY B VAN DYKE"])).toBe(true);
  });

  it("never lets an ambiguous space-form split override a comma-form conflict", () => {
    // The comma form pins the surname, so its A-vs-B conflict is
    // authoritative; the space-form sibling name re-splitting as surname
    // "A SMITH" must not resurrect the match through the longest-surname
    // fallback.
    expect(
      georgiaCandidateNameMatchesRowNames("John A. Smith", ["Smith, John B. A.", "John B A Smith"])
    ).toBe(false);
  });
});

describe("resolveGeorgiaCandidateCommittee", () => {
  it("matches a formal registration name through a VoteApp nickname, literal first", () => {
    // Live: VoteApp "Mike Cheokas", PeachFile "Cheokas, Michael" (committee
    // name also formal, so the committee-title fallback cannot help).
    const michael: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerEntityId: 501,
      guid: "00000000-0000-0000-0000-000000000501",
      filerName: "Cheokas, Michael",
      committeeName: "Cheokas, Michael",
      candidateFirstName: "Michael",
      candidateMiddleName: null,
      candidateLastName: "Cheokas",
      office: "State Representative",
      districtName: "151",
    };
    const input = {
      candidateName: "Mike Cheokas",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionYear: 2026,
      district: "151",
    };
    expect(resolveGeorgiaCandidateCommittee({ ...input, candidateIndexRows: [michael] })).toMatchObject({
      status: "matched",
      filerEntityId: "501",
      confidence: "exact",
    });
    const mike = {
      ...michael,
      filerEntityId: 502,
      guid: "00000000-0000-0000-0000-000000000502",
      filerName: "Cheokas, Mike",
      candidateFirstName: "Mike",
    };
    expect(resolveGeorgiaCandidateCommittee({ ...input, candidateIndexRows: [michael, mike] })).toMatchObject({
      status: "matched",
      filerEntityId: "502",
    });
    expect(georgiaCandidateNameMatchesRowNames("Mike Cheokas", ["Cheokas, Michael"])).toBe(false);
  });

  it("rejects a same-race row whose middle name contradicts the candidate", () => {
    // Same office, cycle, and district — only the middle evidence differs.
    // Without the middle gate this row would link as an "exact" match and
    // attach another person's money.
    const wrongPerson: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Carr, Christopher B.",
      candidateMiddleName: "Bernard",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Christopher Michael Carr",
      candidateIndexRows: [wrongPerson],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("matches a legal-name registration through committee-name evidence (nickname shape)", () => {
    // The index registers the LEGAL name while the roster carries the
    // campaign name — Georgia's own committee title supplies the everyday
    // name ("Dale Washburn for State House" under "Washburn, Roy D.",
    // live-verified 2026-08-09). Surname must match structurally and the
    // roster first name must appear as a whole word in the committee name.
    const legalNameRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Washburn, Roy D.",
      candidateFirstName: "Roy",
      candidateMiddleName: "D.",
      candidateLastName: "Washburn",
      committeeName: "Dale Washburn for State House",
      office: "State Representative",
      districtName: "144",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      candidateName: "Dale Washburn",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionYear: 2026,
      district: "144",
      candidateIndexRows: [legalNameRow],
    });
    expect(resolution).toMatchObject({ status: "matched", committeeName: "Dale Washburn for State House" });
  });

  it("committee-name evidence works without the surname in the title (Friends for Fitz shape)", () => {
    const fitzRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Johnson, Terrell F.",
      candidateFirstName: "Terrell",
      candidateMiddleName: "F.",
      candidateLastName: "Johnson",
      committeeName: "Friends for Fitz PSC",
      office: "Public Service Commissioner",
      districtName: "3",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      candidateName: "Fitz Johnson",
      officeScope: "statewide",
      officeName: "Public Service Commissioner",
      electionYear: 2026,
      district: null,
      candidateIndexRows: [fitzRow],
    });
    expect(resolution).toMatchObject({ status: "matched", committeeName: "Friends for Fitz PSC" });
  });

  it("marks committee-title matches with their own confidence, person-name matches as exact", () => {
    const legalNameRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Washburn, Roy D.",
      candidateFirstName: "Roy",
      candidateMiddleName: "D.",
      candidateLastName: "Washburn",
      committeeName: "Dale Washburn for State House",
      office: "State Representative",
      districtName: "144",
    };
    const viaTitle = resolveGeorgiaCandidateCommittee({
      candidateName: "Dale Washburn",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionYear: 2026,
      district: "144",
      candidateIndexRows: [legalNameRow],
    });
    expect(viaTitle).toMatchObject({ status: "matched", confidence: "committee_title" });

    const viaPerson = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateIndexRows: [CARR_ROW],
    });
    expect(viaPerson).toMatchObject({ status: "matched", confidence: "exact" });
  });

  it("committee-name evidence accepts a compound registered surname for a space-form roster name", () => {
    // Space-form parsing reduces the roster surname to its last token
    // (Mary Van Dyke -> DYKE) while the registration keeps the compound
    // form; ballots routinely drop particles, so the word-boundary suffix
    // must carry it.
    const compoundRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Van Dyke, Machteld",
      candidateFirstName: "Machteld",
      candidateMiddleName: null,
      candidateLastName: "Van Dyke",
      committeeName: "Mary Van Dyke for State House",
      office: "State Representative",
      districtName: "60",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      candidateName: "Mary Van Dyke",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionYear: 2026,
      district: "60",
      candidateIndexRows: [compoundRow],
    });
    expect(resolution).toMatchObject({ status: "matched", confidence: "committee_title" });
  });

  it("committee-name evidence never overrides the middle-name veto", () => {
    // First names AGREE and middles conflict: the person-name gate vetoed
    // this row, and a committee title echoing the roster name must not
    // resurrect it.
    const vetoedRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Carr, Christopher B.",
      candidateMiddleName: "Bernard",
      committeeName: "Christopher Carr for Georgia",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Christopher Michael Carr",
      candidateIndexRows: [vetoedRow],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("committee-name evidence requires the surname to match structurally", () => {
    // A committee title that happens to contain the roster first name is
    // not enough when the registered person has a different surname.
    const foreignRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filerName: "Smith, Roy D.",
      candidateFirstName: "Roy",
      candidateMiddleName: null,
      candidateLastName: "Smith",
      committeeName: "Dale for Georgia",
      office: "State Representative",
      districtName: "144",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      candidateName: "Dale Washburn",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionYear: 2026,
      district: "144",
      candidateIndexRows: [foreignRow],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("uses the structured middle name even when the app name has no middle", () => {
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Christopher Carr",
      candidateIndexRows: [CARR_ROW],
    });
    expect(resolution).toMatchObject({ status: "matched", filerEntityId: "100035" });
  });

  it("matches Carr to the PeachFile registration on the fixture row", () => {
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateIndexRows: [CARR_ROW],
    });
    expect(resolution).toMatchObject({
      status: "matched",
      filerEntityId: "100035",
      registrationGuid: "d973ab3b-54c2-416e-81ce-f5b1ee9a6f57",
      committeeName: "Carr for Georgia, Inc.",
      confidence: "exact",
      source: "peachfile_candidate_index",
    });
  });

  it("rejects rows from another cycle", () => {
    const oldCycle: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      filingCycleName: "2022 Candidate/Committee Filing Cycle",
      electionCycleName: "2022 Georgia State Election",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateIndexRows: [oldCycle],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("rejects rows for a different office and a different person", () => {
    const wrongOffice = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateIndexRows: [{ ...CARR_ROW, office: "Attorney General" }],
    });
    expect(wrongOffice.status).toBe("unmatched");

    const wrongPerson = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateName: "Geoff Duncan",
      candidateIndexRows: [CARR_ROW],
    });
    expect(wrongPerson.status).toBe("unmatched");
  });

  it("returns ambiguous when two distinct registrations survive every gate", () => {
    const secondRegistration: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      guid: "84070958-98cc-4ec5-a7de-de1757d712fc",
      filerEntityId: 200099,
      committeeName: "Another Carr Committee",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateIndexRows: [CARR_ROW, secondRegistration],
    });
    expect(resolution).toMatchObject({ status: "ambiguous", reason: "multiple_matching_registrations" });
    if (resolution.status === "ambiguous") {
      expect(resolution.matches).toHaveLength(2);
    }
  });

  it("accumulates duplicate rows for the same registration into one match", () => {
    const resolution = resolveGeorgiaCandidateCommittee({
      ...GOVERNOR_INPUT,
      candidateIndexRows: [CARR_ROW, { ...CARR_ROW }],
    });
    expect(resolution).toMatchObject({ status: "matched", matchedRowCount: 2 });
  });

  it("gates legislative offices on the district", () => {
    const senateRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      office: "State Senator",
      districtName: "District 33",
    };
    const senateInput = {
      candidateName: "Christopher Carr",
      officeScope: "state_upper",
      officeName: "State Senator",
      electionYear: 2026,
    };

    expect(
      resolveGeorgiaCandidateCommittee({ ...senateInput, district: "33", candidateIndexRows: [senateRow] })
    ).toMatchObject({ status: "matched" });
    expect(
      resolveGeorgiaCandidateCommittee({ ...senateInput, district: "34", candidateIndexRows: [senateRow] })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
    expect(
      resolveGeorgiaCandidateCommittee({ ...senateInput, district: null, candidateIndexRows: [senateRow] })
    ).toMatchObject({ status: "unmatched", reason: "missing_legislative_district" });
  });

  it("maps the state_lower app office onto PeachFile's State Representative label", () => {
    const houseRow: GeorgiaCandidateIndexRow = {
      ...CARR_ROW,
      office: "State Representative",
      districtName: "60",
      filerName: "Miller, Tanya",
      candidateFirstName: "Tanya",
      candidateLastName: "Miller",
      committeeName: "Committee to Elect Tanya Miller",
    };
    const resolution = resolveGeorgiaCandidateCommittee({
      candidateName: "Tanya Miller",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      electionYear: 2026,
      district: "60",
      candidateIndexRows: [houseRow],
    });
    expect(resolution).toMatchObject({ status: "matched", committeeName: "Committee to Elect Tanya Miller" });
  });

  it("fails closed on offices outside the eligible set", () => {
    const resolution = resolveGeorgiaCandidateCommittee({
      candidateName: "Christopher Carr",
      officeScope: "county",
      officeName: "County Commissioner",
      electionYear: 2026,
      district: null,
      candidateIndexRows: [CARR_ROW],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "unsupported_office" });
  });
});

describe("searchAndResolveGeorgiaCandidateCommittee", () => {
  it("searches PeachFile by last-name token and resolves from the fixture response", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const transport: GeorgiaEthicsTransport = {
      postJson: async (url, body) => {
        calls.push({ url, body });
        const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "peachfile_candidate_index_carr.json"), "utf-8"));
        return fixture.data;
      },
    };
    const resolution = await searchAndResolveGeorgiaCandidateCommittee(GOVERNOR_INPUT, transport);
    expect(resolution).toMatchObject({ status: "matched", filerEntityId: "100035" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("api-peachfile.ethics.ga.gov/api/PublicFilerDetails/GetCandidateDetails");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ filerTypeCode: "RC", filerName: "CARR" });
  });

  it("skips the network entirely for unsupported offices", async () => {
    const transport: GeorgiaEthicsTransport = {
      postJson: async () => {
        throw new Error("should not be called");
      },
    };
    const resolution = await searchAndResolveGeorgiaCandidateCommittee(
      { ...GOVERNOR_INPUT, officeScope: "county", officeName: "Sheriff" },
      transport
    );
    expect(resolution).toMatchObject({ status: "unmatched", reason: "unsupported_office" });
  });
});
