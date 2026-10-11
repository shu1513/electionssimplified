import { describe, expect, it, vi } from "vitest";

import { createStandardStateFinanceSnapshotWriter } from "../../../src/pipeline/finance/standardStateFinanceSnapshotWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");

const TABLES = {
  links: "zz_candidate_finance_links",
  summaries: "zz_candidate_finance_summaries",
  directBreakdowns: "zz_candidate_finance_direct_breakdowns",
  outsideGroups: "zz_candidate_finance_outside_groups",
  outsideGroupBreakdowns: "zz_candidate_finance_outside_group_breakdowns",
} as const;

function makeWriter(overrides?: Partial<Parameters<typeof createStandardStateFinanceSnapshotWriter>[0]>) {
  return createStandardStateFinanceSnapshotWriter({
    label: "Zetaland",
    minElectionYear: 2000,
    tables: TABLES,
    ...overrides,
  });
}

function linkInput() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "PAT DOE",
    officeName: "Governor",
    district: null,
    committeeId: "C-1",
    committeeName: "Doe for Zetaland",
    linkStatus: "active" as const,
    linkSource: "manual" as const,
    sourceUrl: "https://example.test/committee/C-1",
    lastVerifiedAt: NOW,
  };
}

function poolWithClient() {
  const client = {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
  return { db, client };
}

describe("createStandardStateFinanceSnapshotWriter config options", () => {
  it.each([false, true])("runs state snapshot rows inside the existing transaction with summary=%s", async (withSummary) => {
    const { db, client } = poolWithClient();
    const hook = vi.fn(async ({ db: tx }: Pick<Parameters<ReturnType<typeof makeWriter>["replaceSnapshot"]>[0], "db">) => {
      expect(client.query.mock.calls.map((call) => String(call[0]))).not.toContain("COMMIT");
      await tx.query("STATE SNAPSHOT ROWS");
    });
    const result = await makeWriter().replaceSnapshot({
      db, link: linkInput(), syncedAt: NOW,
      ...(withSummary ? { summary: { totalReceipts: 100 } } : {}),
      afterSnapshotWrite: hook,
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ db: client, linkId: "link-1", electionYear: 2026, syncedAt: NOW });
    expect(result.summaryWritten).toBe(withSummary);
    expect(client.query.mock.calls.at(-2)![0]).toBe("STATE SNAPSHOT ROWS");
    expect(client.query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("rolls back the entire transaction when a state snapshot hook fails with summary=%s", async (withSummary) => {
    const { db, client } = poolWithClient();
    await expect(makeWriter().replaceSnapshot({
      db, link: linkInput(), syncedAt: NOW,
      ...(withSummary ? { summary: { totalReceipts: 100 } } : {}),
      afterSnapshotWrite: async () => { throw new Error("State snapshot unavailable"); },
    })).rejects.toThrow("State snapshot unavailable");
    expect(client.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.map((call) => String(call[0]))).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("enforces the configured election-year floor", async () => {
    const writer = makeWriter({ minElectionYear: 2008 });
    const db = { query: vi.fn() };

    await expect(
      writer.upsertLink({ db, link: { ...linkInput(), electionYear: 2007 } })
    ).rejects.toThrow("Invalid Zetaland finance election year: 2007");
    expect(db.query).not.toHaveBeenCalled();

    db.query.mockResolvedValue({ rows: [{ id: "link-1" }], rowCount: 1 });
    await expect(writer.upsertLink({ db, link: { ...linkInput(), electionYear: 2008 } })).resolves.toEqual({
      linkId: "link-1",
    });
  });

  it("rejects a nonsensical configured floor", () => {
    expect(() => makeWriter({ minElectionYear: 199 })).toThrow(
      "Invalid Zetaland finance minimum election year: 199"
    );
  });

  it("accepts negative cash on hand only when the state opts in, and persists it unchanged", async () => {
    // Signed cash is per-state opt-in: each state's summaries table carries
    // its own amounts CHECK, and a state still pinning cash_on_hand >= 0
    // must keep the writer's clear error instead of a constraint rollback.
    const { db, client } = poolWithClient();
    await expect(
      makeWriter({ allowNegativeCashOnHand: true }).replaceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        summary: { totalReceipts: 100, cashOnHand: -2500.75 },
      })
    ).resolves.toBeDefined();
    // The signed value reaches the summary INSERT unchanged — a regression
    // that nulls or clamps it would otherwise still pass.
    const summaryCall = client.query.mock.calls.find((call) => String(call[0]).includes("cash_on_hand"));
    expect(summaryCall?.[1]).toContain(-2500.75);

    const { db: db2 } = poolWithClient();
    await expect(
      makeWriter().replaceSnapshot({
        db: db2,
        link: linkInput(),
        syncedAt: NOW,
        summary: { totalReceipts: 100, cashOnHand: -1 },
      })
    ).rejects.toThrow("cash on hand must be a nonnegative number");

    const { db: db3 } = poolWithClient();
    await expect(
      makeWriter({ allowNegativeCashOnHand: true }).replaceSnapshot({
        db: db3,
        link: linkInput(),
        syncedAt: NOW,
        summary: { totalReceipts: -100 },
      })
    ).rejects.toThrow("total receipts must be a nonnegative number");
  });

  it("COALESCEs every summary column by default", async () => {
    const { db, client } = poolWithClient();

    await makeWriter().replaceSnapshot({
      db,
      link: linkInput(),
      syncedAt: NOW,
      summary: { totalReceipts: 100 },
    });

    const summarySql = String(client.query.mock.calls[2]?.[0]);
    expect(summarySql).toContain("total_receipts = COALESCE(EXCLUDED.total_receipts, zz_candidate_finance_summaries.total_receipts)");
    expect(summarySql).toContain("cash_on_hand = COALESCE(EXCLUDED.cash_on_hand, zz_candidate_finance_summaries.cash_on_hand)");
    expect(summarySql).toContain("last_synced_at = EXCLUDED.last_synced_at");
  });

  it("replaces the columns configured as replace, leaving the rest preserved", async () => {
    const { db, client } = poolWithClient();

    await makeWriter({
      summaryUpdatePolicy: {
        total_receipts: "replace",
        direct_contribution_total: "replace",
        total_disbursements: "replace",
        cash_on_hand: "replace",
        source_url: "replace",
      },
    }).replaceSnapshot({
      db,
      link: linkInput(),
      syncedAt: NOW,
      summary: { totalReceipts: 100 },
    });

    const summarySql = String(client.query.mock.calls[2]?.[0]);
    expect(summarySql).toContain("total_receipts = EXCLUDED.total_receipts,");
    expect(summarySql).toContain("cash_on_hand = EXCLUDED.cash_on_hand,");
    expect(summarySql).toContain("source_url = EXCLUDED.source_url,");
    expect(summarySql).toContain("outside_support_total = COALESCE(EXCLUDED.outside_support_total, zz_candidate_finance_summaries.outside_support_total)");
    expect(summarySql).toContain("outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, zz_candidate_finance_summaries.outside_oppose_total)");
  });

  it("allows breakdowns without groups when validation is none (default)", async () => {
    const { db } = poolWithClient();

    await expect(
      makeWriter().replaceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroupBreakdowns: [
          {
            committeeId: "PAC-1",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Some Donor",
            amount: 500,
          },
        ],
      })
    ).resolves.toMatchObject({ outsideGroupBreakdownsWritten: 1 });
  });

  it("presence validation rejects breakdowns without groups before touching the db", async () => {
    const db = { connect: vi.fn(), query: vi.fn() };

    await expect(
      makeWriter({ outsideGroupValidation: "presence" }).replaceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroupBreakdowns: [
          {
            committeeId: "PAC-1",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Some Donor",
            amount: 500,
          },
        ],
      })
    ).rejects.toThrow("Zetaland outside group breakdowns require outside groups in the same snapshot");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("pairing validation rejects a breakdown whose group is not in the snapshot", async () => {
    const db = { connect: vi.fn(), query: vi.fn() };
    const writer = makeWriter({ outsideGroupValidation: "pairing" });

    await expect(
      writer.replaceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroups: [
          {
            committeeId: "PAC-1",
            committeeName: "Some PAC",
            supportOppose: "support",
            amount: 500,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "PAC-1",
            supportOppose: "oppose",
            categoryType: "donor",
            categoryName: "Some Donor",
            amount: 500,
          },
        ],
      })
    ).rejects.toThrow("Zetaland outside group breakdowns must reference outside groups in the same snapshot");
    expect(db.connect).not.toHaveBeenCalled();

    const { db: okDb } = poolWithClient();
    await expect(
      writer.replaceSnapshot({
        db: okDb,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroups: [
          {
            committeeId: "PAC-1",
            committeeName: "Some PAC",
            supportOppose: "support",
            amount: 500,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "PAC-1",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Some Donor",
            amount: 500,
          },
        ],
      })
    ).resolves.toMatchObject({ outsideGroupsWritten: 1, outsideGroupBreakdownsWritten: 1 });
  });

  it("applies normalizeCommitteeId to the link, outside rows, and stale-delete keep lists", async () => {
    const { db, client } = poolWithClient();
    const writer = makeWriter({
      normalizeCommitteeId: (value) => value.replace(/\s+/g, " ").toUpperCase(),
    });

    await writer.replaceSnapshot({
      db,
      link: { ...linkInput(), committeeId: " c  1 " },
      syncedAt: NOW,
      outsideGroups: [
        {
          committeeId: " pac  1 ",
          committeeName: "Some PAC",
          supportOppose: "support",
          amount: 500,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeId: "pac 1",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "Some Donor",
          amount: 500,
        },
      ],
    });

    const calls = client.query.mock.calls;
    const linkCall = calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.links}`));
    const groupCall = calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.outsideGroups}`));
    const breakdownCall = calls.find((call) =>
      String(call[0]).includes(`INSERT INTO public.${TABLES.outsideGroupBreakdowns}`)
    );
    const deleteGroupsCall = calls.find((call) =>
      String(call[0]).includes(`DELETE FROM public.${TABLES.outsideGroups}`)
    );
    const deleteBreakdownsCall = calls.find((call) =>
      String(call[0]).includes(`DELETE FROM public.${TABLES.outsideGroupBreakdowns}`)
    );

    expect(linkCall?.[1]?.[6]).toBe("C 1");
    expect(groupCall?.[1]?.[2]).toBe("PAC 1");
    expect(breakdownCall?.[1]?.[2]).toBe("PAC 1");
    expect(JSON.parse(String(deleteGroupsCall?.[1]?.[2]))).toEqual([
      { committee_id: "PAC 1", support_oppose: "support" },
    ]);
    expect(JSON.parse(String(deleteBreakdownsCall?.[1]?.[2]))).toEqual([
      { committee_id: "PAC 1", support_oppose: "support", category_type: "donor", category_name: "Some Donor" },
    ]);
  });

  it("pairing validation compares normalized committee ids", async () => {
    const { db } = poolWithClient();

    await expect(
      makeWriter({
        outsideGroupValidation: "pairing",
        normalizeCommitteeId: (value) => value.toUpperCase(),
      }).replaceSnapshot({
        db,
        link: linkInput(),
        syncedAt: NOW,
        outsideGroups: [
          {
            committeeId: "pac-1",
            committeeName: "Some PAC",
            supportOppose: "support",
            amount: 500,
          },
        ],
        outsideGroupBreakdowns: [
          {
            committeeId: "PAC-1",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Some Donor",
            amount: 500,
          },
        ],
      })
    ).resolves.toMatchObject({ outsideGroupsWritten: 1, outsideGroupBreakdownsWritten: 1 });
  });

  it("keeps an existing manual link's status and source instead of overwriting them from a sync", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: "link-1" }], rowCount: 1 }) };

    await makeWriter().upsertLink({ db, link: { ...linkInput(), linkSource: "state_bulk" } });

    const linkSql = String(db.query.mock.calls[0]?.[0]);
    expect(linkSql).toContain(
      `WHEN ${TABLES.links}.link_source = 'manual' AND EXCLUDED.link_source <> 'manual' THEN ${TABLES.links}.link_source`
    );
    expect(linkSql).toContain("ELSE EXCLUDED.link_source");
    expect(linkSql).not.toContain("link_source = EXCLUDED.link_source");
    // Status is guarded too: auto-link selects on "no active link exists", so
    // an unguarded status would let automation reactivate an operator-disabled
    // manual row.
    expect(linkSql).toContain(
      `WHEN ${TABLES.links}.link_source = 'manual' AND EXCLUDED.link_source <> 'manual' THEN ${TABLES.links}.link_status`
    );
    expect(linkSql).toContain("ELSE EXCLUDED.link_status");
    expect(linkSql).not.toContain("link_status = EXCLUDED.link_status");
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(linkSql).not.toContain("WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'");
  });

  it("reuses an exact active manual link when candidate-wide protection is enabled", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "manual-link", committee_id: "c-1", link_status: "active", election_year: 2026 }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };

    await expect(
      makeWriter({
        manualLinkProtection: true,
        normalizeCommitteeId: (value) => value.trim().toUpperCase(),
      }).upsertLink({
        db,
        link: { ...linkInput(), committeeId: " C-1 ", linkSource: "state_bulk" },
      })
    ).resolves.toEqual({ linkId: "manual-link" });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_source='manual'");
    expect(String(db.query.mock.calls[1]?.[0])).toBe(
      `UPDATE public.${TABLES.links} SET last_verified_at=$2::timestamptz WHERE id=$1::uuid`
    );
    expect(db.query.mock.calls[1]?.[1]).toEqual(["manual-link", NOW.toISOString()]);
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO"))).toBe(false);
  });

  it("fails closed when an exact active manual link has a different election year", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "manual-link", committee_id: "C-1", link_status: "active", election_year: 2024 }],
        rowCount: 1,
      }),
    };

    await expect(
      makeWriter({ manualLinkProtection: true }).upsertLink({
        db,
        link: { ...linkInput(), linkSource: "state_bulk" },
      })
    ).rejects.toThrow(
      "Zetaland automatic finance link year 2026 does not match the protected manual link year 2024"
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an automatic link matches an operator-disabled manual link", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "manual-link", committee_id: "C-1", link_status: "inactive" }],
        rowCount: 1,
      }),
    };

    await expect(
      makeWriter({ manualLinkProtection: true }).upsertLink({
        db,
        link: { ...linkInput(), linkSource: "state_bulk" },
      })
    ).rejects.toThrow("Zetaland automatic finance link matches an operator-disabled manual link");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("blocks a different automatic identity when an active manual link exists", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "manual-link", committee_id: "C-2", link_status: "active" }],
        rowCount: 1,
      }),
    };

    await expect(
      makeWriter({ manualLinkProtection: true }).upsertLink({
        db,
        link: { ...linkInput(), linkSource: "state_bulk" },
      })
    ).rejects.toThrow("Zetaland automatic finance link conflicts with protected manual link");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("allows a different identity past inactive manual rows and adds the conflict-race backstop", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "manual-link", committee_id: "C-2", link_status: "inactive" }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: "auto-link" }], rowCount: 1 }),
    };

    await expect(
      makeWriter({ manualLinkProtection: true }).upsertLink({
        db,
        link: { ...linkInput(), linkSource: "state_bulk" },
      })
    ).resolves.toEqual({ linkId: "auto-link" });

    const insertSql = String(db.query.mock.calls[1]?.[0]);
    expect(insertSql).toContain(
      `WHERE ${TABLES.links}.link_source <> 'manual' OR EXCLUDED.link_source = 'manual'`
    );
  });

  it("reports a concurrent manual conflict when the protected upsert returns no row", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };

    await expect(
      makeWriter({ manualLinkProtection: true }).upsertLink({
        db,
        link: { ...linkInput(), linkSource: "state_bulk" },
      })
    ).rejects.toThrow(
      "Zetaland finance link upsert wrote no row — blocked by a concurrent protected manual link"
    );
  });

  it("deactivates superseded same-source links inside the snapshot transaction", async () => {
    const { db, client } = poolWithClient();
    const writer = makeWriter({ supersededLinkSource: "bulk_import" });

    await writer.replaceSnapshot({
      db,
      link: { ...linkInput(), linkSource: "bulk_import" },
      syncedAt: NOW,
      summary: { totalReceipts: 100 },
    });

    const deactivateCall = client.query.mock.calls[2];
    expect(String(deactivateCall?.[0])).toContain(`UPDATE public.${TABLES.links}`);
    expect(String(deactivateCall?.[0])).toContain("SET link_status = 'inactive'");
    expect(String(deactivateCall?.[0])).toContain("link_source = 'bulk_import'");
    expect(deactivateCall?.[1]).toEqual([CANDIDATE_ID, ELECTION_ID, "link-1"]);
  });

  it("does not deactivate links for other sources, inactive links, or plain upsertLink", async () => {
    const client = {
      query: vi.fn((sql: unknown) =>
        Promise.resolve(
          String(sql).includes(`INSERT INTO public.${TABLES.links}`)
            ? { rows: [{ id: "link-1" }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
        )
      ),
      release: vi.fn(),
    };
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    const writer = makeWriter({ supersededLinkSource: "bulk_import" });

    await writer.replaceSnapshot({
      db,
      link: { ...linkInput(), linkSource: "manual" },
      syncedAt: NOW,
    });
    await writer.replaceSnapshot({
      db,
      link: { ...linkInput(), linkSource: "bulk_import", linkStatus: "inactive" },
      syncedAt: NOW,
    });

    const upsertDb = { query: vi.fn().mockResolvedValue({ rows: [{ id: "link-1" }], rowCount: 1 }) };
    await writer.upsertLink({ db: upsertDb, link: { ...linkInput(), linkSource: "bulk_import" } });

    const updates = client.query.mock.calls.filter((call) =>
      String(call[0]).includes(`UPDATE public.${TABLES.links}`)
    );
    expect(updates).toHaveLength(0);
    expect(upsertDb.query).toHaveBeenCalledTimes(1);
    expect(String(upsertDb.query.mock.calls[0]?.[0])).toContain(`INSERT INTO public.${TABLES.links}`);
  });

  it("rejects a superseded link source that is not identifier-safe", () => {
    expect(() => makeWriter({ supersededLinkSource: "bad'source" })).toThrow(
      "Invalid Zetaland superseded link source: bad'source"
    );
  });

  it("renders configured outside-group identity columns in every outside statement", async () => {
    const { db, client } = poolWithClient();
    const writer = makeWriter({
      outsideGroupIdentityColumns: { id: "sponsor_id", name: "sponsor_name" },
    });

    await writer.replaceSnapshot({
      db,
      link: linkInput(),
      syncedAt: NOW,
      outsideGroups: [
        {
          committeeId: "PAC-1",
          committeeName: "Some PAC",
          supportOppose: "support",
          amount: 500,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeId: "PAC-1",
          supportOppose: "support",
          categoryType: "donor",
          categoryName: "Some Donor",
          amount: 500,
        },
      ],
    });

    const calls = client.query.mock.calls;
    const groupCall = calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.outsideGroups}`));
    const breakdownCall = calls.find((call) =>
      String(call[0]).includes(`INSERT INTO public.${TABLES.outsideGroupBreakdowns}`)
    );
    const deleteGroupsCall = calls.find((call) =>
      String(call[0]).includes(`DELETE FROM public.${TABLES.outsideGroups}`)
    );
    const deleteBreakdownsCall = calls.find((call) =>
      String(call[0]).includes(`DELETE FROM public.${TABLES.outsideGroupBreakdowns}`)
    );

    const groupSql = String(groupCall?.[0]);
    expect(groupSql).toContain("sponsor_id,");
    expect(groupSql).toContain("sponsor_name,");
    expect(groupSql).toContain("ON CONFLICT (link_id, election_year, sponsor_id, support_oppose)");
    expect(groupSql).toContain("sponsor_name = EXCLUDED.sponsor_name,");
    expect(groupSql).not.toContain("committee_id");
    expect(groupSql).not.toContain("committee_name");
    // The identity value still comes from the committeeId input field.
    expect(groupCall?.[1]?.[2]).toBe("PAC-1");
    expect(groupCall?.[1]?.[3]).toBe("Some PAC");

    const breakdownSql = String(breakdownCall?.[0]);
    expect(breakdownSql).toContain(
      "ON CONFLICT (link_id, election_year, sponsor_id, support_oppose, category_type, category_name)"
    );
    expect(breakdownSql).not.toContain("committee_id");

    expect(String(deleteGroupsCall?.[0])).toContain("keep.sponsor_id = zz_candidate_finance_outside_groups.sponsor_id");
    expect(JSON.parse(String(deleteGroupsCall?.[1]?.[2]))).toEqual([
      { sponsor_id: "PAC-1", support_oppose: "support" },
    ]);
    expect(String(deleteBreakdownsCall?.[0])).toContain(
      "keep.sponsor_id = zz_candidate_finance_outside_group_breakdowns.sponsor_id"
    );
    expect(JSON.parse(String(deleteBreakdownsCall?.[1]?.[2]))).toEqual([
      { sponsor_id: "PAC-1", support_oppose: "support", category_type: "donor", category_name: "Some Donor" },
    ]);
  });

  it("does not touch the link table's committee columns when outside identity is overridden", async () => {
    const { db, client } = poolWithClient();

    await makeWriter({
      outsideGroupIdentityColumns: { id: "sponsor_id", name: "sponsor_name" },
    }).replaceSnapshot({
      db,
      link: linkInput(),
      syncedAt: NOW,
      outsideGroups: [
        { committeeId: "PAC-1", committeeName: "Some PAC", supportOppose: "support", amount: 500 },
      ],
    });

    const linkCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes(`INSERT INTO public.${TABLES.links}`)
    );
    expect(String(linkCall?.[0])).toContain("ON CONFLICT (candidate_id, election_id, committee_id)");
    expect(String(linkCall?.[0])).toContain("committee_name = EXCLUDED.committee_name,");
  });

  it("rejects outside-group identity columns that are not identifier-safe", () => {
    expect(() => makeWriter({ outsideGroupIdentityColumns: { id: "sponsor id" } })).toThrow(
      "Invalid Zetaland outside-group identity column: sponsor id"
    );
    expect(() => makeWriter({ outsideGroupIdentityColumns: { name: 'sponsor"name' } })).toThrow(
      'Invalid Zetaland outside-group identity column: sponsor"name'
    );
  });

  it("renders configured link identity columns in the link upsert and nowhere else", async () => {
    const { db, client } = poolWithClient();
    const writer = makeWriter({
      linkIdentityColumns: { id: "candidate_filer_id", name: "candidate_filer_name" },
      supersededLinkSource: "bulk_import",
    });

    await writer.replaceSnapshot({
      db,
      link: { ...linkInput(), linkSource: "bulk_import" },
      syncedAt: NOW,
      outsideGroups: [
        { committeeId: "PAC-1", committeeName: "Some PAC", supportOppose: "support", amount: 500 },
      ],
    });

    const calls = client.query.mock.calls;
    const linkCall = calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.links}`));
    const linkSql = String(linkCall?.[0]);
    expect(linkSql).toContain("candidate_filer_id,");
    expect(linkSql).toContain("candidate_filer_name,");
    expect(linkSql).toContain("ON CONFLICT (candidate_id, election_id, candidate_filer_id)");
    expect(linkSql).toContain("candidate_filer_name = EXCLUDED.candidate_filer_name,");
    expect(linkSql).not.toContain("committee_id");
    expect(linkSql).not.toContain("committee_name");
    // The identity values still come from the committeeId/committeeName fields.
    expect(linkCall?.[1]?.[6]).toBe("C-1");
    expect(linkCall?.[1]?.[7]).toBe("Doe for Zetaland");

    // Supersession keys on candidate/election/source, not the identity column.
    const deactivateCall = calls.find((call) => String(call[0]).includes(`UPDATE public.${TABLES.links}`));
    expect(String(deactivateCall?.[0])).toContain("link_source = 'bulk_import'");
    expect(String(deactivateCall?.[0])).not.toContain("candidate_filer_id");

    // Outside tables keep their own (default) identity columns.
    const groupCall = calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.outsideGroups}`));
    expect(String(groupCall?.[0])).toContain("ON CONFLICT (link_id, election_year, committee_id, support_oppose)");
  });

  it("supports link and outside identity overrides together", async () => {
    const { db, client } = poolWithClient();

    await makeWriter({
      linkIdentityColumns: { id: "candidate_filer_id", name: "candidate_filer_name" },
      outsideGroupIdentityColumns: { id: "outside_group_id", name: "outside_group_name" },
    }).replaceSnapshot({
      db,
      link: linkInput(),
      syncedAt: NOW,
      outsideGroups: [
        { committeeId: "PAC-1", committeeName: "Some PAC", supportOppose: "support", amount: 500 },
      ],
    });

    const calls = client.query.mock.calls;
    const linkSql = String(calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.links}`))?.[0]);
    const groupSql = String(
      calls.find((call) => String(call[0]).includes(`INSERT INTO public.${TABLES.outsideGroups}`))?.[0]
    );
    const deleteGroupsCall = calls.find((call) => String(call[0]).includes(`DELETE FROM public.${TABLES.outsideGroups}`));
    expect(linkSql).toContain("ON CONFLICT (candidate_id, election_id, candidate_filer_id)");
    expect(groupSql).toContain("ON CONFLICT (link_id, election_year, outside_group_id, support_oppose)");
    expect(groupSql).toContain("outside_group_name = EXCLUDED.outside_group_name,");
    expect(JSON.parse(String(deleteGroupsCall?.[1]?.[2]))).toEqual([
      { outside_group_id: "PAC-1", support_oppose: "support" },
    ]);
  });

  it("rejects link identity columns that are not identifier-safe", () => {
    expect(() => makeWriter({ linkIdentityColumns: { id: "filer id" } })).toThrow(
      "Invalid Zetaland link identity column: filer id"
    );
    expect(() => makeWriter({ linkIdentityColumns: { name: "filer;name" } })).toThrow(
      "Invalid Zetaland link identity column: filer;name"
    );
  });
});
