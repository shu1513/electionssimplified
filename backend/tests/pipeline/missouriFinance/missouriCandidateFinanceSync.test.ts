import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMissouriCandidateFinanceCycleWindow, syncMissouriCandidateFinance } from "../../../src/pipeline/missouriFinance/missouriCandidateFinanceSync.js";
import type { MissouriCandidateFinanceArtifacts } from "../../../src/pipeline/missouriFinance/missouriCandidateFinanceSync.js";

const artifacts: MissouriCandidateFinanceArtifacts = {
  committeeInfo: {
    mecid: "C263985", committeeName: "Jane for Missouri", candidateName: "Jane Doe",
    electionHistory: [
      { electionDate: "2026-11-03", electionType: "General Election", office: "State Representative", politicalSubdivision: "Missouri House" },
      { electionDate: "2026-08-04", electionType: "Primary Election", office: "State Representative", politicalSubdivision: "Missouri House" },
    ],
    sourceUrl: "https://example.test/committee",
  },
  inventory: [{ reportId: "1", report: "8 Day Before General Election", dateFiled: "2026-10-26", isAmended: false, lineageKey: "8 DAY BEFORE GENERAL ELECTION" }],
  contributionRows: [{
    mecid: "C263985", committeeName: "Jane for Missouri", report: "8 Day Before General Election",
    contributorCommittee: null, contributorCompany: null, contributorLastName: "Doe", contributorFirstName: "John",
    employer: null, occupation: "Teacher", contributionDate: "2026-09-01", amountCents: 12500, contributionKind: "Monetary",
  }],
  expenditureRows: [{
    mecid: "C263985", committeeName: "Jane for Missouri", report: "8 Day Before General Election",
    payeeLastName: null, payeeFirstName: null, payeeCompany: "Printer", purpose: "Signs",
    expenditureDate: "2026-10-01", amountCents: 5000, expenditureType: "Paid",
  }],
  contributionSourceUrl: "https://example.test/contributions",
  expenditureSourceUrl: "https://example.test/expenditures",
};

afterEach(() => vi.unstubAllEnvs());

function receiptSyncInput() {
  const source = { ...artifacts, contributionRows: [{ ...artifacts.contributionRows[0]!,
    contributorCommittee: "Example Committee", contributorLastName: null, contributorFirstName: null }] };
  return {
    candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
    candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-11-03", officeScope: "state_lower",
    officeName: "State Lower Chamber Legislator", district: "1",
    committee: { committeeId: "C263985", committeeName: "Jane for Missouri", linkSource: "mec_portal" as const },
    artifacts: source, outsideArtifacts: null,
    receiptArtifacts: { committeeInfo: source.committeeInfo, inventory: source.inventory, contributionRows: source.contributionRows,
      contributionSourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx",
      sourceRetrievedAt: "2026-10-15T00:00:00.000Z", sourceSha256: "a".repeat(64), sourceByteSize: 100,
      reportInventorySha256: "b".repeat(64) },
    now: new Date("2026-10-15T01:00:00Z"),
  };
}

function receiptDb() {
  const linkId = "33333333-3333-4333-8333-333333333333";
  const client = { query: vi.fn((sql: unknown) =>
    String(sql).includes("INSERT INTO public.mo_candidate_finance_links") ||
    String(sql).includes("WHERE id=$1::uuid AND election_year=$2 AND committee_id=$3")
      ? Promise.resolve({ rows: [{ id: linkId }], rowCount: 1 })
      : Promise.resolve({ rows: [], rowCount: 0 })), release: vi.fn() };
  return { client, db: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn().mockResolvedValue(client) } };
}

describe("missouriCandidateFinanceSync", () => {
  it.each([false, true])("keeps an operator-disabled manual due link disabled (receipt-only=%s)", async (receiptOnly) => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const input = receiptSyncInput();
    const client = { query: vi.fn(async (sql: unknown) => String(sql).includes("link_source='manual'")
      ? { rows: [{ id: "33333333-3333-4333-8333-333333333333", committee_id: "C263985", link_status: "disabled", election_year: 2026 }], rowCount: 1 }
      : { rows: [], rowCount: 0 }), release: vi.fn() };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
    await expect(syncMissouriCandidateFinance({ ...input, db: db as never,
      committee: { ...input.committee, linkSource: "manual" }, directArtifactsUnavailable: receiptOnly,
    })).rejects.toThrow("operator-disabled manual link");
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some(sql => /(?:INSERT INTO|UPDATE|DELETE FROM) public\.mo_candidate_finance_/.test(sql))).toBe(false);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("writes qualified receipts alone after unrelated expenditure data fails", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const input = receiptSyncInput();
    input.artifacts.expenditureRows = [{ ...artifacts.expenditureRows[0]!, expenditureType: "Unknown source kind" }];
    const { db, client } = receiptDb();
    const result = await syncMissouriCandidateFinance({ ...input, db: db as never });
    expect(result).toMatchObject({ summaryWritten: false, directBreakdownsWritten: 0, aggregation: null,
      committeeReceiptGroupsWritten: 1, committeeMonetaryReceipts: { status: "qualified", totalAmountCents: 12500 } });
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some(sql => sql.includes("INSERT INTO public.mo_candidate_finance_committee_receipts"))).toBe(true);
    expect(statements.some(sql => /(?:INSERT INTO|UPDATE|DELETE FROM) public\.mo_candidate_finance_(?:summaries|direct_breakdowns|outside_groups|outside_group_breakdowns)\b/.test(sql))).toBe(false);
    expect(statements.filter(sql => sql === "BEGIN")).toHaveLength(1);
    expect(statements).toContain("COMMIT");
  });

  it("shares the protected transaction when direct and receipt sources both qualify", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const { db, client } = receiptDb();
    const result = await syncMissouriCandidateFinance({ ...receiptSyncInput(), db: db as never });
    expect(result).toMatchObject({ summaryWritten: true, committeeReceiptGroupsWritten: 1 });
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter(sql => sql === "BEGIN")).toHaveLength(1);
    expect(statements.some(sql => sql.includes("INSERT INTO public.mo_candidate_finance_summaries"))).toBe(true);
    expect(statements.some(sql => sql.includes("INSERT INTO public.mo_candidate_finance_committee_receipts"))).toBe(true);
  });

  it("dry-runs a receipt-only acquisition without loading stale direct money or writing", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const db = { query: vi.fn(), connect: vi.fn() };
    const result = await syncMissouriCandidateFinance({ ...receiptSyncInput(), db: db as never,
      directArtifactsUnavailable: true, dryRun: true });
    expect(result).toMatchObject({ aggregation: null, committeeReceiptGroupsWritten: 0,
      committeeMonetaryReceipts: { status: "qualified", totalAmountCents: 12500 } });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("starts the general cycle the day after the same-year primary", () => {
    expect(resolveMissouriCandidateFinanceCycleWindow({ electionDate: "2026-11-03", committeeInfo: artifacts.committeeInfo })).toEqual({
      cycleStart: "2026-08-05", cycleEnd: "2026-11-03", primaryElectionDate: "2026-08-04",
    });
  });

  it("fails closed when MEC history cannot prove the primary/general boundary", () => {
    expect(() => resolveMissouriCandidateFinanceCycleWindow({
      electionDate: "2026-11-03",
      committeeInfo: { ...artifacts.committeeInfo, electionHistory: artifacts.committeeInfo.electionHistory.slice(0, 1) },
    })).toThrow("no matching same-year primary boundary");
  });

  it("ignores an unrelated same-year primary when resolving the cycle boundary", () => {
    expect(resolveMissouriCandidateFinanceCycleWindow({
      electionDate: "2026-11-03",
      committeeInfo: {
        ...artifacts.committeeInfo,
        electionHistory: [
          artifacts.committeeInfo.electionHistory[0]!,
          { electionDate: "2026-09-01", electionType: "Primary Election", office: "State Representative", politicalSubdivision: "Missouri State Senate" },
          { electionDate: "2026-08-15", electionType: "Primary Election", office: "State Senator", politicalSubdivision: "Missouri House" },
          artifacts.committeeInfo.electionHistory[1]!,
        ],
      },
    })).toMatchObject({ cycleStart: "2026-08-05", primaryElectionDate: "2026-08-04" });
  });

  it("builds a dry-run direct snapshot from cache data without DB writes", async () => {
    const query = vi.fn();
    const result = await syncMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      candidateId: "11111111-1111-4111-8111-111111111111",
      electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-11-03",
      officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator", district: "1",
      committee: { committeeId: "C263985", committeeName: "Jane for Missouri", linkSource: "mec_portal" },
      artifacts, outsideArtifacts: null, dryRun: true, now: new Date("2026-08-19T00:00:00Z"),
    });
    expect(result).toMatchObject({ dryRun: true, cycleStart: "2026-08-05", cycleEnd: "2026-11-03", summaryWritten: false });
    expect(result.aggregation).toMatchObject({ directContributionTotal: 125, totalDisbursements: 50 });
    expect(result.outsideSpending).toBeNull();
    expect(result.outsideSpendingSkippedReason).toBe("yearly outside-spending artifact unavailable");
    expect(query).not.toHaveBeenCalled();
  });

  it("builds outside totals and organizational funders from exact MECID artifacts", async () => {
    const query = vi.fn();
    const result = await syncMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      candidateId: "11111111-1111-4111-8111-111111111111",
      electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-11-03",
      officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "1",
      committee: { committeeId: "C263985", committeeName: "Jane for Missouri", linkSource: "mec_portal" },
      artifacts,
      outsideArtifacts: {
        rows: [{
          candidateNameAndAddress: "Jane A Doe 10 Private St", officeSought: "District 1 Missouri House of Representatives",
          supportOppose: "Support", expenditureDate: "2026-10-20", amountCents: 250_00,
          reportingCommittee: "Example PAC", report: "8 Day Before General Election-11/3/2026",
        }, {
          candidateNameAndAddress: "Jane A Doe 10 Private St", officeSought: "District 1 Missouri House of Representatives",
          supportOppose: "Oppose", expenditureDate: "2026-10-21", amountCents: 75_00,
          reportingCommittee: "Unresolved PAC", report: "8 Day Before General Election-11/3/2026",
        }],
        identities: [
          { reportingCommittee: "Example PAC", mecid: "C123456" },
          { reportingCommittee: "Unresolved PAC", mecid: null },
        ],
        sourceUrl: "https://example.test/outside",
      },
      outsideSpenderArtifactsByMecid: new Map([["C123456", {
        inventory: [{
          reportId: "2", report: "October Quarterly Report", dateFiled: "2026-10-15",
          isAmended: false, lineageKey: "OCTOBER QUARTERLY REPORT",
        }],
        contributionRows: [{
          mecid: "C123456", committeeName: "Example PAC", report: "October Quarterly Report",
          contributorCommittee: null, contributorCompany: "Teamsters Local 1", contributorLastName: null,
          contributorFirstName: null, employer: null, occupation: null, contributionDate: "2026-09-01",
          amountCents: 100_00, contributionKind: "Monetary",
        }],
        sourceUrl: "https://example.test/contributions",
      }]]),
      dryRun: true,
    });
    expect(result).toMatchObject({
      outsideSupportTotal: 250, outsideOpposeTotal: 0,
      outsideSpending: {
        attributedRowCount: 1, attributedAmount: 250,
        unresolvedSpenderRowCount: 1, unresolvedSpenderAmount: 75,
      },
      outsideFunders: { includedContributionRowCount: 1, reportDiagnostics: [] },
      outsideSpendingSkippedReason: null, outsideFundersSkippedReason: null,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("persists rule-classified outside industries after uncapped donor aggregation", async () => {
    const linkId = "33333333-3333-4333-8333-333333333333";
    const client = {
      query: vi.fn((sql: unknown) => String(sql).includes("INSERT INTO public.mo_candidate_finance_links")
        ? Promise.resolve({ rows: [{ id: linkId }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn().mockResolvedValue(client) };
    const result = await syncMissouriCandidateFinance({
      db: db as never,
      candidateId: "11111111-1111-4111-8111-111111111111",
      electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-11-03",
      officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "1",
      committee: { committeeId: "C263985", committeeName: "Jane for Missouri", linkSource: "mec_portal" },
      artifacts,
      outsideArtifacts: {
        rows: [{
          candidateNameAndAddress: "Jane Doe 10 Private St", officeSought: "State Representative",
          supportOppose: "Support", expenditureDate: "2026-10-20", amountCents: 250_00,
          reportingCommittee: "Example PAC", report: "8 Day Before General Election",
        }],
        identities: [{ reportingCommittee: "Example PAC", mecid: "C123456" }],
        sourceUrl: "https://example.test/outside",
      },
      outsideSpenderArtifactsByMecid: new Map([["C123456", {
        inventory: [{ reportId: "2", report: "October Quarterly Report", dateFiled: "2026-10-15", isAmended: false, lineageKey: "OCTOBER QUARTERLY REPORT" }],
        contributionRows: [{
          mecid: "C123456", committeeName: "Example PAC", report: "October Quarterly Report",
          contributorCommittee: null, contributorCompany: "Teamsters Local 1", contributorLastName: null,
          contributorFirstName: null, employer: null, occupation: null, contributionDate: "2026-09-01",
          amountCents: 100_00, contributionKind: "Monetary",
        }],
        sourceUrl: "https://example.test/contributions",
      }]]),
    });
    expect(result).toMatchObject({ outsideGroupsWritten: 1, outsideGroupBreakdownsWritten: 2 });
    const breakdownCalls = client.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.mo_candidate_finance_outside_group_breakdowns")
    );
    expect(breakdownCalls).toHaveLength(2);
    expect(breakdownCalls.map((call) => call[1])).toEqual(expect.arrayContaining([
      expect.arrayContaining(["donor", "Teamsters Local 1"]),
      expect.arrayContaining(["industry", "labor_unions"]),
    ]));
    expect(client.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))).toBe(true);
  });

  it("preserves the complete prior outside snapshot when a spender artifact is unavailable", async () => {
    const linkId = "33333333-3333-4333-8333-333333333333";
    const client = {
      query: vi.fn((sql: unknown) => String(sql).includes("INSERT INTO public.mo_candidate_finance_links")
        ? Promise.resolve({ rows: [{ id: linkId }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const result = await syncMissouriCandidateFinance({
      db: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as never,
      candidateId: "11111111-1111-4111-8111-111111111111",
      electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-11-03",
      officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "1",
      committee: { committeeId: "C263985", committeeName: "Jane for Missouri", linkSource: "mec_portal" },
      artifacts,
      outsideArtifacts: {
        rows: [{
          candidateNameAndAddress: "Jane Doe 10 Private St", officeSought: "State Representative",
          supportOppose: "Support", expenditureDate: "2026-10-20", amountCents: 250_00,
          reportingCommittee: "Example PAC", report: "8 Day Before General Election",
        }],
        identities: [{ reportingCommittee: "Example PAC", mecid: "C123456" }],
        sourceUrl: "https://example.test/outside",
      },
      refreshOutsideSpenderArtifacts: vi.fn().mockRejectedValue(new Error("spender unavailable")),
    });
    expect(result).toMatchObject({
      outsideSupportTotal: 250,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      outsideFundersSkippedReason: "spender unavailable",
    });
    const summaryCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.mo_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual(expect.arrayContaining([null]));
    expect(summaryCall?.[1]?.[6]).toBeNull();
    expect(summaryCall?.[1]?.[7]).toBeNull();
    expect(client.query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO public.mo_candidate_finance_outside_groups") ||
      String(call[0]).includes("DELETE FROM public.mo_candidate_finance_outside_groups") ||
      String(call[0]).includes("mo_candidate_finance_outside_group_breakdowns")
    )).toBe(false);
  });

  it("refuses to publish a partial snapshot when an in-cycle amendment is ambiguous", async () => {
    const april = "April Quarterly Report";
    const ambiguous: MissouriCandidateFinanceArtifacts = {
      ...artifacts,
      inventory: [
        { reportId: "1", report: april, dateFiled: "2026-09-01", isAmended: false, lineageKey: april.toUpperCase() },
        { reportId: "2", report: `AMENDED ${april}`, dateFiled: "2026-09-02", isAmended: true, lineageKey: april.toUpperCase() },
      ],
      contributionRows: [
        { ...artifacts.contributionRows[0]!, report: april, amountCents: 30000 },
        { ...artifacts.contributionRows[0]!, report: `AMENDED ${april}`, amountCents: 12500, contributionKind: "In-Kind" },
      ],
      expenditureRows: [],
    };
    const query = vi.fn();
    await expect(syncMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-11-03", officeScope: "state_lower",
      officeName: "State Lower Chamber Legislator",
      committee: { committeeId: "C263985", committeeName: "Jane for Missouri", linkSource: "mec_portal" },
      artifacts: ambiguous,
    })).rejects.toThrow("in-cycle report lineage is not publishable");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects local no-primary cycles before reading or writing finance data", async () => {
    const query = vi.fn();
    await expect(syncMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
      candidateName: "Jane Doe", electionYear: 2026, electionDate: "2026-04-07", officeScope: "school_unified",
      officeName: "School Board Member",
      committee: { committeeId: "C263985", committeeName: "Jane for School Board", linkSource: "mec_portal" },
      artifacts,
    })).rejects.toThrow("does not support office cycle school_unified::School Board Member");
    expect(query).not.toHaveBeenCalled();
  });
});
