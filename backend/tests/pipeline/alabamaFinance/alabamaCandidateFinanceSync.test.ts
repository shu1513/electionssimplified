import { describe, expect, it, vi } from "vitest";

import type {
  AlabamaCommitteeSearchRow,
  AlabamaRaceRow,
} from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";
import type { AlabamaCashRow } from "../../../src/pipeline/alabamaFinance/alabamaFcpaCsv.js";
import type { AlabamaCommitteeCycleCovers } from "../../../src/pipeline/alabamaFinance/alabamaCommitteeCycleCovers.js";
import {
  alabamaBucketExtractYears,
  syncAlabamaCandidateFinance,
} from "../../../src/pipeline/alabamaFinance/alabamaCandidateFinanceSync.js";

const LINK_ID = "33333333-3333-4333-8333-333333333333";

function raceRow(overrides: Partial<AlabamaRaceRow>): AlabamaRaceRow {
  return {
    COMMITTEEID: 7962,
    CANDIDATE: "Doug Jones",
    CANDIDATESTATUS: "Active",
    BEGINNINGFUNDS: 0,
    MONETARYCONTRIB: 100,
    MONETARYEXP: 40,
    NONMONETARYCONTRIB: 5,
    OTHERSOURCES: 20,
    ENDINGFUNDS: 85,
    YEAR: null,
    ...overrides,
  };
}

function cashRow(overrides: Partial<AlabamaCashRow>): AlabamaCashRow {
  return {
    committeeId: "32837",
    amountCents: 10_000,
    contributionDate: "2026-03-01",
    lastName: "Smith",
    firstName: "Ann",
    contributionId: "1",
    filedDate: "2026-03-02",
    contributionType: "Cash (Itemized)",
    contributorType: "Individual",
    committeeType: "Principal Campaign Committee",
    committeeName: "Friends of Jones",
    candidateName: "Doug Jones",
    amended: "N",
    ...overrides,
  };
}

function writingDb() {
  const client = {
    query: vi.fn((sql: unknown) => {
      if (String(sql).includes("INSERT INTO public.al_candidate_finance_links")) {
        return Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
  return { db, client };
}

function officeContext(rows: AlabamaRaceRow[]) {
  return vi.fn(async () => ({
    raceRows: rows,
    committeeRowsByInternalId: new Map<number, AlabamaCommitteeSearchRow>(),
  }));
}

function cashLoader(rowsByYear: Record<number, AlabamaCashRow[]>) {
  return vi.fn(async (year: number) => ({
    rows: rowsByYear[year] ?? [],
    quarantinedCount: 0,
  }));
}

// Window covers consistent with raceRow(): cash 100 + in-kind 5 + other 20,
// spent 40, and opening 0 + 100 + 20 - 40 = 80 + ... = ENDINGFUNDS 85 only
// with opening balance 5 (the identity check below).
function coversLoader(overrides: Partial<AlabamaCommitteeCycleCovers> = {}) {
  return vi.fn(async (_internalCommitteeId: number, windowStart: string) => ({
    windowStart,
    filingCount: 3,
    windowFilingCount: 2,
    cashCents: 10_000,
    inKindCents: 500,
    otherCents: 2_000,
    expenditureCents: 4_000,
    openingBalanceCents: 500,
    latestEndingBalanceCents: 8_500,
    ...overrides,
  }));
}

function baseInput(db: { query: unknown; connect: unknown }) {
  return {
    loadCycleCovers: coversLoader(),
    db: db as never,
    candidateId: "candidate-1",
    electionId: "election-1",
    candidateName: "Doug Jones",
    electionYear: 2026,
    officeScope: "statewide",
    officeName: "Governor",
    ballotTitle: "Governor",
    district: null,
    link: {
      internalCommitteeId: 7962,
      committeeName: "Doug Jones",
      fcpaCommitteeNumber: "32837" as string | null,
      linkSource: "fcpa_race_search" as const,
      sourceUrl: "https://fcpa.alabamavotes.gov/",
    },
    now: new Date("2026-09-01T00:00:00Z"),
  };
}

describe("alabamaBucketExtractYears", () => {
  it("spans the term-length cycle, clamped to the first extract year", () => {
    expect(alabamaBucketExtractYears(2026, 4)).toEqual([2023, 2024, 2025, 2026]);
    // Alabama appellate judges serve six-year terms.
    expect(alabamaBucketExtractYears(2026, 6)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(alabamaBucketExtractYears(2014, 4)).toEqual([2013, 2014]);
  });
});

describe("syncAlabamaCandidateFinance", () => {
  it("writes accepted PAC cash as a subset without changing current-cover Raised", async () => {
    const { db, client } = writingDb();
    const loadPacDonors = vi.fn(async () => ({
      pacDonors: [{ committeeId: "24906", committeeName: "Electric Cooperatives of Alabama PAC",
        committeeType: "Political Action Committee" as const, amount: 50, contributionCount: 1,
        sourceUrl: "https://fcpa.alabamavotes.gov/" }], diagnostics: [],
    }));
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db), loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }), loadPacDonors,
    });
    expect(result).toMatchObject({ totalReceipts: 125, directContributionTotal: 105,
      pacDonorsAccepted: true, pacDonorsWritten: 1, pacDonorAmount: 50, pacDiagnostics: [] });
    expect(loadPacDonors).toHaveBeenCalledWith({ internalCommitteeId: 7962, fcpaCommitteeNumber: "32837",
      windowStart: "2023-01-01", windowEnd: "2026-12-31", extractYears: [2023, 2024, 2025, 2026],
      coversCashCents: 10_000, authoritativeCoverCount: 2 });
    const donor = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.al_candidate_finance_pac_donors"));
    expect(donor?.[1]).toContain(50);
    const summary = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.al_candidate_finance_summaries"));
    expect(summary?.[1]?.[2]).toBe(125);
  });

  it("preserves prior PAC data after source failure while still refreshing independent direct totals", async () => {
    const { db, client } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db), loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
      loadPacDonors: vi.fn(async () => { throw new Error("Current source changed"); }),
    });
    expect(result).toMatchObject({ totalReceipts: 125, summaryWritten: true,
      pacDonorsAccepted: false, pacDonorsWritten: 0, pacDonorAmount: null });
    expect(result.pacDiagnostics).toEqual(["pac_source_unavailable: Current source changed"]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("al_candidate_finance_pac_donors"))).toBe(false);
  });

  it("clears PAC rows only for an independently accepted empty component", async () => {
    const { db, client } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db), loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
      loadPacDonors: vi.fn(async () => ({ pacDonors: [], diagnostics: [] })),
    });
    expect(result).toMatchObject({ totalReceipts: 125, pacDonorsAccepted: true,
      pacDonorsWritten: 0, pacDonorAmount: 0 });
    const cleanup = client.query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM public.al_candidate_finance_pac_donors"));
    expect(cleanup?.[1]?.[2]).toEqual([]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM public.al_candidate_finance_outside"))).toBe(false);
  });

  it("reports accepted donor coverage on dry run without changing the database", async () => {
    const { db } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db), dryRun: true, loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
      loadPacDonors: vi.fn(async () => ({ pacDonors: [{ committeeId: "24906", committeeName: "Some PAC",
        committeeType: "Political Action Committee" as const, amount: 50, contributionCount: 1,
        sourceUrl: "https://fcpa.alabamavotes.gov/" }], diagnostics: [] })),
    });
    expect(result).toMatchObject({ totalReceipts: 125, pacDonorsAccepted: true,
      pacDonorAmount: 50, pacDonorsWritten: 0, summaryWritten: false });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("writes the race-row summary and coverage-passing buckets", async () => {
    const { db, client } = writingDb();
    const loadCashRows = cashLoader({ 2026: [cashRow({})] });
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows,
    });
    expect(result).toMatchObject({
      status: "synced",
      totalReceipts: 125,
      directContributionTotal: 105,
      totalDisbursements: 40,
      cashOnHand: 85,
      cycleWindowStart: "2023-01-01",
      coverFilingCount: 2,
      raceRowTotalReceipts: 125,
      summaryDiagnostics: [],
      coverageRatio: 1,
      bucketDiagnostics: [],
      summaryWritten: true,
      bucketsWritten: 1,
    });
    expect(loadCashRows).toHaveBeenCalledTimes(4);
    const summaryInsert = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.al_candidate_finance_summaries")
    );
    expect(summaryInsert).toBeDefined();
    const breakdownInsert = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.al_candidate_finance_direct_breakdowns")
    );
    expect(breakdownInsert).toBeDefined();
  });

  it("dry run computes without touching the database", async () => {
    const { db, client } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      dryRun: true,
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    expect(result).toMatchObject({ dryRun: true, summaryWritten: false, bucketsWritten: 0 });
    expect(db.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("handles a yearly extract larger than the spread-argument limit", async () => {
    // Live 2026-09-01: the 2025 cash extract has 120,501 rows and the 2026
    // one 117,300; push(...rows) overflowed the call stack and gated every
    // candidate's buckets off with artifact_unavailable.
    const { db } = writingDb();
    const filler: AlabamaCashRow[] = [];
    for (let index = 0; index < 200_000; index += 1) {
      filler.push(cashRow({ committeeId: "1", contributionId: String(index) }));
    }
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      dryRun: true,
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2025: filler, 2026: [cashRow({})] }),
    });
    expect(result).toMatchObject({ coverageRatio: 1, bucketDiagnostics: [] });
  });

  it("takes the summary from window covers, not the race row's lifetime aggregate", async () => {
    // Live 2026-09-01: an incumbent's race row showed $655,220.53 raised while
    // the 2026-cycle covers summed to $171,102.00 (the race aggregate lumps in
    // every untagged annual/major report since 2014).
    const { db } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      loadOfficeRaceContext: officeContext([
        raceRow({ MONETARYCONTRIB: 655_220.53, MONETARYEXP: 552_049.08, ENDINGFUNDS: 85 }),
      ]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    expect(result).toMatchObject({
      totalReceipts: 125,
      totalDisbursements: 40,
      cashOnHand: 85,
      raceRowTotalReceipts: 655_245.53,
      summaryDiagnostics: [],
      coverageRatio: 1,
      bucketsWritten: 1,
    });
  });

  it("reports a cash-on-hand identity miss and an empty window without failing", async () => {
    const { db } = writingDb();
    const mismatch = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      dryRun: true,
      loadCycleCovers: coversLoader({ openingBalanceCents: 0 }),
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    expect(mismatch.summaryDiagnostics).toEqual([
      "cash_on_hand_identity_mismatch: window implies 80.00, race row 85.00",
    ]);
    const empty = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      dryRun: true,
      loadCycleCovers: coversLoader({
        windowFilingCount: 0,
        cashCents: 0,
        inKindCents: 0,
        otherCents: 0,
        expenditureCents: 0,
        openingBalanceCents: null,
        latestEndingBalanceCents: null,
      }),
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({}),
    });
    expect(empty).toMatchObject({
      totalReceipts: 0,
      totalDisbursements: 0,
      cashOnHand: 85,
      summaryDiagnostics: ["no_filings_in_window:2023-01-01"],
    });
  });

  it("stores a null cash on hand for an overdrawn committee and says so", async () => {
    const { db } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      // -125.90 + 100 + 20 - 40 = -45.90: identity holds, only the sign trips.
      loadCycleCovers: coversLoader({ openingBalanceCents: -12_590 }),
      loadOfficeRaceContext: officeContext([raceRow({ ENDINGFUNDS: -45.9 })]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    expect(result).toMatchObject({
      cashOnHand: null,
      summaryWritten: true,
      summaryDiagnostics: ["cash_on_hand_negative_not_stored: -45.90"],
    });
  });

  it("replaces a stored cash on hand with null instead of preserving the old balance", async () => {
    const { db, client } = writingDb();
    await syncAlabamaCandidateFinance({
      ...baseInput(db),
      loadCycleCovers: coversLoader({ openingBalanceCents: -12_590 }),
      loadOfficeRaceContext: officeContext([raceRow({ ENDINGFUNDS: -45.9 })]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    const summaryUpsert = client.query.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes("INSERT INTO public.al_candidate_finance_summaries"));
    expect(summaryUpsert).toBeDefined();
    expect(summaryUpsert).toContain("cash_on_hand = EXCLUDED.cash_on_hand");
    expect(summaryUpsert).not.toContain("COALESCE(EXCLUDED.cash_on_hand");
  });

  it("throws and writes nothing when the covers cannot be loaded", async () => {
    const { db, client } = writingDb();
    await expect(
      syncAlabamaCandidateFinance({
        ...baseInput(db),
        loadCycleCovers: vi.fn(async () => {
          throw new Error("filing 52634 cover unavailable after 3 attempts");
        }),
        loadOfficeRaceContext: officeContext([raceRow({})]),
        loadCashRows: cashLoader({ 2026: [cashRow({})] }),
      })
    ).rejects.toThrow("cover unavailable");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("throws and writes nothing when the race row is missing", async () => {
    const { db, client } = writingDb();
    await expect(
      syncAlabamaCandidateFinance({
        ...baseInput(db),
        loadOfficeRaceContext: officeContext([raceRow({ COMMITTEEID: 1 })]),
        loadCashRows: cashLoader({}),
      })
    ).rejects.toThrow("race row for internal committee id 7962 not found");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("writes the summary with cleared buckets when the FCPA number is missing", async () => {
    const { db } = writingDb();
    const loadCashRows = cashLoader({ 2026: [cashRow({})] });
    const base = baseInput(db);
    const result = await syncAlabamaCandidateFinance({
      ...base,
      link: { ...base.link, fcpaCommitteeNumber: null },
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows,
    });
    expect(result).toMatchObject({
      summaryWritten: true,
      bucketsWritten: 0,
      bucketDiagnostics: ["fcpa_committee_number_missing"],
    });
    expect(loadCashRows).not.toHaveBeenCalled();
  });

  it("self-heals a NULL FCPA number from the committee-search join and persists it", async () => {
    const { db } = writingDb();
    const base = baseInput(db);
    const result = await syncAlabamaCandidateFinance({
      ...base,
      link: { ...base.link, fcpaCommitteeNumber: null },
      loadOfficeRaceContext: vi.fn(async () => ({
        raceRows: [raceRow({})],
        committeeRowsByInternalId: new Map([
          [7962, { id: 7962, committeeId: "32837" } as never],
        ]),
      })),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    expect(result).toMatchObject({
      fcpaCommitteeNumber: "32837",
      bucketDiagnostics: [],
      bucketsWritten: 1,
    });
    const backfill = db.query.mock.calls.find((call) =>
      String(call[0]).includes("SET fcpa_committee_number")
    );
    expect(backfill?.[1]).toEqual(["candidate-1", "election-1", "7962", "32837"]);
  });

  it("uses the six-year window for appellate-court candidates", async () => {
    const { db } = writingDb();
    const loadCashRows = cashLoader({ 2026: [cashRow({})] });
    const base = baseInput(db);
    const result = await syncAlabamaCandidateFinance({
      ...base,
      officeName: "State Level Judge",
      ballotTitle: "Associate Justice of the Alabama Supreme Court, Place 7",
      dryRun: true,
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows,
    });
    expect(result.bucketExtractYears).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(loadCashRows).toHaveBeenCalledTimes(6);
  });

  it("gates buckets off when a window artifact is unreadable, keeping the summary", async () => {
    const { db } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: vi.fn(async (year: number) => {
        if (year === 2024) throw new Error("no cached metadata");
        return { rows: [cashRow({})], quarantinedCount: 0 };
      }),
    });
    expect(result.summaryWritten).toBe(true);
    expect(result.bucketsWritten).toBe(0);
    expect(result.bucketDiagnostics[0]).toContain("artifact_unavailable:2024");
  });

  it("gates buckets off outside the coverage tolerance, keeping the summary", async () => {
    const { db } = writingDb();
    const result = await syncAlabamaCandidateFinance({
      ...baseInput(db),
      loadCycleCovers: coversLoader({ cashCents: 100_000, openingBalanceCents: -89_500 }),
      loadOfficeRaceContext: officeContext([raceRow({})]),
      loadCashRows: cashLoader({ 2026: [cashRow({})] }),
    });
    expect(result.summaryWritten).toBe(true);
    expect(result.totalReceipts).toBe(1_025);
    expect(result.bucketsWritten).toBe(0);
    expect(result.bucketDiagnostics[0]).toContain("cash_coverage_out_of_tolerance");
  });

  it("rejects ineligible offices", async () => {
    const { db } = writingDb();
    await expect(
      syncAlabamaCandidateFinance({
        ...baseInput(db),
        officeScope: "county",
        officeName: "Sheriff",
        loadOfficeRaceContext: officeContext([raceRow({})]),
        loadCashRows: cashLoader({}),
      })
    ).rejects.toThrow("not Alabama-finance eligible");
  });
});
