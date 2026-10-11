import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConnecticutEcrisArtifactCachePaths } from "../../../src/pipeline/connecticutFinance/connecticutEcrisArtifactCache.js";
import { describe, expect, it, vi } from "vitest";

import {
  listDueConnecticutCandidateFinanceSyncRows,
  syncDueConnecticutCandidateFinance,
  type ConnecticutEcrisReceiptDataForYear,
} from "../../../src/pipeline/connecticutFinance/connecticutCandidateFinanceBatchSync.js";
import type { ConnecticutEcrisArtifactRow } from "../../../src/pipeline/connecticutFinance/connecticutEcrisArtifactReader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

function receipt(overrides: Partial<ConnecticutEcrisArtifactRow> = {}): ConnecticutEcrisArtifactRow {
  return {
    Committee: "ACKERT FOR THE 8TH",
    "Contributor Name": "Carolyn Gerrity",
    District: "8",
    "Office Sought": "State Representative",
    Employer: "RTX-Pratt Whitney",
    "Receipt Type": "Itemized Contributions from Individuals",
    "Committee Type": "Candidate Committee",
    "Transaction Date": "03/31/2026",
    "File To State": "04/01/2026",
    Amount: "50.00",
    "Receipt State": "Original",
    Occupation: "Business Manager",
    ElectionYear: "2026",
    "Committee ID": "14376",
    "Candidate First Name": "Timothy",
    "Candidate Middle Intial": "J",
    "Candidate Last Name": "Ackert",
    ...overrides,
  };
}

function receiptDataForYear(input: {
  year: number;
  sourceUrl?: string;
  rowsByCommitteeId: Map<string, ConnecticutEcrisArtifactRow[]>;
}): ConnecticutEcrisReceiptDataForYear {
  return {
    year: input.year,
    filePath: `/tmp/${input.year}_candidate_receipts.csv`,
    sourceUrl:
      input.sourceUrl ??
      `https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts${input.year}ElectionYearCandidateExploratoryCommittees.csv`,
    rowsByCommitteeId: input.rowsByCommitteeId,
  };
}

describe("connecticutCandidateFinanceBatchSync", () => {
  it("lists due Connecticut finance sync rows from explicit active links", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Timothy Ackert",
        election_year: 2026,
        office_name: "State Lower Chamber Legislator",
        district: "8",
        committee_id: "14376",
        committee_name: "ACKERT FOR THE 8TH",
        source_url: "https://seec.ct.gov/portal/ecris/CurPreYears",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_name: "Governor",
        district: null,
        committee_id: "20001",
        committee_name: "DOE FOR GOVERNOR",
        source_url: null,
        last_synced_at: "2026-01-01 00:00:00+00",
        total_due_rows: "2",
      },
    ]);

    const result = await listDueConnecticutCandidateFinanceSyncRows(db, {
      now: new Date("2026-06-01T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 30,
      electionLookaheadDays: 730,
    });

    expect(result).toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Timothy Ackert",
          electionYear: 2026,
          officeName: "State Lower Chamber Legislator",
          district: "8",
          committeeId: "14376",
          committeeName: "ACKERT FOR THE 8TH",
          sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeName: "Governor",
          district: null,
          committeeId: "20001",
          committeeName: "DOE FOR GOVERNOR",
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.ct_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'CT'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      30,
      730,
    ]);
  });

  it("uses a one-day post-election grace window by default for due selection", async () => {
    const db = createMockDb();

    await syncDueConnecticutCandidateFinance({
      db,
      syncConnecticutCandidateFinanceFn: vi.fn(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      // A missing cache dir keeps the test off any real local artifact.
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      autoLinkMissingLinks: false,
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
    ]);
  });

  it("syncs selected due links with cached yearly receipt rows and continues after failures", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Timothy Ackert",
        election_year: 2026,
        office_name: "State Lower Chamber Legislator",
        district: "8",
        committee_id: "14376",
        committee_name: "ACKERT FOR THE 8TH",
        source_url: "https://seec.ct.gov/portal/ecris/CurPreYears",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_name: "Governor",
        district: null,
        committee_id: "20001",
        committee_name: "DOE FOR GOVERNOR",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const syncConnecticutCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        dryRun: false,
        resolution: { status: "matched", committeeId: "14376" },
        linkWritten: true,
        summaryWritten: true,
        directBreakdownsWritten: 3,
        totalReceipts: 100,
        matchedReceiptRowCount: 1,
        includedReceiptRowCount: 1,
        skippedReceiptRowCount: 0,
      })
      .mockRejectedValueOnce(new Error("eCRIS row parse failed"));
    const row = receipt({ "Committee ID": "14376", Amount: "100.00" });

    const result = await syncDueConnecticutCandidateFinance({
      db,
      syncConnecticutCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      // A missing cache dir keeps the test off any real local artifact.
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      receiptDataByYear: new Map([
        [
          2026,
          receiptDataForYear({
            year: 2026,
            rowsByCommitteeId: new Map([["14376", [row]]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      dryRun: false,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({ ok: true, committeeId: "14376" });
    expect(result.results[1]).toMatchObject({
      ok: false,
      committeeId: "20001",
      error: "eCRIS row parse failed",
    });
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledTimes(2);
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Timothy Ackert",
        electionYear: 2026,
        officeName: "State Lower Chamber Legislator",
        district: "8",
        sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
        receiptRows: [row],
        receiptSourceUrl:
          "https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/exportdatafiles/Receipts2026ElectionYearCandidateExploratoryCommittees.csv",
      })
    );
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "33333333-3333-4333-8333-333333333333",
        electionId: "44444444-4444-4444-8444-444444444444",
        officeName: "Governor",
        receiptRows: [],
      })
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      3,
      2,
      30,
      730,
    ]);
  });

  it("passes the year's cached independent expenditures to each sync, or nothing when the year has none", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Timothy Ackert",
        election_year: 2026,
        office_name: "State Lower Chamber Legislator",
        district: "8",
        committee_id: "14376",
        committee_name: "ACKERT FOR THE 8TH",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Jane Doe",
        election_year: 2025,
        office_name: "Governor",
        district: null,
        committee_id: "20001",
        committee_name: "DOE FOR GOVERNOR",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const syncConnecticutCandidateFinanceFn = vi.fn().mockResolvedValue({ ok: true });
    const expenditureRow = {
      rootExpenditureId: "0",
      committeeName: "Nutmeg Forward",
      formTag: "SEEC40",
      documentUrl: null,
      reportType: "July 10 Filing",
      documentType: "Original",
      payee: "Vendor",
      receivedDate: "2026-06-30",
      fileYear: 2026,
      periodStartDate: null,
      periodEndDate: null,
      amountCents: 1000,
      formSection: "G. Expenses Paid by Committee",
      supportingCandidates: ["Tim Ackert"],
      supportingOffices: ["State Representative"],
      opposingCandidates: [],
      opposingOffices: [],
      dataSource: "eFile",
    };

    await syncDueConnecticutCandidateFinance({
      db,
      syncConnecticutCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      autoLinkMissingLinks: false,
      receiptDataByYear: new Map([
        [2026, receiptDataForYear({ year: 2026, rowsByCommitteeId: new Map() })],
        [2025, receiptDataForYear({ year: 2025, rowsByCommitteeId: new Map() })],
      ]),
      independentExpenditureDataByYear: new Map([
        [
          2026,
          {
            year: 2026,
            filePath: "/tmp/2026_independent_expenditures.json",
            sourceUrl: "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx",
            rows: [expenditureRow],
          },
        ],
      ]),
    });

    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledTimes(2);
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        independentExpenditureRows: [expenditureRow],
        independentExpenditureSourceUrl: "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx",
      })
    );
    const governorCall = syncConnecticutCandidateFinanceFn.mock.calls.find((call) => call[0].electionYear === 2025)?.[0];
    expect(governorCall).toBeDefined();
    expect(governorCall.independentExpenditureRows).toBeUndefined();
    expect(governorCall.independentExpenditureSourceUrl).toBeUndefined();
  });

  it("withholds independent expenditures from candidates whose name and office another candidate shares", async () => {
    const dueRow = {
      candidate_id: CANDIDATE_ID,
      election_id: ELECTION_ID,
      candidate_name: "Timothy Ackert",
      election_year: 2026,
      office_name: "State Lower Chamber Legislator",
      district: "8",
      committee_id: "14376",
      committee_name: "ACKERT FOR THE 8TH",
      source_url: null,
      last_synced_at: null,
      total_due_rows: "1",
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("FROM public.ct_candidate_finance_links AS link")) {
          return { rows: [dueRow] };
        }
        if (String(sql).includes("JOIN public.offices AS office")) {
          return {
            rows: [
              { election_year: 2026, candidate_name: "Timothy Ackert", office_name: "State Lower Chamber Legislator" },
              { election_year: 2026, candidate_name: "Tim Ackert", office_name: "State Lower Chamber Legislator" },
              { election_year: 2026, candidate_name: "Jane Doe", office_name: "Governor" },
            ],
          };
        }
        throw new Error(`Unexpected query: ${String(sql)}`);
      }),
    };
    const syncConnecticutCandidateFinanceFn = vi.fn().mockResolvedValue({ ok: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await syncDueConnecticutCandidateFinance({
      db,
      syncConnecticutCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      // A missing cache dir keeps the test off any real local artifact.
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      autoLinkMissingLinks: false,
      receiptDataByYear: new Map([[2026, receiptDataForYear({ year: 2026, rowsByCommitteeId: new Map() })]]),
      independentExpenditureDataByYear: new Map([
        [2026, { year: 2026, filePath: "/tmp/2026_independent_expenditures.json", sourceUrl: "https://seec.ct.gov/ie", rows: [] }],
      ]),
    });

    expect(db.query.mock.calls.map((call) => String(call[0]).includes("JOIN public.offices AS office"))).toEqual([false, true]);
    expect(db.query.mock.calls[1]?.[1]).toEqual([[2026]]);
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledTimes(1);
    const call = syncConnecticutCandidateFinanceFn.mock.calls[0]?.[0];
    expect(call.independentExpenditureRows).toBeUndefined();
    expect(call.independentExpenditureSourceUrl).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Connecticut outside spending skipped for Timothy Ackert"));
  });

  it("records artifact load failures per year without blocking other due years", async () => {
    const successfulCandidateId = "55555555-5555-4555-8555-555555555555";
    const successfulElectionId = "66666666-6666-4666-8666-666666666666";
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Timothy Ackert",
        election_year: 2025,
        office_name: "State Lower Chamber Legislator",
        district: "8",
        committee_id: "14376",
        committee_name: "ACKERT FOR THE 8TH",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: successfulCandidateId,
        election_id: successfulElectionId,
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_name: "Governor",
        district: null,
        committee_id: "20001",
        committee_name: "DOE FOR GOVERNOR",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const row = receipt({ "Committee ID": "20001", Amount: "100.00" });
    const syncConnecticutCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: successfulCandidateId,
      electionId: successfulElectionId,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched", committeeId: "20001" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      totalReceipts: 100,
      matchedReceiptRowCount: 1,
      includedReceiptRowCount: 1,
      skippedReceiptRowCount: 0,
    });

    const result = await syncDueConnecticutCandidateFinance({
      db,
      syncConnecticutCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      autoLinkMissingLinks: false,
      receiptDataByYear: new Map([
        [
          2026,
          receiptDataForYear({
            year: 2026,
            rowsByCommitteeId: new Map([["20001", [row]]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({
      ok: false,
      candidateId: CANDIDATE_ID,
      electionYear: 2025,
      committeeId: "14376",
    });
    expect(result.results[0]?.error).toContain("Connecticut eCRIS candidate receipt artifact not found for 2025");
    expect(result.results[1]).toMatchObject({
      ok: true,
      candidateId: successfulCandidateId,
      electionYear: 2026,
      committeeId: "20001",
    });
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledTimes(1);
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: successfulCandidateId,
        electionId: successfulElectionId,
        electionYear: 2026,
        receiptRows: [row],
      })
    );
  });

  it("auto-links missing candidates before listing due rows", async () => {
    const row = receipt({ "Committee ID": "14376", Amount: "100.00" });
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Timothy Ackert",
              election_year: 2026,
              office_name: "State Lower Chamber Legislator",
              district: "8",
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Timothy Ackert",
              election_year: 2026,
              office_name: "State Lower Chamber Legislator",
              district: "8",
              committee_id: "14376",
              committee_name: "ACKERT FOR THE 8TH",
              source_url: "https://seec.ct.gov/portal/ecris/CurPreYears",
              last_synced_at: null,
              total_due_rows: "1",
            },
          ],
          rowCount: 1,
        }),
    };
    const syncConnecticutCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched", committeeId: "14376" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      totalReceipts: 100,
      matchedReceiptRowCount: 1,
      includedReceiptRowCount: 1,
      skippedReceiptRowCount: 0,
    });

    const result = await syncDueConnecticutCandidateFinance({
      db,
      syncConnecticutCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      // A missing cache dir keeps the test off any real local artifact.
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      receiptDataByYear: new Map([
        [
          2026,
          receiptDataForYear({
            year: 2026,
            sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
            rowsByCommitteeId: new Map([["14376", [row]]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.candidate_elections AS candidate_election");
    expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.ct_candidate_finance_links");
    expect(String(db.query.mock.calls[2]?.[0])).toContain("FROM public.ct_candidate_finance_links AS link");
    expect(syncConnecticutCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        receiptRows: [row],
      })
    );
  });

  it("auto-links and writes a direct finance snapshot with the real sync path", async () => {
    const receiptRows = [
      receipt({ Amount: "100.00", Occupation: "Attorney" }),
      receipt({ Amount: "250.00", Occupation: "Teacher" }),
    ];
    const db = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [], rowCount: null };
        }
        if (text.includes("FROM public.candidate_elections AS candidate_election")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Timothy Ackert",
                election_year: 2026,
                office_name: "State Lower Chamber Legislator",
                district: "8",
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("INSERT INTO public.ct_candidate_finance_links")) {
          return { rows: [{ id: "link-1" }], rowCount: 1 };
        }
        if (text.includes("FROM public.ct_candidate_finance_links AS link")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Timothy Ackert",
                election_year: 2026,
                office_name: "State Lower Chamber Legislator",
                district: "8",
                committee_id: "14376",
                committee_name: "ACKERT FOR THE 8TH",
                source_url: "https://seec.ct.gov/portal/ecris/CurPreYears",
                last_synced_at: null,
                total_due_rows: "1",
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("INSERT INTO public.ct_candidate_finance_summaries")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("INSERT INTO public.ct_candidate_finance_direct_breakdowns")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("ct_candidate_finance_pac_donors")) return { rows: [], rowCount: 1 };
        if (text.includes("DELETE FROM public.ct_candidate_finance_direct_breakdowns")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    const result = await syncDueConnecticutCandidateFinance({
      db,
      now: new Date("2026-06-01T00:00:00.000Z"),
      // A missing cache dir keeps the test off any real local artifact.
      rawDataCacheDir: "/tmp/voteapp-missing-connecticut-ecris-cache",
      receiptDataByYear: new Map([
        [
          2026,
          receiptDataForYear({
            year: 2026,
            sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
            rowsByCommitteeId: new Map([["14376", receiptRows]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(result.results[0]).toMatchObject({
      ok: true,
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      committeeId: "14376",
      result: {
        linkWritten: true,
        summaryWritten: true,
        totalReceipts: 350,
        matchedReceiptRowCount: 2,
        includedReceiptRowCount: 2,
        skippedReceiptRowCount: 0,
        resolution: {
          status: "matched",
          committeeId: "14376",
          committeeName: "ACKERT FOR THE 8TH",
        },
      },
    });

    const statements = db.query.mock.calls.map((call) => String(call[0]));
    expect(statements.filter((sql) => sql.includes("INSERT INTO public.ct_candidate_finance_links"))).toHaveLength(2);
    expect(statements.some((sql) => sql.includes("INSERT INTO public.ct_candidate_finance_summaries"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO public.ct_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM public.ct_candidate_finance_direct_breakdowns"))).toBe(true);
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
  });

  it("validates batch options", async () => {
    const db = createMockDb();

    await expect(
      syncDueConnecticutCandidateFinance({
        db,
        maxCandidates: 0,
      })
    ).rejects.toThrow("Invalid Connecticut finance batch sync maxCandidates");

    expect(db.query).not.toHaveBeenCalled();
  });
});

it("keeps registry types from recipients filtered out of the due batch", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ct-registry-"));
  try {
    const rows = [
      receipt({ "Contributor Name": "Exploratory Donor", "Receipt Type": "Contributions from Other Committees" }),
      receipt({ Committee: "Exploratory Donor", "Committee ID": "999", "Committee Type": "Exploratory Committee" }),
    ];
    const columns = Object.keys(rows[0]!);
    const csv = [columns, ...rows.map((row) => columns.map((key) => row[key] ?? ""))]
      .map((row) => row.map((cell) => '"' + cell.replace(/"/g, '""') + '"').join(",")).join("\n");
    const paths = getConnecticutEcrisArtifactCachePaths({
      cacheDir, year: 2026, transactionType: "receipts", committeeType: "candidate_exploratory", period: "election", format: "csv",
    });
    await writeFile(paths.filePath, csv);
    const db = createMockDb([{
      candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, candidate_name: "Timothy Ackert", election_year: 2026,
      office_name: "State Lower Chamber Legislator", district: "8", committee_id: "14376",
      committee_name: "ACKERT FOR THE 8TH", source_url: null, last_synced_at: null, total_due_rows: "1",
    }]);
    const syncFn = vi.fn().mockResolvedValue({});
    await syncDueConnecticutCandidateFinance({
      db, rawDataCacheDir: cacheDir, autoLinkMissingLinks: false, syncConnecticutCandidateFinanceFn: syncFn,
    });
    expect(syncFn).toHaveBeenCalledWith(expect.objectContaining({
      receiptRows: [rows[0]],
      committeeRegistry: expect.arrayContaining([
        { committeeId: "999", committeeName: "Exploratory Donor", committeeType: "Exploratory Committee" },
      ]),
    }));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
