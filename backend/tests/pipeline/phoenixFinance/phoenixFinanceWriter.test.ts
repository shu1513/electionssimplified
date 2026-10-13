import { describe, expect, it, vi } from "vitest";
import {
  replacePhoenixCandidateFinanceSnapshot,
  upsertPhoenixFinanceLink,
} from "../../../src/pipeline/phoenixFinance/phoenixFinanceWriter.js";

// A query mock that answers the link INSERT with an id and everything else
// with empty rows — the writer's control flow (manual SELECT, deactivate
// UPDATE, detail deletes/inserts) all tolerate empty results.
function queryMock(overrides?: (sql: string) => { rows: unknown[] } | null) {
  return vi.fn().mockImplementation((sql: unknown) => {
    const s = String(sql);
    const override = overrides?.(s);
    if (override) return Promise.resolve(override);
    if (s.startsWith("INSERT INTO public.phx_candidate_finance_links"))
      return Promise.resolve({ rows: [{ id: "link-1" }] });
    return Promise.resolve({ rows: [] });
  });
}

const link = {
  candidateId: "c",
  electionId: "e",
  electionYear: 2026,
  candidateNameNormalized: "ED HERMES",
  copId: "CAN-25-4",
  committeeName: "Hermes for Phoenix",
  portalCycleName: "2025-2027",
  portalCycleStart: "2025-04-01",
  portalCycleEnd: "2027-03-31",
};

const summary = {
  totalRaisedCents: 31613910,
  totalSpentCents: 12345678,
  cashOnHandCents: 19268232,
  debtsOwedCents: 0,
  loansReceivedCents: 100000,
  outsideSupportCents: null,
  outsideOpposeCents: null,
  directCoverageNote: null,
  outsideCoverageNote:
    "Outside totals cover Phoenix-portal PAC filings only; standing-PAC, IE-entity, and EFD channels are not yet measured.",
  methodologyVersion: "phx-portal-v1",
  sourceUrl: "https://apps-secure.phoenix.gov/CampaignFinance",
  reportedThrough: "2026-03-31",
};

describe("Phoenix finance writer", () => {
  it("writes a full snapshot in one transaction with exact dollar strings", async () => {
    const query = queryMock();
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await replacePhoenixCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary,
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amountCents: 123456,
          contributorCount: 7,
        },
      ],
      outsideWriteMode: "replace",
      outsideGroups: [
        {
          spenderFilerId: "PAC-25-9",
          spenderName: "SOME IE COMMITTEE",
          supportOppose: "support",
          amountCents: 5000000,
          expenditureCount: 12,
        },
      ],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phx_candidate_finance_summaries"),
        expect.stringContaining(
          "DELETE FROM public.phx_candidate_finance_direct_breakdowns",
        ),
        expect.stringContaining(
          "DELETE FROM public.phx_candidate_finance_outside_groups",
        ),
      ]),
    );
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.phx_candidate_finance_summaries",
      ),
    );
    // Cents → exact dollar strings, never floats: raised, spent, cash, loans.
    expect(summaryCall?.[1]).toEqual(
      expect.arrayContaining([
        "316139.10",
        "123456.78",
        "192682.32",
        "1000.00",
      ]),
    );
    // The outside coverage disclosure is persisted alongside the totals.
    expect(summaryCall?.[1]).toEqual(
      expect.arrayContaining([summary.outsideCoverageNote]),
    );
    expect(release).toHaveBeenCalled();
  });

  it("preserves unavailable groups and omitted scalar fields during direct refresh", async () => {
    const query = queryMock();
    await replacePhoenixCandidateFinanceSnapshot({
      db: {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      } as never,
      link,
      summary: {
        ...summary,
        outsideSupportCents: undefined,
        outsideOpposeCents: undefined,
      },
      directBreakdowns: [],
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /^(?:INSERT INTO|DELETE FROM|UPDATE) public\.phx_candidate_finance_outside_groups/.test(
          String(sql),
        ),
      ),
    ).toBe(false);
    const update = query.mock.calls.find(([sql]) =>
      String(sql).startsWith(
        "INSERT INTO public.phx_candidate_finance_summaries",
      ),
    );
    expect(update?.[1].slice(15)).toEqual([true, true]);
    expect(String(update?.[0])).toContain(
      "CASE WHEN $16::boolean THEN phx_candidate_finance_summaries.outside_support_total ELSE EXCLUDED.outside_support_total END",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("writes explicit unknown scalars as NULL rather than restoring old zeros", async () => {
    const query = queryMock();
    await replacePhoenixCandidateFinanceSnapshot({
      db: {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      } as never,
      link,
      summary,
      directBreakdowns: [],
      outsideGroups: [],
    });
    const update = query.mock.calls.find(([sql]) =>
      String(sql).startsWith(
        "INSERT INTO public.phx_candidate_finance_summaries",
      ),
    );
    expect(update?.[1].slice(7, 9)).toEqual([null, null]);
    expect(update?.[1].slice(15)).toEqual([false, false]);
    expect(String(update?.[0])).not.toContain("COALESCE");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).startsWith(
          "DELETE FROM public.phx_candidate_finance_outside_groups",
        ),
      ),
    ).toBe(false);
  });

  it("upserts a lower current positive amount without deleting absent payers or directions", async () => {
    const query = queryMock();
    await replacePhoenixCandidateFinanceSnapshot({
      db: {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      } as never,
      link,
      summary,
      directBreakdowns: [],
      outsideGroups: [
        {
          spenderFilerId: "PAC-25-9",
          spenderName: "KNOWN PAYER",
          supportOppose: "support",
          amountCents: 12500,
          expenditureCount: 1,
        },
      ],
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).startsWith(
          "DELETE FROM public.phx_candidate_finance_outside_groups",
        ),
      ),
    ).toBe(false);
    const group = query.mock.calls.find(([sql]) =>
      String(sql).startsWith(
        "INSERT INTO public.phx_candidate_finance_outside_groups",
      ),
    );
    expect(String(group?.[0])).toContain(
      "ON CONFLICT (link_id,election_year,spender_filer_id,spender_name,support_oppose) DO UPDATE SET amount=EXCLUDED.amount",
    );
    expect(group?.[1].slice(2, 7)).toEqual([
      "PAC-25-9",
      "KNOWN PAYER",
      "support",
      "125.00",
      1,
    ]);
  });

  it("clears groups only for explicit complete empty replacement", async () => {
    const query = queryMock();
    await replacePhoenixCandidateFinanceSnapshot({
      db: {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      } as never,
      link,
      summary,
      directBreakdowns: [],
      outsideGroups: [],
      outsideWriteMode: "replace",
    });
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).startsWith(
          "DELETE FROM public.phx_candidate_finance_outside_groups",
        ),
      ),
    ).toHaveLength(1);
  });

  it("rejects stale observations under the lock before financial mutations", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT s.last_synced_at")
        ? { rows: [{ last_synced_at: "2026-10-12T20:00:00Z" }] }
        : null,
    );
    await expect(
      replacePhoenixCandidateFinanceSnapshot({
        db: {
          connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
        } as never,
        link,
        summary,
        directBreakdowns: [],
        syncedAt: new Date("2026-10-12T19:00:00Z"),
      }),
    ).rejects.toThrow("older than the stored observation");
    const sql = query.mock.calls.map(([sql]) => String(sql));
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain("FOR UPDATE OF s");
    expect(sql.some((s) => /^(?:INSERT|DELETE|UPDATE)\b/.test(s))).toBe(false);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
  });

  it("rejects invalid or repeated groups and modes before connecting", async () => {
    const valid = {
      spenderFilerId: "PAC-25-9",
      spenderName: "KNOWN PAYER",
      supportOppose: "support" as const,
      amountCents: 500,
      expenditureCount: 1,
    };
    for (const groups of [
      [{ ...valid, amountCents: 0 }],
      [{ ...valid, amountCents: -1 }],
      [{ ...valid, amountCents: Infinity }],
      [{ ...valid, amountCents: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...valid, expenditureCount: 1.5 }],
      [{ ...valid, supportOppose: "unknown" }],
      [valid, { ...valid }],
    ]) {
      const connect = vi.fn();
      await expect(
        replacePhoenixCandidateFinanceSnapshot({
          db: { connect } as never,
          link,
          summary,
          directBreakdowns: [],
          outsideGroups: groups as never,
        }),
      ).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
    }
    const connect = vi.fn();
    await expect(
      replacePhoenixCandidateFinanceSnapshot({
        db: { connect } as never,
        link,
        summary,
        directBreakdowns: [],
        outsideWriteMode: "wrong" as never,
      }),
    ).rejects.toThrow("write mode");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls direct and outside writes back together on group failure", async () => {
    const query = queryMock();
    const base = query.getMockImplementation()!;
    query.mockImplementation((sql: unknown) =>
      String(sql).startsWith(
        "INSERT INTO public.phx_candidate_finance_outside_groups",
      )
        ? Promise.reject(new Error("database failure"))
        : base(sql),
    );
    const release = vi.fn();
    await expect(
      replacePhoenixCandidateFinanceSnapshot({
        db: { connect: vi.fn().mockResolvedValue({ query, release }) } as never,
        link,
        summary,
        directBreakdowns: [],
        outsideGroups: [
          {
            spenderFilerId: "PAC-25-9",
            spenderName: "KNOWN PAYER",
            supportOppose: "support",
            amountCents: 500,
            expenditureCount: 1,
          },
        ],
      }),
    ).rejects.toThrow("database failure");
    const sql = query.mock.calls.map(([sql]) => String(sql));
    expect(
      sql.some((s) =>
        s.startsWith("INSERT INTO public.phx_candidate_finance_summaries"),
      ),
    ).toBe(true);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("retains one caller generation before a connection await", async () => {
    const query = queryMock();
    const mutableLink = { ...link };
    const mutableSummary = { ...summary };
    const groups = [
      {
        spenderFilerId: "PAC-25-9",
        spenderName: "KNOWN PAYER",
        supportOppose: "support" as const,
        amountCents: 500,
        expenditureCount: 1,
      },
    ];
    const connect = vi.fn(async () => {
      mutableLink.copId = "CAN-25-999";
      mutableSummary.totalRaisedCents = 1;
      groups[0].amountCents = 999;
      return { query, release: vi.fn() };
    });
    await replacePhoenixCandidateFinanceSnapshot({
      db: { connect } as never,
      link: mutableLink,
      summary: mutableSummary,
      directBreakdowns: [],
      outsideGroups: groups,
    });
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).startsWith(
          "INSERT INTO public.phx_candidate_finance_links",
        ),
      )?.[1][4],
    ).toBe("CAN-25-4");
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).startsWith(
          "INSERT INTO public.phx_candidate_finance_summaries",
        ),
      )?.[1][2],
    ).toBe("316139.10");
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).startsWith(
          "INSERT INTO public.phx_candidate_finance_outside_groups",
        ),
      )?.[1][5],
    ).toBe("5.00");
  });

  it("writes the portal cycle identity and bounds on the link row", async () => {
    const query = queryMock();
    await upsertPhoenixFinanceLink({ db: { query } as never, link });
    const insert = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.phx_candidate_finance_links",
      ),
    );
    expect(String(insert?.[0])).toContain(
      "portal_cycle_name=EXCLUDED.portal_cycle_name",
    );
    expect(insert?.[1]).toEqual(
      expect.arrayContaining(["2025-2027", "2025-04-01", "2027-03-31"]),
    );
  });

  it("routes an employer breakdown through with its category intact", async () => {
    const query = queryMock();
    const db = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await replacePhoenixCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary,
      directBreakdowns: [
        {
          categoryType: "employer",
          categoryName: "City of Phoenix",
          amountCents: 250000,
          contributorCount: 3,
        },
      ],
      outsideGroups: [],
    });
    const breakdown = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.phx_candidate_finance_direct_breakdowns",
      ),
    );
    expect(breakdown?.[1]).toEqual(
      expect.arrayContaining(["employer", "City of Phoenix", "2500.00", 3]),
    );
  });

  it("passes negative cash on hand through as a signed balance", async () => {
    const query = queryMock();
    const db = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    await replacePhoenixCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary: { ...summary, cashOnHandCents: -4200 },
      directBreakdowns: [],
      outsideGroups: [],
    });
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.phx_candidate_finance_summaries",
      ),
    );
    expect(summaryCall?.[1]).toEqual(expect.arrayContaining(["-42.00"]));
  });

  it("rejects a negative flow and rolls the snapshot back", async () => {
    const query = queryMock();
    const release = vi.fn();
    const db = { connect: vi.fn().mockResolvedValue({ query, release }) };
    await expect(
      replacePhoenixCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalRaisedCents: -1 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/total raised must be nonnegative/);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("rejects non-integer cents", async () => {
    const db = {
      connect: vi
        .fn()
        .mockResolvedValue({ query: queryMock(), release: vi.fn() }),
    };
    await expect(
      replacePhoenixCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalSpentCents: 100.5 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/total spent must be integer cents/);
  });

  it("reuses a matching protected manual link and advances last_verified_at", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,cop_id")
        ? {
            rows: [
              { id: "manual-1", cop_id: "CAN-25-4", link_status: "active" },
            ],
          }
        : null,
    );
    const verifiedAt = new Date("2026-08-12T00:00:00Z");
    const result = await upsertPhoenixFinanceLink({
      db: { query } as never,
      link: {
        ...link,
        linkSource: "efiling_portal",
        lastVerifiedAt: verifiedAt,
      },
    });
    expect(result.linkId).toBe("manual-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    // Only the manual probe and the last_verified_at touch — never an INSERT
    // that would rewrite the operator's row.
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
    const touch = query.mock.calls.find((call) =>
      String(call[0]).includes("SET last_verified_at"),
    );
    expect(touch?.[1]).toEqual(["manual-1", verifiedAt.toISOString()]);
  });

  it("errors when an automatic link conflicts with a protected manual link", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,cop_id")
        ? {
            rows: [
              { id: "manual-1", cop_id: "CAN-25-11", link_status: "active" },
            ],
          }
        : null,
    );
    await expect(
      upsertPhoenixFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "efiling_portal" },
      }),
    ).rejects.toThrow(/conflicts with protected manual link/);
  });

  it("never resurrects an operator-disabled manual link with the same COP id", async () => {
    // The disabled manual row is the ON CONFLICT target — without the
    // any-status probe the upsert would silently flip it back to
    // active/efiling_portal.
    for (const linkStatus of ["inactive", "needs_review"]) {
      const query = queryMock((sql) =>
        sql.startsWith("SELECT id::text,cop_id")
          ? {
              rows: [
                { id: "manual-1", cop_id: "CAN-25-4", link_status: linkStatus },
              ],
            }
          : null,
      );
      await expect(
        upsertPhoenixFinanceLink({
          db: { query } as never,
          link: { ...link, linkSource: "efiling_portal" },
        }),
      ).rejects.toThrow(/matches an operator-disabled manual link/);
      const sql = query.mock.calls.map((call) => String(call[0]));
      expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
      expect(sql.some((s) => s.includes("SET last_verified_at"))).toBe(false);
    }
  });

  it("allows a new automatic identity past a disabled manual link with a different COP id", async () => {
    // The operator disabled that association, not the candidate.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,cop_id")
        ? {
            rows: [
              { id: "manual-1", cop_id: "CAN-23-7", link_status: "inactive" },
            ],
          }
        : null,
    );
    const result = await upsertPhoenixFinanceLink({
      db: { query } as never,
      link: { ...link, linkSource: "efiling_portal" },
    });
    expect(result.linkId).toBe("link-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((s) =>
        s.startsWith("INSERT INTO public.phx_candidate_finance_links"),
      ),
    ).toBe(true);
  });

  it("deactivates other automatic links before an active upsert", async () => {
    const query = queryMock();
    await upsertPhoenixFinanceLink({ db: { query } as never, link });
    const deactivate = query.mock.calls.find((call) =>
      String(call[0]).includes("SET link_status='inactive'"),
    );
    expect(String(deactivate?.[0])).toContain("link_source<>'manual'");
    expect(deactivate?.[1]).toEqual(["c", "e", "CAN-25-4"]);
  });

  it("normalizes the COP id (trim + uppercase) before the manual probe, not only before the INSERT", async () => {
    // A padded or lowercased id must still hit the disabled manual row in
    // the probe — otherwise it slips past, normalizes at the INSERT, and
    // reaches the manual row through ON CONFLICT.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,cop_id")
        ? {
            rows: [
              { id: "manual-1", cop_id: "CAN-25-4", link_status: "inactive" },
            ],
          }
        : null,
    );
    await expect(
      upsertPhoenixFinanceLink({
        db: { query } as never,
        link: { ...link, copId: " can-25-4 ", linkSource: "efiling_portal" },
      }),
    ).rejects.toThrow(/matches an operator-disabled manual link/);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("validates every link field before any statement runs", async () => {
    // Callers hand the upsert a plain Pool where each statement
    // autocommits — a validation throw after the deactivation UPDATE would
    // leave the candidate with no active link. Blank fields and malformed
    // cycle dates must all fail before the first query.
    const cases: [Record<string, string>, RegExp][] = [
      [{ committeeName: " " }, /committee name is required/],
      [{ candidateNameNormalized: "" }, /candidate name is required/],
      [{ portalCycleName: " " }, /portal cycle name is required/],
      [
        { portalCycleStart: "04/01/2025" },
        /portal cycle start must be an ISO date/,
      ],
      [{ portalCycleEnd: "2027-3-31" }, /portal cycle end must be an ISO date/],
    ];
    for (const [patch, message] of cases) {
      const query = queryMock();
      await expect(
        upsertPhoenixFinanceLink({
          db: { query } as never,
          link: { ...link, ...patch },
        }),
      ).rejects.toThrow(message);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("refuses to rewrite a manual row that appeared between the probe and the upsert", async () => {
    // The DO UPDATE's WHERE guard makes the write update nothing when the
    // conflict target turned manual after the probe — empty RETURNING must
    // throw, never silently resurrect.
    const query = queryMock((sql) =>
      sql.startsWith("INSERT INTO public.phx_candidate_finance_links")
        ? { rows: [] }
        : null,
    );
    await expect(
      upsertPhoenixFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "efiling_portal" },
      }),
    ).rejects.toThrow(/blocked by a concurrent protected manual link/);
    const insert = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.phx_candidate_finance_links",
      ),
    );
    expect(String(insert?.[0])).toContain(
      "WHERE phx_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual'",
    );
  });
});
