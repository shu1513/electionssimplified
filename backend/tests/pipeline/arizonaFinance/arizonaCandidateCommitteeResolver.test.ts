import { describe, expect, it, vi } from "vitest";

import { resolveArizonaCandidateCommittee } from "../../../src/pipeline/arizonaFinance/arizonaCandidateCommitteeResolver.js";

describe("arizonaCandidateCommitteeResolver", () => {
  it("matches exactly one Spotlight committee", async () => {
    const searchCandidateCommittees = vi.fn(async () => [
      {
        committeeId: "AZ100",
        committeeName: "Katie Hobbs for Governor",
        amount: 1000,
        rowCount: 2,
        sourceUrl: "https://seethemoney.az.gov/Reporting/Explore",
      },
    ]);

    await expect(
      resolveArizonaCandidateCommittee(
        {
          candidateName: "Katie Hobbs",
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2024,
        },
        { timeoutMs: 1000 },
        { searchCandidateCommittees }
      )
    ).resolves.toEqual({
      status: "matched",
      committeeId: "AZ100",
      committeeName: "Katie Hobbs for Governor",
      confidence: "single_committee",
      source: "spotlight",
      sourceUrl: "https://seethemoney.az.gov/Reporting/Explore",
      matchedIncomeRowCount: 2,
      totalIncomeAmount: 1000,
    });
  });

  it("skips ambiguous committee matches", async () => {
    const searchCandidateCommittees = vi.fn(async () => [
      {
        committeeId: "AZ100",
        committeeName: "Katie Hobbs for Governor",
        amount: 1000,
        rowCount: 2,
        sourceUrl: null,
      },
      {
        committeeId: "AZ200",
        committeeName: "Katie Hobbs Exploratory",
        amount: 500,
        rowCount: 1,
        sourceUrl: null,
      },
    ]);

    await expect(
      resolveArizonaCandidateCommittee(
        {
          candidateName: "Katie Hobbs",
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2024,
        },
        {},
        { searchCandidateCommittees }
      )
    ).resolves.toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      matches: [{ committeeId: "AZ100" }, { committeeId: "AZ200" }],
    });
  });

  it("falls back to a surname-only committee for a statewide race when the full name finds nothing", async () => {
    // Live: "Adrian Fontes" returns no income rows (the committee is
    // "Fontes for AZ"); Spotlight's FilerName search is a committee-name
    // substring and its CandidateName filter is ignored.
    const searchCandidateCommittees = vi.fn(async (input: { candidateName: string }) =>
      input.candidateName === "Fontes"
        ? [
            { committeeId: "100622", committeeName: "Fontes for AZ", amount: 700, rowCount: 3, sourceUrl: null },
            { committeeId: "100900", committeeName: "Nancy Fontes for State Representative - District 18", amount: 250, rowCount: 1, sourceUrl: null },
            { committeeId: "1045", committeeName: "FONTES FAMILY PAC", amount: 100, rowCount: 1, sourceUrl: null },
          ]
        : []
    );
    await expect(
      resolveArizonaCandidateCommittee(
        { candidateName: "Adrian Fontes", officeScope: "statewide", officeName: "Secretary of State", electionYear: 2026 },
        {},
        { searchCandidateCommittees }
      )
    ).resolves.toMatchObject({ status: "matched", committeeId: "100622", confidence: "surname_committee" });
    expect(searchCandidateCommittees).toHaveBeenCalledTimes(2);
  });

  it("rejects a surname-only committee whose office word names another race", async () => {
    const searchCandidateCommittees = vi.fn(async (input: { candidateName: string }) =>
      input.candidateName === "Biggs"
        ? [{ committeeId: "5", committeeName: "Biggs for Senate", amount: 10, rowCount: 1, sourceUrl: null }]
        : []
    );
    await expect(
      resolveArizonaCandidateCommittee(
        { candidateName: "Andy Biggs", officeScope: "statewide", officeName: "Governor", electionYear: 2026 },
        {},
        { searchCandidateCommittees }
      )
    ).resolves.toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("never uses the surname fallback for legislative races and stays ambiguous on two surname committees", async () => {
    const searchCandidateCommittees = vi.fn(async (input: { candidateName: string }) =>
      input.candidateName === "Biggs"
        ? [
            { committeeId: "5", committeeName: "Biggs for AZ", amount: 10, rowCount: 1, sourceUrl: null },
            { committeeId: "6", committeeName: "Elect Biggs", amount: 10, rowCount: 1, sourceUrl: null },
          ]
        : []
    );
    await expect(
      resolveArizonaCandidateCommittee(
        { candidateName: "Mylie Biggs", officeScope: "state_upper", officeName: "State Senator", district: "14", electionYear: 2026 },
        {},
        { searchCandidateCommittees }
      )
    ).resolves.toMatchObject({ status: "unmatched" });
    expect(searchCandidateCommittees).toHaveBeenCalledTimes(1);
    await expect(
      resolveArizonaCandidateCommittee(
        { candidateName: "Andy Biggs", officeScope: "statewide", officeName: "Governor", electionYear: 2026 },
        {},
        { searchCandidateCommittees }
      )
    ).resolves.toMatchObject({ status: "ambiguous" });
  });

  it("rejects unsupported offices before querying Spotlight", async () => {
    const searchCandidateCommittees = vi.fn();

    await expect(
      resolveArizonaCandidateCommittee(
        {
          candidateName: "Katie Hobbs",
          officeScope: "county",
          officeName: "Sheriff",
          electionYear: 2024,
        },
        {},
        { searchCandidateCommittees }
      )
    ).resolves.toMatchObject({
      status: "unmatched",
      reason: "unsupported_office",
    });
    expect(searchCandidateCommittees).not.toHaveBeenCalled();
  });
});
