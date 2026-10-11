import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  replaceArkansasCandidateFinanceSnapshot,
  upsertArkansasFinanceLink,
} from "../../../src/pipeline/arkansasFinance/arkansasFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://ethics-disclosures.sos.arkansas.gov/";
const VERIFIED_AT = new Date("2026-09-01T00:00:00.000Z");

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    candidateNameNormalized: "SARAH SANDERS",
    officeName: "Governor",
    district: null,
    filingEntityId: 1004,
    filerName: "Sanders, Sarah (Sarah for Governor)",
    linkSource: "cfis_registration" as const,
    sourceUrl: SOURCE_URL,
    lastVerifiedAt: VERIFIED_AT,
  };
}

function successfulQuery(sql: unknown) {
  if (String(sql).includes("INSERT INTO public.ar_candidate_finance_links")) {
    return Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

function transactionalDb() {
  const client = { query: vi.fn(successfulQuery), release: vi.fn() };
  const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
  return { db, client };
}

describe("arkansasFinanceWriter", () => {
  it("writes the CFIS filing-entity link identity and protects manual links", async () => {
    const db = { query: vi.fn(successfulQuery) };

    await expect(upsertArkansasFinanceLink({ db, link: baseLink() })).resolves.toEqual({
      linkId: LINK_ID,
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("link_source='manual'");
    const insert = db.query.mock.calls[1];
    expect(String(insert?.[0])).toContain("filing_entity_id");
    expect(String(insert?.[0])).toContain("filer_name");
    expect(insert?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "SARAH SANDERS",
      "Governor",
      null,
      "1004",
      "Sanders, Sarah (Sarah for Governor)",
      "active",
      "cfis_registration",
      SOURCE_URL,
      VERIFIED_AT.toISOString(),
    ]);
  });

  it("replaces a direct-only snapshot transactionally and never writes outside rows", async () => {
    const { db, client } = transactionalDb();

    await expect(
      replaceArkansasCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        syncedAt: new Date("2026-09-01T12:00:00.000Z"),
        summary: {
          totalReceipts: 7_870_507.53,
          directContributionTotal: 7_870_507.53,
          totalDisbursements: 5_717_191.87,
          cashOnHand: 2_153_315.66,
          sourceUrl: SOURCE_URL,
        },
        directBreakdowns: [
          { categoryType: "occupation", categoryName: "Retired", amount: 500_000, contributorCount: 1_200 },
          { categoryType: "contribution_size", categoryName: "$100-$249", amount: 250_000 },
        ],
      })
    ).resolves.toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
    });

    const calls = client.query.mock.calls;
    expect(calls[0]?.[0]).toBe("BEGIN");
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();

    const summary = calls.find((call) => String(call[0]).includes("ar_candidate_finance_summaries"));
    const summarySql = String(summary?.[0]);
    // Unknown direct and outside components preserve their stored values.
    expect(summarySql).toContain(
      "total_receipts = COALESCE(EXCLUDED.total_receipts, ar_candidate_finance_summaries.total_receipts)"
    );
    expect(summarySql).toContain("outside_support_total = COALESCE(EXCLUDED.outside_support_total, ar_candidate_finance_summaries.outside_support_total)");
    expect(summarySql).toContain("outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, ar_candidate_finance_summaries.outside_oppose_total)");
    expect(summary?.[1]?.slice(2, 9)).toEqual([
      7_870_507.53,
      7_870_507.53,
      5_717_191.87,
      2_153_315.66,
      null,
      null,
      SOURCE_URL,
    ]);

    const directInserts = calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.ar_candidate_finance_direct_breakdowns")
    );
    expect(directInserts.map((call) => call[1]?.[2])).toEqual(["occupation", "contribution_size"]);

    expect(
      calls.some((call) => String(call[0]).includes("INSERT INTO public.ar_candidate_finance_outside_groups"))
    ).toBe(false);
    expect(
      calls.some((call) => String(call[0]).includes("DELETE FROM public.ar_candidate_finance_outside_groups"))
    ).toBe(false);
    expect(
      calls.some((call) => String(call[0]).includes("DELETE FROM public.ar_candidate_finance_outside_group_breakdowns"))
    ).toBe(false);

    const supersede = calls.find(
      (call) =>
        String(call[0]).includes("UPDATE public.ar_candidate_finance_links") && String(call[0]).includes("id <>")
    );
    expect(String(supersede?.[0])).toContain("link_source = 'cfis_registration'");
  });

  it("accepts a negative cash-on-hand balance", async () => {
    const { db, client } = transactionalDb();

    await replaceArkansasCandidateFinanceSnapshot({
      db,
      link: { ...baseLink(), filingEntityId: 11847, filerName: "Wilson, Harrell" },
      summary: {
        totalReceipts: 206_119,
        directContributionTotal: 206_119,
        totalDisbursements: 153_003.78,
        cashOnHand: -55_067.21,
        sourceUrl: SOURCE_URL,
      },
    });

    const summary = client.query.mock.calls.find((call) =>
      String(call[0]).includes("ar_candidate_finance_summaries")
    );
    expect(summary?.[1]?.[5]).toBe(-55_067.21);
  });

  it("preserves stored totals and direct rows when source sections are unavailable", async () => {
    const { db, client } = transactionalDb();

    await replaceArkansasCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: {
        totalReceipts: null,
        directContributionTotal: null,
        totalDisbursements: null,
        cashOnHand: null,
        sourceUrl: null,
      },
    });

    const calls = client.query.mock.calls;
    const summarySql = String(
      calls.find((call) => String(call[0]).includes("ar_candidate_finance_summaries"))?.[0]
    );
    expect(summarySql).toContain("direct_contribution_total = COALESCE(EXCLUDED.direct_contribution_total");
    expect(summarySql).toContain("cash_on_hand = COALESCE(EXCLUDED.cash_on_hand");
    expect(
      calls.some((call) => String(call[0]).includes("DELETE FROM public.ar_candidate_finance_direct_breakdowns"))
    ).toBe(false);
  });

  it("writes zeros and clears stale direct rows after a successful empty fetch", async () => {
    const { db, client } = transactionalDb();

    await replaceArkansasCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: {
        totalReceipts: 0,
        directContributionTotal: 0,
        totalDisbursements: 0,
        cashOnHand: 0,
        sourceUrl: SOURCE_URL,
      },
      directBreakdowns: [],
    });

    const calls = client.query.mock.calls;
    const summary = calls.find((call) => String(call[0]).includes("ar_candidate_finance_summaries"));
    expect(summary?.[1]?.slice(2, 9)).toEqual([0, 0, 0, 0, null, null, SOURCE_URL]);
    expect(
      calls.some((call) => String(call[0]).includes("DELETE FROM public.ar_candidate_finance_direct_breakdowns"))
    ).toBe(true);
  });

  it("rejects non-Arkansas direct category types before opening a transaction", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };

    await expect(
      replaceArkansasCandidateFinanceSnapshot({
        db: db as never,
        link: baseLink(),
        directBreakdowns: [{ categoryType: "industry" as never, categoryName: "health-care", amount: 100 }],
      })
    ).rejects.toThrow("Arkansas finance direct breakdown category type is not allowed: industry");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects invalid filing entity IDs and pre-2026 years before database writes", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };

    await expect(
      replaceArkansasCandidateFinanceSnapshot({ db: db as never, link: { ...baseLink(), filingEntityId: 0 } })
    ).rejects.toThrow("Invalid Arkansas filing entity ID: 0");
    await expect(
      replaceArkansasCandidateFinanceSnapshot({ db: db as never, link: { ...baseLink(), filingEntityId: 1.5 } })
    ).rejects.toThrow("Invalid Arkansas filing entity ID: 1.5");
    await expect(
      replaceArkansasCandidateFinanceSnapshot({ db: db as never, link: { ...baseLink(), electionYear: 2024 } })
    ).rejects.toThrow(/2024/);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back and releases the client when a snapshot query fails", async () => {
    const client = {
      query: vi.fn((sql: unknown) => {
        if (String(sql).includes("ar_candidate_finance_summaries")) {
          return Promise.reject(new Error("summary failed"));
        }
        return successfulQuery(sql);
      }),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };

    await expect(
      replaceArkansasCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        summary: {
          totalReceipts: 1,
          directContributionTotal: 1,
          totalDisbursements: 1,
          cashOnHand: 0,
          sourceUrl: SOURCE_URL,
        },
      })
    ).rejects.toThrow("summary failed");

    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some((call) => call[0] === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("migration 266", () => {
  const sql = readFileSync(
    new URL("../../../../db/migrations/266_add_arkansas_campaign_finance_tables.sql", import.meta.url),
    "utf8"
  );

  it("pins the writer's schema contract", () => {
    for (const table of [
      "ar_candidate_finance_links",
      "ar_candidate_finance_summaries",
      "ar_candidate_finance_direct_breakdowns",
      "ar_candidate_finance_outside_groups",
      "ar_candidate_finance_outside_group_breakdowns",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table} (`);
    }
    expect(sql).toContain("CHECK (link_source IN ('manual', 'cfis_registration'))");
    expect(sql).toContain("CHECK (category_type IN ('occupation', 'contribution_size'))");
    expect(sql).toContain("CHECK (filing_entity_id ~ '^[1-9][0-9]*$')");
    expect(sql).toContain("CHECK (election_year BETWEEN 2026 AND 2100)");
    // cash_on_hand is signed: it must not appear in the nonnegative amounts guard.
    expect(sql).not.toContain("cash_on_hand IS NULL OR cash_on_hand >= 0");
    expect(sql).toContain("total_disbursements IS NULL OR total_disbursements >= 0");
  });

  it("keeps every identifier within Postgres's 63-character limit", () => {
    const identifiers = [...sql.matchAll(/(?:CONSTRAINT|INDEX IF NOT EXISTS|TRIGGER IF EXISTS|CREATE TRIGGER)\s+([a-z0-9_]+)/g)].map(
      (match) => match[1]!
    );
    expect(identifiers.length).toBeGreaterThan(20);
    for (const identifier of identifiers) {
      expect(identifier.length, identifier).toBeLessThanOrEqual(63);
    }
  });
});
