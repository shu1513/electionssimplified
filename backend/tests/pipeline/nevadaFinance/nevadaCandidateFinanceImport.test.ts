import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSource: vi.fn(),
  readContributions: vi.fn(),
  readExpenses: vi.fn(),
  readReports: vi.fn(),
  readReportHtml: vi.fn(),
  readRoster: vi.fn(),
  directAggregate: vi.fn(),
  parseSummary: vi.fn(),
  writer: vi.fn(),
}));
vi.mock(
  "../../../src/pipeline/nevadaFinance/nevadaReportSummary.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/pipeline/nevadaFinance/nevadaReportSummary.js")
    >()),
    parseNevadaCandidateReportSummary: mocks.parseSummary,
  }),
);
vi.mock(
  "../../../src/pipeline/nevadaFinance/nevadaCommitteeDonorObservation.js",
  () => ({ readNevadaCommitteeDonorObservation: mocks.readSource }),
);
vi.mock(
  "../../../src/pipeline/nevadaFinance/nevadaAuroraArtifacts.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/pipeline/nevadaFinance/nevadaAuroraArtifacts.js")
    >()),
    readNevadaMonthlyContributions: mocks.readContributions,
    readNevadaMonthlyExpenditures: mocks.readExpenses,
    readNevadaCandidateReportsArtifact: mocks.readReports,
    readNevadaReportHtmlArtifact: mocks.readReportHtml,
    readNevadaRosterArtifact: mocks.readRoster,
  }),
);
vi.mock(
  "../../../src/pipeline/nevadaFinance/nevadaDirectContributionAggregator.js",
  () => ({ aggregateNevadaDirectContributions: mocks.directAggregate }),
);
vi.mock("../../../src/pipeline/nevadaFinance/nevadaFinanceWriter.js", () => ({
  replaceNevadaCandidateFinanceSnapshot: mocks.writer,
}));

import { importNevadaCandidateFinance } from "../../../src/pipeline/nevadaFinance/nevadaCandidateFinanceImport.js";
import type { readNevadaCommitteeDonorObservation } from "../../../src/pipeline/nevadaFinance/nevadaCommitteeDonorObservation.js";

const candidateId = "652d73f3-cacf-4f7e-9ada-4e3d81c3badc",
  electionId = "b08a5a3c-dc06-4a60-b881-2aee1faab725";
const publicSource =
  "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx";
function source(): Awaited<
  ReturnType<typeof readNevadaCommitteeDonorObservation>
> {
  return {
    filerName: "Alexis M Hansen",
    sourceOffice: "State Assembly, District 32",
    electionYear: 2026,
    manifestRows: [],
    cashRowCount: 20,
    cashCents: 4133334,
    reportCount: 3,
    pacDonorSource: {
      observedAt: new Date("2026-10-12T17:00:00.000Z"),
      periodStart: "2025-01-01",
      periodEnd: "2026-06-30",
      captureDigest: "a".repeat(64),
    },
    pacDonors: [
      {
        committeeId: "reported:EXAMPLE PAC",
        committeeName: "Example PAC",
        totalAmount: 9000,
        contributionCount: 2,
        recognitionMethod: "reported_name",
        sourceUrl: publicSource,
      },
    ],
    warnings: ["Reported names; no legal ID inferred"],
  };
}
function link(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: candidateId,
    election_id: electionId,
    election_year: 2026,
    candidate_name_normalized: "ALEXIS HANSEN",
    office_name: "State Lower Chamber Legislator",
    district: "Assembly District 32 (2024); Nevada",
    filer_key: "ALEXIS M HANSEN",
    filer_name: "Alexis M Hansen",
    link_status: "active",
    link_source: "manual",
    source_url: publicSource,
    canonical_candidate_name: "Alexis Hansen",
    office_scope: "state_lower",
    office_canonical_name: "State Lower Chamber Legislator",
    district_name: "Assembly District 32 (2024); Nevada",
    canonical_state: "NV",
    canonical_status: "declared",
    canonical_stage: "general",
    candidate_deleted_at: null,
    candidate_merged_into: null,
    ...overrides,
  };
}
function db(rows: unknown[] = [link()]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    connect: vi
      .fn()
      .mockRejectedValue(
        new Error("Real writer/database connection forbidden in boundary test"),
      ),
  };
}
function input(database = db(), write = true) {
  return {
    db: database,
    artifactDir: "unused-monthly-artifacts",
    electionDate: "2026-11-03",
    write,
    onlyFiler: "Alexis M Hansen",
    committeeDonorArtifactPath: "restricted-source-observation.json",
  };
}
function expectNoLegacySource() {
  for (const mock of [
    mocks.readContributions,
    mocks.readExpenses,
    mocks.readReports,
    mocks.readReportHtml,
    mocks.readRoster,
    mocks.directAggregate,
  ])
    expect(mock).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSource.mockResolvedValue(source());
  mocks.writer.mockResolvedValue({ pacDonorsWritten: 1 });
  for (const mock of [
    mocks.readContributions,
    mocks.readExpenses,
    mocks.readReports,
    mocks.readReportHtml,
    mocks.readRoster,
    mocks.directAggregate,
  ])
    mock.mockImplementation(() => {
      throw new Error("Legacy direct machinery must not run");
    });
});

describe("Nevada donor-only artifact import boundary (mocked decoded source)", () => {
  it("writes only the donor component through one exact existing active manual link", async () => {
    const database = db();
    const decoded = source();
    mocks.readSource.mockResolvedValue(decoded);
    const result = await importNevadaCandidateFinance(input(database));
    expect(result).toMatchObject({
      electionYear: 2026,
      linkCount: 1,
      monthsLoaded: [],
      importedCount: 1,
      quarantinedCount: 0,
      results: [
        {
          status: "imported",
          pacDonorCount: 1,
          pacDonorAmount: 9000,
          sourcePeriodEnd: "2026-06-30",
        },
      ],
    });
    expect(result.results[0]).not.toHaveProperty("totalReceipts");
    expectNoLegacySource();
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.query.mock.calls[0]?.[1]).toEqual([
      2026,
      "ALEXIS M HANSEN",
      "2026-11-03",
    ]);
    expect(String(database.query.mock.calls[0]?.[0])).toContain(
      "link.link_status = 'active'",
    );
    expect(String(database.query.mock.calls[0]?.[0])).toContain(
      "election.election_date = $3::date",
    );
    expect(mocks.writer).toHaveBeenCalledOnce();
    const write = mocks.writer.mock.calls[0]![0];
    expect(Object.keys(write).sort()).toEqual([
      "db",
      "link",
      "pacDonorSource",
      "pacDonors",
    ]);
    expect(write.pacDonors).toEqual(decoded.pacDonors);
    expect(write.pacDonorSource).toEqual(decoded.pacDonorSource);
    expect(write.link).toMatchObject({
      candidateId,
      electionId,
      electionYear: 2026,
      linkSource: "manual",
      filerName: "Alexis M Hansen",
    });
    for (const key of [
      "summary",
      "directBreakdowns",
      "outsideGroups",
      "outsideGroupBreakdowns",
    ])
      expect(write).not.toHaveProperty(key);
  });
  it("dry run exercises the same source/link guards but never calls the writer", async () => {
    const database = db();
    const result = await importNevadaCandidateFinance(input(database, false));
    expect(result.importedCount).toBe(0);
    expect(result.results[0]?.status).toBe("dry_run_ok");
    expect(database.query).toHaveBeenCalledOnce();
    expect(mocks.writer).not.toHaveBeenCalled();
    expectNoLegacySource();
  });
  it.each([
    { rows: [] },
    {
      rows: [
        link(),
        link({ candidate_id: "11111111-1111-4111-8111-111111111111" }),
      ],
    },
  ])(
    "does not choose a receiver from missing/ambiguous links",
    async ({ rows }) => {
      await expect(
        importNevadaCandidateFinance(input(db(rows))),
      ).rejects.toThrow("one existing active receiving link");
      expect(mocks.writer).not.toHaveBeenCalled();
      expectNoLegacySource();
    },
  );
  it.each([
    { canonical_candidate_name: "Jane Smith" },
    { canonical_state: "CA" },
    { canonical_status: "withdrawn" },
    { canonical_status: "lost" },
    { canonical_stage: "primary" },
    { canonical_stage: null },
    { candidate_deleted_at: new Date("2026-10-01") },
    { candidate_merged_into: "11111111-1111-4111-8111-111111111111" },
    { office_scope: "state_upper", office_canonical_name: "State Senator" },
    { office_canonical_name: "Governor" },
    { district_name: "Assembly District 33; Nevada" },
  ])(
    "preserves every component on incompatible canonical receiver: %j",
    async (overrides) => {
      await expect(
        importNevadaCandidateFinance(input(db([link(overrides)]))),
      ).rejects.toThrow("candidate/office/seat");
      expect(mocks.writer).not.toHaveBeenCalled();
      expectNoLegacySource();
    },
  );
  it.each([
    "State Senate, District 32",
    "State Assembly, District 31",
    "State Assembly",
    "County Commission District 32",
  ])("rejects wrong/unknown source office-seat %s", async (sourceOffice) => {
    mocks.readSource.mockResolvedValue({ ...source(), sourceOffice });
    await expect(importNevadaCandidateFinance(input())).rejects.toThrow(
      "candidate/office/seat",
    );
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("rejects source year mismatch before looking up or writing links", async () => {
    mocks.readSource.mockResolvedValue({ ...source(), electionYear: 2025 });
    const database = db();
    await expect(importNevadaCandidateFinance(input(database))).rejects.toThrow(
      "requested filer/year",
    );
    expect(database.query).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    expectNoLegacySource();
  });
  it("rejects a requested filer mismatch without silently importing another source", async () => {
    const database = db();
    await expect(
      importNevadaCandidateFinance({
        ...input(database),
        onlyFiler: "Other Person",
      }),
    ).rejects.toThrow("requested filer/year");
    expect(database.query).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    expectNoLegacySource();
  });
  it("source decoder failure never falls back to monthly or direct snapshots", async () => {
    mocks.readSource.mockRejectedValue(new Error("Source incomplete"));
    const database = db();
    await expect(importNevadaCandidateFinance(input(database))).rejects.toThrow(
      "Source incomplete",
    );
    expect(database.query).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    expectNoLegacySource();
  });
  it("writer failure escapes rather than reporting a donor import or performing legacy writes", async () => {
    mocks.writer.mockRejectedValue(new Error("Atomic donor write failed"));
    await expect(importNevadaCandidateFinance(input())).rejects.toThrow(
      "Atomic donor write failed",
    );
    expectNoLegacySource();
  });
  it("passes a verified empty donor component and source watermark without touching direct figures", async () => {
    mocks.readSource.mockResolvedValue({ ...source(), pacDonors: [] });
    const result = await importNevadaCandidateFinance(input());
    expect(result.results[0]).toMatchObject({
      pacDonorCount: 0,
      pacDonorAmount: 0,
    });
    expect(mocks.writer.mock.calls[0]?.[0]).toMatchObject({
      pacDonors: [],
      pacDonorSource: source().pacDonorSource,
    });
    expect(mocks.writer.mock.calls[0]?.[0]).not.toHaveProperty("summary");
    expectNoLegacySource();
  });
});

describe("Nevada direct import with a negative ending fund balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  function cycleSummary(balanceCents: number) {
    const zero = { periodCents: 0, cumulativeCents: null };
    return {
      lines: {
        1: { periodCents: 100_000, cumulativeCents: null },
        2: zero, 3: zero, 4: zero, 5: zero, 6: zero, 7: zero,
        8: { periodCents: 100_000, cumulativeCents: null },
        9: { periodCents: 500_000, cumulativeCents: null },
        10: zero, 11: zero,
        12: { periodCents: 500_000, cumulativeCents: null },
      },
      endingFundBalanceCents: balanceCents,
      filedOn: null,
    };
  }
  function directInput(write: boolean) {
    mocks.readReports.mockResolvedValue({
      name: "Alexis M Hansen",
      detailToken: "token",
      reportRows: [
        { reportName: "CE Report 3", year: 2026, fileDate: "2026-10-15", office: "State Assembly, District 32", syn: "ce3" },
      ],
    });
    mocks.readReportHtml.mockResolvedValue("<html>report</html>");
    mocks.parseSummary.mockReturnValue(cycleSummary(-400_000));
    mocks.readContributions.mockResolvedValue({ rows: [], monthsLoaded: ["2026-07", "2026-08", "2026-09"], fileCount: 3 });
    mocks.readExpenses.mockResolvedValue({
      rows: [
        { payeeName: "Printer", date: "2026-08-01", amountCents: 500_000, transactionType: "Monetary Expense", filerName: "Alexis M Hansen", filerKey: "ALEXIS M HANSEN", reportName: "2026 CE Report 3", isLegalDefenseFund: false },
      ],
      monthsLoaded: ["2026-07", "2026-08", "2026-09"],
      fileCount: 3,
    });
    mocks.directAggregate.mockReturnValue({ directContributionTotalCents: 100_000, directBreakdowns: [], foreignReportYearRowCount: 0 });
    mocks.writer.mockResolvedValue(undefined);
    return { db: db(), artifactDir: "unused", electionDate: "2026-11-03", write };
  }
  it("imports the reconciled totals with cash on hand unknown and a warning", async () => {
    const report = await importNevadaCandidateFinance(directInput(true) as never);
    expect(report.importedCount).toBe(1);
    expect(report.quarantinedCount).toBe(0);
    const [result] = report.results;
    expect(result.status).toBe("imported");
    expect(result.cashOnHand).toBeNull();
    expect(result.totalReceipts).toBe(1000);
    expect(result.totalDisbursements).toBe(5000);
    expect(result.warnings).toContain("negative ending fund balance -400000 cents stored as unknown cash on hand");
    expect(mocks.writer).toHaveBeenCalledTimes(1);
    const [call] = mocks.writer.mock.calls[0] as [{ summary: { cashOnHand: number | null; totalReceipts: number } }];
    expect(call.summary.cashOnHand).toBeNull();
    expect(call.summary.totalReceipts).toBe(1000);
  });
  it("dry run reports the same unknown cash without writing", async () => {
    const report = await importNevadaCandidateFinance(directInput(false) as never);
    expect(report.results[0].status).toBe("dry_run_ok");
    expect(report.results[0].cashOnHand).toBeNull();
    expect(mocks.writer).not.toHaveBeenCalled();
  });
});
