import { describe, expect, it, vi } from "vitest";

import type { WestVirginiaCommitteeRow, WestVirginiaCurrentFilingRow, WestVirginiaTransactionRow } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";
import {
  parseWestVirginiaContributionCsv,
  parseWestVirginiaExpenditureCsv,
  parseWestVirginiaReportingScheduleCsv,
  type WestVirginiaContributionCsvRow,
  type WestVirginiaExpenditureCsvRow,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsCsv.js";
import {
  syncWestVirginiaCandidateFinance,
  type WestVirginiaFinanceArtifactLoader,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaCandidateFinanceSync.js";

const LINK_ID = "33333333-3333-4333-8333-333333333333";
const ENTITY = "1010003610";

const CON_HEADER =
  "RegistrantID,CommitteeName,CandidateName,TransactionType,TransactionCategory,TransactionDate,TransactionAmount,ContributorPayeeType,ContributorPayeeName,ContributorAddress,EmployerName,FiledDate";
const EXP_HEADER =
  "RegistrantID,CommitteeName,CandidateName,TransactionType,ExpenditureType,ExpenditurePurpose,TransactionDate,TransactionAmount,RecipientType,RecipientName,RecipientAddress,FiledDate";
const REPS_HEADER = "ElectionName,ReportingCycle,ReportingPeriodDescription,FormType,ReportType,BeginDate,Enddate,DueDate";

const SCHEDULES: Record<number, string[]> = {
  2025: ["2026 Election,2026 Candidate Election Cycle,2025 3rd Quarter Report,Campaign Financial Statement,Quarterly,2025-07-01,2025-09-30,2025-10-07"],
  2026: [
    "2026 Election,2026 Candidate Election Cycle,2025 4th Quarter Report,Campaign Financial Statement,Quarterly,2025-10-01,2025-12-31,2026-01-07",
    "2026 Election,2026 Candidate Election Cycle,2026 1st Quarter Report,Campaign Financial Statement,Quarterly,2026-01-01,2026-03-31,2026-04-07",
    "2026 Election,2026 Candidate Election Cycle,2026 General Report,Campaign Financial Statement,General,2026-10-01,2026-10-18,2026-10-23",
  ],
  2027: ["2026 Election,2026 Candidate Election Cycle,2026 4th Quarter Report,Campaign Financial Statement,Quarterly,2026-10-19,2026-12-31,2027-01-07"],
};

const CONTRIBUTIONS: Record<number, string[]> = {
  2025: [`${ENTITY},Committee to Elect Dean Jeffries,Warren Dean Jeffries,Contributions,Monetary,2025-08-15,250.0000,Individual,Ann Early,1 Elm St,Acme Coal,2025-10-07`],
  2026: [
    `${ENTITY},Committee to Elect Dean Jeffries,Warren Dean Jeffries,Contributions,Monetary,2026-03-01,500.0000,Individual,Jane Doe,2 Oak St,Charleston General Hospital,2026-04-07`,
    `${ENTITY},Committee to Elect Dean Jeffries,Warren Dean Jeffries,Contributions,Monetary,2026-03-02,1000.0000,Political Action Committee,WV Realtors PAC,3 Pine St,,2026-04-07`,
    `${ENTITY},Committee to Elect Dean Jeffries,Warren Dean Jeffries,Contributions,Monetary,2026-03-03,3000.0000,Self,Warren Dean Jeffries,4 Ash St,,2026-04-07`,
    `1010009999,Other Committee,Other Person,Contributions,Monetary,2026-03-03,99.0000,Individual,Someone Else,5 Fir St,,2026-04-07`,
  ],
};

const EXPENDITURES: Record<number, string[]> = {
  2025: [],
  2026: [`${ENTITY},Committee to Elect Dean Jeffries,Warren Dean Jeffries,Expenditures,Monetary,Advertising,2026-03-05,120.0000,Business or Organization,Acme Print,6 Elm St,2026-04-07`],
};

function apiRow(overrides: Partial<WestVirginiaTransactionRow>): WestVirginiaTransactionRow {
  return {
    transactionID: 1,
    entityID: ENTITY,
    orgID: 3610,
    committeeName: "Committee to Elect Dean Jeffries",
    candidateName: "Jeffries, Warren Dean",
    transactionAmount: 500,
    transactionDate: "2026-03-01T00:00:00",
    filedDate: "2026-04-07T00:00:00",
    entityTypeDesc: "Individual",
    transactionCategoryDesc: "Monetary",
    transactionTypeDesc: "Contributions",
    transactionPurpose: null,
    contributorPayeeName: "Doe Jane",
    employerName: "Charleston General Hospital",
    employerOccupation: "Healthcare/Medical",
    transactionTotalYTD: null,
    amendedFlag: false,
    reportVersionID: "1",
    reportFileName: null,
    s3ReportFilePath: null,
    stanceDescription: null,
    candidateNameAssocation: null,
    ballotMeasureDescription: null,
    orgType: "State Candidate",
    ...overrides,
  };
}

const API_ROWS: Record<number, WestVirginiaTransactionRow[]> = {
  2025: [apiRow({ transactionID: 10, transactionAmount: 250, transactionDate: "2025-08-15T00:00:00", contributorPayeeName: "Early Ann", employerOccupation: "Retired" })],
  2026: [
    apiRow({ transactionID: 11 }),
    apiRow({ transactionID: 12, transactionAmount: 1000, transactionDate: "2026-03-02T00:00:00", entityTypeDesc: "Political Action Committee", employerOccupation: null }),
    apiRow({ transactionID: 13, transactionAmount: 3000, transactionDate: "2026-03-03T00:00:00", entityTypeDesc: "Self", employerOccupation: null }),
    // A loan row rides along on the CON selector and must not disturb the reconciliation.
    apiRow({ transactionID: 14, transactionAmount: 7000, transactionCategoryDesc: "Loans", transactionTypeDesc: "Loans", entityTypeDesc: "Self" }),
  ],
};

function loader(overrides: Partial<WestVirginiaFinanceArtifactLoader> = {}): WestVirginiaFinanceArtifactLoader {
  const parseCon = (lines: string[]): WestVirginiaContributionCsvRow[] =>
    parseWestVirginiaContributionCsv(`${CON_HEADER}\n${lines.join("\n")}\n`).rows;
  const parseExp = (lines: string[]): WestVirginiaExpenditureCsvRow[] =>
    parseWestVirginiaExpenditureCsv(`${EXP_HEADER}\n${lines.join("\n")}\n`).rows;
  const missing = (label: string, year: number) => Promise.reject(new Error(`West Virginia CFRS artifact ${label} ${year} has no cached metadata`));
  return {
    scheduleRows: vi.fn(async (year: number) =>
      SCHEDULES[year] ? parseWestVirginiaReportingScheduleCsv(`${REPS_HEADER}\n${SCHEDULES[year]!.join("\n")}\n`).rows : missing("reporting_schedules", year)
    ),
    contributionRows: vi.fn(async (year: number) => (CONTRIBUTIONS[year] ? parseCon(CONTRIBUTIONS[year]!) : missing("contributions", year))),
    expenditureRows: vi.fn(async (year: number) => (EXPENDITURES[year] ? parseExp(EXPENDITURES[year]!) : missing("expenditures", year))),
    apiContributionRows: vi.fn(async (year: number) => API_ROWS[year] ?? missing("api_contributions", year)),
    ...overrides,
  };
}

function donorRegistry(): WestVirginiaCommitteeRow[] {
  return [{ orgID: 1234, entityId: "1020001234", orgName: "WV Realtors PAC", candidateName: null,
    orgType: "State Political Action Committee", orgTypeCode: "102", orgSubType: "Regular PAC",
    office: null, district: null, party: null, election: "2018 General Election", registrationYear: "2018", orgStatus: "Active" }];
}

function donorLoader(overrides: Partial<WestVirginiaFinanceArtifactLoader> = {}): WestVirginiaFinanceArtifactLoader {
  return loader({
    registryRows: vi.fn(async () => donorRegistry()),
    // Older money-only fixtures intentionally have an irrelevant donor name. Keep them unchanged.
    apiContributionRows: vi.fn(async (year: number) => API_ROWS[year]!.map((row) =>
      row.transactionID === 12 ? { ...row, contributorPayeeName: "WV Realtors PAC" } : { ...row }
    )),
    ...overrides,
  });
}

function writingDb() {
  const client = {
    query: vi.fn((sql: unknown, _params?: unknown[]) => {
      if (String(sql).includes("INSERT INTO public.wv_candidate_finance_links")) {
        return Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
  return { db, client };
}

function baseInput(db: { query: unknown; connect: unknown }) {
  return {
    db: db as never,
    candidateId: "candidate-1",
    electionId: "election-1",
    candidateName: "Dean Jeffries",
    electionYear: 2026,
    officeScope: "state_lower",
    officeName: "State Lower Chamber Legislator",
    district: "Delegate District 12 (2024); West Virginia",
    link: {
      entityId: ENTITY,
      committeeName: "Committee to Elect Dean Jeffries",
      linkSource: "cfrs_registry" as const,
      sourceUrl: null,
    },
    now: new Date("2026-09-01T00:00:00Z"),
  };
}

describe("syncWestVirginiaCandidateFinance", () => {
  it("resolves the window, reconciles every year, aggregates and writes one snapshot", async () => {
    const { db, client } = writingDb();
    const artifacts = loader();
    const result = await syncWestVirginiaCandidateFinance({ ...baseInput(db), loadArtifacts: artifacts });
    expect(result).toMatchObject({
      status: "synced",
      entityId: ENTITY,
      window: { reportingCycle: "2026 Candidate Election Cycle", windowStart: "2025-07-01", windowEnd: "2026-12-31" },
      windowYears: [2025, 2026],
      totalReceipts: 4750,
      directContributionTotal: 1750,
      totalDisbursements: 120,
      breakdownCounts: { occupation: 2, industry: 1, contribution_size: 2 },
      summaryWritten: true,
      directBreakdownsWritten: 5,
    });
    expect(result.reconciliation).toEqual([
      { year: 2025, csvRowCount: 1, apiRowCount: 1, csvTotalCents: 25_000, apiTotalCents: 25_000, amendedApiRowCount: 0 },
      { year: 2026, csvRowCount: 3, apiRowCount: 3, csvTotalCents: 450_000, apiTotalCents: 450_000, amendedApiRowCount: 0 },
    ]);
    expect(artifacts.scheduleRows).toHaveBeenCalledTimes(3);
    const summaryInsert = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.wv_candidate_finance_summaries")
    );
    expect(summaryInsert).toBeDefined();
    // Unavailable cash/outside source inputs remain NULL; accepted outside snapshots survive the upsert.
    expect(String(summaryInsert?.[0])).toContain("COALESCE(EXCLUDED.outside_support_total");
    expect(String(summaryInsert?.[0])).toContain("COALESCE(EXCLUDED.outside_oppose_total");
    expect(client.query.mock.calls.some(([sql]) => /DELETE FROM public\.wv_candidate_finance_outside_/.test(String(sql)))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("wv_candidate_finance_pac_donors"))).toBe(false);
    expect(result.pacDonorCount).toBeNull();
    expect(result).not.toHaveProperty("pacDonorsWritten");
    expect(summaryInsert?.[1]).toEqual([LINK_ID, 2026, 4750, 1750, 120, null, null, null, "https://cfrs.wvsos.gov/", "2026-09-01T00:00:00.000Z"]);
    const breakdownInserts = client.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.wv_candidate_finance_direct_breakdowns")
    );
    expect(breakdownInserts.map((call) => [call[1]![2], call[1]![3], call[1]![4]])).toEqual([
      ["occupation", "Healthcare/Medical", 500],
      ["occupation", "Retired", 250],
      ["industry", "healthcare", 500],
      ["contribution_size", "$500-$999", 500],
      ["contribution_size", "$250-$499", 250],
    ]);
  });

  it("persists uniquely typed committee donors without adding their money to Raised twice", async () => {
    const { db, client } = writingDb();
    const artifacts = donorLoader();
    const result = await syncWestVirginiaCandidateFinance({ ...baseInput(db), loadArtifacts: artifacts });
    expect(result).toMatchObject({ totalReceipts: 4750, directContributionTotal: 1750, pacDonorCount: 1, pacDonorsWritten: 1 });
    expect(result.committeeDonorReconciliation).toMatchObject([
      { entityId: ENTITY, csvRowCount: 0, apiRowCount: 0, multisetMatch: true },
      { entityId: ENTITY, csvRowCount: 1, apiRowCount: 1, multisetMatch: true },
    ]);
    expect(artifacts.registryRows).toHaveBeenCalledOnce();
    const pacInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_pac_donors"));
    expect(pacInsert?.[1]).toEqual([LINK_ID, 2026, "1020001234", "WV Realtors PAC", "102", 1000, 1, "https://cfrs.wvsos.gov/", "2026-09-01T00:00:00.000Z"]);
    const summaryInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_summaries"));
    expect(summaryInsert?.[1]?.slice(2, 5)).toEqual([4750, 1750, 120]);
    expect(client.query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM public.wv_candidate_finance_pac_donors"))?.[1]).toEqual([LINK_ID, 2026, ["1020001234"]]);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it.each(["registry has no cached metadata", "registry checksum mismatch"])("updates receipts while preserving PAC rows when %s", async (message) => {
    const { db, client } = writingDb();
    const result = await syncWestVirginiaCandidateFinance({ ...baseInput(db), loadArtifacts: donorLoader({ registryRows: vi.fn(async () => { throw new Error(message); }) }) });
    expect(result).toMatchObject({ totalReceipts: 4750, directContributionTotal: 1750, summaryWritten: true, pacDonorCount: null, committeeRegistryError: message });
    expect(result).not.toHaveProperty("pacDonorsWritten");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_summaries"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("wv_candidate_finance_pac_donors"))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => /DELETE FROM public\.wv_candidate_finance_outside_/.test(String(sql)))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it.each([
    { contributorPayeeName: "Amended Donor PAC" },
    { entityTypeDesc: "Political Party Committee / Caucus Campaign Committee" },
    { entityTypeDesc: "Business or Organization" },
  ])("rejects a same-money donor identity amendment before opening a transaction: %j", async (change) => {
    const { db, client } = writingDb();
    const artifacts = donorLoader({ apiContributionRows: vi.fn(async (year: number) => API_ROWS[year]!.map((row) =>
      row.transactionID === 12 ? { ...row, contributorPayeeName: "WV Realtors PAC", reportVersionID: "2", amendedFlag: false, ...change } : { ...row }
    )) });
    await expect(syncWestVirginiaCandidateFinance({ ...baseInput(db), loadArtifacts: artifacts })).rejects.toThrow("Committee donor identities do not reconcile");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("clears PAC rows only after a complete registry and successful empty donor reconciliation", async () => {
    const { db, client } = writingDb();
    const artifacts = donorLoader({
      contributionRows: vi.fn(async (year: number) => parseWestVirginiaContributionCsv(`${CON_HEADER}\n${CONTRIBUTIONS[year]!.filter((line) => !line.includes("Political Action Committee")).join("\n")}\n`).rows),
      apiContributionRows: vi.fn(async (year: number) => API_ROWS[year]!.filter((row) => row.transactionID !== 12)),
    });
    const result = await syncWestVirginiaCandidateFinance({ ...baseInput(db), loadArtifacts: artifacts });
    expect(result).toMatchObject({ directContributionTotal: 750, totalReceipts: 3750, pacDonorCount: 0, pacDonorsWritten: 0 });
    expect(result.committeeDonorReconciliation).toMatchObject([
      { csvRowCount: 0, apiRowCount: 0, multisetMatch: true }, { csvRowCount: 0, apiRowCount: 0, multisetMatch: true },
    ]);
    expect(client.query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM public.wv_candidate_finance_pac_donors"))?.[1]).toEqual([LINK_ID, 2026, []]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_pac_donors"))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("dry run computes without touching the database", async () => {
    const { db, client } = writingDb();
    const result = await syncWestVirginiaCandidateFinance({ ...baseInput(db), dryRun: true, loadArtifacts: loader() });
    expect(result).toMatchObject({ dryRun: true, summaryWritten: false, directBreakdownsWritten: 0, totalReceipts: 4750 });
    expect(db.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("fails closed when the CSV and API rows for a year disagree", async () => {
    const { db, client } = writingDb();
    await expect(
      syncWestVirginiaCandidateFinance({
        ...baseInput(db),
        loadArtifacts: loader({
          apiContributionRows: vi.fn(async (year: number) =>
            year === 2026 ? API_ROWS[2026]!.filter((row) => row.transactionID !== 12) : API_ROWS[year]!
          ),
        }),
      })
    ).rejects.toThrow(/2026 contributions do not reconcile for 1010003610: CSV 3 rows \/ 450000c vs API 2 rows \/ 350000c/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("fails closed when a window year's artifact is not cached", async () => {
    const { db, client } = writingDb();
    await expect(
      syncWestVirginiaCandidateFinance({
        ...baseInput(db),
        loadArtifacts: loader({ expenditureRows: vi.fn(async () => Promise.reject(new Error("no cached metadata"))) }),
      })
    ).rejects.toThrow(/no cached metadata/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("fails closed when a schedule file is missing (the window could be short)", async () => {
    const { db } = writingDb();
    await expect(
      syncWestVirginiaCandidateFinance({
        ...baseInput(db),
        loadArtifacts: loader({
          scheduleRows: vi.fn(async (year: number) => (year === 2027 ? Promise.reject(new Error("no cached metadata")) : [])),
        }),
      })
    ).rejects.toThrow(/no cached metadata/);
  });

  it("fails closed on vocabulary outside the pinned sets", async () => {
    const { db, client } = writingDb();
    await expect(
      syncWestVirginiaCandidateFinance({
        ...baseInput(db),
        loadArtifacts: loader({
          expenditureRows: vi.fn(async (year: number) =>
            year === 2026
              ? parseWestVirginiaExpenditureCsv(
                  `${EXP_HEADER}\n${ENTITY},C,W,Expenditures,Refund,Advertising,2026-03-05,120.0000,Business or Organization,Acme,1 Elm,2026-04-07\n`
                ).rows
              : []
          ),
        }),
      })
    ).rejects.toThrow(/unrecognized values in window for 1010003610: expenditure type "Refund"/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("publishes NULL totals, not $0, for a committee with no rows in the window", async () => {
    const { db, client } = writingDb();
    const base = baseInput(db);
    const result = await syncWestVirginiaCandidateFinance({
      ...base,
      link: { ...base.link, entityId: "1010009998", committeeName: "Late Registrant for House" },
      loadArtifacts: loader(),
    });
    expect(result).toMatchObject({
      status: "synced",
      reportedActivity: false,
      totalReceipts: null,
      directContributionTotal: null,
      totalDisbursements: null,
      breakdownCounts: { occupation: 0, industry: 0, contribution_size: 0 },
      summaryWritten: true,
      directBreakdownsWritten: 0,
    });
    const summaryInsert = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.wv_candidate_finance_summaries")
    );
    expect(summaryInsert?.[1]).toEqual([LINK_ID, 2026, null, null, null, null, null, null, "https://cfrs.wvsos.gov/", "2026-09-01T00:00:00.000Z"]);
    expect(
      client.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.wv_candidate_finance_direct_breakdowns"))
    ).toBe(false);
  });

  it("rejects ineligible offices, bad ids and pre-2026 years before reading anything", async () => {
    const { db } = writingDb();
    const artifacts = loader();
    await expect(
      syncWestVirginiaCandidateFinance({ ...baseInput(db), officeScope: "county", officeName: "Sheriff", loadArtifacts: artifacts })
    ).rejects.toThrow(/not West Virginia-finance eligible/);
    const base = baseInput(db);
    await expect(
      syncWestVirginiaCandidateFinance({ ...base, link: { ...base.link, entityId: "123" }, loadArtifacts: artifacts })
    ).rejects.toThrow(/Invalid West Virginia CFRS entityId/);
    await expect(
      syncWestVirginiaCandidateFinance({ ...base, electionYear: 2024, loadArtifacts: artifacts })
    ).rejects.toThrow(/invalid election year/);
    expect(artifacts.scheduleRows).not.toHaveBeenCalled();
  });
});


// IE fixtures are separate from the direct-money fixtures above. This keeps
// current report evidence and the source's full candidate identity explicit.
const CRISS_ENTITY = "1010003582";
const CRISS_TARGET: WestVirginiaCommitteeRow = {
  orgID: 3582, entityId: CRISS_ENTITY, orgName: "Committee to Elect Vernon Criss", candidateName: "Criss, Vernon",
  orgType: "State Candidate", orgTypeCode: "101", orgSubType: "Candidate", office: "House of Delegates", district: "12",
  party: "Republican", election: "2026 Election", registrationYear: "2025", orgStatus: "Active",
};
const STRONG: WestVirginiaCommitteeRow = {
  orgID: 2875, entityId: "1040002875", orgName: "West Virginia Strong,  Inc.", candidateName: null,
  orgType: "Independent Expenditure Committee", orgTypeCode: "104", orgSubType: "Organization", office: null, district: null,
  party: null, election: "2018 Election", registrationYear: "2022", orgStatus: "Active",
};
const CRISS_IE: WestVirginiaTransactionRow = apiRow({
  transactionID: 562631, entityID: STRONG.entityId, orgID: STRONG.orgID, committeeName: STRONG.orgName,
  candidateName: null, transactionAmount: 897.1, transactionDate: "2026-02-06T00:00:00", filedDate: "2026-04-29T00:00:00",
  entityTypeDesc: "Business or Organization", transactionTypeDesc: "Independent Expenditures", transactionPurpose: "Direct Mail",
  contributorPayeeName: "Dunbar Printing", employerName: null, employerOccupation: null, amendedFlag: false,
  reportVersionID: "2", reportFileName: "2026 1st Quarter Report", electionYear: 2026,
  s3ReportFilePath: "prd/Reports/2875/9357de47-f931-4240-a6aa-6d15a4cac5c1.pdf", stanceDescription: "Support",
  candidateNameAssocation: "Criss, Vernon", orgType: "Independent Expenditure Committee",
});
const STRONG_CURRENT: WestVirginiaCurrentFilingRow = {
  orgID: 2875, reportID: 32245, reportVersionID: 2, registrantID: STRONG.entityId, committeeName: STRONG.orgName!,
  reportFileName: "2026 1st Quarter Report", reportFormType: "Campaign Financial Statement",
  startDate: "2026-01-01T00:00:00", endDate: "2026-03-31T00:00:00", dueDate: "2026-04-07T00:00:00",
  filedDate: "2026-04-29T00:00:00", reportStatus: "Amended", documentBarCode: "F5BA3496AFAF45AE",
};
type ElectronicArtifact = Awaited<ReturnType<NonNullable<WestVirginiaFinanceArtifactLoader["electronicOutsideData"]>>>;
function crissArtifact(overrides: Partial<ElectronicArtifact> = {}): ElectronicArtifact {
  return {
    metadata: {
      version: 1, artifact: "electronic_ie", scope: "electronic_regular_report_ie", years: [2025, 2026],
      request: { modes: ["102", "103", "104", "105"], transactionCategory: "IE", pageSize: 5000 },
      sourceUrl: "https://cfrs.wvsos.gov/", registrySha256: "b".repeat(64),
      queryCounts: { before: [], after: [] }, filePath: "fixture.json", metadataPath: "fixture.metadata.json",
      downloadedAt: "2026-10-11T00:00:00Z", bytes: 1, sha256: "a".repeat(64), recordCount: 1,
    },
    rows: [CRISS_IE], registryRows: [CRISS_TARGET, STRONG, ...donorRegistry()],
    currentFilingsByOrg: new Map([[2875, [STRONG_CURRENT]]]), ...overrides,
  };
}
function crissInput(db: ReturnType<typeof writingDb>["db"]) {
  const base = baseInput(db);
  return { ...base, candidateName: "Vernon Criss", link: { ...base.link, entityId: CRISS_ENTITY, committeeName: CRISS_TARGET.orgName! } };
}
function crissLoader(electronicOutsideData: NonNullable<WestVirginiaFinanceArtifactLoader["electronicOutsideData"]>) {
  const direct = donorLoader();
  const rename = <T extends { registrantId: string; committeeName: string; candidateName: string }>(rows: T[]) => rows.map((row) =>
    row.registrantId === ENTITY ? { ...row, registrantId: CRISS_ENTITY, committeeName: CRISS_TARGET.orgName!, candidateName: "Vernon Criss" } : row);
  return donorLoader({
    registryRows: vi.fn(async () => [CRISS_TARGET, STRONG, ...donorRegistry()]),
    contributionRows: vi.fn(async (year) => rename(await direct.contributionRows(year))),
    expenditureRows: vi.fn(async (year) => rename(await direct.expenditureRows(year))),
    apiContributionRows: vi.fn(async (year) => (await direct.apiContributionRows(year)).map((row) =>
      row.entityID === ENTITY ? { ...row, entityID: CRISS_ENTITY, orgID: 3582, committeeName: CRISS_TARGET.orgName, candidateName: "Criss, Vernon" } : row)),
    electronicOutsideData,
  });
}
function outsideSql(client: ReturnType<typeof writingDb>["client"]) {
  return client.query.mock.calls.filter(([sql]) => /(?:INSERT INTO|DELETE FROM|UPDATE) public\.wv_candidate_finance_outside_/.test(String(sql)));
}
function expectDirectAndPreservedOutside(client: ReturnType<typeof writingDb>["client"]) {
  const summary = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_summaries"));
  expect(summary?.[1]?.slice(2, 8)).toEqual([4750, 1750, 120, null, null, null]);
  expect(String(summary?.[0])).toContain("COALESCE(EXCLUDED.outside_support_total");
  expect(String(summary?.[0])).toContain("COALESCE(EXCLUDED.outside_oppose_total");
  expect(outsideSql(client)).toEqual([]);
  expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_pac_donors"))).toBe(true);
  expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
}

describe("WV electronic IE sync source and preservation boundaries", () => {
  it("persists verified Criss current v2 $897.10 and provenance, excluding deleted original $3,000", async () => {
    const { db, client } = writingDb();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const artifact = crissArtifact({ rows: [
      { ...CRISS_IE, transactionID: 562630, reportVersionID: "1", filedDate: "2026-04-09T00:00:00", transactionAmount: 3000 }, CRISS_IE,
    ] });
    const result = await syncWestVirginiaCandidateFinance({ ...crissInput(db), loadArtifacts: crissLoader(async () => artifact) });
    expect(result).toMatchObject({ totalReceipts: 4750, directContributionTotal: 1750, pacDonorsWritten: 1,
      outsideSupportTotal: 897.1, outsideOpposeTotal: 0, outsideGroupsWritten: 1, outsideSourceSha256: "a".repeat(64), outsideDiagnostics: [] });
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.wv_candidate_finance_outside_groups"));
    expect(insert?.[1]?.slice(2, 6)).toEqual([STRONG.entityId, "West Virginia Strong, Inc.", "support", 897.1]);
    const proof = client.query.mock.calls.find(([sql]) => String(sql).includes("SET source_transactions = $5::jsonb"));
    expect(JSON.parse(String(proof?.[1]?.[4]))).toEqual([expect.objectContaining({ transactionID: 562631,
      spenderEntityId: STRONG.entityId, orgID: 2875, reportID: 32245, reportVersionID: 2, targetEntityId: CRISS_ENTITY,
      documentBarCode: "F5BA3496AFAF45AE", amount: 897.1 })]);
    expect(db.query).toHaveBeenCalledOnce();
    const [sql, params] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain("link.candidate_id = $1::uuid AND link.election_id = $2::uuid");
    expect(String(sql)).toContain("link.link_status = 'active'");
    expect(params).toEqual(["candidate-1", "election-1", 2026]);
    expect(db.query.mock.invocationCallOrder[0]).toBeLessThan(db.connect.mock.invocationCallOrder[0]!);
    const siblings = client.query.mock.calls.filter(([sql]) => String(sql).includes("id <> $3::uuid") &&
      (/DELETE FROM public\.wv_candidate_finance_outside_/.test(String(sql)) || String(sql).includes("SET outside_support_total = NULL")));
    expect(siblings).toHaveLength(3);
    for (const call of siblings) expect(call[1]).toEqual(["candidate-1", "election-1", LINK_ID, 2026]);
    const siblingSummary = siblings.find(([sql]) => String(sql).includes("UPDATE public.wv_candidate_finance_summaries"));
    expect(String(siblingSummary?.[0])).toContain("SET outside_support_total = NULL, outside_oppose_total = NULL");
    expect(String(siblingSummary?.[0])).not.toMatch(/SET[^]*total_receipts/);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it.each(["no cached metadata", "checksum mismatch"])("preserves every outside row when source %s, while direct/PAC update", async (message) => {
    const { db, client } = writingDb();
    const result = await syncWestVirginiaCandidateFinance({ ...crissInput(db), loadArtifacts: crissLoader(async () => { throw new Error(message); }) });
    expect(result).toMatchObject({ outsideSupportTotal: null, outsideOpposeTotal: null, outsideGroupsWritten: 0, outsideDiagnostics: [message] });
    expect(db.query).not.toHaveBeenCalled();
    expectDirectAndPreservedOutside(client);
  });

  it.each(["empty", "ambiguous", "incomplete-years"])("preserves outside spending for %s evidence", async (mode) => {
    const { db, client } = writingDb();
    const artifact = mode === "empty" ? crissArtifact({ rows: [] }) : mode === "ambiguous"
      ? crissArtifact({ currentFilingsByOrg: new Map([[2875, [STRONG_CURRENT, { ...STRONG_CURRENT, reportID: 12345 }]]]) })
      : crissArtifact({ metadata: { ...crissArtifact().metadata, years: [2026] } });
    const result = await syncWestVirginiaCandidateFinance({ ...crissInput(db), loadArtifacts: crissLoader(async () => artifact) });
    expect(result.outsideDiagnostics.join(" ")).toMatch(/no_accepted|ambiguous|does not cover every cycle year/);
    expect(result.outsideSupportTotal).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expectDirectAndPreservedOutside(client);
  });

  it("preserves prior accepted spending if its transaction disappears despite another current positive", async () => {
    const { db, client } = writingDb();
    db.query.mockResolvedValue({ rows: [{ committee_id: STRONG.entityId, support_oppose: "support",
      source_transactions: [{ spenderEntityId: STRONG.entityId, transactionID: 562630, reportID: 32245,
        reportVersionID: 1, supportOppose: "support" }] }], rowCount: 1 });
    const result = await syncWestVirginiaCandidateFinance({ ...crissInput(db), loadArtifacts: crissLoader(async () => crissArtifact()) });
    expect(result).toMatchObject({ outsideSupportTotal: null, outsideGroupsWritten: 0 });
    expect(result.outsideDiagnostics.join(" ")).toMatch(/Previously published.*disappeared/);
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query.mock.invocationCallOrder[0]).toBeLessThan(db.connect.mock.invocationCallOrder[0]!);
    expectDirectAndPreservedOutside(client);
  });

  it("preserves legacy outside spending without accepted provenance even with a current positive", async () => {
    const { db, client } = writingDb();
    db.query.mockResolvedValue({ rows: [{ committee_id: STRONG.entityId, support_oppose: "support", source_transactions: null }], rowCount: 1 });
    const result = await syncWestVirginiaCandidateFinance({ ...crissInput(db), loadArtifacts: crissLoader(async () => crissArtifact()) });
    expect(result.outsideDiagnostics.join(" ")).toMatch(/lacks reviewed transaction provenance/);
    expectDirectAndPreservedOutside(client);
  });
});
