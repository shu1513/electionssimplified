import { describe, expect, it, vi } from "vitest";

import {
  normalizeVirginiaCandidateNameKeys,
  resolveVirginiaCandidateCommittee,
  searchAndResolveVirginiaCandidateCommittee,
} from "../../../src/pipeline/virginiaFinance/virginiaCandidateCommitteeResolver.js";
import type {
  VirginiaCommitteeSearchResult,
  VirginiaReportHeader,
} from "../../../src/pipeline/virginiaFinance/virginiaCampaignFinanceClient.js";

function committee(overrides: Partial<VirginiaCommitteeSearchResult> = {}): VirginiaCommitteeSearchResult {
  return {
    committeeId: "60e10dc7-c59e-4a79-afca-e688c1efed65",
    committeeName: "Spanberger for Governor",
    candidateName: "Abigail Spanberger",
    committeeType: "Candidate Campaign Committee",
    reportsUrl: "https://cfreports.elections.virginia.gov/Committee/Index/60e10dc7-c59e-4a79-afca-e688c1efed65",
    sourceUrl: "https://cfreports.elections.virginia.gov/?CommitteeName=Spanberger",
    ...overrides,
  };
}

function header(overrides: Partial<VirginiaReportHeader> = {}): VirginiaReportHeader {
  return {
    committeeCode: "CC-23-02436",
    committeeName: "Spanberger for Governor",
    reportYear: 2025,
    reportType: "Scheduled",
    filingDate: "2026-01-15",
    startDate: "2025-10-24",
    endDate: "2025-11-27",
    electionCycle: "11/2025",
    officeSought: "Governor",
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, statusText: "OK" });
}

describe("virginiaCandidateCommitteeResolver", () => {
  it("normalizes direct, comma-form, and parenthetical candidate names", () => {
    expect([...normalizeVirginiaCandidateNameKeys("SPANBERGER, Abigail (Abby Spanberger)")]).toEqual([
      "SPANBERGER ABIGAIL",
      "ABIGAIL SPANBERGER",
      "ABBY SPANBERGER",
    ]);
  });

  it("rejects a same-race committee whose middle name contradicts the candidate", () => {
    // Same eligible office and year — only the middle evidence differs.
    // Without the middle gate this committee linked as an "exact" match and
    // attached the other Spanberger's finance records.
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail A. Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [
          committee({
            committeeId: "other",
            candidateName: "Spanberger, Abigail B.",
            committeeName: "Spanberger for Governor",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail B. Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee({ committeeId: "other", candidateName: "Spanberger, Abigail Bernice" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "other" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee({ committeeId: "other", candidateName: "Spanberger, Abigail B." })],
      })
    ).toMatchObject({ status: "matched", committeeId: "other" });
  });

  it("lets a middle conflict veto a middle-less sibling name on the same result", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail A. Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [
          committee({
            committeeId: "other",
            candidateName: "Spanberger, Abigail B.",
            committeeName: "Abigail Spanberger",
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
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail V. Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee({ committeeId: "other", candidateName: "Spanberger, Abigail B." })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail B. Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee({ committeeId: "other", candidateName: "Spanberger, Abigail V" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail V. Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee({ committeeId: "other", candidateName: "Spanberger, Abigail V" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "other" });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee({ committeeId: "other", candidateName: "Spanberger, Abigail V" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "other" });
  });

  it("matches exactly one Virginia candidate committee by name and eligible office", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee(), committee({ committeeId: "other", candidateName: "Other Person" })],
      })
    ).toEqual({
      status: "matched",
      committeeId: "60e10dc7-c59e-4a79-afca-e688c1efed65",
      committeeName: "Spanberger for Governor",
      committeeCode: null,
      candidateName: "Abigail Spanberger",
      confidence: "exact",
      source: "cfreports_search",
      sourceUrl: "https://cfreports.elections.virginia.gov/?CommitteeName=Spanberger",
      matchedReportHeaderCount: 0,
    });
  });

  it("uses report headers to verify office, election cycle, and committee code when provided", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee()],
        reportHeaders: [
          header({ electionCycle: "11/2021" }),
          header({ officeSought: "Attorney General" }),
          header(),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "60e10dc7-c59e-4a79-afca-e688c1efed65",
      committeeName: "Spanberger for Governor",
      committeeCode: "CC-23-02436",
      candidateName: "Abigail Spanberger",
      confidence: "exact",
      source: "cfreports_search",
      sourceUrl: "https://cfreports.elections.virginia.gov/?CommitteeName=Spanberger",
      matchedReportHeaderCount: 1,
    });
  });

  it("maps Virginia legislative report office labels to canonical app offices", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2025,
        committeeResults: [committee({ committeeName: "Jane Doe for Delegate", candidateName: "Jane Doe" })],
        reportHeaders: [
          header({
            committeeName: "Jane Doe for Delegate",
            officeSought: "House of Delegates",
            electionCycle: "11/2025",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeName: "Jane Doe for Delegate",
      matchedReportHeaderCount: 1,
    });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2025,
        committeeResults: [committee({ committeeName: "Jane Doe for Senate", candidateName: "Jane Doe" })],
        reportHeaders: [
          header({
            committeeName: "Jane Doe for Senate",
            officeSought: "Senate",
            electionCycle: "11/2025",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeName: "Jane Doe for Senate",
      matchedReportHeaderCount: 1,
    });
  });

  it("does not guess when multiple candidate committees match", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2025,
        committeeResults: [
          committee({
            committeeId: "a",
            committeeName: "Jane Doe for Attorney General",
            candidateName: "Jane Doe",
          }),
          committee({
            committeeId: "b",
            committeeName: "Friends of Jane Doe",
            candidateName: "Jane Doe",
          }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "Attorney General",
      matches: [{ committeeId: "a" }, { committeeId: "b" }],
    });
  });

  it("returns unmatched for unsupported offices, missing names, typos, and report metadata mismatches", () => {
    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "county",
        officeName: "Sheriff",
        electionYear: 2025,
        committeeResults: [committee({ candidateName: "Jane Doe" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "unsupported_office" });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "   ",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
      officeNameNormalized: "Governor",
    });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spamburger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee()],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2025,
        committeeResults: [committee()],
        reportHeaders: [header({ officeSought: "Attorney General" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("rejects invalid election years", () => {
    expect(() =>
      resolveVirginiaCandidateCommittee({
        candidateName: "Abigail Spanberger",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 1999,
        committeeResults: [],
      })
    ).toThrow("Invalid Virginia candidate committee election year");
  });

  it("can search Virginia committees and resolve through the async wrapper", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        `
          <table>
            <tr>
              <td class="committeeName"><div> Spanberger for Governor </div></td>
              <td class="candidateName"><div> Abigail Spanberger </div></td>
              <td class="committeeType"><div> Candidate Campaign Committee </div></td>
              <td><a href="/Committee/Index/60e10dc7-c59e-4a79-afca-e688c1efed65">View Reports</a></td>
            </tr>
          </table>
        `,
        { status: 200, statusText: "OK" }
      )
    ) as unknown as typeof fetch;

    await expect(
      searchAndResolveVirginiaCandidateCommittee(
        {
          candidateName: "Abigail Spanberger",
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2025,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      committeeId: "60e10dc7-c59e-4a79-afca-e688c1efed65",
    });

    const requestUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]));
    expect(requestUrl.origin + requestUrl.pathname).toBe("https://cfreports.elections.virginia.gov/");
    expect(requestUrl.searchParams.get("CommitteeName")).toBe("Abigail Spanberger");
  });

  it("does not force report-header matching when the async wrapper receives an empty header map", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        `
          <table>
            <tr>
              <td class="committeeName"><div> Spanberger for Governor </div></td>
              <td class="candidateName"><div> Abigail Spanberger </div></td>
              <td class="committeeType"><div> Candidate Campaign Committee </div></td>
              <td><a href="/Committee/Index/60e10dc7-c59e-4a79-afca-e688c1efed65">View Reports</a></td>
            </tr>
          </table>
        `,
        { status: 200, statusText: "OK" }
      )
    ) as unknown as typeof fetch;

    await expect(
      searchAndResolveVirginiaCandidateCommittee(
        {
          candidateName: "Abigail Spanberger",
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2025,
          reportHeadersByCommitteeId: new Map(),
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      committeeId: "60e10dc7-c59e-4a79-afca-e688c1efed65",
      matchedReportHeaderCount: 0,
    });
  });

  it("drops the cfreports title and falls back to a surname search (live: Mr Nathaniel Alexander Fritzen; the quoted Nate is not a middle name)", async () => {
    const page = (rows: string) =>
      new Response(`<table>${rows}</table>`, { status: 200, statusText: "OK" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page(""))
      .mockResolvedValueOnce(
        page(`
          <tr>
            <td class="committeeName"><div> Nate For HD-20 </div></td>
            <td class="candidateName"><div> Mr Nathaniel Alexander Fritzen </div></td>
            <td class="committeeType"><div> Candidate Campaign Committee </div></td>
            <td><a href="/Committee/Index/cc327202-6d9f-4708-90eb-fdbca069a1ac">View Reports</a></td>
          </tr>`)
      ) as unknown as typeof fetch;

    await expect(
      searchAndResolveVirginiaCandidateCommittee(
        {
          candidateName: 'Nathaniel "Nate" Fritzen',
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          electionYear: 2026,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({ status: "matched", committeeId: "cc327202-6d9f-4708-90eb-fdbca069a1ac" });

    const urls = vi.mocked(fetchImpl).mock.calls.map((call) => new URL(String(call[0])).searchParams.get("CommitteeName"));
    expect(urls).toEqual(['Nathaniel "Nate" Fritzen', "FRITZEN"]);
  });

  it("does not search the network for unsupported offices", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([])) as unknown as typeof fetch;

    await expect(
      searchAndResolveVirginiaCandidateCommittee(
        {
          candidateName: "Jane Doe",
          officeScope: "county",
          officeName: "Sheriff",
          electionYear: 2025,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({ status: "unmatched", reason: "unsupported_office" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
