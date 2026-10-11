import { describe, expect, it, vi } from "vitest";

import {
  normalizeWashingtonCandidateNameKeys,
  resolveWashingtonCandidateCommittee,
  searchAndResolveWashingtonCandidateCommittee,
} from "../../../src/pipeline/washingtonFinance/washingtonCandidateCommitteeResolver.js";
import type { WashingtonPdcCandidateSummary } from "../../../src/pipeline/washingtonFinance/washingtonPdcClient.js";

function summary(overrides: Partial<WashingtonPdcCandidateSummary> = {}): WashingtonPdcCandidateSummary {
  return {
    filerId: "FERGR *115",
    committeeId: "32311",
    candidacyId: "689556",
    filerName: "Robert W. Ferguson (Bob Ferguson)",
    committeeCategory: "Candidate",
    politicalCommitteeType: "Candidate",
    candidateCommitteeStatus: "Candidate declared",
    activeCandidate: true,
    hasReports: true,
    office: "GOVERNOR",
    jurisdiction: "State of Washington",
    jurisdictionType: "Statewide",
    electionYear: 2024,
    contributionsAmount: 14668288.73,
    sourceUrl: "https://my.pdc.wa.gov/registration/public/-/#/public/registration/59793",
    ...overrides,
  };
}

describe("washingtonCandidateCommitteeResolver", () => {
  it("normalizes direct, comma-form, and parenthetical candidate names", () => {
    expect([...normalizeWashingtonCandidateNameKeys("FERGUSON, Robert W. (Bob Ferguson)")]).toEqual([
      "FERGUSON ROBERT W",
      "ROBERT W FERGUSON",
      "ROBERT FERGUSON",
      "BOB FERGUSON",
    ]);
  });

  it("rejects a same-race summary whose middle name contradicts the candidate", () => {
    // Same office and election year — only the middle evidence differs.
    // Without the middle gate this summary linked as an "exact" match and
    // attached the other Ferguson's finance records.
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert W. Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Robert B. Ferguson" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert W. Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Robert Wayne Ferguson" })],
      })
    ).toMatchObject({ status: "matched", filerId: "FERGB--024" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Robert B. Ferguson" })],
      })
    ).toMatchObject({ status: "matched", filerId: "FERGB--024" });
  });

  it("lets a middle conflict veto a middle-less parenthetical alias on the same summary", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert W. Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [
          summary({
            filerId: "FERGB--024",
            committeeId: "36704",
            filerName: "Robert B. Ferguson (Robert Ferguson)",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("treats a bare V as a middle initial, not a generational suffix", () => {
    // Shared policy (GENERATIONAL_SUFFIX_RANK in finance/personNameMiddleEvidence.ts)
    // deliberately excludes "V": it is far more often a middle initial than a
    // fifth-generation suffix, so it must stay as middle evidence on either side.
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert V. Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Ferguson, Robert B." })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert B. Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Ferguson, Robert V" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert V. Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Ferguson, Robert V" })],
      })
    ).toMatchObject({ status: "matched", filerId: "FERGB--024" });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Robert Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ filerId: "FERGB--024", committeeId: "36704", filerName: "Ferguson, Robert V" })],
      })
    ).toMatchObject({ status: "matched", filerId: "FERGB--024" });
  });

  it("matches exactly one active Washington candidate committee by public parenthetical name", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Bob Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [
          summary({
            filerId: "FERGB--024",
            committeeId: "36704",
            filerName: "Bob Ferguson",
            candidateCommitteeStatus: "Candidate withdrew",
            activeCandidate: false,
            hasReports: false,
          }),
          summary({ filerId: "FERGR *115" }),
          summary({ filerId: "OTHER", committeeId: "999", filerName: "Other Person" }),
        ],
      })
    ).toEqual({
      status: "matched",
      filerId: "FERGR *115",
      committeeId: "32311",
      committeeName: "Robert W. Ferguson (Bob Ferguson)",
      candidacyId: "689556",
      contributionsAmount: 14668288.73,
      confidence: "exact",
      source: "pdc_api",
      sourceUrl: "https://my.pdc.wa.gov/registration/public/-/#/public/registration/59793",
      matchedSummaryRowCount: 1,
    });
  });

  it("matches Supreme Court justices filed as STATE SUPREME COURT JUSTICE", () => {
    // Live PDC 2026 row for VoteApp "Colleen Melody" (statewide State Level Judge).
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Colleen Melody",
        officeScope: "statewide",
        officeName: "State Level Judge",
        electionYear: 2026,
        summaries: [
          summary({
            filerId: "MELOC--109",
            committeeId: "40001",
            filerName: "Colleen M. Melody (Colleen Melody)",
            office: "STATE SUPREME COURT JUSTICE",
            jurisdiction: "SUPREME COURT",
            position: "1",
            electionYear: 2026,
          }),
          summary({
            filerId: "EDWAS--001",
            committeeId: "40002",
            filerName: "Scott M. Edwards (Scott Edwards)",
            office: "STATE SUPREME COURT JUSTICE",
            jurisdiction: "SUPREME COURT",
            position: "1",
            electionYear: 2026,
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "MELOC--109", committeeId: "40001" });
  });

  it("matches a filer name with doubled spaces", () => {
    // Live PDC 2026: "DEBRA Jean  ENTENMAN (DEBRA ENTENMAN)", LD 47.
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Debra Jean Entenman",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        legislativeDistrict: "47",
        electionYear: 2026,
        summaries: [
          summary({
            filerId: "ENTED--001",
            committeeId: "40003",
            filerName: "DEBRA Jean  ENTENMAN (DEBRA ENTENMAN)",
            office: "STATE REPRESENTATIVE",
            legislativeDistrict: "47",
            electionYear: 2026,
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "40003" });
  });

  it("matches legislative committees only when the expected district matches", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        legislativeDistrict: "9",
        electionYear: 2024,
        summaries: [
          summary({
            filerId: "DOEJ--101",
            committeeId: "4001",
            filerName: "Jane Doe",
            office: "STATE REPRESENTATIVE",
            legislativeDistrict: "09",
          }),
          summary({
            filerId: "DOEJ--102",
            committeeId: "4002",
            filerName: "Jane Doe",
            office: "STATE REPRESENTATIVE",
            legislativeDistrict: "10",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "DOEJ--101",
      committeeId: "4001",
    });
  });

  it("requires districts for legislative offices", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2024,
        summaries: [summary({ filerName: "Jane Doe", office: "STATE SENATOR", legislativeDistrict: "01" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "STATE SENATOR",
    });
  });

  it("matches city-council committees only on jurisdiction and seat agreement", () => {
    const councilSummary = (overrides: Partial<WashingtonPdcCandidateSummary>) =>
      summary({
        filerName: "Neeloofar Jenks (Nilu Jenks)",
        office: "CITY COUNCIL MEMBER",
        jurisdiction: "CITY OF SEATTLE",
        jurisdictionType: "Local",
        position: "5",
        electionYear: 2026,
        ...overrides,
      });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Nilu Jenks",
        officeScope: "place",
        officeName: "City Council Member",
        electionYear: 2026,
        jurisdiction: "Seattle city, Washington",
        position: "5",
        summaries: [
          councilSummary({ filerId: "JENKN--778", committeeId: "40861" }),
          // Same name, same office, wrong seat: must not match.
          councilSummary({ filerId: "JENKN--779", committeeId: "40900", position: "2" }),
          // Same name and seat but a different city: must not match.
          councilSummary({ filerId: "JENKN--780", committeeId: "40901", jurisdiction: "CITY OF KENT" }),
          // The PAC trap ("Katie Wilson for an Affordable Seattle" pattern):
          // non-Candidate committee categories never link as candidate money.
          councilSummary({
            filerId: "SEATN--108",
            committeeId: "40950",
            committeeCategory: "Single Election Committee",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "JENKN--778", committeeId: "40861" });
  });

  it("rejects a composite-seat committee registered for a different seat", () => {
    // Live PDC pattern (Spokane/Puyallup 2025): position is a composite label,
    // not a bare number. A committee registered for District 3 Position 2 must
    // not link to our District 1 election even though name, city, year, and
    // office all agree.
    const compositeSummary = summary({
      filerId: "DOEJ--300",
      committeeId: "5001",
      filerName: "Jane Doe",
      office: "CITY COUNCIL MEMBER",
      jurisdiction: "CITY OF SPOKANE",
      jurisdictionType: "Local",
      position: "City Council Member District 3, Position 2",
      electionYear: 2025,
    });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "City Council Member",
        electionYear: 2025,
        jurisdiction: "Spokane city, Washington",
        position: "1",
        summaries: [compositeSummary],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    // Same composite seat on both sides still matches.
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "City Council Member",
        electionYear: 2025,
        jurisdiction: "Spokane city, Washington",
        position: "3-2",
        summaries: [compositeSummary],
      })
    ).toMatchObject({ status: "matched", filerId: "DOEJ--300" });
  });

  it("matches municipal-court judges through the court jurisdiction spelling", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Garmon Newsom",
        officeScope: "place",
        officeName: "Place Level Judge",
        electionYear: 2026,
        jurisdiction: "Seattle city, Washington",
        position: "5",
        summaries: [
          summary({
            filerId: "NEWSG--159",
            committeeId: "41631",
            filerName: "Garmon Newsom II (Garmon Newsom)",
            office: "MUNICIPAL COURT JUDGE",
            jurisdiction: "SEATTLE MUNICIPAL COURT",
            jurisdictionType: "Judicial",
            position: "5",
            electionYear: 2026,
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "NEWSG--159", committeeId: "41631" });
  });

  it("matches a mayor without any seat and requires the jurisdiction input", () => {
    const mayorSummary = summary({
      filerId: "WILSK--949",
      committeeId: "39876",
      filerName: "Katie Wilson",
      office: "MAYOR",
      jurisdiction: "CITY OF SEATTLE",
      jurisdictionType: "Local",
      electionYear: 2025,
    });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Katie Wilson",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2025,
        jurisdiction: "Seattle city, Washington",
        summaries: [mayorSummary],
      })
    ).toMatchObject({ status: "matched", filerId: "WILSK--949" });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Katie Wilson",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2025,
        summaries: [mayorSummary],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_jurisdiction",
      candidateNameNormalized: "KATIE WILSON",
      officeNameNormalized: "MAYOR",
    });
  });

  it("does not guess when multiple active committees match", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Secretary of State",
        electionYear: 2024,
        summaries: [
          summary({ filerId: "DOEJ--101", committeeId: "4001", filerName: "Jane Doe", office: "SECRETARY OF STATE" }),
          summary({ filerId: "DOEJ--102", committeeId: "4002", filerName: "Jane Doe", office: "SECRETARY OF STATE" }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "SECRETARY OF STATE",
      matches: [
        { filerId: "DOEJ--101", committeeId: "4001" },
        { filerId: "DOEJ--102", committeeId: "4002" },
      ],
    });
  });

  it("does not merge distinct committees that share the same filer id", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Secretary of State",
        electionYear: 2024,
        summaries: [
          summary({ filerId: "DOEJ--101", committeeId: "4001", filerName: "Jane Doe", office: "SECRETARY OF STATE" }),
          summary({
            filerId: "DOEJ--101",
            committeeId: "4002",
            filerName: "Jane Doe",
            office: "SECRETARY OF STATE",
          }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      matches: [
        { filerId: "DOEJ--101", committeeId: "4001" },
        { filerId: "DOEJ--101", committeeId: "4002" },
      ],
    });
  });

  it("returns unmatched for unsupported offices, missing names, inactive rows, and typos", () => {
    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "county",
        officeName: "County Sheriff",
        electionYear: 2024,
        summaries: [summary({ filerName: "Jane Doe", office: "COUNTY SHERIFF" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "unsupported_office" });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "   ",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
      officeNameNormalized: "GOVERNOR",
    });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Bob Fergusson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary()],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveWashingtonCandidateCommittee({
        candidateName: "Bob Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        summaries: [summary({ candidateCommitteeStatus: "Candidate withdrew", activeCandidate: false })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("rejects invalid election years", () => {
    expect(() =>
      resolveWashingtonCandidateCommittee({
        candidateName: "Bob Ferguson",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 1999,
        summaries: [],
      })
    ).toThrow("Invalid Washington candidate committee election year");
  });

  it("can search PDC summaries and resolve them through the async wrapper", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          filer_id: "FERGR *115",
          committee_id: "32311",
          candidacy_id: "689556",
          filer_name: "Robert W. Ferguson (Bob Ferguson)",
          committee_category: "Candidate",
          political_committee_type: "Candidate",
          candidate_committee_status: "Candidate declared",
          active_candidate: "true",
          has_reports: "true",
          office: "GOVERNOR",
          jurisdiction: "State of Washington",
          jurisdiction_type: "Statewide",
          election_year: "2024",
          contributions_amount: "14668288.73",
          url: { url: "https://my.pdc.wa.gov/registration/public/-/#/public/registration/59793" },
        },
      ]), {
        status: 200,
        statusText: "OK",
      })
    ) as unknown as typeof fetch;

    await expect(
      searchAndResolveWashingtonCandidateCommittee(
        {
          candidateName: "Bob Ferguson",
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2024,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      filerId: "FERGR *115",
      committeeId: "32311",
    });

    const requestUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]));
    expect(requestUrl.origin + requestUrl.pathname).toBe("https://data.wa.gov/resource/3h9x-7bvm.json");
    expect(requestUrl.searchParams.get("$where")).toContain("upper(office) = upper('GOVERNOR')");
  });
});
