import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WashingtonPdcClientError,
  buildWashingtonPdcCandidateSummaryByCommitteeUrl,
  buildWashingtonPdcCandidateSummarySearchUrl,
  buildWashingtonPdcContributionSizeAggregatesUrl,
  buildWashingtonPdcDatasetUrl,
  buildWashingtonPdcDirectOccupationAggregatesUrl,
  buildWashingtonPdcIndependentExpenditureGroupsUrl,
  buildWashingtonPdcSponsorOrganizationFundersUrl,
  buildWashingtonPdcSponsorSummarySearchUrl,
  getWashingtonPdcContributionSizeAggregates,
  getWashingtonPdcDirectOccupationAggregates,
  getWashingtonPdcIndependentExpenditureGroups,
  getWashingtonPdcSponsorOrganizationFunders,
  getWashingtonPdcSponsorSummaryByName,
  searchWashingtonPdcCandidateSummaries,
} from "../../../src/pipeline/washingtonFinance/washingtonPdcClient.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    statusText: "OK",
    ...init,
  });
}

describe("washingtonPdcClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds Socrata dataset URLs", () => {
    const url = new URL(
      buildWashingtonPdcDatasetUrl("kv7h-kjye", {
        $select: "filer_id,amount",
        $where: "election_year = '2024'",
      })
    );

    expect(url.origin + url.pathname).toBe("https://data.wa.gov/resource/kv7h-kjye.json");
    expect(url.searchParams.get("$select")).toBe("filer_id,amount");
    expect(url.searchParams.get("$where")).toBe("election_year = '2024'");
    expect(() => buildWashingtonPdcDatasetUrl("bad", {})).toThrow(WashingtonPdcClientError);
  });

  it("builds candidate summary search URLs with conservative filters", () => {
    const url = new URL(
      buildWashingtonPdcCandidateSummarySearchUrl({
        candidateName: " Bob   Ferguson ",
        electionYear: 2024,
        office: "Governor",
        limit: 10,
      })
    );

    expect(url.origin + url.pathname).toBe("https://data.wa.gov/resource/3h9x-7bvm.json");
    expect(url.searchParams.get("$where")).toContain("election_year = '2024'");
    expect(url.searchParams.get("$where")).toContain("lower(filer_name) like '%bob%ferguson%'");
    expect(url.searchParams.get("$where")).toContain("upper(office) = upper('Governor')");
    expect(url.searchParams.get("$order")).toBe("contributions_amount DESC, filer_name ASC");
    expect(url.searchParams.get("$limit")).toBe("10");

    // Joining words with % lets "DEBRA Jean  ENTENMAN" (two spaces) match.
    const entenman = new URL(
      buildWashingtonPdcCandidateSummarySearchUrl({ candidateName: "Debra Jean Entenman", electionYear: 2026 })
    );
    expect(entenman.searchParams.get("$where")).toContain("lower(filer_name) like '%debra%jean%entenman%'");
  });

  it("parses candidate summaries and skips malformed rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          filer_id: "FERGR *115",
          committee_id: "32311",
          candidacy_id: "31985",
          filer_name: "Robert W. Ferguson (Bob Ferguson)",
          committee_category: "Candidate",
          political_committee_type: "Statewide",
          candidate_committee_status: "Active",
          active_candidate: "true",
          has_reports: "yes",
          office: "Governor",
          election_year: "2024",
          contributions_amount: "14634321.50",
          expenditures_amount: 1300,
          independent_expenditures_for_amount: "10",
          independent_expenditures_against_amount: "20",
          url: { url: "https://www.pdc.wa.gov/example" },
        },
        { filer_name: "missing id" },
      ])
    ) as unknown as typeof fetch;

    await expect(
      searchWashingtonPdcCandidateSummaries(
        { candidateName: "Bob Ferguson", electionYear: 2024, office: "Governor" },
        { fetchImpl, timeoutMs: 1000, appToken: "token" }
      )
    ).resolves.toEqual([
      {
        filerId: "FERGR *115",
        committeeId: "32311",
        candidacyId: "31985",
        filerName: "Robert W. Ferguson (Bob Ferguson)",
        committeeCategory: "Candidate",
        politicalCommitteeType: "Statewide",
        candidateCommitteeStatus: "Active",
        activeCandidate: true,
        hasReports: true,
        office: "Governor",
        electionYear: 2024,
        contributionsAmount: 14634321.5,
        expendituresAmount: 1300,
        independentExpendituresForAmount: 10,
        independentExpendituresAgainstAmount: 20,
        sourceUrl: "https://www.pdc.wa.gov/example",
      },
    ]);

    const request = vi.mocked(fetchImpl).mock.calls[0];
    expect(String(request?.[0])).toContain("/3h9x-7bvm.json");
    expect((request?.[1]?.headers as Headers).get("X-App-Token")).toBe("token");
  });

  it("builds and parses direct occupation aggregates", async () => {
    const url = new URL(
      buildWashingtonPdcDirectOccupationAggregatesUrl({ filerId: "FERGR *115", electionYear: 2024, limit: 5 })
    );
    expect(url.origin + url.pathname).toBe("https://data.wa.gov/resource/kv7h-kjye.json");
    expect(url.searchParams.get("$where")).toContain("filer_id = 'FERGR *115'");
    expect(url.searchParams.get("$where")).toContain("contributor_category = 'Individual'");
    // Case/whitespace normalization happens server-side; blank occupations are
    // excluded instead of becoming an "UNKNOWN" category.
    expect(url.searchParams.get("$select")).toContain("upper(trim(contributor_occupation)) as category_name");
    expect(url.searchParams.get("$group")).toBe("category_name");
    expect(url.searchParams.get("$where")).toContain("contributor_occupation IS NOT NULL");
    expect(url.searchParams.get("$where")).toContain("trim(contributor_occupation) != ''");
    // Over-fetch grouped rows: the whitespace merge happens client-side, so
    // slicing to the display limit server-side would let a merged variant
    // crowd out a real category (Franz 2024 top-20 lost PHYSICIAN).
    expect(url.searchParams.get("$limit")).toBe("500");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        { category_name: "ATTORNEY - LAWYER", total_amount: "719187.76", total_count: "25" },
        // SoQL trim() leaves internal whitespace runs: these two are separate
        // server-side buckets and must merge client-side.
        { category_name: "NOT EMPLOYED", total_amount: "300", total_count: "3" },
        { category_name: "NOT  EMPLOYED", total_amount: "200", total_count: "2" },
        { total_amount: "100", total_count: "1" },
      ])
    ) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcDirectOccupationAggregates(
        { filerId: "FERGR *115", electionYear: 2024, limit: 5 },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toEqual([
      { categoryName: "ATTORNEY - LAWYER", amount: 719187.76, count: 25 },
      { categoryName: "NOT EMPLOYED", amount: 500, count: 5 },
    ]);

    // Display limit applies AFTER the merge: with limit 2, the merged
    // whitespace variant must not crowd out the next real category.
    const limitedFetch = vi.fn().mockResolvedValue(
      jsonResponse([
        { category_name: "NOT EMPLOYED", total_amount: "300", total_count: "3" },
        { category_name: "NOT  EMPLOYED", total_amount: "200", total_count: "2" },
        { category_name: "PHYSICIAN", total_amount: "150", total_count: "1" },
      ])
    ) as unknown as typeof fetch;
    await expect(
      getWashingtonPdcDirectOccupationAggregates(
        { filerId: "FERGR *115", electionYear: 2024, limit: 2 },
        { fetchImpl: limitedFetch, timeoutMs: 1000 }
      )
    ).resolves.toEqual([
      { categoryName: "NOT EMPLOYED", amount: 500, count: 5 },
      { categoryName: "PHYSICIAN", amount: 150, count: 1 },
    ]);
  });

  it("builds hard-ID committee summary lookups", () => {
    const url = new URL(
      buildWashingtonPdcCandidateSummaryByCommitteeUrl({ filerId: "FERGR *115", committeeId: "32311", electionYear: 2024 })
    );
    expect(url.origin + url.pathname).toBe("https://data.wa.gov/resource/3h9x-7bvm.json");
    expect(url.searchParams.get("$where")).toBe(
      "election_year = '2024' AND filer_id = 'FERGR *115' AND committee_id = '32311'"
    );
    expect(() =>
      buildWashingtonPdcCandidateSummaryByCommitteeUrl({ filerId: "FERGR *115", electionYear: 2024 })
    ).toThrow("filerId and committeeId are both required");
  });

  it("builds and parses contribution size aggregates", async () => {
    const url = new URL(
      buildWashingtonPdcContributionSizeAggregatesUrl({ committeeId: "32311", electionYear: 2024, limit: 5 })
    );
    expect(url.searchParams.get("$where")).toContain("committee_id = '32311'");
    expect(url.searchParams.get("$select")).toBe("amount");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ amount: "25" }, { amount: "75" }, { amount: "1000" }, { amount: "5000" }, { amount: "-1" }])
      )
      .mockResolvedValueOnce(jsonResponse([])) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcContributionSizeAggregates(
        { committeeId: "32311", electionYear: 2024, limit: 5 },
        { fetchImpl, timeoutMs: 1000, pageLimit: 5 }
      )
    ).resolves.toEqual([
      { categoryName: "5000_plus", amount: 5000, count: 1 },
      { categoryName: "1000_4999", amount: 1000, count: 1 },
      { categoryName: "under_100", amount: 100, count: 2 },
    ]);
  });

  it("aggregates independent expenditure groups by sponsor and support direction", async () => {
    const url = new URL(
      buildWashingtonPdcIndependentExpenditureGroupsUrl({
        candidateName: "Bob Ferguson",
        electionYear: 2024,
        office: "Governor",
      })
    );
    expect(url.origin + url.pathname).toBe("https://data.wa.gov/resource/67cp-h962.json");
    expect(url.searchParams.get("$where")).toContain("for_or_against in('For','Against')");
    expect(url.searchParams.get("$where")).toContain(
      "report_type in('Independent Expenditure','Independent Expenditure Ad','Electioneering Communication')"
    );
    expect(url.searchParams.get("$where")).toContain("lower(candidate_name) like");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            candidate_name: "Bob Ferguson",
            sponsor_id: "FUSEV  101",
            sponsor_name: "FUSE VOTES",
            for_or_against: "For",
            portion_of_amount: "2457.26",
            url: { url: "https://www.pdc.wa.gov/ie/1" },
          },
          {
            candidate_name: "Bob Ferguson",
            sponsor_id: "FUSEV  101",
            sponsor_name: "FUSE VOTES",
            for_or_against: "For",
            portion_of_amount: 1000,
            url: { url: "https://www.pdc.wa.gov/ie/2" },
          },
          {
            candidate_name: "Bob Ferguson",
            sponsor_id: "WA24   101",
            sponsor_name: "WASHINGTON 24",
            for_or_against: "Against",
            portion_of_amount: "10000.00",
          },
          {
            candidate_name: "Bob Ferguson",
            sponsor_id: "bad",
            sponsor_name: "Bad Row",
            for_or_against: "Assist",
            portion_of_amount: "999999",
          },
          {
            candidate_name: "Bob Ferguson Jr",
            sponsor_id: "other",
            sponsor_name: "Wrong Candidate PAC",
            for_or_against: "For",
            portion_of_amount: "50000",
          },
        ])
      )
      .mockResolvedValueOnce(jsonResponse([])) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcIndependentExpenditureGroups(
        { candidateName: "Bob Ferguson", electionYear: 2024, limit: 10 },
        { fetchImpl, timeoutMs: 1000, pageLimit: 4 }
      )
    ).resolves.toEqual([
      {
        sponsorId: "WA24   101",
        sponsorName: "WASHINGTON 24",
        supportOppose: "oppose",
        amount: 10000,
        expenditureCount: 1,
      },
      {
        sponsorId: "FUSEV  101",
        sponsorName: "FUSE VOTES",
        supportOppose: "support",
        amount: 3457.26,
        expenditureCount: 2,
        sourceUrl: "https://www.pdc.wa.gov/ie/1",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("filters by hard candidate IDs and keeps name-casing variants (Wilson 2025 characterization)", async () => {
    const url = new URL(
      buildWashingtonPdcIndependentExpenditureGroupsUrl({
        candidateName: "Katie Wilson",
        electionYear: 2025,
        office: "Mayor",
        candidateFilerId: "WILSK--949",
        candidateCommitteeId: "37672",
      })
    );
    expect(url.searchParams.get("$where")).toContain("candidate_filer_id = 'WILSK--949'");
    expect(url.searchParams.get("$where")).toContain("candidate_committee_id = '37672'");
    // Hard-ID mode must not constrain by name or office text.
    expect(url.searchParams.get("$where")).not.toContain("candidate_name");
    expect(url.searchParams.get("$where")).not.toContain("candidate_office");

    // A filer ID alone must NOT enter hard-ID mode: one filer can run two
    // races in the same year under different committees, so the query keeps
    // the name/office race filters instead.
    const filerOnlyUrl = new URL(
      buildWashingtonPdcIndependentExpenditureGroupsUrl({
        candidateName: "Katie Wilson",
        electionYear: 2025,
        office: "Mayor",
        candidateFilerId: "WILSK--949",
      })
    );
    expect(filerOnlyUrl.searchParams.get("$where")).not.toContain("candidate_filer_id");
    expect(filerOnlyUrl.searchParams.get("$where")).toContain("lower(candidate_name) like");
    expect(filerOnlyUrl.searchParams.get("$where")).toContain("upper(candidate_office)");

    // PDC's own summary totals for Wilson 2025: 273,026.25 for / 1,232,834.74
    // against — the sum of all three C6 report types, including rows whose
    // candidate_name casing differs from the search name.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            candidate_name: "Katie Wilson",
            sponsor_id: "SPONA  101",
            sponsor_name: "SUPPORT SPONSOR",
            for_or_against: "For",
            report_type: "Electioneering Communication",
            portion_of_amount: "260691.67",
          },
          {
            candidate_name: "Katie Wilson",
            sponsor_id: "SPONA  101",
            sponsor_name: "SUPPORT SPONSOR",
            for_or_against: "For",
            report_type: "Independent Expenditure",
            portion_of_amount: "113.99",
          },
          {
            candidate_name: "Katie Wilson",
            sponsor_id: "SPONA  101",
            sponsor_name: "SUPPORT SPONSOR",
            for_or_against: "For",
            report_type: "Independent Expenditure Ad",
            portion_of_amount: "12220.59",
          },
          {
            candidate_name: "Katie Wilson",
            sponsor_id: "FUTUB--916",
            sponsor_name: "BRUCE HARRELL FOR SEATTLE'S FUTURE",
            for_or_against: "Against",
            report_type: "Independent Expenditure",
            portion_of_amount: "683855.00",
          },
          {
            candidate_name: "Katie Wilson",
            sponsor_id: "FUTUB--916",
            sponsor_name: "BRUCE HARRELL FOR SEATTLE'S FUTURE",
            for_or_against: "Against",
            report_type: "Independent Expenditure Ad",
            portion_of_amount: "480979.74",
          },
          {
            candidate_name: "KATIE WILSON",
            sponsor_id: "FUTUB--916",
            sponsor_name: "BRUCE HARRELL FOR SEATTLE'S FUTURE",
            for_or_against: "Against",
            report_type: "Independent Expenditure",
            portion_of_amount: "34000.00",
          },
          {
            candidate_name: "KATIE WILSON",
            sponsor_id: "FUTUB--916",
            sponsor_name: "BRUCE HARRELL FOR SEATTLE'S FUTURE",
            for_or_against: "Against",
            report_type: "Independent Expenditure Ad",
            portion_of_amount: "34000.00",
          },
        ])
      )
      .mockResolvedValueOnce(jsonResponse([])) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcIndependentExpenditureGroups(
        {
          candidateName: "Katie Wilson",
          electionYear: 2025,
          candidateFilerId: "WILSK--949",
          candidateCommitteeId: "37672",
          limit: 10,
        },
        { fetchImpl, timeoutMs: 1000, pageLimit: 10 }
      )
    ).resolves.toEqual([
      {
        sponsorId: "FUTUB--916",
        sponsorName: "BRUCE HARRELL FOR SEATTLE'S FUTURE",
        supportOppose: "oppose",
        amount: 1232834.74,
        expenditureCount: 4,
      },
      {
        sponsorId: "SPONA  101",
        sponsorName: "SUPPORT SPONSOR",
        supportOppose: "support",
        amount: 273026.25,
        expenditureCount: 3,
      },
    ]);
  });

  it("caps paged reads defensively", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ amount: "25" }])) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcContributionSizeAggregates(
        { committeeId: "32311", electionYear: 2024, limit: 5 },
        { fetchImpl, timeoutMs: 1000, pageLimit: 1, maxPages: 1 }
      )
    ).rejects.toMatchObject({
      code: "bad_response",
      message: expect.stringContaining("exceeded 1 pages"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("finds sponsor summaries by exact sponsor name", async () => {
    const url = new URL(buildWashingtonPdcSponsorSummarySearchUrl({ sponsorName: "FUSE VOTES", electionYear: 2024 }));
    expect(url.searchParams.get("$where")).toContain("upper(filer_name) = upper('FUSE VOTES')");

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          filer_id: "FUSEV  101",
          committee_id: "6708",
          filer_name: "FUSE VOTES",
          election_year: "2024",
          committee_category: "Political Committee",
          active_candidate: "false",
          has_reports: "true",
        },
      ])
    ) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcSponsorSummaryByName(
        { sponsorName: "FUSE VOTES", electionYear: 2024 },
        { fetchImpl, timeoutMs: 1000 }
      )
    ).resolves.toEqual([
      {
        filerId: "FUSEV  101",
        committeeId: "6708",
        filerName: "FUSE VOTES",
        committeeCategory: "Political Committee",
        activeCandidate: false,
        hasReports: true,
        electionYear: 2024,
      },
    ]);
  });

  it("aggregates organization funders for outside sponsors", async () => {
    const url = new URL(
      buildWashingtonPdcSponsorOrganizationFundersUrl({ filerId: "FUSEV  101", committeeId: "6708", electionYear: 2024 })
    );
    expect(url.searchParams.get("$where")).toContain("filer_id = 'FUSEV  101'");
    expect(url.searchParams.get("$where")).toContain("committee_id = '6708'");
    expect(url.searchParams.get("$where")).toContain("filer_id = 'FUSEV  101' AND committee_id = '6708'");
    expect(url.searchParams.get("$where")).not.toContain("filer_id = 'FUSEV  101' OR committee_id = '6708'");
    expect(url.searchParams.get("$where")).toContain("contributor_category = 'Organization'");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            contributor_name: "Washington Conservation Action Votes",
            amount: "20000",
            url: { url: "https://www.pdc.wa.gov/receipt/1" },
          },
          {
            contributor_name: "WASHINGTON CONSERVATION ACTION VOTES",
            amount: "5000",
            url: { url: "https://www.pdc.wa.gov/receipt/2" },
          },
          { contributor_name: "", amount: "100000" },
          { contributor_name: "Bad Negative", amount: "-1" },
        ])
      )
      .mockResolvedValueOnce(jsonResponse([])) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcSponsorOrganizationFunders(
        { filerId: "FUSEV  101", committeeId: "6708", electionYear: 2024, limit: 5 },
        { fetchImpl, timeoutMs: 1000, pageLimit: 4 }
      )
    ).resolves.toEqual([
      {
        categoryName: "Washington Conservation Action Votes",
        amount: 25000,
        count: 2,
        sourceUrl: "https://www.pdc.wa.gov/receipt/1",
      },
    ]);
  });

  it("returns every organization funder when no limit is given", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { contributor_name: "Alpha Fund", amount: "300" },
          { contributor_name: "Beta Fund", amount: "200" },
          { contributor_name: "Gamma Fund", amount: "100" },
        ])
      )
      .mockResolvedValueOnce(jsonResponse([])) as unknown as typeof fetch;

    await expect(
      getWashingtonPdcSponsorOrganizationFunders(
        { filerId: "FUSEV  101", committeeId: "6708", electionYear: 2024 },
        { fetchImpl, timeoutMs: 1000, pageLimit: 3 }
      )
    ).resolves.toEqual([
      { categoryName: "Alpha Fund", amount: 300, count: 1 },
      { categoryName: "Beta Fund", amount: 200, count: 1 },
      { categoryName: "Gamma Fund", amount: 100, count: 1 },
    ]);
  });

  it("requires a filer ID or committee ID for committee contribution queries", () => {
    expect(() => buildWashingtonPdcDirectOccupationAggregatesUrl({ electionYear: 2024 })).toThrow(
      "filerId or committeeId is required"
    );
  });

  it("throws structured errors for HTTP and malformed responses", async () => {
    const httpFetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
    await expect(
      searchWashingtonPdcCandidateSummaries({ candidateName: "Bob Ferguson", electionYear: 2024 }, { fetchImpl: httpFetch })
    ).rejects.toMatchObject({ code: "http_error", status: 500 });

    const badPayloadFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] })) as unknown as typeof fetch;
    await expect(
      searchWashingtonPdcCandidateSummaries(
        { candidateName: "Bob Ferguson", electionYear: 2024 },
        { fetchImpl: badPayloadFetch }
      )
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});
