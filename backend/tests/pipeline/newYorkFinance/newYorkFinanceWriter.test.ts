import { describe, expect, it, vi } from "vitest";

import {
  replaceNewYorkCandidateFinanceSnapshot,
  upsertNewYorkFinanceLink,
} from "../../../src/pipeline/newYorkFinance/newYorkFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "KATHY HOCHUL",
    officeName: "Governor",
    filerId: "16851",
    filerName: "Friends for Kathy Hochul",
    linkSource: "ny_soda_api" as const,
    sourceUrl: "https://data.ny.gov/d/7x2g-h32p",
    lastVerifiedAt: new Date("2026-07-11T00:00:00.000Z"),
  };
}

describe("newYorkFinanceWriter", () => {
  it("retires other active links before upserting, so committee changes cannot trip the single-active index", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    };

    await expect(
      upsertNewYorkFinanceLink({ db, link: baseLink() }),
    ).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query).toHaveBeenCalledTimes(2);
    const [deactivateSql, deactivateParams] = db.query.mock.calls[0];
    expect(String(deactivateSql)).toContain("SET link_status = 'inactive'");
    expect(String(deactivateSql)).toContain("filer_id <> $3");
    expect(String(deactivateSql)).toContain(
      "(link_source IS DISTINCT FROM 'manual' OR $4 = 'manual')",
    );
    expect(deactivateParams).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      "16851",
      "ny_soda_api",
    ]);

    expect(String(db.query.mock.calls[1]?.[0])).toContain(
      "INSERT INTO public.ny_candidate_finance_links",
    );
    expect(String(db.query.mock.calls[1]?.[0])).toContain(
      "ON CONFLICT (candidate_id, election_id, filer_id)",
    );
    expect(db.query.mock.calls[1]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "KATHY HOCHUL",
      "Governor",
      null,
      "16851",
      "Friends for Kathy Hochul",
      "active",
      "ny_soda_api",
      "https://data.ny.gov/d/7x2g-h32p",
      "2026-07-11T00:00:00.000Z",
    ]);
  });

  it("replaces a New York finance snapshot inside a transaction and prunes stale rows", async () => {
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

    const result = await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-07-11T04:05:06.000Z"),
      summary: {
        outsideSupportTotal: 12_320_650.23,
        outsideOpposeTotal: 0,
        sourceUrl: "https://data.ny.gov/d/e9ss-239a",
      },
      outsideGroups: [
        {
          filerId: "590891",
          filerName: "Citizens for Affordable Rates PAC",
          supportOppose: "support",
          amount: 12_320_650.23,
          sourceUrl: "https://data.ny.gov/d/e9ss-239a",
        },
      ],
      outsideGroupBreakdowns: [
        {
          filerId: "590891",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "Uber Technologies Inc.",
          amount: 11_686_700.23,
          contributorCount: 23,
          sourceUrl: "https://data.ny.gov/d/e9ss-239a",
        },
        {
          filerId: "590891",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "transportation",
          amount: 11_686_700.23,
          contributorCount: 23,
          sourceUrl: "https://data.ny.gov/d/e9ss-239a",
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
    });

    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(
      statements.some((sql) =>
        sql.includes("INSERT INTO public.ny_candidate_finance_summaries"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes("INSERT INTO public.ny_candidate_finance_outside_groups"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes(
          "INSERT INTO public.ny_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes("DELETE FROM public.ny_candidate_finance_outside_groups"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes(
          "DELETE FROM public.ny_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toBe(true);
    // No direct breakdowns provided in Phase 1: their delete never runs.
    expect(
      statements.some((sql) =>
        sql.includes(
          "DELETE FROM public.ny_candidate_finance_direct_breakdowns",
        ),
      ),
    ).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it("rolls back and rethrows when a write fails", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (
          String(sql).includes(
            "INSERT INTO public.ny_candidate_finance_summaries",
          )
        ) {
          throw new Error("summary write failed");
        }
        return { rows: [{ id: LINK_ID }], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await expect(
      replaceNewYorkCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        summary: { outsideSupportTotal: 1, outsideOpposeTotal: 0 },
      }),
    ).rejects.toThrow("summary write failed");

    expect(client.query.mock.calls.map((call) => String(call[0]))).toContain(
      "ROLLBACK",
    );
    expect(client.release).toHaveBeenCalled();
  });

  it("rejects breakdowns without their groups and non-pool databases", async () => {
    const clientLike = { query: vi.fn(), release: vi.fn() };
    await expect(
      replaceNewYorkCandidateFinanceSnapshot({
        db: clientLike as never,
        link: baseLink(),
      }),
    ).rejects.toThrow("must receive a Pool, not a PoolClient");

    const db = { query: vi.fn(), connect: vi.fn() };
    await expect(
      replaceNewYorkCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroupBreakdowns: [
          {
            filerId: "590891",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Uber Technologies Inc.",
            amount: 1,
          },
        ],
      }),
    ).rejects.toThrow("require outside groups");
  });
});

function pac(overrides: Record<string, unknown> = {}) {
  return {
    committeeId: "reported:EXAMPLE PAC",
    committeeName: "Example PAC",
    sourceReportedClass: "Political Action Committee (PAC)" as const,
    amount: 500,
    contributionCount: 2,
    sourceUrl: "https://data.ny.gov/d/e9ss-239a",
    ...overrides,
  };
}
function transactionalDb(failTable?: string) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (failTable && sql.includes(failTable))
        throw new Error("PAC write failed");
      return { rows: [{ id: LINK_ID }], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return {
    client,
    db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) },
  };
}
describe("New York typed reported PAC snapshot", () => {
  it("omitted/null outside summary values preserve prior totals and omit all outside pruning", async () => {
    const { db, client } = transactionalDb();
    await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: {
        directContributionTotal: 1200,
        outsideSupportTotal: null,
        outsideOpposeTotal: null,
      },
    });
    const summary = client.query.mock.calls.find((c) =>
      String(c[0]).includes(
        "INSERT INTO public.ny_candidate_finance_summaries",
      ),
    )!;
    expect(String(summary[0])).toContain(
      "outside_support_total = COALESCE(EXCLUDED.outside_support_total, ny_candidate_finance_summaries.outside_support_total)",
    );
    expect(String(summary[0])).toContain(
      "outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, ny_candidate_finance_summaries.outside_oppose_total)",
    );
    expect(
      client.query.mock.calls.some((c) =>
        /DELETE FROM public.ny_candidate_finance_outside/.test(String(c[0])),
      ),
    ).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("omitted PAC component does not mutate donor rows while independent direct summary commits", async () => {
    const { db, client } = transactionalDb();
    const r = await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: { directContributionTotal: 1200 },
    });
    expect(r).not.toHaveProperty("pacDonorsWritten");
    expect(
      client.query.mock.calls.some((c) =>
        String(c[0]).includes("ny_candidate_finance_pac_donors"),
      ),
    ).toBe(false);
    expect(
      client.query.mock.calls.some((c) =>
        String(c[0]).includes("ny_candidate_finance_summaries"),
      ),
    ).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("explicit empty component prunes only the exact receiving link/year", async () => {
    const { db, client } = transactionalDb();
    const r = await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      pacDonors: [],
    });
    expect(r.pacDonorsWritten).toBe(0);
    const deletes = client.query.mock.calls.filter((c) =>
      String(c[0]).includes(
        "DELETE FROM public.ny_candidate_finance_pac_donors",
      ),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual([LINK_ID, 2026, []]);
    expect(String(deletes[0][0])).toContain(
      "link_id=$1::uuid AND election_year=$2",
    );
    expect(
      client.query.mock.calls.some((c) =>
        /ny_candidate_finance_(summaries|direct_breakdowns|outside_groups)/.test(
          String(c[0]),
        ),
      ),
    ).toBe(false);
  });
  it("writes gross typed positions and gift occurrences atomically without altering direct or outside business fields", async () => {
    const { db, client } = transactionalDb();
    const r = await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2026-10-12T20:00:00Z"),
      pacDonors: [
        pac(),
        pac({
          committeeId: "reported:A & B P.A.C.",
          committeeName: "A & B P.A.C.",
          amount: 0,
          contributionCount: 0,
          sourceUrl: null,
        }),
      ],
    });
    expect(r).toMatchObject({
      summaryWritten: false,
      pacDonorsWritten: 2,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
    });
    const inserts = client.query.mock.calls.filter((c) =>
      String(c[0]).includes(
        "INSERT INTO public.ny_candidate_finance_pac_donors",
      ),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toEqual([
      LINK_ID,
      2026,
      "reported:EXAMPLE PAC",
      "Example PAC",
      "Political Action Committee (PAC)",
      500,
      2,
      "https://data.ny.gov/d/e9ss-239a",
      "2026-10-12T20:00:00.000Z",
    ]);
    expect(
      client.query.mock.calls.filter((c) =>
        String(c[0]).includes("ny_candidate_finance_summaries"),
      ),
    ).toHaveLength(0);
    expect(client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it.each([
    { amount: -1 },
    { amount: 0.001 },
    { amount: NaN },
    { amount: Infinity },
    { amount: 1e14 },
    { contributionCount: -1 },
    { contributionCount: 1.5 },
    { contributionCount: Infinity },
    { sourceReportedClass: "Political Committee" },
    { sourceReportedClass: "Corporation" },
    { committeeId: "590891" },
    { committeeId: "reported:DIFFERENT NAME" },
    { committeeName: "" },
  ])(
    "rejects unsafe gross/class/reported identity before connecting %#",
    async (change) => {
      const { db } = transactionalDb();
      await expect(
        replaceNewYorkCandidateFinanceSnapshot({
          db,
          link: baseLink(),
          pacDonors: [pac(change)] as never,
        }),
      ).rejects.toThrow();
      expect(db.connect).not.toHaveBeenCalled();
    },
  );
  it("rejects repeated reported donor IDs instead of overwriting one amount", async () => {
    const { db } = transactionalDb();
    await expect(
      replaceNewYorkCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        pacDonors: [pac(), pac({ committeeName: "EXAMPLE PAC", amount: 1000 })],
      }),
    ).rejects.toThrow("unique exact reported-name");
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("keeps punctuation-distinct reported labels as separate donor groups", async () => {
    const { db, client } = transactionalDb();
    await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      pacDonors: [
        pac({ committeeId: "reported:A-B PAC", committeeName: "A-B PAC" }),
        pac({ committeeId: "reported:A B PAC", committeeName: "A B PAC" }),
      ],
    });
    const inserts = client.query.mock.calls.filter((c) =>
      String(c[0]).includes(
        "INSERT INTO public.ny_candidate_finance_pac_donors",
      ),
    );
    expect(inserts.map((c) => (c[1] as unknown[])[2])).toEqual([
      "reported:A-B PAC",
      "reported:A B PAC",
    ]);
  });
  it("rolls back donor failure together with direct writes and link changes", async () => {
    const { db, client } = transactionalDb(
      "INSERT INTO public.ny_candidate_finance_pac_donors",
    );
    await expect(
      replaceNewYorkCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        summary: { directContributionTotal: 1200 },
        pacDonors: [pac()],
      }),
    ).rejects.toThrow("PAC write failed");
    const sql = client.query.mock.calls.map((c) => String(c[0]));
    expect(
      sql.some((s) =>
        s.includes("INSERT INTO public.ny_candidate_finance_summaries"),
      ),
    ).toBe(true);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("retains the entire source generation before asynchronous connect", async () => {
    const { db, client } = transactionalDb();
    const input = {
      db,
      link: baseLink(),
      syncedAt: new Date("2026-10-12T20:00:00Z"),
      pacDonors: [pac()],
      summary: { directContributionTotal: 1200 },
    };
    db.connect.mockImplementation(async () => {
      input.link.filerId = "CHANGED";
      input.pacDonors[0].amount = 999;
      input.pacDonors[0].committeeName = "CHANGED";
      input.syncedAt.setUTCFullYear(2020);
      input.summary.directContributionTotal = 0;
      return client;
    });
    await replaceNewYorkCandidateFinanceSnapshot(input);
    const donorInsert = client.query.mock.calls.find((c) =>
      String(c[0]).includes(
        "INSERT INTO public.ny_candidate_finance_pac_donors",
      ),
    )!;
    expect((donorInsert[1] as unknown[]).slice(2, 7)).toEqual([
      "reported:EXAMPLE PAC",
      "Example PAC",
      "Political Action Committee (PAC)",
      500,
      2,
    ]);
    expect((donorInsert[1] as unknown[])[8]).toBe("2026-10-12T20:00:00.000Z");
    const summary = client.query.mock.calls.find((c) =>
      String(c[0]).includes(
        "INSERT INTO public.ny_candidate_finance_summaries",
      ),
    )!;
    expect(summary[1]).toContain(1200);
  });
});

describe("New York partial outside updates", () => {
  it("upserts a known payer A without pruning retained payer B or its breakdowns", async () => {
    const { db, client } = transactionalDb();
    const retained = new Map([["payer-B", 900]]);
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE FROM public.ny_candidate_finance_outside"))
        retained.delete("payer-B");
      return { rows: [{ id: LINK_ID }], rowCount: 1 };
    });
    const result = await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      outsideWriteMode: "upsert",
      outsideGroups: [
        {
          filerId: "payer-A",
          filerName: "Known payer A",
          supportOppose: "support",
          amount: 200,
        },
      ],
      outsideGroupBreakdowns: [
        {
          filerId: "payer-A",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "Known donor",
          amount: 200,
        },
      ],
    });
    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
    });
    const statements = client.query.mock.calls.map((c) => String(c[0]));
    expect(
      statements.some((s) =>
        s.includes("INSERT INTO public.ny_candidate_finance_outside_groups"),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.includes(
          "INSERT INTO public.ny_candidate_finance_outside_group_breakdowns",
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.includes("DELETE FROM public.ny_candidate_finance_outside"),
      ),
    ).toBe(false);
    expect(retained.get("payer-B")).toBe(900);
    expect(statements.at(-1)).toBe("COMMIT");
  });
  it("empty upsert arrays preserve outside rows while explicit PAC replacement remains independent", async () => {
    const { db, client } = transactionalDb();
    await replaceNewYorkCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      outsideWriteMode: "upsert",
      outsideGroups: [],
      outsideGroupBreakdowns: [],
      pacDonors: [],
    });
    const statements = client.query.mock.calls.map((c) => String(c[0]));
    expect(
      statements.some((s) =>
        s.includes("DELETE FROM public.ny_candidate_finance_outside"),
      ),
    ).toBe(false);
    expect(
      statements.some((s) =>
        s.includes("DELETE FROM public.ny_candidate_finance_pac_donors"),
      ),
    ).toBe(true);
  });
  it("rejects an unsupported outside mode before connecting", async () => {
    const { db } = transactionalDb();
    await expect(
      replaceNewYorkCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideWriteMode: "append" as never,
      }),
    ).rejects.toThrow("outside write mode");
    expect(db.connect).not.toHaveBeenCalled();
  });
});
