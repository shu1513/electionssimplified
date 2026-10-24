import { describe, expect, it, vi } from "vitest";

import {
  DENVER_SEARCHLIGHT_MAX_PAGE_SIZE,
  DenverSearchlightClientError,
  buildDenverTransactionSearchBody,
  getDenverCommitteeDetailsByFiler,
  getDenverFiler,
  getDenverFilingSummary,
  getDenverOutsideSpenders,
  searchDenverContributionTransactions,
  searchDenverExpenditureTransactions,
  selectLatestDenverFilings,
  sweepDenverContributionTransactions,
  type DenverFiling,
} from "../../../src/pipeline/denverFinance/denverSearchlightClient.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), { status: 200, statusText: "OK", ...init });
}

/** Raw contribution row as the live API returns it — including the PII fields
 * (street address, zip) that the typed mapping must drop. */
function rawContributionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: 270852,
    transactionType: "Contribution",
    transactionSubType: "Monetary",
    recipientName: "Flor Alvidrez",
    recipientCommitteeName: "Flor For Denver",
    recipientCommitteeId: 744,
    officeSought: "City Council",
    district: "7",
    ballotIssue: null,
    contributorName: "Alec Garnett",
    contributorId: 161097,
    amount: 50.0,
    date: "2026-08-03T06:00:00",
    contributorEmployer: "UCHealth",
    contributorOccupation: "VP GR",
    contributorCity: "Denver",
    contributorStateCode: "CO",
    contactTypeId: 1,
    committeeTypeId: 1,
    transactionSubTypeId: 1,
    filerTypeId: 3,
    zipCode: "80218",
    address1: "921 N Clarkson St",
    address2: "",
    contributorFirstName: "Alec",
    contributorLastName: "Garnett",
    txnPurpose: null,
    fefTransaction: true,
    ...overrides,
  };
}

function contributionResponse(rows: Record<string, unknown>[], totalAmount: number, totalRecords: number) {
  return {
    totalContributionAmount: totalAmount,
    totalRecords,
    searchContributionTransactions: rows,
  };
}

describe("denverSearchlightClient", () => {
  it("builds the captured transaction search body shape", () => {
    const body = buildDenverTransactionSearchBody({
      candidateName: "  Mike   Johnston ",
      electionCycleIds: [26],
      pageNum: 2,
      pageSize: 500,
    });
    expect(body).toEqual({
      ballotIssue: null,
      candidateName: "Mike   Johnston",
      committeeName: null,
      committeePosition: null,
      contributionsFrom: null,
      contributionsFromCityStateCode: null,
      contributionsToIds: null,
      electionCycleIds: [26],
      isBallotIssue: false,
      isCandidate: false,
      ballotIssueId: null,
      candidateOfficeSoughtId: null,
      transactionFromDate: null,
      transactionToDate: null,
      transactionSubTypeId: null,
      pageNum: 2,
      pageSize: 500,
    });
    const defaults = buildDenverTransactionSearchBody({ pageNum: 1, pageSize: 10 });
    expect(defaults.candidateName).toBeNull();
    expect(defaults.contributionsToIds).toBeNull();
    expect(
      buildDenverTransactionSearchBody({ contributionsToIds: [658, 807], pageNum: 1, pageSize: 10 })
        .contributionsToIds
    ).toEqual([658, 807]);
    expect(() =>
      buildDenverTransactionSearchBody({ pageNum: 1, pageSize: DENVER_SEARCHLIGHT_MAX_PAGE_SIZE + 1 })
    ).toThrow(DenverSearchlightClientError);
    expect(() => buildDenverTransactionSearchBody({ pageNum: 0, pageSize: 10 })).toThrow(
      DenverSearchlightClientError
    );
  });

  it("maps contribution rows to cents and drops address/zip PII", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(contributionResponse([rawContributionRow()], 50.0, 1)));
    const page = await searchDenverContributionTransactions(
      { candidateName: "Mike Johnston", electionCycleIds: [26], pageNum: 1, pageSize: 10 },
      { fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://denver.maplight.com/api/Transaction/SearchContributionTransactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).candidateName).toBe("Mike Johnston");

    expect(page.totalContributionAmountCents).toBe(5_000);
    expect(page.totalContributionCount).toBe(1);
    const row = page.rows[0]!;
    expect(row.amountCents).toBe(5_000);
    expect(row.fefTransaction).toBe(true);
    expect(row.contributorOccupation).toBe("VP GR");
    const keys = Object.keys(row);
    expect(keys).not.toContain("address1");
    expect(keys).not.toContain("address2");
    expect(keys).not.toContain("zipCode");
    expect(JSON.stringify(page)).not.toContain("Clarkson");
  });

  it("converts fractional dollars to exact integer cents", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(contributionResponse([rawContributionRow({ amount: 2016263.63 })], 2016263.63, 1))
      );
    const page = await searchDenverContributionTransactions(
      { pageNum: 1, pageSize: 10 },
      { fetchImpl }
    );
    expect(page.totalContributionAmountCents).toBe(201_626_363);
    expect(page.rows[0]!.amountCents).toBe(201_626_363);
  });

  it("fails closed on a non-numeric amount or non-boolean fefTransaction", async () => {
    const badAmount = vi
      .fn()
      .mockResolvedValue(jsonResponse(contributionResponse([rawContributionRow({ amount: "50" })], 50, 1)));
    await expect(
      searchDenverContributionTransactions({ pageNum: 1, pageSize: 10 }, { fetchImpl: badAmount })
    ).rejects.toMatchObject({ code: "bad_response" });

    const badFlag = vi
      .fn()
      .mockResolvedValue(jsonResponse(contributionResponse([rawContributionRow({ fefTransaction: "true" })], 50, 1)));
    await expect(
      searchDenverContributionTransactions({ pageNum: 1, pageSize: 10 }, { fetchImpl: badFlag })
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("maps expenditure rows with the IE/FEF flags and drops payee addresses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        totalExpendituresAmount: 19.8,
        totalExpendituresCount: 1,
        searchExpendituresTransactions: [
          {
            transactionId: 255038,
            transactionType: "Expenditure",
            transactionSubType: "Expenditure",
            committeeName: "Mike Johnston for Mayor",
            committeeId: 807,
            candidateName: "Mike Johnston",
            candidateOffice: "Mayor",
            candidateDistrict: null,
            amount: 19.8,
            date: "2023-12-27T07:00:00",
            purpose: "Bank Fee",
            payee: "FirstBank",
            contactTypeId: 2,
            address1: "12345 W. Colfax Ave",
            address2: null,
            zipCode: "80215",
            fefTransaction: false,
            electioneeringCommFlag: false,
            independentExpnFlag: false,
          },
        ],
      })
    );
    const page = await searchDenverExpenditureTransactions({ pageNum: 1, pageSize: 10 }, { fetchImpl });
    const row = page.rows[0]!;
    expect(row.amountCents).toBe(1_980);
    expect(row.committeeId).toBe(807);
    expect(row.independentExpnFlag).toBe(false);
    expect(Object.keys(row)).not.toContain("address1");
    expect(JSON.stringify(page)).not.toContain("Colfax");
  });

  it("maps committee details through the PII allowlist", async () => {
    // Raw response as observed live 2026-08-12 (filer 1326, cycle 36) — the
    // treasurer's name and address fields must never survive the mapping.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        entityName: "Browne for Denver",
        entityType: "Candidate Committee",
        candidateName: "Jake Browne",
        treasurerName: "Samantha Sandt",
        address1: "123 Main St",
        address2: "Unit 4",
        electionDate: "2026-11-03T07:00:00",
        committeeId: 797,
        committeeName: "Browne for Denver",
        committeeType: "Candidate Committee",
        committeeTypeId: 1,
        district: null,
        office: "City Council At-Large Seat B",
        officeId: 10,
        filerId: 1326,
        entityId: 797,
        electionCycle: "2026 City Council Vacancy Election",
        electionCycleId: 36,
      })
    );
    const details = await getDenverCommitteeDetailsByFiler(1326, 36, { fetchImpl });
    expect(details).toEqual({
      filerId: 1326,
      committeeId: 797,
      committeeName: "Browne for Denver",
      committeeTypeId: 1,
      committeeType: "Candidate Committee",
      candidateName: "Jake Browne",
      office: "City Council At-Large Seat B",
      officeId: 10,
      electionCycleId: 36,
      electionDate: "2026-11-03T07:00:00",
    });
    expect(JSON.stringify(details)).not.toContain("Sandt");
    expect(JSON.stringify(details)).not.toContain("Main St");
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("GetCommitteeDetailsByFiler?filerId=1326&electionCycleId=36");
  });

  it("returns null committee details on the live 204 no-content answer", async () => {
    // Verified live 2026-08-13: filer 1328 has no detail record for cycle 36
    // and the endpoint answers 204 with an empty body. That is source data,
    // not a fault — throwing here aborted the whole auto-link leg.
    const noContent = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(getDenverCommitteeDetailsByFiler(1328, 36, { fetchImpl: noContent })).resolves.toBeNull();

    // A 200 with an empty body is the same answer from a different server.
    const emptyBody = vi.fn().mockResolvedValue(new Response("  ", { status: 200 }));
    await expect(getDenverCommitteeDetailsByFiler(1328, 36, { fetchImpl: emptyBody })).resolves.toBeNull();
  });

  it("still fails closed when another endpoint answers with no content", async () => {
    // Only the details getter treats "no content" as data; an empty filer or
    // transaction response is a broken answer and must not pass silently.
    const noContent = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(getDenverFiler(658, { fetchImpl: noContent })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("surfaces HTTP and JSON failures with typed error codes", async () => {
    const httpError = vi.fn().mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" }));
    await expect(getDenverFiler(658, { fetchImpl: httpError })).rejects.toMatchObject({
      code: "http_error",
      status: 500,
    });

    const badJson = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(getDenverFiler(658, { fetchImpl: badJson })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("rejects a response that declares a body over the size cap", async () => {
    const oversized = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(33 * 1024 * 1024) },
      })
    );
    await expect(getDenverFiler(658, { fetchImpl: oversized })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("maps the filer identity record", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        filerId: 658,
        filerTypeId: 3,
        filerTypeName: "Committee",
        filerStatusId: 4,
        filerStatusName: "Active",
        isTerminated: false,
        committeeIds: [641, 807],
        lobbyistIds: [],
        accessEthicseIds: [],
        independentExpenditureIds: [],
      })
    );
    const filer = await getDenverFiler(658, { fetchImpl });
    expect(filer).toEqual({
      filerId: 658,
      filerTypeName: "Committee",
      filerStatusName: "Active",
      isTerminated: false,
      committeeIds: [641, 807],
      independentExpenditureIds: [],
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://denver.maplight.com/api/Filer/filer/658");
  });

  it("maps outside spenders and filing summaries to cents", async () => {
    const spendersImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ name: "Advancing Denver", total: 4962415.47 }]));
    const spenders = await getDenverOutsideSpenders(
      { filerId: 658, electionCycleId: 26, direction: "support" },
      { fetchImpl: spendersImpl }
    );
    expect(spenders).toEqual([{ name: "Advancing Denver", totalCents: 496_241_547 }]);
    expect(spendersImpl.mock.calls[0]![0]).toContain("positionType=1");

    const summaryImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        openingBalance: 0.0,
        totalMonetaryContributions: 104911.52,
        totalFEFQualifyingContributions: 80745.0,
        totalInKindContributions: 0.0,
        totalRefunds: 0.0,
        totalExpenditures: 21484.47,
        totalFairElectionExpenditures: 0.0,
        totalOtherExpenditures: 21484.47,
        totalFairElectionsFunding: 0.0,
        totalNewLoans: 0,
        totalLoanBalance: 0,
        closingBalance: 164172.05,
        totalNonDonorFunds: 0.0,
      })
    );
    const summary = await getDenverFilingSummary(9673, { fetchImpl: summaryImpl });
    expect(summary.totalMonetaryContributionsCents).toBe(10_491_152);
    expect(summary.totalFefQualifyingContributionsCents).toBe(8_074_500);
    expect(summary.closingBalanceCents).toBe(16_417_205);
    expect(summary.totalNonDonorFundsCents).toBe(0);
  });

  it("sweeps pages until a short page and validates the header count", async () => {
    const pageOne = contributionResponse(
      [rawContributionRow({ transactionId: 1 }), rawContributionRow({ transactionId: 2 })],
      150.0,
      3
    );
    const pageTwo = contributionResponse([rawContributionRow({ transactionId: 3, amount: 50 })], 150.0, 3);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pageOne))
      .mockResolvedValueOnce(jsonResponse(pageTwo));
    const sweep = await sweepDenverContributionTransactions({}, { fetchImpl, pageSize: 2 });
    expect(sweep.rows.map((row) => row.transactionId)).toEqual([1, 2, 3]);
    expect(sweep.totalContributionCount).toBe(3);

    const undercount = vi
      .fn()
      .mockResolvedValue(jsonResponse(contributionResponse([rawContributionRow()], 50.0, 5)));
    await expect(sweepDenverContributionTransactions({}, { fetchImpl: undercount, pageSize: 2 })).rejects.toMatchObject(
      { code: "bad_response" }
    );

    const endless = vi.fn().mockImplementation(async () =>
      jsonResponse(
        contributionResponse([rawContributionRow({ transactionId: 9 }), rawContributionRow({ transactionId: 10 })], 999, 999)
      )
    );
    await expect(
      sweepDenverContributionTransactions({}, { fetchImpl: endless, pageSize: 2, maxPages: 3 })
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("selects the latest filing version per period and rejects malformed chains", () => {
    const filing = (overrides: Partial<DenverFiling>): DenverFiling => ({
      filingId: 1,
      filerId: 658,
      entityId: 807,
      electionCycleId: 26,
      filingPeriodId: 100,
      filingPeriodName: null,
      filingTypeName: "Campaign Finance Report",
      filingVersion: 1,
      filingStatusName: "Submitted",
      filingTypeId: 5,
      submittedDate: null,
      startDate: "2023-01-01T07:00:00",
      endDate: null,
      ...overrides,
    });

    const latest = selectLatestDenverFilings([
      filing({ filingId: 1, filingPeriodId: 100, filingVersion: 1, startDate: "2023-02-01T07:00:00" }),
      filing({ filingId: 2, filingPeriodId: 100, filingVersion: 3, startDate: "2023-02-01T07:00:00" }),
      filing({ filingId: 3, filingPeriodId: 100, filingVersion: 2, startDate: "2023-02-01T07:00:00" }),
      filing({ filingId: 4, filingPeriodId: 99, filingVersion: 1, startDate: "2023-01-01T07:00:00" }),
    ]);
    expect(latest.map((entry) => entry.filingId)).toEqual([4, 2]);

    expect(() =>
      selectLatestDenverFilings([
        filing({ filingId: 5, filingPeriodId: 100, filingVersion: 2 }),
        filing({ filingId: 6, filingPeriodId: 100, filingVersion: 2 }),
      ])
    ).toThrow(DenverSearchlightClientError);

    expect(() => selectLatestDenverFilings([filing({ filingPeriodId: null })])).toThrow(
      DenverSearchlightClientError
    );
  });
});

it("preserves native organization labels for committee cash without carrying address fields", async () => {
 const fetchImpl=vi.fn().mockResolvedValue(jsonResponse(contributionResponse([rawContributionRow({contributorName:null,orgName:"Example Political Fund",contactTypeId:2})],50,1)));
 const page=await searchDenverContributionTransactions({pageNum:1,pageSize:10},{fetchImpl});expect(page.rows[0]).toMatchObject({organizationName:"Example Political Fund",contactTypeId:2,contributorName:null});expect(page.rows[0]).not.toHaveProperty("address1");
});
