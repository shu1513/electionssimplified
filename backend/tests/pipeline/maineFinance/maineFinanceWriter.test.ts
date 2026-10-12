import { describe, expect, it, vi } from "vitest";

import {
  replaceMaineCandidateFinanceSnapshot,
  upsertMaineFinanceLink,
  type MaineFinanceSnapshotInput,
  type MaineMapLightFinanceSourceInput,
} from "../../../src/pipeline/maineFinance/maineFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2024,
    candidateNameNormalized: "REAGAN LEEANN PAUL",
    officeName: "Representative",
    district: "37",
    committeeId: "1001",
    committeeName: "Paul for Maine",
    linkSource: "cfis_bulk" as const,
    sourceUrl: "https://mainecampaignfinance.com/",
    lastVerifiedAt: new Date("2026-06-25T00:00:00.000Z"),
  };
}

describe("maineFinanceWriter", () => {
  it("upserts Maine finance links and returns the link id", async () => {
    const db = createMockDb();

    await expect(
      upsertMaineFinanceLink({ db, link: baseLink() }),
    ).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "INSERT INTO public.me_candidate_finance_links",
    );
    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "ON CONFLICT (candidate_id, election_id, committee_id)",
    );
    expect(String(db.query.mock.calls[0]?.[0])).toContain("RETURNING id");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2024,
      "REAGAN LEEANN PAUL",
      "Representative",
      "37",
      "1001",
      "Paul for Maine",
      "active",
      "cfis_bulk",
      "https://mainecampaignfinance.com/",
      "2026-06-25T00:00:00.000Z",
    ]);
  });

  it("normalizes committee ids at the writer boundary", async () => {
    const db = createMockDb();

    await upsertMaineFinanceLink({
      db,
      link: { ...baseLink(), committeeId: " org abc 123 " },
    });

    expect(db.query.mock.calls[0]?.[1]?.[6]).toBe("ORG ABC 123");
  });

  it("replaces a full Maine finance snapshot inside a transaction", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    const result = await replaceMaineCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-06-25T12:00:00.000Z"),
      summary: {
        totalReceipts: 5500,
        directContributionTotal: 500,
        outsideSupportTotal: 1600,
        outsideOpposeTotal: 200,
        sourceUrl: "https://mainecampaignfinance.com/",
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney/Legal",
          amount: 250,
          contributorCount: 1,
          sourceUrl: "https://mainecampaignfinance.com/",
        },
        {
          categoryType: "contribution_size",
          categoryName: "$100-$249",
          amount: 250,
          contributorCount: 1,
        },
      ],
      outsideGroups: [
        {
          committeeId: "242",
          committeeName: "ASSOCIATED BUILDERS AND CONTRACTORS OF MAINE PAC",
          supportOppose: "support",
          amount: 1600,
          sourceUrl: "https://mainecampaignfinance.com/",
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeId: "242",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "construction",
          amount: 35000,
          contributorCount: 1,
          sourceUrl: "https://mainecampaignfinance.com/",
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);

    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((statement) =>
        statement.includes("INSERT INTO public.me_candidate_finance_summaries"),
      ),
    ).toBe(true);
    const summaryCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes(
        "INSERT INTO public.me_candidate_finance_summaries",
      ),
    );
    expect(String(summaryCall?.[0])).toContain("cash_on_hand");
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2024,
      5500,
      500,
      null,
      null,
      1600,
      200,
      "https://mainecampaignfinance.com/",
      "2026-06-25T12:00:00.000Z",
    ]);
    expect(
      sql.some((statement) =>
        statement.includes("UPDATE public.me_candidate_finance_links"),
      ),
    ).toBe(true);
    expect(
      sql.filter((statement) =>
        statement.includes(
          "INSERT INTO public.me_candidate_finance_direct_breakdowns",
        ),
      ),
    ).toHaveLength(2);
    expect(
      sql.filter((statement) =>
        statement.includes(
          "INSERT INTO public.me_candidate_finance_outside_groups",
        ),
      ),
    ).toHaveLength(1);
    expect(
      sql.filter((statement) =>
        statement.includes(
          "INSERT INTO public.me_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toHaveLength(1);
    expect(
      sql.some((statement) =>
        statement.includes(
          "DELETE FROM public.me_candidate_finance_direct_breakdowns",
        ),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes(
          "DELETE FROM public.me_candidate_finance_outside_groups",
        ),
      ),
    ).toBe(true);
    expect(
      sql.some((statement) =>
        statement.includes(
          "DELETE FROM public.me_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toBe(true);
  });

  it("does not delete omitted sections", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    const result = await replaceMaineCandidateFinanceSnapshot({
      db,
      link: { ...baseLink(), linkSource: "manual" },
      syncedAt: new Date("2026-06-25T12:00:00.000Z"),
      summary: {
        outsideSupportTotal: 1000,
      },
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
    });
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    const summarySql = sql.find((statement) =>
      statement.includes("INSERT INTO public.me_candidate_finance_summaries"),
    );
    // Whitespace-insensitive: the factory renders this clause on one line
    // where the bespoke writer used three. Same SQL semantics.
    expect(summarySql).toMatch(
      /outside_support_total = COALESCE\(\s*EXCLUDED\.outside_support_total,\s*me_candidate_finance_summaries\.outside_support_total\s*\)/,
    );
    expect(
      sql.some((statement) =>
        statement.includes(
          "DELETE FROM public.me_candidate_finance_direct_breakdowns",
        ),
      ),
    ).toBe(false);
    expect(
      sql.some((statement) =>
        statement.includes(
          "DELETE FROM public.me_candidate_finance_outside_groups",
        ),
      ),
    ).toBe(false);
    expect(
      sql.some((statement) =>
        statement.includes(
          "DELETE FROM public.me_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toBe(false);
  });

  it("validates outside group breakdowns before writing", async () => {
    const db = {
      query: vi.fn(),
      connect: vi.fn(),
    };

    await expect(
      replaceMaineCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroupBreakdowns: [
          {
            committeeId: "242",
            supportOppose: "support",
            categoryType: "industry",
            categoryName: "construction",
            amount: 100,
          },
        ],
      }),
    ).rejects.toThrow(
      "Maine outside group breakdowns require outside groups in the same snapshot",
    );

    await expect(
      replaceMaineCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroups: [
          {
            committeeId: "999",
            committeeName: "Other PAC",
            supportOppose: "support",
            amount: 50,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "242",
            supportOppose: "support",
            categoryType: "industry",
            categoryName: "construction",
            amount: 100,
          },
        ],
      }),
    ).rejects.toThrow(
      "Maine outside group breakdowns require matching outside groups in the same snapshot",
    );

    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back and releases the client when a transactional write fails", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockRejectedValueOnce(new Error("write failed"))
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    await expect(
      replaceMaineCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        summary: { totalReceipts: 1000 },
      }),
    ).rejects.toThrow("write failed");

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("validates core inputs before writing", async () => {
    const db = createMockDb();

    await expect(
      upsertMaineFinanceLink({
        db,
        link: {
          ...baseLink(),
          electionYear: 1999,
        },
      }),
    ).rejects.toThrow("Invalid Maine finance election year");

    await expect(
      upsertMaineFinanceLink({
        db,
        link: {
          ...baseLink(),
          committeeId: " ",
        },
      }),
    ).rejects.toThrow("Maine committee id is required");

    expect(db.query).not.toHaveBeenCalled();
  });
});

const mapId = (prefix: "a" | "f", letter: string) =>
  `${prefix}_${letter.repeat(26)}`;
function modernInput(): Omit<MaineFinanceSnapshotInput, "db"> {
  return {
    link: {
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      candidateNameNormalized: "ALEX EXAMPLE",
      officeName: "State Senator",
      district: "14",
      committeeId: "1001",
      committeeName: "Example Campaign",
      linkStatus: "active",
      linkSource: "cfis_bulk",
      sourceUrl: "https://mainecampaignfinance.com/",
      lastVerifiedAt: new Date("2026-07-21T01:02:03.000Z"),
    },
    syncedAt: new Date("2026-10-12T21:00:00.000Z"),
    mapLightSource: {
      linkId: LINK_ID,
      electionDate: "2026-11-03",
      sourceCalendarYear: 2026,
      periodStart: "2026-01-01",
      periodEnd: "2026-10-11",
      observedAt: new Date("2026-10-12T20:00:00.000Z"),
      captureDigest: "a".repeat(64),
      sourceUrl:
        "https://maine-disclosure-system.refined.site/space/MESUPPORT/2763390977/Maine+Campaign+Finance+Datasets",
      sourceFilerId: mapId("f", "c"),
      sourceFilerName: "Alex Example",
      sourceOffice: "Senator",
      sourceDistrict: "14",
      publishedSourceTimes: {
        allFiler: "2026-10-11 09:59 ET",
        independentExpenditures: "2026-10-11 09:55 ET",
      },
    },
    mapLightCommitteeDonors: [
      {
        committeeId: "reported:EXAMPLE PAC",
        committeeName: "Example PAC",
        sourceReportedClass: "political_action_committee",
        amountCents: 50000,
        contributionCount: 1,
        giftTransactionIds: [mapId("a", "g")],
        returnedTransactionIds: [],
      },
    ],
    mapLightOutsideAllocations: [
      {
        occurrence: 1,
        transactionId: mapId("a", "i"),
        filerId: mapId("f", "p"),
        filerName: "Example Payer",
        transactionType: "independent_expenditure",
        transactionDate: "2026-09-18",
        totalTransactionAmount: "$200.00",
        totalTransactionAmountCents: 20000,
        description: "Mail",
        purpose: "Source mail",
        candidateId: mapId("f", "c"),
        candidateName: "Alex Example",
        supportOppose: "support",
        amountSpentOnCandidate: "$100.00",
        amountSpentOnCandidateCents: 10000,
      },
    ],
  };
}
function owner(overrides: Record<string, unknown> = {}) {
  const input = modernInput();
  return {
    id: LINK_ID,
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    election_year: 2026,
    candidate_name_normalized: input.link.candidateNameNormalized,
    office_name: input.link.officeName,
    district: "14",
    committee_id: "1001",
    committee_name: "Example Campaign",
    link_status: "active",
    link_source: "cfis_bulk",
    source_url: input.link.sourceUrl,
    last_verified_at: input.link.lastVerifiedAt,
    candidate_name: "Alex Example",
    candidate_state: "ME",
    candidate_deleted: false,
    candidate_merged: false,
    candidate_election_status: "declared",
    election_stage: "general",
    race_type: "office",
    election_date: "2026-11-03",
    district_state: "ME",
    district_type: "state_upper",
    geoid_compact: "23014",
    office_scope: "state_upper",
    office_canonical_name: "State Senator",
    ...overrides,
  };
}
function marker(overrides: Record<string, unknown> = {}) {
  const source = modernInput().mapLightSource!;
  return {
    component: "committee_donors",
    period_start: source.periodStart,
    period_end: source.periodEnd,
    observed_at: new Date("2026-10-12T19:00:00.000Z"),
    capture_digest: source.captureDigest,
    source_filer_id: source.sourceFilerId,
    source_filer_name: source.sourceFilerName,
    source_office: source.sourceOffice,
    source_district: source.sourceDistrict,
    election_date: source.electionDate,
    source_url: source.sourceUrl,
    published_source_times: source.publishedSourceTimes,
    ...overrides,
  };
}
function modernDb(
  options: {
    owners?: Record<string, unknown>[];
    markers?: Record<string, unknown>[];
    failSql?: string;
  } = {},
) {
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (options.failSql && sql.includes(options.failSql))
        throw new Error("Synthetic state write failure");
      if (sql.includes("SELECT link.id::text"))
        return { rows: options.owners ?? [owner()], rowCount: 1 };
      if (sql.includes("SELECT component,period_start"))
        return { rows: options.markers ?? [], rowCount: 0 };
      if (sql.includes("INSERT INTO public.me_candidate_finance_links"))
        return { rows: [{ id: LINK_ID }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return {
    db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) },
    client,
  };
}

describe("Maine source-scoped MapLight storage", () => {
  it("writes only source scopes atomically, keeping the old receiving ID/fields/verification stamp", async () => {
    const { db, client } = modernDb();
    const result = await replaceMaineCandidateFinanceSnapshot({
      db,
      ...modernInput(),
    });
    expect(result).toMatchObject({
      linkId: LINK_ID,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      mapLightCommitteeDonorsWritten: 1,
      mapLightOutsideAllocationsWritten: 1,
    });
    const calls = client.query.mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    const link = calls.find((call) =>
      call[0].includes("INSERT INTO public.me_candidate_finance_links"),
    );
    expect(link?.[1]?.[6]).toBe("1001");
    expect(link?.[1]?.[11]).toBe("2026-07-21T01:02:03.000Z");
    expect(
      calls.some((call) =>
        /(?:INSERT INTO|DELETE FROM|UPDATE) public.me_candidate_finance_(?:summaries|direct_breakdowns|outside_groups|outside_group_breakdowns)\b/.test(
          call[0],
        ),
      ),
    ).toBe(false);
    const markerCalls = calls.filter((call) =>
      call[0].includes(
        "INSERT INTO public.me_candidate_finance_source_markers",
      ),
    );
    expect(markerCalls.map((call) => call[1]?.[2])).toEqual([
      "committee_donors",
      "independent_expenditures",
    ]);
    expect(markerCalls[0][1]?.[14]).toBe(
      JSON.stringify(modernInput().mapLightSource?.publishedSourceTimes),
    );
    expect(
      calls.find((call) =>
        call[0].includes("DELETE FROM public.me_candidate_finance_pac_donors"),
      )?.[1],
    ).toEqual([LINK_ID, 2026, 2026]);
    const allocation = calls.find((call) =>
      call[0].includes(
        "INSERT INTO public.me_candidate_finance_maplight_allocations",
      ),
    );
    expect(allocation?.[1]?.slice(3, 12)).toEqual([
      mapId("a", "i"),
      mapId("f", "c"),
      "Alex Example",
      mapId("f", "p"),
      "Example Payer",
      "support",
      "2026-09-18",
      "100.00",
      "200.00",
    ]);
  });
  it("stores signed/zero donor positions and positive gift occurrence counts without clamping", async () => {
    const { db, client } = modernDb();
    const input = modernInput();
    input.mapLightOutsideAllocations = undefined;
    input.mapLightCommitteeDonors = [
      {
        ...input.mapLightCommitteeDonors![0],
        amountCents: 0,
        returnedTransactionIds: [mapId("a", "r")],
      },
      {
        committeeId: "reported:EXAMPLE PARTY",
        committeeName: "Example Party",
        sourceReportedClass: "political_party_committee",
        amountCents: -10000,
        contributionCount: 0,
        giftTransactionIds: [],
        returnedTransactionIds: [mapId("a", "s")],
      },
    ];
    await replaceMaineCandidateFinanceSnapshot({ db, ...input });
    const donors = client.query.mock.calls.filter((call) =>
      call[0].includes("INSERT INTO public.me_candidate_finance_pac_donors"),
    );
    expect(donors.map((call) => [call[1]?.[6], call[1]?.[7]])).toEqual([
      ["0.00", 1],
      ["-100.00", 0],
    ]);
  });
  it.each(["committee_donors", "independent_expenditures"] as const)(
    "empty accepted %s retains a watermark and leaves the other component untouched",
    async (component) => {
      const { db, client } = modernDb();
      const input = modernInput();
      input.mapLightCommitteeDonors =
        component === "committee_donors" ? [] : undefined;
      input.mapLightOutsideAllocations =
        component === "independent_expenditures" ? [] : undefined;
      await replaceMaineCandidateFinanceSnapshot({ db, ...input });
      const markers = client.query.mock.calls.filter((call) =>
        call[0].includes(
          "INSERT INTO public.me_candidate_finance_source_markers",
        ),
      );
      expect(markers).toHaveLength(1);
      expect(markers[0][1]?.[2]).toBe(component);
      const ownTable =
        component === "committee_donors"
          ? "pac_donors"
          : "maplight_allocations";
      const otherTable =
        component === "committee_donors"
          ? "maplight_allocations"
          : "pac_donors";
      expect(
        client.query.mock.calls.some((call) =>
          call[0].includes(
            `DELETE FROM public.me_candidate_finance_${ownTable}`,
          ),
        ),
      ).toBe(true);
      expect(
        client.query.mock.calls.some((call) =>
          call[0].includes(`public.me_candidate_finance_${otherTable}`),
        ),
      ).toBe(false);
    },
  );
  it("legacy calls without modern components remain supported without source marker access", async () => {
    const { db, client } = modernDb();
    await replaceMaineCandidateFinanceSnapshot({
      db,
      link: modernInput().link,
    });
    expect(
      client.query.mock.calls.some(
        (call) =>
          call[0].includes("maplight") ||
          call[0].includes("source_markers") ||
          call[0].includes("pac_donors"),
      ),
    ).toBe(false);
  });
  it.each([
    [
      "missing source",
      (input: Omit<MaineFinanceSnapshotInput, "db">) => {
        input.mapLightSource = undefined;
      },
    ],
    [
      "unpaired source",
      (input: Omit<MaineFinanceSnapshotInput, "db">) => {
        input.mapLightCommitteeDonors = undefined;
        input.mapLightOutsideAllocations = undefined;
      },
    ],
    [
      "legacy summary",
      (input: Omit<MaineFinanceSnapshotInput, "db">) => {
        input.summary = {};
      },
    ],
    [
      "legacy groups",
      (input: Omit<MaineFinanceSnapshotInput, "db">) => {
        input.outsideGroups = [];
      },
    ],
    [
      "missing original stamp",
      (input: Omit<MaineFinanceSnapshotInput, "db">) => {
        input.link.lastVerifiedAt = undefined;
      },
    ],
  ])("rejects %s before any connection/write", async (_reason, mutate) => {
    const { db } = modernDb();
    const input = modernInput();
    mutate(input);
    await expect(
      replaceMaineCandidateFinanceSnapshot({ db, ...input }),
    ).rejects.toThrow();
    expect(db.connect).not.toHaveBeenCalled();
  });
  it.each([
    ["deleted", { candidate_deleted: true }],
    ["merged", { candidate_merged: true }],
    ["candidate state", { candidate_state: "NH" }],
    ["district state", { district_state: "NH" }],
    ["undeclared", { candidate_election_status: "withdrawn" }],
    ["primary", { election_stage: "primary" }],
    ["non-office", { race_type: "measure" }],
    ["wrong date", { election_date: "2026-11-04" }],
    ["wrong canonical name", { candidate_name: "Different Example" }],
    ["wrong geoid", { geoid_compact: "23015" }],
    [
      "wrong chamber",
      {
        office_scope: "state_lower",
        office_canonical_name: "State Lower Chamber Legislator",
      },
    ],
    ["wrong office", { office_canonical_name: "Secretary of State" }],
    ["receiving key changed", { committee_id: "1002" }],
    ["source URL changed", { source_url: "https://example.com/new" }],
    [
      "verification stamp changed",
      { last_verified_at: new Date("2026-07-22T00:00:00.000Z") },
    ],
  ])(
    "locks and refuses %s with rollback before writes",
    async (_reason, overrides) => {
      const { db, client } = modernDb({ owners: [owner(overrides)] });
      await expect(
        replaceMaineCandidateFinanceSnapshot({ db, ...modernInput() }),
      ).rejects.toThrow("Maine MapLight write:");
      expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
      expect(
        client.query.mock.calls.some((call) => call[0].includes("INSERT")),
      ).toBe(false);
      expect(client.query.mock.calls[1][0]).toContain(
        "FOR UPDATE OF link,candidate,candidate_election,election,district,office",
      );
    },
  );
  it("rejects another active receiving sibling or another candidate sharing the key", async () => {
    const { db, client } = modernDb({
      owners: [owner(), owner({ id: "44444444-4444-4444-4444-444444444444" })],
    });
    await expect(
      replaceMaineCandidateFinanceSnapshot({ db, ...modernInput() }),
    ).rejects.toThrow("ambiguous");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("copies a genuinely null verification stamp rather than creating a new verification", async () => {
    const { db, client } = modernDb({
      owners: [owner({ last_verified_at: null })],
    });
    const input = modernInput();
    input.link.lastVerifiedAt = null;
    await replaceMaineCandidateFinanceSnapshot({ db, ...input });
    expect(
      client.query.mock.calls.find((call) =>
        call[0].includes("INSERT INTO public.me_candidate_finance_links"),
      )?.[1]?.[11],
    ).toBeNull();
  });
  it.each([
    [
      "older observation",
      { observed_at: new Date("2026-10-12T21:00:00.000Z") },
    ],
    ["shorter cutoff", { period_end: "2026-10-12" }],
    [
      "same-time conflicting digest",
      {
        observed_at: new Date("2026-10-12T20:00:00.000Z"),
        capture_digest: "b".repeat(64),
      },
    ],
    [
      "earlier same-day publication",
      {
        published_source_times: {
          allFiler: "2026-10-11 10:00 ET",
          independentExpenditures: "2026-10-11 09:55 ET",
        },
      },
    ],
  ])("refuses %s even for complete empty positions", async (_reason, prior) => {
    const { db, client } = modernDb({ markers: [marker(prior)] });
    const input = modernInput();
    input.mapLightCommitteeDonors = [];
    input.mapLightOutsideAllocations = undefined;
    await expect(
      replaceMaineCandidateFinanceSnapshot({ db, ...input }),
    ).rejects.toThrow();
    expect(
      client.query.mock.calls.some((call) => call[0].includes("DELETE")),
    ).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("refuses a shorter starting period", async () => {
    const { db, client } = modernDb({ markers: [marker()] });
    const input = modernInput();
    input.mapLightSource!.periodStart = "2026-02-01";
    await expect(
      replaceMaineCandidateFinanceSnapshot({ db, ...input }),
    ).rejects.toThrow("shorter");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("allows idempotent same-source observation and a later longer period", async () => {
    for (const prior of [
      marker({ observed_at: modernInput().mapLightSource!.observedAt }),
      marker({ period_end: "2026-10-10" }),
    ]) {
      const { db } = modernDb({ markers: [prior] });
      await expect(
        replaceMaineCandidateFinanceSnapshot({ db, ...modernInput() }),
      ).resolves.toMatchObject({ mapLightCommitteeDonorsWritten: 1 });
    }
  });
  it.each([
    "2026-02-29 09:59 ET",
    "2026-10-11 24:00 ET",
    "2026-10-11 09:60 ET",
    "2026-10-11T09:59:00Z",
  ])("rejects invalid publisher time %s", async (value) => {
    const { db } = modernDb();
    const input = modernInput();
    input.mapLightSource!.publishedSourceTimes!.allFiler = value;
    await expect(
      replaceMaineCandidateFinanceSnapshot({ db, ...input }),
    ).rejects.toThrow("Maine MapLight write:");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("rejects duplicate receipt IDs, untyped donors and wrong target/monetary allocations", async () => {
    const invalid = [
      () => {
        const input = modernInput();
        input.mapLightCommitteeDonors = [
          input.mapLightCommitteeDonors![0],
          {
            ...input.mapLightCommitteeDonors![0],
            committeeId: "reported:OTHER PAC",
            committeeName: "Other PAC",
          },
        ];
        return input;
      },
      () => {
        const input = modernInput();
        input.mapLightCommitteeDonors = [
          {
            ...input.mapLightCommitteeDonors![0],
            sourceReportedClass: "business" as never,
          },
        ];
        return input;
      },
      () => {
        const input = modernInput();
        input.mapLightOutsideAllocations = [
          {
            ...input.mapLightOutsideAllocations![0],
            candidateId: mapId("f", "x"),
          },
        ];
        return input;
      },
      () => {
        const input = modernInput();
        input.mapLightOutsideAllocations = [
          {
            ...input.mapLightOutsideAllocations![0],
            amountSpentOnCandidateCents: 10001,
          },
        ];
        return input;
      },
    ];
    for (const build of invalid) {
      const { db } = modernDb();
      await expect(
        replaceMaineCandidateFinanceSnapshot({ db, ...build() }),
      ).rejects.toThrow();
      expect(db.connect).not.toHaveBeenCalled();
    }
  });
  it("rolls back marker and both components on an allocation insert failure", async () => {
    const { db, client } = modernDb({
      failSql: "INSERT INTO public.me_candidate_finance_maplight_allocations",
    });
    await expect(
      replaceMaineCandidateFinanceSnapshot({ db, ...modernInput() }),
    ).rejects.toThrow("Synthetic state write failure");
    expect(
      client.query.mock.calls.some((call) =>
        call[0].includes("INSERT INTO public.me_candidate_finance_pac_donors"),
      ),
    ).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some((call) => call[0] === "COMMIT")).toBe(
      false,
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
