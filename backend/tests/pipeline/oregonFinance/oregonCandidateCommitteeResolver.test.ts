import { describe, expect, it } from "vitest";

import {
  resolveOregonCandidateCommitteeFromSearchRows,
  type OregonCandidateCommitteeSearchRow,
} from "../../../src/pipeline/oregonFinance/oregonCandidateCommitteeResolver.js";
import type { OregonOrestarTransactionSearchResultRow } from "../../../src/pipeline/oregonFinance/oregonOrestarParser.js";

function row(overrides: Partial<OregonOrestarTransactionSearchResultRow> = {}): OregonOrestarTransactionSearchResultRow {
  return {
    transactionId: "4458653",
    transactionDate: "10/12/2022",
    status: "Original",
    filerCommitteeName: "Friends of Tina Kotek",
    filerCommitteeId: "4792",
    contributorPayeeName: "John Ramsbacher",
    contributorPayeeOutOfState: false,
    subType: "Cash Contribution",
    amount: 10_000,
    isInKindExpenditure: false,
    detailUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
    committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=4792",
    ...overrides,
  };
}

function directoryRow(overrides: Partial<OregonCandidateCommitteeSearchRow> = {}): OregonCandidateCommitteeSearchRow {
  return {
    filerCommitteeName: "Education First PAC",
    filerCommitteeId: "21727",
    committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21727",
    candidateFirstName: "Courtney",
    candidateLastName: "Bangs",
    candidateOffice: "State Representative District 32",
    activeElection: "2026 General Election",
    ...overrides,
  };
}

describe("oregonCandidateCommitteeResolver", () => {
  it("resolves a unique ORESTAR committee from parsed search rows", () => {
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Tina Kotek",
        searchRows: [row(), row({ transactionId: "4458654" })],
      })
    ).toEqual({
      status: "matched",
      committeeId: "4792",
      committeeName: "Friends of Tina Kotek",
      confidence: "exact",
      source: "orestar_public",
      sourceUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=4792",
      matchedCommitteeRowCount: 2,
    });
  });

  it("does not take a nickname row whose office or district contradicts the race", () => {
    const senateSmith = directoryRow({
      filerCommitteeName: "Daniel Smith for Senate",
      filerCommitteeId: "24101",
      candidateFirstName: "Daniel",
      candidateLastName: "Smith",
      candidateOffice: "State Senator District 8",
    });
    const houseSmith = directoryRow({
      ...senateSmith,
      filerCommitteeName: "Daniel Smith for House",
      filerCommitteeId: "24102",
      candidateOffice: "State Representative District 17",
    });
    const race = {
      candidateName: "Dan Smith",
      electionYear: 2026,
      officeName: "State Lower Chamber Legislator",
      officeScope: "state_lower",
      district: "17",
    };
    expect(resolveOregonCandidateCommitteeFromSearchRows({ ...race, searchRows: [senateSmith] })).toMatchObject({
      status: "no_match",
    });
    expect(resolveOregonCandidateCommitteeFromSearchRows({ ...race, searchRows: [senateSmith, houseSmith] })).toMatchObject({
      status: "matched",
      committeeId: "24102",
    });
    // Free-form office text that names no office or district is not a contradiction.
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        ...race,
        searchRows: [directoryRow({ ...senateSmith, candidateOffice: "Legislature" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "24101" });
  });

  it("matches a formal ORESTAR first name through nicknames, literal names first", () => {
    // Live Oct 2026: VoteApp "Dan Farrington" files as Daniel Farrington.
    const farrington = directoryRow({
      filerCommitteeName: "Farrington for Oregon",
      filerCommitteeId: "24001",
      candidateFirstName: "Daniel",
      candidateLastName: "Farrington",
      candidateOffice: "17th District",
    });
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({ candidateName: "Dan Farrington", searchRows: [farrington] })
    ).toMatchObject({ status: "matched", committeeId: "24001" });

    // A literal "Dan" row wins over a "Daniel" row instead of turning ambiguous.
    const literal = directoryRow({
      filerCommitteeName: "Dan Farrington PAC",
      filerCommitteeId: "24002",
      candidateFirstName: "Dan",
      candidateLastName: "Farrington",
    });
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Dan Farrington",
        searchRows: [farrington, literal],
      })
    ).toMatchObject({ status: "matched", committeeId: "24002" });

    // Unrelated first names still do not match.
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Michael Summers",
        searchRows: [
          directoryRow({
            filerCommitteeName: "Summers for Oregon",
            candidateFirstName: "Matthew",
            candidateLastName: "Summers",
          }),
        ],
      })
    ).toMatchObject({ status: "no_match" });
  });

  it("returns no_match when committee names do not contain the candidate name", () => {
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Tina Kotek",
        searchRows: [row({ filerCommitteeName: "2022 Our Oregon Voter Guide", filerCommitteeId: "22333" })],
      })
    ).toMatchObject({
      status: "no_match",
      matchedCommitteeRowCount: 0,
    });
  });

  it("returns ambiguous when multiple committees match", () => {
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Tina Kotek",
        searchRows: [
          row(),
          row({ filerCommitteeName: "Tina Kotek Victory Fund", filerCommitteeId: "9999" }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      matchedCommitteeRowCount: 2,
      matches: expect.arrayContaining([
        expect.objectContaining({ committeeId: "4792" }),
        expect.objectContaining({ committeeId: "9999" }),
      ]),
    });
  });

  it("matches structured candidate identity when the committee name omits the candidate", () => {
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Courtney Bangs",
        electionYear: 2026,
        officeName: "State Lower Chamber Legislator",
        district: "32",
        searchRows: [directoryRow()],
      })
    ).toEqual({
      status: "matched",
      committeeId: "21727",
      committeeName: "Education First PAC",
      confidence: "candidate_identity",
      source: "orestar_public",
      sourceUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21727",
      matchedCommitteeRowCount: 1,
    });
  });

  it("uses election, office, and district context to disambiguate structured same-name rows", () => {
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Alex Lee",
        electionYear: 2026,
        officeName: "State Lower Chamber Legislator",
        district: "32",
        searchRows: [
          directoryRow({
            filerCommitteeId: "100",
            filerCommitteeName: "Alex Lee Senate Committee",
            candidateFirstName: "Alex",
            candidateLastName: "Lee",
            candidateOffice: "State Senator District 4",
            activeElection: "2024 General Election",
          }),
          directoryRow({
            filerCommitteeId: "200",
            filerCommitteeName: "Future Oregon PAC",
            candidateFirstName: "Alex",
            candidateLastName: "Lee",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeId: "200",
      confidence: "candidate_identity_and_context",
      matchedCommitteeRowCount: 1,
    });
  });

  it("keeps structured same-name matches ambiguous when context cannot separate them", () => {
    expect(
      resolveOregonCandidateCommitteeFromSearchRows({
        candidateName: "Alex Lee",
        electionYear: 2026,
        officeName: "State Lower Chamber Legislator",
        district: "32",
        searchRows: [
          directoryRow({ filerCommitteeId: "100", candidateFirstName: "Alex", candidateLastName: "Lee" }),
          directoryRow({ filerCommitteeId: "200", candidateFirstName: "Alex", candidateLastName: "Lee" }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      matchedCommitteeRowCount: 2,
      matches: expect.arrayContaining([
        expect.objectContaining({ committeeId: "100" }),
        expect.objectContaining({ committeeId: "200" }),
      ]),
    });
  });
});
