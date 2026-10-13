import { describe, expect, it } from "vitest";
import {
  getSanFranciscoCandidateTargetedSpending,
  getSanFranciscoCommitteeCashTransactions,
  getSanFranciscoCommitteeCurrentForm460Filings,
  getSanFranciscoCommitteeItemizedTransactions,
  getSanFranciscoCommitteeSummaryRows,
  getSanFranciscoDatasetFreshness,
  getSanFranciscoFilers,
  getSanFranciscoPublicFundsApproved,
  moneyStringToCents,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoOpenDataClient.js";

function jsonFetch(rows: unknown[]): typeof fetch {
  return async () =>
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("moneyStringToCents", () => {
  it("converts decimal strings exactly", () => {
    expect(moneyStringToCents("4841006.0")).toBe(484100600);
    expect(moneyStringToCents("92.4")).toBe(9240);
    expect(moneyStringToCents("10917642.52")).toBe(1091764252);
    expect(moneyStringToCents("0")).toBe(0);
    expect(moneyStringToCents("-25.5")).toBe(-2550);
  });

  it("rounds a sub-cent third digit on the magnitude", () => {
    expect(moneyStringToCents("1.005")).toBe(101);
    expect(moneyStringToCents("1.004")).toBe(100);
    expect(moneyStringToCents("-1.005")).toBe(-101);
  });

  it("rejects non-money text", () => {
    expect(moneyStringToCents("n/a")).toBeNull();
    expect(moneyStringToCents("$5")).toBeNull();
    expect(moneyStringToCents("")).toBeNull();
    expect(moneyStringToCents(undefined)).toBeNull();
  });
});

describe("getSanFranciscoCommitteeSummaryRows", () => {
  const row = (overrides: Record<string, unknown>) => ({
    filing_nid: "1",
    filing_id_number: "100",
    filing_type: "FiledOriginal",
    form_type: "FPPC460",
    start_date: "2024-01-01T00:00:00.000",
    end_date: "2024-06-30T00:00:00.000",
    line_1_col_a: "896598.68",
    line_2_col_a: "29.38",
    line_5_col_a: "896998.68",
    line_11_col_a: "1107012.93",
    line_16_col_a: "66969.88",
    line_19_col_a: "29.38",
    scheduleb1_line_1: "100000.0",
    sync_flag: true,
    ...overrides,
  });

  it("maps summary rows to cents", async () => {
    const rows = await getSanFranciscoCommitteeSummaryRows(
      { fppcId: "1463099" },
      { fetchImpl: jsonFetch([row({})]) },
    );
    expect(rows).toEqual([
      {
        filingNid: "1",
        filingIdNumber: "100",
        filingType: "FiledOriginal",
        formType: "FPPC460",
        periodStart: "2024-01-01T00:00:00.000",
        periodEnd: "2024-06-30T00:00:00.000",
        monetaryContributionsCents: 89659868,
        line2Cents: 2938,
        contributionsCents: 89699868,
        expendituresCents: 110701293,
        endingCashCents: 6696988,
        outstandingDebtsCents: 2938,
        loansReceivedCents: 10000000,
        syncFlag: true,
      },
    ]);
  });

  it("fails loudly when the current-version-only guarantee breaks", async () => {
    await expect(
      getSanFranciscoCommitteeSummaryRows(
        { fppcId: "1463099" },
        {
          fetchImpl: jsonFetch([row({}), row({ filing_id_number: "101" })]),
        },
      ),
    ).rejects.toThrow(/duplicate filing_nid 1/);
  });

  it("rejects malformed FPPC ids", async () => {
    await expect(
      getSanFranciscoCommitteeSummaryRows(
        { fppcId: "abc" },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Invalid San Francisco FPPC id/);
  });
});

describe("Open Data request retry", () => {
  it("uses fresh connections throughout pagination without changing token or timeout handling", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(init!);
      // Reproduces the endpoint's empty 428 when connection reuse is allowed.
      const headers = new Headers(init?.headers);
      if (headers.get("connection") !== "close")
        return new Response(null, { status: 428 });
      return new Response(
        requests.length === 1 ? '[{"filing_nid":"1"}]' : "[]",
        {
          status: 200,
        },
      );
    };
    await getSanFranciscoCommitteeSummaryRows(
      { fppcId: "1463099" },
      { fetchImpl, pageLimit: 1, appToken: "test-token" },
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = new Headers(request.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("X-App-Token")).toBe("test-token");
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal?.aborted).toBe(false);
    }
  });

  // Retry lives in the shared fetch path, so one entry point covers all of
  // the dataset getters.
  const failThenSucceed = (failures: Response[] | Error[]) => {
    let calls = 0;
    const fetchImpl = (async () => {
      const failure = failures[calls];
      calls += 1;
      if (failure instanceof Error) throw failure;
      if (failure) return failure;
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fetchImpl, callCount: () => calls };
  };

  it("retries a 503 and then succeeds", async () => {
    const { fetchImpl, callCount } = failThenSucceed([
      new Response("busy", { status: 503 }),
    ]);
    await expect(
      getSanFranciscoCommitteeSummaryRows({ fppcId: "1463099" }, { fetchImpl }),
    ).resolves.toEqual([]);
    expect(callCount()).toBe(2);
  });

  it("retries a network failure and then succeeds", async () => {
    const { fetchImpl, callCount } = failThenSucceed([
      new TypeError("fetch failed"),
    ]);
    await expect(
      getSanFranciscoCommitteeSummaryRows({ fppcId: "1463099" }, { fetchImpl }),
    ).resolves.toEqual([]);
    expect(callCount()).toBe(2);
  });

  it("retries 429 Too Many Requests, the one retryable client error", async () => {
    const { fetchImpl, callCount } = failThenSucceed([
      new Response("slow down", { status: 429 }),
    ]);
    await expect(
      getSanFranciscoCommitteeSummaryRows({ fppcId: "1463099" }, { fetchImpl }),
    ).resolves.toEqual([]);
    expect(callCount()).toBe(2);
  });

  it("does not retry non-429 client errors", async () => {
    const { fetchImpl, callCount } = failThenSucceed([
      new Response("gone", { status: 404, statusText: "Not Found" }),
    ]);
    await expect(
      getSanFranciscoCommitteeSummaryRows({ fppcId: "1463099" }, { fetchImpl }),
    ).rejects.toThrow(/request failed: 404/);
    expect(callCount()).toBe(1);
  });

  it("still rejects an empty 428 instead of accepting missing source rows", async () => {
    const { fetchImpl, callCount } = failThenSucceed([
      new Response(null, { status: 428 }),
    ]);
    await expect(
      getSanFranciscoCommitteeSummaryRows({ fppcId: "1463099" }, { fetchImpl }),
    ).rejects.toThrow(/request failed: 428/);
    expect(callCount()).toBe(1);
  });

  it("throws the terminal status once retries run out", async () => {
    const { fetchImpl, callCount } = failThenSucceed([
      new Response("busy", { status: 503, statusText: "Unavailable" }),
      new Response("busy", { status: 503, statusText: "Unavailable" }),
    ]);
    await expect(
      getSanFranciscoCommitteeSummaryRows(
        { fppcId: "1463099" },
        { fetchImpl, retryCount: 1 },
      ),
    ).rejects.toThrow(/request failed: 503/);
    expect(callCount()).toBe(2);
  });
});

describe("getSanFranciscoDatasetFreshness", () => {
  it("returns the aggregate maxima and validates the dataset id", async () => {
    let requestedUrl = "";
    const freshness = await getSanFranciscoDatasetFreshness("9ggq-m8hp", {
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify([
            {
              data_as_of: "2026-08-07T00:00:00.000",
              data_loaded_at: "2026-08-08T00:00:00.000",
            },
          ]),
          { status: 200 },
        );
      },
    });
    expect(freshness).toEqual({
      dataAsOf: "2026-08-07T00:00:00.000",
      dataLoadedAt: "2026-08-08T00:00:00.000",
    });
    expect(requestedUrl).toContain("9ggq-m8hp.json");
    expect(decodeURIComponent(requestedUrl)).toContain("max(data_as_of)");
    await expect(
      getSanFranciscoDatasetFreshness("not a dataset", {
        fetchImpl: jsonFetch([]),
      }),
    ).rejects.toThrow(/Invalid San Francisco dataset id/);
  });

  it("maps an empty aggregate to nulls", async () => {
    expect(
      await getSanFranciscoDatasetFreshness("9ggq-m8hp", {
        fetchImpl: jsonFetch([{}]),
      }),
    ).toEqual({ dataAsOf: null, dataLoadedAt: null });
  });
});

describe("getSanFranciscoCommitteeCurrentForm460Filings", () => {
  it("filters to current e-filed 460 chains and dedupes filing_nid", async () => {
    let requestedUrl = "";
    const rows = await getSanFranciscoCommitteeCurrentForm460Filings(
      { fppcId: "1467508" },
      {
        fetchImpl: async (url) => {
          requestedUrl = String(url);
          return new Response(
            JSON.stringify([
              { filing_nid: "nid-1", filing_date: "2024-08-01T00:00:00.000" },
              { filing_nid: "nid-1", filing_date: "2024-08-01T00:00:00.000" },
              { filing_nid: "nid-2", filing_date: "2025-01-10T00:00:00.000" },
              { filing_date: "2025-01-11T00:00:00.000" },
            ]),
            { status: 200 },
          );
        },
      },
    );
    expect(rows).toEqual([
      { filingNid: "nid-1", filingDate: "2024-08-01T00:00:00.000" },
      { filingNid: "nid-2", filingDate: "2025-01-10T00:00:00.000" },
    ]);
    const where = decodeURIComponent(requestedUrl);
    expect(where).toContain("form_type='FPPC460'");
    expect(where).toContain("current_status+like+'Most+Recent%'");
    expect(where).toContain("rejected=false");
    expect(where).toContain("has_efile_content=true");
    await expect(
      getSanFranciscoCommitteeCurrentForm460Filings(
        { fppcId: "abc" },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Invalid San Francisco FPPC id/);
  });
});

describe("getSanFranciscoCandidateTargetedSpending", () => {
  it("maps grouped rows and tolerates missing ids", async () => {
    const rows = await getSanFranciscoCandidateTargetedSpending(
      {
        candidateLastName: "Wong",
        transactionDateFrom: "2024-06-02",
        transactionDateTo: "2026-07-02",
      },
      {
        fetchImpl: jsonFetch([
          {
            fppc_id: "1488188",
            filer_name: "GROWSF SUPPORTING ALAN WONG FOR SUPERVISOR 2026",
            form_type: "F496",
            support_oppose_code: "S",
            amount: "209221.7",
            transaction_count: "12",
          },
          {
            filer_name: "Unregistered Spender",
            form_type: "D",
            amount: "not-money",
          },
          {
            fppc_id: "pending",
            filer_name: "Pending Committee",
            form_type: "D",
            support_oppose_code: "",
            amount: "1680.19",
            transaction_count: "16",
          },
        ]),
      },
    );
    expect(rows).toEqual([
      {
        spenderFppcId: "1488188",
        spenderName: "GROWSF SUPPORTING ALAN WONG FOR SUPERVISOR 2026",
        formType: "F496",
        supportOpposeCode: "S",
        amountCents: 20922170,
        transactionCount: 12,
      },
      {
        spenderFppcId: null,
        spenderName: "Pending Committee",
        formType: "D",
        supportOpposeCode: null,
        amountCents: 168019,
        transactionCount: 16,
      },
    ]);
  });

  it("orders grouped pages with a total order and keeps paging past filtered rows", async () => {
    const requestedUrls: string[] = [];
    const pageLimit = 2;
    // Page 1 is "full" (rawCount = pageLimit) but one element is malformed
    // and filtered out — pagination must still fetch page 2.
    const pages = [
      [
        {
          fppc_id: "1488188",
          filer_name: "GROWSF",
          form_type: "F496",
          support_oppose_code: "S",
          amount: "1.00",
          transaction_count: "1",
        },
        "not-an-object",
      ],
      [],
    ];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
    };
    const rows = await getSanFranciscoCandidateTargetedSpending(
      {
        candidateLastName: "Wong",
        transactionDateFrom: "2024-06-02",
        transactionDateTo: "2026-07-02",
      },
      { fetchImpl, pageLimit },
    );
    expect(rows).toHaveLength(1);
    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]!).searchParams.get("$order")).toBe(
      "amount DESC,fppc_id,filer_name,form_type,support_oppose_code",
    );
  });

  it("rejects malformed and impossible transaction dates", async () => {
    await expect(
      getSanFranciscoCandidateTargetedSpending(
        {
          candidateLastName: "Wong",
          transactionDateFrom: "06/02/2026",
          transactionDateTo: "2026-07-02",
        },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Invalid San Francisco transaction date/);
    // V8 would silently normalize this to March 3; it must fail here instead.
    await expect(
      getSanFranciscoCandidateTargetedSpending(
        {
          candidateLastName: "Wong",
          transactionDateFrom: "2026-02-31",
          transactionDateTo: "2026-07-02",
        },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Invalid San Francisco transaction date: 2026-02-31/);
  });

  it("rejects an empty or reversed date window", async () => {
    await expect(
      getSanFranciscoCandidateTargetedSpending(
        {
          candidateLastName: "Wong",
          transactionDateFrom: "2026-07-02",
          transactionDateTo: "2024-06-02",
        },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Empty San Francisco transaction-date window/);
    await expect(
      getSanFranciscoCandidateTargetedSpending(
        {
          candidateLastName: "Wong",
          transactionDateFrom: "2026-07-02",
          transactionDateTo: "2026-07-02",
        },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Empty San Francisco transaction-date window/);
  });
});

describe("getSanFranciscoFilers", () => {
  const registryRow = {
    filer_nid: "215112140",
    fppc_id: "1485709",
    filer_name: "ALAN WONG FOR SUPERVISOR 2026",
    filer_type: "Candidate or Officeholder",
    candidate_name: "Wong, Alan",
    status: "ACTIVE",
    is_terminated: false,
  };

  it("maps registry rows and nulls a pending FPPC id", async () => {
    const rows = await getSanFranciscoFilers(
      { fppcId: "1485709" },
      {
        fetchImpl: jsonFetch([
          registryRow,
          { ...registryRow, filer_nid: "217168240", fppc_id: "pending" },
        ]),
      },
    );
    expect(rows).toEqual([
      {
        filerNid: "215112140",
        fppcId: "1485709",
        filerName: "ALAN WONG FOR SUPERVISOR 2026",
        filerType: "Candidate or Officeholder",
        candidateName: "Wong, Alan",
        status: "ACTIVE",
        isTerminated: false,
      },
      expect.objectContaining({ filerNid: "217168240", fppcId: null }),
    ]);
  });

  it("filters by candidate-name fragment case-insensitively", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response("[]", { status: 200 });
    };
    await getSanFranciscoFilers({ candidateName: "Wong" }, { fetchImpl });
    expect(new URL(requestedUrls[0]!).searchParams.get("$where")).toBe(
      "upper(candidate_name) like '%WONG%'",
    );
  });

  it("requires at least one filter", async () => {
    await expect(
      getSanFranciscoFilers({}, { fetchImpl: jsonFetch([]) }),
    ).rejects.toThrow(/needs an FPPC id or a candidate name/);
  });
});

describe("getSanFranciscoCommitteeItemizedTransactions", () => {
  // Real row shape captured live 2026-08-06 (Lurie Schedule A).
  const scheduleARow = {
    filing_nid: "179442009",
    transaction_id: "INC139",
    form_type: "A",
    transaction_date: "2023-09-26T00:00:00.000",
    transaction_first_name: "MICHAEL",
    transaction_last_name: "EISLER",
    transaction_occupation: "BACO PROPERTIES",
    transaction_employer: "REAL ESTATE INVESTOR",
    entity_code: "IND",
    calculated_amount: "500.0",
    transaction_amount_1: "500.0",
    memo_code: false,
    is_itemized: true,
  };

  it("maps rows and drops one whose canonical amount is unparseable", async () => {
    const rows = await getSanFranciscoCommitteeItemizedTransactions(
      {
        fppcId: "1463099",
        formTypes: ["A", "C"],
        transactionDateFrom: "2022-12-05",
        transactionDateTo: "2024-12-05",
      },
      {
        fetchImpl: jsonFetch([
          scheduleARow,
          { ...scheduleARow, calculated_amount: "n/a" },
        ]),
      },
    );
    expect(rows).toEqual([
      {
        filingNid: "179442009",
        transactionId: "INC139",
        formType: "A",
        transactionDate: "2023-09-26T00:00:00.000",
        contributorFirstName: "MICHAEL",
        contributorLastName: "EISLER",
        occupation: "BACO PROPERTIES",
        employer: "REAL ESTATE INVESTOR",
        city: null,
        state: null,
        zip: null,
        entityCode: "IND",
        calculatedAmountCents: 50000,
        transactionAmount1Cents: 50000,
        memoCode: false,
        isItemized: true,
        crossReferenceMatch: null,
        crossReferenceSchedule: null,
        supportOpposeCode: null,
        transactionCode: null,
      },
    ]);
  });

  it("queries by committee and explicit form types with a total order", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response("[]", { status: 200 });
    };
    await getSanFranciscoCommitteeItemizedTransactions(
      {
        fppcId: "1463099",
        // Exact-case values: Socrata equality is case-sensitive, and the
        // dataset's summary pseudo-rows are mixed-case ("F460ALine2").
        formTypes: ["A", "F496", "F460ALine2"],
        transactionDateFrom: "2023-01-01",
        transactionDateTo: "2024-12-05",
      },
      { fetchImpl },
    );
    const params = new URL(requestedUrls[0]!).searchParams;
    expect(params.get("$where")).toBe(
      "fppc_id='1463099' AND form_type in ('A','F496','F460ALine2') AND transaction_date>='2023-01-01T00:00:00.000' AND transaction_date<'2024-12-05T00:00:00.000'",
    );
    expect(params.get("$order")).toBe("transaction_date,transaction_id,:id");
    expect(params.get("$select")).toContain("calculated_amount");
    expect(params.get("$select")).toContain("transaction_occupation");
  });

  it("widens the window to undated rows only when asked", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response("[]", { status: 200 });
    };
    await getSanFranciscoCommitteeItemizedTransactions(
      {
        fppcId: "1467508",
        formTypes: ["B1"],
        transactionDateFrom: "2023-01-01",
        transactionDateTo: "2024-12-05",
        includeUndatedTransactions: true,
      },
      { fetchImpl },
    );
    expect(new URL(requestedUrls[0]!).searchParams.get("$where")).toBe(
      "fppc_id='1467508' AND form_type in ('B1') AND (transaction_date IS NULL OR (transaction_date>='2023-01-01T00:00:00.000' AND transaction_date<'2024-12-05T00:00:00.000'))",
    );
  });

  it("rejects empty and malformed form types", async () => {
    const window = {
      transactionDateFrom: "2022-12-05",
      transactionDateTo: "2024-12-05",
    };
    await expect(
      getSanFranciscoCommitteeItemizedTransactions(
        { fppcId: "1463099", formTypes: [], ...window },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/needs at least one form type/);
    await expect(
      getSanFranciscoCommitteeItemizedTransactions(
        { fppcId: "1463099", formTypes: ["A'; drop"], ...window },
        { fetchImpl: jsonFetch([]) },
      ),
    ).rejects.toThrow(/Invalid San Francisco form type/);
  });
});

describe("getSanFranciscoPublicFundsApproved", () => {
  it("scopes by district server-side when asked", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response("[]", { status: 200 });
    };
    await getSanFranciscoPublicFundsApproved(
      { electionDate: "2024-11-05", district: "Mayor" },
      { fetchImpl },
    );
    expect(new URL(requestedUrls[0]!).searchParams.get("$where")).toBe(
      "election_date='2024-11-05T00:00:00.000' AND district='Mayor'",
    );
  });
});

describe("strict SF committee cash source fields", () => {
  const sourceRow = () => ({
    element_nid: "element1",
    filing_nid: "chain",
    filing_activity_nid: "edition",
    fppc_id: "1483804",
    form_type: "A",
    transaction_date: "2026-03-01T00:00:00.000",
    transaction_last_name: "Example Committee",
    entity_code: "COM",
    committee_id: "reported1",
    calculated_amount: "500.0",
    memo_code: false,
    is_itemized: true,
  });
  const scope = {
    fppcId: "1483804",
    transactionDateFrom: "2025-01-01",
    transactionDateTo: "2027-01-01",
  };
  it("retains raw reported ID spelling without treating it as legal identity", async () => {
    const rows = await getSanFranciscoCommitteeCashTransactions(scope, {
      fetchImpl: jsonFetch([{ ...sourceRow(), committee_id: " reported1 " }]),
    });
    expect(rows[0]!.reportedCommitteeId).toBe(" reported1 ");
    await expect(
      getSanFranciscoCommitteeCashTransactions(scope, {
        fetchImpl: jsonFetch([{ ...sourceRow(), committee_id: {} }]),
      }),
    ).rejects.toThrow(/unsupported source type/);
  });
  it("retains actual element/current edition/reported committee fields and full schedule scope", async () => {
    let requested = "";
    const rows = await getSanFranciscoCommitteeCashTransactions(scope, {
      fetchImpl: async (url) => {
        requested = String(url);
        return jsonFetch([sourceRow()])(url);
      },
    });
    expect(rows[0]).toMatchObject({
      elementNid: "element1",
      filingActivityNid: "edition",
      fppcId: "1483804",
      reportedCommitteeId: "reported1",
      calculatedAmountCents: 50000,
    });
    const query = new URL(requested).searchParams;
    expect(query.get("$select")).toContain(
      "element_nid,filing_activity_nid,fppc_id,committee_id",
    );
    expect(query.get("$where")).toContain("'A','E','B1','F497P1'");
    expect(query.get("$order")).toBe("element_nid,:id");
    expect(query.get("$where")).not.toContain("transaction_date");
  });
  it.each([
    "element_nid",
    "filing_activity_nid",
    "fppc_id",
    "calculated_amount",
  ])("refuses missing %s rather than partial rows", async (key) => {
    const r: Record<string, unknown> = sourceRow();
    delete r[key];
    await expect(
      getSanFranciscoCommitteeCashTransactions(scope, {
        fetchImpl: jsonFetch([r]),
      }),
    ).rejects.toThrow();
  });
  it.each(["1.001", "9007199254740992", "bad"])(
    "refuses non-exact/unsafe money %s",
    async (calculated_amount) => {
      await expect(
        getSanFranciscoCommitteeCashTransactions(scope, {
          fetchImpl: jsonFetch([{ ...sourceRow(), calculated_amount }]),
        }),
      ).rejects.toThrow();
    },
  );
  it("refuses duplicate elements and malformed physical rows", async () => {
    await expect(
      getSanFranciscoCommitteeCashTransactions(scope, {
        fetchImpl: jsonFetch([sourceRow(), sourceRow()]),
      }),
    ).rejects.toThrow(/ambiguous/);
    await expect(
      getSanFranciscoCommitteeCashTransactions(scope, {
        fetchImpl: jsonFetch([sourceRow(), null]),
      }),
    ).rejects.toThrow(/malformed physical/);
  });
  it("exhausts all pages and refuses caps", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      const data = calls++ === 0 ? [sourceRow()] : [];
      return new Response(JSON.stringify(data), { status: 200 });
    };
    expect(
      await getSanFranciscoCommitteeCashTransactions(scope, {
        fetchImpl,
        pageLimit: 1,
        maxPages: 2,
      }),
    ).toHaveLength(1);
    expect(calls).toBe(2);
    await expect(
      getSanFranciscoCommitteeCashTransactions(scope, {
        fetchImpl: jsonFetch([sourceRow()]),
        pageLimit: 1,
        maxPages: 1,
      }),
    ).rejects.toThrow(/exceeded/);
  });
  it("retains strict summary itemized controls and receiver/edition", async () => {
    const s = {
      filing_nid: "chain",
      filing_activity_nid: "edition",
      fppc_id: "1483804",
      form_type: "FPPC460",
      schedulea_line_1: "500.0",
      schedulee_line_1: "20.0",
    };
    expect(
      (
        await getSanFranciscoCommitteeSummaryRows(
          { fppcId: "1483804", strictCommitteeCash: true },
          { fetchImpl: jsonFetch([s]) },
        )
      )[0],
    ).toMatchObject({
      filingActivityNid: "edition",
      fppcId: "1483804",
      scheduleAItemizedCents: 50000,
      scheduleEItemizedCents: 2000,
    });
    await expect(
      getSanFranciscoCommitteeSummaryRows(
        { fppcId: "1483804", strictCommitteeCash: true },
        { fetchImpl: jsonFetch([{ ...s, schedulee_line_1: null }]) },
      ),
    ).rejects.toThrow(/exact cents/);
  });
  it("retains only explicit current electronic edition and refuses duplicated chains", async () => {
    const f = {
      filing_nid: "chain",
      filing_activity_nid: "edition",
      fppc_id: "1483804",
      current_status: "Most Recent Amendment",
      has_efile_content: true,
      rejected: false,
      start_date: "2026-01-01",
      end_date: "2026-06-30",
    };
    expect(
      (
        await getSanFranciscoCommitteeCurrentForm460Filings(
          { fppcId: "1483804", strictCommitteeCash: true },
          { fetchImpl: jsonFetch([f]) },
        )
      )[0],
    ).toMatchObject({
      filingActivityNid: "edition",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
    });
    await expect(
      getSanFranciscoCommitteeCurrentForm460Filings(
        { fppcId: "1483804", strictCommitteeCash: true },
        { fetchImpl: jsonFetch([f, f]) },
      ),
    ).rejects.toThrow(/ambiguous/);
    await expect(
      getSanFranciscoCommitteeCurrentForm460Filings(
        { fppcId: "1483804", strictCommitteeCash: true },
        { fetchImpl: jsonFetch([{ ...f, rejected: true }]) },
      ),
    ).rejects.toThrow(/unavailable/);
  });

  it.each([false, null])(
    "sees paper or unknown current versions and refuses incomplete cash replacement: %s",
    async (hasEfileContent) => {
      let where = "";
      await expect(
        getSanFranciscoCommitteeCurrentForm460Filings(
          { fppcId: "1483804", strictCommitteeCash: true },
          {
            fetchImpl: async (url) => {
              where = new URL(String(url)).searchParams.get("$where")!;
              return new Response(
                JSON.stringify([
                  {
                    filing_nid: "chain",
                    filing_activity_nid: "current-paper",
                    fppc_id: "1483804",
                    current_status: "Most Recent Amendment",
                    has_efile_content: hasEfileContent,
                    rejected: false,
                    start_date: "2026-01-01",
                    end_date: "2026-06-30",
                  },
                ]),
              );
            },
          },
        ),
      ).rejects.toThrow(/current filing identity is unavailable/);
      expect(where).toContain("Most Recent");
      expect(where).not.toContain("has_efile_content");
      expect(where).not.toContain("rejected=false");
    },
  );
});
