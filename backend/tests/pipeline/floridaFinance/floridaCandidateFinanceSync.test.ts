import { describe, expect, it, vi } from "vitest";

import { syncFloridaCandidateFinance } from "../../../src/pipeline/floridaFinance/floridaCandidateFinanceSync.js";
import * as financeWriter from "../../../src/pipeline/floridaFinance/floridaFinanceWriter.js";
import type { FloridaCommitteeDonorFinanceInput } from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorWriter.js";
import type { FloridaContributionRow } from "../../../src/pipeline/floridaFinance/floridaCampaignFinanceRows.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const CANDIDATE_ELECTION_ID = "44444444-4444-4444-4444-444444444444";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const SUPPORT_LINK_ID = "55555555-5555-5555-5555-555555555555";
const SOURCE_URL = "https://dos.elections.myflorida.com/cgi-bin/contrib.exe";

function createMockDb(input: { storedSupportLinks?: readonly Record<string, unknown>[] } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (String(sql).includes("FROM public.finance_label_classifications AS classification")) {
      return { rows: [], rowCount: 0 };
    }
    if (
      String(sql).includes("FROM public.fl_candidate_finance_outside_group_links") &&
      String(sql).includes("SELECT")
    ) {
      return { rows: input.storedSupportLinks ?? [], rowCount: input.storedSupportLinks?.length ?? 0 };
    }
    if (String(sql).includes("INSERT INTO public.fl_candidate_finance_outside_group_links")) {
      return { rows: [{ id: SUPPORT_LINK_ID }], rowCount: 1 };
    }
    return { rows: [{ id: LINK_ID }], rowCount: 1 };
  });
  const client = {
    query,
    release: vi.fn(),
  };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

function contribution(overrides: Partial<FloridaContributionRow> = {}): FloridaContributionRow {
  return {
    recipientName: "Friends of Jane Doe",
    contributionDate: "9/15/2026",
    amount: "100.00",
    transactionType: "CHE",
    contributorName: "Pat Person",
    address: "1 Main St",
    city: "Tallahassee",
    state: "FL",
    zip: "32301",
    occupation: "Attorney",
    inKindDescription: "",
    electionCode: "20261103-GEN",
    sourceUrl: SOURCE_URL,
    ...overrides,
  };
}

function outsideContribution(overrides: Partial<FloridaContributionRow> = {}): FloridaContributionRow {
  return contribution({
    recipientName: "Floridians for Jane Doe",
    amount: "25000.00",
    contributorName: "Energy Transfer LLC",
    occupation: "",
    ...overrides,
  });
}

function baseInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Jane Doe",
    electionYear: 2026,
    officeName: "Governor",
    sourceUrl: SOURCE_URL,
    contributionSourceUrl: SOURCE_URL,
    outsideSourceUrl: SOURCE_URL,
    now: new Date("2026-02-03T04:05:06.000Z"),
    trustedCommittee: {
      committeeId: "FRIENDS_OF_JANE_DOE",
      committeeName: "Friends of Jane Doe",
      sourceUrl: SOURCE_URL,
    },
  };
}

describe("floridaCandidateFinanceSync", () => {
  it.each([
    { pacDonorsWritten: 1, netCommitteeAmount: 100 },
    { pacDonorsWritten: 0, netCommitteeAmount: 0 },
    { pacDonorsWritten: 0 },
  ])("reports the actual PAC write result %j", async pacResult => {
    const write = vi.spyOn(financeWriter, "replaceFloridaCandidateFinanceSnapshot").mockResolvedValue({
      linkId: LINK_ID, summaryWritten: true, directBreakdownsWritten: 0,
      outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0, outsideGroupSupportLinksWritten: 0,
      ...pacResult,
    });
    try {
      // Only result forwarding is mocked; writer tests exercise real source-preservation checks.
      const pacFinance = { finance: { donors: [{}], netCommitteeAmount: 100 } } as unknown as FloridaCommitteeDonorFinanceInput;
      const result = await syncFloridaCandidateFinance({
        ...baseInput(), db: createMockDb(), contributionRows: [contribution()], pacFinance,
      });
      expect(write).toHaveBeenCalledOnce();
      expect(result.pacDonorsWritten).toBe(pacResult.pacDonorsWritten);
      if ("netCommitteeAmount" in pacResult) expect(result.netCommitteeAmount).toBe(pacResult.netCommitteeAmount);
      else expect(result).not.toHaveProperty("netCommitteeAmount");
    } finally { write.mockRestore(); }
  });
  it("aggregates trusted direct and outside finance data and writes a snapshot", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      contributionRows: [
        contribution({ amount: "100.00", occupation: "Attorney", contributorName: "Pat Person" }),
        contribution({ amount: "250.00", occupation: "Teacher", contributorName: "Sam Person", address: "2 Main St" }),
        contribution({ amount: "5000.00", transactionType: "INK", occupation: "Consultant" }),
      ],
      trustedOutsideGroups: [
        {
          committeeId: "FLORIDIANS_FOR_JANE_DOE",
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          amount: 1200,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideContributionRows: [outsideContribution()],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 350,
      directContributionTotal: 350,
      outsideSupportTotal: 1200,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 3,
      includedContributionRowCount: 2,
      skippedContributionRowCount: 1,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
      resolution: {
        status: "matched",
        committeeId: "FRIENDS_OF_JANE_DOE",
        committeeName: "Friends of Jane Doe",
        recipientNames: ["Friends of Jane Doe"],
        source: "dos_export",
      },
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.finance_label_classifications");
    expect(db.query.mock.calls[1]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const linkCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "JANE DOE",
      "Governor",
      null,
      "FRIENDS_OF_JANE_DOE",
      "Friends of Jane Doe",
      "active",
      "dos_export",
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      350,
      350,
      null,
      null,
      1200,
      0,
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);

    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.fl_candidate_finance_direct_breakdowns")
      )
    ).toHaveLength(4);
    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_groups")
      )
    ).toHaveLength(1);
    const outsideBreakdownCalls = db.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual([
      [
        LINK_ID,
        2026,
        "FLORIDIANS_FOR_JANE_DOE",
        "support",
        "donor",
        "Energy Transfer LLC",
        25000,
        1,
        SOURCE_URL,
        "2026-02-03T04:05:06.000Z",
      ],
      [
        LINK_ID,
        2026,
        "FLORIDIANS_FOR_JANE_DOE",
        "support",
        "industry",
        "oil_gas_energy",
        25000,
        1,
        SOURCE_URL,
        "2026-02-03T04:05:06.000Z",
      ],
    ]);

    const classificationCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.finance_label_classifications")
    );
    expect(classificationCall?.[1]).toEqual([
      "Energy Transfer LLC",
      "donor",
      "ENERGY TRANSFER",
      "oil_gas_energy",
      "high",
      "rule",
    ]);
  });

  it("classifies every donor but caps the persisted donor rows per group", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      // Cap of 1: the smaller IBEW donor must be dropped from the WRITTEN
      // donor rows, yet still feed the classifications and the rebuilt
      // labor_unions industry total.
      outsideMaxBreakdownsPerCategory: 1,
      contributionRows: [contribution({ amount: "100.00" })],
      trustedOutsideGroups: [
        {
          committeeId: "FLORIDIANS_FOR_JANE_DOE",
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          amount: 1200,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideContributionRows: [
        outsideContribution({ amount: "50000.00", contributorName: "IBEW Local 540" }),
        outsideContribution({ amount: "30000.00", contributorName: "IBEW Voluntary PAC" }),
      ],
    });

    // 1 capped donor row + 1 industry row built from BOTH donors.
    expect(result.outsideGroupBreakdownsWritten).toBe(2);
    const breakdownInsertParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_group_breakdowns"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(breakdownInsertParams).toContain("IBEW Local 540");
    expect(breakdownInsertParams).not.toContain("IBEW Voluntary PAC");
    // The rebuilt industry total covers the dropped donor too.
    expect(breakdownInsertParams).toContain("labor_unions");
    expect(breakdownInsertParams).toContain(80_000);
    // Both donors persisted classification rows.
    const classificationParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(classificationParams).toContain("IBEW Local 540");
    expect(classificationParams).toContain("IBEW Voluntary PAC");
  });

  it("resolves trusted outside group support evidence into outside groups and persists the evidence link", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      candidateElectionId: CANDIDATE_ELECTION_ID,
      contributionRows: [contribution({ amount: "100.00" })],
      outsideGroupSupportEvidence: [
        {
          candidateElectionId: CANDIDATE_ELECTION_ID,
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          confidence: "high",
          amount: 0,
          evidenceUrl: "https://example.test/evidence",
          evidenceNote: "Trusted report says the PAC supports Jane Doe.",
        },
      ],
      outsideContributionRows: [outsideContribution()],
      includeStoredOutsideGroupSupportEvidence: false,
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      outsideGroupSupportLinksWritten: 1,
      resolvedOutsideGroupCount: 1,
      outsideGroupSupportEvidenceCount: 1,
      heuristicOutsideGroupCount: 0,
      outsideSupportTotal: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
    });

    const outsideGroupCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_groups")
    );
    expect(outsideGroupCall?.[1]).toEqual([
      LINK_ID,
      2026,
      "FLORIDIANS_FOR_JANE_DOE",
      "Floridians for Jane Doe",
      "support",
      0,
      "https://example.test/evidence",
      "2026-02-03T04:05:06.000Z",
    ]);

    const supportLinkCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_group_links")
    );
    expect(supportLinkCall?.[1]).toEqual([
      CANDIDATE_ELECTION_ID,
      null,
      "Floridians for Jane Doe",
      "support",
      "high",
      0,
      "https://example.test/evidence",
      "Trusted report says the PAC supports Jane Doe.",
      "manual",
    ]);
  });

  it("aggregates but does not write in dry-run mode", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      candidateElectionId: CANDIDATE_ELECTION_ID,
      dryRun: true,
      contributionRows: [contribution({ amount: "1000.00" })],
      trustedOutsideGroups: [
        {
          committeeId: "FLORIDIANS_FOR_JANE_DOE",
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          amount: 2500,
        },
      ],
      outsideContributionRows: [outsideContribution({ amount: "30000.00" })],
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: 1000,
      directContributionTotal: 1000,
      outsideSupportTotal: 2500,
      matchedOutsideContributionRowCount: 1,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("leaves outside totals null when trusted outside groups are omitted", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      contributionRows: [contribution({ amount: "250.00" })],
    });

    expect(result).toMatchObject({
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      matchedOutsideContributionRowCount: 0,
    });
    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      250,
      250,
      null,
      null,
      null,
      null,
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);
  });

  it("does not load stored outside group support links during direct-only sync", async () => {
    const db = createMockDb({
      storedSupportLinks: [
        {
          id: SUPPORT_LINK_ID,
          candidate_election_id: CANDIDATE_ELECTION_ID,
          committee_id: "FLORIDIANS_FOR_JANE_DOE",
          committee_name: "Floridians for Jane Doe",
          support_oppose: "support",
          confidence: "high",
          amount: "1200",
          evidence_url: "https://example.test/evidence",
          evidence_note: "Curated outside support evidence.",
          link_source: "manual",
        },
      ],
    });

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      candidateElectionId: CANDIDATE_ELECTION_ID,
      contributionRows: [contribution({ amount: "250.00" })],
      outsideContributionRows: [outsideContribution()],
    });

    expect(result).toMatchObject({
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      outsideGroupSupportLinksWritten: 0,
      resolvedOutsideGroupCount: 0,
      outsideGroupSupportEvidenceCount: 0,
      heuristicOutsideGroupCount: 0,
      matchedOutsideContributionRowCount: 0,
    });
    expect(
      db.query.mock.calls.some(
        (call) =>
          String(call[0]).includes("FROM public.fl_candidate_finance_outside_group_links") &&
          String(call[0]).includes("SELECT")
      )
    ).toBe(false);
  });

  it("honors an explicit outside group finance opt-out even when outside inputs are present", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      contributionRows: [contribution({ amount: "250.00" })],
      trustedOutsideGroups: [
        {
          committeeId: "FLORIDIANS_FOR_JANE_DOE",
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          amount: 1200,
        },
      ],
      outsideContributionRows: [outsideContribution()],
      includeOutsideGroupFinance: false,
    });

    expect(result).toMatchObject({
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      resolvedOutsideGroupCount: 0,
      matchedOutsideContributionRowCount: 0,
    });
  });

  it("loads stored outside group support links only when explicitly opted in", async () => {
    const db = createMockDb({
      storedSupportLinks: [
        {
          id: SUPPORT_LINK_ID,
          candidate_election_id: CANDIDATE_ELECTION_ID,
          committee_id: "FLORIDIANS_FOR_JANE_DOE",
          committee_name: "Floridians for Jane Doe",
          support_oppose: "support",
          confidence: "high",
          amount: "1200",
          evidence_url: "https://example.test/evidence",
          evidence_note: "Curated outside support evidence.",
          link_source: "manual",
        },
      ],
    });

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      candidateElectionId: CANDIDATE_ELECTION_ID,
      contributionRows: [contribution({ amount: "250.00" })],
      outsideContributionRows: [outsideContribution()],
      includeStoredOutsideGroupSupportEvidence: true,
    });

    expect(result).toMatchObject({
      outsideSupportTotal: 1200,
      outsideOpposeTotal: 0,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      outsideGroupSupportLinksWritten: 0,
      resolvedOutsideGroupCount: 1,
      outsideGroupSupportEvidenceCount: 1,
      heuristicOutsideGroupCount: 0,
      matchedOutsideContributionRowCount: 1,
    });
    expect(
      db.query.mock.calls.some(
        (call) =>
          String(call[0]).includes("FROM public.fl_candidate_finance_outside_group_links") &&
          String(call[0]).includes("SELECT")
      )
    ).toBe(true);
  });

  it("writes trusted outside groups without deleting outside breakdowns when PAC donor rows are omitted", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      contributionRows: [],
      trustedOutsideGroups: [
        {
          committeeId: "FLORIDIANS_FOR_JANE_DOE",
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          amount: 2500,
        },
      ],
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 0,
      outsideSupportTotal: 2500,
      matchedOutsideContributionRowCount: 0,
    });
    expect(
      db.query.mock.calls.some((call) =>
        String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_groups")
      )
    ).toBe(true);
    expect(
      db.query.mock.calls.some((call) =>
        String(call[0]).includes("DELETE FROM public.fl_candidate_finance_outside_group_breakdowns")
      )
    ).toBe(false);
  });

  it("uses the shared classifier for high-dollar unknown outside organization donors", async () => {
    const db = createMockDb();
    const financeIndustryClassifier = vi.fn(async ({ labels }) =>
      labels.map((label) => ({
        rawLabel: label.rawLabel,
        labelType: label.labelType,
        normalizedLabel: label.normalizedLabel,
        industrySlug: "technology" as const,
        confidence: "medium" as const,
        classificationSource: "ai" as const,
        matchedRule: null,
      }))
    );

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      contributionRows: [contribution({ amount: "100.00" })],
      trustedOutsideGroups: [
        {
          committeeId: "FLORIDIANS_FOR_JANE_DOE",
          committeeName: "Floridians for Jane Doe",
          supportOppose: "support",
          amount: 1200,
        },
      ],
      outsideContributionRows: [
        outsideContribution({
          amount: "30000.00",
          contributorName: "Sunshine Strategic Holdings",
        }),
      ],
      financeIndustryClassifier,
      aiClassificationMinAmount: 25_000,
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
    });
    expect(financeIndustryClassifier).toHaveBeenCalledWith({
      labels: [
        expect.objectContaining({
          rawLabel: "Sunshine Strategic Holdings",
          labelType: "donor",
          amount: 30000,
        }),
      ],
    });

    const outsideBreakdownCalls = db.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.fl_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        [
          LINK_ID,
          2026,
          "FLORIDIANS_FOR_JANE_DOE",
          "support",
          "industry",
          "technology",
          30000,
          1,
          SOURCE_URL,
          "2026-02-03T04:05:06.000Z",
        ],
      ])
    );
  });

  it("treats outside group name heuristics as an explicit outside-finance opt-in", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      candidateElectionId: CANDIDATE_ELECTION_ID,
      contributionRows: [contribution({ amount: "100.00" })],
      outsideContributionRows: [outsideContribution({ recipientName: "Floridians for Jane Doe" })],
      includeOutsideGroupNameHeuristics: true,
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      heuristicOutsideGroupCount: 1,
      resolvedOutsideGroupCount: 1,
    });
  });

  it("does not use embedded-token matches for outside group name heuristics", async () => {
    const db = createMockDb();

    const result = await syncFloridaCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Ann Lee",
      candidateElectionId: CANDIDATE_ELECTION_ID,
      contributionRows: [contribution({ amount: "100.00" })],
      outsideContributionRows: [outsideContribution({ recipientName: "Friends of Joann Lee" })],
      includeOutsideGroupNameHeuristics: true,
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 0,
      heuristicOutsideGroupCount: 0,
      resolvedOutsideGroupCount: 0,
    });
  });

  it("validates trusted committee inputs", async () => {
    await expect(
      syncFloridaCandidateFinance({
        db: createMockDb(),
        ...baseInput(),
        trustedCommittee: {
          committeeId: " ",
          committeeName: "Friends of Jane Doe",
        },
        contributionRows: [],
      })
    ).rejects.toThrow("trusted Florida committee id is required");
  });
});
