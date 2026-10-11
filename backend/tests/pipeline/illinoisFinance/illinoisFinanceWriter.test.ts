import { describe, expect, it, vi } from "vitest";

import {
  replaceIllinoisCandidateFinanceSnapshot,
  upsertIllinoisFinanceLink,
} from "../../../src/pipeline/illinoisFinance/illinoisFinanceWriter.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_URL = "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCandidates.aspx";

function baseLink() {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2022,
    candidateNameNormalized: "JANE DOE",
    officeName: "Governor",
    district: " ",
    committeeKey: " friends  of jane ",
    committeeName: "Friends of Jane",
    linkStatus: "active" as const,
    linkSource: "illinois_sbe" as const,
    sourceUrl: SOURCE_URL,
    lastVerifiedAt: new Date("2022-06-01T00:00:00.000Z"),
  };
}

function createMockDb() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

describe("illinoisFinanceWriter", () => {
  const donor = () => ({ committeeId: "1028", committeeName: "Community BANCPAC",
    committeeType: "Political Action" as const, totalAmount: 2000, contributionCount: 2,
    sourceUrl: SOURCE_URL });
  const report = () => ({ committeeId: "615", filedDocId: "1023410", periodStart: "2026-07-01",
    periodEnd: "2026-09-30", receivedAt: "2026-10-07 15:46:19.163000000", fingerprint: "a".repeat(64) });
  function verifiedDb(previous: unknown[]) {
    const db = createMockDb();
    db.client.query.mockImplementation(async (sql: string) => sql.includes("SELECT groups.source_reports")
      ? { rows: previous.map((source_reports) => ({ source_reports })), rowCount: previous.length }
      : { rows: [{ id: LINK_ID }], rowCount: 1 });
    return db;
  }
  function verifiedOutside() {
    return { link: { ...baseLink(), electionYear: 2026, committeeKey: "SBE:34092" },
      summary: { totalReceipts: 20000, outsideSupportTotal: 66.5, outsideOpposeTotal: 0 },
      outsideGroups: [{ committeeKey: "SBE:615", committeeName: "Kane County Republican Central Cmte",
        supportOppose: "support" as const, amount: 66.5, sourceReports: [report()] }],
      outsideReportEvidence: [report()] };
  }

  it("stores verified report provenance once across receiving links without touching sibling direct/PAC data", async () => {
    const db = verifiedDb([]);
    const result = await replaceIllinoisCandidateFinanceSnapshot({ db, ...verifiedOutside() });
    expect(result.outsidePreserved).toBe(false);
    expect(result.outsideGroupsWritten).toBe(1);
    const calls = db.client.query.mock.calls;
    expect(JSON.parse(calls.find((call) => String(call[0]).includes("INSERT INTO public.il_candidate_finance_outside_groups"))?.[1][8]))
      .toEqual([report()]);
    const cleanup = calls.filter((call) => String(call[0]).includes("id <> $3::uuid"));
    expect(cleanup).toHaveLength(2);
    expect(cleanup[0]?.[1]).toEqual([CANDIDATE_ID, ELECTION_ID, LINK_ID, 2026]);
    expect(String(cleanup[1]?.[0])).toContain("outside_support_total = NULL, outside_oppose_total = NULL");
    expect(cleanup.every((call) => !String(call[0]).includes("pac_donors") && !String(call[0]).includes("direct_breakdowns"))).toBe(true);
  });

  it.each([
    null, [], [{ ...report(), fingerprint: "b".repeat(64) }], [{ ...report(), filedDocId: "99999" }], [{ invalid: true }],
  ])("preserves missing, disappearing or changed same-version provenance while updating direct/PAC: %j", async (old) => {
    const db = verifiedDb([old]);
    const result = await replaceIllinoisCandidateFinanceSnapshot({ db, ...verifiedOutside(), pacDonors: [donor()] });
    expect(result).toMatchObject({ outsidePreserved: true, outsideGroupsWritten: 0, pacDonorsWritten: 1, summaryWritten: true });
    const calls = db.client.query.mock.calls;
    expect(calls.some((call) => /(?:INSERT INTO|DELETE FROM) public\.il_candidate_finance_outside/.test(String(call[0])))).toBe(false);
    const summary = calls.find((call) => String(call[0]).includes("INSERT INTO public.il_candidate_finance_summaries"));
    expect(summary?.[1][2]).toBe(20000);
    expect(summary?.[1].slice(7, 9)).toEqual([null, null]);
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("accepts unchanged provenance and a verified newer amendment that explicitly supersedes it", async () => {
    const unchanged = verifiedDb([[report()]]);
    expect((await replaceIllinoisCandidateFinanceSnapshot({ db: unchanged, ...verifiedOutside() })).outsidePreserved).toBe(false);
    const amended = { ...report(), filedDocId: "1023500", fingerprint: "b".repeat(64), supersededDocumentIds: ["1023410"] };
    const db = verifiedDb([[report()]]);
    const input = verifiedOutside();
    const result = await replaceIllinoisCandidateFinanceSnapshot({ db, ...input, outsideReportEvidence: [amended],
      outsideGroups: [{ ...input.outsideGroups[0]!, sourceReports: [amended] }] });
    expect(result.outsidePreserved).toBe(false);
    expect(result.outsideGroupsWritten).toBe(1);
  });

  it("rejects unproven empty or mismatched verified groups before a transaction", async () => {
    const db = verifiedDb([]);
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, ...verifiedOutside(), outsideGroups: [] })).rejects.toThrow("empty IE");
    const input = verifiedOutside();
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, ...input,
      outsideGroups: [{ ...input.outsideGroups[0]!, sourceReports: [] }] })).rejects.toThrow("report evidence");
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, ...input,
      outsideGroups: [{ ...input.outsideGroups[0]!, committeeKey: "SBE:999" }] })).rejects.toThrow("report evidence");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it.each([undefined, { outsideSupportTotal: null, outsideOpposeTotal: 0 },
    { outsideSupportTotal: 66.51, outsideOpposeTotal: 0 },
    { outsideSupportTotal: 66.5, outsideOpposeTotal: 1 }])("rejects inconsistent verified headlines before writing: %j", async (summary) => {
    const db = verifiedDb([]);
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, ...verifiedOutside(), summary }))
      .rejects.toThrow("headline");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it.each([0, 0.001, Number.MAX_SAFE_INTEGER])("rejects unsafe or zero verified groups: %s", async (amount) => {
    const db = verifiedDb([]), input = verifiedOutside();
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, ...input,
      outsideGroups: [{ ...input.outsideGroups[0]!, amount }] })).rejects.toThrow("positive safe cents");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects duplicate normalized verified group keys", async () => {
    const db = verifiedDb([]), input = verifiedOutside();
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, ...input,
      outsideGroups: [...input.outsideGroups, { ...input.outsideGroups[0]!, committeeKey: " sbe:615 " }] }))
      .rejects.toThrow("unique keys");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("writes and replaces typed PAC donors inside the same snapshot transaction", async () => {
    const db = createMockDb();
    const result = await replaceIllinoisCandidateFinanceSnapshot({ db, link: baseLink(),
      summary: { totalReceipts: 20000 }, pacDonors: [donor()] });
    expect(result.pacDonorsWritten).toBe(1);
    const calls = db.client.query.mock.calls;
    const insert = calls.find((call) => String(call[0]).includes("INSERT INTO public.il_candidate_finance_pac_donors"));
    expect(insert?.[1].slice(0, 8)).toEqual([LINK_ID, 2022, "1028", "Community BANCPAC", "Political Action", 2000, 2, SOURCE_URL]);
    expect(calls.find((call) => String(call[0]).includes("DELETE FROM public.il_candidate_finance_pac_donors"))?.[1])
      .toEqual([LINK_ID, 2022, ["1028"]]);
    expect(calls[0]?.[0]).toBe("BEGIN");
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.query).not.toHaveBeenCalled();
    // PAC subset never changes the fundraising amount.
    expect(calls.find((call) => String(call[0]).includes("INSERT INTO public.il_candidate_finance_summaries"))?.[1][2]).toBe(20000);
  });

  it("preserves omitted donors and clears only an explicitly validated empty donor scope", async () => {
    const db = createMockDb();
    await replaceIllinoisCandidateFinanceSnapshot({ db, link: baseLink() });
    expect(db.client.query.mock.calls.some((call) => String(call[0]).includes("pac_donors"))).toBe(false);
    db.client.query.mockClear();
    const result = await replaceIllinoisCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [] });
    expect(result.pacDonorsWritten).toBe(0);
    expect(db.client.query.mock.calls.filter((call) => String(call[0]).includes("pac_donors")))
      .toEqual([[expect.stringContaining("DELETE FROM public.il_candidate_finance_pac_donors"), [LINK_ID, 2022, []]]]);
  });

  it.each([
    { committeeId: "0" }, { committeeId: "1028 OR true" }, { committeeId: "99999999999999999" },
    { committeeName: " " }, { committeeType: "Candidate" }, { totalAmount: 0 }, { totalAmount: -1 },
    { totalAmount: Number.NaN }, { totalAmount: 1.001 }, { contributionCount: 0 }, { contributionCount: 1.5 },
  ])("rejects invalid donor evidence before opening a transaction: %j", async (change) => {
    const db = createMockDb();
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, link: baseLink(),
      pacDonors: [{ ...donor(), ...change } as ReturnType<typeof donor>] })).rejects.toThrow();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects duplicate donor IDs and recipient self transfers", async () => {
    const db = createMockDb();
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, link: baseLink(), pacDonors: [donor(), donor()] }))
      .rejects.toThrow("duplicate IDs");
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, link: { ...baseLink(), committeeKey: "SBE:1028" }, pacDonors: [donor()] }))
      .rejects.toThrow("receiving committee");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back direct totals when a PAC donor write fails", async () => {
    const db = createMockDb();
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO public.il_candidate_finance_pac_donors")) throw new Error("donor write failed");
      return { rows: [{ id: LINK_ID }], rowCount: 1 };
    });
    await expect(replaceIllinoisCandidateFinanceSnapshot({ db, link: baseLink(),
      summary: { totalReceipts: 20000 }, pacDonors: [donor()] })).rejects.toThrow("donor write failed");
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.client.query.mock.calls.some((call) => call[0] === "COMMIT")).toBe(false);
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("upserts Illinois finance links with normalized nullable fields", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
    };

    await expect(upsertIllinoisFinanceLink({ db, link: baseLink() })).resolves.toEqual({ linkId: LINK_ID });

    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.il_candidate_finance_links");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (candidate_id, election_id, committee_key)");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("WHEN il_candidate_finance_links.link_source = 'manual'");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("THEN il_candidate_finance_links.source_url");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("THEN il_candidate_finance_links.last_verified_at");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("THEN il_candidate_finance_links.sbe_candidate_id");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("THEN il_candidate_finance_links.sbe_district_type");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("THEN il_candidate_finance_links.sbe_office");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("THEN il_candidate_finance_links.is_at_large");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2022,
      "JANE DOE",
      "Governor",
      null,
      null,
      null,
      null,
      null,
      "FRIENDS OF JANE",
      "Friends of Jane",
      "active",
      "illinois_sbe",
      SOURCE_URL,
      "2022-06-01T00:00:00.000Z",
    ]);
  });

  it("replaces an Illinois finance snapshot inside a transaction", async () => {
    const db = createMockDb();

    const result = await replaceIllinoisCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      syncedAt: new Date("2022-07-08T09:10:11.000Z"),
      summary: {
        totalReceipts: 120000,
        directContributionTotal: 120000,
        outsideSupportTotal: 35000,
        outsideOpposeTotal: 5000,
        sourceUrl: SOURCE_URL,
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 90000,
          contributorCount: 12,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideGroups: [
        {
          committeeKey: " illinois conservation action ",
          committeeName: "Illinois Conservation Action",
          supportOppose: "support",
          amount: 35000,
          sourceUrl: SOURCE_URL,
        },
      ],
      outsideGroupBreakdowns: [
        {
          committeeKey: "ILLINOIS CONSERVATION ACTION",
          supportOppose: "support",
          categoryType: "industry",
          categoryName: "environmental_group",
          amount: 35000,
          contributorCount: 1,
          sourceUrl: SOURCE_URL,
        },
      ],
    });

    expect(result).toEqual({
      linkId: LINK_ID,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 1,
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledTimes(1);

    const sql = db.client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO public.il_candidate_finance_summaries"))).toBe(true);
    expect(sql.some((statement) => statement.includes("ELSE COALESCE(EXCLUDED.total_receipts, il_candidate_finance_summaries.total_receipts) END"))).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes("outside_support_total = COALESCE(") &&
          statement.includes("il_candidate_finance_summaries.outside_support_total") &&
          statement.includes("outside_oppose_total = COALESCE(") &&
          statement.includes("il_candidate_finance_summaries.outside_oppose_total")
      )
    ).toBe(true);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.il_candidate_finance_direct_breakdowns"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.il_candidate_finance_outside_groups"))).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("INSERT INTO public.il_candidate_finance_outside_group_breakdowns"))).toHaveLength(1);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.il_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.il_candidate_finance_outside_groups"))).toBe(true);
    expect(sql.some((statement) => statement.includes("DELETE FROM public.il_candidate_finance_outside_group_breakdowns"))).toBe(true);

    const outsideGroupCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_outside_groups")
    );
    const outsideBreakdownCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideGroupCall?.[1]?.[2]).toBe("ILLINOIS CONSERVATION ACTION");
    expect(outsideBreakdownCall?.[1]?.[2]).toBe("ILLINOIS CONSERVATION ACTION");
  });

  it("replaces current D-2 totals, including unavailable ones, and keeps stored totals only when D-2 was omitted", async () => {
    const summaryCall = (db: ReturnType<typeof createMockDb>) => db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_summaries"));
    const current = createMockDb();
    await replaceIllinoisCandidateFinanceSnapshot({ db: current, link: baseLink(), summary: { totalReceipts: 100, cashOnHand: null, d2Current: true } });
    expect(String(summaryCall(current)?.[0])).toContain("cash_on_hand = CASE WHEN $12::boolean THEN EXCLUDED.cash_on_hand");
    expect(summaryCall(current)?.[1]?.[5]).toBeNull();
    expect(summaryCall(current)?.[1]?.[11]).toBe(true);
    const omitted = createMockDb();
    await replaceIllinoisCandidateFinanceSnapshot({ db: omitted, link: baseLink(), summary: { outsideSupportTotal: 5, outsideOpposeTotal: 0 } });
    expect(summaryCall(omitted)?.[1]?.[11]).toBe(false);
  });

  it("stores signed ending cash while keeping flow amounts nonnegative", async () => {
    const db = createMockDb();

    await replaceIllinoisCandidateFinanceSnapshot({
      db,
      link: baseLink(),
      summary: { cashOnHand: -423.14, totalReceipts: 100 },
    });

    const summaryCall = db.client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.il_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]?.[5]).toBe(-423.14);

    await expect(
      replaceIllinoisCandidateFinanceSnapshot({
        db: createMockDb(),
        link: baseLink(),
        summary: { totalReceipts: -1 },
      })
    ).rejects.toThrow("total receipts must be a nonnegative number");
  });

  it("rejects outside group breakdowns without matching outside groups", async () => {
    const db = createMockDb();

    await expect(
      replaceIllinoisCandidateFinanceSnapshot({
        db,
        link: baseLink(),
        outsideGroups: [],
        outsideGroupBreakdowns: [
          {
            committeeKey: "ILLINOIS CONSERVATION ACTION",
            supportOppose: "support",
            categoryType: "donor",
            categoryName: "Sierra Club",
            amount: 1000,
          },
        ],
      })
    ).rejects.toThrow("Illinois outside group breakdowns require outside groups");
    expect(db.connect).not.toHaveBeenCalled();
  });
});
