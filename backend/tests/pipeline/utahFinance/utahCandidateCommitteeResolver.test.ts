import { describe, expect, it, vi } from "vitest";

import {
  normalizeUtahCandidateNameKeys,
  resolveUtahCandidateCommittee,
  searchAndResolveUtahCandidateCommittee,
} from "../../../src/pipeline/utahFinance/utahCandidateCommitteeResolver.js";
import type { UtahDisclosuresEntitySearchRow } from "../../../src/pipeline/utahFinance/utahDisclosuresClient.js";

function entityRow(overrides: Partial<UtahDisclosuresEntitySearchRow> = {}): UtahDisclosuresEntitySearchRow {
  return {
    folderId: "98765",
    entityName: "Friends of Jane Doe",
    reportYears: [2024, 2022],
    sourceUrl: "https://disclosures.utah.gov/Search/AdvancedSearch/FolderDetails/98765",
    ...overrides,
  };
}

describe("utahCandidateCommitteeResolver", () => {
  it("normalizes direct, comma-form, suffix, and parenthetical candidate names", () => {
    expect([...normalizeUtahCandidateNameKeys("DOE, Jane Q. Jr.")]).toEqual([
      "DOE JANE Q",
      "JANE Q DOE",
      "JANE DOE",
    ]);
    expect(normalizeUtahCandidateNameKeys("Jane Doe (Janet Doe)").has("JANET DOE")).toBe(true);
  });

  it("matches a formal folder name through nicknames, literal names first", () => {
    // Live Oct 2026: VoteApp "Walt Brooks" (House 75) files as "Brooks, Walter".
    const walter = entityRow({ folderId: "11111", entityName: "Brooks, Walter (2024 House-75)", reportYears: [2026, 2024] });
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Walt Brooks",
        electionYear: 2026,
        officeName: "State Lower Chamber Legislator",
        district: "75",
        entityRows: [walter],
      })
    ).toMatchObject({ status: "matched", folderId: "11111" });

    // A literal "Walt" folder wins over the "Walter" folder instead of turning ambiguous.
    const walt = entityRow({ folderId: "22222", entityName: "Brooks, Walt (2026 House-75)", reportYears: [2026] });
    expect(
      resolveUtahCandidateCommittee({ candidateName: "Walt Brooks", electionYear: 2026, entityRows: [walter, walt] })
    ).toMatchObject({ status: "matched", folderId: "22222" });

    // The first storage key stays the literal name.
    expect([...normalizeUtahCandidateNameKeys("Walt Brooks", { expandNicknames: true })][0]).toBe("WALT BROOKS");
  });

  it("rejects a same-year folder whose middle name contradicts the candidate", () => {
    // Same report year and no office conflict — only the middle evidence
    // differs. Without the middle gate this folder linked as an "exact" match
    // and attached the other Jane Doe's finance records.
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane R. Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane Q.", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Q. Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane Quinn", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "matched", folderId: "33333" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane Q.", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "matched", folderId: "33333" });
  });

  it("lets a middle conflict veto a middle-less parenthetical alias on the same folder", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane R. Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane Q. (Jane Doe)", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("treats a bare V as a middle initial, not a generational suffix", () => {
    // Shared policy (GENERATIONAL_SUFFIX_RANK in finance/personNameMiddleEvidence.ts)
    // deliberately excludes "V": it is far more often a middle initial than a
    // fifth-generation suffix, so it must stay as middle evidence on either side.
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane V. Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane Q.", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Q. Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane V", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane V. Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane V", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "matched", folderId: "33333" });

    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [entityRow({ folderId: "33333", entityName: "Doe, Jane V", reportYears: [2024] })],
      })
    ).toMatchObject({ status: "matched", folderId: "33333" });
  });

  it("matches exactly one Utah candidate folder by candidate name and report year", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [
          entityRow(),
          entityRow({ folderId: "11111", entityName: "John Doe for Utah" }),
          entityRow({ folderId: "22222", entityName: "Friends of Jane Doe 2022", reportYears: [2022] }),
        ],
        sourceUrl: "https://disclosures.utah.gov/Search/AdvancedSearch",
      })
    ).toEqual({
      status: "matched",
      folderId: "98765",
      committeeName: "Friends of Jane Doe",
      reportYears: [2024, 2022],
      confidence: "exact",
      source: "disclosures_advanced_search",
      sourceUrl: "https://disclosures.utah.gov/Search/AdvancedSearch/FolderDetails/98765",
      matchedEntityRowCount: 1,
    });
  });

  it("can match rows without parsed report-year links after the posted Utah year filter", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [entityRow({ reportYears: [] })],
      })
    ).toMatchObject({
      status: "matched",
      folderId: "98765",
      reportYears: [],
    });
  });

  it("trusts Utah report-year links over older folder title years for ongoing committees", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Spencer Cox",
        electionYear: 2024,
        officeName: "Governor",
        entityRows: [
          entityRow({
            folderId: "1411358",
            entityName: "Cox, Spencer (2020 Governor)",
            reportYears: [2025, 2024, 2023, 2022, 2021, 2020],
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      folderId: "1411358",
      committeeName: "Cox, Spencer (2020 Governor)",
    });
  });

  it("does not guess when multiple Utah candidate folders match", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [
          entityRow({ folderId: "20000", entityName: "Jane Doe for Utah" }),
          entityRow({ folderId: "10000", entityName: "Friends of Jane Doe" }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      matches: [{ folderId: "10000" }, { folderId: "20000" }],
    });
  });

  it("uses parsed folder office and district hints to disambiguate legislative folders", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Nelson Abbott",
        electionYear: 2022,
        officeName: "State Lower Chamber Legislator",
        district: "57",
        entityRows: [
          entityRow({ folderId: "10000", entityName: "Abbott, Nelson (2022 House-57)", reportYears: [] }),
          entityRow({ folderId: "20000", entityName: "Abbott, Nelson (2022 Senate-12)", reportYears: [] }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      folderId: "10000",
      committeeName: "Abbott, Nelson (2022 House-57)",
    });
  });

  it("supports trusted Utah folder IDs from app filing identifiers", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Different Name",
        electionYear: 2024,
        trustedFolderId: "98765",
        entityRows: [entityRow({ entityName: "Utah Future Fund" })],
      })
    ).toMatchObject({
      status: "matched",
      folderId: "98765",
      committeeName: "Utah Future Fund",
    });
  });

  it("returns unmatched for missing names, wrong names, wrong years, and invalid years", () => {
    expect(
      resolveUtahCandidateCommittee({
        candidateName: " ",
        electionYear: 2024,
        entityRows: [entityRow()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
    });

    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [entityRow({ entityName: "Friends of Janet Roe" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 2024,
        entityRows: [entityRow({ reportYears: [2022] })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(() =>
      resolveUtahCandidateCommittee({
        candidateName: "Jane Doe",
        electionYear: 1997,
        entityRows: [],
      })
    ).toThrow("Invalid Utah candidate committee election year");
  });

  it("searches Utah advanced search and resolves parsed folders", async () => {
    const html = `
      <tr>
        <td><a href="/Search/AdvancedSearch/FolderDetails/98765">Friends of Jane Doe</a></td>
        <td><a href="/Search/AdvancedSearch/GenerateReport/98765?ReportYear=2024">2024</a></td>
      </tr>
    `;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(html, { status: 200, statusText: "OK" })) as unknown as typeof fetch;

    await expect(
      searchAndResolveUtahCandidateCommittee(
        {
          candidateName: "Jane Doe",
          electionYear: 2024,
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      folderId: "98765",
      committeeName: "Friends of Jane Doe",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toBe(
      "https://disclosures.utah.gov/Search/AdvancedSearch/GetEntityReportList"
    );
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body)).toBe(
      "Search=Jane+Doe&EntityType=PCC&ReportYear=2024&HideContributions=false&HideExpenditures=false&PageNumber=1"
    );
  });

  it("falls back to candidate name parts when Utah advanced search does not match first-last names", async () => {
    const emptyHtml = "<tbody></tbody>";
    const html = `
      <tr>
        <td><a href="/Search/AdvancedSearch/FolderDetails/98765">Doe, Jane (2024 Governor)</a></td>
        <td><a href="/Search/AdvancedSearch/GenerateReport/98765?ReportYear=2024">2024</a></td>
      </tr>
    `;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(emptyHtml, { status: 200, statusText: "OK" }))
      .mockResolvedValueOnce(new Response(html, { status: 200, statusText: "OK" })) as unknown as typeof fetch;

    await expect(
      searchAndResolveUtahCandidateCommittee(
        {
          candidateName: "Jane Doe",
          electionYear: 2024,
          officeName: "Governor",
        },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toMatchObject({
      status: "matched",
      folderId: "98765",
      committeeName: "Doe, Jane (2024 Governor)",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body)).toContain("Search=Jane+Doe");
    expect(String(vi.mocked(fetchImpl).mock.calls[1]?.[1]?.body)).toContain("Search=Doe");
  });
});
