import { describe, expect, it, vi } from "vitest";

import {
  deactivateMichiganFinanceLinksForCandidateElection,
  replaceMichiganCandidateFinanceSnapshot,
  upsertMichiganFinanceLink,
} from "../../../src/pipeline/michiganFinance/michiganFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_URL =
  "https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do?page=page.miboeContributionPublicSearch";

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2022,
    candidateNameNormalized: "GRETCHEN WHITMER",
    officeName: "Governor",
    committeeId: "514456",
    committeeName: "WHITMER FOR GOVERNOR",
    linkSource: "mitn_public_search" as const,
    sourceUrl: SOURCE_URL,
    lastVerifiedAt: new Date("2022-01-01T00:00:00.000Z"),
  };
}

describe("michiganFinanceWriter", () => {
  it("upserts Michigan finance links and returns the link id", async () => {
    const db = createMockDb();

    await expect(upsertMichiganFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.mi_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, committee_id)");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("WHEN mi_candidate_finance_links.link_source = 'manual'");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2022,
      "GRETCHEN WHITMER",
      "Governor",
      null,
      "514456",
      "WHITMER FOR GOVERNOR",
      "active",
      "mitn_public_search",
      SOURCE_URL,
      "2022-01-01T00:00:00.000Z",
    ]);
  });

  it("does not deactivate manually curated Michigan finance links", async () => {
    const db = createMockDb();

    await expect(
      deactivateMichiganFinanceLinksForCandidateElection({
        db,
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2022,
        verifiedAt: new Date("2022-01-01T00:00:00.000Z"),
      })
    ).resolves.toBe(1);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_source IS DISTINCT FROM 'manual'");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2022,
      "2022-01-01T00:00:00.000Z",
    ]);
  });

  it("replaces a Michigan finance snapshot inside a transaction", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    const result = await replaceMichiganCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2022-02-03T04:05:06.000Z"),
      summary: {
        totalReceipts: 5350,
        directContributionTotal: 5350,
        candidateLoanTotal: 1000,
        outsideSupportTotal: 0,
        outsideOpposeTotal: 863076.75,
        sourceUrl: SOURCE_URL,
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 350,
          contributorCount: 2,
          sourceUrl: SOURCE_URL,
        },
        {
          categoryType: "contribution_size",
          categoryName: "$250-$499",
          amount: 250,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideGroups: [
        {
          committeeId: "520012",
          committeeName: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
          supportOppose: "oppose",
          amount: 863076.75,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeId: "520012",
          supportOppose: "oppose",
          categoryType: "donor",
          categoryName: "Energy Transfer LLC",
          amount: 35000,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
        {
          committeeId: "520012",
          supportOppose: "oppose",
          categoryType: "industry",
          categoryName: "oil_gas_energy",
          amount: 35000,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);

    // Every statement's highest $N placeholder must match its param count —
    // catches a placeholder edited in one INSERT leaking into an identical
    // VALUES line elsewhere (mocks never validate SQL arity, Postgres does).
    for (const call of client.query.mock.calls) {
      const statement = String(call[0]);
      const placeholders = [...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      const maxPlaceholder = placeholders.length > 0 ? Math.max(...placeholders) : 0;
      expect({ statement, maxPlaceholder }).toEqual({
        statement,
        maxPlaceholder: (call[1] as unknown[] | undefined)?.length ?? 0,
      });
    }

    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.mi_candidate_finance_summaries"))).toBe(true);
    expect(sql.some((statement) => statement.includes("total_receipts = EXCLUDED.total_receipts"))).toBe(true);
    expect(sql.some((statement) => statement.includes("COALESCE(EXCLUDED.total_receipts"))).toBe(false);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.mi_candidate_finance_direct_breakdowns"))).toHaveLength(2);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.mi_candidate_finance_outside_groups"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.mi_candidate_finance_outside_group_breakdowns"))).toHaveLength(2);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.mi_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.mi_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.mi_candidate_finance_outside_group_breakdowns"))).toBe(true);
  });

  it("preserves prior outside totals when a partial refresh does not have expenditure data", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    };

    await replaceMichiganCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2022-02-03T04:05:06.000Z"),
      summary: {
        totalReceipts: 5350,
        directContributionTotal: 5350,
        outsideSupportTotal: null,
        outsideOpposeTotal: null,
      },
    });

    const summaryCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.mi_candidate_finance_summaries")
    );
    expect(String(summaryCall?.[0])).toContain(
      "outside_support_total = COALESCE(\n          EXCLUDED.outside_support_total,\n          mi_candidate_finance_summaries.outside_support_total\n        )"
    );
    expect(String(summaryCall?.[0])).toContain(
      "outside_oppose_total = COALESCE(\n          EXCLUDED.outside_oppose_total,\n          mi_candidate_finance_summaries.outside_oppose_total\n        )"
    );
    expect(String(summaryCall?.[0])).toContain("candidate_loan_total = EXCLUDED.candidate_loan_total");
    // candidate_loan_total omitted -> null param at index 4; outside totals at 7/8.
    expect(summaryCall?.[1]?.[4]).toBeNull();
    expect(summaryCall?.[1]?.[7]).toBeNull();
    expect(summaryCall?.[1]?.[8]).toBeNull();
  });

  it("wraps a supplied queryable in a transaction", async () => {
    const db = createMockDb();

    const result = await replaceMichiganCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2022-02-03T04:05:06.000Z"),
      summary: { totalReceipts: 1000 },
    });

    expect(result.summaryWritten).toBe(true);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rejects a supplied PoolClient so it cannot commit an outer transaction", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
      release: vi.fn(),
    };

    await expect(
      replaceMichiganCandidateFinanceSnapshot({
        db: client,
        link: baseLink(),
        syncedAt: new Date("2022-02-03T04:05:06.000Z"),
        summary: { totalReceipts: 1000 },
      })
    ).rejects.toThrow("Michigan finance snapshot writes must receive a Pool, not a PoolClient");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects outside breakdown snapshots without outside groups", async () => {
    const db = createMockDb();

    await expect(
      replaceMichiganCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroupBreakdowns: [
          {
            committeeId: "520012",
            supportOppose: "oppose",
            categoryType: "industry",
            categoryName: "oil_gas_energy",
            amount: 35000,
          },
        ],
      })
    ).rejects.toThrow("outside group breakdowns require outside groups");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects outside breakdown snapshots with mismatched outside groups", async () => {
    const db = createMockDb();

    await expect(
      replaceMichiganCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroups: [
          {
            committeeId: "520012",
            committeeName: "GET MICHIGAN WORKING AGAIN",
            supportOppose: "support",
            amount: 100,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "520012",
            supportOppose: "oppose",
            categoryType: "industry",
            categoryName: "oil_gas_energy",
            amount: 35000,
          },
        ],
      })
    ).rejects.toThrow("outside group breakdowns must reference outside groups");
    expect(db.query).not.toHaveBeenCalled();
  });
});

const PAC_DONOR = {
  committeeId: "500010", committeeName: "Michigan Workers PAC", committeeType: "Independent",
  amount: 250, contributionCount: 2, sourceUrl: SOURCE_URL,
};

// A transactional fake keeps committed rows separate from pending writes.
// Unlike a statement-only mock, it catches clearing rows before rollback.
function pacSnapshotDb(failAfterDelete = false) {
  let committed = new Map([["500010", 10], ["stale", 20]]);
  let pending: Map<string, number> | null = null;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN") pending = new Map(committed);
    else if (sql === "COMMIT") { committed = pending!; pending = null; }
    else if (sql === "ROLLBACK") pending = null;
    else if (sql.includes("INSERT INTO public.mi_candidate_finance_pac_donors")) {
      pending!.set(String(values![2]), Number(values![5]));
    } else if (sql.includes("DELETE FROM public.mi_candidate_finance_pac_donors")) {
      const keep = new Set(values![2] as string[]);
      for (const id of pending!.keys()) if (!keep.has(id)) pending!.delete(id);
      if (failAfterDelete) throw new Error("PAC cleanup failed");
    }
    return { rows: [{ id: LINK_ID }], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }, client,
    rows: () => [...committed.entries()] };
}

describe("Michigan PAC donor snapshot replacement", () => {
  it("preserves prior PAC donors when the field is omitted", async () => {
    const { db, client, rows } = pacSnapshotDb();
    const result = await replaceMichiganCandidateFinanceSnapshot({ db, link: baseLink(), summary: { totalReceipts: 100 } });
    expect(rows()).toEqual([["500010", 10], ["stale", 20]]);
    expect(client.query.mock.calls.some(([sql]) => sql.includes("mi_candidate_finance_pac_donors"))).toBe(false);
    expect(result.pacDonorsWritten).toBeUndefined();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("replaces donors and clears stale rows on the same transaction client", async () => {
    const { db, client, rows } = pacSnapshotDb();
    const result = await replaceMichiganCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [PAC_DONOR] });
    expect(rows()).toEqual([["500010", 250]]);
    expect(result.pacDonorsWritten).toBe(1);
    expect(db.query).not.toHaveBeenCalled();
    const insert = client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.mi_candidate_finance_pac_donors"));
    expect(insert?.[1]).toEqual([LINK_ID, 2022, "500010", "Michigan Workers PAC", "Independent", 250, 2, SOURCE_URL, expect.any(String)]);
    expect(String(insert?.[0])).toContain("committee_type = EXCLUDED.committee_type");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    for (const [sql, params] of client.query.mock.calls) {
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      expect(placeholders.length ? Math.max(...placeholders) : 0).toBe(params?.length ?? 0);
    }
  });

  it("clears prior PAC donors with an explicit empty list", async () => {
    const { db, client, rows } = pacSnapshotDb();
    await expect(replaceMichiganCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [] }))
      .resolves.toMatchObject({ pacDonorsWritten: 0 });
    expect(rows()).toEqual([]);
    const deletion = client.query.mock.calls.find(([sql]) => sql.includes("DELETE FROM public.mi_candidate_finance_pac_donors"));
    expect(deletion?.[1]).toEqual([LINK_ID, 2022, []]);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rolls back both replacement and cleanup after a failure", async () => {
    const { db, client, rows } = pacSnapshotDb(true);
    await expect(replaceMichiganCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [PAC_DONOR] }))
      .rejects.toThrow("PAC cleanup failed");
    expect(rows()).toEqual([["500010", 10], ["stale", 20]]);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("omits zero-dollar net donors while still clearing stale rows", async () => {
    const { db, rows } = pacSnapshotDb();
    await expect(replaceMichiganCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [{ ...PAC_DONOR, amount: 0 }] }))
      .resolves.toMatchObject({ pacDonorsWritten: 0 });
    expect(rows()).toEqual([]);
  });

  it.each([
    { amount: -1 }, { amount: NaN }, { amount: Infinity },
    { contributionCount: -1 }, { contributionCount: 1.5 }, { committeeType: " " },
  ])("rejects invalid donor input before replacing data: %j", async (change) => {
    const { db, rows } = pacSnapshotDb();
    await expect(replaceMichiganCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [{ ...PAC_DONOR, ...change }] }))
      .rejects.toThrow();
    expect(db.connect).not.toHaveBeenCalled();
    expect(rows()).toEqual([["500010", 10], ["stale", 20]]);
  });
});

describe("verified candidate/election outside snapshots", () => {
  const SIBLING_ID = "44444444-4444-4444-4444-444444444444";
  const MISSING_ID = "55555555-5555-5555-5555-555555555555";
  const INACTIVE_ID = "66666666-6666-6666-6666-666666666666";
  const OTHER_YEAR_ID = "77777777-7777-7777-7777-777777777777";
  const oldTimestamp = "2022-01-01T00:00:00.000Z";
  const newTimestamp = new Date("2022-02-03T04:05:06.000Z");

  function transactionalDb(failSibling = false) {
    type Summary = Record<string, unknown>;
    type State = { summaries: Record<string, Summary>; groups: Record<string, number[]>; breakdowns: Record<string, number[]> };
    let state: State = {
      summaries: Object.fromEntries([LINK_ID, SIBLING_ID, INACTIVE_ID, OTHER_YEAR_ID].map((id) => [id, {
        total_receipts: 700, direct_contribution_total: 600, candidate_loan_total: 100,
        total_disbursements: 50, cash_on_hand: 650, source_url: "old-direct-source",
        last_synced_at: oldTimestamp, outside_support_total: 100, outside_oppose_total: 20,
      }])),
      groups: Object.fromEntries([LINK_ID, SIBLING_ID, INACTIVE_ID, OTHER_YEAR_ID].map((id) => [id, [100]])),
      breakdowns: Object.fromEntries([LINK_ID, SIBLING_ID, INACTIVE_ID, OTHER_YEAR_ID].map((id) => [id, [100]])),
    };
    let pending: State | undefined;
    const client = {
      release: vi.fn(),
      query: vi.fn(async (statement: string, values: unknown[] = []) => {
        if (statement === "BEGIN") { pending = structuredClone(state); return { rows: [] }; }
        if (statement === "COMMIT") { state = pending!; pending = undefined; return { rows: [] }; }
        if (statement === "ROLLBACK") { pending = undefined; return { rows: [] }; }
        const active = pending!;
        const id = String(values[0]);
        if (statement.includes("INSERT INTO public.mi_candidate_finance_links")) return { rows: [{ id: LINK_ID }] };
        if (statement.includes("SELECT id::text AS id")) {
          expect(values).toEqual([CANDIDATE_ID, ELECTION_ID, 2022, LINK_ID]);
          expect(statement).toContain("link_status = 'active'");
          expect(statement).toContain("election_year = $3");
          expect(statement).toContain("candidate_id = $1::uuid");
          expect(statement).toContain("election_id = $2::uuid");
          return { rows: [{ id: SIBLING_ID }, { id: MISSING_ID }] };
        }
        if (statement.includes("INSERT INTO public.mi_candidate_finance_summaries")) {
          const columns = statement.match(/summaries\s*\(([\s\S]*?)\)\s*VALUES/)![1]!.split(",").map((column) => column.trim());
          const inserted = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
          const existing = active.summaries[id];
          if (existing) {
            const update = statement.split("DO UPDATE SET")[1]!;
            for (const match of update.matchAll(/(\w+)\s*=\s*(?:COALESCE\(\s*)?EXCLUDED\.(\w+)/g)) {
              const value = inserted[match[2]!];
              if (value != null || !match[0].includes("COALESCE")) existing[match[1]!] = value;
            }
          } else active.summaries[id] = inserted;
        }
        if (statement.includes("INSERT INTO public.mi_candidate_finance_outside_groups")) {
          active.groups[id] = [Number(values[5])];
        }
        if (statement.includes("INSERT INTO public.mi_candidate_finance_outside_group_breakdowns")) {
          active.breakdowns[id] = [Number(values[6])];
        }
        if (statement.includes("DELETE FROM public.mi_candidate_finance_outside_group_breakdowns")) {
          if (failSibling && id === SIBLING_ID) throw new Error("sibling cleanup failed");
          if (values[2] === "[]") active.breakdowns[id] = [];
        } else if (statement.includes("DELETE FROM public.mi_candidate_finance_outside_groups") && values[2] === "[]") active.groups[id] = [];
        // Direct/PAC writes are deliberately observable separately from the outside state.
        return { rows: [], rowCount: 1 };
      }),
    };
    return { db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) }, client, state: () => state };
  }

  function snapshot(clear = false) {
    return {
      link: baseLink(), syncedAt: newTimestamp, candidateElectionOutsideSnapshot: true,
      summary: { totalReceipts: 50, directContributionTotal: 50, outsideSupportTotal: clear ? 0 : 50, outsideOpposeTotal: 0, sourceUrl: SOURCE_URL },
      outsideGroups: clear ? [] : [{ committeeId: "520012", committeeName: "PAC", supportOppose: "support" as const, amount: 50 }],
      outsideGroupBreakdowns: clear ? [] : [{ committeeId: "520012", supportOppose: "support" as const, categoryType: "donor" as const, categoryName: "Donor", amount: 50 }],
    };
  }

  it("replaces stale larger sibling outside totals without refreshing sibling direct money", async () => {
    const store = transactionalDb();
    const originalSibling = structuredClone(store.state().summaries[SIBLING_ID]!);
    await replaceMichiganCandidateFinanceSnapshot({ db: store.db, ...snapshot() });
    const state = store.state();
    expect(state.summaries[SIBLING_ID]).toEqual({ ...originalSibling, outside_support_total: 50, outside_oppose_total: 0 });
    expect(state.summaries[LINK_ID]).toMatchObject({ total_receipts: 50, last_synced_at: newTimestamp.toISOString() });
    expect(state.summaries[MISSING_ID]).toMatchObject({ outside_support_total: 50, outside_oppose_total: 0, last_synced_at: new Date(0).toISOString() });
    expect(state.summaries[MISSING_ID]).not.toHaveProperty("direct_contribution_total");
    expect(state.summaries[MISSING_ID]).not.toHaveProperty("source_url");
    for (const id of [LINK_ID, SIBLING_ID, MISSING_ID]) {
      expect(state.groups[id]).toEqual([50]);
      expect(state.breakdowns[id]).toEqual([50]);
    }
    for (const id of [INACTIVE_ID, OTHER_YEAR_ID]) {
      expect(state.summaries[id]?.outside_support_total).toBe(100);
      expect(state.groups[id]).toEqual([100]);
      expect(state.breakdowns[id]).toEqual([100]);
    }
    expect(Math.max(...[LINK_ID, SIBLING_ID, MISSING_ID].map((id) => Number(state.summaries[id]?.outside_support_total)))).toBe(50);
    for (const [sql, values] of store.client.query.mock.calls) {
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      expect(placeholders.length ? Math.max(...placeholders) : 0).toBe(values?.length ?? 0);
      if (values?.[0] === SIBLING_ID || values?.[0] === MISSING_ID) {
        expect(sql).not.toContain("mi_candidate_finance_direct_breakdowns");
        expect(sql).not.toContain("mi_candidate_finance_pac_donors");
      }
    }
    expect(store.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(store.client.release).toHaveBeenCalledOnce();
  });

  it("clears stale outside rows on every active sibling after a verified empty export", async () => {
    const store = transactionalDb();
    await replaceMichiganCandidateFinanceSnapshot({ db: store.db, ...snapshot(true) });
    for (const id of [LINK_ID, SIBLING_ID, MISSING_ID]) {
      expect(store.state().summaries[id]).toMatchObject({ outside_support_total: 0, outside_oppose_total: 0 });
      expect(store.state().groups[id]).toEqual([]);
      expect(store.state().breakdowns[id]).toEqual([]);
    }
    expect(store.state().summaries[SIBLING_ID]?.last_synced_at).toBe(oldTimestamp);
  });

  it.each(["default", "omitted groups", "omitted breakdowns", "missing total"] as const)("does not propagate an incomplete snapshot: %s", async (kind) => {
    const store = transactionalDb();
    const input = snapshot();
    await replaceMichiganCandidateFinanceSnapshot({
      db: store.db, ...input,
      ...(kind === "default" ? { candidateElectionOutsideSnapshot: undefined } : {}),
      ...(kind === "omitted groups" ? { outsideGroups: undefined, outsideGroupBreakdowns: undefined } : {}),
      ...(kind === "omitted breakdowns" ? { outsideGroupBreakdowns: undefined } : {}),
      ...(kind === "missing total" ? { summary: { ...input.summary, outsideSupportTotal: null } } : {}),
    });
    expect(store.client.query.mock.calls.some(([sql]) => sql.includes("SELECT id::text AS id"))).toBe(false);
    expect(store.state().summaries[SIBLING_ID]?.outside_support_total).toBe(100);
  });

  it("rolls back selected and sibling writes when sibling cleanup fails", async () => {
    const store = transactionalDb(true);
    const before = structuredClone(store.state());
    await expect(replaceMichiganCandidateFinanceSnapshot({ db: store.db, ...snapshot() })).rejects.toThrow("sibling cleanup failed");
    expect(store.state()).toEqual(before);
    expect(store.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(store.client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(store.client.release).toHaveBeenCalledOnce();
  });
});
