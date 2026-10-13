import { describe, expect, it, vi } from "vitest";
import {
  flagSanFranciscoFinanceLinksMissingFromManifest,
  replaceSanFranciscoCandidateFinanceSnapshot,
  replaceSanFranciscoOutsideCommitteeLinks,
  upsertSanFranciscoFinanceLink,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoFinanceWriter.js";

const LINK = {
  candidateId: "cand-1",
  electionId: "elec-1",
  electionYear: 2026,
  candidateNameNormalized: "ALAN WONG",
  contestCode: "bos04",
  fppcId: "1489126",
  filerNid: "216198377",
  committeeName: "ALAN WONG FOR SUPERVISOR 2026 GENERAL",
  linkSource: "sfec_dashboard" as const,
};

describe("upsertSanFranciscoFinanceLink", () => {
  it("reuses a protected manual link with the same committee", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: "manual-1", fppc_id: "1489126", link_status: "active" }],
      }),
    };
    const result = await upsertSanFranciscoFinanceLink({ db, link: LINK });
    expect(result.linkId).toBe("manual-1");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("advances a matching manual link's last_verified_at when one is given", async () => {
    const verifiedAt = new Date("2026-08-09T12:00:00.000Z");
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "manual-1", fppc_id: "1489126", link_status: "active" }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const result = await upsertSanFranciscoFinanceLink({
      db,
      link: { ...LINK, lastVerifiedAt: verifiedAt },
    });
    expect(result.linkId).toBe("manual-1");
    expect(db.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = db.query.mock.calls[1]!;
    expect(updateSql).toContain("SET last_verified_at=");
    expect(updateSql).not.toContain("link_source");
    expect(updateParams).toEqual(["manual-1", verifiedAt.toISOString()]);
  });

  it("matches a protected manual link on a whitespace-padded FPPC id", async () => {
    // The trimmed id must drive the manual comparison — a padded input that
    // matches the stored id is a reuse, never a probe miss that reaches the
    // stored row through ON CONFLICT.
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: "manual-1", fppc_id: "1489126", link_status: "active" }],
      }),
    };
    const result = await upsertSanFranciscoFinanceLink({
      db,
      link: { ...LINK, fppcId: " 1489126 " },
    });
    expect(result.linkId).toBe("manual-1");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("refuses to override a manual link with a different committee", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: "manual-1", fppc_id: "9999999", link_status: "active" }],
      }),
    };
    await expect(
      upsertSanFranciscoFinanceLink({ db, link: LINK }),
    ).rejects.toThrow(/protected manual link/);
  });

  it("deactivates other automatic links, then upserts", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // manual-link probe
        .mockResolvedValueOnce({ rows: [] }) // deactivation
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }] }),
    };
    const result = await upsertSanFranciscoFinanceLink({ db, link: LINK });
    expect(result.linkId).toBe("link-1");
    const [deactivateSql] = db.query.mock.calls[1]!;
    expect(deactivateSql).toContain("link_status='inactive'");
    expect(deactivateSql).toContain("link_source<>'manual'");
    const [insertSql, insertParams] = db.query.mock.calls[2]!;
    expect(insertSql).toContain(
      "ON CONFLICT (candidate_id,election_id,fppc_id)",
    );
    // The in-statement race backstop: a row concurrently flipped to manual
    // must block the update instead of being rewritten.
    expect(insertSql).toContain(
      "WHERE sfc_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual'",
    );
    expect(insertParams).toEqual([
      "cand-1",
      "elec-1",
      2026,
      "ALAN WONG",
      "bos04",
      "1489126",
      "216198377",
      "ALAN WONG FOR SUPERVISOR 2026 GENERAL",
      "active",
      "sfec_dashboard",
      null,
      null,
    ]);
  });

  it("writes a needs_review link without touching active links", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // manual-link probe
        .mockResolvedValueOnce({ rows: [{ id: "link-2" }] }),
    };
    const result = await upsertSanFranciscoFinanceLink({
      db,
      link: { ...LINK, linkStatus: "needs_review" },
    });
    expect(result.linkId).toBe("link-2");
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1]![0]).toContain("INSERT INTO");
  });

  it("protects a manual link from a needs_review automatic write too", async () => {
    // Without status-independent protection, this upsert would hit
    // ON CONFLICT on the manual row and rewrite it to sfec_dashboard.
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ id: "manual-1", fppc_id: "1489126", link_status: "active" }],
      }),
    };
    const result = await upsertSanFranciscoFinanceLink({
      db,
      link: { ...LINK, linkStatus: "needs_review" },
    });
    expect(result.linkId).toBe("manual-1");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("never resurrects an operator-disabled manual link", async () => {
    // The disabled manual row is the ON CONFLICT target — without the
    // any-status probe the upsert would silently flip it back to
    // active/sfec_dashboard.
    for (const linkStatus of ["inactive", "needs_review"]) {
      const db = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            { id: "manual-1", fppc_id: "1489126", link_status: linkStatus },
          ],
        }),
      };
      await expect(
        upsertSanFranciscoFinanceLink({
          db,
          link: { ...LINK, lastVerifiedAt: new Date("2026-08-12T00:00:00Z") },
        }),
      ).rejects.toThrow(/matches an operator-disabled manual link/);
      // Only the probe ran — never the last_verified_at touch or the INSERT.
      expect(db.query).toHaveBeenCalledTimes(1);
    }
  });

  it("allows a new automatic identity past a disabled manual link with a different committee", async () => {
    // The operator disabled that association, not the candidate.
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { id: "manual-1", fppc_id: "9999999", link_status: "inactive" },
          ],
        }) // manual-link probe
        .mockResolvedValueOnce({ rows: [] }) // deactivation
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }] }),
    };
    const result = await upsertSanFranciscoFinanceLink({ db, link: LINK });
    expect(result.linkId).toBe("link-1");
    expect(db.query.mock.calls[2]![0]).toContain(
      "INSERT INTO public.sfc_candidate_finance_links",
    );
  });

  it("refuses to rewrite a manual row that appeared between the probe and the upsert", async () => {
    // The DO UPDATE's WHERE guard makes the write update nothing when the
    // conflict target turned manual after the probe — empty RETURNING must
    // throw, never silently resurrect.
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // manual-link probe
        .mockResolvedValueOnce({ rows: [] }) // deactivation
        .mockResolvedValueOnce({ rows: [] }), // guarded INSERT wrote no row
    };
    await expect(
      upsertSanFranciscoFinanceLink({ db, link: LINK }),
    ).rejects.toThrow(/blocked by a concurrent protected manual link/);
  });
});

describe("flagSanFranciscoFinanceLinksMissingFromManifest", () => {
  it("flags active automatic links whose committee left the manifest", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: "stale-1" }] }),
    };
    const flagged = await flagSanFranciscoFinanceLinksMissingFromManifest({
      db,
      electionId: "elec-1",
      presentFppcIds: ["1489126", "1491969"],
    });
    expect(flagged).toEqual(["stale-1"]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("link_status='needs_review'");
    expect(sql).toContain("link_source='sfec_dashboard'");
    expect(params).toEqual(["elec-1", ["1489126", "1491969"]]);
  });
});

describe("replaceSanFranciscoOutsideCommitteeLinks", () => {
  it("deletes then inserts the manifest's relation set", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await replaceSanFranciscoOutsideCommitteeLinks({
      db,
      candidateId: "cand-1",
      electionId: "elec-1",
      electionYear: 2026,
      relations: [
        {
          spenderFppcId: "1488188",
          spenderName: "GROWSF SUPPORTING ALAN WONG FOR SUPERVISOR 2026",
          supportOppose: "support",
          sourceUrl: "https://example.test/bos04",
        },
        {
          spenderFppcId: "name:AFFORDABLE SF NOW",
          spenderName: "AFFORDABLE SF NOW",
          supportOppose: "oppose",
        },
      ],
      lastVerifiedAt: new Date("2026-08-07T00:00:00Z"),
    });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[0]![0]).toContain("DELETE FROM");
    const [insertSql, insertParams] = db.query.mock.calls[1]!;
    expect(insertSql).toContain("ON CONFLICT");
    expect(insertParams).toEqual([
      "cand-1",
      "elec-1",
      2026,
      "1488188",
      "GROWSF SUPPORTING ALAN WONG FOR SUPERVISOR 2026",
      "support",
      "https://example.test/bos04",
      "2026-08-07T00:00:00.000Z",
    ]);
  });

  it("clears every relation when the manifest has none", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await replaceSanFranciscoOutsideCommitteeLinks({
      db,
      candidateId: "cand-1",
      electionId: "elec-1",
      electionYear: 2026,
      relations: [],
      lastVerifiedAt: new Date(),
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]![0]).toContain("DELETE FROM");
  });
});

const SUMMARY = {
  totalRaisedCents: 123_456,
  directContributionCents: 90_000,
  totalSpentCents: 100_000,
  cashOnHandCents: 5,
  debtsOwedCents: null,
  loansReceivedCents: 0,
  publicFundsReceivedCents: 25_500_00,
  outsideSupportCents: 0,
  outsideOpposeCents: 0,
  methodologyVersion: "sf-2026.1",
  sourceUrl: "https://example.test/bos04",
  reportedThrough: "2026-06-30",
};

function snapshotDb(previous: unknown[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("INSERT INTO public.sfc_candidate_finance_links"))
      return { rows: [{ id: "link-1" }] };
    if (sql.startsWith("SELECT s.last_synced_at")) return { rows: previous };
    return { rows: [] };
  });
  const release = vi.fn();
  return {
    query,
    release,
    db: { connect: vi.fn().mockResolvedValue({ query, release }) },
  };
}

describe("replaceSanFranciscoCandidateFinanceSnapshot", () => {
  it.each([
    { last_synced_at: "2026-10-13T00:00:00Z", reported_through: "2026-06-30" },
    { last_synced_at: "2026-10-11T00:00:00Z", reported_through: "2026-09-19" },
  ])(
    "preserves a newer snapshot observed during acquisition: %j",
    async (previous) => {
      const { query, db } = snapshotDb([previous]);
      await expect(
        replaceSanFranciscoCandidateFinanceSnapshot({
          db: db as never,
          link: LINK,
          summary: SUMMARY,
          directBreakdowns: [],
          outsideGroups: [],
          syncedAt: new Date("2026-10-12T00:00:00Z"),
        }),
      ).rejects.toThrow(/newer stored coverage/);
      expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
      expect(
        query.mock.calls.some(
          ([sql]) =>
            String(sql).startsWith("INSERT") ||
            String(sql).startsWith("DELETE"),
        ),
      ).toBe(false);
    },
  );

  const cashPosition = {
    committeeId: "reported:com:example committee",
    committeeName: "Example Committee",
    sourceReportedClass: "COM" as const,
    amountCents: -12500,
    contributionCount: 0,
    giftOccurrenceIds: [],
    returnOccurrenceIds: ["return-1"],
    reportedCommitteeIds: ["1234567"],
  };

  it("preserves signed return-only positions and source evidence in the snapshot transaction", async () => {
    const { query, db } = snapshotDb();
    await replaceSanFranciscoCandidateFinanceSnapshot({
      db: db as never,
      link: LINK,
      summary: SUMMARY,
      directBreakdowns: [],
      outsideGroups: [],
      committeeCash: {
        positions: [cashPosition],
        reportedThrough: "2026-09-19",
        sourceUrl: "https://data.sfgov.org/d/pitq-e56w",
      },
      syncedAt: new Date("2026-10-12T00:00:00Z"),
    });
    const inserts = query.mock.calls.filter(([sql]) =>
      String(sql).startsWith(
        "INSERT INTO public.sfc_candidate_finance_pac_donors",
      ),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toEqual([
      "link-1",
      2026,
      cashPosition.committeeId,
      cashPosition.committeeName,
      "COM",
      '["1234567"]',
      "-125.00",
      0,
      "https://data.sfgov.org/d/pitq-e56w",
      "2026-09-19",
      "2026-10-12T00:00:00.000Z",
    ]);
    expect(query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });

  it("leaves prior committee rows untouched when acquisition was omitted", async () => {
    const { query, db } = snapshotDb();
    await replaceSanFranciscoCandidateFinanceSnapshot({
      db: db as never,
      link: LINK,
      summary: SUMMARY,
      directBreakdowns: [],
      outsideGroups: [],
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("sfc_candidate_finance_pac_donors"),
      ),
    ).toBe(false);
  });

  it("clears prior committee positions only for an explicitly qualified empty component", async () => {
    const { query, db } = snapshotDb();
    await replaceSanFranciscoCandidateFinanceSnapshot({
      db: db as never,
      link: LINK,
      summary: SUMMARY,
      directBreakdowns: [],
      outsideGroups: [],
      committeeCash: {
        positions: [],
        reportedThrough: "2026-09-19",
        sourceUrl: "https://data.sfgov.org/d/pitq-e56w",
      },
    });
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes(
          "DELETE FROM public.sfc_candidate_finance_pac_donors",
        ),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).startsWith(
          "INSERT INTO public.sfc_candidate_finance_pac_donors",
        ),
      ),
    ).toBe(false);
  });

  it("rolls back every financial component when committee evidence is invalid", async () => {
    const { query, db } = snapshotDb();
    await expect(
      replaceSanFranciscoCandidateFinanceSnapshot({
        db: db as never,
        link: LINK,
        summary: SUMMARY,
        directBreakdowns: [],
        outsideGroups: [],
        committeeCash: {
          positions: [{ ...cashPosition, contributionCount: -1 }],
          reportedThrough: "2026-09-19",
          sourceUrl: "https://data.sfgov.org/d/pitq-e56w",
        },
      }),
    ).rejects.toThrow(/committee cash evidence/);
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it("writes link, summary, breakdowns, and outside groups in one transaction", async () => {
    const { query, release, db } = snapshotDb();
    const result = await replaceSanFranciscoCandidateFinanceSnapshot({
      db: db as never,
      link: LINK,
      summary: SUMMARY,
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amountCents: 50_000,
          contributorCount: 3,
        },
      ],
      outsideGroups: [
        {
          spenderFppcId: "1488188",
          spenderName: "GROWSF",
          supportOppose: "support",
          amountCents: 7_500,
          sourceUrl: "https://example.test/bos04",
        },
      ],
      syncedAt: new Date("2026-08-09T00:00:00Z"),
    });
    expect(result.linkId).toBe("link-1");
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalled();
    const summaryCall = query.mock.calls.find((call) =>
      String(call[0]).startsWith(
        "INSERT INTO public.sfc_candidate_finance_summaries",
      ),
    )!;
    // Cents converted to exact dollar strings; nulls preserved.
    expect(summaryCall[1]).toEqual([
      "link-1",
      2026,
      "1234.56",
      "900.00",
      "1000.00",
      "0.05",
      null,
      "0.00",
      "25500.00",
      "0.00",
      "0.00",
      "sf-2026.1",
      "https://example.test/bos04",
      "2026-06-30",
      "2026-08-09T00:00:00.000Z",
    ]);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "DELETE FROM public.sfc_candidate_finance_direct_breakdowns",
        ),
        expect.stringContaining(
          "DELETE FROM public.sfc_candidate_finance_outside_groups",
        ),
      ]),
    );
    const breakdownInsert = query.mock.calls.find((call) =>
      String(call[0]).includes(
        "INSERT INTO public.sfc_candidate_finance_direct_breakdowns",
      ),
    )!;
    expect(breakdownInsert[1]).toEqual([
      "link-1",
      2026,
      "occupation",
      "Attorney",
      "500.00",
      3,
      null,
      "2026-08-09T00:00:00.000Z",
    ]);
    const groupInsert = query.mock.calls.find((call) =>
      String(call[0]).includes(
        "INSERT INTO public.sfc_candidate_finance_outside_groups",
      ),
    )!;
    expect(groupInsert[1]).toEqual([
      "link-1",
      2026,
      "1488188",
      "GROWSF",
      "support",
      "75.00",
      "https://example.test/bos04",
      "2026-08-09T00:00:00.000Z",
    ]);
  });

  it("clears stale detail rows when the snapshot has none", async () => {
    const { query, db } = snapshotDb();
    await replaceSanFranciscoCandidateFinanceSnapshot({
      db: db as never,
      link: LINK,
      summary: SUMMARY,
      directBreakdowns: [],
      outsideGroups: [],
    });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.filter((statement) => statement.startsWith("DELETE FROM")),
    ).toHaveLength(2);
    expect(
      sql.some((statement) =>
        statement.startsWith(
          "INSERT INTO public.sfc_candidate_finance_direct_breakdowns",
        ),
      ),
    ).toBe(false);
    expect(sql.at(-1)).toBe("COMMIT");
  });

  it("rolls the whole snapshot back on a negative amount", async () => {
    const { query, release, db } = snapshotDb();
    await expect(
      replaceSanFranciscoCandidateFinanceSnapshot({
        db: db as never,
        link: LINK,
        summary: { ...SUMMARY, cashOnHandCents: -1 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/cash on hand must be nonnegative/);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("rejects non-integer cents", async () => {
    const { db } = snapshotDb();
    await expect(
      replaceSanFranciscoCandidateFinanceSnapshot({
        db: db as never,
        link: LINK,
        summary: { ...SUMMARY, totalRaisedCents: 100.5 },
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/total raised must be integer cents/);
  });

  it("requires a Pool, not a bare client", async () => {
    await expect(
      replaceSanFranciscoCandidateFinanceSnapshot({
        db: { query: vi.fn() } as never,
        link: LINK,
        summary: SUMMARY,
        directBreakdowns: [],
        outsideGroups: [],
      }),
    ).rejects.toThrow(/require a Pool/);
  });
});
