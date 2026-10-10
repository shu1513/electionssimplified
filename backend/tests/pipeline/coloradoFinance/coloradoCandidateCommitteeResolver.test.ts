import { describe, expect, it } from "vitest";

import {
  normalizeColoradoCandidateNameKeys,
  resolveColoradoCandidateCommittee,
} from "../../../src/pipeline/coloradoFinance/coloradoCandidateCommitteeResolver.js";
import type { ColoradoTracerContributionRow } from "../../../src/pipeline/coloradoFinance/coloradoTracerContributionReader.js";

function contribution(overrides: Partial<ColoradoTracerContributionRow> = {}): ColoradoTracerContributionRow {
  return {
    CO_ID: "202650001",
    ContributionAmount: "100.00",
    ContributionDate: "01/10/2026",
    LastName: "Doe",
    FirstName: "Jane",
    MI: "",
    Suffix: "",
    Address1: "",
    Address2: "",
    City: "Denver",
    State: "CO",
    Zip: "80203",
    Explanation: "",
    RecordID: "R1",
    FiledDate: "02/01/2026",
    ContributionType: "Monetary",
    ReceiptType: "Contribution",
    ContributorType: "Individual",
    Electioneering: "",
    CommitteeType: "Candidate Committee",
    CommitteeName: "Jane Doe for Colorado Governor",
    CandidateName: "Jane Doe",
    Employer: "Acme Inc",
    Occupation: "Engineer",
    Amended: "False",
    Amendment: "",
    AmendedRecordID: "",
    Jurisdiction: "STATEWIDE",
    OccupationComments: "",
    ...overrides,
  };
}

describe("coloradoCandidateCommitteeResolver", () => {
  it("normalizes direct and comma-form candidate names", () => {
    expect([...normalizeColoradoCandidateNameKeys("DOE, Jane Q.")]).toEqual([
      "DOE JANE Q",
      "JANE Q DOE",
    ]);
  });

  it("matches exactly one candidate committee for the candidate and cycle", () => {
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2026,
        sourceUrl: "https://tracer.sos.colorado.gov/",
        contributionRows: [
          contribution({ CandidateName: "DOE, JANE" }),
          contribution({ CO_ID: "999", CandidateName: "Other Person" }),
          contribution({ CO_ID: "888", CandidateName: "Jane Doe", CommitteeType: "Issue Committee" }),
          contribution({ CO_ID: "777", CandidateName: "Jane Doe", ContributionDate: "01/10/2024" }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "202650001",
      committeeName: "Jane Doe for Colorado Governor",
      sourceUrl: "https://tracer.sos.colorado.gov/",
    });
  });

  it("does not guess when multiple candidate committees match", () => {
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2026,
        contributionRows: [
          contribution(),
          contribution({
            CO_ID: "202650002",
            CommitteeName: "Coloradans for Jane Doe",
            CandidateName: "Jane Doe",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
    });
  });

  it("recovers a row when only the candidate side carries a middle", () => {
    // Full-string keys never overlap here ("JANE Q DOE" vs "JANE DOE"), which
    // silently stranded the link before the middle-evidence fallback.
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Q. Doe",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toMatchObject({ status: "matched", committeeId: "202650001" });
  });

  it("recovers a row when only the TRACER side carries a middle", () => {
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Doe, Jane Q." })],
      })
    ).toMatchObject({ status: "matched", committeeId: "202650001" });
  });

  it("still refuses a row whose middle name contradicts the candidate", () => {
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Q. Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Doe, Jane R." })],
      })
    ).toEqual({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it must stay as
    // middle evidence on either side instead of being stripped as a suffix.
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane V. Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Doe, Jane R." })],
      })
    ).toEqual({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane R. Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Doe, Jane V" })],
      })
    ).toEqual({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane V. Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Doe, Jane V" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "202650001" });

    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Doe, Jane V" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "202650001" });
  });

  it("rejects a fallback row whose second middle name contradicts the candidate", () => {
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "John Michael Andrew Smith",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Smith, John Michael Bernard" })],
      })
    ).toEqual({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("recovers a compound-surname row despite the shorter-split parse", () => {
    // The wrong "DYKE" split would read VAN as a middle and manufacture a
    // conflict; the longest aligned surname ("VAN DYKE") is weak and matches.
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Mary Van Dyke",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Mary B Van Dyke" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "202650001" });
  });

  it("returns unmatched when there is no candidate committee match", () => {
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "Other Person" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
  });

  it("matches TRACER's formal first name through a VoteApp nickname", () => {
    // Live: "PHIL WEISER FOR COLORADO" rows carry CandidateName "PHILIP WEISER".
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Phil Weiser",
        electionYear: 2026,
        contributionRows: [
          contribution({ CO_ID: "20255047944", CommitteeName: "PHIL WEISER FOR COLORADO", CandidateName: "PHILIP WEISER", CommitteeType: "Candidate Committee", ContributionDate: "2026-01-01 00:00:00" }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "20255047944" });
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Phil Weiser",
        electionYear: 2026,
        contributionRows: [
          contribution({ CO_ID: "1", CommitteeName: "WEISER FOR COLORADO", CandidateName: "PETER WEISER", CommitteeType: "Candidate Committee", ContributionDate: "2026-01-01 00:00:00" }),
        ],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("collapses same-name committee ids to the one with the most cycle rows", () => {
    const rows = [
      contribution({ CO_ID: "20175032081", CommitteeName: "PHIL WEISER FOR COLORADO", CandidateName: "PHILIP JACOB WEISER", CommitteeType: "Candidate Committee", ContributionDate: "2025-01-03 00:00:00" }),
      contribution({ CO_ID: "20255047944", CommitteeName: "PHIL WEISER FOR COLORADO", CandidateName: "PHILIP WEISER", CommitteeType: "Candidate Committee", ContributionDate: "2026-01-01 00:00:00" }),
      contribution({ CO_ID: "20255047944", CommitteeName: "PHIL WEISER FOR COLORADO", CandidateName: "PHILIP WEISER", CommitteeType: "Candidate Committee", ContributionDate: "2026-01-02 00:00:00" }),
    ];
    expect(resolveColoradoCandidateCommittee({ candidateName: "Phil Weiser", electionYear: 2026, contributionRows: rows })).toMatchObject({
      status: "matched",
      committeeId: "20255047944",
    });
    expect(
      resolveColoradoCandidateCommittee({
        candidateName: "Phil Weiser",
        electionYear: 2026,
        contributionRows: [...rows, contribution({ CO_ID: "1", CommitteeName: "FRIENDS OF PHIL WEISER", CandidateName: "PHILIP WEISER", CommitteeType: "Candidate Committee", ContributionDate: "2026-01-02 00:00:00" })],
      })
    ).toMatchObject({ status: "ambiguous" });
  });
});
