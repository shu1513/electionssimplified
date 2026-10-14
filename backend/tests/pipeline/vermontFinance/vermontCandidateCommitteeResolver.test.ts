import { describe, expect, it, vi } from "vitest";

import {
  buildVermontCandidateSearchPhrases,
  normalizeVermontCandidateNameKeys,
  resolveVermontCandidateCommittee,
  searchAndResolveVermontCandidateCommittee,
  type VermontCandidateCommitteeTransactionRow,
} from "../../../src/pipeline/vermontFinance/vermontCandidateCommitteeResolver.js";
import {
  isVermontFinanceEligibleOffice,
  mapVermontOfficeSought,
  toVermontOfficeSearchInput,
} from "../../../src/pipeline/vermontFinance/vermontFinanceEligibleOffices.js";

function transactionRow(
  overrides: Partial<VermontCandidateCommitteeTransactionRow> = {}
): VermontCandidateCommitteeTransactionRow {
  return {
    transactionId: 1001,
    guid: "transaction-guid-1",
    filerRegistrationGuid: "f174929e-e5ba-4e8a-ab5b-54661c3c5c88",
    filerName: "SCOTT, PHIL",
    filerTypeCode: "CAN",
    filerTypeDescription: "Candidate",
    electionYear: 2024,
    electionId: 35,
    officeId: 19,
    officeType: "OTSTW",
    entityId: 33545,
    reportName: "07/01/2024 - PRIMARY",
    candidateFirstName: "PHIL",
    candidateMiddleName: null,
    candidateLastName: "SCOTT",
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, statusText: "OK" });
}

function emptyPagedResponse(): Response {
  return jsonResponse({ data: { items: [], totalItems: 0 }, succeeded: true, error: null });
}

describe("vermontFinanceEligibleOffices", () => {
  it("maps app offices to Vermont office sought IDs", () => {
    expect(toVermontOfficeSearchInput({ officeScope: "statewide", officeCanonicalName: "Governor" })).toEqual({
      officeId: 19,
      officeName: "Governor",
    });
    expect(toVermontOfficeSearchInput({ officeScope: "statewide", officeCanonicalName: "State Auditor" })).toEqual({
      officeId: 23,
      officeName: "Auditor of Accounts",
    });
    expect(toVermontOfficeSearchInput({ officeScope: "state_lower", officeCanonicalName: "State Lower Chamber Legislator" })).toEqual({
      officeId: 7,
      officeName: "State Representative",
    });
    expect(isVermontFinanceEligibleOffice({ officeScope: "county", officeCanonicalName: "Sheriff" })).toBe(false);
    expect(mapVermontOfficeSought({ officeId: 19 })).toMatchObject({
      officeScope: "statewide",
      officeCanonicalName: "Governor",
      officeName: "Governor",
    });
  });
});

describe("vermontCandidateCommitteeResolver", () => {
  it("normalizes direct, comma-form, and parenthetical candidate names", () => {
    expect([...normalizeVermontCandidateNameKeys("SCOTT, Phil (Phil Scott)")]).toEqual([
      "SCOTT PHIL",
      "PHIL SCOTT",
    ]);
    expect(buildVermontCandidateSearchPhrases("Phil Scott")).toEqual(["Phil Scott", "SCOTT", "SCOTT, PHIL"]);
  });

  it("rejects a same-race row whose middle name contradicts the candidate", () => {
    // Same office and election year — only the middle evidence differs.
    // Without the middle gate this row linked as an "exact" match and attached
    // the other Phil Scott's finance records.
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil A. Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL B",
            candidateMiddleName: "B",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil B. Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL BRIAN",
            candidateMiddleName: "BRIAN",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerRegistrationGuid: "other-guid" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL B",
            candidateMiddleName: "B",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerRegistrationGuid: "other-guid" });
  });

  it("lets a middle conflict veto a middle-less sibling name on the same row", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil A. Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "PHIL SCOTT",
            candidateMiddleName: "B",
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
      resolveVermontCandidateCommittee({
        candidateName: "Phil V. Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL B",
            candidateMiddleName: "B",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil B. Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL V",
            candidateMiddleName: "V",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil V. Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL V",
            candidateMiddleName: "V",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerRegistrationGuid: "other-guid" });

    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "SCOTT, PHIL V",
            candidateMiddleName: "V",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerRegistrationGuid: "other-guid" });
  });

  it("matches exactly one Vermont candidate filer by candidate name, office, and election year", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "other-guid",
            filerName: "OTHER, CANDIDATE",
            candidateFirstName: "OTHER",
            candidateLastName: "CANDIDATE",
          }),
          transactionRow(),
          transactionRow({ filerTypeCode: "PAC", filerTypeDescription: "Political Committee" }),
        ],
      })
    ).toEqual({
      status: "matched",
      filerRegistrationGuid: "f174929e-e5ba-4e8a-ab5b-54661c3c5c88",
      filerName: "SCOTT, PHIL",
      candidateName: "PHIL SCOTT",
      officeId: 19,
      officeName: "Governor",
      officeDisplayName: "Governor",
      electionYear: 2024,
      electionId: 35,
      entityId: 33545,
      reportName: "07/01/2024 - PRIMARY",
      confidence: "exact",
      source: "vermont_public_transactions",
      sourceUrl: "https://campaignfinance.vermont.gov/",
      matchedTransactionRowCount: 1,
    });
  });

  it("returns canonical office names so matched resolutions can round-trip through the resolver", () => {
    const resolution = resolveVermontCandidateCommittee({
      candidateName: "Jane Auditor",
      officeScope: "statewide",
      officeName: "State Auditor",
      electionYear: 2026,
      transactionRows: [
        transactionRow({
          filerRegistrationGuid: "auditor-guid",
          filerName: "AUDITOR, JANE",
          candidateFirstName: "JANE",
          candidateLastName: "AUDITOR",
          officeId: 23,
          electionYear: 2026,
        }),
      ],
    });

    expect(resolution).toMatchObject({
      status: "matched",
      officeId: 23,
      officeName: "State Auditor",
      officeDisplayName: "Auditor of Accounts",
    });
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Jane Auditor",
        officeScope: "statewide",
        officeName: resolution.status === "matched" ? resolution.officeName : "",
        electionYear: 2026,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "auditor-guid",
            filerName: "AUDITOR, JANE",
            candidateFirstName: "JANE",
            candidateLastName: "AUDITOR",
            officeId: 23,
            electionYear: 2026,
          }),
        ],
      })
    ).toMatchObject({ status: "matched", officeName: "State Auditor" });
  });

  it("matches using Vermont comma-form filer names when candidate name fields are missing", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [
          transactionRow({
            candidateFirstName: null,
            candidateLastName: null,
            candidateMiddleName: null,
          }),
        ],
      })
    ).toMatchObject({ status: "matched", filerRegistrationGuid: "f174929e-e5ba-4e8a-ab5b-54661c3c5c88" });
  });

  it("filters non-candidate filers, wrong offices, wrong years, missing office IDs, and typos", () => {
    const baseInput = {
      candidateName: "Phil Scott",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2024,
    };

    expect(
      resolveVermontCandidateCommittee({
        ...baseInput,
        transactionRows: [transactionRow({ filerTypeCode: "PAC", filerTypeDescription: "Political Committee" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(resolveVermontCandidateCommittee({ ...baseInput, transactionRows: [transactionRow({ officeId: 20 })] })).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });

    expect(resolveVermontCandidateCommittee({ ...baseInput, transactionRows: [transactionRow({ electionYear: 2022 })] })).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });

    expect(resolveVermontCandidateCommittee({ ...baseInput, transactionRows: [transactionRow({ officeId: null })] })).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });

    expect(resolveVermontCandidateCommittee({ ...baseInput, candidateName: "Phil Scot", transactionRows: [transactionRow()] })).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
  });

  it("returns unmatched for unsupported offices and missing names", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "county",
        officeName: "Sheriff",
        electionYear: 2024,
        transactionRows: [transactionRow()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: "PHIL SCOTT",
      officeNameNormalized: "SHERIFF",
    });

    expect(
      resolveVermontCandidateCommittee({
        candidateName: "   ",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2024,
        transactionRows: [transactionRow()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
      officeNameNormalized: "Governor",
    });
  });

  it("does not guess when multiple Vermont filer registrations match", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        transactionRows: [
          transactionRow({
            filerRegistrationGuid: "candidate-guid-1",
            filerName: "DOE, JANE",
            candidateFirstName: "JANE",
            candidateLastName: "DOE",
            officeId: 24,
            electionYear: 2026,
          }),
          transactionRow({
            filerRegistrationGuid: "candidate-guid-2",
            filerName: "JANE DOE",
            candidateFirstName: "JANE",
            candidateLastName: "DOE",
            officeId: 24,
            electionYear: 2026,
          }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "Attorney General",
      matches: [{ filerRegistrationGuid: "candidate-guid-1" }, { filerRegistrationGuid: "candidate-guid-2" }],
    });
  });

  it("selects a dominant Vermont filer registration when one match has almost all rows", () => {
    const dominantRows = Array.from({ length: 30 }, (_value, index) =>
      transactionRow({
        transactionId: 2000 + index,
        guid: `dominant-row-${index}`,
        filerRegistrationGuid: "dominant-guid",
        filerName: "SCOTT, PHIL",
        candidateFirstName: "PHIL",
        candidateLastName: "SCOTT",
        officeId: 19,
        electionYear: 2022,
        electionId: 24,
        reportName: "03/15/2022 - GENERAL",
      })
    );

    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2022,
        transactionRows: [
          ...dominantRows,
          transactionRow({
            transactionId: 3001,
            guid: "later-tail-row",
            filerRegistrationGuid: "tail-guid",
            filerName: "SCOTT, PHIL",
            candidateFirstName: "PHIL",
            candidateLastName: "SCOTT",
            officeId: 19,
            electionYear: 2022,
            electionId: 35,
            reportName: "07/01/2023 - GENERAL",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerRegistrationGuid: "dominant-guid",
      matchedTransactionRowCount: 30,
    });
  });

  it("groups duplicate transaction rows with the same filer registration guid", () => {
    expect(
      resolveVermontCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "State Treasurer",
        electionYear: 2026,
        transactionRows: [
          transactionRow({
            transactionId: 1,
            guid: "row-1",
            filerRegistrationGuid: "candidate-guid-1",
            filerName: "DOE, JANE",
            candidateFirstName: "JANE",
            candidateLastName: "DOE",
            officeId: 21,
            electionYear: 2026,
          }),
          transactionRow({
            transactionId: 2,
            guid: "row-2",
            filerRegistrationGuid: "candidate-guid-1",
            filerName: "JANE DOE",
            candidateFirstName: "JANE",
            candidateLastName: "DOE",
            officeId: 21,
            electionYear: 2026,
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerRegistrationGuid: "candidate-guid-1",
      matchedTransactionRowCount: 2,
    });
  });

  it("rejects invalid election years", () => {
    expect(() =>
      resolveVermontCandidateCommittee({
        candidateName: "Phil Scott",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 1999,
        transactionRows: [],
      })
    ).toThrow("Invalid Vermont candidate committee election year");
  });

  it("resolves a candidate beyond 2,500 rows in a broad last-name search", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        filerName?: string;
        transactionTypeCode?: string;
        pageNumber?: number;
        pageSize: number;
      };
      const offset = ((body.pageNumber ?? 1) - 1) * body.pageSize;
      if (body.filerName === "SCOTT" && body.transactionTypeCode === "TCON" && offset < 3000) {
        return Promise.resolve(
          jsonResponse({
            data: {
              items: Array.from({ length: body.pageSize }, (_value, index) => ({
                  transactionID: 91000 + offset + index,
                  guid: `non-match-${offset + index + 1}`,
                  filerRegistrationGuid: `other-guid-${offset + index + 1}`,
                  filerName: "SCOTT, OTHER",
                  transactionAmount: 1000,
                  filerTypeCode: "CAN",
                  filerTypeDescription: "Candidate",
                  electionYear: 2024,
                  electionId: 35,
                  officeID: 19,
                  entityId: 22222,
                  candidateFirstName: "OTHER",
                  candidateLastName: "SCOTT",
                })),
              totalItems: 3001,
            },
            succeeded: true,
            error: null,
          })
        );
      }
      if (body.filerName === "SCOTT" && body.transactionTypeCode === "TCON") {
        return Promise.resolve(
          jsonResponse({
            data: {
              items: [
                {
                  transactionID: 90013,
                  guid: "transaction-guid-1",
                  filerRegistrationGuid: "f174929e-e5ba-4e8a-ab5b-54661c3c5c88",
                  filerName: "SCOTT, PHIL",
                  transactionAmount: 1000,
                  filerTypeCode: "CAN",
                  filerTypeDescription: "Candidate",
                  electionYear: 2024,
                  electionId: 35,
                  officeID: 19,
                  officeType: "OTSTW",
                  entityId: 33545,
                  reportName: "07/01/2024 - PRIMARY",
                  candidateFirstName: "PHIL",
                  candidateLastName: "SCOTT",
                },
              ],
              totalItems: 3001,
            },
            succeeded: true,
            error: null,
          })
        );
      }
      return Promise.resolve(emptyPagedResponse());
    }) as unknown as typeof fetch;

    await expect(
      searchAndResolveVermontCandidateCommittee(
        {
          candidateName: "Phil Scott",
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2024,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      filerRegistrationGuid: "f174929e-e5ba-4e8a-ab5b-54661c3c5c88",
      officeId: 19,
      electionYear: 2024,
    });

    const requestBodies = vi
      .mocked(fetchImpl)
      .mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>);
    expect(requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filerName: "Phil Scott", transactionTypeCode: "TCON", electionYear: 2024 }),
        expect.objectContaining({ filerName: "SCOTT", transactionTypeCode: "TCON", electionYear: 2024, pageNumber: 1 }),
        expect.objectContaining({ filerName: "SCOTT", transactionTypeCode: "TCON", electionYear: 2024, pageNumber: 4 }),
        expect.objectContaining({ filerName: "SCOTT, PHIL", transactionTypeCode: "TEXP", electionYear: 2024 }),
      ])
    );
  });
});
