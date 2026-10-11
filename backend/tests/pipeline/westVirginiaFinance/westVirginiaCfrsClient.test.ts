import { describe, expect, it } from "vitest";

import {
  WestVirginiaCfrsClientError,
  getAllWestVirginiaTransactions,
  getAllWestVirginiaCurrentFilings,
  getWestVirginiaFilingAmendmentHistory,
  getWestVirginiaDataDownloadCatalog,
  getWestVirginiaDocumentDownloadUrl,
  redactPresignedUrl,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const TRANSACTION_ROW = {
  transactionID: 1,
  entityID: "1010000001",
  orgID: 1,
  committeeName: "Test Committee",
  candidateName: "Test, Candidate",
  transactionAmount: 25.44,
  transactionDate: "2026-06-17T00:00:00",
  filedDate: "2026-07-07T00:00:00",
  entityTypeDesc: "Individual",
  transactionCategoryDesc: "Monetary",
  transactionTypeDesc: "Contributions",
  transactionPurpose: null,
  contributorPayeeName: "Jacob Hively",
  employerName: null,
  employerOccupation: null,
  transactionTotalYTD: "25.4400",
  amendedFlag: false,
  reportVersionID: "1",
  reportFileName: "2026 2nd Quarter Report",
  s3ReportFilePath: "prd/Reports/1/x.pdf",
  stanceDescription: null,
  candidateNameAssocation: null,
  ballotMeasureDescription: null,
  orgType: "State Candidate",
};

describe("redactPresignedUrl", () => {
  it("strips the credential-bearing query string", () => {
    const url = "https://bucket.s3.us-gov-east-1.amazonaws.com/prd/x.csv?X-Amz-Security-Token=SECRET&X-Amz-Expires=3600";
    expect(redactPresignedUrl(url)).toBe("https://bucket.s3.us-gov-east-1.amazonaws.com/prd/x.csv");
    expect(redactPresignedUrl(url)).not.toContain("SECRET");
  });
});

describe("getWestVirginiaDataDownloadCatalog", () => {
  it("sends the mandatory pagination body and parses rows", async () => {
    let capturedBody: unknown;
    const rows = [{ id: 1078, dataType: "Contributions", year: "2026", s3ReportFilePath: "prd/x.csv" }];
    const catalog = await getWestVirginiaDataDownloadCatalog(
      {},
      {
        fetchImpl: async (_url, init) => {
          capturedBody = JSON.parse(String(init?.body));
          return jsonResponse({ isSuccess: true, responseData: { totalRecords: 1, data: rows } });
        },
      }
    );
    expect(capturedBody).toEqual({ pageNumber: 1, pageSize: 5000 });
    expect(catalog).toEqual(rows);
  });

  it("fails closed on the WAF's HTML block page", async () => {
    await expect(
      getWestVirginiaDataDownloadCatalog(
        {},
        {
          fetchImpl: async () =>
            new Response("<html>403 Forbidden</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        }
      )
    ).rejects.toThrow(/unexpected content type/);
  });

  it("classifies a body-read failure as a typed network error", async () => {
    const brokenBody = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      arrayBuffer: async () => {
        throw new TypeError("terminated");
      },
    } as unknown as Response;
    const pending = getWestVirginiaDataDownloadCatalog({}, { fetchImpl: async () => brokenBody });
    await expect(pending).rejects.toBeInstanceOf(WestVirginiaCfrsClientError);
    await expect(pending).rejects.toThrow(/response read failed .*terminated/);
  });

  it("fails closed on isSuccess=false envelopes", async () => {
    await expect(
      getWestVirginiaDataDownloadCatalog(
        {},
        { fetchImpl: async () => jsonResponse({ isSuccess: false, responseData: null, message: "Something went wrong." }) }
      )
    ).rejects.toThrow(/Something went wrong/);
  });
});

describe("getAllWestVirginiaTransactions", () => {
  it("requires a 3-digit orgTypeCode", async () => {
    await expect(
      getAllWestVirginiaTransactions({ orgTypeCode: "" }, { fetchImpl: async () => jsonResponse({}) })
    ).rejects.toThrow(WestVirginiaCfrsClientError);
  });

  it("paginates on totalRecords and detects mid-pagination drift", async () => {
    let call = 0;
    await expect(
      getAllWestVirginiaTransactions(
        { orgTypeCode: "101", pageSize: 1 },
        {
          fetchImpl: async () => {
            call += 1;
            return jsonResponse({
              isSuccess: true,
              responseData: { totalRecords: call === 1 ? 2 : 5, data: [TRANSACTION_ROW] },
            });
          },
        }
      )
    ).rejects.toThrow(/totalRecords changed/);
  });

  it.each([null, undefined, {}])("rejects IE empty results without an explicit array: %s", async (data) => {
    await expect(getAllWestVirginiaTransactions({ orgTypeCode: "104", transactionCategory: "IE" }, {
      fetchImpl: async () => jsonResponse({ isSuccess: true, responseData: { totalRecords: 0, data } }),
    })).rejects.toThrow(/requires explicit array data/);
  });

  it("accepts explicit empty IE results and preserves ordinary CON empty behavior", async () => {
    for (const [transactionCategory, data] of [["IE", []], ["CON", null]] as const) {
      await expect(getAllWestVirginiaTransactions({ orgTypeCode: "104", transactionCategory }, {
        fetchImpl: async () => jsonResponse({ isSuccess: true, responseData: { totalRecords: 0, data } }),
      })).resolves.toEqual([]);
    }
  });

  it("returns typed rows across pages", async () => {
    let call = 0;
    const rows = await getAllWestVirginiaTransactions(
      { orgTypeCode: "101", transactionCategory: "CON", pageSize: 1 },
      {
        fetchImpl: async (_url, init) => {
          call += 1;
          const body = JSON.parse(String(init?.body));
          expect(body.orgTypeCode).toBe("101");
          expect(body.transactionCategory).toBe("CON");
          expect(body.pageNumber).toBe(call);
          return jsonResponse({ isSuccess: true, responseData: { totalRecords: 2, data: [TRANSACTION_ROW] } });
        },
      }
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].entityID).toBe("1010000001");
    expect(rows[0].amendedFlag).toBe(false);
  });
});

describe("getWestVirginiaDocumentDownloadUrl", () => {
  it("posts s3FilePath to Common-Service and returns the https url", async () => {
    let capturedUrl = "";
    const url = await getWestVirginiaDocumentDownloadUrl("prd/OrgDocuments/3981/x.pdf", {
      fetchImpl: async (requestUrl) => {
        capturedUrl = String(requestUrl);
        return jsonResponse({ isSuccess: true, responseData: "https://bucket/x.pdf?token=1" });
      },
    });
    expect(capturedUrl).toContain("/api/Common-Service/AmazonCloudFront/getDownloadLinkWithoutCookies");
    expect(url).toBe("https://bucket/x.pdf?token=1");
  });

  it("rejects absolute urls passed as s3FilePath", async () => {
    await expect(
      getWestVirginiaDocumentDownloadUrl("https://evil.example/x.pdf", { fetchImpl: async () => jsonResponse({}) })
    ).rejects.toThrow(/Invalid West Virginia CFRS s3FilePath/);
  });
});


const CURRENT_FILING = {
  orgID: 2875, reportID: 32245, reportVersionID: 2, registrantID: "1040002875",
  committeeName: "West Virginia Strong,  Inc.", reportFileName: "2026 1st Quarter Report",
  reportFormType: "Campaign Financial Statement", startDate: "2026-01-01T00:00:00",
  endDate: "2026-03-31T00:00:00", dueDate: "2026-04-07T00:00:00",
  filedDate: "2026-04-29T00:00:00", reportStatus: "Amended", documentBarCode: "F5BA3496AFAF45AE",
};

function filingResponse(rows: unknown[], totalRecords = rows.length): Response {
  return jsonResponse({ isSuccess: true, responseData: { totalRecords, data: rows } });
}

describe("WV public current filings and history", () => {
  it("acquires the verified current v2 POST and prior v1 GET separately", async () => {
    const prior = { ...CURRENT_FILING, reportVersionID: 1, reportStatus: "Original",
      filedDate: "2026-04-09T00:00:00", documentBarCode: "205AD5C1C6564C18" };
    const current = await getAllWestVirginiaCurrentFilings({ orgID: 2875, pageSize: 100 }, {
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://cfrs.wvsos.gov/api/Public-Service/AccessReport/getAllFiledReportDataList");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ orgID: 2875, pageNumber: 1, pageSize: 100,
          sortColumn: "filedDate", sortDirection: "desc" });
        return filingResponse([CURRENT_FILING]);
      },
    });
    const history = await getWestVirginiaFilingAmendmentHistory(32245, {
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://cfrs.wvsos.gov/api/Public-Service/AccessReport/getOrgFiledReportAmendHistory/32245");
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return jsonResponse({ isSuccess: true, responseData: [prior] });
      },
    });
    expect(current[0]?.reportVersionID).toBe(2);
    expect(history.map((row) => row.reportVersionID)).toEqual([1]);
    expect(history[0]).not.toHaveProperty("orgID");
  });

  it("paginates current reports with exact counts and distinct report identities", async () => {
    let page = 0;
    const rows = await getAllWestVirginiaCurrentFilings({ orgID: 2875, pageSize: 1 }, {
      fetchImpl: async (_url, init) => {
        page += 1;
        expect(JSON.parse(String(init?.body)).pageNumber).toBe(page);
        return filingResponse([{ ...CURRENT_FILING, reportID: 32244 + page }], 2);
      },
    });
    expect(rows.map((row) => row.reportID)).toEqual([32245, 32246]);
  });

  it("accepts explicit successful empty lists and empty prior-version history", async () => {
    expect(await getAllWestVirginiaCurrentFilings({ orgID: 3981 }, {
      fetchImpl: async () => filingResponse([]),
    })).toEqual([]);
    expect(await getWestVirginiaFilingAmendmentHistory(32245, {
      fetchImpl: async () => jsonResponse({ isSuccess: true, responseData: [] }),
    })).toEqual([]);
  });

  it.each([null, undefined, {}])("rejects missing or malformed current list data: %s", async (data) => {
    await expect(getAllWestVirginiaCurrentFilings({ orgID: 2875 }, {
      fetchImpl: async () => jsonResponse({ isSuccess: true, responseData: { totalRecords: 0, data } }),
    })).rejects.toThrow(/explicit array/);
  });

  it.each([
    [{ ...CURRENT_FILING, orgID: 3981 }, /another orgID/],
    [{ ...CURRENT_FILING, reportStatus: "Pending" }, /filing status/],
    [{ ...CURRENT_FILING, reportVersionID: 0 }, /reportVersionID/],
    [{ ...CURRENT_FILING, reportVersionID: "2" }, /reportVersionID/],
    [{ ...CURRENT_FILING, reportID: -1 }, /reportID/],
    [{ ...CURRENT_FILING, startDate: "2026-02-30" }, /startDate/],
    [{ ...CURRENT_FILING, filedDate: "2026-04-29T25:00:00" }, /filedDate/],
    [{ ...CURRENT_FILING, startDate: "2026-04-01" }, /reversed/],
    [{ ...CURRENT_FILING, documentBarCode: "../bad" }, /documentBarCode/],
    [{ ...CURRENT_FILING, registrantID: "bad" }, /registrantID/],
  ])("rejects invalid current filing schema", async (row, error) => {
    await expect(getAllWestVirginiaCurrentFilings({ orgID: 2875 }, {
      fetchImpl: async () => filingResponse([row]),
    })).rejects.toThrow(error as RegExp);
  });

  it("rejects current duplicate report IDs even across pages", async () => {
    await expect(getAllWestVirginiaCurrentFilings({ orgID: 2875, pageSize: 1 }, {
      fetchImpl: async () => filingResponse([CURRENT_FILING], 2),
    })).rejects.toThrow(/Duplicate.*reportID/);
  });

  it("rejects total drift and truncated current pages", async () => {
    let call = 0;
    await expect(getAllWestVirginiaCurrentFilings({ orgID: 2875, pageSize: 1 }, {
      fetchImpl: async () => filingResponse([{ ...CURRENT_FILING, reportID: 32245 + ++call }], call === 1 ? 2 : 3),
    })).rejects.toThrow(/totalRecords changed/);
    await expect(getAllWestVirginiaCurrentFilings({ orgID: 2875, pageSize: 1 }, {
      fetchImpl: async () => filingResponse([], 2),
    })).rejects.toThrow(/pagination ended inconsistently/);
  });

  it("rejects malformed, wrong-report and repeated history versions", async () => {
    for (const data of [null, {}, [{ ...CURRENT_FILING, reportID: 1 }], [CURRENT_FILING, CURRENT_FILING]]) {
      await expect(getWestVirginiaFilingAmendmentHistory(32245, {
        fetchImpl: async () => jsonResponse({ isSuccess: true, responseData: data }),
      })).rejects.toThrow(/explicit array|mismatched or duplicate/);
    }
  });
});

describe("WV raw target election year", () => {
  it("retains an IE target year even when spender registration and transaction year differ", async () => {
    const rows = await getAllWestVirginiaTransactions({ orgTypeCode: "104", transactionCategory: "IE" }, {
      fetchImpl: async () => filingResponse([{ ...TRANSACTION_ROW, transactionTypeDesc: "Independent Expenditures",
        transactionDate: "2025-12-31T00:00:00", electionYear: 2026 }]),
    });
    expect(rows[0]?.electionYear).toBe(2026);
  });

  it.each([undefined, null, "2026", 2026.5, 0])("ordinary rows do not fail on unavailable outside evidence: %s", async (electionYear) => {
    const rows = await getAllWestVirginiaTransactions({ orgTypeCode: "102", transactionCategory: "IE" }, {
      fetchImpl: async () => filingResponse([{ ...TRANSACTION_ROW, electionYear }]),
    });
    expect(rows[0]?.electionYear).toBeNull();
    expect(rows[0]?.transactionTypeDesc).toBe("Contributions");
  });
});
