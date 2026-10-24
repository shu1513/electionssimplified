import { describe, expect, it, vi } from "vitest";
import {
  AUSTIN_FINANCE_TEXT_KEY_PATTERN,
  normalizeAustinFinanceTextKey,
} from "../../../src/pipeline/austinFinance/austinFinanceKeys.js";
import {
  replaceAustinCandidateFinanceSnapshot,
  upsertAustinFinanceLink,
} from "../../../src/pipeline/austinFinance/austinFinanceWriter.js";

// A query mock that answers the link INSERT with an id and everything else
// with empty rows — the writer's control flow (manual SELECT, deactivate
// UPDATE, detail deletes/inserts) all tolerate empty results.
function queryMock(overrides?: (sql: string) => { rows: unknown[] } | null) {
  return vi.fn().mockImplementation((sql: unknown) => {
    const s = String(sql);
    const override = overrides?.(s);
    if (override) return Promise.resolve(override);
    if (s.startsWith("INSERT INTO public.atx_candidate_finance_links"))
      return Promise.resolve({ rows: [{ id: "link-1" }] });
    return Promise.resolve({ rows: [] });
  });
}

function poolMock(query = queryMock()) {
  const release = vi.fn();
  return {
    db: { connect: vi.fn().mockResolvedValue({ query, release }) },
    query,
    release,
  };
}

const link = {
  candidateId: "c",
  electionId: "e",
  electionYear: 2024,
  candidateNameNormalized: "KIRK WATSON",
  officeName: "Mayor",
  filerName: "Watson, Kirk P.",
};

// Watson 2024 fixtures (docs/plans/plan-austin-finance.md Phase 0 gates): raised /
// spent are effective-report cover sums; the outside figures are the Austin
// Leadership PAC allocation.
const summary = {
  totalReceiptsCents: 104_772_990,
  directContributionTotalCents: 104_772_990,
  totalDisbursementsCents: 107_598_085,
  cashOnHandCents: -12_345,
  outsideSupportCents: 21_419_920,
  outsideOpposeCents: 0,
  sourceUrl: "https://data.austintexas.gov/d/b2pc-2s8n",
};

const outsideGroup = {
  spenderName: "Austin Leadership PAC",
  supportOppose: "support" as const,
  amountCents: 21_419_920,
};

describe("Austin finance text keys", () => {
  it("normalizes names deterministically and matches the schema CHECK", () => {
    const cases: Array<[string, string]> = [
      ["Watson, Kirk P.", "WATSON KIRK P"],
      ["  watson,kirk p  ", "WATSON KIRK P"],
      ["Velásquez, José", "VELASQUEZ JOSE"],
      ["Austin Fire Fighters PAC", "AUSTIN FIRE FIGHTERS PAC"],
      ["Realtors & Friends", "REALTORS AND FRIENDS"],
      ["---", ""],
    ];
    for (const [raw, expected] of cases) {
      const key = normalizeAustinFinanceTextKey(raw);
      expect(key).toBe(expected);
      if (expected) expect(key).toMatch(AUSTIN_FINANCE_TEXT_KEY_PATTERN);
    }
    expect(normalizeAustinFinanceTextKey(null)).toBe("");
    // Raw names never satisfy the key pattern the schema enforces.
    expect("Watson, Kirk P.").not.toMatch(AUSTIN_FINANCE_TEXT_KEY_PATTERN);
  });
});

describe("Austin finance writer", () => {
  it("writes a full snapshot in one transaction with exact dollar strings", async () => {
    const { db, query, release } = poolMock();
    await replaceAustinCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary,
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "RETIRED",
          amountCents: 13_479_731,
          contributorCount: 412,
        },
      ],
      outsideGroups: [outsideGroup],
      outsideGroupBreakdowns: [
        {
          spenderName: "Austin Leadership PAC",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "real-estate",
          amountCents: 5_000_000,
          contributorCount: 3,
        },
      ],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining("atx_candidate_finance_summaries"),
        expect.stringContaining(
          "DELETE FROM public.atx_candidate_finance_direct_breakdowns",
        ),
        expect.stringContaining(
          "DELETE FROM public.atx_candidate_finance_outside_groups",
        ),
        expect.stringContaining(
          "INSERT INTO public.atx_candidate_finance_outside_group_breakdowns",
        ),
      ]),
    );
    // Groups are deleted (cascading into breakdowns) before either is
    // re-inserted, and breakdowns land after their groups.
    const deleteGroups = sql.findIndex((s) =>
      s.startsWith("DELETE FROM public.atx_candidate_finance_outside_groups"),
    );
    const insertGroup = sql.findIndex((s) =>
      s.startsWith("INSERT INTO public.atx_candidate_finance_outside_groups"),
    );
    const insertBreakdown = sql.findIndex((s) =>
      s.startsWith(
        "INSERT INTO public.atx_candidate_finance_outside_group_breakdowns",
      ),
    );
    expect(deleteGroups).toBeGreaterThan(-1);
    expect(insertGroup).toBeGreaterThan(deleteGroups);
    expect(insertBreakdown).toBeGreaterThan(insertGroup);
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("atx_candidate_finance_summaries"),
    );
    // Cents → exact dollar strings, never floats, asserted POSITIONALLY in
    // the INSERT's column order (link_id, election_year, total_receipts,
    // direct_contribution_total, total_disbursements, cash_on_hand,
    // outside_support_total, outside_oppose_total, source_url,
    // last_synced_at) so a swapped column pair cannot pass.
    expect(summaryCall?.[1]).toEqual([
      "link-1",
      2024,
      "1047729.90",
      "1047729.90",
      "1075980.85",
      "-123.45",
      "214199.20",
      "0.00",
      "https://data.austintexas.gov/d/b2pc-2s8n",
      expect.any(String),
      true,
      true,
    ]);
    // The link write carries the derived key AND the exact source spelling.
    const linkCall = query.mock.calls.find((call) =>
      String(call[0]).startsWith("INSERT INTO public.atx_candidate_finance_links"),
    );
    expect(linkCall?.[1]).toEqual(
      expect.arrayContaining(["WATSON KIRK P", "Watson, Kirk P."]),
    );
    // The DB-enforced race backstop: an automatic write must never rewrite a
    // manual row the pre-probe did not see.
    expect(String(linkCall?.[0])).toContain(
      "WHERE atx_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual'",
    );
    // Outside rows carry the derived spender key plus the display name; the
    // breakdown carries the same key.
    const groupCall = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.atx_candidate_finance_outside_groups",
      ),
    );
    expect(groupCall?.[1]).toEqual(
      expect.arrayContaining([
        "AUSTIN LEADERSHIP PAC",
        "Austin Leadership PAC",
        "support",
        "214199.20",
      ]),
    );
    const breakdownCall = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.atx_candidate_finance_outside_group_breakdowns",
      ),
    );
    expect(breakdownCall?.[1]).toEqual(
      expect.arrayContaining([
        "AUSTIN LEADERSHIP PAC",
        "industry",
        "real-estate",
        "50000.00",
        3,
      ]),
    );
    expect(release).toHaveBeenCalled();
  });

  it("throws when the guarded upsert writes no row (concurrent manual link)", async () => {
    // A manual link created between the probe and the INSERT makes the
    // DO UPDATE's WHERE fail: RETURNING is empty and the write must abort
    // instead of silently converting the operator's row.
    const query = queryMock((sql) =>
      sql.startsWith("INSERT INTO public.atx_candidate_finance_links")
        ? { rows: [] }
        : null,
    );
    await expect(
      upsertAustinFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "austin_clerk" },
      }),
    ).rejects.toThrow(/blocked by a concurrent protected manual link/);
  });

  it("rejects a negative flow and rolls the snapshot back", async () => {
    const { db, query, release } = poolMock();
    await expect(
      replaceAustinCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalReceiptsCents: -1 },
        directBreakdowns: [],
        outsideGroups: [],
        outsideGroupBreakdowns: [],
      }),
    ).rejects.toThrow(/total receipts must be nonnegative/);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("rejects non-integer cents", async () => {
    const { db } = poolMock();
    await expect(
      replaceAustinCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary: { ...summary, totalDisbursementsCents: 100.5 },
        directBreakdowns: [],
        outsideGroups: [],
        outsideGroupBreakdowns: [],
      }),
    ).rejects.toThrow(/total disbursements must be integer cents/);
  });

  it("rejects a filer name with no identity after normalization", async () => {
    for (const filerName of ["", "   ", "---", "¿?"]) {
      await expect(
        upsertAustinFinanceLink({
          db: { query: queryMock() } as never,
          link: { ...link, filerName },
        }),
      ).rejects.toThrow(/filer name (is required|has no identity)/);
    }
  });

  it("rejects an outside group breakdown whose spender has no group in the snapshot", async () => {
    const { db, query } = poolMock();
    await expect(
      replaceAustinCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary,
        directBreakdowns: [],
        outsideGroups: [outsideGroup],
        outsideGroupBreakdowns: [
          {
            // Same spender, other direction — no such group.
            spenderName: "Austin Leadership PAC",
            supportOppose: "oppose",
            categoryType: "donor",
            categoryName: "Some Donor",
            amountCents: 100,
            contributorCount: 1,
          },
        ],
      }),
    ).rejects.toThrow(/breakdown has no matching outside group/);
    // Rejected before any statement ran — the prior snapshot is untouched.
    expect(query).not.toHaveBeenCalled();
  });

  it("pairs breakdowns to groups by normalized spender key, not raw spelling", async () => {
    const { db, query } = poolMock();
    await replaceAustinCandidateFinanceSnapshot({
      db: db as never,
      link,
      summary,
      directBreakdowns: [],
      outsideGroups: [outsideGroup],
      outsideGroupBreakdowns: [
        {
          spenderName: "AUSTIN LEADERSHIP  PAC",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "Some Donor",
          amountCents: 100,
          contributorCount: 1,
        },
      ],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.at(-1)).toBe("COMMIT");
  });

  it("rejects a malformed contributor count", async () => {
    const { db } = poolMock();
    await expect(
      replaceAustinCandidateFinanceSnapshot({
        db: db as never,
        link,
        summary,
        directBreakdowns: [
          {
            categoryType: "occupation",
            categoryName: "RETIRED",
            amountCents: 100,
            contributorCount: -1,
          },
        ],
        outsideGroups: [],
        outsideGroupBreakdowns: [],
      }),
    ).rejects.toThrow(/contributor count must be a nonnegative integer/);
  });

  it("reuses a matching protected manual link, refreshing filer_name and last_verified_at only", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,filer_key")
        ? {
            rows: [
              { id: "manual-1", filer_key: "WATSON KIRK P", link_status: "active" },
            ],
          }
        : null,
    );
    const verifiedAt = new Date("2026-08-18T00:00:00Z");
    const result = await upsertAustinFinanceLink({
      db: { query } as never,
      // Different raw spelling, same normalized identity.
      link: {
        ...link,
        filerName: "WATSON, KIRK P",
        linkSource: "austin_clerk",
        lastVerifiedAt: verifiedAt,
      },
    });
    expect(result.linkId).toBe("manual-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    // Only the manual probe and the filer_name/last_verified_at touch —
    // never an INSERT that would rewrite the operator's row. filer_name IS
    // refreshed: it is the sync's exact-match query key, and the automatic
    // spelling is the one known to exist in Socrata.
    expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
    const touch = query.mock.calls.find((call) =>
      String(call[0]).includes("SET filer_name"),
    );
    expect(String(touch?.[0])).toMatch(
      /^UPDATE public\.atx_candidate_finance_links SET filer_name=\$2,last_verified_at=/,
    );
    expect(String(touch?.[0])).not.toMatch(/link_status|link_source|office_name|district|source_url/);
    expect(touch?.[1]).toEqual([
      "manual-1",
      "WATSON, KIRK P",
      verifiedAt.toISOString(),
    ]);
  });

  it("errors when an automatic link conflicts with a protected manual link", async () => {
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,filer_key")
        ? {
            rows: [
              { id: "manual-1", filer_key: "OTHER FILER", link_status: "active" },
            ],
          }
        : null,
    );
    await expect(
      upsertAustinFinanceLink({
        db: { query } as never,
        link: { ...link, linkSource: "austin_clerk" },
      }),
    ).rejects.toThrow(/conflicts with protected manual link/);
  });

  it("never resurrects an operator-disabled manual link with the same filer key", async () => {
    // The disabled manual row is the ON CONFLICT target — without the
    // any-status probe the upsert would silently flip it back to
    // active/austin_clerk.
    for (const linkStatus of ["inactive", "needs_review"]) {
      const query = queryMock((sql) =>
        sql.startsWith("SELECT id::text,filer_key")
          ? {
              rows: [
                { id: "manual-1", filer_key: "WATSON KIRK P", link_status: linkStatus },
              ],
            }
          : null,
      );
      await expect(
        upsertAustinFinanceLink({
          db: { query } as never,
          link: { ...link, linkSource: "austin_clerk" },
        }),
      ).rejects.toThrow(/matches an operator-disabled manual link/);
      const sql = query.mock.calls.map((call) => String(call[0]));
      expect(sql.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
      expect(sql.some((s) => s.includes("SET filer_name"))).toBe(false);
    }
  });

  it("allows a new automatic identity past a disabled manual link with a different filer key", async () => {
    // The operator disabled that association, not the candidate.
    const query = queryMock((sql) =>
      sql.startsWith("SELECT id::text,filer_key")
        ? {
            rows: [
              { id: "manual-1", filer_key: "OTHER FILER", link_status: "inactive" },
            ],
          }
        : null,
    );
    const result = await upsertAustinFinanceLink({
      db: { query } as never,
      link: { ...link, linkSource: "austin_clerk" },
    });
    expect(result.linkId).toBe("link-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((s) =>
        s.startsWith("INSERT INTO public.atx_candidate_finance_links"),
      ),
    ).toBe(true);
  });

  it("skips the manual probe for manual writes and deactivates other automatic links before an active upsert", async () => {
    const query = queryMock();
    await upsertAustinFinanceLink({ db: { query } as never, link });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.startsWith("SELECT id::text,filer_key"))).toBe(
      false,
    );
    const deactivate = query.mock.calls.find((call) =>
      String(call[0]).includes("SET link_status='inactive'"),
    );
    expect(String(deactivate?.[0])).toContain("link_source<>'manual'");
    expect(deactivate?.[1]).toEqual(["c", "e", "WATSON KIRK P"]);
  });

  it("does not deactivate anything for a non-active upsert", async () => {
    const query = queryMock();
    await upsertAustinFinanceLink({
      db: { query } as never,
      link: { ...link, linkStatus: "needs_review" },
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.includes("SET link_status='inactive'"))).toBe(
      false,
    );
  });

  it("requires a Pool for snapshot writes", async () => {
    await expect(
      replaceAustinCandidateFinanceSnapshot({
        db: { query: queryMock() } as never,
        link,
        summary,
        directBreakdowns: [],
        outsideGroups: [],
        outsideGroupBreakdowns: [],
      }),
    ).rejects.toThrow(/require a Pool/);
  });
});

describe("Austin component preservation and committee cash transactions", () => {
  const cash = { donors: [{ committeeKey: "EXAMPLE PAC", committeeName: "Example PAC", amountCents: 100_000, contributionCount: 2 }],
    amountCents: 100_000, contributionCount: 2, reportedThrough: "2026-06-30" };
  it("writes source controls and every uncapped donor inside the snapshot transaction", async () => {
    const { db, query } = poolMock();
    await replaceAustinCandidateFinanceSnapshot({ db: db as never, link, summary, directBreakdowns: [], reportedCommitteeCash: cash });
    const calls = query.mock.calls.map(call => ({ sql: String(call[0]), params: call[1] }));
    expect(calls.find(call => call.sql.startsWith("INSERT INTO public.atx_candidate_finance_pac_sources"))?.params)
      .toEqual(["link-1", 2024, "100000", 2, 1, "2026-06-30", expect.any(String)]);
    expect(calls.find(call => call.sql.startsWith("INSERT INTO public.atx_candidate_finance_pac_donors"))?.params)
      .toEqual(["link-1", 2024, "EXAMPLE PAC", "Example PAC", "100000", 2]);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("rejects broken source totals before any mutation", async () => {
    const { db, query } = poolMock();
    await expect(replaceAustinCandidateFinanceSnapshot({ db: db as never, link, summary, directBreakdowns: [],
      reportedCommitteeCash: { ...cash, amountCents: 1 } })).rejects.toThrow("do not close");
    expect(query).not.toHaveBeenCalled();
  });
  it("rolls back the entire snapshot if donor persistence fails", async () => {
    const query = queryMock();
    const ordinary = query.getMockImplementation()!;
    query.mockImplementation((sql: unknown) => String(sql).startsWith("INSERT INTO public.atx_candidate_finance_pac_donors")
      ? Promise.reject(new Error("donor write failed")) : ordinary(sql));
    const { db, release } = poolMock(query);
    await expect(replaceAustinCandidateFinanceSnapshot({ db: db as never, link, summary, directBreakdowns: [], reportedCommitteeCash: cash }))
      .rejects.toThrow("donor write failed");
    expect(query.mock.calls.map(call => String(call[0])).at(-1)).toBe("ROLLBACK");
    expect(query.mock.calls.some(call => call[0] === "COMMIT")).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
  it("omits outside mutations and retains summary totals when outside evidence is unresolved", async () => {
    const { db, query } = poolMock();
    await replaceAustinCandidateFinanceSnapshot({ db: db as never, link,
      summary: { ...summary, outsideSupportCents: undefined, outsideOpposeCents: undefined }, directBreakdowns: [] });
    const calls = query.mock.calls.map(call => ({ sql: String(call[0]), params: call[1] as unknown[] }));
    expect(calls.some(call => /(?:DELETE FROM|INSERT INTO) public.atx_candidate_finance_outside/.test(call.sql))).toBe(false);
    const written = calls.find(call => call.sql.startsWith("INSERT INTO public.atx_candidate_finance_summaries"))!;
    expect(written.params.slice(6, 8)).toEqual([null, null]);
    expect(written.params.slice(10)).toEqual([false, false]);
    expect(written.sql).toContain("ELSE atx_candidate_finance_summaries.outside_support_total");
    expect(calls.some(call => call.sql.includes("atx_candidate_finance_pac_"))).toBe(false);
  });
});
