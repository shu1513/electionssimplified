import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NewYorkSodaClientError,
  buildNewYorkSodaDatasetUrl,
  getNewYorkFilerRecords,
  getNewYorkCommitteeItemizedReceipts,
  getNewYorkParentExpenditures,
  getNewYorkScheduleRAllocations,
  newYorkCycleSchedDateWindow,
  newYorkGeneralElectionDay,
  searchNewYorkActiveAuthorizedCommitteeFilers,
  searchNewYorkActiveCandidateFilers,
  soqlString,
} from "../../../src/pipeline/newYorkFinance/newYorkSodaClient.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), { status: 200, statusText: "OK", ...init });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newYorkSodaClient", () => {
  it("builds dataset URLs and escapes SoQL strings", () => {
    const url = new URL(
      buildNewYorkSodaDatasetUrl("e9ss-239a", { $where: "filer_id='590891'", $limit: 5 })
    );
    expect(url.origin + url.pathname).toBe("https://data.ny.gov/resource/e9ss-239a.json");
    expect(url.searchParams.get("$where")).toBe("filer_id='590891'");
    expect(() => buildNewYorkSodaDatasetUrl("bad", {})).toThrow(NewYorkSodaClientError);
    expect(soqlString("O'Brien")).toBe("'O''Brien'");
  });

  it("computes general election days and cycle sched_date windows", () => {
    expect(newYorkGeneralElectionDay(2022)).toBe("2022-11-08");
    expect(newYorkGeneralElectionDay(2024)).toBe("2024-11-05");
    expect(newYorkGeneralElectionDay(2026)).toBe("2026-11-03");

    expect(newYorkCycleSchedDateWindow(2026, 4)).toEqual({
      startDate: "2022-11-09",
      endDateExclusive: "2026-11-04",
    });
    expect(newYorkCycleSchedDateWindow(2026, 2)).toEqual({
      startDate: "2024-11-06",
      endDateExclusive: "2026-11-04",
    });
    expect(() => newYorkCycleSchedDateWindow(2026, 3 as 2)).toThrow("Invalid New York SODA cycle years");
  });

  it("looks up filer registry records in chunks and drops duplicate filer ids entirely", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          filer_id: "590891",
          filer_name: "Citizens for Affordable Rates PAC",
          compliance_type_desc: "COMMITTEE",
          committee_type_desc: "Independent Expenditure Committee",
          filer_status: "ACTIVE",
          filer_type_desc: "State",
        },
        // Three copies must stay dropped, not toggle back in.
        { filer_id: "111", filer_name: "Duplicate Filer" },
        { filer_id: "111", filer_name: "Duplicate Filer Copy" },
        { filer_id: "111", filer_name: "Duplicate Filer Third Copy" },
        { filer_name: "Missing id is skipped" },
      ])
    );

    const records = await getNewYorkFilerRecords({ filerIds: ["590891", "111", "590891"] }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("$where")).toBe("filer_id IN ('590891','111')");
    expect(url.searchParams.get("$order")).toBe("filer_id");
    expect(records.get("590891")).toMatchObject({
      filerName: "Citizens for Affordable Rates PAC",
      committeeType: "Independent Expenditure Committee",
    });
    expect(records.has("111")).toBe(false);
    await expect(getNewYorkFilerRecords({ filerIds: ["abc"] }, { fetchImpl })).rejects.toThrow(
      "Invalid New York filer id"
    );
  });

  it("searches active state candidate filers scoped to office labels and district", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          filer_id: "27197",
          filer_name: "Kathy C. Hochul",
          compliance_type_desc: "CANDIDATE",
          filer_status: "ACTIVE",
          filer_type_desc: "State",
          office_desc: "Governor",
        },
      ])
    );

    const records = await searchNewYorkActiveCandidateFilers(
      { boeOfficeLabels: ["State Senator"], district: "43" },
      { fetchImpl }
    );

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("$where")).toBe(
      "compliance_type_desc='CANDIDATE' AND filer_status='ACTIVE' AND filer_type_desc='State' AND office_desc IN ('State Senator') AND district='43'"
    );
    expect(url.searchParams.get("$order")).toBe("filer_id");
    expect(records).toHaveLength(1);
    expect(records[0]?.filerId).toBe("27197");
  });

  it("searches active authorized single candidate committees by name fragment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    await searchNewYorkActiveAuthorizedCommitteeFilers({ nameContains: "  ho%chul_ " }, { fetchImpl });

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    // filer_type_desc='State' keeps same-name county committees out.
    expect(url.searchParams.get("$where")).toBe(
      "compliance_type_desc='COMMITTEE' AND committee_type_desc IN ('Authorized Single Candidate Committee','Public Campaign Finance Committee') AND filer_status='ACTIVE' AND filer_type_desc='State' AND upper(filer_name) like '%HOCHUL%'"
    );
    await expect(
      searchNewYorkActiveAuthorizedCommitteeFilers({ nameContains: "x" }, { fetchImpl })
    ).rejects.toThrow("name fragment");
  });

  it("fetches Schedule R allocations with strict filters and drops malformed rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          filer_id: "590891",
          cand_comm_name: "Citizens for Affordable Rates PAC",
          flng_ent_first_name: "Kathy",
          flng_ent_last_name: "Hochul",
          office_desc: "Governor",
          election_year_r: "2026",
          r_support_oppose: "S",
          org_amt: "2500000",
          trans_number: "T-1",
          trans_mapping: "M-1",
          filing_trans_id: "F-1",
        },
        // Missing explicit support/oppose value: dropped.
        {
          filer_id: "590891",
          cand_comm_name: "Citizens for Affordable Rates PAC",
          office_desc: "Governor",
          election_year_r: "2026",
          r_support_oppose: "X",
          org_amt: "1",
          trans_number: "T-2",
          filing_trans_id: "F-2",
        },
        // Missing filing_trans_id: dropped.
        {
          filer_id: "590891",
          cand_comm_name: "Citizens for Affordable Rates PAC",
          office_desc: "Governor",
          election_year_r: "2026",
          r_support_oppose: "O",
          org_amt: "1",
          trans_number: "T-3",
        },
      ])
    );

    const rows = await getNewYorkScheduleRAllocations(
      { electionYear: 2026, boeOfficeLabels: ["Governor"], district: null },
      { fetchImpl }
    );

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("$where")).toBe(
      "filing_sched_abbrev='R' AND election_year_r='2026' AND r_support_oppose IS NOT NULL AND office_desc IN ('Governor')"
    );
    expect(url.searchParams.get("$order")).toBe("filing_trans_id");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filerId: "590891",
      candidateLastName: "Hochul",
      supportOppose: "S",
      amount: 2_500_000,
      transMapping: "M-1",
    });
  });

  it("resolves parent expenditures grouped by trans_number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        { trans_number: "M-1", filing_sched_abbrev: "F", org_amt: "18570" },
        { trans_number: "M-2", filing_sched_abbrev: "F", org_amt: "10" },
        { trans_number: "M-2", filing_sched_abbrev: "R", org_amt: "10" },
      ])
    );

    const parents = await getNewYorkParentExpenditures(
      { filerId: "590891", transNumbers: ["M-1", "M-2", "M-1", " "] },
      { fetchImpl }
    );

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("$where")).toBe("filer_id='590891' AND trans_number IN ('M-1','M-2')");
    expect(parents.get("M-1")).toEqual([{ transNumber: "M-1", scheduleAbbrev: "F", amount: 18_570 }]);
    expect(parents.get("M-2")).toHaveLength(2);
  });

  it("fetches cycle-scoped itemized IE committee receipts and pages with a stable order", async () => {
    const pageOne = Array.from({ length: 3 }, (_unused, index) => ({
      flng_ent_name: `Org ${index}`,
      cntrbr_type_desc: "Corporation",
      filing_sched_abbrev: "B",
      org_amt: "100",
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pageOne))
      .mockResolvedValueOnce(jsonResponse([{ flng_ent_name: "Org 3", filing_sched_abbrev: "B", org_amt: "50" }]));

    const receipts = await getNewYorkCommitteeItemizedReceipts(
      { filerId: "590891", electionYear: 2026, cycleYears: 4 },
      { fetchImpl, pageLimit: 3 }
    );

    const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(firstUrl.searchParams.get("$where")).toBe(
      "filer_id='590891' AND filing_sched_abbrev IN ('A','B','C','D') AND filing_cat_desc='Itemized' AND sched_date>='2022-11-09' AND sched_date<'2026-11-04'"
    );
    expect(firstUrl.searchParams.get("$order")).toBe("filing_trans_id");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get("$offset")).toBe("3");
    expect(receipts).toHaveLength(4);
  });

  it("applies the timeout to body reads, not just response headers", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: () =>
        new Promise((_resolve, reject) => {
          // Real fetch bodies reject with AbortError once the controller
          // fires; simulate a body that stalls past the timeout.
          setTimeout(() => reject(new DOMException("The operation was aborted", "AbortError")), 30);
        }),
    })) as unknown as typeof fetch;

    await expect(
      getNewYorkFilerRecords({ filerIds: ["590891"] }, { fetchImpl, timeoutMs: 10 })
    ).rejects.toThrow("timed out after 10ms");
  });

  it("computes the committee expenditure total server-side", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ total: "3706000.56" }]));

    const { getNewYorkCommitteeExpenditureTotal } = await import(
      "../../../src/pipeline/newYorkFinance/newYorkSodaClient.js"
    );
    const total = await getNewYorkCommitteeExpenditureTotal(
      { filerId: "16851", electionYear: 2026, cycleYears: 4 },
      { fetchImpl }
    );

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("$select")).toBe("sum(org_amt) AS total");
    expect(url.searchParams.get("$where")).toBe(
      "filer_id='16851' AND filing_sched_abbrev='F' AND filing_cat_desc='Itemized' AND sched_date>='2022-11-09' AND sched_date<'2026-11-04'"
    );
    expect(total).toBe(3_706_000.56);

    const emptyFetch = vi.fn().mockResolvedValue(jsonResponse([{}]));
    await expect(
      getNewYorkCommitteeExpenditureTotal({ filerId: "16851", electionYear: 2026, cycleYears: 4 }, { fetchImpl: emptyFetch })
    ).resolves.toBeNull();
  });

  it("surfaces HTTP errors with status and stops runaway paging", async () => {
    const failingFetch = vi.fn().mockResolvedValue(jsonResponse({ error: true }, { status: 429, statusText: "Too Many" }));
    await expect(
      getNewYorkCommitteeItemizedReceipts(
        { filerId: "590891", electionYear: 2026, cycleYears: 4 },
        { fetchImpl: failingFetch }
      )
    ).rejects.toMatchObject({ code: "http_error", status: 429 });

    const endlessFetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse([{ flng_ent_name: "Org", filing_sched_abbrev: "B", org_amt: "1" }]));
    await expect(
      getNewYorkCommitteeItemizedReceipts(
        { filerId: "590891", electionYear: 2026, cycleYears: 4 },
        { fetchImpl: endlessFetch, pageLimit: 1, maxPages: 2 }
      )
    ).rejects.toThrow("exceeded 2 pages");
  });
});
