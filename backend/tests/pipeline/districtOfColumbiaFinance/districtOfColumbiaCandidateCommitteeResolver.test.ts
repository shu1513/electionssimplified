import { describe, expect, it, vi } from "vitest";

import {
  normalizeDistrictOfColumbiaCandidateNameKeys,
  resolveDistrictOfColumbiaCandidateCommittee,
  searchAndResolveDistrictOfColumbiaCandidateCommittee,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateCommitteeResolver.js";
import type { DistrictOfColumbiaOcfContributionRecord } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaOcfClient.js";

function record(
  overrides: Partial<DistrictOfColumbiaOcfContributionRecord> = {}
): DistrictOfColumbiaOcfContributionRecord {
  return {
    committeeName: "Committee To Elect Jane Doe",
    committeeKey: "COMMITTEE TO ELECT JANE DOE",
    candidateName: "Jane Doe",
    office: "Mayor",
    electionYear: 2026,
    contributorName: "John Smith",
    occupation: "Attorney",
    amount: 100,
    date: "03/01/2026",
    ...overrides,
  };
}

function utf16LeCsv(csv: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
}

describe("districtOfColumbiaCandidateCommitteeResolver", () => {
  it("normalizes direct, comma-form, and suffix candidate names", () => {
    expect([...normalizeDistrictOfColumbiaCandidateNameKeys("DOE, Jane Q. Jr.")]).toEqual([
      "DOE JANE Q",
      "JANE Q DOE",
      "JANE DOE",
    ]);
  });

  it("matches exactly one D.C. candidate committee by candidate, office, and cycle", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record(),
          record({ committeeName: "Other Committee", committeeKey: "OTHER", candidateName: "Other Person" }),
          record({ committeeName: "Old Committee", committeeKey: "OLD", electionYear: 2022 }),
        ],
        sourceUrl: "https://efiling.ocf.dc.gov/DataDownload",
      })
    ).toEqual({
      status: "matched",
      committeeKey: "COMMITTEE TO ELECT JANE DOE",
      committeeName: "Committee To Elect Jane Doe",
      confidence: "exact",
      source: "ocf_export",
      sourceUrl: "https://efiling.ocf.dc.gov/DataDownload",
      matchedContributionRowCount: 1,
    });
  });

  it("can match when candidate name is only supported by the committee name", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: undefined,
            office: undefined,
            committeeName: "Friends of Jane Doe 2026",
            committeeKey: "FRIENDS OF JANE DOE 2026",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeKey: "FRIENDS OF JANE DOE 2026",
    });
  });

  it("rejects a committee-name fallback naming a middle-conflicting namesake", () => {
    // When the row carries no candidateName, matching falls back to
    // committee-name token containment — which accepted "Committee to Elect
    // John B. Smith" for candidate "John A. Smith". The stripped committee
    // text parses as a person name, so the middle gate applies there too.
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: undefined,
            office: undefined,
            committeeName: "Committee to Elect John B. Smith",
            committeeKey: "COMMITTEE TO ELECT JOHN B SMITH",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("rejects a fallback conflict hidden behind office or year designators", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: undefined,
            office: undefined,
            committeeName: "John B. Smith for Mayor 2026",
            committeeKey: "JOHN B SMITH FOR MAYOR 2026",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("keeps a committee-name fallback whose middle corroborates the candidate", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: undefined,
            office: undefined,
            committeeName: "Committee to Elect John Andrew Smith",
            committeeKey: "COMMITTEE TO ELECT JOHN ANDREW SMITH",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeKey: "COMMITTEE TO ELECT JOHN ANDREW SMITH" });
  });

  it("rejects a same-race record whose middle name contradicts the candidate", () => {
    // Same office and cycle — only the middle evidence differs. Without the
    // middle gate this record linked as an "exact" match and attached the
    // other John Smith's contributions.
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: "John B. Smith",
            committeeName: "Smith For DC",
            committeeKey: "SMITH FOR DC",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: "Smith, John Andrew",
            committeeName: "Smith For DC",
            committeeKey: "SMITH FOR DC",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeKey: "SMITH FOR DC" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "John Smith",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: "John B. Smith",
            committeeName: "Smith For DC",
            committeeKey: "SMITH FOR DC",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeKey: "SMITH FOR DC" });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it must stay as
    // middle evidence on either side instead of being stripped as a suffix.
    function resolveAgainstRecordName(candidateName: string, recordCandidateName: string) {
      return resolveDistrictOfColumbiaCandidateCommittee({
        candidateName,
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({
            candidateName: recordCandidateName,
            committeeName: "Smith For DC",
            committeeKey: "SMITH FOR DC",
          }),
        ],
      });
    }

    expect(resolveAgainstRecordName("John V. Smith", "John B. Smith")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolveAgainstRecordName("John B. Smith", "Smith, John V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolveAgainstRecordName("John V. Smith", "Smith, John V")).toMatchObject({
      status: "matched",
      committeeKey: "SMITH FOR DC",
    });
    expect(resolveAgainstRecordName("John Smith", "Smith, John V")).toMatchObject({
      status: "matched",
      committeeKey: "SMITH FOR DC",
    });
  });

  it("requires and enforces D.C. ward or at-large seats for seat-scoped offices", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "City Council Member",
        electionYear: 2026,
        contributionRecords: [record({ office: "Councilmember", seat: "Ward 4" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_seat",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "CITY COUNCIL MEMBER",
    });

    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "City Council Member",
        seat: "Ward 5",
        electionYear: 2026,
        contributionRecords: [record({ office: "Councilmember", seat: "Ward 4" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "City Council Member",
        seat: "Ward 4",
        electionYear: 2026,
        contributionRecords: [record({ office: "Councilmember", seat: "Ward 4" })],
      })
    ).toMatchObject({
      status: "matched",
      committeeKey: "COMMITTEE TO ELECT JANE DOE",
    });
  });

  it("links a state_upper ward Council race through OCF rows that carry no office or seat", () => {
    // OCF's export has no office or seat column; the live Ward 5 committee
    // name omits the ward too (migration 320 moved ward races to state_upper).
    const seatless = record({
      office: undefined,
      seat: undefined,
      electionYear: undefined,
      candidateName: "Zachary Parker",
      committeeName: "Committee to Re - Elect Zachary Parker 2026",
      committeeKey: "COMMITTEE TO RE - ELECT ZACHARY PARKER 2026",
    });
    const resolve = (contributionRecords: DistrictOfColumbiaOcfContributionRecord[]) =>
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Zachary Parker",
        officeScope: "state_upper",
        officeName: "City Council Member",
        seat: "Ward 5 Member of the Council Ward 5 (2024); District of Columbia",
        electionYear: 2026,
        contributionRecords,
      });

    expect(resolve([seatless])).toMatchObject({
      status: "matched",
      committeeKey: "COMMITTEE TO RE - ELECT ZACHARY PARKER 2026",
    });
    // A committee that names another ward stays out.
    expect(
      resolve([{ ...seatless, committeeName: "Parker for Ward 7", committeeKey: "PARKER FOR WARD 7" }])
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
    // A row with no candidate name cannot use the seatless path.
    expect(
      resolve([{ ...seatless, candidateName: undefined }])
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("does not guess when multiple D.C. committees match", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [
          record({ committeeName: "Jane Doe 2026", committeeKey: "JANE DOE 2026" }),
          record({ committeeName: "Friends of Jane Doe", committeeKey: "FRIENDS OF JANE DOE" }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "Mayor",
      matches: [
        { committeeKey: "FRIENDS OF JANE DOE" },
        { committeeKey: "JANE DOE 2026" },
      ],
    });
  });

  it("returns unmatched for unsupported offices, missing names, wrong offices, and invalid years", () => {
    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "City Treasurer",
        electionYear: 2026,
        contributionRecords: [record()],
      })
    ).toMatchObject({ status: "unmatched", reason: "unsupported_office" });

    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "   ",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        contributionRecords: [record()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
      officeNameNormalized: "Mayor",
    });

    expect(
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        contributionRecords: [record({ office: "Mayor" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(() =>
      resolveDistrictOfColumbiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 1999,
        contributionRecords: [],
      })
    ).toThrow("Invalid D.C. candidate committee election year");
  });

  it("searches OCF exports and resolves them through the async wrapper", async () => {
    const csv = [
      "Committee Name,Candidate Name,Office,Seat,Election Year,Contributor Name,Occupation,Amount",
      "Committee To Elect Jane Doe,Jane Doe,Mayor,,2026,John Smith,Attorney,$100.00",
    ].join("\n");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html></html>", { status: 200, statusText: "OK" }))
      .mockResolvedValueOnce(new Response("<div>results</div>", { status: 200, statusText: "OK" }))
      .mockResolvedValueOnce(new Response(utf16LeCsv(csv), { status: 200, statusText: "OK" })) as unknown as typeof fetch;

    await expect(
      searchAndResolveDistrictOfColumbiaCandidateCommittee(
        {
          candidateName: "Jane Doe",
          officeScope: "place",
          officeName: "Mayor",
          electionYear: 2026,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      committeeKey: "COMMITTEE TO ELECT JANE DOE",
      committeeName: "Committee To Elect Jane Doe",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const submitInit = vi.mocked(fetchImpl).mock.calls[1]?.[1];
    expect(String(submitInit?.body)).toContain("FilerTypeId=2");
    expect(String(submitInit?.body)).toContain("FromDate=01%2F01%2F2025");
    expect(String(submitInit?.body)).toContain("ToDate=12%2F31%2F2026");
  });
});
