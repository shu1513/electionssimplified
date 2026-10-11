import { describe, expect, it, vi } from "vitest";

import {
  autoLinkMissingNewMexicoCandidateFinanceLinks,
  autoLinkNewMexicoCandidateFinanceForCandidateElection,
  buildNewMexicoCandidateNamePredicate,
  listNewMexicoCandidateElectionsMissingFinanceLinks,
} from "../../../src/pipeline/newMexicoFinance/newMexicoCandidateFinanceAutoLink.js";
import type { NewMexicoCfisContributionRow } from "../../../src/pipeline/newMexicoFinance/newMexicoCfisArtifactReader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

function contribution(overrides: Partial<NewMexicoCfisContributionRow> = {}): NewMexicoCfisContributionRow {
  return {
    OrgID: "1001",
    "Transaction Amount": "100.00",
    "Transaction Date": "01/10/2026",
    "Last Name": "Doe",
    "First Name": "Jane",
    "Middle Name": "",
    Prefix: "",
    Suffix: "",
    "Contributor Address Line 1": "",
    "Contributor Address Line 2": "",
    "Contributor City": "Santa Fe",
    "Contributor State": "NM",
    "Contributor Zip Code": "87501",
    Description: "",
    "Check Number": "",
    "Transaction ID": "T1",
    "Filed Date": "02/01/2026",
    Election: "2026 General",
    "Report Name": "First Report",
    "Start of Period": "01/01/2026",
    "End of Period": "01/31/2026",
    "Contributor Code": "Individual",
    "Contribution Type": "Contributions - Monetary",
    "Report Entity Type": "Candidate",
    "Committee Name": "Haaland for New Mexico",
    "Candidate Last Name": "Haaland",
    "Candidate First Name": "Deb",
    "Candidate Middle Name": "",
    "Candidate Prefix": "",
    "Candidate Suffix": "",
    Amended: "",
    "Contributor Employer": "Acme",
    "Contributor Occupation": "Attorney",
    "Occupation Comment": "",
    "Employment Information Requested": "",
    ...overrides,
  };
}

describe("newMexicoCandidateFinanceAutoLink", () => {
  it("lists eligible New Mexico candidate elections missing active finance links", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Deb Haaland",
        election_year: 2026,
        office_scope: "statewide",
        office_name: "Governor",
        district: null,
      },
    ]);

    await expect(
      listNewMexicoCandidateElectionsMissingFinanceLinks(db, {
        now: NOW,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Deb Haaland",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
      },
    ]);

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.candidate_elections AS candidate_election");
    expect(sql).toContain("district.state = 'NM'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($5::text[])");
    expect(sql).toContain("FROM public.nm_candidate_finance_links AS link");
    expect(sql).toContain("regexp_replace");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      25,
      1,
      730,
      expect.arrayContaining([
        "statewide::Governor",
        "statewide::Land Commissioner",
      ]),
    ]);
    expect(db.query.mock.calls[0]?.[1]?.[4]).not.toContain("statewide::Commissioner of Insurance");
    expect(db.query.mock.calls[0]?.[1]?.[4]).not.toContain("state_upper::State Senator");
    expect(db.query.mock.calls[0]?.[1]?.[4]).not.toContain("state_lower::State Lower Chamber Legislator");
  });

  it("links a matched candidate election to the resolved CFIS committee", async () => {
    const db = createMockDb([{ id: "link-1" }]);

    await expect(
      autoLinkNewMexicoCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        sourceUrl: "https://login.cfis.sos.state.nm.us/",
        contributionRows: [contribution()],
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Deb Haaland",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
        },
      })
    ).resolves.toEqual({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      status: "linked",
      committeeId: "1001",
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.nm_candidate_finance_links");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "DEB HAALAND",
      "Governor",
      null,
      "1001",
      "Haaland for New Mexico",
      "active",
      "cfis_bulk",
      "https://login.cfis.sos.state.nm.us/",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("does not auto-link legislative offices because CFIS contribution rows do not prove district", async () => {
    const db = createMockDb([{ id: "link-1" }]);

    await expect(
      autoLinkNewMexicoCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        sourceUrl: "https://login.cfis.sos.state.nm.us/",
        contributionRows: [contribution()],
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Deb Haaland",
          electionYear: 2026,
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          district: "12",
        },
      })
    ).resolves.toEqual({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      status: "unmatched",
      reason: "unsupported_office",
    });

    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not write a link when committee resolution is ambiguous", async () => {
    const db = createMockDb();

    await expect(
      autoLinkNewMexicoCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        sourceUrl: "https://login.cfis.sos.state.nm.us/",
        contributionRows: [
          contribution(),
          contribution({
            OrgID: "9999",
            "Committee Name": "Friends of Deb Haaland",
          }),
        ],
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Deb Haaland",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
        },
      })
    ).resolves.toEqual({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      status: "ambiguous",
      reason: "multiple_matching_committees",
    });

    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses provided candidate elections without querying when auto-linking a batch", async () => {
    const db = createMockDb([{ id: "link-1" }]);

    await expect(
      autoLinkMissingNewMexicoCandidateFinanceLinks({
        db,
        now: NOW,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
        candidateElections: [
          {
            candidateId: CANDIDATE_ID,
            electionId: ELECTION_ID,
            candidateName: "Deb Haaland",
            electionYear: 2026,
            officeScope: "statewide",
            officeName: "Governor",
            district: null,
          },
        ],
        contributionRowsByYear: new Map([[2026, [contribution()]]]),
        sourceUrlByYear: new Map([[2026, "https://login.cfis.sos.state.nm.us/"]]),
      })
    ).resolves.toEqual([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        status: "linked",
        committeeId: "1001",
      },
    ]);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.nm_candidate_finance_links");
  });

  it("continues auto-linking later candidates when one candidate write fails", async () => {
    const db = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary write failure"))
        .mockResolvedValueOnce({ rows: [{ id: "link-2" }], rowCount: 1 }),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        autoLinkMissingNewMexicoCandidateFinanceLinks({
          db,
          now: NOW,
          maxCandidates: 25,
          electionLookbackDays: 1,
          electionLookaheadDays: 730,
          candidateElections: [
            {
              candidateId: CANDIDATE_ID,
              electionId: ELECTION_ID,
              candidateName: "Deb Haaland",
              electionYear: 2026,
              officeScope: "statewide",
              officeName: "Governor",
              district: null,
            },
            {
              candidateId: "33333333-3333-4333-8333-333333333333",
              electionId: "44444444-4444-4444-8444-444444444444",
              candidateName: "Deb Haaland",
              electionYear: 2026,
              officeScope: "statewide",
              officeName: "Governor",
              district: null,
            },
          ],
          contributionRowsByYear: new Map([[2026, [contribution()]]]),
          sourceUrlByYear: new Map([[2026, "https://login.cfis.sos.state.nm.us/"]]),
        })
      ).resolves.toEqual([
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          status: "error",
          reason: "auto_link_failed",
          error: "temporary write failure",
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          status: "linked",
          committeeId: "1001",
        },
      ]);
    } finally {
      warnSpy.mockRestore();
    }

    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("builds a candidate-name predicate for filtered CFIS reads", () => {
    const predicate = buildNewMexicoCandidateNamePredicate([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Deb Haaland",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
      },
    ]);

    expect(predicate(contribution({ "Candidate Last Name": "Haaland", "Candidate First Name": "Deb" }))).toBe(true);
    expect(predicate(contribution({ "Candidate Last Name": "Other", "Candidate First Name": "Person" }))).toBe(false);
  });

  it("admits formal-name rows for a VoteApp nickname in the pre-filter", () => {
    // Live: Sam Kane's CFIS rows carry Candidate First Name "SAMUEL".
    const predicate = buildNewMexicoCandidateNamePredicate([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Sam Kane",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Attorney General",
        district: null,
      },
    ]);

    expect(predicate(contribution({ "Candidate Last Name": "KANE", "Candidate First Name": "SAMUEL" }))).toBe(true);
  });
});
