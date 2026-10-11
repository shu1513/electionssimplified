import { describe, expect, it } from "vitest";

import {
  isMinnesotaFinanceEligibleOffice,
  mapMinnesotaFinanceOffice,
  normalizeMinnesotaFinanceDistrict,
  normalizeMinnesotaFinanceOfficeName,
} from "../../../src/pipeline/minnesotaFinance/minnesotaFinanceEligibleOffices.js";
import {
  normalizeMinnesotaCandidateNameKeys,
  resolveMinnesotaCandidateCommittee,
} from "../../../src/pipeline/minnesotaFinance/minnesotaCandidateCommitteeResolver.js";
import type { MinnesotaCampaignFinanceCsvRow } from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactReader.js";

function record(overrides: Partial<MinnesotaCampaignFinanceCsvRow> = {}): MinnesotaCampaignFinanceCsvRow {
  return {
    "Committee ID": "1001",
    "Committee Name": "FRIENDS OF JANE DOE",
    Candidate: "Jane Doe",
    Office: "Governor",
    District: "",
    Status: "Active",
    Year: "2026",
    ...overrides,
  };
}

describe("Minnesota finance eligible offices", () => {
  it("normalizes office names and districts conservatively", () => {
    expect(normalizeMinnesotaFinanceOfficeName("State Representative")).toBe("State Lower Chamber Legislator");
    expect(normalizeMinnesotaFinanceOfficeName("Secretary of State")).toBe("Secretary of State");
    expect(normalizeMinnesotaFinanceOfficeName("State Auditor")).toBe("State Auditor");
    expect(normalizeMinnesotaFinanceDistrict(" 07 ")).toBe("7");
    expect(mapMinnesotaFinanceOffice({ officeScope: "statewide", officeCanonicalName: "Governor" })).toEqual(
      expect.objectContaining({
        officeScope: "statewide",
        officeName: "Governor",
        requiresDistrict: false,
        district: null,
      })
    );
    expect(
      isMinnesotaFinanceEligibleOffice({
        officeScope: "state_lower",
        officeCanonicalName: "State Representative",
        district: "7",
      })
    ).toBe(
      true
    );
  });

  it("treats legislative offices as eligible without a district, unlike committee mapping", () => {
    expect(
      isMinnesotaFinanceEligibleOffice({ officeScope: "state_lower", officeCanonicalName: "State Representative" })
    ).toBe(true);
    expect(
      isMinnesotaFinanceEligibleOffice({ officeScope: "state_upper", officeCanonicalName: "State Senator" })
    ).toBe(true);
    expect(isMinnesotaFinanceEligibleOffice({ officeScope: "state_upper", officeCanonicalName: "Governor" })).toBe(false);
    expect(
      mapMinnesotaFinanceOffice({ officeScope: "state_lower", officeCanonicalName: "State Representative" })
    ).toBeNull();
  });
});

describe("Minnesota candidate committee resolver", () => {
  it("normalizes candidate names without broad fuzzy matching", () => {
    expect([...normalizeMinnesotaCandidateNameKeys("Doe, Jane A.")]).toEqual([
      "DOE JANE A",
      "JANE A DOE",
      "JANE DOE",
    ]);
    expect(normalizeMinnesotaCandidateNameKeys("Bill E Gates J.R.")).toContain("BILL E GATES");
    expect(normalizeMinnesotaCandidateNameKeys("Mary J.R. Jones")).toContain("MARY J R JONES");
  });

  it("matches exactly one candidate committee by candidate name and office", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        sourceUrl: "https://register.cfb.mn.gov/reports-and-data/viewers/campaign-finance/candidates/0/2026/",
        candidateRows: [
          record(),
          record({
            "Committee ID": "9999",
            "Committee Name": "Other Committee",
            Candidate: "Other Candidate",
            Office: "Governor",
          }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "1001",
      committeeName: "FRIENDS OF JANE DOE",
      confidence: "exact",
      source: "mn_board_viewer",
      sourceUrl: "https://register.cfb.mn.gov/reports-and-data/viewers/campaign-finance/candidates/0/2026/",
      matchedCandidateRowCount: 1,
    });
  });

  it("rejects a same-race row whose middle name contradicts the candidate", () => {
    // Same office and year — only the middle evidence differs. Without the
    // middle gate this row linked as an "exact" match and attached the other
    // Jane Doe's committee.
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane A. Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [record({ Candidate: "Jane B. Doe" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("rejects a PCC recipient whose middle name contradicts the candidate", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane A. Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "1001",
            Recipient: "Doe, Jane B Gov Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane A. Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [record({ Candidate: "Jane Ann Doe" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [record({ Candidate: "Jane B. Doe" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("treats a bare trailing V as a middle initial, not a generational suffix", () => {
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts), so it must stay as middle evidence
    // on either side instead of being trimmed off the given-name segment.
    const resolve = (candidateName: string, rowName: string) =>
      resolveMinnesotaCandidateCommittee({
        candidateName,
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [record({ Candidate: rowName })],
      });
    expect(resolve("Jane V. Doe", "Doe, Jane B.")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("Jane B. Doe", "Doe, Jane V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("Jane V. Doe", "Doe, Jane V")).toMatchObject({ status: "matched", committeeId: "1001" });
    expect(resolve("Jane Doe", "Doe, Jane V")).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it.each([
    ["Demuth, Lisa Gov Committee", "Lisa Demuth", "Governor", "1001"],
    ["Ellison, Keith Atty Gen Committee", "Keith Ellison", "Attorney General", "1002"],
    ["Simon, Steve Sec of State Committee", "Steve Simon", "Secretary of State", "1003"],
    ["Blaha, Julie State Aud Committee", "Julie Blaha", "State Auditor", "1004"],
  ])("parses and matches live PCC recipient format: %s", (recipient, candidateName, officeName, committeeId) => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName,
        officeScope: "statewide",
        officeName,
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": committeeId,
            Recipient: recipient,
            "Recipient type": "PCC",
            "Recipient subtype": "",
            Year: "2025",
          },
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeId,
      committeeName: recipient,
    });
  });

  it.each(["PCF", "PTU"])("does not match candidate-looking %s recipients", (recipientType) => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Lisa Demuth",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "1001",
            Recipient: "Demuth, Lisa Gov Committee",
            "Recipient type": recipientType,
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("does not match a PCC recipient for another office", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Ryan Winkler",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "18274",
            Recipient: "Winkler, Ryan House Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("matches dotted candidate suffixes to CFB suffix formatting", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Bill E Gates J.R.",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "19283",
            Recipient: "Gates Jr., Bill E Gov Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "19283" });
  });

  it("matches a legislative PCC row on name and chamber when the export states no district", () => {
    // The bulk contribution export has no district column, so identity rests on
    // the candidate name, the chamber and the election year.
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Tina Liebling",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "24B",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "15719",
            Recipient: "Liebling, Tina House Committee",
            "Recipient type": "PCC",
            Year: "2025",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "15719" });
  });

  it("keeps the literal first-name match when a nickname variant also files", () => {
    // Nicknames only widen the search after the literal name found nothing, so
    // a different Ronald Latz does not make Ron Latz ambiguous.
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Ron Latz",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "46",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "16553",
            Recipient: "Latz, Ronald S Senate Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
          {
            "Recipient reg num": "16554",
            Recipient: "Latz, Ron Senate Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "16554" });
  });

  it("matches a formal recipient name through the VoteApp nickname (live: Ron Latz)", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Ron Latz",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "46",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "16553",
            Recipient: "Latz, Ronald S Senate Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "16553" });
  });

  it("matches past a leading initial the candidate does not use (live: D Scott Dibble)", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Scott Dibble",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "61",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "15667",
            Recipient: "Dibble, D Scott Senate Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "15667" });
  });

  it("does not expand nicknames on the source side", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Ron Latz",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "46",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "16553",
            Recipient: "Latz, Ronnie Senate Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("still rejects a legislative PCC row whose stated district contradicts the candidate", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Tina Liebling",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "24B",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "15719",
            Recipient: "Liebling, Tina House Committee",
            "Recipient type": "PCC",
            District: "11A",
            Year: "2025",
          },
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("refuses rather than guesses when two committees share a name and chamber", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Tina Liebling",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "24B",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "15719",
            Recipient: "Liebling, Tina House Committee",
            "Recipient type": "PCC",
            Year: "2025",
          },
          {
            "Recipient reg num": "99999",
            Recipient: "Liebling, Tina House Committee",
            "Recipient type": "PCC",
            Year: "2026",
          },
        ],
      })
    ).toMatchObject({ status: "ambiguous", reason: "multiple_matching_committees" });
  });

  it("anchors a parenthetical nickname to the surname instead of keying on it alone", () => {
    const keys = normalizeMinnesotaCandidateNameKeys("Joseph (Joe) Staloch");
    expect(keys).toContain("JOE STALOCH");
    expect(keys).not.toContain("JOE");
    // A comma-form committee name anchors to the same surname.
    expect(normalizeMinnesotaCandidateNameKeys("Staloch, Joseph (Joe)")).toContain("JOE STALOCH");
  });

  it("does not report two different Joes as ambiguous", () => {
    // Real committee names. Before the surname anchor, both rows produced the
    // bare key "JOE", so a candidate carrying the same nickname matched both.
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Joseph (Joe) Staloch",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "55A",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "19103",
            Recipient: "Staloch, Joseph (Joe) House Committee",
            "Recipient type": "PCC",
            Year: "2025",
          },
          {
            "Recipient reg num": "17167",
            Recipient: "McDonald, Joseph (Joe) House Committee",
            "Recipient type": "PCC",
            Year: "2025",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "19103" });
  });

  it("does not hand one Joe the other Joe's committee when only that one has rows", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Joseph (Joe) Staloch",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "55A",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "17167",
            Recipient: "McDonald, Joseph (Joe) House Committee",
            "Recipient type": "PCC",
            Year: "2025",
          },
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("lets a ballot nickname match the committee's parenthetical working name", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Joe Staloch",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "55A",
        electionYear: 2026,
        candidateRows: [
          {
            "Recipient reg num": "19103",
            Recipient: "Staloch, Joseph (Joe) House Committee",
            "Recipient type": "PCC",
            Year: "2025",
          },
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "19103" });
  });

  it("requires legislative districts for state senate and house candidates", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2026,
        candidateRows: [record({ Office: "State Senator", District: "7" })],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "missing_legislative_district",
    });

    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "07",
        electionYear: 2026,
        candidateRows: [record({ Office: "State Senator", District: "7" })],
      })
    ).toMatchObject({
      status: "matched",
      committeeId: "1001",
    });
  });

  it("skips other districts and unsupported offices", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "8",
        electionYear: 2026,
        candidateRows: [record({ Office: "State Senator", District: "7" })],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });

    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "President",
        electionYear: 2026,
        candidateRows: [record({ Office: "Governor" })],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "unsupported_office",
    });
  });

  it("skips rows from the wrong election year when that year is present", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [record({ Year: "2024" })],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
  });

  it("does not guess when multiple committees match", () => {
    expect(
      resolveMinnesotaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [
          record(),
          record({
            "Committee ID": "1002",
            "Committee Name": "JANE DOE FOR GOVERNOR TRANSITION",
            Candidate: "Jane Doe",
            Office: "Governor",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "Governor",
      matches: [
        {
          committeeId: "1001",
          committeeName: "FRIENDS OF JANE DOE",
          confidence: "exact",
          source: "mn_board_viewer",
          sourceUrl: null,
          matchedCandidateRowCount: 1,
        },
        {
          committeeId: "1002",
          committeeName: "JANE DOE FOR GOVERNOR TRANSITION",
          confidence: "exact",
          source: "mn_board_viewer",
          sourceUrl: null,
          matchedCandidateRowCount: 1,
        },
      ],
    });
  });
});
