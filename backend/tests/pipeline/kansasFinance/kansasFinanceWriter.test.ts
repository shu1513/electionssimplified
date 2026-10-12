import { describe, expect, it, vi } from "vitest";

import {
  buildKansasFilerKey,
  normalizeKansasFilerKey,
  normalizeKansasNameForStorage,
  parseKansasFilerKey,
  replaceKansasCandidateFinanceSnapshot,
  upsertKansasFinanceLink,
} from "../../../src/pipeline/kansasFinance/kansasFinanceWriter.js";

describe("Kansas filer recipe keys", () => {
  it("builds <officeCode>:<district>:<SURNAME>:<FIRST> with storage normalization", () => {
    expect(buildKansasFilerKey({ officeCode: "7", districtNumber: 85, surname: "Brunson", firstName: "Steven" })).toBe("7:85:BRUNSON:STEVEN");
    expect(buildKansasFilerKey({ officeCode: "1", districtNumber: null, surname: "Rowan", firstName: "Stacy" })).toBe("1::ROWAN:STACY");
    expect(buildKansasFilerKey({ officeCode: "7", districtNumber: 12, surname: "Van Dyke", firstName: "Mary-Ann" })).toBe("7:12:VAN DYKE:MARY ANN");
    expect(normalizeKansasNameForStorage("O'Brien, José")).toBe("O BRIEN JOSE");
  });

  it("rejects keys outside the recipe shape", () => {
    expect(normalizeKansasFilerKey(" 7:85:brunson:steven ")).toBe("7:85:BRUNSON:STEVEN");
    expect(() => normalizeKansasFilerKey("12345")).toThrow("Invalid Kansas filer key");
    expect(() => normalizeKansasFilerKey("7:85:BRUNSON")).toThrow("Invalid Kansas filer key");
    expect(() => normalizeKansasFilerKey("7:85::STEVEN")).toThrow("Invalid Kansas filer key");
    expect(() => buildKansasFilerKey({ officeCode: "7", districtNumber: 85, surname: "", firstName: "Steven" })).toThrow("Invalid Kansas filer key");
  });

  it("parses a stored key back into its recipe parts", () => {
    expect(parseKansasFilerKey("7:85:VAN DYKE:MARY ANN")).toEqual({ officeCode: "7", districtNumber: 85, surname: "VAN DYKE", firstName: "MARY ANN" });
    expect(parseKansasFilerKey(" 1::rowan:stacy ")).toEqual({ officeCode: "1", districtNumber: null, surname: "ROWAN", firstName: "STACY" });
    expect(() => parseKansasFilerKey("7:85:BRUNSON")).toThrow("Invalid Kansas filer key");
  });
});

describe("upsertKansasFinanceLink", () => {
  it("canonicalizes the key and writes through the standard writer", async () => {
    const db = {
      query: vi.fn((sql: unknown) =>
        String(sql).includes("INSERT INTO public.ks_candidate_finance_links")
          ? Promise.resolve({ rows: [{ id: "link-1" }], rowCount: 1 })
          : Promise.resolve({ rows: [], rowCount: 0 })
      ),
    };
    const result = await upsertKansasFinanceLink({
      db,
      link: {
        candidateId: "11111111-1111-4111-8111-111111111111",
        electionId: "22222222-2222-4222-8222-222222222222",
        electionYear: 2026,
        candidateNameNormalized: "STEVEN BRUNSON",
        officeName: "State Lower Chamber Legislator",
        district: "85",
        committeeId: "7:85:brunson:steven",
        committeeName: "BRUNSON STEVEN",
        linkSource: "cfr_viewer",
      },
    });
    expect(result).toEqual({ linkId: "link-1" });
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_links"));
    expect(insert?.[1]?.[6]).toBe("7:85:BRUNSON:STEVEN");
    expect(insert?.[1]?.[9]).toBe("cfr_viewer");
  });

  it("refuses a link whose id is not a recipe key", async () => {
    const db = { query: vi.fn() };
    await expect(
      upsertKansasFinanceLink({
        db,
        link: {
          candidateId: "11111111-1111-4111-8111-111111111111",
          electionId: "22222222-2222-4222-8222-222222222222",
          electionYear: 2026,
          candidateNameNormalized: "STEVEN BRUNSON",
          officeName: "State Lower Chamber Legislator",
          district: "85",
          committeeId: "H085SB",
          committeeName: "BRUNSON STEVEN",
        },
      })
    ).rejects.toThrow("Invalid Kansas filer key");
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("replaceKansasCandidateFinanceSnapshot", () => {
  it("writes link, summary and breakdowns in one transaction, leaving outside groups alone when none are passed", async () => {
    const client = {
      query: vi.fn((sql: unknown) =>
        String(sql).includes("INSERT INTO public.ks_candidate_finance_links")
          ? Promise.resolve({ rows: [{ id: "link-1" }], rowCount: 1 })
          : Promise.resolve({ rows: [], rowCount: 0 })
      ),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
    const syncedAt = new Date("2026-09-03T12:00:00.000Z");
    const result = await replaceKansasCandidateFinanceSnapshot({
      db,
      link: {
        candidateId: "11111111-1111-4111-8111-111111111111",
        electionId: "22222222-2222-4222-8222-222222222222",
        electionYear: 2026,
        candidateNameNormalized: "STEVEN BRUNSON",
        officeName: "State Lower Chamber Legislator",
        district: "85",
        committeeId: " 7:85:brunson:steven ",
        committeeName: "BRUNSON STEVEN",
        linkSource: "manual",
        lastVerifiedAt: syncedAt,
      },
      syncedAt,
      summary: { totalReceipts: 1234.5, directContributionTotal: 1000, totalDisbursements: 200, cashOnHand: null, sourceUrl: "https://sos.ks.gov/x" },
      directBreakdowns: [{ categoryType: "occupation", categoryName: "Retired", amount: 500, sourceUrl: "https://sos.ks.gov/x" }],
    });
    expect(result).toEqual({ linkId: "link-1", summaryWritten: true, directBreakdownsWritten: 1, outsideGroupsWritten: 0, outsideGroupBreakdownsWritten: 0 });
    const sqls = client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 4).join(" "));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    const insertLink = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_links"));
    expect(insertLink?.[1]?.[6]).toBe("7:85:BRUNSON:STEVEN");
    expect(insertLink?.[1]?.[9]).toBe("manual");
    const summary = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"));
    expect(summary?.[1]).toEqual(["link-1", 2026, 1234.5, 1000, 200, null, null, null, "https://sos.ks.gov/x", syncedAt.toISOString()]);
    expect(String(summary?.[0])).toContain("outside_support_total = COALESCE(EXCLUDED.outside_support_total, ks_candidate_finance_summaries.outside_support_total)");
    expect(String(summary?.[0])).toContain("outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, ks_candidate_finance_summaries.outside_oppose_total)");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.ks_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.ks_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("ks_candidate_finance_outside_groups"))).toBe(false);
  });
it("allows an explicitly supplied numeric zero and empty outside component to replace", async () => {
  const client = {
    query: vi.fn(async (sql: unknown) =>
      String(sql).includes("INSERT INTO public.ks_candidate_finance_links")
        ? { rows: [{ id: "link-1" }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    ),
    release: vi.fn(),
  };
  const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
  await replaceKansasCandidateFinanceSnapshot({
    db,
    link: {
      candidateId: "11111111-1111-4111-8111-111111111111",
      electionId: "22222222-2222-4222-8222-222222222222",
      electionYear: 2026,
      candidateNameNormalized: "STEVEN BRUNSON",
      officeName: "State Lower Chamber Legislator",
      district: "85",
      committeeId: "7:85:BRUNSON:STEVEN",
      committeeName: "BRUNSON STEVEN",
      linkSource: "manual",
    },
    syncedAt: new Date("2026-10-12T12:00:00Z"),
    summary: {
      totalReceipts: 0,
      directContributionTotal: 0,
      totalDisbursements: 0,
      cashOnHand: 0,
      outsideSupportTotal: 0,
      outsideOpposeTotal: 0,
    },
    directBreakdowns: [],
    outsideGroups: [],
  });
  const summary = client.query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO public.ks_candidate_finance_summaries"),
  );
  expect(summary?.[1]?.slice(6, 8)).toEqual([0, 0]);
  expect(
    client.query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM public.ks_candidate_finance_outside_groups"),
    ),
  ).toBe(true);
  expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
});

});
